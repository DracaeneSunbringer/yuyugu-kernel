import crypto from 'node:crypto'

export function buildObjectiveConfig(raw = {}) {
  const horizonSec = Number.isFinite(raw.horizonSec) ? Math.max(0, Math.floor(raw.horizonSec)) : 6 * 14400
  const terminalSupplyMode = raw.terminalSupplyMode || 'conservative-floor'
  const defaultContinuationIsleDays = terminalSupplyMode === 'zero' ? 0 : 12
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

/**
 * Unified Multi-Season Continuation Farm Flow & Renewal Engine:
 * Shared between `evaluateTerminalLiquidationTail` (terminal objective valuation) and
 * `planner/solve.mjs` (background post-horizon workshop & crop-tier saturation).
 * Simulates both standing plots' remaining legal harvests AND chronological post-release /
 * empty-plot seasonal renewals across `contSlots` using exact `adapter.exactPlotTimings`,
 * with smooth pro-rata credit on cycles straddling `contEndSec`.
 */
export function projectContinuationFarmFlows(adapter, worldAtStart, contSlots, {
  craftCapByIsle = new Map(),
  getScAtSlot = () => 0,
  addScAtSlot = () => {},
  approxTaxMult = 1.0,
  discRatePerHour = 0,
  discOriginSec = null,
  allowTerminalCraft = true,
  allowTerminalHarvest = true,
  allowTerminalPlant = true,
  skipStandingPlots = false,
  freeRegenEnPool = Infinity,
  staminaShadowCost = 0,
} = {}) {
  const S = Array.isArray(contSlots) ? contSlots.length : 0
  const state = worldAtStart?.state || {}
  const plotN = Math.max(
    Number(state.plotN || 0),
    Array.isArray(state.plots) ? state.plots.length : 0
  )
  if (S === 0 || plotN <= 0 || (!allowTerminalHarvest && !allowTerminalPlant)) {
    return {
      standingPlotValue: 0,
      renewalPlotValue: 0,
      totalPlotContinuationValue: 0,
    }
  }

  const { R, graph } = adapter
  const clockStart = worldAtStart?.clockStart
  adapter.syncClock(clockStart)
  const tStart = Number(contSlots[0].atSec || worldAtStart?.now || 0)
  const originSec = Number.isFinite(discOriginSec) ? Number(discOriginSec) : tStart
  const contEndSec = Number(contSlots[S - 1].nextAtSec || tStart)
  if (!(contEndSec > tStart)) {
    return {
      standingPlotValue: 0,
      renewalPlotValue: 0,
      totalPlotContinuationValue: 0,
    }
  }

  let remFreeEn = Math.max(0, Number.isFinite(freeRegenEnPool) ? Number(freeRegenEnPool) : Infinity)
  const coffeePricePerEn = (Number(R.WORLD?.coffee?.price || 15000)) / Math.max(1, Number(R.WORLD?.coffee?.energy || 60))
  const clearEnCost = R.WORLD?.cost?.clear ?? 1
  const craftEnCost = R.WORLD?.cost?.craft ?? 1

  const previewStaminaCost = (enUnits, disc = 1.0) => {
    if (!(enUnits > 0)) return 0
    const freeTake = Math.min(remFreeEn, enUnits)
    const paidTake = Math.max(0, enUnits - freeTake)
    return (freeTake * staminaShadowCost + paidTake * Math.max(staminaShadowCost, coffeePricePerEn)) * disc
  }
  const commitStaminaCost = (enUnits, disc = 1.0) => {
    const cost = previewStaminaCost(enUnits, disc)
    if (Number.isFinite(remFreeEn) && enUnits > 0) {
      remFreeEn = Math.max(0, remFreeEn - enUnits)
    }
    return cost
  }

  const slotIdxForSec = (sec) => {
    let lo = 0
    let hi = S - 1
    let ans = S - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (contSlots[mid].nextAtSec > sec) {
        ans = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    return ans
  }

  const slotDisc = (sIdx) => (
    Number.isFinite(contSlots[sIdx]?.discFromTH)
      ? contSlots[sIdx].discFromTH
      : discountFactor(discRatePerHour, Math.max(0, contSlots[sIdx].atSec - originSec))
  )

  const suffixBestRecipeVal = new Map()
  if (allowTerminalCraft) {
    for (const rec of R.RECIPES || []) {
      if (!(rec.price > 0) || Object.keys(rec.in || {}).length !== 1) continue
      const baseP = Number(R.BASE_PRICE?.[rec.id] || 0)
      if (!(baseP > 0)) continue
      const arr = new Float64Array(S)
      let bestVal = 0
      for (let s = S - 1; s >= 0; s--) {
        const quoteP = Number(contSlots[s].prices?.[rec.id] || 0)
        if (quoteP > 0) {
          const v = Math.round(quoteP) * slotDisc(s)
          if (v > bestVal) bestVal = v
        }
        arr[s] = bestVal
      }
      suffixBestRecipeVal.set(rec.id, arr)
    }
  }

  const evaluateHarvestBatch = (cropId, expByQ, matureSec, commit) => {
    const matureSlotIdx = slotIdxForSec(matureSec)
    let usedRecipe = null
    let bestRecImplied = 0
    if (allowTerminalCraft) {
      for (const rec of graph.consumedByRecipes.get(cropId) || []) {
        const suffixArr = suffixBestRecipeVal.get(rec.id)
        if (!suffixArr) continue
        const needQty = Number(rec.in[cropId] || 0)
        if (!(needQty > 0)) continue
        let openCraftSlot = -1
        for (let s = matureSlotIdx; s < S; s++) {
          if ((craftCapByIsle.get(contSlots[s].isleIndex) || 0) >= 1 - 1e-9) {
            openCraftSlot = s
            break
          }
        }
        if (openCraftSlot < 0) continue
        const outBestVal = suffixArr[openCraftSlot]
        const craftDisc = slotDisc(openCraftSlot)
        const craftEnVal = previewStaminaCost(craftEnCost, craftDisc)
        const implied = Math.max(0, outBestVal * approxTaxMult - craftEnVal) / needQty
        if (implied > bestRecImplied) {
          bestRecImplied = implied
          usedRecipe = { isleIdx: contSlots[openCraftSlot].isleIndex, needQty, craftDisc }
        }
      }
    }

    let valSum = 0
    for (const q of [2, 1, 0]) {
      const units = Number(expByQ[q] || 0)
      if (!(units > 0)) continue
      let bestDirVal = 0
      let bestDirSlot = matureSlotIdx
      const qual = R.QUALITY?.[q] ?? 1
      for (let s = matureSlotIdx; s < S; s++) {
        const quoteP = Number(contSlots[s].prices?.[cropId] || 0)
        if (!(quoteP > 0)) continue
        const sc = Number(getScAtSlot(s, cropId) || 0)
        const mult = sc >= 400 ? 0.70 : sc >= 150 ? 0.85 : 1.0
        const v = Math.round(quoteP * qual) * mult * slotDisc(s) * approxTaxMult
        if (v > bestDirVal + 1e-9) {
          bestDirVal = v
          bestDirSlot = s
        }
      }

      if (usedRecipe && bestRecImplied > bestDirVal) {
        const curCap = craftCapByIsle.get(usedRecipe.isleIdx) || 0
        const slotsReq = units / usedRecipe.needQty
        const slotsTake = Math.min(curCap, slotsReq)
        const unitsCrafted = slotsTake * usedRecipe.needQty
        const unitsLeft = Math.max(0, units - unitsCrafted)
        valSum += unitsCrafted * bestRecImplied + unitsLeft * bestDirVal
        if (commit) {
          if (slotsTake > 0) {
            craftCapByIsle.set(usedRecipe.isleIdx, Math.max(0, curCap - slotsTake))
            commitStaminaCost(slotsTake * craftEnCost, usedRecipe.craftDisc)
          }
          if (unitsLeft > 0) {
            addScAtSlot(bestDirSlot, cropId, unitsLeft)
          }
        }
      } else {
        valSum += units * bestDirVal
        if (commit) addScAtSlot(bestDirSlot, cropId, units)
      }
    }
    return valSum
  }

  let standingPlotValue = 0
  let renewalPlotValue = 0
  const freeAtSec = new Float64Array(plotN)
  const needsClear = new Uint8Array(plotN)

  if (skipStandingPlots) {
    freeAtSec.fill(tStart)
  } else {
    const standingEvents = []
    for (let pIdx = 0; pIdx < plotN; pIdx++) {
      const p0 = state.plots?.[pIdx]
      if (!p0 || !p0.c) {
        freeAtSec[pIdx] = tStart
        continue
      }
      const crop = graph.cropsById.get(p0.c)
      if (!crop) {
        freeAtSec[pIdx] = tStart
        needsClear[pIdx] = 1
        continue
      }
      if (!allowTerminalHarvest) {
        freeAtSec[pIdx] = contEndSec + 1
        continue
      }
      const isSpr = Boolean(R.sprinkled(state, pIdx))
      const standing = adapter.simulateStandingPlotLifecycle(p0, {
        nowSec: tStart,
        isSprinkled: isSpr,
        clockStart,
        cutoffEndSec: contEndSec,
        dryManualWaterStages: 2,
      })

      for (const hv of standing.harvests) {
        standingEvents.push({
          atSec: hv.matureAt,
          cropId: crop.id,
          expByQ: hv.expectedByQuality,
          stepEn: hv.stepEn,
        })
      }
      if (standing.partialProgressAtCutoff) {
        const pp = standing.partialProgressAtCutoff
        standingEvents.push({
          atSec: pp.atSec,
          cropId: crop.id,
          expByQ: pp.expectedByQuality,
          stepEn: pp.stepEn * pp.frac,
        })
      }

      freeAtSec[pIdx] = standing.releaseSec
      if (standing.needsClearAtEnd) {
        needsClear[pIdx] = 1
      }
    }

    standingEvents.sort((a, b) => a.atSec - b.atSec)
    for (const ev of standingEvents) {
      const disc = discountFactor(discRatePerHour, Math.max(0, ev.atSec - originSec))
      const rev = evaluateHarvestBatch(ev.cropId, ev.expByQ, ev.atSec, true)
      const enCost = commitStaminaCost(ev.stepEn, disc)
      standingPlotValue += Math.max(0, rev - enCost)
    }
  }

  if (allowTerminalPlant && allowTerminalHarvest) {
    const cropsBySeason = [0, 1, 2, 3].map((s) => (R.CROPS || []).filter((c) => c.seasons.includes(s)))
    for (let guard = 0; guard < plotN * 64; guard++) {
      let bestPlot = -1
      let minFree = contEndSec
      for (let pIdx = 0; pIdx < plotN; pIdx++) {
        if (freeAtSec[pIdx] < minFree) {
          minFree = freeAtSec[pIdx]
          bestPlot = pIdx
        }
      }
      if (bestPlot < 0) break

      const simT = minFree
      const isSpr = Boolean(R.sprinkled(state, bestPlot))
      const ncFlag = needsClear[bestPlot]
      const batchPlots = []
      for (let pIdx = 0; pIdx < plotN; pIdx++) {
        if (
          freeAtSec[pIdx] === simT &&
          Boolean(R.sprinkled(state, pIdx)) === isSpr &&
          needsClear[pIdx] === ncFlag
        ) {
          batchPlots.push(pIdx)
        }
      }
      const batchCount = batchPlots.length
      const season = R.seasonOf(R.isleDay(simT))
      const inSeason = cropsBySeason[season] || []
      const discStart = discountFactor(discRatePerHour, Math.max(0, simT - originSec))
      const extraClearEnPerPlot = ncFlag ? clearEnCost : 0

      const previewCyclePerPlotAt = (crop, startSec) => {
        const spec = adapter.simulateCropLifecycleFromPlant(crop, {
          startSec,
          isSprinkled: isSpr,
          clockStart,
          cutoffEndSec: -1,
          dryManualWaterStages: 2,
        })
        if (!spec) return null
        let revBatch = 0
        for (const h of spec.harvests) {
          const evalSec = Math.min(contEndSec - 1, h.matureAt)
          const eq = h.expectedByQuality
          revBatch += evaluateHarvestBatch(
            crop.id,
            [eq[0] * batchCount, eq[1] * batchCount, eq[2] * batchCount],
            evalSec,
            false
          )
        }
        const dStart = discountFactor(discRatePerHour, Math.max(0, startSec - originSec))
        const cycleEnValBatch = previewStaminaCost(spec.totalStaminaSpent * batchCount, dStart)
        const cycleNetPerPlot = (revBatch - spec.seedCost * batchCount * dStart - cycleEnValBatch) / batchCount
        return {
          spec,
          cycleNetPerPlot,
          rawRatePerPlotSec: cycleNetPerPlot / spec.occupiedSec,
        }
      }

      const nextSeasonB = adapter.nextSeasonBoundary(simT, clockStart)
      const evaluatedInSeason = []
      let hasCrossSeasonSpill = false
      for (const crop of inSeason) {
        const prev = previewCyclePerPlotAt(crop, simT)
        if (!prev || !(prev.cycleNetPerPlot > 1e-6)) continue
        evaluatedInSeason.push(prev)
        if (nextSeasonB > simT && nextSeasonB < contEndSec && prev.spec.endSec > nextSeasonB) {
          hasCrossSeasonSpill = true
        }
      }

      let rNextSeason = 0
      if (hasCrossSeasonSpill) {
        const nextSeason = R.seasonOf(R.isleDay(nextSeasonB))
        for (const futCrop of cropsBySeason[nextSeason] || []) {
          const nextPrev = previewCyclePerPlotAt(futCrop, nextSeasonB)
          if (nextPrev && nextPrev.rawRatePerPlotSec > rNextSeason) {
            rNextSeason = nextPrev.rawRatePerPlotSec
          }
        }
      }

      let bestSpec = null
      let bestScore = 0
      let bestTotalEnPerPlot = 0

      for (const prev of evaluatedInSeason) {
        const { spec, cycleNetPerPlot, rawRatePerPlotSec } = prev
        let score = rawRatePerPlotSec
        if (hasCrossSeasonSpill && rNextSeason > 0 && spec.endSec > nextSeasonB) {
          const spillNextSec = spec.endSec - nextSeasonB
          const surplusVsWait = cycleNetPerPlot - spillNextSec * rNextSeason
          if (!(surplusVsWait > 1e-6)) continue
          const preBoundaryWindowSec = Math.min(spec.occupiedSec, Math.max(60, nextSeasonB - simT))
          score = surplusVsWait / preBoundaryWindowSec
        }
        if (score > bestScore + 1e-9) {
          bestScore = score
          bestSpec = spec
          // Note: `spec.totalStaminaSpent` ALREADY includes `spec.endClearEnCost` when `spec.needsClearAtEnd === true`!
          bestTotalEnPerPlot = extraClearEnPerPlot + spec.totalStaminaSpent
        }
      }

      if (!bestSpec) {
        const nextB = adapter.nextIsleBoundary(simT, clockStart)
        const nextFree = nextB > simT ? Math.min(contEndSec, nextB) : contEndSec
        for (const pIdx of batchPlots) freeAtSec[pIdx] = nextFree
        continue
      }

      if (bestSpec.endSec <= contEndSec) {
        let realizedRev = 0
        for (const h of bestSpec.harvests) {
          const eq = h.expectedByQuality
          realizedRev += evaluateHarvestBatch(
            bestSpec.crop.id,
            [eq[0] * batchCount, eq[1] * batchCount, eq[2] * batchCount],
            h.matureAt,
            true
          )
        }
        const enVal = commitStaminaCost(bestTotalEnPerPlot * batchCount, discStart)
        renewalPlotValue += Math.max(0, realizedRev - bestSpec.seedCost * batchCount * discStart - enVal)
        // `bestTotalEnPerPlot` already charged both `extraClearEnPerPlot` and `bestSpec.endClearEnCost`,
        // so `needsClear` is strictly 0 at `bestSpec.endSec` (no double-counting!).
        for (const pIdx of batchPlots) {
          needsClear[pIdx] = 0
          freeAtSec[pIdx] = bestSpec.endSec
        }
      } else {
        const frac = Math.min(1, Math.max(0, contEndSec - simT) / bestSpec.occupiedSec)
        if (frac > 0) {
          let realizedRev = 0
          for (const h of bestSpec.harvests) {
            const evalSec = Math.min(contEndSec - 1, h.matureAt)
            const eq = h.expectedByQuality
            realizedRev += evaluateHarvestBatch(
              bestSpec.crop.id,
              [eq[0] * frac * batchCount, eq[1] * frac * batchCount, eq[2] * frac * batchCount],
              evalSec,
              true
            )
          }
          const enVal = commitStaminaCost(bestTotalEnPerPlot * frac * batchCount, discStart)
          renewalPlotValue += Math.max(0, realizedRev - bestSpec.seedCost * discStart * frac * batchCount - enVal)
        }
        for (const pIdx of batchPlots) {
          needsClear[pIdx] = 0
          freeAtSec[pIdx] = contEndSec
        }
      }
    }
  }

  return {
    standingPlotValue,
    renewalPlotValue,
    totalPlotContinuationValue: standingPlotValue + renewalPlotValue,
  }
}

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
  const initP = initialWorld?.prices
  const hasSyntheticZeroPrices = Boolean(
    initP &&
    adapter.graph?.sellableIds?.some(
      (id) => Object.prototype.hasOwnProperty.call(initP, id) && Number(initP[id]) <= 0 && Number(R.BASE_PRICE?.[id]) > 0
    )
  )
  const contDays = hasSyntheticZeroPrices && R.isleIndex(tH) === R.isleIndex(t0)
    ? 0
    : Math.max(0, Math.floor(Number(objectiveCfg.continuationIsleDays ?? 0)))
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
  allowTerminalPlant = allowTerminalHarvest,
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
      let chunk = 1
      if (bestChoice.chunk > 1) {
        const unitOutVal = bestNonCropSale(bestChoice.tpl.outId, bestChoice.sIdx, 0).val
        let prevOpp = previewOpportunityCost(avail, bestChoice.tpl.rawIn, 1)
        for (let m = 2; m <= bestChoice.chunk; m++) {
          const nextOpp = previewOpportunityCost(avail, bestChoice.tpl.rawIn, m)
          if (unitOutVal - (nextOpp - prevOpp) <= 1e-6) break
          chunk = m
          prevOpp = nextOpp
        }
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

  // Value standing in-season plots AND chronological post-release / empty-plot seasonal renewals across `contSlots`
  let standingPlotContinuationValue = 0
  if (allowTerminalHarvest || allowTerminalPlant) {
    const contEndSec = contSlots[S - 1].nextAtSec
    const approxTaxMult = Number(simWorld.coins || 0) > (R.B12_TAX?.free || 3000000) ? 0.99 : 1.0
    const totalPassiveRegen = initEn + Math.floor(Math.max(0, contEndSec - baseEnT) / regenEvery)
    let craftSpentTotal = 0
    for (let m = 0; m < spentEnByCraftSlot.length; m++) craftSpentTotal += spentEnByCraftSlot[m]
    const freeRegenEnPool = Math.max(0, totalPassiveRegen - craftSpentTotal)
    const farmFlows = projectContinuationFarmFlows(adapter, worldAtHorizon, contSlots, {
      craftCapByIsle,
      getScAtSlot: (sIdx, id) => getScAtNdIdx(slotNdIdx[sIdx], id),
      addScAtSlot: (sIdx, id, qty) => addScAtNdIdx(slotNdIdx[sIdx], id, qty),
      approxTaxMult,
      discRatePerHour: Number(objectiveCfg.discountRatePerHour || 0),
      discOriginSec: tH,
      allowTerminalCraft,
      allowTerminalHarvest,
      allowTerminalPlant,
      skipStandingPlots: false,
      freeRegenEnPool,
      staminaShadowCost: Number(objectiveCfg.energyTerminalCreditPerPoint || 0),
    })
    standingPlotContinuationValue = farmFlows.totalPlotContinuationValue
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
  allowTerminalPlant = allowTerminalHarvest,
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
    allowTerminalPlant,
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
