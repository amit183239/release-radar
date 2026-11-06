-- migrations/0004_user_role.sql
-- Role system: an explicit first-login role pick, and role keys aligned to the
-- src/lib/roles.ts registry (legacy 'dev' -> 'developer'; 'cx' unchanged).
ALTER TABLE users ADD COLUMN role_chosen INTEGER NOT NULL DEFAULT 0;
UPDATE users SET lens_profile = 'developer' WHERE lens_profile = 'dev';
