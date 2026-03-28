/**
 * store.js — Read/write extracted knowledge to memory.db.
 */

const { esc } = require('./driver');

function mergeCSV(existing, incoming) {
  const existingSet = new Set(
    (existing || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  );
  const incomingItems = (incoming || '').split(',').map(s => s.trim()).filter(Boolean);
  const result = [...(existing || '').split(',').map(s => s.trim()).filter(Boolean)];

  for (const item of incomingItems) {
    if (!existingSet.has(item.toLowerCase())) {
      result.push(item);
      existingSet.add(item.toLowerCase());
    }
  }
  return result.join(', ');
}

function upsertMember(driver, member, messageDate) {
  const existing = driver.read(
    `SELECT id, expertise, projects FROM members WHERE display_name='${esc(member.display_name)}' OR username='${esc(member.username)}'`
  );

  if (existing.length > 0) {
    const e = existing[0];
    const mergedExpertise = mergeCSV(e.expertise, member.expertise);
    const mergedProjects = mergeCSV(e.projects, member.projects);

    driver.write(`
      UPDATE members SET
        expertise = '${esc(mergedExpertise)}',
        projects = '${esc(mergedProjects)}',
        last_seen = '${esc(messageDate)}',
        updated_at = datetime('now')
      WHERE id = ${e.id};
    `);
    return e.id;
  } else {
    driver.write(`
      INSERT INTO members (username, display_name, expertise, projects, first_seen, last_seen)
      VALUES (
        '${esc(member.username || '')}',
        '${esc(member.display_name)}',
        '${esc(member.expertise || '')}',
        '${esc(member.projects || '')}',
        '${esc(messageDate)}',
        '${esc(messageDate)}'
      );
    `);
    // Query back the id (last_insert_rowid doesn't work across separate sqlite3 processes)
    const inserted = driver.read(
      `SELECT id FROM members WHERE display_name='${esc(member.display_name)}' OR username='${esc(member.username)}'`
    );
    return inserted[0]?.id;
  }
}

function insertFact(driver, fact, memberId, messageDate) {
  // Dedup strategy: extract key terms from content and check FTS for similar existing facts.
  // This catches semantically similar facts even when LLM rephrases them.
  const content = fact.content || '';

  // 1. Exact prefix match (fast path)
  const prefix = esc(content.substring(0, 80).toLowerCase());
  const exactMatch = driver.read(
    `SELECT id FROM facts WHERE LOWER(SUBSTR(content, 1, 80)) = '${prefix}'`
  );
  if (exactMatch.length > 0) return false;

  // 2. FTS similarity check: use first 2 distinctive keywords to find similar existing facts.
  //    Two keywords is enough to identify a topic ("langchain AND rag", "hetzner AND vps").
  //    Using more risks missing rephrased duplicates.
  const keywords = extractKeywords(content);
  if (keywords.length >= 2) {
    const ftsQuery = esc(keywords.slice(0, 2).join(' AND '));
    const ftsMatch = driver.read(
      `SELECT id FROM facts WHERE id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${ftsQuery}') AND category = '${esc(fact.category)}' LIMIT 1`
    );
    if (ftsMatch.length > 0) return false;
  }

  driver.write(`
    INSERT INTO facts (category, content, source_member_id, tags, confidence, message_date)
    VALUES (
      '${esc(fact.category)}',
      '${esc(content)}',
      ${memberId || 'NULL'},
      '${esc(fact.tags || '')}',
      ${parseFloat(fact.confidence) || 0.8},
      '${esc(messageDate)}'
    );
  `);
  return true;
}

function extractKeywords(text) {
  // Extended stopwords: common English words + common verbs/adjectives that don't carry topic signal
  const stopwords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','shall','should','may','might','must','can','could',
    'and','but','or','nor','not','no','so','if','then','than','that','this','these','those',
    'it','its','of','in','on','at','to','for','with','by','from','as','into','about','between',
    'through','during','before','after','above','below','up','down','out','off','over','under',
    'such','very','too','also','just','only','more','most','other','some','any','each','every',
    'all','both','few','many','much','own','same','well','still','already','even',
    'works','working','worked','work','used','uses','using','use','like','good','best','better',
    'great','make','makes','made','making','effective','especially','particularly','really',
    'quite','rather','described','features','featuring','recommended','available','based',
    'allows','approach','approaches','current','currently','different','general','generally',
    'include','includes','including','known','large','small','new','old','first','last',
    'high','low','long','short','full','specific','specifically','similar','common','commonly',
    'provides','provides','support','supports','system','systems','method','methods','called']);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));
}

function insertTopic(driver, topic, messageDate) {
  // Dedup: check for existing topic with similar name via FTS (2 keywords)
  const nameKeywords = extractKeywords(topic.name);
  if (nameKeywords.length >= 2) {
    const ftsQuery = esc(nameKeywords.slice(0, 2).join(' AND '));
    const existing = driver.read(
      `SELECT id FROM topics WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${ftsQuery}') LIMIT 1`
    );
    if (existing.length > 0) return false;
  }

  driver.write(`
    INSERT INTO topics (name, summary, participants, message_date, tags)
    VALUES (
      '${esc(topic.name)}',
      '${esc(topic.summary || '')}',
      '${esc(topic.participants || '')}',
      '${esc(messageDate)}',
      '${esc(topic.tags || '')}'
    );
  `);
  return true;
}

function processExtraction(driver, extracted, messageDate) {
  let totalFacts = 0, totalTopics = 0, totalMembers = 0;
  const memberIdMap = {};

  if (extracted.members && Array.isArray(extracted.members)) {
    for (const member of extracted.members) {
      if (!member.display_name) continue;
      const id = upsertMember(driver, member, messageDate);
      memberIdMap[member.display_name.toLowerCase()] = id;
      totalMembers++;
    }
  }

  if (extracted.facts && Array.isArray(extracted.facts)) {
    for (const fact of extracted.facts) {
      if (!fact.content) continue;
      const memberId = fact.source_member
        ? memberIdMap[fact.source_member.toLowerCase()] || null
        : null;
      if (insertFact(driver, fact, memberId, messageDate)) {
        totalFacts++;
      }
    }
  }

  if (extracted.topics && Array.isArray(extracted.topics)) {
    for (const topic of extracted.topics) {
      if (!topic.name) continue;
      insertTopic(driver, topic, messageDate);
      totalTopics++;
    }
  }

  return { totalFacts, totalTopics, totalMembers };
}

function getState(driver) {
  const rows = driver.read('SELECT * FROM extraction_state WHERE id=1');
  return rows[0] || null;
}

function updateState(driver, { lastProcessedId, messagesProcessed, factsExtracted, topicsExtracted }) {
  driver.write(`
    UPDATE extraction_state SET
      last_processed_id = '${esc(String(lastProcessedId))}',
      total_messages_processed = total_messages_processed + ${messagesProcessed},
      total_facts_extracted = total_facts_extracted + ${factsExtracted},
      total_topics_extracted = total_topics_extracted + ${topicsExtracted},
      total_members_seen = (SELECT COUNT(*) FROM members),
      last_run_at = datetime('now')
    WHERE id = 1;
  `);
}

function resetState(driver) {
  driver.write("UPDATE extraction_state SET last_processed_id = '0', total_messages_processed = 0 WHERE id = 1;");
}

function getStats(driver) {
  const members = driver.read('SELECT COUNT(*) as c FROM members');
  const facts = driver.read('SELECT COUNT(*) as c FROM facts');
  const topics = driver.read('SELECT COUNT(*) as c FROM topics');
  const state = getState(driver);

  return {
    members: parseInt(members[0]?.c) || 0,
    facts: parseInt(facts[0]?.c) || 0,
    topics: parseInt(topics[0]?.c) || 0,
    messagesProcessed: parseInt(state?.total_messages_processed) || 0,
    lastProcessedId: state?.last_processed_id || '0',
    lastRun: state?.last_run_at || 'never',
    driver: driver.backend,
    vectors: driver.capabilities.vectors,
  };
}

// --- Query helpers ---

function searchFacts(driver, query, limit = 15, minConfidence = 0) {
  let where = `f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${esc(query)}')`;
  if (minConfidence > 0) where += ` AND f.confidence >= ${minConfidence}`;
  return driver.read(
    `SELECT f.*, m.display_name as source FROM facts f LEFT JOIN members m ON f.source_member_id = m.id WHERE ${where} ORDER BY f.confidence DESC, f.created_at DESC LIMIT ${limit}`
  );
}

function searchTopics(driver, query, limit = 10) {
  return driver.read(
    `SELECT * FROM topics WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${esc(query)}') ORDER BY created_at DESC LIMIT ${limit}`
  );
}

function searchMembers(driver, query) {
  return driver.read(
    `SELECT * FROM members WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${esc(query)}')`
  );
}

function whoKnows(driver, keyword) {
  return driver.read(
    `SELECT display_name, username, expertise, projects FROM members WHERE expertise LIKE '%${esc(keyword)}%' OR projects LIKE '%${esc(keyword)}%' ORDER BY last_seen DESC`
  );
}

function generateRoster(driver, { maxExpertise = 5, maxProjects = 3 } = {}) {
  const members = driver.read('SELECT display_name, expertise, projects FROM members ORDER BY display_name');
  const lines = ['# Community Members', ''];
  for (const m of members) {
    const name = m.display_name || '';
    const exp = (m.expertise || '').split(',').slice(0, maxExpertise).map(s => s.trim()).filter(Boolean).join(', ');
    const proj = (m.projects || '').split(',').slice(0, maxProjects).map(s => s.trim()).filter(Boolean).join(', ');
    let line = `- **${name}**`;
    if (exp) line += ` — ${exp}`;
    if (proj) line += ` | builds: ${proj}`;
    lines.push(line);
  }
  return { content: lines.join('\n') + '\n', count: members.length };
}

module.exports = {
  processExtraction,
  getState,
  updateState,
  resetState,
  getStats,
  searchFacts,
  searchTopics,
  searchMembers,
  whoKnows,
  generateRoster,
};
