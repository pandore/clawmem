#!/usr/bin/env node
/**
 * Basic integration test for chatmem.
 * Creates a test SQLite source, runs extraction with a mock LLM, verifies results.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const chatmem = require('../src/index');
const store = require('../src/store');
const { createDriver, esc } = require('../src/driver');

const TEST_DIR = path.join(__dirname, '.test-data');
const SOURCE_DB = path.join(TEST_DIR, 'source.db');
const MEMORY_DB = path.join(TEST_DIR, 'memory.db');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

function setup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Create source database with test messages
  execSync(`sqlite3 "${SOURCE_DB}"`, {
    input: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        sender TEXT,
        content TEXT,
        timestamp TEXT
      );
      INSERT INTO messages VALUES (1, 'Alice', 'I have been using LangChain for our RAG pipeline, works great with chunk size 512', '2026-03-15T10:00:00Z');
      INSERT INTO messages VALUES (2, 'Bob', 'We switched to LlamaIndex last month, much better for large PDFs', '2026-03-15T10:05:00Z');
      INSERT INTO messages VALUES (3, 'Alice', 'Interesting! What embedding model are you using?', '2026-03-15T10:10:00Z');
      INSERT INTO messages VALUES (4, 'Bob', 'text-embedding-3-small from OpenAI, cheap and decent quality', '2026-03-15T10:15:00Z');
      INSERT INTO messages VALUES (5, 'Charlie', 'Has anyone tried Claude Code for refactoring? I use it daily on our Python backend', '2026-03-15T10:20:00Z');
      INSERT INTO messages VALUES (6, 'Alice', 'Claude Code is amazing for large refactors, saved us hours last week', '2026-03-15T10:25:00Z');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

// --- Tests ---

function testInit() {
  console.log('\n--- Test: init ---');

  const result = chatmem.init(MEMORY_DB);
  assert(result.created === true, 'Database created');
  assert(fs.existsSync(MEMORY_DB), 'File exists on disk');

  // Verify schema
  const tables = execSync(`sqlite3 "${MEMORY_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('members'), 'members table exists');
  assert(tables.includes('facts'), 'facts table exists');
  assert(tables.includes('topics'), 'topics table exists');
  assert(tables.includes('facts_fts'), 'FTS tables exist');
  assert(tables.includes('extraction_state'), 'extraction_state table exists');

  // Idempotent
  const result2 = chatmem.init(MEMORY_DB);
  assert(result2.created === false, 'Second init skips creation');
}

function testAdapter() {
  console.log('\n--- Test: sqlite adapter ---');

  const adapter = chatmem.adapters.sqlite.create({
    path: SOURCE_DB,
    table: 'messages',
    columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
  });

  const validation = adapter.validate();
  assert(validation.ok === true, 'Adapter validates successfully');

  const messages = adapter.getMessages('0');
  assert(messages.length === 6, `Got ${messages.length} messages (expected 6)`);
  assert(messages[0].sender === 'Alice', 'First message sender is Alice');
  assert(messages[0].content.includes('LangChain'), 'First message content is correct');

  // Cursor works
  const after3 = adapter.getMessages('3');
  assert(after3.length === 3, `Got ${after3.length} messages after id 3 (expected 3)`);
}

function testJsonlAdapter() {
  console.log('\n--- Test: jsonl adapter ---');

  const jsonlPath = path.join(TEST_DIR, 'messages.jsonl');
  const lines = [
    '{"id":"1","sender":"Alice","content":"Hello world","timestamp":"2026-01-01"}',
    '{"id":"2","sender":"Bob","content":"Testing JSONL adapter","timestamp":"2026-01-02"}',
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n'));

  const adapter = chatmem.adapters.jsonl.create({ path: jsonlPath });
  const validation = adapter.validate();
  assert(validation.ok === true, 'JSONL adapter validates');

  const messages = adapter.getMessages('0');
  assert(messages.length === 2, `Got ${messages.length} messages (expected 2)`);
  assert(messages[0].sender === 'Alice', 'First message sender correct');
}

function testStore() {
  console.log('\n--- Test: store operations ---');

  const memDriver = createDriver(MEMORY_DB);

  // Direct store operations (simulating what extraction does)
  store.processExtraction(memDriver, {
    members: [
      { display_name: 'Alice', username: 'alice', expertise: 'RAG, LangChain', projects: 'pipeline' },
      { display_name: 'Bob', username: 'bob', expertise: 'LlamaIndex, embeddings', projects: '' },
    ],
    facts: [
      { category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag, langchain', confidence: 0.9 },
      { category: 'opinion', content: 'LlamaIndex is better for large PDFs than LangChain', source_member: 'bob', tags: 'rag, llamaindex', confidence: 0.8 },
    ],
    topics: [
      { name: 'RAG Pipeline Comparison', summary: 'Discussion comparing LangChain vs LlamaIndex for RAG', participants: 'Alice, Bob', tags: 'rag, comparison' },
    ],
  }, '2026-03-15');

  const stats = store.getStats(memDriver);
  assert(stats.members === 2, `${stats.members} members (expected 2)`);
  assert(stats.facts === 2, `${stats.facts} facts (expected 2)`);
  assert(stats.topics === 1, `${stats.topics} topics (expected 1)`);

  // FTS search
  const ragFacts = store.searchFacts(memDriver, 'RAG');
  assert(ragFacts.length === 2, `FTS found ${ragFacts.length} RAG facts (expected 2)`);

  const ragTopics = store.searchTopics(memDriver, 'RAG');
  assert(ragTopics.length === 1, `FTS found ${ragTopics.length} RAG topics (expected 1)`);

  // Who knows
  const ragExperts = store.whoKnows(memDriver, 'RAG');
  assert(ragExperts.length === 1, `Found ${ragExperts.length} RAG experts (expected 1)`);

  // Dedup: insert same fact again (exact match)
  store.processExtraction(memDriver, {
    members: [{ display_name: 'Alice', username: 'alice', expertise: 'RAG, Python', projects: 'pipeline, new-project' }],
    facts: [{ category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag', confidence: 0.9 }],
    topics: [],
  }, '2026-03-15');

  const stats2 = store.getStats(memDriver);
  assert(stats2.members === 2, `Still ${stats2.members} members after upsert (expected 2)`);
  assert(stats2.facts === 2, `Still ${stats2.facts} facts — exact dedup worked (expected 2)`);

  // Dedup: insert semantically similar fact (LLM rephrased it)
  store.processExtraction(memDriver, {
    members: [],
    facts: [{ category: 'tool', content: 'LangChain is effective for RAG pipelines, especially with a chunk size of 512 tokens', source_member: 'alice', tags: 'rag, langchain', confidence: 0.9 }],
    topics: [{ name: 'Comparing RAG Pipeline Tools', summary: 'LangChain vs LlamaIndex comparison', participants: 'Alice, Bob', tags: 'rag' }],
  }, '2026-03-15');

  const stats3 = store.getStats(memDriver);
  assert(stats3.facts === 2, `Still ${stats3.facts} facts — semantic dedup worked (expected 2)`);
  assert(stats3.topics === 1, `Still ${stats3.topics} topics — topic dedup worked (expected 1)`);

  // Check member expertise was merged
  const alice = store.searchMembers(memDriver, 'Alice');
  assert(alice.length > 0 && alice[0].expertise.includes('Python'), 'Alice expertise merged with Python');
  assert(alice.length > 0 && alice[0].projects.includes('new-project'), 'Alice projects merged');

  memDriver.close();
}

function testConfidenceFiltering() {
  console.log('\n--- Test: confidence filtering ---');

  const memDriver = createDriver(MEMORY_DB);

  // Insert facts with different confidence levels
  store.processExtraction(memDriver, {
    members: [],
    facts: [
      { category: 'tool', content: 'High confidence fact about Docker pricing at $5/month', source_member: 'alice', tags: 'docker, pricing', confidence: 0.95 },
      { category: 'opinion', content: 'Medium confidence opinion about Kubernetes being overkill', source_member: 'bob', tags: 'kubernetes, opinion', confidence: 0.8 },
      { category: 'tool', content: 'Low confidence rumor about a new AWS service', source_member: 'alice', tags: 'aws, rumor', confidence: 0.5 },
    ],
    topics: [],
  }, '2026-03-16');

  // Search without filter
  const allFacts = store.searchFacts(memDriver, 'Docker OR Kubernetes OR AWS');
  assert(allFacts.length >= 3, `Found ${allFacts.length} facts without filter (expected >= 3)`);

  // Search with minConfidence 0.75
  const highFacts = store.searchFacts(memDriver, 'Docker OR Kubernetes OR AWS', 15, 0.75);
  assert(highFacts.length >= 2, `Found ${highFacts.length} facts with confidence >= 0.75 (expected >= 2)`);

  // Search with minConfidence 0.9
  const veryHigh = store.searchFacts(memDriver, 'Docker OR Kubernetes OR AWS', 15, 0.9);
  assert(veryHigh.length >= 1, `Found ${veryHigh.length} facts with confidence >= 0.9 (expected >= 1)`);

  // Verify ordering: high confidence first
  if (highFacts.length >= 2) {
    assert(parseFloat(highFacts[0].confidence) >= parseFloat(highFacts[1].confidence),
      'Facts ordered by confidence descending');
  }

  memDriver.close();
}

function testRoster() {
  console.log('\n--- Test: roster generation ---');

  const memDriver = createDriver(MEMORY_DB);
  const roster = store.generateRoster(memDriver);
  memDriver.close();

  assert(roster.count >= 2, `Roster has ${roster.count} members (expected >= 2)`);
  assert(roster.content.startsWith('# Community Members'), 'Roster starts with header');
  assert(roster.content.includes('Alice'), 'Roster contains Alice');
  assert(roster.content.includes('Bob'), 'Roster contains Bob');
  assert(roster.content.includes('RAG'), 'Roster includes expertise');
}

function testConversationFilter() {
  console.log('\n--- Test: conversation filtering ---');

  // Create a source with mixed group/DM conversations
  const CONV_DB = path.join(TEST_DIR, 'conv-source.db');
  execSync(`sqlite3 "${CONV_DB}"`, {
    input: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER,
        sender TEXT,
        content TEXT,
        timestamp TEXT
      );
      -- Group messages (with is_group_chat marker)
      INSERT INTO messages VALUES (1, 1, 'Alice', 'Group msg with "is_group_chat": true marker about Python', '2026-03-15');
      INSERT INTO messages VALUES (2, 1, 'Bob', 'Another group msg "is_group_chat": true about RAG', '2026-03-15');
      INSERT INTO messages VALUES (3, 1, 'Alice', 'Third group "is_group_chat": true message', '2026-03-15');
      -- DM messages (no marker)
      INSERT INTO messages VALUES (4, 2, 'Alice', 'Private DM message about secrets', '2026-03-15');
      INSERT INTO messages VALUES (5, 2, 'Alice', 'Another private DM', '2026-03-15');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const adapter = chatmem.adapters.sqlite.create({
    path: CONV_DB,
    table: 'messages',
    columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
    conversationFilter: {
      column: 'conversation_id',
      detectGroup: { contentColumn: 'content', marker: 'is_group_chat' },
    },
  });

  const validation = adapter.validate();
  assert(validation.ok === true, 'Adapter with conversation filter validates');
  assert(validation.groupConversations?.length === 1, `Detected ${validation.groupConversations?.length} group conversation(s) (expected 1)`);

  const messages = adapter.getMessages('0');
  assert(messages.length === 3, `Got ${messages.length} messages (expected 3 — group only, no DMs)`);
  assert(!messages.some(m => m.content.includes('secrets')), 'DM content excluded');
}

function testCliDriver() {
  console.log('\n--- Test: CliDriver ---');

  const driver = createDriver(MEMORY_DB, { forceBackend: 'cli' });

  assert(driver.backend === 'cli', 'Backend is cli');
  assert(driver.capabilities.inProcess === false, 'inProcess is false');
  assert(driver.capabilities.vectors === false, 'vectors is false');
  assert(driver.capabilities.transactions === false, 'transactions is false');

  // Read (COUNT)
  const rows = driver.read('SELECT COUNT(*) as c FROM members');
  assert(Array.isArray(rows), 'read returns array');
  assert(rows.length === 1 && rows[0].c !== undefined, 'read returns count row');

  // Write (INSERT then DELETE)
  driver.write("INSERT INTO members (username, display_name, first_seen, last_seen) VALUES ('cli_test_user', 'CLI Test User', '2026-01-01', '2026-01-01')");
  const inserted = driver.read("SELECT id FROM members WHERE username='cli_test_user'");
  assert(inserted.length === 1, 'INSERT via write succeeded');

  driver.write("DELETE FROM members WHERE username='cli_test_user'");
  const deleted = driver.read("SELECT id FROM members WHERE username='cli_test_user'");
  assert(deleted.length === 0, 'DELETE via write succeeded');

  // run() is alias for write
  driver.run("INSERT INTO members (username, display_name, first_seen, last_seen) VALUES ('cli_run_user', 'CLI Run User', '2026-01-01', '2026-01-01')");
  const runInserted = driver.read("SELECT id FROM members WHERE username='cli_run_user'");
  assert(runInserted.length === 1, 'run() inserts row');
  driver.write("DELETE FROM members WHERE username='cli_run_user'");

  // transaction just calls fn()
  let called = false;
  const txResult = driver.transaction(() => { called = true; return 42; });
  assert(called === true, 'transaction calls fn');
  assert(txResult === 42, 'transaction returns fn result');

  // close is a noop
  driver.close();
  assert(true, 'close() does not throw');

  // esc() — single quotes
  assert(esc("it's fine") === "it''s fine", "esc handles single quotes");
  assert(esc(null) === '', 'esc handles null');
  assert(esc(undefined) === '', 'esc handles undefined');
  assert(esc('no quotes') === 'no quotes', 'esc leaves clean strings alone');
}

function testBetterSqliteDriver() {
  console.log('\n--- Test: BetterSqliteDriver ---');

  let BetterSqlite3;
  try {
    BetterSqlite3 = require('better-sqlite3');
  } catch (_) {
    console.log('  SKIP: better-sqlite3 not installed');
    return;
  }

  const driver = createDriver(MEMORY_DB);

  assert(driver.backend === 'better-sqlite3', 'Backend is better-sqlite3');
  assert(driver.capabilities.inProcess === true, 'inProcess is true');
  assert(driver.capabilities.transactions === true, 'transactions is true');
  // vectors may or may not be true depending on sqlite-vec; just check it's a boolean
  assert(typeof driver.capabilities.vectors === 'boolean', 'vectors capability is boolean');

  // Read
  const rows = driver.read('SELECT COUNT(*) as c FROM members');
  assert(Array.isArray(rows) && rows.length === 1, 'read returns result');

  // Parameterized read with ? placeholders
  const paramRows = driver.read('SELECT * FROM members WHERE display_name = ?', ['Alice']);
  assert(Array.isArray(paramRows), 'parameterized read returns array');

  // Write with params
  driver.write(
    "INSERT INTO members (username, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)",
    ['bsql_test_user', 'BSql Test User', '2026-01-01', '2026-01-01']
  );
  const inserted = driver.read('SELECT id FROM members WHERE username = ?', ['bsql_test_user']);
  assert(inserted.length === 1, 'write with params inserted row');

  // run() is alias for write
  driver.run('DELETE FROM members WHERE username = ?', ['bsql_test_user']);
  const afterDelete = driver.read('SELECT id FROM members WHERE username = ?', ['bsql_test_user']);
  assert(afterDelete.length === 0, 'run() with params deleted row');

  // Transaction — both inserts committed atomically
  driver.transaction(() => {
    driver.write(
      "INSERT INTO members (username, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)",
      ['tx_user_1', 'TX User 1', '2026-01-01', '2026-01-01']
    );
    driver.write(
      "INSERT INTO members (username, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)",
      ['tx_user_2', 'TX User 2', '2026-01-01', '2026-01-01']
    );
  });
  const txRows = driver.read("SELECT id FROM members WHERE username IN ('tx_user_1', 'tx_user_2')");
  assert(txRows.length === 2, 'transaction committed both inserts');

  // Cleanup
  driver.write("DELETE FROM members WHERE username IN ('tx_user_1', 'tx_user_2')");

  // _db is exposed for raw access
  assert(driver._db !== undefined, '_db is exposed');

  // dbPath is stored
  assert(driver.dbPath === MEMORY_DB, 'dbPath is stored on driver');

  driver.close();
  assert(true, 'close() does not throw');
}

async function testEmbeddings() {
  console.log('\n--- Test: embeddings module ---');
  const embeddings = require('../src/embeddings');

  assert(embeddings.estimateTokens('hello world') > 0, 'Token estimation positive');
  assert(embeddings.estimateTokens('hello world') < 10, 'Token estimation reasonable');

  const texts = ['short', 'a'.repeat(1000), 'medium length text here', 'another one'];
  const batches = embeddings.splitIntoBatches(texts, 500);
  assert(batches.length >= 2, `Split into ${batches.length} batches (expected >= 2)`);
  assert(batches.flat().length === texts.length, 'All texts in batches');
}

async function testUrlEnrichment() {
  console.log('\n--- Test: URL enrichment ---');

  const urlEnricher = require('../src/enrichers/url');

  // Test with a known GitHub repo
  const messages = [
    { id: '1', content: 'Check out https://github.com/pandore/clawmem for memory extraction', sender: 'Alice', timestamp: '2026-03-17' },
    { id: '2', content: 'No URLs in this message', sender: 'Bob', timestamp: '2026-03-17' },
    { id: '3', content: 'Multiple URLs: https://github.com/pandore/clawmem and https://example.com', sender: 'Alice', timestamp: '2026-03-17' },
  ];

  const result = await urlEnricher.enrichMessages(messages, { timeoutMs: 10000 });
  assert(result.enriched >= 1, `Enriched ${result.enriched} URLs (expected >= 1)`);

  // GitHub URL should have been enriched with repo info
  const msg1 = messages[0].content;
  assert(msg1.includes('[') && msg1.includes('clawmem'), `GitHub URL enriched: ${msg1.substring(0, 120)}...`);

  // Message without URLs should be unchanged
  assert(messages[1].content === 'No URLs in this message', 'Non-URL message unchanged');

  // Test with empty messages
  const emptyResult = await urlEnricher.enrichMessages([]);
  assert(emptyResult.enriched === 0, 'Empty messages returns 0 enriched');
}

// --- Run ---

async function runAll() {
  setup();
  testInit();
  testAdapter();
  testJsonlAdapter();
  testStore();
  testConfidenceFiltering();
  testRoster();
  testConversationFilter();
  testCliDriver();
  testBetterSqliteDriver();
  await testEmbeddings();
  await testUrlEnrichment();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error(`\nTest crashed: ${err.message}\n${err.stack}`);
  cleanup();
  process.exit(1);
});
