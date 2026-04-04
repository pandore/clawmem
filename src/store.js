/**
 * store.js — Read/write extracted knowledge to memory.db.
 */

const { esc, sanitizeFtsQuery } = require('./driver');

// Reject facts that contain credentials, API keys, tokens, or secrets.
// These can leak into agent prompts via context injection or search results.
const CREDENTIAL_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{20,})\b/,                     // OpenAI keys
  /\b(AIza[a-zA-Z0-9_-]{30,})\b/,                   // Google API keys
  /\b(ghp_[a-zA-Z0-9]{36,})\b/,                     // GitHub PATs
  /\b(ghs_[a-zA-Z0-9]{36,})\b/,                     // GitHub app tokens
  /\b(glpat-[a-zA-Z0-9_-]{20,})\b/,                 // GitLab PATs
  /\b(xox[bpras]-[a-zA-Z0-9-]{10,})\b/,             // Slack tokens
  /\b(AKIA[A-Z0-9]{16})\b/,                         // AWS access keys
  /\b(eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]+)\b/, // JWTs
  /\b[a-f0-9]{40}\b/,                                // 40-char hex (SHA1 tokens/secrets)
  /\bapi[_-]?key\s*[:=]\s*\S{10,}/i,                // Generic "api_key = ..."
  /\bsecret[_-]?key\s*[:=]\s*\S{10,}/i,             // Generic "secret_key = ..."
  /\bpassword\s*[:=]\s*\S{6,}/i,                     // Inline passwords
  /\btoken\s*[:=]\s*\S{10,}/i,                       // Generic "token = ..."
];

function containsCredential(text) {
  return CREDENTIAL_PATTERNS.some(p => p.test(text));
}

// Filter out generic/bot member names that don't represent real people
const GENERIC_MEMBER_NAMES = new Set([
  'ai agent', 'ai assistant', 'assistant', 'bot', 'chatbot', 'system',
  'admin', 'moderator', 'unknown', 'anonymous', 'user', 'guest',
  'content agent', 'chat agent', 'virtual assistant',
]);

const GENERIC_MEMBER_PATTERN = /^(?:ai|content|chat|virtual|auto)\s+(?:agent|assistant|bot|helper)$/i;

function isGenericMember(name) {
  const normalized = name.toLowerCase().trim();
  return GENERIC_MEMBER_NAMES.has(normalized) || GENERIC_MEMBER_PATTERN.test(normalized);
}

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

function insertFact(driver, fact, memberId, messageDate, sourceAgent, conversationId) {
  // Dedup strategy: extract key terms from content and check FTS for similar existing facts.
  // This catches semantically similar facts even when LLM rephrases them.
  const content = fact.content || '';

  // Reject facts containing credentials/secrets — these leak into agent prompts
  if (containsCredential(content)) return false;

  // Dedup: combined exact-prefix + FTS keyword check in single query
  const prefix = esc(content.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(content);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM facts WHERE LOWER(SUBSTR(content, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR (id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${ftsQuery}') AND category = '${esc(fact.category)}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;

  driver.write(`
    INSERT INTO facts (category, content, source_member_id, tags, confidence, message_date, source_agent, conversation_id)
    VALUES (
      '${esc(fact.category)}',
      '${esc(content)}',
      ${memberId || 'NULL'},
      '${esc(fact.tags || '')}',
      ${parseFloat(fact.confidence) || 0.8},
      '${esc(messageDate)}',
      ${sourceAgent ? `'${esc(sourceAgent)}'` : 'NULL'},
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'}
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

function insertTopic(driver, topic, messageDate, conversationId) {
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
    INSERT INTO topics (name, summary, participants, message_date, tags, conversation_id)
    VALUES (
      '${esc(topic.name)}',
      '${esc(topic.summary || '')}',
      '${esc(topic.participants || '')}',
      '${esc(messageDate)}',
      '${esc(topic.tags || '')}',
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'}
    );
  `);
  return true;
}

function insertDecision(driver, decision, messageDate, sourceAgent, conversationId) {
  const description = decision.description || '';
  const prefix = esc(description.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(description);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM decisions WHERE LOWER(SUBSTR(description, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;

  driver.write(`
    INSERT INTO decisions (description, participants, context, status, tags, message_date, source_agent, conversation_id)
    VALUES (
      '${esc(description)}',
      '${esc(decision.participants || '')}',
      '${esc(decision.context || '')}',
      '${esc(decision.status || 'proposed')}',
      '${esc(decision.tags || '')}',
      '${esc(messageDate)}',
      ${sourceAgent ? `'${esc(sourceAgent)}'` : 'NULL'},
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'}
    );
  `);
  return true;
}

function insertTask(driver, task, memberId, messageDate, sourceAgent, conversationId) {
  const description = task.description || '';
  const prefix = esc(description.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(description);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM tasks WHERE LOWER(SUBSTR(description, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;

  driver.write(`
    INSERT INTO tasks (description, assignee, deadline, status, source_member_id, tags, message_date, source_agent, conversation_id)
    VALUES (
      '${esc(description)}',
      '${esc(task.assignee || '')}',
      ${task.deadline ? `'${esc(task.deadline)}'` : 'NULL'},
      '${esc(task.status || 'open')}',
      ${memberId || 'NULL'},
      '${esc(task.tags || '')}',
      '${esc(messageDate)}',
      ${sourceAgent ? `'${esc(sourceAgent)}'` : 'NULL'},
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'}
    );
  `);
  return true;
}

function insertQuestion(driver, question, messageDate, conversationId) {
  const text = question.question || '';
  const prefix = esc(text.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(text);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM questions WHERE LOWER(SUBSTR(question, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;

  driver.write(`
    INSERT INTO questions (question, asker, answer, answered_by, status, tags, message_date, conversation_id)
    VALUES (
      '${esc(text)}',
      '${esc(question.asker || '')}',
      ${question.answer ? `'${esc(question.answer)}'` : 'NULL'},
      '${esc(question.answered_by || '')}',
      '${esc(question.status || 'open')}',
      '${esc(question.tags || '')}',
      '${esc(messageDate)}',
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'}
    );
  `);
  return true;
}

function insertEvent(driver, event, messageDate, conversationId) {
  const name = event.name || '';
  const prefix = esc(name.substring(0, 80).toLowerCase());
  const keywords = extractKeywords(name);
  const ftsQuery = keywords.length >= 2 ? esc(keywords.slice(0, 2).join(' AND ')) : '';

  const duplicate = driver.read(
    `SELECT id FROM events WHERE LOWER(SUBSTR(name, 1, 80)) = '${prefix}'` +
    (ftsQuery ? ` OR id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${ftsQuery}')` : '') +
    ` LIMIT 1`
  );
  if (duplicate.length > 0) return false;

  driver.write(`
    INSERT INTO events (name, description, event_date, location, attendees, tags, message_date, conversation_id)
    VALUES (
      '${esc(name)}',
      '${esc(event.description || '')}',
      ${event.event_date ? `'${esc(event.event_date)}'` : 'NULL'},
      '${esc(event.location || '')}',
      '${esc(event.attendees || '')}',
      '${esc(event.tags || '')}',
      '${esc(messageDate)}',
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'}
    );
  `);
  return true;
}

// --- Entity update functions ---

function updateDecisionStatus(driver, id, status, context) {
  const existing = driver.read(`SELECT id FROM decisions WHERE id = ${parseInt(id)}`);
  if (existing.length === 0) return false;
  if (!['proposed', 'agreed', 'revisited'].includes(status)) return false;
  let sql = `UPDATE decisions SET status = '${esc(status)}', updated_at = datetime('now')`;
  if (context) sql += `, context = '${esc(context)}'`;
  sql += ` WHERE id = ${parseInt(id)};`;
  driver.write(sql);
  return true;
}

function updateTaskStatus(driver, id, status) {
  const existing = driver.read(`SELECT id FROM tasks WHERE id = ${parseInt(id)}`);
  if (existing.length === 0) return false;
  if (!['open', 'done', 'blocked'].includes(status)) return false;
  driver.write(`UPDATE tasks SET status = '${esc(status)}', updated_at = datetime('now') WHERE id = ${parseInt(id)};`);
  return true;
}

function updateQuestionAnswer(driver, id, answer, answeredBy) {
  const existing = driver.read(`SELECT id FROM questions WHERE id = ${parseInt(id)}`);
  if (existing.length === 0) return false;
  driver.write(`UPDATE questions SET answer = '${esc(answer)}', answered_by = '${esc(answeredBy || '')}', status = 'answered', updated_at = datetime('now') WHERE id = ${parseInt(id)};`);
  return true;
}

// --- Context query helpers ---

function getActiveContext(driver, profileConfig, options = {}) {
  const { recencyDays = 30, maxItems = {} } = options;
  const entities = profileConfig.entities;
  const context = {};

  if (entities.includes('decisions')) {
    const limit = maxItems.decisions || 5;
    context.decisions = driver.read(
      `SELECT id, description, status, context FROM decisions WHERE status IN ('proposed', 'agreed') ORDER BY created_at DESC LIMIT ${limit}`
    );
  }

  if (entities.includes('tasks')) {
    const limit = maxItems.tasks || 10;
    context.tasks = driver.read(
      `SELECT id, description, assignee, status FROM tasks WHERE status IN ('open', 'blocked') ORDER BY created_at DESC LIMIT ${limit}`
    );
  }

  if (entities.includes('questions')) {
    const limit = maxItems.questions || 5;
    context.questions = driver.read(
      `SELECT id, question, asker, status FROM questions WHERE status = 'open' ORDER BY created_at DESC LIMIT ${limit}`
    );
  }

  if (entities.includes('facts')) {
    const limit = maxItems.facts || 5;
    context.facts = driver.read(
      `SELECT id, content, confidence FROM facts WHERE created_at >= datetime('now', '-${recencyDays} days') ORDER BY confidence DESC, created_at DESC LIMIT ${limit}`
    );
  }

  if (entities.includes('topics')) {
    const limit = maxItems.topics || 3;
    context.topics = driver.read(
      `SELECT id, name FROM topics WHERE created_at >= datetime('now', '-${recencyDays} days') ORDER BY created_at DESC LIMIT ${limit}`
    );
  }

  return context;
}

function formatContext(context, tokenBudget = 1000) {
  const lines = [];

  if (context.topics?.length) {
    lines.push('Recent topics: ' + context.topics.map(t => t.name).join(', '));
  }
  if (context.decisions?.length) {
    lines.push('Open decisions:');
    for (const d of context.decisions) {
      lines.push(`  [id:${d.id}] ${d.description} -- status: ${d.status}`);
    }
  }
  if (context.tasks?.length) {
    lines.push('Open tasks:');
    for (const t of context.tasks) {
      lines.push(`  [id:${t.id}] ${t.description} -- ${t.assignee || 'unassigned'}, ${t.status}`);
    }
  }
  if (context.questions?.length) {
    lines.push('Unanswered questions:');
    for (const q of context.questions) {
      lines.push(`  [id:${q.id}] ${q.question} (asked by ${q.asker})`);
    }
  }
  if (context.facts?.length) {
    lines.push('Recent facts:');
    for (const f of context.facts) {
      lines.push(`  [id:${f.id}] ${f.content} (${f.confidence})`);
    }
  }

  if (lines.length === 0) return '';

  // Token budget enforcement: rough estimate (1 token ~ 4 chars)
  let text = lines.join('\n');
  while (Math.ceil(text.length / 4) > tokenBudget && lines.length > 1) {
    lines.pop();
    text = lines.join('\n');
  }

  return text;
}

function processExtraction(driver, extracted, messageDate, { sourceAgent = null, conversationId = null } = {}) {
  let totalFacts = 0, totalTopics = 0, totalMembers = 0;
  let totalDecisions = 0, totalTasks = 0, totalQuestions = 0, totalEvents = 0;
  const memberIdMap = {};
  const insertedFactIds = [];

  if (extracted.members && Array.isArray(extracted.members)) {
    for (const member of extracted.members) {
      if (!member.display_name) continue;
      if (isGenericMember(member.display_name)) continue;
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
      if (insertFact(driver, fact, memberId, messageDate, sourceAgent, conversationId)) {
        totalFacts++;
        const lastFact = driver.read('SELECT id FROM facts ORDER BY id DESC LIMIT 1');
        if (lastFact.length > 0) insertedFactIds.push(lastFact[0].id);
      }
    }
  }

  if (extracted.topics && Array.isArray(extracted.topics)) {
    for (const topic of extracted.topics) {
      if (!topic.name) continue;
      if (insertTopic(driver, topic, messageDate, conversationId)) {
        totalTopics++;
      }
    }
  }

  if (extracted.decisions && Array.isArray(extracted.decisions)) {
    for (const decision of extracted.decisions) {
      if (!decision.description) continue;
      if (insertDecision(driver, decision, messageDate, sourceAgent, conversationId)) {
        totalDecisions++;
      }
    }
  }

  if (extracted.tasks && Array.isArray(extracted.tasks)) {
    for (const task of extracted.tasks) {
      if (!task.description) continue;
      const memberId = task.source_member
        ? memberIdMap[task.source_member.toLowerCase()] || null
        : null;
      if (insertTask(driver, task, memberId, messageDate, sourceAgent, conversationId)) {
        totalTasks++;
      }
    }
  }

  if (extracted.questions && Array.isArray(extracted.questions)) {
    for (const question of extracted.questions) {
      if (!question.question) continue;
      if (insertQuestion(driver, question, messageDate, conversationId)) {
        totalQuestions++;
      }
    }
  }

  if (extracted.events && Array.isArray(extracted.events)) {
    for (const event of extracted.events) {
      if (!event.name) continue;
      if (insertEvent(driver, event, messageDate, conversationId)) {
        totalEvents++;
      }
    }
  }

  // Process updates for existing entities
  let totalUpdated = 0;
  if (extracted.updates) {
    if (Array.isArray(extracted.updates.decisions)) {
      for (const upd of extracted.updates.decisions) {
        if (upd.id && upd.status && updateDecisionStatus(driver, upd.id, upd.status, upd.context))
          totalUpdated++;
      }
    }
    if (Array.isArray(extracted.updates.tasks)) {
      for (const upd of extracted.updates.tasks) {
        if (upd.id && upd.status && updateTaskStatus(driver, upd.id, upd.status))
          totalUpdated++;
      }
    }
    if (Array.isArray(extracted.updates.questions)) {
      for (const upd of extracted.updates.questions) {
        if (upd.id && upd.answer && updateQuestionAnswer(driver, upd.id, upd.answer, upd.answered_by))
          totalUpdated++;
      }
    }
  }

  return { totalFacts, totalTopics, totalMembers, totalDecisions, totalTasks, totalQuestions, totalEvents, totalUpdated, insertedFactIds };
}

/**
 * Post-FTS semantic dedup for a batch of fact IDs.
 * Checks each new fact's embedding against existing facts_vec.
 * Returns Set of fact IDs that are semantic duplicates (should be deleted).
 */
async function semanticDedupFacts(driver, newFactIds, embeddingConfig, options = {}) {
  const { threshold = 0.15 } = options;
  if (!driver.capabilities.vectors || !driver._db || newFactIds.length === 0) {
    return new Set();
  }

  const embeddings = require('./embeddings');
  const duplicateIds = new Set();

  const placeholders = newFactIds.map(() => '?').join(',');
  const newFacts = driver._db.prepare(
    `SELECT id, content FROM facts WHERE id IN (${placeholders})`
  ).all(...newFactIds);

  if (newFacts.length === 0) return duplicateIds;

  const texts = newFacts.map(f => f.content);
  let vecs;
  try {
    const result = await embeddings.embedWithRetry(texts, embeddingConfig);
    vecs = result.embeddings;
  } catch (_) {
    return duplicateIds;
  }

  for (let i = 0; i < newFacts.length; i++) {
    if (duplicateIds.has(newFacts[i].id)) continue;
    const queryVec = new Float32Array(vecs[i]);
    try {
      const neighbors = driver._db.prepare(
        'SELECT fact_id, distance FROM facts_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 5'
      ).all(queryVec);

      for (const n of neighbors) {
        if (n.fact_id === newFacts[i].id) continue;
        if (n.distance < threshold) {
          duplicateIds.add(newFacts[i].id);
          break;
        }
      }
    } catch (_) {
      // facts_vec may not exist yet
    }
  }

  return duplicateIds;
}

function removeFacts(driver, factIds) {
  if (factIds.length === 0) return;
  for (const id of factIds) {
    driver.write(`DELETE FROM facts WHERE id = ${parseInt(id)}`);
    // Clean up vec and metadata if present
    if (driver._db) {
      try { driver._db.prepare('DELETE FROM facts_vec WHERE fact_id = ?').run(id); } catch (_) {}
      try { driver._db.prepare("DELETE FROM embedding_metadata WHERE entity_type = 'fact' AND entity_id = ?").run(id); } catch (_) {}
    }
  }
}

function getState(driver) {
  const rows = driver.read('SELECT * FROM extraction_state WHERE id=1');
  return rows[0] || null;
}

function updateState(driver, { lastProcessedId, messagesProcessed, factsExtracted, topicsExtracted,
  decisionsExtracted = 0, tasksExtracted = 0, questionsExtracted = 0, eventsExtracted = 0, updatesApplied = 0 }) {
  driver.write(`
    UPDATE extraction_state SET
      last_processed_id = '${esc(String(lastProcessedId))}',
      total_messages_processed = total_messages_processed + ${messagesProcessed},
      total_facts_extracted = total_facts_extracted + ${factsExtracted},
      total_topics_extracted = total_topics_extracted + ${topicsExtracted},
      total_decisions_extracted = total_decisions_extracted + ${decisionsExtracted},
      total_tasks_extracted = total_tasks_extracted + ${tasksExtracted},
      total_questions_extracted = total_questions_extracted + ${questionsExtracted},
      total_events_extracted = total_events_extracted + ${eventsExtracted},
      total_updates_applied = total_updates_applied + ${updatesApplied},
      total_members_seen = (SELECT COUNT(*) FROM members),
      last_run_at = datetime('now')
    WHERE id = 1;
  `);
}

function resetState(driver) {
  driver.write("UPDATE extraction_state SET last_processed_id = '0', total_messages_processed = 0 WHERE id = 1;");
}

function setCursor(driver, id) {
  driver.write(`UPDATE extraction_state SET last_processed_id = '${esc(String(id))}' WHERE id = 1;`);
}

function getKnownMemberNames(driver, limit = 100) {
  const safeLimit = Math.max(1, parseInt(limit) || 100);
  const rows = driver.read(`SELECT display_name FROM members ORDER BY last_seen DESC LIMIT ${safeLimit}`);
  return rows.map(r => r.display_name).filter(Boolean);
}

function getStats(driver) {
  const members = driver.read('SELECT COUNT(*) as c FROM members');
  const facts = driver.read('SELECT COUNT(*) as c FROM facts');
  const topics = driver.read('SELECT COUNT(*) as c FROM topics');
  const decisions = driver.read('SELECT COUNT(*) as c FROM decisions');
  const tasks = driver.read('SELECT COUNT(*) as c FROM tasks');
  const questions = driver.read('SELECT COUNT(*) as c FROM questions');
  const events = driver.read('SELECT COUNT(*) as c FROM events');
  const state = getState(driver);

  // Get profile from meta
  const profileMeta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'");
  const profile = profileMeta[0]?.value || 'knowledge';

  return {
    members: parseInt(members[0]?.c) || 0,
    facts: parseInt(facts[0]?.c) || 0,
    topics: parseInt(topics[0]?.c) || 0,
    decisions: parseInt(decisions[0]?.c) || 0,
    tasks: parseInt(tasks[0]?.c) || 0,
    questions: parseInt(questions[0]?.c) || 0,
    events: parseInt(events[0]?.c) || 0,
    messagesProcessed: parseInt(state?.total_messages_processed) || 0,
    lastProcessedId: state?.last_processed_id || '0',
    lastRun: state?.last_run_at || 'never',
    profile,
    driver: driver.backend,
    vectors: driver.capabilities.vectors,
  };
}

// --- Query helpers ---

function searchFacts(driver, query, limit = 15, minConfidence = 0) {
  const sanitized = esc(sanitizeFtsQuery(query));
  let where = `f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${sanitized}')`;
  if (minConfidence > 0) where += ` AND f.confidence >= ${minConfidence}`;
  return driver.read(
    `SELECT f.*, m.display_name as source FROM facts f LEFT JOIN members m ON f.source_member_id = m.id WHERE ${where} ORDER BY f.confidence DESC, f.created_at DESC LIMIT ${limit}`
  );
}

function searchTopics(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM topics WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${sanitized}') ORDER BY created_at DESC LIMIT ${limit}`
  );
}

function searchMembers(driver, query) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM members WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${sanitized}')`
  );
}

function whoKnows(driver, keyword) {
  return driver.read(
    `SELECT display_name, username, expertise, projects FROM members WHERE expertise LIKE '%${esc(keyword)}%' OR projects LIKE '%${esc(keyword)}%' ORDER BY last_seen DESC`
  );
}

function searchDecisions(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM decisions WHERE id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${sanitized}') ORDER BY created_at DESC LIMIT ${limit}`
  );
}

function searchTasks(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT t.*, m.display_name as source FROM tasks t LEFT JOIN members m ON t.source_member_id = m.id WHERE t.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${sanitized}') ORDER BY t.created_at DESC LIMIT ${limit}`
  );
}

function searchQuestions(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM questions WHERE id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${sanitized}') ORDER BY created_at DESC LIMIT ${limit}`
  );
}

function searchEvents(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM events WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${sanitized}') ORDER BY created_at DESC LIMIT ${limit}`
  );
}

function generateRoster(driver, { maxExpertise = 5, maxProjects = 3, title = 'Members', memberLabels = null } = {}) {
  const members = driver.read('SELECT display_name, expertise, projects FROM members ORDER BY display_name');
  const projLabel = memberLabels?.rosterProjects || 'builds';
  const lines = [`# ${title}`, ''];
  for (const m of members) {
    const name = m.display_name || '';
    const exp = (m.expertise || '').split(',').slice(0, maxExpertise).map(s => s.trim()).filter(Boolean).join(', ');
    const proj = (m.projects || '').split(',').slice(0, maxProjects).map(s => s.trim()).filter(Boolean).join(', ');
    let line = `- **${name}**`;
    if (exp) line += ` — ${exp}`;
    if (proj) line += ` | ${projLabel}: ${proj}`;
    lines.push(line);
  }
  return { content: lines.join('\n') + '\n', count: members.length };
}

module.exports = {
  processExtraction,
  getState,
  updateState,
  resetState,
  setCursor,
  getStats,
  searchFacts,
  searchTopics,
  searchMembers,
  searchDecisions,
  searchTasks,
  searchQuestions,
  searchEvents,
  whoKnows,
  generateRoster,
  updateDecisionStatus,
  updateTaskStatus,
  updateQuestionAnswer,
  getKnownMemberNames,
  getActiveContext,
  formatContext,
  semanticDedupFacts,
  removeFacts,
};
