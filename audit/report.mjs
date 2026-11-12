import { buildObjectiveConfig, detectRollingDeferral, evaluateTrajectoryObjective } from '../model/objective.mjs'
import { auditTransactionReplay } from './replay.mjs'
import { auditDecisionAgainstReference } from './reference-solver.mjs'

/**
 * Layer 3 Audit Report Generator (`audit/report.mjs`)
 *
 * Strictly separates:
 * 1. `not-identifiable` (missing pre-state or archived rules)
 * 2. `mechanical-or-conservation-defect` (Layer 1 receipt/shadow-state/illegal-action failure)
 * 3. `rolling-deferral-defect` (rolling-endpoint perpetual deferral without new info)
 * 4. `identifiableDecisionRegretLowerBound` (`R_lower > 0` ex-ante under observed information)
 * 5. `estimatedReferenceDelta` (non-exhaustive counterfactual delta)
 * 6. `planFulfillmentDrift` (planned vs realized execution gap)
 * 7. `exPostHindsightGap` (clairvoyant hindsight gap — NEVER misclassified as decision regret!)
 *
 * Zero dependency on `planner/*`.
 */
export async function buildAuditDecisionReport({
  journal = null,
  tx = null,
  adapter,
  worldBefore = null,
  actualFirstActions = null,
  actualFullPolicyObjectiveValue = null,
  plannedExpectedObjectiveValue = null,
  realizedOutcomeObjectiveValue = null,
  exPostRealizedScenario = null,
  scenarios = null,
  explicitPricesByStep = null,
  deterministicArrivals = [],
  visitBeliefs = null,
  upcomingVisitBeliefs = null,
  reservedStealUsedThisIsleDay = null,
  objectiveCfg = null,
  allowedActionTypes = ['sell', 'craft', 'wait', 'stockBuy', 'eat', 'coffee'],
  constraints = null,
  commitmentHistory = null,
  maxSteps = 4,
  maxSearchNodes = 2500,
}) {
  // 1. Layer 1 replay check (if backed by a journal transaction)
  let replayResult = null
  if (journal && tx) {
    replayResult = await auditTransactionReplay(journal, tx, { fallbackAdapter: adapter })
    if (!replayResult.identifiable) {
      return {
        verdict: 'not-identifiable',
        identifiable: false,
        reason: replayResult.reason,
        replay: replayResult,
        identifiableDecisionRegretLowerBound: null,
        estimatedReferenceDelta: null,
        planFulfillmentDrift: null,
        exPostHindsightGap: null,
      }
    }
    if (tx.kind === 'xian-act') {
      const defect = ['model-drift', 'illegal-action-in-batch'].includes(replayResult.status)
      return {
        verdict: defect ? 'mechanical-or-conservation-defect' : 'ex-ante-consistent',
        identifiable: true,
        replay: replayResult,
        identifiableDecisionRegretLowerBound: 0,
        estimatedReferenceDelta: 0,
        planFulfillmentDrift: null,
        exPostHindsightGap: null,
      }
    }
    if (!worldBefore && tx.stateBeforeRef) {
      worldBefore = journal.readBlob(tx.stateBeforeRef)
    }
    if ((!actualFirstActions || actualFirstActions.length === 0) && tx.requestRef) {
      const req = journal.readBlob(tx.requestRef)
      if (Array.isArray(req?.actions)) actualFirstActions = req.actions
    }
    // Reconstruct archived envelope, objectiveCfg, and planned trajectory expectation automatically from journal!
    if (tx.envelopeRef) {
      const archivedEnvelope = journal.readBlob(tx.envelopeRef)
      if (!scenarios && Array.isArray(archivedEnvelope?.beliefs?.scenarios) && archivedEnvelope.beliefs.scenarios.length > 0) {
        scenarios = archivedEnvelope.beliefs.scenarios
      }
      if (!visitBeliefs && Array.isArray(archivedEnvelope?.beliefs?.visitBeliefs)) {
        visitBeliefs = archivedEnvelope.beliefs.visitBeliefs
      }
      if (!upcomingVisitBeliefs && Array.isArray(archivedEnvelope?.beliefs?.upcomingVisitBeliefs)) {
        upcomingVisitBeliefs = archivedEnvelope.beliefs.upcomingVisitBeliefs
      }
      if (reservedStealUsedThisIsleDay == null && archivedEnvelope?.reservedBudgets?.stealUsedOrReservedThisIsleDay != null) {
        reservedStealUsedThisIsleDay = Number(archivedEnvelope.reservedBudgets.stealUsedOrReservedThisIsleDay || 0)
      }
      if (!constraints && archivedEnvelope?.constraints) {
        constraints = archivedEnvelope.constraints
      }
    }
    if (!objectiveCfg && tx.objectiveCfgRef) {
      objectiveCfg = journal.readBlob(tx.objectiveCfgRef)
    }
    if (tx.planRef) {
      const archivedPlan = journal.readBlob(tx.planRef)
      if (plannedExpectedObjectiveValue == null && Number.isFinite(archivedPlan?.quality?.feasibleIncumbentValue)) {
        plannedExpectedObjectiveValue = archivedPlan.quality.feasibleIncumbentValue
      }
      if (!constraints && archivedPlan?.constraints) {
        constraints = archivedPlan.constraints
      }
    }
  }

  actualFirstActions ||= []
  scenarios ||= [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }]
  constraints ||= {}
  objectiveCfg ||= buildObjectiveConfig()

  // Reconstruct chronological `commitmentHistory` from `journal` if not explicitly passed!
  if (!commitmentHistory) {
    commitmentHistory = journal ? reconstructCommitmentHistoryFromJournal(journal, tx) : []
  }

  if (!worldBefore || !worldBefore.state || !adapter) {
    return {
      verdict: 'not-identifiable',
      identifiable: false,
      reason: !adapter ? 'missing-rules-adapter' : 'missing-world-before',
      replay: replayResult,
      identifiableDecisionRegretLowerBound: null,
      estimatedReferenceDelta: null,
      planFulfillmentDrift: null,
      exPostHindsightGap: null,
    }
  }

  // Check Layer 1 mechanical / conservation / illegal-action failures
  const hasMechanicalDefect = replayResult
    ? ['model-drift', 'shadow-conservation-violation', 'illegal-action-in-batch'].includes(replayResult.status)
    : false

  // 2. Rolling-horizon perpetual deferral detector (evaluates per itemId when multiple items appear in history)
  const deferral = evaluateDeferralAcrossItems(commitmentHistory)

  // 3. Layer 2 Ex-Ante Counterfactual Reference Audit
  const refAudit = auditDecisionAgainstReference(adapter, {
    worldBefore,
    actualFirstActions,
    actualFullPolicyObjectiveValue,
    scenarios,
    explicitPricesByStep,
    deterministicArrivals,
    visitBeliefs: visitBeliefs || [],
    upcomingVisitBeliefs: upcomingVisitBeliefs || [],
    reservedStealUsedThisIsleDay: Number(reservedStealUsedThisIsleDay || 0),
    objectiveCfg,
    allowedActionTypes,
    constraints,
    maxSteps,
    maxSearchNodes,
  })

  if (!refAudit.actualLegal) {
    return {
      verdict: 'mechanical-or-conservation-defect',
      identifiable: true,
      reason: 'actual-first-actions-illegal-under-rules',
      replay: replayResult,
      deferral,
      reference: refAudit,
      identifiableDecisionRegretLowerBound: refAudit.identifiableRegretLowerBound,
      estimatedReferenceDelta: refAudit.estimatedReferenceDelta,
      planFulfillmentDrift: null,
      exPostHindsightGap: null,
    }
  }

  // 4. Plan Fulfillment Drift (if both planned expectation and realized value are available)
  const planFulfillmentDrift = (
    Number.isFinite(plannedExpectedObjectiveValue) &&
    Number.isFinite(realizedOutcomeObjectiveValue)
  )
    ? plannedExpectedObjectiveValue - realizedOutcomeObjectiveValue
    : null

  // 5. Informational Ex-Post Hindsight Gap (clairvoyant single-scenario optimum on realized draw vs realized outcome)
  let exPostHindsightGap = null
  if (exPostRealizedScenario) {
    const hindsightAudit = auditDecisionAgainstReference(adapter, {
      worldBefore,
      actualFirstActions,
      scenarios: [{ ...exPostRealizedScenario, weight: 1.0 }],
      explicitPricesByStep: exPostRealizedScenario.explicitPricesByStep || explicitPricesByStep,
      deterministicArrivals,
      visitBeliefs: visitBeliefs || [],
      upcomingVisitBeliefs: upcomingVisitBeliefs || [],
      reservedStealUsedThisIsleDay: Number(reservedStealUsedThisIsleDay || 0),
      objectiveCfg,
      allowedActionTypes,
      constraints,
      maxSteps,
      maxSearchNodes,
    })
    if (hindsightAudit.bestAlternative && hindsightAudit.actualContinuationValue != null) {
      exPostHindsightGap = Math.max(0, hindsightAudit.bestAlternative.value - hindsightAudit.actualContinuationValue)
    }
  }

  const rLower = refAudit.identifiableRegretLowerBound
  const estDelta = refAudit.estimatedReferenceDelta

  let verdict = 'ex-ante-consistent'
  if (hasMechanicalDefect) {
    verdict = 'mechanical-or-conservation-defect'
  } else if (deferral.rollingDeferralDetected) {
    verdict = 'rolling-deferral-defect'
  } else if (rLower != null && rLower > 1e-6) {
    verdict = 'identifiable-decision-regret'
  } else if (rLower == null && estDelta > 1e-6) {
    verdict = 'estimated-suboptimal-candidate'
  }

  return {
    verdict,
    identifiable: true,
    replay: replayResult,
    deferral,
    reference: refAudit,
    identifiableDecisionRegretLowerBound: rLower,
    estimatedReferenceDelta: estDelta,
    planFulfillmentDrift,
    exPostHindsightGap,
  }
}

function evaluateDeferralAcrossItems(commitmentHistory = []) {
  if (!Array.isArray(commitmentHistory) || commitmentHistory.length < 3) {
    return detectRollingDeferral(commitmentHistory)
  }
  const byItem = new Map()
  for (const entry of commitmentHistory) {
    const key = entry?.itemId || '__default__'
    if (!byItem.has(key)) byItem.set(key, [])
    byItem.get(key).push(entry)
  }
  let maxRes = { rollingDeferralDetected: false, shifts: 0, reason: null }
  for (const list of byItem.values()) {
    const res = detectRollingDeferral(list)
    if (res.rollingDeferralDetected) return res
    if (res.shifts > maxRes.shifts) maxRes = res
  }
  return maxRes
}

/**
 * Reconstructs per-item sales commitment history chronologically from archived `tx-intent`/`tx-transition`
 * and `wait-decision` records in `journal` up through `upToTx` (if provided).
 */
export function reconstructCommitmentHistoryFromJournal(journal, upToTx = null) {
  if (!journal || typeof journal.reconstructTransactions !== 'function') return []
  const { txMap, waitDecisions } = journal.reconstructTransactions()
  const cutoffSeq = Number.isFinite(upToTx?.lastSeq) ? upToTx.lastSeq : Infinity

  const decisionRecords = []
  for (const tx of txMap.values()) {
    if ((tx.lastSeq ?? 0) > cutoffSeq) continue
    if (!tx.planRef) continue
    decisionRecords.push({
      kind: 'tx',
      seq: tx.firstSeq ?? tx.lastSeq ?? 0,
      atSec: tx.serverNow || 0,
      planRef: tx.planRef,
      stateBeforeRef: tx.stateBeforeRef,
      requestRef: tx.requestRef,
      responseRef: tx.responseRef,
      status: tx.status,
    })
  }
  for (const wd of waitDecisions || []) {
    if ((wd.seq ?? 0) > cutoffSeq) continue
    if (!wd.planRef) continue
    decisionRecords.push({
      kind: 'wait',
      seq: wd.seq ?? 0,
      atSec: wd.plannedWakeSec || 0,
      planRef: wd.planRef,
      stateBeforeRef: wd.stateBeforeRef,
      requestRef: null,
      responseRef: null,
      status: 'wait',
    })
  }

  decisionRecords.sort((a, b) => a.seq - b.seq)

  const out = []
  const prevPriceByItem = new Map()
  for (const rec of decisionRecords) {
    const planBlob = journal.readBlob(rec.planRef)
    if (!planBlob) continue
    const wBefore = rec.stateBeforeRef ? journal.readBlob(rec.stateBeforeRef) : null
    const atSec = Number(wBefore?.now ?? planBlob.serverNow ?? rec.atSec ?? 0)

    // Extractplanned commitments (either explicit `plannedSalesCommitments` or derived from `trunkBuckets`)
    let commitments = planBlob.plannedSalesCommitments
    if (!commitments && Array.isArray(planBlob.trunkBuckets)) {
      commitments = {}
      for (const b of planBlob.trunkBuckets) {
        for (const act of b.domesticActions || []) {
          if (act?.a === 'sell' && act.id && Number(act.n) > 0 && !commitments[act.id]) {
            commitments[act.id] = {
              itemId: act.id,
              firstPlannedSellAtSec: b.atSec,
              totalPlannedQtyInTrunk: Number(act.n),
            }
          }
        }
      }
    }

    // Extract executed sell quantities in confirmed `act` transactions
    const executedByItem = {}
    if (rec.kind === 'tx' && rec.status === 'confirmed' && rec.requestRef) {
      const req = journal.readBlob(rec.requestRef)
      const res = rec.responseRef ? journal.readBlob(rec.responseRef) : null
      const outArr = res?.body?.out || res?.out || null
      const actions = Array.isArray(req?.actions) ? req.actions : []
      actions.forEach((act, idx) => {
        if (act?.a === 'sell' && act.id && (!outArr || outArr[idx]?.ok !== false)) {
          executedByItem[act.id] = (executedByItem[act.id] || 0) + Number(act.n || 0)
        }
      })
    }

    const itemIds = new Set([
      ...Object.keys(commitments || {}),
      ...Object.keys(executedByItem),
    ])
    for (const itemId of itemIds) {
      const curPrice = wBefore?.prices?.[itemId]
      const prevPrice = prevPriceByItem.get(itemId)
      const priceChanged = prevPrice !== undefined && curPrice !== undefined && curPrice !== prevPrice
      if (curPrice !== undefined) prevPriceByItem.set(itemId, curPrice)

      const comm = commitments?.[itemId]
      out.push({
        itemId,
        atSec,
        plannedSellAtSec: comm?.firstPlannedSellAtSec ?? null,
        executedSellQty: Number(executedByItem[itemId] || 0),
        newExternalShock: priceChanged,
      })
    }
  }
  return out
}
