-- schema.sql — FLAT REFERENCE of the current D1 schema. Generated from
-- migrations/*.sql; update in the SAME commit as any new migration (billing
-- convention). Do NOT apply this file directly — wrangler applies migrations/.

-- 0001_initial.sql — release-radar v1 (Phase 1 core + Phase 2/3 columns).
-- Conventions: TEXT UUIDv4 ids, epoch-INTEGER
-- timestamps, parameterized queries only. schema.sql mirrors this file's
-- resulting state and must change in the same commit as any new migration.

-- ---------------------------------------------------------------------------
-- 1. cron_locks — singleton guard for the poll tick (see lib/cron-locks.ts).
-- lock_token is set by acquireLock and required by releaseLock so a stale
-- runner whose TTL elapsed cannot delete a lock now held by a fresh runner.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_locks (
  job_name    TEXT PRIMARY KEY,
  locked_at   INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  lock_token  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. sync_state — resumable poll cursors, keyed by a logical stream name
-- (e.g. 'pr-search' for the org-wide UPDATED-DESC PR cursor, 'backfill' for
-- the bootstrap cursor). status is a freeform runner state string.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
  key            TEXT PRIMARY KEY,
  cursor         TEXT,
  last_synced_at INTEGER,
  status         TEXT
);

-- ---------------------------------------------------------------------------
-- 3. apps — the app registry, seeded from mapping.json (fetched via API).
-- last_ref is the SHA of the most recent prod tag whose chain has been fully
-- committed; the poll advances it ONLY after the app's whole chain lands
-- (partial-tick safety). synthetic=1 marks the shared-lib umbrella bucket
-- (e.g. 'platform') that is not a real mapping.json slug.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apps (
  slug              TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  repos_json        TEXT,           -- JSON array of repos this app spans
  source_paths_json TEXT,           -- JSON array of path prefixes owned by this app
  label_override    TEXT,           -- optional GitHub label that forces app scope
  visibility        TEXT NOT NULL DEFAULT 'internal',
  synthetic         INTEGER NOT NULL DEFAULT 0,
  last_ref          TEXT,           -- SHA of last fully-processed prod tag
  last_ref_at       INTEGER,        -- tag-creation time of last_ref
  created_at        INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 4. entities — the GitHub issue/PR cache. UNIQUE(repo,kind,number) makes
-- upserts idempotent. last_meaningful_activity_at drives re-surface and is
-- advanced only by meaningful events (not raw label/assignee edits).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id                         TEXT PRIMARY KEY,
  repo                       TEXT NOT NULL,
  kind                       TEXT NOT NULL,          -- 'issue' | 'pr'
  number                     INTEGER NOT NULL,
  title                      TEXT,
  state                      TEXT,
  author                     TEXT,
  labels_json                TEXT,
  issue_type                 TEXT,
  milestone                  TEXT,
  updated_at                 INTEGER,
  last_meaningful_activity_at INTEGER,
  closes_json                TEXT,                   -- JSON array of issue numbers this PR closes
  url                        TEXT,
  UNIQUE(repo, kind, number)
);

-- ---------------------------------------------------------------------------
-- 5. releases — one row per (app, prod tag). deployed_at = tag-creation time
-- (the only monotonic deploy-order signal). base_ref = previous prod SHA in
-- the chain. divergent=1 when the compare status was 'diverged'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS releases (
  id          TEXT PRIMARY KEY,
  app         TEXT NOT NULL,
  ref         TEXT NOT NULL,          -- tagged commit SHA (immutable key)
  tag         TEXT NOT NULL,          -- tag name
  deployed_at INTEGER NOT NULL,       -- tag-creation time (tagger.date)
  base_ref    TEXT,                   -- prev prod SHA (compare base); NULL for chain head
  divergent   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(app, ref)
);

-- ---------------------------------------------------------------------------
-- 6. notes — per-PR changelog entries inside a release. Dual copy:
-- note_technical (Dev) + note_customer (CX, AI/curated). copy_source records
-- provenance. customer_facing/docs_needed/security_relevant default false
-- (fail-closed). UNIQUE(release_id, pr_number) keeps re-scans idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id                TEXT PRIMARY KEY,
  release_id        TEXT NOT NULL,
  app               TEXT NOT NULL,
  pr_number         INTEGER NOT NULL,
  note_technical    TEXT,
  note_customer     TEXT,
  copy_source       TEXT,                   -- 'human' | 'ai' | 'fallback'
  customer_facing   INTEGER NOT NULL DEFAULT 0,
  docs_needed       INTEGER NOT NULL DEFAULT 0,
  security_relevant INTEGER NOT NULL DEFAULT 0,
  help_url          TEXT,
  author            TEXT,
  merged_at         INTEGER,
  url               TEXT,
  UNIQUE(release_id, pr_number)
);

-- ---------------------------------------------------------------------------
-- 7. users — one row per @<allowed-domain> person, created on first login.
-- lens_profile: 'developer' (default) | 'cx' | ... (role keys; see src/lib/roles.ts).
-- role_chosen: 0 until the user picks a role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  name             TEXT,
  lens_profile     TEXT NOT NULL DEFAULT 'developer',  -- role key (see src/lib/roles.ts)
  role_chosen      INTEGER NOT NULL DEFAULT 0,          -- 0 until the user picks a role
  notif_prefs_json TEXT,
  created_at       INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 8. sessions — server-side session store. The cookie value IS the id (the
-- bearer credential). OAuth tokens are stored encrypted at rest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  email               TEXT,
  oauth_user_id     TEXT,
  oauth_team_id     TEXT,
  enc_oauth_tokens  TEXT,          -- AES-GCM ciphertext of the OAuth token blob
  token_expires_at    INTEGER,
  expires_at          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- 9. pending_logins — one-shot hand-off row for the OAuth callback -> app.
-- Holds the verified profile + encrypted tokens between callback and session
-- mint; deleted on claim (DELETE...RETURNING). Prevents session fixation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_logins (
  token             TEXT PRIMARY KEY,
  email             TEXT,
  oauth_user_id   TEXT,
  oauth_team_id   TEXT,
  enc_token_data    TEXT,
  token_expires_at  INTEGER,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 10. follows (Phase 2) — one row per followed target. target_type in
-- {issue, pr, label, milestone, query, app}. customer_ref/ticket_ref are
-- opaque CRM links (never routable send targets, never customer names).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follows (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_ref   TEXT NOT NULL,
  customer_ref TEXT,
  ticket_ref   TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  muted_at     INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE(user_id, target_type, target_ref)
);

-- ---------------------------------------------------------------------------
-- 11. feed (Phase 2) — per-user event fan-out. lens records which lens framing
-- the item was generated under; read_at NULL = unread.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  entity_id    TEXT,
  lens         TEXT,
  matched_type TEXT,                      -- which followed target matched (pr|issue|label|app); null = legacy
  matched_ref  TEXT,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_user_unread ON feed(user_id, read_at);

-- 0002_phase2_follow_feed.sql — Phase 2: event ledger, feed dedup, curated copy.
-- Conventions unchanged (TEXT UUID ids, epoch-INTEGER timestamps, parameterized).
-- schema.sql mirrors the resulting state.

-- ---------------------------------------------------------------------------
-- events — the ship/activity ledger that feed items reference. A "shipped"
-- event = a followed target's PR landed in a prod tag. UNIQUE(kind, release_id,
-- pr_number) keeps re-scans idempotent (the poll re-emits on every tick).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,           -- 'shipped' (more in later phases)
  app          TEXT,
  release_id   TEXT,
  pr_number    INTEGER,
  entity_id    TEXT,
  payload_json TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(kind, release_id, pr_number)
);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(app);

-- ---------------------------------------------------------------------------
-- feed dedup — one item per (user, event) (review V7 dedup key). feed was
-- created in 0001 without this constraint; the table is empty pre-launch so the
-- unique index applies cleanly.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_user_event ON feed(user_id, event_id);

-- ---------------------------------------------------------------------------
-- entities.release_note — curated copy extracted from a PR body's
-- `## Release Note` section (the ● curated vs ○ from-PR-title distinction).
-- ---------------------------------------------------------------------------
ALTER TABLE entities ADD COLUMN release_note TEXT;

-- 0003_phase3_cx.sql — Phase 3: CX lens (AI note_customer + spend cap).
-- Conventions unchanged. schema.sql mirrors the resulting state.

-- ---------------------------------------------------------------------------
-- ai_spend — monthly AI cost ledger for the spend cap (review V9). Keyed by
-- ISO month (`YYYY-MM`). The off-tick generation job checks the cap before
-- every call and records cost after.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_spend (
  month      TEXT PRIMARY KEY,        -- 'YYYY-MM' (UTC)
  calls      INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- notes.customer_source — provenance of note_customer, distinct from
-- copy_source (which describes note_technical): 'human' | 'ai' | 'fallback'.
-- ---------------------------------------------------------------------------
ALTER TABLE notes ADD COLUMN customer_source TEXT;

-- 0006_persona_summaries.sql — AI-generated per-role summaries for PRs.
-- ---------------------------------------------------------------------------
-- persona_summaries — one row per (release_id, pr_number, role). Consumed by
-- Tasks 6–13. No CHECK constraints on role/source — enforced in TypeScript.
-- ---------------------------------------------------------------------------
CREATE TABLE persona_summaries (
  id            TEXT PRIMARY KEY,
  release_id    TEXT NOT NULL,
  pr_number     INTEGER NOT NULL,
  role          TEXT NOT NULL,
  headline      TEXT NOT NULL,
  body          TEXT,
  source        TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (release_id, pr_number, role)
);
CREATE INDEX idx_persona_summaries_lookup ON persona_summaries (release_id, pr_number);

-- 0007_entities_files.sql — cache PR changed-file paths for path-scoped attribution.
ALTER TABLE entities ADD COLUMN files_json TEXT;


-- 0008_v1_todos.sql — re-surface activity events.
-- entities.comments_count: comment-count baseline (NULL = no baseline yet).
ALTER TABLE entities ADD COLUMN comments_count INTEGER;
-- events.dedupe_key: idempotency key for activity events (release_id is NULL
-- for them, so UNIQUE(kind, release_id, pr_number) cannot dedupe). Partial.
ALTER TABLE events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
  ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
