import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
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
  dryRun = false,
}) {
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
    })
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
      stamRes = snipeScheduler?.isStealEnabled()
        ? snipeScheduler.computeImminentSnipeStaminaReservation(adapter, inLockWorld, inLockWorld.now)
        : { staminaReserveFloor: 0, staminaReserveUntilSec: 0 }
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
        staminaReserveFloor: Math.max(
          Number(baseUserConstraints.staminaReserveFloor || 0),
          stamRes.staminaReserveFloor
        ),
        staminaReserveUntilSec: Math.max(
          Number(baseUserConstraints.staminaReserveUntilSec || 0),
          stamRes.staminaReserveUntilSec
        ),
      }
      return effectiveConstraints
    },
    solverOptions,
    asyncPlanner: activePlanner,
    rulesPath: effectiveRulesPath,
    deadlineAtMs: effectiveDeadlineAtMs,
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

  if (snipeScheduler?.isStealEnabled()) {
    if (
      controllerOut?.status !== 'confirmed' &&
      lastInLockWorld &&
      controllerOut?.plan?.marginalContext &&
      (controllerOut.plan.marginalContext.sourceWorldRev == null ||
        controllerOut.plan.marginalContext.sourceWorldRev === (lastInLockWorld.rev ?? null))
    ) {
      snipeScheduler.primeUnifiedBaseline(adapter, lastInLockWorld, controllerOut.plan.marginalContext, effectiveConstraints)
    } else if (controllerOut?.status === 'confirmed') {
      snipeScheduler.invalidateUnifiedBaseline?.()
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

  // If an urgent Domestic/Visit transaction just fired, re-enter loop promptly before background slices
  if (!dryRun && controllerOut.status === 'confirmed') {
    return {
      phase: 'controller-executed',
      account,
      controllerOut,
      staminaReservation: stamRes,
      nextWakeSec: controllerOut.nextWakeSec,
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

    // C.5: Incremental Neighbor Discovery Slice FIFTH (`main` only, `<= 2` pages, `<= 4` probes)
    if (lastInLockWorld && snipeScheduler?.isStealEnabled() && !snipeScheduler.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec())) {
      backgroundReport.discovery = await snipeScheduler.runIncrementalDiscoverySlice(adapter, httpClient, lastInLockWorld, {
        maxPages: 2,
        maxProbes: 4,
        preemptWindowSec: null,
        allowThiefBuffPurchase: effectiveConstraints.allowThiefBuffPurchase !== false,
        cashReserveFloor: Number(effectiveConstraints.cashReserveFloor || 0),
      })
    }
  }

  // Compute earliest wake timestamp across domestic schedule, physical snipe staging (`unlockAt - ceil(T_prep + 1)`), arena, and discovery
  const nowEndSec = httpClient.estimatedServerNowSec()
  let nextWakeSec = Number(controllerOut.nextWakeSec || (nowEndSec + 60))
  const nextSnipe = snipeScheduler?.nextExactUnlockInfo(nowEndSec)
  if (nextSnipe) {
    const prepLeadSec = snipeScheduler.computePhysicalPrepLeadSec(nextSnipe.entry, adapter, httpClient)
    nextWakeSec = Math.min(nextWakeSec, Math.max(nowEndSec + 1, nextSnipe.unlockAt - Math.ceil(prepLeadSec + 1)))
  }
  if (backgroundReport.discovery?.status === 'ready-target-found') {
    nextWakeSec = nowEndSec
  } else if ((runtimeState.arenaRemaining || 0) > 0) {
    nextWakeSec = Math.min(nextWakeSec, nowEndSec + 9)
  } else if (snipeScheduler?.isStealEnabled() && snipeScheduler.data.discoveryCursor) {
    nextWakeSec = Math.min(nextWakeSec, nowEndSec + 15)
  }

  // Proactive Idle PlanCache Pre-Warming: when waiting for an upcoming domestic maturity within 30s and
  // no snipe is imminent, pre-compute the next plan in the background Worker so wake execution hits PlanCache in <1ms!
  if (
    !dryRun &&
    activePlanner &&
    effectiveRulesPath &&
    controllerOut.status === 'waiting' &&
    controllerOut.world &&
    nextWakeSec > nowEndSec &&
    (nextWakeSec - nowEndSec) <= 30 &&
    !snipeScheduler?.shouldBlockBackgroundWork(nowEndSec)
  ) {
    try {
      const preWorld = adapter.advanceTimeOnly(controllerOut.world, nextWakeSec)
      preWorld.rev = controllerOut.world.rev
      const preStealUsed = journal ? journal.countOccupiedBudget('steal', adapter.R.isleIndex(preWorld.now)) : 0
      const preEnv = buildObservationEnvelope(adapter, {
        account,
        world: preWorld,
        neighborTargets: [],
        partnerWorld: null,
        knownSoldByIsleIndex: new Map(),
        userConstraints: effectiveConstraints,
        reservedBudgets: { stealUsedOrReservedThisIsleDay: preStealUsed },
      })
      activePlanner.precomputeInBackground({
        rulesPath: effectiveRulesPath,
        adapter,
        account,
        envelope: preEnv,
        objectiveCfg,
        neighborTargets: [],
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
    console.log(`[${new Date().toISOString()}] [LIVE:${account}] kernel=v${updateNotifier.localVersion} started pid=${process.pid}`)
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
            dryRun,
          })
          const nowSec = httpClient.estimatedServerNowSec()
          const deltaSec = Math.max(1, Math.min(120, Number(res.nextWakeSec || (nowSec + 15)) - nowSec))
          sleepMs = deltaSec * 1000
          if (!snipeScheduler.shouldBlockBackgroundWork(nowSec, 50)) {
            updateNotifier.maybeCheckInBackground()
          }
          console.log(
            `[${new Date().toISOString()}] [LIVE:${account}] phase=${res.phase} status=${res.controllerOut?.status ?? res.stagedOut?.status} src=${res.controllerOut?.planSource ?? '-'} sleep=${deltaSec}s GETs=${httpClient.stats.getCount} POSTs=${httpClient.stats.postCount}${updateNotifier.inlineTag()}`
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
