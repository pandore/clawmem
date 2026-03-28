/**
 * embeddings.js — OpenAI-compatible embedding client for clawmem.
 * Handles token-aware batching, retry, vec0 table management,
 * model change detection, and backfill logic.
 */

'use strict';

const { esc } = require('./driver');

// --- Utility functions ---

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Groups an array of texts into batches that each fit within batchTokenLimit.
 * Uses character length as a proxy for tokens (batchTokenLimit is a character budget).
 * Texts that individually exceed the limit are placed in their own batch.
 */
function splitIntoBatches(texts, batchTokenLimit) {
  const batches = [];
  let currentBatch = [];
  let currentLen = 0;

  for (const text of texts) {
    const len = (text || '').length;
    if (currentBatch.length > 0 && currentLen + len > batchTokenLimit) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLen = 0;
    }
    currentBatch.push(text);
    currentLen += len;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// --- API client ---

/**
 * POST to config.baseUrl + '/embeddings' with Bearer auth.
 * Returns { embeddings: [[...], ...], dimensions: N }
 */
async function embed(texts, config) {
  const url = config.baseUrl.replace(/\/$/, '') + '/embeddings';
  const body = JSON.stringify({
    model: config.model,
    input: texts,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Embedding API error ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const embeddings = data.data.map(item => item.embedding);
  const dimensions = embeddings.length > 0 ? embeddings[0].length : (config.dimensions || 0);

  return { embeddings, dimensions };
}

/**
 * Retries embed() on 429 with exponential backoff (1s, 2s, 4s).
 */
async function embedWithRetry(texts, config, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await embed(texts, config);
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
}

// --- Metadata helpers ---

/**
 * Reads a value from clawmem_meta table.
 */
function getMeta(driver, key) {
  const rows = driver.read(
    `SELECT value FROM clawmem_meta WHERE key = '${esc(key)}'`
  );
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Writes a value to clawmem_meta table (INSERT OR REPLACE).
 */
function setMeta(driver, key, value) {
  driver.write(
    `INSERT OR REPLACE INTO clawmem_meta (key, value, updated_at) VALUES ('${esc(key)}', '${esc(String(value))}', datetime('now'))`
  );
}

/**
 * Compares stored embedding_model against config.model.
 * Returns { ok: true } if consistent, or { ok: false, error: '...' } if not.
 */
function checkModelConsistency(driver, config) {
  const stored = getMeta(driver, 'embedding_model');
  if (!stored) {
    // No model stored yet — considered consistent (first run)
    return { ok: true };
  }
  if (stored !== config.model) {
    return {
      ok: false,
      error: `Model mismatch: stored='${stored}', config='${config.model}'. Use rebuild option to re-embed with new model.`,
    };
  }
  return { ok: true };
}

// --- Vec0 management ---

/**
 * Creates facts_vec, topics_vec, members_vec using vec0.
 * Throws if driver.capabilities.vectors is false.
 */
function createVecTables(driver, dimensions) {
  if (!driver.capabilities.vectors) {
    throw new Error('Vector capability not available on this driver (sqlite-vec not loaded)');
  }

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(
      fact_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS topics_vec USING vec0(
      topic_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS members_vec USING vec0(
      member_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);
}

/**
 * Returns coverage stats: total vs embedded for each table, plus model and dimensions.
 */
function getEmbeddingStats(driver) {
  const model = getMeta(driver, 'embedding_model') || null;
  const dimensions = getMeta(driver, 'embedding_dimensions');

  function count(table) {
    const rows = driver.read(`SELECT COUNT(*) as c FROM ${table}`);
    return parseInt(rows[0]?.c) || 0;
  }

  const factsTotal = count('facts');
  const topicsTotal = count('topics');
  const membersTotal = count('members');

  // Vec tables may not exist yet; driver.read returns [] on missing table
  const factsEmbedded = count('facts_vec');
  const topicsEmbedded = count('topics_vec');
  const membersEmbedded = count('members_vec');

  return {
    model,
    dimensions: dimensions ? parseInt(dimensions) : null,
    facts: { total: factsTotal, embedded: factsEmbedded },
    topics: { total: topicsTotal, embedded: topicsEmbedded },
    members: { total: membersTotal, embedded: membersEmbedded },
  };
}

// --- Backfill pipeline ---

/**
 * Embeds all unembedded facts, topics, and members.
 *
 * Steps:
 * 1. Check driver.capabilities.vectors — skip if unavailable
 * 2. Check model consistency (unless options.rebuild)
 * 3. Determine dimensions (config → stored meta → auto-detect via probe)
 * 4. If rebuild: drop existing vec tables, clear meta
 * 5. Create vec tables if needed
 * 6. Store meta (model, dimensions, baseUrl)
 * 7. Embed unembedded facts, topics, members
 * 8. Return { ok: true, totalEmbedded }
 *
 * @param {object} driver
 * @param {object} config - { baseUrl, apiKey, model, dimensions?, batchTokenLimit? }
 * @param {object} [options] - { rebuild?, batchTokenLimit? }
 */
async function backfill(driver, config, options = {}) {
  if (!driver.capabilities.vectors) {
    console.warn('[clawmem:embeddings] Skipping backfill — vector capability unavailable');
    return { ok: false, skipped: true, reason: 'vectors_unavailable' };
  }

  // Model consistency check
  if (!options.rebuild) {
    const consistency = checkModelConsistency(driver, config);
    if (!consistency.ok) {
      return { ok: false, error: consistency.error };
    }
  }

  // Determine dimensions
  let dimensions = config.dimensions ? parseInt(config.dimensions) : null;

  if (!dimensions) {
    const storedDims = getMeta(driver, 'embedding_dimensions');
    if (storedDims) {
      dimensions = parseInt(storedDims);
    }
  }

  if (!dimensions) {
    // Auto-detect via probe call
    console.log('[clawmem:embeddings] Detecting dimensions via probe embedding...');
    const probe = await embedWithRetry(['probe'], config);
    dimensions = probe.dimensions;
  }

  // Rebuild: drop existing vec tables and clear meta
  if (options.rebuild) {
    for (const table of ['facts_vec', 'topics_vec', 'members_vec']) {
      driver.write(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const key of ['embedding_model', 'embedding_dimensions', 'embedding_base_url']) {
      driver.write(`DELETE FROM clawmem_meta WHERE key = '${esc(key)}'`);
    }
  }

  // Create vec tables if they don't exist
  createVecTables(driver, dimensions);

  // Store meta
  setMeta(driver, 'embedding_model', config.model);
  setMeta(driver, 'embedding_dimensions', String(dimensions));
  setMeta(driver, 'embedding_base_url', config.baseUrl);

  const batchTokenLimit = options.batchTokenLimit || config.batchTokenLimit || 8000;
  let totalEmbedded = 0;

  // --- Embed facts ---
  {
    const rows = driver.read(
      `SELECT f.id, f.content FROM facts f
       LEFT JOIN facts_vec fv ON f.id = fv.fact_id
       WHERE fv.fact_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r => r.content || '');
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO facts_vec (fact_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(row.id, new Float32Array(result.embeddings[i]));
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed topics ---
  {
    const rows = driver.read(
      `SELECT t.id, t.name, t.summary FROM topics t
       LEFT JOIN topics_vec tv ON t.id = tv.topic_id
       WHERE tv.topic_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r => `${r.name || ''}: ${r.summary || ''}`);
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO topics_vec (topic_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(row.id, new Float32Array(result.embeddings[i]));
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed members ---
  {
    const rows = driver.read(
      `SELECT m.id, m.display_name, m.expertise, m.projects FROM members m
       LEFT JOIN members_vec mv ON m.id = mv.member_id
       WHERE mv.member_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r =>
        `${r.display_name || ''} — ${r.expertise || ''} | ${r.projects || ''}`
      );
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO members_vec (member_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(row.id, new Float32Array(result.embeddings[i]));
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  return { ok: true, totalEmbedded };
}

module.exports = {
  estimateTokens,
  splitIntoBatches,
  embed,
  embedWithRetry,
  getMeta,
  setMeta,
  checkModelConsistency,
  createVecTables,
  getEmbeddingStats,
  backfill,
};
