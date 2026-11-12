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
import { reconcileUnknownWithFreshWorld } from '../execution/reconcile.mjs'
import {
  BREW_READY_SEC,
  FORBIDDEN_XIAN_ACTIONS,
  MAX_XS_BATCH,
  assertSafeXianBatch,
  computeNextXianWakeSec,
  fromWireXsAction,
  normalizeXianOptions,
  planXianActions,
  runXianCultivationSlice,
  selectOptimalFusionPair,
} from '../execution/xian-cultivation.mjs'
import {
  MED_MAX,
  act as xsAct,
  cvNeed,
  newXs,
  tick as xsTick,
} from '../rules/xs-xian-rules.js'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeTempDir(prefix = 'kernel-p11-xs-') {
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

function makePostPrologueXs(nowSec, roots = ['metal', 'water']) {
  const x = newXs(nowSec)
  x.st = 4
  x.root = roots[0]
  x.roots = { e: [...roots], v: [] }
  x.hv = 1
  // Prologue harvested plot 14 (`lingcao`) and story 4 awarded +30 stone & +3 `jingu` seeds
  x.plots[14] = { s: 'soil' }
  x.bag.lingcao = 1
  x.xp = 4
  x.stone = 130
  x.seeds.jingu = 3
  return x
}

function makeBaseWorld(adapter, nowSec, xsState = null, overrides = {}) {
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
  if (xsState) s.xs = structuredClone(xsState)
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

function applyAuthoritativeXsBatch(world, wireActions, rng = Math.random) {
  assert.ok(wireActions.length <= MAX_XS_BATCH, `Batch size ${wireActions.length} exceeds server MAX=${MAX_XS_BATCH}`)
  const next = structuredClone(world)
  next.state.xs ||= newXs(next.now)
  const out = []
  for (const wire of wireActions) {
    const internal = fromWireXsAction(wire)
    assert.ok(internal, `Expected valid xs* wire action, got: ${JSON.stringify(wire)}`)
    const res = xsAct(next.state.xs, internal, next.now, rng)
    assert.ok(res && res.ok, `Expected xsAct(${JSON.stringify(wire)}) to succeed, got: ${JSON.stringify(res)}`)
    out.push(res)
  }
  next.rev = Number(next.rev || 0) + 1
  return { afterWorld: next, out }
}

test('Phase 11.1: Default-OFF isolation guarantees zero xs actions, zero wake perturbation, and null backgroundReport.xian', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000
  const world = makeBaseWorld(adapter, t0, makePostPrologueXs(t0))

  const defOpts = normalizeXianOptions()
  assert.equal(defOpts.enabled, false)
  assert.equal(defOpts.breakMode, 'smart')
  assert.equal(defOpts.autoFuse, false)
  assert.equal(defOpts.fuseTarget, 'auto')
  assert.equal(defOpts.maxActionsPerBatch, 30)

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

  const tmp = makeTempDir('p11-def-off-')
  try {
    let curWorld = makeBaseWorld(adapter, t0, makePostPrologueXs(t0), {
      coins: 0,
      state: {
        en: 0,
        enT: t0,
        inv: {},
        barnN: 0,
        barn: [],
        trapN: 0,
        traps: [],
        plots: Array.from({ length: 24 }, () => ({ c: 'corn', t: t0, w: 3, g: 0, h: 0 })),
        iq: { d: adapter.R.isleIndex(t0), craft: 80, mine: 30, fish: 20, bomb: 0 },
      },
    })
    const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })
    const postedPayloads = []
    const mockHttp = {
      nowMsFn: () => curWorld.now * 1000,
      estimatedServerNowSec: () => curWorld.now,
      estimatedServerNowMs: () => curWorld.now * 1000,
      serverSecToLocalMs: (s) => s * 1000,
      stats: { getCount: 0, postCount: 0 },
      getJson: async (url) => {
        if (url === '/api/pet/world') return structuredClone(curWorld)
        if (url === '/api/pet/home' || url === '/api/pet/status') return { adopted: false }
        if (url === '/api/pet/huancai') return { boughtToday: true }
        return {}
      },
      postJson: async (url, payload) => {
        postedPayloads.push({ url, payload: structuredClone(payload) })
        if (url === '/api/pet/world/act') {
          const { afterWorld, out } = applyAuthoritativeXsBatch(curWorld, payload.actions, makeRng(101))
          curWorld = afterWorld
          return { ok: true, status: 200, networkError: false, body: { ok: true, rev: curWorld.rev, out, world: structuredClone(curWorld) } }
        }
        return { ok: true, status: 200, networkError: false, body: { ok: true } }
      },
    }
    const commonTickArgs = {
      account: 'main',
      adapter,
      httpClient: mockHttp,
      journal,
      snipeScheduler: {
        isStealEnabled: () => false,
        shouldBlockBackgroundWork: () => false,
        nextExactUnlockInfo: () => null,
        computeImminentSnipeStaminaReservation: () => ({ staminaReserveFloor: 0, staminaReserveUntilSec: 0 }),
      },
      lockRootDir: path.join(tmp, 'locks'),
      profileStorePath: path.join(tmp, 'profiles.json'),
      huancaiStatePath: path.join(tmp, 'huancai.json'),
      runtimeState: {
        lastPetCareAtSec: t0,
        lastBattlePrepAtSec: t0,
        lastHuancaiCheckAtSec: t0,
        arenaRemaining: 0,
      },
      baseUserConstraints: { allowCapex: false, maxStealsPerIsleDay: 0, minStealSpots: 999999 },
      objectiveCfg: { horizonSec: 3600 },
      solverOptions: { checkHorizonStability: false, stochasticPolicySamples: 1 },
    }

    // Default-OFF tick: zero POSTs, null `backgroundReport.xian`, wake time unperturbed by xs timers
    const tickOff = await runLiveAccountTick(commonTickArgs)
    assert.equal(tickOff.phase, 'full-tick')
    assert.equal(tickOff.controllerOut.status, 'waiting')
    assert.equal(tickOff.backgroundReport.xian, null)
    assert.equal(postedPayloads.length, 0)

    // Explicit `--enable-xian` tick on the exact same idle main island: executes `xs*` slice cleanly and incorporates xs wake timer
    const tickOn = await runLiveAccountTick({
      ...commonTickArgs,
      xianOptions: { enabled: true },
    })
    assert.equal(tickOn.phase, 'full-tick')
    assert.equal(tickOn.backgroundReport.xian?.status, 'confirmed')
    assert.equal(postedPayloads.length, 1)
    assert.ok(postedPayloads[0].payload.actions.every((a) => String(a.a).startsWith('xs')))
    assert.ok(tickOn.nextWakeSec <= tickOff.nextWakeSec)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Phase 11.2: Prologue standby (st < 4 / unchosen root), manual danmaku/NPC-duel yield, and static batch firewall', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000
  const opts = { enabled: true }

  // 1. Brand-new world without `state.xs` or mid-prologue (`st = 2`) stays in standby
  const wNoXs = makeBaseWorld(adapter, t0, null)
  const p0 = planXianActions(wNoXs, t0, opts)
  assert.equal(p0.reason, 'prologue-manual-standby')
  assert.deepEqual(p0.actions, [])
  assert.equal(computeNextXianWakeSec(wNoXs, t0, opts), t0 + 120)

  const midPrologue = newXs(t0)
  midPrologue.st = 2
  midPrologue.root = 'water'
  midPrologue.roots = { e: ['water', 'wood'], v: [] }
  const pMid = planXianActions(makeBaseWorld(adapter, t0, midPrologue), t0, opts)
  assert.equal(pMid.reason, 'prologue-manual-standby')
  assert.deepEqual(pMid.actions, [])

  // 2. Active manual stage fight (`secret`) or NPC duel (`duel`) cleanly yields without clobbering `rev`
  const xsInDuel = makePostPrologueXs(t0)
  xsInDuel.fight = { s: 'duel', t: t0 - 15, npc: 'castle' }
  const wDuel = makeBaseWorld(adapter, t0, xsInDuel)
  const pDuel = planXianActions(wDuel, t0, opts)
  assert.equal(pDuel.reason, 'manual-fight-in-progress')
  assert.deepEqual(pDuel.actions, [])
  assert.ok(computeNextXianWakeSec(wDuel, t0, opts) > t0)

  // Once 1800s fight timeout has elapsed, automation resumes normally
  const pExpiredFight = planXianActions(wDuel, t0 + 1850, opts)
  assert.equal(pExpiredFight.reason, 'actions-ready')
  assert.ok(pExpiredFight.actions.length > 0)

  // 3. Static firewall assertions
  for (const forbidden of FORBIDDEN_XIAN_ACTIONS) {
    assert.throws(() => assertSafeXianBatch([{ a: forbidden }], wDuel, opts), /Forbidden manual-only/)
  }
  assert.throws(() => assertSafeXianBatch([{ a: 'sell', id: 'corn', n: 1 }], wDuel, opts), /Illegal non-xs/)
  assert.throws(() => assertSafeXianBatch([{ a: 'xsFuse', el: 'metal+water' }], wDuel, { enabled: true, autoFuse: false }), /autoFuse is disabled/)
  assert.throws(() => assertSafeXianBatch([{ a: 'xsBreak' }], wDuel, { enabled: true, breakMode: 'manual' }), /breakMode is manual/)
})

test('Phase 11.3: Deterministic log % 4 === 3 orchestration achieves 2x yield across multi-plot leizhu harvests', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000

  for (const startLogMod of [0, 1, 2, 3]) {
    const xs = makePostPrologueXs(t0, ['metal'])
    xs.lv = 5
    xs.en = 90
    xs.stone = 600
    xs.log = 100 + startLogMod
    xs.seeds = {}
    xs.bag = { lingcao: 6, jingu: 2, linglan: 2 }
    xs.pills = { huiling: 6, peiyuan: 4 }
    xs.techs = ['metal']
    xs.tech = 'metal'
    xs.med = { t: t0 - 300 }
    // 6 mature `leizhu` plots (`g = 3`), remaining open plots already watered & growing
    for (let i = 0; i < 8; i++) {
      xs.plots[i] = i < 6
        ? { s: 'soil', c: 'leizhu', g: 3, w: 0 }
        : { s: 'soil', c: 'leizhu', g: 1, w: t0 - 100 }
    }
    xs.plots[14] = { s: 'soil', c: 'leizhu', g: 1, w: t0 - 100 }
    xs.plots[15] = { s: 'soil', c: 'leizhu', g: 1, w: t0 - 100 }

    let world = makeBaseWorld(adapter, t0, xs)
    const plan = planXianActions(world, t0, { enabled: true })
    assert.ok(plan.actions.length > 0 && plan.actions.length <= MAX_XS_BATCH)

    const { afterWorld, out } = applyAuthoritativeXsBatch(world, plan.actions)
    const harvestOuts = out.filter((o) => o.herb === 'leizhu')
    assert.equal(harvestOuts.length, 6, `Expected all 6 mature leizhu harvested for startLogMod=${startLogMod}`)
    for (const hOut of harvestOuts) {
      assert.equal(hOut.n, 2, `Expected 2x leizhu yield via log%4===3 alignment (startLogMod=${startLogMod}), got ${JSON.stringify(hOut)}`)
    }
    assert.equal(afterWorld.coins, world.coins)
  }
})

test('Phase 11.4: 72-hour autonomous loop progresses st=4 -> Farm Lv5 leizhu with 0 island resource drift and 0 spin wakes', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const rng = makeRng(0x20261112)
  const tStart = 1794450000
  let curT = tStart
  let world = makeBaseWorld(adapter, curT, makePostPrologueXs(curT, ['water', 'wood']))
  const initialCoins = world.coins
  const initialEn = world.state.en
  const initialInvJson = JSON.stringify(world.state.inv)

  const opts = { enabled: true, breakMode: 'smart', autoFuse: false }
  let totalBatches = 0
  let brewFinishes = 0
  let maxBatchSeen = 0

  const tEnd = tStart + 72 * 3600
  let guard = 0
  while (curT < tEnd && guard++ < 1500) {
    world.now = curT
    const plan = planXianActions(world, curT, opts)
    if (plan.actions.length > 0) {
      maxBatchSeen = Math.max(maxBatchSeen, plan.actions.length)
      assertSafeXianBatch(plan.actions, world, opts)
      assert.ok(!plan.actions.some((a) => a.a === 'xsFuse'), 'Must never auto-fuse when autoFuse=false')
      for (const a of plan.actions) {
        if (a.a === 'xsFinish') {
          const d = curT - world.state.xs.brew.t
          assert.ok(d >= 15 && d <= 1800, `Cauldron finished outside valid window: d=${d}s`)
          assert.equal(a.n, 2)
          brewFinishes++
        }
      }
      const { afterWorld } = applyAuthoritativeXsBatch(world, plan.actions, rng)
      world = afterWorld
      totalBatches++
      assert.equal(world.coins, initialCoins)
      assert.equal(world.state.en, initialEn)
      assert.equal(JSON.stringify(world.state.inv), initialInvJson)
      curT += plan.followUpSoon ? 3 : Math.max(3, computeNextXianWakeSec(world, curT, opts) - curT)
    } else {
      const wake = computeNextXianWakeSec(world, curT, opts)
      assert.ok(Number.isFinite(wake) && wake > curT, `Expected strictly future wake > ${curT}, got ${wake}`)
      curT = wake
    }
  }

  const finalXs = world.state.xs
  xsTick(finalXs, curT)
  assert.ok(totalBatches > 20)
  assert.ok(maxBatchSeen <= MAX_XS_BATCH)
  assert.equal(finalXs.lv, 5, `Expected Farm to reach Lv5 within 72h, got lv=${finalXs.lv} xp=${finalXs.xp}`)
  assert.ok(brewFinishes >= 4, `Expected multiple q=2 cauldron batches, got ${brewFinishes}`)
  assert.ok(finalXs.techs.includes('water') && finalXs.techs.includes('wood'), 'Expected both base root techs learned')
  assert.ok(finalXs.stone > 2000, `Expected strong stone accumulation at Lv5, got ${finalXs.stone}`)
  const openPlots = finalXs.plots.filter((p) => p.s === 'soil').length
  assert.ok(openPlots > 10, `Expected surplus xs.en to expand open plots past initial 10, got ${openPlots}`)
})

test('Phase 11.5: Breakthrough policies (smart vs eager vs manual), free s=9 over-buffering, and xsBreak-before-xsRise shield', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000

  // 1. While `lv < 5` at `r = 1` (筑基 9 层), `smart` mode prioritizes eating `peiyuan` for Farm Lv5 instead of burning 2 pills on 金丹,
  //    AND continues 30m meditation cycles at `s = 9` to stack free failure-buffer XP!
  const xsSubLv5 = makePostPrologueXs(t0, ['metal'])
  xsSubLv5.lv = 3
  xsSubLv5.en = 4
  xsSubLv5.cv = { r: 1, s: 9, xp: cvNeed(1, 9) + 50 }
  xsSubLv5.pills = { peiyuan: 2 }
  xsSubLv5.med = { t: t0 - MED_MAX - 10 }
  for (let i = 0; i < 8; i++) xsSubLv5.plots[i] = { s: 'soil', c: 'binglian', g: 1, w: t0 - 60 }
  xsSubLv5.plots[14] = { s: 'soil', c: 'binglian', g: 1, w: t0 - 60 }
  xsSubLv5.plots[15] = { s: 'soil', c: 'binglian', g: 1, w: t0 - 60 }

  const wSubLv5 = makeBaseWorld(adapter, t0, xsSubLv5)
  const smartPlan = planXianActions(wSubLv5, t0, { enabled: true, breakMode: 'smart' })
  assert.ok(!smartPlan.actions.some((a) => a.a === 'xsBreak'), 'smart mode must not burn multi-pill r>=1 break before Farm Lv5')
  assert.equal(smartPlan.actions.filter((a) => a.a === 'xsUse' && a.herb === 'peiyuan').length, 2, 'smart mode feeds peiyuan to rush Farm Lv5')
  assert.ok(smartPlan.actions.some((a) => a.a === 'xsRise') && smartPlan.actions.some((a) => a.a === 'xsSit'), 'keeps cycling s=9 meditation for free XP cushion')

  // `eager` mode on the exact same state breaks immediately!
  const eagerPlan = planXianActions(wSubLv5, t0, { enabled: true, breakMode: 'eager' })
  assert.ok(eagerPlan.actions.some((a) => a.a === 'xsBreak'), 'eager mode breaks immediately when pills >= r+1')

  // `manual` mode even at `lv = 5` never emits `xsBreak`
  const xsLv5Full = structuredClone(xsSubLv5)
  xsLv5Full.lv = 5
  const manualPlan = planXianActions(makeBaseWorld(adapter, t0, xsLv5Full), t0, { enabled: true, breakMode: 'manual' })
  assert.ok(!manualPlan.actions.some((a) => a.a === 'xsBreak'))

  // 2. Verify `xsBreak` BEFORE `xsRise` shields in-flight meditation XP on BOTH 60% success and 40% failure!
  const xsShield = structuredClone(xsLv5Full)
  xsShield.med = { t: t0 - 1500 } // 25 minutes of accrued meditation
  const wShield = makeBaseWorld(adapter, t0, xsShield)
  const shieldPlan = planXianActions(wShield, t0, { enabled: true, breakMode: 'smart' })
  const breakIdx = shieldPlan.actions.findIndex((a) => a.a === 'xsBreak')
  const riseIdx = shieldPlan.actions.findIndex((a) => a.a === 'xsRise')
  assert.ok(breakIdx >= 0 && riseIdx > breakIdx, `Expected xsBreak (${breakIdx}) strictly BEFORE xsRise (${riseIdx})`)

  // Success branch (`rand = 0.1 < 0.6`): enters `r = 2` AND keeps the 25-min session XP in the new realm (`xp > 0`)!
  const succOut = applyAuthoritativeXsBatch(wShield, shieldPlan.actions, () => 0.1)
  assert.equal(succOut.afterWorld.state.xs.cv.r, 2)
  assert.ok(succOut.afterWorld.state.xs.cv.xp > 0, 'Shielded meditation XP must carry into new realm after xsBreak!')

  // Failure branch (`rand = 0.9 >= 0.6`): 25-min session XP is added AFTER `Math.floor(xp * 0.7)` (100% untaxed!)
  const failOut = applyAuthoritativeXsBatch(wShield, shieldPlan.actions, () => 0.9)
  const expectedUntaxedFloor = Math.floor(xsShield.cv.xp * 0.7)
  assert.ok(failOut.afterWorld.state.xs.cv.xp > expectedUntaxedFloor + 200)
})

test('Phase 11.6: Pentagon C_5 4-root dual-fusion protection, target filter, and pre-fusion base-tech preservation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000

  // 1. 4-root chain `fire - metal - water - wood`:
  //    Middle edge `metal+water` (`ice`) would strand `fire` & `wood` (`totalReachableFusions = 1`).
  //    `selectOptimalFusionPair` with `auto` MUST select an endpoint (`fire+metal -> thunder` or `water+wood -> wind`, `totalReachableFusions = 2`)!
  const fourRoots = { e: ['fire', 'metal', 'water', 'wood'], v: [] }
  const bestAuto = selectOptimalFusionPair(fourRoots, 'auto')
  assert.ok(bestAuto)
  assert.equal(bestAuto.totalReachableFusions, 2)
  assert.notEqual(bestAuto.variantId, 'ice', 'Must NEVER pick middle edge on P_4 4-root chain!')
  assert.ok(['thunder', 'wind'].includes(bestAuto.variantId))

  // Explicit user `--xian-fuse-target wind` picks `water+wood`
  const pickWind = selectOptimalFusionPair(fourRoots, 'wind')
  assert.equal(pickWind?.variantId, 'wind')
  assert.equal(pickWind?.key, 'water+wood')

  // 2. Pre-fusion tech preservation + low-`cv.xp` window gate
  const xsFuseState = makePostPrologueXs(t0, ['metal', 'water'])
  xsFuseState.lv = 5
  xsFuseState.en = 4
  xsFuseState.stone = 500
  xsFuseState.cv = { r: 1, s: 1, xp: 0 }
  xsFuseState.pills = { peiyuan: 2 }
  xsFuseState.techs = ['metal'] // `water` tech NOT learned yet!
  xsFuseState.tech = 'metal'
  xsFuseState.med = { t: t0 - 120 }
  for (let i = 0; i < 8; i++) xsFuseState.plots[i] = { s: 'soil', c: 'leizhu', g: 1, w: t0 - 60 }
  xsFuseState.plots[14] = { s: 'soil', c: 'leizhu', g: 1, w: t0 - 60 }
  xsFuseState.plots[15] = { s: 'soil', c: 'leizhu', g: 1, w: t0 - 60 }

  const wFuse = makeBaseWorld(adapter, t0, xsFuseState)
  const fusePlan = planXianActions(wFuse, t0, { enabled: true, autoFuse: true, fuseTarget: 'auto' })
  // Must learn `water` (`xsLearn`) BEFORE emitting `xsFuse` in the same or prior batch!
  const learnWaterIdx = fusePlan.actions.findIndex((a) => a.a === 'xsLearn' && a.el === 'water')
  const fuseIdx = fusePlan.actions.findIndex((a) => a.a === 'xsFuse' && a.el === 'metal+water')
  assert.ok(learnWaterIdx >= 0, 'Must learn water tech before fusing metal+water!')
  assert.ok(fuseIdx > learnWaterIdx, 'xsFuse must run strictly after both base techs are learned!')

  // Verify after fusion succeeds (`rand = 0.1 < 0.55`), both `metal` and `water` remain permanently equippable in `techs`!
  const fusedRes = applyAuthoritativeXsBatch(wFuse, fusePlan.actions, () => 0.1)
  const afterXs = fusedRes.afterWorld.state.xs
  assert.deepEqual(afterXs.roots.v, ['ice'])
  assert.deepEqual(afterXs.roots.e, [])
  assert.ok(afterXs.techs.includes('metal') && afterXs.techs.includes('water'))
  const equipCheck = xsAct(structuredClone(afterXs), { a: 'equip', el: 'water' }, t0 + 5)
  assert.equal(equipCheck.ok, true, 'Previously learned base tech stays permanently equippable after root fusion!')
})

test('Phase 11.7: Journal recording, deterministic xs Layer 1/3 audit verification, and unknown-receipt reconciliation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794450000
  const tmp = makeTempDir('p11-audit-')

  try {
    const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })
    let serverWorld = makeBaseWorld(adapter, t0, makePostPrologueXs(t0, ['metal']))

    const mockHttp = {
      estimatedServerNowSec: () => serverWorld.now,
      getJson: async (url) => {
        assert.equal(url, '/api/pet/world')
        return structuredClone(serverWorld)
      },
      postJson: async (url, payload) => {
        assert.equal(url, '/api/pet/world/act')
        const { afterWorld, out } = applyAuthoritativeXsBatch(serverWorld, payload.actions, () => 0.25)
        serverWorld = afterWorld
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            rev: serverWorld.rev,
            now: serverWorld.now,
            coins: serverWorld.coins,
            state: structuredClone(serverWorld.state),
            out,
          },
        }
      },
    }

    const sliceOut = await runXianCultivationSlice({
      account: 'main',
      adapter,
      httpClient: mockHttp,
      journal,
      lockRootDir: path.join(tmp, 'locks'),
      observedWorld: serverWorld,
      xianOptions: { enabled: true },
    })
    assert.equal(sliceOut.status, 'confirmed')
    assert.ok(sliceOut.actions.length > 0)
    assert.ok(sliceOut.nextXianWakeSec === t0 + BREW_READY_SEC || sliceOut.nextXianWakeSec > t0)

    const { transactions } = journal.reconstructTransactions()
    assert.equal(transactions.length, 1)
    const tx = transactions[0]
    assert.equal(tx.kind, 'xian-act')
    assert.equal(tx.status, 'confirmed')

    const replay = await auditTransactionReplay(journal, tx, { fallbackAdapter: adapter })
    assert.equal(replay.status, 'consistent-external-xian')
    assert.deepEqual(replay.serverDrifts, [])

    const report = await buildAuditDecisionReport({ journal, tx, adapter })
    assert.equal(report.verdict, 'ex-ante-consistent')

    // Simulate network drop (`unknown`) followed by `reconcileUnknownWithFreshWorld` when `rev` did not advance
    serverWorld.now += 600
    xsTick(serverWorld.state.xs, serverWorld.now)
    serverWorld.state.xs.plots[0] = { s: 'soil', c: 'jingu', g: 3, w: 0 }

    const dropHttp = {
      estimatedServerNowSec: () => serverWorld.now,
      getJson: async () => structuredClone(serverWorld),
      postJson: async () => ({ ok: false, status: null, networkError: true }),
    }
    const dropOut = await runXianCultivationSlice({
      account: 'main',
      adapter,
      httpClient: dropHttp,
      journal,
      lockRootDir: path.join(tmp, 'locks'),
      observedWorld: serverWorld,
      xianOptions: { enabled: true },
    })
    assert.equal(dropOut.status, 'unknown')

    const freshUnchanged = structuredClone(serverWorld)
    freshUnchanged.now += 5
    const rec = reconcileUnknownWithFreshWorld(journal, adapter, freshUnchanged)
    assert.equal(rec.reconciled, 1)
    assert.equal(rec.remainingNonVisitUnknown, 0)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
