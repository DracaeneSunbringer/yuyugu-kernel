import crypto from 'node:crypto'
import {
  buildObjectiveConfig,
  buildTerminalPrices,
  discountFactor,
  evaluateTrajectoryObjective,
} from '../model/objective.mjs'
import {
  buildObservationEnvelope,
  buildVisitTargetBelief,
  quoteFutureItemUnderScenario,
  recomputeVisitBeliefForVisitor,
} from '../model/observations.mjs'
import {
  applyExogenousArrivals,
  buildEventBuckets,
  deductRecipeLowStarFirst,
  expectedBombYield,
  expectedFishYieldPerCast,
  expectedHarvestYield,
  expectedMineYieldPerHit,
} from './resources.mjs'
import { computeValidUpperBound } from './bounds.mjs'
import { computeCausalStochasticPrefix } from './compile-prefix.mjs'

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
function solveExactItemSaleSchedule(adapter, {
  itemId,
  supplyByBucket, // Array< [n0, n1, n2] > of length L
  slots,          // Array<{ slotIdx, bucketIdx, atSec, naturalDay, prices, isTerminal, disc }>
  initialNatDay,
  initialScCount,
}) {
  const { R, graph } = adapter
  const isCrop = graph.cropsById.has(itemId)
  const L = supplyByBucket.length

  if (!isCrop) {
    // Non-crops have no daily tier decay: each (u, q) independently picks highest discounted unit revenue slot s >= u
    const sellsBySlot = slots.map(() => [0, 0, 0])
    let totalWeightedRevenue = 0
    for (let u = 0; u < L; u++) {
      const row = supplyByBucket[u]
      if (!row) continue
      for (const q of [2, 1, 0]) {
        const cnt = Math.floor(Number(row[q] || 0))
        if (!(cnt > 0)) continue
        let bestSlotIdx = -1
        let bestUnitVal = 0
        for (let s = 0; s < slots.length; s++) {
          const sl = slots[s]
          if (!sl.allowSell || sl.availFromBucket < u) continue
          const p = Number(sl.prices?.[itemId] || 0)
          if (!(p > 0)) continue
          const unit = Math.round(p * (R.QUALITY?.[q] ?? 1)) * sl.disc * sl.netTaxFactor
          if (unit > bestUnitVal + 1e-9) {
            bestUnitVal = unit
            bestSlotIdx = s
          }
        }
        if (bestSlotIdx >= 0) {
          sellsBySlot[bestSlotIdx][q] += cnt
          totalWeightedRevenue += cnt * bestUnitVal
        }
      }
    }
    return { sellsBySlot, totalWeightedRevenue }
  }

  // Crop case: concave natural-day tiers [150 @ 1.0, 250 @ 0.85, inf @ 0.70]
  const supplyNodes = []
  let totalSupply = 0
  for (let u = 0; u < L; u++) {
    const row = supplyByBucket[u]
    if (!row) continue
    for (const q of [2, 1, 0]) {
      const cnt = Math.floor(Number(row[q] || 0))
      if (cnt > 0) {
        supplyNodes.push({ u, q, cnt })
        totalSupply += cnt
      }
    }
  }
  const sellsBySlot = slots.map(() => [0, 0, 0])
  if (supplyNodes.length === 0) {
    return { sellsBySlot, totalWeightedRevenue: 0 }
  }

  // Exact Tier-0 Non-Binding Fast Path:
  // When `initialScCount + totalSupply <= 150`, Tier 0 (1.0x) has >= totalSupply remaining capacity on EVERY natural day!
  // Thus Tier 1 (0.85x) and Tier 2 (0.70x) can never be entered, reducing exact global assignment to O(P * |slots|) with zero graph allocations!
  if (initialScCount + totalSupply <= 150) {
    let totalWeightedRevenue = 0
    for (let i = 0; i < supplyNodes.length; i++) {
      const { u, q, cnt } = supplyNodes[i]
      let bestSlotIdx = -1
      let bestUnitVal = 0
      const qual = R.QUALITY?.[q] ?? 1
      for (let s = 0; s < slots.length; s++) {
        const sl = slots[s]
        if (!sl.allowSell || sl.availFromBucket < u) continue
        const p = Number(sl.prices?.[itemId] || 0)
        if (!(p > 0)) continue
        const unit = Math.round(p * qual) * sl.disc * sl.netTaxFactor
        if (unit > bestUnitVal + 1e-9) {
          bestUnitVal = unit
          bestSlotIdx = s
        }
      }
      if (bestSlotIdx >= 0) {
        sellsBySlot[bestSlotIdx][q] += cnt
        totalWeightedRevenue += cnt * bestUnitVal
      }
    }
    return { sellsBySlot, totalWeightedRevenue }
  }

  const natDays = []
  const natDayMap = new Map()
  for (const sl of slots) {
    if (!sl.allowSell) continue
    if (!natDayMap.has(sl.naturalDay)) {
      natDayMap.set(sl.naturalDay, natDays.length)
      natDays.push(sl.naturalDay)
    }
  }
  if (natDays.length === 0) {
    return { sellsBySlot, totalWeightedRevenue: 0 }
  }

  // Build min-cost max-flow (costs = -gain)
  // Nodes: 0 = SRC, 1..P = supplyNodes, P+1..P+3*D = (ndIdx, tier), last = SNK
  const P = supplyNodes.length
  const D = natDays.length
  const SRC = 0
  const SNK = 1 + P + 3 * D
  const N = SNK + 1
  const adj = Array.from({ length: N }, () => [])

  const addEdge = (from, to, cap, cost, meta = null) => {
    const fwd = { to, rev: adj[to].length, cap, cost, flow: 0, meta }
    const bwd = { to: from, rev: adj[from].length, cap: 0, cost: -cost, flow: 0, meta: null }
    adj[from].push(fwd)
    adj[to].push(bwd)
  }

  for (let i = 0; i < P; i++) {
    addEdge(SRC, 1 + i, supplyNodes[i].cnt, 0)
    // Allow holding unsold with 0 value if all slots have 0 price
    addEdge(1 + i, SNK, supplyNodes[i].cnt, 0, { slotIdx: -1, q: supplyNodes[i].q })
  }

  const tierMults = [1.0, 0.85, 0.70]
  for (let dIdx = 0; dIdx < D; dIdx++) {
    const nd = natDays[dIdx]
    const sc0 = nd === initialNatDay ? initialScCount : 0
    const cap0 = Math.max(0, 150 - sc0)
    const cap1 = Math.max(0, 400 - Math.max(150, sc0))
    const caps = [cap0, cap1, totalSupply]
    for (let t = 0; t < 3; t++) {
      const tierNode = 1 + P + dIdx * 3 + t
      if (caps[t] > 0) addEdge(tierNode, SNK, caps[t], 0)
    }
  }

  // Connect each supplyNode (u, q) to best slot s >= u within each naturalDay dIdx
  for (let i = 0; i < P; i++) {
    const { u, q, cnt } = supplyNodes[i]
    for (let dIdx = 0; dIdx < D; dIdx++) {
      const nd = natDays[dIdx]
      let bestSlotIdx = -1
      let bestBaseUnit = 0
      for (let s = 0; s < slots.length; s++) {
        const sl = slots[s]
        if (!sl.allowSell || sl.naturalDay !== nd || sl.availFromBucket < u) continue
        const p = Number(sl.prices?.[itemId] || 0)
        if (!(p > 0)) continue
        const val = Math.round(p * (R.QUALITY?.[q] ?? 1)) * sl.disc * sl.netTaxFactor
        if (val > bestBaseUnit + 1e-9) {
          bestBaseUnit = val
          bestSlotIdx = s
        }
      }
      if (bestSlotIdx >= 0) {
        const sl = slots[bestSlotIdx]
        const rawUnit = Math.round(Number(sl.prices[itemId]) * (R.QUALITY?.[q] ?? 1))
        for (let t = 0; t < 3; t++) {
          const tierNode = 1 + P + dIdx * 3 + t
          const gain = rawUnit * tierMults[t] * sl.disc * sl.netTaxFactor
          addEdge(1 + i, tierNode, cnt, -gain, { slotIdx: bestSlotIdx, q })
        }
      }
    }
  }

  // SPFA Successive Shortest Path with O(1) ring-buffer queue
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
      const edges = adj[v]
      for (let eIdx = 0; eIdx < edges.length; eIdx++) {
        const e = edges[eIdx]
        if (e.cap - e.flow <= 0) continue
        const ndist = dist[v] + e.cost
        if (ndist < dist[e.to] - 1e-9) {
          dist[e.to] = ndist
          parentNode[e.to] = v
          parentEdge[e.to] = eIdx
          if (!inQueue[e.to]) {
            ringQueue[qTail] = e.to
            qTail = (qTail + 1) % qCap
            inQueue[e.to] = 1
          }
        }
      }
    }

    if (!Number.isFinite(dist[SNK])) break
    let push = Infinity
    for (let cur = SNK; cur !== SRC; cur = parentNode[cur]) {
      const e = adj[parentNode[cur]][parentEdge[cur]]
      if (e.cap - e.flow < push) push = e.cap - e.flow
    }
    if (!(push > 0) || !Number.isFinite(push)) break
    for (let cur = SNK; cur !== SRC; cur = parentNode[cur]) {
      const p = parentNode[cur]
      const e = adj[p][parentEdge[cur]]
      e.flow += push
      adj[cur][e.rev].flow -= push
    }
    totalCost += push * dist[SNK]
  }

  for (let i = 0; i < P; i++) {
    for (const e of adj[1 + i]) {
      if (e.flow > 0 && e.meta && e.meta.slotIdx >= 0) {
        sellsBySlot[e.meta.slotIdx][e.meta.q] += e.flow
      }
    }
  }

  return {
    sellsBySlot,
    totalWeightedRevenue: -totalCost,
  }
}

/**
 * Builds canonical recipe & multi-step chain templates dynamically from `adapter.graph`.
 * Completely invariant to `R.RECIPES` permutation!
 */
function buildCanonicalCraftTemplates(adapter) {
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
}) {
  const itemSet = new Set()
  for (const bm of supplyByBucket) {
    for (const id of Object.keys(bm)) itemSet.add(id)
  }
  const perItem = new Map()
  let totalValue = 0
  for (const id of itemSet) {
    if (!(Number(adapter.R.BASE_PRICE?.[id] || 0) > 0)) continue
    const perBucketRows = supplyByBucket.map((bm) => bm[id] || [0, 0, 0])
    const initSc = Number(initialCnt?.['sc_' + id] || 0)
    const sched = solveExactItemSaleSchedule(adapter, {
      itemId: id,
      supplyByBucket: perBucketRows,
      slots,
      initialNatDay,
      initialScCount: initSc,
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
}) {
  const nextPerItem = new Map(baseEval.perItem)
  let nextTotal = baseEval.totalValue

  for (const id of changedItemIds) {
    if (!(Number(adapter.R.BASE_PRICE?.[id] || 0) > 0)) continue
    const oldSched = nextPerItem.get(id)
    if (oldSched) nextTotal -= oldSched.totalWeightedRevenue
    const perBucketRows = supplyByBucket.map((bm) => bm[id] || [0, 0, 0])
    const hasAny = perBucketRows.some((r) => (r[0] || 0) + (r[1] || 0) + (r[2] || 0) > 0)
    if (!hasAny) {
      nextPerItem.delete(id)
      continue
    }
    const initSc = Number(initialCnt?.['sc_' + id] || 0)
    const sched = solveExactItemSaleSchedule(adapter, {
      itemId: id,
      supplyByBucket: perBucketRows,
      slots,
      initialNatDay,
      initialScCount: initSc,
    })
    nextPerItem.set(id, sched)
    nextTotal += sched.totalWeightedRevenue
  }

  return { totalValue: nextTotal, perItem: nextPerItem }
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
}) {
  const L = buckets.length
  const baseEval = baseEvalOverride || evaluateSupplyPortfolio(adapter, {
    supplyByBucket: initialSupplyByBucket,
    slots,
    initialNatDay,
    initialCnt,
  })

  if (!allowCraft || L === 0) {
    return {
      craftsByBucket: buckets.map(() => []),
      supplyAfterCrafts: initialSupplyByBucket,
      baseRawPortfolio: baseEval,
      salePortfolio: baseEval,
      netPortfolioScore: baseEval.totalValue,
    }
  }

  const templates = buildCanonicalCraftTemplates(adapter)
  const craftEnCost = adapter.R.WORLD?.cost?.craft ?? 1

  // Filter templates that could ever be feasible with total horizon supply
  const totalRaw = {}
  for (let u = 0; u < L; u++) {
    for (const [id, r] of Object.entries(initialSupplyByBucket[u])) {
      totalRaw[id] = (totalRaw[id] || 0) + (r[0] || 0) + (r[1] || 0) + (r[2] || 0)
    }
  }
  const baseOriginOffset = buckets[0]?.isleDayOffset ?? 0
  const candidateMoves = [] // { moveId, tpl, u, isleIdx }
  for (let u = 0; u < L; u++) {
    const isleIdx = buckets[u].isleIndex
    if ((craftCapByIsle.get(isleIdx) || 0) <= 0 || (enCapByBucket[u] || 0) < craftEnCost) continue
    for (const tpl of templates) {
      if (tpl.craftSlots > (craftCapByIsle.get(isleIdx) || 0)) continue
      if (tpl.craftSlots * craftEnCost > (enCapByBucket[u] || 0)) continue
      const possible = Object.entries(tpl.rawIn).every(([inId, need]) => (totalRaw[inId] || 0) >= need)
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
      supplyAfterCrafts: initialSupplyByBucket,
      baseRawPortfolio: baseEval,
      salePortfolio: baseEval,
      netPortfolioScore: baseEval.totalValue,
    }
  }

  // Estimate maximum total craft steps possible from raw inputs & quotas
  let maxMaterialCrafts = 0
  for (const mv of candidateMoves) {
    const lim = Math.min(
      craftCapByIsle.get(mv.isleIdx) || 0,
      ...Object.entries(mv.tpl.rawIn).map(([inId, need]) => Math.floor((totalRaw[inId] || 0) / need))
    )
    maxMaterialCrafts = Math.max(maxMaterialCrafts, lim)
  }

  const applyMoveOnce = (supply, mv, count = 1) =>
    deductFromPrefixSupply(supply, mv.u, mv.tpl.rawIn, count, mv.tpl.outId)

  // Exact DFS with canonical non-decreasing move index when search space is compact
  if (candidateMoves.length <= 14 && maxMaterialCrafts <= 8) {
    let bestScore = baseEval.totalValue
    let bestSupply = initialSupplyByBucket
    let bestEval = baseEval
    let bestCounts = new Int32Array(candidateMoves.length)
    let visitedNodes = 0
    const MAX_EXACT_NODES = 600

    const remCraft = new Map(craftCapByIsle)
    const remEn = Float64Array.from(enCapByBucket)
    const curCounts = new Int32Array(candidateMoves.length)

    const dfs = (startIdx, curSupply, curEval, spentStaminaCost) => {
      if (++visitedNodes > MAX_EXACT_NODES) return
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
        // Prefix stamina constraint: spending enNeed at mv.u reduces stamina for u..L-1
        let enOk = true
        for (let fb = mv.u; fb < L; fb++) {
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
        })

        remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) - slotsNeed)
        for (let fb = mv.u; fb < L; fb++) remEn[fb] -= enNeed
        curCounts[i]++

        dfs(i, nextSup, nextEval, spentStaminaCost + enNeed * staminaShadowCost)

        curCounts[i]--
        for (let fb = mv.u; fb < L; fb++) remEn[fb] += enNeed
        remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) + slotsNeed)
      }
    }

    dfs(0, initialSupplyByBucket, baseEval, 0)

    const craftsByBucket = buckets.map(() => [])
    for (let i = 0; i < candidateMoves.length; i++) {
      const cnt = bestCounts[i]
      if (cnt > 0) {
        const mv = candidateMoves[i]
        for (const step of mv.tpl.actions) {
          craftsByBucket[mv.u].push({ a: 'craft', id: step.id, n: step.n * cnt })
        }
      }
    }
    return {
      craftsByBucket: craftsByBucket.map(mergeCraftActionsPreserveTopo),
      supplyAfterCrafts: bestSupply,
      baseRawPortfolio: baseEval,
      salePortfolio: bestEval,
      netPortfolioScore: bestScore,
    }
  }

  // Large-scale case: iterative highest marginal gain per craft slot with exact separable per-item cache
  let curSupply = cloneSupplyTable(initialSupplyByBucket)
  let curEval = baseEval
  let curSpentStaminaCost = 0
  const remCraft = new Map(craftCapByIsle)
  const remEn = Float64Array.from(enCapByBucket)
  const chosenCounts = new Int32Array(candidateMoves.length)
  // Cache `{ desiredChunk, actualChunk, ratio, feasible }` for moves whose `changedIds` were not touched!
  const moveCache = new Array(candidateMoves.length).fill(null)

  for (let guard = 0; guard < 120; guard++) {
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
      for (let fb = mv.u; fb < L; fb++) {
        maxEnMult = Math.min(maxEnMult, Math.floor(remEn[fb] / enNeed))
      }
      if (maxEnMult <= 0) continue

      const desiredChunk = maxEnMult >= 8 ? 4 : 1
      let cached = moveCache[i]
      if (!cached || cached.desiredChunk !== desiredChunk) {
        let actualChunk = desiredChunk
        let nextSup = applyMoveOnce(curSupply, mv, desiredChunk)
        if (!nextSup && desiredChunk > 1) {
          actualChunk = 1
          nextSup = applyMoveOnce(curSupply, mv, 1)
        }
        if (!nextSup) {
          cached = { desiredChunk, feasible: false, actualChunk: 0, ratio: -Infinity }
        } else {
          const ev = evaluateSupplyPortfolioIncremental(adapter, {
            baseEval: curEval,
            supplyByBucket: nextSup,
            changedItemIds: mv.changedIds,
            slots,
            initialNatDay,
            initialCnt,
          })
          const delta = (ev.totalValue - curEval.totalValue) - (actualChunk * enNeed * staminaShadowCost)
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
    })
    const slotsUsed = mv.tpl.craftSlots * bestChunk
    const enUsed = slotsUsed * craftEnCost
    remCraft.set(mv.isleIdx, remCraft.get(mv.isleIdx) - slotsUsed)
    for (let fb = mv.u; fb < L; fb++) remEn[fb] -= enUsed
    chosenCounts[bestIdx] += bestChunk
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

  return {
    craftsByBucket: craftsByBucket.map(mergeCraftActionsPreserveTopo),
    supplyAfterCrafts: curSupply,
    baseRawPortfolio: baseEval,
    salePortfolio: curEval,
    netPortfolioScore: curEval.totalValue - curSpentStaminaCost,
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
 * using exact weather-segment timings, regrow season-wither rule (`pet-world-rules.js:411,522`),
 * and marginal downstream item values.
 */
function selectBestCropToPlant(adapter, {
  state,
  plotIdx,
  atSec,
  tEnd,
  marginalItemValueFn,
  staminaPointCost = 0,
}) {
  const { R } = adapter
  const iDay = R.isleDay(atSec)
  const season = R.seasonOf(iDay)
  const isSpr = R.sprinkled(state, plotIdx)
  let bestCrop = null
  let bestNet = 0

  for (const crop of R.CROPS || []) {
    if (!crop.seasons.includes(season)) continue
    let simT = atSec
    let h = 0
    const maxTimes = crop.regrow ? (crop.times || 1) : 1
    let totalExpectedRevenue = 0
    let totalStaminaSpent = R.WORLD?.cost?.plant ?? 2

    while (h < maxTimes) {
      if (!crop.seasons.includes(R.seasonOf(R.isleDay(simT)))) {
        // Regrow planted at simT across season change immediately withers (`stage = -1`) and needs `clear`!
        totalStaminaSpent += R.WORLD?.cost?.clear ?? 1
        break
      }
      const mockPlot = { c: crop.id, t: simT, w: 0, g: 0, h }
      const timing = adapter.exactPlotTimings(mockPlot, isSpr, simT)
      if (!timing || timing.matureAt > tEnd) break

      const wateredStages = isSpr || R.weatherOf(R.isleDay(simT)) === 1 ? 3 : 2
      if (!isSpr && R.weatherOf(R.isleDay(simT)) !== 1) {
        totalStaminaSpent += wateredStages * (R.WORLD?.cost?.water ?? 1)
      }
      totalStaminaSpent += R.WORLD?.cost?.harvest ?? 1

      const yld = expectedHarvestYield(adapter, wateredStages, false)
      for (let q = 0; q < 3; q++) {
        totalExpectedRevenue += yld.expectedByQuality[q] * marginalItemValueFn(crop.id, q, timing.matureAt)
      }

      simT = timing.matureAt
      h++
    }

    const freeSeedAvail = adapter.availableInv(state, `sd_${crop.id}`, 0) > 0
    const seedCashCost = freeSeedAvail ? 0 : crop.seed
    const net = totalExpectedRevenue - seedCashCost - totalStaminaSpent * staminaPointCost
    if (net > bestNet + 1e-6) {
      bestNet = net
      bestCrop = crop
    }
  }

  return bestCrop ? { crop: bestCrop, expectedNetGain: bestNet } : null
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
    if (price <= freeCash) candidates.push({ action: { a: 'expand', k: 'plot' }, price })
  }

  const maxTraps = Math.min(R.WORLD.trapMax, targets.trapsMax ?? R.WORLD.trapMax)
  if ((s.traps?.length || 0) < maxTraps) {
    const price = R.WORLD.trapPrice((s.traps?.length || 0) + 1)
    if (price <= freeCash) candidates.push({ action: { a: 'buyTrap' }, price })
  }

  if ((s.barn?.length || 0) < (s.barnN || 0)) {
    for (const a of R.ANIMALS || []) {
      if (a.price <= freeCash) {
        candidates.push({ action: { a: 'buyAnimal', k: a.id }, price: a.price })
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
      candidates.push({ action: { a: 'upgrade', k: tool }, price })
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
  })
  const innerAllowed = new Set([...allowedSet].filter((a) => a !== 'capex' && a !== 'visit'))

  const evalRolloutMean = (startW) => {
    const tl = buildEventBuckets(adapter, startW, { horizonSec: paybackSec, maxBuckets: 8 })
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
    let bestAct = null
    let bestVal = curBaseline
    let bestAfterW = null
    for (const c of cands) {
      if (isPastDeadlineFn?.()) break
      const sim = adapter.simulateBatch(curWorld, [c.action], { t: curWorld.now, prices: curWorld.prices })
      if (!sim.allOk) continue
      const val = evalRolloutMean(sim.afterWorld)
      if (val > bestVal + 1e-6) {
        bestVal = val
        bestAct = c.action
        bestAfterW = sim.afterWorld
      }
    }
    if (!bestAct) break
    chosen.push(bestAct)
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
}) {
  const { R, graph } = adapter
  const L = seqBuckets.length
  const t0 = Number(initialWorldForObjective?.now ?? startWorld.now)
  const effectivePrngFactory = typeof prngFactory === 'function'
    ? prngFactory
    : () => adapter.makeSampleStreamPrng(0, t0)
  const probePrng = effectivePrngFactory()
  const trackPrng = effectivePrngFactory()
  const baseExecPrng = effectivePrngFactory()
  const auxSeedPrng = effectivePrngFactory()
  const baseExecSeed = Math.floor(auxSeedPrng() * 0xffffffff) >>> 0
  const execPrngMap = new Map()
  const getExecPrngForKind = (kindStr) => {
    const key = String(kindStr || 'det')
    if (key === 'det') return baseExecPrng
    let fn = execPrngMap.get(key)
    if (!fn) {
      if (execPrngMap.size === 0) {
        fn = baseExecPrng
      } else {
        let h = baseExecSeed ^ 0x811c9dc5
        for (let i = 0; i < key.length; i++) {
          h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
        }
        let state = (h || 0x52d777) >>> 0
        fn = () => {
          state = (state + 0x6d2b79f5) >>> 0
          let z = state
          z = Math.imul(z ^ (z >>> 15), z | 1)
          z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
          return ((z ^ (z >>> 14)) >>> 0) / 4294967296
        }
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
  const termPrices = objectiveCfg.terminalSupplyMode === 'zero'
    ? {}
    : buildTerminalPrices(adapter, termStub, initialWorldForObjective, objectiveCfg, scenarioSupplyFactor)

  const approxTaxFactor = Number(startWorld.coins || 0) > (R.B12_TAX?.free || 3000000) ? 0.99 : 1.0

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

  // Track exact unreserved workshop capacity per isleIndex & unreserved initial inventory via `solveJointCraftAndSell`
  // on initial stock so upstream `plant` / `stockBuy` neither hallucinate saturated slots nor over-claim unprofitable recipes!
  const initSnap0 = adapter.availableInvSnapshot(startWorld.state)
  const startIsleIdx = R.isleIndex(startWorld.now)
  const rawFreeWorkshopByIsle = new Map()
  for (const b of seqBuckets) {
    if (rawFreeWorkshopByIsle.has(b.isleIndex)) continue
    if (!allowedSet.has('craft')) {
      rawFreeWorkshopByIsle.set(b.isleIndex, 0)
      continue
    }
    const used = b.isleIndex === startIsleIdx && startWorld.state?.iq?.d === startIsleIdx
      ? Number(startWorld.state.iq.craft || 0)
      : 0
    rawFreeWorkshopByIsle.set(b.isleIndex, Math.max(0, (R.WORLD?.daily?.craft || 80) - used))
  }

  const unreservedInitCounts = {}
  const reservedByInitCS = {}
  for (const [id, row] of Object.entries(initSnap0)) {
    unreservedInitCounts[id] = (row[0] || 0) + (row[1] || 0) + (row[2] || 0)
  }

  const unreservedWorkshopByIsle = new Map(rawFreeWorkshopByIsle)
  if (allowedSet.has('craft') && L > 0) {
    const craftEn = R.WORLD?.cost?.craft ?? 1
    const initCS = solveJointCraftAndSell(adapter, {
      initialSupplyByBucket: [structuredClone(initSnap0), ...seqBuckets.slice(1).map(() => ({}))],
      buckets: seqBuckets,
      slots,
      initialNatDay: R.worldDay(startWorld.now),
      initialCnt: startWorld.state?.cnt || {},
      craftCapByIsle: new Map(rawFreeWorkshopByIsle),
      enCapByBucket: Float64Array.from(seqBuckets.map((b) => (rawFreeWorkshopByIsle.get(b.isleIndex) || 0) * craftEn)),
      staminaShadowCost: 0,
      allowCraft: true,
      maxCraftHoldIsleDays,
    })
    const producedMid = {}
    for (let u = 0; u < L; u++) {
      const iIdx = seqBuckets[u].isleIndex
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
  }

  const projectedScOnStartDay = {}
  for (const [k, v] of Object.entries(startWorld.state?.cnt || {})) {
    if (k.startsWith('sc_')) projectedScOnStartDay[k.slice(3)] = Number(v || 0)
  }

  const bestDirectUnitValue = (id, q = 0, atSec = startWorld.now) => {
    const qual = R.QUALITY?.[q] ?? 1
    let bestDirect = 0
    for (const sl of slots) {
      if (!sl.allowSell || sl.atSec + 1 < atSec) continue
      const p = Number(sl.prices?.[id] || 0)
      if (!(p > 0)) continue
      const isCrop = graph.cropsById.has(id)
      const sc0 = sl.naturalDay === R.worldDay(startWorld.now) ? Number(projectedScOnStartDay[id] || 0) : 0
      const tierMult = !isCrop ? 1.0 : (sc0 >= 400 ? 0.70 : sc0 >= 150 ? 0.85 : 1.0)
      bestDirect = Math.max(bestDirect, Math.round(p * qual) * tierMult * sl.disc * sl.netTaxFactor)
    }
    return bestDirect
  }

  const marginalItemValueFn = (id, q = 0, atSec = startWorld.now, { reserveUnits = 0 } = {}) => {
    const bestDirect = bestDirectUnitValue(id, q, atSec)
    let best = bestDirect
    let usedWorkshopRecipe = null

    if (allowedSet.has('craft')) {
      const consumers = graph.consumedByRecipes.get(id) || []
      for (const r of consumers) {
        if (!(r.price > 0)) continue
        const needThis = Number(r.in?.[id] || 0)
        if (!(needThis > 0)) continue
        const minSlotReq = reserveUnits > 0 ? Math.min(1, reserveUnits / needThis) : 1 / needThis
        const hasOpenSlot = seqBuckets.some(
          (fb) => fb.atSec + 1 >= atSec && (unreservedWorkshopByIsle.get(fb.isleIndex) || 0) + 1e-9 >= Math.max(1, minSlotReq)
        )
        if (!hasOpenSlot) continue

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
        let bestRecOut = 0
        for (const sl of slots) {
          if (!sl.allowSell || sl.atSec + 1 < atSec) continue
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
        const slotsConsumed = reserveUnits / usedWorkshopRecipe.needThis
        for (const fb of seqBuckets) {
          if (fb.atSec + 1 >= atSec && (unreservedWorkshopByIsle.get(fb.isleIndex) || 0) >= 1 - 1e-9) {
            const cur = unreservedWorkshopByIsle.get(fb.isleIndex) || 0
            unreservedWorkshopByIsle.set(fb.isleIndex, Math.max(0, cur - slotsConsumed))
            break
          }
        }
      } else if (graph.cropsById.has(id)) {
        projectedScOnStartDay[id] = Number(projectedScOnStartDay[id] || 0) + reserveUnits
      }
    }

    return Math.max(0, best)
  }

  // Step B: Pre-pass over deterministic maintenance, farm, barn & cargo `stockBuy` to collect exact supply arrivals per bucket!
  let probeWorld = adapter.cloneWorld(startWorld)
  const preActionsByU = seqBuckets.map(() => [])
  const supplyByBucket = seqBuckets.map(() => ({}))
  const enAfterPreByU = new Float64Array(L)
  const craftCapByIsle = new Map()
  const seenCargoIsle = new Set()

  const addSupply = (u, id, q, n) => {
    if (!(n > 0)) return
    supplyByBucket[u][id] ||= [0, 0, 0]
    supplyByBucket[u][id][q] += n
  }

  for (let u = 0; u < L; u++) {
    const b = seqBuckets[u]
    const bPrices = estPricesByU[u] || {}
    probeWorld = adapter.advanceTimeOnly(probeWorld, b.atSec, { futurePrices: bPrices })
    probeWorld = applyExogenousArrivals(probeWorld, b.exogenousArrivalsAtStart)

    if (!craftCapByIsle.has(b.isleIndex)) {
      const used = probeWorld.state?.iq?.d === b.isleIndex ? Number(probeWorld.state.iq.craft || 0) : 0
      craftCapByIsle.set(b.isleIndex, allowedSet.has('craft') ? Math.max(0, (R.WORLD?.daily?.craft || 80) - used) : 0)
    }

    const batch = []
    let s = probeWorld.state
    const weather = R.weatherOf(b.isleDay)

    // 1. Pre-selected CapEx at u=0 if authorized
    if (u === 0 && allowedSet.has('capex') && preselectedCapexActions.length > 0) {
      batch.push(...preselectedCapexActions)
    }

    // 2. Zero-stamina crab traps
    if (allowedSet.has('trap')) {
      for (let i = 0; i < (s.traps?.length || 0); i++) {
        if (R.trapReady(s.traps[i], b.atSec, weather === 2).n > 0) {
          batch.push({ a: 'trap', i })
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
          batch.push({ a: 'collect', i }, { a: 'pet', i })
        } else {
          batch.push({ a: 'pet', i }, { a: 'collect', i })
        }
      } else if (canPet) {
        batch.push({ a: 'pet', i })
      } else if (canCollect) {
        batch.push({ a: 'collect', i })
      }
    }

    // 3b. Low-cash working-capital pre-sell at `u === 0`:
    //     When wallet is below the tax-free threshold (`B12_TAX.free`) and short of working capital for
    //     immediate hungry-barn `feed`, empty-plot `plant`, or high-ROI cargo `stockBuy`, liquidate the
    //     minimal amount of finished/non-craft-reserved stock first so cash-poor islands never stall!
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
      if (allowedSet.has('plant')) {
        let emptyOrHarvestable = 0
        for (let i = 0; i < (s.plotN || 0); i++) {
          const p = s.plots?.[i]
          if (!p) emptyOrHarvestable++
          else {
            const st = R.cropStage(p, b.atSec, R.sprinkled(s, i) || weather === 1)
            if (st.stage === 3 || st.stage === -1) emptyOrHarvestable++
          }
        }
        estWorkingCapNeed += emptyOrHarvestable * 600
      }
      if (allowedSet.has('stockBuy') && typeof R.b12Stock === 'function') {
        const stock0 = R.b12Stock(b.atSec, bPrices)
        const cargoMap0 = new Map(stock0.map((it) => [it.id, { price: Number(it.price || 0), left: R.b12StockLeft(s, it, b.atSec) }]))
        const edibleSpecs0 = allowedSet.has('eat') && typeof adapter.listDeterministicEdibleSpecs === 'function'
          ? adapter.listDeterministicEdibleSpecs()
          : []
        let bestCargoEdible = null
        for (const item of stock0) {
          const left = cargoMap0.get(item.id)?.left || 0
          if (!(left > 0) || !(item.price > 0)) continue
          const edSp = edibleSpecs0.find((sp) => (sp.kind === 'snack' && sp.id === item.id) || (sp.kind !== 'snack' && sp.id === item.id && sp.q === 0))
          if (edSp && edSp.energyGain > 0) {
            const cpe = item.price / edSp.energyGain
            if (!bestCargoEdible || cpe < bestCargoEdible.cpe) {
              bestCargoEdible = { price: item.price, left, enGain: edSp.energyGain, cpe }
            }
          }
          if (utilityTokens.explosiveId && item.id === utilityTokens.explosiveId && allowedSet.has('bomb')) {
            estWorkingCapNeed += left * item.price
          } else if (bestDirectUnitValue(item.id, 0, b.atSec) > item.price * 1.02) {
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
                oppPerBundle += reqQty * cInfo.price
              } else {
                maxB = Math.min(maxB, Math.floor((unreservedInitCounts[inId] || 0) / reqQty))
                oppPerBundle += reqQty * bestDirectUnitValue(inId, 0, b.atSec)
              }
            }
            if (usesCargo && maxB > 0 && outBest > oppPerBundle * 1.02) {
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
        // Prefer selling pure finished goods (`consumedByRecipes` empty) whose current quote is not deeply depressed
        const candidates = Object.keys(snap0)
          .filter((id) => Number(bPrices?.[id] || 0) > 0 && Number(R.BASE_PRICE?.[id] || 0) > 0)
          .map((id) => {
            const isRawInput = (graph.consumedByRecipes.get(id) || []).some((r) => r.price > 0)
            const curP = Number(bPrices[id] || 0)
            const futBest = marginalItemValueFn(id, 0, b.atSec)
            const holdRatio = futBest > 0 ? curP / futBest : 1
            return { id, isRawInput, curP, holdRatio }
          })
          .filter((c) => !c.isRawInput || c.holdRatio >= 0.92)
          .sort((a, b2) => Number(a.isRawInput) - Number(b2.isRawInput) || b2.holdRatio - a.holdRatio)

        const wcSells = []
        for (const c of candidates) {
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
          const svWc = simulateValidBatch(adapter, probeWorld, [...batch, ...wcSells].slice(0, R.WORLD?.maxActions || 40), {
            t: b.atSec,
            prices: bPrices,
            rand: probePrng,
          })
          probeWorld = svWc.afterWorld
          s = probeWorld.state
          preActionsByU[u].push(...svWc.validActions)
          batch.length = 0
        }
      }
    }

    // 4. Barn `feed` (buy feed if short)
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
        const haveFeed = adapter.availableInv(s, utilityTokens.feedId, 0)
        const needBuy = Math.max(0, hungryIndices.length - haveFeed)
        const feedPrice = Number(R.SHOP?.[utilityTokens.feedId]?.price || 150)
        if (needBuy > 0 && allowedSet.has('buy') && probeWorld.coins - constraints.cashReserveFloor >= needBuy * feedPrice) {
          batch.push({ a: 'buy', id: utilityTokens.feedId, n: Math.min(99, needBuy) })
        }
        for (const idx of hungryIndices) {
          batch.push({ a: 'feed', i: idx })
        }
      }
    }

    // 5. Plots: harvest mature, clear withered, water, plant seasonal optimal crop
    for (let i = 0; i < (s.plots?.length || 0); i++) {
      const p = s.plots[i]
      if (!p) continue
      const auto = R.sprinkled(s, i) || weather === 1
      const st = R.cropStage(p, b.atSec, auto)
      if (st.stage === 3 && allowedSet.has('harvest')) {
        batch.push({ a: 'harvest', i })
      } else if (st.stage === -1 && allowedSet.has('clear')) {
        batch.push({ a: 'clear', i })
      } else if (st.stage >= 0 && st.stage < 3 && !auto && p.w <= st.stage && allowedSet.has('water')) {
        batch.push({ a: 'water', i })
      }
    }

    // Simulate the harvest/clear/collect part first so newly freed plots can be replanted in the same batch!
    if (batch.length > 0) {
      const sv1 = simulateValidBatch(adapter, probeWorld, batch.slice(0, R.WORLD?.maxActions || 40), {
        t: b.atSec,
        prices: bPrices,
        rand: probePrng,
      })
      probeWorld = sv1.afterWorld
      preActionsByU[u].push(...sv1.validActions)
    }

    // Plant empty plots if profitable (and allowed in u=0 by upstream policy candidate)
    if (allowedSet.has('plant') && (u > 0 || enableFirstBucketPlant)) {
      const plantActs = []
      const ps = probeWorld.state
      let simCash = Number(probeWorld.coins || 0) - Number(constraints.cashReserveFloor || 0)
      let simEn = Number(ps.en || 0)
      for (let i = 0; i < ps.plotN && preActionsByU[u].length + plantActs.length < (R.WORLD?.maxActions || 40) - 4; i++) {
        if (ps.plots[i]) continue
        if (simEn < (R.WORLD?.cost?.plant ?? 2)) break
        const bestP = selectBestCropToPlant(adapter, {
          state: ps,
          plotIdx: i,
          atSec: b.atSec,
          tEnd: tH,
          marginalItemValueFn,
          staminaPointCost: 0,
        })
        if (!bestP) break
        const hasFreeSeed = adapter.availableInv(ps, `sd_${bestP.crop.id}`, 0) > 0
        const costCash = hasFreeSeed ? 0 : bestP.crop.seed
        if (costCash > simCash) continue
        // Reserve workshop/crop-tier capacity as each plot is tentatively planted!
        marginalItemValueFn(bestP.crop.id, 0, b.atSec, { reserveUnits: 2 })
        plantActs.push({ a: 'plant', i, c: bestP.crop.id })
        if (!R.sprinkled(ps, i) && weather !== 1 && simEn >= (R.WORLD?.cost?.plant ?? 2) + (R.WORLD?.cost?.water ?? 1)) {
          plantActs.push({ a: 'water', i })
          simEn -= R.WORLD?.cost?.water ?? 1
        }
        simCash -= costCash
        simEn -= R.WORLD?.cost?.plant ?? 2
      }
      if (plantActs.length > 0) {
        const sv2 = simulateValidBatch(adapter, probeWorld, plantActs, {
          t: b.atSec,
          prices: bPrices,
          rand: probePrng,
        })
        probeWorld = sv2.afterWorld
        preActionsByU[u].push(...sv2.validActions)
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
          unreservedWorkshopByIsle.set(iIdx, slFree)
        }

        const existingCraftWorkUnits = []
        if (allowedSet.has('craft')) {
          const localEndIdx = u + localCargoBuckets.length - 1
          const probeCS = solveJointCraftAndSell(adapter, {
            initialSupplyByBucket: [structuredClone(curSnapCargo), ...localCargoBuckets.slice(1).map(() => ({}))],
            buckets: localCargoBuckets,
            slots: slots
              .filter((sl) => sl.availFromBucket >= u)
              .map((sl) => ({
                ...sl,
                availFromBucket: Math.min(Math.max(0, localCargoBuckets.length - 1), Math.max(0, sl.availFromBucket - u)),
              }))
              .filter((sl, idx2, arr2) => !sl.isTerminal || sl.availFromBucket <= localEndIdx - u || idx2 === arr2.length - 1),
            initialNatDay: b.naturalDay,
            initialCnt: probeWorld.state?.cnt || {},
            craftCapByIsle: new Map(probeFreeSlotsByIsle),
            enCapByBucket: Float64Array.from(localCargoBuckets.map((fb) => (probeFreeSlotsByIsle.get(fb.isleIndex) || 0) * craftEn)),
            staminaShadowCost: 0,
            allowCraft: true,
            maxCraftHoldIsleDays,
          })

          const expandedProbeCrafts = []
          for (let relU = 0; relU < localCargoBuckets.length; relU++) {
            const iIdx = localCargoBuckets[relU].isleIndex
            for (const ca of probeCS.craftsByBucket[relU] || []) {
              const nCraft = Number(ca.n || 1)
              unreservedWorkshopByIsle.set(iIdx, Math.max(0, (unreservedWorkshopByIsle.get(iIdx) || 0) - nCraft))
              for (let k = 0; k < nCraft; k++) {
                expandedProbeCrafts.push({ id: ca.id, atSec: localCargoBuckets[relU].atSec })
              }
            }
          }

          const simProbeSnap = structuredClone(curSnapCargo)
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
                const testSnap = structuredClone(simProbeSnap)
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
              unreservedWorkshopByIsle.set(iIdx, Math.max(0, cur - tk))
              rem -= tk
            }
          }
        }

        const committedPassEatUnits = []
        const committedPassWorkUnits = []

        // Unified Stamina × Cash × Workshop-Slots Bounded Knapsack DP across:
        // - Existing stamina-hungry work (`existingCraftWorkUnits` + `bomb`/`fish`/`mine`)
        // - Existing stamina supplies (`inv-eat` + `coffee`)
        // - Cargo edible supplies (`tide_snack` + ALL `q=0` edible crops on `b12Stock`)
        // - Cargo `recipe-bundle`s (1-stage & 2-stage chains), `explosive`s, and `direct` arbitrage!
        for (let pass = 0; pass < 2 && availCoins > 0; pass++) {
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

          // 2) Cargo Dual-Use (`eat` vs `direct` mutually exclusive per physical copy!) & `snack` supplies
          const cargoPhase1Units = []
          for (const [itemId, price] of cargoPrice.entries()) {
            const left = cargoLeft.get(itemId) || 0
            if (left <= 0 || price > availCoins) continue
            if (utilityTokens.explosiveId && itemId === utilityTokens.explosiveId) continue
            const maxAfford = Math.min(left, Math.floor(availCoins / price))

            if (utilityTokens.snackId && itemId === utilityTokens.snackId) {
              if (!allowedSet.has('eat') || remSnackNeed <= 0 || totalWorkEnDemand <= effectiveFreeEn) continue
              const cnt = Math.min(maxAfford, remSnackNeed)
              const snackEn = R.B12_SNACK?.energy || 20
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
            const maxEatCopies = (edibleSp && edibleSp.energyGain > 0 && totalWorkEnDemand > effectiveFreeEn)
              ? Math.min(maxAfford, Math.ceil((totalWorkEnDemand - effectiveFreeEn) / edibleSp.energyGain) + 1)
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

          const phase1SupplyAndDual = [
            ...existingInvEatUnits.map((x) => ({ ...x, kind: 'inv-eat', isCargo: false })),
            ...shopCoffeeUnits,
            ...cargoPhase1Units,
          ]
          const phase2NonSlotWork = [
            ...allActiveWorkForEn.map((x) => ({ ...x, kind: 'existing-work', isCargo: false })),
            ...cargoExplosiveUnits,
            ...(slotsBinding ? [] : bundleUnits),
          ]
          const phase3SlotBundles = slotsBinding ? bundleUnits : []

          const allCargoDpItems = [...phase1SupplyAndDual, ...phase2NonSlotWork, ...phase3SlotBundles]
          const totalMaxDpCashSpend = allCargoDpItems.reduce((acc, it) => acc + Number(it.cashCost || 0), 0)
          const cashBinding = totalMaxDpCashSpend > availCoins + 1e-9

          let rawGcd = 0
          if (cashBinding) {
            for (const it of allCargoDpItems) {
              if (it.cashCost > 0) rawGcd = rawGcd === 0 ? it.cashCost : gcdCargo(rawGcd, it.cashCost)
            }
          }
          if (rawGcd <= 0) rawGcd = 1
          const maxCashCells = S_eff > 0 ? 250 : 800
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
          if (cashBinding) {
            recordCashGrid('cargo-stamina-slots-dp', cashUnit, rawGcd, (S_eff + 1) * sliceSize)
          }

          const NEG_INF = -1e18
          const dp1 = new Float64Array(sliceSize)
          dp1.fill(NEG_INF)
          dp1[Math.min(E, effectiveFreeEn) * stride] = 0

          const prevP1 = phase1SupplyAndDual.map(() => new Int32Array(sliceSize))
          for (let i = 0; i < phase1SupplyAndDual.length; i++) {
            const it = phase1SupplyAndDual[i]
            const cCost = cashBinding && it.cashCost > 0 ? Math.ceil(it.cashCost / cashUnit) : 0
            if (cCost > C) continue
            const pArr = prevP1[i]

            if (it.kind === 'cargo-item') {
              const capE = Math.min(E, eatStaminaCap)
              for (let srcC = C - cCost; srcC >= 0; srcC--) {
                const dstC = srcC + cCost
                for (let srcE = E; srcE >= 0; srcE--) {
                  const srcIdx = srcE * stride + srcC
                  const srcVal = dp1[srcIdx]
                  if (srcVal <= -1e17) continue
                  if (it.canEat) {
                    const newE = Math.min(capE, Math.max(srcE, srcE + it.enGain))
                    const dstIdx = newE * stride + dstC
                    const candVal = srcVal + it.eatGain
                    if (candVal > dp1[dstIdx] + 1e-6) {
                      dp1[dstIdx] = candVal
                      pArr[dstIdx] = (srcIdx + 1) * 2
                    }
                  }
                  if (it.canDirect) {
                    const dstIdx = srcE * stride + dstC
                    const candVal = srcVal + it.directGain
                    if (candVal > dp1[dstIdx] + 1e-6) {
                      dp1[dstIdx] = candVal
                      pArr[dstIdx] = (srcIdx + 1) * 2 + 1
                    }
                  }
                }
              }
            } else {
              const capE = it.isCoffee ? E : Math.min(E, eatStaminaCap)
              for (let srcE = E; srcE >= 0; srcE--) {
                const newE = Math.min(capE, Math.max(srcE, srcE + it.enGain))
                for (let srcC = C - cCost; srcC >= 0; srcC--) {
                  if (newE === srcE && cCost === 0) continue
                  const srcIdx = srcE * stride + srcC
                  const srcVal = dp1[srcIdx]
                  if (srcVal <= -1e17) continue
                  const dstIdx = newE * stride + (srcC + cCost)
                  const candVal = srcVal + it.netGain
                  if (candVal > dp1[dstIdx] + 1e-6) {
                    dp1[dstIdx] = candVal
                    pArr[dstIdx] = (srcIdx + 1) * 2
                  }
                }
              }
            }
          }

          const prevP2 = phase2NonSlotWork.map(() => new Int32Array(sliceSize))
          for (let i = 0; i < phase2NonSlotWork.length; i++) {
            const it = phase2NonSlotWork[i]
            const cEn = it.enCost || 0
            const cCost = cashBinding && it.cashCost > 0 ? Math.ceil(it.cashCost / cashUnit) : 0
            if (cEn > E || cCost > C) continue
            const pArr = prevP2[i]
            for (let newE = 0; newE <= E - cEn; newE++) {
              const srcRow = (newE + cEn) * stride
              const dstRow = newE * stride
              for (let newC = C; newC >= cCost; newC--) {
                const srcC = newC - cCost
                const srcIdx = srcRow + srcC
                const srcVal = dp1[srcIdx]
                if (srcVal <= -1e17) continue
                const dstIdx = dstRow + newC
                const candVal = srcVal + it.netGain
                if (candVal > dp1[dstIdx] + 1e-6) {
                  dp1[dstIdx] = candVal
                  pArr[dstIdx] = srcIdx + 1
                }
              }
            }
          }

          const chosenCargo = []
          if (phase3SlotBundles.length > 0) {
            const totalCells3 = (S_eff + 1) * sliceSize
            const dp3 = new Float64Array(totalCells3)
            dp3.fill(NEG_INF)
            dp3.set(dp1, 0)
            const prevP3 = phase3SlotBundles.map(() => new Int32Array(totalCells3))

            for (let i = 0; i < phase3SlotBundles.length; i++) {
              const it = phase3SlotBundles[i]
              const sCost = it.slotsCost
              const cEn = it.enCost || 0
              const cCost = cashBinding && it.cashCost > 0 ? Math.ceil(it.cashCost / cashUnit) : 0
              if (sCost > S_eff || cEn > E || cCost > C) continue
              const pArr = prevP3[i]
              for (let newS = S_eff; newS >= sCost; newS--) {
                const srcSOff = (newS - sCost) * sliceSize
                const dstSOff = newS * sliceSize
                for (let newE = 0; newE <= E - cEn; newE++) {
                  const srcERow = srcSOff + (newE + cEn) * stride
                  const dstERow = dstSOff + newE * stride
                  for (let newC = C; newC >= cCost; newC--) {
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
            }

            let bestIdx3 = Math.min(E, effectiveFreeEn) * stride
            let bestVal3 = dp3[bestIdx3]
            for (let idx = 0; idx < totalCells3; idx++) {
              if (dp3[idx] > bestVal3 + 1e-6) {
                bestVal3 = dp3[idx]
                bestIdx3 = idx
              }
            }
            let curIdx = bestIdx3
            for (let i = phase3SlotBundles.length - 1; i >= 0; i--) {
              const code = prevP3[i][curIdx]
              if (code > 0) {
                chosenCargo.push({ ...phase3SlotBundles[i], chosenMode: 'recipe-bundle' })
                curIdx = code - 1
              }
            }
            // Now `curIdx` is in slice `s = 0` (`0 <= curIdx < sliceSize`)!
            for (let i = phase2NonSlotWork.length - 1; i >= 0; i--) {
              const code = prevP2[i][curIdx]
              if (code > 0) {
                if (phase2NonSlotWork[i].isCargo) {
                  chosenCargo.push({ ...phase2NonSlotWork[i], chosenMode: phase2NonSlotWork[i].kind })
                }
                curIdx = code - 1
              }
            }
            for (let i = phase1SupplyAndDual.length - 1; i >= 0; i--) {
              const code = prevP1[i][curIdx]
              if (code > 0) {
                const isDirect = (code & 1) === 1
                const srcIdx = ((code - (code & 1)) / 2) - 1
                if (phase1SupplyAndDual[i].isCargo) {
                  chosenCargo.push({
                    ...phase1SupplyAndDual[i],
                    chosenMode: isDirect ? 'direct' : 'cargo-eat',
                  })
                }
                curIdx = srcIdx
              }
            }
          } else {
            let bestIdx1 = Math.min(E, effectiveFreeEn) * stride
            let bestVal1 = dp1[bestIdx1]
            for (let idx = 0; idx < sliceSize; idx++) {
              if (dp1[idx] > bestVal1 + 1e-6) {
                bestVal1 = dp1[idx]
                bestIdx1 = idx
              }
            }
            let curIdx = bestIdx1
            for (let i = phase2NonSlotWork.length - 1; i >= 0; i--) {
              const code = prevP2[i][curIdx]
              if (code > 0) {
                if (phase2NonSlotWork[i].isCargo) {
                  chosenCargo.push({ ...phase2NonSlotWork[i], chosenMode: phase2NonSlotWork[i].kind })
                }
                curIdx = code - 1
              }
            }
            for (let i = phase1SupplyAndDual.length - 1; i >= 0; i--) {
              const code = prevP1[i][curIdx]
              if (code > 0) {
                const isDirect = (code & 1) === 1
                const srcIdx = ((code - (code & 1)) / 2) - 1
                if (phase1SupplyAndDual[i].isCargo) {
                  chosenCargo.push({
                    ...phase1SupplyAndDual[i],
                    chosenMode: isDirect ? 'direct' : 'cargo-eat',
                  })
                }
                curIdx = srcIdx
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
          preActionsByU[u].push(...sv3.validActions)
        }
      }
    }

    // 7. Claim any completed daily goals (0 stamina)
    if (allowedSet.has('goal') && typeof R.dailyGoals === 'function') {
      const goals = R.dailyGoals(b.naturalDay, probeWorld.state)
      const goalActs = []
      for (let k = 0; k < 4; k++) {
        if (goals[k] && !probeWorld.state.cnt?.['goal' + k] && (probeWorld.state.cnt?.[goals[k].id] || 0) >= goals[k].n) {
          goalActs.push({ a: 'goal', k })
        }
      }
      if (goalActs.length > 0) {
        const svG = simulateValidBatch(adapter, probeWorld, goalActs, {
          t: b.atSec,
          prices: bPrices,
          rand: probePrng,
        })
        probeWorld = svG.afterWorld
        preActionsByU[u].push(...svG.validActions)
      }
    }

    enAfterPreByU[u] = Number(probeWorld.state?.en || 0)
  }

  // Reconstruct exact net incremental available inventory arriving at each bucket u = 0..L-1
  // by diffing `availableInvSnapshot` after `preActionsByU[u]` against the previous bucket's post-state!
  {
    let trackWorld = adapter.cloneWorld(startWorld)
    let prevSnap = {}
    for (let u = 0; u < L; u++) {
      const b = seqBuckets[u]
      const bPrices = estPricesByU[u] || {}
      trackWorld = adapter.advanceTimeOnly(trackWorld, b.atSec, { futurePrices: bPrices })
      trackWorld = applyExogenousArrivals(trackWorld, b.exogenousArrivalsAtStart)
      if (preActionsByU[u].length > 0) {
        trackWorld = adapter.simulateBatch(trackWorld, preActionsByU[u], { t: b.atSec, prices: bPrices, rand: trackPrng }).afterWorld
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
      enAfterPreByU[u] = Number(trackWorld.state?.en || 0)
    }
  }

  // Step C: Solve multi-bucket joint Craft + Sell across buckets `0..L-1` to reserve scarce craft slots & inputs
  // for higher-margin future arrivals (e.g., reserving 1 craft slot for `t0 + 60` strawberry arrival)!
  const jointCS = solveJointCraftAndSell(adapter, {
    initialSupplyByBucket: supplyByBucket,
    buckets: seqBuckets,
    slots,
    initialNatDay: R.worldDay(startWorld.now),
    initialCnt: startWorld.state?.cnt || {},
    craftCapByIsle,
    enCapByBucket: Float64Array.from(seqBuckets.map((b2, idx2) => Math.max(enAfterPreByU[idx2] || 0, craftCapByIsle.get(b2.isleIndex) || 0))),
    staminaShadowCost: 0,
    allowCraft: allowedSet.has('craft'),
    maxCraftHoldIsleDays,
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
  const globalRecipeInputSet = new Set()
  for (const rec of R.RECIPES || []) {
    for (const inId of Object.keys(rec.in || {})) globalRecipeInputSet.add(inId)
  }

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
    const maxBucketActions = Math.min(200, maxBatchesInBucket * maxSingleBatch)

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

    // 1. Execute pre-actions (CapEx, traps, barn, plots, cargo stockBuy, goals)
    pushAndSim(preActionsByU[u])

    const directSaleOnlyValue = (stState, id, q = 0, extraSc = 0) => {
      const qual = R.QUALITY?.[q] ?? 1
      let best = 0
      for (const sl of slots) {
        if (!sl.allowSell || sl.atSec + 1 < b.atSec) continue
        const p = Number(sl.prices?.[id] || 0)
        if (!(p > 0)) continue
        const isCrop = graph.cropsById.has(id)
        const sc0 = sl.naturalDay === b.naturalDay ? Number(stState?.cnt?.['sc_' + id] || 0) + extraSc : 0
        const tierMult = !isCrop ? 1.0 : (sc0 >= 400 ? 0.70 : sc0 >= 150 ? 0.85 : 1.0)
        best = Math.max(best, Math.round(p * qual) * tierMult * sl.disc * sl.netTaxFactor)
      }
      return best
    }

    const recipeInputSet = new Set()
    for (const rec of R.RECIPES || []) {
      for (const inId of Object.keys(rec.in || {})) recipeInputSet.add(inId)
    }

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
      for (let fu = u + 1; fu < L; fu++) {
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
      const localCS = solveJointCraftAndSell(adapter, {
        initialSupplyByBucket: [snapAvail, ...seqBuckets.slice(u + 1).map(() => ({}))],
        buckets: seqBuckets.slice(u),
        slots: slots.filter((sl) => sl.availFromBucket >= u).map((sl) => ({ ...sl, availFromBucket: Math.max(0, sl.availFromBucket - u) })),
        initialNatDay: b.naturalDay,
        initialCnt: s.cnt || {},
        craftCapByIsle: new Map([[b.isleIndex, freeSlotsNow]]),
        enCapByBucket: Float64Array.from(seqBuckets.slice(u).map(() => freeSlotsNow * craftEn)),
        staminaShadowCost: 0,
        allowCraft: true,
        maxCraftHoldIsleDays,
      })

      const plannedActs = localCS.craftsByBucket[0] || []
      const expandedSingle = []
      for (const ca of plannedActs) {
        for (let k = 0; k < (ca.n || 1); k++) expandedSingle.push(ca.id)
      }
      const simSnap = structuredClone(snapAvail)
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
            const testSnap = structuredClone(simSnap)
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

    const solveBucketStaminaKnapsack = (stWorld, maxEnLimit, craftBundlesOverride = null, { fullIsleQuotas = false } = {}) => {
      const s = stWorld.state
      const freeCash = Math.max(0, Number(stWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      const actionRoom = fullIsleQuotas ? 200 : Math.max(0, maxBucketActions - bucketActs.length)
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
          const valBait = fullIsleQuotas ? Math.max(rawValBait, bestIsleEv) : rawValBait
          const enCapCheck = Number(R.energyMax(s))
          const hasBetterWindowLaterSameIsle = !fullIsleQuotas
            && seqBuckets.slice(u + 1).some((fb) => fb.isleIndex === b.isleIndex)
            && rawValBait + 1e-6 < bestIsleEv
            && Number(s.en || 0) < (Number.isFinite(enCapCheck) && enCapCheck > 0 ? enCapCheck : 100)

          if (!hasBetterWindowLaterSameIsle) {
            const capCasts = fullIsleQuotas ? fishLeft : Math.min(fishLeft, Math.min(16, actionRoom))
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
            const capHits = fullIsleQuotas ? mineLeft : Math.min(mineLeft, Math.min(20, actionRoom))
            for (let k = 0; k < capHits; k++) {
              items.push({ kind: 'mine', costEn: mineEn, gain: mv })
            }
          }
        }
      }

      const maxCostSum = items.reduce((sAcc, it) => sAcc + it.costEn, 0)
      const E = Math.max(0, Math.min(maxEnLimit, maxCostSum))
      const totalPaidCash = items.reduce((sAcc, it) => sAcc + Number(it.cashCost || 0), 0)

      // When multiple paid item pools (`bomb-buy` + `fish-buy-bait`) compete for scarce `freeCash`,
      // solve exact 2D `(e, c)` DP so reconstructed items NEVER exceed `freeCash`!
      if (totalPaidCash > freeCash + 1e-9 && E > 0) {
        let rawGcd = 0
        for (const it of items) {
          if (it.cashCost > 0) rawGcd = rawGcd === 0 ? it.cashCost : gcdInt(rawGcd, it.cashCost)
        }
        if (rawGcd <= 0) rawGcd = 1
        const cashUnit = Math.floor(freeCash / rawGcd) > 500
          ? Math.max(1, Math.ceil(freeCash / 500))
          : rawGcd
        const C = Math.max(0, Math.floor(freeCash / cashUnit))
        const stride = C + 1
        recordCashGrid('bucket-stamina-cash-dp', cashUnit, rawGcd, (E + 1) * stride)
        const dp2 = new Float64Array((E + 1) * stride)
        const take2 = items.map(() => new Uint8Array((E + 1) * stride))

        for (let i = 0; i < items.length; i++) {
          const cEn = items[i].costEn
          const cCash = items[i].cashCost > 0 ? Math.ceil(items[i].cashCost / cashUnit) : 0
          const g = items[i].gain
          if (cEn > E || cCash > C) continue
          for (let e = E; e >= cEn; e--) {
            const rowOff = e * stride
            const prevOff = (e - cEn) * stride
            for (let c = C; c >= cCash; c--) {
              const cand = dp2[prevOff + (c - cCash)] + g
              if (cand > dp2[rowOff + c] + 1e-6) {
                dp2[rowOff + c] = cand
                take2[i][rowOff + c] = 1
              }
            }
          }
        }

        const bestAtMost = new Float64Array(E + 1)
        const bestExactE = new Int32Array(E + 1)
        const bestExactC = new Int32Array(E + 1)
        for (let e = 0; e <= E; e++) {
          let rowBest = e > 0 ? bestAtMost[e - 1] : 0
          let rowBestE = e > 0 ? bestExactE[e - 1] : 0
          let rowBestC = e > 0 ? bestExactC[e - 1] : 0
          const rowOff = e * stride
          for (let c = 0; c <= C; c++) {
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
          for (let i = items.length - 1; i >= 0 && curE > 0; i--) {
            if (take2[i][curE * stride + curC]) {
              picked.push(items[i])
              curE -= items[i].costEn
              curC -= items[i].cashCost > 0 ? Math.ceil(items[i].cashCost / cashUnit) : 0
            }
          }
          picked.reverse()
          return picked
        }

        return { items, E, bestAtMost, reconstructAt }
      }

      const dp = new Float64Array(E + 1)
      const takeTable = items.map(() => new Uint8Array(E + 1))

      for (let i = 0; i < items.length; i++) {
        const cEn = items[i].costEn
        const g = items[i].gain
        for (let e = E; e >= cEn; e--) {
          const cand = dp[e - cEn] + g
          if (cand > dp[e] + 1e-6) {
            dp[e] = cand
            takeTable[i][e] = 1
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
        for (let i = items.length - 1; i >= 0 && curE > 0; i--) {
          if (takeTable[i][curE]) {
            picked.push(items[i])
            curE -= items[i].costEn
          }
        }
        picked.reverse()
        return picked
      }

      return { items, E, bestAtMost, reconstructAt }
    }

    // 2. Exact Post-State Stamina Top-Up (`eat` / `coffee`):
    //    Every candidate `eat` or `coffee` action is simulated FIRST (`simFood.afterWorld`), and the
    //    Stamina × Cash Knapsack DP is solved on `simFood.afterWorld` so spent coffee cash (`-15,000 D`)
    //    and eaten craft ingredients are NEVER double-counted by downstream paid work (`bomb`/`bait`/`craft`)!
    const bucketEnFloor = Number(constraints.staminaReserveFloor || 0) > 0 && b.atSec < Number(constraints.staminaReserveUntilSec || 0)
      ? Math.max(0, Math.floor(Number(constraints.staminaReserveFloor || 0)))
      : 0

    if (u === 0) {
      const ksNonCraftCurve = solveBucketStaminaKnapsack(execWorld, 600, [], { fullIsleQuotas: true })
      const isleWindowEnd = Math.min(tH, adapter.nextIsleBoundary(b.atSec, startWorld.clockStart))
      const regenStep = R.WORLD?.regen || 180
      const regenInIsleWindow = Math.max(0, Math.floor((isleWindowEnd - Number(execWorld.state?.enT || b.atSec)) / regenStep))
      const preEnSpent0 = Math.max(0, Number(startWorld.state?.en || 0) - Number(execWorld.state?.en || 0))
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
          const unitCost = spec.kind === 'snack' ? 0 : directSaleOnlyValue(s0, spec.id, spec.q)
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

    if (allowedSet.has('eat') || allowedSet.has('coffee')) {
      for (let topStep = 0; topStep < 24 && bucketActs.length < maxBucketActions - 4; topStep++) {
        const s = execWorld.state
        const curEn = Math.max(0, Math.floor(Number(s.en || 0)))
        const spendableCurEn = Math.max(0, curEn - bucketEnFloor)
        const rawEnMax = Number(R.energyMax(s))
        const enMax = Number.isFinite(rawEnMax) && rawEnMax > 0 ? rawEnMax : 100
        const ksEatBase = solveBucketStaminaKnapsack(execWorld, Math.max(spendableCurEn, Math.max(0, enMax - bucketEnFloor), Math.max(0, curEn + (R.WORLD?.coffee?.energy || 60) - bucketEnFloor)), cachedCraftBundles)
        const baseVal = ksEatBase.bestAtMost[Math.min(ksEatBase.E, spendableCurEn)]

        const futureCraftNeedByItem = {}
        for (let fu = u + 1; fu < L; fu++) {
          for (const ca of jointCS.craftsByBucket[fu] || []) {
            const rec = graph.recipesById.get(ca.id)
            for (const [inId, perU] of Object.entries(rec?.in || {})) {
              futureCraftNeedByItem[inId] = (futureCraftNeedByItem[inId] || 0) + perU * Number(ca.n || 1)
            }
          }
        }
        const curBucketCraftNeedByItem = {}
        for (const cb of cachedCraftBundles || []) {
          for (const stStep of cb.craftSteps || []) {
            const rec = graph.recipesById.get(stStep.id)
            for (const [inId, perU] of Object.entries(rec?.in || {})) {
              curBucketCraftNeedByItem[inId] = (curBucketCraftNeedByItem[inId] || 0) + perU * Number(stStep.n || 1)
            }
          }
        }

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

        let bestFoodAct = null
        let bestAfterBundles = cachedCraftBundles
        let bestRatio = 1.0
        let bestOppCost = Infinity

        if (allowedSet.has('eat') && curEn < enMax && ksEatBase.E > curEn) {
          // Build the available non-craft-cannibalizing food pool sorted by unit cost-per-energy (`cpe`),
          // breaking ties strictly by lower `oppCost` (`q=0` BEFORE `q=1` BEFORE `q=2`!) so:
          // 1) Multi-unit food reachability (`2 * 5 en` turnips -> `6 en` bomb) is recognized from `curEn = 0`, and
          // 2) Staircase jumps in `ksEatBase.bestAtMost` NEVER trick 1-step lookahead into eating `q=2` before `q=0`!
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
            const gainEn = Math.min(enMax - curEn, spec.energyGain)
            if (!(gainEn > 0)) continue

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
              deferredCraftCutSpecs.push({ spec, candAct, gainEn })
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
                  if (diff > 0) unitOppCost += diff * directSaleOnlyValue(s, spec.id, qIdx)
                }
              } else {
                unitOppCost = Math.max(
                  directSaleOnlyValue(s, spec.id, spec.q),
                  marginalItemValueFn(spec.id, 0, b.atSec)
                )
              }
            }
            poolEntries.push({
              spec,
              candAct,
              count: Math.max(1, Math.min(24, surplusCount)),
              rawGain: spec.energyGain,
              firstGain: gainEn,
              unitOppCost,
              cpe: unitOppCost / Math.max(1, gainEn),
            })
          }

          if (poolEntries.length > 0) {
            poolEntries.sort((a, b2) =>
              (a.cpe - b2.cpe) ||
              (a.unitOppCost - b2.unitOppCost) ||
              ((a.spec.q ?? 0) - (b2.spec.q ?? 0))
            )
            // Find the highest return-on-cost reachable stamina threshold `targetE` (`curEn < targetE <= min(ksEatBase.E, enMax)`)
            let reachEn = curEn
            let cumCost = 0
            for (const pe of poolEntries) {
              for (let k = 0; k < pe.count && reachEn < enMax; k++) {
                const stepGain = Math.min(enMax - reachEn, pe.rawGain)
                if (!(stepGain > 0)) break
                reachEn += stepGain
                cumCost += pe.unitOppCost
                const workAtReach = ksEatBase.bestAtMost[Math.min(ksEatBase.E, Math.max(0, reachEn - bucketEnFloor))]
                const deltaWork = workAtReach - baseVal
                const netImp = deltaWork - cumCost
                if (netImp > 1e-6) {
                  const firstEntry = poolEntries[0]
                  const ratio = cumCost <= 1e-6 ? 1e12 + netImp : deltaWork / cumCost
                  if (ratio > bestRatio + 1e-6 || (Math.abs(ratio - bestRatio) <= 1e-6 && firstEntry.unitOppCost < bestOppCost - 1e-6)) {
                    bestRatio = ratio
                    bestOppCost = firstEntry.unitOppCost
                    bestFoodAct = firstEntry.candAct
                    bestAfterBundles = cachedCraftBundles
                  }
                }
              }
            }
          }

          // Now evaluate craft-cannibalizing candidates ONLY if their exact weak-dominance upper bound
          // (`ksEatBase.bestAtMost[optimisticAfterEn] - baseVal`) can beat BOTH `oppCost` AND `bestRatio`!
          for (const { spec, candAct, gainEn } of deferredCraftCutSpecs) {
            const oppCost = directSaleOnlyValue(s, spec.id, spec.q)
            const optimisticAfterEn = Math.max(0, Math.min(enMax, curEn + gainEn) - bucketEnFloor)
            const optimisticDelta = ksEatBase.bestAtMost[Math.min(ksEatBase.E, optimisticAfterEn)] - baseVal
            if (optimisticDelta - oppCost <= 1e-6) continue
            const optimisticRatio = oppCost <= 1e-6 ? 1e12 + (optimisticDelta - oppCost) : optimisticDelta / oppCost
            if (
              optimisticRatio < bestRatio - 1e-6 ||
              (Math.abs(optimisticRatio - bestRatio) <= 1e-6 && oppCost >= bestOppCost - 1e-6)
            ) {
              continue
            }

            const simFood = adapter.simulateBatch(execWorld, [candAct], { t: b.atSec, prices: dynamicPrices })
            if (!simFood.allOk) continue
            const afterW = simFood.afterWorld
            const afterEn = Math.max(0, Math.floor(Number(afterW.state?.en || 0)))
            if (afterEn <= curEn) continue
            const spendableAfterEn = Math.max(0, afterEn - bucketEnFloor)
            const afterBundles = computeBucketCraftBundles(afterW)
            const ksAfter = solveBucketStaminaKnapsack(afterW, spendableAfterEn, afterBundles)
            const newVal = ksAfter.bestAtMost[Math.min(ksAfter.E, spendableAfterEn)]
            const deltaWorkVal = newVal - baseVal
            const netImprovement = deltaWorkVal - oppCost
            if (netImprovement > 1e-6) {
              const ratio = oppCost <= 1e-6 ? 1e12 + netImprovement : deltaWorkVal / oppCost
              if (ratio > bestRatio + 1e-6 || (Math.abs(ratio - bestRatio) <= 1e-6 && oppCost < bestOppCost - 1e-6)) {
                bestRatio = ratio
                bestOppCost = oppCost
                bestFoodAct = candAct
                bestAfterBundles = afterBundles
              }
            }
          }
        }

        const coffeePrice = R.WORLD?.coffee?.price || 15000
        if (
          allowedSet.has('coffee') &&
          Number(s.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
          Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0) >= coffeePrice
        ) {
          const coffeeEnGain = R.WORLD?.coffee?.energy || 60
          const oppCost = coffeePrice * bucketDisc
          const optimisticCoffeeEn = Math.max(0, curEn + coffeeEnGain - bucketEnFloor)
          const optimisticCoffeeDelta = ksEatBase.bestAtMost[Math.min(ksEatBase.E, optimisticCoffeeEn)] - baseVal
          const optimisticCoffeeRatio = optimisticCoffeeDelta / Math.max(1e-9, oppCost)
          if (
            optimisticCoffeeDelta - oppCost > 1e-6 &&
            (optimisticCoffeeRatio > bestRatio + 1e-6 || (Math.abs(optimisticCoffeeRatio - bestRatio) <= 1e-6 && oppCost < bestOppCost - 1e-6))
          ) {
            const candAct = { a: 'coffee' }
            const simFood = adapter.simulateBatch(execWorld, [candAct], { t: b.atSec, prices: dynamicPrices })
            if (simFood.allOk) {
              const afterW = simFood.afterWorld
              const afterEn = Math.max(0, Math.floor(Number(afterW.state?.en || 0)))
              const spendableCoffeeEn = Math.max(0, afterEn - bucketEnFloor)
              const ksAfter = solveBucketStaminaKnapsack(afterW, spendableCoffeeEn, cachedCraftBundles)
              const newVal = ksAfter.bestAtMost[Math.min(ksAfter.E, spendableCoffeeEn)]
              const deltaWorkVal = newVal - baseVal
              const netImprovement = deltaWorkVal - oppCost
              if (netImprovement > 1e-6) {
                const ratio = deltaWorkVal / oppCost
                if (ratio > bestRatio + 1e-6 || (Math.abs(ratio - bestRatio) <= 1e-6 && oppCost < bestOppCost - 1e-6)) {
                  bestRatio = ratio
                  bestOppCost = oppCost
                  bestFoodAct = candAct
                  bestAfterBundles = cachedCraftBundles
                }
              }
            }
          }
        }

        if (!bestFoodAct) break
        pushAndSim([bestFoodAct])
        cachedCraftBundles = bestAfterBundles
      }
    }

    // 3. Solve final Exact Bucket Stamina Knapsack at `execWorld.state.en - bucketEnFloor` and emit chosen actions!
    //    (Shop buys & deterministic crafts run before stochastic actions so prefix compiler captures maximum deterministic value!)
    {
      const curEn = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - bucketEnFloor)
      if (curEn > 0) {
        const ksFinal = solveBucketStaminaKnapsack(execWorld, curEn)
        const chosenItems = ksFinal.reconstructAt(curEn)
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

          // 3a) Deterministic crafts first!
          if (rawCraftList.length > 0) {
            pushAndSim(mergeCraftActionsPreserveTopo(rawCraftList))
          }

          // 3b) Shop purchases for bombs/bait (deterministic, lowers wallet before `b12TaxSale`!)
          let freeCashNow = Math.max(0, Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
          if (nBombBuy > 0 && utilityTokens.explosiveId) {
            const pBomb = Number(R.SHOP?.[utilityTokens.explosiveId]?.price || 0)
            const affordB = pBomb > 0 ? Math.min(nBombBuy, Math.floor(freeCashNow / pBomb)) : 0
            if (affordB > 0) {
              pushAndSim([{ a: 'buy', id: utilityTokens.explosiveId, n: affordB }])
              freeCashNow = Math.max(0, Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
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

          // Note: Before running stochastic extraction (`bomb`/`fish`/`mine`), sell any deterministic finished goods
          // that should be liquidated in THIS bucket so `compileExecutablePrefix` executes deterministic sells
          // BEFORE truncating on the first stochastic action!
          if (
            (nBombInv + nBombBuy + nFishInvBait + nFishBuyBait + nFishNoBait + nMine > 0) &&
            allowedSet.has('sell') &&
            !(forcedTrunkSellPolicy === 'hold-in-first-bucket' && u === 0 && L > 1)
          ) {
            emitOptimalBucketSells(u, b, dynamicPrices, pushAndSim)
          }

          // 3c) Stochastic extraction actions ordered by highest marginal gain per stamina so the single compiled
          //     stochastic action at the end of a truncated prefix is ALWAYS the highest-EV extraction!
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

          // 3b-post) Post-turnover empty-plot planting:
          //          When deterministic `stockBuy -> craft -> sell` inside this bucket replenished wallet cash
          //          (e.g. `enableFirstBucketPlant: false` preserved pre-craft cash for cargo wine bundles),
          //          plant remaining empty plots deterministically BEFORE stochastic extraction!
          if (allowedSet.has('plant') && (execWorld.state?.plotN || 0) > 0) {
            const ps = execWorld.state
            const weatherNow = R.weatherOf(b.isleDay)
            const totalStochEn = totalBombs * (R.WORLD?.cost?.bomb ?? 6)
              + (totalBaitedFish + totalUnbaitedFish) * (R.WORLD?.cost?.fish ?? 4)
              + nMine * (R.WORLD?.cost?.mine ?? 3)
            const lowestStochPerEn = stochGroups.length > 0 ? stochGroups[stochGroups.length - 1].perEn : 0
            let simCashP = Math.max(0, Number(execWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
            let simEnP = Math.max(0, Math.floor(Number(ps.en || 0)))
            const postPlants = []
            for (let i = 0; i < ps.plotN; i++) {
              if (ps.plots?.[i]) continue
              const pCostEn = R.WORLD?.cost?.plant ?? 2
              if (simEnP < pCostEn) break
              const oppPerEn = simEnP - pCostEn < totalStochEn ? lowestStochPerEn : 0
              const bestP = selectBestCropToPlant(adapter, {
                state: ps,
                plotIdx: i,
                atSec: b.atSec,
                tEnd: tH,
                marginalItemValueFn,
                staminaPointCost: oppPerEn,
              })
              if (!bestP) continue
              const hasFreeSeed = adapter.availableInv(ps, `sd_${bestP.crop.id}`, 0) > 0
              const costCash = hasFreeSeed ? 0 : bestP.crop.seed
              if (costCash > simCashP) continue
              postPlants.push({ a: 'plant', i, c: bestP.crop.id })
              simCashP -= costCash
              simEnP -= pCostEn
              if (!R.sprinkled(ps, i) && weatherNow !== 1 && simEnP >= (R.WORLD?.cost?.water ?? 1)) {
                postPlants.push({ a: 'water', i })
                simEnP -= R.WORLD?.cost?.water ?? 1
              }
            }
            if (postPlants.length > 0) {
              pushAndSim(postPlants)
            }
          }

          for (const grp of stochGroups) {
            if (!grp.acts || grp.acts.length === 0) continue
            const remEnForStoch = Math.max(0, Math.floor(Number(execWorld.state?.en || 0)) - bucketEnFloor)
            if (remEnForStoch <= 0) break
            const sampleAct = grp.acts[0]
            const unitCost = sampleAct.a === 'bomb'
              ? (R.WORLD?.cost?.bomb ?? 6)
              : (sampleAct.a === 'fish' ? (R.WORLD?.cost?.fish ?? 4) : (R.WORLD?.cost?.mine ?? 3))
            const maxAffordEn = Math.floor(remEnForStoch / Math.max(1, unitCost))
            if (maxAffordEn <= 0) continue
            pushAndSim(grp.acts.slice(0, maxAffordEn))
          }
        }
      }
    }

    // 4. Execute optimal multi-bucket `sell` actions for any remaining/newly extracted inventory in this bucket!
    if (allowedSet.has('sell') && !(forcedTrunkSellPolicy === 'hold-in-first-bucket' && u === 0 && L > 1)) {
      emitOptimalBucketSells(u, b, dynamicPrices, pushAndSim)
    }

    finalBucketActions[u] = bucketActs
  }

  function emitOptimalBucketSells(u, b, dynamicPrices, pushAndSimFn) {
    const curAvail = adapter.availableInvSnapshot(execWorld.state)
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
      // deducting planned future crafts (`u+1..L-1`) from the arriving bucket backwards down to `0` (`curAvail`)
      // so cross-day crop sale tiers (`150` / `400`) account for upcoming harvests while reserving raw inputs!
      const remSupply = [
        [...(curAvail[id] || [0, 0, 0])],
        ...seqBuckets.slice(u + 1).map((_, idx) => [...(supplyByBucket[u + 1 + idx]?.[id] || [0, 0, 0])]),
      ]
      for (let relFu = 1; relFu < remSupply.length; relFu++) {
        const fu = u + relFu
        let needAtFu = 0
        for (const ca of jointCS.craftsByBucket[fu] || []) {
          if (ca.id === id) {
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
  const objEval = evaluateTrajectoryObjective(adapter, {
    initialWorld: initialWorldForObjective,
    finalWorld: finalWorldAtHorizon,
    cashEvents,
    objectiveCfg,
    scenarioSupplyFactor,
    explicitTerminalPrices: actualTermPrices,
    prevIsleSoldMap: actualTermPrevSold,
  })

  const marginalContext = {
    sourceWorldRev: startWorld?.rev ?? null,
    sourceIsleIndex: R.isleIndex(startWorld.now),
    sourceWorldDay: R.worldDay(startWorld.now),
    sourceCoins: Math.floor(Number(startWorld.coins || 0)),
    sourceEnergy: Math.floor(Number(startWorld.state?.en || 0)),
    seqBuckets,
    slots,
    supplyByBucket,
    jointCS,
    craftCapByIsle,
    enAfterPreByU,
    initialNatDay: R.worldDay(startWorld.now),
    initialCnt: startWorld.state?.cnt || {},
    allowCraft: allowedSet.has('craft'),
    maxCraftHoldIsleDays,
    u0MarginalStaminaMeta,
    baseWorldEn0: Number(startWorld.state?.en || 0),
    t0,
    tH,
    objectiveCfg,
    scenarioSupplyFactor,
    recipeInputSet: globalRecipeInputSet,
  }

  return {
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
  let replayCursor = 0
  const replayRand = typeof rand === 'function'
    ? () => (replayCursor < drawn.length ? drawn[replayCursor++] : rand())
    : null
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

/**
 * Unified Economic Kernel Solver (`solveUnifiedPlan`)
 *
 * Single mathematical brain across farming, ranching, cargo, workshop chains, crop tiers,
 * stamina conversion (`eat`/`coffee`), mining/fishing/bombing, CapEx, and neighbor raid (`visit`)!
 */
export function solveUnifiedPlan(adapter, envelope, objectiveCfgInput = {}, options = {}) {
  const startMs = performance.now()
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
  const preselectedCapexActions = selectCapexByTrajectoryDelta(adapter, {
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
      && !options.explicitPricesByBucket
      && !options.explicitPricesByIsleIndex
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
          explicitTerminalPrices: termP,
          prevIsleSoldMap: termPrev,
        })
        return {
          expectedValue: ev.totalObjectiveValue,
          policyExpectedValue: ev.totalObjectiveValue,
          policyMeta,
          trunkBucketsUsed: [],
          trunkActionsByBucket: [],
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
      })
      return {
        expectedValue: res.objectiveEval.totalObjectiveValue,
        policyExpectedValue: res.objectiveEval.totalObjectiveValue,
        policyMeta,
        trunkBucketsUsed: activeBuckets,
        trunkActionsByBucket: res.bucketActions,
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
    })

    // Replay ONLY the shared trunk actions `0..K-1` identically to obtain the exact common `worldAtBranchStart`!
    const K = activeTrunkMeta.length
    const trunkActions = lookaheadRun.bucketActions.slice(0, K)
    let trunkWorld = adapter.cloneWorld(startW)
    const trunkCashEvents = [...autoInitCashEvents]
    const trunkSoldByIsle = new Map()
    for (const [k, v] of startSoldMap.entries()) trunkSoldByIsle.set(k, { ...v })
    const replayPrng = typeof prngFactory === 'function' ? prngFactory() : adapter.makeSampleStreamPrng(0, initialObjectiveW.now)

    for (let u = 0; u < K; u++) {
      const b = activeTrunkMeta[u]
      trunkWorld = adapter.advanceTimeOnly(trunkWorld, b.atSec, { futurePrices: startW.prices || {} })
      trunkWorld = applyExogenousArrivals(trunkWorld, b.exogenousArrivalsAtStart)
      const acts = trunkActions[u] || []
      if (acts.length > 0) {
        const beforeC = Number(trunkWorld.coins || 0)
        const sim = adapter.simulateBatch(trunkWorld, acts, { t: b.atSec, prices: startW.prices || {}, rand: replayPrng })
        trunkWorld = sim.afterWorld
        const afterC = Number(trunkWorld.coins || 0)
        if (afterC !== beforeC) trunkCashEvents.push({ atSec: b.atSec, netCashDelta: afterC - beforeC })
        acts.forEach((act, idx) => {
          if (act.a === 'sell' && sim.result.out[idx]?.ok) {
            const m = trunkSoldByIsle.get(b.isleIndex) || {}
            m[act.id] = (m[act.id] || 0) + Number(act.n || 0)
            trunkSoldByIsle.set(b.isleIndex, m)
          }
        })
      }
    }

    // Now branch per scenario ω at `activeBranchMeta` (`isleDayOffset >= 1`), optimizing conditional recourse!
    let expectedVal = 0
    const scenarioBranches = {}
    const mergedDisc = {
      cashDiscretized: Boolean(lookaheadRun.discretizationMeta?.cashDiscretized),
      maxCashUnit: Number(lookaheadRun.discretizationMeta?.maxCashUnit || 1),
      minExactGcd: Number(lookaheadRun.discretizationMeta?.minExactGcd || 1),
      maxDpCells: Number(lookaheadRun.discretizationMeta?.maxDpCells || 0),
      sites: [...(lookaheadRun.discretizationMeta?.sites || [])],
    }
    for (const sc of scenarios) {
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
      })
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
        prevIsleSoldMap: termPrevSold,
      })
      expectedVal += sc.weight * fullEval.totalObjectiveValue
      scenarioBranches[sc.id] = {
        weight: sc.weight,
        objectiveValue: fullEval.totalObjectiveValue,
        bucketActions: branchRes.bucketActions,
      }
    }

    return {
      expectedValue: expectedVal,
      policyExpectedValue: expectedVal,
      policyMeta,
      trunkBucketsUsed: activeTrunkMeta,
      trunkActionsByBucket: trunkActions,
      discretizationMeta: mergedDisc,
      marginalContext: lookaheadRun.marginalContext,
      scenarioBranches,
    }
  }

  const minGapSec = adapter.R.WORLD?.minGap || 2
  const tHorizonEnd = world0.now + Math.max(0, Math.floor(objectiveCfg.horizonSec || 0))
  const remArrivalsAfterT0 = (options.deterministicArrivals || []).filter((a) => a.atSec > world0.now)
  const scoredPrefixCache = new Map()

  const evalContinuationFromPostPrefix = (afterPrefixWorld, prefixCashEvents, prefixSoldMap, prngFactory = null, contPolicyMode = 'optimal') => {
    const tFollow = Math.min(tHorizonEnd, world0.now + minGapSec)
    const wCont = tFollow > afterPrefixWorld.now
      ? adapter.advanceTimeOnly(afterPrefixWorld, tFollow, { futurePrices: world0.prices || {} })
      : afterPrefixWorld
    const baseMaxB = options.maxBuckets || 16
    const contMaxBuckets = prngFactory != null
      ? Math.min(8, baseMaxB)
      : baseMaxB
    const contBuckets = tFollow < tHorizonEnd
      ? buildEventBuckets(adapter, wCont, {
          horizonSec: tHorizonEnd - tFollow,
          deterministicArrivals: remArrivalsAfterT0,
          maxBuckets: contMaxBuckets,
          coalesceWindowSec: options.coalesceWindowSec ?? 5,
          preservePrefixThroughSec: prngFactory != null ? null : (options.preservePrefixThroughSec ?? null),
          prefixMaxBuckets: prngFactory != null ? null : (options.prefixMaxBuckets ?? null),
        }).buckets
      : []
    const modeToUse = contPolicyMode === 'hold-in-first-bucket' && contBuckets.length > 1
      ? 'hold-in-first-bucket'
      : 'optimal'
    return evaluateTrunkPolicy(modeToUse, wCont, world0, {
      customBuckets: contBuckets,
      capexActionsAtStart: [],
      initialCashEventsOverride: prefixCashEvents,
      initialSoldByIsleOverride: prefixSoldMap,
      prngFactory,
    })
  }

  // True Policy Expectation Evaluator (`Round-2 P1-1`):
  // Scores EVERY domestic candidate BEFORE ranking so candidate comparison (`candidateModes`, `upstreamVariants`)
  // and final quality reporting BOTH use true stochastic policy expectation (exact discrete outcome enumeration
  // for single `harvest`/`fish`/`mine`, or paired Common-Random-Number M-stream Monte Carlo with `rand:`)!
  const scoreDomesticCandidate = (cand) => {
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
    if (!hasDomStoch) {
      cand.policyExpectedValue = cand.expectedValue
      cand.standardError = 0
      cand.confidenceInterval95 = null
      cand.policySampleCount = null
      cand.valueInterpretation = scenarios.length === 1
        ? 'deterministic-exact'
        : 'conditional-scenario-expectation'
      return cand
    }

    const b0 = cand.trunkBucketsUsed?.[0]
    const dom0 = cand.trunkActionsByBucket?.[0] || []
    const firstStochIdx = dom0.findIndex((a) => adapter.isStochasticAction(a))
    const contMode = cand.policyMeta?.trunkPolicyMode === 'hold-in-first-bucket' ? 'hold-in-first-bucket' : 'optimal'
    let causalPref = dom0
    if (firstStochIdx >= 0 && b0) {
      const p0Tmp = makePricesFn(scenarios[0])(b0, baseSoldByIsle)
      let w0Tmp = adapter.advanceTimeOnly(world0, b0.atSec, { futurePrices: p0Tmp })
      w0Tmp = applyExogenousArrivals(w0Tmp, b0.exogenousArrivalsAtStart)
      causalPref = computeCausalStochasticPrefix(adapter, w0Tmp, dom0, adapter.R.WORLD?.maxActions || 40).prefix
    }
    const compiledPrefix = firstStochIdx >= 0 ? causalPref : dom0
    const cacheKey = b0
      ? JSON.stringify({ k: firstStochIdx >= 0 ? 'pref' : 'det0', contMode, pref: compiledPrefix })
      : JSON.stringify({ k: 'full', meta: cand.policyMeta, acts: cand.trunkActionsByBucket })

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
    if (firstStochIdx >= 0 && trunkStochCount === 1 && branchStochCount === 0 && b0) {
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
          for (const br of exactBranches) {
            if (isPastDeadline()) {
              anyFurtherStoch = true
              break
            }
            const brCash = [...preCash]
            const dC = Number(br.afterWorld.coins || 0) - Number(wAt0.coins || 0)
            if (dC !== 0) brCash.push({ atSec: b0.atSec, netCashDelta: dC })
            const cont = evalContinuationFromPostPrefix(br.afterWorld, brCash, preSold, null, contMode)
            const contStoch = (cont.trunkActionsByBucket || []).some((ba) => (ba || []).some((a) => adapter.isStochasticAction(a)))
              || Object.values(cont.scenarioBranches || {}).some((sb) => (sb.bucketActions || []).some((ba) => (ba || []).some((a) => adapter.isStochasticAction(a))))
            if (contStoch) {
              anyFurtherStoch = true
              break
            }
            exactMean += br.prob * cont.expectedValue
          }
          if (!anyFurtherStoch) {
            const stats = {
              policyExpectedValue: exactMean,
              standardError: 0,
              confidenceInterval95: [exactMean, exactMean],
              policySampleCount: exactBranches.length,
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
      const defaultM = scenarios.length > 1 && buckets.length > 4 ? 4 : 8
      const M = Math.max(4, Math.floor(Number(options.stochasticPolicySamples ?? defaultM)))
      const sampleVals = []

      // Pre-compute deterministic prefix state once when `firstStochIdx === -1 && b0`!
      let detPostPrefix = null
      if (firstStochIdx === -1 && b0) {
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
        if (m === 0 && !fixedStochPrefix) {
          // Stream 0 already ran identically in `evaluateTrunkPolicy(..., prngFactory: null)`!
          sampleVals.push(cand.expectedValue)
          continue
        }
        const prngFactory = () => adapter.makeSampleStreamPrng(m, world0.now)
        if (fixedStochPrefix && b0) {
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
          const cont = evalContinuationFromPostPrefix(simPref.afterWorld, preCash, preSold, prngFactory, contMode)
          sampleVals.push(cont.expectedValue)
        } else if (detPostPrefix) {
          const cont = evalContinuationFromPostPrefix(
            detPostPrefix.afterWorld,
            detPostPrefix.preCash,
            detPostPrefix.preSold,
            prngFactory,
            contMode
          )
          sampleVals.push(cont.expectedValue)
        } else {
          const roll = evaluateTrunkPolicy(cand.policyMeta?.trunkPolicyMode || 'optimal', world0, world0, {
            enableFirstBucketPlant: cand.policyMeta?.enableFirstBucketPlant ?? true,
            enableFirstBucketStockBuy: cand.policyMeta?.enableFirstBucketStockBuy ?? true,
            prngFactory,
          })
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
      if (usedM === M) scoredPrefixCache.set(cacheKey, stats)
      Object.assign(cand, stats)
    }

    return cand
  }

  // Compare candidate trunk commitments (`optimal` vs `hold-in-first-bucket` vs `sell-all-now`)
  // AND candidate upstream add/drop variants (`with/without first-bucket plant & stockBuy`) strictly
  // by `cand.policyExpectedValue`!
  const hasImmediatePrefixStochastic = (cand) =>
    (cand.trunkActionsByBucket?.[0] || []).some((a) => adapter.isStochasticAction(a))

  const candidateModes = buckets.length > 1 && allowedSet.has('sell')
    ? ['optimal', 'hold-in-first-bucket', 'sell-all-now']
    : ['optimal']

  let bestDomestic = null
  for (const mode of candidateModes) {
    if (bestDomestic && isPastDeadline()) break
    const rawCand = evaluateTrunkPolicy(mode, world0, world0)
    const cand = hasImmediatePrefixStochastic(rawCand) ? scoreDomesticCandidate(rawCand) : rawCand
    if (!bestDomestic || cand.policyExpectedValue > bestDomestic.policyExpectedValue + 1e-6) {
      bestDomestic = cand
    }
  }

  const firstBucketActs0 = bestDomestic.trunkActionsByBucket[0] || []
  const usedPlant0 = firstBucketActs0.some((a) => a.a === 'plant')
  const usedStockBuy0 = firstBucketActs0.some((a) => a.a === 'stockBuy')
  const upstreamVariants = []
  if (usedPlant0) upstreamVariants.push({ enableFirstBucketPlant: false, enableFirstBucketStockBuy: true })
  if (usedStockBuy0) upstreamVariants.push({ enableFirstBucketPlant: true, enableFirstBucketStockBuy: false })
  if (usedPlant0 && usedStockBuy0) upstreamVariants.push({ enableFirstBucketPlant: false, enableFirstBucketStockBuy: false })
  for (const uv of upstreamVariants) {
    if (isPastDeadline()) break
    const rawCand = evaluateTrunkPolicy('optimal', world0, world0, uv)
    const cand = hasImmediatePrefixStochastic(rawCand) ? scoreDomesticCandidate(rawCand) : rawCand
    if (cand.policyExpectedValue > bestDomestic.policyExpectedValue + 1e-6) {
      bestDomestic = cand
    }
  }

  // Ensure the selected winning domestic candidate ALWAYS carries full stochastic policy expectation & SE metadata!
  if (bestDomestic && bestDomestic.valueInterpretation == null) {
    scoreDomesticCandidate(bestDomestic)
  }

  // Unified Steal Raid Valuation:
  // - Combinational `R.THIEF_ITEMS` + stamina prep
  // - Sequential Conditional Multi-Raid Packing (prevents double-counting shared workshop/tier capacities across targets!)
  // - Consistent Post-Prep Continuation Timeline (when `raidPrepActs` occupies `t0`, domestic work is evaluated at `t0 + minGap`!)
  const selectedVisits = []
  let raidPrepActs = []
  let raidAdjustedDomestic = bestDomestic

  if (
    allowedSet.has('visit') &&
    constraints.maxStealsPerIsleDay !== 0 &&
    Array.isArray(envelope.beliefs?.visitBeliefs) &&
    envelope.beliefs.visitBeliefs.length > 0
  ) {
    const remStealBudget = constraints.maxStealsPerIsleDay == null
      ? Infinity
      : Math.max(0, constraints.maxStealsPerIsleDay - Number(envelope.reservedBudgets?.stealUsedOrReservedThisIsleDay || 0))
    const minSpots = Number(options.minStealSpots ?? constraints.minStealSpots ?? 0)
    const eligibleRawBeliefs = envelope.beliefs.visitBeliefs.filter(
      (b) => b && b.targetId != null && b.totalSpots > 0 && b.totalSpots >= minSpots
    )

    if (remStealBudget > 0 && eligibleRawBeliefs.length > 0) {
      const packRes = packRaidsOnMarginalContext(adapter, {
        worldAtNow: world0,
        marginalCtx: bestDomestic.marginalContext,
        eligibleRawBeliefs,
        rawNeighborTargetsById: options.rawNeighborTargetsById || null,
        constraints,
        allowedSet,
        utilityTokens,
        remStealBudget,
        isPastDeadlineFn: isPastDeadline,
      })

      if (packRes && packRes.visits.length > 0) {
        selectedVisits.push(...packRes.visits)
        raidPrepActs = packRes.prepActs
        if (raidPrepActs.length > 0) {
          const tContRaid = Math.min(tHorizonEnd, world0.now + minGapSec)
          const evalBaseWorld = adapter.advanceTimeOnly(packRes.afterPrepWorld, tContRaid, { futurePrices: world0.prices || {} })
          const raidContBuckets = tContRaid < tHorizonEnd
            ? buildEventBuckets(adapter, evalBaseWorld, {
                horizonSec: tHorizonEnd - tContRaid,
                deterministicArrivals: remArrivalsAfterT0,
                maxBuckets: options.maxBuckets || 16,
                coalesceWindowSec: options.coalesceWindowSec ?? 5,
              }).buckets
            : []
          raidAdjustedDomestic = evaluateTrunkPolicy('optimal', evalBaseWorld, world0, {
            customBuckets: raidContBuckets,
            capexActionsAtStart: preselectedCapexActions,
          })
        } else {
          raidAdjustedDomestic = bestDomestic
        }
      }
    }
  }

  // Assemble `trunkBuckets` output:
  // When `selectedVisits.length > 0 && raidPrepActs.length > 0`, `trunkBuckets[0]` at `t0` contains ONLY `raidPrepActs`,
  // followed by the deferred continuation buckets `raidAdjustedDomestic.trunkBucketsUsed` at `t0 + minGap`!
  let trunkBuckets
  if (selectedVisits.length > 0 && raidPrepActs.length > 0) {
    const firstMeta = trunkBucketsMeta[0]
    const contUsed = raidAdjustedDomestic.trunkBucketsUsed || []
    const contActs = raidAdjustedDomestic.trunkActionsByBucket || []
    trunkBuckets = [
      {
        ...firstMeta,
        nextAtSec: contUsed.length > 0 ? contUsed[0].atSec : firstMeta.nextAtSec,
        domesticActions: raidPrepActs,
        visitActions: selectedVisits,
        visitFirst: false,
      },
      ...contUsed.map((bMeta, idx) => ({
        ...bMeta,
        index: idx + 1,
        domesticActions: contActs[idx] || [],
        visitActions: [],
        visitFirst: false,
      })),
    ]
  } else {
    const usedMeta = raidAdjustedDomestic.trunkBucketsUsed || trunkBucketsMeta
    trunkBuckets = usedMeta.map((b, idx) => ({
      ...b,
      domesticActions: raidAdjustedDomestic.trunkActionsByBucket[idx] || [],
      visitActions: idx === 0 ? selectedVisits : [],
      visitFirst: idx === 0 && selectedVisits.length > 0,
    }))
  }

  // Check if any stochastic action appears in the active plan (across trunk OR scenario recourse branches!)
  const branchHasStochastic = Object.values(raidAdjustedDomestic.scenarioBranches || {}).some((br) =>
    (br.bucketActions || []).some((bActs) => (bActs || []).some((a) => adapter.isStochasticAction(a)))
  )
  const hasDomesticStochastic = trunkBuckets.some((b) =>
    b.domesticActions.some((a) => adapter.isStochasticAction(a))
  ) || branchHasStochastic
  const hasStochasticInPlan = hasDomesticStochastic || selectedVisits.length > 0

  const netRaidDeltaOverBase0 = selectedVisits.length > 0
    ? (raidAdjustedDomestic.expectedValue + (selectedVisits[0]?.expectedDeltaObjectiveMid || 0)) - bestDomestic.expectedValue
    : 0
  const feasibleIncumbentValue = selectedVisits.length > 0
    ? bestDomestic.policyExpectedValue + netRaidDeltaOverBase0
    : bestDomestic.policyExpectedValue
  const standardError = selectedVisits.length > 0 ? 0 : (bestDomestic.standardError || 0)
  const confidenceInterval95 = selectedVisits.length > 0 ? null : (bestDomestic.confidenceInterval95 || null)
  const policySampleCount = selectedVisits.length > 0 ? null : (bestDomestic.policySampleCount || null)
  const valueInterpretation = selectedVisits.length > 0
    ? 'conditional-scenario-expectation'
    : (bestDomestic.valueInterpretation || (scenarios.length === 1 ? 'deterministic-exact' : 'conditional-scenario-expectation'))

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

  // Determine exact livelock-proof `nextWakeSec`
  const minWakeFloorSec = world0.now + Math.max(5, minGapSec)
  let nextWakeIdx = 1
  if (trunkBuckets[0]?.domesticActions.length === 0 && trunkBuckets[0]?.visitActions.length === 0) {
    for (let idx = 1; idx < buckets.length; idx++) {
      const bMeta = buckets[idx]
      const tb = trunkBuckets[idx]
      const hasPlannedWork = (tb?.domesticActions?.length || 0) > 0 || (tb?.visitActions?.length || 0) > 0
      const revealsNewInfo = !bMeta.isTrunkBeforePriceReveal || (bMeta.exogenousArrivalsAtStart?.length || 0) > 0
      const beyondTrunkEvent = idx >= trunkBuckets.length
      if (hasPlannedWork || revealsNewInfo || beyondTrunkEvent) {
        nextWakeIdx = idx
        break
      }
    }
  }
  let nextWakeSec = buckets.length > nextWakeIdx
    ? buckets[nextWakeIdx].atSec
    : world0.now + Math.min(300, Math.max(60, objectiveCfg.horizonSec || 300))
  const nextRegenSec = Number(world0.state?.en || 0) < adapter.R.energyMax(world0.state)
    ? Math.max(minWakeFloorSec, Number(world0.state?.enT || world0.now) + (adapter.R.WORLD?.regen || 180))
    : Infinity
  if (Number.isFinite(nextRegenSec) && nextRegenSec < nextWakeSec && nextRegenSec > world0.now) {
    if (Number(world0.state?.en || 0) < 4) nextWakeSec = nextRegenSec
  }
  nextWakeSec = Math.max(minWakeFloorSec, nextWakeSec)

  const elapsedMs = performance.now() - startMs

  return {
    planId: crypto.randomUUID(),
    account: envelope.account,
    rulesHash: adapter.rulesHash,
    objectiveHash: objectiveCfg.objectiveHash,
    constraintsHash: envelope.constraintsHash,
    constraints,
    serverNow: world0.now,
    horizonSec: objectiveCfg.horizonSec,
    terminalMethod: objectiveCfg.terminalSupplyMode,
    trunkBuckets,
    scenarioBranches: raidAdjustedDomestic.scenarioBranches,
    marginalContext: bestDomestic.marginalContext || null,
    nextWakeSec,
    waitReason: trunkBuckets[0]?.domesticActions.length === 0 && trunkBuckets[0]?.visitActions.length === 0
      ? (buckets[nextWakeIdx]?.reasons?.join(',') || 'hold-for-future-event-or-price-reveal')
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
    },
  }
}

/**
 * Rolling-Horizon Prefix Stability Check (`round2-design-review.md §3`):
 * Compares executable `trunkBuckets[0]` under `H` vs `H + ΔH`, preserving `[t0, t0 + H]`
 * event buckets identically and skipping the extended check cleanly if `deadlineAtMs` is near!
 */
export function solveWithHorizonStability(adapter, envelope, objectiveCfgInput = {}, options = {}) {
  const nowMsFn = typeof options.nowMsFn === 'function' ? options.nowMsFn : Date.now
  const deadlineAtMs = Number.isFinite(options.deadlineAtMs)
    ? Number(options.deadlineAtMs)
    : (Number.isFinite(options.maxSolveMs) ? nowMsFn() + Number(options.maxSolveMs) : Infinity)

  const baseCfg = objectiveCfgInput?.objectiveHash
    ? objectiveCfgInput
    : buildObjectiveConfig(objectiveCfgInput)
  const extCfg = buildObjectiveConfig({
    ...baseCfg,
    horizonSec: baseCfg.horizonSec + (baseCfg.extendedHorizonDeltaSec || 2 * 14400),
  })

  const baseMaxBuckets = options.maxBuckets || 16
  const basePlan = solveUnifiedPlan(adapter, envelope, baseCfg, {
    ...options,
    nowMsFn,
    deadlineAtMs,
  })

  if (Number.isFinite(deadlineAtMs)) {
    const minExtBudgetMs = Math.max(50, Number(basePlan.quality?.elapsedMs || 0) * 0.7)
    if (nowMsFn() + minExtBudgetMs >= deadlineAtMs || basePlan.quality?.pruning?.deadlineReached) {
      return {
        prefixStable: null,
        skippedByDeadline: true,
        basePlan,
        extendedPlan: null,
      }
    }
  }

  const extScale = extCfg.horizonSec / Math.max(1, baseCfg.horizonSec)
  const extMaxBuckets = Math.max(baseMaxBuckets + 4, Math.ceil(baseMaxBuckets * extScale))
  const t0 = Number(envelope.observed?.world?.now || 0)
  const extendedPlan = solveUnifiedPlan(adapter, envelope, extCfg, {
    ...options,
    nowMsFn,
    deadlineAtMs,
    maxBuckets: extMaxBuckets,
    preservePrefixThroughSec: t0 + Math.max(0, Math.floor(baseCfg.horizonSec || 0)),
    prefixMaxBuckets: baseMaxBuckets,
  })

  const sig0 = JSON.stringify({
    dom: basePlan.trunkBuckets[0]?.domesticActions || [],
    vis: (basePlan.trunkBuckets[0]?.visitActions || []).map((v) => v.targetId),
  })
  const sig1 = JSON.stringify({
    dom: extendedPlan.trunkBuckets[0]?.domesticActions || [],
    vis: (extendedPlan.trunkBuckets[0]?.visitActions || []).map((v) => v.targetId),
  })

  return {
    prefixStable: sig0 === sig1,
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
  const touchesCraft = allowCraft && (
    craftEnTightened ||
    changedIds.some((id) => recipeInputSet.has(id) || adapter.graph.recipesById.has(id))
  )

  let invAndCraftDelta = 0
  let nextCraftEn0 = baseCraftEn0

  if (touchesCraft) {
    const nextSupply = applyInvDeltaToSupplyTable(supplyByBucket, invDeltaById)
    const nextRawEval = changedIds.length > 0
      ? evaluateSupplyPortfolioIncremental(adapter, {
          baseEval: jointCS.baseRawPortfolio,
          supplyByBucket: nextSupply,
          changedItemIds: changedIds,
          slots,
          initialNatDay,
          initialCnt,
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
    })
    invAndCraftDelta = nextJointCS.netPortfolioScore - jointCS.netPortfolioScore
    nextCraftEn0 = countIsle0CraftEn(nextJointCS.craftsByBucket)
  } else if (changedIds.length > 0) {
    const nextAfterCraftSupply = applyInvDeltaToSupplyTable(jointCS.supplyAfterCrafts, invDeltaById)
    const nextSaleEval = evaluateSupplyPortfolioIncremental(adapter, {
      baseEval: jointCS.salePortfolio,
      supplyByBucket: nextAfterCraftSupply,
      changedItemIds: changedIds,
      slots,
      initialNatDay,
      initialCnt,
    })
    invAndCraftDelta = nextSaleEval.totalValue - jointCS.salePortfolio.totalValue
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

    const stateMemo = new Map()
    const evalStateDelta = (enVal, invDeltaMap) => {
      const mKey = `${enVal}:${JSON.stringify(invDeltaMap)}`
      let hit = stateMemo.get(mKey)
      if (hit === undefined) {
        hit = evaluateMarginalRaidDelta(adapter, marginalCtx, {
          invDeltaById: invDeltaMap,
          postRaidEn: enVal,
          cashSpent,
          coffeeUsedInPrep,
        })
        stateMemo.set(mKey, hit)
      }
      return hit
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

  let marginalCtx = precomputedMarginalContext
  if (
    marginalCtx &&
    ((marginalCtx.sourceWorldRev != null && world0.rev != null && marginalCtx.sourceWorldRev !== world0.rev) ||
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
