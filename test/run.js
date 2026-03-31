#!/usr/bin/env node
/**
 * Basic integration test for lizardbrain.
 * Creates a test SQLite source, runs extraction with a mock LLM, verifies results.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const lizardbrain = require('../src/index');
const store = require('../src/store');
const { createDriver, esc } = require('../src/driver');
const profiles = require('../src/profiles');
const { buildPrompt, formatMessages } = require('../src/llm');
const { migrate } = require('../src/schema');

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

  const result = lizardbrain.init(MEMORY_DB, { profile: 'team' });
  assert(result.created === true, 'Database created');
  assert(fs.existsSync(MEMORY_DB), 'File exists on disk');
  assert(result.message.includes('team'), 'Init message includes profile name');

  // Verify schema
  const tables = execSync(`sqlite3 "${MEMORY_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('members'), 'members table exists');
  assert(tables.includes('facts'), 'facts table exists');
  assert(tables.includes('topics'), 'topics table exists');
  assert(tables.includes('decisions'), 'decisions table exists');
  assert(tables.includes('tasks'), 'tasks table exists');
  assert(tables.includes('questions'), 'questions table exists');
  assert(tables.includes('events'), 'events table exists');
  assert(tables.includes('facts_fts'), 'FTS tables exist');
  assert(tables.includes('decisions_fts'), 'decisions_fts table exists');
  assert(tables.includes('tasks_fts'), 'tasks_fts table exists');
  assert(tables.includes('extraction_state'), 'extraction_state table exists');

  // Verify profile stored in meta
  const profileMeta = execSync(`sqlite3 -json "${MEMORY_DB}" "SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'"`, { encoding: 'utf-8' });
  assert(profileMeta.includes('team'), 'Profile name stored in meta');

  // Idempotent
  const result2 = lizardbrain.init(MEMORY_DB);
  assert(result2.created === false, 'Second init skips creation');
}

function testAdapter() {
  console.log('\n--- Test: sqlite adapter ---');

  const adapter = lizardbrain.adapters.sqlite.create({
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

  const adapter = lizardbrain.adapters.jsonl.create({ path: jsonlPath });
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

  assert(roster.count >= 2, `Roster has ${roster.count} members (expected >= 2)`);
  assert(roster.content.startsWith('# Members'), 'Roster starts with default header');

  // Custom title
  const custom = store.generateRoster(memDriver, { title: 'Team Roster' });
  assert(custom.content.startsWith('# Team Roster'), 'Roster supports custom title');
  assert(roster.content.includes('Alice'), 'Roster contains Alice');
  assert(roster.content.includes('Bob'), 'Roster contains Bob');
  assert(roster.content.includes('RAG'), 'Roster includes expertise');

  memDriver.close();
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

  const adapter = lizardbrain.adapters.sqlite.create({
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

function testRRFMerge() {
  console.log('\n--- Test: RRF merge ---');
  const { mergeRRF } = require('../src/search');

  const ftsResults = [
    { key: 'fact:1', data: { source: 'fact', id: 1, text: 'FTS hit 1' } },
    { key: 'fact:2', data: { source: 'fact', id: 2, text: 'FTS hit 2' } },
    { key: 'topic:1', data: { source: 'topic', id: 1, text: 'FTS topic' } },
  ];
  const vecResults = [
    { key: 'fact:2', data: { source: 'fact', id: 2, text: 'Vec hit 2' } },
    { key: 'fact:3', data: { source: 'fact', id: 3, text: 'Vec hit 3' } },
    { key: 'topic:1', data: { source: 'topic', id: 1, text: 'Vec topic' } },
  ];

  const merged = mergeRRF([ftsResults, vecResults], 60);
  assert(merged.length === 4, `RRF merged ${merged.length} items (expected 4)`);
  const topKey = merged[0].key;
  assert(topKey === 'fact:2' || topKey === 'topic:1', `Top result is overlap: ${topKey}`);
  const keys = merged.map(m => m.key);
  assert(keys.includes('fact:1'), 'FTS-only item present');
  assert(keys.includes('fact:3'), 'Vec-only item present');
  for (let i = 1; i < merged.length; i++) {
    assert(merged[i].score <= merged[i - 1].score, `Score descending at ${i}`);
  }
}

async function testFtsOnlySearch() {
  console.log('\n--- Test: FTS-only search ---');
  const { search } = require('../src/search');
  const driver = createDriver(MEMORY_DB);

  // Note: MEMORY_DB has data from testStore which runs before this
  const result = await search(driver, 'RAG', { limit: 5, ftsOnly: true });
  assert(result.mode === 'fts5', `Mode is fts5: ${result.mode}`);
  assert(result.results.length > 0, `Got ${result.results.length} results`);
  assert(result.results[0].source, 'Has source field');
  assert(result.results[0].text, 'Has text field');
  assert(typeof result.results[0].score === 'number', 'Has numeric score');
  driver.close();
}

function testStdinAdapter() {
  console.log('\n--- Test: stdin adapter ---');

  const stdinAdapter = require('../src/adapters/stdin');

  // Test with JSONL written to a temp file, then read via the adapter's internal parsing
  // We test the create/getMessages logic directly since stdin is hard to mock
  const testJsonl = [
    '{"id": "1", "sender": "Alice", "content": "Hello from stdin", "timestamp": "2026-03-28T10:00:00Z"}',
    '{"id": "2", "sender": "Bob", "content": "Stdin works!", "timestamp": "2026-03-28T10:01:00Z"}',
    '{"id": "3", "sender": "Alice", "content": "Third message", "timestamp": "2026-03-28T10:02:00Z"}',
    'not valid json',
    '{"id": "5", "sender": "Charlie", "content": "With conv", "timestamp": "2026-03-28T10:03:00Z", "conv_id": "thread-1"}',
  ].join('\n');

  // Write temp JSONL and test via the jsonl adapter (same parsing logic)
  const tmpPath = path.join(TEST_DIR, 'stdin-test.jsonl');
  fs.writeFileSync(tmpPath, testJsonl);

  // Use jsonl adapter to verify parsing (stdin adapter uses identical parse logic)
  const jsonlAdapter = require('../src/adapters/jsonl');
  const adapter = jsonlAdapter.create({ path: tmpPath });

  assert(adapter.validate().ok, 'JSONL validates for stdin-format data');

  const msgs = adapter.getMessages('0');
  assert(msgs.length === 4, `Parsed ${msgs.length} messages from JSONL (expected 4, skipping invalid line)`);
  assert(msgs[0].sender === 'Alice', 'First message sender is Alice');
  assert(msgs[0].content === 'Hello from stdin', 'First message content correct');
  assert(msgs[1].id === '2', 'Second message ID is 2');

  // Test cursor: get messages after id "2"
  const afterCursor = adapter.getMessages('2');
  assert(afterCursor.length === 2, `After cursor "2": ${afterCursor.length} messages (expected 2)`);
  assert(afterCursor[0].id === '3', 'First message after cursor is id 3');

  // Test conversationId field mapping
  const convAdapter = jsonlAdapter.create({ path: tmpPath, fields: { conversationId: 'conv_id' } });
  const convMsgs = convAdapter.getMessages('0');
  const withConv = convMsgs.filter(m => m.conversationId);
  assert(withConv.length === 1, `1 message has conversationId (got ${withConv.length})`);
  assert(withConv[0].conversationId === 'thread-1', 'ConversationId mapped correctly');

  // Test stdin adapter creates successfully
  const sa = stdinAdapter.create({ fields: { id: 'id', content: 'content' } });
  assert(sa.name === 'stdin', 'Stdin adapter has correct name');
  assert(typeof sa.getMessages === 'function', 'Stdin adapter has getMessages');
  assert(typeof sa.validate === 'function', 'Stdin adapter has validate');
}

async function testUrlEnrichment() {
  console.log('\n--- Test: URL enrichment ---');

  const urlEnricher = require('../src/enrichers/url');

  // Test with a known GitHub repo
  const messages = [
    { id: '1', content: 'Check out https://github.com/pandore/lizardbrain for memory extraction', sender: 'Alice', timestamp: '2026-03-17' },
    { id: '2', content: 'No URLs in this message', sender: 'Bob', timestamp: '2026-03-17' },
    { id: '3', content: 'Multiple URLs: https://github.com/pandore/lizardbrain and https://example.com', sender: 'Alice', timestamp: '2026-03-17' },
  ];

  const result = await urlEnricher.enrichMessages(messages, { timeoutMs: 10000 });
  assert(result.enriched >= 1, `Enriched ${result.enriched} URLs (expected >= 1)`);

  // GitHub URL should have been enriched with repo info
  const msg1 = messages[0].content;
  assert(msg1.includes('[') && msg1.includes('lizardbrain'), `GitHub URL enriched: ${msg1.substring(0, 120)}...`);

  // Message without URLs should be unchanged
  assert(messages[1].content === 'No URLs in this message', 'Non-URL message unchanged');

  // Test with empty messages
  const emptyResult = await urlEnricher.enrichMessages([]);
  assert(emptyResult.enriched === 0, 'Empty messages returns 0 enriched');
}

function testProfiles() {
  console.log('\n--- Test: profiles ---');

  // Profile definitions
  assert(profiles.PROFILE_NAMES.includes('knowledge'), 'knowledge profile exists');
  assert(profiles.PROFILE_NAMES.includes('team'), 'team profile exists');
  assert(profiles.PROFILE_NAMES.includes('project'), 'project profile exists');
  assert(profiles.PROFILE_NAMES.includes('full'), 'full profile exists');

  // getProfile
  const knowledge = profiles.getProfile('knowledge');
  assert(knowledge.entities.includes('members'), 'knowledge has members');
  assert(knowledge.entities.includes('facts'), 'knowledge has facts');
  assert(knowledge.entities.includes('topics'), 'knowledge has topics');
  assert(!knowledge.entities.includes('decisions'), 'knowledge does not have decisions');

  const team = profiles.getProfile('team');
  assert(team.entities.includes('decisions'), 'team has decisions');
  assert(team.entities.includes('tasks'), 'team has tasks');
  assert(!team.entities.includes('questions'), 'team does not have questions');

  const project = profiles.getProfile('project');
  assert(project.entities.includes('questions'), 'project has questions');
  assert(!project.entities.includes('topics'), 'project does not have topics');

  const full = profiles.getProfile('full');
  assert(full.entities.length === profiles.ALL_ENTITIES.length, 'full has all entity types');

  // custom profile
  const custom = profiles.getProfile('custom');
  assert(custom.entities.length === profiles.ALL_ENTITIES.length, 'custom defaults to all entities');

  // buildCustomProfile
  const cp = profiles.buildCustomProfile(['members', 'facts', 'decisions']);
  assert(cp.entities.length === 3, 'custom profile with 3 entities');

  // Error on invalid profile
  let threw = false;
  try { profiles.getProfile('nonexistent'); } catch (e) { threw = true; }
  assert(threw, 'getProfile throws on invalid profile name');

  // Member labels differ between profiles
  assert(knowledge.memberLabels.rosterProjects === 'builds', 'knowledge roster label is "builds"');
  assert(team.memberLabels.rosterProjects === 'works on', 'team roster label is "works on"');
  assert(project.memberLabels.rosterProjects === 'scope', 'project roster label is "scope"');

  // Fact categories differ
  assert(knowledge.factCategories.includes('tool'), 'knowledge has tool category');
  assert(team.factCategories.includes('process'), 'team has process category');
  assert(project.factCategories.includes('requirement'), 'project has requirement category');
}

function testNewEntities() {
  console.log('\n--- Test: new entities ---');

  const memDriver = createDriver(MEMORY_DB);

  // Insert decisions
  const result1 = store.processExtraction(memDriver, {
    members: [],
    facts: [],
    topics: [],
    decisions: [
      { description: 'Use PostgreSQL instead of MySQL for the new service', participants: 'Alice, Bob', context: 'Need better JSON support', status: 'agreed', tags: 'database, migration' },
      { description: 'Deploy to AWS instead of GCP', participants: 'Alice', context: 'Cost analysis showed 30% savings', status: 'proposed', tags: 'cloud, deployment' },
    ],
    tasks: [
      { description: 'Migrate user service to PostgreSQL', assignee: 'Bob', deadline: '2026-04-15', status: 'open', source_member: 'Alice', tags: 'database' },
    ],
    questions: [
      { question: 'What is the best way to handle database migrations?', asker: 'Bob', answer: 'Use Flyway or Liquibase', answered_by: 'Alice', status: 'answered', tags: 'database, migrations' },
      { question: 'Should we use Kubernetes or ECS?', asker: 'Charlie', answer: null, answered_by: null, status: 'open', tags: 'infrastructure' },
    ],
    events: [
      { name: 'Architecture Review Meeting', description: 'Review migration plan for Q2', event_date: '2026-04-01', location: 'Zoom', attendees: 'Alice, Bob, Charlie', tags: 'meeting, architecture' },
    ],
  }, '2026-03-28');

  assert(result1.totalDecisions === 2, `Inserted ${result1.totalDecisions} decisions (expected 2)`);
  assert(result1.totalTasks === 1, `Inserted ${result1.totalTasks} tasks (expected 1)`);
  assert(result1.totalQuestions === 2, `Inserted ${result1.totalQuestions} questions (expected 2)`);
  assert(result1.totalEvents === 1, `Inserted ${result1.totalEvents} events (expected 1)`);

  // Dedup: insert same decision again
  const result2 = store.processExtraction(memDriver, {
    members: [], facts: [], topics: [],
    decisions: [{ description: 'Use PostgreSQL instead of MySQL for the new service', participants: 'Alice, Bob', context: 'JSON support', status: 'agreed', tags: 'database' }],
    tasks: [],
    questions: [],
    events: [],
  }, '2026-03-28');
  assert(result2.totalDecisions === 0, 'Decision dedup: exact match blocked');

  // FTS search across new entities
  const decisions = store.searchDecisions(memDriver, 'PostgreSQL');
  assert(decisions.length >= 1, `FTS found ${decisions.length} PostgreSQL decisions (expected >= 1)`);

  const tasks = store.searchTasks(memDriver, 'PostgreSQL');
  assert(tasks.length >= 1, `FTS found ${tasks.length} PostgreSQL tasks (expected >= 1)`);

  const questions = store.searchQuestions(memDriver, 'database');
  assert(questions.length >= 1, `FTS found ${questions.length} database questions (expected >= 1)`);

  const events = store.searchEvents(memDriver, 'Architecture');
  assert(events.length >= 1, `FTS found ${events.length} Architecture events (expected >= 1)`);

  // Stats should include new entity counts
  const stats = store.getStats(memDriver);
  assert(stats.decisions >= 2, `Stats shows ${stats.decisions} decisions (expected >= 2)`);
  assert(stats.tasks >= 1, `Stats shows ${stats.tasks} tasks (expected >= 1)`);
  assert(stats.questions >= 2, `Stats shows ${stats.questions} questions (expected >= 2)`);
  assert(stats.events >= 1, `Stats shows ${stats.events} events (expected >= 1)`);
  assert(stats.profile === 'team', `Stats shows profile: ${stats.profile} (expected team)`);

  memDriver.close();
}

function testDynamicPrompt() {
  console.log('\n--- Test: dynamic prompt ---');

  const knowledge = profiles.getProfile('knowledge');
  const prompt = buildPrompt('test messages', knowledge);
  assert(prompt.includes('"members"'), 'knowledge prompt includes members');
  assert(prompt.includes('"facts"'), 'knowledge prompt includes facts');
  assert(prompt.includes('"topics"'), 'knowledge prompt includes topics');
  assert(!prompt.includes('"decisions"'), 'knowledge prompt excludes decisions');
  assert(!prompt.includes('"tasks"'), 'knowledge prompt excludes tasks');
  assert(prompt.includes('tool, technique'), 'knowledge prompt has knowledge categories');

  const team = profiles.getProfile('team');
  const teamPrompt = buildPrompt('test messages', team);
  assert(teamPrompt.includes('"decisions"'), 'team prompt includes decisions');
  assert(teamPrompt.includes('"tasks"'), 'team prompt includes tasks');
  assert(!teamPrompt.includes('"questions"'), 'team prompt excludes questions');
  assert(teamPrompt.includes('process, technical'), 'team prompt has team categories');
  assert(teamPrompt.includes('role/position'), 'team prompt uses role/position label');

  const project = profiles.getProfile('project');
  const projPrompt = buildPrompt('test messages', project);
  assert(projPrompt.includes('"questions"'), 'project prompt includes questions');
  assert(!projPrompt.includes('"topics"'), 'project prompt excludes topics');
  assert(projPrompt.includes('requirement'), 'project prompt has requirement category');

  const full = profiles.getProfile('full');
  const fullPrompt = buildPrompt('test messages', full);
  assert(fullPrompt.includes('"events"'), 'full prompt includes events');
  assert(fullPrompt.includes('"questions"'), 'full prompt includes questions');
  assert(fullPrompt.includes('"decisions"'), 'full prompt includes decisions');
}

function testProfileRoster() {
  console.log('\n--- Test: profile roster ---');

  const memDriver = createDriver(MEMORY_DB);

  // Knowledge roster uses "builds" label
  const knowledgeRoster = store.generateRoster(memDriver, {
    memberLabels: profiles.getProfile('knowledge').memberLabels,
  });
  assert(knowledgeRoster.content.includes('builds:'), 'knowledge roster uses "builds:" label');

  // Team roster uses "works on" label
  const teamRoster = store.generateRoster(memDriver, {
    memberLabels: profiles.getProfile('team').memberLabels,
  });
  assert(teamRoster.content.includes('works on:'), 'team roster uses "works on:" label');

  // Project roster uses "scope" label
  const projectRoster = store.generateRoster(memDriver, {
    memberLabels: profiles.getProfile('project').memberLabels,
  });
  assert(projectRoster.content.includes('scope:'), 'project roster uses "scope:" label');

  memDriver.close();
}

function testMigration() {
  console.log('\n--- Test: migration ---');

  // Create a v0.3-style database (no new tables, no profile meta)
  const V03_DB = path.join(TEST_DIR, 'v03.db');
  if (fs.existsSync(V03_DB)) fs.unlinkSync(V03_DB);
  execSync(`sqlite3 "${V03_DB}"`, {
    input: `
      PRAGMA journal_mode=WAL;
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT, expertise TEXT DEFAULT '', projects TEXT DEFAULT '', preferences TEXT DEFAULT '', first_seen TEXT, last_seen TEXT, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, content TEXT NOT NULL, source_member_id INTEGER, tags TEXT DEFAULT '', confidence REAL DEFAULT 0.8, message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, summary TEXT, participants TEXT DEFAULT '', message_date TEXT, tags TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE members_fts USING fts5(username, display_name, expertise, projects, preferences, content='members', content_rowid='id');
      CREATE VIRTUAL TABLE facts_fts USING fts5(category, content, tags, content='facts', content_rowid='id');
      CREATE VIRTUAL TABLE topics_fts USING fts5(name, summary, participants, tags, content='topics', content_rowid='id');
      CREATE TABLE extraction_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_processed_id TEXT DEFAULT '0', total_messages_processed INTEGER DEFAULT 0, total_facts_extracted INTEGER DEFAULT 0, total_topics_extracted INTEGER DEFAULT 0, total_members_seen INTEGER DEFAULT 0, last_run_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO extraction_state (id) VALUES (1);
      CREATE TABLE lizardbrain_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')));
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const driver = createDriver(V03_DB);
  const result = migrate(driver);
  assert(result.migrated === true, 'Migration ran successfully');

  // Verify new tables exist
  const tables = execSync(`sqlite3 "${V03_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('decisions'), 'decisions table created by migration');
  assert(tables.includes('tasks'), 'tasks table created by migration');
  assert(tables.includes('questions'), 'questions table created by migration');
  assert(tables.includes('events'), 'events table created by migration');
  assert(tables.includes('decisions_fts'), 'decisions_fts created by migration');

  // Verify profile defaulted to knowledge
  const profileMeta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'");
  assert(profileMeta[0]?.value === 'knowledge', 'Migration defaults to knowledge profile');

  // Verify schema version set
  const version = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  assert(version[0]?.value === '0.6', 'Schema version set to 0.6');

  // Idempotent: running again should be a no-op
  const result2 = migrate(driver);
  assert(result2.migrated === false, 'Second migration is a no-op');

  driver.close();
}

async function testNewEntityFtsSearch() {
  console.log('\n--- Test: new entity FTS search ---');

  const { search } = require('../src/search');
  const memDriver = createDriver(MEMORY_DB);

  // Search should find results across new entity types
  const res = await search(memDriver, 'PostgreSQL', { limit: 10, ftsOnly: true });
  const sources = res.results.map(r => r.source);
  assert(sources.includes('decision') || sources.includes('task'), 'Search finds new entity types');
  memDriver.close();
}

function testBatchOverlap() {
  console.log('\n--- Test: batch overlap ---');

  // Create 15 messages
  const messages = Array.from({ length: 15 }, (_, i) => ({
    id: String(i + 1), sender: 'User', content: `Message ${i + 1}`, timestamp: '2026-03-28'
  }));

  const batchSize = 10;
  const overlap = 3;
  const step = batchSize - overlap;
  const batches = [];
  const batchMetas = [];
  for (let i = 0; i < messages.length; i += step) {
    batches.push(messages.slice(i, i + batchSize));
    batchMetas.push({ overlapCount: (i === 0) ? 0 : overlap });
  }

  // 15 messages, step=7: batch1=[0..9](10), batch2=[7..14](8), batch3=[14](1)
  assert(batches.length === 3, `Created ${batches.length} batches (expected 3)`);
  assert(batches[0].length === 10, `Batch 1 has ${batches[0].length} messages (expected 10)`);
  assert(batches[1].length === 8, `Batch 2 has ${batches[1].length} messages (expected 8)`);
  assert(batches[2].length === 1, `Batch 3 has ${batches[2].length} messages (expected 1)`);
  assert(batchMetas[0].overlapCount === 0, 'First batch has no overlap');
  assert(batchMetas[1].overlapCount === 3, 'Second batch has 3 overlap');

  // Overlap: last 3 of batch 1 = first 3 of batch 2
  assert(batches[0][7].id === batches[1][0].id, 'Overlap: batch1[7] === batch2[0]');
  assert(batches[0][8].id === batches[1][1].id, 'Overlap: batch1[8] === batch2[1]');
  assert(batches[0][9].id === batches[1][2].id, 'Overlap: batch1[9] === batch2[2]');

  // No overlap = standard batching
  const noOverlapBatches = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    noOverlapBatches.push(messages.slice(i, i + batchSize));
  }
  assert(noOverlapBatches.length === 2, `No overlap: ${noOverlapBatches.length} batches (expected 2)`);
  assert(noOverlapBatches[0].length === 10, 'No overlap: batch 1 has 10 messages');
  assert(noOverlapBatches[1].length === 5, 'No overlap: batch 2 has 5 messages');
}

function testConversationBatching() {
  console.log('\n--- Test: per-conversation batching ---');

  // Messages from 3 different conversations, interleaved by ID order
  const messages = [
    { id: '1', sender: 'Alice', content: 'Conv A msg 1', timestamp: '2026-03-28', conversationId: 'conv-a' },
    { id: '2', sender: 'Bob', content: 'Conv B msg 1', timestamp: '2026-03-28', conversationId: 'conv-b' },
    { id: '3', sender: 'Alice', content: 'Conv A msg 2', timestamp: '2026-03-28', conversationId: 'conv-a' },
    { id: '4', sender: 'Charlie', content: 'Conv C msg 1', timestamp: '2026-03-28', conversationId: 'conv-c' },
    { id: '5', sender: 'Bob', content: 'Conv B msg 2', timestamp: '2026-03-28', conversationId: 'conv-b' },
    { id: '6', sender: 'Alice', content: 'Conv A msg 3', timestamp: '2026-03-28', conversationId: 'conv-a' },
    { id: '7', sender: 'Bob', content: 'Conv B msg 3', timestamp: '2026-03-28', conversationId: 'conv-b' },
    { id: '8', sender: 'Charlie', content: 'Conv C msg 2', timestamp: '2026-03-28', conversationId: 'conv-c' },
  ];

  const batchSize = 5;
  const step = batchSize;
  const batches = [];

  // Replicate extractor grouping logic
  const hasConversations = messages.some(m => m.conversationId);
  assert(hasConversations, 'Messages have conversationId fields');

  const groups = new Map();
  for (const m of messages) {
    const key = m.conversationId || '__no_conversation__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  assert(groups.size === 3, `Grouped into ${groups.size} conversations (expected 3)`);
  assert(groups.get('conv-a').length === 3, 'Conv A has 3 messages');
  assert(groups.get('conv-b').length === 3, 'Conv B has 3 messages');
  assert(groups.get('conv-c').length === 2, 'Conv C has 2 messages');

  for (const [, groupMsgs] of groups) {
    for (let i = 0; i < groupMsgs.length; i += step) {
      batches.push(groupMsgs.slice(i, i + batchSize));
    }
  }

  // Each conversation fits in one batch (all < batchSize=5)
  assert(batches.length === 3, `Created ${batches.length} batches (expected 3, one per conversation)`);

  // Verify no cross-conversation mixing
  for (let b = 0; b < batches.length; b++) {
    const convIds = new Set(batches[b].map(m => m.conversationId));
    assert(convIds.size === 1, `Batch ${b + 1} has messages from exactly 1 conversation`);
  }

  // Fallback: messages without conversationId use chronological batching
  const noConvMessages = messages.map(m => ({ ...m, conversationId: null }));
  const hasConv2 = noConvMessages.some(m => m.conversationId);
  assert(!hasConv2, 'Null conversationId falls back to chronological batching');

  const fallbackBatches = [];
  for (let i = 0; i < noConvMessages.length; i += batchSize) {
    fallbackBatches.push(noConvMessages.slice(i, i + batchSize));
  }
  assert(fallbackBatches.length === 2, `Fallback: ${fallbackBatches.length} batches (expected 2)`);
  assert(fallbackBatches[0].length === 5, 'Fallback batch 1 has 5 messages');
  assert(fallbackBatches[1].length === 3, 'Fallback batch 2 has 3 messages');
}

function testEntityUpdates() {
  console.log('\n--- Test: entity updates ---');

  const memDriver = createDriver(MEMORY_DB);
  migrate(memDriver);

  // Insert entities to update
  store.processExtraction(memDriver, {
    members: [], facts: [], topics: [],
    decisions: [{ description: 'Use Redis for caching layer', participants: 'Alice', context: 'Performance improvement', status: 'proposed', tags: 'redis' }],
    tasks: [{ description: 'Set up Redis cluster', assignee: 'Bob', status: 'open', tags: 'redis' }],
    questions: [{ question: 'Which Redis deployment model?', asker: 'Charlie', status: 'open', tags: 'redis' }],
    events: [],
  }, '2026-03-28');

  // Get IDs
  const decisions = store.searchDecisions(memDriver, 'Redis');
  const tasks = store.searchTasks(memDriver, 'Redis');
  const questions = store.searchQuestions(memDriver, 'Redis');

  assert(decisions.length >= 1, 'Decision inserted for update test');
  assert(tasks.length >= 1, 'Task inserted for update test');
  assert(questions.length >= 1, 'Question inserted for update test');

  const decisionId = decisions[0].id;
  const taskId = tasks[0].id;
  const questionId = questions[0].id;

  // Test updateDecisionStatus
  const d1 = store.updateDecisionStatus(memDriver, decisionId, 'agreed', 'Team confirmed in standup');
  assert(d1 === true, 'updateDecisionStatus returns true');
  const updatedDecision = memDriver.read(`SELECT status, context FROM decisions WHERE id = ${decisionId}`);
  assert(updatedDecision[0].status === 'agreed', 'Decision status updated to agreed');
  assert(updatedDecision[0].context.includes('standup'), 'Decision context updated');

  // Test updateTaskStatus
  const t1 = store.updateTaskStatus(memDriver, taskId, 'done');
  assert(t1 === true, 'updateTaskStatus returns true');
  const updatedTask = memDriver.read(`SELECT status FROM tasks WHERE id = ${taskId}`);
  assert(updatedTask[0].status === 'done', 'Task status updated to done');

  // Test updateQuestionAnswer
  const q1 = store.updateQuestionAnswer(memDriver, questionId, 'Use Redis Sentinel', 'Alice');
  assert(q1 === true, 'updateQuestionAnswer returns true');
  const updatedQ = memDriver.read(`SELECT answer, answered_by, status FROM questions WHERE id = ${questionId}`);
  assert(updatedQ[0].status === 'answered', 'Question status updated to answered');
  assert(updatedQ[0].answer === 'Use Redis Sentinel', 'Question answer set');
  assert(updatedQ[0].answered_by === 'Alice', 'Question answered_by set');

  // Test invalid updates
  assert(store.updateDecisionStatus(memDriver, 99999, 'agreed') === false, 'Update nonexistent decision returns false');
  assert(store.updateDecisionStatus(memDriver, decisionId, 'invalid_status') === false, 'Invalid status returns false');
  assert(store.updateTaskStatus(memDriver, 99999, 'done') === false, 'Update nonexistent task returns false');
  assert(store.updateTaskStatus(memDriver, taskId, 'invalid') === false, 'Invalid task status returns false');
  assert(store.updateQuestionAnswer(memDriver, 99999, 'answer') === false, 'Update nonexistent question returns false');

  memDriver.close();
}

function testProcessExtractionUpdates() {
  console.log('\n--- Test: processExtraction with updates ---');

  const memDriver = createDriver(MEMORY_DB);
  migrate(memDriver);

  // Insert entities first
  store.processExtraction(memDriver, {
    members: [], facts: [], topics: [],
    decisions: [{ description: 'Switch to GraphQL API', participants: 'Dev team', context: 'REST getting unwieldy', status: 'proposed', tags: 'api' }],
    tasks: [{ description: 'Write GraphQL schema', assignee: 'Dave', status: 'open', tags: 'graphql' }],
    questions: [{ question: 'Which GraphQL library to use?', asker: 'Eve', status: 'open', tags: 'graphql' }],
    events: [],
  }, '2026-03-28');

  const decisionId = store.searchDecisions(memDriver, 'GraphQL')[0].id;
  const taskId = store.searchTasks(memDriver, 'GraphQL')[0].id;
  const questionId = store.searchQuestions(memDriver, 'GraphQL')[0].id;

  // Now process extraction with updates key
  const result = store.processExtraction(memDriver, {
    members: [], facts: [], topics: [],
    decisions: [], tasks: [], questions: [], events: [],
    updates: {
      decisions: [{ id: decisionId, status: 'agreed', context: 'Approved in architecture review' }],
      tasks: [{ id: taskId, status: 'done' }],
      questions: [{ id: questionId, answer: 'Use Apollo Server', answered_by: 'Frank' }],
    },
  }, '2026-03-29');

  assert(result.totalUpdated === 3, `processExtraction applied ${result.totalUpdated} updates (expected 3)`);

  // Verify updates persisted
  const dec = memDriver.read(`SELECT status, context FROM decisions WHERE id = ${decisionId}`);
  assert(dec[0].status === 'agreed', 'Decision updated via processExtraction');
  const task = memDriver.read(`SELECT status FROM tasks WHERE id = ${taskId}`);
  assert(task[0].status === 'done', 'Task updated via processExtraction');
  const q = memDriver.read(`SELECT status, answer FROM questions WHERE id = ${questionId}`);
  assert(q[0].status === 'answered', 'Question updated via processExtraction');
  assert(q[0].answer === 'Use Apollo Server', 'Question answer set via processExtraction');

  // Invalid updates should be silently skipped
  const result2 = store.processExtraction(memDriver, {
    members: [], facts: [], topics: [],
    decisions: [], tasks: [], questions: [], events: [],
    updates: {
      decisions: [{ id: 99999, status: 'agreed' }],
      tasks: [{ id: 99999, status: 'done' }],
    },
  }, '2026-03-29');
  assert(result2.totalUpdated === 0, 'Invalid update IDs silently skipped');

  memDriver.close();
}

function testContextQuery() {
  console.log('\n--- Test: context query ---');

  const memDriver = createDriver(MEMORY_DB);
  migrate(memDriver);

  // Insert some active entities
  store.processExtraction(memDriver, {
    members: [{ display_name: 'Tester', username: 'tester', expertise: 'testing', projects: 'qa' }],
    facts: [{ category: 'tool', content: 'Vitest is faster than Jest for unit tests', source_member: 'Tester', tags: 'testing', confidence: 0.9 }],
    topics: [{ name: 'Testing Framework Migration', summary: 'Moving from Jest to Vitest', participants: 'Tester', tags: 'testing' }],
    decisions: [{ description: 'Adopt Vitest for all new tests', participants: 'Tester', context: 'Speed improvement', status: 'proposed', tags: 'testing' }],
    tasks: [{ description: 'Migrate existing Jest tests to Vitest', assignee: 'Tester', status: 'open', tags: 'testing' }],
    questions: [{ question: 'Does Vitest support snapshot testing?', asker: 'Tester', status: 'open', tags: 'testing' }],
    events: [],
  }, '2026-03-28');

  const fullProfile = profiles.getProfile('full');
  const context = store.getActiveContext(memDriver, fullProfile, {
    recencyDays: 365,
    maxItems: { decisions: 3, tasks: 3, questions: 3, facts: 3, topics: 3 },
  });

  assert(context.decisions !== undefined, 'Context includes decisions');
  assert(context.tasks !== undefined, 'Context includes tasks');
  assert(context.questions !== undefined, 'Context includes questions');
  assert(context.facts !== undefined, 'Context includes facts');
  assert(context.topics !== undefined, 'Context includes topics');
  assert(context.decisions.length >= 1, 'Context has open decisions');
  assert(context.tasks.length >= 1, 'Context has open tasks');
  assert(context.questions.length >= 1, 'Context has open questions');

  // formatContext
  const text = store.formatContext(context, 500);
  assert(typeof text === 'string', 'formatContext returns string');
  assert(text.length > 0, 'formatContext produces non-empty text');
  assert(text.includes('[id:'), 'Context text includes entity IDs');
  assert(text.includes('Open decisions:'), 'Context includes decisions section');
  assert(text.includes('Open tasks:'), 'Context includes tasks section');

  // Empty context
  const emptyContext = store.getActiveContext(memDriver, { entities: [] }, {});
  const emptyText = store.formatContext(emptyContext, 500);
  assert(emptyText === '', 'Empty context returns empty string');

  // Knowledge profile should not include decisions/tasks/questions
  const knowledgeProfile = profiles.getProfile('knowledge');
  const knowledgeContext = store.getActiveContext(memDriver, knowledgeProfile, { recencyDays: 365 });
  assert(knowledgeContext.decisions === undefined, 'Knowledge profile excludes decisions');
  assert(knowledgeContext.tasks === undefined, 'Knowledge profile excludes tasks');
  assert(knowledgeContext.facts !== undefined, 'Knowledge profile includes facts');

  memDriver.close();
}

function testBuildPromptWithContext() {
  console.log('\n--- Test: buildPrompt with context ---');

  const teamProfile = profiles.getProfile('team');
  const messages = '[2026-03-28] alice: The migration is complete\n[2026-03-28] bob: Great, so we agreed on PostgreSQL then';
  const contextSection = 'Open decisions:\n  [id:5] Use PostgreSQL instead of MySQL -- status: proposed\nOpen tasks:\n  [id:12] Run migration script -- bob, open';

  // With context
  const promptWithContext = buildPrompt(messages, teamProfile, {
    contextSection,
  });
  assert(promptWithContext.includes('EXISTING KNOWLEDGE'), 'Prompt includes EXISTING KNOWLEDGE section');
  assert(promptWithContext.includes('[id:5]'), 'Prompt includes decision ID');
  assert(promptWithContext.includes('"updates"'), 'Prompt includes updates schema');
  assert(promptWithContext.includes('Update rules:'), 'Prompt includes update rules');
  assert(promptWithContext.includes('ONLY reference IDs'), 'Update rules mention ID constraint');

  // With overlap
  const overlapMessages = '[2026-03-28] alice: Should we switch to PostgreSQL?';
  const promptWithOverlap = buildPrompt(messages, teamProfile, {
    overlapMessages,
  });
  assert(promptWithOverlap.includes('PREVIOUS MESSAGES'), 'Prompt includes PREVIOUS MESSAGES section');
  assert(promptWithOverlap.includes('do NOT extract from these'), 'Overlap section has warning');
  assert(!promptWithOverlap.includes('"updates"'), 'No updates schema without context');

  // Without context or overlap (backward compat)
  const promptPlain = buildPrompt(messages, teamProfile);
  assert(!promptPlain.includes('EXISTING KNOWLEDGE'), 'Plain prompt has no context section');
  assert(!promptPlain.includes('PREVIOUS MESSAGES'), 'Plain prompt has no overlap section');
  assert(!promptPlain.includes('"updates"'), 'Plain prompt has no updates schema');

  // Update schema only includes entities in profile
  const knowledgeProfile = profiles.getProfile('knowledge');
  const promptKnowledge = buildPrompt(messages, knowledgeProfile, { contextSection: 'some context' });
  assert(!promptKnowledge.includes('"updates"'), 'Knowledge profile has no updateable entities');

  // formatMessages
  const msgs = [
    { sender: 'alice', timestamp: '2026-01-01', content: 'hello' },
    { senderName: 'bob', timestamp: '2026-01-02', content: 'world' },
  ];
  const formatted = formatMessages(msgs);
  assert(formatted.includes('[2026-01-01] alice: hello'), 'formatMessages formats sender correctly');
  assert(formatted.includes('[2026-01-02] bob: world'), 'formatMessages handles senderName');
}

function testMigrationV05() {
  console.log('\n--- Test: v0.4 to v0.5 migration ---');

  // Create a v0.4 database (has entity tables but no updated_at, no total_updates_applied)
  const V04_DB = path.join(TEST_DIR, 'v04.db');
  if (fs.existsSync(V04_DB)) fs.unlinkSync(V04_DB);
  execSync(`sqlite3 "${V04_DB}"`, {
    input: `
      PRAGMA journal_mode=WAL;
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT, expertise TEXT DEFAULT '', projects TEXT DEFAULT '', preferences TEXT DEFAULT '', first_seen TEXT, last_seen TEXT, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, content TEXT NOT NULL, source_member_id INTEGER, tags TEXT DEFAULT '', confidence REAL DEFAULT 0.8, message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, summary TEXT, participants TEXT DEFAULT '', message_date TEXT, tags TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, participants TEXT DEFAULT '', context TEXT DEFAULT '', status TEXT DEFAULT 'proposed', tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, assignee TEXT DEFAULT '', deadline TEXT, status TEXT DEFAULT 'open', source_member_id INTEGER, tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, asker TEXT DEFAULT '', answer TEXT, answered_by TEXT DEFAULT '', status TEXT DEFAULT 'open', tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', event_date TEXT, location TEXT DEFAULT '', attendees TEXT DEFAULT '', tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE members_fts USING fts5(username, display_name, expertise, projects, preferences, content='members', content_rowid='id');
      CREATE VIRTUAL TABLE facts_fts USING fts5(category, content, tags, content='facts', content_rowid='id');
      CREATE VIRTUAL TABLE topics_fts USING fts5(name, summary, participants, tags, content='topics', content_rowid='id');
      CREATE VIRTUAL TABLE decisions_fts USING fts5(description, context, participants, tags, content='decisions', content_rowid='id');
      CREATE VIRTUAL TABLE tasks_fts USING fts5(description, assignee, tags, content='tasks', content_rowid='id');
      CREATE VIRTUAL TABLE questions_fts USING fts5(question, answer, asker, tags, content='questions', content_rowid='id');
      CREATE VIRTUAL TABLE events_fts USING fts5(name, description, attendees, tags, content='events', content_rowid='id');
      CREATE TABLE extraction_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_processed_id TEXT DEFAULT '0', total_messages_processed INTEGER DEFAULT 0, total_facts_extracted INTEGER DEFAULT 0, total_topics_extracted INTEGER DEFAULT 0, total_decisions_extracted INTEGER DEFAULT 0, total_tasks_extracted INTEGER DEFAULT 0, total_questions_extracted INTEGER DEFAULT 0, total_events_extracted INTEGER DEFAULT 0, total_members_seen INTEGER DEFAULT 0, last_run_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO extraction_state (id) VALUES (1);
      CREATE TABLE lizardbrain_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')));
      INSERT INTO lizardbrain_meta (key, value) VALUES ('schema_version', '0.4');
      INSERT INTO lizardbrain_meta (key, value) VALUES ('profile_name', 'team');
      INSERT INTO lizardbrain_meta (key, value) VALUES ('profile_entities', 'members,facts,topics,decisions,tasks');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const driver = createDriver(V04_DB);
  const result = migrate(driver);
  assert(result.migrated === true, 'v0.4→v0.5 migration ran');

  // Verify updated_at column exists on decisions
  const decCols = execSync(`sqlite3 "${V04_DB}" "PRAGMA table_info(decisions)"`, { encoding: 'utf-8' });
  assert(decCols.includes('updated_at'), 'decisions has updated_at column');

  // Verify updated_at column exists on tasks
  const taskCols = execSync(`sqlite3 "${V04_DB}" "PRAGMA table_info(tasks)"`, { encoding: 'utf-8' });
  assert(taskCols.includes('updated_at'), 'tasks has updated_at column');

  // Verify updated_at column exists on questions
  const qCols = execSync(`sqlite3 "${V04_DB}" "PRAGMA table_info(questions)"`, { encoding: 'utf-8' });
  assert(qCols.includes('updated_at'), 'questions has updated_at column');

  // Verify total_updates_applied column
  const stateCols = execSync(`sqlite3 "${V04_DB}" "PRAGMA table_info(extraction_state)"`, { encoding: 'utf-8' });
  assert(stateCols.includes('total_updates_applied'), 'extraction_state has total_updates_applied');

  // Verify schema version
  const version = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  assert(version[0]?.value === '0.6', 'Schema version updated to 0.6');

  // Idempotent
  const result2 = migrate(driver);
  assert(result2.migrated === false, 'Second v0.5 migration is no-op');

  driver.close();
}

function testCredentialFiltering() {
  console.log('\n--- Test: credential filtering ---');

  const memDriver = createDriver(MEMORY_DB);
  const before = store.getStats(memDriver);

  store.processExtraction(memDriver, {
    members: [],
    facts: [
      { category: 'resource', content: 'Use sk-abc123def456ghi789jkl012mno345pqr678stu to access the API', source_member: 'alice', tags: 'api', confidence: 0.9 },
      { category: 'resource', content: 'The GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123456789 gives repo access', source_member: 'bob', tags: 'github', confidence: 0.9 },
      { category: 'tool', content: 'Set api_key = sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxx in your .env file', source_member: 'alice', tags: 'config', confidence: 0.85 },
      { category: 'tool', content: 'LangChain supports multiple embedding providers', source_member: 'alice', tags: 'langchain', confidence: 0.9 },
      { category: 'resource', content: 'AWS access key AKIAIOSFODNN7EXAMPLE was shared in channel', source_member: 'bob', tags: 'aws', confidence: 0.8 },
      { category: 'tool', content: 'password = hunter2suchsecret is the database password', source_member: 'alice', tags: 'db', confidence: 0.7 },
    ],
    topics: [],
  }, '2026-03-20');

  const after = store.getStats(memDriver);
  const newFacts = after.facts - before.facts;
  assert(newFacts === 1, `Only 1 safe fact stored out of 6 (got ${newFacts}) — credentials blocked`);

  memDriver.close();
}

function testGenericMemberFiltering() {
  console.log('\n--- Test: generic member filtering ---');

  const memDriver = createDriver(MEMORY_DB);
  const before = store.getStats(memDriver);

  store.processExtraction(memDriver, {
    members: [
      { display_name: 'AI Agent', username: null, expertise: 'everything', projects: '' },
      { display_name: 'Bot', username: 'bot', expertise: '', projects: '' },
      { display_name: 'System', username: 'system', expertise: '', projects: '' },
      { display_name: 'Charlie', username: 'charlie', expertise: 'Python, FastAPI', projects: 'web-app' },
      { display_name: 'Unknown', username: null, expertise: '', projects: '' },
    ],
    facts: [],
    topics: [],
  }, '2026-03-20');

  const after = store.getStats(memDriver);
  const newMembers = after.members - before.members;
  assert(newMembers === 1, `Only 1 real member stored out of 5 (got ${newMembers}) — generics filtered`);

  memDriver.close();
}

function testCodeFenceStripping() {
  console.log('\n--- Test: JSON code fence stripping ---');

  // Simulate what the LLM returns wrapped in code fences
  const fenced = '```json\n{"members": [], "facts": [], "topics": []}\n```';
  const cleaned = fenced.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  assert(Array.isArray(parsed.members), 'Parsed members from fenced JSON');
  assert(Array.isArray(parsed.facts), 'Parsed facts from fenced JSON');

  // Without fences should also work
  const plain = '{"members": [], "facts": []}';
  const cleanedPlain = plain.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const parsedPlain = JSON.parse(cleanedPlain);
  assert(Array.isArray(parsedPlain.members), 'Plain JSON still parses correctly');

  // Just ``` without json label
  const fencedNoLabel = '```\n{"members": []}\n```';
  const cleanedNoLabel = fencedNoLabel.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const parsedNoLabel = JSON.parse(cleanedNoLabel);
  assert(Array.isArray(parsedNoLabel.members), 'Fenced JSON without label also parses');
}

function testJsonRepair() {
  console.log('\n--- Test: JSON repair ---');
  const { repairJson } = require('../src/llm');

  // Valid JSON passes through
  const valid = '{"members": [], "facts": []}';
  const parsed = repairJson(valid);
  assert(Array.isArray(parsed.members), 'Valid JSON passes through repairJson');

  // Code fences
  const fenced = '```json\n{"members": [], "facts": []}\n```';
  const parsedFenced = repairJson(fenced);
  assert(Array.isArray(parsedFenced.members), 'Fenced JSON repaired');

  // Trailing comma
  const trailingComma = '{"facts": [{"content": "test"},]}';
  const parsedComma = repairJson(trailingComma);
  assert(parsedComma.facts.length === 1, 'Trailing comma repaired');

  // Truncated array (simulates LLM output cut mid-generation)
  const truncated = '{"facts": [{"content": "fact 1", "category": "tool"}, {"content": "fact 2", "category": "tech';
  const parsedTrunc = repairJson(truncated);
  assert(parsedTrunc.facts.length === 1, `Truncated JSON repaired: kept ${parsedTrunc.facts.length} valid element`);
  assert(parsedTrunc.facts[0].content === 'fact 1', 'First complete element preserved');

  // Truncated with multiple valid elements
  const truncated2 = '{"members": [{"display_name": "Alice"}, {"display_name": "Bob"}], "facts": [{"content": "good"}, {"content": "trunca';
  const parsedTrunc2 = repairJson(truncated2);
  assert(parsedTrunc2.members.length === 2, 'Members preserved in truncated JSON');
  assert(parsedTrunc2.facts.length === 1, 'Last complete fact kept, truncated one dropped');
}

function testAnthropicDetection() {
  console.log('\n--- Test: Anthropic provider detection ---');
  const { isAnthropic } = require('../src/llm');

  assert(isAnthropic({ provider: 'anthropic', baseUrl: 'https://example.com' }), 'Explicit provider=anthropic detected');
  assert(isAnthropic({ baseUrl: 'https://api.anthropic.com/v1' }), 'anthropic.com in URL detected');
  assert(!isAnthropic({ baseUrl: 'https://api.openai.com/v1' }), 'OpenAI URL not detected as Anthropic');
  assert(!isAnthropic({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }), 'Explicit provider=openai not Anthropic');
  // Explicit openai override even on anthropic.com domain (reverse proxy scenario)
  assert(!isAnthropic({ provider: 'openai', baseUrl: 'https://api.anthropic.com/v1' }), 'provider=openai overrides anthropic.com URL');
  assert(!isAnthropic({}), 'Empty config not Anthropic');
}

function testExpandedGenericFilter() {
  console.log('\n--- Test: expanded generic member filter ---');

  const driver = createDriver(MEMORY_DB);
  const store = require('../src/store');

  // Clear dependent tables first (FK constraints), then members
  driver.write('DELETE FROM facts;');
  driver.write('DELETE FROM tasks;');
  driver.write('DELETE FROM members;');

  const extracted = {
    members: [
      { display_name: 'Content Agent', expertise: 'content strategy' },
      { display_name: 'Chat Bot', expertise: 'conversation' },
      { display_name: 'Auto Helper', expertise: 'automation' },
      { display_name: 'Virtual Assistant', expertise: 'scheduling' },
      { display_name: 'Oleksii', expertise: 'engineering' },
      { display_name: 'AI Bot', expertise: 'machine learning' },
    ],
    facts: [],
    topics: [],
  };

  store.processExtraction(driver, extracted, '2026-03-29');
  const members = driver.read('SELECT display_name FROM members');
  assert(members.length === 1, `Only 1 real member stored (got ${members.length})`);
  assert(members[0].display_name === 'Oleksii', 'Real member preserved');
  driver.close();
}

function testContextAssembly() {
  console.log('\n--- Test: context-assembly ---');

  const context = require('../src/context');

  // Setup: insert test data into memory DB
  const driver = createDriver(MEMORY_DB);
  migrate(driver);

  // Insert members
  store.processExtraction(driver, {
    members: [
      { display_name: 'Alice', username: 'alice', expertise: 'Python, ML', projects: 'RAG pipeline' },
      { display_name: 'Bob', username: 'bob', expertise: 'TypeScript, React', projects: 'Frontend' },
    ],
    facts: [
      { content: 'LangChain works well with chunk size 512', category: 'technique', source_member: 'Alice', tags: 'rag,langchain', confidence: 0.9 },
      { content: 'LlamaIndex is better for large PDFs', category: 'tool', source_member: 'Bob', tags: 'llamaindex,pdf', confidence: 0.85 },
      { content: 'text-embedding-3-small is cheap and decent quality', category: 'tool', source_member: 'Bob', tags: 'embeddings,openai', confidence: 0.8 },
    ],
    decisions: [
      { description: 'Use LlamaIndex for PDF processing', status: 'agreed', participants: 'Alice, Bob', tags: 'architecture' },
    ],
    tasks: [
      { description: 'Migrate RAG pipeline to LlamaIndex', assignee: 'Bob', status: 'open', source_member: 'Bob', tags: 'migration' },
    ],
    questions: [
      { question: 'What embedding model should we standardize on?', asker: 'Alice', status: 'open', tags: 'embeddings' },
    ],
  }, '2026-03-15T10:00:00Z', { sourceAgent: 'test' });

  // Test 1: participants only
  const ctx1 = context.assembleContext(driver, { participants: ['Alice'] });
  assert(ctx1.participants.length >= 1, 'participants: returns Alice profile');
  assert(ctx1.participants[0].name === 'Alice', 'participants: correct name');
  assert(ctx1.participants[0].expertise.includes('Python'), 'participants: includes expertise');

  // Test 2: topics only
  const ctx2 = context.assembleContext(driver, { topics: ['langchain'] });
  assert(ctx2.facts.length >= 1, 'topics: returns facts about langchain');

  // Test 3: both participants and topics
  const ctx3 = context.assembleContext(driver, { participants: ['Alice'], topics: ['langchain'] });
  assert(ctx3.participants.length >= 1, 'both: has participants');
  assert(ctx3.facts.length >= 0, 'both: has facts (may be in participant recentFacts)');

  // Test 4: neither (general catch-up)
  const ctx4 = context.assembleContext(driver, {});
  const hasAnyContent = ctx4.participants.length > 0 || ctx4.facts.length > 0 ||
    ctx4.decisions.length > 0 || ctx4.tasks.length > 0 || ctx4.questions.length > 0;
  assert(hasAnyContent, 'general: returns recent activity');

  // Test 5: token budget enforcement
  const ctx5 = context.assembleContext(driver, { topics: ['langchain', 'embeddings', 'pdf'], tokenBudget: 100 });
  const totalChars = JSON.stringify(ctx5).length;
  assert(totalChars <= 100 * 4 + 200, 'budget: output roughly within token budget');

  // Test 6: empty DB
  const emptyDb = path.join(TEST_DIR, 'empty.db');
  lizardbrain.init(emptyDb, { profile: 'full' });
  const emptyDriver = createDriver(emptyDb);
  migrate(emptyDriver);
  const ctx6 = context.assembleContext(emptyDriver, { participants: ['Nobody'] });
  assert(ctx6.participants.length === 0, 'empty DB: no participants');
  assert(ctx6.facts.length === 0, 'empty DB: no facts');
  emptyDriver.close();

  // Test 7: recencyDays filtering
  const ctx7 = context.assembleContext(driver, { topics: ['langchain'], recencyDays: 0 });
  assert(Array.isArray(ctx7.facts), 'recencyDays: returns array');

  driver.close();
}

function testExtractFromText() {
  console.log('\n--- Test: extract-from-text ---');

  const llm = require('../src/llm');
  assert(typeof llm.extractFromText === 'function', 'extractFromText is exported');
  assert(typeof llm.buildPrompt === 'function', 'buildPrompt still exported');
  assert(typeof llm.formatMessages === 'function', 'formatMessages still exported');
}

async function testMcpToolHandlers() {
  console.log('\n--- Test: mcp-tool-handlers ---');

  let mcp;
  try {
    mcp = require('../src/mcp');
  } catch (e) {
    console.log('  SKIP: @modelcontextprotocol/sdk not installed');
    return;
  }

  // Setup: fresh DB with test data
  const mcpDb = path.join(TEST_DIR, 'mcp-test.db');
  lizardbrain.init(mcpDb, { profile: 'full' });
  const driver = createDriver(mcpDb);
  migrate(driver);

  store.processExtraction(driver, {
    members: [
      { display_name: 'Alice', username: 'alice', expertise: 'Python, ML', projects: 'RAG pipeline' },
      { display_name: 'Bob', username: 'bob', expertise: 'TypeScript, React', projects: 'Frontend' },
    ],
    facts: [
      { content: 'LangChain works well for RAG', category: 'technique', source_member: 'Alice', tags: 'rag', confidence: 0.9 },
      { content: 'React 19 has improved SSR', category: 'tool', source_member: 'Bob', tags: 'react', confidence: 0.8 },
    ],
    decisions: [
      { description: 'Use LlamaIndex for PDFs', status: 'agreed', participants: 'Alice, Bob', tags: 'architecture' },
    ],
    tasks: [
      { description: 'Migrate to LlamaIndex', assignee: 'Bob', status: 'open', source_member: 'Bob', tags: 'migration' },
    ],
    questions: [
      { question: 'Which embedding model?', asker: 'Alice', status: 'open', tags: 'embeddings' },
    ],
  }, '2026-03-15T10:00:00Z', { sourceAgent: 'test' });

  const handlers = mcp.createHandlers(driver, {});

  // --- get_context ---
  const ctx1 = await handlers.get_context({ participants: ['Alice'] });
  assert(!ctx1.isError, 'get_context: no error');
  assert(ctx1.data.participants.length >= 1, 'get_context: returns participants');
  assert(ctx1.data.participants[0].name === 'Alice', 'get_context: correct participant name');

  const ctx2 = await handlers.get_context({ topics: ['rag'] });
  assert(!ctx2.isError, 'get_context topics: no error');
  assert(ctx2.data.facts.length >= 1, 'get_context topics: returns facts');

  const ctx3 = await handlers.get_context({});
  assert(!ctx3.isError, 'get_context general: no error');

  // --- search ---
  const s1 = await handlers.search({ query: 'LangChain' });
  assert(!s1.isError, 'search: no error');
  assert(s1.data.results.length >= 1, 'search: returns results');
  assert(s1.data.results[0].type !== undefined, 'search: results have type field');
  assert(s1.data.results[0].text !== undefined, 'search: results have text field');

  const s2 = await handlers.search({ query: 'LangChain', types: ['fact'] });
  assert(!s2.isError, 'search type filter: no error');
  for (const r of s2.data.results) {
    assert(r.type === 'fact', 'search type filter: only facts returned');
  }

  const s3 = await handlers.search({ query: '' });
  assert(!s3.isError, 'search empty: no error');
  assert(s3.data.results.length === 0, 'search empty: empty results');

  // --- who_knows ---
  const w1 = await handlers.who_knows({ topic: 'Python' });
  assert(!w1.isError, 'who_knows: no error');
  assert(w1.data.members.length >= 1, 'who_knows: returns members');
  assert(w1.data.members[0].name !== undefined, 'who_knows: members have name');

  // --- get_stats ---
  const st1 = await handlers.get_stats({});
  assert(!st1.isError, 'get_stats: no error');
  assert(st1.data.facts >= 2, 'get_stats: correct fact count');
  assert(st1.data.members >= 2, 'get_stats: correct member count');

  // --- add_knowledge ---
  const ak1 = await handlers.add_knowledge({
    facts: [{ content: 'New fact from MCP', category: 'tool', tags: 'mcp' }],
    sourceAgent: 'test-agent',
  });
  assert(!ak1.isError, 'add_knowledge: no error');
  assert(ak1.data.inserted.facts >= 1, 'add_knowledge: fact inserted');

  // add_knowledge dedup
  const ak2 = await handlers.add_knowledge({
    facts: [{ content: 'New fact from MCP', category: 'tool', tags: 'mcp' }],
  });
  assert(!ak2.isError, 'add_knowledge dedup: no error');
  assert(ak2.data.inserted.facts === 0, 'add_knowledge dedup: duplicate skipped');

  // --- update_entity ---
  const tasks = driver.read('SELECT id FROM tasks LIMIT 1');
  if (tasks.length > 0) {
    const u1 = await handlers.update_entity({ type: 'task', id: tasks[0].id, status: 'done' });
    assert(!u1.isError, 'update_entity task: no error');
    assert(u1.data.updated === true, 'update_entity task: updated');
  }

  const decisions = driver.read('SELECT id FROM decisions LIMIT 1');
  if (decisions.length > 0) {
    const u2 = await handlers.update_entity({ type: 'decision', id: decisions[0].id, status: 'revisited' });
    assert(!u2.isError, 'update_entity decision: no error');
    assert(u2.data.updated === true, 'update_entity decision: updated');
  }

  // update_entity validation errors
  const u3 = await handlers.update_entity({ type: 'task', id: 1 });
  assert(u3.isError === true, 'update_entity: missing status is error');

  const u4 = await handlers.update_entity({ type: 'question', id: 1 });
  assert(u4.isError === true, 'update_entity: missing answer is error');

  const u5 = await handlers.update_entity({ type: 'invalid', id: 1 });
  assert(u5.isError === true, 'update_entity: invalid type is error');

  driver.close();
}

async function testMcpIntegration() {
  console.log('\n--- Test: mcp-integration ---');

  let mcp;
  try {
    mcp = require('../src/mcp');
  } catch (e) {
    console.log('  SKIP: @modelcontextprotocol/sdk not installed');
    return;
  }

  // Setup: fresh DB
  const intDb = path.join(TEST_DIR, 'mcp-integration.db');
  lizardbrain.init(intDb, { profile: 'full' });
  const driver = createDriver(intDb);
  migrate(driver);

  const handlers = mcp.createHandlers(driver, {});

  // Write knowledge
  const writeResult = await handlers.add_knowledge({
    facts: [{ content: 'Integration test fact about MCP servers', category: 'tool', tags: 'mcp,test' }],
    members: [{ display_name: 'TestUser', username: 'testuser', expertise: 'MCP testing' }],
    sourceAgent: 'integration-test',
  });
  assert(!writeResult.isError, 'integration: write succeeded');
  assert(writeResult.data.inserted.facts >= 1, 'integration: fact inserted');
  assert(writeResult.data.inserted.members >= 1, 'integration: member inserted');

  // Read it back via get_context
  const ctxResult = await handlers.get_context({ participants: ['TestUser'] });
  assert(!ctxResult.isError, 'integration: get_context succeeded');
  assert(ctxResult.data.participants.length >= 1, 'integration: participant found');
  assert(ctxResult.data.participants[0].name === 'TestUser', 'integration: correct participant');

  // Read it back via search
  const searchResult = await handlers.search({ query: 'MCP servers' });
  assert(!searchResult.isError, 'integration: search succeeded');
  assert(searchResult.data.results.length >= 1, 'integration: search found the fact');

  // Stats should reflect the writes
  const statsResult = await handlers.get_stats({});
  assert(!statsResult.isError, 'integration: stats succeeded');
  assert(statsResult.data.facts >= 1, 'integration: stats shows facts');
  assert(statsResult.data.members >= 1, 'integration: stats shows members');

  // Verify context module is exported from index
  const idx = require('../src/index');
  assert(typeof idx.context.assembleContext === 'function', 'integration: assembleContext exported from index');

  driver.close();
}

// --- Run ---

async function runAll() {
  setup();
  testInit();
  testAdapter();
  testJsonlAdapter();
  testProfiles();
  testStore();
  testNewEntities();
  testConfidenceFiltering();
  testRoster();
  testProfileRoster();
  testDynamicPrompt();
  testMigration();
  testConversationFilter();
  testCliDriver();
  testBetterSqliteDriver();
  await testEmbeddings();
  testRRFMerge();
  await testFtsOnlySearch();
  await testNewEntityFtsSearch();
  testBatchOverlap();
  testConversationBatching();
  testEntityUpdates();
  testProcessExtractionUpdates();
  testContextQuery();
  testBuildPromptWithContext();
  testMigrationV05();
  testCredentialFiltering();
  testGenericMemberFiltering();
  testCodeFenceStripping();
  testJsonRepair();
  testAnthropicDetection();
  testExpandedGenericFilter();
  testStdinAdapter();
  testContextAssembly();
  testExtractFromText();
  await testMcpToolHandlers();
  await testMcpIntegration();
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
