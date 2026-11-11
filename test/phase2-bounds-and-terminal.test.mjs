import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope, quoteFutureItemUnderScenario } from '../model/observations.mjs'
import {
  buildObjectiveConfig,
  detectRollingDeferral,
  evaluateTerminalLiquidationTail,
} from '../model/objective.mjs'
import { computeValidUpperBound } from '../planner/bounds.mjs'
import { buildEventBuckets } from '../planner/resources.mjs'
import { solveUnifiedPlan, solveWithHorizonStability } from '../planner/solve.mjs'
import { auditDecisionAgainstReference } from '../audit/reference-solver.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeBaseWorld(adapter, nowSec = 1794340000, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plots = Array(s.plotN).fill(null)
  s.barn = []
  s.traps = []
  s.en = 50
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
    coins: 0,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

test('Phase 2B.1: Certified Weak-Duality Upper Bound satisfies L <= exactOpt <= U across deterministic instances', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  const instances = [
    // Instance 1: Craft chain vs direct sell
    {
      inv: { gold: [4, 0, 0], coal: [2, 0, 0], diamond: [2, 0, 0] },
      craftUsed: 78,
      arrivals: [],
    },
    // Instance 2: Scarce craft slot + future arrival + crop tier boundary
    {
      inv: { turnip: [3, 0, 0], carrot: [3, 0, 0], strawberry: [4, 0, 2] },
      craftUsed: 79,
      sc_strawberry: 149,
      arrivals: [{ atSec: t0 + 60, items: [{ id: 'strawberry', q: 0, n: 4 }] }],
    },
  ]

  for (const inst of instances) {
    const world = makeBaseWorld(adapter, t0, {
      state: {
        enDay: adapter.R.worldDay(t0),
        cnt: inst.sc_strawberry ? { sc_strawberry: inst.sc_strawberry } : {},
        inv: inst.inv,
        iq: { d: adapter.R.isleIndex(t0), craft: inst.craftUsed },
        en: 20,
      },
    })
    const cfg = buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' })
    const env = buildObservationEnvelope(adapter, {
      world,
      scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    })
    const plan = solveUnifiedPlan(adapter, env, cfg, {
      deterministicArrivals: inst.arrivals,
      allowedActionTypes: ['sell', 'craft', 'wait'],
    })
    const exactRef = auditDecisionAgainstReference(adapter, {
      worldBefore: world,
      actualFirstActions: plan.trunkBuckets[0].domesticActions,
      scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
      deterministicArrivals: inst.arrivals,
      objectiveCfg: cfg,
      allowedActionTypes: ['sell', 'craft', 'wait'],
    })

    const L = plan.quality.feasibleIncumbentValue
    const optStar = exactRef.bestAlternative.value
    const U = plan.quality.validUpperBound

    assert.ok(U != null, 'Deterministic sell/craft/wait subproblem must certify a non-null weak-duality upper bound')
    assert.ok(L <= optStar + 1e-6, `Feasible incumbent L (${L}) must never exceed exactOpt (${optStar})`)
    assert.ok(optStar <= U + 1e-6, `Weak-duality upper bound U (${U}) must never fall below exactOpt (${optStar})`)
  }
})

test('Phase 2B.2: Pruned inner candidate set or stochastic action strictly refuses to claim validUpperBound', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeBaseWorld(adapter, t0, {
    state: { inv: { strawberry: [10, 0, 0] } },
  })
  const timeline = buildEventBuckets(adapter, world, { horizonSec: 300 })

  // 1) Pruned inner set (round2 §2 counterexample guard: never report invalid U < opt*!)
  const prunedBound = computeValidUpperBound(adapter, {
    world,
    buckets: timeline.buckets,
    pricesByBucket: [world.prices],
    candidateSetComplete: false,
    innerPruningApplied: true,
  })
  assert.equal(prunedBound.validUpperBound, null)
  assert.equal(prunedBound.status, 'refused-pruned-inner')

  // 2) Stochastic action active (`mine`) -> refuses deterministic bound
  const stochBound = computeValidUpperBound(adapter, {
    world,
    buckets: timeline.buckets,
    pricesByBucket: [world.prices],
    allowedActionTypes: ['sell', 'mine'],
  })
  assert.equal(stochBound.validUpperBound, null)
  assert.equal(stochBound.status, 'not-applicable-stochastic')
})

test('Phase 2B.3: Executable terminal liquidation tail values 1 strawberry at sc=400 & quote=1900 at exact 1330 (not naive 2640)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tH = 1794340000
  const worldAtH = makeBaseWorld(adapter, tH, {
    coins: 100000,
    state: {
      enDay: adapter.R.worldDay(tH),
      cnt: { sc_strawberry: 400 }, // 70% tier!
      inv: {
        strawberry: [3, 0, 0], // 1 available + 2 locked in vault!
        bomb: [5, 0, 0],       // unsellable utility item -> must contribute 0!
      },
      b12: {
        v: 1,
        vault: { strawberry: [2, 0, 0] },
      },
    },
  })

  // Quote = 1900 (e.g. conservative 0.8 supply * 0.8 market/event depression):
  // Available = 3 - 2 = 1 strawberry; at sc = 400 (70% tier): Math.round(1900 * 0.70) = 1330!
  const tail = evaluateTerminalLiquidationTail(adapter, worldAtH, {
    initialWorld: worldAtH,
    objectiveCfg: buildObjectiveConfig({ terminalSupplyMode: 'conservative-floor' }),
    explicitTerminalPrices: { ...worldAtH.prices, strawberry: 1900 },
  })

  assert.equal(tail.allBatchesValid, true)
  assert.equal(tail.netLiquidationCash, 1330)
  assert.equal(tail.totalTerminalValue, 1330)
})

test('Phase 2B.4: Rolling-horizon p(t) = 100 - 1/(t+1) deferral pathology prevented by executable terminal tail & detected by audit', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeBaseWorld(adapter, t0, {
    prices: { ...Object.fromEntries(adapter.graph.sellableIds.map((k) => [k, 100])), turnip: 99 },
    state: { inv: { turnip: [10, 0, 0] } },
  })

  // 1) Under conservative terminal floor (where future conservative floor <= 99), unified solver sells immediately at t0!
  const env = buildObservationEnvelope(adapter, {
    world,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 0.8 }],
  })
  const stab = solveWithHorizonStability(
    adapter,
    env,
    buildObjectiveConfig({
      horizonSec: 3600,
      extendedHorizonDeltaSec: 3600,
      terminalSupplyMode: 'conservative-floor',
      continuationIsleDays: 0,
    }),
    { allowedActionTypes: ['sell', 'wait'] }
  )
  assert.equal(stab.prefixStable, true)
  assert.deepEqual(stab.basePlan.trunkBuckets[0].domesticActions, [{ a: 'sell', id: 'turnip', q: 0, n: 10 }])

  // 2) And if a broken rolling-endpoint agent shifts planned sell time forward 3 times without executing:
  const deferralCheck = detectRollingDeferral([
    { itemId: 'turnip', atSec: t0, plannedSellAtSec: t0 + 3600, executedSellQty: 0, newExternalShock: false },
    { itemId: 'turnip', atSec: t0 + 3600, plannedSellAtSec: t0 + 7200, executedSellQty: 0, newExternalShock: false },
    { itemId: 'turnip', atSec: t0 + 7200, plannedSellAtSec: t0 + 10800, executedSellQty: 0, newExternalShock: false },
  ])
  assert.equal(deferralCheck.rollingDeferralDetected, true)
  assert.equal(deferralCheck.shifts, 2)
})

test('Phase 2B.5: Multi-bucket trunk non-anticipativity before nextIsleAt & endogenous self-sale impact at nextIsleAt', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000 // nextIsleAt = 1794369600
  const world = makeBaseWorld(adapter, t0, {
    prices: { ...Object.fromEntries(adapter.graph.sellableIds.map((k) => [k, 1000])), turnip: 540 },
    state: { inv: { turnip: [50, 0, 0] } },
  })

  // Create an intra-isle-day event at t0 + 600 (STILL isleDayOffset === 0 before nextIsleAt!)
  // AND horizon spanning past nextIsleAt into isleDayOffset === 1 across 3 external supply scenarios!
  const arrivals = [{ atSec: t0 + 600, items: [{ id: 'turnip', q: 0, n: 20 }] }]
  const env = buildObservationEnvelope(adapter, {
    world,
    scenarios: [
      { id: 'tight', weight: 0.3, externalSupplyFactor: 1.05 },
      { id: 'mid', weight: 0.4, externalSupplyFactor: 0.95 },
      { id: 'glut', weight: 0.3, externalSupplyFactor: 0.82 },
    ],
  })
  const plan = solveUnifiedPlan(
    adapter,
    env,
    buildObjectiveConfig({ horizonSec: 32000 }),
    { deterministicArrivals: arrivals, allowedActionTypes: ['sell', 'wait'] }
  )

  // Both bucket 0 (t0) and bucket 1 (t0 + 600) are before nextIsleAt (`isleDayOffset === 0`),
  // so BOTH belong to the single shared non-anticipative `trunkBuckets`!
  assert.ok(plan.trunkBuckets.length >= 2)
  assert.ok(plan.trunkBuckets.every((b) => b.isTrunkBeforePriceReveal === true && b.isleDayOffset === 0))
  assert.equal(Object.keys(plan.scenarioBranches).length, 3)

  // Verify endogenous self-sale supply factor impact formula `-0.3 * selfSoldPrevIsleDay / marketDepth`
  const nextIsleStr = adapter.R.isleDay(world.nextIsleAt + 10)
  const qZeroSelf = quoteFutureItemUnderScenario(adapter, {
    itemId: 'pumpkin',
    isleDayIndex: 1,
    isleDayStr: nextIsleStr,
    currentPrices: world.prices,
    externalSupplyFactor: 1.04,
    selfSoldPrevIsleDay: 0,
  })
  const qHeavySelf = quoteFutureItemUnderScenario(adapter, {
    itemId: 'pumpkin',
    isleDayIndex: 1,
    isleDayStr: nextIsleStr,
    currentPrices: world.prices,
    externalSupplyFactor: 1.04,
    selfSoldPrevIsleDay: 400, // pumpkin marketDepth = max(800, round(1.6M/9000)) = 800 -> -0.3 * 0.5 = -0.15!
  })
  assert.ok(qHeavySelf < qZeroSelf, `Heavy self sales (${qHeavySelf}) must depress next isle-day quote below zero-sale quote (${qZeroSelf})`)
})
