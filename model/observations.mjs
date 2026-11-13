import crypto from 'node:crypto'

const ALLOWED_WORLD_TOP_KEYS = new Set([
  'now',
  'clockStart',
  'nextIsleAt',
  'rev',
  'coins',
  'prices',
  'rumors',
  'state',
])

const FORBIDDEN_SECRET_KEY_RE = /cookie|token|secret|authorization|session|password|set-cookie/i

function stripSecretsDeep(val) {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(stripSecretsDeep)
  const out = {}
  for (const [k, v] of Object.entries(val)) {
    if (FORBIDDEN_SECRET_KEY_RE.test(k)) continue
    out[k] = stripSecretsDeep(v)
  }
  return out
}

export function sanitizeWorldSnapshot(rawWorld) {
  if (!rawWorld || typeof rawWorld !== 'object') return null
  const out = {}
  for (const k of ALLOWED_WORLD_TOP_KEYS) {
    if (Object.hasOwn(rawWorld, k) && rawWorld[k] !== undefined) {
      out[k] = stripSecretsDeep(structuredClone(rawWorld[k]))
    }
  }
  return out
}

export function inferSupplyBoundsFromQuote(adapter, itemId, quote, isleDayStr) {
  const { R } = adapter
  const dBase = adapter.deterministicPriceBase(itemId, isleDayStr)
  if (!(dBase > 0) || !(quote > 0)) {
    return {
      deterministicBase: dBase,
      supplyFactorInterval: [0.8, 1.06],
      relativeToZeroVolumeRatio: [0.8 / 1.06, 1.0],
      impliedVolumeInterval: [0, Infinity],
      clampedFloor: true,
      clampedCeil: true,
    }
  }
  const rawLo = quote <= 1 ? 0 : (quote - 0.5) / dBase
  const rawHi = (quote + 0.5) / dBase
  const sMin = Math.max(0.8, Math.min(1.06, rawLo))
  const sMax = Math.max(sMin, Math.min(1.06, rawHi))
  const depth = typeof R.marketDepth === 'function' ? R.marketDepth(itemId) : (R.NORMAL_VOLUME || 400)
  const clampedFloor = rawLo <= 0.8 + 1e-9
  const clampedCeil = rawHi >= 1.06 - 1e-9
  // S = 1.06 - 0.3 * (vol / depth) => vol = ((1.06 - S) / 0.3) * depth
  const volMin = clampedCeil ? 0 : Math.max(0, Math.ceil(((1.06 - sMax) / 0.3) * depth - 1e-9))
  const volMax = clampedFloor ? Infinity : Math.max(volMin, Math.floor(((1.06 - sMin) / 0.3) * depth + 1e-9))
  return {
    deterministicBase: dBase,
    supplyFactorInterval: [sMin, sMax],
    relativeToZeroVolumeRatio: [sMin / 1.06, sMax / 1.06],
    impliedVolumeInterval: [volMin, volMax],
    marketDepth: depth,
    clampedFloor,
    clampedCeil,
  }
}

export const DEFAULT_EXTERNAL_SUPPLY_SCENARIOS = [
  { id: 'tight', weight: 0.25, externalSupplyFactor: 1.03 },
  { id: 'baseline', weight: 0.50, externalSupplyFactor: 0.96 },
  { id: 'glut', weight: 0.25, externalSupplyFactor: 0.84 },
]

export function buildFutureIsleDayTimeline(adapter, startSec, horizonSec) {
  const endSec = startSec + Math.max(0, horizonSec)
  const days = []
  let cursor = startSec
  for (let guard = 0; guard < 128 && cursor <= endSec; guard++) {
    const iDay = adapter.R.isleDay(cursor)
    const nextB = adapter.nextIsleBoundary(cursor)
    days.push({
      index: days.length,
      isleDay: iDay,
      isleIdx: adapter.R.isleIndex(cursor),
      season: adapter.R.seasonOf(iDay),
      weather: adapter.R.weatherOf(iDay),
      startSec: cursor,
      endSec: Math.min(endSec, nextB),
      boundaryAfterSec: nextB,
    })
    if (nextB > endSec || nextB <= cursor) break
    cursor = nextB
  }
  return days
}

export function quoteFutureItemUnderScenario(adapter, {
  itemId,
  isleDayIndex,
  isleDayStr,
  currentPrices,
  externalSupplyFactor = 0.96,
  selfSoldPrevIsleDay = 0,
}) {
  if (isleDayIndex === 0 && currentPrices && Number(currentPrices[itemId]) > 0) {
    return Number(currentPrices[itemId])
  }
  const depth = typeof adapter.R.marketDepth === 'function'
    ? adapter.R.marketDepth(itemId)
    : (adapter.R.NORMAL_VOLUME || 400)
  const selfImpact = -0.3 * (Math.max(0, selfSoldPrevIsleDay) / Math.max(1, depth))
  const effS = Math.max(0.8, Math.min(1.06, externalSupplyFactor + selfImpact))
  return adapter.quoteWithSupplyFactor(itemId, isleDayStr, effS)
}

export function normalizeUserConstraints(raw = {}, account = 'main') {
  const isDomesticSecondary = Boolean(raw.domesticOnly) || account === 'secondary'
  const defaultAllowCapex = isDomesticSecondary
  const defaultMaxSteals = isDomesticSecondary ? 0 : (raw.maxStealsPerIsleDay !== undefined ? raw.maxStealsPerIsleDay : null)
  const defaultMinStealSpots = isDomesticSecondary
    ? 999999
    : (Number.isFinite(raw.minStealSpots) ? Math.max(0, Math.floor(raw.minStealSpots)) : 0)
  const baseCapexTargets = isDomesticSecondary
    ? { plotsMax: 24, barnMax: 8, trapsMax: 4, houseMax: 0, toolsMax: { rod: 4, pick: 4, spr: 3 } }
    : { plotsMax: 0, barnMax: 0, trapsMax: 0, houseMax: 0, toolsMax: { rod: 0, pick: 0, spr: 0 } }
  const mergedCapexTargets = raw.capexTargets
    ? {
        ...baseCapexTargets,
        ...raw.capexTargets,
        toolsMax: {
          ...baseCapexTargets.toolsMax,
          ...(raw.capexTargets.toolsMax || {}),
        },
      }
    : baseCapexTargets
  const out = {
    account,
    allowCapex: raw.allowCapex !== undefined ? !!raw.allowCapex : defaultAllowCapex,
    capexTargets: mergedCapexTargets,
    maxCapexPaybackSec: Number.isFinite(raw.maxCapexPaybackSec) ? raw.maxCapexPaybackSec : 72 * 3600,
    maxStealsPerIsleDay: defaultMaxSteals,
    minStealSpots: defaultMinStealSpots,
    allowThiefBuffPurchase: isDomesticSecondary ? false : (raw.allowThiefBuffPurchase !== false),
    allowGuardBuffPurchase: raw.allowGuardBuffPurchase !== undefined ? !!raw.allowGuardBuffPurchase : false,
    cashReserveFloor: Number.isFinite(raw.cashReserveFloor) ? Math.max(0, Math.floor(raw.cashReserveFloor)) : 0,
    staminaReserveFloor: Number.isFinite(raw.staminaReserveFloor) ? Math.max(0, Math.floor(raw.staminaReserveFloor)) : 0,
    staminaReserveUntilSec: Number.isFinite(raw.staminaReserveUntilSec) ? Math.max(0, Math.floor(raw.staminaReserveUntilSec)) : 0,
  }
  return out
}

export function computeConstraintsHash(constraints) {
  return crypto.createHash('sha256').update(JSON.stringify(constraints), 'utf8').digest('hex')
}

const NON_STATIC_FARM_STATE_KEYS = new Set(['xs', 'npcG', 'log', 'en', 'enT', 'enDay'])
const NON_FARM_CNT_KEYS = new Set(['npc', 'npcWin', 'gomokuPaid'])

function canonicalizeForDigest(val) {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(canonicalizeForDigest)
  const sortedKeys = Object.keys(val).sort()
  const out = {}
  for (const k of sortedKeys) {
    if (val[k] !== undefined) {
      out[k] = canonicalizeForDigest(val[k])
    }
  }
  return out
}

function canonicalizeStateCntForFarmDigest(cntObj) {
  if (!cntObj || typeof cntObj !== 'object' || Array.isArray(cntObj)) {
    return canonicalizeForDigest(cntObj)
  }
  const out = {}
  for (const k of Object.keys(cntObj).sort()) {
    if (!NON_FARM_CNT_KEYS.has(k) && cntObj[k] !== undefined) {
      out[k] = canonicalizeForDigest(cntObj[k])
    }
  }
  return out
}

/**
 * Canonical SHA-256 digest of all farm-domain static state fields on `world`,
 * explicitly isolating out B16 cultivation state (`state.xs`), 52D toy-stall meta (`state.npcG`, `cnt.npc*`),
 * and passive regen clocks (`en`, `enT`, `enDay`), as well as transport-level `world.rev` / `world.now`.
 */
export function computeStaticFarmStateDigest(world) {
  if (!world || typeof world !== 'object') return 'null'
  const rawState = world.state && typeof world.state === 'object' ? world.state : {}
  const farmState = {}
  for (const k of Object.keys(rawState).sort()) {
    if (NON_STATIC_FARM_STATE_KEYS.has(k)) continue
    if (rawState[k] !== undefined) {
      farmState[k] = k === 'cnt'
        ? canonicalizeStateCntForFarmDigest(rawState[k])
        : canonicalizeForDigest(rawState[k])
    }
  }
  const payload = {
    clockStart: Number(world.clockStart || 0),
    coins: Number(world.coins || 0),
    prices: canonicalizeForDigest(world.prices || {}),
    rumors: canonicalizeForDigest(world.rumors || null),
    state: farmState,
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 24)
}

/**
 * Full farm-domain identity digest including refreshed stamina `(en, enT, enDay)` while excluding `state.xs` and `world.rev`.
 */
export function computeFarmDomainDigest(world, adapter = null) {
  if (!world || typeof world !== 'object') return 'null'
  const wRef = (adapter && typeof adapter.advanceTimeOnly === 'function' && Number.isFinite(world.now))
    ? adapter.advanceTimeOnly(world, world.now)
    : world
  const staticDigest = computeStaticFarmStateDigest(wRef)
  const en = Number(wRef.state?.en || 0)
  const enT = Number(wRef.state?.enT || 0)
  const enDay = String(wRef.state?.enDay || '')
  return `${staticDigest}:${en}:${enT}:${enDay}`
}

/**
 * Verifies that `liveWorld` is passively compatible with `baseWorld` on the farm domain
 * (i.e. only time passed and/or isolated `state.xs` changed, with zero unmodeled farm mutations).
 */
export function isFarmDomainPassiveCompatible(adapter, baseWorld, liveWorld, {
  isWaitPlan = false,
  staticDigestBase = null,
} = {}) {
  if (!adapter || !baseWorld || !liveWorld) return false
  const baseNow = Math.floor(Number(baseWorld.now || 0))
  const liveNow = Math.floor(Number(liveWorld.now || 0))
  if (liveNow < baseNow) return false
  if (adapter.R.isleIndex(liveNow) !== adapter.R.isleIndex(baseNow)) return false
  if (adapter.R.worldDay(liveNow) !== adapter.R.worldDay(baseNow)) return false

  if (baseWorld.rev != null && liveWorld.rev != null) {
    const bRev = Number(baseWorld.rev)
    const lRev = Number(liveWorld.rev)
    if (lRev < bRev) return false
    if (lRev > bRev) {
      const baseXs = JSON.stringify(canonicalizeForDigest(baseWorld.state?.xs ?? null))
      const liveXs = JSON.stringify(canonicalizeForDigest(liveWorld.state?.xs ?? null))
      const extractNpcMeta = (w) => ({
        npcG: w?.state?.npcG ?? null,
        npc: Number(w?.state?.cnt?.npc || 0),
        npcWin: Number(w?.state?.cnt?.npcWin || 0),
        gomokuPaid: Number(w?.state?.cnt?.gomokuPaid || 0),
      })
      const baseNpc = JSON.stringify(canonicalizeForDigest(extractNpcMeta(baseWorld)))
      const liveNpc = JSON.stringify(canonicalizeForDigest(extractNpcMeta(liveWorld)))
      if (baseXs === liveXs && baseNpc === liveNpc) return false
    }
  }

  const baseStatic = staticDigestBase || computeStaticFarmStateDigest(baseWorld)
  const liveStatic = computeStaticFarmStateDigest(liveWorld)
  if (baseStatic !== liveStatic) return false

  const baseAtBase = adapter.advanceTimeOnly(baseWorld, baseNow)
  const baseAdvancedToLive = adapter.advanceTimeOnly(baseWorld, liveNow)
  const liveRefreshed = adapter.advanceTimeOnly(liveWorld, liveNow)

  if (Number(baseAdvancedToLive.state?.en || 0) !== Number(liveRefreshed.state?.en || 0)) {
    return false
  }
  if (Number(baseAdvancedToLive.state?.enT || 0) !== Number(liveRefreshed.state?.enT || 0)) {
    return false
  }
  if (isWaitPlan && Number(liveRefreshed.state?.en || 0) > Number(baseAtBase.state?.en || 0)) {
    return false
  }
  return true
}

/**
 * Resolves a neighbor raid belief into its exact discrete physical outcome branches:
 * `{ undetected, guard-win, guard-tie, guard-loss }`.
 *
 * Every branch carries strictly integer `lootBag` and discrete integer `fineCoins`
 * (zero fractional items, zero unsold-item-to-cash conversion).
 */
export function resolveRaidOutcomeDistribution(adapter, raidBelief, visitorWorld = null, nowSec = visitorWorld?.now, {
  mode = 'auto',
} = {}) {
  const vb = (visitorWorld && raidBelief)
    ? recomputeVisitBeliefForVisitor(adapter, raidBelief, visitorWorld, nowSec ?? visitorWorld.now)
    : raidBelief
  if (!vb) {
    return {
      belief: null,
      energyCost: 0,
      outcomes: [],
      expectedLootBag: {},
      guaranteedLootBag: {},
      expectedFineCoins: 0,
      worstCaseFineCoins: 0,
      isStochastic: false,
    }
  }

  const energyCost = Math.max(0, Math.floor(Number(vb.energyCost || 0)))
  const pDet = vb.hasGuard ? Math.max(0, Math.min(1, Number(vb.detectionProb || 0))) : 0
  const pUndet = Math.max(0, 1 - pDet)

  const wLo = Math.max(0, Math.min(1, Number(vb.winInterval?.[0] ?? (vb.hasGuard ? 0.25 : 1))))
  const wHi = Math.max(wLo, Math.min(1, Number(vb.winInterval?.[1] ?? (vb.hasGuard ? 0.85 : 1))))
  const wMid = 0.5 * (wLo + wHi)

  const lLoRaw = Math.max(0, Math.min(1, Number(vb.lossInterval?.[0] ?? (vb.hasGuard ? Math.max(0, 1 - wHi) : 0))))
  const lHiRaw = Math.max(lLoRaw, Math.min(1, Number(vb.lossInterval?.[1] ?? (vb.hasGuard ? Math.max(0, 1 - wLo) : 0))))
  const lLo = Math.min(Math.max(0, 1 - wHi), lLoRaw)
  const lHi = Math.min(Math.max(0, 1 - wLo), lHiRaw)
  const lMid = Math.min(Math.max(0, 1 - wMid), 0.5 * (lLoRaw + lHiRaw))

  const useConservative = mode === 'conservative'
    || (mode === 'auto' && vb.estimationSource === 'unobserved-wide-prior')
  const useOptimistic = mode === 'optimistic'

  const wCond = !vb.hasGuard ? 1 : (useConservative ? wLo : (useOptimistic ? wHi : wMid))
  const lCond = !vb.hasGuard ? 0 : (useConservative ? lHi : (useOptimistic ? lLo : lMid))
  const dCond = !vb.hasGuard ? 0 : Math.max(0, 1 - wCond - lCond)

  const cleanIntBag = (bag) => {
    const out = {}
    for (const [id, rawQty] of Object.entries(bag || {})) {
      const n = Math.max(0, Math.round(Number(rawQty || 0)))
      if (n > 0) out[id] = n
    }
    return out
  }

  const undetBag = cleanIntBag(vb.lootBag)
  const winBag = cleanIntBag(vb.guardWinLootBag || vb.lootBag)
  const estFine = Math.max(0, Math.round(Number(vb.estimatedFineOnLoss || 0)))

  const rawOutcomes = [
    { kind: 'undetected', prob: pUndet, lootBag: undetBag, fineCoins: 0 },
    { kind: 'guard-win', prob: pDet * wCond, lootBag: winBag, fineCoins: 0 },
    { kind: 'guard-tie', prob: pDet * dCond, lootBag: {}, fineCoins: 0 },
    { kind: 'guard-loss', prob: pDet * lCond, lootBag: {}, fineCoins: estFine },
  ].filter((o) => o.prob > 1e-12)

  const pSum = rawOutcomes.reduce((s, o) => s + o.prob, 0) || 1
  const outcomes = rawOutcomes.map((o) => ({ ...o, prob: o.prob / pSum }))

  const allIds = new Set([
    ...Object.keys(undetBag),
    ...Object.keys(winBag),
  ])
  const expectedLootBag = {}
  const guaranteedLootBag = {}
  for (const id of allIds) {
    let expQty = 0
    let minQty = outcomes.length > 0 ? Infinity : 0
    for (const o of outcomes) {
      const q = Number(o.lootBag[id] || 0)
      expQty += o.prob * q
      if (q < minQty) minQty = q
    }
    if (expQty > 1e-12) expectedLootBag[id] = expQty
    if (minQty > 0 && Number.isFinite(minQty)) guaranteedLootBag[id] = minQty
  }

  let expectedFineCoins = 0
  let worstCaseFineCoins = 0
  for (const o of outcomes) {
    expectedFineCoins += o.prob * o.fineCoins
    if (o.fineCoins > worstCaseFineCoins) worstCaseFineCoins = o.fineCoins
  }

  return {
    belief: vb,
    energyCost,
    outcomes,
    expectedLootBag,
    guaranteedLootBag,
    expectedFineCoins,
    worstCaseFineCoins,
    isStochastic: outcomes.length > 1,
  }
}

export function buildVisitTargetBelief(adapter, visitorWorld, targetBundle, nowSec = visitorWorld?.now) {
  const { R, graph } = adapter
  const owner = targetBundle?.owner || {}
  const isle = targetBundle?.isle || {}
  const ownerState = isle?.state || isle || {}
  const visitorState = visitorWorld?.state || {}

  const detProb = typeof R.b12Detection === 'function'
    ? R.b12Detection(ownerState, visitorState, nowSec)
    : 0.55
  const ownerAlert = typeof R.b12Effect === 'function'
    ? R.b12Effect(ownerState, 'alert', nowSec)
    : null

  const hasCarry = typeof R.b12Effect === 'function'
    ? !!R.b12Effect(visitorState, 'carry', nowSec)
    : false
  const unitsPerSpot = hasCarry ? 2 : 1
  const guardWinUnitsPerSpot = unitsPerSpot + 1

  const spotCounts = {}
  const lootBag = {}
  const guardWinLootBag = {}
  let totalSpots = 0
  let marketValueAtBase = 0
  for (const p of isle?.barn || []) {
    if (!p || !p.steal) continue
    const def = graph.animalsById.get(p.k)
    if (!def || def.cap < 2) continue
    totalSpots++
    spotCounts[def.product] = (spotCounts[def.product] || 0) + 1
    lootBag[def.product] = (lootBag[def.product] || 0) + unitsPerSpot
    guardWinLootBag[def.product] = (guardWinLootBag[def.product] || 0) + guardWinUnitsPerSpot
    marketValueAtBase += (R.BASE_PRICE?.[def.product] || 0) * unitsPerSpot
  }
  for (const p of isle?.plots || []) {
    if (!p || !p.steal || !p.c) continue
    totalSpots++
    spotCounts[p.c] = (spotCounts[p.c] || 0) + 1
    lootBag[p.c] = (lootBag[p.c] || 0) + unitsPerSpot
    guardWinLootBag[p.c] = (guardWinLootBag[p.c] || 0) + guardWinUnitsPerSpot
    marketValueAtBase += (R.BASE_PRICE?.[p.c] || 0) * unitsPerSpot
  }

  const energyCost = totalSpots > 0
    ? (typeof R.b12StealCost === 'function'
        ? R.b12StealCost(visitorState, nowSec, totalSpots, 5, 1, 15)
        : Math.min(15, 5 + Math.max(0, totalSpots - 1)))
    : 0

  const hasGuard = !!(owner?.guard || isle?.guard)
  const post = targetBundle?.posterior || null
  // Honest uncertainty interval: if no battle posterior provided, keep wide [winLo, winHi] instead of faking precision
  const winInterval = !hasGuard
    ? [1, 1]
    : (Array.isArray(post?.winInterval) && post.winInterval.length === 2
        ? [Math.max(0, post.winInterval[0]), Math.min(1, post.winInterval[1])]
        : [0.25, 0.85])
  const lossInterval = !hasGuard
    ? [0, 0]
    : (Array.isArray(post?.lossInterval) && post.lossInterval.length === 2
        ? [Math.max(0, post.lossInterval[0]), Math.min(1, post.lossInterval[1])]
        : [Math.max(0, 1 - winInterval[1]), Math.min(1, 1 - winInterval[0])])

  // Fine upper/mid estimate from UI documented rule: min(5000, round(1.2 * marketValue)), kept explicitly tagged as estimate
  const estFine = Math.min(5000, Math.round(marketValueAtBase * 1.2))
  const hasCalibratedMatchup = Boolean(post?.simulated || post?.sampleCount > 0)

  return {
    targetId: targetBundle?.id ?? owner?.id ?? null,
    targetName: owner?.name || String(targetBundle?.id || ''),
    totalSpots,
    spotCounts,
    lootBag,
    guardWinLootBag: hasGuard ? guardWinLootBag : lootBag,
    unitsPerSpot,
    guardWinUnitsPerSpot: hasGuard ? guardWinUnitsPerSpot : unitsPerSpot,
    energyCost,
    detectionProb: hasGuard ? detProb : 0,
    ownerAlertId: ownerAlert?.id || null,
    hasGuard,
    winInterval,
    lossInterval,
    sampleCount: Number(post?.sampleCount || 0),
    tacticalDecision: post?.decision || null,
    optimalLoadout: post?.optimalLoadout || null,
    numGearChanges: Number(post?.numGearChanges || 0),
    estimatedFineOnLoss: estFine,
    estimationSource: !hasGuard
      ? 'no-guard-deterministic'
      : (hasCalibratedMatchup ? 'empirical-posterior-interval' : 'unobserved-wide-prior'),
  }
}

export function recomputeVisitBeliefForVisitor(adapter, baseBelief, visitorWorld, nowSec = visitorWorld?.now) {
  if (!baseBelief) return null
  const { R } = adapter
  const visitorState = visitorWorld?.state || {}
  const ownerMock = baseBelief.ownerAlertId
    ? { b12: { effects: { alert: { id: baseBelief.ownerAlertId, until: Number(nowSec || 0) + 86400 } } } }
    : {}
  const detProb = typeof R.b12Detection === 'function'
    ? R.b12Detection(ownerMock, visitorState, nowSec)
    : baseBelief.detectionProb
  const hasCarry = typeof R.b12Effect === 'function'
    ? !!R.b12Effect(visitorState, 'carry', nowSec)
    : false
  const unitsPerSpot = hasCarry ? 2 : 1
  const guardWinUnitsPerSpot = unitsPerSpot + 1

  const lootBag = {}
  const guardWinLootBag = {}
  let marketValueAtBase = 0
  if (baseBelief.spotCounts && Object.keys(baseBelief.spotCounts).length > 0) {
    for (const [id, spots] of Object.entries(baseBelief.spotCounts)) {
      const nSpots = Number(spots || 0)
      const qty = nSpots * unitsPerSpot
      if (qty > 0) {
        lootBag[id] = qty
        guardWinLootBag[id] = nSpots * guardWinUnitsPerSpot
        marketValueAtBase += (R.BASE_PRICE?.[id] || 0) * qty
      }
    }
  } else {
    const prevUps = Math.max(1, Number(baseBelief.unitsPerSpot || 1))
    for (const [id, prevQty] of Object.entries(baseBelief.lootBag || {})) {
      const spots = Math.round(Number(prevQty || 0) / prevUps)
      const qty = spots * unitsPerSpot
      if (qty > 0) {
        lootBag[id] = qty
        guardWinLootBag[id] = spots * guardWinUnitsPerSpot
        marketValueAtBase += (R.BASE_PRICE?.[id] || 0) * qty
      }
    }
  }

  const energyCost = baseBelief.totalSpots > 0
    ? (typeof R.b12StealCost === 'function'
        ? R.b12StealCost(visitorState, nowSec, baseBelief.totalSpots, 5, 1, 15)
        : Math.min(15, 5 + Math.max(0, baseBelief.totalSpots - 1)))
    : 0
  const estFine = Math.min(5000, Math.round(marketValueAtBase * 1.2))

  return {
    ...baseBelief,
    lootBag,
    guardWinLootBag: baseBelief.hasGuard ? guardWinLootBag : lootBag,
    unitsPerSpot,
    guardWinUnitsPerSpot: baseBelief.hasGuard ? guardWinUnitsPerSpot : unitsPerSpot,
    energyCost,
    detectionProb: baseBelief.hasGuard ? detProb : 0,
    estimatedFineOnLoss: estFine,
  }
}

export function buildUpcomingVisitBelief(adapter, visitorWorld, upcomingTarget) {
  if (!upcomingTarget || !visitorWorld) return null
  const unlockAtSec = Math.floor(Number(
    upcomingTarget.unlockAtSec ?? upcomingTarget.expectedUnlockAt ?? visitorWorld.now ?? 0
  ))
  if (!Number.isFinite(unlockAtSec) || unlockAtSec <= 0) return null
  const exactUnlockKnown = Boolean(upcomingTarget.exactUnlockKnown ?? false)
  const futureVisitor = unlockAtSec > Number(visitorWorld.now || 0)
    ? adapter.advanceTimeOnly(visitorWorld, unlockAtSec)
    : visitorWorld

  let base = null
  if (upcomingTarget.waveBundle?.isle) {
    base = buildVisitTargetBelief(adapter, futureVisitor, upcomingTarget.waveBundle, unlockAtSec)
  } else if (upcomingTarget.isle) {
    const rawPlots = upcomingTarget.isle.plots || []
    const rawBarn = upcomingTarget.isle.barn || []
    const statePlots = upcomingTarget.state?.plots || rawPlots
    const stateBarn = upcomingTarget.state?.barn || rawBarn
    const protectSec = Number(adapter.R?.WORLD?.steal?.delay ?? 1800)
    const nowRef = Math.floor(Number(visitorWorld.now || 0))
    const sprLvl = Number(upcomingTarget.state?.tools?.spr ?? upcomingTarget.isle?.spr ?? 0)
    const sprCover = sprLvl > 0 ? Number(adapter.R?.SPRINKLER?.[sprLvl]?.cover ?? 999) : 0

    const projectedPlots = rawPlots.map((p, idx) => {
      if (!p || !p.c) return p
      if (p.steal) return p
      if (Number(p.stolen || 0) >= Number(adapter.R?.WORLD?.steal?.perPlotCap ?? 2)) return p
      const rp = statePlots[idx] || p
      if (rp?.t != null && typeof adapter.exactPlotTimings === 'function') {
        const pt = adapter.exactPlotTimings(rp, Boolean(p.auto) || idx < sprCover, nowRef, visitorWorld.clockStart, {
          protectSec,
          isAlreadyRipe: p.stage === 3,
        })
        if (pt && pt.unlockAt <= unlockAtSec) {
          return { ...p, stage: 3, steal: true, stolen: Number(p.stolen || 0) }
        }
        return p
      }
      if (p.stage === 3 && upcomingTarget.unlockAtSec != null) {
        return { ...p, stage: 3, steal: true, stolen: Number(p.stolen || 0) }
      }
      return p
    })

    const projectedBarn = rawBarn.map((pen, idx) => {
      if (!pen || !pen.k) return pen
      if (pen.steal) return pen
      const rPen = stateBarn[idx] || pen
      if (rPen?.t != null && typeof adapter.exactBarnTimings === 'function') {
        const bt = adapter.exactBarnTimings(rPen, nowRef, visitorWorld.clockStart, { protectSec })
        if (bt?.stealUnlockAt != null && bt.stealUnlockAt <= unlockAtSec) {
          return { ...pen, steal: true, stolen: Number(pen.stolen || 0) }
        }
      }
      return pen
    })

    const projectedBundle = {
      ...upcomingTarget,
      isle: { ...upcomingTarget.isle, plots: projectedPlots, barn: projectedBarn },
    }
    base = buildVisitTargetBelief(adapter, futureVisitor, projectedBundle, unlockAtSec)
  } else {
    const summary = upcomingTarget.upcomingBeliefSummary || upcomingTarget.beliefSummary || upcomingTarget
    if (
      summary &&
      (Number(summary.totalSpots || 0) > 0 ||
        (summary.spotCounts && Object.keys(summary.spotCounts).length > 0) ||
        (summary.lootBag && Object.keys(summary.lootBag).length > 0))
    ) {
      base = recomputeVisitBeliefForVisitor(adapter, {
        targetId: summary.targetId ?? upcomingTarget.targetId ?? upcomingTarget.id ?? null,
        targetName: summary.targetName || upcomingTarget.targetName || upcomingTarget.name || String(upcomingTarget.id || ''),
        totalSpots: Number(summary.totalSpots || upcomingTarget.upcomingSpots || 0),
        spotCounts: summary.spotCounts || null,
        lootBag: summary.lootBag || null,
        unitsPerSpot: Number(summary.unitsPerSpot || 1),
        hasGuard: Boolean(summary.hasGuard ?? upcomingTarget.guard),
        ownerAlertId: summary.ownerAlertId || null,
        winInterval: Array.isArray(summary.winInterval)
          ? [...summary.winInterval]
          : (Boolean(summary.hasGuard ?? upcomingTarget.guard) ? [0.25, 0.85] : [1, 1]),
        lossInterval: Array.isArray(summary.lossInterval)
          ? [...summary.lossInterval]
          : (Boolean(summary.hasGuard ?? upcomingTarget.guard) ? [0.15, 0.75] : [0, 0]),
        sampleCount: Number(summary.sampleCount || 0),
        estimationSource: summary.estimationSource || (Boolean(summary.hasGuard ?? upcomingTarget.guard) ? 'unobserved-wide-prior' : 'no-guard-deterministic'),
        tacticalDecision: summary.tacticalDecision || null,
        optimalLoadout: summary.optimalLoadout || upcomingTarget.optimalLoadout || null,
        numGearChanges: Number(summary.numGearChanges ?? upcomingTarget.numGearChanges ?? 0),
      }, futureVisitor, unlockAtSec)
    }
  }
  if (!base || !(Number(base.totalSpots || 0) > 0)) return null
  const resolvedId = base.targetId ?? upcomingTarget.targetId ?? upcomingTarget.id ?? null
  return {
    ...base,
    targetId: resolvedId,
    targetName: base.targetName || upcomingTarget.targetName || upcomingTarget.name || String(resolvedId ?? ''),
    unlockAtSec,
    exactUnlockKnown,
    ...(upcomingTarget.ownerLeft != null ? { ownerLeft: Number(upcomingTarget.ownerLeft) } : {}),
  }
}

export function buildObservationEnvelope(adapter, {
  account = 'main',
  world,
  observedAtMs = Date.now(),
  neighborTargets = [],
  upcomingNeighborTargets = [],
  partnerWorld = null,
  knownSoldByIsleIndex = null,
  scenarios = DEFAULT_EXTERNAL_SUPPLY_SCENARIOS,
  userConstraints = {},
  reservedBudgets = { stealUsedOrReservedThisIsleDay: 0 },
} = {}) {
  const cleanWorld = sanitizeWorldSnapshot(world)
  if (!cleanWorld) throw new Error('world snapshot is required')
  adapter.syncClock(cleanWorld.clockStart)

  const curIsleDay = adapter.R.isleDay(cleanWorld.now)
  const supplyInferences = {}
  for (const id of adapter.graph.sellableIds) {
    const q = Number(cleanWorld.prices?.[id] || 0)
    if (q > 0) {
      supplyInferences[id] = inferSupplyBoundsFromQuote(adapter, id, q, curIsleDay)
    }
  }

  const constraints = normalizeUserConstraints(userConstraints, account)
  const visitBeliefs = (neighborTargets || []).map((t) => buildVisitTargetBelief(adapter, cleanWorld, t, cleanWorld.now))
  const upcomingVisitBeliefs = (upcomingNeighborTargets || [])
    .map((t) => buildUpcomingVisitBelief(adapter, cleanWorld, t))
    .filter((b) => b && Number(b.unlockAtSec || 0) > cleanWorld.now)
    .sort((a, b) => (a.unlockAtSec - b.unlockAtSec) || (Number(a.targetId || 0) - Number(b.targetId || 0)))

  const cleanSoldByIsle = {}
  if (knownSoldByIsleIndex && typeof knownSoldByIsleIndex === 'object') {
    const entries = knownSoldByIsleIndex instanceof Map
      ? [...knownSoldByIsleIndex.entries()]
      : Object.entries(knownSoldByIsleIndex)
    for (const [k, itemMap] of entries) {
      if (!itemMap || typeof itemMap !== 'object') continue
      cleanSoldByIsle[String(k)] = { ...itemMap }
    }
  }

  return {
    schemaVersion: 1,
    account,
    observedAtMs,
    mechanicalTruth: {
      rulesHash: adapter.rulesHash,
      clockStart: cleanWorld.clockStart || adapter.clockStart || 0,
    },
    observed: {
      serverNow: cleanWorld.now,
      rev: cleanWorld.rev ?? null,
      world: cleanWorld,
      partnerWorld: partnerWorld ? sanitizeWorldSnapshot(partnerWorld) : null,
      knownSoldByIsleIndex: cleanSoldByIsle,
    },
    beliefs: {
      supplyInferences,
      scenarios: scenarios.map((s) => ({ ...s })),
      visitBeliefs,
      upcomingVisitBeliefs,
    },
    constraints,
    constraintsHash: computeConstraintsHash(constraints),
    reservedBudgets: {
      stealUsedOrReservedThisIsleDay: Number(reservedBudgets?.stealUsedOrReservedThisIsleDay || 0),
    },
  }
}
