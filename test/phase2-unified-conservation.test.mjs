import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createRulesAdapter, loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { auditDecisionAgainstReference } from '../audit/reference-solver.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeCleanWorld(adapter, nowSec = 1794340000, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plots = Array(s.plotN).fill(null)
  s.barn = []
  s.traps = []
  s.en = 100
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
    coins: 50000,
    prices,
    ...overrides,
    state: {
      ...s,
      ...(overrides.state || {}),
    },
  }
}

test('Phase 2.1: R.RECIPES permutation invariance', async () => {
  const baseMod = await import('../rules/pet-world-rules.js')
  const reversedMod = {
    ...baseMod,
    RECIPES: [...baseMod.RECIPES].reverse(),
  }
  const adapter1 = createRulesAdapter(baseMod, { clockStart: CLOCK_START })
  const adapter2 = createRulesAdapter(reversedMod, { clockStart: CLOCK_START })

  const makeState = (ad) => makeCleanWorld(ad, 1794340000, {
    state: {
      inv: {
        turnip: [6, 0, 0],
        carrot: [6, 0, 0],
        strawberry: [8, 0, 0],
        gold: [4, 0, 0],
        coal: [2, 0, 0],
        diamond: [2, 0, 0],
      },
      iq: { d: ad.R.isleIndex(1794340000), craft: 77 }, // only 3 craft slots!
      en: 20,
    },
  })

  const cfg = buildObjectiveConfig({ horizonSec: 600, terminalSupplyMode: 'zero' })
  const env1 = buildObservationEnvelope(adapter1, {
    world: makeState(adapter1),
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const env2 = buildObservationEnvelope(adapter2, {
    world: makeState(adapter2),
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })

  const p1 = solveUnifiedPlan(adapter1, env1, cfg, { allowedActionTypes: ['sell', 'craft', 'wait'] })
  const p2 = solveUnifiedPlan(adapter2, env2, cfg, { allowedActionTypes: ['sell', 'craft', 'wait'] })

  assert.equal(p1.quality.feasibleIncumbentValue, p2.quality.feasibleIncumbentValue)
  assert.deepEqual(p1.trunkBuckets[0].domesticActions, p2.trunkBuckets[0].domesticActions)
})

test('Phase 2.2: Scarce 1 craft slot waits 60s for 4 strawberries instead of burning slot on low-margin salad', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      inv: {
        turnip: [3, 0, 0],
        carrot: [3, 0, 0],
      },
      iq: { d: adapter.R.isleIndex(t0), craft: 79 }, // strictly 1 craft slot left in this isleDay!
      en: 20,
    },
  })

  // At base prices:
  // Option A (myopic craft salad @ t0): salad (6500) + 4 raw strawberry @ t0+60 (4*3300=13200) = 19,700
  // Option B (wait @ t0, craft jam @ t0+60): raw turnip+carrot (3*540 + 3*960 = 4500) + jam (17000) = 21,500!
  const arrivals = [{ atSec: t0 + 60, items: [{ id: 'strawberry', q: 0, n: 4 }] }]
  const cfg = buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' })
  const env = buildObservationEnvelope(adapter, {
    world,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })

  const plan = solveUnifiedPlan(adapter, env, cfg, {
    deterministicArrivals: arrivals,
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })

  // At t0 (bucket 0), MUST NOT craft `salad`!
  const craftsAtT0 = plan.trunkBuckets[0].domesticActions.filter((a) => a.a === 'craft')
  assert.equal(craftsAtT0.length, 0)
  // At t0 + 60 (bucket 1), MUST craft `jam`!
  const craftsAtT1 = plan.trunkBuckets[1].domesticActions.filter((a) => a.a === 'craft')
  assert.deepEqual(craftsAtT1, [{ a: 'craft', id: 'jam', n: 1 }])
  assert.equal(plan.quality.feasibleIncumbentValue, 21500)
})

test('Phase 2.3: Multi-step recipe chain ingot -> crown beats selling ingot + raw diamonds (108,000 vs 95,000)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      inv: {
        gold: [4, 0, 0],
        coal: [2, 0, 0],
        diamond: [2, 0, 0],
      },
      iq: { d: adapter.R.isleIndex(t0), craft: 78 }, // 2 craft slots
      en: 10,
    },
  })

  const cfg = buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' })
  const env = buildObservationEnvelope(adapter, {
    world,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })

  const plan = solveUnifiedPlan(adapter, env, cfg, { allowedActionTypes: ['sell', 'craft', 'wait'] })
  assert.equal(plan.quality.feasibleIncumbentValue, 108000)
  const craftIds = plan.trunkBuckets[0].domesticActions.filter((a) => a.a === 'craft').map((a) => a.id)
  assert.deepEqual(craftIds, ['ingot', 'crown'])
})

test('Phase 2.4: Shared natural-day crop tier orders q2 -> q1 -> q0 and splits across 00:00 midnight reset', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  // Place t0 at 23:55 UTC+8 inside long night so nextIsleAt (08:00+) is AFTER 00:00 natural-day reset!
  const midnightSec = adapter.nextNaturalDayBoundary(1794340000)
  const t0 = midnightSec - 300 // 23:55 UTC+8!

  // Part A: Single-bucket `sc = 148` with `2 q0 + 2 q2` strawberries -> MUST sell `q2` first!
  const wSingle = makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      enDay: adapter.R.worldDay(t0),
      cnt: { sc_strawberry: 148 },
      inv: { strawberry: [2, 0, 2] },
    },
  })
  const envSingle = buildObservationEnvelope(adapter, {
    world: wSingle,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const pSingle = solveUnifiedPlan(
    adapter,
    envSingle,
    buildObjectiveConfig({ horizonSec: 120, terminalSupplyMode: 'zero' }),
    { allowedActionTypes: ['sell', 'wait'] }
  )
  const sellOrder = pSingle.trunkBuckets[0].domesticActions.filter((a) => a.a === 'sell').map((a) => a.q)
  assert.deepEqual(sellOrder, [2, 0])
  // 2 * 4950 * 1.0 + 2 * 3300 * 0.85 = 9900 + 5610 = 15510 (vs q0 first: 6600 + 8415 = 15015)
  assert.equal(pSingle.quality.feasibleIncumbentValue, 15510)

  // Part B: Cross-midnight split (`250 q0` strawberries at 23:55, same isleDay price 3300 across 00:00!)
  const wCross = makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      enDay: adapter.R.worldDay(t0),
      cnt: { sc_strawberry: 0 },
      inv: { strawberry: [250, 0, 0] },
    },
  })
  const envCross = buildObservationEnvelope(adapter, {
    world: wCross,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const pCross = solveUnifiedPlan(
    adapter,
    envCross,
    buildObjectiveConfig({ horizonSec: 900, discountRatePerHour: 0, terminalSupplyMode: 'zero' }),
    { allowedActionTypes: ['sell', 'wait'] }
  )
  // Full 100% tier on all 250 units = 250 * 3300 = 825,000 (vs dumping all at 23:55 = 150*3300 + 100*2805 = 775,500)
  assert.equal(pCross.quality.feasibleIncumbentValue, 825000)
})

test('Phase 2.5: Mature regrow crop harvested before season change avoids immediate regrow wither', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  // Find exact last isleDay of season 0 (spring, strawberry season) after CLOCK_START
  let probe = CLOCK_START + 3600
  while (adapter.R.seasonOf(adapter.R.isleDay(probe)) !== 0) probe += 14400
  while (adapter.R.seasonOf(adapter.R.isleDay(adapter.nextIsleBoundary(probe, CLOCK_START))) === 0) {
    probe = adapter.nextIsleBoundary(probe, CLOCK_START) + 60
  }
  const seasonChangeSec = adapter.nextIsleBoundary(probe, CLOCK_START)
  const t0 = seasonChangeSec - 600 // 10 minutes before spring -> summer transition!

  const world = makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      en: 20,
      plots: [
        // Mature strawberry plot (planted earlier in spring, h=0, ready now!)
        { c: 'strawberry', t: t0 - 30000, w: 3, g: 0, h: 0 },
        ...Array(5).fill(null),
      ],
    },
  })

  const env = buildObservationEnvelope(adapter, {
    world,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 1800 }))
  const hasHarvestNow = plan.trunkBuckets[0].domesticActions.some((a) => a.a === 'harvest' && a.i === 0)
  assert.equal(hasHarvestNow, true)

  // Verify via rules simulation that harvesting at t0 keeps regrown plot alive (`stage >= 0`),
  // whereas waiting past `seasonChangeSec` causes regrown plot to immediately wither (`stage === -1`)!
  const simBefore = adapter.simulateBatch(world, [{ a: 'harvest', i: 0 }], { t: t0 })
  assert.ok(adapter.R.cropStage(simBefore.afterWorld.state.plots[0], seasonChangeSec + 10).stage >= 0)
  const afterBoundaryWorld = adapter.advanceTimeOnly(world, seasonChangeSec + 10)
  const simLate = adapter.simulateBatch(afterBoundaryWorld, [{ a: 'harvest', i: 0 }], { t: seasonChangeSec + 10 })
  assert.equal(adapter.R.cropStage(simLate.afterWorld.state.plots[0], seasonChangeSec + 10).stage, -1)
})

test('Phase 2.6: Low-star-first craft vs shared crop tier switches from raw sell (sc=0) to jam craft (sc=400)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  const makeStrawberryMix = (sc) => makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      enDay: adapter.R.worldDay(t0),
      cnt: { sc_strawberry: sc },
      inv: { strawberry: [1, 1, 2] }, // 1 normal (3300) + 1 silver (4125) + 2 gold (9900) = 17,325 raw at 100%
      en: 10,
    },
  })

  const cfg = buildObjectiveConfig({ horizonSec: 120, terminalSupplyMode: 'zero' })
  // At sc = 0: raw sell = 17,325 > jam = 17,000 -> MUST sell raw!
  const pSc0 = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { world: makeStrawberryMix(0), scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }),
    cfg,
    { allowedActionTypes: ['sell', 'craft', 'wait'] }
  )
  assert.equal(pSc0.quality.feasibleIncumbentValue, 17325)
  assert.equal(pSc0.trunkBuckets[0].domesticActions.some((a) => a.a === 'craft'), false)

  // At sc = 400 (70% tier): raw sell = 6930 + 2888 + 2310 = 12,128 < jam = 17,000 -> MUST craft jam!
  const pSc400 = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { world: makeStrawberryMix(400), scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }),
    cfg,
    { allowedActionTypes: ['sell', 'craft', 'wait'] }
  )
  assert.equal(pSc400.quality.feasibleIncumbentValue, 17000)
  assert.deepEqual(
    pSc400.trunkBuckets[0].domesticActions.filter((a) => a.a === 'craft'),
    [{ a: 'craft', id: 'jam', n: 1 }]
  )
})

test('Phase 2.7: Stamina mechanics — coffee legally exceeds energyMax while eat is capped and picks cheapest food', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  // Subcase A: `en = 100 === energyMax`, holding 160 wool (`80` sweater crafts = 80 en) PLUS Lv4 rod fishing (`12` casts = 48 en -> 128 en needed > 100!)
  const wFullEn = makeCleanWorld(adapter, t0, {
    coins: 20000,
    state: {
      en: 100, // already at energyMax(s) = 100!
      tools: { rod: 4, pick: 4, spr: 0, house: 0 },
      inv: { turnip: [10, 0, 0], wool: [160, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 0, fish: 0 },
    },
  })
  const pFull = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { world: wFullEn, scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }),
    buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    { allowedActionTypes: ['sell', 'craft', 'fish', 'eat', 'coffee', 'wait'] }
  )
  const actsFull = pFull.trunkBuckets[0].domesticActions
  // Must NOT emit `eat` at `en=100` (which would fail), and MUST emit `coffee` (`en -> 160`) to craft 60 sweaters!
  assert.equal(actsFull.some((a) => a.a === 'eat'), false)
  assert.equal(actsFull.some((a) => a.a === 'coffee'), true)
  const compFull = compileExecutablePrefix(adapter, wFullEn, pFull)
  assert.equal(compFull.status, 'ready')

  // Subcase B: `en = 0`, holding `1 turnip (540 D, +8 en)` and `1 pumpkin (9000 D, +20 en)` plus `8 wool` (4 sweaters)
  const wZeroEn = makeCleanWorld(adapter, t0, {
    coins: 0,
    state: {
      en: 0,
      enT: t0,
      inv: { turnip: [1, 0, 0], pumpkin: [1, 0, 0], wool: [8, 0, 0] },
    },
  })
  const pZero = solveUnifiedPlan(
    adapter,
    buildObservationEnvelope(adapter, { world: wZeroEn, scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }),
    buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    { allowedActionTypes: ['sell', 'craft', 'eat', 'wait'] }
  )
  const eatActs = pZero.trunkBuckets[0].domesticActions.filter((a) => a.a === 'eat')
  assert.deepEqual(eatActs, [{ a: 'eat', id: 'turnip', q: 0 }])
})

test('Phase 2.8: Zero-hardcoded-ID isomorphic renaming test across planner AND independent reference auditor', async () => {
  const baseMod = await import('../rules/pet-world-rules.js')
  const renameMap = new Map()
  baseMod.CROPS.forEach((c, i) => renameMap.set(c.id, `iso_crop_${i}`))
  baseMod.ANIMALS.forEach((a, i) => renameMap.set(a.product, `iso_prod_${i}`))
  baseMod.FISH.forEach((f, i) => renameMap.set(f.id, `iso_fish_${i}`))
  baseMod.ORES.forEach((o, i) => renameMap.set(o.id, `iso_ore_${i}`))
  baseMod.RECIPES.filter((r) => r.price > 0).forEach((r, i) => renameMap.set(r.id, `iso_rec_${i}`))

  const tr = (id) => renameMap.get(id) || id

  const renamedCrops = baseMod.CROPS.map((c) => ({ ...c, id: tr(c.id) }))
  const renamedAnimals = baseMod.ANIMALS.map((a) => ({ ...a, product: tr(a.product) }))
  const renamedFish = baseMod.FISH.map((f) => ({ ...f, id: tr(f.id) }))
  const renamedOres = baseMod.ORES.map((o) => ({ ...o, id: tr(o.id) }))
  const renamedRecipes = baseMod.RECIPES.map((r) => ({
    ...r,
    id: tr(r.id),
    in: Object.fromEntries(Object.entries(r.in).map(([k, v]) => [tr(k), v])),
  }))
  const renamedBasePrice = Object.fromEntries(Object.entries(baseMod.BASE_PRICE).map(([k, v]) => [tr(k), v]))
  const renamedItemName = Object.fromEntries(Object.entries(baseMod.ITEM_NAME).map(([k, v]) => [tr(k), v]))

  // Build self-contained isomorphic rules module delegating core engine on renamed IDs
  const isoMod = {
    ...baseMod,
    CROPS: renamedCrops,
    ANIMALS: renamedAnimals,
    FISH: renamedFish,
    ORES: renamedOres,
    RECIPES: renamedRecipes,
    BASE_PRICE: renamedBasePrice,
    ITEM_NAME: renamedItemName,
    applyActions(s, actions, ctx) {
      const nextEn = (s.en || 0)
      let spend = 0
      let earn = 0
      const out = []
      s.iq ||= { d: baseMod.isleIndex(ctx.t) }
      for (const act of actions) {
        if (act.a === 'craft') {
          const rec = renamedRecipes.find((x) => x.id === act.id)
          const n = act.n || 1
          if (!rec || s.en < n) { out.push({ ok: false, a: 'craft' }); continue }
          const okMat = Object.entries(rec.in).every(([id, k]) => ((s.inv[id]?.[0] || 0) + (s.inv[id]?.[1] || 0) + (s.inv[id]?.[2] || 0)) >= k * n)
          if (!okMat) { out.push({ ok: false, a: 'craft' }); continue }
          for (const [id, k] of Object.entries(rec.in)) {
            let rem = k * n
            for (let q = 0; q < 3 && rem > 0; q++) {
              const tk = Math.min(rem, s.inv[id]?.[q] || 0)
              s.inv[id][q] -= tk
              rem -= tk
            }
          }
          s.inv[rec.id] ||= [0, 0, 0]
          s.inv[rec.id][0] += n
          s.en -= n
          s.iq.craft = (s.iq.craft || 0) + n
          out.push({ ok: true, a: 'craft', got: [{ id: rec.id, q: 0, n }] })
        } else if (act.a === 'sell') {
          const p = ctx.prices[act.id] || 0
          const q = act.q || 0
          const n = act.n || 1
          if (!(p > 0) || (s.inv[act.id]?.[q] || 0) < n) { out.push({ ok: false, a: 'sell' }); continue }
          s.inv[act.id][q] -= n
          const val = Math.round(p * baseMod.QUALITY[q]) * n
          earn += val
          out.push({ ok: true, a: 'sell', earn: val, gross: val, tax: 0 })
        }
      }
      return { out, spend, earn, xp: 0, tax: 0 }
    },
  }

  const isoAdapter = createRulesAdapter(isoMod, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const isoWorld = makeCleanWorld(isoAdapter, t0, {
    coins: 0,
    state: {
      inv: {
        [tr('gold')]: [4, 0, 0],
        [tr('coal')]: [2, 0, 0],
        [tr('diamond')]: [2, 0, 0],
      },
      iq: { d: isoAdapter.R.isleIndex(t0), craft: 78 },
      en: 10,
    },
  })

  const cfg = buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' })
  const env = buildObservationEnvelope(isoAdapter, {
    world: isoWorld,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const plan = solveUnifiedPlan(isoAdapter, env, cfg, { allowedActionTypes: ['sell', 'craft', 'wait'] })
  assert.equal(plan.quality.feasibleIncumbentValue, 108000)

  const ref = auditDecisionAgainstReference(isoAdapter, {
    worldBefore: isoWorld,
    actualFirstActions: plan.trunkBuckets[0].domesticActions,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: cfg,
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })
  assert.equal(ref.bestAlternative.value, 108000)
  assert.equal(ref.identifiableRegretLowerBound, 0)
})

test('Phase 2.9 & 2.10: Account constraints + fail-closed prefix compilation & stochastic truncation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  // 1) default mode forbids unapproved CapEx; domestic-only mode forbids steal
  const richWorld = makeCleanWorld(adapter, t0, { coins: 5000000 })
  const neighbor = {
    id: 777,
    owner: { id: 777, name: 'UnguardedRichNeighbor', guard: false },
    isle: { plots: [{ c: 'pumpkin', steal: true }, { c: 'pumpkin', steal: true }], barn: [] },
  }

  const mainEnv = buildObservationEnvelope(adapter, {
    account: 'main',
    world: richWorld,
    neighborTargets: [neighbor],
  })
  const mainPlan = solveUnifiedPlan(adapter, mainEnv, buildObjectiveConfig({ horizonSec: 3600 }))
  const capexActs = mainPlan.trunkBuckets[0].domesticActions.filter((a) => ['expand', 'buyAnimal', 'buyTrap', 'upgrade'].includes(a.a))
  assert.equal(capexActs.length, 0)
  assert.equal(mainPlan.trunkBuckets[0].visitActions.length, 1)

  const secondaryEnv = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: richWorld,
    neighborTargets: [neighbor],
  })
  const secondaryPlan = solveUnifiedPlan(adapter, secondaryEnv, buildObjectiveConfig({ horizonSec: 3600 }))
  assert.equal(secondaryPlan.trunkBuckets[0].visitActions.length, 0)

  // 2) Prefix compiler truncates immediately after stochastic action (`harvest` on mature summer crop `tomato`)
  const wStoch = makeCleanWorld(adapter, t0, {
    state: {
      barn: [{ k: 'chicken', f: t0, p: t0 - 20000, m: 60, born: CLOCK_START }],
      plots: [{ c: 'tomato', t: t0 - 20000, w: 3, g: 0, h: 0 }, null, null, null, null, null],
      inv: { tomato: [5, 0, 0] },
    },
  })
  const mockStochPlan = {
    constraints: mainEnv.constraints,
    trunkBuckets: [{
      atSec: t0,
      domesticActions: [
        { a: 'pet', i: 0 },
        { a: 'harvest', i: 0 },
        { a: 'sell', id: 'tomato', q: 0, n: 5 },
      ],
      visitActions: [],
    }],
    nextWakeSec: t0 + 60,
  }
  const compStoch = compileExecutablePrefix(adapter, wStoch, mockStochPlan)
  assert.equal(compStoch.status, 'ready')
  assert.equal(compStoch.truncatedAfterStochastic, true)
  assert.deepEqual(compStoch.domesticBatch, [{ a: 'pet', i: 0 }, { a: 'harvest', i: 0 }])

  // 3) Fail-closed when ANY action in prefix is invalid (NEVER silently dropping failed middle action!)
  const mockInvalidPlan = {
    constraints: mainEnv.constraints,
    trunkBuckets: [{
      atSec: t0,
      domesticActions: [
        { a: 'pet', i: 0 },
        { a: 'craft', id: 'crown', n: 1 }, // missing materials -> invalid!
        { a: 'sell', id: 'turnip', q: 0, n: 5 },
      ],
      visitActions: [],
    }],
  }
  const compInvalid = compileExecutablePrefix(adapter, wStoch, mockInvalidPlan)
  assert.equal(compInvalid.status, 'plan-invalid')
  assert.equal(compInvalid.failedIndex, 1)
  assert.deepEqual(compInvalid.domesticBatch, [])
})

test('Phase 2.11: Combinational thief buffs (stealth + carry) + stamina prep + non-blocking raid compilation & low-cash working capital', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  // Subcase A: Neighbor has 4 high-value guarded pumpkin/cow spots (`cow` cap=2 + `pumpkin`, guard with low win posterior [0.15, 0.25]),
  // visitor has `en = 2` (starved!), `carrot` in inv, and no active thief buffs.
  // Solver should discover BOTH `carry` (`sack`) + `stealth` (`cloak` or `whistle`) AND `eat` (`carrot`) as non-blocking `raidPrepActs`,
  // compile `raidPrepActs` cleanly on step 1, and immediately fire `visitFirst = true` on step 2!
  const wRaidStarved = makeCleanWorld(adapter, t0, {
    coins: 50000,
    state: {
      en: 2,
      enT: t0,
      inv: { carrot: [3, 0, 0] },
    },
  })
  const guardedRichNeighbor = {
    id: 888,
    owner: { id: 888, name: 'GuardedMilkPumpkinBaron', guard: true },
    isle: {
      plots: [{ c: 'pumpkin', steal: true }, { c: 'pumpkin', steal: true }],
      barn: [
        { k: 'cow', steal: true },
        { k: 'cow', steal: true },
      ],
    },
    posterior: { sampleCount: 12, winInterval: [0.15, 0.25], lossInterval: [0.75, 0.85] },
  }

  const envStep1 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wRaidStarved,
    neighborTargets: [guardedRichNeighbor],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const planStep1 = solveUnifiedPlan(adapter, envStep1, buildObjectiveConfig({ horizonSec: 3600 }))
  assert.equal(planStep1.trunkBuckets[0].visitActions.length, 1)
  assert.equal(planStep1.trunkBuckets[0].visitFirst, false)

  const prepDom = planStep1.trunkBuckets[0].domesticActions
  // Verify BOTH stealth and carry slots were purchased from `R.THIEF_ITEMS` + carrot eaten, with ZERO blocking mine/fish!
  const boughtBuffSlots = new Set(
    prepDom.filter((a) => a.a === 'buy' && adapter.R.THIEF_ITEMS[a.id]).map((a) => adapter.R.THIEF_ITEMS[a.id].slot)
  )
  assert.ok(boughtBuffSlots.has('carry'), 'must buy carry buff when 4 high-value spots more than cover 2500D')
  assert.ok(boughtBuffSlots.has('stealth'), 'must also buy stealth buff against tough guard')
  assert.ok(prepDom.some((a) => a.a === 'eat' && a.id === 'carrot'), 'must eat carrot to reach steal stamina cost')
  assert.ok(!prepDom.some((a) => a.a === 'mine' || a.a === 'fish'), 'must not block race-sensitive raid behind mine/fish')

  const compStep1 = compileExecutablePrefix(adapter, wRaidStarved, planStep1)
  assert.equal(compStep1.status, 'ready')
  assert.equal(compStep1.nextTransactionKind, 'act')

  // Simulate executing step 1's prep batch -> step 2 immediately triggers `visitFirst = true`!
  const afterStep1 = adapter.simulateBatch(wRaidStarved, compStep1.domesticBatch, { t: t0, prices: wRaidStarved.prices }).afterWorld
  const envStep2 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: afterStep1,
    neighborTargets: [guardedRichNeighbor],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const planStep2 = solveUnifiedPlan(adapter, envStep2, buildObjectiveConfig({ horizonSec: 3600 }))
  assert.equal(planStep2.trunkBuckets[0].visitFirst, true)
  const compStep2 = compileExecutablePrefix(adapter, afterStep1, planStep2)
  assert.equal(compStep2.status, 'ready')
  assert.equal(compStep2.nextTransactionKind, 'visit')
  assert.equal(compStep2.visitOperations[0].targetId, 888)

  // Subcase B: Cash-poor island (`coins = 50`) holding finished `wine` with hungry barn + empty plots:
  // Solver pre-sells minimal `wine` to fund `buy(feed)` + `feed` + `plant` in the very first batch!
  const wCashPoor = makeCleanWorld(adapter, t0, {
    coins: 50,
    state: {
      en: 40,
      enT: t0,
      plotN: 2,
      plots: [null, null],
      barn: [{ k: 'cow', f: t0 - 90000, p: t0, m: 80, born: CLOCK_START }],
      inv: { wine: [3, 0, 0] },
    },
  })
  const envPoor = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: wCashPoor,
    userConstraints: { allowCapex: false },
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const planPoor = solveUnifiedPlan(adapter, envPoor, buildObjectiveConfig({ horizonSec: 8 * 3600 }))
  const actsPoor = planPoor.trunkBuckets[0].domesticActions
  assert.ok(actsPoor.some((a) => a.a === 'sell' && a.id === 'wine'), 'must liquidate wine for working capital')
  assert.ok(actsPoor.some((a) => a.a === 'feed' && a.i === 0), 'must feed hungry cow using raised working capital')
  assert.ok(actsPoor.some((a) => a.a === 'plant'), 'must plant empty plots using raised working capital')
  const compPoor = compileExecutablePrefix(adapter, wCashPoor, planPoor)
  assert.equal(compPoor.status, 'ready')

  // Subcase C: Livelock-proof `nextWakeSec` (never wakes < now + 5s)
  const wIdle = makeCleanWorld(adapter, t0, {
    coins: 1000,
    state: { en: 0, enT: t0 - 179, plotN: 0, plots: [], barn: [], traps: [], inv: {} },
  })
  const envIdle = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: wIdle,
    userConstraints: { allowCapex: false },
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const planIdle = solveUnifiedPlan(adapter, envIdle, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['wait'],
  })
  assert.ok(planIdle.nextWakeSec >= t0 + 5, `expected nextWakeSec >= ${t0 + 5}, got ${planIdle.nextWakeSec}`)
})
