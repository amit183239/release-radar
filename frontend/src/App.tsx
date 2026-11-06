import { useEffect, useRef, useState, createContext, useContext, useCallback, Fragment } from 'react'
import { Routes, Route, Link, NavLink, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { api, Unauthorized, type Me, type Note, type RoleOption, type Suggestion, type FeedItem, type DigestItem } from './api'
import { safeUrl } from './lib/safeUrl'
import { RolePicker } from './RolePicker'
import { Settings } from './Settings'
import { Insights } from './Insights'
import { FollowsProvider, useFollows } from './follows'
import { Issues } from './Issues'

// --- Auth + role context -----------------------------------------------------
interface Ctx { me: Me; role: string; setRole: (r: string) => void; roles: RoleOption[] }
const AppCtx = createContext<Ctx | null>(null)
const useApp = () => useContext(AppCtx)!

function fmtDate(epoch: number | null): string {
  if (!epoch) return '—'
  return new Date(epoch * 1000).toLocaleString()
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [state, setState] = useState<'loading' | 'anon' | 'ready'>('loading')

  useEffect(() => {
    api.me().then(
      (m) => {
        setMe(m)
        setState('ready')
        api.roles().then(setRoles).catch(() => {})
      },
      (e) => setState(e instanceof Unauthorized ? 'anon' : 'ready')
    )
  }, [])

  const setRole = useCallback((r: string) => {
    setMe((prev) => (prev ? { ...prev, role: r, role_chosen: true } : prev))
    api.setRole(r).catch(() => {})
  }, [])

  if (state === 'loading') return <div className="center muted">Loading…</div>
  if (state === 'anon' || !me) return <Login />

  if (!me.role_chosen) {
    return (
      <main className="container">
        <RolePicker roles={roles} current={me.role}
          onChosen={(r) => setMe((prev) => (prev ? { ...prev, role: r, role_chosen: true } : prev))} />
      </main>
    )
  }

  return (
    <AppCtx.Provider value={{ me, role: me.role, setRole, roles }}>
      <FollowsProvider>
        <TopBar />
        <main className="container">
          <Routes>
            <Route path="/" element={<AppsPage />} />
            <Route path="/apps/:slug" element={<ChangelogPage />} />
            <Route path="/feed" element={<FeedPage />} />
            <Route path="/follows" element={<FollowsPage />} />
            <Route path="/issues" element={<Issues />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="*" element={<div className="muted">Not found.</div>} />
          </Routes>
        </main>
      </FollowsProvider>
    </AppCtx.Provider>
  )
}

function Login() {
  return (
    <div className="center">
      <h1>Release Radar</h1>
      <p className="muted">Per-app release changelog, SSO-gated.</p>
      <a className="btn primary" href="/auth/login">Sign in</a>
      {/* DEBUG-only: works solely when the Worker runs with DEBUG=true (local). */}
      <a className="btn ghost small" href="/auth/dev-login">Dev sign-in (local)</a>
    </div>
  )
}

function TopBar() {
  const { me } = useApp()
  const [unread, setUnread] = useState(0)
  const nav = useNavigate()
  const [q, setQ] = useState('')

  useEffect(() => {
    const load = () => api.unreadCount().then(setUnread).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <header className="topbar">
      <Link to="/" className="brand">◎ Release Radar</Link>
      <form
        className="search"
        onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`) }}
      >
        <input placeholder="Search changelog…" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <nav className="nav">
        <NavLink to="/feed">Feed{unread > 0 && <span className="badge">{unread}<span className="sr-only"> unread</span></span>}</NavLink>
        <NavLink to="/follows">Follows</NavLink>
        <NavLink to="/issues">Issues</NavLink>
        <NavLink to="/insights">Insights</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <span className="rolepill">{me.role}</span>
        <span className="muted email" title={me.email}>{me.email}</span>
        <a className="btn ghost" href="/auth/logout">Sign out</a>
      </nav>
    </header>
  )
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; err: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    fn().then(
      (d) => { if (live) { setData(d); setErr(null); setLoading(false) } },
      (e) => { if (live) { setErr(String(e)); setLoading(false) } }
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, err, loading }
}

function AppsPage() {
  const { data, loading } = useAsync(() => api.apps(), [])
  return (
    <>
      <h2>Apps</h2>
      {loading ? <p className="muted">Loading…</p> : (
        <ul className="cards">
          {(data ?? []).map((a) => (
            <li key={a.slug} className="card">
              <Link to={`/apps/${a.slug}`}>{a.display_name}</Link>
              {a.synthetic ? <span className="tag">shared</span> : null}
              <div className="muted small">last ship: {fmtDate(a.last_ref_at)}</div>
            </li>
          ))}
          {data && data.length === 0 && <p className="muted">No apps yet — the poll seeds these from mapping.json.</p>}
        </ul>
      )}
    </>
  )
}

function ChangelogPage() {
  const { slug = '' } = useParams()
  const { role } = useApp()
  const { data, loading } = useAsync(() => api.releases(slug), [slug])
  const follows = useFollows()

  return (
    <>
      <div className="row">
        <h2>{slug}</h2>
        <button type="button" className="btn ghost" disabled={follows.loading}
          aria-pressed={follows.isFollowing('app', slug)}
          onClick={() => follows.toggle('app', slug)}>
          {follows.isFollowing('app', slug) ? '✓ Following app' : 'Follow app'}
        </button>
      </div>
      <Insights role={role} app={slug} />
      {loading ? <p className="muted">Loading…</p> : (
        <div className="timeline">
          {(data ?? []).map((r) => (
            <ReleaseBlock key={r.id} id={r.id} tag={r.tag} at={r.deployed_at} divergent={!!r.divergent} role={role} />
          ))}
          {data && data.length === 0 && <p className="muted">No releases recorded yet.</p>}
        </div>
      )}
    </>
  )
}

function ReleaseBlock(props: { id: string; tag: string; at: number; divergent: boolean; role: string }) {
  const { data } = useAsync(() => api.notes(props.id, props.role), [props.id, props.role])
  return (
    <section className="release">
      <div className="release-head">
        <strong>{props.tag}</strong>
        <span className="muted small">{fmtDate(props.at)}</span>
        {props.divergent && <span className="tag warn">divergent</span>}
      </div>
      <ul className="notes">
        {(data ?? []).map((n) => <NoteRow key={n.pr_number} n={n} />)}
        {data && data.length === 0 && <li className="muted small">No {props.role === 'cx' ? 'customer-facing ' : ''}changes.</li>}
      </ul>
    </section>
  )
}

function NoteRow({ n }: { n: Note }) {
  const curated = n.copy_source === 'human'
  const text = n.note ?? n.note_technical
  const follows = useFollows()
  return (
    <li className="note">
      <span className={`dot ${curated ? 'curated' : 'fallback'}`} title={curated ? 'curated' : 'from PR title'} />
      <span className="note-text">
        {text ?? '(no note)'}
        {n.labels.length > 0 && (
          <span className="chips">
            {n.labels.map((l) => (
              <button type="button" key={l} className={`chip${follows.isFollowing('label', l) ? ' on' : ''}`}
                disabled={follows.loading} title={`Follow label "${l}"`}
                aria-pressed={follows.isFollowing('label', l)}
                aria-label={`Follow label "${l}"`}
                onClick={() => follows.toggle('label', l)}>
                {l}<span className="plus" aria-hidden="true">{follows.isFollowing('label', l) ? '✓' : '+'}</span>
              </button>
            ))}
          </span>
        )}
      </span>
      <button type="button" className={`followpr${follows.isFollowing('pr', String(n.pr_number)) ? ' on' : ''}`}
        disabled={follows.loading}
        aria-pressed={follows.isFollowing('pr', String(n.pr_number))}
        aria-label={`Follow PR #${n.pr_number}`}
        onClick={() => follows.toggle('pr', String(n.pr_number))}>
        <span aria-hidden="true">🔔</span> {follows.isFollowing('pr', String(n.pr_number)) && <span aria-hidden="true">✓ </span>}Follow PR
      </button>
      {n.url ? <a className="pr" href={n.url} target="_blank" rel="noreferrer">#{n.pr_number}</a> : <span className="pr muted">#{n.pr_number}</span>}
      {n.customer_source === 'ai' && <span className="tag ai">auto-generated</span>}
    </li>
  )
}

/** "Shipped for: ACME-123 · ZD-4512". Refs are opaque, viewer-owned text; a
 *  ticket ref renders as a link only when safeUrl() accepts it (https only). */
function RefLine({ prefix, customers, tickets }: { prefix: string; customers: string[]; tickets: string[] }) {
  if (customers.length === 0 && tickets.length === 0) return null
  const items = [
    ...customers.map((c) => <span key={`c:${c}`}>{c}</span>),
    ...tickets.map((t) => {
      const href = safeUrl(t)
      return href
        ? <a key={`t:${t}`} href={href} target="_blank" rel="noreferrer">{t}</a>
        : <span key={`t:${t}`}>{t}</span>
    }),
  ]
  return (
    <span className="refline">
      {prefix ? `${prefix} ` : null}
      {items.map((el, i) => <Fragment key={i}>{i > 0 ? ' · ' : null}{el}</Fragment>)}
    </span>
  )
}

/** Deduped viewer refs across all of a feed item's matches. */
function refsOf(f: FeedItem): { customers: string[]; tickets: string[] } {
  const customers = new Set<string>()
  const tickets = new Set<string>()
  for (const m of f.matches) {
    if (m.customer_ref) customers.add(m.customer_ref)
    if (m.ticket_ref) tickets.add(m.ticket_ref)
  }
  return { customers: [...customers], tickets: [...tickets] }
}

/** "PR #140 merged", "Issue #92 · +3 comments", "Issue #92 closed — not shipped yet".
 *  Closed is not deployed: an issue closing is NOT a ship. */
function activityText(p: NonNullable<FeedItem['payload']>): string {
  const head = `${p.entity_kind === 'issue' ? 'Issue' : 'PR'} #${p.number}`
  let state = ''
  if (p.state_to) {
    const to = p.state_to.toUpperCase()
    if (to === 'MERGED') state = 'merged'
    else if (to === 'CLOSED') state = p.entity_kind === 'issue' ? 'closed — not shipped yet' : 'closed'
    else if (to === 'OPEN') state = 'reopened'
    else state = p.state_to.toLowerCase()
  }
  const comments = p.new_comments ? `+${p.new_comments} comment${p.new_comments === 1 ? '' : 's'}` : ''
  return `${head}${state ? ` ${state}` : ''}${comments ? ` · ${comments}` : ''}`
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(timer.current) }
  }, [])
  const flash = (ok: boolean) => {
    if (!mounted.current) return
    setCopied(ok); setFailed(!ok)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { setCopied(false); setFailed(false) }, 1500)
  }
  const copy = () => {
    Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => flash(true)).catch(() => flash(false))
  }
  return (
    <button type="button" className="btn ghost small copy-btn" onClick={copy} aria-live="polite">
      {copied ? 'Copied' : failed ? 'Copy failed' : 'Copy for customer'}
    </button>
  )
}

/** Compact re-surface card: no persona summary, no customer-facing badge. */
function ActivityRow({ f, onRead }: { f: FeedItem; onRead: (id: string) => void }) {
  const p = f.payload!
  const href = safeUrl(p.url)
  const text = activityText(p)
  const { customers, tickets } = refsOf(f)
  return (
    <li className={`feed-row activity-row${f.read_at ? '' : ' unread'}`} onMouseEnter={() => !f.read_at && onRead(f.id)}>
      <div>
        {href
          ? <a className="act-title" href={href} target="_blank" rel="noreferrer">{text}</a>
          : <span className="act-title">{text}</span>}
        {p.title ? <div className="small muted">{p.title}</div> : null}
        <RefLine prefix="For:" customers={customers} tickets={tickets} />
      </div>
      {!f.read_at && <button type="button" className="btn ghost small" aria-label="Mark as read" onClick={() => onRead(f.id)}>Mark read</button>}
    </li>
  )
}

function FeedRow({ f, customerVoice, onRead }: { f: FeedItem; customerVoice: boolean; onRead: (id: string) => void }) {
  // Activity items dispatch BEFORE any role/summary branch.
  if (f.kind === 'activity' && f.payload) return <ActivityRow f={f} onRead={onRead} />

  const isAi = f.summary?.source === 'ai'
  const multi = f.matches.length > 1
  const whyChips = multi ? (
    <span className="why multi-why">
      matched {f.matches.length} of your follows:
      {f.matches.map((m) => (
        <span key={`${m.type}:${m.ref}`} className={`rchip ${m.type}`}>{m.type} {m.ref}</span>
      ))}
    </span>
  ) : f.matches.length === 1 ? (
    <span className="why">you follow {f.matches[0].type} <b>{f.matches[0].ref}</b></span>
  ) : null

  const { customers, tickets } = refsOf(f)
  const hasRefs = customers.length + tickets.length > 0
  const refLine = <RefLine prefix="Shipped for:" customers={customers} tickets={tickets} />
  // A customer explicitly waits on this ship: give CX something to send.
  const aiCx = isAi && f.summary!.role === 'cx'
  const copyText = aiCx
    ? (f.summary!.body ? `${f.summary!.headline} — ${f.summary!.body}` : f.summary!.headline)
    : (f.note_technical ?? '')
  const cxCopy = customerVoice && hasRefs && copyText ? (
    <span className="cx-copy">
      <CopyButton text={copyText} />
      {!aiCx && <span className="muted copy-hint">from PR text — review before sending</span>}
    </span>
  ) : null
  const markRead = !f.read_at
    ? <button type="button" className="btn ghost small" aria-label="Mark as read" onClick={() => onRead(f.id)}>Mark read</button>
    : null

  return (
    <li className={`feed-row${f.read_at ? '' : ' unread'}${multi ? ' multi' : ''}`} onMouseEnter={() => !f.read_at && onRead(f.id)}>
      {isAi ? (
        <>
          <div className="persona-card">
            <span className={`role-tag ${f.summary!.role}`}>{f.summary!.role === 'cx' ? 'CX view' : 'Dev view'}</span>
            <strong className="persona-headline">{f.summary!.headline}</strong>
            {f.summary!.body ? <div className="persona-body">{f.summary!.body}</div> : null}
          </div>
          {refLine}
          {whyChips}
          {cxCopy}
          <details className="feed-details">
            <summary>Details</summary>
            <div className="small">
              <strong>{f.app}</strong> shipped <span className="muted">{f.tag}</span>
              {f.pr_number ? ` — #${f.pr_number}` : ''}
              <div>{f.note_technical ?? ''}</div>
              {f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.pr_number ? `#${f.pr_number}` : 'source'}</a> : null}
            </div>
          </details>
          {markRead}
        </>
      ) : (
        <>
          <div>
            <strong>{f.app}</strong> shipped <span className="muted">{f.tag}</span>
            {f.pr_number ? ` — #${f.pr_number}` : ''}
            <div className="small">{f.note_technical ?? ''}</div>
            {f.summary?.source === 'fallback' ? <span className="muted feed-indicator">no summary available</span> : null}
            {customerVoice && !f.summary
              ? <span className="muted feed-indicator">{hasRefs ? 'No customer summary' : 'Not customer-facing'}</span>
              : null}
            {refLine}
            {whyChips}
            {cxCopy}
          </div>
          {markRead}
        </>
      )}
    </li>
  )
}

const FEED_SECTIONS: { type: string; label: string }[] = [
  { type: 'pr', label: 'PRs you follow' },
  { type: 'issue', label: 'Issues you follow' },
  { type: 'milestone', label: 'Milestones you follow' },
  { type: 'label', label: 'Labels you follow' },
  { type: 'query', label: 'Queries you follow' },
  { type: 'app', label: 'Apps you follow' },
  { type: 'activity', label: 'Activity' },
]
const KNOWN_SECTIONS = new Set(FEED_SECTIONS.map((s) => s.type))
const OTHER_SECTION = { type: '__other', label: 'Other' }

function FollowsFeed({ customerVoice }: { customerVoice: boolean }) {
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [nonce, setNonce] = useState(0)
  const { data, loading } = useAsync(() => api.feed(unreadOnly), [unreadOnly, nonce])
  const onRead = (id: string) => { api.markRead(id).then(() => setNonce((x) => x + 1)) }
  const items = data ?? []
  const groupOf = (f: FeedItem) =>
    f.kind === 'activity' ? 'activity' : (f.matches[0]?.type ?? f.matched_type ?? 'app')
  // Catch-all so an unknown matched_type is never silently dropped.
  const inSection = (f: FeedItem, type: string) =>
    type === OTHER_SECTION.type ? !KNOWN_SECTIONS.has(groupOf(f)) : groupOf(f) === type
  return (
    <>
      <div className="row" style={{ marginTop: 0 }}>
        <label className="muted small"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> unread only</label>
        <button type="button" className="btn ghost" onClick={() => api.markAllRead().then(() => setNonce((x) => x + 1))}>Mark all read</button>
      </div>
      {loading ? <p className="muted">Loading…</p> : items.length === 0 ? (
        <p className="muted">Nothing here yet. Follow an app, label, milestone, query, issue or PR to get ship notifications.</p>
      ) : (
        [...FEED_SECTIONS, OTHER_SECTION].map((s) => {
          const group = items.filter((f) => inSection(f, s.type))
          if (group.length === 0) return null
          return (
            <div className="group" key={s.type}>
              <h3>{s.label} <span className="muted small">({group.length})</span></h3>
              <ul className="feed">{group.map((f) => <FeedRow key={f.id} f={f} customerVoice={customerVoice} onRead={onRead} />)}</ul>
            </div>
          )
        })
      )}
    </>
  )
}

function DigestCard({ it, role }: { it: DigestItem; role: string }) {
  const text = it.body ? `${it.headline} — ${it.body}` : it.headline
  return (
    <li className="feed-row">
      <div className="persona-card">
        <span className={`role-tag ${role}`}>{role === 'cx' ? 'CX view' : 'Dev view'}</span>
        <strong className="persona-headline">{it.headline}</strong>
        {it.body ? <div className="persona-body">{it.body}</div> : null}
      </div>
      <details className="feed-details">
        <summary>Details</summary>
        <div className="small">
          <strong>{it.app}</strong> shipped <span className="muted">{it.tag}</span>
          {it.pr_number ? ` — #${it.pr_number}` : ''}
          {it.note_technical ? <div>{it.note_technical}</div> : null}
          {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.pr_number ? `#${it.pr_number}` : 'source'}</a> : null}
        </div>
      </details>
      {role === 'cx' ? <CopyButton text={text} /> : null}
    </li>
  )
}

function DigestFeed({ role }: { role: string }) {
  const { data, loading } = useAsync(() => api.feedDigest(), [])
  if (loading) return <p className="muted">Loading…</p>
  const items = data?.items ?? []
  const digestRole = data?.role ?? role
  if (items.length === 0) return <p className="muted">No summaries yet — AI notes may be off.</p>
  const byApp = new Map<string, DigestItem[]>()
  for (const it of items) { const arr = byApp.get(it.app) ?? []; arr.push(it); byApp.set(it.app, arr) }
  const apps = [...byApp.keys()].sort(
    (a, b) => Math.max(...byApp.get(b)!.map((x) => x.deployed_at)) - Math.max(...byApp.get(a)!.map((x) => x.deployed_at)),
  )
  return (
    <>
      <p className="digest-summary">{items.length} change{items.length === 1 ? '' : 's'} across {byApp.size} app{byApp.size === 1 ? '' : 's'}</p>
      {apps.map((app) => (
        <div className="group" key={app}>
          <div className="digest-appgroup"><h3>{app}</h3><span className="muted small">({byApp.get(app)!.length})</span></div>
          <ul className="feed">{byApp.get(app)!.map((it) => <DigestCard key={`${it.release_id}:${it.pr_number}`} it={it} role={digestRole} />)}</ul>
        </div>
      ))}
    </>
  )
}

function FeedPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'digest' ? 'digest' : 'follows'
  const { role, roles } = useApp()
  const customerVoice = roles.find((r) => r.key === role)?.voice === 'customer'
  const digestLabel = role === 'cx' ? 'CX view' : 'Dev view'
  const setView = (v: 'follows' | 'digest') => setParams(v === 'digest' ? { view: 'digest' } : {}, { replace: true })
  return (
    <>
      <div className="row">
        <h2>Feed</h2>
        <div className="seg" role="tablist" aria-label="Feed view">
          <button type="button" role="tab" aria-selected={view === 'follows'} onClick={() => setView('follows')}>What you follow</button>
          <button type="button" role="tab" aria-selected={view === 'digest'} onClick={() => setView('digest')}>{digestLabel}</button>
        </div>
      </div>
      <div role="tabpanel" aria-label={view === 'follows' ? 'What you follow' : digestLabel}>
        {view === 'follows' ? <FollowsFeed customerVoice={customerVoice} /> : <DigestFeed role={role} />}
      </div>
    </>
  )
}

const FOLLOW_TYPES = ['label', 'issue', 'pr', 'milestone', 'query', 'app'] as const
/** Only issue/pr follows carry customer/ticket refs (server ignores them otherwise). */
const REF_TYPES = new Set(['issue', 'pr'])
/** Mirrors the server rule (src/lib/follow-validation.ts): queries are 3–200 chars. */
const QUERY_MIN = 3

function FollowsPage() {
  const [nonce, setNonce] = useState(0)
  const { data, loading } = useAsync(() => api.follows(), [nonce])
  const [type, setType] = useState('label')
  const [ref, setRef] = useState('')
  const [customerRef, setCustomerRef] = useState('')
  const [ticketRef, setTicketRef] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [sugs, setSugs] = useState<Suggestion[]>([])
  const [openList, setOpenList] = useState(false)

  const groups: Record<string, string> = {
    app: 'Apps', pr: 'Pull requests', label: 'Labels', issue: 'Issues', milestone: 'Milestones', query: 'Queries',
  }
  const byType = (data ?? []).reduce<Record<string, typeof data>>((acc, f) => {
    (acc[f.target_type] ||= []).push(f); return acc
  }, {})

  // Debounced typeahead for the selected type. Queries are free text — no suggest.
  useEffect(() => {
    if (type === 'query') { setSugs([]); return }
    let live = true
    const t = setTimeout(() => {
      api.suggest(type, ref).then((s) => { if (live) setSugs(s) }).catch(() => {})
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [type, ref])

  const tooShort = type === 'query' && ref.trim().length < QUERY_MIN
  const follow = (r: string) => {
    const v = r.trim()
    if (!v || (type === 'query' && v.length < QUERY_MIN)) return
    const opts = REF_TYPES.has(type)
      ? { customer_ref: customerRef.trim() || undefined, ticket_ref: ticketRef.trim() || undefined }
      : undefined
    setErr(null)
    api.follow(type, v, opts).then(() => {
      setRef(''); setCustomerRef(''); setTicketRef(''); setSugs([]); setOpenList(false); setNonce((x) => x + 1)
    }).catch(() => setErr(type === 'query' ? `Queries must be ${QUERY_MIN}–200 characters.` : 'Could not follow — check the value.'))
  }

  return (
    <>
      <h2>Follows</h2>
      <div className="followbar">
        <span className="muted small">Follow</span>
        <select aria-label="Follow type" value={type} onChange={(e) => { setType(e.target.value); setSugs([]); setErr(null) }}>
          {FOLLOW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="typeahead">
          <input value={ref} aria-label={type === 'query' ? 'Query text' : `${type} to follow`}
            placeholder={type === 'query' ? 'Text to match in release notes…' : `Search ${type}s…`}
            onChange={(e) => { setRef(e.target.value); setOpenList(true) }}
            onFocus={() => setOpenList(true)}
            onBlur={() => setTimeout(() => setOpenList(false), 150)}
            onKeyDown={(e) => { if (e.key === 'Enter') follow(ref) }} />
          {openList && sugs.length > 0 && (
            <ul className="suggest">
              {sugs.map((s) => (
                <li key={s.ref} onMouseDown={(e) => { e.preventDefault(); follow(s.ref) }}>
                  {s.state && <span className={`state ${s.state === 'OPEN' ? 'open' : 'closed'}`}>{s.state.toLowerCase()}</span>}
                  <span className="stitle">{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {REF_TYPES.has(type) && (
          <span className="refinputs">
            <input value={customerRef} maxLength={200} aria-label="Customer ref (optional)"
              placeholder="Customer ref (optional)" onChange={(e) => setCustomerRef(e.target.value)} />
            <input value={ticketRef} maxLength={200} aria-label="Ticket ref (optional)"
              placeholder="Ticket ref (optional)" onChange={(e) => setTicketRef(e.target.value)} />
          </span>
        )}
        <button type="button" className="btn primary small" disabled={tooShort} onClick={() => follow(ref)}>Follow</button>
      </div>
      {err && <p className="muted small" role="alert">{err}</p>}
      {loading ? <p className="muted">Loading…</p> : (
        Object.keys(groups).filter((t) => (byType[t] ?? []).length > 0).map((t) => (
          <div className="group" key={t}>
            <h3>{groups[t]}</h3>
            <ul className="follows">
              {(byType[t] ?? []).map((f) => (
                <li key={f.id}>
                  {(f.target_type === 'issue' || f.target_type === 'pr') ? (
                    <span className="ftarget">
                      {f.entity_state && <span className={`state ${f.entity_state === 'OPEN' ? 'open' : 'closed'}`}>{f.entity_state.toLowerCase()}</span>}
                      <span className="inum">#{f.target_ref}</span>
                      <span>{f.entity_title ?? <span className="muted">not yet ingested</span>}</span>
                      <RefLine prefix="" customers={f.customer_ref ? [f.customer_ref] : []} tickets={f.ticket_ref ? [f.ticket_ref] : []} />
                    </span>
                  ) : f.target_type === 'query' ? (
                    <span className="ftarget">
                      <span>"{f.target_ref}"</span>
                      <Link className="small" to={`/search?q=${encodeURIComponent(f.target_ref)}`}>preview matches</Link>
                    </span>
                  ) : (
                    <span>{f.target_ref}</span>
                  )}
                  <button type="button" className="btn ghost small"
                    aria-label={`Unfollow ${f.target_type} ${f.target_ref}`}
                    onClick={() => api.unfollow(f.id).then(() => setNonce((x) => x + 1))}>Unfollow</button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {data && data.length === 0 && <p className="muted">Not following anything yet.</p>}
    </>
  )
}

function SearchPage() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const { data, loading } = useAsync(() => (q ? api.search(q) : Promise.resolve([])), [q])
  return (
    <>
      <h2>Search: "{q}"</h2>
      {loading ? <p className="muted">Loading…</p> : (
        <ul className="results">
          {(data ?? []).map((r, i) => (
            <li key={i}>
              <Link to={`/apps/${r.app}`}>{r.app}</Link> <span className="muted">{r.tag}</span> — {r.note_technical}
              {r.url && <a className="pr" href={r.url} target="_blank" rel="noreferrer">#{r.pr_number}</a>}
            </li>
          ))}
          {data && data.length === 0 && <p className="muted">No matches.</p>}
        </ul>
      )}
    </>
  )
}

function SettingsPage() {
  const { me, roles, setRole } = useApp()
  return <Settings roles={roles} current={me.role} onSaved={setRole} />
}
function InsightsPage() {
  const { role } = useApp()
  return <Insights role={role} />
}
