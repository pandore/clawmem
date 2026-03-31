'use strict';

const store = require('./store');

/**
 * Assemble layered context for a conversation.
 *
 * @param {object} driver - BetterSqliteDriver instance
 * @param {object} options
 * @param {string[]} [options.participants] - member names to load profiles for
 * @param {string[]} [options.topics] - topic keywords to search
 * @param {number} [options.recencyDays=30] - how far back to look
 * @param {number} [options.tokenBudget=1000] - max output size in tokens
 * @returns {object} { participants, facts, decisions, tasks, questions }
 */
function assembleContext(driver, options = {}) {
  const {
    participants = [],
    topics = [],
    recencyDays: rawRecency = 30,
    tokenBudget: rawBudget = 1000,
  } = options;

  const recencyDays = Math.max(0, Math.min(365, parseInt(rawRecency) || 30));
  const tokenBudget = Math.max(100, Math.min(10000, rawBudget));
  const seen = new Map();
  const result = { participants: [], facts: [], decisions: [], tasks: [], questions: [] };

  // Layer 1: Participants
  if (participants.length > 0) {
    for (const name of participants) {
      const members = store.searchMembers(driver, name);
      if (members.length === 0) continue;
      const member = members[0];

      // Recent facts by this member
      const recentFacts = driver.read(
        `SELECT id, content, category, confidence, created_at FROM facts
         WHERE source_member_id = ${parseInt(member.id)}
         AND created_at >= datetime('now', '-${recencyDays} days')
         ORDER BY created_at DESC LIMIT 5`
      );

      result.participants.push({
        name: member.display_name,
        expertise: member.expertise || '',
        projects: member.projects || '',
        recentFacts: recentFacts.map(f => {
          seen.set(`fact:${f.id}`, true);
          return { id: f.id, content: f.content, category: f.category };
        }),
      });
    }
  }

  // Layer 2: Topics
  if (topics.length > 0) {
    for (const topic of topics) {
      const facts = store.searchFacts(driver, topic, 10);
      for (const f of facts) {
        if (!seen.has(`fact:${f.id}`)) {
          result.facts.push(scoreEntity(f, 'fact', recencyDays));
          seen.set(`fact:${f.id}`, true);
        }
      }

      const decisions = store.searchDecisions(driver, topic, 5);
      for (const d of decisions) {
        if (!seen.has(`decision:${d.id}`)) {
          result.decisions.push(scoreEntity(d, 'decision', recencyDays));
          seen.set(`decision:${d.id}`, true);
        }
      }

      const tasks = store.searchTasks(driver, topic, 5);
      for (const t of tasks) {
        if (!seen.has(`task:${t.id}`)) {
          result.tasks.push(scoreEntity(t, 'task', recencyDays));
          seen.set(`task:${t.id}`, true);
        }
      }

      const questions = store.searchQuestions(driver, topic, 5);
      for (const q of questions) {
        if (!seen.has(`question:${q.id}`)) {
          result.questions.push(scoreEntity(q, 'question', recencyDays));
          seen.set(`question:${q.id}`, true);
        }
      }
    }
  }

  // Layer 3: General (if neither participants nor topics given)
  if (participants.length === 0 && topics.length === 0) {
    const profileConfig = { entities: ['members', 'facts', 'topics', 'decisions', 'tasks', 'questions', 'events'] };
    const active = store.getActiveContext(driver, profileConfig, { recencyDays });

    if (active.facts) {
      for (const f of active.facts) {
        result.facts.push({ ...f, _score: 1.0 });
      }
    }
    if (active.decisions) {
      for (const d of active.decisions) {
        result.decisions.push({ ...d, _score: 1.0 });
      }
    }
    if (active.tasks) {
      for (const t of active.tasks) {
        result.tasks.push({ ...t, _score: 1.0 });
      }
    }
    if (active.questions) {
      for (const q of active.questions) {
        result.questions.push({ ...q, _score: 1.0 });
      }
    }
  }

  // Sort scored entities by score descending
  result.facts.sort((a, b) => (b._score || 0) - (a._score || 0));
  result.decisions.sort((a, b) => (b._score || 0) - (a._score || 0));
  result.tasks.sort((a, b) => (b._score || 0) - (a._score || 0));
  result.questions.sort((a, b) => (b._score || 0) - (a._score || 0));

  // Budget enforcement
  enforceTokenBudget(result, tokenBudget);

  // Strip internal _score fields
  for (const key of ['facts', 'decisions', 'tasks', 'questions']) {
    for (const item of result[key]) {
      delete item._score;
    }
  }

  return result;
}

function scoreEntity(entity, type, recencyDays) {
  const dateField = entity.created_at || entity.message_date;
  let recencyDecay = 1.0;
  if (dateField && recencyDays > 0) {
    const ageDays = (Date.now() - new Date(dateField).getTime()) / (1000 * 60 * 60 * 24);
    recencyDecay = Math.max(0.1, 1 - (ageDays / recencyDays));
  }
  return { ...entity, _score: recencyDecay };
}

function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

function enforceTokenBudget(result, tokenBudget) {
  // Participants always included first — truncate fields if needed
  let used = estimateTokens(result.participants);

  // If participants alone exceed budget, truncate their fields
  if (used > tokenBudget && result.participants.length > 0) {
    for (const p of result.participants) {
      if (p.expertise && p.expertise.length > 100) {
        p.expertise = p.expertise.slice(0, 100);
      }
      if (p.projects && p.projects.length > 100) {
        p.projects = p.projects.slice(0, 100);
      }
      p.recentFacts = p.recentFacts.slice(0, 2);
    }
    used = estimateTokens(result.participants);
  }

  const remaining = tokenBudget - used;
  if (remaining <= 0) {
    result.facts = [];
    result.decisions = [];
    result.tasks = [];
    result.questions = [];
    return;
  }

  // Merge all scored entities, pick greedily by score
  const all = [];
  for (const f of result.facts) all.push({ type: 'facts', item: f, score: f._score || 0 });
  for (const d of result.decisions) all.push({ type: 'decisions', item: d, score: d._score || 0 });
  for (const t of result.tasks) all.push({ type: 'tasks', item: t, score: t._score || 0 });
  for (const q of result.questions) all.push({ type: 'questions', item: q, score: q._score || 0 });

  all.sort((a, b) => b.score - a.score);

  const kept = { facts: [], decisions: [], tasks: [], questions: [] };
  let budgetUsed = 0;

  for (const entry of all) {
    const cost = estimateTokens(entry.item);
    if (budgetUsed + cost > remaining) continue;
    kept[entry.type].push(entry.item);
    budgetUsed += cost;
  }

  result.facts = kept.facts;
  result.decisions = kept.decisions;
  result.tasks = kept.tasks;
  result.questions = kept.questions;
}

module.exports = { assembleContext };
