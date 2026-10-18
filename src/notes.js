/**
 * 사진 + 메모 기록.
 *
 * 흐름
 *   파일 선택 → EXIF 좌표 확인 → (없으면) 지도 클릭으로 위치 지정
 *   → 리사이즈 → 메모 입력 → IndexedDB 저장 → 지도에 핀
 *
 * 좌표가 없는 사진이 예외가 아니라 기본이다(메신저·SNS를 거치면 EXIF가 지워진다).
 * 지도 클릭 경로를 곁가지가 아니라 정식 경로로 취급한다.
 *
 * 기록은 길마다 나뉜다(`note.trail`). 지금 보고 있는 길의 기록만 지도·목록에 보인다.
 * 필드가 없는 기록(길을 나누기 전에 만든 것)은 남파랑길 기록이다. 저장·동기화·백업은 길과
 * 관계없이 전부 다룬다 — 거르는 것은 화면에서만 한다.
 */

import { allNotes, saveNote, deleteNote, getPhoto, newId, usage } from './store.js'
import { readExif, processImage, formatBytes } from './photos.js'
import { haversine } from './geo.js'

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

/**
 * 이미지 소스를 고른다. 로컬 Blob 이 있으면 그걸, 없으면 원격 raw URL 을 쓴다.
 *
 * 다른 기기에서 동기화로 내려온 노트는 Blob 이 없다. 썸네일 450개를 미리
 * 받으면 9MB이므로, 원격 URL 을 그대로 <img src> 에 넣어 브라우저 캐시에 맡긴다.
 */
function imageSrc(blob, url) {
  if (blob) {
    const objectUrl = URL.createObjectURL(blob)
    return { src: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) }
  }
  return { src: url || null, revoke: () => {} }
}

/** `trail` 필드가 없는 기록은 남파랑길 기록이다. 옮기지 않아도 된다. */
const DEFAULT_TRAIL = 'namparang'
const trailOf = (n) => n?.trail || DEFAULT_TRAIL

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(+d)
    ? ''
    : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.host  사이드바 안의 기록 섹션 컨테이너
 * @param {object} deps.view       createMap 이 돌려준 지도 뷰
 * @param {Array}  deps.courses    지금 길의 courses.json
 * @param {string} deps.trail      지금 길 id
 * @param {Array}  deps.trails     trails.json 의 길 목록 (등록·수정 화면에서 길을 고를 때)
 * @param {(id: string) => Promise<Array>} deps.loadIndex  다른 길의 courses.json
 */
export function createNotes({ host, view, courses, sync, trail = DEFAULT_TRAIL, trails = [], loadIndex }) {
  const trailName = (id) => trails.find((t) => t.id === id)?.name ?? id
  const coursesOf = (id) => (id === trail ? Promise.resolve(courses) : (loadIndex?.(id) ?? Promise.resolve([])))

  /**
   * 원격 사진 URL. 동기화 설정에서 조립하므로 리포 이름을 바꿔도 깨지지 않는다.
   * 동기화가 없으면 노트에 저장된 절대 URL 로 폴백한다.
   */
  const remoteUrl = (note, kind) =>
    sync?.photoUrl?.(note, kind) ?? note?.photo?.[`${kind}Url`] ?? null

  /** 지도에 넘길 노트 목록. 원격 썸네일 URL 을 미리 붙인다 (map.js 는 설정을 모른다). */
  const pinSource = () =>
    [...notes.values()].map((n) => ({ ...n, remoteThumbUrl: remoteUrl(n, 'thumb') }))

  /** @type {Map<string, object>} */
  const notes = new Map()
  let picking = null

  // ── 사이드바 섹션 ────────────────────────────────────
  const head = el('div', 'notes-head')
  const headTitle = el('span', 'notes-title', '기록')
  const headCount = el('span', 'notes-count')
  head.append(headTitle, headCount)

  const addBtn = el('button', 'add-btn', '+ 사진 · 메모 추가')
  addBtn.type = 'button'

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.hidden = true

  const list = el('ul', 'notes-list')
  const usageLine = el('div', 'notes-usage')

  // ── 동기화 줄 ────────────────────────────────────────
  const syncRow = el('div', 'sync-row')
  const syncBtn = el('button', 'sync-btn', '동기화')
  syncBtn.type = 'button'
  const gearBtn = el('button', 'icon-btn sync-gear', '⚙')
  gearBtn.type = 'button'
  gearBtn.title = 'GitHub 동기화 설정'
  gearBtn.setAttribute('aria-label', gearBtn.title)
  const syncMsg = el('span', 'sync-msg')
  syncRow.append(syncBtn, gearBtn, syncMsg)

  // ── 백업 줄 ──────────────────────────────────────────
  const backupRow = el('div', 'backup-row')
  const expBtn = el('button', 'link-btn', '내보내기')
  const impBtn = el('button', 'link-btn', '가져오기')
  expBtn.type = impBtn.type = 'button'
  expBtn.title = '모든 기록과 사진을 ZIP 파일로 저장'
  impBtn.title = '백업 ZIP 파일에서 복원 (기존 기록과 병합)'
  const zipInput = document.createElement('input')
  zipInput.type = 'file'
  zipInput.accept = '.zip,application/zip'
  zipInput.hidden = true
  const backupMsg = el('span', 'backup-msg')
  backupRow.append(el('span', 'backup-label', 'ZIP 백업'), expBtn, impBtn, zipInput, backupMsg)

  host.append(head, addBtn, input, list, syncRow, backupRow, usageLine)

  expBtn.onclick = async () => {
    expBtn.disabled = true
    try {
      const { exportZip } = await import('./backup.js')
      const r = await exportZip((m) => (backupMsg.textContent = m), { remoteUrl })
      backupMsg.textContent =
        `${r.name} · 기록 ${r.notes}개 · 사진 ${r.photos}장 · ${formatBytes(r.bytes)}` +
        (r.missing ? ` · 사진 ${r.missing}장은 받지 못해 빠졌습니다 (네트워크 확인 후 다시 시도)` : '')
    } catch (e) {
      backupMsg.textContent = `내보내기 실패 — ${e.message}`
    } finally {
      expBtn.disabled = false
    }
  }

  impBtn.onclick = () => zipInput.click()
  zipInput.onchange = async () => {
    const file = zipInput.files?.[0]
    zipInput.value = ''
    if (!file) return
    impBtn.disabled = true
    try {
      const { importZip } = await import('./backup.js')
      const r = await importZip(file, (m) => (backupMsg.textContent = m))
      backupMsg.textContent = `가져오기 완료 · 추가 ${r.added} · 갱신 ${r.updated} · 건너뜀 ${r.skipped}`
      await load()
    } catch (e) {
      backupMsg.textContent = `가져오기 실패 — ${e.message}`
    } finally {
      impBtn.disabled = false
    }
  }

  const PHASE_TEXT = {
    start: '동기화 시작…',
    photos: '사진 업로드 중…',
    notes: '메모 반영 중…',
    pull: '원격 변경 확인 중…',
  }

  function setSyncMsg(text, kind = '') {
    syncMsg.textContent = text
    syncMsg.className = `sync-msg${kind ? ` is-${kind}` : ''}`
  }

  if (sync) {
    gearBtn.onclick = () => sync.openSettings()
    syncBtn.onclick = async () => {
      // 옛 코드로는 동기화하지 않는다. 새 버전이 있으면 다시 연다.
      const v = await sync.ensureLatestVersion()
      if (v !== 'latest') {
        setSyncMsg(
          v === 'reloading' ? '새 버전으로 다시 불러오는 중…' : '새 버전 배포 중입니다. 잠시 후 다시 시도하세요',
          v === 'stale' ? 'bad' : '',
        )
        return
      }
      try {
        await sync.run()
      } catch {
        // 상태 메시지는 onState 에서 이미 표시한다
      }
    }
    sync.onState(async (st) => {
      if (st.phase === 'done') {
        syncBtn.disabled = false
        const bits = []
        if (st.pushed) bits.push(`올림 ${st.pushed}`)
        if (st.pulled) bits.push(`내림 ${st.pulled}`)
        if (st.photos?.uploaded) bits.push(`사진 ${st.photos.uploaded}장`)
        if (st.photos?.restored) bits.push(`사진 복구 ${st.photos.restored}장`)
        if (st.photos?.removed) bits.push(`사진 정리 ${st.photos.removed}장`)
        setSyncMsg(bits.length ? `완료 · ${bits.join(' · ')}` : '변경 없음', 'ok')
        // 원격에서 사라졌고 로컬 원본도 없는 사진은 되살릴 수 없다. 조용히 넘기지 않는다.
        if (st.photos?.orphaned) {
          setSyncMsg(
            `완료 · 사진 ${st.photos.orphaned}장은 원격·로컬 모두에 없어 복구할 수 없습니다`,
            'bad',
          )
        }
        await load() // 내려받은 노트를 화면에 반영
      } else if (st.phase === 'error') {
        syncBtn.disabled = false
        setSyncMsg(st.message, 'bad')
      } else {
        syncBtn.disabled = true
        setSyncMsg(PHASE_TEXT[st.phase] ?? '…')
      }
    })
  } else {
    syncRow.hidden = true
  }

  addBtn.onclick = () => input.click()
  input.onchange = async () => {
    const files = [...input.files]
    input.value = '' // 같은 파일을 다시 골라도 change 가 오게
    for (const file of files) await ingest(file)
  }

  // ── 가장 가까운 코스 찾기 ────────────────────────────
  /**
   * 좌표에서 가장 가까운 코스를 고른다.
   * 오버뷰 라인(코스당 43점)으로만 재기 때문에 정확한 최단거리가 아니라
   * "어느 코스 근처냐"를 가리는 수준이다. 그 용도에는 충분하다.
   */
  function nearestCourse(latlng, list = courses) {
    let best = null
    let bestD = Infinity
    for (const c of list) {
      for (const p of c.overview) {
        const d = haversine(latlng, p)
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
    }
    return bestD <= 3000 ? { course: best, distM: bestD } : null
  }

  /**
   * 다른 길의 코스가 더 가까운지 본다. 오륙도(남파랑길·해파랑길 시점)처럼 길 경계에서 찍은 사진은
   * 어느 길 기록인지 사람이 정해야 한다. 다른 길 데이터는 이때만 받는다.
   * @returns {Promise<{trail: string, course: object, distM: number}|null>}
   */
  async function nearestElsewhere(latlng, here) {
    let best = null
    for (const t of trails) {
      if (t.id === trail) continue
      let list
      try {
        list = await coursesOf(t.id)
      } catch {
        continue // 받지 못하면 묻지 않는다. 지금 길로 저장된다
      }
      const n = nearestCourse(latlng, list)
      if (n && (!best || n.distM < best.distM)) best = { trail: t.id, ...n }
    }
    // 지금 길의 코스가 같거나 더 가까우면 묻지 않는다
    if (!best || (here && here.distM <= best.distM)) return null
    return best
  }

  // ── 등록 ─────────────────────────────────────────────
  async function ingest(file) {
    if (!file.type.startsWith('image/')) {
      toast(`${file.name}: 이미지 파일이 아닙니다`)
      return
    }

    let exif
    let image
    try {
      ;[exif, image] = await Promise.all([readExif(file), processImage(file)])
    } catch (e) {
      toast(`${file.name}: 처리 실패 — ${e.message}`)
      return
    }

    let latlng = exif.latlng
    let source = 'exif'
    if (!latlng) {
      // 좌표는 없지만 주소가 있는 경우가 있다(갤럭시 등 일부 기기는 좌표 대신
      // 주소 문자열을 XMP/IPTC 에 넣는다). 주소를 보여주면 어디를 클릭해야
      // 하는지 알 수 있으므로 배너에 그대로 띄운다.
      const picked = await askLocation(file.name, exif)
      if (!picked) return // 사용자가 취소
      latlng = picked.latlng
      source = picked.via // 'gps' | 'map'
    }

    const near = nearestCourse(latlng)
    const elsewhere = trails.length > 1 ? await nearestElsewhere(latlng, near) : null
    openForm({
      draft: {
        id: newId(),
        trail,
        lat: latlng[0],
        lng: latlng[1],
        courseId: near?.course?.id ?? '',
        takenAt: exif.takenAt,
        title: '',
        memo: '',
        rating: 0,
        locationSource: source,
        address: exif.address || '',
      },
      image,
      near,
      elsewhere,
      exif,
    })
  }

  /**
   * 주소 문자열을 우리 코스 데이터와 맞춰 본다.
   *
   * 외부 지오코딩 서비스를 쓰지 않는다. 우리에겐 이미 이 길의 시·군과 코스별
   * 시작·종료 지점명이 있다. "거제시 학동고개" 같은 주소면 거제시 구간으로
   * 지도를 옮겨주는 것만으로 클릭할 자리를 크게 좁힐 수 있다.
   *
   * @returns {{ids: Set<string>, label: string}|null}
   */
  function matchAddress(address) {
    if (!address) return null
    const text = address.replace(/\s+/g, '')
    const regions = [...new Set(courses.map((c) => c.region).filter(Boolean))]

    // 1) 지점명 토큰으로 좁힌다.
    //    지점명 전체(`거제시 동부면 학동리 학동고개`)를 그대로 찾으면 안 맞는다 —
    //    사진 주소는 보통 `학동고개 거제시` 처럼 순서와 구성이 다르다.
    //    그래서 토큰 단위로 보고, 시·군 이름은 너무 넓어서 제외한다.
    const specific = (place) =>
      place
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !regions.includes(t))
    const byPlace = courses.filter((c) =>
      [c.start, c.end].filter(Boolean).some((p) => specific(p).some((t) => text.includes(t))),
    )
    if (byPlace.length) {
      const ids = new Set(byPlace.map((c) => c.id))
      return {
        ids,
        label:
          byPlace.length === 1
            ? byPlace[0].name
            : `${byPlace[0].name}~${byPlace[byPlace.length - 1].name}`,
      }
    }

    // 2) 시·군 단위
    const hit = regions.find((r) => text.includes(r.replace(/\s+/g, '')))
    if (hit) {
      const ids = courses.filter((c) => c.region === hit).map((c) => c.id)
      return { ids: new Set(ids), label: `${hit} 구간 ${ids.length}개` }
    }
    return null
  }

  /**
   * "35.0997, 129.1236" 같은 문자열을 좌표로 읽는다. 콤마·공백 구분 모두 받는다.
   * 범위를 벗어나면(위도 ±90, 경도 ±180) 좌표가 아니라 주소로 취급한다.
   */
  function parseLatLng(text) {
    const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text)
    if (!m) return null
    const lat = Number(m[1])
    const lng = Number(m[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    return [lat, lng]
  }

  /** 촬영 시각이 지금으로부터 이 시간(ms) 이내면 "방금 찍은 사진"으로 본다. */
  const RECENT_MS = 15 * 60 * 1000

  /**
   * 지도를 클릭하거나, "현재 위치"를 눌러 위치를 받는다.
   *
   * 모바일에서 사진 라이브러리를 통해 파일을 고르면 iOS/Android가 개인정보
   * 보호 차원에서 GPS EXIF를 지우고 넘기는 경우가 있다 — 브라우저에 도착하기
   * 전에 사라진 데이터라 파싱으로는 복구할 수 없다. 하지만 사진을 찍은 자리에서
   * 곧바로 등록하는 트레킹 중 흐름이라면, **그 순간의 실시간 GPS**
   * (`navigator.geolocation`)가 사진의 EXIF 좌표와 실질적으로 같다.
   * 그래서 지도 클릭과 나란히 "현재 위치 사용"을 제공한다 — 나중에(그날
   * 저녁 등) 몰아서 올리는 사진은 이 위치가 틀리므로 지도 클릭도 그대로 둔다.
   */
  function askLocation(fileName, exif = {}) {
    const banner = el('div', 'pick-banner')
    banner.append(el('b', null, '위치를 지정하세요'))

    if (exif.address) {
      // 주소가 있으면 그게 가장 쓸모있는 단서다. 파일명보다 먼저 크게 보여준다.
      banner.append(el('span', 'pick-addr', `📍 ${exif.address}`))
      banner.append(el('span', 'pick-sub', `${fileName} — 좌표는 없고 주소만 기록돼 있습니다`))
    } else {
      banner.append(
        el(
          'span',
          'pick-sub',
          `${fileName} — 사진에 위치 정보가 없습니다 (모바일에서 사진첩을 거치면 GPS가 지워지는 경우가 있습니다)`,
        ),
      )
    }
    // 주소로 지역을 알아낼 수 있으면 지도를 먼저 그쪽으로 옮긴다.
    // 전국 축척에서 클릭하게 두면 정밀도가 km 단위로 떨어진다.
    const matchHint = el('span', 'pick-hint')
    banner.append(matchHint)
    /** @returns {boolean} 일치하는 코스가 있어 지도를 옮겼는지 */
    function applyMatch(matched) {
      if (!matched) return false
      view.fitIds(matched.ids)
      matchHint.textContent = `지도 이동: ${matched.label} — 이제 지도를 클릭하세요`
      return true
    }
    if (exif.address) applyMatch(matchAddress(exif.address))

    const takenRecently =
      exif.takenAt && Date.now() - new Date(exif.takenAt).getTime() <= RECENT_MS
    const gpsBtn = el(
      'button',
      `pick-gps${takenRecently ? ' is-suggested' : ''}`,
      '📍 지금 여기(현재 위치) 사용',
    )
    gpsBtn.type = 'button'
    banner.append(gpsBtn)
    banner.append(
      el('span', 'pick-hint', '사진을 방금 찍었다면 정확합니다. 예전 사진이면 아래 좌표/주소를 입력하거나 지도를 클릭하세요.'),
    )

    // ── 좌표 또는 주소 직접 입력 ──────────────────────────
    // 외부 지오코딩 서비스는 쓰지 않는다. 좌표는 그대로 쓰고, 주소는
    // matchAddress()로 이 길 코스의 지점명·지역과 맞춰 지도만 옮긴다 —
    // 정확한 지점은 여전히 지도 클릭으로 짚는다.
    const manualRow = el('div', 'pick-manual')
    const manualIn = document.createElement('input')
    manualIn.type = 'text'
    manualIn.placeholder = '좌표(35.0997, 129.1236) 또는 주소'
    manualIn.autocomplete = 'off'
    const manualBtn = el('button', 'btn', '적용')
    manualBtn.type = 'button'
    manualRow.append(manualIn, manualBtn)
    banner.append(manualRow)

    const submitManual = () => {
      const value = manualIn.value.trim()
      if (!value) return
      const coords = parseLatLng(value)
      if (coords) {
        finishOnce(coords, 'manual')
        return
      }
      if (!applyMatch(matchAddress(value))) {
        toast(`"${value}"와 일치하는 코스 지점을 찾지 못했습니다`)
      }
    }
    manualBtn.onclick = submitManual
    manualIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitManual()
    })

    const cancel = el('button', 'pick-cancel', '취소')
    cancel.type = 'button'
    banner.append(cancel)
    document.querySelector('.map-overlay').append(banner)

    picking = view.pickLocation()
    cancel.onclick = () => picking?.cancel()

    // 지도 클릭과 "현재 위치" 버튼 중 먼저 들어온 값이 이긴다.
    let settled = false
    let resolveOuter
    const outer = new Promise((resolve) => (resolveOuter = resolve))
    const finishOnce = (latlng, via) => {
      if (settled) return
      settled = true
      picking?.cancel()
      resolveOuter(latlng ? { latlng, via } : null)
    }
    picking.promise.then((v) => finishOnce(v, 'map'))

    gpsBtn.onclick = () => {
      if (!navigator.geolocation) {
        toast('이 브라우저는 위치 조회를 지원하지 않습니다')
        return
      }
      gpsBtn.disabled = true
      gpsBtn.textContent = '위치 확인 중…'
      navigator.geolocation.getCurrentPosition(
        (pos) => finishOnce([pos.coords.latitude, pos.coords.longitude], 'gps'),
        (err) => {
          gpsBtn.disabled = false
          gpsBtn.textContent = '📍 지금 여기(현재 위치) 사용'
          toast(
            err.code === err.PERMISSION_DENIED
              ? '위치 접근이 거부됐습니다 — 브라우저 설정에서 허용하거나 지도를 클릭하세요'
              : `위치를 가져올 수 없습니다 — ${err.message}`,
          )
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
      )
    }

    return outer.finally(() => {
      banner.remove()
      picking = null
    })
  }

  // ── 입력 폼 ──────────────────────────────────────────
  function openForm({ draft, image, near, elsewhere, existingThumbUrl, exif }) {
    const back = el('div', 'modal-back')
    const box = el('div', 'modal form-modal')

    const previewUrl = image ? URL.createObjectURL(image.thumb) : existingThumbUrl
    const cleanup = () => {
      if (image && previewUrl) URL.revokeObjectURL(previewUrl)
      back.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup()
    }
    document.addEventListener('keydown', onKey)

    const h = el('div', 'modal-head')
    h.append(el('b', null, image ? '기록 추가' : '기록 수정'))
    const x = el('button', 'modal-x', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', '닫기')
    x.onclick = cleanup
    h.append(x)
    box.append(h)

    if (previewUrl) {
      const img = el('img', 'form-preview')
      img.src = previewUrl
      img.alt = '미리보기'
      box.append(img)
    }

    const meta = el('div', 'form-meta')
    const courseSel = document.createElement('select')
    /** 코스 목록을 그 길의 코스로 채운다. 길을 바꾸면 다시 채운다. */
    const fillCourses = (list, selected) => {
      courseSel.textContent = ''
      const none = document.createElement('option')
      none.value = ''
      none.textContent = '코스 지정 없음'
      courseSel.append(none)
      for (const c of list) {
        const o = document.createElement('option')
        o.value = c.id
        o.textContent = `${c.seq}코스 · ${c.region || '—'}`
        courseSel.append(o)
      }
      courseSel.value = list.some((c) => c.id === selected) ? selected : ''
    }
    const draftTrail = trailOf(draft)
    fillCourses(draftTrail === trail ? courses : [], draft.courseId ?? '')

    // 길 선택. 등록할 때는 지금 길이 기본이고, 잘못 지정한 기록은 수정 화면에서 옮길 수 있다.
    let trailSel = null
    if (trails.length > 1) {
      trailSel = document.createElement('select')
      for (const t of trails) {
        const o = document.createElement('option')
        o.value = t.id
        o.textContent = t.name
        trailSel.append(o)
      }
      trailSel.value = draftTrail
      trailSel.onchange = async () => {
        const id = trailSel.value
        let list = []
        try {
          list = await coursesOf(id)
        } catch {
          toast(`${trailName(id)} 코스 목록을 받지 못했습니다 — 코스는 비워 두고 저장됩니다`)
        }
        // 좌표가 있으면 그 길에서 가장 가까운 코스를 다시 고른다
        const n = Number.isFinite(draft.lat) ? nearestCourse([draft.lat, draft.lng], list) : null
        fillCourses(list, n?.course?.id ?? '')
      }
      meta.append(labelled('길', trailSel))
    }

    meta.append(labelled('코스', courseSel))

    if (elsewhere && trailSel) {
      const ask = el('div', 'form-elsewhere')
      ask.append(
        `이 위치는 ${trailName(elsewhere.trail)} ${elsewhere.course.name}에 더 가깝습니다 (${Math.round(elsewhere.distM)}m). `,
      )
      const move = el('button', 'link-btn', `${trailName(elsewhere.trail)} 기록으로`)
      move.type = 'button'
      move.onclick = async () => {
        trailSel.value = elsewhere.trail
        await trailSel.onchange()
        courseSel.value = elsewhere.course.id
        ask.remove()
      }
      ask.append(move)
      meta.append(ask)
    }
    const infoBits = []
    if (draft.takenAt) infoBits.push(`촬영 ${fmtDate(draft.takenAt)}`)
    infoBits.push(
      {
        exif: '위치: 사진 EXIF',
        gps: '위치: 현재 위치',
        map: '위치: 지도 지정',
        manual: '위치: 좌표 직접입력',
      }[draft.locationSource] ?? '위치: 지도 지정',
    )
    if (near) infoBits.push(`코스에서 ${Math.round(near.distM)}m`)
    meta.append(el('div', 'form-info', infoBits.join(' · ')))
    if (draft.address) meta.append(el('div', 'form-addr', `📍 사진에 기록된 주소: ${draft.address}`))
    box.append(meta)

    // 진단: "주소는 보이는데 좌표가 없다" 같은 제보를 확인할 수 있게
    // 실제로 어떤 메타데이터가 들어 있었는지 펼쳐 볼 수 있게 한다.
    if (exif?.diag?.keys?.length) {
      const det = document.createElement('details')
      det.className = 'form-diag'
      det.append(el('summary', null, `사진 메타데이터 ${exif.diag.keys.length}개 항목`))
      const body = el('div', 'diag-body')
      body.append(
        el(
          'div',
          null,
          `좌표 관련 키: ${exif.diag.hasGpsKeys.length ? exif.diag.hasGpsKeys.join(', ') : '없음'}`,
        ),
      )
      if (exif.addressSource) body.append(el('div', null, `주소 출처: ${exif.addressSource}`))
      const pre = el('pre', 'diag-pre', exif.diag.textValues.join('\n') || '(문자열 값 없음)')
      body.append(pre)
      const copy = el('button', 'btn diag-copy', '메타데이터 복사')
      copy.type = 'button'
      copy.onclick = async () => {
        const text = [
          `keys: ${exif.diag.keys.join(', ')}`,
          `gpsKeys: ${exif.diag.hasGpsKeys.join(', ') || '없음'}`,
          `addressSource: ${exif.addressSource || '없음'}`,
          '',
          ...exif.diag.textValues,
        ].join('\n')
        try {
          await navigator.clipboard.writeText(text)
          copy.textContent = '복사됨'
        } catch {
          copy.textContent = '복사 실패'
        }
      }
      body.append(copy)
      det.append(body)
      box.append(det)
    }

    const titleIn = document.createElement('input')
    titleIn.type = 'text'
    titleIn.maxLength = 80
    titleIn.placeholder = '예: 학동고개 정상'
    titleIn.value = draft.title ?? ''
    box.append(labelled('제목', titleIn))

    const memoIn = document.createElement('textarea')
    memoIn.rows = 4
    memoIn.maxLength = 2000
    memoIn.placeholder = '메모'
    memoIn.value = draft.memo ?? ''
    box.append(labelled('메모', memoIn))

    const stars = el('div', 'stars')
    let rating = draft.rating ?? 0
    const starBtns = []
    for (let i = 1; i <= 5; i++) {
      const b = el('button', 'star', '★')
      b.type = 'button'
      b.setAttribute('aria-label', `${i}점`)
      b.onclick = () => {
        rating = rating === i ? 0 : i
        paintStars()
      }
      starBtns.push(b)
      stars.append(b)
    }
    const paintStars = () => starBtns.forEach((b, i) => b.classList.toggle('is-on', i < rating))
    paintStars()
    box.append(labelled('평점', stars))

    const foot = el('div', 'modal-foot')
    const cancelBtn = el('button', 'btn', '취소')
    cancelBtn.type = 'button'
    cancelBtn.onclick = cleanup
    const saveBtn = el('button', 'btn btn-primary', '저장')
    saveBtn.type = 'button'
    saveBtn.onclick = async () => {
      saveBtn.disabled = true
      saveBtn.textContent = '저장 중…'
      try {
        const rec = await saveNote(
          {
            ...draft,
            trail: trailSel?.value ?? draftTrail,
            courseId: courseSel.value,
            title: titleIn.value.trim(),
            memo: memoIn.value.trim(),
            rating,
            address: draft.address ?? '',
            thumb: image ? image.thumb : notes.get(draft.id)?.thumb ?? null,
          },
          image ? image.full : null,
        )
        // 다른 길로 저장했으면 이 길 화면에서는 빠진다
        if (trailOf(rec) === trail) notes.set(rec.id, rec)
        else {
          notes.delete(rec.id)
          toast(`${trailName(trailOf(rec))} 기록으로 저장했습니다 — 그 길을 고르면 보입니다`)
        }
        view.syncNotePins(pinSource(), { onClick: openViewer })
        renderList()
        refreshUsage()
        hintPending()
        cleanup()
      } catch (e) {
        saveBtn.disabled = false
        saveBtn.textContent = '저장'
        toast(`저장 실패 — ${e.message}`)
      }
    }
    foot.append(cancelBtn, saveBtn)
    box.append(foot)

    back.append(box)
    back.onclick = (e) => {
      if (e.target === back) cleanup()
    }
    document.body.append(back)
    titleIn.focus()
  }

  function labelled(text, control) {
    const wrap = el('label', 'form-row')
    wrap.append(el('span', 'form-label', text), control)
    return wrap
  }

  // ── 보기 모달 ────────────────────────────────────────
  async function openViewer(note) {
    const ordered = [...notes.values()]
    let idx = ordered.findIndex((n) => n.id === note.id)
    if (idx < 0) idx = 0

    const back = el('div', 'modal-back')
    const box = el('div', 'modal view-modal')
    let revokeCurrent = null

    const cleanup = () => {
      revokeCurrent?.()
      back.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup()
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    document.addEventListener('keydown', onKey)

    const h = el('div', 'modal-head')
    const hTitle = el('b')
    const nav = el('span', 'view-nav')
    const x = el('button', 'modal-x', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', '닫기')
    x.onclick = cleanup
    h.append(hTitle, nav, x)

    const figure = el('div', 'view-figure')
    const img = el('img', 'view-img')
    img.alt = ''
    figure.append(img)

    const prev = el('button', 'view-arrow view-prev', '‹')
    const next = el('button', 'view-arrow view-next', '›')
    prev.type = next.type = 'button'
    prev.setAttribute('aria-label', '이전 기록')
    next.setAttribute('aria-label', '다음 기록')
    prev.onclick = () => step(-1)
    next.onclick = () => step(1)
    figure.append(prev, next)

    const body = el('div', 'view-body')
    const foot = el('div', 'modal-foot')
    const editBtn = el('button', 'btn', '수정')
    const delBtn = el('button', 'btn btn-danger', '삭제')
    editBtn.type = delBtn.type = 'button'
    foot.append(delBtn, editBtn)

    box.append(h, figure, body, foot)
    back.append(box)
    back.onclick = (e) => {
      if (e.target === back) cleanup()
    }
    document.body.append(back)

    const step = (d) => {
      const n = ordered.length
      if (n <= 1) return
      idx = (idx + d + n) % n
      paint()
    }

    async function paint() {
      const cur = ordered[idx]
      hTitle.textContent = cur.title || '(제목 없음)'
      nav.textContent = ordered.length > 1 ? `${idx + 1} / ${ordered.length}` : ''
      prev.hidden = next.hidden = ordered.length <= 1

      body.textContent = ''
      const course = courses.find((c) => c.id === cur.courseId)
      const bits = []
      if (course) bits.push(course.name + (course.region ? ` · ${course.region}` : ''))
      if (cur.takenAt) bits.push(`촬영 ${fmtDate(cur.takenAt)}`)
      else if (cur.createdAt) bits.push(`등록 ${fmtDate(cur.createdAt)}`)
      if (cur.rating) bits.push('★'.repeat(cur.rating))
      body.append(el('div', 'view-meta', bits.join(' · ')))
      if (cur.address) body.append(el('div', 'view-addr', `📍 ${cur.address}`))
      if (cur.memo) body.append(el('p', 'view-memo', cur.memo)) // textContent — HTML 로 렌더하지 않는다

      revokeCurrent?.()
      revokeCurrent = null
      img.removeAttribute('src')
      const blob = (await getPhoto(cur.id)) ?? cur.thumb
      const picked = imageSrc(blob, remoteUrl(cur, 'full') ?? remoteUrl(cur, 'thumb'))
      if (picked.src) {
        img.src = picked.src
        img.alt = cur.title || '사진'
        revokeCurrent = picked.revoke
      }

      editBtn.onclick = () => {
        cleanup()
        openForm({
          draft: { ...cur },
          image: null,
          near: null,
          // 업로드가 끝난 사진은 로컬 썸네일이 없다 — 원격 URL 로 보여 준다
          existingThumbUrl: cur.thumb ? URL.createObjectURL(cur.thumb) : remoteUrl(cur, 'thumb'),
        })
      }
      delBtn.onclick = async () => {
        if (!confirm(`"${cur.title || '이 기록'}"을 삭제할까요?`)) return
        await deleteNote(cur.id)
        notes.delete(cur.id)
        view.syncNotePins(pinSource(), { onClick: openViewer })
        renderList()
        refreshUsage()
        hintPending()
        cleanup()
      }

      view.panTo([cur.lat, cur.lng])
    }

    await paint()
  }

  // ── 목록 ─────────────────────────────────────────────
  const listUrls = new Set()

  /**
   * 목록에 한 번에 보여줄 개수.
   *
   * 전부 렌더하면 기록마다 DOM 노드와 blob URL 이 생긴다. 수백 장이면
   * 구간을 바꿀 때마다 그만큼 만들고 해제하느라 눈에 띄게 느려진다.
   */
  const PAGE = 20
  let shown = PAGE

  function renderList() {
    for (const u of listUrls) URL.revokeObjectURL(u)
    listUrls.clear()
    list.textContent = ''

    const all = [...notes.values()].reverse() // 최근 등록이 위로
    headCount.textContent = all.length ? `${all.length}개` : ''
    const ordered = all.slice(0, shown)

    if (all.length === 0) {
      list.append(
        el(
          'li',
          'notes-empty',
          sync?.configured?.()
            ? `이 브라우저에 ${trailName(trail)} 기록이 없습니다. 사진을 올리거나, 동기화를 눌러 GitHub 에 저장된 기록을 받아오세요.`
            : `아직 ${trailName(trail)} 기록이 없습니다. 사진을 올리면 지도에 위치가 표시됩니다.`,
        ),
      )
      return
    }

    for (const n of ordered) {
      const li = el('li', 'note-item')
      const picked = imageSrc(n.thumb, remoteUrl(n, 'thumb'))
      if (picked.src) {
        if (n.thumb) listUrls.add(picked.src)
        const img = el('img', 'note-thumb')
        img.src = picked.src
        img.alt = ''
        img.loading = 'lazy'
        li.append(img)
      } else {
        li.append(el('span', 'note-thumb is-empty', '📷'))
      }

      const mid = el('span', 'note-mid')
      mid.append(el('span', 'note-name', n.title || '(제목 없음)'))
      const course = courses.find((c) => c.id === n.courseId)
      mid.append(
        el('span', 'note-sub', [course?.name, fmtDate(n.takenAt ?? n.createdAt)].filter(Boolean).join(' · ')),
      )
      li.append(mid)

      li.onclick = () => openViewer(n)
      list.append(li)
    }

    if (all.length > ordered.length) {
      const more = el('li', 'notes-more')
      const btn = el('button', 'link-btn', `더 보기 (${all.length - ordered.length}개 남음)`)
      btn.type = 'button'
      btn.onclick = () => {
        shown += PAGE
        renderList()
      }
      more.append(btn)
      list.append(more)
    }
  }

  /** 동기화가 설정돼 있으면 "올릴 것이 있다"는 걸 알려준다. */
  function hintPending() {
    if (!sync?.configured()) return
    const last = sync.lastSyncedAtValue
    setSyncMsg(last ? '변경됨 — 동기화 필요' : '아직 동기화하지 않음')
  }

  async function refreshUsage() {
    const u = await usage()
    const count = notes.size
    const base = u
      ? `사진 ${count}장 · 이 브라우저에 약 ${formatBytes(u.usedBytes)} 저장됨`
      : `사진 ${count}장`

    // 지도에 일부만 그려졌으면 그 사실을 알린다.
    // 상한에 걸려 조용히 빠지면 "사진이 사라졌다"고 오해하게 된다.
    const pins = view.notePinStats?.()
    const capped = pins && pins.drawn < pins.total
    usageLine.textContent = capped
      ? `${base} · 지도에 ${pins.drawn}개 표시 (확대하면 더 보입니다)`
      : base
  }

  function toast(message) {
    const t = el('div', 'toast', message)
    document.body.append(t)
    setTimeout(() => t.remove(), 4000)
  }

  // ── 초기 로딩 ────────────────────────────────────────
  /** 저장소에서 지금 길의 기록만 다시 읽는다. 다른 길로 옮긴 기록은 여기서 빠진다. */
  async function readTrailNotes() {
    notes.clear()
    for (const n of await allNotes()) if (trailOf(n) === trail) notes.set(n.id, n)
  }

  async function load() {
    try {
      await readTrailNotes()
    } catch (e) {
      usageLine.textContent = `저장소를 열 수 없습니다 — ${e.message}`
      return
    }
    // 핀은 화면에 보이는 것만 그린다. 전부 그리면 기록 수만큼 DOM 마커와
    // blob URL 이 동시에 살아 있어서 수백 장이 되면 지도가 무거워진다.
    view.syncNotePins(pinSource(), { onClick: openViewer })
    renderList()
    refreshUsage()
    // 지도를 움직이면 그려진 핀 수가 바뀌므로 표시도 따라가게 한다
    view.map.on('moveend zoomend', refreshUsage)

    // 토큰 없이도 공개 리포의 최신 기록을 받아온다.
    //
    // 이게 없으면 리포 주인이 기기에서 "동기화"를 눌러야만 그 결과가 자기
    // 화면에 보이고, 다른 방문자는 토큰이 없어 영원히 빈 지도만 본다.
    // 쓰기(사진 업로드·notes.json 커밋)만 토큰이 필요하지, 공개 리포 읽기는
    // 누구나 할 수 있다 — 그 경로를 타서 로컬에 조용히 병합한다.
    if (sync) {
      try {
        const r = await sync.pullPublic()
        if (r.pulled) {
          await readTrailNotes()
          view.syncNotePins(pinSource(), { onClick: openViewer })
          renderList()
          refreshUsage()
        }
      } catch {
        // 오프라인이거나 리포가 아직 없을 수 있다 — 로컬 기록은 이미 보이므로 조용히 넘긴다
      }
    }

    if (sync && !syncMsg.textContent) {
      const at = await sync.lastSyncedAt()
      const expiry = sync.tokenExpiryNote?.()
      if (expiry) return setSyncMsg(expiry, 'bad')
      setSyncMsg(
        !sync.configured()
          ? '동기화 미설정 — ⚙ 를 눌러 설정하세요'
          : at
            ? `마지막 동기화 ${fmtDate(at)}`
            : '아직 동기화하지 않음',
      )
    }
  }

  return { load, get count() { return notes.size } }
}
