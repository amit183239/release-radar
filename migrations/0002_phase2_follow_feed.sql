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
