#!/usr/bin/env node
/**
 * Bin entry for the `iap-language-server` executable: start the LSP server
 * over stdio. All behavior lives in `./server.js` + `./providers.js`.
 */
import { startServer } from './server.js';

startServer();
