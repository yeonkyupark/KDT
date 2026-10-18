/**
 * 두루누비(한국관광공사) 코스 데이터 수집.
 *
 * 출처가 둘이다.
 *
 *   공공 API  : 공공데이터포털 "한국관광공사 두루누비 정보 서비스" (routeList / courseList)
 *               https://apis.data.go.kr/B551011/Durunubi — 인증키 필요, 데이터 갱신 일 1회.
 *               **코스가 절반가량만 들어 있다** (2026-10-18 기준 남파랑길 44/90, 해파랑길 43/50,
 *               서해랑길 51/109, DMZ 평화의 길 34/48). 빠진 코스에 규칙이 없다.
 *   사이트 목록 : 두루누비 사이트가 코스 목록 화면을 채우는 `/api/course/list`.
 *               인증 없음, 코스가 전부 있다. 공식 문서가 없는 내부 API 라 바뀔 수 있다.
 *               `robots.txt` 가 막은 경로가 아니다.
 *
 * 규칙: **공공 API 에 있는 코스는 공공 API 값을 쓰고, 없는 코스만 사이트 목록으로 채운다.**
 * 거리만 예외다 — 공공 API 는 정수로 반올림해 주므로(18.9 → 19) 같은 값이면 사이트의 소수 값을 쓴다.
 *
 * GPX 는 두 출처 모두 같은 경로를 준다. 공공 API 가 안내하는 `editImgUp.do?filePath=…` 로 받는다
 * (`robots.txt` 가 막은 `/download` 와 다른 경로다). 받은 파일은 사이트에서 직접 받은 것과 바이트 단위로 같다.
 */

import { existsSync, readFileSync } from 'node:fs'

const PUBLIC_API = 'https://apis.data.go.kr/B551011/Durunubi'
const SITE = 'https://www.durunubi.kr'
const APP_NAME = 'KDT'

/** 요청 사이 간격. 두루누비 서버에 부담을 주지 않는다. */
const DELAY_MS = 300
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 로컬에서는 .env, CI 에서는 환경변수(GitHub Secret)로 인증키를 받는다. 키는 리포에 넣지 않는다. */
export function serviceKey() {
  if (process.env.DURUNUBI_SERVICE_KEY) return process.env.DURUNUBI_SERVICE_KEY
  if (existsSync('.env')) {
    const m = /^DURUNUBI_SERVICE_KEY=(.+)$/m.exec(readFileSync('.env', 'utf8'))
    if (m) return m[1].trim()
  }
  throw new Error('DURUNUBI_SERVICE_KEY 가 없다. .env 또는 환경변수로 공공데이터포털 인증키를 넣어라.')
}

async function getJson(url, what) {
  let res
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url)
      if (res.status < 500) break
    } catch (e) {
      if (attempt >= 2) throw new Error(`${what}: 네트워크 실패 — ${e.message}`)
    }
    if (attempt >= 2) break
    await sleep(2000 * (attempt + 1))
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch {
    // 공공데이터포털은 인증 오류를 JSON 이 아닌 XML 로 돌려준다
    throw new Error(`${what}: JSON 이 아니다 — ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
}

/** 공공 API — 길 하나의 코스 전부. 응답 item 이 1개면 배열이 아니라 객체로 온다. */
export async function fetchPublicCourses(routeIdx, key = serviceKey()) {
  const out = []
  for (let pageNo = 1; ; pageNo++) {
    const u = new URL(`${PUBLIC_API}/courseList`)
    u.search = new URLSearchParams({
      serviceKey: key,
      MobileOS: 'ETC',
      MobileApp: APP_NAME,
      _type: 'json',
      numOfRows: '100',
      pageNo: String(pageNo),
      routeIdx,
    })
    const j = await getJson(u, `공공 API courseList(${routeIdx})`)
    const header = j?.response?.header
    if (header?.resultCode !== '0000') {
      throw new Error(`공공 API courseList(${routeIdx}): ${header?.resultCode} ${header?.resultMsg}`)
    }
    const body = j.response.body
    out.push(...[].concat(body?.items?.item ?? []))
    if (out.length >= Number(body?.totalCount ?? 0) || !body?.items) break
    await sleep(DELAY_MS)
  }
  return out
}

/** 사이트 목록 — 길 하나의 코스 전부. 화면과 같은 파라미터(offset 은 0부터 시작하는 페이지 번호). */
export async function fetchSiteCourses(serviceFlag) {
  const q = `type=DNWW&serviceFlag=${encodeURIComponent(serviceFlag)}`
  const count = Number((await getJson(`${SITE}/api/course/count?${q}`, `사이트 count(${serviceFlag})`)).response)
  const size = 200
  const out = []
  for (let offset = 0; out.length < count; offset++) {
    await sleep(DELAY_MS)
    const j = await getJson(
      `${SITE}/api/course/list?${q}&offset=${offset}&size=${size}&orderBy=4`,
      `사이트 list(${serviceFlag})`,
    )
    const page = j?.response ?? []
    if (!page.length) break
    out.push(...page)
  }
  if (out.length !== count) throw new Error(`사이트 list(${serviceFlag}): ${out.length}개를 받았는데 count 는 ${count}`)
  return out
}

/** 안내문 텍스트 정리: <br> → 줄바꿈, \r 제거, 줄 앞뒤 공백 제거. */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim()
}

/**
 * 여행자정보(travelerInfo)에서 시점·종점을 뽑는다.
 *   - 시점 : 오륙도해맞이공원 (부산 남구 오륙도로 137)
 *   교통편) 경성대부경대역 24번 버스, 오륙도스카이워크 하차
 * 주소 괄호 안에 괄호가 또 있을 수 있어 첫 '(' 기준으로 자르고 끝의 ')' 하나만 뗀다.
 */
export function parseTravelerInfo(text) {
  const t = cleanText(text)
  const point = (label) => {
    const m = new RegExp(`-\\s*${label}\\s*:\\s*([^\\n]*)(?:\\n\\s*교통편\\)\\s*([^\\n]*))?`).exec(t)
    if (!m) return null
    const head = m[1].trim()
    const i = head.indexOf('(')
    return {
      name: (i >= 0 ? head.slice(0, i) : head).replace(/\s+/g, ' ').trim(),
      addr: i >= 0 ? head.slice(i + 1).replace(/\)\s*$/, '').trim() : '',
      access: (m[2] ?? '').trim(),
    }
  }
  return { start: point('시점'), end: point('종점') }
}

/**
 * 코스 이름에서 번호를 뽑는다. 길 이름 다음의 첫 번호가 코스 번호다.
 *   '남파랑길 31코스' → {seq:31, sub:0, label:''}
 *   'DMZ 평화의 길 3-1코스(우회로)' → {seq:3, sub:1, label:'우회로'}
 *   'DMZ 평화의 길 8코스 (예약노선)' → {seq:8, sub:0, label:'예약노선'}
 *   '해파랑길 35코스 바우길 09구간' → {seq:35, sub:0, label:'바우길 09구간'}  (괄호 없는 부제)
 *   '서해랑길 64-3(지선3코스)' → {seq:64, sub:3, label:'지선3코스'}  ("코스" 가 빠졌다)
 * "코스" 도 하위 번호도 괄호 부제도 없으면 코스 이름으로 보지 않는다(null).
 */
export function parseCourseName(name) {
  const m = /^\D*?(\d+)(?:-(\d+))?\s*(코스)?\s*(.*?)\s*$/.exec(name ?? '')
  if (!m) return null
  const [, seq, sub, word, rest] = m
  const paren = /^\((.*)\)$/.exec(rest)
  if (!word && !sub && !paren) return null
  return { seq: Number(seq), sub: sub ? Number(sub) : 0, label: (paren ? paren[1] : rest).trim() }
}

/**
 * 여행자정보에 시점·종점 줄이 없는 길(해파랑길)에서 쓸 만한 것을 뽑는다.
 *
 *   *해파랑길 스탬프함 위치
 *   해운대구 해운대해변로 264(해운대 종합관광봉사센터 내)
 *   → stamp: { addr: '해운대구 해운대해변로 264', place: '해운대 종합관광봉사센터 내' }
 *
 *   - 부산역에서 급행버스 1003번 이용, 해운대해수욕장 하차 후 도보이동(약 160m)
 *   → access: 교통 수단이 나오는 첫 줄 (코스 시점까지 가는 방법이다)
 *
 * 스탬프 위치 설명("자판기 옆", "건너편")은 지점명으로 쓰지 않는다. 따로 보여 준다.
 */
export function parseStampAndAccess(text) {
  const t = cleanText(text)
  const line = /스탬프함\s*위치\s*\n([^\n]+)/.exec(t)?.[1]?.trim() ?? ''
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(line)
  const stamp = line ? { addr: (m ? m[1] : line).trim(), place: (m ? m[2] : '').trim() } : null
  const access =
    t
      .split('\n')
      .find((l) => /^-/.test(l) && /(버스|지하철|열차|기차|터미널|하차|역에서)/.test(l))
      ?.replace(/^-\s*/, '') ?? ''
  return { stamp, access }
}

const LEVEL_LABEL = { 1: '쉬움', 2: '보통', 3: '어려움' }

/**
 * 두 출처를 코스 ID(crsIdx)로 합쳐 같은 모양의 기록으로 만든다.
 * 화면·빌드에 쓰는 안정적인 필드만 남긴다(조회수·후기 수처럼 매번 바뀌는 값은 버린다).
 */
export function mergeCourses(trail, publicItems, siteItems) {
  const pub = new Map(publicItems.map((c) => [c.crsIdx, c]))
  const records = []
  const unparsed = []

  for (const s of siteItems) {
    const p = pub.get(s.crs_idx)
    const name = (p?.crsKorNm ?? s.crs_Kor_Nm ?? '').trim()
    const num = parseCourseName(name)
    // 해석하지 못한 이름을 버리면 코스가 조용히 사라진다. 모아서 실패시킨다.
    if (!num) {
      unparsed.push(name || `(이름 없음 ${s.crs_idx})`)
      continue
    }

    const siteKm = Number(s.crs_Dstnc)
    const pubKm = p ? Number(p.crsDstnc) : NaN
    // 공공 API 는 정수 반올림 값이다. 같은 값을 가리키면 사이트의 소수 값을 쓴다.
    const km = p && !(Number.isFinite(siteKm) && Math.round(siteKm) === pubKm) ? pubKm : siteKm
    const level = Number(p?.crsLevel ?? s.level)
    const gpxFilePath = (p ? String(p.gpxpath ?? '').replace(/^.*filePath=/, '') : s.gpx_src) || s.gpx_src

    let file = ''
    try {
      file = decodeURIComponent(s.downloadGpxFilename ?? '')
    } catch {
      file = ''
    }
    if (!/\.gpx$/i.test(file) || /[\\/]/.test(file)) {
      file = `${trail.name}_${num.seq}${num.sub ? `-${num.sub}` : ''}코스.gpx`
    }

    records.push({
      crsIdx: s.crs_idx,
      name,
      seq: num.seq,
      sub: num.sub,
      label: num.label,
      source: p ? 'public' : 'site',
      km,
      minutes: Number(p?.crsTotlRqrmHour ?? s.crs_Totl_Rqrm_Hour),
      level,
      levelLabel: LEVEL_LABEL[level] ?? '',
      cycle: (p?.crsCycle ?? s.cycle ?? '').trim(),
      sigun: (p?.sigun ?? s.sigun ?? '').trim(),
      travelerInfo: cleanText(p?.travelerinfo ?? s.travelerInfo),
      summary: cleanText(p?.crsSummary ?? s.summary),
      contents: cleanText(p?.crsContents ?? s.contents),
      tourInfo: cleanText(p?.crsTourInfo ?? s.tourInfo),
      warning: cleanText(s.warning_notice),
      // 사이트 목록의 시·종점 주소. 남파랑길은 여행자정보에 지점명·주소가 함께 있지만
      // 해파랑길 여행자정보에는 시점·종점 줄이 없어 이 주소가 유일한 공식 시·종점 표기다.
      startAddress: (s.startAddress ?? '').trim(),
      endAddress: (s.endAddress ?? '').trim(),
      startLatLng: [Number(s.startLat), Number(s.startLon)],
      endLatLng: [Number(s.endLat), Number(s.endLon)],
      publicModified: p?.modifiedtime ?? p?.modifitedtime ?? null,
      gpxFilePath,
      file,
    })
  }
  if (unparsed.length) {
    throw new Error(`${trail.name}: 코스 이름 ${unparsed.length}개를 해석하지 못했다 — ${unparsed.join(', ')}`)
  }
  return records.sort((a, b) => a.seq - b.seq || a.sub - b.sub)
}

export function gpxUrl(gpxFilePath) {
  return `${SITE}/editImgUp.do?filePath=${gpxFilePath}`
}

/** GPX 크기만 확인한다(HEAD). 서버가 ETag·Last-Modified 를 주지 않아 크기로 변경을 가늠한다. */
export async function gpxLength(gpxFilePath) {
  const res = await fetch(gpxUrl(gpxFilePath), { method: 'HEAD' })
  if (!res.ok) throw new Error(`GPX HEAD ${res.status}: ${gpxFilePath}`)
  const n = Number(res.headers.get('content-length'))
  return Number.isFinite(n) ? n : null
}

/** GPX 를 받는다. 바이트 그대로 돌려준다(공공누리 변경금지 — 손대지 않는다). */
export async function downloadGpx(gpxFilePath) {
  const res = await fetch(gpxUrl(gpxFilePath))
  if (!res.ok) throw new Error(`GPX 다운로드 ${res.status}: ${gpxFilePath}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const head = buf.toString('utf8', 0, 400)
  if (!/<gpx[\s>]/.test(head)) throw new Error(`GPX 가 아니다: ${gpxFilePath} — ${head.slice(0, 80)}`)
  return buf
}
