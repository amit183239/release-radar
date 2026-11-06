/**
 * Chained tag attribution — the net-new correctness core (§2). Pure functions
 * over already-fetched data so the whole algorithm is unit-testable offline
 * (see the DEBUG fixture/replay mode).
 *
 * The problem: the repo publishes git tags only (no GitHub Releases), tags are
 * NOT ancestors of HEAD, and dispatch deploys from any branch — so the tagged
 * commit's committer/author date is wrong for a hotfix off an old branch. The
 * only monotonic deploy-order signal is the tag object's creation time
 * (tagger.date). We order an app's prod tags by that, chain consecutive pairs,
 * and three-dot-compare each pair to get "what this deploy added over the prev".
 */

import type { ResolvedTag } from './github'

/** One consecutive-pair release to materialize via a three-dot compare. */
export interface ReleasePair {
  /** Tag name of the head (this deploy). */
  tag: string
  /** SHA of the tagged commit (compare head). */
  headSha: string
  /** SHA of the previous prod tag in chronological order (compare base). Null
   *  only for the very first tag ever (no predecessor to diff against). */
  baseSha: string | null
  /** Epoch seconds; the head tag's creation time (deploy order + deployed_at). */
  deployedAt: number
}

/**
 * Build the chain of consecutive-pair releases to process for one app.
 *
 * @param tags   All of this app's prod tags (any order). Sorted here by
 *               createdAt asc; ties broken by name for determinism.
 * @param sinceAt Epoch seconds of the app's stored last_ref tag-creation time,
 *               or null for a full history build. Only tags STRICTLY newer than
 *               this become releases; the tag at/just-before it anchors the base
 *               of the oldest new release.
 *
 * The base of each new tag is its immediate chronological predecessor in the
 * full sorted list — which is the stored last_ref (when present) or a prior new
 * tag. Callers that don't retain the predecessor in `tags` (e.g. backfill at a
 * window edge) must fetch one tag beyond the window to anchor the oldest base.
 */
export function buildChain(
  tags: ResolvedTag[],
  sinceAt: number | null
): ReleasePair[] {
  const sorted = [...tags].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const pairs: ReleasePair[] = []
  for (let i = 0; i < sorted.length; i++) {
    const tag = sorted[i]!
    if (sinceAt !== null && tag.createdAt <= sinceAt) continue // already processed
    const predecessor = i > 0 ? sorted[i - 1]! : null
    pairs.push({
      tag: tag.name,
      headSha: tag.commitSha,
      baseSha: predecessor ? predecessor.commitSha : null,
      deployedAt: tag.createdAt,
    })
  }
  return pairs
}

/**
 * Parse the squash-merge PR number from a commit's SUBJECT-LINE SUFFIX only.
 * GitHub squash merges append `(#123)` to the PR title used as the subject.
 * Anchoring to the end of the first line avoids false positives from:
 *   - `Revert "Foo (#12)"`  (the `(#12)` is mid-line, not the suffix)
 *   - body text that mentions `(#45)` on a later line
 *
 * Returns the PR number, or null when the subject has no trailing `(#N)`.
 */
export function parseSquashPr(message: string): number | null {
  const subject = message.split('\n', 1)[0] ?? ''
  const m = subject.match(/\(#(\d+)\)\s*$/)
  if (!m) return null
  const n = Number.parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Enumerate the unique PR numbers contributing to a release, in first-seen
 * order, from its compare commits. Commits without a squash suffix (direct
 * pushes, merge commits) contribute nothing.
 */
export function enumeratePrNumbers(
  commits: Array<{ message: string }>
): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const c of commits) {
    const pr = parseSquashPr(c.message)
    if (pr !== null && !seen.has(pr)) {
      seen.add(pr)
      out.push(pr)
    }
  }
  return out
}

/** True when a compare status means the base is not an ancestor of the head. */
export function isDivergent(compareStatus: string): boolean {
  return compareStatus === 'diverged'
}
