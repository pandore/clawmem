/**
 * driver.js — Database driver abstraction for clawmem.
 * Tries better-sqlite3 at startup, falls back to sqlite3 CLI.
 */

const { execSync } = require('child_process');
const fs = require('fs');

// --- Detect available backends at import time ---

let BetterSqlite3 = null;
let sqliteVec = null;

try {
  BetterSqlite3 = require('better-sqlite3');
} catch (_) {
  // not installed
}

try {
  sqliteVec = require('sqlite-vec');
} catch (_) {
  // not installed
}

// --- SQL string escaping ---

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/'/g, "''");
}

// --- CliDriver ---

class CliDriver {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.backend = 'cli';
    this.capabilities = {
      inProcess: false,
      vectors: false,
      transactions: false,
    };
  }

  read(sql) {
    try {
      const result = execSync(
        `sqlite3 -json "${this.dbPath}" "${sql.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );
      return result.trim() ? JSON.parse(result.trim()) : [];
    } catch (err) {
      if (err.message.includes('unknown option')) {
        return this._readFallback(sql);
      }
      const msg = err.stderr?.toString() || err.message;
      if (msg.includes('no such table') || msg.includes('no such column')) return [];
      console.error(`[clawmem:driver:cli] read error: ${msg}`);
      return [];
    }
  }

  _readFallback(sql) {
    try {
      const result = execSync(
        `sqlite3 -header -separator '|||' "${this.dbPath}" "${sql.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );
      const lines = result.trim().split('\n').filter(Boolean);
      if (lines.length < 2) return [];
      const headers = lines[0].split('|||');
      return lines.slice(1).map(line => {
        const vals = line.split('|||');
        const obj = {};
        headers.forEach((h, i) => obj[h] = vals[i] || '');
        return obj;
      });
    } catch (err) {
      console.error(`[clawmem:driver:cli] readFallback error: ${err.stderr?.toString() || err.message}`);
      return [];
    }
  }

  write(sql) {
    try {
      execSync(`sqlite3 "${this.dbPath}"`, {
        input: sql,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { changes: -1 };
    } catch (err) {
      console.error(`[clawmem:driver:cli] write error: ${err.stderr?.toString() || err.message}`);
      return { changes: 0 };
    }
  }

  run(sql) {
    return this.write(sql);
  }

  transaction(fn) {
    return fn();
  }

  close() {
    // noop — no persistent connection
  }
}

// --- BetterSqliteDriver ---

class BetterSqliteDriver {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.backend = 'better-sqlite3';

    const db = BetterSqlite3(dbPath);

    // Enable WAL mode
    db.pragma('journal_mode = WAL');

    // Try to load sqlite-vec extension
    let hasVectors = false;
    if (sqliteVec) {
      try {
        sqliteVec.load(db);
        hasVectors = true;
      } catch (_) {
        // extension load failed
      }
    }

    this.capabilities = {
      inProcess: true,
      vectors: hasVectors,
      transactions: true,
    };

    // Semi-public: used by embeddings.js and search.js for vec0 operations
    // that require typed arrays (Float32Array) not supported by the generic interface.
    this._db = db;
  }

  read(sql, params = []) {
    try {
      return this._db.prepare(sql).all(...params);
    } catch (err) {
      if (err.message.includes('no such table') || err.message.includes('no such column')) {
        return [];
      }
      console.error(`[clawmem:driver:better-sqlite3] read error: ${err.message}`);
      return [];
    }
  }

  write(sql, params = []) {
    try {
      const result = this._db.prepare(sql).run(...params);
      return { changes: result.changes };
    } catch (_) {
      // Fallback for multi-statement SQL (e.g. schema init)
      try {
        this._db.exec(sql);
        return { changes: -1 };
      } catch (err2) {
        console.error(`[clawmem:driver:better-sqlite3] write error: ${err2.message}`);
        return { changes: -1 };
      }
    }
  }

  run(sql, params = []) {
    return this.write(sql, params);
  }

  transaction(fn) {
    return this._db.transaction(fn)();
  }

  close() {
    this._db.close();
  }
}

// --- Factory ---

function createDriver(dbPath, options = {}) {
  const { forceBackend } = options;

  if (forceBackend === 'cli' || !BetterSqlite3) {
    return new CliDriver(dbPath);
  }

  return new BetterSqliteDriver(dbPath);
}

// --- Utility ---

function dbExists(dbPath) {
  return fs.existsSync(dbPath);
}

module.exports = { createDriver, esc, dbExists, CliDriver, BetterSqliteDriver };
