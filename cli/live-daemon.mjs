import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import {
  buildObservationEnvelope,
  computeStaticFarmStateDigest,
  getManualArcadeStandbyInfo,
} from '../model/observations.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { AsyncPlanManager } from '../execution/async-planner.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { executeWithTacticalLoadout, readAccountGearState } from '../execution/combat-engine.mjs'
import {
  runHuancaiDailyCheck,
  runSingleArenaBout,
  syncBattleProfilesAndPreparation,
  syncPetCareFirst,
} from '../execution/pet-and-battle.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { UpdateNotifier } from '../execution/update-notifier.mjs'
import {
  computeNextNpcWakeSec,
  runNpcToyStallSlice,
} from '../execution/npc-toy-stall.mjs'
import {
  computeNextXianWakeSec,
  normalizeXianOptions,
  runXianCultivationSlice,
} from '../execution/xian-cultivation.mjs'
import { runControllerStep } from './controller.mjs'

/**
 * Unified Production Daemon (`cli/live-daemon.mjs`)
 *
 * Orchestrates the daemon loop (standard mode or `--domestic-only` mode) with strict causal ordering and zero leaf inversions:
 *   Phase A: Pre-unlock staged snipe fast-lane (`leadSec <= 16` for `main`) — highest priority, zero background block.
 *   Phase B: Preemptible unified economic `runControllerStep` (`AsyncPlanManager` Worker + `PlanCache` + hard `T_unlock - 14s`
 *            `worker.terminate()` deadline with same-tick handoff to `executeStagedSnipe`).
 *   Phase C: Preemptible background slice ONLY when `!snipeScheduler.shouldBlockBackgroundWork(nowSec, 50)`:
 *            `syncPetCareFirst` -> `syncBattleProfilesAndPreparation` -> `runSingleArenaBout` (1 bout) ->
 *            `runHuancaiDailyCheck` -> `runIncrementalDiscoverySlice` (`<= 2` pages, `<= 4` probes).
 */

export async function runLiveAccountTick({
  account = 'main',
  adapter,
  httpClient,
  partnerHttpClient = null,
  journal,
  partnerJournal = null,
  snipeScheduler,
  lockRootDir,
  profileStorePath,
  huancaiStatePath = null,
  runtimeState,
  baseUserConstraints = {},
  objectiveCfg = {},
  solverOptions = {},
  asyncPlanner = null,
  rulesPath = null,
  maxTickSolveMs = 45000,
  xianOptions = {},
  npcOptions = { enabled: false },
  arcadeStandbyOptions = {},
  dryRun = false,
}) {
  const normalizedXian = normalizeXianOptions(xianOptions)
  const effectiveRulesPath = rulesPath || runtimeState?.rulesPath || null
  const activePlanner = asyncPlanner
    || (runtimeState?.asyncPlanner ?? null)
    || ((effectiveRulesPath && runtimeState)
      ? (runtimeState.asyncPlanner = new AsyncPlanManager({ rulesPath: effectiveRulesPath }))
      : null)

  const fetchWorldFn = async () => httpClient.getJson('/api/pet/world')
  const fetchPartnerWorldFn = partnerHttpClient
    ? async () => partnerHttpClient.getJson('/api/pet/world').catch(() => null)
    : null

  const runUrgentStagedSnipeIfImminent = async (minTriggerFloorSec = 0) => {
    if (dryRun || !snipeScheduler?.isStealEnabled()) return null
    const nextInfo = snipeScheduler.nextExactUnlockInfo(httpClient.estimatedServerNowSec())
    if (!nextInfo) return null
    const prepLeadSec = snipeScheduler.computePhysicalPrepLeadSec(nextInfo.entry, adapter, httpClient)
    const stageTriggerSec = Math.max(Math.ceil(prepLeadSec + 1), Number(minTriggerFloorSec || 0))
    if (nextInfo.leadSec > stageTriggerSec) return null
    const stagedOut = await snipeScheduler.executeStagedSnipe({
      adapter,
      httpClient,
      journal,
      lockRootDir,
      fetchWorldFn,
      userConstraints: baseUserConstraints,
      stageWindowSec: stageTriggerSec,
      postUnlockOffsetMs: 25,
      arcadeStandbyOptions,
    })
    if (stagedOut?.status === 'standby-manual-arcade') {
      const nowArcSec = httpClient.estimatedServerNowSec()
      const standbyInfo = stagedOut.arcadeStandby || getManualArcadeStandbyInfo(stagedOut.world, nowArcSec, arcadeStandbyOptions)
      return {
        phase: 'arcade-standby',
        account,
        arcadeStandby: standbyInfo,
        stagedOut,
        nextWakeSec: Number(stagedOut.nextWakeSec || Math.min(nowArcSec + 5, standbyInfo.resumeAtSec || (nowArcSec + 5))),
      }
    }
    return {
      phase: 'staged-snipe',
      account,
      stagedOut,
      nextWakeSec: httpClient.estimatedServerNowSec() + (adapter.R.WORLD?.minGap || 2),
    }
  }

  // Phase A: Physical-Cooldown Staged Snipe Fast Lane (`leadSec <= T_prep + 1s` enters unified staged countdown)
  const urgentAtEntry = await runUrgentStagedSnipeIfImminent()
  if (urgentAtEntry) return urgentAtEntry

  // Phase B: Unified Economic Controller Step (non-blocking Worker via `AsyncPlanManager` + `PlanCache`)
  const effectiveMaxTickSolveMs = Number(solverOptions?.maxTickSolveMs ?? maxTickSolveMs)
  const tickDeadlineAtMs = Number.isFinite(effectiveMaxTickSolveMs)
    ? httpClient.nowMsFn() + effectiveMaxTickSolveMs
    : Infinity
  const nextSnipeAtStart = !dryRun && snipeScheduler?.isStealEnabled()
    ? snipeScheduler.nextExactUnlockInfo(httpClient.estimatedServerNowSec())
    : null
  const initialSnipeStageTriggerSec = nextSnipeAtStart
    ? Math.ceil(snipeScheduler.computePhysicalPrepLeadSec(nextSnipeAtStart.entry, adapter, httpClient) + 1)
    : 0
  const snipePrepTargetSec = nextSnipeAtStart
    ? nextSnipeAtStart.unlockAt - initialSnipeStageTriggerSec
    : null
  const snipePrepDeadlineAtMs = snipePrepTargetSec != null
    ? (typeof httpClient.serverSecToLocalMs === 'function'
        ? httpClient.serverSecToLocalMs(snipePrepTargetSec)
        : snipePrepTargetSec * 1000 - Number(httpClient?.serverClockOffsetMs ?? 0))
    : Infinity
  const effectiveDeadlineAtMs = Math.min(
    Number.isFinite(tickDeadlineAtMs) ? tickDeadlineAtMs : Infinity,
    Number.isFinite(snipePrepDeadlineAtMs) ? snipePrepDeadlineAtMs : Infinity
  )

  let lastInLockWorld = null
  let stamRes = { staminaReserveFloor: 0, staminaReserveUntilSec: 0 }
  let effectiveConstraints = { ...baseUserConstraints }
  const forceSkipStability =
    Number(runtimeState?.consecutivePlanInvalid || 0) >= 1 ||
    Number(runtimeState?.consecutiveDeferred || 0) >= 1
  const effectiveSolverOptions = forceSkipStability
    ? { ...solverOptions, checkHorizonStability: false }
    : solverOptions

  const controllerOut = await runControllerStep({
    adapter,
    journal,
    partnerJournal,
    lockRootDir,
    account,
    fetchWorldFn: async () => {
      const w = await fetchWorldFn()
      lastInLockWorld = w
      return w
    },
    fetchNeighborsFn: snipeScheduler?.isStealEnabled()
      ? async (w) => snipeScheduler.collectReadyNeighborBundlesForController(adapter, httpClient, w, {
          allowThiefBuffPurchase: baseUserConstraints.allowThiefBuffPurchase !== false,
          cashReserveFloor: Number(baseUserConstraints.cashReserveFloor || 0),
        })
      : null,
    fetchUpcomingNeighborsFn: snipeScheduler?.isStealEnabled()
      ? (w) => snipeScheduler.collectUpcomingTargetsForController(adapter, w)
      : null,
    fetchPartnerWorldFn,
    sendActFn: async ({ operation, actions, worldBefore }) => {
      const r = await httpClient.postJson('/api/pet/world/act', {
        rev: worldBefore.rev,
        operation,
        actions,
      })
      return { ok: r.ok, status: r.status, networkError: r.networkError, body: r.body }
    },
    sendVisitFn: async ({ operation, targetId, visitOp }) => {
      const entry = snipeScheduler?.data?.targets?.[String(targetId)] || null
      const tac = await executeWithTacticalLoadout({
        accountKey: account,
        lockRoot: lockRootDir,
        opponentId: targetId,
        mode: 'guard',
        knownOpponentLevel: entry?.level || null,
        storePath: profileStorePath,
        precomputedDecision: visitOp?.tacticalDecision || null,
        getGearFn: () => httpClient.getJson('/api/pet/battle/gear'),
        equipSlotFn: (slot, item) => httpClient.postJson('/api/pet/battle/equip', { slot, item }),
        actionFn: async () => {
          const r = await httpClient.postJson(`/api/pet/world/visit/${targetId}`, {
            operation,
            kind: 'all',
            i: 0,
          })
          return { ok: r.ok, status: r.status, networkError: r.networkError, body: r.body }
        },
      })
      if (tac.preEquipError || !tac.result) {
        return { ok: false, status: 409, networkError: false, body: { error: tac.preEquipError || 'pre-equip-aborted' } }
      }
      return tac.result
    },
    onVisitReceiptFn: ({ targetId, rawResp }) => {
      snipeScheduler?.recordSnipeReceipt(adapter, targetId, rawResp, httpClient.estimatedServerNowSec(), {
        visitorWorld: lastInLockWorld,
      })
    },
    onReconciledVisitFn: (info) => {
      snipeScheduler?.recordReconciledVisit(info)
    },
    objectiveCfg,
    userConstraints: (inLockWorld) => {
      const nowW = Number(inLockWorld?.now || httpClient.estimatedServerNowSec())
      const capexDue = Boolean(baseUserConstraints.allowCapex) && (
        Boolean(runtimeState?.pendingCapex) ||
        (nowW - Number(runtimeState?.lastCapexEvalAtSec || 0)) >= 600
      )
      if (capexDue && runtimeState) {
        runtimeState.lastCapexEvalAtSec = nowW
      }
      effectiveConstraints = {
        ...baseUserConstraints,
        allowCapex: capexDue,
        staminaReserveFloor: Number(baseUserConstraints.staminaReserveFloor || 0),
        staminaReserveUntilSec: Number(baseUserConstraints.staminaReserveUntilSec || 0),
      }
      return effectiveConstraints
    },
    solverOptions: effectiveSolverOptions,
    asyncPlanner: activePlanner,
    snipeScheduler,
    rulesPath: effectiveRulesPath,
    deadlineAtMs: effectiveDeadlineAtMs,
    arcadeStandbyOptions,
    shouldPreemptFn: () => {
      if (dryRun || !snipeScheduler?.isStealEnabled()) return null
      const curNext = snipeScheduler.nextExactUnlockInfo(httpClient.estimatedServerNowSec())
      if (!curNext) return null
      const reqLead = Math.ceil(snipeScheduler.computePhysicalPrepLeadSec(curNext.entry, adapter, httpClient) + 1)
      return curNext.leadSec <= reqLead ? `snipe-physical-prep-due:${curNext.targetId}` : null
    },
    nowMsFn: () => httpClient.nowMsFn(),
    dryRun,
  })

  if (controllerOut?.plan) {
    stamRes = {
      mode: 'unified-timeline',
      committedRaids: controllerOut.plan.raidSchedule?.committedRaids?.length || 0,
      committedUpcomingRaids: controllerOut.plan.committedUpcomingRaids?.length || 0,
      plannedPostBucketEnFloor: Number(controllerOut.plan.trunkBuckets?.[0]?.plannedPostBucketEnFloor || 0),
      staminaReserveFloor: Number(baseUserConstraints.staminaReserveFloor || 0),
      staminaReserveUntilSec: Number(baseUserConstraints.staminaReserveUntilSec || 0),
    }
  }

  if (runtimeState) {
    if (controllerOut?.status === 'plan-invalid') {
      runtimeState.consecutivePlanInvalid = Number(runtimeState.consecutivePlanInvalid || 0) + 1
    } else if (controllerOut?.status === 'confirmed' || controllerOut?.status === 'waiting') {
      runtimeState.consecutivePlanInvalid = 0
    }
    if (controllerOut?.status === 'deferred-by-deadline') {
      runtimeState.consecutiveDeferred = Number(runtimeState.consecutiveDeferred || 0) + 1
    } else if (controllerOut?.status === 'confirmed' || controllerOut?.status === 'waiting') {
      runtimeState.consecutiveDeferred = 0
    }
  }

  if (snipeScheduler?.isStealEnabled()) {
    if (
      !dryRun &&
      controllerOut?.plan &&
      controllerOut?.transactionKind !== 'visit' &&
      snipeScheduler.activeRaidSchedule?.planId !== controllerOut.plan.planId
    ) {
      snipeScheduler.syncCommittedRaidSchedule(controllerOut.plan, lastInLockWorld || controllerOut.world)
    }
    if (
      controllerOut?.status !== 'confirmed' &&
      lastInLockWorld &&
      controllerOut?.plan?.marginalContext &&
      (controllerOut.plan.marginalContext.sourceFarmDigest != null
        ? controllerOut.plan.marginalContext.sourceFarmDigest === computeStaticFarmStateDigest(lastInLockWorld)
        : (controllerOut.plan.marginalContext.sourceWorldRev == null ||
            controllerOut.plan.marginalContext.sourceWorldRev === (lastInLockWorld.rev ?? null)))
    ) {
      snipeScheduler.primeUnifiedBaseline(adapter, lastInLockWorld, controllerOut.plan.marginalContext, effectiveConstraints)
    } else if (controllerOut?.status === 'confirmed') {
      snipeScheduler.invalidateUnifiedBaseline?.()
    }
  }

  if (!dryRun && controllerOut?.status === 'standby-manual-arcade') {
    const nowArcSec = httpClient.estimatedServerNowSec()
    const standbyInfo = controllerOut.arcadeStandby || getManualArcadeStandbyInfo(
      lastInLockWorld || controllerOut.world,
      nowArcSec,
      arcadeStandbyOptions
    )
    return {
      phase: 'arcade-standby',
      account,
      controllerOut,
      staminaReservation: stamRes,
      arcadeStandby: standbyInfo,
      nextWakeSec: Number(controllerOut.nextWakeSec || Math.min(nowArcSec + 5, standbyInfo.resumeAtSec || (nowArcSec + 5))),
    }
  }

  // If an exact snipe reached its physical staging lead right as controller finished, run staged snipe in the same tick
  const urgentAfterSolve = await runUrgentStagedSnipeIfImminent(
    controllerOut?.status === 'deferred-by-deadline' ? initialSnipeStageTriggerSec : 0
  )
  if (urgentAfterSolve) {
    return {
      ...urgentAfterSolve,
      preemptedControllerOut: controllerOut,
    }
  }

  // If an urgent Domestic/Visit transaction just fired, re-enter loop promptly before background slices,
  // while strictly clamping `nextWakeSec` to any committed upcoming snipe's physical staging lead (and arena/npc/xian wakes)!
  if (!dryRun && controllerOut.status === 'confirmed') {
    const nowAfterTxSec = httpClient.estimatedServerNowSec()
    let confirmedWakeSec = Number(controllerOut.nextWakeSec || (nowAfterTxSec + (adapter.R.WORLD?.minGap || 2)))
    const goalClaimedInBatch = (controllerOut.compiled?.domesticBatch || []).some((x) => x?.a === 'goal')
    if (goalClaimedInBatch && runtimeState) {
      runtimeState.lastBattlePrepAtSec = 0
      confirmedWakeSec = Math.min(confirmedWakeSec, nowAfterTxSec + 2)
    }
    const nextSnipeAfterTx = snipeScheduler?.nextExactUnlockInfo(nowAfterTxSec)
    if (nextSnipeAfterTx) {
      const prepLeadAfterTx = snipeScheduler.computePhysicalPrepLeadSec(nextSnipeAfterTx.entry, adapter, httpClient)
      confirmedWakeSec = Math.min(
        confirmedWakeSec,
        Math.max(nowAfterTxSec + 1, nextSnipeAfterTx.unlockAt - Math.ceil(prepLeadAfterTx + 1))
      )
    }
    const nextHorizonAfterTx = snipeScheduler?.nextHorizonEntrySec?.(nowAfterTxSec)
    if (Number.isFinite(nextHorizonAfterTx)) {
      confirmedWakeSec = Math.min(confirmedWakeSec, Math.max(nowAfterTxSec + 1, Math.ceil(nextHorizonAfterTx)))
    }
    if (snipeScheduler?.needsScheduleRefresh?.()) {
      confirmedWakeSec = nowAfterTxSec
    } else {
      if ((runtimeState?.arenaRemaining || 0) > 0) {
        confirmedWakeSec = Math.min(confirmedWakeSec, nowAfterTxSec + 9)
      }
      if (Boolean(npcOptions?.enabled) && !snipeScheduler?.shouldBlockBackgroundWork(nowAfterTxSec)) {
        const npcWakeAfterTx = computeNextNpcWakeSec(
          adapter,
          lastInLockWorld || controllerOut.txResult?.worldAfter || controllerOut.world,
          nowAfterTxSec,
          { ...npcOptions, arcadeStandbyOptions }
        )
        if (Number.isFinite(npcWakeAfterTx)) {
          confirmedWakeSec = Math.min(confirmedWakeSec, Math.max(nowAfterTxSec + 2, npcWakeAfterTx))
        }
      }
      if (normalizedXian.enabled) {
        const xianWakeAfterTx = computeNextXianWakeSec(lastInLockWorld || controllerOut.world, nowAfterTxSec, normalizedXian)
        if (Number.isFinite(xianWakeAfterTx)) {
          confirmedWakeSec = Math.min(confirmedWakeSec, Math.max(nowAfterTxSec + 1, xianWakeAfterTx))
        }
      }
    }
    return {
      phase: 'controller-executed',
      account,
      controllerOut,
      staminaReservation: stamRes,
      nextWakeSec: confirmedWakeSec,
    }
  }

  // Phase C: Strictly Preemptible Background Maintenance Slice
  const nowBgSec = httpClient.estimatedServerNowSec()
  const backgroundReport = {
    blockedByImminentSnipe: false,
    petCare: null,
    battlePrep: null,
    arenaBout: null,
    huancai: null,
    xian: null,
    npc: null,
    discovery: null,
  }

  if (snipeScheduler?.shouldBlockBackgroundWork(nowBgSec)) {
    backgroundReport.blockedByImminentSnipe = true
  } else {
    // C.1: Pet Care FIRST (so any level-up `+3` stat points exist before battle gear/points!)
    const petDue = (nowBgSec - Number(runtimeState.lastPetCareAtSec || 0)) >= 180
    if (petDue) {
      backgroundReport.petCare = await syncPetCareFirst(httpClient, { dryRun })
      runtimeState.lastPetCareAtSec = httpClient.estimatedServerNowSec()
    }

    // C.2: Battle Profiles, Chests, Resting Gear & Multi-Pass Stat Points SECOND
    const gearState = readAccountGearState(account, lockRootDir)
    const battlePrepDue =
      Boolean(backgroundReport.petCare?.leveledUp) ||
      Boolean(gearState?.dirty) ||
      (httpClient.estimatedServerNowSec() - Number(runtimeState.lastBattlePrepAtSec || 0)) >= 120

    if (battlePrepDue && !snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec())) {
      backgroundReport.battlePrep = await syncBattleProfilesAndPreparation(httpClient, {
        accountKey: account,
        lockRoot: lockRootDir,
        storePath: profileStorePath,
        dryRun,
      })
      runtimeState.lastBattlePrepAtSec = httpClient.estimatedServerNowSec()
      const home = backgroundReport.battlePrep?.homeData
      if (home?.adopted) {
        const used = Number(home.today?.used || 0)
        const lim = Number(home.today?.limit ?? home.today?.drops ?? 30)
        runtimeState.arenaRemaining = Math.max(0, lim - used)
      }
    }

    // C.3: Single Preemptible Arena Bout THIRD (cooldown slept OUTSIDE gear lock!)
    if (
      (runtimeState.arenaRemaining == null || runtimeState.arenaRemaining > 0) &&
      !snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec())
    ) {
      const boutOut = await runSingleArenaBout(httpClient, {
        accountKey: account,
        lockRoot: lockRootDir,
        storePath: profileStorePath,
        lastBoutFinishedAtMs: runtimeState.lastBoutFinishedAtMs || 0,
        minBoutGapMs: 8500,
        shouldAbortFn: () => Boolean(snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec())),
        dryRun,
      })
      backgroundReport.arenaBout = boutOut
      if (boutOut.status === 'bout-completed' || boutOut.status === 'bout-rejected') {
        runtimeState.lastBoutFinishedAtMs = boutOut.finishedAtMs || httpClient.nowMsFn()
        if (runtimeState.arenaRemaining != null && boutOut.status === 'bout-completed') {
          runtimeState.arenaRemaining = Math.max(0, runtimeState.arenaRemaining - 1)
        }
        if (boutOut.chestMilestoneReached) {
          runtimeState.lastBattlePrepAtSec = 0
        }
      } else if (boutOut.status === 'daily-quota-complete' || boutOut.status === 'not-adopted') {
        runtimeState.arenaRemaining = 0
      }
    }

    // C.4: Huancai Daily 10D Floor FOURTH (`22:30 CST` cycle, `main` only by default)
    const huancaiDue = (httpClient.estimatedServerNowSec() - Number(runtimeState.lastHuancaiCheckAtSec || 0)) >= 600
    if (huancaiDue && !snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec())) {
      backgroundReport.huancai = await runHuancaiDailyCheck(httpClient, {
        accountKey: account,
        allowHuancaiFloor: account === 'main',
        cashReserveFloor: Number(effectiveConstraints.cashReserveFloor ?? 10),
        stateFilePath: huancaiStatePath,
        dryRun,
      })
      runtimeState.lastHuancaiCheckAtSec = httpClient.estimatedServerNowSec()
    }

    // C.5: Optional xs Xian Cultivation Slice (`--enable-xian`, default OFF; 100% isolated from main-island D-coins/stamina)
    const isArcadeStandbyNow = (w = lastInLockWorld || controllerOut.world) =>
      !dryRun && getManualArcadeStandbyInfo(w, httpClient.estimatedServerNowSec(), arcadeStandbyOptions).active

    if (normalizedXian.enabled && !snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec()) && !isArcadeStandbyNow()) {
      const xianHttpClient = Object.create(httpClient)
      xianHttpClient.getJson = async (url, ...rest) => {
        const data = await httpClient.getJson(url, ...rest)
        if (url === '/api/pet/world' && data?.state) {
          lastInLockWorld = data
        }
        return data
      }
      const xianOut = await runXianCultivationSlice({
        account,
        adapter,
        httpClient: xianHttpClient,
        journal,
        lockRootDir,
        observedWorld: lastInLockWorld || controllerOut.world || null,
        shouldAbortFn: () => Boolean(
          snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec()) ||
          isArcadeStandbyNow()
        ),
        xianOptions: normalizedXian,
        dryRun,
      })
      backgroundReport.xian = xianOut
      if (xianOut?.status === 'confirmed' && xianOut.worldAfter) {
        lastInLockWorld = xianOut.worldAfter
      }
      if (isArcadeStandbyNow()) {
        const nowArcSec = httpClient.estimatedServerNowSec()
        const standbyInfo = getManualArcadeStandbyInfo(lastInLockWorld || controllerOut.world, nowArcSec, arcadeStandbyOptions)
        backgroundReport.xian = {
          ...(xianOut || {}),
          status: 'standby-manual-arcade',
          reason: 'standby-manual-arcade',
          arcadeStandby: standbyInfo,
        }
        return {
          phase: 'arcade-standby',
          account,
          controllerOut,
          staminaReservation: stamRes,
          backgroundReport,
          arcadeStandby: standbyInfo,
          nextWakeSec: Math.min(nowArcSec + 5, standbyInfo.resumeAtSec || (nowArcSec + 5)),
        }
      }
    }

    // C.5b: Daily 52D Toy Stall Slice (`NPC.daily = 52`, `0` stamina, `0` D-coins, 10x Hard Gomoku `1.5×` + Card batches)
    const npcSliceOptions = { ...npcOptions, arcadeStandbyOptions }
    if (Boolean(npcOptions?.enabled) && !snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec()) && !isArcadeStandbyNow()) {
      const npcOut = await runNpcToyStallSlice({
        account,
        adapter,
        httpClient,
        journal,
        lockRootDir,
        observedWorld: lastInLockWorld || controllerOut.world || null,
        shouldAbortFn: () => Boolean(
          snipeScheduler?.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec()) ||
          isArcadeStandbyNow()
        ),
        npcOptions: npcSliceOptions,
        dryRun,
      })
      backgroundReport.npc = npcOut
      if (npcOut?.worldAfter) {
        lastInLockWorld = npcOut.worldAfter
      }
      if (!dryRun && (npcOut?.status === 'standby-manual-arcade' || isArcadeStandbyNow())) {
        const nowArcSec = httpClient.estimatedServerNowSec()
        const standbyInfo = npcOut?.arcadeStandby || getManualArcadeStandbyInfo(lastInLockWorld || controllerOut.world, nowArcSec, arcadeStandbyOptions)
        return {
          phase: 'arcade-standby',
          account,
          controllerOut,
          staminaReservation: stamRes,
          backgroundReport,
          arcadeStandby: standbyInfo,
          nextWakeSec: Number(npcOut?.nextNpcWakeSec || Math.min(nowArcSec + 5, standbyInfo.resumeAtSec || (nowArcSec + 5))),
        }
      }
    }

    // C.6: Incremental Neighbor Discovery Slice (`main` only, `<= 2` pages, `<= 4` probes)
    if (lastInLockWorld && snipeScheduler?.isStealEnabled() && !snipeScheduler.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec()) && !isArcadeStandbyNow()) {
      backgroundReport.discovery = await snipeScheduler.runIncrementalDiscoverySlice(adapter, httpClient, lastInLockWorld, {
        maxPages: 2,
        maxProbes: 4,
        preemptWindowSec: null,
        allowThiefBuffPurchase: effectiveConstraints.allowThiefBuffPurchase !== false,
        cashReserveFloor: Number(effectiveConstraints.cashReserveFloor || 0),
      })
    }
  }

  // Compute earliest wake timestamp across domestic schedule (`farmWakeSec`), physical snipe staging, arena, xian, and discovery
  const nowEndSec = httpClient.estimatedServerNowSec()
  const farmWakeSec = Number(controllerOut.nextWakeSec || (nowEndSec + 60))
  let nextWakeSec = farmWakeSec
  const nextSnipe = snipeScheduler?.nextExactUnlockInfo(nowEndSec)
  if (nextSnipe) {
    const prepLeadSec = snipeScheduler.computePhysicalPrepLeadSec(nextSnipe.entry, adapter, httpClient)
    nextWakeSec = Math.min(nextWakeSec, Math.max(nowEndSec + 1, nextSnipe.unlockAt - Math.ceil(prepLeadSec + 1)))
  }
  const nextHorizonSec = snipeScheduler?.nextHorizonEntrySec?.(nowEndSec)
  if (Number.isFinite(nextHorizonSec)) {
    nextWakeSec = Math.min(nextWakeSec, Math.max(nowEndSec + 1, Math.ceil(nextHorizonSec)))
  }
  const scheduleRefreshReason = snipeScheduler?.needsScheduleRefresh?.()
    ? (snipeScheduler.getScheduleRefreshReason?.() || 'schedule-refresh-due')
    : null
  if (backgroundReport.discovery?.status === 'ready-target-found' || scheduleRefreshReason) {
    nextWakeSec = nowEndSec
  } else if ((runtimeState.arenaRemaining || 0) > 0) {
    nextWakeSec = Math.min(nextWakeSec, nowEndSec + 9)
  } else if (snipeScheduler?.isStealEnabled() && snipeScheduler.data.discoveryCursor) {
    nextWakeSec = Math.min(nextWakeSec, nowEndSec + 15)
  }
  if (Boolean(npcOptions?.enabled) && !snipeScheduler?.shouldBlockBackgroundWork(nowEndSec)) {
    const npcWake = Number.isFinite(backgroundReport.npc?.nextNpcWakeSec)
      ? backgroundReport.npc.nextNpcWakeSec
      : computeNextNpcWakeSec(adapter, lastInLockWorld || controllerOut.world, nowEndSec, { ...npcOptions, arcadeStandbyOptions })
    if (Number.isFinite(npcWake)) {
      nextWakeSec = Math.min(nextWakeSec, Math.max(nowEndSec + 2, npcWake))
    }
  }
  if (normalizedXian.enabled) {
    const xianWake = Number.isFinite(backgroundReport.xian?.nextXianWakeSec)
      ? backgroundReport.xian.nextXianWakeSec
      : computeNextXianWakeSec(lastInLockWorld || controllerOut.world, nowEndSec, normalizedXian)
    if (Number.isFinite(xianWake)) {
      nextWakeSec = Math.min(nextWakeSec, Math.max(nowEndSec + 1, xianWake))
    }
  }

  // Proactive Idle PlanCache Pre-Warming: ONLY when `farmWakeSec` itself (never `xianWake` / `npcWake` / `arenaWake`!) is within 45s
  // and no snipe / schedule refresh is pending, pre-compute the farm wake plan in the background Worker!
  const prewarmSourceWorld = lastInLockWorld || backgroundReport.npc?.worldAfter || backgroundReport.xian?.worldAfter || controllerOut.world
  if (
    !dryRun &&
    activePlanner &&
    effectiveRulesPath &&
    controllerOut.status === 'waiting' &&
    prewarmSourceWorld &&
    !scheduleRefreshReason &&
    Number.isFinite(farmWakeSec) &&
    farmWakeSec > nowEndSec &&
    (farmWakeSec - nowEndSec) <= 45 &&
    !snipeScheduler?.shouldBlockBackgroundWork(nowEndSec)
  ) {
    try {
      const preWorld = adapter.advanceTimeOnly(prewarmSourceWorld, farmWakeSec)
      preWorld.rev = prewarmSourceWorld.rev
      const preStealUsed = journal ? journal.countOccupiedBudget('steal', adapter.R.isleIndex(preWorld.now)) : 0
      const preNeighbors = controllerOut.observedNeighbors || []
      const preUpcomingNeighbors = snipeScheduler?.isStealEnabled()
        ? snipeScheduler.collectUpcomingTargetsForController(adapter, preWorld)
        : (controllerOut.observedUpcomingNeighbors || [])
      const prePartnerWorld = controllerOut.observedPartnerWorld || null
      const preSoldLedger = controllerOut.soldLedger || new Map()
      const preConstraints = typeof effectiveConstraints === 'object' && effectiveConstraints !== null
        ? {
            ...baseUserConstraints,
            allowCapex: Boolean(baseUserConstraints.allowCapex) && (
              Boolean(runtimeState?.pendingCapex) ||
              (Number(preWorld.now) - Number(runtimeState?.lastCapexEvalAtSec || 0)) >= 600
            ),
            staminaReserveFloor: Number(baseUserConstraints.staminaReserveFloor || 0),
            staminaReserveUntilSec: Number(baseUserConstraints.staminaReserveUntilSec || 0),
          }
        : effectiveConstraints
      const preEnv = buildObservationEnvelope(adapter, {
        account,
        world: preWorld,
        neighborTargets: preNeighbors,
        upcomingNeighborTargets: preUpcomingNeighbors,
        partnerWorld: prePartnerWorld,
        knownSoldByIsleIndex: preSoldLedger,
        userConstraints: preConstraints,
        reservedBudgets: { stealUsedOrReservedThisIsleDay: preStealUsed },
      })
      activePlanner.precomputeInBackground({
        rulesPath: effectiveRulesPath,
        adapter,
        account,
        envelope: preEnv,
        objectiveCfg,
        neighborTargets: preNeighbors,
        solverOptions,
        runStability: false,
      })
    } catch {
      // Non-fatal background pre-warm
    }
  }

  return {
    phase: 'full-tick',
    account,
    controllerOut,
    staminaReservation: stamRes,
    backgroundReport,
    nextSnipe,
    farmWakeSec,
    scheduleRefreshReason,
    nextWakeSec,
  }
}

const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectMain) {
  await (async () => {
    const args = process.argv.slice(2)
    const hasFlag = (f) => args.includes(f)
    const getArg = (flag, defVal) => {
      const idx = args.indexOf(flag)
      return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defVal
    }

    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const account = getArg('--account', 'main')
    const baseUrl = getArg('--base-url', process.env.MEME_BASE_URL || 'https://52dmeme.com')
    const sessionDir = getArg('--session-dir', rootDir)
    const defaultSessionName = account === 'main' ? '.session.json' : `.session.${account}.json`
    const sessionPath = getArg('--session', process.env.SESSION_PATH || path.join(sessionDir, defaultSessionName))
    const partnerAccount = getArg('--partner-account', account === 'main' ? 'secondary' : 'main')
    const defaultPartnerSessionName = partnerAccount === 'main' ? '.session.json' : `.session.${partnerAccount}.json`
    const partnerSessionPath = getArg('--partner-session', path.join(sessionDir, defaultPartnerSessionName))
    const rulesPath = getArg('--rules', path.join(rootDir, 'rules/pet-world-rules.js'))
    const dataRootDir = getArg('--data-dir', path.join(rootDir, 'logs/live'))
    const selfIdsRaw = getArg('--self-ids', process.env.MEME_SELF_IDS || '')
    const selfIds = selfIdsRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    const domesticOnly = hasFlag('--domestic-only') || hasFlag('--no-steal') || account === 'secondary'
    const allowCapexFlag = hasFlag('--allow-capex')
    const noCapexFlag = hasFlag('--no-capex')
    const maxTickSolveMs = Math.max(1000, Number(getArg('--max-tick-solve-ms', '45000')) || 45000)
    const dryRun = hasFlag('--dry-run')
    const once = hasFlag('--once')
    const checkUpdateOnly = hasFlag('--check-update')
    const noUpdateCheck = hasFlag('--no-update-check')
    const updateWebhookUrl = getArg('--update-webhook', process.env.MEME_UPDATE_WEBHOOK_URL || '')
    const enableXian = hasFlag('--enable-xian') || process.env.MEME_ENABLE_XIAN === '1'
    const xianBreakMode = getArg('--xian-break-mode', process.env.MEME_XIAN_BREAK_MODE || 'smart')
    const xianAutoFuse = hasFlag('--xian-auto-fuse') || process.env.MEME_XIAN_AUTO_FUSE === '1'
    const xianFuseTarget = getArg('--xian-fuse-target', process.env.MEME_XIAN_FUSE_TARGET || 'auto')
    const xianAutoAll = hasFlag('--xian-opt3') || hasFlag('--xian-auto-all') || process.env.MEME_XIAN_AUTO_ALL === '1'
    const xianAutoEvents = hasFlag('--xian-auto-events') || process.env.MEME_XIAN_AUTO_EVENTS === '1'
    const xianAutoSocial = hasFlag('--xian-auto-social') || process.env.MEME_XIAN_AUTO_SOCIAL === '1'
    const xianAutoDuel = hasFlag('--xian-auto-duel') || process.env.MEME_XIAN_AUTO_DUEL === '1'
    const xianAutoRealm = hasFlag('--xian-auto-realm') || process.env.MEME_XIAN_AUTO_REALM === '1'
    const npcOptions = { enabled: !hasFlag('--disable-npc') }
    const arcadeStandbyEnabled = !hasFlag('--disable-arcade-standby') && process.env.MEME_DISABLE_ARCADE_STANDBY !== '1'
    const arcadeStandbyTtlRaw = Number(getArg('--arcade-standby-ttl', process.env.MEME_ARCADE_STANDBY_TTL || '180'))
    const arcadeStandbyOptions = {
      enabled: arcadeStandbyEnabled,
      ttlSec: Number.isFinite(arcadeStandbyTtlRaw) && arcadeStandbyTtlRaw >= 10 ? arcadeStandbyTtlRaw : 180,
    }
    const xianOptions = normalizeXianOptions({
      enabled: enableXian,
      breakMode: xianBreakMode,
      autoFuse: xianAutoFuse,
      fuseTarget: xianFuseTarget,
      autoAll: xianAutoAll,
      autoEvents: xianAutoEvents,
      autoSocial: xianAutoSocial,
      autoDuel: xianAutoDuel,
      autoRealm: xianAutoRealm,
    })

    const updateNotifier = new UpdateNotifier({
      rootDir,
      stateFilePath: dryRun ? null : path.join(dataRootDir, 'update-status.json'),
      webhookUrl: updateWebhookUrl || null,
      enabled: !noUpdateCheck,
    })

    if (checkUpdateOnly) {
      const st = await updateNotifier.checkNow({ printBanner: true })
      if (!st.hasUpdate && !st.error) {
        console.log(`[UPDATE] 当前已是最新版本 v${st.localVersion}（checkedAt=${st.checkedAt}）`)
      }
      console.log(JSON.stringify(st, null, 2))
      return
    }

    const journalRootDir = path.join(dataRootDir, 'journal')
    const partnerJournalDir = path.join(journalRootDir, partnerAccount)
    const lockRootDir = path.join(dataRootDir, 'locks')
    const profileStorePath = getArg('--opponent-profiles', path.join(dataRootDir, 'opponent-profiles.json'))
    const scheduleFilePath = path.join(dataRootDir, `snipe-schedule.${account}.json`)
    const huancaiStatePath = path.join(dataRootDir, `huancai-state.${account}.json`)

    const httpClient = new KernelHttpClient({
      baseUrl,
      sessionFilePath: sessionPath,
      dryRun,
    })
    const partnerHttpClient = fs.existsSync(partnerSessionPath)
      ? new KernelHttpClient({ baseUrl, sessionFilePath: partnerSessionPath, dryRun: true })
      : null

    const adapter = await loadRulesAdapterFromFile(rulesPath)
    const journal = dryRun ? null : new ContentAddressedJournal({ rootDir: journalRootDir, account })
    const partnerJournal = (!dryRun && (fs.existsSync(partnerJournalDir) || fs.existsSync(partnerSessionPath)))
      ? new ContentAddressedJournal({ rootDir: journalRootDir, account: partnerAccount })
      : null

    const snipeScheduler = new SnipeScheduler({
      accountKey: account,
      scheduleFilePath: dryRun ? null : scheduleFilePath,
      profileStorePath,
      gearLockRoot: lockRootDir,
      selfIds,
      domesticOnly,
      minStealSpots: domesticOnly ? 999999 : 1,
    })

    const effectiveAllowCapex = noCapexFlag ? false : (allowCapexFlag ? true : domesticOnly)
    const baseUserConstraints = !domesticOnly
      ? {
          allowCapex: effectiveAllowCapex,
          minStealSpots: 0,
          allowThiefBuffPurchase: true,
          allowGuardBuffPurchase: false,
          cashReserveFloor: 10,
        }
      : {
          domesticOnly: true,
          allowCapex: effectiveAllowCapex,
          capexTargets: { plotsMax: 24, barnMax: 8, trapsMax: 4, houseMax: 0, toolsMax: { rod: 4, pick: 4, spr: 3 } },
          maxStealsPerIsleDay: 0,
          minStealSpots: 999999,
          allowThiefBuffPurchase: false,
          allowGuardBuffPurchase: false,
          cashReserveFloor: 0,
        }

    const asyncPlanner = new AsyncPlanManager({ rulesPath })
    const runtimeState = {
      rulesPath,
      asyncPlanner,
      lastPetCareAtSec: 0,
      lastBattlePrepAtSec: 0,
      lastBoutFinishedAtMs: 0,
      lastHuancaiCheckAtSec: 0,
      lastCapexEvalAtSec: 0,
      pendingCapex: false,
      arenaRemaining: null,
      consecutivePlanInvalid: 0,
      consecutiveDeferred: 0,
    }

    let stopping = false
    process.on('SIGTERM', () => { stopping = true })
    process.on('SIGINT', () => { stopping = true })

    if (once) {
      await updateNotifier.checkNow({ printBanner: true }).catch(() => null)
      const res = await runLiveAccountTick({
        account,
        adapter,
        httpClient,
        partnerHttpClient,
        journal,
        partnerJournal,
        snipeScheduler,
        lockRootDir,
        profileStorePath,
        huancaiStatePath,
        runtimeState,
        baseUserConstraints,
        asyncPlanner,
        rulesPath,
        maxTickSolveMs,
        xianOptions,
        npcOptions,
        arcadeStandbyOptions,
        dryRun,
      })
      await asyncPlanner.close()
      console.log(JSON.stringify({
        version: updateNotifier.localVersion,
        account,
        dryRun,
        phase: res.phase,
        controllerStatus: res.controllerOut?.status ?? null,
        planSource: res.controllerOut?.planSource ?? null,
        diagnostics: res.controllerOut?.diagnostics ?? null,
        staminaReservation: res.staminaReservation ?? null,
        backgroundReport: res.backgroundReport ?? null,
        nextWakeSec: res.nextWakeSec,
        httpStats: httpClient.stats,
        plannerStats: asyncPlanner.stats,
        updateStatus: updateNotifier.status,
      }, null, 2))
      return
    }

    const pidFilePath = path.join(dataRootDir, `live-daemon.${account}.pid`)
    if (!dryRun) {
      fs.mkdirSync(dataRootDir, { recursive: true })
      fs.writeFileSync(pidFilePath, `${process.pid}\n`, 'utf8')
    }
    const xianOpt3Tags = [
      xianOptions.autoEvents ? 'ev' : '',
      xianOptions.autoSocial ? 'soc' : '',
      xianOptions.autoDuel ? 'duel' : '',
      xianOptions.autoRealm ? 'rlm' : '',
    ].filter(Boolean)
    const xianBootTag = xianOptions.enabled
      ? `on(break=${xianOptions.breakMode},fuse=${xianOptions.autoFuse ? xianOptions.fuseTarget : 'off'}${xianOpt3Tags.length ? `,opt3=${xianOpt3Tags.join('+')}` : ''})`
      : 'off'
    console.log(`[${new Date().toISOString()}] [LIVE:${account}] kernel=v${updateNotifier.localVersion} xian=${xianBootTag} started pid=${process.pid}`)
    updateNotifier.maybeCheckInBackground()

    try {
      while (!stopping) {
        let sleepMs = 5000
        try {
          const res = await runLiveAccountTick({
            account,
            adapter,
            httpClient,
            partnerHttpClient,
            journal,
            partnerJournal,
            snipeScheduler,
            lockRootDir,
            profileStorePath,
            huancaiStatePath,
            runtimeState,
            baseUserConstraints,
            asyncPlanner,
            rulesPath,
            maxTickSolveMs,
            xianOptions,
            npcOptions,
            arcadeStandbyOptions,
            dryRun,
          })
          const nowSec = httpClient.estimatedServerNowSec()
          const nowServerMs = typeof httpClient.estimatedServerNowMs === 'function'
            ? httpClient.estimatedServerNowMs()
            : nowSec * 1000
          const targetWakeSec = Number(res.nextWakeSec || (nowSec + 15))
          const rawSleepMs = Math.ceil(targetWakeSec * 1000 + 150 - nowServerMs)
          sleepMs = Math.max(250, Math.min(120000, rawSleepMs))
          const deltaSec = Number((sleepMs / 1000).toFixed(2))
          if (!snipeScheduler.shouldBlockBackgroundWork(nowSec, 50)) {
            updateNotifier.maybeCheckInBackground()
          }
          const diag = res.controllerOut?.diagnostics
          const diagParts = []
          if (diag?.solveElapsedMs != null && res.controllerOut?.planSource === 'solved') {
            diagParts.push(`solve=${diag.solveElapsedMs}ms`)
          }
          if (diag?.recoveredFromCheckpoint) {
            diagParts.push('ckpt=1')
          }
          if (diag?.truncatedByTransition) {
            diagParts.push('transSalvage=1')
          }
          if (res.controllerOut?.status === 'plan-invalid') {
            diagParts.push(`drift=${diag?.clockDriftSec ?? '?'}s`)
            diagParts.push(`reason=${diag?.failedReason || 'unknown'}`)
            if (diag?.failedAction?.a) diagParts.push(`failedAct=${diag.failedAction.a}`)
          } else if (res.controllerOut?.status === 'deferred-by-deadline' && res.controllerOut?.abortReason) {
            diagParts.push(`abort=${res.controllerOut.abortReason}`)
          } else if (res.controllerOut?.status === 'stale-plan-invalidated') {
            diagParts.push(`rev=${res.controllerOut.expectedRev}->${res.controllerOut.actualRev}`)
          }
          const diagTag = diagParts.length > 0 ? ` ${diagParts.join(' ')}` : ''
          const xianRes = res.backgroundReport?.xian
          const xianTickTag = xianRes?.status === 'confirmed'
            ? ` xian=act(${xianRes.actions?.length || 0})`
            : xianRes?.reason === 'prologue-manual-standby'
              ? ' xian=standby(prologue)'
              : xianRes?.reason === 'manual-fight-in-progress'
                ? ' xian=yield(fight)'
                : xianRes?.reason === 'manual-realm-in-progress'
                  ? ' xian=yield(realm)'
                  : ''
          const npcRes = res.backgroundReport?.npc
          const npcTickTag = npcRes?.status === 'confirmed'
            ? ` npc=act(${npcRes.actions?.length || 0})`
            : (npcRes?.status === 'rejected' || npcRes?.status === 'unknown' || npcRes?.status === 'blocked-pending-unknown')
              ? ` npc=${npcRes.status}`
              : ''
          const arcRes = res.arcadeStandby
          const arcTickTag = (res.phase === 'arcade-standby' || arcRes?.active)
            ? ` arc=yield(${arcRes?.game || 'unknown'},rem=${arcRes?.remainingSec ?? '?'}s)`
            : ''
          console.log(
            `[${new Date().toISOString()}] [LIVE:${account}] phase=${res.phase} status=${res.controllerOut?.status ?? res.stagedOut?.status} src=${res.controllerOut?.planSource ?? '-'} sleep=${deltaSec}s GETs=${httpClient.stats.getCount} POSTs=${httpClient.stats.postCount}${diagTag}${xianTickTag}${npcTickTag}${arcTickTag}${updateNotifier.inlineTag()}`
          )
        } catch (err) {
          console.error(`[${new Date().toISOString()}] [LIVE:${account}:ERROR] ${err?.stack || err}`)
          sleepMs = 10000
        }
        let rem = sleepMs
        while (rem > 0 && !stopping) {
          const chunk = Math.min(500, rem)
          await new Promise((r) => setTimeout(r, chunk))
          rem -= chunk
        }
      }
    } finally {
      await asyncPlanner.close()
      try {
        if (!dryRun && fs.existsSync(pidFilePath)) {
          const curPid = fs.readFileSync(pidFilePath, 'utf8').trim()
          if (curPid === String(process.pid)) fs.unlinkSync(pidFilePath)
        }
      } catch {}
    }
  })()
}
