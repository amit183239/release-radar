import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { api } from './api'

const keyOf = (type: string, ref: string) => `${type}:${ref}`

interface FollowsCtx {
  isFollowing: (type: string, ref: string) => boolean
  toggle: (type: string, ref: string) => void
  loading: boolean
}
const Ctx = createContext<FollowsCtx | null>(null)
export const useFollows = () => useContext(Ctx)!

export function FollowsProvider({ children }: { children: ReactNode }) {
  // Map<"type:ref", followId> — the id is needed to DELETE.
  const [map, setMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const inflight = useRef<Set<string>>(new Set())

  useEffect(() => {
    api.follows().then(
      (rows) => {
        setMap(new Map(rows.map((f) => [keyOf(f.target_type, f.target_ref), f.id])))
        setLoading(false)
      },
      () => setLoading(false)
    )
  }, [])

  const isFollowing = useCallback((type: string, ref: string) => map.has(keyOf(type, ref)), [map])

  const toggle = useCallback((type: string, ref: string) => {
    const key = keyOf(type, ref)
    if (inflight.current.has(key)) return
    const existingId = map.get(key)
    if (existingId) {
      inflight.current.add(key)
      api.unfollow(existingId)
        .then(() => setMap((prev) => { const next = new Map(prev); next.delete(key); return next }))
        .catch(() => {})
        .finally(() => inflight.current.delete(key))
    } else {
      inflight.current.add(key)
      api.follow(type, ref).then(
        ({ id }) => setMap((prev) => new Map(prev).set(key, id)),
        () => {}
      ).finally(() => inflight.current.delete(key))
    }
  }, [map])

  return <Ctx.Provider value={{ isFollowing, toggle, loading }}>{children}</Ctx.Provider>
}
