import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  DEFAULTS, DEMO, IDLE_MS, LIVE_MS, TICK_MS, applyAction, closeFight, eventInfo, errorLine, gameClock, loadSettings, nextEvent,
  nextInterval, parseCommand, queryTime, snapshotFromWindow, statusLine, step,
} from './lol'
import type { LiveSnapshot } from './lol'

const T0 = Date.parse('2026-10-24T17:20:00Z')

type P = { k: number; d: number }
function frame(ms: number, blue: { kills: number; towers?: number; barons?: number; dragons?: string[]; gold?: number; players?: P[] },
               red: { kills: number; towers?: number; barons?: number; dragons?: string[]; gold?: number; players?: P[] }) {
  const team = (t: typeof blue, offset: number) => ({
    totalKills: t.kills, totalGold: t.gold ?? 30_000, towers: t.towers ?? 0, barons: t.barons ?? 0, inhibitors: 0,
    dragons: t.dragons ?? [],
    participants: (t.players ?? [0, 0, 0, 0, 0].map(() => ({ k: 0, d: 0 }))).map((p, i) => ({
      participantId: offset + i + 1, level: 10, kills: p.k, deaths: p.d, assists: 0, creepScore: 100, totalGold: 6000,
    })),
  })
  return { rfc460Timestamp: new Date(ms).toISOString(), gameState: 'in_game', blueTeam: team(blue, 0), redTeam: team(red, 5) }
}
const names = ['Zeus', 'Oner', 'Faker', 'Gumayusi', 'Keria', 'Kiin', 'Canyon', 'Chovy', 'Ruler', 'Duro']
const champs = ['Gnar', 'LeeSin', 'Ahri', 'Jinx', 'Braum', 'Ornn', 'Vi', 'Azir', 'Ashe', 'Leona']
const roles = ['top', 'jungle', 'mid', 'bottom', 'support']
const meta = {
  blueTeamMetadata: { esportsTeamId: 't1', participantMetadata: roles.map((role, i) => ({ participantId: i + 1, summonerName: names[i], championId: champs[i], role })) },
  redTeamMetadata: { esportsTeamId: 'gen', participantMetadata: roles.map((role, i) => ({ participantId: i + 6, summonerName: names[i + 5], championId: champs[i + 5], role })) },
}
const TEAMS = { t1: 'T1', gen: 'GEN' }
function snap(f: ReturnType<typeof frame>): LiveSnapshot {
  const s = snapshotFromWindow({ esportsGameId: 'g1', gameMetadata: meta, frames: [f] }, TEAMS, Date.parse(f.rfc460Timestamp) + 60_000)
  if (s.state !== 'live') throw new Error('expected live')
  return s
}
const zero = () => [0, 1, 2, 3, 4].map(() => ({ k: 0, d: 0 }))
const withStats = (stats: [number, number][]) => stats.map(([k, d]) => ({ k, d }))

test('snapshot: latest frame, team codes, Korean names, status line', async () => {
  const s = snap(frame(T0, { kills: 6, gold: 34_100, towers: 1, dragons: [] }, { kills: 2, gold: 30_800, dragons: ['infernal'] }))
  expect(s.blue.name).toBe('T1')
  expect(s.blue.players[2]).toMatchObject({ role: '미드', name: 'Faker', champion: '아리' })
  // Score only, until the game's first frame is known; then whole 5 minutes of game time.
  expect(statusLine(s)).toBe('⚔ T1 6:2 GEN')
  const f = frame(T0, { kills: 6 }, { kills: 2 })
  const timed = snapshotFromWindow({ esportsGameId: 'g1', gameMetadata: meta, frames: [f] }, TEAMS, T0 + 60_000,
                                   { gameStartMs: T0 - (17 * 60 + 5) * 1000, lookbackSeconds: 60 })
  if (timed.state !== 'live') throw new Error('expected live')
  expect(statusLine(timed)).toBe('⚔ T1 6:2 GEN (15분)')
  expect(gameClock(timed)).toBe('17:05')
  // A feed that stopped says so.
  const stale = snapshotFromWindow({ esportsGameId: 'g1', gameMetadata: meta, frames: [f] }, TEAMS, T0 + 200_000, { lookbackSeconds: 60 })
  expect(statusLine(stale)).toBe('⚔ T1 6:2 GEN · ⚠ 3분 전 데이터')
})

test('the frame shown is the one at the replay time, not the last of the window', async () => {
  const frames = [0, 1000, 2000, 3000].map(ms => frame(T0 + ms, { kills: ms / 1000 }, { kills: 0 }))
  const at = snapshotFromWindow({ esportsGameId: 'g1', gameMetadata: meta, frames }, TEAMS, T0, { atMs: T0 + 1500 })
  if (at.state !== 'live') throw new Error('expected live')
  expect(at.frameMs).toBe(T0 + 1000)
  expect(at.blue.kills).toBe(1)
})

test('a kill is a toast the moment it is seen; a small fight adds no summary', async () => {
  const a = snap(frame(T0, { kills: 0, players: zero() }, { kills: 0, players: zero() }))
  const b = snap(frame(T0 + 10_000, { kills: 1, players: withStats([[0, 0], [0, 0], [1, 0], [0, 0], [0, 0]]) },
                                    { kills: 0, players: withStats([[0, 0], [0, 0], [0, 1], [0, 0], [0, 0]]) }))
  const opened = step(a, b, {})
  expect(opened.alerts).toEqual([expect.objectContaining({ level: 'toast', text: '⚔ T1 Faker 킬 · GEN Chovy 사망 (1:0)' })])
  expect(opened.log).toEqual(['17:20:10 ⚔ T1 Faker 킬 · GEN Chovy 사망 (1:0)'])
  expect(opened.track.fight?.kills).toEqual({ blue: 1, red: 0 })
  const c = snap(frame(T0 + 20_000, { kills: 1, players: withStats([[0, 0], [0, 0], [1, 0], [0, 0], [0, 0]]) },
                                    { kills: 0, players: withStats([[0, 0], [0, 0], [0, 1], [0, 0], [0, 0]]) }))
  const closed = step(b, c, opened.track)
  expect(closed.track.fight).toBe(undefined)
  expect(closed.alerts).toEqual([])
})

test('kills over consecutive polls become one teamfight summary with who killed and who died', async () => {
  const a = snap(frame(T0, { kills: 4, players: withStats([[1, 0], [1, 0], [1, 0], [1, 0], [0, 0]]) },
                           { kills: 1, players: withStats([[1, 1], [0, 1], [0, 1], [0, 1], [0, 0]]) }))
  const b = snap(frame(T0 + 10_000, { kills: 6, players: withStats([[1, 0], [1, 0], [3, 0], [1, 0], [0, 1]]) },
                                    { kills: 2, players: withStats([[2, 1], [0, 2], [0, 2], [0, 1], [0, 0]]) }))
  const c = snap(frame(T0 + 20_000, { kills: 7, barons: 1, players: withStats([[1, 0], [1, 0], [3, 0], [2, 0], [0, 1]]) },
                                    { kills: 2, players: withStats([[2, 1], [0, 2], [0, 2], [0, 2], [0, 0]]) }))
  const d = snap(frame(T0 + 30_000, { kills: 7, barons: 1, players: withStats([[1, 0], [1, 0], [3, 0], [2, 0], [0, 1]]) },
                                    { kills: 2, players: withStats([[2, 1], [0, 2], [0, 2], [0, 2], [0, 0]]) }))
  const s1 = step(a, b, {})
  const s2 = step(b, c, s1.track)
  expect(s1.alerts.map(x => x.text)).toEqual(['⚔ T1 Faker ×2 킬 · GEN Kiin 킬 · T1 Keria 사망 · GEN Canyon·Chovy 사망 (6:2)'])
  expect(s2.alerts.map(x => x.text)).toEqual(['🟣 T1 내셔 남작 처치', '⚔ T1 Gumayusi 킬 · GEN Ruler 사망 (7:2)'])
  // Ten seconds of game time with no kill ends the fight: a short headline, the details in the log.
  const s3 = step(c, d, s2.track)
  expect(s3.alerts).toHaveLength(1)
  expect(s3.alerts[0]).toMatchObject({ level: 'notify', key: 'g1:fight:7:2', text: '💥 한타 T1 3:1 GEN → T1 승리 (7:2) · T1 바론' })
  expect(s3.log).toEqual([
    '17:20:30 💥 한타 T1 3:1 GEN → T1 승리 (7:2) · T1 바론',
    '  └ T1  처치 Faker 2킬·Gumayusi 1킬 │ 사망 Keria',
    '  └ GEN 처치 Kiin 1킬 │ 사망 Canyon·Chovy·Ruler',
  ])
})

test('a fight summary splits kills and deaths by side, every killer with a count, a repeat death as ×n', async () => {
  const cur = snap(frame(T0, { kills: 5 }, { kills: 4 }))
  const fight = { startMs: T0, lastKillMs: T0, objectives: [] }
  expect(closeFight({ ...fight, kills: { blue: 1, red: 1 }, killers: { Chovy: 1, Faker: 1 }, deaths: ['Ruler', 'Keria'] }, cur)).toEqual({ alerts: [], log: [] })
  const big = closeFight({ ...fight, kills: { blue: 1, red: 3 }, killers: { Kiin: 1, Chovy: 2, Oner: 1 }, deaths: ['Keria', 'Faker', 'Keria', 'Zeus'] }, cur)
  expect(big.alerts.map(a => a.text)).toEqual(['💥 한타 T1 1:3 GEN → GEN 승리 (5:4)'])
  expect(big.log).toEqual([
    '17:20:00 💥 한타 T1 1:3 GEN → GEN 승리 (5:4)',
    '  └ T1  처치 Oner 1킬 │ 사망 Keria ×2·Faker·Zeus',
    '  └ GEN 처치 Chovy 2킬·Kiin 1킬 │ 사망 -',
  ])
})

test('dragon types; a gold lead flip through small leads still alerts once', async () => {
  const a = snap(frame(T0, { kills: 0, gold: 31_500 }, { kills: 0, gold: 30_000 }))
  const b = snap(frame(T0 + 10_000, { kills: 0, gold: 31_000 }, { kills: 0, gold: 31_400, dragons: ['ocean'] }))
  const c = snap(frame(T0 + 20_000, { kills: 0, gold: 31_000 }, { kills: 0, gold: 32_500, dragons: ['ocean'] }))
  const s1 = step(undefined, a, {})
  const s2 = step(a, b, s1.track)
  expect(s1.track.leader).toBe('blue')
  expect(s2.alerts.map(x => x.text)).toEqual(['🐉 GEN 바다 드래곤 (1번째)'])
  expect(step(b, c, s2.track).alerts.map(x => x.text)).toEqual(['🔄 골드 역전: GEN +1.5k'])
})

test('the fight that ends a game is announced when frames stop or the game changes', async () => {
  const a = snap(frame(T0, { kills: 10 }, { kills: 5 }))
  const b = snap(frame(T0 + 10_000, { kills: 13 }, { kills: 5 }))
  const open = step(a, b, {})
  expect(open.track.fight?.kills).toEqual({ blue: 3, red: 0 })
  const stalled = step(b, b, open.track)
  expect(stalled.track.fight).toBe(undefined)
  expect(stalled.alerts[0]?.text).toMatch(/^💥 한타 T1 3:0 GEN → T1 승리 \(13:5\)/)
  const other = { ...b, gameId: 'g2' }
  expect(step(b, other, open.track).alerts[0]?.key).toBe('g1:fight:13:5')
})

test('delay is API 60s plus 0..120, floored to 10s', async () => {
  expect(queryTime(Date.parse('2026-10-24T17:20:07Z'), 60)).toBe('2026-10-24T17:19:00Z')
  expect(queryTime(Date.parse('2026-10-24T17:20:07Z'), 180)).toBe('2026-10-24T17:17:00Z')
  expect(parseCommand('delay 120')).toMatchObject({ kind: 'set', patch: { delay: 120 } })
  expect(parseCommand('delay 300').kind).toBe('error')
  expect(loadSettings({ delay: 300 }).delay).toBe(120)
})

test('commands parse; toggles; anything else is a question', async () => {
  expect(parseCommand('').kind).toBe('snapshot')
  expect(parseCommand('panel').kind).toBe('panel')
  expect(parseCommand('demo')).toMatchObject({ patch: { demo: true } })
  expect(parseCommand('demo', { ...DEFAULTS, demo: true })).toMatchObject({ patch: { demo: false } })
  expect(parseCommand('demo 25')).toMatchObject({ kind: 'set', patch: { demo: true, demoFrom: 25 } })
  expect(parseCommand('demo 99').kind).toBe('error')
  expect(loadSettings({ demo: true, demoFrom: 25 }).demoFrom).toBe(25)
  const fromDemo = parseCommand('demo off')
  if (fromDemo.kind !== 'set') throw new Error('expected set')
  expect(applyAction({ ...DEFAULTS, demo: true, demoFrom: 25 }, fromDemo)).toEqual(DEFAULTS)
  expect(parseCommand('alerts')).toMatchObject({ patch: { alerts: false } })
  expect(parseCommand('alerts on')).toMatchObject({ patch: { alerts: true } })
  expect(parseCommand('지금 누가 유리해?')).toEqual({ kind: 'ask', question: '지금 누가 유리해?' })
  expect(parseCommand('status 바론 몇 개야?').kind).toBe('ask')
  expect(parseCommand('game 몇세트야?').kind).toBe('ask')
  expect(parseCommand('game 1 --at 2026-10-18T18:30:00Z junk').kind).toBe('error')
  const pinned = parseCommand('game 116299649498303885 116299649498303884 --at 2026-10-18T18:30:00Z')
  const auto = parseCommand('game auto')
  if (pinned.kind !== 'set' || auto.kind !== 'set') throw new Error('expected set')
  expect(applyAction(applyAction(DEFAULTS, pinned), auto)).toEqual(DEFAULTS)
})

test('idle: next match in KST without results; intervals; errors', async () => {
  const schedule = [
    { state: 'completed', startTime: '2026-10-18T18:00:00Z', match: { teams: [{ code: 'KC' }, { code: 'MVK' }] } },
    { state: 'unstarted', startTime: '2026-10-23T17:00:00Z', match: { teams: [{ code: 'GEN' }, { code: 'IG' }] } },
  ]
  expect(nextEvent(schedule, Date.parse('2026-10-19T00:00:00Z'))).toEqual({ label: 'GEN vs IG', kst: '10/24 02:00' })
  expect(nextInterval('live')).toBe(LIVE_MS)
  expect(nextInterval('idle')).toBe(IDLE_MS)
  expect(nextInterval('error')).toBe(60_000)
  expect(errorLine('HTTP 429: API 호출 한도 초과')).toBe('⚔ LoL: HTTP 429: API 호출 한도 초과')
})

// Trimmed from the real getEventDetails response for Worlds KC vs MVK (fetched 2026-10-19).
const REAL_DETAILS = {"id": "116299649498303884", "type": "match", "league": {"id": "98767975604431411", "slug": "worlds", "name": "월드 챔피언십"}, "match": {"strategy": {"count": 5}, "teams": [{"id": "111692118851466302", "name": "Karmine Corp", "code": "KC", "result": {"gameWins": 3}}, {"id": "107251245690956393", "name": "MVK Esports", "code": "MVK", "result": {"gameWins": 0}}], "games": [{"number": 1, "id": "116299649498303885", "state": "completed"}, {"number": 2, "id": "116299649498303886", "state": "completed"}, {"number": 3, "id": "116299649498303887", "state": "completed"}, {"number": 4, "id": "116299649498303888", "state": "unneeded"}, {"number": 5, "id": "116299649498303889", "state": "unneeded"}]}}

test('eventInfo reads the real getEventDetails shape', async () => {
  expect(eventInfo(REAL_DETAILS)).toEqual({
    id: '116299649498303884', label: '월드 챔피언십 · KC vs MVK', codes: ['KC', 'MVK'],
    teams: { '111692118851466302': 'KC', '107251245690956393': 'MVK' }, wins: { KC: 3, MVK: 0 },
  })
  // A game in progress: the 'inProgress' spelling is lol_tui's assumption, not yet seen live.
  const live = { ...REAL_DETAILS, match: { ...REAL_DETAILS.match, games: REAL_DETAILS.match.games.map(g => g.number === 3 ? { ...g, state: 'inProgress' } : g) } }
  expect(eventInfo(live).game).toEqual({ id: '116299649498303887', number: 3 })
})

/// ----- the mod in the engine -----

const START = { cwd: '/tmp', surface: 'terminal' as const, isInteractive: true }
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 200 } }

// A stand-in for the demo game's feed, shaped like the real one: the window asked without a
// starting time opens at the game's first frame, and every other window holds a frame per
// second for its 10 seconds. A three-kill fight every 3 minutes (blue +2, red +1 ten seconds
// later) plus stray kills; each team's kills spread over its players in order.
const GAME0 = Date.parse('2026-09-13T08:19:07Z')
const DEMO_IDS = Object.keys(DEMO.teams)
const DEMO_NAMES = ['GEN Kiin', 'GEN Canyon', 'GEN Chovy', 'GEN Ruler', 'GEN Duro', 'HLE Zeus', 'HLE Kanavi', 'HLE Zeka', 'HLE Gumayusi', 'HLE Delight']

function fakeFrame(ms: number) {
  const elapsed = Math.floor((ms - GAME0) / 1000)
  const kills = [Math.floor(elapsed / 150) + 2 * Math.floor((elapsed + 20) / 180),
                 Math.floor(elapsed / 170) + Math.floor((elapsed + 10) / 180)]
  const team = (offset: number) => {
    const own = kills[offset ? 1 : 0] ?? 0, other = kills[offset ? 0 : 1] ?? 0
    return {
      totalGold: 10_000 + elapsed * (offset ? 20 : 22), totalKills: own, towers: 0, inhibitors: 0, barons: 0, dragons: [],
      participants: [0, 1, 2, 3, 4].map(i => ({
        participantId: offset + i + 1, level: 12, assists: 0, creepScore: 200, totalGold: 8000,
        kills: Math.floor(own / 5) + (i < own % 5 ? 1 : 0), deaths: Math.floor(other / 5) + (i < other % 5 ? 1 : 0),
      })),
    }
  }
  return { rfc460Timestamp: new Date(ms).toISOString(), gameState: 'in_game', blueTeam: team(0), redTeam: team(5) }
}

function fakeDemoFeed(on: Parameters<TestBody>[1], asked: string[] = []) {
  const meta = (offset: number) => ({
    esportsTeamId: DEMO_IDS[offset ? 1 : 0],
    participantMetadata: roles.map((role, i) => ({ participantId: offset + i + 1, summonerName: DEMO_NAMES[offset + i], championId: champs[offset + i], role })),
  })
  on('http.fetch', async (_$, e) => {
    asked.push(e.url)
    const m = /\/window\/(\d+)(?:\?startingTime=([^&]+))?$/.exec(e.url)
    if (!m || m[1] !== DEMO.gameId) return { value: { status: 404, ok: false, headers: {}, text: '' } } as never
    const from = m[2] ? Date.parse(decodeURIComponent(m[2])) : GAME0
    const frames = Array.from({ length: m[2] ? 10 : 2 }, (_, i) => fakeFrame(from + i * 1000))
    const body = { esportsGameId: DEMO.gameId, gameMetadata: { blueTeamMetadata: meta(0), redTeamMetadata: meta(5) }, frames }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
}

test('demo: the real final replays; status line is score and 5-minute game time; /lol off stops it', async ($, on) => {
  const clock = mock.clock(on)
  clock.set(T0)
  mock.store(on, { settings: { demo: true } })
  fakeDemoFeed(on)
  const statuses: (string | undefined)[] = []
  const opened: string[] = []
  const closed: string[] = []
  on('ui.status', async (_$, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.panes', async () => ({ value: opened.filter(id => !closed.includes(id)).map(id => ({ id, title: 'LoL 라이브', isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.open', async (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', async (_$, e) => { closed.push(e.id); return { value: undefined } })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.notify', async () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'lol' } }))
  await $.session.start(START)
  await clock.settle()
  // Demo time starts at DEMO.fromMinute (19:00): the status line rounds down to 15분.
  expect(statuses.at(-1)).toMatch(/^⚔ \[데모\] GEN \d+:\d+ HLE \(15분\)$/)
  expect(opened).toEqual(['lol'])
  await clock.advance(70_000)
  expect(statuses.at(-1)).toMatch(/^⚔ \[데모\] GEN \d+:\d+ HLE \(20분\)$/)
  const off = await $.command.run({ command: 'lol', args: 'off', ...RUN })
  expect(off.text).toContain('lol-live 꺼짐')
  expect(statuses.at(-1)).toBe(undefined)
  expect(closed).toEqual(['lol'])
  const count = statuses.length
  await clock.advance(LIVE_MS * 3)
  expect(statuses.length).toBe(count)
})

test('a kill is told within a tick of its frame, stamped with game time', async ($, on) => {
  const clock = mock.clock(on)
  await clock.set(T0)
  mock.store(on, { settings: { demo: true } })
  fakeDemoFeed(on)
  const toasts: string[] = []
  on('ui.status', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', async () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'lol' } }))
  await $.session.start(START)
  await clock.settle()
  // The first kill after 19:00 in the fake feed is HLE's at 19:50 (elapsed 1190 s): 50 s in.
  await clock.advance(48_000)
  expect(toasts).toEqual([])
  await clock.advance(TICK_MS)
  expect(toasts).toEqual(['⚔ HLE Zeka 킬 · GEN Chovy 사망 (19:13)'])
  const board = await $.command.run({ command: 'lol', args: '', ...RUN })
  expect(board.text).toContain('게임 시간 19:5')
  expect(board.text).toContain('19:50 ⚔ HLE Zeka 킬 · GEN Chovy 사망 (19:13)')
})

async function runDemo($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], sent: Record<string, number>) {
  const clock = mock.clock(on)
  clock.set(T0)
  mock.store(on, { settings: { demo: true }, 'sent-alerts': sent })
  fakeDemoFeed(on)
  const notes: string[] = []
  on('ui.status', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.notify', async (_$, e) => { notes.push(e.text); return { value: { isSent: true, channel: 'terminal_bell' } } as never })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'lol' } }))
  await $.session.start(START)
  for (let i = 0; i < 40; i++) await clock.advance(LIVE_MS)
  return notes.filter(n => n.startsWith('💥'))
}

test('demo teamfights are summarized as one short notification each', async ($, on) => {
  const fights = await runDemo($, on, {})
  expect(fights.length).toBeGreaterThan(0)
  for (const fight of fights) expect(fight).toMatch(/^💥 한타 GEN \d+:\d+ HLE( → (GEN|HLE) 승리)? \(\d+:\d+\)/)
})

test('a notification another session already sent is not sent again', async ($, on) => {
  const sent: Record<string, number> = {}
  for (let b = 0; b < 80; b++) for (let r = 0; r < 80; r++) sent[`${DEMO.gameId}:fight:${b}:${r}`] = T0 + 3_600_000
  expect(await runDemo($, on, sent)).toEqual([])
})

test('set start, set end with the winner, match end — even when the game window fails', async ($, on) => {
  const clock = mock.clock(on)
  clock.set(T0)
  mock.store(on)
  let phase = 1
  const notes: string[] = []
  const teams = (t1: number, gen: number) => [
    { id: 't1', code: 'T1', result: { gameWins: t1 } }, { id: 'gen', code: 'GEN', result: { gameWins: gen } }]
  // Shaped like the real getEventDetails event (see REAL_DETAILS): no state, no match.id.
  const event = (games: { id: string; number: number; state: string }[], t1: number, gen: number) => ({
    id: 'm1', type: 'match', league: { id: 'L1', slug: 'lck', name: 'LCK' },
    match: { strategy: { count: 3 }, teams: teams(t1, gen), games },
  })
  const ok = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', async (_$, e) => {
    const url = e.url
    if (url.includes('getLeagues')) return ok({ data: { leagues: [{ id: 'L1', slug: 'lck', name: 'LCK' }, { id: 'L2', slug: 'worlds', name: 'Worlds' }] } })
    if (url.includes('getSchedule')) return ok({ data: { schedule: { events: [] } } })
    if (url.includes('getEventDetails')) {
      const detail = phase <= 2 ? event([{ id: 'g1', number: 1, state: 'inProgress' }], 0, 0)
        : phase === 3 ? event([{ id: 'g1', number: 1, state: 'completed' }, { id: 'g2', number: 2, state: 'inProgress' }], 1, 0)
        : event([{ id: 'g1', number: 1, state: 'completed' }, { id: 'g2', number: 2, state: 'completed' }], 2, 0)
      return ok({ data: { event: detail } })
    }
    if (url.includes('getLive')) {
      // Only the match id is relied on from getLive.
      const events = phase <= 3 ? [{ id: 'm1', type: 'match', state: 'inProgress', league: { id: 'L1', slug: 'lck', name: 'LCK' }, match: { id: 'm1', teams: [] } }] : []
      return ok({ data: { schedule: { events } } })
    }
    if (url.includes('/window/g2')) return { value: { status: 404, ok: false, headers: {}, text: '' } }
    return ok({ esportsGameId: 'g1', gameMetadata: meta, frames: [frame(Date.parse(new Date(T0).toISOString()), { kills: 1 }, { kills: 0 })] })
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.notify', async (_$, e) => { notes.push(e.text); return { value: { isSent: true, channel: 'terminal_bell' } } as never })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: { command: 'lol' } }))
  await $.session.start(START)
  await clock.settle()
  await clock.advance(LIVE_MS)
  expect(notes).toEqual([])
  phase = 3
  await clock.advance(LIVE_MS)
  expect(notes).toEqual(['🏁 LCK · T1 vs GEN 1세트 종료: T1 승리 (T1 1 : GEN 0)', '▶ LCK · T1 vs GEN 2세트 시작'])
  phase = 4
  await clock.advance(IDLE_MS)
  expect(notes).toHaveLength(2)
  await clock.advance(IDLE_MS)
  expect(notes.slice(2)).toEqual(['🏁 LCK · T1 vs GEN 2세트 종료: T1 승리', '🏆 경기 종료: LCK · T1 vs GEN (T1 2 : GEN 0)'])
})
