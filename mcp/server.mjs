#!/usr/bin/env node
/**
 * 남파랑길 코스 정보 MCP 서버.
 *
 * **배포된 정적 사이트의 JSON을 그대로 fetch 한다** — 로컬 파일을 읽지 않는다.
 * `courses.json`/`meta.json`은 GitHub Pages에 공개돼 있고(CORS 허용,
 * robots.txt 차단 없음, 우리 자신의 데이터라 권한 문제도 없다), 앱이 갱신되면
 * 이 서버가 보는 정보도 그만큼 최신이다.
 *
 * 로컬 파일에 의존하지 않는 이유가 하나 더 있다: 저장소를 clone 하지 않고도
 * 이 파일 하나(+ npm 의존성 2개)만 있으면 어디서든 실행된다. 나중에 이 서버를
 * 진짜 원격 호스팅(Cloudflare Workers 등)으로 옮기고 싶어지면, 로컬 파일 I/O가
 * 없으므로 stdio 전송만 HTTP로 바꾸면 거의 그대로 옮겨진다.
 *
 * 로컬 stdio 로만 서빙한다(데이터는 원격에서 받아오지만 MCP 서버 프로세스
 * 자체는 각자의 PC에서 돈다 — claude.ai 웹은 여전히 못 쓴다). 개인 기록
 * (사진·메모)은 다루지 않는다 — 코스 정보(공개 자료 기반)만 노출한다.
 *
 * 실행: `node mcp/server.mjs` (MCP 호스트가 이 명령으로 자식 프로세스를 띄운다)
 */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

const SITE = 'https://yeonkyupark.github.io/KDT'

// 사이트 자체 CDN 캐시가 10분(Cache-Control: max-age=600)이라 그보다 짧게 맞춘다.
// 도구를 여러 번 연달아 부를 때마다 168KB를 새로 받는 낭비를 막는다.
const CACHE_TTL_MS = 5 * 60 * 1000

function cachedFetch(path) {
  let entry = null
  return async () => {
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.value
    const url = `${SITE}/${path}`
    let res
    try {
      res = await fetch(url)
    } catch (e) {
      throw new Error(`${url} 요청 실패 — 네트워크를 확인하세요 (${e.message})`)
    }
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
    entry = { value: await res.json(), at: Date.now() }
    return entry.value
  }
}

const loadCourses = cachedFetch('data/courses.json')
const loadMeta = cachedFetch('data/meta.json')

/** 목록·검색에 쓰는 간략 표현. */
function brief(c) {
  return {
    id: c.id,
    seq: c.seq,
    name: c.name,
    region: c.region,
    start: c.start,
    end: c.end,
    distanceKm: c.distanceKm,
    difficulty: c.difficulty,
  }
}

/**
 * 상세 조회용 표현. 좌표 폴리라인(`overview`)·고도 배열(`eleLow`)·`bbox`는
 * 뺀다 — 지도용 원시 데이터라 텍스트 응답에 무의미하게 크다.
 */
function detail(c) {
  return {
    id: c.id,
    seq: c.seq,
    name: c.name,
    region: c.region,
    alias: c.alias || null,
    start: c.start || null,
    end: c.end || null,
    startAddr: c.startAddr || null,
    startAccess: c.startAccess || null,
    endAddr: c.endAddr || null,
    endAccess: c.endAccess || null,
    distanceKm: c.distanceKm,
    durationMin: c.durationMin,
    ascentM: c.ascentM,
    descentM: c.descentM,
    eleMin: c.eleMin,
    eleMax: c.eleMax,
    difficulty: c.difficulty,
    officialKm: c.officialKm ?? null,
    startLatLng: c.startLatLng,
    endLatLng: c.endLatLng,
    note: c.note || null,
  }
}

const BriefSchema = z.object({
  id: z.string(),
  seq: z.number(),
  name: z.string(),
  region: z.string(),
  start: z.string(),
  end: z.string(),
  distanceKm: z.number(),
  difficulty: z.string(),
})

const DetailSchema = z.object({
  id: z.string(),
  seq: z.number(),
  name: z.string(),
  region: z.string(),
  alias: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  startAddr: z.string().nullable(),
  startAccess: z.string().nullable(),
  endAddr: z.string().nullable(),
  endAccess: z.string().nullable(),
  distanceKm: z.number(),
  durationMin: z.number(),
  ascentM: z.number(),
  descentM: z.number(),
  eleMin: z.number(),
  eleMax: z.number(),
  difficulty: z.string(),
  officialKm: z.number().nullable(),
  startLatLng: z.tuple([z.number(), z.number()]),
  endLatLng: z.tuple([z.number(), z.number()]),
  note: z.string().nullable(),
})

/** 매 stdio 연결마다 새 서버 인스턴스를 만든다 — SDK가 권장하는 팩토리 패턴. */
function buildServer() {
  const server = new McpServer({ name: 'namparang-gil', version: '0.1.0' })

  server.registerTool(
    'list_courses',
    {
      title: '남파랑길 코스 목록',
      description:
        '남파랑길 90개 코스 전체를 간단히 나열한다. 지역으로 필터링할 수 있다. ' +
        '자세한 코스 정보가 필요하면 get_courses 를 쓴다.',
      inputSchema: z.object({
        region: z.string().optional().describe('시/군 이름으로 필터링 (예: "거제시", "통영시")'),
      }),
      outputSchema: z.object({ courses: z.array(BriefSchema) }),
      annotations: { readOnlyHint: true },
    },
    async ({ region }) => {
      const courses = await loadCourses()
      const rows = courses.filter((c) => !region || c.region?.includes(region)).map(brief)
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 1) }],
        structuredContent: { courses: rows },
      }
    },
  )

  server.registerTool(
    'get_courses',
    {
      title: '남파랑길 코스 상세 + 구간 합계',
      description:
        '코스 번호 범위(from~to)의 상세 정보와 구간 합계(총 거리·소요시간·상승/하강)를 반환한다. ' +
        '단일 코스만 보려면 to 를 생략하거나 from 과 같게 준다. ' +
        '코스 1~90번은 부산 오륙도(1번)에서 해남 땅끝탑(90번) 방향으로 이어진다.',
      inputSchema: z.object({
        from: z.number().int().min(1).describe('시작 코스 번호'),
        to: z.number().int().min(1).optional().describe('종료 코스 번호. 생략하면 from 과 같다'),
      }),
      outputSchema: z.object({
        summary: z.object({
          range: z.string(),
          courseCount: z.number(),
          totalDistanceKm: z.number(),
          totalDurationMin: z.number(),
          totalAscentM: z.number(),
          totalDescentM: z.number(),
        }),
        courses: z.array(DetailSchema),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const courses = await loadCourses()
      const maxSeq = Math.max(...courses.map((c) => c.seq))
      const lo = Math.min(from, to ?? from)
      const hi = Math.max(from, to ?? from)

      const sel = courses.filter((c) => c.seq >= lo && c.seq <= hi)
      if (!sel.length) {
        return {
          content: [
            {
              type: 'text',
              text: `${lo}~${hi}코스에 해당하는 코스가 없습니다. 전체 범위는 1~${maxSeq}코스입니다.`,
            },
          ],
          isError: true,
        }
      }
      const totalDistanceKm =
        Math.round((sel.reduce((s, c) => s + c.distanceM, 0) / 1000) * 10) / 10
      const summary = {
        range: lo === hi ? `${lo}코스` : `${lo}~${hi}코스`,
        courseCount: sel.length,
        totalDistanceKm,
        totalDurationMin: sel.reduce((s, c) => s + c.durationMin, 0),
        totalAscentM: sel.reduce((s, c) => s + c.ascentM, 0),
        totalDescentM: sel.reduce((s, c) => s + c.descentM, 0),
      }
      const payload = {
        summary,
        courses: sel.map(detail),
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }],
        structuredContent: payload,
      }
    },
  )

  server.registerTool(
    'search_courses',
    {
      title: '남파랑길 코스 검색',
      description: '지역명·지점명·코스 별칭으로 코스를 찾는다 (예: "학동고개", "남해바래길").',
      inputSchema: z.object({
        query: z.string().min(1).describe('검색어'),
      }),
      outputSchema: z.object({ courses: z.array(BriefSchema) }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const courses = await loadCourses()
      const q = query.replace(/\s+/g, '')
      const rows = courses
        .filter((c) => {
          const hay = [c.name, c.region, c.start, c.end, c.alias]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, '')
          return hay.includes(q)
        })
        .map(brief)
      return {
        content: [
          {
            type: 'text',
            text: rows.length
              ? JSON.stringify(rows, null, 1)
              : `"${query}"와 일치하는 코스를 찾지 못했습니다.`,
          },
        ],
        structuredContent: { courses: rows },
      }
    },
  )

  server.registerTool(
    'get_trail_summary',
    {
      title: '남파랑길 전체 개요',
      description: '남파랑길 전체(90개 코스)의 총 거리·상승고도, 데이터 출처와 주의사항을 반환한다.',
      outputSchema: z.object({
        courseCount: z.number(),
        mainCourseCount: z.number(),
        totalKm: z.number(),
        totalAscentM: z.number(),
        notes: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const meta = await loadMeta()
      const payload = {
        courseCount: meta.courseCount,
        mainCourseCount: meta.mainCourseCount,
        totalKm: meta.totalKm,
        totalAscentM: meta.totalAscentM,
        notes: [
          `난이도·소요시간: ${meta.duration?.note ?? ''}`,
          `고도: ${meta.elevation?.note ?? ''}`,
          `공식 자료 출처: ${meta.official?.source ?? ''} (${meta.official?.license ?? ''})`,
        ].filter(Boolean),
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }],
        structuredContent: payload,
      }
    },
  )

  return server
}

const handle = serveStdio(buildServer)

process.on('SIGINT', () => {
  handle.close()
  process.exit(0)
})
