/**
 * 동기화 설정 — 리포지토리와 개인 액세스 토큰(PAT).
 *
 * ── 왜 PAT 를 브라우저에 두는가 ──
 * Public 리포의 정적 사이트에는 비밀을 숨길 수 없다. 검토한 선택지:
 *   PAT 를 리포에 커밋      → 누구나 리포에 쓸 수 있다. 불가.
 *   OAuth (표준)            → 토큰 교환에 client_secret 필요 → 서버 필요.
 *   OAuth Device Flow       → client_secret 은 없어도 되지만 GitHub 토큰
 *                             엔드포인트가 CORS 를 허용하지 않는다 → 프록시(=서버) 필요.
 *   기존 github.com 로그인    → 쓸 수 없다. api.github.com 은 `Access-Control-Allow-Origin: *`
 *                             를 주는데, 와일드카드는 credentials 와 함께 쓸 수 없다.
 *   본인 PAT 를 브라우저에   → 서버가 필요 없는 **유일한** 해법. 채택.
 *
 * 브라우저에서 실측한 결과 (2026-08-27):
 *   fetch('https://github.com/login/device/code')          → TypeError: Failed to fetch
 *   fetch('https://github.com/login/oauth/access_token')   → TypeError: Failed to fetch
 *   fetch('https://api.github.com/rate_limit')             → 200 (CORS 허용)
 *   fetch('https://api.github.com/user', {credentials})    → TypeError: Failed to fetch
 *
 * ── 위험과 완화 ──
 * localStorage 의 토큰은 XSS 가 터지면 유출된다. 그래서:
 *   - 서드파티 스크립트 0개 (분석·광고·CDN 스크립트 없음)
 *   - 사용자 입력은 절대 innerHTML 로 렌더하지 않는다 (textContent 만)
 *   - PAT 권한을 이 리포 2개의 Contents 쓰기로만 제한 (fine-grained PAT)
 *   - 만료 90일
 * 권한이 파일 쓰기로 한정되므로 최악의 피해는 "리포 2개 오염"이고 git 으로 복구된다.
 */

const KEY = 'namparang.sync'

const DEFAULTS = {
  owner: 'yeonkyupark',
  repo: 'KDT',
  photoRepo: 'photo-repo',
  /**
   * 사진 리포 안에서 이 프로젝트가 쓰는 최상위 폴더.
   *
   * 사진 리포는 **여러 트레일이 공유할 수 있게** 설계했다 — 노트 ID 가 UUID 라
   * 트레일이 섞여도 파일명이 충돌하지 않는다. 다만 접두어가 없으면 리포를 열어봐도
   * 어느 트레일 사진인지 알 수 없으므로 경로를 `{prefix}/{연도}/{id}.jpg` 로 둔다.
   * 해파랑길·서해랑길을 같은 구조로 만들면 `haeparang`, `seohaerang` 만 바꾸면 된다.
   */
  photoPrefix: 'namparang',
  branch: 'main',
  token: '',
  tokenSetAt: '', // 만료(권장 90일) 임박을 알려주기 위해 설정 시점을 기록한다
}

/** fine-grained PAT 권장 만료. 이 날수에 가까워지면 경고한다. */
const TOKEN_MAX_DAYS = 90
const TOKEN_WARN_DAYS = 80

/** 토큰 설정 후 지난 날수. 기록이 없으면 null. */
export function tokenAgeDays(settings) {
  if (!settings?.tokenSetAt) return null
  const d = (Date.now() - new Date(settings.tokenSetAt).getTime()) / 86400000
  return Number.isFinite(d) ? Math.floor(d) : null
}

/** 만료 임박/초과 안내 문구. 문제 없으면 빈 문자열. */
export function tokenExpiryNote(settings) {
  const age = tokenAgeDays(settings)
  if (age == null) return ''
  if (age >= TOKEN_MAX_DAYS) return `토큰을 설정한 지 ${age}일 — 만료됐을 수 있습니다`
  if (age >= TOKEN_WARN_DAYS) return `토큰 설정 후 ${age}일 — 곧 만료됩니다 (권장 ${TOKEN_MAX_DAYS}일)`
  return ''
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    const s = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
    // 리포 이름을 KDT-Namparang → KDT 로 바꿨다(2026-10-18). 저장된 옛 이름을 새 이름으로 읽는다.
    if (s.repo === 'KDT-Namparang') s.repo = 'KDT'
    return s
  } catch {
    // 시크릿 모드 등에서 접근이 막힐 수 있다
    return { ...DEFAULTS }
  }
}

export function saveSettings(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

/** 토큰 문자열을 로그·화면에 그대로 쓰지 않기 위한 가림 처리. */
export function maskToken(t) {
  if (!t) return ''
  return t.length <= 12 ? '•'.repeat(t.length) : `${t.slice(0, 7)}…${t.slice(-4)}`
}

/**
 * 설정 모달.
 * @param {{current: object, onSave: (s: object) => void, onCheck: (s: object) => Promise<object>}} opts
 */
export function openSettings({ current, onSave, onCheck }) {
  const back = el('div', 'modal-back')
  const box = el('div', 'modal settings-modal')

  const cleanup = () => {
    back.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') cleanup()
  }
  document.addEventListener('keydown', onKey)

  const head = el('div', 'modal-head')
  head.append(el('b', null, 'GitHub 동기화 설정'))
  const x = el('button', 'modal-x', '✕')
  x.type = 'button'
  x.setAttribute('aria-label', '닫기')
  x.onclick = cleanup
  head.append(x)
  box.append(head)

  const field = (label, value, { placeholder = '', type = 'text', hint = '' } = {}) => {
    const wrap = el('label', 'form-row')
    wrap.append(el('span', 'form-label', label))
    const input = document.createElement('input')
    input.type = type
    input.value = value ?? ''
    input.placeholder = placeholder
    input.autocomplete = 'off'
    input.spellcheck = false
    wrap.append(input)
    if (hint) wrap.append(el('span', 'form-hint', hint))
    box.append(wrap)
    return input
  }

  const ownerIn = field('GitHub 계정', current.owner)
  const repoIn = field('메모 리포지토리', current.repo, { hint: 'public/data/notes.json 에 기록을 저장합니다' })
  const photoIn = field('사진 리포지토리', current.photoRepo, {
    hint: '여러 트레일이 공유할 수 있습니다. 비워두면 사진을 올리지 않습니다',
  })
  const prefixIn = field('사진 폴더', current.photoPrefix, {
    hint: '사진 리포 안에서 이 트레일이 쓸 폴더. 경로는 {폴더}/{연도}/{id}.jpg 가 됩니다',
  })
  const tokenIn = field('Personal Access Token', current.token, {
    type: 'password',
    placeholder: current.token ? maskToken(current.token) : 'github_pat_...',
    hint: '이 브라우저에만 저장됩니다. 리포에는 절대 커밋되지 않습니다',
  })

  const guide = el('div', 'settings-guide')
  guide.append(el('b', null, '토큰 만드는 법'))
  const ol = el('ol')
  for (const t of [
    'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens',
    'Repository access: 위에 적은 리포 2개만 선택',
    'Permissions → Repository permissions → Contents: Read and write',
    '만료 90일 권장. 이 토큰으로 할 수 있는 일은 그 리포 2개의 파일 쓰기뿐입니다',
  ]) {
    ol.append(el('li', null, t))
  }
  guide.append(ol)
  const link = el('a', null, 'Fine-grained token 만들기 →')
  link.href = 'https://github.com/settings/personal-access-tokens/new'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  guide.append(link)
  box.append(guide)

  const status = el('div', 'settings-status')
  const age = tokenAgeDays(current)
  if (age != null) {
    const note = tokenExpiryNote(current)
    status.className = note ? 'settings-status is-bad' : 'settings-status'
    status.textContent = note || `현재 토큰: ${maskToken(current.token)} · 설정 후 ${age}일`
  }
  box.append(status)

  // 토큰을 붙여넣는 순간 바로 검증한다. "저장했는데 왜 안 되지"를 없애는 게 목적이다.
  let checkTimer = null
  tokenIn.addEventListener('input', () => {
    clearTimeout(checkTimer)
    const v = tokenIn.value.trim()
    if (v.length < 20) return
    status.className = 'settings-status'
    status.textContent = '붙여넣은 토큰 확인 중…'
    checkTimer = setTimeout(() => checkBtn.click(), 400)
  })

  const collect = () => ({
    ...current,
    owner: ownerIn.value.trim(),
    repo: repoIn.value.trim(),
    photoRepo: photoIn.value.trim(),
    photoPrefix: prefixIn.value.trim().replace(/^\/+|\/+$/g, ''),
    token: tokenIn.value.trim() || current.token,
  })

  const foot = el('div', 'modal-foot')

  /** 검사 결과를 항목별로 그린다. 통과/경고/실패를 한눈에 보이게. */
  function renderCheck(r) {
    status.textContent = ''
    status.className = 'settings-status'

    const rows = []
    const add = (kind, text) => rows.push({ kind, text })

    add('ok', `${r.login} 계정으로 인증됨`)

    // 메모 리포
    const n = r.notes
    if (!n.canWrite) add('bad', `${n.fullName}: 쓰기 권한 없음 — Contents: Read and write 로 설정하세요`)
    else add('ok', `${n.fullName}: 쓰기 가능`)
    if (n.empty) {
      add('warn', `${n.fullName}: 커밋이 없어 '${r.branch}' 브랜치가 아직 없습니다 — README 를 하나 만들어 초기화하세요`)
    } else if (n.defaultBranch && n.defaultBranch !== r.branch) {
      add('warn', `${n.fullName}: 기본 브랜치가 '${n.defaultBranch}' 인데 설정은 '${r.branch}' 입니다`)
    }

    // 사진 리포
    const p = r.photos
    if (!p) {
      add('warn', '사진 리포가 비어 있습니다 — 메모만 동기화되고 사진은 올라가지 않습니다')
    } else if (p.error) {
      add('bad', `사진 리포: ${p.error}`)
    } else {
      if (!p.canWrite) add('bad', `${p.fullName}: 쓰기 권한 없음`)
      else add('ok', `${p.fullName}: 쓰기 가능`)
      if (p.empty) {
        add('warn', `${p.fullName}: 커밋이 없어 '${r.branch}' 브랜치가 아직 없습니다 — README 를 하나 만들어 초기화하세요`)
      } else if (p.defaultBranch && p.defaultBranch !== r.branch) {
        add('warn', `${p.fullName}: 기본 브랜치가 '${p.defaultBranch}' 인데 설정은 '${r.branch}' 입니다`)
      }
      // 비공개 리포의 raw URL 은 인증이 필요해 <img src> 로 못 읽는다
      if (p.isPrivate) {
        add('bad', `${p.fullName} 이(가) 비공개입니다 — 사진이 다른 기기에서 보이지 않습니다. 공개로 바꾸세요`)
      }
    }

    const ul = document.createElement('ul')
    ul.className = 'check-list'
    for (const { kind, text } of rows) {
      const li = el('li', `check-${kind}`)
      li.append(el('span', 'check-mark', kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '✕'))
      li.append(el('span', null, text))
      ul.append(li)
    }
    status.append(ul)
  }

  const checkBtn = el('button', 'btn', '연결 확인')
  checkBtn.type = 'button'
  checkBtn.onclick = async () => {
    status.className = 'settings-status'
    status.textContent = '확인 중…'
    checkBtn.disabled = true
    try {
      renderCheck(await onCheck(collect()))
    } catch (e) {
      status.className = 'settings-status is-bad'
      status.textContent =
        e.status === 401
          ? '토큰이 유효하지 않습니다 (401)'
          : e.status === 404
            ? '메모 리포를 찾을 수 없거나 토큰에 접근 권한이 없습니다 (404)'
            : `실패 — ${e.message}`
    } finally {
      checkBtn.disabled = false
    }
  }

  const clearBtn = el('button', 'btn btn-danger', '토큰 삭제')
  clearBtn.type = 'button'
  clearBtn.hidden = !current.token
  clearBtn.onclick = () => {
    onSave({ ...collect(), token: '', tokenSetAt: '' })
    cleanup()
  }

  const saveBtn = el('button', 'btn btn-primary', '저장')
  saveBtn.type = 'button'
  saveBtn.onclick = () => {
    const next = collect()
    // 토큰이 바뀐 경우에만 설정일을 갱신한다
    if (next.token && next.token !== current.token) next.tokenSetAt = new Date().toISOString()
    onSave(next)
    cleanup()
  }

  foot.append(clearBtn, checkBtn, saveBtn)
  box.append(foot)

  back.append(box)
  back.onclick = (e) => {
    if (e.target === back) cleanup()
  }
  document.body.append(back)
  ;(current.token ? checkBtn : tokenIn).focus()
}
