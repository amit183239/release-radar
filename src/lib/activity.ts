/**
 * Re-surface detection (spec §2c, plan §2 V12). Pure: compares an entity's
 * cached row (prior) with the freshly polled node (next) and reports only
 * MEANINGFUL activity — a state change (OPEN/CLOSED/MERGED) or a comment-count
 * increase. Label/assignee/title edits are never passed in, so never count.
 *
 * Fail-quiet rules:
 *  - no prior row (first sighting) -> null, so the first sync can't flood feeds;
 *  - prior.comments_count NULL (row predates migration 0008) -> baseline only,
 *    no comment event (state is still compared);
 *  - comment delta <= 0 (deleted comments) -> no comment event.
 */
export interface ActivityPrior {
  state: string | null
  comments_count: number | null
}

export interface ActivityNext {
  state: string
  commentsCount: number | null
}

export interface Activity {
  stateFrom?: string
  stateTo?: string
  newComments?: number
}

export function detectActivity(prior: ActivityPrior | undefined, next: ActivityNext): Activity | null {
  if (!prior) return null
  const out: Activity = {}
  if (prior.state != null && prior.state !== next.state) {
    out.stateFrom = prior.state
    out.stateTo = next.state
  }
  if (prior.comments_count != null && next.commentsCount != null) {
    const delta = next.commentsCount - prior.comments_count
    if (delta > 0) out.newComments = delta
  }
  return out.stateTo !== undefined || out.newComments !== undefined ? out : null
}
