// src/lib/insights.ts
/**
 * Role-specific insights. Computes each role's card set + highlight list over a
 * time window from releases/notes/entities. Pure aggregation given a D1 handle;
 * the role registry decides which cards/highlights to return.
 */
import { getRole } from './roles'

export interface InsightCard { key: string; label: string; value: number; hint?: string }
export interface Highlight { title: string; app: string; pr_number?: number; url?: string }
/** One calendar day of activity within the window (for the daily trend). */
export interface DayPoint { day: string; prs: number; releases: number }
/** A notable change: a breaking/feature PR or a divergent release. */
export interface MajorChange { title: string; app: string; pr_number?: number; url?: string; reason: string }
export interface InsightsResult {
  window: number
  cards: InsightCard[]
  highlights: Highlight[]
  series: DayPoint[]
  major: MajorChange[]
}

interface NoteRow {
  app: string
  pr_number: number
  customer_facing: number
  copy_source: string | null
  customer_source: string | null
  note_customer: string | null
  note_technical: string | null
  url: string | null
  labels_json: string | null
  closes_json: string | null
  deployed_at: number
}
interface RelRow { id: string; app: string; tag: string; deployed_at: number; divergent: number }

const CARD_LABELS: Record<string, string> = {
  prs: 'PRs shipped', releases: 'Releases', divergent: 'Divergent releases', breaking: 'Breaking changes',
  customer_facing: 'Customer-facing changes', issues_resolved: 'Issues resolved', apps_impact: 'Apps with impact',
  ai_summarized: 'AI-summarized', bugs: 'Bugs fixed', regressions: 'Regressions',
  features: 'New features', enhancements: 'Enhancements', talking_points: 'Talking points',
  prs_by_app: 'Apps shipping PRs', feature_fix_ratio: 'Feature-vs-fix %', customer_facing_share: 'Customer-facing %',
}

function labels(n: NoteRow): string[] {
  try { const v = JSON.parse(n.labels_json ?? '[]'); return Array.isArray(v) ? v.map((s: string) => String(s).toLowerCase()) : [] }
  catch { return [] }
}
function closesCount(n: NoteRow): number {
  try { const v = JSON.parse(n.closes_json ?? '[]'); return Array.isArray(v) ? v.length : 0 }
  catch { return 0 }
}
const hasLabel = (n: NoteRow, l: string) => labels(n).includes(l)

const METRICS: Record<string, (notes: NoteRow[], rels: RelRow[]) => number> = {
  prs: (n) => n.length,
  prs_by_app: (n) => new Set(n.map((x) => x.app)).size,
  releases: (_n, r) => r.length,
  divergent: (_n, r) => r.filter((x) => x.divergent === 1).length,
  breaking: (n) => n.filter((x) => hasLabel(x, 'breaking-change')).length,
  bugs: (n) => n.filter((x) => hasLabel(x, 'bug')).length,
  regressions: (n) => n.filter((x) => hasLabel(x, 'regression')).length,
  features: (n) => n.filter((x) => hasLabel(x, 'feature')).length,
  enhancements: (n) => n.filter((x) => hasLabel(x, 'enhancement')).length,
  talking_points: (n) => n.filter((x) => x.customer_facing === 1 && (hasLabel(x, 'feature') || hasLabel(x, 'enhancement'))).length,
  customer_facing: (n) => n.filter((x) => x.customer_facing === 1).length,
  issues_resolved: (n) => n.reduce((s, x) => s + closesCount(x), 0),
  ai_summarized: (n) => n.filter((x) => x.customer_source === 'ai').length,
  // Intentionally counts distinct apps among customer-facing notes (used by the customer-voice roles CX + Sales).
  apps_impact: (n) => new Set(n.filter((x) => x.customer_facing === 1).map((x) => x.app)).size,
  feature_fix_ratio: (n) => {
    const feat = n.filter((x) => hasLabel(x, 'feature') || hasLabel(x, 'enhancement')).length
    const fix = n.filter((x) => hasLabel(x, 'bug') || hasLabel(x, 'regression')).length
    return fix === 0 ? (feat > 0 ? 100 : 0) : Math.round((feat / (feat + fix)) * 100)
  },
  customer_facing_share: (n) => (n.length === 0 ? 0 : Math.round((n.filter((x) => x.customer_facing === 1).length / n.length) * 100)),
}

function buildHighlights(kind: string, notes: NoteRow[]): Highlight[] {
  const pick = (rows: NoteRow[]) =>
    rows.slice(0, 6).map((n) => ({
      title: n.note_customer ?? n.note_technical ?? `#${n.pr_number}`,
      app: n.app, pr_number: n.pr_number, url: n.url ?? undefined,
    }))
  switch (kind) {
    case 'customer_changes':
    case 'talking_points':
      return pick(notes.filter((n) => n.customer_facing === 1))
    case 'breaking_and_regressions':
      return pick(notes.filter((n) => hasLabel(n, 'breaking-change') || hasLabel(n, 'regression')))
    case 'active_apps':
    case 'themes':
    default:
      return pick(notes)
  }
}

export async function computeInsights(
  db: D1Database,
  opts: { repo: string; roleKey: string; windowDays: number; app?: string; now: number }
): Promise<InsightsResult> {
  const role = getRole(opts.roleKey)
  const since = opts.now - opts.windowDays * 86_400

  const relSql =
    `SELECT id, app, tag, deployed_at, divergent FROM releases
      WHERE deployed_at >= ?1 ${opts.app ? 'AND app = ?2' : ''}`
  const rels = (
    await (opts.app
      ? db.prepare(relSql).bind(since, opts.app)
      : db.prepare(relSql).bind(since)
    ).all<RelRow>()
  ).results ?? []

  const noteSql =
    `SELECT n.app, n.pr_number, n.customer_facing, n.copy_source, n.customer_source,
            n.note_customer, n.note_technical, n.url, e.labels_json, e.closes_json,
            r.deployed_at AS deployed_at
       FROM notes n
       JOIN releases r ON r.id = n.release_id
       LEFT JOIN entities e ON e.repo = ?1 AND e.kind = 'pr' AND e.number = n.pr_number
      WHERE r.deployed_at >= ?2 ${opts.app ? 'AND n.app = ?3' : ''}
      ORDER BY r.deployed_at DESC`
  const notes = (
    await (opts.app
      ? db.prepare(noteSql).bind(opts.repo, since, opts.app)
      : db.prepare(noteSql).bind(opts.repo, since)
    ).all<NoteRow>()
  ).results ?? []

  const cards: InsightCard[] = role.insights.cards.map((key) => ({
    key,
    label: CARD_LABELS[key] ?? key,
    value: (METRICS[key] ?? (() => 0))(notes, rels),
  }))

  const series = buildSeries(notes, rels, opts.now, opts.windowDays)
  const major = buildMajor(notes, rels)

  return {
    window: opts.windowDays,
    cards,
    highlights: buildHighlights(role.insights.highlights, notes),
    series,
    major,
  }
}

/** UTC YYYY-MM-DD for an epoch-seconds timestamp; '' for a bad value. */
function dayKey(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return ''
  return new Date(epochSec * 1000).toISOString().slice(0, 10)
}

/** One bucket per calendar day across the window (oldest→newest), zeros filled. */
function buildSeries(notes: NoteRow[], rels: RelRow[], now: number, windowDays: number): DayPoint[] {
  const prByDay = new Map<string, number>()
  for (const n of notes) {
    const k = dayKey(n.deployed_at)
    if (k) prByDay.set(k, (prByDay.get(k) ?? 0) + 1)
  }
  const relByDay = new Map<string, number>()
  for (const r of rels) {
    const k = dayKey(r.deployed_at)
    if (k) relByDay.set(k, (relByDay.get(k) ?? 0) + 1)
  }
  const out: DayPoint[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86_400)
    out.push({ day, prs: prByDay.get(day) ?? 0, releases: relByDay.get(day) ?? 0 })
  }
  return out
}

/** Major changes = divergent releases + breaking-change PRs + feature/enhancement
 *  PRs, newest first, capped. Routine fixes/chores are excluded. */
function buildMajor(notes: NoteRow[], rels: RelRow[]): MajorChange[] {
  const out: Array<MajorChange & { at: number }> = []
  for (const r of rels) {
    if (r.divergent === 1) out.push({ title: r.tag, app: r.app, reason: 'divergent', at: r.deployed_at })
  }
  for (const n of notes) {
    const ls = labels(n)
    const title = n.note_customer ?? n.note_technical ?? `#${n.pr_number}`
    if (ls.includes('breaking-change')) {
      out.push({ title, app: n.app, pr_number: n.pr_number, url: n.url ?? undefined, reason: 'breaking', at: n.deployed_at })
    } else if (ls.includes('feature') || ls.includes('enhancement')) {
      out.push({ title, app: n.app, pr_number: n.pr_number, url: n.url ?? undefined, reason: 'feature', at: n.deployed_at })
    }
  }
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, 20).map(({ at: _at, ...m }) => m)
}
