import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { solveUnifiedPlan, solveWithHorizonStability } from '../planner/solve.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import {
  executeTransaction,
  reconcileUnknownWithFreshWorld,
  withAccountLock,
} from '../execution/reconcile.mjs'
import { buildNeighborSignature } from '../execution/async-planner.mjs'

function extractPlannedSalesCommitments(plan) {
  const byItem = {}
  for (const b of plan?.trunkBuckets || []) {
    for (const act of b.domesticActions || []) {
      if (act?.a !== 'sell' || !act.id || !(Number(act.n) > 0)) continue
      if (!byItem[act.id]) {
        byItem[act.id] = { itemId: act.id, firstPlannedSellAtSec: b.atSec, totalPlannedQtyInTrunk: 0 }
      }
      byItem[act.id].totalPlannedQtyInTrunk += Number(act.n)
    }
  }
  const branches = Object.values(plan?.scenarioBranches || {})
  if (branches.length > 0) {
    for (const br of branches) {
      for (const bActs of br.bucketActions || []) {
        for (const act of bActs || []) {
          if (act?.a !== 'sell' || !act.id || !(Number(act.n) > 0)) continue
          if (!byItem[act.id]) {
            const firstBranchSec = plan?.trunkBuckets?.length
              ? plan.trunkBuckets[plan.trunkBuckets.length - 1].nextAtSec
              : (plan?.serverNow || 0)
            byItem[act.id] = { itemId: act.id, firstPlannedSellAtSec: firstBranchSec, totalPlannedQtyInTrunk: 0 }
          }
        }
      }
    }
  }
  return byItem
}

/**
 * Sole Unified Economic Controller (`cli/controller.mjs`)
 *
 * Replaces all split-brain legacy loops (`policy.analyze`, separate `visit` valuation, etc.)
 * with ONE closed, in-lock pipeline:
 *   `withAccountLock -> fetchWorld -> reconcileUnknown -> ObservationEnvelope -> solveWithHorizonStability -> compileExecutablePrefix -> executeTransaction | recordWait`
 */
export async function runControllerStep({
  adapter,
  journal,
  partnerJournal = null,
  lockRootDir,
  account = 'main',
  fetchWorldFn,
  fetchNeighborsFn = null,
  fetchPartnerWorldFn = null,
  sendActFn = null,
  sendVisitFn = null,
  onVisitReceiptFn = null,
  onReconciledVisitFn = null,
  objectiveCfg = {},
  userConstraints = {},
  solverOptions = {},
  asyncPlanner = null,
  rulesPath = null,
  deadlineAtMs = Infinity,
  shouldPreemptFn = null,
  maxCachedPlanDriftSec = Infinity,
  nowMsFn = Date.now,
  dryRun = false,
}) {
  const buildSoldLedger = () => {
    const knownSoldByIsleIndex = new Map()
    for (const j of [journal, partnerJournal]) {
      if (!j || typeof j.sumConfirmedSalesByIsleIndex !== 'function') continue
      for (const [isleIdx, itemMap] of j.sumConfirmedSalesByIsleIndex(adapter).entries()) {
        const cur = knownSoldByIsleIndex.get(isleIdx) || {}
        for (const [id, qty] of Object.entries(itemMap)) {
          cur[id] = (cur[id] || 0) + Number(qty || 0)
        }
        knownSoldByIsleIndex.set(isleIdx, cur)
      }
    }
    return knownSoldByIsleIndex
  }

  const applyUnknownReservations = (rawWorld, reconcileSummary) => {
    if (!(reconcileSummary?.remainingUnknown > 0)) return rawWorld
    const pw = adapter.cloneWorld(rawWorld)
    pw.state.en = Math.max(0, Number(pw.state?.en || 0) - Number(reconcileSummary.inFlightVisitEnergyReserved || 0))
    pw.coins = Math.max(0, Number(pw.coins || 0) - Number(reconcileSummary.inFlightVisitFineReserved || 0))
    return pw
  }

  const commitCompiledPlan = async ({
    heldLock,
    rawWorld,
    effectiveWorldBefore,
    envelope,
    objCfg,
    plan,
    horizonStability,
    compiled,
    planSource = 'inline',
    solveElapsedMs = null,
    observedNeighbors = [],
    observedPartnerWorld = null,
  }) => {
    const at0Diag = Math.floor(Number(plan?.trunkBuckets?.[0]?.atSec ?? effectiveWorldBefore?.now ?? 0))
    const nowDiag = Math.floor(Number(effectiveWorldBefore?.now ?? rawWorld?.now ?? 0))
    const diagnostics = {
      solveElapsedMs: Number.isFinite(solveElapsedMs) ? Math.round(solveElapsedMs) : null,
      clockDriftSec: nowDiag - at0Diag,
      failedReason: compiled.failedReason || null,
      failedAction: compiled.failedAction || null,
      failedIndex: compiled.failedIndex ?? null,
      recoveredFromCheckpoint: Boolean(horizonStability?.recoveredFromCheckpoint),
      truncatedByTransition: Boolean(compiled.truncatedByTransition),
    }

    if (compiled.status === 'plan-invalid') {
      asyncPlanner?.cache?.invalidate(account)
      return {
        status: 'plan-invalid',
        planSource,
        account,
        plan,
        horizonStability,
        compiled,
        diagnostics,
        nextWakeSec: Number(rawWorld.now || 0) + (adapter.R.WORLD?.minGap || 2),
      }
    }

    const fullPlanArchive = {
      planId: plan.planId,
      planSource,
      serverNow: plan.serverNow,
      horizonSec: plan.horizonSec,
      terminalMethod: plan.terminalMethod,
      quality: plan.quality,
      horizonStability,
      trunkBuckets: plan.trunkBuckets,
      scenarioBranches: plan.scenarioBranches,
      plannedSalesCommitments: extractPlannedSalesCommitments(plan),
      compiledStatus: compiled.status,
      nextTransactionKind: compiled.nextTransactionKind,
      containsStochasticAction: compiled.containsStochasticAction,
      truncatedAfterStochastic: compiled.truncatedAfterStochastic,
      nextWakeSec: plan.nextWakeSec,
      waitReason: plan.waitReason,
    }

    if (dryRun) {
      return {
        status: compiled.status === 'wait' ? 'shadow-wait' : 'shadow-ready',
        planSource,
        account,
        envelope,
        objectiveCfg: objCfg,
        plan,
        horizonStability,
        compiled,
        diagnostics,
        nextWakeSec: plan.nextWakeSec,
      }
    }

    if (compiled.status === 'wait') {
      if (journal) {
        journal.recordWaitDecision({
          decisionId: plan.planId,
          worldBefore: effectiveWorldBefore,
          envelope,
          objectiveCfg: objCfg,
          rulesHash: adapter.rulesHash,
          rulesSourceText: adapter.rulesSourceText,
          objectiveHash: plan.objectiveHash,
          constraintsHash: plan.constraintsHash,
          plannedWakeSec: plan.nextWakeSec,
          reason: compiled.waitReason,
          planSummary: fullPlanArchive,
        })
      }
      return {
        status: 'waiting',
        planSource,
        account,
        world: effectiveWorldBefore,
        observedNeighbors,
        observedPartnerWorld,
        soldLedger: buildSoldLedger(),
        plan,
        horizonStability,
        compiled,
        diagnostics,
        nextWakeSec: plan.nextWakeSec,
      }
    }

    if (compiled.nextTransactionKind === 'visit') {
      if (typeof sendVisitFn !== 'function') {
        throw new Error('sendVisitFn is required to execute a planned visit transaction')
      }
      const visitOp = compiled.visitOperations[0]
      const txRes = await executeTransaction({
        journal,
        adapter,
        lockRootDir,
        alreadyLocked: heldLock,
        account,
        decisionId: plan.planId,
        kind: 'visit',
        budgetKind: 'steal',
        budgetLimitPerIsleDay: envelope.constraints.maxStealsPerIsleDay,
        worldBefore: effectiveWorldBefore,
        envelope,
        objectiveCfg: objCfg,
        planSummary: fullPlanArchive,
        objectiveHash: plan.objectiveHash,
        constraintsHash: plan.constraintsHash,
        requestPayload: {
          targetId: visitOp.targetId,
          expectedSpots: visitOp.totalSpots,
          expectedEnergyCost: visitOp.energyCost,
        },
        sendFn: ({ operation, request }) => sendVisitFn({ operation, targetId: visitOp.targetId, request, visitOp }),
        onReceiptFn: typeof onVisitReceiptFn === 'function'
          ? (rec) => onVisitReceiptFn({ ...rec, targetId: visitOp.targetId, visitOp })
          : null,
        fetchAfterWorldFn: fetchWorldFn,
      })
      asyncPlanner?.cache?.invalidate(account)

      return {
        status: txRes.status,
        planSource,
        transactionKind: 'visit',
        account,
        plan,
        horizonStability,
        compiled,
        diagnostics,
        txResult: txRes,
        nextWakeSec: txRes.status === 'confirmed'
          ? (txRes.worldAfter?.now ?? rawWorld.now) + (adapter.R.WORLD?.minGap || 2)
          : plan.nextWakeSec,
      }
    }

    if (typeof sendActFn !== 'function') {
      throw new Error('sendActFn is required to execute a planned domestic act transaction')
    }

    const txRes = await executeTransaction({
      journal,
      adapter,
      lockRootDir,
      alreadyLocked: heldLock,
      account,
      decisionId: plan.planId,
      kind: 'act',
      budgetKind: null,
      budgetLimitPerIsleDay: null,
      worldBefore: effectiveWorldBefore,
      envelope,
      objectiveCfg: objCfg,
      planSummary: fullPlanArchive,
      objectiveHash: plan.objectiveHash,
      constraintsHash: plan.constraintsHash,
      requestPayload: {
        actions: compiled.domesticBatch,
      },
      sendFn: ({ operation, request }) => sendActFn({
        operation,
        actions: compiled.domesticBatch,
        request,
        worldBefore: effectiveWorldBefore,
      }),
      fetchAfterWorldFn: fetchWorldFn,
    })
    asyncPlanner?.cache?.invalidate(account)

    const needsContinuation = txRes.status === 'confirmed'
      && (
        compiled.containsStochasticAction ||
        compiled.truncatedAfterStochastic ||
        compiled.truncatedByBatchLimit ||
        compiled.truncatedByTransition ||
        (plan.trunkBuckets[0]?.visitActions?.length || 0) > 0
      )

    if (
      needsContinuation &&
      asyncPlanner &&
      txRes.worldAfter &&
      !shouldPreemptFn?.() &&
      nowMsFn() + 500 < deadlineAtMs
    ) {
      const minGap = adapter.R.WORLD?.minGap || 2
      const nextAt = Number(txRes.worldAfter.now || rawWorld.now) + minGap
      const preWorld = adapter.advanceTimeOnly(txRes.worldAfter, nextAt)
      preWorld.rev = txRes.worldAfter.rev
      Promise.resolve(typeof userConstraints === 'function' ? userConstraints(preWorld) : userConstraints)
        .then((nextU) => {
          const nextStealUsed = journal ? journal.countOccupiedBudget('steal', adapter.R.isleIndex(preWorld.now)) : 0
          const preEnv = buildObservationEnvelope(adapter, {
            account,
            world: preWorld,
            neighborTargets: observedNeighbors,
            partnerWorld: observedPartnerWorld,
            knownSoldByIsleIndex: buildSoldLedger(),
            userConstraints: nextU || {},
            reservedBudgets: { stealUsedOrReservedThisIsleDay: nextStealUsed },
          })
          asyncPlanner.precomputeInBackground({
            rulesPath,
            adapter,
            account,
            envelope: preEnv,
            objectiveCfg: objCfg,
            neighborTargets: observedNeighbors,
            solverOptions,
            runStability: false,
            deadlineAtMs,
          })
        })
        .catch(() => {})
    }

    return {
      status: txRes.status,
      planSource,
      transactionKind: 'act',
      account,
      observedNeighbors,
      observedPartnerWorld,
      soldLedger: buildSoldLedger(),
      plan,
      horizonStability,
      compiled,
      diagnostics,
      txResult: txRes,
      nextWakeSec: needsContinuation
        ? (txRes.worldAfter?.now ?? rawWorld.now) + (adapter.R.WORLD?.minGap || 2)
        : plan.nextWakeSec,
    }
  }

  // Decoupled Preemptible Mode (`asyncPlanner != null`):
  // 1) Never hold `.kernel.<account>.lock` while computing plans in background Worker.
  // 2) Reuse `PlanCache` (< 1ms) when pre-computed plan matches authoritative `(rev, isleIndex, naturalDay, constraintsHash)`.
  // 3) Hard-abort Worker via `worker.terminate()` on `deadlineAtMs` or `shouldPreemptFn()`!
  if (asyncPlanner) {
    const earlyAbort = shouldPreemptFn?.() || (nowMsFn() >= deadlineAtMs ? 'deadline-expired-at-entry' : null)
    if (earlyAbort) {
      await asyncPlanner.abortActiveJob(String(earlyAbort))
      return {
        status: 'deferred-by-deadline',
        abortReason: String(earlyAbort),
        account,
        nextWakeSec: null,
      }
    }

    let rawWorld = null
    let preReconcile = {
      reconciled: 0,
      remainingUnknown: 0,
      remainingNonVisitUnknown: 0,
      inFlightVisitEnergyReserved: 0,
      inFlightVisitFineReserved: 0,
    }

    const hasPendingUnknown = Boolean(
      journal && !dryRun && typeof journal.listUnknownTransactions === 'function' && journal.listUnknownTransactions().length > 0
    )
    if (hasPendingUnknown && lockRootDir) {
      const recStep = await withAccountLock(lockRootDir, account, async () => {
        const w = await fetchWorldFn()
        if (!w || !w.state) throw new Error(`Failed to fetch valid world snapshot for ${account}`)
        adapter.syncClock(w.clockStart)
        const rs = reconcileUnknownWithFreshWorld(journal, adapter, w, { onReconciledVisitFn })
        return { w, rs }
      })
      rawWorld = recStep.w
      preReconcile = recStep.rs
      if (preReconcile.remainingNonVisitUnknown > 0) {
        return {
          status: 'blocked-pending-reconcile',
          account,
          reconcileSummary: preReconcile,
          nextWakeSec: Number(rawWorld.now || 0) + 15,
        }
      }
    } else {
      rawWorld = await fetchWorldFn()
      if (!rawWorld || !rawWorld.state) {
        throw new Error(`Failed to fetch valid world snapshot for ${account}`)
      }
      adapter.syncClock(rawWorld.clockStart)
    }

    const planningWorld = applyUnknownReservations(rawWorld, preReconcile)
    const curIsleIdx = adapter.R.isleIndex(rawWorld.now)
    const stealUsedOrReserved = journal ? journal.countOccupiedBudget('steal', curIsleIdx) : 0
    const neighborTargets = (typeof fetchNeighborsFn === 'function' && preReconcile.remainingUnknown === 0)
      ? (await fetchNeighborsFn(rawWorld)) || []
      : []
    const partnerWorld = typeof fetchPartnerWorldFn === 'function'
      ? await fetchPartnerWorldFn()
      : null
    const knownSoldByIsleIndex = buildSoldLedger()
    const resolvedUserConstraints = typeof userConstraints === 'function'
      ? (await userConstraints(planningWorld)) || {}
      : userConstraints

    const envelope = buildObservationEnvelope(adapter, {
      account,
      world: planningWorld,
      neighborTargets,
      partnerWorld,
      knownSoldByIsleIndex,
      userConstraints: resolvedUserConstraints,
      reservedBudgets: { stealUsedOrReservedThisIsleDay: stealUsedOrReserved },
    })
    const objCfg = buildObjectiveConfig(objectiveCfg)
    const runStability = solverOptions.checkHorizonStability === true
      || (solverOptions.checkHorizonStability !== false && neighborTargets.length === 0)

    const tSolveStartMs = nowMsFn()
    const asyncOut = await asyncPlanner.solveOrPreempt({
      rulesPath,
      adapter,
      account,
      envelope,
      objectiveCfg: objCfg,
      neighborTargets,
      solverOptions,
      runStability,
      deadlineAtMs,
      shouldPreemptFn,
      maxClockDriftSec: maxCachedPlanDriftSec,
      nowMsFn,
    })
    const solveElapsedMs = Math.max(0, nowMsFn() - tSolveStartMs)

    if (asyncOut.status === 'aborted-by-deadline') {
      return {
        status: 'deferred-by-deadline',
        abortReason: asyncOut.reason,
        account,
        diagnostics: { solveElapsedMs: Math.round(solveElapsedMs) },
        nextWakeSec: Number(rawWorld.now || 0) + 1,
      }
    }
    if (asyncOut.status === 'worker-error') {
      throw new Error(`Async planner worker failed: ${asyncOut.error}`)
    }

    const { plan, horizonStability } = asyncOut
    const planSource = asyncOut.status
    const effectiveMaxDriftSec = planSource === 'cache-hit' ? maxCachedPlanDriftSec : Infinity

    if (dryRun) {
      const compiledDry = compileExecutablePrefix(adapter, envelope.observed.world, plan, {
        maxClockDriftSec: effectiveMaxDriftSec,
      })
      return commitCompiledPlan({
        heldLock: false,
        rawWorld,
        effectiveWorldBefore: envelope.observed.world,
        envelope,
        objCfg,
        plan,
        horizonStability,
        compiled: compiledDry,
        planSource,
        solveElapsedMs,
        observedNeighbors: neighborTargets,
        observedPartnerWorld: partnerWorld,
      })
    }

    const executeInLock = async (heldLock) => {
      const postSolveAbort = shouldPreemptFn?.() || (nowMsFn() >= deadlineAtMs ? 'deadline-expired-before-commit' : null)
      if (postSolveAbort) {
        return {
          status: 'deferred-by-deadline',
          abortReason: String(postSolveAbort),
          account,
          plan,
          horizonStability,
          diagnostics: { solveElapsedMs: Math.round(solveElapsedMs) },
          nextWakeSec: Number(rawWorld.now || 0) + 1,
        }
      }

      const inLockWorld = await fetchWorldFn()
      if (!inLockWorld || !inLockWorld.state) {
        throw new Error(`Failed to fetch authoritative in-lock world snapshot for ${account}`)
      }
      adapter.syncClock(inLockWorld.clockStart)

      let inLockReconcile = preReconcile
      if (journal) {
        inLockReconcile = reconcileUnknownWithFreshWorld(journal, adapter, inLockWorld, {
          onReconciledVisitFn,
        })
        if (inLockReconcile.remainingNonVisitUnknown > 0) {
          return {
            status: 'blocked-pending-reconcile',
            account,
            reconcileSummary: inLockReconcile,
            nextWakeSec: Number(inLockWorld.now || 0) + 15,
          }
        }
      }

      if (Number(inLockWorld.rev) !== Number(rawWorld.rev)) {
        asyncPlanner.cache.invalidate(account)
        return {
          status: 'stale-plan-invalidated',
          planSource,
          account,
          expectedRev: rawWorld.rev,
          actualRev: inLockWorld.rev,
          diagnostics: { solveElapsedMs: Math.round(solveElapsedMs) },
          nextWakeSec: Number(inLockWorld.now || 0) + 1,
        }
      }

      const effectiveInLockWorld = applyUnknownReservations(inLockWorld, inLockReconcile)
      const compiledInLock = compileExecutablePrefix(adapter, effectiveInLockWorld, plan, {
        maxClockDriftSec: effectiveMaxDriftSec,
      })
      return commitCompiledPlan({
        heldLock,
        rawWorld: inLockWorld,
        effectiveWorldBefore: effectiveInLockWorld,
        envelope,
        objCfg,
        plan,
        horizonStability,
        compiled: compiledInLock,
        planSource,
        solveElapsedMs,
        observedNeighbors: neighborTargets,
        observedPartnerWorld: partnerWorld,
      })
    }

    if (lockRootDir) {
      return withAccountLock(lockRootDir, account, () => executeInLock(true))
    }
    return executeInLock(false)
  }

  // Synchronous In-Process Mode (backward-compatible for unit tests & CLI inspection, cooperative `deadlineAtMs` aware)
  const executeStepBody = async (heldLock) => {
    const rawWorld = await fetchWorldFn()
    if (!rawWorld || !rawWorld.state) {
      throw new Error(`Failed to fetch valid world snapshot for ${account}`)
    }
    adapter.syncClock(rawWorld.clockStart)

    let reconcileSummary = {
      reconciled: 0,
      remainingUnknown: 0,
      remainingNonVisitUnknown: 0,
      inFlightVisitEnergyReserved: 0,
      inFlightVisitFineReserved: 0,
    }
    let planningWorld = rawWorld
    if (journal && !dryRun) {
      reconcileSummary = reconcileUnknownWithFreshWorld(journal, adapter, rawWorld, {
        onReconciledVisitFn,
      })
      if (reconcileSummary.remainingNonVisitUnknown > 0) {
        return {
          status: 'blocked-pending-reconcile',
          account,
          reconcileSummary,
          nextWakeSec: Number(rawWorld.now || 0) + 15,
        }
      }
      planningWorld = applyUnknownReservations(rawWorld, reconcileSummary)
    }

    const curIsleIdx = adapter.R.isleIndex(rawWorld.now)
    const stealUsedOrReserved = journal
      ? journal.countOccupiedBudget('steal', curIsleIdx)
      : 0

    const neighborTargets = (typeof fetchNeighborsFn === 'function' && reconcileSummary.remainingUnknown === 0)
      ? (await fetchNeighborsFn(rawWorld)) || []
      : []
    const partnerWorld = typeof fetchPartnerWorldFn === 'function'
      ? await fetchPartnerWorldFn()
      : null

    const rawNeighborTargetsById = new Map()
    for (const nt of neighborTargets) {
      const tid = nt?.id ?? nt?.owner?.id
      if (tid != null) rawNeighborTargetsById.set(tid, nt)
    }

    const knownSoldByIsleIndex = buildSoldLedger()
    const resolvedUserConstraints = typeof userConstraints === 'function'
      ? (await userConstraints(planningWorld)) || {}
      : userConstraints

    const envelope = buildObservationEnvelope(adapter, {
      account,
      world: planningWorld,
      neighborTargets,
      partnerWorld,
      knownSoldByIsleIndex,
      userConstraints: resolvedUserConstraints,
      reservedBudgets: { stealUsedOrReservedThisIsleDay: stealUsedOrReserved },
    })

    const objCfg = buildObjectiveConfig(objectiveCfg)
    const runStability = solverOptions.checkHorizonStability === true
      || (solverOptions.checkHorizonStability !== false && neighborTargets.length === 0)
    const tSolveStartMs = nowMsFn()
    let plan
    let horizonStability = null
    if (runStability) {
      const stab = solveWithHorizonStability(adapter, envelope, objCfg, {
        ...solverOptions,
        rawNeighborTargetsById,
        deadlineAtMs,
        nowMsFn,
      })
      const adoptExtended = Boolean(!stab.skippedByDeadline && stab.prefixStable === false && stab.extendedPlan)
      plan = adoptExtended ? stab.extendedPlan : stab.basePlan
      horizonStability = {
        prefixStable: stab.prefixStable,
        adoptedExtendedPlan: adoptExtended,
        skippedByDeadline: Boolean(stab.skippedByDeadline),
        extendedHorizonSec: stab.extendedPlan?.horizonSec ?? null,
        extendedObjectiveValue: stab.extendedPlan?.quality?.feasibleIncumbentValue ?? null,
      }
    } else {
      plan = solveUnifiedPlan(adapter, envelope, objCfg, {
        ...solverOptions,
        rawNeighborTargetsById,
        deadlineAtMs,
        nowMsFn,
      })
    }
    const solveElapsedMs = Math.max(0, nowMsFn() - tSolveStartMs)

    const compiled = compileExecutablePrefix(adapter, envelope.observed.world, plan)
    return commitCompiledPlan({
      heldLock,
      rawWorld,
      effectiveWorldBefore: envelope.observed.world,
      envelope,
      objCfg,
      plan,
      horizonStability,
      compiled,
      planSource: 'inline',
      solveElapsedMs,
      observedNeighbors: neighborTargets,
      observedPartnerWorld: partnerWorld,
    })
  }

  if (!dryRun && lockRootDir) {
    return withAccountLock(lockRootDir, account, () => executeStepBody(true))
  }
  return executeStepBody(false)
}

// CLI shadow-runner entrypoint for direct inspection
const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectMain) {
  const args = process.argv.slice(2)
  const getArg = (flag, defVal) => {
    const idx = args.indexOf(flag)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defVal
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const fixturePath = path.resolve(rootDir, getArg('--fixture', 'fixtures/sample-snapshot.json'))
  const account = getArg('--account', 'main')
  const rulesPath = path.resolve(rootDir, 'rules/pet-world-rules.js')

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, ''))
  const world = fixture[account]?.world
    || (account === 'main' ? fixture.mainBundle?.main : null)
    || fixture[account]
  const neighbors = account === 'main'
    ? (fixture.neighbors || fixture.mainBundle?.sampleVisits || [])
    : []
  const adapter = await loadRulesAdapterFromFile(rulesPath, { clockStart: world.clockStart })

  const out = await runControllerStep({
    adapter,
    journal: null,
    lockRootDir: path.join(rootDir, '.tmp-locks'),
    account,
    fetchWorldFn: async () => world,
    fetchNeighborsFn: async () => neighbors,
    userConstraints: {},
    dryRun: true,
  })

  console.log(JSON.stringify({
    account,
    status: out.status,
    serverNow: world.now,
    nextTransactionKind: out.compiled.nextTransactionKind,
    domesticBatchLength: out.compiled.domesticBatch.length,
    domesticBatchSample: out.compiled.domesticBatch.slice(0, 10),
    visitOperations: out.compiled.visitOperations,
    truncatedAfterStochastic: out.compiled.truncatedAfterStochastic,
    nextWakeSec: out.nextWakeSec,
    quality: out.plan.quality,
  }, null, 2))
}
