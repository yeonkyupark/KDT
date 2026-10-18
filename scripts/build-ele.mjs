/**
 * 단계 2a — DEM 고도 확보
 *
 * 모든 고도 지표를 SRTM 30m DEM에서 직접 산출한다.
 *
 * 두루누비 공식 GPX 에도 <ele> 가 있지만 쓰지 않는다. 남파랑길은 37개 코스에 고도가 빠진 점이 있고
 * (55코스는 26/614점), 49코스는 대부분 0, 5·51코스는 해수면 아래(-7m)로 내려간다. 해파랑길도 50개 중
 * 23개에 누락·0값·음수가 있다. 제작 도구도 섞여 있어 코스마다 기준이 다르다. DEM 은 모든 길이 같은 기준이다.
 *
 * 전략
 *  - 원본 트랙포인트를 전부 조회하지 않는다. 50m 균일 간격으로 재샘플링한다
 *    (남파랑길 124,173점 -> 약 29,000점). opentopodata 공개 API 는 하루 1,000요청까지다.
 *  - 조회 전에 예상 요청 수를 출력한다. --max-requests 에 닿으면 멈추고, 다음 실행이 이어서 한다.
 *  - 코스 하나가 끝나면 즉시 캐시에 쓴다. 중단되면 다시 실행하면 이어서 진행한다.
 *  - 캐시를 리포에 커밋하므로 재빌드 때 재조회가 없고 오프라인 빌드가 된다.
 *  - 캐시에 원본 GPX 의 SHA1 을 남긴다. GPX 가 바뀌면(노선 교체 등) 그 코스만 다시 조회한다.
 *
 * 사용법
 *   node scripts/build-ele.mjs                       # 켜진(enabled) 길, 캐시 없는 코스만
 *   node scripts/build-ele.mjs --trail=haeparang     # 꺼진 길도 이름을 대면 조회한다
 *   node scripts/build-ele.mjs --max-requests=300    # 요청 수 상한 (기본 900, 하루 한도 1,000 아래)
 *   node scripts/build-ele.mjs --force               # 전부 다시
 *   node scripts/build-ele.mjs --only=23,64-1        # 특정 코스만 (길 안의 코스 id)
 *   node scripts/build-ele.mjs --dry-run             # 예상 요청 수만 보고 조회하지 않는다
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listCourses, parseGpx, sourceSha1 } from './lib/gpx.mjs'
import { resample, pathLength } from './lib/geo.mjs'
import { TRAILS } from './lib/trails.mjs'

const CACHE_DIR = 'data/cache/ele'

const SPACING = 50 // 샘플 간격 (m). SRTM 30m 대비 적당한 오버샘플
const DATASET = 'srtm30m'
const INTERPOLATION = 'cubic' // 실측 5개 코스 대조 결과 nearest/bilinear보다 정확했다
const BATCH = 100 // opentopodata 요청당 최대 좌표 수
const DELAY_MS = 1100 // 1req/s 제한 + 여유
const MAX_RETRY = 4

const API = `https://api.opentopodata.org/v1/${DATASET}`

const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const DRY = argv.includes('--dry-run')
const TRAIL_IDS = argv.find((a) => a.startsWith('--trail='))?.slice(8).split(',')
const MAX_REQUESTS = Number(argv.find((a) => a.startsWith('--max-requests='))?.slice(15) ?? 900)
const ONLY = (() => {
  const a = argv.find((x) => x.startsWith('--only='))
  if (!a) return null
  return new Set(a.slice(7).split(',').map((s) => s.trim()))
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 좌표 100개 이하를 한 번에 조회한다. 실패 시 백오프 재시도. */
async function fetchBatch(points) {
  const locations = points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|')

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) {
      const wait = 5000 * 3 ** (attempt - 1) // 5s, 15s, 45s, 135s
      process.stdout.write(` [재시도 ${attempt}, ${wait / 1000}s 대기]`)
      await sleep(wait)
    }

    let res
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations, interpolation: INTERPOLATION }),
      })
    } catch (e) {
      if (attempt === MAX_RETRY) throw new Error(`네트워크 실패: ${e.message}`)
      continue
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_RETRY) throw new Error(`HTTP ${res.status} (재시도 소진)`)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)

    const json = await res.json()
    if (json.status !== 'OK') throw new Error(`API status=${json.status} ${json.error ?? ''}`)
    if (json.results.length !== points.length) {
      throw new Error(`결과 수 불일치: ${json.results.length} != ${points.length}`)
    }
    return json.results.map((r) => r.elevation)
  }
}

/** 캐시가 유효하면 건너뛰고, 아니면 재샘플링해 몇 번 요청할지 정한다(조회는 아직 하지 않는다). */
function planCourse(course) {
  const out = join(CACHE_DIR, `${course.key}.json`)
  const sha1 = sourceSha1(course.path)

  if (!FORCE && existsSync(out)) {
    const cached = JSON.parse(readFileSync(out, 'utf8'))
    if (cached.spacing === SPACING && cached.dataset === DATASET && cached.sourceSha1 === sha1) {
      return { ...course, out, skipped: true, samples: cached.ele.length, batches: 0 }
    }
  }

  const latlng = parseGpx(course.path).points.map((p) => [p.lat, p.lng])
  const samples = resample(latlng, SPACING)
  return { ...course, out, sha1, lengthM: pathLength(latlng), samplePts: samples, samples: samples.length, batches: Math.ceil(samples.length / BATCH) }
}

async function buildCourse(course) {
  const { out, sha1, lengthM, samplePts: samples, batches } = course
  process.stdout.write(
    `  ${course.key.padEnd(7)}${(lengthM / 1000).toFixed(2).padStart(6)}km  ` +
      `${String(samples.length).padStart(4)}점 / ${String(batches).padStart(2)}요청 `,
  )

  const ele = []
  for (let i = 0; i < samples.length; i += BATCH) {
    if (i > 0) await sleep(DELAY_MS)
    ele.push(...(await fetchBatch(samples.slice(i, i + BATCH))))
    process.stdout.write('.')
  }

  const nulls = ele.filter((v) => v == null).length
  const known = ele.filter((v) => v != null)

  writeFileSync(
    out,
    JSON.stringify({
      file: course.file,
      id: course.id,
      sourceSha1: sha1,
      dataset: DATASET,
      interpolation: INTERPOLATION,
      spacing: SPACING,
      lengthM: Math.round(lengthM),
      // 재현 및 검증을 위해 샘플 좌표도 함께 보관한다
      lat: samples.map((p) => +p.lat.toFixed(6)),
      lng: samples.map((p) => +p.lng.toFixed(6)),
      dist: samples.map((p) => Math.round(p.d)),
      ele,
    }),
  )

  process.stdout.write(
    ` ok  ${known.length ? `${Math.min(...known)}~${Math.max(...known)}m` : '값없음'}` +
      `${nulls ? `  ⚠ null ${nulls}개` : ''}\n`,
  )

  return { ...course, skipped: false, samples: ele.length, nulls }
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true })

  const trails = TRAIL_IDS ? TRAILS.filter((t) => TRAIL_IDS.includes(t.id)) : TRAILS.filter((t) => t.enabled)
  if (!trails.length) throw new Error(`대상 길이 없다: ${TRAIL_IDS ?? '(enabled 없음)'}`)

  let courses = trails.flatMap((t) => listCourses(t).map((c) => ({ ...c, trail: t })))
  if (ONLY) courses = courses.filter((c) => ONLY.has(c.id))

  const plans = courses.map(planCourse)
  const todo = plans.filter((p) => !p.skipped)
  const need = todo.reduce((s, p) => s + p.batches, 0)
  console.log(
    `DEM 고도 조회 — ${DATASET} / ${INTERPOLATION} / ${SPACING}m 간격\n` +
      `대상 ${trails.map((t) => t.name).join(', ')} ${plans.length}개 코스${FORCE ? ' (--force)' : ''} — ` +
      `캐시 재사용 ${plans.length - todo.length}, 조회 ${todo.length}개 코스\n` +
      `예상 요청 ${need}회 (상한 ${MAX_REQUESTS}, opentopodata 하루 1,000회)\n`,
  )
  if (DRY) return

  const done = []
  let requests = 0
  let stopped = 0
  for (const p of todo) {
    // 코스 중간에 끊지 않는다. 이 코스를 다 받으면 상한을 넘는다면 여기서 멈춘다
    if (requests + p.batches > MAX_REQUESTS) {
      stopped = todo.length - done.length
      break
    }
    try {
      const r = await buildCourse(p)
      done.push(r)
      requests += p.batches
    } catch (e) {
      console.error(`\n  ✗ ${p.file}: ${e.message}`)
      console.error('   중단한다. 원인을 해결하고 다시 실행하면 이어서 진행한다.')
      process.exitCode = 1
      return
    }
  }

  const samples = done.reduce((s, r) => s + r.samples, 0)
  const nulls = done.reduce((s, r) => s + (r.nulls ?? 0), 0)
  console.log(
    `\n완료 — 조회 ${done.length}개 코스 / 샘플 ${samples.toLocaleString()}점 / 요청 ${requests}회 / ` +
      `캐시 재사용 ${plans.length - todo.length}개` +
      (nulls ? `\n⚠ 고도 null ${nulls}점 — DEM 공백 구간이다. 보간 필요.` : ''),
  )
  // 상한에서 멈춘 것은 실패가 아니다. 캐시가 남으므로 다음 실행(다음 날)이 이어서 한다
  if (stopped) console.log(`⚠ 요청 상한 ${MAX_REQUESTS}회에 닿아 ${stopped}개 코스를 남겼다. 다시 실행하면 이어서 한다.`)
  console.log(`캐시: ${CACHE_DIR}/  (커밋해서 재조회를 없앤다)`)
  console.log('다음: npm run build:data')
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`)
  process.exitCode = 1
})
