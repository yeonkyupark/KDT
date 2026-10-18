/**
 * 코리아둘레길 4개 길. 값은 두루누비에서 확인한 것이다(2026-10-18).
 *
 *   routeIdx    공공 API(routeList) 의 길 고유번호
 *   serviceFlag 두루누비 사이트 목록 화면(`{slug}-course-list.do`)이 쓰는 길 구분값
 *   gpxDir      공식 GPX 원본을 받은 그대로 두는 폴더
 *   manifest    코스 기록 + GPX 지문(SHA1) — 동기화가 갱신하고 빌드가 읽는다
 *
 * `enabled` 가 false 인 길은 동기화·빌드에서 건너뛴다. 지금 앱은 남파랑길만 그린다.
 */
export const TRAILS = [
  {
    id: 'namparang',
    name: '남파랑길',
    routeIdx: 'T_ROUTE_MNG0000000001',
    serviceFlag: 'NA',
    gpxDir: 'data/gpx_durunubi',
    manifest: 'data/durunubi/namparang.json',
    enabled: true,
  },
  {
    id: 'haeparang',
    name: '해파랑길',
    routeIdx: 'T_THEME_MNG0000011235',
    serviceFlag: 'HE',
    gpxDir: 'data/durunubi/gpx/haeparang',
    manifest: 'data/durunubi/haeparang.json',
    enabled: false,
  },
  {
    id: 'seohaerang',
    name: '서해랑길',
    routeIdx: 'T_ROUTE_MNG0000000043',
    serviceFlag: 'SEO',
    gpxDir: 'data/durunubi/gpx/seohaerang',
    manifest: 'data/durunubi/seohaerang.json',
    enabled: false,
  },
  {
    id: 'dmz',
    name: 'DMZ 평화의 길',
    routeIdx: 'T_ROUTE_MNG0000000047',
    serviceFlag: 'DMZ',
    gpxDir: 'data/durunubi/gpx/dmz',
    manifest: 'data/durunubi/dmz.json',
    enabled: false,
  },
]

export const trailById = (id) => TRAILS.find((t) => t.id === id)
