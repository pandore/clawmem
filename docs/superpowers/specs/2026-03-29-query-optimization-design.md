# Query & Dedup Optimization — Design Spec

**Date:** 2026-03-29
**Scope:** Database indexes, dedup query merging, known-members prompt cap
**Files:** `src/schema.js`, `src/store.js`
**Risk:** Low — no correctness changes, all existing tests pass unchanged

---

## Problem

Lizardbrain's extraction pipeline makes excessive database round-trips during deduplication and lacks indexes on frequently queried columns. At current scale (<500 members, <10K facts), this adds unnecessary latency. As the database grows, performance degrades linearly because context queries and member lookups do full table scans.

Additionally, the known-members prompt injection (added in v0.6) sends all member names to the LLM regardless of database size, which wastes tokens on large communities.

## Design

Three surgical changes — no new features, no schema version bump, no correctness changes. The known-members cap is a minor behavior change (LLM may re-extract low-frequency members in communities with 100+ people) but does not affect data integrity — `upsertMember()` still deduplicates at the DB level.

### 1. Database Indexes

Add 9 indexes via idempotent `CREATE INDEX IF NOT EXISTS` statements. These speed up context queries, member upserts, and foreign-key joins in search. They do **not** speed up the dedup prefix check (`LOWER(SUBSTR(content,1,80)) = ...`), which remains a scan — the dedup improvement comes from merging round-trips (section 2), not indexing.

**Member upsert lookups** — `upsertMember()` queries by `display_name` and `username` on every member extraction. Note: `username` already has an implicit index from its `UNIQUE` constraint, so only `display_name` needs an explicit index:
```sql
CREATE INDEX IF NOT EXISTS idx_members_display_name ON members(display_name);
```

**Foreign key joins** — search queries join facts/tasks to members by `source_member_id`:
```sql
CREATE INDEX IF NOT EXISTS idx_facts_source_member ON facts(source_member_id);
CREATE INDEX IF NOT EXISTS idx_tasks_source_member ON tasks(source_member_id);
```

**Context queries** — `getActiveContext()` filters by status and orders by `created_at`:
```sql
CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at);
```

**Recency queries** — context injection fetches recent facts and topics:
```sql
CREATE INDEX IF NOT EXISTS idx_facts_created_at ON facts(created_at);
CREATE INDEX IF NOT EXISTS idx_topics_created_at ON topics(created_at);
```

**Placement in `migrate()`:** The indexes reference tables (`decisions`, `tasks`, `questions`) that only exist after the v0.5/v0.6 migration creates them. Therefore, the index block must go **at the end of `migrate()`**, after all table creation and migration is complete, just before the final `return` statement. This ensures pre-v0.6 databases get their tables created first, then the indexes applied. `IF NOT EXISTS` makes it a no-op on subsequent runs.

**Placement in `SCHEMA_SQL`:** Also add the same 9 indexes to `SCHEMA_SQL` so that fresh databases created via `init` get them from the start.

### 2. Merged Dedup Queries

Currently, each entity insert function (`insertFact`, `insertDecision`, `insertTask`, `insertQuestion`, `insertEvent`) runs two separate reads:
1. Exact 80-character prefix match
2. FTS5 2-keyword overlap check (only when `keywords.length >= 2`)

These are combined into a single `SELECT ... WHERE (exact match) OR (FTS match) LIMIT 1` query. This is primarily a **round-trip optimization** — it eliminates one `driver.read()` call per entity, which is significant on the CliDriver (each read spawns a subprocess). The SQLite query planner may or may not optimize the combined OR better than two separate queries, but the round-trip savings dominate.

**Before** (2 reads per entity):
```js
const exactMatch = driver.read(`SELECT id FROM facts WHERE LOWER(SUBSTR(content,1,80)) = '${prefix}'`);
if (exactMatch.length > 0) return false;

if (keywords.length >= 2) {
  const ftsMatch = driver.read(`SELECT id FROM facts WHERE id IN (...) LIMIT 1`);
  if (ftsMatch.length > 0) return false;
}
```

**After** (1 read per entity):
```js
const duplicate = driver.read(`
  SELECT id FROM facts WHERE
    LOWER(SUBSTR(content,1,80)) = '${prefix}'
    ${ftsQuery ? `OR (id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${ftsQuery}') AND category = '${esc(fact.category)}')` : ''}
  LIMIT 1
`);
if (duplicate.length > 0) return false;
```

**Critical implementation requirement:** The FTS branch of the OR must only be appended when `keywords.length >= 2` (i.e., when `ftsQuery` is non-empty). This preserves the existing guard — entities with fewer than 2 keywords only get the exact-prefix check, same as today. The conditional template `${ftsQuery ? ... : ''}` handles this.

**Applied to:** `insertFact`, `insertDecision`, `insertTask`, `insertQuestion`, `insertEvent` (5 functions). `insertTopic` only has FTS dedup (no prefix match), so it stays as a single read — no change.

**Entity-specific differences in the OR clause:**
- `insertFact`: FTS branch includes `AND category = '...'` (scopes dedup to same category)
- `insertDecision`, `insertTask`, `insertQuestion`, `insertEvent`: FTS branch has no category filter — just prefix OR FTS match

**Dedup logic is unchanged.** The OR produces the same result as two sequential checks with early return. If either condition matches, the entity is a duplicate.

### 3. Known-Members Prompt Cap

**IMPORTANT FOR INTEGRATORS:** The `getKnownMemberNames()` function injects existing member names into the LLM extraction prompt so the model skips re-extracting unchanged members. By default, this is capped at the **100 most recently active members** (sorted by `last_seen DESC`).

**Why 100:** In most group chats, 50-100 people account for the active participants in any given period. At ~15 tokens per name, 100 members = ~1500 prompt tokens — a reasonable budget. Members outside the top 100 are still deduplicated at the database level by `upsertMember()`, so correctness is never affected — only the LLM token optimization is skipped for less active members.

**For larger communities (500+ active members):** Increase the limit by passing a higher value to `getKnownMemberNames(driver, limit)`. The function signature is:

```js
function getKnownMemberNames(driver, limit = 100)
```

Callers can override the default. A future enhancement could make this configurable via `lizardbrain.json` (e.g., `"knownMembersLimit": 200`), but this is not implemented in this change.

**Trade-off at higher limits:** More members in the prompt = fewer redundant LLM extractions, but higher prompt token cost per batch. At 500 members (~7500 tokens), the prompt cost may outweigh the savings from skipped extractions. The sweet spot depends on the ratio of active-to-total members.

**Input validation:** The `limit` parameter is clamped to a positive integer: `Math.max(1, parseInt(limit) || 100)`. This prevents negative, zero, or non-numeric values from producing invalid SQL.

**Change:**
```js
// Before
function getKnownMemberNames(driver) {
  const rows = driver.read('SELECT display_name FROM members ORDER BY last_seen DESC');
  return rows.map(r => r.display_name).filter(Boolean);
}

// After
function getKnownMemberNames(driver, limit = 100) {
  const safeLimit = Math.max(1, parseInt(limit) || 100);
  const rows = driver.read(`SELECT display_name FROM members ORDER BY last_seen DESC LIMIT ${safeLimit}`);
  return rows.map(r => r.display_name).filter(Boolean);
}
```

## Impact

| Metric | Before | After |
|--------|--------|-------|
| DB reads per 50-fact batch (dedup) | ~150 | ~75 |
| Context query time (1K+ rows) | Full table scan | Index seek |
| Member upsert lookup | Full table scan | Index seek |
| FK joins in search | Full table scan | Index seek |
| Dedup prefix check | Full table scan | Full table scan (unchanged) |
| Known-members prompt tokens | Unbounded | ~1500 (capped at 100) |

## Testing

All 238 existing tests pass unchanged. No new tests required — the indexes are additive, the dedup merge produces identical results to the sequential pattern, and the known-members cap does not affect data integrity.

## Files Modified

| File | Change |
|------|--------|
| `src/schema.js` | Add 9 `CREATE INDEX IF NOT EXISTS` statements in `migrate()` and `SCHEMA_SQL` |
| `src/store.js` | Merge 2-read dedup into 1-read in 5 insert functions; add `LIMIT` param with clamping to `getKnownMemberNames` |
