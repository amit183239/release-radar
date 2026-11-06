import { describe, it, expect } from 'vitest'
import {
  parseMapping,
  deriveFamilies,
  scopePath,
  scopeFilesToApps,
  prScopesToApp,
} from '../lib/app-scoping'

const MAPPING = JSON.stringify({
  projects: {
    'billing-marketplace-backend': 'apps/billing/backend',
    'platform-app-api': 'apps/platform/app-api',
    search: 'apps/search',
    'providers-billing-sdk': 'libs/providers/billing/sdk',
    'ui-kit': 'libs/ui-kit',
  },
})

describe('deriveFamilies', () => {
  it('groups app paths by their second segment', () => {
    const fams = deriveFamilies(parseMapping(MAPPING)).map((f) => f.slug)
    expect(fams).toEqual(['billing', 'platform', 'search'])
  })
})

describe('scopePath', () => {
  const families = new Set(['billing', 'platform', 'search'])

  it('maps apps/<family>/** to the family', () => {
    expect(scopePath('apps/billing/backend/src/x.ts', families, 'platform')).toBe(
      'billing'
    )
  })
  it('maps a lib named for a family to that family', () => {
    expect(
      scopePath('libs/providers/billing/sdk/index.ts', families, 'shared')
    ).toBe('billing')
  })
  it('buckets a genuinely-shared lib under the shared bucket', () => {
    expect(scopePath('libs/ui-kit/button.ts', families, 'platform')).toBe(
      'platform'
    )
  })
  it('buckets root/config paths under the shared bucket', () => {
    expect(scopePath('.github/workflows/deploy.yml', families, 'platform')).toBe(
      'platform'
    )
  })
})

describe('scopeFilesToApps', () => {
  const families = new Set(['billing', 'platform'])

  it('unions and de-dupes owning apps across changed files', () => {
    const apps = scopeFilesToApps(
      [
        'apps/billing/backend/a.ts',
        'apps/billing/backend/b.ts',
        'libs/ui-kit/x.ts',
      ],
      families,
      'platform'
    )
    expect(apps).toEqual(['billing', 'platform'])
  })

  it('never leaves a release unscoped — empty files fall back to the bucket', () => {
    expect(scopeFilesToApps([], families, 'platform')).toEqual(['platform'])
  })
})

describe('prScopesToApp', () => {
  const fam = new Set(['billing', 'attribution', 'checkout', 'platform', 'search'])
  it('matches only the PR\'s own app', () => {
    expect(prScopesToApp(['apps/platform/web/x.ts'], 'platform', fam, 'platform')).toBe(true)
    expect(prScopesToApp(['apps/platform/web/x.ts'], 'checkout', fam, 'platform')).toBe(false)
  })
  it('a multi-app PR belongs to each of its apps', () => {
    const files = ['apps/billing/a.ts', 'apps/checkout/b.ts']
    expect(prScopesToApp(files, 'billing', fam, 'platform')).toBe(true)
    expect(prScopesToApp(files, 'checkout', fam, 'platform')).toBe(true)
    expect(prScopesToApp(files, 'platform', fam, 'platform')).toBe(false)
  })
  it('an unmapped/shared-lib PR belongs only to the shared bucket', () => {
    expect(prScopesToApp(['libs/util/x.ts'], 'platform', fam, 'platform')).toBe(true)
    expect(prScopesToApp(['libs/util/x.ts'], 'billing', fam, 'platform')).toBe(false)
  })
  it('empty files belong only to the shared bucket', () => {
    expect(prScopesToApp([], 'platform', fam, 'platform')).toBe(true)
    expect(prScopesToApp([], 'billing', fam, 'platform')).toBe(false)
  })
})
