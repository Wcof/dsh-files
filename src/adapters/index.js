/**
 * Adapter registry. Importing this module registers all built-in adapters.
 * A new agent only needs one file that calls defineAdapter().
 */

import { defineAdapter, createAdapter, validateAdapter, listAdapters } from './adapter.js';
import './in-process.js';
import './dsh.js';
import './zcode.js';
import './mcp.js';
import './http.js';

export { defineAdapter, createAdapter, validateAdapter, listAdapters };
export {
  readLineStream,
  isSameOrigin,
  jsonReply,
  readRequestBody,
} from './adapter.js';
