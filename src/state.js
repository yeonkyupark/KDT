/**
 * URL 쿼리스트링에 화면 상태를 보관한다.
 * `?trail=haeparang&from=17&to=23&layer=지형` — 새로고침·북마크·공유에서 그대로 복원된다.
 */

const KEYS = { trail: 'trail', from: 'from', to: 'to', layer: 'layer' }

/** 마지막으로 본 길. 개인 취향이라 URL 이 아니라 브라우저에 둔다. 키 이름은 기존 사용자 호환으로 그대로 둔다. */
const LAST_TRAIL_KEY = 'namparang.trail'

/**
 * 열 길을 정한다.
 *   1. URL 의 `?trail=`
 *   2. 길 없이 구간만 적힌 옛 주소(`?from=17&to=23`)는 기본 길(남파랑길) — 예전에 공유한 링크가 그대로 열린다
 *   3. 아무것도 없으면 마지막으로 본 길
 *   4. 그것도 없으면 기본 길
 */
export function readTrail(ids, fallback) {
  const q = new URLSearchParams(location.search)
  const asked = q.get(KEYS.trail)
  if (ids.includes(asked)) return asked
  if (q.has(KEYS.from) || q.has(KEYS.to)) return fallback
  try {
    const last = localStorage.getItem(LAST_TRAIL_KEY)
    if (ids.includes(last)) return last
  } catch {
    // 시크릿 모드 등에서 막힐 수 있다
  }
  return fallback
}

export function rememberTrail(id) {
  try {
    localStorage.setItem(LAST_TRAIL_KEY, id)
  } catch {
    // 저장이 막혀도 이번 화면은 정상 동작한다
  }
}

/** 다른 길로 옮겨 가는 주소. 지도 종류는 이어 가고 구간은 새 길의 전체로 둔다. */
export function trailHref(id, { from, to } = {}) {
  const q = new URLSearchParams(location.search)
  q.delete(KEYS.from)
  q.delete(KEYS.to)
  q.set(KEYS.trail, id)
  if (from) q.set(KEYS.from, String(from))
  if (to) q.set(KEYS.to, String(to))
  return `?${q}${location.hash}`
}

export function readState({ maxSeq, tiles }) {
  const q = new URLSearchParams(location.search)

  const num = (key, fallback) => {
    const n = Number.parseInt(q.get(KEYS[key]) ?? '', 10)
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), maxSeq) : fallback
  }

  let from = num('from', 1)
  let to = num('to', maxSeq)
  if (from > to) [from, to] = [to, from]

  const layer = tiles.includes(q.get(KEYS.layer)) ? q.get(KEYS.layer) : tiles[0]

  return { from, to, layer }
}

/** 히스토리를 더럽히지 않도록 replaceState 로 갱신한다. */
export function writeState({ trail, from, to, layer }, { maxSeq, tiles, defaultTrail }) {
  const q = new URLSearchParams(location.search)

  // 기본값이면 파라미터를 지운다 — URL이 짧을수록 공유하기 좋다.
  // 기본 길이라도 구간이 적혀 있으면 길을 지워도 된다(옛 주소 규칙으로 기본 길이 열린다).
  if (trail === defaultTrail) q.delete(KEYS.trail)
  else q.set(KEYS.trail, trail)

  if (from === 1) q.delete(KEYS.from)
  else q.set(KEYS.from, String(from))

  if (to === maxSeq) q.delete(KEYS.to)
  else q.set(KEYS.to, String(to))

  if (layer === tiles[0]) q.delete(KEYS.layer)
  else q.set(KEYS.layer, layer)

  const qs = q.toString()
  history.replaceState(null, '', qs ? `?${qs}${location.hash}` : location.pathname + location.hash)
}
