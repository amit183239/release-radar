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
