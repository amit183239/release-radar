import { useState } from 'react'
import { api, type RoleOption } from './api'

export function Settings({ roles, current, onSaved }: {
  roles: RoleOption[]
  current: string
  onSaved: (role: string) => void
}) {
  const [sel, setSel] = useState(current)
  const [saved, setSaved] = useState(false)
  return (
    <>
      <h2>Settings</h2>
      <div className="setrow">
        <h3>Your role</h3>
        <p className="muted small">Controls how the changelog is filtered and what insights you see.</p>
        {roles.map((r) => (
          <button type="button" key={r.key} className={`opt${sel === r.key ? ' sel' : ''}`} aria-pressed={sel === r.key} onClick={() => { setSel(r.key); setSaved(false) }}>
            <span className="radio" />
            <span><span className="oname">{r.label}</span> <span className="oblurb muted">· {r.blurb}</span></span>
          </button>
        ))}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn primary" onClick={() => { api.setRole(sel).then(() => { onSaved(sel); setSaved(true) }).catch(() => {}) }}>Save role</button>
          {saved && <span className="muted small">Saved.</span>}
        </div>
      </div>
    </>
  )
}
