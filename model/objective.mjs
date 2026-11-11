import crypto from 'node:crypto'

export function buildObjectiveConfig(raw = {}) {
  const cfg = {
    horizonSec: Number.isFinite(raw.horizonSec) ? Math.max(0, Math.floor(raw.horizonSec)) : 6 * 14400,
    extendedHorizonDeltaSec: Number.isFinite(raw.extendedHorizonDeltaSec)
      ? Math.max(0, Math.floor(raw.extendedHorizonDeltaSec))
      : 2 * 14400,
    discountRatePerHour: Number.isFinite(raw.discountRatePerHour) ? Math.max(0, Number(raw.discountRatePerHour)) : 0,
    terminalSupplyMode: raw.terminalSupplyMode || 'conservative-floor',
    conservativeSupplyFactor: Number.isFinite(raw.conservativeSupplyFactor) ? Number(raw.conservativeSupplyFactor) : 0.8,
    maxLiquidationBatches: Number.isInteger(raw.maxLiquidationBatches) && raw.maxLiquidationBatches > 0 ? raw.maxLiquidationBatches : 8,
    energyTerminalCreditPerPoint: Number.isFinite(raw.energyTerminalCreditPerPoint) ? Number(raw.energyTerminalCreditPerPoint) : 0,
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(cfg), 'utf8').digest('hex')
  return { ...cfg, objectiveHash: hash }
}

export function discountFactor(discountRatePerHour, elapsedSec) {
  if (!(discountRatePerHour > 0) || !(elapsedSec > 0)) return 1
  return Math.pow(1 + discountRatePerHour, -(elapsedSec / 3600))
}

export function buildTerminalPrices(adapter, worldAtHorizon, initialWorld, objectiveCfg, scenarioSupplyFactor = null, prevIsleSoldMap = null) {
  const tH = Number(worldAtHorizon?.now || 0)
  const t0 = Number(initialWorld?.now ?? tH)
  const sameIsleDay = adapter.R.isleIndex(tH) === adapter.R.isleIndex(t0)
  if (sameIsleDay && initialWorld?.prices && Object.keys(initialWorld.prices).length > 0) {
    return { ...initialWorld.prices }
  }
  const iDay = adapter.R.isleDay(tH)
  const sFactor = objectiveCfg.terminalSupplyMode === 'scenario-matched' && Number.isFinite(scenarioSupplyFactor)
    ? scenarioSupplyFactor
    : objectiveCfg.conservativeSupplyFactor
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    const soldPrev = Math.max(0, Number(prevIsleSoldMap?.[id] || 0))
    const depth = typeof adapter.R.marketDepth === 'function'
      ? adapter.R.marketDepth(id)
      : (adapter.R.NORMAL_VOLUME || 400)
    const effS = soldPrev > 0
      ? Math.max(0.8, Math.min(1.06, sFactor - 0.3 * (soldPrev / Math.max(1, depth))))
      : sFactor
    prices[id] = adapter.quoteWithSupplyFactor(id, iDay, effS)
  }
  return prices
}

/**
 * Executable Terminal Liquidation Tail (round2-design-review.md §3):
 * Values remaining sellable inventory by constructing and executing real legal `sell` batches
 * via `applyActions` at `t_H` (respecting q2->q1->q0 shared crop tiers, rounding, market/event factors,
 * vault exclusions, and progressive b12 sale tax). Unsellable items receive strictly 0 fake cash.
 */
export function evaluateTerminalLiquidationTail(adapter, worldAtHorizon, {
  initialWorld = worldAtHorizon,
  objectiveCfg = buildObjectiveConfig(),
  scenarioSupplyFactor = null,
  explicitTerminalPrices = null,
  prevIsleSoldMap = null,
} = {}) {
  if (objectiveCfg.terminalSupplyMode === 'zero') {
    return {
      netLiquidationCash: 0,
      grossLiquidationCash: 0,
      taxPaidOnLiquidation: 0,
      standingPlotSeedRecovery: 0,
      terminalEnergyCredit: 0,
      totalTerminalValue: 0,
      executableActions: [],
      allBatchesValid: true,
    }
  }

  const prices = explicitTerminalPrices || buildTerminalPrices(adapter, worldAtHorizon, initialWorld, objectiveCfg, scenarioSupplyFactor, prevIsleSoldMap)
  const avail = adapter.availableInvSnapshot(worldAtHorizon.state)
  const sellActions = []

  // Sort items deterministically; within each item sell q=2 -> q=1 -> q=0 (exchange-optimal on shared crop tiers)
  const itemIds = Object.keys(avail).sort()
  for (const id of itemIds) {
    const baseP = Number(adapter.R.BASE_PRICE?.[id] || 0)
    const quoteP = Number(prices?.[id] || 0)
    if (!(baseP > 0) || !(quoteP > 0)) continue
    const counts = avail[id]
    for (const q of [2, 1, 0]) {
      let rem = Number(counts[q] || 0)
      while (rem > 0) {
        const n = Math.min(999, rem)
        sellActions.push({ a: 'sell', id, q, n })
        rem -= n
      }
    }
  }

  const maxBatch = adapter.R.WORLD?.maxActions || 40
  const maxAllowedActions = maxBatch * (objectiveCfg.maxLiquidationBatches || 8)
  const boundedSellActions = sellActions.slice(0, maxAllowedActions)
  let simWorld = adapter.cloneWorld(worldAtHorizon)
  simWorld.prices = prices
  let grossSum = 0
  let taxSum = 0
  let allValid = true

  for (let i = 0; i < boundedSellActions.length; i += maxBatch) {
    const batch = boundedSellActions.slice(i, i + maxBatch)
    const step = adapter.simulateBatch(simWorld, batch, { t: simWorld.now, prices })
    if (!step.allOk) allValid = false
    simWorld = step.afterWorld
    for (const o of step.result.out || []) {
      if (o?.ok) {
        grossSum += Number(o.gross ?? o.earn ?? 0)
        taxSum += Number(o.tax || 0)
      }
    }
  }

  const netLiquidationCash = Number(simWorld.coins || 0) - Number(worldAtHorizon.coins || 0)
  const terminalEnergyCredit = Math.max(0, Number(worldAtHorizon.state?.en || 0)) * objectiveCfg.energyTerminalCreditPerPoint
  const totalTerminalValue = netLiquidationCash + terminalEnergyCredit

  return {
    netLiquidationCash,
    grossLiquidationCash: grossSum,
    taxPaidOnLiquidation: taxSum,
    standingPlotContinuationValue: 0,
    terminalEnergyCredit,
    totalTerminalValue,
    executableActions: boundedSellActions,
    truncatedByBatchBudget: sellActions.length > boundedSellActions.length,
    allBatchesValid: allValid,
  }
}

export function evaluateTrajectoryObjective(adapter, {
  initialWorld,
  finalWorld,
  cashEvents = [],
  objectiveCfg = buildObjectiveConfig(),
  scenarioSupplyFactor = null,
  explicitTerminalPrices = null,
  prevIsleSoldMap = null,
}) {
  const t0 = Number(initialWorld?.now || 0)
  const tH = Number(finalWorld?.now ?? t0)
  let discountedNetCashFlow = 0
  if (cashEvents.length > 0) {
    for (const ev of cashEvents) {
      const dt = Math.max(0, Number(ev.atSec ?? t0) - t0)
      discountedNetCashFlow += Number(ev.netCashDelta || 0) * discountFactor(objectiveCfg.discountRatePerHour, dt)
    }
  } else {
    discountedNetCashFlow = Number(finalWorld?.coins || 0) - Number(initialWorld?.coins || 0)
  }

  const tail = evaluateTerminalLiquidationTail(adapter, finalWorld, {
    initialWorld,
    objectiveCfg,
    scenarioSupplyFactor,
    explicitTerminalPrices,
    prevIsleSoldMap,
  })
  const tailDiscount = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, tH - t0))
  const totalObjectiveValue = Number(initialWorld?.coins || 0) + discountedNetCashFlow + tail.totalTerminalValue * tailDiscount

  return {
    initialCoins: Number(initialWorld?.coins || 0),
    finalCoinsBeforeTail: Number(finalWorld?.coins || 0),
    undiscountedNetCashDelta: Number(finalWorld?.coins || 0) - Number(initialWorld?.coins || 0),
    discountedNetCashFlow,
    terminalTail: tail,
    discountedTerminalValue: tail.totalTerminalValue * tailDiscount,
    totalObjectiveValue,
  }
}

/**
 * Detects the rolling-endpoint perpetual deferral pathology (round2-design-review.md §3):
 * e.g., p(t) = 100 - 1/(t+1) with terminalValue = 0 and rolling 1-step horizon where
 * every step plans to sell at t+1 and never executes at t.
 */
export function detectRollingDeferral(commitmentHistory = []) {
  if (!Array.isArray(commitmentHistory) || commitmentHistory.length < 3) {
    return { rollingDeferralDetected: false, shifts: 0, reason: null }
  }
  let consecutiveForwardShifts = 0
  let prevTargetSec = null
  const itemId = commitmentHistory[0]?.itemId || null
  for (const step of commitmentHistory) {
    if (step.executedSellQty > 0) {
      consecutiveForwardShifts = 0
      prevTargetSec = null
      continue
    }
    if (step.newExternalShock === true) {
      consecutiveForwardShifts = 0
      prevTargetSec = step.plannedSellAtSec ?? null
      continue
    }
    if (Number.isFinite(step.plannedSellAtSec)) {
      if (prevTargetSec != null && step.plannedSellAtSec > prevTargetSec) {
        consecutiveForwardShifts++
      }
      prevTargetSec = step.plannedSellAtSec
    }
  }
  if (consecutiveForwardShifts >= 2) {
    return {
      rollingDeferralDetected: true,
      itemId,
      shifts: consecutiveForwardShifts,
      reason: 'rolling-horizon-endpoint-shift-without-new-information',
    }
  }
  return { rollingDeferralDetected: false, shifts: consecutiveForwardShifts, reason: null }
}
