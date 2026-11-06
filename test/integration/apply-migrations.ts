import { env, applyD1Migrations } from 'cloudflare:test'

// Setup files run before each test file; applyD1Migrations is idempotent
// (tracked in d1_migrations), so re-running it is a no-op.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
