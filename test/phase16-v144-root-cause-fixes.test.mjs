import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { KernelHttpClient } from '../execution/http-client.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeBaseWorld(adapter, nowSec, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plots = Array(s.plotN).fill(null)
  s.barn = []
  s.traps = []
  s.tools = { hoe: 2, can: 2, rod: 2, pick: 2, axe: 2, house: 1 }
  s.en = 100
  s.enT = nowSec
  s.enDay = adapter.R.worldDay(nowSec)
  s.iq = { d: adapter.R.isleIndex(nowSec), craft: 0, mine: 100, fish: 80, bomb: 0 }
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(adapter.R.BASE_PRICE[id])
  }
  const { state: stateOverrides = {}, ...restOverrides } = overrides
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 1,
    coins: 50000,
    prices,
    ...restOverrides,
    state: { ...s, ...stateOverrides },
  }
}

test('Phase 16.1 (Module B): Tail-indexed ContentAddressedJournal stays fast on 3,000+ lines with exact parity across external appends and truncation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase16-journal-'))
  try {
    const j1 = new ContentAddressedJournal({ rootDir: tmpDir, account: 'main' })
    const w0 = makeBaseWorld(adapter, CLOCK_START + 100)
    const reqRef = j1.writeBlob({
      actions: [{ a: 'sell', id: 'turnip', q: 0, n: 2 }],
    })
    const lines = []
    for (let i = 0; i < 3200; i++) {
      lines.push(JSON.stringify({
        ts: '2026-11-13T00:00:00.000Z',
        account: 'main',
        operation: `op-wait-${i}`,
        kind: i % 50 === 0 ? 'visit' : 'act',
        status: i % 50 === 0 ? 'rejected' : 'confirmed',
        serverNow: w0.now,
        possibleIsleIndices: [adapter.R.isleIndex(w0.now)],
        requestRef: i === 1501 ? reqRef : null,
      }))
    }
    fs.writeFileSync(j1.logPath, lines.join('\n') + '\n', 'utf8')

    // Cold sync reads the 3,200 lines once
    const curIsle = adapter.R.isleIndex(w0.now)
    assert.equal(j1.reconstructTransactions().coverage.unknownCount, 0)
    assert.deepEqual(j1.sumConfirmedSalesByIsleIndex(adapter).get(curIsle), { turnip: 2 })

    // Warm query must be O(1) (< 5ms avg) even with 3,200+ lines on disk
    const tw0 = performance.now()
    for (let k = 0; k < 20; k++) {
      j1.reconstructTransactions()
      j1.sumConfirmedSalesByIsleIndex(adapter)
    }
    const warmMs = (performance.now() - tw0) / 20
    assert.ok(warmMs < 5, `Avg warm query took ${warmMs.toFixed(2)}ms (>= 5ms)`)

    // External process appends a pending submitted event & another sale -> delta sync picks it up accurately
    const reqRef2 = j1.writeBlob({ actions: [{ a: 'sell', id: 'turnip', q: 0, n: 3 }] })
    const extLines = [
      JSON.stringify({
        ts: '2026-11-13T00:01:00.000Z',
        account: 'main',
        operation: 'op-ext-sale',
        kind: 'act',
        status: 'confirmed',
        serverNow: w0.now,
        possibleIsleIndices: [curIsle],
        requestRef: reqRef2,
      }),
      JSON.stringify({
        ts: '2026-11-13T00:01:05.000Z',
        account: 'main',
        operation: 'op-ext-pending',
        kind: 'visit',
        budgetKind: 'steal',
        status: 'submitted',
        serverNow: w0.now,
        possibleIsleIndices: [curIsle],
      }),
    ]
    fs.appendFileSync(j1.logPath, extLines.join('\n') + '\n', 'utf8')
    assert.equal(j1.reconstructTransactions().coverage.unknownCount, 1)
    assert.equal(j1.countOccupiedBudget('steal', curIsle), 1)
    assert.deepEqual(j1.sumConfirmedSalesByIsleIndex(adapter).get(curIsle), { turnip: 5 })

    // Fresh instance parity check
    const jFresh = new ContentAddressedJournal({ rootDir: tmpDir, account: 'main' })
    assert.equal(jFresh.reconstructTransactions().coverage.unknownCount, 1)
    assert.equal(jFresh.countOccupiedBudget('steal', curIsle), 1)
    assert.deepEqual(jFresh.sumConfirmedSalesByIsleIndex(adapter).get(curIsle), { turnip: 5 })

    // Truncation reset check
    fs.writeFileSync(j1.logPath, '', 'utf8')
    assert.equal(j1.reconstructTransactions().coverage.unknownCount, 0)
    assert.equal(j1.countOccupiedBudget('steal', curIsle), 0)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Phase 16.2 (Module B): Continuous serverClockOffsetMs clamping, evaluator cache stability on en/rev/xs drift, physical prep lead, and zero bogus +1s retry on late 409', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase16-sched-'))
  try {
    // 1. observeServerTimestampSec continuous clamping: zero jumps on 750ms RTT when 0 is within [lo, hi]
    let fakeNowMs = 1794213000500
    const http = new KernelHttpClient({
      dryRun: true,
      nowMsFn: () => fakeNowMs,
      sleepMsFn: async (ms) => { fakeNowMs += Math.max(0, ms) },
    })
    // Req started at -750ms, server responded floor=1794213000 -> true offset 0 is in [-500, +1249]
    http.observeServerTimestampSec(1794213000, fakeNowMs - 750)
    assert.equal(http.serverClockOffsetMs, 0)
    // Next sample crosses second boundary with 15ms jitter: offset should stay 0
    fakeNowMs = 1794213001015
    http.observeServerTimestampSec(1794213001, fakeNowMs - 750)
    assert.equal(http.serverClockOffsetMs, 0)

    // 2. _makeEvaluatorCacheKey decouples `en`, `enT`, `rev`, `now`, and `xs` so passive regen doesn't invalidate precomputed raids
    const t0 = CLOCK_START + 500
    const w0 = makeBaseWorld(adapter, t0, { state: { en: 40, enT: t0 } })
    const wRegen = makeBaseWorld(adapter, t0 + 18, { rev: 7, state: { en: 45, enT: t0 + 18, xs: { active: true } } })
    const sched = new SnipeScheduler({
      accountKey: 'main',
      scheduleFilePath: path.join(tmpDir, 'sched.json'),
      selfIds: [999999],
    })
    assert.equal(
      sched._makeEvaluatorCacheKey(adapter, w0, {}),
      sched._makeEvaluatorCacheKey(adapter, wRegen, {})
    )

    // 3. computePhysicalPrepLeadSec adapts to RTT and planned prep/gear swaps
    http.lastRttMs = 750
    const leadGearOnly = sched.computePhysicalPrepLeadSec({ id: 1001, guard: true, numGearChanges: 2, plannedPrepActs: [] }, adapter, http)
    const leadNoGuard = sched.computePhysicalPrepLeadSec({ id: 1002, guard: false, numGearChanges: 0, plannedPrepActs: [] }, adapter, http)
    assert.ok(leadGearOnly > leadNoGuard + 2, `Expected gear lead ${leadGearOnly} > no-guard lead ${leadNoGuard} + 2`)

    // 4. Late 409 (`>= +250ms` past expectedUnlockAt) must NOT set bogus `earlyRetryCount = 1` or `+1s` retry
    const lateEntry = {
      id: 2002,
      name: 'LateTarget',
      level: 5,
      guard: false,
      readyEligible: true,
      upcomingEligible: true,
      expectedUnlockAt: t0 + 100,
      ownerLeft: 1,
      upcomingWaves: [{ unlockAt: t0 + 100, exactUnlockKnown: true, upcomingSpots: 1 }],
      earlyRetryCount: 0,
    }
    sched.data.targets['2002'] = lateEntry
    const lateRes = sched.recordSnipeReceipt(adapter, 2002, {
      ok: false,
      httpStatus: 409,
      status: 'rejected',
      body: { error: '保护中', now: t0 + 101 },
    }, t0 + 101, {
      visitorWorld: w0,
      sentAtServerMs: (t0 + 100) * 1000 + 400, // +400ms past boundary (>= +250ms)
    })
    assert.equal(lateRes.earlyRetryCount || 0, 0, 'Late 409 must not trigger +1s early retry')
    assert.equal(lateRes.readyEligible, false)

    // 5. Positive pre/on-boundary control (`< +250ms` past expectedUnlockAt): triggers +1s earlyRetryCount=1 once
    const earlyEntry = {
      id: 2003,
      name: 'EarlyTarget',
      level: 5,
      guard: false,
      readyEligible: true,
      upcomingEligible: true,
      expectedUnlockAt: t0 + 100,
      ownerLeft: 1,
      upcomingWaves: [{ unlockAt: t0 + 100, exactUnlockKnown: true, upcomingSpots: 1 }],
      earlyRetryCount: 0,
    }
    sched.data.targets['2003'] = earlyEntry
    const earlyRes = sched.recordSnipeReceipt(adapter, 2003, {
      ok: false,
      httpStatus: 409,
      status: 'rejected',
      body: { error: '保护中', now: t0 + 100 },
    }, t0 + 100, {
      visitorWorld: w0,
      sentAtServerMs: (t0 + 100) * 1000 + 50,
    })
    assert.equal(earlyRes.earlyRetryCount, 1, 'On-boundary 409 must trigger +1s earlyRetryCount=1')
    assert.equal(earlyRes.expectedUnlockAt, t0 + 101)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Phase 16.3 (Module A): Multi-wave upcomingWaves grouping (ownerLeft = 2), < 5ms wave advance on win, and activeRaidSchedule preservation across truncated solve', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase16-waves-'))
  try {
    const t0 = CLOCK_START + 1000
    const w0 = makeBaseWorld(adapter, t0, { state: { en: 80 }, coins: 100000 })
    const sched = new SnipeScheduler({
      accountKey: 'main',
      scheduleFilePath: path.join(tmpDir, 'sched.json'),
      selfIds: [999999],
    })
    const cropObj = adapter.R.CROPS.find((c) => !c.bad && (c.seasons || []).includes(adapter.R.seasonOf(adapter.R.isleDay(t0)))) || adapter.R.CROPS[0]
    const crop = cropObj.id
    const protectSec = 120
    const pt1 = adapter.exactPlotTimings({ c: crop, t: t0 - 60, w: 3, g: 0, h: 0 }, false, t0, CLOCK_START, { protectSec })
    const pt2 = adapter.exactPlotTimings({ c: crop, t: t0, w: 3, g: 0, h: 0 }, false, t0, CLOCK_START, { protectSec })
    assert.ok(pt1 && pt2 && pt1.matureAt > t0 && pt2.unlockAt >= pt1.unlockAt + 15)

    const visitData = {
      now: t0,
      clockStart: CLOCK_START,
      owner: { id: 3003, name: 'TwoWaveOwner', level: 8, guard: false },
      rules: { protect: protectSec, perPlot: 2, perPen: 2 },
      left: { owner: 2 },
      isle: {
        plots: [
          ...Array.from({ length: 4 }, () => ({ c: crop, stage: 1, left: pt1.matureAt - t0, steal: false, stolen: 0 })),
          ...Array.from({ length: 4 }, () => ({ c: crop, stage: 1, left: pt2.matureAt - t0, steal: false, stolen: 0 })),
          ...Array.from({ length: 16 }, () => null),
        ],
        barn: [],
      },
      state: {
        plots: [
          ...Array.from({ length: 4 }, () => ({ c: crop, t: t0 - 60, w: 3, g: 0, h: 0 })),
          ...Array.from({ length: 4 }, () => ({ c: crop, t: t0, w: 3, g: 0, h: 0 })),
          ...Array.from({ length: 16 }, () => null),
        ],
        barn: [],
        tools: { spr: 0 },
      },
    }
    const entry = sched.recordVisitSnapshot(adapter, w0, 3003, visitData)
    assert.ok(Array.isArray(entry.upcomingWaves) && entry.upcomingWaves.length === 2, `Expected 2 waves, got ${entry.upcomingWaves?.length}`)
    assert.equal(entry.expectedUnlockAt, pt1.unlockAt)
    assert.equal(entry.upcomingWaves[1].unlockAt, pt2.unlockAt)
    assert.ok(entry.upcomingWaves[1].unlockAt >= entry.upcomingWaves[0].unlockAt + 15)

    // Wave advance on `win` receipt must execute quickly and promote wave 2 without HTTP probe
    const ta0 = performance.now()
    const advanced = sched.recordSnipeReceipt(adapter, 3003, {
      ok: true,
      httpStatus: 200,
      body: { result: { outcome: 'win', coins: 2500 }, owner: visitData.owner },
    }, pt1.unlockAt + 1, {
      visitorWorld: makeBaseWorld(adapter, pt1.unlockAt + 1),
    })
    const advMs = performance.now() - ta0
    assert.ok(advMs < 15, `Wave advance took ${advMs.toFixed(2)}ms`)
    assert.equal(advanced.ownerLeft, 1)
    assert.equal(advanced.expectedUnlockAt, pt2.unlockAt)
    assert.equal(advanced.upcomingEligible, true)

    // syncCommittedRaidSchedule preserves future activeRaidSchedule when a solve truncates empty
    sched.syncCommittedRaidSchedule({
      planId: 'plan-1',
      serverNow: t0,
      raidSchedule: {
        planId: 'plan-1',
        createdAtSec: t0,
        truncatedByDeadline: false,
        committedRaids: [
          { targetId: 3003, unlockAtSec: pt2.unlockAt, energyCost: 6, plannedPrepActs: [] },
        ],
        evaluatedTargetIds: [3003],
      },
    }, w0)
    const preserved = sched.syncCommittedRaidSchedule({
      planId: 'plan-2',
      serverNow: t0 + 10,
      raidSchedule: {
        planId: 'plan-2',
        createdAtSec: t0 + 10,
        truncatedByDeadline: true,
        committedRaids: [],
        evaluatedTargetIds: [],
      },
    }, makeBaseWorld(adapter, t0 + 10))
    assert.equal(preserved.committedRaids.length, 1)
    assert.equal(preserved.needsRefresh, true)
    assert.equal(preserved.refreshReason, 'previous-solve-truncated-by-deadline')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('Phase 16.4 (Module C): Exact discrete smaller-grain ration DP, causal future farm deficit reservation, and negative wait control', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = CLOCK_START + 200
  const secLen = 43200
  const season0 = adapter.R.seasonOf(adapter.R.isleDay(t0))
  const fCrop = adapter.R.CROPS.find((c) => !c.bad && (c.seasons || []).includes(season0)) || adapter.R.CROPS[0]
  const probe = adapter.exactPlotTimings({ c: fCrop.id, t: t0, w: 3, g: 0, h: 0 }, false, t0, CLOCK_START)
  const growSpan = probe.matureAt - t0

  // (a) Immediate ripe harvest (2 plots) + smaller-grain ration (wheat +6en vs tomato +15en) at en = 0:
  //     Must immediately eat cheap wheat (NOT wait and NOT waste high-value tomato) and harvest in b0!
  const wRipe = makeBaseWorld(adapter, t0, {
    coins: 20000,
    state: {
      en: 0,
      enT: t0,
      inv: { wheat: [2, 0, 0], tomato: [0, 0, 5] },
      plots: [
        { c: fCrop.id, t: t0 - growSpan - 10, w: 3, g: 0, h: 0 },
        { c: fCrop.id, t: t0 - growSpan - 10, w: 3, g: 0, h: 0 },
        ...Array.from({ length: 22 }, () => null),
      ],
    },
  })
  const envRipe = buildObservationEnvelope(adapter, { account: 'main', world: wRipe })
  const planRipe = solveUnifiedPlan(adapter, envRipe, buildObjectiveConfig({ horizonSec: secLen, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['eat', 'harvest', 'plant', 'water', 'wait'],
  })
  const b0Ripe = planRipe.trunkBuckets[0]?.domesticActions || []
  assert.ok(
    b0Ripe.some((a) => a.a === 'eat' && a.id === 'wheat'),
    `Expected exact discrete ration DP to eat cheap wheat in b0, got ${JSON.stringify(b0Ripe)}`
  )
  assert.ok(
    b0Ripe.some((a) => a.a === 'harvest'),
    `Expected immediate harvest after eating wheat in b0, got ${JSON.stringify(b0Ripe)}`
  )

  // (b) Causal future farm deficit reservation: en = 6, 4 plots mature in +25s (needing 4 en harvest < 1 regen tick),
  //     inv = {}, coins = 0 -> must reserve stamina for +25s harvests instead of spending 4 en on fish now!
  const wReserve = makeBaseWorld(adapter, t0, {
    coins: 0,
    state: {
      en: 6,
      enT: t0,
      inv: {},
      plots: [
        { c: fCrop.id, t: t0 + 25 - growSpan, w: 3, g: 0, h: 0 },
        { c: fCrop.id, t: t0 + 25 - growSpan, w: 3, g: 0, h: 0 },
        { c: fCrop.id, t: t0 + 25 - growSpan, w: 3, g: 0, h: 0 },
        { c: fCrop.id, t: t0 + 25 - growSpan, w: 3, g: 0, h: 0 },
        ...Array.from({ length: 20 }, () => null),
      ],
    },
  })
  const envReserve = buildObservationEnvelope(adapter, { account: 'main', world: wReserve })
  const planReserve = solveUnifiedPlan(adapter, envReserve, buildObjectiveConfig({ horizonSec: 3600, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['harvest', 'fish', 'wait'],
  })
  const b0Reserve = planReserve.trunkBuckets[0]?.domesticActions || []
  assert.equal(
    b0Reserve.filter((a) => a.a === 'fish').length,
    0,
    `Causal same-isle farm deficit must reserve en=6 for +25s harvests instead of casting fish (got ${JSON.stringify(b0Reserve)})`
  )

  // (c) Negative control: en = 0, ZERO future farm tasks, only expensive tomato[q=2] -> must wait without eating
  const wNeg = makeBaseWorld(adapter, t0, {
    coins: 0,
    state: {
      en: 0,
      enT: t0,
      inv: { tomato: [0, 0, 5] },
      plots: Array.from({ length: 24 }, () => null),
    },
  })
  const envNeg = buildObservationEnvelope(adapter, { account: 'main', world: wNeg })
  const planNeg = solveUnifiedPlan(adapter, envNeg, buildObjectiveConfig({ horizonSec: 300, terminalSupplyMode: 'zero' }), {
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
    allowedActionTypes: ['eat', 'fish', 'wait'],
  })
  const b0Neg = planNeg.trunkBuckets[0]?.domesticActions || []
  assert.equal(b0Neg.filter((a) => a.a === 'eat').length, 0, `Negative control must not eat expensive tomato for low-value fish, got ${JSON.stringify(b0Neg)}`)
})

test('Phase 16.5 (Module A): Joint 6-target multi-wave raid timeline solve completes in < 6000ms without deadline truncation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = CLOCK_START + 1200
  const w0 = makeBaseWorld(adapter, t0, { coins: 200000, state: { en: 100, cnt: { coffee: 0 }, inv: { fgt: [3, 0, 0] } } })
  const season0 = adapter.R.seasonOf(adapter.R.isleDay(t0))
  const highCrop = adapter.R.CROPS
    .filter((c) => !c.bad && (c.seasons || []).includes(season0))
    .sort((a, b) => Number(adapter.R.BASE_PRICE[b.id] || 0) - Number(adapter.R.BASE_PRICE[a.id] || 0))[0]?.id || 'tomato'

  const upcomingNeighborTargets = []
  for (let idx = 0; idx < 6; idx++) {
    const id = 5001 + idx
    const w1 = t0 + 90 + idx * 140
    const w2 = w1 + 40
    for (const unlockAtSec of [w1, w2]) {
      upcomingNeighborTargets.push({
        id,
        targetId: id,
        unlockAtSec,
        exactUnlockKnown: true,
        ownerLeft: 2,
        waveBundle: {
          id,
          owner: { id, name: `Neighbor-${idx}`, level: 8, guard: false },
          isle: {
            plots: Array.from({ length: 4 }, () => ({ c: highCrop, stage: 3, steal: true, stolen: 0 })),
            barn: [],
          },
        },
      })
    }
  }
  const env = buildObservationEnvelope(adapter, {
    world: w0,
    account: 'main',
    upcomingNeighborTargets,
  })
  const ts0 = performance.now()
  const plan = solveUnifiedPlan(adapter, env, buildObjectiveConfig({ horizonSec: 3600, terminalSupplyMode: 'zero' }), {
    maxSolveMs: 12000,
  })
  const elapsedMs = performance.now() - ts0
  assert.ok(elapsedMs < 6000, `Joint 6-target multi-wave solve took ${elapsedMs.toFixed(0)}ms (>= 6000ms)`)
  assert.equal(plan.quality?.pruning?.deadlineReached, false, 'Must not truncate by deadline')
  assert.ok((plan.committedUpcomingRaids?.length || 0) >= 2, `Expected >= 2 committed upcoming raids, got ${plan.committedUpcomingRaids?.length}`)
})
