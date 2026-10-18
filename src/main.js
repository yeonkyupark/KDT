import './style.css'
import { loadIndex, loadMeta, loadCourse } from './data.mjs'
import { createMap, TILE_NAMES, formatDuration } from './map.js'
import { createSidebar } from './sidebar.js'
import { createProfile } from './profile.js'
import { readState, writeState } from './state.js'
import { configureDifficulty } from './metrics.js'
import { cumulative, pointAtFraction } from './geo.js'
import { createNotes } from './notes.js'
import { createSync, photoUrl } from './sync.js'
import { loadSettings, saveSettings, openSettings, tokenExpiryNote } from './settings.js'
import { createClient } from './github.js'
import { ensureLatestVersion, cleanVersionParam } from './version.js'

/**
 * 선택 구간이 이 개수 이하일 때만 상세 라인·고도를 받는다.
 *
 * 상세 파일은 코스당 8KB다. 90개 전 구간을 고르면 745KB인데, 그 줌에서는
 * 오버뷰(코스당 43점)와 눈으로 구분되지 않고 프로필도 픽셀당 1.8km라
 * `eleLow`(코스당 32점)로 충분하다. 확대해서 볼 만한 구간에서만 받는다.
 */
const DETAIL_LIMIT = 30

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function renderShell() {
  const app = document.getElementById('app')
  app.textContent = ''
  app.className = 'shell'

  const header = el('header', 'topbar')

  const sideBtn = el('button', 'icon-btn side-toggle')
  sideBtn.type = 'button'
  sideBtn.setAttribute('aria-controls', 'sidepanel')
  header.append(sideBtn)

  const brand = el('div', 'brand')
  brand.append(el('b', null, '남파랑길'))
  brand.append(el('span', 'brand-sub', '부산 오륙도 → 해남 땅끝탑'))
  header.append(brand)

  const tools = el('div', 'tools')
  const tileGroup = el('div', 'seg')
  tileGroup.setAttribute('role', 'group')
  tileGroup.setAttribute('aria-label', '지도 종류')
  tools.append(tileGroup)
  header.append(tools)

  const stage = el('div', 'stage')
  const mapwrap = el('div', 'mapwrap')
  const mapEl = el('div', 'map')
  mapEl.id = 'map'

  // 코스 정보 카드를 mapwrap 에 직접 붙이면 bottom 기준이 '지도 + 고도 프로필'의
  // 밑단이 되어, 카드가 지도/프로필 경계를 걸치고 지도 우측 하단 attribution 과
  // 겹친다(attribution 의 z-index 가 더 높아 글자가 카드 위로 겹쳐 찍힌다).
  // 지도 행만 덮는 오버레이 층을 따로 둔다.
  const mapOverlay = el('div', 'map-overlay')

  mapwrap.append(mapEl, mapOverlay)
  stage.append(mapwrap)

  app.append(header, stage)
  return { header, tileGroup, tools, stage, mapwrap, mapEl, mapOverlay, sideBtn }
}

function renderInfoCard(host, course) {
  document.querySelector('.infocard')?.remove()

  const card = el('div', 'infocard')

  const head = el('div', 'ic-head')
  head.append(el('b', null, course.name))
  if (course.region) head.append(el('span', 'ic-region', course.region))
  const close = el('button', 'ic-close')
  close.type = 'button'
  close.setAttribute('aria-label', '닫기')
  close.textContent = '✕'
  close.onclick = () => card.remove()
  head.append(close)
  card.append(head)

  if (course.alias) card.append(el('div', 'ic-alias', course.alias))
  card.append(
    el(
      'div',
      'ic-route',
      course.start && course.end ? `${course.start} → ${course.end}` : '지점명 정보 없음',
    ),
  )

  const stats = el('div', 'ic-stats')
  for (const [k, v] of [
    ['거리', `${course.distanceKm} km`],
    ['예상 소요', formatDuration(course.durationMin)],
    ['누적 상승', `${course.ascentM.toLocaleString()} m`],
    ['누적 하강', `${course.descentM.toLocaleString()} m`],
    ['고도', `${course.eleMin}–${course.eleMax} m`],
    ['난이도', course.difficulty],
  ]) {
    const s = el('div', 'ic-stat')
    s.append(el('span', 'k', k), el('span', 'v', v))
    stats.append(s)
  }
  card.append(stats)

  // 주소·교통편이 있으면 보여준다. 들머리까지 어떻게 가는지가
  // 실제로 계획할 때 가장 필요한 정보다.
  const access = [
    ['시점', course.start, course.startAddr, course.startAccess],
    ['종점', course.end, course.endAddr, course.endAccess],
  ].filter(([, , addr, acc]) => addr || acc)

  if (access.length) {
    const box = el('div', 'ic-access')
    for (const [label, place, addr, acc] of access) {
      const row = el('div', 'ic-acc-row')
      const head = el('div', 'ic-acc-head')
      head.append(el('span', 'ic-acc-tag', label))
      if (place) head.append(el('span', 'ic-acc-place', place))
      row.append(head)
      if (addr) row.append(el('div', 'ic-acc-addr', addr))
      if (acc) row.append(el('div', 'ic-acc-transit', `🚌 ${acc}`))
      box.append(row)
    }
    card.append(box)
  }

  // 우리 노선과 공식 노선의 거리가 눈에 띄게 다르면 그 사실을 숨기지 않는다.
  if (course.officialKm && Math.abs(course.distanceKm - course.officialKm) >= 1) {
    card.append(
      el(
        'div',
        'ic-note',
        `표시 거리는 이 앱이 그리는 노선 기준입니다. 공식 거리는 ${course.officialKm} km 로, ` +
          `이 코스는 두 노선이 다릅니다.`,
      ),
    )
  }

  if (course.isAlt) card.append(el('div', 'ic-note', '임시·우회 노선 — 구간 합계에서 제외됩니다.'))
  if (course.note) card.append(el('div', 'ic-note', course.note))
  card.append(
    el(
      'div',
      'ic-foot',
      course.durationSource === 'official'
        ? '고도는 DEM 추정값 · 난이도와 소요시간은 두루누비 공식값'
        : '고도는 DEM 추정값 · 소요시간은 계산값',
    ),
  )

  host.append(card)
}

function renderError(message) {
  const app = document.getElementById('app')
  app.textContent = ''
  app.className = ''
  const box = el('div', 'errorbox')
  box.append(el('h1', null, '데이터를 불러오지 못했습니다'))
  box.append(el('p', null, message))
  box.append(el('p', 'hint', 'npm run build:data 를 실행해 public/data/ 를 생성했는지 확인하세요.'))
  app.append(box)
}

async function main() {
  let courses
  let meta
  try {
    ;[courses, meta] = await Promise.all([loadIndex(), loadMeta()])
  } catch (e) {
    renderError(e.message)
    return
  }

  configureDifficulty(meta.difficulty?.breaks)

  const byId = new Map(courses.map((c) => [c.id, c]))
  const { tileGroup, tools, stage, mapwrap, mapEl, mapOverlay, sideBtn } = renderShell()

  /**
   * fitBounds가 피해야 하는 영역.
   * 사이드바(넓은 화면)와 하단 시트(좁은 화면) 모두 그리드로 분리되어 있어
   * 지도를 덮지 않는다. 남는 건 Leaflet 컨트롤과 attribution 정도다.
   */
  const getInsets = () => ({ left: 24, top: 20, right: 24, bottom: 34 })

  const view = createMap(mapEl, courses, {
    getInsets,
    onSelect: (c) => renderInfoCard(mapOverlay, c),
  })

  // ── 고도 프로필 ──────────────────────────────────────
  /** 지도 커서를 놓을 좌표를 구하기 위한, 코스별 폴리라인 + 누적거리 캐시 */
  const lineCache = new Map()

  function lineFor(id) {
    if (!lineCache.has(id)) {
      const rec = view.rendered.get(id)
      const pts = rec?.detail ?? byId.get(id)?.overview ?? []
      lineCache.set(id, { pts, cum: cumulative(pts) })
    }
    return lineCache.get(id)
  }

  const profile = createProfile(mapwrap, {
    onHover: (s) => {
      if (!s) return view.setCursor(null)
      const { pts, cum } = lineFor(s.courseId)
      const p = pointAtFraction(pts, cum, s.frac)
      view.setCursor(p)
    },
  })

  // ── 구간 적용 ────────────────────────────────────────
  const maxSeq = Math.max(...courses.filter((c) => !c.isAlt).map((c) => c.seq))
  const opts = { maxSeq, tiles: TILE_NAMES }
  const initial = readState(opts)
  let layer = initial.layer

  /** 프로필은 본 코스만 이어 붙인다. 임시노선은 경로를 두 번 세게 만든다. */
  function profileSegments(from, to) {
    return courses
      .filter((c) => !c.isAlt && c.seq >= from && c.seq <= to)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => {
        const detail = view.rendered.get(c.id)?.eleDetail
        return { course: c, ele: detail ?? c.eleLow ?? [], lengthM: c.distanceM }
      })
  }

  let applyToken = 0

  async function applyRange({ from, to }, { fit = true } = {}) {
    const ids = new Set(courses.filter((c) => c.seq >= from && c.seq <= to).map((c) => c.id))
    view.setSelection(ids.size === courses.length ? null : ids)
    if (fit) view.fitIds(ids)

    writeState({ from, to, layer }, opts)
    profile.setSegments(profileSegments(from, to))

    // 구간이 바뀌면 열려 있던 정보 카드가 옛 코스를 그대로 들고 있게 된다.
    // 새 구간의 시작 코스로 갱신한다. (카드가 닫혀 있으면 굳이 열지 않는다)
    if (document.querySelector('.infocard')) {
      const head = courses.find((c) => !c.isAlt && c.seq === from)
      if (head) renderInfoCard(mapOverlay, head)
    }

    const token = ++applyToken
    if (ids.size > DETAIL_LIMIT) return

    // 상세는 뒤늦게 도착해도 되므로 await 하지 않는다.
    for (const id of ids) {
      loadCourse(id)
        .then((d) => {
          if (token !== applyToken) return
          view.upgradeToDetail(id, d.line)
          lineCache.delete(id) // 상세 라인으로 커서 정확도가 올라간다
          const rec = view.rendered.get(id)
          if (rec) rec.eleDetail = d.ele?.values
          profile.setSegments(profileSegments(from, to))
        })
        .catch(() => {}) // 상세는 있으면 좋은 것이다. 실패해도 오버뷰로 동작한다.
    }
  }

  const sidebar = createSidebar(stage, courses, {
    onRangeChange: (r) => applyRange(r),
    onPick: (c) => {
      view.togglePin(c.id)
      renderInfoCard(mapOverlay, c)
      view.focus(c.id)
      sidebar.collapse()
    },
    onHover: (id, on) => view.accent(id, on),
  })

  // ── 사진 · 메모 + GitHub 동기화 ──────────────────────
  let syncSettings = loadSettings()
  const syncCore = createSync(() => syncSettings)

  const syncApi = {
    run: () => syncCore.run(),
    ensureLatestVersion,
    pullPublic: () => syncCore.pullPublic(),
    onState: (fn) => syncCore.onState(fn),
    lastSyncedAt: () => syncCore.lastSyncedAt(),
    lastSyncedAtValue: null,
    configured: () => Boolean(syncSettings.token && syncSettings.owner && syncSettings.repo),
    tokenExpiryNote: () => tokenExpiryNote(syncSettings),
    photoUrl: (note, kind) => photoUrl(syncSettings, note, kind),
    openSettings: () =>
      openSettings({
        current: syncSettings,
        onSave: (next) => {
          syncSettings = next
          saveSettings(next)
        },
        // 확인은 저장 전 입력값으로 한다 — 틀린 토큰을 저장해두고 확인해봐야 의미가 없다.
        // 메모 리포와 사진 리포를 **둘 다** 본다. 하나만 통과해도 동기화는 실패한다.
        onCheck: async (c) => {
          const mk = (repo) =>
            createClient({ owner: c.owner, repo, branch: c.branch, token: c.token })

          const notesClient = mk(c.repo)
          const login = await notesClient.whoami()
          const notes = await notesClient.repoInfo()

          let photos = null
          if (c.photoRepo) {
            try {
              photos = await mk(c.photoRepo).repoInfo()
            } catch (e) {
              photos = { error: e.status === 404 ? '찾을 수 없거나 토큰에 권한이 없습니다' : e.message }
            }
          }
          return { login, notes, photos, branch: c.branch || 'main' }
        },
      }),
  }
  syncCore.onState((st) => {
    if (st.phase === 'done') syncApi.lastSyncedAtValue = st.at
  })

  const notes = createNotes({ host: sidebar.notesHost, view, courses, sync: syncApi })

  // ── 타일 토글 ────────────────────────────────────────
  const buttons = TILE_NAMES.map((name) => {
    const b = el('button', 'seg-btn' + (name === layer ? ' is-on' : ''), name)
    b.type = 'button'
    b.onclick = () => {
      if (name === layer) return
      layer = name
      view.setTile(name)
      for (const other of buttons) other.classList.toggle('is-on', other.textContent === name)
      writeState({ ...sidebar.getRange(), layer }, opts)
    }
    tileGroup.append(b)
    return b
  })

  // ── 고도 프로필 접기 ─────────────────────────────────
  const profBtn = el('button', 'ghost-btn is-on', '고도')
  profBtn.type = 'button'
  profBtn.setAttribute('aria-pressed', 'true')
  let profOpen = window.innerWidth >= 861 // 좁은 화면은 자리가 없어 기본 접힘
  const syncProf = () => {
    mapwrap.classList.toggle('no-profile', !profOpen)
    profBtn.classList.toggle('is-on', profOpen)
    profBtn.setAttribute('aria-pressed', String(profOpen))
  }
  profBtn.onclick = () => {
    profOpen = !profOpen
    syncProf()
  }
  tools.append(profBtn)

  const fitBtn = el('button', 'ghost-btn', '전체보기')
  fitBtn.type = 'button'
  fitBtn.onclick = () => view.fitAll()
  tools.append(fitBtn)

  // ── 사진 핀 표시 on/off ──────────────────────────────
  // 기록이 많아지면 지도가 사진 핀으로 덮여 코스 선이 안 보일 수 있다.
  // 목록은 그대로 두고 지도 위 핀만 끄고 켠다.
  const notesBtn = el('button', 'ghost-btn is-on', '사진')
  notesBtn.type = 'button'
  notesBtn.setAttribute('aria-pressed', 'true')
  notesBtn.onclick = () => {
    view.setNotesVisible(!view.notesVisible)
    notesBtn.classList.toggle('is-on', view.notesVisible)
    notesBtn.setAttribute('aria-pressed', String(view.notesVisible))
  }
  tools.append(notesBtn)

  // ── 사이드바 접기 ────────────────────────────────────
  // 화면 상태가 아니라 개인 취향이므로 URL이 아니라 localStorage 에 둔다.
  // (URL은 공유용이다 — 남에게 보낸 링크가 내 패널 상태까지 강제하면 안 된다)
  const SIDE_KEY = 'namparang.sidebar'
  let sideOpen = true
  try {
    sideOpen = localStorage.getItem(SIDE_KEY) !== 'closed'
  } catch {
    // 시크릿 모드 등에서 접근 자체가 막힐 수 있다. 기본값으로 간다.
  }

  const syncSide = () => {
    document.querySelector('.shell').classList.toggle('side-closed', !sideOpen)
    sideBtn.textContent = sideOpen ? '◀' : '▶'
    sideBtn.title = sideOpen ? '사이드 메뉴 접기' : '사이드 메뉴 펼치기'
    sideBtn.setAttribute('aria-label', sideBtn.title)
    sideBtn.setAttribute('aria-expanded', String(sideOpen))
  }
  sideBtn.onclick = () => {
    sideOpen = !sideOpen
    syncSide()
    try {
      localStorage.setItem(SIDE_KEY, sideOpen ? 'open' : 'closed')
    } catch {
      // 저장이 막혀도 이번 세션에서는 정상 동작한다
    }
  }

  // ── 초기 상태 반영 ───────────────────────────────────
  // 캐시된 옛 HTML 로 열렸으면 새 버전으로 다시 연다. 오프라인이어도 화면은 그대로 뜬다.
  cleanVersionParam()
  ensureLatestVersion()

  syncSide()
  syncProf()
  view.setTile(layer)
  sidebar.setRange(initial.from, initial.to, { notify: false })
  await applyRange({ from: initial.from, to: initial.to })

  // 코스 데이터가 먼저 보이는 게 중요하므로 기록은 뒤이어 올린다.
  notes.load()

  window.addEventListener('popstate', () => {
    const s = readState(opts)
    layer = s.layer
    view.setTile(layer)
    for (const b of buttons) b.classList.toggle('is-on', b.textContent === layer)
    sidebar.setRange(s.from, s.to, { notify: false })
    applyRange({ from: s.from, to: s.to })
  })
}

main()
