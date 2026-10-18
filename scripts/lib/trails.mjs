/**
 * 코리아둘레길 4개 길. 값은 두루누비에서 확인한 것이다(2026-10-18).
 *
 *   routeIdx    공공 API(routeList) 의 길 고유번호
 *   serviceFlag 두루누비 사이트 목록 화면(`{slug}-course-list.do`)이 쓰는 길 구분값
 *   slug        두루누비 코스 목록 페이지 이름 — 출처 표기 링크가 된다
 *   span        화면 머리말에 쓰는 구간 설명
 *   gpxDir      공식 GPX 원본을 받은 그대로 두는 폴더
 *   manifest    코스 기록 + GPX 지문(SHA1) — 동기화가 갱신하고 빌드가 읽는다
 *   metaCsv     공식 자료의 오타·빈칸만 고치는 보정 CSV (없어도 된다)
 *   cautions    여행자정보에서 출입 통제·신분증·예약 안내 줄을 뽑아 코스 카드 위에 보인다 (DMZ 평화의 길만.
 *               다른 길은 같은 낱말이 정류장 이름·체험 예약에 쓰여 엉뚱한 줄이 잡힌다)
 *   keyPrefix   고도 캐시 등 파생 파일 이름의 접두어 (nam-07, hae-07 …). 남파랑길 값은 바꾸지 않는다
 *
 * `enabled` 가 false 인 길은 동기화·빌드·화면에서 빠진다.
 */
export const TRAILS = [
  {
    id: 'namparang',
    name: '남파랑길',
    routeIdx: 'T_ROUTE_MNG0000000001',
    serviceFlag: 'NA',
    slug: 'namparang',
    span: '부산 오륙도 → 해남 땅끝탑',
    gpxDir: 'data/gpx_durunubi',
    manifest: 'data/durunubi/namparang.json',
    metaCsv: 'data/courses.meta.csv',
    keyPrefix: 'nam',
    enabled: true,
  },
  {
    id: 'haeparang',
    name: '해파랑길',
    routeIdx: 'T_THEME_MNG0000011235',
    serviceFlag: 'HE',
    slug: 'haeparang',
    span: '부산 오륙도 → 고성 통일전망대',
    gpxDir: 'data/durunubi/gpx/haeparang',
    manifest: 'data/durunubi/haeparang.json',
    metaCsv: 'data/courses.meta.haeparang.csv',
    keyPrefix: 'hae',
    enabled: true,
  },
  {
    id: 'seohaerang',
    name: '서해랑길',
    routeIdx: 'T_ROUTE_MNG0000000043',
    serviceFlag: 'SEO',
    slug: 'seohaerang',
    span: '해남 땅끝 → 인천 강화',
    gpxDir: 'data/durunubi/gpx/seohaerang',
    manifest: 'data/durunubi/seohaerang.json',
    metaCsv: 'data/courses.meta.seohaerang.csv',
    keyPrefix: 'seo',
    enabled: true,
  },
  {
    id: 'dmz',
    name: 'DMZ 평화의 길',
    routeIdx: 'T_ROUTE_MNG0000000047',
    serviceFlag: 'DMZ',
    slug: 'dmz',
    span: '인천 강화 → 강원 고성',
    gpxDir: 'data/durunubi/gpx/dmz',
    manifest: 'data/durunubi/dmz.json',
    metaCsv: 'data/courses.meta.dmz.csv',
    keyPrefix: 'dmz',
    cautions: true,
    enabled: false,
  },
]

export const trailById = (id) => TRAILS.find((t) => t.id === id)

/** 길의 두루누비 코스 목록 페이지. 공공누리 출처표시에 쓴다. */
export const listUrl = (trail) => `https://www.durunubi.kr/${trail.slug}-course-list.do`
