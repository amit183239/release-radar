/**
 * Offline fixture/replay source (§7 Phase-1 requirement: "a fixture/replay
 * DEBUG mode to test the poll offline"). Implements the PollSource interface
 * against in-memory data so the whole tick — mapping seed, tag chaining,
 * compare, PR enumeration — runs deterministically with zero network.
 */
import type { PollSource } from '../../jobs/poll'
import type {
  ResolvedTag,
  CompareResult,
  PullRequestNode,
  IssueNode,
} from '../../lib/github'

export interface FixtureData {
  mappingJson: string
  tags: ResolvedTag[]
  /** Keyed by `${base}...${head}`. */
  compares: Record<string, CompareResult>
  pullRequests?: PullRequestNode[]
  issuePages?: IssueNode[][]
}

export class FixturePollSource implements PollSource {
  constructor(private readonly data: FixtureData) {}

  private issueCursor = 0
  /** Every `updatedSinceISO` the poll passed to the PR / issue search (Task 6 asserts these). */
  readonly prSinceCalls: string[] = []
  readonly issueSinceCalls: string[] = []

  async getContent(_path: string, etag?: string | null) {
    // Simulate a stable ETag; a caller that already holds it gets a 304.
    const currentEtag = 'fixture-etag-1'
    if (etag === currentEtag) {
      return { notModified: true, etag: currentEtag, text: null }
    }
    return { notModified: false, etag: currentEtag, text: this.data.mappingJson }
  }

  async fetchTagsPage(_cursor: string | null) {
    // Single page — the fixture holds the full tag set.
    return { items: this.data.tags, hasNextPage: false, endCursor: null }
  }

  async compare(base: string, head: string): Promise<CompareResult> {
    const key = `${base}...${head}`
    const cmp = this.data.compares[key]
    if (!cmp) {
      throw new Error(`fixture: no compare for ${key}`)
    }
    return cmp
  }

  async searchPullRequestsPage(
    updatedSinceISO: string,
    _cursor: string | null
  ): Promise<{ items: PullRequestNode[]; hasNextPage: boolean; endCursor: string | null }> {
    this.prSinceCalls.push(updatedSinceISO)
    return {
      items: this.data.pullRequests ?? [],
      hasNextPage: false,
      endCursor: null,
    }
  }

  async searchIssuesPage(updatedSinceISO: string, _cursor: string | null) {
    this.issueSinceCalls.push(updatedSinceISO)
    const pages = this.data.issuePages ?? []
    const items = pages[this.issueCursor] ?? []
    const hasNextPage = this.issueCursor < pages.length - 1
    this.issueCursor += 1
    return { items, hasNextPage, endCursor: hasNextPage ? String(this.issueCursor) : null }
  }
}
