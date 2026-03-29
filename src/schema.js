/**
 * schema.js — Creates and manages the lizardbrain SQLite schema.
 */

const { createDriver } = require('./driver');

// Single source of truth for performance indexes (used in SCHEMA_SQL and migrate())
const PERFORMANCE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_members_display_name ON members(display_name)',
  'CREATE INDEX IF NOT EXISTS idx_facts_source_member ON facts(source_member_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_source_member ON tasks(source_member_id)',
  'CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_topics_created_at ON topics(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_members_last_seen ON members(last_seen)',
];

function applyIndexes(driver) {
  for (const stmt of PERFORMANCE_INDEXES) {
    driver.write(stmt + ';');
  }
}

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;

-- Members: people in the chat
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  display_name TEXT,
  expertise TEXT DEFAULT '',
  projects TEXT DEFAULT '',
  preferences TEXT DEFAULT '',
  first_seen TEXT,
  last_seen TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Facts: extracted knowledge claims
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source_member_id INTEGER REFERENCES members(id),
  tags TEXT DEFAULT '',
  confidence REAL DEFAULT 0.8,
  message_date TEXT,
  source_agent TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Topics: discussion threads
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  summary TEXT,
  participants TEXT DEFAULT '',
  message_date TEXT,
  tags TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- FTS5 indexes
CREATE VIRTUAL TABLE IF NOT EXISTS members_fts USING fts5(
  username, display_name, expertise, projects, preferences,
  content='members', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  category, content, tags,
  content='facts', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(
  name, summary, participants, tags,
  content='topics', content_rowid='id'
);

-- FTS sync triggers: members
CREATE TRIGGER IF NOT EXISTS members_ai AFTER INSERT ON members BEGIN
  INSERT INTO members_fts(rowid, username, display_name, expertise, projects, preferences)
  VALUES (new.id, new.username, new.display_name, new.expertise, new.projects, new.preferences);
END;
CREATE TRIGGER IF NOT EXISTS members_ad AFTER DELETE ON members BEGIN
  INSERT INTO members_fts(members_fts, rowid, username, display_name, expertise, projects, preferences)
  VALUES ('delete', old.id, old.username, old.display_name, old.expertise, old.projects, old.preferences);
END;
CREATE TRIGGER IF NOT EXISTS members_au AFTER UPDATE ON members BEGIN
  INSERT INTO members_fts(members_fts, rowid, username, display_name, expertise, projects, preferences)
  VALUES ('delete', old.id, old.username, old.display_name, old.expertise, old.projects, old.preferences);
  INSERT INTO members_fts(rowid, username, display_name, expertise, projects, preferences)
  VALUES (new.id, new.username, new.display_name, new.expertise, new.projects, new.preferences);
END;

-- FTS sync triggers: facts
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, category, content, tags)
  VALUES (new.id, new.category, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, category, content, tags)
  VALUES ('delete', old.id, old.category, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, category, content, tags)
  VALUES ('delete', old.id, old.category, old.content, old.tags);
  INSERT INTO facts_fts(rowid, category, content, tags)
  VALUES (new.id, new.category, new.content, new.tags);
END;

-- FTS sync triggers: topics
CREATE TRIGGER IF NOT EXISTS topics_ai AFTER INSERT ON topics BEGIN
  INSERT INTO topics_fts(rowid, name, summary, participants, tags)
  VALUES (new.id, new.name, new.summary, new.participants, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS topics_ad AFTER DELETE ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, name, summary, participants, tags)
  VALUES ('delete', old.id, old.name, old.summary, old.participants, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS topics_au AFTER UPDATE ON topics BEGIN
  INSERT INTO topics_fts(topics_fts, rowid, name, summary, participants, tags)
  VALUES ('delete', old.id, old.name, old.summary, old.participants, old.tags);
  INSERT INTO topics_fts(rowid, name, summary, participants, tags)
  VALUES (new.id, new.name, new.summary, new.participants, new.tags);
END;

-- Decisions: group decisions and agreements
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  participants TEXT DEFAULT '',
  context TEXT DEFAULT '',
  status TEXT DEFAULT 'proposed',
  tags TEXT DEFAULT '',
  message_date TEXT,
  source_agent TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- Tasks: action items and assignments
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  assignee TEXT DEFAULT '',
  deadline TEXT,
  status TEXT DEFAULT 'open',
  source_member_id INTEGER REFERENCES members(id),
  tags TEXT DEFAULT '',
  message_date TEXT,
  source_agent TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- Questions: asked and answered
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  asker TEXT DEFAULT '',
  answer TEXT,
  answered_by TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  tags TEXT DEFAULT '',
  message_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- Events: meetings, deadlines, gatherings
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  event_date TEXT,
  location TEXT DEFAULT '',
  attendees TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  message_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- FTS5 indexes: decisions, tasks, questions, events
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  description, context, participants, tags,
  content='decisions', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  description, assignee, tags,
  content='tasks', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
  question, answer, asker, tags,
  content='questions', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  name, description, attendees, tags,
  content='events', content_rowid='id'
);

-- FTS sync triggers: decisions
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, description, context, participants, tags)
  VALUES (new.id, new.description, new.context, new.participants, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, description, context, participants, tags)
  VALUES ('delete', old.id, old.description, old.context, old.participants, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, description, context, participants, tags)
  VALUES ('delete', old.id, old.description, old.context, old.participants, old.tags);
  INSERT INTO decisions_fts(rowid, description, context, participants, tags)
  VALUES (new.id, new.description, new.context, new.participants, new.tags);
END;

-- FTS sync triggers: tasks
CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, description, assignee, tags)
  VALUES (new.id, new.description, new.assignee, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, description, assignee, tags)
  VALUES ('delete', old.id, old.description, old.assignee, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, description, assignee, tags)
  VALUES ('delete', old.id, old.description, old.assignee, old.tags);
  INSERT INTO tasks_fts(rowid, description, assignee, tags)
  VALUES (new.id, new.description, new.assignee, new.tags);
END;

-- FTS sync triggers: questions
CREATE TRIGGER IF NOT EXISTS questions_ai AFTER INSERT ON questions BEGIN
  INSERT INTO questions_fts(rowid, question, answer, asker, tags)
  VALUES (new.id, new.question, new.answer, new.asker, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS questions_ad AFTER DELETE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, question, answer, asker, tags)
  VALUES ('delete', old.id, old.question, old.answer, old.asker, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS questions_au AFTER UPDATE ON questions BEGIN
  INSERT INTO questions_fts(questions_fts, rowid, question, answer, asker, tags)
  VALUES ('delete', old.id, old.question, old.answer, old.asker, old.tags);
  INSERT INTO questions_fts(rowid, question, answer, asker, tags)
  VALUES (new.id, new.question, new.answer, new.asker, new.tags);
END;

-- FTS sync triggers: events
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, name, description, attendees, tags)
  VALUES (new.id, new.name, new.description, new.attendees, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, name, description, attendees, tags)
  VALUES ('delete', old.id, old.name, old.description, old.attendees, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, name, description, attendees, tags)
  VALUES ('delete', old.id, old.name, old.description, old.attendees, old.tags);
  INSERT INTO events_fts(rowid, name, description, attendees, tags)
  VALUES (new.id, new.name, new.description, new.attendees, new.tags);
END;

-- Extraction state (singleton row)
CREATE TABLE IF NOT EXISTS extraction_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_processed_id TEXT DEFAULT '0',
  total_messages_processed INTEGER DEFAULT 0,
  total_facts_extracted INTEGER DEFAULT 0,
  total_topics_extracted INTEGER DEFAULT 0,
  total_decisions_extracted INTEGER DEFAULT 0,
  total_tasks_extracted INTEGER DEFAULT 0,
  total_questions_extracted INTEGER DEFAULT 0,
  total_events_extracted INTEGER DEFAULT 0,
  total_updates_applied INTEGER DEFAULT 0,
  total_members_seen INTEGER DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO extraction_state (id) VALUES (1);

-- Metadata key-value store
CREATE TABLE IF NOT EXISTS lizardbrain_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Embedding metadata (model_id tracking, separate from vec0 tables)
CREATE TABLE IF NOT EXISTS embedding_metadata (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  embedded_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type, entity_id)
);

-- Performance indexes
${PERFORMANCE_INDEXES.map(s => s + ';').join('\n')}
`;

function init(dbPath, { force = false, profile = 'knowledge' } = {}) {
  const fs = require('fs');
  const { getProfile } = require('./profiles');

  if (force && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  if (fs.existsSync(dbPath) && !force) {
    return { created: false, message: `Database already exists at ${dbPath}` };
  }

  const profileConfig = getProfile(profile);
  const driver = createDriver(dbPath);
  driver.write(SCHEMA_SQL);

  // Store profile and schema version in meta
  const { esc } = require('./driver');
  driver.write(`INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('profile_name', '${esc(profile)}', datetime('now'));`);
  driver.write(`INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('profile_entities', '${esc(profileConfig.entities.join(','))}', datetime('now'));`);
  driver.write(`INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.6', datetime('now'));`);

  driver.close();

  return { created: true, message: `Database created at ${dbPath} (profile: ${profile})` };
}

/**
 * Migrate a v0.3 database to v0.4 schema.
 * Idempotent — safe to call on already-migrated databases.
 */
function migrate(driver) {
  const { esc } = require('./driver');

  // Check current schema version
  const meta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  const version = meta[0]?.value;
  if (version >= '0.6') {
    applyIndexes(driver); // Ensure performance indexes exist (idempotent)
    return { migrated: false, message: 'Already at v0.6' };
  }

  // Create new tables (IF NOT EXISTS makes this idempotent)
  const newTables = `
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, participants TEXT DEFAULT '',
      context TEXT DEFAULT '', status TEXT DEFAULT 'proposed', tags TEXT DEFAULT '',
      message_date TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, assignee TEXT DEFAULT '',
      deadline TEXT, status TEXT DEFAULT 'open', source_member_id INTEGER REFERENCES members(id),
      tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, asker TEXT DEFAULT '',
      answer TEXT, answered_by TEXT DEFAULT '', status TEXT DEFAULT 'open',
      tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '',
      event_date TEXT, location TEXT DEFAULT '', attendees TEXT DEFAULT '',
      tags TEXT DEFAULT '', message_date TEXT, created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
      description, context, participants, tags, content='decisions', content_rowid='id');
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      description, assignee, tags, content='tasks', content_rowid='id');
    CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
      question, answer, asker, tags, content='questions', content_rowid='id');
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      name, description, attendees, tags, content='events', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
      INSERT INTO decisions_fts(rowid, description, context, participants, tags)
      VALUES (new.id, new.description, new.context, new.participants, new.tags); END;
    CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, description, context, participants, tags)
      VALUES ('delete', old.id, old.description, old.context, old.participants, old.tags); END;
    CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
      INSERT INTO decisions_fts(decisions_fts, rowid, description, context, participants, tags)
      VALUES ('delete', old.id, old.description, old.context, old.participants, old.tags);
      INSERT INTO decisions_fts(rowid, description, context, participants, tags)
      VALUES (new.id, new.description, new.context, new.participants, new.tags); END;

    CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(rowid, description, assignee, tags)
      VALUES (new.id, new.description, new.assignee, new.tags); END;
    CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, description, assignee, tags)
      VALUES ('delete', old.id, old.description, old.assignee, old.tags); END;
    CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
      INSERT INTO tasks_fts(tasks_fts, rowid, description, assignee, tags)
      VALUES ('delete', old.id, old.description, old.assignee, old.tags);
      INSERT INTO tasks_fts(rowid, description, assignee, tags)
      VALUES (new.id, new.description, new.assignee, new.tags); END;

    CREATE TRIGGER IF NOT EXISTS questions_ai AFTER INSERT ON questions BEGIN
      INSERT INTO questions_fts(rowid, question, answer, asker, tags)
      VALUES (new.id, new.question, new.answer, new.asker, new.tags); END;
    CREATE TRIGGER IF NOT EXISTS questions_ad AFTER DELETE ON questions BEGIN
      INSERT INTO questions_fts(questions_fts, rowid, question, answer, asker, tags)
      VALUES ('delete', old.id, old.question, old.answer, old.asker, old.tags); END;
    CREATE TRIGGER IF NOT EXISTS questions_au AFTER UPDATE ON questions BEGIN
      INSERT INTO questions_fts(questions_fts, rowid, question, answer, asker, tags)
      VALUES ('delete', old.id, old.question, old.answer, old.asker, old.tags);
      INSERT INTO questions_fts(rowid, question, answer, asker, tags)
      VALUES (new.id, new.question, new.answer, new.asker, new.tags); END;

    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, name, description, attendees, tags)
      VALUES (new.id, new.name, new.description, new.attendees, new.tags); END;
    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, name, description, attendees, tags)
      VALUES ('delete', old.id, old.name, old.description, old.attendees, old.tags); END;
    CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, name, description, attendees, tags)
      VALUES ('delete', old.id, old.name, old.description, old.attendees, old.tags);
      INSERT INTO events_fts(rowid, name, description, attendees, tags)
      VALUES (new.id, new.name, new.description, new.attendees, new.tags); END;
  `;
  driver.write(newTables);

  // Add new columns to extraction_state (try-catch for "duplicate column" on CLI driver)
  const newCols = ['total_decisions_extracted', 'total_tasks_extracted', 'total_questions_extracted', 'total_events_extracted'];
  for (const col of newCols) {
    try {
      driver.write(`ALTER TABLE extraction_state ADD COLUMN ${col} INTEGER DEFAULT 0;`);
    } catch (e) {
      // Column already exists — ignore
    }
  }

  // Set default profile if not already set
  const profileMeta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'");
  if (!profileMeta.length) {
    driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('profile_name', 'knowledge', datetime('now'));");
    driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('profile_entities', 'members,facts,topics', datetime('now'));");
  }

  // Set schema version to v0.4
  driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.4', datetime('now'));");

  // v0.5 migration: add updated_at to updateable tables, add updates counter
  for (const table of ['decisions', 'tasks', 'questions']) {
    try { driver.write(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT;`); }
    catch (e) { /* column already exists */ }
  }
  try { driver.write('ALTER TABLE extraction_state ADD COLUMN total_updates_applied INTEGER DEFAULT 0;'); }
  catch (e) { /* column already exists */ }

  driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.5', datetime('now'));");

  // v0.6 migration: source_agent on facts/decisions/tasks, embedding_metadata table
  for (const table of ['facts', 'decisions', 'tasks']) {
    try { driver.write(`ALTER TABLE ${table} ADD COLUMN source_agent TEXT DEFAULT NULL;`); }
    catch (e) { /* column already exists */ }
  }

  // embedding_metadata table for model_id tracking (vec0 doesn't support extra columns)
  driver.write(`
    CREATE TABLE IF NOT EXISTS embedding_metadata (
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      embedded_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (entity_type, entity_id)
    );
  `);

  driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.6', datetime('now'));");

  applyIndexes(driver); // Performance indexes (idempotent)

  return { migrated: true, message: 'Migrated to v0.6 schema' };
}

module.exports = { init, migrate, SCHEMA_SQL };
