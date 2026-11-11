import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObjectiveConfig, evaluateTerminalLiquidationTail } from '../model/objective.mjs'
import { runControllerStep } from './controller.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { computeGuardPosteriorForTarget } from '../execution/combat-engine.mjs'
import { parseSessionCookieHeader } from '../execution/http-client.mjs'

/**
 * Strictly Read-Only Shadow Parallel Observer (`cli/shadow-daemon.mjs`)
 *
 * Guarantees:
 * 1. HTTP Firewall: ONLY `GET` requests are permitted; any non-GET attempt throws immediately.
 * 2. Session Isolation: Session file (`.session.json`) and optional
 *    opponent profiles are read via `fs.readFileSync` ONLY; zero writes outside `logs/shadow/`.
 * 3. Mode Boundary: Domestic-only mode never probes neighbor lists or islands (`0` steal probes).
 * 4. Independent Layer-3 Self-Audit: Every shadow tick records both `controller.mjs` (`dryRun: true`)
 *    output and `audit/report.mjs` independent reference check + live `rev` transition tracking.
 */

async function readOnlyGetJson(baseUrl, apiPath, cookieHeader, stats) {
  if (!apiPath.startsWith('/api/')) {
    throw new Error(`SHADOW_READ_ONLY_FIREWALL: disallowed path ${apiPath}`)
  }
  const url = new URL(apiPath, baseUrl).toString()
  stats.getCount = (stats.getCount || 0) + 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie: cookieHeader,
        'user-agent': '52dmeme-unified-kernel-shadow/1.0 (read-only)',
      },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`GET ${apiPath} HTTP ${res.status}: ${txt.slice(0, 160)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function wilsonInterval(wins, total, z = 1.28) {
  if (!(total > 0)) return null
  const phat = wins / total
  const denom = 1 + (z * z) / total
  const center = (phat + (z * z) / (2 * total)) / denom
  const half = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total)) / denom
  return [Math.max(0, Number((center - half).toFixed(4))), Math.min(1, Number((center + half).toFixed(4)))]
}

function readOptionalJsonReadOnly(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

function loadOptionalOpponentPosteriorResolver(profilesPath, gearStatePath) {
  if (!profilesPath || !fs.existsSync(profilesPath)) {
    return () => null
  }
  const raw = readOptionalJsonReadOnly(profilesPath)
  const gearSt = readOptionalJsonReadOnly(gearStatePath)
  const gearData = gearSt?.gearSnap || null
  const observedPanels = gearSt?.observedPanels || null
  const entries = raw?.profiles || raw?.opponents || raw || {}

  return (targetId, ownerLevel = null) => {
    const id = Number(targetId)
    if (!Number.isFinite(id)) return null
    if (gearData) {
      const crnPost = computeGuardPosteriorForTarget(gearData, id, {
        knownOpponentLevel: ownerLevel,
        observedPanels,
        storePath: profilesPath,
        trials: 500,
      })
      if (crnPost) return crnPost
    }
    const v = entries[String(id)]
    if (!v) return null
    const wins = Number(v?.wins ?? v?.battleWins ?? 0)
    const losses = Number(v?.losses ?? v?.battleLosses ?? 0)
    const draws = Number(v?.draws ?? 0)
    const total = wins + losses + draws
    if (total > 0) {
      return {
        sampleCount: total,
        winInterval: wilsonInterval(wins, total),
        lossInterval: wilsonInterval(losses, total),
      }
    }
    return null
  }
}

function summarizeBatch(batch = []) {
  const counts = {}
  for (const a of batch) {
    const key = a.id
      ? `${a.a}:${a.id}${a.q != null ? `@q${a.q}` : ''}`
      : (a.k != null ? `${a.a}:${a.k}` : a.a)
    counts[key] = (counts[key] || 0) + Number(a.n || 1)
  }
  return counts
}

export async function runShadowTickForAccount({
  account,
  baseUrl,
  cookieHeader,
  partnerCookieHeader = null,
  rulesPath,
  logRootDir,
  maxNeighborProbes = 6,
  opponentProfilesPath = null,
  gearStatePath = null,
  snipeSchedulePath = null,
  selfIds = [],
  prevTracker,
}) {
  const httpStats = { getCount: 0, postCount: 0 }
  const startedAtMs = Date.now()

  const rawWorld = await readOnlyGetJson(baseUrl, '/api/pet/world', cookieHeader, httpStats)
  const adapter = await loadRulesAdapterFromFile(rulesPath, { clockStart: rawWorld.clockStart })

  let partnerWorld = null
  if (partnerCookieHeader) {
    try {
      partnerWorld = await readOnlyGetJson(baseUrl, '/api/pet/world', partnerCookieHeader, httpStats)
    } catch {
      partnerWorld = null
    }
  }

  const resolvePosterior = account === 'main'
    ? loadOptionalOpponentPosteriorResolver(opponentProfilesPath, gearStatePath)
    : () => null

  const schedJson = account === 'main' ? readOptionalJsonReadOnly(snipeSchedulePath) : null
  const schedEntries = schedJson?.targets || schedJson?.entries || {}

  const fetchNeighborsFn = account === 'main'
    ? async () => {
        const [dirAll, dirMarked] = await Promise.all([
          readOnlyGetJson(baseUrl, '/api/pet/world/neighbors?limit=20&q=', cookieHeader, httpStats).catch(() => ({ neighbors: [] })),
          readOnlyGetJson(baseUrl, '/api/pet/world/neighbors/marked?limit=20&q=', cookieHeader, httpStats).catch(() => ({ neighbors: [] })),
        ])
        const seen = new Set((selfIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))
        const cands = []
        // Prioritize ready/imminent targets from `snipe-schedule.json` if present
        for (const [k, se] of Object.entries(schedEntries)) {
          const sid = Number(se?.id ?? k)
          if (!Number.isFinite(sid) || seen.has(sid)) continue
          if (se?.readyEligible || (se?.expectedUnlockAt && Math.abs(se.expectedUnlockAt - rawWorld.now) <= 120)) {
            seen.add(sid)
            cands.push({
              id: sid,
              name: se.name,
              level: se.level || 1,
              plots: Math.max(1, Number(se.stealableCount || 0) + Number(se.protectedRipeCount || se.upcomingSpots || 0)),
              pens: 0,
              schedPriority: 1,
            })
          }
        }
        for (const item of [...(dirMarked.neighbors || []), ...(dirAll.neighbors || [])]) {
          if (!item || seen.has(item.id)) continue
          seen.add(item.id)
          if (item.newbie) continue
          const estSpots = Number(item.plots || 0) + Number(item.pens || 0)
          if (estSpots < 1) continue
          cands.push({ ...item, schedPriority: 0 })
        }
        cands.sort((a, b) =>
          ((b.schedPriority || 0) - (a.schedPriority || 0)) ||
          ((Number(b.plots || 0) + Number(b.pens || 0)) - (Number(a.plots || 0) + Number(a.pens || 0))) ||
          (Number(a.level || 0) - Number(b.level || 0))
        )
        const picked = cands.slice(0, maxNeighborProbes)
        const targets = []
        for (const c of picked) {
          try {
            const v = await readOnlyGetJson(baseUrl, `/api/pet/world/visit/${c.id}`, cookieHeader, httpStats)
            if (v && v.isle) {
              const ownerObj = { ...(v.owner || c), ...(v.state?.b12 ? { b12: v.state.b12 } : {}) }
              targets.push({
                id: c.id,
                owner: ownerObj,
                isle: v.isle,
                posterior: resolvePosterior(c.id, ownerObj.level || null),
              })
            }
          } catch {
            // Skip unreachable neighbor island cleanly
          }
        }
        return targets
      }
    : null

  const userConstraints = account === 'main'
    ? {
        allowCapex: false,
        minStealSpots: 0,
        allowThiefBuffPurchase: true,
        allowGuardBuffPurchase: false,
        cashReserveFloor: 10,
      }
    : {
        allowCapex: true,
        maxStealsPerIsleDay: 0,
        allowThiefBuffPurchase: false,
        allowGuardBuffPurchase: false,
        cashReserveFloor: 0,
      }

  const stepOut = await runControllerStep({
    adapter,
    journal: null,
    partnerJournal: null,
    lockRootDir: null,
    account,
    fetchWorldFn: async () => rawWorld,
    fetchNeighborsFn,
    fetchPartnerWorldFn: partnerWorld ? async () => partnerWorld : null,
    sendActFn: async () => {
      throw new Error('SHADOW_READ_ONLY_FIREWALL: sendActFn is forbidden')
    },
    sendVisitFn: async () => {
      throw new Error('SHADOW_READ_ONLY_FIREWALL: sendVisitFn is forbidden')
    },
    userConstraints,
    solverOptions: {},
    dryRun: true,
  })

  // Run Layer-3 independent reference solver audit on deterministic prefix actions
  const refAllowedSet = new Set(['sell', 'craft', 'wait', 'stockBuy', 'eat', 'coffee'])
  const prefixForRefAudit = (stepOut.compiled.domesticBatch || []).filter((a) => refAllowedSet.has(a.a))
  let independentAudit = null
  try {
    const auditRep = await buildAuditDecisionReport({
      adapter,
      worldBefore: stepOut.envelope.observed.world,
      actualFirstActions: prefixForRefAudit,
      actualFullPolicyObjectiveValue: stepOut.plan?.quality?.feasibleIncumbentValue ?? null,
      scenarios: stepOut.envelope.beliefs.scenarios,
      objectiveCfg: stepOut.objectiveCfg || buildObjectiveConfig({}),
      constraints: stepOut.envelope.constraints,
      maxSteps: 1,
      maxSearchNodes: 80,
    })
    independentAudit = {
      verdict: auditRep.verdict,
      identifiable: auditRep.identifiable,
      identifiableDecisionRegretLowerBound: auditRep.identifiableDecisionRegretLowerBound,
      estimatedReferenceDelta: auditRep.estimatedReferenceDelta,
    }
  } catch (err) {
    independentAudit = { verdict: 'audit-error', error: String(err?.message || err) }
  }

  const liqNow = evaluateTerminalLiquidationTail(adapter, stepOut.envelope.observed.world, {
    explicitTerminalPrices: rawWorld.prices,
  })
  const curNetWorth = Number(rawWorld.coins || 0) + Number(liqNow.netLiquidationCash || 0)

  const prev = prevTracker.get(account) || null
  let liveTransitionSincePrevTick = null
  if (prev && prev.rev !== rawWorld.rev) {
    liveTransitionSincePrevTick = {
      prevTickAtIso: prev.atIso,
      prevRev: prev.rev,
      curRev: rawWorld.rev,
      revDelta: rawWorld.rev - prev.rev,
      coinsDelta: rawWorld.coins - prev.coins,
      samePriceNetWorthDelta: Math.round(curNetWorth - prev.netWorth),
      prevShadowNextKind: prev.nextTransactionKind,
      prevShadowBatchSummary: prev.batchSummary,
    }
  }

  const batchSummary = summarizeBatch(stepOut.compiled.domesticBatch)
  const record = {
    atIso: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    mode: 'shadow-dry-run',
    writeRequestsSent: 0,
    readOnlyGetRequests: httpStats.getCount,
    account,
    serverNow: rawWorld.now,
    isleDay: adapter.R.isleDay(rawWorld.now),
    isleHour: adapter.R.isleHour(rawWorld.now),
    rev: rawWorld.rev,
    coins: rawWorld.coins,
    energy: rawWorld.state?.en ?? rawWorld.state?.energy ?? 0,
    iq: rawWorld.state?.iq || {},
    realizableInventoryNetNow: Math.round(liqNow.netLiquidationCash),
    totalRealizableNetWorthNow: Math.round(curNetWorth),
    neighborCandidatesProbed: stepOut.envelope.beliefs.visitBeliefs?.length || 0,
    shadowStatus: stepOut.status,
    nextTransactionKind: stepOut.compiled.nextTransactionKind,
    waitReason: stepOut.plan.waitReason || null,
    nextWakeSec: stepOut.nextWakeSec,
    wakeInSec: Math.max(0, Number(stepOut.nextWakeSec || rawWorld.now) - Number(rawWorld.now || 0)),
    horizonStability: stepOut.horizonStability,
    quality: stepOut.plan.quality,
    domesticBatchLength: stepOut.compiled.domesticBatch.length,
    domesticBatchSummary: batchSummary,
    domesticBatchSample: stepOut.compiled.domesticBatch.slice(0, 12),
    visitOperations: stepOut.compiled.visitOperations,
    truncatedAfterStochastic: stepOut.compiled.truncatedAfterStochastic,
    independentLayer3Audit: independentAudit,
    liveTransitionSincePrevTick,
  }

  prevTracker.set(account, {
    atIso: record.atIso,
    rev: rawWorld.rev,
    coins: rawWorld.coins,
    netWorth: curNetWorth,
    nextTransactionKind: stepOut.compiled.nextTransactionKind,
    batchSummary,
  })

  const acctDir = path.join(logRootDir, account)
  fs.mkdirSync(acctDir, { recursive: true })
  fs.appendFileSync(path.join(acctDir, 'shadow-decisions.jsonl'), JSON.stringify(record) + '\n', 'utf8')
  fs.writeFileSync(path.join(acctDir, 'latest-status.json'), JSON.stringify(record, null, 2), 'utf8')

  return record
}

const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectMain) {
  const args = process.argv.slice(2)
  const hasFlag = (f) => args.includes(f)
  const getArg = (flag, defVal) => {
    const idx = args.indexOf(flag)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defVal
  }

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const baseUrl = getArg('--base-url', process.env.MEME_BASE_URL || 'https://52dmeme.com')
  const sessionDir = getArg('--session-dir', rootDir)
  const dataDir = getArg('--data-dir', path.join(rootDir, 'logs/live'))
  const mainSessionPath = getArg('--main-session', path.join(sessionDir, '.session.json'))
  const secondarySessionPath = getArg('--secondary-session', path.join(sessionDir, '.session.secondary.json'))
  const opponentProfilesPath = getArg('--opponent-profiles', path.join(dataDir, 'opponent-profiles.json'))
  const gearStatePath = getArg('--gear-state', path.join(dataDir, 'locks/.battle-gear-state.main.json'))
  const snipeSchedulePath = getArg('--snipe-schedule', path.join(dataDir, 'snipe-schedule.main.json'))
  const rulesPath = getArg('--rules', path.join(rootDir, 'rules/pet-world-rules.js'))
  const logRootDir = getArg('--log-dir', path.join(rootDir, 'logs/shadow'))
  const selfIdsRaw = getArg('--self-ids', process.env.MEME_SELF_IDS || '')
  const selfIds = selfIdsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  const accountsArg = getArg('--accounts', fs.existsSync(secondarySessionPath) ? 'main,secondary' : 'main')
  const accounts = accountsArg.split(',').map((s) => s.trim()).filter(Boolean)
  const intervalSec = Math.max(30, Number(getArg('--interval-sec', '180')) || 180)
  const once = hasFlag('--once')

  fs.mkdirSync(logRootDir, { recursive: true })
  const pidFile = path.join(logRootDir, 'shadow-daemon.pid')
  if (!once) {
    fs.writeFileSync(pidFile, String(process.pid), 'utf8')
    const cleanup = () => {
      try {
        if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
          fs.unlinkSync(pidFile)
        }
      } catch {}
      process.exit(0)
    }
    process.on('SIGTERM', cleanup)
    process.on('SIGINT', cleanup)
  }

  const prevTracker = new Map()

  const runPass = async () => {
    const mainCookie = fs.existsSync(mainSessionPath) ? parseSessionCookieHeader(mainSessionPath) : null
    const secondaryCookie = fs.existsSync(secondarySessionPath) ? parseSessionCookieHeader(secondarySessionPath) : null

    const results = []
    for (const acct of accounts) {
      const customAcctSession = path.join(sessionDir, acct === 'main' ? '.session.json' : `.session.${acct}.json`)
      const cookie = acct === 'main'
        ? mainCookie
        : (acct === 'secondary' ? secondaryCookie : (fs.existsSync(customAcctSession) ? parseSessionCookieHeader(customAcctSession) : null))
      const partnerCookie = acct === 'main' ? secondaryCookie : mainCookie
      if (!cookie) throw new Error(`Missing session cookie for account=${acct}`)
      const rec = await runShadowTickForAccount({
        account: acct,
        baseUrl,
        cookieHeader: cookie,
        partnerCookieHeader: partnerCookie,
        rulesPath,
        logRootDir,
        opponentProfilesPath,
        gearStatePath,
        snipeSchedulePath,
        selfIds,
        prevTracker,
      })
      results.push(rec)
      console.log(
        `[${rec.atIso}] [SHADOW:${acct}] rev=${rec.rev} coins=${rec.coins} en=${rec.energy} status=${rec.shadowStatus} next=${rec.nextTransactionKind} batch=${JSON.stringify(rec.domesticBatchSummary)} visits=${rec.visitOperations.length} regretLB=${rec.independentLayer3Audit?.identifiableDecisionRegretLowerBound} GETs=${rec.readOnlyGetRequests} POSTs=0 (${rec.elapsedMs}ms)`
      )
    }
    return results
  }

  if (once) {
    const out = await runPass()
    if (hasFlag('--json')) {
      console.log(JSON.stringify(out, null, 2))
    }
    process.exit(0)
  }

  while (true) {
    let sleepSec = intervalSec
    try {
      const recs = await runPass()
      const minWake = Math.min(...recs.map((r) => (r.wakeInSec > 0 ? r.wakeInSec : intervalSec)))
      sleepSec = Math.max(60, Math.min(intervalSec, minWake))
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [SHADOW:ERROR] ${err?.stack || err}`)
      sleepSec = Math.min(120, intervalSec)
    }
    await new Promise((r) => setTimeout(r, sleepSec * 1000))
  }
}
