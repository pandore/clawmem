/**
 * extractor.js — Core extraction pipeline. Adapter-agnostic, model-agnostic.
 */

const llm = require('./llm');
const store = require('./store');
const urlEnricher = require('./enrichers/url');

async function run(adapter, driver, config, options = {}) {
  const { dryRun = false, reprocess = false, rosterPath = null, enrichUrls = true } = options;
  const { batchSize = 40, minMessages = 5 } = config;

  const log = (msg) => console.log(msg);

  log(`[${new Date().toISOString()}] clawmem extraction`);
  log(`Memory DB: ${driver.dbPath}`);
  log(`Backend: ${driver.backend}`);
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

  // Batch messages
  const batches = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    batches.push(messages.slice(i, i + batchSize));
  }
  log(`Processing ${batches.length} batch(es)...`);

  let totalFacts = 0, totalTopics = 0, totalMembers = 0;
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

    if (dryRun) {
      log(`  [DRY RUN] First: ${batch[0].content?.substring(0, 80)}...`);
      log(`  [DRY RUN] Last:  ${batch[batch.length - 1].content?.substring(0, 80)}...`);
      continue;
    }

    try {
      const extracted = await llm.extract(batch, config.llm);
      const messageDate = batch[0].timestamp?.split('T')[0] || new Date().toISOString().split('T')[0];

      const result = store.processExtraction(driver, extracted, messageDate);
      totalFacts += result.totalFacts;
      totalTopics += result.totalTopics;
      totalMembers += result.totalMembers;

      log(`  Extracted: ${result.totalMembers} members, ${result.totalFacts} facts, ${result.totalTopics} topics`);

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
    });
  }

  // Generate roster file if configured
  if (!dryRun && rosterPath) {
    const fs = require('fs');
    const roster = store.generateRoster(driver);
    fs.writeFileSync(rosterPath, roster.content);
    log(`Roster: ${roster.count} members → ${rosterPath}`);
  }

  const summary = {
    ok: true,
    messages: messages.length,
    facts: totalFacts,
    topics: totalTopics,
    members: totalMembers,
    maxId,
    dryRun,
  };

  log(`\nDone: ${messages.length} messages → ${totalFacts} facts, ${totalTopics} topics, ${totalMembers} members`);
  if (dryRun) log('[DRY RUN — nothing written]');

  return summary;
}

module.exports = { run };
