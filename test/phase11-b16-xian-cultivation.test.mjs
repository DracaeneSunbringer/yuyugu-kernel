import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { auditTransactionReplay } from '../audit/replay.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld } from '../execution/reconcile.mjs'
import {
  FORBIDDEN_XIAN_ACTIONS,
  assertSafeXianBatch,
  computeNextXianWakeSec,
  estimateBattleWinProb,
  normalizeXianOptions,
  planXianActions,
  runXianCultivationSlice,
} from '../execution/xian-cultivation.mjs'
import { xianAction, xianDay, xianNeed, xianTowerEnemy } from '../rules/b16-xian-rules.js'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeTempDir(prefix = 'kernel-p11-xian-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeRng(seed = 0x12345678) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeBaseWorld(adapter, nowSec, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {
    iron: [10, 0, 0],
    bomb: [10, 0, 0],
  }
  s.plotN = 24
  s.plots = Array.from({ length: 24 }, () => ({ c: 'corn', t: nowSec, w: 2, g: 0, h: 0 }))
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
    rev: 10,
    coins: 500000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

function applyAuthoritativeXianBatch(world, actions, rng) {
  const next = structuredClone(world)
  const out = []
  let totalSpend = 0
  for (const act of actions) {
    const res = xianAction(next.state, act, {
      t: next.now,
      coins: next.coins,
      rand: rng,
    })
    assert.ok(res && res.ok, `Expected xianAction(${JSON.stringify(act)}) to succeed, got: ${JSON.stringify(res)}`)
    const sp = Number(res.spend || 0)
    if (sp > 0) {
      next.coins -= sp
      totalSpend += sp
    }
    out.push(res)
  }
  next.rev = Number(next.rev || 0) + 1
  return { afterWorld: next, out, spend: totalSpend }
}

test('Phase 11.1: Default-OFF isolation guarantees zero xian actions, zero wake perturbation, and null backgroundReport.xian', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000
  const world = makeBaseWorld(adapter, t0)

  const defOpts = normalizeXianOptions()
  assert.equal(defOpts.enabled, false)
  assert.equal(defOpts.dailyStoneQuota, 0)

  const plan = planXianActions(world, t0)
  assert.equal(plan.enabled, false)
  assert.deepEqual(plan.actions, [])
  assert.equal(computeNextXianWakeSec(world, t0), Infinity)

  const sliceOut = await runXianCultivationSlice({
    account: 'main',
    adapter,
    httpClient: {
      estimatedServerNowSec: () => t0,
      getJson: async () => {
        throw new Error('Should never fetch world when xian is disabled!')
      },
    },
    observedWorld: world,
  })
  assert.equal(sliceOut.status, 'disabled')
  assert.deepEqual(sliceOut.actions, [])

  const tmpDir = makeTempDir('kernel-p11-defoff-')
  let postActCalls = 0
  const mockHttp = {
    stats: { getCount: 0, postCount: 0 },
    nowMsFn: () => t0 * 1000,
    estimatedServerNowSec: () => t0,
    estimatedServerNowMs: () => t0 * 1000,
    getJson: async (apiPath) => {
      if (apiPath === '/api/pet/world') return structuredClone(world)
      if (apiPath === '/api/pet') return { adopted: false }
      if (apiPath === '/api/pet/battle/home') return { adopted: false }
      return {}
    },
    postJson: async (apiPath) => {
      if (apiPath === '/api/pet/world/act') postActCalls++
      return { ok: true, status: 200, networkError: false, body: {} }
    },
  }

  const tickRes = await runLiveAccountTick({
    account: 'secondary',
    adapter,
    httpClient: mockHttp,
    partnerHttpClient: null,
    journal: null,
    partnerJournal: null,
    snipeScheduler: null,
    lockRootDir: path.join(tmpDir, 'locks'),
    profileStorePath: path.join(tmpDir, 'profiles.json'),
    huancaiStatePath: path.join(tmpDir, 'huancai.json'),
    runtimeState: {
      lastPetCareAtSec: t0,
      lastBattlePrepAtSec: t0,
      lastHuancaiCheckAtSec: t0,
      arenaRemaining: 0,
    },
    baseUserConstraints: { allowCapex: false, maxStealsPerIsleDay: 0, minStealSpots: 999999 },
    objectiveCfg: { horizonSec: 600, continuationIsleDays: 0 },
    solverOptions: { runStability: false, allowedActionTypes: ['sell', 'wait'] },
    dryRun: true,
  })
  assert.equal(tickRes.backgroundReport?.xian, null, 'Default xianOptions must leave backgroundReport.xian === null')
  assert.equal(postActCalls, 0)
})

test('Phase 11.2: Free bootstrap & 72-hour autonomous cultivation loop spends strictly 0 D-coins and 0 island materials', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const rng = makeRng(0x20261112)
  let t = 1794451200
  let world = makeBaseWorld(adapter, t)
  const initialCoins = world.coins

  // First tick on fresh account (`!world.state.xian`): enters, turns on heal carry, talks to all 21 NPCs, plants & waters dew
  const bootPlan = planXianActions(world, t, { enabled: true })
  assert.equal(bootPlan.reason, 'bootstrap-enter')
  assert.equal(bootPlan.expectedSpendCoins, 0)
  assert.equal(bootPlan.actions[0]?.a, 'xianEnter')
  assert.ok(bootPlan.actions.some((a) => a.a === 'xianCarry' && a.on === true))
  assert.equal(bootPlan.actions.filter((a) => a.a === 'xianTalk').length, 21)
  assert.ok(bootPlan.actions.some((a) => a.a === 'xianPlant' && a.id === 'dew'))
  assert.ok(bootPlan.actions.some((a) => a.a === 'xianWater'))

  let applied = applyAuthoritativeXianBatch(world, bootPlan.actions, rng)
  world = applied.afterWorld
  assert.equal(world.coins, initialCoins, 'Bootstrap entry must spend 0 D-coins')
  assert.equal(world.state.xian?.v, 1)
  assert.ok(world.state.xian.stone >= 300, 'Starter 100 stones + 21 NPC daily talks (~268) must exceed 360 stones')

  // Simulate 72 hours of event-driven wakeups (`computeNextXianWakeSec` / `followUpSoon`)
  const endSec = t + 72 * 3600
  let batchesExecuted = 1
  let harvests = 0
  let brews = 0
  let duelsOrTowers = 0

  while (t < endSec) {
    const plan = planXianActions(world, t, { enabled: true, dailyStoneQuota: 0 })
    if (plan.actions.length > 0) {
      for (const act of plan.actions) {
        assert.equal(FORBIDDEN_XIAN_ACTIONS.has(act.a), false, `Forbidden action emitted: ${act.a}`)
        assert.notEqual(act.a, 'xianStoneBuy')
        if (act.a === 'xianTower') assert.notEqual(act.pay, true)
        if (act.a === 'xianHarvest') harvests++
        if (act.a === 'xianBrew') brews++
        if (act.a === 'xianDuel' || act.a === 'xianTower') duelsOrTowers++
      }
      applied = applyAuthoritativeXianBatch(world, plan.actions, rng)
      world = applied.afterWorld
      batchesExecuted++
      assert.equal(world.coins, initialCoins, 'Pure F2P xian loop must never spend a single D-coin')
      assert.deepEqual(world.state.inv.iron, [10, 0, 0], 'Main-island iron must never be touched')
      assert.deepEqual(world.state.inv.bomb, [10, 0, 0], 'Main-island bomb must never be touched')
    }
    const wake = plan.followUpSoon ? t + 3 : computeNextXianWakeSec(world, t, { enabled: true })
    t = Math.min(endSec, Math.max(t + 3, wake))
    world.now = t
  }

  assert.ok(batchesExecuted >= 15, `Expected multi-day autonomous progress, ran ${batchesExecuted} batches`)
  assert.ok(harvests >= 6, `Expected regular spirit herb harvests, got ${harvests}`)
  assert.ok(brews >= 3, `Expected autonomous pill brewing, got ${brews}`)
  assert.ok(duelsOrTowers >= 10, `Expected NPC duels & free tower climbs, got ${duelsOrTowers}`)
  assert.ok(world.state.xian.lv >= 4, `Expected cultivation level progression, reached Lv${world.state.xian.lv}`)
})

test('Phase 11.3: Hard firewall blocks forbidden actions/paid tower and protects x.pend, gun/cannon, and g>=3 gear during salvage', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t = 1794460000
  const rng = makeRng(0x99887766)
  let world = makeBaseWorld(adapter, t)
  world = applyAuthoritativeXianBatch(world, [{ a: 'xianEnter' }], rng).afterWorld

  for (const forbidden of FORBIDDEN_XIAN_ACTIONS) {
    assert.throws(
      () => assertSafeXianBatch([{ a: forbidden }], world, { enabled: true }),
      /Forbidden xian action blocked by firewall/
    )
  }
  assert.throws(
    () => assertSafeXianBatch([{ a: 'xianTower', pay: true }], world, { enabled: true }),
    /Paid xianTower is strictly forbidden/
  )
  assert.throws(
    () => assertSafeXianBatch([{ a: 'xianStoneBuy', n: 10 }], world, { enabled: true, dailyStoneQuota: 0 }),
    /xianStoneBuy blocked when dailyStoneQuota=0/
  )
  assert.throws(
    () => assertSafeXianBatch([{ a: 'sell', id: 'corn', q: 0, n: 1 }], world, { enabled: true }),
    /Non-xian action leaked/
  )

  // Populate 26 items in bag including:
  // - id=5: low-score g=0 wood sword currently referenced by `x.pend = { k: 'i', i: 5, ... }`
  // - id=6: g=0 `gun` (bomb-forged special base)
  // - id=7: g=1 `cannon` (bomb-forged special base)
  // - id=8: g=3 `gourd` (`仙器` grade >= 3)
  // - 22 weak g=0 `wood`/`talisman`/`abacus` filler items
  const items = [
    { id: 5, b: 'wood', g: 0, lv: 1, a: [['hp', 0.01]], el: 'wood' },
    { id: 6, b: 'gun', g: 0, lv: 1, a: [['atk', 0.02]], el: 'fire' },
    { id: 7, b: 'cannon', g: 1, lv: 2, a: [['atk', 0.03]], el: 'metal' },
    { id: 8, b: 'gourd', g: 3, lv: 3, a: [['hp', 0.12]] },
  ]
  for (let i = 10; i < 32; i++) {
    items.push({ id: i, b: i % 2 === 0 ? 'wood' : 'talisman', g: 0, lv: 1, a: [['spd', 0.01]], el: 'earth' })
  }
  world.state.xian.items = items
  world.state.xian.nid = 40
  world.state.xian.eq = { weapon: 10 }
  world.state.xian.pend = { k: 'i', i: 5, v: [['atk', 0.18]] }
  world.state.xian.dy = {
    d: xianDay(t),
    stone: 0,
    water: 4,
    tower: 5,
    extra: 0,
    duel: 10,
    talk: Array.from({ length: 21 }, (_, idx) => `n${idx}`),
    won: [],
  }
  // Mark all real NPCs talked so batch focuses on gear & salvage
  const plan = planXianActions(world, t, { enabled: true })
  const salvagedIds = new Set(plan.actions.filter((a) => a.a === 'xianSalvage').map((a) => a.id))
  assert.ok(salvagedIds.size >= 5, 'Should salvage weak filler items when bag has 26/30 items')
  assert.equal(salvagedIds.has(5), false, 'Must NEVER salvage item referenced by user pending reforge x.pend!')
  assert.equal(salvagedIds.has(6), false, 'Must NEVER salvage bomb-forged gun!')
  assert.equal(salvagedIds.has(7), false, 'Must NEVER salvage bomb-forged cannon!')
  assert.equal(salvagedIds.has(8), false, 'Must NEVER salvage g>=3 gear!')
  assert.equal(plan.actions.some((a) => a.a === 'xianPending'), false, 'Must NEVER touch x.pend!')

  const after = applyAuthoritativeXianBatch(world, plan.actions, rng).afterWorld
  assert.deepEqual(after.state.xian.pend, { k: 'i', i: 5, v: [['atk', 0.18]] }, 'x.pend must survive untouched')
})

test('Phase 11.4: Optional --xian-daily-stone respects daily quota and cashReserveFloor', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t = 1794470000
  const rng = makeRng(0x55443322)
  let world = makeBaseWorld(adapter, t, { coins: 320000 })
  world = applyAuthoritativeXianBatch(world, [{ a: 'xianEnter' }], rng).afterWorld

  // Request up to 300 stones/day (`300,000 D`), but with `coins = 320,000` and `cashReserveFloor = 150,000`,
  // affordable budget is `170,000 D` -> must buy exactly `170` stones!
  const p1 = planXianActions(world, t, {
    enabled: true,
    dailyStoneQuota: 300,
    cashReserveFloor: 150000,
  })
  const buyAct1 = p1.actions.find((a) => a.a === 'xianStoneBuy')
  assert.deepEqual(buyAct1, { a: 'xianStoneBuy', n: 170 })
  assert.equal(p1.expectedSpendCoins, 170000)

  world = applyAuthoritativeXianBatch(world, p1.actions, rng).afterWorld
  assert.equal(world.coins, 150000, 'Post-exchange coins must never dip below cashReserveFloor')

  // Once coins increase later in the same CST day (`+200,000 D`), only the remaining `300 - 170 = 130` stones are bought!
  world.coins += 200000
  const p2 = planXianActions(world, t + 60, {
    enabled: true,
    dailyStoneQuota: 300,
    cashReserveFloor: 150000,
  })
  const buyAct2 = p2.actions.find((a) => a.a === 'xianStoneBuy')
  assert.deepEqual(buyAct2, { a: 'xianStoneBuy', n: 130 })
  world = applyAuthoritativeXianBatch(world, p2.actions, rng).afterWorld
  assert.equal(world.state.xian.dy.stone, 300)

  // Further ticks on the same CST day emit 0 xianStoneBuy
  const p3 = planXianActions(world, t + 120, {
    enabled: true,
    dailyStoneQuota: 300,
    cashReserveFloor: 150000,
  })
  assert.equal(p3.actions.some((a) => a.a === 'xianStoneBuy'), false)
})

test('Phase 11.5: Breakthrough shields accrued cAt XP before xianCultivate/qi, and hatched pets execute feed -> claim -> sell feather', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t = 1794480000
  const rng = makeRng(0x77771111)
  let world = makeBaseWorld(adapter, t)
  world = applyAuthoritativeXianBatch(world, [{ a: 'xianEnter' }], rng).afterWorld

  const x = world.state.xian
  x.lv = 9 // 练气九层 bottleneck (`XIAN_BREAK[9] === 'found'`)
  x.xp = xianNeed(9) + 25
  x.cAt = t - 14 * 3600 // 14 hours of uncollected passive XP sitting safely in `cAt`!
  x.pills = {
    found: [0, 1, 0, 0, 0],
    qi: [2, 0, 0, 0, 0],
    beast: [1, 0, 0, 0, 0],
    heal: [2, 0, 0, 0, 0],
  }
  x.herbs = {
    dew: [8, 0, 0, 0, 0],
    gold: [4, 0, 0, 0, 0],
  }
  x.pets = [{ k: 'fox', h: t - 60, gr: 50, a: [['crit', 0.04]] }]
  x.pet = -1

  const plan = planXianActions(world, t, { enabled: true })
  const idxBreak = plan.actions.findIndex((a) => a.a === 'xianBreak')
  const idxCult = plan.actions.findIndex((a) => a.a === 'xianCultivate')
  const idxQi = plan.actions.findIndex((a) => a.a === 'xianEat' && a.id === 'qi')

  assert.ok(idxBreak >= 0, 'Must emit xianBreak when Lv9 XP and found pill are ready')
  assert.equal(idxCult, -1, 'Must NOT call xianCultivate in the same batch as stochastic xianBreak (shields accrued cAt XP from 20% fail penalty!)')
  assert.equal(idxQi, -1, 'Must NOT eat qi pill before resolving stochastic xianBreak')

  // Verify pet activation + beast pill + 1-herb feed + feather claim in same batch
  assert.ok(plan.actions.some((a) => a.a === 'xianPetActive' && a.i === 0))
  assert.ok(plan.actions.some((a) => a.a === 'xianEat' && a.id === 'beast' && a.i === 0))
  assert.ok(plan.actions.some((a) => a.a === 'xianPetFeed' && a.i === 0))
  assert.ok(plan.actions.some((a) => a.a === 'xianPetClaim'))
  assert.ok(plan.actions.some((a) => a.a === 'xianSell' && a.kind === 'mat' && a.id === 'feather'))

  const after = applyAuthoritativeXianBatch(world, plan.actions, rng).afterWorld
  assert.equal(after.state.xian.cAt, t - 14 * 3600, 'Accrued passive XP timestamp cAt remains intact across xianBreak!')
  assert.equal(after.state.xian.mats.feather || 0, 0, 'Claimed feathers were immediately converted into spirit stones')

  // Also sanity-check Monte Carlo battle estimator monotonic win probability
  const floor1 = xianTowerEnemy(1)
  const floor40 = xianTowerEnemy(40)
  const w1 = estimateBattleWinProb(after.state.xian, floor1, { trials: 30 })
  const w40 = estimateBattleWinProb(after.state.xian, floor40, { trials: 30 })
  assert.ok(w1.winProb > w40.winProb, `Expected floor 1 winProb (${w1.winProb}) > floor 40 (${w40.winProb})`)
})

test('Phase 11.6: End-to-end runXianCultivationSlice + Journal + Unknown rev reconcile + Audit Replay/Report', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tmpDir = makeTempDir('kernel-p11-e2e-')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  const lockRootDir = path.join(tmpDir, 'locks')
  const rng = makeRng(0xabcdef01)

  let t = 1794490000
  let serverWorld = makeBaseWorld(adapter, t)

  const mockHttp = {
    estimatedServerNowSec: () => t,
    getJson: async (apiPath) => {
      assert.equal(apiPath, '/api/pet/world')
      return structuredClone(serverWorld)
    },
    postJson: async (apiPath, body) => {
      assert.equal(apiPath, '/api/pet/world/act')
      assert.equal(body.rev, serverWorld.rev)
      const applied = applyAuthoritativeXianBatch(serverWorld, body.actions, rng)
      serverWorld = applied.afterWorld
      return {
        ok: true,
        status: 200,
        networkError: false,
        body: {
          ok: true,
          rev: serverWorld.rev,
          coins: serverWorld.coins,
          spend: applied.spend,
          out: applied.out,
          state: structuredClone(serverWorld.state),
        },
      }
    },
  }

  const slice1 = await runXianCultivationSlice({
    account: 'main',
    adapter,
    httpClient: mockHttp,
    journal,
    lockRootDir,
    observedWorld: serverWorld,
    xianOptions: { enabled: true, dailyStoneQuota: 0 },
  })
  assert.equal(slice1.status, 'confirmed')
  assert.ok(slice1.actions.length >= 20)
  assert.equal(serverWorld.rev, 11)

  // Verify Layer 1 replay and Layer 3 decision report on the recorded `xian-act` transaction
  const { transactions: txs } = journal.reconstructTransactions()
  assert.equal(txs.length, 1)
  assert.equal(txs[0].kind, 'xian-act')
  assert.equal(txs[0].status, 'confirmed')

  const replay = await auditTransactionReplay(journal, txs[0], { fallbackAdapter: adapter })
  assert.equal(replay.status, 'consistent-external-xian')
  assert.deepEqual(replay.serverDrifts, [])

  const report = await buildAuditDecisionReport({
    journal,
    tx: txs[0],
    adapter,
  })
  assert.equal(report.verdict, 'ex-ante-consistent')
  assert.equal(report.identifiableDecisionRegretLowerBound, 0)

  // Simulate a network-timeout `unknown` `xian-act` transaction whose batch DID apply on server (`rev: 11 -> 12`)
  t += 8 * 3600
  serverWorld.now = t
  const nextPlan = planXianActions(serverWorld, t, { enabled: true })
  assert.ok(nextPlan.actions.length > 0)
  const beforeUnknownWorld = structuredClone(serverWorld)

  const unknownTxOut = await executeTransaction({
    journal,
    adapter,
    lockRootDir,
    account: 'main',
    kind: 'xian-act',
    worldBefore: beforeUnknownWorld,
    requestPayload: { actions: nextPlan.actions },
    sendFn: async () => {
      serverWorld = applyAuthoritativeXianBatch(serverWorld, nextPlan.actions, rng).afterWorld
      return { ok: false, status: 0, networkError: true, body: null }
    },
    fetchAfterWorldFn: async () => null,
  })
  assert.equal(unknownTxOut.status, 'unknown')
  assert.equal(journal.reconstructTransactions().coverage.unknownCount, 1)

  const rec = reconcileUnknownWithFreshWorld(journal, adapter, serverWorld)
  assert.equal(rec.remainingUnknown, 0)
  assert.equal(rec.remainingNonVisitUnknown, 0)
  assert.equal(rec.reconciled, 1)
  assert.equal(journal.reconstructTransactions().txMap.get(unknownTxOut.operation)?.status, 'unknown-state-reanchored')
})
