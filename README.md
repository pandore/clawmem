# LizardBrain
**Give your group chat a brain.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.5.0-orange.svg)](package.json)

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

**Use any LLM.** OpenAI, Gemini, Groq, Ollama, Mistral -- anything with an OpenAI-compatible API. Cheap models work great for extraction; you don't need a frontier model to pull facts out of chat messages.

**Zero dependencies to start.** The core tier uses Node.js and the `sqlite3` CLI that's already on your machine. No `npm install` needed.

**Scales up when you want.** Add `better-sqlite3` + `sqlite-vec` for hybrid vector search that combines keyword matching with semantic similarity via Reciprocal Rank Fusion.

**Runs incrementally.** Tracks where it left off. Each run only processes new messages, so it's cheap and fast even on large chats.

**Context-aware.** The LLM sees existing knowledge from previous runs. Decisions get confirmed, tasks get closed, questions get answered -- entities evolve naturally across extraction runs.

**Links get context.** When someone shares a GitHub repo or web page, LizardBrain fetches metadata (stars, descriptions, titles) before sending to the LLM, so extracted facts are richer.

**Built for agents.** Generate a compact member roster (~30 tokens per person) designed to fit in an agent's system prompt. At 100 members, that's ~3,000 tokens.

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
    "tokenBudget": 500,
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
| `tokenBudget` | `500` | Max tokens (~2000 chars) for context section |
| `recencyDays` | `30` | How far back to look for recent entities |
| `maxItems` | see above | Max items per entity type in context |

Default: disabled (identical to v0.4 behavior). Both features are fully backward compatible.

</details>

### LLM providers

Any OpenAI-compatible chat completions API:

| Provider | `baseUrl` | Model | Cost (input/output per 1M) |
|----------|-----------|-------|----------------------------|
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

driver.close();
```

---

## CLI reference

```
lizardbrain init [--force] [--profile <name>]       Create memory database
lizardbrain extract [--dry-run] [--reprocess]       Run extraction pipeline
lizardbrain embed [--stats] [--rebuild]             Manage vector embeddings
lizardbrain stats                                   Show database statistics
lizardbrain search <query> [--json] [--fts-only]    Search knowledge
lizardbrain who <keyword>                           Find members by expertise
lizardbrain roster [--output path]                  Generate member roster
```

| Flag | Description |
|------|-------------|
| `--config <path>` | Path to config file |
| `--profile <name>` | Set extraction profile (knowledge, team, project, full) |
| `--roster <path>` | Generate roster after extraction |
| `--no-enrich` | Skip URL metadata enrichment |
| `--no-embed` | Skip auto-embedding after extraction |

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

</details>

---

## Requirements

| Tier | What you need |
|------|--------------|
| **Core** (zero deps) | Node.js >= 18 and `sqlite3` CLI (already on macOS/Linux) |
| **Vector** (optional) | + `npm install better-sqlite3 sqlite-vec` + any embedding API |

---

## License

MIT
