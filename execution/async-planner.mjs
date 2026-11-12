import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { compileExecutablePrefix, computeEarliestDomesticTransitionSec } from '../planner/compile-prefix.mjs'

function canonicalizeBeliefItem(b) {
  return {
    targetId: String(b?.targetId ?? b?.id ?? ''),
    unlockAtSec: Number(b?.unlockAtSec ?? b?.expectedUnlockAt ?? 0),
    exactUnlockKnown: Boolean(b?.exactUnlockKnown),
    totalSpots: Number(b?.totalSpots ?? b?.upcomingSpots ?? 0),
    spotCounts: b?.spotCounts || null,
    lootBag: b?.lootBag || null,
    energyCost: Number(b?.energyCost ?? b?.projectedEnergyCost ?? 0),
    hasGuard: Boolean(b?.hasGuard ?? b?.guard),
    detectionProb: Number(b?.detectionProb ?? 0),
    ownerAlertId: b?.ownerAlertId || null,
    winInterval: b?.winInterval || null,
    lossInterval: b?.lossInterval || null,
    estimatedFineOnLoss: Number(b?.estimatedFineOnLoss ?? 0),
  }
}

export function buildNeighborSignature(neighborTargets = [], upcomingOrEnvelope = null) {
  const readyList = Array.isArray(neighborTargets) ? neighborTargets : []
  const envReadyBeliefs = Array.isArray(upcomingOrEnvelope?.beliefs?.visitBeliefs)
    ? upcomingOrEnvelope.beliefs.visitBeliefs
    : null
  const upcomingList = Array.isArray(upcomingOrEnvelope)
    ? upcomingOrEnvelope
    : (Array.isArray(upcomingOrEnvelope?.beliefs?.upcomingVisitBeliefs)
        ? upcomingOrEnvelope.beliefs.upcomingVisitBeliefs
        : [])

  if (readyList.length === 0 && (!envReadyBeliefs || envReadyBeliefs.length === 0) && upcomingList.length === 0) {
    return 'none'
  }

  const canonicalReady = envReadyBeliefs && envReadyBeliefs.length > 0
    ? envReadyBeliefs.map(canonicalizeBeliefItem).sort((a, b) => a.targetId.localeCompare(b.targetId))
    : readyList
        .map((nt) => {
          const rawPlots = nt?.isle?.plots || nt?.state?.plots || nt?.plots || []
          const rawBarn = nt?.isle?.barn || nt?.state?.barn || nt?.barn || []
          return {
            id: String(nt?.id ?? nt?.owner?.id ?? ''),
            rev: nt?.rev ?? null,
            plots: rawPlots.map((p) => (p ? [p.c ?? null, p.stage ?? null, Boolean(p.steal), p.stolen ?? 0] : null)),
            barn: rawBarn.map((p) => (p ? [p.k ?? null, Boolean(p.steal), p.stolen ?? 0] : null)),
            guard: Boolean(nt?.owner?.guard ?? nt?.isle?.guard ?? nt?.guard),
            guardUntil: nt?.guard?.until ?? nt?.state?.guardUntil ?? 0,
            posterior: nt?.posterior
              ? { winInterval: nt.posterior.winInterval || null, lossInterval: nt.posterior.lossInterval || null }
              : null,
          }
        })
        .sort((a, b) => a.id.localeCompare(b.id))

  const canonicalUpcoming = upcomingList
    .map(canonicalizeBeliefItem)
    .sort((a, b) => (a.unlockAtSec - b.unlockAtSec) || a.targetId.localeCompare(b.targetId))

  const payload = canonicalUpcoming.length > 0
    ? { ready: canonicalReady, upcoming: canonicalUpcoming }
    : canonicalReady
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 16)
}

function computeEarliestUpcomingUnlockSec(envelope) {
  const list = envelope?.beliefs?.upcomingVisitBeliefs
  if (!Array.isArray(list) || list.length === 0) return Infinity
  let earliest = Infinity
  for (const b of list) {
    const u = Number(b?.unlockAtSec)
    if (Number.isFinite(u) && u > 0 && u < earliest) earliest = u
  }
  return earliest
}

/**
 * Executable Plan Cache (`PlanCache`)
 *
 * Stores pre-computed UnifiedPlans keyed by account and validates them fail-closed
 * against authoritative in-lock `world` state (`rev`, `isleIndex`, `naturalDay`,
 * `coins`, `en`, `constraintsHash`, `objectiveHash`, `neighborSig`, and `compileExecutablePrefix`).
 */
export class PlanCache {
  constructor() {
    this.byAccount = new Map()
  }

  put({
    adapter,
    account,
    worldBefore,
    envelope,
    objectiveCfg,
    neighborSig = 'none',
    plan,
    horizonStability = null,
    createdAtMs = Date.now(),
  }) {
    if (!account || !worldBefore || !plan) return null
    const bucket0 = plan.trunkBuckets?.[0]
    const isWaitPlan = (bucket0?.domesticActions?.length || 0) === 0 && (bucket0?.visitActions?.length || 0) === 0
    const domesticInvalidateAtSec = adapter
      ? computeEarliestDomesticTransitionSec(adapter, worldBefore, isWaitPlan ? plan.nextWakeSec : null)
      : Infinity
    const invalidateAtSec = Math.min(domesticInvalidateAtSec, computeEarliestUpcomingUnlockSec(envelope))
    const entry = {
      account,
      rev: Number(worldBefore.rev ?? -1),
      atSec: Math.floor(Number(worldBefore.now || 0)),
      isleIndex: adapter.R.isleIndex(worldBefore.now),
      naturalDay: adapter.R.worldDay(worldBefore.now),
      coins: Number(worldBefore.coins || 0),
      en: Number(worldBefore.state?.en || 0),
      iqJson: JSON.stringify(worldBefore.state?.iq || {}),
      constraintsHash: envelope?.constraintsHash || plan.constraintsHash,
      objectiveHash: objectiveCfg?.objectiveHash || plan.objectiveHash,
      neighborSig,
      isWaitPlan,
      invalidateAtSec,
      envelope,
      plan,
      horizonStability,
      createdAtMs,
    }
    this.byAccount.set(account, entry)
    return entry
  }

  getValid({
    adapter,
    account,
    world,
    constraintsHash,
    objectiveHash,
    neighborSig = 'none',
    maxClockDriftSec = Infinity,
  }) {
    const entry = this.byAccount.get(account)
    if (!entry || !world) return null
    if (Number(world.rev ?? -2) !== entry.rev) {
      if (Number(world.rev ?? -2) > entry.rev) {
        this.byAccount.delete(account)
      }
      return null
    }
    const nowW = Math.floor(Number(world.now || 0))
    const driftSec = nowW - entry.atSec
    if (driftSec < 0 || driftSec > maxClockDriftSec) return null
    if (nowW >= entry.invalidateAtSec) {
      this.byAccount.delete(account)
      return null
    }
    if (adapter.R.isleIndex(world.now) !== entry.isleIndex) return null
    if (adapter.R.worldDay(world.now) !== entry.naturalDay) return null
    if (constraintsHash && entry.constraintsHash !== constraintsHash) return null
    if (objectiveHash && entry.objectiveHash !== objectiveHash) return null
    if (entry.neighborSig !== neighborSig) return null
    if (Number(world.coins || 0) !== entry.coins) return null
    const refreshedEn = adapter.advanceTimeOnly
      ? Number(adapter.advanceTimeOnly(world, world.now).state?.en || 0)
      : Number(world.state?.en || 0)
    if (refreshedEn < entry.en) return null
    if (entry.isWaitPlan && refreshedEn > entry.en) return null
    if (JSON.stringify(world.state?.iq || {}) !== entry.iqJson) return null

    const compiled = compileExecutablePrefix(adapter, world, entry.plan, { maxClockDriftSec })
    if (compiled.status === 'plan-invalid') {
      return null
    }
    return {
      ...entry,
      compiled,
    }
  }

  invalidate(account) {
    if (account) this.byAccount.delete(account)
    else this.byAccount.clear()
  }
}

/**
 * Preemptible Background Planner (`AsyncPlanManager`)
 *
 * Decouples heavy solver computation from execution & scheduling:
 * 1. Runs `solveUnifiedPlan` / `solveWithHorizonStability` off the main event loop inside a `Worker` thread.
 * 2. Caches executable plans in `PlanCache` (supports proactive background pre-warming ahead of `nextWakeSec` or post-`act`).
 * 3. Enforces hard deadlines & imminent-snipe preemption via `worker.terminate()` (`< 5ms` hard kill),
 *    guaranteeing a long solve starting at `leadSec = 46s` NEVER blocks `executeStagedSnipe`!
 */
export class AsyncPlanManager {
  constructor({ rulesPath, cache = new PlanCache() } = {}) {
    this.rulesPath = rulesPath
    this.cache = cache
    this.worker = null
    this.nextJobId = 1
    this.activeJob = null
    this.stats = {
      workerSolves: 0,
      cacheHits: 0,
      preemptedJobs: 0,
      backgroundPrecomputes: 0,
      checkpointRecoveries: 0,
    }
  }

  _ensureWorker() {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./planner-worker.mjs', import.meta.url), { execArgv: [] })
    w.unref()
    w.on('error', (err) => {
      if (this.activeJob && this.activeJob.worker === w) {
        const job = this.activeJob
        this.activeJob = null
        this.worker = null
        if (job.checkpointPlan) {
          this.stats.checkpointRecoveries++
          job.settle({
            status: 'solved',
            plan: job.checkpointPlan,
            horizonStability: {
              prefixStable: null,
              adoptedExtendedPlan: false,
              skippedByDeadline: true,
              recoveredFromCheckpoint: true,
              recoveryReason: err?.message || String(err),
            },
          })
        } else {
          job.settle({ status: 'worker-error', error: err?.message || String(err) })
        }
      } else if (this.worker === w) {
        this.worker = null
      }
    })
    w.on('exit', (code) => {
      if (this.activeJob && this.activeJob.worker === w) {
        const job = this.activeJob
        this.activeJob = null
        this.worker = null
        if (!job.abortReason && job.checkpointPlan) {
          this.stats.checkpointRecoveries++
          job.settle({
            status: 'solved',
            plan: job.checkpointPlan,
            horizonStability: {
              prefixStable: null,
              adoptedExtendedPlan: false,
              skippedByDeadline: true,
              recoveredFromCheckpoint: true,
              recoveryReason: `worker-exited:${code}`,
            },
          })
        } else {
          job.settle({
            status: 'aborted-by-deadline',
            reason: job.abortReason || `worker-exited:${code}`,
          })
        }
      } else if (this.worker === w) {
        this.worker = null
      }
    })
    w.on('message', (msg) => {
      if (!this.activeJob || msg?.jobId !== this.activeJob.jobId) return
      if (msg.kind === 'base-plan-checkpoint') {
        const job = this.activeJob
        if (msg.plan) {
          job.checkpointPlan = msg.plan
          if (job.adapter && job.envelope) {
            this.cache.put({
              adapter: job.adapter,
              account: job.account,
              worldBefore: job.envelope.observed.world,
              envelope: job.envelope,
              objectiveCfg: job.objCfg,
              neighborSig: job.neighborSig,
              plan: msg.plan,
              horizonStability: {
                prefixStable: null,
                adoptedExtendedPlan: false,
                skippedByDeadline: true,
                recoveredFromCheckpoint: true,
              },
            })
          }
        }
        return
      }
      const job = this.activeJob
      this.activeJob = null
      w.unref()
      if (msg.ok) {
        job.settle({
          status: 'solved',
          plan: msg.plan,
          horizonStability: msg.horizonStability,
        })
      } else if (job.checkpointPlan) {
        this.stats.checkpointRecoveries++
        job.settle({
          status: 'solved',
          plan: job.checkpointPlan,
          horizonStability: {
            prefixStable: null,
            adoptedExtendedPlan: false,
            skippedByDeadline: true,
            recoveredFromCheckpoint: true,
            recoveryReason: msg.error || 'extended-worker-error',
          },
        })
      } else {
        job.settle({
          status: 'worker-error',
          error: msg.error || 'unknown-worker-error',
          code: msg.code || null,
        })
      }
    })
    this.worker = w
    return w
  }

  async abortActiveJob(reason = 'preempted') {
    const job = this.activeJob
    const w = this.worker
    this.activeJob = null
    this.worker = null
    if (job) {
      job.abortReason = reason
      this.stats.preemptedJobs++
      job.settle({ status: 'aborted-by-deadline', reason })
    }
    if (w) {
      try {
        await w.terminate()
      } catch {
        // Ignore termination race if already exited
      }
    }
  }

  _buildMatchKey({ account, world, constraintsHash, objectiveHash, neighborSig, runStability }) {
    return `${account}:${world?.rev}:${Math.floor(Number(world?.now || 0))}:${constraintsHash}:${objectiveHash}:${neighborSig}:${runStability ? 1 : 0}`
  }

  _startWorkerJob({
    rulesPath,
    adapter,
    account,
    envelope,
    objCfg,
    neighborTargets = [],
    neighborSig = 'none',
    solverOptions = {},
    runStability = true,
    deadlineAtMs = Infinity,
    nowMsFn = Date.now,
    isBackground = false,
  }) {
    const useRulesPath = rulesPath || this.rulesPath
    if (!useRulesPath) {
      throw new Error('AsyncPlanManager requires rulesPath to run worker-thread solver')
    }
    const w = this._ensureWorker()
    w.ref()

    const jobId = this.nextJobId++
    const matchKey = this._buildMatchKey({
      account,
      world: envelope.observed.world,
      constraintsHash: envelope.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
      runStability,
    })

    const rawNeighborEntries = []
    for (const nt of neighborTargets || []) {
      const tid = nt?.id ?? nt?.owner?.id
      if (tid != null) rawNeighborEntries.push([tid, nt])
    }
    const serializableOptions = { ...solverOptions }
    delete serializableOptions.rawNeighborTargetsById
    delete serializableOptions.nowMsFn
    serializableOptions.rawNeighborEntries = rawNeighborEntries

    let settled = false
    let settleFn = null
    const promise = new Promise((resolve) => {
      settleFn = (val) => {
        if (settled) return
        settled = true
        if (val.status === 'solved' && adapter) {
          this.cache.put({
            adapter,
            account,
            worldBefore: envelope.observed.world,
            envelope,
            objectiveCfg: objCfg,
            neighborSig,
            plan: val.plan,
            horizonStability: val.horizonStability,
          })
        }
        resolve(val)
      }
    })

    const jobWorld = envelope.observed.world
    const jobAtSec = Math.floor(Number(jobWorld?.now || 0))
    const jobInvalidateAtSec = Math.min(
      adapter ? computeEarliestDomesticTransitionSec(adapter, jobWorld, null) : Infinity,
      computeEarliestUpcomingUnlockSec(envelope)
    )
    const nowStartMs = nowMsFn()
    const rawTotalBudgetMs = Number.isFinite(deadlineAtMs)
      ? Math.max(0, deadlineAtMs - nowStartMs)
      : Infinity
    const commitMarginMs = Number.isFinite(rawTotalBudgetMs)
      ? (rawTotalBudgetMs > 1500
          ? Math.min(2500, Math.floor(rawTotalBudgetMs * 0.15))
          : (rawTotalBudgetMs > 300 ? Math.floor(rawTotalBudgetMs * 0.2) : 0))
      : 0
    const workerCutoffAtMs = Number.isFinite(deadlineAtMs)
      ? deadlineAtMs - commitMarginMs
      : Infinity
    const workerDeadlineBudgetMs = Number.isFinite(workerCutoffAtMs)
      ? Math.max(0, workerCutoffAtMs - nowStartMs)
      : null

    this.activeJob = {
      jobId,
      worker: w,
      adapter,
      envelope,
      objCfg,
      account,
      matchKey,
      rev: Number(jobWorld?.rev ?? -1),
      atSec: jobAtSec,
      isleIndex: adapter ? adapter.R.isleIndex(jobWorld?.now || 0) : null,
      naturalDay: adapter ? adapter.R.worldDay(jobWorld?.now || 0) : null,
      coins: Number(jobWorld?.coins || 0),
      en: Number(jobWorld?.state?.en || 0),
      iqJson: JSON.stringify(jobWorld?.state?.iq || {}),
      constraintsHash: envelope.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
      invalidateAtSec: jobInvalidateAtSec,
      isBackground,
      checkpointPlan: null,
      workerCutoffAtMs,
      abortReason: null,
      promise,
      settle: settleFn,
    }
    if (isBackground) this.stats.backgroundPrecomputes++
    else this.stats.workerSolves++

    w.postMessage({
      jobId,
      rulesPath: useRulesPath,
      envelope,
      objectiveCfg: objCfg,
      solverOptions: serializableOptions,
      runStability,
      deadlineAtMs: workerCutoffAtMs,
      workerDeadlineBudgetMs,
      simulateSlowSolveMs: solverOptions?.simulateSlowSolveMs || 0,
    })

    return this.activeJob
  }

  async solveOrPreempt({
    rulesPath = null,
    adapter,
    account,
    envelope,
    objectiveCfg = {},
    neighborTargets = [],
    solverOptions = {},
    runStability = true,
    deadlineAtMs = Infinity,
    shouldPreemptFn = null,
    pollIntervalMs = 25,
    maxClockDriftSec = Infinity,
    nowMsFn = Date.now,
  }) {
    const objCfg = objectiveCfg?.objectiveHash
      ? objectiveCfg
      : buildObjectiveConfig(objectiveCfg || {})
    const neighborSig = buildNeighborSignature(neighborTargets, envelope)
    const world = envelope.observed.world

    // 1. Fast-path PlanCache hit (< 1ms, zero worker overhead!)
    const cached = this.cache.getValid({
      adapter,
      account,
      world,
      constraintsHash: envelope.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
      maxClockDriftSec,
    })
    if (cached) {
      this.stats.cacheHits++
      return {
        status: 'cache-hit',
        plan: cached.plan,
        horizonStability: cached.horizonStability,
        compiled: cached.compiled,
      }
    }

    // 2. Check deadline & urgent preemption before dispatching
    const preReason = shouldPreemptFn?.()
    if (preReason || nowMsFn() >= deadlineAtMs) {
      return {
        status: 'aborted-by-deadline',
        reason: preReason || 'deadline-expired-before-dispatch',
      }
    }

    const matchKey = this._buildMatchKey({
      account,
      world,
      constraintsHash: envelope.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
      runStability,
    })

    const isCompatibleInFlight = (candJob) => {
      if (!candJob) return false
      if (candJob.matchKey === matchKey) return true
      const nowW = Math.floor(Number(world?.now || 0))
      const drift = nowW - Number(candJob.atSec || 0)
      if (candJob.account !== account) return false
      if (Number(world?.rev ?? -2) !== candJob.rev) return false
      if (drift < 0 || drift > maxClockDriftSec) return false
      if (nowW >= candJob.invalidateAtSec) return false
      if (adapter && (adapter.R.isleIndex(world.now) !== candJob.isleIndex || adapter.R.worldDay(world.now) !== candJob.naturalDay)) return false
      if (candJob.constraintsHash !== envelope.constraintsHash) return false
      if (candJob.objectiveHash !== objCfg.objectiveHash) return false
      if (candJob.neighborSig !== neighborSig) return false
      if (Number(world?.coins || 0) !== candJob.coins) return false
      if (Number(world?.state?.en || 0) < candJob.en) return false
      if (JSON.stringify(world?.state?.iq || {}) !== candJob.iqJson) return false
      return true
    }

    // 3. Reuse compatible in-flight job (including `+2s` pre-warm jobs regardless of `runStability`) or preempt stale job
    let job = this.activeJob
    const reusedInFlight = Boolean(job && isCompatibleInFlight(job))
    if (job && !reusedInFlight) {
      await this.abortActiveJob('superseded-by-foreground-solve')
      job = null
    }
    if (!job) {
      job = this._startWorkerJob({
        rulesPath,
        adapter,
        account,
        envelope,
        objCfg,
        neighborTargets,
        neighborSig,
        solverOptions,
        runStability,
        deadlineAtMs,
        nowMsFn,
        isBackground: false,
      })
    } else {
      job.worker?.ref()
    }

    // 4. Race worker job against hard deadline & `shouldPreemptFn` with `worker.terminate()`
    let timerId = null
    const effectiveCutoffMs = Math.min(
      Number.isFinite(deadlineAtMs) ? deadlineAtMs : Infinity,
      Number.isFinite(job.workerCutoffAtMs) ? job.workerCutoffAtMs : Infinity
    )
    try {
      const watchPromise = new Promise((resolve) => {
        const check = () => {
          const dynReason = shouldPreemptFn?.()
          if (dynReason) {
            resolve({ preempt: true, urgent: true, recoverCheckpoint: false, reason: String(dynReason) })
            return
          }
          const curMs = nowMsFn()
          if (job.checkpointPlan && curMs >= effectiveCutoffMs) {
            resolve({ preempt: true, urgent: false, recoverCheckpoint: true, reason: 'extended-deadline-exceeded' })
            return
          }
          if (curMs >= deadlineAtMs) {
            resolve({
              preempt: true,
              urgent: false,
              recoverCheckpoint: Boolean(job.checkpointPlan),
              reason: 'solver-deadline-exceeded',
            })
            return
          }
          const nextBound = job.checkpointPlan ? effectiveCutoffMs : deadlineAtMs
          const rem = Number.isFinite(nextBound)
            ? Math.max(5, Math.min(pollIntervalMs, nextBound - curMs))
            : pollIntervalMs
          timerId = setTimeout(check, rem)
          if (typeof timerId?.unref === 'function') timerId.unref()
        }
        if (Number.isFinite(deadlineAtMs) || typeof shouldPreemptFn === 'function') {
          const firstBound = job.checkpointPlan ? effectiveCutoffMs : deadlineAtMs
          const firstWait = Number.isFinite(firstBound)
            ? Math.max(5, Math.min(pollIntervalMs, firstBound - nowMsFn()))
            : pollIntervalMs
          timerId = setTimeout(check, firstWait)
          if (typeof timerId?.unref === 'function') timerId.unref()
        }
      })

      const winner = await Promise.race([
        job.promise.then((res) => ({ preempt: false, res })),
        watchPromise,
      ])

      if (winner.preempt) {
        const savedCheckpoint = job.checkpointPlan
        await this.abortActiveJob(winner.reason)
        if (winner.recoverCheckpoint && savedCheckpoint && !winner.urgent) {
          this.stats.checkpointRecoveries++
          return {
            status: 'solved',
            plan: savedCheckpoint,
            horizonStability: {
              prefixStable: null,
              adoptedExtendedPlan: false,
              skippedByDeadline: true,
              recoveredFromCheckpoint: true,
              recoveryReason: winner.reason,
            },
          }
        }
        return {
          status: 'aborted-by-deadline',
          reason: winner.reason,
        }
      }
      if (reusedInFlight && winner.res?.status === 'solved' && adapter) {
        const revalidated = this.cache.getValid({
          adapter,
          account,
          world,
          constraintsHash: envelope.constraintsHash,
          objectiveHash: objCfg.objectiveHash,
          neighborSig,
          maxClockDriftSec,
        })
        if (revalidated) {
          this.stats.cacheHits++
          return {
            status: 'cache-hit',
            plan: revalidated.plan,
            horizonStability: revalidated.horizonStability,
            compiled: revalidated.compiled,
          }
        }
        return this.solveOrPreempt({
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
          pollIntervalMs,
          maxClockDriftSec,
          nowMsFn,
        })
      }
      return winner.res
    } finally {
      if (timerId != null) clearTimeout(timerId)
    }
  }

  precomputeInBackground({
    rulesPath = null,
    adapter,
    account,
    envelope,
    objectiveCfg = {},
    neighborTargets = [],
    solverOptions = {},
    runStability = false,
    deadlineAtMs = Infinity,
  }) {
    if (this.activeJob) return null
    const objCfg = objectiveCfg?.objectiveHash
      ? objectiveCfg
      : buildObjectiveConfig(objectiveCfg || {})
    const neighborSig = buildNeighborSignature(neighborTargets, envelope)
    const already = this.cache.getValid({
      adapter,
      account,
      world: envelope.observed.world,
      constraintsHash: envelope.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
    })
    if (already) return Promise.resolve({ status: 'cache-hit', plan: already.plan })

    const job = this._startWorkerJob({
      rulesPath,
      adapter,
      account,
      envelope,
      objCfg,
      neighborTargets,
      neighborSig,
      solverOptions,
      runStability,
      deadlineAtMs,
      isBackground: true,
    })
    return job.promise
  }

  async close() {
    this.activeJob = null
    const w = this.worker
    this.worker = null
    if (w) {
      try {
        await w.terminate()
      } catch {
        // Ignore
      }
    }
  }
}
