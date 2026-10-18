/**
 * 두루누비 코스 동기화 — 바뀐 것만 받는다.
 *
 *   1. 길마다 공공 API + 사이트 목록을 받아 합친다 (scripts/lib/durunubi.mjs)
 *   2. 이전 기록(manifest)과 비교해 GPX 를 받을 코스를 고른다
 *        - 로컬 파일이 없다 / GPX 경로가 바뀌었다 / 공공 API 수정일이 바뀌었다
 *        - 서버 파일 크기(HEAD)가 기록과 다르다
 *        - --full: 전부 다시 받아 SHA1 로 비교
 *   3. 받은 GPX 는 바이트 그대로 저장하고(변경금지) SHA1 을 기록한다
 *   4. 코스가 출처에서 사라지면 **지우지 않고** 경고만 남긴다. 판단은 사람이 한다
 *
 * 바뀐 것이 있으면 manifest 를 다시 쓰고, 이어서 build:ele → build:data 를 돌리면 된다.
 * CI(.github/workflows/sync-durunubi.yml)는 GITHUB_OUTPUT 의 changed 로 다음 단계를 정한다.
 *
 * 사용법
 *   npm run sync:durunubi                  # 켜진(enabled) 길 전부, 바뀐 것만
 *   npm run sync:durunubi -- --full        # GPX 전부 다시 받아 비교
 *   npm run sync:durunubi -- --trail=haeparang   # 꺼진 길도 이름을 대면 받는다
 *   npm run sync:durunubi -- --dry-run     # 무엇이 바뀌었는지만 보고 쓰지 않는다
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { TRAILS } from './lib/trails.mjs'
import { parseGpx } from './lib/gpx.mjs'
import { haversine } from './lib/geo.mjs'
import {
  serviceKey,
  fetchPublicCourses,
  fetchSiteCourses,
  mergeCourses,
  gpxLength,
  downloadGpx,
} from './lib/durunubi.mjs'

const argv = process.argv.slice(2)
const FULL = argv.includes('--full')
const DRY = argv.includes('--dry-run')
const ONLY = argv.find((a) => a.startsWith('--trail='))?.slice(8).split(',')

/** 요약에 넣을 목록. 첫 동기화처럼 많으면 앞부분만 보인다. */
const list = (xs, sep = ', ') => (xs.length > 15 ? `${xs.slice(0, 15).join(sep)}${sep}… 외 ${xs.length - 15}` : xs.join(sep))

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** manifest 에서 비교할 메타데이터. 이 값이 바뀌면 GPX 가 같아도 빌드를 다시 한다. */
const META_KEYS = [
  'name', 'seq', 'sub', 'label', 'source', 'km', 'minutes', 'level', 'levelLabel', 'cycle', 'sigun',
  'travelerInfo', 'summary', 'contents', 'tourInfo', 'warning', 'startAddress', 'endAddress', 'startLatLng', 'endLatLng',
  'publicModified', 'gpxFilePath', 'file',
]

/** 이 거리를 넘으면 코스가 끊겼거나 공식 경계와 어긋난 것으로 보고 경고한다. */
const GAP_WARN_M = 500

/**
 * 본 코스(지선·우회 제외)의 연결성 점검.
 *   junction  앞 코스 종점 ↔ 다음 코스 시점 (구간 선택 기능의 전제)
 *   endpoint  GPX 시·종점 ↔ 공식 시·종점 좌표
 */
function continuity(trail, courses) {
  const main = courses.filter((c) => !c.sub && !c.missingSince).sort((a, b) => a.seq - b.seq)
  const ends = main.map((c) => {
    const pts = parseGpx(join(trail.gpxDir, c.file)).points
    return { c, first: [pts[0].lat, pts[0].lng], last: [pts.at(-1).lat, pts.at(-1).lng] }
  })
  const junctions = []
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].c.seq !== ends[i - 1].c.seq + 1) continue
    junctions.push({ at: `${ends[i - 1].c.seq}/${ends[i].c.seq}`, m: Math.round(haversine(ends[i - 1].last, ends[i].first)) })
  }
  const endpoints = ends.flatMap(({ c, first, last }) => [
    { at: `${c.seq} 시점`, m: Number.isFinite(c.startLatLng[0]) ? Math.round(haversine(first, c.startLatLng)) : 0 },
    { at: `${c.seq} 종점`, m: Number.isFinite(c.endLatLng[0]) ? Math.round(haversine(last, c.endLatLng)) : 0 },
  ])
  const max = (xs) => xs.reduce((a, b) => (b.m > a.m ? b : a), { at: '', m: 0 })
  return {
    maxJunctionGap: max(junctions),
    maxEndpointToOfficial: max(endpoints),
    warnings: [...junctions, ...endpoints].filter((x) => x.m > GAP_WARN_M),
  }
}

function readManifest(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function syncTrail(trail, key) {
  const log = []
  const say = (s) => {
    log.push(s)
    console.log(s)
  }

  const [pub, site] = await Promise.all([fetchPublicCourses(trail.routeIdx, key), fetchSiteCourses(trail.serviceFlag)])
  const fresh = mergeCourses(trail, pub, site)
  const fromPublic = fresh.filter((c) => c.source === 'public').length
  say(`\n## ${trail.name}`)
  say(`- 코스 ${fresh.length}개 (공공 API ${fromPublic} · 사이트 목록 보충 ${fresh.length - fromPublic})`)

  const prev = readManifest(trail.manifest)
  const prevById = new Map((prev?.courses ?? []).map((c) => [c.crsIdx, c]))
  const freshIds = new Set(fresh.map((c) => c.crsIdx))

  const added = []
  const metaChanged = []
  const gpxChanged = []
  const out = []

  for (const c of fresh) {
    const old = prevById.get(c.crsIdx)
    const path = join(trail.gpxDir, c.file)
    const local = existsSync(path) ? readFileSync(path) : null

    // GPX 를 받을지 정한다
    let reason = null
    if (FULL) reason = '전체 재검증'
    else if (!local) reason = '로컬 파일 없음'
    else if (old && old.gpxFilePath !== c.gpxFilePath) reason = 'GPX 경로 변경'
    else if (old && c.publicModified && old.publicModified !== c.publicModified) reason = '공공 API 수정일 변경'
    else {
      const len = await gpxLength(c.gpxFilePath)
      await sleep(150)
      if (len != null && len !== local.length) reason = `파일 크기 변경 ${local.length}→${len}`
    }

    let buf = local
    if (reason) {
      buf = await downloadGpx(c.gpxFilePath)
      await sleep(300)
    }
    const hash = sha1(buf)
    const changedGpx = !local || sha1(local) !== hash
    if (changedGpx) {
      gpxChanged.push(`${c.name} (${reason})`)
      if (!DRY) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, buf)
      }
    }

    const rec = { ...c, sha1: hash, bytes: buf.length }
    if (!old) added.push(c.name)
    else if (META_KEYS.some((k) => JSON.stringify(old[k]) !== JSON.stringify(rec[k]))) {
      const keys = META_KEYS.filter((k) => JSON.stringify(old[k]) !== JSON.stringify(rec[k]))
      metaChanged.push(`${c.name}: ${keys.join(', ')}`)
    }
    out.push(rec)
  }

  // 출처에서 사라진 코스는 지우지 않는다. 일시적 누락일 수 있고, 지우면 사진 기록의 코스가 사라진다.
  const vanished = (prev?.courses ?? []).filter((c) => !freshIds.has(c.crsIdx))
  for (const c of vanished) out.push({ ...c, missingSince: c.missingSince ?? new Date().toISOString().slice(0, 10) })
  out.sort((a, b) => a.seq - b.seq || a.sub - b.sub)

  // 연결성은 GPX 가 바뀌었거나 이전 기록에 없을 때만 다시 잰다 (드라이런이면 새 파일이 디스크에 없다)
  const checks = !DRY && (gpxChanged.length || !prev?.checks) ? continuity(trail, out) : prev?.checks
  if (checks?.warnings?.length) {
    say(`- ⚠️ 연결성 경고 (${GAP_WARN_M}m 초과): ${list(checks.warnings.map((w) => `${w.at} ${w.m}m`))}`)
  }

  // 같은 내용이면 파일을 다시 쓰지 않는다 (checkedAt 만 바뀌는 커밋을 만들지 않는다)
  const changed = added.length + metaChanged.length + gpxChanged.length > 0 ||
    vanished.some((c) => !prevById.get(c.crsIdx)?.missingSince) ||
    JSON.stringify(checks) !== JSON.stringify(prev?.checks)
  if (changed && !DRY) {
    mkdirSync(dirname(trail.manifest), { recursive: true })
    writeFileSync(
      trail.manifest,
      JSON.stringify(
        {
          trail: trail.id,
          name: trail.name,
          routeIdx: trail.routeIdx,
          source: {
            public: '공공데이터포털 한국관광공사 두루누비 정보 서비스 (apis.data.go.kr/B551011/Durunubi)',
            site: '두루누비 사이트 코스 목록 (www.durunubi.kr/api/course/list) — 공공 API 에 없는 코스 보충',
            license: '공공누리 제4유형 (출처표시 + 상업적이용금지 + 변경금지) — 두루누비 표기. 공공데이터포털 API 는 이용허락범위 제한 없음, 더 엄격한 쪽을 지킨다',
          },
          updatedAt: new Date().toISOString(),
          checks,
          courses: out,
        },
        null,
        1,
      ) + '\n',
    )
  }

  if (added.length) say(`- 새 코스 ${added.length}: ${list(added)}`)
  if (gpxChanged.length) say(`- GPX 변경 ${gpxChanged.length}: ${list(gpxChanged, ' / ')}`)
  if (metaChanged.length) say(`- 정보 변경 ${metaChanged.length}: ${list(metaChanged, ' / ')}`)
  if (vanished.length) say(`- ⚠️ 출처에서 사라진 코스 ${vanished.length} (지우지 않음): ${vanished.map((c) => c.name).join(', ')}`)
  if (!changed) say('- 변경 없음')

  return { trail, changed, gpxChanged: gpxChanged.length, log }
}

async function main() {
  const key = serviceKey()
  const targets = ONLY ? TRAILS.filter((t) => ONLY.includes(t.id)) : TRAILS.filter((t) => t.enabled)
  if (!targets.length) throw new Error(`대상 길이 없다: ${ONLY ?? '(enabled 없음)'}`)
  console.log(`두루누비 동기화 — ${targets.map((t) => t.name).join(', ')}${FULL ? ' (--full)' : ''}${DRY ? ' (--dry-run)' : ''}`)

  const results = []
  for (const t of targets) results.push(await syncTrail(t, key))

  const changed = results.some((r) => r.changed)
  const gpx = results.reduce((s, r) => s + r.gpxChanged, 0)

  // CI 연동: 다음 단계 조건과 커밋 메시지·요약
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\ngpx_changed=${gpx > 0}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# 두루누비 동기화\n${results.flatMap((r) => r.log).join('\n')}\n`)
  }
  if (changed && !DRY) {
    mkdirSync('scratch', { recursive: true })
    writeFileSync(
      'scratch/sync-message.txt',
      `코스 데이터 동기화 (두루누비)\n\n${results.flatMap((r) => r.log).join('\n').trim()}\n`,
    )
  }
  console.log(changed ? `\n변경 있음${gpx ? ` (GPX ${gpx}개)` : ''} — 다음: npm run build:ele && npm run build:data` : '\n변경 없음')
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`)
  process.exitCode = 1
})
