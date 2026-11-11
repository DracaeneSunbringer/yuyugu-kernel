import { parentPort } from 'node:worker_threads'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { solveUnifiedPlan, solveWithHorizonStability } from '../planner/solve.mjs'

let cachedRulesPath = null
let cachedAdapter = null

async function getAdapter(rulesPath, clockStart) {
  if (!cachedAdapter || cachedRulesPath !== rulesPath) {
    cachedAdapter = await loadRulesAdapterFromFile(rulesPath, { clockStart })
    cachedRulesPath = rulesPath
  } else if (Number.isFinite(clockStart)) {
    cachedAdapter.syncClock(clockStart)
  }
  return cachedAdapter
}

if (parentPort) {
  parentPort.on('message', async (msg) => {
    const {
      jobId,
      rulesPath,
      envelope,
      objectiveCfg,
      solverOptions = {},
      runStability = true,
      deadlineAtMs = Infinity,
      workerDeadlineBudgetMs = null,
      simulateSlowSolveMs = 0,
    } = msg || {}

    try {
      const slowMs = Math.floor(Number(simulateSlowSolveMs || solverOptions?.simulateSlowSolveMs || 0))
      if (slowMs > 0) {
        // Real worker-thread blocking wait for adversarial preemption verification;
        // `worker.terminate()` interrupts `Atomics.wait` immediately in <5ms with zero CPU spin!
        const sab = new SharedArrayBuffer(4)
        const view = new Int32Array(sab)
        Atomics.wait(view, 0, 0, slowMs)
      }

      const clockStart = envelope?.observed?.world?.clockStart
      const adapter = await getAdapter(rulesPath, clockStart)
      const objCfg = objectiveCfg?.objectiveHash
        ? objectiveCfg
        : buildObjectiveConfig(objectiveCfg || {})

      const rawNeighborTargetsById = new Map(solverOptions.rawNeighborEntries || [])
      const effectiveWorkerDeadlineAtMs = Number.isFinite(workerDeadlineBudgetMs)
        ? Date.now() + Number(workerDeadlineBudgetMs)
        : deadlineAtMs
      const cleanOptions = {
        ...solverOptions,
        rawNeighborTargetsById,
        deadlineAtMs: effectiveWorkerDeadlineAtMs,
      }
      delete cleanOptions.rawNeighborEntries
      delete cleanOptions.simulateSlowSolveMs

      let plan
      let horizonStability = null
      if (runStability) {
        const stab = solveWithHorizonStability(adapter, envelope, objCfg, cleanOptions)
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
        plan = solveUnifiedPlan(adapter, envelope, objCfg, cleanOptions)
      }

      parentPort.postMessage({
        jobId,
        ok: true,
        plan,
        horizonStability,
      })
    } catch (err) {
      parentPort.postMessage({
        jobId,
        ok: false,
        error: err?.message || String(err),
        code: err?.code || null,
      })
    }
  })
}
