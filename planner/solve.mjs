import crypto from 'node:crypto'
import {
  buildContinuationTimeline,
  buildObjectiveConfig,
  buildTerminalPrices,
  discountFactor,
  evaluateTrajectoryObjective,
  projectContinuationFarmFlows,
} from '../model/objective.mjs'
import {
  buildObservationEnvelope,
  buildVisitTargetBelief,
  computeStaticFarmStateDigest,
  quoteFutureItemUnderScenario,
  recomputeVisitBeliefForVisitor,
  resolveRaidOutcomeDistribution,
} from '../model/observations.mjs'
import {
  applyExogenousArrivals,
  buildEventBuckets,
  deductRecipeLowStarFirst,
  expectedBombYield,
  expectedFishYieldPerCast,
  expectedMineYieldPerHit,
} from './resources.mjs'
import { computeValidUpperBound } from './bounds.mjs'
import { buildExecutablePlanSignature, computeCausalStochasticPrefix } from './compile-prefix.mjs'

function cloneInvSnap(snap) {
  const out = {}
  if (!snap) return out
  for (const k in snap) {
    if (Object.prototype.hasOwnProperty.call(snap, k)) {
      const r = snap[k]
      if (r) out[k] = [r[0] || 0, r[1] || 0, r[2] || 0]
    }
  }
  return out
}

/**
 * Collects all unclaimed daily goal actions (`k = 0..3`) plus the all-clear bonus (`k = 4`)
 * whenever all four daily goals are already claimed or become claimed inside the same batch.
 */
export function collectClaimableGoalActions(R, naturalDay, state) {
  if (!state || typeof R?.dailyGoals !== 'function') return []
  const goals = R.dailyGoals(naturalDay, state)
  const goalActs = []
  const readyOrClaimed = [false, false, false, false]
  for (let k = 0; k < 4; k++) {
    const alreadyClaimed = Boolean(state.cnt?.['goal' + k])
    if (alreadyClaimed) {
      readyOrClaimed[k] = true
      continue
    }
    if (goals[k] && Number(state.cnt?.[goals[k].id] || 0) >= goals[k].n) {
      goalActs.push({ a: 'goal', k })
      readyOrClaimed[k] = true
    }
  }
  if (readyOrClaimed.every(Boolean) && !state.cnt?.goal4) {
    goalActs.push({ a: 'goal', k: 4 })
  }
  return goalActs
}

/**
 * Dynamically discovers rule utility item IDs from `R` tables/initializers
 * with ZERO hardcoded item name strings anywhere in source code.
 */
export function discoverRuleUtilityTokens(adapter) {
  const { R, graph } = adapter
  const explosiveRecipe = (R.RECIPES || []).find((r) => !(Number(r.price) > 0))
  const explosiveId = explosiveRecipe?.id
    || Object.keys(R.SHOP || {}).find((id) => R.WORLD?.daily?.[id] != null)
    || null

  let feedId = null
  if (typeof R.newWorld === 'function') {
    const sample = R.newWorld(R.ISLE_LAUNCH || 0)
    for (const id of Object.keys(sample?.inv || {})) {
      if (!graph.cropsById.has(id)) {
        feedId = id
        break
      }
    }
  }

  let baitId = null
  for (const id of Object.keys(R.SHOP || {})) {
    if (id !== feedId && id !== explosiveId) {
      baitId = id
      break
    }
  }

  let snackId = null
  if (R.B12_SNACK && typeof R.b12Stock === 'function') {
    // Probe deterministic cargo across several days or inspect ITEM_NAME exclusions
    const knownCatalog = new Set([
      ...graph.cropsById.keys(),
      ...[...graph.animalsById.values()].map((a) => a.product),
      ...graph.fishById.keys(),
      ...graph.oresById.keys(),
      ...graph.recipesById.keys(),
      ...Object.keys(R.SHOP || {}),
      ...Object.keys(R.GUARD_ITEMS || {}),
      ...Object.keys(R.THIEF_ITEMS || {}),
    ])
    for (const id of Object.keys(R.ITEM_NAME || {})) {
      if (knownCatalog.has(id)) continue
      // Seed items correspond to `<prefix><cropId>` matching exact crop count
      const matchesCropSuffix = [...graph.cropsById.keys()].some((cid) => id !== cid && id.endsWith(cid))
      if (matchesCropSuffix) continue
      snackId = id
      break
    }
  }

  return { feedId, baitId, explosiveId, snackId }
}

/**
 * Exact Max-Weight Assignment for a single item's arrivals across buckets `0..L`
 * (including concave 3-tier natural-day crop capacities `[150, 250, Infinity]`).
 * Uses Successive Shortest Augmenting Path (SPFA) on a compact network (<= 35 nodes),
 * guaranteeing 100% global optimality across `q2/q1/q0` and `00:00` natural-day resets.
 */
const slotScheduleWeakCache = new WeakMap()
const globalSlotItemStructCache = new WeakMap()

function getSlotScheduleItemMeta(R, slots, itemId, needNatDayTable = false) {
  let root = slotScheduleWeakCache.get(slots)
  if (!root) {
    let maxAvailU = 0
    const natDays = []
    const natDayMap = new Map()
    const slotsByNatDay = []
    const slotNatDayIdx = new Int32Array(slots.length).fill(-1)
    for (let s = 0; s < slots.length; s++) {
      const sl = slots[s]
      if (!sl.allowSell) continue
      if (sl.availFromBucket > maxAvailU) maxAvailU = sl.availFromBucket
      let dIdx = natDayMap.get(sl.naturalDay)
      if (dIdx === undefined) {
        dIdx = natDays.length
        natDayMap.set(sl.naturalDay, dIdx)
        natDays.push(sl.naturalDay)
        slotsByNatDay.push([])
      }
      slotNatDayIdx[s] = dIdx
      slotsByNatDay[dIdx].push(s)
    }
    root = { maxAvailU, natDays, slotsByNatDay, slotNatDayIdx, byItem: new Map() }
    slotScheduleWeakCache.set(slots, root)
  }

  let itemMeta = root.byItem.get(itemId)
  if (!itemMeta) {
    const U = root.maxAvailU + 1
    let byR = globalSlotItemStructCache.get(R)
    if (!byR) {
      byR = new Map()
      globalSlotItemStructCache.set(R, byR)
    }
    let structMap = byR.get(itemId)
    if (!structMap) {
      structMap = new Map()
      byR.set(itemId, structMap)
    } else if (structMap.size > 512) {
      structMap.clear()
    }
    let schedKey = `${slots.length}:${U}`
    for (let s = 0; s < slots.length; s++) {
      const sl = slots[s]
      if (!sl.allowSell) continue
      schedKey += `|${s},${sl.availFromBucket},${sl.naturalDay},${Number(sl.prices?.[itemId] || 0)},${sl.disc * sl.netTaxFactor}`
    }
    itemMeta = structMap.get(schedKey)
    if (!itemMeta) {
      const bestGlobalSlotIdx = new Int32Array(U * 3).fill(-1)
      const bestGlobalUnitVal = new Float64Array(U * 3)
      const quals = [R.QUALITY?.[0] ?? 1, R.QUALITY?.[1] ?? 1, R.QUALITY?.[2] ?? 1]
      for (let s = 0; s < slots.length; s++) {
        const sl = slots[s]
        if (!sl.allowSell) continue
        const p = Number(sl.prices?.[itemId] || 0)
        if (!(p > 0)) continue
        const mult = sl.disc * sl.netTaxFactor
        const maxU = sl.availFromBucket
        for (let q = 0; q < 3; q++) {
          const unit = Math.round(p * quals[q]) * mult
          for (let u = 0; u <= maxU; u++) {
            const idx = u * 3 + q
            if (unit > bestGlobalUnitVal[idx] + 1e-9) {
              bestGlobalUnitVal[idx] = unit
              bestGlobalSlotIdx[idx] = s
            }
          }
        }
      }
      itemMeta = {
        bestGlobalSlotIdx,
        bestGlobalUnitVal,
        bestNdSlotIdx: null,
        flowRevCache: new Map(),
        flowFullCache: new Map(),
      }
      structMap.set(schedKey, itemMeta)
    }
    root.byItem.set(itemId, itemMeta)
  }

  if (needNatDayTable && !itemMeta.bestNdSlotIdx) {
    const D = root.natDays.length
    const U = root.maxAvailU + 1
    const bestNdSlotIdx = new Int32Array(D * U * 3).fill(-1)
    const bestNdUnitVal = new Float64Array(D * U * 3)
    const quals = [R.QUALITY?.[0] ?? 1, R.QUALITY?.[1] ?? 1, R.QUALITY?.[2] ?? 1]
    for (let dIdx = 0; dIdx < D; dIdx++) {
      const ndSlots = root.slotsByNatDay[dIdx]
      const dBase = dIdx * U * 3
      for (let k = 0; k < ndSlots.length; k++) {
        const s = ndSlots[k]
        const sl = slots[s]
        const p = Number(sl.prices?.[itemId] || 0)
        if (!(p > 0)) continue
        const mult = sl.disc * sl.netTaxFactor
        const maxU = sl.availFromBucket
        for (let q = 0; q < 3; q++) {
          const val = Math.round(p * quals[q]) * mult
          for (let u = 0; u <= maxU; u++) {
            const idx = dBase + u * 3 + q
            if (val > bestNdUnitVal[idx] + 1e-9) {
              bestNdUnitVal[idx] = val
              bestNdSlotIdx[idx] = s
            }
          }
        }
      }
    }
    itemMeta.bestNdSlotIdx = bestNdSlotIdx
  }

  return { root, itemMeta }
}

function solveExactItemSaleSchedule(adapter, {
  itemId,
  supplyByBucket = null, // Array< [n0, n1, n2] > of length L
  supplyTable = null,    // Optional Array< Record<itemId, [n0, n1, n2]> > to avoid intermediate `.map()`
  slots,                 // Array<{ slotIdx, bucketIdx, atSec, naturalDay, prices, isTerminal, disc }>
  initialNatDay,
  initialScCount,
  revenueOnly = false,
}) {
  const { R, graph } = adapter
  const isCrop = graph.cropsById.has(itemId)
  const L = supplyTable ? supplyTable.length : supplyByBucket.length

  if (!isCrop) {
    // Non-crops have no daily tier decay: O(1) lookup from precomputed `(slots, itemId)` table!
    const { root, itemMeta } = getSlotScheduleItemMeta(R, slots, itemId, false)
    const sellsBySlot = revenueOnly ? null : slots.map(() => [0, 0, 0])
    let totalWeightedRevenue = 0
    const uLim = Math.min(L, root.maxAvailU + 1)
    for (let u = 0; u < uLim; u++) {
      const row = supplyTable ? supplyTable[u]?.[itemId] : supplyByBucket[u]
      if (!row) continue
      const uBase = u * 3
      for (let q = 2; q >= 0; q--) {
        const cnt = Math.floor(Number(row[q] || 0))
        if (!(cnt > 0)) continue
        const bestSlotIdx = itemMeta.bestGlobalSlotIdx[uBase + q]
        if (bestSlotIdx >= 0) {
          if (sellsBySlot) sellsBySlot[bestSlotIdx][q] += cnt
          totalWeightedRevenue += cnt * itemMeta.bestGlobalUnitVal[uBase + q]
        }
      }
    }
    return { sellsBySlot, totalWeightedRevenue }
  }

  // Crop case: concave natural-day tiers [150 @ 1.0, 250 @ 0.85, inf @ 0.70]
  const uNodes = new Int32Array(L * 3)
  const qNodes = new Int32Array(L * 3)
  const cntNodes = new Int32Array(L * 3)
  let rawP = 0
  let totalSupply = 0
  for (let u = 0; u < L; u++) {
    const row = supplyTable ? supplyTable[u]?.[itemId] : supplyByBucket[u]
    if (!row) continue
    for (let q = 2; q >= 0; q--) {
      const cnt = Math.floor(Number(row[q] || 0))
      if (cnt > 0) {
        uNodes[rawP] = u
        qNodes[rawP] = q
        cntNodes[rawP] = cnt
        rawP++
        totalSupply += cnt
      }
    }
  }
  if (rawP === 0) {
    return { sellsBySlot: revenueOnly ? null : slots.map(() => [0, 0, 0]), totalWeightedRevenue: 0 }
  }

  const { root: baseRoot, itemMeta: baseItemMeta } = getSlotScheduleItemMeta(R, slots, itemId, false)
  const D = baseRoot.natDays.length
  if (D === 0) {
    return { sellsBySlot: revenueOnly ? null : slots.map(() => [0, 0, 0]), totalWeightedRevenue: 0 }
  }

  // Exact Tier-0 Non-Binding Fast Path (single-day AND multi-day unconstrained upper-bound feasibility):
  // Assigning every `(u, q)` to its unconstrained global best slot achieves a valid global upper bound on revenue;
  // if every natural day receiving > 0 units satisfies `sc0(d) + dayUsed[d] <= 150`, that assignment is 100% feasible
  // in Tier 0 (1.0x) and therefore guaranteed globally optimal!
  let tier0Feasible = initialScCount + totalSupply <= 150
  if (!tier0Feasible) {
    const dayUsed = new Int32Array(D)
    tier0Feasible = true
    for (let i = 0; i < rawP; i++) {
      const u = uNodes[i]
      if (u > baseRoot.maxAvailU) continue
      const bestSlotIdx = baseItemMeta.bestGlobalSlotIdx[u * 3 + qNodes[i]]
      if (bestSlotIdx >= 0) {
        const dIdx = baseRoot.slotNatDayIdx[bestSlotIdx]
        const nextUsed = dayUsed[dIdx] + cntNodes[i]
        dayUsed[dIdx] = nextUsed
        const sc0 = baseRoot.natDays[dIdx] === initialNatDay ? initialScCount : 0
        if (sc0 + nextUsed > 150) {
          tier0Feasible = false
          break
        }
      }
    }
  }

  if (tier0Feasible) {
    const sellsBySlot = revenueOnly ? null : slots.map(() => [0, 0, 0])
    let totalWeightedRevenue = 0
    for (let i = 0; i < rawP; i++) {
      const u = uNodes[i]
      if (u > baseRoot.maxAvailU) continue
      const q = qNodes[i]
      const cnt = cntNodes[i]
      const idx = u * 3 + q
      const bestSlotIdx = baseItemMeta.bestGlobalSlotIdx[idx]
      if (bestSlotIdx >= 0) {
        if (sellsBySlot) sellsBySlot[bestSlotIdx][q] += cnt
        totalWeightedRevenue += cnt * baseItemMeta.bestGlobalUnitVal[idx]
      }
    }
    return { sellsBySlot, totalWeightedRevenue }
  }

  const { root, itemMeta } = getSlotScheduleItemMeta(R, slots, itemId, true)
  const { natDays, maxAvailU } = root
  const U = maxAvailU + 1

  // Coalesce supply nodes `(u, q)` sharing identical `(q, bestNdSlotIdx[0..D-1])` (100% identical outgoing edge costs & slots!)
  const grpQ = new Int32Array(rawP)
  const grpRepU = new Int32Array(rawP)
  const grpCnt = new Int32Array(rawP)
  let P = 0
  for (let i = 0; i < rawP; i++) {
    const u = uNodes[i]
    if (u > maxAvailU) continue
    const q = qNodes[i]
    const cnt = cntNodes[i]
    let matchedG = -1
    for (let g = 0; g < P; g++) {
      if (grpQ[g] !== q) continue
      const uG = grpRepU[g]
      let sameVec = true
      for (let dIdx = 0; dIdx < D; dIdx++) {
        const base = dIdx * U * 3 + q
        if (itemMeta.bestNdSlotIdx[base + u * 3] !== itemMeta.bestNdSlotIdx[base + uG * 3]) {
          sameVec = false
          break
        }
      }
      if (sameVec) {
        matchedG = g
        break
      }
    }
    if (matchedG >= 0) {
      grpCnt[matchedG] += cnt
    } else {
      grpQ[P] = q
      grpRepU[P] = u
      grpCnt[P] = cnt
      P++
    }
  }

  if (P === 0) {
    return { sellsBySlot: revenueOnly ? null : slots.map(() => [0, 0, 0]), totalWeightedRevenue: 0 }
  }

  let flowKey = `${initialNatDay}:${initialScCount}`
  for (let i = 0; i < P; i++) {
    flowKey += `|${grpQ[i]},${grpRepU[i]},${grpCnt[i]}`
  }
  if (revenueOnly) {
    const revHit = itemMeta.flowRevCache.get(flowKey)
    if (revHit !== undefined) {
      return { sellsBySlot: null, totalWeightedRevenue: revHit }
    }
  } else {
    const fullHit = itemMeta.flowFullCache.get(flowKey)
    if (fullHit !== undefined) {
      return {
        sellsBySlot: fullHit.sellsBySlot.map((r) => [r[0], r[1], r[2]]),
        totalWeightedRevenue: fullHit.totalWeightedRevenue,
      }
    }
  }

  // Flat typed-array Min-Cost Max-Flow (costs = -gain; reverse edge index = `e ^ 1`)
  // Nodes: 0 = SRC, 1..P = coalesced supply groups, P+1..P+3*D = (ndIdx, tier), last = SNK
  const SRC = 0
  const SNK = 1 + P + 3 * D
  const N = SNK + 1
  const maxEdges = 2 * (2 * P + 3 * D + P * 3 * D)
  const head = new Int32Array(N).fill(-1)
  const edgeTo = new Int32Array(maxEdges)
  const edgeNext = new Int32Array(maxEdges)
  const edgeCap = new Int32Array(maxEdges)
  const edgeCost = new Float64Array(maxEdges)
  const edgeSlot = revenueOnly ? null : new Int32Array(maxEdges).fill(-1)
  const edgeQ = revenueOnly ? null : new Int32Array(maxEdges)
  let edgeCount = 0

  const addEdge = (from, to, cap, cost, slotIdx = -1, q = 0) => {
    const fIdx = edgeCount++
    edgeTo[fIdx] = to
    edgeCap[fIdx] = cap
    edgeCost[fIdx] = cost
    edgeNext[fIdx] = head[from]
    if (edgeSlot) {
      edgeSlot[fIdx] = slotIdx
      edgeQ[fIdx] = q
    }
    head[from] = fIdx

    const bIdx = edgeCount++
    edgeTo[bIdx] = from
    edgeCap[bIdx] = 0
    edgeCost[bIdx] = -cost
    edgeNext[bIdx] = head[to]
    head[to] = bIdx
  }

  for (let i = 0; i < P; i++) {
    const cnt = grpCnt[i]
    addEdge(SRC, 1 + i, cnt, 0)
    // Allow holding unsold with 0 value if all slots have 0 price
    addEdge(1 + i, SNK, cnt, 0, -1, grpQ[i])
  }

  const tierMults = [1.0, 0.85, 0.70]
  const maxTierByDay = new Int32Array(D)
  for (let dIdx = 0; dIdx < D; dIdx++) {
    const nd = natDays[dIdx]
    const sc0 = nd === initialNatDay ? initialScCount : 0
    const cap0 = Math.max(0, 150 - sc0)
    const cap1 = Math.max(0, 400 - Math.max(150, sc0))
    const maxReachableTier = totalSupply <= cap0 ? 0 : (totalSupply <= cap0 + cap1 ? 1 : 2)
    maxTierByDay[dIdx] = maxReachableTier
    if (cap0 > 0) addEdge(1 + P + dIdx * 3, SNK, cap0, 0)
    if (maxReachableTier >= 1 && cap1 > 0) addEdge(1 + P + dIdx * 3 + 1, SNK, cap1, 0)
    if (maxReachableTier >= 2 && totalSupply > 0) addEdge(1 + P + dIdx * 3 + 2, SNK, totalSupply, 0)
  }

  for (let i = 0; i < P; i++) {
    const u = grpRepU[i]
    const q = grpQ[i]
    const cnt = grpCnt[i]
    const qual = R.QUALITY?.[q] ?? 1
    for (let dIdx = 0; dIdx < D; dIdx++) {
      const bestSlotIdx = itemMeta.bestNdSlotIdx[dIdx * U * 3 + u * 3 + q]
      if (bestSlotIdx >= 0) {
        const sl = slots[bestSlotIdx]
        const rawUnit = Math.round(Number(sl.prices[itemId]) * qual)
        const baseFactor = rawUnit * sl.disc * sl.netTaxFactor
        const maxT = maxTierByDay[dIdx]
        for (let t = 0; t <= maxT; t++) {
          addEdge(1 + i, 1 + P + dIdx * 3 + t, cnt, -(baseFactor * tierMults[t]), bestSlotIdx, q)
        }
      }
    }
  }

  // SPFA Successive Shortest Path with O(1) ring-buffer queue over flat typed arrays
  let totalCost = 0
  const dist = new Float64Array(N)
  const parentNode = new Int32Array(N)
  const parentEdge = new Int32Array(N)
  const inQueue = new Uint8Array(N)
  const qCap = N + 1
  const ringQueue = new Int32Array(qCap)

  while (true) {
    dist.fill(Infinity)
    parentNode.fill(-1)
    parentEdge.fill(-1)
    inQueue.fill(0)
    dist[SRC] = 0
    let qHead = 0
    let qTail = 1
    ringQueue[0] = SRC
    inQueue[SRC] = 1

    while (qHead !== qTail) {
      const v = ringQueue[qHead]
      qHead = (qHead + 1) % qCap
      inQueue[v] = 0
      for (let e = head[v]; e >= 0; e = edgeNext[e]) {
        if (edgeCap[e] <= 0) continue
        const to = edgeTo[e]
        const ndist = dist[v] + edgeCost[e]
        if (ndist < dist[to] - 1e-9) {
          dist[to] = ndist
          parentNode[to] = v
          parentEdge[to] = e
          if (!inQueue[to]) {
            ringQueue[qTail] = to
            qTail = (qTail + 1) % qCap
            inQueue[to] = 1
          }
        }
      }
    }

    if (!Number.isFinite(dist[SNK])) break
    let push = 2147483647
    for (let cur = SNK; cur !== SRC; cur = parentNode[cur]) {
      const rem = edgeCap[parentEdge[cur]]
      if (rem < push) push = rem
    }
    if (!(push > 0)) break
    for (let cur = SNK; cur !== SRC; cur = parentNode[cur]) {
      const e = parentEdge[cur]
      edgeCap[e] -= push
      edgeCap[e ^ 1] += push
    }
    totalCost += push * dist[SNK]
  }

  let sellsBySlot = null
  if (!revenueOnly) {
    sellsBySlot = slots.map(() => [0, 0, 0])
    for (let i = 0; i < P; i++) {
      for (let e = head[1 + i]; e >= 0; e = edgeNext[e]) {
        if ((e & 1) === 0 && edgeSlot[e] >= 0) {
          const flowed = edgeCap[e ^ 1]
          if (flowed > 0) {
            sellsBySlot[edgeSlot[e]][edgeQ[e]] += flowed
          }
        }
      }
    }
  }

  const finalWeightedRev = -totalCost
  if (itemMeta.flowRevCache.size < 8192) {
    itemMeta.flowRevCache.set(flowKey, finalWeightedRev)
  }
  if (!revenueOnly && itemMeta.flowFullCache.size < 2048) {
    itemMeta.flowFullCache.set(flowKey, {
      sellsBySlot: sellsBySlot.map((r) => [r[0], r[1], r[2]]),
      totalWeightedRevenue: finalWeightedRev,
    })
  }

  return {
    sellsBySlot,
    totalWeightedRevenue: finalWeightedRev,
  }
}

/**
 * Builds canonical recipe & multi-step chain templates dynamically from `adapter.graph`.
 * Completely invariant to `R.RECIPES` permutation!
 */
function buildCanonicalCraftTemplates(adapter) {
  if (adapter._canonicalCraftTemplates) return adapter._canonicalCraftTemplates
  const { R, graph } = adapter
  const sellableRecipes = (R.RECIPES || []).filter((r) => Number(r.price) > 0)
  const templates = []

  // Canonical signature independent of R.RECIPES order
  const sigOf = (steps, rawInputs, outId) => {
    const inStr = Object.keys(rawInputs)
      .sort()
      .map((k) => `${k}:${rawInputs[k]}`)
      .join(',')
    return `${steps}|${inStr}->${outId}`
  }

  for (const r of sellableRecipes) {
    // 1. Direct single-step recipe (uses existing intermediate if already in inv)
    templates.push({
      kind: 'single',
      outId: r.id,
      actions: [{ id: r.id, n: 1 }],
      rawIn: { ...r.in },
      craftSlots: 1,
      signature: sigOf(1, r.in, r.id),
    })

    // 2. Expanded multi-step chain when any input is itself craftable (e.g. ingot -> crown)
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
      templates.push({
        kind: 'chain',
        outId: r.id,
        actions: [...upstreamActions, { id: r.id, n: 1 }],
        rawIn: expandedRawIn,
        craftSlots: totalSlots,
        signature: sigOf(totalSlots, expandedRawIn, r.id),
      })
    }
  }

  templates.sort((a, b) => a.signature.localeCompare(b.signature))
  adapter._canonicalCraftTemplates = templates
  return templates
}

function cloneSupplyTable(supplyByBucket) {
  return supplyByBucket.map((bucketMap) => {
    const m = {}
    for (const [id, row] of Object.entries(bucketMap)) {
      m[id] = [row[0] || 0, row[1] || 0, row[2] || 0]
    }
    return m
  })
}

/**
 * Deducts `need` units of `id` low-star-first (`q0 -> q1 -> q2`) from cumulative supply available up to `bucketIdx`
 * (preferring earliest available buckets so conservation holds across all prefixes `0..u`).
 * Uses copy-on-write per touched `(bucket, itemId)` and zero-allocation pre-check when infeasible.
 */
function deductFromPrefixSupply(supplyByBucket, bucketIdx, rawIn, count = 1, outId = null) {
  const rawEntries = Object.entries(rawIn)
  for (let idx = 0; idx < rawEntries.length; idx++) {
    const [inId, perUnit] = rawEntries[idx]
    const need = perUnit * count
    let availTotal = 0
    for (let u = 0; u <= bucketIdx; u++) {
      const r = supplyByBucket[u][inId]
      if (r) availTotal += (r[0] || 0) + (r[1] || 0) + (r[2] || 0)
    }
    if (availTotal < need) return null
  }

  const next = supplyByBucket.slice()
  const bucketCopied = new Uint8Array(bucketIdx + 1)
  const ensureMutableBucket = (u) => {
    if (!bucketCopied[u]) {
      next[u] = { ...next[u] }
      bucketCopied[u] = 1
    }
    return next[u]
  }

  for (let idx = 0; idx < rawEntries.length; idx++) {
    const [inId, perUnit] = rawEntries[idx]
    let need = perUnit * count
    // Apply low-star-first across the pooled inventory at bucketIdx:
    // At execution time in bucketIdx, all unsold stock from 0..bucketIdx sits in `s.inv[inId]`,
    // and `applyActions` deducts `q=0` first, then `q=1`, then `q=2`!
    for (let q = 0; q < 3 && need > 0; q++) {
      for (let u = 0; u <= bucketIdx && need > 0; u++) {
        const r = next[u][inId]
        if (!r || !(r[q] > 0)) continue
        const take = Math.min(need, r[q])
        const bMap = ensureMutableBucket(u)
        if (bMap[inId] === supplyByBucket[u][inId]) {
          bMap[inId] = [r[0] || 0, r[1] || 0, r[2] || 0]
        }
        bMap[inId][q] -= take
        need -= take
      }
    }
    if (need > 0) return null
  }

  if (outId != null) {
    const bMap = ensureMutableBucket(bucketIdx)
    const prevOut = bMap[outId]
    if (!prevOut) {
      bMap[outId] = [count, 0, 0]
    } else if (prevOut === supplyByBucket[bucketIdx][outId]) {
      bMap[outId] = [(prevOut[0] || 0) + count, prevOut[1] || 0, prevOut[2] || 0]
    } else {
      prevOut[0] += count
    }
  }

  return next
}

/**
 * Evaluates total portfolio sale value across `slots` for all items in `supplyByBucket`.
 */
function evaluateSupplyPortfolio(adapter, {
  supplyByBucket,
  slots,
  initialNatDay,
  initialCnt,
  revenueOnly = false,
}) {
  const itemSet = new Set()
  for (const bm of supplyByBucket) {
    for (const id of Object.keys(bm)) itemSet.add(id)
  }
  const perItem = new Map()
  let totalValue = 0
  for (const id of itemSet) {
    if (!(Number(adapter.R.BASE_PRICE?.[id] || 0) > 0)) continue
    const initSc = Number(initialCnt?.['sc_' + id] || 0)
    const sched = solveExactItemSaleSchedule(adapter, {
      itemId: id,
      supplyTable: supplyByBucket,
      slots,
      initialNatDay,
      initialScCount: initSc,
      revenueOnly,
    })
    perItem.set(id, sched)
    totalValue += sched.totalWeightedRevenue
  }
  return { totalValue, perItem }
}

function evaluateSupplyPortfolioIncremental(adapter, {
  baseEval,
  supplyByBucket,
  changedItemIds,
  slots,
  initialNatDay,
  initialCnt,
  revenueOnly = false,
}) {
  const nextPerItem = new Map(baseEval.perItem)
  let nextTotal = baseEval.totalValue
  const L = supplyByBucket.length

  for (const id of changedItemIds) {
    if (!(Number(adapter.R.BASE_PRICE?.[id] || 0) > 0)) continue
    const oldSched = nextPerItem.get(id)
    if (oldSched) nextTotal -= oldSched.totalWeightedRevenue
    let hasAny = false
    for (let u = 0; u < L; u++) {
      const r = supplyByBucket[u]?.[id]
      if (r && (r[0] || 0) + (r[1] || 0) + (r[2] || 0) > 0) {
        hasAny = true
        break
      }
    }
    if (!hasAny) {
      nextPerItem.delete(id)
      continue
    }
    const initSc = Number(initialCnt?.['sc_' + id] || 0)
    const sched = solveExactItemSaleSchedule(adapter, {
      itemId: id,
      supplyTable: supplyByBucket,
      slots,
      initialNatDay,
      initialScCount: initSc,
      revenueOnly,
    })
    nextPerItem.set(id, sched)
    nextTotal += sched.totalWeightedRevenue
  }

  return { totalValue: nextTotal, perItem: nextPerItem }
}

function evaluateSupplyPortfolioValueOnly(adapter, {
  baseEval,
  supplyByBucket,
  changedItemIds,
  slots,
  initialNatDay,
  initialCnt,
}) {
  let nextTotal = baseEval.totalValue
  const L = supplyByBucket.length

  for (let idx = 0; idx < changedItemIds.length; idx++) {
    const id = changedItemIds[idx]
    if (!(Number(adapter.R.BASE_PRICE?.[id] || 0) > 0)) continue
    const oldSched = baseEval.perItem.get(id)
    if (oldSched) nextTotal -= oldSched.totalWeightedRevenue
    let hasAny = false
    for (let u = 0; u < L; u++) {
      const r = supplyByBucket[u]?.[id]
      if (r && (r[0] || 0) + (r[1] || 0) + (r[2] || 0) > 0) {
        hasAny = true
        break
      }
    }
    if (!hasAny) continue
    const initSc = Number(initialCnt?.['sc_' + id] || 0)
    const sched = solveExactItemSaleSchedule(adapter, {
      itemId: id,
      supplyTable: supplyByBucket,
      slots,
      initialNatDay,
      initialScCount: initSc,
      revenueOnly: true,
    })
    nextTotal += sched.totalWeightedRevenue
  }

  return nextTotal
}

/**
 * Joint Multi-Bucket Craft + Sell Optimizer (`solveJointCraftAndSell`):
 * Allocates single & chained recipes across all buckets `0..L-1` sharing `isleIndex` craft caps
 * and bucket stamina budgets, together with exact multi-bucket tier-aware sales!
 *
 * Uses exact memoized branch-and-bound when remaining craft/material space is compact,
 * and marginal-gain + 2-for-1 swap polish on large 80-slot live states.
 */
function solveJointCraftAndSell(adapter, {
  initialSupplyByBucket,
  buckets,
  slots,
  initialNatDay,
  initialCnt,
  craftCapByIsle,
  enCapByBucket,
  staminaShadowCost = 0,
  allowCraft = true,
  maxCraftHoldIsleDays = null,
  baseEvalOverride = null,
  onlyTouchItemIds = null,
  revenueOnly = false,
  isPastDeadlineFn = null,
}) {
  const L = buckets.length
  const baseEval = baseEvalOverride || evaluateSupplyPortfolio(adapter, {
    supplyByBucket: initialSupplyByBucket,
    slots,
    initialNatDay,
    initialCnt,
    revenueOnly,
  })

  if (!allowCraft || L === 0) {
    return {
      craftsByBucket: buckets.map(() => []),
      executionOrderMoves: [],
      supplyAfterCrafts: initialSupplyByBucket,
      baseRawPortfolio: baseEval,
      salePortfolio: baseEval,
      netPortfolioScore: baseEval.totalValue,
    }
  }

  const templates = buildCanonicalCraftTemplates(adapter)
  const craftEnCost = adapter.R.WORLD?.cost?.craft ?? 1

  // Filter templates that could ever be feasible with total / prefix horizon supply
  const totalRaw = {}
  for (let u = 0; u < L; u++) {
    for (const [id, r] of Object.entries(initialSupplyByBucket[u])) {
      totalRaw[id] = (totalRaw[id] || 0) + (r[0] || 0) + (r[1] || 0) + (r[2] || 0)
    }
  }
  const prefixRaw = {}
  const baseOriginOffset = buckets[0]?.isleDayOffset ?? 0
  const candidateMoves = [] // { moveId, tpl, u, isleIdx }
  for (let u = 0; u < L; u++) {
    for (const [id, r] of Object.entries(initialSupplyByBucket[u])) {
      prefixRaw[id] = (prefixRaw[id] || 0) + (r[0] || 0) + (r[1] || 0) + (r[2] || 0)
    }
    const isleIdx = buckets[u].isleIndex
    if ((craftCapByIsle.get(isleIdx) || 0) <= 0 || (enCapByBucket[u] || 0) < craftEnCost) continue
    for (const tpl of templates) {
      if (onlyTouchItemIds && !onlyTouchItemIds.has(tpl.outId) && !Object.keys(tpl.rawIn).some((inId) => onlyTouchItemIds.has(inId))) {
        continue
      }
      if (tpl.craftSlots > (craftCapByIsle.get(isleIdx) || 0)) continue
      if (tpl.craftSlots * craftEnCost > (enCapByBucket[u] || 0)) continue
      const possible = Object.entries(tpl.rawIn).every(([inId, need]) => {
        const capAtU = adapter.graph.recipesById.has(inId) ? (totalRaw[inId] || 0) : (prefixRaw[inId] || 0)
        return capAtU >= need
      })
      if (!possible) continue
      const hasLocalArrival = u > 0 && Object.keys(tpl.rawIn).some((inId) => {
        const r = initialSupplyByBucket[u]?.[inId]
        return r && (r[0] || 0) + (r[1] || 0) + (r[2] || 0) > 0
      })
      if (
        Number.isFinite(maxCraftHoldIsleDays) &&
        !hasLocalArrival &&
        (buckets[u].isleDayOffset - baseOriginOffset) > maxCraftHoldIsleDays
      ) {
        continue
      }
      const isDistinctTiming = u === 0
        || buckets[u].isleIndex !== buckets[u - 1].isleIndex
        || enCapByBucket[u] > enCapByBucket[u - 1]
        || hasLocalArrival
      if (isDistinctTiming) {
        candidateMoves.push({
          key: `${u}:${tpl.signature}`,
          u,
          isleIdx,
          tpl,
          changedIds: [tpl.outId, ...Object.keys(tpl.rawIn)],
        })
      }
    }
  }

  if (candidateMoves.length === 0) {
    return {
      craftsByBucket: buckets.map(() => []),
      executionOrderMoves: [],
      supplyAfterCrafts: initialSupplyByBucket,
      baseRawPortfolio: baseEval,
      salePortfolio: baseEval,
      netPortfolioScore: baseEval.totalValue,
    }
  }

  // Bound maximum total craft steps possible simultaneously across all active isles & raw inputs
  const MAX_EXACT_NODES = 600
  const maxMoveLimByIsle = new Map()
  const minNeedByRawIn = new Map()
  for (const mv of candidateMoves) {
    const lim = Math.min(
      Math.floor((craftCapByIsle.get(mv.isleIdx) || 0) / mv.tpl.craftSlots),
      ...Object.entries(mv.tpl.rawIn).map(([inId, need]) => Math.floor((totalRaw[inId] || 0) / need))
    )
    if (lim > 0) {
      maxMoveLimByIsle.set(mv.isleIdx, (maxMoveLimByIsle.get(mv.isleIdx) || 0) + lim)
      for (const [inId, need] of Object.entries(mv.tpl.rawIn)) {
        const prev = minNeedByRawIn.get(inId)
        if (prev == null || need < prev) minNeedByRawIn.set(inId, need)
      }
    }
  }
  let totalIsleCraftBound = 0
  for (const [iIdx, sumLim] of maxMoveLimByIsle.entries()) {
    totalIsleCraftBound += Math.min(craftCapByIsle.get(iIdx) || 0, sumLim)
  }
  let totalRawCraftBound = 0
  for (const [inId, minNeed] of minNeedByRawIn.entries()) {
    totalRawCraftBound += Math.floor((totalRaw[inId] || 0) / minNeed)
  }
  const maxTotalCraftSteps = Math.min(totalIsleCraftBound, totalRawCraftBound)
  let exactTreeBound = 1
  if (maxTotalCraftSteps > 0 && candidateMoves.length > 0) {
    const M = candidateMoves.length
    for (let d = 1; d <= maxTotalCraftSteps; d++) {
      exactTreeBound = Math.floor((exactTreeBound * (M + d)) / d)
      if (exactTreeBound > MAX_EXACT_NODES) break
    }
  }

  const applyMoveOnce = (supply, mv, count = 1) =>
    deductFromPrefixSupply(supply, mv.u, mv.tpl.rawIn, count, mv.tpl.outId)

  // Exact DFS with canonical non-decreasing move index when full search tree fits within MAX_EXACT_NODES
  let dfsFallbackCandidate = null
  if (exactTreeBound <= MAX_EXACT_NODES) {
    let bestScore = baseEval.totalValue
    let bestSupply = initialSupplyByBucket
    let bestEval = baseEval
    let bestCounts = new Int32Array(candidateMoves.length)
    let visitedNodes = 0
    let dfsTruncated = false

    const remCraft = new Map(craftCapByIsle)
    const remEn = Float64Array.from(enCapByBucket)
    const curCounts = new Int32Array(candidateMoves.length)

    const dfs = (startIdx, curSupply, curEval, spentStaminaCost) => {
      if (++visitedNodes > MAX_EXACT_NODES || ((visitedNodes & 63) === 0 && isPastDeadlineFn?.())) {
        dfsTruncated = true
        return
      }
      const score = curEval.totalValue - spentStaminaCost
      if (score > bestScore + 1e-6) {
        bestScore = score
        bestSupply = curSupply
        bestEval = curEval
        bestCounts = Int32Array.from(curCounts)
      }

      for (let i = startIdx; i < candidateMoves.length; i++) {
        const mv = candidateMoves[i]
        const slotsNeed = mv.tpl.craftSlots
        const enNeed = slotsNeed * craftEnCost
        if ((remCraft.get(mv.isleIdx) || 0) < slotsNeed) continue
        // Per-isle prefix stamina constraint: spending enNeed at mv.u reduces stamina within mv.isleIdx
        let enOk = true
        for (let fb = mv.u; fb < L && buckets[fb].isleIndex === mv.isleIdx; fb++) {
          if (remEn[fb] < enNeed) { enOk = false; break }
        }
        if (!enOk) continue

        const nextSup = applyMoveOnce(curSupply, mv, 1)
        if (!nextSup) continue
        const nextEval = evaluateSupplyPortfolioIncremental(adapter, {
          baseEval: curEval,
          supplyByBucket: nextSup,
          changedItemIds: mv.changedIds,
          slots,
          initialNatDay,
          initialCnt,
          revenueOnly,
        })

        remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) - slotsNeed)
        for (let fb = mv.u; fb < L && buckets[fb].isleIndex === mv.isleIdx; fb++) remEn[fb] -= enNeed
        curCounts[i]++

        dfs(i, nextSup, nextEval, spentStaminaCost + enNeed * staminaShadowCost)
        if (dfsTruncated) {
          curCounts[i]--
          for (let fb = mv.u; fb < L && buckets[fb].isleIndex === mv.isleIdx; fb++) remEn[fb] += enNeed
          remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) + slotsNeed)
          return
        }

        curCounts[i]--
        for (let fb = mv.u; fb < L && buckets[fb].isleIndex === mv.isleIdx; fb++) remEn[fb] += enNeed
        remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) + slotsNeed)
      }
    }

    dfs(0, initialSupplyByBucket, baseEval, 0)

    const craftsByBucket = buckets.map(() => [])
    const executionOrderMoves = []
    for (let i = 0; i < candidateMoves.length; i++) {
      const cnt = bestCounts[i]
      if (cnt > 0) {
        const mv = candidateMoves[i]
        executionOrderMoves.push({ u: mv.u, isleIdx: mv.isleIdx, tpl: mv.tpl, count: cnt, changedIds: mv.changedIds })
        for (const step of mv.tpl.actions) {
          craftsByBucket[mv.u].push({ a: 'craft', id: step.id, n: step.n * cnt })
        }
      }
    }
    const dfsResult = {
      craftsByBucket: craftsByBucket.map(mergeCraftActionsPreserveTopo),
      executionOrderMoves,
      supplyAfterCrafts: bestSupply,
      baseRawPortfolio: baseEval,
      salePortfolio: bestEval,
      netPortfolioScore: bestScore,
    }
    if (!dfsTruncated) return dfsResult
    dfsFallbackCandidate = dfsResult
  }

  // Large-scale case: iterative highest marginal gain per craft slot with exact separable per-item cache
  let curSupply = cloneSupplyTable(initialSupplyByBucket)
  let curEval = baseEval
  let curSpentStaminaCost = 0
  const remCraft = new Map(craftCapByIsle)
  const remEn = Float64Array.from(enCapByBucket)
  const chosenCounts = new Int32Array(candidateMoves.length)
  const executionOrderMoves = []
  // Cache `{ desiredChunk, actualChunk, ratio, feasible }` for moves whose `changedIds` were not touched!
  const moveCache = new Array(candidateMoves.length).fill(null)
  const moveMaxChunkCap = new Int32Array(candidateMoves.length).fill(16)

  for (let guard = 0; guard < 240; guard++) {
    if (guard > 0 && isPastDeadlineFn?.()) break
    let bestIdx = -1
    let bestRatio = 0
    let bestChunk = 1

    for (let i = 0; i < candidateMoves.length; i++) {
      const mv = candidateMoves[i]
      const slotsNeed = mv.tpl.craftSlots
      const enNeed = slotsNeed * craftEnCost
      const capLeft = Math.floor((remCraft.get(mv.isleIdx) || 0) / slotsNeed)
      if (capLeft <= 0) continue
      let maxEnMult = capLeft
      for (let fb = mv.u; fb < L && buckets[fb].isleIndex === mv.isleIdx; fb++) {
        maxEnMult = Math.min(maxEnMult, Math.floor(remEn[fb] / enNeed))
      }
      if (maxEnMult <= 0) continue

      const rawDesiredChunk = maxEnMult >= 32 ? 16 : (maxEnMult >= 8 ? 4 : 1)
      const desiredChunk = Math.min(rawDesiredChunk, moveMaxChunkCap[i])
      let cached = moveCache[i]
      if (!cached || cached.desiredChunk !== desiredChunk) {
        let actualChunk = desiredChunk
        let nextSup = applyMoveOnce(curSupply, mv, actualChunk)
        if (!nextSup && actualChunk > 4) {
          actualChunk = 4
          nextSup = applyMoveOnce(curSupply, mv, 4)
        }
        if (!nextSup && actualChunk > 1) {
          actualChunk = 1
          nextSup = applyMoveOnce(curSupply, mv, 1)
        }
        if (!nextSup) {
          cached = { desiredChunk, feasible: false, actualChunk: 0, ratio: -Infinity }
        } else {
          const evTotal = evaluateSupplyPortfolioValueOnly(adapter, {
            baseEval: curEval,
            supplyByBucket: nextSup,
            changedItemIds: mv.changedIds,
            slots,
            initialNatDay,
            initialCnt,
          })
          const delta = (evTotal - curEval.totalValue) - (actualChunk * enNeed * staminaShadowCost)
          const ratio = delta / (actualChunk * slotsNeed)
          cached = { desiredChunk, feasible: true, actualChunk, ratio }
        }
        moveCache[i] = cached
      }

      if (cached.feasible && cached.ratio > bestRatio + 1e-6) {
        bestRatio = cached.ratio
        bestIdx = i
        bestChunk = cached.actualChunk
      }
    }

    if (bestIdx < 0) break
    const mv = candidateMoves[bestIdx]
    const bestNextSup = applyMoveOnce(curSupply, mv, bestChunk)
    if (!bestNextSup) {
      moveCache[bestIdx] = { desiredChunk: 1, feasible: false, actualChunk: 0, ratio: -Infinity }
      continue
    }
    const bestNextEval = evaluateSupplyPortfolioIncremental(adapter, {
      baseEval: curEval,
      supplyByBucket: bestNextSup,
      changedItemIds: mv.changedIds,
      slots,
      initialNatDay,
      initialCnt,
      revenueOnly,
    })
    if (bestChunk > 1) {
      const prevSup = applyMoveOnce(curSupply, mv, bestChunk - 1)
      if (prevSup) {
        const evPrevTotal = evaluateSupplyPortfolioValueOnly(adapter, {
          baseEval: curEval,
          supplyByBucket: prevSup,
          changedItemIds: mv.changedIds,
          slots,
          initialNatDay,
          initialCnt,
        })
        const enNeedSingle = mv.tpl.craftSlots * craftEnCost
        if ((bestNextEval.totalValue - evPrevTotal) - enNeedSingle * staminaShadowCost <= 1e-6) {
          const nextCap = bestChunk > 4 ? 4 : 1
          moveMaxChunkCap[bestIdx] = nextCap
          moveCache[bestIdx] = null
          continue
        }
      }
    }
    const slotsUsed = mv.tpl.craftSlots * bestChunk
    const enUsed = slotsUsed * craftEnCost
    remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) - slotsUsed)
    for (let fb = mv.u; fb < L && buckets[fb].isleIndex === mv.isleIdx; fb++) remEn[fb] -= enUsed
    chosenCounts[bestIdx] += bestChunk
    const lastExec = executionOrderMoves[executionOrderMoves.length - 1]
    if (lastExec && lastExec.u === mv.u && lastExec.tpl === mv.tpl) {
      lastExec.count += bestChunk
    } else {
      executionOrderMoves.push({ u: mv.u, isleIdx: mv.isleIdx, tpl: mv.tpl, count: bestChunk, changedIds: mv.changedIds })
    }
    curSupply = bestNextSup
    curEval = bestNextEval
    curSpentStaminaCost += enUsed * staminaShadowCost

    // Invalidate ONLY moves sharing at least one item ID in `mv.changedIds`!
    const touchedSet = new Set(mv.changedIds)
    for (let j = 0; j < candidateMoves.length; j++) {
      if (!moveCache[j]) continue
      const cm = candidateMoves[j]
      for (let k = 0; k < cm.changedIds.length; k++) {
        if (touchedSet.has(cm.changedIds[k])) {
          moveCache[j] = null
          break
        }
      }
    }
  }

  const craftsByBucket = buckets.map(() => [])
  for (let i = 0; i < candidateMoves.length; i++) {
    const cnt = chosenCounts[i]
    if (cnt > 0) {
      const mv = candidateMoves[i]
      for (const step of mv.tpl.actions) {
        craftsByBucket[mv.u].push({ a: 'craft', id: step.id, n: step.n * cnt })
      }
    }
  }

  const iterScore = curEval.totalValue - curSpentStaminaCost
  if (dfsFallbackCandidate && dfsFallbackCandidate.netPortfolioScore > iterScore + 1e-6) {
    return dfsFallbackCandidate
  }

  return {
    craftsByBucket: craftsByBucket.map(mergeCraftActionsPreserveTopo),
    executionOrderMoves,
    supplyAfterCrafts: curSupply,
    baseRawPortfolio: baseEval,
    salePortfolio: curEval,
    netPortfolioScore: iterScore,
  }
}

function mergeCraftActionsPreserveTopo(list) {
  // Merge identical consecutive/compatible craft IDs while respecting max n=20 per craft action in applyActions!
  const out = []
  for (const act of list) {
    let rem = Math.floor(Number(act.n || 0))
    while (rem > 0) {
      const prev = out[out.length - 1]
      if (prev && prev.a === 'craft' && prev.id === act.id && prev.n < 20) {
        const add = Math.min(20 - prev.n, rem)
        prev.n += add
        rem -= add
      } else {
        const chunk = Math.min(20, rem)
        out.push({ a: 'craft', id: act.id, n: chunk })
        rem -= chunk
      }
    }
  }
  return out
}

/**
 * Evaluates best seasonal crop to plant on an empty plot `plotIdx` at `atSec`
 * using the unified `adapter.simulateCropLifecycleFromPlant` & `adapter.nextSeasonBoundary`
 * physical truth (`pet-world-rules.js:411,522`), downstream multi-season marginal item values,
 * and Renewal NPV Rate (`net / occupiedSec`).
 */
function selectBestCropToPlant(adapter, {
  state,
  clockStart = adapter.clockStart,
  plotIdx,
  atSec,
  tEnd,
  marginalItemValueFn,
  staminaPointCost = 0,
  enforceHorizonCutoff = false,
}) {
  const { R } = adapter
  const isSpr = R.sprinkled(state, plotIdx)

  const evalCropAt = (crop, startSec, cutoff) => {
    const skel = adapter.simulateCropLifecycleFromPlant(crop, {
      startSec,
      isSprinkled: isSpr,
      clockStart,
      cutoffEndSec: cutoff ? Math.floor(Number(tEnd || 0)) : -1,
      dryManualWaterStages: 2,
    })
    if (!skel) return null
    let totalExpectedRevenue = 0
    for (let k = 0; k < skel.harvests.length; k++) {
      const hv = skel.harvests[k]
      const eq = hv.expectedByQuality
      totalExpectedRevenue +=
        eq[0] * marginalItemValueFn(crop.id, 0, hv.matureAt) +
        eq[1] * marginalItemValueFn(crop.id, 1, hv.matureAt) +
        eq[2] * marginalItemValueFn(crop.id, 2, hv.matureAt)
    }
    const freeSeedAvail = startSec === atSec && adapter.availableInv(state, `sd_${crop.id}`, 0) > 0
    const seedCashCost = freeSeedAvail ? 0 : crop.seed
    const net = totalExpectedRevenue - seedCashCost - skel.totalStaminaSpent * staminaPointCost
    return {
      net,
      occupiedSec: skel.occupiedSec,
      endSec: skel.endSec,
      totalExpectedUnits: skel.totalExpectedUnits,
      rawRatePerSec: net / skel.occupiedSec,
    }
  }

  const nextSeasonBoundarySec = !enforceHorizonCutoff
    ? adapter.nextSeasonBoundary(atSec, clockStart)
    : -1
  const evaluated = []
  let hasCrossSeasonSpill = false
  for (const crop of R.CROPS || []) {
    const res = evalCropAt(crop, atSec, enforceHorizonCutoff)
    if (!res || !(res.net > 1e-6)) continue
    evaluated.push({ crop, res })
    if (nextSeasonBoundarySec > atSec && res.endSec > nextSeasonBoundarySec) {
      hasCrossSeasonSpill = true
    }
  }

  let rNextSeason = 0
  if (hasCrossSeasonSpill) {
    for (const futCrop of R.CROPS || []) {
      const resNext = evalCropAt(futCrop, nextSeasonBoundarySec, false)
      if (resNext && resNext.rawRatePerSec > rNextSeason) {
        rNextSeason = resNext.rawRatePerSec
      }
    }
  }

  let bestCrop = null
  let bestNet = 0
  let bestScore = 0
  let bestRawRate = 0
  let bestOccupiedSec = 0
  let bestTotalUnits = 0

  for (const { crop, res } of evaluated) {
    let score = enforceHorizonCutoff ? res.net : res.rawRatePerSec
    if (hasCrossSeasonSpill && rNextSeason > 0 && res.endSec > nextSeasonBoundarySec) {
      const spillNextSec = res.endSec - nextSeasonBoundarySec
      const surplusVsWait = res.net - spillNextSec * rNextSeason
      if (!(surplusVsWait > 1e-6)) continue
      const preBoundaryWindowSec = Math.min(res.occupiedSec, Math.max(60, nextSeasonBoundarySec - atSec))
      score = surplusVsWait / preBoundaryWindowSec
    }
    if (score > bestScore + 1e-9) {
      bestScore = score
      bestNet = res.net
      bestRawRate = res.rawRatePerSec
      bestCrop = crop
      bestOccupiedSec = res.occupiedSec
      bestTotalUnits = res.totalExpectedUnits
    }
  }

  return bestCrop
    ? {
        crop: bestCrop,
        expectedNetGain: bestNet,
        netPresentValue: bestNet,
        occupiedSec: bestOccupiedSec,
        totalExpectedUnits: bestTotalUnits,
        ratePerSec: bestRawRate,
        netRatePerSec: bestRawRate,
      }
    : null
}

/**
 * Enumerates mechanically legal, affordable single CapEx actions at `world` within `constraints.capexTargets`
 * (zero hardcoded valuation constants; candidates are scored purely via counterfactual trajectory simulation).
 */
function enumerateLegalCapexCandidates(adapter, world, constraints) {
  if (!constraints?.allowCapex) return []
  const { R } = adapter
  const s = world.state || {}
  const targets = constraints.capexTargets || {}
  const freeCash = Math.max(0, Number(world.coins || 0) - Number(constraints.cashReserveFloor || 0))
  const candidates = []

  const maxPlots = Math.min(R.WORLD.plotsMax, targets.plotsMax ?? R.WORLD.plotsMax)
  if ((s.plotN || 0) < maxPlots) {
    const price = R.WORLD.plotPrice((s.plotN || 0) + 1)
    if (price <= freeCash) candidates.push({ actions: [{ a: 'expand', k: 'plot' }], price })
  }

  const maxTraps = Math.min(R.WORLD.trapMax, targets.trapsMax ?? R.WORLD.trapMax)
  if ((s.traps?.length || 0) < maxTraps) {
    const price = R.WORLD.trapPrice((s.traps?.length || 0) + 1)
    if (price <= freeCash) candidates.push({ actions: [{ a: 'buyTrap' }], price })
  }

  if ((s.barn?.length || 0) < (s.barnN || 0)) {
    for (const a of R.ANIMALS || []) {
      if (a.price <= freeCash) {
        candidates.push({ actions: [{ a: 'buyAnimal', k: a.id }], price: a.price })
      }
    }
  }

  for (const tool of ['spr', 'pick', 'rod', 'house']) {
    const maxLv = tool === 'house'
      ? (targets.houseMax ?? 0)
      : (targets.toolsMax?.[tool] ?? 0)
    const curLv = Number(s.tools?.[tool] || 0)
    if (curLv >= maxLv) continue
    const price = R.upgradePrice(s, tool)
    if (price != null && price <= freeCash) {
      candidates.push({ actions: [{ a: 'upgrade', k: tool }], price })
    }
  }

  return candidates
}

export class SolverDeadlineError extends Error {
  constructor(message = 'Solver deadline exceeded') {
    super(message)
    this.name = 'SolverDeadlineError'
    this.code = 'SOLVER_DEADLINE_EXCEEDED'
  }
}

/**
 * Selects CapEx actions strictly by counterfactual rule-trajectory delta (`J(afterCapex) - J(withoutCapex) > 0`)
 * over `maxCapexPaybackSec` with ZERO magic valuation constants!
 */
function selectCapexByTrajectoryDelta(adapter, {
  world0,
  constraints,
  objectiveCfg,
  allowedSet,
  utilityTokens,
  makePricesFnForScenario0,
  baseSoldByIsle,
  scenarioSupplyFactor,
  maxCraftHoldIsleDays = 3,
  isPastDeadlineFn = null,
}) {
  if (!constraints?.allowCapex || !allowedSet.has('capex')) return []
  if (isPastDeadlineFn?.()) return []
  const initialCands = enumerateLegalCapexCandidates(adapter, world0, constraints)
  if (initialCands.length === 0) return []

  const paybackSec = Math.max(
    objectiveCfg.horizonSec || 3600,
    Math.min(72 * 3600, Number(constraints.maxCapexPaybackSec || 72 * 3600))
  )
  const capexObjCfg = buildObjectiveConfig({
    ...objectiveCfg,
    horizonSec: paybackSec,
    continuationIsleDays: 0,
  })
  const innerAllowed = new Set([...allowedSet].filter((a) => a !== 'capex' && a !== 'visit'))

  const evalRolloutMean = (startW) => {
    const tl = buildEventBuckets(adapter, startW, {
      horizonSec: paybackSec,
      maxBuckets: 16,
    })
    const initDelta = Number(startW.coins || 0) - Number(world0.coins || 0)
    const runWithStream = (streamIdx) => optimizeAndSimulateSequence(adapter, {
      startWorld: startW,
      initialWorldForObjective: world0,
      seqBuckets: tl.buckets,
      pricesForBucketFn: makePricesFnForScenario0,
      objectiveCfg: capexObjCfg,
      constraints: { ...constraints, allowCapex: false },
      allowedSet: innerAllowed,
      utilityTokens,
      initialSoldByIsle: baseSoldByIsle,
      scenarioSupplyFactor,
      maxCraftHoldIsleDays,
      prngFactory: () => adapter.makeSampleStreamPrng(streamIdx, world0.now),
      initialCashEvents: initDelta !== 0 ? [{ atSec: world0.now, netCashDelta: initDelta }] : [],
    })
    const res0 = runWithStream(0)
    const hasStoch = (res0.bucketActions || []).some((ba) => (ba || []).some((a) => adapter.isStochasticAction(a)))
    if (!hasStoch) return res0.objectiveEval.totalObjectiveValue
    let sumVal = res0.objectiveEval.totalObjectiveValue
    let count = 1
    const K = 4
    for (let m = 1; m < K; m++) {
      if (isPastDeadlineFn?.()) break
      sumVal += runWithStream(m).objectiveEval.totalObjectiveValue
      count++
    }
    return sumVal / count
  }

  const chosen = []
  let curWorld = adapter.advanceTimeOnly(world0, world0.now)
  let curBaseline = evalRolloutMean(curWorld)

  for (let step = 0; step < 1; step++) {
    if (isPastDeadlineFn?.()) break
    const cands = enumerateLegalCapexCandidates(adapter, curWorld, constraints)
    if (cands.length === 0) break
    let bestActs = null
    let bestVal = curBaseline
    let bestAfterW = null
    for (const c of cands) {
      if (isPastDeadlineFn?.()) break
      const candActs = c.actions || (c.action ? [c.action] : [])
      if (candActs.length === 0) continue
      const sim = adapter.simulateBatch(curWorld, candActs, { t: curWorld.now, prices: curWorld.prices })
      if (!sim.allOk) continue
      const val = evalRolloutMean(sim.afterWorld)
      if (val > bestVal + 1e-6) {
        bestVal = val
        bestActs = candActs
        bestAfterW = sim.afterWorld
      }
    }
    if (!bestActs) break
    chosen.push(...bestActs)
    curWorld = bestAfterW
    curBaseline = bestVal
  }

  return chosen
}

/**
 * Optimizes and simulates a complete deterministic/scenario trajectory across `seqBuckets`
 * starting from `startWorld`, returning exact simulated bucket actions and objective score!
 */
function optimizeAndSimulateSequence(adapter, {
  startWorld,
  initialWorldForObjective,
  seqBuckets,
  pricesForBucketFn,
  objectiveCfg,
  constraints,
  allowedSet,
  utilityTokens,
  forcedTrunkSellPolicy = 'optimal', // 'optimal' | 'sell-all-now' | 'hold-in-first-bucket'
  enableFirstBucketPlant = true,
  enableFirstBucketStockBuy = true,
  preselectedCapexActions = [],
  initialSoldByIsle = new Map(),
  partnerSoldByIsle = new Map(),
  scenarioSupplyFactor = null,
  prngFactory = null,
  initialCashEvents = [],
  maxCraftHoldIsleDays = 3,
  hasExplicitPriceOverride = false,
  skipObjectiveEval = false,
  isPastDeadlineFn = null,
  scheduledUpcomingRaids = [],
  raidOutcomeOverrides = null,
}) {
  const { R, graph } = adapter
  const L = seqBuckets.length
  const t0 = Number(initialWorldForObjective?.now ?? startWorld.now)
  const hasExplicitPrng = typeof prngFactory === 'function'
  const effectivePrngFactory = hasExplicitPrng
    ? prngFactory
    : () => adapter.makeSampleStreamPrng(0, t0)
  const probePrng = effectivePrngFactory()
  const trackPrng = effectivePrngFactory()
  const baseExecPrng = effectivePrngFactory()
  const auxSeedPrng = effectivePrngFactory()
  const baseExecSeed = Math.floor(auxSeedPrng() * 0xffffffff) >>> 0
  const makeIsolatedRaidStream = () => {
    let state = ((baseExecSeed ^ 0x51a7beef) >>> 0) || 0x13579bdf
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let z = state
      z = Math.imul(z ^ (z >>> 15), z | 1)
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296
    }
  }
  const probeRaidPrng = hasExplicitPrng ? makeIsolatedRaidStream() : null
  const execRaidPrng = hasExplicitPrng ? makeIsolatedRaidStream() : null
  const resolveDiscreteRaidBranch = (dist, raidKey, raidPrngFn) => {
    const outcomes = dist?.outcomes || []
    const overrideKind = raidOutcomeOverrides instanceof Map
      ? raidOutcomeOverrides.get(raidKey)
      : raidOutcomeOverrides?.[raidKey]
    if (overrideKind) {
      const matched = outcomes.find((o) => o.kind === overrideKind) || outcomes[0]
      if (matched) {
        return {
          kind: matched.kind,
          isRealizedBranch: true,
          arrivals: Object.entries(matched.lootBag || {}).map(([id, n]) => ({ id, q: 0, n })),
          fineCoins: matched.fineCoins,
        }
      }
    }
    if (raidPrngFn && outcomes.length > 0) {
      const uVal = raidPrngFn()
      let acc = 0
      let picked = outcomes[outcomes.length - 1]
      for (const o of outcomes) {
        acc += o.prob
        if (uVal <= acc + 1e-12) {
          picked = o
          break
        }
      }
      return {
        kind: picked.kind,
        isRealizedBranch: true,
        arrivals: Object.entries(picked.lootBag || {}).map(([id, n]) => ({ id, q: 0, n })),
        fineCoins: picked.fineCoins,
      }
    }
    return {
      kind: outcomes.length === 1 ? outcomes[0].kind : 'conservative-trunk',
      isRealizedBranch: outcomes.length === 1,
      arrivals: Object.entries(dist?.guaranteedLootBag || {}).map(([id, n]) => ({ id, q: 0, n })),
      fineCoins: Number(dist?.worstCaseFineCoins || 0),
    }
  }
  const execPrngMap = new Map()
  const getExecPrngForKind = (kindStr) => {
    const key = String(kindStr || 'det')
    if (key === 'det') return baseExecPrng
    let fn = execPrngMap.get(key)
    if (!fn) {
      if (execPrngMap.size === 0) {
        fn = baseExecPrng
      } else {
        let h = (baseExecSeed ^ 0x811c9dc5) >>> 0
        for (let i = 0; i < key.length; i++) {
          h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
        }
        h ^= h >>> 16
        h = Math.imul(h, 0x85ebca6b) >>> 0
        h ^= h >>> 13
        h = Math.imul(h, 0xc2b2ae35) >>> 0
        h ^= h >>> 16
        fn = adapter.makeDeterministicPrng((h || 0x52d777) >>> 0)
      }
      execPrngMap.set(key, fn)
    }
    return fn
  }

  const discretizationMeta = {
    cashDiscretized: false,
    maxCashUnit: 1,
    minExactGcd: 1,
    maxDpCells: 0,
    sites: [],
  }
  const recordCashGrid = (site, cashUnit, rawGcd, dpCells) => {
    discretizationMeta.maxDpCells = Math.max(discretizationMeta.maxDpCells, dpCells)
    if (cashUnit > rawGcd) {
      discretizationMeta.cashDiscretized = true
      discretizationMeta.maxCashUnit = Math.max(discretizationMeta.maxCashUnit, cashUnit)
      discretizationMeta.minExactGcd = discretizationMeta.sites.length === 0
        ? rawGcd
        : Math.min(discretizationMeta.minExactGcd, rawGcd)
      if (!discretizationMeta.sites.includes(site)) discretizationMeta.sites.push(site)
    }
  }

  // Step A: Estimate prices per bucket & workshop-capacity-aware marginal item values
  const soldTracker = new Map()
  for (const [k, v] of initialSoldByIsle.entries()) soldTracker.set(k, { ...v })

  const estPricesByU = seqBuckets.map((b) => pricesForBucketFn(b, soldTracker))
  const tH = L > 0 ? seqBuckets[L - 1].nextAtSec : startWorld.now
  const termStub = { ...startWorld, now: tH }
  const contTimeline = (
    objectiveCfg.terminalSupplyMode === 'zero' ||
    forcedTrunkSellPolicy === 'sell-all-now' ||
    hasExplicitPriceOverride
  )
    ? []
    : buildContinuationTimeline(adapter, termStub, initialWorldForObjective, objectiveCfg, scenarioSupplyFactor)
  const termPrices = objectiveCfg.terminalSupplyMode === 'zero'
    ? {}
    : (contTimeline[0]?.prices ?? buildTerminalPrices(adapter, termStub, initialWorldForObjective, objectiveCfg, scenarioSupplyFactor))

  const approxTaxFactor = typeof R.b12TaxSale === 'function'
    ? Math.max(0.05, Math.min(1, 1 - R.b12TaxSale(startWorld.state, { t: startWorld.now }, Number(startWorld.coins || 0), 10000) / 10000))
    : (Number(startWorld.coins || 0) > (R.B12_TAX?.free || 3000000) ? 0.99 : 1.0)

  const buildSlots = (pricesArr) => [
    ...seqBuckets.map((b, u) => ({
      slotIdx: u,
      availFromBucket: u,
      atSec: b.atSec,
      naturalDay: b.naturalDay,
      isleIndex: b.isleIndex,
      prices: pricesArr[u] || {},
      allowSell: allowedSet.has('sell') && !(forcedTrunkSellPolicy === 'hold-in-first-bucket' && u === 0 && L > 1),
      isTerminal: false,
      disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, b.atSec - t0)),
      netTaxFactor: approxTaxFactor,
    })),
    ...(objectiveCfg.terminalSupplyMode === 'zero' || forcedTrunkSellPolicy === 'sell-all-now'
      ? []
      : contTimeline.length > 1
        ? contTimeline.map((cs, idx) => ({
            slotIdx: L + idx,
            availFromBucket: Math.max(0, L - 1),
            atSec: cs.atSec,
            naturalDay: cs.naturalDay,
            isleIndex: cs.isleIndex,
            prices: cs.prices,
            allowSell: true,
            isTerminal: true,
            disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, cs.atSec - t0)),
            netTaxFactor: approxTaxFactor,
          }))
        : [{
            slotIdx: L,
            availFromBucket: Math.max(0, L - 1),
            atSec: tH,
            naturalDay: R.worldDay(tH),
            isleIndex: R.isleIndex(tH),
            prices: termPrices,
            allowSell: true,
            isTerminal: true,
            disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, tH - t0)),
            netTaxFactor: approxTaxFactor,
          }]),
  ]

  const slots = buildSlots(estPricesByU)

  const contCraftBuckets = []
  if (contTimeline.length > 1 && allowedSet.has('craft')) {
    const dailyCraftCap = Math.max(1, Number(R.WORLD?.daily?.craft || 80))
    let estMaxCraftUnits = 0
    for (const [id, qArr] of Object.entries(startWorld.state?.inv || {})) {
      const tot = (qArr?.[0] || 0) + (qArr?.[1] || 0) + (qArr?.[2] || 0)
      if (!(tot > 0)) continue
      const recs = graph.consumedByRecipes.get(id)
      if (!recs || recs.length === 0) continue
      let minNeed = Infinity
      for (const r of recs) {
        const n = Number(r.in?.[id] || 0)
        if (n > 0 && n < minNeed) minNeed = n
      }
      if (Number.isFinite(minNeed)) estMaxCraftUnits += Math.ceil(tot / minNeed)
    }
    const estHorizonIsleSpan = Math.max(1, Math.ceil(Math.max(0, tH - t0) / 14400))
    estMaxCraftUnits += ((startWorld.state?.plotN || 0) + (startWorld.state?.barn?.length || 0)) * estHorizonIsleSpan
    const maxContCraftIsles = Math.max(1, Math.ceil(estMaxCraftUnits / dailyCraftCap))

    const seenInHorizonIsles = new Set(seqBuckets.map((b) => b.isleIndex))
    const seenContIsles = new Set()
    const baseOff = L > 0 ? Number(seqBuckets[L - 1].isleDayOffset || 0) : 0
    for (const cs of contTimeline) {
      if (contCraftBuckets.length >= maxContCraftIsles) break
      if (seenInHorizonIsles.has(cs.isleIndex) || seenContIsles.has(cs.isleIndex)) continue
      seenContIsles.add(cs.isleIndex)
      contCraftBuckets.push({
        index: L + contCraftBuckets.length,
        atSec: cs.atSec,
        nextAtSec: cs.nextAtSec,
        naturalDay: cs.naturalDay,
        isleIndex: cs.isleIndex,
        isleDay: cs.isleDay,
        isleDayOffset: baseOff + seenContIsles.size,
      })
    }
  }

  const buildJointSlots = (baseSlots) => {
    if (contCraftBuckets.length === 0) return baseSlots
    return baseSlots.map((sl) => {
      if (!sl.isTerminal) return sl
      let availU = Math.max(0, L - 1)
      for (let cIdx = 0; cIdx < contCraftBuckets.length; cIdx++) {
        if (sl.atSec >= contCraftBuckets[cIdx].atSec) availU = L + cIdx
      }
      return { ...sl, availFromBucket: availU }
    })
  }
  const jointSlots = buildJointSlots(slots)

  // Track exact unreserved workshop capacity per isleIndex (both in-horizon and continuation!)
  // & unreserved initial inventory via `solveJointCraftAndSell` on initial stock
  const initSnap0 = adapter.availableInvSnapshot(startWorld.state)
  const startIsleIdx = R.isleIndex(startWorld.now)
  const allOpenIsleTimeline = []
  const rawFreeWorkshopByIsle = new Map()
  for (const b of seqBuckets) {
    if (rawFreeWorkshopByIsle.has(b.isleIndex)) continue
    allOpenIsleTimeline.push({ isleIndex: b.isleIndex, atSec: b.atSec, isContinuation: false })
    if (!allowedSet.has('craft')) {
      rawFreeWorkshopByIsle.set(b.isleIndex, 0)
      continue
    }
    const used = b.isleIndex === startIsleIdx && startWorld.state?.iq?.d === startIsleIdx
      ? Number(startWorld.state.iq.craft || 0)
      : 0
    rawFreeWorkshopByIsle.set(b.isleIndex, Math.max(0, (R.WORLD?.daily?.craft || 80) - used))
  }
  for (const cs of contTimeline) {
    if (rawFreeWorkshopByIsle.has(cs.isleIndex)) continue
    allOpenIsleTimeline.push({ isleIndex: cs.isleIndex, atSec: cs.atSec, isContinuation: true })
    rawFreeWorkshopByIsle.set(cs.isleIndex, allowedSet.has('craft') ? (R.WORLD?.daily?.craft || 80) : 0)
  }

  let marginalStateVer = 0
  const directChoiceMemo = new Map()
  const marginalValMemo = new Map()
  const bumpMarginalState = () => {
    marginalStateVer++
    directChoiceMemo.clear()
    marginalValMemo.clear()
  }

  const startNatDay = R.worldDay(startWorld.now)
  const projectedScOnStartDay = {}
  for (const [k, v] of Object.entries(startWorld.state?.cnt || {})) {
    if (k.startsWith('sc_')) projectedScOnStartDay[k.slice(3)] = Number(v || 0)
  }
  const projectedScByNatDay = new Map([[startNatDay, projectedScOnStartDay]])
  const getProjectedSc = (nd, id) => Number(projectedScByNatDay.get(nd)?.[id] || 0)
  const addProjectedSc = (nd, id, qty) => {
    if (!(qty > 0)) return
    let row = projectedScByNatDay.get(nd)
    if (!row) {
      row = {}
      projectedScByNatDay.set(nd, row)
    }
    row[id] = Number(row[id] || 0) + qty
    bumpMarginalState()
  }

  const unreservedInitCounts = {}
  const reservedByInitCS = {}
  for (const [id, row] of Object.entries(initSnap0)) {
    unreservedInitCounts[id] = (row[0] || 0) + (row[1] || 0) + (row[2] || 0)
  }

  const unreservedWorkshopByIsle = new Map(rawFreeWorkshopByIsle)
  const setUnreservedWorkshop = (iIdx, val) => {
    const prev = unreservedWorkshopByIsle.get(iIdx)
    if (prev !== val) {
      unreservedWorkshopByIsle.set(iIdx, val)
      bumpMarginalState()
    }
  }
  if ((allowedSet.has('craft') || allowedSet.has('sell')) && (L + contCraftBuckets.length) > 0) {
    const craftEn = R.WORLD?.cost?.craft ?? 1
    const initCSBuckets = [...seqBuckets, ...contCraftBuckets]
    const initCS = solveJointCraftAndSell(adapter, {
      initialSupplyByBucket: [cloneInvSnap(initSnap0), ...initCSBuckets.slice(1).map(() => ({}))],
      buckets: initCSBuckets,
      slots: jointSlots,
      initialNatDay: startNatDay,
      initialCnt: startWorld.state?.cnt || {},
      craftCapByIsle: new Map(rawFreeWorkshopByIsle),
      enCapByBucket: Float64Array.from(initCSBuckets.map((b) => (rawFreeWorkshopByIsle.get(b.isleIndex) || 0) * craftEn)),
      staminaShadowCost: 0,
      allowCraft: allowedSet.has('craft'),
      maxCraftHoldIsleDays: Math.max(maxCraftHoldIsleDays || 3, initCSBuckets.length > 0 ? (initCSBuckets[initCSBuckets.length - 1].isleDayOffset || 0) + 1 : 3),
      isPastDeadlineFn,
    })
    const producedMid = {}
    for (let u = 0; u < initCSBuckets.length; u++) {
      const iIdx = initCSBuckets[u].isleIndex
      for (const ca of initCS.craftsByBucket[u] || []) {
        const nCraft = Number(ca.n || 1)
        producedMid[ca.id] = (producedMid[ca.id] || 0) + nCraft
        unreservedWorkshopByIsle.set(iIdx, Math.max(0, (unreservedWorkshopByIsle.get(iIdx) || 0) - nCraft))
        const rec = graph.recipesById.get(ca.id)
        for (const [inId, perU] of Object.entries(rec?.in || {})) {
          let req = perU * nCraft
          const fromMid = Math.min(req, producedMid[inId] || 0)
          producedMid[inId] = (producedMid[inId] || 0) - fromMid
          req -= fromMid
          if (req > 0) {
            const takeInit = Math.min(req, Number(unreservedInitCounts[inId] || 0))
            unreservedInitCounts[inId] = Math.max(0, Number(unreservedInitCounts[inId] || 0) - takeInit)
            reservedByInitCS[inId] = (reservedByInitCS[inId] || 0) + takeInit
          }
        }
      }
    }
    for (const [id, sched] of initCS.salePortfolio.perItem.entries()) {
      if (!graph.cropsById.has(id)) continue
      for (let s = 0; s < jointSlots.length; s++) {
        if (jointSlots[s].naturalDay === startNatDay) continue
        const sr = sched.sellsBySlot[s]
        if (!sr) continue
        const soldCnt = (sr[0] || 0) + (sr[1] || 0) + (sr[2] || 0)
        if (soldCnt > 0) addProjectedSc(jointSlots[s].naturalDay, id, soldCnt)
      }
    }
  }

  // Project background seasonal farm output across post-`tH` continuation isle-days (`stepIdx >= 1`)
  // using the exact shared `projectContinuationFarmFlows` engine from `model/objective.mjs`!
  const postHorizonContSlots = contTimeline.filter((cs) => cs.stepIdx >= 1)
  if ((allowedSet.has('plant') || allowedSet.has('harvest')) && postHorizonContSlots.length > 0) {
    projectContinuationFarmFlows(
      adapter,
      { ...startWorld, now: postHorizonContSlots[0].atSec },
      postHorizonContSlots,
      {
        craftCapByIsle: unreservedWorkshopByIsle,
        getScAtSlot: (sIdx, id) => getProjectedSc(postHorizonContSlots[sIdx].naturalDay, id),
        addScAtSlot: (sIdx, id, qty) => addProjectedSc(postHorizonContSlots[sIdx].naturalDay, id, qty),
        approxTaxMult: approxTaxFactor,
        discRatePerHour: Number(objectiveCfg.discountRatePerHour || 0),
        discOriginSec: t0,
        allowTerminalCraft: allowedSet.has('craft'),
        allowTerminalHarvest: allowedSet.has('harvest'),
        allowTerminalPlant: allowedSet.has('plant'),
        skipStandingPlots: true,
      }
    )
    bumpMarginalState()
  }

  const findBestDirectSaleChoice = (id, q = 0, atSec = startWorld.now) => {
    const dKey = `${id}:${q}:${atSec}`
    const hit = directChoiceMemo.get(dKey)
    if (hit !== undefined) return hit
    const qual = R.QUALITY?.[q] ?? 1
    let bestDirect = 0
    let bestNatDay = startNatDay
    const isCrop = graph.cropsById.has(id)
    for (const sl of slots) {
      if (!sl.allowSell || sl.atSec + 1 < atSec) continue
      const p = Number(sl.prices?.[id] || 0)
      if (!(p > 0)) continue
      const sc0 = isCrop ? getProjectedSc(sl.naturalDay, id) : 0
      const tierMult = !isCrop ? 1.0 : (sc0 >= 400 ? 0.70 : sc0 >= 150 ? 0.85 : 1.0)
      const val = Math.round(p * qual) * tierMult * sl.disc * sl.netTaxFactor
      if (val > bestDirect + 1e-9) {
        bestDirect = val
        bestNatDay = sl.naturalDay
      }
    }
    const out = { val: bestDirect, natDay: bestNatDay }
    directChoiceMemo.set(dKey, out)
    return out
  }

  const bestDirectUnitValue = (id, q = 0, atSec = startWorld.now) => findBestDirectSaleChoice(id, q, atSec).val

  const marginalItemValueFn = (id, q = 0, atSec = startWorld.now, { reserveUnits = 0 } = {}) => {
    const mKey = reserveUnits > 0 ? null : `${id}:${q}:${atSec}`
    if (mKey !== null) {
      const mHit = marginalValMemo.get(mKey)
      if (mHit !== undefined) return mHit
    }
    const dirChoice = findBestDirectSaleChoice(id, q, atSec)
    const bestDirect = dirChoice.val
    let best = bestDirect
    let usedWorkshopRecipe = null

    if (allowedSet.has('craft')) {
      const consumers = graph.consumedByRecipes.get(id) || []
      for (const r of consumers) {
        if (!(r.price > 0)) continue
        const needThis = Number(r.in?.[id] || 0)
        if (!(needThis > 0)) continue
        const minSlotReq = reserveUnits > 0 ? Math.min(1, reserveUnits / needThis) : 1 / needThis
        let openIsleEntry = null
        for (const entry of allOpenIsleTimeline) {
          if (entry.atSec + 1 >= atSec && (unreservedWorkshopByIsle.get(entry.isleIndex) || 0) + 1e-9 >= Math.max(1, minSlotReq)) {
            openIsleEntry = entry
            break
          }
        }
        if (!openIsleEntry) continue

        let compFeasible = true
        let otherCost = 0
        for (const [oId, oQty] of Object.entries(r.in || {})) {
          if (oId === id) continue
          const haveComp = Number(unreservedInitCounts[oId] || 0)
          if (haveComp < oQty) {
            compFeasible = false
            break
          }
          otherCost += oQty * bestDirectUnitValue(oId, 0, atSec)
        }
        if (!compFeasible) continue
        const craftReadySec = Math.max(atSec, openIsleEntry.atSec)
        let bestRecOut = 0
        for (const sl of slots) {
          if (!sl.allowSell || sl.atSec + 1 < craftReadySec) continue
          bestRecOut = Math.max(bestRecOut, Number(sl.prices?.[r.id] || 0) * sl.disc * sl.netTaxFactor)
        }
        const implied = (bestRecOut - otherCost) / needThis
        if (implied > best) {
          best = implied
          usedWorkshopRecipe = { recipe: r, needThis }
        }
      }
    }

    if (reserveUnits > 0) {
      if (usedWorkshopRecipe) {
        // Exact fractional workshop slot reservation: 1 unit of an ingredient that takes `needThis` per craft
        // reserves `1 / needThis` of a slot (NEVER `Math.ceil(1 / needThis)`!)
        let remSlotsToConsume = reserveUnits / usedWorkshopRecipe.needThis
        for (const entry of allOpenIsleTimeline) {
          if (remSlotsToConsume <= 1e-9) break
          if (entry.atSec + 1 >= atSec && (unreservedWorkshopByIsle.get(entry.isleIndex) || 0) > 1e-9) {
            const cur = unreservedWorkshopByIsle.get(entry.isleIndex) || 0
            const tk = Math.min(cur, remSlotsToConsume)
            setUnreservedWorkshop(entry.isleIndex, Math.max(0, cur - tk))
            remSlotsToConsume -= tk
          }
        }
      } else if (graph.cropsById.has(id)) {
        addProjectedSc(dirChoice.natDay, id, reserveUnits)
      }
    }

    const resVal = Math.max(0, best)
    if (mKey !== null) marginalValMemo.set(mKey, resVal)
    return resVal
  }

  // Step B: Pre-pass over deterministic maintenance, urgent farm/barn care & cargo `stockBuy` to collect exact supply arrivals per bucket!
  let probeWorld = adapter.cloneWorld(startWorld)
  const earlyZeroEnPreByU = seqBuckets.map(() => [])
  const cargoPreByU = seqBuckets.map(() => [])
  const goalPreByU = seqBuckets.map(() => [])
  const probeAllPreByU = seqBuckets.map(() => [])
  const probeVirtualEnByU = new Float64Array(L)
  const probeCoffeeCashByU = new Float64Array(L)
  const estUrgentFarmEnByU = new Float64Array(L)
  const supplyByBucket = seqBuckets.map(() => ({}))
  const enAfterPreByU = new Float64Array(L)
  const craftCapByIsle = new Map()
  const seenCargoIsle = new Set()
  const probeEdibleSpecs = typeof adapter.listDeterministicEdibleSpecs === 'function'
    ? adapter.listDeterministicEdibleSpecs()
    : []

  const scheduledRaidsByU = seqBuckets.map(() => [])
  const futureRaidsAfterU = seqBuckets.map(() => [])
  const raidIntLootByU = seqBuckets.map(() => [])
  if (Array.isArray(scheduledUpcomingRaids) && scheduledUpcomingRaids.length > 0 && L > 0) {
    const sortedRaids = [...scheduledUpcomingRaids]
      .filter((r) => r && Number(r.unlockAtSec) >= startWorld.now && Number(r.unlockAtSec) <= tH)
      .sort((a, b2) => (Number(a.unlockAtSec) - Number(b2.unlockAtSec)) || (Number(a.targetId || 0) - Number(b2.targetId || 0)))
    for (const r of sortedRaids) {
      let targetU = -1
      for (let uIdx = 0; uIdx < L; uIdx++) {
        if (seqBuckets[uIdx].atSec >= r.unlockAtSec) {
          targetU = uIdx
          break
        }
      }
      if (targetU >= 0) {
        scheduledRaidsByU[targetU].push(r)
        for (let prevU = 0; prevU < targetU; prevU++) {
          futureRaidsAfterU[prevU].push(r)
        }
      }
    }
  }

  // Endogenous marginal stamina shadow cost derived strictly from game physics (`0` magic constants)
  const baseStaminaShadowCost = (() => {
    const termCredit = Math.max(0, Number(objectiveCfg.energyTerminalCreditPerPoint || 0))
    const s0 = startWorld.state || {}
    const iIdx0 = R.isleIndex(t0)
    const regenStep0 = R.WORLD?.regen || 180
    const isle0End = Math.min(tH, adapter.nextIsleBoundary(t0, startWorld.clockStart))
    const freeRegen0 = Math.max(0, Math.floor((isle0End - Math.max(t0, Number(s0.enT || t0))) / regenStep0))
    const usedIq0 = s0.iq?.d === iIdx0 ? s0.iq : {}
    let shiftableDemand0 = 0
    if (allowedSet.has('craft')) shiftableDemand0 += Math.max(0, (R.WORLD?.daily?.craft || 80) - Number(usedIq0.craft || 0)) * (R.WORLD?.cost?.craft ?? 1)
    if (allowedSet.has('bomb')) shiftableDemand0 += Math.max(0, (R.WORLD?.daily?.bomb || 10) - Number(usedIq0.bomb || 0)) * (R.WORLD?.cost?.bomb ?? 6)
    if (allowedSet.has('fish')) shiftableDemand0 += Math.max(0, (R.WORLD?.daily?.fish || 80) - Number(usedIq0.fish || 0)) * (R.WORLD?.cost?.fish ?? 4)
    if (allowedSet.has('mine')) shiftableDemand0 += Math.max(0, (R.WORLD?.daily?.mine || 100) - Number(usedIq0.mine || 0)) * (R.WORLD?.cost?.mine ?? 3)
    if (Math.max(0, Math.floor(Number(s0.en || 0))) + freeRegen0 >= shiftableDemand0) {
      return termCredit
    }
    let minTopUpCpe = Infinity
    if (allowedSet.has('eat')) {
      for (const sp of probeEdibleSpecs) {
        const qty = sp.kind === 'snack'
          ? Math.min(adapter.availableInv(s0, sp.id, 0), sp.dailyCap != null ? Math.max(0, sp.dailyCap - Number(s0.cnt?.[sp.id] || 0)) : 999)
          : adapter.availableInv(s0, sp.id, sp.q)
        if (!(qty > 0) || !(sp.energyGain > 0)) continue
        const cpe = sp.kind === 'snack' ? 0 : bestDirectUnitValue(sp.id, sp.q, t0) / sp.energyGain
        if (cpe < minTopUpCpe) minTopUpCpe = cpe
      }
    }
    if (allowedSet.has('coffee')) {
      const cLeft = Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(s0.cnt?.coffee || 0))
      const cPrice = R.WORLD?.coffee?.price || 15000
      const cEn = R.WORLD?.coffee?.energy || 60
      if (cLeft > 0 && cEn > 0 && Number(startWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) >= cPrice) {
        minTopUpCpe = Math.min(minTopUpCpe, cPrice / cEn)
      }
    }
    let bestExtractionPerEn = termCredit
    if (allowedSet.has('mine')) {
      const my0 = expectedMineYieldPerHit(adapter, s0, R.isleDay(t0))
      const mv0 = Object.entries(my0.byOre).reduce((acc, [oId, c]) => acc + c * marginalItemValueFn(oId, 0, t0), 0)
      bestExtractionPerEn = Math.max(bestExtractionPerEn, mv0 / Math.max(1, R.WORLD?.cost?.mine ?? 3))
    }
    if (allowedSet.has('fish')) {
      const fy0 = expectedFishYieldPerCast(adapter, s0, t0, false)
      const fv0 = Object.entries(fy0.byFish).reduce(
        (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, t0) + qs[1] * marginalItemValueFn(fId, 1, t0) + qs[2] * marginalItemValueFn(fId, 2, t0),
        0
      )
      bestExtractionPerEn = Math.max(bestExtractionPerEn, fv0 / Math.max(1, R.WORLD?.cost?.fish ?? 4))
    }
    return Number.isFinite(minTopUpCpe)
      ? Math.max(termCredit, Math.min(minTopUpCpe, bestExtractionPerEn))
      : bestExtractionPerEn
  })()

  const buildProbeTopUpPool = (stWorld, atSec, bucketDiscVal) => {
    const s = stWorld.state || {}
    const pool = []
    if (allowedSet.has('eat')) {
      for (const sp of probeEdibleSpecs) {
        const qty = sp.kind === 'snack'
          ? Math.min(adapter.availableInv(s, sp.id, 0), sp.dailyCap != null ? Math.max(0, sp.dailyCap - Number(s.cnt?.[sp.id] || 0)) : 999)
          : adapter.availableInv(s, sp.id, sp.q)
        if (!(qty > 0) || !(sp.energyGain > 0)) continue
        const unitOpp = sp.kind === 'snack' ? 0 : Math.max(bestDirectUnitValue(sp.id, sp.q, atSec), marginalItemValueFn(sp.id, sp.q, atSec))
        pool.push({
          kind: 'eat',
          rem: qty,
          enGain: sp.energyGain,
          cpe: unitOpp / sp.energyGain,
          cashPerUnit: 0,
        })
      }
    }
    if (allowedSet.has('coffee')) {
      const cLeft = Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(s.cnt?.coffee || 0))
      const cPrice = R.WORLD?.coffee?.price || 15000
      const cEn = R.WORLD?.coffee?.energy || 60
      const freeC = Math.max(0, Number(stWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      const affordC = cPrice > 0 ? Math.min(cLeft, Math.floor(freeC / cPrice)) : 0
      if (affordC > 0 && cEn > 0) {
        pool.push({
          kind: 'coffee',
          rem: affordC,
          enGain: cEn,
          cpe: (cPrice * bucketDiscVal) / cEn,
          cashPerUnit: cPrice,
        })
      }
    }
    pool.sort((a, b2) => a.cpe - b2.cpe)
    return pool
  }

  const addSupply = (u, id, q, n) => {
    if (!(n > 0)) return
    supplyByBucket[u][id] ||= [0, 0, 0]
    supplyByBucket[u][id][q] += n
  }

  for (let u = 0; u < L; u++) {
    const b = seqBuckets[u]
    const bPrices = estPricesByU[u] || {}
    const bDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, b.atSec - t0))
    probeWorld = adapter.advanceTimeOnly(probeWorld, b.atSec, { futurePrices: bPrices })
    probeWorld = applyExogenousArrivals(probeWorld, b.exogenousArrivalsAtStart)

    if (scheduledRaidsByU[u].length > 0) {
      const topUpRaidB = buildProbeTopUpPool(probeWorld, b.atSec, bDisc)
      for (const sr of scheduledRaidsByU[u]) {
        const expTr = computeExpectedRaidTransition(adapter, sr, probeWorld, null)
        let curProbeEn = Math.max(0, Math.floor(Number(probeWorld.state?.en || 0)))
        if (curProbeEn < expTr.energyCost) {
          let defR = expTr.energyCost - curProbeEn
          let grantR = 0
          let cSpentR = 0
          const freeCR = Math.max(0, Number(probeWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
          for (const entry of topUpRaidB) {
            if (defR <= 0) break
            while (entry.rem > 0 && defR > 0) {
              if (entry.cashPerUnit > 0 && cSpentR + entry.cashPerUnit > freeCR) break
              entry.rem -= 1
              grantR += entry.enGain
              defR -= entry.enGain
              cSpentR += entry.cashPerUnit
            }
          }
          curProbeEn += grantR
          probeVirtualEnByU[u] += grantR
          if (cSpentR > 0) {
            probeWorld.coins = Math.max(0, Number(probeWorld.coins || 0) - cSpentR)
            probeCoffeeCashByU[u] += cSpentR
          }
        }
        probeWorld.state.en = Math.max(0, curProbeEn - expTr.energyCost)
        const raidKey = `${sr.targetId}@${Number(sr.unlockAtSec ?? b.atSec)}`
        const probeBranch = resolveDiscreteRaidBranch(expTr.distribution, raidKey, probeRaidPrng)
        if (probeBranch.arrivals.length > 0) {
          probeWorld = applyExogenousArrivals(probeWorld, probeBranch.arrivals)
          raidIntLootByU[u].push(...probeBranch.arrivals)
        }
        const probeFine = Math.min(Math.max(0, Number(probeWorld.coins || 0)), probeBranch.fineCoins)
        if (probeFine > 0) {
          probeWorld.coins = Math.max(0, Number(probeWorld.coins || 0) - probeFine)
        }
      }
    }

    if (!craftCapByIsle.has(b.isleIndex)) {
      const used = probeWorld.state?.iq?.d === b.isleIndex ? Number(probeWorld.state.iq.craft || 0) : 0
      craftCapByIsle.set(b.isleIndex, allowedSet.has('craft') ? Math.max(0, (R.WORLD?.daily?.craft || 80) - used) : 0)
    }

    const earlyBatch = []
    let s = probeWorld.state
    const weather = R.weatherOf(b.isleDay)

    // 1. Pre-selected CapEx at u=0 if authorized (0 stamina)
    if (u === 0 && allowedSet.has('capex') && preselectedCapexActions.length > 0) {
      earlyBatch.push(...preselectedCapexActions)
    }

    // 2. Zero-stamina crab traps
    if (allowedSet.has('trap')) {
      for (let i = 0; i < (s.traps?.length || 0); i++) {
        if (R.trapReady(s.traps[i], b.atSec, weather === 2).n > 0) {
          earlyBatch.push({ a: 'trap', i })
        }
      }
    }

    // 3. Zero-stamina barn `collect` & `pet` (exact mood-cap ordering: m >= 95 -> collect before pet; else pet before collect!)
    for (let i = 0; i < (s.barn?.length || 0); i++) {
      const pen = s.barn[i]
      if (!pen) continue
      const stage = R.b12AnimalStage(pen, b.atSec)
      const st = R.animalReady(pen, b.atSec)
      const canPet = allowedSet.has('pet') && !stage.retired && Number(s.cnt?.['pet' + i] || 0) < 1
      const canCollect = allowedSet.has('collect') && st.ready
      if (canCollect && canPet) {
        if ((pen.m || 0) >= 95) {
          earlyBatch.push({ a: 'collect', i }, { a: 'pet', i })
        } else {
          earlyBatch.push({ a: 'pet', i }, { a: 'collect', i })
        }
      } else if (canPet) {
        earlyBatch.push({ a: 'pet', i })
      } else if (canCollect) {
        earlyBatch.push({ a: 'collect', i })
      }
    }

    // 3b. Low-cash working-capital pre-sell at `u === 0` (exact seed, feed & positive-arbitrage cargo needs; 0 magic constants)
    if (
      u === 0 &&
      allowedSet.has('sell') &&
      !(forcedTrunkSellPolicy === 'hold-in-first-bucket' && L > 1) &&
      Number(probeWorld.coins || 0) < (R.B12_TAX?.free || 3000000)
    ) {
      let estWorkingCapNeed = 0
      if (allowedSet.has('feed') && utilityTokens.feedId) {
        let hungryCnt = 0
        for (let i = 0; i < (s.barn?.length || 0); i++) {
          const pen = s.barn[i]
          if (!pen || R.b12AnimalStage(pen, b.atSec).retired) continue
          const hungryAt = pen.f + 86400
          if (b.atSec - pen.f >= 8 * 3600 && (hungryAt <= b.nextAtSec || b.atSec >= hungryAt)) hungryCnt++
        }
        const needFeed = Math.max(0, hungryCnt - adapter.availableInv(s, utilityTokens.feedId, 0))
        estWorkingCapNeed += needFeed * Number(R.SHOP?.[utilityTokens.feedId]?.price || 150)
      }
      if (allowedSet.has('plant') && enableFirstBucketPlant) {
        const freeSeedRem = new Map()
        for (let i = 0; i < (s.plotN || 0); i++) {
          const p = s.plots?.[i]
          let willBeEmpty = !p
          if (p) {
            const st = R.cropStage(p, b.atSec, R.sprinkled(s, i) || weather === 1)
            if (st.stage === 3 && allowedSet.has('harvest')) {
              const post = adapter.predictPostHarvestPlot(p, b.atSec, startWorld.clockStart)
              willBeEmpty = post.kind === 'empty' || (post.kind === 'withered' && allowedSet.has('clear'))
            } else if (st.stage === -1 && allowedSet.has('clear')) {
              willBeEmpty = true
            }
          }
          if (!willBeEmpty) continue
          const bestP = selectBestCropToPlant(adapter, {
            state: s,
            clockStart: startWorld.clockStart,
            plotIdx: i,
            atSec: b.atSec,
            tEnd: tH,
            marginalItemValueFn,
            staminaPointCost: baseStaminaShadowCost,
            enforceHorizonCutoff: objectiveCfg.terminalSupplyMode === 'zero',
          })
          if (!bestP) continue
          const sdKey = `sd_${bestP.crop.id}`
          if (!freeSeedRem.has(sdKey)) freeSeedRem.set(sdKey, adapter.availableInv(s, sdKey, 0))
          const remSd = freeSeedRem.get(sdKey) || 0
          if (remSd > 0) {
            freeSeedRem.set(sdKey, remSd - 1)
          } else {
            estWorkingCapNeed += Number(bestP.crop.seed || 0)
          }
        }
      }
      if (allowedSet.has('stockBuy') && enableFirstBucketStockBuy && typeof R.b12Stock === 'function') {
        const stock0 = R.b12Stock(b.atSec, bPrices)
        const cargoMap0 = new Map(stock0.map((it) => [it.id, { price: Number(it.price || 0), left: R.b12StockLeft(s, it, b.atSec) }]))
        let bestCargoEdible = null
        for (const item of stock0) {
          const left = cargoMap0.get(item.id)?.left || 0
          if (!(left > 0) || !(item.price > 0)) continue
          const edSp = allowedSet.has('eat')
            ? probeEdibleSpecs.find((sp) => (sp.kind === 'snack' && sp.id === item.id) || (sp.kind !== 'snack' && sp.id === item.id && sp.q === 0))
            : null
          if (edSp && edSp.energyGain > 0) {
            const cpe = item.price / edSp.energyGain
            if (!bestCargoEdible || cpe < bestCargoEdible.cpe) {
              bestCargoEdible = { price: item.price, left, enGain: edSp.energyGain, cpe }
            }
          }
          if (utilityTokens.explosiveId && item.id === utilityTokens.explosiveId && allowedSet.has('bomb')) {
            estWorkingCapNeed += left * item.price
          } else if (bestDirectUnitValue(item.id, 0, b.atSec) > item.price * bDisc + 1e-6) {
            estWorkingCapNeed += left * item.price
          }
        }
        if (bestCargoEdible) {
          const rawEnCap0 = Number(R.energyMax(s))
          const enCap0 = Number.isFinite(rawEnCap0) && rawEnCap0 > 0 ? rawEnCap0 : 100
          const deficitEn = Math.max(0, enCap0 - Math.max(0, Math.floor(Number(s.en || 0))))
          if (deficitEn > 0) {
            estWorkingCapNeed += Math.min(bestCargoEdible.left, Math.ceil(deficitEn / bestCargoEdible.enGain)) * bestCargoEdible.price
          }
        }
        if (allowedSet.has('craft')) {
          let freeSlotsEst = Math.floor((unreservedWorkshopByIsle.get(b.isleIndex) || 0) + 1e-9)
          for (const rec of R.RECIPES || []) {
            if (!(rec.price > 0) || freeSlotsEst <= 0) continue
            let outBest = 0
            for (const sl of slots) {
              if (!sl.allowSell || sl.atSec + 1 < b.atSec) continue
              outBest = Math.max(outBest, Number(sl.prices?.[rec.id] || 0) * sl.disc * sl.netTaxFactor)
            }
            let maxB = freeSlotsEst
            let cashPerBundle = 0
            let oppPerBundle = 0
            let usesCargo = false
            for (const [inId, reqQty] of Object.entries(rec.in || {})) {
              const cInfo = cargoMap0.get(inId)
              if (cInfo && cInfo.left > 0 && cInfo.price > 0) {
                usesCargo = true
                maxB = Math.min(maxB, Math.floor(((unreservedInitCounts[inId] || 0) + cInfo.left) / reqQty))
                cashPerBundle += reqQty * cInfo.price
                oppPerBundle += reqQty * cInfo.price * bDisc
              } else {
                maxB = Math.min(maxB, Math.floor((unreservedInitCounts[inId] || 0) / reqQty))
                oppPerBundle += reqQty * bestDirectUnitValue(inId, 0, b.atSec)
              }
            }
            if (usesCargo && maxB > 0 && outBest > oppPerBundle + 1e-6) {
              estWorkingCapNeed += maxB * cashPerBundle
              freeSlotsEst -= maxB
            }
          }
        }
      }
      const availNow = Math.max(0, Number(probeWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      let shortfall = Math.max(0, estWorkingCapNeed - availNow)
      if (shortfall > 0) {
        const snap0 = adapter.availableInvSnapshot(s)
        for (const [resId, resNeed] of Object.entries(reservedByInitCS)) {
          let remRes = Math.max(0, Math.floor(Number(resNeed || 0)))
          const row = snap0[resId]
          if (!row || !(remRes > 0)) continue
          for (let qIdx = 0; qIdx < 3 && remRes > 0; qIdx++) {
            const tk = Math.min(row[qIdx] || 0, remRes)
            row[qIdx] -= tk
            remRes -= tk
          }
        }
        const allCandidates = Object.keys(snap0)
          .filter((id) => Number(bPrices?.[id] || 0) > 0 && Number(R.BASE_PRICE?.[id] || 0) > 0)
          .map((id) => {
            const isRawInput = (graph.consumedByRecipes.get(id) || []).some((r) => r.price > 0)
            const curP = Number(bPrices[id] || 0)
            const curNet0 = Math.round(curP) * (graph.cropsById.has(id) ? 0.85 : 1) * bDisc * approxTaxFactor
            const futBest = marginalItemValueFn(id, 0, b.atSec)
            const holdRatio = futBest > 0 ? curNet0 / futBest : 1
            return { id, isRawInput, curP, curNet0, futBest, holdRatio }
          })
          .filter((c) => !c.isRawInput || c.curNet0 + 1e-6 >= c.futBest)
          .sort((a, b2) => Number(a.isRawInput) - Number(b2.isRawInput) || b2.holdRatio - a.holdRatio)

        const wcSells = []
        for (const c of allCandidates) {
          if (shortfall <= 0) break
          for (const q of [2, 1, 0]) {
            if (shortfall <= 0) break
            const have = snap0[c.id]?.[q] || 0
            if (!(have > 0)) continue
            const unitGross = Math.max(1, Math.round(c.curP * (R.QUALITY?.[q] ?? 1)) * (graph.cropsById.has(c.id) ? 0.85 : 1))
            const sellQty = Math.min(999, have, Math.ceil(shortfall / unitGross))
            if (sellQty > 0) {
              wcSells.push({ a: 'sell', id: c.id, q, n: sellQty })
              shortfall -= sellQty * unitGross
            }
          }
        }
        if (wcSells.length > 0) {
          earlyBatch.push(...wcSells)
        }
      }
    }

    if (earlyBatch.length > 0) {
      const svEarly = simulateValidBatch(adapter, probeWorld, earlyBatch, {
        t: b.atSec,
        prices: bPrices,
        rand: probePrng,
      })
      probeWorld = svEarly.afterWorld
      s = probeWorld.state
      earlyZeroEnPreByU[u].push(...svEarly.validActions)
      probeAllPreByU[u].push(...svEarly.validActions)
    }

    // 4 & 5. Urgent Farm & Barn Care on `probeWorld` in exact economic priority order:
    //   (a) Ripe `harvest` & withered `clear` (`1 en`)
    //   (b) Empty-plot `plant` (`2 en`, including plots freed by `harvest`/`clear`!)
    //   (c) Hungry barn `feed` (`1 en`)
    //   (d) Expiring manual `water` (`1 en`), and non-expiring manual `water` ONLY after all empty plots are planted!
    {
      const regenStepB = R.WORLD?.regen || 180
      const baseEnTB = Math.max(b.atSec, Number(s.enT || b.atSec))
      const nextOppSecB = Math.min(b.nextAtSec > b.atSec ? b.nextAtSec : b.atSec + regenStepB, baseEnTB + regenStepB)
      const topUpPoolB = buildProbeTopUpPool(probeWorld, b.atSec, bDisc)
      let probeRaidMinReserveEn = 0
      if (futureRaidsAfterU[u].length > 0) {
        const remPoolEnCap = topUpPoolB.reduce((sAcc, e) => sAcc + e.rem * e.enGain, 0)
        let cumRaidNeed = 0
        for (const fr of futureRaidsAfterU[u]) {
          cumRaidNeed += Math.max(0, Math.floor(Number(fr.energyCost || 0)))
          const passiveRegenToFr = Math.max(0, Math.floor((fr.unlockAtSec - baseEnTB) / regenStepB))
          const holdReq = Math.max(0, cumRaidNeed - passiveRegenToFr - remPoolEnCap)
          if (holdReq > probeRaidMinReserveEn) probeRaidMinReserveEn = holdReq
        }
      }

      const ensureProbeUrgentEn = (neededEn, maxAcceptableCpe) => {
        const reqWithRaid = neededEn + probeRaidMinReserveEn
        const curEnB = Math.max(0, Math.floor(Number(probeWorld.state?.en || 0)))
        if (curEnB >= reqWithRaid) return true
        let deficit = reqWithRaid - curEnB
        let granted = 0
        let coffeeSpent = 0
        const freeCoinsNow = Math.max(0, Number(probeWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
        for (const entry of topUpPoolB) {
          if (deficit <= 0) break
          if (!(entry.rem > 0) || entry.cpe >= maxAcceptableCpe - 1e-6) continue
          while (entry.rem > 0 && deficit > 0) {
            if (entry.cashPerUnit > 0 && coffeeSpent + entry.cashPerUnit > freeCoinsNow) break
            entry.rem -= 1
            granted += entry.enGain
            deficit -= entry.enGain
            coffeeSpent += entry.cashPerUnit
          }
        }
        if (granted > 0) {
          probeWorld.state.en = curEnB + granted
          probeVirtualEnByU[u] += granted
          if (coffeeSpent > 0) {
            probeWorld.coins = Math.max(0, Number(probeWorld.coins || 0) - coffeeSpent)
            probeCoffeeCashByU[u] += coffeeSpent
          }
        }
        return Math.max(0, Math.floor(Number(probeWorld.state?.en || 0))) >= reqWithRaid
      }

      // (a) Ripe `harvest` & withered `clear` (including immediate post-harvest cross-season wither -> `clear`)
      const hcActs = []
      const harvestCostEnProbe = R.WORLD?.cost?.harvest ?? 1
      const clearCostEnProbe = R.WORLD?.cost?.clear ?? 1
      let hcPlannedEn = 0
      let expiringWaters = []
      let nonExpiringWaters = []
      for (let i = 0; i < (s.plots?.length || 0); i++) {
        const p = s.plots[i]
        if (!p) continue
        const auto = R.sprinkled(s, i) || weather === 1
        const st = R.cropStage(p, b.atSec, auto)
        if (st.stage === 3 && allowedSet.has('harvest')) {
          const cropDef = graph.cropsById.get(p.c)
          const unitVal = cropDef ? Math.max(1, marginalItemValueFn(cropDef.id, 0, b.atSec)) : 100
          const approxDelayLoss = Math.max(20, (unitVal / Math.max(3600, (cropDef?.grow || 120) * 60)) * regenStepB + 0.15 * unitVal)
          if (ensureProbeUrgentEn(hcPlannedEn + harvestCostEnProbe, approxDelayLoss)) {
            hcActs.push({ a: 'harvest', i })
            hcPlannedEn += harvestCostEnProbe
            const post = adapter.predictPostHarvestPlot(p, b.atSec, startWorld.clockStart)
            if (post.kind === 'withered' && allowedSet.has('clear')) {
              if (ensureProbeUrgentEn(hcPlannedEn + clearCostEnProbe, 500)) {
                hcActs.push({ a: 'clear', i })
                hcPlannedEn += clearCostEnProbe
              }
            }
          }
        } else if (st.stage === -1 && allowedSet.has('clear')) {
          if (ensureProbeUrgentEn(hcPlannedEn + clearCostEnProbe, 500)) {
            hcActs.push({ a: 'clear', i })
            hcPlannedEn += clearCostEnProbe
          }
        } else if (st.stage >= 0 && st.stage < 3 && !auto && p.w <= st.stage && allowedSet.has('water')) {
          const stageEndSec = Number(p.t || b.atSec) + Math.ceil((Number(st.total || 3600) * (st.stage + 1)) / 3)
          const cropDef = graph.cropsById.get(p.c)
          const unitVal = cropDef ? marginalItemValueFn(cropDef.id, 0, b.atSec) : 0
          const deltaWaterVal = 0.20 * unitVal
          if (stageEndSec <= nextOppSecB) {
            expiringWaters.push({ i, deltaWaterVal })
          } else {
            nonExpiringWaters.push({ i, deltaWaterVal })
          }
        }
      }
      if (hcActs.length > 0) {
        const svHC = simulateValidBatch(adapter, probeWorld, hcActs, {
          t: b.atSec,
          prices: bPrices,
          rand: probePrng,
        })
        probeWorld = svHC.afterWorld
        s = probeWorld.state
        probeAllPreByU[u].push(...svHC.validActions)
        for (const va of svHC.validActions) {
          estUrgentFarmEnByU[u] += va.a === 'clear' ? clearCostEnProbe : harvestCostEnProbe
        }
      }

      // (b) Empty-plot `plant` (including plots newly freed by `harvest` / `clear`)
      let unplantedProfitableCount = 0
      if (allowedSet.has('plant') && (u > 0 || enableFirstBucketPlant)) {
        const plantActs = []
        const plantCostEn = R.WORLD?.cost?.plant ?? 2
        let simCash = Number(probeWorld.coins || 0) - Number(constraints.cashReserveFloor || 0)
        for (let i = 0; i < (s.plotN || 0); i++) {
          if (s.plots?.[i]) continue
          const bestP = selectBestCropToPlant(adapter, {
            state: s,
            clockStart: startWorld.clockStart,
            plotIdx: i,
            atSec: b.atSec,
            tEnd: tH,
            marginalItemValueFn,
            staminaPointCost: baseStaminaShadowCost,
            enforceHorizonCutoff: objectiveCfg.terminalSupplyMode === 'zero',
          })
          if (!bestP) continue
          const hasFreeSeed = adapter.availableInv(s, `sd_${bestP.crop.id}`, 0) > 0
          const costCash = hasFreeSeed ? 0 : bestP.crop.seed
          if (costCash > simCash) continue
          const lossPerEn = Math.max(
            1,
            bestP.netRatePerSec * regenStepB +
              (R.seasonOf(R.isleDay(b.atSec + plantCostEn * regenStepB)) !== R.seasonOf(b.isleDay) ? bestP.netPresentValue / plantCostEn : 0)
          )
          if (!ensureProbeUrgentEn((plantActs.length + 1) * plantCostEn, lossPerEn)) {
            unplantedProfitableCount++
            continue
          }
          marginalItemValueFn(bestP.crop.id, 0, b.atSec, {
            reserveUnits: Math.max(1, Math.round(bestP.totalExpectedUnits || 2)),
          })
          plantActs.push({ a: 'plant', i, c: bestP.crop.id })
          if (!R.sprinkled(s, i) && weather !== 1) {
            nonExpiringWaters.push({ i, deltaWaterVal: 0.20 * marginalItemValueFn(bestP.crop.id, 0, b.atSec) })
          }
          simCash -= costCash
        }
        if (plantActs.length > 0) {
          const svP = simulateValidBatch(adapter, probeWorld, plantActs, {
            t: b.atSec,
            prices: bPrices,
            rand: probePrng,
          })
          probeWorld = svP.afterWorld
          s = probeWorld.state
          probeAllPreByU[u].push(...svP.validActions)
          estUrgentFarmEnByU[u] += svP.validActions.length * plantCostEn
        }
      }

      // (c) Hungry barn `feed`
      if (allowedSet.has('feed')) {
        const hungryIndices = []
        for (let i = 0; i < (s.barn?.length || 0); i++) {
          const pen = s.barn[i]
          if (!pen || R.b12AnimalStage(pen, b.atSec).retired) continue
          const hungryAt = pen.f + 86400
          if (b.atSec - pen.f >= 8 * 3600 && (hungryAt <= b.nextAtSec || b.atSec >= hungryAt)) {
            hungryIndices.push(i)
          }
        }
        if (hungryIndices.length > 0 && utilityTokens.feedId) {
          const feedActs = []
          const haveFeed = adapter.availableInv(s, utilityTokens.feedId, 0)
          const needBuy = Math.max(0, hungryIndices.length - haveFeed)
          const feedPrice = Number(R.SHOP?.[utilityTokens.feedId]?.price || 150)
          if (needBuy > 0 && allowedSet.has('buy') && probeWorld.coins - constraints.cashReserveFloor >= needBuy * feedPrice) {
            feedActs.push({ a: 'buy', id: utilityTokens.feedId, n: Math.min(99, needBuy) })
          }
          let fedCount = 0
          for (const idx of hungryIndices) {
            const pen = s.barn[idx]
            const def = graph.animalsById.get(pen?.k)
            const prodVal = def ? marginalItemValueFn(def.product, 0, b.atSec) : 500
            const periodSec = Math.max(3600, R.b12AnimalPeriod?.(pen.k, b.atSec) || 28800)
            const lossPerEn = (prodVal / periodSec) * regenStepB
            if (ensureProbeUrgentEn(fedCount + 1, lossPerEn)) {
              feedActs.push({ a: 'feed', i: idx })
              fedCount++
            }
          }
          if (fedCount > 0) {
            const svF = simulateValidBatch(adapter, probeWorld, feedActs, {
              t: b.atSec,
              prices: bPrices,
              rand: probePrng,
            })
            probeWorld = svF.afterWorld
            s = probeWorld.state
            probeAllPreByU[u].push(...svF.validActions)
            estUrgentFarmEnByU[u] += svF.validActions.filter((a) => a.a === 'feed').length * (R.WORLD?.cost?.feed ?? 1)
          }
        }
      }

      // (d) Manual `water`: expiring stage-end waters first; non-expiring waters ONLY if zero empty plots remain unplanted!
      const waterActs = []
      let neededWEn = 0
      for (const ew of expiringWaters) {
        if (ensureProbeUrgentEn(neededWEn + 1, ew.deltaWaterVal)) {
          waterActs.push({ a: 'water', i: ew.i })
          neededWEn += R.WORLD?.cost?.water ?? 1
        }
      }
      const expiringCountAccepted = waterActs.length
      if (unplantedProfitableCount === 0) {
        const spareEnNow = Math.max(0, Math.floor(Number(probeWorld.state?.en || 0)) - neededWEn)
        for (let k = 0; k < Math.min(spareEnNow, nonExpiringWaters.length); k++) {
          waterActs.push({ a: 'water', i: nonExpiringWaters[k].i })
        }
      }
      if (waterActs.length > 0) {
        const svW = simulateValidBatch(adapter, probeWorld, waterActs, {
          t: b.atSec,
          prices: bPrices,
          rand: probePrng,
        })
        probeWorld = svW.afterWorld
        s = probeWorld.state
        probeAllPreByU[u].push(...svW.validActions)
        estUrgentFarmEnByU[u] += Math.min(expiringCountAccepted, svW.validActions.length) * (R.WORLD?.cost?.water ?? 1)
      }
    }

    // 6. Bundle-Aware Cargo `stockBuy` Allocation (once per isleIndex):
    //    Jointly allocates complete recipe-completion cargo bundles (supporting multi-unit & 2-stage workshop chains
    //    without burning 1 slot per raw unit!), direct raw-resale arbitrage, and stamina/bomb supplies under shared
    //    `(availCoins, cargoLeft, unreservedWorkshopByIsle, curUnreserved, nonCoffeeEn)`!
    if (
      allowedSet.has('stockBuy') &&
      (u > 0 || enableFirstBucketStockBuy) &&
      typeof R.b12Stock === 'function' &&
      !seenCargoIsle.has(b.isleIndex)
    ) {
      seenCargoIsle.add(b.isleIndex)
      const stockList = R.b12Stock(b.atSec, bPrices)
      const bucketDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, b.atSec - t0))
      const cargoPrice = new Map()
      const cargoLeft = new Map()
      const buyTotals = new Map()
      for (const item of stockList) {
        const left = R.b12StockLeft(probeWorld.state, item, b.atSec)
        if (left > 0 && item.price > 0) {
          cargoPrice.set(item.id, Number(item.price))
          cargoLeft.set(item.id, left)
          buyTotals.set(item.id, 0)
        }
      }

      let availCoins = Math.max(0, Number(probeWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      if (cargoPrice.size > 0 && availCoins > 0) {
        const craftEn = R.WORLD?.cost?.craft ?? 1
        const localCargoBuckets = seqBuckets.slice(u)
        const distinctOpenIsles = [...new Set(localCargoBuckets.map((fb) => fb.isleIndex))]
        const distinctNatDays = Math.max(1, new Set(localCargoBuckets.map((fb) => fb.naturalDay)).size)
        const distinctIsles = distinctOpenIsles.length

        // Recompute exact initial craft schedule on `probeWorld` (captures any newly harvested/collected goods in bucket `u`!)
        const curSnapCargo = adapter.availableInvSnapshot(probeWorld.state)
        const probeFreeSlotsByIsle = new Map()
        for (const iIdx of distinctOpenIsles) {
          if (!allowedSet.has('craft')) {
            probeFreeSlotsByIsle.set(iIdx, 0)
          } else {
            const used = iIdx === b.isleIndex && probeWorld.state?.iq?.d === b.isleIndex
              ? Number(probeWorld.state.iq.craft || 0)
              : 0
            probeFreeSlotsByIsle.set(iIdx, Math.max(0, (R.WORLD?.daily?.craft || 80) - used))
          }
        }

        const curUnreserved = {}
        const probeReservedById = {}
        for (const [id, row] of Object.entries(curSnapCargo)) {
          curUnreserved[id] = (row[0] || 0) + (row[1] || 0) + (row[2] || 0)
        }
        for (const [iIdx, slFree] of probeFreeSlotsByIsle.entries()) {
          setUnreservedWorkshop(iIdx, slFree)
        }

        const existingCraftWorkUnits = []
        if (allowedSet.has('craft')) {
          const localEndIdx = u + localCargoBuckets.length - 1
          let subSlots = slots._subSlotsByU?.[u]
          if (!subSlots) {
            if (!slots._subSlotsByU) slots._subSlotsByU = []
            subSlots = slots
              .filter((sl) => sl.availFromBucket >= u)
              .map((sl) => ({
                ...sl,
                availFromBucket: Math.min(Math.max(0, localCargoBuckets.length - 1), Math.max(0, sl.availFromBucket - u)),
              }))
              .filter((sl, idx2, arr2) => !sl.isTerminal || sl.availFromBucket <= localEndIdx - u || idx2 === arr2.length - 1)
            slots._subSlotsByU[u] = subSlots
          }
          const probeCS = solveJointCraftAndSell(adapter, {
            initialSupplyByBucket: [cloneInvSnap(curSnapCargo), ...localCargoBuckets.slice(1).map(() => ({}))],
            buckets: localCargoBuckets,
            slots: subSlots,
            initialNatDay: b.naturalDay,
            initialCnt: probeWorld.state?.cnt || {},
            craftCapByIsle: new Map(probeFreeSlotsByIsle),
            enCapByBucket: Float64Array.from(localCargoBuckets.map((fb) => (probeFreeSlotsByIsle.get(fb.isleIndex) || 0) * craftEn)),
            staminaShadowCost: 0,
            allowCraft: true,
            maxCraftHoldIsleDays,
            revenueOnly: true,
            isPastDeadlineFn,
          })

          const expandedProbeCrafts = []
          for (let relU = 0; relU < localCargoBuckets.length; relU++) {
            const iIdx = localCargoBuckets[relU].isleIndex
            for (const ca of probeCS.craftsByBucket[relU] || []) {
              const nCraft = Number(ca.n || 1)
              setUnreservedWorkshop(iIdx, Math.max(0, (unreservedWorkshopByIsle.get(iIdx) || 0) - nCraft))
              for (let k = 0; k < nCraft; k++) {
                expandedProbeCrafts.push({ id: ca.id, atSec: localCargoBuckets[relU].atSec })
              }
            }
          }

          const simProbeSnap = cloneInvSnap(curSnapCargo)
          const recordRawReserve = (deductedMap) => {
            let opp = 0
            for (const [inId, qArr] of Object.entries(deductedMap)) {
              const totQ = (qArr[0] || 0) + (qArr[1] || 0) + (qArr[2] || 0)
              if (totQ > 0) {
                curUnreserved[inId] = Math.max(0, Number(curUnreserved[inId] || 0) - totQ)
                probeReservedById[inId] = (probeReservedById[inId] || 0) + totQ
                for (let q = 0; q < 3; q++) {
                  if (qArr[q] > 0) opp += qArr[q] * bestDirectUnitValue(inId, q, b.atSec)
                }
              }
            }
            return opp
          }

          for (let idxP = 0; idxP < expandedProbeCrafts.length; idxP++) {
            const entry = expandedProbeCrafts[idxP]
            if (!entry) continue
            const rec = graph.recipesById.get(entry.id)
            if (!rec || !(rec.price > 0)) continue

            const downstreamIdx = expandedProbeCrafts.findIndex((later, lIdx) => {
              if (lIdx <= idxP || !later) return false
              const dRec = graph.recipesById.get(later.id)
              const curMid = (simProbeSnap[entry.id]?.[0] || 0) + (simProbeSnap[entry.id]?.[1] || 0) + (simProbeSnap[entry.id]?.[2] || 0)
              return dRec?.in?.[entry.id] > 0 && curMid < dRec.in[entry.id]
            })

            if (downstreamIdx > idxP) {
              const downEntry = expandedProbeCrafts[downstreamIdx]
              const downRec = graph.recipesById.get(downEntry.id)
              const needUp = downRec.in[entry.id]
              const upIndices = []
              for (let scIdx = idxP; scIdx < downstreamIdx && upIndices.length < needUp; scIdx++) {
                if (expandedProbeCrafts[scIdx]?.id === entry.id) upIndices.push(scIdx)
              }
              if (upIndices.length === needUp) {
                const testSnap = cloneInvSnap(simProbeSnap)
                const rawDedList = []
                let okChain = true
                for (let sStep = 0; sStep < needUp; sStep++) {
                  const d1 = deductRecipeLowStarFirst(testSnap, rec, 1)
                  if (!d1.feasible) { okChain = false; break }
                  rawDedList.push(d1.deducted)
                  testSnap[entry.id] ||= [0, 0, 0]
                  testSnap[entry.id][0] += 1
                }
                if (okChain) {
                  const d2 = deductRecipeLowStarFirst(testSnap, downRec, 1)
                  if (d2.feasible) {
                    Object.assign(simProbeSnap, testSnap)
                    let rawOpp = 0
                    for (const dm of rawDedList) rawOpp += recordRawReserve(dm)
                    const filteredDownDed = { ...d2.deducted }
                    delete filteredDownDed[entry.id]
                    rawOpp += recordRawReserve(filteredDownDed)
                    let outVal = 0
                    for (const sl of slots) {
                      if (!sl.allowSell || sl.atSec + 1 < downEntry.atSec) continue
                      outVal = Math.max(outVal, Number(sl.prices?.[downRec.id] || 0) * sl.disc * sl.netTaxFactor)
                    }
                    if (outVal - rawOpp > 1e-6) {
                      existingCraftWorkUnits.push({ enCost: (needUp + 1) * craftEn, cashCost: 0, netGain: outVal - rawOpp })
                    }
                    for (const ui of upIndices) expandedProbeCrafts[ui] = null
                    expandedProbeCrafts[downstreamIdx] = null
                    continue
                  }
                }
              }
            }

            const ded = deductRecipeLowStarFirst(simProbeSnap, rec, 1)
            if (ded.feasible) {
              const rawOpp = recordRawReserve(ded.deducted)
              let outVal = 0
              for (const sl of slots) {
                if (!sl.allowSell || sl.atSec + 1 < entry.atSec) continue
                outVal = Math.max(outVal, Number(sl.prices?.[rec.id] || 0) * sl.disc * sl.netTaxFactor)
              }
              if (outVal - rawOpp > 1e-6) {
                existingCraftWorkUnits.push({ enCost: craftEn, cashCost: 0, netGain: outVal - rawOpp })
              }
            }
          }
        }

        const curEnNow = Math.max(0, Math.floor(Number(probeWorld.state?.en || 0)))
        const rawEnMaxCargo = Number(R.energyMax(probeWorld.state))
        const enMaxCargo = Number.isFinite(rawEnMaxCargo) && rawEnMaxCargo > 0 ? rawEnMaxCargo : 100
        const lastCraftBucketAt = localCargoBuckets[localCargoBuckets.length - 1]?.nextAtSec ?? b.nextAtSec ?? b.atSec
        const regenEn = Math.max(0, Math.floor((lastCraftBucketAt - (probeWorld.state?.enT || b.atSec)) / (R.WORLD?.regen || 180)))
        const baseFreeEn = curEnNow + regenEn
        const eatStaminaCap = Math.min(220, Math.max(curEnNow, enMaxCargo) * Math.min(2, Math.max(1, localCargoBuckets.length)) + regenEn)

        const coffeePrice = R.WORLD?.coffee?.price || 15000
        const coffeeEn = R.WORLD?.coffee?.energy || 60
        const canTopUpCoffee = allowedSet.has('coffee') && Number(probeWorld.state?.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3)
        const remCoffee = canTopUpCoffee
          ? Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(probeWorld.state?.cnt?.coffee || 0))
          : 0

        const cargoEdibleSpecs = allowedSet.has('eat') && typeof adapter.listDeterministicEdibleSpecs === 'function'
          ? adapter.listDeterministicEdibleSpecs()
          : []

        // Existing unreserved in-inventory food & non-cargo work units (`bomb`, `fish`, `mine`)
        const existingInvEatUnits = []
        for (const sp of cargoEdibleSpecs) {
          if (sp.kind === 'snack') {
            const cnt = Math.min(
              adapter.availableInv(probeWorld.state, sp.id, 0),
              Math.max(0, distinctNatDays * (sp.dailyCap ?? 2) - Number(probeWorld.state?.cnt?.[sp.id] || 0))
            )
            for (let k = 0; k < cnt; k++) {
              existingInvEatUnits.push({ enGain: sp.energyGain, cashCost: 0, netGain: 0, isCoffee: false })
            }
          } else if (sp.q === 0 || sp.q === 1 || sp.q === 2) {
            const row = [
              adapter.availableInv(probeWorld.state, sp.id, 0),
              adapter.availableInv(probeWorld.state, sp.id, 1),
              adapter.availableInv(probeWorld.state, sp.id, 2),
            ]
            let keep = Number(probeReservedById[sp.id] || 0)
            for (let qIdx = 0; qIdx < 3 && keep > 0; qIdx++) {
              const tk = Math.min(row[qIdx], keep)
              row[qIdx] -= tk
              keep -= tk
            }
            const unresQ = Math.min(20, row[sp.q] || 0)
            if (unresQ > 0) {
              const opp = bestDirectUnitValue(sp.id, sp.q, b.atSec)
              for (let k = 0; k < unresQ; k++) {
                existingInvEatUnits.push({ enGain: sp.energyGain, cashCost: 0, netGain: -opp, isCoffee: false })
              }
            }
          }
        }

        let remSnackNeed = (utilityTokens.snackId && allowedSet.has('eat'))
          ? Math.max(
              0,
              distinctNatDays * (R.B12_SNACK?.daily || 2) -
                Number(probeWorld.state?.cnt?.[utilityTokens.snackId] || 0) -
                adapter.availableInv(probeWorld.state, utilityTokens.snackId, 0)
            )
          : 0
        const usedBombInit = probeWorld.state?.iq?.d === b.isleIndex ? Number(probeWorld.state?.iq?.bomb || 0) : 0
        const totalBombQuotaLeft = (utilityTokens.explosiveId && allowedSet.has('bomb'))
          ? Math.max(0, distinctIsles * (R.WORLD?.daily?.bomb || 10) - usedBombInit)
          : 0
        const haveInvBombs = utilityTokens.explosiveId ? adapter.availableInv(probeWorld.state, utilityTokens.explosiveId, 0) : 0
        const useInvBombs = Math.min(haveInvBombs, totalBombQuotaLeft)
        let remBombNeed = Math.max(0, totalBombQuotaLeft - useInvBombs)

        const bombEn = R.WORLD?.cost?.bomb ?? 6
        const bombDropVal = (utilityTokens.explosiveId && allowedSet.has('bomb') && totalBombQuotaLeft > 0)
          ? Object.entries(expectedBombYield(adapter, probeWorld.state, b.isleDay).byOre).reduce(
              (sAcc, [oId, oc]) => sAcc + oc * marginalItemValueFn(oId, 0, b.atSec),
              0
            )
          : 0

        const existingOtherWorkUnits = []
        if (useInvBombs > 0 && bombDropVal > 1e-6) {
          for (let k = 0; k < useInvBombs; k++) {
            existingOtherWorkUnits.push({ enCost: bombEn, cashCost: 0, netGain: bombDropVal })
          }
        }
        const shopBombPrice = utilityTokens.explosiveId ? Number(R.SHOP?.[utilityTokens.explosiveId]?.price || 0) : 0
        if (remBombNeed > 0 && allowedSet.has('buy') && shopBombPrice > 0 && bombDropVal - shopBombPrice * bucketDisc > 1e-6) {
          const cargoBombOffer = cargoPrice.has(utilityTokens.explosiveId) && (cargoPrice.get(utilityTokens.explosiveId) <= shopBombPrice)
            ? Math.min(remBombNeed, cargoLeft.get(utilityTokens.explosiveId) || 0)
            : 0
          const shopBombCap = Math.min(remBombNeed - cargoBombOffer, Math.floor(availCoins / shopBombPrice))
          for (let k = 0; k < shopBombCap; k++) {
            existingOtherWorkUnits.push({ enCost: bombEn, cashCost: shopBombPrice, netGain: bombDropVal - shopBombPrice * bucketDisc })
          }
        }
        if (allowedSet.has('fish')) {
          const usedFish = probeWorld.state?.iq?.d === b.isleIndex ? Number(probeWorld.state.iq.fish || 0) : 0
          const fishLeft = Math.min(20, Math.max(0, distinctIsles * (R.WORLD?.daily?.fish || 80) - usedFish))
          const fishEn = R.WORLD?.cost?.fish ?? 4
          if (fishLeft > 0) {
            const fyBait = expectedFishYieldPerCast(adapter, probeWorld.state, b.atSec, true)
            const fyNoBait = expectedFishYieldPerCast(adapter, probeWorld.state, b.atSec, false)
            const valBait = Object.entries(fyBait.byFish).reduce(
              (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, b.atSec) + qs[1] * marginalItemValueFn(fId, 1, b.atSec) + qs[2] * marginalItemValueFn(fId, 2, b.atSec),
              0
            )
            const valNoBait = Object.entries(fyNoBait.byFish).reduce(
              (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, b.atSec) + qs[1] * marginalItemValueFn(fId, 1, b.atSec) + qs[2] * marginalItemValueFn(fId, 2, b.atSec),
              0
            )
            const haveBait = utilityTokens.baitId ? adapter.availableInv(probeWorld.state, utilityTokens.baitId, 0) : 0
            const baitPrice = utilityTokens.baitId ? Number(R.SHOP?.[utilityTokens.baitId]?.price || 0) : 0
            let fAssigned = 0
            if (utilityTokens.baitId && valBait >= valNoBait && valBait > 1e-6) {
              const nInvB = Math.min(haveBait, fishLeft)
              for (let k = 0; k < nInvB; k++) {
                existingOtherWorkUnits.push({ enCost: fishEn, cashCost: 0, netGain: valBait })
                fAssigned++
              }
              const remF = fishLeft - fAssigned
              if (remF > 0 && allowedSet.has('buy') && baitPrice > 0 && valBait - baitPrice * bucketDisc > Math.max(0, valNoBait)) {
                const nBuyB = Math.min(remF, Math.floor(availCoins / baitPrice))
                for (let k = 0; k < nBuyB; k++) {
                  existingOtherWorkUnits.push({ enCost: fishEn, cashCost: baitPrice, netGain: valBait - baitPrice * bucketDisc })
                  fAssigned++
                }
              }
            }
            const remNB = fishLeft - fAssigned
            if (remNB > 0 && valNoBait > 1e-6) {
              for (let k = 0; k < remNB; k++) {
                existingOtherWorkUnits.push({ enCost: fishEn, cashCost: 0, netGain: valNoBait })
              }
            }
          }
        }
        if (allowedSet.has('mine')) {
          const usedMine = probeWorld.state?.iq?.d === b.isleIndex ? Number(probeWorld.state.iq.mine || 0) : 0
          const mineLeft = Math.min(25, Math.max(0, distinctIsles * (R.WORLD?.daily?.mine || 100) - usedMine))
          const mineEn = R.WORLD?.cost?.mine ?? 3
          if (mineLeft > 0) {
            const my = expectedMineYieldPerHit(adapter, probeWorld.state, b.isleDay)
            const mv = Object.entries(my.byOre).reduce((acc, [oId, oc]) => acc + oc * marginalItemValueFn(oId, 0, b.atSec), 0)
            if (mv > 1e-6) {
              for (let k = 0; k < mineLeft; k++) {
                existingOtherWorkUnits.push({ enCost: mineEn, cashCost: 0, netGain: mv })
              }
            }
          }
        }

        const gcdCargo = (a, b2) => {
          let x = Math.abs(Math.round(a))
          let y = Math.abs(Math.round(b2))
          while (y > 0) {
            const t = x % y
            x = y
            y = t
          }
          return Math.max(1, x)
        }

        const consumeWorkshopSlots = (slotsNeeded) => {
          let rem = slotsNeeded
          for (const iIdx of distinctOpenIsles) {
            if (rem <= 0) break
            const cur = unreservedWorkshopByIsle.get(iIdx) || 0
            if (cur > 0) {
              const tk = Math.min(cur, rem)
              setUnreservedWorkshop(iIdx, Math.max(0, cur - tk))
              rem -= tk
            }
          }
        }

        const committedPassEatUnits = []
        const committedPassWorkUnits = []

        const isRootImmediateBucket = u === 0 && startWorld.now <= t0
        // Unified Stamina × Cash × Workshop-Slots Bounded Knapsack DP across:
        // - Existing stamina-hungry work (`existingCraftWorkUnits` + `bomb`/`fish`/`mine`)
        // - Existing stamina supplies (`inv-eat` + `coffee`)
        // - Cargo edible supplies (`tide_snack` + ALL `q=0` edible crops on `b12Stock`)
        // - Cargo `recipe-bundle`s (1-stage & 2-stage chains), `explosive`s, and `direct` arbitrage!
        for (let pass = 0; pass < (isRootImmediateBucket ? 2 : 1) && availCoins > 0; pass++) {
          const totalOpenSlots = distinctOpenIsles.reduce(
            (sAcc, iIdx) => sAcc + Math.floor((unreservedWorkshopByIsle.get(iIdx) || 0) + 1e-9),
            0
          )
          const S = Math.min(80, totalOpenSlots)
          const bundleUnits = []

          // 1) Marginal copies of Complete Recipe-Completion Cargo Bundles (1-stage & 2-stage workshop chains)
          if (allowedSet.has('craft') && S > 0) {
            for (const rec of R.RECIPES || []) {
              if (!(rec.price > 0)) continue
              const localUnres = { ...curUnreserved }
              const localLeft = new Map(cargoLeft)
              let remSlotsRec = S
              let localAvailCoins = availCoins

              while (remSlotsRec > 0 && localAvailCoins > 0) {
                let slotsNeeded = 1
                const rawNeed = {}
                const midInvUsed = {}
                for (const [inId, reqQty] of Object.entries(rec.in || {})) {
                  const upRec = graph.recipesById.get(inId)
                  if (upRec && !cargoPrice.has(inId)) {
                    const useMid = Math.min(reqQty, localUnres[inId] || 0)
                    if (useMid > 0) midInvUsed[inId] = useMid
                    const missMid = reqQty - useMid
                    if (missMid > 0) {
                      slotsNeeded += missMid
                      for (const [uIn, uQty] of Object.entries(upRec.in || {})) {
                        rawNeed[uIn] = (rawNeed[uIn] || 0) + uQty * missMid
                      }
                    }
                  } else {
                    rawNeed[inId] = (rawNeed[inId] || 0) + reqQty
                  }
                }
                if (slotsNeeded > remSlotsRec) break
                const enNeeded = slotsNeeded * craftEn

                let feasibleBundle = true
                let cashCost = 0
                let invOppCost = 0
                let totalBought = 0
                const buyPlan = {}
                const invPlan = { ...midInvUsed }
                for (const [mId, mQty] of Object.entries(midInvUsed)) {
                  invOppCost += mQty * bestDirectUnitValue(mId, 0, b.atSec)
                }
                for (const [rId, reqQty] of Object.entries(rawNeed)) {
                  const useInv = Math.min(reqQty, localUnres[rId] || 0)
                  const buyN = reqQty - useInv
                  if (buyN > 0) {
                    const cLeft = localLeft.get(rId) || 0
                    const cPrice = cargoPrice.get(rId) || 0
                    if (cLeft < buyN || !(cPrice > 0)) {
                      feasibleBundle = false
                      break
                    }
                    buyPlan[rId] = buyN
                    totalBought += buyN
                    cashCost += buyN * cPrice
                  }
                  if (useInv > 0) {
                    invPlan[rId] = (invPlan[rId] || 0) + useInv
                    invOppCost += useInv * bestDirectUnitValue(rId, 0, b.atSec)
                  }
                }
                if (!feasibleBundle || totalBought <= 0 || cashCost > localAvailCoins) break

                let earliestCraftAt = b.atSec
                for (const fb of seqBuckets.slice(u)) {
                  if ((unreservedWorkshopByIsle.get(fb.isleIndex) || 0) + 1e-9 >= 1) {
                    earliestCraftAt = fb.atSec
                    break
                  }
                }
                let bestRecOut = 0
                for (const sl of slots) {
                  if (!sl.allowSell || sl.atSec + 1 < earliestCraftAt) continue
                  bestRecOut = Math.max(bestRecOut, Number(sl.prices?.[rec.id] || 0) * sl.disc * sl.netTaxFactor)
                }
                const netGain = bestRecOut - (cashCost * bucketDisc + invOppCost)
                if (!(netGain > 1e-6)) break

                bundleUnits.push({
                  kind: 'recipe-bundle',
                  slotsCost: slotsNeeded,
                  enCost: enNeeded,
                  cashCost,
                  netGain,
                  buyPlan,
                  invPlan,
                  isCargo: true,
                })

                localAvailCoins -= cashCost
                remSlotsRec -= slotsNeeded
                for (const [bId, bQty] of Object.entries(buyPlan)) localLeft.set(bId, (localLeft.get(bId) || 0) - bQty)
                for (const [iId, iQty] of Object.entries(invPlan)) localUnres[iId] = Math.max(0, (localUnres[iId] || 0) - iQty)
              }
            }
          }

          const allActiveWorkForEn = [
            ...existingCraftWorkUnits,
            ...existingOtherWorkUnits,
            ...committedPassWorkUnits,
          ]
          const cargoExplosiveUnits = []
          if (utilityTokens.explosiveId && cargoPrice.has(utilityTokens.explosiveId) && remBombNeed > 0) {
            const ePrice = cargoPrice.get(utilityTokens.explosiveId) || 0
            const eLeft = cargoLeft.get(utilityTokens.explosiveId) || 0
            const maxAffordE = ePrice > 0 ? Math.min(eLeft, remBombNeed, Math.floor(availCoins / ePrice)) : 0
            const eNet = bombDropVal - ePrice * bucketDisc
            if (eNet > 1e-6 && maxAffordE > 0) {
              for (let k = 0; k < maxAffordE; k++) {
                cargoExplosiveUnits.push({
                  kind: 'explosive',
                  itemId: utilityTokens.explosiveId,
                  slotsCost: 0,
                  enCost: bombEn,
                  cashCost: ePrice,
                  netGain: eNet,
                  isCargo: true,
                })
              }
            }
          }

          const totalWorkEnDemand =
            allActiveWorkForEn.reduce((acc, w) => acc + w.enCost, 0) +
            bundleUnits.reduce((acc, w) => acc + w.slotsCost * craftEn, 0) +
            cargoExplosiveUnits.reduce((acc, w) => acc + w.enCost, 0)

          const committedEatEn = committedPassEatUnits.reduce((acc, e) => acc + e.enGain, 0)
          const effectiveFreeEn = Math.min(eatStaminaCap, baseFreeEn + committedEatEn)
          const neededExtraEnForWork = Math.max(0, totalWorkEnDemand - effectiveFreeEn)
          let maxConsumerGainPerEn = 0
          if (neededExtraEnForWork > 0) {
            for (const wIt of allActiveWorkForEn) {
              if (wIt.netGain > 0 && wIt.enCost > 0) {
                const r = wIt.netGain / wIt.enCost
                if (r > maxConsumerGainPerEn) maxConsumerGainPerEn = r
              }
            }
            for (const ce of cargoExplosiveUnits) {
              if (ce.netGain > 0 && ce.enCost > 0) {
                const r = ce.netGain / ce.enCost
                if (r > maxConsumerGainPerEn) maxConsumerGainPerEn = r
              }
            }
            for (const bu of bundleUnits) {
              const buEn = Math.max(1, bu.slotsCost * craftEn)
              if (bu.netGain > 0) {
                const r = bu.netGain / buEn
                if (r > maxConsumerGainPerEn) maxConsumerGainPerEn = r
              }
            }
          }

          // 2) Cargo Dual-Use (`eat` vs `direct` mutually exclusive per physical copy!) & `snack` supplies
          const cargoPhase1Units = []
          for (const [itemId, price] of cargoPrice.entries()) {
            const left = cargoLeft.get(itemId) || 0
            if (left <= 0 || price > availCoins) continue
            if (utilityTokens.explosiveId && itemId === utilityTokens.explosiveId) continue
            const maxAfford = Math.min(left, Math.floor(availCoins / price))

            const curEnNowForCargoEat = Math.max(0, Math.floor(Number(probeWorld.state?.en || 0))) + committedEatEn
            const maxEatEnRoomFromCargo = Math.max(
              0,
              Math.min(totalWorkEnDemand, eatStaminaCap) - Math.min(effectiveFreeEn, curEnNowForCargoEat)
            )
            if (utilityTokens.snackId && itemId === utilityTokens.snackId) {
              const snackEn = R.B12_SNACK?.energy || 20
              if (
                !allowedSet.has('eat') ||
                remSnackNeed <= 0 ||
                maxEatEnRoomFromCargo <= 0 ||
                neededExtraEnForWork <= 0 ||
                snackEn * maxConsumerGainPerEn <= price * bucketDisc + 1e-6
              ) {
                continue
              }
              const cnt = Math.min(maxAfford, remSnackNeed, Math.ceil(maxEatEnRoomFromCargo / Math.max(1, snackEn)) + 1)
              for (let k = 0; k < cnt; k++) {
                cargoPhase1Units.push({
                  kind: 'cargo-item',
                  isSnack: true,
                  itemId,
                  cashCost: price,
                  canEat: true,
                  enGain: snackEn,
                  eatGain: -price * bucketDisc,
                  canDirect: false,
                  directGain: 0,
                  isCargo: true,
                })
              }
              continue
            }

            const edibleSp = cargoEdibleSpecs.find((sp) => sp.kind !== 'snack' && sp.id === itemId && sp.q === 0)
            const eatCanImproveWork =
              Boolean(edibleSp) &&
              allowedSet.has('eat') &&
              edibleSp.energyGain > 0 &&
              maxEatEnRoomFromCargo > 0 &&
              neededExtraEnForWork > 0 &&
              edibleSp.energyGain * maxConsumerGainPerEn > price * bucketDisc + 1e-6
            const maxEatCopies = eatCanImproveWork
              ? Math.min(maxAfford, Math.ceil(maxEatEnRoomFromCargo / edibleSp.energyGain) + 1)
              : 0

            const origSc = Number(projectedScOnStartDay[itemId] || 0)
            for (let k = 0; k < maxAfford; k++) {
              const directVal = bestDirectUnitValue(itemId, 0, b.atSec)
              const directGain = directVal - price * bucketDisc
              const canDirect = directGain > 1e-6
              const canEat = k < maxEatCopies
              if (!canDirect && !canEat) break
              cargoPhase1Units.push({
                kind: 'cargo-item',
                isSnack: false,
                itemId,
                cashCost: price,
                canEat,
                enGain: canEat ? edibleSp.energyGain : 0,
                eatGain: -price * bucketDisc,
                canDirect,
                directGain,
                isCargo: true,
              })
              if (canDirect && graph.cropsById.has(itemId)) {
                projectedScOnStartDay[itemId] = origSc + k + 1
              }
            }
            if (graph.cropsById.has(itemId)) projectedScOnStartDay[itemId] = origSc
          }

          const hasAnyCargoCandidate = bundleUnits.length > 0 || cargoExplosiveUnits.length > 0 || cargoPhase1Units.length > 0
          if (!hasAnyCargoCandidate) break

          const shopCoffeeUnits = []
          if (remCoffee > 0 && totalWorkEnDemand > effectiveFreeEn) {
            const maxAffordCoffee = Math.min(remCoffee, Math.floor(availCoins / coffeePrice))
            for (let k = 0; k < maxAffordCoffee; k++) {
              shopCoffeeUnits.push({
                kind: 'shop-coffee',
                enGain: coffeeEn,
                cashCost: coffeePrice,
                netGain: -coffeePrice * bucketDisc,
                isCoffee: true,
                isCargo: false,
              })
            }
          }

          // Compute tight cash-feasible upper bound on workshop slots so `S_eff > 0` ONLY when `availCoins` can actually afford `> S` slots!
          let maxCashFeasibleBundleSlots = 0
          if (bundleUnits.length > 0 && S >= 0) {
            const sortedBySlotCost = [...bundleUnits].sort(
              (a, b2) => (a.cashCost / Math.max(1, a.slotsCost)) - (b2.cashCost / Math.max(1, b2.slotsCost))
            )
            let remCashForSlots = availCoins
            for (const bIt of sortedBySlotCost) {
              if (bIt.cashCost <= remCashForSlots + 1e-9) {
                remCashForSlots -= bIt.cashCost
                maxCashFeasibleBundleSlots += bIt.slotsCost
              }
            }
          }
          const slotsBinding = maxCashFeasibleBundleSlots > S
          const S_eff = slotsBinding ? Math.min(24, S) : 0

          const packBinaryCargoUnits = (list, sameFn, scaleFn) => {
            const out = []
            let idx = 0
            while (idx < list.length) {
              const base = list[idx]
              let run = 1
              while (idx + run < list.length && sameFn(base, list[idx + run])) run++
              let rem = run
              let bPow = 1
              while (rem > 0) {
                const takeN = Math.min(bPow, rem)
                out.push(scaleFn(base, takeN))
                rem -= takeN
                bPow *= 2
              }
              idx += run
            }
            return out
          }

          // Prune zero-cash `inv-eat` and `existing-work` tails that exceed physical stamina cap `eatStaminaCap` / `220`
          // (purely exact: zero-cash items beyond total DP stamina capacity can never be packed!)
          const prunedInvEat = [...existingInvEatUnits].sort(
            (a, b2) => (b2.netGain / Math.max(1, b2.enGain)) - (a.netGain / Math.max(1, a.enGain))
          )
          const boundedInvEat = []
          let accEatEn = 0
          const maxNeededEatEn = Math.max(0, eatStaminaCap - effectiveFreeEn) + 24
          for (const ie of prunedInvEat) {
            if (accEatEn >= maxNeededEatEn) break
            boundedInvEat.push(ie)
            accEatEn += Math.max(1, ie.enGain || 1)
          }
          const bundledInvEat = packBinaryCargoUnits(
            boundedInvEat,
            (a, b2) => a.enGain === b2.enGain && Math.abs(a.netGain - b2.netGain) <= 1e-9,
            (base, n) => ({
              enGain: base.enGain * n,
              cashCost: 0,
              unitCash: 0,
              bundleCount: n,
              netGain: base.netGain * n,
              isCoffee: false,
              kind: 'inv-eat',
              isCargo: false,
            })
          )

          const paidActiveWorkRaw = allActiveWorkForEn
            .filter((x) => (x.cashCost || 0) > 0)
            .sort((a, b2) => (a.cashCost - b2.cashCost) || (a.enCost - b2.enCost) || (b2.netGain - a.netGain))
          const bundledPaidWork = packBinaryCargoUnits(
            paidActiveWorkRaw,
            (a, b2) => a.enCost === b2.enCost && a.cashCost === b2.cashCost && Math.abs(a.netGain - b2.netGain) <= 1e-9,
            (base, n) => ({
              enCost: base.enCost * n,
              cashCost: base.cashCost * n,
              unitCash: base.cashCost,
              bundleCount: n,
              netGain: base.netGain * n,
              kind: 'existing-work',
              isCargo: false,
            })
          )

          const freeActiveWork = allActiveWorkForEn
            .filter((x) => !(x.cashCost > 0))
            .sort((a, b2) => (b2.netGain / Math.max(1, b2.enCost)) - (a.netGain / Math.max(1, a.enCost)))
          const boundedFreeWork = []
          let accFreeWorkEn = 0
          for (const fw of freeActiveWork) {
            if (accFreeWorkEn >= 220) break
            boundedFreeWork.push(fw)
            accFreeWorkEn += Math.max(1, fw.enCost || 1)
          }
          const bundledFreeWork = packBinaryCargoUnits(
            boundedFreeWork,
            (a, b2) => a.enCost === b2.enCost && Math.abs(a.netGain - b2.netGain) <= 1e-9,
            (base, n) => ({
              enCost: base.enCost * n,
              cashCost: 0,
              unitCash: 0,
              bundleCount: n,
              netGain: base.netGain * n,
              kind: 'existing-work',
              isCargo: false,
            })
          )

          const packDualPartitionCargoUnits = (list, sameFn, scaleFn) => {
            const out = []
            let idx = 0
            while (idx < list.length) {
              const base = list[idx]
              let run = 1
              while (idx + run < list.length && sameFn(base, list[idx + run])) run++
              if (base.canEat && base.canDirect) {
                // Exact 2-partition binary decomposition `[1, 1, 1, 2, 2, 4, 4, ...]` represents every `(kEat, kDirect)` with `kEat + kDirect <= run`!
                let rem = run
                if (rem > 0) {
                  out.push(scaleFn(base, 1))
                  rem -= 1
                }
                for (let bPow = 1; rem > 0; bPow *= 2) {
                  for (let rep = 0; rep < 2 && rem > 0; rep++) {
                    const takeN = Math.min(bPow, rem)
                    out.push(scaleFn(base, takeN))
                    rem -= takeN
                  }
                }
              } else {
                let rem = run
                let bPow = 1
                while (rem > 0) {
                  const takeN = Math.min(bPow, rem)
                  out.push(scaleFn(base, takeN))
                  rem -= takeN
                  bPow *= 2
                }
              }
              idx += run
            }
            return out
          }

          const bundledCargoP1 = packDualPartitionCargoUnits(
            cargoPhase1Units,
            (a, b2) =>
              a.itemId === b2.itemId &&
              a.isSnack === b2.isSnack &&
              a.canEat === b2.canEat &&
              a.canDirect === b2.canDirect &&
              a.enGain === b2.enGain &&
              a.cashCost === b2.cashCost &&
              Math.abs(a.eatGain - b2.eatGain) <= 1e-9 &&
              Math.abs(a.directGain - b2.directGain) <= 1e-9,
            (base, n) =>
              n === 1
                ? { ...base, unitCash: base.cashCost, bundleCount: 1, baseUnit: base }
                : {
                    ...base,
                    cashCost: base.cashCost * n,
                    enGain: base.enGain * n,
                    eatGain: base.eatGain * n,
                    directGain: base.directGain * n,
                    unitCash: base.cashCost,
                    bundleCount: n,
                    baseUnit: base,
                  }
          )

          const bundledCargoExplosive = packBinaryCargoUnits(
            cargoExplosiveUnits,
            (a, b2) =>
              a.itemId === b2.itemId &&
              a.enCost === b2.enCost &&
              a.cashCost === b2.cashCost &&
              Math.abs(a.netGain - b2.netGain) <= 1e-9,
            (base, n) =>
              n === 1
                ? { ...base, unitCash: base.cashCost, bundleCount: 1, baseUnit: base }
                : {
                    ...base,
                    enCost: base.enCost * n,
                    cashCost: base.cashCost * n,
                    netGain: base.netGain * n,
                    unitCash: base.cashCost,
                    bundleCount: n,
                    baseUnit: base,
                  }
          )

          const bundledRecipeUnits = packBinaryCargoUnits(
            bundleUnits,
            (a, b2) =>
              a.slotsCost === b2.slotsCost &&
              a.enCost === b2.enCost &&
              a.cashCost === b2.cashCost &&
              Math.abs(a.netGain - b2.netGain) <= 1e-9 &&
              JSON.stringify(a.buyPlan) === JSON.stringify(b2.buyPlan) &&
              JSON.stringify(a.invPlan) === JSON.stringify(b2.invPlan),
            (base, n) =>
              n === 1
                ? { ...base, unitCash: base.cashCost, bundleCount: 1, baseUnit: base }
                : {
                    ...base,
                    slotsCost: base.slotsCost * n,
                    enCost: base.enCost * n,
                    cashCost: base.cashCost * n,
                    netGain: base.netGain * n,
                    unitCash: base.cashCost,
                    bundleCount: n,
                    baseUnit: base,
                  }
          )

          const phase1SupplyAndDual = [
            ...bundledInvEat,
            ...shopCoffeeUnits.map((x) => ({ ...x, unitCash: x.cashCost, bundleCount: 1 })),
            ...bundledCargoP1,
          ]
          const phase2NonSlotWork = [
            ...bundledPaidWork,
            ...bundledCargoExplosive,
            ...(slotsBinding ? [] : bundledRecipeUnits),
          ]
          const phase3SlotBundles = slotsBinding ? bundledRecipeUnits : []

          const allCargoDpItems = [...phase1SupplyAndDual, ...phase2NonSlotWork, ...phase3SlotBundles]
          const totalMaxDpCashSpend = allCargoDpItems.reduce((acc, it) => acc + Number(it.cashCost || 0), 0)
          const demandedCargoQty = new Map()
          for (const bu of bundleUnits) {
            for (const [bId, bQty] of Object.entries(bu.buyPlan || {})) {
              demandedCargoQty.set(bId, (demandedCargoQty.get(bId) || 0) + bQty)
            }
          }
          for (const ce of cargoExplosiveUnits) {
            demandedCargoQty.set(ce.itemId, (demandedCargoQty.get(ce.itemId) || 0) + 1)
          }
          for (const cp of cargoPhase1Units) {
            demandedCargoQty.set(cp.itemId, (demandedCargoQty.get(cp.itemId) || 0) + 1)
          }
          let maxPhysicalCargoCash = 0
          for (const [cId, demQ] of demandedCargoQty.entries()) {
            const cP = cargoPrice.get(cId) || 0
            const cL = Math.min(demQ, cargoLeft.get(cId) || 0, cP > 0 ? Math.floor(availCoins / cP) : 0)
            if (cL > 0 && cP > 0) maxPhysicalCargoCash += cL * cP
          }
          const maxNonCargoDpCash =
            shopCoffeeUnits.reduce((sAcc, x) => sAcc + Number(x.cashCost || 0), 0) +
            paidActiveWorkRaw.reduce((sAcc, x) => sAcc + Number(x.cashCost || 0), 0)
          const trueMaxSpendableCash = Math.min(totalMaxDpCashSpend, maxPhysicalCargoCash + maxNonCargoDpCash)
          const cashBinding = trueMaxSpendableCash > availCoins + 1e-9

          let rawGcd = 0
          if (cashBinding) {
            for (const it of allCargoDpItems) {
              const uCash = Number(it.unitCash ?? it.cashCost ?? 0)
              if (uCash > 0) rawGcd = rawGcd === 0 ? uCash : gcdCargo(rawGcd, uCash)
            }
          }
          if (rawGcd <= 0) rawGcd = 1
          const maxCashCells = isRootImmediateBucket ? (S_eff > 0 ? 250 : 800) : (S_eff > 0 ? 80 : 140)
          const cashUnit = !cashBinding
            ? 1
            : Math.floor(availCoins / rawGcd) > maxCashCells
              ? Math.max(1, Math.ceil(availCoins / maxCashCells))
              : rawGcd
          const C = cashBinding ? Math.max(0, Math.floor(availCoins / cashUnit)) : 0

          let maxFoodEnAdd = 0
          let maxCoffeeEnAdd = 0
          for (const p1 of phase1SupplyAndDual) {
            if (p1.isCoffee) maxCoffeeEnAdd += Number(p1.enGain || 0)
            else if (p1.kind === 'cargo-item') {
              if (p1.canEat) maxFoodEnAdd += Number(p1.enGain || 0)
            } else {
              maxFoodEnAdd += Number(p1.enGain || 0)
            }
          }
          const maxReachableEn = Math.min(eatStaminaCap, effectiveFreeEn + maxFoodEnAdd) + maxCoffeeEnAdd
          const E = Math.min(220, maxReachableEn, Math.max(effectiveFreeEn, totalWorkEnDemand))
          const stride = C + 1
          const sliceSize = (E + 1) * stride
          const bestFreeWorkAtMost = new Float64Array(E + 1)
          for (let i = 0; i < bundledFreeWork.length; i++) {
            const fw = bundledFreeWork[i]
            const cEn = fw.enCost || 0
            if (cEn <= 0) {
              if (fw.netGain > 0) {
                for (let e = 0; e <= E; e++) bestFreeWorkAtMost[e] += fw.netGain
              }
              continue
            }
            if (cEn > E) continue
            const gain = fw.netGain
            for (let e = E; e >= cEn; e--) {
              const cand = bestFreeWorkAtMost[e - cEn] + gain
              if (cand > bestFreeWorkAtMost[e]) bestFreeWorkAtMost[e] = cand
            }
          }
          if (cashBinding && isRootImmediateBucket) {
            recordCashGrid('cargo-stamina-slots-dp', cashUnit, rawGcd, (S_eff + 1) * sliceSize)
          }

          const NEG_INF = -1e18
          const dp1 = new Float64Array(sliceSize)
          dp1.fill(NEG_INF)
          const minP1E = Math.min(E, effectiveFreeEn)
          let maxReachableE = minP1E
          dp1[minP1E * stride] = 0
          let maxReachableC = 0

          const firstCargoP1 = phase1SupplyAndDual.findIndex((x) => x.isCargo)
          const hasCargoP1 = firstCargoP1 >= 0
          const prevP1 = phase1SupplyAndDual.map((_, idx) =>
            hasCargoP1 && idx >= firstCargoP1 ? new Int32Array(sliceSize) : null
          )
          for (let i = 0; i < phase1SupplyAndDual.length; i++) {
            const it = phase1SupplyAndDual[i]
            const uCash = Number(it.unitCash ?? it.cashCost ?? 0)
            const bCnt = Number(it.bundleCount || 1)
            const cCost = cashBinding && uCash > 0 ? bCnt * Math.ceil(uCash / cashUnit) : 0
            if (cCost > C) continue
            const pArr = prevP1[i]
            const cStart = Math.min(maxReachableC, C - cCost)
            const eStart = maxReachableE

            if (it.kind === 'cargo-item') {
              const capE = Math.min(E, eatStaminaCap)
              if (!it.canEat && it.canDirect) {
                for (let srcC = cStart; srcC >= 0; srcC--) {
                  const dstC = srcC + cCost
                  for (let srcE = eStart; srcE >= minP1E; srcE--) {
                    const srcIdx = srcE * stride + srcC
                    const srcVal = dp1[srcIdx]
                    if (srcVal <= -1e17) continue
                    const dstIdx = srcE * stride + dstC
                    const candVal = srcVal + it.directGain
                    if (candVal > dp1[dstIdx] + 1e-6) {
                      dp1[dstIdx] = candVal
                      if (pArr) pArr[dstIdx] = (srcIdx + 1) * 2 + 1
                    }
                  }
                }
              } else {
                for (let srcC = cStart; srcC >= 0; srcC--) {
                  const dstC = srcC + cCost
                  for (let srcE = eStart; srcE >= minP1E; srcE--) {
                    const srcIdx = srcE * stride + srcC
                    const srcVal = dp1[srcIdx]
                    if (srcVal <= -1e17) continue
                    if (it.canEat) {
                      const newE = Math.min(capE, Math.max(srcE, srcE + it.enGain))
                      const dstIdx = newE * stride + dstC
                      const candVal = srcVal + it.eatGain
                      if (candVal > dp1[dstIdx] + 1e-6) {
                        dp1[dstIdx] = candVal
                        if (pArr) pArr[dstIdx] = (srcIdx + 1) * 2
                      }
                    }
                    if (it.canDirect) {
                      const dstIdx = srcE * stride + dstC
                      const candVal = srcVal + it.directGain
                      if (candVal > dp1[dstIdx] + 1e-6) {
                        dp1[dstIdx] = candVal
                        if (pArr) pArr[dstIdx] = (srcIdx + 1) * 2 + 1
                      }
                    }
                  }
                }
                if (it.canEat && it.enGain > 0) {
                  maxReachableE = Math.max(maxReachableE, Math.min(capE, eStart + it.enGain))
                }
              }
            } else {
              const capE = it.isCoffee ? E : Math.min(E, eatStaminaCap)
              for (let srcE = eStart; srcE >= minP1E; srcE--) {
                const newE = Math.min(capE, Math.max(srcE, srcE + it.enGain))
                for (let srcC = cStart; srcC >= 0; srcC--) {
                  if (newE === srcE && cCost === 0) continue
                  const srcIdx = srcE * stride + srcC
                  const srcVal = dp1[srcIdx]
                  if (srcVal <= -1e17) continue
                  const dstIdx = newE * stride + (srcC + cCost)
                  const candVal = srcVal + it.netGain
                  if (candVal > dp1[dstIdx] + 1e-6) {
                    dp1[dstIdx] = candVal
                    if (pArr) pArr[dstIdx] = (srcIdx + 1) * 2
                  }
                }
              }
              if (it.enGain > 0) {
                maxReachableE = Math.max(maxReachableE, Math.min(capE, eStart + it.enGain))
              }
            }
            if (cCost > 0) maxReachableC = Math.min(C, maxReachableC + cCost)
          }

          const firstCargoP2 = phase2NonSlotWork.findIndex((x) => x.isCargo)
          const needTraceP2From = hasCargoP1 ? 0 : (firstCargoP2 >= 0 ? firstCargoP2 : phase2NonSlotWork.length)
          const prevP2 = phase2NonSlotWork.map((_, idx) =>
            idx >= needTraceP2From ? new Int32Array(sliceSize) : null
          )
          for (let i = 0; i < phase2NonSlotWork.length; i++) {
            const it = phase2NonSlotWork[i]
            const cEn = it.enCost || 0
            const uCash = Number(it.unitCash ?? it.cashCost ?? 0)
            const bCnt = Number(it.bundleCount || 1)
            const cCost = cashBinding && uCash > 0 ? bCnt * Math.ceil(uCash / cashUnit) : 0
            if (cEn > E || cCost > C) continue
            const pArr = prevP2[i]
            const cMaxDst = Math.min(C, maxReachableC + cCost)
            const eMaxDst = Math.min(E, maxReachableE) - cEn
            for (let newE = 0; newE <= eMaxDst; newE++) {
              const srcRow = (newE + cEn) * stride
              const dstRow = newE * stride
              for (let newC = cMaxDst; newC >= cCost; newC--) {
                const srcC = newC - cCost
                const srcIdx = srcRow + srcC
                const srcVal = dp1[srcIdx]
                if (srcVal <= -1e17) continue
                const dstIdx = dstRow + newC
                const candVal = srcVal + it.netGain
                if (candVal > dp1[dstIdx] + 1e-6) {
                  dp1[dstIdx] = candVal
                  if (pArr) pArr[dstIdx] = srcIdx + 1
                }
              }
            }
            if (cCost > 0) maxReachableC = Math.min(C, maxReachableC + cCost)
          }

          const pushChosenCargoExpanded = (item, chosenMode) => {
            const base = item.baseUnit || item
            const cnt = Number(item.bundleCount || 1)
            for (let k = 0; k < cnt; k++) {
              chosenCargo.push({ ...base, chosenMode })
            }
          }

          const chosenCargo = []
          if (phase3SlotBundles.length > 0) {
            const totalCells3 = (S_eff + 1) * sliceSize
            const dp3 = new Float64Array(totalCells3)
            dp3.fill(NEG_INF)
            dp3.set(dp1, 0)
            const prevP3 = phase3SlotBundles.map(() => new Int32Array(totalCells3))

            let maxReachableS = 0
            for (let i = 0; i < phase3SlotBundles.length; i++) {
              const it = phase3SlotBundles[i]
              const sCost = it.slotsCost
              const cEn = it.enCost || 0
              const uCash = Number(it.unitCash ?? it.cashCost ?? 0)
              const bCnt = Number(it.bundleCount || 1)
              const cCost = cashBinding && uCash > 0 ? bCnt * Math.ceil(uCash / cashUnit) : 0
              if (sCost > S_eff || cEn > maxReachableE || cCost > C) continue
              const pArr = prevP3[i]
              const cMaxDst = Math.min(C, maxReachableC + cCost)
              const sMaxDst = Math.min(S_eff, maxReachableS + sCost)
              const eMaxDst = Math.min(E, maxReachableE) - cEn
              for (let newS = sMaxDst; newS >= sCost; newS--) {
                const srcSOff = (newS - sCost) * sliceSize
                const dstSOff = newS * sliceSize
                for (let newE = 0; newE <= eMaxDst; newE++) {
                  const srcERow = srcSOff + (newE + cEn) * stride
                  const dstERow = dstSOff + newE * stride
                  for (let newC = cMaxDst; newC >= cCost; newC--) {
                    const srcIdx = srcERow + (newC - cCost)
                    const srcVal = dp3[srcIdx]
                    if (srcVal <= -1e17) continue
                    const dstIdx = dstERow + newC
                    const candVal = srcVal + it.netGain
                    if (candVal > dp3[dstIdx] + 1e-6) {
                      dp3[dstIdx] = candVal
                      pArr[dstIdx] = srcIdx + 1
                    }
                  }
                }
              }
              if (cCost > 0) maxReachableC = Math.min(C, maxReachableC + cCost)
              maxReachableS = sMaxDst
            }

            const initRemE = Math.min(E, effectiveFreeEn)
            let bestIdx3 = initRemE * stride
            let bestVal3 = dp3[bestIdx3] + bestFreeWorkAtMost[initRemE]
            let idx = 0
            for (let s = 0; s <= S_eff; s++) {
              for (let remE = 0; remE <= E; remE++) {
                const fwGain = bestFreeWorkAtMost[remE]
                for (let c = 0; c < stride; c++, idx++) {
                  const v = dp3[idx]
                  if (v > -1e17) {
                    const tot = v + fwGain
                    if (tot > bestVal3 + 1e-6) {
                      bestVal3 = tot
                      bestIdx3 = idx
                    }
                  }
                }
              }
            }
            let curIdx = bestIdx3
            for (let i = phase3SlotBundles.length - 1; i >= 0; i--) {
              const code = prevP3[i][curIdx]
              if (code > 0) {
                pushChosenCargoExpanded(phase3SlotBundles[i], 'recipe-bundle')
                curIdx = code - 1
              }
            }
            // Now `curIdx` is in slice `s = 0` (`0 <= curIdx < sliceSize`)!
            for (let i = phase2NonSlotWork.length - 1; i >= needTraceP2From; i--) {
              const code = prevP2[i][curIdx]
              if (code > 0) {
                if (phase2NonSlotWork[i].isCargo) {
                  pushChosenCargoExpanded(phase2NonSlotWork[i], phase2NonSlotWork[i].kind)
                }
                curIdx = code - 1
              }
            }
            if (hasCargoP1) {
              for (let i = phase1SupplyAndDual.length - 1; i >= firstCargoP1; i--) {
                const code = prevP1[i][curIdx]
                if (code > 0) {
                  const isDirect = (code & 1) === 1
                  const srcIdx = ((code - (code & 1)) / 2) - 1
                  if (phase1SupplyAndDual[i].isCargo) {
                    pushChosenCargoExpanded(phase1SupplyAndDual[i], isDirect ? 'direct' : 'cargo-eat')
                  }
                  curIdx = srcIdx
                }
              }
            }
          } else {
            const initRemE = Math.min(E, effectiveFreeEn)
            let bestIdx1 = initRemE * stride
            let bestVal1 = dp1[bestIdx1] + bestFreeWorkAtMost[initRemE]
            let idx = 0
            for (let remE = 0; remE <= E; remE++) {
              const fwGain = bestFreeWorkAtMost[remE]
              for (let c = 0; c < stride; c++, idx++) {
                const v = dp1[idx]
                if (v > -1e17) {
                  const tot = v + fwGain
                  if (tot > bestVal1 + 1e-6) {
                    bestVal1 = tot
                    bestIdx1 = idx
                  }
                }
              }
            }
            let curIdx = bestIdx1
            for (let i = phase2NonSlotWork.length - 1; i >= needTraceP2From; i--) {
              const code = prevP2[i][curIdx]
              if (code > 0) {
                if (phase2NonSlotWork[i].isCargo) {
                  pushChosenCargoExpanded(phase2NonSlotWork[i], phase2NonSlotWork[i].kind)
                }
                curIdx = code - 1
              }
            }
            if (hasCargoP1) {
              for (let i = phase1SupplyAndDual.length - 1; i >= firstCargoP1; i--) {
                const code = prevP1[i][curIdx]
                if (code > 0) {
                  const isDirect = (code & 1) === 1
                  const srcIdx = ((code - (code & 1)) / 2) - 1
                  if (phase1SupplyAndDual[i].isCargo) {
                    pushChosenCargoExpanded(phase1SupplyAndDual[i], isDirect ? 'direct' : 'cargo-eat')
                  }
                  curIdx = srcIdx
                }
              }
            }
          }

          if (chosenCargo.length === 0) break

          // Apply `cargo-eat` first (powers high-margin work), then `recipe-bundle`, `explosive`, `direct`
          const modeRank = { 'cargo-eat': 0, 'recipe-bundle': 1, explosive: 2, direct: 3 }
          chosenCargo.sort((a, b2) =>
            ((modeRank[a.chosenMode] ?? 9) - (modeRank[b2.chosenMode] ?? 9)) ||
            ((b2.netGain ?? b2.directGain ?? 0) - (a.netGain ?? a.directGain ?? 0))
          )

          let appliedCount = 0
          let skippedAny = false
          for (const cu of chosenCargo) {
            if (cu.cashCost > availCoins) { skippedAny = true; continue }
            if (cu.chosenMode === 'recipe-bundle') {
              let ok = true
              for (const [bId, bQty] of Object.entries(cu.buyPlan)) {
                if ((cargoLeft.get(bId) || 0) < bQty) { ok = false; break }
              }
              if (ok) {
                for (const [iId, iQty] of Object.entries(cu.invPlan)) {
                  if ((curUnreserved[iId] || 0) < iQty) { ok = false; break }
                }
              }
              const remOpen = distinctOpenIsles.reduce((acc, idx2) => acc + (unreservedWorkshopByIsle.get(idx2) || 0), 0)
              if (!ok || remOpen + 1e-9 < cu.slotsCost) { skippedAny = true; continue }
              availCoins -= cu.cashCost
              for (const [bId, bQty] of Object.entries(cu.buyPlan)) {
                cargoLeft.set(bId, (cargoLeft.get(bId) || 0) - bQty)
                buyTotals.set(bId, (buyTotals.get(bId) || 0) + bQty)
              }
              for (const [iId, iQty] of Object.entries(cu.invPlan)) {
                curUnreserved[iId] = Math.max(0, (curUnreserved[iId] || 0) - iQty)
              }
              consumeWorkshopSlots(cu.slotsCost)
              committedPassWorkUnits.push({ enCost: cu.enCost, cashCost: 0, netGain: cu.netGain })
              appliedCount++
            } else {
              const leftNow = cargoLeft.get(cu.itemId) || 0
              if (leftNow <= 0) { skippedAny = true; continue }
              if (cu.chosenMode === 'cargo-eat' && cu.isSnack && remSnackNeed <= 0) { skippedAny = true; continue }
              if (cu.chosenMode === 'explosive' && remBombNeed <= 0) { skippedAny = true; continue }
              availCoins -= cu.cashCost
              cargoLeft.set(cu.itemId, leftNow - 1)
              buyTotals.set(cu.itemId, (buyTotals.get(cu.itemId) || 0) + 1)
              if (cu.chosenMode === 'cargo-eat') {
                if (cu.isSnack) remSnackNeed--
                committedPassEatUnits.push({ enGain: cu.enGain })
              } else if (cu.chosenMode === 'explosive') {
                remBombNeed--
                committedPassWorkUnits.push({ enCost: cu.enCost, cashCost: 0, netGain: cu.netGain })
              } else if (graph.cropsById.has(cu.itemId)) {
                projectedScOnStartDay[cu.itemId] = Number(projectedScOnStartDay[cu.itemId] || 0) + 1
              }
              appliedCount++
            }
          }

          if (appliedCount === 0 || !skippedAny) break
        }

        const cargoActs = []
        for (const item of stockList) {
          const buyQty = buyTotals.get(item.id) || 0
          if (buyQty > 0) {
            cargoActs.push({ a: 'stockBuy', id: item.id, n: buyQty, day: b.isleDay })
          }
        }
        if (cargoActs.length > 0) {
          const sv3 = simulateValidBatch(adapter, probeWorld, cargoActs, {
            t: b.atSec,
            prices: bPrices,
            rand: probePrng,
          })
          probeWorld = sv3.afterWorld
          cargoPreByU[u].push(...sv3.validActions)
          probeAllPreByU[u].push(...sv3.validActions)
        }
      }
    }

    // 7. Claim any completed daily goals (0 stamina), including the `k = 4` all-clear bonus
    if (allowedSet.has('goal') && typeof R.dailyGoals === 'function') {
      const goalActs = collectClaimableGoalActions(R, b.naturalDay, probeWorld.state)
      if (goalActs.length > 0) {
        const svG = simulateValidBatch(adapter, probeWorld, goalActs, {
          t: b.atSec,
          prices: bPrices,
          rand: probePrng,
        })
        probeWorld = svG.afterWorld
        goalPreByU[u].push(...svG.validActions)
        probeAllPreByU[u].push(...svG.validActions)
      }
    }

    enAfterPreByU[u] = Number(probeWorld.state?.en || 0)
  }

  // Reconstruct exact net incremental available inventory arriving at each bucket u = 0..L-1
  // by diffing `availableInvSnapshot` after `probeAllPreByU[u]` against the previous bucket's post-state!
  {
    let trackWorld = adapter.cloneWorld(startWorld)
    let prevSnap = {}
    for (let u = 0; u < L; u++) {
      const b = seqBuckets[u]
      const bPrices = estPricesByU[u] || {}
      trackWorld = adapter.advanceTimeOnly(trackWorld, b.atSec, { futurePrices: bPrices })
      trackWorld = applyExogenousArrivals(trackWorld, b.exogenousArrivalsAtStart)
      if (raidIntLootByU[u].length > 0) {
        trackWorld = applyExogenousArrivals(trackWorld, raidIntLootByU[u])
      }
      if (probeVirtualEnByU[u] > 0) {
        trackWorld.state.en = Math.max(0, Math.floor(Number(trackWorld.state?.en || 0))) + probeVirtualEnByU[u]
      }
      if (probeCoffeeCashByU[u] > 0) {
        trackWorld.coins = Math.max(0, Number(trackWorld.coins || 0) - probeCoffeeCashByU[u])
      }
      if (probeAllPreByU[u].length > 0) {
        trackWorld = simulateValidBatch(adapter, trackWorld, probeAllPreByU[u], { t: b.atSec, prices: bPrices, rand: trackPrng }).afterWorld
      }
      const curSnap = adapter.availableInvSnapshot(trackWorld.state)
      for (const [id, row] of Object.entries(curSnap)) {
        const pRow = prevSnap[id] || [0, 0, 0]
        for (let q = 0; q < 3; q++) {
          const delta = Math.max(0, (row[q] || 0) - (pRow[q] || 0))
          if (delta > 0) addSupply(u, id, q, delta)
        }
      }
      prevSnap = curSnap
      enAfterPreByU[u] = Math.max(0, Number(trackWorld.state?.en || 0) - probeVirtualEnByU[u])
    }
  }

  // Step C: Solve multi-bucket joint Craft + Sell across buckets `0..L-1` (plus post-`tH` continuation craft buckets)
  // to reserve scarce craft slots & raw inputs for higher-margin future/off-season peaks!
  const craftEnForJoint = R.WORLD?.cost?.craft ?? 1
  const jointBuckets = [...seqBuckets, ...contCraftBuckets]
  const jointSupplyByBucket = [...supplyByBucket, ...contCraftBuckets.map(() => ({}))]
  const jointCraftCapByIsle = new Map(craftCapByIsle)
  for (const cb of contCraftBuckets) {
    if (!jointCraftCapByIsle.has(cb.isleIndex)) {
      jointCraftCapByIsle.set(cb.isleIndex, allowedSet.has('craft') ? (R.WORLD?.daily?.craft || 80) : 0)
    }
  }
  const jointEnAfterPre = Float64Array.from(jointBuckets.map((b2, idx2) =>
    idx2 < L
      ? Math.max(enAfterPreByU[idx2] || 0, (jointCraftCapByIsle.get(b2.isleIndex) || 0) * craftEnForJoint)
      : (jointCraftCapByIsle.get(b2.isleIndex) || 0) * craftEnForJoint
  ))
  const jointMaxHoldDays = contCraftBuckets.length > 0 && jointBuckets.length > 0
    ? Math.max(maxCraftHoldIsleDays || 3, (jointBuckets[jointBuckets.length - 1].isleDayOffset || 0) + 1)
    : maxCraftHoldIsleDays
  const jointCS = solveJointCraftAndSell(adapter, {
    initialSupplyByBucket: jointSupplyByBucket,
    buckets: jointBuckets,
    slots: jointSlots,
    initialNatDay: R.worldDay(startWorld.now),
    initialCnt: startWorld.state?.cnt || {},
    craftCapByIsle: jointCraftCapByIsle,
    enCapByBucket: jointEnAfterPre,
    staminaShadowCost: 0,
    allowCraft: allowedSet.has('craft'),
    maxCraftHoldIsleDays: jointMaxHoldDays,
    isPastDeadlineFn,
  })

  // Step D: Unified Integer Bounded Knapsack Stamina Competition + Exact Marginal Stamina Top-Up (`eat` / `coffee`)!
  // Every stamina-consuming unit (`craft`, `bomb`, `fish`, `mine`) competes simultaneously in a single 1D DP
  // with ZERO hardcoded action priority order!
  const finalBucketActions = seqBuckets.map(() => [])
  let execWorld = adapter.cloneWorld(startWorld)
  const cashEvents = [...initialCashEvents]
  const execSoldByIsle = new Map(initialSoldByIsle)
  const edibleSpecs = typeof adapter.listDeterministicEdibleSpecs === 'function'
    ? adapter.listDeterministicEdibleSpecs()
    : []

  const bestFishEvInIsle = new Map()
  if (allowedSet.has('fish')) {
    for (let u = 0; u < L; u++) {
      const b = seqBuckets[u]
      const fy = expectedFishYieldPerCast(adapter, startWorld.state, b.atSec, true)
      const ev = Object.entries(fy.byFish).reduce(
        (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, b.atSec) + qs[1] * marginalItemValueFn(fId, 1, b.atSec) + qs[2] * marginalItemValueFn(fId, 2, b.atSec),
        0
      )
      bestFishEvInIsle.set(b.isleIndex, Math.max(bestFishEvInIsle.get(b.isleIndex) || 0, ev))
    }
  }

  let u0MarginalStaminaMeta = null
  const raidTransitionsByBucket = seqBuckets.map(() => [])
  const bucketPlannedPostEnFloor = new Int32Array(L)
  const globalRecipeInputSet = new Set()
  for (const rec of R.RECIPES || []) {
    for (const inId of Object.keys(rec.in || {})) globalRecipeInputSet.add(inId)
  }

  const makeInfeasibleRaidReturn = () => ({
    raidScheduleInfeasible: true,
    raidTransitionsByBucket,
    bucketPlannedPostEnFloor,
    bucketActions: finalBucketActions,
    worldAfterSequence: execWorld,
    finalWorldAtHorizon: execWorld,
    cashEvents: [],
    soldByIsle: execSoldByIsle,
    objectiveEval: { totalObjectiveValue: -Infinity },
    discretizationMeta,
    marginalContext: null,
  })

  for (let u = 0; u < L; u++) {
    const b = seqBuckets[u]
    const dynamicPrices = pricesForBucketFn(b, execSoldByIsle)
    execWorld = adapter.advanceTimeOnly(execWorld, b.atSec, { futurePrices: dynamicPrices })
    execWorld = applyExogenousArrivals(execWorld, b.exogenousArrivalsAtStart)

    const bucketActs = []
    const bucketDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, b.atSec - t0))
    const maxSingleBatch = R.WORLD?.maxActions || 40
    const minGapBucket = R.WORLD?.minGap || 2
    const bucketEndSec = u + 1 < L ? seqBuckets[u + 1].atSec : tH
    const maxBatchesInBucket = 1 + Math.floor(Math.max(0, bucketEndSec - b.atSec) / minGapBucket)
    const maxBucketActions = Math.min(400, maxBatchesInBucket * maxSingleBatch)

    const pushAndSim = (candActs) => {
      if (!candActs || candActs.length === 0) return
      const room = Math.max(0, maxBucketActions - bucketActs.length)
      if (room <= 0) return
      const sliced = candActs.slice(0, room)

      // Group into runs sharing `(isStochastic ? act.a : 'det')` and chunk by `maxSingleBatch` (40)
      // so every HTTP batch is <= 40 actions AND each stochastic category draws from its own CRN sub-stream!
      let cursor = 0
      while (cursor < sliced.length) {
        const firstAct = sliced[cursor]
        const firstKey = adapter.isStochasticAction(firstAct) ? firstAct.a : 'det'
        let end = cursor + 1
        while (
          end < sliced.length &&
          end - cursor < maxSingleBatch &&
          (adapter.isStochasticAction(sliced[end]) ? sliced[end].a : 'det') === firstKey
        ) {
          end++
        }
        const chunk = sliced.slice(cursor, end)
        cursor = end

        const beforeCoins = Number(execWorld.coins || 0)
        const sv = simulateValidBatch(adapter, execWorld, chunk, {
          t: b.atSec,
          prices: dynamicPrices,
          rand: getExecPrngForKind(firstKey),
        })
        const valid = sv.validActions
        if (valid.length === 0 || !sv.sim) continue
        execWorld = sv.afterWorld
        const afterCoins = Number(execWorld.coins || 0)
        if (afterCoins !== beforeCoins) {
          cashEvents.push({ atSec: b.atSec, netCashDelta: afterCoins - beforeCoins })
        }
        valid.forEach((act, idx) => {
          if (act.a === 'sell' && sv.sim.result.out[idx]?.ok) {
            const curMap = execSoldByIsle.get(b.isleIndex) || {}
            curMap[act.id] = (curMap[act.id] || 0) + Number(act.n || 0)
            execSoldByIsle.set(b.isleIndex, curMap)
          }
        })
        bucketActs.push(...valid)
      }
    }

    const directSaleOnlyValue = (stState, id, q = 0, extraSc = 0) => {
      const qual = R.QUALITY?.[q] ?? 1
      let best = 0
      for (const sl of slots) {
        if (!sl.allowSell || sl.atSec + 1 < b.atSec) continue
        const p = Number(sl.prices?.[id] || 0)
        if (!(p > 0)) continue
        const isCrop = graph.cropsById.has(id)
        const sc0 = !isCrop
          ? 0
          : sl.naturalDay === b.naturalDay
            ? Number(stState?.cnt?.['sc_' + id] || 0) + extraSc
            : getProjectedSc(sl.naturalDay, id)
        const tierMult = !isCrop ? 1.0 : (sc0 >= 400 ? 0.70 : sc0 >= 150 ? 0.85 : 1.0)
        best = Math.max(best, Math.round(p * qual) * tierMult * sl.disc * sl.netTaxFactor)
      }
      return best
    }

    const recipeInputSet = globalRecipeInputSet

    const edibleOpportunityUnitValue = (stState, id, q = 0) => {
      const dirVal = directSaleOnlyValue(stState, id, q)
      if (!recipeInputSet.has(id)) return dirVal
      return Math.max(dirVal, marginalItemValueFn(id, q, b.atSec))
    }

    // 0. Execute any committed neighbor raids unlocking at `b.atSec` BEFORE bucket-`u` domestic work!
    if (scheduledRaidsByU[u].length > 0) {
      for (let rIdxU = 0; rIdxU < scheduledRaidsByU[u].length; rIdxU++) {
        const scheduledRaid = scheduledRaidsByU[u][rIdxU]
        const remRaidsAfterThis = [
          ...scheduledRaidsByU[u].slice(rIdxU + 1),
          ...futureRaidsAfterU[u],
        ]
        const buffCombos = Array.isArray(scheduledRaid.forcedBuffCombo)
          ? [scheduledRaid.forcedBuffCombo]
          : buildThiefBuffCombinations(adapter, execWorld, constraints, allowedSet)
        let chosenRaidOpt = null

        for (const buffCombo of buffCombos) {
          let wCand = execWorld
          let buffCostCoins = 0
          if (buffCombo.length > 0) {
            buffCostCoins = buffCombo.reduce((sAcc, a) => sAcc + Number(R.THIEF_ITEMS?.[a.id]?.price || 0), 0)
            if (Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) < buffCostCoins) continue
            const stepB = adapter.simulateBatch(execWorld, buffCombo, { t: b.atSec, prices: dynamicPrices })
            if (!stepB.allOk) continue
            wCand = stepB.afterWorld
          }

          const trans = computeExpectedRaidTransition(adapter, scheduledRaid, wCand, marginalItemValueFn)
          if (!(trans.energyCost > 0) && !(trans.belief?.totalSpots > 0)) continue
          const prep = prepareRaidStaminaWithOppCost(adapter, wCand, trans.energyCost, {
            allowedSet,
            utilityTokens,
            constraints,
            edibleSpecs,
            edibleOppValueFn: edibleOpportunityUnitValue,
            bucketDisc,
          })
          if (!prep.feasible) continue

          // Ensure buying an optional thief buff never starves subsequent committed raids of required coffee cash/stamina!
          if (buffCombo.length > 0 && remRaidsAfterThis.length > 0) {
            let checkW = adapter.advanceTimeOnly(prep.afterWorld, b.atSec, { futurePrices: dynamicPrices })
            checkW.state.en = Math.max(0, Math.floor(Number(checkW.state?.en || 0)) - trans.energyCost)
            let futureOk = true
            for (const futR of remRaidsAfterThis) {
              checkW = adapter.advanceTimeOnly(checkW, futR.unlockAtSec, { futurePrices: dynamicPrices })
              const futTr = computeExpectedRaidTransition(adapter, futR, checkW, null)
              const futPrep = prepareRaidStaminaWithOppCost(adapter, checkW, futTr.energyCost, {
                allowedSet,
                utilityTokens,
                constraints,
                edibleSpecs,
                edibleOppValueFn: null,
                bucketDisc: 1,
              })
              if (!futPrep.feasible) {
                futureOk = false
                break
              }
              checkW = futPrep.afterWorld
              checkW.state.en = Math.max(0, Math.floor(Number(checkW.state?.en || 0)) - futTr.energyCost)
            }
            if (!futureOk) continue
          }

          // Include incremental buff value on later scheduled raids covered by the 4-hour buff duration
          let futureBuffSynergy = 0
          if (buffCombo.length > 0 && remRaidsAfterThis.length > 0) {
            for (const futR of remRaidsAfterThis) {
              const wNoBuffAtFut = adapter.advanceTimeOnly(execWorld, futR.unlockAtSec, { futurePrices: dynamicPrices })
              const wWithBuffAtFut = adapter.advanceTimeOnly(wCand, futR.unlockAtSec, { futurePrices: dynamicPrices })
              const tr0 = computeExpectedRaidTransition(adapter, futR, wNoBuffAtFut, marginalItemValueFn)
              const tr1 = computeExpectedRaidTransition(adapter, futR, wWithBuffAtFut, marginalItemValueFn)
              const fDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, futR.unlockAtSec - t0))
              futureBuffSynergy += (tr1.grossLootValue - tr0.grossLootValue) - (tr1.expFine - tr0.expFine) * fDisc
            }
          }

          const score = trans.grossLootValue + futureBuffSynergy - (trans.expFine + buffCostCoins) * bucketDisc - prep.oppCost
          if (!chosenRaidOpt || score > chosenRaidOpt.score + 1e-6) {
            chosenRaidOpt = {
              score,
              buffCombo,
              buffCostCoins,
              prepActs: prep.prepActs,
              trans,
            }
          }
        }

        if (!chosenRaidOpt) {
          return makeInfeasibleRaidReturn()
        }

        const prePrepEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)))
        const prepAndBuffActs = [...chosenRaidOpt.buffCombo, ...chosenRaidOpt.prepActs]
        let prepCashSpent = 0
        if (prepAndBuffActs.length > 0) {
          const bCoins = Number(execWorld.coins || 0)
          const svPrep = simulateValidBatch(adapter, execWorld, prepAndBuffActs, {
            t: b.atSec,
            prices: dynamicPrices,
          })
          execWorld = svPrep.afterWorld
          const aCoins = Number(execWorld.coins || 0)
          prepCashSpent = Math.max(0, bCoins - aCoins)
          if (aCoins !== bCoins) {
            cashEvents.push({ atSec: b.atSec, netCashDelta: aCoins - bCoins })
          }
        }
        execWorld = adapter.advanceTimeOnly(execWorld, b.atSec, { futurePrices: dynamicPrices })
        const postPrepEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)))
        if (postPrepEn < chosenRaidOpt.trans.energyCost) {
          return makeInfeasibleRaidReturn()
        }
        const prepEnGrant = Math.max(0, postPrepEn - prePrepEn)
        const minEnBeforePrep = Math.max(0, chosenRaidOpt.trans.energyCost - prepEnGrant)
        const minCoinsBeforePrep = prepCashSpent > 0
          ? Number(constraints.cashReserveFloor || 0) + prepCashSpent
          : 0
        const requiredEdiblesMap = new Map()
        let coffeeCount = 0
        for (const pa of chosenRaidOpt.prepActs) {
          if (pa.a === 'coffee') coffeeCount++
          else if (pa.a === 'eat') {
            const eKey = `${pa.id}:${pa.q ?? 0}`
            requiredEdiblesMap.set(eKey, (requiredEdiblesMap.get(eKey) || 0) + 1)
          }
        }
        const requiredEdibles = [...requiredEdiblesMap.entries()].map(([k, n]) => {
          const [id, qRaw] = k.split(':')
          return { id, q: Number(qRaw || 0), count: n }
        })

        execWorld.state.en = Math.max(0, postPrepEn - chosenRaidOpt.trans.energyCost)
        const raidKey = `${scheduledRaid.targetId}@${Number(scheduledRaid.unlockAtSec ?? b.atSec)}`
        const realized = resolveDiscreteRaidBranch(chosenRaidOpt.trans.distribution, raidKey, execRaidPrng)
        if (realized.arrivals.length > 0) {
          execWorld = applyExogenousArrivals(execWorld, realized.arrivals)
        }
        const actualFineCoins = Math.min(Math.max(0, Number(execWorld.coins || 0)), realized.fineCoins)
        if (actualFineCoins > 0) {
          execWorld.coins = Math.max(0, Number(execWorld.coins || 0) - actualFineCoins)
          cashEvents.push({ atSec: b.atSec, netCashDelta: -actualFineCoins })
        }
        raidTransitionsByBucket[u].push({
          targetId: scheduledRaid.targetId,
          targetName: chosenRaidOpt.trans.belief?.targetName || scheduledRaid.targetName || String(scheduledRaid.targetId),
          unlockAtSec: Number(scheduledRaid.unlockAtSec ?? b.atSec),
          isImmediate: Boolean(scheduledRaid.isImmediate),
          exactUnlockKnown: Boolean(scheduledRaid.exactUnlockKnown),
          atSec: b.atSec,
          totalSpots: Number(chosenRaidOpt.trans.belief?.totalSpots || scheduledRaid.totalSpots || 0),
          buffActs: chosenRaidOpt.buffCombo,
          staminaPrepActs: chosenRaidOpt.prepActs,
          prepAndBuffActs,
          preconditions: {
            minEnBeforePrep,
            minCoinsBeforePrep,
            coffeeCount,
            requiredEdibles,
          },
          energyCost: chosenRaidOpt.trans.energyCost,
          tacticalDecision: chosenRaidOpt.trans.belief?.tacticalDecision || scheduledRaid.tacticalDecision || null,
          optimalLoadout: chosenRaidOpt.trans.belief?.optimalLoadout || scheduledRaid.optimalLoadout || null,
          numGearChanges: Number(chosenRaidOpt.trans.belief?.numGearChanges ?? scheduledRaid.numGearChanges ?? 0),
          belief: chosenRaidOpt.trans.belief,
          distribution: chosenRaidOpt.trans.distribution,
          outcomeKind: realized.kind,
          intLoot: realized.arrivals,
          fineCoins: actualFineCoins,
        })
      }
    }

    // 1. Execute zero-stamina pre-actions first (`CapEx`, `trap`, `collect`/`pet`, working-capital `sell`, cargo `stockBuy`)
    pushAndSim(earlyZeroEnPreByU[u])
    pushAndSim(cargoPreByU[u])

    const computeBucketCraftBundles = (stWorld) => {
      const craftItems = []
      const s = stWorld.state
      const actionRoom = Math.max(0, maxBucketActions - bucketActs.length)
      if (!allowedSet.has('craft') || actionRoom <= 0) return craftItems

      const futureSameIsleSlots = seqBuckets
        .slice(u + 1)
        .reduce((acc, fb, idx2) => {
          if (fb.isleIndex !== b.isleIndex) return acc
          const cList = jointCS.craftsByBucket[u + 1 + idx2] || []
          return acc + cList.reduce((s2, ca) => s2 + Number(ca.n || 1), 0)
        }, 0)
      const craftUsedNow = s.iq?.d === b.isleIndex ? Number(s.iq.craft || 0) : 0
      const freeSlotsNow = Math.max(0, (R.WORLD?.daily?.craft || 80) - craftUsedNow - futureSameIsleSlots)
      if (freeSlotsNow <= 0) return craftItems

      const snapAvail = adapter.availableInvSnapshot(s)
      for (let fu = u + 1; fu < jointCS.craftsByBucket.length; fu++) {
        for (const ca of jointCS.craftsByBucket[fu] || []) {
          const rec = graph.recipesById.get(ca.id)
          if (!rec?.in) continue
          for (const [inId, perUnit] of Object.entries(rec.in)) {
            let remKeep = perUnit * Number(ca.n || 1)
            const row = snapAvail[inId]
            if (!row) continue
            for (let q = 0; q < 3 && remKeep > 0; q++) {
              const tk = Math.min(row[q], remKeep)
              row[q] -= tk
              remKeep -= tk
            }
          }
        }
      }

      const anyRecipeHasInputs = (R.RECIPES || []).some((rec) =>
        Object.entries(rec.in || {}).every(([inId, need]) => {
          const r = snapAvail[inId]
          return r && ((r[0] || 0) + (r[1] || 0) + (r[2] || 0)) >= need
        })
      )
      if (!anyRecipeHasInputs) return craftItems

      const craftEn = R.WORLD?.cost?.craft ?? 1
      let localCraftSlots = slots._localCraftSlotsByU?.[u]
      if (!localCraftSlots) {
        if (!slots._localCraftSlotsByU) slots._localCraftSlotsByU = []
        localCraftSlots = slots
          .filter((sl) => sl.availFromBucket >= u)
          .map((sl) => ({ ...sl, availFromBucket: Math.max(0, sl.availFromBucket - u) }))
        slots._localCraftSlotsByU[u] = localCraftSlots
      }
      const localCS = solveJointCraftAndSell(adapter, {
        initialSupplyByBucket: [snapAvail, ...seqBuckets.slice(u + 1).map(() => ({}))],
        buckets: seqBuckets.slice(u),
        slots: localCraftSlots,
        initialNatDay: b.naturalDay,
        initialCnt: s.cnt || {},
        craftCapByIsle: new Map([[b.isleIndex, freeSlotsNow]]),
        enCapByBucket: Float64Array.from(seqBuckets.slice(u).map(() => freeSlotsNow * craftEn)),
        staminaShadowCost: 0,
        allowCraft: true,
        maxCraftHoldIsleDays,
        isPastDeadlineFn,
      })

      const plannedActs = localCS.craftsByBucket[0] || []
      const expandedSingle = []
      for (const ca of plannedActs) {
        for (let k = 0; k < (ca.n || 1); k++) expandedSingle.push(ca.id)
      }
      const simSnap = cloneInvSnap(snapAvail)
      let idxC = 0
      while (idxC < expandedSingle.length) {
        const rId = expandedSingle[idxC]
        const rec = graph.recipesById.get(rId)
        if (!rec) { idxC++; continue }
        if (!(rec.price > 0) || !deductRecipeLowStarFirst(simSnap, rec, 1).feasible) {
          idxC++
          continue
        }
        let bundledWithDownstream = false
        const downstreamIdx = expandedSingle.findIndex((laterId, lIdx) => {
          if (lIdx <= idxC) return false
          const dRec = graph.recipesById.get(laterId)
          return dRec?.in?.[rId] > 0 && ((simSnap[rId]?.[0] || 0) + (simSnap[rId]?.[1] || 0) + (simSnap[rId]?.[2] || 0)) < dRec.in[rId]
        })
        if (downstreamIdx > idxC) {
          const downId = expandedSingle[downstreamIdx]
          const downRec = graph.recipesById.get(downId)
          const needUp = downRec.in[rId]
          const upIndices = []
          for (let scan = idxC; scan < downstreamIdx && upIndices.length < needUp; scan++) {
            if (expandedSingle[scan] === rId) upIndices.push(scan)
          }
          if (upIndices.length === needUp) {
            const testSnap = cloneInvSnap(simSnap)
            let rawCost = 0
            let okChain = true
            for (let uStep = 0; uStep < needUp; uStep++) {
              const d1 = deductRecipeLowStarFirst(testSnap, rec, 1)
              if (!d1.feasible) { okChain = false; break }
              for (const [inId, qArr] of Object.entries(d1.deducted)) {
                for (let q = 0; q < 3; q++) if (qArr[q] > 0) rawCost += qArr[q] * directSaleOnlyValue(s, inId, q)
              }
              testSnap[rId] ||= [0, 0, 0]
              testSnap[rId][0] += 1
            }
            if (okChain) {
              const d2 = deductRecipeLowStarFirst(testSnap, downRec, 1)
              if (d2.feasible) {
                for (const [inId, qArr] of Object.entries(d2.deducted)) {
                  if (inId === rId) continue
                  for (let q = 0; q < 3; q++) if (qArr[q] > 0) rawCost += qArr[q] * directSaleOnlyValue(s, inId, q)
                }
                const outVal = directSaleOnlyValue(s, downId, 0)
                const gain = outVal - rawCost
                if (gain > 1e-6) {
                  craftItems.push({
                    kind: 'craft-bundle',
                    costEn: (needUp + 1) * craftEn,
                    gain,
                    craftSteps: [{ id: rId, n: needUp }, { id: downId, n: 1 }],
                  })
                  Object.assign(simSnap, testSnap)
                  for (const ui of upIndices) expandedSingle[ui] = null
                  expandedSingle[downstreamIdx] = null
                  bundledWithDownstream = true
                }
              }
            }
          }
        }
        if (bundledWithDownstream) {
          idxC++
          continue
        }
        const ded = deductRecipeLowStarFirst(simSnap, rec, 1)
        if (ded.feasible) {
          let inVal = 0
          for (const [inId, qArr] of Object.entries(ded.deducted)) {
            for (let q = 0; q < 3; q++) if (qArr[q] > 0) inVal += qArr[q] * directSaleOnlyValue(s, inId, q)
          }
          const outVal = directSaleOnlyValue(s, rId, 0)
          const gain = outVal - inVal
          if (gain > 1e-6) {
            craftItems.push({
              kind: 'craft-bundle',
              costEn: craftEn,
              gain,
              craftSteps: [{ id: rId, n: 1 }],
            })
          }
        }
        idxC++
      }
      return craftItems
    }

    let cachedCraftBundles = computeBucketCraftBundles(execWorld)

    // Helper: Build all marginal integer stamina work units (`craft`, `bomb`, `fish`, `mine`) at `stWorld`
    // and solve the exact Stamina × Cash Bounded Knapsack DP!
    const gcdInt = (a, b2) => {
      let x = Math.abs(Math.round(a))
      let y = Math.abs(Math.round(b2))
      while (y > 0) {
        const t = x % y
        x = y
        y = t
      }
      return Math.max(1, x)
    }

    const solveBucketStaminaKnapsack = (
      stWorld,
      maxEnLimit,
      craftBundlesOverride = null,
      { fullIsleQuotas = false, fishEvOverride = null } = {}
    ) => {
      const s = stWorld.state
      const freeCash = Math.max(0, Number(stWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      const actionRoom = fullIsleQuotas ? 400 : Math.max(0, maxBucketActions - bucketActs.length)
      const items = [] // Array<{ kind, costEn, gain, craftSteps, cashCost }>

      // A) Unreserved Craft units (cached unless an `eat` action consumed a recipe ingredient!)
      if (allowedSet.has('craft') && actionRoom > 0) {
        const activeBundles = craftBundlesOverride ?? (cachedCraftBundles || (cachedCraftBundles = computeBucketCraftBundles(stWorld)))
        items.push(...activeBundles)
      }

      // B) `bomb` units (existing inventory explosives & affordable shop-bought explosives)
      if (allowedSet.has('bomb') && utilityTokens.explosiveId && actionRoom > 0) {
        const usedBomb = s.iq?.d === b.isleIndex ? Number(s.iq.bomb || 0) : 0
        const bombLimitLeft = Math.max(0, (R.WORLD?.daily?.bomb || 10) - usedBomb)
        const bombEn = R.WORLD?.cost?.bomb ?? 6
        if (bombLimitLeft > 0) {
          const by = expectedBombYield(adapter, s, b.isleDay)
          const dropVal = Object.entries(by.byOre).reduce((acc, [oId, c]) => acc + c * marginalItemValueFn(oId, 0, b.atSec), 0)
          const haveBombs = adapter.availableInv(s, utilityTokens.explosiveId, 0)
          const useInv = Math.min(haveBombs, bombLimitLeft, actionRoom)
          if (dropVal > 1e-6) {
            for (let k = 0; k < useInv; k++) {
              items.push({ kind: 'bomb-inv', costEn: bombEn, gain: dropVal })
            }
          }
          const remQuota = bombLimitLeft - useInv
          const shopBombPrice = Number(R.SHOP?.[utilityTokens.explosiveId]?.price || 0)
          if (remQuota > 0 && allowedSet.has('buy') && shopBombPrice > 0 && actionRoom >= 2) {
            const netGain = dropVal - shopBombPrice * bucketDisc
            const maxAfford = Math.min(remQuota, Math.floor(freeCash / shopBombPrice), actionRoom - 1)
            if (netGain > 1e-6 && maxAfford > 0) {
              for (let k = 0; k < maxAfford; k++) {
                items.push({ kind: 'bomb-buy', costEn: bombEn, gain: netGain, cashCost: shopBombPrice })
              }
            }
          }
        }
      }

      // C) `fish` units (respecting later golden-hour windows in the same isleIndex!)
      if (allowedSet.has('fish') && actionRoom > 0) {
        const usedFish = s.iq?.d === b.isleIndex ? Number(s.iq.fish || 0) : 0
        const fishLeft = Math.max(0, (R.WORLD?.daily?.fish || 80) - usedFish)
        const fishEn = R.WORLD?.cost?.fish ?? 4
        if (fishLeft > 0) {
          const fyBait = expectedFishYieldPerCast(adapter, s, b.atSec, true)
          const fyNoBait = expectedFishYieldPerCast(adapter, s, b.atSec, false)
          const rawValBait = Object.entries(fyBait.byFish).reduce(
            (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, b.atSec) + qs[1] * marginalItemValueFn(fId, 1, b.atSec) + qs[2] * marginalItemValueFn(fId, 2, b.atSec),
            0
          )
          const valNoBait = Object.entries(fyNoBait.byFish).reduce(
            (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, b.atSec) + qs[1] * marginalItemValueFn(fId, 1, b.atSec) + qs[2] * marginalItemValueFn(fId, 2, b.atSec),
            0
          )
          const bestIsleEv = bestFishEvInIsle.get(b.isleIndex) || 0
          const valBait = fishEvOverride != null
            ? fishEvOverride
            : (fullIsleQuotas ? Math.max(rawValBait, bestIsleEv) : rawValBait)
          const enCapCheck = Number(R.energyMax(s))
          const hasBetterWindowLaterSameIsle = !fullIsleQuotas
            && seqBuckets.slice(u + 1).some((fb) => fb.isleIndex === b.isleIndex)
            && rawValBait + 1e-6 < bestIsleEv
            && Number(s.en || 0) < (Number.isFinite(enCapCheck) && enCapCheck > 0 ? enCapCheck : 100)

          if (!hasBetterWindowLaterSameIsle) {
            const capCasts = fullIsleQuotas ? fishLeft : Math.min(fishLeft, actionRoom)
            const haveBait = utilityTokens.baitId ? adapter.availableInv(s, utilityTokens.baitId, 0) : 0
            const baitPrice = utilityTokens.baitId ? Number(R.SHOP?.[utilityTokens.baitId]?.price || 0) : 0
            let assigned = 0
            if (utilityTokens.baitId && valBait >= valNoBait && valBait > 1e-6) {
              const nInvBait = Math.min(haveBait, capCasts)
              for (let k = 0; k < nInvBait; k++) {
                items.push({ kind: 'fish-inv-bait', costEn: fishEn, gain: valBait })
                assigned++
              }
              const remCasts = capCasts - assigned
              if (
                remCasts > 0 &&
                allowedSet.has('buy') &&
                baitPrice > 0 &&
                valBait - baitPrice * bucketDisc > Math.max(0, valNoBait) &&
                actionRoom >= 2
              ) {
                const nBuyBait = Math.min(remCasts, Math.floor(freeCash / baitPrice), actionRoom - 1)
                for (let k = 0; k < nBuyBait; k++) {
                  items.push({ kind: 'fish-buy-bait', costEn: fishEn, gain: valBait - baitPrice * bucketDisc, cashCost: baitPrice })
                  assigned++
                }
              }
            }
            const remNoBait = capCasts - assigned
            if (remNoBait > 0 && valNoBait > 1e-6) {
              for (let k = 0; k < remNoBait; k++) {
                items.push({ kind: 'fish-no-bait', costEn: fishEn, gain: valNoBait })
              }
            }
          }
        }
      }

      // D) `mine` units
      if (allowedSet.has('mine') && actionRoom > 0) {
        const usedMine = s.iq?.d === b.isleIndex ? Number(s.iq.mine || 0) : 0
        const mineLeft = Math.max(0, (R.WORLD?.daily?.mine || 100) - usedMine)
        const mineEn = R.WORLD?.cost?.mine ?? 3
        if (mineLeft > 0) {
          const my = expectedMineYieldPerHit(adapter, s, b.isleDay)
          const mv = Object.entries(my.byOre).reduce((acc, [oId, c]) => acc + c * marginalItemValueFn(oId, 0, b.atSec), 0)
          if (mv > 1e-6) {
            const capHits = fullIsleQuotas ? mineLeft : Math.min(mineLeft, actionRoom)
            for (let k = 0; k < capHits; k++) {
              items.push({ kind: 'mine', costEn: mineEn, gain: mv })
            }
          }
        }
      }

      const maxCostSum = items.reduce((sAcc, it) => sAcc + it.costEn, 0)
      const E = Math.max(0, Math.min(maxEnLimit, maxCostSum))
      const totalPaidCash = items.reduce((sAcc, it) => sAcc + Number(it.cashCost || 0), 0)

      // Exact Bounded -> 0-1 Binary Bundling (`1, 2, 4, ...`) with zero-cash items ordered first!
      const freeRaw = []
      const paidRaw = []
      for (const it of items) {
        if (it.cashCost > 0) paidRaw.push(it)
        else freeRaw.push(it)
      }
      const orderedRaw = [...freeRaw, ...paidRaw]
      const sameKsItem = (a, b2) => {
        if (a.kind !== b2.kind || a.costEn !== b2.costEn || (a.cashCost || 0) !== (b2.cashCost || 0)) return false
        if (Math.abs(a.gain - b2.gain) > 1e-9) return false
        if (a.kind === 'craft-bundle') {
          if (!a.craftSteps || !b2.craftSteps || a.craftSteps.length !== 1 || b2.craftSteps.length !== 1) return false
          return a.craftSteps[0].id === b2.craftSteps[0].id && a.craftSteps[0].n === b2.craftSteps[0].n
        }
        return true
      }
      const dpItems = []
      let rIdx = 0
      while (rIdx < orderedRaw.length) {
        const base = orderedRaw[rIdx]
        let run = 1
        while (rIdx + run < orderedRaw.length && sameKsItem(base, orderedRaw[rIdx + run])) run++
        let rem = run
        let bPow = 1
        const uCash = Number(base.cashCost || 0)
        while (rem > 0) {
          const takeN = Math.min(bPow, rem)
          dpItems.push({
            baseItem: base,
            bundleCount: takeN,
            unitCash: uCash,
            costEn: base.costEn * takeN,
            gain: base.gain * takeN,
          })
          rem -= takeN
          bPow *= 2
        }
        rIdx += run
      }

      // When multiple paid item pools (`bomb-buy` + `fish-buy-bait`) compete for scarce `freeCash`,
      // solve exact 2D `(e, c)` DP so reconstructed items NEVER exceed `freeCash`!
      if (totalPaidCash > freeCash + 1e-9 && E > 0) {
        let rawGcd = 0
        for (const it of dpItems) {
          if (it.unitCash > 0) rawGcd = rawGcd === 0 ? it.unitCash : gcdInt(rawGcd, it.unitCash)
        }
        if (rawGcd <= 0) rawGcd = 1
        const cashUnit = Math.floor(freeCash / rawGcd) > 500
          ? Math.max(1, Math.ceil(freeCash / 500))
          : rawGcd
        const C = Math.max(0, Math.floor(freeCash / cashUnit))
        const stride = C + 1
        recordCashGrid('bucket-stamina-cash-dp', cashUnit, rawGcd, (E + 1) * stride)
        const dp2 = new Float64Array((E + 1) * stride)
        dp2.fill(-1e18)
        dp2[0] = 0
        let maxReachC = 0
        const take2 = dpItems.map(() => new Uint8Array((E + 1) * stride))

        for (let i = 0; i < dpItems.length; i++) {
          const cEn = dpItems[i].costEn
          const cCash = dpItems[i].unitCash > 0 ? dpItems[i].bundleCount * Math.ceil(dpItems[i].unitCash / cashUnit) : 0
          const g = dpItems[i].gain
          if (cEn > E || cCash > C) continue
          const cMax = Math.min(C, maxReachC + cCash)
          const tArr = take2[i]
          for (let e = E; e >= cEn; e--) {
            const rowOff = e * stride
            const prevOff = (e - cEn) * stride
            for (let c = cMax; c >= cCash; c--) {
              const prevVal = dp2[prevOff + (c - cCash)]
              if (prevVal <= -1e17) continue
              const cand = prevVal + g
              if (cand > dp2[rowOff + c] + 1e-6) {
                dp2[rowOff + c] = cand
                tArr[rowOff + c] = 1
              }
            }
          }
          if (cCash > 0) maxReachC = Math.min(C, maxReachC + cCash)
        }

        const bestAtMost = new Float64Array(E + 1)
        const bestExactE = new Int32Array(E + 1)
        const bestExactC = new Int32Array(E + 1)
        for (let e = 0; e <= E; e++) {
          let rowBest = e > 0 ? bestAtMost[e - 1] : 0
          let rowBestE = e > 0 ? bestExactE[e - 1] : 0
          let rowBestC = e > 0 ? bestExactC[e - 1] : 0
          const rowOff = e * stride
          for (let c = 0; c <= maxReachC; c++) {
            if (dp2[rowOff + c] > rowBest + 1e-6) {
              rowBest = dp2[rowOff + c]
              rowBestE = e
              rowBestC = c
            }
          }
          bestAtMost[e] = rowBest
          bestExactE[e] = rowBestE
          bestExactC[e] = rowBestC
        }

        const reconstructAt = (availEn) => {
          const clamped = Math.max(0, Math.min(E, Math.floor(availEn)))
          let curE = bestExactE[clamped]
          let curC = bestExactC[clamped]
          const picked = []
          for (let i = dpItems.length - 1; i >= 0 && curE > 0; i--) {
            if (take2[i][curE * stride + curC]) {
              const cnt = dpItems[i].bundleCount
              for (let k = 0; k < cnt; k++) picked.push(dpItems[i].baseItem)
              curE -= dpItems[i].costEn
              curC -= dpItems[i].unitCash > 0 ? cnt * Math.ceil(dpItems[i].unitCash / cashUnit) : 0
            }
          }
          picked.reverse()
          return picked
        }

        return { items, E, bestAtMost, reconstructAt }
      }

      const dp = new Float64Array(E + 1)
      const takeTable = dpItems.map(() => new Uint8Array(E + 1))

      for (let i = 0; i < dpItems.length; i++) {
        const cEn = dpItems[i].costEn
        const g = dpItems[i].gain
        const tArr = takeTable[i]
        for (let e = E; e >= cEn; e--) {
          const cand = dp[e - cEn] + g
          if (cand > dp[e] + 1e-6) {
            dp[e] = cand
            tArr[e] = 1
          }
        }
      }
      const bestAtMost = new Float64Array(E + 1)
      const bestExactE = new Int32Array(E + 1)
      for (let e = 1; e <= E; e++) {
        if (dp[e] > bestAtMost[e - 1] + 1e-6) {
          bestAtMost[e] = dp[e]
          bestExactE[e] = e
        } else {
          bestAtMost[e] = bestAtMost[e - 1]
          bestExactE[e] = bestExactE[e - 1]
        }
      }

      const reconstructAt = (availEn) => {
        const clamped = Math.max(0, Math.min(E, Math.floor(availEn)))
        let curE = bestExactE[clamped]
        const picked = []
        for (let i = dpItems.length - 1; i >= 0 && curE > 0; i--) {
          if (takeTable[i][curE]) {
            const cnt = dpItems[i].bundleCount
            for (let k = 0; k < cnt; k++) picked.push(dpItems[i].baseItem)
            curE -= dpItems[i].costEn
          }
        }
        picked.reverse()
        return picked
      }

      return { items, E, bestAtMost, reconstructAt }
    }

    // 2. Unified Whole-Isle Bellman Stamina Allocation & Multi-Batch Turnover (`eat` / `coffee`):
    //    Jointly prices Bucket-`u` urgent farm/barn queuing loss (`V_farmCurve`), Bucket-`u` shiftable work,
    //    and remaining same-isle passive regen + post-midnight coffee across `[u, isleEnd]` with 0 heuristic gates!
    const bucketEnFloor = Number(constraints.staminaReserveFloor || 0) > 0 && b.atSec < Number(constraints.staminaReserveUntilSec || 0)
      ? Math.max(0, Math.floor(Number(constraints.staminaReserveFloor || 0)))
      : 0

    const regenStepU = R.WORLD?.regen || 180
    const sInitU = execWorld.state
    const weatherU = R.weatherOf(b.isleDay)
    const rawCapInitU = Number(R.energyMax(sInitU))
    const enMaxInitU = Number.isFinite(rawCapInitU) && rawCapInitU > 0 ? rawCapInitU : 100
    const curInitEnU = Math.max(0, Math.floor(Number(sInitU.en || 0)))
    const exactStartEnTU = curInitEnU >= enMaxInitU
      ? b.atSec
      : Math.max(b.atSec - regenStepU + 1, Math.min(b.atSec, Number(sInitU.enT || b.atSec)))
    const baseEnTU = Math.max(b.atSec, Number(sInitU.enT || b.atSec))
    const nextOppSecU = Math.min(
      bucketEndSec > b.atSec ? bucketEndSec : b.atSec + regenStepU,
      Math.max(b.atSec + 1, exactStartEnTU + regenStepU)
    )

    // 2a. Build ordered Bucket-`u` urgent farm & barn tasks (`harvest` -> `clear` -> `plant` -> hungry `feed` -> expiring `water`)
    const urgentTasks = []
    const harvestTasks = []
    const clearTasks = []
    const expiringWaterTasks = []
    const plotWillBeEmptyAfterHC = new Uint8Array(Math.max(0, sInitU.plotN || 0))

    const exactManualWaterGain = (cropId, curW, remLeftSec, plotRatePerSec) => {
      const w0 = Math.max(0, Math.min(2, Number(curW || 0)))
      const w1 = w0 + 1
      const v0 = marginalItemValueFn(cropId, 0, b.atSec)
      const v1 = marginalItemValueFn(cropId, 1, b.atSec)
      const v2 = marginalItemValueFn(cropId, 2, b.atSec)
      const expVal = (w) => {
        const eq = adapter.expectedHarvestYield(w, false).expectedByQuality
        return eq[0] * v0 + eq[1] * v1 + eq[2] * v2
      }
      return Math.max(0, expVal(w1) - expVal(w0)) + Math.max(0, plotRatePerSec) * Math.floor(Math.max(0, Number(remLeftSec || 0)) * 0.25)
    }

    for (let i = 0; i < (sInitU.plotN || 0); i++) {
      const p = sInitU.plots?.[i]
      if (!p) {
        plotWillBeEmptyAfterHC[i] = 1
        continue
      }
      const isSpr = R.sprinkled(sInitU, i)
      const auto = isSpr || weatherU === 1
      const st = R.cropStage(p, b.atSec, auto)
      const bestNextP = allowedSet.has('plant')
        ? selectBestCropToPlant(adapter, {
            state: sInitU,
            clockStart: startWorld.clockStart,
            plotIdx: i,
            atSec: b.atSec,
            tEnd: tH,
            marginalItemValueFn,
            staminaPointCost: baseStaminaShadowCost,
            enforceHorizonCutoff: objectiveCfg.terminalSupplyMode === 'zero',
          })
        : null
      const fallbackRate = p.c && graph.cropsById.has(p.c)
        ? marginalItemValueFn(p.c, 0, b.atSec) / Math.max(1800, (graph.cropsById.get(p.c).grow || 120) * 60)
        : 0.02
      const rPlot = Math.max(0.01, bestNextP ? bestNextP.netRatePerSec : fallbackRate)

      if (st.stage === 3 && allowedSet.has('harvest')) {
        const post = adapter.predictPostHarvestPlot(p, b.atSec, startWorld.clockStart)
        const canImmediateClear = post.kind === 'withered' && allowedSet.has('clear')
        if (post.kind === 'empty' || canImmediateClear) {
          plotWillBeEmptyAfterHC[i] = 1
        }
        const timing = adapter.exactPlotTimings(p, isSpr, b.atSec, startWorld.clockStart, { isAlreadyRipe: true })
        const unlockAt = timing ? timing.unlockAt : b.atSec + 1800
        const protectSec = Math.max(600, timing?.protectSec || 1800)
        const wEff = auto ? 3 : Number(p.w || 0)
        const wasStolen = Boolean(p.sv && p.sv.length > 0)
        const unstolenExtra = Math.max(0, adapter.expectedHarvestYield(wEff, wasStolen).expectedUnits - 1.0)
        const stealLossCap = unstolenExtra * marginalItemValueFn(p.c, 0, b.atSec)
        harvestTasks.push({
          kind: 'harvest',
          i,
          costEn: R.WORLD?.cost?.harvest ?? 1,
          ratePerSec: rPlot,
          unlockAt,
          protectSec,
          stealLossCap,
          sortPriority: rPlot + (b.atSec >= unlockAt ? stealLossCap / protectSec : (stealLossCap * 0.25) / protectSec),
        })
        if (canImmediateClear) {
          clearTasks.push({
            kind: 'clear',
            i,
            costEn: R.WORLD?.cost?.clear ?? 1,
            ratePerSec: rPlot,
            sortPriority: rPlot,
          })
        }
      } else if (st.stage === -1 && allowedSet.has('clear')) {
        plotWillBeEmptyAfterHC[i] = 1
        clearTasks.push({
          kind: 'clear',
          i,
          costEn: R.WORLD?.cost?.clear ?? 1,
          ratePerSec: rPlot,
          sortPriority: rPlot,
        })
      } else if (st.stage >= 0 && st.stage < 3 && !auto && p.w <= st.stage && allowedSet.has('water')) {
        const stageEndSec = Number(p.t || b.atSec) + Math.ceil((Number(st.total || 3600) * (st.stage + 1)) / 3)
        if (stageEndSec <= nextOppSecU) {
          const dw = exactManualWaterGain(p.c, p.w, st.left, rPlot)
          if (dw > 1e-6) {
            expiringWaterTasks.push({
              kind: 'water-expiring',
              i,
              costEn: R.WORLD?.cost?.water ?? 1,
              fixedLossIfUnfunded: dw,
            })
          }
        }
      }
    }

    harvestTasks.sort((a, b2) => b2.sortPriority - a.sortPriority || a.i - b2.i)
    clearTasks.sort((a, b2) => b2.sortPriority - a.sortPriority || a.i - b2.i)
    urgentTasks.push(...harvestTasks, ...clearTasks)

    if (allowedSet.has('plant') && (u > 0 || enableFirstBucketPlant)) {
      const plantCostEn = R.WORLD?.cost?.plant ?? 2
      let simPlantCash = Math.max(0, Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      const freeSeedCounts = new Map()
      const plantTasks = []
      for (let i = 0; i < (sInitU.plotN || 0); i++) {
        if (!plotWillBeEmptyAfterHC[i]) continue
        const bestP = selectBestCropToPlant(adapter, {
          state: sInitU,
          clockStart: startWorld.clockStart,
          plotIdx: i,
          atSec: b.atSec,
          tEnd: tH,
          marginalItemValueFn,
          staminaPointCost: baseStaminaShadowCost,
          enforceHorizonCutoff: objectiveCfg.terminalSupplyMode === 'zero',
        })
        if (!bestP) continue
        const sdId = `sd_${bestP.crop.id}`
        if (!freeSeedCounts.has(sdId)) freeSeedCounts.set(sdId, adapter.availableInv(sInitU, sdId, 0))
        const remFreeSd = freeSeedCounts.get(sdId) || 0
        const costCash = remFreeSd > 0 ? 0 : Number(bestP.crop.seed || 0)
        if (costCash > simPlantCash) continue
        if (remFreeSd > 0) freeSeedCounts.set(sdId, remFreeSd - 1)
        simPlantCash -= costCash
        plantTasks.push({
          kind: 'plant',
          i,
          crop: bestP.crop,
          costEn: plantCostEn,
          ratePerSec: Math.max(0.01, bestP.netRatePerSec),
          npv: Math.max(0, bestP.netPresentValue),
        })
      }
      plantTasks.sort((a, b2) => b2.ratePerSec - a.ratePerSec || a.i - b2.i)
      urgentTasks.push(...plantTasks)
    }

    if (allowedSet.has('feed') && utilityTokens.feedId) {
      let simFeedHave = adapter.availableInv(sInitU, utilityTokens.feedId, 0)
      let simFeedCash = Math.max(0, Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      const feedPrice = Number(R.SHOP?.[utilityTokens.feedId]?.price || 150)
      for (let i = 0; i < (sInitU.barn?.length || 0); i++) {
        const pen = sInitU.barn[i]
        if (!pen || R.b12AnimalStage(pen, b.atSec).retired) continue
        const hungryAt = pen.f + 86400
        if (b.atSec - pen.f >= 8 * 3600 && (hungryAt <= bucketEndSec || b.atSec >= hungryAt)) {
          if (simFeedHave > 0) simFeedHave--
          else if (allowedSet.has('buy') && simFeedCash >= feedPrice) simFeedCash -= feedPrice
          else continue
          const def = graph.animalsById.get(pen.k)
          const prodVal = def ? marginalItemValueFn(def.product, 0, b.atSec) : 500
          const periodSec = Math.max(3600, R.b12AnimalPeriod?.(pen.k, b.atSec) || 28800)
          urgentTasks.push({
            kind: 'feed',
            i,
            costEn: R.WORLD?.cost?.feed ?? 1,
            hungryAt,
            haltRatePerSec: Math.max(0.005, prodVal / periodSec),
          })
        }
      }
    }

    expiringWaterTasks.sort((a, b2) => b2.fixedLossIfUnfunded - a.fixedLossIfUnfunded || a.i - b2.i)
    urgentTasks.push(...expiringWaterTasks)

    const futureRaidsU = futureRaidsAfterU[u]
    let minZeroFoodRaidPostEn = 0
    let firstZeroFoodBlockingRaidSec = b.atSec
    let lastFutureRaidSecU = b.atSec
    let hasAnyRaidTopUpSourceU = false
    if (futureRaidsU.length > 0) {
      lastFutureRaidSecU = futureRaidsU[futureRaidsU.length - 1].unlockAtSec
      for (let checkE = 0; checkE <= enMaxInitU + 1; checkE++) {
        let eSim = checkE
        let tSim = checkE >= enMaxInitU ? b.atSec : exactStartEnTU
        let okNoFood = true
        let failSec = b.atSec
        for (const fr of futureRaidsU) {
          const adv = advanceScalarStamina(eSim, tSim, enMaxInitU, regenStepU, fr.unlockAtSec)
          eSim = adv.en
          tSim = adv.enT
          const reqE = Math.max(0, Math.floor(Number(fr.energyCost || 0)))
          if (eSim < reqE) {
            okNoFood = false
            failSec = fr.unlockAtSec
            break
          }
          if (eSim >= enMaxInitU) tSim = Math.max(tSim, fr.unlockAtSec)
          eSim -= reqE
        }
        if (okNoFood) {
          minZeroFoodRaidPostEn = checkE
          break
        }
        if (checkE === curInitEnU) {
          firstZeroFoodBlockingRaidSec = failSec
        }
        minZeroFoodRaidPostEn = enMaxInitU + 1
      }
      if (firstZeroFoodBlockingRaidSec <= b.atSec) {
        firstZeroFoodBlockingRaidSec = futureRaidsU[0].unlockAtSec
      }
      if (allowedSet.has('eat')) {
        for (const sp of edibleSpecs) {
          const qHave = sp.kind === 'snack'
            ? Math.min(adapter.availableInv(sInitU, sp.id, 0), sp.dailyCap != null ? Math.max(0, sp.dailyCap - Number(sInitU.cnt?.[sp.id] || 0)) : 999)
            : adapter.availableInv(sInitU, sp.id, sp.q)
          if (qHave > 0 && sp.energyGain > 0) {
            hasAnyRaidTopUpSourceU = true
            break
          }
        }
      }
      if (!hasAnyRaidTopUpSourceU && allowedSet.has('coffee')) {
        const cPrice0 = R.WORLD?.coffee?.price || 15000
        if (
          Number(sInitU.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
          Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) >= cPrice0
        ) {
          hasAnyRaidTopUpSourceU = true
        }
      }
    }

    const hasBucketStochWorkU0 = u === 0 && (
      (allowedSet.has('fish') && (sInitU.iq?.d === b.isleIndex ? Number(sInitU.iq.fish || 0) : 0) < (R.WORLD?.daily?.fish || 80)) ||
      (allowedSet.has('mine') && (sInitU.iq?.d === b.isleIndex ? Number(sInitU.iq.mine || 0) : 0) < (R.WORLD?.daily?.mine || 100)) ||
      (allowedSet.has('bomb') && (sInitU.iq?.d === b.isleIndex ? Number(sInitU.iq.bomb || 0) : 0) < (R.WORLD?.daily?.bomb || 10))
    )
    const urgentFarmEn = urgentTasks.reduce((sAcc, t) => sAcc + t.costEn, 0)
    const isleEndSecForUrgent = adapter.nextIsleBoundary(b.atSec, startWorld.clockStart)
    const evalUnfundedFarmMetrics = (fundedEn) => {
      let remEF = Math.max(0, Math.floor(fundedEn))
      let idxT = 0
      while (idxT < urgentTasks.length && remEF >= urgentTasks[idxT].costEn) {
        remEF -= urgentTasks[idxT].costEn
        idxT++
      }
      if (idxT >= urgentTasks.length) return { totalLoss: 0, deferredSameIsleEn: 0 }
      let cumRegenNeed = -remEF
      let totalLoss = 0
      let deferredSameIsleEn = 0
      const postFundedInitEn = Math.max(0, curInitEnU - Math.max(0, Math.floor(fundedEn)))
      for (let m = idxT; m < urgentTasks.length; m++) {
        const t = urgentTasks[m]
        cumRegenNeed += t.costEn
        const needTicks = Math.max(1, cumRegenNeed)
        // Causal prefix seriality: deterministic tasks in `u === 0` run in the opening batch (`0s` delay),
        // whereas unfunded tasks left behind stochastic `fish`/`mine`/`bomb` must wait at least 1 RTT round-trip (`minGap + 1s`).
        const causalFloorSec = hasBucketStochWorkU0 ? (b.atSec + minGapBucket + 1) : (b.atSec + 1)
        let readySec = Math.max(causalFloorSec, exactStartEnTU + needTicks * regenStepU)
        if (futureRaidsU.length > 0 && postFundedInitEn - needTicks < minZeroFoodRaidPostEn) {
          readySec = hasAnyRaidTopUpSourceU
            ? Math.max(readySec, firstZeroFoodBlockingRaidSec + minGapBucket)
            : Math.max(readySec, lastFutureRaidSecU + needTicks * regenStepU)
        }
        const waitSec = Math.max(1, readySec - b.atSec)
        let losesSeasonHere = false
        if (t.kind === 'harvest') {
          const expBefore = Math.max(0, b.atSec - t.unlockAt)
          const expAfter = Math.max(0, readySec - t.unlockAt)
          const stealProbDelta = Math.max(0, Math.exp(-expBefore / t.protectSec) - Math.exp(-expAfter / t.protectSec))
          totalLoss += t.ratePerSec * waitSec + t.stealLossCap * stealProbDelta
        } else if (t.kind === 'clear') {
          totalLoss += t.ratePerSec * waitSec
        } else if (t.kind === 'plant') {
          const futureSeason = R.seasonOf(R.isleDay(readySec))
          losesSeasonHere = futureSeason !== R.seasonOf(b.isleDay) && !(t.crop?.seasons || []).includes(futureSeason)
          totalLoss += Math.max(t.ratePerSec * waitSec, losesSeasonHere ? t.npv : 0)
        } else if (t.kind === 'feed') {
          const haltSec = Math.max(regenStepU, readySec - Math.max(b.atSec, t.hungryAt))
          totalLoss += t.haltRatePerSec * haltSec
        } else if (t.kind === 'water-expiring') {
          totalLoss += t.fixedLossIfUnfunded
        }
        if (t.kind !== 'water-expiring' && !losesSeasonHere && readySec < isleEndSecForUrgent) {
          deferredSameIsleEn += t.costEn
        }
      }
      return { totalLoss, deferredSameIsleEn }
    }

    const V_farmCurve = new Float64Array(urgentFarmEn + 1)
    const deferredSameIsleFarmEnByEF = new Int32Array(urgentFarmEn + 1)
    if (urgentFarmEn > 0) {
      const metricsAtZero = evalUnfundedFarmMetrics(0)
      const lossAtZero = metricsAtZero.totalLoss
      deferredSameIsleFarmEnByEF[0] = metricsAtZero.deferredSameIsleEn
      for (let eF = 1; eF <= urgentFarmEn; eF++) {
        const mAtEF = evalUnfundedFarmMetrics(eF)
        const gain = Math.max(0, lossAtZero - mAtEF.totalLoss)
        V_farmCurve[eF] = Math.max(V_farmCurve[eF - 1], gain)
        deferredSameIsleFarmEnByEF[eF] = mAtEF.deferredSameIsleEn
      }
    }

    // 2b. Compute remaining same-isle passive regen, chronological demand events, causal peak farm/craft deficit & deferral factor
    const sameIsleFutureIndices = []
    let futureSameIsleRegenEn = 0
    let estFutureSameIsleFarmEn = 0
    let futureSameIsleJointCraftEn = 0
    let peakFarmCraftDeficitEn = 0
    const sameIslePrefixRegenDemand = []
    let hasPostMidnightSameIsleReset = false
    let firstPostMidSec = b.atSec
    for (let fu = u + 1; fu < L; fu++) {
      if (seqBuckets[fu].isleIndex !== b.isleIndex) break
      sameIsleFutureIndices.push(fu)
      if (seqBuckets[fu].naturalDay !== b.naturalDay) {
        if (!hasPostMidnightSameIsleReset) firstPostMidSec = seqBuckets[fu].atSec
        hasPostMidnightSameIsleReset = true
      }
    }
    const isleBoundaryU = adapter.nextIsleBoundary(b.atSec, startWorld.clockStart)
    const sameIsleRaidsU = futureRaidsU.filter((fr) => R.isleIndex(fr.unlockAtSec) === b.isleIndex)
    const nextIsleRaidsU = futureRaidsU.filter((fr) => R.isleIndex(fr.unlockAtSec) > b.isleIndex)
    const sameIsleDemandEvents = []
    let sameIsleSimEndSec = b.atSec
    const earliestFutureSameIsleDtSec = sameIsleFutureIndices.length > 0
      ? Math.max(6, seqBuckets[sameIsleFutureIndices[0]].atSec - b.atSec)
      : 0
    const sameIsleDeferFactor = sameIsleFutureIndices.length > 0
      ? discountFactor(Math.max(Number(objectiveCfg.discountRatePerHour || 0), 0.002), earliestFutureSameIsleDtSec)
      : 1
    let curRawFishEvForGate = 0
    let maxFutureSameIsleFishEv = 0
    if (sameIsleFutureIndices.length > 0) {
      const rawCapGate = Number(R.energyMax(execWorld.state))
      const capEGate = Number.isFinite(rawCapGate) && rawCapGate > 0 ? rawCapGate : 100
      const craftUnitEnGate = Math.max(1, R.WORLD?.cost?.craft ?? 1)
      let prevSecGate = baseEnTU
      let cumFarmCraftDemand = 0
      for (const fu of sameIsleFutureIndices) {
        const fSec = seqBuckets[fu].atSec
        const segRegen = Math.min(capEGate, Math.max(0, Math.floor((fSec - prevSecGate) / regenStepU)))
        futureSameIsleRegenEn += segRegen
        prevSecGate += segRegen * regenStepU
        const fuFarm = estUrgentFarmEnByU[fu] || 0
        let fuCraft = 0
        for (const ca of jointCS.craftsByBucket[fu] || []) {
          fuCraft += craftUnitEnGate * Math.max(1, Number(ca.n || 1))
        }
        estFutureSameIsleFarmEn += fuFarm
        futureSameIsleJointCraftEn += fuCraft
        cumFarmCraftDemand += fuFarm + fuCraft
        sameIslePrefixRegenDemand.push({ cumRegen: futureSameIsleRegenEn, cumFarmCraft: cumFarmCraftDemand })
        const defHere = cumFarmCraftDemand - futureSameIsleRegenEn
        if (defHere > peakFarmCraftDeficitEn) peakFarmCraftDeficitEn = defHere
        if (fuFarm > 0 || fuCraft > 0 || fu === sameIsleFutureIndices[0]) {
          sameIsleDemandEvents.push({
            atSec: fSec,
            farmCraftEn: fuFarm + fuCraft,
            isFirstFutureBucket: fu === sameIsleFutureIndices[0],
            raidEn: 0,
          })
        }
      }
      for (let rIdx = 0; rIdx < sameIsleRaidsU.length; rIdx++) {
        const fr = sameIsleRaidsU[rIdx]
        sameIsleDemandEvents.push({
          atSec: fr.unlockAtSec,
          farmCraftEn: 0,
          isFirstFutureBucket: false,
          raidEn: Math.max(0, Math.floor(Number(fr.energyCost || 0))),
          raidIdx: rIdx,
        })
      }
      sameIsleDemandEvents.sort((a, b2) => (a.atSec - b2.atSec) || (b2.raidEn - a.raidEn))
      const lastSameIsleBucketSec = seqBuckets[sameIsleFutureIndices[sameIsleFutureIndices.length - 1]].atSec
      const maxSameIsleRaidSec = sameIsleRaidsU.length > 0 ? sameIsleRaidsU[sameIsleRaidsU.length - 1].unlockAtSec : 0
      sameIsleSimEndSec = (nextIsleRaidsU.length > 0 || tH >= isleBoundaryU)
        ? Math.min(tH, isleBoundaryU)
        : Math.min(tH, isleBoundaryU, Math.max(lastSameIsleBucketSec, maxSameIsleRaidSec))
      if (allowedSet.has('fish')) {
        const fyNow = expectedFishYieldPerCast(adapter, execWorld.state, b.atSec, true)
        curRawFishEvForGate = Object.entries(fyNow.byFish).reduce(
          (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, b.atSec) + qs[1] * marginalItemValueFn(fId, 1, b.atSec) + qs[2] * marginalItemValueFn(fId, 2, b.atSec),
          0
        )
        for (const fu of sameIsleFutureIndices) {
          const fb = seqBuckets[fu]
          const fyFut = expectedFishYieldPerCast(adapter, execWorld.state, fb.atSec, true)
          const fEv = Object.entries(fyFut.byFish).reduce(
            (acc, [fId, qs]) => acc + qs[0] * marginalItemValueFn(fId, 0, fb.atSec) + qs[1] * marginalItemValueFn(fId, 1, fb.atSec) + qs[2] * marginalItemValueFn(fId, 2, fb.atSec),
            0
          )
          if (fEv > maxFutureSameIsleFishEv) maxFutureSameIsleFishEv = fEv
        }
      }
    }

    if (u === 0) {
      const ksNonCraftCurve = solveBucketStaminaKnapsack(execWorld, 600, [], { fullIsleQuotas: true })
      const isleWindowEnd = Math.min(tH, adapter.nextIsleBoundary(b.atSec, startWorld.clockStart))
      const rawRegenInIsleWindow = Math.max(0, Math.floor((isleWindowEnd - baseEnTU) / regenStepU))
      const regenInIsleWindow = Math.max(0, rawRegenInIsleWindow - estFutureSameIsleFarmEn)
      const preEnSpent0 = urgentFarmEn
      const topUpUnits = []
      const s0 = execWorld.state
      const rawCap0 = Number(R.energyMax(s0))
      const enCap0 = Number.isFinite(rawCap0) && rawCap0 > 0 ? rawCap0 : 100
      if (allowedSet.has('eat')) {
        for (const spec of edibleSpecs) {
          const qty = spec.kind === 'snack'
            ? Math.min(
                adapter.availableInv(s0, spec.id, 0),
                spec.dailyCap != null ? Math.max(0, spec.dailyCap - Number(s0.cnt?.[spec.id] || 0)) : 999
              )
            : adapter.availableInv(s0, spec.id, spec.q)
          if (!(qty > 0) || !(spec.energyGain > 0)) continue
          const unitCost = spec.kind === 'snack' ? 0 : edibleOpportunityUnitValue(s0, spec.id, spec.q)
          topUpUnits.push({
            kind: 'eat',
            id: spec.id,
            q: spec.kind === 'snack' ? 0 : spec.q,
            qty,
            energyGain: spec.energyGain,
            cpe: unitCost / spec.energyGain,
          })
        }
      }
      if (allowedSet.has('coffee')) {
        const cLeft = Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(s0.cnt?.coffee || 0))
        const cPrice = R.WORLD?.coffee?.price || 15000
        const cEn = R.WORLD?.coffee?.energy || 60
        const freeC = Math.max(0, Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
        const canBuyC = Math.min(cLeft, Math.floor(freeC / cPrice))
        if (canBuyC > 0 && cEn > 0) {
          topUpUnits.push({
            kind: 'coffee',
            id: 'coffee',
            q: 0,
            qty: canBuyC,
            energyGain: cEn,
            cpe: (cPrice * bucketDisc) / cEn,
          })
        }
      }
      topUpUnits.sort((a, b2) => a.cpe - b2.cpe)
      u0MarginalStaminaMeta = {
        ksNonCraftCurve: {
          E: ksNonCraftCurve.E,
          bestAtMost: ksNonCraftCurve.bestAtMost,
        },
        bucketEnFloor,
        regenInIsleWindow,
        preEnSpent0,
        enCap0,
        topUpUnits,
        isleIndex0: b.isleIndex,
      }
    }

    let planWorld = adapter.cloneWorld(execWorld)
    let planBundles = cachedCraftBundles
    const plannedTopUpActs = []
    const baseSpendableEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - bucketEnFloor)
    let addedCoffeeEn = 0
    let addedExpiringSnackEn = 0

    const futureCraftNeedByItem = {}
    for (let fu = u + 1; fu < jointCS.craftsByBucket.length; fu++) {
      for (const ca of jointCS.craftsByBucket[fu] || []) {
        const rec = graph.recipesById.get(ca.id)
        for (const [inId, perU] of Object.entries(rec?.in || {})) {
          futureCraftNeedByItem[inId] = (futureCraftNeedByItem[inId] || 0) + perU * Number(ca.n || 1)
        }
      }
    }

    const freeFutureSameIsleEn = Math.max(0, futureSameIsleRegenEn - estFutureSameIsleFarmEn)
    const coffeePrice = R.WORLD?.coffee?.price || 15000
    const coffeeEnGain = R.WORLD?.coffee?.energy || 60
    const postMidDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, firstPostMidSec - t0))
    const fishCostEnU = Math.max(1, R.WORLD?.cost?.fish ?? 4)
    const usedFishU = sInitU.iq?.d === b.isleIndex ? Number(sInitU.iq.fish || 0) : 0
    const remFishU = Math.max(0, (R.WORLD?.daily?.fish || 80) - usedFishU)

    // Exact marginal value of lumpy stamina (`coffee` / expiring snack) carrying across `nextIsleBoundary`
    let nextIsleCarryValuePerEn = 0
    {
      let nextIsleBucket = null
      for (let fu = u + 1; fu < L; fu++) {
        if (seqBuckets[fu].isleIndex > b.isleIndex) {
          nextIsleBucket = seqBuckets[fu]
          break
        }
      }
      if (nextIsleBucket) {
        const nextIsleDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, nextIsleBucket.atSec - t0))
        let bestNextWorkPerEn = 0
        if (allowedSet.has('mine') && Number(sInitU.mine?.max || 0) > 0) {
          const mCost = Math.max(1, R.WORLD?.cost?.mine ?? 3)
          const oy = expectedMineYieldPerHit(adapter, sInitU, nextIsleBucket.isleDay)
          let oreEv = 0
          for (const [oId, qty] of Object.entries(oy.byOre || {})) {
            oreEv += qty * marginalItemValueFn(oId, 0, nextIsleBucket.atSec)
          }
          bestNextWorkPerEn = Math.max(bestNextWorkPerEn, oreEv / mCost)
        }
        if (allowedSet.has('fish')) {
          const fCost = Math.max(1, R.WORLD?.cost?.fish ?? 4)
          const fyN = expectedFishYieldPerCast(adapter, sInitU, nextIsleBucket.atSec, true)
          let fishEv = 0
          for (const [fId, qs] of Object.entries(fyN.byFish || {})) {
            fishEv += qs[0] * marginalItemValueFn(fId, 0, nextIsleBucket.atSec)
              + qs[1] * marginalItemValueFn(fId, 1, nextIsleBucket.atSec)
              + qs[2] * marginalItemValueFn(fId, 2, nextIsleBucket.atSec)
          }
          const baitPrice = Number(R.SHOP?.[utilityTokens.baitId]?.price || 80) * nextIsleDisc
          bestNextWorkPerEn = Math.max(bestNextWorkPerEn, Math.max(0, fishEv - baitPrice) / fCost)
        }
        const nextCoffeeCpe = allowedSet.has('coffee')
          ? (coffeePrice * nextIsleDisc) / Math.max(1, coffeeEnGain)
          : Infinity
        nextIsleCarryValuePerEn = Math.min(bestNextWorkPerEn, nextCoffeeCpe)
      } else if (objectiveCfg.terminalSupplyMode !== 'zero') {
        const termDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, tH - t0))
        nextIsleCarryValuePerEn = Math.max(0, Number(objectiveCfg.energyTerminalCreditPerPoint || 0)) * termDisc
      }
    }

    let sameIsleScheduledSaleCash = 0
    if (hasPostMidnightSameIsleReset && allowedSet.has('sell') && jointCS?.salePortfolio?.perItemSchedules) {
      const sameIsleSlotSet = new Set(sameIsleFutureIndices)
      for (const [id, sched] of jointCS.salePortfolio.perItemSchedules.entries()) {
        for (const fu of sameIsleSlotSet) {
          const row = sched.sellsBySlot?.[fu]
          if (!row) continue
          const pQuote = Number(slots[fu]?.prices?.[id] || 0)
          if (!(pQuote > 0)) continue
          const cropMult = graph.cropsById.has(id) ? 0.85 : 1.0
          for (let q = 0; q < 3; q++) {
            if (row[q] > 0) {
              sameIsleScheduledSaleCash += row[q] * Math.round(pQuote * (R.QUALITY?.[q] ?? 1)) * cropMult
            }
          }
        }
      }
    }

    const sameIsleRaidEn = futureRaidsU.reduce(
      (sAcc, fr) => (R.isleIndex(fr.unlockAtSec) === b.isleIndex ? sAcc + Math.max(0, Math.floor(Number(fr.energyCost || 0))) : sAcc),
      0
    )

    const buildDeferredRaidPool = (stWorld) => {
      const s = stWorld.state || {}
      const pool = []
      if (allowedSet.has('eat')) {
        for (const spec of edibleSpecs) {
          const rawHave = spec.kind === 'snack'
            ? adapter.availableInv(s, spec.id, 0)
            : Math.max(0, adapter.availableInv(s, spec.id, spec.q) - Number(futureCraftNeedByItem[spec.id] || 0))
          if (!(rawHave > 0) || !(spec.energyGain > 0)) continue
          const unitOpp = spec.kind === 'snack' ? 0 : edibleOpportunityUnitValue(s, spec.id, spec.q)
          pool.push({
            kind: 'eat',
            isSnack: spec.kind === 'snack',
            id: spec.id,
            q: spec.kind === 'snack' ? null : spec.q,
            rem: rawHave,
            dailyCap: spec.kind === 'snack' ? spec.dailyCap : null,
            initUsedToday: spec.kind === 'snack' ? Number(s.cnt?.[spec.id] || 0) : 0,
            energyGain: spec.energyGain,
            unitOppCost: unitOpp,
            cashCost: 0,
            sortCpe: unitOpp / spec.energyGain,
          })
        }
        if (allowedSet.has('stockBuy') && typeof R.b12Stock === 'function') {
          const stockItems = R.b12Stock(b.atSec, dynamicPrices)
          for (const cIt of stockItems) {
            const left = R.b12StockLeft(s, cIt, b.atSec)
            if (!(left > 0) || !(cIt.price > 0)) continue
            if (utilityTokens?.snackId && cIt.id === utilityTokens.snackId && R.B12_SNACK) {
              pool.push({
                kind: 'cargo-eat',
                isSnack: true,
                id: cIt.id,
                q: null,
                rem: left,
                dailyCap: R.B12_SNACK.daily,
                initUsedToday: Number(s.cnt?.[cIt.id] || 0),
                energyGain: R.B12_SNACK.energy,
                unitOppCost: cIt.price * bucketDisc,
                cashCost: cIt.price,
                sortCpe: (cIt.price * bucketDisc) / Math.max(1, R.B12_SNACK.energy),
              })
            } else {
              const cropDef = (R.CROPS || []).find((c) => c.id === cIt.id)
              if (cropDef && cropDef.eat > 0) {
                const g = Math.round(cropDef.eat * (R.QUALITY?.[0] ?? 1))
                if (g > 0) {
                  pool.push({
                    kind: 'cargo-eat',
                    isSnack: false,
                    id: cIt.id,
                    q: 0,
                    rem: left,
                    dailyCap: null,
                    initUsedToday: 0,
                    energyGain: g,
                    unitOppCost: cIt.price * bucketDisc,
                    cashCost: cIt.price,
                    sortCpe: (cIt.price * bucketDisc) / g,
                  })
                }
              }
            }
          }
        }
      }
      if (allowedSet.has('coffee') && coffeeEnGain > 0) {
        pool.push({
          kind: 'coffee',
          isSnack: false,
          id: 'coffee',
          q: null,
          rem: 99,
          dailyCap: R.WORLD?.daily?.coffee || 3,
          initUsedToday: Number(s.cnt?.coffee || 0),
          energyGain: coffeeEnGain,
          unitOppCost: coffeePrice * bucketDisc,
          cashCost: coffeePrice,
          sortCpe: (coffeePrice * bucketDisc) / coffeeEnGain,
        })
      }
      pool.sort((a, b2) => a.sortCpe - b2.sortCpe || a.unitOppCost - b2.unitOppCost)
      return pool
    }

    const buildFutureRaidStaminaSchedule = (
      poolTemplate,
      coinsStart,
      enMaxVal,
      maxPostECap,
      extraSnackUsedToday = 0,
      extraCoffeeUsedToday = 0
    ) => {
      if (futureRaidsU.length === 0) return null
      const maxPostE = Math.max(0, Math.floor(maxPostECap))
      const schedByPostEn = new Array(maxPostE + 1)
      let anyFeasible = false
      let minFeasiblePostEn = Infinity
      const P = poolTemplate.length
      const baseRemArr = new Int32Array(P)
      for (let i = 0; i < P; i++) baseRemArr[i] = poolTemplate[i].rem
      const cashFloor = Number(constraints.cashReserveFloor || 0)
      const initFreeCoins = Math.max(0, Number(coinsStart || 0) - cashFloor)
      const postMidNatDay = hasPostMidnightSameIsleReset ? R.worldDay(firstPostMidSec) : null

      const simulateRaidSequence = (raidsList, {
        initEn,
        initEnT,
        initCoins,
        initNatDay,
        initSnackUsedDay,
        initCoffeeUsedDay,
        initRemArr,
      }) => {
        const rem = new Int32Array(initRemArr)
        let e = initEn
        let enT = initEnT
        let freeCoins = initCoins
        let curNatDay = initNatDay
        let snackUsedDay = initSnackUsedDay
        let coffeeUsedDay = initCoffeeUsedDay
        let prepCost = 0
        let sameIsleAddedEn = 0
        let coffeeEn = 0
        let postMidSameIsleCoffeeUsed = 0
        let cashReserve = 0
        let eatReserve = null
        let feasible = true
        const addedPerRaid = new Int32Array(raidsList.length)

        for (let rIdx = 0; rIdx < raidsList.length; rIdx++) {
          const fr = raidsList[rIdx]
          const atSec = fr.unlockAtSec
          const needEn = Math.max(0, Math.floor(Number(fr.energyCost || 0)))
          const rNatDay = R.worldDay(atSec)
          if (rNatDay !== curNatDay) {
            curNatDay = rNatDay
            snackUsedDay = 0
            coffeeUsedDay = 0
          }
          const isSameIsleR = R.isleIndex(atSec) === b.isleIndex
          const rDisc = discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, atSec - t0))
          const adv = advanceScalarStamina(e, enT, enMaxVal, regenStepU, atSec)
          e = adv.en
          enT = adv.enT

          while (e < needEn) {
            let bestIdx = -1
            let bestCpe = Infinity
            let bestOpp = Infinity
            let bestGain = 0
            for (let pIdx = 0; pIdx < P; pIdx++) {
              if (rem[pIdx] <= 0) continue
              const pe = poolTemplate[pIdx]
              if (pe.cashCost > 0 && freeCoins < pe.cashCost) continue
              if (pe.kind === 'coffee') {
                const usedC = curNatDay === b.naturalDay ? pe.initUsedToday + coffeeUsedDay : coffeeUsedDay
                if (pe.dailyCap != null && usedC >= pe.dailyCap) continue
                const opp = pe.cashCost * rDisc
                const cpe = opp / pe.energyGain
                if (cpe < bestCpe - 1e-9 || (Math.abs(cpe - bestCpe) <= 1e-9 && opp < bestOpp)) {
                  bestIdx = pIdx
                  bestCpe = cpe
                  bestOpp = opp
                  bestGain = pe.energyGain
                }
              } else {
                if (e >= enMaxVal) continue
                if (pe.isSnack && pe.dailyCap != null) {
                  const usedS = curNatDay === b.naturalDay ? pe.initUsedToday + snackUsedDay : snackUsedDay
                  if (usedS >= pe.dailyCap) continue
                }
                const gain = Math.min(enMaxVal - e, pe.energyGain)
                if (!(gain > 0)) continue
                const opp = pe.cashCost > 0 ? pe.cashCost * rDisc : pe.unitOppCost
                const cpe = opp / gain
                if (cpe < bestCpe - 1e-9 || (Math.abs(cpe - bestCpe) <= 1e-9 && opp < bestOpp)) {
                  bestIdx = pIdx
                  bestCpe = cpe
                  bestOpp = opp
                  bestGain = gain
                }
              }
            }
            if (bestIdx < 0) {
              feasible = false
              break
            }
            const chosen = poolTemplate[bestIdx]
            rem[bestIdx] -= 1
            e += bestGain
            addedPerRaid[rIdx] += bestGain
            prepCost += bestOpp
            if (isSameIsleR) sameIsleAddedEn += bestGain
            if (chosen.kind === 'coffee') {
              coffeeUsedDay += 1
              if (postMidNatDay && curNatDay === postMidNatDay) {
                postMidSameIsleCoffeeUsed += 1
              }
              freeCoins -= chosen.cashCost
              coffeeEn += bestGain
              cashReserve += chosen.cashCost
            } else {
              if (chosen.isSnack) snackUsedDay += 1
              if (chosen.cashCost > 0) {
                freeCoins -= chosen.cashCost
                cashReserve += chosen.cashCost
              } else if (chosen.q != null) {
                eatReserve ||= {}
                eatReserve[chosen.id] ||= [0, 0, 0]
                eatReserve[chosen.id][chosen.q] += 1
              }
            }
          }

          if (!feasible) break
          if (e >= enMaxVal) enT = Math.max(enT, atSec)
          e -= needEn
        }

        return {
          feasible,
          terminalRaidEn: e,
          enT,
          prepCost,
          sameIsleAddedEn,
          coffeeEn,
          postMidSameIsleCoffeeUsed,
          cashReserve,
          eatReserve,
          addedPerRaid,
          remArrAfter: rem,
          freeCoinsAfter: freeCoins,
          curNatDayAfter: curNatDay,
          snackUsedAfter: snackUsedDay,
          coffeeUsedAfter: coffeeUsedDay,
        }
      }

      for (let postE = 0; postE <= maxPostE; postE++) {
        if (postE < bucketEnFloor) {
          schedByPostEn[postE] = { feasible: false }
          continue
        }
        const simFull = simulateRaidSequence(futureRaidsU, {
          initEn: postE,
          initEnT: postE >= enMaxVal ? b.atSec : exactStartEnTU,
          initCoins: initFreeCoins,
          initNatDay: b.naturalDay,
          initSnackUsedDay: extraSnackUsedToday,
          initCoffeeUsedDay: extraCoffeeUsedToday,
          initRemArr: baseRemArr,
        })
        if (simFull.feasible) {
          anyFeasible = true
          if (postE < minFeasiblePostEn) minFeasiblePostEn = postE
          schedByPostEn[postE] = {
            feasible: true,
            deferredPrepCost: simFull.prepCost,
            deferredSameIsleAddedEn: simFull.sameIsleAddedEn,
            deferredCoffeeEn: simFull.coffeeEn,
            deferredCashReserve: simFull.cashReserve,
            deferredEatReserve: simFull.eatReserve,
            addedPerRaid: simFull.addedPerRaid,
            terminalRaidEn: simFull.terminalRaidEn,
            postMidSameIsleCoffeeUsed: simFull.postMidSameIsleCoffeeUsed,
          }
        } else {
          schedByPostEn[postE] = { feasible: false }
        }
      }

      let sameIsleOnlyByPostEn = null
      let evalNextIsleRaids = null
      let minNextIsleEntryEnFor = null
      let prepKneeEntriesFor = null
      if (sameIsleFutureIndices.length > 0 && nextIsleRaidsU.length > 0) {
        const natDayAtIsleEnd = R.worldDay(isleBoundaryU)
        sameIsleOnlyByPostEn = new Array(maxPostE + 1)
        const zeroSameIsleFeasible = {
          feasible: true,
          prepCost: 0,
          sameIsleAddedEn: 0,
          coffeeEn: 0,
          postMidSameIsleCoffeeUsed: 0,
          cashReserve: 0,
          eatReserve: null,
          addedPerRaid: new Int32Array(0),
          remArrAfter: baseRemArr,
          freeCoinsAfter: initFreeCoins,
          curNatDayAfter: natDayAtIsleEnd,
          snackUsedAfter: natDayAtIsleEnd === b.naturalDay ? extraSnackUsedToday : 0,
          coffeeUsedAfter: natDayAtIsleEnd === b.naturalDay ? extraCoffeeUsedToday : 0,
        }
        for (let postE = 0; postE <= maxPostE; postE++) {
          if (postE < bucketEnFloor) {
            sameIsleOnlyByPostEn[postE] = { feasible: false }
            continue
          }
          if (sameIsleRaidsU.length === 0) {
            sameIsleOnlyByPostEn[postE] = zeroSameIsleFeasible
          } else {
            const sRes = simulateRaidSequence(sameIsleRaidsU, {
              initEn: postE,
              initEnT: postE >= enMaxVal ? b.atSec : exactStartEnTU,
              initCoins: initFreeCoins,
              initNatDay: b.naturalDay,
              initSnackUsedDay: extraSnackUsedToday,
              initCoffeeUsedDay: extraCoffeeUsedToday,
              initRemArr: baseRemArr,
            })
            if (sRes.feasible && natDayAtIsleEnd !== sRes.curNatDayAfter) {
              sRes.curNatDayAfter = natDayAtIsleEnd
              sRes.snackUsedAfter = 0
              sRes.coffeeUsedAfter = 0
            }
            sameIsleOnlyByPostEn[postE] = sRes
          }
        }

        const nextMemo = new Map()
        evalNextIsleRaids = (postE, entryEnAtIsleEnd) => {
          const pE = Math.max(0, Math.min(maxPostE, Math.floor(postE)))
          const sRs = sameIsleOnlyByPostEn[pE]
          if (!sRs || !sRs.feasible) return { feasible: false }
          const entryE = Math.max(0, Math.min(maxPostE, Math.floor(entryEnAtIsleEnd)))
          const mKey = sameIsleRaidsU.length === 0 ? entryE : (pE * (maxPostE + 1) + entryE)
          const hit = nextMemo.get(mKey)
          if (hit) return hit
          const nRes = simulateRaidSequence(nextIsleRaidsU, {
            initEn: entryE,
            initEnT: isleBoundaryU,
            initCoins: sRs.freeCoinsAfter,
            initNatDay: sRs.curNatDayAfter,
            initSnackUsedDay: sRs.snackUsedAfter,
            initCoffeeUsedDay: sRs.coffeeUsedAfter,
            initRemArr: sRs.remArrAfter,
          })
          nextMemo.set(mKey, nRes)
          return nRes
        }

        const minEntryMemo = new Map()
        minNextIsleEntryEnFor = (postE) => {
          const pE = Math.max(0, Math.min(maxPostE, Math.floor(postE)))
          const sRs = sameIsleOnlyByPostEn[pE]
          if (!sRs || !sRs.feasible) return Infinity
          const mKey = sameIsleRaidsU.length === 0 ? 0 : pE
          if (minEntryMemo.has(mKey)) return minEntryMemo.get(mKey)
          let ans = Infinity
          for (let eTry = 0; eTry <= maxPostE; eTry++) {
            if (evalNextIsleRaids(pE, eTry).feasible) {
              ans = eTry
              break
            }
          }
          minEntryMemo.set(mKey, ans)
          return ans
        }

        const kneeMemo = new Map()
        prepKneeEntriesFor = (postE) => {
          const pE = Math.max(0, Math.min(maxPostE, Math.floor(postE)))
          const mKey = sameIsleRaidsU.length === 0 ? 0 : pE
          if (kneeMemo.has(mKey)) return kneeMemo.get(mKey)
          const minE = minNextIsleEntryEnFor(pE)
          if (!Number.isFinite(minE)) {
            kneeMemo.set(mKey, [])
            return []
          }
          const knees = [minE]
          let prevCost = evalNextIsleRaids(pE, minE).prepCost
          for (let eTry = minE + 1; eTry <= maxPostE; eTry++) {
            const nr = evalNextIsleRaids(pE, eTry)
            if (!nr.feasible) continue
            if (nr.prepCost < prevCost - 1e-9) {
              knees.push(eTry)
              prevCost = nr.prepCost
              if (prevCost <= 1e-9) break
            }
          }
          kneeMemo.set(mKey, knees)
          return knees
        }
      }

      return {
        anyFeasible,
        minFeasiblePostEn,
        maxPostE,
        schedByPostEn,
        sameIsleOnlyByPostEn,
        evalNextIsleRaids,
        minNextIsleEntryEnFor,
        prepKneeEntriesFor,
      }
    }

    const totalFutureSameIsleMandatoryEn = estFutureSameIsleFarmEn + futureSameIsleJointCraftEn
    const rawPoolAfterCraftReserveGlobal = (qCounts, craftReserve) => {
      const rem = [qCounts[0], qCounts[1], qCounts[2]]
      let keep = craftReserve
      for (let qIdx = 0; qIdx < 3 && keep > 0; qIdx++) {
        const tk = Math.min(rem[qIdx], keep)
        rem[qIdx] -= tk
        keep -= tk
      }
      return rem
    }
    const buildSameIsleSurplusRationChunks = (stWorld, usedExtraMap = null) => {
      if (sameIsleFutureIndices.length === 0 || !allowedSet.has('eat')) return []
      const s = stWorld?.state || {}
      const chunks = []
      const extraTotalById = new Map()
      if (usedExtraMap) {
        for (const [k, qtyUsed] of Object.entries(usedExtraMap)) {
          if (!(qtyUsed > 0)) continue
          const idOnly = k.split(':')[0]
          extraTotalById.set(idOnly, (extraTotalById.get(idOnly) || 0) + Number(qtyUsed))
        }
      }
      for (const spec of edibleSpecs) {
        if (!(spec.energyGain > 0)) continue
        const keyS = spec.kind === 'snack' ? `${spec.id}:snack` : `${spec.id}:${spec.q}`
        const usedThisSpec = Number(usedExtraMap?.[keyS] || 0)
        if (spec.kind === 'snack') {
          const haveS = Math.max(0, adapter.availableInv(s, spec.id, 0) - usedThisSpec)
          const remCap = spec.dailyCap != null
            ? (hasPostMidnightSameIsleReset
                ? spec.dailyCap + Math.max(0, spec.dailyCap - Number(s.cnt?.[spec.id] || 0) - usedThisSpec)
                : Math.max(0, spec.dailyCap - Number(s.cnt?.[spec.id] || 0) - usedThisSpec))
            : haveS
          const avail = Math.min(haveS, remCap)
          if (avail > 0) {
            chunks.push({ id: spec.id, q: null, count: avail, energyGain: spec.energyGain, cpe: 0 })
          }
          continue
        }
        const qHold = [
          Math.max(0, adapter.availableInv(s, spec.id, 0) - Number(usedExtraMap?.[`${spec.id}:0`] || 0)),
          Math.max(0, adapter.availableInv(s, spec.id, 1) - Number(usedExtraMap?.[`${spec.id}:1`] || 0)),
          Math.max(0, adapter.availableInv(s, spec.id, 2) - Number(usedExtraMap?.[`${spec.id}:2`] || 0)),
        ]
        const futNeed = Number(futureCraftNeedByItem[spec.id] || 0)
        const remAfterReserve = rawPoolAfterCraftReserveGlobal(qHold, futNeed)
        const surplusQ = remAfterReserve[spec.q] || 0
        if (surplusQ > 0) {
          const unitCost = edibleOpportunityUnitValue(s, spec.id, spec.q)
          chunks.push({
            id: spec.id,
            q: spec.q,
            count: surplusQ,
            energyGain: spec.energyGain,
            cpe: unitCost / spec.energyGain,
          })
        }
      }
      chunks.sort((a, b2) => a.cpe - b2.cpe)
      return chunks
    }

    const evalWholeIsleObjective = (
      ksLocal,
      ksIsle,
      enMaxVal,
      curCoinsVal,
      candTotalUEn,
      candCoffeeEn,
      candExpiringSnackEn = 0,
      raidSched = null,
      remSameIsleRationChunks = null,
      isPostTopUpAlloc = false
    ) => {
      const initExecEnU = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)))
      const freeOvernightWorkCash = (allowedSet.has('sell') && ksIsle && freeFutureSameIsleEn > 0)
        ? ksIsle.bestAtMost[Math.min(ksIsle.E, freeFutureSameIsleEn)]
        : 0
      const postMidCashAvail = curCoinsVal + sameIsleScheduledSaleCash + freeOvernightWorkCash
      const postMidCoffeeCap = (hasPostMidnightSameIsleReset && allowedSet.has('coffee'))
        ? Math.min(
            R.WORLD?.daily?.coffee || 3,
            Math.floor(Math.max(0, postMidCashAvail - Number(constraints.cashReserveFloor || 0)) / coffeePrice)
          )
        : 0

      const baseChunks = remSameIsleRationChunks || []
      const objTagMap = new WeakMap()
      let nextObjTag = 1
      const getObjTag = (obj) => {
        if (!obj) return 0
        let t = objTagMap.get(obj)
        if (!t) {
          t = nextObjTag++
          objTagMap.set(obj, t)
        }
        return t
      }
      const peakIdxByCpe = new Map()
      const getPeakIdxForCpe = (cpe) => {
        let pk = peakIdxByCpe.get(cpe)
        if (pk !== undefined) return pk
        pk = 0
        if (ksIsle && ksIsle.E > 0) {
          let bestSc = ksIsle.bestAtMost[0] * sameIsleDeferFactor
          for (let idx = 1; idx <= ksIsle.E; idx++) {
            const sc = ksIsle.bestAtMost[idx] * sameIsleDeferFactor - idx * cpe
            if (sc > bestSc + 1e-6) {
              bestSc = sc
              pk = idx
            }
          }
        }
        peakIdxByCpe.set(cpe, pk)
        return pk
      }
      const simSurplusMemo = new Map()

      const mergeEatReserves = (aRes, bRes) => {
        if (!aRes && !bRes) return null
        const out = {}
        for (const src of [aRes, bRes]) {
          if (!src) continue
          for (const [id, arr] of Object.entries(src)) {
            out[id] ||= [0, 0, 0]
            out[id][0] += Number(arr[0] || 0)
            out[id][1] += Number(arr[1] || 0)
            out[id][2] += Number(arr[2] || 0)
          }
        }
        return out
      }
      const mergeRaidEntries = (sRs, nRs) => ({
        feasible: Boolean(sRs?.feasible && nRs?.feasible),
        deferredPrepCost: Number(sRs?.prepCost || 0) + Number(nRs?.prepCost || 0),
        deferredSameIsleAddedEn: Number(sRs?.sameIsleAddedEn || 0) + Number(nRs?.sameIsleAddedEn || 0),
        deferredCoffeeEn: Number(sRs?.coffeeEn || 0) + Number(nRs?.coffeeEn || 0),
        deferredCashReserve: Number(sRs?.cashReserve || 0) + Number(nRs?.cashReserve || 0),
        deferredEatReserve: mergeEatReserves(sRs?.eatReserve, nRs?.eatReserve),
        addedPerRaid: sRs?.addedPerRaid || null,
        terminalRaidEn: Number(nRs?.terminalRaidEn ?? sRs?.terminalRaidEn ?? 0),
        postMidSameIsleCoffeeUsed: Number(sRs?.postMidSameIsleCoffeeUsed || 0) + Number(nRs?.postMidSameIsleCoffeeUsed || 0),
      })

      const simulateSameIsleSurplus = (
        rawCarryEn,
        deferredEatReserve = null,
        deferredUrgentEn = 0,
        raidAddedArr = null,
        sameIsleCoffeeSpent = 0
      ) => {
        const eInt = Math.max(0, Math.floor(rawCarryEn))
        const dUrgInt = Math.max(0, Math.floor(deferredUrgentEn || 0))
        const cSpentInt = Math.max(0, Number(sameIsleCoffeeSpent || 0))
        const memKey = `${eInt}:${dUrgInt}:${cSpentInt}:${getObjTag(deferredEatReserve)}:${getObjTag(raidAddedArr)}`
        const memHit = simSurplusMemo.get(memKey)
        if (memHit) return memHit

        let chunks = baseChunks
        if (deferredEatReserve && chunks.length > 0) {
          chunks = chunks.map((ch) => {
            if (ch.q == null) return ch
            const used = Number(deferredEatReserve?.[ch.id]?.[ch.q] || 0)
            if (used <= 0) return ch
            return { ...ch, count: Math.max(0, ch.count - used) }
          }).filter((ch) => ch.count > 0)
        }

        let e = eInt
        let enT = e >= enMaxVal ? b.atSec : exactStartEnTU
        let mandatoryDeficit = 0
        for (const ev of sameIsleDemandEvents) {
          const adv = advanceScalarStamina(e, enT, enMaxVal, regenStepU, ev.atSec)
          e = adv.en
          enT = adv.enT
          if (ev.raidEn > 0) {
            const rAdd = raidAddedArr ? Number(raidAddedArr[ev.raidIdx] || 0) : 0
            if (rAdd > 0) {
              e += rAdd
              if (e >= enMaxVal) enT = Math.max(enT, ev.atSec)
            }
            const need = ev.raidEn
            if (e >= need) {
              e -= need
            } else {
              mandatoryDeficit += need - e
              e = 0
            }
          } else {
            const need = ev.farmCraftEn + (ev.isFirstFutureBucket ? dUrgInt : 0)
            if (need > 0) {
              if (e >= need) {
                e -= need
              } else {
                mandatoryDeficit += need - e
                e = 0
              }
            }
          }
        }
        const advEnd = advanceScalarStamina(e, enT, enMaxVal, regenStepU, sameIsleSimEndSec)
        const surplusAtIsleEnd = advEnd.en

        let mandatoryRationCost = 0
        let chunkIdx = 0
        let chunkRemEn = chunks.length > 0 ? chunks[0].count * chunks[0].energyGain : 0
        let remMand = mandatoryDeficit
        while (remMand > 0 && chunkIdx < chunks.length) {
          if (chunkRemEn <= 0) {
            chunkIdx++
            chunkRemEn = chunkIdx < chunks.length ? chunks[chunkIdx].count * chunks[chunkIdx].energyGain : 0
            continue
          }
          const take = Math.min(remMand, chunkRemEn)
          mandatoryRationCost += take * chunks[chunkIdx].cpe
          chunkRemEn -= take
          remMand -= take
        }
        let remCoffeeSlots = Math.max(0, postMidCoffeeCap - cSpentInt)
        if (remMand > 0 && remCoffeeSlots > 0 && coffeeEnGain > 0) {
          const cNeed = Math.min(remCoffeeSlots, Math.ceil(remMand / coffeeEnGain))
          mandatoryRationCost += cNeed * coffeePrice * postMidDisc
          remCoffeeSlots -= cNeed
          remMand = Math.max(0, remMand - cNeed * coffeeEnGain)
        }
        if (remMand > 0) {
          mandatoryRationCost += remMand * 450
        }

        const totalSurplusPool = Math.max(0, surplusAtIsleEnd - remMand)
        const simResult = {
          totalSurplusPool,
          mandatoryRationCost,
          chunks,
          chunkIdx,
          chunkRemEn,
          remCoffeeSlots,
        }
        simSurplusMemo.set(memKey, simResult)
        return simResult
      }

      const scoreSameIsleContFromSurplus = (
        eLocalVal,
        surplusSim,
        lumpyAddedEn,
        allowWorkRationsHere = true,
        { holdFromSurplus = 0, overrideCarryNext = null } = {}
      ) => {
        const localKsVal = ksLocal ? ksLocal.bestAtMost[Math.min(ksLocal.E, Math.max(0, Math.floor(eLocalVal)))] : 0
        const availCovForKsIsle = Math.max(0, surplusSim.totalSurplusPool - Math.max(0, Math.floor(holdFromSurplus)))
        let bestW = -1e18
        let bestFutureKsUsed = 0
        let bestCarryNext = 0

        if (!ksIsle || ksIsle.E <= 0) {
          const carryNext = overrideCarryNext != null
            ? Math.min(enMaxVal, Math.min(lumpyAddedEn, overrideCarryNext))
            : Math.min(enMaxVal, Math.min(lumpyAddedEn, availCovForKsIsle))
          bestW = localKsVal - surplusSim.mandatoryRationCost + carryNext * nextIsleCarryValuePerEn
          bestFutureKsUsed = 0
          bestCarryNext = carryNext
          return { bestW, bestFutureKsUsed, bestCarryNext }
        }

        const extraNowFishBonus = (allowedSet.has('fish') && curRawFishEvForGate > maxFutureSameIsleFishEv + 1e-6 && remFishU > 0)
          ? Math.min(remFishU, Math.floor(eLocalVal / fishCostEnU)) * (curRawFishEvForGate - maxFutureSameIsleFishEv)
          : 0

        const eLocalClamped = Math.max(0, Math.floor(eLocalVal))
        const remQuotaCap = Math.max(0, ksIsle.E - eLocalClamped)
        const evalLaterVal = (covVal) => {
          const cClamped = Math.max(0, Math.floor(covVal))
          const capByStamina = ksIsle.bestAtMost[Math.min(ksIsle.E, cClamped)]
          const totalIsleIdx = Math.min(ksIsle.E, eLocalClamped + cClamped)
          const capByQuota = Math.max(0, ksIsle.bestAtMost[totalIsleIdx] + extraNowFishBonus - localKsVal)
          return Math.min(capByStamina, capByQuota)
        }

        const { chunks, chunkIdx, chunkRemEn, remCoffeeSlots, mandatoryRationCost } = surplusSim
        for (let kC = 0; kC <= remCoffeeSlots; kC++) {
          let cov = availCovForKsIsle + kC * coffeeEnGain
          let rationWorkCost = 0
          let ci = chunkIdx
          let cr = chunkRemEn
          if (allowWorkRationsHere && remQuotaCap > 0) {
            while (cov < remQuotaCap && ci < chunks.length) {
              if (cr <= 0) {
                ci++
                cr = ci < chunks.length ? chunks[ci].count * chunks[ci].energyGain : 0
                continue
              }
              const cpe = chunks[ci].cpe
              const maxStep = Math.min(remQuotaCap - cov, cr)
              const curLater = evalLaterVal(cov)
              let bestDe = 0
              let bestNet = 0
              const testRange = (loD, hiD) => {
                const lo = Math.max(1, Math.floor(loD))
                const hi = Math.min(maxStep, Math.ceil(hiD))
                for (let dE = lo; dE <= hi; dE++) {
                  const netGain = (evalLaterVal(cov + dE) - curLater) * sameIsleDeferFactor - dE * cpe
                  if (netGain > bestNet + 1e-6) {
                    bestNet = netGain
                    bestDe = dE
                  }
                }
              }
              if (maxStep <= 32) {
                testRange(1, maxStep)
              } else {
                let loB = 0
                let hiB = Math.floor(maxStep / 12)
                while (loB < hiB) {
                  const mid = (loB + hiB) >> 1
                  const dM = mid * 12
                  const dN = (mid + 1) * 12
                  const vM = (evalLaterVal(cov + dM) - curLater) * sameIsleDeferFactor - dM * cpe
                  const vN = (evalLaterVal(cov + dN) - curLater) * sameIsleDeferFactor - dN * cpe
                  if (vN > vM + 1e-9) loB = mid + 1
                  else hiB = mid
                }
                testRange(1, 12)
                testRange(loB * 12 - 12, loB * 12 + 12)
                testRange(maxStep - 12, maxStep)
                const pk = getPeakIdxForCpe(cpe)
                testRange(pk - eLocalClamped - cov - 12, pk - eLocalClamped - cov + 12)
                testRange(pk - cov - 12, pk - cov + 12)
              }
              if (bestDe > 0) {
                cov += bestDe
                rationWorkCost += bestDe * cpe
                cr -= bestDe
                if (bestDe < maxStep) break
              } else {
                break
              }
            }
          }
          const lumpySpillCap = Math.min(enMaxVal, lumpyAddedEn + kC * coffeeEnGain)
          const rawCarryNext = overrideCarryNext != null
            ? Math.max(0, overrideCarryNext)
            : Math.max(0, cov - ksIsle.E)
          const carryNext = Math.min(lumpySpillCap, rawCarryNext)

          const laterVal = evalLaterVal(cov)

          const candW = localKsVal
            + laterVal * sameIsleDeferFactor
            - kC * coffeePrice * postMidDisc
            - mandatoryRationCost
            - rationWorkCost
            + carryNext * nextIsleCarryValuePerEn
          if (candW > bestW) {
            bestW = candW
            bestFutureKsUsed = Math.min(remQuotaCap, availCovForKsIsle)
            bestCarryNext = carryNext
          }
        }
        return { bestW, bestFutureKsUsed, bestCarryNext }
      }

      if (raidSched) {
        if (!raidSched.anyFeasible) {
          return {
            bestVal: -1e18,
            bestEF: 0,
            bestELocal: 0,
            bestPostEnFloor: Infinity,
            feasible: false,
            bestRaidPrepCost: Infinity,
            bestFutureKsUsed: 0,
            bestCarryNext: 0,
            bestRaidEntry: null,
          }
        }
        const curEnVal = Math.max(0, Math.floor(candTotalUEn)) + bucketEnFloor
        const maxSpendS = Math.min(
          Math.max(0, curEnVal - Math.max(bucketEnFloor, raidSched.minFeasiblePostEn)),
          urgentFarmEn + ksLocal.E
        )
        const hasSplitIsleRaids = sameIsleFutureIndices.length > 0 && nextIsleRaidsU.length > 0 && Boolean(raidSched.evalNextIsleRaids)
        const bucketFloorReleaseAtIsleEnd = isleBoundaryU >= Number(constraints.staminaReserveUntilSec || 0)
          ? bucketEnFloor
          : 0
        let bestVal = -1e18
        let bestEF = 0
        let bestELocal = 0
        let bestPostEnFloor = curEnVal
        let bestRaidPrepCost = Infinity
        let bestFutureKsUsed = 0
        let bestCarryNext = 0
        let bestRaidEntry = null
        let foundFeasible = false

        for (let S = 0; S <= maxSpendS; S++) {
          const rawPostE = curEnVal - S
          const postE = S === 0 && curEnVal > initExecEnU
            ? Math.min(rawPostE, Math.max(bucketEnFloor, initExecEnU))
            : rawPostE
          if (postE < 0 || postE > raidSched.maxPostE) continue
          const allowWorkRationsHere = isPostTopUpAlloc || ((S > 0 ? curEnVal : postE) >= enMaxVal)

          const minEFForS = Math.max(0, S - ksLocal.E)
          const maxEFForS = Math.min(urgentFarmEn, S)
          if (minEFForS > maxEFForS) continue

          if (sameIsleFutureIndices.length === 0) {
            const rs = raidSched.schedByPostEn[postE]
            if (!rs || !rs.feasible) continue
            const postRaidPool = Math.max(0, rs.terminalRaidEn - bucketEnFloor)
            const lumpySpillCap = Math.min(enMaxVal, candCoffeeEn + candExpiringSnackEn + rs.deferredCoffeeEn)
            const carryNext = Math.min(lumpySpillCap, postRaidPool)
            const carryMinusPrep = carryNext * nextIsleCarryValuePerEn - rs.deferredPrepCost
            for (let eF = minEFForS; eF <= maxEFForS; eF++) {
              const eLocal = S - eF
              const localKsVal = ksLocal ? ksLocal.bestAtMost[Math.min(ksLocal.E, eLocal)] : 0
              const tot = V_farmCurve[eF] + localKsVal + carryMinusPrep
              if (!foundFeasible || tot > bestVal + 1e-9) {
                foundFeasible = true
                bestVal = tot
                bestEF = eF
                bestELocal = eLocal
                bestPostEnFloor = postE
                bestRaidPrepCost = rs.deferredPrepCost
                bestFutureKsUsed = 0
                bestCarryNext = carryNext
                bestRaidEntry = rs
              }
            }
          } else if (hasSplitIsleRaids) {
            const sRs = raidSched.sameIsleOnlyByPostEn?.[postE]
            if (!sRs || !sRs.feasible) continue
            const knees = raidSched.prepKneeEntriesFor ? raidSched.prepKneeEntriesFor(postE) : []
            if (knees.length === 0) continue
            const preMergedEat = sRs.eatReserve
            const lumpySpillHere = candCoffeeEn + candExpiringSnackEn
            for (let eF = minEFForS; eF <= maxEFForS; eF++) {
              const eLocal = S - eF
              const defUrgEF = deferredSameIsleFarmEnByEF[eF] || 0
              const simRes = simulateSameIsleSurplus(
                postE - bucketEnFloor,
                preMergedEat,
                defUrgEF,
                sRs.addedPerRaid,
                sRs.postMidSameIsleCoffeeUsed
              )
              const maxHoldable = simRes.totalSurplusPool + bucketFloorReleaseAtIsleEnd
              if (knees[0] > maxHoldable) continue
              const holdCandidates = []
              for (const kH of knees) {
                if (kH <= maxHoldable) {
                  if (!holdCandidates.includes(kH)) holdCandidates.push(kH)
                  if (lumpySpillHere > 0) {
                    const spillHold = Math.min(maxHoldable, enMaxVal, kH + lumpySpillHere)
                    if (spillHold >= knees[0] && !holdCandidates.includes(spillHold)) holdCandidates.push(spillHold)
                  }
                }
              }
              const capHold = Math.min(maxHoldable, enMaxVal)
              if (capHold >= knees[0] && !holdCandidates.includes(capHold)) holdCandidates.push(capHold)
              if (maxHoldable >= knees[0] && !holdCandidates.includes(maxHoldable)) holdCandidates.push(maxHoldable)

              for (const holdTotal of holdCandidates) {
                const nRs = raidSched.evalNextIsleRaids(postE, holdTotal)
                if (!nRs || !nRs.feasible) continue
                const merged = mergeRaidEntries(sRs, nRs)
                const effSimRes = nRs.eatReserve
                  ? simulateSameIsleSurplus(
                      postE - bucketEnFloor,
                      merged.deferredEatReserve,
                      defUrgEF,
                      sRs.addedPerRaid,
                      sRs.postMidSameIsleCoffeeUsed
                    )
                  : simRes
                const effMaxHoldable = effSimRes.totalSurplusPool + bucketFloorReleaseAtIsleEnd
                if (holdTotal > effMaxHoldable) continue
                const holdFromSurplus = Math.max(0, holdTotal - bucketFloorReleaseAtIsleEnd)
                const overrideCarryNext = Math.max(0, nRs.terminalRaidEn - bucketEnFloor)
                const cont = scoreSameIsleContFromSurplus(
                  eLocal,
                  effSimRes,
                  lumpySpillHere + merged.deferredCoffeeEn,
                  allowWorkRationsHere,
                  { holdFromSurplus, overrideCarryNext }
                )
                const tot = V_farmCurve[eF] + cont.bestW - merged.deferredPrepCost
                if (!foundFeasible || tot > bestVal + 1e-9) {
                  foundFeasible = true
                  bestVal = tot
                  bestEF = eF
                  bestELocal = eLocal
                  bestPostEnFloor = postE
                  bestRaidPrepCost = merged.deferredPrepCost
                  bestFutureKsUsed = cont.bestFutureKsUsed
                  bestCarryNext = cont.bestCarryNext
                  bestRaidEntry = merged
                }
              }
            }
          } else {
            const rs = raidSched.schedByPostEn[postE]
            if (!rs || !rs.feasible) continue
            for (let eF = minEFForS; eF <= maxEFForS; eF++) {
              const eLocal = S - eF
              const defUrgEF = deferredSameIsleFarmEnByEF[eF] || 0
              const simRes = simulateSameIsleSurplus(
                postE - bucketEnFloor,
                rs.deferredEatReserve,
                defUrgEF,
                rs.addedPerRaid,
                rs.postMidSameIsleCoffeeUsed
              )
              const cont = scoreSameIsleContFromSurplus(
                eLocal,
                simRes,
                candCoffeeEn + candExpiringSnackEn + rs.deferredCoffeeEn,
                allowWorkRationsHere
              )
              const tot = V_farmCurve[eF] + cont.bestW - rs.deferredPrepCost
              if (!foundFeasible || tot > bestVal + 1e-9) {
                foundFeasible = true
                bestVal = tot
                bestEF = eF
                bestELocal = eLocal
                bestPostEnFloor = postE
                bestRaidPrepCost = rs.deferredPrepCost
                bestFutureKsUsed = cont.bestFutureKsUsed
                bestCarryNext = cont.bestCarryNext
                bestRaidEntry = rs
              }
            }
          }
        }
        return {
          bestVal,
          bestEF,
          bestELocal,
          bestPostEnFloor,
          feasible: foundFeasible,
          bestRaidPrepCost,
          bestFutureKsUsed,
          bestCarryNext,
          bestRaidEntry,
          simulateSameIsleSurplus,
          mergeRaidEntries,
        }
      }

      const maxEF = Math.min(urgentFarmEn, Math.max(0, Math.floor(candTotalUEn)))
      const allowWorkRationsHere = isPostTopUpAlloc || (Math.floor(candTotalUEn) + bucketEnFloor >= enMaxVal)
      let bestVal = -1e18
      let bestEF = 0
      for (let eF = 0; eF <= maxEF; eF++) {
        const remAfterFarm = Math.max(0, candTotalUEn - eF)
        let shiftVal = 0
        if (sameIsleFutureIndices.length === 0) {
          const usedLocal = Math.min(ksLocal.E, remAfterFarm)
          const lumpySpillCap = Math.min(enMaxVal, candCoffeeEn + candExpiringSnackEn)
          const carryNext = Math.min(lumpySpillCap, Math.max(0, remAfterFarm - usedLocal))
          shiftVal = ksLocal.bestAtMost[usedLocal] + carryNext * nextIsleCarryValuePerEn
        } else {
          const defUrgEF = deferredSameIsleFarmEnByEF[eF] || 0
          let peakDefForEF = peakFarmCraftDeficitEn
          if (defUrgEF > 0) {
            for (const stP of sameIslePrefixRegenDemand) {
              const defP = stP.cumFarmCraft - Math.max(0, stP.cumRegen - defUrgEF)
              if (defP > peakDefForEF) peakDefForEF = defP
            }
            if (defUrgEF > peakDefForEF) peakDefForEF = defUrgEF
          }
          const maxCarryNoOverflow = Math.max(0, enMaxVal - bucketEnFloor) + candCoffeeEn
          const eLocalA = Math.min(ksLocal.E, remAfterFarm)
          const maxCarryA = Math.max(Math.max(0, baseSpendableEn - eF - eLocalA), maxCarryNoOverflow)
          const carryA = Math.min(Math.max(0, remAfterFarm - eLocalA), maxCarryA)
          const simA = simulateSameIsleSurplus(carryA, null, defUrgEF)
          let bestChoice = scoreSameIsleContFromSurplus(
            eLocalA,
            simA,
            candCoffeeEn + candExpiringSnackEn,
            allowWorkRationsHere
          ).bestW
          if (peakDefForEF > carryA && eLocalA > 0) {
            const maxCarryB = Math.max(Math.max(0, baseSpendableEn - eF), maxCarryNoOverflow)
            const targetCarryB = Math.min(remAfterFarm, peakDefForEF, maxCarryB)
            const eLocalB = Math.min(ksLocal.E, Math.max(0, remAfterFarm - targetCarryB))
            const carryB = Math.min(Math.max(0, remAfterFarm - eLocalB), maxCarryB)
            const simB = simulateSameIsleSurplus(carryB, null, defUrgEF)
            const choiceB = scoreSameIsleContFromSurplus(
              eLocalB,
              simB,
              candCoffeeEn + candExpiringSnackEn,
              allowWorkRationsHere
            ).bestW
            if (choiceB > bestChoice) bestChoice = choiceB
          }
          if (maxFutureSameIsleFishEv > curRawFishEvForGate + 1e-6 && eLocalA > 0) {
            const maxCarryC = Math.max(Math.max(0, baseSpendableEn - eF), maxCarryNoOverflow)
            const carryC = Math.min(remAfterFarm, maxCarryC)
            const simC = simulateSameIsleSurplus(carryC, null, defUrgEF)
            const choiceC = scoreSameIsleContFromSurplus(
              0,
              simC,
              candCoffeeEn + candExpiringSnackEn,
              allowWorkRationsHere
            ).bestW
            if (choiceC > bestChoice) bestChoice = choiceC
          }
          shiftVal = bestChoice
        }
        const tot = V_farmCurve[eF] + shiftVal
        if (tot > bestVal + 1e-9) {
          bestVal = tot
          bestEF = eF
        }
      }
      return {
        bestVal,
        bestEF,
        bestELocal: 0,
        bestPostEnFloor: bucketEnFloor,
        feasible: true,
        bestRaidPrepCost: 0,
        bestFutureKsUsed: 0,
        bestCarryNext: 0,
        bestRaidEntry: null,
      }
    }

    const computeIsleWorkCapEn = (st) => {
      const iq = st?.iq?.d === b.isleIndex ? st.iq : {}
      const mLeft = allowedSet.has('mine') ? Math.max(0, (R.WORLD?.daily?.mine || 100) - Number(iq.mine || 0)) : 0
      const fLeft = allowedSet.has('fish') ? Math.max(0, (R.WORLD?.daily?.fish || 80) - Number(iq.fish || 0)) : 0
      const bLeft = allowedSet.has('bomb') ? Math.max(0, (R.WORLD?.daily?.bomb || 10) - Number(iq.bomb || 0)) : 0
      const cLeft = allowedSet.has('craft') ? Math.max(0, (R.WORLD?.daily?.craft || 80) - Number(iq.craft || 0)) : 0
      return Math.min(
        900,
        Math.max(
          1,
          mLeft * (R.WORLD?.cost?.mine ?? 3)
            + fLeft * (R.WORLD?.cost?.fish ?? 4)
            + bLeft * (R.WORLD?.cost?.bomb ?? 6)
            + cLeft * (R.WORLD?.cost?.craft ?? 1)
        )
      )
    }

    const computeLocalReachCapEn = (st, enMaxVal) => {
      const curE = Math.max(0, Math.floor(Number(st?.en || 0)))
      const cLeft = allowedSet.has('coffee')
        ? Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(st?.cnt?.coffee || 0))
        : 0
      return Math.min(
        900,
        Math.max(1, Math.max(curE, enMaxVal) - bucketEnFloor + cLeft * coffeeEnGain)
      )
    }

    if (allowedSet.has('eat') || allowedSet.has('coffee')) {
      const rawPoolAfterCraftReserve = (qCounts, craftReserve) => {
        const rem = [qCounts[0], qCounts[1], qCounts[2]]
        let keep = craftReserve
        for (let qIdx = 0; qIdx < 3 && keep > 0; qIdx++) {
          const tk = Math.min(rem[qIdx], keep)
          rem[qIdx] -= tk
          keep -= tk
        }
        return rem
      }

      let cachedKsLocal = null
      let cachedKsIsleFull = null
      let cachedKsCoins = -1
      let cachedKsBundles = null
      let cachedLocalCap = 0

      for (let topStep = 0; topStep < 32 && bucketActs.length + plannedTopUpActs.length < maxBucketActions - 4; topStep++) {
        const s = planWorld.state
        const curEn = Math.max(0, Math.floor(Number(s.en || 0)))
        const rawEnMax = Number(R.energyMax(s))
        const enMax = Number.isFinite(rawEnMax) && rawEnMax > 0 ? rawEnMax : 100
        const curTotalUEn = Math.max(0, curEn - bucketEnFloor)
        const curCoinsNow = Number(planWorld.coins || 0)
        const reqLocalCap = computeLocalReachCapEn(s, enMax)

        if (!cachedKsLocal || curCoinsNow !== cachedKsCoins || planBundles !== cachedKsBundles || reqLocalCap > cachedLocalCap) {
          cachedKsLocal = solveBucketStaminaKnapsack(planWorld, reqLocalCap, planBundles)
          cachedLocalCap = reqLocalCap
          if (sameIsleFutureIndices.length > 0) {
            cachedKsIsleFull = solveBucketStaminaKnapsack(planWorld, computeIsleWorkCapEn(s), planBundles, {
              fullIsleQuotas: true,
              fishEvOverride: allowedSet.has('fish') ? maxFutureSameIsleFishEv : null,
            })
          }
          cachedKsCoins = curCoinsNow
          cachedKsBundles = planBundles
        }

        const ksEatBase = cachedKsLocal
        const ksIsleFull = cachedKsIsleFull
        const maxUsefulUEn = urgentFarmEn + sameIsleRaidEn + peakFarmCraftDeficitEn + Math.max(ksEatBase.E, ksIsleFull ? ksIsleFull.E : 0)
        if (curTotalUEn >= maxUsefulUEn && !allowedSet.has('coffee')) break

        const baseRaidPool = futureRaidsU.length > 0 ? buildDeferredRaidPool(planWorld) : null
        const baseRaidSched = baseRaidPool
          ? buildFutureRaidStaminaSchedule(baseRaidPool, curCoinsNow, enMax, Math.max(curEn, enMax))
          : null
        const baseRationChunks = sameIsleFutureIndices.length > 0 ? buildSameIsleSurplusRationChunks(planWorld) : null
        const baseEval = evalWholeIsleObjective(
          ksEatBase,
          ksIsleFull,
          enMax,
          curCoinsNow,
          curTotalUEn,
          addedCoffeeEn,
          addedExpiringSnackEn,
          baseRaidSched,
          baseRationChunks
        )
        const baseVal = baseEval.bestVal

        const curBucketCraftNeedByItem = {}
        for (const cb of planBundles || []) {
          for (const stStep of cb.craftSteps || []) {
            const rec = graph.recipesById.get(stStep.id)
            for (const [inId, perU] of Object.entries(rec?.in || {})) {
              curBucketCraftNeedByItem[inId] = (curBucketCraftNeedByItem[inId] || 0) + perU * Number(stStep.n || 1)
            }
          }
        }

        let bestFoodAct = null
        let bestFoodBatchCount = 1
        let bestFoodIsExpiringSnack = false
        let bestAfterBundles = planBundles
        let bestNetImp = 0
        let bestOppCost = Infinity

        if (allowedSet.has('eat') && curEn < enMax && curTotalUEn < maxUsefulUEn) {
          const poolEntries = []
          const deferredCraftCutSpecs = []
          for (const spec of edibleSpecs) {
            const haveQty = spec.kind === 'snack'
              ? Math.min(
                  adapter.availableInv(s, spec.id, 0),
                  spec.dailyCap != null ? Math.max(0, spec.dailyCap - Number(s.cnt?.[spec.id] || 0)) : 999
                )
              : adapter.availableInv(s, spec.id, spec.q)
            if (!(haveQty > 0)) continue
            const firstGain = Math.min(enMax - curEn, spec.energyGain)
            if (!(firstGain > 0)) continue

            const candAct = spec.kind === 'snack'
              ? { a: 'eat', id: spec.id }
              : { a: 'eat', id: spec.id, q: spec.q }

            const qHold = spec.kind !== 'snack'
              ? [
                  adapter.availableInv(s, spec.id, 0),
                  adapter.availableInv(s, spec.id, 1),
                  adapter.availableInv(s, spec.id, 2),
                ]
              : [0, 0, 0]
            const totalHold = qHold[0] + qHold[1] + qHold[2]
            const futNeed = Number(futureCraftNeedByItem[spec.id] || 0)
            const totNeed = futNeed + Number(curBucketCraftNeedByItem[spec.id] || 0)
            const cutsIntoCurrentCraft = spec.kind !== 'snack'
              && recipeInputSet.has(spec.id)
              && totalHold <= totNeed
              && totalHold > futNeed

            if (cutsIntoCurrentCraft) {
              deferredCraftCutSpecs.push({ spec, candAct, stepGain: firstGain })
              continue
            }

            let unitOppCost = 0
            let surplusCount = haveQty
            if (spec.kind !== 'snack') {
              if (totalHold > totNeed) {
                surplusCount = Math.min(haveQty, totalHold - totNeed)
                const beforeRem = rawPoolAfterCraftReserve(qHold, totNeed)
                const qAfter = [qHold[0], qHold[1], qHold[2]]
                qAfter[spec.q] -= 1
                const afterRem = rawPoolAfterCraftReserve(qAfter, totNeed)
                for (let qIdx = 0; qIdx < 3; qIdx++) {
                  const diff = beforeRem[qIdx] - afterRem[qIdx]
                  if (diff > 0) unitOppCost += diff * edibleOpportunityUnitValue(s, spec.id, qIdx)
                }
              } else {
                unitOppCost = edibleOpportunityUnitValue(s, spec.id, spec.q)
              }
            }
            const isExpiringSnack = spec.kind === 'snack' && unitOppCost <= 1e-6
            poolEntries.push({
              spec,
              candAct,
              count: Math.max(1, Math.min(60, surplusCount)),
              rawGain: spec.energyGain,
              unitOppCost,
              isExpiringSnack,
              cpe: unitOppCost / Math.max(1, firstGain),
            })
          }

          if (poolEntries.length > 0) {
            poolEntries.sort((a, b2) =>
              (a.cpe - b2.cpe) ||
              (a.unitOppCost - b2.unitOppCost) ||
              (a.rawGain - b2.rawGain) ||
              ((a.spec.q ?? 0) - (b2.spec.q ?? 0))
            )
            // Exact bounded discrete DP over `g in 0..(enMax - curEn)` so smaller-grain items (e.g. `wheat` +6en)
            // are NEVER masked behind lower-`cpe` larger-grain items (e.g. `tomato` +15en)!
            const G = Math.max(0, enMax - curEn)
            const P = poolEntries.length
            const dpCost = new Float64Array(G + 1)
            dpCost.fill(Infinity)
            dpCost[0] = 0
            const dpExpSnackEn = new Int32Array(G + 1)
            const dpCounts = Array.from({ length: G + 1 }, () => null)
            dpCounts[0] = new Int16Array(P)
            const dpFirstIdx = new Int32Array(G + 1)
            dpFirstIdx.fill(-1)

            for (let pIdx = 0; pIdx < P; pIdx++) {
              const pe = poolEntries[pIdx]
              const stepG = Math.max(1, pe.rawGain)
              const maxK = Math.min(pe.count, Math.ceil(G / stepG))
              for (let k = 0; k < maxK; k++) {
                for (let g = G - 1; g >= 0; g--) {
                  if (!Number.isFinite(dpCost[g])) continue
                  const ng = Math.min(G, g + stepG)
                  const unitGainHere = ng - g
                  const nc = dpCost[g] + pe.unitOppCost
                  if (nc < dpCost[ng] - 1e-9 || (Math.abs(nc - dpCost[ng]) <= 1e-9 && dpFirstIdx[g] >= 0 && dpFirstIdx[ng] > (dpFirstIdx[g] >= 0 ? dpFirstIdx[g] : pIdx))) {
                    dpCost[ng] = nc
                    dpExpSnackEn[ng] = dpExpSnackEn[g] + (pe.isExpiringSnack ? unitGainHere : 0)
                    const nextCnt = new Int16Array(dpCounts[g])
                    nextCnt[pIdx] += 1
                    dpCounts[ng] = nextCnt
                    dpFirstIdx[ng] = dpCounts[g][pIdx] > 0 && dpFirstIdx[g] >= 0 ? dpFirstIdx[g] : (dpFirstIdx[g] >= 0 ? dpFirstIdx[g] : pIdx)
                  }
                }
              }
            }

            const maxRoom = Math.max(
              1,
              Math.min(R.WORLD?.maxActions || 40, maxBucketActions - 4 - bucketActs.length - plannedTopUpActs.length)
            )
            // Keep pareto-undominated gains: never evaluate a smaller gain `g` if a strictly larger `g'` achieves <= cost
            // UNLESS we need smaller `g` to respect cap / `maxUsefulUEn` (no, larger `g' > g` with same cost also dominates!).
            let minFutureDpCost = Infinity
            const candGains = []
            for (let g = G; g >= 1; g--) {
              if (!Number.isFinite(dpCost[g])) continue
              if (dpCost[g] < minFutureDpCost - 1e-9) {
                minFutureDpCost = dpCost[g]
                candGains.push(g)
              }
            }
            candGains.reverse()

            for (const g of candGains) {
              const cumCost = dpCost[g]
              const simEn = curEn + g
              const reachTotalUEn = Math.max(0, simEn - bucketEnFloor)
              const usedArr = dpCounts[g]
              let candRaidSched = null
              let simSnackAdded = 0
              const usedMap = sameIsleFutureIndices.length > 0 ? {} : null
              if (baseRaidPool || usedMap) {
                const simRaidPool = baseRaidPool ? baseRaidPool.map((p) => ({ ...p })) : null
                for (let pIdx = 0; pIdx < P; pIdx++) {
                  const uQty = usedArr[pIdx]
                  if (uQty <= 0) continue
                  const pe = poolEntries[pIdx]
                  const matchQ = pe.spec.kind === 'snack' ? null : pe.spec.q
                  if (pe.spec.kind === 'snack') simSnackAdded += uQty
                  if (simRaidPool) {
                    const rp = simRaidPool.find((p) => p.kind === 'eat' && p.id === pe.spec.id && p.q === matchQ)
                    if (rp) rp.rem = Math.max(0, rp.rem - uQty)
                  }
                  if (usedMap) {
                    const uk = pe.spec.kind === 'snack' ? `${pe.spec.id}:snack` : `${pe.spec.id}:${pe.spec.q}`
                    usedMap[uk] = (usedMap[uk] || 0) + uQty
                  }
                }
                if (simRaidPool) {
                  candRaidSched = buildFutureRaidStaminaSchedule(simRaidPool, curCoinsNow, enMax, Math.max(simEn, enMax), simSnackAdded, 0)
                }
              }
              const candRationChunks = sameIsleFutureIndices.length > 0
                ? buildSameIsleSurplusRationChunks(planWorld, usedMap)
                : null
              const candEval = evalWholeIsleObjective(
                ksEatBase,
                ksIsleFull,
                enMax,
                curCoinsNow,
                reachTotalUEn,
                addedCoffeeEn,
                addedExpiringSnackEn + dpExpSnackEn[g],
                candRaidSched,
                candRationChunks
              )
              if (!candEval.feasible) continue
              const deltaWork = baseEval.feasible ? (candEval.bestVal - baseVal) : (Math.max(0, candEval.bestVal) + cumCost + 1)
              const netImp = deltaWork - cumCost
              if (netImp > bestNetImp + 1e-6 || (netImp > 1e-6 && Math.abs(netImp - bestNetImp) <= 1e-6 && cumCost < bestOppCost - 1e-6)) {
                let firstIdx = dpFirstIdx[g]
                if (firstIdx < 0 || usedArr[firstIdx] <= 0) {
                  firstIdx = usedArr.findIndex((c) => c > 0)
                }
                if (firstIdx >= 0) {
                  const firstEntry = poolEntries[firstIdx]
                  bestNetImp = netImp
                  bestOppCost = cumCost
                  bestFoodAct = firstEntry.candAct
                  bestFoodIsExpiringSnack = firstEntry.isExpiringSnack
                  bestFoodBatchCount = Math.min(usedArr[firstIdx], maxRoom)
                  bestAfterBundles = planBundles
                }
              }
            }
          }

          // Evaluate craft-cannibalizing candidates ONLY if their exact weak-dominance upper bound beats `bestNetImp`
          for (const { spec, candAct, stepGain } of deferredCraftCutSpecs) {
            const oppCost = edibleOpportunityUnitValue(s, spec.id, spec.q)
            const nextSimEn = Math.min(enMax, curEn + stepGain)
            const nextTotalUEn = Math.max(0, nextSimEn - bucketEnFloor)
            const optEval = evalWholeIsleObjective(
              ksEatBase,
              ksIsleFull,
              enMax,
              curCoinsNow,
              nextTotalUEn,
              addedCoffeeEn,
              addedExpiringSnackEn,
              baseRaidPool ? buildFutureRaidStaminaSchedule(baseRaidPool, curCoinsNow, enMax, Math.max(nextSimEn, enMax)) : null,
              baseRationChunks
            )
            if (!optEval.feasible) continue
            const optimisticDelta = baseEval.feasible ? (optEval.bestVal - baseVal) : (Math.max(0, optEval.bestVal) + oppCost + 1)
            const optimisticNet = optimisticDelta - oppCost
            if (optimisticNet <= bestNetImp + 1e-6) continue

            const simFood = adapter.simulateBatch(planWorld, [candAct], { t: b.atSec, prices: dynamicPrices })
            if (!simFood.allOk) continue
            const afterW = simFood.afterWorld
            const afterBundles = computeBucketCraftBundles(afterW)
            const ksAfterLocal = solveBucketStaminaKnapsack(afterW, computeLocalReachCapEn(afterW.state, enMax), afterBundles)
            const ksAfterIsle = sameIsleFutureIndices.length > 0
              ? solveBucketStaminaKnapsack(afterW, computeIsleWorkCapEn(afterW.state), afterBundles, {
                  fullIsleQuotas: true,
                  fishEvOverride: allowedSet.has('fish') ? maxFutureSameIsleFishEv : null,
                })
              : null
            const afterEnFloorInt = Math.max(0, Math.floor(Number(afterW.state?.en || 0)))
            const afterTotalUEn = Math.max(0, afterEnFloorInt - bucketEnFloor)
            const afterRaidSched = futureRaidsU.length > 0
              ? buildFutureRaidStaminaSchedule(buildDeferredRaidPool(afterW), Number(afterW.coins || 0), enMax, Math.max(afterEnFloorInt, enMax))
              : null
            const afterRationChunks = sameIsleFutureIndices.length > 0
              ? buildSameIsleSurplusRationChunks(afterW)
              : null
            const afterEval = evalWholeIsleObjective(
              ksAfterLocal,
              ksAfterIsle,
              enMax,
              Number(afterW.coins || 0),
              afterTotalUEn,
              addedCoffeeEn,
              addedExpiringSnackEn,
              afterRaidSched,
              afterRationChunks
            )
            if (!afterEval.feasible) continue
            const deltaWorkVal = baseEval.feasible ? (afterEval.bestVal - baseVal) : (Math.max(0, afterEval.bestVal) + oppCost + 1)
            const netImprovement = deltaWorkVal - oppCost
            if (netImprovement > bestNetImp + 1e-6 || (netImprovement > 1e-6 && Math.abs(netImprovement - bestNetImp) <= 1e-6 && oppCost < bestOppCost - 1e-6)) {
              bestNetImp = netImprovement
              bestOppCost = oppCost
              bestFoodAct = candAct
              bestFoodIsExpiringSnack = false
              bestFoodBatchCount = 1
              bestAfterBundles = afterBundles
            }
          }
        }

        if (
          allowedSet.has('coffee') &&
          Number(s.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
          curCoinsNow - Number(constraints.cashReserveFloor || 0) >= coffeePrice
        ) {
          const oppCost = coffeePrice * bucketDisc
          const nextCoffeeEn = curEn + coffeeEnGain
          const nextCoffeeTotalUEn = Math.max(0, nextCoffeeEn - bucketEnFloor)
          const optCoffeeRaidSched = baseRaidPool
            ? buildFutureRaidStaminaSchedule(baseRaidPool, curCoinsNow - coffeePrice, enMax, Math.max(nextCoffeeEn, enMax), 0, 1)
            : null
          const optCoffeeEval = evalWholeIsleObjective(
            ksEatBase,
            ksIsleFull,
            enMax,
            curCoinsNow - coffeePrice,
            nextCoffeeTotalUEn,
            addedCoffeeEn + coffeeEnGain,
            addedExpiringSnackEn,
            optCoffeeRaidSched,
            baseRationChunks
          )
          const optimisticCoffeeDelta = optCoffeeEval.feasible
            ? (baseEval.feasible ? (optCoffeeEval.bestVal - baseVal) : (Math.max(0, optCoffeeEval.bestVal) + oppCost + 1))
            : -Infinity
          const optimisticCoffeeNet = optimisticCoffeeDelta - oppCost
          if (optimisticCoffeeNet > bestNetImp + 1e-6 || (optimisticCoffeeNet > 1e-6 && Math.abs(optimisticCoffeeNet - bestNetImp) <= 1e-6 && oppCost < bestOppCost - 1e-6)) {
            const candAct = { a: 'coffee' }
            const simFood = adapter.simulateBatch(planWorld, [candAct], { t: b.atSec, prices: dynamicPrices })
            if (simFood.allOk) {
              const afterW = simFood.afterWorld
              const ksAfterLocal = solveBucketStaminaKnapsack(afterW, computeLocalReachCapEn(afterW.state, enMax), planBundles)
              const ksAfterIsle = sameIsleFutureIndices.length > 0
                ? solveBucketStaminaKnapsack(afterW, computeIsleWorkCapEn(afterW.state), planBundles, {
                    fullIsleQuotas: true,
                    fishEvOverride: allowedSet.has('fish') ? maxFutureSameIsleFishEv : null,
                  })
                : null
              const afterCoffeeInt = Math.max(0, Math.floor(Number(afterW.state?.en || 0)))
              const afterCoffeeUEn = Math.max(0, afterCoffeeInt - bucketEnFloor)
              const afterCoffeeRaidSched = futureRaidsU.length > 0
                ? buildFutureRaidStaminaSchedule(buildDeferredRaidPool(afterW), Number(afterW.coins || 0), enMax, Math.max(afterCoffeeInt, enMax))
                : null
              const afterRationChunks = sameIsleFutureIndices.length > 0
                ? buildSameIsleSurplusRationChunks(afterW)
                : null
              const afterEval = evalWholeIsleObjective(
                ksAfterLocal,
                ksAfterIsle,
                enMax,
                Number(afterW.coins || 0),
                afterCoffeeUEn,
                addedCoffeeEn + coffeeEnGain,
                addedExpiringSnackEn,
                afterCoffeeRaidSched,
                afterRationChunks
              )
              if (afterEval.feasible) {
                const deltaWorkVal = baseEval.feasible ? (afterEval.bestVal - baseVal) : (Math.max(0, afterEval.bestVal) + oppCost + 1)
                const netImprovement = deltaWorkVal - oppCost
                if (netImprovement > bestNetImp + 1e-6 || (netImprovement > 1e-6 && Math.abs(netImprovement - bestNetImp) <= 1e-6 && oppCost < bestOppCost - 1e-6)) {
                  bestNetImp = netImprovement
                  bestOppCost = oppCost
                  bestFoodAct = candAct
                  bestFoodIsExpiringSnack = false
                  bestFoodBatchCount = 1
                  bestAfterBundles = planBundles
                }
              }
            }
          }
        }

        if (!bestFoodAct) break
        if (bestFoodAct.a === 'coffee') {
          const simC = adapter.simulateBatch(planWorld, [bestFoodAct], { t: b.atSec, prices: dynamicPrices })
          if (!simC.allOk) break
          planWorld = simC.afterWorld
          addedCoffeeEn += coffeeEnGain
          plannedTopUpActs.push(bestFoodAct)
          planBundles = bestAfterBundles
        } else {
          const prevEn = Math.max(0, Math.floor(Number(planWorld.state?.en || 0)))
          const subBatch = Array.from({ length: Math.min(bestFoodBatchCount, R.WORLD?.maxActions || 40) }, () => bestFoodAct)
          const simSub = simulateValidBatch(adapter, planWorld, subBatch, { t: b.atSec, prices: dynamicPrices })
          if (simSub.validActions.length === 0) break
          planWorld = simSub.afterWorld
          const newEn = Math.max(0, Math.floor(Number(planWorld.state?.en || 0)))
          if (bestFoodIsExpiringSnack && newEn > prevEn) {
            addedExpiringSnackEn += newEn - prevEn
          }
          for (const va of simSub.validActions) plannedTopUpActs.push(va)
          planBundles = bestAfterBundles
        }
      }
    }

    // Determine exact funded urgent farm budget `fundedUrgentEn`, committed raid post-bucket floor,
    // and upcoming maturity reserve `effectiveShiftableFloor`
    const rawCapFinalU = Number(R.energyMax(planWorld.state))
    const enMaxFinalU = Number.isFinite(rawCapFinalU) && rawCapFinalU > 0 ? rawCapFinalU : 100
    const ksFinalPlanLocal = solveBucketStaminaKnapsack(planWorld, computeLocalReachCapEn(planWorld.state, enMaxFinalU), planBundles)
    const ksFinalPlanIsle = sameIsleFutureIndices.length > 0
      ? solveBucketStaminaKnapsack(planWorld, computeIsleWorkCapEn(planWorld.state), planBundles, {
          fullIsleQuotas: true,
          fishEvOverride: allowedSet.has('fish') ? maxFutureSameIsleFishEv : null,
        })
      : null
    const planCurEnFinal = Math.max(0, Math.floor(Number(planWorld.state?.en || 0)))
    const finalPlanTotalUEn = Math.max(0, planCurEnFinal - bucketEnFloor)
    const finalRaidSched = futureRaidsU.length > 0
      ? buildFutureRaidStaminaSchedule(
          buildDeferredRaidPool(planWorld),
          Number(planWorld.coins || 0),
          enMaxFinalU,
          Math.max(enMaxFinalU, planCurEnFinal)
        )
      : null
    const finalAlloc = evalWholeIsleObjective(
      ksFinalPlanLocal,
      ksFinalPlanIsle,
      enMaxFinalU,
      Number(planWorld.coins || 0),
      finalPlanTotalUEn,
      addedCoffeeEn,
      addedExpiringSnackEn,
      finalRaidSched,
      sameIsleFutureIndices.length > 0 ? buildSameIsleSurplusRationChunks(planWorld) : null,
      true
    )
    if (futureRaidsU.length > 0 && !finalAlloc.feasible) {
      return makeInfeasibleRaidReturn()
    }
    const fundedUrgentEn = finalAlloc.bestEF
    let committedRaidPostEnFloor = futureRaidsU.length > 0
      ? Math.max(bucketEnFloor, finalAlloc.bestPostEnFloor)
      : bucketEnFloor
    let activeRaidSchedEntry = finalAlloc.bestRaidEntry || (
      futureRaidsU.length > 0
        ? (finalRaidSched?.schedByPostEn?.[Math.min(finalRaidSched.maxPostE, committedRaidPostEnFloor)] || null)
        : null
    )
    if (futureRaidsU.length > 0 && finalRaidSched) {
      const upperPostE = Math.min(finalRaidSched.maxPostE, committedRaidPostEnFloor)
      const defUrgFinal = deferredSameIsleFarmEnByEF[fundedUrgentEn] || 0
      const hasSplitFinal = sameIsleFutureIndices.length > 0 && nextIsleRaidsU.length > 0 && Boolean(finalRaidSched.evalNextIsleRaids)
      const bucketFloorReleaseFinal = isleBoundaryU >= Number(constraints.staminaReserveUntilSec || 0)
        ? bucketEnFloor
        : 0
      for (let rE = bucketEnFloor; rE < upperPostE; rE++) {
        if (sameIsleFutureIndices.length === 0) {
          const rEntry = finalRaidSched.schedByPostEn[rE]
          if (!rEntry || !rEntry.feasible) continue
          if (rEntry.deferredPrepCost > finalAlloc.bestRaidPrepCost + 1e-6) continue
          const postRaidPoolR = Math.max(0, rEntry.terminalRaidEn - bucketEnFloor)
          const lumpySpillCapR = Math.min(enMaxFinalU, addedCoffeeEn + addedExpiringSnackEn + rEntry.deferredCoffeeEn)
          if (Math.min(lumpySpillCapR, postRaidPoolR) >= finalAlloc.bestCarryNext - 1e-6) {
            committedRaidPostEnFloor = rE
            activeRaidSchedEntry = rEntry
            break
          }
        } else if (hasSplitFinal) {
          const sRsR = finalRaidSched.sameIsleOnlyByPostEn?.[rE]
          if (!sRsR || !sRsR.feasible) continue
          const preSimR = finalAlloc.simulateSameIsleSurplus(
            rE - bucketEnFloor,
            sRsR.eatReserve,
            defUrgFinal,
            sRsR.addedPerRaid,
            sRsR.postMidSameIsleCoffeeUsed
          )
          const maxHoldR = preSimR.totalSurplusPool + bucketFloorReleaseFinal
          const kneesR = finalRaidSched.prepKneeEntriesFor ? finalRaidSched.prepKneeEntriesFor(rE) : []
          if (kneesR.length === 0 || kneesR[0] > maxHoldR) continue
          const holdCandsR = []
          const lumpySpillFinal = addedCoffeeEn + addedExpiringSnackEn
          for (const kH of kneesR) {
            if (kH <= maxHoldR) {
              if (!holdCandsR.includes(kH)) holdCandsR.push(kH)
              if (lumpySpillFinal > 0) {
                const spillHoldR = Math.min(maxHoldR, enMaxFinalU, kH + lumpySpillFinal)
                if (spillHoldR >= kneesR[0] && !holdCandsR.includes(spillHoldR)) holdCandsR.push(spillHoldR)
              }
            }
          }
          const capHoldR = Math.min(maxHoldR, enMaxFinalU)
          if (capHoldR >= kneesR[0] && !holdCandsR.includes(capHoldR)) holdCandsR.push(capHoldR)
          if (maxHoldR >= kneesR[0] && !holdCandsR.includes(maxHoldR)) holdCandsR.push(maxHoldR)
          let matchedEntryR = null
          for (const hR of holdCandsR) {
            const nRsR = finalRaidSched.evalNextIsleRaids(rE, hR)
            if (!nRsR || !nRsR.feasible) continue
            const mergedR = finalAlloc.mergeRaidEntries(sRsR, nRsR)
            if (mergedR.deferredPrepCost > finalAlloc.bestRaidPrepCost + 1e-6) continue
            const effSimR = nRsR.eatReserve
              ? finalAlloc.simulateSameIsleSurplus(
                  rE - bucketEnFloor,
                  mergedR.deferredEatReserve,
                  defUrgFinal,
                  sRsR.addedPerRaid,
                  sRsR.postMidSameIsleCoffeeUsed
                )
              : preSimR
            const effMaxHoldR = effSimR.totalSurplusPool + bucketFloorReleaseFinal
            if (hR > effMaxHoldR) continue
            const lumpyCapR = Math.min(enMaxFinalU, lumpySpillFinal + mergedR.deferredCoffeeEn)
            const carryNextR = Math.min(lumpyCapR, Math.max(0, nRsR.terminalRaidEn - bucketEnFloor))
            if (carryNextR >= finalAlloc.bestCarryNext - 1e-6) {
              matchedEntryR = mergedR
              break
            }
          }
          if (matchedEntryR) {
            committedRaidPostEnFloor = rE
            activeRaidSchedEntry = matchedEntryR
            break
          }
        } else {
          const rEntry = finalRaidSched.schedByPostEn[rE]
          if (!rEntry || !rEntry.feasible) continue
          if (rEntry.deferredPrepCost > finalAlloc.bestRaidPrepCost + 1e-6) continue
          const postRaidPoolR = Math.max(0, rEntry.terminalRaidEn - bucketEnFloor)
          const lumpySpillCapR = Math.min(enMaxFinalU, addedCoffeeEn + addedExpiringSnackEn + rEntry.deferredCoffeeEn)
          if (Math.min(lumpySpillCapR, postRaidPoolR) >= finalAlloc.bestCarryNext - 1e-6) {
            committedRaidPostEnFloor = rE
            activeRaidSchedEntry = rEntry
            break
          }
        }
      }
    }
    const minUrgentRaidFloor = futureRaidsU.length > 0
      ? Math.max(bucketEnFloor, finalRaidSched.minFeasiblePostEn)
      : bucketEnFloor
    bucketPlannedPostEnFloor[u] = committedRaidPostEnFloor

    let farmReserveFloor = 0
    if (sameIsleFutureIndices.length > 0) {
      let remUntouchedTopUpEn = 0
      const sRemP = planWorld.state
      if (allowedSet.has('eat')) {
        for (const sp of edibleSpecs) {
          const qty = sp.kind === 'snack'
            ? Math.min(adapter.availableInv(sRemP, sp.id, 0), sp.dailyCap != null ? Math.max(0, sp.dailyCap - Number(sRemP.cnt?.[sp.id] || 0)) : 999)
            : Math.max(0, adapter.availableInv(sRemP, sp.id, sp.q) - Number(futureCraftNeedByItem[sp.id] || 0))
          if (qty > 0 && sp.energyGain > 0) remUntouchedTopUpEn += qty * sp.energyGain
        }
      }
      if (allowedSet.has('coffee')) {
        const cLeft = Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(sRemP.cnt?.coffee || 0))
        const freeC = Math.max(0, Number(planWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
        remUntouchedTopUpEn += Math.min(cLeft, Math.floor(freeC / coffeePrice)) * coffeeEnGain
      }
      let cumFutFarm = 0
      for (const fu of sameIsleFutureIndices) {
        cumFutFarm += estUrgentFarmEnByU[fu] || 0
        if (!(cumFutFarm > 0)) continue
        const regenToFu = Math.max(0, Math.floor((seqBuckets[fu].atSec - baseEnTU) / regenStepU))
        const noOverflowCap = Math.max(0, enMaxFinalU - Math.min(enMaxFinalU, regenToFu))
        const needHold = Math.max(0, cumFutFarm - regenToFu - remUntouchedTopUpEn)
        farmReserveFloor = Math.max(farmReserveFloor, Math.min(noOverflowCap, needHold))
      }
    }
    const effectiveShiftableFloor = Math.max(
      sameIsleFutureIndices.length > 0 ? Math.max(bucketEnFloor, farmReserveFloor) : bucketEnFloor,
      committedRaidPostEnFloor
    )

    // 3. Interleaved Execution: Urgent Farm Care -> Post-Harvest Craft & Shiftable Work -> Non-Expiring Water -> Goals & Sells
    {
      let topUpCursor = 0
      const edibleGainByKey = new Map()
      for (const sp of edibleSpecs) {
        edibleGainByKey.set(sp.kind === 'snack' ? `${sp.id}:snack` : `${sp.id}:${sp.q ?? 0}`, sp.energyGain)
      }
      const getPendingEatReserve = () => {
        const res = {}
        for (let idx = topUpCursor; idx < plannedTopUpActs.length; idx++) {
          const ta = plannedTopUpActs[idx]
          if (ta.a === 'eat' && ta.q != null) {
            res[ta.id] ||= [0, 0, 0]
            res[ta.id][ta.q] += 1
          }
        }
        if (activeRaidSchedEntry?.deferredEatReserve) {
          for (const [rId, rArr] of Object.entries(activeRaidSchedEntry.deferredEatReserve)) {
            res[rId] ||= [0, 0, 0]
            res[rId][0] += Number(rArr[0] || 0)
            res[rId][1] += Number(rArr[1] || 0)
            res[rId][2] += Number(rArr[2] || 0)
          }
        }
        return res
      }
      const getPendingCoffeeCash = () => {
        let c = Number(activeRaidSchedEntry?.deferredCashReserve || 0)
        for (let idx = topUpCursor; idx < plannedTopUpActs.length; idx++) {
          if (plannedTopUpActs[idx].a === 'coffee') c += coffeePrice
        }
        return c
      }
      const getPendingTopUpEn = (maxEatStepCap) => {
        let enSum = 0
        for (let idx = topUpCursor; idx < plannedTopUpActs.length; idx++) {
          const ta = plannedTopUpActs[idx]
          if (ta.a === 'coffee') {
            enSum += coffeeEnGain
          } else {
            const g = ta.q != null
              ? (edibleGainByKey.get(`${ta.id}:${ta.q}`) || 0)
              : (edibleGainByKey.get(`${ta.id}:snack`) || edibleGainByKey.get(`${ta.id}:0`) || 0)
            enSum += Math.min(maxEatStepCap, g)
          }
        }
        return enSum
      }
      const ensureExecStamina = (neededSpendableEn, activeFloor = bucketEnFloor) => {
        while (topUpCursor < plannedTopUpActs.length) {
          let curExecEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)))
          if (curExecEn - activeFloor >= neededSpendableEn) return
          const rawCapExec = Number(R.energyMax(execWorld.state))
          const capExec = Number.isFinite(rawCapExec) && rawCapExec > 0 ? rawCapExec : 100
          const startIdx = topUpCursor
          while (topUpCursor < plannedTopUpActs.length && curExecEn - activeFloor < neededSpendableEn) {
            const ta = plannedTopUpActs[topUpCursor]
            if (ta.a === 'coffee') {
              curExecEn += coffeeEnGain
            } else {
              const g = ta.q != null
                ? (edibleGainByKey.get(`${ta.id}:${ta.q}`) || 0)
                : (edibleGainByKey.get(`${ta.id}:snack`) || edibleGainByKey.get(`${ta.id}:0`) || 0)
              if (curExecEn >= capExec || g <= 0) break
              curExecEn = Math.min(capExec, curExecEn + g)
            }
            topUpCursor++
          }
          if (topUpCursor <= startIdx) break
          pushAndSim(plannedTopUpActs.slice(startIdx, topUpCursor))
        }
      }

      // 3.1) Execute Urgent Farm & Barn Care (`harvest` -> `clear` -> `plant` -> hungry `feed` -> expiring `water`)
      let urgentSpentSoFar = 0
      for (const hcTask of [...harvestTasks, ...clearTasks]) {
        if (bucketActs.length >= maxBucketActions) break
        if (hcTask.kind === 'clear') {
          const curPlot = execWorld.state?.plots?.[hcTask.i]
          if (!curPlot || !adapter.isPlotWithered(curPlot, b.atSec, startWorld.clockStart)) continue
        }
        const cEn = hcTask.costEn
        if (futureRaidsU.length > 0 && urgentSpentSoFar + cEn > fundedUrgentEn) break
        if (urgentSpentSoFar + cEn <= fundedUrgentEn) {
          ensureExecStamina(cEn, minUrgentRaidFloor)
        }
        if (Math.floor(Number(execWorld.state?.en || 0)) - minUrgentRaidFloor < cEn) break
        pushAndSim([{ a: hcTask.kind, i: hcTask.i }])
        urgentSpentSoFar += cEn
      }

      let unplantedProfitablePlots = 0
      if (allowedSet.has('plant') && (u > 0 || enableFirstBucketPlant) && (execWorld.state?.plotN || 0) > 0) {
        const pCostEn = R.WORLD?.cost?.plant ?? 2
        const emptyIndices = []
        for (let i = 0; i < (execWorld.state.plotN || 0); i++) {
          if (!execWorld.state.plots?.[i]) emptyIndices.push(i)
        }
        for (const i of emptyIndices) {
          if (bucketActs.length >= maxBucketActions) break
          const ps = execWorld.state
          if (ps.plots?.[i]) continue
          const bestP = selectBestCropToPlant(adapter, {
            state: ps,
            clockStart: startWorld.clockStart,
            plotIdx: i,
            atSec: b.atSec,
            tEnd: tH,
            marginalItemValueFn,
            staminaPointCost: baseStaminaShadowCost,
            enforceHorizonCutoff: objectiveCfg.terminalSupplyMode === 'zero',
          })
          if (!bestP) continue
          const hasFreeSeed = adapter.availableInv(ps, `sd_${bestP.crop.id}`, 0) > 0
          const costCash = hasFreeSeed ? 0 : Number(bestP.crop.seed || 0)
          const availPlantCash = Math.max(
            0,
            Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) - getPendingCoffeeCash()
          )
          if (costCash > availPlantCash) continue
          if (futureRaidsU.length > 0 && urgentSpentSoFar + pCostEn > fundedUrgentEn) {
            unplantedProfitablePlots++
            continue
          }
          if (urgentSpentSoFar + pCostEn <= fundedUrgentEn) {
            ensureExecStamina(pCostEn, minUrgentRaidFloor)
          }
          if (Math.floor(Number(execWorld.state?.en || 0)) - minUrgentRaidFloor < pCostEn) {
            unplantedProfitablePlots++
            continue
          }
          marginalItemValueFn(bestP.crop.id, 0, b.atSec, {
            reserveUnits: Math.max(1, Math.round(bestP.totalExpectedUnits || 2)),
          })
          pushAndSim([{ a: 'plant', i, c: bestP.crop.id }])
          urgentSpentSoFar += pCostEn
        }
      }

      if (allowedSet.has('feed') && utilityTokens.feedId) {
        const hungryNow = []
        for (let i = 0; i < (execWorld.state?.barn?.length || 0); i++) {
          const pen = execWorld.state.barn[i]
          if (!pen || R.b12AnimalStage(pen, b.atSec).retired) continue
          const hungryAt = pen.f + 86400
          if (b.atSec - pen.f >= 8 * 3600 && (hungryAt <= bucketEndSec || b.atSec >= hungryAt)) {
            hungryNow.push(i)
          }
        }
        if (hungryNow.length > 0) {
          const haveFeed = adapter.availableInv(execWorld.state, utilityTokens.feedId, 0)
          const needBuy = Math.max(0, hungryNow.length - haveFeed)
          const feedPrice = Number(R.SHOP?.[utilityTokens.feedId]?.price || 150)
          const availFeedCash = Math.max(
            0,
            Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) - getPendingCoffeeCash()
          )
          if (needBuy > 0 && allowedSet.has('buy') && availFeedCash >= needBuy * feedPrice) {
            pushAndSim([{ a: 'buy', id: utilityTokens.feedId, n: Math.min(99, Math.floor(availFeedCash / feedPrice), needBuy) }])
          }
          const fCostEn = R.WORLD?.cost?.feed ?? 1
          for (const idx of hungryNow) {
            if (adapter.availableInv(execWorld.state, utilityTokens.feedId, 0) <= 0) break
            if (futureRaidsU.length > 0 && urgentSpentSoFar + fCostEn > fundedUrgentEn) break
            if (urgentSpentSoFar + fCostEn <= fundedUrgentEn) {
              ensureExecStamina(fCostEn, minUrgentRaidFloor)
            }
            if (Math.floor(Number(execWorld.state?.en || 0)) - minUrgentRaidFloor < fCostEn) break
            pushAndSim([{ a: 'feed', i: idx }])
            urgentSpentSoFar += fCostEn
          }
        }
      }

      for (const ewTask of expiringWaterTasks) {
        if (bucketActs.length >= maxBucketActions) break
        const pNow = execWorld.state?.plots?.[ewTask.i]
        if (!pNow) continue
        const autoNow = R.sprinkled(execWorld.state, ewTask.i) || weatherU === 1
        const stNow = R.cropStage(pNow, b.atSec, autoNow)
        if (!(stNow.stage >= 0 && stNow.stage < 3 && !autoNow && pNow.w <= stNow.stage)) continue
        const wCostEn = ewTask.costEn
        if (futureRaidsU.length > 0 && urgentSpentSoFar + wCostEn > fundedUrgentEn) break
        if (urgentSpentSoFar + wCostEn <= fundedUrgentEn) {
          ensureExecStamina(wCostEn, minUrgentRaidFloor)
        }
        if (Math.floor(Number(execWorld.state?.en || 0)) - minUrgentRaidFloor < wCostEn) break
        pushAndSim([{ a: 'water', i: ewTask.i }])
        urgentSpentSoFar += wCostEn
      }

      // 3.2) Recompute post-harvest craft bundles & shiftable Stamina × Cash Knapsack (protecting pending `eat` & `coffee`)
      const rawCapPost = Number(R.energyMax(execWorld.state))
      const capExecPost = Number.isFinite(rawCapPost) && rawCapPost > 0 ? rawCapPost : 100
      const pendingTopUpEnRem = getPendingTopUpEn(Math.max(0, capExecPost - effectiveShiftableFloor))
      const shiftableSpendableEn = Math.max(
        0,
        Math.floor(Number(execWorld.state?.en || 0)) + pendingTopUpEnRem - effectiveShiftableFloor
      )

      if (shiftableSpendableEn > 0) {
        const postUrgentPlanW = adapter.cloneWorld(execWorld)
        const pendingEatRes = getPendingEatReserve()
        for (const [eId, qArr] of Object.entries(pendingEatRes)) {
          const invRow = postUrgentPlanW.state?.inv?.[eId]
          if (!invRow) continue
          for (let q = 0; q < 3; q++) {
            invRow[q] = Math.max(0, Number(invRow[q] || 0) - Number(qArr[q] || 0))
          }
        }
        postUrgentPlanW.coins = Math.max(0, Number(postUrgentPlanW.coins || 0) - getPendingCoffeeCash())

        const postHarvestBundles = computeBucketCraftBundles(postUrgentPlanW)
        const ksFinal = solveBucketStaminaKnapsack(postUrgentPlanW, shiftableSpendableEn, postHarvestBundles)
        const chosenItems = ksFinal.reconstructAt(shiftableSpendableEn)
        if (chosenItems.length > 0) {
          const rawCraftList = []
          let nBombInv = 0
          let nBombBuy = 0
          let nFishInvBait = 0
          let nFishBuyBait = 0
          let nFishNoBait = 0
          let nMine = 0

          for (const it of chosenItems) {
            if (it.kind === 'craft-bundle') {
              for (const stStep of it.craftSteps) {
                rawCraftList.push({ a: 'craft', id: stStep.id, n: stStep.n })
              }
            } else if (it.kind === 'bomb-inv') nBombInv++
            else if (it.kind === 'bomb-buy') nBombBuy++
            else if (it.kind === 'fish-inv-bait') nFishInvBait++
            else if (it.kind === 'fish-buy-bait') nFishBuyBait++
            else if (it.kind === 'fish-no-bait') nFishNoBait++
            else if (it.kind === 'mine') nMine++
          }

          // 3.3a) Deterministic crafts first (pulling top-up stamina just-in-time per craft chunk!)
          if (rawCraftList.length > 0) {
            const craftEnUnit = R.WORLD?.cost?.craft ?? 1
            const mergedCrafts = mergeCraftActionsPreserveTopo(rawCraftList)
            let cIdx = 0
            while (cIdx < mergedCrafts.length) {
              const firstNeed = Math.max(1, Number(mergedCrafts[cIdx].n || 1)) * craftEnUnit
              ensureExecStamina(firstNeed, effectiveShiftableFloor)
              const availEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - effectiveShiftableFloor)
              if (availEn < firstNeed) break
              const craftChunk = []
              let usedEn = 0
              while (cIdx < mergedCrafts.length) {
                const stepEn = Math.max(1, Number(mergedCrafts[cIdx].n || 1)) * craftEnUnit
                if (craftChunk.length > 0 && usedEn + stepEn > availEn) break
                craftChunk.push(mergedCrafts[cIdx])
                usedEn += stepEn
                cIdx++
              }
              pushAndSim(craftChunk)
            }
          }

          // 3.3b) Shop purchases for bombs/bait (preserving cash reserved for any pending just-in-time `coffee`!)
          let freeCashNow = Math.max(
            0,
            Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) - getPendingCoffeeCash()
          )
          if (nBombBuy > 0 && utilityTokens.explosiveId) {
            const pBomb = Number(R.SHOP?.[utilityTokens.explosiveId]?.price || 0)
            const affordB = pBomb > 0 ? Math.min(nBombBuy, Math.floor(freeCashNow / pBomb)) : 0
            if (affordB > 0) {
              pushAndSim([{ a: 'buy', id: utilityTokens.explosiveId, n: affordB }])
              freeCashNow = Math.max(
                0,
                Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) - getPendingCoffeeCash()
              )
              nBombBuy = affordB
            } else {
              nBombBuy = 0
            }
          }
          if (nFishBuyBait > 0 && utilityTokens.baitId) {
            const pBait = Number(R.SHOP?.[utilityTokens.baitId]?.price || 0)
            const affordBait = pBait > 0 ? Math.min(nFishBuyBait, Math.floor(freeCashNow / pBait)) : 0
            if (affordBait > 0) {
              pushAndSim([{ a: 'buy', id: utilityTokens.baitId, n: affordBait }])
              nFishBuyBait = affordBait
            } else {
              nFishBuyBait = 0
            }
          }

          // Sell deterministic finished goods before stochastic extraction while protecting pending `eat` reserves!
          if (
            (nBombInv + nBombBuy + nFishInvBait + nFishBuyBait + nFishNoBait + nMine > 0) &&
            allowedSet.has('sell') &&
            !(forcedTrunkSellPolicy === 'hold-in-first-bucket' && u === 0 && L > 1)
          ) {
            emitOptimalBucketSells(u, b, dynamicPrices, pushAndSim, getPendingEatReserve())
          }

          // 3.3c) Stochastic extraction actions ordered by highest marginal gain per stamina
          const stochGroups = []
          const totalBombs = nBombInv + nBombBuy
          if (totalBombs > 0) {
            const sampleBomb = chosenItems.find((x) => x.kind === 'bomb-inv' || x.kind === 'bomb-buy')
            stochGroups.push({
              perEn: (sampleBomb?.gain || 0) / Math.max(1, sampleBomb?.costEn || 6),
              acts: Array.from({ length: totalBombs }, () => ({ a: 'bomb', f: 99 })),
            })
          }
          const totalBaitedFish = nFishInvBait + nFishBuyBait
          const totalUnbaitedFish = nFishNoBait
          if (totalBaitedFish + totalUnbaitedFish > 0) {
            const sampleFish = chosenItems.find((x) => x.kind.startsWith('fish-'))
            stochGroups.push({
              perEn: (sampleFish?.gain || 0) / Math.max(1, sampleFish?.costEn || 4),
              acts: [
                ...Array.from({ length: totalBaitedFish }, () => ({ a: 'fish', bait: true })),
                ...Array.from({ length: totalUnbaitedFish }, () => ({ a: 'fish', bait: false })),
              ],
            })
          }
          if (nMine > 0) {
            const sampleMine = chosenItems.find((x) => x.kind === 'mine')
            stochGroups.push({
              perEn: (sampleMine?.gain || 0) / Math.max(1, sampleMine?.costEn || 3),
              acts: Array.from({ length: nMine }, () => ({ a: 'mine', f: 99 })),
            })
          }
          stochGroups.sort((a, b2) => b2.perEn - a.perEn)

          let seenFirstStochInBucket = false
          for (const grp of stochGroups) {
            if (!grp.acts || grp.acts.length === 0) continue
            const sampleAct = grp.acts[0]
            const unitCost = Math.max(
              1,
              sampleAct.a === 'bomb'
                ? (R.WORLD?.cost?.bomb ?? 6)
                : (sampleAct.a === 'fish' ? (R.WORLD?.cost?.fish ?? 4) : (R.WORLD?.cost?.mine ?? 3))
            )
            let cursorAct = 0
            while (cursorAct < grp.acts.length && bucketActs.length < maxBucketActions) {
              let remEnForStoch = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - effectiveShiftableFloor)
              if (remEnForStoch < unitCost) {
                const rawCapExec = Number(R.energyMax(execWorld.state))
                const capExec = Number.isFinite(rawCapExec) && rawCapExec > 0 ? rawCapExec : 100
                const wantEn = (u === 0 && !seenFirstStochInBucket)
                  ? unitCost
                  : Math.min(
                      Math.max(unitCost, Math.max(0, capExec - effectiveShiftableFloor)),
                      (grp.acts.length - cursorAct) * unitCost
                    )
                ensureExecStamina(wantEn, effectiveShiftableFloor)
                remEnForStoch = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - effectiveShiftableFloor)
              }
              if (remEnForStoch < unitCost) break
              const maxAffordEn = Math.min(grp.acts.length - cursorAct, Math.floor(remEnForStoch / unitCost))
              if (maxAffordEn <= 0) break
              pushAndSim(grp.acts.slice(cursorAct, cursorAct + maxAffordEn))
              cursorAct += maxAffordEn
              seenFirstStochInBucket = true
            }
          }
        }
      }

      // 3.4) Non-expiring manual `water`: executes ONLY when 0 profitable empty plots remain unplanted
      //      and spare stamina above `effectiveShiftableFloor` is available (never starving `plant`!)
      if (unplantedProfitablePlots === 0 && allowedSet.has('water')) {
        const wUnit = R.WORLD?.cost?.water ?? 1
        let spareWaterEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - effectiveShiftableFloor)
        if (spareWaterEn >= wUnit) {
          const nonExpWaters = []
          for (let i = 0; i < (execWorld.state?.plotN || 0) && nonExpWaters.length * wUnit < spareWaterEn; i++) {
            const p = execWorld.state.plots?.[i]
            if (!p) continue
            const auto = R.sprinkled(execWorld.state, i) || weatherU === 1
            const st = R.cropStage(p, b.atSec, auto)
            if (st.stage >= 0 && st.stage < 3 && !auto && p.w <= st.stage) {
              nonExpWaters.push({ a: 'water', i })
            }
          }
          if (nonExpWaters.length > 0) {
            pushAndSim(nonExpWaters)
          }
        }
      }

      // 3.5) Claim any newly completed daily goals (`0` stamina), including `k = 4`, before optimal multi-bucket `sell`
      if (allowedSet.has('goal') && typeof R.dailyGoals === 'function') {
        const goalActsNow = collectClaimableGoalActions(R, b.naturalDay, execWorld.state)
        if (goalActsNow.length > 0) pushAndSim(goalActsNow)
      }

      cachedCraftBundles = computeBucketCraftBundles(execWorld)
    }

    // 4. Execute optimal multi-bucket `sell` actions for any remaining/newly extracted inventory in this bucket
    //    while protecting any deferred rations reserved for committed future raids!
    if (allowedSet.has('sell') && !(forcedTrunkSellPolicy === 'hold-in-first-bucket' && u === 0 && L > 1)) {
      emitOptimalBucketSells(u, b, dynamicPrices, pushAndSim, activeRaidSchedEntry?.deferredEatReserve || null)
    }

    // 4.5) Re-check daily goals immediately after `sell` so newly satisfied `sold` targets (80k / 300k) + `goal4` claim in-batch
    if (allowedSet.has('goal') && typeof R.dailyGoals === 'function') {
      const postSellGoals = collectClaimableGoalActions(R, b.naturalDay, execWorld.state)
      if (postSellGoals.length > 0) pushAndSim(postSellGoals)
    }

    if (futureRaidsU.length > 0 && bucketPlannedPostEnFloor[u] != null) {
      bucketPlannedPostEnFloor[u] = Math.max(
        bucketEnFloor,
        Math.min(bucketPlannedPostEnFloor[u], Math.floor(Number(execWorld.state?.en || 0)))
      )
    }

    finalBucketActions[u] = bucketActs
  }

  function emitOptimalBucketSells(u, b, dynamicPrices, pushAndSimFn, pendingEatReserve = null) {
    const curAvail = adapter.availableInvSnapshot(execWorld.state)
    if (pendingEatReserve) {
      for (const [eId, qArr] of Object.entries(pendingEatReserve)) {
        if (!curAvail[eId]) continue
        for (let q = 0; q < 3; q++) {
          curAvail[eId][q] = Math.max(0, (curAvail[eId][q] || 0) - (qArr[q] || 0))
        }
      }
    }
    const remSlots = slots
      .filter((sl) => sl.availFromBucket >= u)
      .map((sl) => ({
        ...sl,
        availFromBucket: Math.max(0, sl.availFromBucket - u),
        prices: sl.slotIdx === u ? dynamicPrices : sl.prices,
      }))

    const sellActs = []
    for (const id of Object.keys(curAvail).sort()) {
      if (!(Number(R.BASE_PRICE?.[id] || 0) > 0) || !(Number(dynamicPrices?.[id] || 0) > 0)) continue
      if (forcedTrunkSellPolicy === 'sell-all-now' && u === 0) {
        for (const q of [2, 1, 0]) {
          let rem = curAvail[id][q] || 0
          while (rem > 0) {
            const n = Math.min(999, rem)
            sellActs.push({ a: 'sell', id, q, n })
            rem -= n
          }
        }
        continue
      }
      // Build full remaining supply across `u..L-1` (current stock at `u` + future arrivals in `u+1..L-1`),
      // deducting planned future & continuation crafts (`u+1..jointCS.craftsByBucket.length-1`)
      // from the arriving bucket backwards down to `0` (`curAvail`)!
      const remSupply = [
        [...(curAvail[id] || [0, 0, 0])],
        ...seqBuckets.slice(u + 1).map((_, idx) => [...(supplyByBucket[u + 1 + idx]?.[id] || [0, 0, 0])]),
      ]
      for (let fu = u + 1; fu < jointCS.craftsByBucket.length; fu++) {
        const relFu = Math.min(remSupply.length - 1, fu - u)
        let needAtFu = 0
        for (const ca of jointCS.craftsByBucket[fu] || []) {
          if (fu < L && ca.id === id) {
            remSupply[relFu][0] += Number(ca.n || 1)
          }
          const rec = graph.recipesById.get(ca.id)
          if (rec?.in?.[id]) needAtFu += rec.in[id] * Number(ca.n || 1)
        }
        for (let q = 0; q < 3 && needAtFu > 0; q++) {
          for (let k = relFu; k >= 0 && needAtFu > 0; k--) {
            const tk = Math.min(remSupply[k][q] || 0, needAtFu)
            remSupply[k][q] -= tk
            needAtFu -= tk
          }
        }
      }
      const row = remSupply[0]
      if ((row[0] || 0) + (row[1] || 0) + (row[2] || 0) <= 0) continue

      const sched = solveExactItemSaleSchedule(adapter, {
        itemId: id,
        supplyByBucket: remSupply,
        slots: remSlots,
        initialNatDay: b.naturalDay,
        initialScCount: Number(execWorld.state?.cnt?.['sc_' + id] || 0),
      })
      const nowRow = sched.sellsBySlot[0] || [0, 0, 0]
      for (const q of [2, 1, 0]) {
        let rem = Math.floor(nowRow[q] || 0)
        while (rem > 0) {
          const n = Math.min(999, rem)
          sellActs.push({ a: 'sell', id, q, n })
          rem -= n
        }
      }
    }
    if (sellActs.length > 0) {
      pushAndSimFn(sellActs)
    }
  }

  // Advance to horizon endpoint `tH` for terminal valuation
  const actualTermPrevSold = execSoldByIsle.get(R.isleIndex(tH) - 1) || null
  const actualTermPrices = objectiveCfg.terminalSupplyMode === 'zero'
    ? {}
    : buildTerminalPrices(adapter, { ...execWorld, now: tH }, initialWorldForObjective, objectiveCfg, scenarioSupplyFactor, actualTermPrevSold)
  const finalWorldAtHorizon = adapter.advanceTimeOnly(execWorld, tH, { futurePrices: actualTermPrices })
  const objEval = skipObjectiveEval
    ? { totalObjectiveValue: 0 }
    : evaluateTrajectoryObjective(adapter, {
        initialWorld: initialWorldForObjective,
        finalWorld: finalWorldAtHorizon,
        cashEvents,
        objectiveCfg,
        scenarioSupplyFactor,
        explicitTerminalPrices: hasExplicitPriceOverride ? actualTermPrices : null,
        prevIsleSoldMap: actualTermPrevSold,
        allowTerminalCraft: allowedSet.has('craft'),
        allowTerminalHarvest: allowedSet.has('harvest'),
        allowTerminalPlant: allowedSet.has('plant'),
      })

  const marginalContext = {
    sourceWorldRev: startWorld?.rev ?? null,
    sourceFarmDigest: computeStaticFarmStateDigest(startWorld),
    sourceIsleIndex: R.isleIndex(startWorld.now),
    sourceWorldDay: R.worldDay(startWorld.now),
    sourceCoins: Math.floor(Number(startWorld.coins || 0)),
    sourceEnergy: Math.floor(Number(startWorld.state?.en || 0)),
    seqBuckets: jointBuckets,
    slots: jointSlots,
    supplyByBucket: jointSupplyByBucket,
    jointCS,
    craftCapByIsle: jointCraftCapByIsle,
    enAfterPreByU: jointEnAfterPre,
    initialNatDay: R.worldDay(startWorld.now),
    initialCnt: startWorld.state?.cnt || {},
    allowCraft: allowedSet.has('craft'),
    maxCraftHoldIsleDays: jointMaxHoldDays,
    u0MarginalStaminaMeta,
    baseWorldEn0: Number(startWorld.state?.en || 0),
    t0,
    tH,
    objectiveCfg,
    scenarioSupplyFactor,
    recipeInputSet: globalRecipeInputSet,
  }

  return {
    raidScheduleInfeasible: false,
    raidTransitionsByBucket,
    bucketPlannedPostEnFloor,
    bucketActions: finalBucketActions,
    worldAfterSequence: execWorld,
    finalWorldAtHorizon,
    cashEvents,
    soldByIsle: execSoldByIsle,
    objectiveEval: objEval,
    discretizationMeta,
    marginalContext,
  }
}

function simulateValidBatch(adapter, world, candidateActions, { t, prices, rand = null } = {}) {
  if (!candidateActions || candidateActions.length === 0) {
    return { validActions: [], sim: null, afterWorld: world }
  }
  const maxBatch = adapter.R?.WORLD?.maxActions || 40
  if (candidateActions.length > maxBatch) {
    const validActions = []
    const mergedOut = []
    let cur = world
    for (let i = 0; i < candidateActions.length; i += maxBatch) {
      const part = simulateValidBatch(adapter, cur, candidateActions.slice(i, i + maxBatch), { t, prices, rand })
      if (part.validActions.length > 0) {
        validActions.push(...part.validActions)
        if (part.sim?.result?.out) mergedOut.push(...part.sim.result.out)
        cur = part.afterWorld
      }
    }
    if (validActions.length === 0) return { validActions: [], sim: null, afterWorld: world }
    return {
      validActions,
      sim: { allOk: true, result: { out: mergedOut }, afterWorld: cur },
      afterWorld: cur,
    }
  }
  const drawn = []
  const wrappedRand = typeof rand === 'function'
    ? () => {
        const v = rand()
        drawn.push(v)
        return v
      }
    : null
  const fastSim = adapter.simulateBatch(world, candidateActions, {
    t,
    prices,
    ...(wrappedRand ? { rand: wrappedRand } : {}),
  })
  if (fastSim.allOk) {
    return { validActions: candidateActions, sim: fastSim, afterWorld: fastSim.afterWorld }
  }
  const fastOut = fastSim.result?.out || []
  const fastAccepted = candidateActions.filter((_, idx) => fastOut[idx]?.ok === true)
  if (fastAccepted.length === 0) {
    return { validActions: [], sim: null, afterWorld: world }
  }
  let replayCursor = 0
  const replayRand = typeof rand === 'function'
    ? () => (replayCursor < drawn.length ? drawn[replayCursor++] : rand())
    : null
  const reSim = adapter.simulateBatch(world, fastAccepted, {
    t,
    prices,
    ...(replayRand ? { rand: replayRand } : {}),
  })
  if (reSim.allOk) {
    return { validActions: fastAccepted, sim: reSim, afterWorld: reSim.afterWorld }
  }
  replayCursor = 0
  const accepted = []
  const mergedOut = []
  let cur = adapter.cloneWorld(world)
  for (const act of candidateActions) {
    const step = adapter.simulateBatch(cur, [act], {
      t,
      prices,
      ...(replayRand ? { rand: replayRand } : {}),
    })
    if (step.allOk) {
      accepted.push(act)
      mergedOut.push(step.result.out[0] || { ok: true })
      cur = step.afterWorld
    }
  }
  if (accepted.length === 0) {
    return { validActions: [], sim: null, afterWorld: world }
  }
  return {
    validActions: accepted,
    sim: {
      allOk: true,
      result: { out: mergedOut },
      afterWorld: cur,
    },
    afterWorld: cur,
  }
}

export function buildThiefBuffCombinations(adapter, worldAtNow, constraints, allowedSet) {
  const combos = [[]]
  if (!constraints.allowThiefBuffPurchase || !allowedSet.has('buy')) return combos
  const bySlot = new Map()
  for (const [buffId, def] of Object.entries(adapter.R.THIEF_ITEMS || {})) {
    if (!def?.slot || !(def?.price > 0)) continue
    const cur = adapter.R.b12Effect?.(worldAtNow.state, def.slot, worldAtNow.now)
    // Skip if this exact buff already has > 30 min remaining or another/legacy buff occupies the same slot
    if (cur?.legacy) continue
    if (cur && cur.id !== buffId) continue
    if (cur && cur.id === buffId && cur.until > worldAtNow.now + 1800) continue
    const arr = bySlot.get(def.slot) || []
    arr.push({ buffId, def })
    bySlot.set(def.slot, arr)
  }
  let partial = [[]]
  for (const [, slotItems] of bySlot.entries()) {
    const next = []
    for (const prefix of partial) {
      next.push(prefix)
      for (const item of slotItems) {
        next.push([...prefix, { a: 'buy', id: item.buffId }])
      }
    }
    partial = next
  }
  return partial
}

export function findCheapestRaidStaminaPrep(adapter, worldAtNow, neededEn, allowedSet, utilityTokens, constraints) {
  if (Number(worldAtNow.state?.en || 0) >= neededEn) {
    return { feasible: true, prepActs: [], afterWorld: worldAtNow }
  }
  const { R } = adapter
  let curW = adapter.cloneWorld(worldAtNow)
  const prepActs = []
  for (let guard = 0; guard < 12 && Number(curW.state?.en || 0) < neededEn; guard++) {
    const s = curW.state
    const rawMax = Number(R.energyMax(s))
    const enMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 100
    let bestActs = null
    let bestCpe = Infinity
    const freeRaidCash = Math.max(0, Number(curW.coins || 0) - Number(constraints.cashReserveFloor || 0))
    if (allowedSet.has('eat') && s.en < enMax) {
      if (
        utilityTokens.snackId &&
        R.B12_SNACK &&
        Number(s.cnt?.[utilityTokens.snackId] || 0) < R.B12_SNACK.daily &&
        adapter.availableInv(s, utilityTokens.snackId, 0) > 0
      ) {
        const gain = Math.min(R.B12_SNACK.energy, enMax - s.en)
        if (gain > 0) {
          bestCpe = 0
          bestActs = [{ a: 'eat', id: utilityTokens.snackId }]
        }
      }
      for (const crop of R.CROPS || []) {
        if (!(crop.eat > 0)) continue
        for (let q = 0; q < 3; q++) {
          if (adapter.availableInv(s, crop.id, q) <= 0) continue
          const gain = Math.min(enMax - s.en, Math.round(crop.eat * (R.QUALITY?.[q] ?? 1)))
          if (!(gain > 0)) continue
          const unitQuote = Number(curW.prices?.[crop.id] || R.BASE_PRICE?.[crop.id] || 0) * (R.QUALITY?.[q] ?? 1)
          const cpe = unitQuote / gain
          if (cpe < bestCpe) {
            bestCpe = cpe
            bestActs = [{ a: 'eat', id: crop.id, q }]
          }
        }
      }
      if (allowedSet.has('stockBuy') && typeof R.b12Stock === 'function') {
        const cargoItems = R.b12Stock(curW.now, curW.prices)
        const isleDayNow = R.isleDay(curW.now)
        for (const cIt of cargoItems) {
          if (!(cIt.price > 0) || cIt.price > freeRaidCash || R.b12StockLeft(s, cIt, curW.now) <= 0) continue
          if (utilityTokens.snackId && cIt.id === utilityTokens.snackId && R.B12_SNACK) {
            if (Number(s.cnt?.[cIt.id] || 0) >= R.B12_SNACK.daily) continue
            const gain = Math.min(R.B12_SNACK.energy, enMax - s.en)
            if (gain > 0 && cIt.price / gain < bestCpe) {
              bestCpe = cIt.price / gain
              bestActs = [{ a: 'stockBuy', id: cIt.id, n: 1, day: isleDayNow }, { a: 'eat', id: cIt.id }]
            }
          } else {
            const cropDef = (R.CROPS || []).find((c) => c.id === cIt.id)
            if (!cropDef || !(cropDef.eat > 0)) continue
            const gain = Math.min(enMax - s.en, Math.round(cropDef.eat * (R.QUALITY?.[0] ?? 1)))
            if (gain > 0 && cIt.price / gain < bestCpe) {
              bestCpe = cIt.price / gain
              bestActs = [{ a: 'stockBuy', id: cIt.id, n: 1, day: isleDayNow }, { a: 'eat', id: cIt.id, q: 0 }]
            }
          }
        }
      }
    }
    const coffeePrice = R.WORLD?.coffee?.price || 15000
    const coffeeEn = R.WORLD?.coffee?.energy || 60
    if (
      allowedSet.has('coffee') &&
      Number(s.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
      freeRaidCash >= coffeePrice
    ) {
      const cpe = coffeePrice / coffeeEn
      if (cpe < bestCpe || !bestActs) {
        bestCpe = cpe
        bestActs = [{ a: 'coffee' }]
      }
    }
    if (!bestActs) break
    const step = adapter.simulateBatch(curW, bestActs, { t: curW.now, prices: curW.prices })
    if (!step.allOk) break
    curW = step.afterWorld
    prepActs.push(...bestActs)
  }
  return {
    feasible: Number(curW.state?.en || 0) >= neededEn,
    prepActs,
    afterWorld: curW,
  }
}

function advanceScalarStamina(curEn, curEnT, enMax, regenStep, targetSec) {
  if (targetSec <= curEnT) {
    return { en: curEn, enT: curEn >= enMax ? Math.max(curEnT, targetSec) : curEnT }
  }
  if (curEn >= enMax) {
    return { en: curEn, enT: Math.max(curEnT, targetSec) }
  }
  const n = Math.floor((targetSec - curEnT) / regenStep)
  if (n <= 0) return { en: curEn, enT: curEnT }
  const nextEn = Math.min(enMax, curEn + n)
  const nextEnT = nextEn >= enMax ? targetSec : curEnT + n * regenStep
  return { en: nextEn, enT: nextEnT }
}

function computeExpectedRaidTransition(adapter, raidBelief, visitorWorldAtRaid, marginalItemValueFn = null) {
  let effectiveBelief = raidBelief
  if (raidBelief?._rawNeighborTarget && visitorWorldAtRaid) {
    const rebuilt = buildVisitTargetBelief(adapter, visitorWorldAtRaid, raidBelief._rawNeighborTarget, visitorWorldAtRaid.now)
    effectiveBelief = {
      ...rebuilt,
      targetId: rebuilt.targetId ?? raidBelief.targetId,
      targetName: rebuilt.targetName || raidBelief.targetName,
      unlockAtSec: raidBelief.unlockAtSec,
      isImmediate: raidBelief.isImmediate,
      exactUnlockKnown: raidBelief.exactUnlockKnown,
      forcedBuffCombo: raidBelief.forcedBuffCombo,
    }
  }
  const dist = resolveRaidOutcomeDistribution(
    adapter,
    effectiveBelief,
    raidBelief?._rawNeighborTarget ? null : visitorWorldAtRaid,
    visitorWorldAtRaid?.now
  )
  const guaranteedArrivals = Object.entries(dist.guaranteedLootBag || {}).map(([id, n]) => ({ id, q: 0, n }))
  let grossLootValue = 0
  if (marginalItemValueFn) {
    for (const [id, expQty] of Object.entries(dist.expectedLootBag || {})) {
      grossLootValue += expQty * marginalItemValueFn(id, 0, visitorWorldAtRaid.now)
    }
  }
  return {
    belief: dist.belief,
    distribution: dist,
    energyCost: dist.energyCost,
    lootBag: dist.expectedLootBag,
    guaranteedLootBag: dist.guaranteedLootBag,
    guaranteedArrivals,
    expFine: dist.expectedFineCoins,
    worstCaseFineCoins: dist.worstCaseFineCoins,
    grossLootValue,
  }
}

function prepareRaidStaminaWithOppCost(adapter, worldAtRaid, neededEn, {
  allowedSet,
  utilityTokens,
  constraints,
  edibleSpecs = [],
  edibleOppValueFn = null,
  bucketDisc = 1,
} = {}) {
  if (Math.floor(Number(worldAtRaid.state?.en || 0)) >= neededEn) {
    return { feasible: true, prepActs: [], afterWorld: worldAtRaid, oppCost: 0 }
  }
  const { R } = adapter
  let curW = adapter.cloneWorld(worldAtRaid)
  const prepActs = []
  let oppCost = 0

  for (let guard = 0; guard < 12 && Math.floor(Number(curW.state?.en || 0)) < neededEn; guard++) {
    const s = curW.state
    const curEn = Math.max(0, Math.floor(Number(s.en || 0)))
    const rawMax = Number(R.energyMax(s))
    const enMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 100
    const freeRaidCash = Math.max(0, Number(curW.coins || 0) - Number(constraints.cashReserveFloor || 0))

    let bestActs = null
    let bestCpe = Infinity
    let bestStepOpp = Infinity

    if (allowedSet.has('eat') && curEn < enMax) {
      for (const spec of edibleSpecs) {
        const haveQty = spec.kind === 'snack'
          ? Math.min(
              adapter.availableInv(s, spec.id, 0),
              spec.dailyCap != null ? Math.max(0, spec.dailyCap - Number(s.cnt?.[spec.id] || 0)) : 999
            )
          : adapter.availableInv(s, spec.id, spec.q)
        if (!(haveQty > 0)) continue
        const gain = Math.min(enMax - curEn, spec.energyGain)
        if (!(gain > 0)) continue
        const stepOpp = spec.kind === 'snack'
          ? 0
          : (edibleOppValueFn
              ? edibleOppValueFn(s, spec.id, spec.q)
              : Number(curW.prices?.[spec.id] || R.BASE_PRICE?.[spec.id] || 0) * (R.QUALITY?.[spec.q] ?? 1) * bucketDisc)
        const cpe = stepOpp / gain
        if (cpe < bestCpe - 1e-9 || (Math.abs(cpe - bestCpe) <= 1e-9 && stepOpp < bestStepOpp)) {
          bestCpe = cpe
          bestStepOpp = stepOpp
          bestActs = [spec.kind === 'snack' ? { a: 'eat', id: spec.id } : { a: 'eat', id: spec.id, q: spec.q }]
        }
      }

      if (allowedSet.has('stockBuy') && typeof R.b12Stock === 'function') {
        const cargoItems = R.b12Stock(curW.now, curW.prices)
        const isleDayNow = R.isleDay(curW.now)
        for (const cIt of cargoItems) {
          if (!(cIt.price > 0) || cIt.price > freeRaidCash || R.b12StockLeft(s, cIt, curW.now) <= 0) continue
          if (utilityTokens?.snackId && cIt.id === utilityTokens.snackId && R.B12_SNACK) {
            if (Number(s.cnt?.[cIt.id] || 0) >= R.B12_SNACK.daily) continue
            const gain = Math.min(R.B12_SNACK.energy, enMax - curEn)
            const stepOpp = cIt.price * bucketDisc
            if (gain > 0 && stepOpp / gain < bestCpe - 1e-9) {
              bestCpe = stepOpp / gain
              bestStepOpp = stepOpp
              bestActs = [{ a: 'stockBuy', id: cIt.id, n: 1, day: isleDayNow }, { a: 'eat', id: cIt.id }]
            }
          } else {
            const cropDef = (R.CROPS || []).find((c) => c.id === cIt.id)
            if (!cropDef || !(cropDef.eat > 0)) continue
            const gain = Math.min(enMax - curEn, Math.round(cropDef.eat * (R.QUALITY?.[0] ?? 1)))
            const stepOpp = cIt.price * bucketDisc
            if (gain > 0 && stepOpp / gain < bestCpe - 1e-9) {
              bestCpe = stepOpp / gain
              bestStepOpp = stepOpp
              bestActs = [{ a: 'stockBuy', id: cIt.id, n: 1, day: isleDayNow }, { a: 'eat', id: cIt.id, q: 0 }]
            }
          }
        }
      }
    }

    const coffeePrice = R.WORLD?.coffee?.price || 15000
    const coffeeEn = R.WORLD?.coffee?.energy || 60
    if (
      allowedSet.has('coffee') &&
      Number(s.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
      freeRaidCash >= coffeePrice &&
      coffeeEn > 0
    ) {
      const stepOpp = coffeePrice * bucketDisc
      const cpe = stepOpp / coffeeEn
      if (cpe < bestCpe - 1e-9 || !bestActs) {
        bestCpe = cpe
        bestStepOpp = stepOpp
        bestActs = [{ a: 'coffee' }]
      }
    }

    if (!bestActs) break
    const step = adapter.simulateBatch(curW, bestActs, { t: curW.now, prices: curW.prices })
    if (!step.allOk) break
    curW = step.afterWorld
    prepActs.push(...bestActs)
    oppCost += bestStepOpp
  }

  return {
    feasible: Math.floor(Number(curW.state?.en || 0)) >= neededEn,
    prepActs,
    afterWorld: curW,
    oppCost,
  }
}

function replayRecordedRaidTransitions(adapter, world, transitions, { atSec, prices, cashEvents } = {}) {
  let curW = world
  for (const tr of transitions || []) {
    if (tr.prepAndBuffActs?.length > 0) {
      const bC = Number(curW.coins || 0)
      const sv = simulateValidBatch(adapter, curW, tr.prepAndBuffActs, { t: atSec, prices })
      curW = sv.afterWorld
      const aC = Number(curW.coins || 0)
      if (aC !== bC && cashEvents) {
        cashEvents.push({ atSec, netCashDelta: aC - bC })
      }
    }
    curW = adapter.advanceTimeOnly(curW, atSec, { futurePrices: prices })
    curW.state.en = Math.max(0, Math.floor(Number(curW.state?.en || 0)) - Number(tr.energyCost || 0))
    if (tr.intLoot?.length > 0) {
      curW = applyExogenousArrivals(curW, tr.intLoot)
    }
    const actualFine = Math.min(Math.max(0, Number(curW.coins || 0)), Number(tr.fineCoins || 0))
    if (actualFine > 0) {
      curW.coins = Math.max(0, Number(curW.coins || 0) - actualFine)
      if (cashEvents) {
        cashEvents.push({ atSec, netCashDelta: -actualFine })
      }
    }
  }
  return curW
}

/**
 * Unified Economic Kernel Solver (`solveUnifiedPlan`)
 *
 * Single mathematical brain across farming, ranching, cargo, workshop chains, crop tiers,
 * stamina conversion (`eat`/`coffee`), mining/fishing/bombing, CapEx, and neighbor raid (`visit`)!
 */
export function solveUnifiedPlan(adapter, envelope, objectiveCfgInput = {}, options = {}) {
  const startMs = performance.now()
  const startCpu = typeof process?.cpuUsage === 'function' ? process.cpuUsage() : null
  const nowMsFn = typeof options.nowMsFn === 'function' ? options.nowMsFn : Date.now
  const deadlineAtMs = Number.isFinite(options.deadlineAtMs)
    ? Number(options.deadlineAtMs)
    : (Number.isFinite(options.maxSolveMs) ? nowMsFn() + Number(options.maxSolveMs) : Infinity)
  let deadlineHit = false
  const isPastDeadline = () => {
    if (!Number.isFinite(deadlineAtMs)) return false
    if (deadlineHit) return true
    if (nowMsFn() >= deadlineAtMs) {
      deadlineHit = true
      return true
    }
    return false
  }
  if (options.abortHardOnDeadline === true && isPastDeadline()) {
    throw new SolverDeadlineError('Solver deadline exceeded before planning started')
  }

  const objectiveCfg = objectiveCfgInput?.objectiveHash
    ? objectiveCfgInput
    : buildObjectiveConfig(objectiveCfgInput)

  const world0 = adapter.cloneWorld(envelope.observed.world)
  adapter.syncClock(world0.clockStart)
  const utilityTokens = discoverRuleUtilityTokens(adapter)
  const constraints = envelope.constraints
  const maxCraftHoldIsleDays = options.maxCraftHoldIsleDays !== undefined ? options.maxCraftHoldIsleDays : 3

  // Seed endogenous prior sales map from ObservationEnvelope (`knownSoldByIsleIndex`) + `options.priorSoldByIsle`
  const baseSoldByIsle = new Map()
  const mergeSoldSource = (src) => {
    if (!src || typeof src !== 'object') return
    const entries = src instanceof Map ? [...src.entries()] : Object.entries(src)
    for (const [rawIdx, itemMap] of entries) {
      const idx = Number(rawIdx)
      if (!Number.isFinite(idx) || !itemMap || typeof itemMap !== 'object') continue
      const cur = baseSoldByIsle.get(idx) || {}
      for (const [id, qty] of Object.entries(itemMap)) {
        cur[id] = (cur[id] || 0) + Number(qty || 0)
      }
      baseSoldByIsle.set(idx, cur)
    }
  }
  mergeSoldSource(envelope.observed?.knownSoldByIsleIndex)
  mergeSoldSource(options.priorSoldByIsle)

  const defaultActions = [
    'sell', 'craft', 'wait', 'stockBuy', 'buy', 'eat', 'coffee',
    'plant', 'water', 'harvest', 'clear', 'collect', 'feed', 'pet',
    'trap', 'goal', 'fish', 'mine', 'bomb', 'visit',
    ...(constraints.allowCapex ? ['capex'] : []),
  ]
  const activeActionTypes = Array.isArray(options.allowedActionTypes)
    ? [...options.allowedActionTypes]
    : defaultActions
  const allowedSet = new Set(activeActionTypes)

  // Build multi-boundary event timeline
  const timeline = buildEventBuckets(adapter, world0, {
    horizonSec: objectiveCfg.horizonSec,
    deterministicArrivals: options.deterministicArrivals || [],
    maxBuckets: options.maxBuckets || 16,
    coalesceWindowSec: options.coalesceWindowSec ?? 5,
    preservePrefixThroughSec: options.preservePrefixThroughSec ?? null,
    prefixMaxBuckets: options.prefixMaxBuckets ?? null,
  })
  const buckets = timeline.buckets

  // Scenarios: if explicitPricesByBucket or single scenario is supplied, deterministic 1-scenario mode;
  // otherwise branch at first `isleDayOffset >= 1` bucket (`!isTrunkBeforePriceReveal`)!
  const rawScenarios = options.explicitPricesByBucket || options.explicitPricesByIsleIndex
    ? [{ id: 'explicit-deterministic', weight: 1.0, externalSupplyFactor: objectiveCfg.conservativeSupplyFactor }]
    : (options.scenarios?.length > 0
        ? options.scenarios
        : (envelope.beliefs?.scenarios?.length > 0
            ? envelope.beliefs.scenarios
            : [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }]))

  const weightSum = rawScenarios.reduce((s, x) => s + Number(x.weight || 0), 0) || 1
  const scenarios = rawScenarios.map((s) => ({ ...s, weight: Number(s.weight || 0) / weightSum }))

  // Partition buckets into shared non-anticipative trunk (`isTrunkBeforePriceReveal`) and scenario recourse branches!
  const hasFuturePriceBranch = scenarios.length > 1
    && !options.explicitPricesByBucket
    && !options.explicitPricesByIsleIndex
    && buckets.some((b) => !b.isTrunkBeforePriceReveal)

  const trunkBucketsMeta = hasFuturePriceBranch
    ? buckets.filter((b) => b.isTrunkBeforePriceReveal)
    : buckets
  const branchBucketsMeta = hasFuturePriceBranch
    ? buckets.filter((b) => !b.isTrunkBeforePriceReveal)
    : []

  // Memoize zero-self-sale future quotes per `(scenario.id, externalSupplyFactor, isleDayOffset, isleDay)`
  // so `makePricesFn` & `expectedPriceFn` only recompute the sparse items with `prevSoldMap[id] > 0`!
  const baseQuoteMemo = new Map()
  const getZeroSoldBaseQuotes = (scenario, bucket) => {
    const mKey = `${scenario.id}:${scenario.externalSupplyFactor}:${bucket.isleDayOffset}:${bucket.isleDay}`
    let baseMap = baseQuoteMemo.get(mKey)
    if (!baseMap) {
      baseMap = {}
      for (const id of adapter.graph.sellableIds) {
        baseMap[id] = quoteFutureItemUnderScenario(adapter, {
          itemId: id,
          isleDayIndex: bucket.isleDayOffset,
          isleDayStr: bucket.isleDay,
          currentPrices: world0.prices || {},
          externalSupplyFactor: scenario.externalSupplyFactor,
          selfSoldPrevIsleDay: 0,
        })
      }
      baseQuoteMemo.set(mKey, baseMap)
    }
    return baseMap
  }

  const makePricesFn = (scenario) => (bucket, soldByIsle) => {
    if (options.explicitPricesByBucket?.[bucket.index]) {
      return options.explicitPricesByBucket[bucket.index]
    }
    if (options.explicitPricesByIsleIndex?.[bucket.isleIndex]) {
      return options.explicitPricesByIsleIndex[bucket.isleIndex]
    }
    if (bucket.isleDayOffset === 0) {
      return world0.prices || {}
    }
    const baseMap = getZeroSoldBaseQuotes(scenario, bucket)
    const prevSoldMap = soldByIsle.get(bucket.isleIndex - 1)
    if (!prevSoldMap) return baseMap
    const soldKeys = Object.keys(prevSoldMap)
    if (soldKeys.length === 0) return baseMap
    const out = { ...baseMap }
    for (const id of soldKeys) {
      const qty = Number(prevSoldMap[id] || 0)
      if (!(qty > 0)) continue
      out[id] = quoteFutureItemUnderScenario(adapter, {
        itemId: id,
        isleDayIndex: bucket.isleDayOffset,
        isleDayStr: bucket.isleDay,
        currentPrices: world0.prices || {},
        externalSupplyFactor: scenario.externalSupplyFactor,
        selfSoldPrevIsleDay: qty,
      })
    }
    return out
  }

  // Pre-select any CapEx actions at `t0` strictly via counterfactual rule-trajectory delta (zero magic constants!)
  const preselectedCapexActions = Array.isArray(options.preselectedCapexActionsOverride)
    ? options.preselectedCapexActionsOverride
    : selectCapexByTrajectoryDelta(adapter, {
        world0,
        constraints,
        objectiveCfg,
        allowedSet,
        utilityTokens,
        makePricesFnForScenario0: makePricesFn(scenarios[0]),
        baseSoldByIsle,
        scenarioSupplyFactor: scenarios[0]?.externalSupplyFactor ?? null,
        maxCraftHoldIsleDays,
        isPastDeadlineFn: isPastDeadline,
      })

  const hasExplicitPriceOverride = Boolean(
    options.explicitPricesByBucket ||
    options.explicitPricesByIsleIndex ||
    (world0.prices && adapter.graph.sellableIds.some(
      (id) => Object.prototype.hasOwnProperty.call(world0.prices, id) && Number(world0.prices[id]) <= 0 && Number(adapter.R.BASE_PRICE?.[id]) > 0
    ))
  )

  // Evaluate a trunk policy candidate by running conditional recourse across all scenarios ω in Ω!
  const evaluateTrunkPolicy = (
    trunkPolicyMode,
    startW = world0,
    initialObjectiveW = startW,
    {
      customBuckets = null,
      enableFirstBucketPlant = true,
      enableFirstBucketStockBuy = true,
      capexActionsAtStart = startW === world0 ? preselectedCapexActions : [],
      initialCashEventsOverride = null,
      initialSoldByIsleOverride = null,
      prngFactory = null,
      scheduledUpcomingRaids = [],
      raidOutcomeOverrides = null,
    } = {}
  ) => {
    const activeBuckets = customBuckets || buckets
    const startSoldMap = initialSoldByIsleOverride || baseSoldByIsle
    const autoInitCashEvents = initialCashEventsOverride ?? (() => {
      const diff = Number(startW.coins || 0) - Number(initialObjectiveW.coins || 0)
      return diff !== 0 ? [{ atSec: initialObjectiveW.now, netCashDelta: diff }] : []
    })()

    const policyMeta = {
      trunkPolicyMode,
      enableFirstBucketPlant,
      enableFirstBucketStockBuy,
    }
    const activeHasBranch = scenarios.length > 1
      && !hasExplicitPriceOverride
      && activeBuckets.some((b) => !b.isTrunkBeforePriceReveal)

    if (!activeHasBranch) {
      const sc = scenarios[0]
      if (activeBuckets.length === 0) {
        const tH = initialObjectiveW.now + Math.max(0, Math.floor(objectiveCfg.horizonSec || 0))
        const termPrev = startSoldMap.get(adapter.R.isleIndex(tH) - 1) || null
        const termP = objectiveCfg.terminalSupplyMode === 'zero'
          ? {}
          : buildTerminalPrices(adapter, { ...startW, now: tH }, initialObjectiveW, objectiveCfg, sc.externalSupplyFactor, termPrev)
        const fW = adapter.advanceTimeOnly(startW, tH, { futurePrices: termP })
        const ev = evaluateTrajectoryObjective(adapter, {
          initialWorld: initialObjectiveW,
          finalWorld: fW,
          cashEvents: autoInitCashEvents,
          objectiveCfg,
          scenarioSupplyFactor: sc.externalSupplyFactor,
          explicitTerminalPrices: hasExplicitPriceOverride ? termP : null,
          prevIsleSoldMap: termPrev,
          allowTerminalCraft: allowedSet.has('craft'),
          allowTerminalHarvest: allowedSet.has('harvest'),
          allowTerminalPlant: allowedSet.has('plant'),
        })
        return {
          raidScheduleInfeasible: false,
          expectedValue: ev.totalObjectiveValue,
          policyExpectedValue: ev.totalObjectiveValue,
          policyMeta,
          allBuckets: activeBuckets,
          trunkBucketsUsed: [],
          trunkActionsByBucket: [],
          raidTransitionsByBucket: [],
          raidTransitionsFlat: [],
          bucketPlannedPostEnFloor: new Int32Array(0),
          scheduledUpcomingRaids,
          scenarioBranches: {
            [sc.id]: { weight: sc.weight, objectiveValue: ev.totalObjectiveValue, bucketActions: [] },
          },
        }
      }
      const res = optimizeAndSimulateSequence(adapter, {
        startWorld: startW,
        initialWorldForObjective: initialObjectiveW,
        seqBuckets: activeBuckets,
        pricesForBucketFn: makePricesFn(sc),
        objectiveCfg,
        constraints,
        allowedSet,
        utilityTokens,
        forcedTrunkSellPolicy: trunkPolicyMode,
        enableFirstBucketPlant,
        enableFirstBucketStockBuy,
        preselectedCapexActions: capexActionsAtStart,
        initialSoldByIsle: startSoldMap,
        scenarioSupplyFactor: sc.externalSupplyFactor,
        prngFactory,
        initialCashEvents: autoInitCashEvents,
        maxCraftHoldIsleDays,
        hasExplicitPriceOverride,
        isPastDeadlineFn: isPastDeadline,
        scheduledUpcomingRaids,
        raidOutcomeOverrides,
      })
      if (res.raidScheduleInfeasible) {
        return {
          raidScheduleInfeasible: true,
          expectedValue: -Infinity,
          policyExpectedValue: -Infinity,
          policyMeta,
          allBuckets: activeBuckets,
          trunkBucketsUsed: activeBuckets,
          trunkActionsByBucket: res.bucketActions,
          raidTransitionsByBucket: [],
          raidTransitionsFlat: [],
          bucketPlannedPostEnFloor: res.bucketPlannedPostEnFloor,
          scheduledUpcomingRaids,
          scenarioBranches: {},
        }
      }
      const raidTrByB = res.raidTransitionsByBucket || []
      return {
        raidScheduleInfeasible: false,
        expectedValue: res.objectiveEval.totalObjectiveValue,
        policyExpectedValue: res.objectiveEval.totalObjectiveValue,
        policyMeta,
        allBuckets: activeBuckets,
        trunkBucketsUsed: activeBuckets,
        trunkActionsByBucket: res.bucketActions,
        raidTransitionsByBucket: raidTrByB,
        raidTransitionsFlat: raidTrByB.flat(),
        bucketPlannedPostEnFloor: res.bucketPlannedPostEnFloor,
        scheduledUpcomingRaids,
        discretizationMeta: res.discretizationMeta,
        marginalContext: res.marginalContext,
        scenarioBranches: {
          [sc.id]: {
            weight: sc.weight,
            objectiveValue: res.objectiveEval.totalObjectiveValue,
            bucketActions: [],
          },
        },
      }
    }

    const activeTrunkMeta = activeBuckets.filter((b) => b.isTrunkBeforePriceReveal)
    const activeBranchMeta = activeBuckets.filter((b) => !b.isTrunkBeforePriceReveal)

    const expectedZeroSoldMemo = new Map()
    const expectedPriceFn = (bucket, soldByIsle) => {
      if (bucket.isleDayOffset === 0) return world0.prices || {}
      const eKey = `${bucket.isleDayOffset}:${bucket.isleDay}`
      let baseAvg = expectedZeroSoldMemo.get(eKey)
      if (!baseAvg) {
        baseAvg = {}
        for (const id of adapter.graph.sellableIds) baseAvg[id] = 0
        for (const sc of scenarios) {
          const bMap = getZeroSoldBaseQuotes(sc, bucket)
          for (const id of adapter.graph.sellableIds) {
            baseAvg[id] += sc.weight * Number(bMap[id] || 0)
          }
        }
        for (const id of adapter.graph.sellableIds) baseAvg[id] = Math.round(baseAvg[id])
        expectedZeroSoldMemo.set(eKey, baseAvg)
      }
      const prevSoldMap = soldByIsle.get(bucket.isleIndex - 1)
      if (!prevSoldMap) return baseAvg
      const soldKeys = Object.keys(prevSoldMap)
      if (soldKeys.length === 0) return baseAvg
      const avg = { ...baseAvg }
      for (const id of soldKeys) {
        const qty = Number(prevSoldMap[id] || 0)
        if (!(qty > 0)) continue
        let wSum = 0
        for (const sc of scenarios) {
          wSum += sc.weight * quoteFutureItemUnderScenario(adapter, {
            itemId: id,
            isleDayIndex: bucket.isleDayOffset,
            isleDayStr: bucket.isleDay,
            currentPrices: world0.prices || {},
            externalSupplyFactor: sc.externalSupplyFactor,
            selfSoldPrevIsleDay: qty,
          })
        }
        avg[id] = Math.round(wSum)
      }
      return avg
    }

    const lookaheadRun = optimizeAndSimulateSequence(adapter, {
      startWorld: startW,
      initialWorldForObjective: initialObjectiveW,
      seqBuckets: activeBuckets,
      pricesForBucketFn: expectedPriceFn,
      objectiveCfg,
      constraints,
      allowedSet,
      utilityTokens,
      forcedTrunkSellPolicy: trunkPolicyMode,
      enableFirstBucketPlant,
      enableFirstBucketStockBuy,
      preselectedCapexActions: capexActionsAtStart,
      initialSoldByIsle: startSoldMap,
      scenarioSupplyFactor: scenarios.reduce((s, x) => s + x.weight * x.externalSupplyFactor, 0),
      prngFactory,
      initialCashEvents: autoInitCashEvents,
      maxCraftHoldIsleDays,
      hasExplicitPriceOverride,
      skipObjectiveEval: true,
      isPastDeadlineFn: isPastDeadline,
      scheduledUpcomingRaids,
      raidOutcomeOverrides,
    })
    if (lookaheadRun.raidScheduleInfeasible) {
      return {
        raidScheduleInfeasible: true,
        expectedValue: -Infinity,
        policyExpectedValue: -Infinity,
        policyMeta,
        allBuckets: activeBuckets,
        trunkBucketsUsed: activeTrunkMeta,
        trunkActionsByBucket: [],
        raidTransitionsByBucket: [],
        raidTransitionsFlat: [],
        bucketPlannedPostEnFloor: new Int32Array(activeTrunkMeta.length),
        scheduledUpcomingRaids,
        scenarioBranches: {},
      }
    }

    // Replay ONLY the shared trunk actions `0..K-1` identically to obtain the exact common `worldAtBranchStart`!
    const K = activeTrunkMeta.length
    const trunkActions = lookaheadRun.bucketActions.slice(0, K)
    const trunkRaidTransitions = (lookaheadRun.raidTransitionsByBucket || []).slice(0, K)
    let trunkWorld = adapter.cloneWorld(startW)
    const trunkCashEvents = [...autoInitCashEvents]
    const trunkSoldByIsle = new Map()
    for (const [k, v] of startSoldMap.entries()) trunkSoldByIsle.set(k, { ...v })
    const replayPrng = typeof prngFactory === 'function' ? prngFactory() : adapter.makeSampleStreamPrng(0, initialObjectiveW.now)

    for (let u = 0; u < K; u++) {
      const b = activeTrunkMeta[u]
      trunkWorld = adapter.advanceTimeOnly(trunkWorld, b.atSec, { futurePrices: startW.prices || {} })
      trunkWorld = applyExogenousArrivals(trunkWorld, b.exogenousArrivalsAtStart)
      if (lookaheadRun.raidTransitionsByBucket?.[u]?.length > 0) {
        trunkWorld = replayRecordedRaidTransitions(adapter, trunkWorld, lookaheadRun.raidTransitionsByBucket[u], {
          atSec: b.atSec,
          prices: startW.prices || {},
          cashEvents: trunkCashEvents,
        })
      }
      const acts = trunkActions[u] || []
      if (acts.length > 0) {
        const beforeC = Number(trunkWorld.coins || 0)
        const sv = simulateValidBatch(adapter, trunkWorld, acts, { t: b.atSec, prices: startW.prices || {}, rand: replayPrng })
        trunkWorld = sv.afterWorld
        const afterC = Number(trunkWorld.coins || 0)
        if (afterC !== beforeC) trunkCashEvents.push({ atSec: b.atSec, netCashDelta: afterC - beforeC })
        if (sv.sim) {
          sv.validActions.forEach((act, idx) => {
            if (act.a === 'sell' && sv.sim.result.out[idx]?.ok) {
              const m = trunkSoldByIsle.get(b.isleIndex) || {}
              m[act.id] = (m[act.id] || 0) + Number(act.n || 0)
              trunkSoldByIsle.set(b.isleIndex, m)
            }
          })
        }
      }
    }

    // Now branch per scenario ω at `activeBranchMeta` (`isleDayOffset >= 1`), optimizing conditional recourse!
    const branchStartSec = activeBranchMeta[0]?.atSec ?? Infinity
    const branchUpcomingRaids = (scheduledUpcomingRaids || []).filter((r) => Number(r.unlockAtSec) >= branchStartSec)
    let expectedVal = 0
    const scenarioBranches = {}
    let firstBranchRaidTransitionsFlat = []
    const mergedDisc = {
      cashDiscretized: Boolean(lookaheadRun.discretizationMeta?.cashDiscretized),
      maxCashUnit: Number(lookaheadRun.discretizationMeta?.maxCashUnit || 1),
      minExactGcd: Number(lookaheadRun.discretizationMeta?.minExactGcd || 1),
      maxDpCells: Number(lookaheadRun.discretizationMeta?.maxDpCells || 0),
      sites: [...(lookaheadRun.discretizationMeta?.sites || [])],
    }
    for (let scIdx = 0; scIdx < scenarios.length; scIdx++) {
      const sc = scenarios[scIdx]
      const branchRes = optimizeAndSimulateSequence(adapter, {
        startWorld: trunkWorld,
        initialWorldForObjective: initialObjectiveW,
        seqBuckets: activeBranchMeta,
        pricesForBucketFn: makePricesFn(sc),
        objectiveCfg,
        constraints,
        allowedSet,
        utilityTokens,
        forcedTrunkSellPolicy: 'optimal',
        preselectedCapexActions: [],
        initialSoldByIsle: trunkSoldByIsle,
        scenarioSupplyFactor: sc.externalSupplyFactor,
        prngFactory,
        initialCashEvents: [],
        maxCraftHoldIsleDays,
        hasExplicitPriceOverride,
        skipObjectiveEval: true,
        isPastDeadlineFn: isPastDeadline,
        scheduledUpcomingRaids: branchUpcomingRaids,
        raidOutcomeOverrides,
      })
      if (branchRes.raidScheduleInfeasible) {
        return {
          raidScheduleInfeasible: true,
          expectedValue: -Infinity,
          policyExpectedValue: -Infinity,
          policyMeta,
          allBuckets: activeBuckets,
          trunkBucketsUsed: activeTrunkMeta,
          trunkActionsByBucket: trunkActions,
          raidTransitionsByBucket: trunkRaidTransitions,
          raidTransitionsFlat: trunkRaidTransitions.flat(),
          bucketPlannedPostEnFloor: lookaheadRun.bucketPlannedPostEnFloor.slice(0, K),
          scheduledUpcomingRaids,
          scenarioBranches: {},
        }
      }
      if (scIdx === 0 && branchRes.raidTransitionsByBucket) {
        firstBranchRaidTransitionsFlat = branchRes.raidTransitionsByBucket.flat()
      }
      if (branchRes.discretizationMeta) {
        mergedDisc.maxDpCells = Math.max(mergedDisc.maxDpCells, branchRes.discretizationMeta.maxDpCells || 0)
        if (branchRes.discretizationMeta.cashDiscretized) {
          mergedDisc.minExactGcd = !mergedDisc.cashDiscretized
            ? branchRes.discretizationMeta.minExactGcd
            : Math.min(mergedDisc.minExactGcd, branchRes.discretizationMeta.minExactGcd)
          mergedDisc.cashDiscretized = true
          mergedDisc.maxCashUnit = Math.max(mergedDisc.maxCashUnit, branchRes.discretizationMeta.maxCashUnit || 1)
          for (const site of branchRes.discretizationMeta.sites || []) {
            if (!mergedDisc.sites.includes(site)) mergedDisc.sites.push(site)
          }
        }
      }
      const combinedCashEvents = [...trunkCashEvents, ...branchRes.cashEvents]
      const termPrevSold = branchRes.soldByIsle.get(adapter.R.isleIndex(branchRes.finalWorldAtHorizon.now) - 1) || null
      const fullEval = evaluateTrajectoryObjective(adapter, {
        initialWorld: initialObjectiveW,
        finalWorld: branchRes.finalWorldAtHorizon,
        cashEvents: combinedCashEvents,
        objectiveCfg,
        scenarioSupplyFactor: sc.externalSupplyFactor,
        explicitTerminalPrices: hasExplicitPriceOverride ? null : null,
        prevIsleSoldMap: termPrevSold,
        allowTerminalCraft: allowedSet.has('craft'),
        allowTerminalHarvest: allowedSet.has('harvest'),
        allowTerminalPlant: allowedSet.has('plant'),
      })
      expectedVal += sc.weight * fullEval.totalObjectiveValue
      scenarioBranches[sc.id] = {
        weight: sc.weight,
        objectiveValue: fullEval.totalObjectiveValue,
        bucketActions: branchRes.bucketActions,
      }
    }

    return {
      raidScheduleInfeasible: false,
      expectedValue: expectedVal,
      policyExpectedValue: expectedVal,
      policyMeta,
      allBuckets: activeBuckets,
      trunkBucketsUsed: activeTrunkMeta,
      trunkActionsByBucket: trunkActions,
      raidTransitionsByBucket: trunkRaidTransitions,
      raidTransitionsFlat: [...trunkRaidTransitions.flat(), ...firstBranchRaidTransitionsFlat],
      bucketPlannedPostEnFloor: lookaheadRun.bucketPlannedPostEnFloor.slice(0, K),
      scheduledUpcomingRaids,
      discretizationMeta: mergedDisc,
      marginalContext: lookaheadRun.marginalContext,
      scenarioBranches,
    }
  }

  const minGapSec = adapter.R.WORLD?.minGap || 2
  const tHorizonEnd = world0.now + Math.max(0, Math.floor(objectiveCfg.horizonSec || 0))
  const remArrivalsAfterT0 = (options.deterministicArrivals || []).filter((a) => a.atSec > world0.now)
  const scoredPrefixCache = new Map()

  const evalContinuationFromPostPrefix = (
    afterPrefixWorld,
    prefixCashEvents,
    prefixSoldMap,
    prngFactory = null,
    contPolicyMode = 'optimal',
    scheduledUpcomingRaids = [],
    raidOutcomeOverrides = null
  ) => {
    const tFollow = Math.min(tHorizonEnd, world0.now + minGapSec)
    const wCont = tFollow > afterPrefixWorld.now
      ? adapter.advanceTimeOnly(afterPrefixWorld, tFollow, { futurePrices: world0.prices || {} })
      : afterPrefixWorld
    const remRaids = (scheduledUpcomingRaids || [])
      .filter((r) => Number(r.unlockAtSec) > world0.now && Number(r.unlockAtSec) <= tHorizonEnd)
      .map((r) => (Number(r.unlockAtSec) < wCont.now ? { ...r, unlockAtSec: wCont.now } : r))
    const baseMaxB = options.maxBuckets || 16
    const contMaxBuckets = (prngFactory != null ? Math.min(8, baseMaxB) : baseMaxB) + remRaids.length
    const contBuckets = (tFollow < tHorizonEnd || objectiveCfg.horizonSec > 0)
      ? buildEventBuckets(adapter, wCont, {
          horizonSec: Math.max(0, tHorizonEnd - wCont.now),
          deterministicArrivals: remArrivalsAfterT0,
          upcomingRaidSecs: remRaids.map((r) => Number(r.unlockAtSec)),
          maxBuckets: contMaxBuckets,
          coalesceWindowSec: options.coalesceWindowSec ?? 5,
          preservePrefixThroughSec: prngFactory != null ? null : (options.preservePrefixThroughSec ?? null),
          prefixMaxBuckets: prngFactory != null
            ? null
            : (options.prefixMaxBuckets != null ? options.prefixMaxBuckets + remRaids.length : null),
        }).buckets
      : []
    const modeToUse = contPolicyMode === 'hold-in-first-bucket' && contBuckets.length > 1
      ? 'hold-in-first-bucket'
      : 'optimal'
    const contRes = evaluateTrunkPolicy(modeToUse, wCont, world0, {
      customBuckets: contBuckets,
      capexActionsAtStart: [],
      initialCashEventsOverride: prefixCashEvents,
      initialSoldByIsleOverride: prefixSoldMap,
      prngFactory,
      scheduledUpcomingRaids: remRaids,
      raidOutcomeOverrides,
    })
    if (contRes.raidScheduleInfeasible && remRaids.length > 0) {
      return evalContinuationFromPostPrefix(
        afterPrefixWorld,
        prefixCashEvents,
        prefixSoldMap,
        prngFactory,
        contPolicyMode,
        [],
        raidOutcomeOverrides
      )
    }
    contRes._evalStartWorld = wCont
    contRes._evalInitCash = prefixCashEvents
    contRes._evalInitSold = prefixSoldMap
    return contRes
  }

  const candidateHasDomesticStoch = (c) => {
    for (const bActs of c?.trunkActionsByBucket || []) {
      for (const a of bActs || []) if (adapter.isStochasticAction(a)) return true
    }
    for (const br of Object.values(c?.scenarioBranches || {})) {
      for (const bActs of br.bucketActions || []) {
        for (const a of bActs || []) if (adapter.isStochasticAction(a)) return true
      }
    }
    return false
  }

  // Non-anticipative exact discrete outcome tree for stochastic neighbor raids (`{ undetected, guard-win, guard-tie, guard-loss }`):
  // - Replays all pre-raid domestic buckets `0 .. uStoch - 1` AND pre-visit `prepAndBuffActs` ONCE identically (zero hindsight!).
  // - Branches ONLY on the discrete raid receipt at `bRaid.atSec`, allowing post-receipt buckets `uStoch .. B-1` to adapt to
  //   integer realized loot and discrete `-actualFine` (zero fractional cash, zero pre-receipt infeasible commitments!).
  const evalExactUpcomingRaidTree = (baseCand, startW = world0, initCash = null, initSold = null, depth = 0) => {
    const allRaidFlat = baseCand?.raidTransitionsFlat || []
    const stochFlat = allRaidFlat.filter((tr) => tr?.distribution?.isStochastic)
    if (stochFlat.length === 0) {
      return { ok: !candidateHasDomesticStoch(baseCand), value: baseCand.expectedValue, branchCount: 1 }
    }
    if (depth > 3 || candidateHasDomesticStoch(baseCand)) {
      return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
    }
    let totalCombos = 1
    for (const tr of stochFlat) {
      const nOut = (tr.distribution?.outcomes || []).filter((o) => o.prob > 1e-9).length || 1
      totalCombos *= nOut
    }
    if (totalCombos > 16) {
      return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
    }

    const uStoch = (baseCand.raidTransitionsByBucket || []).findIndex((trs) =>
      (trs || []).some((tr) => tr?.distribution?.isStochastic)
    )
    const curSoldBase = initSold || baseSoldByIsle
    const curCashBase = initCash ?? (() => {
      const diff = Number(startW.coins || 0) - Number(world0.coins || 0)
      return diff !== 0 ? [{ atSec: world0.now, netCashDelta: diff }] : []
    })()

    if (uStoch < 0) {
      // Stochastic raid occurs in post-isle-reveal scenario branches (`activeBranchMeta`): enumerate `raidOutcomeOverrides`
      let states = [{ prob: 1, overrides: new Map() }]
      for (const tr of stochFlat) {
        const rKey = `${tr.targetId}@${Number(tr.unlockAtSec ?? tr.atSec)}`
        const outs = (tr.distribution?.outcomes || []).filter((o) => o.prob > 1e-9)
        const nextStates = []
        for (const st of states) {
          for (const out of outs) {
            const nextMap = new Map(st.overrides)
            nextMap.set(rKey, out)
            nextStates.push({ prob: st.prob * out.prob, overrides: nextMap })
          }
        }
        states = nextStates
      }
      let mean = 0
      for (const st of states) {
        if (isPastDeadline()) return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
        const sub = evaluateTrunkPolicy(baseCand.policyMeta?.trunkPolicyMode || 'optimal', startW, world0, {
          customBuckets: baseCand.allBuckets,
          enableFirstBucketPlant: baseCand.policyMeta?.enableFirstBucketPlant ?? true,
          enableFirstBucketStockBuy: baseCand.policyMeta?.enableFirstBucketStockBuy ?? true,
          capexActionsAtStart: startW === world0 ? preselectedCapexActions : [],
          initialCashEventsOverride: curCashBase,
          initialSoldByIsleOverride: curSoldBase,
          scheduledUpcomingRaids: baseCand.scheduledUpcomingRaids || [],
          raidOutcomeOverrides: st.overrides,
        })
        if (sub.raidScheduleInfeasible || candidateHasDomesticStoch(sub)) {
          return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
        }
        mean += st.prob * sub.expectedValue
      }
      return { ok: true, value: mean, branchCount: states.length }
    }

    // Replay `0 .. uStoch - 1` identically before the stochastic raid unlocks
    let preW = adapter.cloneWorld(startW)
    const preCash = [...curCashBase]
    const preSold = new Map()
    for (const [k, v] of curSoldBase.entries()) preSold.set(k, { ...v })

    for (let u = 0; u < uStoch; u++) {
      const b = baseCand.trunkBucketsUsed[u]
      const pB = makePricesFn(scenarios[0])(b, preSold)
      preW = adapter.advanceTimeOnly(preW, b.atSec, { futurePrices: pB })
      preW = applyExogenousArrivals(preW, b.exogenousArrivalsAtStart)
      if (baseCand.raidTransitionsByBucket?.[u]?.length > 0) {
        preW = replayRecordedRaidTransitions(adapter, preW, baseCand.raidTransitionsByBucket[u], {
          atSec: b.atSec,
          prices: pB,
          cashEvents: preCash,
        })
      }
      const acts = baseCand.trunkActionsByBucket?.[u] || []
      if (acts.length > 0) {
        const bCoins = Number(preW.coins || 0)
        const sv = simulateValidBatch(adapter, preW, acts, { t: b.atSec, prices: pB })
        preW = sv.afterWorld
        const aCoins = Number(preW.coins || 0)
        if (aCoins !== bCoins) preCash.push({ atSec: b.atSec, netCashDelta: aCoins - bCoins })
        if (sv.sim) {
          sv.validActions.forEach((act, idx) => {
            if (act.a === 'sell' && sv.sim.result.out[idx]?.ok) {
              const sm = preSold.get(b.isleIndex) || {}
              sm[act.id] = (sm[act.id] || 0) + Number(act.n || 0)
              preSold.set(b.isleIndex, sm)
            }
          })
        }
      }
    }

    const bRaid = baseCand.trunkBucketsUsed[uStoch]
    const pRaid = makePricesFn(scenarios[0])(bRaid, preSold)
    preW = adapter.advanceTimeOnly(preW, bRaid.atSec, { futurePrices: pRaid })
    preW = applyExogenousArrivals(preW, bRaid.exogenousArrivalsAtStart)

    let states = [{ prob: 1, w: preW, cash: preCash }]
    const trsAtU = baseCand.raidTransitionsByBucket?.[uStoch] || []
    for (const tr of trsAtU) {
      const nextStates = []
      const outs = (tr.distribution?.outcomes || [{ kind: 'undetected', prob: 1, lootBag: {}, fineCoins: 0 }])
        .filter((o) => o.prob > 1e-9)
      for (const st of states) {
        let wAfterPrep = adapter.cloneWorld(st.w)
        const cashAfterPrep = [...st.cash]
        if (tr.prepAndBuffActs?.length > 0) {
          const bC = Number(wAfterPrep.coins || 0)
          const svP = simulateValidBatch(adapter, wAfterPrep, tr.prepAndBuffActs, { t: bRaid.atSec, prices: pRaid })
          wAfterPrep = svP.afterWorld
          const aC = Number(wAfterPrep.coins || 0)
          if (aC !== bC) cashAfterPrep.push({ atSec: bRaid.atSec, netCashDelta: aC - bC })
        }
        wAfterPrep = adapter.advanceTimeOnly(wAfterPrep, bRaid.atSec, { futurePrices: pRaid })
        wAfterPrep.state.en = Math.max(0, Math.floor(Number(wAfterPrep.state?.en || 0)) - Number(tr.energyCost || 0))

        for (const out of outs) {
          let wBr = adapter.cloneWorld(wAfterPrep)
          const cashBr = [...cashAfterPrep]
          const arrivals = Object.entries(out.lootBag || {}).map(([id, n]) => ({ id, q: 0, n }))
          if (arrivals.length > 0) wBr = applyExogenousArrivals(wBr, arrivals)
          const actualFine = Math.min(Math.max(0, Number(wBr.coins || 0)), Math.max(0, Math.round(Number(out.fineCoins || 0))))
          if (actualFine > 0) {
            wBr.coins = Math.max(0, Number(wBr.coins || 0) - actualFine)
            cashBr.push({ atSec: bRaid.atSec, netCashDelta: -actualFine })
          }
          nextStates.push({ prob: st.prob * out.prob, w: wBr, cash: cashBr })
        }
      }
      states = nextStates
    }

    const remBuckets = (baseCand.allBuckets || []).slice(uStoch).map((b, idx) =>
      idx === 0 ? { ...b, index: 0, exogenousArrivalsAtStart: [] } : { ...b, index: idx }
    )
    const remRaids = (baseCand.scheduledUpcomingRaids || []).filter((r) => Number(r.unlockAtSec) > bRaid.atSec)

    let meanVal = 0
    let totalBranches = 0
    for (const br of states) {
      if (isPastDeadline()) return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
      const subCand = evaluateTrunkPolicy(baseCand.policyMeta?.trunkPolicyMode || 'optimal', br.w, world0, {
        customBuckets: remBuckets,
        enableFirstBucketPlant: uStoch === 0 ? (baseCand.policyMeta?.enableFirstBucketPlant ?? true) : true,
        enableFirstBucketStockBuy: uStoch === 0 ? (baseCand.policyMeta?.enableFirstBucketStockBuy ?? true) : true,
        capexActionsAtStart: uStoch === 0 && startW === world0 ? preselectedCapexActions : [],
        initialCashEventsOverride: br.cash,
        initialSoldByIsleOverride: preSold,
        scheduledUpcomingRaids: remRaids,
      })
      if (subCand.raidScheduleInfeasible || candidateHasDomesticStoch(subCand)) {
        return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
      }
      const rec = evalExactUpcomingRaidTree(subCand, br.w, br.cash, preSold, depth + 1)
      if (!rec.ok) {
        return { ok: false, value: baseCand.expectedValue, branchCount: 0 }
      }
      meanVal += br.prob * rec.value
      totalBranches += rec.branchCount
    }
    return { ok: true, value: meanVal, branchCount: totalBranches }
  }

  // True Policy Expectation Evaluator (`Round-2 P1-1` + `v1.4.3 Discrete Raid Outcome Alignment`):
  // Scores EVERY candidate BEFORE ranking so candidate comparison (`candidateModes`, `upstreamVariants`, `raidSubsets`)
  // and final quality reporting BOTH use true stochastic policy expectation (exact discrete outcome enumeration
  // for single `harvest`/`fish`/`mine` and/or discrete guarded raid outcomes, or paired CRN M-stream Monte Carlo)!
  let fastRankingMode = Boolean(options._fastCandidateRankingOnly)
  const scoreDomesticCandidate = (cand) => {
    const candRaids = cand.scheduledUpcomingRaids || []
    const immSig = cand.immediateRaidMeta?.sig || ''
    const raidSig = `${immSig}::${candRaids.map((r) => `${r.targetId}@${r.unlockAtSec}:${r.energyCost}`).join('|')}`
    let trunkStochCount = 0
    for (const bActs of cand.trunkActionsByBucket || []) {
      for (const a of bActs || []) if (adapter.isStochasticAction(a)) trunkStochCount++
    }
    let branchStochCount = 0
    for (const br of Object.values(cand.scenarioBranches || {})) {
      for (const bActs of br.bucketActions || []) {
        for (const a of bActs || []) if (adapter.isStochasticAction(a)) branchStochCount++
      }
    }
    const hasDomStoch = (trunkStochCount + branchStochCount) > 0
    const hasImmStochRaid = Boolean(cand.immediateRaidMeta?.hasStochasticImmRaid)
    const hasUpcomingStochRaid = Boolean((cand.raidTransitionsFlat || []).some((tr) => tr?.distribution?.isStochastic))
    const hasAnyStochRaid = hasImmStochRaid || hasUpcomingStochRaid

    if (!hasDomStoch && !hasAnyStochRaid) {
      cand.policyExpectedValue = cand.expectedValue
      cand.standardError = 0
      cand.confidenceInterval95 = null
      cand.policySampleCount = null
      cand.valueInterpretation = scenarios.length === 1
        ? 'deterministic-exact'
        : 'conditional-scenario-expectation'
      return cand
    }

    if (!hasDomStoch && hasAnyStochRaid) {
      if (isPastDeadline()) {
        cand.policyExpectedValue = cand.expectedValue
        cand.standardError = 0
        cand.confidenceInterval95 = null
        cand.policySampleCount = 1
        cand.valueInterpretation = 'deadline-truncated-single-stream'
        return cand
      }
      if (cand.immediateRaidMeta?.evalExactExpectationFn) {
        const immExact = cand.immediateRaidMeta.evalExactExpectationFn()
        if (immExact.ok) {
          cand.policyExpectedValue = immExact.value
          cand.standardError = 0
          cand.confidenceInterval95 = [immExact.value, immExact.value]
          cand.policySampleCount = immExact.branchCount
          cand.valueInterpretation = 'exact-discrete-policy-expectation'
          return cand
        }
      } else {
        const upExact = evalExactUpcomingRaidTree(
          cand,
          cand._evalStartWorld || world0,
          cand._evalInitCash || null,
          cand._evalInitSold || null,
          0
        )
        if (upExact.ok) {
          cand.policyExpectedValue = upExact.value
          cand.standardError = 0
          cand.confidenceInterval95 = [upExact.value, upExact.value]
          cand.policySampleCount = upExact.branchCount
          cand.valueInterpretation = 'exact-discrete-policy-expectation'
          return cand
        }
      }
    }

    const b0 = cand.immediateRaidMeta ? null : cand.trunkBucketsUsed?.[0]
    const dom0 = cand.immediateRaidMeta ? [] : (cand.trunkActionsByBucket?.[0] || [])
    const firstStochIdx = dom0.findIndex((a) => adapter.isStochasticAction(a))
    const rawContMode = cand.policyMeta?.trunkPolicyMode === 'hold-in-first-bucket' ? 'hold-in-first-bucket' : 'optimal'
    // When `firstStochIdx >= 0`, execution commits `compiledPrefix` at `t0` and re-enters the unified planner
    // fresh after receiving the stochastic receipt (`t0 + minGap`), so post-receipt recourse is unified (`'optimal'`).
    // When `firstStochIdx === -1` (deterministic bucket 0), preserve candidate-specific `rawContMode`!
    const contMode = firstStochIdx >= 0 ? 'optimal' : rawContMode
    let causalPref = dom0
    if (firstStochIdx >= 0 && b0) {
      const p0Tmp = makePricesFn(scenarios[0])(b0, baseSoldByIsle)
      let w0Tmp = adapter.advanceTimeOnly(world0, b0.atSec, { futurePrices: p0Tmp })
      w0Tmp = applyExogenousArrivals(w0Tmp, b0.exogenousArrivalsAtStart)
      causalPref = computeCausalStochasticPrefix(adapter, w0Tmp, dom0, adapter.R.WORLD?.maxActions || 40).prefix
    }
    const compiledPrefix = firstStochIdx >= 0 ? causalPref : dom0
    const cacheKey = b0 && !(cand.raidTransitionsByBucket?.[0]?.length > 0)
      ? JSON.stringify(
          firstStochIdx >= 0
            ? { k: 'pref', pref: compiledPrefix, r: raidSig }
            : { k: 'det0', contMode, pref: compiledPrefix, r: raidSig }
        )
      : JSON.stringify({ k: 'full', meta: cand.policyMeta, acts: cand.trunkActionsByBucket, r: raidSig })

    if (scoredPrefixCache.has(cacheKey)) {
      Object.assign(cand, scoredPrefixCache.get(cacheKey))
      return cand
    }

    if (isPastDeadline()) {
      cand.policyExpectedValue = cand.expectedValue
      cand.standardError = 0
      cand.confidenceInterval95 = null
      cand.policySampleCount = 1
      cand.valueInterpretation = 'deadline-truncated-single-stream'
      return cand
    }

    let exactEvaluated = false
    if (
      firstStochIdx >= 0 &&
      trunkStochCount === 1 &&
      branchStochCount === 0 &&
      b0 &&
      !(cand.raidTransitionsByBucket?.[0]?.length > 0)
    ) {
      const detBefore = dom0.slice(0, firstStochIdx)
      const stochAct = dom0[firstStochIdx]
      if (stochAct.a === 'harvest' || stochAct.a === 'fish' || stochAct.a === 'mine') {
        const p0 = makePricesFn(scenarios[0])(b0, baseSoldByIsle)
        let wAt0 = adapter.advanceTimeOnly(world0, b0.atSec, { futurePrices: p0 })
        wAt0 = applyExogenousArrivals(wAt0, b0.exogenousArrivalsAtStart)
        const preSold = new Map()
        for (const [k, v] of baseSoldByIsle.entries()) preSold.set(k, { ...v })
        const preCash = []

        if (detBefore.length > 0) {
          const bCoins = Number(wAt0.coins || 0)
          const simPre = adapter.simulateBatch(wAt0, detBefore, { t: b0.atSec, prices: p0 })
          wAt0 = simPre.afterWorld
          const aCoins = Number(wAt0.coins || 0)
          if (aCoins !== bCoins) preCash.push({ atSec: b0.atSec, netCashDelta: aCoins - bCoins })
          detBefore.forEach((act, idx) => {
            if (act.a === 'sell' && simPre.result.out[idx]?.ok) {
              const m = preSold.get(b0.isleIndex) || {}
              m[act.id] = (m[act.id] || 0) + Number(act.n || 0)
              preSold.set(b0.isleIndex, m)
            }
          })
        }

        const exactBranches = adapter.enumerateExactSingleStochasticOutcomes(wAt0, stochAct, {
          t: b0.atSec,
          prices: p0,
        })

        if (exactBranches && exactBranches.length > 0) {
          let exactMean = 0
          let anyFurtherStoch = false
          let totalLeafCount = 0
          for (const br of exactBranches) {
            if (isPastDeadline()) {
              anyFurtherStoch = true
              break
            }
            const brCash = [...preCash]
            const dC = Number(br.afterWorld.coins || 0) - Number(wAt0.coins || 0)
            if (dC !== 0) brCash.push({ atSec: b0.atSec, netCashDelta: dC })
            const cont = evalContinuationFromPostPrefix(br.afterWorld, brCash, preSold, null, contMode, candRaids)
            if (candidateHasDomesticStoch(cont)) {
              anyFurtherStoch = true
              break
            }
            const contRaidTree = evalExactUpcomingRaidTree(
              cont,
              cont._evalStartWorld || br.afterWorld,
              cont._evalInitCash || brCash,
              cont._evalInitSold || preSold,
              0
            )
            if (!contRaidTree.ok) {
              anyFurtherStoch = true
              break
            }
            exactMean += br.prob * contRaidTree.value
            totalLeafCount += contRaidTree.branchCount
          }
          if (!anyFurtherStoch) {
            const stats = {
              policyExpectedValue: exactMean,
              standardError: 0,
              confidenceInterval95: [exactMean, exactMean],
              policySampleCount: totalLeafCount || exactBranches.length,
              valueInterpretation: 'exact-discrete-policy-expectation',
            }
            scoredPrefixCache.set(cacheKey, stats)
            Object.assign(cand, stats)
            exactEvaluated = true
          }
        }
      }
    }

    if (!exactEvaluated) {
      const defaultM = scenarios.length > 1 ? 2 : (buckets.length > 4 ? 4 : 8)
      const M = options.stochasticPolicySamples != null
        ? Math.max(1, Math.floor(Number(options.stochasticPolicySamples)))
        : (fastRankingMode ? 1 : defaultM)
      const sampleVals = []

      // Pre-compute deterministic prefix state once when `firstStochIdx === -1 && b0`!
      let detPostPrefix = null
      if (firstStochIdx === -1 && b0 && !(cand.raidTransitionsByBucket?.[0]?.length > 0)) {
        const p0 = makePricesFn(scenarios[0])(b0, baseSoldByIsle)
        let wAt0 = adapter.advanceTimeOnly(world0, b0.atSec, { futurePrices: p0 })
        wAt0 = applyExogenousArrivals(wAt0, b0.exogenousArrivalsAtStart)
        const preSold = new Map()
        for (const [k, v] of baseSoldByIsle.entries()) preSold.set(k, { ...v })
        const preCash = []
        if (dom0.length > 0) {
          const bCoins = Number(wAt0.coins || 0)
          const simDet = adapter.simulateBatch(wAt0, dom0, { t: b0.atSec, prices: p0 })
          wAt0 = simDet.afterWorld
          const aCoins = Number(wAt0.coins || 0)
          if (aCoins !== bCoins) preCash.push({ atSec: b0.atSec, netCashDelta: aCoins - bCoins })
          dom0.forEach((act, idx) => {
            if (act.a === 'sell' && simDet.result.out[idx]?.ok) {
              const sm = preSold.get(b0.isleIndex) || {}
              sm[act.id] = (sm[act.id] || 0) + Number(act.n || 0)
              preSold.set(b0.isleIndex, sm)
            }
          })
        }
        detPostPrefix = { afterWorld: wAt0, preCash, preSold }
      }

      const fixedStochPrefix = firstStochIdx >= 0 ? compiledPrefix : null
      for (let m = 0; m < M; m++) {
        if (m > 0 && isPastDeadline()) break
        if (m === 0 && !fixedStochPrefix && !hasAnyStochRaid && !cand.immediateRaidMeta) {
          // Stream 0 already ran identically in `evaluateTrunkPolicy(..., prngFactory: null)` when no stochastic raid used conservative trunk!
          sampleVals.push(cand.expectedValue)
          continue
        }
        const prngFactory = () => adapter.makeSampleStreamPrng(m, world0.now)
        if (cand.immediateRaidMeta?.evalRolloutFn) {
          sampleVals.push(cand.immediateRaidMeta.evalRolloutFn(prngFactory))
        } else if (fixedStochPrefix && b0 && !(cand.raidTransitionsByBucket?.[0]?.length > 0)) {
          const p0 = makePricesFn(scenarios[0])(b0, baseSoldByIsle)
          let wAt0 = adapter.advanceTimeOnly(world0, b0.atSec, { futurePrices: p0 })
          wAt0 = applyExogenousArrivals(wAt0, b0.exogenousArrivalsAtStart)
          const preSold = new Map()
          for (const [k, v] of baseSoldByIsle.entries()) preSold.set(k, { ...v })
          const preCash = []
          const bCoins = Number(wAt0.coins || 0)
          const simPref = adapter.simulateBatch(wAt0, fixedStochPrefix, {
            t: b0.atSec,
            prices: p0,
            rand: adapter.makeSampleStreamPrng(m * 997 + 1, world0.now),
          })
          const aCoins = Number(simPref.afterWorld.coins || 0)
          if (aCoins !== bCoins) preCash.push({ atSec: b0.atSec, netCashDelta: aCoins - bCoins })
          fixedStochPrefix.forEach((act, idx) => {
            if (act.a === 'sell' && simPref.result.out[idx]?.ok) {
              const sm = preSold.get(b0.isleIndex) || {}
              sm[act.id] = (sm[act.id] || 0) + Number(act.n || 0)
              preSold.set(b0.isleIndex, sm)
            }
          })
          const cont = evalContinuationFromPostPrefix(simPref.afterWorld, preCash, preSold, prngFactory, contMode, candRaids)
          sampleVals.push(cont.expectedValue)
        } else if (detPostPrefix) {
          const cont = evalContinuationFromPostPrefix(
            detPostPrefix.afterWorld,
            detPostPrefix.preCash,
            detPostPrefix.preSold,
            prngFactory,
            contMode,
            candRaids
          )
          sampleVals.push(cont.expectedValue)
        } else {
          let roll = evaluateTrunkPolicy(cand.policyMeta?.trunkPolicyMode || 'optimal', world0, world0, {
            customBuckets: cand.allBuckets || null,
            enableFirstBucketPlant: cand.policyMeta?.enableFirstBucketPlant ?? true,
            enableFirstBucketStockBuy: cand.policyMeta?.enableFirstBucketStockBuy ?? true,
            prngFactory,
            scheduledUpcomingRaids: candRaids,
          })
          if (roll.raidScheduleInfeasible && candRaids.length > 0) {
            roll = evaluateTrunkPolicy(cand.policyMeta?.trunkPolicyMode || 'optimal', world0, world0, {
              enableFirstBucketPlant: cand.policyMeta?.enableFirstBucketPlant ?? true,
              enableFirstBucketStockBuy: cand.policyMeta?.enableFirstBucketStockBuy ?? true,
              prngFactory,
            })
          }
          sampleVals.push(roll.expectedValue)
        }
      }

      const usedM = Math.max(1, sampleVals.length)
      let mean = 0
      for (let m = 0; m < usedM; m++) mean += sampleVals[m]
      mean /= usedM
      let sqSum = 0
      for (let m = 0; m < usedM; m++) {
        const d = sampleVals[m] - mean
        sqSum += d * d
      }
      const se = usedM > 1 ? Math.sqrt(sqSum / (usedM * (usedM - 1))) : 0
      const stats = {
        policyExpectedValue: mean,
        standardError: se,
        confidenceInterval95: [mean - 1.96 * se, mean + 1.96 * se],
        policySampleCount: usedM,
        valueInterpretation: usedM < M
          ? 'deadline-truncated-monte-carlo-expectation'
          : 'monte-carlo-policy-expectation',
      }
      if (usedM === M && !fastRankingMode) scoredPrefixCache.set(cacheKey, stats)
      Object.assign(cand, stats)
    }

    return cand
  }

  // Compare candidate trunk commitments (`optimal` vs `hold-in-first-bucket` vs `sell-all-now`)
  // AND candidate upstream add/drop variants (`with/without first-bucket plant & stockBuy`) strictly
  // by `cand.policyExpectedValue`!
  const hasImmediatePrefixStochastic = (cand) =>
    (cand.trunkActionsByBucket?.[0] || []).some((a) => adapter.isStochasticAction(a))

  const freeCashAtT0 = Math.max(0, Number(world0.coins || 0) - Number(constraints.cashReserveFloor || 0))
  const maxSeedPriceAtT0 = Math.max(0, ...(adapter.R.CROPS || []).map((c) => Number(c.seed || 0)))
  const maxCargoCostAtT0 = typeof adapter.R.b12Stock === 'function'
    ? adapter.R.b12Stock(world0.now, world0.prices || {}).reduce(
        (sumC, it) => sumC + Math.max(0, adapter.R.b12StockLeft(world0.state, it, world0.now)) * Math.max(0, Number(it.price || 0)),
        0
      )
    : 0
  const shopBombPriceAtT0 = utilityTokens.bombId
    ? Math.max(0, Number(adapter.R.SHOP?.[utilityTokens.bombId]?.price || 0))
    : 0
  const remCoffeeAtT0 = allowedSet.has('coffee')
    ? Math.max(0, (adapter.R.WORLD?.daily?.coffee || 3) - Number(world0.state?.cnt?.coffee || 0))
    : 0
  const remBombAtT0 = allowedSet.has('bomb')
    ? Math.max(
        0,
        (adapter.R.WORLD?.daily?.bomb || 10) -
          (world0.state?.iq?.d === buckets[0]?.isleIndex ? Number(world0.state?.iq?.bomb || 0) : 0)
      )
    : 0
  const maxFirstBucketCashDemand =
    (world0.state?.plotN || 0) * maxSeedPriceAtT0 +
    maxCargoCostAtT0 +
    remCoffeeAtT0 * (adapter.R.WORLD?.coffee?.price || 15000) +
    remBombAtT0 * shopBombPriceAtT0
  const isFirstBucketCashBindingPossible = freeCashAtT0 < maxFirstBucketCashDemand

  const candidateModes = buckets.length > 1 && allowedSet.has('sell')
    ? (isFirstBucketCashBindingPossible
        ? ['optimal', 'hold-in-first-bucket', 'sell-all-now']
        : ['optimal', 'hold-in-first-bucket'])
    : ['optimal']

  const sellableIdSet = new Set(adapter.graph.sellableIds)
  const hasAnySellableInvAtT0 = Object.entries(world0.state?.inv || {}).some(
    ([id, q]) => sellableIdSet.has(id) && Array.isArray(q) && ((q[0] || 0) + (q[1] || 0) + (q[2] || 0)) > 0
  )

  const getDomesticPrefixSig = (cand) => {
    const raidSig = (cand.scheduledUpcomingRaids || [])
      .map((r) => `${r.targetId}@${r.unlockAtSec}:${r.energyCost}`)
      .join('|')
    const b0 = cand.trunkBucketsUsed?.[0]
    const dom0 = cand.trunkActionsByBucket?.[0] || []
    if (!b0) return JSON.stringify({ k: 'full', meta: cand.policyMeta, acts: cand.trunkActionsByBucket, r: raidSig })
    const firstStochIdx = dom0.findIndex((a) => adapter.isStochasticAction(a))
    if (firstStochIdx >= 0) {
      const p0Tmp = makePricesFn(scenarios[0])(b0, baseSoldByIsle)
      let w0Tmp = adapter.advanceTimeOnly(world0, b0.atSec, { futurePrices: p0Tmp })
      w0Tmp = applyExogenousArrivals(w0Tmp, b0.exogenousArrivalsAtStart)
      const pref = computeCausalStochasticPrefix(adapter, w0Tmp, dom0, adapter.R.WORLD?.maxActions || 40).prefix
      return JSON.stringify({ k: 'pref', pref, r: raidSig })
    }
    const contMode = cand.policyMeta?.trunkPolicyMode === 'hold-in-first-bucket' ? 'hold-in-first-bucket' : 'optimal'
    return JSON.stringify({ k: 'det0', contMode, pref: dom0, r: raidSig })
  }

  let bestDomestic = null
  let bestDomPrefixSig = null
  for (const mode of candidateModes) {
    if (bestDomestic && isPastDeadline()) break
    if (mode === 'hold-in-first-bucket' && bestDomestic) {
      const optActs0 = bestDomestic.trunkActionsByBucket?.[0] || []
      const b0Opt = bestDomestic.trunkBucketsUsed?.[0]
      let execActs0 = optActs0
      if (b0Opt && optActs0.some((a) => adapter.isStochasticAction(a))) {
        const p0Opt = makePricesFn(scenarios[0])(b0Opt, baseSoldByIsle)
        let w0Opt = adapter.advanceTimeOnly(world0, b0Opt.atSec, { futurePrices: p0Opt })
        w0Opt = applyExogenousArrivals(w0Opt, b0Opt.exogenousArrivalsAtStart)
        execActs0 = computeCausalStochasticPrefix(adapter, w0Opt, optActs0, adapter.R.WORLD?.maxActions || 40).prefix
      }
      if (!execActs0.some((a) => a.a === 'sell')) continue
    }
    if (mode === 'sell-all-now' && bestDomestic && !hasAnySellableInvAtT0) {
      const optActs0 = bestDomestic.trunkActionsByBucket?.[0] || []
      if (!optActs0.some((a) => a.a === 'harvest' || a.a === 'collect' || a.a === 'stockBuy')) continue
    }
    const rawCand = evaluateTrunkPolicy(mode, world0, world0)
    const candSig = getDomesticPrefixSig(rawCand)
    if (!bestDomestic) {
      bestDomestic = rawCand
      bestDomPrefixSig = candSig
      continue
    }
    if (candSig === bestDomPrefixSig) continue
    if (hasImmediatePrefixStochastic(bestDomestic) || hasImmediatePrefixStochastic(rawCand)) {
      if (bestDomestic.valueInterpretation == null) scoreDomesticCandidate(bestDomestic)
      scoreDomesticCandidate(rawCand)
    }
    if (rawCand.policyExpectedValue > bestDomestic.policyExpectedValue + 1e-6) {
      bestDomestic = rawCand
      bestDomPrefixSig = candSig
    }
  }

  const firstBucketActs0 = bestDomestic.trunkActionsByBucket[0] || []
  const usedPlant0 = firstBucketActs0.some((a) => a.a === 'plant')
  const usedStockBuy0 = firstBucketActs0.some((a) => a.a === 'stockBuy')
  const sameIsleNextBucket = buckets.length <= 1 || buckets[1]?.isleIndex === buckets[0]?.isleIndex
  const canUpstreamBind = isFirstBucketCashBindingPossible || !sameIsleNextBucket

  const upstreamVariants = []
  if (canUpstreamBind) {
    if (usedPlant0) upstreamVariants.push({ enableFirstBucketPlant: false, enableFirstBucketStockBuy: true })
    if (usedStockBuy0) upstreamVariants.push({ enableFirstBucketPlant: true, enableFirstBucketStockBuy: false })
    if (usedPlant0 && usedStockBuy0) upstreamVariants.push({ enableFirstBucketPlant: false, enableFirstBucketStockBuy: false })
  }
  for (const uv of upstreamVariants) {
    if (isPastDeadline()) break
    const rawCand = evaluateTrunkPolicy('optimal', world0, world0, uv)
    const candSig = getDomesticPrefixSig(rawCand)
    if (candSig === bestDomPrefixSig) continue
    if (bestDomestic && bestDomestic.valueInterpretation == null) {
      scoreDomesticCandidate(bestDomestic)
    }
    const cand = scoreDomesticCandidate(rawCand)
    if (cand.policyExpectedValue > bestDomestic.policyExpectedValue + 1e-6) {
      bestDomestic = cand
      bestDomPrefixSig = candSig
    }
  }

  // Ensure the selected winning domestic candidate ALWAYS carries full stochastic policy expectation & SE metadata!
  if (bestDomestic && bestDomestic.valueInterpretation == null && !options.skipPostSelectionScoring) {
    scoreDomesticCandidate(bestDomestic)
  }

  // Unified Steal Raid Horizon & Executable Schedule (`v1.4.3`):
  // - Ready (`t = t0`) and Upcoming (`t > t0`) neighbor raids enter ONE unified candidate pool `R_all`.
  // - Candidate subsets `C ⊆ R_all` (`∅`, ready-only, upcoming-only, and ready + upcoming) are compared
  //   on the EXACT SAME full-trajectory objective (`policyExpectedValue`) with shared stamina, rations,
  //   thief-buff durations, cash, and workshop capacities — eliminating `selectedVisits.length === 0` gating!
  // - Outputs explicit `plan.raidSchedule` (`evaluatedTargetIds`, `committedRaids`, `plannedPrepActs`,
  //   `tacticalDecision`, `optimalLoadout`, `preconditions`) for `SnipeScheduler`.
  const evaluatedTargetIdSet = new Set()
  let raidEvalTruncatedByDeadline = false

  const regenEveryPlan0 = adapter.R.WORLD?.regen || 180
  const refWorldAt0 = adapter.advanceTimeOnly(world0, world0.now, { futurePrices: world0.prices || {} })
  const plannedAtEnT0 = Math.max(world0.now - regenEveryPlan0, Math.floor(Number(refWorldAt0.state?.enT ?? world0.now)))

  const selectedVisits = []
  let raidPrepActs = []
  let raidAdjustedDomestic = bestDomestic
  let committedRaids = []
  let committedUpcomingRaids = []

  if (
    allowedSet.has('visit') &&
    constraints.maxStealsPerIsleDay !== 0 &&
    ((envelope.beliefs?.visitBeliefs?.length || 0) > 0 || (envelope.beliefs?.upcomingVisitBeliefs?.length || 0) > 0)
  ) {
    if (isPastDeadline()) {
      raidEvalTruncatedByDeadline = true
    } else {
    const isle0 = adapter.R.isleIndex(world0.now)
    const maxPerIsleSteal = constraints.maxStealsPerIsleDay == null
      ? Infinity
      : Math.max(0, Number(constraints.maxStealsPerIsleDay))
    const remIsle0StealBudget = constraints.maxStealsPerIsleDay == null
      ? Infinity
      : Math.max(0, maxPerIsleSteal - Number(envelope.reservedBudgets?.stealUsedOrReservedThisIsleDay || 0))
    const minSpots = Number(options.minStealSpots ?? constraints.minStealSpots ?? 0)

    const rawReady = remIsle0StealBudget > 0
      ? (envelope.beliefs?.visitBeliefs || [])
          .filter((b) => b && b.targetId != null && Number(b.totalSpots || 0) > 0 && Number(b.totalSpots || 0) >= minSpots)
          .map((b) => ({
            ...b,
            unlockAtSec: world0.now,
            isImmediate: true,
            exactUnlockKnown: true,
            _rawNeighborTarget: options.rawNeighborTargetsById?.get(b.targetId) || null,
          }))
      : []

    const rawUpcoming = (envelope.beliefs?.upcomingVisitBeliefs || [])
      .filter(
        (b) =>
          b &&
          b.targetId != null &&
          Number.isFinite(Number(b.unlockAtSec)) &&
          Math.floor(Number(b.unlockAtSec)) > world0.now &&
          Math.floor(Number(b.unlockAtSec)) <= tHorizonEnd &&
          Number(b.totalSpots || 0) > 0 &&
          Number(b.totalSpots || 0) >= minSpots
      )
      .map((b) => ({
        ...b,
        unlockAtSec: Math.floor(Number(b.unlockAtSec)),
        isImmediate: false,
        exactUnlockKnown: Boolean(b.exactUnlockKnown),
      }))

    // Pre-filter gross-positive raid candidates (zero stamina/food cost subtracted; discrete integer outcomes only!)
    const baseEnForGross = bestDomestic.marginalContext?.baseWorldEn0 ?? Number(world0.state?.en || 0)
    const evalCandidateGross = (candBelief) => {
      const unlockSec = Math.floor(Number(candBelief.unlockAtSec))
      const iIdx = adapter.R.isleIndex(unlockSec)
      if ((iIdx === isle0 ? remIsle0StealBudget : maxPerIsleSteal) <= 0) return -Infinity
      const wAtUnlock = unlockSec > world0.now
        ? adapter.advanceTimeOnly(world0, unlockSec, { futurePrices: world0.prices || {} })
        : refWorldAt0
      const buffCombos = buildThiefBuffCombinations(adapter, wAtUnlock, constraints, allowedSet)
      let bestGrossDelta = -Infinity
      for (const buffCombo of buffCombos) {
        let wCand = wAtUnlock
        let buffCost = 0
        if (buffCombo.length > 0) {
          buffCost = buffCombo.reduce((sAcc, a) => sAcc + Number(adapter.R.THIEF_ITEMS?.[a.id]?.price || 0), 0)
          if (Number(wAtUnlock.coins || 0) - Number(constraints.cashReserveFloor || 0) < buffCost) continue
          const simB = adapter.simulateBatch(wAtUnlock, buffCombo, { t: unlockSec, prices: world0.prices || {} })
          if (!simB.allOk) continue
          wCand = simB.afterWorld
        }
        const tr = computeExpectedRaidTransition(adapter, candBelief, wCand, null)
        if (!(tr.energyCost > 0) || !(tr.belief?.totalSpots > 0)) continue
        let grossDelta = 0
        if (bestDomestic.marginalContext) {
          for (const out of tr.distribution?.outcomes || []) {
            if (!(out.prob > 1e-9)) continue
            grossDelta += out.prob * evaluateMarginalRaidDelta(adapter, bestDomestic.marginalContext, {
              invDeltaById: addBagToInvDelta({}, out.lootBag),
              postRaidEn: baseEnForGross,
              cashSpent: Number(out.fineCoins || 0) + buffCost,
            })
          }
        } else {
          for (const out of tr.distribution?.outcomes || []) {
            if (!(out.prob > 1e-9)) continue
            const rawLootVal = Object.entries(out.lootBag || {}).reduce(
              (acc, [id, q0]) => acc + q0 * Math.max(Number(world0.prices?.[id] || 0), Number(adapter.R.BASE_PRICE?.[id] || 0)),
              0
            )
            grossDelta += out.prob * (rawLootVal - Number(out.fineCoins || 0) - buffCost)
          }
        }
        if (grossDelta > bestGrossDelta) bestGrossDelta = grossDelta
      }
      return bestGrossDelta
    }

    const grossReady = []
    for (const rb of rawReady) {
      const g = evalCandidateGross(rb)
      if (g > 1e-6) grossReady.push({ belief: rb, grossDelta: g })
    }
    const grossUpcoming = []
    for (const ub of rawUpcoming) {
      const g = evalCandidateGross(ub)
      if (g > 1e-6) grossUpcoming.push({ belief: ub, grossDelta: g })
    }

    const sortByGrossDesc = (a, b) =>
      (b.grossDelta - a.grossDelta) ||
      (a.belief.unlockAtSec - b.belief.unlockAtSec) ||
      (Number(a.belief.targetId) - Number(b.belief.targetId))
    grossReady.sort(sortByGrossDesc)
    grossUpcoming.sort(sortByGrossDesc)

    // Balanced pool up to K = 5 preserving top ready AND top upcoming options (and multi-wave targets) so they compete directly!
    const pickedPool = []
    const pushUniqueCand = (item) => {
      if (!item || pickedPool.length >= 5) return
      const key = `${item.belief.targetId}@${item.belief.unlockAtSec}:${item.belief.isImmediate ? 1 : 0}`
      if (pickedPool.some((x) => `${x.belief.targetId}@${x.belief.unlockAtSec}:${x.belief.isImmediate ? 1 : 0}` === key)) return
      pickedPool.push(item)
    }
    for (let i = 0; i < Math.min(2, grossReady.length); i++) pushUniqueCand(grossReady[i])
    for (let i = 0; i < Math.min(2, grossUpcoming.length); i++) pushUniqueCand(grossUpcoming[i])
    for (const rem of [...grossReady.slice(2), ...grossUpcoming.slice(2)].sort(sortByGrossDesc)) {
      if (pickedPool.length >= 5) break
      pushUniqueCand(rem)
    }

    if (pickedPool.length > 0) {
      pickedPool.sort((a, b) =>
        (a.belief.unlockAtSec - b.belief.unlockAtSec) ||
        ((a.belief.isImmediate ? 0 : 1) - (b.belief.isImmediate ? 0 : 1)) ||
        (b.grossDelta - a.grossDelta) ||
        (Number(a.belief.targetId) - Number(b.belief.targetId))
      )
      const K = pickedPool.length
      const minWaveGapSec = Math.max(15, minGapSec)
      const candidateSubsets = []
      for (let mask = 1; mask < (1 << K); mask++) {
        const sub = []
        let grossSum = 0
        let validSub = true
        const ownerDayCount = new Map()
        const lastNonImmSecByOwner = new Map()
        const perIsleUsed = new Map()
        for (let bit = 0; bit < K; bit++) {
          if (!(mask & (1 << bit))) continue
          const item = pickedPool[bit]
          const r = item.belief
          const natDay = adapter.R.worldDay(r.unlockAtSec)
          const ownerDayKey = `${r.targetId}:${natDay}`
          const ownerWaveCap = Math.min(3, Math.max(1, Math.floor(Number(r.ownerLeft ?? 1))))
          const nextOwnerCnt = (ownerDayCount.get(ownerDayKey) || 0) + 1
          if (nextOwnerCnt > ownerWaveCap) {
            validSub = false
            break
          }
          ownerDayCount.set(ownerDayKey, nextOwnerCnt)
          if (!r.isImmediate) {
            const prevSec = lastNonImmSecByOwner.get(r.targetId)
            if (prevSec != null && r.unlockAtSec - prevSec < minWaveGapSec) {
              validSub = false
              break
            }
            lastNonImmSecByOwner.set(r.targetId, r.unlockAtSec)
          }
          const rIsle = adapter.R.isleIndex(r.unlockAtSec)
          const nextIsleUsed = (perIsleUsed.get(rIsle) || 0) + 1
          const capIsle = rIsle === isle0 ? remIsle0StealBudget : maxPerIsleSteal
          if (nextIsleUsed > capIsle) {
            validSub = false
            break
          }
          perIsleUsed.set(rIsle, nextIsleUsed)
          sub.push({ ...r, _grossDelta: item.grossDelta })
          grossSum += item.grossDelta
        }
        if (validSub && sub.length > 0) {
          candidateSubsets.push({ sub, grossSum })
        }
      }
      candidateSubsets.sort((a, b) => b.grossSum - a.grossSum || a.sub.length - b.sub.length)

      let winningRaidCand = bestDomestic
      const baseModeForSub = bestDomestic.policyMeta?.trunkPolicyMode || 'optimal'
      const modesToTry = baseModeForSub !== 'optimal' ? ['optimal', baseModeForSub] : ['optimal']
      const t0BuffCombos = buildThiefBuffCombinations(adapter, refWorldAt0, constraints, allowedSet)

      // Fast chronological raid-resource timeline ranking via `bestDomestic.marginalContext` (`v1.4.4`):
      // Scores all `<= 31` subsets in ~50-150ms and promotes only top `1-2` finalists to full `evaluateTrunkPolicy`.
      const mCtx = bestDomestic.marginalContext || null
      let finalistsToVerify = []
      if (!mCtx) {
        finalistsToVerify = candidateSubsets.slice(0, 3).map((cs) => ({
          sub: cs.sub,
          fastNetDelta: cs.grossSum,
          rankedBuffCombos0: t0BuffCombos.slice(0, 2),
        }))
      } else {
        const marginalStateMemo = new Map()
        const canonicalInvDeltaKey = (invDeltaMap) => {
          const keys = Object.keys(invDeltaMap || {}).sort()
          if (keys.length === 0) return ''
          const parts = []
          for (const k of keys) {
            const v = invDeltaMap[k]
            if (Array.isArray(v)) {
              if (v[0] || v[1] || v[2]) parts.push(`${k}:${v[0] | 0},${v[1] | 0},${v[2] | 0}`)
            } else if (v) {
              parts.push(`${k}:${v}`)
            }
          }
          return parts.join('|')
        }
        const evalLeafMarginal = (postRaidEnVal, coffeeUsedVal, invDeltaMap) => {
          const key = `${postRaidEnVal}:${coffeeUsedVal}:${canonicalInvDeltaKey(invDeltaMap)}`
          let hit = marginalStateMemo.get(key)
          if (hit === undefined) {
            hit = evaluateMarginalRaidDelta(adapter, mCtx, {
              invDeltaById: invDeltaMap,
              postRaidEn: postRaidEnVal,
              cashSpent: 0,
              coffeeUsedInPrep: coffeeUsedVal,
            })
            marginalStateMemo.set(key, hit)
          }
          return hit
        }

        const cpeLookup = new Map()
        for (const uIt of mCtx.u0MarginalStaminaMeta?.topUpUnits || []) {
          if (uIt.kind === 'eat') {
            cpeLookup.set(`${uIt.id}:${uIt.q ?? 0}`, uIt.cpe)
          }
        }
        const fastTopUpPool = []
        const { R } = adapter
        const sRef = refWorldAt0.state || {}
        const rawEnMax0 = Number(R.energyMax(sRef))
        const enMaxFast = Number.isFinite(rawEnMax0) && rawEnMax0 > 0 ? rawEnMax0 : 100
        const regenFast = R.WORLD?.regen || 180
        const freeCoinsInit = Math.max(0, Number(refWorldAt0.coins || 0) - Number(constraints.cashReserveFloor || 0))
        if (allowedSet.has('eat')) {
          if (utilityTokens.snackId && R.B12_SNACK) {
            const qty = adapter.availableInv(sRef, utilityTokens.snackId, 0)
            if (qty > 0 && R.B12_SNACK.energy > 0) {
              fastTopUpPool.push({
                kind: 'snack',
                id: utilityTokens.snackId,
                q: 0,
                qty,
                dailyCap: R.B12_SNACK.daily,
                usedDay0: Number(sRef.cnt?.[utilityTokens.snackId] || 0),
                energyGain: R.B12_SNACK.energy,
                cashCost: 0,
                cpe: 0,
              })
            }
          }
          for (const crop of R.CROPS || []) {
            if (!(crop.eat > 0)) continue
            for (let q = 0; q < 3; q++) {
              const qty = adapter.availableInv(sRef, crop.id, q)
              if (qty <= 0) continue
              const gain = Math.round(crop.eat * (R.QUALITY?.[q] ?? 1))
              if (gain <= 0) continue
              const estCpe = cpeLookup.get(`${crop.id}:${q}`)
                ?? ((Number(refWorldAt0.prices?.[crop.id] || R.BASE_PRICE?.[crop.id] || 0) * (R.QUALITY?.[q] ?? 1)) / gain)
              fastTopUpPool.push({
                kind: 'crop',
                id: crop.id,
                q,
                qty,
                dailyCap: null,
                usedDay0: 0,
                energyGain: gain,
                cashCost: 0,
                cpe: estCpe,
              })
            }
          }
          if (allowedSet.has('stockBuy') && typeof R.b12Stock === 'function') {
            const cargoItems = R.b12Stock(refWorldAt0.now, refWorldAt0.prices || {})
            for (const cIt of cargoItems) {
              const left = Math.max(0, R.b12StockLeft(sRef, cIt, refWorldAt0.now))
              if (!(cIt.price > 0) || left <= 0) continue
              if (utilityTokens.snackId && cIt.id === utilityTokens.snackId && R.B12_SNACK) {
                if (R.B12_SNACK.energy > 0) {
                  fastTopUpPool.push({
                    kind: 'cargo-snack',
                    id: cIt.id,
                    q: 0,
                    qty: left,
                    dailyCap: R.B12_SNACK.daily,
                    usedDay0: Number(sRef.cnt?.[cIt.id] || 0),
                    energyGain: R.B12_SNACK.energy,
                    cashCost: cIt.price,
                    cpe: cIt.price / R.B12_SNACK.energy,
                  })
                }
              } else {
                const cropDef = (R.CROPS || []).find((c) => c.id === cIt.id)
                if (cropDef && cropDef.eat > 0) {
                  const g = Math.round(cropDef.eat * (R.QUALITY?.[0] ?? 1))
                  if (g > 0) {
                    fastTopUpPool.push({
                      kind: 'cargo-crop',
                      id: cIt.id,
                      q: 0,
                      qty: left,
                      dailyCap: null,
                      usedDay0: 0,
                      energyGain: g,
                      cashCost: cIt.price,
                      cpe: cIt.price / g,
                    })
                  }
                }
              }
            }
          }
        }
        if (allowedSet.has('coffee')) {
          const coffeePrice = R.WORLD?.coffee?.price || 15000
          const coffeeEn = R.WORLD?.coffee?.energy || 60
          if (coffeeEn > 0) {
            fastTopUpPool.push({
              kind: 'coffee',
              id: 'coffee',
              q: null,
              qty: 999,
              dailyCap: R.WORLD?.daily?.coffee || 3,
              usedDay0: Number(sRef.cnt?.coffee || 0),
              energyGain: coffeeEn,
              cashCost: coffeePrice,
              cpe: coffeePrice / coffeeEn,
            })
          }
        }
        fastTopUpPool.sort((a, b2) => (a.cpe - b2.cpe) || (a.cashCost - b2.cashCost))

        const transCache = new Map()
        const getCachedRaidTrans = (rBelief, buffCombo) => {
          const buffSig = buffCombo.map((a) => a.id).sort().join(',')
          const tKey = `${rBelief.targetId}@${rBelief.unlockAtSec}:${rBelief.isImmediate ? 1 : 0}|${buffSig}`
          let hit = transCache.get(tKey)
          if (hit !== undefined) return hit
          const atSec = Math.floor(Number(rBelief.unlockAtSec))
          let wAtR = atSec > world0.now
            ? adapter.advanceTimeOnly(world0, atSec, { futurePrices: world0.prices || {} })
            : refWorldAt0
          if (buffCombo.length > 0) {
            const simB = adapter.simulateBatch(wAtR, buffCombo, { t: atSec, prices: world0.prices || {} })
            if (!simB.allOk) {
              hit = null
              transCache.set(tKey, hit)
              return hit
            }
            wAtR = simB.afterWorld
          }
          const tr = computeExpectedRaidTransition(adapter, rBelief, wAtR, null)
          hit = (tr.energyCost > 0 && tr.belief?.totalSpots > 0) ? tr : null
          transCache.set(tKey, hit)
          return hit
        }

        const mergeInventory = (aInv, lootBag) => {
          const outInv = {}
          for (const [k, v] of Object.entries(aInv || {})) {
            outInv[k] = Array.isArray(v) ? [v[0] || 0, v[1] || 0, v[2] || 0] : Number(v || 0)
          }
          for (const [id, qVal] of Object.entries(lootBag || {})) {
            if (!(qVal > 0)) continue
            if (!outInv[id]) outInv[id] = [0, 0, 0]
            outInv[id][0] += qVal
          }
          return outInv
        }

        const evaluateRaidSubsetFastTimeline = (sub) => {
          const buffScores = []
          const firstSec = Math.floor(Number(sub[0].unlockAtSec))
          const day0 = R.worldDay(world0.now)
          const isleDayInit = R.isleDay(world0.now)
          const discRate = objectiveCfg.discountRatePerHour || 0
          const firstDisc = discountFactor(discRate, Math.max(0, firstSec - world0.now))

          for (const buffCombo0 of t0BuffCombos) {
            const buffCost0 = buffCombo0.reduce((sA, a) => sA + Number(R.THIEF_ITEMS?.[a.id]?.price || 0), 0)
            if (freeCoinsInit < buffCost0) continue

            let freeCoinsRem = freeCoinsInit - buffCost0
            let cashSpentRaw = buffCost0
            let cashSpentDisc = buffCost0 * firstDisc
            let en = Math.max(0, Math.floor(Number(refWorldAt0.state?.en || 0)))
            let enT = plannedAtEnT0
            let curDay = day0
            let curIsleDay = isleDayInit
            const usedToday = new Map()
            const remCounts = fastTopUpPool.map((p) => p.qty)
            let isle0AddedPrepEn = 0
            let isle0RaidEnSpent = 0
            let coffeeUsedIsle0 = 0
            let ensemble = [{ prob: 1, invDelta: {}, expFine: 0 }]
            let feasible = true

            for (let ri = 0; ri < sub.length; ri++) {
              const r = sub[ri]
              const atSec = Math.floor(Number(r.unlockAtSec))
              const rDay = R.worldDay(atSec)
              const rIsleDay = R.isleDay(atSec)
              const rIsle = R.isleIndex(atSec)
              const rDisc = discountFactor(discRate, Math.max(0, atSec - world0.now))

              // Active buffs bought at `sub[0]` apply within 24h (`86400s`)
              const activeBuffsHere = (atSec - firstSec < 86400) ? buffCombo0 : []
              const tr = getCachedRaidTrans(r, activeBuffsHere)
              if (!tr) {
                feasible = false
                break
              }

              if (rDay !== curDay) {
                curDay = rDay
                usedToday.clear()
              }
              if (rIsleDay !== curIsleDay) {
                curIsleDay = rIsleDay
              }

              const adv = advanceScalarStamina(en, enT, enMaxFast, regenFast, atSec)
              en = adv.en
              enT = adv.enT

              while (en < tr.energyCost) {
                let pickedIdx = -1
                let bestEffCpe = Infinity
                for (let pi = 0; pi < fastTopUpPool.length; pi++) {
                  const p = fastTopUpPool[pi]
                  if (remCounts[pi] <= 0) continue
                  if (p.cashCost > 0 && freeCoinsRem < p.cashCost) continue
                  if (p.kind !== 'coffee' && en >= enMaxFast) continue
                  if (p.dailyCap != null) {
                    const baseUsed = curDay === day0 ? p.usedDay0 : 0
                    const extraUsed = usedToday.get(p.id) || 0
                    if (baseUsed + extraUsed >= p.dailyCap) continue
                  }
                  const gain = p.kind === 'coffee' ? p.energyGain : Math.min(enMaxFast - en, p.energyGain)
                  if (gain <= 0) continue
                  const effCpe = p.cashCost > 0 ? (p.cashCost * rDisc) / gain : (p.cpe * (p.energyGain / gain))
                  if (effCpe < bestEffCpe - 1e-9) {
                    bestEffCpe = effCpe
                    pickedIdx = pi
                    if (effCpe <= 0) break
                  }
                }
                if (pickedIdx < 0) {
                  feasible = false
                  break
                }
                const p = fastTopUpPool[pickedIdx]
                const gain = p.kind === 'coffee' ? p.energyGain : Math.min(enMaxFast - en, p.energyGain)
                en += gain
                remCounts[pickedIdx] -= 1
                if (p.dailyCap != null) usedToday.set(p.id, (usedToday.get(p.id) || 0) + 1)
                if (p.cashCost > 0) {
                  freeCoinsRem -= p.cashCost
                  cashSpentRaw += p.cashCost
                  cashSpentDisc += p.cashCost * rDisc
                } else if (p.kind === 'crop' || p.kind === 'snack') {
                  for (const br of ensemble) {
                    if (!br.invDelta[p.id]) br.invDelta[p.id] = [0, 0, 0]
                    br.invDelta[p.id][p.q] -= 1
                  }
                }
                if (rIsle === isle0) {
                  isle0AddedPrepEn += gain
                  if (p.kind === 'coffee') coffeeUsedIsle0 += 1
                }
              }
              if (!feasible) break

              en -= tr.energyCost
              if (rIsle === isle0) isle0RaidEnSpent += tr.energyCost

              const outs = (tr.distribution?.outcomes || [{ kind: 'undetected', prob: 1, lootBag: {}, fineCoins: 0 }])
                .filter((o) => o.prob > 1e-9)
              const mergedMap = new Map()
              const availCoinsForFine = Math.max(0, Number(refWorldAt0.coins || 0) - cashSpentRaw)
              for (const br of ensemble) {
                for (const out of outs) {
                  const pBr = br.prob * out.prob
                  if (!(pBr > 1e-9)) continue
                  const nextInv = Object.keys(out.lootBag || {}).length > 0
                    ? mergeInventory(br.invDelta, out.lootBag)
                    : br.invDelta
                  const fineHere = Math.min(availCoinsForFine, Math.max(0, Number(out.fineCoins || 0))) * rDisc
                  const expFineNext = br.expFine + fineHere
                  const mKey = canonicalInvDeltaKey(nextInv)
                  const prev = mergedMap.get(mKey)
                  if (!prev) {
                    mergedMap.set(mKey, { prob: pBr, invDelta: nextInv, expFine: expFineNext })
                  } else {
                    const totP = prev.prob + pBr
                    prev.expFine = (prev.expFine * prev.prob + expFineNext * pBr) / totP
                    prev.prob = totP
                  }
                }
              }
              let nextEnsemble = [...mergedMap.values()].sort((a, b2) => b2.prob - a.prob)
              if (nextEnsemble.length > 6) {
                const kept = nextEnsemble.slice(0, 5)
                const tail = nextEnsemble.slice(5)
                let tailP = 0
                let tailFine = 0
                for (const tb of tail) {
                  tailP += tb.prob
                  tailFine += tb.prob * tb.expFine
                }
                kept.push({
                  prob: tailP,
                  invDelta: tail[0].invDelta,
                  expFine: tailP > 0 ? tailFine / tailP : 0,
                })
                nextEnsemble = kept
              }
              ensemble = nextEnsemble
            }

            if (!feasible) continue
            const baseWorldEn = Number(mCtx.baseWorldEn0 ?? refWorldAt0.state?.en ?? 0)
            const effPostRaidEn0 = Math.max(0, Math.round(baseWorldEn + isle0AddedPrepEn - isle0RaidEnSpent))
            let expectedFastVal = -cashSpentDisc
            for (const br of ensemble) {
              const leafDelta = evalLeafMarginal(effPostRaidEn0, coffeeUsedIsle0, br.invDelta)
              expectedFastVal += br.prob * (leafDelta - br.expFine)
            }
            buffScores.push({ buffCombo: buffCombo0, fastNetDelta: expectedFastVal })
          }

          if (buffScores.length === 0) {
            return { sub, fastNetDelta: -Infinity, rankedBuffCombos0: [] }
          }
          buffScores.sort((a, b2) => b2.fastNetDelta - a.fastNetDelta)
          return {
            sub,
            fastNetDelta: buffScores[0].fastNetDelta,
            rankedBuffCombos0: buffScores.map((x) => x.buffCombo),
          }
        }

        const fastRankedAll = []
        for (const { sub } of candidateSubsets) {
          if (isPastDeadline()) {
            raidEvalTruncatedByDeadline = true
            break
          }
          const evSub = evaluateRaidSubsetFastTimeline(sub)
          if (Number.isFinite(evSub.fastNetDelta)) {
            fastRankedAll.push(evSub)
          }
        }
        fastRankedAll.sort((a, b) => b.fastNetDelta - a.fastNetDelta)

        const remBudgetMs = Number.isFinite(deadlineAtMs) ? Math.max(0, deadlineAtMs - nowMsFn()) : Infinity
        const positiveRanked = fastRankedAll.filter((x) => x.fastNetDelta > 1e-6)
        if (positiveRanked.length > 0) {
          finalistsToVerify = positiveRanked
        } else if (fastRankedAll.length > 0 && fastRankedAll[0].fastNetDelta > -150 && remBudgetMs > 6000) {
          finalistsToVerify = [fastRankedAll[0]]
        }
      }

      const remBudgetStartMs = Number.isFinite(deadlineAtMs) ? Math.max(0, deadlineAtMs - nowMsFn()) : Infinity
      const maxFinalists = (finalistsToVerify.length >= 2 && (finalistsToVerify[0].fastNetDelta - finalistsToVerify[1].fastNetDelta > 1500 || remBudgetStartMs < 5000))
        ? 1
        : 2
      let verifiedFeasibleCount = 0
      let verifiedAttemptCount = 0

      for (const finalist of finalistsToVerify) {
        if (verifiedFeasibleCount >= maxFinalists || verifiedAttemptCount >= 3) break
        if (isPastDeadline()) {
          raidEvalTruncatedByDeadline = true
          break
        }
        verifiedAttemptCount++
        const { sub, rankedBuffCombos0 } = finalist
        let subVerifiedFeasible = false
        const immSub = sub
          .filter((r) => r.isImmediate)
          .sort((a, b) => (b._grossDelta - a._grossDelta) || (Number(a.targetId) - Number(b.targetId)))
        const futSub = sub
          .filter((r) => !r.isImmediate)
          .sort((a, b) => (a.unlockAtSec - b.unlockAtSec) || (Number(a.targetId) - Number(b.targetId)))

        if (immSub.length === 0) {
          // Upcoming-only subset `futSub` (`t > t0`):
          const candBuckets = buildEventBuckets(adapter, world0, {
            horizonSec: objectiveCfg.horizonSec,
            deterministicArrivals: options.deterministicArrivals || [],
            upcomingRaidSecs: futSub.map((r) => Number(r.unlockAtSec)),
            maxBuckets: (options.maxBuckets || 16) + futSub.length,
            coalesceWindowSec: options.coalesceWindowSec ?? 5,
            preservePrefixThroughSec: options.preservePrefixThroughSec ?? null,
            prefixMaxBuckets: options.prefixMaxBuckets != null ? options.prefixMaxBuckets + futSub.length : null,
          }).buckets

          for (const mTry of modesToTry) {
            if (isPastDeadline()) break
            const rawCand = evaluateTrunkPolicy(mTry, world0, world0, {
              customBuckets: candBuckets,
              enableFirstBucketPlant: bestDomestic.policyMeta?.enableFirstBucketPlant ?? true,
              enableFirstBucketStockBuy: bestDomestic.policyMeta?.enableFirstBucketStockBuy ?? true,
              scheduledUpcomingRaids: futSub,
            })
            if (rawCand.raidScheduleInfeasible) continue
            subVerifiedFeasible = true
            const hasStochRaidHere = Boolean((rawCand.raidTransitionsFlat || []).some((tr) => tr?.distribution?.isStochastic))
            if (
              hasStochRaidHere ||
              hasImmediatePrefixStochastic(winningRaidCand) ||
              hasImmediatePrefixStochastic(rawCand) ||
              winningRaidCand.immediateRaidMeta
            ) {
              if (winningRaidCand.valueInterpretation == null) scoreDomesticCandidate(winningRaidCand)
              scoreDomesticCandidate(rawCand)
            }
            if (rawCand.policyExpectedValue > winningRaidCand.policyExpectedValue + 1e-6) {
              winningRaidCand = rawCand
            }
          }
        } else {
          // Subset includes immediate `t0` raid(s) `immSub` (plus `0` or more upcoming raids `futSub`):
          const buffCombosToTry = (rankedBuffCombos0 && rankedBuffCombos0.length > 0)
            ? rankedBuffCombos0.slice(0, 2)
            : t0BuffCombos.slice(0, 2)
          for (const buffCombo of buffCombosToTry) {
            if (isPastDeadline()) break
            let wAfterBuff0 = refWorldAt0
            if (buffCombo.length > 0) {
              const buffCost0 = buffCombo.reduce((sAcc, a) => sAcc + Number(adapter.R.THIEF_ITEMS?.[a.id]?.price || 0), 0)
              if (Number(refWorldAt0.coins || 0) - Number(constraints.cashReserveFloor || 0) < buffCost0) continue
              const stepB = adapter.simulateBatch(refWorldAt0, buffCombo, { t: world0.now, prices: world0.prices || {} })
              if (!stepB.allOk) continue
              wAfterBuff0 = stepB.afterWorld
            }

            const immTransList = []
            let immValid = true
            let totalImmEn = 0
            for (const immR of immSub) {
              const tr = computeExpectedRaidTransition(adapter, immR, wAfterBuff0, null)
              if (!(tr.energyCost > 0) || !(tr.belief?.totalSpots > 0)) {
                immValid = false
                break
              }
              totalImmEn += tr.energyCost
              immTransList.push({ raid: immR, trans: tr })
            }
            if (!immValid) continue

            const prepRes0 = findCheapestRaidStaminaPrep(
              adapter,
              wAfterBuff0,
              totalImmEn,
              allowedSet,
              utilityTokens,
              constraints
            )
            if (!prepRes0.feasible) continue

            const fullPrepActs0 = [...buffCombo, ...prepRes0.prepActs]
            const prePrepEn0 = Math.max(0, Math.floor(Number(refWorldAt0.state?.en || 0)))
            let wAfterPrep0 = refWorldAt0
            let prepCashSpent0 = 0
            const prepCashEvents0 = []
            if (fullPrepActs0.length > 0) {
              const bC = Number(refWorldAt0.coins || 0)
              const simP = adapter.simulateBatch(refWorldAt0, fullPrepActs0, { t: world0.now, prices: world0.prices || {} })
              if (!simP.allOk) continue
              wAfterPrep0 = simP.afterWorld
              const aC = Number(wAfterPrep0.coins || 0)
              prepCashSpent0 = Math.max(0, bC - aC)
              if (aC !== bC) prepCashEvents0.push({ atSec: world0.now, netCashDelta: aC - bC })
            }
            const postPrepEn0 = Math.max(0, Math.floor(Number(wAfterPrep0.state?.en || 0)))
            if (postPrepEn0 < totalImmEn) continue

            const prepEnGrant0 = Math.max(0, postPrepEn0 - prePrepEn0)
            const reqEdMap0 = new Map()
            let coffeeCnt0 = 0
            for (const pa of prepRes0.prepActs) {
              if (pa.a === 'coffee') coffeeCnt0++
              else if (pa.a === 'eat') {
                const ek = `${pa.id}:${pa.q ?? 0}`
                reqEdMap0.set(ek, (reqEdMap0.get(ek) || 0) + 1)
              }
            }
            const reqEdibles0 = [...reqEdMap0.entries()].map(([k, count]) => {
              const [id, qRaw] = k.split(':')
              return { id, q: Number(qRaw || 0), count }
            })

            const tContRaid = Math.min(tHorizonEnd, world0.now + minGapSec)
            const remFutSub = futSub
              .filter((r) => Number(r.unlockAtSec) <= tHorizonEnd)
              .map((r) => (Number(r.unlockAtSec) < tContRaid ? { ...r, unlockAtSec: tContRaid } : r))

            const buildContBucketsAt = (wStart) =>
              (tContRaid < tHorizonEnd || objectiveCfg.horizonSec > 0)
                ? buildEventBuckets(adapter, wStart, {
                    horizonSec: Math.max(0, tHorizonEnd - wStart.now),
                    deterministicArrivals: remArrivalsAfterT0,
                    upcomingRaidSecs: remFutSub.map((r) => Number(r.unlockAtSec)),
                    maxBuckets: (options.maxBuckets || 16) + remFutSub.length,
                    coalesceWindowSec: options.coalesceWindowSec ?? 5,
                    preservePrefixThroughSec: options.preservePrefixThroughSec ?? null,
                    prefixMaxBuckets: options.prefixMaxBuckets != null ? options.prefixMaxBuckets + remFutSub.length : null,
                  }).buckets
                : []

            // Build conservative post-`immSub` trunk world (`guaranteedArrivals` + `worstCaseFineCoins`)
            let wTrunkImm = adapter.cloneWorld(wAfterPrep0)
            const trunkCash0 = [...prepCashEvents0]
            const immTransitions = []
            for (let idxImm = 0; idxImm < immTransList.length; idxImm++) {
              const { raid: immR, trans: tr } = immTransList[idxImm]
              wTrunkImm.state.en = Math.max(0, Math.floor(Number(wTrunkImm.state?.en || 0)) - tr.energyCost)
              if (tr.guaranteedArrivals.length > 0) {
                wTrunkImm = applyExogenousArrivals(wTrunkImm, tr.guaranteedArrivals)
              }
              const worstFine = Math.min(Math.max(0, Number(wTrunkImm.coins || 0)), tr.worstCaseFineCoins)
              if (worstFine > 0) {
                wTrunkImm.coins = Math.max(0, Number(wTrunkImm.coins || 0) - worstFine)
                trunkCash0.push({ atSec: world0.now, netCashDelta: -worstFine })
              }
              immTransitions.push({
                targetId: immR.targetId,
                targetName: tr.belief?.targetName || immR.targetName || String(immR.targetId),
                unlockAtSec: world0.now,
                isImmediate: true,
                exactUnlockKnown: true,
                atSec: world0.now,
                totalSpots: Number(tr.belief?.totalSpots || immR.totalSpots || 0),
                buffActs: idxImm === 0 ? buffCombo : [],
                staminaPrepActs: idxImm === 0 ? prepRes0.prepActs : [],
                prepAndBuffActs: idxImm === 0 ? fullPrepActs0 : [],
                preconditions: idxImm === 0
                  ? {
                      minEnBeforePrep: Math.max(0, totalImmEn - prepEnGrant0),
                      minCoinsBeforePrep: prepCashSpent0 > 0 ? Number(constraints.cashReserveFloor || 0) + prepCashSpent0 : 0,
                      coffeeCount: coffeeCnt0,
                      requiredEdibles: reqEdibles0,
                    }
                  : { minEnBeforePrep: tr.energyCost, minCoinsBeforePrep: 0, coffeeCount: 0, requiredEdibles: [] },
                energyCost: tr.energyCost,
                tacticalDecision: tr.belief?.tacticalDecision || immR.tacticalDecision || null,
                optimalLoadout: tr.belief?.optimalLoadout || immR.optimalLoadout || null,
                numGearChanges: Number(tr.belief?.numGearChanges ?? immR.numGearChanges ?? 0),
                belief: tr.belief,
                distribution: tr.distribution,
              })
            }

            const evalBaseWorld = tContRaid > wTrunkImm.now
              ? adapter.advanceTimeOnly(wTrunkImm, tContRaid, { futurePrices: world0.prices || {} })
              : wTrunkImm
            const raidContBuckets = buildContBucketsAt(evalBaseWorld)
            const rawCand = evaluateTrunkPolicy('optimal', evalBaseWorld, world0, {
              customBuckets: raidContBuckets,
              capexActionsAtStart: preselectedCapexActions,
              initialCashEventsOverride: trunkCash0,
              initialSoldByIsleOverride: baseSoldByIsle,
              scheduledUpcomingRaids: remFutSub,
            })
            if (rawCand.raidScheduleInfeasible) continue

            const hasStochasticImmRaid = immTransList.some((x) => Boolean(x.trans.distribution?.isStochastic))
            rawCand.immediateRaidMeta = {
              sig: `${fullPrepActs0.map((a) => `${a.a}:${a.id || ''}:${a.q ?? ''}`).join(',')}=>${immTransList.map((x) => x.raid.targetId).join(',')}`,
              hasPrepAtT0: fullPrepActs0.length > 0,
              fullPrepActs0,
              immTransitions,
              hasStochasticImmRaid,
              evalExactExpectationFn: () => {
                let states = [{ prob: 1, w: adapter.cloneWorld(wAfterPrep0), cash: [...prepCashEvents0] }]
                for (const { trans: tr } of immTransList) {
                  const outs = (tr.distribution?.outcomes || [{ kind: 'undetected', prob: 1, lootBag: {}, fineCoins: 0 }])
                    .filter((o) => o.prob > 1e-9)
                  const nextStates = []
                  for (const st of states) {
                    let wStep = adapter.cloneWorld(st.w)
                    wStep.state.en = Math.max(0, Math.floor(Number(wStep.state?.en || 0)) - tr.energyCost)
                    for (const out of outs) {
                      let wBr = adapter.cloneWorld(wStep)
                      const cashBr = [...st.cash]
                      const arrivals = Object.entries(out.lootBag || {}).map(([id, n]) => ({ id, q: 0, n }))
                      if (arrivals.length > 0) wBr = applyExogenousArrivals(wBr, arrivals)
                      const actualFine = Math.min(Math.max(0, Number(wBr.coins || 0)), Math.max(0, Math.round(Number(out.fineCoins || 0))))
                      if (actualFine > 0) {
                        wBr.coins = Math.max(0, Number(wBr.coins || 0) - actualFine)
                        cashBr.push({ atSec: world0.now, netCashDelta: -actualFine })
                      }
                      nextStates.push({ prob: st.prob * out.prob, w: wBr, cash: cashBr })
                    }
                  }
                  states = nextStates
                }
                if (states.length > 16) return { ok: false, value: rawCand.expectedValue, branchCount: 0 }
                let meanVal = 0
                let totalLeaves = 0
                for (const br of states) {
                  if (isPastDeadline()) return { ok: false, value: rawCand.expectedValue, branchCount: 0 }
                  const wBrCont = tContRaid > br.w.now
                    ? adapter.advanceTimeOnly(br.w, tContRaid, { futurePrices: world0.prices || {} })
                    : br.w
                  const brCand = evaluateTrunkPolicy('optimal', wBrCont, world0, {
                    customBuckets: raidContBuckets,
                    capexActionsAtStart: preselectedCapexActions,
                    initialCashEventsOverride: br.cash,
                    initialSoldByIsleOverride: baseSoldByIsle,
                    scheduledUpcomingRaids: remFutSub,
                  })
                  if (brCand.raidScheduleInfeasible || candidateHasDomesticStoch(brCand)) {
                    return { ok: false, value: rawCand.expectedValue, branchCount: 0 }
                  }
                  const rec = evalExactUpcomingRaidTree(brCand, wBrCont, br.cash, baseSoldByIsle, 0)
                  if (!rec.ok) return { ok: false, value: rawCand.expectedValue, branchCount: 0 }
                  meanVal += br.prob * rec.value
                  totalLeaves += rec.branchCount
                }
                return { ok: true, value: meanVal, branchCount: totalLeaves }
              },
              evalRolloutFn: (prngFactory) => {
                const raidRand = typeof prngFactory === 'function' ? prngFactory() : adapter.makeSampleStreamPrng(991, world0.now)
                let wRoll = adapter.cloneWorld(wAfterPrep0)
                const cashRoll = [...prepCashEvents0]
                for (const { trans: tr } of immTransList) {
                  wRoll.state.en = Math.max(0, Math.floor(Number(wRoll.state?.en || 0)) - tr.energyCost)
                  const outs = tr.distribution?.outcomes || []
                  const uDraw = raidRand()
                  let chosen = outs[outs.length - 1] || { lootBag: {}, fineCoins: 0 }
                  let acc = 0
                  for (const o of outs) {
                    acc += o.prob
                    if (uDraw <= acc + 1e-12) {
                      chosen = o
                      break
                    }
                  }
                  const arrivals = Object.entries(chosen.lootBag || {}).map(([id, n]) => ({ id, q: 0, n }))
                  if (arrivals.length > 0) wRoll = applyExogenousArrivals(wRoll, arrivals)
                  const actualFine = Math.min(Math.max(0, Number(wRoll.coins || 0)), Math.max(0, Math.round(Number(chosen.fineCoins || 0))))
                  if (actualFine > 0) {
                    wRoll.coins = Math.max(0, Number(wRoll.coins || 0) - actualFine)
                    cashRoll.push({ atSec: world0.now, netCashDelta: -actualFine })
                  }
                }
                const wRollCont = tContRaid > wRoll.now
                  ? adapter.advanceTimeOnly(wRoll, tContRaid, { futurePrices: world0.prices || {} })
                  : wRoll
                let rollRes = evaluateTrunkPolicy('optimal', wRollCont, world0, {
                  customBuckets: raidContBuckets,
                  capexActionsAtStart: preselectedCapexActions,
                  initialCashEventsOverride: cashRoll,
                  initialSoldByIsleOverride: baseSoldByIsle,
                  prngFactory,
                  scheduledUpcomingRaids: remFutSub,
                })
                if (rollRes.raidScheduleInfeasible && remFutSub.length > 0) {
                  rollRes = evaluateTrunkPolicy('optimal', wRollCont, world0, {
                    capexActionsAtStart: preselectedCapexActions,
                    initialCashEventsOverride: cashRoll,
                    initialSoldByIsleOverride: baseSoldByIsle,
                    prngFactory,
                  })
                }
                return rollRes.expectedValue
              },
            }

            if (winningRaidCand.valueInterpretation == null) scoreDomesticCandidate(winningRaidCand)
            scoreDomesticCandidate(rawCand)
            subVerifiedFeasible = true
            if (rawCand.policyExpectedValue > winningRaidCand.policyExpectedValue + 1e-6) {
              winningRaidCand = rawCand
            }
          }
        }
        if (subVerifiedFeasible) verifiedFeasibleCount++
      }

      if (winningRaidCand !== bestDomestic) {
        if (!options.skipPostSelectionScoring && winningRaidCand.valueInterpretation == null) {
          scoreDomesticCandidate(winningRaidCand)
        }
        if (bestDomestic.valueInterpretation == null) {
          scoreDomesticCandidate(bestDomestic)
        }
        const netDeltaOverBestDom = winningRaidCand.policyExpectedValue - bestDomestic.policyExpectedValue
        if (netDeltaOverBestDom > 1e-6) {
          raidAdjustedDomestic = winningRaidCand

          const immMeta = winningRaidCand.immediateRaidMeta || null
          if (immMeta && immMeta.immTransitions.length > 0) {
            raidPrepActs = immMeta.fullPrepActs0 || []
            const firstImm = immMeta.immTransitions[0]
            const vb0 = firstImm.belief || {}
            selectedVisits.push({
              targetId: firstImm.targetId,
              targetName: firstImm.targetName,
              totalSpots: firstImm.totalSpots,
              lootBag: vb0.lootBag || {},
              guardWinLootBag: vb0.guardWinLootBag || vb0.lootBag || {},
              energyCost: firstImm.energyCost,
              detectionProb: vb0.hasGuard ? Number(vb0.detectionProb || 0) : 0,
              hasGuard: Boolean(vb0.hasGuard),
              expectedDeltaObjectiveMid: netDeltaOverBestDom,
              expectedDeltaObjectiveInterval: [netDeltaOverBestDom, netDeltaOverBestDom],
              estimationSource: vb0.estimationSource || (vb0.hasGuard ? 'unobserved-wide-prior' : 'no-guard-deterministic'),
              decisionScore: netDeltaOverBestDom,
              tacticalDecision: firstImm.tacticalDecision || null,
              optimalLoadout: firstImm.optimalLoadout || null,
              numGearChanges: firstImm.numGearChanges || 0,
              belief: vb0,
            })
          }

          const allRecordedRaids = [
            ...(immMeta?.immTransitions || []),
            ...(winningRaidCand.raidTransitionsFlat || []),
          ]
          committedRaids = allRecordedRaids.map((tr) => ({
            targetId: tr.targetId,
            targetName: tr.targetName || String(tr.targetId),
            unlockAtSec: Number(tr.unlockAtSec ?? tr.atSec ?? world0.now),
            isImmediate: Boolean(tr.isImmediate),
            exactUnlockKnown: Boolean(tr.exactUnlockKnown),
            totalSpots: Number(tr.totalSpots || 0),
            energyCost: Number(tr.energyCost || 0),
            plannedBuffActs: tr.buffActs || [],
            plannedStaminaPrepActs: tr.staminaPrepActs || [],
            plannedPrepActs: tr.prepAndBuffActs || [],
            tacticalDecision: tr.tacticalDecision || null,
            optimalLoadout: tr.optimalLoadout || null,
            numGearChanges: Number(tr.numGearChanges || 0),
            expectedDeltaObjectiveMid: netDeltaOverBestDom,
            preconditions: tr.preconditions || {
              minEnBeforePrep: Number(tr.energyCost || 0),
              minCoinsBeforePrep: 0,
              coffeeCount: 0,
              requiredEdibles: [],
            },
          }))
          committedUpcomingRaids = committedRaids
            .filter((r) => !r.isImmediate && r.unlockAtSec > world0.now)
            .map((r) => ({
              targetId: r.targetId,
              targetName: r.targetName,
              unlockAtSec: r.unlockAtSec,
              exactUnlockKnown: r.exactUnlockKnown,
              energyCost: r.energyCost,
              totalSpots: r.totalSpots,
              plannedBuffActs: r.plannedBuffActs,
              plannedStaminaPrepActs: r.plannedStaminaPrepActs,
              plannedPrepActs: r.plannedPrepActs,
              tacticalDecision: r.tacticalDecision,
              optimalLoadout: r.optimalLoadout,
              preconditions: r.preconditions,
            }))
        }
      }
      if (!raidEvalTruncatedByDeadline) {
        for (const b of envelope.beliefs?.visitBeliefs || []) {
          if (b?.targetId != null) evaluatedTargetIdSet.add(Number(b.targetId))
        }
        for (const b of envelope.beliefs?.upcomingVisitBeliefs || []) {
          if (b?.targetId != null) evaluatedTargetIdSet.add(Number(b.targetId))
        }
      }
    }
    if (!raidEvalTruncatedByDeadline && evaluatedTargetIdSet.size === 0) {
      for (const b of envelope.beliefs?.visitBeliefs || []) {
        if (b?.targetId != null) evaluatedTargetIdSet.add(Number(b.targetId))
      }
      for (const b of envelope.beliefs?.upcomingVisitBeliefs || []) {
        if (b?.targetId != null) evaluatedTargetIdSet.add(Number(b.targetId))
      }
    }
    }
  }
  for (const cr of committedRaids) {
    if (cr?.targetId != null) evaluatedTargetIdSet.add(Number(cr.targetId))
  }
  const evaluatedTargetIds = [...evaluatedTargetIdSet].filter(Number.isFinite).sort((a, b) => a - b)

  // Assemble `trunkBuckets` output:
  // When `selectedVisits.length > 0`, `trunkBuckets[0]` at `t0` holds `raidPrepActs` (`[]` when stamina/buffs are already ready,
  // emitting `visitFirst = true`, or `fullPrepActs0` emitting `visitFirst = false`), followed by post-raid continuation at `t0 + minGap`!
  let trunkBuckets
  if (selectedVisits.length > 0) {
    const firstMeta = trunkBucketsMeta[0]
    const contUsed = raidAdjustedDomestic.trunkBucketsUsed || []
    const contActs = raidAdjustedDomestic.trunkActionsByBucket || []
    trunkBuckets = [
      {
        ...firstMeta,
        nextAtSec: contUsed.length > 0 ? contUsed[0].atSec : firstMeta.nextAtSec,
        domesticActions: raidPrepActs,
        visitActions: selectedVisits,
        visitFirst: raidPrepActs.length === 0,
        plannedPostBucketEnFloor: 0,
        plannedAtEnT: plannedAtEnT0,
      },
      ...contUsed.map((bMeta, idx) => ({
        ...bMeta,
        index: idx + 1,
        domesticActions: contActs[idx] || [],
        visitActions: [],
        visitFirst: false,
        plannedPostBucketEnFloor: Number(raidAdjustedDomestic.bucketPlannedPostEnFloor?.[idx] || 0),
      })),
    ]
  } else {
    const usedMeta = raidAdjustedDomestic.trunkBucketsUsed || trunkBucketsMeta
    trunkBuckets = usedMeta.map((b, idx) => ({
      ...b,
      domesticActions: raidAdjustedDomestic.trunkActionsByBucket[idx] || [],
      visitActions: [],
      visitFirst: false,
      plannedPostBucketEnFloor: Number(raidAdjustedDomestic.bucketPlannedPostEnFloor?.[idx] || 0),
      ...(idx === 0 ? { plannedAtEnT: plannedAtEnT0 } : {}),
    }))
  }

  // Check if any stochastic action appears in the active plan (across trunk, scenario recourse branches, or guarded raids!)
  const branchHasStochastic = Object.values(raidAdjustedDomestic.scenarioBranches || {}).some((br) =>
    (br.bucketActions || []).some((bActs) => (bActs || []).some((a) => adapter.isStochasticAction(a)))
  )
  const hasDomesticStochastic = trunkBuckets.some((b) =>
    b.domesticActions.some((a) => adapter.isStochasticAction(a))
  ) || branchHasStochastic
  const hasStochasticInPlan = hasDomesticStochastic || selectedVisits.length > 0

  const feasibleIncumbentValue = raidAdjustedDomestic.policyExpectedValue
  const standardError = raidAdjustedDomestic.standardError || 0
  const confidenceInterval95 = raidAdjustedDomestic.confidenceInterval95 || null
  const policySampleCount = raidAdjustedDomestic.policySampleCount || null
  const valueInterpretation = raidAdjustedDomestic.valueInterpretation
    || (scenarios.length === 1 ? 'deterministic-exact' : 'conditional-scenario-expectation')

  // Only claim valid upper bound when no unmodeled farm/stochastic actions were active in `activeActionTypes`!
  const boundRes = scenarios.length === 1
    ? computeValidUpperBound(adapter, {
        world: world0,
        buckets,
        pricesByBucket: buckets.map((b) => makePricesFn(scenarios[0])(b, baseSoldByIsle)),
        objectiveCfg,
        allowedActionTypes: activeActionTypes,
        candidateSetComplete: options.candidateSetComplete !== false,
        innerPruningApplied: options.innerPruningApplied === true,
      })
    : {
        validUpperBound: null,
        status: 'multi-scenario-no-single-deterministic-bound',
        reason: 'Multiple external price scenarios active; incumbent reported as conditional scenario expectation.',
      }

  // Strict U >= L Verification (`P1-3`): NEVER mask `validUpperBound < feasibleIncumbentValue` as `gap = 0`!
  let validUpperBound = boundRes.validUpperBound
  let upperBoundStatus = boundRes.status
  let gap = null
  let boundViolationDelta = null
  let solverStatus = 'feasible-incumbent'

  if (validUpperBound != null) {
    if (validUpperBound + 1e-6 < feasibleIncumbentValue) {
      solverStatus = 'bound-violation-error'
      boundViolationDelta = validUpperBound - feasibleIncumbentValue
      upperBoundStatus = 'invalid-bound-below-incumbent'
      validUpperBound = null
      gap = null
    } else {
      gap = Math.max(0, validUpperBound - feasibleIncumbentValue)
      if (gap <= 1e-6) solverStatus = 'certified-optimal'
    }
  }

  // Determine exact event-driven & `minActionableEn`-driven `nextWakeSec` (zero `+5s` delay on deterministic events)
  const activePlanBuckets = selectedVisits.length > 0
    ? [trunkBuckets[0], ...(raidAdjustedDomestic.allBuckets || [])]
    : (raidAdjustedDomestic.allBuckets || buckets)
  const fallbackWakeFloorSec = world0.now + Math.max(5, minGapSec)
  const bucket0Empty = (trunkBuckets[0]?.domesticActions?.length || 0) === 0 && (trunkBuckets[0]?.visitActions?.length || 0) === 0
  let nextWakeIdx = 1
  let hasExactBucketTarget = false
  if (bucket0Empty) {
    for (let idx = 1; idx < activePlanBuckets.length; idx++) {
      const bMeta = activePlanBuckets[idx]
      const tb = trunkBuckets[idx]
      const hasPlannedWork = (tb?.domesticActions?.length || 0) > 0 || (tb?.visitActions?.length || 0) > 0
      const revealsNewInfo = !bMeta.isTrunkBeforePriceReveal || (bMeta.exogenousArrivalsAtStart?.length || 0) > 0
      const hasUpcomingRaidUnlock = Boolean(bMeta.reasons?.includes('upcoming-raid-unlock'))
      const beyondTrunkEvent = idx >= trunkBuckets.length
      if (hasPlannedWork || revealsNewInfo || hasUpcomingRaidUnlock || beyondTrunkEvent) {
        nextWakeIdx = idx
        hasExactBucketTarget = true
        break
      }
    }
  } else if (activePlanBuckets.length > 1) {
    hasExactBucketTarget = true
  }
  let nextWakeSec = activePlanBuckets.length > nextWakeIdx
    ? Math.max(world0.now + (bucket0Empty ? 1 : minGapSec), activePlanBuckets[nextWakeIdx].atSec)
    : Math.max(fallbackWakeFloorSec, world0.now + Math.min(300, Math.max(60, objectiveCfg.horizonSec || 300)))

  const sWake = world0.state || {}
  const curEnWake = Math.max(0, Math.floor(Number(sWake.en || 0)))
  const rawMaxWake = Number(adapter.R.energyMax(sWake))
  const enMaxWake = Number.isFinite(rawMaxWake) && rawMaxWake > 0 ? rawMaxWake : 100
  if (curEnWake < enMaxWake) {
    const userFloorWake = Number(constraints.staminaReserveFloor || 0) > 0 && world0.now < Number(constraints.staminaReserveUntilSec || 0)
      ? Math.max(0, Math.floor(Number(constraints.staminaReserveFloor || 0)))
      : 0
    const plannedRaidFloorWake = bucket0Empty
      ? Math.max(0, Math.floor(Number(trunkBuckets[0]?.plannedPostBucketEnFloor || 0)))
      : 0
    const activeFloorWake = Math.max(userFloorWake, plannedRaidFloorWake)
    const iDayWake = adapter.R.isleDay(world0.now)
    const iIdxWake = adapter.R.isleIndex(world0.now)
    const weatherWake = adapter.R.weatherOf(iDayWake)
    let minActionableEn = Infinity
    let hasEmptyPlotWake = false
    let hasManualWaterPlotWake = false
    for (let i = 0; i < (sWake.plotN || 0); i++) {
      const p = sWake.plots?.[i]
      if (!p) {
        if (allowedSet.has('plant')) {
          hasEmptyPlotWake = true
          minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.cost?.plant ?? 2))
        }
        continue
      }
      const auto = adapter.R.sprinkled(sWake, i) || weatherWake === 1
      const st = adapter.R.cropStage(p, world0.now, auto)
      if (st.stage === 3 && allowedSet.has('harvest')) {
        minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.cost?.harvest ?? 1))
      } else if (st.stage === -1 && allowedSet.has('clear')) {
        minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.cost?.clear ?? 1))
      } else if (st.stage >= 0 && st.stage < 3 && !auto && p.w <= st.stage && allowedSet.has('water')) {
        hasManualWaterPlotWake = true
      }
    }
    if (!hasEmptyPlotWake && hasManualWaterPlotWake) {
      minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.cost?.water ?? 1))
    }
    if (allowedSet.has('feed')) {
      for (let i = 0; i < (sWake.barn?.length || 0); i++) {
        const pen = sWake.barn[i]
        if (pen && !adapter.R.b12AnimalStage(pen, world0.now).retired && world0.now >= pen.f + 86400) {
          minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.cost?.feed ?? 1))
        }
      }
    }
    const iqWake = sWake.iq?.d === iIdxWake ? sWake.iq : {}
    if (allowedSet.has('mine') && Number(iqWake.mine || 0) < (adapter.R.WORLD?.daily?.mine || 100)) {
      minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.cost?.mine ?? 3))
    }
    if (allowedSet.has('fish') && Number(iqWake.fish || 0) < (adapter.R.WORLD?.daily?.fish || 80)) {
      minActionableEn = Math.min(minActionableEn, activeFloorWake + (adapter.R.WORLD?.daily?.fish ? (adapter.R.WORLD?.cost?.fish ?? 4) : 4))
    }
    if (curEnWake < minActionableEn && minActionableEn <= enMaxWake) {
      const regenEvery = adapter.R.WORLD?.regen || 180
      const baseEnTWake = Math.max(world0.now - regenEvery, Number(sWake.enT || world0.now))
      const regenWakeSec = Math.max(world0.now + 1, baseEnTWake + (minActionableEn - curEnWake) * regenEvery)
      if (regenWakeSec < nextWakeSec) {
        nextWakeSec = regenWakeSec
        hasExactBucketTarget = true
      }
    }
  }
  if (!hasExactBucketTarget) {
    nextWakeSec = Math.max(fallbackWakeFloorSec, nextWakeSec)
  } else {
    nextWakeSec = Math.max(world0.now + 1, nextWakeSec)
  }

  const elapsedMs = performance.now() - startMs
  const cpuDiff = startCpu && typeof process?.cpuUsage === 'function' ? process.cpuUsage(startCpu) : null
  const cpuMs = cpuDiff ? (cpuDiff.user + cpuDiff.system) / 1000 : elapsedMs

  const planId = crypto.randomUUID()
  const sourceFarmDigest = computeStaticFarmStateDigest(world0)
  const raidSchedule = {
    planId,
    createdAtSec: world0.now,
    sourceFarmDigest,
    evaluatedTargetIds,
    committedRaids,
    truncatedByDeadline: raidEvalTruncatedByDeadline,
  }

  const planOut = {
    planId,
    account: envelope.account,
    rulesHash: adapter.rulesHash,
    objectiveHash: objectiveCfg.objectiveHash,
    constraintsHash: envelope.constraintsHash,
    constraints,
    serverNow: world0.now,
    horizonSec: objectiveCfg.horizonSec,
    terminalMethod: objectiveCfg.terminalSupplyMode,
    trunkBuckets,
    raidSchedule,
    committedUpcomingRaids,
    scenarioBranches: raidAdjustedDomestic.scenarioBranches,
    marginalContext: raidAdjustedDomestic.marginalContext || bestDomestic.marginalContext || null,
    nextWakeSec,
    waitReason: trunkBuckets[0]?.domesticActions.length === 0 && trunkBuckets[0]?.visitActions.length === 0
      ? (activePlanBuckets[nextWakeIdx]?.reasons?.join(',') || 'hold-for-future-event-or-price-reveal')
      : null,
    quality: {
      solverStatus,
      valueInterpretation,
      feasibleIncumbentValue,
      standardError,
      confidenceInterval95,
      policySampleCount,
      validUpperBound,
      upperBoundStatus,
      boundViolationDelta,
      gap,
      scenarios: scenarios.map((s) => ({ id: s.id, weight: s.weight, externalSupplyFactor: s.externalSupplyFactor })),
      pruning: (() => {
        const discMeta = raidAdjustedDomestic.discretizationMeta || {
          cashDiscretized: false,
          maxCashUnit: 1,
          minExactGcd: 1,
          maxDpCells: 0,
          sites: [],
        }
        return {
          maxBuckets: options.maxBuckets || 16,
          upperBoundComplete: options.candidateSetComplete !== false && options.innerPruningApplied !== true && !deadlineHit,
          candidateSetComplete: options.candidateSetComplete !== false && !discMeta.cashDiscretization && !discMeta.cashDiscretized && !deadlineHit,
          innerPruningApplied: options.innerPruningApplied === true || Boolean(discMeta.cashDiscretized) || deadlineHit,
          deadlineReached: deadlineHit,
          incumbentCashDiscretization: discMeta,
        }
      })(),
      elapsedMs,
      cpuMs,
    },
  }

  if (options._exposeCapexForStability) {
    planOut._selectedCapexActions = preselectedCapexActions
  }
  if (options.skipPostSelectionScoring) {
    const wasRankedFast = Boolean(fastRankingMode)
    planOut._finalizePostSelectionQuality = () => {
      const targetCand = raidAdjustedDomestic
      if (!targetCand) return
      if (targetCand.valueInterpretation != null && !wasRankedFast) return
      const tFin0 = performance.now()
      fastRankingMode = false
      targetCand.valueInterpretation = null
      scoreDomesticCandidate(targetCand)
      const q = planOut.quality
      const nextIncumbent = targetCand.policyExpectedValue
      q.feasibleIncumbentValue = nextIncumbent
      q.standardError = targetCand.standardError || 0
      q.confidenceInterval95 = targetCand.confidenceInterval95 || null
      q.policySampleCount = targetCand.policySampleCount || null
      q.valueInterpretation = targetCand.valueInterpretation || q.valueInterpretation
      if (boundRes.validUpperBound != null) {
        if (boundRes.validUpperBound + 1e-6 < nextIncumbent) {
          q.solverStatus = 'bound-violation-error'
          q.boundViolationDelta = boundRes.validUpperBound - nextIncumbent
          q.upperBoundStatus = 'invalid-bound-below-incumbent'
          q.validUpperBound = null
          q.gap = null
        } else {
          q.validUpperBound = boundRes.validUpperBound
          q.upperBoundStatus = boundRes.status
          q.boundViolationDelta = null
          q.gap = Math.max(0, boundRes.validUpperBound - nextIncumbent)
          q.solverStatus = q.gap <= 1e-6 ? 'certified-optimal' : 'feasible-incumbent'
        }
      }
      q.elapsedMs += performance.now() - tFin0
    }
  }

  return planOut
}

/**
 * Rolling-Horizon Prefix Stability Check (`round2-design-review.md §3`):
 * Compares executable `trunkBuckets[0]` under `H` vs `H + ΔH`, preserving `[t0, t0 + H]`
 * event buckets identically and skipping the extended check cleanly if `deadlineAtMs` is near!
 */
export function solveWithHorizonStability(adapter, envelope, objectiveCfgInput = {}, options = {}) {
  const nowMsFn = typeof options.nowMsFn === 'function' ? options.nowMsFn : Date.now
  const startWallMs = nowMsFn()
  const deadlineAtMs = Number.isFinite(options.deadlineAtMs)
    ? Number(options.deadlineAtMs)
    : (Number.isFinite(options.maxSolveMs) ? startWallMs + Number(options.maxSolveMs) : Infinity)

  const baseCfg = objectiveCfgInput?.objectiveHash
    ? objectiveCfgInput
    : buildObjectiveConfig(objectiveCfgInput)
  const extCfg = buildObjectiveConfig({
    ...baseCfg,
    horizonSec: baseCfg.horizonSec + (baseCfg.extendedHorizonDeltaSec || 2 * 14400),
  })

  const worldObs = envelope?.observed?.world
  const t0 = Number(worldObs?.now || 0)
  const cs = worldObs?.clockStart
  let effectiveDeadlineAtMs = deadlineAtMs
  if (Number.isFinite(deadlineAtMs) && worldObs) {
    const nextIsleSec = adapter.nextIsleBoundary?.(t0, cs) ?? Infinity
    const nextNatSec = adapter.nextNaturalDayBoundary?.(t0) ?? Infinity
    const secToEpoch = Math.max(0, Math.min(nextIsleSec, nextNatSec) - t0)
    if (Number.isFinite(secToEpoch)) {
      const epochWallDeadlineMs = startWallMs + Math.max(250, secToEpoch * 1000 - 1500)
      effectiveDeadlineAtMs = Math.min(effectiveDeadlineAtMs, epochWallDeadlineMs)
    }
  }

  const baseMaxBuckets = options.maxBuckets || 16
  const basePlan = solveUnifiedPlan(adapter, envelope, baseCfg, {
    ...options,
    nowMsFn,
    deadlineAtMs: effectiveDeadlineAtMs,
    _exposeCapexForStability: true,
  })
  const reusedCapex = basePlan._selectedCapexActions
  delete basePlan._selectedCapexActions

  // Stream `basePlan` checkpoint immediately so caller/Worker host retains a valid executable plan
  // even if the subsequent extended-horizon verification times out, errors, or is hard-terminated!
  if (typeof options.onBasePlanReady === 'function') {
    options.onBasePlanReady(basePlan)
  }

  const extScale = extCfg.horizonSec / Math.max(1, baseCfg.horizonSec)
  if (Number.isFinite(effectiveDeadlineAtMs)) {
    const minExtBudgetMs = Math.max(50, Number(basePlan.quality?.elapsedMs || 0) * Math.max(1.2, extScale))
    if (nowMsFn() + minExtBudgetMs >= effectiveDeadlineAtMs || basePlan.quality?.pruning?.deadlineReached) {
      return {
        prefixStable: null,
        skippedByDeadline: true,
        basePlan,
        extendedPlan: null,
      }
    }
  }

  const maxCapexCapSec = Math.min(72 * 3600, Number(envelope?.constraints?.maxCapexPaybackSec || 72 * 3600))
  const basePaybackSec = Math.max(baseCfg.horizonSec || 3600, maxCapexCapSec)
  const extPaybackSec = Math.max(extCfg.horizonSec || 3600, maxCapexCapSec)

  const extMaxBuckets = Math.max(baseMaxBuckets + 4, Math.ceil(baseMaxBuckets * extScale))
  let extendedPlan = null
  try {
    extendedPlan = solveUnifiedPlan(adapter, envelope, extCfg, {
      ...options,
      nowMsFn,
      deadlineAtMs: effectiveDeadlineAtMs,
      maxBuckets: extMaxBuckets,
      preservePrefixThroughSec: t0 + Math.max(0, Math.floor(baseCfg.horizonSec || 0)),
      prefixMaxBuckets: baseMaxBuckets,
      preselectedCapexActionsOverride: extPaybackSec === basePaybackSec ? reusedCapex : undefined,
      skipPostSelectionScoring: true,
      _fastCandidateRankingOnly: true,
    })
  } catch (extErr) {
    return {
      prefixStable: null,
      skippedByDeadline: true,
      extendedError: extErr?.message || String(extErr),
      basePlan,
      extendedPlan: null,
    }
  }

  // Never discard a complete `basePlan` in favor of a deadline-truncated `extendedPlan`!
  if (!basePlan.quality?.pruning?.deadlineReached && extendedPlan.quality?.pruning?.deadlineReached) {
    delete extendedPlan._finalizePostSelectionQuality
    return {
      prefixStable: null,
      skippedByDeadline: true,
      basePlan,
      extendedPlan: null,
    }
  }

  const waitCapSec = t0 + Math.max(0, Math.floor(baseCfg.horizonSec || 0))
  const sig0 = worldObs
    ? buildExecutablePlanSignature(adapter, worldObs, basePlan, { waitHorizonCapSec: waitCapSec })
    : JSON.stringify({
        dom: basePlan.trunkBuckets[0]?.domesticActions || [],
        vis: (basePlan.trunkBuckets[0]?.visitActions || []).map((v) => v.targetId),
      })
  const sig1 = worldObs
    ? buildExecutablePlanSignature(adapter, worldObs, extendedPlan, { waitHorizonCapSec: waitCapSec })
    : JSON.stringify({
        dom: extendedPlan.trunkBuckets[0]?.domesticActions || [],
        vis: (extendedPlan.trunkBuckets[0]?.visitActions || []).map((v) => v.targetId),
      })
  const isStable = sig0 === sig1
  if (!isStable && typeof extendedPlan._finalizePostSelectionQuality === 'function') {
    extendedPlan._finalizePostSelectionQuality()
  }
  delete extendedPlan._finalizePostSelectionQuality

  return {
    prefixStable: isStable,
    skippedByDeadline: false,
    basePlan,
    extendedPlan,
  }
}

function addBagToInvDelta(baseDelta, lootBag) {
  const next = {}
  for (const [k, row] of Object.entries(baseDelta || {})) {
    next[k] = [row[0] || 0, row[1] || 0, row[2] || 0]
  }
  for (const [id, qty] of Object.entries(lootBag || {})) {
    const q0 = Number(qty || 0)
    if (!q0) continue
    next[id] ||= [0, 0, 0]
    next[id][0] += q0
  }
  return next
}

function applyInvDeltaToSupplyTable(supplyByBucket, invDeltaById) {
  const L = supplyByBucket.length
  const next = supplyByBucket.slice()
  const copied = new Uint8Array(L)
  const ensureBucket = (u) => {
    if (!copied[u]) {
      next[u] = { ...next[u] }
      copied[u] = 1
    }
    return next[u]
  }

  for (const [id, rawRow] of Object.entries(invDeltaById || {})) {
    const dRow = Array.isArray(rawRow) ? rawRow : [Number(rawRow || 0), 0, 0]
    for (let q = 0; q < 3; q++) {
      const d = Number(dRow[q] || 0)
      if (d > 0 && L > 0) {
        const b0 = ensureBucket(0)
        const prev = b0[id] || [0, 0, 0]
        b0[id] = [prev[0] || 0, prev[1] || 0, prev[2] || 0]
        b0[id][q] += d
      } else if (d < 0) {
        let remDeduct = -d
        for (let u = 0; u < L && remDeduct > 0; u++) {
          const prev = next[u][id]
          if (!prev || !(prev[q] > 0)) continue
          const bm = ensureBucket(u)
          if (bm[id] === supplyByBucket[u][id]) {
            bm[id] = [prev[0] || 0, prev[1] || 0, prev[2] || 0]
          }
          const tk = Math.min(remDeduct, bm[id][q])
          bm[id][q] -= tk
          remDeduct -= tk
        }
      }
    }
  }
  return next
}

/**
 * Fast (`< 2ms`) Exact Unified Marginal Raid Delta Evaluator:
 * Reuses the domestic baseline `marginalContext` (`supplyByBucket`, `jointCS`, `slots`, `u0MarginalStaminaMeta`)
 * to evaluate the exact joint multi-bucket craft + cross-day crop-tier sale + terminal liquidation + stamina delta
 * of any `(invDeltaById, postRaidEn, cashSpent)` state without re-cloning or re-solving the entire farm!
 */
export function evaluateMarginalRaidDelta(adapter, marginalCtx, {
  invDeltaById = {},
  postRaidEn = 0,
  cashSpent = 0,
  coffeeUsedInPrep = 0,
} = {}) {
  if (!marginalCtx || !marginalCtx.seqBuckets || marginalCtx.seqBuckets.length === 0) {
    return -Number(cashSpent || 0)
  }

  const {
    seqBuckets,
    slots,
    supplyByBucket,
    jointCS,
    craftCapByIsle,
    enAfterPreByU,
    initialNatDay,
    initialCnt,
    allowCraft,
    maxCraftHoldIsleDays,
    u0MarginalStaminaMeta,
    baseWorldEn0,
    recipeInputSet,
  } = marginalCtx

  const changedIds = Object.keys(invDeltaById || {}).filter((id) => {
    const r = invDeltaById[id]
    return Array.isArray(r) ? (r[0] !== 0 || r[1] !== 0 || r[2] !== 0) : Number(r || 0) !== 0
  })

  const craftEnCost = adapter.R.WORLD?.cost?.craft ?? 1
  const meta0 = u0MarginalStaminaMeta
  let totalTopUpEnCap = 0
  if (meta0?.topUpUnits) {
    for (const uIt of meta0.topUpUnits) {
      let remQty = uIt.qty
      if (uIt.kind === 'coffee') remQty = Math.max(0, remQty - Number(coffeeUsedInPrep || 0))
      else if (invDeltaById?.[uIt.id]) {
        const eaten = Math.max(0, -(Number(invDeltaById[uIt.id][uIt.q] || 0)))
        remQty = Math.max(0, remQty - eaten)
      }
      totalTopUpEnCap += remQty * uIt.energyGain
    }
  }

  const maxReachableIsle0En = meta0
    ? Math.max(0, Math.floor(Number(postRaidEn || 0)) - meta0.preEnSpent0 - meta0.bucketEnFloor)
      + meta0.regenInIsleWindow
      + totalTopUpEnCap
    : Infinity

  const nextEnCapByBucket = Float64Array.from(seqBuckets.map((b2, idx2) => {
    const baseCap = Math.max(enAfterPreByU[idx2] || 0, (craftCapByIsle.get(b2.isleIndex) || 0) * craftEnCost)
    if (meta0 && b2.isleIndex === meta0.isleIndex0) {
      return Math.min(baseCap, maxReachableIsle0En)
    }
    return baseCap
  }))

  const countIsle0CraftEn = (craftsByBucket) => {
    if (!meta0) return 0
    let used = 0
    for (let u = 0; u < seqBuckets.length; u++) {
      if (seqBuckets[u].isleIndex !== meta0.isleIndex0) continue
      for (const ca of craftsByBucket[u] || []) used += Number(ca.n || 1) * craftEnCost
    }
    return used
  }

  const baseCraftEn0 = countIsle0CraftEn(jointCS.craftsByBucket)
  const craftEnTightened = meta0 && maxReachableIsle0En < baseCraftEn0
  const baseCraftTouchedIds = new Set()
  if (Array.isArray(jointCS.executionOrderMoves)) {
    for (const em of jointCS.executionOrderMoves) {
      for (const cId of em.changedIds) baseCraftTouchedIds.add(cId)
    }
  }
  const canChangedItemTouchCraft = (id) => {
    const d = invDeltaById?.[id] || [0, 0, 0]
    const hasNeg = (d[0] || 0) < 0 || (d[1] || 0) < 0 || (d[2] || 0) < 0
    if (hasNeg) return recipeInputSet.has(id) || adapter.graph.recipesById.has(id)
    if (!recipeInputSet.has(id)) return false
    if (baseCraftTouchedIds.has(id)) return true
    const recs = adapter.graph.consumedByRecipes.get(id)
    if (!recs || recs.length === 0) return false
    let minReq = Infinity
    for (const r of recs) {
      const req = Number(r.in?.[id] || 0)
      if (req > 0 && req < minReq) minReq = req
    }
    if (!Number.isFinite(minReq)) return false
    let totalQty = (d[0] || 0) + (d[1] || 0) + (d[2] || 0)
    for (let u = 0; u < seqBuckets.length && totalQty < minReq; u++) {
      const row = supplyByBucket[u]?.[id]
      if (row) totalQty += (row[0] || 0) + (row[1] || 0) + (row[2] || 0)
    }
    return totalQty >= minReq
  }
  const touchesCraft = allowCraft && (
    craftEnTightened ||
    changedIds.some(canChangedItemTouchCraft)
  )

  let invAndCraftDelta = 0
  let nextCraftEn0 = baseCraftEn0

  if (touchesCraft) {
    let hasNegativeRecipeItem = false
    let totalAddedRecipeUnits = 0
    for (const id of changedIds) {
      if (!canChangedItemTouchCraft(id)) continue
      const d = invDeltaById[id] || [0, 0, 0]
      if ((d[0] || 0) < 0 || (d[1] || 0) < 0 || (d[2] || 0) < 0) {
        hasNegativeRecipeItem = true
        break
      }
      totalAddedRecipeUnits += (d[0] || 0) + (d[1] || 0) + (d[2] || 0)
    }

    let warmSolved = false
    if (!craftEnTightened && !hasNegativeRecipeItem && Array.isArray(jointCS.executionOrderMoves)) {
      const baseFreeCraftCap = new Map(craftCapByIsle)
      const baseFreeEnCap = Float64Array.from(nextEnCapByBucket)
      for (const em of jointCS.executionOrderMoves) {
        const usedSlots = em.tpl.craftSlots * em.count
        const usedEn = usedSlots * craftEnCost
        baseFreeCraftCap.set(em.isleIdx, Math.max(0, (baseFreeCraftCap.get(em.isleIdx) || 0) - usedSlots))
        for (let fb = em.u; fb < seqBuckets.length && seqBuckets[fb].isleIndex === em.isleIdx; fb++) {
          baseFreeEnCap[fb] = Math.max(0, baseFreeEnCap[fb] - usedEn)
        }
      }

      // 1) Exact Keep-All-Existing-Crafts feasible baseline (preserves all base crafts + low-star substitution + free slots)
      let keepAllBestScore = -Infinity
      let keepAllCraftEn0 = baseCraftEn0
      {
        const touchesExistingRawIn = changedIds.some((id) => baseCraftTouchedIds.has(id))
        let keepSupply = null
        if (!touchesExistingRawIn) {
          keepSupply = applyInvDeltaToSupplyTable(jointCS.supplyAfterCrafts, invDeltaById)
        } else {
          keepSupply = applyInvDeltaToSupplyTable(supplyByBucket, invDeltaById)
          for (let idx = 0; idx < jointCS.executionOrderMoves.length; idx++) {
            const em = jointCS.executionOrderMoves[idx]
            if (!(em.count > 0)) continue
            const nextSup = deductFromPrefixSupply(keepSupply, em.u, em.tpl.rawIn, em.count, em.tpl.outId)
            if (!nextSup) { keepSupply = null; break }
            keepSupply = nextSup
          }
        }
        if (keepSupply) {
          const keepBaseEval = changedIds.length > 0
            ? evaluateSupplyPortfolioIncremental(adapter, {
                baseEval: jointCS.salePortfolio,
                supplyByBucket: keepSupply,
                changedItemIds: changedIds,
                slots,
                initialNatDay,
                initialCnt,
                revenueOnly: true,
              })
            : jointCS.salePortfolio
          const keepJointCS = solveJointCraftAndSell(adapter, {
            initialSupplyByBucket: keepSupply,
            buckets: seqBuckets,
            slots,
            initialNatDay,
            initialCnt,
            craftCapByIsle: new Map(baseFreeCraftCap),
            enCapByBucket: Float64Array.from(baseFreeEnCap),
            staminaShadowCost: 0,
            allowCraft,
            maxCraftHoldIsleDays,
            baseEvalOverride: keepBaseEval,
            onlyTouchItemIds: new Set(changedIds),
            revenueOnly: true,
          })
          keepAllBestScore = keepJointCS.netPortfolioScore
          keepAllCraftEn0 = baseCraftEn0 + countIsle0CraftEn(keepJointCS.craftsByBucket)
        }
      }

      // 2) Marginal-slot unroll with transitive later-bucket raw-input release (prevents prefix cannibalization)
      const kUnrollSlots = Math.max(2, totalAddedRecipeUnits * 2)
      const remCraftCap = new Map(baseFreeCraftCap)
      const remEnCap = Float64Array.from(baseFreeEnCap)
      const keptCounts = new Int32Array(jointCS.executionOrderMoves.length)
      const activeTouchSet = new Set(changedIds)
      const earliestUnrolledByRawIn = new Map()
      let unrolledAny = false

      for (let idx = jointCS.executionOrderMoves.length - 1; idx >= 0; idx--) {
        const em = jointCS.executionOrderMoves[idx]
        const freeSlotsIsle = remCraftCap.get(em.isleIdx) || 0
        let minFreeEnIsle = Infinity
        for (let fb = em.u; fb < seqBuckets.length && seqBuckets[fb].isleIndex === em.isleIdx; fb++) {
          minFreeEnIsle = Math.min(minFreeEnIsle, remEnCap[fb] || 0)
        }
        const needSlotRelease = Math.max(0, kUnrollSlots - freeSlotsIsle)
        const needEnRelease = Math.max(0, kUnrollSlots * craftEnCost - minFreeEnIsle)
        const releaseSlotsTarget = Math.max(needSlotRelease, Math.ceil(needEnRelease / Math.max(1, craftEnCost)))
        if (releaseSlotsTarget > 0) {
          const unrollCnt = Math.min(em.count, Math.ceil(releaseSlotsTarget / em.tpl.craftSlots))
          keptCounts[idx] = em.count - unrollCnt
          if (unrollCnt > 0) {
            unrolledAny = true
            const relSlots = unrollCnt * em.tpl.craftSlots
            const relEn = relSlots * craftEnCost
            remCraftCap.set(em.isleIdx, (remCraftCap.get(em.isleIdx) || 0) + relSlots)
            for (let fb = em.u; fb < seqBuckets.length && seqBuckets[fb].isleIndex === em.isleIdx; fb++) {
              remEnCap[fb] += relEn
            }
            for (const cId of em.changedIds) activeTouchSet.add(cId)
            for (const inId of Object.keys(em.tpl.rawIn)) {
              const prevU = earliestUnrolledByRawIn.get(inId)
              if (prevU == null || em.u < prevU) earliestUnrolledByRawIn.set(inId, em.u)
            }
          }
        } else {
          keptCounts[idx] = em.count
        }
      }

      if (unrolledAny && earliestUnrolledByRawIn.size > 0) {
        let changedPass = true
        while (changedPass) {
          changedPass = false
          for (let idx = 0; idx < jointCS.executionOrderMoves.length; idx++) {
            const kCnt = keptCounts[idx]
            if (kCnt <= 0) continue
            const em = jointCS.executionOrderMoves[idx]
            let mustRelease = false
            for (const inId of Object.keys(em.tpl.rawIn)) {
              const u0Unrolled = earliestUnrolledByRawIn.get(inId)
              if (u0Unrolled != null && em.u > u0Unrolled) {
                mustRelease = true
                break
              }
            }
            if (mustRelease) {
              keptCounts[idx] = 0
              const relSlots = kCnt * em.tpl.craftSlots
              const relEn = relSlots * craftEnCost
              remCraftCap.set(em.isleIdx, (remCraftCap.get(em.isleIdx) || 0) + relSlots)
              for (let fb = em.u; fb < seqBuckets.length && seqBuckets[fb].isleIndex === em.isleIdx; fb++) {
                remEnCap[fb] += relEn
              }
              for (const cId of em.changedIds) activeTouchSet.add(cId)
              for (const inId of Object.keys(em.tpl.rawIn)) {
                const prevU = earliestUnrolledByRawIn.get(inId)
                if (prevU == null || em.u < prevU) earliestUnrolledByRawIn.set(inId, em.u)
              }
              changedPass = true
            }
          }
        }
      }

      if (!unrolledAny && Number.isFinite(keepAllBestScore)) {
        invAndCraftDelta = keepAllBestScore - jointCS.netPortfolioScore
        nextCraftEn0 = keepAllCraftEn0
        warmSolved = true
      } else if (unrolledAny) {
        let warmSupply = applyInvDeltaToSupplyTable(supplyByBucket, invDeltaById)
        let keptIsle0CraftEn = 0
        let replayOk = true
        for (let idx = 0; idx < jointCS.executionOrderMoves.length; idx++) {
          const kCnt = keptCounts[idx]
          if (kCnt <= 0) continue
          const em = jointCS.executionOrderMoves[idx]
          const nextSup = deductFromPrefixSupply(warmSupply, em.u, em.tpl.rawIn, kCnt, em.tpl.outId)
          if (!nextSup) {
            replayOk = false
            break
          }
          warmSupply = nextSup
          if (meta0 && em.isleIdx === meta0.isleIndex0) {
            keptIsle0CraftEn += kCnt * em.tpl.craftSlots * craftEnCost
          }
        }

        if (replayOk && warmSupply) {
          const diffIds = [...activeTouchSet]
          const warmBaseEval = diffIds.length > 0
            ? evaluateSupplyPortfolioIncremental(adapter, {
                baseEval: jointCS.salePortfolio,
                supplyByBucket: warmSupply,
                changedItemIds: diffIds,
                slots,
                initialNatDay,
                initialCnt,
                revenueOnly: true,
              })
            : jointCS.salePortfolio
          const incJointCS = solveJointCraftAndSell(adapter, {
            initialSupplyByBucket: warmSupply,
            buckets: seqBuckets,
            slots,
            initialNatDay,
            initialCnt,
            craftCapByIsle: remCraftCap,
            enCapByBucket: remEnCap,
            staminaShadowCost: 0,
            allowCraft,
            maxCraftHoldIsleDays,
            baseEvalOverride: warmBaseEval,
            onlyTouchItemIds: activeTouchSet,
            revenueOnly: true,
          })
          if (Number.isFinite(keepAllBestScore) && keepAllBestScore >= incJointCS.netPortfolioScore) {
            invAndCraftDelta = keepAllBestScore - jointCS.netPortfolioScore
            nextCraftEn0 = keepAllCraftEn0
          } else {
            invAndCraftDelta = incJointCS.netPortfolioScore - jointCS.netPortfolioScore
            nextCraftEn0 = keptIsle0CraftEn + countIsle0CraftEn(incJointCS.craftsByBucket)
          }
          warmSolved = true
        } else if (Number.isFinite(keepAllBestScore)) {
          invAndCraftDelta = keepAllBestScore - jointCS.netPortfolioScore
          nextCraftEn0 = keepAllCraftEn0
          warmSolved = true
        }
      }
    }

    if (!warmSolved) {
      const nextSupply = applyInvDeltaToSupplyTable(supplyByBucket, invDeltaById)
      const nextRawEval = changedIds.length > 0
        ? evaluateSupplyPortfolioIncremental(adapter, {
            baseEval: jointCS.baseRawPortfolio,
            supplyByBucket: nextSupply,
            changedItemIds: changedIds,
            slots,
            initialNatDay,
            initialCnt,
            revenueOnly: true,
          })
        : jointCS.baseRawPortfolio
      const nextJointCS = solveJointCraftAndSell(adapter, {
        initialSupplyByBucket: nextSupply,
        buckets: seqBuckets,
        slots,
        initialNatDay,
        initialCnt,
        craftCapByIsle,
        enCapByBucket: nextEnCapByBucket,
        staminaShadowCost: 0,
        allowCraft,
        maxCraftHoldIsleDays,
        baseEvalOverride: nextRawEval,
        revenueOnly: true,
      })
      invAndCraftDelta = nextJointCS.netPortfolioScore - jointCS.netPortfolioScore
      nextCraftEn0 = countIsle0CraftEn(nextJointCS.craftsByBucket)
    }
  } else if (changedIds.length > 0) {
    const nextAfterCraftSupply = applyInvDeltaToSupplyTable(jointCS.supplyAfterCrafts, invDeltaById)
    const nextSaleTotal = evaluateSupplyPortfolioValueOnly(adapter, {
      baseEval: jointCS.salePortfolio,
      supplyByBucket: nextAfterCraftSupply,
      changedItemIds: changedIds,
      slots,
      initialNatDay,
      initialCnt,
    })
    invAndCraftDelta = nextSaleTotal - jointCS.salePortfolio.totalValue
  }

  let staminaDelta = 0
  if (meta0?.ksNonCraftCurve) {
    const ks = meta0.ksNonCraftCurve
    const ksAt = (e) => ks.bestAtMost[Math.max(0, Math.min(ks.E, Math.floor(e)))] || 0
    const baseFreeEn = Math.max(
      0,
      Math.floor(Number(baseWorldEn0 || 0)) - meta0.preEnSpent0 - meta0.bucketEnFloor + meta0.regenInIsleWindow - baseCraftEn0
    )
    const nextFreeEn = Math.max(
      0,
      Math.floor(Number(postRaidEn || 0)) - meta0.preEnSpent0 - meta0.bucketEnFloor + meta0.regenInIsleWindow - nextCraftEn0
    )
    if (nextFreeEn >= baseFreeEn) {
      staminaDelta = ksAt(nextFreeEn) - ksAt(baseFreeEn)
    } else {
      const baseClamped = Math.min(ks.E, baseFreeEn)
      if (nextFreeEn < baseClamped) {
        const rawWorkLoss = ksAt(baseClamped) - ksAt(nextFreeEn)
        if (rawWorkLoss > 1e-9) {
          let deficit = baseClamped - nextFreeEn
          let repCost = 0
          let coveredEn = 0
          for (const uIt of meta0.topUpUnits || []) {
            if (deficit <= 0) break
            let remQty = uIt.qty
            if (uIt.kind === 'coffee') remQty = Math.max(0, remQty - Number(coffeeUsedInPrep || 0))
            else if (invDeltaById?.[uIt.id]) {
              const eaten = Math.max(0, -(Number(invDeltaById[uIt.id][uIt.q] || 0)))
              remQty = Math.max(0, remQty - eaten)
            }
            for (let k = 0; k < remQty && deficit > 0; k++) {
              const gain = Math.min(deficit, uIt.energyGain)
              const stepCost = gain * uIt.cpe
              coveredEn += gain
              repCost += stepCost
              deficit -= gain
            }
          }
          const uncoveredLoss = ksAt(baseClamped) - ksAt(nextFreeEn + coveredEn)
          staminaDelta = -Math.min(rawWorkLoss, repCost + uncoveredLoss)
        }
      }
    }
  }

  return invAndCraftDelta + staminaDelta - Number(cashSpent || 0)
}

/**
 * Shared Unified Raid Packer used by BOTH `solveUnifiedPlan` AND `SnipeScheduler`:
 * Evaluates all legal `R.THIEF_ITEMS` combinations + cheapest stamina prep + 4-outcome guard loot
 * (`1 - pDet` `lootBag`, `pDet * pWin` `guardWinLootBag`, `pDet * pDraw` `0`, `pDet * pLoss` `-fine`)
 * with sequential conditional multi-raid packing on `marginalCtx`!
 */
export function packRaidsOnMarginalContext(adapter, {
  worldAtNow,
  marginalCtx,
  eligibleRawBeliefs,
  rawNeighborTargetsById = null,
  constraints,
  allowedSet,
  utilityTokens,
  remStealBudget = 1,
  mustIncludeTargetId = null,
  isPastDeadlineFn = null,
}) {
  const refreshed0 = adapter.advanceTimeOnly(worldAtNow, worldAtNow.now)
  const baseInvSnap = adapter.availableInvSnapshot(refreshed0.state)
  const buffCombos = buildThiefBuffCombinations(adapter, refreshed0, constraints, allowedSet)

  let bestOption = null
  let bestNoRaidPrepFloor = 0
  const crossBuffStateMemo = new Map()

  for (const buffCombo of buffCombos) {
    if (isPastDeadlineFn?.()) break
    let wAfterBuff = refreshed0
    if (buffCombo.length > 0) {
      const totalBuffCost = buffCombo.reduce((s, a) => s + Number(adapter.R.THIEF_ITEMS?.[a.id]?.price || 0), 0)
      if (Number(refreshed0.coins || 0) - Number(constraints.cashReserveFloor || 0) < totalBuffCost) continue
      const step = adapter.simulateBatch(refreshed0, buffCombo, { t: refreshed0.now, prices: refreshed0.prices })
      if (!step.allOk) continue
      wAfterBuff = step.afterWorld
    }

    const updatedBeliefs = eligibleRawBeliefs.map((rb) =>
      rawNeighborTargetsById?.has(rb.targetId)
        ? buildVisitTargetBelief(adapter, wAfterBuff, rawNeighborTargetsById.get(rb.targetId), wAfterBuff.now)
        : recomputeVisitBeliefForVisitor(adapter, rb, wAfterBuff, wAfterBuff.now)
    )
    const reqTarget = mustIncludeTargetId != null
      ? updatedBeliefs.find((ub) => ub.targetId === mustIncludeTargetId)
      : null
    if (mustIncludeTargetId != null && !reqTarget) continue

    const minTargetEn = reqTarget
      ? reqTarget.energyCost
      : Math.min(...updatedBeliefs.map((ub) => ub.energyCost))
    const prepRes = findCheapestRaidStaminaPrep(adapter, wAfterBuff, minTargetEn, allowedSet, utilityTokens, constraints)
    if (!prepRes.feasible) continue

    const fullPrepActs = [...buffCombo, ...prepRes.prepActs]
    const cashSpent = Math.max(0, Number(refreshed0.coins || 0) - Number(prepRes.afterWorld.coins || 0))
    const coffeeUsedInPrep = prepRes.prepActs.filter((a) => a.a === 'coffee').length
    const afterPrepSnap = adapter.availableInvSnapshot(prepRes.afterWorld.state)
    const prepInvDelta = {}
    const allSnapIds = new Set([...Object.keys(baseInvSnap), ...Object.keys(afterPrepSnap)])
    for (const id of allSnapIds) {
      const r0 = baseInvSnap[id] || [0, 0, 0]
      const r1 = afterPrepSnap[id] || [0, 0, 0]
      if (r1[0] !== r0[0] || r1[1] !== r0[1] || r1[2] !== r0[2]) {
        prepInvDelta[id] = [r1[0] - r0[0], r1[1] - r0[1], r1[2] - r0[2]]
      }
    }

    const evalStateDelta = (enVal, invDeltaMap) => {
      const mKey = `${enVal}:${coffeeUsedInPrep}:${JSON.stringify(invDeltaMap)}`
      let baseHit = crossBuffStateMemo.get(mKey)
      if (baseHit === undefined) {
        baseHit = evaluateMarginalRaidDelta(adapter, marginalCtx, {
          invDeltaById: invDeltaMap,
          postRaidEn: enVal,
          cashSpent: 0,
          coffeeUsedInPrep,
        })
        crossBuffStateMemo.set(mKey, baseHit)
      }
      return baseHit - Number(cashSpent || 0)
    }

    const startEn = Number(prepRes.afterWorld.state?.en || 0)
    const baseAfterPrepDelta = evalStateDelta(startEn, prepInvDelta)
    if (buffCombo.length === 0) {
      bestNoRaidPrepFloor = Math.max(bestNoRaidPrepFloor, baseAfterPrepDelta)
    }

    let ensemble = [{ prob: 1.0, en: startEn, invDelta: prepInvDelta, val: baseAfterPrepDelta }]
    const remainingPool = [...updatedBeliefs]
    const packed = []
    let sumScore = 0
    const maxPackCount = Math.min(remStealBudget, remainingPool.length, 3)

    for (let stepIdx = 0; stepIdx < maxPackCount; stepIdx++) {
      if (isPastDeadlineFn?.()) break
      const minBranchEn = Math.min(...ensemble.map((br) => br.en))
      let bestIdx = -1
      let bestCand = null
      let bestNextEnsemble = null

      // When `mustIncludeTargetId != null`, step 0 evaluates ONLY `mustIncludeTargetId` first so its standalone/first-step eligibility is tested cleanly!
      for (let cIdx = 0; cIdx < remainingPool.length; cIdx++) {
        if (isPastDeadlineFn?.()) break
        const vb = remainingPool[cIdx]
        if (stepIdx === 0 && mustIncludeTargetId != null && vb.targetId !== mustIncludeTargetId) continue
        if (vb.energyCost > minBranchEn) continue

        const pDet = vb.hasGuard ? vb.detectionProb : 0
        const pUndet = 1 - pDet
        const wLo = vb.winInterval[0]
        const wHi = vb.winInterval[1]
        const wMid = 0.5 * (wLo + wHi)
        const lHi = Math.min(1 - wLo, vb.lossInterval[1])
        const lLo = Math.min(1 - wHi, vb.lossInterval[0])
        const lMid = Math.min(1 - wMid, 0.5 * (vb.lossInterval[0] + vb.lossInterval[1]))
        const dLo = Math.max(0, 1 - wLo - lHi)
        const dHi = Math.max(0, 1 - wHi - lLo)
        const dMid = Math.max(0, 1 - wMid - lMid)

        let curEnsembleVal = 0
        let wUndetExpected = 0
        let wGuardWinExpected = 0
        let wEmptyExpected = 0
        const nextBranches = []

        const wBranch = vb.estimationSource === 'unobserved-wide-prior' ? wLo : wMid

        for (const br of ensemble) {
          curEnsembleVal += br.prob * br.val
          const enAfter = Math.max(0, br.en - vb.energyCost)
          const invUndet = addBagToInvDelta(br.invDelta, vb.lootBag)
          const vUndet = evalStateDelta(enAfter, invUndet)
          wUndetExpected += br.prob * vUndet

          let vGuardWin = vUndet
          let vEmpty = vUndet
          let invGuardWin = invUndet

          if (pDet > 1e-9) {
            if (wHi > 1e-9) {
              invGuardWin = addBagToInvDelta(br.invDelta, vb.guardWinLootBag || vb.lootBag)
              vGuardWin = evalStateDelta(enAfter, invGuardWin)
            } else {
              vGuardWin = 0
            }
            vEmpty = evalStateDelta(enAfter, br.invDelta)
          }
          wGuardWinExpected += br.prob * vGuardWin
          wEmptyExpected += br.prob * vEmpty

          if (br.prob * pUndet > 1e-6) {
            nextBranches.push({ prob: br.prob * pUndet, en: enAfter, invDelta: invUndet, val: vUndet })
          }
          if (pDet > 1e-9 && br.prob * pDet * wBranch > 1e-6) {
            nextBranches.push({ prob: br.prob * pDet * wBranch, en: enAfter, invDelta: invGuardWin, val: vGuardWin })
          }
          const pNoLoot = pDet * Math.max(0, 1 - wBranch)
          if (br.prob * pNoLoot > 1e-6) {
            nextBranches.push({ prob: br.prob * pNoLoot, en: enAfter, invDelta: br.invDelta, val: vEmpty })
          }
        }

        const fine = Number(vb.estimatedFineOnLoss || 0)
        const evLo = pUndet * wUndetExpected
          + pDet * (wLo * wGuardWinExpected + (dLo + lHi) * wEmptyExpected - lHi * fine)
          - curEnsembleVal
        const evHi = pUndet * wUndetExpected
          + pDet * (wHi * wGuardWinExpected + (dHi + lLo) * wEmptyExpected - lLo * fine)
          - curEnsembleVal
        const evMid = pUndet * wUndetExpected
          + pDet * (wMid * wGuardWinExpected + (dMid + lMid) * wEmptyExpected - lMid * fine)
          - curEnsembleVal
        const decisionScore = vb.estimationSource === 'unobserved-wide-prior' ? evLo : evMid

        // Every raid step must strictly add positive value (`decisionScore > 1e-6`) over `afterPrepWorld`
        // (never piggybacking a negative-EV raid on domestic coffee/food stamina surplus!).
        const allowStep = decisionScore > 1e-6
        if (allowStep && (!bestCand || decisionScore > bestCand.decisionScore + 1e-6)) {
          bestIdx = cIdx
          bestCand = {
            targetId: vb.targetId,
            targetName: vb.targetName,
            totalSpots: vb.totalSpots,
            lootBag: vb.lootBag,
            guardWinLootBag: vb.guardWinLootBag || vb.lootBag,
            energyCost: vb.energyCost,
            detectionProb: pDet,
            hasGuard: vb.hasGuard,
            expectedDeltaObjectiveMid: evMid,
            expectedDeltaObjectiveInterval: [evLo, evHi],
            estimationSource: vb.estimationSource,
            decisionScore,
            tacticalDecision: vb.tacticalDecision || null,
            optimalLoadout: vb.optimalLoadout || null,
            numGearChanges: vb.numGearChanges || 0,
            belief: vb,
          }
          nextBranches.sort((a, b2) => b2.prob - a.prob)
          const kept = nextBranches.slice(0, 4)
          const pSum = kept.reduce((s, x) => s + x.prob, 0) || 1
          bestNextEnsemble = kept.map((x) => ({ ...x, prob: x.prob / pSum }))
        }
      }

      if (!bestCand) break
      packed.push(bestCand)
      sumScore += bestCand.decisionScore
      ensemble = bestNextEnsemble
      remainingPool.splice(bestIdx, 1)
    }

    if (packed.length === 0) continue
    if (mustIncludeTargetId != null && packed[0]?.targetId !== mustIncludeTargetId) continue

    const totalNetDelta = baseAfterPrepDelta + sumScore
    if (totalNetDelta > bestNoRaidPrepFloor + 1e-6 && (!bestOption || totalNetDelta > bestOption.totalNetDelta + 1e-6)) {
      bestOption = {
        totalNetDelta,
        baseAfterPrepDelta,
        buffActs: buffCombo,
        staminaPrepActs: prepRes.prepActs,
        prepActs: fullPrepActs,
        afterPrepWorld: prepRes.afterWorld,
        visits: packed.slice(0, 1),
        packedAll: packed,
        combinedRaidDeltaMid: packed.reduce((s, v) => s + v.expectedDeltaObjectiveMid, 0),
      }
    }
  }

  return bestOption
}

/**
 * Resident Fast Unified Raid Evaluator (`< 5ms` per target wave after one baseline build per `world.rev`):
 * Used by `SnipeScheduler` and `live-daemon` so discovery, wave timing, staging, and `T_unlock` execution
 * ALL share the exact same unified economic brain as `solveUnifiedPlan` with ZERO heuristic shadow prices!
 */
export function createUnifiedRaidEvaluator(adapter, world, {
  account = 'main',
  objectiveCfg: objectiveCfgInput = {},
  userConstraints = {},
  knownSoldByIsleIndex = null,
  partnerWorld = null,
  scenarios: customScenarios = null,
  precomputedMarginalContext = null,
  maxBuckets = 12,
} = {}) {
  const objectiveCfg = objectiveCfgInput?.objectiveHash
    ? objectiveCfgInput
    : buildObjectiveConfig(objectiveCfgInput)
  const world0 = adapter.cloneWorld(world)
  adapter.syncClock(world0.clockStart)
  const utilityTokens = discoverRuleUtilityTokens(adapter)
  const envelope = buildObservationEnvelope(adapter, {
    account,
    world: world0,
    neighborTargets: [],
    knownSoldByIsleIndex,
    partnerWorld,
    userConstraints,
    scenarios: customScenarios || undefined,
  })
  const constraints = envelope.constraints
  const allowedSet = new Set([
    'harvest', 'plant', 'water', 'clear',
    'collect', 'feed', 'pet', 'trap',
    'mine', 'fish', 'bomb', 'craft',
    'sell', 'buy', 'stockBuy', 'eat', 'coffee',
    'goal', 'visit', 'wait',
  ])

  const curStaticFarmDigest = computeStaticFarmStateDigest(world0)
  let marginalCtx = precomputedMarginalContext
  if (
    marginalCtx &&
    ((marginalCtx.sourceFarmDigest != null
      ? marginalCtx.sourceFarmDigest !== curStaticFarmDigest
      : (marginalCtx.sourceWorldRev != null && world0.rev != null && marginalCtx.sourceWorldRev !== world0.rev)) ||
      (marginalCtx.sourceIsleIndex != null && marginalCtx.sourceIsleIndex !== adapter.R.isleIndex(world0.now)) ||
      (marginalCtx.sourceWorldDay != null && marginalCtx.sourceWorldDay !== adapter.R.worldDay(world0.now)))
  ) {
    marginalCtx = null
  }
  if (!marginalCtx) {
    const baseSoldByIsle = new Map()
    if (knownSoldByIsleIndex && typeof knownSoldByIsleIndex === 'object') {
      const entries = knownSoldByIsleIndex instanceof Map ? [...knownSoldByIsleIndex.entries()] : Object.entries(knownSoldByIsleIndex)
      for (const [k, v] of entries) {
        if (v && typeof v === 'object') baseSoldByIsle.set(Number(k), { ...v })
      }
    }
    const scenarios = envelope.beliefs.scenarios
    const tl = buildEventBuckets(adapter, world0, { horizonSec: objectiveCfg.horizonSec, maxBuckets })
    const expectedPriceFn = (bucket, soldByIsle) => {
      if (bucket.isleDayOffset === 0) return world0.prices || {}
      const prevSoldMap = soldByIsle.get(bucket.isleIndex - 1) || {}
      const avg = {}
      for (const id of adapter.graph.sellableIds) {
        let wSum = 0
        for (const sc of scenarios) {
          wSum += sc.weight * quoteFutureItemUnderScenario(adapter, {
            itemId: id,
            isleDayIndex: bucket.isleDayOffset,
            isleDayStr: bucket.isleDay,
            currentPrices: world0.prices || {},
            externalSupplyFactor: sc.externalSupplyFactor,
            selfSoldPrevIsleDay: Number(prevSoldMap[id] || 0),
          })
        }
        avg[id] = Math.round(wSum)
      }
      return avg
    }
    const baseRun = optimizeAndSimulateSequence(adapter, {
      startWorld: world0,
      initialWorldForObjective: world0,
      seqBuckets: tl.buckets,
      pricesForBucketFn: expectedPriceFn,
      objectiveCfg,
      constraints,
      allowedSet,
      utilityTokens,
      initialSoldByIsle: baseSoldByIsle,
      scenarioSupplyFactor: scenarios.reduce((s, x) => s + x.weight * x.externalSupplyFactor, 0),
      skipObjectiveEval: true,
    })
    marginalCtx = baseRun.marginalContext
  }

  return {
    marginalContext: marginalCtx,
    constraints,
    evaluateTargetWave(rawTargetBundle, evalAtSec = world0.now, {
      visitorWorldOverride = null,
      extraUpcomingBundles = [],
      remStealBudget = 3,
    } = {}) {
      if (constraints.maxStealsPerIsleDay === 0 || !(remStealBudget > 0)) {
        return { profitable: false, decisionScore: -Infinity, totalNetDelta: -Infinity }
      }
      const baseVis = visitorWorldOverride || world0
      const visAtT = evalAtSec > baseVis.now
        ? adapter.advanceTimeOnly(baseVis, evalAtSec, { futurePrices: baseVis.prices || {} })
        : baseVis
      const targetId = Number(rawTargetBundle.id ?? rawTargetBundle.targetId ?? rawTargetBundle.owner?.id)
      const primaryBelief = buildVisitTargetBelief(adapter, visAtT, rawTargetBundle, visAtT.now)
      if (!primaryBelief || !(primaryBelief.totalSpots > 0)) {
        return { profitable: false, decisionScore: -Infinity, totalNetDelta: -Infinity, belief: primaryBelief }
      }

      const rawMap = new Map([[targetId, rawTargetBundle]])
      const beliefs = [primaryBelief]
      for (const ex of extraUpcomingBundles.slice(0, 2)) {
        const exId = Number(ex.id ?? ex.targetId ?? ex.owner?.id)
        if (!exId || exId === targetId) continue
        const exB = buildVisitTargetBelief(adapter, visAtT, ex, visAtT.now)
        if (exB && exB.totalSpots > 0) {
          rawMap.set(exId, ex)
          beliefs.push(exB)
        }
      }

      const opt = packRaidsOnMarginalContext(adapter, {
        worldAtNow: visAtT,
        marginalCtx,
        eligibleRawBeliefs: beliefs,
        rawNeighborTargetsById: rawMap,
        constraints,
        allowedSet,
        utilityTokens,
        remStealBudget: Math.min(remStealBudget, beliefs.length),
        mustIncludeTargetId: targetId,
      })

      if (!opt || !opt.visits[0]) {
        return {
          profitable: false,
          decisionScore: -Infinity,
          totalNetDelta: -Infinity,
          belief: primaryBelief,
          neededEn: primaryBelief.energyCost,
          tacticalDecision: primaryBelief.tacticalDecision || null,
          optimalLoadout: primaryBelief.optimalLoadout || null,
          numGearChanges: primaryBelief.numGearChanges || 0,
        }
      }

      const v0 = opt.visits[0]
      return {
        profitable: true,
        decisionScore: opt.totalNetDelta,
        totalNetDelta: opt.totalNetDelta,
        standaloneDecisionScore: v0.decisionScore,
        evMid: v0.expectedDeltaObjectiveMid,
        evInterval: v0.expectedDeltaObjectiveInterval,
        buffActs: opt.buffActs,
        staminaPrepActs: opt.staminaPrepActs,
        prepActs: opt.prepActs,
        neededEn: v0.energyCost,
        belief: v0.belief || primaryBelief,
        tacticalDecision: v0.tacticalDecision || null,
        optimalLoadout: v0.optimalLoadout || null,
        numGearChanges: v0.numGearChanges || 0,
      }
    },
  }
}
