import { defineAdapter } from './adapter.js';

/** Simplest adapter: a direct JS API for a host running in the same process. */
defineAdapter('in-process', () => {
  let service;
  return {
    name: 'in-process',
    async start({ service: fileService }) {
      service = fileService;
      return {
        service,
        call: (method, params, options) => service.call(method, params, options),
        handle: (request) => service.handle(request),
        tools: () => service.tools(),
        describe: () => service.describe(),
      };
    },
    async stop() {
      service = undefined;
    },
    describe() {
      return { transport: 'in-process', framing: 'none', sideEffects: 'none' };
    },
  };
});
