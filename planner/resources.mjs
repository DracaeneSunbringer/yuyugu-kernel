export function buildEventBuckets(adapter, world, {
  horizonSec = 6 * 14400,
  deterministicArrivals = [],
  maxBuckets = 20,
  coalesceWindowSec = 5,
  preservePrefixThroughSec = null,
  prefixMaxBuckets = null,
} = {}) {
  const { R, graph } = adapter
  adapter.syncClock(world?.clockStart)
  const t0 = Math.floor(Number(world?.now || 0))
  const tEnd = t0 + Math.max(0, Math.floor(horizonSec))
  const state = world?.state || {}

  const rawPoints = new Map()
  const addPoint = (at, reason, hardBoundary = false) => {
    const sec = Math.floor(Number(at))
    if (!Number.isFinite(sec) || sec < t0 || sec > tEnd) return
    const prev = rawPoints.get(sec)
    if (!prev) {
      rawPoints.set(sec, { atSec: sec, reasons: new Set([reason]), hardBoundary: !!hardBoundary })
    } else {
      prev.reasons.add(reason)
      if (hardBoundary) prev.hardBoundary = true
    }
  }

  addPoint(t0, 'now', true)

  // 1. Natural-day boundaries (00:00 UTC+8)
  let ndCursor = t0
  for (let i = 0; i < 16; i++) {
    const nextNd = adapter.nextNaturalDayBoundary(ndCursor)
    if (nextNd > tEnd || nextNd <= ndCursor) break
    addPoint(nextNd, 'natural-day-reset', true)
    ndCursor = nextNd
  }

  // 2. Isle-day boundaries (4h active clock, respecting 22:00-08:00 freeze)
  let idCursor = t0
  for (let i = 0; i < 32; i++) {
    const nextId = adapter.nextIsleBoundary(idCursor, world?.clockStart)
    if (nextId > tEnd || nextId <= idCursor) break
    if (i === 0 && nextId - t0 >= 5400) {
      addPoint(nextId - 60, 'pre-isle-regen-flush', false)
    }
    addPoint(nextId, 'isle-day-reset', true)
    idCursor = nextId
  }

  // 3. Long-night transitions
  const startIsleIndex = R.isleIndex(t0)
  let lnCursor = t0
  for (let i = 0; i < 16; i++) {
    const ev = adapter.nextLongNightEvent(lnCursor)
    if (!ev || ev.at > tEnd || ev.at <= lnCursor) break
    if (ev.kind === 'long-night-end' && R.isleIndex(ev.at - 1) === startIsleIndex && ev.at - lnCursor >= 5 * 3600) {
      addPoint(Math.floor(0.5 * (lnCursor + ev.at)), 'long-night-mid-regen', false)
    }
    addPoint(ev.at, ev.kind, true)
    lnCursor = ev.at
  }

  // 4. Standing plot maturity times
  for (let i = 0; i < (state.plots?.length || 0); i++) {
    const p = state.plots[i]
    if (!p || !p.c) continue
    const timing = adapter.exactPlotTimings(p, R.sprinkled(state, i), t0, world?.clockStart)
    if (timing && timing.matureAt > t0 && timing.matureAt <= tEnd) {
      addPoint(timing.matureAt, `plot-mature:${i}`, false)
    }
  }

  // 5. Barn production & feedable times
  for (let i = 0; i < (state.barn?.length || 0); i++) {
    const pen = state.barn[i]
    if (!pen || !pen.k) continue
    const bt = adapter.exactBarnTimings(pen, t0, world?.clockStart)
    if (!bt) continue
    if (bt.nextOwnUnitAt && bt.nextOwnUnitAt > t0 && bt.nextOwnUnitAt <= tEnd) {
      addPoint(bt.nextOwnUnitAt, `barn-ready:${i}`, false)
    }
    if (bt.hungryAt && bt.hungryAt > t0 && bt.hungryAt <= tEnd) {
      addPoint(bt.hungryAt, `barn-hungry:${i}`, false)
    }
  }

  // 6. Explicit deterministic arrivals (for exact reference & synthetic timing scenarios)
  for (const arr of deterministicArrivals || []) {
    if (Number.isFinite(arr?.atSec) && arr.atSec >= t0 && arr.atSec <= tEnd) {
      addPoint(Math.floor(arr.atSec), 'deterministic-arrival', true)
    }
  }

  // 7. Dynamic fish time-window openings within current/next isle days (derived purely from R.FISH.hours)
  const maxRod = Number(state.tools?.rod || 1)
  const windowHours = new Set()
  for (const f of R.FISH || []) {
    if (f.rod <= maxRod && Array.isArray(f.hours) && (f.hours[0] > 0 || f.hours[1] < 24)) {
      windowHours.add(f.hours[0] % 24)
      windowHours.add(f.hours[1] % 24)
    }
  }
  if (windowHours.size > 0 && horizonSec > 0) {
    // Each isle hour in active time is ISLE_SPAN / 24 = 600s
    const secPerIsleHour = Math.max(60, Math.floor((R.ISLE_SPAN || 14400) / 24))
    let probe = t0 + secPerIsleHour
    let prevHour = R.isleHour(t0)
    while (probe <= Math.min(tEnd, t0 + 2 * (R.ISLE_SPAN || 14400))) {
      const h = R.isleHour(probe)
      if (h !== prevHour && windowHours.has(h)) {
        addPoint(probe, `fish-hour:${h}`, false)
      }
      prevHour = h
      probe += secPerIsleHour
    }
  }

  const sorted = [...rawPoints.values()].sort((a, b) => a.atSec - b.atSec)

  // Coalesce close soft events without ever merging across naturalDay or isleIndex boundaries
  const merged = []
  for (const pt of sorted) {
    if (merged.length === 0) {
      merged.push(pt)
      continue
    }
    const prev = merged[merged.length - 1]
    const sameNd = R.worldDay(prev.atSec) === R.worldDay(pt.atSec)
    const sameId = R.isleIndex(prev.atSec) === R.isleIndex(pt.atSec)
    if (!pt.hardBoundary && !prev.hardBoundary && sameNd && sameId && pt.atSec - prev.atSec <= coalesceWindowSec) {
      for (const r of pt.reasons) prev.reasons.add(r)
      prev.atSec = pt.atSec
    } else {
      merged.push(pt)
    }
  }

  // Respect maxBuckets while strictly keeping t0, all hard boundaries up to maxBuckets, and earliest soft events.
  // When `preservePrefixThroughSec` is set (e.g. rolling-horizon stability extension `H -> H + ΔH`),
  // preserve the exact bucket selection on `[t0, preservePrefixThroughSec]` first so extending `H` never evicts near-term trunk events!
  const selectWithinCap = (pts, cap) => {
    if (pts.length <= cap) return pts
    const hard = pts.filter((p) => p.atSec === t0 || p.hardBoundary)
    if (hard.length >= cap) return hard.slice(0, cap)
    const soft = pts.filter((p) => p.atSec !== t0 && !p.hardBoundary)
    const keepSoft = soft.slice(0, cap - hard.length)
    return [...hard, ...keepSoft].sort((a, b) => a.atSec - b.atSec)
  }

  let selected
  if (Number.isFinite(preservePrefixThroughSec) && preservePrefixThroughSec > t0 && preservePrefixThroughSec < tEnd) {
    const pCap = Number.isFinite(prefixMaxBuckets) && prefixMaxBuckets > 0
      ? Math.min(maxBuckets, Math.floor(prefixMaxBuckets))
      : maxBuckets
    const prefixPts = merged.filter((p) => p.atSec <= preservePrefixThroughSec)
    const tailPts = merged.filter((p) => p.atSec > preservePrefixThroughSec)
    const keptPrefix = selectWithinCap(prefixPts, pCap)
    const remCap = Math.max(0, maxBuckets - keptPrefix.length)
    const keptTail = remCap > 0 ? selectWithinCap(tailPts, remCap) : []
    selected = [...keptPrefix, ...keptTail]
  } else {
    selected = selectWithinCap(merged, maxBuckets)
  }

  const baseIsleIdx = R.isleIndex(t0)
  const arrivalsBySec = new Map()
  for (const arr of deterministicArrivals || []) {
    const sec = Math.floor(Number(arr.atSec))
    if (!arrivalsBySec.has(sec)) arrivalsBySec.set(sec, [])
    for (const item of arr.items || []) {
      arrivalsBySec.get(sec).push({ id: item.id, q: Number(item.q || 0), n: Number(item.n || 0) })
    }
  }

  const buckets = selected.map((pt, idx) => {
    const nextAtSec = idx + 1 < selected.length ? selected[idx + 1].atSec : tEnd
    const isleIdx = R.isleIndex(pt.atSec)
    const isleDayOffset = Math.max(0, isleIdx - baseIsleIdx)
    return {
      index: idx,
      atSec: pt.atSec,
      nextAtSec,
      durationSec: Math.max(0, nextAtSec - pt.atSec),
      naturalDay: R.worldDay(pt.atSec),
      isleIndex: isleIdx,
      isleDay: R.isleDay(pt.atSec),
      isleDayOffset,
      season: R.seasonOf(R.isleDay(pt.atSec)),
      weather: R.weatherOf(R.isleDay(pt.atSec)),
      isLongNight: typeof R.b12IsLongNight === 'function' ? R.b12IsLongNight(pt.atSec) : false,
      // Non-anticipativity observation node: all buckets before first isle-day boundary share 'trunk'
      isTrunkBeforePriceReveal: isleDayOffset === 0,
      reasons: [...pt.reasons],
      exogenousArrivalsAtStart: pt.atSec === t0
        ? []
        : (arrivalsBySec.get(pt.atSec) || []),
    }
  })

  // Also capture any exogenous arrivals at t0 itself
  if (buckets.length > 0 && arrivalsBySec.has(t0)) {
    buckets[0].exogenousArrivalsAtStart = arrivalsBySec.get(t0)
  }

  return {
    t0,
    tEnd,
    horizonSec: tEnd - t0,
    buckets,
  }
}

export function applyExogenousArrivals(world, arrivals = []) {
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

/**
 * Simulates how crafting `qty` of `recipe` deducts low-star-first (`q0 -> q1 -> q2`) from available inventory `availInv`.
 * Returns `{ feasible: true, deducted: { [id]: [n0, n1, n2] }, nextInv }` or `{ feasible: false }`.
 */
export function deductRecipeLowStarFirst(availInv, recipe, qty = 1) {
  const n = Math.floor(Number(qty))
  if (!(n >= 1)) return { feasible: false }
  const nextInv = {}
  for (const [k, v] of Object.entries(availInv)) nextInv[k] = [v[0] || 0, v[1] || 0, v[2] || 0]
  const deducted = {}

  for (const [inId, perUnit] of Object.entries(recipe.in || {})) {
    let need = perUnit * n
    const row = nextInv[inId] || [0, 0, 0]
    if (row[0] + row[1] + row[2] < need) return { feasible: false }
    deducted[inId] = [0, 0, 0]
    for (let q = 0; q < 3 && need > 0; q++) {
      const take = Math.min(need, row[q])
      if (take > 0) {
        row[q] -= take
        deducted[inId][q] += take
        need -= take
      }
    }
    nextInv[inId] = row
  }

  nextInv[recipe.id] ||= [0, 0, 0]
  nextInv[recipe.id][0] += n
  return { feasible: true, deducted, nextInv }
}

export function expectedHarvestYield(adapter, wateredStages = 3, wasStolen = false) {
  // Exact rule expectation from pet-world-rules.js:509-515:
  // gold = 0.05 + 0.1 * w, silver = 0.2 + 0.08 * w, q0 = 1 - gold - silver
  // n = 1 + (rand < 0.3 + 0.08 * w ? 1 : 0) minus 1 if stolen (clamped >= 1 -> always 1 when stolen!)
  const w = Math.max(0, Math.min(3, wateredStages))
  const pGold = 0.05 + 0.1 * w
  const pSilver = 0.2 + 0.08 * w
  const pNormal = Math.max(0, 1 - pGold - pSilver)
  const expectedUnits = wasStolen ? 1.0 : (1.0 + (0.3 + 0.08 * w))
  return {
    expectedUnits,
    probs: [pNormal, pSilver, pGold],
    expectedByQuality: [expectedUnits * pNormal, expectedUnits * pSilver, expectedUnits * pGold],
  }
}

export function expectedMineYieldPerHit(adapter, state, isleDayStr) {
  const { R } = adapter
  const pickLv = Number(state?.tools?.pick || 1)
  const floor = Math.max(1, Math.min(Number(state?.mine?.max || 1), R.PICK_FLOOR?.[pickLv] || 8))
  const weather = R.weatherOf(isleDayStr)
  const pool = (R.ORES || []).filter((o) => o.floor <= floor)
  if (!pool.length) return { floor, expectedHits: 0, byOre: {} }
  const weights = pool.map((o) => o.w * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor) / 40))
  const wSum = weights.reduce((a, b) => a + b, 0)
  const expectedHits = 1 + (0.25 + 0.05 * pickLv)
  const byOre = {}
  pool.forEach((o, i) => {
    byOre[o.id] = expectedHits * (weights[i] / wSum)
  })
  return { floor, expectedHits, byOre }
}

export function expectedBombYield(adapter, state, isleDayStr) {
  const { R } = adapter
  const pickLv = Number(state?.tools?.pick || 1)
  const floor = Math.max(1, Math.min(Number(state?.mine?.max || 1), R.PICK_FLOOR?.[pickLv] || 8))
  const weather = R.weatherOf(isleDayStr)
  const pool = (R.ORES || []).filter((o) => o.floor <= floor)
  if (!pool.length) return { floor, expectedDrops: 0, byOre: {} }
  const weights = pool.map(
    (o) => o.w * (o.price >= 7000 ? 1.35 : 1) * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor) / 40)
  )
  const wSum = weights.reduce((a, b) => a + b, 0)
  const expectedDrops = 6 + 2 * (0.3 + 0.05 * pickLv)
  const byOre = {}
  pool.forEach((o, i) => {
    byOre[o.id] = expectedDrops * (weights[i] / wSum)
  })
  return { floor, expectedDrops, byOre }
}

export function expectedFishYieldPerCast(adapter, state, atSec, useBait = false) {
  const { R } = adapter
  const rodLv = Number(state?.tools?.rod || 1)
  const iDay = R.isleDay(atSec)
  const weather = R.weatherOf(iDay)
  const pool = R.fishPool(state, atSec, rodLv)
  if (!pool || pool.length === 0) return { catchProb: 0, byFish: {} }
  const miss = Math.max(0.05, 0.22 - 0.04 * rodLv - (useBait ? 0.08 : 0) - (weather === 1 ? 0.05 : 0))
  const catchProb = 1 - miss
  const boost = (useBait ? 2 : 1) * (weather === 1 ? 1.5 : 1)
  const weights = pool.map((f) => f.w * (f.price >= 9000 ? boost : 1))
  const wSum = weights.reduce((a, b) => a + b, 0)
  const pGold = 0.08 + 0.05 * rodLv
  const pSilver = (1 - pGold) * 0.28
  const pNormal = Math.max(0, 1 - pGold - pSilver)
  const byFish = {}
  pool.forEach((f, idx) => {
    const pFish = catchProb * (weights[idx] / wSum)
    byFish[f.id] = [pFish * pNormal, pFish * pSilver, pFish * pGold]
  })
  return { catchProb, byFish }
}
