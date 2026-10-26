/**
 * GitHub Contents API — SDK 없이 fetch 로만 쓴다.
 *
 * 필요한 동작이 넷뿐이다: 파일 읽기, JSON 쓰기, 바이너리 쓰기, 토큰 확인.
 * Octokit(수십 KB)을 넣을 이유가 없다.
 *
 * 읽기는 `raw.githubusercontent.com` 으로 간다 — CORS 가 열려 있고, 5분 캐시라
 * 갓 올린 파일도 곧 보이며, **api.github.com 의 미인증 60req/hr 한도에 걸리지 않는다.**
 * 쓰기는 인증되므로 5,000req/hr — 개인 사용에는 사실상 무제한이다.
 */

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

/** Uint8Array → base64. 큰 배열을 한 번에 스프레드하면 스택이 터지므로 나눠 돈다. */
function toBase64(bytes) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/** 한글이 들어간 JSON 은 btoa 로 바로 못 넘긴다(Latin1 전용). UTF-8 로 인코딩해서 넘긴다. */
function jsonToBase64(value) {
  return toBase64(new TextEncoder().encode(JSON.stringify(value, null, 1)))
}

async function blobToBase64(blob) {
  return toBase64(new Uint8Array(await blob.arrayBuffer()))
}

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * @param {{owner: string, repo: string, branch?: string, token?: string}} cfg
 */
export function createClient(cfg) {
  const branch = cfg.branch || 'main'

  const authHeaders = () =>
    cfg.token ? { ...HEADERS, Authorization: `Bearer ${cfg.token}` } : { ...HEADERS }

  async function api(path, init = {}) {
    const res = await fetch(`${API}${path}`, { ...init, headers: { ...authHeaders(), ...init.headers } })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    if (!res.ok) {
      throw new GitHubError(body?.message || `HTTP ${res.status}`, res.status, body)
    }
    return body
  }

  /**
   * 쓰기 직전 읽기용 URL. `t` 는 캐시 무력화용이다.
   * 브라우저 no-store 만으로는 부족하다 — GitHub 쪽이 같은 URL 에 대해 커밋 직후
   * 한동안 이전 sha 를 돌려줄 때가 있어, 그 sha 로 PUT 하면 409 "does not match" 가 난다.
   */
  const freshContentsUrl = (path) =>
    `${contentsPath(path)}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`

  const contentsPath = (path) =>
    `/repos/${cfg.owner}/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`

  return {
    get config() {
      return { owner: cfg.owner, repo: cfg.repo, branch }
    },

    rawUrl(path) {
      return `${RAW}/${cfg.owner}/${cfg.repo}/${branch}/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`
    },

    /** raw 로 JSON 을 읽는다. 없으면 null. */
    async readJson(path) {
      const res = await fetch(`${this.rawUrl(path)}?t=${Date.now()}`, { cache: 'no-store' })
      if (res.status === 404) return null
      if (!res.ok) throw new GitHubError(`읽기 실패 HTTP ${res.status}`, res.status, null)
      return res.json()
    },

    /**
     * 쓰기 직전에 쓸 sha + 내용을 **한 번에** 읽는다.
     *
     * sha 는 API(즉시 최신)에서, 내용은 raw(최대 5분 캐시)에서 따로 읽으면
     * 방금 다른 기기가 올린 변경을 못 본 채 최신 sha 로 덮어써서 되돌릴 수 있다.
     * Contents API 는 둘을 원자적으로 준다.
     *
     * @returns {Promise<{sha: string, json: any}|null>} 파일이 없으면 null
     */
    async getFileJson(path) {
      let r
      try {
        r = await api(freshContentsUrl(path), {
          cache: 'no-store',
        })
      } catch (e) {
        if (e.status === 404) return null
        throw e
      }

      // 1MB 를 넘으면 Contents API 가 content 를 비워 보낸다. 그때만 raw 로 받는다.
      if (!r.content && r.download_url) {
        const res = await fetch(`${r.download_url}?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) throw new GitHubError(`읽기 실패 HTTP ${res.status}`, res.status, null)
        return { sha: r.sha, json: await res.json() }
      }

      const bytes = Uint8Array.from(atob(r.content.replace(/\s/g, '')), (c) => c.charCodeAt(0))
      return { sha: r.sha, json: JSON.parse(new TextDecoder().decode(bytes)) }
    },

    /** 쓰기에 필요한 현재 sha. 파일이 없으면 null. */
    async headSha(path) {
      try {
        // no-store: 브라우저 HTTP 캐시(max-age=60)가 방금 올린 파일을 "없음"으로 답하면
        // sha 없이 PUT 해서 422 "sha wasn't supplied" 가 난다.
        const r = await api(freshContentsUrl(path), {
          cache: 'no-store',
        })
        return r?.sha ?? null
      } catch (e) {
        if (e.status === 404) return null
        throw e
      }
    },

    /**
     * 파일을 쓴다. `sha` 를 주면 그 버전에서만 덮어쓴다(낙관적 락).
     * 그 사이 다른 곳에서 바뀌었으면 409 가 오고, 호출부가 다시 읽어 병합한다.
     */
    async putFile(path, base64, { message, sha }) {
      try {
        return await api(contentsPath(path), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, content: base64, branch, ...(sha ? { sha } : {}) }),
        })
      } catch (e) {
        // 어느 리포의 어느 파일에서 실패했는지 메시지에 남긴다.
        if (e instanceof GitHubError) e.message = `${e.message} (${cfg.repo}/${path})`
        throw e
      }
    },

    putJson(path, value, opts) {
      return this.putFile(path, jsonToBase64(value), opts)
    },

    async putBlob(path, blob, opts) {
      return this.putFile(path, await blobToBase64(blob), opts)
    },

    /**
     * 브랜치의 전체 파일 경로 목록. 요청 1회로 리포에 뭐가 있는지 다 안다.
     *
     * 사진 존재 확인을 파일마다 `headSha` 로 하면 N회 요청이 되고, raw 는
     * 5분 캐시라 방금 지워진 파일을 아직 있다고 답한다. 트리는 즉시 정확하다.
     *
     * @returns {Promise<Set<string>|null>} 경로 집합. 리포가 비었거나
     *          항목이 10만개를 넘어 잘렸으면 null (= 판단 보류).
     */
    async listPaths() {
      try {
        // 브랜치 끝 커밋을 캐시 없이 얻고, 그 sha 로 트리를 읽는다 (sha 기준이라 캐시돼도 정확)
        const ref = await api(
          `/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${encodeURIComponent(branch)}?t=${Date.now()}`,
          { cache: 'no-store' },
        )
        const r = await api(
          `/repos/${cfg.owner}/${cfg.repo}/git/trees/${ref.object.sha}?recursive=1`,
          { cache: 'no-store' },
        )
        if (r?.truncated) return null
        return new Set((r?.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path))
      } catch (e) {
        if (e.status === 404 || e.status === 409) return new Set()
        throw e
      }
    },

    /** 파일이 이미 있으면 건너뛴다. 사진은 한 번 올리면 바뀌지 않는다. */
    async putBlobIfAbsent(path, blob, message) {
      const sha = await this.headSha(path)
      if (sha) return { skipped: true, path }
      for (let attempt = 0; ; attempt++) {
        try {
          await this.putBlob(path, blob, { message })
          return { skipped: false, path }
        } catch (e) {
          // 확인과 쓰기 사이에 이미 생겼다(이전 동기화가 올렸거나 API 복제 지연).
          // 사진은 한 번 올리면 바뀌지 않으므로 있는 것으로 충분하다.
          if (e.status === 422 && /sha/i.test(e.message)) return { skipped: true, path }
          // 409: 다른 기기가 같은 브랜치에 동시에 커밋해 브랜치 끝이 움직였다.
          // 파일 경로는 겹치지 않으므로 잠시 뒤 그대로 다시 보내면 된다.
          if (e.status !== 409 || attempt >= 2) throw e
          await sleep(1000 * 2 ** attempt)
        }
      }
    },

    /**
     * 파일을 지운다. 이미 없으면 아무것도 하지 않는다.
     * 409(다른 기기의 동시 커밋)는 던진다 — 호출부가 대기 목록에 남겨 다음 동기화 때 다시 지운다.
     * @returns {Promise<boolean>} 실제로 지웠으면 true
     */
    async deleteFile(path, message) {
      const sha = await this.headSha(path)
      if (!sha) return false
      try {
        await api(contentsPath(path), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sha, branch }),
        })
        return true
      } catch (e) {
        // 확인과 삭제 사이에 이미 지워졌다.
        if (e.status === 404) return false
        throw e
      }
    },

    /** 토큰이 가리키는 사용자. */
    async whoami() {
      if (!cfg.token) throw new GitHubError('토큰이 없습니다', 401, null)
      const user = await api('/user')
      return user.login
    },

    /**
     * 이 클라이언트가 가리키는 리포의 상태.
     *
     * `defaultBranch` 와 `empty` 를 함께 본다. 갓 만든 리포는 커밋이 없어
     * 기본 브랜치도 없는데, 그 상태에서 `branch` 를 지정해 쓰면 실패한다.
     */
    async repoInfo() {
      const repo = await api(`/repos/${cfg.owner}/${cfg.repo}`)
      let empty = false
      try {
        await api(`/repos/${cfg.owner}/${cfg.repo}/commits?per_page=1`)
      } catch (e) {
        if (e.status === 409) empty = true // "Git Repository is empty"
        else if (e.status !== 404) throw e
      }
      return {
        fullName: repo.full_name,
        canWrite: Boolean(repo.permissions?.push),
        isPrivate: Boolean(repo.private),
        defaultBranch: repo.default_branch ?? null,
        empty,
      }
    },
  }
}
