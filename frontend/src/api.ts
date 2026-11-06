/** Typed client for the release-radar Worker API. Cookies carry the session, so
 *  every call is credentialed. A 401 throws Unauthorized so the app can show the
 *  sign-in gate. */

export class Unauthorized extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'include', ...init })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`)
  return (await res.json()) as T
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

export interface RoleOption { key: string; label: string; blurb: string; voice: 'technical' | 'customer' }
export interface Me { email: string; name: string | null; role: string; role_chosen: boolean }
export interface App { slug: string; display_name: string; visibility: string; synthetic: number; last_ref_at: number | null }
export interface Release { id: string; app: string; ref: string; tag: string; deployed_at: number; base_ref: string | null; divergent: number }
export interface Note {
  pr_number: number
  note_technical: string | null
  note_customer: string | null
  note: string | null
  copy_source: string | null
  customer_source?: string | null
  customer_facing: number
  author: string | null
  url: string | null
  labels: string[]
}
/** Activity re-surface payload (events.payload_json for kind='activity'). */
export interface ActivityPayload {
  entity_kind: 'issue' | 'pr'
  number: number
  title: string | null
  url: string | null
  state_from?: string
  state_to?: string
  new_comments?: number
}
/** One of the viewer's follows a feed item satisfies; refs are the viewer's own. */
export interface FeedMatch { type: string; ref: string; customer_ref?: string | null; ticket_ref?: string | null }
export interface FeedItem {
  id: string
  read_at: number | null
  created_at: number
  kind: string
  app: string | null
  pr_number: number | null
  tag: string | null
  note_technical: string | null
  url: string | null
  matched_type: string | null
  matched_ref: string | null
  matches: FeedMatch[]
  payload: ActivityPayload | null
  summary?: { headline: string; body: string | null; source: 'ai' | 'fallback'; role: string } | null
}
export interface Follow {
  id: string
  target_type: string
  target_ref: string
  customer_ref: string | null
  ticket_ref: string | null
  created_at: number
  entity_title?: string | null
  entity_state?: string | null
}
export interface SearchResult {
  app: string
  pr_number: number
  note_technical: string | null
  copy_source: string | null
  url: string | null
  tag: string
  deployed_at: number
}

export interface DigestItem {
  release_id: string; pr_number: number; app: string; tag: string; deployed_at: number
  headline: string; body: string | null; source: 'ai'; note_technical: string | null; url: string | null
}

export interface InsightCard { key: string; label: string; value: number; hint?: string }
export interface Highlight { title: string; app: string; pr_number?: number; url?: string }
export interface DayPoint { day: string; prs: number; releases: number }
export interface MajorChange { title: string; app: string; pr_number?: number; url?: string; reason: string }
export interface InsightsResult { window: number; cards: InsightCard[]; highlights: Highlight[]; series: DayPoint[]; major: MajorChange[] }
export interface Issue { number: number; title: string; state: string; labels: string[]; milestone: string | null; url: string }
export interface Suggestion { ref: string; title: string; state?: string | null }

export const api = {
  me: () => req<Me>('/api/me'),
  roles: () => req<{ roles: RoleOption[] }>('/api/roles').then((r) => r.roles),
  setRole: (role: string) => req<{ role: string }>('/api/me/role', jsonBody('PATCH', { role })),
  apps: () => req<{ apps: App[] }>('/api/apps').then((r) => r.apps),
  releases: (slug: string) =>
    req<{ releases: Release[] }>(`/api/apps/${encodeURIComponent(slug)}/releases`).then((r) => r.releases),
  notes: (releaseId: string, role: string) =>
    req<{ notes: Note[] }>(`/api/releases/${releaseId}/notes?role=${encodeURIComponent(role)}`).then((r) => r.notes),
  feed: (unread: boolean) =>
    req<{ items: FeedItem[] }>(`/api/feed${unread ? '?unread=1' : ''}`).then((r) => r.items),
  unreadCount: () => req<{ count: number }>('/api/notifications/unread-count').then((r) => r.count),
  markRead: (id: string) => req(`/api/feed/${id}/read`, { method: 'POST' }),
  markAllRead: () => req('/api/feed/read-all', { method: 'POST' }),
  follows: () => req<{ follows: Follow[] }>('/api/follows').then((r) => r.follows),
  follow: (target_type: string, target_ref: string, opts?: { customer_ref?: string; ticket_ref?: string }) =>
    req<{ id: string }>('/api/follows', jsonBody('POST', { target_type, target_ref, ...(opts ?? {}) })),
  unfollow: (id: string) => req(`/api/follows/${id}`, { method: 'DELETE' }),
  search: (q: string) =>
    req<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
  insights: (role: string, window: number, app?: string) =>
    req<InsightsResult>(`/api/insights?role=${encodeURIComponent(role)}&window=${window}${app ? `&app=${encodeURIComponent(app)}` : ''}`),
  issues: (limit = 50, offset = 0) =>
    req<{ issues: Issue[]; total: number }>(`/api/issues?limit=${limit}&offset=${offset}`),
  suggest: (type: string, q: string) =>
    req<{ suggestions: Suggestion[] }>(`/api/suggest?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`).then((r) => r.suggestions),
  feedDigest: () => req<{ role: string; items: DigestItem[] }>('/api/feed/digest'),
}
