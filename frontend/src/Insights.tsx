// frontend/src/Insights.tsx
import { useEffect, useState } from 'react'
import { api, type InsightsResult } from './api'

const WINDOWS = [3, 7, 14, 30]

export function Insights({ role, app }: { role: string; app?: string }) {
  const [win, setWin] = useState(7)
  const [data, setData] = useState<InsightsResult | null>(null)
  useEffect(() => {
    let live = true
    setData(null)
    api.insights(role, win, app).then((d) => { if (live) setData(d) }).catch(() => {})
    return () => { live = false }
  }, [role, win, app])
  if (!data) return <p className="muted">Loading…</p>

  const maxPrs = Math.max(1, ...data.series.map((d) => d.prs))

  return (
    <>
      {!app && (
        <div className="row">
          <h2 style={{ margin: 0 }}>Insights</h2><div style={{ flex: 1 }} />
          <span className="win">
            {WINDOWS.map((d) => (
              <button type="button" key={d} className={win === d ? 'on' : ''} aria-pressed={win === d}
                onClick={() => setWin(d)}>{d}d</button>
            ))}
          </span>
        </div>
      )}

      <div className={app ? 'strip' : 'stat-cards'}>
        {data.cards.map((crd) => (
          <div className={app ? 'ministat' : 'stat'} key={crd.key}>
            <span className={app ? 'v' : 'val'}>{crd.value}</span>
            <span className={app ? 'l' : 'lbl'}>{crd.label}</span>
            {!app && crd.hint && <span className="hint">{crd.hint}</span>}
          </div>
        ))}
      </div>

      {!app && (
        <>
          <div className="hl-h">Daily activity — PRs shipped</div>
          <div className="daychart">
            {data.series.map((d) => (
              <div key={d.day} className="daycol" title={`${d.day}: ${d.prs} PRs, ${d.releases} releases`}>
                <div className="daybar" style={{ height: `${Math.round((d.prs / maxPrs) * 100)}%` }} />
                <span className="dtick">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>

          <div className="hl-h">Major changes</div>
          <ul className="hl">
            {data.major.map((m, i) => (
              <li key={m.pr_number ?? `${m.reason}-${i}`}>
                <span className={`rtag ${m.reason}`}>{m.reason}</span>
                <span className="app">{m.app}</span>
                <span className="htext">{m.title}</span>
                {m.pr_number && (m.url
                  ? <a className="pr" href={m.url} target="_blank" rel="noreferrer">#{m.pr_number}</a>
                  : <span className="pr">#{m.pr_number}</span>)}
              </li>
            ))}
            {data.major.length === 0 && <li className="muted small">No major changes in this window.</li>}
          </ul>
        </>
      )}
    </>
  )
}
