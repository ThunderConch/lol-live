import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { eventDetails, firstFrameMs, liveEvents, liveWindow, schedule } from './api'
import {
  API_LOOKBACK, DEFAULTS, DEMO, HELP, LIVE_MS, LOG_LIMIT, TICK_MS, applyAction, ago, boardText, describeSettings,
  dragonName, errorLine, eventInfo, gameClock, gold, goldLead, kst, loadSettings, nextEvent, nextInterval,
  parseCommand, queryTime, snapshotFromWindow, statusLine, step,
} from './lol'
import type { Alert, Buildings, EventInfo, FeedExtra, LiveSnapshot, PollState, Settings, Side, Snapshot, TeamNames, Track } from './lol'

const STORE_KEY = 'settings'
const SENT_KEY = 'sent-alerts'
const PANE = 'lol'
const SERIES_TTL = 30 * 60_000
// A live series must be missing from getLive this many polls in a row to count as over.
const MISSES_FOR_END = 2
// A frame that has not moved for this long (wall time) means the feed stopped: it closes an open fight.
const STALL_MS = 20_000
// A live window that ends before the time being shown is asked again at most this often.
const REFETCH_MS = 3_000

const snapshotAtom = atom({ plugin: 'lol-live', key: 'snapshot' } as const, null)
const logAtom = atom({ plugin: 'lol-live', key: 'log' } as const, [])
const errorAtom = atom({ plugin: 'lol-live', key: 'error' } as const, null)

let settings: Settings = DEFAULTS
let last: Snapshot | undefined
let pollState: PollState | undefined
// When the next look for a match is due; between looks the module sleeps (see plan).
let nextLookAt = 0
// The schedule, read at most every SCHEDULE_TTL_MS: the 30-second looks before a match reuse it.
let scheduleCache: { at: number; events: unknown[] } | undefined
const SCHEDULE_TTL_MS = 10 * 60_000
let inflight: Promise<void> | undefined
// Bumped on every settings change: a snapshot fetched under older settings is dropped.
let generation = 0
let ticker: Timer | undefined
let prevLive: LiveSnapshot | undefined
let lastAdvanceAt = 0
let track: Track = {}
let lastStatus: string | undefined
let lastError: string | null = null
// Series seen live this process, for set start/end and match end.
const series = new Map<string, EventInfo & { misses: number }>()
let seriesReady = false
let dismissedGame: string | undefined
const pinnedTeams = new Map<string, EventInfo>()
// Each game's first frame: the zero of its clock.
const gameStarts = new Map<string, number>()
// Wall time the demo started at; its game time runs from `demoFrom` minutes on.
let demoAnchor: number | undefined

// What the pane plays: one game's feed, the 10-second window that holds the time shown,
// and how that time moves (live: now minus the lookback; pinned --at: fixed; demo: on from
// where it started). The window is fetched when the time leaves it; the frames inside it
// are played back every TICK_MS.
// `buildings`, where the game's timeline is known (the demo), names each tower and inhibitor.
type Source = { gameId: string; teams: TeamNames; extra: FeedExtra; target: (now: number) => number; growing: boolean; buildings?: Buildings }
type Feed = Source & { window?: unknown; windowStart?: string; lastFrameMs?: number; fetchedAt?: number; retryAt?: number }
let feed: Feed | undefined

function lookback() {
  return API_LOOKBACK + settings.delay
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function gameStart($: EngineInterface, gameId: string): Promise<number | undefined> {
  const known = gameStarts.get(gameId)
  if (known !== undefined) return known
  try {
    const ms = await firstFrameMs($, gameId)
    if (ms !== undefined) gameStarts.set(gameId, ms)
    return ms
  } catch {
    // The clock is optional: the next lookup tries again.
    return undefined
  }
}

// Series alerts are computed before the game is looked at and survive its failure.
type Found = { source?: Source; snap?: Snapshot; error?: string; alerts: Alert[] }

async function discover($: EngineInterface, now: number): Promise<Found> {
  if (settings.demo) {
    const anchor = (demoAnchor ??= now)
    const from = (settings.demoFrom ?? DEMO.fromMinute) * 60_000
    const start = await gameStart($, DEMO.gameId)
    if (start === undefined) return { error: '데모 경기 기록을 받지 못함', alerts: [] }
    return {
      source: {
        gameId: DEMO.gameId, teams: DEMO.teams, growing: false, target: t => start + from + (t - anchor), buildings: DEMO.buildings,
        extra: { demo: true, label: DEMO.label, gameNumber: DEMO.gameNumber, gameStartMs: start, lookbackSeconds: 0 },
      },
      alerts: [],
    }
  }
  if (settings.gameId) {
    try {
      let info: EventInfo | undefined
      if (settings.matchId) {
        info = pinnedTeams.get(settings.matchId) ?? eventInfo(await eventDetails($, settings.matchId))
        pinnedTeams.set(settings.matchId, info)
      }
      const at = settings.at
      const start = await gameStart($, settings.gameId)
      return {
        source: {
          gameId: settings.gameId, teams: info?.teams ?? {}, growing: !at,
          target: at ? () => Date.parse(at) + 9_999 : t => t - lookback() * 1000,
          extra: { ...(info ? { label: info.label } : {}), ...(start !== undefined ? { gameStartMs: start } : {}), lookbackSeconds: lookback() },
        },
        alerts: [],
      }
    } catch (error) {
      return { error: message(error), alerts: [] }
    }
  }
  let infos: EventInfo[]
  try {
    infos = []
    for (const event of await liveEvents($)) {
      const state = (event as { state?: unknown }).state
      if (state !== undefined && state !== 'inProgress') continue
      // getLive only says which matches are on: its live shape is unverified, while
      // getEventDetails (teams with ids, gameWins, games) was checked against the real API.
      const id = eventInfo(event).id
      if (id) infos.push(eventInfo(await eventDetails($, id)))
    }
  } catch (error) {
    return { error: message(error), alerts: [] }
  }
  const alerts = await seriesAlerts($, infos)
  try {
    const playing = infos.find(i => i.game)
    if (playing?.game) {
      const start = await gameStart($, playing.game.id)
      return {
        source: {
          gameId: playing.game.id, teams: playing.teams, growing: true, target: t => t - lookback() * 1000,
          extra: {
            label: playing.label, ...(playing.game.number ? { gameNumber: playing.game.number } : {}),
            ...(start !== undefined ? { gameStartMs: start } : {}), lookbackSeconds: lookback(),
          },
        },
        alerts,
      }
    }
    const waiting = infos[0]
    if (waiting) return { snap: { state: 'waiting', label: waiting.label }, alerts }
    if (!scheduleCache || now - scheduleCache.at >= SCHEDULE_TTL_MS) scheduleCache = { at: now, events: await schedule($) }
    const next = nextEvent(scheduleCache.events, now)
    return { snap: { state: 'idle', ...(next ? { next } : {}) }, alerts }
  } catch (error) {
    return { error: message(error), alerts }
  }
}

const lastFrameOf = (window: unknown) => {
  const frames = (window as { frames?: { rfc460Timestamp?: unknown }[] })?.frames ?? []
  const ms = Date.parse(String(frames.at(-1)?.rfc460Timestamp ?? ''))
  return Number.isFinite(ms) ? ms : undefined
}

// The frame for this moment, out of the cached window, fetching the window it lies in when
// the time moved past the one held (or a live one ran out of frames).
async function replay($: EngineInterface, f: Feed, now: number): Promise<{ snap?: Snapshot; error?: string }> {
  const target = f.target(now)
  const windowStart = queryTime(target, 0)
  const ranOut = f.growing && f.lastFrameMs !== undefined && target > f.lastFrameMs + 1_500 && now - (f.fetchedAt ?? 0) >= REFETCH_MS
  let error: string | undefined
  if ((f.windowStart !== windowStart || ranOut) && now >= (f.retryAt ?? 0)) {
    try {
      const window = await liveWindow($, f.gameId, windowStart)
      Object.assign(f, { window, windowStart, fetchedAt: now, lastFrameMs: lastFrameOf(window), retryAt: 0 })
    } catch (e) {
      // Keep playing what is held; try again a poll later.
      f.retryAt = now + LIVE_MS
      error = message(e)
    }
  }
  if (f.window === undefined) return error ? { error } : {}
  const snap = snapshotFromWindow(f.window, f.teams, f.growing ? now : target, { ...f.extra, atMs: target })
  return { snap, ...(error ? { error } : {}) }
}

// Only a team whose recorded win count went up, with both sides' counts known before and after.
function winner(before: EventInfo, after: EventInfo): string | undefined {
  const known = (info: EventInfo) => info.codes.length >= 2 && info.codes.every(code => info.wins[code] !== undefined)
  if (!known(before) || !known(after)) return undefined
  const up = after.codes.filter(code => (after.wins[code] ?? 0) > (before.wins[code] ?? 0))
  return up.length === 1 ? up[0] : undefined
}

const seriesScore = (info: EventInfo) => info.codes.slice(0, 2).map(c => `${c} ${info.wins[c] ?? '?'}`).join(' : ')
const setName = (info: EventInfo) => (info.game?.number ? `${info.game.number}세트` : '세트')

// Set start, set end (with the winner) and match end, from how live series change.
async function seriesAlerts($: EngineInterface, infos: EventInfo[]): Promise<Alert[]> {
  const alerts: Alert[] = []
  const seen = new Set(infos.map(i => i.id))
  for (const info of infos) {
    const before = series.get(info.id)
    const won = before && winner(before, info)
    if (before && won) {
      alerts.push({ level: 'notify', ttlMs: SERIES_TTL, key: `${info.id}:set-end:${seriesScore(info)}`,
                    text: `🏁 ${info.label} ${setName(before)} 종료: ${won} 승리 (${seriesScore(info)})` })
    }
    if (info.game && (before ? before.game?.id !== info.game.id : seriesReady)) {
      alerts.push({ level: 'notify', ttlMs: SERIES_TTL, key: `${info.id}:set-start:${info.game.id}`,
                    text: `▶ ${info.label} ${setName(info)} 시작` })
    }
    const merged = before && !info.game && before.game ? { ...info, game: before.game } : info
    // Keep the last known win counts when this response lacks them.
    series.set(info.id, { ...merged, wins: Object.keys(info.wins).length ? info.wins : before?.wins ?? {}, misses: 0 })
  }
  for (const [id, before] of series) {
    if (seen.has(id)) continue
    if (before.misses + 1 < MISSES_FOR_END) {
      series.set(id, { ...before, misses: before.misses + 1 })
      continue
    }
    series.delete(id)
    try {
      const final = eventInfo(await eventDetails($, id))
      const won = winner(before, final)
      if (won) {
        alerts.push({ level: 'notify', ttlMs: SERIES_TTL, key: `${id}:set-end:${seriesScore(final)}`,
                      text: `🏁 ${final.label} ${setName(before)} 종료: ${won} 승리` })
      }
      alerts.push({ level: 'notify', ttlMs: SERIES_TTL, key: `${id}:match-end`, text: `🏆 경기 종료: ${final.label} (${seriesScore(final)})` })
    } catch {
      alerts.push({ level: 'notify', ttlMs: SERIES_TTL, key: `${id}:match-end`, text: `🏆 경기 종료: ${before.label}` })
    }
  }
  seriesReady = true
  return alerts
}

// Toasts show in every window. An OS notification goes out once across open sessions:
// the store is re-read right before each claim, and a session with nowhere to show it
// gives the claim back.
async function deliver($: EngineInterface, alerts: Alert[]) {
  if (!settings.alerts) return
  for (const alert of alerts) {
    if (alert.level === 'toast') {
      $.ui.toast(alert.text)
      continue
    }
    const now = await $.clock.now()
    const sent = { ...(((await $.store.get(SENT_KEY)) ?? {}) as Record<string, number>) }
    for (const [key, until] of Object.entries(sent)) if (until <= now) delete sent[key]
    if (sent[alert.key] !== undefined) continue
    sent[alert.key] = now + alert.ttlMs
    await $.store.set(SENT_KEY, sent)
    $.ui.toast(alert.text, { timeoutMs: 8000 })
    try {
      const result = await $.ui.notify(alert.text, { title: 'LoL 라이브' })
      if (!result.isSent && result.reason === 'no-surface') {
        const latest = { ...(((await $.store.get(SENT_KEY)) ?? {}) as Record<string, number>) }
        delete latest[alert.key]
        await $.store.set(SENT_KEY, latest)
      }
    } catch {
      // A refused notification still showed as a toast here.
    }
  }
}

async function showPane($: EngineInterface, snap: Snapshot) {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (snap.state === 'live' && !isOpen && dismissedGame !== snap.gameId) {
    await $.ui.open({ id: PANE, title: 'LoL 라이브' })
  } else if (snap.state === 'idle' && isOpen) {
    await $.ui.close({ id: PANE })
  }
}

function setStatus($: EngineInterface, text: string | undefined) {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function apply($: EngineInterface, now: number, started: number, snap: Snapshot | undefined, error: string | undefined, found: Alert[]) {
  if (!settings.enabled) return
  let alerts = found
  if (started === generation) {
    if (snap || error) {
      pollState = snap ? snap.state : 'error'
      setStatus($, snap ? statusLine(snap) : errorLine(error ?? ''))
    }
    if ((error ?? null) !== lastError) {
      lastError = error ?? null
      await update($, errorAtom, () => lastError)
    }
    if (snap) {
      last = snap
      await update($, snapshotAtom, () => snap)
      if (snap.state === 'live') {
        const advanced = !prevLive || prevLive.gameId !== snap.gameId || snap.frameMs > prevLive.frameMs
        // A frame that stays put for a tick is the replay waiting on the feed; for STALL_MS it is the feed stopping.
        if (advanced || now - lastAdvanceAt >= STALL_MS) {
          const moved = step(prevLive, snap, track, feed?.gameId === snap.gameId ? feed.buildings : undefined)
          track = moved.track
          if (advanced) prevLive = snap
          lastAdvanceAt = now
          if (moved.log.length) await update($, logAtom, log => [...log, ...moved.log].slice(-LOG_LIMIT))
          alerts = [...alerts, ...moved.alerts]
        }
      }
      await showPane($, snap)
    }
  }
  await deliver($, alerts)
}

// When to look for a match again, from what the last look found.
function lookEvery(now: number): number {
  // A series that just left getLive is confirmed over at LIVE_MS, not after a sleep.
  if (pollState === 'idle' && series.size > 0) return LIVE_MS
  return nextInterval(pollState, now, last?.state === 'idle' ? last.next?.startMs : undefined)
}

// The one timer: TICK_MS while a game is shown (live or replayed), else straight to the next
// look, so between matches nothing runs until shortly before the next one.
function plan($: EngineInterface, now: number) {
  ticker?.cancel()
  ticker = undefined
  if (!settings.enabled) return
  const wait = feed ? TICK_MS : Math.max(TICK_MS, nextLookAt - now)
  ticker = $.clock.after(wait, () => void tick($))
}

// Look for the game to show when that is due, and play the frame for this moment.
async function tick($: EngineInterface, force = false) {
  if (!settings.enabled || inflight) return
  const now = await $.clock.now()
  const due = force || now >= nextLookAt - 500
  if (!due && !feed) return plan($, now)
  const started = generation
  inflight = (async () => {
    let alerts: Alert[] = []
    if (due) {
      const found = await discover($, now)
      if (started !== generation) return
      alerts = found.alerts
      if (!found.source) {
        feed = undefined
        await apply($, now, started, found.snap, found.error, alerts)
        return
      }
      const held = feed
      feed = held && held.gameId === found.source.gameId ? Object.assign(held, found.source) : { ...found.source }
    }
    if (!feed) return
    const played = await replay($, feed, now)
    await apply($, now, started, played.snap, played.error, alerts)
  })().finally(() => {
    inflight = undefined
  })
  await inflight
  if (due) nextLookAt = now + lookEvery(now)
  plan($, now)
}

async function save($: EngineInterface, next: Settings) {
  const targetChanged = next.demo !== settings.demo || next.demoFrom !== settings.demoFrom ||
    next.gameId !== settings.gameId || next.at !== settings.at
  settings = next
  generation += 1
  pollState = undefined
  await $.store.set(STORE_KEY, settings)
  if (targetChanged) {
    prevLive = undefined
    track = {}
    feed = undefined
    demoAnchor = undefined
    lastAdvanceAt = 0
    dismissedGame = undefined
    await update($, logAtom, () => [])
  }
  if (!settings.enabled) {
    plan($, 0)
    setStatus($, undefined)
    if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
    return
  }
  // Let a tick begun under the old settings finish (its result is dropped), then look anew.
  if (inflight) await inflight
  await tick($, true)
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

function sideBlock({ Box, Text }: Elements, side: Side, color: string) {
  return (
    <Box flexDirection="column" width="50%">
      <Text bold color={color} wrap="truncate">{side.name}</Text>
      {side.players.map(p => (
        <Text wrap="truncate">
          {p.role} {p.name} <Text dimColor>{p.champion}</Text> {p.k ?? '?'}/{p.d ?? '?'}/{p.a ?? '?'}
          <Text dimColor> CS {p.cs} {gold(p.gold)}</Text>
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    settings = loadSettings(await $.store.get(STORE_KEY))
    await $.command.register({
      name: 'lol',
      description: 'LoL 라이브: 상태줄·패널·한타 알림 제어, 전체 스냅샷, 현재 경기 질문',
      argumentHint: '[panel|on|off|alerts|status|list|game|delay|demo [분]|help|질문]',
      immediate: true,
    })
    void tick($, true)
    return started
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && (last?.state === 'live' || last?.state === 'buffering')) dismissedGame = last.gameId
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const snap = await read($, snapshotAtom)
    const log = await read($, logAtom)
    const error = await read($, errorAtom)
    if (!snap || snap.state !== 'live') {
      return (
        <Box flexDirection="column">
          <Text dimColor>{snap ? statusLine(snap) : '불러오는 중…'}</Text>
          {error && <Text color="red">{errorLine(error)}</Text>}
        </Box>
      )
    }
    const { blue, red } = snap
    const clock = gameClock(snap)
    const rows = Math.max(4, (e.viewport?.rows ?? 30) - 16)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor wrap="truncate">
            {snap.demo ? '[데모] ' : ''}{snap.label ?? ''}{snap.gameNumber ? ` · ${snap.gameNumber}세트` : ''} · {snap.demo ? '다시보기' : `${ago(snap.ageSeconds)} · 지연 ${lookback()}초`}
          </Text>
          {error && <Text color="red" wrap="truncate">{errorLine(error)} (마지막 성공 데이터 표시 중)</Text>}
          <Text bold size="title">
            <Text color="blue">{blue.name} {blue.kills ?? '?'}</Text> : <Text color="red">{red.kills ?? '?'} {red.name}</Text>
            {clock ? <Text dimColor>{`  ⏱ ${clock}`}</Text> : null}
          </Text>
          <Text wrap="truncate">
            {goldLead(snap)} · 포탑 {blue.towers ?? '?'}:{red.towers ?? '?'} · 바론 {blue.barons ?? '?'}:{red.barons ?? '?'} · 억제기 {blue.inhibitors ?? '?'}:{red.inhibitors ?? '?'}
          </Text>
          <Text dimColor wrap="truncate">
            드래곤 {blue.dragons.map(dragonName).join('·') || '-'} / {red.dragons.map(dragonName).join('·') || '-'}
          </Text>
        </Box>
        <Box flexDirection="row">
          {sideBlock(elements, blue, 'blue')}
          {sideBlock(elements, red, 'red')}
        </Box>
        <Box flexDirection="column">
          {log.length === 0 && <Text dimColor>기록 없음 (관측된 변화가 생기면 게임 시간과 함께 표시)</Text>}
          {log.slice(-rows).map(line => <Text dimColor wrap="truncate">{line}</Text>)}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="slower" label="지연 +5" onPress={() => void save($, { ...settings, delay: Math.min(120, settings.delay + 5) })} />
          <Button key="faster" label="지연 -5" onPress={() => void save($, { ...settings, delay: Math.max(0, settings.delay - 5) })} />
          <Button key="alerts" label={settings.alerts ? '알림 끄기' : '알림 켜기'}
                  onPress={() => void save($, { ...settings, alerts: !settings.alerts })} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'lol' }, async ($, e) => {
    const action = parseCommand(e.args, settings)
    switch (action.kind) {
      case 'help':
        return { text: HELP }
      case 'error':
        return { text: action.text }
      case 'status':
        return { text: `${last ? statusLine(last) : '(아직 갱신 전)'}\n${describeSettings(settings)}` }
      case 'set':
        await save($, applyAction(settings, action))
        return { text: `${action.note}\n${describeSettings(settings)}` }
      case 'panel': {
        if (last?.state === 'live') dismissedGame = undefined
        const opened = await $.ui.open({ id: PANE, title: 'LoL 라이브' })
        return { text: opened.isPlaced ? '패널을 열었습니다.' : `패널을 아직 놓지 못했습니다: ${opened.reason}` }
      }
      case 'list': {
        try {
          const now = await $.clock.now()
          const events = (await schedule($)) as { state?: string; startTime?: string }[]
          const lines = events
            .filter(ev => ev.state !== 'completed' && Date.parse(ev.startTime ?? '') >= now - 6 * 3600_000)
            .sort((a, b) => Date.parse(a.startTime ?? '') - Date.parse(b.startTime ?? ''))
            .slice(0, 15)
            .map(ev => `${kst(ev.startTime ?? '')}  ${eventInfo(ev).label}${ev.state === 'inProgress' ? '  [진행 중]' : ''}`)
          return { text: lines.length ? `한국 시간 기준\n${lines.join('\n')}` : '예정된 경기가 없습니다.' }
        } catch (error) {
          return { text: errorLine(error instanceof Error ? error.message : String(error)) }
        }
      }
      case 'snapshot': {
        await tick($, true)
        return { text: last ? boardText(last, await read($, logAtom)) : '(스냅샷 없음) /lol status로 오류를 확인하세요.' }
      }
      case 'ask': {
        await tick($, true)
        if (!last || pollState === 'error') {
          return { text: '스냅샷을 가져오지 못해 질문을 보내지 않았습니다. /lol status로 오류를 확인하세요.' }
        }
        void $.prompt.submit({ text: action.question, asUser: true })
        return {
          text: `${statusLine(last)}\n이 스냅샷을 붙여 질문했습니다.`,
          context: [
            'lol-live mod가 방금 받은 LoL 경기 스냅샷입니다. 비공식 LoL Esports API 기준이며 방송보다 늦거나 빠를 수 있고, ' +
              '기록은 두 표본의 차이입니다. 이 데이터에 없는 사실(누가 누구를 잡았는지 등)은 지어내지 마세요.\n' +
              boardText(last, await read($, logAtom)) + '\n\nJSON: ' + JSON.stringify(last),
          ],
        }
      }
    }
  })
}
