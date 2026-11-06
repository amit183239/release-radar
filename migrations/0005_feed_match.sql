-- Feed "why it reached you": record which followed target matched a ship.
-- Nullable — legacy rows stay null and the UI omits the reason line.
ALTER TABLE feed ADD COLUMN matched_type TEXT;
ALTER TABLE feed ADD COLUMN matched_ref TEXT;
