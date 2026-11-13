import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import {
  DEFAULT_MANUAL_ARCADE_TTL_SEC,
  buildObservationEnvelope,
  computeStaticFarmStateDigest,
  getManualArcadeStandbyInfo,
  isFarmDomainPassiveCompatible,
} from '../model/observations.mjs'
import { collectClaimableGoalActions, solveUnifiedPlan } from '../planner/solve.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { runSingleArenaBout, syncBattleProfilesAndPreparation } from '../execution/pet-and-battle.mjs'
import { computeNextNpcWakeSec, runNpcToyStallSlice, solveGomokuForSeed } from '../execution/npc-toy-stall.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { auditTransactionReplay } from '../audit/replay.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')

function makeTempDir(prefix = 'p17-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makePrices(adapter, tSec) {
  const iDay = adapter.R.isleDay(tSec)
  const out = {}
  for (const id of adapter.graph.sellableIds) {
    out[id] = adapter.R.priceOf(id, iDay, 0)
  }
  return out
}

test('Phase 17.1: Daily goal all-clear bonus (k=4) claims standalone, in-batch with k=0..3, post-sell, and triggers battle gear prep reset', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH)
  const R = adapter.R
  const baseT = Math.floor(Date.UTC(2026, 10, 13, 4, 0, 0) / 1000) // 12:00 CST (noon), deterministic worldDay
  const wBase = adapter.cloneWorld({
    now: baseT,
    clockStart: baseT - 86400,
    coins: 5000,
    prices: makePrices(adapter, baseT),
    state: {
      ...R.newWorld(baseT),
      en: 0,
      plots: [],
      barn: [],
      traps: [],
      inv: {},
      cnt: {},
    },
    rev: 10,
  })
  const natDay = R.worldDay(baseT)
  const goals = R.dailyGoals(natDay, wBase.state)
  assert.equal(goals.length, 4)

  // Case A: All 4 goals already claimed (`cnt.goal0..3 = 1`), `goal4` unclaimed, 0 stamina & 0 farm work
  const wA = adapter.cloneWorld(wBase)
  wA.state.goals = { day: natDay, list: wBase.state.goals.list.slice() }
  wA.state.cnt = { goal0: 1, goal1: 1, goal2: 1, goal3: 1 }
  const envA = buildObservationEnvelope(adapter, { account: 'acc', world: wA })
  const planA = solveUnifiedPlan(adapter, envA, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['goal', 'sell', 'craft', 'wait'],
  })
  const actsA = planA.trunkBuckets[0]?.domesticActions || []
  assert.deepEqual(actsA.filter((a) => a.a === 'goal'), [{ a: 'goal', k: 4 }])
  const compiledA = compileExecutablePrefix(adapter, wA, planA)
  assert.equal(compiledA.status, 'ready')
  const simA = adapter.simulateBatch(wA, compiledA.domesticBatch, { t: baseT, prices: wA.prices })
  assert.equal(simA.afterWorld.state.cnt.goal4, 1)
  assert.equal(simA.afterWorld.coins - wA.coins, R.GOAL_BONUS_COINS || 30000)
  assert.equal(simA.afterWorld.state.inv?.emerald?.[0] || 0, 1)
  assert.equal(simA.afterWorld.state.inv?.bomb?.[0] || 0, 2)

  // Verify `runLiveAccountTick` resets `runtimeState.lastBattlePrepAtSec = 0` when a `goal` batch confirms
  const tmp = makeTempDir('p17-goal-tick-')
  let serverWorld = adapter.cloneWorld(wA)
  const tickClient = new KernelHttpClient({
    cookieHeader: 'sid=acc',
    nowMsFn: () => baseT * 1000,
    sleepMsFn: async () => {},
    fetchImpl: async (url, init) => {
      const p = new URL(url).pathname
      if (p === '/api/pet/world') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify(serverWorld) }
      }
      if (init.method === 'POST' && p === '/api/pet/world/act') {
        const body = JSON.parse(init.body)
        if (Number(body.rev) !== Number(serverWorld.rev)) {
          return {
            status: 409,
            headers: new Map(),
            text: async () => JSON.stringify({ error: '小岛状态已变化', code: 'world_conflict', rev: serverWorld.rev, state: serverWorld.state }),
          }
        }
        const sim = adapter.simulateBatch(serverWorld, body.actions, { t: baseT, prices: serverWorld.prices })
        sim.afterWorld.rev = (serverWorld.rev || 0) + 1
        serverWorld = sim.afterWorld
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true, out: sim.result.out, world: serverWorld }) }
      }
      throw new Error(`Unexpected endpoint ${init.method} ${p}`)
    },
  })
  const runtimeState = {
    lastPetCareAtSec: baseT,
    lastBattlePrepAtSec: baseT,
    lastHuancaiCheckAtSec: baseT,
    arenaRemaining: 0,
  }
  const tickOut = await runLiveAccountTick({
    account: 'acc',
    adapter,
    httpClient: tickClient,
    journal: new ContentAddressedJournal({ rootDir: path.join(tmp, 'j'), account: 'acc' }),
    snipeScheduler: null,
    lockRootDir: path.join(tmp, 'locks'),
    profileStorePath: path.join(tmp, 'opp.json'),
    runtimeState,
    baseUserConstraints: { allowCapex: false, cashReserveFloor: 0 },
    solverOptions: { checkHorizonStability: false, maxSteps: 1 },
  })
  assert.equal(tickOut.controllerOut.status, 'confirmed')
  assert.equal(runtimeState.lastBattlePrepAtSec, 0, 'goal reward claim must trigger immediate battle gear prep reset')
  assert.equal(serverWorld.state.cnt.goal4, 1)

  // Case B: All 4 goals completed simultaneously -> single batch claims k = 0, 1, 2, 3, 4
  const wB = adapter.cloneWorld(wBase)
  wB.state.cnt = {}
  for (const g of goals) {
    wB.state.cnt[g.id] = Math.max(Number(wB.state.cnt[g.id] || 0), g.n)
  }
  const directActsB = collectClaimableGoalActions(R, natDay, wB.state)
  assert.deepEqual(directActsB, [
    { a: 'goal', k: 0 },
    { a: 'goal', k: 1 },
    { a: 'goal', k: 2 },
    { a: 'goal', k: 3 },
    { a: 'goal', k: 4 },
  ])
  const envB = buildObservationEnvelope(adapter, { account: 'acc', world: wB })
  const planB = solveUnifiedPlan(adapter, envB, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['goal', 'sell', 'craft', 'wait'],
  })
  const simB = adapter.simulateBatch(wB, planB.trunkBuckets[0].domesticActions, { t: baseT, prices: wB.prices })
  assert.equal(simB.result.out.filter((o) => !o.ok).length, 0)
  assert.equal(simB.afterWorld.state.cnt.goal4, 1)

  // Case C: `sold` goal (`80,000`) completed by `sell` inside bucket 0 -> immediate post-sell claim with `k = 4`
  let soldTimeSec = null
  for (let dOff = 0; dOff < 60; dOff++) {
    const tTry = baseT + dOff * 86400
    const gsTry = R.dailyGoals(R.worldDay(tTry), R.newWorld(tTry))
    if (gsTry.some((g) => g.id === 'sold')) {
      soldTimeSec = tTry
      break
    }
  }
  assert.ok(soldTimeSec != null, 'expected a day with a `sold` goal')
  const prC = makePrices(adapter, soldTimeSec)
  prC.ruby = 50000
  const lowPrC = { ...prC, ruby: 10000 }
  const wC = adapter.cloneWorld({
    now: soldTimeSec,
    clockStart: soldTimeSec - 86400,
    coins: 5000,
    prices: prC,
    state: {
      ...R.newWorld(soldTimeSec),
      en: 0,
      plots: [],
      barn: [],
      traps: [],
      inv: { ruby: [50, 0, 0] },
      cnt: {},
    },
    rev: 20,
  })
  const goalsC = R.dailyGoals(R.worldDay(soldTimeSec), wC.state)
  goalsC.forEach((g, idx) => {
    if (g.id !== 'sold') wC.state.cnt[`goal${idx}`] = 1
  })
  const envC = buildObservationEnvelope(adapter, { account: 'acc', world: wC })
  const iNowC = R.isleIndex(soldTimeSec)
  const planC = solveUnifiedPlan(adapter, envC, buildObjectiveConfig({ horizonSec: 300 }), {
    allowedActionTypes: ['goal', 'sell', 'wait'],
    explicitPricesByIsleIndex: { [iNowC]: prC, [iNowC + 1]: lowPrC },
  })
  const actsC = planC.trunkBuckets[0]?.domesticActions || []
  const goalIndicesC = actsC.filter((a) => a.a === 'goal').map((a) => a.k)
  const soldIdx = goalsC.findIndex((g) => g.id === 'sold')
  assert.ok(actsC.some((a) => a.a === 'sell'), 'bucket 0 must sell inventory')
  assert.ok(goalIndicesC.includes(soldIdx), 'post-sell goal check must claim newly satisfied `sold` goal in-batch')
  assert.ok(goalIndicesC.includes(4), 'post-sell goal check must also claim `k=4` all-clear bonus in-batch')
  const simC = adapter.simulateBatch(wC, actsC, { t: soldTimeSec, prices: prC })
  assert.equal(simC.afterWorld.state.cnt.goal4, 1)
})

test('Phase 17.2: syncBattleProfilesAndPreparation opens all 5 ready daily chests via gear.daily + POST {} and equips dropped Legendary upgrade in same lock', async () => {
  const tmp = makeTempDir('p17-chests-')
  const lockDir = path.join(tmp, 'locks')
  let simMs = 1_794_558_000_000
  let chestsOpenedCount = 0
  let equippedWeapon = 'wp_rare'
  let droppedLegend = false
  const chestPayloads = []
  const equipCalls = []

  const buildGearPayload = () => {
    const items = [
      { id: 'wp_rare', name: 'RareSword', slot: 'weapon', rarity: 2, lv: 0, atk: 14, spd: 2 },
      { id: 'ar_rare', name: 'RareArmor', slot: 'armor', rarity: 2, lv: 0, hp: 60, def: 8 },
      { id: 'ch_rare', name: 'RareCharm', slot: 'charm', rarity: 2, lv: 0, agi: 4 },
    ]
    if (droppedLegend) {
      items.push({ id: 'wp_legend', name: 'DragonBlade', slot: 'weapon', rarity: 4, lv: 0, atk: 55, spd: 12, hp: 40 })
    }
    const byId = new Map(items.map((x) => [x.id, x]))
    return {
      catalog: items,
      items,
      gear: {
        weapon: byId.get(equippedWeapon),
        armor: byId.get('ar_rare'),
        charm: byId.get('ch_rare'),
      },
      freePoints: 0,
      points: { str: 20, vit: 6, agi: 4, spd: 8 },
      daily: {
        trained: 0,
        chest: chestsOpenedCount,
        chestMax: 5,
        battles: 30,
        need: 3,
        earned: 5,
        ready: chestsOpenedCount < 5,
        nextAt: 3,
      },
      pity: 10,
    }
  }

  const client = new KernelHttpClient({
    cookieHeader: 'sid=acc2',
    nowMsFn: () => simMs,
    sleepMsFn: async () => {},
    fetchImpl: async (url, init) => {
      const p = new URL(url).pathname
      const body = init.body ? JSON.parse(init.body) : null
      if (init.method === 'GET' && p === '/api/pet/battle/home') {
        // Live `/api/pet/battle/home` has NO `chests` field!
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            adopted: true,
            today: { used: 30, limit: null, unlimited: true, drops: 30 },
            history: [],
          }),
        }
      }
      if (init.method === 'GET' && p === '/api/pet/world/guard-log') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ battles: [] }) }
      }
      if (init.method === 'GET' && p === '/api/pet/battle/gear') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify(buildGearPayload()) }
      }
      if (init.method === 'POST' && p === '/api/pet/battle/chest') {
        chestPayloads.push(body)
        chestsOpenedCount++
        let gotItem = { id: 'ar_rare', rarity: 2 }
        if (chestsOpenedCount === 3) {
          droppedLegend = true
          gotItem = { id: 'wp_legend', rarity: 4 }
        }
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            ...buildGearPayload(),
            got: { item: gotItem, pity: 10, upgraded: false },
          }),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/battle/equip') {
        equipCalls.push(body)
        if (body.slot === 'weapon') equippedWeapon = body.item
        return { status: 200, headers: new Map(), text: async () => JSON.stringify(buildGearPayload()) }
      }
      if (init.method === 'GET' && p === '/api/pet/battle/opponents') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ opponents: [{ id: 801, name: 'Bot', level: 8, left: 3, power: 200 }] }),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/battle') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            id: 901,
            result: 'win',
            coins: 200,
            fighters: [
              { id: 1001, level: 10, hp: 300, atk: 50, def: 10, agi: 15, spd: 20 },
              { id: 801, level: 8, hp: 200, atk: 30, def: 5, agi: 10, spd: 12 },
            ],
          }),
        }
      }
      throw new Error(`Unexpected endpoint ${init.method} ${p}`)
    },
  })

  const prepRes = await syncBattleProfilesAndPreparation(client, {
    accountKey: 'acc2',
    lockRoot: lockDir,
    storePath: path.join(tmp, 'profiles.json'),
  })
  assert.equal(prepRes.ok, true)
  assert.equal(chestsOpenedCount, 5, 'all 5 daily chests must be opened')
  assert.equal(chestPayloads.length, 5)
  for (const pl of chestPayloads) {
    assert.deepEqual(pl, {}, 'live /api/pet/battle/chest expects empty `{}` payload')
  }
  assert.equal(equippedWeapon, 'wp_legend', 'newly dropped Legendary weapon must equip in the exact same lock')
  assert.ok(equipCalls.some((c) => c.slot === 'weapon' && c.item === 'wp_legend'))

  // Also verify `chestMilestoneReached` on bout 3 (`used: 2 -> 3`) and non-milestone (`used: 1 -> 2`)
  const boutNonMilestone = await runSingleArenaBout(client, {
    accountKey: 'acc2',
    lockRoot: lockDir,
    homeData: { adopted: true, today: { used: 1, limit: 30 } },
    minBoutGapMs: 0,
  })
  assert.equal(boutNonMilestone.chestMilestoneReached, false)

  const boutMilestone = await runSingleArenaBout(client, {
    accountKey: 'acc2',
    lockRoot: lockDir,
    homeData: { adopted: true, today: { used: 2, limit: 30 } },
    minBoutGapMs: 0,
  })
  assert.equal(boutMilestone.chestMilestoneReached, true)
})

test('Phase 17.3: 52D Toy Stall beats 15x15 Hard Gomoku deterministically, completes 52/52 quota cleanly, passes Layer-1/Layer-3 audits & preserves PlanCache across gomoku start', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH)
  const R = adapter.R

  // 1. 25 deterministic seeds of 15x15 d=3 Hard Gomoku
  for (let i = 1; i <= 25; i++) {
    const seed = (i * 2654435761) % 1_000_000_000
    const res = solveGomokuForSeed(R, seed, 3, 15)
    assert.equal(R.gomokuReplay(seed, res.mv, 3, 15), 'win', `seed=${seed} must win 15x15 d=3`)
  }

  // 2. End-to-end stateful simulation: 10 paid d=3 Gomoku + batched Card games -> 52/52 quota + Layer-1/Layer-3 audits
  const tmp = makeTempDir('p17-npc-')
  const lockDir = path.join(tmp, 'locks')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'acc3' })
  let simMs = Math.floor(Date.UTC(2026, 10, 13, 6, 0, 0) / 1000) * 1000
  let prngStep = 1
  const detRand = () => {
    prngStep = (prngStep * 1664525 + 1013904223) >>> 0
    return prngStep / 4294967296
  }
  const initSec = Math.floor(simMs / 1000)
  const baseInitState = R.newWorld(initSec)
  R.b12State(baseInitState)
  baseInitState.seen ||= []
  baseInitState.iq ||= { d: R.isleIndex(initSec) }
  let serverWorld = adapter.cloneWorld({
    now: initSec,
    clockStart: initSec - 86400,
    coins: 1000,
    prices: makePrices(adapter, initSec),
    state: {
      ...baseInitState,
      en: 0,
      plots: [],
      barn: [],
      traps: [],
      inv: {},
      cnt: {},
    },
    rev: 1,
  })

  let httpCalls = 0
  let rejectedActOps = 0
  const client = new KernelHttpClient({
    cookieHeader: 'sid=acc3',
    nowMsFn: () => simMs,
    sleepMsFn: async (ms) => { simMs += ms },
    fetchImpl: async (url, init) => {
      httpCalls++
      const p = new URL(url).pathname
      if (p === '/api/pet/world') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ ...serverWorld, now: Math.floor(simMs / 1000) }),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/world/act') {
        const body = JSON.parse(init.body)
        if (Number(body.rev) !== Number(serverWorld.rev)) {
          return {
            status: 409,
            headers: new Map(),
            text: async () => JSON.stringify({ error: '小岛状态已变化', code: 'world_conflict', rev: serverWorld.rev, state: serverWorld.state }),
          }
        }
        const nowS = Math.floor(simMs / 1000)
        const sim = adapter.simulateBatch(serverWorld, body.actions, {
          t: nowS,
          prices: serverWorld.prices,
          rand: detRand,
        })
        for (const o of sim.result.out || []) {
          if (!o?.ok) rejectedActOps++
        }
        sim.afterWorld.rev = (serverWorld.rev || 0) + 1
        serverWorld = sim.afterWorld
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ ok: true, out: sim.result.out, world: serverWorld }),
        }
      }
      throw new Error(`Unexpected endpoint ${init.method} ${p}`)
    },
  })

  let gomokuStartBefore = null
  let gomokuStartAfter = null
  let loopCount = 0
  while (loopCount < 50) {
    loopCount++
    const preSnapshot = adapter.cloneWorld(serverWorld)
    const out = await runNpcToyStallSlice({
      account: 'acc3',
      adapter,
      httpClient: client,
      journal,
      lockRootDir: lockDir,
      observedWorld: serverWorld,
    })
    if (out.status === 'quota-complete') break
    assert.equal(out.status, 'confirmed')
    if (out.actions?.[0]?.g === 'gomoku' && out.actions?.[0]?.k === 'start' && !gomokuStartBefore) {
      gomokuStartBefore = preSnapshot
      gomokuStartAfter = out.worldAfter || out.txResult.worldAfter
    }
  }

  assert.equal(rejectedActOps, 0, 'zero rejected action items across all 52+ NPC transactions')
  assert.equal(serverWorld.state.cnt.gomokuPaid, 10)
  assert.equal(serverWorld.state.cnt.npc, 52)
  assert.equal(serverWorld.state.npcG, undefined)
  assert.ok(loopCount < 35, `completed 10 Gomoku + card batches efficiently in ${loopCount} slices`)

  // Zero-HTTP fast exit once 52/52 quota is reached
  const callsBeforeIdleCheck = httpCalls
  const idleOut = await runNpcToyStallSlice({
    account: 'acc3',
    adapter,
    httpClient: client,
    journal,
    lockRootDir: lockDir,
    observedWorld: serverWorld,
  })
  assert.equal(idleOut.status, 'quota-complete')
  assert.equal(httpCalls, callsBeforeIdleCheck, 'quota-complete fast path must issue ZERO HTTP requests')
  assert.ok(idleOut.nextNpcWakeSec > serverWorld.now + 300)

  // Verify `isFarmDomainPassiveCompatible`: `true` across `gomoku start`, `false` if coins/inv change
  assert.ok(gomokuStartBefore && gomokuStartAfter)
  assert.equal(computeStaticFarmStateDigest(gomokuStartBefore), computeStaticFarmStateDigest(gomokuStartAfter))
  assert.equal(isFarmDomainPassiveCompatible(adapter, gomokuStartBefore, gomokuStartAfter), true)
  const wCoinWin = adapter.cloneWorld(gomokuStartAfter)
  wCoinWin.rev += 1
  wCoinWin.coins += 500
  assert.equal(isFarmDomainPassiveCompatible(adapter, gomokuStartBefore, wCoinWin), false)

  // Verify EVERY `npc-act` transaction in journal passes Layer-1 replay & Layer-3 audit!
  const hist = journal.reconstructTransactions()
  const npcTxs = hist.transactions.filter((tx) => tx.kind === 'npc-act')
  assert.ok(npcTxs.length >= 20)
  for (const tx of npcTxs) {
    const rep = await auditTransactionReplay(journal, tx, { fallbackAdapter: adapter })
    assert.equal(rep.identifiable, true)
    assert.equal(rep.rejectedSimIndices.length, 0)
    const report = await buildAuditDecisionReport({ journal, tx, adapter })
    assert.equal(report.verdict, 'ex-ante-consistent')
  }

  // Verify unfinished `box` game completion (3 picks -> completed cleanly)
  serverWorld.state.cnt.npc = 40
  serverWorld.state.npcG = { g: 'box', left: R.BOX_SET.slice(), me: [], np: [] }
  serverWorld.rev += 1
  for (let p = 0; p < 3; p++) {
    const boxOut = await runNpcToyStallSlice({
      account: 'acc3',
      adapter,
      httpClient: client,
      journal,
      lockRootDir: lockDir,
      observedWorld: serverWorld,
    })
    assert.equal(boxOut.status, 'confirmed')
    assert.equal(boxOut.actions[0].g, 'box')
    assert.equal(boxOut.actions[0].k, 'pick')
  }
  assert.equal(rejectedActOps, 0)
  assert.equal(serverWorld.state.npcG, undefined)
})

test('Phase 17.4: B26 warehouse rework parity — availableInv excludes b12.vault, b26Check enforces 12-slot/300-unit Lv1 caps, and digest detects warehouse edits', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH)
  const R = adapter.R
  const t0 = Math.floor(Date.UTC(2026, 10, 13, 4, 0, 0) / 1000)
  const w = adapter.cloneWorld({
    now: t0,
    clockStart: t0 - 86400,
    coins: 50000,
    prices: makePrices(adapter, t0),
    state: {
      ...R.newWorld(t0),
      inv: {
        tomato: [10, 5, 0],
        copper: [50, 0, 0],
      },
      b12: {
        v: 1,
        vault: {
          tomato: [6, 5, 0],
        },
        keep: {},
      },
    },
    rev: 5,
  })

  // `availableInvSnapshot` must exclude `b12.vault` stock so kernel never sells/crafts/eats vaulted goods
  const avail = adapter.availableInvSnapshot(w.state)
  assert.deepEqual(avail.tomato, [4, 0, 0])
  assert.deepEqual(avail.copper, [50, 0, 0])

  // Digest detects both `b12.vault` and `b26` changes
  const d0 = computeStaticFarmStateDigest(w)
  const wVaultMut = adapter.cloneWorld(w)
  wVaultMut.state.b12.vault.tomato[0] = 7
  assert.notEqual(computeStaticFarmStateDigest(wVaultMut), d0)

  const wB26Mut = adapter.cloneWorld(w)
  wB26Mut.state.b26 = { v: 1, lv: 2, order: {}, alert: {}, sold: [] }
  assert.notEqual(computeStaticFarmStateDigest(wB26Mut), d0)

  // Live `B26` table & `b26State` + `simulateBatch` enforce Lv1 caps (12 slots, 300/slot) and Lv2 upgrade (600/slot)
  assert.equal(typeof R.b26State, 'function')
  assert.deepEqual(R.B26.slots, [12, 18, 22, 30])
  assert.deepEqual(R.B26.unit, [300, 600, 1200, 2400])
  const wCapTest = adapter.cloneWorld(w)
  wCapTest.state.inv.tomato = [350, 0, 0]
  const simLv1 = adapter.simulateBatch(wCapTest, [{ a: 'warehouse', id: 'tomato', q: 0, n: 301 }], {
    t: t0,
    prices: wCapTest.prices,
  })
  assert.equal(simLv1.result.out[0]?.ok, false, 'adding beyond 300/slot at Lv1 must be blocked')
  wCapTest.state.b26 = { v: 1, lv: 2, order: {}, alert: {}, sold: [] }
  const simLv2 = adapter.simulateBatch(wCapTest, [{ a: 'warehouse', id: 'tomato', q: 0, n: 301 }], {
    t: t0,
    prices: wCapTest.prices,
  })
  assert.equal(simLv2.result.out[0]?.ok, true, 'Lv2 increases per-slot cap to 600')
})

test('Phase 17.5: Manual arcade standby (state.arc.cur) isolates PlanCache and yields all writes until arcEnd or 180s TTL', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH)
  const R = adapter.R
  const t0 = Math.floor(Date.UTC(2026, 10, 13, 6, 0, 0) / 1000)
  const wBase = adapter.cloneWorld({
    now: t0,
    clockStart: t0 - 86400,
    rev: 100,
    coins: 0,
    prices: makePrices(adapter, t0),
    state: {
      ...R.newWorld(t0),
      en: 0,
      enT: t0,
      enDay: R.isleDay(t0),
      day: R.worldDay(t0),
      inv: {},
      plots: [],
      barn: [],
      traps: [],
      b12: { v: 1, lv: 0, xp: 0, rep: 0, ord: null, vault: {}, auto: 0, ordDone: 0, ordDay: '' },
      b26: { v: 1, lv: 1, order: {}, alert: {}, sold: [] },
      cnt: { npc: 52, gomokuPaid: 10, goal0: 1, goal1: 1, goal2: 1, goal3: 1, goal4: 1 },
      arc: { day: R.worldDay(t0), cnt: {}, best: {}, db: {}, cur: null },
      xs: { st: 'qi1', lv: 1, exp: 0, mp: 50, maxMp: 50, hp: 100, maxHp: 100, qi: 10, bag: {}, eq: {}, realm: null, cd: 0 },
    },
  })

  // 1) Standby TTL helpers
  assert.equal(DEFAULT_MANUAL_ARCADE_TTL_SEC, 180)
  const wDuringArc = adapter.cloneWorld(wBase)
  wDuringArc.rev = 101
  wDuringArc.state.arc = {
    day: R.worldDay(t0),
    cnt: { bounce: 1 },
    best: {},
    db: {},
    cur: { g: 'bounce', seed: 987654, t: t0 - 25 },
  }
  wDuringArc.state.b9Rank = { bounce: 120 }

  const activeInfo = getManualArcadeStandbyInfo(wDuringArc, t0)
  assert.equal(activeInfo.active, true)
  assert.equal(activeInfo.game, 'bounce')
  assert.equal(activeInfo.elapsedSec, 25)
  assert.equal(activeInfo.remainingSec, 155)
  assert.equal(activeInfo.resumeAtSec, t0 - 25 + 180)

  const escExpiredInfo = getManualArcadeStandbyInfo(wDuringArc, t0 - 25 + 180)
  assert.equal(escExpiredInfo.active, false)
  assert.equal(escExpiredInfo.remainingSec, 0)

  const disabledInfo = getManualArcadeStandbyInfo(wDuringArc, t0, { enabled: false })
  assert.equal(disabledInfo.active, false)

  // 2) Static farm digest & PlanCache invariance across state.arc / state.b9Rank mutations
  assert.equal(computeStaticFarmStateDigest(wDuringArc), computeStaticFarmStateDigest(wBase))
  assert.equal(isFarmDomainPassiveCompatible(adapter, wBase, wDuringArc), true)
  const wFarmMut = adapter.cloneWorld(wDuringArc)
  wFarmMut.rev = 102
  wFarmMut.state.inv.tomato = [3, 0, 0]
  assert.equal(isFarmDomainPassiveCompatible(adapter, wBase, wFarmMut), false)

  // 3) Live daemon tick standby while arc.cur active -> browser arcEnd succeeds with zero 409 -> immediate resume
  const tempRoot = makeTempDir('p17-arc-')
  try {
    let serverNow = t0
    let serverWorld = adapter.cloneWorld(wDuringArc)
    serverWorld.state.cnt.npc = 0
    serverWorld.state.cnt.gomokuPaid = 0
    const postPaths = []

    const makeMockHttpClient = () => ({
      stats: { getCount: 0, postCount: 0 },
      nowMsFn: () => serverNow * 1000,
      estimatedServerNowSec: () => serverNow,
      estimatedServerNowMs: () => serverNow * 1000,
      sleepMsFn: async () => {},
      async getJson(url) {
        this.stats.getCount++
        if (url === '/api/pet/world') return adapter.cloneWorld(serverWorld)
        if (url === '/api/pet/battle/gear') return { ok: true, items: [], equipped: {}, points: 0 }
        return { ok: true }
      },
      async postJson(url, body) {
        this.stats.postCount++
        postPaths.push({ url, rev: body?.rev })
        if (url === '/api/pet/world/act' && Number(body?.rev) !== Number(serverWorld.rev)) {
          return { ok: false, status: 409, networkError: false, body: { error: 'world_conflict' } }
        }
        serverWorld.rev += 1
        return { ok: true, status: 200, networkError: false, body: { ok: true, world: adapter.cloneWorld(serverWorld) } }
      },
    })

    const http1 = makeMockHttpClient()
    const journal1 = new ContentAddressedJournal({ rootDir: path.join(tempRoot, 'j1') })
    const runtime1 = { lastPetCareAtSec: t0, lastBattlePrepAtSec: t0, lastHuancaiCheckAtSec: t0, arenaRemaining: 0 }
    const tick1 = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient: http1,
      journal: journal1,
      snipeScheduler: null,
      lockRootDir: path.join(tempRoot, 'locks1'),
      profileStorePath: path.join(tempRoot, 'profiles1.json'),
      runtimeState: runtime1,
      xianOptions: { enabled: true },
      npcOptions: { enabled: true },
    })
    assert.equal(tick1.phase, 'arcade-standby')
    assert.equal(tick1.arcadeStandby.active, true)
    assert.equal(tick1.arcadeStandby.game, 'bounce')
    assert.ok(tick1.nextWakeSec <= t0 + 5)
    assert.equal(postPaths.length, 0, 'daemon must emit ZERO POSTs while manual arcade session is active')

    // Browser sends arcEnd with captured pre-end rev (101) -> no 409!
    assert.equal(serverWorld.rev, 101)
    serverWorld.state.arc.cur = null
    serverWorld.state.b9Rank = { bounce: 450 }
    serverWorld.rev = 102
    serverNow += 6

    const tick2 = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient: http1,
      journal: journal1,
      snipeScheduler: null,
      lockRootDir: path.join(tempRoot, 'locks1'),
      profileStorePath: path.join(tempRoot, 'profiles1.json'),
      runtimeState: runtime1,
      xianOptions: { enabled: false },
      npcOptions: { enabled: true },
    })
    assert.notEqual(tick2.phase, 'arcade-standby', 'clearing arc.cur resumes daemon immediately without waiting 180s')
    assert.ok(postPaths.some((p) => p.url === '/api/pet/world/act'), 'resumed tick executes normal pending work (NPC/farm)')

    // 4) Mid-Phase-C xian abort when arcStart occurs after Phase B finishes
    let getSeq = 0
    const postPathsMid = []
    serverWorld = adapter.cloneWorld(wBase)
    serverWorld.now = serverNow
    serverWorld.state.enT = serverNow
    serverWorld.state.cnt.npc = 0
    serverWorld.state.cnt.gomokuPaid = 0

    const http2 = {
      stats: { getCount: 0, postCount: 0 },
      nowMsFn: () => serverNow * 1000,
      estimatedServerNowSec: () => serverNow,
      estimatedServerNowMs: () => serverNow * 1000,
      sleepMsFn: async () => {},
      async getJson(url) {
        this.stats.getCount++
        if (url === '/api/pet/world') {
          getSeq++
          const wSnap = adapter.cloneWorld(serverWorld)
          if (getSeq >= 2) {
            wSnap.state.arc = {
              day: R.worldDay(serverNow),
              cnt: { bowl: 1 },
              best: {},
              db: {},
              cur: { g: 'bowl', seed: 555, t: serverNow },
            }
            wSnap.rev = serverWorld.rev + 1
          }
          return wSnap
        }
        return { ok: true }
      },
      async postJson(url, body) {
        this.stats.postCount++
        postPathsMid.push({ url, rev: body?.rev })
        return { ok: false, status: 409, networkError: false, body: { error: 'unexpected_post_during_arcade' } }
      },
    }
    const tickMid = await runLiveAccountTick({
      account: 'main',
      adapter,
      httpClient: http2,
      journal: new ContentAddressedJournal({ rootDir: path.join(tempRoot, 'j2') }),
      snipeScheduler: null,
      lockRootDir: path.join(tempRoot, 'locks2'),
      profileStorePath: path.join(tempRoot, 'profiles2.json'),
      runtimeState: { lastPetCareAtSec: serverNow, lastBattlePrepAtSec: serverNow, lastHuancaiCheckAtSec: serverNow, arenaRemaining: 0 },
      xianOptions: { enabled: true },
      npcOptions: { enabled: true },
    })
    assert.equal(tickMid.phase, 'arcade-standby')
    assert.equal(tickMid.arcadeStandby.game, 'bowl')
    assert.equal(postPathsMid.length, 0, 'mid-Phase-C arcStart aborts xian and skips npc with ZERO POSTs')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
