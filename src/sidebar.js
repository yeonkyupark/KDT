import { DIFFICULTY_COLOR, formatDuration } from './map.js'
import { difficultyOf } from './metrics.js'

/** 공식 등급 숫자 → 라벨 */
const LEVEL_LABEL = { 1: '쉬움', 2: '보통', 3: '어려움' }

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

/**
 * 사이드바 — 시작/종료 코스 선택, 구간 요약, 코스 목록.
 *
 * 모바일에서는 하단 시트가 된다. 손잡이를 눌러 3단(요약만 / 선택까지 / 목록까지)으로 접힌다.
 * 드래그 제스처는 넣지 않았다 — 탭만으로 세 상태를 다 갈 수 있고 코드가 훨씬 적다.
 */
/**
 * @param {Array} courses  본선 코스 — 시작/종료 선택, 요약, 목록
 * @param {Array} opts.subs  지선·우회로 — 구간과 겹치면 목록 아래 따로 보여 준다(합계에 넣지 않는다)
 */
export function createSidebar(
  root,
  courses,
  { onRangeChange, onPick, onHover, subs = [], subInRange = () => false, groups = [] } = {},
) {
  const maxSeq = Math.max(...courses.map((c) => c.seq))

  const panel = el('aside', 'panel')
  panel.id = 'sidepanel' // 상단바 접기 버튼의 aria-controls 대상

  // ── 손잡이 (모바일 전용) ─────────────────────────────
  const handle = el('button', 'sheet-handle')
  handle.type = 'button'
  handle.setAttribute('aria-label', '패널 펼치기/접기')
  handle.append(el('span', 'grip'))
  const handleLabel = el('span', 'sheet-label')
  handle.append(handleLabel)
  panel.append(handle)

  const body = el('div', 'panel-body')
  panel.append(body)

  // ── 코스 선택 ────────────────────────────────────────
  const picker = el('div', 'picker')
  const mkSelect = (labelText) => {
    const wrap = el('label', 'field')
    wrap.append(el('span', 'field-label', labelText))
    const sel = el('select')
    for (const c of courses) {
      const opt = document.createElement('option')
      opt.value = String(c.seq)
      opt.textContent = `${c.seq}. ${c.region || '—'}`
      sel.append(opt)
    }
    wrap.append(sel)
    picker.append(wrap)
    return sel
  }
  const fromSel = mkSelect('시작 코스')
  const toSel = mkSelect('종료 코스')

  const resetBtn = el('button', 'reset-btn', '전체 구간')
  resetBtn.type = 'button'
  picker.append(resetBtn)
  body.append(picker)

  // ── 구간 요약 ────────────────────────────────────────
  const summary = el('div', 'sum')
  body.append(summary)

  // ── 코스 목록 ────────────────────────────────────────
  const listWrap = el('div', 'list-wrap')
  const listHead = el('div', 'list-head')
  listWrap.append(listHead)
  const list = el('ul', 'course-list')
  listWrap.append(list)
  // 지선·우회로 (있는 길만)
  const subHead = el('div', 'list-head sub-head')
  const subList = el('ul', 'course-list sub-list')
  listWrap.append(subHead, subList)
  body.append(listWrap)

  // 사진·메모 섹션은 notes.js 가 채운다 (자리만 만들어 둔다)
  const notesHost = el('div', 'notes-section')
  body.append(notesHost)

  root.append(panel)

  // ── 상태 ─────────────────────────────────────────────
  let range = { from: 1, to: maxSeq }
  let sheet = 1 // 0 요약만 / 1 선택까지 / 2 목록까지
  const SHEET_CLASS = ['is-peek', 'is-half', 'is-full']
  const SHEET_LABEL = ['펼치기', '목록 보기', '접기']

  function applySheet() {
    panel.classList.remove(...SHEET_CLASS)
    panel.classList.add(SHEET_CLASS[sheet])
    handleLabel.textContent = SHEET_LABEL[sheet]
  }
  handle.onclick = () => {
    sheet = (sheet + 1) % 3
    applySheet()
  }
  applySheet()

  function inRange(c) {
    return c.seq >= range.from && c.seq <= range.to
  }

  function renderSummary() {
    summary.textContent = ''

    const sel = courses.filter(inRange)

    // 반올림된 distanceKm 을 더하면 90개에서 0.5km 어긋난다. 원시 미터로 합산한다.
    const km = sel.reduce((s, c) => s + (c.distanceM ?? c.distanceKm * 1000), 0) / 1000
    const min = sel.reduce((s, c) => s + c.durationMin, 0)
    const up = sel.reduce((s, c) => s + c.ascentM, 0)
    const down = sel.reduce((s, c) => s + c.descentM, 0)
    // 코스별 난이도가 공식 등급이므로, 구간 평균도 그 등급(1/2/3)의 평균으로 낸다.
    // 거리·상승으로 다시 계산하면 개별 코스에 표시된 난이도와 어긋난다.
    const levels = sel.map((c) => c.difficultyLevel).filter((n) => n > 0)
    const label = levels.length
      ? LEVEL_LABEL[Math.round(levels.reduce((a, b) => a + b, 0) / levels.length)] ?? '보통'
      : difficultyOf(km / Math.max(sel.length, 1), up / Math.max(sel.length, 1))

    const rows = [
      ['코스', `${sel.length}개`],
      ['거리', `${km.toFixed(1)} km`],
      ['예상 소요', min >= 600 ? `약 ${Math.round(min / 60)}시간` : formatDuration(min)],
      ['누적 상승', `${up.toLocaleString()} m`],
      ['누적 하강', `${down.toLocaleString()} m`],
      ['평균 난이도', label],
    ]
    for (const [k, v] of rows) {
      const r = el('div', 'sum-row')
      r.append(el('span', 'k', k), el('span', 'v', v))
      summary.append(r)
    }

    summary.append(el('div', 'sum-note', '고도는 DEM 추정값 · 노선·난이도·소요시간은 공식(두루누비) 기준'))
  }

  function renderList() {
    list.textContent = ''
    const sel = courses.filter(inRange).sort((a, b) => a.seq - b.seq)
    listHead.textContent = `구간 코스 ${sel.length}개`
    for (const c of sel) list.append(courseItem(c))

    subList.textContent = ''
    const near = subs.filter((c) => subInRange(c, range)).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    subHead.hidden = subList.hidden = near.length === 0
    if (near.length) {
      const km = near.reduce((s, c) => s + (c.distanceM ?? c.distanceKm * 1000), 0) / 1000
      const kinds = new Set(near.map((c) => (c.kind === 'detour' ? '우회로' : '지선')))
      subHead.textContent = `${[...kinds].join('·')} ${near.length}개 · ${km.toFixed(1)} km (구간 합계에 넣지 않음)`
      for (const c of near) subList.append(courseItem(c))
    }
  }

  function courseItem(c) {
    const li = el('li', 'course-item' + (c.kind && c.kind !== 'main' ? ' is-sub' : ''))

    const dot = el('i', 'dot')
    dot.style.background = DIFFICULTY_COLOR[c.difficulty] ?? '#8b8f98'

    const num = el('span', 'ci-num', c.kind && c.kind !== 'main' ? c.id : String(c.seq))

    const mid = el('span', 'ci-mid')
    mid.append(el('span', 'ci-name', c.name))
    mid.append(
      el('span', 'ci-route', c.start && c.end ? `${c.start} → ${c.end}` : '지점명 정보 없음'),
    )

    const right = el('span', 'ci-right')
    right.append(el('span', 'ci-km', `${c.distanceKm} km`))
    right.append(el('span', 'ci-up', `↑${c.ascentM.toLocaleString()}`))

    li.append(dot, num, mid, right)
    li.onclick = () => onPick?.(c)
    li.onmouseenter = () => onHover?.(c.id, true)
    li.onmouseleave = () => onHover?.(c.id, false)
    return li
  }

  function syncSelects() {
    fromSel.value = String(range.from)
    toSel.value = String(range.to)
    resetBtn.disabled = range.from === 1 && range.to === maxSeq

    // 종료 코스 목록에서 시작보다 앞선 코스를 못 고르게 한다.
    // 고르면 조용히 시작/종료가 뒤바뀌는데, 그게 더 놀랍다.
    for (const opt of toSel.options) opt.disabled = Number(opt.value) < range.from
  }

  function commit(next, { notify = true } = {}) {
    range = { from: Math.min(next.from, next.to), to: Math.max(next.from, next.to) }
    syncSelects()
    renderSummary()
    renderList()
    if (notify) onRangeChange?.({ ...range })
  }

  fromSel.onchange = () => {
    // 시작 코스를 바꾸면 종료 코스도 같은 코스로 맞춘다.
    // 종료가 90에 남아 있으면 원하는 종료 코스까지 목록을 한참 스크롤해야 한다.
    // 시작에 붙여두면 그 다음 선택이 바로 근처에서 끝난다.
    const from = Number(fromSel.value)
    commit({ from, to: from })
  }
  toSel.onchange = () => commit({ from: range.from, to: Number(toSel.value) })
  resetBtn.onclick = () => commit({ from: 1, to: maxSeq })

  return {
    maxSeq,
    notesHost,
    setRange: (from, to, opts) => commit({ from, to }, opts),
    getRange: () => ({ ...range }),
    /** 모바일에서 코스를 고르면 시트를 접어 지도를 보여준다. */
    collapse() {
      if (sheet !== 0) {
        sheet = 0
        applySheet()
      }
    },
  }
}
