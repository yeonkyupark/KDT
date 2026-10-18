/**
 * 배포 버전 확인
 *
 * 오래 열어 둔 탭이나 홈 화면 앱은 새로 배포돼도 옛 JS 를 계속 돌린다. 옛 코드가 고친
 * 버그(예: 캐시된 sha 로 notes.json 쓰기)를 그대로 안고 동기화하지 않도록,
 * 동기화 전에 배포된 version.json 과 비교해 다르면 새 버전으로 다시 연다.
 */

/* global __APP_VERSION__ */
const CURRENT = __APP_VERSION__

async function fetchDeployedVersion() {
  const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) return null
  return (await res.json())?.version ?? null
}

/**
 * index.html 은 10분 캐시라 같은 주소로 새로고침하면 옛 HTML 을 다시 받을 수 있다.
 * 주소에 버전을 붙여 새로 받게 한다. 이미 그 주소인데도 옛 버전이면 배포 CDN 이
 * 아직 따라오지 못한 것이므로 다시 열지 않는다(무한 새로고침 방지).
 * @returns {boolean} 다시 열기 시작했으면 true
 */
function reloadTo(version) {
  const url = new URL(location.href)
  if (url.searchParams.get('v') === version) return false
  url.searchParams.set('v', version)
  location.replace(url)
  return true
}

/**
 * @returns {Promise<'latest'|'reloading'|'stale'>}
 *   latest: 최신이거나 확인할 수 없음(오프라인 등 — 동기화가 알아서 실패한다)
 *   reloading: 새 버전으로 다시 여는 중
 *   stale: 새 버전이 있으나 아직 받을 수 없음
 */
export async function ensureLatestVersion() {
  if (CURRENT === 'dev') return 'latest'
  const deployed = await fetchDeployedVersion().catch(() => null)
  if (!deployed || deployed === CURRENT) return 'latest'
  return reloadTo(deployed) ? 'reloading' : 'stale'
}

/**
 * 새 버전으로 다시 열렸으면 주소에 남은 `?v=` 를 지운다.
 * 아직 옛 버전이면 남겨 둔다 — reloadTo 가 그것을 보고 반복 새로고침을 막는다.
 */
export function cleanVersionParam() {
  const url = new URL(location.href)
  if (url.searchParams.get('v') !== CURRENT) return
  url.searchParams.delete('v')
  history.replaceState(history.state, '', url)
}
