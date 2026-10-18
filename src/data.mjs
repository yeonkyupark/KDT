/**
 * 정적 데이터 로딩.
 *
 * 경로는 반드시 `document.baseURI` 기준으로 만든다. GitHub Pages 하위 경로
 * (`/KDT/`)와 로컬 루트(`/`) 양쪽에서 같은 코드가 동작해야 한다.
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

let indexPromise = null

/** 90개 코스 메타 + 오버뷰 라인. 랜딩에서 받는 유일한 데이터. */
export function loadIndex() {
  indexPromise ??= getJson('courses.json')
  return indexPromise
}

let metaPromise = null

export function loadMeta() {
  metaPromise ??= getJson('meta.json')
  return metaPromise
}

const detailCache = new Map()

/** 코스 상세(고해상도 라인 + 고도 프로필). 한 번 받으면 캐시한다. */
export function loadCourse(id) {
  if (!detailCache.has(id)) detailCache.set(id, getJson(`course/${id}.json`))
  return detailCache.get(id)
}
