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
