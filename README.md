# LizardBrain
**Give your group chat a brain.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.8.0-orange.svg)](package.json)

Your group chat has years of knowledge buried in thousands of messages. Who knows what, what was decided, what tasks were assigned, what questions were answered -- it's all there, but impossible to find.

LizardBrain reads your chat messages, extracts the important stuff using any LLM, and stores it in a searchable database. Run it on a cron, and your AI agent always knows what your group has been talking about.

---

## What problems does it solve?

**"Who on our team knows about Kubernetes?"** -- Instead of asking around, search your memory database. LizardBrain tracks what each member talks about and builds expertise profiles automatically.

**"What did we decide about the database migration?"** -- Decisions made in chat are captured with context and participants. No more scrolling through months of messages.

**"What's the status of the API rewrite?"** -- Tasks, assignments, and deadlines mentioned in chat are extracted and searchable.

**"Summarize what our community knows about RAG pipelines"** -- Facts, opinions, and resources shared by members are stored with confidence scores and attribution.

---

## How it works

Point LizardBrain at your chat messages (SQLite, JSONL, or any custom source). It sends batches to a cheap LLM, which extracts structured knowledge. Everything goes into SQLite with full-text search, and optionally vector search for semantic matching.

```
Messages  -->  LLM extracts knowledge  -->  SQLite + search indexes
```

You choose a **profile** that matches your group type, and LizardBrain adjusts what it looks for:

| Profile | What it extracts | Best for |
|---------|-----------------|----------|
| **knowledge** | Members, facts, topics | Communities, interest groups, Discord servers |
| **team** | + decisions, tasks | Teams, workplaces, Slack channels |
| **project** | + questions (no topics) | Client work, project groups, contractor chats |
| **full** | All 7 entity types | When you want everything |

---

## Quick start

```bash
git clone https://github.com/pandore/lizardbrain && cd lizardbrain

cp examples/lizardbrain.json lizardbrain.json
# Edit lizardbrain.json -- set your chat DB path and LLM provider

node src/cli.js init              # Asks which profile fits your group
LIZARDBRAIN_LLM_API_KEY=your-key node src/cli.js extract

# Now query your group's knowledge
node src/cli.js search "RAG pipeline"
node src/cli.js who "python"
node src/cli.js stats
```

Set it up on a cron and forget about it:

```bash
0 */2 * * * cd /path/to/project && LIZARDBRAIN_LLM_API_KEY=key node src/cli.js extract >> /tmp/lizardbrain.log 2>&1
```

---

## What gets extracted

Depending on your profile, LizardBrain pulls out up to 7 types of structured knowledge:

| Entity | What it captures | Example |
|--------|-----------------|---------|
| **Members** | Who's in the chat, what they know, what they work on | Alice -- RAG, LangChain \| builds: pipeline |
| **Facts** | Claims, insights, recommendations with confidence scores | "LangChain works well with chunk size 512" (0.9) |
| **Topics** | Discussion threads with summaries | "RAG Pipeline Comparison" -- Alice, Bob |
| **Decisions** | What was decided, by whom, and why | "Use PostgreSQL instead of MySQL" (agreed) |
| **Tasks** | Action items with assignees and deadlines | "Migrate user service" -- Bob, due Apr 15 |
| **Questions** | Questions asked and answers given | "Best way to handle migrations?" -- answered |
| **Events** | Meetings, deadlines, gatherings | "Architecture Review" -- Apr 1, Zoom |

Everything is deduplicated automatically -- if the LLM extracts the same fact twice (even rephrased), LizardBrain catches it.

### Entity updates

Decisions, tasks, and questions evolve over time. A decision starts as "proposed" and becomes "agreed." A task goes from "open" to "done." A question gets answered.

LizardBrain handles this automatically when context injection is enabled. The LLM sees existing open entities and can update their status instead of creating duplicates:

```
Run 1: Decision extracted — "Use PostgreSQL" (proposed)
Run 2: LLM sees the decision in context, messages confirm it → status updated to "agreed"
```

No manual intervention needed. The LLM references entity IDs from context and outputs updates alongside new extractions.

---

## Why LizardBrain?

**Use any LLM.** OpenAI, Anthropic, Gemini, Groq, Ollama, Mistral -- uses the [Vercel AI SDK](https://sdk.vercel.ai/) with Zod-validated structured output, so you get typed extraction results or a clear error, never silently broken JSON. Any OpenAI-compatible endpoint works, plus native Anthropic support.

**Zero dependencies to start.** The core tier uses Node.js and the `sqlite3` CLI that's already on your machine. No `npm install` needed.

**Scales up when you want.** Add `better-sqlite3` + `sqlite-vec` for hybrid vector search that combines keyword matching with semantic similarity via Reciprocal Rank Fusion.

**Runs incrementally.** Tracks where it left off. Each run only processes new messages, so it's cheap and fast even on large chats.

**Context-aware.** The LLM sees existing knowledge from previous runs. Decisions get confirmed, tasks get closed, questions get answered -- entities evolve naturally across extraction runs.

**Links get context.** When someone shares a GitHub repo or web page, LizardBrain fetches metadata (stars, descriptions, titles) before sending to the LLM, so extracted facts are richer.

**Built for agents.** Generate a compact member roster (~30 tokens per person) designed to fit in an agent's system prompt. At 100 members, that's ~3,000 tokens.

**MCP server built in.** Run `lizardbrain serve` and any MCP-compatible client (Claude Desktop, Cursor, custom agents) can read, search, and write knowledge directly. No shell-outs, no parsing CLI output — agents talk to LizardBrain over the Model Context Protocol.

---

## v0.7 features

<details>
<summary>Vercel AI SDK for structured output</summary>

Replaced raw `fetch()` calls with the [Vercel AI SDK](https://sdk.vercel.ai/) (`ai` v6). LLM responses are now validated against dynamic Zod schemas built from your profile's entity types — you get a typed object or a clear error, never silently broken JSON.

- **Structured output** -- `generateText` + `Output.object({ schema })` with per-profile Zod schemas
- **Built-in retries** -- SDK handles rate limits (429) and transient errors with exponential backoff
- **Graceful fallback** -- if structured output fails, falls back to JSON repair for resilience
- **Provider selection** -- `@ai-sdk/openai-compatible` for any endpoint, `@ai-sdk/anthropic` (optional) for native Anthropic support with custom base URLs
- **`promptTemplate` deprecated** -- still works (plain text mode + JSON repair) but profiles with Zod schemas are recommended

</details>

<details>
<summary>MCP server</summary>

Run `lizardbrain serve` and any MCP-compatible client (Claude Desktop, Cursor, custom agents) can read, search, and write knowledge directly. 7 tools: `get_context`, `search`, `who_knows`, `get_stats`, `add_knowledge`, `ingest`, `update_entity`.

</details>

## v0.6 features (included in v0.7)

<details>
<summary>Security hardening</summary>

- SQL escaping strips null bytes and properly handles single quotes via `esc()`
- FTS5 queries are sanitized: operators (`*`, `NEAR`, `NOT`, `OR`, `AND`, `"`, `{`, `}`, `(`, `)`, `:`, `-`) are stripped before reaching MATCH clauses
- CLI driver passes SQL via stdin (not shell arguments) to prevent shell metacharacter injection
- **Credential leakage protection** -- 12 regex patterns block API keys, tokens, passwords, JWTs, and connection strings from being stored as facts
- **Generic member filter** -- rejects bot/placeholder names ("AI Agent", "Bot", "System", "Content Agent") via exact match and pattern matching

</details>

<details>
<summary>Extraction pipeline improvements</summary>

- **Native Anthropic API** -- auto-detects `anthropic.com` endpoints or use explicit `provider: 'anthropic'`. Also works via OpenRouter for Anthropic models.
- **stdin adapter** -- `cat messages.jsonl | lizardbrain extract --source stdin` for piped input from any source
- **JSON repair** -- truncated LLM output (trailing commas, unclosed brackets, code fences) is automatically repaired as a fallback when structured output fails
- **Per-batch cursor commits** -- cursor advances after each successful batch, so a crash mid-run doesn't lose all progress
- **LLM retry with backoff** -- transient errors (429, 5xx, network) automatically retry up to 3 times via AI SDK's built-in retry
- **`--limit N`** -- limit extraction to N batches for testing or cost control
- **Enhanced `--dry-run`** -- now calls the LLM and shows what would be extracted, without writing to the database
- **`reset-cursor` / `--from`** -- reprocess from a specific message ID
- **Known-member injection** -- the 100 most recently active members are injected into the LLM prompt so it skips re-extracting unchanged members, saving tokens

</details>

<details>
<summary>Multi-agent support</summary>

Track which agent or pipeline produced each extraction via `source_agent`:

```bash
LIZARDBRAIN_SOURCE_AGENT=discord-bot node src/cli.js extract
```

All extracted entities (facts, decisions, tasks) are tagged with the source agent. Useful when multiple bots or pipelines write to the same database.

</details>

<details>
<summary>Operational tooling</summary>

- **`health [--json]`** -- check database, LLM connectivity, embedding endpoint, source adapter, disk usage
- **`prune-embeddings`** -- clean up orphaned, stale, or model-specific embeddings from vector tables
- **`reset-cursor [--to <id>]`** -- reset the extraction cursor to reprocess messages

</details>

<details>
<summary>Performance</summary>

- 9 database indexes on frequently queried columns (member lookups, context queries, FK joins, recency sorts)
- Dedup queries merged from 2 reads to 1 read per entity (~50% fewer DB round-trips during extraction)
- Known-members prompt capped at 100 most recent (configurable) to bound token usage

</details>

---

## Configuration

Create `lizardbrain.json` in your working directory:

```json
{
  "memoryDbPath": "./lizardbrain.db",
  "profile": "knowledge",

  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5-nano"
  },

  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": {
      "id": "id",
      "content": "content",
      "sender": "sender_name",
      "timestamp": "created_at"
    }
  }
}
```

API key via `.env` file, environment variable (`LIZARDBRAIN_LLM_API_KEY`), or directly in config.

<details>
<summary>Batch overlap (split conversation fix)</summary>

When a discussion spans two batches (e.g., messages 35-45 with batchSize=40), the LLM sees half in each batch with no continuity. Batch overlap fixes this by including trailing messages from the previous batch as read-only context:

```json
{
  "batchOverlap": 5
}
```

With `batchSize: 40` and `batchOverlap: 5`:
- Batch 1: messages 1-40
- Batch 2: messages 36-75 (36-40 included as context, extraction starts at 41)
- Batch 3: messages 71-100

Overlap messages are clearly marked in the LLM prompt as "already processed — do NOT extract from these." Dedup catches any accidental re-extraction as a safety net.

Default: `0` (no overlap, identical to v0.4 behavior).

</details>

<details>
<summary>Context injection (cross-run awareness)</summary>

Without context, each extraction run is stateless — the LLM doesn't know about decisions, tasks, or questions from previous runs. Enable context injection to fix this:

```json
{
  "context": {
    "enabled": true,
    "tokenBudget": 1000,
    "recencyDays": 30,
    "maxItems": {
      "decisions": 5,
      "tasks": 10,
      "questions": 5,
      "facts": 5,
      "topics": 3
    }
  }
}
```

Before the extraction loop, LizardBrain queries the DB for recent and active entities (open decisions, pending tasks, unanswered questions) and includes them in every LLM prompt. The LLM can then output updates to existing entities alongside new ones.

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable context injection |
| `tokenBudget` | `1000` | Max tokens (~4000 chars) for context section |
| `recencyDays` | `30` | How far back to look for recent entities |
| `maxItems` | see above | Max items per entity type in context |

Default: disabled (identical to v0.4 behavior). Both features are fully backward compatible.

</details>

### LLM providers

OpenAI-compatible or native Anthropic Messages API:

| Provider | `baseUrl` | Model | Cost (input/output per 1M) |
|----------|-----------|-------|----------------------------|
| Anthropic | `https://api.anthropic.com` | `claude-haiku-4-5` | $0.80 / $4.00 |
| OpenAI | `https://api.openai.com/v1` | `gpt-5-nano` | $0.05 / $0.40 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash-lite` | $0.10 / $0.40 |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-instruct` | $0.10 / $0.32 |
| Mistral | `https://api.mistral.ai/v1` | `ministral-3b-2512` | $0.10 / $0.10 |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` | free (local) |
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-4-scout` | $0.08 / $0.30 |

<details>
<summary>Embedding providers (for vector search)</summary>

Works with any OpenAI-compatible `/v1/embeddings` endpoint. You can mix providers -- e.g., cheap LLM (Groq) for extraction + quality embeddings (OpenAI) for search.

| Provider | `embedding.baseUrl` | Model | Dimensions |
|----------|---------------------|-------|------------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | 1536 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `text-embedding-004` | 768 |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` | 768 |

Add to your config:

```json
{
  "embedding": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  }
}
```

Then run:

```bash
npm install better-sqlite3 sqlite-vec
LIZARDBRAIN_EMBEDDING_API_KEY=your-key node src/cli.js embed --backfill
```

See `examples/lizardbrain-mixed.json` for a mixed-provider config.

</details>

---

## Chat sources

### SQLite (default)

Point at any SQLite database with a messages table. Works with Telegram exports, custom bots, or any app that stores messages in SQLite.

```json
{
  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": { "id": "message_id", "content": "text", "sender": "author", "timestamp": "created_at" },
    "filter": "channel = 'general'"
  }
}
```

<details>
<summary>Group-only filtering (exclude DMs)</summary>

Restrict extraction to group chats only -- prevents private messages from leaking into shared memory:

```json
{
  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "conversationFilter": {
      "column": "conversation_id",
      "detectGroup": { "contentColumn": "content", "marker": "is_group_chat" }
    }
  }
}
```

</details>

### JSONL

```json
{
  "source": {
    "type": "jsonl",
    "path": "./messages.jsonl",
    "fields": { "id": "id", "content": "text", "sender": "from", "timestamp": "date" }
  }
}
```

### stdin

Pipe messages directly from any source:

```bash
cat messages.jsonl | node src/cli.js extract --source stdin
curl https://api.example.com/messages | node src/cli.js extract --source stdin
```

### Custom adapter

Write your own in ~10 lines:

```js
// my-adapter.js
module.exports = {
  name: 'my-source',
  validate() { return { ok: true }; },
  getMessages(afterId) {
    return [{ id: '1', content: 'hello', sender: 'alice', timestamp: '2026-01-01' }];
  }
};
```

```json
{ "source": { "type": "custom", "adapterPath": "./my-adapter.js" } }
```

---

## Profiles in depth

Profiles adapt what the LLM looks for based on the type of group:

- **Knowledge** profile asks the LLM to extract skills, tools, and project involvement. Roster shows "expertise" and "builds".
- **Team** profile asks for roles, responsibilities, and current work. Roster shows "role" and "works on". Also captures decisions and tasks.
- **Project** profile asks for company, role, and scope of work. Roster shows "role" and "scope". Captures decisions, tasks, and questions -- but not topics (project chats tend to be focused, not multi-topic).

The same database columns are reused across profiles -- only the LLM prompt changes. You can switch profiles without migrating data.

<details>
<summary>Custom entity selection</summary>

Override which entities are extracted in your config file:

```json
{
  "profile": "team",
  "entities": ["members", "facts", "decisions", "tasks"]
}
```

Available entity types: `members`, `facts`, `topics`, `decisions`, `tasks`, `questions`, `events`.

</details>

<details>
<summary>Confidence scores</summary>

Facts are tagged with confidence scores to distinguish verified information from opinions and hearsay:

| Score | Meaning | Example |
|-------|---------|---------|
| 0.9+ | Verified specifics | "Claude Opus costs $15/M output tokens" |
| 0.75-0.89 | Opinions, experiences | "LlamaIndex works better for large PDFs" |
| 0.5-0.74 | Secondhand, speculation | "I heard they might release a new model" |

</details>

---

## Programmatic API

```js
const lizardbrain = require('lizardbrain');

// Initialize with a profile
lizardbrain.init('./memory.db', { profile: 'team' });

// Connect to your chat source
const adapter = lizardbrain.adapters.sqlite.create({
  path: './chat.db',
  table: 'messages',
  columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
});
const driver = lizardbrain.createDriver('./memory.db');

// Extract knowledge
await lizardbrain.extract(adapter, driver, {
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5-nano' },
});

// Search (hybrid FTS5 + vector, or FTS5-only fallback)
const { mode, results } = await lizardbrain.search(driver, 'kubernetes', { limit: 5 });

// Query helpers
const facts = lizardbrain.query.searchFacts(driver, 'kubernetes');
const experts = lizardbrain.query.whoKnows(driver, 'python');
const decisions = lizardbrain.query.searchDecisions(driver, 'database');
const tasks = lizardbrain.query.searchTasks(driver, 'migration');

// Generate a compact roster for agent context windows
const roster = lizardbrain.query.generateRoster(driver);
// roster.content is ~30 tokens per member, ready for a system prompt

// Assemble context for an agent (used by MCP server internally)
const context = lizardbrain.context.assembleContext(driver, {
  participants: ['Alice', 'Bob'],
  topics: ['kubernetes'],
  recencyDays: 30,
  tokenBudget: 2000,
});

// Start an MCP server programmatically
const server = lizardbrain.createServer({ driver, config });
await server.listen(); // connects stdio transport

driver.close();
```

---

## CLI reference

```
lizardbrain init [--force] [--profile <name>]              Create memory database
lizardbrain extract [--dry-run] [--reprocess]              Run extraction pipeline
    [--limit N] [--from <id>]
lizardbrain embed [--stats] [--rebuild]                    Manage vector embeddings
lizardbrain stats                                          Show database statistics
lizardbrain health [--json]                                Check system health
lizardbrain search <query> [--json] [--fts-only] [--limit N]  Search knowledge
lizardbrain who <keyword>                                  Find members by expertise
lizardbrain roster [--output path]                         Generate member roster
lizardbrain reset-cursor [--to <id>]                       Reset extraction cursor
lizardbrain prune-embeddings [--orphaned] [--stale] [--model <name>]  Clean up embeddings
lizardbrain serve                                         Start MCP server (stdio)
```

| Flag | Description |
|------|-------------|
| `--config <path>` | Path to config file |
| `--profile <name>` | Set extraction profile (knowledge, team, project, full) |
| `--roster <path>` | Generate roster after extraction |
| `--no-enrich` | Skip URL metadata enrichment |
| `--no-embed` | Skip auto-embedding after extraction |
| `--limit N` | Limit extraction to N batches |
| `--from <id>` | Start extraction from a specific message ID |

<details>
<summary>Environment variables</summary>

| Variable | Description |
|----------|-------------|
| `LIZARDBRAIN_LLM_API_KEY` | LLM API key |
| `LIZARDBRAIN_LLM_BASE_URL` | LLM API base URL |
| `LIZARDBRAIN_LLM_MODEL` | LLM model name |
| `LIZARDBRAIN_EMBEDDING_API_KEY` | Embedding API key |
| `LIZARDBRAIN_EMBEDDING_BASE_URL` | Embedding API base URL |
| `LIZARDBRAIN_EMBEDDING_MODEL` | Embedding model name |
| `LIZARDBRAIN_DB_PATH` | Path to memory database |
| `LIZARDBRAIN_PROFILE` | Extraction profile |
| `LIZARDBRAIN_SOURCE_AGENT` | Source agent identifier (multi-agent setups) |
| `LIZARDBRAIN_CONVERSATION_TYPE` | Explicit conversation type (skip heuristic detection) |

</details>

---

## MCP Server

Run LizardBrain as an [MCP](https://modelcontextprotocol.io/) server so any compatible agent can read, search, and write knowledge directly:

```bash
node src/cli.js serve
```

Requires `better-sqlite3` and `@modelcontextprotocol/sdk` (installed via `npm install`). The server communicates over stdio using JSON-RPC.

### Tools

The MCP server exposes 7 tools:

| Tool | Type | Description |
|------|------|-------------|
| `get_context` | Read | Assembled, token-budgeted context for a conversation (participants, topics, or both) |
| `search` | Read | Unified search across all entity types (hybrid FTS5 + vector, or FTS-only fallback) |
| `who_knows` | Read | Find people by expertise or involvement |
| `get_stats` | Read | Database overview (entity counts) |
| `add_knowledge` | Write | Structured write-back — agent provides pre-structured entities |
| `ingest` | Write | Unstructured write-back — raw text is sent through LLM extraction and stored |
| `update_entity` | Update | Update status of decisions, tasks, or questions |

### Client configuration

<details>
<summary>Claude Desktop</summary>

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "lizardbrain": {
      "command": "node",
      "args": ["/path/to/lizardbrain/src/cli.js", "serve"],
      "env": {
        "LIZARDBRAIN_LLM_API_KEY": "your-key"
      }
    }
  }
}
```

</details>

<details>
<summary>Claude Code</summary>

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "lizardbrain": {
      "command": "node",
      "args": ["/path/to/lizardbrain/src/cli.js", "serve"],
      "env": {
        "LIZARDBRAIN_LLM_API_KEY": "your-key"
      }
    }
  }
}
```

</details>

<details>
<summary>Cursor</summary>

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "lizardbrain": {
      "command": "node",
      "args": ["/path/to/lizardbrain/src/cli.js", "serve"],
      "env": {
        "LIZARDBRAIN_LLM_API_KEY": "your-key"
      }
    }
  }
}
```

</details>

### Example usage

Once connected, an agent can:

```
# Load context about specific people and topics
get_context({ participants: ["Alice", "Bob"], topics: ["kubernetes"], tokenBudget: 2000 })

# Search for specific knowledge
search({ query: "database migration", types: ["decisions", "tasks"], limit: 5 })

# Write structured knowledge directly
add_knowledge({ facts: [{ category: "technique", content: "Use pg_dump for migrations", confidence: 0.9 }] })

# Ingest raw text through LLM extraction
ingest({ text: "Alice said we should switch to PostgreSQL. Bob agreed.", profile: "team" })

# Update entity status
update_entity({ type: "task", id: 42, status: "done" })
```

### Notes

- The `ingest` tool requires LLM configuration (same as `extract`). All other tools work without an LLM.
- All logging goes to stderr — stdout is reserved for JSON-RPC.
- The server uses `better-sqlite3` exclusively (no CLI driver fallback) to prevent SQL injection.
- `sqlite-vec` remains optional — hybrid search when available, FTS-only fallback otherwise.

---

## Integration Patterns

### Roster as system prompt injection

The `roster` command generates compact member listings (~30 tokens per person) suitable for injection into agent system prompts. Recommended two-layer approach:

1. **Static layer** (refreshed daily via cron): inject `lizardbrain roster` output as a system prompt section -- gives agents awareness of team members and their expertise
2. **Dynamic layer** (per-turn): inject `lizardbrain search` results for contextual facts relevant to the current conversation

See `examples/openclaw-plugin.ts` for a full working example.

### CLI driver limitations

The CLI driver (used when `better-sqlite3` is not installed) passes SQL via stdin to the `sqlite3` binary. It uses string escaping rather than parameterized queries. **Do not use the CLI driver with untrusted input.** Install `better-sqlite3` for production deployments with user-facing data.

### Log rotation

LizardBrain uses `console.log` and does not manage log files directly. When running extraction via cron, redirect stdout to a file and use external log rotation:

```bash
# Cron entry
0 3 * * * cd /path/to/project && node src/cli.js extract >> /var/log/lizardbrain-extract.log 2>&1

# /etc/logrotate.d/lizardbrain
/var/log/lizardbrain-extract.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
}
```

---

## Tuning Guide

LizardBrain ships with defaults tuned for small groups (<50 active members, <5K messages). Below are all parameters you should review when setting up for your specific use case. **Ask these questions before configuring:**

1. **How many active members?** Affects `knownMembersLimit` and roster token budget.
2. **How many messages per day?** Affects `batchSize`, `minMessages`, and cron frequency.
3. **What kind of group?** Determines the `profile` — community vs. team vs. project.
4. **Do decisions/tasks need tracking?** Determines whether to enable `context` injection.
5. **Is cost a concern?** Affects LLM model choice, `batchSize`, and embedding config.

### Extraction pipeline

These control how messages are batched and sent to the LLM.

| Parameter | Default | Config key | What to change |
|-----------|---------|------------|----------------|
| Batch size | `40` | `batchSize` | **Increase to 60-80** for groups with long threaded discussions. **Decrease to 20-30** for noisy groups where conversations are short. Larger batches give the LLM more context but cost more per call. |
| Min messages | `5` | `minMessages` | **Increase to 10-20** for high-volume groups to avoid processing tiny increments. **Set to 1** if running manually and you want every message processed. |
| Batch overlap | `0` | `batchOverlap` | **Set to 5-10** if conversations frequently span batch boundaries (people continue the same topic across 40+ messages). Costs extra tokens but prevents split-context extraction. |
| Max retries | `3` | `llm.maxRetries` | **Increase to 5** if using rate-limited free tiers. **Set to 1** for fast failure during development. |

### Context injection

Controls what existing knowledge the LLM sees when extracting new batches. **Without context, decisions/tasks can never be updated — only created.**

| Parameter | Default | Config key | What to change |
|-----------|---------|------------|----------------|
| Enabled | `false` | `context.enabled` | **Set to `true`** for any profile that has decisions, tasks, or questions (team, project, full). Not needed for knowledge-only profiles. |
| Token budget | `1000` | `context.tokenBudget` | **Increase to 1500-2000** for teams with many open tasks/decisions (50+). Each entity takes ~30-50 tokens. At 1000, you get ~25-30 entities in context. |
| Recency days | `30` | `context.recencyDays` | **Increase to 90-180** for slow-moving groups where decisions take months. **Decrease to 7-14** for fast-paced daily standup groups. |
| Max decisions | `5` | `context.maxItems.decisions` | **Increase to 15-20** for teams with many concurrent decisions. |
| Max tasks | `10` | `context.maxItems.tasks` | **Increase to 25-50** for project-heavy teams. This is often the most important number to raise. |
| Max questions | `5` | `context.maxItems.questions` | **Increase to 10-15** for Q&A-heavy communities. |
| Max facts | `5` | `context.maxItems.facts` | Usually fine at 5. Only recent high-confidence facts are injected. |
| Max topics | `3` | `context.maxItems.topics` | Usually fine at 3. Topics are mainly for dedup, not updates. |

### Known members prompt

Controls how many existing members are shown to the LLM to prevent redundant re-extraction.

| Parameter | Default | Where | What to change |
|-----------|---------|-------|----------------|
| Known members limit | `100` | `getKnownMemberNames(driver, limit)` | **Increase to 200-500** for large communities (500+ members). Each name costs ~15 tokens. At 500 members that's ~7500 prompt tokens — weigh against extraction cost. Callers override this via the `limit` parameter. |

### LLM settings

These are hardcoded in `src/llm.js` but may need adjustment for specific models.

| Parameter | Default | What to change |
|-----------|---------|----------------|
| Temperature | `0.1` | **Leave low** for extraction (you want deterministic structured output). Only increase if using a model that produces repetitive output at low temperature. |
| Max output tokens | `4096` | **Increase to 8192** if using large batch sizes (80+) and the LLM truncates its response. Most extraction responses are 1-2K tokens. |
| Structured output | Zod schema | Uses Vercel AI SDK's `Output.object({ schema })` with dynamic Zod schemas built from your profile. If the model returns invalid output, falls back to JSON repair. No configuration needed. |

### Embedding & search

| Parameter | Default | Config key | What to change |
|-----------|---------|------------|----------------|
| Enabled | `false` | `embedding.enabled` | **Set to `true`** for semantic search (finds "container orchestration" when searching "Kubernetes"). Requires `better-sqlite3` + `sqlite-vec`. |
| Dimensions | auto-detect | `embedding.dimensions` | **Set explicitly** if your model doesn't return dimensions in the API response. Common: 1536 (OpenAI), 768 (Gemini/Nomic). |
| Batch token limit | `8000` | `embedding.batchTokenLimit` | **Increase to 16000** for embedding APIs with higher limits. This is characters, not tokens (~4 chars per token). |
| RRF K constant | `60` | hardcoded in `search.js` | Controls hybrid search ranking. Higher K = more equal weighting between FTS and vector results. Default of 60 is standard in IR literature. Rarely needs changing. |

### URL enrichment

| Parameter | Default | Config key | What to change |
|-----------|---------|------------|----------------|
| Max URLs per batch | `10` | `urlEnrichment.maxUrls` | **Increase to 20** for link-heavy groups (dev communities sharing repos). **Set to 0 or use `--no-enrich`** to disable entirely if URLs are rare or you want faster extraction. |
| Timeout per URL | `5000` ms | `urlEnrichment.timeoutMs` | **Decrease to 2000** if enrichment is slowing extraction. **Increase to 10000** if fetching from slow sites. |

### Recommended configurations

<details>
<summary>Small team (5-15 people, Slack/Discord)</summary>

```json
{
  "profile": "team",
  "batchSize": 40,
  "batchOverlap": 5,
  "context": {
    "enabled": true,
    "tokenBudget": 1000,
    "recencyDays": 60
  }
}
```

</details>

<details>
<summary>Large community (100-500 people, Discord/Telegram)</summary>

```json
{
  "profile": "knowledge",
  "batchSize": 60,
  "minMessages": 10,
  "batchOverlap": 0,
  "context": {
    "enabled": false
  }
}
```

Context injection is less important for knowledge profiles (no tasks/decisions to update). The dedup layer handles fact overlap. Consider enabling embeddings for semantic search across the larger fact base.

</details>

<details>
<summary>Project group (15-50 people, heavy task tracking)</summary>

```json
{
  "profile": "project",
  "batchSize": 40,
  "batchOverlap": 5,
  "context": {
    "enabled": true,
    "tokenBudget": 1500,
    "recencyDays": 90,
    "maxItems": {
      "decisions": 15,
      "tasks": 25,
      "questions": 10,
      "facts": 5
    }
  }
}
```

Higher token budget and item limits because projects tend to have many concurrent tasks and decisions that evolve over weeks/months.

</details>

---

## Requirements

| Tier | What you need |
|------|--------------|
| **Core** | Node.js >= 18, `sqlite3` CLI (already on macOS/Linux), `npm install` (installs `ai`, `@ai-sdk/openai-compatible`, `zod`) |
| **Anthropic** (native API) | + `npm install @ai-sdk/anthropic` (optional — included in optionalDependencies) |
| **MCP** (agent access) | + `npm install better-sqlite3 @modelcontextprotocol/sdk` |
| **Vector** (semantic search) | + `npm install sqlite-vec` + any embedding API |

---

## License

MIT
