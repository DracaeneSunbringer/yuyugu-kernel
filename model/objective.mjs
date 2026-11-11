import crypto from 'node:crypto'

export function buildObjectiveConfig(raw = {}) {
  const horizonSec = Number.isFinite(raw.horizonSec) ? Math.max(0, Math.floor(raw.horizonSec)) : 6 * 14400
  const terminalSupplyMode = raw.terminalSupplyMode || 'conservative-floor'
  const defaultContinuationIsleDays = terminalSupplyMode === 'zero' || horizonSec < 2 * 14400 ? 0 : 12
  const cfg = {
    horizonSec,
    extendedHorizonDeltaSec: Number.isFinite(raw.extendedHorizonDeltaSec)
      ? Math.max(0, Math.floor(raw.extendedHorizonDeltaSec))
      : 2 * 14400,
    discountRatePerHour: Number.isFinite(raw.discountRatePerHour) ? Math.max(0, Number(raw.discountRatePerHour)) : 0,
    terminalSupplyMode,
    conservativeSupplyFactor: Number.isFinite(raw.conservativeSupplyFactor) ? Number(raw.conservativeSupplyFactor) : 0.8,
    maxLiquidationBatches: Number.isInteger(raw.maxLiquidationBatches) && raw.maxLiquidationBatches > 0 ? raw.maxLiquidationBatches : 8,
    energyTerminalCreditPerPoint: Number.isFinite(raw.energyTerminalCreditPerPoint) ? Number(raw.energyTerminalCreditPerPoint) : 0,
    continuationIsleDays: Number.isInteger(raw.continuationIsleDays) && raw.continuationIsleDays >= 0
      ? raw.continuationIsleDays
      : defaultContinuationIsleDays,
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

const contQuoteCacheByAdapter = new WeakMap()
const contCraftTemplatesByAdapter = new WeakMap()

function getContinuationQuotesForIsleDay(adapter, iDay, sFactor) {
  let cache = contQuoteCacheByAdapter.get(adapter)
  if (!cache) {
    cache = new Map()
    contQuoteCacheByAdapter.set(adapter, cache)
  }
  const key = `${iDay}:${Number(sFactor).toFixed(6)}`
  let quotes = cache.get(key)
  if (!quotes) {
    quotes = {}
    for (const id of adapter.graph.sellableIds) {
      quotes[id] = adapter.quoteWithSupplyFactor(id, iDay, sFactor)
    }
    cache.set(key, quotes)
  }
  return quotes
}

function getContinuationCraftTemplates(adapter) {
  let tpls = contCraftTemplatesByAdapter.get(adapter)
  if (tpls) return tpls
  const { R, graph } = adapter
  const sellableRecipes = (R.RECIPES || []).filter((r) => Number(r.price) > 0)
  const list = []
  const sigOf = (steps, rawInputs, outId) => {
    const inStr = Object.keys(rawInputs)
      .sort()
      .map((k) => `${k}:${rawInputs[k]}`)
      .join(',')
    return `${steps}|${inStr}->${outId}`
  }
  for (const r of sellableRecipes) {
    list.push({
      outId: r.id,
      actions: [{ id: r.id, n: 1 }],
      rawIn: { ...r.in },
      craftSlots: 1,
      signature: sigOf(1, r.in, r.id),
    })
    const upstreamActions = []
    const expandedRawIn = {}
    let hasCraftedInput = false
    let totalSlots = 1
    for (const [inId, qty] of Object.entries(r.in || {})) {
      const upRec = graph.recipesById.get(inId)
      if (upRec) {
        hasCraftedInput = true
        upstreamActions.push({ id: upRec.id, n: qty })
        totalSlots += qty
        for (const [rawId, rawQty] of Object.entries(upRec.in || {})) {
          expandedRawIn[rawId] = (expandedRawIn[rawId] || 0) + rawQty * qty
        }
      } else {
        expandedRawIn[inId] = (expandedRawIn[inId] || 0) + qty
      }
    }
    if (hasCraftedInput) {
      list.push({
        outId: r.id,
        actions: [...upstreamActions, { id: r.id, n: 1 }],
        rawIn: expandedRawIn,
        craftSlots: totalSlots,
        signature: sigOf(totalSlots, expandedRawIn, r.id),
      })
    }
  }
  list.sort((a, b) => a.signature.localeCompare(b.signature))
  contCraftTemplatesByAdapter.set(adapter, list)
  return list
}

export function buildContinuationTimeline(
  adapter,
  worldAtHorizon,
  initialWorld,
  objectiveCfg,
  scenarioSupplyFactor = null,
  prevIsleSoldMap = null
) {
  if (!objectiveCfg || objectiveCfg.terminalSupplyMode === 'zero') return []
  const clockStart = worldAtHorizon?.clockStart ?? initialWorld?.clockStart
  adapter.syncClock(clockStart)
  const { R } = adapter
  const tH = Number(worldAtHorizon?.now || 0)
  const t0 = Number(initialWorld?.now ?? tH)
  const sameIsleDay = R.isleIndex(tH) === R.isleIndex(t0)
  const contDays = sameIsleDay ? 0 : Math.max(0, Math.floor(Number(objectiveCfg.continuationIsleDays || 0)))
  const sFactor = objectiveCfg.terminalSupplyMode === 'scenario-matched' && Number.isFinite(scenarioSupplyFactor)
    ? scenarioSupplyFactor
    : Number(objectiveCfg.conservativeSupplyFactor ?? 0.8)
  const discRate = Number(objectiveCfg.discountRatePerHour || 0)

  const slots = []
  let curSec = tH
  for (let d = 0; d <= contDays; d++) {
    const isleStart = curSec
    const nextIsleSec = adapter.nextIsleBoundary(isleStart, clockStart)
    const iIdx = R.isleIndex(isleStart)
    const iDay = R.isleDay(isleStart)
    const prices = d === 0
      ? buildTerminalPrices(adapter, worldAtHorizon, initialWorld, objectiveCfg, scenarioSupplyFactor, prevIsleSoldMap)
      : getContinuationQuotesForIsleDay(adapter, iDay, sFactor)

    if (contDays === 0 || !(nextIsleSec > isleStart)) {
      slots.push({
        stepIdx: d,
        slotOffset: slots.length,
        atSec: isleStart,
        nextAtSec: Math.max(isleStart, nextIsleSec),
        isleIndex: iIdx,
        isleDay: iDay,
        naturalDay: R.worldDay(isleStart),
        season: R.seasonOf(iDay),
        weather: R.weatherOf(iDay),
        prices,
        discFromTH: discountFactor(discRate, Math.max(0, isleStart - tH)),
      })
      break
    }

    let segStart = isleStart
    for (let guard = 0; guard < 4 && segStart < nextIsleSec; guard++) {
      const nextNd = adapter.nextNaturalDayBoundary(segStart)
      const segEnd = nextNd > segStart && nextNd < nextIsleSec ? nextNd : nextIsleSec
      slots.push({
        stepIdx: d,
        slotOffset: slots.length,
        atSec: segStart,
        nextAtSec: segEnd,
        isleIndex: iIdx,
        isleDay: iDay,
        naturalDay: R.worldDay(segStart),
        season: R.seasonOf(iDay),
        weather: R.weatherOf(iDay),
        prices,
        discFromTH: discountFactor(discRate, Math.max(0, segStart - tH)),
      })
      segStart = segEnd
    }
    curSec = nextIsleSec
  }
  return slots
}

/**
 * Executable Terminal Liquidation & Multi-Season Continuation Tail:
 * Values remaining sellable inventory and standing in-season crops across the deterministic
 * multi-season continuation timeline (`contSlots`) by constructing and executing real legal
 * `craft` and `sell` batches via `advanceTimeOnly` + `simulateBatch` (respecting q2->q1->q0
 * shared crop tiers, workshop caps, natural stamina regen, rounding, market/event/season factors,
 * vault exclusions, and progressive b12 sale tax). Unsellable items receive strictly 0 fake cash.
 */
export function evaluateTerminalLiquidationTail(adapter, worldAtHorizon, {
  initialWorld = worldAtHorizon,
  objectiveCfg = buildObjectiveConfig(),
  scenarioSupplyFactor = null,
  explicitTerminalPrices = null,
  prevIsleSoldMap = null,
  allowTerminalCraft = true,
  allowTerminalHarvest = true,
} = {}) {
  if (objectiveCfg.terminalSupplyMode === 'zero') {
    return {
      netLiquidationCash: 0,
      grossLiquidationCash: 0,
      taxPaidOnLiquidation: 0,
      standingPlotSeedRecovery: 0,
      standingPlotContinuationValue: 0,
      terminalEnergyCredit: 0,
      totalTerminalValue: 0,
      executableActions: [],
      allBatchesValid: true,
    }
  }

  const contSlots = explicitTerminalPrices != null
    ? []
    : buildContinuationTimeline(adapter, worldAtHorizon, initialWorld, objectiveCfg, scenarioSupplyFactor, prevIsleSoldMap)

  if (explicitTerminalPrices != null || contSlots.length <= 1) {
    const prices = explicitTerminalPrices || (contSlots[0]?.prices ?? buildTerminalPrices(adapter, worldAtHorizon, initialWorld, objectiveCfg, scenarioSupplyFactor, prevIsleSoldMap))
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

  // Multi-season continuation liquidation across `contSlots` (`contSlots.length > 1`)
  const { R, graph } = adapter
  const tH = Number(worldAtHorizon?.now || 0)
  const S = contSlots.length
  const avail = adapter.availableInvSnapshot(worldAtHorizon.state)

  // Group continuation slots by naturalDay (zero-string-allocation integer day index `slotNdIdx[s]`)
  const distinctNatDays = []
  const natDayToIdx = new Map()
  const slotsByNatDay = []
  const slotNdIdx = new Int32Array(S)
  for (let s = 0; s < S; s++) {
    const nd = contSlots[s].naturalDay
    let ndIdx = natDayToIdx.get(nd)
    if (ndIdx === undefined) {
      ndIdx = distinctNatDays.length
      distinctNatDays.push(nd)
      natDayToIdx.set(nd, ndIdx)
      slotsByNatDay.push([])
    }
    slotNdIdx[s] = ndIdx
    slotsByNatDay[ndIdx].push(s)
  }

  const D_CONT = distinctNatDays.length
  const scByItem = Object.create(null)
  const initNatDay = R.worldDay(tH)
  const initNdIdx = natDayToIdx.get(initNatDay)
  if (initNdIdx !== undefined && worldAtHorizon.state?.enDay === initNatDay && worldAtHorizon.state?.cnt) {
    for (const [k, v] of Object.entries(worldAtHorizon.state.cnt)) {
      if (k.startsWith('sc_') && Number(v) > 0) {
        const arr = new Float64Array(D_CONT)
        arr[initNdIdx] = Number(v)
        scByItem[k.slice(3)] = arr
      }
    }
  }
  const getScAtNdIdx = (ndIdx, id) => {
    const arr = scByItem[id]
    return arr ? arr[ndIdx] : 0
  }
  const addScAtNdIdx = (ndIdx, id, n) => {
    if (!(n > 0)) return
    let arr = scByItem[id]
    if (!arr) {
      arr = new Float64Array(D_CONT)
      scByItem[id] = arr
    }
    arr[ndIdx] += n
  }

  const bestNonCropSale = (id, minSlotIdx = 0, q = 0) => {
    const baseP = Number(R.BASE_PRICE?.[id] || 0)
    if (!(baseP > 0)) return { slotIdx: -1, val: 0 }
    const qual = R.QUALITY?.[q] ?? 1
    let bestIdx = -1
    let bestVal = 0
    for (let s = minSlotIdx; s < S; s++) {
      const quoteP = Number(contSlots[s].prices?.[id] || 0)
      if (!(quoteP > 0)) continue
      const v = Math.round(quoteP * qual) * contSlots[s].discFromTH
      if (v > bestVal + 1e-9) {
        bestVal = v
        bestIdx = s
      }
    }
    return { slotIdx: bestIdx, val: bestVal }
  }

  const bestMarginalItemSaleVal = (id, q = 0, minSlotIdx = 0) => {
    if (!graph.cropsById.has(id)) return bestNonCropSale(id, minSlotIdx, q).val
    const baseP = Number(R.BASE_PRICE?.[id] || 0)
    if (!(baseP > 0)) return 0
    const qual = R.QUALITY?.[q] ?? 1
    const scArr = scByItem[id]
    let bestVal = 0
    for (let s = minSlotIdx; s < S; s++) {
      const quoteP = Number(contSlots[s].prices?.[id] || 0)
      if (!(quoteP > 0)) continue
      const sc = scArr ? scArr[slotNdIdx[s]] : 0
      const mult = sc >= 400 ? 0.70 : sc >= 150 ? 0.85 : 1.0
      const v = Math.round(quoteP * qual) * mult * contSlots[s].discFromTH
      if (v > bestVal + 1e-9) bestVal = v
    }
    return bestVal
  }

  // Track workshop caps per continuation isleIndex and natural stamina regen
  const craftCapByIsle = new Map()
  const firstSlotByIsle = []
  const initIsle = R.isleIndex(tH)
  for (let s = 0; s < S; s++) {
    const iIdx = contSlots[s].isleIndex
    if (!craftCapByIsle.has(iIdx)) {
      const used0 = iIdx === initIsle && worldAtHorizon.state?.iq?.d === initIsle
        ? Number(worldAtHorizon.state.iq.craft || 0)
        : 0
      craftCapByIsle.set(iIdx, allowTerminalCraft ? Math.max(0, (R.WORLD?.daily?.craft || 80) - used0) : 0)
      firstSlotByIsle.push(s)
    }
  }

  const regenEvery = R.WORLD?.regen || 180
  const initEn = Math.max(0, Math.floor(Number(worldAtHorizon.state?.en || 0)))
  const baseEnT = Number.isFinite(worldAtHorizon.state?.enT) ? Number(worldAtHorizon.state.enT) : tH
  const craftEnCost = R.WORLD?.cost?.craft ?? 1
  const rawEnMax = Number(R.energyMax(worldAtHorizon.state || {}))
  const enMaxCap = Number.isFinite(rawEnMax) && rawEnMax > 0 ? rawEnMax : 100
  const spentEnByCraftSlot = new Int32Array(firstSlotByIsle.length)

  const maxFeasibleAddEnAtSlot = (targetK) => {
    // Compute exact stamina available at `targetK` and ensure later already-committed craft slots remain feasible!
    let lo = 0
    let hi = enMaxCap
    if (targetK === 0 && initEn > enMaxCap) hi = initEn
    const checkAdd = (addEn) => {
      let curEn = initEn
      let curEnT = baseEnT
      for (let m = 0; m < firstSlotByIsle.length; m++) {
        const sec = contSlots[firstSlotByIsle[m]].atSec
        if (curEn < enMaxCap && sec > curEnT) {
          const add = Math.floor((sec - curEnT) / regenEvery)
          if (add > 0) {
            curEn = Math.min(enMaxCap, curEn + add)
            curEnT = curEn >= enMaxCap ? sec : curEnT + add * regenEvery
          }
        } else if (curEn >= enMaxCap) {
          curEnT = Math.max(curEnT, sec)
        }
        const spendHere = spentEnByCraftSlot[m] + (m === targetK ? addEn : 0)
        if (curEn < spendHere) return false
        if (spendHere > 0) {
          const wasFull = curEn >= enMaxCap
          curEn -= spendHere
          if (wasFull && curEn < enMaxCap) curEnT = sec
        }
      }
      return true
    }
    if (!checkAdd(craftEnCost)) return 0
    let ans = craftEnCost
    lo = craftEnCost + 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (checkAdd(mid)) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  const slotCraftActions = Array.from({ length: S }, () => [])
  const craftedArrivalsBySlot = Array.from({ length: S }, () => ({}))

  if (allowTerminalCraft && firstSlotByIsle.length > 0) {
    const templates = getContinuationCraftTemplates(adapter)
    const canDeductRaw = (snap, rawIn, mult) => {
      for (const [inId, perU] of Object.entries(rawIn)) {
        const r = snap[inId]
        const tot = r ? (r[0] || 0) + (r[1] || 0) + (r[2] || 0) : 0
        if (tot < perU * mult) return false
      }
      return true
    }
    const previewOpportunityCost = (snap, rawIn, mult) => {
      let opp = 0
      for (const [inId, perU] of Object.entries(rawIn)) {
        let need = perU * mult
        const r = snap[inId] || [0, 0, 0]
        for (let q = 0; q < 3 && need > 0; q++) {
          const tk = Math.min(r[q] || 0, need)
          if (tk > 0) {
            opp += tk * bestMarginalItemSaleVal(inId, q, 0)
            need -= tk
          }
        }
      }
      return opp
    }
    const applyDeductRaw = (snap, rawIn, mult) => {
      for (const [inId, perU] of Object.entries(rawIn)) {
        let need = perU * mult
        const r = snap[inId]
        for (let q = 0; q < 3 && need > 0; q++) {
          const tk = Math.min(r[q] || 0, need)
          r[q] -= tk
          need -= tk
        }
      }
    }

    for (let iter = 0; iter < 160; iter++) {
      let bestChoice = null
      for (let k = 0; k < firstSlotByIsle.length; k++) {
        const sIdx = firstSlotByIsle[k]
        const iIdx = contSlots[sIdx].isleIndex
        const capLeft = craftCapByIsle.get(iIdx) || 0
        if (capLeft <= 0) continue
        const availEnAtK = maxFeasibleAddEnAtSlot(k)
        if (availEnAtK < craftEnCost) continue

        for (const tpl of templates) {
          if (tpl.craftSlots > capLeft) continue
          const enReq = tpl.craftSlots * craftEnCost
          if (enReq > availEnAtK) continue
          if (!canDeductRaw(avail, tpl.rawIn, 1)) continue
          const outSale = bestNonCropSale(tpl.outId, sIdx, 0)
          if (!(outSale.val > 0)) continue
          const rawOpp = previewOpportunityCost(avail, tpl.rawIn, 1)
          const marginPerSlot = (outSale.val - rawOpp) / tpl.craftSlots
          if (marginPerSlot > 1e-6 && (!bestChoice || marginPerSlot > bestChoice.marginPerSlot + 1e-6)) {
            const maxChunk = Math.min(
              8,
              Math.floor(capLeft / tpl.craftSlots),
              Math.floor(availEnAtK / enReq),
              ...Object.entries(tpl.rawIn).map(([inId, perU]) => {
                const r = avail[inId] || [0, 0, 0]
                return Math.floor(((r[0] || 0) + (r[1] || 0) + (r[2] || 0)) / perU)
              })
            )
            bestChoice = { k, sIdx, iIdx, tpl, marginPerSlot, chunk: Math.max(1, maxChunk) }
          }
        }
      }
      if (!bestChoice) break
      let chunk = bestChoice.chunk
      if (chunk > 1) {
        const outMulti = bestChoice.chunk * bestNonCropSale(bestChoice.tpl.outId, bestChoice.sIdx, 0).val
        const oppMulti = previewOpportunityCost(avail, bestChoice.tpl.rawIn, chunk)
        if (outMulti - oppMulti <= 1e-6) chunk = 1
      }
      applyDeductRaw(avail, bestChoice.tpl.rawIn, chunk)
      craftCapByIsle.set(bestChoice.iIdx, (craftCapByIsle.get(bestChoice.iIdx) || 0) - bestChoice.tpl.craftSlots * chunk)
      spentEnByCraftSlot[bestChoice.k] += bestChoice.tpl.craftSlots * chunk * craftEnCost
      craftedArrivalsBySlot[bestChoice.sIdx][bestChoice.tpl.outId] =
        (craftedArrivalsBySlot[bestChoice.sIdx][bestChoice.tpl.outId] || 0) + chunk
      for (const actStep of bestChoice.tpl.actions) {
        const addN = actStep.n * chunk
        const list = slotCraftActions[bestChoice.sIdx]
        const prev = list[list.length - 1]
        if (prev && prev.id === actStep.id && prev.n + addN <= 20) {
          prev.n += addN
        } else {
          let remC = addN
          while (remC > 0) {
            const cN = Math.min(20, remC)
            list.push({ a: 'craft', id: actStep.id, n: cN })
            remC -= cN
          }
        }
      }
    }
  }

  const slotSellActions = Array.from({ length: S }, () => [])
  const pushSellToSlot = (sIdx, id, q, qty) => {
    let rem = Math.floor(qty)
    while (rem > 0) {
      const n = Math.min(999, rem)
      slotSellActions[sIdx].push({ a: 'sell', id, q, n })
      rem -= n
    }
  }

  // 1) Schedule crafted outputs from their craft slot onwards
  for (let s = 0; s < S; s++) {
    for (const id of Object.keys(craftedArrivalsBySlot[s]).sort()) {
      const qty = craftedArrivalsBySlot[s][id]
      if (!(qty > 0)) continue
      const best = bestNonCropSale(id, s, 0)
      if (best.slotIdx >= 0) pushSellToSlot(best.slotIdx, id, 0, qty)
    }
  }

  // 2) Schedule remaining initial `avail` items (`q = 2 -> 1 -> 0` concave tier allocation for crops)
  for (const id of Object.keys(avail).sort()) {
    const baseP = Number(R.BASE_PRICE?.[id] || 0)
    if (!(baseP > 0)) continue
    const counts = avail[id]
    if (!graph.cropsById.has(id)) {
      for (const q of [2, 1, 0]) {
        const rem = Number(counts[q] || 0)
        if (!(rem > 0)) continue
        const best = bestNonCropSale(id, 0, q)
        if (best.slotIdx >= 0) pushSellToSlot(best.slotIdx, id, q, rem)
      }
      continue
    }

    for (const q of [2, 1, 0]) {
      let rem = Number(counts[q] || 0)
      if (!(rem > 0)) continue
      const qual = R.QUALITY?.[q] ?? 1
      const segments = []
      for (let ndIdx = 0; ndIdx < D_CONT; ndIdx++) {
        let bestS = -1
        let bestUnit = 0
        const ndSlots = slotsByNatDay[ndIdx]
        for (let k = 0; k < ndSlots.length; k++) {
          const sIdx = ndSlots[k]
          const quoteP = Number(contSlots[sIdx].prices?.[id] || 0)
          if (!(quoteP > 0)) continue
          const uVal = Math.round(quoteP * qual) * contSlots[sIdx].discFromTH
          if (uVal > bestUnit + 1e-9) {
            bestUnit = uVal
            bestS = sIdx
          }
        }
        if (bestS < 0) continue
        const sc0 = getScAtNdIdx(ndIdx, id)
        const cap0 = Math.max(0, 150 - sc0)
        const cap1 = Math.max(0, 400 - Math.max(150, sc0))
        if (cap0 > 0) segments.push({ ndIdx, sIdx: bestS, cap: cap0, score: bestUnit * 1.0 })
        if (cap1 > 0) segments.push({ ndIdx, sIdx: bestS, cap: cap1, score: bestUnit * 0.85 })
        segments.push({ ndIdx, sIdx: bestS, cap: rem, score: bestUnit * 0.70 })
      }
      segments.sort((a, b) => (b.score - a.score) || (a.sIdx - b.sIdx))
      const bySlotQty = new Map()
      for (const seg of segments) {
        if (rem <= 0) break
        const take = Math.min(rem, seg.cap)
        if (take > 0) {
          rem -= take
          addScAtNdIdx(seg.ndIdx, id, take)
          bySlotQty.set(seg.sIdx, (bySlotQty.get(seg.sIdx) || 0) + take)
        }
      }
      for (const [sIdx, qty] of [...bySlotQty.entries()].sort((a, b) => a[0] - b[0])) {
        pushSellToSlot(sIdx, id, q, qty)
      }
    }
  }

  // Execute sparse continuation slot batches chronologically via real `advanceTimeOnly` + `simulateBatch`
  const maxBatch = R.WORLD?.maxActions || 40
  const maxAllowedActions = maxBatch * Math.max(8, objectiveCfg.maxLiquidationBatches || 8)
  let simWorld = adapter.cloneWorld(worldAtHorizon)
  let discountedNetCash = 0
  let grossSum = 0
  let taxSum = 0
  let allValid = true
  let totalPlannedCount = 0
  const executedActions = []

  for (let s = 0; s < S; s++) {
    const combined = [...slotCraftActions[s], ...slotSellActions[s]]
    if (combined.length === 0) continue
    totalPlannedCount += combined.length
    const room = Math.max(0, maxAllowedActions - executedActions.length)
    if (room <= 0) break
    const bounded = combined.slice(0, room)
    const sl = contSlots[s]
    simWorld = adapter.advanceTimeOnly(simWorld, sl.atSec, { futurePrices: sl.prices })
    const beforeCoins = Number(simWorld.coins || 0)
    for (let i = 0; i < bounded.length; i += maxBatch) {
      const batch = bounded.slice(i, i + maxBatch)
      const step = adapter.simulateBatch(simWorld, batch, { t: sl.atSec, prices: sl.prices })
      if (!step.allOk) allValid = false
      simWorld = step.afterWorld
      executedActions.push(...batch)
      for (const o of step.result.out || []) {
        if (o?.ok) {
          grossSum += Number(o.gross ?? o.earn ?? 0)
          taxSum += Number(o.tax || 0)
        }
      }
    }
    const afterCoins = Number(simWorld.coins || 0)
    discountedNetCash += (afterCoins - beforeCoins) * sl.discFromTH
  }

  // Value standing in-season plots across their remaining legal harvests in `contSlots` (when `allowTerminalHarvest`)
  let standingPlotContinuationValue = 0
  if (allowTerminalHarvest && Array.isArray(worldAtHorizon.state?.plots)) {
    const contEndSec = contSlots[S - 1].nextAtSec
    const approxTaxMult = Number(simWorld.coins || 0) > (R.B12_TAX?.free || 3000000) ? 0.99 : 1.0
    const yBase = R.WORLD?.yieldBase || [1, 2]
    const yWBonus = R.WORLD?.yieldWaterBonus || 0.18
    const qBase = R.WORLD?.qualBase || [0.06, 0.22]
    const qWBonus = R.WORLD?.qualWaterBonus || [0.05, 0.10]

    for (let pIdx = 0; pIdx < worldAtHorizon.state.plots.length; pIdx++) {
      const p0 = worldAtHorizon.state.plots[pIdx]
      if (!p0 || !p0.c) continue
      const crop = graph.cropsById.get(p0.c)
      if (!crop) continue
      const isSpr = Boolean(R.sprinkled(worldAtHorizon.state, pIdx))
      const maxTimes = crop.regrow ? (crop.times || 1) : 1
      let curPlot = { ...p0 }

      while ((curPlot.h || 0) < maxTimes) {
        const plantedDay = R.isleDay(curPlot.t)
        if (!crop.seasons.includes(R.seasonOf(plantedDay))) break
        const evalFrom = Math.max(tH, Number(curPlot.t || tH))
        const timing = adapter.exactPlotTimings(curPlot, isSpr, evalFrom, worldAtHorizon.clockStart)
        if (!timing || timing.stage === -1 || timing.matureAt > contEndSec) break

        let matureSlotIdx = S - 1
        for (let s = 0; s < S; s++) {
          if (contSlots[s].nextAtSec > timing.matureAt) {
            matureSlotIdx = s
            break
          }
        }

        const wStages = isSpr || R.weatherOf(plantedDay) === 1 ? 3 : Math.max(Number(curPlot.w || 0), 2)
        const avgCount = 0.5 * (yBase[0] + yBase[1]) + wStages * yWBonus
        const pQ2 = Math.min(1, qBase[0] + wStages * qWBonus[0])
        const pQ1 = Math.min(1 - pQ2, qBase[1] + wStages * qWBonus[1])
        const pQ0 = Math.max(0, 1 - pQ2 - pQ1)
        const expByQ = [avgCount * pQ0, avgCount * pQ1, avgCount * pQ2]

        // Value expected yield across remaining continuation workshop or crop-tier capacity from `matureSlotIdx`
        let usedRecipe = null
        let bestRecImplied = 0
        if (allowTerminalCraft) {
          for (const rec of graph.consumedByRecipes.get(crop.id) || []) {
            if (!(rec.price > 0) || Object.keys(rec.in || {}).length !== 1) continue
            const needQty = Number(rec.in[crop.id] || 0)
            if (!(needQty > 0)) continue
            let openCraftSlot = -1
            for (let s = matureSlotIdx; s < S; s++) {
              if ((craftCapByIsle.get(contSlots[s].isleIndex) || 0) >= 1 - 1e-9) {
                openCraftSlot = s
                break
              }
            }
            if (openCraftSlot < 0) continue
            const outBest = bestNonCropSale(rec.id, openCraftSlot, 0)
            const implied = (outBest.val * approxTaxMult) / needQty
            if (implied > bestRecImplied) {
              bestRecImplied = implied
              usedRecipe = { isleIdx: contSlots[openCraftSlot].isleIndex, needQty }
            }
          }
        }

        for (const q of [2, 1, 0]) {
          const units = expByQ[q]
          if (!(units > 0)) continue
          let bestDirVal = 0
          let bestDirNdIdx = slotNdIdx[matureSlotIdx]
          const qual = R.QUALITY?.[q] ?? 1
          const scArr = scByItem[crop.id]
          for (let s = matureSlotIdx; s < S; s++) {
            const quoteP = Number(contSlots[s].prices?.[crop.id] || 0)
            if (!(quoteP > 0)) continue
            const sc = scArr ? scArr[slotNdIdx[s]] : 0
            const mult = sc >= 400 ? 0.70 : sc >= 150 ? 0.85 : 1.0
            const v = Math.round(quoteP * qual) * mult * contSlots[s].discFromTH * approxTaxMult
            if (v > bestDirVal + 1e-9) {
              bestDirVal = v
              bestDirNdIdx = slotNdIdx[s]
            }
          }
          if (usedRecipe && bestRecImplied > bestDirVal) {
            standingPlotContinuationValue += units * bestRecImplied
            const curCap = craftCapByIsle.get(usedRecipe.isleIdx) || 0
            craftCapByIsle.set(usedRecipe.isleIdx, Math.max(0, curCap - units / usedRecipe.needQty))
          } else {
            standingPlotContinuationValue += units * bestDirVal
            addScAtNdIdx(bestDirNdIdx, crop.id, units)
          }
        }

        const nextH = (curPlot.h || 0) + 1
        if (crop.regrow && nextH < maxTimes) {
          curPlot = { ...curPlot, t: timing.matureAt, w: 0, g: 0, h: nextH }
        } else {
          break
        }
      }
    }
  }

  const terminalEnergyCredit = Math.max(0, Number(worldAtHorizon.state?.en || 0)) * objectiveCfg.energyTerminalCreditPerPoint
  const totalTerminalValue = discountedNetCash + standingPlotContinuationValue + terminalEnergyCredit

  return {
    netLiquidationCash: discountedNetCash,
    grossLiquidationCash: grossSum,
    taxPaidOnLiquidation: taxSum,
    standingPlotContinuationValue,
    terminalEnergyCredit,
    totalTerminalValue,
    executableActions: executedActions,
    truncatedByBatchBudget: totalPlannedCount > executedActions.length,
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
  allowTerminalCraft = true,
  allowTerminalHarvest = true,
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
    allowTerminalCraft,
    allowTerminalHarvest,
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
