/**
 * 고도 프로필 — 인라인 SVG.
 *
 * 차트 라이브러리를 쓰지 않는다. 필요한 건 면적 + 선 + 커서 하나뿐이고,
 * uPlot(40KB)이나 Chart.js(70KB)를 넣으면 "가벼운 스택" 제약에 어긋난다.
 *
 * 데이터는 두 단계로 들어온다.
 *   1. courses.json 의 `eleLow` (코스당 32점) — 전 구간도 즉시 그린다
 *   2. course/{id}.json 의 `ele.values` (50m 간격) — 도착하면 고해상도로 교체
 */

const NS = 'http://www.w3.org/2000/svg'
/** 컨테이너 높이를 못 읽을 때만 쓰는 대비값. 실제 높이는 CSS가 정한다. */
const FALLBACK_HEIGHT = 132
const PAD = { top: 12, right: 46, bottom: 18, left: 8 }

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
  return n
}

/**
 * @param {HTMLElement} root
 * @param {{onHover?: (s: object|null) => void}} opts
 */
export function createProfile(root, { onHover } = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'profile'

  const head = document.createElement('div')
  head.className = 'pf-head'
  const title = document.createElement('span')
  title.className = 'pf-title'
  title.textContent = '고도 프로필'
  const readout = document.createElement('span')
  readout.className = 'pf-readout'
  const note = document.createElement('span')
  note.className = 'pf-note'
  note.textContent = 'DEM 추정값'
  head.append(title, readout, note)

  const plot = document.createElement('div')
  plot.className = 'pf-plot'

  wrap.append(head, plot)
  root.append(wrap)

  /** @type {Array<{x:number, y:number, courseId:string, frac:number}>} */
  let samples = []
  let segments = []
  let scale = null
  let svg = null
  let cursorGroup = null

  function buildSamples(segs) {
    const out = []
    let offset = 0 // m
    for (const seg of segs) {
      const n = seg.ele.length
      if (n === 0) {
        offset += seg.lengthM
        continue
      }
      for (let i = 0; i < n; i++) {
        // 샘플은 코스 안에서 균등 간격이다 (50m 간격 원본이든 32버킷 요약이든)
        const frac = n === 1 ? 0 : i / (n - 1)
        out.push({
          x: offset + frac * seg.lengthM,
          y: seg.ele[i],
          courseId: seg.course.id,
          courseName: seg.course.name,
          frac,
        })
      }
      offset += seg.lengthM
    }
    return out
  }

  function render() {
    plot.textContent = ''
    svg = null
    cursorGroup = null
    scale = null

    const w = plot.clientWidth
    // 높이를 상수로 박으면 CSS(모바일 104px)와 어긋나 컨테이너를 넘치고
    // 문서 전체에 스크롤바가 생긴다. 실제 높이를 읽는다.
    const H = plot.clientHeight || FALLBACK_HEIGHT
    if (!w || samples.length < 2) return

    const totalM = samples[samples.length - 1].x
    const ys = samples.map((s) => s.y)
    let lo = Math.min(...ys)
    let hi = Math.max(...ys)
    if (hi - lo < 20) {
      // 평탄한 구간에서 y축을 과확대하면 노이즈가 산맥처럼 보인다
      const mid = (hi + lo) / 2
      lo = mid - 10
      hi = mid + 10
    }

    const innerW = Math.max(1, w - PAD.left - PAD.right)
    const innerH = Math.max(1, H - PAD.top - PAD.bottom)
    const px = (m) => PAD.left + (totalM ? (m / totalM) * innerW : 0)
    const py = (e) => PAD.top + innerH - ((e - lo) / (hi - lo)) * innerH
    scale = { px, py, totalM, lo, hi, innerW, innerH, w, H }

    svg = svgEl('svg', {
      width: w,
      height: H,
      viewBox: `0 0 ${w} ${H}`,
      class: 'pf-svg',
      role: 'img',
      'aria-label': `선택 구간 고도 프로필, ${Math.round(lo)}m부터 ${Math.round(hi)}m`,
    })

    // 기준선 (최저·중간·최고)
    for (const e of [lo, (lo + hi) / 2, hi]) {
      const y = py(e)
      svg.append(
        svgEl('line', { x1: PAD.left, y1: y, x2: PAD.left + innerW, y2: y, class: 'pf-grid' }),
      )
      const t = svgEl('text', { x: PAD.left + innerW + 6, y: y + 3.5, class: 'pf-ylabel' })
      t.textContent = `${Math.round(e)}m`
      svg.append(t)
    }

    // 코스 경계
    let acc = 0
    const showLabels = segments.length <= 14
    for (const seg of segments) {
      if (acc > 0) {
        const x = px(acc)
        svg.append(
          svgEl('line', { x1: x, y1: PAD.top, x2: x, y2: PAD.top + innerH, class: 'pf-sep' }),
        )
      }
      if (showLabels) {
        const t = svgEl('text', {
          x: px(acc + seg.lengthM / 2),
          y: H - 5,
          class: 'pf-xlabel',
          'text-anchor': 'middle',
        })
        t.textContent = String(seg.course.seq)
        svg.append(t)
      }
      acc += seg.lengthM
    }

    // 면적 + 선
    let d = ''
    for (const [i, s] of samples.entries()) {
      d += `${i ? 'L' : 'M'}${px(s.x).toFixed(1)} ${py(s.y).toFixed(1)}`
    }
    const base = PAD.top + innerH
    svg.append(svgEl('path', { d: `${d}L${px(totalM).toFixed(1)} ${base}L${px(0).toFixed(1)} ${base}Z`, class: 'pf-area' }))
    svg.append(svgEl('path', { d, class: 'pf-line' }))

    // 거리 라벨
    for (const [m, anchor] of [
      [0, 'start'],
      [totalM, 'end'],
    ]) {
      const t = svgEl('text', {
        x: px(m) + (anchor === 'start' ? 0 : 0),
        y: PAD.top - 3,
        class: 'pf-dist',
        'text-anchor': anchor,
      })
      t.textContent = `${(m / 1000).toFixed(m === 0 ? 0 : 1)} km`
      svg.append(t)
    }

    cursorGroup = svgEl('g', { class: 'pf-cursor', visibility: 'hidden' })
    cursorGroup.append(
      svgEl('line', { x1: 0, y1: PAD.top, x2: 0, y2: base, class: 'pf-cursor-line' }),
      svgEl('circle', { cx: 0, cy: 0, r: 3.5, class: 'pf-cursor-dot' }),
    )
    svg.append(cursorGroup)

    plot.append(svg)
  }

  function sampleAt(clientX) {
    if (!scale || samples.length === 0) return null
    const rect = plot.getBoundingClientRect()
    const x = clientX - rect.left
    const m = ((x - PAD.left) / scale.innerW) * scale.totalM

    // 균등 간격이 아닐 수 있으므로 이분 탐색
    let lo = 0
    let hi = samples.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (samples[mid].x <= m) lo = mid
      else hi = mid
    }
    return Math.abs(samples[lo].x - m) <= Math.abs(samples[hi].x - m) ? samples[lo] : samples[hi]
  }

  function showCursor(s) {
    if (!cursorGroup || !scale) return
    if (!s) {
      cursorGroup.setAttribute('visibility', 'hidden')
      readout.textContent = ''
      return
    }
    const x = scale.px(s.x)
    const y = scale.py(s.y)
    cursorGroup.setAttribute('visibility', 'visible')
    cursorGroup.firstChild.setAttribute('x1', x)
    cursorGroup.firstChild.setAttribute('x2', x)
    cursorGroup.lastChild.setAttribute('cx', x)
    cursorGroup.lastChild.setAttribute('cy', y)
    readout.textContent = `${s.courseName} · ${(s.x / 1000).toFixed(1)} km · ${Math.round(s.y)} m`
  }

  plot.addEventListener('pointermove', (e) => {
    const s = sampleAt(e.clientX)
    showCursor(s)
    onHover?.(s)
  })
  plot.addEventListener('pointerleave', () => {
    showCursor(null)
    onHover?.(null)
  })

  const ro = new ResizeObserver(() => render())
  ro.observe(plot)

  return {
    element: wrap,

    setSegments(segs) {
      segments = segs.filter((s) => s.lengthM > 0)
      samples = buildSamples(segments)
      render()
    },

    /** 프로필이 그릴 수 있는 상태인지 */
    get empty() {
      return samples.length < 2
    },
  }
}
