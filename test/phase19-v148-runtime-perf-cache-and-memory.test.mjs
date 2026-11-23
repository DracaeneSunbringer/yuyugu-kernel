import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ContentAddressedJournal } from '../audit/journal.mjs'
import { runControllerStep } from '../cli/controller.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'
import { AsyncPlanManager } from '../execution/async-planner.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld } from '../execution/reconcile.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import {
  buildObservationEnvelope,
  isBenignWaitPlanRegen,
  isFarmDomainPassiveCompatible,
} from '../model/observations.mjs'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { compileExecutablePrefix, computeCausalStochasticPrefix } from '../planner/compile-prefix.mjs'
import { createUnifiedRaidEvaluator, solveUnifiedPlan } from '../planner/solve.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeTempDir(prefix = 'kernel-p19-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function findSummerMidDaySec(adapter, anchorSec = 1794485274) {
  const { R } = adapter
  let t = anchorSec
  for (let k = 0; k < 400; k++, t += 1800) {
    const iDay = R.isleDay(t)
    const remIsle = adapter.nextIsleBoundary(t, CLOCK_START) - t
    const remNat = adapter.nextNaturalDayBoundary(t) - t
    if (R.seasonOf(iDay) === 1 && remIsle >= 7200 && remNat >= 7200) {
      return t
    }
  }
  return anchorSec
}

function makeActionableWorld(adapter, nowSec = findSummerMidDaySec(adapter), en = 60) {
  const { R } = adapter
  const s = R.newWorld(nowSec)
  const cropId = 'tomato'
  const matSec = Math.max(60, Math.ceil(Number(R.cropStage({ c: cropId, t: nowSec, g: 0, w: 3, h: 0 }, nowSec, true)?.total || 14400)))
  s.plotN = 8
  s.plots = Array.from({ length: 8 }, (_, idx) => (
    idx < 4
      ? { c: cropId, t: nowSec - matSec - 120, g: 0, w: 3, h: 0 }
      : null
  ))
  s.barnN = 4
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 1 }
  s.mine = { max: 10 }
  s.en = en
  s.enT = nowSec
  s.enDay = R.worldDay(nowSec)
  s.cnt = {}
  s.b12 = {}
  s.iq = { d: R.isleIndex(nowSec), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 }
  const day = R.isleDay(nowSec)
  const season = R.seasonOf(day)
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id] || R.marketPrices(season, 1, s)?.[id] || 10)
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 100,
    coins: 5000,
    prices,
    state: s,
  }
}

function makeIdleWaitingWorld(adapter, nowSec, en = 20) {
  const { R } = adapter
  const s = R.newWorld(nowSec)
  const cropId = 'tomato'
  s.plotN = 6
  s.plots = Array.from({ length: 6 }, () => ({ c: cropId, t: nowSec - 60, g: 0, w: 3, h: 0 }))
  s.barnN = 4
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 1 }
  s.mine = { max: 10 }
  s.en = en
  s.enT = nowSec
  s.enDay = R.worldDay(nowSec)
  s.cnt = {}
  s.b12 = {}
  s.iq = { d: R.isleIndex(nowSec), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 }
  s.inv = {}
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id] || 10)
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 100,
    coins: 0,
    prices,
    state: s,
  }
}

test('Phase 19.1: Benign wait +1 passive regen reuses PlanCache while crossing threshold or hitting enCap invalidates; allowFutureMinGap hits +2s prewarm', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter)
  const waitWorld0 = makeIdleWaitingWorld(adapter, t0, 20)

  const env0 = buildObservationEnvelope(adapter, { account: 'main', world: waitWorld0 })
  const objCfg = buildObjectiveConfig({})
  const plan0 = solveUnifiedPlan(adapter, env0, objCfg, { checkHorizonStability: false })
  const compiled0 = compileExecutablePrefix(adapter, waitWorld0, plan0)
  assert.equal(compiled0.status, 'wait', `Expected wait status, got ${compiled0.status}`)

  let dt = 30
  while (dt <= 1800 && Number(adapter.advanceTimeOnly(waitWorld0, t0 + dt).state?.en || 0) <= Number(waitWorld0.state.en)) {
    dt += 30
  }
  const waitWorld1 = {
    ...adapter.advanceTimeOnly(waitWorld0, t0 + dt),
    rev: waitWorld0.rev,
  }
  assert.ok(waitWorld1.state.en > waitWorld0.state.en, 'Expected advanceTimeOnly to tick passive energy +1')

  assert.equal(isBenignWaitPlanRegen(adapter, waitWorld0, waitWorld1, plan0), true)
  assert.equal(isFarmDomainPassiveCompatible(adapter, waitWorld0, waitWorld1, { isWaitPlan: true, plan: plan0 }), true)

  const manager = new AsyncPlanManager({ rulesPath: RULES_PATH })
  manager.cache.put({
    adapter,
    account: 'main',
    worldBefore: waitWorld0,
    plan: plan0,
    horizonStability: null,
    constraintsHash: env0.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: 'none',
  })

  const cacheHit = manager.cache.getValid({
    adapter,
    account: 'main',
    world: waitWorld1,
    constraintsHash: env0.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: 'none',
  })
  assert.ok(cacheHit, 'Wait PlanCache must hit after +1 passive energy regen when no new action unlocked')
  assert.equal(cacheHit.compiled.status, 'wait')

  // Partial empty-plot wait world (coins=0 so cannot plant):
  // - en 20->21 (< energyMax) is benign,
  // - en 20->energyMax invalidates,
  // - en 2->3 (< 2*maxSingleActCost) invalidates.
  const partialWaitWorld = makeIdleWaitingWorld(adapter, t0, 20)
  partialWaitWorld.state.plots[0] = null
  const envP = buildObservationEnvelope(adapter, { account: 'main', world: partialWaitWorld })
  const planP = solveUnifiedPlan(adapter, envP, objCfg, { checkHorizonStability: false })
  assert.equal(compileExecutablePrefix(adapter, partialWaitWorld, planP).status, 'wait')

  const partialPlusOne = structuredClone(partialWaitWorld)
  partialPlusOne.now = t0 + 60
  partialPlusOne.rev += 1
  partialPlusOne.state.en = 21
  partialPlusOne.state.enT = t0 + 60
  assert.equal(isBenignWaitPlanRegen(adapter, partialWaitWorld, partialPlusOne, planP), true)

  const enCapWorld = structuredClone(partialWaitWorld)
  enCapWorld.now = t0 + 60
  enCapWorld.rev = partialWaitWorld.rev + 1
  enCapWorld.state.en = adapter.R.energyMax(enCapWorld.state)
  enCapWorld.state.enT = t0 + 60
  assert.equal(isBenignWaitPlanRegen(adapter, partialWaitWorld, enCapWorld, planP), false)

  const lowEnBase = makeIdleWaitingWorld(adapter, t0, 2)
  lowEnBase.state.plots[0] = null
  const lowEnPlan = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { account: 'main', world: lowEnBase }),
    objCfg,
    { checkHorizonStability: false }
  )
  const lowEnNext = structuredClone(lowEnBase)
  lowEnNext.now = t0 + 60
  lowEnNext.rev += 1
  lowEnNext.state.en = 3
  lowEnNext.state.enT = t0 + 60
  assert.equal(isBenignWaitPlanRegen(adapter, lowEnBase, lowEnNext, lowEnPlan), false)

  // +2s future pre-warm hit only when allowFutureMinGap === true
  const actionWorld0 = makeActionableWorld(adapter, t0)
  const minGap = adapter.R.WORLD?.minGap || 2
  const futureWorld = {
    ...adapter.advanceTimeOnly(actionWorld0, actionWorld0.now + minGap),
    rev: actionWorld0.rev,
  }
  const envFuture = buildObservationEnvelope(adapter, { account: 'main', world: futureWorld })
  const planFuture = solveUnifiedPlan(adapter, envFuture, objCfg, { checkHorizonStability: false })
  const futureCompiled = compileExecutablePrefix(adapter, futureWorld, planFuture)
  assert.equal(futureCompiled.status, 'ready', 'Expected actionable world at t0+minGap to be ready')

  const m2 = new AsyncPlanManager({ rulesPath: RULES_PATH })
  m2.cache.put({
    adapter,
    account: 'main',
    worldBefore: futureWorld,
    plan: planFuture,
    horizonStability: null,
    constraintsHash: envFuture.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: 'none',
  })
  const missWithoutFlag = m2.cache.getValid({
    adapter,
    account: 'main',
    world: actionWorld0,
    constraintsHash: envFuture.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: 'none',
    allowFutureMinGap: false,
  })
  assert.equal(missWithoutFlag, null)

  const hitWithFlag = m2.cache.getValid({
    adapter,
    account: 'main',
    world: actionWorld0,
    constraintsHash: envFuture.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: 'none',
    allowFutureMinGap: true,
  })
  assert.ok(hitWithFlag, 'allowFutureMinGap=true must reuse +minGap pre-warmed domestic plan')
  assert.equal(hitWithFlag.compiled.status, 'ready')

  await manager.close()
  await m2.close()
})

test('Phase 19.2: Compact journal prunes old settled txs & waitDecisions while preserving unresolved/recent budgets, O(1) reconcile writes 0 blobs, and waitSig deduplicates', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter)
  const sample = makeActionableWorld(adapter, t0)
  const tmpDir = makeTempDir('kernel-p19-j-')

  const journal = new ContentAddressedJournal({
    rootDir: tmpDir,
    account: 'main',
    compactRuntimeIndex: true,
    maxRetainedWaitDecisions: 6,
    retainSettledIsleWindow: 2,
  })

  for (let i = 0; i < 15; i++) {
    journal.appendEvent({
      recordType: 'wait-decision',
      decisionId: `w-${i}`,
      serverNow: t0 + i,
      plannedWakeSec: t0 + 60,
      reason: 'wait',
    })
  }

  const sellReqRef = journal.writeBlob({ actions: [{ a: 'sell', id: 'tomato', n: 3 }] })
  const isleTimes = [t0]
  for (let k = 0; k < 5; k++) {
    isleTimes.push(adapter.nextIsleBoundary(isleTimes[isleTimes.length - 1], CLOCK_START) + 60)
  }
  const firstIsleIdx = adapter.R.isleIndex(isleTimes[0])
  const lastIsleIdx = adapter.R.isleIndex(isleTimes[5])
  for (let k = 0; k <= 5; k++) {
    const ts = isleTimes[k]
    const isleIdx = adapter.R.isleIndex(ts)
    const op = `op-confirmed-${k}`
    journal.appendEvent({
      recordType: 'tx-transition',
      operation: op,
      decisionId: `d-${k}`,
      kind: 'act',
      status: 'confirmed',
      requestRef: sellReqRef,
      possibleIsleIndices: [isleIdx],
      serverNow: ts,
    })
    journal.appendEvent({
      recordType: 'tx-transition',
      operation: `visit-confirmed-${k}`,
      decisionId: `dv-${k}`,
      kind: 'visit',
      budgetKind: 'steal',
      status: 'confirmed',
      possibleIsleIndices: [isleIdx],
    })
  }
  journal.appendEvent({
    recordType: 'tx-transition',
    operation: 'op-old-unknown',
    decisionId: 'd-unk',
    kind: 'visit',
    budgetKind: 'steal',
    status: 'unknown',
    possibleIsleIndices: [firstIsleIdx],
  })

  const recon = journal.reconstructTransactions()
  assert.equal(recon.waitDecisions.length, 6)
  assert.equal(recon.txMap.has('op-confirmed-0'), false, 'Old settled first-isle tx must be pruned outside window 2')
  assert.equal(recon.txMap.has('op-confirmed-5'), true, 'Recent settled last-isle tx must be retained')
  assert.equal(recon.txMap.get('op-confirmed-5').history.length, 0, 'Compact index must clear terminal tx history')
  assert.equal(recon.txMap.has('op-old-unknown'), true, 'Unresolved unknown tx must NEVER be pruned')
  assert.equal(journal.listUnknownTransactions().length, 1)
  assert.equal(journal.countOccupiedBudget('steal', lastIsleIdx), 1)
  assert.equal(journal.countOccupiedBudget('steal', firstIsleIdx), 1, 'Old unresolved unknown tx still occupies first-isle budget')

  const salesByIsle = journal.sumConfirmedSalesByIsleIndex(adapter)
  assert.ok((salesByIsle.get(lastIsleIdx)?.tomato || 0) >= 3)

  // O(1) reconcile fast path must not write any blob when unknown list is empty
  const cleanDir = makeTempDir('kernel-p19-cleanj-')
  const cleanJournal = new ContentAddressedJournal({ rootDir: cleanDir, account: 'main', compactRuntimeIndex: true })
  const recOut = reconcileUnknownWithFreshWorld(cleanJournal, adapter, sample)
  assert.equal(recOut.reconciled, 0)
  assert.equal(recOut.remainingUnknown, 0)
  assert.equal(fs.readdirSync(cleanJournal.blobsDir).length, 0, 'Zero blobs written when unknownTxs is empty')

  // waitSig deduplication in runControllerStep
  const waitWorld = makeIdleWaitingWorld(adapter, t0, 20)
  const lockRoot = makeTempDir('kernel-p19-lock-')
  const planner = new AsyncPlanManager({ rulesPath: RULES_PATH })
  const out1 = await runControllerStep({
    adapter,
    journal: cleanJournal,
    lockRootDir: lockRoot,
    account: 'main',
    fetchWorldFn: async () => structuredClone(waitWorld),
    asyncPlanner: planner,
    solverOptions: { checkHorizonStability: false },
  })
  assert.equal(out1.status, 'waiting')
  const linesAfter1 = fs.readFileSync(cleanJournal.logPath, 'utf8').trim().split('\n').length
  const out2 = await runControllerStep({
    adapter,
    journal: cleanJournal,
    lockRootDir: lockRoot,
    account: 'main',
    fetchWorldFn: async () => ({ ...structuredClone(waitWorld), now: waitWorld.now + 30 }),
    asyncPlanner: planner,
    solverOptions: { checkHorizonStability: false },
  })
  assert.equal(out2.status, 'waiting')
  const linesAfter2 = fs.readFileSync(cleanJournal.logPath, 'utf8').trim().split('\n').length
  assert.equal(linesAfter2, linesAfter1, 'Repeated identical wait must not append duplicate wait-decision event')
  await planner.close()
})

test('Phase 19.3: SnipeScheduler guards non-finite now, bounds _liveVisitBundles/gearData, schedules 90s committed probe wake with priority 220 & anti-spin backoff', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter)
  const sample = makeActionableWorld(adapter, t0)
  const cropId = 'tomato'
  const sched = new SnipeScheduler({ accountKey: 'main', selfIds: [999999] })

  assert.doesNotThrow(() => sched._makeEvaluatorCacheKey(adapter, { now: NaN, state: {} }, {}))
  assert.equal(sched.getUnifiedEvaluator(adapter, { now: NaN }), null)

  // Ineligible targets do not remain in _liveVisitBundles
  for (let i = 1; i <= 5; i++) {
    sched.recordVisitSnapshot(adapter, sample, 1000 + i, {
      now: t0,
      owner: { id: 1000 + i, name: `empty-${i}`, level: 1, guard: false },
      isle: { plots: [], barn: [] },
      state: { plots: [], barn: [], arc: { huge: 'ignored' } },
      rules: { protect: 1800, perPlot: 2, perPen: 2 },
    }, { gearData: { big: true }, observedPanels: { p: 1 }, skipSave: true })
  }
  assert.equal(sched._liveVisitBundles.size, 0)

  // Populate 180 eligible upcoming targets and verify size <= 160, gearData <= 32, and stripped heavy state keys
  for (let i = 1; i <= 180; i++) {
    sched.recordVisitSnapshot(adapter, sample, 2000 + i, {
      now: t0,
      owner: { id: 2000 + i, name: `target-${i}`, level: 5, guard: true },
      isle: {
        plots: [{ c: cropId, stage: 3, steal: false, stolen: 0 }],
        barn: [],
      },
      state: {
        tools: { spr: 2 },
        plots: [{ c: cropId, t: t0 - 100, g: 0, w: 3, h: 0 }],
        barn: [],
        arc: { giantBlob: 'x'.repeat(256) },
      },
      rules: { protect: 1800, perPlot: 2, perPen: 2 },
    }, { gearData: { gear: { idx: i } }, observedPanels: { idx: i }, skipSave: true })
  }
  assert.ok(sched._liveVisitBundles.size <= 160, `Expected <= 160 cached bundles, got ${sched._liveVisitBundles.size}`)
  let gearCount = 0
  for (const rec of sched._liveVisitBundles.values()) {
    if (rec.gearData || rec.observedPanels) gearCount++
    assert.equal(rec.bundle?.state?.arc, undefined, 'Heavy non-farm state keys must be stripped from _liveVisitBundles')
  }
  assert.ok(gearCount <= 32, `Expected <= 32 cached gearData entries, got ${gearCount}`)

  // Committed target within 90s wakes & gets priority 220
  const commId = 2180
  const entry = sched.data.targets[String(commId)]
  const unlockAt = t0 + 70
  entry.upcomingEligible = true
  entry.expectedUnlockAt = unlockAt
  entry.updatedAt = t0 - 200
  entry.nextProbeAt = unlockAt - 35
  sched.activeRaidSchedule = {
    planId: 'p-test',
    committedByTargetId: new Map([[commId, { targetId: commId, unlockAtSec: unlockAt, isImmediate: false }]]),
    committedRaids: [{ targetId: commId, unlockAtSec: unlockAt, isImmediate: false }],
    evaluatedTargetSet: new Set([commId]),
    needsRefresh: false,
  }
  const probeWake = sched.nextCommittedProbeWakeSec(t0)
  assert.ok(probeWake != null && probeWake <= t0 + 15, `Expected imminent committed probe wake, got ${probeWake}`)

  const probedIds = []
  const mockHttp = {
    estimatedServerNowSec: () => t0,
    getJson: async (url) => {
      const m = url.match(/\/visit\/(\d+)$/)
      if (m) {
        probedIds.push(Number(m[1]))
        return {
          now: t0,
          owner: { id: Number(m[1]), name: 'target', level: 5, guard: false },
          isle: { plots: [{ c: cropId, stage: 3, steal: false, stolen: 0 }], barn: [] },
          state: { plots: [{ c: cropId, t: t0 - 100, g: 0, w: 3, h: 0 }], barn: [] },
          rules: { protect: 1800, perPlot: 2, perPen: 2 },
        }
      }
      return { neighbors: [], nextCursor: 'c2' }
    },
  }
  const nonComm = sched.data.targets['2179']
  nonComm.nextProbeAt = t0 - 10
  await sched.runIncrementalDiscoverySlice(adapter, mockHttp, sample, {
    maxPages: 0,
    maxProbes: 1,
    markedSyncIntervalSec: 999999,
  })
  assert.equal(probedIds[0], commId, 'Committed target within 90s must win top discovery probe slot (priority 220)')
  assert.equal(sched.nextCommittedProbeWakeSec(t0 + 5), null, 'Freshly probed committed target must not re-wake before unlock')

  // Failed /visit/:id probe must record lastProbeAttemptAtSec & back off to avoid 1s spin loop
  const failId = 2178
  const failEntry = sched.data.targets[String(failId)]
  const failUnlockAt = t0 + 80
  failEntry.upcomingEligible = true
  failEntry.expectedUnlockAt = failUnlockAt
  failEntry.updatedAt = t0 - 200
  failEntry.lastProbeAttemptAtSec = 0
  failEntry.nextProbeAt = failUnlockAt - 35
  sched.activeRaidSchedule = {
    planId: 'p-test-fail',
    committedByTargetId: new Map([[failId, { targetId: failId, unlockAtSec: failUnlockAt, isImmediate: false }]]),
    committedRaids: [{ targetId: failId, unlockAtSec: failUnlockAt, isImmediate: false }],
    evaluatedTargetSet: new Set([failId]),
    needsRefresh: false,
  }
  const failingHttp = {
    estimatedServerNowSec: () => t0,
    getJson: async () => {
      throw new Error('HTTP 502')
    },
  }
  await sched.runIncrementalDiscoverySlice(adapter, failingHttp, sample, {
    maxPages: 0,
    maxProbes: 1,
    markedSyncIntervalSec: 999999,
  })
  assert.equal(failEntry.lastProbeAttemptAtSec, t0)
  assert.equal(sched.nextCommittedProbeWakeSec(t0 + 1), null, 'Failed probe attempt must silence repeated imminent wake until unlock window')
})

test('Phase 19.4: live-daemon defers capex cooldown on abort, clamps confirmedWakeSec to write-bucket cooldown, and throttles warm discovery to +45s', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter)
  const sample = makeActionableWorld(adapter, t0)
  const tmpDir = makeTempDir('kernel-p19-daemon-')
  const lockRoot = path.join(tmpDir, 'locks')
  const storePath = path.join(tmpDir, 'profiles.json')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main', compactRuntimeIndex: true })

  let fixedNowMs = t0 * 1000 + 800
  let serverWorld = structuredClone(sample)
  const httpClient = new KernelHttpClient({
    baseUrl: 'https://game.example.invalid',
    cookieHeader: 'sid=test',
    nowMsFn: () => fixedNowMs,
    sleepMsFn: async () => {},
    fetchImpl: async (urlStr) => {
      const u = new URL(urlStr)
      if (u.pathname === '/api/pet/world/act') {
        serverWorld = structuredClone(serverWorld)
        serverWorld.rev += 1
        serverWorld.now = Math.floor(fixedNowMs / 1000)
        return new Response(JSON.stringify({ ok: true, world: serverWorld, out: [{ ok: true }] }), { status: 200 })
      }
      if (u.pathname === '/api/pet/world') {
        return new Response(JSON.stringify(serverWorld), { status: 200 })
      }
      if (u.pathname === '/api/pet/battle/home') {
        return new Response(JSON.stringify({ adopted: false }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    },
  })

  // 1) Aborted tick (maxTickSolveMs: -1 -> deferred-by-deadline) must NOT consume 600s capex cooldown
  const runtimeState = {
    lastCapexEvalAtSec: 0,
    lastPetCareAtSec: t0,
    lastBattlePrepAtSec: t0,
    lastHuancaiAtSec: t0,
    lastHuancaiCheckAtSec: t0,
    lastNpcAtSec: t0,
    lastXianAtSec: t0,
    arenaRemaining: 0,
  }
  const planner = new AsyncPlanManager({ rulesPath: RULES_PATH })
  const sched = new SnipeScheduler({ accountKey: 'main', domesticOnly: true })
  const deferredTick = await runLiveAccountTick({
    account: 'main',
    adapter,
    httpClient,
    journal,
    snipeScheduler: sched,
    lockRootDir: lockRoot,
    profileStorePath: storePath,
    runtimeState,
    baseUserConstraints: { domesticOnly: true, allowCapex: true },
    solverOptions: { checkHorizonStability: false },
    asyncPlanner: planner,
    rulesPath: RULES_PATH,
    maxTickSolveMs: -1,
  })
  assert.equal(deferredTick.controllerOut?.status, 'deferred-by-deadline')
  assert.equal(runtimeState.lastCapexEvalAtSec, 0, 'deferred-by-deadline must not update lastCapexEvalAtSec')

  // 2) Confirmed action at t0 + 0.8s clamps confirmedWakeSec to write-bucket cooldown ready second (t0 + 3)
  const actTick = await runLiveAccountTick({
    account: 'main',
    adapter,
    httpClient,
    journal,
    snipeScheduler: sched,
    lockRootDir: lockRoot,
    profileStorePath: storePath,
    runtimeState,
    baseUserConstraints: { domesticOnly: true, allowCapex: false },
    solverOptions: { checkHorizonStability: false },
    asyncPlanner: planner,
    rulesPath: RULES_PATH,
    maxTickSolveMs: 30000,
  })
  assert.equal(actTick.controllerOut?.status, 'confirmed')
  assert.ok(actTick.nextWakeSec >= t0 + 3, `Expected write-bucket cooldown wake >= ${t0 + 3}, got ${actTick.nextWakeSec}`)

  // 3) Warm discovery cursor throttles idle wait polling to +45s (instead of +15s)
  const waitWorld = makeIdleWaitingWorld(adapter, t0, 20)
  const warmSched = new SnipeScheduler({ accountKey: 'main', domesticOnly: false })
  warmSched.data.discoveryCursor = 'cursor-2'
  warmSched.data.lastHeadScanAtSec = t0 - 10
  for (let i = 1; i <= 205; i++) {
    warmSched.data.targets[String(3000 + i)] = { id: 3000 + i, nextProbeAt: t0 + 3600 }
  }
  const httpIdle = new KernelHttpClient({
    baseUrl: 'https://game.example.invalid',
    cookieHeader: 'sid=test',
    nowMsFn: () => t0 * 1000,
    sleepMsFn: async () => {},
    fetchImpl: async (urlStr) => {
      const u = new URL(urlStr)
      if (u.pathname === '/api/pet/world') return new Response(JSON.stringify(waitWorld), { status: 200 })
      if (u.pathname === '/api/pet/battle/home') return new Response(JSON.stringify({ adopted: false }), { status: 200 })
      if (u.pathname === '/api/pet/world/neighbors') {
        return new Response(JSON.stringify({ neighbors: [], nextCursor: 'cursor-next', asOf: t0 }), { status: 200 })
      }
      if (u.pathname === '/api/pet/world/neighbors/marked') {
        return new Response(JSON.stringify({ neighbors: [], asOf: t0 }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    },
  })
  const warmRuntime = {
    lastCapexEvalAtSec: t0,
    lastPetCareAtSec: t0,
    lastBattlePrepAtSec: t0,
    lastHuancaiCheckAtSec: t0,
    lastNpcAtSec: t0,
    lastXianAtSec: t0,
    arenaRemaining: 0,
  }
  const warmOut = await runLiveAccountTick({
    account: 'main',
    adapter,
    httpClient: httpIdle,
    journal,
    snipeScheduler: warmSched,
    lockRootDir: lockRoot,
    profileStorePath: storePath,
    runtimeState: warmRuntime,
    baseUserConstraints: { allowCapex: false },
    solverOptions: { checkHorizonStability: false },
    asyncPlanner: planner,
    rulesPath: RULES_PATH,
    maxTickSolveMs: 30000,
  })
  assert.equal(warmOut.phase, 'full-tick')
  assert.equal(warmOut.nextWakeSec, t0 + 45)
  await planner.close()
})

test('Phase 19.5: Memoized worldDay/isleDay, SOLVER_IGNORED_STATE_KEYS, and SPFA/unified raid evaluator parity remain exact', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter)
  const sample = makeActionableWorld(adapter, t0)

  assert.throws(() => adapter.R.worldDay(NaN), RangeError)
  assert.throws(() => adapter.R.isleDay(NaN), RangeError)
  for (let k = 0; k < 20; k++) {
    const t = t0 + k * 4321
    const wd = adapter.R.worldDay(t)
    const id = adapter.R.isleDay(t)
    assert.equal(adapter.R.worldDay(t), wd)
    assert.equal(adapter.R.isleDay(t), id)
  }

  const cleanWorld = structuredClone(sample)
  const bloatedWorld = structuredClone(sample)
  bloatedWorld.state.arc = { logs: Array(50).fill('ignored') }
  bloatedWorld.state.whaleFriends = [1, 2, 3]
  bloatedWorld.state.realm = { stage: 99 }
  bloatedWorld.state.xian = { qi: 999 }
  bloatedWorld.state.xs = { dummy: 1 }
  bloatedWorld.state.gift = { list: [1, 2] }
  bloatedWorld.state.freshness = { ts: t0 }

  const objCfg = buildObjectiveConfig({})
  const planClean = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { account: 'main', world: cleanWorld }),
    objCfg,
    { checkHorizonStability: false }
  )
  const planBloated = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { account: 'main', world: bloatedWorld }),
    objCfg,
    { checkHorizonStability: false }
  )
  assert.equal(planBloated.quality.feasibleIncumbentValue, planClean.quality.feasibleIncumbentValue)
  assert.deepEqual(planBloated.trunkBuckets[0]?.domesticActions || [], planClean.trunkBuckets[0]?.domesticActions || [])

  const evaluator = createUnifiedRaidEvaluator(adapter, cleanWorld, { account: 'main' })
  const res = evaluator.evaluateTargetWave(
    {
      id: 4242,
      owner: { id: 4242, name: 'n', level: 5, guard: false },
      isle: { plots: [{ c: 'tomato', stage: 3, steal: true, stolen: 0 }], barn: [] },
    },
    t0
  )
  assert.equal(typeof res.decisionScore, 'number')
})

test('Phase 19.6: Zero-Yield Lower-Bound Sandbox compiles interleaved eat+harvest+plant atomically & PlanCache continues multi-batch suffixes without re-solving', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R, graph } = adapter
  const t0 = findSummerMidDaySec(adapter)
  const regrowCrop = [...graph.cropsById.values()].find((c) => c.regrow && c.seasons.includes(1) && Number(c.eat) > 0) || graph.cropsById.get('corn')
  const foodCrop = [...graph.cropsById.values()].find((c) => c.id !== regrowCrop.id && Number(c.eat) > 0) || graph.cropsById.get('turnip')
  const maxH = Math.max(0, Number(regrowCrop.times || 1) - 1)
  const dur = Math.max(60, Math.ceil(Number(R.cropStage({ c: regrowCrop.id, t: t0, g: 0, w: 3, h: maxH }, t0, true)?.total || 14400)))

  // 1a) Interleaved [eat(food), harvest, ..., eat(food), plant] (<= 40 acts) with pre-existing food & coins compiles atomically!
  const worldLowEn = makeActionableWorld(adapter, t0, 3)
  worldLowEn.coins = 500000
  worldLowEn.state.plotN = 10
  worldLowEn.state.plots = Array.from({ length: 10 }, () => ({
    c: regrowCrop.id,
    t: t0 - dur - 120,
    g: 0,
    w: 3,
    h: maxH,
  }))
  worldLowEn.state.inv = { [foodCrop.id]: [20, 0, 0] }
  worldLowEn.state.iq = { d: R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 }

  const interleavedSeq = [
    { a: 'eat', id: foodCrop.id, q: 0 },
    { a: 'harvest', i: 0 },
    { a: 'harvest', i: 1 },
    { a: 'harvest', i: 2 },
    { a: 'eat', id: foodCrop.id, q: 0 },
    { a: 'harvest', i: 3 },
    { a: 'harvest', i: 4 },
    { a: 'harvest', i: 5 },
    { a: 'eat', id: foodCrop.id, q: 0 },
    { a: 'harvest', i: 6 },
    { a: 'harvest', i: 7 },
    { a: 'harvest', i: 8 },
    { a: 'harvest', i: 9 },
    { a: 'eat', id: foodCrop.id, q: 0 },
    { a: 'plant', i: 0, c: regrowCrop.id },
    { a: 'plant', i: 1, c: regrowCrop.id },
    { a: 'eat', id: foodCrop.id, q: 0 },
    { a: 'plant', i: 2, c: regrowCrop.id },
    { a: 'plant', i: 3, c: regrowCrop.id },
  ]
  const causalOk = computeCausalStochasticPrefix(adapter, worldLowEn, interleavedSeq, 40)
  assert.equal(causalOk.truncatedAfterStochastic, false, 'Interleaved eat+harvest+plant funded by pre-existing bag/coins must NOT truncate!')
  assert.equal(causalOk.prefix.length, interleavedSeq.length)

  // 1b) If a post-harvest eat/sell depends on unobserved harvest drops (exceeds pre-existing inv), truncate cleanly!
  worldLowEn.state.inv = { [regrowCrop.id]: [1, 0, 0] }
  const depSeq = [
    { a: 'harvest', i: 0 },
    { a: 'harvest', i: 1 },
    { a: 'eat', id: regrowCrop.id, q: 0 }, // covered by pre-existing inv=1
    { a: 'eat', id: regrowCrop.id, q: 0 }, // needs harvest yield -> MUST truncate before this!
    { a: 'plant', i: 0, c: regrowCrop.id },
  ]
  const causalDep = computeCausalStochasticPrefix(adapter, worldLowEn, depSeq, 40)
  assert.equal(causalDep.truncatedAfterStochastic, true)
  assert.deepEqual(causalDep.prefix, [
    { a: 'harvest', i: 0 },
    { a: 'harvest', i: 1 },
  ], 'Truncating at yield-dependent eat must also strip trailing orphan eat')

  // 1c) If maxBatch slices immediately after a trailing eat/coffee, strip the orphan eat for Batch 2
  worldLowEn.state.inv = { [foodCrop.id]: [10, 0, 0] }
  worldLowEn.state.en = 10
  const maxBatchSlice = [
    { a: 'harvest', i: 0 },
    { a: 'harvest', i: 1 },
    { a: 'harvest', i: 2 },
    { a: 'harvest', i: 3 },
    { a: 'harvest', i: 4 },
    { a: 'eat', id: foodCrop.id, q: 0 },
    { a: 'plant', i: 0, c: regrowCrop.id },
  ]
  const causalBatchCut = computeCausalStochasticPrefix(adapter, worldLowEn, maxBatchSlice, 6)
  assert.equal(causalBatchCut.truncatedByBatchLimit, true)
  assert.equal(causalBatchCut.prefix.length, 5, 'Trailing orphan eat right before maxBatch boundary must be held for Batch 2')

  // 2) Pillar 2: Multi-batch 24-plot harvest + plant (> 40 actions) executes Batch 2 via PlanCache continuation with 0 extra Worker solves!
  const tmpDir = makeTempDir('kernel-p19-cont-')
  const lockRoot = path.join(tmpDir, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  const planner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  try {
    let simNow = t0
    const world24 = makeActionableWorld(adapter, t0, 100)
    world24.coins = 1000000
    world24.state.plotN = 24
    world24.state.plots = Array.from({ length: 24 }, () => ({
      c: regrowCrop.id,
      t: t0 - dur - 120,
      g: 0,
      w: 3,
      h: maxH,
    }))
    world24.state.iq = { d: R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 }
    world24.state.inv = {}

    let serverWorld = structuredClone(world24)
    const sentBatches = []
    const stepCommon = {
      adapter,
      journal,
      lockRootDir: lockRoot,
      account: 'main',
      fetchWorldFn: async () => {
        const w = adapter.advanceTimeOnly(serverWorld, simNow)
        w.rev = serverWorld.rev
        return w
      },
      sendActFn: async ({ actions, worldBefore }) => {
        sentBatches.push(actions)
        // Simulate real server random drops (`rand` producing random quality/qty!)
        const sim = adapter.simulateBatch(worldBefore, actions, {
          t: simNow,
          prices: worldBefore.prices,
          rand: () => 0.15,
        })
        assert.equal(sim.allOk, true, `Expected simulated batch ok: ${JSON.stringify(sim.result?.out)}`)
        serverWorld = sim.afterWorld
        serverWorld.rev = Number(worldBefore.rev) + 1
        serverWorld.now = simNow
        return {
          ok: true,
          status: 200,
          networkError: false,
          body: { ok: true, world: structuredClone(serverWorld), out: sim.result.out },
        }
      },
      userConstraints: { domesticOnly: true, allowCapex: false },
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: {
        allowedActionTypes: ['harvest', 'plant', 'wait'],
        scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
        checkHorizonStability: false,
      },
      asyncPlanner: planner,
      rulesPath: RULES_PATH,
    }

    const s1 = await runControllerStep(stepCommon)
    assert.equal(s1.status, 'confirmed')
    assert.equal(s1.planSource, 'solved')
    assert.equal(planner.stats.workerSolves, 1)
    assert.equal(planner.stats.backgroundPrecomputes, 0, 'Continuation in PlanCache must suppress redundant background Worker precompute')
    assert.equal(sentBatches[0].length, 40, 'Batch 1 must pack 24 harvests + 16 plants into maxBatch=40 in 1 HTTP request!')
    assert.equal(sentBatches[0].filter((a) => a.a === 'harvest').length, 24)
    assert.equal(sentBatches[0].filter((a) => a.a === 'plant').length, 16)
    assert.equal(s1.nextWakeSec, t0 + 2)

    simNow = t0 + 2
    const s2 = await runControllerStep(stepCommon)
    assert.equal(s2.status, 'confirmed')
    assert.equal(s2.planSource, 'cache-hit', 'Batch 2 must execute immediately from PlanCache continuation!')
    assert.equal(planner.stats.workerSolves, 1, 'Batch 2 must NOT invoke a second Worker solve!')
    assert.equal(planner.stats.backgroundPrecomputes, 0)
    assert.equal(sentBatches[1].filter((a) => a.a === 'plant').length, 8, 'Batch 2 must replant all remaining 8 plots immediately!')
    assert.equal(serverWorld.state.plots.every((p) => p && p.c === regrowCrop.id && p.h === 0), true, 'All 24 plots must be replanted cleanly')

    // 2b) Continuation preserves across far-future upcoming neighbor sliding into horizon,
    //     and automatically invalidates when Batch 2 starts with sell/craft of stochastically harvested crop!
    const worldMix = makeActionableWorld(adapter, t0, 100)
    worldMix.state.plotN = 4
    worldMix.state.plots = Array.from({ length: 4 }, (_, i) => (
      i < 2
        ? { c: regrowCrop.id, t: t0 - dur - 120, g: 0, w: 3, h: maxH }
        : null
    ))
    worldMix.state.inv = { [regrowCrop.id]: [2, 0, 0] }
    const fakeMultiFishPlan = {
      planId: 'p-fish-cont',
      serverNow: t0,
      constraintsHash: 'ch',
      objectiveHash: 'oh',
      trunkBuckets: [{
        bucketIndex: 0,
        atSec: t0,
        nextAtSec: t0 + 600,
        domesticActions: [
          { a: 'fish', bait: false },
          { a: 'fish', bait: false },
        ],
        visitActions: [],
      }],
    }
    const fishCompiled1 = compileExecutablePrefix(adapter, worldMix, fakeMultiFishPlan)
    assert.equal(fishCompiled1.domesticBatch.length, 1)
    const fishAfter1 = adapter.simulateBatch(worldMix, fishCompiled1.domesticBatch, { t: t0, prices: worldMix.prices }).afterWorld
    fishAfter1.rev = worldMix.rev + 1
    fishAfter1.now = t0
    const fakeEnv = {
      constraintsHash: 'ch',
      beliefs: { visitBeliefs: [], upcomingVisitBeliefs: [] },
      observed: { world: worldMix },
    }
    const contEntry = planner.cache.advanceAfterCommittedPrefix({
      adapter,
      account: 'fish-acc',
      plan: fakeMultiFishPlan,
      envelope: fakeEnv,
      objectiveCfg: { objectiveHash: 'oh' },
      neighborTargets: [],
      neighborSig: 'sig-1',
      compiled: fishCompiled1,
      worldBefore: worldMix,
      worldAfter: fishAfter1,
    })
    assert.ok(contEntry, 'Multi-step extraction suffix must advance in PlanCache')
    const fishAtT2 = { ...adapter.advanceTimeOnly(fishAfter1, t0 + 2), rev: fishAfter1.rev }
    const fishHit = planner.cache.getValid({
      adapter,
      account: 'fish-acc',
      world: fishAtT2,
      constraintsHash: 'ch',
      objectiveHash: 'oh',
      neighborSig: 'sig-upcoming-shifted',
      readyNeighborSig: contEntry.readyNeighborSig,
    })
    assert.ok(fishHit, 'Continuation must match even if far-future upcoming neighbor sig shifts while ready neighbors are unchanged')
    assert.deepEqual(fishHit.compiled.domesticBatch, [{ a: 'fish', bait: false }])

    // Post-harvest suffix that starts with selling stochastically harvested crop must invalidate for re-optimization!
    const postHarvestSellPlan = {
      planId: 'p-harv-sell',
      serverNow: t0,
      constraintsHash: 'ch2',
      objectiveHash: 'oh2',
      trunkBuckets: [{
        bucketIndex: 0,
        atSec: t0,
        nextAtSec: t0 + 600,
        domesticActions: [
          { a: 'harvest', i: 0 },
          { a: 'sell', id: regrowCrop.id, q: 0, n: 1 },
        ],
        visitActions: [],
      }],
    }
    const emptyInvHarvest = structuredClone(worldMix)
    emptyInvHarvest.state.inv = {}
    const hComp = compileExecutablePrefix(adapter, emptyInvHarvest, postHarvestSellPlan)
    const hAfter = adapter.simulateBatch(emptyInvHarvest, hComp.domesticBatch, {
      t: t0,
      prices: emptyInvHarvest.prices,
      rand: () => 0.99, // drops q=0 regrowCrop into inv
    }).afterWorld
    hAfter.rev = emptyInvHarvest.rev + 1
    hAfter.now = t0
    const sellCont = planner.cache.advanceAfterCommittedPrefix({
      adapter,
      account: 'sell-acc',
      plan: postHarvestSellPlan,
      envelope: { constraintsHash: 'ch2', beliefs: {}, observed: { world: emptyInvHarvest } },
      objectiveCfg: { objectiveHash: 'oh2' },
      neighborTargets: [],
      neighborSig: 'none',
      compiled: hComp,
      worldBefore: emptyInvHarvest,
      worldAfter: hAfter,
    })
    assert.equal(sellCont, null, 'Suffix selling stochastically harvested crop MUST invalidate continuation and trigger fresh optimal liquidation solve')
  } finally {
    await planner.close()
  }
})

test('Phase 19.7: executeTransaction inherits omitted /act metadata for PlanCache hits & re-anchors cleanly on server rev rollback', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter)
  const tmpDir = makeTempDir('kernel-p19-rollback-')
  const lockRoot = path.join(tmpDir, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main', compactRuntimeIndex: true })
  const planner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  try {
    // 1) Partial POST /act body omitting `clockStart` and `prices` still keeps PlanCache continuation valid across steps!
    let simNow = t0
    const worldFish = makeActionableWorld(adapter, t0, 40)
    worldFish.coins = 500000
    worldFish.rev = 17235
    worldFish.state.plots = Array.from({ length: 8 }, () => ({ c: 'corn', t: t0 - 60, g: 0, w: 3, h: 0 }))
    worldFish.state.iq = { d: adapter.R.isleIndex(t0), craft: 80, mine: 100, fish: 0, bomb: 10, steal: 0 }
    let serverWorld = structuredClone(worldFish)

    const fishCommon = {
      adapter,
      journal,
      lockRootDir: lockRoot,
      account: 'main',
      fetchWorldFn: async () => {
        const w = adapter.advanceTimeOnly(serverWorld, simNow)
        w.rev = serverWorld.rev
        return w
      },
      sendActFn: async ({ actions, worldBefore }) => {
        const sim = adapter.simulateBatch(worldBefore, actions, { t: simNow, prices: worldBefore.prices })
        serverWorld = sim.afterWorld
        serverWorld.rev = Number(worldBefore.rev) + 1
        serverWorld.now = simNow
        // Simulate real server response omitting top-level `clockStart`, `prices`, `nextIsleAt`, `rumors`
        return {
          ok: true,
          status: 200,
          networkError: false,
          body: {
            ok: true,
            rev: serverWorld.rev,
            now: serverWorld.now,
            coins: serverWorld.coins,
            state: structuredClone(serverWorld.state),
            out: sim.result.out,
          },
        }
      },
      userConstraints: { domesticOnly: true, allowCapex: false },
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: {
        allowedActionTypes: ['fish', 'wait'],
        scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
        checkHorizonStability: false,
      },
      asyncPlanner: planner,
      rulesPath: RULES_PATH,
    }

    const s1 = await runControllerStep(fishCommon)
    assert.equal(s1.status, 'confirmed')
    assert.equal(s1.planSource, 'solved')
    assert.equal(planner.stats.workerSolves, 1)

    simNow = t0 + 2
    const s2 = await runControllerStep(fishCommon)
    assert.equal(s2.status, 'confirmed')
    assert.equal(s2.planSource, 'cache-hit', 'Partial /act response omitting clockStart/prices MUST still hit PlanCache continuation on Step 2')
    assert.equal(planner.stats.workerSolves, 1)

    // 2) Server rev rollback (`rev 17239 -> 17237` at later serverNow): re-anchors and confirms without deadlocking,
    //    while preserving same-timestamp stale-caller rejection!
    const rbJournal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal-rb'), account: 'secondary', compactRuntimeIndex: true })
    let wPre = makeActionableWorld(adapter, t0, 20)
    wPre.rev = 17237
    wPre.coins = 100000
    // Record historical settled txs from before VPS restore reaching rev=17239 at t0
    for (let r = 17237; r <= 17238; r++) {
      const res = await executeTransaction({
        journal: rbJournal,
        adapter,
        lockRootDir: lockRoot,
        account: 'secondary',
        operation: `old-op-${r}`,
        decisionId: `old-dec-${r}`,
        kind: 'act',
        worldBefore: { ...wPre, rev: r, now: t0 },
        requestPayload: { actions: [{ a: 'coffee' }] },
        sendFn: async () => ({
          status: 200,
          body: { ok: true, rev: r + 1, now: t0, coins: 85000, state: wPre.state, out: [{ ok: true }] },
        }),
      })
      assert.equal(res.status, 'confirmed')
    }

    // Same timestamp + same rev WITHOUT later server advancement must still fail closed (`stale-prestate-aborted`)
    const sameSecStale = await executeTransaction({
      journal: rbJournal,
      adapter,
      lockRootDir: lockRoot,
      account: 'secondary',
      operation: 'stale-same-sec',
      decisionId: 'dec-stale',
      kind: 'act',
      worldBefore: { ...wPre, rev: 17237, now: t0 },
      requestPayload: { actions: [{ a: 'coffee' }] },
      fetchAfterWorldFn: async () => ({ ...wPre, rev: 17237, now: t0 }),
      sendFn: async () => { throw new Error('must not send') },
    })
    assert.equal(sameSecStale.status, 'stale-prestate-aborted')

    // Later server timestamp (t0 + 1800) with rolled-back live server rev=17237 MUST re-anchor and confirm cleanly!
    const rolledBackWorld = { ...structuredClone(wPre), rev: 17237, now: t0 + 1800 }
    let sentAfterRollback = 0
    const recoveredTx = await executeTransaction({
      journal: rbJournal,
      adapter,
      lockRootDir: lockRoot,
      account: 'secondary',
      operation: 'op-post-rollback',
      decisionId: 'dec-post-rollback',
      kind: 'act',
      worldBefore: rolledBackWorld,
      requestPayload: { actions: [{ a: 'coffee' }] },
      fetchAfterWorldFn: async () => structuredClone(rolledBackWorld),
      sendFn: async ({ operation }) => {
        sentAfterRollback++
        return {
          status: 200,
          body: {
            ok: true,
            operation,
            rev: 17238,
            now: t0 + 1800,
            coins: rolledBackWorld.coins - 15000,
            state: rolledBackWorld.state,
            out: [{ ok: true }],
          },
        }
      },
    })
    assert.equal(sentAfterRollback, 1)
    assert.equal(recoveredTx.status, 'confirmed')

    // Subsequent call trying stale rev=17238 MUST still abort once rev advanced to 17239, proving safety lock remains active
    const staleAfterReanchor = await executeTransaction({
      journal: rbJournal,
      adapter,
      lockRootDir: lockRoot,
      account: 'secondary',
      operation: 'op-stale-after-reanchor',
      decisionId: 'dec-stale-after',
      kind: 'act',
      worldBefore: { ...rolledBackWorld, rev: 17237, now: t0 + 1800 },
      requestPayload: { actions: [{ a: 'coffee' }] },
      fetchAfterWorldFn: async () => ({ ...rolledBackWorld, rev: 17238, now: t0 + 1800 }),
      sendFn: async () => { throw new Error('must not send on rev=17237 when server is at 17238') },
    })
    assert.equal(staleAfterReanchor.status, 'stale-prestate-aborted')
  } finally {
    await planner.close()
  }
})
