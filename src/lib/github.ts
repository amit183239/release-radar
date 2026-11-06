/**
 * Minimal GitHub GraphQL + REST client for the poll. fetch + Web Crypto only
 * (no @octokit). Auth is a fine-grained, read-only PAT in a Worker secret.
 *
 * Rate-limit hygiene (§2): conditional GETs (ETag), `updated:>cursor` search
 * windows, and pagination caps keep a full sweep well inside the 5,000 req/hr
 * budget. Every call has a wall-time cap so a hung upstream can't stall a tick.
 */

const GITHUB_API = 'https://api.github.com'
const GRAPHQL_URL = `${GITHUB_API}/graphql`
const REQUEST_TIMEOUT_MS = 15_000
/** GitHub asks integrations to send a descriptive UA. */
const USER_AGENT = 'release-radar (+https://github.com/amit183239/release-radar)'

export class GitHubApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  )
}

/** A prod tag resolved to its underlying commit + its ordering timestamp. */
export interface ResolvedTag {
  name: string
  /** SHA of the commit the tag points at (annotated tag's target, or the
   *  commit itself for a lightweight tag). */
  commitSha: string
  /** Epoch seconds. tagger.date for an annotated tag (the deploy-order signal);
   *  falls back to the commit's committedDate for a lightweight tag. */
  createdAt: number
  /** True when the timestamp came from committedDate (lightweight tag) rather
   *  than tagger.date — a weaker ordering signal, surfaced for diagnostics. */
  lightweight: boolean
}

/** One commit in a compare response. */
export interface CompareCommit {
  sha: string
  /** Full commit message; the subject is the first line. */
  message: string
  authorLogin: string | null
}

/** Result of a three-dot compare (base...head). */
export interface CompareResult {
  /** 'ahead' | 'behind' | 'identical' | 'diverged'. */
  status: string
  commits: CompareCommit[]
  /** Changed file paths (repo-relative). May be truncated at the API's 300-file
   *  cap for very large releases — acceptable for v1 scoping. */
  files: string[]
  /** True when GitHub truncated the commit/file lists (release exceeded the
   *  compare API's 250-commit / 300-file page). */
  truncated: boolean
}

/** One cached issue from the search sweep. */
export interface IssueNode {
  number: number
  title: string
  state: string
  labels: string[]
  milestone: string | null
  url: string
  updatedAt: number // epoch seconds
  /** GitHub issue type name (e.g. "Bug"); null unless the org configures issue types. */
  issueType?: string | null
  /** Conversation comment count (re-surface baseline). */
  commentsCount?: number | null
}

/** One cached PR from the search sweep. */
export interface PullRequestNode {
  number: number
  title: string
  state: string
  authorLogin: string | null
  labels: string[]
  /** Issue numbers this PR closes (via `closes #N` / linked issues). */
  closesIssues: number[]
  updatedAt: number // epoch seconds
  mergedAt: number | null
  url: string
  /** PR body markdown (for `## Release Note` curated-copy extraction). */
  body: string | null
  /** Changed file paths (repo-relative). Truncated at 100 — acceptable for v1 scoping. */
  files: string[]
  /** Milestone title, or null. */
  milestone?: string | null
  /** Conversation comment count (excludes review comments) — re-surface baseline. */
  commentsCount?: number | null
}

interface ItemsPage<T> {
  items: T[]
  hasNextPage: boolean
  endCursor: string | null
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly ownerRepo: string
  ) {}

  private get owner(): string {
    return this.ownerRepo.split('/')[0]!
  }
  private get repo(): string {
    return this.ownerRepo.split('/')[1]!
  }

  private baseHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  }

  // -------------------------------------------------------------------------
  // GraphQL
  // -------------------------------------------------------------------------
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    let res: Response
    try {
      res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      if (isAbortError(e)) {
        throw new GitHubApiError('GraphQL request timed out', 0)
      }
      throw new GitHubApiError(`GraphQL request failed: ${String(e)}`, 0)
    }
    if (!res.ok) {
      throw new GitHubApiError(`GraphQL returned ${res.status}`, res.status)
    }
    const body = (await res.json()) as {
      data?: T
      errors?: Array<{ message: string }>
    }
    if (body.errors && body.errors.length > 0) {
      throw new GitHubApiError(
        `GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
        200
      )
    }
    if (!body.data) {
      throw new GitHubApiError('GraphQL response missing data', 200)
    }
    return body.data
  }

  // -------------------------------------------------------------------------
  // REST (with optional conditional GET)
  // -------------------------------------------------------------------------
  /**
   * Conditional GET. Returns `{ notModified: true }` on a 304 (caller reuses
   * its cached copy), else the parsed JSON plus the fresh ETag to persist.
   */
  private async restGet<T>(
    path: string,
    etag?: string | null
  ): Promise<{ notModified: boolean; etag: string | null; json: T | null }> {
    const headers: Record<string, string> = this.baseHeaders()
    if (etag) headers['If-None-Match'] = etag
    let res: Response
    try {
      res = await fetch(`${GITHUB_API}${path}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      if (isAbortError(e)) throw new GitHubApiError(`GET ${path} timed out`, 0)
      throw new GitHubApiError(`GET ${path} failed: ${String(e)}`, 0)
    }
    if (res.status === 304) {
      return { notModified: true, etag: etag ?? null, json: null }
    }
    if (!res.ok) {
      throw new GitHubApiError(`GET ${path} returned ${res.status}`, res.status)
    }
    const json = (await res.json()) as T
    return { notModified: false, etag: res.headers.get('etag'), json }
  }

  // -------------------------------------------------------------------------
  // Tags — list refs under refs/tags with the underlying commit + timestamp.
  // The caller filters by the release-tag pattern and sorts by createdAt
  // (tagger.date). We paginate DESC by commit date and let the caller stop
  // once tags are older than the app's last_ref.
  // -------------------------------------------------------------------------
  async fetchTagsPage(cursor: string | null): Promise<ItemsPage<ResolvedTag>> {
    const query = `
      query($owner:String!, $repo:String!, $cursor:String) {
        repository(owner:$owner, name:$repo) {
          refs(refPrefix:"refs/tags/", first:100, after:$cursor,
               orderBy:{field:TAG_COMMIT_DATE, direction:DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              target {
                __typename
                ... on Tag { tagger { date } target { __typename ... on Commit { oid } } }
                ... on Commit { oid committedDate }
              }
            }
          }
        }
      }`
    type Resp = {
      repository: {
        refs: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
          nodes: Array<{
            name: string
            target:
              | {
                  __typename: 'Tag'
                  tagger: { date: string } | null
                  target: { __typename: string; oid?: string } | null
                }
              | { __typename: 'Commit'; oid: string; committedDate: string }
              | { __typename: string }
          }>
        }
      }
    }
    const data = await this.graphql<Resp>(query, {
      owner: this.owner,
      repo: this.repo,
      cursor,
    })
    const refs = data.repository.refs
    const items: ResolvedTag[] = []
    for (const node of refs.nodes) {
      const t = node.target
      if (t.__typename === 'Tag') {
        const tag = t as Extract<typeof t, { __typename: 'Tag' }>
        const commitOid = tag.target?.oid
        const dateStr = tag.tagger?.date
        if (!commitOid || !dateStr) continue
        items.push({
          name: node.name,
          commitSha: commitOid,
          createdAt: Math.floor(new Date(dateStr).getTime() / 1000),
          lightweight: false,
        })
      } else if (t.__typename === 'Commit') {
        const commit = t as Extract<typeof t, { __typename: 'Commit' }>
        items.push({
          name: node.name,
          commitSha: commit.oid,
          createdAt: Math.floor(new Date(commit.committedDate).getTime() / 1000),
          lightweight: true,
        })
      }
    }
    return {
      items,
      hasNextPage: refs.pageInfo.hasNextPage,
      endCursor: refs.pageInfo.endCursor,
    }
  }

  // -------------------------------------------------------------------------
  // Compare — three-dot base...head (commits reachable from head not base).
  // -------------------------------------------------------------------------
  async compare(base: string, head: string): Promise<CompareResult> {
    const path = `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(
      base
    )}...${encodeURIComponent(head)}`
    const { json } = await this.restGet<{
      status: string
      commits: Array<{
        sha: string
        commit: { message: string }
        author: { login: string } | null
      }>
      files?: Array<{ filename: string }>
      total_commits: number
    }>(path)
    if (!json) throw new GitHubApiError(`compare ${base}...${head} empty`, 200)
    const commits: CompareCommit[] = json.commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      authorLogin: c.author?.login ?? null,
    }))
    return {
      status: json.status,
      commits,
      files: (json.files ?? []).map((f) => f.filename),
      // The compare API returns at most 250 commits / 300 files per call.
      truncated: json.total_commits > commits.length,
    }
  }

  // -------------------------------------------------------------------------
  // Repo content — used to fetch mapping.json (path->app), conditionally.
  // -------------------------------------------------------------------------
  async getContent(
    path: string,
    etag?: string | null
  ): Promise<{ notModified: boolean; etag: string | null; text: string | null }> {
    const apiPath = `/repos/${this.owner}/${this.repo}/contents/${path}`
    const { notModified, etag: newEtag, json } = await this.restGet<{
      content: string
      encoding: string
    }>(apiPath, etag)
    if (notModified) return { notModified: true, etag: newEtag, text: null }
    if (!json) return { notModified: false, etag: newEtag, text: null }
    const text =
      json.encoding === 'base64'
        ? // base64 may contain newlines per GitHub; strip before decode.
          new TextDecoder().decode(
            Uint8Array.from(atob(json.content.replace(/\n/g, '')), (ch) =>
              ch.charCodeAt(0)
            )
          )
        : json.content
    return { notModified: false, etag: newEtag, text }
  }

  // -------------------------------------------------------------------------
  // PR search — one org-wide GraphQL search window (`updated:>=cursor`) that
  // feeds the entity cache and `closes #N` linkage. Paginated by the caller.
  // -------------------------------------------------------------------------
  async searchPullRequestsPage(
    updatedSinceISO: string,
    cursor: string | null
  ): Promise<ItemsPage<PullRequestNode>> {
    const searchQuery = `repo:${this.ownerRepo} is:pr updated:>=${updatedSinceISO} sort:updated-asc`
    const query = `
      query($q:String!, $cursor:String) {
        search(query:$q, type:ISSUE, first:50, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on PullRequest {
              number title state url updatedAt mergedAt body
              author { login }
              labels(first:20) { nodes { name } }
              closingIssuesReferences(first:20) { nodes { number } }
              files(first:100) { nodes { path } }
              milestone { title }
              comments { totalCount }
            }
          }
        }
      }`
    type Resp = {
      search: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<
          | {
              __typename: 'PullRequest'
              number: number
              title: string
              state: string
              url: string
              updatedAt: string
              mergedAt: string | null
              body: string | null
              author: { login: string } | null
              labels: { nodes: Array<{ name: string }> }
              closingIssuesReferences: { nodes: Array<{ number: number }> }
              files: { nodes: Array<{ path: string }> }
              milestone: { title: string } | null
              comments: { totalCount: number }
            }
          | { __typename: string }
        >
      }
    }
    const data = await this.graphql<Resp>(query, { q: searchQuery, cursor })
    const items: PullRequestNode[] = []
    for (const node of data.search.nodes) {
      if (node.__typename !== 'PullRequest') continue
      const pr = node as Extract<typeof node, { __typename: 'PullRequest' }>
      items.push({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        authorLogin: pr.author?.login ?? null,
        labels: pr.labels.nodes.map((l) => l.name),
        closesIssues: pr.closingIssuesReferences.nodes.map((i) => i.number),
        updatedAt: Math.floor(new Date(pr.updatedAt).getTime() / 1000),
        mergedAt: pr.mergedAt
          ? Math.floor(new Date(pr.mergedAt).getTime() / 1000)
          : null,
        url: pr.url,
        body: pr.body ?? null,
        files: pr.files.nodes.map((f) => f.path),
        milestone: pr.milestone?.title ?? null,
        commentsCount: pr.comments?.totalCount ?? null,
      })
    }
    return {
      items,
      hasNextPage: data.search.pageInfo.hasNextPage,
      endCursor: data.search.pageInfo.endCursor,
    }
  }

  // -------------------------------------------------------------------------
  // Issue search — a SEPARATE GraphQL query (is:issue, no body/mergedAt/
  // closingIssuesReferences, has milestone { title }). Feeds the issue entity
  // cache. Paginated by the caller.
  // -------------------------------------------------------------------------
  async searchIssuesPage(
    updatedSinceISO: string,
    cursor: string | null
  ): Promise<ItemsPage<IssueNode>> {
    const searchQuery = `repo:${this.ownerRepo} is:issue updated:>=${updatedSinceISO} sort:updated-asc`
    const query = `
      query($q:String!, $cursor:String) {
        search(query:$q, type:ISSUE, first:50, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on Issue {
              number title state url updatedAt
              labels(first:20) { nodes { name } }
              milestone { title }
              issueType { name }
              comments { totalCount }
            }
          }
        }
      }`
    type Resp = {
      search: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<
          | {
              __typename: 'Issue'
              number: number
              title: string
              state: string
              url: string
              updatedAt: string
              labels: { nodes: Array<{ name: string }> }
              milestone: { title: string } | null
              issueType: { name: string } | null
              comments: { totalCount: number }
            }
          | { __typename: string }
        >
      }
    }
    const data = await this.graphql<Resp>(query, { q: searchQuery, cursor })
    const items: IssueNode[] = []
    for (const node of data.search.nodes) {
      if (node.__typename !== 'Issue') continue
      const iss = node as Extract<typeof node, { __typename: 'Issue' }>
      items.push({
        number: iss.number,
        title: iss.title,
        state: iss.state,
        labels: iss.labels.nodes.map((l) => l.name),
        milestone: iss.milestone?.title ?? null,
        url: iss.url,
        updatedAt: Math.floor(new Date(iss.updatedAt).getTime() / 1000),
        issueType: iss.issueType?.name ?? null,
        commentsCount: iss.comments?.totalCount ?? null,
      })
    }
    return { items, hasNextPage: data.search.pageInfo.hasNextPage, endCursor: data.search.pageInfo.endCursor }
  }
}
