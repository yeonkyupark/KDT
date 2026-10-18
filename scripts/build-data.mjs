/**
 * 단계 2b — GPX + 고도 캐시 → public/data/
 *
 * 브라우저는 GPX를 절대 파싱하지 않는다. 여기서 한 번 구워둔 JSON만 받는다.
 * 켜진(enabled) 길마다 따로 만든다. 화면은 한 번에 한 길만 받는다.
 *
 * 산출물
 *   public/data/trails.json               길 목록 · 합계 · 출처 · 길 사이 연결 (화면이 맨 먼저 받는다)
 *   public/data/<길>/courses.json         코스 메타 + 저해상도 오버뷰 라인
 *   public/data/<길>/course/{id}.json     상세 라인 + 고도 프로필 (코스 선택 시 lazy fetch)
 *   public/data/<길>/meta.json            생성 정보 · 출처 · 합계
 *   public/data/courses.json, meta.json, course/   남파랑길 사본 — 옛 경로를 읽는 캐시된 앱과
 *                                                   옛 MCP 서버 사본(README 설치 방법)이 깨지지 않게 둔다
 *
 * 사용법: node scripts/build-data.mjs   (npm run build:data)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { listCourses, parseGpx, sourceSha1 } from './lib/gpx.mjs'
import { chainFill, normalizeJunctions, normalizeRegions } from './lib/names.mjs'
import { parseTravelerInfo, parseStampAndAccess, cleanText } from './lib/durunubi.mjs'
import { TRAILS, listUrl } from './lib/trails.mjs'
import { pathLength, simplify, movingAverage, ascentDescent, haversine } from './lib/geo.mjs'
import {
  ELE_SPACING,
  ELE_DATASET,
  ELE_SMOOTH_WINDOW,
  ELE_THRESHOLD_M,
  SIMPLIFY_OVERVIEW_M,
  SIMPLIFY_DETAIL_M,
  WALK_SPEED_KMH,
  ASCENT_SPEED_MH,
  DIFFICULTY_BREAKS,
} from './lib/config.mjs'

const ELE_CACHE = 'data/cache/ele'
const OUT_ROOT = 'public/data'

/** 이 거리 안에서 두 길의 끝점이 만나면 "이어지는 길"로 안내한다. */
const LINK_M = 1000

/** 지선 묶음의 시점·종점이 본선 선에서 이 거리 안이면 그 코스에서 갈라지고(합류하고) 있다고 본다. */
const BRANCH_M = 1000

/**
 * 하위 번호 코스의 종류. 공식 이름의 부제로 가른다.
 *   '64-1코스(지선1코스)', '4-1코스(지선코스)' → spur (지선: 본선 밖으로 따로 나가는 길)
 *   '2-1코스(우회로)'                           → detour (우회로: 본선 일부를 대신 걷는 길)
 */
const kindOf = (c) => (!c.sub ? 'main' : /우회/.test(c.label ?? '') ? 'detour' : 'spur')

/** 점에서 가장 가까운 본선 코스와 그 거리. */
function nearestMain(mains, p) {
  let best = null
  for (const m of mains) {
    for (const q of m.detail) {
      const d = haversine(p, q)
      if (!best || d < best.distM) best = { course: m, distM: d }
    }
  }
  return best
}

/** 앞 하위 코스 종점과 다음 하위 코스 시점이 이 거리 안이면 한 묶음(이어진 길)이다. */
const RUN_M = 50

/**
 * 하위 번호 코스를 **실제로 이어진 것끼리** 묶는다. 번호가 같아야 묶이는 게 아니다.
 *   서해랑길 64-1~64-6               (같은 번호, 접합부 0~2m)
 *   DMZ 평화의 길 30-1·30-2·31-1·32-1·33-1  (번호를 넘나들며 이어진 우회로, 접합부 0~5m)
 * 번호 순으로 늘어놓고 앞 코스 종점 ↔ 다음 코스 시점이 RUN_M 안이면 이어 붙인다.
 */
function subRunsOf(built) {
  const subs = built.filter((c) => c.sub).sort((a, b) => a.seq - b.seq || a.sub - b.sub)
  const runs = []
  for (const c of subs) {
    const run = runs.at(-1)
    const prev = run?.at(-1)
    if (prev && haversine(prev.detail.at(-1), c.detail[0]) <= RUN_M) run.push(c)
    else runs.push([c])
  }
  return runs
}

/**
 * 묶음의 시점·종점이 본선 어느 코스에 닿는지 좌표로 잰다. 닿지 않으면(BRANCH_M 초과) null.
 * 한쪽만 닿는 묶음도 있다(DMZ 평화의 길 4-1 지선은 종점만 4코스에 닿는다).
 */
function groupSubs(built, runs) {
  const mains = built.filter((c) => !c.sub)
  const groups = []
  for (const list of runs) {
    const seq = list[0].seq
    const a = nearestMain(mains, list[0].detail[0])
    const b = nearestMain(mains, list.at(-1).detail.at(-1))
    const at = (n) => (n && n.distM <= BRANCH_M ? { courseId: n.course.id, seq: n.course.seq, distM: Math.round(n.distM) } : null)
    groups.push({
      seq,
      // 묶음 안에 우회로가 하나라도 있으면 우회로 묶음이다
      kind: list.some((c) => c.kind === 'detour') ? 'detour' : 'spur',
      ids: list.map((c) => c.id),
      from: at(a),
      to: at(b),
      lengthM: list.reduce((s, c) => s + c.lengthM, 0),
      ascentM: list.reduce((s, c) => s + c.ascentM, 0),
      durationMin: list.reduce((s, c) => s + (c.durationMin ?? 0), 0),
      // 분기·합류를 못 찾았을 때 경고에 쓴다
      fromDistM: Math.round(a?.distM ?? Infinity),
      toDistM: Math.round(b?.distM ?? Infinity),
    })
  }
  return groups
}

/** CSV 로 덮어쓸 수 있는 필드. 여기 없는 열은 무시된다. */
const OVERRIDE_FIELDS = [
  'name',
  'region',
  'start',
  'end',
  'startAddr',
  'startAccess',
  'endAddr',
  'endAccess',
  'difficulty',
  'alias',
  'note',
]

const r5 = (n) => Math.round(n * 1e5) / 1e5 // 좌표 소수점 5자리 ≈ 1m
const r1 = (n) => Math.round(n * 10) / 10

/**
 * CSV 한 줄을 따옴표까지 처리해 쪼갠다.
 *
 * `line.split(',')` 로는 안 된다. 교통편처럼 값 안에 콤마가 있는 항목
 * (`경성대부경대역 24번 버스, 오륙도스카이워크 하차`)이 **경고도 없이 잘린다.**
 * 값에 콤마가 있으면 `"..."` 로 감싸고, 값 안의 따옴표는 `""` 로 쓴다.
 */
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch !== '"') cur += ch
      else if (line[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** 수기 보정 CSV를 읽는다. 빈 칸은 덮어쓰지 않는다. 파일이 없으면 보정 없음. */
function loadOverrides(path) {
  if (!path || !existsSync(path)) return new Map()
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (lines.length === 0) return new Map()

  const cols = parseCsvLine(lines[0]).map((s) => s.trim())
  const map = new Map()
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const row = {}
    cols.forEach((c, i) => {
      const v = (cells[i] ?? '').trim()
      if (v) row[c] = v
    })
    if (row.id) map.set(String(row.id), row)
  }
  return map
}

/**
 * 두루누비(한국관광공사) 공식 코스 기록을 코스 번호로 색인한다.
 * `npm run sync:durunubi` 가 공공 API(+사이트 목록 보충)에서 받아 쓴 manifest 다.
 *
 * 난이도와 소요시간은 **공식값을 쓴다.** 운영기관이 매긴 등급이 내가 만든
 * 공식(거리 + 상승/100)보다 신뢰도가 높다 — 실제로 90개 중 41개만 일치했다.
 * 거리는 GPX 실측값을 쓴다: 지도에 그리는 선과 숫자가 어긋나면 안 된다.
 * 노선도 공식 GPX 라 남파랑길은 90개 중 86개가 공식 표기 거리와 5% 안쪽이다 (가장 큰 차이 약 6%).
 */
function loadOfficial(trail) {
  const path = trail.manifest
  if (!existsSync(path)) throw new Error(`${path} 가 없다. 먼저 npm run sync:durunubi 를 실행하라.`)
  const map = new Map()
  for (const r of JSON.parse(readFileSync(path, 'utf8')).courses) {
    map.set(r.sub ? `${r.seq}-${r.sub}` : String(r.seq), {
      crsIdx: r.crsIdx,
      km: r.km,
      min: r.minutes,
      level: r.level, // 1 쉬움 / 2 보통 / 3 어려움
      levelLabel: r.levelLabel,
      sigun: r.sigun,
      label: r.label ?? '',
      siteStartAddr: r.startAddress ?? '',
      siteEndAddr: r.endAddress ?? '',
      // 두루누비 코스 공지(통행 제한·우회 안내). 매주 동기화로 바뀐다
      warning: r.warning ?? '',
      cautions: trail.cautions ? cautionLines(r.travelerInfo) : [],
      ...parseTravelerInfo(r.travelerInfo),
      ...parseStampAndAccess(r.travelerInfo),
    })
  }
  return map
}

/**
 * 여행자정보에서 출입 통제·신분증·예약 같은 안내 줄만 뽑는다. DMZ 평화의 길은 민간인 통제구역이 많다.
 *   '- 강화 평화전망대에서 6.25 참전용사기념공원까지는 민간인 통제구역이므로 신분증을 지참해야 한다'
 */
const CAUTION_RE = /(민간인\s*통제|민통선|통제구역|신분증|출입\s*(신고|통제|금지|허가|불가)|예약|군사|검문소|통행\s*(금지|제한|불가))/
function cautionLines(text) {
  return cleanText(text)
    .split('\n')
    .map((l) => l.replace(/^[-*·.\s]+/, '').trim()) // '.- 예약이 …' 처럼 앞에 점이 붙은 줄도 있다
    .filter((l) => l && CAUTION_RE.test(l))
}

/**
 * 주소를 지점 표기로 줄인다. 지점명이 공식 자료에 없을 때만 쓴다.
 *   '부산광역시 기장군 기장읍 대변리 203-22' → '기장읍 대변리'
 *   '부산광역시 남구 용호동 산196-10'        → '용호동'
 */
function placeFromAddr(addr) {
  const tokens = String(addr ?? '').split(/\s+/).filter((t) => t && !/\d/.test(t))
  const local = tokens.filter((t) => /(읍|면|동|리|가)$/.test(t)).slice(-2)
  return (local.length ? local : tokens.slice(-2)).join(' ')
}

/**
 * 공식 기록의 시점·종점·지역을 코스 필드로 옮긴다. 값이 없으면 비워 두고 연쇄 보정·CSV 에 맡긴다.
 *
 * 남파랑길은 여행자정보에 "- 시점 : 이름 (주소) / 교통편)" 이 있다.
 * 해파랑길은 그 줄이 없다. 주소는 사이트 목록의 시·종점 주소, 교통편은 여행자정보의 교통 줄
 * (코스 시점까지 가는 방법)을 쓰고, 지점명은 주소를 줄여 채운다(출처 'addr').
 */
function officialPlaces(off) {
  if (!off) return {}
  // 사이트 주소는 여행자정보에 시점·종점 줄이 아예 없을 때만 쓴다. 줄은 있는데 주소만 빠진
  // 경우(남파랑길 12코스 '암아교차로')는 지금처럼 이웃 코스에서 연쇄로 채운다.
  const startAddr = (off.start ? off.start.addr : off.siteStartAddr) || ''
  const endAddr = (off.end ? off.end.addr : off.siteEndAddr) || ''
  const p = {
    region: off.sigun || '',
    start: off.start?.name || '',
    startAddr,
    startAccess: off.start?.access || (off.start ? '' : off.access) || '',
    end: off.end?.name || '',
    endAddr,
    endAccess: off.end?.access || '',
  }
  if (!p.start && startAddr) {
    p.start = placeFromAddr(startAddr)
    p.startSource = 'addr'
  }
  if (!p.end && endAddr) {
    p.end = placeFromAddr(endAddr)
    p.endSource = 'addr'
  }
  return p
}

function difficultyOf(km, ascentM) {
  const score = km + ascentM / 100
  return { score: r1(score), label: DIFFICULTY_BREAKS.find((b) => score <= b.max).label }
}

/**
 * 고도 프로필의 저해상도 요약. courses.json 에 실어 보낸다.
 *
 * 전 구간(90개) 프로필을 그리려면 코스별 상세 파일 92개(745KB)가 필요하다.
 * 하지만 1,464km를 800px에 그리면 픽셀당 1.8km라 32점이면 충분하다.
 * 구간을 좁히면 상세 파일이 도착해 고해상도로 교체된다.
 *
 * 버킷 평균을 쓰므로 좁은 봉우리는 뭉개진다 — 개요용이라는 뜻이다.
 */
function lowResProfile(values, n = 32) {
  if (values.length <= n) return values.map((v) => Math.round(v))
  const out = []
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * values.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n))
    let sum = 0
    for (let j = a; j < b; j++) sum += values[j]
    out.push(Math.round(sum / (b - a)))
  }
  return out
}

/** 네이스미스 규칙 변형. GPX <time> 은 편집 시각이라 쓰지 않는다. */
function durationMin(km, ascentM) {
  const min = (km / WALK_SPEED_KMH) * 60 + (ascentM / ASCENT_SPEED_MH) * 60
  return Math.round(min / 10) * 10
}

/** 길 하나를 빌드해 public/data/<길>/ 에 쓴다. trails.json 에 넣을 요약을 돌려준다. */
function buildTrail(trail) {
  const outDir = join(OUT_ROOT, trail.id)
  const outCourse = join(outDir, 'course')
  const courses = listCourses(trail)
  const overrides = loadOverrides(trail.metaCsv)
  const official = loadOfficial(trail)

  // ── 1. GPX 파싱 + 고도 캐시 결합 ─────────────────────────
  const built = []
  const warnings = []

  for (const c of courses) {
    const { name, points, nonstandard, duplicateTracks } = parseGpx(c.path)
    if (nonstandard) warnings.push(`${c.file}: 비표준 세그먼트 태그 (파서가 흡수)`)
    if (duplicateTracks) warnings.push(`${c.file}: 같은 노선 트랙 ${duplicateTracks + 1}개 — 첫 트랙만 사용`)

    const latlng = points.map((p) => [p.lat, p.lng])
    const lengthM = pathLength(latlng)

    const cachePath = join(ELE_CACHE, `${c.key}.json`)
    if (!existsSync(cachePath)) {
      throw new Error(`${c.file}: 고도 캐시가 없다. 먼저 npm run build:ele -- --trail=${trail.id} 를 실행하라.`)
    }
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    // 다른 GPX(예: 교체 전 노선)로 만든 캐시면 고도 프로필이 선과 맞지 않는다.
    if (cache.sourceSha1 !== sourceSha1(c.path)) {
      throw new Error(`${c.file}: 고도 캐시가 이 GPX 에서 나온 것이 아니다. npm run build:ele 를 다시 실행하라.`)
    }
    if (cache.ele.some((v) => v == null)) warnings.push(`${c.file}: 고도 null 포함`)

    const smooth = movingAverage(cache.ele, ELE_SMOOTH_WINDOW)
    const { ascentM, descentM } = ascentDescent(smooth, ELE_THRESHOLD_M)
    const off = official.get(c.id)

    built.push({
      ...c,
      trackName: name,
      // 지점명·주소·교통편·지역은 공식 자료에서. 틀린 곳만 아래 CSV 가 고친다.
      ...officialPlaces(off),
      label: off?.label ?? '',
      kind: kindOf({ sub: c.sub, label: off?.label }),
      warning: off?.warning ?? '',
      cautions: off?.cautions ?? [],
      stamp: off?.stamp ?? null,
      lengthM,
      km: r1(lengthM / 1000),
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      eleMin: Math.round(Math.min(...smooth)),
      eleMax: Math.round(Math.max(...smooth)),
      eleProfile: smooth.map(r1),
      eleDist: cache.dist,
      overview: simplify(latlng, SIMPLIFY_OVERVIEW_M),
      detail: simplify(latlng, SIMPLIFY_DETAIL_M),
      rawPoints: latlng.length,
      bbox: [
        r5(Math.min(...latlng.map((p) => p[1]))),
        r5(Math.min(...latlng.map((p) => p[0]))),
        r5(Math.max(...latlng.map((p) => p[1]))),
        r5(Math.max(...latlng.map((p) => p[0]))),
      ],
      startLatLng: [r5(latlng[0][0]), r5(latlng[0][1])],
      endLatLng: [r5(latlng.at(-1)[0]), r5(latlng.at(-1)[1])],
    })
  }

  // ── 2. 지점명 보정 ───────────────────────────────────────
  // "앞 코스 종점 = 다음 코스 시점" 은 본선에만 성립한다. 지선·우회로는 자기 시종점을 그대로 쓴다.
  const mains = built.filter((c) => !c.sub)
  // 이어진 하위 코스 묶음(서해랑길 64-1~64-6 등) 안에서만 연쇄로 채운다
  const subRuns = subRunsOf(built)
  for (const run of subRuns) chainFill(run)
  const chained = chainFill(mains)
  const junctions = normalizeJunctions(mains)
  const regionFixes = normalizeRegions(built)

  // CSV 덮어쓰기는 맨 마지막 (수기 보정이 최우선)
  let overridden = 0
  for (const c of built) {
    const o = overrides.get(c.id)
    if (!o) continue
    for (const k of OVERRIDE_FIELDS) {
      if (o[k]) {
        c[k] = o[k]
        c[`${k}Source`] = 'csv'
      }
    }
    overridden++
  }

  // CSV 를 적용한 뒤 연쇄 보정을 **다시** 돌린다.
  // 이게 없으면 1코스 종점에 '부산역'을 적어도 2코스 시점은 여전히 비어 있어,
  // 접합부마다 같은 값을 두 번씩 적어야 한다(89곳 중복 입력).
  // chainFill 은 빈 값만 채우므로 CSV 값을 덮어쓸 위험이 없다.
  const chainedAfterCsv = chainFill(mains)
  const regionsAfterCsv = normalizeRegions(built)

  // ── 3. 파생 지표 ─────────────────────────────────────────
  for (const c of built) {
    const off = official.get(c.id)

    // 우리 계산값은 참고용으로 남겨둔다 (공식값이 빠진 코스의 대비책도 된다)
    const computed = difficultyOf(c.km, c.ascentM)
    c.difficultyScore = computed.score
    c.naismithMin = durationMin(c.km, c.ascentM)

    // 난이도·소요시간은 공식값 우선. CSV 수기 보정이 있으면 그게 최우선.
    if (!c.difficulty) c.difficulty = off?.levelLabel || computed.label
    c.difficultyLevel = off?.level ?? DIFFICULTY_BREAKS.findIndex((b) => b.label === c.difficulty) + 1
    c.durationMin = off?.min ?? c.naismithMin
    c.durationSource = off?.min ? 'official' : 'computed'

    // 공식 거리는 표시용 참고값. 지도 선과 일치해야 하므로 distanceKm 은 우리 값을 쓴다.
    c.officialKm = off?.km ?? null

    if (!c.name) c.name = `${c.id}코스`
  }

  // 지선·우회로 묶음: 어느 본선 코스에서 갈라져 어디로 합류하는가
  const groups = groupSubs(built, subRuns)
  for (const g of groups) {
    // 한쪽만 닿는 묶음은 있을 수 있다(막다른 지선). 양쪽 다 못 찾으면 좌표가 잘못된 것이다
    if (!g.from && !g.to) {
      warnings.push(`${g.ids.join('·')}: 본선과 닿는 곳을 못 찾았다 (시점 ${g.fromDistM}m · 종점 ${g.toDistM}m, 기준 ${BRANCH_M}m)`)
    }
    for (const id of g.ids) {
      const c = built.find((x) => x.id === id)
      c.group = { ids: g.ids, from: g.from, to: g.to }
    }
  }

  // ── 4. 출력 ──────────────────────────────────────────────
  if (existsSync(outCourse)) rmSync(outCourse, { recursive: true })
  mkdirSync(outCourse, { recursive: true })

  const index = built.map((c) => ({
    id: c.id,
    seq: c.seq,
    // 옛 MCP 서버 사본(README 의 설치 방법)이 이 필드로 본선만 고른다
    isAlt: c.kind !== 'main',
    // main 본선 · spur 지선 · detour 우회로. 구간 선택·합계·고도 프로필은 본선만 쓴다
    kind: c.kind,
    // 지선·우회로 묶음: 같은 번호의 하위 코스들과, 갈라지는(from)·합류하는(to) 본선 코스. 본선은 없다
    group: c.group ?? undefined,
    name: c.name,
    // 공식 코스명의 부제 (예: '영덕 블루로드 1, 2코스', '바우길 09구간')
    label: c.label || '',
    region: c.region || '',
    start: c.start || '',
    end: c.end || '',
    // 'addr' 이면 지점명이 공식 자료에 없어 주소를 줄여 쓴 것이다
    startSource: c.startSource === 'addr' ? 'addr' : undefined,
    endSource: c.endSource === 'addr' ? 'addr' : undefined,
    startAddr: c.startAddr || '',
    startAccess: c.startAccess || '',
    endAddr: c.endAddr || '',
    endAccess: c.endAccess || '',
    // 코리아둘레길 스탬프함 위치 (해파랑길 여행자정보). 없으면 null
    stamp: c.stamp || null,
    // 두루누비 코스 공지(통행 제한·우회 안내 등). 없으면 빈 문자열
    warning: c.warning || '',
    // 여행자정보 중 출입 통제·신분증·예약 안내 줄 (DMZ 평화의 길)
    cautions: c.cautions?.length ? c.cautions : undefined,
    alias: c.alias || '',
    note: c.note || '',
    distanceKm: c.km,
    // 구간 합계용. distanceKm(반올림값)을 더하면 오차가 쌓인다.
    distanceM: Math.round(c.lengthM),
    durationMin: c.durationMin,
    ascentM: c.ascentM,
    descentM: c.descentM,
    eleMin: c.eleMin,
    eleMax: c.eleMax,
    difficulty: c.difficulty,
    difficultyLevel: c.difficultyLevel,
    durationSource: c.durationSource,
    naismithMin: c.naismithMin,
    officialKm: c.officialKm,
    bbox: c.bbox,
    startLatLng: c.startLatLng,
    endLatLng: c.endLatLng,
    overview: c.overview.map((p) => [r5(p[0]), r5(p[1])]),
    // 전 구간 고도 프로필을 상세 파일 없이도 그릴 수 있게 하는 요약
    eleLow: lowResProfile(c.eleProfile),
  }))

  writeFileSync(join(outDir, 'courses.json'), JSON.stringify(index))

  for (const c of built) {
    writeFileSync(
      join(outCourse, `${c.id}.json`),
      JSON.stringify({
        id: c.id,
        line: c.detail.map((p) => [r5(p[0]), r5(p[1])]),
        ele: { spacing: ELE_SPACING, dataset: ELE_DATASET, dist: c.eleDist, values: c.eleProfile },
      }),
    )
  }

  // 합계는 본선만. 지선·우회로는 groups 에 따로 담는다
  const totalKm = r1(mains.reduce((s, c) => s + c.lengthM, 0) / 1000)
  const totalAscentM = mains.reduce((s, c) => s + c.ascentM, 0)
  const groupsOut = groups.map(({ fromDistM, toDistM, lengthM, ...g }) => ({ ...g, km: r1(lengthM / 1000) }))
  writeFileSync(
    join(outDir, 'meta.json'),
    JSON.stringify(
      {
        generatedAt: GENERATED_AT,
        trail: trail.id,
        trailName: trail.name,
        courseCount: built.length,
        mainCourseCount: mains.length,
        // 지선·우회로 묶음 (본선 합계에 들어가지 않는다)
        groups: groupsOut,
        // 코스별 반올림값을 더하면 오차가 쌓인다. 원시 미터로 합산한 뒤 반올림한다.
        totalKm,
        totalAscentM,
        elevation: {
          source: `${ELE_DATASET} (opentopodata)`,
          note: 'DEM 추정값. 공식 GPX 의 고도는 코스마다 누락·0값이 있어 쓰지 않는다.',
          spacing: ELE_SPACING,
          smoothWindow: ELE_SMOOTH_WINDOW,
          thresholdM: ELE_THRESHOLD_M,
        },
        duration: {
          note: '두루누비(한국관광공사) 공식 권장 소요시간.',
          naismithNote: '참고용 계산값은 naismithMin 에 함께 담았다.',
          walkSpeedKmh: WALK_SPEED_KMH,
          ascentSpeedMh: ASCENT_SPEED_MH,
        },
        // 난이도 경계를 클라이언트에 중복 정의하지 않도록 실어 보낸다.
        // JSON에는 Infinity가 없어서 마지막 max 는 null 로 직렬화된다.
        difficulty: {
          source: '두루누비(한국관광공사) 공식 등급',
          formula: '참고용 계산값(difficultyScore): 거리km + 상승m/100',
          breaks: DIFFICULTY_BREAKS,
        },
        official: {
          source: `두루누비 — ${listUrl(trail)}`,
          license: '공공누리 제4유형 (출처표시 + 상업적이용금지 + 변경금지)',
          note: '난이도·소요시간은 공식값. 거리는 지도 선과 맞추기 위해 GPX 실측값을 쓴다.',
        },
        source: {
          gpx: `두루누비(한국관광공사) 코스별 공식 GPX — ${listUrl(trail)}`,
          license: '공공누리 제4유형 (출처표시 + 상업적이용금지 + 변경금지)',
          detail: 'data/SOURCE.md',
        },
      },
      null,
      1,
    ),
  )

  // ── 5. 리포트 ────────────────────────────────────────────
  const sum = (f) => mains.reduce((s, c) => s + f(c), 0)
  const size = (p) => (readFileSync(p).length / 1024).toFixed(1) + 'KB'
  const courseDirKB = built.reduce((s, c) => s + readFileSync(join(outCourse, `${c.id}.json`)).length, 0)

  console.log(`\n# ${trail.name} — 본선 ${mains.length}개${groups.length ? ` + 지선·우회로 ${built.length - mains.length}개` : ''}\n`)
  for (const g of groupsOut) {
    const where = (x) => (x ? `${x.seq}코스(${x.distM}m)` : '없음')
    console.log(`  ${g.kind === 'detour' ? '우회로' : '지선'} ${g.ids[0]}${g.ids.length > 1 ? `~${g.ids.at(-1)}` : ''}  ${g.km} km · 갈라짐 ${where(g.from)} → 합류 ${where(g.to)}`)
  }
  console.log('합계 (본선)')
  console.log(`  거리        ${r1(sum((c) => c.lengthM) / 1000).toLocaleString()} km`)
  console.log(`  누적 상승   ${sum((c) => c.ascentM).toLocaleString()} m  (${(sum((c) => c.ascentM) / sum((c) => c.km)).toFixed(1)} m/km)`)
  console.log(`  예상 시간   ${Math.round(sum((c) => c.durationMin) / 60).toLocaleString()} 시간`)
  const diff = {}
  for (const c of built) diff[c.difficulty] = (diff[c.difficulty] ?? 0) + 1
  console.log(`  난이도      ${Object.entries(diff).map(([k, v]) => `${k} ${v}`).join(' / ')}`)

  console.log('\n좌표 단순화')
  console.log(`  원본        ${sum((c) => c.rawPoints).toLocaleString()}점`)
  console.log(`  오버뷰 ε${SIMPLIFY_OVERVIEW_M}m  ${sum((c) => c.overview.length).toLocaleString()}점 (코스당 평균 ${Math.round(sum((c) => c.overview.length) / mains.length)})`)
  console.log(`  상세   ε${SIMPLIFY_DETAIL_M}m   ${sum((c) => c.detail.length).toLocaleString()}점 (코스당 평균 ${Math.round(sum((c) => c.detail.length) / mains.length)})`)

  console.log('\n지점명')
  console.log(`  연쇄 보정   시점 ${chained.start} · 종점 ${chained.end} · 지역 ${chained.region}`)
  console.log(`  접합부 통일 ${junctions.length}곳`)
  for (const j of junctions) {
    // 자동 통일 뒤에 CSV가 다시 덮어썼을 수 있으므로 최종값을 보여준다
    const final = built.find((c) => c.seq === j.seq)?.end
    const tag = final !== j.to ? `  (CSV가 재교정: "${final}")` : ''
    console.log(`      ${j.seq}/${j.seq + 1}  "${j.from}" -> "${j.to}"${tag}`)
  }
  if (regionFixes.length) {
    console.log(`  지역 통일   ${regionFixes.map((f) => `${f.from}->${f.to}`).join(', ')}`)
  }
  console.log(`  CSV 보정    ${overridden}개 코스`)
  console.log(
    `  CSV 후 연쇄 시점 ${chainedAfterCsv.start} · 종점 ${chainedAfterCsv.end}` +
      (regionsAfterCsv.length ? ` · 지역 ${regionsAfterCsv.length}` : ''),
  )
  const fromAddr = built.filter((c) => c.startSource === 'addr' || c.endSource === 'addr').length
  if (fromAddr) console.log(`  주소로 쓴 지점명 ${fromAddr}개 코스 (공식 지점명 없음)`)
  const withAccess = built.filter((c) => c.startAccess || c.endAccess).length
  if (withAccess) console.log(`  교통편 정보  ${withAccess}개 코스`)
  const noPlace = built.filter((c) => !c.start || !c.end)
  console.log(`  지점명 미확인 ${noPlace.length}개: ${noPlace.map((c) => c.id).join(',') || '없음'}`)
  const noRegion = built.filter((c) => !c.region)
  if (noRegion.length) console.log(`  지역 미확인 ${noRegion.length}개: ${noRegion.map((c) => c.id).join(',')}`)

  console.log('\n산출물')
  console.log(`  ${trail.id}/courses.json   ${size(join(outDir, 'courses.json'))}   <- 그 길을 고르면 이것만 받는다`)
  console.log(`  ${trail.id}/course/*.json  ${(courseDirKB / 1024).toFixed(1)}KB 총 / 코스당 평균 ${(courseDirKB / built.length / 1024).toFixed(1)}KB   <- lazy fetch`)

  if (warnings.length) {
    console.log(`\n경고 ${warnings.length}건`)
    for (const w of warnings) console.log(`  - ${w}`)
  }

  const first = mains[0]
  const last = mains.at(-1)
  return {
    id: trail.id,
    name: trail.name,
    span: trail.span,
    // 본선 코스 수. 지선·우회로는 따로
    courseCount: mains.length,
    subCourseCount: built.length - mains.length,
    totalKm,
    totalAscentM,
    bbox: [
      Math.min(...built.map((c) => c.bbox[0])),
      Math.min(...built.map((c) => c.bbox[1])),
      Math.max(...built.map((c) => c.bbox[2])),
      Math.max(...built.map((c) => c.bbox[3])),
    ],
    source: listUrl(trail),
    // 길 사이 연결을 찾는 데 쓴다 (trails.json 에는 links 로 정리해 넣는다)
    ends: {
      start: { courseId: first.id, latlng: first.startLatLng },
      end: { courseId: last.id, latlng: last.endLatLng },
    },
  }
}

/**
 * 길 끝점끼리 LINK_M 안에서 만나면 "이어지는 길"로 묶는다.
 * 예: 남파랑길 1코스 시점 = 해파랑길 1코스 시점 (부산 오륙도)
 * 좌표로 잰다. 끝점이 어긋난 길을 이어진 것처럼 안내하지 않는다.
 */
function linkTrails(summaries) {
  for (const a of summaries) {
    a.links = []
    for (const b of summaries) {
      if (a === b) continue
      for (const at of ['start', 'end']) {
        for (const toAt of ['start', 'end']) {
          const distM = Math.round(haversine(a.ends[at].latlng, b.ends[toAt].latlng))
          if (distM > LINK_M) continue
          a.links.push({
            at,
            courseId: a.ends[at].courseId,
            trail: b.id,
            trailName: b.name,
            toAt,
            toCourseId: b.ends[toAt].courseId,
            distM,
          })
        }
      }
    }
  }
}

/** 데이터 생성 시각. 모든 길의 meta.json 과 trails.json 이 같은 값을 쓴다 (vite.config.js 의 캐시 버스터). */
const GENERATED_AT = new Date().toISOString()

function main() {
  const trails = TRAILS.filter((t) => t.enabled)
  const summaries = trails.map(buildTrail)
  linkTrails(summaries)

  writeFileSync(
    join(OUT_ROOT, 'trails.json'),
    JSON.stringify(
      {
        generatedAt: GENERATED_AT,
        // 화면이 처음 여는 길. 길을 적지 않은 옛 주소(?from=17&to=23)도 이 길로 해석한다
        defaultTrail: 'namparang',
        license: '공공누리 제4유형 (출처표시 + 상업적이용금지 + 변경금지) — 두루누비(한국관광공사)',
        trails: summaries.map(({ ends, ...t }) => t),
      },
      null,
      1,
    ),
  )

  // 남파랑길은 옛 경로에도 둔다. 옛 앱(캐시된 index.html)과 옛 MCP 서버 사본이 이 경로를 읽는다.
  const legacy = 'namparang'
  if (trails.some((t) => t.id === legacy)) {
    const legacyCourse = join(OUT_ROOT, 'course')
    if (existsSync(legacyCourse)) rmSync(legacyCourse, { recursive: true })
    cpSync(join(OUT_ROOT, legacy, 'course'), legacyCourse, { recursive: true })
    for (const f of ['courses.json', 'meta.json']) cpSync(join(OUT_ROOT, legacy, f), join(OUT_ROOT, f))
  }

  console.log(`\n길 ${summaries.length}개 — ${summaries.map((s) => `${s.name} ${s.courseCount}코스 ${s.totalKm}km`).join(' · ')}`)
  for (const s of summaries) {
    for (const l of s.links) {
      const side = (x) => (x === 'start' ? '시점' : '종점')
      console.log(`  연결  ${s.name} ${l.courseId}코스 ${side(l.at)} = ${l.trailName} ${l.toCourseId}코스 ${side(l.toAt)} (${l.distM}m)`)
    }
  }
  console.log('  trails.json · 남파랑길 사본 public/data/courses.json, meta.json, course/')
}

main()
