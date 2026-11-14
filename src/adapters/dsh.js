/**
 * DeepSeek Harness (DSH) adapter.
 *
 * Unlike the old `@natives/dsh-files` shell, this adapter does NOT iframe the
 * whole Natives Core. It registers same-origin API routes on
 * the DSH Host `webServer` and exposes the same tool catalogue every other
 * agent sees. The host may render its own panel using `clientSpec`; the plugin
 * ships no React, no Natives CSS, no port 8770 dependency and no product data.
 */

import {
  defineAdapter,
  jsonReply,
  readRequestBody,
  isSameOrigin,
} from './adapter.js';
import fsp from 'node:fs/promises';
import { FilePluginError, ErrorCode, asFilePluginError, httpStatus, safeMessage } from '../protocol/errors.js';
import { callTool, toDshManifest } from '../tool-definitions.js';
import { openPagePreview } from '../core/preview.js';

/**
 * HTML previews are served with a `CSP: sandbox` header so the document always
 * runs in an opaque origin — script can execute (a "live" preview) but cannot
 * reach the same-origin file API, and even a direct top-level navigation stays
 * sandboxed. The injected bootstrap only rewrites relative `src` targets to
 * the raw route so local images resolve; it never touches the document HTML.
 */
const HTML_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups";
const MAX_HTML_PREVIEW_BYTES = 4 * 1024 * 1024;

function previewBootstrap(directory) {
  const base = JSON.stringify(directory.replaceAll('\\', '/'));
  return `<script data-dsh-preview>(function(){
  var base=${base};
  function resolve(src){
    if(/^(https?:|data:|blob:)/i.test(src))return null;
    if(/^[a-z]:[\\\\/]/i.test(src)||src.startsWith('//'))return src.replaceAll('\\\\','/');
    var parts=base.split('/');
    for(var seg of src.split('/')){
      if(!seg||seg==='.')continue;
      if(seg==='..')parts.pop();else parts.push(seg);
    }
    return parts.join('/');
  }
  function fix(el){
    var src=el.getAttribute('src')||'';
    if(!src||el.dataset.dshFix)return;
    var target=resolve(src);
    if(target===null)return;
    el.dataset.dshFix='1';
    el.src='/agent/files/raw?path='+encodeURIComponent(target);
  }
  function scan(){document.querySelectorAll('img[src],source[src],video[src],audio[src]').forEach(fix);}
  document.addEventListener('error',function(event){var node=event.target;if(node&&node.tagName==='IMG')fix(node);},true);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan);else scan();
})()</script>`;
}

function injectPreviewBootstrap(html, directory) {
  if (html.includes('data-dsh-preview')) return html;
  const bootstrap = previewBootstrap(directory);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${bootstrap}${html.slice(head.index + head[0].length)}`;
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return `${html.slice(0, htmlTag.index + htmlTag[0].length)}${bootstrap}${html.slice(htmlTag.index + htmlTag[0].length)}`;
  return `${bootstrap}\n${html}`;
}

defineAdapter('dsh', (options = {}) => {
  let service;
  let config;
  let log;
  const prefix = options.routePrefix ?? '/agent/files';
  const rawPath = `${prefix}/raw`;
  const panelId = options.panelId ?? 'universal-files';
  const disposers = [];
  const streams = new Set();
  const applied = new WeakSet();

  const routes = [
    { method: 'GET', path: `${prefix}/tools` },
    { method: 'GET', path: `${prefix}/describe` },
    { method: 'POST', path: `${prefix}/rpc` },
    { method: 'POST', path: `${prefix}/tools/call` },
    { method: 'GET', path: `${prefix}/events` },
    { method: 'GET', path: rawPath },
  ];

  /** Pure dispatcher: usable in tests and by hosts that own their own server. */
  async function dispatch({ method, path, body, headers, query = {} }) {
    const request = { headers, method, url: path };
    if (options.sameOriginOnly !== false && !isSameOrigin(request)) {
      return { status: 403, payload: { code: 'cross-origin', message: 'same-origin only' } };
    }
    const route = routes.find((entry) => entry.path === path);
    if (!route) return { status: 404, payload: { ok: false, error: 'not found' } };
    if (route.method !== method) return { status: 405, payload: { ok: false, error: 'method not allowed' } };
    if (path === `${prefix}/events`) return { status: 400, payload: { ok: false, error: 'use the HTTP event stream' } };
    if (path === rawPath) return { status: 400, payload: { ok: false, error: 'use the HTTP preview stream' } };
    if (method === 'GET' && path === `${prefix}/tools`) {
      return { status: 200, payload: toDshManifest(service.tools(), { routePrefix: prefix }) };
    }
    if (method === 'GET' && path === `${prefix}/describe`) {
      return { status: 200, payload: service.describe() };
    }
    if (method !== 'POST') return { status: 404, payload: { ok: false, error: 'not found' } };

    let parsed = body;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { status: 400, payload: { ok: false, error: 'invalid JSON body' } };
      }
    }
    if (parsed === undefined) parsed = query;
    if (path === `${prefix}/tools/call`) {
      try {
        const result = await callTool(service, parsed?.name, parsed?.arguments ?? parsed?.input ?? {});
        return { status: 200, payload: { ok: true, result } };
      } catch (error) {
        return {
          status: httpStatus(error),
          payload: { ok: false, error: safeMessage(asFilePluginError(error), config?.security) },
        };
      }
    }
    return { status: 200, payload: await service.handle(parsed) };
  }

  /**
   * Same-origin, range-capable media stream for the built-in page preview.
   * The core owns path authorization and file access; this layer only maps
   * the HTTP request onto byte ranges and response headers.
   */
  async function serveRaw(request, response) {
    if (options.sameOriginOnly !== false && !isSameOrigin(request)) {
      return jsonReply(response, 403, { ok: false, error: 'same-origin only' });
    }
    const url = new URL(request.url ?? rawPath, 'http://127.0.0.1');
    try {
      const file = await openPagePreview(service.policy, url.searchParams.get('path'));
      if (file.html) return serveHtmlPreview(request, response, file);
      let start = 0;
      let end = Math.max(0, file.size - 1);
      let status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers?.range ?? '');
      if (range) {
        const first = range[1] ? Number(range[1]) : 0;
        const last = range[2] ? Number(range[2]) : end;
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || first >= file.size) {
          response.writeHead(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${file.size}` });
          return response.end();
        }
        start = first; end = Math.min(last, file.size - 1); status = 206;
      }
      const headers = {
        'Content-Type': file.mimeType,
        'Content-Length': file.size ? end - start + 1 : 0,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
      response.writeHead(status, headers);
      if (request.method === 'HEAD' || !file.size) return response.end();
      const stream = file.read(start, end);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      jsonReply(response, httpStatus(error), { ok: false, error: safeMessage(asFilePluginError(error), config?.security) });
    }
  }

  /**
   * HTML pages cannot be streamed byte-identical: the sandboxing CSP header is
   * added and the file is read whole (bounded) to inject the image-fixing
   * bootstrap. Range requests are answered with the full document.
   */
  async function serveHtmlPreview(request, response, file) {
    if (file.size > MAX_HTML_PREVIEW_BYTES) {
      const tooLarge = new FilePluginError(ErrorCode.INVALID_PARAMETER, 'HTML preview is limited to 4 MiB; open the file in the default app');
      return jsonReply(response, httpStatus(tooLarge), { ok: false, error: safeMessage(tooLarge, config?.security) });
    }
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = file.read(0, Math.max(0, file.size - 1));
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
      response.on('close', () => stream.destroy());
    });
    // searchParams values are already percent-decoded once.
    const target = new URL(request.url ?? rawPath, 'http://127.0.0.1').searchParams.get('path') ?? '';
    const directory = target.replaceAll('\\', '/').split('/').slice(0, -1).join('/');
    const body = injectPreviewBootstrap(Buffer.concat(chunks).toString('utf8'), directory);
    response.writeHead(200, {
      'Content-Type': file.mimeType,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': HTML_SANDBOX_CSP,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  async function subscribe(request, response) {
    if (!isSameOrigin(request)) return jsonReply(response, 403, { ok: false, error: 'same-origin only' });
    if (streams.size >= 32) return jsonReply(response, 503, { ok: false, error: 'too many event subscribers' });
    const watchedPath = new URL(request.url, 'http://localhost').searchParams.get('path');
    const owner = {};
    // Each page owns its watch; closing one page must not stop another page or tool.
    if (watchedPath) await service.call('watch_start', { path: watchedPath }, { owner });
    if (response.destroyed || response.writableEnded || streams.size >= 32) {
      if (watchedPath) await service.call('watch_stop', { path: watchedPath }, { owner });
      if (!response.destroyed && !response.writableEnded) jsonReply(response, 503, { ok: false, error: 'too many event subscribers' });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    response.write(': connected\n\n');
    let closed = false;
    const unsubscribe = service.on('*', ({ type, payload }) => {
      if (!closed && !response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)) close();
    });
    const heartbeat = setInterval(() => {
      if (!response.write(': heartbeat\n\n')) close();
    }, 15000);
    heartbeat.unref?.();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      response.off('close', close);
      response.off('error', close);
      response.end();
      if (watchedPath) void service.call('watch_stop', { path: watchedPath }, { owner }).catch(() => {});
    }
    streams.add(close);
    response.once('close', close);
    response.once('error', close);
  }

  const handle = {
    routes,
    prefix,
    panelId,
    dispatch,
    clientSpec: {
      panelId,
      sidebar: { name: 'sidebar.panellist', id: panelId, order: options.order ?? 20 },
      main: { name: 'main', key: panelId },
      routePrefix: prefix,
      rendering: 'host-owned',
      note: 'No iframe of any product page; the host renders its own UI and calls the tool routes.',
    },

    /**
     * Attach to a DSH Host context (`{ webServer, effect }`).
     * Works with the same `webServer.register({kind, path, handler})` shape as
     * `integrations/dsh/runtime/index.js:392-432`.
     */
    apply(pluginContext) {
      if (!service) throw new Error('dsh adapter must be started before apply()');
      const webServer = pluginContext?.webServer;
      if (!webServer || typeof webServer.register !== 'function') {
        throw new Error('DSH host context must provide webServer.register()');
      }
      if (applied.has(pluginContext)) return handle;
      const registerOne = (route) =>
        webServer.register({
          kind: 'exact',
          path: route.path,
          handler: async (request, response) => {
            try {
              if (route.path === rawPath) {
                if (!['GET', 'HEAD'].includes(request.method)) return jsonReply(response, 405, { ok: false, error: 'method not allowed' });
                return await serveRaw(request, response);
              }
              if (route.path === `${prefix}/events` && request.method === 'GET') return await subscribe(request, response);
              const body = request.method === 'POST' ? await readRequestBody(request) : undefined;
              const url = new URL(request.url ?? route.path, 'http://127.0.0.1');
              const query = Object.fromEntries(url.searchParams.entries());
              const result = await dispatch({
                method: request.method,
                path: route.path,
                body,
                query,
                headers: request.headers ?? {},
              });
              jsonReply(response, result.status, result.payload);
            } catch (error) {
              log?.('dsh adapter error', error);
              jsonReply(response, httpStatus(error), {
                ok: false,
                error: safeMessage(asFilePluginError(error), config?.security),
              });
            }
          },
        });

      try {
        for (const route of routes) {
          const rawDispose = registerOne(route);
          let active = true;
          const dispose = () => {
            if (!active) return;
            active = false;
            return rawDispose?.();
          };
          disposers.push(dispose);
          pluginContext.effect?.(() => dispose, `${panelId}:${route.method}:${route.path}`);
        }
        applied.add(pluginContext);
      } catch (error) {
        for (const dispose of disposers.splice(0)) dispose();
        throw error;
      }
      return handle;
    },
  };

  return {
    name: 'dsh',
    async start({ service: fileService, config: pluginConfig, log: pluginLog }) {
      service = fileService;
      config = pluginConfig;
      log = pluginLog;
      if (options.hostContext) handle.apply(options.hostContext);
      return handle;
    },
    async stop() {
      for (const close of [...streams]) close();
      for (const dispose of disposers.splice(0)) {
        try {
          await dispose();
        } catch (error) {
          log?.('dsh adapter dispose failed', error);
        }
      }
    },
    describe() {
      return {
        transport: 'dsh-webServer',
        routes: routes.map((route) => `${route.method} ${route.path}`),
        panelId,
        coupling: 'none to AiNative Core / 8770 / ~/.natives',
      };
    },
  };
});
