/**
 * extractor.js — Core extraction pipeline. Adapter-agnostic, model-agnostic.
 */

const llm = require('./llm');
const { formatMessages } = llm;
const store = require('./store');
const urlEnricher = require('./enrichers/url');
const { getProfile } = require('./profiles');

async function run(adapter, driver, config, options = {}) {
  const { dryRun = false, reprocess = false, rosterPath = null, enrichUrls = true, noEmbed = false } = options;
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
  const lastId = state?.last_processed_id || '0';
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

  // Batch messages with optional overlap
  const batchOverlap = config.batchOverlap || 0;
  const overlap = Math.min(batchOverlap, Math.floor(batchSize / 2));
  const step = overlap > 0 ? batchSize - overlap : batchSize;
  const batches = [];
  const batchMetas = [];
  for (let i = 0; i < messages.length; i += step) {
    batches.push(messages.slice(i, i + batchSize));
    batchMetas.push({ overlapCount: (i === 0) ? 0 : overlap });
  }
  if (overlap > 0) log(`Batch overlap: ${overlap} messages`);
  log(`Processing ${batches.length} batch(es)...`);

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

    if (dryRun) {
      log(`  [DRY RUN] First: ${primaryMsgs[0].content?.substring(0, 80)}...`);
      log(`  [DRY RUN] Last:  ${primaryMsgs[primaryMsgs.length - 1].content?.substring(0, 80)}...`);
      if (overlapMsgs) log(`  [DRY RUN] Overlap: ${overlapMsgs.length} context messages`);
      continue;
    }

    try {
      const llmConfig = {
        ...config.llm,
        profileConfig,
        overlapMessages: overlapMsgs ? formatMessages(overlapMsgs) : null,
        contextSection,
      };
      const extracted = await llm.extract(primaryMsgs, llmConfig);
      const messageDate = primaryMsgs[0].timestamp?.split('T')[0] || new Date().toISOString().split('T')[0];

      const result = store.processExtraction(driver, extracted, messageDate);
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

      // Only advance cursor on success
      maxId = batchMaxId > maxId ? batchMaxId : maxId;
    } catch (err) {
      log(`  Batch ${i + 1} error: ${err.message}`);
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
