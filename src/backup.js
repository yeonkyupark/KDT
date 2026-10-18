/**
 * ZIP 백업 — 내보내기 / 가져오기.
 *
 * GitHub 동기화가 있어도 이걸 남겨둔다. 계정 문제, 리포 사고, 정책 변경에
 * 대한 **유일한 탈출구**다. 파일 하나로 전부 들고 나갈 수 있어야 한다.
 *
 * `fflate` 는 백업을 실제로 쓸 때만 필요하므로 동적 import 한다.
 *
 * ZIP 구조
 *   notes.json          모든 노트 메타데이터 (삭제 표시된 것 포함)
 *   photos/{id}.jpg     저장용 이미지 (긴 변 1024px)
 *   thumbs/{id}.jpg     썸네일 (280px)
 *
 * 내용은 대개 WebP 지만 이름은 사진 리포와 같이 `.jpg` 다. 가져올 때 내용으로 형식을 정한다.
 * 동기화가 끝난 사진은 로컬에서 지워지므로 대부분 사진 리포에서 받아 담는다.
 */

import { allNotesRaw, getPhoto, putNoteRaw, saveNote } from './store.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** 파일명에 쓸 수 있는 오늘 날짜. */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 내용으로 MIME 형식을 정한다. 이름이 `.jpg` 여도 내용은 대개 WebP 다. */
function imageType(bytes) {
  if (String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  return 'image/jpeg'
}

/** 로컬 Blob 이 있으면 그것을, 없으면 사진 리포에서 받는다. 못 받으면 null. */
async function photoBytes(blob, url) {
  if (blob) return new Uint8Array(await blob.arrayBuffer())
  if (!url) return null
  const res = await fetch(url, { cache: 'no-store' }).catch(() => null)
  return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null
}

/**
 * 백업 ZIP 을 만들어 내려준다.
 * @param {(msg: string) => void} [onProgress]
 * @param {{remoteUrl?: (note: object, kind: 'full'|'thumb') => string|null}} [opts]
 * @returns {Promise<{notes: number, photos: number, missing: number, bytes: number, name: string}>}
 */
export async function exportZip(onProgress, { remoteUrl } = {}) {
  const { zip } = await import('fflate')

  const notes = await allNotesRaw()
  onProgress?.(`노트 ${notes.length}개 모으는 중…`)

  /** @type {Record<string, [Uint8Array, object]>} */
  const files = {}
  let photoCount = 0
  let missing = 0

  for (const [i, n] of notes.entries()) {
    if (n.deleted) continue
    const hasPhoto = Boolean(n.photo || n.thumb)

    const full = await photoBytes(await getPhoto(n.id), remoteUrl?.(n, 'full'))
    // 이미 압축된 이미지다. 다시 압축하면 CPU만 쓰고 크기는 그대로다.
    if (full) {
      files[`photos/${n.id}.jpg`] = [full, { level: 0 }]
      photoCount++
    } else if (hasPhoto) {
      missing++
    }
    const thumb = await photoBytes(n.thumb, remoteUrl?.(n, 'thumb'))
    if (thumb) files[`thumbs/${n.id}.jpg`] = [thumb, { level: 0 }]
    if (i % 5 === 0) onProgress?.(`사진 ${photoCount}장 담는 중…`)
  }

  // Blob 은 JSON 으로 직렬화되지 않으므로 빼고 담는다. 사진은 위에서 별도 파일로 들어갔다.
  const meta = notes.map(({ thumb, ...rest }) => rest)
  files['notes.json'] = [
    enc.encode(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notes: meta }, null, 1)),
    { level: 6 },
  ]

  onProgress?.('압축 중…')
  const bytes = await new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)))
  })

  const name = `kdt-backup-${stamp()}.zip`
  const blob = new Blob([bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // 다운로드가 시작될 시간을 준 뒤 해제한다
  setTimeout(() => URL.revokeObjectURL(url), 10_000)

  return { notes: meta.length, photos: photoCount, missing, bytes: blob.size, name }
}

/**
 * 백업 ZIP 을 읽어 병합한다.
 *
 * 병합 규칙은 동기화와 같다 — `updatedAt` 이 늦은 쪽이 이긴다.
 * 그래서 같은 백업을 두 번 넣어도 결과가 달라지지 않는다.
 *
 * @returns {Promise<{added: number, updated: number, skipped: number, photos: number}>}
 */
export async function importZip(file, onProgress) {
  const { unzip } = await import('fflate')

  onProgress?.('압축 해제 중…')
  const buf = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise((resolve, reject) => {
    unzip(buf, (err, data) => (err ? reject(err) : resolve(data)))
  })

  const raw = entries['notes.json']
  if (!raw) throw new Error('notes.json 이 없습니다 — 이 앱이 만든 백업 파일이 맞는지 확인하세요')

  let parsed
  try {
    parsed = JSON.parse(dec.decode(raw))
  } catch {
    throw new Error('notes.json 을 읽을 수 없습니다 (손상된 파일)')
  }
  const incoming = Array.isArray(parsed?.notes) ? parsed.notes : []

  const existing = new Map((await allNotesRaw()).map((n) => [n.id, n]))
  let added = 0
  let updated = 0
  let skipped = 0
  let photos = 0

  for (const [i, n] of incoming.entries()) {
    if (!n?.id) continue
    const mine = existing.get(n.id)

    if (mine && (mine.updatedAt ?? '') >= (n.updatedAt ?? '')) {
      skipped++
      continue
    }

    const thumbBytes = entries[`thumbs/${n.id}.jpg`]
    const fullBytes = entries[`photos/${n.id}.jpg`]

    const rec = {
      ...(mine ?? {}),
      ...n,
      thumb: thumbBytes ? new Blob([thumbBytes], { type: imageType(thumbBytes) }) : (mine?.thumb ?? null),
    }

    if (fullBytes) {
      // saveNote 는 updatedAt 을 지금으로 바꾼다. 백업의 시각을 지켜야 하므로
      // 사진만 saveNote 로 넣고 노트는 putNoteRaw 로 덮어쓴다.
      await saveNote(rec, new Blob([fullBytes], { type: imageType(fullBytes) }))
      photos++
    }
    await putNoteRaw(rec)

    mine ? updated++ : added++
    if (i % 20 === 0) onProgress?.(`${i + 1} / ${incoming.length} 처리 중…`)
  }

  return { added, updated, skipped, photos }
}
