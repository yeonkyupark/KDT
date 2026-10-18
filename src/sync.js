/**
 * GitHub 동기화.
 *
 * 구조
 *   메모  : 메인 리포 `public/data/notes.json` 한 파일 (sha 낙관적 락 + 재시도)
 *   사진  : 사진 전용 리포 `{yyyy}/{id}.jpg`, `{yyyy}/{id}_t.jpg`
 *   읽기  : raw.githubusercontent.com (즉시 반영, CORS 열림, API 한도 무관)
 *   쓰기  : Contents API + 브라우저에만 보관하는 fine-grained PAT
 *
 * ── 계획에서 바꾼 것 ──
 * 원래 계획은 노트당 파일 1개(`data/notes/{id}.json`)였다. 단일 파일이 동시
 * 수정에 취약하다는 이유였다. 실제로 만들면서 단일 파일로 바꿨다:
 *   - 읽기가 요청 1번이면 끝난다. 노트당 파일이면 목록을 얻기 위해 디렉터리
 *     조회(인증 필요, API 한도) + 파일마다 요청이 필요하다. 450개면 451번이다.
 *   - 단일 사용자가 한 기기에서 쓰므로 충돌이 드물고, 충돌하면 409 가 오니
 *     다시 읽어 병합하고 재시도하면 정확하다.
 *   - `public/data/` 에 두면 배포 사이트에도 그대로 실린다.
 * 450개 × 약 300B = 135KB 수준이라 용량도 문제가 아니다.
 *
 * ── 병합 규칙 ──
 * `updatedAt` 이 늦은 쪽이 이긴다(LWW). 개인 단일 사용자에게는 이걸로 충분하고,
 * 삭제는 소프트 삭제(`deleted: true`)라 삭제도 기기 간에 전파된다.
 */

import { createClient } from './github.js'
import { allNotesRaw, putNoteRaw, getPhoto, deletePhoto, setSyncedAt, getSyncedAt } from './store.js'

const NOTES_PATH = 'public/data/notes.json'
const MAX_PUT_RETRY = 4
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 원격 notes.json 에 담는 필드만 골라낸다. Blob 은 올리지 않는다. */
function toRemote(note) {
  return {
    id: note.id,
    lat: note.lat,
    lng: note.lng,
    courseId: note.courseId ?? '',
    takenAt: note.takenAt ?? null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    title: note.title ?? '',
    memo: note.memo ?? '',
    rating: note.rating ?? 0,
    locationSource: note.locationSource ?? '',
    address: note.address ?? '',
    deleted: Boolean(note.deleted),
    photo: note.photo ?? null, // { full, thumb } — 사진 리포 안의 경로
  }
}

const laterOf = (a, b) => ((a?.updatedAt ?? '') >= (b?.updatedAt ?? '') ? a : b)

/**
 * 사진의 raw URL 을 **설정에서 조립한다.**
 *
 * 업로드 시점의 절대 URL 도 노트에 함께 저장하지만, 그것만 믿으면 사진 리포 이름을
 * 바꾸거나 계정을 옮긴 순간 기존 사진이 전부 깨진다. 경로(`photo.full`/`photo.thumb`)는
 * 안정적이므로 현재 설정 + 경로로 다시 만들고, 경로가 없는 옛 노트만 저장된 URL 로 폴백한다.
 *
 * @param {object} settings
 * @param {object} note
 * @param {'full'|'thumb'} kind
 */
export function photoUrl(settings, note, kind) {
  const p = note?.photo
  if (!p) return null
  const path = p[kind]
  const owner = settings?.owner || 'yeonkyupark'
  const photoRepo = settings?.photoRepo || 'photo-repo'
  const branch = settings?.branch || 'main'
  if (path && owner && photoRepo) {
    const enc = path.split('/').map(encodeURIComponent).join('/')
    return `https://raw.githubusercontent.com/${owner}/${photoRepo}/${branch}/${enc}`
  }
  return p[`${kind}Url`] ?? null
}

export function createSync(getSettings) {
  const listeners = new Set()
  const emit = (state) => listeners.forEach((fn) => fn(state))

  let running = null // 진행 중인 동기화 Promise — 겹쳐 들어온 호출은 이것을 함께 기다린다

  function clients() {
    const s = getSettings()
    if (!s.token) throw new Error('토큰이 설정되지 않았습니다')
    if (!s.owner || !s.repo) throw new Error('리포지토리가 설정되지 않았습니다')
    const main = createClient({ owner: s.owner, repo: s.repo, branch: s.branch, token: s.token })
    const photos = s.photoRepo
      ? createClient({ owner: s.owner, repo: s.photoRepo, branch: s.branch, token: s.token })
      : null
    return { main, photos, settings: s }
  }

  /** 원격에 있는 것이 확인된 사진의 로컬 사본(본문 Blob·썸네일)을 지운다. */
  async function dropLocalCopy(n) {
    await deletePhoto(n.id)
    if (n.thumb) {
      n.thumb = null
      await putNoteRaw(n)
    }
  }

  /**
   * 아직 원격에 올라가지 않은 사진을 올리고 경로를 note.photo 에 기록한다.
   *
   * 내용은 대개 WebP 지만 확장자는 `.jpg` 로 둔다. raw.githubusercontent 는 확장자로
   * Content-Type 을 정하는데 `.webp` 는 `application/octet-stream` + nosniff 로 나가
   * Safari 가 이미지로 표시하지 않는다. `.jpg`(image/jpeg) 로 주면 모든 브라우저가
   * 내용을 보고 WebP 로 디코딩한다.
   *
   * 원격에 있는 것이 확인된 사진은 로컬 사본을 지운다. 로컬은 업로드 대기열일 뿐이라
   * 기록이 늘어도 브라우저 저장소가 커지지 않는다. 화면은 원격 URL 로 보여 준다.
   * 그래서 원격에서 사라진 사진은 업로드 직후가 아니면 되살릴 수 없다(orphaned 로 알린다).
   */
  async function uploadPhotos(photosClient, notes, prefix) {
    if (!photosClient) return { uploaded: 0, skipped: 0, missing: notes.filter((n) => !n.photo).length }

    let uploaded = 0
    let skipped = 0
    let restored = 0
    let orphaned = 0

    // 리포에 실제로 뭐가 있는지 요청 1회로 확인한다.
    //
    // `n.photo` 가 있으면 올렸다는 뜻이지만, 그 파일이 지금도 있다는 보장은 없다.
    // GitHub 웹에서 지우거나 다른 정리 작업이 지나가면 notes.json 은 없는 파일을
    // 가리킨 채로 남고, 예전 코드는 `n.photo` 가 있으면 건너뛰어 영구히 복구되지
    // 않았다. 실제로 이 리포에서 그 일이 일어났다 (PLAN.md 6c 참조).
    let present = null
    try {
      present = await photosClient.listPaths()
    } catch {
      // 목록을 못 얻으면 복구 판정을 하지 않는다. 신규 업로드는 그대로 진행.
      present = null
    }

    for (const n of notes) {
      if (n.deleted) continue

      if (n.photo) {
        // 목록을 못 얻었거나 파일이 멀쩡하면 건드리지 않는다.
        if (!present) continue
        const gone = [n.photo.full, n.photo.thumb].filter((x) => x && !present.has(x))
        if (!gone.length) {
          await dropLocalCopy(n) // 이전 버전이 남겨 둔 로컬 사본
          continue
        }

        // 원격에서 사라졌다. 로컬 원본이 남아 있으면 다시 올린다.
        if (!(await getPhoto(n.id)) || !n.thumb) {
          orphaned++ // 로컬에도 없다 — 이 사진은 되살릴 수 없다
          continue
        }
        delete n.photo // 아래 신규 업로드 경로를 다시 타게 한다
        restored++
      }

      const full = await getPhoto(n.id)
      if (!full || !n.thumb) continue

      const year = (n.takenAt ?? n.createdAt ?? '').slice(0, 4) || 'misc'
      // 사진 리포는 여러 트레일이 공유할 수 있다. 접두어로 구분한다.
      const dir = prefix ? `${prefix}/${year}` : year
      const paths = { full: `${dir}/${n.id}.jpg`, thumb: `${dir}/${n.id}_t.jpg` }

      const a = await photosClient.putBlobIfAbsent(paths.full, full, `사진 추가 ${n.id}`)
      const b = await photosClient.putBlobIfAbsent(paths.thumb, n.thumb, `썸네일 추가 ${n.id}`)
      a.skipped && b.skipped ? skipped++ : uploaded++

      n.photo = {
        ...paths,
        fullUrl: photosClient.rawUrl(paths.full),
        thumbUrl: photosClient.rawUrl(paths.thumb),
      }
      await putNoteRaw(n)
      // putBlobIfAbsent 가 던지지 않았으면 올렸거나 이미 있던 것이다.
      await dropLocalCopy(n)
    }
    return { uploaded, skipped, restored, orphaned, missing: 0 }
  }

  /** 삭제한 노트의 사진 파일을 사진 리포에서 지운다. 성공한 경로만 대기 목록에서 뺀다. */
  async function removeDeletedPhotos(photosClient) {
    if (!photosClient) return 0
    const all = await allNotesRaw()
    // 다른 노트가 아직 그 사진을 쓰고 있으면 지우지 않는다.
    const inUse = new Set(
      all
        .filter((n) => !n.deleted)
        .flatMap((n) => [n.photo?.full, n.photo?.thumb])
        .filter(Boolean),
    )
    let removed = 0
    for (const n of all) {
      const pending = n.pendingDeletes ?? []
      if (!pending.length) continue
      const left = []
      for (const path of pending) {
        if (inUse.has(path)) continue
        try {
          if (await photosClient.deleteFile(path, `사진 삭제 ${path}`)) removed++
        } catch {
          left.push(path) // 다음 동기화 때 다시 시도
        }
      }
      await putNoteRaw({ ...n, pendingDeletes: left })
    }
    return removed
  }

  /**
   * 토큰 없이 공개 저장소의 최신 기록을 받아온다.
   *
   * `run()`은 사진 업로드·notes.json 쓰기가 있어 토큰이 필수다. 하지만 **읽기는
   * 토큰이 필요 없다** — 리포가 공개면 raw.githubusercontent.com 이 누구에게나
   * 열려 있다(`github.js`의 `readJson` 참조). 방문자가 토큰 없이도 이미 동기화된
   * 사진·메모를 볼 수 있어야 하므로, 로딩 시 이 함수를 호출해 조용히 병합한다.
   *
   * 병합 규칙은 `run()`의 3단계(원격→로컬)와 같다: `updatedAt` 늦은 쪽이 이기고,
   * 사진 Blob 은 내리지 않는다(원격 raw URL 로 표시).
   *
   * @returns {Promise<{pulled: number}>}
   */
  async function pullPublic() {
    const s = getSettings()
    if (!s.owner || !s.repo) return { pulled: 0 }

    const reader = createClient({ owner: s.owner, repo: s.repo, branch: s.branch })
    const remote = await reader.readJson(NOTES_PATH).catch(() => null)
    if (!remote?.notes?.length) return { pulled: 0 }

    let pulled = 0
    const localById = new Map((await allNotesRaw()).map((n) => [n.id, n]))
    for (const r of remote.notes) {
      const mine = localById.get(r.id)
      if (mine && (mine.updatedAt ?? '') >= (r.updatedAt ?? '')) continue
      await putNoteRaw({ ...(mine ?? {}), ...r, thumb: mine?.thumb ?? null })
      pulled++
    }
    return { pulled }
  }

  /**
   * 로컬 → 원격 → 로컬 한 바퀴.
   *
   * 이미 진행 중이면 새로 시작하지 않고 그 결과를 돌려준다. 동기화가 도는 사이에
   * 다시 호출해도 같은 결과(또는 같은 오류)를 받는다.
   * @returns {Promise<{pushed:number, pulled:number, photos:object}>}
   */
  function run() {
    if (!running) {
      running = doRun().finally(() => {
        running = null
      })
    }
    return running
  }

  async function doRun() {
    emit({ phase: 'start' })

    try {
      const { main, photos } = clients()

      // 1) 사진 먼저. notes.json 에 경로를 담아야 하므로 순서가 중요하다.
      emit({ phase: 'photos' })
      const local = await allNotesRaw()
      const photoStat = await uploadPhotos(photos, local, getSettings().photoPrefix ?? '')

      // 2) notes.json 을 읽어 병합하고 쓴다. 409 면 다시 읽어 재시도.
      emit({ phase: 'notes' })
      let pushed = 0
      let merged = null

      for (let attempt = 0; attempt < MAX_PUT_RETRY; attempt++) {
        // sha 와 내용을 원자적으로 읽는다. raw 는 5분 캐시라 쓰기 경로에 쓰면
        // 방금 올라온 원격 변경을 못 보고 되돌릴 수 있다.
        const head = await main.getFileJson(NOTES_PATH)
        const sha = head?.sha ?? null
        const remote = head?.json ?? null

        const byId = new Map()
        for (const r of remote?.notes ?? []) byId.set(r.id, r)

        pushed = 0
        for (const n of await allNotesRaw()) {
          const mine = toRemote(n)
          const theirs = byId.get(n.id)
          const winner = laterOf(mine, theirs)
          if (winner === mine && JSON.stringify(theirs) !== JSON.stringify(mine)) pushed++
          byId.set(n.id, winner)
        }

        merged = {
          version: 1,
          updatedAt: new Date().toISOString(),
          notes: [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
        }

        // 원격과 완전히 같으면 커밋을 만들지 않는다 (빈 커밋으로 CI 를 돌릴 이유가 없다)
        if (remote && JSON.stringify(remote.notes) === JSON.stringify(merged.notes)) break

        try {
          await main.putJson(NOTES_PATH, merged, {
            message: `기록 동기화 (${merged.notes.filter((n) => !n.deleted).length}개)`,
            sha,
          })
          break
        } catch (e) {
          // 409(sha 불일치)·422(sha 누락)는 읽은 sha 가 낡았다는 뜻 — 잠시 뒤 다시 읽어 병합한다.
          // 그 외 오류(권한 등)는 재시도해도 같으므로 바로 던진다.
          const conflict = e.status === 409 || (e.status === 422 && /sha/i.test(e.message))
          if (!conflict || attempt === MAX_PUT_RETRY - 1) throw e
          await sleep(1000 * 2 ** attempt)
        }
      }

      // 3) 원격에만 있거나 더 최신인 노트를 로컬로 내린다.
      emit({ phase: 'pull' })
      let pulled = 0
      const localById = new Map((await allNotesRaw()).map((n) => [n.id, n]))
      for (const r of merged?.notes ?? []) {
        const mine = localById.get(r.id)
        if (mine && (mine.updatedAt ?? '') >= (r.updatedAt ?? '')) continue
        // 사진 Blob 은 내리지 않는다. 원격 raw URL 로 바로 표시한다
        // (450개 썸네일을 미리 받으면 9MB다).
        await putNoteRaw({ ...(mine ?? {}), ...r, thumb: mine?.thumb ?? null })
        pulled++
      }

      // 4) 새 notes.json 이 더는 가리키지 않게 된 뒤에 사진 파일을 지운다.
      //    먼저 지우면 커밋이 실패했을 때 공개 페이지에 깨진 사진이 남는다.
      photoStat.removed = await removeDeletedPhotos(photos)

      const at = new Date().toISOString()
      await setSyncedAt(at)
      emit({ phase: 'done', at, pushed, pulled, photos: photoStat })
      return { pushed, pulled, photos: photoStat, at }
    } catch (e) {
      emit({ phase: 'error', message: e.message, status: e.status })
      throw e
    }
  }

  return {
    run,
    pullPublic,
    onState: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    lastSyncedAt: getSyncedAt,
    get busy() {
      return running !== null
    },
  }
}
