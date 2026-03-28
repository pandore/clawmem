# Lizardbrain

Persistent memory for group chats. Reads messages from any source, extracts structured knowledge via any LLM, stores in SQLite with FTS5 and optional vector hybrid search. Profile-driven entity extraction supports knowledge communities, team chats, project groups, and custom setups.

## Architecture

Two-tier, one codebase:
- **Core tier:** Zero dependencies. Uses CLI `sqlite3`. FTS5 keyword search only.
- **Vector tier:** Add `better-sqlite3` + `sqlite-vec` for hybrid search (FTS5 + kNN + RRF merge).

Data flow: `Chat Source → Adapter → URL Enricher → LLM Extraction → SQLite + FTS5 [→ Embedding Pipeline → vec0 tables → Hybrid Search]`

## Project Structure

```
src/
  index.js        — Public API (main entry point)
  cli.js          — CLI (init, extract, embed, stats, search, who, roster)
  config.js       — Config loader (JSON file + env vars + defaults)
  driver.js       — DB driver abstraction (BetterSqliteDriver / CliDriver)
  schema.js       — SQLite schema (7 entity tables + FTS5 + vec0, migration)
  store.js        — Read/write knowledge, deduplication, query helpers
  profiles.js     — Profile definitions, entity metadata, prompt fragments
  llm.js          — OpenAI-compatible LLM client, dynamic prompt assembly
  extractor.js    — Extraction pipeline orchestrator (profile-aware)
  embeddings.js   — Embedding pipeline (batching, retries, vec0 tables)
  search.js       — Hybrid search (FTS5 + kNN + RRF merge)
  adapters/
    sqlite.js     — SQLite source adapter
    jsonl.js      — JSONL source adapter
  enrichers/
    url.js        — URL metadata enrichment (GitHub API, HTML meta)
test/
  run.js          — Integration test suite (238 tests)
examples/         — Example config files for various providers
docs/
  specs/          — Technical design specs
  plans/          — Implementation plans
```

## Code Conventions

- **Module system:** CommonJS (require/module.exports)
- **Style:** Single quotes, semicolons, 2-space indent, camelCase
- **Error handling:** Try-catch for I/O; return `{ ok, error }` for validation; throw for unrecoverable; graceful degradation for optional features
- **SQL:** Use `esc()` helper for escaping; parameterized queries with `?` placeholders when using better-sqlite3
- **Async:** async/await, Promise.all for parallel ops, exponential backoff for rate limits
- **Config:** Env vars (`LIZARDBRAIN_*`) override file config; no silent defaults

## Commands

```bash
npm test              # Run test suite (node test/run.js)
npm run init          # Initialize memory database
npm run extract       # Run extraction pipeline
npm run stats         # Show database statistics
```

## Profiles

Profiles control what entity types are extracted and how member fields are interpreted:
- `knowledge` — members, facts, topics (default, backward-compatible)
- `team` — + decisions, tasks
- `project` — + decisions, tasks, questions (no topics)
- `full` — all 7 entity types
- `custom` — user picks entity types

Member columns (`expertise`, `projects`) are reused across profiles — the LLM prompt adapts based on profile labels. No schema migration needed.

## Key Design Decisions

- Model-agnostic: any OpenAI-compatible API works for both LLM and embeddings
- Profile-driven extraction: LLM prompt assembled dynamically from profile config
- Context-aware extraction: batch overlap prevents split conversations, context injection from DB enables entity updates across runs
- Entity updates: decisions (status), tasks (status), questions (answers) can be updated by the LLM when it sees existing knowledge in context
- Deduplication: multi-level (exact prefix match + FTS keyword overlap)
- Hybrid search: FTS5 + vector kNN merged via Reciprocal Rank Fusion (K=60)
- Auto-detect available deps at startup — gracefully degrade without optional deps
- Incremental processing via cursor tracking in extraction_state table
- Schema migration: v0.3→v0.4→v0.5 is automatic and idempotent

## Dependencies

- **Runtime:** Node.js >= 18, sqlite3 CLI with FTS5
- **Optional:** better-sqlite3, sqlite-vec (for vector tier)
- **No other dependencies**
