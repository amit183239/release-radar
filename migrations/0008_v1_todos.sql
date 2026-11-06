-- 0008_v1_todos.sql — re-surface activity events (v1 TODOs spec §0b).
--
-- entities.comments_count: baseline for comment-increase activity detection.
-- NULL on rows that predate this migration = "no baseline yet" (never an event).
ALTER TABLE entities ADD COLUMN comments_count INTEGER;

-- events.dedupe_key: idempotency key for activity events. Their release_id is
-- NULL, and SQLite treats NULLs as distinct, so UNIQUE(kind, release_id,
-- pr_number) cannot dedupe them. Partial index so shipped rows (NULL key) are
-- unconstrained. Conflict target: ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL.
ALTER TABLE events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
  ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
