import { getSummaryInputRow } from './queries'
import { stripPrSuffix } from '../ai/persona-summaries'
import type { SummaryInput, SummaryRole } from '../ai/persona-summaries'
import { parseJsonArray } from './json'

export async function buildSummaryInput(
  db: Parameters<typeof getSummaryInputRow>[0],
  a: { repo: string; app: string; prNumber: number; role: SummaryRole; noteTechnical: string | null },
): Promise<SummaryInput> {
  const row = await getSummaryInputRow(db, a.repo, a.prNumber)
  const prTitle = row?.pr_title ?? ''
  const labels = parseJsonArray(row?.labels_json ?? null).map((x) => String(x).toLowerCase())
  const linkedIssueTitles = parseJsonArray(row?.issue_titles_json ?? '[]').filter(Boolean).map((x) => String(x))
  // Drop noteTechnical when it duplicates the PR title (after stripping the (#N) suffix)
  const noteTechnical = a.noteTechnical && a.noteTechnical !== stripPrSuffix(prTitle) ? a.noteTechnical : null
  return { app: a.app, role: a.role, prTitle, releaseNote: row?.release_note ?? null, labels, linkedIssueTitles, noteTechnical }
}
