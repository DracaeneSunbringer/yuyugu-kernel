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
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function exactMatureDurationSec(adapter, cropId, nowSec, h = 0, auto = true) {
  const st = adapter.R.cropStage({ c: cropId, t: nowSec, g: 0, w: 3, h }, nowSec, auto)
  return Math.max(60, Math.ceil(Number(st?.total || 14400)))
}

function makeOutageWorld(adapter, nowSec, overrides = {}) {
  const { R } = adapter
  const s = R.newWorld(nowSec)
  s.plotN = 24
  const cornTotalH1 = exactMatureDurationSec(adapter, 'corn', nowSec, 1, true)
  const cornTotalH0 = exactMatureDurationSec(adapter, 'corn', nowSec, 0, true)
  const tomTotalH0 = exactMatureDurationSec(adapter, 'tomato', nowSec, 0, true)

  // Realistic 24-plot main farm:
  // - Plot 19: ripe corn whose `matureAt + 1800s` visitor steal-protection `unlockAt` is at `nowSec + 10` (crossed during a 38s solve!)
  // - Plots 4 & 6: ripe tomatoes (`matureAt = nowSec - 120`)
  // - Remaining 21 plots: growing corn (`matureAt > nowSec + 3600`)
  s.plots = Array.from({ length: 24 }, (_, idx) => {
    if (idx === 19) {
      return { c: 'corn', t: nowSec - cornTotalH1 - 1790, g: 0, w: 3, h: 1 }
    }
    if (idx === 4 || idx === 6) {
      return { c: 'tomato', t: nowSec - tomTotalH0 - 120, g: 0, w: 3, h: 0 }
    }
    return { c: 'corn', t: nowSec - Math.min(1800, Math.floor(cornTotalH0 / 3)), g: 0, w: 3, h: 0 }
  })
  s.barnN = 8
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 2 }
  s.mine = { max: 30 }
  s.en = 58
  s.enT = nowSec
  s.enDay = R.worldDay(nowSec)
  s.iq = { d: R.isleIndex(nowSec), craft: 12, mine: 40, fish: 20, bomb: 2 }
  s.inv = {
    corn: [2100, 180, 39],   // 2,319 corn (> 150 tier-0 cap across natural days — the exact outage SPFA trigger!)
    tomato: [450, 50, 29],   // 529 tomato
    milk: [60, 12, 4],
    egg: [55, 10, 3],
    iron: [42, 0, 0],
    coal: [38, 0, 0],
    gold: [18, 0, 0],
    bait: [30, 0, 0],
  }
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id])
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 6237,
    coins: 3800000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

function findSummerMidIsleTime(adapter) {
  const { R } = adapter
  let t0 = 1794449342
  for (let step = 0; step < 200; step++, t0 += 3600) {
    const iDay = R.isleDay(t0)
    const remIsle = adapter.nextIsleBoundary(t0, CLOCK_START) - t0
    if (R.seasonOf(iDay) === 1 && remIsle >= 5400) {
      return t0
    }
  }
  return t0
}

test('Phase 12.1: Reproduces 2026-11-12 high-stock 24-plot outage snapshot — finishes fast and commits harvest cleanly even across +38s drift & own unlockAt', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidIsleTime(adapter)
  const snapshotWorld = makeOutageWorld(adapter, t0)

  // Sanity-check fixture: exactly 3 plots (4, 6, 19) are stage 3 at `t0`, and plot 19's `unlockAt` is in `(t0, t0 + 38)`!
  const ripeAtT0 = snapshotWorld.state.plots
    .map((p, idx) => (p && adapter.R.cropStage(p, t0, true).stage === 3 ? idx : -1))
    .filter((idx) => idx >= 0)
  assert.deepEqual(ripeAtT0, [4, 6, 19])
  const p19Timing = adapter.exactPlotTimings(snapshotWorld.state.plots[19], true, t0, CLOCK_START)
  assert.ok(p19Timing.unlockAt > t0 && p19Timing.unlockAt < t0 + 38, 'Plot 19 unlockAt must fall inside the +38s solve window')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p12-1-'))
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  const lockRootDir = path.join(tmpDir, 'locks')
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  try {
    let fetchCount = 0
    let committedActions = null
    // Simulate a 38-second wall-clock drift between initial world fetch (at t0) and in-lock fetch (at t0 + 38),
    // which ALSO crosses plot 19's visitor steal-protection `unlockAt` (t0 + 10) without crossing any new maturity!
    const out = await runControllerStep({
      adapter,
      journal,
      lockRootDir,
      account: 'main',
      fetchWorldFn: async () => {
        fetchCount++
        if (fetchCount === 1) return structuredClone(snapshotWorld)
        const advanced = adapter.advanceTimeOnly(snapshotWorld, t0 + 38, { futurePrices: snapshotWorld.prices })
        advanced.rev = snapshotWorld.rev
        return advanced
      },
      sendActFn: async ({ actions, worldBefore }) => {
        committedActions = actions
        const sim = adapter.simulateBatch(worldBefore, actions, {
          t: worldBefore.now,
          prices: worldBefore.prices,
          rand: adapter.makeSampleStreamPrng(1, worldBefore.now),
        })
        assert.equal(sim.allOk, true)
        const after = sim.afterWorld
        after.rev = worldBefore.rev + 1
        return { ok: true, status: 200, networkError: false, body: { ok: true, rev: after.rev, world: after } }
      },
      objectiveCfg: { horizonSec: 86400 },
      userConstraints: { allowCapex: false, cashReserveFloor: 10 },
      solverOptions: { checkHorizonStability: true },
      asyncPlanner,
      rulesPath: RULES_PATH,
    })

    assert.equal(out.status, 'confirmed', `Expected harvest batch to commit instead of plan-invalid, got ${JSON.stringify(out.diagnostics)}`)
    assert.equal(out.planSource, 'solved')
    assert.equal(out.diagnostics.clockDriftSec, 38)
    assert.ok(
      out.plan.quality.elapsedMs < 15000,
      `Expected base solver compute time < 15000ms (~5.5s standalone), got ${out.plan.quality.elapsedMs}ms`
    )
    assert.ok(
      out.diagnostics.solveElapsedMs < 30000,
      `Expected total 24h+32h Worker step < 30000ms even under 4x concurrent test load (~11.9s standalone, was 67,700ms before fix), got ${out.diagnostics.solveElapsedMs}ms`
    )
    const harvestedPlots = (committedActions || []).filter((a) => a.a === 'harvest').map((a) => a.i).sort((a, b) => a - b)
    assert.deepEqual(harvestedPlots, [4, 6, 19], 'All 3 ripe plots must be harvested in the committed batch')
  } finally {
    await asyncPlanner.close()
  }
})

test('Phase 12.2 (Codex Condition 3): Streaming base-plan checkpoint survives extended-solve timeout (worker.terminate) AND extended-solve crash, committing basePlan in the same tick', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidIsleTime(adapter)
  const world = makeOutageWorld(adapter, t0, {
    state: {
      ...makeOutageWorld(adapter, t0).state,
      inv: { corn: [120, 0, 0], tomato: [40, 0, 0] },
    },
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p12-2-'))
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  const lockRootDir = path.join(tmpDir, 'locks')
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH, commitMarginMs: 600 })

  try {
    // Subcase A: Extended horizon hangs (`simulateSlowExtendedMs: 12000`) past `deadlineAtMs` -> Worker is terminated,
    // `AsyncPlanManager` recovers streamed `basePlan` checkpoint, and `runControllerStep` commits the harvest!
    let actCommittedA = null
    const outTimeout = await runControllerStep({
      adapter,
      journal,
      lockRootDir,
      account: 'main',
      fetchWorldFn: async () => structuredClone(world),
      sendActFn: async ({ actions, worldBefore }) => {
        actCommittedA = actions
        const sim = adapter.simulateBatch(worldBefore, actions, {
          t: worldBefore.now,
          prices: worldBefore.prices,
          rand: adapter.makeSampleStreamPrng(2, worldBefore.now),
        })
        assert.equal(sim.allOk, true)
        const after = sim.afterWorld
        after.rev = worldBefore.rev + 1
        return { ok: true, status: 200, networkError: false, body: { ok: true, rev: after.rev, world: after } }
      },
      objectiveCfg: { horizonSec: 86400 },
      userConstraints: { allowCapex: false },
      solverOptions: {
        checkHorizonStability: true,
        stochasticPolicySamples: 1,
        simulateSlowExtendedMs: 12000,
      },
      asyncPlanner,
      rulesPath: RULES_PATH,
      deadlineAtMs: Date.now() + 8000,
    })

    assert.equal(outTimeout.status, 'confirmed', `Expected checkpoint recovery to commit basePlan, got ${outTimeout.status}`)
    assert.equal(outTimeout.diagnostics.recoveredFromCheckpoint, true)
    assert.equal(asyncPlanner.stats.checkpointRecoveries, 1)
    assert.ok((actCommittedA || []).some((a) => a.a === 'harvest'), 'Recovered basePlan must execute ripe harvests')

    // Subcase B: Extended horizon throws an unexpected runtime exception after basePlan checkpoint was streamed!
    world.rev += 10
    let actCommittedB = null
    const outCrash = await runControllerStep({
      adapter,
      journal,
      lockRootDir,
      account: 'main',
      fetchWorldFn: async () => structuredClone(world),
      sendActFn: async ({ actions, worldBefore }) => {
        actCommittedB = actions
        const sim = adapter.simulateBatch(worldBefore, actions, {
          t: worldBefore.now,
          prices: worldBefore.prices,
          rand: adapter.makeSampleStreamPrng(3, worldBefore.now),
        })
        assert.equal(sim.allOk, true)
        const after = sim.afterWorld
        after.rev = worldBefore.rev + 1
        return { ok: true, status: 200, networkError: false, body: { ok: true, rev: after.rev, world: after } }
      },
      objectiveCfg: { horizonSec: 86400 },
      userConstraints: { allowCapex: false },
      solverOptions: {
        checkHorizonStability: true,
        stochasticPolicySamples: 1,
        simulateExtendedError: true,
      },
      asyncPlanner,
      rulesPath: RULES_PATH,
      deadlineAtMs: Date.now() + 15000,
    })

    assert.equal(outCrash.status, 'confirmed', `Expected Worker crash in extended solve to recover basePlan, got ${outCrash.status}`)
    assert.equal(outCrash.diagnostics.recoveredFromCheckpoint, true)
    assert.equal(asyncPlanner.stats.checkpointRecoveries, 2)
    assert.ok((actCommittedB || []).some((a) => a.a === 'harvest'))
  } finally {
    await asyncPlanner.close()
  }
})

test('Phase 12.3 (Codex Condition 1): Lateral mid-solve maturity salvages urgent harvests while withholding discretionary stamina/cash actions (mine/stockBuy/craft) for immediate +2s re-optimization', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R } = adapter
  const t0 = findSummerMidIsleTime(adapter)
  const cornTotalH0 = exactMatureDurationSec(adapter, 'corn', t0, 0, true)

  // Subcase A: Mixed batch `[stockBuy, harvest(0), harvest(1), sell]` planned at `t0`, while neighboring plot 2 matures at `t0 + 10`.
  // At `t0 + 15`, `compileExecutablePrefix` MUST salvage `[harvest(0), harvest(1)]`, withhold `stockBuy` and `sell`,
  // and flag `truncatedByTransition: true` so controller schedules a `+2s` continuation tick for plot 2 + discretionary actions!
  const baseStock0 = R.b12Stock(t0, R.BASE_PRICE)[0]
  const worldA0 = makeOutageWorld(adapter, t0, {
    state: {
      ...makeOutageWorld(adapter, t0).state,
      en: 20,
      enT: t0,
      plots: Array.from({ length: 24 }, (_, idx) => {
        if (idx === 0 || idx === 1) return { c: 'corn', t: t0 - cornTotalH0 - 60, g: 0, w: 3, h: 0 }
        if (idx === 2) return { c: 'corn', t: t0 - cornTotalH0 + 10, g: 0, w: 3, h: 0 } // matures at t0 + 10!
        return { c: 'corn', t: t0 - 1800, g: 0, w: 3, h: 0 }
      }),
    },
  })
  assert.equal(R.cropStage(worldA0.state.plots[0], t0, true).stage, 3)
  assert.equal(R.cropStage(worldA0.state.plots[2], t0, true).stage, 2)
  const worldA15 = adapter.advanceTimeOnly(worldA0, t0 + 15, { futurePrices: worldA0.prices })
  worldA15.rev = worldA0.rev
  assert.equal(R.cropStage(worldA15.state.plots[2], t0 + 15, true).stage, 3)

  const syntheticMixedPlan = {
    planId: 'p12-mixed',
    serverNow: t0,
    horizonSec: 86400,
    nextWakeSec: t0 + 3600,
    waitReason: 'next-event',
    trunkBuckets: [
      {
        atSec: t0,
        domesticActions: [
          { a: 'stockBuy', id: baseStock0.id, n: 1, day: baseStock0.day },
          { a: 'harvest', i: 0 },
          { a: 'harvest', i: 1 },
          { a: 'sell', id: 'milk', q: 0, n: 5 },
        ],
        visitActions: [],
      },
    ],
  }
  const compiledMixed = compileExecutablePrefix(adapter, worldA15, syntheticMixedPlan)
  assert.equal(compiledMixed.status, 'ready')
  assert.equal(compiledMixed.truncatedByTransition, true)
  assert.deepEqual(
    compiledMixed.domesticBatch,
    [{ a: 'harvest', i: 0 }, { a: 'harvest', i: 1 }],
    'Must salvage urgent harvests while withholding discretionary stockBuy/sell across mid-solve maturity'
  )

  // Subcase B: Discretionary stamina `[{ a: 'mine' }]` planned at `t0` with `en = 3`, while plot 0 matures at `t0 + 10`.
  // At `t0 + 15`, `{ a: 'mine' }` is still rule-legal (`simulateBatch` passes!), yet executing it would waste the 3 stamina
  // needed to harvest newly matured plot 0! Must fail-closed with `bucket0-domestic-transition-crossed` and harvest on retry!
  let serverWorldB = makeOutageWorld(adapter, t0, {
    coins: 5000, // insufficient for 15,000 D coffee so 3 stamina is strictly scarce!
    state: {
      ...makeOutageWorld(adapter, t0).state,
      en: 3,
      enT: t0,
      iq: { d: R.isleIndex(t0), craft: 80, mine: 0, fish: 80, bomb: 10 },
      inv: {},
      plots: Array.from({ length: 24 }, (_, idx) => {
        if (idx === 0) return { c: 'corn', t: t0 - cornTotalH0 + 10, g: 0, w: 3, h: 0 } // matures at t0 + 10!
        return { c: 'corn', t: t0 - 1800, g: 0, w: 3, h: 0 }
      }),
    },
  })

  const minePlanAtT0 = {
    planId: 'p12-mine-stale-resource',
    serverNow: t0,
    horizonSec: 86400,
    nextWakeSec: t0 + 10,
    waitReason: 'plot-mature',
    trunkBuckets: [
      {
        atSec: t0,
        domesticActions: [{ a: 'mine' }],
        visitActions: [],
      },
    ],
  }
  const worldB15 = adapter.advanceTimeOnly(serverWorldB, t0 + 15, { futurePrices: serverWorldB.prices })
  worldB15.rev = serverWorldB.rev

  // Confirm `{ a: 'mine' }` WOULD pass raw `simulateBatch`, proving rule legality alone is insufficient:
  const rawMineSim = adapter.simulateBatch(worldB15, [{ a: 'mine' }], {
    t: worldB15.now,
    prices: worldB15.prices,
    rand: adapter.makeSampleStreamPrng(1, worldB15.now),
  })
  assert.equal(rawMineSim.allOk, true)

  const compiledMine = compileExecutablePrefix(adapter, worldB15, minePlanAtT0)
  assert.equal(compiledMine.status, 'plan-invalid')
  assert.ok(
    String(compiledMine.failedReason || '').startsWith('bucket0-domestic-transition-crossed:'),
    `Expected bucket0-domestic-transition-crossed, got ${compiledMine.failedReason}`
  )

  // Now verify the immediate retry tick at `t0 + 17` uses that preserved stamina to harvest plot 0 instead of mining!
  const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p12-3-'))
  const journalB = new ContentAddressedJournal({ rootDir: path.join(tmpDirB, 'journal'), account: 'secondary' })
  serverWorldB = adapter.advanceTimeOnly(serverWorldB, t0 + 17, { futurePrices: serverWorldB.prices })
  let retryActions = null
  const retryOut = await runControllerStep({
    adapter,
    journal: journalB,
    lockRootDir: path.join(tmpDirB, 'locks'),
    account: 'secondary',
    fetchWorldFn: async () => structuredClone(serverWorldB),
    sendActFn: async ({ actions, worldBefore }) => {
      retryActions = actions
      const sim = adapter.simulateBatch(worldBefore, actions, {
        t: worldBefore.now,
        prices: worldBefore.prices,
        rand: adapter.makeSampleStreamPrng(5, worldBefore.now),
      })
      assert.equal(sim.allOk, true)
      const after = sim.afterWorld
      after.rev = worldBefore.rev + 1
      serverWorldB = after
      return { ok: true, status: 200, networkError: false, body: { ok: true, rev: after.rev, world: after } }
    },
    objectiveCfg: { horizonSec: 86400 },
    userConstraints: { allowCapex: false, cashReserveFloor: 5000 },
    solverOptions: { checkHorizonStability: false, stochasticPolicySamples: 1 },
  })

  assert.equal(retryOut.status, 'confirmed')
  assert.ok(
    (retryActions || []).some((a) => a.a === 'harvest' && a.i === 0),
    `Preserved stamina must harvest newly matured plot 0 on retry, got ${JSON.stringify(retryActions)}`
  )
  assert.equal(
    (retryActions || []).some((a) => a.a === 'mine'),
    false,
    `Scarce 3 stamina must NOT be spent on mine before harvesting plot 0, got ${JSON.stringify(retryActions)}`
  )
})

test('Phase 12.4: Multi-tick runLiveAccountTick recovery loop — adaptive checkHorizonStability fallback, +2s harvest->replant continuity, diagnostics, and xian=off isolation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R } = adapter
  const t0 = findSummerMidIsleTime(adapter)
  const cornMeta = R.CROPS.find((c) => c.id === 'corn')
  const finalH = Math.max(0, Number(cornMeta?.times || 4) - 1)
  const cornTotalFinal = exactMatureDurationSec(adapter, 'corn', t0, finalH, true)

  let curWorld = makeOutageWorld(adapter, t0, {
    state: {
      ...makeOutageWorld(adapter, t0).state,
      en: 40,
      enT: t0,
      inv: { corn: [80, 0, 0] },
      plots: Array.from({ length: 24 }, (_, idx) => {
        // Plot 0 is on final regrow (`h = times - 1` -> becomes `null` empty plot after harvest!)
        if (idx === 0) return { c: 'corn', t: t0 - cornTotalFinal - 30, g: 0, w: 3, h: finalH }
        return { c: 'corn', t: t0 - 1800, g: 0, w: 3, h: 0 }
      }),
    },
  })
  assert.equal(R.cropStage(curWorld.state.plots[0], t0, true).stage, 3)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p12-4-'))
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  const lockRootDir = path.join(tmpDir, 'locks')
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })

  const mockHttp = {
    stats: { getCount: 0, postCount: 0 },
    nowMsFn: () => curWorld.now * 1000,
    estimatedServerNowSec: () => curWorld.now,
    serverSecToLocalMs: (sec) => sec * 1000,
    async getJson(url) {
      this.stats.getCount++
      if (url === '/api/pet/world') return structuredClone(curWorld)
      if (url === '/api/pet/status') return { adopted: false }
      return {}
    },
    async postJson(url, payload) {
      this.stats.postCount++
      if (url === '/api/pet/world/act') {
        const sim = adapter.simulateBatch(curWorld, payload.actions, {
          t: curWorld.now,
          prices: curWorld.prices,
          rand: adapter.makeSampleStreamPrng(7, curWorld.now),
        })
        assert.equal(sim.allOk, true)
        curWorld = sim.afterWorld
        curWorld.rev += 1
        return { ok: true, status: 200, networkError: false, body: { ok: true, rev: curWorld.rev, world: structuredClone(curWorld) } }
      }
      throw new Error(`Unexpected POST ${url}`)
    },
  }

  const runtimeState = {
    rulesPath: RULES_PATH,
    asyncPlanner,
    lastPetCareAtSec: t0,
    lastBattlePrepAtSec: t0,
    lastBoutFinishedAtMs: t0 * 1000,
    lastHuancaiCheckAtSec: t0,
    lastCapexEvalAtSec: t0,
    pendingCapex: false,
    arenaRemaining: 0,
    consecutivePlanInvalid: 1, // Simulate prior `plan-invalid` -> must trigger adaptive `checkHorizonStability: false`!
    consecutiveDeferred: 0,
  }

  try {
    // Tick 1: Harvests plot 0 (`h = finalH` -> clears plot 0), resets `consecutivePlanInvalid` to `0`, schedules `+2s` continuation!
    const tick1 = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient: mockHttp,
      journal,
      snipeScheduler: null,
      lockRootDir,
      profileStorePath: path.join(tmpDir, 'profiles.json'),
      runtimeState,
      baseUserConstraints: { allowCapex: false, maxStealsPerIsleDay: 0 },
      objectiveCfg: { horizonSec: 86400 },
      solverOptions: { stochasticPolicySamples: 1 },
      asyncPlanner,
      rulesPath: RULES_PATH,
      xianOptions: { enabled: false },
    })

    assert.equal(tick1.controllerOut.status, 'confirmed')
    assert.equal(tick1.controllerOut.horizonStability, null, 'Adaptive recovery must skip extended horizon stability after prior plan-invalid')
    assert.equal(runtimeState.consecutivePlanInvalid, 0, 'Successful confirmation must reset consecutivePlanInvalid')
    assert.equal(curWorld.state.plots[0], null, 'Plot 0 final harvest must clear plot 0')
    assert.equal(tick1.nextWakeSec, t0 + 2, 'Stochastic harvest must schedule immediate +2s continuation tick')
    assert.equal(tick1.backgroundReport ?? null, null)

    // Advance 2s to continuation tick -> must immediately buy seed & replant plot 0 with zero idle stall!
    curWorld = adapter.advanceTimeOnly(curWorld, t0 + 2, { futurePrices: curWorld.prices })
    const tick2 = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient: mockHttp,
      journal,
      snipeScheduler: null,
      lockRootDir,
      profileStorePath: path.join(tmpDir, 'profiles.json'),
      runtimeState,
      baseUserConstraints: { allowCapex: false, maxStealsPerIsleDay: 0 },
      objectiveCfg: { horizonSec: 86400 },
      solverOptions: { checkHorizonStability: false, stochasticPolicySamples: 1 },
      asyncPlanner,
      rulesPath: RULES_PATH,
      xianOptions: { enabled: false },
    })

    assert.equal(tick2.controllerOut.status, 'confirmed')
    assert.notEqual(curWorld.state.plots[0], null, 'Plot 0 must be replanted immediately on the +2s continuation tick')
    assert.equal(Number.isFinite(tick2.controllerOut.diagnostics?.solveElapsedMs), true)
  } finally {
    await asyncPlanner.close()
  }
})
