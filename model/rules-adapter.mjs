import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function canonicalizeForHash(value) {
  if (typeof value === 'function') return `[fn:${value.toString()}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalizeForHash).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalizeForHash(value[k])).join(',') + '}'
}

export function computeRulesHash(rulesModule, sourceText = null) {
  const payload = typeof sourceText === 'string' && sourceText.length > 0
    ? sourceText
    : canonicalizeForHash({
        WORLD: rulesModule.WORLD,
        ISLE_SPAN: rulesModule.ISLE_SPAN,
        ISLE_LAUNCH: rulesModule.ISLE_LAUNCH,
        ISLE_SEASON_DAYS: rulesModule.ISLE_SEASON_DAYS,
        CROPS: rulesModule.CROPS,
        ANIMALS: rulesModule.ANIMALS,
        FISH: rulesModule.FISH,
        ORES: rulesModule.ORES,
        PICK_FLOOR: rulesModule.PICK_FLOOR,
        SHOP: rulesModule.SHOP,
        BASE_PRICE: rulesModule.BASE_PRICE,
        QUALITY: rulesModule.QUALITY,
        CROP_TIERS: rulesModule.CROP_TIERS,
        RECIPES: rulesModule.RECIPES,
        GUARD_ITEMS: rulesModule.GUARD_ITEMS,
        THIEF_ITEMS: rulesModule.THIEF_ITEMS,
        B12_SNACK: rulesModule.B12_SNACK,
        B12_GROW_DAYS: rulesModule.B12_GROW_DAYS,
        B12_ADULT_DAYS: rulesModule.B12_ADULT_DAYS,
        B12_TAX: rulesModule.B12_TAX,
      })
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function buildCatalogGraph(R) {
  const cropsById = new Map((R.CROPS || []).map((c) => [c.id, c]))
  const animalsById = new Map((R.ANIMALS || []).map((a) => [a.id, a]))
  const animalByProduct = new Map((R.ANIMALS || []).map((a) => [a.product, a]))
  const fishById = new Map((R.FISH || []).map((f) => [f.id, f]))
  const oresById = new Map((R.ORES || []).map((o) => [o.id, o]))
  const recipesById = new Map((R.RECIPES || []).map((r) => [r.id, r]))

  const consumedByRecipes = new Map()
  for (const r of R.RECIPES || []) {
    for (const inId of Object.keys(r.in || {})) {
      if (!consumedByRecipes.has(inId)) consumedByRecipes.set(inId, [])
      consumedByRecipes.get(inId).push(r)
    }
  }

  // Topological sort over recipes so intermediate crafted materials (e.g. ingot -> crown) precede consumers.
  const inDegree = new Map()
  const edges = new Map()
  for (const r of R.RECIPES || []) {
    inDegree.set(r.id, 0)
    edges.set(r.id, [])
  }
  for (const r of R.RECIPES || []) {
    for (const inId of Object.keys(r.in || {})) {
      if (recipesById.has(inId)) {
        edges.get(inId).push(r.id)
        inDegree.set(r.id, (inDegree.get(r.id) || 0) + 1)
      }
    }
  }
  const queue = []
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id)
  }
  const topoRecipes = []
  while (queue.length > 0) {
    const id = queue.shift()
    topoRecipes.push(recipesById.get(id))
    for (const nxt of edges.get(id) || []) {
      const nd = (inDegree.get(nxt) || 0) - 1
      inDegree.set(nxt, nd)
      if (nd === 0) queue.push(nxt)
    }
  }
  for (const r of R.RECIPES || []) {
    if (!topoRecipes.includes(r)) topoRecipes.push(r)
  }

  // Depth of recipe chain (1 for direct recipes, 2 for 2-step chains like ingot -> crown, etc.)
  const recipeChainSteps = new Map()
  for (const r of topoRecipes) {
    let extra = 0
    for (const [inId, qty] of Object.entries(r.in || {})) {
      if (recipeChainSteps.has(inId)) {
        extra += qty * recipeChainSteps.get(inId)
      }
    }
    recipeChainSteps.set(r.id, 1 + extra)
  }

  const sellableIds = Object.keys(R.BASE_PRICE || {}).filter((id) => Number(R.BASE_PRICE[id]) > 0)
  const allKnownItemIds = new Set([
    ...sellableIds,
    ...Object.keys(R.ITEM_NAME || {}),
    ...Object.keys(R.SHOP || {}),
    ...(R.RECIPES || []).map((r) => r.id),
  ])

  return {
    cropsById,
    animalsById,
    animalByProduct,
    fishById,
    oresById,
    recipesById,
    consumedByRecipes,
    topoRecipes,
    recipeChainSteps,
    sellableIds,
    allKnownItemIds,
  }
}

const STOCHASTIC_ACTIONS = new Set([
  'harvest',
  'fish',
  'mine',
  'bomb',
  'trap',
  'npc',
  'scratch',
  'visit',
])

export function createRulesAdapter(rulesModule, { clockStart = 0, rulesSourceText = null } = {}) {
  const R = rulesModule
  const effectiveClockStart = Number.isSafeInteger(clockStart) && clockStart >= (R.ISLE_LAUNCH || 0)
    ? clockStart
    : (typeof R.b12ClockStart === 'function' ? R.b12ClockStart() : 0)

  const syncClock = (overrideClockStart = null) => {
    const cs = Number.isSafeInteger(overrideClockStart) && overrideClockStart >= (R.ISLE_LAUNCH || 0)
      ? overrideClockStart
      : effectiveClockStart
    if (cs >= (R.ISLE_LAUNCH || 0) && typeof R.b12ConfigureClock === 'function') {
      if (R.b12ClockStart() !== cs) R.b12ConfigureClock(cs)
    }
    return cs
  }
  syncClock()

  const rulesHash = computeRulesHash(R, rulesSourceText)
  const graph = buildCatalogGraph(R)

  function fastCloneJson(val) {
    if (val === null || typeof val !== 'object') return val
    if (Array.isArray(val)) {
      const len = val.length
      const arr = new Array(len)
      for (let i = 0; i < len; i++) {
        const el = val[i]
        arr[i] = el !== null && typeof el === 'object' ? fastCloneJson(el) : el
      }
      return arr
    }
    const proto = Object.getPrototypeOf(val)
    if (proto !== Object.prototype && proto !== null) {
      return structuredClone(val)
    }
    const out = {}
    for (const k in val) {
      if (Object.prototype.hasOwnProperty.call(val, k)) {
        const v = val[k]
        out[k] = v !== null && typeof v === 'object' ? fastCloneJson(v) : v
      }
    }
    return out
  }

  function cloneWorld(world) {
    return fastCloneJson(world)
  }

  function nextNaturalDayBoundary(t) {
    const localDays = Math.floor((t + 8 * 3600) / 86400)
    return (localDays + 1) * 86400 - 8 * 3600
  }

  function nextLongNightEvent(t) {
    const local = t + 8 * 3600
    const dayStartLocal = Math.floor(local / 86400) * 86400
    const secInDay = local - dayStartLocal
    if (secInDay < 8 * 3600) {
      return { at: dayStartLocal + 8 * 3600 - 8 * 3600, kind: 'long-night-end' }
    }
    if (secInDay < 22 * 3600) {
      return { at: dayStartLocal + 22 * 3600 - 8 * 3600, kind: 'long-night-start' }
    }
    return { at: dayStartLocal + 32 * 3600 - 8 * 3600, kind: 'long-night-end' }
  }

  function nextIsleBoundary(t, cs = null) {
    syncClock(cs)
    if (typeof R.b12NextIsleBoundary === 'function') return R.b12NextIsleBoundary(t)
    const span = R.ISLE_SPAN || 14400
    return (Math.floor(t / span) + 1) * span
  }

  const nextSeasonBoundaryMemo = new Map()

  function nextSeasonBoundary(t, cs = null) {
    const activeCs = syncClock(cs)
    const t0 = Math.floor(Number(t || 0))
    const iIdx = R.isleIndex(t0)
    const memoKey = `${activeCs}:${iIdx}`
    const cached = nextSeasonBoundaryMemo.get(memoKey)
    if (cached !== undefined) return cached

    if (nextSeasonBoundaryMemo.size > 4096) nextSeasonBoundaryMemo.clear()
    const startSeason = R.seasonOf(R.isleDay(t0))
    const maxSteps = (R.ISLE_SEASON_DAYS || 12) + 2
    let cursor = t0
    let found = -1
    for (let step = 0; step < maxSteps; step++) {
      const nxt = nextIsleBoundary(cursor, activeCs)
      if (!(nxt > cursor)) break
      cursor = nxt
      if (R.seasonOf(R.isleDay(cursor)) !== startSeason) {
        found = cursor
        break
      }
    }
    nextSeasonBoundaryMemo.set(memoKey, found)
    return found
  }

  function availableInv(state, id, q) {
    const raw = Number(state?.inv?.[id]?.[q] || 0)
    const reserved = Number(state?.b12?.vault?.[id]?.[q] || 0)
    return Math.max(0, raw - reserved)
  }

  function availableInvSnapshot(state) {
    const out = {}
    for (const [id, arr] of Object.entries(state?.inv || {})) {
      if (!Array.isArray(arr)) continue
      const row = [0, 1, 2].map((q) => availableInv(state, id, q))
      if (row[0] > 0 || row[1] > 0 || row[2] > 0) out[id] = row
    }
    return out
  }

  function deterministicPriceBase(itemId, isleDayStr) {
    const base = Number(R.BASE_PRICE?.[itemId] || 0)
    if (!(base > 0)) return 0
    return base * R.marketFactor(itemId, isleDayStr) * R.eventFactor(itemId, isleDayStr)
  }

  function quoteWithSupplyFactor(itemId, isleDayStr, sFactor) {
    const dBase = deterministicPriceBase(itemId, isleDayStr)
    if (!(dBase > 0)) return 0
    const clampedS = Math.max(0.8, Math.min(1.06, sFactor))
    return Math.max(1, Math.round(dBase * clampedS))
  }

  function quoteAtSoldVolume(itemId, isleDayStr, soldYesterday = 0) {
    return R.priceOf(itemId, isleDayStr, soldYesterday)
  }

  function saleNetQuote({ wallet, taxPaidToday = 0, gross, nowSec, taxDayToday = null, clockStartOverride = null }) {
    if (!(gross > 0)) return { gross: 0, tax: 0, net: 0, nextTaxPaid: taxPaidToday }
    const cs = syncClock(clockStartOverride)
    if (!cs || nowSec < cs || typeof R.b12SaleQuote !== 'function') {
      return { gross, tax: 0, net: gross, nextTaxPaid: 0 }
    }
    const curDay = R.worldDay(nowSec)
    const effPaid = taxDayToday === curDay ? (taxPaidToday || 0) : 0
    const q = R.b12SaleQuote(wallet, effPaid, gross)
    const tax = q.tax || 0
    return {
      gross,
      tax,
      net: gross - tax,
      nextTaxPaid: (q.carried || 0) + tax,
      nextTaxDay: curDay,
    }
  }

  function cropSellBatchQuote({ itemId, q, n, unitBasePrice, soldBefore, wallet, taxPaidToday, nowSec, taxDayToday }) {
    if (!(n > 0) || !(unitBasePrice > 0)) {
      return { gross: 0, tax: 0, net: 0, nextSold: soldBefore, nextTaxPaid: taxPaidToday }
    }
    const qualMul = R.QUALITY?.[q] ?? 1
    const unit = Math.round(unitBasePrice * qualMul)
    const isCrop = graph.cropsById.has(itemId)
    const gross = Math.round(isCrop ? R.cropTierValue(soldBefore, n, unit) : unit * n)
    const sq = saleNetQuote({ wallet, taxPaidToday, gross, nowSec, taxDayToday })
    return {
      gross,
      tax: sq.tax,
      net: sq.net,
      nextSold: isCrop ? soldBefore + n : soldBefore,
      nextTaxPaid: sq.nextTaxPaid,
      nextTaxDay: sq.nextTaxDay,
    }
  }

  function isStochasticAction(act) {
    return STOCHASTIC_ACTIONS.has(String(act?.a || ''))
  }

  function makeDeterministicPrng(seed = 0x52d001) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function makeSampleStreamPrng(sampleIndex = 0, simT = 0) {
    // Strictly independent of `world.rev` so identical economic states have identical policy expectations!
    const salt = (Math.imul((sampleIndex + 1) >>> 0, 0x9e3779b1) ^ Math.imul(simT >>> 0, 0x85ebca6b) ^ 0x52d777) >>> 0
    return makeDeterministicPrng(salt)
  }

  function listDeterministicEdibleSpecs() {
    const specs = []
    for (const crop of R.CROPS || []) {
      if (!(crop.eat > 0)) continue
      for (const q of [0, 1, 2]) {
        const gain = Math.round(crop.eat * (R.QUALITY?.[q] ?? 1))
        if (gain > 0) {
          specs.push({
            id: crop.id,
            q,
            energyGain: gain,
            dailyCap: null,
            actionTemplate: { a: 'eat', id: crop.id, q },
          })
        }
      }
    }
    if (R.B12_SNACK && Number(R.B12_SNACK.energy) > 0) {
      const nonSnackIds = new Set([
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
        if (!nonSnackIds.has(id) && !id.startsWith('sd_')) {
          specs.push({
            id,
            q: 0,
            energyGain: Number(R.B12_SNACK.energy),
            dailyCap: Number(R.B12_SNACK.daily || 2),
            actionTemplate: { a: 'eat', id },
          })
          break
        }
      }
    }
    return specs
  }

  function simulateBatch(world, actions, { t = world?.now, prices = world?.prices || {}, rand = null, prng = null, auto = false } = {}) {
    const cs = syncClock(world?.clockStart)
    const nextWorld = cloneWorld(world)
    const simT = Number.isFinite(t) ? Math.floor(t) : Math.floor(nextWorld.now || 0)
    // Default PRNG is strictly independent of `world.rev` so revision bumps never perturb simulated yields!
    // Accept both `rand` and `prng` option aliases so caller sample streams are NEVER silently ignored!
    const activeRand = typeof rand === 'function'
      ? rand
      : (typeof prng === 'function' ? prng : makeDeterministicPrng((simT ^ 0x52d001) >>> 0))
    const ctx = {
      t: simT,
      day: R.worldDay(simT),
      rand: activeRand,
      prices,
      coins: Number(nextWorld.coins || 0),
      auto,
    }
    const res = R.applyActions(nextWorld.state, actions, ctx)
    nextWorld.coins = Number(nextWorld.coins || 0) - (res.spend || 0) + (res.earn || 0)
    nextWorld.now = simT
    nextWorld.nextIsleAt = nextIsleBoundary(simT, cs)
    if (cs) nextWorld.clockStart = cs
    const allOk = actions.length <= (R.WORLD?.maxActions || 40)
      && res.out.length === actions.length
      && res.out.every((o) => o && o.ok === true)
    return {
      afterWorld: nextWorld,
      result: res,
      allOk,
    }
  }

  /**
   * Enumerates the exact discrete finite probability distribution of a single stochastic action
   * (`harvest` or `fish`) by driving `R.applyActions` with exact quantile RNG sequences.
   * Returns `Array<{ prob, afterWorld, result }>` summing to 1.0, or `null` if unsupported.
   */
  function enumerateExactSingleStochasticOutcomes(world, action, { t = world?.now, prices = world?.prices || {} } = {}) {
    const simT = Number.isFinite(t) ? Math.floor(t) : Math.floor(world?.now || 0)
    const refreshed = advanceTimeOnly(world, simT, { futurePrices: prices })
    const s = refreshed.state
    const iDay = R.isleDay(simT)
    const weather = R.weatherOf(iDay)

    const makeSeqRng = (vals) => {
      let idx = 0
      return () => (idx < vals.length ? vals[idx++] : 0.5)
    }

    if (action?.a === 'harvest') {
      const i = Number(action.i)
      const p = s.plots?.[i]
      const auto = !!p && (R.sprinkled(s, i) || weather === 1)
      const st = p && R.cropStage(p, simT, auto)
      if (!p || !st || st.stage < 3 || s.en < (R.WORLD?.cost?.harvest ?? 1)) return null
      const w = auto ? 3 : p.w
      const gold = 0.05 + 0.1 * w
      const silver = 0.2 + 0.08 * w
      const qSpecs = [
        { q: 2, p: gold, u: gold * 0.5 },
        { q: 1, p: silver, u: gold + silver * 0.5 },
        { q: 0, p: Math.max(0, 1 - gold - silver), u: Math.min(0.999999, gold + silver + 0.5 * Math.max(0, 1 - gold - silver)) },
      ].filter((x) => x.p > 0)
      const stolen = !!(p.sv && p.sv.length > 0)
      const extraP = 0.3 + 0.08 * w
      const nSpecs = stolen
        ? [{ p: 1.0, u: 0.99 }]
        : [
            { p: extraP, u: extraP * 0.5 },
            { p: Math.max(0, 1 - extraP), u: Math.min(0.999999, extraP + 0.5 * (1 - extraP)) },
          ].filter((x) => x.p > 0)

      const branches = []
      for (const qs of qSpecs) {
        for (const ns of nSpecs) {
          const prob = qs.p * ns.p
          if (!(prob > 0)) continue
          const step = simulateBatch(refreshed, [action], { t: simT, prices, rand: makeSeqRng([qs.u, ns.u]) })
          if (!step.allOk) return null
          branches.push({ prob, afterWorld: step.afterWorld, result: step.result })
        }
      }
      return branches.length > 0 ? branches : null
    }

    if (action?.a === 'fish') {
      const rodLv = Number(s.tools?.rod || 1)
      const pool = R.fishPool(s, simT)
      if (!pool || pool.length === 0 || s.en < (R.WORLD?.cost?.fish ?? 4)) return null
      const baitId = Object.keys(R.SHOP || {}).find((id) => {
        const sample = R.newWorld?.(R.ISLE_LAUNCH || 0)
        return !(sample?.inv && Object.hasOwn(sample.inv, id)) && !(R.WORLD?.daily?.[id] != null)
      })
      const canUseBait = !!action.bait && baitId && availableInv(s, baitId, 0) > 0
      const miss = Math.max(0.05, 0.22 - 0.04 * rodLv - (canUseBait ? 0.08 : 0) - (weather === 1 ? 0.05 : 0))
      const branches = []
      if (miss > 0) {
        const missStep = simulateBatch(refreshed, [action], { t: simT, prices, rand: makeSeqRng([miss * 0.5]) })
        if (!missStep.allOk) return null
        branches.push({ prob: miss, afterWorld: missStep.afterWorld, result: missStep.result })
      }
      const catchP = 1 - miss
      if (catchP > 0) {
        const boost = (canUseBait ? 2 : 1) * (weather === 1 ? 1.5 : 1)
        const weights = pool.map((f) => f.w * (f.price >= 9000 ? boost : 1))
        const wSum = weights.reduce((a, b) => a + b, 0)
        const pGold = 0.08 + 0.05 * rodLv
        const qChoices = [
          { prob: pGold, uGold: pGold * 0.5, uSilver: 0.5 },
          { prob: (1 - pGold) * 0.28, uGold: Math.min(0.999999, pGold + 0.5 * (1 - pGold)), uSilver: 0.14 },
          { prob: (1 - pGold) * 0.72, uGold: Math.min(0.999999, pGold + 0.5 * (1 - pGold)), uSilver: 0.64 },
        ].filter((x) => x.prob > 0)
        let cumW = 0
        for (let idx = 0; idx < pool.length; idx++) {
          const wThis = weights[idx]
          const uPick = (cumW + wThis * 0.5) / wSum
          cumW += wThis
          const pThisFish = catchP * (wThis / wSum)
          for (const qc of qChoices) {
            const prob = pThisFish * qc.prob
            if (!(prob > 0)) continue
            const step = simulateBatch(refreshed, [action], {
              t: simT,
              prices,
              rand: makeSeqRng([Math.min(0.999999, miss + 0.5 * catchP), uPick, qc.uGold, qc.uSilver]),
            })
            if (!step.allOk) return null
            branches.push({ prob, afterWorld: step.afterWorld, result: step.result })
          }
        }
      }
      return branches.length > 0 ? branches : null
    }

    if (action?.a === 'mine') {
      const pickLv = Number(s.tools?.pick || 1)
      const pickCap = R.PICK_FLOOR?.[pickLv] || 8
      const floor = Math.max(1, Math.min(Number(action.f) || 1, Number(s.mine?.max || 1), pickCap))
      const pool = (R.ORES || []).filter((o) => o.floor <= floor)
      if (!pool.length || s.en < (R.WORLD?.cost?.mine ?? 3)) return null

      const pTwoHits = Math.min(1, Math.max(0, 0.25 + 0.05 * pickLv))
      const pOneHit = 1 - pTwoHits
      const weights = pool.map((o) => o.w * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor) / 40))
      const wSum = weights.reduce((a, b) => a + b, 0)
      if (!(wSum > 0)) return null

      const uForIdx = []
      let cumW = 0
      for (let idx = 0; idx < pool.length; idx++) {
        uForIdx.push((cumW + weights[idx] * 0.5) / wSum)
        cumW += weights[idx]
      }

      const canLadder = floor === Number(s.mine?.max || 1) && Number(s.mine?.max || 1) < pickCap
      const ladderChoices = canLadder
        ? [{ prob: 0.25, u: 0.125 }, { prob: 0.75, u: 0.625 }]
        : [{ prob: 1.0, u: 0.5 }]

      const branches = []
      if (pOneHit > 0) {
        const uHit1 = Math.min(0.999999, pTwoHits + 0.5 * pOneHit)
        for (let i = 0; i < pool.length; i++) {
          const pOre = pOneHit * (weights[i] / wSum)
          for (const lc of ladderChoices) {
            const prob = pOre * lc.prob
            if (!(prob > 0)) continue
            const step = simulateBatch(refreshed, [action], {
              t: simT,
              prices,
              rand: makeSeqRng([uHit1, uForIdx[i], lc.u]),
            })
            if (!step.allOk) return null
            branches.push({ prob, afterWorld: step.afterWorld, result: step.result })
          }
        }
      }
      if (pTwoHits > 0) {
        const uHit2 = pTwoHits * 0.5
        for (let i = 0; i < pool.length; i++) {
          for (let j = i; j < pool.length; j++) {
            const pairMult = i === j ? 1 : 2
            const pPair = pTwoHits * pairMult * (weights[i] / wSum) * (weights[j] / wSum)
            for (const lc of ladderChoices) {
              const prob = pPair * lc.prob
              if (!(prob > 0)) continue
              const step = simulateBatch(refreshed, [action], {
                t: simT,
                prices,
                rand: makeSeqRng([uHit2, uForIdx[i], uForIdx[j], lc.u]),
              })
              if (!step.allOk) return null
              branches.push({ prob, afterWorld: step.afterWorld, result: step.result })
            }
          }
        }
      }
      return branches.length > 0 ? branches : null
    }

    return null
  }

  function advanceTimeOnly(world, toSec, { futurePrices = null } = {}) {
    const cs = syncClock(world?.clockStart)
    const nextWorld = cloneWorld(world)
    const targetSec = Math.max(Number(nextWorld.now || 0), Math.floor(toSec))
    R.refresh(nextWorld.state, targetSec)
    nextWorld.now = targetSec
    nextWorld.nextIsleAt = nextIsleBoundary(targetSec, cs)
    if (futurePrices) nextWorld.prices = { ...futurePrices }
    return nextWorld
  }

  function isPlotWithered(rawPlot, atSec, cs = null) {
    if (!rawPlot || !rawPlot.c || !Number.isFinite(rawPlot.t) || rawPlot.t <= 0) return false
    syncClock(cs)
    if (!graph.cropsById.has(rawPlot.c)) return true
    const evalSec = Math.floor(Number.isFinite(atSec) ? atSec : rawPlot.t)
    const st = R.cropStage(rawPlot, evalSec, false)
    return !st || st.stage === -1
  }

  function expectedHarvestYield(wateredStages = 3, wasStolen = false) {
    const w = Math.max(0, Math.min(3, Number(wateredStages || 0)))
    const pGold = 0.05 + 0.1 * w
    const pSilver = 0.2 + 0.08 * w
    const pNormal = Math.max(0, 1 - pGold - pSilver)
    const stolen = Boolean(wasStolen)
    const expectedUnits = stolen ? 1.0 : (1.3 + 0.08 * w)
    return {
      wateredStages: w,
      wasStolen: stolen,
      expectedUnits,
      probs: [pNormal, pSilver, pGold],
      expectedByQuality: [expectedUnits * pNormal, expectedUnits * pSilver, expectedUnits * pGold],
    }
  }

  // Exact plot maturity & protection unlock across weather segments (rain <-> sun)
  // Server `/api/pet/world/visit/:id` enforces `rules.protect = 1800` (30m) from maturity in the active weather segment.
  function exactPlotTimings(rawPlot, isSprinkledPlot, nowSec, cs = null, opts = {}) {
    if (!rawPlot || !rawPlot.c || !Number.isFinite(rawPlot.t) || rawPlot.t <= 0) return null
    const activeCs = syncClock(cs)
    const crop = graph.cropsById.get(rawPlot.c)
    if (!crop) return null
    const fast = rawPlot.t >= R.ISLE_LAUNCH
    if (!opts?.isAlreadyRipe && fast && !crop.seasons.includes(R.seasonOf(R.isleDay(rawPlot.t)))) {
      return null
    }
    const base = (rawPlot.h && crop.regrow ? crop.regrow * (fast ? 0.8 : 1) : crop.grow) * 60 * (fast ? 0.8 : 1)
    const protectSec = Number.isFinite(opts?.protectSec) ? Math.max(0, opts.protectSec) : 1800
    const g = Number(rawPlot.g || 0)

    // Start from `rawPlot.t` when already ripe (`opts.isAlreadyRipe`) or `rawPlot.t <= nowSec` so cross-weather maturity before `nowSec` is never shifted!
    let cursor = opts?.isAlreadyRipe ? Math.max(0, rawPlot.t) : Math.max(nowSec, rawPlot.t)
    let matureAt = null
    for (let step = 0; step < 32; step++) {
      const iDay = R.isleDay(cursor)
      const isRain = R.weatherOf(iDay) === 1
      const auto = !!(isSprinkledPlot || isRain)
      const totalSeg = Math.max(1, base * (auto ? 0.6 : 1) - g)
      const candMature = Math.max(cursor, Math.ceil(rawPlot.t + totalSeg))
      const segEnd = nextIsleBoundary(cursor, activeCs)
      if (candMature < segEnd) {
        matureAt = candMature
        break
      }
      cursor = Math.max(cursor + 1, segEnd)
    }
    if (matureAt == null) return null
    if (!fast && !crop.seasons.includes(R.seasonOf(R.worldDay(matureAt)))) {
      return null
    }

    let uCursor = opts?.isAlreadyRipe ? Math.max(0, matureAt) : Math.max(nowSec, matureAt)
    let unlockAt = null
    for (let step = 0; step < 32; step++) {
      const iDay = R.isleDay(uCursor)
      const isRain = R.weatherOf(iDay) === 1
      const auto = !!(isSprinkledPlot || isRain)
      const totalSeg = Math.max(1, base * (auto ? 0.6 : 1) - g)
      const candUnlock = Math.max(uCursor, Math.ceil(rawPlot.t + totalSeg + protectSec))
      const segEnd = nextIsleBoundary(uCursor, activeCs)
      if (candUnlock < segEnd) {
        unlockAt = candUnlock
        break
      }
      uCursor = Math.max(uCursor + 1, segEnd)
    }
    if (unlockAt == null) return null
    return { matureAt, unlockAt, protectSec, crop }
  }

  /**
   * Exact server post-harvest plot transition (`rules/pet-world-rules.js:521-524` + `410-412`):
   * - Final harvest or single-harvest crop -> `{ kind: 'empty', nextPlot: null, needsClear: false }`
   * - Remaining regrow starting in valid season -> `{ kind: 'regrow', nextPlot, needsClear: false }`
   * - Remaining regrow starting in invalid season -> `{ kind: 'withered', nextPlot, needsClear: true }`
   */
  function predictPostHarvestPlot(rawPlot, harvestAtSec, cs = null) {
    const activeCs = syncClock(cs)
    const simT = Math.floor(Number(harvestAtSec || 0))
    const crop = rawPlot?.c ? graph.cropsById.get(rawPlot.c) : null
    const nextH = Number(rawPlot?.h || 0) + 1
    const maxTimes = crop?.regrow ? Number(crop.times || 1) : 1
    if (!crop || !crop.regrow || nextH >= maxTimes) {
      return { kind: 'empty', nextPlot: null, needsClear: false, clearEnCost: 0 }
    }
    const nextPlot = { c: crop.id, t: simT, w: 0, g: 0, h: nextH }
    const st = R.cropStage(nextPlot, simT, false)
    if (!st || st.stage === -1) {
      return {
        kind: 'withered',
        nextPlot,
        needsClear: true,
        clearEnCost: R.WORLD?.cost?.clear ?? 1,
      }
    }
    return { kind: 'regrow', nextPlot, needsClear: false, clearEnCost: 0 }
  }

  function simulateStandingPlotLifecycle(rawPlot, {
    nowSec,
    isSprinkled = false,
    clockStart = null,
    cutoffEndSec = -1,
    dryManualWaterStages = 2,
  } = {}) {
    const activeCs = syncClock(clockStart)
    const tStart = Math.floor(Number(nowSec || 0))
    if (!rawPlot || !rawPlot.c) {
      return {
        crop: null,
        initiallyWithered: false,
        harvests: [],
        releaseSec: tStart,
        witheredAtEnd: false,
        needsClearAtEnd: false,
        truncatedByCutoff: false,
        partialProgressAtCutoff: null,
      }
    }
    const crop = graph.cropsById.get(rawPlot.c)
    if (!crop) {
      return {
        crop: null,
        initiallyWithered: true,
        harvests: [],
        releaseSec: tStart,
        witheredAtEnd: true,
        needsClearAtEnd: true,
        truncatedByCutoff: false,
        partialProgressAtCutoff: null,
      }
    }

    const spr = Boolean(isSprinkled)
    const waterCostUnit = R.WORLD?.cost?.water ?? 1
    const harvestCostUnit = R.WORLD?.cost?.harvest ?? 1
    const maxTimes = crop.regrow ? Number(crop.times || 1) : 1
    const harvests = []
    let curPlot = { ...rawPlot }
    let releaseSec = tStart
    let witheredAtEnd = false
    let needsClearAtEnd = false
    let truncatedByCutoff = false
    let partialProgressAtCutoff = null

    for (let guard = 0; guard < maxTimes + 2 && Number(curPlot.h || 0) < maxTimes; guard++) {
      const evalFrom = Math.max(tStart, Number(curPlot.t || tStart))
      if (isPlotWithered(curPlot, evalFrom, activeCs)) {
        releaseSec = evalFrom
        witheredAtEnd = true
        needsClearAtEnd = true
        return {
          crop,
          initiallyWithered: harvests.length === 0,
          harvests,
          releaseSec,
          witheredAtEnd,
          needsClearAtEnd,
          truncatedByCutoff: false,
          partialProgressAtCutoff: null,
        }
      }

      const timing = exactPlotTimings(curPlot, spr, evalFrom, activeCs)
      if (!timing) {
        truncatedByCutoff = true
        releaseSec = cutoffEndSec >= 0 ? cutoffEndSec + 1 : Infinity
        break
      }

      const cycleStartRain = R.weatherOf(R.isleDay(Number(curPlot.t || evalFrom))) === 1
      const harvestRain = R.weatherOf(R.isleDay(timing.matureAt)) === 1
      const autoAtHarvest = spr || harvestRain
      const baseW = Math.max(0, Math.min(3, Number(curPlot.w || 0)))
      const manualWaters = spr || cycleStartRain
        ? 0
        : Math.max(0, Math.min(3, dryManualWaterStages) - baseW)
      const wateredStages = autoAtHarvest ? 3 : Math.min(3, baseW + manualWaters)
      const wasStolen = Boolean(harvests.length === 0 && rawPlot.sv && rawPlot.sv.length > 0)
      const yld = expectedHarvestYield(wateredStages, wasStolen)
      const stepWaterEn = manualWaters * waterCostUnit
      const stepHarvestEn = harvestCostUnit
      const stepEn = stepWaterEn + stepHarvestEn

      if (cutoffEndSec >= 0 && timing.matureAt > cutoffEndSec) {
        if (evalFrom < cutoffEndSec) {
          const cycleOrigin = Number(curPlot.t || evalFrom)
          const denom = Math.max(60, timing.matureAt - cycleOrigin)
          const numer = Math.max(0, cutoffEndSec - cycleOrigin)
          const frac = Math.min(1, numer / denom)
          if (frac > 0) {
            partialProgressAtCutoff = {
              atSec: cutoffEndSec - 1,
              frac,
              wateredStages,
              manualWaters,
              stepEn,
              expectedByQuality: [
                yld.expectedByQuality[0] * frac,
                yld.expectedByQuality[1] * frac,
                yld.expectedByQuality[2] * frac,
              ],
            }
          }
        }
        truncatedByCutoff = true
        releaseSec = cutoffEndSec + 1
        break
      }

      const harvestAt = Math.max(tStart, timing.matureAt)
      const postHarvest = predictPostHarvestPlot(curPlot, harvestAt, activeCs)
      harvests.push({
        h: Number(curPlot.h || 0),
        startSec: Number(curPlot.t || tStart),
        matureAt: harvestAt,
        unlockAt: timing.unlockAt,
        wateredStages,
        manualWaters,
        stepWaterEn,
        stepHarvestEn,
        stepEn,
        expectedUnits: yld.expectedUnits,
        expectedByQuality: yld.expectedByQuality,
        postHarvest,
      })
      releaseSec = harvestAt

      if (postHarvest.kind === 'empty') {
        witheredAtEnd = false
        needsClearAtEnd = false
        break
      }
      if (postHarvest.kind === 'withered') {
        witheredAtEnd = true
        needsClearAtEnd = true
        break
      }
      curPlot = postHarvest.nextPlot
    }

    return {
      crop,
      initiallyWithered: false,
      harvests,
      releaseSec,
      witheredAtEnd,
      needsClearAtEnd,
      truncatedByCutoff,
      partialProgressAtCutoff,
    }
  }

  const cropLifecycleMemo = new Map()

  function simulateCropLifecycleFromPlant(cropOrId, {
    startSec,
    isSprinkled = false,
    clockStart = null,
    cutoffEndSec = -1,
    dryManualWaterStages = 2,
  } = {}) {
    const activeCs = syncClock(clockStart)
    const crop = typeof cropOrId === 'string' ? graph.cropsById.get(cropOrId) : cropOrId
    if (!crop) return null
    const t0 = Math.floor(Number(startSec || 0))
    const cutoff = cutoffEndSec >= 0 ? Math.floor(Number(cutoffEndSec)) : -1
    const spr = Boolean(isSprinkled)
    const dryW = Math.max(0, Math.min(3, Math.floor(Number(dryManualWaterStages ?? 2))))

    if (cropLifecycleMemo.size > 16384) cropLifecycleMemo.clear()
    const key = `${activeCs}:${spr ? 1 : 0}:${t0}:${cutoff}:${dryW}:${crop.id}`
    const cached = cropLifecycleMemo.get(key)
    if (cached !== undefined) return cached

    if (!crop.seasons.includes(R.seasonOf(R.isleDay(t0)))) {
      cropLifecycleMemo.set(key, null)
      return null
    }

    const standing = simulateStandingPlotLifecycle(
      { c: crop.id, t: t0, w: 0, g: 0, h: 0 },
      {
        nowSec: t0,
        isSprinkled: spr,
        clockStart: activeCs,
        cutoffEndSec: cutoff,
        dryManualWaterStages: dryW,
      }
    )

    if (!standing || standing.harvests.length === 0) {
      cropLifecycleMemo.set(key, null)
      return null
    }

    const plantEnCost = R.WORLD?.cost?.plant ?? 2
    const endClearEnCost = standing.needsClearAtEnd ? (R.WORLD?.cost?.clear ?? 1) : 0
    let careAndHarvestEn = 0
    let totalExpectedUnits = 0
    for (const hv of standing.harvests) {
      careAndHarvestEn += hv.stepEn
      totalExpectedUnits += hv.expectedUnits
    }
    const totalPlantAndCareEn = plantEnCost + careAndHarvestEn
    const totalStaminaSpent = totalPlantAndCareEn + endClearEnCost
    const endSec = standing.harvests[standing.harvests.length - 1].matureAt
    const occupiedSec = Math.max(60, endSec - t0)

    const res = {
      crop,
      harvests: standing.harvests,
      endSec,
      occupiedSec,
      seedCost: Number(crop.seed || 0),
      plantEnCost,
      careAndHarvestEn,
      totalPlantAndCareEn,
      endClearEnCost,
      totalStaminaSpent,
      totalExpectedUnits,
      witheredAtEnd: standing.witheredAtEnd,
      needsClearAtEnd: standing.needsClearAtEnd,
      truncatedByCutoff: standing.truncatedByCutoff,
    }
    cropLifecycleMemo.set(key, res)
    return res
  }

  // Exact barn production & stealable unlock (cap >= 2 required for visitor steal; server `rules.protect = 1800`)
  function exactBarnTimings(rawPen, nowSec, cs = null, opts = {}) {
    if (!rawPen || !rawPen.k) return null
    syncClock(cs)
    const def = graph.animalsById.get(rawPen.k)
    if (!def) return null
    const protectSec = Number.isFinite(opts?.protectSec) ? Math.max(0, opts.protectSec) : 1800
    const age = R.b12AnimalStage(rawPen, nowSec)
    const st = R.animalReady(rawPen, nowSec)
    const untilMax = Math.min((rawPen.f || 0) + 86400, age.retireAt || Infinity)

    let nextOwnUnitAt = null
    if (!age.retired && st.n < def.cap) {
      const period = R.b12AnimalPeriod(rawPen.k, st.nextP)
      const cand = st.nextP + period
      if (cand <= untilMax) nextOwnUnitAt = cand
    }

    // Steal timing: rule requires leaving >= 1 unit to owner, so cap < 2 can never be stolen
    let stealUnlockAt = null
    if (def.cap >= 2 && !(rawPen.sv && rawPen.sv.length >= 2)) {
      const growDays = R.B12_GROW_DAYS?.[rawPen.k] || 2
      const adultAt = (Number.isSafeInteger(rawPen.born) && typeof R.b12AfterActive === 'function')
        ? R.b12AfterActive(rawPen.born, growDays * (R.ISLE_SPAN || 14400))
        : 0
      let cursor = Math.max(rawPen.p || 0, adultAt)
      const heldCount = Array.isArray(rawPen.held) ? Math.min(def.cap, rawPen.held.length) : 0
      let count = heldCount
      let firstReady = count >= 1 ? (rawPen.heldAt || cursor) : 0
      let secondReady = count >= 2 ? (rawPen.heldAt || cursor) : 0
      while (count < 2) {
        const per = R.b12AnimalPeriod(rawPen.k, cursor)
        if (!(per > 0)) break
        const end = cursor + per
        if (end > untilMax) break
        count++
        if (count === 1) firstReady = end
        if (count === 2) secondReady = end
        cursor = end
      }
      if (secondReady > 0) {
        if (st.n >= 2) {
          stealUnlockAt = Math.ceil(Math.max(secondReady, firstReady) + protectSec)
        } else if (!age.retired && nowSec < untilMax) {
          stealUnlockAt = Math.ceil(Math.max(secondReady, firstReady > 0 ? firstReady + protectSec : 0))
        }
      }
    }

    return {
      readyCount: st.n,
      qualities: st.qualities,
      fed: st.fed,
      retired: age.retired,
      hungryAt: age.retired ? null : rawPen.f + 86400,
      canFeedAt: age.retired ? null : rawPen.f + 8 * 3600,
      nextOwnUnitAt,
      stealUnlockAt,
    }
  }

  return {
    R,
    rulesHash,
    rulesSourceText,
    clockStart: effectiveClockStart,
    graph,
    syncClock,
    cloneWorld,
    nextNaturalDayBoundary,
    nextLongNightEvent,
    nextIsleBoundary,
    nextSeasonBoundary,
    availableInv,
    availableInvSnapshot,
    deterministicPriceBase,
    quoteWithSupplyFactor,
    quoteAtSoldVolume,
    saleNetQuote,
    cropSellBatchQuote,
    isStochasticAction,
    makeDeterministicPrng,
    makeSampleStreamPrng,
    listDeterministicEdibleSpecs,
    simulateBatch,
    enumerateExactSingleStochasticOutcomes,
    advanceTimeOnly,
    isPlotWithered,
    expectedHarvestYield,
    exactPlotTimings,
    predictPostHarvestPlot,
    simulateStandingPlotLifecycle,
    simulateCropLifecycleFromPlant,
    exactBarnTimings,
  }
}

export async function loadRulesAdapterFromFile(rulesFilePath, { clockStart = 0 } = {}) {
  const abs = path.resolve(rulesFilePath)
  const sourceText = fs.readFileSync(abs, 'utf8')
  const mod = await import(pathToFileURL(abs).href)
  return createRulesAdapter(mod, { clockStart, rulesSourceText: sourceText })
}
