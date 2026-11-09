/**
 * Loopback HTTP adapter — the neutral transport used by any agent that can
 * speak JSON over HTTP (and by the local CLI).
 */

import http from 'node:http';
import { defineAdapter, jsonReply, readRequestBody, isSameOrigin } from './adapter.js';
import { asFilePluginError, httpStatus, safeMessage } from '../protocol/errors.js';
import { callTool } from '../tool-definitions.js';

defineAdapter('http', (options = {}) => {
  let server;
  let service;
  let config;
  let address;
  const prefix = options.routePrefix ?? '';

  function authorized(request) {
    const token = options.token ?? config?.http?.token;
    if (!token) return true;
    const header = request.headers?.authorization ?? '';
    return header === `Bearer ${token}`;
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname.slice(prefix.length) || '/';
    if (options.sameOriginOnly !== false && !isSameOrigin(request)) {
      jsonReply(response, 403, { code: 'cross-origin', message: 'same-origin only' });
      return;
    }
    if (!authorized(request)) {
      jsonReply(response, 401, { code: 'unauthorized', message: 'invalid token' });
      return;
    }
    if (request.method === 'GET' && pathname === '/healthz') {
      jsonReply(response, 200, { ok: true, backend: service.backend.name });
      return;
    }
    if (request.method === 'GET' && pathname === '/tools') {
      jsonReply(response, 200, { tools: service.tools() });
      return;
    }
    if (request.method === 'GET' && pathname === '/describe') {
      jsonReply(response, 200, service.describe());
      return;
    }
    if (request.method === 'POST' && (pathname === '/rpc' || pathname === '/tools/call')) {
      let body;
      try {
        body = JSON.parse(await readRequestBody(request));
      } catch (error) {
        jsonReply(response, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (pathname === '/tools/call' || typeof body?.name === 'string') {
        try {
          const result = await callTool(service, body.name, body.arguments ?? body.input ?? {});
          jsonReply(response, 200, { ok: true, result });
        } catch (error) {
          jsonReply(response, httpStatus(error), { ok: false, error: safeMessage(error, config?.security) });
        }
        return;
      }
      jsonReply(response, 200, await service.handle(body));
      return;
    }
    jsonReply(response, 404, { ok: false, error: 'not found' });
  }

  return {
    name: 'http',
    async start({ service: fileService, config: pluginConfig, log }) {
      service = fileService;
      config = pluginConfig;
      // Embedding mode: the host already owns an HTTP server and only needs
      // the handler. No socket is opened, no port is allocated.
      if (options.listen === false) {
        return { handler: route, listen: false, prefix };
      }
      server = http.createServer((request, response) => {
        route(request, response).catch((error) => {
          log?.('http adapter error', error);
          jsonReply(response, httpStatus(error), {
            ok: false,
            error: safeMessage(asFilePluginError(error), config?.security),
          });
        });
      });
      const host = options.host ?? config.http.host;
      const port = options.port ?? config.http.port;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      address = server.address();
      log?.(`file plugin http adapter listening on http://${host}:${address.port}`);
      return {
        url: `http://${host}:${address.port}${prefix}`,
        port: address.port,
        server,
      };
    },
    /** Exposed for hosts that already own an HTTP server and only need a handler. */
    handler: route,
    async stop() {
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    },
    describe() {
      return {
        transport: 'http',
        mode: options.listen === false ? 'injected-handler' : 'standalone-server',
        bind: options.listen === false ? 'none (host-owned server)' : `${options.host ?? '127.0.0.1'}:${options.port ?? 'configured'}`,
        routes: ['GET /healthz', 'GET /tools', 'GET /describe', 'POST /rpc', 'POST /tools/call'],
        auth: options.token || config?.http?.token ? 'bearer-token' : 'none',
      };
    },
  };
});
