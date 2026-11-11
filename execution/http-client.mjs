import fs from 'node:fs'

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

export function parseSessionCookieHeader(sessionFilePath) {
  const raw = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8').replace(/^\uFEFF/, ''))
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw?.cookie === 'string' && raw.cookie.trim()) return raw.cookie.trim()
  if (typeof raw?.cookieHeader === 'string' && raw.cookieHeader.trim()) return raw.cookieHeader.trim()
  if (raw?.cookies && typeof raw.cookies === 'object' && !Array.isArray(raw.cookies)) {
    return Object.entries(raw.cookies)
      .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? (v.value ?? '') : v}`)
      .join('; ')
  }
  if (Array.isArray(raw?.cookies)) {
    return raw.cookies
      .map((c) => (typeof c === 'string' ? c.split(';')[0] : `${c.name}=${c.value}`))
      .join('; ')
  }
  throw new Error(`Unrecognized session format in ${sessionFilePath}`)
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
    }
  }

  getCookieHeader() {
    if (this._staticCookieHeader) return this._staticCookieHeader
    if (this.sessionFilePath) return parseSessionCookieHeader(this.sessionFilePath)
    throw new Error('KernelHttpClient requires cookieHeader or sessionFilePath')
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
    // Never artificially bias above `0` when NTP-aligned (`0 in [offsetLoMs, offsetHiMs]`), and when skewed,
    // use conservative lower bound `offsetLoMs` so `sleepUntilServerSec(unlockAt, +35ms)` NEVER fires early!
    this.serverClockOffsetMs = (this._offsetLoMs <= 0 && 0 <= this._offsetHiMs)
      ? 0
      : this._offsetLoMs
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

      let res = null
      try {
        const originUrl = new URL(this.baseUrl).origin
        const defaultRefPath = String(apiPath || '').startsWith('/api/huancai') ? '/huancai' : '/pets'
        const headers = {
          accept: 'application/json',
          cookie: this.getCookieHeader(),
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
      const err = new Error(`GET ${apiPath} failed: ${msg}`)
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
