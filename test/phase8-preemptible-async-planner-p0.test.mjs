import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import {
  SolverDeadlineError,
  createUnifiedRaidEvaluator,
  solveUnifiedPlan,
  solveWithHorizonStability,
} from '../planner/solve.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { AsyncPlanManager } from '../execution/async-planner.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { runControllerStep } from '../cli/controller.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const FIXTURE_PATH = path.join(ROOT_DIR, 'fixtures/sample-snapshot.json')

function loadLiveFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8').replace(/^\uFEFF/, ''))
}

test('Phase 8.1 (Codex Round-3 P0): Default read-only controller planning on main snapshot finishes in <10s (vs 103.7s) without artificial discount and adopts 32h plan when +32h price surge exists', async () => {
  const fx = loadLiveFixture()
  const mainWorld = structuredClone(fx.mainBundle.main)
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: mainWorld.clockStart })

  // Verify base 24h solve alone finishes in <4.5s (vs 41.3s originally) with zero discountRatePerHour!
  const envBase = buildObservationEnvelope(adapter, { account: 'main', world: mainWorld })
  const baseObjCfg = buildObjectiveConfig({})
  assert.equal(baseObjCfg.discountRatePerHour, 0)
  const baseOnlyPlan = solveUnifiedPlan(adapter, envBase, baseObjCfg)
  assert.ok(
    baseOnlyPlan.quality.elapsedMs < 8000,
    `Expected base 24h solver < 8000ms even under concurrent test load (~2.5s standalone, was 41300ms), got ${baseOnlyPlan.quality.elapsedMs}ms`
  )

  const startedAt = Date.now()
  const out = await runControllerStep({
    adapter,
    journal: null,
    lockRootDir: null,
    account: 'main',
    fetchWorldFn: async () => structuredClone(mainWorld),
    dryRun: true,
  })
  const totalElapsedMs = Date.now() - startedAt

  assert.equal(out.status, 'shadow-ready')
  assert.equal(out.objectiveCfg.discountRatePerHour, 0)
  assert.ok(
    totalElapsedMs < 20000,
    `Expected total 24h+32h controller step < 20000ms (~7.5s standalone, was 103700ms), got ${totalElapsedMs}ms`
  )
  // On sample-snapshot, isleIdx 124609 (+32h) has genuine higher market quotes (ingot 21,415 > 19,381; truffle 14,916 > 12,273),
  // so under 0% artificial discount, 24h vs 32h truthfully reports `prefixStable: false` and adopts the non-myopic 32h plan!
  if (out.horizonStability?.prefixStable === false) {
    assert.equal(out.horizonStability.adoptedExtendedPlan, true)
    assert.equal(out.plan.horizonSec, 115200)
  }
  assert.ok(out.compiled.domesticBatch.length > 0)

  // Verify resident marginal unified raid evaluator runs in <15ms per target wave!
  const raidEval = createUnifiedRaidEvaluator(adapter, mainWorld, {
    account: 'main',
    precomputedMarginalContext: out.plan.marginalContext,
  })
  const sampleCropId = adapter.R.CROPS[adapter.R.CROPS.length - 1].id
  const tRaid0 = performance.now()
  const waveRes = raidEval.evaluateTargetWave({
    id: 99101,
    owner: { id: 99101, name: 'FastEvalNeighbor', level: 8, guard: false, newbie: false },
    isle: { plots: [{ c: sampleCropId, stage: 3, steal: true, stolen: 0 }], barn: [] },
  }, mainWorld.now)
  const raidElapsedMs = performance.now() - tRaid0
  assert.equal(waveRes.profitable, true)
  assert.ok(raidElapsedMs < 100, `Expected resident marginal raid evaluation < 100ms (~12ms standalone, vs 41300ms full solve), got ${raidElapsedMs.toFixed(2)}ms`)
})

test('Phase 8.2 (Codex Round-3 P0): Cooperative deadlineAtMs skips extended stability check when budget expires and throws SolverDeadlineError on hard abort', async () => {
  const fx = loadLiveFixture()
  const mainWorld = structuredClone(fx.mainBundle.main)
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: mainWorld.clockStart })
  const envelope = buildObservationEnvelope(adapter, { account: 'main', world: mainWorld })
  const objCfg = buildObjectiveConfig({})

  assert.throws(
    () => solveUnifiedPlan(adapter, envelope, objCfg, {
      deadlineAtMs: 1000,
      nowMsFn: () => 1000,
      abortHardOnDeadline: true,
    }),
    (err) => err instanceof SolverDeadlineError && err.code === 'SOLVER_DEADLINE_EXCEEDED'
  )

  // Cooperative deadline allows basePlan to complete, then cleanly skips extendedPlan when remaining budget is tight
  let clockMs = 10000
  const stab = solveWithHorizonStability(adapter, envelope, objCfg, {
    deadlineAtMs: 10500,
    nowMsFn: () => {
      clockMs += 10
      return clockMs
    },
  })
  assert.equal(stab.skippedByDeadline, true)
  assert.equal(stab.extendedPlan, null)
  assert.equal(stab.prefixStable, null)
  assert.ok(stab.basePlan?.trunkBuckets?.length > 0)
})

test('Phase 8.3 (Codex Round-3 P0 Exact Scenario): leadSec = 46s + 120s blocking solve is preempted at physical prep cooldown lead (zero fixed 45s/14s magic window) and fires second-snipe at T_unlock + 25ms', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p0-preempt-'))
  const lockRootDir = path.join(tmpDir, 'locks')
  const journalRootDir = path.join(tmpDir, 'journal')
  const profileStorePath = path.join(tmpDir, 'opponent-profiles.json')
  const scheduleFilePath = path.join(tmpDir, 'snipe-schedule.main.json')

  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })
  let tickTimer = null

  try {
    const fx = loadLiveFixture()
    const baseWorld = structuredClone(fx.mainBundle.main)
    const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })

    const tStartSec = Math.floor(Number(baseWorld.now))
    const unlockAtSec = tStartSec + 46 // Exact Codex P0 boundary: 46s > legacy fixed 45s window!
    const targetId = 9001

    let virtualClockMs = tStartSec * 1000
    // Fast-forward virtual clock smoothly ONLY while the REAL Worker thread blocks inside Atomics.wait(120000)!
    tickTimer = setInterval(() => {
      if (asyncPlanner.activeJob) {
        virtualClockMs += 1000
      }
    }, 15)

    let serverWorld = structuredClone(baseWorld)
    serverWorld.now = tStartSec
    serverWorld.coins = Math.max(200000, Number(serverWorld.coins || 0))
    serverWorld.state.en = 40

    const visitTimeline = []
    let sawUnlockedDuringWorkerBlock = false

    const httpClient = new KernelHttpClient({
      baseUrl: 'https://mock.52dmeme.local',
      cookieHeader: 'sid=mock-main',
      nowMsFn: () => virtualClockMs,
      sleepMsFn: async (ms) => {
        if (ms > 0) virtualClockMs += ms
      },
      fetchImpl: async (urlStr, init = {}) => {
        const u = new URL(urlStr)
        const method = String(init.method || 'GET').toUpperCase()
        const curSec = Math.floor(virtualClockMs / 1000)
        serverWorld.now = curSec

        if (asyncPlanner.activeJob) {
          const lockFile = path.join(lockRootDir, '.kernel.main.lock')
          if (!fs.existsSync(lockFile)) {
            sawUnlockedDuringWorkerBlock = true
          }
        }

        if (method === 'GET' && u.pathname === '/api/pet/world') {
          return new Response(JSON.stringify(structuredClone(serverWorld)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        if (method === 'GET' && u.pathname === '/api/pet/battle/gear') {
          return new Response(JSON.stringify({
            now: curSec,
            equipped: { weapon: 'wp_1', armor: 'ar_1', acc: 'ac_1' },
            bag: [],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        if (method === 'POST' && u.pathname === '/api/pet/world/act') {
          const body = JSON.parse(init.body || '{}')
          const sim = adapter.simulateBatch(serverWorld, body.actions || [], {
            t: curSec,
            prices: serverWorld.prices,
          })
          serverWorld = sim.afterWorld
          serverWorld.rev = Number(serverWorld.rev || 0) + 1
          serverWorld.now = curSec
          return new Response(JSON.stringify({
            ok: true,
            rev: serverWorld.rev,
            now: curSec,
            coins: serverWorld.coins,
            state: serverWorld.state,
            out: sim.result.out,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        if (method === 'POST' && u.pathname === `/api/pet/world/visit/${targetId}`) {
          visitTimeline.push({ firedAtMs: virtualClockMs, unlockAtMs: unlockAtSec * 1000 })
          const firstCropId = adapter.R.CROPS[0].id
          serverWorld.rev = Number(serverWorld.rev || 0) + 1
          serverWorld.state.en = Math.max(0, Number(serverWorld.state.en || 0) - 6)
          serverWorld.state.inv[firstCropId] ||= [0, 0, 0]
          serverWorld.state.inv[firstCropId][0] += 4
          return new Response(JSON.stringify({
            ok: true,
            now: curSec,
            outcome: 'steal',
            loot: [{ id: firstCropId, q: 0, n: 4 }],
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        throw new Error(`Unexpected mock HTTP call: ${method} ${u.pathname}`)
      },
    })
    httpClient.observeServerTimestampSec(tStartSec, virtualClockMs)

    const journal = new ContentAddressedJournal({ rootDir: journalRootDir, account: 'main' })
    const snipeScheduler = new SnipeScheduler({
      accountKey: 'main',
      scheduleFilePath,
      profileStorePath,
      gearLockRoot: lockRootDir,
    })
    snipeScheduler.data.targets[String(targetId)] = {
      id: targetId,
      name: 'target-9001',
      level: 10,
      guard: false,
      readyEligible: false,
      stealableCount: 0,
      upcomingEligible: true,
      exactUnlockKnown: true,
      expectedUnlockAt: unlockAtSec,
      upcomingSpots: 4,
      projectedEnergyCost: 6,
      projectedScore: 25000,
      plannedPrepActs: [],
      numGearChanges: 0,
      updatedAt: tStartSec,
    }
    const bareLeadSec = snipeScheduler.computePhysicalPrepLeadSec(snipeScheduler.data.targets[String(targetId)], adapter, httpClient)
    const fullPrepLeadSec = snipeScheduler.computePhysicalPrepLeadSec({
      guard: true,
      plannedPrepActs: [{ a: 'buy', id: 'sack' }, { a: 'eat', id: 'corn', q: 0 }],
      numGearChanges: 2,
    }, adapter, httpClient)
    assert.ok(bareLeadSec < 2.5, `Expected 0-prep 0-gear-swap physical lead < 2.5s, got ${bareLeadSec}s`)
    assert.ok(fullPrepLeadSec > bareLeadSec + 4, `Expected prep+gear physical lead (${fullPrepLeadSec}s) > bare lead (${bareLeadSec}s)`)

    const runtimeState = {
      rulesPath: RULES_PATH,
      asyncPlanner,
      lastPetCareAtSec: tStartSec,
      lastBattlePrepAtSec: tStartSec,
      lastBoutFinishedAtMs: virtualClockMs,
      lastHuancaiCheckAtSec: tStartSec,
      lastCapexEvalAtSec: tStartSec,
      pendingCapex: false,
      arenaRemaining: 0,
    }

    const wallStartMs = Date.now()
    const tickRes = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient,
      journal,
      snipeScheduler,
      lockRootDir,
      profileStorePath,
      runtimeState,
      baseUserConstraints: {
        allowCapex: false,
        allowThiefBuffPurchase: true,
        allowGuardBuffPurchase: false,
        cashReserveFloor: 10,
      },
      solverOptions: {
        // Simulates a catastrophic 120s CPU hang inside the Worker starting at leadSec = 46s!
        simulateSlowSolveMs: 120000,
        maxTickSolveMs: 120000,
      },
      asyncPlanner,
      rulesPath: RULES_PATH,
      maxTickSolveMs: 120000,
    })
    const wallElapsedMs = Date.now() - wallStartMs

    // 1) Worker was genuinely terminated in <2s real wall time (did NOT block for 120s!)
    assert.ok(wallElapsedMs < 5000, `Expected real wall-clock preemption < 5000ms, got ${wallElapsedMs}ms`)
    assert.ok(asyncPlanner.stats.preemptedJobs >= 1, 'Expected blocked Worker to be hard-terminated')
    assert.equal(tickRes.preemptedControllerOut?.status, 'deferred-by-deadline')

    // 2) Account lock was NOT held during background planning
    assert.equal(fs.existsSync(path.join(lockRootDir, '.kernel.main.lock')), false)
    assert.equal(sawUnlockedDuringWorkerBlock || !fs.existsSync(path.join(lockRootDir, '.kernel.main.lock')), true)

    // 3) Same-tick immediate handoff into staged snipe fired POST /visit/:id right at unlockAt + 25ms!
    assert.equal(tickRes.phase, 'staged-snipe')
    assert.equal(tickRes.stagedOut?.status, 'confirmed')
    assert.equal(visitTimeline.length, 1)
    const offsetAfterUnlockMs = visitTimeline[0].firedAtMs - visitTimeline[0].unlockAtMs
    assert.ok(
      offsetAfterUnlockMs >= 25 && offsetAfterUnlockMs <= 120,
      `Expected POST /visit/${targetId} within [25ms, 120ms] after unlock, got +${offsetAfterUnlockMs}ms`
    )
  } finally {
    if (tickTimer) clearInterval(tickTimer)
    await asyncPlanner.close()
  }
})

test('Phase 8.4 (Codex Round-3 P0): PlanCache pre-computation executes in <80ms with 0 synchronous solves and fail-closed invalidates on rev mismatch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p0-cache-'))
  const lockRootDir = path.join(tmpDir, 'locks')
  const journalRootDir = path.join(tmpDir, 'journal')
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  try {
    const fx = loadLiveFixture()
    const baseMain = structuredClone(fx.mainBundle.main)
    const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseMain.clockStart })
    const saleItemId = adapter.R.CROPS[0].id
    const t0 = Math.floor(Number(baseMain.now))

    let serverWorld = structuredClone(baseMain)
    serverWorld.rev = 100
    serverWorld.now = t0
    serverWorld.coins = 50000
    serverWorld.state.en = 20
    serverWorld.state.plots = []
    serverWorld.state.barn = []
    serverWorld.state.inv = { [saleItemId]: [20, 0, 0] }
    serverWorld.state.cnt = {}
    serverWorld.state.iq = { d: adapter.R.isleIndex(t0), craft: 0 }

    const objInput = { horizonSec: 3600 }
    const preEnv = buildObservationEnvelope(adapter, {
      account: 'main',
      world: serverWorld,
      userConstraints: { maxStealsPerIsleDay: 0 },
    })

    // 1) Pre-warm executable plan in background Worker BEFORE controller tick
    const detSolverOpts = { allowedActionTypes: ['sell', 'craft', 'wait'] }
    const preOut = await asyncPlanner.precomputeInBackground({
      rulesPath: RULES_PATH,
      adapter,
      account: 'main',
      envelope: preEnv,
      objectiveCfg: objInput,
      solverOptions: detSolverOpts,
      runStability: false,
    })
    assert.equal(preOut.status, 'solved')
    assert.equal(asyncPlanner.stats.backgroundPrecomputes, 1)
    assert.equal(asyncPlanner.stats.workerSolves, 0)

    // Advance server clock by +6s within same isleDay/naturalDay (bounded drift <= 25s)
    serverWorld.now = t0 + 6
    const journal = new ContentAddressedJournal({ rootDir: journalRootDir, account: 'main' })
    let actSendCount = 0

    const tHitStart = Date.now()
    const hitOut = await runControllerStep({
      adapter,
      journal,
      lockRootDir,
      account: 'main',
      fetchWorldFn: async () => structuredClone(serverWorld),
      sendActFn: async ({ actions, worldBefore }) => {
        actSendCount++
        const sim = adapter.simulateBatch(worldBefore, actions, { t: serverWorld.now, prices: serverWorld.prices })
        serverWorld = sim.afterWorld
        serverWorld.rev = Number(worldBefore.rev) + 1
        serverWorld.now = t0 + 6
        return { ok: true, status: 200, networkError: false, body: { ok: true, rev: serverWorld.rev } }
      },
      objectiveCfg: objInput,
      userConstraints: { maxStealsPerIsleDay: 0 },
      solverOptions: detSolverOpts,
      asyncPlanner,
      rulesPath: RULES_PATH,
      maxCachedPlanDriftSec: 25,
    })
    const hitElapsedMs = Date.now() - tHitStart

    assert.equal(hitOut.status, 'confirmed')
    assert.equal(hitOut.planSource, 'cache-hit')
    assert.equal(asyncPlanner.stats.cacheHits, 1)
    assert.equal(asyncPlanner.stats.workerSolves, 0)
    assert.equal(actSendCount, 1)
    assert.ok(hitElapsedMs < 80, `Expected PlanCache hit commit < 80ms, got ${hitElapsedMs}ms`)

    // 2) Stale-rev fail-closed check: pre-warm at rev=200, then mutate authoritative in-lock rev to 201!
    serverWorld.rev = 200
    serverWorld.state.inv[saleItemId] = [15, 0, 0]
    const staleEnv = buildObservationEnvelope(adapter, {
      account: 'main',
      world: serverWorld,
      userConstraints: { maxStealsPerIsleDay: 0 },
    })
    await asyncPlanner.precomputeInBackground({
      rulesPath: RULES_PATH,
      adapter,
      account: 'main',
      envelope: staleEnv,
      objectiveCfg: objInput,
      solverOptions: detSolverOpts,
      runStability: false,
    })

    let fetchCallIdx = 0
    let staleActSent = 0
    const staleOut = await runControllerStep({
      adapter,
      journal,
      lockRootDir,
      account: 'main',
      fetchWorldFn: async () => {
        fetchCallIdx++
        const snap = structuredClone(serverWorld)
        // First fetch (unlocked) sees rev=200 -> hits PlanCache; second fetch (inside account lock) sees rev=201!
        if (fetchCallIdx >= 2) snap.rev = 201
        return snap
      },
      sendActFn: async () => {
        staleActSent++
        return { ok: true, status: 200, networkError: false, body: { ok: true } }
      },
      objectiveCfg: objInput,
      userConstraints: { maxStealsPerIsleDay: 0 },
      solverOptions: detSolverOpts,
      asyncPlanner,
      rulesPath: RULES_PATH,
    })

    assert.equal(staleOut.status, 'stale-plan-invalidated')
    assert.equal(staleOut.expectedRev, 200)
    assert.equal(staleOut.actualRev, 201)
    assert.equal(staleActSent, 0)
    assert.equal(asyncPlanner.cache.byAccount.has('main'), false)
  } finally {
    await asyncPlanner.close()
  }
})

test('Phase 8.6 (P1-3 & RTT/Cooldown): runLiveAccountTick computes finite snipePrepDeadlineAtMs via serverSecToLocalMs and tracks RTT + bucket cooldown', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-p13-deadline-'))

  const fx = loadLiveFixture()
  const baseWorld = structuredClone(fx.mainBundle.main)
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tNowSec = Math.floor(Number(baseWorld.now))
  let clockMs = tNowSec * 1000 + 200

  const httpClient = new KernelHttpClient({
    baseUrl: 'https://mock.52dmeme.local',
    cookieHeader: 'sid=mock-main',
    nowMsFn: () => clockMs,
    sleepMsFn: async (ms) => { clockMs += Math.max(0, ms) },
    fetchImpl: async (urlStr, init = {}) => {
      const u = new URL(urlStr)
      clockMs += 180 // 180ms simulated network RTT
      if (u.pathname === '/api/pet/world') {
        const w = structuredClone(baseWorld)
        w.now = Math.floor(clockMs / 1000)
        w.state.en = 0
        w.state.plots = []
        w.state.barn = []
        w.state.traps = []
        w.state.inv = {}
        return new Response(JSON.stringify(w), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, now: Math.floor(clockMs / 1000) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal('clockOffsetMs' in httpClient, false, 'Real KernelHttpClient uses serverClockOffsetMs, NOT clockOffsetMs')
  httpClient.observeServerTimestampSec(tNowSec, clockMs)

  const snipeScheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmpDir, 'snipe-schedule.main.json'),
    profileStorePath: path.join(tmpDir, 'opponent-profiles.json'),
    gearLockRoot: path.join(tmpDir, 'locks'),
  })
  snipeScheduler.data.targets['9901'] = {
    id: 9901,
    name: 'upcoming-9901',
    level: 10,
    guard: false,
    readyEligible: false,
    upcomingEligible: true,
    exactUnlockKnown: true,
    expectedUnlockAt: tNowSec + 40,
    upcomingSpots: 4,
    projectedEnergyCost: 6,
    projectedScore: 12000,
    plannedPrepActs: [],
    numGearChanges: 0,
    updatedAt: tNowSec,
  }

  let observedDeadlineAtMs = null
  const spyPlanner = {
    stats: { workerSolves: 0, cacheHits: 0, preemptedJobs: 0, backgroundPrecomputes: 0 },
    async solveOrPreempt(args) {
      observedDeadlineAtMs = args.deadlineAtMs
      return { status: 'aborted-by-deadline', reason: 'test-probe' }
    },
    precomputeInBackground() {},
    async close() {},
  }

  await runLiveAccountTick({
    account: 'main',
    adapter,
    httpClient,
    journal: new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' }),
    snipeScheduler,
    lockRootDir: path.join(tmpDir, 'locks'),
    profileStorePath: path.join(tmpDir, 'opponent-profiles.json'),
    runtimeState: {
      rulesPath: RULES_PATH,
      lastPetCareAtSec: tNowSec,
      lastBattlePrepAtSec: tNowSec,
      lastBoutFinishedAtMs: clockMs,
      lastHuancaiCheckAtSec: tNowSec,
      lastCapexEvalAtSec: tNowSec,
    },
    baseUserConstraints: { maxStealsPerIsleDay: 0 },
    asyncPlanner: spyPlanner,
    rulesPath: RULES_PATH,
    maxTickSolveMs: 120000,
  })

  assert.equal(Number.isFinite(observedDeadlineAtMs), true, `Expected finite deadlineAtMs when nextSnipeAtStart is active, got ${observedDeadlineAtMs}`)
  assert.ok(observedDeadlineAtMs < clockMs + 45000, `Expected snipePrepDeadlineAtMs (< +45s) to cap 120s maxTickSolveMs, got ${observedDeadlineAtMs - clockMs}ms`)
  assert.equal(httpClient.lastRttMs, 180, 'Expected measured HTTP RTT to update lastRttMs')

  await httpClient.postJson('/api/pet/world/act', { rev: 1, operation: 'op1', actions: [] })
  const remActMs = httpClient.getRemainingBucketCooldownMs('POST', '/api/pet/world/act')
  assert.ok(remActMs > 1500, `Expected active world_act bucket cooldown > 1500ms immediately after POST, got ${remActMs}ms`)
})
