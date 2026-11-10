/** Cordis lifecycle, also exported from the package root alongside the JS API. */
import { createFilePlugin } from './host.js';
import { createAdapter } from './adapters/index.js';
import { callTool } from './tool-definitions.js';
import { asFilePluginError, safeMessage } from './protocol/errors.js';
import { registerFilesPage } from './adapters/dsh-web.js';

export const name = 'dsh-files';
export const inject = ['tools'];

export async function apply(ctx, config = {}) {
  const plugin = createFilePlugin(config);
  ctx.effect(() => () => plugin.dispose());
  try {
    await plugin.backend.init?.();
    for (const tool of plugin.tools()) {
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        output: {
          schema: {},
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          try {
            return await callTool(plugin.service, tool.name, args, { signal: exec?.signal });
          } catch (error) {
            const structured = asFilePluginError(error);
            throw Object.assign(new Error(safeMessage(structured, plugin.config.security)), { code: structured.code });
          }
        },
      });
    }
    // Web profiles expose the existing API too; headless profiles need only tools.
    ctx.inject(['webServer'], async (webContext) => {
      const adapter = createAdapter('dsh');
      webContext.effect(() => () => adapter.stop());
      const handle = await adapter.start({ service: plugin.service, config: plugin.config, log: plugin.config.log });
      handle.apply(webContext);
      webContext.effect(() => registerFilesPage(webContext), 'dsh-files:page');
    });
  } catch (error) {
    await plugin.dispose();
    throw error;
  }
}
