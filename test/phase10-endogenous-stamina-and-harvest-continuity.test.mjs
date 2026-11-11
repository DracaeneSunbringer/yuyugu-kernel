import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import {
  buildContinuationTimeline,
  buildObjectiveConfig,
  projectContinuationFarmFlows,
} from '../model/objective.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { AsyncPlanManager, PlanCache, buildNeighborSignature } from '../execution/async-planner.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeBaseWorld(adapter, nowSec, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plotN = 24
  s.plots = Array(24).fill(null)
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 1 }
  s.mine = { max: 30 }
  s.en = 80
  s.enT = nowSec
  s.enDay = adapter.R.worldDay(nowSec)
  s.iq = { d: adapter.R.isleIndex(nowSec), craft: 0, mine: 0, fish: 0, bomb: 0 }
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(adapter.R.BASE_PRICE[id])
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 1,
    coins: 200000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

test('Phase 10.1: Static source audit confirms 100% removal of local band-aids and magic thresholds', () => {
  const solveSrc = fs.readFileSync(path.join(ROOT_DIR, 'planner/solve.mjs'), 'utf8')
  const resSrc = fs.readFileSync(path.join(ROOT_DIR, 'planner/resources.mjs'), 'utf8')
  const objSrc = fs.readFileSync(path.join(ROOT_DIR, 'model/objective.mjs'), 'utf8')

  assert.equal(solveSrc.includes('capWithIsleWindow'), false, 'capWithIsleWindow gate must be completely removed')
  assert.equal(solveSrc.includes("candActs[0].k === 'house'"), false, 'upgrade(house) state-tampering hack must be removed')
  assert.equal(solveSrc.includes('chunkCount = 4'), false, '4-chunk background farm heuristic must be removed')
  assert.equal(resSrc.includes('pre-isle-regen-flush'), false, '5400/-60 magic flush bucket must be removed')
  assert.equal(resSrc.includes('long-night-mid-regen'), false, '5*3600 magic midpoint bucket must be removed')
  assert.equal(objSrc.includes('horizonSec < 2 * 14400'), false, '8h continuationIsleDays cliff must be removed')
  assert.equal(objSrc.includes('sameIsleDay ? 0'), false, 'sameIsleDay continuation collapse must be removed')
})

test('Phase 10.2: Cures secondary domestic low-stamina (en=0..1) manual-water starvation & empty-plot deadlock', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R } = adapter

  // Pick a sunny Summer isle day (`weather !== 1`) so plots 16..23 (`spr=2` covers 0..15) need manual water
  let t0 = 1794340000
  for (let step = 0; step < 500; step++, t0 += 14400) {
    const iDay = R.isleDay(t0)
    if (R.seasonOf(iDay) === 1 && R.weatherOf(iDay) !== 1 && adapter.nextIsleBoundary(t0, CLOCK_START) - t0 > 7200) {
      break
    }
  }

  const plots = Array.from({ length: 24 }, (_, idx) => {
    if (idx === 0 || idx === 13 || idx === 14) return null // 3 empty plots
    if (idx === 23) return { c: 'corn', t: t0 - 86400, w: 2, g: 0, h: 3 } // ripe final harvest (`h=3` on `times=4` frees plot 23!)
    if (idx === 16) return { c: 'corn', t: t0 - 600, w: 0, g: 0, h: 0 } // unwatered growing plot (non-expiring stage)
    return { c: 'corn', t: t0 - 600, w: 3, g: 0, h: 0 }
  })

  // Case A: `eat`/`coffee` disabled at `en = 1` -> MUST harvest ripe plot 23 instead of watering plot 16!
  const worldEn1WithRipe = makeBaseWorld(adapter, t0, {
    coins: 50000,
    state: {
      plotN: 24,
      plots: structuredClone(plots),
      tools: { pick: 4, rod: 4, can: 4, spr: 2, house: 1 },
      en: 1,
      enT: t0,
      iq: { d: R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10 },
      inv: { tomato: [0, 0, 89] },
    },
  })
  const envNoTopUp = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: worldEn1WithRipe,
    userConstraints: { allowCapex: false },
  })
  const planHarvestFirst = solveUnifiedPlan(adapter, envNoTopUp, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['harvest', 'plant', 'water', 'clear', 'wait'],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const actsA = planHarvestFirst.trunkBuckets[0]?.domesticActions || []
  assert.deepEqual(
    actsA,
    [{ a: 'harvest', i: 23 }],
    'At en=1 without top-up, ripe harvest(23) MUST strictly preempt manual water(16)'
  )

  // Case B: After harvest(23), when `en` regenerates back to `1` (`enT = t0 + 180`), empty plots need `2 en` to plant:
  // planner MUST NOT waste `1 en` on non-expiring `water(16)`, and MUST wake at exact `en = 2` (`t0 + 360`)!
  const plotsAfterHarvest = structuredClone(plots)
  plotsAfterHarvest[23] = null
  const worldEn1EmptyPlots = makeBaseWorld(adapter, t0 + 180, {
    coins: 50000,
    state: {
      plotN: 24,
      plots: plotsAfterHarvest,
      tools: { pick: 4, rod: 4, can: 4, spr: 2, house: 1 },
      en: 1,
      enT: t0 + 180,
      iq: { d: R.isleIndex(t0 + 180), craft: 80, mine: 100, fish: 80, bomb: 10 },
    },
  })
  const envWaitPlant = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: worldEn1EmptyPlots,
    userConstraints: { allowCapex: false },
  })
  const planHoldForPlant = solveUnifiedPlan(adapter, envWaitPlant, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['harvest', 'plant', 'water', 'clear', 'wait'],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const actsB = planHoldForPlant.trunkBuckets[0]?.domesticActions || []
  assert.equal(
    actsB.filter((a) => a.a === 'water').length,
    0,
    'Non-expiring manual water MUST NOT steal en=1 when profitable empty plots are waiting for en=2 to plant!'
  )
  assert.equal(
    planHoldForPlant.nextWakeSec,
    t0 + 360,
    'nextWakeSec MUST wake on the exact second passive regen reaches minActionableEn=2 for plant'
  )

  // Case C: With `eat` enabled on `secondary` (`en = 0`, `mine = 100/100`, `fish = 80/80`):
  // `V_farmCurve` funds urgent farm care via `eat` even when shiftable extraction quotas are 100% exhausted,
  // AND stops eating once remaining passive regen wait (`180s` for the last `1 en` on plot 23) costs less than another turnip!
  const worldSecondaryEn0 = makeBaseWorld(adapter, t0, {
    coins: 20000,
    state: {
      plotN: 24,
      plots: structuredClone(plots),
      tools: { pick: 4, rod: 4, can: 4, spr: 2, house: 1 },
      en: 0,
      enT: t0,
      cnt: { coffee: 3 },
      iq: { d: R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10 },
      inv: { turnip: [5, 0, 0] },
    },
  })
  const envSecondaryFull = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: worldSecondaryEn0,
    userConstraints: { allowCapex: false },
  })
  const planSecondaryFull = solveUnifiedPlan(adapter, envSecondaryFull, buildObjectiveConfig({ horizonSec: 7200 }), {
    allowedActionTypes: ['harvest', 'plant', 'water', 'clear', 'eat', 'coffee', 'wait'],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const actsC = planSecondaryFull.trunkBuckets[0]?.domesticActions || []
  assert.ok(actsC.some((a) => a.a === 'eat' && a.id === 'turnip'), 'Must eat food to break en=0 farm deadlock')
  assert.ok(actsC.some((a) => a.a === 'harvest' && a.i === 23), 'Must immediately harvest ripe plot 23')
  const plantedIndices = actsC.filter((a) => a.a === 'plant').map((a) => a.i).sort((a, b) => a - b)
  assert.ok(plantedIndices.length >= 3 && plantedIndices.includes(0) && plantedIndices.includes(13) && plantedIndices.includes(14), 'Must immediately plant empty plots in Bucket 0 without wasting stamina on non-expiring water!')
  assert.equal(actsC.filter((a) => a.a === 'water').length, 0, 'Must not waste food-funded stamina on non-expiring manual water while plots remain empty')
})

test('Phase 10.3: Reserves stamina across same-isle buckets for imminent maturity waves when food/coffee cannot cover', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R, graph } = adapter

  let t0 = 1794340000
  for (let step = 0; step < 500; step++, t0 += 7200) {
    if (adapter.nextIsleBoundary(t0, CLOCK_START) - t0 > 7200 && R.seasonOf(R.isleDay(t0)) === 0) {
      break
    }
  }
  const singleCrop = [...graph.cropsById.values()].find((c) => !c.regrow && c.seasons.includes(0))
  assert.ok(singleCrop)

  // Construct 12 plots maturing in exactly +300s (`36 en` needed: 12 harvests + 12 replants; passive regen in 300s = `1 en`).
  let plantedAt = null
  for (let back = 60; back < 86400; back += 1) {
    const candP = { c: singleCrop.id, t: t0 + 300 - back, w: 3, g: 0, h: 0 }
    const tm = adapter.exactPlotTimings(candP, true, t0, CLOCK_START)
    if (tm && tm.matureAt === t0 + 300) {
      plantedAt = candP.t
      break
    }
  }
  assert.ok(plantedAt != null, 'Must find exact plantedAt for +300s maturity')
  const plots = Array.from({ length: 24 }, (_, idx) =>
    idx < 12
      ? { c: singleCrop.id, t: plantedAt, w: 3, g: 0, h: 0 }
      : { c: singleCrop.id, t: t0, w: 3, g: 0, h: 0 }
  )

  const worldWave = makeBaseWorld(adapter, t0, {
    coins: 12000, // enough for seeds, < 15,000 for coffee; 0 food in bag!
    state: {
      plotN: 24,
      plots,
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 1 },
      en: 36,
      enT: t0,
      iq: { d: R.isleIndex(t0), craft: 80, mine: 0, fish: 80, bomb: 10 },
      inv: {},
    },
  })

  const envWave = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: worldWave,
    userConstraints: { allowCapex: false },
  })
  const planWave = solveUnifiedPlan(adapter, envWave, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['harvest', 'plant', 'mine', 'sell', 'buy', 'eat', 'coffee', 'wait'],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })

  const b0MineCount = (planWave.trunkBuckets[0]?.domesticActions || []).filter((a) => a.a === 'mine').length
  assert.equal(b0MineCount, 0, 'Bucket 0 MUST hold en=36 for the +300s 12-plot maturity wave instead of draining stamina on mine!')

  const waveBucket = planWave.trunkBuckets.find((b) => b.atSec === t0 + 300)
  assert.ok(waveBucket, 'Must have exact maturity bucket at t0 + 300s')
  const waveHarvests = waveBucket.domesticActions.filter((a) => a.a === 'harvest').length
  const wavePlants = waveBucket.domesticActions.filter((a) => a.a === 'plant').length
  assert.equal(waveHarvests, 12, 'All 12 plots MUST be harvested on the exact maturity second t0+300s')
  assert.equal(wavePlants, 12, 'All 12 freed plots MUST be replanted on the exact maturity second t0+300s')
})

test('Phase 10.4: Long-night sameIsleDay activates full 12-isle-day continuation and smooth pro-rata farm renewal', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })

  // Find a 10h long-night isle window (`nextIsleBoundary - isleStart >= 30000s`, i.e., 22:00..08:00 CST)
  let nightStart = CLOCK_START
  for (let step = 0; step < 200; step++) {
    const nextB = adapter.nextIsleBoundary(nightStart, CLOCK_START)
    if (nextB - nightStart >= 30000) break
    nightStart = nextB
  }
  const tNight = nightStart + 600 // 22:10 CST, 9h50m remaining in SAME isle day!
  const worldNight = makeBaseWorld(adapter, tNight, {})

  // Horizon = 4h (`14400s`): `tH = 02:10 CST` is STILL in the same isle day (`sameIsleDay === true`) and `< 8h`!
  const objCfg4h = buildObjectiveConfig({ horizonSec: 14400 })
  assert.equal(objCfg4h.continuationIsleDays, 12, '4h horizon must keep full 12-isle-day continuation (no <8h cliff)')

  const worldAtTH = adapter.advanceTimeOnly(worldNight, tNight + 14400)
  const contSlots = buildContinuationTimeline(adapter, worldAtTH, worldNight, objCfg4h, 1.0)
  assert.ok(contSlots.length > 12, `Expected >12 continuation slots inside long night, got ${contSlots.length}`)

  // Check smoothness across small horizon shifts (`14000s`, `14400s`, `14800s`) — no cycle-truncation cliff!
  const vals = [14000, 14400, 14800].map((hSec) => {
    const cfg = buildObjectiveConfig({ horizonSec: hSec })
    const wH = adapter.advanceTimeOnly(worldNight, tNight + hSec)
    const slots = buildContinuationTimeline(adapter, wH, worldNight, cfg, 1.0)
    return projectContinuationFarmFlows(adapter, wH, slots, { discountRatePerHour: 0 }).totalPlotContinuationValue
  })
  assert.ok(vals[0] > 0 && vals[1] > 0 && vals[2] > 0)
  const relJump01 = Math.abs(vals[1] - vals[0]) / vals[0]
  const relJump12 = Math.abs(vals[2] - vals[1]) / vals[1]
  assert.ok(relJump01 < 0.05 && relJump12 < 0.05, `Continuation renewal value must vary smoothly (<5%), got jumps ${relJump01}, ${relJump12}`)
})

test('Phase 10.5: PlanCache invalidates across maturity/regen transitions & AsyncPlanManager reuses compatible in-flight Worker job', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R } = adapter
  const t0 = 1794340000

  // 1) PlanCache MUST invalidate a cached `wait` plan as soon as `world.now >= matureAt` (even with unchanged `rev`!)
  let plantedT = null
  for (let back = 10; back < 86400; back += 1) {
    const cand = { c: 'corn', t: t0 + 10 - back, w: 3, g: 0, h: 0 }
    const tm = adapter.exactPlotTimings(cand, true, t0, CLOCK_START)
    if (tm && tm.matureAt === t0 + 10) {
      plantedT = cand.t
      break
    }
  }
  assert.ok(plantedT != null, 'Must find exact plantedT for +10s maturity')
  const worldPreMature = makeBaseWorld(adapter, t0, {
    rev: 7,
    state: {
      plotN: 1,
      plots: [{ c: 'corn', t: plantedT, w: 3, g: 0, h: 0 }],
      tools: { pick: 4, rod: 4, can: 4, spr: 3, house: 1 },
      en: 10,
      enT: t0,
      iq: { d: R.isleIndex(t0), craft: 80, mine: 100, fish: 80, bomb: 10 },
    },
  })
  const envPre = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: worldPreMature,
    userConstraints: { allowCapex: false },
  })
  const objCfg = buildObjectiveConfig({ horizonSec: 1800 })
  const waitPlan = solveUnifiedPlan(adapter, envPre, objCfg, {
    allowedActionTypes: ['harvest', 'plant', 'water', 'clear', 'wait'],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  assert.equal(waitPlan.trunkBuckets[0].domesticActions.length, 0)
  assert.equal(waitPlan.nextWakeSec, t0 + 10, 'Wait plan must wake at exact t0+10s maturity (no +5s floor if <5s either)')

  const cache = new PlanCache()
  cache.put({
    adapter,
    account: 'secondary',
    worldBefore: worldPreMature,
    envelope: envPre,
    objectiveCfg: objCfg,
    neighborSig: 'none',
    plan: waitPlan,
  })

  const worldAtPlus5 = adapter.advanceTimeOnly(worldPreMature, t0 + 5)
  worldAtPlus5.rev = 7
  assert.ok(
    cache.getValid({
      adapter,
      account: 'secondary',
      world: worldAtPlus5,
      constraintsHash: envPre.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
    }),
    'PlanCache should hit before maturity (t0 + 5 < t0 + 10)'
  )

  const worldAtMature = adapter.advanceTimeOnly(worldPreMature, t0 + 10)
  worldAtMature.rev = 7
  assert.equal(
    cache.getValid({
      adapter,
      account: 'secondary',
      world: worldAtMature,
      constraintsHash: envPre.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
    }),
    null,
    'PlanCache MUST invalidate stale wait plan once plot matures at t0 + 10 even with unchanged rev=7!'
  )

  // 2) `AsyncPlanManager.solveOrPreempt` MUST reuse an in-flight `runStability: false` `+2s` precompute with neighbors!
  const mgr = new AsyncPlanManager({ rulesPath: RULES_PATH })
  try {
    const neighborList = [{ id: 8801, rev: 3, state: { plots: [], barn: [] } }]
    const wPre = makeBaseWorld(adapter, t0 + 2, {
      rev: 12,
      state: {
        plotN: 4,
        plots: Array(4).fill(null),
        en: 20,
        enT: t0 + 2,
        iq: { d: R.isleIndex(t0 + 2), craft: 80, mine: 100, fish: 80, bomb: 10 },
      },
    })
    const envBg = buildObservationEnvelope(adapter, {
      account: 'main',
      world: wPre,
      neighborTargets: neighborList,
    })
    const bgPromise = mgr.precomputeInBackground({
      rulesPath: RULES_PATH,
      adapter,
      account: 'main',
      envelope: envBg,
      objectiveCfg: objCfg,
      neighborTargets: neighborList,
      solverOptions: { simulateSlowSolveMs: 120, scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] },
      runStability: false,
    })
    assert.ok(bgPromise, 'Background precompute job should start')

    // Foreground `solveOrPreempt` arrives 1s later (`t0 + 3`) with `runStability: true` and same `neighborList`!
    const wFg = adapter.advanceTimeOnly(wPre, t0 + 3)
    wFg.rev = 12
    const envFg = buildObservationEnvelope(adapter, {
      account: 'main',
      world: wFg,
      neighborTargets: neighborList,
    })
    assert.equal(buildNeighborSignature(neighborList) !== 'none', true)
    const fgOut = await mgr.solveOrPreempt({
      rulesPath: RULES_PATH,
      adapter,
      account: 'main',
      envelope: envFg,
      objectiveCfg: objCfg,
      neighborTargets: neighborList,
      solverOptions: { scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] },
      runStability: true,
    })
    assert.equal(fgOut.status, 'cache-hit', 'Foreground solveOrPreempt MUST reuse the in-flight +2s background job!')
    assert.equal(mgr.stats.preemptedJobs, 0, 'Must NOT kill compatible in-flight background job!')
  } finally {
    await mgr.close()
  }
})
