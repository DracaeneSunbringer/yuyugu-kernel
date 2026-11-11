import crypto from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { compileExecutablePrefix, computeEarliestDomesticTransitionSec } from '../planner/compile-prefix.mjs'

export function buildNeighborSignature(neighborTargets = []) {
  if (!Array.isArray(neighborTargets) || neighborTargets.length === 0) return 'none'
  const canonical = neighborTargets
    .map((nt) => ({
      id: String(nt?.id ?? nt?.owner?.id ?? ''),
      rev: nt?.rev ?? null,
      plots: (nt?.state?.plots || nt?.plots || []).length,
      barn: (nt?.state?.barn || nt?.barn || []).length,
      guardUntil: nt?.guard?.until ?? nt?.state?.guardUntil ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 16)
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
    const invalidateAtSec = adapter
      ? computeEarliestDomesticTransitionSec(adapter, worldBefore, isWaitPlan ? plan.nextWakeSec : null)
      : Infinity
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
    maxClockDriftSec = 25,
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
    if (Number(world.state?.en || 0) < entry.en) return null
    if (entry.isWaitPlan && Number(world.state?.en || 0) > entry.en) return null
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
    }
  }

  _ensureWorker() {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./planner-worker.mjs', import.meta.url))
    w.unref()
    w.on('error', (err) => {
      if (this.activeJob && this.activeJob.worker === w) {
        const job = this.activeJob
        this.activeJob = null
        this.worker = null
        job.settle({ status: 'worker-error', error: err?.message || String(err) })
      } else if (this.worker === w) {
        this.worker = null
      }
    })
    w.on('exit', (code) => {
      if (this.activeJob && this.activeJob.worker === w) {
        const job = this.activeJob
        this.activeJob = null
        this.worker = null
        job.settle({
          status: 'aborted-by-deadline',
          reason: job.abortReason || `worker-exited:${code}`,
        })
      } else if (this.worker === w) {
        this.worker = null
      }
    })
    w.on('message', (msg) => {
      if (!this.activeJob || msg?.jobId !== this.activeJob.jobId) return
      const job = this.activeJob
      this.activeJob = null
      w.unref()
      if (msg.ok) {
        job.settle({
          status: 'solved',
          plan: msg.plan,
          horizonStability: msg.horizonStability,
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
    const jobInvalidateAtSec = adapter
      ? computeEarliestDomesticTransitionSec(adapter, jobWorld, null)
      : Infinity
    this.activeJob = {
      jobId,
      worker: w,
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
      abortReason: null,
      promise,
      settle: settleFn,
    }
    if (isBackground) this.stats.backgroundPrecomputes++
    else this.stats.workerSolves++

    const workerDeadlineBudgetMs = Number.isFinite(deadlineAtMs)
      ? Math.max(0, deadlineAtMs - nowMsFn())
      : null

    w.postMessage({
      jobId,
      rulesPath: useRulesPath,
      envelope,
      objectiveCfg: objCfg,
      solverOptions: serializableOptions,
      runStability,
      deadlineAtMs,
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
    maxClockDriftSec = 25,
    nowMsFn = Date.now,
  }) {
    const objCfg = objectiveCfg?.objectiveHash
      ? objectiveCfg
      : buildObjectiveConfig(objectiveCfg || {})
    const neighborSig = buildNeighborSignature(neighborTargets)
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
    try {
      const watchPromise = new Promise((resolve) => {
        const check = () => {
          const dynReason = shouldPreemptFn?.()
          if (dynReason) {
            resolve({ preempt: true, reason: String(dynReason) })
            return
          }
          if (nowMsFn() >= deadlineAtMs) {
            resolve({ preempt: true, reason: 'solver-deadline-exceeded' })
            return
          }
          const rem = Number.isFinite(deadlineAtMs)
            ? Math.max(5, Math.min(pollIntervalMs, deadlineAtMs - nowMsFn()))
            : pollIntervalMs
          timerId = setTimeout(check, rem)
          if (typeof timerId?.unref === 'function') timerId.unref()
        }
        if (Number.isFinite(deadlineAtMs) || typeof shouldPreemptFn === 'function') {
          const firstWait = Number.isFinite(deadlineAtMs)
            ? Math.max(5, Math.min(pollIntervalMs, deadlineAtMs - nowMsFn()))
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
        await this.abortActiveJob(winner.reason)
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
    const neighborSig = buildNeighborSignature(neighborTargets)
    const already = this.cache.getValid({
      adapter,
      account,
      world: envelope.observed.world,
      constraintsHash: envelope.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
      maxClockDriftSec: 25,
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
