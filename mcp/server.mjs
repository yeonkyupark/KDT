#!/usr/bin/env node
/**
 * 코리아둘레길 코스 정보 MCP 서버. 길(`trail`)마다 코스를 조회한다 — 기본은 남파랑길.
 *
 * **배포된 정적 사이트의 JSON을 그대로 fetch 한다** — 로컬 파일을 읽지 않는다.
 * `trails.json`과 길별 `courses.json`/`meta.json`은 GitHub Pages에 공개돼 있고(CORS 허용,
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

// 배포 전 로컬 데이터로 시험할 때만 KDT_SITE 로 바꾼다 (예: npm run preview 의 주소)
const SITE = process.env.KDT_SITE || 'https://yeonkyupark.github.io/KDT'

// 사이트 자체 CDN 캐시가 10분(Cache-Control: max-age=600)이라 그보다 짧게 맞춘다.
// 도구를 여러 번 연달아 부를 때마다 160KB를 새로 받는 낭비를 막는다.
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()

async function cachedFetch(path) {
  const entry = cache.get(path)
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.value
  const url = `${SITE}/${path}`
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    throw new Error(`${url} 요청 실패 — 네트워크를 확인하세요 (${e.message})`)
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  const value = await res.json()
  cache.set(path, { value, at: Date.now() })
  return value
}

const DEFAULT_TRAIL = 'namparang'
const loadTrails = () => cachedFetch('data/trails.json')

/** 길 id 를 확인하고 그 길 정보를 돌려준다. 모르는 길이면 쓸 수 있는 길을 알려 준다. */
async function trailInfo(id = DEFAULT_TRAIL) {
  const { trails } = await loadTrails()
  const t = trails.find((x) => x.id === id)
  if (!t) throw new Error(`"${id}" 길이 없습니다. 쓸 수 있는 길: ${trails.map((x) => `${x.id}(${x.name})`).join(', ')}`)
  return t
}
const loadCourses = async (id) => cachedFetch(`data/${(await trailInfo(id)).id}/courses.json`)
const loadMeta = async (id) => cachedFetch(`data/${(await trailInfo(id)).id}/meta.json`)

const TrailArg = z
  .string()
  .optional()
  .describe('길 id. namparang(남파랑길, 기본) · haeparang(해파랑길). 전체 목록은 list_trails')

/** 도구 실행 중 오류(모르는 길 등)를 MCP 오류 응답으로 바꾼다. */
const guarded = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true }
  }
}

/** 목록·검색에 쓰는 간략 표현. */
function brief(c) {
  return {
    id: c.id,
    seq: c.seq,
    name: c.name,
    label: c.label ?? '',
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
    label: c.label || null,
    region: c.region,
    alias: c.alias || null,
    start: c.start || null,
    end: c.end || null,
    startAddr: c.startAddr || null,
    startAccess: c.startAccess || null,
    endAddr: c.endAddr || null,
    endAccess: c.endAccess || null,
    // 해파랑길처럼 공식 지점명이 없어 주소로 표시한 경우 true
    placeFromAddress: c.startSource === 'addr' || c.endSource === 'addr',
    stamp: c.stamp ?? null,
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
  label: z.string(),
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
  label: z.string().nullable(),
  region: z.string(),
  alias: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  startAddr: z.string().nullable(),
  startAccess: z.string().nullable(),
  endAddr: z.string().nullable(),
  endAccess: z.string().nullable(),
  placeFromAddress: z.boolean(),
  stamp: z.object({ addr: z.string(), place: z.string() }).nullable(),
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
  const server = new McpServer({ name: 'korea-dulle-gil', version: '0.2.0' })

  server.registerTool(
    'list_trails',
    {
      title: '코리아둘레길 길 목록',
      description:
        '이 서버가 다루는 코리아둘레길 길(남파랑길·해파랑길 …)의 id, 이름, 구간, 코스 수, 총 거리, ' +
        '길 사이 연결(예: 남파랑길 1코스 시점 = 해파랑길 1코스 시점)을 반환한다. ' +
        '다른 도구의 trail 인자에 여기 나온 id 를 쓴다.',
      outputSchema: z.object({
        trails: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            span: z.string(),
            courseCount: z.number(),
            totalKm: z.number(),
            totalAscentM: z.number(),
            source: z.string(),
            links: z.array(z.string()),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      const side = (x) => (x === 'start' ? '시점' : '종점')
      const rows = (await loadTrails()).trails.map((t) => ({
        id: t.id,
        name: t.name,
        span: t.span,
        courseCount: t.courseCount,
        totalKm: t.totalKm,
        totalAscentM: t.totalAscentM,
        source: t.source,
        links: (t.links ?? []).map(
          (l) => `${t.name} ${l.courseId}코스 ${side(l.at)} = ${l.trailName} ${l.toCourseId}코스 ${side(l.toAt)}`,
        ),
      }))
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 1) }],
        structuredContent: { trails: rows },
      }
    }),
  )

  server.registerTool(
    'list_courses',
    {
      title: '코스 목록',
      description:
        '길 하나의 코스 전체를 간단히 나열한다(기본 남파랑길). 지역으로 필터링할 수 있다. ' +
        '자세한 코스 정보가 필요하면 get_courses 를 쓴다.',
      inputSchema: z.object({
        trail: TrailArg,
        region: z.string().optional().describe('시/군 이름으로 필터링 (예: "거제시", "강릉시")'),
      }),
      outputSchema: z.object({ courses: z.array(BriefSchema) }),
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ trail, region }) => {
      const courses = await loadCourses(trail)
      const rows = courses.filter((c) => !region || c.region?.includes(region)).map(brief)
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 1) }],
        structuredContent: { courses: rows },
      }
    }),
  )

  server.registerTool(
    'get_courses',
    {
      title: '코스 상세 + 구간 합계',
      description:
        '길 하나에서 코스 번호 범위(from~to)의 상세 정보와 구간 합계(총 거리·소요시간·상승/하강)를 반환한다. ' +
        '단일 코스만 보려면 to 를 생략하거나 from 과 같게 준다. ' +
        '남파랑길 1~90코스는 부산 오륙도에서 해남 땅끝탑 방향, 해파랑길 1~50코스는 부산 오륙도에서 고성 통일전망대 방향이다.',
      inputSchema: z.object({
        trail: TrailArg,
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
    guarded(async ({ trail, from, to }) => {
      const courses = await loadCourses(trail)
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
    }),
  )

  server.registerTool(
    'search_courses',
    {
      title: '코스 검색',
      description:
        '길 하나에서 지역명·지점명·코스 별칭·부제로 코스를 찾는다 (예: "학동고개", "남해바래길", "블루로드").',
      inputSchema: z.object({
        trail: TrailArg,
        query: z.string().min(1).describe('검색어'),
      }),
      outputSchema: z.object({ courses: z.array(BriefSchema) }),
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ trail, query }) => {
      const courses = await loadCourses(trail)
      const q = query.replace(/\s+/g, '')
      const rows = courses
        .filter((c) => {
          const hay = [c.name, c.label, c.region, c.start, c.end, c.alias]
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
    }),
  )

  server.registerTool(
    'get_trail_summary',
    {
      title: '길 전체 개요',
      description: '길 하나(기본 남파랑길) 전체의 총 거리·상승고도, 데이터 출처와 주의사항을 반환한다.',
      inputSchema: z.object({ trail: TrailArg }),
      outputSchema: z.object({
        trail: z.string(),
        name: z.string(),
        courseCount: z.number(),
        mainCourseCount: z.number(),
        totalKm: z.number(),
        totalAscentM: z.number(),
        notes: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ trail }) => {
      const t = await trailInfo(trail)
      const meta = await loadMeta(t.id)
      const payload = {
        trail: t.id,
        name: t.name,
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
    }),
  )

  return server
}

const handle = serveStdio(buildServer)

process.on('SIGINT', () => {
  handle.close()
  process.exit(0)
})
