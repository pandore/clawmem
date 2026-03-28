#!/usr/bin/env node
/**
 * clawmem CLI — Command-line interface for clawmem.
 *
 * Usage:
 *   clawmem init [--force]                    Create memory database
 *   clawmem extract [--dry-run] [--reprocess] Run extraction pipeline
 *   clawmem stats                             Show database statistics
 *   clawmem search <query>                    Search facts and topics
 *   clawmem who <keyword>                     Find members with expertise
 *
 * Configuration:
 *   Place a clawmem.json in your working directory, or use environment variables.
 *   See README.md for details.
 */

const path = require('path');
const clawmem = require('./index');
const config = require('./config');
const { createDriver, dbExists } = require('./driver');

const args = process.argv.slice(2);
const command = args[0];

function flag(name) { return args.includes(`--${name}`); }
function arg(index) { return args[index]; }

async function main() {
  const configPath = flag('config')
    ? args[args.indexOf('--config') + 1]
    : null;

  const cfg = config.load(configPath);

  switch (command) {
    case 'init': {
      const result = clawmem.init(cfg.memoryDbPath, { force: flag('force') });
      console.log(result.message);
      break;
    }

    case 'extract': {
      if (!dbExists(cfg.memoryDbPath)) {
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const adapter = createAdapter(cfg.source);
      const rosterOutput = flag('roster') ? args[args.indexOf('--roster') + 1] : (cfg.rosterPath || null);
      const result = await clawmem.extract(adapter, driver, cfg, {
        dryRun: flag('dry-run'),
        reprocess: flag('reprocess'),
        rosterPath: rosterOutput,
        enrichUrls: !flag('no-enrich'),
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
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const stats = clawmem.query.getStats(driver);
      driver.close();

      console.log('\n=== clawmem stats ===');
      console.log(`Members:  ${stats.members}`);
      console.log(`Facts:    ${stats.facts}`);
      console.log(`Topics:   ${stats.topics}`);
      console.log(`\nMessages processed: ${stats.messagesProcessed}`);
      console.log(`Last processed ID:  ${stats.lastProcessedId}`);
      console.log(`Last run:           ${stats.lastRun}`);
      console.log('');
      break;
    }

    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.log('Usage: clawmem search <query>');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const facts = clawmem.query.searchFacts(driver, query);
      const topics = clawmem.query.searchTopics(driver, query);
      driver.close();

      if (facts.length > 0) {
        console.log('\n--- Facts ---');
        for (const f of facts) {
          console.log(`  [${f.category}] ${f.content}`);
          if (f.source) console.log(`    — ${f.source}`);
        }
      }
      if (topics.length > 0) {
        console.log('\n--- Topics ---');
        for (const t of topics) {
          console.log(`  ${t.name}: ${t.summary}`);
          if (t.participants) console.log(`    participants: ${t.participants}`);
        }
      }
      if (facts.length === 0 && topics.length === 0) {
        console.log(`No results for "${query}"`);
      }
      console.log('');
      break;
    }

    case 'who': {
      const keyword = args.slice(1).join(' ');
      if (!keyword) {
        console.log('Usage: clawmem who <keyword>');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const members = clawmem.query.whoKnows(driver, keyword);
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
        console.log('Memory database not found. Run `clawmem init` first.');
        process.exit(1);
      }

      const driver = createDriver(cfg.memoryDbPath);
      const roster = clawmem.query.generateRoster(driver);
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

    default:
      console.log(`clawmem — Lightweight structured memory for community chats

Commands:
  init [--force]                    Create memory database
  extract [--dry-run] [--reprocess] Run extraction pipeline
  stats                             Show database statistics
  search <query>                    Search facts and topics (FTS)
  who <keyword>                     Find members by expertise
  roster [--output path]            Generate member roster as markdown

Options:
  --config <path>                   Path to clawmem.json config file
  --roster <path>                   Generate roster after extraction
  --no-enrich                       Skip URL metadata enrichment

Environment variables:
  CLAWMEM_DB_PATH                   Path to memory database
  CLAWMEM_LLM_BASE_URL             LLM API base URL (OpenAI-compatible)
  CLAWMEM_LLM_API_KEY              LLM API key
  CLAWMEM_LLM_MODEL                LLM model name
`);
  }
}

function createAdapter(sourceConfig) {
  const type = sourceConfig.type || 'sqlite';

  switch (type) {
    case 'sqlite':
      return clawmem.adapters.sqlite.create(sourceConfig);
    case 'jsonl':
      return clawmem.adapters.jsonl.create(sourceConfig);
    case 'custom':
      if (sourceConfig.adapterPath) {
        const custom = require(path.resolve(sourceConfig.adapterPath));
        return typeof custom.create === 'function' ? custom.create(sourceConfig) : custom;
      }
      throw new Error('Custom adapter requires "adapterPath" in source config');
    default:
      throw new Error(`Unknown adapter type: ${type}. Use sqlite, jsonl, or custom.`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
