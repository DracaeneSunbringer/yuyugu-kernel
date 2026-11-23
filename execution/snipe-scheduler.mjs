import fs from 'node:fs'
import path from 'node:path'
import {
  computeStaticFarmStateDigest,
  getManualArcadeStandbyInfo,
  normalizeUserConstraints,
} from '../model/observations.mjs'
import {
  createUnifiedRaidEvaluator,
  discoverRuleUtilityTokens,
  findCheapestRaidStaminaPrep,
} from '../planner/solve.mjs'
import {
  computeGuardPosteriorForTarget,
  executeWithTacticalLoadout,
  readAccountGearState,
  recordBattleSnapshot,
  syncGuardLogProfiles,
} from './combat-engine.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld, withAccountLock } from './reconcile.mjs'

/**
 * Precision Neighbor Snipe Scheduler, Physical-Cooldown Pre-Unlock Staging & Incremental Discovery (`execution/snipe-scheduler.mjs`)
 *
 * Single Unified Economic Brain:
 * 1. Exact Cross-Weather / Barn Unlock Timing (`adapter.exactPlotTimings` + `adapter.exactBarnTimings` with server `rules.protect = 1800`)
 *    with ZERO artificial wave-coalescing delay (`coalesceUnlockWindowSec` removed: raids at the earliest chronological `candT` with positive unified EV).
 * 2. Fast (`< 5ms`) Resident Unified Evaluation (`createUnifiedRaidEvaluator`):
 *    - Reuses the exact domestic baseline (`solveJointCraftAndSell` + cross-day crop tiers + terminal liquidation + non-craft stamina curve),
 *    - Evaluates the 4-outcome guard loot distribution (`1 - pDet` `lootBag`, `pDet * pWin` `guardWinLootBag` `+1/spot`, `pDet * pDraw` `0`, `pDet * pLoss` `-fine`),
 *    - Caches optimal combat loadout `(weapon, armor, charm)` & `(pWin, pDraw, pLoss)` from `computeGuardPosteriorForTarget`.
 * 3. Physical Cooldown Staging (`computePhysicalPrepLeadSec` + `executeStagedSnipe`):
 *    - Derives staging lead time `T_prep` strictly from actual physical action cooldowns (`minGap + RTT` when `prepActs` needed + `numGearChanges * equipGap + RTT`),
 *    - Reuses `precomputedDecision` in `executeWithTacticalLoadout` (`0` redundant 2,000-trial re-simulations at `T_unlock`),
 *    - Conditional-independence loss handling: battle losses refresh opponent fighter snapshots (`recordBattleSnapshot` / `needsGuardLogSync`) without a dogmatic 2-loss 20-minute ban.
 */

const _syncWaitArr = new Int32Array(new SharedArrayBuffer(4))

function syncSleepMs(ms) {
  if (ms > 0) Atomics.wait(_syncWaitArr, 0, 0, Math.ceil(ms))
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function renameWithRetrySync(tmpPath, targetPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath)
      return
    } catch (err) {
      if ((err?.code === 'EPERM' || err?.code === 'EACCES') && attempt < 2) {
        syncSleepMs(10)
        continue
      }
      throw err
    }
  }
}

function defaultScheduleData() {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    discoveryCursor: null,
    lastMarkedSyncAtSec: 0,
    lastHeadScanAtSec: 0,
    targets: {},
  }
}

function defaultSharedScanData() {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    discoveryCursor: null,
    cursorLeaseUntilSec: 0,
    cursorLeaseBy: null,
    lastMarkedSyncAtSec: 0,
    lastHeadScanAtSec: 0,
    pendingDirItems: {},
    islands: {},
  }
}

function loadSharedScanSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return defaultSharedScanData()
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
    if (parsed && typeof parsed === 'object') {
      return {
        ...defaultSharedScanData(),
        ...parsed,
        pendingDirItems: parsed.pendingDirItems && typeof parsed.pendingDirItems === 'object' ? parsed.pendingDirItems : {},
        islands: parsed.islands && typeof parsed.islands === 'object' ? parsed.islands : {},
      }
    }
  } catch {}
  return defaultSharedScanData()
}

function mutateSharedScanSync(filePath, mutatorFn, { timeoutMs = 5000, retryMs = 15 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const lockFile = `${filePath}.lock`
  const gateFile = `${lockFile}.gate`
  const deadline = Date.now() + timeoutMs
  let acquired = false

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
      fs.closeSync(fd)
      acquired = true
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      try {
        const gfd = fs.openSync(gateFile, 'wx')
        try {
          const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
          if (raw && !isPidAlive(raw.pid)) {
            fs.unlinkSync(lockFile)
          }
        } catch {} finally {
          fs.closeSync(gfd)
          try { fs.unlinkSync(gateFile) } catch {}
        }
      } catch {}
      syncSleepMs(retryMs)
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire shared scan lock for ${filePath} within ${timeoutMs}ms`)
  }

  try {
    const shared = loadSharedScanSync(filePath)
    const out = mutatorFn(shared)
    const shouldSave = out?.save !== false
    if (shouldSave) {
      const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
      fs.writeFileSync(tmp, JSON.stringify(shared, null, 2), 'utf8')
      renameWithRetrySync(tmp, filePath)
    }
    return out?.result !== undefined ? out.result : shared
  } finally {
    try { fs.unlinkSync(lockFile) } catch {}
  }
}

function compactVisitSnapshot(visitData, owner, nowSec, fallbackClockStart = 0) {
  if (!visitData?.isle) return null
  return {
    now: Number.isFinite(Number(visitData.now)) && Number(visitData.now) > 0
      ? Math.floor(Number(visitData.now))
      : nowSec,
    clockStart: Number(visitData.clockStart || fallbackClockStart || 0),
    owner: {
      id: Number(owner?.id ?? visitData.owner?.id ?? 0),
      name: owner?.name || visitData.owner?.name || '',
      level: Number(owner?.level ?? visitData.owner?.level ?? 1),
      guard: Boolean(owner?.guard ?? visitData.owner?.guard),
      newbie: Boolean(owner?.newbie ?? visitData.owner?.newbie),
      boost: Number(owner?.boost ?? visitData.owner?.boost ?? 0),
      spr: owner?.spr ?? visitData.owner?.spr ?? null,
    },
    rules: visitData.rules ? { ...visitData.rules } : { protect: 1800, perPlot: 2, perPen: 2 },
    isle: {
      plots: Array.isArray(visitData.isle?.plots) ? visitData.isle.plots : [],
      barn: Array.isArray(visitData.isle?.barn) ? visitData.isle.barn : [],
      plotN: visitData.isle?.plotN,
      barnN: visitData.isle?.barnN,
    },
    state: {
      tools: visitData.state?.tools ? { spr: Number(visitData.state.tools.spr || 0) } : undefined,
      plots: Array.isArray(visitData.state?.plots) ? visitData.state.plots : [],
      barn: Array.isArray(visitData.state?.barn) ? visitData.state.barn : [],
      b12: visitData.state?.b12?.effects ? { effects: visitData.state.b12.effects } : undefined,
    },
  }
}

export class SnipeScheduler {
  constructor({
    accountKey = 'main',
    scheduleFilePath = null,
    sharedScanFilePath = null,
    profileStorePath = null,
    gearLockRoot = null,
    selfIds = [],
    domesticOnly = undefined,
    minStealSpots = 1,
    controllerHorizonSec = 3600,
    maxUpcomingTargets = 10,
    maxReadyProbes = 4,
  } = {}) {
    this.accountKey = accountKey
    this.scheduleFilePath = scheduleFilePath
    this.sharedScanFilePath = sharedScanFilePath
    this.profileStorePath = profileStorePath
    this.gearLockRoot = gearLockRoot
    this.selfIds = new Set((selfIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))
    this.domesticOnly = domesticOnly !== undefined ? Boolean(domesticOnly) : (accountKey === 'secondary')
    this.minStealSpots = this.domesticOnly ? 999999 : Math.max(1, Number(minStealSpots || 1))
    this.controllerHorizonSec = Math.max(60, Number(controllerHorizonSec || 3600))
    this.maxUpcomingTargets = Math.max(1, Number(maxUpcomingTargets || 10))
    this.maxReadyProbes = Math.max(1, Number(maxReadyProbes || 4))
    this.data = this._load()
    // Keep most recent raw `visit` snapshots in memory so `runControllerStep` & `executeStagedSnipe` get exact `isle` + `posterior`
    this._liveVisitBundles = new Map()
    this._evaluatorCache = { key: null, evaluator: null }
    this.activeRaidSchedule = null
    this._lastSharedScanMtimeMs = -1
    this._lastSharedScanSize = -1
    this._lastVisitorWorld = null
  }

  syncCommittedRaidSchedule(plan, world = null) {
    if (!this.isStealEnabled()) {
      this.activeRaidSchedule = null
      return null
    }
    const rs = plan?.raidSchedule
    if (!rs || typeof rs !== 'object') {
      return this.activeRaidSchedule
    }
    const nowRefSec = Number(world?.now ?? plan?.serverNow ?? rs?.createdAtSec ?? 0)
    const incomingRaids = Array.isArray(rs.committedRaids) ? rs.committedRaids : []
    if (rs.truncatedByDeadline && incomingRaids.length === 0 && this.activeRaidSchedule) {
      const keptRaids = (this.activeRaidSchedule.committedRaids || []).filter(
        (r) => Number(r?.unlockAtSec || 0) > nowRefSec - 2
      )
      const committedByTargetId = new Map()
      const committedWavesByTargetId = new Map()
      for (const cr of keptRaids) {
        const tid = Number(cr?.targetId)
        if (!Number.isFinite(tid)) continue
        const list = committedWavesByTargetId.get(tid) || []
        list.push(cr)
        committedWavesByTargetId.set(tid, list)
      }
      for (const [tid, list] of committedWavesByTargetId.entries()) {
        list.sort((a, b) => Number(a.unlockAtSec || 0) - Number(b.unlockAtSec || 0))
        committedByTargetId.set(tid, list[0])
      }
      this.activeRaidSchedule = {
        ...this.activeRaidSchedule,
        committedByTargetId,
        committedWavesByTargetId,
        committedRaids: keptRaids,
        needsRefresh: true,
        refreshReason: 'previous-solve-truncated-by-deadline',
      }
      return this.activeRaidSchedule
    }

    const evaluatedTargetSet = new Set((rs.evaluatedTargetIds || []).map(Number).filter(Number.isFinite))
    const committedByTargetId = new Map()
    const committedWavesByTargetId = new Map()
    for (const cr of incomingRaids) {
      const tid = Number(cr?.targetId)
      if (Number.isFinite(tid)) {
        const list = committedWavesByTargetId.get(tid) || []
        list.push(cr)
        committedWavesByTargetId.set(tid, list)
      }
    }
    for (const [tid, list] of committedWavesByTargetId.entries()) {
      list.sort((a, b) => Number(a.unlockAtSec || 0) - Number(b.unlockAtSec || 0))
      const firstCr = list[0]
      committedByTargetId.set(tid, firstCr)
      const key = String(tid)
      if (this.data?.targets?.[key] && !firstCr.isImmediate) {
        this.data.targets[key].plannedPrepActs = firstCr.plannedPrepActs || []
        if (firstCr.numGearChanges != null) {
          this.data.targets[key].numGearChanges = Number(firstCr.numGearChanges || 0)
        }
      }
    }
    this.activeRaidSchedule = {
      planId: rs.planId || plan?.planId || null,
      createdAtSec: Number(rs.createdAtSec ?? plan?.serverNow ?? world?.now ?? 0),
      sourceFarmDigest: rs.sourceFarmDigest || (world ? computeStaticFarmStateDigest(world) : null),
      evaluatedTargetSet,
      committedByTargetId,
      committedWavesByTargetId,
      committedRaids: [...incomingRaids],
      needsRefresh: false,
      refreshReason: null,
    }
    return this.activeRaidSchedule
  }

  needsScheduleRefresh() {
    return Boolean(this.activeRaidSchedule?.needsRefresh)
  }

  getScheduleRefreshReason() {
    return this.activeRaidSchedule?.refreshReason || null
  }

  _makeEvaluatorCacheKey(adapter, visitorWorld, constraints) {
    const rawNow = visitorWorld?.now
    const now = rawNow != null && Number.isFinite(Number(rawNow)) ? Number(rawNow) : null
    if (visitorWorld?.clockStart != null && adapter?.syncClock) {
      adapter.syncClock(visitorWorld.clockStart)
    }
    const staticDigest = computeStaticFarmStateDigest(visitorWorld)
    const prices = visitorWorld?.prices || {}
    const priceSig = Object.keys(prices).sort().map((k) => `${k}:${prices[k]}`).join(',')
    let isleIdxStr = '0'
    let worldDayStr = ''
    if (now !== null && adapter?.R) {
      try {
        if (adapter.R.isleIndex) isleIdxStr = String(adapter.R.isleIndex(now))
        if (adapter.R.worldDay) worldDayStr = String(adapter.R.worldDay(now))
      } catch {}
    }
    return [
      adapter?.rulesHash || '',
      staticDigest,
      isleIdxStr,
      worldDayStr,
      priceSig,
      Boolean(constraints?.domesticOnly),
      Number(constraints?.maxStealsPerIsleDay ?? 999999),
      Boolean(constraints?.allowThiefBuffPurchase ?? true),
      Number(constraints?.cashReserveFloor ?? 10),
    ].join('|')
  }

  invalidateUnifiedBaseline() {
    this._evaluatorCache = { key: null, evaluator: null }
  }

  _normalizeSchedulerConstraints(userConstraints = {}) {
    return normalizeUserConstraints({
      domesticOnly: this.domesticOnly,
      minStealSpots: this.domesticOnly ? 999999 : 0,
      ...userConstraints,
    }, this.accountKey)
  }

  primeUnifiedBaseline(adapter, visitorWorld, marginalContext, userConstraints = {}) {
    if (!this.isStealEnabled() || !adapter || !visitorWorld || !marginalContext) return null
    const now = Number(visitorWorld?.now || 0)
    const staticDigest = computeStaticFarmStateDigest(visitorWorld)
    const farmMismatch = marginalContext.sourceFarmDigest != null
      ? marginalContext.sourceFarmDigest !== staticDigest
      : (marginalContext.sourceWorldRev != null && visitorWorld?.rev != null && marginalContext.sourceWorldRev !== visitorWorld.rev)
    const isleMismatch = marginalContext.sourceIsleIndex != null
      && adapter?.R?.isleIndex
      && marginalContext.sourceIsleIndex !== adapter.R.isleIndex(now)
    const dayMismatch = marginalContext.sourceWorldDay != null
      && adapter?.R?.worldDay
      && marginalContext.sourceWorldDay !== adapter.R.worldDay(now)
    if (farmMismatch || isleMismatch || dayMismatch) {
      this.invalidateUnifiedBaseline()
      return null
    }
    if (visitorWorld?.state && Number.isFinite(Number(visitorWorld?.now))) {
      this._lastVisitorWorld = visitorWorld
    }
    const constraints = this._normalizeSchedulerConstraints(userConstraints)
    const key = this._makeEvaluatorCacheKey(adapter, visitorWorld, constraints)
    const evaluator = createUnifiedRaidEvaluator(adapter, visitorWorld, {
      account: this.accountKey,
      userConstraints: constraints,
      precomputedMarginalContext: marginalContext,
    })
    this._evaluatorCache = { key, evaluator }
    return evaluator
  }

  getUnifiedEvaluator(adapter, visitorWorld, { userConstraints = {} } = {}) {
    const effWorld = (
      visitorWorld?.state && Number.isFinite(Number(visitorWorld?.now))
        ? visitorWorld
        : (this._lastVisitorWorld?.state && Number.isFinite(Number(this._lastVisitorWorld?.now))
            ? this._lastVisitorWorld
            : visitorWorld)
    )
    if (!effWorld?.state || !Number.isFinite(Number(effWorld?.now))) {
      return null
    }
    if (effWorld.clockStart != null && adapter?.syncClock) {
      adapter.syncClock(effWorld.clockStart)
    }
    const constraints = this._normalizeSchedulerConstraints(userConstraints)
    const key = this._makeEvaluatorCacheKey(adapter, effWorld, constraints)
    if (this._evaluatorCache.key === key && this._evaluatorCache.evaluator) {
      return this._evaluatorCache.evaluator
    }
    const evaluator = createUnifiedRaidEvaluator(adapter, effWorld, {
      account: this.accountKey,
      userConstraints: constraints,
    })
    this._evaluatorCache = { key, evaluator }
    return evaluator
  }

  _pruneLiveVisitBundles(protectedId = null) {
    const maxTotal = 160
    const maxGearData = 32
    const committedIds = this.activeRaidSchedule?.committedByTargetId
    if (this._liveVisitBundles.size > maxTotal) {
      for (const id of this._liveVisitBundles.keys()) {
        if (this._liveVisitBundles.size <= maxTotal) break
        if (id === protectedId || committedIds?.has(id)) continue
        this._liveVisitBundles.delete(id)
      }
      if (this._liveVisitBundles.size > maxTotal) {
        for (const id of this._liveVisitBundles.keys()) {
          if (this._liveVisitBundles.size <= maxTotal) break
          if (id === protectedId) continue
          this._liveVisitBundles.delete(id)
        }
      }
    }
    if (this._liveVisitBundles.size > maxGearData) {
      let withGear = 0
      for (const rec of this._liveVisitBundles.values()) {
        if (rec?.gearData || rec?.observedPanels) withGear++
      }
      if (withGear > maxGearData) {
        for (const [id, rec] of this._liveVisitBundles.entries()) {
          if (withGear <= maxGearData) break
          if (id === protectedId || committedIds?.has(id)) continue
          if (rec?.gearData || rec?.observedPanels) {
            rec.gearData = null
            rec.observedPanels = null
            withGear--
          }
        }
        if (withGear > maxGearData) {
          for (const [id, rec] of this._liveVisitBundles.entries()) {
            if (withGear <= maxGearData) break
            if (id === protectedId) continue
            if (rec?.gearData || rec?.observedPanels) {
              rec.gearData = null
              rec.observedPanels = null
              withGear--
            }
          }
        }
      }
    }
  }

  computePhysicalPrepLeadSec(entry, adapter = null, httpClient = null) {
    const rttSec = Math.max(0.5, Math.min(2.0, Number(httpClient?.lastRttMs || 750) / 1000))
    const needPrepAct = (entry?.plannedPrepActs?.length || 0) > 0
    const gearSwaps = entry?.numGearChanges != null
      ? Math.max(0, Number(entry.numGearChanges || 0))
      : (entry?.guard ? 2 : 0)
    const minGapSec = Number(adapter?.R?.WORLD?.minGap || 2)
    const remActCdSec = needPrepAct
      ? Math.max(0, Number(httpClient?.getRemainingBucketCooldownMs?.('POST', '/api/pet/world/act') || 0) / 1000)
      : 0
    const remEquipCdSec = gearSwaps > 0
      ? Math.max(0, Number(httpClient?.getRemainingBucketCooldownMs?.('POST', '/api/pet/battle/equip') || 0) / 1000)
      : 0
    const remVisitCdSec = (!needPrepAct && gearSwaps === 0)
      ? Math.max(0, Number(httpClient?.getRemainingBucketCooldownMs?.('POST', `/api/pet/world/visit/${entry?.id || 0}`) || 0) / 1000)
      : 0
    const worldCheckSec = rttSec + 0.35
    const actPrepSec = needPrepAct ? (remActCdSec + minGapSec + rttSec + 0.5) : 0
    const perSwapSec = Math.max(1.25, rttSec + 0.35)
    const gearPrepSec = gearSwaps > 0
      ? (remEquipCdSec + rttSec + gearSwaps * perSwapSec + 0.6)
      : (entry?.guard ? (rttSec + 0.5) : 0.2)
    return worldCheckSec + actPrepSec + gearPrepSec + remVisitCdSec + 1.0
  }

  isStealEnabled() {
    return !this.domesticOnly && this.minStealSpots < 999999
  }

  _isEntryQuiescent(entry) {
    if (!entry) return true
    if (entry.readyEligible || entry.upcomingEligible) return false
    if (Number(entry.stealableCount || 0) > 0 || Number(entry.upcomingSpots || 0) > 0) return false
    if (entry.quiescentEmpty !== undefined) return Boolean(entry.quiescentEmpty)
    return Object.keys(entry.plotUnlockAt || {}).length === 0
  }

  _load() {
    if (!this.isStealEnabled() || !this.scheduleFilePath) return defaultScheduleData()
    try {
      if (fs.existsSync(this.scheduleFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.scheduleFilePath, 'utf8').replace(/^\uFEFF/, ''))
        if (parsed && typeof parsed.targets === 'object') {
          return { ...defaultScheduleData(), ...parsed }
        }
        // Also support importing legacy `entries` read-only if needed
        if (parsed && typeof parsed.entries === 'object') {
          const migrated = defaultScheduleData()
          for (const [k, e] of Object.entries(parsed.entries)) {
            if (!e || this.selfIds.has(Number(k))) continue
            migrated.targets[String(k)] = {
              id: Number(k),
              name: e.name || String(k),
              level: Number(e.level || 1),
              guard: Boolean(e.guard),
              readyEligible: Boolean(e.readyEligible),
              stealableCount: Number(e.stealableCount || 0),
              upcomingEligible: Boolean(e.upcomingEligible),
              upcomingSpots: Number((e.protectedRipeCount || 0) + (e.growingCount || 0)),
              expectedUnlockAt: e.expectedUnlockAt || null,
              exactUnlockKnown: Boolean(e.exactUnlockKnown),
              nextProbeAt: e.nextProbeAt || 0,
              blockedUntil: Number(e.blockedUntil || 0),
              blockedReason: e.blockedReason || null,
              cooldownUntil: 0,
              lossCount: Number(e.lossState?.count || 0),
              lastLossAtSec: Number(e.lossState?.lastAtSec || 0),
              needsGuardLogSync: false,
              overdueCount: 0,
              earlyRetryCount: 0,
              plotFirstRipeAt: e.plotFirstRipeAt || {},
              plotUnlockAt: e.plotUnlockAt || {},
              projectedScore: Number(e.estVal || 0),
              projectedEnergyCost: 8,
              updatedAt: Number(e.updatedAt || 0),
            }
          }
          return migrated
        }
      }
    } catch {}
    return defaultScheduleData()
  }

  save(nowSec = Math.floor(Date.now() / 1000)) {
    if (!this.isStealEnabled() || !this.scheduleFilePath) return
    this.data.updatedAt = nowSec
    fs.mkdirSync(path.dirname(this.scheduleFilePath), { recursive: true })
    const tmp = `${this.scheduleFilePath}.tmp.${process.pid}.${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.scheduleFilePath)
  }

  _readCachedGearContext() {
    if (!this.gearLockRoot) return { gearData: null, observedPanels: null }
    const st = readAccountGearState(this.accountKey, this.gearLockRoot)
    return {
      gearData: st?.gearSnap || null,
      observedPanels: st?.observedPanels || null,
    }
  }

  /**
   * Evaluates a `GET /api/pet/world/visit/:id` snapshot, updating both currently stealable belief
   * and exact upcoming multi-spot unlock schedule (`expectedUnlockAt`, `exactUnlockKnown`).
   */
  recordVisitSnapshot(adapter, visitorWorld, targetId, visitData, {
    gearData = null,
    observedPanels = null,
    allowThiefBuffPurchase = true,
    cashReserveFloor = 10,
    directoryActiveAt = 0,
    fromSharedScan = false,
    skipSave = false,
  } = {}) {
    if (!this.isStealEnabled() || !visitData?.isle) return null
    const idNum = Number(targetId)
    if (!Number.isFinite(idNum) || this.selfIds.has(idNum)) return null
    if (visitorWorld?.state && Number.isFinite(Number(visitorWorld?.now))) {
      this._lastVisitorWorld = visitorWorld
    }

    const nowSec = Number.isFinite(visitData.now) && visitData.now > 0
      ? Math.floor(visitData.now)
      : Math.floor(Number(visitorWorld?.now || Date.now() / 1000))
    if (visitData.clockStart) adapter.syncClock(visitData.clockStart)
    else if (visitorWorld?.clockStart) adapter.syncClock(visitorWorld.clockStart)

    const key = String(idNum)
    const prev = this.data.targets[key] || null
    const owner = {
      ...(visitData.owner || {}),
      id: idNum,
      ...(visitData.state?.b12 ? { b12: visitData.state.b12 } : {}),
    }

    const effGearCtx = gearData ? { gearData, observedPanels } : this._readCachedGearContext()
    const posterior = (owner.guard && effGearCtx.gearData && this.profileStorePath)
      ? computeGuardPosteriorForTarget(effGearCtx.gearData, idNum, {
          knownOpponentLevel: owner.level || null,
          observedPanels: effGearCtx.observedPanels,
          storePath: this.profileStorePath,
        })
      : null

    const protectSec = Number.isFinite(visitData.rules?.protect) ? visitData.rules.protect : 1800
    const perPlotCap = Number.isFinite(visitData.rules?.perPlot) ? visitData.rules.perPlot : 2
    const perPenCap = Number.isFinite(visitData.rules?.perPen) ? visitData.rules.perPen : 2
    const ownerLeft = Number(visitData.left?.owner ?? prev?.ownerLeft ?? 999)
    const ownerCanBeStolen = ownerLeft > 0 && !owner.newbie
    const sprCover = Number(adapter.R.WORLD?.sprCover?.[visitData.state?.tools?.spr ?? owner.spr ?? 0] || 0)

    const prevOverdueCount = Number(prev?.overdueCount || 0)
    let sawOverdue = false
    const guardOverdue = (rawUnlockAt, isExact) => {
      if (rawUnlockAt > nowSec) return { unlockAt: rawUnlockAt, exact: isExact }
      sawOverdue = true
      if (rawUnlockAt >= nowSec - 2 && prevOverdueCount === 0) {
        return { unlockAt: nowSec + 1, exact: isExact }
      }
      const backoff = [5, 20, 60, 300][Math.min(3, Math.max(0, prevOverdueCount))]
      return { unlockAt: nowSec + backoff, exact: false }
    }

    const evaluator = ownerCanBeStolen
      ? this.getUnifiedEvaluator(adapter, visitorWorld, {
          userConstraints: {
            domesticOnly: this.domesticOnly,
            allowThiefBuffPurchase,
            cashReserveFloor,
          },
        })
      : null

    // Gather up to 2 already-known other targets so multi-raid buff sharing uses real observed islands (zero `/8` heuristic!)
    const extraBundles = []
    if (evaluator) {
      for (const [otherId, rec] of this._liveVisitBundles.entries()) {
        if (otherId === idNum || !rec?.bundle) continue
        if (extraBundles.length >= 2) break
        extraBundles.push(rec.bundle)
      }
    }

    // 1) Evaluate currently unlocked spots under unified economic model
    const rawBundleNow = { id: idNum, owner, isle: visitData.isle, posterior }
    const nowEval = evaluator
      ? evaluator.evaluateTargetWave(rawBundleNow, nowSec, { extraUpcomingBundles: extraBundles })
      : null
    const stealableNow = nowEval?.belief ? nowEval.belief.totalSpots : 0
    const readyEligible = Boolean(
      ownerCanBeStolen &&
      nowEval?.profitable &&
      stealableNow >= this.minStealSpots &&
      nowEval.decisionScore > 0
    )

    // 2) Enumerate exact upcoming plot & barn unlocks
    const futurePlots = []
    const futurePens = []
    const plotFirstRipeAt = {}
    const plotUnlockAt = {}
    let earliestMatureAt = null

    if (ownerCanBeStolen) {
      const visBarn = visitData.isle?.barn || []
      for (let bIdx = 0; bIdx < visBarn.length; bIdx++) {
        const p = visBarn[bIdx]
        if (!p || !p.k || p.steal) continue
        if (Number(p.stolen || 0) >= perPenCap) continue
        const rawPen = visitData.state?.barn?.[bIdx]
        if (!rawPen) continue
        const bt = adapter.exactBarnTimings(rawPen, nowSec, visitData.clockStart || visitorWorld?.clockStart, { protectSec })
        if (bt?.stealUnlockAt != null) {
          const g = guardOverdue(bt.stealUnlockAt, true)
          futurePens.push({ idx: bIdx, unlockAt: g.unlockAt, exact: g.exact })
        }
      }

      const visPlots = visitData.isle?.plots || []
      for (let i = 0; i < visPlots.length; i++) {
        const p = visPlots[i]
        if (!p || !p.c || p.stage < 0) continue
        if (p.steal) {
          plotUnlockAt[i] = nowSec
          continue
        }
        const rawPlot = visitData.state?.plots?.[i]
        const isSprinkled = i < sprCover
        if (p.stage === 3 && Number(p.stolen || 0) === 0) {
          const pt = rawPlot
            ? adapter.exactPlotTimings(rawPlot, isSprinkled, nowSec, visitData.clockStart || visitorWorld?.clockStart, {
                protectSec,
                isAlreadyRipe: true,
              })
            : null
          if (pt && pt.matureAt <= nowSec + 60) {
            const g = guardOverdue(pt.unlockAt, true)
            plotFirstRipeAt[i] = pt.matureAt
            plotUnlockAt[i] = g.unlockAt
            futurePlots.push({ idx: i, unlockAt: g.unlockAt, exact: g.exact, matureAt: pt.matureAt })
          } else {
            const seenRipe = Number(prev?.plotFirstRipeAt?.[i] || nowSec)
            plotFirstRipeAt[i] = seenRipe
            const approx = Math.max(nowSec + 15, seenRipe + Math.round(protectSec * 0.5))
            plotUnlockAt[i] = approx
            futurePlots.push({ idx: i, unlockAt: approx, exact: false, matureAt: seenRipe })
          }
        } else if (p.stage < 3 && Number(p.left || 0) > 0 && Number(p.stolen || 0) < perPlotCap) {
          const pt = rawPlot
            ? adapter.exactPlotTimings(rawPlot, isSprinkled, nowSec, visitData.clockStart || visitorWorld?.clockStart, {
                protectSec,
                isAlreadyRipe: false,
              })
            : null
          const matAt = pt ? pt.matureAt : (nowSec + Number(p.left))
          const rawU = pt ? pt.unlockAt : Math.ceil(matAt + protectSec)
          const immutableExact = Boolean(pt) && (isSprinkled || Number(rawPlot?.w || 0) >= 3)
          const g = guardOverdue(rawU, immutableExact || Boolean(pt))
          plotUnlockAt[i] = g.unlockAt
          if (earliestMatureAt == null || matAt < earliestMatureAt) earliestMatureAt = matAt
          futurePlots.push({ idx: i, unlockAt: g.unlockAt, exact: g.exact, matureAt: matAt })
        }
      }
    }

    const buildBeliefSummary = (belief) => belief
      ? {
          targetId: idNum,
          targetName: owner.name || String(idNum),
          totalSpots: Number(belief.totalSpots || 0),
          spotCounts: { ...(belief.spotCounts || {}) },
          hasGuard: Boolean(belief.hasGuard),
          ownerAlertId: belief.ownerAlertId || null,
          winInterval: Array.isArray(belief.winInterval) ? [...belief.winInterval] : [1, 1],
          lossInterval: Array.isArray(belief.lossInterval) ? [...belief.lossInterval] : [0, 0],
          sampleCount: Number(belief.sampleCount || 0),
          estimationSource: belief.estimationSource || (!belief.hasGuard ? 'no-guard-deterministic' : 'unobserved-wide-prior'),
          tacticalDecision: belief.tacticalDecision || null,
          optimalLoadout: belief.optimalLoadout || null,
          numGearChanges: Number(belief.numGearChanges || 0),
        }
      : null

    const allUnlocks = [...futurePlots, ...futurePens].sort((a, b) => a.unlockAt - b.unlockAt)
    let upcomingEligible = false
    let expectedUnlockAt = null
    let exactUnlockKnown = false
    let upcomingSpots = 0
    let upcomingWaveBelief = null
    let upcomingWaveBundle = null
    let chosenEval = readyEligible ? nowEval : null
    let chosenWaveBundle = readyEligible ? rawBundleNow : null
    let projectedScore = readyEligible ? nowEval.decisionScore : 0
    let projectedEnergyCost = readyEligible ? nowEval.neededEn : 0
    const upcomingWaves = []
    const waveBundlesByUnlock = new Map()

    // Enumerate up to `min(ownerLeft, 3)` chronological non-overlapping waves (`u.unlockAt <= candT`)
    // for staggered neighbor batches (zero artificial delay inside any wave; Wave w+1 starts >= 15s after Wave w).
    if (ownerCanBeStolen && evaluator && allUnlocks.length > 0) {
      const candidateTimes = [...new Set(allUnlocks.map((u) => u.unlockAt))]
      const maxWavesForOwner = Math.min(3, Math.max(1, Number.isFinite(ownerLeft) ? ownerLeft : 1))
      const claimedPlotSet = new Set()
      const claimedPenSet = new Set()
      if (readyEligible) {
        ;(visitData.isle?.plots || []).forEach((p, idx) => {
          if (p?.steal) claimedPlotSet.add(idx)
        })
        ;(visitData.isle?.barn || []).forEach((p, idx) => {
          if (p?.steal) claimedPenSet.add(idx)
        })
      }
      let lastWaveUnlockAt = -Infinity

      for (const candT of candidateTimes) {
        if (upcomingWaves.length >= maxWavesForOwner) break
        if (upcomingWaves.length > 0 && candT < lastWaveUnlockAt + 15) continue

        const plotSet = new Set(
          futurePlots.filter((u) => u.unlockAt <= candT && !claimedPlotSet.has(u.idx)).map((u) => u.idx)
        )
        const penSet = new Set(
          futurePens.filter((u) => u.unlockAt <= candT && !claimedPenSet.has(u.idx)).map((u) => u.idx)
        )
        const waveItems = allUnlocks.filter(
          (u) => u.unlockAt <= candT && (u.matureAt !== undefined ? plotSet.has(u.idx) : penSet.has(u.idx))
        )
        const waveExact = waveItems.length > 0 && waveItems.every((u) => u.exact)

        const simPlots = (visitData.isle?.plots || []).map((p, idx) => {
          if (!p) return p
          if (claimedPlotSet.has(idx)) return { ...p, steal: false }
          if (!p.steal && plotSet.has(idx)) return { ...p, stage: 3, steal: true, stolen: 0 }
          return p
        })
        const simBarn = (visitData.isle?.barn || []).map((p, idx) => {
          if (!p) return p
          if (claimedPenSet.has(idx)) return { ...p, steal: false }
          if (!p.steal && penSet.has(idx)) return { ...p, steal: true, stolen: 0 }
          return p
        })
        const simBundle = {
          id: idNum,
          owner,
          isle: { ...visitData.isle, plots: simPlots, barn: simBarn },
          posterior,
        }
        const waveEval = evaluator.evaluateTargetWave(simBundle, candT, { extraUpcomingBundles: extraBundles })
        if (
          waveEval.profitable &&
          waveEval.belief?.totalSpots >= this.minStealSpots &&
          waveEval.decisionScore > 0
        ) {
          const wSummary = buildBeliefSummary(waveEval.belief)
          const waveRec = {
            waveIndex: upcomingWaves.length,
            unlockAt: candT,
            exactUnlockKnown: waveExact,
            upcomingSpots: waveEval.belief.totalSpots,
            projectedScore: Math.round(waveEval.decisionScore),
            projectedEnergyCost: waveEval.neededEn,
            plannedPrepActs: waveEval.prepActs || [],
            plannedBuffActs: waveEval.buffActs || [],
            plannedStaminaPrepActs: waveEval.staminaPrepActs || [],
            optimalLoadout: waveEval.optimalLoadout || posterior?.optimalLoadout || null,
            numGearChanges: waveEval.numGearChanges ?? posterior?.numGearChanges ?? 0,
            tacticalDecision: waveEval.tacticalDecision || posterior?.decision || null,
            upcomingBeliefSummary: wSummary,
          }
          upcomingWaves.push(waveRec)
          waveBundlesByUnlock.set(candT, simBundle)
          if (upcomingWaves.length === 1) {
            upcomingEligible = true
            expectedUnlockAt = candT
            exactUnlockKnown = waveExact
            upcomingSpots = waveEval.belief.totalSpots
            upcomingWaveBelief = waveEval.belief
            upcomingWaveBundle = simBundle
            if (!readyEligible) {
              chosenEval = waveEval
              chosenWaveBundle = simBundle
              projectedScore = waveEval.decisionScore
              projectedEnergyCost = waveEval.neededEn
            }
          }
          for (const idx of plotSet) claimedPlotSet.add(idx)
          for (const idx of penSet) claimedPenSet.add(idx)
          ;(visitData.isle?.plots || []).forEach((p, idx) => { if (p?.steal) claimedPlotSet.add(idx) })
          ;(visitData.isle?.barn || []).forEach((p, idx) => { if (p?.steal) claimedPenSet.add(idx) })
          lastWaveUnlockAt = candT
        }
      }
    }

    // Only mechanical game-rule caps (`ownerLeft <= 0` or `negative-ev-after-guard-sync`) block a target;
    // conditionally independent RNG battle losses NEVER trigger a 20-minute 2-loss ban!
    let blockedUntil = (prev?.blockedUntil > nowSec && prev?.blockedReason !== 'two-loss-circuit-breaker')
      ? prev.blockedUntil
      : 0
    let blockedReason = blockedUntil > nowSec ? (prev?.blockedReason || null) : null
    if (ownerLeft <= 0) {
      blockedUntil = adapter.nextNaturalDayBoundary(nowSec)
      blockedReason = 'owner-daily-cap'
    }

    const hasAnyLiveCropPlot = (visitData.isle?.plots || []).some((p) => {
      if (!p || !p.c || p.stage < 0) return false
      if (p.steal || p.stage < 3) return true
      return Number(p.stolen || 0) === 0
    })
    const hasAnyLiveBarnPen = stealableNow > 0 || futurePens.length > 0 || (visitData.isle?.barn || []).some((p, bIdx) => {
      if (!p || !p.k) return false
      if (p.steal) return true
      if (Number(p.stolen || 0) >= perPenCap) return false
      const def = adapter.graph?.animalsById?.get(p.k)
      if (!def || def.cap < 2) return false
      const rawPen = visitData.state?.barn?.[bIdx]
      if (!rawPen) return false
      const bt = adapter.exactBarnTimings(rawPen, nowSec, visitData.clockStart || visitorWorld?.clockStart, { protectSec })
      return bt ? (!bt.retired && bt.fed) : false
    })
    const quiescentEmpty = !readyEligible && !upcomingEligible && allUnlocks.length === 0 && !hasAnyLiveCropPlot && !hasAnyLiveBarnPen
    const emptyStreak = quiescentEmpty
      ? ((prev && this._isEntryQuiescent(prev)) ? Math.min(8, Number(prev.emptyStreak || 1) + 1) : 1)
      : 0
    const lastKnownOwnerActiveAt = Math.max(
      Number(directoryActiveAt || 0),
      Number(prev?.lastKnownOwnerActiveAt || 0)
    )

    const baseIsleSpan = Number(adapter?.R?.ISLE_SPAN || 14400)
    const nxtIsle = typeof adapter?.nextIsleBoundary === 'function' ? adapter.nextIsleBoundary(nowSec) : -1
    let objectiveNextProbeAt = nowSec + 900
    if (stealableNow > 0) {
      objectiveNextProbeAt = nowSec + 60
    } else if (allUnlocks.length > 0) {
      const u0 = allUnlocks[0].unlockAt
      if (earliestMatureAt && earliestMatureAt > nowSec + 30 && earliestMatureAt < u0 - 60) {
        objectiveNextProbeAt = earliestMatureAt + 5
      } else if (u0 - nowSec <= 45) {
        objectiveNextProbeAt = u0
      } else {
        objectiveNextProbeAt = Math.max(nowSec + 60, u0 - 35)
      }
    } else if (quiescentEmpty) {
      const backoffSec = Math.min(baseIsleSpan * 3, 1800 * Math.pow(2, Math.min(5, emptyStreak - 1)))
      objectiveNextProbeAt = nowSec + backoffSec
    } else {
      objectiveNextProbeAt = nxtIsle > nowSec
        ? Math.min(nowSec + 900, Math.max(nowSec + 120, nxtIsle + 5))
        : (nowSec + 900)
    }

    let nextProbeAt = objectiveNextProbeAt
    if (blockedUntil > nowSec) {
      nextProbeAt = blockedUntil + 5
    } else if (readyEligible) {
      nextProbeAt = nowSec
    } else if (upcomingEligible && expectedUnlockAt != null) {
      const lead = expectedUnlockAt - nowSec
      if (lead <= 45) nextProbeAt = expectedUnlockAt
      else if (earliestMatureAt && earliestMatureAt > nowSec + 30 && earliestMatureAt < expectedUnlockAt - 60) {
        nextProbeAt = earliestMatureAt + 5
      } else {
        nextProbeAt = Math.max(nowSec + 60, expectedUnlockAt - 35)
      }
    } else if (allUnlocks.length > 0) {
      nextProbeAt = Math.max(nowSec + 120, allUnlocks[0].unlockAt)
    }

    const upcomingBeliefSummary = upcomingWaves[0]?.upcomingBeliefSummary || buildBeliefSummary(upcomingWaveBelief)

    const entry = {
      id: idNum,
      name: owner.name || String(idNum),
      level: Number(owner.level || 1),
      guard: Boolean(owner.guard),
      newbie: Boolean(owner.newbie),
      ownerLeft,
      readyEligible,
      stealableCount: stealableNow,
      upcomingEligible,
      upcomingSpots,
      expectedUnlockAt,
      exactUnlockKnown,
      upcomingWaves,
      earliestMatureAt,
      nextProbeAt,
      blockedUntil,
      blockedReason,
      cooldownUntil: prev?.cooldownUntil > nowSec ? prev.cooldownUntil : 0,
      lossCount: Number(prev?.lossCount || 0),
      lastLossAtSec: Number(prev?.lastLossAtSec || 0),
      needsGuardLogSync: Boolean(prev?.needsGuardLogSync),
      overdueCount: sawOverdue ? prevOverdueCount + 1 : 0,
      earlyRetryCount: 0,
      quiescentEmpty,
      emptyStreak,
      lastKnownOwnerActiveAt,
      lastIngestedScanAtSec: Math.max(nowSec, Number(prev?.lastIngestedScanAtSec || 0)),
      plotFirstRipeAt,
      plotUnlockAt,
      plannedPrepActs: chosenEval?.prepActs || [],
      plannedBuffActs: chosenEval?.buffActs || [],
      plannedStaminaPrepActs: chosenEval?.staminaPrepActs || [],
      optimalLoadout: chosenEval?.optimalLoadout || posterior?.optimalLoadout || null,
      numGearChanges: chosenEval?.numGearChanges ?? posterior?.numGearChanges ?? 0,
      upcomingBeliefSummary,
      projectedScore: Math.round(projectedScore),
      projectedEnergyCost,
      updatedAt: nowSec,
    }

    this.data.targets[key] = entry
    if (!entry.readyEligible && !entry.upcomingEligible) {
      this._liveVisitBundles.delete(idNum)
    } else {
      const rawState = visitData.state
      const compactState = rawState
        ? {
            tools: rawState.tools ? { spr: Number(rawState.tools.spr || 0) } : undefined,
            plots: Array.isArray(rawState.plots) ? rawState.plots : [],
            barn: Array.isArray(rawState.barn) ? rawState.barn : [],
            b12: rawState.b12?.effects ? { effects: rawState.b12.effects } : undefined,
          }
        : undefined
      this._liveVisitBundles.delete(idNum)
      this._liveVisitBundles.set(idNum, {
        atSec: nowSec,
        bundle: { id: idNum, owner, isle: visitData.isle, state: compactState, posterior },
        waveBundle: chosenWaveBundle,
        upcomingWaveBundle,
        waveBundlesByUnlock,
        tacticalDecision: chosenEval?.tacticalDecision || posterior?.decision || null,
        gearData: effGearCtx.gearData || null,
        observedPanels: effGearCtx.observedPanels || null,
      })
      this._pruneLiveVisitBundles(idNum)
    }

    if (this.activeRaidSchedule) {
      const comm = this.activeRaidSchedule.committedByTargetId.get(idNum)
      if (comm && !comm.isImmediate) {
        const lostEligibility = !entry.upcomingEligible && !entry.readyEligible
        const unlockShifted = entry.expectedUnlockAt != null
          && Math.abs(Number(entry.expectedUnlockAt) - Number(comm.unlockAtSec)) > 2
        const spotsDropped = Number(entry.upcomingSpots || entry.stealableCount || 0) < Number(comm.totalSpots || 0)
        if (lostEligibility || unlockShifted || spotsDropped) {
          this.activeRaidSchedule.needsRefresh = true
          this.activeRaidSchedule.refreshReason = `committed-target-drifted:${idNum}`
        }
      } else if (!this.activeRaidSchedule.evaluatedTargetSet.has(idNum)) {
        if (this.wouldTargetEnterControllerSet(nowSec, idNum)) {
          this.activeRaidSchedule.needsRefresh = true
          this.activeRaidSchedule.refreshReason = `new-positive-ev-target:${idNum}`
        }
      }
    }

    if (!fromSharedScan && this.sharedScanFilePath) {
      const snap = quiescentEmpty
        ? null
        : compactVisitSnapshot(visitData, owner, nowSec, visitorWorld?.clockStart)
      const earliestUnlockAt = allUnlocks.length > 0 ? allUnlocks[0].unlockAt : null
      const latestUnlockAt = allUnlocks.length > 0 ? allUnlocks[allUnlocks.length - 1].unlockAt : null
      mutateSharedScanSync(this.sharedScanFilePath, (shared) => {
        const prevShared = shared.islands[key]
        if (!prevShared || nowSec >= Number(prevShared.observedAtSec || 0)) {
          shared.islands[key] = {
            id: idNum,
            owner: {
              id: idNum,
              name: owner.name || String(idNum),
              level: Number(owner.level || 1),
              guard: Boolean(owner.guard),
              newbie: Boolean(owner.newbie),
            },
            observedAtSec: nowSec,
            observedBy: this.accountKey,
            quiescentEmpty,
            emptyStreak,
            lastKnownOwnerActiveAt: Math.max(lastKnownOwnerActiveAt, Number(prevShared?.lastKnownOwnerActiveAt || 0)),
            hasLiveSteal: stealableNow > 0,
            earliestUnlockAt,
            latestUnlockAt,
            sharedNextProbeAt: objectiveNextProbeAt,
            probeLeaseUntilSec: 0,
            probeLeaseBy: null,
            snapshot: snap,
          }
          shared.updatedAt = Math.max(Number(shared.updatedAt || 0), nowSec)
        } else if (prevShared?.probeLeaseBy === this.accountKey) {
          prevShared.probeLeaseUntilSec = 0
          prevShared.probeLeaseBy = null
        }
        delete shared.pendingDirItems[key]
      })
    }

    if (!skipSave) {
      this.save(nowSec)
    }
    return entry
  }

  ingestSharedScanUpdates(adapter, visitorWorld = null, userConstraints = {}) {
    if (!this.isStealEnabled() || !this.sharedScanFilePath || !adapter || !fs.existsSync(this.sharedScanFilePath)) {
      return 0
    }
    if (visitorWorld?.state && Number.isFinite(Number(visitorWorld?.now))) {
      this._lastVisitorWorld = visitorWorld
    }
    const effWorld = (visitorWorld?.state ? visitorWorld : null) || this._lastVisitorWorld
    if (!effWorld) return 0

    let st
    try {
      st = fs.statSync(this.sharedScanFilePath)
    } catch {
      return 0
    }
    if (st.mtimeMs === this._lastSharedScanMtimeMs && st.size === this._lastSharedScanSize) {
      return 0
    }

    const shared = loadSharedScanSync(this.sharedScanFilePath)
    const nowWorldSec = Number(effWorld.now || Math.floor(Date.now() / 1000))
    const allowThiefBuffPurchase = userConstraints.allowThiefBuffPurchase !== false
    const cashReserveFloor = Number(userConstraints.cashReserveFloor ?? 10)
    let updatedCount = 0
    let dirty = false

    for (const [idKey, sRec] of Object.entries(shared.islands || {})) {
      if (!sRec) continue
      const idNum = Number(sRec.id ?? idKey)
      if (!Number.isFinite(idNum) || idNum <= 0 || this.selfIds.has(idNum)) continue

      const obsAt = Number(sRec.observedAtSec || 0)
      const prev = this.data.targets[idKey] || null
      const alreadyAt = Math.max(Number(prev?.lastIngestedScanAtSec || 0), Number(prev?.updatedAt || 0))

      if (obsAt <= alreadyAt) {
        if (
          prev &&
          this._isEntryQuiescent(prev) &&
          sRec.quiescentEmpty &&
          Number(sRec.sharedNextProbeAt || 0) > Number(prev.nextProbeAt || 0)
        ) {
          prev.nextProbeAt = Number(sRec.sharedNextProbeAt)
          prev.lastKnownOwnerActiveAt = Math.max(
            Number(prev.lastKnownOwnerActiveAt || 0),
            Number(sRec.lastKnownOwnerActiveAt || 0)
          )
          dirty = true
        }
        continue
      }

      if (sRec.quiescentEmpty || !sRec.snapshot) {
        const sOwner = sRec.owner || {}
        const blockedUntil = prev?.blockedUntil > nowWorldSec ? prev.blockedUntil : 0
        const nextProbe = blockedUntil > nowWorldSec
          ? blockedUntil + 5
          : Math.max(obsAt + 1800, Number(sRec.sharedNextProbeAt || 0))
        this.data.targets[idKey] = {
          id: idNum,
          name: sOwner.name || prev?.name || String(idNum),
          level: Number(sOwner.level || prev?.level || 1),
          guard: Boolean(sOwner.guard ?? prev?.guard),
          newbie: Boolean(sOwner.newbie ?? prev?.newbie),
          ownerLeft: Number(prev?.ownerLeft ?? 999),
          readyEligible: false,
          stealableCount: 0,
          upcomingEligible: false,
          upcomingSpots: 0,
          expectedUnlockAt: null,
          exactUnlockKnown: false,
          upcomingWaves: [],
          earliestMatureAt: null,
          nextProbeAt: nextProbe,
          blockedUntil,
          blockedReason: blockedUntil > nowWorldSec ? (prev?.blockedReason || null) : null,
          cooldownUntil: prev?.cooldownUntil > nowWorldSec ? prev.cooldownUntil : 0,
          lossCount: Number(prev?.lossCount || 0),
          lastLossAtSec: Number(prev?.lastLossAtSec || 0),
          needsGuardLogSync: Boolean(prev?.needsGuardLogSync),
          overdueCount: 0,
          earlyRetryCount: 0,
          quiescentEmpty: true,
          emptyStreak: Number(sRec.emptyStreak || 1),
          lastKnownOwnerActiveAt: Math.max(
            Number(sRec.lastKnownOwnerActiveAt || 0),
            Number(prev?.lastKnownOwnerActiveAt || 0)
          ),
          lastIngestedScanAtSec: obsAt,
          plotFirstRipeAt: {},
          plotUnlockAt: {},
          plannedPrepActs: [],
          plannedBuffActs: [],
          plannedStaminaPrepActs: [],
          optimalLoadout: prev?.optimalLoadout || null,
          numGearChanges: Number(prev?.numGearChanges || 0),
          upcomingBeliefSummary: null,
          projectedScore: 0,
          projectedEnergyCost: 0,
          updatedAt: obsAt,
        }
        this._liveVisitBundles.delete(idNum)
        if (this.activeRaidSchedule?.committedByTargetId?.has(idNum)) {
          const comm = this.activeRaidSchedule.committedByTargetId.get(idNum)
          if (comm && !comm.isImmediate) {
            this.activeRaidSchedule.needsRefresh = true
            this.activeRaidSchedule.refreshReason = `committed-target-drifted:${idNum}`
          }
        }
        dirty = true
        updatedCount++
        continue
      }

      if (!sRec.hasLiveSteal && Number(sRec.latestUnlockAt || 0) > 0 && Number(sRec.latestUnlockAt) < nowWorldSec - 60) {
        if (prev) {
          prev.nextProbeAt = Math.max(nowWorldSec, Number(prev.nextProbeAt || 0))
          prev.lastIngestedScanAtSec = obsAt
          prev.lastKnownOwnerActiveAt = Math.max(
            Number(prev.lastKnownOwnerActiveAt || 0),
            Number(sRec.lastKnownOwnerActiveAt || 0)
          )
          dirty = true
        }
        continue
      }

      const ent = this.recordVisitSnapshot(adapter, effWorld, idNum, sRec.snapshot, {
        allowThiefBuffPurchase,
        cashReserveFloor,
        directoryActiveAt: Number(sRec.lastKnownOwnerActiveAt || 0),
        fromSharedScan: true,
        skipSave: true,
      })
      if (ent) {
        ent.lastIngestedScanAtSec = obsAt
        dirty = true
        updatedCount++
      }
    }

    this._lastSharedScanMtimeMs = st.mtimeMs
    this._lastSharedScanSize = st.size
    if (dirty) {
      this.save(nowWorldSec)
    }
    return updatedCount
  }

  _advanceEntryToNextWave(entry, idNum, nowSec, { decOwnerLeft = false, completedUnlockAt = null } = {}) {
    if (!entry) return false
    if (decOwnerLeft && Number.isFinite(Number(entry.ownerLeft))) {
      entry.ownerLeft = Math.max(0, Number(entry.ownerLeft) - 1)
    }
    const minNextUnlock = Math.max(nowSec + 6, completedUnlockAt != null ? Number(completedUnlockAt) + 10 : nowSec + 6)
    const remWaves = (entry.upcomingWaves || []).filter((w) => Number(w?.unlockAt || 0) >= minNextUnlock)
    entry.upcomingWaves = remWaves
    if ((entry.ownerLeft == null || Number(entry.ownerLeft) > 0) && remWaves.length > 0) {
      const nxt = remWaves[0]
      entry.upcomingEligible = true
      entry.expectedUnlockAt = Number(nxt.unlockAt)
      entry.exactUnlockKnown = Boolean(nxt.exactUnlockKnown)
      entry.upcomingSpots = Number(nxt.upcomingSpots || 0)
      entry.projectedScore = Number(nxt.projectedScore || entry.projectedScore || 0)
      entry.projectedEnergyCost = Number(nxt.projectedEnergyCost || entry.projectedEnergyCost || 6)
      entry.plannedPrepActs = nxt.plannedPrepActs || []
      entry.plannedBuffActs = nxt.plannedBuffActs || []
      entry.plannedStaminaPrepActs = nxt.plannedStaminaPrepActs || []
      entry.optimalLoadout = nxt.optimalLoadout || entry.optimalLoadout || null
      entry.numGearChanges = nxt.numGearChanges ?? entry.numGearChanges ?? 0
      entry.upcomingBeliefSummary = nxt.upcomingBeliefSummary || entry.upcomingBeliefSummary || null
      entry.nextProbeAt = Math.max(nowSec + 10, Number(nxt.unlockAt) - 40)
      const cached = this._liveVisitBundles.get(idNum)
      if (cached) {
        const nextWaveBundle = cached.waveBundlesByUnlock?.get(Number(nxt.unlockAt)) || null
        cached.upcomingWaveBundle = nextWaveBundle
        cached.waveBundle = nextWaveBundle || cached.waveBundle
        cached.tacticalDecision = nxt.tacticalDecision || cached.tacticalDecision || null
      }
      if (this.activeRaidSchedule?.committedWavesByTargetId?.has(idNum)) {
        const curList = (this.activeRaidSchedule.committedWavesByTargetId.get(idNum) || []).filter(
          (r) => Number(r?.unlockAtSec || 0) >= minNextUnlock
        )
        if (curList.length > 0) {
          this.activeRaidSchedule.committedWavesByTargetId.set(idNum, curList)
          this.activeRaidSchedule.committedByTargetId.set(idNum, curList[0])
        } else {
          this.activeRaidSchedule.committedWavesByTargetId.delete(idNum)
          this.activeRaidSchedule.committedByTargetId.delete(idNum)
        }
        this.activeRaidSchedule.committedRaids = (this.activeRaidSchedule.committedRaids || []).filter(
          (r) => Number(r?.targetId) !== idNum || Number(r?.unlockAtSec || 0) >= minNextUnlock
        )
      }
      return true
    }
    entry.upcomingEligible = false
    entry.expectedUnlockAt = null
    entry.exactUnlockKnown = false
    entry.upcomingSpots = 0
    if (this.activeRaidSchedule?.committedByTargetId?.has(idNum)) {
      this.activeRaidSchedule.committedByTargetId.delete(idNum)
      this.activeRaidSchedule.committedWavesByTargetId?.delete(idNum)
      this.activeRaidSchedule.committedRaids = (this.activeRaidSchedule.committedRaids || []).filter(
        (r) => Number(r?.targetId) !== idNum
      )
    }
    return false
  }

  /**
   * Immediately updates schedule & opponent profile store from a `POST /api/pet/world/visit/:id` receipt
   * (called inside `executeTransaction.onReceiptFn` BEFORE `fetchAfterWorldFn`!).
   */
  recordSnipeReceipt(adapter, targetId, rawResp, nowSec, { visitorWorld = null, sentAtServerMs = null } = {}) {
    if (!this.isStealEnabled()) return null
    const idNum = Number(targetId)
    const key = String(idNum)
    const entry = {
      ...(this.data.targets[key] || {
        id: idNum,
        name: String(idNum),
        level: 1,
        guard: true,
        lossCount: 0,
        lastLossAtSec: 0,
      }),
    }

    const body = rawResp?.body || rawResp || {}
    if (body?.battle && this.profileStorePath) {
      recordBattleSnapshot(body.battle, 'guard', { storePath: this.profileStorePath })
    }

    const respRejected = rawResp?.ok === false
      || rawResp?.status === 'rejected'
      || (Number.isFinite(rawResp?.httpStatus) && rawResp.httpStatus >= 400)
    if (respRejected) {
      const status = rawResp?.httpStatus ?? rawResp?.status
      const errMsg = String(body?.error || body?.msg || '')
      const prevExpectedUnlock = entry.expectedUnlockAt
      const sentBeforeOrAtBoundary = prevExpectedUnlock != null && (
        sentAtServerMs != null
          ? sentAtServerMs < prevExpectedUnlock * 1000 + 250
          : (body?.now != null ? Number(body.now) <= prevExpectedUnlock : nowSec <= prevExpectedUnlock)
      )
      if (/上限|今天偷过|新手/.test(errMsg)) {
        entry.blockedUntil = adapter.nextNaturalDayBoundary(nowSec)
        entry.blockedReason = 'server-owner-or-daily-cap'
        entry.readyEligible = false
        entry.upcomingEligible = false
        entry.upcomingWaves = []
      } else if (
        status === 409 &&
        prevExpectedUnlock != null &&
        sentBeforeOrAtBoundary &&
        Math.abs(nowSec - prevExpectedUnlock) <= 2 &&
        Number(entry.earlyRetryCount || 0) === 0
      ) {
        // True pre/on-boundary clock truncation jitter: retry once `+1s` later instead of dropping the batch!
        entry.earlyRetryCount = 1
        entry.expectedUnlockAt = Math.max(nowSec + 1, prevExpectedUnlock + 1)
        entry.readyEligible = false
      } else {
        entry.readyEligible = false
        entry.stealableCount = 0
        entry.cooldownUntil = nowSec + 90
        if (prevExpectedUnlock != null && prevExpectedUnlock <= nowSec + 2) {
          this._advanceEntryToNextWave(entry, idNum, nowSec, {
            decOwnerLeft: false,
            completedUnlockAt: prevExpectedUnlock,
          })
        }
        if (!entry.upcomingEligible) {
          entry.nextProbeAt = Math.max(Number(entry.nextProbeAt || 0), nowSec + 90)
        }
      }
      entry.updatedAt = nowSec
      this.data.targets[key] = entry
      if (!entry.upcomingEligible) {
        this._liveVisitBundles.delete(idNum)
        if (this.activeRaidSchedule?.committedByTargetId?.has(idNum)) {
          this.activeRaidSchedule.committedByTargetId.delete(idNum)
          this.activeRaidSchedule.committedWavesByTargetId?.delete(idNum)
          this.activeRaidSchedule.needsRefresh = true
          this.activeRaidSchedule.refreshReason = `committed-target-rejected:${idNum}`
        }
      }
      this.save(nowSec)
      return entry
    }

    const outcome = body?.result?.outcome ?? body?.outcome ?? (body?.lost ? 'lose' : 'win')
    if (outcome === 'lose') {
      entry.lossCount = Number(entry.lossCount || 0) + 1
      entry.lastLossAtSec = nowSec
      entry.needsGuardLogSync = !body?.battle
      entry.cooldownUntil = nowSec + 5
      // Re-evaluate immediately if we have the updated battle snapshot & cached/returned isle
      const cachedBundle = this._liveVisitBundles.get(idNum)
      const isleToEval = body?.isle || cachedBundle?.bundle?.isle
      if (body?.battle && isleToEval && visitorWorld) {
        this.data.targets[key] = entry
        return this.recordVisitSnapshot(adapter, visitorWorld, idNum, {
          ...body,
          isle: isleToEval,
          state: body?.state || cachedBundle?.bundle?.state,
          owner: body?.owner || cachedBundle?.bundle?.owner || { id: idNum, name: entry.name, level: entry.level, guard: entry.guard },
          now: nowSec,
        }, {
          gearData: cachedBundle?.gearData || null,
          observedPanels: cachedBundle?.observedPanels || null,
        })
      }
    } else if (outcome === 'win') {
      const completedUnlock = entry.expectedUnlockAt
      entry.lossCount = 0
      entry.lastLossAtSec = 0
      entry.needsGuardLogSync = false
      entry.readyEligible = false
      entry.stealableCount = 0
      const hasMoreWaves = this._advanceEntryToNextWave(entry, idNum, nowSec, {
        decOwnerLeft: true,
        completedUnlockAt: completedUnlock != null && completedUnlock <= nowSec + 15 ? completedUnlock : nowSec,
      })
      if (!hasMoreWaves) {
        entry.quiescentEmpty = false
        entry.emptyStreak = 0
        entry.nextProbeAt = nowSec + 300
        this._liveVisitBundles.delete(idNum)
      }
    } else {
      // Draw: spots remain on island, brief 4s cooldown before re-evaluating
      entry.cooldownUntil = nowSec + 4
    }

    entry.updatedAt = nowSec
    this.data.targets[key] = entry

    // If response includes updated `isle`, refresh schedule directly!
    if (body?.isle && visitorWorld && outcome !== 'lose') {
      return this.recordVisitSnapshot(adapter, visitorWorld, idNum, {
        ...body,
        owner: body.owner || {
          id: idNum,
          name: entry.name,
          level: entry.level,
          guard: entry.guard,
          newbie: Boolean(entry.newbie),
        },
        now: nowSec,
      })
    }

    this.save(nowSec)
    return entry
  }

  /**
   * Handles reconciled `visit:unknown` outcomes (`reconcileUnknownWithFreshWorld` callback):
   * On inferred guard loss, flags `needsGuardLogSync = true` so the opponent's fighter panel is refreshed
   * before re-evaluating EV (zero dogmatic 2-loss ban!).
   */
  recordReconciledVisit({ targetId, status, inferredVisitOutcome, freshWorld }) {
    if (!this.isStealEnabled() || targetId == null) return null
    const idNum = Number(targetId)
    const key = String(idNum)
    const nowSec = Number(freshWorld?.now || Math.floor(Date.now() / 1000))
    const entry = {
      ...(this.data.targets[key] || { id: idNum, name: String(idNum), level: 1, guard: true }),
    }

    if (status === 'confirmed' && inferredVisitOutcome === 'lose') {
      entry.lossCount = Number(entry.lossCount || 0) + 1
      entry.lastLossAtSec = nowSec
      entry.needsGuardLogSync = true
      entry.cooldownUntil = nowSec + 5
    } else if (status === 'confirmed') {
      entry.readyEligible = false
      entry.stealableCount = 0
      entry.quiescentEmpty = false
      entry.emptyStreak = 0
      entry.nextProbeAt = nowSec + 180
      this._liveVisitBundles.delete(idNum)
    }
    entry.updatedAt = nowSec
    this.data.targets[key] = entry
    this.save(nowSec)
    return entry
  }

  isTargetBlocked(entry, nowSec) {
    if (!entry) return true
    if (Number(entry.blockedUntil || 0) > nowSec) return true
    if (Number(entry.cooldownUntil || 0) > nowSec) return true
    return false
  }

  /**
   * Returns earliest unblocked `exactUnlockKnown` target and `leadSec = expectedUnlockAt - nowSec`,
   * enforcing `this.activeRaidSchedule` when synced from `solveUnifiedPlan`:
   *   - Targets committed in `plan.raidSchedule` execute with their committed prep/loadout metadata.
   *   - Targets already evaluated and rejected by `plan.raidSchedule` are strictly skipped.
   *   - Newly discovered targets outside `evaluatedTargetIds`:
   *       * if `leadSec > ceil(T_prep + 2)`, mark `needsRefresh = true` so `live-daemon` wakes `runControllerStep` first;
   *       * if `leadSec <= ceil(T_prep + 2)` (imminent unplanned discovery), allow immediate fast-path staging with audit reason.
   */
  wouldTargetEnterControllerSet(nowSec, targetId) {
    if (!this.isStealEnabled()) return false
    const idNum = Number(targetId)
    if (!Number.isFinite(idNum) || idNum <= 0) return false
    const dueReady = Object.values(this.data.targets || {})
      .filter((e) => e && !this.isTargetBlocked(e, nowSec) && Number(e.projectedScore || 0) > 0 && (
        e.readyEligible ||
        (e.upcomingEligible && e.expectedUnlockAt != null && Number(e.expectedUnlockAt) <= nowSec)
      ))
      .sort((a, b) => (Number(b.projectedScore || 0) - Number(a.projectedScore || 0)))
      .slice(0, this.maxReadyProbes)
    if (dueReady.some((e) => Number(e.id) === idNum)) return true
    const upcoming = this.collectUpcomingTargetsForController(null, { now: nowSec }, {
      horizonSec: this.controllerHorizonSec,
      maxUpcomingTargets: this.maxUpcomingTargets,
    })
    return upcoming.some((c) => Number(c.id) === idNum && Number(c.projectedScore || 0) > 0)
  }

  nextHorizonEntrySec(nowSec) {
    if (!this.isStealEnabled()) return null
    const sched = this.activeRaidSchedule
    let earliestEntrySec = Infinity
    for (const e of Object.values(this.data.targets || {})) {
      if (!e || this.isTargetBlocked(e, nowSec)) continue
      const idNum = Number(e.id)
      if (sched?.evaluatedTargetSet?.has(idNum) || sched?.committedByTargetId?.has(idNum)) continue
      const waves = Array.isArray(e.upcomingWaves) && e.upcomingWaves.length > 0
        ? e.upcomingWaves
        : (e.upcomingEligible && e.expectedUnlockAt != null
            ? [{
                waveIndex: 0,
                unlockAt: e.expectedUnlockAt,
                exactUnlockKnown: e.exactUnlockKnown,
                upcomingSpots: e.upcomingSpots,
                projectedScore: e.projectedScore,
                upcomingBeliefSummary: e.upcomingBeliefSummary,
              }]
            : [])
      const cached = this._liveVisitBundles.get(e.id)
      for (const w of waves) {
        const unlockAtSec = Math.floor(Number(w.unlockAt || 0))
        const lead = unlockAtSec - nowSec
        if (!(lead > this.controllerHorizonSec)) continue
        if (Number(w.upcomingSpots || 0) < this.minStealSpots) continue
        const score = Number(w.projectedScore || e.projectedScore || 0)
        if (!(score > 0)) continue
        const waveBundle = cached?.waveBundlesByUnlock?.get(unlockAtSec)
          || (w.waveIndex === 0 ? (cached?.upcomingWaveBundle || cached?.waveBundle || null) : null)
        const beliefSummary = w.upcomingBeliefSummary || e.upcomingBeliefSummary || null
        if (!waveBundle && !beliefSummary) continue
        const candEntrySec = Math.max(nowSec + 1, unlockAtSec - this.controllerHorizonSec)
        if (candEntrySec < earliestEntrySec && this.wouldTargetEnterControllerSet(candEntrySec, idNum)) {
          earliestEntrySec = candEntrySec
        }
      }
    }
    return Number.isFinite(earliestEntrySec) ? earliestEntrySec : null
  }

  /**
   * Returns earliest wake timestamp (<= nowSec + ...) to refresh a committed upcoming target
   * ~75s before unlock if it hasn't been probed within `[unlockAt - 90, unlockAt]`.
   */
  nextCommittedProbeWakeSec(nowSec) {
    if (!this.isStealEnabled() || !this.activeRaidSchedule?.committedByTargetId) return null
    let earliestSec = Infinity
    for (const [idNum, comm] of this.activeRaidSchedule.committedByTargetId.entries()) {
      if (!comm || comm.isImmediate) continue
      const entry = this.data.targets?.[String(idNum)]
      if (!entry || this.isTargetBlocked(entry, nowSec)) continue
      const unlockAt = Number(entry.expectedUnlockAt ?? comm.unlockAtSec ?? 0)
      if (!Number.isFinite(unlockAt) || unlockAt <= nowSec + 15) continue
      const lastProbeSec = Math.max(Number(entry.updatedAt || 0), Number(entry.lastProbeAttemptAtSec || 0))
      if (lastProbeSec >= unlockAt - 90) continue
      const nextProbe = Number(entry.nextProbeAt || Infinity)
      const desiredProbe = unlockAt - 75
      const wakeCandidate = Math.max(
        nowSec + 1,
        lastProbeSec + 15,
        Math.min(Number.isFinite(nextProbe) ? nextProbe : desiredProbe, desiredProbe)
      )
      if (wakeCandidate < unlockAt - 15 && wakeCandidate < earliestSec) {
        earliestSec = wakeCandidate
      }
    }
    return Number.isFinite(earliestSec) ? Math.ceil(earliestSec) : null
  }

  _isCommittedImminentProbeDue(entry, nowSec) {
    const comm = this.activeRaidSchedule?.committedByTargetId?.get(Number(entry?.id))
    if (!comm || comm.isImmediate) return false
    const unlockAt = Number(entry?.expectedUnlockAt ?? comm.unlockAtSec ?? 0)
    const lead = unlockAt - nowSec
    const lastProbeSec = Math.max(Number(entry?.updatedAt || 0), Number(entry?.lastProbeAttemptAtSec || 0))
    return lead > 15 && lead <= 90 && lastProbeSec < unlockAt - 90
  }

  _candidatePriorityForEntry(entry, nowSec) {
    const comm = this.activeRaidSchedule?.committedByTargetId?.get(Number(entry?.id))
    const unlockAt = Number(entry?.expectedUnlockAt ?? comm?.unlockAtSec ?? 0)
    if (comm && !comm.isImmediate && (unlockAt - nowSec) <= 90) return 220
    return this._isEntryQuiescent(entry) ? 12 : (85 + (entry.upcomingEligible ? 20 : 0))
  }

  nextExactUnlockInfo(nowSec) {
    if (!this.isStealEnabled()) return null
    let best = null
    const sched = this.activeRaidSchedule
    for (const entry of Object.values(this.data.targets || {})) {
      if (!entry || this.isTargetBlocked(entry, nowSec)) continue
      if (!entry.upcomingEligible || !entry.exactUnlockKnown || entry.expectedUnlockAt == null) continue
      const leadSec = Number(entry.expectedUnlockAt) - nowSec
      if (leadSec < -20) continue

      const idNum = Number(entry.id)
      let committedRaid = null
      let unplannedImminentDiscovery = false
      let effectiveEntry = entry

      if (sched) {
        const comm = sched.committedByTargetId.get(idNum) || null
        if (comm) {
          if (comm.isImmediate && !(Number(entry.expectedUnlockAt) > nowSec)) continue
          committedRaid = comm
          effectiveEntry = {
            ...entry,
            plannedPrepActs: comm.plannedPrepActs || entry.plannedPrepActs || [],
            numGearChanges: comm.numGearChanges ?? entry.numGearChanges,
          }
        } else if (sched.evaluatedTargetSet.has(idNum)) {
          continue
        } else {
          const immWindow = Math.ceil(this.computePhysicalPrepLeadSec(entry) + 2)
          if (leadSec > immWindow) {
            if (this.wouldTargetEnterControllerSet(nowSec, idNum)) {
              sched.needsRefresh = true
              if (!sched.refreshReason) {
                sched.refreshReason = `new-positive-ev-target:${idNum}`
              }
            }
            continue
          }
          unplannedImminentDiscovery = true
        }
      }

      if (
        !best ||
        entry.expectedUnlockAt < best.unlockAt ||
        (entry.expectedUnlockAt === best.unlockAt && (entry.projectedScore || 0) > (best.entry.projectedScore || 0))
      ) {
        best = {
          targetId: idNum,
          entry: effectiveEntry,
          rawEntry: entry,
          unlockAt: Number(entry.expectedUnlockAt),
          leadSec,
          committedRaid,
          unplannedImminentDiscovery,
        }
      }
    }
    return best
  }

  hasReadyTargetNow(nowSec) {
    if (!this.isStealEnabled()) return false
    const sched = this.activeRaidSchedule
    for (const entry of Object.values(this.data.targets || {})) {
      if (!entry || this.isTargetBlocked(entry, nowSec)) continue
      const idNum = Number(entry.id)
      if (sched && sched.evaluatedTargetSet.has(idNum) && !sched.committedByTargetId.has(idNum)) {
        continue
      }
      if (entry.readyEligible && Number(entry.stealableCount || 0) >= this.minStealSpots && Number(entry.projectedScore || 0) > 0) {
        return true
      }
    }
    return false
  }

  /**
   * Priority Preemption Predicate:
   * Returns `true` whenever a ready positive-EV raid exists OR an `exactUnlockKnown` snipe unlocks within `<= windowSec` (`50s`).
   */
  shouldBlockBackgroundWork(nowSec, windowSec = null) {
    if (!this.isStealEnabled()) return false
    if (this.hasReadyTargetNow(nowSec)) return true
    const nxt = this.nextExactUnlockInfo(nowSec)
    if (!nxt) return false
    const effWindow = windowSec != null
      ? Number(windowSec)
      : Math.max(12, Math.ceil(this.computePhysicalPrepLeadSec(nxt.entry) + 4))
    return nxt.leadSec <= effWindow
  }

  /**
   * Computes `{ staminaReserveFloor, staminaReserveUntilSec }` so domestic `mine`/`fish` in `solveUnifiedPlan`
   * never drains stamina below what an upcoming high-EV snipe needs (accounting for natural stamina regen!).
   */
  computeImminentSnipeStaminaReservation(adapter, world, nowSec = world?.now, horizonSec = 900) {
    if (!this.isStealEnabled() || !world?.state) {
      return { staminaReserveFloor: 0, staminaReserveUntilSec: 0 }
    }
    const regenSec = Number(adapter.R.WORLD?.regen || adapter.R.WORLD?.enRegen || 180)
    const rawMax = Number(adapter.R.energyMax?.(world.state))
    const enMax = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 100

    let requiredNowFloor = 0
    let reserveUntilSec = 0
    for (const entry of Object.values(this.data.targets || {})) {
      if (!entry || this.isTargetBlocked(entry, nowSec)) continue
      if (!entry.upcomingEligible || entry.expectedUnlockAt == null || !(Number(entry.projectedScore || 0) > 0)) continue
      const lead = Number(entry.expectedUnlockAt) - nowSec
      if (lead < -10 || lead > horizonSec) continue
      const needAtUnlock = Math.min(15, Math.max(6, Number(entry.projectedEnergyCost || 8)))
      const naturalRegen = lead > 0 ? Math.floor(lead / regenSec) : 0
      const floorNow = Math.min(enMax, Math.max(0, needAtUnlock - naturalRegen))
      if (floorNow > requiredNowFloor) {
        requiredNowFloor = floorNow
        reserveUntilSec = Number(entry.expectedUnlockAt)
      } else if (floorNow > 0 && floorNow === requiredNowFloor) {
        reserveUntilSec = Math.max(reserveUntilSec, Number(entry.expectedUnlockAt))
      }
    }
    return {
      staminaReserveFloor: requiredNowFloor,
      staminaReserveUntilSec: requiredNowFloor > 0 ? reserveUntilSec : 0,
    }
  }

  /**
   * Pure in-memory read of unblocked upcoming snipe targets (`0 < expectedUnlockAt - nowSec <= horizonSec`)
   * so `buildObservationEnvelope` & `solveUnifiedPlan` can schedule upcoming raids, farm work, and stamina
   * top-ups jointly on the same physical timeline without extra HTTP GETs.
   */
  collectUpcomingTargetsForController(adapter, visitorWorld, {
    horizonSec = 3600,
    maxUpcomingTargets = 10,
  } = {}) {
    if (!this.isStealEnabled() || !visitorWorld) return []
    if (adapter && visitorWorld?.state) {
      this.ingestSharedScanUpdates(adapter, visitorWorld)
    }
    const nowSec = Number(visitorWorld.now || 0)
    const candidates = []
    for (const e of Object.values(this.data.targets || {})) {
      if (!e || this.isTargetBlocked(e, nowSec)) continue
      const waves = Array.isArray(e.upcomingWaves) && e.upcomingWaves.length > 0
        ? e.upcomingWaves
        : (e.upcomingEligible && e.expectedUnlockAt != null
            ? [{
                waveIndex: 0,
                unlockAt: e.expectedUnlockAt,
                exactUnlockKnown: e.exactUnlockKnown,
                upcomingSpots: e.upcomingSpots,
                projectedScore: e.projectedScore,
                upcomingBeliefSummary: e.upcomingBeliefSummary,
              }]
            : [])
      const cached = this._liveVisitBundles.get(e.id)
      for (const w of waves) {
        if (w.waveIndex === 0 && e.readyEligible && !(Number(w.upcomingSpots || 0) > Number(e.stealableCount || 0))) {
          continue
        }
        const unlockAtSec = Math.floor(Number(w.unlockAt || 0))
        const lead = unlockAtSec - nowSec
        if (!(lead > 0 && lead <= horizonSec)) continue
        if (Number(w.upcomingSpots || 0) < this.minStealSpots) continue
        const waveBundle = cached?.waveBundlesByUnlock?.get(unlockAtSec)
          || (w.waveIndex === 0 ? (cached?.upcomingWaveBundle || cached?.waveBundle || null) : null)
        const beliefSummary = w.upcomingBeliefSummary || e.upcomingBeliefSummary || null
        if (!waveBundle && !beliefSummary) continue

        candidates.push({
          id: e.id,
          targetId: e.id,
          name: e.name || String(e.id),
          waveIndex: Number(w.waveIndex || 0),
          ownerLeft: Number(e.ownerLeft ?? 1),
          unlockAtSec,
          expectedUnlockAt: unlockAtSec,
          exactUnlockKnown: Boolean(w.exactUnlockKnown),
          upcomingSpots: Number(w.upcomingSpots || 0),
          projectedScore: Number(w.projectedScore || e.projectedScore || 0),
          waveBundle,
          upcomingBeliefSummary: beliefSummary,
        })
      }
    }

    return candidates
      .sort((a, b) => (b.projectedScore - a.projectedScore) || (a.unlockAtSec - b.unlockAtSec))
      .slice(0, maxUpcomingTargets)
      .sort((a, b) => (a.unlockAtSec - b.unlockAtSec) || (a.id - b.id))
  }

  /**
   * Returns fresh `neighborTargets` array (`{ id, owner, isle, posterior }`) for `runControllerStep`
   * by probing ready/due targets from `schedule.targets` (up to `maxReadyProbes`).
   */
  async collectReadyNeighborBundlesForController(adapter, httpClient, visitorWorld, {
    maxReadyProbes = 4,
    allowThiefBuffPurchase = true,
    cashReserveFloor = 10,
  } = {}) {
    if (!this.isStealEnabled()) return []
    if (adapter && visitorWorld?.state) {
      this.ingestSharedScanUpdates(adapter, visitorWorld, {
        allowThiefBuffPurchase,
        cashReserveFloor,
      })
    }
    const nowSec = Number(visitorWorld?.now || httpClient.estimatedServerNowSec())
    const dueReady = Object.values(this.data.targets || {})
      .filter((e) => e && !this.isTargetBlocked(e, nowSec) && (
        e.readyEligible ||
        (e.upcomingEligible && e.expectedUnlockAt != null && e.expectedUnlockAt <= nowSec)
      ))
      .sort((a, b) => (Number(b.projectedScore || 0) - Number(a.projectedScore || 0)))
      .slice(0, maxReadyProbes)

    const out = []
    for (const e of dueReady) {
      const cached = this._liveVisitBundles.get(e.id)
      if (cached && (nowSec - cached.atSec) <= 20 && e.readyEligible) {
        out.push(cached.bundle)
        continue
      }
      try {
        const v = await httpClient.getJson(`/api/pet/world/visit/${e.id}`)
        const updated = this.recordVisitSnapshot(adapter, visitorWorld, e.id, v, {
          allowThiefBuffPurchase,
          cashReserveFloor,
        })
        const freshCached = this._liveVisitBundles.get(e.id)
        if (updated?.readyEligible && freshCached) {
          out.push(freshCached.bundle)
        }
      } catch {}
    }
    return out
  }

  /**
   * Executes Pre-Unlock Staged Snipe when an `exactUnlockKnown` target is within `stageWindowSec` (`12s`):
   *   1. Guard-log sync if `needsGuardLogSync` (re-checking EV before risking fine!)
   *   2. At `T - 6s` (before gear lock): thief buff (`stealth`/`carry`) + stamina prep via `executeTransaction('act')`
   *   3. Inside `executeWithTacticalLoadout` (`T - 2.5s`): pre-equips optimal CRN gear -> `sleepUntilServerSec(T_unlock, 35)`
   *      -> fires `POST /api/pet/world/visit/:id` directly (`0` extra GET!) -> receipt-first snapshot/breaker -> `finally` restore resting gear!
   */
  async executeStagedSnipe({
    adapter,
    httpClient,
    journal,
    lockRootDir,
    fetchWorldFn,
    userConstraints = {},
    stageWindowSec = null,
    postUnlockOffsetMs = 25,
    arcadeStandbyOptions = {},
  }) {
    if (!this.isStealEnabled()) return { status: 'disabled-for-account' }

    const estNow = httpClient.estimatedServerNowSec()
    const nextInfo = this.nextExactUnlockInfo(estNow)
    if (!nextInfo) {
      return { status: 'no-imminent-snipe', nextUnlock: null }
    }
    const physicalLeadSec = this.computePhysicalPrepLeadSec(nextInfo.entry, adapter, httpClient)
    const effStageWindowSec = stageWindowSec != null
      ? Number(stageWindowSec)
      : Math.ceil(physicalLeadSec + 2)
    if (nextInfo.leadSec > effStageWindowSec) {
      return { status: 'no-imminent-snipe', nextUnlock: nextInfo, physicalLeadSec }
    }

    const { targetId, entry, unlockAt } = nextInfo
    const rawEntry = this.data.targets[String(targetId)] || nextInfo.rawEntry || entry
    const committedRaid = nextInfo.committedRaid
      || this.activeRaidSchedule?.committedByTargetId?.get(Number(targetId))
      || null
    const schedulePlanId = this.activeRaidSchedule?.planId || null
    let usedCommittedSchedule = false
    let scheduleReselectReason = nextInfo.unplannedImminentDiscovery
      ? 'imminent-unplanned-discovery-reselect'
      : (this.activeRaidSchedule && !committedRaid ? 'unscheduled-fallback' : null)
    let prepFallbackReason = null
    const constraints = this._normalizeSchedulerConstraints(userConstraints)

    // 1) Guard-log freshness check if target had a prior un-synced loss
    if (rawEntry.needsGuardLogSync && this.profileStorePath) {
      await syncGuardLogProfiles(httpClient, this.accountKey, { storePath: this.profileStorePath })
      rawEntry.needsGuardLogSync = false
      this.data.targets[String(targetId)] = rawEntry
      const cached = this._liveVisitBundles.get(targetId)
      if (cached) {
        const wCheck = await fetchWorldFn()
        const reEval = this.recordVisitSnapshot(adapter, wCheck, targetId, {
          owner: cached.bundle.owner,
          isle: cached.bundle.isle,
          state: cached.bundle.state,
          now: wCheck.now,
        }, {
          gearData: cached.gearData || null,
          observedPanels: cached.observedPanels || null,
          allowThiefBuffPurchase: constraints.allowThiefBuffPurchase,
          cashReserveFloor: constraints.cashReserveFloor,
        })
        if (!reEval?.upcomingEligible && !reEval?.readyEligible) {
          reEval.blockedUntil = Number(wCheck.now || estNow) + 600
          reEval.blockedReason = 'negative-ev-after-guard-sync'
          this.save(Number(wCheck.now || estNow))
          return { status: 'aborted-negative-ev-after-guard-sync', targetId }
        }
      }
    }

    return withAccountLock(lockRootDir, this.accountKey, async () => {
      // Wait down to `unlockAt - physicalLeadSec` derived strictly from actual action cooldowns + gear swaps + RTT!
      const preStageWaitMs = (unlockAt - physicalLeadSec) * 1000 - httpClient.estimatedServerNowMs()
      if (preStageWaitMs > 0) {
        await httpClient.sleepMsFn(preStageWaitMs)
      }

      let liveWorld = await fetchWorldFn()
      if (!liveWorld || !Number.isFinite(Number(liveWorld.now))) {
        return { status: 'fetch-world-failed', targetId }
      }
      adapter.syncClock(liveWorld.clockStart)
      if (journal) {
        reconcileUnknownWithFreshWorld(journal, adapter, liveWorld, {
          onReconciledVisitFn: (info) => this.recordReconciledVisit(info),
        })
      }

      const arcadeInfo = getManualArcadeStandbyInfo(
        liveWorld,
        httpClient?.estimatedServerNowSec?.() ?? liveWorld?.now,
        arcadeStandbyOptions
      )
      if (arcadeInfo.active) {
        return {
          status: 'standby-manual-arcade',
          targetId,
          arcadeStandby: arcadeInfo,
          world: liveWorld,
          nextWakeSec: Math.min(Number(liveWorld.now || 0) + 5, arcadeInfo.resumeAtSec),
        }
      }

      // Check steal quota occupation
      const curIsleIdx = adapter.R.isleIndex(liveWorld.now)
      const usedSteals = journal ? journal.countOccupiedBudget('steal', curIsleIdx) : 0
      const remSteals = constraints.maxStealsPerIsleDay == null
        ? 3
        : Math.max(0, constraints.maxStealsPerIsleDay - usedSteals)
      if (remSteals <= 0) {
        return { status: 'steal-budget-exhausted', targetId }
      }

      // 2) Committed Raid Contract Fast-Path (`< 1ms` live precondition check, 0 duplicate evaluation!)
      //    with fail-closed Unified Re-Evaluation fallback if preconditions drifted or target was unplanned.
      const cachedRec = this._liveVisitBundles.get(targetId)
      let fullPrepBatch = []
      let neededEn = Math.max(1, Number(committedRaid?.energyCost || rawEntry.projectedEnergyCost || 6))
      let precomputedDecision = committedRaid?.tacticalDecision || cachedRec?.tacticalDecision || null

      if (committedRaid && !committedRaid.isImmediate) {
        const unlockMatches = Math.abs(Number(unlockAt) - Number(committedRaid.unlockAtSec ?? unlockAt)) <= 2
        const spotsStillOk = Number(rawEntry.upcomingSpots || rawEntry.stealableCount || committedRaid.totalSpots || 0) >= this.minStealSpots
        if (unlockMatches && spotsStillOk) {
          let precondOk = true
          let simW = adapter.advanceTimeOnly(liveWorld, liveWorld.now)
          const verifiedCommittedPrep = []

          for (const act of committedRaid.plannedBuffActs || []) {
            const buffDef = act?.a === 'buy' ? adapter.R.THIEF_ITEMS?.[act.id] : null
            if (!buffDef || constraints.allowThiefBuffPurchase === false) continue
            const curEff = adapter.R.b12Effect?.(simW.state, buffDef.slot, simW.now)
            if (curEff && curEff.id === act.id && curEff.until > simW.now + 60) continue
            if (curEff?.legacy || (curEff && curEff.id !== act.id)) {
              precondOk = false
              break
            }
            const step = adapter.simulateBatch(simW, [act], { t: simW.now, prices: simW.prices })
            if (!step.allOk) {
              precondOk = false
              break
            }
            verifiedCommittedPrep.push(act)
            simW = step.afterWorld
          }

          if (precondOk && Math.floor(Number(simW.state?.en || 0)) < neededEn) {
            for (const act of committedRaid.plannedStaminaPrepActs || []) {
              if ((act.a === 'eat' || act.a === 'coffee') && Math.floor(Number(simW.state?.en || 0)) >= neededEn) continue
              const step = adapter.simulateBatch(simW, [act], { t: simW.now, prices: simW.prices })
              if (!step.allOk) {
                precondOk = false
                break
              }
              verifiedCommittedPrep.push(act)
              simW = step.afterWorld
            }
          }

          const minCashFloor = Number(
            committedRaid.preconditions?.minCashFloor ?? constraints.cashReserveFloor ?? 0
          )
          if (
            precondOk &&
            Math.floor(Number(simW.state?.en || 0)) >= neededEn &&
            Number(simW.coins || 0) >= minCashFloor
          ) {
            usedCommittedSchedule = true
            fullPrepBatch = verifiedCommittedPrep
            precomputedDecision = committedRaid.tacticalDecision || cachedRec?.tacticalDecision || null
          } else {
            prepFallbackReason = 'committed-precondition-drift'
          }
        } else {
          prepFallbackReason = !unlockMatches ? 'committed-unlock-drifted' : 'committed-spots-dropped'
        }
      }

      if (!usedCommittedSchedule) {
        const evaluator = this.getUnifiedEvaluator(adapter, liveWorld, { userConstraints: constraints })
        let activeCachedRec = cachedRec
        if (!(activeCachedRec?.waveBundle || activeCachedRec?.bundle) && typeof httpClient?.getJson === 'function' && (unlockAt - httpClient.estimatedServerNowSec()) >= 2) {
          try {
            const freshSnap = await httpClient.getJson(`/api/pet/world/visit/${targetId}`)
            if (freshSnap && freshSnap.owner) {
              this.recordVisitSnapshot(adapter, liveWorld, targetId, freshSnap, {
                allowThiefBuffPurchase: constraints.allowThiefBuffPurchase !== false,
                cashReserveFloor: Number(constraints.cashReserveFloor || 0),
              })
              activeCachedRec = this._liveVisitBundles.get(targetId) || null
            }
          } catch {
            // Non-fatal fallback to persisted entry fields if mock/test endpoint lacks GET /visit/:id
          }
        }

        if (activeCachedRec?.waveBundle || activeCachedRec?.bundle) {
          const baseWave = activeCachedRec.waveBundle || activeCachedRec.bundle
          const effGearCtx = activeCachedRec.gearData
            ? { gearData: activeCachedRec.gearData, observedPanels: activeCachedRec.observedPanels }
            : this._readCachedGearContext()
          const livePosterior = (baseWave.owner?.guard && effGearCtx.gearData && this.profileStorePath)
            ? computeGuardPosteriorForTarget(effGearCtx.gearData, targetId, {
                knownOpponentLevel: baseWave.owner.level || rawEntry.level || null,
                observedPanels: effGearCtx.observedPanels,
                storePath: this.profileStorePath,
              })
            : (baseWave.posterior || null)
          const liveEval = evaluator.evaluateTargetWave(
            { ...baseWave, posterior: livePosterior },
            unlockAt,
            { visitorWorldOverride: liveWorld, remStealBudget: remSteals }
          )
          if (!liveEval.profitable || !(liveEval.decisionScore > 0)) {
            rawEntry.upcomingEligible = false
            rawEntry.readyEligible = false
            this.data.targets[String(targetId)] = rawEntry
            this.save(liveWorld.now)
            return { status: 'aborted-non-positive-unified-ev', targetId, decisionScore: liveEval.decisionScore }
          }
          fullPrepBatch = liveEval.prepActs || []
          neededEn = liveEval.neededEn || neededEn
          precomputedDecision = liveEval.tacticalDecision || livePosterior?.decision || precomputedDecision
        } else {
          let curSimW = adapter.advanceTimeOnly(liveWorld, liveWorld.now)
          const rebuiltPrep = []
          for (const act of entry.plannedPrepActs || []) {
            const buffDef = act?.a === 'buy' ? adapter.R.THIEF_ITEMS?.[act.id] : null
            if (!buffDef || constraints.allowThiefBuffPurchase === false) continue
            const curEff = adapter.R.b12Effect?.(curSimW.state, buffDef.slot, curSimW.now)
            if (curEff?.legacy || (curEff && curEff.id !== act.id)) continue
            if (curEff && curEff.id === act.id && curEff.until > curSimW.now + 60) continue
            const step = adapter.simulateBatch(curSimW, [act], { t: curSimW.now, prices: curSimW.prices })
            if (step.allOk) {
              rebuiltPrep.push(act)
              curSimW = step.afterWorld
            }
          }
          if (Number(curSimW.state?.en || 0) < neededEn) {
            const prepRes = findCheapestRaidStaminaPrep(
              adapter,
              curSimW,
              neededEn,
              new Set(['eat', 'coffee', 'stockBuy']),
              discoverRuleUtilityTokens(adapter),
              constraints
            )
            if (prepRes.feasible) {
              rebuiltPrep.push(...prepRes.prepActs)
            }
          }
          fullPrepBatch = rebuiltPrep
        }

        if (fullPrepBatch.length > 0) {
          const verifiedPrep = []
          let simW = adapter.advanceTimeOnly(liveWorld, liveWorld.now)
          for (const act of fullPrepBatch) {
            if ((act.a === 'eat' || act.a === 'coffee') && Number(simW.state?.en || 0) >= neededEn) continue
            const step = adapter.simulateBatch(simW, [act], { t: simW.now, prices: simW.prices })
            if (step.allOk) {
              verifiedPrep.push(act)
              simW = step.afterWorld
            }
          }
          fullPrepBatch = verifiedPrep
        }
      }

      if (fullPrepBatch.length === 0 && Number(liveWorld.state?.en || 0) < neededEn) {
        rawEntry.cooldownUntil = Math.max(Number(rawEntry.cooldownUntil || 0), unlockAt + 15)
        this.data.targets[String(targetId)] = rawEntry
        this.save(liveWorld.now)
        return { status: 'insufficient-stamina-for-snipe', targetId, neededEn, currentEn: liveWorld.state?.en }
      }

      if (fullPrepBatch.length > 0) {
        const prepTx = await executeTransaction({
          journal,
          adapter,
          lockRootDir,
          alreadyLocked: true,
          account: this.accountKey,
          decisionId: schedulePlanId,
          kind: 'act',
          worldBefore: liveWorld,
          requestPayload: {
            actions: fullPrepBatch,
            reason: 'staged-snipe-prep',
            targetId,
            schedulePlanId,
            usedCommittedSchedule,
            prepFallbackReason,
          },
          sendFn: async ({ operation }) => {
            const r = await httpClient.postJson('/api/pet/world/act', {
              rev: liveWorld.rev,
              operation,
              actions: fullPrepBatch,
            })
            return {
              ok: r.ok,
              status: r.status,
              networkError: r.networkError,
              body: r.body,
            }
          },
          fetchAfterWorldFn: fetchWorldFn,
        })
        if (prepTx.status !== 'confirmed') {
          return { status: 'staged-prep-failed', prepStatus: prepTx.status, targetId }
        }
        liveWorld = prepTx.worldAfter || await fetchWorldFn()
      }

      // Wait down to physical gear-swap lead (`remEquipCd + rtt + gearSwaps * perSwap + 1.1`) so `GET /battle/gear`,
      // equip cooldowns, and durable journal reservation all finish BEFORE `T_unlock`!
      const rttSec = Math.max(0.5, Math.min(2.0, Number(httpClient?.lastRttMs || 750) / 1000))
      const gearSwaps = precomputedDecision?.switchedSlots?.length ?? Number(entry.numGearChanges || (rawEntry.guard ? 2 : 0))
      const remEquipCdSec = gearSwaps > 0
        ? Math.max(0, Number(httpClient?.getRemainingBucketCooldownMs?.('POST', '/api/pet/battle/equip') || 0) / 1000)
        : 0
      const perSwapSec = Math.max(1.25, rttSec + 0.35)
      const gearLeadSec = (gearSwaps > 0 ? (remEquipCdSec + rttSec + gearSwaps * perSwapSec) : rttSec) + 1.1
      const preGearWaitMs = (unlockAt - gearLeadSec) * 1000 - httpClient.estimatedServerNowMs()
      if (preGearWaitMs > 0) {
        await httpClient.sleepMsFn(preGearWaitMs)
      }

      // 3) Pre-equip cached tactical loadout inside `.battle-gear.<account>.lock` (`0` duplicate simulation!),
      //    sleep inside `waitBeforeSendFn` to `T_unlock + postUnlockOffsetMs`, and fire `POST /visit/:id`!
      const gearLockDir = this.gearLockRoot || lockRootDir
      let visitSentServerMs = null
      const tacRes = await executeWithTacticalLoadout({
        accountKey: this.accountKey,
        lockRoot: gearLockDir,
        opponentId: targetId,
        mode: 'guard',
        knownOpponentLevel: rawEntry.level || null,
        storePath: this.profileStorePath,
        precomputedDecision,
        getGearFn: () => httpClient.getJson('/api/pet/battle/gear'),
        equipSlotFn: (slot, item) => httpClient.postJson('/api/pet/battle/equip', { slot, item }),
        actionFn: async () => {
          return executeTransaction({
            journal,
            adapter,
            lockRootDir,
            alreadyLocked: true,
            account: this.accountKey,
            decisionId: schedulePlanId,
            kind: 'visit',
            budgetKind: 'steal',
            budgetLimitPerIsleDay: constraints.maxStealsPerIsleDay,
            worldBefore: liveWorld,
            requestPayload: {
              targetId,
              expectedSpots: Math.max(this.minStealSpots, rawEntry.upcomingSpots || committedRaid?.totalSpots || 1),
              expectedEnergyCost: neededEn,
              stagedExactUnlockAt: unlockAt,
              schedulePlanId,
              usedCommittedSchedule,
              scheduleReselectReason,
              prepFallbackReason,
            },
            waitBeforeSendFn: async () => {
              await httpClient.sleepUntilServerSec(unlockAt, postUnlockOffsetMs)
            },
            sendFn: async ({ operation }) => {
              visitSentServerMs = httpClient.estimatedServerNowMs()
              const r = await httpClient.postJson(`/api/pet/world/visit/${targetId}`, {
                operation,
                kind: 'all',
                i: 0,
              })
              return {
                ok: r.ok,
                status: r.status,
                networkError: r.networkError,
                body: r.body,
              }
            },
            onReceiptFn: ({ rawResp }) => {
              this.recordSnipeReceipt(adapter, targetId, rawResp, Math.max(unlockAt, httpClient.estimatedServerNowSec()), {
                visitorWorld: liveWorld,
                sentAtServerMs: visitSentServerMs,
              })
            },
            fetchAfterWorldFn: fetchWorldFn,
          })
        },
      })

      return {
        status: tacRes.result?.status || (tacRes.preEquipError ? 'pre-equip-aborted' : 'completed'),
        targetId,
        unlockAt,
        schedulePlanId,
        usedCommittedSchedule,
        scheduleReselectReason,
        prepFallbackReason,
        prepActionsSent: fullPrepBatch.length,
        switchedLoadout: tacRes.decision?.switched || false,
        switchedSlots: tacRes.decision?.switchedSlots || [],
        restoreOk: tacRes.restoreOk,
        txResult: tacRes.result,
      }
    })
  }

  async _runSharedDiscoverySlice(adapter, httpClient, visitorWorld, {
    maxPages = 2,
    maxProbes = 4,
    preemptWindowSec = 50,
    markedSyncIntervalSec = 180,
    headSyncIntervalSec = 45,
    allowThiefBuffPurchase = true,
    cashReserveFloor = 10,
  } = {}) {
    const shouldAbortNow = () => this.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec(), preemptWindowSec)
    const baseIsleSpan = Number(adapter?.R?.ISLE_SPAN || 14400)

    this.ingestSharedScanUpdates(adapter, visitorWorld, {
      allowThiefBuffPurchase,
      cashReserveFloor,
    })

    const claim = mutateSharedScanSync(this.sharedScanFilePath, (shared) => {
      const t = httpClient.estimatedServerNowSec()
      const doMarkedSync = (t - Number(shared.lastMarkedSyncAtSec || 0)) >= markedSyncIntervalSec
      if (doMarkedSync) shared.lastMarkedSyncAtSec = t
      const leaseBusy = Number(shared.cursorLeaseUntilSec || 0) > t && shared.cursorLeaseBy && shared.cursorLeaseBy !== this.accountKey
      const claimCursor = !leaseBusy
      const claimedCursor = shared.discoveryCursor || null
      const doHeadScan = Boolean(claimedCursor && maxPages >= 2 && (t - Number(shared.lastHeadScanAtSec || 0)) >= headSyncIntervalSec)
      if (doHeadScan) shared.lastHeadScanAtSec = t
      if (claimCursor) {
        shared.cursorLeaseUntilSec = t + 12
        shared.cursorLeaseBy = this.accountKey
      }
      return {
        save: doMarkedSync || doHeadScan || claimCursor,
        result: { doMarkedSync, doHeadScan, claimCursor, claimedCursor },
      }
    })

    let pagesScanned = 0
    const fetchedItems = []
    let cursorNext = claim.claimedCursor
    let cursorFetched = false
    let cursorReset = false
    let scannedHeadAt = 0
    let abortedBeforeProbes = false

    if (claim.doMarkedSync) {
      if (shouldAbortNow()) {
        abortedBeforeProbes = true
      } else {
        try {
          const markedResp = await httpClient.getJson('/api/pet/world/neighbors/marked?limit=20&q=')
          for (const it of markedResp?.neighbors || []) fetchedItems.push({ item: it, pageAsOf: markedResp?.asOf })
        } catch {}
      }
    }

    if (!abortedBeforeProbes && claim.doHeadScan) {
      if (shouldAbortNow()) {
        abortedBeforeProbes = true
      } else {
        try {
          const headResp = await httpClient.getJson('/api/pet/world/neighbors?limit=20&q=')
          pagesScanned++
          scannedHeadAt = Math.max(scannedHeadAt, httpClient.estimatedServerNowSec())
          for (const it of headResp?.neighbors || []) fetchedItems.push({ item: it, pageAsOf: headResp?.asOf })
        } catch {}
      }
    }

    if (!abortedBeforeProbes && claim.claimCursor) {
      while (pagesScanned < maxPages) {
        if (shouldAbortNow()) {
          abortedBeforeProbes = true
          break
        }
        const q = new URLSearchParams({ limit: '20', q: '' })
        const scannedHead = !cursorNext
        if (cursorNext) q.set('cursor', cursorNext)
        try {
          const dirResp = await httpClient.getJson(`/api/pet/world/neighbors?${q.toString()}`)
          pagesScanned++
          cursorFetched = true
          if (scannedHead) {
            scannedHeadAt = Math.max(scannedHeadAt, httpClient.estimatedServerNowSec())
          }
          for (const it of dirResp?.neighbors || []) fetchedItems.push({ item: it, pageAsOf: dirResp?.asOf })
          cursorNext = dirResp?.nextCursor || null
          if (!cursorNext) break
        } catch (err) {
          if (/列表已更新/.test(String(err?.message || ''))) {
            cursorNext = null
            cursorReset = true
          }
          break
        }
      }
    }

    const foldOut = mutateSharedScanSync(this.sharedScanFilePath, (shared) => {
      const foldNowSec = httpClient.estimatedServerNowSec()
      if (claim.claimCursor && shared.cursorLeaseBy === this.accountKey) {
        shared.cursorLeaseUntilSec = 0
        shared.cursorLeaseBy = null
      }
      if (cursorFetched || cursorReset) {
        shared.discoveryCursor = cursorNext
      }
      if (scannedHeadAt > 0) {
        shared.lastHeadScanAtSec = Math.max(Number(shared.lastHeadScanAtSec || 0), scannedHeadAt)
      }

      for (const { item, pageAsOf } of fetchedItems) {
        if (!item || item.id == null) continue
        const id = Number(item.id)
        if (!Number.isFinite(id) || this.selfIds.has(id)) continue
        if (item.newbie) continue

        const idKey = String(id)
        const refNowSec = Number.isFinite(Number(pageAsOf)) && Number(pageAsOf) > 0
          ? Math.floor(Number(pageAsOf))
          : foldNowSec
        const activeAt = Number(item.active || 0)
        const level = Number(item.level || 1)
        const dirSpots = Number(item.plots || 0) + Number(item.pens || 0)
        const hasLiveSteal = Boolean(item.canSteal) || dirSpots >= this.minStealSpots
        const sRec = shared.islands[idKey]
        const prevPending = shared.pendingDirItems[idKey]

        if (sRec) {
          const knownActiveAt = Math.max(Number(sRec.lastKnownOwnerActiveAt || 0), Number(sRec.observedAtSec || 0))
          const ownerActedSinceProbe = activeAt > knownActiveAt
          if (sRec.quiescentEmpty && ownerActedSinceProbe) {
            sRec.quiescentEmpty = false
            sRec.emptyStreak = 0
            sRec.lastKnownOwnerActiveAt = activeAt
            sRec.sharedNextProbeAt = foldNowSec
            shared.pendingDirItems[idKey] = {
              id,
              level,
              dirSpots,
              hasLiveSteal,
              activeAt,
              refNowSec,
              priorityBoost: 'awakened',
              queuedAt: foldNowSec,
              probeLeaseUntilSec: Number(prevPending?.probeLeaseUntilSec || 0),
              probeLeaseBy: prevPending?.probeLeaseBy || null,
            }
          } else if (sRec.quiescentEmpty && activeAt > 0 && activeAt <= knownActiveAt && !hasLiveSteal) {
            sRec.lastKnownOwnerActiveAt = Math.max(Number(sRec.lastKnownOwnerActiveAt || 0), activeAt)
            sRec.sharedNextProbeAt = Math.max(Number(sRec.sharedNextProbeAt || 0), foldNowSec + baseIsleSpan)
            delete shared.pendingDirItems[idKey]
          } else {
            sRec.lastKnownOwnerActiveAt = Math.max(Number(sRec.lastKnownOwnerActiveAt || 0), activeAt)
            if (hasLiveSteal || Number(sRec.sharedNextProbeAt || 0) <= foldNowSec) {
              shared.pendingDirItems[idKey] = {
                id,
                level,
                dirSpots,
                hasLiveSteal,
                activeAt,
                refNowSec,
                priorityBoost: ownerActedSinceProbe ? 'acted' : (prevPending?.priorityBoost || null),
                queuedAt: foldNowSec,
                probeLeaseUntilSec: Number(prevPending?.probeLeaseUntilSec || 0),
                probeLeaseBy: prevPending?.probeLeaseBy || null,
              }
            }
          }
        } else {
          shared.pendingDirItems[idKey] = {
            id,
            level,
            dirSpots,
            hasLiveSteal,
            activeAt,
            refNowSec,
            queuedAt: foldNowSec,
            probeLeaseUntilSec: Number(prevPending?.probeLeaseUntilSec || 0),
            probeLeaseBy: prevPending?.probeLeaseBy || null,
          }
        }
      }

      const pendingKeys = Object.keys(shared.pendingDirItems)
      if (pendingKeys.length > 500) {
        const sortedOld = pendingKeys
          .map((k) => ({ k, item: shared.pendingDirItems[k] }))
          .filter((x) => x.item && !x.item.hasLiveSteal)
          .sort((a, b) => Number(a.item.queuedAt || 0) - Number(b.item.queuedAt || 0))
        for (const rm of sortedOld.slice(0, pendingKeys.length - 500)) {
          delete shared.pendingDirItems[rm.k]
        }
      }

      if (abortedBeforeProbes) {
        shared.updatedAt = Math.max(Number(shared.updatedAt || 0), foldNowSec)
        return {
          save: true,
          result: {
            aborted: true,
            chosen: [],
            nextCursor: shared.discoveryCursor,
            lastMarked: shared.lastMarkedSyncAtSec,
            lastHead: shared.lastHeadScanAtSec,
          },
        }
      }

      const candidates = []
      const seenSharedIds = new Set()

      for (const [idKey, pItem] of Object.entries(shared.pendingDirItems)) {
        if (!pItem) continue
        const id = Number(pItem.id ?? idKey)
        if (!Number.isFinite(id) || this.selfIds.has(id) || seenSharedIds.has(id)) continue
        seenSharedIds.add(id)

        const myEntry = this.data.targets[idKey]
        if (myEntry && this.isTargetBlocked(myEntry, foldNowSec)) continue
        const sRec = shared.islands[idKey]
        const leaseActive = (Number(pItem.probeLeaseUntilSec || 0) > foldNowSec && pItem.probeLeaseBy && pItem.probeLeaseBy !== this.accountKey)
          || (sRec && Number(sRec.probeLeaseUntilSec || 0) > foldNowSec && sRec.probeLeaseBy && sRec.probeLeaseBy !== this.accountKey)
        if (leaseActive) continue

        const dirSpots = Number(pItem.dirSpots || 0)
        const level = Number(pItem.level || 1)
        const activeAt = Number(pItem.activeAt || 0)
        const hasLiveSteal = Boolean(pItem.hasLiveSteal)

        const committedDue = Boolean(myEntry && this._isCommittedImminentProbeDue(myEntry, foldNowSec))
        if (!hasLiveSteal && !committedDue && sRec && Number(sRec.sharedNextProbeAt || 0) > foldNowSec && !pItem.priorityBoost) {
          delete shared.pendingDirItems[idKey]
          continue
        }

        let priority
        if (myEntry && this._candidatePriorityForEntry(myEntry, foldNowSec) === 220) {
          priority = 220
        } else if (hasLiveSteal) {
          priority = 150 + Math.min(30, dirSpots)
        } else if (sRec) {
          const ownerActed = activeAt > Number(sRec.observedAtSec || 0)
          if (pItem.priorityBoost === 'awakened' || (ownerActed && !sRec.quiescentEmpty && !(Number(sRec.latestUnlockAt || 0) > foldNowSec))) {
            priority = 95 + Math.min(15, level)
          } else {
            priority = sRec.quiescentEmpty ? 12 : (85 + (Number(sRec.latestUnlockAt || 0) > foldNowSec ? 20 : 0))
          }
        } else {
          const activeAgeSec = activeAt > 0 ? Math.max(0, Number(pItem.refNowSec || foldNowSec) - activeAt) : Infinity
          priority = activeAgeSec <= 86400 ? (60 + Math.min(20, level)) : (25 + Math.min(10, level))
        }

        candidates.push({
          id,
          dirSpots,
          level,
          directoryActiveAt: activeAt,
          priority,
          nextProbeAt: sRec ? Number(sRec.sharedNextProbeAt || 0) : 0,
        })
      }

      for (const [idKey, sRec] of Object.entries(shared.islands)) {
        if (!sRec) continue
        const id = Number(sRec.id ?? idKey)
        if (!Number.isFinite(id) || this.selfIds.has(id) || seenSharedIds.has(id)) continue
        const myEntry = this.data.targets[idKey]
        if (myEntry && this.isTargetBlocked(myEntry, foldNowSec)) continue
        const committedDue = Boolean(myEntry && this._isCommittedImminentProbeDue(myEntry, foldNowSec))
        if (Number(sRec.sharedNextProbeAt || 0) > foldNowSec && !committedDue) continue
        if (Number(sRec.probeLeaseUntilSec || 0) > foldNowSec && sRec.probeLeaseBy && sRec.probeLeaseBy !== this.accountKey) {
          continue
        }
        seenSharedIds.add(id)
        const priority = (myEntry && this._candidatePriorityForEntry(myEntry, foldNowSec) === 220)
          ? 220
          : (sRec.quiescentEmpty ? 12 : (85 + (Number(sRec.latestUnlockAt || 0) > foldNowSec ? 20 : 0)))
        candidates.push({
          id,
          dirSpots: sRec.hasLiveSteal ? 1 : 0,
          level: Number(sRec.owner?.level || 1),
          directoryActiveAt: Number(sRec.lastKnownOwnerActiveAt || 0),
          priority,
          nextProbeAt: Number(sRec.sharedNextProbeAt || 0),
        })
      }

      if (this.activeRaidSchedule?.committedByTargetId) {
        for (const [idNum] of this.activeRaidSchedule.committedByTargetId.entries()) {
          if (seenSharedIds.has(idNum) || this.selfIds.has(idNum)) continue
          const myEntry = this.data.targets[String(idNum)]
          if (!myEntry || this.isTargetBlocked(myEntry, foldNowSec)) continue
          if (!this._isCommittedImminentProbeDue(myEntry, foldNowSec)) continue
          seenSharedIds.add(idNum)
          candidates.push({
            id: idNum,
            dirSpots: Number(myEntry.stealableCount || 0) + Number(myEntry.upcomingSpots || 0),
            level: Number(myEntry.level || 1),
            directoryActiveAt: Number(myEntry.lastKnownOwnerActiveAt || 0),
            priority: 220,
            nextProbeAt: myEntry.nextProbeAt || 0,
          })
        }
      }

      candidates.sort(
        (a, b) =>
          (b.priority - a.priority) ||
          (b.dirSpots - a.dirSpots) ||
          ((b.level || 0) - (a.level || 0)) ||
          ((b.directoryActiveAt || 0) - (a.directoryActiveAt || 0)) ||
          (a.nextProbeAt - b.nextProbeAt)
      )
      const chosen = candidates.slice(0, maxProbes)
      for (const cand of chosen) {
        const k = String(cand.id)
        if (shared.pendingDirItems[k]) {
          shared.pendingDirItems[k].probeLeaseUntilSec = foldNowSec + 20
          shared.pendingDirItems[k].probeLeaseBy = this.accountKey
        }
        if (shared.islands[k]) {
          shared.islands[k].probeLeaseUntilSec = foldNowSec + 20
          shared.islands[k].probeLeaseBy = this.accountKey
        }
      }
      shared.updatedAt = Math.max(Number(shared.updatedAt || 0), foldNowSec)
      return {
        save: true,
        result: {
          aborted: false,
          chosen,
          nextCursor: shared.discoveryCursor,
          lastMarked: shared.lastMarkedSyncAtSec,
          lastHead: shared.lastHeadScanAtSec,
        },
      }
    })

    this.data.discoveryCursor = foldOut.nextCursor
    this.data.lastMarkedSyncAtSec = foldOut.lastMarked
    this.data.lastHeadScanAtSec = foldOut.lastHead

    if (foldOut.aborted) {
      this.save(httpClient.estimatedServerNowSec())
      return { status: 'preempted-by-snipe', pagesScanned, islandsProbed: 0 }
    }

    const leasedKeys = new Set(foldOut.chosen.map((c) => String(c.id)))
    const releaseLeftoverLeases = () => {
      if (leasedKeys.size === 0) return
      mutateSharedScanSync(this.sharedScanFilePath, (shared) => {
        let dirty = false
        for (const k of leasedKeys) {
          if (shared.pendingDirItems[k]?.probeLeaseBy === this.accountKey) {
            shared.pendingDirItems[k].probeLeaseUntilSec = 0
            shared.pendingDirItems[k].probeLeaseBy = null
            dirty = true
          }
          if (shared.islands[k]?.probeLeaseBy === this.accountKey) {
            shared.islands[k].probeLeaseUntilSec = 0
            shared.islands[k].probeLeaseBy = null
            dirty = true
          }
        }
        return { save: dirty }
      })
    }

    let islandsProbed = 0
    for (const cand of foldOut.chosen) {
      if (shouldAbortNow()) {
        releaseLeftoverLeases()
        this.save(httpClient.estimatedServerNowSec())
        return { status: 'preempted-by-snipe', pagesScanned, islandsProbed }
      }
      try {
        const v = await httpClient.getJson(`/api/pet/world/visit/${cand.id}`)
        islandsProbed++
        const updated = this.recordVisitSnapshot(adapter, visitorWorld, cand.id, v, {
          allowThiefBuffPurchase,
          cashReserveFloor,
          directoryActiveAt: cand.directoryActiveAt || 0,
        })
        if (updated) {
          leasedKeys.delete(String(cand.id))
        }
        if (updated?.readyEligible) {
          releaseLeftoverLeases()
          this.save(httpClient.estimatedServerNowSec())
          return {
            status: 'ready-target-found',
            readyTargetId: cand.id,
            pagesScanned,
            islandsProbed,
            nextCursor: this.data.discoveryCursor,
          }
        }
      } catch {
        const failNow = httpClient.estimatedServerNowSec()
        const curEntry = this.data.targets?.[String(cand.id)]
        if (curEntry) {
          curEntry.lastProbeAttemptAtSec = failNow
          curEntry.nextProbeAt = Math.max(Number(curEntry.nextProbeAt || 0), failNow + 60)
        }
      }
    }

    releaseLeftoverLeases()
    this.ingestSharedScanUpdates(adapter, visitorWorld, {
      allowThiefBuffPurchase,
      cashReserveFloor,
    })
    this.save(httpClient.estimatedServerNowSec())
    return {
      status: 'slice-complete',
      pagesScanned,
      islandsProbed,
      nextCursor: this.data.discoveryCursor,
    }
  }

  /**
   * Non-blocking incremental full-server island discovery slice:
   * - Sweeps `marked` islands + periodic Page-1 head scan + rolling `/api/pet/world/neighbors` cursor;
   * - Uses server `active` timestamps & `quiescentEmpty` backoff so dead islands never starve unindexed active farmers;
   * - Aborts IMMEDIATELY before any HTTP request if `shouldBlockBackgroundWork(nowSec, preemptWindowSec)` becomes true!
   */
  async runIncrementalDiscoverySlice(adapter, httpClient, visitorWorld, {
    maxPages = 2,
    maxProbes = 4,
    preemptWindowSec = 50,
    markedSyncIntervalSec = 180,
    headSyncIntervalSec = 45,
    allowThiefBuffPurchase = true,
    cashReserveFloor = 10,
  } = {}) {
    if (!this.isStealEnabled()) {
      return { status: 'disabled-for-account', pagesScanned: 0, islandsProbed: 0 }
    }

    const shouldAbortNow = () => this.shouldBlockBackgroundWork(httpClient.estimatedServerNowSec(), preemptWindowSec)
    if (shouldAbortNow()) {
      return { status: 'preempted-by-snipe', pagesScanned: 0, islandsProbed: 0 }
    }

    if (this.sharedScanFilePath) {
      return this._runSharedDiscoverySlice(adapter, httpClient, visitorWorld, {
        maxPages,
        maxProbes,
        preemptWindowSec,
        markedSyncIntervalSec,
        headSyncIntervalSec,
        allowThiefBuffPurchase,
        cashReserveFloor,
      })
    }

    const startNow = httpClient.estimatedServerNowSec()
    const baseIsleSpan = Number(adapter?.R?.ISLE_SPAN || 14400)
    const candidates = []
    const seenIds = new Set()
    const pushDirItem = (item, pageAsOf = null) => {
      if (!item || item.id == null) return
      const id = Number(item.id)
      if (!Number.isFinite(id) || this.selfIds.has(id) || seenIds.has(id)) return
      seenIds.add(id)
      if (item.newbie) return

      const nowSec = httpClient.estimatedServerNowSec()
      const refNowSec = Number.isFinite(Number(pageAsOf)) && Number(pageAsOf) > 0
        ? Math.floor(Number(pageAsOf))
        : nowSec
      const activeAt = Number(item.active || 0)
      const activeAgeSec = activeAt > 0 ? Math.max(0, refNowSec - activeAt) : Infinity
      const level = Number(item.level || 1)
      const dirSpots = Number(item.plots || 0) + Number(item.pens || 0)
      const hasLiveSteal = Boolean(item.canSteal) || dirSpots >= this.minStealSpots
      const existing = this.data.targets[String(id)]
      if (existing && this.isTargetBlocked(existing, nowSec)) return

      // Tier 1: live stealable spots exposed directly in directory
      if (hasLiveSteal) {
        candidates.push({
          id,
          dirSpots,
          level,
          directoryActiveAt: activeAt,
          priority: 150 + Math.min(30, dirSpots),
          nextProbeAt: existing?.nextProbeAt || 0,
        })
        return
      }

      if (existing) {
        const knownActiveAt = Math.max(
          Number(existing.lastKnownOwnerActiveAt || 0),
          Number(existing.updatedAt || 0)
        )
        const wasQuiescent = this._isEntryQuiescent(existing)
        const ownerActedSinceProbe = activeAt > knownActiveAt
        if (ownerActedSinceProbe && (wasQuiescent || !existing.upcomingEligible)) {
          existing.quiescentEmpty = false
          existing.emptyStreak = 0
          existing.lastKnownOwnerActiveAt = activeAt
          existing.nextProbeAt = nowSec
          candidates.push({
            id,
            dirSpots,
            level,
            directoryActiveAt: activeAt,
            priority: 95 + Math.min(15, level),
            nextProbeAt: nowSec,
          })
          return
        }

        if (wasQuiescent && activeAt > 0 && activeAt <= knownActiveAt) {
          existing.lastKnownOwnerActiveAt = Math.max(Number(existing.lastKnownOwnerActiveAt || 0), activeAt)
          existing.nextProbeAt = Math.max(Number(existing.nextProbeAt || 0), nowSec + baseIsleSpan)
          return
        }

        if (ownerActedSinceProbe) {
          existing.lastKnownOwnerActiveAt = activeAt
        }

        if (Number(existing.nextProbeAt || 0) <= nowSec || this._isCommittedImminentProbeDue(existing, nowSec)) {
          candidates.push({
            id,
            dirSpots: Math.max(dirSpots, Number(existing.stealableCount || 0) + Number(existing.upcomingSpots || 0)),
            level: Math.max(level, Number(existing.level || 1)),
            directoryActiveAt: activeAt,
            priority: this._candidatePriorityForEntry(existing, nowSec),
            nextProbeAt: existing.nextProbeAt || 0,
          })
        }
        return
      }

      // Tier 3 (recently active <= 24h) vs Tier 4 (stale tail)
      const isRecentlyActive = activeAgeSec <= 86400
      candidates.push({
        id,
        dirSpots,
        level,
        directoryActiveAt: activeAt,
        priority: isRecentlyActive ? (60 + Math.min(20, level)) : (25 + Math.min(10, level)),
        nextProbeAt: 0,
      })
    }

    let pagesScanned = 0
    if (startNow - Number(this.data.lastMarkedSyncAtSec || 0) >= markedSyncIntervalSec) {
      if (shouldAbortNow()) return { status: 'preempted-by-snipe', pagesScanned, islandsProbed: 0 }
      try {
        const markedResp = await httpClient.getJson('/api/pet/world/neighbors/marked?limit=20&q=')
        this.data.lastMarkedSyncAtSec = httpClient.estimatedServerNowSec()
        for (const it of markedResp?.neighbors || []) pushDirItem(it, markedResp?.asOf)
      } catch {}
    }

    // Periodic Page-1 head scan catches newly active high-level farmers without resetting rolling `discoveryCursor`
    if (
      this.data.discoveryCursor &&
      maxPages >= 2 &&
      startNow - Number(this.data.lastHeadScanAtSec || 0) >= headSyncIntervalSec
    ) {
      if (shouldAbortNow()) {
        this.save(httpClient.estimatedServerNowSec())
        return { status: 'preempted-by-snipe', pagesScanned, islandsProbed: 0 }
      }
      try {
        const headResp = await httpClient.getJson('/api/pet/world/neighbors?limit=20&q=')
        pagesScanned++
        this.data.lastHeadScanAtSec = httpClient.estimatedServerNowSec()
        for (const it of headResp?.neighbors || []) pushDirItem(it, headResp?.asOf)
      } catch {}
    }

    while (pagesScanned < maxPages) {
      if (shouldAbortNow()) {
        this.save(httpClient.estimatedServerNowSec())
        return { status: 'preempted-by-snipe', pagesScanned, islandsProbed: 0 }
      }
      const q = new URLSearchParams({ limit: '20', q: '' })
      const scannedHead = !this.data.discoveryCursor
      if (this.data.discoveryCursor) q.set('cursor', this.data.discoveryCursor)
      try {
        const dirResp = await httpClient.getJson(`/api/pet/world/neighbors?${q.toString()}`)
        pagesScanned++
        if (scannedHead) {
          this.data.lastHeadScanAtSec = httpClient.estimatedServerNowSec()
        }
        for (const it of dirResp?.neighbors || []) pushDirItem(it, dirResp?.asOf)
        this.data.discoveryCursor = dirResp?.nextCursor || null
        if (!this.data.discoveryCursor) break
      } catch (err) {
        if (/列表已更新/.test(String(err?.message || ''))) {
          this.data.discoveryCursor = null
        }
        break
      }
    }

    // Include remaining due indexed targets not already seen/processed on scanned directory pages
    const afterDirNow = httpClient.estimatedServerNowSec()
    for (const e of Object.values(this.data.targets || {})) {
      if (!e || seenIds.has(e.id) || this.selfIds.has(e.id) || this.isTargetBlocked(e, afterDirNow)) continue
      if (Number(e.nextProbeAt || 0) <= afterDirNow || this._isCommittedImminentProbeDue(e, afterDirNow)) {
        seenIds.add(e.id)
        candidates.push({
          id: e.id,
          dirSpots: Number(e.stealableCount || 0) + Number(e.upcomingSpots || 0),
          level: Number(e.level || 1),
          directoryActiveAt: Number(e.lastKnownOwnerActiveAt || 0),
          priority: this._candidatePriorityForEntry(e, afterDirNow),
          nextProbeAt: e.nextProbeAt || 0,
        })
      }
    }

    candidates.sort(
      (a, b) =>
        (b.priority - a.priority) ||
        (b.dirSpots - a.dirSpots) ||
        ((b.level || 0) - (a.level || 0)) ||
        ((b.directoryActiveAt || 0) - (a.directoryActiveAt || 0)) ||
        (a.nextProbeAt - b.nextProbeAt)
    )
    const toProbe = candidates.slice(0, maxProbes)
    let islandsProbed = 0

    for (const cand of toProbe) {
      if (shouldAbortNow()) {
        this.save(httpClient.estimatedServerNowSec())
        return { status: 'preempted-by-snipe', pagesScanned, islandsProbed }
      }
      try {
        const v = await httpClient.getJson(`/api/pet/world/visit/${cand.id}`)
        islandsProbed++
        const updated = this.recordVisitSnapshot(adapter, visitorWorld, cand.id, v, {
          allowThiefBuffPurchase,
          cashReserveFloor,
          directoryActiveAt: cand.directoryActiveAt || 0,
        })
        // Immediately break out of discovery when a live unlocked high-EV target is spotted so controller raids in <1s!
        if (updated?.readyEligible) {
          this.save(httpClient.estimatedServerNowSec())
          return {
            status: 'ready-target-found',
            readyTargetId: cand.id,
            pagesScanned,
            islandsProbed,
            nextCursor: this.data.discoveryCursor,
          }
        }
      } catch {
        const failNow = httpClient.estimatedServerNowSec()
        const curEntry = this.data.targets?.[String(cand.id)]
        if (curEntry) {
          curEntry.lastProbeAttemptAtSec = failNow
          curEntry.nextProbeAt = Math.max(Number(curEntry.nextProbeAt || 0), failNow + 60)
        }
      }
    }

    this.save(httpClient.estimatedServerNowSec())
    return {
      status: 'slice-complete',
      pagesScanned,
      islandsProbed,
      nextCursor: this.data.discoveryCursor,
    }
  }
}
