import { readFile } from 'node:fs/promises';
import { isSameOrigin } from './adapter.js';

export const FILES_PAGE = '/dsh-files/';
const assets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['api.js', ['api.js', 'text/javascript; charset=utf-8']],
  ['locale.js', ['locale.js', 'text/javascript; charset=utf-8']],
  ['styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['icon.svg', ['icon.svg', 'image/svg+xml']],
]);

/** Only bundled assets are addressable; user paths always go through FileService. */
export function registerFilesPage(ctx) {
  return ctx.webServer.register({
    kind: 'prefix', path: '/dsh-files',
    async handler(request, response) {
      const reply = (status, text) => {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : text);
      };
      if (!isSameOrigin(request)) return reply(403, 'same-origin only');
      if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'method not allowed');
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/dsh-files') {
        response.writeHead(308, { Location: FILES_PAGE, 'Cache-Control': 'no-store' });
        return response.end();
      }
      const asset = pathname.startsWith(FILES_PAGE) ? assets.get(pathname.slice(FILES_PAGE.length)) : undefined;
      if (!asset) return reply(404, 'not found');
      try {
        const data = await readFile(new URL(`../../web/${asset[0]}`, import.meta.url));
        response.writeHead(200, {
          'Content-Type': asset[1], 'Content-Length': data.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src blob:; object-src blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        });
        response.end(request.method === 'HEAD' ? undefined : data);
      } catch {
        reply(503, 'File page assets are unavailable. Reinstall the plugin.');
      }
    },
  });
}
