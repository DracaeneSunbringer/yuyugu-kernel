import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope, sanitizeWorldSnapshot } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld } from '../execution/reconcile.mjs'
import { auditTransactionReplay } from '../audit/replay.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { runControllerStep } from '../cli/controller.mjs'

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

test('Phase 5.1 (Codex P1-1A): Unified Stamina Knapsack chooses higher-EV/en mine (3 en) over hardcoded fish-before-mine (4 en)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, {
    coins: 0,
    state: {
      en: 4,
      enT: t0,
      tools: { hoe: 1, can: 1, rod: 1, pick: 4, axe: 1 },
      mine: { depth: 30, max: 30 },
      inv: {},
    },
  })

  const env = buildObservationEnvelope(adapter, { world, account: 'main' })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 300 }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['fish', 'mine', 'sell', 'wait'],
  })

  const acts0 = plan.trunkBuckets[0]?.domesticActions || []
  assert.equal(acts0.some((a) => a.a === 'mine'), true, 'Must choose mine (3 en, ~3444 D) over Lv1 fish (4 en, ~1108 D)')
  assert.equal(acts0.some((a) => a.a === 'fish'), false, 'Must NOT starve mine by greedily running fish first')
})

test('Phase 5.2 (Codex P1-1B): Saturated workshop (iq.craft = 80/80) never hallucinates recipe margin to buy overpriced cargo', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  // Verify `grape` is genuinely offered by `R.b12Stock(t0, world.prices)` at `t0`!
  // With `prices.grape = 5700` and `sc_grape = 400`, cargo price is `5700 D`, direct raw resale is `5700 * 0.70 = 3990 D < 5700 D`,
  // while `wine` (`36000 D` for `3` grapes = `12000 D/grape`) would be profitable ONLY if a workshop slot were free!
  // Since `iq.craft = 80/80` and horizon stays within the same isle-day, buying cargo would strictly lose `-1710 D/unit`!
  const world = makeWorld(adapter, t0, {
    coins: 50000,
    state: {
      en: 20,
      enT: t0,
      iq: { d: adapter.R.isleIndex(t0), craft: 80, mine: 0, fish: 0, bomb: 0 },
      cnt: { d: adapter.R.worldDay(t0), sc_grape: 400 },
    },
  })
  world.prices.grape = 5700
  const cargoItems = adapter.R.b12Stock(t0, world.prices)
  const grapeCargo = cargoItems.find((x) => x.id === 'grape')
  assert.ok(grapeCargo && grapeCargo.price > 0, 'Fixture check: grape must be an active cargo item in R.b12Stock(t0)')

  const env = buildObservationEnvelope(adapter, { world, account: 'main' })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 600, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['stockBuy', 'craft', 'sell', 'wait'],
  })

  const acts0 = plan.trunkBuckets[0]?.domesticActions || []
  assert.equal(acts0.filter((a) => a.a === 'stockBuy').length, 0, 'Must NOT buy overpriced cargo when workshop is 80/80 saturated!')
})

test('Phase 5.3 (Codex P1-1C): Mechanical CapEx trajectory delta rejects non-payback CapEx with zero magic constants', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, {
    coins: 500000,
    state: {
      en: 20,
      enT: t0,
      plotN: 6,
      plots: Array(6).fill(null),
      barn: [],
    },
  })

  const env = buildObservationEnvelope(adapter, {
    world,
    account: 'secondary',
    userConstraints: { maxCapexPaybackSec: 3600 },
  })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 1800 }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })

  const capexActs = (plan.trunkBuckets[0]?.domesticActions || []).filter((a) =>
    ['expand', 'buyAnimal', 'buyTrap', 'upgrade'].includes(a.a)
  )
  assert.equal(capexActs.length, 0, 'CapEx that fails counterfactual trajectory payback within maxCapexPaybackSec must be rejected!')
})

test('Phase 5.4 (Codex P1-1D): Sequential conditional multi-raid packing prevents double-counting scarce craft slot & preserves t0+minGap post-prep timeline', async () => {
  const tmpRulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-p54-'))
  const rawSource = fs.readFileSync(RULES_PATH, 'utf8')
  // Patch `sack` (`slot: 'carry'`) thief item price to 12,000 D:
  // - 1 craft slot free (`iq.craft = 79`), `sc_strawberry = 400`, 2 unguarded neighbors each holding 2 stealable strawberry plots.
  // - Without `sack` (`unitsPerSpot = 1`): Raid 1 + Raid 2 steal 2 + 2 = 4 strawberries -> 1 jam = 17,000 D.
  // - With `sack` (`unitsPerSpot = 2`): Raid 1 + Raid 2 steal 4 + 4 = 8 strawberries -> 1 jam (17,000) + 4 raw at 0.70x (9,240) = 26,240 D.
  // - True incremental value of `sack` is +9,240 D < 12,000 D (net 14,240 < 17,000), whereas naive independent scoring
  //   would double-count the single craft slot on BOTH raids (34,000 - 12,000 = 22,000 > 9,240) and mistakenly buy `sack`!
  const customSource = rawSource.replace(
    /sack:\s*\{([^}]*?)price:\s*\d+/,
    'sack: {$1price: 12000'
  )
  const customRulesPath = path.join(tmpRulesDir, 'custom-rules.mjs')
  fs.writeFileSync(customRulesPath, customSource, 'utf8')
  const customAdapter = await loadRulesAdapterFromFile(customRulesPath, { clockStart: CLOCK_START })
  assert.equal(customAdapter.R.THIEF_ITEMS.sack.price, 12000, 'Fixture check: sack price must be patched to 12000')

  const t0 = 1794340000
  const world = makeWorld(customAdapter, t0, {
    coins: 50000,
    state: {
      en: 20,
      enT: t0,
      enDay: customAdapter.R.worldDay(t0),
      iq: { d: customAdapter.R.isleIndex(t0), craft: 79, mine: 0, fish: 0, bomb: 0 },
      cnt: { sc_strawberry: 400 },
      b12: { thief: {} },
    },
  })

  const makeTarget = (id) => ({
    id,
    owner: { id, name: `Neighbor-${id}`, guard: false },
    isle: {
      guard: false,
      plots: [
        { c: 'strawberry', steal: true },
        { c: 'strawberry', steal: true },
      ],
    },
  })
  const neighbors = [makeTarget(901), makeTarget(902)]

  const env = buildObservationEnvelope(customAdapter, {
    world,
    account: 'main',
    neighborTargets: neighbors,
    userConstraints: { maxStealsPerIsleDay: 2, minStealSpots: 2 },
  })
  const plan = solveUnifiedPlan(customAdapter, env, buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    rawNeighborTargetsById: new Map(neighbors.map((n) => [n.id, n])),
    allowedActionTypes: ['buy', 'craft', 'sell', 'visit', 'wait'],
  })

  const prepActs = plan.trunkBuckets[0]?.domesticActions || []
  assert.equal(
    prepActs.some((a) => a.a === 'buy' && a.id === 'sack'),
    false,
    'Sequential multi-raid packing must NOT double-count the single free workshop slot to buy overpriced sack (12,000 > 9,240)!'
  )
  assert.equal(plan.trunkBuckets[0]?.visitActions.length, 1)

  // Also verify post-prep continuation timeline (`t0` prep -> `t0 + minGap` domestic continuation) when `en = 0` requires coffee prep!
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const worldZeroEn = makeWorld(adapter, t0, {
    coins: 200000,
    state: {
      en: 0,
      enT: t0,
      inv: { turnip: [5, 0, 0] },
      b12: { thief: { stealth: t0 + 3600, carry: t0 + 3600, sprint: t0 + 3600 } },
    },
  })
  const bigTarget = {
    id: 999,
    owner: { id: 999, name: 'BigBerry', guard: false },
    isle: {
      guard: false,
      plots: Array(6).fill({ c: 'strawberry', steal: true }),
    },
  }
  const envPrep = buildObservationEnvelope(adapter, {
    world: worldZeroEn,
    account: 'main',
    neighborTargets: [bigTarget],
    userConstraints: { maxStealsPerIsleDay: 1, minStealSpots: 2 },
  })
  const planPrep = solveUnifiedPlan(adapter, envPrep, buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    rawNeighborTargetsById: new Map([[999, bigTarget]]),
    allowedActionTypes: ['coffee', 'sell', 'visit', 'wait'],
  })

  assert.equal(planPrep.trunkBuckets[0].atSec, t0)
  assert.deepEqual(planPrep.trunkBuckets[0].domesticActions, [{ a: 'coffee' }])
  assert.equal(planPrep.trunkBuckets.length >= 2, true)
  assert.equal(planPrep.trunkBuckets[1].atSec, t0 + (adapter.R.WORLD?.minGap || 2))
})

test('Phase 5.5 (Codex P1-2): Exact discrete harvest expectation (5046.5338) is invariant across rev=1..6 and marks containsStochasticAction', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  // Find a timestamp whose isleDay season includes tomato (`summer` or `autumn`)!
  let tSummer = 1794340000
  while (!adapter.R.CROPS.find((c) => c.id === 'tomato').seasons.includes(adapter.R.seasonOf(adapter.R.isleDay(tSummer)))) {
    tSummer += 4 * 3600
  }

  for (const rev of [1, 2, 3, 4, 5, 6]) {
    const world = makeWorld(adapter, tSummer, {
      rev,
      prices: { ...Object.fromEntries([...adapter.graph.sellableIds].map((id) => [id, Number(adapter.R.BASE_PRICE[id])])), tomato: 2550 },
      state: {
        en: 10,
        enT: tSummer,
        plots: [{ c: 'tomato', t: tSummer - 3600, g: 86400, w: 3 }, ...Array(5).fill(null)],
      },
    })
    const env = buildObservationEnvelope(adapter, { world, account: 'main' })
    const objCfg = buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' })
    const plan = solveUnifiedPlan(adapter, env, objCfg, {
      scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
      allowedActionTypes: ['harvest', 'sell', 'wait'],
    })

    assert.equal(plan.quality.valueInterpretation, 'exact-discrete-policy-expectation')
    assert.equal(plan.quality.standardError, 0)
    assert.ok(
      Math.abs(plan.quality.feasibleIncumbentValue - 5046.5338) < 1e-2,
      `Expected ~5046.5338 at rev=${rev}, got ${plan.quality.feasibleIncumbentValue}`
    )

    const compiled = compileExecutablePrefix(adapter, world, plan)
    assert.equal(compiled.containsStochasticAction, true)
    assert.equal(compiled.visitOperations.length, 0)
  }
})

test('Phase 5.6 (Codex P1-3): tide_snack stamina relaxation satisfies strict weak-duality U >= L with zero bound violations', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, {
    state: {
      en: 0,
      enT: t0,
      inv: { wool: [40, 0, 0], tide_snack: [1, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 60, mine: 0, fish: 0, bomb: 0 },
    },
  })

  const env = buildObservationEnvelope(adapter, {
    world,
    account: 'main',
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }), {
    allowedActionTypes: ['sell', 'craft', 'eat', 'wait'],
  })

  assert.notEqual(plan.quality.solverStatus, 'bound-violation-error')
  assert.ok(plan.quality.validUpperBound != null, 'Must compute a non-null certified weak-duality upper bound')
  assert.ok(plan.quality.feasibleIncumbentValue > 900000, `Expected high craft value from eating tide_snack, got ${plan.quality.feasibleIncumbentValue}`)
  assert.ok(
    plan.quality.validUpperBound + 1e-6 >= plan.quality.feasibleIncumbentValue,
    `Upper bound ${plan.quality.validUpperBound} must dominate incumbent ${plan.quality.feasibleIncumbentValue}!`
  )
})

test('Phase 5.7 (Codex P1-4A & P1-4B): Multi-batch intra-bucket split has 0 false regret & stochastic replay enforces receipt conservation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  // 2026-11-11 22:30:00 UTC+8 = 2026-11-11T14:30:00Z (`5400s` before 00:00 natural-day midnight reset!)
  const t2230 = Math.floor(Date.parse('2026-11-11T14:30:00Z') / 1000)

  const world = makeWorld(adapter, t2230, {
    prices: { ...Object.fromEntries([...adapter.graph.sellableIds].map((id) => [id, Number(adapter.R.BASE_PRICE[id])])), strawberry: 900 },
    state: {
      en: 20,
      enT: t2230,
      enDay: adapter.R.worldDay(t2230),
      inv: { strawberry: [300, 0, 0] },
      cnt: { sc_strawberry: 0 },
    },
  })

  // Selling 50 strawberries now leaves 5398s before midnight to sell the remaining 100 tier-1.0x quota at t0+2s,
  // and 150 after midnight at tier-1.0x -> total 300 * 900 = 270,000 D with ZERO true regret!
  const rep = await buildAuditDecisionReport({
    adapter,
    worldBefore: world,
    actualFirstActions: [{ a: 'sell', id: 'strawberry', q: 0, n: 50 }],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 3 * 3600, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['sell', 'wait'],
  })

  assert.equal(rep.reference.actualContinuationValue, 270000)
  assert.equal(rep.reference.actualContinuationUpperBound, 270000)
  assert.equal(rep.identifiableDecisionRegretLowerBound, 0)
  assert.equal(rep.verdict, 'ex-ante-consistent')

  // P1-4B: Receipt-conditioned stochastic conservation check in `auditTransactionReplay`!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-p14b-'))
  const journal = new ContentAddressedJournal({ rootDir: tmpDir, account: 'main' })
  journal.archiveRulesSource(adapter.rulesHash, adapter.rulesSourceText)

  const mineBefore = makeWorld(adapter, 1794340000, {
    coins: 1000,
    state: {
      en: 10,
      enT: 1794340000,
      inv: {},
      iq: { d: adapter.R.isleIndex(1794340000), craft: 0, mine: 0, fish: 0, bomb: 0 },
    },
  })
  // Corrupted `stateAfter` claims `iron: [99, 0, 0]` even though receipt `out[0].got` only yielded `{ coal: 2 }` (while coins match = 1000)!
  const corruptedAfter = structuredClone(mineBefore)
  corruptedAfter.rev = 2
  corruptedAfter.state.en = 7
  corruptedAfter.state.iq.mine = 1
  corruptedAfter.state.inv = { iron: [99, 0, 0] }

  const beforeRef = journal.writeBlob(sanitizeWorldSnapshot(mineBefore))
  const afterRef = journal.writeBlob(sanitizeWorldSnapshot(corruptedAfter))
  const reqRef = journal.writeBlob({ actions: [{ a: 'mine' }], operation: 'op-corrupt-mine' })
  const resRef = journal.writeBlob({
    ok: true,
    spend: 0,
    earn: 0,
    out: [{ a: 'mine', ok: true, got: { coal: 2 } }],
  })

  journal.appendEvent({
    recordType: 'tx-transition',
    operation: 'op-corrupt-mine',
    decisionId: 'dec-corrupt-mine',
    kind: 'act',
    status: 'confirmed',
    rulesHash: adapter.rulesHash,
    stateBeforeRef: beforeRef,
    stateAfterRef: afterRef,
    requestRef: reqRef,
    responseRef: resRef,
  })

  const tx = journal.reconstructTransactions().txMap.get('op-corrupt-mine')
  const replayRes = await auditTransactionReplay(journal, tx, { fallbackAdapter: adapter })
  assert.equal(replayRes.receiptStateConservationOk, false)
  assert.equal(replayRes.verdict, 'model-drift')
})

test('Phase 5.8 (Codex P1-5 & P2): In-lock stale pre-state abort, honest unattributed unknown reconcile, and auto-reconstructed audit report', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-p15-'))
  const lockDir = path.join(tmpDir, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })

  // 1) Two concurrent callers planned on the SAME `worldBefore (rev: 1)` attempting to spend 15,000 D on coffee!
  const sharedBefore = makeWorld(adapter, t0, {
    rev: 1,
    coins: 35000,
    state: { en: 0, enT: t0 },
  })
  let liveServerWorld = structuredClone(sharedBefore)
  let serverActCalls = 0

  const runCoffeeCaller = (opId) =>
    executeTransaction({
      journal,
      adapter,
      lockRootDir: lockDir,
      account: 'main',
      operation: opId,
      kind: 'act',
      worldBefore: sharedBefore,
      requestPayload: { actions: [{ a: 'coffee' }] },
      sendFn: async ({ operation, request }) => {
        serverActCalls++
        await new Promise((r) => setTimeout(r, 25))
        const sim = adapter.simulateBatch(liveServerWorld, request.actions, { t: t0, prices: liveServerWorld.prices })
        liveServerWorld = { ...sim.afterWorld, rev: liveServerWorld.rev + 1 }
        return {
          status: 200,
          body: { ok: true, operation, out: sim.result.out, spend: sim.result.spend, earn: sim.result.earn, world: liveServerWorld },
        }
      },
    })

  const [r1, r2] = await Promise.all([runCoffeeCaller('op-coffee-1'), runCoffeeCaller('op-coffee-2')])
  const statuses = [r1.status, r2.status].sort()
  assert.deepEqual(statuses, ['confirmed', 'stale-prestate-aborted'])
  assert.equal(serverActCalls, 1, 'Second concurrent caller on stale rev=1 MUST abort inside lock before calling server!')
  assert.equal(liveServerWorld.coins, 20000, 'Zero wasted duplicate coffee spend!')

  // 2) Unattributed `rev` advance on an `unknown` steal/act transaction MUST NOT fabricate `confirmed` AND MUST keep budget occupied!
  const journalUnk = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal-unk'), account: 'main' })
  const timeoutRes = await executeTransaction({
    journal: journalUnk,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    operation: 'op-timeout-steal',
    kind: 'act',
    budgetKind: 'steal',
    budgetLimitPerIsleDay: 1,
    worldBefore: sharedBefore,
    requestPayload: { actions: [{ a: 'coffee' }] },
    sendFn: async () => {
      throw new Error('network socket hang up')
    },
  })
  assert.equal(timeoutRes.status, 'unknown')

  const unattributedFreshWorld = {
    ...structuredClone(sharedBefore),
    now: t0 + 15,
    rev: 99, // rev advanced, but `lastOp` is NOT `'op-timeout-steal'`!
    lastOp: 'some-other-op',
  }
  const recSummary = reconcileUnknownWithFreshWorld(journalUnk, adapter, unattributedFreshWorld)
  assert.equal(recSummary.reconciled, 1)
  assert.equal(recSummary.remainingUnknown, 0)

  const settledTx = journalUnk.reconstructTransactions().txMap.get('op-timeout-steal')
  assert.equal(settledTx.status, 'unknown-state-reanchored')
  assert.equal(settledTx.reconcileOutcome, 'global-rev-advanced-unattributed')
  assert.equal(
    journalUnk.countOccupiedBudget('steal', adapter.R.isleIndex(t0)),
    1,
    'Unattributed unknown transaction must keep steal quota conservatively occupied!'
  )

  // 3) P2: End-to-end `runControllerStep` -> `buildAuditDecisionReport({ journal, tx, adapter })` auto-reconstructs archived context!
  const journalAuto = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal-auto'), account: 'main' })
  let stepWorld = makeWorld(adapter, t0, {
    rev: 10,
    coins: 5000,
    state: {
      en: 20,
      enT: t0,
      inv: { strawberry: [4, 0, 0] },
    },
  })

  const stepRes = await runControllerStep({
    adapter,
    journal: journalAuto,
    lockRootDir: lockDir,
    account: 'main',
    objectiveCfg: buildObjectiveConfig({ horizonSec: 1800 }),
    fetchWorldFn: async () => stepWorld,
    sendActFn: async ({ operation, actions }) => {
      const sim = adapter.simulateBatch(stepWorld, actions, { t: stepWorld.now, prices: stepWorld.prices })
      stepWorld = { ...sim.afterWorld, rev: stepWorld.rev + 1 }
      return {
        status: 200,
        body: { ok: true, operation, out: sim.result.out, spend: sim.result.spend, earn: sim.result.earn, world: stepWorld },
      }
    },
    dryRun: false,
  })
  assert.equal(stepRes.status, 'confirmed')

  const autoTx = journalAuto.reconstructTransactions().transactions.find((t) => t.status === 'confirmed')
  assert.ok(autoTx, 'Must record confirmed transaction with archived envelopeRef & planRef')
  const autoAudit = await buildAuditDecisionReport({
    journal: journalAuto,
    tx: autoTx,
    adapter,
  })
  assert.equal(autoAudit.identifiable, true)
  assert.equal(autoAudit.verdict, 'ex-ante-consistent')
})
