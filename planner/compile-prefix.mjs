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
  return {
    prefix,
    containsStochasticAction,
    truncatedAfterStochastic,
    truncatedByBatchLimit: endIdx === capped.length && truncatedByBatchLimit,
    stochasticTriggerAction,
  }
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
    }
  }

  const bucket0 = plan.trunkBuckets[0]
  const at0 = Math.floor(Number(bucket0.atSec))
  const nowW = Math.floor(Number(worldBefore?.now || 0))
  const maxClockDriftSec = Math.max(0, Number(options.maxClockDriftSec || 0))
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
      }
    }
  }

  // Cap to single server batch limit and batch independent mature `harvest`/`collect` actions together,
  // truncating only when a downstream action causally depends on unobserved stochastic yields!
  const {
    prefix,
    containsStochasticAction,
    truncatedAfterStochastic,
    truncatedByBatchLimit,
    stochasticTriggerAction,
  } = computeCausalStochasticPrefix(adapter, worldBefore, rawDomestic, maxBatch)

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
        }
      }
    }
  }

  // Validate first visit operation stamina feasibility if a raid is scheduled before domestic work
  const visitOperations = rawVisits.map((v) => ({ ...v }))
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
    visitOperations: nextTransactionKind === 'visit' ? [visitOperations[0]] : ((containsStochasticAction || truncatedAfterStochastic) ? [] : visitOperations.slice(0, 1)),
    containsStochasticAction,
    truncatedAfterStochastic,
    truncatedByBatchLimit,
    stochasticTriggerAction,
    plannedNextWakeSec: plan.nextWakeSec ?? null,
    waitReason: hasImmediateAction ? null : (plan.waitReason || 'awaiting-next-event-boundary'),
  }
}
