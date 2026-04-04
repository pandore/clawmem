/**
 * extractor.js — Core extraction pipeline. Adapter-agnostic, model-agnostic.
 */

const llm = require('./llm');
const { formatMessages } = llm;
const { NoObjectGeneratedError } = require('ai');
const store = require('./store');
const urlEnricher = require('./enrichers/url');
const { getProfile } = require('./profiles');

async function run(adapter, driver, config, options = {}) {
  const { dryRun = false, reprocess = false, rosterPath = null, enrichUrls = true, noEmbed = false, limit = null, from = null } = options;
  const { batchSize = 40, minMessages = 5 } = config;

  const log = (msg) => console.log(msg);

  // Resolve profile: config → DB meta → default "knowledge"
  let profileName = config.profile || null;
  if (!profileName) {
    const meta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'");
    profileName = meta[0]?.value || 'knowledge';
  }
  const profileConfig = getProfile(profileName);

  // Override with config-level entity/category customization
  if (config.entities) profileConfig.entities = config.entities;
  if (config.factCategories) profileConfig.factCategories = config.factCategories;

  log(`[${new Date().toISOString()}] lizardbrain extraction`);
  log(`Memory DB: ${driver.dbPath}`);
  log(`Backend: ${driver.backend}`);
  log(`Profile: ${profileName}`);
  log(`Source: ${adapter.name}`);

  // Validate adapter
  const validation = adapter.validate();
  if (!validation.ok) {
    log(`Source validation failed: ${validation.error}`);
    return { ok: false, error: validation.error };
  }

  // Reset state if reprocessing
  if (reprocess) {
    log('Resetting extraction state...');
    store.resetState(driver);
  }

  // Get cursor position
  const state = store.getState(driver);
  let lastId = state?.last_processed_id || '0';
  if (from) {
    log(`Overriding cursor: ${lastId} → ${from} (ephemeral, cursor not mutated)`);
    lastId = String(from);
  }
  log(`Last processed ID: ${lastId}`);

  // Fetch new messages
  const messages = adapter.getMessages(lastId);
  log(`New messages: ${messages.length}`);

  if (messages.length < minMessages) {
    log(`Below threshold (${minMessages}). Skipping.`);
    store.updateState(driver, {
      lastProcessedId: lastId,
      messagesProcessed: 0,
      factsExtracted: 0,
      topicsExtracted: 0,
    });
    return { ok: true, skipped: true, messages: messages.length };
  }

  // Group messages by conversationId (if present), then batch within each group
  const batchOverlap = config.batchOverlap || 0;
  const overlap = Math.min(batchOverlap, Math.floor(batchSize / 2));
  const step = overlap > 0 ? batchSize - overlap : batchSize;
  const batches = [];
  const batchMetas = [];

  const hasConversations = messages.some(m => m.conversationId);
  if (hasConversations) {
    const groups = new Map();
    for (const m of messages) {
      const key = m.conversationId || '__no_conversation__';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    log(`Conversation groups: ${groups.size}`);
    for (const [, groupMsgs] of groups) {
      for (let i = 0; i < groupMsgs.length; i += step) {
        batches.push(groupMsgs.slice(i, i + batchSize));
        batchMetas.push({ overlapCount: (i === 0) ? 0 : overlap });
      }
    }
  } else {
    for (let i = 0; i < messages.length; i += step) {
      batches.push(messages.slice(i, i + batchSize));
      batchMetas.push({ overlapCount: (i === 0) ? 0 : overlap });
    }
  }
  if (overlap > 0) log(`Batch overlap: ${overlap} messages`);

  // Batch limit: --limit N or auto-limit to 1 for dry-run
  const effectiveLimit = limit || (dryRun ? 1 : null);
  if (effectiveLimit && batches.length > effectiveLimit) {
    batches.splice(effectiveLimit);
    batchMetas.splice(effectiveLimit);
    log(`Limiting to ${effectiveLimit} batch(es)${dryRun && !limit ? ' (dry-run default)' : ''}`);
  }

  log(`Processing ${batches.length} batch(es)...`);

  // Query known members for prompt dedup hint
  const knownMembers = store.getKnownMemberNames(driver);
  if (knownMembers.length > 0) log(`Known members: ${knownMembers.length}`);

  // Query context from existing knowledge if enabled
  let contextSection = null;
  if (config.context?.enabled) {
    const activeContext = store.getActiveContext(driver, profileConfig, {
      recencyDays: config.context.recencyDays,
      maxItems: config.context.maxItems,
    });
    contextSection = store.formatContext(activeContext, config.context.tokenBudget);
    if (contextSection) log(`Context: ${contextSection.split('\n').length} lines injected`);
  }

  let totalFacts = 0, totalTopics = 0, totalMembers = 0, embedded = 0;
  let totalDecisions = 0, totalTasks = 0, totalQuestions = 0, totalEvents = 0;
  let totalUpdated = 0;
  let maxId = lastId;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchMaxId = batch.reduce((max, m) => {
      const id = String(m.id);
      return id > max ? id : max;
    }, '0');

    log(`\nBatch ${i + 1}/${batches.length} (${batch.length} messages)`);

    // Enrich URLs in batch before sending to LLM
    if (enrichUrls) {
      const urlResult = await urlEnricher.enrichMessages(batch, config.urlEnrichment);
      if (urlResult.enriched > 0) {
        log(`  URLs enriched: ${urlResult.enriched}${urlResult.failed > 0 ? ` (${urlResult.failed} failed)` : ''}`);
      }
    }

    // Split overlap from primary messages (cap overlap to leave at least 1 primary message)
    const overlapCount = Math.min(batchMetas[i].overlapCount, batch.length - 1);
    const overlapMsgs = overlapCount > 0 ? batch.slice(0, overlapCount) : null;
    const primaryMsgs = overlapCount > 0 ? batch.slice(overlapCount) : batch;

    try {
      const llmConfig = {
        ...config.llm,
        maxRetries: config.llm?.maxRetries ?? 3,
        profileConfig,
        overlapMessages: overlapMsgs ? formatMessages(overlapMsgs) : null,
        contextSection,
        knownMembers,
      };
      const extracted = await llm.extractWithRetry(primaryMsgs, llmConfig, llmConfig.maxRetries);

      if (dryRun) {
        log(`  [DRY RUN] Extracted from LLM (not writing to DB):`);
        const summary = {};
        for (const key of ['members', 'facts', 'topics', 'decisions', 'tasks', 'questions', 'events']) {
          if (extracted[key]?.length) summary[key] = extracted[key].length;
        }
        log(`  ${JSON.stringify(summary)}`);
        continue;
      }
      const messageDate = primaryMsgs[0].timestamp?.split('T')[0] || new Date().toISOString().split('T')[0];
      const conversationId = batch[0]?.conversationId || null;

      const result = store.processExtraction(driver, extracted, messageDate, { sourceAgent: config.sourceAgent || null, conversationId });

      // Semantic dedup: if enabled, check new facts against existing embeddings
      if (config.dedup?.semantic && driver.capabilities.vectors && config.embedding?.enabled && result.insertedFactIds?.length > 0) {
        try {
          const duplicateIds = await store.semanticDedupFacts(
            driver, result.insertedFactIds, config.embedding, { threshold: config.dedup.threshold || 0.15 }
          );
          if (duplicateIds.size > 0) {
            store.removeFacts(driver, [...duplicateIds]);
            result.totalFacts -= duplicateIds.size;
            log(`  Semantic dedup: removed ${duplicateIds.size} duplicate fact(s)`);
          }
        } catch (err) {
          log(`  Semantic dedup failed (non-fatal): ${err.message}`);
        }
      }

      totalFacts += result.totalFacts;
      totalTopics += result.totalTopics;
      totalMembers += result.totalMembers;
      totalDecisions += result.totalDecisions;
      totalTasks += result.totalTasks;
      totalQuestions += result.totalQuestions;
      totalEvents += result.totalEvents;
      totalUpdated += result.totalUpdated || 0;

      const parts = [`${result.totalMembers} members`, `${result.totalFacts} facts`, `${result.totalTopics} topics`];
      if (result.totalDecisions) parts.push(`${result.totalDecisions} decisions`);
      if (result.totalTasks) parts.push(`${result.totalTasks} tasks`);
      if (result.totalQuestions) parts.push(`${result.totalQuestions} questions`);
      if (result.totalEvents) parts.push(`${result.totalEvents} events`);
      if (result.totalUpdated) parts.push(`${result.totalUpdated} updates`);
      log(`  Extracted: ${parts.join(', ')}`);

      // Advance cursor on success — commit immediately for crash recovery
      maxId = batchMaxId > maxId ? batchMaxId : maxId;
      if (!dryRun) store.setCursor(driver, maxId);
    } catch (err) {
      if (NoObjectGeneratedError.isInstance(err)) {
        log(`  Batch ${i + 1} structured output failed — model returned invalid object`);
        if (err.text) log(`  Raw response (first 200 chars): ${err.text.slice(0, 200)}`);
      } else {
        log(`  Batch ${i + 1} error: ${err.message}`);
      }
    }

    // Rate limit pause
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Update state
  if (!dryRun) {
    store.updateState(driver, {
      lastProcessedId: maxId,
      messagesProcessed: messages.length,
      factsExtracted: totalFacts,
      topicsExtracted: totalTopics,
      decisionsExtracted: totalDecisions,
      tasksExtracted: totalTasks,
      questionsExtracted: totalQuestions,
      eventsExtracted: totalEvents,
      updatesApplied: totalUpdated,
    });
  }

  // Generate roster file if configured
  if (!dryRun && rosterPath) {
    const fs = require('fs');
    const roster = store.generateRoster(driver, { memberLabels: profileConfig.memberLabels });
    fs.writeFileSync(rosterPath, roster.content);
    log(`Roster: ${roster.count} members → ${rosterPath}`);
  }

  // Auto-embed new records if configured
  const totalNew = totalFacts + totalTopics + totalMembers + totalDecisions + totalTasks + totalQuestions + totalEvents;
  if (!dryRun && !noEmbed && config.embedding?.enabled && driver.capabilities.vectors && totalNew > 0) {
    try {
      const embeddings = require('./embeddings');
      log('\nAuto-embedding new records...');
      const embedResult = await embeddings.backfill(driver, config.embedding);
      if (embedResult.ok) {
        embedded = embedResult.totalEmbedded;
        log(`Embedded: ${embedded} new vectors`);
      }
    } catch (err) {
      log(`Embedding failed (non-fatal): ${err.message}`);
    }
  }

  const summary = {
    ok: true,
    messages: messages.length,
    facts: totalFacts,
    topics: totalTopics,
    members: totalMembers,
    decisions: totalDecisions,
    tasks: totalTasks,
    questions: totalQuestions,
    events: totalEvents,
    updated: totalUpdated,
    embedded,
    maxId,
    dryRun,
    profile: profileName,
  };

  const doneParts = [`${totalFacts} facts`, `${totalTopics} topics`, `${totalMembers} members`];
  if (totalDecisions) doneParts.push(`${totalDecisions} decisions`);
  if (totalTasks) doneParts.push(`${totalTasks} tasks`);
  if (totalQuestions) doneParts.push(`${totalQuestions} questions`);
  if (totalEvents) doneParts.push(`${totalEvents} events`);
  if (totalUpdated) doneParts.push(`${totalUpdated} updates`);
  log(`\nDone: ${messages.length} messages → ${doneParts.join(', ')}`);
  if (dryRun) log('[DRY RUN — nothing written]');

  return summary;
}

module.exports = { run };
