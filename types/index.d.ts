// lol-live's state contract: the snapshot and log the pane draws.

export type Player = { role: string; name: string; champion: string; level: string; k?: number; d?: number; a?: number; cs: string; gold?: number }
export type Side = {
  name: string
  kills?: number
  gold?: number
  towers?: number
  barons?: number
  inhibitors?: number
  dragons: string[]
  players: Player[]
}

export type LiveSnapshot = {
  state: 'live'
  demo: boolean
  label?: string
  gameId: string
  gameNumber?: number
  // The game's first frame (its clock's zero) and how far behind now the feed was asked.
  gameStartMs?: number
  lookbackSeconds?: number
  frameUtc: string
  frameMs: number
  ageSeconds: number
  gameState: string
  blue: Side
  red: Side
}
export type Snapshot =
  | LiveSnapshot
  | { state: 'buffering'; label?: string; gameId: string }
  | { state: 'waiting'; label: string }
  | { state: 'idle'; next?: { label: string; kst: string } }

declare module 'claude-code' {
  interface PluginState {
    'lol-live': { snapshot: Snapshot | null; log: string[]; error: string | null }
  }
}
