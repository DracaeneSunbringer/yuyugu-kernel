import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeWorld(adapter, nowSec = 1794340000, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plots = Array(s.plotN).fill(null)
  s.barn = []
  s.traps = []
  s.en = 40
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

test('Phase 3.1: Adversarial Injection #1 — Recipe-order truncation (crafting salad instead of jam) caught with R_lower > 0', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, {
    state: {
      inv: { turnip: [3, 0, 0], carrot: [3, 0, 0], strawberry: [4, 0, 0] },
      iq: { d: adapter.R.isleIndex(t0), craft: 79 }, // 1 craft slot left!
    },
  })

  // Buggy planner truncates to first recipe in R.RECIPES (`salad`: +2000 margin -> total 6500 + 13200 = 19700)
  // instead of `jam` (+3800 margin -> total 4500 + 17000 = 21500)!
  const buggyActions = [
    { a: 'craft', id: 'salad', n: 1 },
    { a: 'sell', id: 'salad', q: 0, n: 1 },
    { a: 'sell', id: 'strawberry', q: 0, n: 4 },
  ]
  const rep = await buildAuditDecisionReport({
    adapter,
    worldBefore: world,
    actualFirstActions: buggyActions,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })

  assert.equal(rep.verdict, 'identifiable-decision-regret')
  assert.equal(rep.identifiableDecisionRegretLowerBound, 1800) // 21500 - 19700 = 1800!
})

test('Phase 3.2: Adversarial Injection #2 — Ignored crop tier delusion caught by BOTH Layer 1 shadow check AND Layer 2 regret', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-adv2-'))
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const journal = new ContentAddressedJournal({ rootDir: dir, account: 'main' })
  journal.archiveRulesSource(adapter.rulesHash, adapter.rulesSourceText)

  const t0 = 1794340000
  const world = makeWorld(adapter, t0, {
    state: {
      enDay: adapter.R.worldDay(t0),
      cnt: { sc_strawberry: 400 }, // 70% tier!
      inv: { strawberry: [4, 0, 0] },
    },
  })

  // Buggy planner sells 4 raw strawberries at sc=400 (actual rule earn = round(4*3300*0.7) = 9240)
  // while claiming in its shadow ledger that it earned full 13200, AND missing `craft jam` (17000)!
  const buggyActions = [{ a: 'sell', id: 'strawberry', q: 0, n: 4 }]
  const sim = adapter.simulateBatch(world, buggyActions, { t: t0, prices: world.prices })
  const bRef = journal.writeBlob(world)
  const aRef = journal.writeBlob(sim.afterWorld)
  const reqRef = journal.writeBlob({ actions: buggyActions })
  const resRef = journal.writeBlob({ status: 200, body: { ok: true, out: sim.result.out } })
  const badPlanRef = journal.writeBlob({ claimedCoinsAfterBatch: 13200 }) // Delusional tier-ignoring shadow coin count!

  journal.appendEvent({
    recordType: 'tx-transition',
    operation: 'op-tier-delusion',
    kind: 'act',
    status: 'confirmed',
    rulesHash: adapter.rulesHash,
    stateBeforeRef: bRef,
    stateAfterRef: aRef,
    requestRef: reqRef,
    responseRef: resRef,
    planRef: badPlanRef,
  })
  const tx = journal.reconstructTransactions().txMap.get('op-tier-delusion')

  const rep = await buildAuditDecisionReport({
    journal,
    tx,
    adapter,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })

  assert.equal(rep.verdict, 'mechanical-or-conservation-defect')
  assert.equal(rep.replay.status, 'shadow-conservation-violation')
  assert.equal(rep.identifiableDecisionRegretLowerBound, 17000 - 9240)
})

test('Phase 3.3: Adversarial Injection #3 — Mispricing gold-star craft consumption (crafting jam from 4 q2 strawberries at sc=0)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, {
    state: {
      enDay: adapter.R.worldDay(t0),
      cnt: { sc_strawberry: 0 },
      inv: { strawberry: [0, 0, 4] }, // 4 gold strawberries = 4 * 4950 = 19,800 raw!
    },
  })

  // Buggy planner crafts jam (17,000) out of 4 gold strawberries instead of selling raw (19,800)
  const rep = await buildAuditDecisionReport({
    adapter,
    worldBefore: world,
    actualFirstActions: [{ a: 'craft', id: 'jam', n: 1 }, { a: 'sell', id: 'jam', q: 0, n: 1 }],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 60, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })

  assert.equal(rep.verdict, 'identifiable-decision-regret')
  assert.equal(rep.identifiableDecisionRegretLowerBound, 19800 - 17000)
})

test('Phase 3.4: Adversarial Injection #4 — Causal violation (attempting craft at t0 before t0+60 arrival)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, { state: { inv: {} } })

  const rep = await buildAuditDecisionReport({
    adapter,
    worldBefore: world,
    actualFirstActions: [{ a: 'craft', id: 'jam', n: 1 }], // illegal at t0: strawberries haven't arrived yet!
    deterministicArrivals: [{ atSec: t0 + 60, items: [{ id: 'strawberry', q: 0, n: 4 }] }],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 180, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })

  assert.equal(rep.verdict, 'mechanical-or-conservation-defect')
  assert.equal(rep.identifiableDecisionRegretLowerBound, 17000)
})

test('Phase 3.5 & 3.6: Adversarial Injections #5 (rolling deferral) and #6 (missing pre-state / archived rules -> not-identifiable)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-adv56-'))
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const journal = new ContentAddressedJournal({ rootDir: dir, account: 'main' })
  const t0 = 1794340000
  const world = makeWorld(adapter, t0, { state: { inv: { turnip: [10, 0, 0] } } })

  // #5: Perpetual deferral history flagged as `rolling-deferral-defect`
  const repDeferral = await buildAuditDecisionReport({
    adapter,
    worldBefore: world,
    actualFirstActions: [],
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    objectiveCfg: buildObjectiveConfig({ horizonSec: 0, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['wait'],
    commitmentHistory: [
      { itemId: 'turnip', atSec: t0, plannedSellAtSec: t0 + 600, executedSellQty: 0 },
      { itemId: 'turnip', atSec: t0 + 600, plannedSellAtSec: t0 + 1200, executedSellQty: 0 },
      { itemId: 'turnip', atSec: t0 + 1200, plannedSellAtSec: t0 + 1800, executedSellQty: 0 },
    ],
  })
  assert.equal(repDeferral.verdict, 'rolling-deferral-defect')

  // #6A: Missing `stateBeforeRef` -> MUST report `not-identifiable`!
  journal.appendEvent({
    recordType: 'tx-transition',
    operation: 'op-missing-prestate',
    kind: 'act',
    status: 'confirmed',
    rulesHash: adapter.rulesHash,
    stateBeforeRef: null,
  })
  const txNoPre = journal.reconstructTransactions().txMap.get('op-missing-prestate')
  const repNoPre = await buildAuditDecisionReport({ journal, tx: txNoPre, adapter })
  assert.equal(repNoPre.verdict, 'not-identifiable')
  assert.equal(repNoPre.identifiable, false)

  // #6B: Unarchived unknown `rulesHash` -> MUST report `not-identifiable`!
  const bRef = journal.writeBlob(world)
  journal.appendEvent({
    recordType: 'tx-transition',
    operation: 'op-unknown-rules-hash',
    kind: 'act',
    status: 'confirmed',
    rulesHash: 'deadbeef00000000000000000000000000000000000000000000000000000000',
    stateBeforeRef: bRef,
  })
  const txBadHash = journal.reconstructTransactions().txMap.get('op-unknown-rules-hash')
  const repBadHash = await buildAuditDecisionReport({ journal, tx: txBadHash, adapter: null })
  assert.equal(repBadHash.verdict, 'not-identifiable')
  assert.equal(repBadHash.identifiable, false)
})

test('Phase 3.7: Ex-ante optimal waiting (0.8*130 + 0.2*70 = 118 > 100) realizing 70 has R_lower = 0 (zero hindsight bias!)', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const nextIsle = adapter.nextIsleBoundary(1794340000, CLOCK_START)
  const t0 = nextIsle - 60 // 60s before nextIsleAt price reveal!

  const base100 = Object.fromEntries(adapter.graph.sellableIds.map((k) => [k, 100]))
  const world = makeWorld(adapter, t0, {
    prices: base100,
    state: { inv: { turnip: [1, 0, 0] } },
  })

  const sUp = {
    id: 'up',
    weight: 0.8,
    externalSupplyFactor: 1.0,
    explicitPricesByStep: [base100, { ...base100, turnip: 130 }],
  }
  const sDown = {
    id: 'down',
    weight: 0.2,
    externalSupplyFactor: 0.8,
    explicitPricesByStep: [base100, { ...base100, turnip: 70 }],
  }

  const rep = await buildAuditDecisionReport({
    adapter,
    worldBefore: world,
    actualFirstActions: [], // Agent chose `wait` at t0 (ex-ante EV = 0.8*130 + 0.2*70 = 118 > 100!)
    scenarios: [sUp, sDown],
    exPostRealizedScenario: sDown, // Nature happened to draw the 20% bad state (price = 70)!
    objectiveCfg: buildObjectiveConfig({ horizonSec: 120, terminalSupplyMode: 'zero' }),
    allowedActionTypes: ['sell', 'wait'],
  })

  assert.equal(rep.verdict, 'ex-ante-consistent')
  assert.equal(rep.identifiableDecisionRegretLowerBound, 0)
  assert.equal(rep.exPostHindsightGap, 30) // 100 - 70 = 30 recorded strictly as hindsight gap, NOT decision regret!
})

test('Phase 3.8: Static Architectural Firewall — zero planner/* imports in audit/* AND zero hardcoded catalog IDs across kernel', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })

  // 1) `audit/*` MUST NOT import `planner/*`
  const auditDir = path.resolve('audit')
  for (const file of fs.readdirSync(auditDir).filter((f) => f.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(auditDir, file), 'utf8')
    assert.ok(
      !/from\s+['"][^'"]*planner\//.test(src) && !/import\s*\(\s*['"][^'"]*planner\//.test(src),
      `Architectural firewall violation: audit/${file} imports planner/*`
    )
  }

  // 2) Zero hardcoded catalog item IDs across `model/`, `planner/`, `execution/`, `audit/`, `cli/`
  //    (Every crop, animal product, fish, ore, sellable recipe, thief item, and guard item must be table-driven!)
  const forbiddenCatalogIds = [
    ...adapter.R.CROPS.map((c) => c.id),
    ...adapter.R.ANIMALS.map((a) => a.id),
    ...adapter.R.ANIMALS.map((a) => a.product),
    ...adapter.R.FISH.map((f) => f.id),
    ...adapter.R.ORES.map((o) => o.id),
    ...adapter.R.RECIPES.filter((r) => r.price > 0).map((r) => r.id),
    ...Object.keys(adapter.R.THIEF_ITEMS),
    ...Object.keys(adapter.R.GUARD_ITEMS),
  ]

  const codeDirs = ['model', 'planner', 'execution', 'audit', 'cli']
  for (const dirName of codeDirs) {
    const absDir = path.resolve(dirName)
    for (const file of fs.readdirSync(absDir).filter((f) => f.endsWith('.mjs'))) {
      const rawSrc = fs.readFileSync(path.join(absDir, file), 'utf8')
      // Strip comments so explanatory comments never mask or false-trigger string-literal checks
      const codeOnly = rawSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      for (const itemId of forbiddenCatalogIds) {
        const quotedRe = new RegExp(`['"\`]${itemId}['"\`]`)
        assert.equal(
          quotedRe.test(codeOnly),
          false,
          `Hardcoded catalog ID '${itemId}' found in ${dirName}/${file}!`
        )
      }
    }
  }
})
