import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ContentAddressedJournal } from '../audit/journal.mjs'
import { auditDecisionAgainstReference } from '../audit/reference-solver.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'
import { AsyncPlanManager, PlanCache, buildNeighborSignature } from '../execution/async-planner.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { buildObservationEnvelope, buildUpcomingVisitBelief } from '../model/observations.mjs'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeTempDir(prefix = 'kernel-p14-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function exactMatureDurationSec(adapter, cropId, nowSec, h = 0, auto = true) {
  const st = adapter.R.cropStage({ c: cropId, t: nowSec, g: 0, w: 3, h }, nowSec, auto)
  return Math.max(60, Math.ceil(Number(st?.total || 14400)))
}

/**
 * Finds a timestamp in Summer (`season === 1`) with >= 2h remaining in the current isle day
 * and >= 2h before midnight natural-day boundary so intra-window stamina/raid physics are crisp.
 */
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
  s.en = 8
  s.enT = nowSec - 13
  s.enDay = R.worldDay(nowSec)
  s.cnt = {}
  s.b12 = {}
  s.iq = { d: R.isleIndex(nowSec), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 }
  s.inv = {}
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id])
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 7100,
    coins: 500000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

/**
 * Builds a raw neighbor snapshot whose `spots` plots unlock at exact `unlockAtSec`
 * (`matureAt = unlockAtSec - stealDelaySec`).
 */
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

test('Phase 14.1: Verified 2026-11-12 20:07:54 CST domestic tomato stall reproduction (target 9103: 11 spots, 15 en at +713s) & synthetic en=1 early-top-up case', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const tomDurH0 = exactMatureDurationSec(adapter, 'tomato', t0, 0, true)
  const cornDurH0 = exactMatureDurationSec(adapter, 'corn', t0, 0, true)

  // Verified 2026-11-12 20:07:54 CST incident parameters:
  // - Domestic: `en = 8`, `enT = t0 - 13` (`3` passive ticks `+3` before `t0 + 713s`),
  //   plots `1, 2` ripe regrowing tomatoes (`h = 0`, `matureAt = t0 - 7s`), `520` inventory tomatoes.
  // - Upcoming raid target `9103`: `11` spots (`energyCost = 15`), unlocking at `t0 + 713s`.
  const plots2007 = Array.from({ length: 24 }, (_, idx) => {
    if (idx === 1 || idx === 2) {
      return { c: 'tomato', t: t0 - tomDurH0 - 7, g: 0, w: 3, h: 0 }
    }
    return { c: 'corn', t: t0 - Math.min(1200, Math.floor(cornDurH0 / 4)), g: 0, w: 3, h: 0 }
  })
  const world2007 = makeBaseSummerWorld(adapter, t0, {
    state: {
      plotN: 24,
      plots: plots2007,
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 8,
      enT: t0 - 13,
      enDay: adapter.R.worldDay(t0),
      iq: { d: adapter.R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 },
      inv: {
        tomato: [450, 50, 20], // 520 inventory tomatoes
      },
    },
  })

  const tmp = makeTempDir('p14-1-')
  const lockDir = path.join(tmp, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })
  const scheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'snipe-sched.json'),
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
  const rec9103 = scheduler.recordVisitSnapshot(adapter, world2007, 9103, snap9103)
  assert.equal(rec9103.upcomingEligible, true)
  assert.equal(rec9103.upcomingSpots, 11)
  assert.equal(rec9103.projectedEnergyCost, 15)
  assert.equal(rec9103.expectedUnlockAt, t0 + 713)

  // Case A: End-to-end `runLiveAccountTick` harvests BOTH ripe regrowing tomato plots immediately at `t0`
  // (zero 33m stall!), commits `9103` on the unified timeline, and consumes 0 tomatoes at `t0`
  // (`8 - 2 = 6 en` + `3` passive ticks = `9 en`, leaving `1` deferred tomato at `t0 + 713s` -> `17 >= 15`)!
  let nowMs = t0 * 1000
  let liveWorld = adapter.cloneWorld(world2007)
  let committedTickActs = null
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })
  try {
    const httpClient = new KernelHttpClient({
      cookieHeader: 'sid=test',
      nowMsFn: () => nowMs,
      sleepMsFn: async (ms) => { nowMs += ms },
      fetchImpl: async (url, init) => {
        const p = new URL(url).pathname
        const body = init?.body ? JSON.parse(init.body) : null
        if (init.method === 'GET' && p === '/api/pet/world') {
          return { status: 200, headers: new Map(), text: async () => JSON.stringify(liveWorld) }
        }
        if (init.method === 'POST' && p === '/api/pet/world/act') {
          committedTickActs = body.actions
          const sim = adapter.simulateBatch(liveWorld, body.actions, {
            t: liveWorld.now,
            prices: liveWorld.prices,
            rand: adapter.makeSampleStreamPrng(7, liveWorld.now),
          })
          assert.equal(sim.allOk, true)
          liveWorld = sim.afterWorld
          liveWorld.rev = Number(liveWorld.rev || 0) + 1
          return {
            status: 200,
            headers: new Map(),
            text: async () => JSON.stringify({ ok: true, rev: liveWorld.rev, world: liveWorld }),
          }
        }
        throw new Error(`Unexpected HTTP call in Phase 14.1: ${init.method} ${p}`)
      },
    })
    httpClient.observeServerTimestampSec(t0)

    const tickOut = await runLiveAccountTick({
      adapter,
      httpClient,
      journal,
      lockRootDir: lockDir,
      account: 'main',
      fetchWorldFn: () => httpClient.getJson('/api/pet/world'),
      objectiveCfg: buildObjectiveConfig({ horizonSec: 3600 }),
      userConstraints: { allowCapex: false, cashReserveFloor: 100 },
      solverOptions: { checkHorizonStability: false },
      snipeScheduler: scheduler,
      asyncPlanner,
      rulesPath: RULES_PATH,
      enableArena: false,
      enablePetCare: false,
    })

    assert.equal(tickOut.controllerOut.status, 'confirmed')
    assert.equal(tickOut.staminaReservation.mode, 'unified-timeline')
    assert.equal(tickOut.staminaReservation.committedUpcomingRaids, 1)
    const harvestedAtT0 = (committedTickActs || [])
      .filter((a) => a.a === 'harvest')
      .map((a) => a.i)
      .sort((a, b) => a - b)
    assert.deepEqual(harvestedAtT0, [1, 2], 'Both ripe regrowing tomato plots [1, 2] must harvest immediately at t0 without waiting for 9103!')
    const eatsAtT0 = (committedTickActs || []).filter((a) => a.a === 'eat')
    assert.equal(eatsAtT0.length, 0, 'At en=8 -> 6 (+3 passive -> 9 + 8 deferred = 17 >= 15), 0 rations are needed at t0 (zero extra food consumed!)')

    // Verify `SnipeScheduler.executeStagedSnipe` skips BOTH `eat` and `coffee` when earlier domestic top-ups already raised `en >= neededEn`:
    let stagedMs = (t0 + 708) * 1000
    let stagedWorld = adapter.advanceTimeOnly(liveWorld, t0 + 708, { futurePrices: liveWorld.prices })
    stagedWorld.state.en = 16 // Already `>= 15` from earlier domestic top-up!
    const stagedPosts = []
    const stagedClient = new KernelHttpClient({
      cookieHeader: 'sid=test',
      nowMsFn: () => stagedMs,
      sleepMsFn: async (ms) => { stagedMs += ms },
      fetchImpl: async (url, init) => {
        const p = new URL(url).pathname
        const body = init?.body ? JSON.parse(init.body) : null
        stagedPosts.push({ method: init.method, path: p, body })
        if (init.method === 'GET' && p === '/api/pet/world') {
          stagedWorld.now = Math.floor(stagedMs / 1000)
          return { status: 200, headers: new Map(), text: async () => JSON.stringify(stagedWorld) }
        }
        if (init.method === 'POST' && p === '/api/pet/world/act') {
          const sim = adapter.simulateBatch(stagedWorld, body.actions, { t: Math.floor(stagedMs / 1000), prices: stagedWorld.prices })
          assert.equal(sim.allOk, true)
          stagedWorld = sim.afterWorld
          stagedWorld.rev += 1
          return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true, rev: stagedWorld.rev, state: stagedWorld.state, coins: stagedWorld.coins, now: stagedWorld.now }) }
        }
        if (init.method === 'GET' && p === '/api/pet/battle/gear') {
          return { status: 200, headers: new Map(), text: async () => JSON.stringify({ level: 12, free: 0, points: {}, gear: {}, items: [], catalog: [] }) }
        }
        if (init.method === 'POST' && p === '/api/pet/world/visit/9103') {
          stagedWorld.rev += 1
          stagedWorld.state.en = Math.max(0, stagedWorld.state.en - 15)
          return {
            status: 200,
            headers: new Map(),
            text: async () => JSON.stringify({ ok: true, result: { outcome: 'undetected', spots: 11, n: 22, items: [['tomato', 22]] } }),
          }
        }
        throw new Error(`Unexpected staged call: ${init.method} ${p}`)
      },
    })
    stagedClient.observeServerTimestampSec(t0 + 708)

    const snipeOut = await scheduler.executeStagedSnipe({
      adapter,
      httpClient: stagedClient,
      journal,
      lockRootDir: lockDir,
      fetchWorldFn: () => stagedClient.getJson('/api/pet/world'),
      userConstraints: { allowThiefBuffPurchase: true, cashReserveFloor: 100 },
      stageWindowSec: 15,
      postUnlockOffsetMs: 25,
    })
    assert.equal(snipeOut.status, 'confirmed')
    const stagedPrepActs = stagedPosts
      .filter((c) => c.method === 'POST' && c.path === '/api/pet/world/act')
      .flatMap((c) => c.body?.actions || [])
    assert.equal(
      stagedPrepActs.some((a) => a.a === 'eat' || a.a === 'coffee'),
      false,
      `executeStagedSnipe must skip redundant eat/coffee when en >= neededEn (got ${JSON.stringify(stagedPrepActs)})`
    )
  } finally {
    await asyncPlanner.close()
  }

  // Case B (Synthetic stress test: `en = 1` at `t0` with `2` ripe regrowing tomatoes & upcoming `9103` needing `15 en` at `+713s`):
  // Planner eats 1 tomato immediately at `t0` (`1 -> 13`), harvests both ripe tomatoes (`13 -> 11`), and commits `9103`!
  const worldEn1 = adapter.cloneWorld(world2007)
  worldEn1.state.en = 1
  const schedulerEn1 = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'snipe-sched-en1.json'),
  })
  schedulerEn1.recordVisitSnapshot(adapter, worldEn1, 9103, snap9103)
  const upcomingTargetsEn1 = schedulerEn1.collectUpcomingTargetsForController(adapter, worldEn1)
  const envEn1 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldEn1,
    upcomingNeighborTargets: upcomingTargetsEn1,
    userConstraints: { allowCapex: false, cashReserveFloor: 100 },
  })
  const planEn1 = solveUnifiedPlan(adapter, envEn1, buildObjectiveConfig({ horizonSec: 3600 }))
  const b0En1 = planEn1.trunkBuckets[0]?.domesticActions || []
  assert.equal(planEn1.committedUpcomingRaids?.length, 1)
  assert.equal(planEn1.committedUpcomingRaids[0].targetId, 9103)
  assert.ok(b0En1.some((a) => a.a === 'eat'), `Expected immediate eat at en=1 to fund ripe harvests, got ${JSON.stringify(b0En1)}`)
  assert.deepEqual(
    b0En1.filter((a) => a.a === 'harvest').map((a) => a.i).sort((a, b) => a - b),
    [1, 2],
    'Both ripe tomatoes [1, 2] must harvest immediately after early eat at t0'
  )
})

test('Phase 14.2 (Codex Guardrail 1 & 2): Synthetic scarce-stamina joint trajectory comparison (empty vs C) & lumpy-ration cliff without fixed order or food double-counting', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const summerCrops = adapter.R.CROPS
    .filter((c) => (c.seasons || []).includes(adapter.R.seasonOf(adapter.R.isleDay(t0))))
    .sort((a, b) => Number(adapter.R.BASE_PRICE[b.id] || 0) - Number(adapter.R.BASE_PRICE[a.id] || 0))
  const highCropId = summerCrops[0].id
  const lowCropId = summerCrops[summerCrops.length - 1].id

  // Synthetic scarce-stamina world: `inv = {}` (zero food), `coins = 200` (below coffee & thief items),
  // `en = 12`, `enT = t0`, `mine` open (`3 en`), upcoming raid at `t0 + 540s` (`+3` passive ticks -> `15 en` max).
  const makeScarceWorld = () => makeBaseSummerWorld(adapter, t0, {
    coins: 200,
    state: {
      plotN: 6,
      plots: Array(6).fill(null),
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 12,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      inv: {},
      iq: { d: adapter.R.isleIndex(t0), craft: 80, mine: 0, fish: 80, bomb: 10, steal: 0 },
    },
  })

  // 1) High-value upcoming raid (`11` spots of highest-tier crop, `15 en` at `t0 + 540s`):
  // `C = [highRaid]` beats `∅`; planner holds `en = 12` (`plannedPostBucketEnFloor = 12`), withholds `mine`, and wakes by `t0 + 540s`!
  const wHigh = makeScarceWorld()
  const snapHigh = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 900101,
    name: 'HighRaid',
    nowSec: t0,
    unlockAtSec: t0 + 540,
    spots: 11,
    cropId: highCropId,
    guard: false,
  })
  const envHigh = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wHigh,
    upcomingNeighborTargets: [{
      id: 900101,
      unlockAtSec: t0 + 540,
      exactUnlockKnown: true,
      owner: snapHigh.owner,
      isle: snapHigh.isle,
    }],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: false },
  })
  const planHigh = solveUnifiedPlan(adapter, envHigh, buildObjectiveConfig({ horizonSec: 1800 }), {
    allowedActionTypes: ['mine', 'sell', 'wait', 'visit'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.equal(planHigh.committedUpcomingRaids?.length, 1, 'High-value upcoming raid must win head-to-head over empty raid set')
  assert.equal(planHigh.trunkBuckets[0].plannedPostBucketEnFloor, 12)
  assert.equal(
    (planHigh.trunkBuckets[0]?.domesticActions || []).filter((a) => a.a === 'mine').length,
    0,
    'Domestic mine (cost 3) would leave 9 + 3 = 12 < 15 en at unlockAt, so planner must withhold mine!'
  )
  assert.ok(planHigh.nextWakeSec <= t0 + 540, `nextWakeSec (${planHigh.nextWakeSec}) must wake at or before unlockAt (${t0 + 540})`)

  // 2) Low-value heavily-guarded upcoming raid (`1` spot of cheapest crop, `guard = true`, high loss probability -> tiny/negative value vs domestic mining):
  // `∅` beats `C` on full-trajectory objective; planner ABANDONS the raid (`committedUpcomingRaids = []`) and mines immediately at `t0`!
  const wLow = makeScarceWorld()
  wLow.state.en = 5
  const snapLow = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 900102,
    name: 'TinyGuardedRaid',
    nowSec: t0,
    unlockAtSec: t0 + 120,
    spots: 1,
    cropId: lowCropId,
    level: 30,
    guard: true,
  })
  const envLow = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wLow,
    upcomingNeighborTargets: [{
      id: 900102,
      unlockAtSec: t0 + 120,
      exactUnlockKnown: true,
      owner: snapLow.owner,
      isle: snapLow.isle,
      posterior: { sampleCount: 30, winInterval: [0.0, 0.02], lossInterval: [0.98, 1.0] },
    }],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: false },
  })
  const planLow = solveUnifiedPlan(adapter, envLow, buildObjectiveConfig({ horizonSec: 1800 }), {
    allowedActionTypes: ['mine', 'sell', 'wait', 'visit'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.equal(planLow.committedUpcomingRaids?.length || 0, 0, 'Empty raid set must beat sub-mining-value upcoming raid head-to-head!')
  assert.ok(
    (planLow.trunkBuckets[0]?.domesticActions || []).some((a) => a.a === 'mine'),
    'Once unprofitable upcoming raid is abandoned, scarce stamina must be spent on domestic mining immediately!'
  )

  // 3) Physically unreachable upcoming raid (`11` spots = `15 en` needed at `+540s`, while `11 + 3 = 14 < 15` with 0 food/coffee):
  // `C` is flagged `raidScheduleInfeasible` and discarded cleanly!
  const wInfeas = makeScarceWorld()
  wInfeas.state.en = 11
  const snapInfeas = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 900103,
    name: 'Unreachable15EnRaid',
    nowSec: t0,
    unlockAtSec: t0 + 540,
    spots: 11,
    cropId: highCropId,
    guard: false,
  })
  const envInfeas = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wInfeas,
    upcomingNeighborTargets: [{
      id: 900103,
      unlockAtSec: t0 + 540,
      exactUnlockKnown: true,
      owner: snapInfeas.owner,
      isle: snapInfeas.isle,
    }],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: false },
  })
  const planInfeas = solveUnifiedPlan(adapter, envInfeas, buildObjectiveConfig({ horizonSec: 1800 }), {
    allowedActionTypes: ['mine', 'sell', 'wait', 'visit'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.equal(planInfeas.committedUpcomingRaids?.length || 0, 0, 'Physically unreachable 16-en raid must be discarded')
  assert.ok((planInfeas.trunkBuckets[0]?.domesticActions || []).some((a) => a.a === 'mine'))

  // 4) Synthetic lumpy-ration boundary (`en = 13` vs `en = 12` with 1 ripe plot and a `15 en` raid at `t0 + 540s`):
  // At `en = 13`, `13 - 1 + 3 = 15 >= 15` harvests with ZERO rations consumed;
  // at `en = 12` with `0` rations (`inv = {}`, `coins = 200`), `12 - 1 + 3 = 14 < 15`, so planner protects the high-EV `15 en` raid
  // instead of assuming a free ration exists!
  const makePlotVsRaidWorld = (enNow) => {
    const w = makeScarceWorld()
    w.state.en = enNow
    const dur = exactMatureDurationSec(adapter, lowCropId, t0, 0, true)
    w.state.plots[0] = { c: lowCropId, t: t0 - dur - 5, g: 0, w: 3, h: 0 }
    return w
  }
  const envEn13 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: makePlotVsRaidWorld(13),
    upcomingNeighborTargets: [{
      id: 900101,
      unlockAtSec: t0 + 540,
      exactUnlockKnown: true,
      owner: snapHigh.owner,
      isle: snapHigh.isle,
    }],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: false },
  })
  const planEn13 = solveUnifiedPlan(adapter, envEn13, buildObjectiveConfig({ horizonSec: 1800 }), {
    allowedActionTypes: ['harvest', 'sell', 'wait', 'visit'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.equal(planEn13.committedUpcomingRaids?.length, 1)
  assert.equal((planEn13.trunkBuckets[0]?.domesticActions || []).some((a) => a.a === 'harvest' && a.i === 0), true)

  const envEn12 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: makePlotVsRaidWorld(12),
    upcomingNeighborTargets: [{
      id: 900101,
      unlockAtSec: t0 + 540,
      exactUnlockKnown: true,
      owner: snapHigh.owner,
      isle: snapHigh.isle,
    }],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: false },
  })
  const planEn12 = solveUnifiedPlan(adapter, envEn12, buildObjectiveConfig({ horizonSec: 1800 }), {
    allowedActionTypes: ['harvest', 'sell', 'wait', 'visit'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.equal(planEn12.committedUpcomingRaids?.length, 1)
  assert.equal(
    (planEn12.trunkBuckets[0]?.domesticActions || []).some((a) => a.a === 'harvest'),
    false,
    'At en=12 with 0 food, harvesting 1 low-value plot drops en at +540s to 14 < 15, so high-EV 11-spot raid wins!'
  )
})

test('Phase 14.3: Verified multi-target window (9101, 9102, 9103) subset selection, non-spliced reservation diagnostics, and PlanCache invalidation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const tmp = makeTempDir('p14-3-')
  const scheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'sched.json'),
  })

  const w = makeBaseSummerWorld(adapter, t0, {
    state: {
      plotN: 12,
      plots: Array(12).fill(null),
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 20,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      inv: { tomato: [100, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 },
    },
  })

  // Verified 2026-11-12 multi-target window shapes:
  // - `9101`: `5` spots (`9 en`) at `t0 + 295s`
  // - `9102`: `7` spots (`11 en`) at `t0 + 588s`
  // - `9103`: `11` spots (`15 en`) at `t0 + 700s`
  const s9101 = makeUpcomingNeighborSnapshot(adapter, { targetId: 9101, name: 'T9101', nowSec: t0, unlockAtSec: t0 + 295, spots: 5, cropId: 'tomato' })
  const s9102 = makeUpcomingNeighborSnapshot(adapter, { targetId: 9102, name: 'T9102', nowSec: t0, unlockAtSec: t0 + 588, spots: 7, cropId: 'tomato' })
  const s9103 = makeUpcomingNeighborSnapshot(adapter, { targetId: 9103, name: 'T9103', nowSec: t0, unlockAtSec: t0 + 700, spots: 11, cropId: 'tomato' })

  scheduler.recordVisitSnapshot(adapter, w, 9101, s9101)
  scheduler.recordVisitSnapshot(adapter, w, 9102, s9102)
  scheduler.recordVisitSnapshot(adapter, w, 9103, s9103)

  const upcomingList = scheduler.collectUpcomingTargetsForController(adapter, w)
  assert.equal(upcomingList.length, 3)

  // 1) With only `1` daily steal slot left (`maxStealsPerIsleDay = 1`), unified subset comparison picks `9103` (`11` spots)
  // instead of greedily burning the final steal slot on the earliest unlock `9101` (`5` spots)!
  const envBudget1 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: w,
    upcomingNeighborTargets: upcomingList,
    userConstraints: { allowCapex: false, maxStealsPerIsleDay: 1 },
  })
  const planBudget1 = solveUnifiedPlan(adapter, envBudget1, buildObjectiveConfig({ horizonSec: 3600 }), {
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.deepEqual(
    (planBudget1.committedUpcomingRaids || []).map((r) => r.targetId),
    [9103],
    'With 1 steal slot remaining, joint subset selector must pick highest-value 9103 (11 spots) over earlier 9101 (5 spots)!'
  )

  // 2) With `2` daily steal slots (`maxStealsPerIsleDay = 2`), joint subset selector picks `[9102, 9103]` (`7 + 11 = 18` spots)!
  const envBudget2 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: w,
    upcomingNeighborTargets: upcomingList,
    userConstraints: { allowCapex: false, maxStealsPerIsleDay: 2 },
  })
  const planBudget2 = solveUnifiedPlan(adapter, envBudget2, buildObjectiveConfig({ horizonSec: 3600 }), {
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.deepEqual(
    (planBudget2.committedUpcomingRaids || []).map((r) => r.targetId),
    [9102, 9103],
    'With 2 steal slots, joint subset selector must pick [9102, 9103]!'
  )

  // 3) Verify `SnipeScheduler.computeImminentSnipeStaminaReservation` NEVER splices `max(floor)` from `9103` (`15 en` at `+700s`)
  // with `max(until)` from a later `1`-spot `9101` (`5 en` at `+810s`)!
  const s9101Late1Spot = makeUpcomingNeighborSnapshot(adapter, { targetId: 9101, name: 'T9101', nowSec: t0, unlockAtSec: t0 + 810, spots: 1, cropId: 'tomato' })
  scheduler.recordVisitSnapshot(adapter, w, 9101, s9101Late1Spot)
  const diagResv = scheduler.computeImminentSnipeStaminaReservation(adapter, w, t0)
  assert.equal(diagResv.staminaReserveFloor, 12)
  assert.equal(
    diagResv.staminaReserveUntilSec,
    t0 + 700,
    'staminaReserveUntilSec must bind to the dominant floor target 9103 (t0+700), NEVER splicing with later 5-en target 9101 (t0+810)!'
  )

  // 4) Verify `buildNeighborSignature` and `PlanCache` invalidate on `upcomingVisitBeliefs` changes AND at `earliestUpcomingUnlockSec`!
  const sigEmpty = buildNeighborSignature([], [])
  const sigWithUpcoming = buildNeighborSignature([], envBudget1)
  assert.notEqual(sigEmpty, sigWithUpcoming, 'upcomingVisitBeliefs must change neighborSig')

  const cache = new PlanCache()
  const objCfg = buildObjectiveConfig({ horizonSec: 3600 })
  const entry = cache.put({
    adapter,
    account: 'main',
    worldBefore: w,
    envelope: envBudget1,
    objectiveCfg: objCfg,
    neighborSig: sigWithUpcoming,
    plan: planBudget1,
  })
  assert.equal(
    entry.invalidateAtSec,
    t0 + 295,
    'PlanCache.put must cap invalidateAtSec at the earliest upcoming unlockAtSec (t0 + 295)!'
  )
  const validBeforeUnlock = cache.getValid({
    adapter,
    account: 'main',
    world: w,
    constraintsHash: envBudget1.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: sigWithUpcoming,
  })
  assert.ok(validBeforeUnlock, 'Cache must hit before earliest upcoming unlockAtSec when neighborSig matches')

  const wAtUnlock = adapter.advanceTimeOnly(w, t0 + 295, { futurePrices: w.prices })
  wAtUnlock.rev = w.rev
  const expiredAtUnlock = cache.getValid({
    adapter,
    account: 'main',
    world: wAtUnlock,
    constraintsHash: envBudget1.constraintsHash,
    objectiveHash: objCfg.objectiveHash,
    neighborSig: sigWithUpcoming,
  })
  assert.equal(expiredAtUnlock, null, 'PlanCache must invalidate once world.now >= earliest upcoming unlockAtSec!')
})

test('Phase 14.4 (Codex Guardrail 3 & 4): Transition-safe urgent prefix salvage (zero economic food selection + passive-tick invariance) & independent Layer-2/3 audit', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const tomDur = exactMatureDurationSec(adapter, 'tomato', t0, 0, true)

  // Subtest A: `compileExecutablePrefix` under lateral plot maturity (`plot 5` matures between `t0` and `t0 + 185s`):
  // - At `t0`: `en = 5`, `enT = t0`, plots `0, 1` ripe (`stage === 3`), plot `5` matures at `t0 + 100s`!
  // - Plan at `t0` has `plannedPostBucketEnFloor = 10` for committed upcoming raid at `t0 + 600s`,
  //   and `domesticActions = [eat(tomato,q=0), eat(tomato,q=0), harvest(0), harvest(1), mine, mine]`.
  // - At `nowW = t0 + 185s`: `1` passive tick elapsed (`en = 6`), so `adjustedPlannedFloor = 10 + 1 = 11`,
  //   and plot `5` laterally matured!
  // - `compileExecutablePrefix` must pull ONLY the minimal prefix of already-planned `eat` (`1` tomato -> `6 + 8 - 2 = 12 >= 11`)
  //   needed for `[harvest(0), harvest(1)]`, withholding the 2nd `eat` and both `mine` actions!
  const plotsSalvage = Array(8).fill(null)
  plotsSalvage[0] = { c: 'tomato', t: t0 - tomDur - 20, g: 0, w: 3, h: 0 }
  plotsSalvage[1] = { c: 'tomato', t: t0 - tomDur - 20, g: 0, w: 3, h: 0 }
  plotsSalvage[5] = { c: 'tomato', t: t0 - tomDur + 100, g: 0, w: 3, h: 0 } // Matures at `t0 + 100`!

  const wAt0 = makeBaseSummerWorld(adapter, t0, {
    state: {
      plotN: 8,
      plots: plotsSalvage,
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 5,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      inv: { tomato: [20, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 },
    },
  })
  const syntheticPlan = {
    constraints: { staminaReserveFloor: 0, staminaReserveUntilSec: 0, cashReserveFloor: 0 },
    committedUpcomingRaids: [{ targetId: 9103, unlockAtSec: t0 + 600, energyCost: 13 }],
    trunkBuckets: [{
      atSec: t0,
      plannedPostBucketEnFloor: 10,
      domesticActions: [
        { a: 'eat', id: 'tomato', q: 0 },
        { a: 'eat', id: 'tomato', q: 0 },
        { a: 'harvest', i: 0 },
        { a: 'harvest', i: 1 },
        { a: 'mine' },
        { a: 'mine' },
      ],
      visitActions: [],
    }],
  }

  const wAt185 = adapter.advanceTimeOnly(wAt0, t0 + 185, { futurePrices: wAt0.prices })
  assert.equal(wAt185.state.en, 6, '+1 passive stamina tick must have elapsed by t0 + 185')
  assert.equal(adapter.R.cropStage(wAt185.state.plots[5], t0 + 185, true).stage, 3, 'Plot 5 must have laterally matured by t0 + 185')

  const salvaged = compileExecutablePrefix(adapter, wAt185, syntheticPlan)
  assert.equal(salvaged.status, 'ready', `Expected urgent harvest salvage to succeed, got ${JSON.stringify(salvaged)}`)
  assert.equal(salvaged.truncatedByTransition, true)
  assert.deepEqual(
    salvaged.domesticBatch,
    [
      { a: 'eat', id: 'tomato', q: 0 },
      { a: 'harvest', i: 0 },
      { a: 'harvest', i: 1 },
    ],
    'Must pull ONLY the single already-planned eat needed to preserve adjustedPlannedFloor (11) for [harvest 0, harvest 1], withholding eat #2 and mines!'
  )

  // Verify `compile-prefix.mjs` NEVER invents new `eat` actions when `prefix` had no `eat`:
  // - Starting from `en(t0) = 11, enT = t0` -> `en(t0 + 185) = 12` (`adjustedPlannedFloor = 10 + 1 = 11`),
  //   only `harvest(0)` (`12 -> 11 >= 11`) survives; `harvest(1)` (`11 -> 10 < 11`) is withheld without inventing `eat`!
  // - Starting from `en(t0) = 10, enT = t0` -> `en(t0 + 185) = 11` (`adjustedPlannedFloor = 10 + 1 = 11`),
  //   `11 - 1 = 10 < 11`, so `compile-prefix.mjs` returns `plan-invalid` (`[]`)!
  const planWithoutEat = structuredClone(syntheticPlan)
  planWithoutEat.trunkBuckets[0].domesticActions = [{ a: 'harvest', i: 0 }, { a: 'harvest', i: 1 }]
  const wEn11At0 = adapter.cloneWorld(wAt0)
  wEn11At0.state.en = 11
  wEn11At0.state.enT = t0
  const wEn12NoEat = adapter.advanceTimeOnly(wEn11At0, t0 + 185, { futurePrices: wAt0.prices })
  const partialNoEat = compileExecutablePrefix(adapter, wEn12NoEat, planWithoutEat)
  assert.equal(partialNoEat.status, 'ready')
  assert.deepEqual(partialNoEat.domesticBatch, [{ a: 'harvest', i: 0 }])

  const wEn10At0 = adapter.cloneWorld(wAt0)
  wEn10At0.state.en = 10
  wEn10At0.state.enT = t0
  const wLowFloor = adapter.advanceTimeOnly(wEn10At0, t0 + 185, { futurePrices: wAt0.prices })
  const rejectedNoEat = compileExecutablePrefix(adapter, wLowFloor, planWithoutEat)
  assert.equal(
    rejectedNoEat.status,
    'plan-invalid',
    'compile-prefix.mjs must fail-closed instead of inventing new eat actions when plannedPostBucketEnFloor would be breached!'
  )

  // Verify `compile-prefix.mjs` returns `plan-invalid` (never standalone `eat`!) when `prefix` has ZERO urgent actions:
  const planOnlyEatMine = structuredClone(syntheticPlan)
  planOnlyEatMine.trunkBuckets[0].domesticActions = [{ a: 'eat', id: 'tomato', q: 0 }, { a: 'mine' }]
  const rejectedNoUrgent = compileExecutablePrefix(adapter, wAt185, planOnlyEatMine)
  assert.equal(rejectedNoUrgent.status, 'plan-invalid')
  assert.equal(rejectedNoUrgent.domesticBatch.length, 0)

  // Subtest B: Independent Layer-2/3 Audit (`auditDecisionAgainstReference` & `buildAuditDecisionReport`, 0 planner/* imports):
  // Find a late-Summer timestamp `45s` before the Autumn season boundary (`seasonOf(dNow) === 1`, `seasonOf(dNext) === 2`):
  // With `en = 1`, `2` ripe `h = 0` regrowing tomatoes, and upcoming `9103` (`11` spots, `15 en` at `+120s`),
  // stalling `[]` at `tLate` delays harvest across the Autumn boundary so post-harvest `p.t` falls in Autumn and immediately withers (`stage = -1`),
  // whereas `stamina+farm-ready` (`eat` + `harvest` x2 at `tLate` in Summer) locks in `p.t` in Summer for another full harvest AND funds `9103`!
  let tLate = t0
  for (let step = 0; step < 3000; step++) {
    const nextB = adapter.nextIsleBoundary(tLate, CLOCK_START)
    const dNow = adapter.R.isleDay(tLate)
    const dNext = adapter.R.isleDay(nextB)
    if (adapter.R.seasonOf(dNow) === 1 && adapter.R.seasonOf(dNext) === 2) {
      tLate = nextB - 45
      break
    }
    tLate = nextB + 60
  }
  const tomDurLate = exactMatureDurationSec(adapter, 'tomato', tLate - 7200, 0, true)
  const snap422 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 9103,
    name: 'Target9103',
    nowSec: tLate,
    unlockAtSec: tLate + 120,
    spots: 11,
    cropId: 'corn',
    guard: false,
  })
  const wAudit = makeBaseSummerWorld(adapter, tLate, {
    state: {
      plotN: 4,
      plots: [
        { c: 'tomato', t: tLate - tomDurLate - 20, g: 0, w: 3, h: 0 },
        { c: 'tomato', t: tLate - tomDurLate - 20, g: 0, w: 3, h: 0 },
        null,
        null,
      ],
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 1,
      enT: tLate,
      enDay: adapter.R.worldDay(tLate),
      inv: { tomato: [50, 0, 0] },
      iq: { d: adapter.R.isleIndex(tLate), craft: 80, mine: 100, fish: 80, bomb: 10, steal: 0 },
    },
  })
  const upcomingBelief = buildUpcomingVisitBelief(adapter, wAudit, {
    id: 9103,
    unlockAtSec: tLate + 120,
    exactUnlockKnown: true,
    owner: snap422.owner,
    isle: snap422.isle,
  })
  assert.ok(upcomingBelief)

  const envAudit = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wAudit,
    upcomingNeighborTargets: [{
      id: 9103,
      unlockAtSec: tLate + 120,
      exactUnlockKnown: true,
      owner: snap422.owner,
      isle: snap422.isle,
    }],
    userConstraints: { allowCapex: false },
  })
  const auditObjCfg = buildObjectiveConfig({ horizonSec: 7200 })
  const unifiedPlan = solveUnifiedPlan(adapter, envAudit, auditObjCfg, {
    allowedActionTypes: ['harvest', 'clear', 'eat', 'sell', 'wait', 'visit'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  const unifiedFirstActs = unifiedPlan.trunkBuckets[0]?.domesticActions || []
  assert.ok(unifiedFirstActs.some((a) => a.a === 'eat'))
  assert.equal(unifiedFirstActs.filter((a) => a.a === 'harvest').length, 2)

  // 1) Stalled `[]` decision crosses Autumn boundary and loses strictly to `stamina+farm-ready`:
  const stalledAudit = auditDecisionAgainstReference(adapter, {
    worldBefore: wAudit,
    actualFirstActions: [],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
    objectiveCfg: auditObjCfg,
    allowedActionTypes: ['harvest', 'clear', 'eat', 'sell', 'wait', 'visit'],
    constraints: envAudit.constraints,
    upcomingVisitBeliefs: [upcomingBelief],
    maxSteps: 4,
    maxSearchNodes: 600,
  })
  assert.equal(stalledAudit.exhaustiveCertified, false, 'Stochastic harvest/visit space must honestly report exhaustiveCertified = false!')
  assert.ok(
    stalledAudit.bestAlternative.label.startsWith('stamina+farm-ready'),
    `Independent reference solver must discover stamina+farm-ready over stalled wait (got ${stalledAudit.bestAlternative.label})`
  )
  assert.ok(
    stalledAudit.bestAlternative.value > stalledAudit.actualContinuationValue + 1000,
    `Stalled wait (${stalledAudit.actualContinuationValue}) must lose strictly to stamina+farm-ready (${stalledAudit.bestAlternative.value})`
  )

  const stalledReport = await buildAuditDecisionReport({
    adapter,
    worldBefore: wAudit,
    actualFirstActions: [],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
    objectiveCfg: auditObjCfg,
    constraints: envAudit.constraints,
    allowedActionTypes: ['harvest', 'clear', 'eat', 'sell', 'wait', 'visit'],
    upcomingVisitBeliefs: [upcomingBelief],
    maxSteps: 4,
    maxSearchNodes: 600,
  })
  assert.equal(stalledReport.reference.exhaustiveCertified, false)
  assert.equal(stalledReport.verdict, 'estimated-suboptimal-candidate')
  assert.equal(stalledReport.identifiableDecisionRegretLowerBound, null)
  assert.ok(stalledReport.estimatedReferenceDelta > 1000)

  // 2) Unified `v1.4.2` decision is certified `ex-ante-consistent` via `buildAuditDecisionReport`:
  const unifiedReport = await buildAuditDecisionReport({
    adapter,
    worldBefore: wAudit,
    actualFirstActions: unifiedFirstActs,
    actualFullPolicyObjectiveValue: unifiedPlan.quality.policyExpectedValue,
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
    objectiveCfg: auditObjCfg,
    constraints: envAudit.constraints,
    allowedActionTypes: ['harvest', 'clear', 'eat', 'sell', 'wait', 'visit'],
    upcomingVisitBeliefs: [upcomingBelief],
    maxSteps: 4,
    maxSearchNodes: 600,
  })
  assert.equal(unifiedReport.reference.exhaustiveCertified, false)
  assert.equal(unifiedReport.verdict, 'ex-ante-consistent')
  assert.equal(unifiedReport.identifiableDecisionRegretLowerBound, null)
  assert.equal(unifiedReport.estimatedReferenceDelta, 0)
})
