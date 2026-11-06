import { useState } from 'react'
import { api, type RoleOption } from './api'

export function RolePicker({ roles, current, onChosen }: {
  roles: RoleOption[]
  current: string
  onChosen: (role: string) => void
}) {
  const [sel, setSel] = useState(current)
  const [saving, setSaving] = useState(false)
  const label = roles.find((r) => r.key === sel)?.label ?? sel
  return (
    <div className="gate">
      <h2>Choose your view</h2>
      <p className="lede muted">Release Radar tailors the changelog and your insights to your role. You can change this any time in Settings.</p>
      <div className="roles">
        {roles.map((r) => (
          <button type="button" key={r.key} className={`rolecard${sel === r.key ? ' sel' : ''}`} aria-pressed={sel === r.key} onClick={() => setSel(r.key)}>
            <span className="rname">{r.label}</span>
            <span className="rblurb muted">{r.blurb}</span>
          </button>
        ))}
      </div>
      <button type="button"
        className="btn primary cont"
        disabled={saving}
        onClick={() => { setSaving(true); api.setRole(sel).then(() => onChosen(sel)).catch(() => setSaving(false)) }}
      >
        {saving ? 'Saving…' : `Continue as ${label} →`}
      </button>
    </div>
  )
}
