import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { haversine } from './geo.mjs'

/** 두루누비(한국관광공사) 공식 GPX. 사용자가 사이트에서 직접 내려받은 원본 그대로다. */
export const GPX_DIR = 'data/gpx_durunubi'

/** 뒤쪽 트랙이 첫 트랙 시점에서 이 거리 안에서 시작하면 같은 노선의 다른 판본으로 본다. */
const DUPLICATE_TRACK_M = 500

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // 코스가 1개뿐인 파일에서도 배열로 받아 분기를 없앤다
  isArray: (name) => name === 'trk' || name === 'trkseg' || name === 'trkpt',
})

/**
 * <trkpt> 를 컨테이너 이름과 무관하게 문서 순서대로 모은다.
 *
 * 공식 GPX 90개는 모두 표준 <trkseg> 지만, 원본을 한 바이트도 고치지 않는다는 방침
 * (data/SOURCE.md)이라 비표준 컨테이너(<trkseq> 같은 오타)가 섞인 파일이 와도 읽히게 둔다.
 */
function collectTrkpts(node, out) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectTrkpts(item, out)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@')) continue
    if (key === 'trkpt') {
      for (const p of Array.isArray(value) ? value : [value]) out.push(p)
    } else if (value !== null && typeof value === 'object') {
      collectTrkpts(value, out)
    }
  }
}

/**
 * GPX 파일 하나를 읽는다.
 * @returns {{name: string, points: Array<{lat:number, lng:number, ele:number|null}>, nonstandard: boolean, duplicateTracks: number}}
 */
export function parseGpx(path) {
  const doc = parser.parse(readFileSync(path, 'utf8'))
  const gpx = doc?.gpx
  if (!gpx) throw new Error(`${path}: <gpx> 루트를 찾을 수 없다`)

  const trks = gpx.trk ?? []
  const name = trks.find((t) => t.name != null)?.name
  let nonstandard = false

  const trackPoints = trks.map((trk) => {
    const out = []
    if (trk.trkseg) {
      for (const seg of trk.trkseg) collectTrkpts(seg, out)
    } else {
      // 표준 <trkseg> 가 없다 — 컨테이너 이름을 무시하고 긁는다
      nonstandard = true
      collectTrkpts(trk, out)
    }
    return out
  })

  // 같은 노선이 트랙 여러 개로 반복 수록된 파일이 있다 (남파랑길_86코스.gpx: 약 25km 트랙 2개,
  // 시·종점이 같고 경로는 최대 391m 차이). 이어 붙이면 64km 가 되고 종점→시점 14km 직선이 생긴다.
  // 원본은 고치지 않는다는 방침이므로 첫 트랙만 쓴다.
  const startOf = (pts) => pts[0] && [Number(pts[0]['@lat']), Number(pts[0]['@lon'])]
  const first = startOf(trackPoints[0] ?? [])
  const duplicates =
    first && trackPoints.length > 1 &&
    trackPoints.slice(1).every((pts) => pts.length && haversine(first, startOf(pts)) <= DUPLICATE_TRACK_M)
  const raw = duplicates ? trackPoints[0] : trackPoints.flat()
  const duplicateTracks = duplicates ? trackPoints.length - 1 : 0

  const points = []
  for (const p of raw) {
    const lat = Number(p['@lat'])
    const lng = Number(p['@lon'])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const ele = p.ele == null ? NaN : Number(p.ele)
    points.push({ lat, lng, ele: Number.isFinite(ele) ? ele : null })
  }

  if (points.length === 0) throw new Error(`${path}: 트랙포인트가 없다`)
  return { name: name == null ? '' : String(name).trim(), points, nonstandard, duplicateTracks }
}

/**
 * 남파랑길_7코스.gpx -> {id:'7', seq:7, key:'nam-07'}
 *
 * 파일명은 두루누비가 내려준 이름 그대로다. 고도 캐시 등 파생 파일은 `key` 로 이름 짓는다.
 */
export function parseCourseId(file) {
  const m = /^남파랑길_(\d+)코스\.gpx$/.exec(basename(file))
  if (!m) throw new Error(`${file}: 파일명 규칙(남파랑길_N코스.gpx)에 맞지 않는다`)
  const seq = Number(m[1])
  return { id: String(seq), seq, key: `nam-${String(seq).padStart(2, '0')}` }
}

/** 파생 파일(고도 캐시)이 어느 원본 GPX 에서 나왔는지 확인하는 지문. */
export function sourceSha1(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/** GPX_DIR 의 모든 GPX를 코스 순서대로 나열한다. */
export function listCourses(dir = GPX_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.gpx'))
    .map((f) => ({ file: f, path: join(dir, f), ...parseCourseId(f) }))
    .sort((a, b) => a.seq - b.seq)
}
