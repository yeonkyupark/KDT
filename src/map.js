import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/** 난이도별 색. 밝은/어두운 타일과 위성 영상 위에서 모두 구분되는 값으로 골랐다. */
export const DIFFICULTY_COLOR = {
  쉬움: '#1f9d5c',
  보통: '#d98026',
  어려움: '#cf4436',
}

/** 난이도 등급이 없는 코스(공식 데이터 누락 대비). */
const NO_LEVEL_COLOR = '#8b8f98'

/**
 * 선택된 코스 / 선택 밖 코스의 선 두께·투명도.
 *
 * OFF를 너무 낮추면(0.28 이하) 밝은 OSM 타일에서 나머지 구간이 사실상 사라져
 * 전체 경로 안에서 지금 구간이 어디인지 감이 안 온다. 맥락은 남긴다.
 */
const ON = { weight: 4, opacity: 1, casing: 8, casingOpacity: 0.8 }
const OFF = { weight: 2, opacity: 0.45, casing: 5, casingOpacity: 0.3 }

// 공공누리 제4유형: 출처표시 의무. 노선·코스 정보 모두 두루누비(한국관광공사) 공식 자료다.
const GPX_ATTR =
  '노선 <a href="https://www.durunubi.kr/namparang-course-list.do" target="_blank" rel="noopener">두루누비(한국관광공사)</a> · 공공누리 제4유형'

export const TILE_NAMES = ['기본', '지형', '위성']

/**
 * 타일을 살짝 옅게 깔아서 그 위의 코스 선(난이도 색 + 흰 테두리)이 더 도드라지게 한다.
 * 위성 영상은 자체 색이 진하고 복잡해서 조금 더 낮춘다.
 *
 * Leaflet의 `opacity` 레이어 옵션은 쓰지 않는다 — 타일 페이드인 애니메이션과
 * 겹치면 타일이 로드된 뒤에도 `opacity: 0`에 멈춰버린다(실측 확인). 대신
 * `tilePane` 전체에 CSS 로 옅게를 적용한다 — 세 레이어가 같은 pane 을 쓰고
 * 한 번에 하나만 보이므로, pane 하나의 값만 바꿔도 충분하다.
 */
const TILE_OPACITY = { 기본: 0.85, 지형: 0.85, 위성: 0.75 }

function tileLayers() {
  return {
    기본: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: `&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · ${GPX_ATTR}`,
    }),
    지형: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      subdomains: 'abc',
      attribution: `&copy; <a href="https://opentopomap.org/" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA) · ${GPX_ATTR}`,
    }),
    위성: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: `Esri, Maxar, Earthstar Geographics · ${GPX_ATTR}` },
    ),
  }
}

/**
 * 지도를 만들고 90개 코스를 그린다.
 *
 * 코스 하나를 폴리라인 2개로 그린다 — 아래에 굵은 흰 테두리(casing), 위에 난이도 색.
 * 위성 영상이나 지형도 위에서 선이 배경에 묻히는 것을 막는다.
 */
export function createMap(el, courses, { onSelect, getInsets } = {}) {
  const layers = tileLayers()

  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    layers: [layers.기본],
  })

  L.control.zoom({ position: 'topright' }).addTo(map)
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map)
  map.getPane('tilePane').style.opacity = TILE_OPACITY.기본

  const casingGroup = L.layerGroup().addTo(map)
  const lineGroup = L.layerGroup().addTo(map)
  const markerGroup = L.layerGroup().addTo(map)
  const noteGroup = L.layerGroup().addTo(map)

  /** @type {Map<string, {marker: L.Marker, url: string|null}>} 노트 핀 + 해제할 blob URL */
  const notePins = new Map()
  /** @type {L.Marker[]} 클러스터 핀. 사진을 들고 있지 않아 매 redraw마다 통째로 다시 그린다. */
  const clusterMarkers = []

  /** 화면 범위 기반 핀 렌더링 상태 */
  let noteSource = []
  let noteClick = null
  let notesVisible = true
  /** 화면 범위 안 후보를 이 개수까지만 본다. 그리디 클러스터링이 O(n²)라 안전장치가 필요하다. */
  const MAX_CANDIDATES = 600
  /** 이 픽셀 거리 안의 핀은 하나의 클러스터로 묶는다. */
  const CLUSTER_PX = 42
  /** 마지막 redraw에서 실제로 본 후보 수 (상태 표시용). */
  let lastCandidateCount = 0

  /** @type {Map<string, object>} id -> {casing, line, marker, course, on, detail} */
  const rendered = new Map()

  /** 고도 프로필 hover 위치를 표시하는 마커. 필요할 때 만든다. */
  let cursor = null

  /**
   * 클릭으로 "고정"한 코스 하나. 마우스오버처럼 지나가면 사라지는 게 아니라
   * 다시 클릭하거나 다른 코스를 클릭하거나 구간이 바뀌기 전까지 굵게 유지된다.
   * @type {string|null}
   */
  let pinnedId = null

  /** 이 코스가 지금 그려야 할 굵기. 고정된 코스는 선택(ON/OFF) 두께에 +3. */
  function baseWeight(id, rec) {
    const w = (rec.on ? ON : OFF).weight
    return id === pinnedId ? w + 3 : w
  }

  /** 지도에서 코스를 클릭해 굵게 고정한다. 같은 코스를 다시 클릭하면 해제된다. */
  function togglePin(id) {
    const prev = pinnedId
    pinnedId = prev === id ? null : id
    for (const target of new Set([prev, pinnedId].filter(Boolean))) {
      const rec = rendered.get(target)
      if (!rec) continue
      rec.line.setStyle({ weight: baseWeight(target, rec) })
      if (target === pinnedId) rec.line.bringToFront()
    }
  }

  for (const c of courses) {
    if (!c.overview?.length) continue

    const color = DIFFICULTY_COLOR[c.difficulty] ?? NO_LEVEL_COLOR

    const casing = L.polyline(c.overview, {
      color: '#ffffff',
      weight: ON.casing,
      opacity: ON.casingOpacity,
      interactive: false,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(casingGroup)

    const line = L.polyline(c.overview, {
      color,
      weight: ON.weight,
      opacity: ON.opacity,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(lineGroup)

    const marker = L.circleMarker(c.startLatLng, {
      radius: 4,
      color: '#ffffff',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(markerGroup)

    const rec = { casing, line, marker, course: c, on: true, detail: null }

    const label = tooltipHtml(c)
    line.bindTooltip(label, { sticky: true })
    marker.bindTooltip(label)

    const select = () => {
      togglePin(c.id)
      onSelect?.(c)
    }
    line.on('click', select)
    marker.on('click', select)

    // 선이 얇아서 hover 판정이 어렵다. 굵게 잡아준다.
    // 고정된 코스는 마우스가 지나가도 그보다 얇아지면 안 되므로 둘 중 굵은 쪽을 쓴다.
    line.on('mouseover', () => line.setStyle({ weight: Math.max((rec.on ? ON : OFF).weight + 3, baseWeight(c.id, rec)) }))
    line.on('mouseout', () => line.setStyle({ weight: baseWeight(c.id, rec) }))

    rendered.set(c.id, rec)
  }

  /**
   * 노트 핀 하나를 그린다.
   * 썸네일이 있으면 핀 자체를 작은 사진으로 만든다 — 지도만 봐도 어디서
   * 뭘 찍었는지 알 수 있다.
   */
  function addNotePin(note) {
    removeNotePin(note.id)

    const box = document.createElement('div')
    box.className = 'note-pin'
    let url = null
    if (note.thumb) {
      url = URL.createObjectURL(note.thumb)
    } else if (note.photo?.thumb || note.photo?.thumbUrl) {
      url = note.remoteThumbUrl ?? note.photo?.thumbUrl ?? null
    }
    if (url) {
      const img = document.createElement('img')
      img.src = url
      img.alt = note.title || '사진'
      img.loading = 'lazy'
      box.append(img)
    } else {
      box.classList.add('is-empty')
      box.textContent = '📷'
    }

    const marker = L.marker([note.lat, note.lng], {
      icon: L.divIcon({ html: box, className: '', iconSize: [30, 30], iconAnchor: [15, 15] }),
      title: note.title || '기록',
      riseOnHover: true,
      zIndexOffset: 1000, // 코스 선·시작점 마커보다 위에
    }).addTo(noteGroup)

    marker.on('click', () => noteClick?.(note))
    // blob URL 만 해제 대상이다. 원격 URL 은 해제하면 안 된다.
    notePins.set(note.id, { marker, url: note.thumb ? url : null })
    return marker
  }

  function removeNotePin(id) {
    const prev = notePins.get(id)
    if (!prev) return
    noteGroup.removeLayer(prev.marker)
    // divIcon 안의 blob URL 을 놓아준다. 안 하면 사진마다 메모리가 샌다.
    if (prev.url) URL.revokeObjectURL(prev.url)
    notePins.delete(id)
  }

  /**
   * 클러스터 핀 하나를 그린다. 사진을 들고 있지 않으므로(개수만 표시) blob URL
   * 해제를 신경 쓸 필요가 없고, 매 redraw마다 통째로 지우고 다시 그려도 싸다.
   * 클릭하면 그 클러스터가 담은 노트들의 bounds로 확대한다 — 확대하면
   * 다음 redraw에서 화면 픽셀 거리가 벌어져 자연히 개별 핀으로 갈라진다.
   */
  function addClusterPin(notes) {
    const box = document.createElement('div')
    box.className = 'note-cluster'
    box.textContent = notes.length > 99 ? '99+' : String(notes.length)

    const center = notes.reduce((acc, n) => [acc[0] + n.lat, acc[1] + n.lng], [0, 0])
    center[0] /= notes.length
    center[1] /= notes.length

    const marker = L.marker(center, {
      icon: L.divIcon({ html: box, className: '', iconSize: [36, 36], iconAnchor: [18, 18] }),
      title: `사진 ${notes.length}장`,
      riseOnHover: true,
      zIndexOffset: 1100, // 개별 노트 핀(1000)보다 위
    }).addTo(noteGroup)

    marker.on('click', () => {
      fitBounds(L.latLngBounds(notes.map((n) => [n.lat, n.lng])), {
        maxZoom: Math.min(map.getZoom() + 3, 18),
      })
    })
    clusterMarkers.push(marker)
  }

  function clearClusterPins() {
    for (const m of clusterMarkers) noteGroup.removeLayer(m)
    clusterMarkers.length = 0
  }

  /**
   * 현재 화면 범위에 드는 노트만 그린다. 가까이 모인 핀은 클러스터로 묶는다.
   *
   * 사진이 몇 장뿐일 때는(≥ 90개 코스, 실제로는 훨씬 적다) 굳이 묶을 일이
   * 없지만, 한 지점에 여러 장을 등록하면(같은 정상, 같은 전망대) 핀이 겹쳐
   * 뒤에 있는 사진을 클릭할 수 없게 된다. 화면 픽셀 거리 기준으로 묶으면
   * 줌 레벨과 무관하게 "겹쳐 보이는 것"만 묶인다.
   */
  function redrawNotePins() {
    clearClusterPins()
    if (!notesVisible || !noteSource.length) {
      for (const id of [...notePins.keys()]) removeNotePin(id)
      lastCandidateCount = 0
      return
    }

    // 화면을 살짝 넘겨 그려두면 조금 움직였을 때 핀이 깜빡이지 않는다
    const bounds = map.getBounds().pad(0.25)
    const candidates = []
    for (const n of noteSource) {
      if (candidates.length >= MAX_CANDIDATES) break
      if (bounds.contains([n.lat, n.lng])) candidates.push(n)
    }
    lastCandidateCount = candidates.length

    // 화면 좌표로 그리디 클러스터링. 후보가 MAX_CANDIDATES로 상한이 있어 O(n²)여도 무겁지 않다.
    const pts = candidates.map((n) => ({ n, p: map.latLngToContainerPoint([n.lat, n.lng]) }))
    const used = new Array(pts.length).fill(false)
    const wanted = new Set()

    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue
      const group = [pts[i]]
      used[i] = true
      for (let j = i + 1; j < pts.length; j++) {
        if (!used[j] && pts[i].p.distanceTo(pts[j].p) <= CLUSTER_PX) {
          group.push(pts[j])
          used[j] = true
        }
      }
      if (group.length === 1) {
        const n = group[0].n
        wanted.add(n.id)
        if (!notePins.has(n.id)) addNotePin(n)
      } else {
        addClusterPin(group.map((g) => g.n))
      }
    }
    for (const id of [...notePins.keys()]) if (!wanted.has(id)) removeNotePin(id)
  }
  map.on('moveend zoomend', redrawNotePins)

  // 사이드바 접기, 고도 프로필 접기, 창 크기 변경 — 지도 컨테이너 크기가 바뀌는
  // 경로가 여러 개다. 그때마다 invalidateSize()를 부르는 대신 한곳에서 관찰한다.
  // (부르지 않으면 Leaflet이 옛 크기를 기준으로 타일과 좌표를 계산해 지도가 어긋난다)
  new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(el)

  // 시작점 마커 90개를 전국 줌에서 원래 크기로 두면 코스 선을 덮어버려
  // 경로가 점선처럼 보인다. 줌에 따라 크기를 줄인다.
  function syncMarkerSize() {
    const z = map.getZoom()
    const base =
      z < 9 ? { radius: 2, weight: 0 } : z < 12 ? { radius: 3.5, weight: 1 } : { radius: 5, weight: 1.5 }
    for (const rec of rendered.values()) {
      const dim = rec.on ? 1 : 0.3
      rec.marker
        .setStyle({ ...base, color: '#ffffff', opacity: base.weight ? dim : 0, fillOpacity: dim })
        .setRadius(base.radius)
    }
  }
  map.on('zoomend', syncMarkerSize)

  function boundsOf(ids) {
    const b = L.latLngBounds([])
    for (const [id, rec] of rendered) {
      if (ids && !ids.has(id)) continue
      b.extend(rec.line.getBounds())
    }
    return b
  }

  /**
   * 지도를 bounds 에 맞춘다.
   *
   * **`animate: false` 가 기본이다.** Leaflet 의 줌 애니메이션 경로가 이 앱에서
   * 완료되지 않는 경우가 있다 — 실측: 줌 12에서 전국(목표 줌 8)으로 `fitBounds` 를
   * 부르면 유효한 bounds 와 올바른 목표 줌을 계산하고 `map.fitBounds` 까지
   * 호출되는데 줌이 그대로였다. 같은 호출에 `animate: false` 를 주면 즉시 8로 갔다.
   * 핀 개수와는 무관했다(핀을 모두 치워도 재현).
   *
   * 근본 원인은 확정하지 못했다. 다만 이 앱에서 줌 애니메이션은 부가 기능이고,
   * 구간을 바꿀 때 즉시 이동하는 편이 오히려 반응이 빠르게 느껴진다.
   * 호출부가 필요하면 `{ animate: true }` 로 덮어쓸 수 있다.
   */
  function fitBounds(b, options) {
    if (!b.isValid()) return
    const ins = getInsets?.() ?? {}
    map.fitBounds(b, {
      paddingTopLeft: [ins.left ?? 24, ins.top ?? 20],
      paddingBottomRight: [ins.right ?? 24, ins.bottom ?? 40],
      animate: false,
      ...options,
    })
    syncMarkerSize()
    redrawNotePins()
  }

  return {
    map,
    layers,
    rendered,
    syncMarkerSize,

    /** 전체 코스가 보이도록 맞춘다. */
    fitAll(options) {
      fitBounds(boundsOf(null), options)
    },

    /** 주어진 코스들만 보이도록 맞춘다. */
    fitIds(ids, options) {
      fitBounds(boundsOf(ids), options)
    },

    /**
     * 선택 구간을 강조하고 나머지를 흐리게 한다.
     * `ids`가 null이면 전부 강조(= 흐린 코스 없음).
     */
    setSelection(ids) {
      // 고정된 코스가 새 구간 밖으로 밀려나면 고정을 해제한다 — 안 그러면
      // 화면에 안 보이는 코스가 계속 "고정"된 채로 남는다.
      if (pinnedId && ids && !ids.has(pinnedId)) pinnedId = null

      for (const [id, rec] of rendered) {
        const on = !ids || ids.has(id)
        rec.on = on
        const s = on ? ON : OFF
        rec.line.setStyle({ weight: baseWeight(id, rec), opacity: s.opacity })
        rec.casing.setStyle({ weight: s.casing, opacity: s.casingOpacity })
        // 강조된 선이 흐린 선 위에 오게 한다
        if (on) rec.line.bringToFront()
      }
      syncMarkerSize()
    },

    /** 지도에서 코스를 클릭해 굵게 고정한다(다시 클릭하면 해제). 사이드바 목록 클릭에서도 쓴다. */
    togglePin,

    /** 오버뷰 라인을 고해상도 상세 라인으로 교체한다. 한 번 바꾸면 되돌리지 않는다. */
    upgradeToDetail(id, latlngs) {
      const rec = rendered.get(id)
      if (!rec || rec.detail || !latlngs?.length) return
      rec.detail = latlngs
      rec.line.setLatLngs(latlngs)
      rec.casing.setLatLngs(latlngs)
    },

    /** 코스 하나를 화면에 담는다. */
    focus(id, options) {
      const rec = rendered.get(id)
      if (rec) fitBounds(rec.line.getBounds(), options)
    },

    /** 목록에서 hover 했을 때 지도에서 해당 코스를 두드러지게 한다. */
    accent(id, on) {
      const rec = rendered.get(id)
      if (!rec) return
      const hoverW = (rec.on ? ON : OFF).weight + 3
      rec.line.setStyle({ weight: on ? hoverW : baseWeight(id, rec) })
      if (on) rec.line.bringToFront()
    },

    /**
     * 고도 프로필에서 가리키는 지점을 지도에 표시한다.
     * `latlng`가 null이면 지운다.
     */
    setCursor(latlng) {
      if (!latlng) {
        cursor?.remove()
        cursor = null
        return
      }
      if (!cursor) {
        cursor = L.circleMarker(latlng, {
          radius: 6,
          color: '#ffffff',
          weight: 2.5,
          fillColor: '#111418',
          fillOpacity: 1,
          interactive: false,
        }).addTo(map)
        cursor.bringToFront()
      } else {
        cursor.setLatLng(latlng)
      }
    },

    setTile(name) {
      for (const [key, layer] of Object.entries(layers)) {
        if (key === name) layer.addTo(map)
        else map.removeLayer(layer)
      }
      map.getPane('tilePane').style.opacity = TILE_OPACITY[name] ?? 1
    },

    // ── 사진·메모 핀 ───────────────────────────────────
    /**
     * 화면에 보이는 노트만 핀으로 그린다.
     *
     * 전부 그리면 기록 수만큼 DOM 마커와 blob URL 이 동시에 살아 있다.
     * 수백 장이 되면 지도 조작이 눈에 띄게 무거워지고 메모리도 그만큼 잡는다.
     * 지금 보이는 범위 + 여유분만 그리고, 지도를 움직이면 다시 계산한다.
     *
     * @param {Array} notes 전체 노트
     * @param {{onClick?: Function}} opts
     */
    syncNotePins(notes, opts = {}) {
      noteSource = notes
      noteClick = opts.onClick ?? noteClick
      redrawNotePins()
    },

    /** 지금 화면에 표시된(개별 핀 + 클러스터에 묶인) 노트 수 / 전체 (상태 표시용) */
    notePinStats() {
      return { drawn: lastCandidateCount, total: noteSource.length, clusters: clusterMarkers.length }
    },

    /** 지도 위 사진 핀을 전부 껐다/켰다 한다. 목록은 영향받지 않는다. */
    setNotesVisible(v) {
      notesVisible = v
      redrawNotePins()
    },

    get notesVisible() {
      return notesVisible
    },

    /** 노트 핀 하나를 강제로 올린다 (범위 계산과 무관하게). */
    setNotePin(note, opts = {}) {
      if (opts.onClick) noteClick = opts.onClick
      addNotePin(note)
    },

    removeNotePin,

    clearNotePins() {
      noteSource = []
      lastCandidateCount = 0
      for (const id of [...notePins.keys()]) removeNotePin(id)
      clearClusterPins()
    },

    /**
     * 지도 클릭으로 좌표 하나를 받는다. EXIF에 좌표가 없는 사진의 위치를 정할 때 쓴다.
     * @returns {{promise: Promise<[number,number]|null>, cancel: () => void}}
     */
    pickLocation() {
      const container = map.getContainer()
      container.classList.add('is-picking')

      let settle
      const promise = new Promise((resolve) => (settle = resolve))

      const finish = (value) => {
        container.classList.remove('is-picking')
        map.off('click', onClick)
        settle(value)
      }
      const onClick = (e) => finish([e.latlng.lat, e.latlng.lng])

      map.on('click', onClick)
      return { promise, cancel: () => finish(null) }
    },

    panTo(latlng) {
      map.panTo(latlng, { animate: true })
    },
  }
}

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  )
}

function tooltipHtml(c) {
  const route = c.start && c.end ? `${esc(c.start)} → ${esc(c.end)}` : '지점명 정보 없음'
  const bits = [`${c.distanceKm} km`, `↑ ${c.ascentM.toLocaleString()} m`, formatDuration(c.durationMin)]
  return (
    `<div class="tip"><b>${esc(c.name)}</b>` +
    (c.region ? ` <span class="tip-region">${esc(c.region)}</span>` : '') +
    (c.alias ? `<div class="tip-alias">${esc(c.alias)}</div>` : '') +
    `<div class="tip-route">${route}</div>` +
    `<div class="tip-stats">${bits.join(' · ')}</div>` +
    '</div>'
  )
}

export function formatDuration(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`
}
