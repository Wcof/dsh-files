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
import { asFilePluginError, httpStatus, safeMessage } from '../protocol/errors.js';
import { callTool, toDshManifest } from '../tool-definitions.js';

defineAdapter('dsh', (options = {}) => {
  let service;
  let config;
  let log;
  const prefix = options.routePrefix ?? '/agent/files';
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

  function subscribe(request, response) {
    if (!isSameOrigin(request)) return jsonReply(response, 403, { ok: false, error: 'same-origin only' });
    if (streams.size >= 32) return jsonReply(response, 503, { ok: false, error: 'too many event subscribers' });
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
              if (route.path === `${prefix}/events` && request.method === 'GET') return subscribe(request, response);
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
