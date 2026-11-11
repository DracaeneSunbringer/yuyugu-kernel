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

export function buildObservationEnvelope(adapter, {
  account = 'main',
  world,
  observedAtMs = Date.now(),
  neighborTargets = [],
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
    },
    constraints,
    constraintsHash: computeConstraintsHash(constraints),
    reservedBudgets: {
      stealUsedOrReservedThisIsleDay: Number(reservedBudgets?.stealUsedOrReservedThisIsleDay || 0),
    },
  }
}
