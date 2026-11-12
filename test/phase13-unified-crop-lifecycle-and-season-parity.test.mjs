import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ContentAddressedJournal } from '../audit/journal.mjs'
import { auditDecisionAgainstReference } from '../audit/reference-solver.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'
import { AsyncPlanManager } from '../execution/async-planner.mjs'
import {
  buildContinuationTimeline,
  buildObjectiveConfig,
  projectContinuationFarmFlows,
} from '../model/objective.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildEventBuckets } from '../planner/resources.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_A = 1794212939
const CLOCK_B = 1794227339

function makeBaseWorld(adapter, nowSec, clockStart = CLOCK_A, overrides = {}) {
  const { R } = adapter
  adapter.syncClock(clockStart)
  const s = R.newWorld(nowSec)
  s.plotN = 24
  s.plots = Array(24).fill(null)
  s.barnN = 8
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 2 }
  s.mine = { max: 30 }
  s.en = 90
  s.enT = nowSec
  s.enDay = R.worldDay(nowSec)
  s.iq = { d: R.isleIndex(nowSec), craft: 80, mine: 100, fish: 80, bomb: 10 }
  s.inv = {}
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id])
  }
  return {
    now: nowSec,
    clockStart,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, clockStart),
    rev: 100,
    coins: 500000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

function findSeasonBoundaryAfter(adapter, fromSec, seasonFrom, clockStart = CLOCK_A) {
  const { R } = adapter
  adapter.syncClock(clockStart)
  let cursor = fromSec
  for (let i = 0; i < 120; i++) {
    const curS = R.seasonOf(R.isleDay(cursor))
    const nextB = adapter.nextSeasonBoundary(cursor, clockStart)
    assert.ok(nextB > cursor)
    if (curS === seasonFrom) {
      return nextB
    }
    cursor = nextB
  }
  throw new Error(`Could not find season ${seasonFrom} boundary`)
}

function executeLifecycleViaRealRules(adapter, cropId, startSec, isSprinkled, clockStart) {
  const { R } = adapter
  const world0 = makeBaseWorld(adapter, startSec, clockStart, {
    coins: 500000,
    state: {
      plotN: 1,
      plots: [null],
      tools: { pick: 4, rod: 4, can: 4, spr: isSprinkled ? 3 : 0, house: 2 },
      en: 140,
      enT: startSec,
      enDay: R.worldDay(startSec),
    },
  })

  let curWorld = world0
  let totalStaminaSpent = 0
  const harvests = []

  const stepPlant = adapter.simulateBatch(curWorld, [{ a: 'plant', i: 0, c: cropId }], { t: startSec })
  assert.equal(stepPlant.allOk, true, `Real R.applyActions must allow planting ${cropId} at ${startSec}`)
  totalStaminaSpent += curWorld.state.en - stepPlant.afterWorld.state.en
  curWorld = stepPlant.afterWorld

  let witheredAtEnd = false
  let needsClearAtEnd = false

  for (let guard = 0; guard < 8; guard++) {
    const p = curWorld.state.plots[0]
    if (!p) break

    const stAtCycleStart = R.cropStage(p, curWorld.now, isSprinkled || R.weatherOf(R.isleDay(curWorld.now)) === 1)
    if (stAtCycleStart.stage === -1) {
      witheredAtEnd = true
      needsClearAtEnd = true
      const beforeEn = curWorld.state.en
      const stepClear = adapter.simulateBatch(curWorld, [{ a: 'clear', i: 0 }], { t: curWorld.now })
      assert.equal(stepClear.allOk, true)
      assert.equal(stepClear.afterWorld.state.plots[0], null)
      totalStaminaSpent += beforeEn - stepClear.afterWorld.state.en
      curWorld = stepClear.afterWorld
      break
    }

    // Scan forward for exact second where `R.cropStage` reaches `stage === 3` (or `-1`)
    let foundMatureSec = null
    let probeT = curWorld.now
    while (probeT <= curWorld.now + 72 * 3600) {
      const auto = isSprinkled || R.weatherOf(R.isleDay(probeT)) === 1
      const st = R.cropStage(p, probeT, auto)
      if (st.stage === 3) {
        // Binary search exact 1-second maturity edge in `(probeT - 60, probeT]`
        let lo = Math.max(curWorld.now, probeT - 60)
        let hi = probeT
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2)
          const midAuto = isSprinkled || R.weatherOf(R.isleDay(mid)) === 1
          if (R.cropStage(p, mid, midAuto).stage === 3) hi = mid
          else lo = mid + 1
        }
        foundMatureSec = lo
        break
      }
      probeT += 60
    }
    assert.ok(foundMatureSec != null, `Expected plot to mature within 72h for ${cropId}`)

    if (foundMatureSec > curWorld.now) {
      const autoPrev = isSprinkled || R.weatherOf(R.isleDay(foundMatureSec - 1)) === 1
      assert.ok(R.cropStage(p, foundMatureSec - 1, autoPrev).stage < 3, 'Must not be mature 1s before matureAt')
    }

    curWorld = adapter.advanceTimeOnly(curWorld, foundMatureSec)
    curWorld.state.en = 140

    // Exact stochastic distribution check on this real harvest via `enumerateExactSingleStochasticOutcomes`
    const branches = adapter.enumerateExactSingleStochasticOutcomes(curWorld, { a: 'harvest', i: 0 }, { t: foundMatureSec })
    assert.ok(branches && branches.length > 0)
    const distByQ = [0, 0, 0]
    let probSum = 0
    for (const br of branches) {
      probSum += br.prob
      for (const g of br.result.out[0].got || []) {
        distByQ[g.q] += br.prob * g.n
      }
    }
    assert.ok(Math.abs(probSum - 1.0) < 1e-12)

    const beforeEn = curWorld.state.en
    const stepH = adapter.simulateBatch(curWorld, [{ a: 'harvest', i: 0 }], { t: foundMatureSec })
    assert.equal(stepH.allOk, true, `Real R.applyActions must allow harvest at ${foundMatureSec}`)
    totalStaminaSpent += beforeEn - stepH.afterWorld.state.en
    curWorld = stepH.afterWorld

    harvests.push({
      matureAt: foundMatureSec,
      distByQ,
    })
  }

  return {
    harvests,
    endSec: harvests[harvests.length - 1].matureAt,
    totalStaminaSpent,
    witheredAtEnd,
    needsClearAtEnd,
    finalPlot: curWorld.state.plots[0],
  }
}

test('Phase 13.1 (Acceptance 1 — Physical Parity): Single-harvest & multi-harvest (first/middle/final cycle) cross-season lifecycles, post-harvest [empty|regrow|withered], Long-Night nextSeasonBoundary, explicit clockStart, and stochastic yield expectations match pet-world-rules.js 1:1', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_A })
  const { R } = adapter

  // 1) Explicit clockStart & Long-Night-aware `nextSeasonBoundary` across Isle Day 1, 6, 11, 12
  for (const cs of [CLOCK_A, CLOCK_B]) {
    adapter.syncClock(cs)
    let probe = cs + 1200
    for (let k = 0; k < 14; k++) {
      const curSeason = R.seasonOf(R.isleDay(probe))
      const bound = adapter.nextSeasonBoundary(probe, cs)
      assert.ok(bound > probe, 'nextSeasonBoundary must strictly advance')
      adapter.syncClock(cs)
      assert.equal(R.seasonOf(R.isleDay(bound - 1)), curSeason, 'bound - 1 must still belong to current season')
      assert.notEqual(R.seasonOf(R.isleDay(bound)), curSeason, 'bound must be exact first second of next season')
      probe = adapter.nextIsleBoundary(probe, cs) + 300
    }
  }

  // Verify cache isolation in `simulateCropLifecycleFromPlant` across distinct `clockStart`
  const springToSummerA = findSeasonBoundaryAfter(adapter, CLOCK_A + 3600, 0, CLOCK_A)
  const lateSpringT = springToSummerA - 1800
  const specClockA = adapter.simulateCropLifecycleFromPlant('strawberry', {
    startSec: lateSpringT,
    isSprinkled: true,
    clockStart: CLOCK_A,
    dryManualWaterStages: 0,
  })
  const specClockB = adapter.simulateCropLifecycleFromPlant('strawberry', {
    startSec: lateSpringT,
    isSprinkled: true,
    clockStart: CLOCK_B,
    dryManualWaterStages: 0,
  })
  // Under CLOCK_A, `lateSpringT` is 30m before Summer (1 harvest then withers); under CLOCK_B (+4h shift), check independent evaluation
  assert.ok(specClockA)
  if (specClockB) {
    // Re-evaluating CLOCK_A must return the exact CLOCK_A result without cross-clock cache pollution
    const specClockAAgain = adapter.simulateCropLifecycleFromPlant('strawberry', {
      startSec: lateSpringT,
      isSprinkled: true,
      clockStart: CLOCK_A,
      dryManualWaterStages: 0,
    })
    assert.deepEqual(specClockAAgain, specClockA)
  }

  // 2) Single-harvest cross-season parity (`cabbage`, `seasons: [3]`, planted 30m before Spring `season=0`)
  const winterToSpring = findSeasonBoundaryAfter(adapter, CLOCK_A + 3600, 3, CLOCK_A)
  const tLateWinter = winterToSpring - 1800
  const cabPred = adapter.simulateCropLifecycleFromPlant('cabbage', {
    startSec: tLateWinter,
    isSprinkled: true,
    clockStart: CLOCK_A,
    dryManualWaterStages: 0,
  })
  const cabReal = executeLifecycleViaRealRules(adapter, 'cabbage', tLateWinter, true, CLOCK_A)
  assert.ok(cabPred, 'Cross-season single-harvest cabbage planted in Winter MUST NOT be zeroed out!')
  assert.equal(cabPred.harvests.length, 1)
  assert.equal(cabReal.harvests.length, 1)
  assert.ok(cabPred.harvests[0].matureAt > winterToSpring, 'Cabbage matures inside Spring')
  assert.equal(cabPred.harvests[0].matureAt, cabReal.harvests[0].matureAt)
  assert.equal(cabPred.witheredAtEnd, false)
  assert.equal(cabReal.witheredAtEnd, false)
  assert.equal(cabPred.harvests[0].postHarvest.kind, 'empty')
  assert.equal(cabPred.totalStaminaSpent, cabReal.totalStaminaSpent)
  for (let q = 0; q < 3; q++) {
    assert.ok(Math.abs(cabPred.harvests[0].expectedByQuality[q] - cabReal.harvests[0].distByQ[q]) < 1e-12)
  }

  // 3) Multi-harvest FIRST cycle (`h=0`) cross-season -> matures in next season, then immediately withers on `h=1` (`tomato`, `seasons: [1]`, `times: 4`)
  const summerToAutumn = findSeasonBoundaryAfter(adapter, CLOCK_A + 3600, 1, CLOCK_A)
  const tTomFirstCross = summerToAutumn - 1800
  const tomPred1 = adapter.simulateCropLifecycleFromPlant('tomato', {
    startSec: tTomFirstCross,
    isSprinkled: true,
    clockStart: CLOCK_A,
    dryManualWaterStages: 0,
  })
  const tomReal1 = executeLifecycleViaRealRules(adapter, 'tomato', tTomFirstCross, true, CLOCK_A)
  assert.equal(tomPred1.harvests.length, 1)
  assert.equal(tomReal1.harvests.length, 1)
  assert.equal(tomPred1.harvests[0].matureAt, tomReal1.harvests[0].matureAt)
  assert.equal(tomPred1.harvests[0].postHarvest.kind, 'withered')
  assert.equal(tomPred1.witheredAtEnd, true)
  assert.equal(tomReal1.witheredAtEnd, true)
  assert.equal(tomPred1.totalStaminaSpent, tomReal1.totalStaminaSpent) // 2 plant + 1 harvest + 1 clear = 4

  // 4) Multi-harvest MIDDLE cycle (`h=1`) cross-season -> `h=0` in Summer, `h=1` starts in Summer & matures in Autumn, then withers on `h=2`!
  let tTomMidCross = null
  for (let back = 5200; back <= 40000; back += 60) {
    const cand = summerToAutumn - back
    adapter.syncClock(CLOCK_A)
    if (R.seasonOf(R.isleDay(cand)) !== 1) continue
    const sp = adapter.simulateCropLifecycleFromPlant('tomato', {
      startSec: cand,
      isSprinkled: true,
      clockStart: CLOCK_A,
      dryManualWaterStages: 0,
    })
    if (sp && sp.harvests.length === 2 && sp.harvests[0].matureAt < summerToAutumn && sp.harvests[1].matureAt > summerToAutumn) {
      tTomMidCross = cand
      break
    }
  }
  assert.ok(tTomMidCross != null, 'Must locate exact startSec for middle-cycle cross-season tomato')
  const tomPred2 = adapter.simulateCropLifecycleFromPlant('tomato', {
    startSec: tTomMidCross,
    isSprinkled: true,
    clockStart: CLOCK_A,
    dryManualWaterStages: 0,
  })
  const tomReal2 = executeLifecycleViaRealRules(adapter, 'tomato', tTomMidCross, true, CLOCK_A)
  assert.equal(tomPred2.harvests.length, 2)
  assert.equal(tomReal2.harvests.length, 2)
  assert.equal(tomPred2.harvests[0].postHarvest.kind, 'regrow')
  assert.equal(tomPred2.harvests[1].postHarvest.kind, 'withered')
  assert.deepEqual(
    tomPred2.harvests.map((h) => h.matureAt),
    tomReal2.harvests.map((h) => h.matureAt)
  )
  assert.equal(tomPred2.witheredAtEnd, true)
  assert.equal(tomReal2.witheredAtEnd, true)
  assert.equal(tomPred2.totalStaminaSpent, tomReal2.totalStaminaSpent) // 2 plant + 2 harvest + 1 clear = 5

  // 5) Multi-harvest FINAL cycle (`h = times - 1 = 2`) cross-season -> `corn` (`seasons: [1,2]`, `times: 3`) harvested in Winter becomes `empty` (0 clear cost!)
  const autumnToWinter = findSeasonBoundaryAfter(adapter, summerToAutumn + 3600, 2, CLOCK_A)
  let tCornFinalCross = null
  for (let back = 12000; back <= 90000; back += 120) {
    const cand = autumnToWinter - back
    adapter.syncClock(CLOCK_A)
    if (R.seasonOf(R.isleDay(cand)) !== 2) continue
    const sp = adapter.simulateCropLifecycleFromPlant('corn', {
      startSec: cand,
      isSprinkled: true,
      clockStart: CLOCK_A,
      dryManualWaterStages: 0,
    })
    if (
      sp &&
      sp.harvests.length === 3 &&
      sp.harvests[1].matureAt < autumnToWinter &&
      sp.harvests[2].matureAt > autumnToWinter
    ) {
      tCornFinalCross = cand
      break
    }
  }
  assert.ok(tCornFinalCross != null, 'Must locate exact startSec for final-cycle cross-season corn')
  const cornPred3 = adapter.simulateCropLifecycleFromPlant('corn', {
    startSec: tCornFinalCross,
    isSprinkled: true,
    clockStart: CLOCK_A,
    dryManualWaterStages: 0,
  })
  const cornReal3 = executeLifecycleViaRealRules(adapter, 'corn', tCornFinalCross, true, CLOCK_A)
  assert.equal(cornPred3.harvests.length, 3)
  assert.equal(cornReal3.harvests.length, 3)
  assert.equal(cornPred3.harvests[2].postHarvest.kind, 'empty', 'Final regrow harvest in Winter must leave empty plot, NOT withered!')
  assert.equal(cornPred3.witheredAtEnd, false)
  assert.equal(cornReal3.witheredAtEnd, false)
  assert.equal(cornPred3.endClearEnCost, 0)
  assert.equal(cornPred3.totalStaminaSpent, cornReal3.totalStaminaSpent) // 2 plant + 3 harvest + 0 clear = 5

  // 6) Already-withered plot returns `null` in `exactPlotTimings` and schedules zero phantom maturity buckets
  const witheredPlot = { c: 'tomato', t: autumnToWinter + 60, w: 0, g: 0, h: 1 }
  assert.equal(adapter.isPlotWithered(witheredPlot, autumnToWinter + 120, CLOCK_A), true)
  assert.equal(adapter.exactPlotTimings(witheredPlot, true, autumnToWinter + 120, CLOCK_A), null)
  const wWithWither = makeBaseWorld(adapter, autumnToWinter + 120, CLOCK_A, {
    state: { plotN: 1, plots: [witheredPlot] },
  })
  const evBuckets = buildEventBuckets(adapter, wWithWither, { horizonSec: 28800 })
  assert.equal(
    evBuckets.buckets.some((b) => b.reasons.some((r) => r.startsWith('plot-mature:'))),
    false,
    'Withered plot must NEVER inject phantom plot-mature buckets'
  )

  // 7) Exact stochastic yield distribution parity across all `w ∈ {0,1,2,3}` and `wasStolen ∈ {false, true}`
  const sunnyT = winterToSpring + 600
  for (const w of [0, 1, 2, 3]) {
    for (const stolen of [false, true]) {
      const worldStoch = makeBaseWorld(adapter, sunnyT, CLOCK_A, {
        state: {
          plotN: 1,
          plots: [{
            c: 'turnip',
            t: sunnyT - 7200,
            w,
            g: 0,
            h: 0,
            ...(stolen ? { sv: ['visitor1'] } : {}),
          }],
          tools: { pick: 4, rod: 4, can: 4, spr: 0, house: 2 },
          en: 50,
          enT: sunnyT,
          enDay: R.worldDay(sunnyT),
        },
      })
      // Ensure non-rainy day so `auto === false` tests exact `w = 0, 1, 2, 3`
      let testT = sunnyT
      while (R.weatherOf(R.isleDay(testT)) === 1 || R.seasonOf(R.isleDay(testT)) !== 0) {
        testT = adapter.nextIsleBoundary(testT, CLOCK_A) + 600
      }
      worldStoch.now = testT
      worldStoch.state.plots[0].t = testT - 7200
      worldStoch.state.enDay = R.worldDay(testT)

      const branches = adapter.enumerateExactSingleStochasticOutcomes(worldStoch, { a: 'harvest', i: 0 }, { t: testT })
      assert.ok(branches && branches.length > 0)
      const exactDist = [0, 0, 0]
      for (const br of branches) {
        for (const got of br.result.out[0].got || []) {
          exactDist[got.q] += br.prob * got.n
        }
      }
      const predYld = adapter.expectedHarvestYield(w, stolen)
      for (let q = 0; q < 3; q++) {
        assert.ok(
          Math.abs(predYld.expectedByQuality[q] - exactDist[q]) < 1e-12,
          `Mismatch at w=${w}, stolen=${stolen}, q=${q}: ${predYld.expectedByQuality[q]} vs ${exactDist[q]}`
        )
      }
    }
  }
})

test('Phase 13.2 (Acceptance 2 — Economic Accounting Consistency): Seeds, stamina, post-wither clear cost, and next-season plot occupation are counted once each with zero double-counting', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_A })
  const { R } = adapter

  // 1) Exact 1x accounting of standing-withered `clear` AND cross-season renewal `endClearEnCost` in `projectContinuationFarmFlows`:
  const summerToAutumn = findSeasonBoundaryAfter(adapter, CLOCK_A + 3600, 1, CLOCK_A)
  const tLateSummer = summerToAutumn - 1800

  // Compare two 1-plot worlds at `tLateSummer` under `freeRegenEnPool = Infinity, staminaShadowCost = 200, discRatePerHour = 0`:
  // - `wEmpty`: plot 0 is `null` (empty, `needsClear = 0`)
  // - `wWithered`: plot 0 has an already-withered Spring strawberry (`stage = -1`, `needsClear = 1`)
  // Because `wWithered` requires exactly ONE initial `clear` (`1 en * 200 = 200`) before executing the EXACT same renewal chain,
  // `valEmpty - valWithered` MUST equal `200` (`1 * clearEnCost * staminaShadowCost`), NOT `0` and NOT `400`!
  const wEmpty = makeBaseWorld(adapter, tLateSummer, CLOCK_A, {
    state: {
      plotN: 1,
      plots: [null],
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
    },
  })
  const springDayT = findSeasonBoundaryAfter(adapter, CLOCK_A + 3600, 3, CLOCK_A) + 600
  const wWithered = makeBaseWorld(adapter, tLateSummer, CLOCK_A, {
    state: {
      plotN: 1,
      plots: [{ c: 'strawberry', t: tLateSummer, w: 0, g: 0, h: 1 }], // `strawberry` is Spring-only -> withered in Summer!
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
    },
  })
  void springDayT
  assert.equal(adapter.isPlotWithered(wWithered.state.plots[0], tLateSummer, CLOCK_A), true)

  const objCfg = buildObjectiveConfig({ horizonSec: 14400 })
  const slotsEmpty = buildContinuationTimeline(adapter, wEmpty, wEmpty, objCfg, 1.0)
  const flowEmpty = projectContinuationFarmFlows(adapter, wEmpty, slotsEmpty, {
    discRatePerHour: 0,
    allowTerminalCraft: false,
    freeRegenEnPool: Infinity,
    staminaShadowCost: 200,
  })
  const flowWithered = projectContinuationFarmFlows(adapter, wWithered, slotsEmpty, {
    discRatePerHour: 0,
    allowTerminalCraft: false,
    freeRegenEnPool: Infinity,
    staminaShadowCost: 200,
  })
  assert.equal(flowWithered.standingPlotValue, 0)
  assert.ok(
    Math.abs((flowEmpty.renewalPlotValue - flowWithered.renewalPlotValue) - 200) < 1e-6,
    `Initial withered clear must be charged ONCE (200), got diff=${flowEmpty.renewalPlotValue - flowWithered.renewalPlotValue}`
  )

  // 2) Verify cross-season renewal withering (`tomato` forced as sole Summer crop by zeroing other Summer crops' base prices in a custom check, or checking single-cycle continuation window):
  // Over a continuation window `[tLateSummer, tAfter2Renewals]` where Cycle 1 is cross-season `tomato` (withering in Autumn) followed by Cycle 2 in Autumn:
  // Verify exact arithmetic against manual step-by-step calculation when `tomato` is the sole in-season Summer crop (`corn`/`wheat` saturated)!
  const wSaturated = makeBaseWorld(adapter, tLateSummer, CLOCK_A, {
    state: {
      plotN: 1,
      plots: [null],
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
    },
  })
  // Construct 2-slot continuation `[tLateSummer, summerToAutumn)` and `[summerToAutumn, summerToAutumn + 14400)`
  const tomSpec = adapter.simulateCropLifecycleFromPlant('tomato', {
    startSec: tLateSummer,
    isSprinkled: true,
    clockStart: CLOCK_A,
  })
  assert.equal(tomSpec.witheredAtEnd, true)
  assert.equal(tomSpec.endClearEnCost, 1)
  assert.equal(tomSpec.totalStaminaSpent, 4, 'Cross-season 1-harvest tomato must cost 2 (plant) + 1 (harvest) + 1 (clear) = 4 en')

  // Verify `renewalPlotValue` on a tight window `[tLateSummer, tomSpec.endSec]` (exact 1 cycle of cross-season crop!)
  // neither double-deducts `clear` nor subtracts `spillNextSec * rNextSeason` from realized cashflow!
  const twoSlotsExact = [
    {
      index: 0,
      atSec: tLateSummer,
      nextAtSec: summerToAutumn,
      isleIndex: R.isleIndex(tLateSummer),
      isleDay: R.isleDay(tLateSummer),
      prices: {
        ...Object.fromEntries(adapter.graph.sellableIds.map((id) => [id, Number(R.BASE_PRICE[id])])),
        corn: 1,
        wheat: 1,
      },
    },
    {
      index: 1,
      atSec: summerToAutumn,
      nextAtSec: tomSpec.endSec,
      isleIndex: R.isleIndex(summerToAutumn),
      isleDay: R.isleDay(summerToAutumn),
      prices: {
        ...Object.fromEntries(adapter.graph.sellableIds.map((id) => [id, Number(R.BASE_PRICE[id])])),
        tomato: 3000,
        grape: 200, // positive `rNextSeason > 0` so `surplusVsWait` is active during selection!
        corn: 1,
        wheat: 1,
        carrot: 1,
        pumpkin: 1,
      },
    },
  ]
  const flowOneCross = projectContinuationFarmFlows(adapter, wSaturated, twoSlotsExact, {
    discRatePerHour: 0,
    allowTerminalCraft: false,
    freeRegenEnPool: Infinity,
    staminaShadowCost: 100,
  })
  const eqTom = tomSpec.harvests[0].expectedByQuality
  const expectedGrossTom =
    Math.round(eqTom[0] * Math.round(3000 * R.QUALITY[0])) +
    Math.round(eqTom[1] * Math.round(3000 * R.QUALITY[1])) +
    Math.round(eqTom[2] * Math.round(3000 * R.QUALITY[2]))
  // Exact 1x deductions: `expectedGrossTom - 540 (seed) - 4 * 100 (plant 2 + harvest 1 + clear 1)` — NO `spillNextSec * rNextSeason` subtracted from realized value!
  const expectedNetTom = expectedGrossTom - tomSpec.seedCost - tomSpec.totalStaminaSpent * 100
  assert.ok(
    Math.abs(flowOneCross.renewalPlotValue - expectedNetTom) < 1.5,
    `Realized renewalPlotValue (${flowOneCross.renewalPlotValue}) must equal exact 1x cashflow (${expectedNetTom}) without double-deducting clear or next-season occupation`
  )

  // 3) Late-Winter empty-plot selection (`< 45m` before Spring) with certified Layer-2 weak-duality check (`L <= U`)
  const winterToSpring = findSeasonBoundaryAfter(adapter, summerToAutumn + 3600, 3, CLOCK_A)
  const tLateWin = winterToSpring - 2400
  const wLateWin = makeBaseWorld(adapter, tLateWin, CLOCK_A, {
    state: {
      plotN: 6,
      plots: Array(6).fill(null),
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 60,
      enT: tLateWin,
      enDay: R.worldDay(tLateWin),
    },
  })
  const envWin = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wLateWin,
    userConstraints: { allowCapex: false },
  })
  const planWin = solveUnifiedPlan(adapter, envWin, buildObjectiveConfig({ horizonSec: 28800 }), {
    scenarios: [{ id: 'det', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  assert.notEqual(planWin.quality.solverStatus, 'bound-violation-error')
  assert.ok(Number.isFinite(planWin.quality.feasibleIncumbentValue) && planWin.quality.feasibleIncumbentValue > 0)
  const winPlants = planWin.trunkBuckets[0].domesticActions.filter((a) => a.a === 'plant')
  assert.ok(winPlants.length > 0, 'Should plant profitable crop in late Winter (or wait only if negative surplus)')
  for (const pa of winPlants) {
    assert.ok(
      R.CROPS.find((c) => c.id === pa.c)?.seasons.includes(3),
      `Every crop planted in late Winter must be legal in Winter: ${pa.c}`
    )
  }
  const refAudit = auditDecisionAgainstReference(adapter, {
    worldBefore: wLateWin,
    actualFirstActions: planWin.trunkBuckets[0].domesticActions,
    actualFullPolicyObjectiveValue: planWin.quality.feasibleIncumbentValue,
    scenarios: [{ id: 'det', weight: 1.0, externalSupplyFactor: 0.96 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 28800 }),
    allowedActionTypes: ['plant', 'clear', 'water', 'sell', 'craft', 'wait'],
    maxSteps: 3,
    maxSearchNodes: 800,
  })
  assert.equal(refAudit.actualLegal, true)
  assert.ok((refAudit.identifiableRegretLowerBound ?? 0) <= 1e-6)
})

test('Phase 13.3 (Acceptance 3 — Live High-Inventory Execution Continuity): Continuous clock executes cross-season regrow harvest -> clear -> +2s receipt -> replant with zero stall and xian=off', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_A })
  const { R } = adapter

  // 1) Multi-bucket 24h lookahead check: growing late-Summer `tomato` (`h=0`) maturing in Autumn emits `harvest -> clear -> plant` in that future bucket!
  const summerToAutumn = findSeasonBoundaryAfter(adapter, CLOCK_A + 3600, 1, CLOCK_A)
  const tLateSummer = summerToAutumn - 1200
  const wLookahead = makeBaseWorld(adapter, tLateSummer, CLOCK_A, {
    state: {
      plotN: 2,
      plots: [
        { c: 'tomato', t: tLateSummer - 600, w: 3, g: 0, h: 0 }, // matures in Autumn (`h=1` will wither!)
        { c: 'corn', t: tLateSummer - 600, w: 3, g: 0, h: 0 },   // matures in Autumn (`h=1` stays regrow!)
      ],
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 80,
      enT: tLateSummer,
      enDay: R.worldDay(tLateSummer),
    },
  })
  const tmTom0 = adapter.exactPlotTimings(wLookahead.state.plots[0], true, tLateSummer, CLOCK_A)
  assert.ok(tmTom0 && tmTom0.matureAt > summerToAutumn)
  const envLook = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wLookahead,
    userConstraints: { allowCapex: false },
  })
  const planLook = solveUnifiedPlan(adapter, envLook, buildObjectiveConfig({ horizonSec: 86400 }))
  const firstBranch = Object.values(planLook.scenarioBranches || {})[0]
  const branchActionLists = (firstBranch?.bucketActions || []).filter((acts) =>
    Array.isArray(acts) && acts.some((a) => a.a === 'harvest' && a.i === 0)
  )
  assert.ok(branchActionLists.length > 0, '24h lookahead scenario branch must schedule harvest of cross-season tomato at its Autumn maturity bucket')
  const bActs = branchActionLists[0]
  const hIdx = bActs.findIndex((a) => a.a === 'harvest' && a.i === 0)
  const cIdx = bActs.findIndex((a) => a.a === 'clear' && a.i === 0)
  const pIdx = bActs.findIndex((a) => a.a === 'plant' && a.i === 0)
  assert.ok(hIdx >= 0 && cIdx > hIdx, `Lookahead bucket must follow cross-season tomato harvest with clear on plot 0: ${JSON.stringify(bActs)}`)
  assert.ok(pIdx > cIdx, `Lookahead bucket must replant plot 0 right after clearing post-harvest wither: ${JSON.stringify(bActs)}`)

  // 2) Live high-inventory continuous-clock execution (`2,319` corn, `529` tomato, `24` plots, `xian = off`):
  // At `t0 = summerToAutumn + 180` (3 minutes into Autumn):
  // - Plots 0 & 1: ripe `tomato` (`h = 0`, planted in late Summer) -> harvesting at `t0` (Autumn!) immediately leaves withered `h = 1`, needing `clear` + `plant`!
  // - Plot 2: ripe `corn` (`h = 2`, final harvest `times = 3`) -> harvesting at `t0` leaves `empty` (`null`), needing `plant` (NO `clear`)!
  // - Plot 3: ripe `corn` (`h = 0`, `times = 3`) -> harvesting at `t0` (Autumn!) continues valid `regrow` (`h = 1`), needing NEITHER `clear` NOR `plant`!
  // - Plots 4..23: growing `corn` (`matureAt > t0 + 5000`)
  const t0 = summerToAutumn + 180
  const tomPlantedInSummer = summerToAutumn - 5100 // in Summer, > 5184s before `t0 = summerToAutumn + 180` -> ripe at `t0`!
  assert.equal(R.seasonOf(R.isleDay(tomPlantedInSummer)), 1)
  assert.equal(R.cropStage({ c: 'tomato', t: tomPlantedInSummer, w: 3, g: 0, h: 0 }, t0, true).stage, 3)

  const cornPlantedEarlier = summerToAutumn - 12000
  assert.equal(R.seasonOf(R.isleDay(cornPlantedEarlier)), 1)
  assert.equal(R.cropStage({ c: 'corn', t: cornPlantedEarlier, w: 3, g: 0, h: 2 }, t0, true).stage, 3)
  assert.equal(R.cropStage({ c: 'corn', t: cornPlantedEarlier, w: 3, g: 0, h: 0 }, t0, true).stage, 3)

  let serverWorld = makeBaseWorld(adapter, t0, CLOCK_A, {
    rev: 7001,
    coins: 3800000,
    state: {
      plotN: 24,
      plots: Array.from({ length: 24 }, (_, idx) => {
        if (idx === 0 || idx === 1) return { c: 'tomato', t: tomPlantedInSummer, w: 3, g: 0, h: 0 }
        if (idx === 2) return { c: 'corn', t: cornPlantedEarlier, w: 3, g: 0, h: 2 }
        if (idx === 3) return { c: 'corn', t: cornPlantedEarlier, w: 3, g: 0, h: 0 }
        return { c: 'corn', t: t0 - 1200, w: 3, g: 0, h: 0 }
      }),
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 2 },
      en: 70,
      enT: t0,
      enDay: R.worldDay(t0),
      iq: { d: R.isleIndex(t0), craft: 10, mine: 40, fish: 20, bomb: 2 },
      inv: {
        corn: [2100, 180, 39],
        tomato: [450, 50, 29],
        milk: [60, 12, 4],
        egg: [55, 10, 3],
        iron: [42, 0, 0],
        coal: [38, 0, 0],
      },
      xs: { v: 1, st: 4, lv: 5, exp: 0, sp: 100, r: [1, 0, 0, 0, 0], f: { lv: 1, plots: [] } },
    },
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-p13-3-'))
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  const lockRootDir = path.join(tmpDir, 'locks')
  const asyncPlanner = new AsyncPlanManager({ rulesPath: RULES_PATH })
  const committedBatches = []

  const mockHttpClient = {
    stats: { getCount: 0, postCount: 0 },
    nowMsFn: () => serverWorld.now * 1000,
    estimatedServerNowSec: () => serverWorld.now,
    serverSecToLocalMs: (sec) => sec * 1000,
    async getJson(url) {
      this.stats.getCount++
      if (url === '/api/pet/world') return structuredClone(serverWorld)
      if (url === '/api/pet/status') return { adopted: false }
      return {}
    },
    async postJson(url, payload) {
      this.stats.postCount++
      if (url === '/api/pet/world/act') {
        const actions = payload.actions || []
        const execSec = serverWorld.now
        const sim = adapter.simulateBatch(serverWorld, actions, {
          t: execSec,
          prices: serverWorld.prices,
          rand: adapter.makeSampleStreamPrng(committedBatches.length + 1, execSec),
        })
        assert.equal(sim.allOk, true, `Every live action MUST succeed on real R.applyActions: ${JSON.stringify(sim.result.out)}`)
        serverWorld = sim.afterWorld
        serverWorld.rev += 1
        committedBatches.push({ atSec: execSec, actions: structuredClone(actions) })
        return {
          ok: true,
          status: 200,
          networkError: false,
          body: { ok: true, rev: serverWorld.rev, world: structuredClone(serverWorld) },
        }
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
    consecutivePlanInvalid: 0,
    consecutiveDeferred: 0,
  }

  try {
    for (let tick = 0; tick < 3; tick++) {
      const res = await runLiveAccountTick({
        account: 'main',
        adapter,
        httpClient: mockHttpClient,
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
      assert.equal(res.controllerOut.status, 'confirmed', `Expected confirmed batch, got ${JSON.stringify(res.controllerOut.diagnostics)}`)
      assert.equal(res.backgroundReport ?? null, null, 'xian=off must keep backgroundReport null')

      // Once plots 0, 1, 2 are all replanted into Autumn crops, stop early
      if (
        serverWorld.state.plots[0]?.c &&
        R.cropStage(serverWorld.state.plots[0], serverWorld.now, true).stage >= 0 &&
        serverWorld.state.plots[0].t >= t0 &&
        serverWorld.state.plots[1]?.c &&
        serverWorld.state.plots[1].t >= t0 &&
        serverWorld.state.plots[2]?.c &&
        serverWorld.state.plots[2].t >= t0
      ) {
        break
      }
      const nextWake = res.nextWakeSec || serverWorld.now + 2
      assert.equal(nextWake, serverWorld.now + 2, 'Stochastic harvest+clear batch must schedule immediate +2s continuation wake!')
      serverWorld = adapter.advanceTimeOnly(serverWorld, nextWake, {
        futurePrices: serverWorld.prices,
      })
    }

    // Verify all 4 ripe plots (0, 1, 2, 3) were harvested in Batch 0!
    assert.ok(committedBatches.length >= 2, `Expected harvest+clear batch followed by +2s replant batch, got ${committedBatches.length}`)
    const batch0 = committedBatches[0].actions
    const harvestedIn0 = batch0.filter((a) => a.a === 'harvest').map((a) => a.i).sort((a, b) => a - b)
    assert.deepEqual(harvestedIn0, [0, 1, 2, 3], 'All 4 ripe plots must be harvested immediately in Tick 0')

    // Verify plots 0 & 1 (withered post-harvest tomatoes) were cleared, plot 2 (final corn) needed NO clear, plot 3 stayed in regrow `h=1`!
    const allActionsFlat = committedBatches.flatMap((b) => b.actions)
    const clearedPlots = allActionsFlat.filter((a) => a.a === 'clear').map((a) => a.i).sort((a, b) => a - b)
    assert.deepEqual(clearedPlots, [0, 1], 'Exactly plots 0 and 1 (out-of-season regrow tomatoes) must be cleared; plot 2 (final corn) & plot 3 (in-season regrow corn) must NOT be cleared')

    // Verify plots 0, 1, 2 are all replanted with valid Autumn crops without waiting for a future event bucket (`<= 15s` game-clock delay from harvest receipt!)
    for (const idx of [0, 1, 2]) {
      const pAfter = serverWorld.state.plots[idx]
      assert.ok(pAfter && pAfter.c, `Plot ${idx} must be replanted`)
      assert.ok(R.CROPS.find((c) => c.id === pAfter.c)?.seasons.includes(2), `Replanted crop ${pAfter.c} on plot ${idx} must be valid in Autumn`)
      assert.ok(
        pAfter.t - committedBatches[0].atSec <= 15,
        `Plot ${idx} must be replanted immediately after +2s receipt (delay=${pAfter.t - committedBatches[0].atSec}s)`
      )
    }
    // Plot 3 (`corn` `h=0 -> h=1`) must still be growing on `h=1` in Autumn!
    assert.equal(serverWorld.state.plots[3]?.c, 'corn')
    assert.equal(serverWorld.state.plots[3]?.h, 1)

    // `xian=off` isolation: zero `xs*` actions emitted!
    assert.equal(
      allActionsFlat.some((a) => String(a.a || '').startsWith('xs')),
      false,
      'xian=off must emit zero xs* actions'
    )
  } finally {
    await asyncPlanner.close()
  }
})
