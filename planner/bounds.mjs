import { buildContinuationTimeline, buildObjectiveConfig, buildTerminalPrices, discountFactor } from '../model/objective.mjs'

/**
 * Computes a mathematically valid Lagrangian Relaxation Upper Bound U(λ) >= opt*
 * for deterministic multi-period resource allocation subproblems (round2-design-review.md §2).
 *
 * CRITICAL INVARIANTS:
 * 1. If `candidateSetComplete === false` or inner maximization is pruned/incomplete,
 *    MUST return `{ validUpperBound: null, reason: 'incomplete-candidate-set' }`.
 * 2. If stochastic transitions (`harvest`, `fish`, `mine`, `bomb`, `trap`, `visit`) are active
 *    in `allowedActionTypes`, returns `{ validUpperBound: null, reason: 'stochastic-actions-require-distribution-tree' }`
 *    so a single sample or heuristic is NEVER mislabeled as a valid upper bound.
 * 3. Inequality dual multipliers λ >= 0 are strictly projected onto R_+^m; the inner problem over
 *    the exact box domain X is solved in closed form to 100% global optimality `sup_{x in X}`.
 */
export function computeValidUpperBound(adapter, {
  world,
  buckets,
  pricesByBucket,
  objectiveCfg = buildObjectiveConfig(),
  allowedActionTypes = ['sell', 'craft', 'wait'],
  candidateSetComplete = true,
  innerPruningApplied = false,
  subgradientIterations = 60,
} = {}) {
  if (!candidateSetComplete || innerPruningApplied) {
    return {
      validUpperBound: null,
      status: 'refused-pruned-inner',
      reason: 'Inner candidate set was pruned or incomplete; refusing to report invalid upper bound.',
    }
  }

  const allowed = new Set(allowedActionTypes)
  for (const stAct of ['harvest', 'fish', 'mine', 'bomb', 'trap', 'visit', 'npc', 'scratch']) {
    if (allowed.has(stAct)) {
      return {
        validUpperBound: null,
        status: 'not-applicable-stochastic',
        reason: `Action '${stAct}' has stochastic transitions; deterministic weak-duality bound not claimed.`,
      }
    }
  }
  // Only certify exact deterministic resource-flow action families (sell, craft, wait, stockBuy, buy, eat, coffee)
  for (const a of allowed) {
    if (!['sell', 'craft', 'wait', 'stockBuy', 'buy', 'eat', 'coffee'].includes(a)) {
      return {
        validUpperBound: null,
        status: 'unsupported-action-in-bound',
        reason: `Action '${a}' not included in exact linear relaxation; reporting unknown upper bound.`,
      }
    }
  }

  const { R, graph } = adapter
  adapter.syncClock(world?.clockStart)
  const t0 = Number(world?.now || 0)
  const w0 = adapter.advanceTimeOnly(world, t0, { futurePrices: world?.prices || {} })
  const B = buckets.length
  const tH = B > 0 ? buckets[B - 1].nextAtSec : t0
  const initCoins = Number(w0?.coins || 0)
  const avail0 = adapter.availableInvSnapshot(w0?.state)

  // Collect exogenous arrivals per bucket
  const exoByBucket = buckets.map((b) => {
    const m = {}
    for (const g of b.exogenousArrivalsAtStart || []) {
      m[g.id] ||= [0, 0, 0]
      m[g.id][g.q || 0] += Number(g.n || 0)
    }
    return m
  })

  // Terminal continuation timeline starting at t_H
  const termWorldStub = { ...world, now: tH }
  const contSlots = objectiveCfg.terminalSupplyMode === 'zero'
    ? []
    : buildContinuationTimeline(adapter, termWorldStub, world, objectiveCfg, null)
  const termPrices = objectiveCfg.terminalSupplyMode === 'zero'
    ? {}
    : (contSlots[0]?.prices ?? buildTerminalPrices(adapter, termWorldStub, world, objectiveCfg, null))

  const allSlots = [
    ...buckets.map((b, idx) => ({
      slotIdx: idx,
      atSec: b.atSec,
      nextAtSec: b.nextAtSec,
      naturalDay: b.naturalDay,
      isleIndex: b.isleIndex,
      isleDay: b.isleDay,
      prices: pricesByBucket?.[idx] || world?.prices || {},
      isTerminal: false,
      disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, b.atSec - t0)),
    })),
    ...(objectiveCfg.terminalSupplyMode === 'zero'
      ? []
      : contSlots.length > 1
        ? contSlots.map((cs, idx) => ({
            slotIdx: B + idx,
            atSec: cs.atSec,
            nextAtSec: cs.nextAtSec,
            naturalDay: cs.naturalDay,
            isleIndex: cs.isleIndex,
            isleDay: cs.isleDay,
            prices: cs.prices,
            isTerminal: true,
            disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, cs.atSec - t0)),
          }))
        : [{
            slotIdx: B,
            atSec: tH,
            nextAtSec: tH,
            naturalDay: R.worldDay(tH),
            isleIndex: R.isleIndex(tH),
            isleDay: R.isleDay(tH),
            prices: termPrices,
            isTerminal: true,
            disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, tH - t0)),
          }]),
  ]
  const S = allSlots.length
  const craftBoundSlots = contSlots.length > 1 ? S : B

  // Identify relevant items (all items with initial stock, arrivals, edibles including snacks, cargo stockBuy, or recipes)
  const edibleSpecs = typeof adapter.listDeterministicEdibleSpecs === 'function'
    ? adapter.listDeterministicEdibleSpecs()
    : []
  const itemSet = new Set([
    ...Object.keys(avail0),
    ...graph.sellableIds,
    ...(R.RECIPES || []).map((r) => r.id),
    ...edibleSpecs.map((e) => e.id),
  ])
  for (const m of exoByBucket) for (const id of Object.keys(m)) itemSet.add(id)
  if (allowed.has('stockBuy') && typeof R.b12Stock === 'function') {
    for (let b = 0; b < B; b++) {
      for (const stItem of R.b12Stock(allSlots[b].atSec, allSlots[b].prices)) {
        itemSet.add(stItem.id)
      }
    }
  }
  const items = [...itemSet]

  // Group slots by isleIndex and naturalDay
  const isleIndices = [...new Set(allSlots.slice(0, craftBoundSlots).map((s) => s.isleIndex))]
  const naturalDays = [...new Set(allSlots.map((s) => s.naturalDay))]

  const initIsleIdx = R.isleIndex(t0)
  const initNatDay = R.worldDay(t0)
  const craftCapByIsle = new Map()
  for (const idx of isleIndices) {
    const used = idx === initIsleIdx && w0?.state?.iq?.d === idx ? Number(w0.state.iq.craft || 0) : 0
    craftCapByIsle.set(idx, allowed.has('craft') ? Math.max(0, (R.WORLD?.daily?.craft || 80) - used) : 0)
  }

  // Max cumulative natural regen by slot (accounting for exact enT remainder after refreshing to t0)
  const initEn = Number(w0?.state?.en || 0)
  const regenEvery = R.WORLD?.regen || 180
  const baseEnT = Number.isFinite(w0?.state?.enT) ? Number(w0.state.enT) : t0
  const maxRegenTo = (sec) => Math.max(
    0,
    Math.ceil(Math.max(0, sec - t0) / regenEvery),
    Math.floor(Math.max(0, sec - baseEnT) / regenEvery)
  )

  // Supply constants per item
  const q2Max = {}
  const q12Max = {}
  const prefixTotalSupply = {} // [item][slotIdx]
  for (const id of items) {
    let c2 = avail0[id]?.[2] || 0
    let c12 = (avail0[id]?.[1] || 0) + c2
    for (let b = 0; b < B; b++) {
      c2 += exoByBucket[b][id]?.[2] || 0
      c12 += (exoByBucket[b][id]?.[1] || 0) + (exoByBucket[b][id]?.[2] || 0)
    }
    q2Max[id] = c2
    q12Max[id] = c12
    prefixTotalSupply[id] = new Array(S).fill(0)
    let cum = (avail0[id]?.[0] || 0) + (avail0[id]?.[1] || 0) + (avail0[id]?.[2] || 0)
    for (let s = 0; s < S; s++) {
      if (s < B) {
        const ex = exoByBucket[s][id]
        if (ex) cum += (ex[0] || 0) + (ex[1] || 0) + (ex[2] || 0)
      }
      prefixTotalSupply[id][s] = cum
    }
  }

  // Build exact variable list over finite box bounds
  // Constraints (all >= 0 dual multipliers λ_c >= 0 for A x <= rhs):
  const constraints = []
  const addConstraint = (key, rhs) => {
    const idx = constraints.length
    constraints.push({ idx, key, rhs: Math.max(0, rhs) })
    return idx
  }

  const cQ2 = new Map()
  const cQ12 = new Map()
  const cPrefixItem = new Map() // `${id}@${s}` -> constraintIdx
  for (const id of items) {
    cQ2.set(id, addConstraint(`q2:${id}`, q2Max[id]))
    cQ12.set(id, addConstraint(`q12:${id}`, q12Max[id]))
    for (let s = 0; s < S; s++) {
      cPrefixItem.set(`${id}@${s}`, addConstraint(`bal:${id}@${s}`, prefixTotalSupply[id][s]))
    }
  }

  const cCraftIsle = new Map()
  for (const idx of isleIndices) {
    cCraftIsle.set(idx, addConstraint(`craft:${idx}`, craftCapByIsle.get(idx)))
  }

  const cPrefixEn = []
  for (let b = 0; b < craftBoundSlots; b++) {
    cPrefixEn.push(addConstraint(`en@${b}`, initEn + maxRegenTo(allSlots[b].nextAtSec)))
  }

  const cCropTier = new Map() // `${id}:${nd}:${tierIdx}` -> constraintIdx
  for (const id of items) {
    if (!graph.cropsById.has(id)) continue
    for (const nd of naturalDays) {
      const sold0 = nd === initNatDay && w0?.state?.enDay === nd ? Number(w0?.state?.cnt?.['sc_' + id] || 0) : 0
      const cap0 = Math.max(0, 150 - sold0)
      const cap1 = Math.max(0, 400 - Math.max(150, sold0))
      cCropTier.set(`${id}:${nd}:0`, addConstraint(`tier0:${id}:${nd}`, cap0))
      cCropTier.set(`${id}:${nd}:1`, addConstraint(`tier1:${id}:${nd}`, cap1))
    }
  }

  // Variables: { ub, obj, terms: [[cIdx, coeff], ...] }
  const vars = []

  // 1) Sell variables (both in-horizon and terminal liquidation slot)
  const canSellInHorizon = allowed.has('sell')
  for (let s = 0; s < S; s++) {
    const slot = allSlots[s]
    if (!slot.isTerminal && !canSellInHorizon) continue
    for (const id of items) {
      const baseP = Number(R.BASE_PRICE?.[id] || 0)
      const quoteP = Number(slot.prices?.[id] || 0)
      if (!(baseP > 0) || !(quoteP > 0)) continue
      const isCrop = graph.cropsById.has(id)
      const maxTotalPossible = prefixTotalSupply[id][S - 1] + (allowed.has('craft') ? 80 * Math.max(1, isleIndices.length) : 0) + (allowed.has('stockBuy') ? 24 * Math.max(1, isleIndices.length) : 0)
      if (maxTotalPossible <= 0) continue

      for (const q of [0, 1, 2]) {
        if (q === 2 && q2Max[id] <= 0) continue
        if (q === 1 && q12Max[id] <= 0) continue
        const unit = Math.round(quoteP * (R.QUALITY?.[q] ?? 1))
        const tiers = isCrop ? [[0, 1.0], [1, 0.85], [2, 0.70]] : [[2, 1.0]]
        for (const [tIdx, mult] of tiers) {
          // Upper-envelope unit revenue: ceil(unit * mult) guarantees batch rounding Math.round(sum) never exceeds sum of ceilings!
          const unitCeil = Math.ceil(unit * mult - 1e-9)
          let ub = maxTotalPossible
          if (q === 2) ub = Math.min(ub, q2Max[id])
          else if (q === 1) ub = Math.min(ub, q12Max[id])
          if (isCrop && tIdx < 2) {
            const tC = cCropTier.get(`${id}:${slot.naturalDay}:${tIdx}`)
            ub = Math.min(ub, constraints[tC].rhs)
          }
          if (ub <= 0) continue
          const terms = []
          if (q === 2) terms.push([cQ2.get(id), 1])
          if (q >= 1) terms.push([cQ12.get(id), 1])
          for (let futureS = s; futureS < S; futureS++) {
            terms.push([cPrefixItem.get(`${id}@${futureS}`), 1])
          }
          if (isCrop && tIdx < 2) {
            terms.push([cCropTier.get(`${id}:${slot.naturalDay}:${tIdx}`), 1])
          }
          vars.push({ ub, obj: unitCeil * slot.disc, terms })
        }
      }
    }
  }

  // 2) Craft variables in slots 0..craftBoundSlots-1
  if (allowed.has('craft')) {
    const craftEnCost = R.WORLD?.cost?.craft ?? 1
    for (let b = 0; b < craftBoundSlots; b++) {
      const slot = allSlots[b]
      const cap = craftCapByIsle.get(slot.isleIndex) || 0
      if (cap <= 0) continue
      for (const r of R.RECIPES || []) {
        const terms = [[cCraftIsle.get(slot.isleIndex), 1]]
        for (let fb = b; fb < craftBoundSlots; fb++) {
          terms.push([cPrefixEn[fb], craftEnCost])
        }
        for (let fs = b; fs < S; fs++) {
          for (const [inId, qty] of Object.entries(r.in || {})) {
            terms.push([cPrefixItem.get(`${inId}@${fs}`), qty])
          }
          // Output reduces net consumption on r.id from slot b onwards!
          terms.push([cPrefixItem.get(`${r.id}@${fs}`), -1])
        }
        vars.push({ ub: cap, obj: 0, terms })
      }
    }
  }

  // 3) Cargo stockBuy variables per isleDay (placed at earliest bucket of that isleDay)
  if (allowed.has('stockBuy') && typeof R.b12Stock === 'function') {
    const seenIsle = new Set()
    for (let b = 0; b < B; b++) {
      const slot = allSlots[b]
      if (seenIsle.has(slot.isleIndex)) continue
      seenIsle.add(slot.isleIndex)
      const stockList = R.b12Stock(slot.atSec, slot.prices)
      for (const item of stockList) {
        const left = slot.isleIndex === initIsleIdx ? R.b12StockLeft(w0.state, item, slot.atSec) : item.limit
        if (left <= 0 || !itemSet.has(item.id)) continue
        const terms = []
        for (let fs = b; fs < S; fs++) {
          terms.push([cPrefixItem.get(`${item.id}@${fs}`), -1])
        }
        vars.push({ ub: left, obj: -item.price * slot.disc, terms })
      }
    }
  }

  // 4) Coffee & crop-eating stamina variables
  if (allowed.has('coffee')) {
    const seenNd = new Set()
    for (let b = 0; b < B; b++) {
      const slot = allSlots[b]
      if (seenNd.has(slot.naturalDay)) continue
      seenNd.add(slot.naturalDay)
      const used = slot.naturalDay === initNatDay && w0?.state?.enDay === slot.naturalDay
        ? Number(w0?.state?.cnt?.coffee || 0)
        : 0
      const left = Math.max(0, (R.WORLD?.daily?.coffee || 3) - used)
      if (left <= 0) continue
      const terms = []
      for (let fb = b; fb < craftBoundSlots; fb++) {
        terms.push([cPrefixEn[fb], -(R.WORLD?.coffee?.energy || 60)])
      }
      vars.push({ ub: left, obj: -(R.WORLD?.coffee?.price || 15000) * slot.disc, terms })
    }
  }

  if (allowed.has('eat')) {
    // Add natural-day daily cap constraints for any capped edible (e.g. R.B12_SNACK)
    const cEdibleDaily = new Map()
    for (const spec of edibleSpecs) {
      if (spec.dailyCap != null) {
        for (const nd of naturalDays) {
          const key = `${spec.id}:${nd}`
          if (!cEdibleDaily.has(key)) {
            const used0 = nd === initNatDay && w0?.state?.enDay === nd
              ? Number(w0?.state?.cnt?.[spec.id] || 0)
              : 0
            cEdibleDaily.set(key, addConstraint(`eatCap:${key}`, Math.max(0, spec.dailyCap - used0)))
          }
        }
      }
    }

    const cargoExtraQ0 = allowed.has('stockBuy') ? 24 * Math.max(1, isleIndices.length) : 0
    for (let b = 0; b < B; b++) {
      const slot = allSlots[b]
      for (const spec of edibleSpecs) {
        const baseSup = prefixTotalSupply[spec.id]?.[b] || 0
        let ub = spec.q === 0 ? baseSup + cargoExtraQ0 : baseSup
        if (spec.q === 2) ub = Math.min(ub, q2Max[spec.id] || 0)
        else if (spec.q === 1) ub = Math.min(ub, q12Max[spec.id] || 0)
        if (spec.dailyCap != null) {
          const capIdx = cEdibleDaily.get(`${spec.id}:${slot.naturalDay}`)
          ub = Math.min(ub, constraints[capIdx].rhs)
        }
        if (ub <= 0) continue
        const terms = []
        if (spec.q === 2) terms.push([cQ2.get(spec.id), 1])
        if (spec.q >= 1) terms.push([cQ12.get(spec.id), 1])
        if (spec.dailyCap != null) {
          terms.push([cEdibleDaily.get(`${spec.id}:${slot.naturalDay}`), 1])
        }
        for (let fs = b; fs < S; fs++) {
          terms.push([cPrefixItem.get(`${spec.id}@${fs}`), 1])
        }
        for (let fb = b; fb < craftBoundSlots; fb++) {
          terms.push([cPrefixEn[fb], -spec.energyGain])
        }
        vars.push({ ub, obj: 0, terms })
      }
    }
  }

  const M = constraints.length
  const lambda = new Float64Array(M)
  // Warm-start item balance duals at max unit quote so step 0 is immediately reasonable
  for (const id of items) {
    let maxP = Number(R.BASE_PRICE?.[id] || 0) * 1.5
    for (const sl of allSlots) maxP = Math.max(maxP, Number(sl.prices?.[id] || 0) * 1.5)
    const lastKey = cPrefixItem.get(`${id}@${S - 1}`)
    if (lastKey != null) lambda[lastKey] = maxP
  }

  let bestUpper = Infinity
  let bestLambda = null
  const subgrad = new Float64Array(M)

  // Exact closed-form evaluation of U(λ) = initCoins + λ^T rhs + sum_j ub_j * max(0, obj_j - sum_c a_{c,j} λ_c)
  for (let iter = 0; iter < subgradientIterations; iter++) {
    for (let c = 0; c < M; c++) subgrad[c] = constraints[c].rhs
    let dualVal = initCoins
    for (let c = 0; c < M; c++) dualVal += lambda[c] * constraints[c].rhs

    for (let j = 0; j < vars.length; j++) {
      const v = vars[j]
      let rc = v.obj
      const terms = v.terms
      for (let k = 0; k < terms.length; k++) {
        rc -= lambda[terms[k][0]] * terms[k][1]
      }
      if (rc > 0) {
        const xVal = v.ub
        dualVal += xVal * rc
        for (let k = 0; k < terms.length; k++) {
          subgrad[terms[k][0]] -= terms[k][1] * xVal
        }
      }
    }

    if (dualVal < bestUpper) {
      bestUpper = dualVal
      bestLambda = Float64Array.from(lambda)
    }

    let normSq = 0
    for (let c = 0; c < M; c++) {
      // On active λ_c == 0 with positive slack (subgrad[c] > 0), projected subgradient is 0
      const g = (lambda[c] === 0 && subgrad[c] > 0) ? 0 : subgrad[c]
      normSq += g * g
    }
    if (normSq < 1e-6) break
    const stepSize = (0.85 / (1 + 0.12 * iter)) * (Math.max(100, bestUpper * 0.05) / Math.sqrt(normSq))
    for (let c = 0; c < M; c++) {
      // Inequality dual multiplier sign invariant: λ_c >= 0 strictly!
      lambda[c] = Math.max(0, lambda[c] - stepSize * subgrad[c])
    }
  }

  const validUpperBound = objectiveCfg.discountRatePerHour > 0
    ? Math.ceil(bestUpper * 1e6 - 1e-6) / 1e6
    : Math.floor(bestUpper + 1e-6)
  const craftShadowByIsle = {}
  if (bestLambda) {
    for (const [idx, cIdx] of cCraftIsle.entries()) {
      craftShadowByIsle[idx] = bestLambda[cIdx]
    }
  }

  return {
    validUpperBound,
    status: 'valid-weak-duality-bound',
    dualConstraintCount: M,
    variableCount: vars.length,
    craftShadowByIsle,
  }
}
