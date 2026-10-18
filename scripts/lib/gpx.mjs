import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import { haversine } from './geo.mjs'

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
 * 코스 번호 -> 길 안의 id 와 파생 파일 키.
 *   남파랑길 7코스     -> {id:'7',    key:'nam-07'}
 *   서해랑길 64-1코스  -> {id:'64-1', key:'seo-64-1'}
 *
 * 남파랑길 키는 예전 파일명 규칙에서 나온 것과 같다. 고도 캐시(data/cache/ele/<key>.json)를 그대로 쓴다.
 */
export function courseKey(trail, seq, sub = 0) {
  const id = sub ? `${seq}-${sub}` : String(seq)
  return { id, key: `${trail.keyPrefix}-${String(seq).padStart(2, '0')}${sub ? `-${sub}` : ''}` }
}

/** 파생 파일(고도 캐시)이 어느 원본 GPX 에서 나왔는지 확인하는 지문. */
export function sourceSha1(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/**
 * 길 하나의 GPX 를 코스 순서대로 나열한다.
 * 파일명이 아니라 대조표(trail.manifest)의 seq·sub 로 코스를 식별한다. 파일명은 두루누비가 주는 대로라
 * 길마다 규칙이 다를 수 있다. 출처에서 사라진 코스(missingSince)도 파일이 남아 있으면 포함한다.
 */
export function listCourses(trail) {
  if (!existsSync(trail.manifest)) throw new Error(`${trail.manifest} 가 없다. 먼저 npm run sync:durunubi -- --trail=${trail.id}`)
  const { courses } = JSON.parse(readFileSync(trail.manifest, 'utf8'))
  const out = courses.map((c) => ({
    file: c.file,
    path: join(trail.gpxDir, c.file),
    seq: c.seq,
    sub: c.sub,
    ...courseKey(trail, c.seq, c.sub),
  }))
  const lost = out.filter((c) => !existsSync(c.path))
  if (lost.length) throw new Error(`대조표에 있는데 GPX 가 없다: ${lost.map((c) => c.path).join(', ')}`)
  return out.sort((a, b) => a.seq - b.seq || a.sub - b.sub)
}
