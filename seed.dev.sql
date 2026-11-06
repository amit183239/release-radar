-- LOCAL DEV SEED DATA. Not applied by migrations; run explicitly:
--   npm run seed:local   (wrangler d1 execute release-radar --local --file seed.dev.sql)
-- Fixed ids + INSERT OR REPLACE make it idempotent. The dev user id matches
-- /auth/dev-login (DEBUG only). Timestamps are epoch seconds.

-- Dev user (same id the DEBUG dev-login uses).
INSERT OR REPLACE INTO users (id, email, name, lens_profile, created_at) VALUES
 ('00000000-0000-4000-8000-000000000001', 'dev@example.com', 'Dev User', 'dev', 1786700000);

-- Apps (platform is the synthetic shared-lib umbrella bucket).
INSERT OR REPLACE INTO apps (slug, display_name, visibility, synthetic, last_ref, last_ref_at, created_at) VALUES
 ('billing', 'billing', 'internal', 0, 'sha-aff-2', 1786790000, 1786700000),
 ('search', 'search', 'internal', 0, 'sha-evo-1', 1786780000, 1786700000),
 ('platform',   'platform',   'internal', 1, NULL,        NULL,       1786700000);

-- Releases (billing x2, search x1; search marked divergent).
INSERT OR REPLACE INTO releases (id, app, ref, tag, deployed_at, base_ref, divergent, created_at) VALUES
 ('rel-aff-1', 'billing', 'sha-aff-1', 'billing-2026.08.10-production', 1786500000, 'sha-aff-0', 0, 1786500000),
 ('rel-aff-2', 'billing', 'sha-aff-2', 'billing-2026.08.16-production', 1786790000, 'sha-aff-1', 0, 1786790000),
 ('rel-evo-1', 'search', 'sha-evo-1', 'search-2026.08.15-production', 1786780000, 'sha-evo-0', 1, 1786780000);

-- Notes: a curated (●) note, plain fallbacks (○), and one AI customer copy.
INSERT OR REPLACE INTO notes
 (id, release_id, app, pr_number, note_technical, note_customer, copy_source, customer_source, customer_facing, author, url) VALUES
 ('note-1', 'rel-aff-1', 'billing', 101, 'Add OAuth login for admins', NULL, 'human', NULL, 1, 'alice', 'https://github.com/acme/monorepo/pull/101'),
 ('note-2', 'rel-aff-1', 'billing', 102, 'Refactor payout batch job', NULL, 'fallback', NULL, 0, 'bob', 'https://github.com/acme/monorepo/pull/102'),
 ('note-3', 'rel-aff-2', 'billing', 110, 'Fix commission rounding bug', 'The commission rounding issue a few merchants reported is now fixed.', 'fallback', 'ai', 1, 'carol', 'https://github.com/acme/monorepo/pull/110'),
 ('note-4', 'rel-evo-1', 'search', 201, 'Improve search relevance ranking', NULL, 'fallback', NULL, 0, 'dan', 'https://github.com/acme/monorepo/pull/201');

-- Dev user follows the billing app.
INSERT OR REPLACE INTO follows (id, user_id, target_type, target_ref, archived, created_at) VALUES
 ('fol-1', '00000000-0000-4000-8000-000000000001', 'app', 'billing', 0, 1786700000);

-- Ship events + feed items for the dev user (one unread, one read).
INSERT OR REPLACE INTO events (id, kind, app, release_id, pr_number, created_at) VALUES
 ('evt-1', 'shipped', 'billing', 'rel-aff-2', 110, 1786790000),
 ('evt-2', 'shipped', 'billing', 'rel-aff-1', 101, 1786500000);
INSERT OR REPLACE INTO feed (id, user_id, event_id, lens, read_at, created_at) VALUES
 ('feed-1', '00000000-0000-4000-8000-000000000001', 'evt-1', NULL, NULL,       1786790000),
 ('feed-2', '00000000-0000-4000-8000-000000000001', 'evt-2', NULL, 1786500500, 1786500000);
