# KDT — 코리아둘레길 가이드

한반도 가장자리를 한 바퀴 잇는 **코리아둘레길**(Korea Dulle-gil Trail)의 코스를
지도에서 보고 구간을 골라 계획하고, 걸으면서 찍은 사진과 메모를 위치에 남기는 개인용 웹앱.

**https://yeonkyupark.github.io/KDT/**

## 지원하는 길

코리아둘레길은 4개 길로 이뤄진다. 한 지도에 4개 길을 모두 그리지 않고,
**길을 하나 골라 그 길만 자세히** 보여 주는 구조로 넓혀 가고 있다.

| 길 | 구간 | 코스 | 상태 |
|---|---|---|---|
| **남파랑길** | 부산 오륙도 → 해남 땅끝 | 90 | ✅ 지원 · 매주 자동 갱신 |
| **해파랑길** | 부산 오륙도 → 고성 통일전망대 | 50 | ✅ 지원 · 매주 자동 갱신 (지점명은 공식 주소로 표시) |
| **서해랑길** | 해남 땅끝 → 인천 강화 | 본선 103 + 지선 6 | ✅ 지원 · 매주 자동 갱신 (지선은 점선) |
| DMZ 평화의 길 | 인천 강화 → 강원 고성 | 본선 34 + 우회로 13 · 지선 1 | 작업 중 (고도 조회 26/48) |

머리말의 메뉴에서 길을 고른다. 주소에 `?trail=haeparang` 처럼 남고, 다음에 열면 마지막으로 본 길이 열린다.
길 없이 구간만 적힌 예전 주소(`?from=17&to=23`)는 남파랑길로 열린다.
확장 순서·길별 특수 사항·진행 현황은 **[TRAILS.md](TRAILS.md)**.

## 무엇을 하는가

- **길을 골라 그 길의 코스 전체를 지도에** 난이도별 색으로 표시. 다른 길 데이터는 받지 않는다
- **시작 코스 ~ 종료 코스를 골라** 구간의 거리 · 예상 소요시간 · 누적 상승/하강 · 난이도를 한 번에 확인.
  선택 구간은 진하게, 나머지는 흐리게. 상태는 URL에 남아 공유·북마크가 된다 (`?trail=haeparang&from=19&to=23`)
- **지선** — 서해랑길 64-1~64-6 처럼 본선에서 갈라졌다 합류하는 길은 지도에 점선으로, 사이드바에 따로 묶어 보여 준다.
  구간 합계·고도 프로필에는 넣지 않는다(본선만). 지선이 갈라지고 합류하는 본선 코스는 빌드가 좌표로 찾는다
- **두루누비 공지** — 통행 제한·우회 안내 같은 공식 공지를 정보 카드에 접어서 보여 주고, 목록에 "공지" 표시. 매주 동기화로 갱신된다
- **코스 정보 카드** — 시·종점 주소와 교통편, 공식 부제(영덕 블루로드 · 바우길), 스탬프함 위치(해파랑길),
  길 끝 코스에서는 **이어지는 길** 링크(오륙도: 남파랑길 1 = 해파랑길 1, 땅끝: 남파랑길 90 = 서해랑길 1)
- **고도 프로필** — 인라인 SVG. 마우스를 올리면 지도에 그 지점 커서가 뜬다
- **사진과 메모를 위치에 기록** — 지도 핀이 곧 사진 썸네일이다. **고른 길의 기록만** 보인다
  - 사진 위치가 다른 길 코스에 더 가까우면 그 길 기록으로 할지 묻는다. 수정 화면에서 길을 옮길 수 있다
  - 길을 나누기 전에 만든 기록(`trail` 없음)은 남파랑길 기록으로 보인다
  - EXIF GPS가 있으면 자동으로 위치를 잡고 가장 가까운 코스에 매핑
  - 좌표가 없으면 **지도를 클릭해 지정**. 메신저·SNS를 거친 사진은 EXIF가 지워지므로 이게 기본 경로다
  - 좌표 대신 **주소만 기록된 사진**(갤럭시 등)은 주소를 보여주고 그 구간으로 지도를 옮겨준다
- **GitHub 동기화** — 기기 간에 기록을 옮긴다 (선택, 아래 설정 참고)
- **ZIP 백업** — 기록과 사진을 파일 하나로 내보내고 되가져온다
- 지도 3종(OSM / 지형 / 위성) · 다크모드 · 모바일 하단 시트

## 기술 스택

**서버가 없다.** 정적 파일과 GitHub만으로 돌아간다.

| | | 크기(gzip) |
|---|---|---|
| 빌드 | Vite 6 | — |
| 지도 | Leaflet + OSM / OpenTopoMap / Esri 타일 | 42KB |
| 프레임워크 | **없음** (Vanilla JS + ES 모듈) | — |
| 고도 차트 | **없음** (인라인 SVG 직접 작성) | — |
| 앱 코드 | | 22KB |
| 로컬 저장 | IndexedDB (오프라인 1차 저장소) | — |
| 원격 저장 | GitHub Contents API (`fetch`, SDK 없음) | — |
| EXIF | `exifr` — 사진 등록 시에만 지연 로딩 | 26KB |
| ZIP | `fflate` — 백업 시에만 지연 로딩 | 9KB |
| 사진 | 긴 변 1024px WebP(미지원 브라우저는 JPEG)로 축소·EXIF 제거, 업로드 후 로컬 사본 삭제 | — |
| 호스팅 | GitHub Pages | — |

첫 로딩은 **JS 70KB + CSS 11KB (gzip)** 에 고른 길의 데이터(남파랑길 42KB, 해파랑길 22KB, 서해랑길 47KB)다.
차트·HTTP·상태관리 라이브러리를 쓰지 않는다.

GPX는 **빌드 타임에 한 번** JSON으로 전처리한다. 브라우저는 GPX를 파싱하지 않는다.
랜딩은 `trails.json`(길 목록)과 고른 길의 `<길>/courses.json` 만 받고, 코스 상세는 구간을 고를 때 받는다.

```
public/data/trails.json               길 목록 · 합계 · 출처 · 길 사이 연결
public/data/<길>/courses.json         코스 메타 + 오버뷰 라인
public/data/<길>/course/{id}.json     코스 상세 (지연 로딩)
public/data/notes.json                사진·메모 기록 — 모든 길이 한 파일 (각 기록에 trail)
public/data/courses.json · course/    남파랑길 사본 — 캐시된 옛 앱과 옛 MCP 사본 호환용
```

## 실행

```bash
npm install
npm run dev
```

빌드:

```bash
npm run build
```

## 코스 데이터 갱신 — 자동 (매주)

코스 데이터는 두루누비에서 **매주 자동으로 점검**한다(`.github/workflows/sync-durunubi.yml`, 월요일 04:00 KST).
바뀐 것이 있으면 데이터를 다시 만들어 커밋하고 배포까지 한다. 바뀐 것이 없으면 아무것도 하지 않는다.
점검 대상은 `scripts/lib/trails.mjs` 에서 `enabled` 가 켜진 길이다(지금은 남파랑길·해파랑길·서해랑길).
길별 대조표는 `data/durunubi/<길>.json` 이다.

```
공공데이터포털 API (코스 정보 + GPX 주소)  ─┐
두루누비 사이트 목록 (API 에 없는 코스 보충) ─┴─> sync:durunubi ─> 바뀐 GPX 만 받기 ─> build:ele ─> build:data ─> 커밋·배포
                                                (data/durunubi/namparang.json 과 비교)
```

- **변경 감지**: 코스별 GPX 경로 · 공공 API 수정일 · 서버 파일 크기를 이전 기록과 비교한다.
  Actions 화면에서 수동 실행할 때 `full` 을 켜면 GPX 를 전부 다시 받아 SHA1 로 비교한다.
- **연결성 점검**: GPX 가 바뀌면 코스 접합부와 공식 시·종점 좌표까지의 거리를 다시 재고, 500m 를 넘으면 요약에 경고한다.
- **사라진 코스**: 출처에서 코스가 빠져도 지우지 않고 경고만 남긴다(`missingSince`).
- **실패 알림**: 인증키 만료나 API 형식 변경으로 점검이 실패하면 GitHub 이 메일로 알린다.

**처음 한 번 설정** — 공공데이터포털 인증키를 리포 Secret 으로 넣는다:
Settings → Secrets and variables → Actions → New repository secret → 이름 `DURUNUBI_SERVICE_KEY`.

로컬에서 직접 돌릴 때는 `.env.example` 을 `.env` 로 복사해 키를 넣는다(커밋되지 않는다).

```bash
npm run sync:durunubi              # 바뀐 것만 받는다 (--full: 전부 다시 비교, --dry-run: 보기만)
npm run build:ele                  # 바뀐 GPX 의 DEM 고도만 다시 조회 -> data/cache/ele/ (--dry-run: 예상 요청 수만)
npm run build:data                 # -> public/data/
```

공식 자료에 오타가 있으면 보정 CSV 에 그 칸만 적어 덮어쓴다(근거는 파일 머리말).
남파랑길은 `data/courses.meta.csv`, 다른 길은 `data/courses.meta.<길>.csv` 다(`trails.mjs` 의 `metaCsv`).

## 데이터 출처

노선과 코스 정보 모두 **두루누비(한국관광공사) 공식 자료**다. 길마다 출처 페이지가 따로 있다.

| 길 | 두루누비 코스 목록 | 노선 GPX 위치 |
|---|---|---|
| 남파랑길 | https://www.durunubi.kr/namparang-course-list.do | [data/gpx_durunubi/](data/gpx_durunubi/) |
| 해파랑길 | https://www.durunubi.kr/haeparang-course-list.do | [data/durunubi/gpx/haeparang/](data/durunubi/gpx/haeparang/) |
| 서해랑길 | https://www.durunubi.kr/seohaerang-course-list.do | [data/durunubi/gpx/seohaerang/](data/durunubi/gpx/seohaerang/) |
| DMZ 평화의 길 | https://www.durunubi.kr/dmz-course-list.do | `data/durunubi/gpx/dmz/` (예정) |

이용 조건은 4개 길 모두 **공공누리 제4유형**(출처표시 + 상업적 이용금지 + 변경금지)을 지킨다.
공공데이터포털 API 의 표기는 "이용허락범위 제한 없음"이지만, 두루누비 사이트가 같은 자료를 제4유형으로 표기하므로 더 엄격한 쪽을 따른다.

| | 내용 | 위치 |
|---|---|---|
| **노선 좌표** | 코스별 공식 GPX (받은 그대로, 수정하지 않음) | 위 표 |
| **코스 정보** | 지점명·주소·교통편·지역·난이도·소요시간 | [data/durunubi/](data/durunubi/)`<길>.json` (자동 갱신), 보정만 `data/courses.meta.csv` |

두 출처를 쓴다. **공공데이터포털 [두루누비 정보 서비스](https://www.data.go.kr) API** 를 우선하고,
API 에 빠진 코스는 두루누비 사이트의 코스 목록으로 보충한다. 공공 API 에는 코스가 절반가량만 있다
(남파랑길 44/90, 해파랑길 43/50, 서해랑길 51/109, DMZ 평화의 길 34/48 — 2026-10-18).
출처·라이선스·수집 방법은 **[data/SOURCE.md](data/SOURCE.md)** 에 전부 기록했다.
개인 비상업적 용도로만 사용하며, 권리자가 요청하면 즉시 삭제한다.

계산 기준은 모든 길에 같게 적용한다. 아래 검증 수치는 남파랑길 90개 코스 결과다(해파랑길은 TRAILS.md 4.1).

- **지점명**: 남파랑길은 공식 여행자정보의 시점·종점 이름을 쓴다. **해파랑길 여행자정보에는 시점·종점 줄이 없어**
  두루누비 사이트 목록의 공식 시·종점 주소를 줄여 표시한다(예: `기장읍 대변리`). 화면에 그 사실을 적는다.

- **난이도·소요시간**: 두루누비 공식값. 내가 만든 공식(거리 + 상승/100)은 공식 등급과
  남파랑길 90개 중 41개만 일치했다 — 운영기관 등급이 더 신뢰할 만하다.
- **거리**: GPX 실측값. 지도에 그리는 선과 숫자가 어긋나면 안 된다.
  남파랑길 90개 합계는 공식 표기와 0.2% 안쪽으로 맞는다.
- **고도**: **SRTM 30m DEM 추정값**이다. 공식 GPX 에도 고도가 있지만 남파랑길만 해도 37개 코스에
  빠진 점이 있고 일부는 0값이라, 모든 코스를 같은 기준으로 맞추려고 쓰지 않는다.

## GitHub 동기화 설정 (선택)

사진·메모는 기본적으로 **이 브라우저에만** 저장됩니다. 기기 간에 옮기려면 GitHub을 저장소로 씁니다.

1. **사진 리포지토리를 만든다** — 예: `photo-repo`
   소스 리포를 가볍게 유지하려고 사진은 따로 둡니다. 커밋된 사진은 삭제해도
   git 히스토리에 남으므로, 소스 리포에 섞으면 `git clone` 이 계속 무거워집니다.

   **이 리포는 코리아둘레길 4개 길이 함께 씁니다.** 사진 파일명이 노트 UUID 라
   길이 섞여도 충돌하지 않고, 경로가 `{폴더}/{연도}/{id}.jpg` 로 나뉩니다.
   남파랑길은 설정의 사진 폴더(기본 `namparang`), 다른 길은 길 이름 폴더(`haeparang`)를 씁니다.
   그래서 이름을 특정 길에 묶이지 않게(기본값 `photo-repo`처럼) 짓는 편이 좋습니다.

   ⚠️ **두 가지 주의**
   - **README 를 포함해 만드세요.** 커밋이 하나도 없는 리포에는 기본 브랜치가 없어서
     첫 업로드가 실패합니다. 생성 화면의 "Add a README file" 을 체크하면 됩니다.
   - **공개(public) 로 만드세요.** 사진은 `raw.githubusercontent.com` 으로 읽는데,
     비공개 리포의 raw URL 은 인증이 필요하고 `<img>` 태그는 인증 헤더를 보낼 수 없습니다.
     즉 **비공개면 다른 기기에서 사진이 보이지 않습니다.** 공개 리포에 올린 사진은
     URL 을 아는 누구나 볼 수 있다는 뜻이기도 합니다 — 이 점을 감안해 결정하세요.
2. **fine-grained PAT 를 만든다** — [토큰 만들기](https://github.com/settings/personal-access-tokens/new)
   - Repository access: 위 리포 2개만 선택
   - Permissions → Repository permissions → **Contents: Read and write**
   - 만료 90일 권장
3. 앱 사이드바 기록 섹션의 **⚙** 를 눌러 계정·리포·토큰을 넣고 **연결 확인** → **저장**
4. **동기화** 버튼을 누른다

저장 위치
- 메모: 메인 리포 `public/data/notes.json` (한 파일, sha 낙관적 락 + 재시도). 모든 길의 기록이 들어 있고 기록마다 `trail` 이 있다
- 사진: 사진 리포 `{폴더}/{연도}/{id}.jpg`, `{폴더}/{연도}/{id}_t.jpg`
  (URL 은 저장된 값이 아니라 **현재 설정에서 조립**하므로 리포 이름을 바꿔도 깨지지 않습니다)
- 읽기는 `raw.githubusercontent.com` 으로 갑니다 — 즉시 반영되고 API 한도에 걸리지 않습니다

## ZIP 백업

GitHub 동기화를 쓰든 안 쓰든, 사이드바 기록 섹션의 **ZIP 백업 · 내보내기** 로
기록과 사진을 파일 하나로 받아둘 수 있다. **가져오기**는 기존 기록과 병합한다
(`updatedAt` 이 늦은 쪽이 이긴다). 같은 백업을 두 번 넣어도 결과가 달라지지 않는다.

GitHub 계정 문제나 정책 변경에 대한 탈출구다. 클라우드 동기화가 있어도 남겨뒀다.

## MCP 서버 (코스 정보를 Claude 등에서 바로 조회)

`mcp/server.mjs` — **배포된 사이트의 JSON을 그대로 fetch** 해서
[MCP](https://modelcontextprotocol.io) 도구로 감싼다. 로컬 파일을 읽지 않는다 —
`https://yeonkyupark.github.io/KDT/data/courses.json` 이 이미 CORS가 열린
공개 데이터라 리포를 clone 할 필요조차 없다. `mcp/server.mjs` 파일 하나만 있으면
어디서든 실행된다. 로컬 stdio 로만 서빙하고, 개인 기록(사진·메모)은 다루지 않는다.

모든 도구에 `trail` 인자가 있다(`namparang` 기본, `haeparang`, `seohaerang`). 생략하면 남파랑길이다.
번호 범위(`get_courses`)는 본선만 고른다. 지선은 목록·검색 결과의 `kind`(`spur`)로 구분된다.

| 도구 | 하는 일 |
|---|---|
| `list_trails()` | 길 목록 — id · 구간 · 코스 수 · 총거리 · 길 사이 연결 |
| `get_courses(trail?, from, to?)` | 번호 범위의 코스 상세 + 구간 합계(거리·소요시간·상승/하강) |
| `list_courses(trail?, region?)` | 코스 목록. 지역으로 필터링 가능 |
| `search_courses(trail?, query)` | 지역명·지점명·별칭·부제(블루로드, 바우길)로 검색 |
| `get_trail_summary(trail?)` | 길 전체 개요(총거리·총상승) + 출처·주의사항 |

예전에 받은 `server.mjs` 사본(남파랑길 전용)도 계속 동작한다 — 사이트가 남파랑길 데이터를 옛 경로에도 둔다.
해파랑길을 쓰려면 파일을 다시 받는다.

로컬 stdio 서버라 **claude.ai(웹)에서는 못 쓴다.** Claude Code(CLI) 또는 Claude
Desktop(앱)에서만 동작한다.

**필요한 건 `server.mjs` 파일 하나뿐이다 — 이 리포를 clone할 필요가 없다.**
로컬 데이터를 읽지 않고 배포된 사이트를 fetch 하도록 만들었기 때문에, 이 파일이
다른 리포 파일을 하나도 참조하지 않는다. 아래 3단계면 끝난다.

### 1. 파일 하나 받기

새 폴더를 만들고 그 안에 파일 하나만 내려받는다:

```bash
mkdir kdt-mcp && cd kdt-mcp
curl -O https://raw.githubusercontent.com/yeonkyupark/KDT/main/mcp/server.mjs
```

curl이 없으면(Windows PowerShell):

```powershell
mkdir kdt-mcp; cd kdt-mcp
Invoke-WebRequest https://raw.githubusercontent.com/yeonkyupark/KDT/main/mcp/server.mjs -OutFile server.mjs
```

또는 그 주소를 브라우저로 열어 "다른 이름으로 저장"해도 된다.

### 2. 의존성 설치

같은 폴더에서 한 줄:

```bash
npm install @modelcontextprotocol/server zod
```

이 폴더에 `package.json`이 없어도 npm이 그 자리에서 자동으로 만든다 — 미리 준비할 것 없다.

### 3. Claude에 등록

**Claude Code** — 이 폴더 경로를 그대로 쓴다:

```bash
claude mcp add korea-dulle-gil --scope user -- node "$(pwd)/server.mjs"
```

(Windows PowerShell이면 `"$(pwd)/server.mjs"` 대신 `"$PWD\server.mjs"`.) 절대경로로
들어가므로 나중에 다른 폴더에서 Claude Code를 실행해도 계속 인식된다.
`claude mcp list` 로 등록 확인.

**Claude Desktop** — 설정 파일에 절대경로로 추가한다.

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "korea-dulle-gil": {
      "command": "node",
      "args": ["/절대/경로/kdt-mcp/server.mjs"]
    }
  }
}
```

추가한 뒤 **Claude Desktop을 완전히 종료하고 다시 실행**해야 반영된다(핫 리로드 없음).

---

이 리포 자체를 이미 clone해서 작업하는 중이라면(즉 이 README를 보고 있는 그 폴더),
위 1단계는 건너뛰고 `mcp/server.mjs` 경로를 그대로 쓰면 된다 — `.mcp.json` 이 이미
리포에 있어서 이 폴더에서 `claude` 를 실행하면 자동 인식된다(다른 사람의 리포를
처음 여는 것이므로 신뢰 승인 프롬프트가 한 번 뜬다).

예전에 `namparang-gil` 이름으로 등록했다면 그대로 써도 된다. 이름은 Claude 가 부르는 별칭일 뿐이다.

### 직접 확인

`node server.mjs` 를 터미널에 그냥 실행하면 응답이 안 보인다 — 표준입출력으로
JSON-RPC를 주고받는 프로토콜이라 호스트(Claude)가 자식 프로세스로 띄워야 정상 동작한다.
직접 도구를 눌러보려면:

```bash
npx @modelcontextprotocol/inspector node server.mjs
```

## 보안 주의

사진·메모 쓰기에는 **본인의 fine-grained PAT**가 필요하고, 이 토큰은
**브라우저 `localStorage`에만 저장된다.** 리포에는 어떤 비밀도 커밋하지 않는다.

- 토큰 권한은 이 리포 2개의 **Contents 쓰기로만** 제한할 것
- 토큰을 리포·이슈·PR에 절대 붙여넣지 말 것
- 다른 방문자에게는 읽기 전용으로 보인다

토큰이 `localStorage` 에 있으므로 XSS 가 터지면 유출된다. 그래서:

- **서드파티 스크립트를 하나도 쓰지 않는다** (분석·광고·CDN 스크립트 없음)
- 사용자가 입력한 메모는 절대 `innerHTML` 로 렌더하지 않는다 (`textContent` 만)
- `index.html` 에 **CSP** 를 걸어 실행 가능한 코드의 출처를 자기 자신으로 묶었다
- 권한이 파일 쓰기로 한정되므로 최악의 피해는 "리포 2개 오염"이고 git 으로 복구된다

## 라이선스

앱 소스 코드는 MIT. **코스 데이터는 제외** — `data/gpx_durunubi/`, `data/durunubi/`(길별 GPX 포함), `data/courses.meta*.csv`
와 이를 가공한 `public/data/` 의 코스 파일은 두루누비(한국관광공사) 자료로 **공공누리 제4유형**
(출처표시 + 상업적 이용금지 + 변경금지)을 따른다. `data/reference/` 의 외부 참고자료도 제외다.
자세한 조건은 [data/SOURCE.md](data/SOURCE.md).
