/**
 * schema.js — Creates and manages the clawmem SQLite schema.
 */

const { createDriver } = require('./driver');

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

-- Extraction state (singleton row)
CREATE TABLE IF NOT EXISTS extraction_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_processed_id TEXT DEFAULT '0',
  total_messages_processed INTEGER DEFAULT 0,
  total_facts_extracted INTEGER DEFAULT 0,
  total_topics_extracted INTEGER DEFAULT 0,
  total_members_seen INTEGER DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO extraction_state (id) VALUES (1);

-- Metadata key-value store
CREATE TABLE IF NOT EXISTS clawmem_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
`;

function init(dbPath, { force = false } = {}) {
  const fs = require('fs');

  if (force && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  if (fs.existsSync(dbPath) && !force) {
    return { created: false, message: `Database already exists at ${dbPath}` };
  }

  const driver = createDriver(dbPath);
  driver.write(SCHEMA_SQL);
  driver.close();

  return { created: true, message: `Database created at ${dbPath}` };
}

module.exports = { init, SCHEMA_SQL };
