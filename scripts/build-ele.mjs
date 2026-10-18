/**
 * 단계 2a — DEM 고도 확보
 *
 * 모든 고도 지표를 SRTM 30m DEM에서 직접 산출한다.
 *
 * 두루누비 공식 GPX 에도 <ele> 가 있지만 쓰지 않는다. 37개 코스에 고도가 빠진 점이 있고
 * (55코스는 26/614점), 49코스는 대부분 0, 5·51코스는 해수면 아래(-7m)로 내려간다.
 * 제작 도구도 4종이 섞여 있어 코스마다 기준이 다르다. DEM 은 90개가 같은 기준이다.
 *
 * 전략
 *  - 124,173개 원본 트랙포인트를 전부 조회하지 않는다. 50m 균일 간격으로
 *    재샘플링해 약 30,000점으로 줄인다 (opentopodata 일일 한도 1,000요청 안쪽).
 *  - 코스 하나가 끝나면 즉시 캐시에 쓴다. 중단되면 다시 실행하면 이어서 진행한다.
 *  - 캐시를 리포에 커밋하므로 재빌드 때 재조회가 없고 오프라인 빌드가 된다.
 *  - 캐시에 원본 GPX 의 SHA1 을 남긴다. GPX 가 바뀌면(노선 교체 등) 그 코스만 다시 조회한다.
 *
 * 사용법
 *   node scripts/build-ele.mjs                # 캐시 없는 코스만
 *   node scripts/build-ele.mjs --force        # 전부 다시
 *   node scripts/build-ele.mjs --only=23,54   # 특정 코스만
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listCourses, sourceSha1 } from './lib/gpx.mjs'
import { resample, pathLength } from './lib/geo.mjs'

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

async function buildCourse(course) {
  const out = join(CACHE_DIR, `${course.key}.json`)
  const sha1 = sourceSha1(course.path)

  if (!FORCE && existsSync(out)) {
    const cached = JSON.parse(readFileSync(out, 'utf8'))
    if (cached.spacing === SPACING && cached.dataset === DATASET && cached.sourceSha1 === sha1) {
      return { ...course, skipped: true, samples: cached.ele.length }
    }
  }

  const { parseGpx } = await import('./lib/gpx.mjs')
  const { points } = parseGpx(course.path)
  const latlng = points.map((p) => [p.lat, p.lng])
  const lengthM = pathLength(latlng)
  const samples = resample(latlng, SPACING)

  const batches = Math.ceil(samples.length / BATCH)
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

  let courses = listCourses()
  if (ONLY) courses = courses.filter((c) => ONLY.has(c.id))

  const totalSamples = courses.length
  console.log(
    `DEM 고도 조회 — ${DATASET} / ${INTERPOLATION} / ${SPACING}m 간격\n` +
      `대상 ${totalSamples}개 코스${FORCE ? ' (--force)' : ''}\n`,
  )

  const done = []
  let skipped = 0
  let requests = 0

  for (const c of courses) {
    try {
      const r = await buildCourse(c)
      done.push(r)
      if (r.skipped) skipped++
      else requests += Math.ceil(r.samples / BATCH)
    } catch (e) {
      console.error(`\n  ✗ ${c.file}: ${e.message}`)
      console.error('   중단한다. 원인을 해결하고 다시 실행하면 이어서 진행한다.')
      process.exitCode = 1
      return
    }
  }

  const samples = done.reduce((s, r) => s + r.samples, 0)
  const nulls = done.reduce((s, r) => s + (r.nulls ?? 0), 0)
  console.log(
    `\n완료 — ${done.length}개 코스 / 샘플 ${samples.toLocaleString()}점 / ` +
      `신규 요청 ${requests}회 / 캐시 재사용 ${skipped}개` +
      (nulls ? `\n⚠ 고도 null ${nulls}점 — DEM 공백 구간이다. 보간 필요.` : ''),
  )
  console.log(`캐시: ${CACHE_DIR}/  (커밋해서 재조회를 없앤다)`)
  console.log('다음: npm run build:data')
}

main()
