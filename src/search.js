/**
 * search.js — Hybrid search combining FTS5 keyword search with vector kNN.
 * Merges results via Reciprocal Rank Fusion (RRF).
 * Falls back to FTS5-only when vectors aren't available.
 */

const { esc } = require('./driver');

/**
 * Merge multiple ranked result sets using Reciprocal Rank Fusion.
 *
 * @param {Array<Array<{key: string, data: object}>>} resultSets - Each set ranked best-first
 * @param {number} K - RRF constant (default 60)
 * @returns {Array<{key: string, score: number, data: object}>} Merged results sorted by score desc
 */
function mergeRRF(resultSets, K = 60) {
  const scores = new Map(); // key -> cumulative score
  const dataMap = new Map(); // key -> data (last writer wins, but overlap items share key)

  for (const resultSet of resultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const { key, data } = resultSet[rank];
      const score = 1 / (K + rank + 1);
      scores.set(key, (scores.get(key) || 0) + score);
      // Keep data from the first set that introduces a key (FTS data for overlap items)
      if (!dataMap.has(key)) {
        dataMap.set(key, data);
      }
    }
  }

  const merged = [];
  for (const [key, score] of scores) {
    merged.push({ key, score, data: dataMap.get(key) });
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

/**
 * Run FTS5 keyword search across facts, topics, and members.
 *
 * @param {object} driver - clawmem driver instance
 * @param {string} query - Search query string
 * @param {number} limit - Max results per table
 * @returns {Array<{key: string, data: object}>}
 */
function ftsSearch(driver, query, limit) {
  const escapedQuery = esc(query);
  const results = [];

  // Search facts_fts
  const facts = driver.read(
    `SELECT f.id, f.content, f.confidence, f.tags, f.category, m.display_name as member
     FROM facts f
     LEFT JOIN members m ON f.source_member_id = m.id
     WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${escapedQuery}')
     ORDER BY f.confidence DESC
     LIMIT ${limit}`
  );
  for (const f of facts) {
    results.push({
      key: `fact:${f.id}`,
      data: {
        source: 'fact',
        id: f.id,
        text: f.content,
        confidence: f.confidence,
        member: f.member || null,
        tags: f.tags || '',
        category: f.category,
      },
    });
  }

  // Search topics_fts
  const topics = driver.read(
    `SELECT id, name, summary, tags, participants
     FROM topics
     WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${escapedQuery}')
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const t of topics) {
    results.push({
      key: `topic:${t.id}`,
      data: {
        source: 'topic',
        id: t.id,
        text: t.summary || t.name,
        tags: t.tags || '',
        participants: t.participants || '',
      },
    });
  }

  // Search members_fts
  const members = driver.read(
    `SELECT id, display_name, username, expertise, projects
     FROM members
     WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${escapedQuery}')
     LIMIT ${limit}`
  );
  for (const m of members) {
    results.push({
      key: `member:${m.id}`,
      data: {
        source: 'member',
        id: m.id,
        text: m.display_name || m.username,
        expertise: m.expertise || '',
        projects: m.projects || '',
      },
    });
  }

  return results;
}

/**
 * Run vector kNN search across facts_vec, topics_vec, and members_vec.
 * Requires driver._db (raw better-sqlite3) and sqlite-vec extension loaded.
 *
 * @param {object} driver - clawmem driver instance with ._db
 * @param {number[]} queryEmbedding - Query vector as array of floats
 * @param {number} limit - Max results per table
 * @returns {Array<{key: string, data: object}>}
 */
function vecSearch(driver, queryEmbedding, limit) {
  const db = driver._db;
  const embeddingBuffer = new Float32Array(queryEmbedding);
  const results = [];

  // Search facts_vec
  try {
    const factRows = db.prepare(
      `SELECT fact_id, distance FROM facts_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of factRows) {
      const fact = db.prepare(
        `SELECT f.id, f.content, f.confidence, f.tags, f.category, m.display_name as member
         FROM facts f
         LEFT JOIN members m ON f.source_member_id = m.id
         WHERE f.id = ?`
      ).get(row.fact_id);
      if (fact) {
        results.push({
          key: `fact:${fact.id}`,
          data: {
            source: 'fact',
            id: fact.id,
            text: fact.content,
            confidence: fact.confidence,
            member: fact.member || null,
            tags: fact.tags || '',
            category: fact.category,
          },
        });
      }
    }
  } catch (_) {
    // facts_vec table may not exist yet
  }

  // Search topics_vec
  try {
    const topicRows = db.prepare(
      `SELECT topic_id, distance FROM topics_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of topicRows) {
      const topic = db.prepare(
        `SELECT id, name, summary, tags, participants FROM topics WHERE id = ?`
      ).get(row.topic_id);
      if (topic) {
        results.push({
          key: `topic:${topic.id}`,
          data: {
            source: 'topic',
            id: topic.id,
            text: topic.summary || topic.name,
            tags: topic.tags || '',
            participants: topic.participants || '',
          },
        });
      }
    }
  } catch (_) {
    // topics_vec table may not exist yet
  }

  // Search members_vec
  try {
    const memberRows = db.prepare(
      `SELECT member_id, distance FROM members_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of memberRows) {
      const member = db.prepare(
        `SELECT id, display_name, username, expertise, projects FROM members WHERE id = ?`
      ).get(row.member_id);
      if (member) {
        results.push({
          key: `member:${member.id}`,
          data: {
            source: 'member',
            id: member.id,
            text: member.display_name || member.username,
            expertise: member.expertise || '',
            projects: member.projects || '',
          },
        });
      }
    }
  } catch (_) {
    // members_vec table may not exist yet
  }

  return results;
}

/**
 * Main search function — hybrid FTS5 + vector kNN, or FTS5-only fallback.
 *
 * @param {object} driver - clawmem driver instance
 * @param {string} query - Search query string
 * @param {object} options
 * @param {number} [options.limit=10] - Max results to return
 * @param {boolean} [options.ftsOnly=false] - Skip vector search
 * @param {object|null} [options.embeddingConfig=null] - Embedding config ({ baseUrl, apiKey, model, ... })
 * @returns {Promise<{mode: 'hybrid'|'fts5', results: Array}>}
 */
async function search(driver, query, options = {}) {
  const { limit = 10, ftsOnly = false, embeddingConfig = null } = options;
  const ftsLimit = limit * 2;

  const ftsResults = ftsSearch(driver, query, ftsLimit);

  const canDoVec = !ftsOnly && driver.capabilities.vectors && embeddingConfig;

  if (canDoVec) {
    try {
      const embeddings = require('./embeddings');
      const { embeddings: vecs } = await embeddings.embedWithRetry([query], embeddingConfig);
      const queryVector = vecs[0];
      const vecResults = vecSearch(driver, queryVector, ftsLimit);
      const merged = mergeRRF([ftsResults, vecResults]);

      const results = merged.slice(0, limit).map(item => {
        const d = item.data;
        const out = {
          source: d.source,
          id: d.id,
          text: d.text,
          score: item.score,
        };
        if (d.confidence !== undefined) out.confidence = d.confidence;
        if (d.member !== undefined) out.member = d.member;
        if (d.tags !== undefined) out.tags = d.tags;
        return out;
      });

      return { mode: 'hybrid', results };
    } catch (err) {
      console.error(`[clawmem:search] Hybrid search failed, falling back to FTS5: ${err.message}`);
    }
  }

  // FTS-only path: assign pseudo-RRF scores based on rank
  const results = ftsResults.slice(0, limit).map((item, rank) => {
    const d = item.data;
    const out = {
      source: d.source,
      id: d.id,
      text: d.text,
      score: 1 / (60 + rank + 1),
    };
    if (d.confidence !== undefined) out.confidence = d.confidence;
    if (d.member !== undefined) out.member = d.member;
    if (d.tags !== undefined) out.tags = d.tags;
    return out;
  });

  return { mode: 'fts5', results };
}

module.exports = { search, mergeRRF, ftsSearch, vecSearch };
