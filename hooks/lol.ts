// Pure logic: settings, LoL feed parsing, status text, alerts, /lol parsing.
// Nothing here is interpolated: a missing field stays '?', frame age is always shown.

import { CHAMPIONS_KO } from './champions'
import type { LiveSnapshot, Player, Side, Snapshot } from '../types'

export type { LiveSnapshot, Player, Side, Snapshot }

export const API_LOOKBACK = 60
export const MAX_EXTRA_DELAY = 120
export const LIVE_MS = 10_000
// The feed's 10-second windows hold a frame every second or so: the pane replays them at this step.
export const TICK_MS = 2_000
export const IDLE_MS = 300_000
export const ERROR_MS = 60_000
export const BIG_FIGHT_KILLS = 3
// Game time with no new kill that ends a fight.
export const FIGHT_GAP_MS = 10_000
export const LOG_LIMIT = 40

// The demo replays a real game through the same feed: 2026 LCK final, game 4 (GEN blue, HLE red).
export const DEMO = {
  matchId: '117030752644841643',
  gameId: '117030752644841647',
  gameNumber: 4,
  label: 'LCK 2026 결승 · GEN vs HLE',
  teams: { '100205573495116443': 'GEN', '100205573496804586': 'HLE' } as Record<string, string>,
  // Where `/lol demo on` starts, in minutes from the game's first frame: a fight comes ~40 s in.
  fromMinute: 19,
  maxMinute: 60,
}

export type Settings = {
  enabled: boolean
  alerts: boolean
  delay: number
  demo: boolean
  demoFrom?: number
  gameId?: string
  matchId?: string
  at?: string
}

export const DEFAULTS: Settings = { enabled: true, alerts: true, delay: 0, demo: false }

export function loadSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  const delay = Number.isInteger(s.delay) ? Math.min(MAX_EXTRA_DELAY, Math.max(0, s.delay as number)) : 0
  return {
    enabled: s.enabled !== false,
    alerts: s.alerts !== false,
    delay,
    demo: s.demo === true,
    ...(Number.isInteger(s.demoFrom) && (s.demoFrom as number) >= 0 && (s.demoFrom as number) <= DEMO.maxMinute ? { demoFrom: s.demoFrom } : {}),
    ...(typeof s.gameId === 'string' && s.gameId ? { gameId: s.gameId } : {}),
    ...(typeof s.matchId === 'string' && s.matchId ? { matchId: s.matchId } : {}),
    ...(typeof s.at === 'string' && s.at ? { at: s.at } : {}),
  }
}

// ---------- feed shapes (loose: the API is unofficial) ----------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
// Strip control characters so remote text never reaches the terminal raw.
export const clean = (v: unknown): string => str(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

const ROLE_KO: Record<string, string> = { top: '탑', jungle: '정글', mid: '미드', bottom: '원딜', support: '서포터' }
const DRAGON_KO: Record<string, string> = {
  infernal: '화염', ocean: '바다', mountain: '대지', cloud: '바람', hextech: '마법공학', chemtech: '화학공학', elder: '장로',
}

export type PollState = Snapshot['state'] | 'error'

function side(frameTeam: Obj, meta: Obj, name: string): Side {
  const roster = new Map(list(meta.participantMetadata).map(p => [str(p.participantId), p]))
  const players = list(frameTeam.participants).map(p => {
    const info = roster.get(str(p.participantId)) ?? {}
    const champ = clean(info.championId) || '?'
    const role = clean(info.role)
    const full = clean(info.summonerName) || '?'
    return {
      role: ROLE_KO[role] ?? (role || '?'),
      // The feed prefixes the team code ("KC Canna"); the pane already shows the team.
      name: full.startsWith(`${name} `) ? full.slice(name.length + 1) : full,
      champion: CHAMPIONS_KO[champ] ?? champ,
      level: str(num(p.level) ?? '?'),
      k: num(p.kills), d: num(p.deaths), a: num(p.assists),
      cs: str(num(p.creepScore) ?? '?'),
      gold: num(p.totalGold),
    }
  })
  return {
    name,
    kills: num(frameTeam.totalKills),
    gold: num(frameTeam.totalGold),
    towers: num(frameTeam.towers),
    barons: num(frameTeam.barons),
    inhibitors: num(frameTeam.inhibitors),
    dragons: Array.isArray(frameTeam.dragons) ? frameTeam.dragons.map(clean) : [],
    players,
  }
}

export type TeamNames = Record<string, string>

export type FeedExtra = { label?: string; gameNumber?: number; demo?: boolean; atMs?: number; gameStartMs?: number; lookbackSeconds?: number }

// The frame of a live-stats window at `extra.atMs` (the last one not after it; the latest
// without it), or a buffering snapshot when the window has no frame.
export function snapshotFromWindow(payload: unknown, teams: TeamNames, nowMs: number, extra: FeedExtra = {}): Snapshot {
  if (!isObj(payload)) throw new Error('잘못된 피드 응답')
  const gameId = clean(payload.esportsGameId)
  const frames = list(payload.frames)
    .map(f => ({ f, ms: Date.parse(str(f.rfc460Timestamp)) }))
    .filter(x => Number.isFinite(x.ms) && isObj(x.f.blueTeam) && isObj(x.f.redTeam))
    .sort((a, b) => a.ms - b.ms)
  const atMs = extra.atMs
  const latest = atMs === undefined ? frames.at(-1) : (frames.filter(x => x.ms <= atMs).at(-1) ?? frames[0])
  if (!latest) return { state: 'buffering', gameId, ...(extra.label ? { label: extra.label } : {}) }
  const meta = isObj(payload.gameMetadata) ? payload.gameMetadata : {}
  const blueMeta = isObj(meta.blueTeamMetadata) ? meta.blueTeamMetadata : {}
  const redMeta = isObj(meta.redTeamMetadata) ? meta.redTeamMetadata : {}
  return {
    state: 'live',
    demo: extra.demo === true,
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.gameNumber ? { gameNumber: extra.gameNumber } : {}),
    ...(extra.gameStartMs !== undefined && extra.gameStartMs <= latest.ms ? { gameStartMs: extra.gameStartMs } : {}),
    ...(extra.lookbackSeconds !== undefined ? { lookbackSeconds: extra.lookbackSeconds } : {}),
    gameId,
    frameUtc: new Date(latest.ms).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    frameMs: latest.ms,
    ageSeconds: Math.max(0, Math.round((nowMs - latest.ms) / 1000)),
    gameState: clean(latest.f.gameState) || 'unknown',
    blue: side(latest.f.blueTeam as Obj, blueMeta, teams[str(blueMeta.esportsTeamId)] ?? '블루'),
    red: side(latest.f.redTeam as Obj, redMeta, teams[str(redMeta.esportsTeamId)] ?? '레드'),
  }
}

// ---------- schedule / events ----------

export type EventInfo = { id: string; label: string; teams: TeamNames; codes: string[]; game?: { id: string; number?: number }; wins: Record<string, number> }

const inProgress = (state: unknown) => str(state).toLowerCase().replace(/[^a-z]/g, '') === 'inprogress'

export function eventInfo(event: unknown): EventInfo {
  const e = isObj(event) ? event : {}
  const match = isObj(e.match) ? e.match : {}
  const league = isObj(e.league) ? e.league : {}
  const teamList = list(match.teams)
  const teams: TeamNames = {}
  const wins: Record<string, number> = {}
  const codes: string[] = []
  for (const t of teamList) {
    const code = clean(t.code) || clean(t.name) || '?'
    codes.push(code)
    if (str(t.id)) teams[str(t.id)] = code
    const result = isObj(t.result) ? t.result : {}
    const w = num(result.gameWins)
    if (w !== undefined) wins[code] = w
  }
  const games = list(match.games).filter(g => inProgress(g.state) && str(g.id))
  const current = games.at(-1)
  const leagueName = clean(league.name) || clean(league.slug) || 'LoL Esports'
  return {
    id: clean(match.id) || clean(e.id),
    label: `${leagueName} · ${codes.slice(0, 2).join(' vs ') || '?'}`,
    teams, codes, wins,
    ...(current ? { game: { id: clean(current.id), ...(num(current.number) ? { number: num(current.number) } : {}) } } : {}),
  }
}

export function isTargetLeague(event: unknown, leagueIds: ReadonlySet<string>): boolean {
  if (!isObj(event) || !isObj(event.league)) return false
  const slug = str(event.league.slug).toLowerCase()
  const name = str(event.league.name).toLowerCase()
  if (slug.includes('challenger') || name.includes('challenger')) return false
  return leagueIds.has(str(event.league.id)) || slug === 'lck' || slug === 'worlds'
}

export function kst(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function nextEvent(schedule: unknown[], nowMs: number): { label: string; kst: string } | undefined {
  const upcoming = schedule
    .filter(isObj)
    .filter(e => e.state === 'unstarted' && Number.isFinite(Date.parse(str(e.startTime))) && Date.parse(str(e.startTime)) >= nowMs - 3600_000)
    .sort((a, b) => Date.parse(str(a.startTime)) - Date.parse(str(b.startTime)))
  const first = upcoming[0]
  if (!first) return undefined
  const info = eventInfo(first)
  return { label: info.codes.length >= 2 ? info.codes.slice(0, 2).join(' vs ') : info.label, kst: kst(str(first.startTime)) }
}

export function queryTime(nowMs: number, lookbackSeconds: number): string {
  const t = Math.floor((nowMs / 1000 - lookbackSeconds) / 10) * 10
  return new Date(t * 1000).toISOString().replace('.000Z', 'Z')
}

// ---------- text ----------

export const gold = (v?: number) => (v === undefined ? '?' : `${(v / 1000).toFixed(1)}k`)
const n = (v?: number) => (v === undefined ? '?' : String(v))
const pair = (a?: number, b?: number) => `${n(a)}:${n(b)}`

export function ago(seconds: number): string {
  if (seconds < 120) return `${seconds}초 전`
  if (seconds < 7200) return `${Math.floor(seconds / 60)}분 전`
  return `${Math.floor(seconds / 3600)}시간 전`
}

// Game time as the feed's clock gives it: time since the game's first frame, pauses included.
export function gameClock(s: LiveSnapshot): string | undefined {
  if (s.gameStartMs === undefined) return undefined
  const total = Math.max(0, Math.floor((s.frameMs - s.gameStartMs) / 1000))
  const p = (v: number) => String(v).padStart(2, '0')
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

// Whole five minutes of game time, for the status line.
export function gameMinutes(s: LiveSnapshot): number | undefined {
  if (s.gameStartMs === undefined) return undefined
  return Math.floor(Math.max(0, s.frameMs - s.gameStartMs) / 300_000) * 5
}

// Data this much older than the lookback asks for means the feed stopped.
const STALE_SECONDS = 60

export function goldLead(s: LiveSnapshot): string {
  const { blue, red } = s
  if (blue.gold === undefined || red.gold === undefined) return '골드 ?'
  const diff = blue.gold - red.gold
  return `골드 +${gold(Math.abs(diff))} ${diff >= 0 ? blue.name : red.name}`
}

export function statusLine(s: Snapshot): string {
  switch (s.state) {
    case 'idle':
      return s.next ? `⚔ 다음: ${s.next.label} ${s.next.kst}` : '⚔ 진행 중 경기 없음'
    case 'waiting':
      return `⚔ ${s.label} · 세트 대기 중`
    case 'buffering':
      return `⚔ ${s.label ?? s.gameId} · 버퍼링`
    case 'live': {
      const { blue, red } = s
      const minutes = gameMinutes(s)
      const stale = s.ageSeconds > (s.lookbackSeconds ?? API_LOOKBACK) + STALE_SECONDS ? ` · ⚠ ${ago(s.ageSeconds)} 데이터` : ''
      return `⚔ ${s.demo ? '[데모] ' : ''}${blue.name} ${pair(blue.kills, red.kills)} ${red.name}${minutes === undefined ? '' : ` (${minutes}분)`}${stale}`
    }
  }
}

export function errorLine(message: string): string {
  const last = message.trim().split('\n').pop() ?? ''
  return `⚔ LoL: ${last.replace(/^(오류|error):\s*/i, '').slice(0, 80) || '응답 없음'}`
}

export function nextInterval(state: PollState | undefined): number {
  return state === 'idle' ? IDLE_MS : state === 'error' ? ERROR_MS : LIVE_MS
}

const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 19)
// Log lines are stamped with game time, or the frame's UTC time before the game's start is known.
const stamp = (s: LiveSnapshot) => gameClock(s) ?? utcTime(s.frameMs)

// ---------- changes between two snapshots, and teamfights ----------

// `key` identifies the moment across sessions so each OS notification is sent once;
// a coarse key with a short `ttlMs` covers moments sessions may see at different frames.
export type Alert = { level: 'toast' | 'notify'; text: string; key: string; ttlMs: number }

export const LONG_TTL = 30 * 60_000
export const SHORT_TTL = 60_000

export type Fight = {
  startMs: number
  lastKillMs: number
  kills: { blue: number; red: number }
  killers: Record<string, number>
  deaths: string[]
  objectives: string[]
}

function deltas(prev: Side, cur: Side) {
  const killers: Record<string, number> = {}
  const deaths: string[] = []
  const before = new Map(prev.players.map(p => [p.name, p]))
  for (const p of cur.players) {
    const old = before.get(p.name)
    if (!old) continue
    if (p.k !== undefined && old.k !== undefined && p.k > old.k) killers[p.name] = p.k - old.k
    if (p.d !== undefined && old.d !== undefined) for (let i = old.d; i < p.d; i++) deaths.push(p.name)
  }
  return { killers, deaths }
}

const grew = (a?: number, b?: number) => (a !== undefined && b !== undefined && b > a ? b - a : 0)

// What carries from one step to the next: the open fight and the last side that led by 1k+.
export type Track = { fight?: Fight; leader?: 'blue' | 'red' }
export type Step = { track: Track; alerts: Alert[]; log: string[] }

export const GOLD_LEAD = 1000

function leadSide(s: LiveSnapshot): 'blue' | 'red' | undefined {
  if (s.blue.gold === undefined || s.red.gold === undefined || Math.abs(s.blue.gold - s.red.gold) < GOLD_LEAD) return undefined
  return s.blue.gold > s.red.gold ? 'blue' : 'red'
}

function mergeCounts(...maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v
  return out
}

const countNames = (names: string[]) => mergeCounts(...names.map(name => ({ [name]: 1 })))

// One side's players out of a name -> count map, most first.
function sideOf(cur: LiveSnapshot, counts: Record<string, number>, isBlue: boolean): [string, number][] {
  const blueNames = new Set(cur.blue.players.map(p => p.name))
  return Object.entries(counts).filter(([name]) => blueNames.has(name) === isBlue).sort((a, b) => b[1] - a[1])
}

const times = ([name, n]: [string, number]) => (n > 1 ? `${name} ×${n}` : name)

// The kills one step saw, the moment it sees them: "⚔ GEN Chovy 킬 · HLE Zeka 사망 (6:4)".
// The counters say who gained a kill and who died, never who killed whom.
function killLine(cur: LiveSnapshot, newKills: { blue: number; red: number }, killers: Record<string, number>, deaths: string[]): string {
  const score = `(${pair(cur.blue.kills, cur.red.kills)})`
  const dead = countNames(deaths)
  const parts: string[] = []
  for (const isBlue of [true, false]) {
    const team = isBlue ? cur.blue.name : cur.red.name
    const who = sideOf(cur, killers, isBlue)
    const scored = isBlue ? newKills.blue : newKills.red
    if (who.length) parts.push(`${team} ${who.map(times).join('·')} 킬`)
    else if (scored) parts.push(`${team} 킬 +${scored}`)
  }
  for (const isBlue of [true, false]) {
    const who = sideOf(cur, dead, isBlue)
    if (who.length) parts.push(`${isBlue ? cur.blue.name : cur.red.name} ${who.map(times).join('·')} 사망`)
  }
  return `⚔ ${parts.join(' · ')} ${score}`
}

// A fight of BIG_FIGHT_KILLS or more, once it is over: a short headline for the toast and the
// OS notification, and the pane's log with one line per side under it.
export function closeFight(f: Fight | undefined, cur: LiveSnapshot): { alerts: Alert[]; log: string[] } {
  if (!f || f.kills.blue + f.kills.red < BIG_FIGHT_KILLS) return { alerts: [], log: [] }
  const { blue, red } = cur
  const winner = f.kills.blue === f.kills.red ? '' : ` → ${f.kills.blue > f.kills.red ? blue.name : red.name} 승리`
  const objectives = f.objectives.length ? ` · ${f.objectives.join('·')}` : ''
  const headline = `💥 한타 ${blue.name} ${f.kills.blue}:${f.kills.red} ${red.name}${winner} (${pair(blue.kills, red.kills)})${objectives}`
  const dead = countNames(f.deaths)
  const width = Math.max(blue.name.length, red.name.length)
  const sideLine = (isBlue: boolean) => {
    const killers = sideOf(cur, f.killers, isBlue).map(([name, n]) => `${name} ${n}킬`).join('·') || '-'
    const died = sideOf(cur, dead, isBlue).map(times).join('·') || '-'
    return `  └ ${(isBlue ? blue.name : red.name).padEnd(width)} 처치 ${killers} │ 사망 ${died}`
  }
  return {
    // Closing totals: the same fight ends on the same score in every session.
    alerts: [{ level: 'notify', text: headline, key: `${cur.gameId}:fight:${blue.kills}:${red.kills}`, ttlMs: LONG_TTL }],
    log: [`${stamp(cur)} ${headline}`, sideLine(true), sideLine(false)],
  }
}

// One step between two frames: each kill is told as it is seen; kills less than
// FIGHT_GAP_MS of game time apart make one fight, summed up once it is over. A frame
// that does not advance (the caller passes one when the feed stalls) or another game
// closes the fight too.
export function step(prev: LiveSnapshot | undefined, cur: LiveSnapshot, track: Track): Step {
  const alerts: Alert[] = []
  const log: string[] = []
  const fight = track.fight
  if (!prev) {
    const leader = leadSide(cur)
    return { track: leader ? { leader } : {}, alerts, log }
  }
  if (prev.gameId !== cur.gameId) return { track: {}, ...closeFight(fight, prev) }
  if (cur.frameMs <= prev.frameMs) {
    return { track: { ...(track.leader ? { leader: track.leader } : {}) }, ...closeFight(fight, prev) }
  }
  const at = stamp(cur)
  const objectives: string[] = []
  for (const key of ['blue', 'red'] as const) {
    const a = prev[key], b = cur[key]
    const towers = grew(a.towers, b.towers)
    if (towers) {
      log.push(`${at} ${b.name} 포탑 +${towers}`)
      alerts.push({ level: 'toast', text: `🏰 ${b.name} 포탑 파괴 (${pair(cur.blue.towers, cur.red.towers)})`,
                    key: `${cur.gameId}:tower:${key}:${b.towers}`, ttlMs: LONG_TTL })
      objectives.push(`${b.name} 포탑`)
    }
    for (const type of b.dragons.slice(a.dragons.length)) {
      const label = type === 'elder' ? '장로 드래곤' : `${DRAGON_KO[type] ?? type} 드래곤`
      log.push(`${at} ${b.name} ${label}`)
      alerts.push({ level: 'notify', text: `🐉 ${b.name} ${label} (${b.dragons.length}번째)`,
                    key: `${cur.gameId}:dragon:${key}:${b.dragons.length}`, ttlMs: LONG_TTL })
      objectives.push(`${b.name} ${label}`)
    }
    if (grew(a.barons, b.barons)) {
      log.push(`${at} ${b.name} 내셔 남작`)
      alerts.push({ level: 'notify', text: `🟣 ${b.name} 내셔 남작 처치`, key: `${cur.gameId}:baron:${key}:${b.barons}`, ttlMs: LONG_TTL })
      objectives.push(`${b.name} 바론`)
    }
    if (grew(a.inhibitors, b.inhibitors)) {
      log.push(`${at} ${b.name} 억제기`)
      alerts.push({ level: 'toast', text: `${b.name} 억제기 파괴`, key: `${cur.gameId}:inhib:${key}:${b.inhibitors}`, ttlMs: LONG_TTL })
    }
  }
  const newKills = { blue: grew(prev.blue.kills, cur.blue.kills), red: grew(prev.red.kills, cur.red.kills) }
  let next = fight
  if (newKills.blue + newKills.red > 0) {
    const blue = deltas(prev.blue, cur.blue), red = deltas(prev.red, cur.red)
    const killers = mergeCounts(blue.killers, red.killers)
    const deaths = [...blue.deaths, ...red.deaths]
    const line = killLine(cur, newKills, killers, deaths)
    log.push(`${at} ${line}`)
    alerts.push({ level: 'toast', text: line, key: `${cur.gameId}:kills:${cur.blue.kills}:${cur.red.kills}`, ttlMs: SHORT_TTL })
    next = next ?? { startMs: prev.frameMs, lastKillMs: cur.frameMs, kills: { blue: 0, red: 0 }, killers: {}, deaths: [], objectives: [] }
    next = {
      ...next,
      lastKillMs: cur.frameMs,
      kills: { blue: next.kills.blue + newKills.blue, red: next.kills.red + newKills.red },
      killers: mergeCounts(next.killers, killers),
      deaths: [...next.deaths, ...deaths],
      objectives: [...next.objectives, ...objectives],
    }
  } else if (next) {
    next = { ...next, objectives: [...next.objectives, ...objectives] }
    if (cur.frameMs - next.lastKillMs >= FIGHT_GAP_MS) {
      const closed = closeFight(next, cur)
      alerts.push(...closed.alerts)
      log.push(...closed.log)
      next = undefined
    }
  }
  let leader = track.leader
  const side = leadSide(cur)
  if (side) {
    const lead = (cur.blue.gold ?? 0) - (cur.red.gold ?? 0)
    if (leader && leader !== side) {
      const name = cur[side].name
      log.push(`${at} 골드 역전: ${name} +${gold(Math.abs(lead))}`)
      alerts.push({ level: 'notify', text: `🔄 골드 역전: ${name} +${gold(Math.abs(lead))}`,
                    key: `${cur.gameId}:flip:${side}:${cur.blue.kills}:${cur.red.kills}`, ttlMs: 5 * 60_000 })
    }
    leader = side
  }
  return { track: { ...(next ? { fight: next } : {}), ...(leader ? { leader } : {}) }, alerts, log }
}

// ---------- /lol ----------

export type Action =
  | { kind: 'snapshot' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'list' }
  | { kind: 'panel' }
  | { kind: 'set'; patch: Partial<Settings>; clear?: (keyof Settings)[]; note: string }
  | { kind: 'ask'; question: string }
  | { kind: 'error'; text: string }

export const HELP = [
  '/lol                  전체 스냅샷 (점수판·선수·로그)',
  '/lol panel            실시간 패널 열기 (경기 중엔 자동으로 열림)',
  '/lol on | off         상태줄·패널·알림 켜기/끄기 (다음 세션에도 유지)',
  '/lol alerts [on|off]  알림만 켜기/끄기 (인자 없으면 전환)',
  '/lol status           현재 상태줄과 설정',
  '/lol list             LCK/월즈 경기 일정',
  '/lol game auto        진행 중 경기 자동 선택 (기본)',
  '/lol game <게임ID> [경기ID] [--at UTC시각]   특정 세트 고정',
  `/lol delay <0~${MAX_EXTRA_DELAY}>     추가 지연(초), 기본 API 지연 ${API_LOOKBACK}초 위에 더함`,
  `/lol demo [on|off|분]  ${DEMO.label} ${DEMO.gameNumber}세트 다시보기 (기본 ${DEMO.fromMinute}분부터, 숫자는 시작 분)`,
  '/lol <질문>           현재 스냅샷을 근거로 Claude에게 질문',
].join('\n')

function toggle(rest: string[], current: boolean): boolean | undefined {
  if (rest.length === 0) return !current
  if (rest.length === 1 && /^(on|off)$/i.test(rest[0] ?? '')) return rest[0]?.toLowerCase() === 'on'
  return undefined
}

export function parseCommand(args: string, current: Settings = DEFAULTS): Action {
  const text = args.trim()
  if (!text) return { kind: 'snapshot' }
  const [head = '', ...rest] = text.split(/\s+/)
  const word = head.toLowerCase()
  const bare = rest.length === 0
  if ((word === 'help' || word === '?') && bare) return { kind: 'help' }
  if (word === 'status' && bare) return { kind: 'status' }
  if (word === 'list' && bare) return { kind: 'list' }
  if (word === 'panel' && bare) return { kind: 'panel' }
  if ((word === 'on' || word === 'off') && bare) {
    return { kind: 'set', patch: { enabled: word === 'on' }, note: `lol-live ${word === 'on' ? '켜짐' : '꺼짐'}` }
  }
  if (word === 'demo' && rest.length === 1 && /^\d+$/.test(rest[0] ?? '')) {
    const minute = Number(rest[0])
    if (minute > DEMO.maxMinute) return { kind: 'error', text: `demo 시작 분은 0~${DEMO.maxMinute}입니다.` }
    return { kind: 'set', patch: { demo: true, demoFrom: minute }, note: `데모 켜짐 (${minute}분부터)` }
  }
  if (word === 'demo' || word === 'alerts') {
    const key = word === 'demo' ? 'demo' : 'alerts'
    const on = toggle(rest, current[key])
    if (on !== undefined) {
      return {
        kind: 'set', patch: { [key]: on }, ...(key === 'demo' ? { clear: ['demoFrom' as const] } : {}),
        note: `${word === 'demo' ? '데모' : '알림'} ${on ? '켜짐' : '꺼짐'}`,
      }
    }
    if (rest.length <= 1) return { kind: 'error', text: `사용법: /lol ${word} [on|off]${word === 'demo' ? '|<시작 분>' : ''}` }
  }
  if (word === 'delay' && bare) return { kind: 'error', text: `사용법: /lol delay <0~${MAX_EXTRA_DELAY}>` }
  if (word === 'delay' && rest.length === 1) {
    const value = Number(rest[0])
    if (!Number.isInteger(value) || value < 0 || value > MAX_EXTRA_DELAY) {
      return { kind: 'error', text: `delay는 0~${MAX_EXTRA_DELAY} 사이 정수(초)입니다.` }
    }
    return { kind: 'set', patch: { delay: value }, note: `추가 지연 ${value}초 (API 조회 ${API_LOOKBACK + value}초 전)` }
  }
  if (word === 'game' && bare) return { kind: 'error', text: '사용법: /lol game auto | /lol game <게임ID> [경기ID] [--at UTC시각]' }
  if (word === 'game' && /^(auto|\d+)$/i.test(rest[0] ?? '')) {
    if (rest.length === 1 && rest[0]?.toLowerCase() === 'auto') {
      return { kind: 'set', patch: {}, clear: ['gameId', 'matchId', 'at'], note: '진행 중 경기 자동 선택' }
    }
    const atIndex = rest.indexOf('--at')
    const at = atIndex >= 0 ? rest[atIndex + 1] : undefined
    const ids = atIndex >= 0 ? rest.slice(0, atIndex) : rest
    if (!ids[0] || !/^\d+$/.test(ids[0]) || (ids[1] && !/^\d+$/.test(ids[1])) || ids.length > 2 ||
        (atIndex >= 0 && (!at || rest.length !== atIndex + 2 || !Number.isFinite(Date.parse(at))))) {
      return { kind: 'error', text: '사용법: /lol game <게임ID> [경기ID] [--at 2026-10-18T18:30:00Z]' }
    }
    const patch: Partial<Settings> = { gameId: ids[0], ...(ids[1] ? { matchId: ids[1] } : {}), ...(at ? { at } : {}) }
    const clear: (keyof Settings)[] = [...(ids[1] ? [] : ['matchId' as const]), ...(at ? [] : ['at' as const])]
    return { kind: 'set', patch, clear, note: `게임 ${ids[0]} 고정${at ? ` (과거 시각 ${at})` : ''}` }
  }
  return { kind: 'ask', question: text }
}

export function applyAction(s: Settings, action: Extract<Action, { kind: 'set' }>): Settings {
  const next: Settings = { ...s, ...action.patch }
  for (const key of action.clear ?? []) delete next[key]
  return next
}

export function describeSettings(s: Settings): string {
  const target = s.demo ? `데모 (${DEMO.label} ${DEMO.gameNumber}세트, ${s.demoFrom ?? DEMO.fromMinute}분부터)` : s.gameId ? `게임 ${s.gameId}${s.matchId ? ` / 경기 ${s.matchId}` : ''}` : '자동'
  return [
    `lol-live ${s.enabled ? '켜짐' : '꺼짐'}`,
    `알림 ${s.alerts ? '켜짐' : '꺼짐'}`,
    `대상 ${target}${s.at ? ` @ ${s.at}` : ''}`,
    `지연 API ${API_LOOKBACK}초 + 추가 ${s.delay}초`,
  ].join(' · ')
}

// Plain-text board for /lol and the model's context.
export function boardText(s: Snapshot, log: readonly string[]): string {
  if (s.state !== 'live') return statusLine(s)
  const { blue, red } = s
  const row = (p?: Player) => (p ? `${p.name} ${p.champion} ${n(p.k)}/${n(p.d)}/${n(p.a)} CS ${p.cs} ${gold(p.gold)}` : '-')
  const lines = [
    `${s.demo ? '[데모] ' : ''}${s.label ?? `${blue.name} vs ${red.name}`}${s.gameNumber ? ` · ${s.gameNumber}세트` : ''}`,
    `${gameClock(s) ? `게임 시간 ${gameClock(s)} · ` : ''}프레임 ${s.frameUtc}${s.demo ? '' : ` (${ago(s.ageSeconds)})`} · ${s.gameState}`,
    `${blue.name} ${n(blue.kills)} : ${n(red.kills)} ${red.name} · ${goldLead(s)}`,
    `골드 ${gold(blue.gold)} : ${gold(red.gold)} · 포탑 ${pair(blue.towers, red.towers)} · 억제기 ${pair(blue.inhibitors, red.inhibitors)} · 바론 ${pair(blue.barons, red.barons)}`,
    `드래곤 ${blue.name} [${blue.dragons.map(d => DRAGON_KO[d] ?? d).join(', ')}] · ${red.name} [${red.dragons.map(d => DRAGON_KO[d] ?? d).join(', ')}]`,
    '',
  ]
  const count = Math.max(blue.players.length, red.players.length)
  for (let i = 0; i < count; i++) {
    const b = blue.players[i], r = red.players[i]
    lines.push(`${(b ?? r)?.role ?? '?'}  ${row(b)}  |  ${row(r)}`)
  }
  if (log.length) lines.push('', '최근 기록 (게임 시간, 두 표본의 차이)', ...log.slice(-12))
  return lines.join('\n')
}

export const dragonName = (type: string) => DRAGON_KO[type] ?? type
