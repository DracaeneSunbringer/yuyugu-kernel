import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeWorld(adapter, nowSec = 1794340000, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plots = Array(s.plotN).fill(null)
  s.barn = []
  s.traps = []
  s.en = 40
  s.enT = nowSec
  s.iq = { d: adapter.R.isleIndex(nowSec), craft: 0, mine: 0, fish: 0, bomb: 0 }
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(adapter.R.BASE_PRICE[id])
  }
  const stOverrides = overrides.state || {}
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 1,
    coins: 0,
    prices,
    ...overrides,
    state: {
      ...s,
      ...stOverrides,
      tools: { ...s.tools, ...(stOverrides.tools || {}) },
    },
  }
}

test('Phase 6.1 (Codex Round-2 P1-1): Exact single-mine expectation (3444.0051) + genuine multi-stream Monte Carlo SE > 0 & candidate ranking by policyExpectedValue', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  // Subcase A: Single `mine` (`en = 3`, `pick = 4`, `mine.max = 30`) -> exact discrete expectation `3444.005129428605 D` (`SE = 0`)
  // and invariant across `rev = 1..5`!
  for (const rev of [1, 2, 3, 4, 5]) {
    const wSingle = makeWorld(adapter, t0, {
      rev,
      state: {
        en: 3,
        enT: t0,
        tools: { hoe: 1, can: 1, rod: 1, pick: 4, axe: 1 },
        mine: { depth: 30, max: 30 },
        inv: {},
      },
    })
    const envSingle = buildObservationEnvelope(adapter, { world: wSingle, account: 'main' })
    const planSingle = solveUnifiedPlan(adapter, envSingle, buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' }), {
      scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
      allowedActionTypes: ['mine', 'sell', 'wait'],
    })
    assert.equal(planSingle.quality.valueInterpretation, 'exact-discrete-policy-expectation')
    assert.equal(planSingle.quality.standardError, 0)
    assert.ok(
      Math.abs(planSingle.quality.feasibleIncumbentValue - 3444.005129428605) < 1e-2,
      `Expected ~3444.0051 at rev=${rev}, got ${planSingle.quality.feasibleIncumbentValue}`
    )
  }

  // Subcase B: Multi-hit `mine` (`en = 6`, 2 hits) -> Monte Carlo policy expectation across distinct `rand` streams (`standardError > 0`)!
  const wMulti = makeWorld(adapter, t0, {
    state: {
      en: 6,
      enT: t0,
      tools: { hoe: 1, can: 1, rod: 1, pick: 4, axe: 1 },
      mine: { depth: 30, max: 30 },
      inv: {},
    },
  })
  const envMulti = buildObservationEnvelope(adapter, { world: wMulti, account: 'main' })
  const planMulti = solveUnifiedPlan(adapter, envMulti, buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['mine', 'sell', 'wait'],
    stochasticPolicySamples: 16,
  })
  assert.equal(planMulti.quality.valueInterpretation, 'monte-carlo-policy-expectation')
  assert.ok(planMulti.quality.standardError > 0, `Expected non-zero Monte Carlo SE from distinct rand streams, got ${planMulti.quality.standardError}`)
  assert.ok(
    planMulti.quality.feasibleIncumbentValue > 5500 && planMulti.quality.feasibleIncumbentValue < 9000,
    `Expected ~6888 D over 2 mine hits, got ${planMulti.quality.feasibleIncumbentValue}`
  )
})

test('Phase 6.2 (Codex Round-2 P1-2): Bundle-aware cargo stockBuy buys 3 corn -> crafts 1 popcorn -> sells for 18500 D (+4100 D net) on 1 remaining workshop slot', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  // Exact Codex Round-2 reproduction:
  // `coins = 14400`, `en = 1`, `iq.craft = 79` (1 slot free!), `inv = {}`, `allowed = ['stockBuy', 'craft', 'sell', 'wait']`.
  // Cargo offers `corn` at `4800 D` (`3 * 4800 = 14400 D`), crafting `1` `popcorn` (`1` slot, `1` en) sells for `18500 D` (`+4100 D` net)!
  const world = makeWorld(adapter, t0, {
    coins: 14400,
    state: {
      en: 1,
      enT: t0,
      iq: { d: adapter.R.isleIndex(t0), craft: 79, mine: 0, fish: 0, bomb: 0 },
      inv: {},
    },
  })

  const env = buildObservationEnvelope(adapter, {
    world,
    account: 'main',
    userConstraints: { cashReserveFloor: 0 },
  })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 600, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['stockBuy', 'craft', 'sell', 'wait'],
  })

  const acts0 = plan.trunkBuckets[0]?.domesticActions || []
  assert.ok(
    acts0.some((a) => a.a === 'stockBuy' && a.id === 'corn' && a.n === 3),
    `Expected stockBuy(corn, 3), got ${JSON.stringify(acts0)}`
  )
  assert.ok(
    acts0.some((a) => a.a === 'craft' && a.id === 'popcorn' && a.n === 1),
    `Expected craft(popcorn, 1), got ${JSON.stringify(acts0)}`
  )
  assert.ok(
    acts0.some((a) => a.a === 'sell' && a.id === 'popcorn' && a.n === 1),
    `Expected sell(popcorn, 1), got ${JSON.stringify(acts0)}`
  )
  assert.equal(plan.quality.feasibleIncumbentValue, 18500)

  const comp = compileExecutablePrefix(adapter, world, plan)
  assert.equal(comp.status, 'ready')
})

test('Phase 6.3 (Codex Round-2 P1-3): Joint cash constraint between coffee (15000 D) and shop bomb (3200 D) never burns 15000 D on coffee with 0 cash left for bombs', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  // Subcase A: Exact Codex Round-2 reproduction (`coins = 15000, en = 0, allowed = ['coffee', 'bomb', 'buy', 'sell', 'wait']`):
  // Buying coffee leaves `coins = 0`, which cannot afford any `3200 D` shop bomb (`-15000 D` loss). Solver MUST keep `coins = 15000` (`[]`)!
  const wTight = makeWorld(adapter, t0, {
    coins: 15000,
    state: {
      en: 0,
      enT: t0,
      tools: { hoe: 1, can: 1, rod: 1, pick: 4, axe: 1 },
      mine: { depth: 30, max: 30 },
      inv: {},
    },
  })
  const envTight = buildObservationEnvelope(adapter, {
    world: wTight,
    account: 'main',
    userConstraints: { cashReserveFloor: 0 },
  })
  const planTight = solveUnifiedPlan(adapter, envTight, buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['coffee', 'bomb', 'buy', 'sell', 'wait'],
  })
  const actsTight = planTight.trunkBuckets[0]?.domesticActions || []
  assert.equal(
    actsTight.some((a) => a.a === 'coffee'),
    false,
    `Must NOT buy coffee when post-coffee cash is 0 and cannot fund any shop bomb! Got ${JSON.stringify(actsTight)}`
  )
  assert.equal(planTight.quality.feasibleIncumbentValue, 15000)

  // Subcase B: With `coins = 45000` (`15000` coffee + `9 * 3200 = 28800` bombs = `43800 <= 45000`),
  // post-coffee cash funds 9 profitable bombs whose net ore margin exceeds the 15000 D coffee cost!
  const wFunded = makeWorld(adapter, t0, {
    coins: 45000,
    state: {
      en: 0,
      enT: t0,
      tools: { hoe: 1, can: 1, rod: 1, pick: 4, axe: 1 },
      mine: { depth: 30, max: 30 },
      inv: {},
    },
  })
  const envFunded = buildObservationEnvelope(adapter, {
    world: wFunded,
    account: 'main',
    userConstraints: { cashReserveFloor: 0 },
  })
  const planFunded = solveUnifiedPlan(adapter, envFunded, buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['coffee', 'bomb', 'buy', 'sell', 'wait'],
  })
  const actsFunded = planFunded.trunkBuckets[0]?.domesticActions || []
  assert.equal(actsFunded.some((a) => a.a === 'coffee'), true, 'Must buy coffee when post-coffee cash funds enough profitable shop bombs to beat 15000 D')
  assert.equal(actsFunded.some((a) => a.a === 'buy' && a.id === 'bomb' && a.n >= 6), true)
  assert.equal(actsFunded.some((a) => a.a === 'bomb'), true)
  assert.ok(planFunded.quality.feasibleIncumbentValue > 45000, `Expected net profit above 45000 D initial coins, got ${planFunded.quality.feasibleIncumbentValue}`)

  // Subcase C: Multi-unit low-star-first `eat` reachability (`2` `q=0` turnips at `+8 en` each = `+16 en`
  // unlock `2` `6 en` bombs (`12 en` total) from `en = 0`, whereas 1-step lookahead would have eaten `q=2` (`+12 en`)!)
  const wEat = makeWorld(adapter, t0, {
    coins: 0,
    state: {
      en: 0,
      enT: t0,
      tools: { hoe: 1, can: 1, rod: 1, pick: 4, axe: 1 },
      mine: { depth: 30, max: 30 },
      inv: { turnip: [2, 0, 2], bomb: [2, 0, 0] },
    },
  })
  const envEat = buildObservationEnvelope(adapter, { world: wEat, account: 'main' })
  const planEat = solveUnifiedPlan(adapter, envEat, buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['eat', 'bomb', 'sell', 'wait'],
  })
  const actsEat = planEat.trunkBuckets[0]?.domesticActions || []
  const eatActs = actsEat.filter((a) => a.a === 'eat')
  assert.equal(eatActs.length, 2, `Expected 2 q=0 turnips eaten to reach 12 en for 2 bombs, got ${JSON.stringify(eatActs)}`)
  assert.ok(eatActs.every((a) => a.id === 'turnip' && a.q === 0), `Must eat q=0 before q=2, got ${JSON.stringify(eatActs)}`)
  assert.equal(actsEat.filter((a) => a.a === 'bomb').length, 2)
})

test('Phase 6.4 (Codex Round-3 P1): Unified Cargo-Edible stockBuy -> eat -> craft/work & per-copy dual-use split', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794398401
  const isleDayStr = adapter.R.isleDay(t0)
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = adapter.R.priceOf(id, isleDayStr, 0)
  }

  const cnt = { coffee: 3 }
  for (const id of adapter.graph.sellableIds) cnt['sc_' + id] = 400

  const wCargoEat = makeWorld(adapter, t0, {
    coins: 6500,
    prices,
    state: {
      en: 0,
      enT: t0,
      inv: { wool: [40, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 0, mine: 100, fish: 80, bomb: 10 },
      cnt,
    },
  })
  const envCargoEat = buildObservationEnvelope(adapter, {
    world: wCargoEat,
    account: 'main',
    userConstraints: { cashReserveFloor: 0 },
  })
  const planCargoEat = solveUnifiedPlan(
    adapter,
    envCargoEat,
    buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    { scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }
  )

  const acts = planCargoEat.trunkBuckets[0]?.domesticActions || []
  const turnipBuy = acts.find((a) => a.a === 'stockBuy' && a.id === 'turnip')
  assert.ok(turnipBuy && turnipBuy.n >= 3, `Expected cargo stockBuy(turnip >= 3) to fund stamina, got ${JSON.stringify(acts)}`)
  const turnipEats = acts.filter((a) => a.a === 'eat' && a.id === 'turnip' && a.q === 0)
  assert.equal(turnipEats.length, 3, `Expected 3 cargo turnips eaten (+24 en) to unlock 20 sweaters, got ${JSON.stringify(acts)}`)
  assert.equal(
    acts.some((a) => a.a === 'craft' && a.id === 'sweater' && a.n === 20),
    true,
    `Expected craft(sweater, 20) unlocked by cargo-bought turnips, got ${JSON.stringify(acts)}`
  )
  // Must strictly beat BOTH old direct-only 1,350,720 D AND pure 3-turnip 1,426,280 D (achieves 1,427,823 D via per-copy eat + resale split)!
  assert.ok(
    planCargoEat.quality.feasibleIncumbentValue >= 1426280,
    `Expected feasibleIncumbentValue >= 1,426,280 D, got ${planCargoEat.quality.feasibleIncumbentValue}`
  )
  assert.equal(planCargoEat.quality.pruning.candidateSetComplete, true)
  assert.equal(planCargoEat.quality.pruning.innerPruningApplied, false)
})

test('Phase 6.5 (Codex Round-3 P2): Honest incumbentCashDiscretization disclosure on coarse binding cash grids & exact non-binding rich grids', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794398401
  const isleDayStr = adapter.R.isleDay(t0)
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = adapter.R.priceOf(id, isleDayStr, 0)
  }

  // Subcase A: Binding scarce cash (`coins = 25000` < total coffee + bomb + cargo demand, with binding slots `S = 2` so `maxCashCells = 400 < 25000 / 10`)
  const wDiscretized = makeWorld(adapter, t0, {
    coins: 25000,
    prices,
    state: {
      en: 0,
      enT: t0,
      inv: { wool: [40, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 78, mine: 0, fish: 0, bomb: 0 },
      cnt: { coffee: 0 },
    },
  })
  const envDiscretized = buildObservationEnvelope(adapter, {
    world: wDiscretized,
    account: 'main',
    userConstraints: { cashReserveFloor: 0 },
  })
  const planDiscretized = solveUnifiedPlan(
    adapter,
    envDiscretized,
    buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    { scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }
  )
  assert.equal(planDiscretized.quality.pruning.upperBoundComplete, true, 'Independent Lagrangian upper bound remains complete')
  assert.equal(planDiscretized.quality.pruning.incumbentCashDiscretization.cashDiscretized, true)
  assert.ok(planDiscretized.quality.pruning.incumbentCashDiscretization.maxCashUnit > planDiscretized.quality.pruning.incumbentCashDiscretization.minExactGcd)
  assert.equal(planDiscretized.quality.pruning.candidateSetComplete, false, 'Must disclose candidateSetComplete=false when cashUnit > rawGcd')
  assert.equal(planDiscretized.quality.pruning.innerPruningApplied, true, 'Must disclose innerPruningApplied=true when cashUnit > rawGcd')

  // Subcase B: Rich account (`coins = 50,000,003` >> total possible DP spend) -> cash axis is provably non-binding (`C = 0`, zero discretization)
  const wRich = makeWorld(adapter, t0, {
    coins: 50000003,
    prices,
    state: {
      en: 0,
      enT: t0,
      inv: { wool: [40, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 78, mine: 0, fish: 0, bomb: 0 },
      cnt: { coffee: 0 },
    },
  })
  const envRich = buildObservationEnvelope(adapter, {
    world: wRich,
    account: 'main',
    userConstraints: { cashReserveFloor: 0 },
  })
  const planRich = solveUnifiedPlan(
    adapter,
    envRich,
    buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    { scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }] }
  )
  assert.equal(planRich.quality.pruning.incumbentCashDiscretization.cashDiscretized, false)
  assert.equal(planRich.quality.pruning.candidateSetComplete, true)
  assert.equal(planRich.quality.pruning.innerPruningApplied, false)
})
