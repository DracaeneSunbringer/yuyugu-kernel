import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Hardened Idempotency-Aware HTTP Session & Bucket Rate-Limiter (`execution/http-client.mjs`)
 *
 * Enforces strict separation between:
 * 1. Idempotent requests (`GET`, and `POST` carrying a server-deduplicated `operation` UUID on
 *    `/api/pet/world/act`, `/api/pet/battle`, `/api/pet/battle/buy`, `/api/pet/battle/enhance`,
 *    `/api/pet/battle/respec`, `/api/pet/battle/train`, `/api/pet/state`):
 *      -> Safe bounded retry on network timeout / `502..504` / `429` reusing the exact `operation` UUID.
 * 2. Non-idempotent POSTs (`/api/pet/world/visit/:id`, `/api/pet/world/help/:id`, `/api/pet/battle/chest`,
 *    `/api/pet/battle/equip`, `/api/pet/battle/points`, `/api/huancai/*`):
 *      -> ZERO automatic retries on timeout / abort / network error / `5xx` (`sendCount === 1`),
 *         routing ambiguous outcomes straight into `reconcileUnknownWithFreshWorld` instead of
 *         legacy's 5-retry duplicate-fine cascade!
 *      -> Only explicit HTTP `429` (rate-limited BEFORE server handler execution) may retry with `Retry-After`.
 */

const OPERATION_IDEMPOTENT_POST_PATHS = new Set([
  '/api/pet/world/act',
  '/api/pet/battle',
  '/api/pet/battle/buy',
  '/api/pet/battle/enhance',
  '/api/pet/battle/respec',
  '/api/pet/battle/train',
  '/api/pet/state',
])

const PLACEHOLDER_COOKIE_RE = /^(YOUR_SID_COOKIE_VALUE|YOUR_SESSION_COOKIE_VALUE|粘贴.*Cookie.*|粘贴你的sid值)$/i

export function normalizeCookieHeaderString(rawInput, sourceLabel = 'cookie') {
  let s = String(rawInput ?? '').replace(/[\r\n]+/g, ' ').trim()
  // Strip accidental surrounding quotes or copied `Cookie:` header prefix (even if repeated)
  while (/^cookie\s*:/i.test(s)) {
    s = s.replace(/^cookie\s*:\s*/i, '').trim()
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
    while (/^cookie\s*:/i.test(s)) {
      s = s.replace(/^cookie\s*:\s*/i, '').trim()
    }
  }
  if (!s) {
    throw new Error(`Empty cookie value in ${sourceLabel}`)
  }

  // Bare token copied from DevTools `Application -> Cookies -> sid -> Value` (no `=`)
  if (!s.includes('=')) {
    if (PLACEHOLDER_COOKIE_RE.test(s)) {
      throw new Error(`Unreplaced placeholder cookie in ${sourceLabel}; please paste your real 'sid' cookie`)
    }
    return `sid=${s}`
  }

  const parts = s.split(';').map((p) => p.trim()).filter(Boolean)
  const parsed = parts.map((part) => {
    const eqIdx = part.indexOf('=')
    if (eqIdx < 0) return { key: '', val: part, raw: part }
    return {
      key: part.slice(0, eqIdx).trim(),
      val: part.slice(eqIdx + 1).trim(),
      raw: part,
    }
  })

  const hasSid = parsed.some((p) => p.key.toLowerCase() === 'sid')
  const normalized = parsed.map((p) => {
    if (!p.key) return p.raw
    let key = p.key
    if (key.toLowerCase() === 'sid') {
      key = 'sid'
    } else if (!hasSid && key.toLowerCase() === 'session') {
      // Tolerate legacy `.session.example.json` prefix `session=<real_sid_value>`
      key = 'sid'
    }
    if (key === 'sid' && (!p.val || PLACEHOLDER_COOKIE_RE.test(p.val))) {
      throw new Error(`Unreplaced placeholder cookie in ${sourceLabel}; please paste your real 'sid' cookie`)
    }
    return `${key}=${p.val}`
  })

  return normalized.join('; ')
}

export function parseSessionCookieHeader(sessionFilePath) {
  const raw = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8').replace(/^\uFEFF/, ''))
  if (typeof raw === 'string') return normalizeCookieHeaderString(raw, sessionFilePath)
  if (typeof raw?.sid === 'string' && raw.sid.trim()) {
    return normalizeCookieHeaderString(raw.sid, sessionFilePath)
  }
  if (typeof raw?.cookie === 'string' && raw.cookie.trim()) {
    return normalizeCookieHeaderString(raw.cookie, sessionFilePath)
  }
  if (typeof raw?.cookieHeader === 'string' && raw.cookieHeader.trim()) {
    return normalizeCookieHeaderString(raw.cookieHeader, sessionFilePath)
  }
  if (raw?.cookies && typeof raw.cookies === 'object' && !Array.isArray(raw.cookies)) {
    const joined = Object.entries(raw.cookies)
      .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? (v.value ?? '') : v}`)
      .join('; ')
    return normalizeCookieHeaderString(joined, sessionFilePath)
  }
  if (Array.isArray(raw?.cookies)) {
    const joined = raw.cookies
      .map((c) => (typeof c === 'string' ? c.split(';')[0] : `${c.name}=${c.value}`))
      .join('; ')
    return normalizeCookieHeaderString(joined, sessionFilePath)
  }
  throw new Error(`Unrecognized session format in ${sessionFilePath}`)
}

export function parseCredentialsFile(credentialsFilePath) {
  if (!credentialsFilePath) {
    throw new Error('Credentials file path is required')
  }
  const raw = JSON.parse(fs.readFileSync(credentialsFilePath, 'utf8').replace(/^\uFEFF/, ''))
  const login = String(raw?.login ?? raw?.username ?? '').trim()
  const password = typeof raw?.password === 'string' ? raw.password : ''
  if (!login || !password) {
    throw new Error(`Invalid credentials format in ${credentialsFilePath} (expected { login, password })`)
  }
  return { login, password }
}

export function extractCookiesFromSetCookieHeaders(headers) {
  let list = []
  if (headers && typeof headers.getSetCookie === 'function') {
    list = headers.getSetCookie()
  } else if (Array.isArray(headers)) {
    list = headers
  } else if (headers && typeof headers.get === 'function') {
    const single = headers.get('set-cookie')
    if (single) list = [single]
  } else if (headers && typeof headers === 'object' && headers['set-cookie']) {
    const v = headers['set-cookie']
    list = Array.isArray(v) ? v : [v]
  }
  const out = {}
  for (const entry of list) {
    const firstSeg = String(entry || '').split(';')[0].trim()
    const eqIdx = firstSeg.indexOf('=')
    if (eqIdx <= 0) continue
    const name = firstSeg.slice(0, eqIdx).trim()
    const val = firstSeg.slice(eqIdx + 1).trim()
    if (!name || !val) continue
    out[name] = val
  }
  return out
}

export function atomicUpdateSessionCookies(sessionFilePath, newCookies, meta = {}) {
  if (!sessionFilePath) {
    throw new Error('sessionFilePath is required to update cookies')
  }
  let existing = {}
  try {
    if (fs.existsSync(sessionFilePath)) {
      const parsed = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed
      }
    }
  } catch {}
  const mergedCookies = (existing.cookies && typeof existing.cookies === 'object' && !Array.isArray(existing.cookies))
    ? { ...existing.cookies }
    : {}
  for (const [k, v] of Object.entries(newCookies || {})) {
    if (v != null && String(v).trim() !== '') {
      mergedCookies[k] = String(v).trim()
    }
  }
  const nextObj = { ...existing }
  delete nextObj.cookie
  delete nextObj.cookieHeader
  delete nextObj.sid
  nextObj.cookies = mergedCookies
  nextObj.extracted_at = meta.nowMs ?? Date.now()
  nextObj.how = meta.how || 'password-login'
  fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true })
  const tmpPath = `${sessionFilePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`
  fs.writeFileSync(tmpPath, JSON.stringify(nextObj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(tmpPath, 0o600) } catch {}
  fs.renameSync(tmpPath, sessionFilePath)
  return nextObj
}

export function classifyBucket(method, apiPath) {
  const cleanPath = String(apiPath || '').split('?')[0]
  if (method === 'GET') return { bucket: 'get', minGapMs: 50, isWrite: false }
  if (cleanPath === '/api/pet/world/act') return { bucket: 'world-act', minGapMs: 2200, isWrite: true }
  if (cleanPath.startsWith('/api/pet/world/visit/')) return { bucket: 'world-visit', minGapMs: 2200, isWrite: true }
  if (cleanPath.startsWith('/api/pet/world/help/')) return { bucket: 'world-help', minGapMs: 2200, isWrite: true }
  if (cleanPath === '/api/pet/battle/equip') return { bucket: 'battle-equip', minGapMs: 1200, isWrite: true }
  if (cleanPath === '/api/pet/battle') return { bucket: 'battle-fight', minGapMs: 1200, isWrite: true }
  if (cleanPath === '/api/pet/state') return { bucket: 'pet-state', minGapMs: 1200, isWrite: true }
  return { bucket: 'default-write', minGapMs: 300, isWrite: true }
}

export function isRequestIdempotent(method, apiPath, body) {
  const upper = String(method || 'GET').toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') return true
  if (upper !== 'POST') return false
  const cleanPath = String(apiPath || '').split('?')[0]
  if (!OPERATION_IDEMPOTENT_POST_PATHS.has(cleanPath)) return false
  return typeof body?.operation === 'string' && body.operation.trim().length > 0
}

export class KernelHttpClient {
  constructor({
    baseUrl = 'https://52dmeme.com',
    cookieHeader = '',
    sessionFilePath = null,
    dryRun = false,
    timeoutMs = 15000,
    maxIdempotentRetries = 2,
    maxRateLimitRetries = 2,
    crossWriteMinGapMs = 120,
    autoRelogin = null,
    fetchImpl = globalThis.fetch,
    nowMsFn = Date.now,
    sleepMsFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    userAgent = '52dmeme-unified-kernel/1.0',
  } = {}) {
    this.baseUrl = baseUrl
    this.sessionFilePath = sessionFilePath
    this._staticCookieHeader = cookieHeader
    this.dryRun = Boolean(dryRun)
    this.timeoutMs = timeoutMs
    this.maxIdempotentRetries = maxIdempotentRetries
    this.maxRateLimitRetries = maxRateLimitRetries
    this.crossWriteMinGapMs = crossWriteMinGapMs
    this._autoRelogin = {
      enabled: Boolean(autoRelogin?.enabled),
      credentialsFilePath: autoRelogin?.credentialsFilePath || null,
      cooldownMs: Number.isFinite(autoRelogin?.cooldownMs) ? Math.max(0, autoRelogin.cooldownMs) : 600_000,
      maxAttemptsPerHour: Number.isFinite(autoRelogin?.maxAttemptsPerHour)
        ? Math.max(1, Math.floor(autoRelogin.maxAttemptsPerHour))
        : 2,
      lockStaleMs: 30_000,
    }
    this._reloginCircuitBroken = false
    this._reloginCircuitReason = null
    this._reloginAttemptAtMs = []
    this._reloginInFlight = null
    this.fetchImpl = fetchImpl
    this.nowMsFn = nowMsFn
    this.sleepMsFn = sleepMsFn
    this.userAgent = userAgent

    this._bucketLastAtMs = new Map()
    this._lastWriteAtMs = 0
    this._bucketChain = new Map()
    this.serverClockOffsetMs = 0
    this._offsetLoMs = -Infinity
    this._offsetHiMs = Infinity
    this._lastClockSampleAtMs = 0
    this.hasCalibratedClock = false
    this.lastRttMs = 600
    this.stats = {
      getCount: 0,
      postCount: 0,
      retryCount: 0,
      rateLimitCount: 0,
      networkErrorCount: 0,
      reloginCount: 0,
      reloginFailCount: 0,
    }
  }

  getCookieHeader() {
    if (this._staticCookieHeader) return normalizeCookieHeaderString(this._staticCookieHeader, 'cookieHeader')
    if (this.sessionFilePath) {
      if (
        !fs.existsSync(this.sessionFilePath) &&
        this._autoRelogin.enabled &&
        !this._reloginCircuitBroken &&
        !this.dryRun
      ) {
        return ''
      }
      return parseSessionCookieHeader(this.sessionFilePath)
    }
    throw new Error('KernelHttpClient requires cookieHeader or sessionFilePath')
  }

  _isAuthExpired(status, parsedBody) {
    if (status === 401) return true
    if (status === 403) {
      const msg = String(parsedBody?.error || parsedBody?.msg || '')
      return /请先登录|未登录|login required|unauthorized/i.test(msg)
    }
    return false
  }

  async _withReloginLock(fn) {
    if (!this.sessionFilePath) return await fn()
    const lockPath = `${this.sessionFilePath}.relogin.lock`
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`
    const deadline = Date.now() + 10_000
    let acquired = false
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx')
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
        fs.closeSync(fd)
        acquired = true
        break
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err
        try {
          const st = fs.statSync(lockPath)
          if (st.mtimeMs + this._autoRelogin.lockStaleMs < Date.now()) {
            fs.unlinkSync(lockPath)
          }
        } catch {}
        await this.sleepMsFn(40)
      }
    }
    if (!acquired) return false
    try {
      return await fn()
    } finally {
      try {
        const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
        if (raw?.token === token) fs.unlinkSync(lockPath)
      } catch {}
    }
  }

  async _rawAuthFetch(apiPath, { method = 'GET', body = undefined, refererPath = '/account-password.html' } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const originUrl = new URL(this.baseUrl).origin
      const url = new URL(apiPath, this.baseUrl).toString()
      const headers = {
        accept: 'application/json',
        origin: originUrl,
        referer: `${originUrl}${refererPath}`,
        'sec-fetch-site': 'same-origin',
        'user-agent': this.userAgent,
      }
      let payload = undefined
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        headers['content-type'] = 'application/json'
        payload = JSON.stringify(body)
      }
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: controller.signal,
      })
      let parsed = {}
      try {
        const txt = await res.text()
        parsed = txt ? JSON.parse(txt) : {}
      } catch {}
      return { ok: res.status >= 200 && res.status < 300, status: res.status, headers: res.headers, body: parsed }
    } catch (err) {
      return { ok: false, status: null, headers: null, body: null, error: err?.message || String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  async _reloginSingleFlight(failedCookieHeader) {
    if (!this._autoRelogin.enabled || this._reloginCircuitBroken || this.dryRun) return false
    if (this._reloginInFlight) return this._reloginInFlight
    this._reloginInFlight = (async () => {
      return await this._withReloginLock(async () => {
        if (!this._autoRelogin.enabled || this._reloginCircuitBroken || this.dryRun) return false

        // Another process/request may already have updated the on-disk session while we waited
        if (this.sessionFilePath && fs.existsSync(this.sessionFilePath)) {
          try {
            const diskCookie = parseSessionCookieHeader(this.sessionFilePath)
            if (diskCookie && diskCookie !== failedCookieHeader) {
              return true
            }
          } catch {}
        }

        const now = this.nowMsFn()
        this._reloginAttemptAtMs = this._reloginAttemptAtMs.filter((t) => now - t < 3_600_000)
        if (this._reloginAttemptAtMs.length >= this._autoRelogin.maxAttemptsPerHour) {
          return false
        }
        if (
          this._reloginAttemptAtMs.length > 0 &&
          (now - this._reloginAttemptAtMs[this._reloginAttemptAtMs.length - 1]) < this._autoRelogin.cooldownMs
        ) {
          return false
        }

        let creds
        try {
          creds = parseCredentialsFile(this._autoRelogin.credentialsFilePath)
        } catch (err) {
          this._reloginCircuitBroken = true
          this._reloginCircuitReason = 'missing-or-invalid-credentials'
          this.stats.reloginFailCount++
          console.error(`[${new Date().toISOString()}] [AUTH] Auto-relogin circuit-broken: ${err?.message || 'invalid credentials'}`)
          return false
        }

        const cfgRes = await this._rawAuthFetch('/api/auth/config', { method: 'GET', refererPath: '/login' })
        if (cfgRes.ok && cfgRes.body && cfgRes.body.password_login === false) {
          this._reloginCircuitBroken = true
          this._reloginCircuitReason = 'password-login-disabled'
          this.stats.reloginFailCount++
          console.error(`[${new Date().toISOString()}] [AUTH] Auto-relogin circuit-broken: site disabled password_login`)
          return false
        }
        if (!cfgRes.ok && cfgRes.status == null) {
          this.stats.reloginFailCount++
          return false
        }

        this._reloginAttemptAtMs.push(this.nowMsFn())
        const loginRes = await this._rawAuthFetch('/api/auth/password-login', {
          method: 'POST',
          body: { login: creds.login, password: creds.password, next: '/pets' },
          refererPath: '/account-password.html',
        })
        if (loginRes.status === 400 || loginRes.status === 401 || loginRes.status === 403) {
          this._reloginCircuitBroken = true
          this._reloginCircuitReason = `auth-rejected:${loginRes.status}`
          this.stats.reloginFailCount++
          console.error(`[${new Date().toISOString()}] [AUTH] Auto-relogin circuit-broken: HTTP ${loginRes.status} (${loginRes.body?.error || 'rejected'})`)
          return false
        }
        if (!loginRes.ok) {
          this.stats.reloginFailCount++
          return false
        }

        const cookies = extractCookiesFromSetCookieHeaders(loginRes.headers)
        if (Object.keys(cookies).length === 0) {
          this.stats.reloginFailCount++
          return false
        }

        if (this.sessionFilePath) {
          atomicUpdateSessionCookies(this.sessionFilePath, cookies, { nowMs: this.nowMsFn(), how: 'password-login' })
        }
        if (this._staticCookieHeader || !this.sessionFilePath) {
          this._staticCookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
        }
        this.stats.reloginCount++
        console.log(`[${new Date().toISOString()}] [AUTH] Session cookie refreshed via password-login for ${this.sessionFilePath || 'memory-client'}`)
        return true
      })
    })()
    try {
      return await this._reloginInFlight
    } finally {
      this._reloginInFlight = null
    }
  }

  observeServerTimestampSec(serverSec, reqStartLocalMs = null) {
    if (!Number.isFinite(serverSec) || serverSec <= 0) return
    const respEndMs = this.nowMsFn()
    const startMs = Number.isFinite(reqStartLocalMs) ? Math.min(reqStartLocalMs, respEndMs) : respEndMs
    // Exact truncation interval: `serverSec = floor(serverTrueMs / 1000)` at `t in [startMs, respEndMs]`
    // implies `(serverSec * 1000 - respEndMs) <= trueOffsetMs <= (serverSec * 1000 + 999 - startMs)`.
    const sampleLo = serverSec * 1000 - respEndMs
    const sampleHi = serverSec * 1000 + 999 - startMs
    if (!this.hasCalibratedClock) {
      this._offsetLoMs = sampleLo
      this._offsetHiMs = sampleHi
      this.hasCalibratedClock = true
    } else {
      const elapsedMs = Math.max(0, respEndMs - this._lastClockSampleAtMs)
      const driftPad = Math.min(250, Math.ceil(elapsedMs * 0.0005))
      const nextLo = Math.max(this._offsetLoMs - driftPad, sampleLo)
      const nextHi = Math.min(this._offsetHiMs + driftPad, sampleHi)
      if (nextLo <= nextHi) {
        this._offsetLoMs = nextLo
        this._offsetHiMs = nextHi
      } else {
        this._offsetLoMs = sampleLo
        this._offsetHiMs = sampleHi
      }
    }
    this._lastClockSampleAtMs = respEndMs
    // Continuous zero-offset clamping: when `0 in [offsetLoMs, offsetHiMs]` OR the nearest endpoint
    // is within 120ms of zero (jitter tolerance), clamp to `0`; otherwise use nearest endpoint to 0.
    if (this._offsetLoMs <= 0 && 0 <= this._offsetHiMs) {
      this.serverClockOffsetMs = 0
    } else {
      const nearestToZero = 0 < this._offsetLoMs ? this._offsetLoMs : this._offsetHiMs
      this.serverClockOffsetMs = Math.abs(nearestToZero) <= 120 ? 0 : nearestToZero
    }
  }

  estimatedServerNowMs() {
    return this.nowMsFn() + this.serverClockOffsetMs
  }

  estimatedServerNowSec() {
    return Math.floor(this.estimatedServerNowMs() / 1000)
  }

  serverSecToLocalMs(targetServerSec, extraOffsetMs = 0) {
    return Number(targetServerSec) * 1000 + Number(extraOffsetMs || 0) - this.serverClockOffsetMs
  }

  async sleepUntilServerSec(targetServerSec, extraOffsetMs = 35) {
    const targetServerMs = targetServerSec * 1000 + extraOffsetMs
    const waitMs = targetServerMs - this.estimatedServerNowMs()
    if (waitMs > 0) {
      await this.sleepMsFn(waitMs)
    }
    return Math.max(0, waitMs)
  }

  getRemainingBucketCooldownMs(method, apiPath, minGapOverrideMs = null) {
    const upper = String(method || 'GET').toUpperCase()
    const { bucket, minGapMs, isWrite } = classifyBucket(upper, apiPath)
    const effGap = minGapOverrideMs != null ? minGapOverrideMs : minGapMs
    const now = this.nowMsFn()
    const lastBucket = this._bucketLastAtMs.get(bucket) || 0
    const needBucketWait = Math.max(0, lastBucket + effGap - now)
    const needCrossWait = isWrite ? Math.max(0, this._lastWriteAtMs + this.crossWriteMinGapMs - now) : 0
    return Math.max(needBucketWait, needCrossWait)
  }

  async _acquireBucketSlot(method, apiPath, minGapOverrideMs = null) {
    const { bucket, minGapMs, isWrite } = classifyBucket(method, apiPath)
    const effGap = minGapOverrideMs != null ? minGapOverrideMs : minGapMs
    const prev = this._bucketChain.get(bucket) || Promise.resolve()
    let release
    const gate = new Promise((r) => { release = r })
    this._bucketChain.set(bucket, prev.then(() => gate))
    await prev
    try {
      const now = this.nowMsFn()
      const lastBucket = this._bucketLastAtMs.get(bucket) || 0
      const needBucketWait = Math.max(0, lastBucket + effGap - now)
      const needCrossWait = isWrite ? Math.max(0, this._lastWriteAtMs + this.crossWriteMinGapMs - now) : 0
      const waitMs = Math.max(needBucketWait, needCrossWait)
      if (waitMs > 0) {
        await this.sleepMsFn(waitMs)
      }
      const mark = this.nowMsFn()
      this._bucketLastAtMs.set(bucket, mark)
      if (isWrite) this._lastWriteAtMs = mark
    } finally {
      release()
    }
  }

  async request(apiPath, {
    method = 'GET',
    body = undefined,
    timeoutMs = this.timeoutMs,
    minGapMs = null,
    bypassRateLimitForUrgentSnipe = false,
  } = {}) {
    const upper = String(method || 'GET').toUpperCase()
    if (!String(apiPath || '').startsWith('/api/')) {
      throw new Error(`Disallowed API path: ${apiPath}`)
    }
    if (this.dryRun && upper !== 'GET' && upper !== 'HEAD') {
      throw new Error(`DRY_RUN_WRITE_FIREWALL: blocked ${upper} ${apiPath}`)
    }

    const idempotent = isRequestIdempotent(upper, apiPath, body)
    const maxNetworkAttempts = idempotent ? (1 + Math.max(0, this.maxIdempotentRetries)) : 1
    let rateLimitRetriesUsed = 0
    let reloginRetried = false
    let networkAttempt = 0

    while (true) {
      if (!bypassRateLimitForUrgentSnipe) {
        await this._acquireBucketSlot(upper, apiPath, minGapMs)
      } else {
        const { bucket, isWrite } = classifyBucket(upper, apiPath)
        const mark = this.nowMsFn()
        this._bucketLastAtMs.set(bucket, mark)
        if (isWrite) this._lastWriteAtMs = mark
      }

      if (upper === 'GET' || upper === 'HEAD') this.stats.getCount++
      else this.stats.postCount++

      networkAttempt++
      const reqStartMs = this.nowMsFn()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const url = new URL(apiPath, this.baseUrl).toString()
      const usedCookie = this.getCookieHeader()

      let res = null
      try {
        const originUrl = new URL(this.baseUrl).origin
        const defaultRefPath = String(apiPath || '').startsWith('/api/huancai') ? '/huancai' : '/pets'
        const headers = {
          accept: 'application/json',
          cookie: usedCookie,
          origin: originUrl,
          referer: `${originUrl}${defaultRefPath}`,
          'sec-fetch-site': 'same-origin',
          'user-agent': this.userAgent,
        }
        let payloadText = undefined
        if (body !== undefined && upper !== 'GET' && upper !== 'HEAD') {
          headers['content-type'] = 'application/json'
          payloadText = JSON.stringify(body)
        }
        res = await this.fetchImpl(url, {
          method: upper,
          headers,
          body: payloadText,
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(timer)
        this.stats.networkErrorCount++
        if (idempotent && networkAttempt < maxNetworkAttempts) {
          this.stats.retryCount++
          await this.sleepMsFn(350 * networkAttempt)
          continue
        }
        return {
          ok: false,
          status: null,
          networkError: true,
          idempotent,
          attempts: networkAttempt,
          error: err?.message || String(err),
          body: null,
        }
      }
      clearTimeout(timer)

      const dateHdr = res.headers?.get?.('date')
      if (dateHdr) {
        const parsedMs = Date.parse(dateHdr)
        if (Number.isFinite(parsedMs)) {
          this.observeServerTimestampSec(Math.floor(parsedMs / 1000), reqStartMs)
        }
      }

      let parsedBody = null
      let rawText = ''
      try {
        rawText = await res.text()
        parsedBody = rawText ? JSON.parse(rawText) : {}
      } catch {
        parsedBody = { rawText: rawText.slice(0, 300) }
      }

      const sampleRttMs = Math.max(1, this.nowMsFn() - reqStartMs)
      this.lastRttMs = (this.stats.getCount + this.stats.postCount) <= 1
        ? sampleRttMs
        : Math.max(1, Math.round(0.7 * this.lastRttMs + 0.3 * sampleRttMs))

      if (Number.isFinite(parsedBody?.now)) {
        this.observeServerTimestampSec(Number(parsedBody.now), reqStartMs)
      } else if (Number.isFinite(parsedBody?.world?.now)) {
        this.observeServerTimestampSec(Number(parsedBody.world.now), reqStartMs)
      }

      // Expired session cookie (401 or explicit login-required 403) -> optional default-OFF password relogin
      if (
        !reloginRetried &&
        !this.dryRun &&
        this._autoRelogin.enabled &&
        !this._reloginCircuitBroken &&
        !String(apiPath || '').startsWith('/api/auth/') &&
        this._isAuthExpired(res.status, parsedBody)
      ) {
        const refreshed = await this._reloginSingleFlight(usedCookie)
        if (refreshed) {
          reloginRetried = true
          networkAttempt = Math.max(0, networkAttempt - 1)
          continue
        }
      }

      // HTTP 429: rate-limited BEFORE handler execution -> safe bounded backoff even for non-idempotent POST
      if (res.status === 429 && rateLimitRetriesUsed < this.maxRateLimitRetries) {
        rateLimitRetriesUsed++
        this.stats.rateLimitCount++
        this.stats.retryCount++
        const retryAfterHdr = Number(res.headers?.get?.('retry-after'))
        const waitMs = Number.isFinite(retryAfterHdr) && retryAfterHdr > 0
          ? Math.min(10000, Math.ceil(retryAfterHdr * 1000))
          : 1500 * rateLimitRetriesUsed
        await this.sleepMsFn(waitMs)
        continue
      }

      // HTTP 502/503/504: retry ONLY if request is strictly idempotent!
      if ((res.status === 502 || res.status === 503 || res.status === 504) && idempotent && networkAttempt < maxNetworkAttempts) {
        this.stats.retryCount++
        await this.sleepMsFn(450 * networkAttempt)
        continue
      }

      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        networkError: false,
        idempotent,
        attempts: networkAttempt,
        body: parsedBody,
      }
    }
  }

  async getJson(apiPath, opts = {}) {
    const r = await this.request(apiPath, { ...opts, method: 'GET' })
    if (!r.ok) {
      const msg = r.body?.error || r.body?.msg || r.error || `HTTP ${r.status}`
      const hint = r.status === 401
        ? ' (请检查 .session.json 中是否填入了登录后的 sid Cookie，且未在浏览器点击退出登录)'
        : ''
      const err = new Error(`GET ${apiPath} failed: ${msg}${hint}`)
      err.status = r.status
      err.response = r
      throw err
    }
    return r.body
  }

  async postJson(apiPath, body = {}, opts = {}) {
    return this.request(apiPath, { ...opts, method: 'POST', body })
  }
}
