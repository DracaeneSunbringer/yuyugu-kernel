import {
  buildContinuationTimeline,
  buildObjectiveConfig,
  buildTerminalPrices,
  discountFactor,
  evaluateTrajectoryObjective,
} from '../model/objective.mjs'
import {
  quoteFutureItemUnderScenario,
  recomputeVisitBeliefForVisitor,
  resolveRaidOutcomeDistribution,
} from '../model/observations.mjs'

/**
 * Layer 2 Independent Reference & Counterfactual Solver (`audit/reference-solver.mjs`)
 *
 * ARCHITECTURAL FIREWALL:
 * - ZERO imports from `planner/*`!
 * - ZERO hardcoded item names!
 * - Independently builds event points, enumerates legal batches from `adapter.R` + `constraints`,
 *   evaluates scenario trees under full non-anticipativity, and computes:
 *     1) Exact `[L(a), U(a)]` and `R_lower = max(0, max_a L(a) - U(a_actual))` on compact finite trees.
 *     2) Constructive superior-trajectory witness `Π_alt` on full-scale states (`J(Π_alt) > J(Π_actual)`).
 */

function buildIndependentDecisionTimes(adapter, world, {
  horizonSec,
  deterministicArrivals = [],
  upcomingRaidSecs = [],
  maxSteps = 8,
} = {}) {
  adapter.syncClock(world?.clockStart)
  const t0 = Math.floor(Number(world?.now || 0))
  const tEnd = t0 + Math.max(0, Math.floor(horizonSec))
  const pts = new Set([t0])

  for (const arr of deterministicArrivals || []) {
    if (Number.isFinite(arr?.atSec) && arr.atSec >= t0 && arr.atSec <= tEnd) {
      pts.add(Math.floor(arr.atSec))
    }
  }
  for (const rSec of upcomingRaidSecs || []) {
    if (Number.isFinite(rSec) && rSec > t0 && rSec <= tEnd) {
      pts.add(Math.floor(rSec))
    }
  }

  let nd = t0
  for (let i = 0; i < 8; i++) {
    const nxt = adapter.nextNaturalDayBoundary(nd)
    if (nxt > tEnd || nxt <= nd) break
    pts.add(nxt)
    nd = nxt
  }

  let id = t0
  for (let i = 0; i < 16; i++) {
    const nxt = adapter.nextIsleBoundary(id, world?.clockStart)
    if (nxt > tEnd || nxt <= id) break
    pts.add(nxt)
    id = nxt
  }

  const state = world?.state || {}
  for (let i = 0; i < (state.plots?.length || 0); i++) {
    const p = state.plots[i]
    if (!p?.c) continue
    const tm = adapter.exactPlotTimings(p, adapter.R.sprinkled(state, i), t0, world?.clockStart)
    if (tm && tm.matureAt > t0 && tm.matureAt <= tEnd) pts.add(tm.matureAt)
  }

  const sorted = [...pts].filter((t) => t >= t0 && t < tEnd || (t === t0 && tEnd === t0)).sort((a, b) => a - b)
  const bounded = sorted.slice(0, maxSteps)
  const arrMap = new Map()
  for (const arr of deterministicArrivals || []) {
    const s = Math.floor(Number(arr.atSec))
    if (!arrMap.has(s)) arrMap.set(s, [])
    for (const it of arr.items || []) {
      arrMap.get(s).push({ id: it.id, q: Number(it.q || 0), n: Number(it.n || 0) })
    }
  }

  const baseIsle = adapter.R.isleIndex(t0)
  return {
    t0,
    tEnd,
    allSortedSecs: sorted,
    truncatedByMaxSteps: sorted.length > bounded.length,
    firstPostT0EventSec: sorted.length > 1 ? sorted[1] : tEnd,
    arrMap,
    steps: bounded.map((sec, idx) => ({
      index: idx,
      atSec: sec,
      nextAtSec: idx + 1 < bounded.length ? bounded[idx + 1] : tEnd,
      isleIndex: adapter.R.isleIndex(sec),
      isleDay: adapter.R.isleDay(sec),
      isleDayOffset: Math.max(0, adapter.R.isleIndex(sec) - baseIsle),
      naturalDay: adapter.R.worldDay(sec),
      arrivals: arrMap.get(sec) || [],
    })),
  }
}

function addArrivalsToWorld(world, arrivals) {
  if (!arrivals || arrivals.length === 0) return world
  const next = structuredClone(world)
  next.state.inv ||= {}
  for (const g of arrivals) {
    if (!g?.id || !(g.n > 0)) continue
    const q = Math.max(0, Math.min(2, Math.floor(Number(g.q || 0))))
    next.state.inv[g.id] ||= [0, 0, 0]
    next.state.inv[g.id][q] += Math.floor(g.n)
  }
  return next
}

export function applyIndependentRaidAtStep(adapter, worldAtStep, raidBelief, {
  atSec,
  prices = {},
  allowedSet = new Set(['eat', 'coffee', 'buy']),
  constraints = {},
  mode = 'auto',
} = {}) {
  const { R } = adapter
  if (!raidBelief || !(Number(raidBelief.totalSpots || 0) > 0)) {
    return { feasible: false }
  }

  const baseStepWorld = adapter.advanceTimeOnly(worldAtStep, atSec, { futurePrices: prices })
  const buffCombos = [[]]
  if (allowedSet.has('buy') && constraints.allowThiefBuffPurchase !== false && R.THIEF_ITEMS) {
    const bySlot = new Map()
    for (const [id, def] of Object.entries(R.THIEF_ITEMS)) {
      if (!def?.slot) continue
      const curEff = R.b12Effect?.(baseStepWorld.state, def.slot, atSec)
      if (curEff?.legacy || (curEff && curEff.until > atSec + 60)) continue
      if (!bySlot.has(def.slot)) bySlot.set(def.slot, [])
      bySlot.get(def.slot).push({ a: 'buy', id })
    }
    const slots = [...bySlot.values()]
    const walkSlots = (idx, acc) => {
      if (idx >= slots.length) {
        if (acc.length > 0) buffCombos.push(acc)
        return
      }
      walkSlots(idx + 1, acc)
      for (const act of slots[idx]) {
        walkSlots(idx + 1, [...acc, act])
      }
    }
    walkSlots(0, [])
  }

  let bestChoice = null
  for (const buffActs of buffCombos) {
    let prepWorld = baseStepWorld
    if (buffActs.length > 0) {
      const freeCash0 = Math.max(0, Number(prepWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
      const buffPrice = buffActs.reduce((s, a) => s + Number(R.THIEF_ITEMS?.[a.id]?.price || 0), 0)
      if (buffPrice > freeCash0) continue
      const simB = adapter.simulateBatch(prepWorld, buffActs, { t: atSec, prices })
      if (!simB.allOk) continue
      prepWorld = simB.afterWorld
    }

    const distPreview = resolveRaidOutcomeDistribution(adapter, raidBelief, prepWorld, atSec, { mode })
    const neededEn = distPreview.energyCost
    if (!(neededEn > 0) || !(Number(distPreview.belief?.totalSpots || 0) > 0)) continue

    const staminaPrepActs = []
    let curEn = Math.max(0, Math.floor(Number(prepWorld.state?.en || 0)))
    const rawMax = Number(R.energyMax(prepWorld.state))
    const enMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 100
    let prepFoodOppCost = 0

    if (curEn < neededEn) {
      const unitPool = []
      if (allowedSet.has('eat')) {
        const specs = typeof adapter.listDeterministicEdibleSpecs === 'function'
          ? adapter.listDeterministicEdibleSpecs()
          : []
        for (const sp of specs) {
          const have = sp.kind === 'snack'
            ? Math.min(
                adapter.availableInv(prepWorld.state, sp.id, 0),
                sp.dailyCap != null ? Math.max(0, sp.dailyCap - Number(prepWorld.state.cnt?.[sp.id] || 0)) : 999
              )
            : adapter.availableInv(prepWorld.state, sp.id, sp.q)
          if (!(have > 0) || !(sp.energyGain > 0)) continue
          const pUnit = sp.kind === 'snack'
            ? 0
            : Math.round(Number(prices?.[sp.id] || R.BASE_PRICE?.[sp.id] || 0) * (R.QUALITY?.[sp.q] ?? 1))
          unitPool.push({
            kind: 'eat',
            act: sp.kind === 'snack' ? { a: 'eat', id: sp.id } : { a: 'eat', id: sp.id, q: sp.q },
            rem: have,
            gain: sp.energyGain,
            unitCost: pUnit,
            cpe: pUnit / sp.energyGain,
          })
        }
      }
      if (allowedSet.has('coffee')) {
        const cPrice = R.WORLD?.coffee?.price || 15000
        const cGain = R.WORLD?.coffee?.energy || 60
        const cLeft = Math.max(0, (R.WORLD?.daily?.coffee || 3) - Number(prepWorld.state.cnt?.coffee || 0))
        const freeCash = Math.max(0, Number(prepWorld.coins || 0) - Number(constraints.cashReserveFloor || 0))
        const canC = Math.min(cLeft, Math.floor(freeCash / cPrice))
        if (canC > 0 && cGain > 0) {
          unitPool.push({
            kind: 'coffee',
            act: { a: 'coffee' },
            rem: canC,
            gain: cGain,
            unitCost: cPrice,
            cpe: cPrice / cGain,
          })
        }
      }
      unitPool.sort((a, b) => a.cpe - b.cpe)

      while (curEn < neededEn) {
        let picked = null
        for (const u of unitPool) {
          if (u.rem <= 0) continue
          if (u.kind === 'eat' && curEn >= enMax) continue
          picked = u
          break
        }
        if (!picked) break
        const step = adapter.simulateBatch(prepWorld, [picked.act], { t: atSec, prices })
        if (!step.allOk) {
          picked.rem = 0
          continue
        }
        picked.rem -= 1
        staminaPrepActs.push(picked.act)
        if (picked.kind === 'eat') prepFoodOppCost += picked.unitCost
        prepWorld = step.afterWorld
        curEn = Math.max(0, Math.floor(Number(prepWorld.state?.en || 0)))
      }
    }

    if (curEn < neededEn) continue

    const dist = resolveRaidOutcomeDistribution(adapter, raidBelief, prepWorld, atSec, { mode })
    const prepCoinDelta = Number(prepWorld.coins || 0) - Number(worldAtStep.coins || 0)
    const outcomes = []
    let expectedFinePaid = 0
    for (const out of dist.outcomes) {
      const branchWorld = structuredClone(prepWorld)
      branchWorld.state.en = Math.max(0, curEn - dist.energyCost)
      branchWorld.state.inv ||= {}
      for (const [id, intN] of Object.entries(out.lootBag)) {
        if (intN > 0) {
          branchWorld.state.inv[id] ||= [0, 0, 0]
          branchWorld.state.inv[id][0] += intN
        }
      }
      const actualFine = Math.min(Math.max(0, Number(branchWorld.coins || 0)), out.fineCoins)
      if (actualFine > 0) {
        branchWorld.coins = Math.max(0, Number(branchWorld.coins || 0) - actualFine)
      }
      expectedFinePaid += out.prob * actualFine
      const extraCashEvents = []
      if (prepCoinDelta !== 0) extraCashEvents.push({ atSec, netCashDelta: prepCoinDelta })
      if (actualFine > 0) extraCashEvents.push({ atSec, netCashDelta: -actualFine })
      outcomes.push({
        kind: out.kind,
        prob: out.prob,
        lootBag: out.lootBag,
        fineCoins: actualFine,
        afterRaidWorld: branchWorld,
        extraCashEvents,
      })
    }

    let approxLootVal = 0
    for (const [id, expQty] of Object.entries(dist.expectedLootBag)) {
      approxLootVal += expQty * Math.max(Number(prices?.[id] || 0), Number(R.BASE_PRICE?.[id] || 0))
    }
    const proxyNet = approxLootVal + prepCoinDelta - prepFoodOppCost - expectedFinePaid
    if (!bestChoice || proxyNet > bestChoice.proxyNet + 1e-6) {
      bestChoice = {
        proxyNet,
        prepActs: [...buffActs, ...staminaPrepActs],
        buffActs,
        staminaPrepActs,
        distribution: dist,
        outcomes,
      }
    }
  }

  if (!bestChoice) {
    return { feasible: false }
  }

  return {
    feasible: true,
    prepActs: bestChoice.prepActs,
    buffActs: bestChoice.buffActs,
    staminaPrepActs: bestChoice.staminaPrepActs,
    distribution: bestChoice.distribution,
    outcomes: bestChoice.outcomes,
    afterRaidWorld: bestChoice.outcomes[0]?.afterRaidWorld || null,
    extraCashEvents: bestChoice.outcomes[0]?.extraCashEvents || [],
  }
}

/**
 * Independently enumerates distinct, mechanically valid candidate batches at `world` (`atSec`, `prices`).
 * Covers:
 * - `[]` (wait / hold)
 * - Full liquidation `sell` (`q2 -> q1 -> q0`)
 * - Tier-threshold `sell` (selling only up to `150 - sc_<id>` or `400 - sc_<id>`, holding excess)
 * - Every feasible single recipe in `R.RECIPES` (both `n=1` and `n=maxFeasible`, with & without immediate sell)
 * - Every feasible 2-step recipe chain `[craft up, craft down]` (with & without immediate sell)
 * - Combined multi-recipe greedy/all-feasible craft packs
 * - Stamina top-up (`eat` crop / `coffee`) + `craft`
 * - Cargo `stockBuy` + `craft` / `sell`
 * - Ready farm/barn maintenance (`collect`, `pet`, `harvest`, `clear`, `water`, `plant`)
 */
export function enumerateIndependentCandidateBatches(adapter, world, {
  atSec = world.now,
  prices = world.prices || {},
  allowedActionTypes = null,
  constraints = {},
} = {}) {
  const { R, graph } = adapter
  const allow = allowedActionTypes ? new Set(allowedActionTypes) : null
  const can = (a) => !allow || allow.has(a)

  const refreshed = adapter.advanceTimeOnly(world, atSec, { futurePrices: prices })
  const bucketEnFloor = Number(constraints?.staminaReserveFloor || 0) > 0 && atSec < Number(constraints?.staminaReserveUntilSec || 0)
    ? Math.min(Number(refreshed.state?.en || 0), Math.max(0, Math.floor(Number(constraints.staminaReserveFloor || 0))))
    : 0
  const candidates = []
  const seenBatchKeys = new Set()

  const addCandidate = (label, rawActions) => {
    const trimmed = rawActions.slice(0, R.WORLD?.maxActions || 40)
    const key = JSON.stringify(trimmed)
    if (seenBatchKeys.has(key)) return
    if (trimmed.length === 0) {
      seenBatchKeys.add(key)
      candidates.push({ label, actions: [], simAfterWorld: refreshed, allOk: true })
      return
    }
    const sim = adapter.simulateBatch(refreshed, trimmed, { t: atSec, prices })
    if (sim.allOk) {
      if (bucketEnFloor > 0 && Number(sim.afterWorld.state?.en || 0) < bucketEnFloor) return
      seenBatchKeys.add(key)
      candidates.push({ label, actions: trimmed, simAfterWorld: sim.afterWorld, allOk: true })
    }
  }

  const makeSellAllActions = (wState, { onlyTier0 = false, onlyUpToTier1 = false } = {}) => {
    const avail = adapter.availableInvSnapshot(wState)
    const acts = []
    for (const id of Object.keys(avail).sort()) {
      if (!(Number(R.BASE_PRICE?.[id] || 0) > 0) || !(Number(prices?.[id] || 0) > 0)) continue
      const isCrop = graph.cropsById.has(id)
      let cap = Infinity
      if (isCrop && onlyTier0) {
        cap = Math.max(0, 150 - Number(wState.cnt?.['sc_' + id] || 0))
      } else if (isCrop && onlyUpToTier1) {
        cap = Math.max(0, 400 - Number(wState.cnt?.['sc_' + id] || 0))
      }
      for (const q of [2, 1, 0]) {
        let rem = Math.min(cap, Number(avail[id][q] || 0))
        cap -= rem
        while (rem > 0) {
          const n = Math.min(999, rem)
          acts.push({ a: 'sell', id, q, n })
          rem -= n
        }
      }
    }
    return acts
  }

  // 1. Wait (`[]`)
  if (can('wait') || !allow) {
    addCandidate('wait', [])
  }

  // 2. Pure sell variants (all, tier-0 cap 150, tier-1 cap 400, and single-item sells)
  if (can('sell')) {
    const sellAll = makeSellAllActions(refreshed.state)
    if (sellAll.length > 0) addCandidate('sell-all', sellAll)
    const sellT0 = makeSellAllActions(refreshed.state, { onlyTier0: true })
    if (sellT0.length > 0) addCandidate('sell-tier0-only', sellT0)
    const sellT1 = makeSellAllActions(refreshed.state, { onlyUpToTier1: true })
    if (sellT1.length > 0) addCandidate('sell-up-to-tier1', sellT1)

    const avail0 = adapter.availableInvSnapshot(refreshed.state)
    for (const id of Object.keys(avail0).sort()) {
      if (!(Number(R.BASE_PRICE?.[id] || 0) > 0) || !(Number(prices?.[id] || 0) > 0)) continue
      const itemSells = []
      for (const q of [2, 1, 0]) {
        const c = avail0[id][q] || 0
        if (c > 0) itemSells.push({ a: 'sell', id, q, n: Math.min(999, c) })
      }
      if (itemSells.length > 0) addCandidate(`sell-only:${id}`, itemSells)
    }
  }

  // 3. Craft enumeration: every recipe in R.RECIPES (sorted canonically by id, zero R.RECIPES order bias!),
  //    every 2-step chain, and multi-recipe combinations!
  if (can('craft')) {
    const isleIdx = R.isleIndex(atSec)
    const usedCraft = refreshed.state?.iq?.d === isleIdx ? Number(refreshed.state.iq.craft || 0) : 0
    const craftLeft = Math.max(0, (R.WORLD?.daily?.craft || 80) - usedCraft)
    const craftEn = R.WORLD?.cost?.craft ?? 1

    if (craftLeft > 0) {
      const avail = adapter.availableInvSnapshot(refreshed.state)
      const totalOf = (id) => (avail[id]?.[0] || 0) + (avail[id]?.[1] || 0) + (avail[id]?.[2] || 0)
      const sortedRecipes = [...(R.RECIPES || [])].sort((a, b) => a.id.localeCompare(b.id))

      // 3a. Single recipes (1 unit and max units, both hold & sell-after)
      const singleFeasible = []
      for (const r of sortedRecipes) {
        const maxMat = Math.min(...Object.entries(r.in || {}).map(([inId, k]) => Math.floor(totalOf(inId) / k)))
        const maxEn = Math.floor(Number(refreshed.state.en || 0) / craftEn)
        const maxN = Math.min(20, craftLeft, maxMat, maxEn)
        if (maxN >= 1) {
          singleFeasible.push({ r, maxN })
        const qtyChoices = maxN <= 8
          ? Array.from({ length: maxN }, (_, idx) => idx + 1)
          : [1, Math.floor(maxN / 2), maxN]
        for (const qty of new Set(qtyChoices)) {
            const cAct = [{ a: 'craft', id: r.id, n: qty }]
            addCandidate(`craft:${r.id}x${qty}`, cAct)
            if (can('sell')) {
              const simC = adapter.simulateBatch(refreshed, cAct, { t: atSec, prices })
              if (simC.allOk) {
                addCandidate(`craft+sell:${r.id}x${qty}`, [...cAct, ...makeSellAllActions(simC.afterWorld.state)])
              }
            }
          }
        }
      }

      // 3b. Two-recipe pairs (covers splitting quota or independent recipes in same bucket)
      if (singleFeasible.length >= 2 && singleFeasible.length <= 12) {
        for (let i = 0; i < singleFeasible.length; i++) {
          for (let j = i + 1; j < singleFeasible.length; j++) {
            const r1 = singleFeasible[i]
            const r2 = singleFeasible[j]
            const seq = [{ a: 'craft', id: r1.r.id, n: r1.maxN }]
            const sim1 = adapter.simulateBatch(refreshed, seq, { t: atSec, prices })
            if (sim1.allOk) {
              const av2 = adapter.availableInvSnapshot(sim1.afterWorld.state)
              const tot2 = (id) => (av2[id]?.[0] || 0) + (av2[id]?.[1] || 0) + (av2[id]?.[2] || 0)
              const remC = Math.max(0, craftLeft - r1.maxN)
              const max2 = Math.min(
                20,
                remC,
                Math.floor(Number(sim1.afterWorld.state.en || 0) / craftEn),
                ...Object.entries(r2.r.in || {}).map(([inId, k]) => Math.floor(tot2(inId) / k))
              )
              if (max2 >= 1) {
                const pairActs = [...seq, { a: 'craft', id: r2.r.id, n: max2 }]
                addCandidate(`craft-pair:${r1.r.id}+${r2.r.id}`, pairActs)
                if (can('sell')) {
                  const simP = adapter.simulateBatch(refreshed, pairActs, { t: atSec, prices })
                  if (simP.allOk) {
                    addCandidate(`craft-pair+sell:${r1.r.id}+${r2.r.id}`, [...pairActs, ...makeSellAllActions(simP.afterWorld.state)])
                  }
                }
              }
            }
          }
        }
      }

      // 3c. Multi-step recipe chains (`upstream -> downstream`, e.g. `ingot -> crown`)
      for (const r of sortedRecipes) {
        const upSteps = []
        let hasUp = false
        let slotsPerChain = 1
        const rawNeeded = {}
        for (const [inId, qty] of Object.entries(r.in || {})) {
          const up = graph.recipesById.get(inId)
          if (up) {
            hasUp = true
            upSteps.push({ id: up.id, perDown: qty })
            slotsPerChain += qty
            for (const [rawId, rq] of Object.entries(up.in || {})) {
              rawNeeded[rawId] = (rawNeeded[rawId] || 0) + rq * qty
            }
          } else {
            rawNeeded[inId] = (rawNeeded[inId] || 0) + qty
          }
        }
        if (!hasUp) continue
        const maxChains = Math.min(
          10,
          Math.floor(craftLeft / slotsPerChain),
          Math.floor(Number(refreshed.state.en || 0) / (slotsPerChain * craftEn)),
          ...Object.entries(rawNeeded).map(([id, need]) => Math.floor(totalOf(id) / need))
        )
        if (maxChains >= 1) {
          for (const cnt of new Set([1, maxChains])) {
            const chainActs = [
              ...upSteps.map((u) => ({ a: 'craft', id: u.id, n: u.perDown * cnt })),
              { a: 'craft', id: r.id, n: cnt },
            ]
            addCandidate(`craft-chain:${r.id}x${cnt}`, chainActs)
            if (can('sell')) {
              const simCh = adapter.simulateBatch(refreshed, chainActs, { t: atSec, prices })
              if (simCh.allOk) {
                addCandidate(`craft-chain+sell:${r.id}x${cnt}`, [...chainActs, ...makeSellAllActions(simCh.afterWorld.state)])
              }
            }
          }
        }
      }
    }
  }

  // 4. Stamina conversion (`eat` / `coffee`) + `craft` (+ `sell`) when stamina is limiting!
  if ((can('eat') || can('coffee')) && can('craft')) {
    const foodStarters = []
    if (can('eat') && refreshed.state.en < R.energyMax(refreshed.state)) {
      const edibleSpecs = typeof adapter.listDeterministicEdibleSpecs === 'function'
        ? adapter.listDeterministicEdibleSpecs()
        : []
      const seenEdibleIds = new Set()
      for (const spec of edibleSpecs) {
        if (seenEdibleIds.has(spec.id)) continue
        if (spec.dailyCap != null && Number(refreshed.state.cnt?.[spec.id] || 0) >= spec.dailyCap) continue
        if (adapter.availableInv(refreshed.state, spec.id, spec.q) > 0) {
          seenEdibleIds.add(spec.id)
          foodStarters.push([spec.kind === 'snack' ? { a: 'eat', id: spec.id } : { a: 'eat', id: spec.id, q: spec.q }])
        }
      }
    }
    if (
      can('coffee') &&
      Number(refreshed.state.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
      Number(refreshed.coins || 0) - Number(constraints.cashReserveFloor || 0) >= (R.WORLD?.coffee?.price || 15000)
    ) {
      foodStarters.push([{ a: 'coffee' }])
    }

    for (const fActs of foodStarters) {
      const simF = adapter.simulateBatch(refreshed, fActs, { t: atSec, prices })
      if (!simF.allOk) continue
      addCandidate(`stamina:${fActs[0].a}`, fActs)
      const av = adapter.availableInvSnapshot(simF.afterWorld.state)
      const tot = (id) => (av[id]?.[0] || 0) + (av[id]?.[1] || 0) + (av[id]?.[2] || 0)
      const isleIdx = R.isleIndex(atSec)
      const cLeft = Math.max(0, (R.WORLD?.daily?.craft || 80) - (simF.afterWorld.state?.iq?.d === isleIdx ? Number(simF.state?.iq?.craft ?? simF.afterWorld.state.iq.craft ?? 0) : 0))
      for (const r of R.RECIPES || []) {
        if (!(r.price > 0)) continue
        const maxN = Math.min(
          20,
          cLeft,
          Math.floor(Number(simF.afterWorld.state.en || 0) / (R.WORLD?.cost?.craft ?? 1)),
          ...Object.entries(r.in || {}).map(([inId, k]) => Math.floor(tot(inId) / k))
        )
        if (maxN >= 1) {
          const combo = [...fActs, { a: 'craft', id: r.id, n: maxN }]
          addCandidate(`stamina+craft:${r.id}x${maxN}`, combo)
          if (can('sell')) {
            const simFC = adapter.simulateBatch(refreshed, combo, { t: atSec, prices })
            if (simFC.allOk) {
              addCandidate(`stamina+craft+sell:${r.id}x${maxN}`, [...combo, ...makeSellAllActions(simFC.afterWorld.state)])
            }
          }
        }
      }
    }
  }

  // 5. Cargo `stockBuy` + optional `craft` + `sell`
  if (can('stockBuy') && typeof R.b12Stock === 'function') {
    const iDay = R.isleDay(atSec)
    for (const item of R.b12Stock(atSec, prices)) {
      const left = R.b12StockLeft(refreshed.state, item, atSec)
      const maxAfford = item.price > 0
        ? Math.floor(Math.max(0, Number(refreshed.coins || 0) - Number(constraints.cashReserveFloor || 0)) / item.price)
        : 0
      const qty = Math.min(left, maxAfford)
      if (qty >= 1) {
        const sbAct = [{ a: 'stockBuy', id: item.id, n: qty, day: iDay }]
        addCandidate(`stockBuy:${item.id}x${qty}`, sbAct)
        if (can('sell')) {
          const simS = adapter.simulateBatch(refreshed, sbAct, { t: atSec, prices })
          if (simS.allOk) {
            addCandidate(`stockBuy+sell:${item.id}x${qty}`, [...sbAct, ...makeSellAllActions(simS.afterWorld.state)])
          }
        }
      }
    }
  }

  // 6. Ready farm/barn collection & harvesting (`collect`, `pet`, `harvest`, `clear`, including immediate post-harvest cross-season wither)
  const farmActs = []
  const farmActsWithoutPostClear = []
  let hasPostHarvestWitherClear = false
  const weather = R.weatherOf(R.isleDay(atSec))
  for (let i = 0; i < (refreshed.state.barn?.length || 0); i++) {
    const pen = refreshed.state.barn[i]
    if (!pen) continue
    if (can('pet') && !R.b12AnimalStage(pen, atSec).retired && !refreshed.state.cnt?.['pet' + i] && (pen.m || 0) < 95) {
      farmActs.push({ a: 'pet', i })
      farmActsWithoutPostClear.push({ a: 'pet', i })
    }
    if (can('collect') && R.animalReady(pen, atSec).ready) {
      farmActs.push({ a: 'collect', i })
      farmActsWithoutPostClear.push({ a: 'collect', i })
    }
  }
  for (let i = 0; i < (refreshed.state.plots?.length || 0); i++) {
    const p = refreshed.state.plots[i]
    if (!p) continue
    const st = R.cropStage(p, atSec, R.sprinkled(refreshed.state, i) || weather === 1)
    if (st.stage === 3 && can('harvest')) {
      farmActs.push({ a: 'harvest', i })
      farmActsWithoutPostClear.push({ a: 'harvest', i })
      const post = adapter.predictPostHarvestPlot(p, atSec, refreshed.clockStart)
      if (post.kind === 'withered' && can('clear')) {
        farmActs.push({ a: 'clear', i })
        hasPostHarvestWitherClear = true
      }
    } else if (st.stage === -1 && can('clear')) {
      farmActs.push({ a: 'clear', i })
      farmActsWithoutPostClear.push({ a: 'clear', i })
    }
  }
  if (farmActs.length > 0) {
    addCandidate('farm-ready', farmActs)
    if (hasPostHarvestWitherClear) {
      addCandidate('farm-ready-no-post-clear', farmActsWithoutPostClear)
    }
    if (can('sell')) {
      const simFm = adapter.simulateBatch(refreshed, farmActs, { t: atSec, prices })
      if (simFm.allOk) {
        addCandidate('farm-ready+sell', [...farmActs, ...makeSellAllActions(simFm.afterWorld.state)])
      }
    }
    const farmNeedsStamina = farmActs.some((a) => a.a === 'harvest' || a.a === 'clear')
    if (farmNeedsStamina && (can('eat') || can('coffee'))) {
      const farmFoodStarters = []
      const rawCap = Number(R.energyMax(refreshed.state))
      const enMaxRef = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 100
      if (can('eat') && refreshed.state.en < enMaxRef) {
        const edibleSpecs = typeof adapter.listDeterministicEdibleSpecs === 'function'
          ? adapter.listDeterministicEdibleSpecs()
          : []
        const seenEdibleIds = new Set()
        for (const spec of edibleSpecs) {
          if (seenEdibleIds.has(spec.id)) continue
          const capLeft = spec.dailyCap != null
            ? Math.max(0, spec.dailyCap - Number(refreshed.state.cnt?.[spec.id] || 0))
            : 999
          const avail = Math.min(capLeft, adapter.availableInv(refreshed.state, spec.id, spec.q))
          if (avail > 0) {
            seenEdibleIds.add(spec.id)
            const singleAct = spec.kind === 'snack' ? { a: 'eat', id: spec.id } : { a: 'eat', id: spec.id, q: spec.q }
            farmFoodStarters.push([singleAct])
            if (avail >= 2 && Number(refreshed.state.en || 0) + Number(spec.energyGain || 0) < enMaxRef) {
              farmFoodStarters.push([singleAct, singleAct])
            }
          }
        }
      }
      if (
        can('coffee') &&
        Number(refreshed.state.cnt?.coffee || 0) < (R.WORLD?.daily?.coffee || 3) &&
        Number(refreshed.coins || 0) - Number(constraints.cashReserveFloor || 0) >= (R.WORLD?.coffee?.price || 15000)
      ) {
        farmFoodStarters.push([{ a: 'coffee' }])
      }
      for (const fActs of farmFoodStarters) {
        const combo = [...fActs, ...farmActs]
        addCandidate(`stamina+farm-ready:${fActs[0].id || fActs[0].a}x${fActs.length}`, combo)
        if (can('sell')) {
          const simSF = adapter.simulateBatch(refreshed, combo, { t: atSec, prices })
          if (simSF.allOk) {
            addCandidate(
              `stamina+farm-ready+sell:${fActs[0].id || fActs[0].a}x${fActs.length}`,
              [...combo, ...makeSellAllActions(simSF.afterWorld.state)]
            )
          }
        }
      }
    }
  }

  return candidates
}

/**
 * Evaluates a specific first-step batch `firstBatchActions` AND searches over all candidate first-step
 * batches + multi-step continuations under the ex-ante scenario tree!
 *
 * Returns:
 * - `actualFirstActionBounds: { L, U }` (when `exhaustive === true`, `U` is a true upper bound over the enumerated space!)
 * - `bestAlternative: { label, firstActions, L, U }`
 * - `identifiableDecisionRegretLowerBound`: `max(0, max_a L(a) - U(a_actual))` when `exhaustive` is certified,
 *   OR constructive policy regret `max(0, L(best) - exactActualTrajectoryValue)` when `exactActualTrajectoryValue` is given!
 */
export function auditDecisionAgainstReference(adapter, {
  worldBefore,
  envelope = null,
  actualFirstActions = [],
  actualFullPolicyObjectiveValue = null,
  scenarios = [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  explicitPricesByStep = null,
  deterministicArrivals = [],
  visitBeliefs = null,
  upcomingVisitBeliefs = null,
  reservedStealUsedThisIsleDay = null,
  objectiveCfg = buildObjectiveConfig(),
  allowedActionTypes = ['sell', 'craft', 'wait', 'stockBuy', 'eat', 'coffee'],
  constraints = null,
  raidOutcomeMode = 'auto',
  maxSteps = 4,
  maxSearchNodes = 2500,
} = {}) {
  const effVisitBeliefs = Array.isArray(visitBeliefs)
    ? visitBeliefs
    : (envelope?.beliefs?.visitBeliefs || [])
  const effUpcomingVisitBeliefs = Array.isArray(upcomingVisitBeliefs)
    ? upcomingVisitBeliefs
    : (envelope?.beliefs?.upcomingVisitBeliefs || [])
  const effConstraints = constraints || envelope?.constraints || {}
  const effReservedSteals = reservedStealUsedThisIsleDay != null
    ? reservedStealUsedThisIsleDay
    : Number(envelope?.reservedBudgets?.stealUsedOrReservedThisIsleDay || 0)
  visitBeliefs = effVisitBeliefs
  upcomingVisitBeliefs = effUpcomingVisitBeliefs
  constraints = effConstraints
  reservedStealUsedThisIsleDay = effReservedSteals
  objectiveCfg = objectiveCfg || buildObjectiveConfig()
  const t0Ref = Math.floor(Number(worldBefore?.now || 0))
  const tEndRef = t0Ref + Math.max(0, Math.floor(objectiveCfg.horizonSec || 0))
  const allowedRefSet = new Set(allowedActionTypes)
  const minStealSpotsRef = Number(constraints?.minStealSpots || 0)
  const readyRaidsById = new Map()
  if (
    allowedRefSet.has('visit') &&
    constraints?.maxStealsPerIsleDay !== 0 &&
    Array.isArray(visitBeliefs)
  ) {
    for (const rb of visitBeliefs) {
      if (!rb || rb.targetId == null || !(Number(rb.totalSpots || 0) > 0) || Number(rb.totalSpots || 0) < minStealSpotsRef) {
        continue
      }
      readyRaidsById.set(Number(rb.targetId), rb)
    }
  }

  const upcomingRaidsBySec = new Map()
  if (
    allowedRefSet.has('visit') &&
    constraints?.maxStealsPerIsleDay !== 0 &&
    Array.isArray(upcomingVisitBeliefs)
  ) {
    for (const ub of upcomingVisitBeliefs) {
      const uSec = Math.floor(Number(ub?.unlockAtSec))
      if (
        !ub ||
        ub.targetId == null ||
        !Number.isFinite(uSec) ||
        uSec <= t0Ref ||
        uSec > tEndRef ||
        !(Number(ub.totalSpots || 0) > 0) ||
        Number(ub.totalSpots || 0) < minStealSpotsRef
      ) {
        continue
      }
      if (!upcomingRaidsBySec.has(uSec)) upcomingRaidsBySec.set(uSec, [])
      upcomingRaidsBySec.get(uSec).push(ub)
    }
  }

  const timeline = buildIndependentDecisionTimes(adapter, worldBefore, {
    horizonSec: objectiveCfg.horizonSec,
    deterministicArrivals,
    upcomingRaidSecs: [...upcomingRaidsBySec.keys()],
    maxSteps: Math.max(maxSteps, maxSteps + Math.min(3, upcomingRaidsBySec.size)),
  })
  const steps = timeline.steps
  const tEnd = timeline.tEnd

  const normWeight = scenarios.reduce((s, x) => s + Number(x.weight || 0), 0) || 1
  const normScenarios = scenarios.map((s) => ({ ...s, weight: Number(s.weight || 0) / normWeight }))

  const hasBranch = normScenarios.length > 1
    && !explicitPricesByStep
    && steps.some((st) => st.isleDayOffset >= 1)

  const trunkSteps = hasBranch ? steps.filter((st) => st.isleDayOffset === 0) : steps
  const branchSteps = hasBranch ? steps.filter((st) => st.isleDayOffset >= 1) : []

  const getStepPrices = (step, sc, soldByIsle) => {
    if (explicitPricesByStep?.[step.index]) return explicitPricesByStep[step.index]
    if (sc.explicitPricesByStep?.[step.index]) return sc.explicitPricesByStep[step.index]
    if (step.isleDayOffset === 0) return worldBefore.prices || {}
    const prevSold = soldByIsle.get(step.isleIndex - 1) || {}
    const out = {}
    for (const id of adapter.graph.sellableIds) {
      out[id] = quoteFutureItemUnderScenario(adapter, {
        itemId: id,
        isleDayIndex: step.isleDayOffset,
        isleDayStr: step.isleDay,
        currentPrices: worldBefore.prices || {},
        externalSupplyFactor: sc.externalSupplyFactor,
        selfSoldPrevIsleDay: Number(prevSold[id] || 0),
      })
    }
    return out
  }

  let nodesVisited = 0
  let hitNodeCap = false
  const maxPerIsleStealRef = constraints?.maxStealsPerIsleDay == null
    ? Infinity
    : Math.max(0, Number(constraints.maxStealsPerIsleDay))

  const buildStepRaidOptions = (baseW, st, prices, baseCash, baseStealsByIsle, baseSeenOwners = new Set()) => {
    const options = [{
      raidTag: null,
      branches: [{ kind: 'no-raid', prob: 1, world: baseW, cash: baseCash }],
      stealsByIsle: baseStealsByIsle,
      seenOwners: baseSeenOwners,
    }]
    const raidsAtSt = upcomingRaidsBySec.get(st.atSec)
    if (!raidsAtSt || raidsAtSt.length === 0 || !allowedRefSet.has('visit')) return options

    const curUsed = baseStealsByIsle.get(st.isleIndex) || 0
    if (curUsed >= maxPerIsleStealRef) return options

    for (const rb of raidsAtSt) {
      const ownerDayKey = `${rb.targetId}:${st.naturalDay}`
      if (baseSeenOwners.has(ownerDayKey)) continue
      const rRes = applyIndependentRaidAtStep(adapter, baseW, rb, {
        atSec: st.atSec,
        prices,
        allowedSet: allowedRefSet,
        constraints,
        mode: raidOutcomeMode,
      })
      if (!rRes.feasible || !Array.isArray(rRes.outcomes) || rRes.outcomes.length === 0) continue
      const nextSteals = new Map(baseStealsByIsle)
      nextSteals.set(st.isleIndex, curUsed + 1)
      const nextSeenOwners = new Set(baseSeenOwners)
      nextSeenOwners.add(ownerDayKey)
      options.push({
        raidTag: { a: 'visit', targetId: rb.targetId, prepActs: rRes.prepActs },
        branches: rRes.outcomes.map((o) => ({
          kind: o.kind,
          prob: o.prob,
          world: o.afterRaidWorld,
          cash: [...baseCash, ...o.extraCashEvents],
        })),
        stealsByIsle: nextSteals,
        seenOwners: nextSeenOwners,
      })
    }
    return options
  }

  // Recursive best-continuation evaluator for a single scenario from `stepIdx` onwards
  const evalBestContinuationSingleScenario = (curWorld, subSteps, idx, sc, cashEvents, soldByIsle, stealsByIsle, seenOwners = new Set()) => {
    if (idx >= subSteps.length) {
      const prevSoldAtEnd = soldByIsle.get(adapter.R.isleIndex(tEnd) - 1) || null
      const termPrices = sc.explicitTerminalPrices
        || (objectiveCfg.terminalSupplyMode === 'zero'
            ? {}
            : buildTerminalPrices(adapter, { ...curWorld, now: tEnd }, worldBefore, objectiveCfg, sc.externalSupplyFactor, prevSoldAtEnd))
      const finalW = adapter.advanceTimeOnly(curWorld, tEnd, { futurePrices: termPrices })
      const ev = evaluateTrajectoryObjective(adapter, {
        initialWorld: worldBefore,
        finalWorld: finalW,
        cashEvents,
        objectiveCfg,
        scenarioSupplyFactor: sc.externalSupplyFactor,
        explicitTerminalPrices: sc.explicitTerminalPrices || (objectiveCfg.terminalSupplyMode === 'zero' ? {} : null),
        prevIsleSoldMap: prevSoldAtEnd,
        allowTerminalCraft: allowedRefSet.has('craft'),
        allowTerminalHarvest: allowedRefSet.has('harvest'),
        allowTerminalPlant: allowedRefSet.has('plant'),
      })
      return { bestVal: ev.totalObjectiveValue, bestTrace: [] }
    }

    if (++nodesVisited > maxSearchNodes) {
      hitNodeCap = true
      const finalW = adapter.advanceTimeOnly(curWorld, tEnd)
      const ev = evaluateTrajectoryObjective(adapter, {
        initialWorld: worldBefore,
        finalWorld: finalW,
        cashEvents,
        objectiveCfg,
        scenarioSupplyFactor: sc.externalSupplyFactor,
        allowTerminalCraft: allowedRefSet.has('craft'),
        allowTerminalHarvest: allowedRefSet.has('harvest'),
        allowTerminalPlant: allowedRefSet.has('plant'),
      })
      return { bestVal: ev.totalObjectiveValue, bestTrace: [] }
    }

    const st = subSteps[idx]
    const prices = getStepPrices(st, sc, soldByIsle)
    let wAtStep = adapter.advanceTimeOnly(curWorld, st.atSec, { futurePrices: prices })
    wAtStep = addArrivalsToWorld(wAtStep, st.arrivals)

    const raidOptions = buildStepRaidOptions(wAtStep, st, prices, cashEvents, stealsByIsle, seenOwners)
    let bestVal = -Infinity
    let bestTrace = []

    for (const opt of raidOptions) {
      if (hitNodeCap && bestVal > -Infinity) break
      let expOptVal = 0
      let optFeasible = true
      let primaryTrace = []

      for (let bIdx = 0; bIdx < opt.branches.length; bIdx++) {
        const br = opt.branches[bIdx]
        const cands = enumerateIndependentCandidateBatches(adapter, br.world, {
          atSec: st.atSec,
          prices,
          allowedActionTypes,
          constraints,
        })
        let bestBrVal = -Infinity
        let bestBrTrace = []
        for (const c of cands) {
          if (hitNodeCap && bestBrVal > -Infinity) break
          const nextCash = [...br.cash]
          const deltaC = Number(c.simAfterWorld.coins || 0) - Number(br.world.coins || 0)
          if (deltaC !== 0) nextCash.push({ atSec: st.atSec, netCashDelta: deltaC })

          const nextSold = new Map(soldByIsle)
          for (const a of c.actions) {
            if (a.a === 'sell') {
              const m = { ...(nextSold.get(st.isleIndex) || {}) }
              m[a.id] = (m[a.id] || 0) + Number(a.n || 0)
              nextSold.set(st.isleIndex, m)
            }
          }

          const sub = evalBestContinuationSingleScenario(
            c.simAfterWorld,
            subSteps,
            idx + 1,
            sc,
            nextCash,
            nextSold,
            opt.stealsByIsle,
            opt.seenOwners
          )
          if (sub.bestVal > bestBrVal) {
            bestBrVal = sub.bestVal
            const recActs = opt.raidTag ? [opt.raidTag, ...c.actions] : c.actions
            bestBrTrace = [{ atSec: st.atSec, actions: recActs, raidOutcome: br.kind }, ...sub.bestTrace]
          }
        }
        if (!(bestBrVal > -Infinity)) {
          optFeasible = false
          break
        }
        expOptVal += br.prob * bestBrVal
        if (bIdx === 0) primaryTrace = bestBrTrace
      }

      if (optFeasible && expOptVal > bestVal) {
        bestVal = expOptVal
        bestTrace = primaryTrace
      }
    }

    return { bestVal, bestTrace }
  }

  // Recursive evaluator over shared non-anticipative trunk steps `trunkList[tIdx..]`, then branching across scenarios!
  const evalSharedTrunkList = (curWorld, trunkList, tIdx, cashEvents, soldByIsle, stealsByIsle, seenOwners = new Set()) => {
    if (tIdx >= trunkList.length) {
      let expVal = 0
      const byScenario = {}
      for (const sc of normScenarios) {
        const res = evalBestContinuationSingleScenario(curWorld, branchSteps, 0, sc, cashEvents, soldByIsle, stealsByIsle, seenOwners)
        expVal += sc.weight * res.bestVal
        byScenario[sc.id] = res
      }
      return { bestVal: expVal, bestTrunkTrace: [], byScenario }
    }

    if (++nodesVisited > maxSearchNodes) {
      hitNodeCap = true
      let expVal = 0
      for (const sc of normScenarios) {
        const res = evalBestContinuationSingleScenario(curWorld, branchSteps, 0, sc, cashEvents, soldByIsle, stealsByIsle, seenOwners)
        expVal += sc.weight * res.bestVal
      }
      return { bestVal: expVal, bestTrunkTrace: [], byScenario: {} }
    }

    const st = trunkList[tIdx]
    const prices = getStepPrices(st, normScenarios[0], soldByIsle)
    let wAtStep = adapter.advanceTimeOnly(curWorld, st.atSec, { futurePrices: prices })
    wAtStep = addArrivalsToWorld(wAtStep, st.arrivals)

    const raidOptions = buildStepRaidOptions(wAtStep, st, prices, cashEvents, stealsByIsle, seenOwners)
    let bestVal = -Infinity
    let bestTrunkTrace = []
    let bestScen = {}

    for (const opt of raidOptions) {
      if (hitNodeCap && bestVal > -Infinity) break
      let expOptVal = 0
      let optFeasible = true
      let primaryTrunkTrace = []
      let primaryScen = {}

      for (let bIdx = 0; bIdx < opt.branches.length; bIdx++) {
        const br = opt.branches[bIdx]
        const cands = enumerateIndependentCandidateBatches(adapter, br.world, {
          atSec: st.atSec,
          prices,
          allowedActionTypes,
          constraints,
        })
        let bestBrVal = -Infinity
        let bestBrTrace = []
        let bestBrScen = {}
        for (const c of cands) {
          if (hitNodeCap && bestBrVal > -Infinity) break
          const nextCash = [...br.cash]
          const deltaC = Number(c.simAfterWorld.coins || 0) - Number(br.world.coins || 0)
          if (deltaC !== 0) nextCash.push({ atSec: st.atSec, netCashDelta: deltaC })

          const nextSold = new Map(soldByIsle)
          for (const a of c.actions) {
            if (a.a === 'sell') {
              const m = { ...(nextSold.get(st.isleIndex) || {}) }
              m[a.id] = (m[a.id] || 0) + Number(a.n || 0)
              nextSold.set(st.isleIndex, m)
            }
          }

          const sub = evalSharedTrunkList(
            c.simAfterWorld,
            trunkList,
            tIdx + 1,
            nextCash,
            nextSold,
            opt.stealsByIsle,
            opt.seenOwners
          )
          if (sub.bestVal > bestBrVal) {
            bestBrVal = sub.bestVal
            const recActs = opt.raidTag ? [opt.raidTag, ...c.actions] : c.actions
            bestBrTrace = [{ atSec: st.atSec, actions: recActs, raidOutcome: br.kind }, ...sub.bestTrunkTrace]
            bestBrScen = sub.byScenario
          }
        }
        if (!(bestBrVal > -Infinity)) {
          optFeasible = false
          break
        }
        expOptVal += br.prob * bestBrVal
        if (bIdx === 0) {
          primaryTrunkTrace = bestBrTrace
          primaryScen = bestBrScen
        }
      }

      if (optFeasible && expOptVal > bestVal) {
        bestVal = expOptVal
        bestTrunkTrace = primaryTrunkTrace
        bestScen = primaryScen
      }
    }

    return { bestVal, bestTrunkTrace, byScenario: bestScen }
  }

  // Evaluate every candidate first action `a` at `step 0` (`t0`) + actual first action `actualFirstActions`!
  const step0 = trunkSteps[0]
  const prices0 = getStepPrices(step0, normScenarios[0], new Map())
  let w0 = adapter.advanceTimeOnly(worldBefore, step0.atSec, { futurePrices: prices0 })
  w0 = addArrivalsToWorld(w0, step0.arrivals)
  const minGapSec = adapter.R.WORLD?.minGap || 2
  const baseIsle = adapter.R.isleIndex(timeline.t0)
  const initStealsByIsle = new Map()
  if (Number(reservedStealUsedThisIsleDay || 0) > 0) {
    initStealsByIsle.set(baseIsle, Math.max(0, Math.floor(Number(reservedStealUsedThisIsleDay))))
  }

  const rootCandidates = enumerateIndependentCandidateBatches(adapter, w0, {
    atSec: step0.atSec,
    prices: prices0,
    allowedActionTypes,
    constraints,
  })
  if (readyRaidsById.size > 0 && (initStealsByIsle.get(step0.isleIndex) || 0) < maxPerIsleStealRef) {
    for (const [tid] of readyRaidsById.entries()) {
      rootCandidates.push({
        label: `visit:${tid}`,
        actions: [{ a: 'visit', targetId: tid }],
      })
    }
  }

  const buildRemainingTrunkForFirstBatch = (actions0) => {
    const rest = trunkSteps.slice(1)
    if (!actions0 || actions0.length === 0) return rest
    // Allow intra-bucket follow-up `/act` batches at `+minGap` before jumping to `step0.nextAtSec`!
    const followUps = []
    const tF1 = step0.atSec + minGapSec
    if (tF1 < step0.nextAtSec && tF1 < tEnd) {
      const tF2 = tF1 + minGapSec
      const hasSecond = tF2 < step0.nextAtSec && tF2 < tEnd && maxSteps >= 3
      followUps.push({
        index: 0,
        atSec: tF1,
        nextAtSec: hasSecond ? tF2 : step0.nextAtSec,
        isleIndex: adapter.R.isleIndex(tF1),
        isleDay: adapter.R.isleDay(tF1),
        isleDayOffset: Math.max(0, adapter.R.isleIndex(tF1) - baseIsle),
        naturalDay: adapter.R.worldDay(tF1),
        arrivals: [],
      })
      if (hasSecond) {
        followUps.push({
          index: 0,
          atSec: tF2,
          nextAtSec: step0.nextAtSec,
          isleIndex: adapter.R.isleIndex(tF2),
          isleDay: adapter.R.isleDay(tF2),
          isleDayOffset: Math.max(0, adapter.R.isleIndex(tF2) - baseIsle),
          naturalDay: adapter.R.worldDay(tF2),
          arrivals: [],
        })
      }
    }
    return [...followUps, ...rest]
  }

  const evalRootAction = (actions0) => {
    const visitAct = (actions0 || []).find((a) => a?.a === 'visit')
    if (visitAct) {
      const tid = Number(visitAct.targetId ?? visitAct.id)
      const rb = readyRaidsById.get(tid)
      const curUsed0 = initStealsByIsle.get(step0.isleIndex) || 0
      if (!rb || curUsed0 >= maxPerIsleStealRef) {
        return { legal: false, value: -Infinity, trace: [] }
      }
      const preVisitDomActs = (actions0 || []).filter((a) => a?.a !== 'visit')
      let preW = w0
      const baseCash0 = []
      const sold0 = new Map()
      if (preVisitDomActs.length > 0) {
        const simPre = adapter.simulateBatch(w0, preVisitDomActs, { t: step0.atSec, prices: prices0 })
        if (!simPre.allOk) return { legal: false, value: -Infinity, trace: [] }
        preW = simPre.afterWorld
        const dC = Number(preW.coins || 0) - Number(w0.coins || 0)
        if (dC !== 0) baseCash0.push({ atSec: step0.atSec, netCashDelta: dC })
        for (const a of preVisitDomActs) {
          if (a.a === 'sell') {
            const m = { ...(sold0.get(step0.isleIndex) || {}) }
            m[a.id] = (m[a.id] || 0) + Number(a.n || 0)
            sold0.set(step0.isleIndex, m)
          }
        }
      }
      const rRes = applyIndependentRaidAtStep(adapter, preW, rb, {
        atSec: step0.atSec,
        prices: prices0,
        allowedSet: allowedRefSet,
        constraints,
        mode: raidOutcomeMode,
      })
      if (!rRes.feasible || !Array.isArray(rRes.outcomes) || rRes.outcomes.length === 0) {
        return { legal: false, value: -Infinity, trace: [] }
      }
      const nextSteals0 = new Map(initStealsByIsle)
      nextSteals0.set(step0.isleIndex, curUsed0 + 1)
      const nextSeen0 = new Set([`${tid}:${step0.naturalDay}`])
      const usedDomAt0 = preVisitDomActs.length > 0 || (rRes.prepActs?.length || 0) > 0
      const remTrunk = buildRemainingTrunkForFirstBatch(usedDomAt0 ? [{ a: 'wait' }] : [visitAct])
      let expVal0 = 0
      let primaryTrace0 = []
      let primaryScen0 = {}
      for (let bIdx = 0; bIdx < rRes.outcomes.length; bIdx++) {
        const br = rRes.outcomes[bIdx]
        const brCash = [...baseCash0, ...br.extraCashEvents]
        const cont = evalSharedTrunkList(br.afterRaidWorld, remTrunk, 0, brCash, sold0, nextSteals0, nextSeen0)
        expVal0 += br.prob * cont.bestVal
        if (bIdx === 0) {
          primaryTrace0 = [{ atSec: step0.atSec, actions: actions0, raidOutcome: br.kind }, ...cont.bestTrunkTrace]
          primaryScen0 = cont.byScenario
        }
      }
      return {
        legal: true,
        afterStep0World: rRes.outcomes[0].afterRaidWorld,
        cash0: [...baseCash0, ...rRes.outcomes[0].extraCashEvents],
        sold0,
        value: expVal0,
        trace: primaryTrace0,
        byScenario: primaryScen0,
      }
    }

    const sim0 = actions0.length === 0
      ? { allOk: true, afterWorld: w0 }
      : adapter.simulateBatch(w0, actions0, { t: step0.atSec, prices: prices0 })

    if (!sim0.allOk) {
      return { legal: false, value: -Infinity, trace: [] }
    }
    const cash0 = []
    const dCoins = Number(sim0.afterWorld.coins || 0) - Number(w0.coins || 0)
    if (dCoins !== 0) cash0.push({ atSec: step0.atSec, netCashDelta: dCoins })
    const sold0 = new Map()
    for (const a of actions0) {
      if (a.a === 'sell') {
        const m = { ...(sold0.get(step0.isleIndex) || {}) }
        m[a.id] = (m[a.id] || 0) + Number(a.n || 0)
        sold0.set(step0.isleIndex, m)
      }
    }
    const remTrunk = buildRemainingTrunkForFirstBatch(actions0)
    const cont = evalSharedTrunkList(sim0.afterWorld, remTrunk, 0, cash0, sold0, initStealsByIsle, new Set())
    return {
      legal: true,
      afterStep0World: sim0.afterWorld,
      cash0,
      sold0,
      value: cont.bestVal,
      trace: [{ atSec: step0.atSec, actions: actions0 }, ...cont.bestTrunkTrace],
      byScenario: cont.byScenario,
    }
  }

  const actualEval = evalRootAction(actualFirstActions)

  let bestAlt = null
  for (const cand of rootCandidates) {
    const ev = evalRootAction(cand.actions)
    if (ev.legal && (!bestAlt || ev.value > bestAlt.value + 1e-6)) {
      bestAlt = {
        label: cand.label,
        firstActions: cand.actions,
        value: ev.value,
        trace: ev.trace,
        byScenario: ev.byScenario,
      }
    }
  }

  const hasStochasticAllowed = (allowedActionTypes || []).some((a) => a === 'visit' || adapter.isStochasticAction({ a }))

  // Compute an independent, untruncated weak-duality upper bound U(a_actual) >= sup_{π after a_actual} E[J(π)]
  // over ALL legal multi-batch continuations (immune to batch-grid discretization, candidate pruning, and maxSteps!)
  const actualContinuationUpperBound = actualEval.legal && !hasStochasticAllowed
    ? computeIndependentContinuationUpperBound(adapter, {
        worldBefore,
        afterStep0World: actualEval.afterStep0World,
        actions0: actualFirstActions,
        step0,
        cash0: actualEval.cash0,
        sold0: actualEval.sold0,
        timeline,
        scenarios: normScenarios,
        explicitPricesByStep,
        objectiveCfg,
        allowedActionTypes,
      })
    : null

  const certifiedUpperActual = actualContinuationUpperBound != null && actualEval.legal
    ? Math.max(actualEval.value, actualContinuationUpperBound)
    : null

  const exhaustiveCertified = certifiedUpperActual != null && !hasStochasticAllowed

  // R_lower computation (round2-design-review.md §5):
  // 1) If actualFirstActions was mechanically illegal (`!actualEval.legal`), regret vs best legal alternative is certified!
  // 2) If `actualFullPolicyObjectiveValue` is known (auditing a complete planned/executed trajectory Π_actual),
  //    any legal witness trajectory `bestAlt` with `bestAlt.value > actualFullPolicyObjectiveValue` proves a strict lower bound!
  // 3) If auditing only the first-step prefix `actualFirstActions`, `certifiedUpperActual = U(a_actual)` is a proven
  //    weak-duality upper bound over ALL continuations after `a_actual` while `L(bestAlt) = bestAlt.value` is a simulated
  //    feasible policy value, so `R_lower = max(0, L(bestAlt) - U(a_actual))` is unconditionally sound!
  let identifiableRegretLowerBound = null
  let estimatedReferenceDelta = 0

  if (bestAlt) {
    const refActual = Number.isFinite(actualFullPolicyObjectiveValue)
      ? actualFullPolicyObjectiveValue
      : (actualEval.legal ? actualEval.value : 0)
    estimatedReferenceDelta = Math.max(0, bestAlt.value - refActual)

    if (!actualEval.legal) {
      identifiableRegretLowerBound = Math.max(0, bestAlt.value - Number(worldBefore.coins || 0))
    } else if (Number.isFinite(actualFullPolicyObjectiveValue) && !hasStochasticAllowed) {
      identifiableRegretLowerBound = Math.max(0, bestAlt.value - actualFullPolicyObjectiveValue)
    } else if (certifiedUpperActual != null) {
      identifiableRegretLowerBound = Math.max(0, bestAlt.value - certifiedUpperActual)
    }
  }

  return {
    identifiable: true,
    exhaustiveCertified,
    nodesVisited,
    actualLegal: actualEval.legal,
    actualContinuationValue: actualEval.legal ? actualEval.value : null,
    actualContinuationUpperBound: certifiedUpperActual,
    actualFullPolicyObjectiveValue,
    bestAlternative: bestAlt,
    identifiableRegretLowerBound,
    estimatedReferenceDelta,
  }
}

/**
 * Self-contained Lagrangian Weak-Duality Continuation Upper Bound `U(a_actual)` inside `audit/`
 * (ZERO imports from `planner/*`!).
 *
 * Bounds the maximum expected objective achievable from `afterStep0World` over `[tContStart, tEnd]`
 * across all unlimited-batch continuations of `['sell', 'craft', 'wait', 'stockBuy', 'buy', 'eat', 'coffee']`.
 * Uses wait-and-see scenario relaxation `sum_ω p_ω U_ω(a_actual) >= sup_{non-anticipative π} E_ω[J_ω(π)]`.
 */
function computeIndependentContinuationUpperBound(adapter, {
  worldBefore,
  afterStep0World,
  actions0,
  step0,
  cash0,
  sold0,
  timeline,
  scenarios,
  explicitPricesByStep,
  objectiveCfg,
  allowedActionTypes,
}) {
  const supported = new Set(['sell', 'craft', 'wait', 'stockBuy', 'buy', 'eat', 'coffee'])
  const allowed = new Set(allowedActionTypes || [])
  for (const a of allowed) {
    if (!supported.has(a)) return null
  }

  const { R, graph } = adapter
  const t0 = timeline.t0
  const tEnd = timeline.tEnd
  const minGapSec = R.WORLD?.minGap || 2
  const tContStart = actions0 && actions0.length > 0
    ? step0.atSec + minGapSec
    : timeline.firstPostT0EventSec

  const baseIsle = R.isleIndex(t0)

  // Map step timestamps to explicit prices if caller supplied step-indexed price overrides
  const stepIndexBySec = new Map()
  for (const st of timeline.steps) stepIndexBySec.set(st.atSec, st.index)

  const resolveUpperSlotPrices = (sec, sc) => {
    const exactIdx = stepIndexBySec.get(sec)
    if (exactIdx != null) {
      if (explicitPricesByStep?.[exactIdx]) return explicitPricesByStep[exactIdx]
      if (sc.explicitPricesByStep?.[exactIdx]) return sc.explicitPricesByStep[exactIdx]
    }
    // Check if any step in the same isleIndex has explicit prices
    const sIsle = R.isleIndex(sec)
    for (const st of timeline.steps) {
      if (st.isleIndex === sIsle) {
        if (explicitPricesByStep?.[st.index]) return explicitPricesByStep[st.index]
        if (sc.explicitPricesByStep?.[st.index]) return sc.explicitPricesByStep[st.index]
      }
    }
    const offset = Math.max(0, sIsle - baseIsle)
    if (offset === 0) return worldBefore.prices || {}
    // Setting additional future self-sales to 0 maximizes `effS` and therefore upper-bounds future prices!
    const prevKnownSold = (sIsle - 1 === step0.isleIndex) ? (sold0.get(step0.isleIndex) || {}) : {}
    const out = {}
    for (const id of graph.sellableIds) {
      out[id] = quoteFutureItemUnderScenario(adapter, {
        itemId: id,
        isleDayIndex: offset,
        isleDayStr: R.isleDay(sec),
        currentPrices: worldBefore.prices || {},
        externalSupplyFactor: sc.externalSupplyFactor,
        selfSoldPrevIsleDay: Number(prevKnownSold[id] || 0),
      })
    }
    return out
  }

  // If no further in-horizon `/act` timestamp exists before `tEnd`, evaluate terminal liquidation directly!
  if (tContStart >= tEnd) {
    let expTerm = 0
    for (const sc of scenarios) {
      const prevSoldTerm = sold0.get(R.isleIndex(tEnd) - 1) || null
      const termPrices = sc.explicitTerminalPrices
        || (objectiveCfg.terminalSupplyMode === 'zero'
            ? {}
            : buildTerminalPrices(adapter, { ...afterStep0World, now: tEnd }, worldBefore, objectiveCfg, sc.externalSupplyFactor, prevSoldTerm))
      let wFinal = adapter.advanceTimeOnly(afterStep0World, tEnd, { futurePrices: termPrices })
      for (const [arrSec, items] of timeline.arrMap.entries()) {
        if (arrSec > step0.atSec && arrSec <= tEnd) {
          wFinal = addArrivalsToWorld(wFinal, items)
        }
      }
      const ev = evaluateTrajectoryObjective(adapter, {
        initialWorld: worldBefore,
        finalWorld: wFinal,
        cashEvents: cash0,
        objectiveCfg,
        scenarioSupplyFactor: sc.externalSupplyFactor,
        explicitTerminalPrices: sc.explicitTerminalPrices || (objectiveCfg.terminalSupplyMode === 'zero' ? {} : null),
        prevIsleSoldMap: prevSoldTerm,
        allowTerminalCraft: allowed.has('craft'),
        allowTerminalHarvest: allowed.has('harvest'),
        allowTerminalPlant: allowed.has('plant'),
      })
      expTerm += sc.weight * ev.totalObjectiveValue
    }
    return expTerm
  }

  // Build untruncated continuation event points in `[tContStart, tEnd)`!
  const contSecsSet = new Set([tContStart])
  for (const s of timeline.allSortedSecs) {
    if (s >= tContStart && s < tEnd) contSecsSet.add(s)
  }
  const contSecs = [...contSecsSet].sort((a, b) => a - b)

  // Discounted cash already locked in at step0 + initialCoins
  let baseObjValue = Number(worldBefore.coins || 0)
  for (const ce of cash0) {
    baseObjValue += ce.netCashDelta * discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, ce.atSec - t0))
  }

  const edibleSpecs = typeof adapter.listDeterministicEdibleSpecs === 'function'
    ? adapter.listDeterministicEdibleSpecs()
    : []

  const solveSingleScenarioBound = (sc) => {
    const firstPrices = resolveUpperSlotPrices(tContStart, sc)
    let wStart = adapter.advanceTimeOnly(afterStep0World, tContStart, { futurePrices: firstPrices })
    // Absorb any exogenous arrivals in `(step0.atSec, tContStart]`
    for (const [arrSec, items] of timeline.arrMap.entries()) {
      if (arrSec > step0.atSec && arrSec <= tContStart) {
        wStart = addArrivalsToWorld(wStart, items)
      }
    }

    const B = contSecs.length
    const buckets = contSecs.map((sec, idx) => ({
      atSec: sec,
      nextAtSec: idx + 1 < B ? contSecs[idx + 1] : tEnd,
      naturalDay: R.worldDay(sec),
      isleIndex: R.isleIndex(sec),
      isleDay: R.isleDay(sec),
      prices: resolveUpperSlotPrices(sec, sc),
      arrivals: sec > tContStart ? (timeline.arrMap.get(sec) || []) : [],
    }))

    const prevSoldForTerm = R.isleIndex(tEnd) - 1 === step0.isleIndex ? (sold0.get(step0.isleIndex) || null) : null
    const contSlots = (sc.explicitTerminalPrices || objectiveCfg.terminalSupplyMode === 'zero')
      ? []
      : buildContinuationTimeline(adapter, { ...wStart, now: tEnd }, worldBefore, objectiveCfg, sc.externalSupplyFactor, prevSoldForTerm)
    const termPrices = sc.explicitTerminalPrices
      || (objectiveCfg.terminalSupplyMode === 'zero'
          ? {}
          : (contSlots[0]?.prices ?? buildTerminalPrices(
              adapter,
              { ...wStart, now: tEnd },
              worldBefore,
              objectiveCfg,
              sc.externalSupplyFactor,
              prevSoldForTerm
            )))

    const allSlots = [
      ...buckets.map((b, idx) => ({
        slotIdx: idx,
        atSec: b.atSec,
        nextAtSec: b.nextAtSec,
        naturalDay: b.naturalDay,
        isleIndex: b.isleIndex,
        isleDay: b.isleDay,
        prices: b.prices,
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
              atSec: tEnd,
              nextAtSec: tEnd,
              naturalDay: R.worldDay(tEnd),
              isleIndex: R.isleIndex(tEnd),
              isleDay: R.isleDay(tEnd),
              prices: termPrices,
              isTerminal: true,
              disc: discountFactor(objectiveCfg.discountRatePerHour, Math.max(0, tEnd - t0)),
            }]),
    ]
    const S = allSlots.length
    const craftBoundSlots = contSlots.length > 1 ? S : B
    const avail0 = adapter.availableInvSnapshot(wStart.state)

    const itemSet = new Set([
      ...Object.keys(avail0),
      ...graph.sellableIds,
      ...(R.RECIPES || []).map((r) => r.id),
      ...edibleSpecs.map((e) => e.id),
    ])
    for (const b of buckets) for (const g of b.arrivals) itemSet.add(g.id)
    if (allowed.has('stockBuy') && typeof R.b12Stock === 'function') {
      for (let b = 0; b < B; b++) {
        for (const stItem of R.b12Stock(allSlots[b].atSec, allSlots[b].prices)) itemSet.add(stItem.id)
      }
    }
    const items = [...itemSet]

    const isleIndices = [...new Set(allSlots.slice(0, craftBoundSlots).map((s) => s.isleIndex))]
    const naturalDays = [...new Set(allSlots.map((s) => s.naturalDay))]
    const startIsleIdx = R.isleIndex(tContStart)
    const startNatDay = R.worldDay(tContStart)

    const craftCapByIsle = new Map()
    for (const idx of isleIndices) {
      const used = idx === startIsleIdx && wStart.state?.iq?.d === idx ? Number(wStart.state.iq.craft || 0) : 0
      craftCapByIsle.set(idx, allowed.has('craft') ? Math.max(0, (R.WORLD?.daily?.craft || 80) - used) : 0)
    }

    const initEn = Number(wStart.state?.en || 0)
    const regenEvery = R.WORLD?.regen || 180
    const baseEnT = Number.isFinite(wStart.state?.enT) ? Number(wStart.state.enT) : tContStart
    const maxRegenTo = (sec) => Math.max(
      0,
      Math.ceil(Math.max(0, sec - tContStart) / regenEvery),
      Math.floor(Math.max(0, sec - baseEnT) / regenEvery)
    )

    const q2Max = {}
    const q12Max = {}
    const prefixTotalSupply = {}
    for (const id of items) {
      let c2 = avail0[id]?.[2] || 0
      let c12 = (avail0[id]?.[1] || 0) + c2
      for (let b = 0; b < B; b++) {
        for (const g of buckets[b].arrivals) {
          if (g.id === id) {
            if ((g.q || 0) === 2) c2 += g.n
            if ((g.q || 0) >= 1) c12 += g.n
          }
        }
      }
      q2Max[id] = c2
      q12Max[id] = c12
      prefixTotalSupply[id] = new Array(S).fill(0)
      let cum = (avail0[id]?.[0] || 0) + (avail0[id]?.[1] || 0) + (avail0[id]?.[2] || 0)
      for (let s = 0; s < S; s++) {
        if (s < B) {
          for (const g of buckets[s].arrivals) {
            if (g.id === id) cum += g.n
          }
        }
        prefixTotalSupply[id][s] = cum
      }
    }

    const linConstraints = []
    const addC = (rhs) => {
      const idx = linConstraints.length
      linConstraints.push(Math.max(0, rhs))
      return idx
    }

    const cQ2 = new Map()
    const cQ12 = new Map()
    const cPrefixItem = new Map()
    for (const id of items) {
      cQ2.set(id, addC(q2Max[id]))
      cQ12.set(id, addC(q12Max[id]))
      for (let s = 0; s < S; s++) cPrefixItem.set(`${id}@${s}`, addC(prefixTotalSupply[id][s]))
    }

    const cCraftIsle = new Map()
    for (const idx of isleIndices) cCraftIsle.set(idx, addC(craftCapByIsle.get(idx)))

    const cPrefixEn = []
    for (let b = 0; b < craftBoundSlots; b++) cPrefixEn.push(addC(initEn + maxRegenTo(allSlots[b].nextAtSec)))

    const cCropTier = new Map()
    for (const id of items) {
      if (!graph.cropsById.has(id)) continue
      for (const nd of naturalDays) {
        const scUsed = nd === startNatDay && wStart.state?.enDay === nd ? Number(wStart.state?.cnt?.['sc_' + id] || 0) : 0
        cCropTier.set(`${id}:${nd}:0`, addC(Math.max(0, 150 - scUsed)))
        cCropTier.set(`${id}:${nd}:1`, addC(Math.max(0, 400 - Math.max(150, scUsed))))
      }
    }

    const vars = []
    const canSellInHorizon = allowed.has('sell')
    for (let s = 0; s < S; s++) {
      const slot = allSlots[s]
      if (!slot.isTerminal && !canSellInHorizon) continue
      for (const id of items) {
        const baseP = Number(R.BASE_PRICE?.[id] || 0)
        const quoteP = Number(slot.prices?.[id] || 0)
        if (!(baseP > 0) || !(quoteP > 0)) continue
        const isCrop = graph.cropsById.has(id)
        const maxPossible = prefixTotalSupply[id][S - 1]
          + (allowed.has('craft') ? 80 * Math.max(1, isleIndices.length) : 0)
          + (allowed.has('stockBuy') ? 24 * Math.max(1, isleIndices.length) : 0)
        if (maxPossible <= 0) continue

        for (const q of [0, 1, 2]) {
          if (q === 2 && q2Max[id] <= 0) continue
          if (q === 1 && q12Max[id] <= 0) continue
          const unit = Math.round(quoteP * (R.QUALITY?.[q] ?? 1))
          const tiers = isCrop ? [[0, 1.0], [1, 0.85], [2, 0.70]] : [[2, 1.0]]
          for (const [tIdx, mult] of tiers) {
            const unitCeil = Math.ceil(unit * mult - 1e-9)
            let ub = maxPossible
            if (q === 2) ub = Math.min(ub, q2Max[id])
            else if (q === 1) ub = Math.min(ub, q12Max[id])
            if (isCrop && tIdx < 2) {
              ub = Math.min(ub, linConstraints[cCropTier.get(`${id}:${slot.naturalDay}:${tIdx}`)])
            }
            if (ub <= 0) continue
            const terms = []
            if (q === 2) terms.push([cQ2.get(id), 1])
            if (q >= 1) terms.push([cQ12.get(id), 1])
            for (let fs = s; fs < S; fs++) terms.push([cPrefixItem.get(`${id}@${fs}`), 1])
            if (isCrop && tIdx < 2) terms.push([cCropTier.get(`${id}:${slot.naturalDay}:${tIdx}`), 1])
            vars.push({ ub, obj: unitCeil * slot.disc, terms })
          }
        }
      }
    }

    if (allowed.has('craft')) {
      const craftEnCost = R.WORLD?.cost?.craft ?? 1
      for (let b = 0; b < craftBoundSlots; b++) {
        const slot = allSlots[b]
        const cap = craftCapByIsle.get(slot.isleIndex) || 0
        if (cap <= 0) continue
        for (const r of R.RECIPES || []) {
          const terms = [[cCraftIsle.get(slot.isleIndex), 1]]
          for (let fb = b; fb < craftBoundSlots; fb++) terms.push([cPrefixEn[fb], craftEnCost])
          for (let fs = b; fs < S; fs++) {
            for (const [inId, qty] of Object.entries(r.in || {})) {
              terms.push([cPrefixItem.get(`${inId}@${fs}`), qty])
            }
            terms.push([cPrefixItem.get(`${r.id}@${fs}`), -1])
          }
          vars.push({ ub: cap, obj: 0, terms })
        }
      }
    }

    if (allowed.has('stockBuy') && typeof R.b12Stock === 'function') {
      const seenIsle = new Set()
      for (let b = 0; b < B; b++) {
        const slot = allSlots[b]
        if (seenIsle.has(slot.isleIndex)) continue
        seenIsle.add(slot.isleIndex)
        for (const item of R.b12Stock(slot.atSec, slot.prices)) {
          const left = slot.isleIndex === startIsleIdx ? R.b12StockLeft(wStart.state, item, slot.atSec) : item.limit
          if (left <= 0 || !itemSet.has(item.id)) continue
          const terms = []
          for (let fs = b; fs < S; fs++) terms.push([cPrefixItem.get(`${item.id}@${fs}`), -1])
          vars.push({ ub: left, obj: -item.price * slot.disc, terms })
        }
      }
    }

    if (allowed.has('coffee')) {
      const seenNd = new Set()
      for (let b = 0; b < B; b++) {
        const slot = allSlots[b]
        if (seenNd.has(slot.naturalDay)) continue
        seenNd.add(slot.naturalDay)
        const used = slot.naturalDay === startNatDay && wStart.state?.enDay === slot.naturalDay
          ? Number(wStart.state?.cnt?.coffee || 0)
          : 0
        const left = Math.max(0, (R.WORLD?.daily?.coffee || 3) - used)
        if (left <= 0) continue
        const terms = []
        for (let fb = b; fb < craftBoundSlots; fb++) terms.push([cPrefixEn[fb], -(R.WORLD?.coffee?.energy || 60)])
        vars.push({ ub: left, obj: -(R.WORLD?.coffee?.price || 15000) * slot.disc, terms })
      }
    }

    if (allowed.has('eat')) {
      const cEdibleDaily = new Map()
      for (const spec of edibleSpecs) {
        if (spec.dailyCap != null) {
          for (const nd of naturalDays) {
            const key = `${spec.id}:${nd}`
            if (!cEdibleDaily.has(key)) {
              const used0 = nd === startNatDay && wStart.state?.enDay === nd
                ? Number(wStart.state?.cnt?.[spec.id] || 0)
                : 0
              cEdibleDaily.set(key, addC(Math.max(0, spec.dailyCap - used0)))
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
            ub = Math.min(ub, linConstraints[cEdibleDaily.get(`${spec.id}:${slot.naturalDay}`)])
          }
          if (ub <= 0) continue
          const terms = []
          if (spec.q === 2) terms.push([cQ2.get(spec.id), 1])
          if (spec.q >= 1) terms.push([cQ12.get(spec.id), 1])
          if (spec.dailyCap != null) terms.push([cEdibleDaily.get(`${spec.id}:${slot.naturalDay}`), 1])
          for (let fs = b; fs < S; fs++) terms.push([cPrefixItem.get(`${spec.id}@${fs}`), 1])
          for (let fb = b; fb < craftBoundSlots; fb++) terms.push([cPrefixEn[fb], -spec.energyGain])
          vars.push({ ub, obj: 0, terms })
        }
      }
    }

    const M = linConstraints.length
    const lambda = new Float64Array(M)
    for (const id of items) {
      let maxP = Number(R.BASE_PRICE?.[id] || 0) * 1.5
      for (const sl of allSlots) maxP = Math.max(maxP, Number(sl.prices?.[id] || 0) * 1.5)
      const lastKey = cPrefixItem.get(`${id}@${S - 1}`)
      if (lastKey != null) lambda[lastKey] = maxP
    }

    let bestUpper = Infinity
    const subgrad = new Float64Array(M)
    for (let iter = 0; iter < 60; iter++) {
      for (let c = 0; c < M; c++) subgrad[c] = linConstraints[c]
      let dualVal = baseObjValue
      for (let c = 0; c < M; c++) dualVal += lambda[c] * linConstraints[c]

      for (let j = 0; j < vars.length; j++) {
        const v = vars[j]
        let rc = v.obj
        const terms = v.terms
        for (let k = 0; k < terms.length; k++) rc -= lambda[terms[k][0]] * terms[k][1]
        if (rc > 0) {
          dualVal += v.ub * rc
          for (let k = 0; k < terms.length; k++) subgrad[terms[k][0]] -= terms[k][1] * v.ub
        }
      }
      if (dualVal < bestUpper) bestUpper = dualVal
      let normSq = 0
      for (let c = 0; c < M; c++) {
        const g = (lambda[c] === 0 && subgrad[c] > 0) ? 0 : subgrad[c]
        normSq += g * g
      }
      if (normSq < 1e-6) break
      const stepSize = (0.85 / (1 + 0.12 * iter)) * (Math.max(100, bestUpper * 0.05) / Math.sqrt(normSq))
      for (let c = 0; c < M; c++) lambda[c] = Math.max(0, lambda[c] - stepSize * subgrad[c])
    }

    return objectiveCfg.discountRatePerHour > 0
      ? Math.ceil(bestUpper * 1e6 - 1e-6) / 1e6
      : Math.floor(bestUpper + 1e-6)
  }

  let weightedUpper = 0
  for (const sc of scenarios) {
    weightedUpper += sc.weight * solveSingleScenarioBound(sc)
  }
  return weightedUpper
}
