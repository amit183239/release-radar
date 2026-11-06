import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

// Runs test/integration/** inside workerd against a real (Miniflare) D1. The
// unit suite (`npm test`, vitest.config.ts) only includes src/test/**, so it never
// imports `cloudflare:test`.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './test/integration/wrangler.test.toml' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['test/integration/**/*.test.ts'],
      setupFiles: ['./test/integration/apply-migrations.ts'],
      
    },
  }
})
