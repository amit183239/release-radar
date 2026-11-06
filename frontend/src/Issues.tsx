import { useEffect, useState } from 'react'
import { api, type Issue } from './api'
import { useFollows } from './follows'

export function Issues() {
  const [data, setData] = useState<{ issues: Issue[]; total: number } | null>(null)
  const follows = useFollows()
  useEffect(() => { let live = true; api.issues(100).then((d) => { if (live) setData(d) }).catch(() => {}); return () => { live = false } }, [])
  if (!data) return <p className="muted">Loading…</p>
  const items = data.issues
  return (
    <>
      <h2>Issues</h2>
      <p className="muted small">Showing {items.length} of {data.total}</p>
      <ul className="issues">
        {items.map((i) => {
          const following = follows.isFollowing('issue', String(i.number))
          return (
          <li key={i.number}>
            <span className={`state ${i.state === 'OPEN' ? 'open' : 'closed'}`}>{i.state.toLowerCase()}</span>
            <a className="inum" href={i.url} target="_blank" rel="noreferrer">#{i.number}</a>
            <span className="note-text">
              {i.title}
              {i.labels.map((l) => (
                <span key={l} className="tag" style={{ marginLeft: 6 }}>{l}</span>
              ))}
              {i.milestone && <span className="tag" style={{ marginLeft: 6 }}>{i.milestone}</span>}
            </span>
            <button type="button" className={`followpr${following ? ' on' : ''}`}
              aria-pressed={following}
              aria-label={following ? `Unfollow issue #${i.number}` : `Follow issue #${i.number}`}
              disabled={follows.loading} onClick={() => follows.toggle('issue', String(i.number))}>
              <span aria-hidden="true">🔔</span> {following ? 'Following' : 'Follow'}
            </button>
          </li>
        )
        })}
        {items.length === 0 && <li className="muted small">No issues ingested yet.</li>}
      </ul>
    </>
  )
}
