/**
 * lizardbrain — Persistent memory for group chats.
 *
 * Usage (programmatic):
 *
 *   const lizardbrain = require('lizardbrain');
 *
 *   // Initialize database with profile
 *   lizardbrain.init('./my-memory.db', { profile: 'team' });
 *
 *   // Create a source adapter
 *   const adapter = lizardbrain.adapters.sqlite.create({
 *     path: './chat.db',
 *     table: 'messages',
 *     columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
 *   });
 *
 *   // Create a driver
 *   const driver = lizardbrain.createDriver('./my-memory.db');
 *
 *   // Run extraction
 *   await lizardbrain.extract(adapter, driver, {
 *     llm: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-...', model: 'gpt-4o-mini' },
 *   });
 *
 *   // Query
 *   lizardbrain.query.searchFacts(driver, 'machine learning');
 *   lizardbrain.query.whoKnows(driver, 'python');
 *
 *   driver.close();
 */

const schema = require('./schema');
const extractor = require('./extractor');
const store = require('./store');
const config = require('./config');
const profiles = require('./profiles');
const sqliteAdapter = require('./adapters/sqlite');
const jsonlAdapter = require('./adapters/jsonl');
const urlEnricher = require('./enrichers/url');
const { createDriver, dbExists, esc } = require('./driver');
const search = require('./search');
const embeddings = require('./embeddings');

module.exports = {
  // Schema
  init: schema.init,
  migrate: schema.migrate,

  // Profiles
  profiles,

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
    searchDecisions: store.searchDecisions,
    searchTasks: store.searchTasks,
    searchQuestions: store.searchQuestions,
    searchEvents: store.searchEvents,
    whoKnows: store.whoKnows,
    getStats: store.getStats,
    generateRoster: store.generateRoster,
    updateDecisionStatus: store.updateDecisionStatus,
    updateTaskStatus: store.updateTaskStatus,
    updateQuestionAnswer: store.updateQuestionAnswer,
    getActiveContext: store.getActiveContext,
    formatContext: store.formatContext,
  },

  // Search (hybrid FTS5 + kNN + RRF)
  search: search.search,

  // Embeddings
  embeddings: {
    backfill: embeddings.backfill,
    getStats: embeddings.getEmbeddingStats,
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
