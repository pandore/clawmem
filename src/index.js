/**
 * clawmem — Lightweight structured memory extraction for community chats.
 *
 * Usage (programmatic):
 *
 *   const clawmem = require('clawmem');
 *
 *   // Initialize database
 *   clawmem.init('./my-memory.db');
 *
 *   // Create a source adapter
 *   const adapter = clawmem.adapters.sqlite.create({
 *     path: './chat.db',
 *     table: 'messages',
 *     columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
 *   });
 *
 *   // Create a driver
 *   const driver = clawmem.createDriver('./my-memory.db');
 *
 *   // Run extraction
 *   await clawmem.extract(adapter, driver, {
 *     llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...', model: 'gpt-4o-mini' },
 *   });
 *
 *   // Query
 *   clawmem.query.searchFacts(driver, 'machine learning');
 *   clawmem.query.whoKnows(driver, 'python');
 *
 *   driver.close();
 */

const schema = require('./schema');
const extractor = require('./extractor');
const store = require('./store');
const config = require('./config');
const sqliteAdapter = require('./adapters/sqlite');
const jsonlAdapter = require('./adapters/jsonl');
const urlEnricher = require('./enrichers/url');
const { createDriver, dbExists, esc } = require('./driver');

module.exports = {
  // Schema
  init: schema.init,

  // Extraction
  extract: extractor.run,

  // Config
  loadConfig: config.load,

  // Driver
  createDriver,
  dbExists,
  esc,

  // Query helpers
  query: {
    searchFacts: store.searchFacts,
    searchTopics: store.searchTopics,
    searchMembers: store.searchMembers,
    whoKnows: store.whoKnows,
    getStats: store.getStats,
    generateRoster: store.generateRoster,
  },

  // Enrichers
  enrichers: {
    url: urlEnricher,
  },

  // Adapters
  adapters: {
    sqlite: sqliteAdapter,
    jsonl: jsonlAdapter,
  },
};
