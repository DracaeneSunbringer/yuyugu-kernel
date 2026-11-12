import fs from 'node:fs'
import path from 'node:path'
import {
  computeStaticFarmStateDigest,
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

function defaultScheduleData() {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    discoveryCursor: null,
    lastMarkedSyncAtSec: 0,
    targets: {},
  }
}

export class SnipeScheduler {
  constructor({
    accountKey = 'main',
    scheduleFilePath = null,
    profileStorePath = null,
    gearLockRoot = null,
    selfIds = [],
    domesticOnly = false,
    minStealSpots = 1,
  } = {}) {
    this.accountKey = accountKey
    this.scheduleFilePath = scheduleFilePath
    this.profileStorePath = profileStorePath
    this.gearLockRoot = gearLockRoot
    this.selfIds = new Set((selfIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))
    this.domesticOnly = Boolean(domesticOnly) || accountKey === 'secondary'
    this.minStealSpots = this.domesticOnly ? 999999 : Math.max(1, Number(minStealSpots || 1))
    this.data = this._load()
    // Keep most recent raw `visit` snapshots in memory so `runControllerStep` & `executeStagedSnipe` get exact `isle` + `posterior`
    this._liveVisitBundles = new Map()
    this._evaluatorCache = { key: null, evaluator: null }
    this.activeRaidSchedule = null
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
    const evaluatedTargetSet = new Set((rs.evaluatedTargetIds || []).map(Number).filter(Number.isFinite))
    const committedByTargetId = new Map()
    for (const cr of rs.committedRaids || []) {
      const tid = Number(cr?.targetId)
      if (Number.isFinite(tid)) {
        committedByTargetId.set(tid, cr)
        const key = String(tid)
        if (this.data?.targets?.[key] && !cr.isImmediate) {
          this.data.targets[key].plannedPrepActs = cr.plannedPrepActs || []
          if (cr.numGearChanges != null) {
            this.data.targets[key].numGearChanges = Number(cr.numGearChanges || 0)
          }
        }
      }
    }
    this.activeRaidSchedule = {
      planId: rs.planId || plan?.planId || null,
      createdAtSec: Number(rs.createdAtSec ?? plan?.serverNow ?? world?.now ?? 0),
      sourceFarmDigest: rs.sourceFarmDigest || (world ? computeStaticFarmStateDigest(world) : null),
      evaluatedTargetSet,
      committedByTargetId,
      committedRaids: [...(rs.committedRaids || [])],
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
    const now = Number(visitorWorld?.now || 0)
    const staticDigest = computeStaticFarmStateDigest(visitorWorld)
    return [
      adapter?.rulesHash || '',
      staticDigest,
      adapter?.R?.isleIndex ? adapter.R.isleIndex(now) : 0,
      adapter?.R?.worldDay ? adapter.R.worldDay(now) : '',
      Math.floor(Number(visitorWorld?.state?.en || 0)),
      Math.floor(Number(visitorWorld?.coins || 0)),
      Boolean(constraints?.allowThiefBuffPurchase ?? true),
      Number(constraints?.cashReserveFloor ?? 10),
    ].join('|')
  }

  invalidateUnifiedBaseline() {
    this._evaluatorCache = { key: null, evaluator: null }
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
    const constraints = normalizeUserConstraints(userConstraints, this.accountKey)
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
    const constraints = normalizeUserConstraints(userConstraints, this.accountKey)
    const key = this._makeEvaluatorCacheKey(adapter, visitorWorld, constraints)
    if (this._evaluatorCache.key === key && this._evaluatorCache.evaluator) {
      return this._evaluatorCache.evaluator
    }
    const evaluator = createUnifiedRaidEvaluator(adapter, visitorWorld, {
      account: this.accountKey,
      userConstraints: constraints,
    })
    this._evaluatorCache = { key, evaluator }
    return evaluator
  }

  computePhysicalPrepLeadSec(entry, adapter = null, httpClient = null) {
    const rttSec = Math.max(0.4, Math.min(2.0, Number(httpClient?.lastRttMs || 600) / 1000))
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
    const actPrepSec = needPrepAct ? (remActCdSec + minGapSec + 2 * rttSec) : 0
    const gearPrepSec = gearSwaps > 0 ? (remEquipCdSec + gearSwaps * 1.3 + 2 * rttSec) : (entry?.guard ? rttSec : 0)
    return actPrepSec + gearPrepSec + remVisitCdSec + rttSec + 0.5
  }

  isStealEnabled() {
    return !this.domesticOnly && this.minStealSpots < 999999
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
  } = {}) {
    if (!this.isStealEnabled() || !visitData?.isle) return null
    const idNum = Number(targetId)
    if (!Number.isFinite(idNum) || this.selfIds.has(idNum)) return null

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
    const ownerLeft = Number(visitData.left?.owner ?? 999)
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
          userConstraints: { allowThiefBuffPurchase, cashReserveFloor },
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

    // Evaluate each distinct chronological unlock timestamp strictly at `u.unlockAt <= candT`
    // (zero artificial `coalesceUnlockWindowSec` delay: snipes immediately at the earliest profitable unlock!)
    if (ownerCanBeStolen && evaluator && allUnlocks.length > 0) {
      const candidateTimes = [...new Set(allUnlocks.map((u) => u.unlockAt))]
      for (const candT of candidateTimes) {
        const plotSet = new Set(futurePlots.filter((u) => u.unlockAt <= candT).map((u) => u.idx))
        const penSet = new Set(futurePens.filter((u) => u.unlockAt <= candT).map((u) => u.idx))
        const waveItems = allUnlocks.filter((u) => u.unlockAt <= candT)
        const waveExact = waveItems.length > 0 && waveItems.every((u) => u.exact)

        const simPlots = (visitData.isle?.plots || []).map((p, idx) =>
          (p && !p.steal && plotSet.has(idx)) ? { ...p, stage: 3, steal: true, stolen: 0 } : p
        )
        const simBarn = (visitData.isle?.barn || []).map((p, idx) =>
          (p && !p.steal && penSet.has(idx)) ? { ...p, steal: true, stolen: 0 } : p
        )
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
          break
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

    let nextProbeAt = nowSec + 900
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

    const upcomingBeliefSummary = upcomingWaveBelief
      ? {
          targetId: idNum,
          targetName: owner.name || String(idNum),
          totalSpots: Number(upcomingWaveBelief.totalSpots || 0),
          spotCounts: { ...(upcomingWaveBelief.spotCounts || {}) },
          hasGuard: Boolean(upcomingWaveBelief.hasGuard),
          ownerAlertId: upcomingWaveBelief.ownerAlertId || null,
          winInterval: Array.isArray(upcomingWaveBelief.winInterval) ? [...upcomingWaveBelief.winInterval] : [1, 1],
          lossInterval: Array.isArray(upcomingWaveBelief.lossInterval) ? [...upcomingWaveBelief.lossInterval] : [0, 0],
          sampleCount: Number(upcomingWaveBelief.sampleCount || 0),
          estimationSource: upcomingWaveBelief.estimationSource || (!upcomingWaveBelief.hasGuard ? 'no-guard-deterministic' : 'unobserved-wide-prior'),
          tacticalDecision: upcomingWaveBelief.tacticalDecision || null,
          optimalLoadout: upcomingWaveBelief.optimalLoadout || null,
          numGearChanges: Number(upcomingWaveBelief.numGearChanges || 0),
        }
      : null

    const entry = {
      id: idNum,
      name: owner.name || String(idNum),
      level: Number(owner.level || 1),
      guard: Boolean(owner.guard),
      newbie: Boolean(owner.newbie),
      readyEligible,
      stealableCount: stealableNow,
      upcomingEligible,
      upcomingSpots,
      expectedUnlockAt,
      exactUnlockKnown,
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
    this._liveVisitBundles.set(idNum, {
      atSec: nowSec,
      bundle: { id: idNum, owner, isle: visitData.isle, state: visitData.state, posterior },
      waveBundle: chosenWaveBundle,
      upcomingWaveBundle,
      tacticalDecision: chosenEval?.tacticalDecision || posterior?.decision || null,
      gearData: effGearCtx.gearData || null,
      observedPanels: effGearCtx.observedPanels || null,
    })

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
        if (
          (entry.readyEligible && Number(entry.projectedScore || 0) > 0) ||
          (entry.upcomingEligible && Number(entry.projectedScore || 0) > 0)
        ) {
          this.activeRaidSchedule.needsRefresh = true
          this.activeRaidSchedule.refreshReason = `new-positive-ev-target:${idNum}`
        }
      }
    }

    this.save(nowSec)
    return entry
  }

  /**
   * Immediately updates schedule & opponent profile store from a `POST /api/pet/world/visit/:id` receipt
   * (called inside `executeTransaction.onReceiptFn` BEFORE `fetchAfterWorldFn`!).
   */
  recordSnipeReceipt(adapter, targetId, rawResp, nowSec, { visitorWorld = null } = {}) {
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
      if (/上限|今天偷过|新手/.test(errMsg)) {
        entry.blockedUntil = adapter.nextNaturalDayBoundary(nowSec)
        entry.blockedReason = 'server-owner-or-daily-cap'
        entry.readyEligible = false
        entry.upcomingEligible = false
      } else if (
        status === 409 &&
        entry.expectedUnlockAt != null &&
        Math.abs(nowSec - entry.expectedUnlockAt) <= 2 &&
        Number(entry.earlyRetryCount || 0) === 0
      ) {
        // 1-second server clock boundary jitter: retry once `+1s` later instead of dropping the batch!
        entry.earlyRetryCount = 1
        entry.expectedUnlockAt = nowSec + 1
        entry.readyEligible = false
      } else {
        entry.readyEligible = false
        entry.stealableCount = 0
        entry.cooldownUntil = nowSec + 90
        if (entry.expectedUnlockAt != null && entry.expectedUnlockAt <= nowSec + 2) {
          entry.upcomingEligible = false
          entry.expectedUnlockAt = null
          entry.exactUnlockKnown = false
        }
        entry.nextProbeAt = Math.max(Number(entry.nextProbeAt || 0), nowSec + 90)
      }
      entry.updatedAt = nowSec
      this.data.targets[key] = entry
      this._liveVisitBundles.delete(idNum)
      if (this.activeRaidSchedule?.committedByTargetId?.has(idNum) && entry.expectedUnlockAt == null) {
        this.activeRaidSchedule.committedByTargetId.delete(idNum)
        this.activeRaidSchedule.needsRefresh = true
        this.activeRaidSchedule.refreshReason = `committed-target-rejected:${idNum}`
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
      entry.lossCount = 0
      entry.lastLossAtSec = 0
      entry.needsGuardLogSync = false
      entry.readyEligible = false
      entry.stealableCount = 0
      if (entry.expectedUnlockAt != null && entry.expectedUnlockAt <= nowSec + 15) {
        entry.upcomingEligible = false
        entry.expectedUnlockAt = null
        entry.exactUnlockKnown = false
      }
      entry.nextProbeAt = nowSec + 300
      this._liveVisitBundles.delete(idNum)
      if (this.activeRaidSchedule?.committedByTargetId?.has(idNum)) {
        this.activeRaidSchedule.committedByTargetId.delete(idNum)
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
        owner: body.owner || { id: idNum, name: entry.name, level: entry.level, guard: entry.guard },
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
            sched.needsRefresh = true
            if (!sched.refreshReason) {
              sched.refreshReason = `new-positive-ev-target:${idNum}`
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
    maxUpcomingTargets = 6,
  } = {}) {
    if (!this.isStealEnabled() || !visitorWorld) return []
    const nowSec = Number(visitorWorld.now || 0)
    const candidates = []
    for (const e of Object.values(this.data.targets || {})) {
      if (!e || this.isTargetBlocked(e, nowSec)) continue
      if (e.readyEligible && !(Number(e.upcomingSpots || 0) > Number(e.stealableCount || 0))) continue
      if (!e.upcomingEligible || e.expectedUnlockAt == null) continue
      const unlockAtSec = Math.floor(Number(e.expectedUnlockAt))
      const lead = unlockAtSec - nowSec
      if (!(lead > 0 && lead <= horizonSec)) continue
      if (Number(e.upcomingSpots || 0) < this.minStealSpots) continue

      const cached = this._liveVisitBundles.get(e.id)
      const waveBundle = cached?.upcomingWaveBundle || cached?.waveBundle || null
      const beliefSummary = e.upcomingBeliefSummary || null
      if (!waveBundle && !beliefSummary) continue

      candidates.push({
        id: e.id,
        targetId: e.id,
        name: e.name || String(e.id),
        unlockAtSec,
        expectedUnlockAt: unlockAtSec,
        exactUnlockKnown: Boolean(e.exactUnlockKnown),
        upcomingSpots: Number(e.upcomingSpots || 0),
        projectedScore: Number(e.projectedScore || 0),
        waveBundle,
        upcomingBeliefSummary: beliefSummary,
      })
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
    const constraints = normalizeUserConstraints(userConstraints, this.accountKey)

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
      adapter.syncClock(liveWorld.clockStart)
      if (journal) {
        reconcileUnknownWithFreshWorld(journal, adapter, liveWorld, {
          onReconciledVisitFn: (info) => this.recordReconciledVisit(info),
        })
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

      // Wait down to physical gear-swap lead (`gearSwaps * 1.3 + 2 * rtt + 0.5`) before acquiring gear lock!
      const rttSec = Math.max(0.4, Math.min(2.0, Number(httpClient?.lastRttMs || 600) / 1000))
      const gearSwaps = precomputedDecision?.switchedSlots?.length ?? Number(entry.numGearChanges || (rawEntry.guard ? 2 : 0))
      const gearLeadSec = (gearSwaps > 0 ? (gearSwaps * 1.3 + 2 * rttSec) : rttSec) + 0.5
      const preGearWaitMs = (unlockAt - gearLeadSec) * 1000 - httpClient.estimatedServerNowMs()
      if (preGearWaitMs > 0) {
        await httpClient.sleepMsFn(preGearWaitMs)
      }

      // 3) Pre-equip cached tactical loadout inside `.battle-gear.<account>.lock` (`0` duplicate simulation!),
      //    sleep inside `waitBeforeSendFn` to `T_unlock + postUnlockOffsetMs`, and fire `POST /visit/:id`!
      const gearLockDir = this.gearLockRoot || lockRootDir
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

  /**
   * Non-blocking incremental full-server island discovery slice:
   * - Sweeps `marked` islands + up to `maxPages` (`2`) of `/api/pet/world/neighbors` cursor;
   * - Probes up to `maxProbes` (`4`) due/unindexed multi-spot islands (`plots + pens >= minStealSpots`);
   * - Aborts IMMEDIATELY before any HTTP request if `shouldBlockBackgroundWork(nowSec, preemptWindowSec)` becomes true!
   */
  async runIncrementalDiscoverySlice(adapter, httpClient, visitorWorld, {
    maxPages = 2,
    maxProbes = 4,
    preemptWindowSec = 50,
    markedSyncIntervalSec = 180,
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

    const candidates = []
    const seenIds = new Set()
    const pushDirItem = (item) => {
      if (!item || item.id == null) return
      const id = Number(item.id)
      if (!Number.isFinite(id) || this.selfIds.has(id) || seenIds.has(id)) return
      seenIds.add(id)
      if (item.newbie) return
      const existing = this.data.targets[String(id)]
      const nowSec = httpClient.estimatedServerNowSec()
      if (existing && this.isTargetBlocked(existing, nowSec)) return
      const dirSpots = Number(item.plots || 0) + Number(item.pens || 0)
      const isDueKnown = existing && Number(existing.nextProbeAt || 0) <= nowSec
      // Always probe unindexed active islands (`!existing`) to map growing crops before maturity, OR islands with `dirSpots >= minStealSpots`, OR due scheduled targets!
      if (!existing || dirSpots >= this.minStealSpots || isDueKnown) {
        candidates.push({
          id,
          dirSpots,
          priority: (dirSpots >= this.minStealSpots ? 100 : 0) + (!existing ? 30 : 0) + (isDueKnown ? 20 : 0),
          nextProbeAt: existing?.nextProbeAt || 0,
        })
      }
    }

    // Also include already-indexed targets whose `nextProbeAt <= nowSec` even before directory scan
    const startNow = httpClient.estimatedServerNowSec()
    for (const e of Object.values(this.data.targets || {})) {
      if (!e || this.selfIds.has(e.id) || this.isTargetBlocked(e, startNow)) continue
      if (Number(e.nextProbeAt || 0) <= startNow) {
        seenIds.add(e.id)
        candidates.push({
          id: e.id,
          dirSpots: Number(e.stealableCount || 0) + Number(e.upcomingSpots || 0),
          priority: 50 + (e.upcomingEligible ? 40 : 0),
          nextProbeAt: e.nextProbeAt || 0,
        })
      }
    }

    let pagesScanned = 0
    if (startNow - Number(this.data.lastMarkedSyncAtSec || 0) >= markedSyncIntervalSec) {
      if (shouldAbortNow()) return { status: 'preempted-by-snipe', pagesScanned, islandsProbed: 0 }
      try {
        const markedResp = await httpClient.getJson('/api/pet/world/neighbors/marked?limit=20&q=')
        this.data.lastMarkedSyncAtSec = httpClient.estimatedServerNowSec()
        for (const it of markedResp?.neighbors || []) pushDirItem(it)
      } catch {}
    }

    for (let page = 0; page < maxPages; page++) {
      if (shouldAbortNow()) {
        this.save(httpClient.estimatedServerNowSec())
        return { status: 'preempted-by-snipe', pagesScanned, islandsProbed: 0 }
      }
      const q = new URLSearchParams({ limit: '20', q: '' })
      if (this.data.discoveryCursor) q.set('cursor', this.data.discoveryCursor)
      try {
        const dirResp = await httpClient.getJson(`/api/pet/world/neighbors?${q.toString()}`)
        pagesScanned++
        for (const it of dirResp?.neighbors || []) pushDirItem(it)
        this.data.discoveryCursor = dirResp?.nextCursor || null
        if (!this.data.discoveryCursor) break
      } catch (err) {
        if (/列表已更新/.test(String(err?.message || ''))) {
          this.data.discoveryCursor = null
        }
        break
      }
    }

    candidates.sort((a, b) => (b.priority - a.priority) || (b.dirSpots - a.dirSpots) || (a.nextProbeAt - b.nextProbeAt))
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
      } catch {}
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
