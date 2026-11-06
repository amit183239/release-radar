import { describe, it, expect, vi, afterEach } from 'vitest'
import { GitHubClient } from '../lib/github'
import { FixturePollSource } from './fixtures/fixture-source'

afterEach(() => vi.unstubAllGlobals())

/** Stub fetch with a single GraphQL `data` payload; capture request bodies. */
function stubGraphql(data: unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  )
  return calls
}

const prNode = (over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest',
  number: 7,
  title: 'feat: x',
  state: 'MERGED',
  url: 'https://github.com/o/r/pull/7',
  updatedAt: '2026-11-03T10:00:00Z',
  mergedAt: '2026-11-03T09:00:00Z',
  body: null,
  author: { login: 'dev' },
  labels: { nodes: [{ name: 'bug' }] },
  closingIssuesReferences: { nodes: [{ number: 5 }] },
  files: { nodes: [{ path: 'apps/checkout/a.ts' }] },
  milestone: { title: 'Q4 Checkout' },
  comments: { totalCount: 3 },
  ...over,
})

const issueNode = (over: Record<string, unknown> = {}) => ({
  __typename: 'Issue',
  number: 92,
  title: 'Checkout breaks',
  state: 'OPEN',
  url: 'https://github.com/o/r/issues/92',
  updatedAt: '2026-11-03T10:00:00Z',
  labels: { nodes: [] },
  milestone: null,
  issueType: { name: 'Bug' },
  comments: { totalCount: 2 },
  ...over,
})

const page = (nodes: unknown[]) => ({ search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } })

describe('GitHubClient PR search fields', () => {
  it('requests milestone + comments.totalCount and maps them', async () => {
    const calls = stubGraphql(page([prNode(), prNode({ number: 8, milestone: null, comments: { totalCount: 0 } })]))
    const gh = new GitHubClient('t', 'o/r')
    const res = await gh.searchPullRequestsPage('2026-11-01', null)
    expect(calls[0]!.query).toContain('milestone { title }')
    expect(calls[0]!.query).toContain('comments { totalCount }')
    expect(res.items[0]).toMatchObject({ number: 7, milestone: 'Q4 Checkout', commentsCount: 3 })
    expect(res.items[1]).toMatchObject({ number: 8, milestone: null, commentsCount: 0 })
  })
})

describe('GitHubClient issue search fields', () => {
  it('requests issueType + comments.totalCount and maps them', async () => {
    const calls = stubGraphql(page([issueNode(), issueNode({ number: 93, issueType: null })]))
    const gh = new GitHubClient('t', 'o/r')
    const res = await gh.searchIssuesPage('2026-11-01', null)
    expect(calls[0]!.query).toContain('issueType { name }')
    expect(calls[0]!.query).toContain('comments { totalCount }')
    expect(res.items[0]).toMatchObject({ number: 92, issueType: 'Bug', commentsCount: 2 })
    expect(res.items[1]).toMatchObject({ number: 93, issueType: null, commentsCount: 2 })
  })
})

describe('FixturePollSource', () => {
  it('passes new node fields through and records search windows', async () => {
    const src = new FixturePollSource({
      mappingJson: '{}',
      tags: [],
      compares: {},
      pullRequests: [
        {
          number: 7, title: 't', state: 'MERGED', authorLogin: null, labels: [], closesIssues: [],
          updatedAt: 1, mergedAt: null, url: 'u', body: null, files: [], milestone: 'Q4', commentsCount: 4,
        },
      ],
      issuePages: [[{ number: 92, title: 'i', state: 'OPEN', labels: [], milestone: null, url: 'u', updatedAt: 1, issueType: 'Bug', commentsCount: 1 }]],
    })
    const prs = await src.searchPullRequestsPage('2026-11-01T00:00:00Z', null)
    const iss = await src.searchIssuesPage('2026-11-02T00:00:00Z', null)
    expect(prs.items[0]).toMatchObject({ milestone: 'Q4', commentsCount: 4 })
    expect(iss.items[0]).toMatchObject({ issueType: 'Bug', commentsCount: 1 })
    expect(src.prSinceCalls).toEqual(['2026-11-01T00:00:00Z'])
    expect(src.issueSinceCalls).toEqual(['2026-11-02T00:00:00Z'])
  })
})

describe('search qualifier', () => {
  it('uses updated:>= with the timestamp cursor for PRs and issues', async () => {
    const calls = stubGraphql(page([]))
    const gh = new GitHubClient('t', 'o/r')
    await gh.searchPullRequestsPage('2026-11-03T10:00:00Z', null)
    await gh.searchIssuesPage('2026-11-03T10:00:00Z', null)
    expect(calls[0]!.variables.q).toContain('updated:>=2026-11-03T10:00:00Z')
    expect(calls[1]!.variables.q).toContain('updated:>=2026-11-03T10:00:00Z')
  })
})
