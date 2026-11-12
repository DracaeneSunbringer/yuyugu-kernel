import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ContentAddressedJournal } from '../audit/journal.mjs'
import { auditDecisionAgainstReference } from '../audit/reference-solver.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { runControllerStep } from '../cli/controller.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'
import { AsyncPlanManager } from '../execution/async-planner.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { fromWireXsAction, MAX_XS_BATCH } from '../execution/xian-cultivation.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import {
  buildObservationEnvelope,
  resolveRaidOutcomeDistribution,
} from '../model/observations.mjs'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { MED_MAX, act as xsAct, newXs } from '../rules/xs-xian-rules.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeTempDir(prefix = 'kernel-p15-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function exactMatureDurationSec(adapter, cropId, nowSec, h = 0, auto = true) {
  const st = adapter.R.cropStage({ c: cropId, t: nowSec, g: 0, w: 3, h }, nowSec, auto)
  return Math.max(60, Math.ceil(Number(st?.total || 14400)))
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

function makeBaseSummerWorld(adapter, nowSec, overrides = {}) {
  const { R } = adapter
  const s = R.newWorld(nowSec)
  s.plotN = 24
  s.plots = Array(24).fill(null)
  s.barnN = 8
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 2 }
  s.mine = { max: 30 }
  s.en = 12
  s.enT = nowSec
  s.enDay = R.worldDay(nowSec)
  s.cnt = {}
  s.b12 = {}
  s.iq = { d: R.isleIndex(nowSec), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 }
  s.inv = {}
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id])
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 9100,
    coins: 500000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

function makeUpcomingNeighborSnapshot(adapter, {
  targetId,
  name,
  nowSec,
  unlockAtSec,
  spots,
  cropId = 'tomato',
  level = 10,
  guard = false,
}) {
  const stealDelaySec = Number(adapter.R.WORLD?.steal?.delay ?? 1800)
  const matureAt = unlockAtSec - stealDelaySec
  let plantedAt = matureAt - exactMatureDurationSec(adapter, cropId, matureAt - 3600, 0, true)
  for (let iter = 0; iter < 5; iter++) {
    const pt = adapter.exactPlotTimings(
      { c: cropId, t: plantedAt, g: 0, w: 3, h: 0 },
      true,
      nowSec,
      CLOCK_START,
      { protectSec: stealDelaySec, isAlreadyRipe: matureAt <= nowSec }
    )
    if (!pt) break
    const err = pt.unlockAt - unlockAtSec
    if (err === 0) break
    plantedAt -= err
  }
  const isRipeNow = matureAt <= nowSec
  const rawPlots = Array.from({ length: spots }, () => ({
    c: cropId,
    t: plantedAt,
    g: 0,
    w: 3,
    h: 0,
  }))
  const islePlots = Array.from({ length: spots }, () => ({
    c: cropId,
    t: plantedAt,
    g: 0,
    w: 3,
    h: 0,
    stage: isRipeNow ? 3 : 2,
    left: isRipeNow ? 0 : Math.max(1, matureAt - nowSec),
    steal: false,
    stolen: 0,
    auto: true,
  }))
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    owner: { id: targetId, name, level, guard, newbie: false },
    state: { plots: rawPlots, barn: [], tools: { spr: 3 } },
    isle: { plots: islePlots, barn: [], spr: 3 },
  }
}

function makeReadyNeighborSnapshot(adapter, {
  targetId,
  name,
  nowSec,
  spots,
  cropId = 'corn',
  level = 10,
  guard = false,
  posterior = null,
}) {
  const dur = exactMatureDurationSec(adapter, cropId, nowSec - 7200, 0, true)
  const plantedAt = nowSec - dur - 3600
  const rawPlots = Array.from({ length: spots }, () => ({
    c: cropId,
    t: plantedAt,
    g: 0,
    w: 3,
    h: 0,
  }))
  const islePlots = Array.from({ length: spots }, () => ({
    c: cropId,
    t: plantedAt,
    g: 0,
    w: 3,
    h: 0,
    stage: 3,
    left: 0,
    steal: true,
    stolen: 0,
    auto: true,
  }))
  return {
    id: targetId,
    now: nowSec,
    clockStart: CLOCK_START,
    owner: { id: targetId, name, level, guard, newbie: false },
    state: { plots: rawPlots, barn: [], tools: { spr: 3 } },
    isle: { plots: islePlots, barn: [], spr: 3 },
    posterior,
  }
}

test('Phase 15.1 (Codex Criterion 1): Planner -> SnipeScheduler executable raid contract skips rejected earlier target 9101, re-plans on newly discovered 9104, and logs imminent unplanned discovery', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const cornDur = exactMatureDurationSec(adapter, 'corn', t0, 0, true)
  const growingPlots = Array.from({ length: 24 }, () => ({
    c: 'corn',
    t: t0 - Math.floor(cornDur / 4),
    g: 0,
    w: 3,
    h: 0,
  }))

  let serverWorld = makeBaseSummerWorld(adapter, t0, {
    state: {
      plotN: 24,
      plots: growingPlots,
      en: 20,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      inv: { tomato: [10, 0, 0] },
    },
  })

  const tmp = makeTempDir('p15-1-')
  const lockRootDir = path.join(tmp, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })
  const snipeScheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'snipe-sched.json'),
    profileStorePath: path.join(tmp, 'profiles.json'),
    gearLockRoot: lockRootDir,
  })

  // Register TWO upcoming targets under `maxStealsPerIsleDay = 1`:
  // - 9101: 5 spots of corn unlocking EARLIER at `t0 + 295s`
  // - 9103: 11 spots of tomato unlocking LATER at `t0 + 700s`
  const snap9101 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 9101,
    name: 'Target9101',
    nowSec: t0,
    unlockAtSec: t0 + 295,
    spots: 5,
    cropId: 'corn',
    guard: false,
  })
  const snap9103 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 9103,
    name: 'Target9103',
    nowSec: t0,
    unlockAtSec: t0 + 700,
    spots: 11,
    cropId: 'tomato',
    guard: false,
  })
  snipeScheduler.recordVisitSnapshot(adapter, serverWorld, 9101, snap9101)
  snipeScheduler.recordVisitSnapshot(adapter, serverWorld, 9103, snap9103)

  let nowMs = t0 * 1000
  const visitPosts = []
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  try {
    const httpClient = new KernelHttpClient({
      baseUrl: 'https://game.example.invalid',
      cookieHeader: 'sid=test-p15-1',
      nowMsFn: () => nowMs,
      sleepMsFn: async (ms) => {
        if (ms > 0) nowMs += ms
      },
      fetchImpl: async (urlStr, init = {}) => {
        const u = new URL(urlStr)
        const method = String(init.method || 'GET').toUpperCase()
        const curSec = Math.floor(nowMs / 1000)
        serverWorld = adapter.advanceTimeOnly(serverWorld, curSec, { futurePrices: serverWorld.prices })
        serverWorld.now = curSec

        if (method === 'GET' && u.pathname === '/api/pet/world') {
          return new Response(JSON.stringify(structuredClone(serverWorld)), { status: 200 })
        }
        if (method === 'GET' && u.pathname === '/api/pet/battle/gear') {
          return new Response(JSON.stringify({ now: curSec, equipped: {}, bag: [] }), { status: 200 })
        }
        if (method === 'POST' && u.pathname === '/api/pet/world/act') {
          const body = JSON.parse(init.body || '{}')
          const sim = adapter.simulateBatch(serverWorld, body.actions || [], {
            t: curSec,
            prices: serverWorld.prices,
          })
          assert.equal(sim.allOk, true)
          serverWorld = sim.afterWorld
          serverWorld.rev = Number(serverWorld.rev || 0) + 1
          return new Response(JSON.stringify({ ok: true, rev: serverWorld.rev, now: curSec, world: serverWorld }), { status: 200 })
        }
        if (method === 'POST' && u.pathname.startsWith('/api/pet/world/visit/')) {
          const tid = Number(u.pathname.split('/').pop())
          visitPosts.push({ targetId: tid, atMs: nowMs })
          const spots = tid === 9104 ? 15 : (tid === 9105 ? 6 : 11)
          const enCost = adapter.R.b12StealCost(serverWorld.state, curSec, spots, 5, 1, 15)
          serverWorld.state.en = Math.max(0, Number(serverWorld.state.en || 0) - enCost)
          serverWorld.state.cnt[`st${tid}`] = Number(serverWorld.state.cnt[`st${tid}`] || 0) + 1
          serverWorld.state.inv.tomato ||= [0, 0, 0]
          serverWorld.state.inv.tomato[0] += spots
          serverWorld.rev = Number(serverWorld.rev || 0) + 1
          return new Response(JSON.stringify({
            ok: true,
            now: curSec,
            outcome: 'steal',
            loot: [{ id: 'tomato', q: 0, n: spots }],
          }), { status: 200 })
        }
        throw new Error(`Unexpected HTTP ${method} ${u.pathname}`)
      },
    })
    httpClient.observeServerTimestampSec(t0, nowMs)

    const runtimeState = {
      rulesPath: RULES_PATH,
      asyncPlanner,
      lastPetCareAtSec: t0,
      lastBattlePrepAtSec: t0,
      lastBoutFinishedAtMs: nowMs,
      lastHuancaiCheckAtSec: t0,
      lastCapexEvalAtSec: t0,
      arenaRemaining: 0,
    }
    const baseUserConstraints = {
      allowCapex: false,
      allowThiefBuffPurchase: true,
      cashReserveFloor: 100,
      maxStealsPerIsleDay: 1,
    }

    // 1) Tick 1 at `t0`: Planner evaluates [9101, 9103] and commits ONLY later high-value 9103!
    const tick1 = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient,
      journal,
      snipeScheduler,
      lockRootDir,
      profileStorePath: path.join(tmp, 'profiles.json'),
      runtimeState,
      baseUserConstraints,
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })

    const rs1 = tick1.controllerOut?.plan?.raidSchedule
    assert.ok(rs1, 'Expected plan.raidSchedule to be emitted by solveUnifiedPlan')
    assert.deepEqual([...rs1.evaluatedTargetIds].sort((a, b) => a - b), [9101, 9103])
    assert.deepEqual(rs1.committedRaids.map((r) => r.targetId), [9103])
    assert.equal(snipeScheduler.activeRaidSchedule?.planId, tick1.controllerOut.plan.planId)

    // 2) Advance clock right into 9101's staging & unlock window (`t0 + 292s` and `t0 + 295s`):
    //    `SnipeScheduler` MUST NOT fire on evaluated-and-rejected target 9101!
    nowMs = (t0 + 292) * 1000
    assert.equal(snipeScheduler.nextExactUnlockInfo(t0 + 292)?.targetId, 9103)
    const tickAt9101Window = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient,
      journal,
      snipeScheduler,
      lockRootDir,
      profileStorePath: path.join(tmp, 'profiles.json'),
      runtimeState: { ...runtimeState, lastPetCareAtSec: t0 + 292, lastBattlePrepAtSec: t0 + 292 },
      baseUserConstraints,
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })
    assert.notEqual(tickAt9101Window.phase, 'staged-snipe')
    assert.equal(visitPosts.length, 0, 'Evaluated-and-rejected earlier target 9101 must NEVER be sniped')

    // 3) Mid-wait dynamic discovery at `t0 + 400s`: brand-new 15-spot target 9104 unlocking at `t0 + 520s`
    //    triggers `needsScheduleRefresh()`, re-solves controller cleanly, and updates committed target to 9104!
    nowMs = (t0 + 400) * 1000
    serverWorld = adapter.advanceTimeOnly(serverWorld, t0 + 400)
    const snap9104 = makeUpcomingNeighborSnapshot(adapter, {
      targetId: 9104,
      name: 'Target9104',
      nowSec: t0 + 400,
      unlockAtSec: t0 + 520,
      spots: 15,
      cropId: 'tomato',
      guard: false,
    })
    snipeScheduler.recordVisitSnapshot(adapter, serverWorld, 9104, snap9104)
    assert.equal(snipeScheduler.needsScheduleRefresh(), true)
    assert.equal(snipeScheduler.getScheduleRefreshReason(), 'new-positive-ev-target:9104')

    const tickReplan = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient,
      journal,
      snipeScheduler,
      lockRootDir,
      profileStorePath: path.join(tmp, 'profiles.json'),
      runtimeState: { ...runtimeState, lastPetCareAtSec: t0 + 400, lastBattlePrepAtSec: t0 + 400 },
      baseUserConstraints,
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })
    assert.equal(snipeScheduler.needsScheduleRefresh(), false)
    assert.deepEqual(tickReplan.controllerOut.plan.raidSchedule.committedRaids.map((r) => r.targetId), [9104])

    // 4) Advance into 9104's physical staging lead (`t0 + 514s`): executes committed fast-path (`usedCommittedSchedule === true`)!
    let evaluateTargetWaveCalls = 0
    const origGetEval = snipeScheduler.getUnifiedEvaluator.bind(snipeScheduler)
    snipeScheduler.getUnifiedEvaluator = (...args) => {
      const ev = origGetEval(...args)
      return {
        ...ev,
        evaluateTargetWave: (...wArgs) => {
          evaluateTargetWaveCalls++
          return ev.evaluateTargetWave(...wArgs)
        },
      }
    }

    nowMs = (t0 + 514) * 1000
    const tickSnipe9104 = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient,
      journal,
      snipeScheduler,
      lockRootDir,
      profileStorePath: path.join(tmp, 'profiles.json'),
      runtimeState: { ...runtimeState, lastPetCareAtSec: t0 + 514, lastBattlePrepAtSec: t0 + 514 },
      baseUserConstraints,
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })
    assert.equal(tickSnipe9104.phase, 'staged-snipe')
    assert.equal(tickSnipe9104.stagedOut.status, 'confirmed')
    assert.equal(tickSnipe9104.stagedOut.targetId, 9104)
    assert.equal(tickSnipe9104.stagedOut.usedCommittedSchedule, true)
    assert.equal(evaluateTargetWaveCalls, 0, 'Committed schedule fast-path must run 0 duplicate evaluateTargetWave calls')
    assert.deepEqual(visitPosts.map((v) => v.targetId), [9104])

    // 5) Imminent unplanned discovery (`leadSec <= ceil(T_prep + 2)`): when a second quota is open (`maxStealsPerIsleDay = 2`)
    //    and target 9105 is discovered at `leadSec = 2s`, fast-lane stages without missing unlock and logs `imminent-unplanned-discovery-reselect`.
    snipeScheduler.getUnifiedEvaluator = origGetEval
    const curSec5 = Math.floor(nowMs / 1000)
    const snap9105 = makeUpcomingNeighborSnapshot(adapter, {
      targetId: 9105,
      name: 'Target9105',
      nowSec: curSec5,
      unlockAtSec: curSec5 + 2,
      spots: 6,
      cropId: 'tomato',
      guard: false,
    })
    snipeScheduler.recordVisitSnapshot(adapter, serverWorld, 9105, snap9105, { allowThiefBuffPurchase: false })
    const tickImminent = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient,
      journal,
      snipeScheduler,
      lockRootDir,
      profileStorePath: path.join(tmp, 'profiles.json'),
      runtimeState: { ...runtimeState, lastPetCareAtSec: curSec5, lastBattlePrepAtSec: curSec5 },
      baseUserConstraints: { ...baseUserConstraints, allowThiefBuffPurchase: false, maxStealsPerIsleDay: 2 },
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })
    assert.equal(tickImminent.phase, 'staged-snipe')
    assert.equal(tickImminent.stagedOut.targetId, 9105)
    assert.equal(tickImminent.stagedOut.scheduleReselectReason, 'imminent-unplanned-discovery-reselect')
  } finally {
    await asyncPlanner.close()
  }
})

test('Phase 15.2 (Codex Criterion 2): Joint Ready (t0) + Upcoming (t > t0) raid horizon commits both when affordable and skips inferior ready raid when quota/stamina is scarce', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const cornDur = exactMatureDurationSec(adapter, 'corn', t0, 0, true)
  const growingPlots = Array.from({ length: 24 }, () => ({
    c: 'corn',
    t: t0 - Math.floor(cornDur / 4),
    g: 0,
    w: 3,
    h: 0,
  }))

  const ready9106 = makeReadyNeighborSnapshot(adapter, {
    targetId: 9106,
    name: 'Ready9106',
    nowSec: t0,
    spots: 2,
    cropId: 'corn',
    guard: false,
  })
  const upcoming9107 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 9107,
    name: 'Upcoming9107',
    nowSec: t0,
    unlockAtSec: t0 + 600,
    spots: 11,
    cropId: 'tomato',
    guard: false,
  })

  // Subcase A: `maxStealsPerIsleDay = 2`, ample rations -> commits BOTH ready 9106 at t0 AND upcoming 9107 at t0+600!
  const worldBoth = makeBaseSummerWorld(adapter, t0, {
    state: {
      plotN: 24,
      plots: growingPlots,
      en: 8,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      inv: { tomato: [5, 0, 0] },
    },
  })
  const envBoth = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldBoth,
    neighborTargets: [ready9106],
    upcomingNeighborTargets: [{
      id: 9107,
      targetId: 9107,
      name: 'Upcoming9107',
      unlockAtSec: t0 + 600,
      exactUnlockKnown: true,
      upcomingSpots: 11,
      isle: upcoming9107.isle,
      state: upcoming9107.state,
      owner: upcoming9107.owner,
    }],
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      maxStealsPerIsleDay: 2,
      cashReserveFloor: 100,
    },
  })
  const planBoth = solveUnifiedPlan(adapter, envBoth, buildObjectiveConfig({ horizonSec: 3600 }), {
    rawNeighborTargetsById: new Map([[9106, ready9106]]),
  })
  assert.deepEqual(
    planBoth.raidSchedule.committedRaids.map((r) => ({ id: r.targetId, imm: r.isImmediate })),
    [
      { id: 9106, imm: true },
      { id: 9107, imm: false },
    ],
    'Joint horizon must commit BOTH ready 9106 at t0 AND upcoming 9107 at t0+600 (eliminating selectedVisits.length === 0 gate!)'
  )
  const compBoth = compileExecutablePrefix(adapter, worldBoth, planBoth)
  assert.equal(compBoth.nextTransactionKind, 'visit')
  assert.equal(compBoth.visitOperations[0].targetId, 9106)

  // Subcase B1 (`maxStealsPerIsleDay = 1`): skips inferior 2-spot ready 9106 at t0 to save the 1 quota for 11-spot upcoming 9107!
  const envQuota1 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldBoth,
    neighborTargets: [ready9106],
    upcomingNeighborTargets: [{
      id: 9107,
      targetId: 9107,
      name: 'Upcoming9107',
      unlockAtSec: t0 + 600,
      exactUnlockKnown: true,
      upcomingSpots: 11,
      isle: upcoming9107.isle,
      state: upcoming9107.state,
      owner: upcoming9107.owner,
    }],
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      maxStealsPerIsleDay: 1,
      cashReserveFloor: 100,
    },
  })
  const planQuota1 = solveUnifiedPlan(adapter, envQuota1, buildObjectiveConfig({ horizonSec: 3600 }), {
    rawNeighborTargetsById: new Map([[9106, ready9106]]),
  })
  assert.deepEqual(planQuota1.raidSchedule.committedRaids.map((r) => r.targetId), [9107])
  assert.equal(planQuota1.trunkBuckets[0]?.visitActions?.length || 0, 0)
  const compQuota1 = compileExecutablePrefix(adapter, worldBoth, planQuota1)
  assert.notEqual(compQuota1.nextTransactionKind, 'visit')
  assert.equal(compQuota1.visitOperations.length, 0)

  // Subcase B2 (`maxStealsPerIsleDay = 2`, scarce stamina `initEn + 3 regen + 1 tomato = 15 en`, guarded 9106 so stochastic loot cannot bootstrap stamina):
  // Can fund EITHER 9106 (6 en) OR 9107 (15 en), NOT both (21 en) -> skips ready 9106 to fund 9107!
  const ready9106Guarded = makeReadyNeighborSnapshot(adapter, {
    targetId: 9106,
    name: 'Ready9106Guarded',
    nowSec: t0,
    spots: 2,
    cropId: 'corn',
    guard: true,
  })
  const posteriors9106 = new Map([
    [9106, { sampleCount: 10, winInterval: [0.95, 0.95], lossInterval: [0.02, 0.02] }],
  ])
  const worldScarceEn = makeBaseSummerWorld(adapter, t0, {
    coins: 5000,
    cargo: { slots: [] },
    state: {
      plotN: 24,
      plots: growingPlots,
      en: 12,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      cnt: { coffee: 3 },
      inv: {},
    },
  })
  // Alone, guarded 9106 is positive-EV and selected at t0:
  const envAlone9106 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldScarceEn,
    neighborTargets: [ready9106Guarded],
    neighborPosteriors: posteriors9106,
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      maxStealsPerIsleDay: 2,
      cashReserveFloor: 4000,
    },
  })
  const planAlone9106 = solveUnifiedPlan(adapter, envAlone9106, buildObjectiveConfig({ horizonSec: 3600 }), {
    rawNeighborTargetsById: new Map([[9106, ready9106Guarded]]),
  })
  assert.deepEqual(planAlone9106.raidSchedule.committedRaids.map((r) => r.targetId), [9106])

  // Together with upcoming 9107, scarce stamina skips ready 9106 to fund 11-spot upcoming 9107:
  const envScarceEn = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldScarceEn,
    neighborTargets: [ready9106Guarded],
    neighborPosteriors: posteriors9106,
    upcomingNeighborTargets: [{
      id: 9107,
      targetId: 9107,
      name: 'Upcoming9107',
      unlockAtSec: t0 + 600,
      exactUnlockKnown: true,
      upcomingSpots: 11,
      isle: upcoming9107.isle,
      state: upcoming9107.state,
      owner: upcoming9107.owner,
    }],
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      maxStealsPerIsleDay: 2,
      cashReserveFloor: 4000,
    },
  })
  const planScarceEn = solveUnifiedPlan(adapter, envScarceEn, buildObjectiveConfig({ horizonSec: 3600 }), {
    rawNeighborTargetsById: new Map([[9106, ready9106Guarded]]),
  })
  assert.deepEqual(planScarceEn.raidSchedule.committedRaids.map((r) => r.targetId), [9107])
  assert.equal(planScarceEn.trunkBuckets[0]?.visitActions?.length || 0, 0)
})

test('Phase 15.3 (Codex Criterion 6): Continuous multi-tick receipt loop (t0 harvest -> ration prep -> +713s snipe -> post-snipe) with ZERO manual state patching', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const tomDurH0 = exactMatureDurationSec(adapter, 'tomato', t0, 0, true)
  const cornDurH0 = exactMatureDurationSec(adapter, 'corn', t0, 0, true)

  const plots = Array.from({ length: 24 }, (_, idx) => {
    if (idx === 1 || idx === 2) {
      return { c: 'tomato', t: t0 - tomDurH0 - 7, g: 0, w: 3, h: 0 }
    }
    return { c: 'corn', t: t0 - Math.min(1200, Math.floor(cornDurH0 / 4)), g: 0, w: 3, h: 0 }
  })

  // Authoritative server world mutated ONLY via rules simulation & receipts (zero manual test patching!)
  let authoritativeWorld = makeBaseSummerWorld(adapter, t0, {
    state: {
      plotN: 24,
      plots,
      en: 8,
      enT: t0 - 13,
      enDay: adapter.R.worldDay(t0),
      inv: { tomato: [20, 0, 0] },
    },
  })

  const tmp = makeTempDir('p15-3-')
  const lockRootDir = path.join(tmp, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })
  const snipeScheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'snipe-sched.json'),
    profileStorePath: path.join(tmp, 'profiles.json'),
    gearLockRoot: lockRootDir,
  })
  const snap9103 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 9103,
    name: 'Target9103',
    nowSec: t0,
    unlockAtSec: t0 + 713,
    spots: 11,
    cropId: 'tomato',
    guard: false,
  })
  snipeScheduler.recordVisitSnapshot(adapter, authoritativeWorld, 9103, snap9103)

  let nowMs = t0 * 1000
  const eventLog = []
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  try {
    const httpClient = new KernelHttpClient({
      baseUrl: 'https://game.example.invalid',
      cookieHeader: 'sid=test-p15-3',
      nowMsFn: () => nowMs,
      sleepMsFn: async (ms) => {
        if (ms > 0) nowMs += ms
      },
      fetchImpl: async (urlStr, init = {}) => {
        const u = new URL(urlStr)
        const method = String(init.method || 'GET').toUpperCase()
        const curSec = Math.floor(nowMs / 1000)
        authoritativeWorld = adapter.advanceTimeOnly(authoritativeWorld, curSec, {
          futurePrices: authoritativeWorld.prices,
        })
        authoritativeWorld.now = curSec

        if (method === 'GET' && u.pathname === '/api/pet/world') {
          return new Response(JSON.stringify(structuredClone(authoritativeWorld)), { status: 200 })
        }
        if (method === 'GET' && u.pathname === '/api/pet/battle/gear') {
          return new Response(JSON.stringify({ now: curSec, equipped: {}, bag: [] }), { status: 200 })
        }
        if (method === 'POST' && u.pathname === '/api/pet/world/act') {
          const body = JSON.parse(init.body || '{}')
          assert.equal(body.rev, authoritativeWorld.rev, 'POST /act must match authoritative server rev')
          const sim = adapter.simulateBatch(authoritativeWorld, body.actions || [], {
            t: curSec,
            prices: authoritativeWorld.prices,
            rand: adapter.makeSampleStreamPrng(11, curSec),
          })
          assert.equal(sim.allOk, true, `Expected legal POST /act batch at ${curSec}: ${JSON.stringify(body.actions)}`)
          authoritativeWorld = sim.afterWorld
          authoritativeWorld.rev = Number(authoritativeWorld.rev || 0) + 1
          eventLog.push({ kind: 'act', atSec: curSec, actions: body.actions })
          return new Response(JSON.stringify({
            ok: true,
            rev: authoritativeWorld.rev,
            now: curSec,
            world: authoritativeWorld,
          }), { status: 200 })
        }
        if (method === 'POST' && u.pathname === '/api/pet/world/visit/9103') {
          assert.ok(nowMs >= (t0 + 713) * 1000, 'POST /visit/9103 must not fire before exact unlockAt')
          const hasCarry = Boolean(adapter.R.b12Effect?.(authoritativeWorld.state, 'carry', curSec))
          const lootQty = 11 * (hasCarry ? 2 : 1)
          const enCost = adapter.R.b12StealCost(authoritativeWorld.state, curSec, 11, 5, 1, 15)
          assert.ok(authoritativeWorld.state.en >= enCost, `Must have >= ${enCost} en at visit fire, had ${authoritativeWorld.state.en}`)
          authoritativeWorld.state.en -= enCost
          authoritativeWorld.state.cnt.st9103 = Number(authoritativeWorld.state.cnt.st9103 || 0) + 1
          authoritativeWorld.state.inv.tomato ||= [0, 0, 0]
          authoritativeWorld.state.inv.tomato[0] += lootQty
          authoritativeWorld.rev = Number(authoritativeWorld.rev || 0) + 1
          eventLog.push({ kind: 'visit', atMs: nowMs, targetId: 9103, lootQty, enCost })
          return new Response(JSON.stringify({
            ok: true,
            now: curSec,
            outcome: 'steal',
            energyCost: enCost,
            got: [{ id: 'tomato', q: 0, n: lootQty }],
          }), { status: 200 })
        }
        throw new Error(`Unexpected HTTP ${method} ${u.pathname}`)
      },
    })
    httpClient.observeServerTimestampSec(t0, nowMs)

    const runtimeState = {
      rulesPath: RULES_PATH,
      asyncPlanner,
      lastPetCareAtSec: t0,
      lastBattlePrepAtSec: t0,
      lastBoutFinishedAtMs: nowMs,
      lastHuancaiCheckAtSec: t0,
      lastCapexEvalAtSec: t0,
      arenaRemaining: 0,
    }
    const baseUserConstraints = {
      allowCapex: false,
      allowThiefBuffPurchase: true,
      cashReserveFloor: 100,
      maxStealsPerIsleDay: 1,
    }

    let stepGuard = 0
    let snipeRes = null
    while (Math.floor(nowMs / 1000) <= t0 + 715 && stepGuard++ < 15) {
      const curS = Math.floor(nowMs / 1000)
      runtimeState.lastPetCareAtSec = curS
      runtimeState.lastBattlePrepAtSec = curS
      runtimeState.lastHuancaiCheckAtSec = curS
      const tick = await runLiveAccountTick({
        account: 'main',
        adapter,
        httpClient,
        journal,
        snipeScheduler,
        lockRootDir,
        profileStorePath: path.join(tmp, 'profiles.json'),
        runtimeState,
        baseUserConstraints,
        objectiveCfg: { horizonSec: 3600 },
        solverOptions: { checkHorizonStability: false },
        asyncPlanner,
        rulesPath: RULES_PATH,
      })
      if (tick.phase === 'staged-snipe') {
        snipeRes = tick.stagedOut
      }
      const nextWakeMs = Math.max(nowMs + 1000, Number(tick.nextWakeSec || (curS + 2)) * 1000)
      if (nowMs >= (t0 + 715) * 1000) break
      nowMs = Math.min((t0 + 715) * 1000 + 100, nextWakeMs)
    }

    // Verify full end-to-end physical chain:
    // 1) Domestic ripe plots 1 & 2 harvested at `t0`
    const firstAct = eventLog.find((e) => e.kind === 'act')
    assert.ok(firstAct && firstAct.atSec === t0)
    assert.deepEqual(
      firstAct.actions.filter((a) => a.a === 'harvest').map((a) => a.i).sort((a, b) => a - b),
      [1, 2]
    )
    // 2) Staged snipe prepared ration/buff and fired `POST /visit/9103` at `t0 + 713.025s` via committed schedule
    assert.ok(snipeRes, 'Expected staged snipe to execute on continuous timeline')
    assert.equal(snipeRes.status, 'confirmed')
    assert.equal(snipeRes.usedCommittedSchedule, true)
    const visitEv = eventLog.find((e) => e.kind === 'visit')
    assert.ok(visitEv)
    assert.ok(visitEv.atMs >= (t0 + 713) * 1000 + 25 && visitEv.atMs <= (t0 + 713) * 1000 + 120)

    // 3) Journal Layer-1/3 audit verifies every transaction in the continuous chain
    const { transactions: txs } = journal.reconstructTransactions()
    assert.ok(txs.length >= 2)
    for (const tx of txs) {
      const report = await buildAuditDecisionReport({
        adapter,
        journal,
        tx,
        maxSteps: 1,
        maxSearchNodes: 80,
      })
      assert.notEqual(report.verdict, 'mechanical-or-conservation-defect')
    }
  } finally {
    await asyncPlanner.close()
  }
})

test('Phase 15.4 (Codex Criterion 3): Guarded stochastic raid enforces discrete outcome feasibility (0 fracCash, 0 pre-receipt phantom craft/sell, fine reserve preserved)', async () => {
  // 1) Static code firewall: zero `fracCash` or `fracLoot` in planner/ or audit/
  for (const rel of ['planner/solve.mjs', 'audit/reference-solver.mjs']) {
    const src = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8')
    assert.equal(/fracCash|fracLoot/.test(src), false, `${rel} must contain zero fracCash/fracLoot conversions`)
  }

  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const cornDur = exactMatureDurationSec(adapter, 'corn', t0, 0, true)
  const growingPlots = Array.from({ length: 24 }, () => ({
    c: 'corn',
    t: t0 - Math.floor(cornDur / 4),
    g: 0,
    w: 3,
    h: 0,
  }))

  // Visitor starts with ZERO strawberries, coins = 6000, cashReserveFloor = 1000.
  // Guarded target 9108 has 8 spots of strawberry (`estFine = min(5000, round(8 * BASE_PRICE.strawberry * 1.2))` > 4000).
  const worldGuarded = makeBaseSummerWorld(adapter, t0, {
    coins: 6000,
    state: {
      plotN: 24,
      plots: growingPlots,
      en: 20,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      iq: { d: adapter.R.isleIndex(t0), craft: 0, mine: 100, fish: 80, bomb: 10, steal: 0 },
      inv: {},
    },
  })
  const guarded9108 = makeReadyNeighborSnapshot(adapter, {
    targetId: 9108,
    name: 'Guarded9108',
    nowSec: t0,
    spots: 8,
    cropId: 'strawberry',
    guard: true,
    posterior: {
      sampleCount: 12,
      winInterval: [0.85, 0.85],
      lossInterval: [0.10, 0.10],
    },
  })

  const env = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldGuarded,
    neighborTargets: [guarded9108],
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      cashReserveFloor: 1000,
      maxStealsPerIsleDay: 1,
    },
  })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 3600 }), {
    rawNeighborTargetsById: new Map([[9108, guarded9108]]),
  })

  // Trunk must NOT schedule `craft(jam)` or `sell(strawberry)` on un-guaranteed guarded loot (`guaranteedLootBag = {}`)!
  for (const b of plan.trunkBuckets || []) {
    for (const act of b.domesticActions || []) {
      assert.notEqual(
        act.a === 'sell' && act.id === 'strawberry',
        true,
        'Shared non-anticipative trunk must NEVER sell unreceived guarded raid loot'
      )
      assert.notEqual(
        act.a === 'craft' && act.id === 'jam',
        true,
        'Shared non-anticipative trunk must NEVER craft jam from unreceived guarded raid loot'
      )
    }
  }

  // Verify discrete receipt realization on BOTH branches (`win` -> crafts/sells strawberries; `lose` -> stays 100% legal after fine!):
  const winAfterWorld = adapter.cloneWorld(worldGuarded)
  winAfterWorld.now = t0 + 3
  winAfterWorld.rev += 1
  winAfterWorld.state.en -= 12
  winAfterWorld.state.inv.strawberry = [16, 0, 0]
  const winStep = await runControllerStep({
    adapter,
    journal: null,
    lockRootDir: null,
    account: 'main',
    fetchWorldFn: async () => winAfterWorld,
    userConstraints: { allowCapex: false, cashReserveFloor: 1000, maxStealsPerIsleDay: 0 },
    solverOptions: { checkHorizonStability: false },
    dryRun: true,
  })
  assert.equal(winStep.status, 'shadow-ready')
  assert.equal(
    winStep.compiled.domesticBatch.some(
      (a) => (a.a === 'craft' && a.id === 'jam') || (a.a === 'sell' && a.id === 'strawberry')
    ),
    true,
    'After discrete win receipt lands 16 strawberries, next step legally crafts jam or sells strawberry'
  )

  const loseAfterWorld = adapter.cloneWorld(worldGuarded)
  loseAfterWorld.now = t0 + 3
  loseAfterWorld.rev += 1
  loseAfterWorld.state.en -= 12
  loseAfterWorld.coins = 6000 - 4500 // 1500 >= 1000 cashReserveFloor
  const loseStep = await runControllerStep({
    adapter,
    journal: null,
    lockRootDir: null,
    account: 'main',
    fetchWorldFn: async () => loseAfterWorld,
    userConstraints: { allowCapex: false, cashReserveFloor: 1000, maxStealsPerIsleDay: 0 },
    solverOptions: { checkHorizonStability: false },
    dryRun: true,
  })
  assert.notEqual(loseStep.status, 'plan-invalid')
  if (loseStep.compiled.domesticBatch.length > 0) {
    const simLose = adapter.simulateBatch(loseAfterWorld, loseStep.compiled.domesticBatch, {
      t: loseAfterWorld.now,
      prices: loseAfterWorld.prices,
    })
    assert.equal(simLose.allOk, true)
  }
})

test('Phase 15.5 (Codex Criterion 4): Independent audit/reference-solver.mjs guarded-target verification (pDet=0.5, win=[0.8,0.8], 10 undet / 20 guard-win => expected 13 units, tie vs loss)', async () => {
  // Static firewall check: `audit/reference-solver.mjs` has 0 imports from `planner/*`
  const refSrc = fs.readFileSync(path.join(ROOT_DIR, 'audit/reference-solver.mjs'), 'utf8')
  assert.equal(/from\s+['"]\.\.\/planner\//.test(refSrc), false)

  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)

  // Clean zero-crop, zero-work world with `corn` price = 100 D/unit so expected units map 1:100 to objective D-coins!
  const world0 = makeBaseSummerWorld(adapter, t0, {
    coins: 50000,
    prices: {
      ...Object.fromEntries([...adapter.graph.sellableIds].map((id) => [id, Number(adapter.R.BASE_PRICE[id])])),
      corn: 100,
    },
    state: {
      plotN: 0,
      plots: [],
      barnN: 0,
      barn: [],
      en: 20,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      iq: { d: adapter.R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 },
      inv: {},
    },
  })

  // Case A0: Exact Codex synthetic arithmetic (`pDet = 0.5`, `winInterval = [0.8, 0.8]`, `lossInterval = [0, 0]` -> `0.2` tie,
  // `10` undetected / `20` guard-win): `0.5 * 10 + 0.5 * 0.8 * 20 + 0.5 * 0.2 * 0 = 13.0` exact expected units (NOT `5.0`)!
  const syntheticDist05 = resolveRaidOutcomeDistribution(
    adapter,
    {
      targetId: 9109,
      totalSpots: 10,
      energyCost: 14,
      hasGuard: true,
      detectionProb: 0.5,
      lootBag: { corn: 10 },
      guardWinLootBag: { corn: 20 },
      winInterval: [0.8, 0.8],
      lossInterval: [0.0, 0.0],
      estimatedFineOnLoss: 5000,
      estimationSource: 'empirical-posterior-interval',
    },
    null,
    t0,
    { mode: 'mid' }
  )
  assert.equal(Math.round((syntheticDist05.expectedLootBag.corn || 0) * 1000) / 1000, 13)
  assert.equal(syntheticDist05.expectedFineCoins, 0)

  // Case A1: Authoritative `pet-world-rules.js` (`R.b12Detection = 0.55`, `10` spots corn -> `10` undet / `20` guard-win,
  // `winInterval = [0.8, 0.8]`, `lossInterval = [0, 0]` -> `0.2` tie):
  // Exact expected corn = `0.45 * 10 + 0.55 * 0.8 * 20 + 0.55 * 0.2 * 0 = 4.5 + 8.8 + 0 = 13.3` units = `+1330 D` (NOT `450 D`)!
  const snapTie = makeReadyNeighborSnapshot(adapter, {
    targetId: 9109,
    name: 'Guarded9109',
    nowSec: t0,
    spots: 10,
    cropId: 'corn',
    guard: true,
    posterior: {
      sampleCount: 20,
      winInterval: [0.8, 0.8],
      lossInterval: [0.0, 0.0],
    },
  })
  const envTie = buildObservationEnvelope(adapter, {
    account: 'main',
    world: world0,
    neighborTargets: [snapTie],
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      cashReserveFloor: 0,
      maxStealsPerIsleDay: 1,
    },
  })
  const distTie = resolveRaidOutcomeDistribution(adapter, envTie.beliefs.visitBeliefs[0], world0, t0, { mode: 'mid' })
  assert.equal(Math.round((distTie.expectedLootBag.corn || 0) * 1000) / 1000, 13.3)
  assert.equal(distTie.expectedFineCoins, 0)

  const objShort = buildObjectiveConfig({ horizonSec: 60, continuationIsleDays: 0 })
  const auditWaitVsTie = auditDecisionAgainstReference(adapter, {
    worldBefore: world0,
    envelope: envTie,
    actualFirstActions: [],
    objectiveCfg: objShort,
    allowedActionTypes: ['sell', 'visit', 'wait'],
    maxSteps: 3,
  })
  assert.equal(auditWaitVsTie.actualContinuationValue, 50000)
  assert.equal(
    Math.round(auditWaitVsTie.bestAlternative.value),
    51330,
    `Expected independent reference solver to value 13.3 expected corn (pDet=0.55) at 50000 + 13.3*100 = 51330, got ${auditWaitVsTie.bestAlternative.value}`
  )
  assert.equal(Math.round(auditWaitVsTie.estimatedReferenceDelta), 1330)

  const auditVisitOptimal = auditDecisionAgainstReference(adapter, {
    worldBefore: world0,
    envelope: envTie,
    actualFirstActions: [{ a: 'visit', targetId: 9109 }],
    objectiveCfg: objShort,
    allowedActionTypes: ['sell', 'visit', 'wait'],
    maxSteps: 3,
  })
  assert.equal(Math.round(auditVisitOptimal.actualContinuationValue), 51330)
  assert.equal(Math.round(auditVisitOptimal.estimatedReferenceDelta), 0)

  // Case B: `lossInterval = [0.2, 0.2]` (`pLoss = 0.55 * 0.2 = 0.11` paying `estFine`) strictly lowers value by `0.11 * estFine`!
  const snapLoss = makeReadyNeighborSnapshot(adapter, {
    targetId: 9109,
    name: 'Guarded9109',
    nowSec: t0,
    spots: 10,
    cropId: 'corn',
    guard: true,
    posterior: {
      sampleCount: 20,
      winInterval: [0.8, 0.8],
      lossInterval: [0.2, 0.2],
    },
  })
  const envLoss = buildObservationEnvelope(adapter, {
    account: 'main',
    world: world0,
    neighborTargets: [snapLoss],
    userConstraints: {
      allowCapex: false,
      allowThiefBuffPurchase: false,
      cashReserveFloor: 0,
      maxStealsPerIsleDay: 1,
    },
  })
  const estFine = envLoss.beliefs.visitBeliefs[0].estimatedFineOnLoss
  assert.ok(estFine > 0)
  const auditVisitWithLoss = auditDecisionAgainstReference(adapter, {
    worldBefore: world0,
    envelope: envLoss,
    actualFirstActions: [{ a: 'visit', targetId: 9109 }],
    objectiveCfg: objShort,
    allowedActionTypes: ['sell', 'visit', 'wait'],
    maxSteps: 3,
  })
  assert.equal(
    Math.round(auditVisitWithLoss.actualContinuationValue),
    Math.round(51330 - 0.11 * estFine),
    'Loss branch must deduct 0.55 * 0.2 * estFine relative to tie branch'
  )
})

test('Phase 15.6 (Codex Criterion 5): xian (state.xs) world.rev isolation — 0 redundant Worker solves across xs* rev bumps, farmWakeSec-only prewarm, and fail-closed on real farm mutation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const tomDur = exactMatureDurationSec(adapter, 'tomato', t0, 0, true)
  const cornDur = exactMatureDurationSec(adapter, 'corn', t0, 0, true)

  // Plot 0 matures in `+36s` (`<= 45s` farmWakeSec pre-warm window!), while `xian` ticks every `~9s`!
  const plots = Array.from({ length: 24 }, (_, idx) => {
    if (idx === 0) return { c: 'tomato', t: t0 - tomDur + 36, g: 0, w: 3, h: 0 }
    return { c: 'corn', t: t0 - Math.floor(cornDur / 4), g: 0, w: 3, h: 0 }
  })

  const x0 = newXs(t0)
  x0.st = 4
  x0.root = 'metal'
  x0.roots = { e: ['metal', 'water'], v: [] }
  x0.hv = 1
  x0.plots[14] = { s: 'soil' }
  x0.stone = 200
  x0.seeds.jingu = 4
  x0.med = MED_MAX
  x0.medAt = t0 - 600

  let serverWorld = makeBaseSummerWorld(adapter, t0, {
    rev: 100,
    coins: 500,
    state: {
      plotN: 24,
      plots,
      en: 20,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      xs: x0,
    },
  })

  const tmp = makeTempDir('p15-6-')
  const lockRootDir = path.join(tmp, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'secondary' })
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })
  let nowMs = t0 * 1000
  let xsCommits = 0
  const farmCommits = []

  try {
    const httpClient = new KernelHttpClient({
      baseUrl: 'https://game.example.invalid',
      cookieHeader: 'sid=test-p15-6',
      nowMsFn: () => nowMs,
      sleepMsFn: async (ms) => {
        if (ms > 0) nowMs += ms
      },
      fetchImpl: async (urlStr, init = {}) => {
        const u = new URL(urlStr)
        const method = String(init.method || 'GET').toUpperCase()
        const curSec = Math.floor(nowMs / 1000)
        serverWorld = adapter.advanceTimeOnly(serverWorld, curSec, { futurePrices: serverWorld.prices })
        serverWorld.now = curSec

        if (method === 'GET' && u.pathname === '/api/pet/world') {
          return new Response(JSON.stringify(structuredClone(serverWorld)), { status: 200 })
        }
        if (method === 'POST' && u.pathname === '/api/pet/world/act') {
          const body = JSON.parse(init.body || '{}')
          assert.equal(body.rev, serverWorld.rev, 'POST /act must send authoritative latest world.rev')
          const actions = body.actions || []
          const isAllXs = actions.length > 0 && actions.every((a) => String(a?.a || '').startsWith('xs'))
          if (isAllXs) {
            assert.ok(actions.length <= MAX_XS_BATCH)
            const nextW = structuredClone(serverWorld)
            for (const wire of actions) {
              const internal = fromWireXsAction(wire)
              const r = xsAct(nextW.state.xs, internal, curSec, Math.random)
              assert.ok(r && r.ok)
            }
            nextW.rev = Number(serverWorld.rev) + 1
            serverWorld = nextW
            xsCommits++
            return new Response(JSON.stringify({ ok: true, rev: serverWorld.rev, now: curSec, world: serverWorld }), { status: 200 })
          }
          const sim = adapter.simulateBatch(serverWorld, actions, {
            t: curSec,
            prices: serverWorld.prices,
            rand: adapter.makeSampleStreamPrng(5, curSec),
          })
          assert.equal(sim.allOk, true)
          serverWorld = sim.afterWorld
          serverWorld.rev = Number(serverWorld.rev) + 1
          farmCommits.push({ atSec: curSec, sentRev: body.rev, actions })
          return new Response(JSON.stringify({ ok: true, rev: serverWorld.rev, now: curSec, world: serverWorld }), { status: 200 })
        }
        throw new Error(`Unexpected HTTP ${method} ${u.pathname}`)
      },
    })
    httpClient.observeServerTimestampSec(t0, nowMs)

    const runtimeState = {
      rulesPath: RULES_PATH,
      asyncPlanner,
      lastPetCareAtSec: t0,
      lastBattlePrepAtSec: t0,
      lastBoutFinishedAtMs: nowMs,
      lastHuancaiCheckAtSec: t0,
      lastCapexEvalAtSec: t0,
      arenaRemaining: 0,
    }
    const tickCommon = {
      account: 'secondary',
      adapter,
      httpClient,
      journal,
      snipeScheduler: null,
      lockRootDir,
      profileStorePath: path.join(tmp, 'profiles.json'),
      runtimeState,
      baseUserConstraints: { allowCapex: false, cashReserveFloor: 500, maxStealsPerIsleDay: 0 },
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
      xianOptions: { enabled: true },
    }

    // 1) Tick 1 at `t0` (`rev = 100`): solves wait plan once (`farmWakeSec = t0 + 36`), executes `xs*` (`rev -> 101`),
    //    and pre-warms `farmWakeSec = t0 + 36` (NOT `xianWake`)!
    const t1 = await runLiveAccountTick(tickCommon)
    assert.equal(t1.controllerOut.status, 'waiting')
    assert.equal(t1.farmWakeSec, t0 + 36)
    assert.ok(xsCommits >= 1)
    assert.equal(serverWorld.rev, 101)
    assert.equal(asyncPlanner.stats.workerSolves, 1)
    // Wait for background `farmWakeSec` (`t0 + 36`) pre-warm job to finish cleanly
    if (asyncPlanner.activeJob) {
      await asyncPlanner.activeJob.promise
    }
    assert.equal(asyncPlanner.stats.backgroundPrecomputes, 1)

    // 2) Tick 2 at `t0 + 10s` (`xian` wake, `rev = 101`, refill `med` so another `xsMeditate` bumps `rev -> 102`):
    //    MUST hit `PlanCache` (`0` foreground Worker solves AND `0` redundant background precomputes)!
    nowMs = (t0 + 10) * 1000
    serverWorld.state.xs.med = MED_MAX
    runtimeState.lastPetCareAtSec = t0 + 10
    runtimeState.lastBattlePrepAtSec = t0 + 10
    const t2 = await runLiveAccountTick(tickCommon)
    assert.equal(t2.controllerOut.status, 'waiting')
    assert.equal(t2.controllerOut.planSource, 'cache-hit')
    assert.equal(asyncPlanner.stats.workerSolves, 1, 'xs* rev bump 100 -> 101 must trigger ZERO extra Worker solves')
    assert.equal(asyncPlanner.stats.backgroundPrecomputes, 1, 'Existing farmWakeSec prewarm must NOT be overwritten or re-dispatched')
    assert.equal(serverWorld.rev, 102)

    // 3) Tick 3 at `t0 + 36s` (crop 0 matures! `rev = 102` at unlocked fetch, AND simulate an in-lock `xs*` bump to `rev = 103`!):
    //    MUST hit the pre-warmed `t0 + 36` harvest plan (`workerSolves` STILL `1`!) and commit `POST /act` with `rev = 103`!
    nowMs = (t0 + 36) * 1000
    runtimeState.lastPetCareAtSec = t0 + 36
    runtimeState.lastBattlePrepAtSec = t0 + 36
    let worldGetCountAt36 = 0
    const origGetJson = httpClient.getJson.bind(httpClient)
    httpClient.getJson = async (p, ...rest) => {
      if (p === '/api/pet/world') {
        worldGetCountAt36++
        if (worldGetCountAt36 === 2) {
          // Simulate concurrent `xs*` mutation bumping `rev: 102 -> 103` between unlocked fetch and in-lock fetch!
          serverWorld.state.xs.log = Number(serverWorld.state.xs.log || 0) + 1
          serverWorld.rev = 103
        }
      }
      return origGetJson(p, ...rest)
    }

    const t3 = await runLiveAccountTick(tickCommon)
    httpClient.getJson = origGetJson
    assert.equal(t3.phase, 'controller-executed')
    assert.equal(t3.controllerOut.status, 'confirmed')
    assert.equal(t3.controllerOut.planSource, 'cache-hit')
    assert.equal(t3.controllerOut.diagnostics.reusedAcrossNonFarmRev, true)
    assert.equal(asyncPlanner.stats.workerSolves, 1, 'Pre-warmed harvest at t0+36 must commit with 0 extra Worker solves across rev 100->103')
    assert.equal(farmCommits.length, 1)
    assert.equal(farmCommits[0].sentRev, 103, 'Authoritative HTTP POST /act must send latest rev=103')
    assert.equal(farmCommits[0].actions.some((a) => a.a === 'harvest' && a.i === 0), true)

    // 4) Fail-closed check: if BOTH `xs` AND a farm field (`coins`) mutate simultaneously (`rev 103 -> 104`),
    //    `executeInLock` MUST invalidate and refuse to commit the stale actionable plan!
    nowMs = (t0 + 40) * 1000
    const wPre = adapter.advanceTimeOnly(serverWorld, t0 + 40)
    wPre.state.plots[1] = { c: 'tomato', t: t0 - tomDur, g: 0, w: 3, h: 0 }
    const preEnv4 = buildObservationEnvelope(adapter, {
      account: 'secondary',
      world: wPre,
      userConstraints: { allowCapex: false, maxStealsPerIsleDay: 0, cashReserveFloor: 500 },
    })
    await asyncPlanner.precomputeInBackground({
      rulesPath: RULES_PATH,
      adapter,
      account: 'secondary',
      envelope: preEnv4,
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false },
      runStability: false,
      nowMsFn: () => nowMs,
    })
    if (asyncPlanner.activeJob) {
      await asyncPlanner.activeJob.promise
    }

    let inLockCheckIdx = 0
    const staleRes = await runControllerStep({
      adapter,
      journal,
      lockRootDir,
      account: 'secondary',
      nowMsFn: () => nowMs,
      fetchWorldFn: async () => {
        inLockCheckIdx++
        const snap = structuredClone(wPre)
        if (inLockCheckIdx >= 2) {
          snap.state.xs.log += 1
          snap.coins += 5000 // Simultaneous farm-domain cash mutation!
          snap.rev = Number(wPre.rev) + 1
        }
        return snap
      },
      sendActFn: async () => ({ ok: true, status: 200, networkError: false, body: { ok: true } }),
      objectiveCfg: { horizonSec: 3600 },
      userConstraints: { allowCapex: false, maxStealsPerIsleDay: 0, cashReserveFloor: 500 },
      solverOptions: { checkHorizonStability: false },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })
    assert.equal(staleRes.status, 'stale-plan-invalidated')
  } finally {
    await asyncPlanner.close()
  }
})
