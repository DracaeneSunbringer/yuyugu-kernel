import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AsyncPlanManager, buildNeighborSignature } from '../execution/async-planner.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeTempDir(prefix = 'kernel-p18-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function exactMatureDurationSec(adapter, cropId, nowSec, h = 0, auto = true) {
  const st = adapter.R.cropStage({ c: cropId, t: nowSec, g: 0, w: 3, h }, nowSec, auto)
  return Math.max(60, Math.ceil(Number(st?.total || 14400)))
}

function findSummerMidDaySec(adapter, anchorSec = 1794485274) {
  const { R } = adapter
  let t = anchorSec
  for (let k = 0; k < 400; k++, t += 1800) {
    const iDay = R.isleDay(t)
    const remIsle = adapter.nextIsleBoundary(t, CLOCK_START) - t
    const remNat = adapter.nextNaturalDayBoundary(t) - t
    if (R.seasonOf(iDay) === 1 && remIsle >= 7200 && remNat >= 7200) {
      return t
    }
  }
  return anchorSec
}

function makeBaseSummerWorld(adapter, nowSec, overrides = {}) {
  const { R } = adapter
  const s = R.newWorld(nowSec)
  s.plotN = 24
  s.plots = Array(24).fill(null)
  s.barnN = 8
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4, spr: 3, house: 2 }
  s.mine = { max: 30 }
  s.en = 100
  s.enT = nowSec
  s.enDay = R.worldDay(nowSec)
  s.cnt = {}
  s.b12 = {}
  s.iq = { d: R.isleIndex(nowSec), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 }
  s.inv = {}
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(R.BASE_PRICE[id])
  }
  const { state: stateOverrides = {}, ...restOverrides } = overrides
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 12000,
    coins: 500000,
    prices,
    ...restOverrides,
    state: { ...s, ...stateOverrides },
  }
}

function makeUpcomingNeighborSnapshot(adapter, {
  targetId,
  name,
  nowSec,
  unlockAtSec,
  spots,
  cropId = 'tomato',
  level = 10,
  guard = false,
}) {
  const stealDelaySec = Number(adapter.R.WORLD?.steal?.delay ?? 1800)
  const matureAt = unlockAtSec - stealDelaySec
  let plantedAt = matureAt - exactMatureDurationSec(adapter, cropId, matureAt - 3600, 0, true)
  for (let iter = 0; iter < 5; iter++) {
    const pt = adapter.exactPlotTimings(
      { c: cropId, t: plantedAt, g: 0, w: 3, h: 0 },
      true,
      nowSec,
      CLOCK_START,
      { protectSec: stealDelaySec, isAlreadyRipe: matureAt <= nowSec }
    )
    if (!pt) break
    const err = pt.unlockAt - unlockAtSec
    if (err === 0) break
    plantedAt -= err
  }
  const isRipeNow = matureAt <= nowSec
  const rawPlots = Array.from({ length: spots }, () => ({
    c: cropId,
    t: plantedAt,
    g: 0,
    w: 3,
    h: 0,
  }))
  const islePlots = Array.from({ length: spots }, () => ({
    c: cropId,
    t: plantedAt,
    g: 0,
    w: 3,
    h: 0,
    stage: isRipeNow ? 3 : 2,
    left: isRipeNow ? 0 : Math.max(1, matureAt - nowSec),
    steal: false,
    stolen: 0,
    auto: true,
  }))
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    owner: { id: targetId, name, level, guard, newbie: false },
    state: { plots: rawPlots, barn: [], tools: { spr: 3 } },
    isle: { plots: islePlots, barn: [], spr: 3 },
  }
}

test('Phase 18.1: Cross-isle raid schedule near end of isle day (09:37 / -23m) executes intra-isle extraction immediately without locking TB[0] floor', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tMid = findSummerMidDaySec(adapter, 1794485274)
  const isleEnd = adapter.nextIsleBoundary(tMid, CLOCK_START)
  const t0 = isleEnd - 23 * 60

  const bombId = Object.entries(adapter.R.ITEMS || {}).find(([, v]) => /炸|bomb|tnt|dynamite/i.test(`${v?.id || ''} ${v?.name || ''}`))?.[0] || 'bomb'
  const baitId = Object.entries(adapter.R.ITEMS || {}).find(([, v]) => /饵|bait/i.test(`${v?.id || ''} ${v?.name || ''}`))?.[0] || 'bait'
  const tomDur = exactMatureDurationSec(adapter, 'tomato', t0, 0, true)
  const plots = Array.from({ length: 24 }, () => ({
    c: 'tomato',
    t: t0 - Math.floor(tomDur / 3),
    g: 0,
    w: 3,
    h: 0,
  }))

  const world = makeBaseSummerWorld(adapter, t0, {
    coins: 500000,
    state: {
      plots,
      en: 100,
      enT: t0,
      inv: {
        [bombId]: [4, 0, 0],
        [baitId]: [15, 0, 0],
        turnip: [40, 0, 0],
      },
      iq: { d: adapter.R.isleIndex(t0), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 },
    },
  })

  const snapNext1 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 98101,
    name: 'NextIsle98101',
    nowSec: t0,
    unlockAtSec: isleEnd + 600,
    spots: 16,
    cropId: 'corn',
    guard: false,
  })
  const snapNext2 = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 98102,
    name: 'NextIsle98102',
    nowSec: t0,
    unlockAtSec: isleEnd + 1500,
    spots: 12,
    cropId: 'corn',
    guard: false,
  })

  const env = buildObservationEnvelope(adapter, {
    account: 'main',
    world,
    upcomingNeighborTargets: [
      {
        id: 98101,
        unlockAtSec: isleEnd + 600,
        exactUnlockKnown: true,
        owner: snapNext1.owner,
        isle: snapNext1.isle,
      },
      {
        id: 98102,
        unlockAtSec: isleEnd + 1500,
        exactUnlockKnown: true,
        owner: snapNext2.owner,
        isle: snapNext2.isle,
      },
    ],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: true, cashReserveFloor: 100 },
  })

  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 3600 }), {
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
    stochasticPolicySamples: 1,
  })

  assert.ok(
    (plan.raidSchedule?.committedRaids?.length || 0) >= 1,
    `Expected future cross-isle raids committed, got ${plan.raidSchedule?.committedRaids?.length}`
  )
  const tb0Floor = Number(plan.trunkBuckets?.[0]?.plannedPostBucketEnFloor ?? Infinity)
  assert.ok(
    tb0Floor < 100,
    `TB[0] plannedPostBucketEnFloor must not stay locked at >=100 (got ${tb0Floor})`
  )
  const tb0Actions = plan.trunkBuckets?.[0]?.domesticActions || []
  const extractActs = tb0Actions.filter((a) => ['bomb', 'fish', 'mine', 'craft'].includes(a.a))
  assert.ok(
    extractActs.length >= 5,
    `Expected immediate intra-isle extraction actions in TB[0], got ${extractActs.length}: ${JSON.stringify(tb0Actions.slice(0, 10))}`
  )

  const prefix = compileExecutablePrefix(adapter, world, plan)
  assert.equal(prefix.status, 'ready')
  const firstBatchExtract = (prefix.domesticBatch || []).filter((a) => ['bomb', 'fish', 'mine', 'craft', 'buy', 'eat', 'coffee'].includes(a.a))
  assert.ok(firstBatchExtract.length > 0, 'compileExecutablePrefix must emit extraction batch immediately')

  // Verify across 14:00, 18:00, and 20:00 CST Summer isle boundaries under 24h horizon with cargo snacks
  // (plus live-default 3-scenario verification at CST 18:00 24h & CST 20:00 1h)
  const snackId = adapter.R.B12_SNACK?.id || 'snack_pack'
  const assertCrossIsleExtraction = (planObj, label) => {
    assert.ok(
      (planObj.raidSchedule?.committedRaids?.length || 0) >= 1,
      `${label}: expected raid committed, got ${planObj.raidSchedule?.committedRaids?.length}`
    )
    const flr = Number(planObj.trunkBuckets?.[0]?.plannedPostBucketEnFloor ?? Infinity)
    assert.ok(flr < 100, `${label}: TB[0] floor must be < 100, got ${flr}`)
    const ext = (planObj.trunkBuckets?.[0]?.domesticActions || []).filter((a) => ['bomb', 'fish', 'mine', 'craft'].includes(a.a))
    assert.ok(ext.length >= 5, `${label}: expected >=5 extraction actions in TB[0], got ${ext.length}`)
  }

  for (const targetCstHour of [14, 18, 20]) {
    let tDay0 = 0
    for (let k = 0; k < 1200; k++) {
      const sProbe = 1794485274 + k * 1800
      const end = adapter.nextIsleBoundary(sProbe, CLOCK_START)
      const iDay = adapter.R.isleDay(end - 60)
      const cstEnd = (((end + 8 * 3600) % 86400) / 3600)
      if (adapter.R.seasonOf(iDay) === 1 && cstEnd === targetCstHour) {
        tDay0 = end - 23 * 60
        break
      }
    }
    assert.ok(tDay0 > 0, `Could not find Summer isle boundary at CST ${targetCstHour}:00`)
    const iEndDay = adapter.nextIsleBoundary(tDay0, CLOCK_START)
    const tomDurDay = exactMatureDurationSec(adapter, 'tomato', tDay0, 0, true)
    const wDay = makeBaseSummerWorld(adapter, tDay0, {
      coins: 500000,
      state: {
        plots: Array.from({ length: 24 }, () => ({ c: 'tomato', t: tDay0 - Math.floor(tomDurDay / 3), g: 0, w: 3, h: 0 })),
        en: 100,
        enT: tDay0,
        inv: {
          [bombId]: [4, 0, 0],
          [baitId]: [15, 0, 0],
          turnip: [40, 0, 0],
          [snackId]: [5, 0, 0],
        },
        iq: { d: adapter.R.isleIndex(tDay0), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 },
      },
    })
    const snapDay = makeUpcomingNeighborSnapshot(adapter, {
      targetId: 98110 + targetCstHour,
      name: `NextIsleCst${targetCstHour}`,
      nowSec: tDay0,
      unlockAtSec: iEndDay + 600,
      spots: 18,
      cropId: 'corn',
      guard: false,
    })
    const envDay = buildObservationEnvelope(adapter, {
      account: 'main',
      world: wDay,
      upcomingNeighborTargets: [
        { id: 98110 + targetCstHour, unlockAtSec: iEndDay + 600, exactUnlockKnown: true, owner: snapDay.owner, isle: snapDay.isle },
      ],
      userConstraints: { allowCapex: false, allowThiefBuffPurchase: true, cashReserveFloor: 100 },
    })
    const planDay = solveUnifiedPlan(adapter, envDay, buildObjectiveConfig({ horizonSec: 86400 }), {
      scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
      stochasticPolicySamples: 1,
    })
    assertCrossIsleExtraction(planDay, `CST ${targetCstHour}:00 (24h 1sc)`)

    if (targetCstHour === 18) {
      const planDay3sc = solveUnifiedPlan(adapter, envDay, buildObjectiveConfig({ horizonSec: 86400 }))
      assertCrossIsleExtraction(planDay3sc, 'CST 18:00 (24h 3sc)')
    } else if (targetCstHour === 20) {
      const plan1h3sc = solveUnifiedPlan(adapter, envDay, buildObjectiveConfig({ horizonSec: 3600 }))
      assertCrossIsleExtraction(plan1h3sc, 'CST 20:00 (1h 3sc)')
    }
  }
})

test('Phase 18.2: Early isle day (00:41 / >3h remaining) with same-isle + next-isle raids executes intra-isle extraction in TB[0] instead of deferring all work', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tMid = findSummerMidDaySec(adapter, 1794485274)
  const targetIsle = adapter.R.isleIndex(tMid)
  let tIsleStart = tMid
  while (adapter.R.isleIndex(tIsleStart - 600) === targetIsle && tMid - tIsleStart < 24 * 3600) {
    tIsleStart -= 600
  }
  const isleEnd = adapter.nextIsleBoundary(tIsleStart, CLOCK_START)
  const t0 = tIsleStart + 41 * 60
  assert.ok(isleEnd - t0 >= 7200, `Expected >=2h remaining in isle day from early offset, got ${isleEnd - t0}s`)

  const bombId = Object.entries(adapter.R.ITEMS || {}).find(([, v]) => /炸|bomb|tnt|dynamite/i.test(`${v?.id || ''} ${v?.name || ''}`))?.[0] || 'bomb'
  const baitId = Object.entries(adapter.R.ITEMS || {}).find(([, v]) => /饵|bait/i.test(`${v?.id || ''} ${v?.name || ''}`))?.[0] || 'bait'
  const tomDur = exactMatureDurationSec(adapter, 'tomato', t0, 0, true)
  const plots = Array.from({ length: 24 }, () => ({
    c: 'tomato',
    t: t0 - Math.floor(tomDur / 4),
    g: 0,
    w: 3,
    h: 0,
  }))

  const world = makeBaseSummerWorld(adapter, t0, {
    coins: 500000,
    state: {
      plots,
      en: 100,
      enT: t0,
      inv: {
        [bombId]: [5, 0, 0],
        [baitId]: [15, 0, 0],
        turnip: [40, 0, 0],
      },
      iq: { d: adapter.R.isleIndex(t0), craft: 0, mine: 0, fish: 0, bomb: 0, steal: 0 },
    },
  })

  const sameIsleUnlock = t0 + 1800
  const nextIsleUnlock = isleEnd + 900
  const snapSame = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 98201,
    name: 'SameIsle98201',
    nowSec: t0,
    unlockAtSec: sameIsleUnlock,
    spots: 14,
    cropId: 'corn',
    guard: false,
  })
  const snapNext = makeUpcomingNeighborSnapshot(adapter, {
    targetId: 98202,
    name: 'NextIsle98202',
    nowSec: t0,
    unlockAtSec: nextIsleUnlock,
    spots: 16,
    cropId: 'corn',
    guard: false,
  })

  const env = buildObservationEnvelope(adapter, {
    account: 'main',
    world,
    upcomingNeighborTargets: [
      {
        id: 98201,
        unlockAtSec: sameIsleUnlock,
        exactUnlockKnown: true,
        owner: snapSame.owner,
        isle: snapSame.isle,
      },
      {
        id: 98202,
        unlockAtSec: nextIsleUnlock,
        exactUnlockKnown: true,
        owner: snapNext.owner,
        isle: snapNext.isle,
      },
    ],
    userConstraints: { allowCapex: false, allowThiefBuffPurchase: true, cashReserveFloor: 100 },
  })

  const horizonSec = Math.max(7200, (nextIsleUnlock - t0) + 1800)
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec }), {
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
    stochasticPolicySamples: 1,
  })

  assert.equal(
    plan.raidSchedule?.committedRaids?.length,
    2,
    `Expected both same-isle and next-isle raids committed, got ${plan.raidSchedule?.committedRaids?.length}`
  )
  const tb0Floor = Number(plan.trunkBuckets?.[0]?.plannedPostBucketEnFloor ?? Infinity)
  assert.ok(tb0Floor < 100, `TB[0] floor should stay below 100, got ${tb0Floor}`)
  const extractActs = (plan.trunkBuckets?.[0]?.domesticActions || []).filter((a) => ['bomb', 'fish', 'mine', 'craft'].includes(a.a))
  assert.ok(
    extractActs.length >= 5,
    `Early-isle TB[0] must perform immediate extraction rather than deferring to last same-isle bucket, got ${extractActs.length}`
  )
})

test('Phase 18.3: SnipeScheduler aligns refresh checks with 3600s/top-10 controller window and schedules exact horizon-entry wake', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const tmpDir = makeTempDir('p18-sched-')
  try {
    const world0 = makeBaseSummerWorld(adapter, t0, {
      state: { en: 80, iq: { d: adapter.R.isleIndex(t0), craft: 0, mine: 100, fish: 80, bomb: 10, steal: 0 } },
    })
    const sched = new SnipeScheduler({
      accountKey: 'main',
      scheduleFilePath: path.join(tmpDir, 'sched.json'),
      selfIds: [999999],
      controllerHorizonSec: 3600,
      maxUpcomingTargets: 10,
      maxReadyProbes: 4,
    })

    const topIds = []
    for (let i = 0; i < 10; i++) {
      const tid = 98301 + i
      topIds.push(tid)
      const snap = makeUpcomingNeighborSnapshot(adapter, {
        targetId: tid,
        name: `Top${tid}`,
        nowSec: t0,
        unlockAtSec: t0 + 1200 + i * 30,
        spots: 20,
        cropId: 'tomato',
        guard: false,
      })
      sched.recordVisitSnapshot(adapter, world0, tid, snap)
    }

    sched.syncCommittedRaidSchedule({
      planId: 'plan-18-3',
      serverNow: t0,
      raidSchedule: {
        planId: 'plan-18-3',
        createdAtSec: t0,
        truncatedByDeadline: false,
        committedRaids: [
          { targetId: topIds[0], unlockAtSec: t0 + 1200, energyCost: 15, plannedPrepActs: [] },
        ],
        evaluatedTargetIds: topIds,
      },
    }, world0)
    assert.equal(sched.needsScheduleRefresh(), false)

    // A) Positive-EV target unlocking outside controller's 3600s horizon (+5400s):
    //    must NOT trigger refresh spin (`needsRefresh === false`), while exposing exact `nextHorizonEntrySec = t0 + 1800`
    const snapFar = makeUpcomingNeighborSnapshot(adapter, {
      targetId: 98399,
      name: 'Far98399',
      nowSec: t0,
      unlockAtSec: t0 + 5400,
      spots: 24,
      cropId: 'tomato',
      guard: false,
    })
    sched.recordVisitSnapshot(adapter, world0, 98399, snapFar)
    assert.equal(sched.wouldTargetEnterControllerSet(t0, 98399), false)
    assert.equal(sched.needsScheduleRefresh(), false)
    assert.equal(sched.getScheduleRefreshReason(), null)
    sched.nextExactUnlockInfo(t0)
    assert.equal(sched.needsScheduleRefresh(), false)
    assert.equal(sched.nextHorizonEntrySec(t0), t0 + 1800)

    // B) Lower-score #11 target inside 3600s (+2500s, 1 spot) while top-10 (20 spots) are already evaluated:
    //    excluded by top-10 cap in `collectUpcomingTargetsForController`, so must NOT trigger `new-positive-ev-target`
    const snapLowRank = makeUpcomingNeighborSnapshot(adapter, {
      targetId: 98398,
      name: 'LowRank98398',
      nowSec: t0,
      unlockAtSec: t0 + 2500,
      spots: 1,
      cropId: 'turnip',
      guard: false,
    })
    sched.recordVisitSnapshot(adapter, world0, 98398, snapLowRank)
    const ctrlList0 = sched.collectUpcomingTargetsForController(adapter, world0, {
      horizonSec: 3600,
      maxUpcomingTargets: 10,
    })
    assert.equal(ctrlList0.some((c) => c.id === 98398), false)
    assert.equal(sched.wouldTargetEnterControllerSet(t0, 98398), false)
    assert.equal(sched.needsScheduleRefresh(), false)
    sched.nextExactUnlockInfo(t0)
    assert.equal(sched.needsScheduleRefresh(), false)

    // C) Advance to `t1 = t0 + 1800` once `98399` (`t0 + 5400 = t1 + 3600`) enters the 3600s horizon & top-10:
    //    `nextExactUnlockInfo(t1)` must now mark `needsScheduleRefresh() === true` cleanly
    const t1 = t0 + 1800
    const world1 = adapter.advanceTimeOnly(world0, t1)
    assert.equal(sched.wouldTargetEnterControllerSet(t1, 98399), true)
    const ctrlList1 = sched.collectUpcomingTargetsForController(adapter, world1, {
      horizonSec: 3600,
      maxUpcomingTargets: 10,
    })
    assert.equal(ctrlList1.some((c) => c.id === 98399), true)
    sched.nextExactUnlockInfo(t1)
    assert.equal(sched.needsScheduleRefresh(), true)
    assert.equal(sched.getScheduleRefreshReason(), 'new-positive-ev-target:98399')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Phase 18.4: AsyncPlanManager does not populate PlanCache with plans whose raidSchedule is truncatedByDeadline', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = findSummerMidDaySec(adapter, 1794485274)
  const world = makeBaseSummerWorld(adapter, t0)
  const env = buildObservationEnvelope(adapter, {
    account: 'main',
    world,
    upcomingNeighborTargets: [],
    userConstraints: { allowCapex: false, cashReserveFloor: 100 },
  })
  const objCfg = buildObjectiveConfig({ horizonSec: 1800 })
  const neighborSig = buildNeighborSignature([])
  const realPlan = solveUnifiedPlan(adapter, env, objCfg, {
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  const truncatedPlan = {
    ...realPlan,
    planId: 'plan-truncated-18-4',
    raidSchedule: {
      ...(realPlan.raidSchedule || {}),
      planId: 'plan-truncated-18-4',
      createdAtSec: t0,
      truncatedByDeadline: true,
      committedRaids: [],
      evaluatedTargetIds: [],
    },
  }
  const fullPlan = {
    ...realPlan,
    planId: 'plan-full-18-4',
    raidSchedule: {
      ...(realPlan.raidSchedule || {}),
      planId: 'plan-full-18-4',
      createdAtSec: t0 + 1,
      truncatedByDeadline: false,
      committedRaids: [],
      evaluatedTargetIds: [],
    },
  }

  let workerCall = 0
  const manager = new AsyncPlanManager({
    rulesPath: RULES_PATH,
    createWorkerFn: () => {
      const w = new EventEmitter()
      w.ref = () => {}
      w.unref = () => {}
      w.terminate = async () => {}
      w.postMessage = (msg) => {
        workerCall++
        const replyPlan = workerCall === 1 ? truncatedPlan : fullPlan
        queueMicrotask(() => {
          if (workerCall === 1) {
            w.emit('message', {
              kind: 'base-plan-checkpoint',
              jobId: msg.jobId,
              plan: truncatedPlan,
            })
          }
          w.emit('message', {
            jobId: msg.jobId,
            ok: true,
            plan: replyPlan,
            horizonStability: { prefixStable: true },
          })
        })
      }
      return w
    },
  })

  const res1 = await manager.solveOrPreempt({
    rulesPath: RULES_PATH,
    adapter,
    account: 'main',
    envelope: env,
    objectiveCfg: objCfg,
    neighborTargets: [],
    runStability: false,
    deadlineAtMs: Date.now() + 5000,
  })
  assert.equal(res1.status, 'solved')
  assert.equal(res1.plan.raidSchedule.truncatedByDeadline, true)
  assert.equal(
    manager.cache.getValid({
      adapter,
      account: 'main',
      world,
      constraintsHash: env.constraintsHash,
      objectiveHash: objCfg.objectiveHash,
      neighborSig,
    }),
    null,
    'Truncated raidSchedule plan (including checkpoint) must NOT be stored in PlanCache'
  )

  const world1 = adapter.advanceTimeOnly(world, t0 + 1)
  const env1 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: world1,
    upcomingNeighborTargets: [],
    userConstraints: { allowCapex: false, cashReserveFloor: 100 },
  })
  const res2 = await manager.solveOrPreempt({
    rulesPath: RULES_PATH,
    adapter,
    account: 'main',
    envelope: env1,
    objectiveCfg: objCfg,
    neighborTargets: [],
    runStability: false,
    deadlineAtMs: Date.now() + 5000,
  })
  assert.equal(res2.status, 'solved', 'Second tick must run a fresh solve rather than hitting cache for a truncated plan')
  assert.equal(res2.plan.raidSchedule.truncatedByDeadline, false)
  assert.equal(manager.stats.workerSolves, 2)

  const world2 = adapter.advanceTimeOnly(world1, t0 + 2)
  const env2 = buildObservationEnvelope(adapter, {
    account: 'main',
    world: world2,
    upcomingNeighborTargets: [],
    userConstraints: { allowCapex: false, cashReserveFloor: 100 },
  })
  const res3 = await manager.solveOrPreempt({
    rulesPath: RULES_PATH,
    adapter,
    account: 'main',
    envelope: env2,
    objectiveCfg: objCfg,
    neighborTargets: [],
    runStability: false,
    deadlineAtMs: Date.now() + 5000,
  })
  assert.equal(res3.status, 'cache-hit', 'Non-truncated solve must populate PlanCache normally')
})
