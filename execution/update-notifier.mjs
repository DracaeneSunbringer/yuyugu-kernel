import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_GITHUB_REPO = 'DracaeneSunbringer/yuyugu-kernel'
const DEFAULT_BRANCH = 'main'
const DEFAULT_CHECK_INTERVAL_MS = 2 * 3600 * 1000
const DEFAULT_BANNER_REPEAT_MS = 2 * 3600 * 1000
const DEFAULT_TIMEOUT_MS = 4500

export function parseSemverTuple(versionStr) {
  const clean = String(versionStr || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
  const parts = clean.split('.').map((x) => Number.parseInt(x, 10))
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return [0, 0, 0]
  }
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

export function compareSemver(a, b) {
  const va = parseSemverTuple(a)
  const vb = parseSemverTuple(b)
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] > vb[i] ? 1 : -1
  }
  return 0
}

export function readLocalPackageMeta(rootDir) {
  try {
    const pkgPath = path.join(rootDir, 'package.json')
    const raw = fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return {
      name: String(parsed.name || 'yuyugu-unified-kernel'),
      version: String(parsed.version || '0.0.0'),
      repository: String(parsed.repository?.url || parsed.repository || `https://github.com/${DEFAULT_GITHUB_REPO}`),
      releaseNotes: parsed.releaseNotes || null,
    }
  } catch {
    return {
      name: 'yuyugu-unified-kernel',
      version: '0.0.0',
      repository: `https://github.com/${DEFAULT_GITHUB_REPO}`,
      releaseNotes: null,
    }
  }
}

function buildDefaultManifestEndpoints(repoSlug = DEFAULT_GITHUB_REPO, branch = DEFAULT_BRANCH, customUrl = null) {
  if (customUrl) return [{ url: String(customUrl), kind: 'raw' }]
  return [
    {
      url: `https://api.github.com/repos/${repoSlug}/contents/package.json?ref=${encodeURIComponent(branch)}`,
      kind: 'github-contents',
    },
    {
      url: `https://raw.githubusercontent.com/${repoSlug}/${encodeURIComponent(branch)}/package.json`,
      kind: 'raw',
    },
  ]
}

function decodeManifestPayload(payload, endpointKind) {
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.version === 'string') return payload
  if (endpointKind === 'github-contents' && typeof payload.content === 'string') {
    const decoded = Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8')
    const inner = JSON.parse(decoded.replace(/^\uFEFF/, ''))
    if (inner && typeof inner.version === 'string') return inner
  }
  return null
}

export function formatUpdateBanner(status) {
  if (!status?.hasUpdate) return ''
  const cur = status.localVersion || '0.0.0'
  const next = status.latestVersion || cur
  const sev = status.severity ? ` [${status.severity}]` : ''
  const datePart = status.releaseDate ? ` (${status.releaseDate})` : ''
  const summary = status.summary || '包含问题修复与策略改进，建议尽快拉取更新。'
  const cmd = status.upgradeCommand || 'git pull'
  const repoUrl = status.repositoryUrl || `https://github.com/${DEFAULT_GITHUB_REPO}`
  const border = '═'.repeat(70)
  return [
    `╔${border}╗`,
    `║ [UPDATE] 发现新版本 v${next}（当前运行 v${cur}）${sev}${datePart}`,
    `║ 更新说明: ${summary}`,
    `║ 升级命令: ${cmd}  （拉取后重启守护进程生效）`,
    `║ 仓库地址: ${repoUrl}`,
    `╚${border}╝`,
  ].join('\n')
}

export function formatInlineUpdateTag(status) {
  if (!status?.hasUpdate) return ''
  const cmd = status.upgradeCommand || 'git pull'
  return ` [有新版本 v${status.latestVersion} -> ${cmd}]`
}

export class UpdateNotifier {
  constructor({
    rootDir,
    stateFilePath = null,
    repoSlug = process.env.MEME_UPDATE_REPO || DEFAULT_GITHUB_REPO,
    branch = process.env.MEME_UPDATE_BRANCH || DEFAULT_BRANCH,
    manifestUrl = process.env.MEME_UPDATE_MANIFEST_URL || null,
    webhookUrl = process.env.MEME_UPDATE_WEBHOOK_URL || null,
    enabled = process.env.MEME_NO_UPDATE_CHECK !== '1',
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    bannerRepeatMs = DEFAULT_BANNER_REPEAT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchFn = globalThis.fetch,
    nowMsFn = () => Date.now(),
    logger = console.log,
  } = {}) {
    this.rootDir = rootDir
    this.stateFilePath = stateFilePath
    this.repoSlug = repoSlug
    this.branch = branch
    this.manifestUrl = manifestUrl
    this.webhookUrl = webhookUrl
    this.enabled = Boolean(enabled) && typeof fetchFn === 'function'
    this.checkIntervalMs = Math.max(60_000, Number(checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS)
    this.bannerRepeatMs = Math.max(60_000, Number(bannerRepeatMs) || DEFAULT_BANNER_REPEAT_MS)
    this.timeoutMs = Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    this.fetchFn = fetchFn
    this.nowMsFn = nowMsFn
    this.logger = logger

    const localMeta = readLocalPackageMeta(rootDir)
    this.localVersion = localMeta.version
    this.repositoryUrl = localMeta.repository.replace(/\.git$/i, '')

    this.lastCheckedAtMs = 0
    this.lastBannerPrintedAtMs = 0
    this.lastBannerVersion = null
    this.lastWebhookNotifiedVersion = null
    this.inFlightPromise = null
    this.status = {
      checkedAt: null,
      localVersion: this.localVersion,
      latestVersion: this.localVersion,
      hasUpdate: false,
      severity: null,
      releaseDate: null,
      summary: null,
      upgradeCommand: 'git pull',
      repositoryUrl: this.repositoryUrl,
      sourceUrl: null,
      error: null,
    }

    this._loadPersistedState()
  }

  _loadPersistedState() {
    if (!this.stateFilePath) return
    try {
      if (!fs.existsSync(this.stateFilePath)) return
      const saved = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8'))
      if (saved && typeof saved === 'object') {
        if (typeof saved.lastWebhookNotifiedVersion === 'string') {
          this.lastWebhookNotifiedVersion = saved.lastWebhookNotifiedVersion
        }
        if (typeof saved.latestVersion === 'string' && compareSemver(saved.latestVersion, this.localVersion) > 0) {
          this.status = {
            ...this.status,
            latestVersion: saved.latestVersion,
            hasUpdate: true,
            severity: saved.severity || null,
            releaseDate: saved.releaseDate || null,
            summary: saved.summary || null,
            upgradeCommand: saved.upgradeCommand || 'git pull',
            checkedAt: saved.checkedAt || null,
          }
        }
      }
    } catch {}
  }

  _persistState() {
    if (!this.stateFilePath) return
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true })
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(
          {
            ...this.status,
            lastWebhookNotifiedVersion: this.lastWebhookNotifiedVersion,
          },
          null,
          2
        ) + '\n',
        'utf8'
      )
    } catch {}
  }

  async _fetchRemoteManifest() {
    const endpoints = buildDefaultManifestEndpoints(this.repoSlug, this.branch, this.manifestUrl)
    let lastErr = null
    for (const ep of endpoints) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      try {
        const headers = {
          'user-agent': `yuyugu-unified-kernel/${this.localVersion}`,
          accept: 'application/json',
        }
        const resp = await this.fetchFn(ep.url, {
          method: 'GET',
          headers,
          signal: ctrl.signal,
        })
        if (!resp || !resp.ok) {
          lastErr = `HTTP ${resp?.status ?? 'ERR'}`
          continue
        }
        const json = await resp.json()
        const manifest = decodeManifestPayload(json, ep.kind)
        if (manifest && typeof manifest.version === 'string') {
          return { manifest, sourceUrl: ep.url }
        }
        lastErr = 'invalid-manifest'
      } catch (err) {
        lastErr = err?.message || String(err)
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(lastErr || 'manifest-unreachable')
  }

  async _sendWebhookIfNeeded(status) {
    if (!this.webhookUrl || !status?.hasUpdate) return
    if (this.lastWebhookNotifiedVersion === status.latestVersion) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const text = `[yuyugu-kernel] 发现新版本 v${status.latestVersion}（当前 v${status.localVersion}）：${status.summary || '请拉取更新'} | 升级: ${status.upgradeCommand || 'git pull'}`
      const resp = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'text',
          msgtype: 'text',
          title: `yuyugu-kernel v${status.latestVersion} 更新提醒`,
          text,
          content: { text },
        }),
        signal: ctrl.signal,
      })
      if (resp && resp.ok) {
        this.lastWebhookNotifiedVersion = status.latestVersion
      }
    } catch {} finally {
      clearTimeout(timer)
    }
  }

  async checkNow({ printBanner = true } = {}) {
    if (!this.enabled) return this.status
    if (this.inFlightPromise) return this.inFlightPromise

    this.inFlightPromise = (async () => {
      const nowMs = this.nowMsFn()
      this.lastCheckedAtMs = nowMs
      try {
        // Re-read local package.json in case user already ran `git pull` on disk without restarting yet!
        const diskMeta = readLocalPackageMeta(this.rootDir)
        const { manifest, sourceUrl } = await this._fetchRemoteManifest()
        const remoteVer = String(manifest.version || '0.0.0').trim()
        const hasUpdate = compareSemver(remoteVer, this.localVersion) > 0
        const notes = manifest.releaseNotes && typeof manifest.releaseNotes === 'object'
          ? manifest.releaseNotes
          : {}
        const diskAlreadyPulled = hasUpdate && compareSemver(diskMeta.version, this.localVersion) >= 0 && compareSemver(diskMeta.version, remoteVer) >= 0

        this.status = {
          checkedAt: new Date(nowMs).toISOString(),
          localVersion: this.localVersion,
          diskVersion: diskMeta.version,
          latestVersion: remoteVer,
          hasUpdate,
          severity: notes.severity || null,
          releaseDate: notes.date || null,
          summary: notes.summary || null,
          upgradeCommand: diskAlreadyPulled
            ? '本地代码已拉取至最新版，请重启脚本进程使新代码生效'
            : (notes.upgradeCommand || 'git pull'),
          repositoryUrl: String(manifest.repository?.url || manifest.repository || this.repositoryUrl).replace(/\.git$/i, ''),
          sourceUrl,
          error: null,
        }

        if (hasUpdate) {
          await this._sendWebhookIfNeeded(this.status)
          const shouldPrint =
            printBanner &&
            (this.lastBannerVersion !== remoteVer || nowMs - this.lastBannerPrintedAtMs >= this.bannerRepeatMs)
          if (shouldPrint && typeof this.logger === 'function') {
            this.logger(formatUpdateBanner(this.status))
            this.lastBannerPrintedAtMs = nowMs
            this.lastBannerVersion = remoteVer
          }
        }
        this._persistState()
      } catch (err) {
        this.status = {
          ...this.status,
          checkedAt: new Date(nowMs).toISOString(),
          error: err?.message || String(err),
        }
      } finally {
        this.inFlightPromise = null
      }
      return this.status
    })()

    return this.inFlightPromise
  }

  maybeCheckInBackground() {
    if (!this.enabled) return
    const nowMs = this.nowMsFn()
    if (this.lastCheckedAtMs > 0 && nowMs - this.lastCheckedAtMs < this.checkIntervalMs) {
      if (
        this.status.hasUpdate &&
        nowMs - this.lastBannerPrintedAtMs >= this.bannerRepeatMs &&
        typeof this.logger === 'function'
      ) {
        this.logger(formatUpdateBanner(this.status))
        this.lastBannerPrintedAtMs = nowMs
        this.lastBannerVersion = this.status.latestVersion
      }
      return
    }
    void this.checkNow({ printBanner: true }).catch(() => {})
  }

  inlineTag() {
    return formatInlineUpdateTag(this.status)
  }
}
