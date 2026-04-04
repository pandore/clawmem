#!/usr/bin/env node
/**
 * lizardbrain CLI — Command-line interface for lizardbrain.
 *
 * Usage:
 *   lizardbrain init [--force]                    Create memory database
 *   lizardbrain extract [--dry-run] [--reprocess] Run extraction pipeline
 *   lizardbrain stats                             Show database statistics
 *   lizardbrain search <query>                    Search facts and topics
 *   lizardbrain who <keyword>                     Find members with expertise
 *
 * Configuration:
 *   Place a lizardbrain.json in your working directory, or use environment variables.
 *   See README.md for details.
 */

const path = require('path');
const lizardbrain = require('./index');
const config = require('./config');
const { createDriver, dbExists } = require('./driver');
const { PROFILES, PROFILE_NAMES, ALL_ENTITIES, getProfile, buildCustomProfile } = require('./profiles');
const { migrate } = require('./schema');

const args = process.argv.slice(2);
const command = args[0];

function flag(name) { return args.includes(`--${name}`); }
function arg(index) { return args[index]; }
function flagValue(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
}

async function main() {
  const configPath = flag('config')
    ? args[args.indexOf('--config') + 1]
    : null;

  const cfg = config.load(configPath);

  switch (command) {
    case 'init': {
      let profile = flagValue('profile') || cfg.profile;

      // Interactive profile selection if no profile specified and stdin is TTY
      if (!profile && process.stdin.isTTY) {
        profile = await promptProfile();
      }
      profile = profile || 'knowledge';

      const result = lizardbrain.init(cfg.memoryDbPath, { force: flag('force'), profile });
      console.log(result.message);
      break;
    }

    case 'extract': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      const adapter = createAdapter(cfg.source);
      const rosterOutput = flag('roster') ? args[args.indexOf('--roster') + 1] : (cfg.rosterPath || null);
      const result = await lizardbrain.extract(adapter, driver, cfg, {
        dryRun: flag('dry-run'),
        reprocess: flag('reprocess'),
        rosterPath: rosterOutput,
        enrichUrls: !flag('no-enrich'),
        noEmbed: flag('no-embed'),
        limit: flagValue('limit') ? parseInt(flagValue('limit')) : null,
        from: flagValue('from') || null,
      });

      driver.close();

      if (!result.ok) {
        console.error(`Extraction failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'stats': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      const stats = lizardbrain.query.getStats(driver);
      console.log('\n=== lizardbrain stats ===');
      console.log(`Profile:  ${stats.profile}`);
      console.log(`Members:  ${stats.members}`);
      console.log(`Facts:    ${stats.facts}`);
      console.log(`Topics:   ${stats.topics}`);
      if (stats.decisions > 0) console.log(`Decisions: ${stats.decisions}`);
      if (stats.tasks > 0) console.log(`Tasks:    ${stats.tasks}`);
      if (stats.questions > 0) console.log(`Questions: ${stats.questions}`);
      if (stats.events > 0) console.log(`Events:   ${stats.events}`);
      console.log(`\nDriver:   ${stats.driver}${stats.vectors ? ' (vectors enabled)' : ''}`);
      console.log(`Search:   ${stats.vectors ? 'hybrid (FTS5 + kNN + RRF)' : 'FTS5'}`);

      if (stats.vectors) {
        const embeddings = require('./embeddings');
        const estats = embeddings.getEmbeddingStats(driver);
        if (estats.dimensions > 0) {
          console.log(`\nEmbeddings:`);
          console.log(`  model:      ${estats.model}`);
          console.log(`  dimensions: ${estats.dimensions}`);
          console.log(`  facts:      ${estats.facts.embedded}/${estats.facts.total}`);
          console.log(`  topics:     ${estats.topics.embedded}/${estats.topics.total}`);
          console.log(`  members:    ${estats.members.embedded}/${estats.members.total}`);
          if (estats.decisions.total > 0) console.log(`  decisions:  ${estats.decisions.embedded}/${estats.decisions.total}`);
          if (estats.tasks.total > 0) console.log(`  tasks:      ${estats.tasks.embedded}/${estats.tasks.total}`);
          if (estats.questions.total > 0) console.log(`  questions:  ${estats.questions.embedded}/${estats.questions.total}`);
          if (estats.events.total > 0) console.log(`  events:     ${estats.events.embedded}/${estats.events.total}`);
        }
      }

      console.log(`\nMessages processed: ${stats.messagesProcessed}`);
      console.log(`Last processed ID:  ${stats.lastProcessedId}`);
      console.log(`Last run:           ${stats.lastRun}`);
      console.log('');
      driver.close();
      break;
    }

    case 'search': {
      const queryText = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
      if (!queryText) {
        console.log('Usage: lizardbrain search <query>');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      const { search: hybridSearch } = require('./search');
      const embCfg = (cfg.embedding?.enabled && cfg.embedding?.apiKey) ? cfg.embedding : null;
      const result = await hybridSearch(driver, queryText, {
        limit: parseInt(args[args.indexOf('--limit') + 1]) || 10,
        ftsOnly: flag('fts-only'),
        embeddingConfig: embCfg,
        conversationId: flagValue('conversation') || null,
      });

      if (flag('json')) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n[${result.mode} search]\n`);
        for (const r of result.results) {
          console.log(`  [${r.source}] ${r.text}`);
          if (r.member) console.log(`    — ${r.member}`);
          if (r.confidence) console.log(`    confidence: ${r.confidence}`);
        }
        if (result.results.length === 0) console.log(`No results for "${queryText}"`);
        console.log('');
      }
      driver.close();
      break;
    }

    case 'embed': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }
      if (!cfg.embedding?.enabled) {
        console.log('Embedding not configured. Add an "embedding" block to lizardbrain.json with enabled: true.');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      if (!driver.capabilities.vectors) {
        console.log('Vector search requires better-sqlite3 + sqlite-vec. Install: npm install better-sqlite3 sqlite-vec');
        driver.close();
        process.exit(1);
      }
      const embeddings = require('./embeddings');

      if (flag('stats')) {
        const estats = embeddings.getEmbeddingStats(driver);
        console.log('\n=== embedding stats ===');
        console.log(`Model:      ${estats.model}`);
        console.log(`Dimensions: ${estats.dimensions}`);
        console.log(`Facts:      ${estats.facts.embedded}/${estats.facts.total}`);
        console.log(`Topics:     ${estats.topics.embedded}/${estats.topics.total}`);
        console.log(`Members:    ${estats.members.embedded}/${estats.members.total}`);
        if (estats.decisions.total > 0) console.log(`Decisions:  ${estats.decisions.embedded}/${estats.decisions.total}`);
        if (estats.tasks.total > 0) console.log(`Tasks:      ${estats.tasks.embedded}/${estats.tasks.total}`);
        if (estats.questions.total > 0) console.log(`Questions:  ${estats.questions.embedded}/${estats.questions.total}`);
        if (estats.events.total > 0) console.log(`Events:     ${estats.events.embedded}/${estats.events.total}`);
        console.log('');
      } else {
        const result = await embeddings.backfill(driver, cfg.embedding, { rebuild: flag('rebuild') });
        if (!result.ok) {
          console.error(`Embedding failed: ${result.error}`);
          driver.close();
          process.exit(1);
        }
      }
      driver.close();
      break;
    }

    case 'who': {
      const keyword = args.slice(1).join(' ');
      if (!keyword) {
        console.log('Usage: lizardbrain who <keyword>');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const members = lizardbrain.query.whoKnows(driver, keyword);
      driver.close();

      if (members.length > 0) {
        console.log(`\nMembers who know about "${keyword}":`);
        for (const m of members) {
          console.log(`  ${m.display_name}${m.username ? ` (@${m.username})` : ''}`);
          if (m.expertise) console.log(`    expertise: ${m.expertise}`);
          if (m.projects) console.log(`    projects: ${m.projects}`);
        }
      } else {
        console.log(`No members found with "${keyword}" expertise`);
      }
      console.log('');
      break;
    }

    case 'roster': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      // Read profile from DB meta to use correct roster labels
      const profileMeta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'");
      const rosterProfile = profileMeta[0]?.value || 'knowledge';
      const rosterLabels = getProfile(rosterProfile).memberLabels;
      const roster = lizardbrain.query.generateRoster(driver, { memberLabels: rosterLabels });
      driver.close();

      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
      if (outputPath) {
        const fs = require('fs');
        fs.writeFileSync(outputPath, roster.content);
        console.log(`Roster: ${roster.count} members → ${outputPath}`);
      } else {
        process.stdout.write(roster.content);
      }
      break;
    }

    case 'health': {
      const health = { healthy: true, issues: [] };

      // DB check (read-only — no migrate)
      if (dbExists(cfg.memoryDbPath)) {
        let driver;
        try {
          driver = createDriver(cfg.memoryDbPath);

          const fs = require('fs');
          const dbStat = fs.statSync(cfg.memoryDbPath);
          const store = require('./store');
          const stats = store.getStats(driver);
          const state = store.getState(driver);

          // Schema version
          const versionRow = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
          const schemaVersion = versionRow[0]?.value || 'unknown';

          health.db = {
            path: cfg.memoryDbPath,
            sizeBytes: dbStat.size,
            schemaVersion,
            profile: stats.profile,
            driver: stats.driver,
            vectors: stats.vectors,
            entities: {
              members: stats.members,
              facts: stats.facts,
              topics: stats.topics,
              decisions: stats.decisions,
              tasks: stats.tasks,
              questions: stats.questions,
              events: stats.events,
            },
          };

          health.extraction = {
            lastProcessedId: state?.last_processed_id || '0',
            lastRunAt: state?.last_run_at || null,
            totalMessagesProcessed: parseInt(state?.total_messages_processed) || 0,
          };

          // Stale cursor check (no run in 48 hours)
          if (state?.last_run_at) {
            const lastRun = new Date(state.last_run_at);
            const hoursSinceRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
            if (hoursSinceRun > 48) {
              health.issues.push(`Extraction stale: last run ${Math.round(hoursSinceRun)}h ago`);
            }
          }
        } catch (err) {
          health.healthy = false;
          health.issues.push(`DB error: ${err.message}`);
        } finally {
          if (driver) driver.close();
        }
      } else {
        health.healthy = false;
        health.db = null;
        health.issues.push('Database not found');
      }

      // LLM connectivity
      if (cfg.llm?.baseUrl && cfg.llm?.apiKey) {
        try {
          const { isAnthropic } = require('./llm');
          const isAnth = isAnthropic(cfg.llm);
          const base = cfg.llm.baseUrl.replace(/\/+$/, '');
          const url = isAnth
            ? (base.endsWith('/v1') ? base + '/messages' : base + '/v1/messages')
            : base + '/models';
          const headers = isAnth
            ? { 'x-api-key': cfg.llm.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
            : { 'Authorization': `Bearer ${cfg.llm.apiKey}` };
          const fetchOpts = { headers, signal: AbortSignal.timeout(5000) };
          if (isAnth) {
            // Validate auth without billing: send empty messages array → 400 = auth OK, 401 = bad key
            fetchOpts.method = 'POST';
            fetchOpts.body = JSON.stringify({ model: cfg.llm.model || 'claude-sonnet-4-6', max_tokens: 1, messages: [] });
          }
          const res = await fetch(url, fetchOpts);
          // For Anthropic: 400 (bad request) means auth passed — endpoint is reachable
          const reachable = isAnth ? (res.status !== 401 && res.status !== 403) : res.ok;
          health.llm = { reachable, status: res.status, provider: isAnth ? 'anthropic' : 'openai-compatible' };
          if (!reachable) health.issues.push(`LLM endpoint returned ${res.status}`);
        } catch (err) {
          health.llm = { reachable: false, error: err.message };
          health.issues.push(`LLM unreachable: ${err.message}`);
        }
      } else {
        health.llm = { configured: false };
      }

      // Embedding connectivity
      if (cfg.embedding?.enabled && cfg.embedding?.baseUrl && cfg.embedding?.apiKey) {
        try {
          const url = cfg.embedding.baseUrl.replace(/\/+$/, '') + '/models';
          const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${cfg.embedding.apiKey}` },
            signal: AbortSignal.timeout(5000),
          });
          health.embedding = { reachable: res.ok, status: res.status };
          if (!res.ok) health.issues.push(`Embedding endpoint returned ${res.status}`);
        } catch (err) {
          health.embedding = { reachable: false, error: err.message };
          health.issues.push(`Embedding unreachable: ${err.message}`);
        }
      } else {
        health.embedding = { configured: false };
      }

      if (health.issues.length > 0) health.healthy = false;

      if (flag('json') || !process.stdout.isTTY) {
        console.log(JSON.stringify(health, null, 2));
      } else {
        console.log(`\n=== lizardbrain health ===`);
        console.log(`Status: ${health.healthy ? 'HEALTHY' : 'UNHEALTHY'}`);
        if (health.db) {
          console.log(`\nDatabase: ${health.db.path} (${(health.db.sizeBytes / 1024).toFixed(0)} KB)`);
          console.log(`  Schema: v${health.db.schemaVersion} | Profile: ${health.db.profile} | Driver: ${health.db.driver}`);
          const e = health.db.entities;
          console.log(`  Entities: ${e.members} members, ${e.facts} facts, ${e.topics} topics, ${e.decisions} decisions, ${e.tasks} tasks`);
          console.log(`  Extraction: cursor=${health.extraction.lastProcessedId}, last run=${health.extraction.lastRunAt || 'never'}, ${health.extraction.totalMessagesProcessed} messages`);
        }
        console.log(`  LLM: ${health.llm?.reachable ? 'reachable' : health.llm?.configured === false ? 'not configured' : 'unreachable'}`);
        console.log(`  Embedding: ${health.embedding?.reachable ? 'reachable' : health.embedding?.configured === false ? 'not configured' : 'unreachable'}`);
        if (health.issues.length > 0) {
          console.log(`\nIssues:`);
          for (const issue of health.issues) console.log(`  - ${issue}`);
        }
        console.log('');
      }

      process.exit(health.healthy ? 0 : 1);
      break;
    }

    case 'prune-embeddings': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      if (!driver.capabilities.vectors) {
        console.log('Vector search requires better-sqlite3 + sqlite-vec.');
        driver.close();
        process.exit(1);
      }
      const embeddings = require('./embeddings');
      const result = embeddings.prune(driver, {
        orphaned: flag('orphaned'),
        stale: flag('stale'),
        model: flagValue('model') || null,
      });
      console.log(`Pruned ${result.totalPruned} embedding(s)`);
      driver.close();
      break;
    }

    case 'dedup': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }
      if (!cfg.embedding?.enabled) {
        console.log('Embedding not configured. Add an "embedding" block to lizardbrain.json with enabled: true.');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      if (!driver.capabilities.vectors) {
        console.log('Vector search requires better-sqlite3 + sqlite-vec.');
        driver.close();
        process.exit(1);
      }

      const threshold = parseFloat(flagValue('threshold')) || cfg.dedup?.threshold || 0.15;
      const doDryRun = flag('dry-run');
      const store = require('./store');
      const embeddings = require('./embeddings');

      console.log('Ensuring all facts are embedded...');
      await embeddings.backfill(driver, cfg.embedding);

      const allFacts = driver.read('SELECT id FROM facts ORDER BY id ASC');
      const factIds = allFacts.map(r => r.id);
      console.log(`Scanning ${factIds.length} facts for semantic duplicates (threshold: ${threshold})...`);

      const duplicates = await store.semanticDedupFacts(driver, factIds, cfg.embedding, { threshold });

      if (duplicates.size === 0) {
        console.log('No semantic duplicates found.');
      } else {
        console.log(`Found ${duplicates.size} duplicate(s).`);
        if (doDryRun) {
          for (const id of duplicates) {
            const fact = driver.read(`SELECT id, content FROM facts WHERE id = ${parseInt(id)}`);
            if (fact.length > 0) console.log(`  [${fact[0].id}] ${fact[0].content.substring(0, 80)}...`);
          }
          console.log('[DRY RUN — nothing deleted]');
        } else {
          store.removeFacts(driver, [...duplicates]);
          console.log(`Removed ${duplicates.size} duplicate fact(s).`);
        }
      }
      driver.close();
      break;
    }

    case 'reset-cursor': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }
      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);
      const targetId = flagValue('to') || '0';
      const store = require('./store');
      const before = store.getState(driver);
      store.setCursor(driver, targetId);
      console.log(`Cursor reset: ${before?.last_processed_id || '0'} → ${targetId}`);
      driver.close();
      break;
    }

    case 'serve': {
      // Require better-sqlite3 for MCP mode
      try {
        require('better-sqlite3');
      } catch (e) {
        console.error('MCP server requires better-sqlite3. Install it with: npm install better-sqlite3');
        process.exit(1);
      }
      try {
        require('@modelcontextprotocol/sdk/server/mcp.js');
      } catch (e) {
        console.error('MCP server requires @modelcontextprotocol/sdk. Install it with: npm install @modelcontextprotocol/sdk zod');
        process.exit(1);
      }

      if (!dbExists(cfg.memoryDbPath)) {
        console.error('Memory database not found. Run `lizardbrain init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      migrate(driver);

      if (driver.backend !== 'better-sqlite3') {
        console.error('MCP server requires better-sqlite3 driver.');
        driver.close();
        process.exit(1);
      }

      const { createServer } = require('./mcp');
      const mcp = createServer({ driver, config: cfg });

      process.on('SIGINT', () => { mcp.close(); process.exit(0); });
      process.on('SIGTERM', () => { mcp.close(); process.exit(0); });

      // All logging must go to stderr in stdio mode
      console.error(`lizardbrain MCP server v${require('../package.json').version}`);
      console.error(`Database: ${cfg.memoryDbPath}`);
      console.error(`Driver: ${driver.backend}, vectors: ${driver.capabilities.vectors}`);

      await mcp.connect();
      break;
    }

    default:
      console.log(`lizardbrain — Persistent memory for group chats

Commands:
  init [--force] [--profile <name>]   Create memory database
  extract [--dry-run] [--reprocess]   Run extraction pipeline
    [--limit N] [--from <id>]
  embed [--stats] [--rebuild]         Manage vector embeddings
  stats                               Show database statistics
  health [--json]                     Check system health
  search <query> [--json] [--fts-only] [--limit N] [--conversation <id>]  Search knowledge
  who <keyword>                       Find members by expertise
  roster [--output path]              Generate member roster
  reset-cursor [--to <id>]            Reset extraction cursor
  dedup [--dry-run] [--threshold <n>]  Find and remove semantic duplicate facts
  prune-embeddings [--orphaned] [--stale] [--model <name>]  Clean up embeddings
  serve                               Start MCP server (stdio transport)

Profiles:
  knowledge  Community, interest group (members, facts, topics)
  team       Team, workplace (+ decisions, tasks)
  project    Client, project group (+ decisions, tasks, questions)
  full       Everything (all entity types)
  custom     Pick your own entity types

Options:
  --config <path>                   Path to lizardbrain.json config file
  --profile <name>                  Set extraction profile (knowledge, team, project, full)
  --roster <path>                   Generate roster after extraction
  --no-enrich                       Skip URL metadata enrichment
  --no-embed                        Skip auto-embedding after extraction

Context injection:
  Configure in lizardbrain.json: "context": { "enabled": true, "tokenBudget": 1000 }
  tokenBudget controls how much existing knowledge is injected into the LLM prompt.

Environment variables:
  LIZARDBRAIN_DB_PATH               Path to memory database
  LIZARDBRAIN_PROFILE               Extraction profile
  LIZARDBRAIN_LLM_PROVIDER           LLM provider (anthropic, openai, or auto-detect)
  LIZARDBRAIN_LLM_BASE_URL          LLM API base URL
  LIZARDBRAIN_LLM_API_KEY           LLM API key
  LIZARDBRAIN_LLM_MODEL             LLM model name
  LIZARDBRAIN_EMBEDDING_BASE_URL    Embedding API base URL
  LIZARDBRAIN_EMBEDDING_API_KEY     Embedding API key
  LIZARDBRAIN_EMBEDDING_MODEL       Embedding model name
  LIZARDBRAIN_SOURCE_AGENT          Source agent identifier (multi-agent)
`);
  }
}

function promptProfile() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    console.log('\nWhat kind of group is this?\n');
    console.log('  1) knowledge  — community, interest group (members, facts, topics)');
    console.log('  2) team       — team, workplace (+ decisions, tasks)');
    console.log('  3) project    — client, project group (+ decisions, tasks, questions)');
    console.log('  4) full       — everything (all entity types)');
    console.log('');

    rl.question('> ', (answer) => {
      rl.close();
      const choice = answer.trim();
      const map = { '1': 'knowledge', '2': 'team', '3': 'project', '4': 'full',
        'knowledge': 'knowledge', 'team': 'team', 'project': 'project', 'full': 'full' };
      resolve(map[choice] || 'knowledge');
    });
  });
}

function createAdapter(sourceConfig) {
  const type = sourceConfig.type || 'sqlite';

  switch (type) {
    case 'sqlite':
      return lizardbrain.adapters.sqlite.create(sourceConfig);
    case 'jsonl':
      return lizardbrain.adapters.jsonl.create(sourceConfig);
    case 'stdin':
      return lizardbrain.adapters.stdin.create(sourceConfig);
    case 'custom':
      if (sourceConfig.adapterPath) {
        const custom = require(path.resolve(sourceConfig.adapterPath));
        return typeof custom.create === 'function' ? custom.create(sourceConfig) : custom;
      }
      throw new Error('Custom adapter requires "adapterPath" in source config');
    default:
      throw new Error(`Unknown adapter type: ${type}. Use sqlite, jsonl, stdin, or custom.`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
