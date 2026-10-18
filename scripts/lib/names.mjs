/**
 * 코스 지점명·지역 보정.
 *
 * 지점명·주소·교통편은 두루누비 공식 안내문에서 옮긴 `data/courses.meta.csv` 가 원천이다.
 * 공식 GPX 의 트랙 이름(`<trk><name>`)은 대부분 `GPX`·`Path` 이고 나머지도 형식이
 * 제각각이라 지점명을 뽑지 않는다.
 *
 * 여기 남은 것은 CSV 값을 서로 맞추는 보정뿐이다. 지점명을 지어내지 않는다.
 */

/**
 * 지점명에서 앞머리 행정구역(시/군/구)을 뽑는다.
 *
 * 주의: `\b` 를 쓰면 안 된다. JS의 `\b` 는 `[A-Za-z0-9_]` 기준이라
 * 한글 뒤에서는 경계가 성립하지 않아 전부 실패한다. `(?=\s|$)` 를 쓴다.
 */
export function extractRegion(place) {
  if (!place) return ''
  const s = place.trim()
  const m = /^([가-힣]{2,4}(?:특별자치시|특별자치도|광역시|특별시|시|군|구))(?=\s|$)/.exec(s)
  if (m) return m[1]
  // '순천 별량면 …' 처럼 시/군 접미사가 빠진 경우
  const m2 = /^([가-힣]{2,3})\s+[가-힣]{1,4}(?:면|읍|동|리)(?=\s|$)/.exec(s)
  return m2 ? m2[1] : ''
}

/** 접합부를 공유하는 필드 쌍. 앞 코스의 종점 값 = 다음 코스의 시점 값. */
const DEFAULT_PAIRS = [
  ['start', 'end'],
  ['startAddr', 'endAddr'],
  ['startAccess', 'endAccess'],
]

/**
 * 코스가 연속이라는 성질로 빈 지점명을 메운다.
 * 앞 코스의 종점 = 다음 코스의 시점.
 *
 * 접합부 89곳이 모두 131m 이내로 검증됐으므로(data/raw/durunubi-gpx.json) 이 전제는 안전하다.
 * 연속된 공백 구간의 내부는 메울 수 없다 — 경계만 채워진다.
 *
 * @param {Array<{seq:number, start:string, end:string, region:string}>} rows  seq 오름차순
 */
export function chainFill(rows, pairs = DEFAULT_PAIRS) {
  const filled = { start: 0, end: 0, region: 0 }

  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1]
    const next = rows[i + 1]
    // 접합부를 공유하는 모든 필드에 같은 규칙을 적용한다.
    // 지점명뿐 아니라 주소·교통편도 "앞 코스 종점 = 다음 코스 시점"이다.
    for (const [startKey, endKey] of pairs) {
      if (!rows[i][startKey] && prev?.[endKey]) {
        rows[i][startKey] = prev[endKey]
        rows[i][`${startKey}Source`] = 'chain'
        if (startKey === 'start') filled.start++
      }
      if (!rows[i][endKey] && next?.[startKey]) {
        rows[i][endKey] = next[startKey]
        rows[i][`${endKey}Source`] = 'chain'
        if (endKey === 'end') filled.end++
      }
    }
  }

  // 지점명이 채워졌으면 지역도 다시 시도
  for (const r of rows) {
    if (!r.region) {
      const reg = extractRegion(r.start) || extractRegion(r.end)
      if (reg) {
        r.region = reg
        r.regionSource = 'chain'
        filled.region++
      }
    }
  }

  return filled
}

/**
 * 접합부 라벨을 통일한다.
 *
 * 같은 장소인데 코스마다 표기가 다른 경우가 7곳 있다. 예:
 *   `송정공원` vs `강서구 송정공원`                      (행정구역 접두어 누락)
 *   `장승포시외버스정류장` vs `장승포 시외버스터미널`      (정류장/터미널)
 *   `부용교 동쪽사거리` vs `부굥교 동쪽사거리`            (원본 오타)
 *
 * 좌표상 접합부 89곳이 모두 131m 이내로 검증됐으므로(data/raw/durunubi-gpx.json)
 * 이들은 확실히 같은 지점이다. 더 상세한(긴) 쪽으로 양쪽을 맞춘다.
 *
 * @returns {Array<{seq:number, from:string, to:string}>} 변경 내역
 */
export function normalizeJunctions(rows) {
  const changes = []
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]
    const b = rows[i + 1]
    if (!a.end || !b.start || a.end === b.start) continue

    const pick = a.end.length >= b.start.length ? a.end : b.start
    const other = pick === a.end ? b.start : a.end
    changes.push({ seq: a.seq, from: other, to: pick })
    a.end = pick
    b.start = pick
  }
  return changes
}

/**
 * 지역명을 통일한다. 같은 곳이 `순천시`/`순천` 두 표기로 나오는 문제.
 * 접미사가 빠진 이름은, 데이터셋 안에 `+시`/`+군` 형태가 있으면 그쪽으로 맞춘다.
 */
export function normalizeRegions(rows) {
  const known = new Set(rows.map((r) => r.region).filter(Boolean))
  const changes = []
  for (const r of rows) {
    if (!r.region || /(시|군|구|도)$/.test(r.region)) continue
    const cand = ['시', '군'].map((s) => r.region + s).find((x) => known.has(x))
    if (cand) {
      changes.push({ seq: r.seq, from: r.region, to: cand })
      r.region = cand
    }
  }
  return changes
}
