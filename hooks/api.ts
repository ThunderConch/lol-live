// LoL Esports website endpoints through $.http: no Python, so the mod runs the same on
// Linux, macOS and Windows (terminal or desktop app). Unofficial API; schemas may change.

import type { EngineInterface } from 'claude-code'

import { isTargetLeague } from './lol'

const PERSISTED = 'https://esports-api.lolesports.com/persisted/gw'
const FEED = 'https://feed.lolesports.com/livestats/v1'
// The key the public lolesports.com website ships to browsers; not a Riot developer key.
const PUBLIC_WEBSITE_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'

const HTTP_ERRORS: Record<number, string> = {
  400: 'API가 요청 값을 거절함', 401: '웹사이트 API 키 거절', 403: '접근 거부',
  404: '경기 피드 없음', 429: 'API 호출 한도 초과',
}

let leagueIds: Set<string> | undefined

export async function getJson($: EngineInterface, base: string, endpoint: string, params: Record<string, string>) {
  const query = new URLSearchParams(params).toString()
  const response = await $.http.fetch(`${base}/${endpoint}${query ? `?${query}` : ''}`, {
    headers: { Accept: 'application/json', 'x-api-key': PUBLIC_WEBSITE_KEY },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${HTTP_ERRORS[response.status] ?? 'API 요청 실패'}`)
  try {
    return JSON.parse(response.text) as unknown
  } catch {
    throw new Error('API가 잘못된 JSON을 반환함')
  }
}

function events(payload: unknown): unknown[] {
  const data = (payload as { data?: { schedule?: { events?: unknown } } })?.data
  const list = data?.schedule?.events
  if (!Array.isArray(list)) throw new Error('일정 응답 형식이 바뀜')
  return list.filter(e => (e as { type?: string })?.type === undefined || (e as { type?: string }).type === 'match')
}

async function targetLeagues($: EngineInterface): Promise<Set<string>> {
  if (leagueIds) return leagueIds
  const payload = await getJson($, PERSISTED, 'getLeagues', { hl: 'ko-KR' })
  const leagues = (payload as { data?: { leagues?: { id?: string; slug?: string; name?: string }[] } })?.data?.leagues
  if (!Array.isArray(leagues)) throw new Error('리그 응답 형식이 바뀜')
  leagueIds = new Set(
    leagues
      .filter(l => (l.slug === 'lck' || l.slug === 'worlds') && !`${l.slug} ${l.name}`.toLowerCase().includes('challenger'))
      .map(l => String(l.id ?? '')),
  )
  return leagueIds
}

export async function liveEvents($: EngineInterface): Promise<unknown[]> {
  const ids = await targetLeagues($)
  return events(await getJson($, PERSISTED, 'getLive', { hl: 'ko-KR' })).filter(e => isTargetLeague(e, ids))
}

export async function schedule($: EngineInterface): Promise<unknown[]> {
  const ids = await targetLeagues($)
  const all: unknown[] = []
  for (const leagueId of [...ids].sort()) {
    all.push(...events(await getJson($, PERSISTED, 'getSchedule', { hl: 'ko-KR', leagueId })))
  }
  return all
}

export async function eventDetails($: EngineInterface, id: string): Promise<unknown> {
  const payload = await getJson($, PERSISTED, 'getEventDetails', { hl: 'ko-KR', id })
  const event = (payload as { data?: { event?: unknown } })?.data?.event
  if (!event || typeof event !== 'object') throw new Error('경기 상세 응답 형식이 바뀜')
  return event
}

export async function liveWindow($: EngineInterface, gameId: string, startingTime: string): Promise<unknown> {
  const payload = await getJson($, FEED, `window/${encodeURIComponent(gameId)}`, { startingTime })
  if (String((payload as { esportsGameId?: unknown })?.esportsGameId ?? '') !== gameId) {
    throw new Error('피드의 게임 ID가 요청과 다름')
  }
  return payload
}
