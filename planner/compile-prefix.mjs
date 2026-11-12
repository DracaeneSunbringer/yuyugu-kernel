const INDEPENDENT_POST_COLLECTION_ACTIONS = new Set([
  'harvest',
  'collect',
  'trap',
  'clear',
  'water',
  'feed',
  'pet',
  'goal',
])

/**
 * Computes the causally safe executable prefix from `rawDomestic`:
 * - All deterministic actions before the first stochastic action are included up to `maxBatch`.
 * - Multiple mutually-independent mature plot `harvest`s, `collect`s, `trap`s, and field care (`clear`/`water`/`feed`/`pet`/`goal`)
 *   batch together in a SINGLE `POST /api/pet/world/act` (`<= 40`), truncating ONLY when a downstream action
 *   would consume or depend on unobserved stochastic yields (`sell`/`craft`/`eat`/`stockBuy`/`plant` needing harvest drops)
 *   or after a single stamina-extraction stochastic action (`fish`/`mine`/`bomb`/`npc`/`scratch`).
 */
export function computeCausalStochasticPrefix(adapter, worldBefore, rawDomestic = [], maxBatch = 40) {
  const capped = rawDomestic.slice(0, maxBatch)
  const truncatedByBatchLimit = rawDomestic.length > maxBatch
  let containsStochasticAction = false
  let stochasticTriggerAction = null
  let seenCollectionStoch = false
  const taintedItems = new Set()
  let taintedAll = false
  let endIdx = capped.length

  const recipeTouchesTainted = (recId, seen = new Set()) => {
    if (taintedAll) return true
    if (seen.has(recId)) return false
    seen.add(recId)
    const rec = adapter.graph?.recipesById?.get(recId)
    if (!rec?.in) return false
    for (const inId of Object.keys(rec.in)) {
      if (taintedItems.has(inId) || recipeTouchesTainted(inId, seen)) return true
    }
    return false
  }

  for (let i = 0; i < capped.length; i++) {
    const act = capped[i]
    const isStoch = adapter.isStochasticAction(act)

    if (!containsStochasticAction) {
      if (isStoch) {
        containsStochasticAction = true
        stochasticTriggerAction = act.a
        if (act.a === 'harvest') {
          seenCollectionStoch = true
          const cId = worldBefore?.state?.plots?.[act.i]?.c
          if (cId) {
            taintedItems.add(cId)
            taintedItems.add(`sd_${cId}`)
          } else {
            taintedAll = true
          }
        } else if (act.a === 'trap') {
          seenCollectionStoch = true
          for (const f of adapter.R?.FISH || []) taintedItems.add(f.id)
        } else {
          // Single stamina extraction (`fish`, `mine`, `bomb`, `npc`, `scratch`): include this action and stop after it
          endIdx = i + 1
          break
        }
      }
      continue
    }

    // Already inside a collection-stochastic batch (`seenCollectionStoch === true`):
    if (INDEPENDENT_POST_COLLECTION_ACTIONS.has(act.a)) {
      if (act.a === 'harvest') {
        const cId = worldBefore?.state?.plots?.[act.i]?.c
        if (cId) {
          taintedItems.add(cId)
          taintedItems.add(`sd_${cId}`)
        } else {
          taintedAll = true
        }
      } else if (act.a === 'trap') {
        for (const f of adapter.R?.FISH || []) taintedItems.add(f.id)
      }
      continue
    }

    // Check if a deterministic action neither consumes tainted items nor re-allocates working capital post-harvest
    if (act.a === 'sell' || act.a === 'eat') {
      if (!taintedAll && !taintedItems.has(act.id)) continue
    } else if (act.a === 'craft') {
      if (!recipeTouchesTainted(act.id)) continue
    }

    // Any downstream action depending on unobserved harvest yield/bonus-seeds (`plant` of harvested crop,
    // `stockBuy`, `sell`/`craft`/`eat` of harvested crop, or switching to `mine`/`fish`/`bomb`) waits for receipt!
    endIdx = i
    break
  }

  const prefix = capped.slice(0, endIdx)
  const truncatedAfterStochastic = containsStochasticAction && endIdx < rawDomestic.length
  if (truncatedAfterStochastic) {
    while (
      prefix.length > 0 &&
      (prefix[prefix.length - 1].a === 'eat' || prefix[prefix.length - 1].a === 'coffee')
    ) {
      prefix.pop()
    }
  }
  return {
    prefix,
    containsStochasticAction,
    truncatedAfterStochastic,
    truncatedByBatchLimit: endIdx === capped.length && truncatedByBatchLimit,
    stochasticTriggerAction,
  }
}

const URGENT_TRANSITION_SAFE_ACTIONS = new Set([
  'harvest',
  'collect',
  'trap',
  'clear',
  'water',
  'feed',
  'pet',
  'goal',
])

/**
 * Computes the earliest wall-clock timestamp `> atSec` at which a domestic physical event
 * transitions without `world.rev` advancing (plot maturity, manual-water stage end,
 * barn production/hunger/feed cooldown/retirement, trap ready, active buff expiry,
 * natural-day or isle-day reset, or planned wake).
 *
 * NOTE: Already-ripe plot `unlockAt` (visitor steal-protection expiry) is intentionally NOT
 * a domestic invalidation transition — our own `harvest` legality, cost, and yield are invariant
 * across `unlockAt`, so crossing `unlockAt` must never abort an in-flight harvest!
 */
export function computeEarliestDomesticTransitionSec(adapter, world, plannedWakeSec = null) {
  const { R } = adapter
  const atSec = Math.floor(Number(world?.now || 0))
  const cs = world?.clockStart ?? null
  adapter.syncClock?.(cs)

  let earliest = Infinity
  const consider = (t) => {
    if (Number.isFinite(t)) {
      const ft = Math.floor(t)
      if (ft > atSec && ft < earliest) earliest = ft
    }
  }

  consider(adapter.nextIsleBoundary?.(atSec, cs))
  consider(adapter.nextNaturalDayBoundary?.(atSec))
  if (Number.isFinite(plannedWakeSec)) consider(plannedWakeSec)

  const s = world?.state
  if (!s) return earliest

  const iDay = R.isleDay(atSec)
  const weather = R.weatherOf(iDay)

  for (let i = 0; i < (s.plotN || s.plots?.length || 0); i++) {
    const p = s.plots?.[i]
    if (!p) continue
    const isSpr = R.sprinkled(s, i)
    const auto = isSpr || weather === 1
    const st = R.cropStage(p, atSec, auto)
    if (st.stage >= 0 && st.stage < 3) {
      const timing = adapter.exactPlotTimings?.(p, isSpr, atSec, cs)
      if (timing?.matureAt) consider(timing.matureAt)
      if (!auto && p.w <= st.stage) {
        const stageEndSec = Number(p.t || atSec) + Math.ceil((Number(st.total || 3600) * (st.stage + 1)) / 3)
        consider(stageEndSec)
      }
    }
  }

  for (let i = 0; i < (s.barn?.length || 0); i++) {
    const pen = s.barn[i]
    if (!pen) continue
    const age = R.b12AnimalStage(pen, atSec)
    if (age?.retired) continue
    if (Number.isFinite(age?.retireAt)) consider(age.retireAt)
    const bt = adapter.exactBarnTimings?.(pen, atSec, cs)
    if (bt?.nextOwnUnitAt) consider(bt.nextOwnUnitAt)
    consider(Number(pen.f || 0) + 8 * 3600)
    consider(Number(pen.f || 0) + 86400)
  }

  for (let i = 0; i < (s.traps?.length || 0); i++) {
    const tr = R.trapReady(s.traps[i], atSec, weather === 2)
    if (!(tr?.n > 0) && Number(tr?.left) > 0) {
      consider(atSec + Math.ceil(tr.left))
    }
  }

  if (s.buffs && typeof s.buffs === 'object') {
    for (const exp of Object.values(s.buffs)) {
      if (Number.isFinite(Number(exp))) consider(Number(exp))
    }
  }

  return earliest
}

/**
 * When a lateral transition occurred during `(at0, nowW]` (e.g. a neighboring plot matured
 * while the planner was computing), discretionary resource-competing actions (`mine`, `fish`, `bomb`,
 * `sell`, `craft`, `buy`, `stockBuy`, `plant`, `visit`, and surplus `eat`/`coffee`) must be withheld
 * for fresh re-optimization, while non-regretful urgent collection/care actions (`harvest`, `collect`,
 * `trap`, `pet`, `goal`, `clear`, `water`, `feed`) that remain legal and respect BOTH `staminaReserveFloor`
 * AND the planner's committed post-bucket stamina floor (`plannedPostBucketEnFloor`) are preserved.
 *
 * Strictly pulls ONLY the minimal prefix of *already-planned* `eat`/`coffee` actions in `prefix`
 * needed for those salvaged urgent actions (zero economic food selection in `compile-prefix.mjs`!).
 */
function extractTransitionSafeUrgentPrefix(adapter, worldBefore, prefix, plan = null) {
  const candidateUrgent = prefix.filter((act) => URGENT_TRANSITION_SAFE_ACTIONS.has(act?.a))
  if (candidateUrgent.length === 0) return []

  const plannedTopUps = prefix.filter((act) => act?.a === 'eat' || act?.a === 'coffee')
  const constraints = plan?.constraints || {}
  const nowW = Math.floor(Number(worldBefore?.now || 0))
  const userReserveFloor = Number(constraints?.staminaReserveFloor || 0) > 0 && nowW < Number(constraints?.staminaReserveUntilSec || 0)
    ? Math.max(0, Math.floor(Number(constraints.staminaReserveFloor || 0)))
    : 0

  let adjustedPlannedFloor = 0
  const committedRaids = Array.isArray(plan?.committedUpcomingRaids) ? plan.committedUpcomingRaids : []
  let earliestCommittedRaidSec = Infinity
  for (const r of committedRaids) {
    const uSec = Math.floor(Number(r?.unlockAtSec))
    if (Number.isFinite(uSec) && nowW < uSec && uSec < earliestCommittedRaidSec) {
      earliestCommittedRaidSec = uSec
    }
  }
  const rawPlannedFloor0 = Math.max(0, Math.floor(Number(plan?.trunkBuckets?.[0]?.plannedPostBucketEnFloor || 0)))
  if (Number.isFinite(earliestCommittedRaidSec) && rawPlannedFloor0 > 0) {
    const at0 = Math.floor(Number(plan?.trunkBuckets?.[0]?.atSec ?? nowW))
    const regenEvery = Math.max(1, Number(adapter.R?.WORLD?.regen || 180))
    const plannedAtEnT = Number.isFinite(Number(plan?.trunkBuckets?.[0]?.plannedAtEnT))
      ? Math.floor(Number(plan.trunkBuckets[0].plannedAtEnT))
      : at0
    const refNow = adapter.advanceTimeOnly(worldBefore, nowW)
    const nowEnT = Math.max(nowW - regenEvery, Math.floor(Number(refNow.state?.enT ?? nowW)))
    const remRegenAt0 = Math.max(0, Math.floor((earliestCommittedRaidSec - plannedAtEnT) / regenEvery))
    const remRegenNow = Math.max(0, Math.floor((earliestCommittedRaidSec - nowEnT) / regenEvery))
    const passiveTicksElapsed = Math.max(0, remRegenAt0 - remRegenNow)
    const rawCap = Number(adapter.R.energyMax(refNow.state))
    const enMax = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : 100
    adjustedPlannedFloor = Math.min(enMax, rawPlannedFloor0 + passiveTicksElapsed)
  }
  const effectiveFloor = Math.max(userReserveFloor, adjustedPlannedFloor)

  const salvagedBatch = []
  let urgentCount = 0
  let topUpCursor = 0
  let simWorld = worldBefore
  const pricesNow = worldBefore?.prices || {}

  for (const act of candidateUrgent) {
    const directStep = adapter.simulateBatch(simWorld, [act], {
      t: nowW,
      prices: pricesNow,
    })
    const directOk = directStep.result?.out?.[0]?.ok === true
    const directAfterEn = Math.floor(Number(directStep.afterWorld?.state?.en || 0))
    if (directOk && directAfterEn >= effectiveFloor) {
      salvagedBatch.push(act)
      simWorld = directStep.afterWorld
      urgentCount++
      continue
    }

    if (topUpCursor < plannedTopUps.length) {
      let tryWorld = simWorld
      for (let tryIdx = topUpCursor; tryIdx < plannedTopUps.length; tryIdx++) {
        const topStep = adapter.simulateBatch(tryWorld, [plannedTopUps[tryIdx]], {
          t: nowW,
          prices: pricesNow,
        })
        if (topStep.result?.out?.[0]?.ok !== true) break
        tryWorld = topStep.afterWorld

        const actStep = adapter.simulateBatch(tryWorld, [act], {
          t: nowW,
          prices: pricesNow,
        })
        const actOk = actStep.result?.out?.[0]?.ok === true
        const actAfterEn = Math.floor(Number(actStep.afterWorld?.state?.en || 0))
        if (actOk && actAfterEn >= effectiveFloor) {
          for (let k = topUpCursor; k <= tryIdx; k++) {
            salvagedBatch.push(plannedTopUps[k])
          }
          salvagedBatch.push(act)
          topUpCursor = tryIdx + 1
          simWorld = actStep.afterWorld
          urgentCount++
          break
        }
      }
    }
  }

  return urgentCount > 0 ? salvagedBatch : []
}

export function compileExecutablePrefix(adapter, worldBefore, plan, options = {}) {
  if (!plan || !Array.isArray(plan.trunkBuckets) || plan.trunkBuckets.length === 0) {
    return {
      status: 'plan-invalid',
      failedIndex: -1,
      failedAction: null,
      failedReason: 'missing-trunk-bucket',
      domesticBatch: [],
      visitOperations: [],
      truncatedAfterStochastic: false,
      truncatedByTransition: false,
    }
  }

  const bucket0 = plan.trunkBuckets[0]
  const at0 = Math.floor(Number(bucket0.atSec))
  const nowW = Math.floor(Number(worldBefore?.now || 0))
  const maxClockDriftSec =
    options.maxClockDriftSec === undefined || options.maxClockDriftSec === null
      ? Infinity
      : Math.max(0, Number(options.maxClockDriftSec))
  const clockDrift = nowW - at0
  if (clockDrift < 0 || clockDrift > maxClockDriftSec) {
    return {
      status: 'plan-invalid',
      failedIndex: -1,
      failedAction: null,
      failedReason: `bucket0-timestamp-mismatch:${bucket0.atSec}!=${worldBefore?.now}`,
      domesticBatch: [],
      visitOperations: [],
      truncatedAfterStochastic: false,
      truncatedByTransition: false,
    }
  }
  if (
    clockDrift > 0 &&
    (adapter.R.isleIndex(at0) !== adapter.R.isleIndex(nowW) || adapter.R.worldDay(at0) !== adapter.R.worldDay(nowW))
  ) {
    return {
      status: 'plan-invalid',
      failedIndex: -1,
      failedAction: null,
      failedReason: `bucket0-boundary-crossed:${bucket0.atSec}->${worldBefore?.now}`,
      domesticBatch: [],
      visitOperations: [],
      truncatedAfterStochastic: false,
      truncatedByTransition: false,
    }
  }

  const rawDomestic = Array.isArray(bucket0.domesticActions) ? bucket0.domesticActions : []
  const rawVisits = Array.isArray(bucket0.visitActions) ? bucket0.visitActions : []
  const maxBatch = adapter.R.WORLD?.maxActions || 40

  // Validate visit actions fail-closed before anything else
  for (let i = 0; i < rawVisits.length; i++) {
    const v = rawVisits[i]
    if (!v || v.targetId == null || !(Number(v.energyCost) >= 1)) {
      return {
        status: 'plan-invalid',
        failedIndex: i,
        failedAction: v || null,
        failedReason: 'invalid-visit-specification',
        domesticBatch: [],
        visitOperations: [],
        truncatedAfterStochastic: false,
        truncatedByTransition: false,
      }
    }
    if (plan.constraints?.maxStealsPerIsleDay === 0) {
      return {
        status: 'plan-invalid',
        failedIndex: i,
        failedAction: v,
        failedReason: 'steal-forbidden-by-account-constraints',
        domesticBatch: [],
        visitOperations: [],
        truncatedAfterStochastic: false,
        truncatedByTransition: false,
      }
    }
    const minSpots = Number(plan.constraints?.minStealSpots || 0)
    if (minSpots > 0 && Number(v.totalSpots || 0) < minSpots) {
      return {
        status: 'plan-invalid',
        failedIndex: i,
        failedAction: v,
        failedReason: `visit-spots-below-minimum:${v.totalSpots}<${minSpots}`,
        domesticBatch: [],
        visitOperations: [],
        truncatedAfterStochastic: false,
        truncatedByTransition: false,
      }
    }
  }

  // Cap to single server batch limit and batch independent mature `harvest`/`collect` actions together,
  // truncating only when a downstream action causally depends on unobserved stochastic yields!
  let {
    prefix,
    containsStochasticAction,
    truncatedAfterStochastic,
    truncatedByBatchLimit,
    stochasticTriggerAction,
  } = computeCausalStochasticPrefix(adapter, worldBefore, rawDomestic, maxBatch)

  let effectiveRawVisits = rawVisits
  let truncatedByTransition = false

  if (clockDrift > 0) {
    const isWaitBucket0 = prefix.length === 0 && rawVisits.length === 0
    let earliestTransition = computeEarliestDomesticTransitionSec(
      adapter,
      { ...worldBefore, now: at0 },
      isWaitBucket0 ? plan.nextWakeSec : null
    )
    if (Array.isArray(plan.committedUpcomingRaids)) {
      for (const r of plan.committedUpcomingRaids) {
        const uSec = Math.floor(Number(r?.unlockAtSec))
        if (Number.isFinite(uSec) && uSec > at0 && uSec < earliestTransition) {
          earliestTransition = uSec
        }
      }
    }
    if (isWaitBucket0) {
      const refAt0 = adapter.advanceTimeOnly({ ...worldBefore, now: at0 }, at0)
      const refNow = adapter.advanceTimeOnly(worldBefore, nowW)
      const passiveRegenCrossed = Math.floor(Number(refNow.state?.en || 0)) > Math.floor(Number(refAt0.state?.en || 0))
      if (nowW >= earliestTransition || passiveRegenCrossed) {
        return {
          status: 'plan-invalid',
          failedIndex: -1,
          failedAction: null,
          failedReason: nowW >= earliestTransition
            ? `bucket0-domestic-transition-crossed:${at0}->${nowW}>=${earliestTransition}`
            : `bucket0-passive-regen-crossed:${at0}->${nowW}`,
          domesticBatch: [],
          visitOperations: [],
          truncatedAfterStochastic: false,
          truncatedByTransition: false,
        }
      }
    } else if (nowW >= earliestTransition) {
      // A physical transition occurred during `(at0, nowW]`:
      // Withhold discretionary resource-competing actions (`mine`/`fish`/`bomb`/`sell`/`craft`/`plant`/`stockBuy`/`visit`
      // and surplus `eat`/`coffee`) for re-optimization on the post-transition world, while preserving safe urgent
      // mature collection/care along with only the minimal already-planned top-up prefix they require!
      const salvaged = extractTransitionSafeUrgentPrefix(adapter, worldBefore, prefix, plan)
      if (salvaged.length === 0) {
        return {
          status: 'plan-invalid',
          failedIndex: -1,
          failedAction: prefix[0] || rawVisits[0] || null,
          failedReason: `bucket0-domestic-transition-crossed:${at0}->${nowW}>=${earliestTransition}`,
          domesticBatch: [],
          visitOperations: [],
          truncatedAfterStochastic: false,
          truncatedByTransition: false,
        }
      }
      if (salvaged.length < prefix.length || rawVisits.length > 0) {
        truncatedByTransition = true
      }
      prefix = salvaged
      effectiveRawVisits = []
      containsStochasticAction = prefix.some((a) => adapter.isStochasticAction(a))
      stochasticTriggerAction = prefix.find((a) => adapter.isStochasticAction(a))?.a || null
      truncatedAfterStochastic = containsStochasticAction && prefix.length < rawDomestic.length
    }
  }

  if (prefix.length > 0) {
    const sim = adapter.simulateBatch(worldBefore, prefix, {
      t: worldBefore.now,
      prices: worldBefore.prices || {},
    })
    const out = sim.result?.out || []
    for (let i = 0; i < prefix.length; i++) {
      if (!out[i] || out[i].ok !== true) {
        return {
          status: 'plan-invalid',
          failedIndex: i,
          failedAction: prefix[i],
          failedReason: out[i]?.msg || 'rejected-by-rules-simulation',
          domesticBatch: [],
          visitOperations: [],
          truncatedAfterStochastic: false,
          truncatedByTransition: false,
        }
      }
    }
  }

  // Validate first visit operation stamina feasibility if a raid is scheduled before domestic work
  const visitOperations = effectiveRawVisits.map((v) => ({ ...v }))
  if (visitOperations.length > 0 && prefix.length === 0) {
    const refreshed = adapter.advanceTimeOnly(worldBefore, worldBefore.now)
    if (Number(refreshed.state?.en || 0) < Number(visitOperations[0].energyCost || 0)) {
      return {
        status: 'plan-invalid',
        failedIndex: 0,
        failedAction: visitOperations[0],
        failedReason: 'insufficient-stamina-for-visit',
        domesticBatch: [],
        visitOperations: [],
        truncatedAfterStochastic: false,
        truncatedByTransition: false,
      }
    }
  }

  const hasImmediateAction = prefix.length > 0 || visitOperations.length > 0
  // Priority: if `visitFirst === true` (e.g. race-sensitive unlocked steal spot and stamina already sufficient),
  // emit `nextTransactionKind: 'visit'`; otherwise if `prefix.length > 0` emit `'act'`; else `'visit'` or `'wait'`.
  let nextTransactionKind = 'wait'
  if (hasImmediateAction) {
    if (bucket0.visitFirst === true && visitOperations.length > 0) {
      nextTransactionKind = 'visit'
    } else if (prefix.length > 0) {
      nextTransactionKind = 'act'
    } else {
      nextTransactionKind = 'visit'
    }
  }

  return {
    status: hasImmediateAction ? 'ready' : 'wait',
    nextTransactionKind,
    domesticBatch: prefix,
    visitOperations: nextTransactionKind === 'visit'
      ? [visitOperations[0]]
      : ((containsStochasticAction || truncatedAfterStochastic || truncatedByTransition) ? [] : visitOperations.slice(0, 1)),
    containsStochasticAction,
    truncatedAfterStochastic,
    truncatedByBatchLimit,
    truncatedByTransition,
    stochasticTriggerAction,
    plannedNextWakeSec: plan.nextWakeSec ?? null,
    waitReason: hasImmediateAction ? null : (plan.waitReason || 'awaiting-next-event-boundary'),
  }
}

/**
 * Canonical signature of the immediate executable commitment of `plan` at `worldBefore`
 * (compares only the actual transaction batch / visit target or bounded wait wake time,
 * ignoring post-stochastic unexecutable tail actions in `trunkBuckets[0]`).
 */
export function buildExecutablePlanSignature(adapter, worldBefore, plan, { waitHorizonCapSec = null } = {}) {
  const comp = compileExecutablePrefix(adapter, worldBefore, plan)
  if (comp.status === 'plan-invalid') {
    return JSON.stringify({ status: 'invalid', reason: comp.failedReason })
  }
  const rawCommitted = Array.isArray(plan?.raidSchedule?.committedRaids)
    ? plan.raidSchedule.committedRaids
    : (Array.isArray(plan?.committedUpcomingRaids) ? plan.committedUpcomingRaids : [])
  const raidsSig = rawCommitted
    .filter((r) => r && (!Number.isFinite(waitHorizonCapSec) || Number(r.unlockAtSec) <= waitHorizonCapSec))
    .map((r) => `${r.targetId}@${r.unlockAtSec}`)
  if (comp.status === 'wait') {
    const rawWake = Number.isFinite(plan?.nextWakeSec) ? Number(plan.nextWakeSec) : null
    const cappedWake = rawWake != null && Number.isFinite(waitHorizonCapSec)
      ? Math.min(rawWake, Math.floor(waitHorizonCapSec))
      : rawWake
    return JSON.stringify({
      status: 'wait',
      nextWakeSec: cappedWake,
      ...(raidsSig.length > 0 ? { raids: raidsSig } : {}),
    })
  }
  return JSON.stringify({
    status: 'ready',
    kind: comp.nextTransactionKind,
    dom: comp.domesticBatch,
    vis: (comp.visitOperations || []).map((v) => v.targetId),
    ...(raidsSig.length > 0 ? { raids: raidsSig } : {}),
  })
}
