/**
 * 정적 데이터 로딩.
 *
 * 경로는 반드시 `document.baseURI` 기준으로 만든다. GitHub Pages 하위 경로
 * (`/KDT/`)와 로컬 루트(`/`) 양쪽에서 같은 코드가 동작해야 한다.
 *
 * 길마다 데이터가 따로 있다(`data/<길>/…`). 화면은 한 번에 한 길만 받는다.
 * `trails.json` 은 길 목록이라 맨 먼저 받고, 나머지는 `useTrail()` 로 고른 길에서 받는다.
 */

/**
 * `index.html` 과 `data/*.json` 은 파일명에 해시가 없어 GitHub Pages 캐시
 * (`Cache-Control: max-age=600`)에 걸린다. 새 JS 가 옛 데이터를 받으면
 * 필드가 없어 화면이 깨질 수 있으므로 빌드 ID 를 붙여 캐시를 깬다.
 * (JS/CSS 는 Vite 가 파일명에 해시를 붙여주므로 이 문제가 없다)
 */
const url = (p) => {
  const u = new URL(`data/${p}`, document.baseURI)
  u.searchParams.set('v', __BUILD_ID__)
  return u.href
}

async function getJson(path) {
  const res = await fetch(url(path))
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

let trailsPromise = null

/** 길 목록 · 합계 · 출처 · 길 사이 연결. */
export function loadTrails() {
  trailsPromise ??= getJson('trails.json')
  return trailsPromise
}

let current = null

/** 이후의 loadIndex / loadMeta / loadCourse 가 이 길의 데이터를 받는다. */
export function useTrail(id) {
  current = id
}

const indexCache = new Map()

/**
 * 길 하나의 코스 메타 + 오버뷰 라인. 랜딩에서는 고른 길 것만 받는다.
 * 다른 길 것은 기록을 등록할 때(사진이 다른 길에 더 가까운지 볼 때)만 받는다.
 */
export function loadIndex(trailId = current) {
  if (!indexCache.has(trailId)) indexCache.set(trailId, getJson(`${trailId}/courses.json`))
  return indexCache.get(trailId)
}

let metaPromise = null

export function loadMeta() {
  metaPromise ??= getJson(`${current}/meta.json`)
  return metaPromise
}

const detailCache = new Map()

/** 코스 상세(고해상도 라인 + 고도 프로필). 한 번 받으면 캐시한다. */
export function loadCourse(id) {
  if (!detailCache.has(id)) detailCache.set(id, getJson(`${current}/course/${id}.json`))
  return detailCache.get(id)
}
