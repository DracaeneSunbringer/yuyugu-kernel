import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope, normalizeUserConstraints } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { createUnifiedRaidEvaluator, solveUnifiedPlan } from '../planner/solve.mjs'
import { compileExecutablePrefix } from '../planner/compile-prefix.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { buildAuditDecisionReport } from '../audit/report.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld } from '../execution/reconcile.mjs'
import { KernelHttpClient, normalizeCookieHeaderString, parseSessionCookieHeader } from '../execution/http-client.mjs'
import {
  executeWithTacticalLoadout,
  loadProfileStore,
  readAccountGearState,
  recordBattleSnapshot,
  syncHomeHistoryProfiles,
} from '../execution/combat-engine.mjs'
import {
  huancaiCycleStartSec,
  planHuancaiFloor,
  runSingleArenaBout,
} from '../execution/pet-and-battle.mjs'
import { SnipeScheduler } from '../execution/snipe-scheduler.mjs'
import { runLiveAccountTick } from '../cli/live-daemon.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const RULES_PATH = path.join(ROOT_DIR, 'rules/pet-world-rules.js')
const FIXTURE_PATH = path.join(ROOT_DIR, 'fixtures/sample-snapshot.json')

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8').replace(/^\uFEFF/, ''))
const baseWorld = fixture.mainBundle?.main || fixture.domestic

function makeTempDir(prefix = 'kernel-p7-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeSyntheticGearCatalog(level = 12, free = 0, points = { str: 20, vit: 4, agi: 0, spd: 4 }) {
  return {
    level,
    free,
    points: { ...points },
    gear: {
      weapon: { id: 'test_blade_rest', enh: 2 },
      armor: { id: 'test_plate_rest', enh: 2 },
      charm: { id: 'test_charm_revive', enh: 2 },
    },
    items: [
      { id: 'test_blade_rest', enh: 2 },
      { id: 'test_spear_fast', enh: 2 },
      { id: 'test_plate_rest', enh: 2 },
      { id: 'test_charm_revive', enh: 2 },
      { id: 'test_charm_first', enh: 2 },
    ],
    catalog: [
      { id: 'test_blade_rest', name: 'RestBlade', slot: 'weapon', rarity: 4, skill: true, stats: { atk: 34, hp: 45, spd: 0, agi: 5, def: 10 } },
      { id: 'test_spear_fast', name: 'FastSpear', slot: 'weapon', rarity: 3, skill: false, stats: { atk: 18, hp: 0, spd: 20, agi: 8, def: 0 } },
      { id: 'test_plate_rest', name: 'RestPlate', slot: 'armor', rarity: 4, stats: { def: 35, hp: 60, atk: 0, spd: 0, agi: 0 } },
      { id: 'test_charm_revive', name: 'ReviveCharm', slot: 'charm', rarity: 4, stats: { hp: 55, def: 20 }, passive: { kind: 'revive', value: 0.30 } },
      { id: 'test_charm_first', name: 'FirstCharm', slot: 'charm', rarity: 3, stats: { atk: 20, spd: 12 }, passive: { kind: 'first', value: 1 } },
    ],
    breakdown: {
      hp: { base: 80 + level * 14, total: 80 + level * 14 + (points.vit || 0) * 6 + 35 },
      atk: { base: 10 + level * 2.5, total: Math.round(10 + level * 2.5 + (points.str || 0) * 1.1 + 10) },
      def: { base: 0, total: 15 },
      agi: { base: 10 + level * 1.3, total: Math.round(10 + level * 1.3 + (points.agi || 0) * 1.2 + 2) },
      spd: { base: 10 + level * 1.0, total: Math.round(10 + level * 1.0 + (points.spd || 0) * 1.1) },
    },
  }
}

test('Phase 7.1: KernelHttpClient strictly forbids network/5xx retries on non-idempotent POSTs while retrying operation-UUID POSTs safely', async () => {
  const calls = []
  let nowMs = 1_794_360_000_000
  const client = new KernelHttpClient({
    cookieHeader: 'sid=test',
    maxIdempotentRetries: 2,
    nowMsFn: () => nowMs,
    sleepMsFn: async (ms) => { nowMs += ms },
    fetchImpl: async (url, init) => {
      const p = new URL(url).pathname
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({ path: p, method: init.method, operation: body?.operation || null })
      if (p.startsWith('/api/pet/world/visit/')) {
        throw new Error('socket hang up after server commit')
      }
      if (p === '/api/pet/world/act') {
        const prevActCalls = calls.filter((c) => c.path === '/api/pet/world/act').length
        if (prevActCalls < 2) {
          return {
            status: 503,
            headers: new Map(),
            text: async () => JSON.stringify({ error: 'upstream unavailable' }),
          }
        }
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ ok: true, rev: 101, now: 1794360005 }),
        }
      }
      throw new Error(`unexpected ${p}`)
    },
  })

  // 1) Non-idempotent `POST /api/pet/world/visit/:id` MUST send exactly ONCE (`attempts === 1`)!
  const visitRes = await client.postJson('/api/pet/world/visit/9002', { operation: 'op-visit-1', kind: 'all', i: 0 })
  assert.equal(visitRes.ok, false)
  assert.equal(visitRes.networkError, true)
  assert.equal(visitRes.idempotent, false)
  assert.equal(visitRes.attempts, 1)
  assert.equal(calls.filter((c) => c.path === '/api/pet/world/visit/9002').length, 1)

  // 2) Server-deduplicated `POST /api/pet/world/act` with `operation` UUID retries safely with the SAME `operation`!
  const actRes = await client.postJson('/api/pet/world/act', { rev: 100, operation: 'op-act-uuid-1', actions: [] })
  assert.equal(actRes.ok, true)
  assert.equal(actRes.idempotent, true)
  assert.equal(actRes.attempts, 2)
  const actCalls = calls.filter((c) => c.path === '/api/pet/world/act')
  assert.equal(actCalls.length, 2)
  assert.equal(actCalls[0].operation, 'op-act-uuid-1')
  assert.equal(actCalls[1].operation, 'op-act-uuid-1')

  // 3) Calibrated server clock sleep wakes at `targetSec * 1000 + offsetMs`
  assert.equal(client.hasCalibratedClock, true)
  const slept = await client.sleepUntilServerSec(1794360010, 35)
  assert.ok(slept > 0)
  assert.ok(client.estimatedServerNowMs() >= 1794360010 * 1000 + 35)

  // 4) Dry-run write firewall blocks any non-GET call
  const dryClient = new KernelHttpClient({ cookieHeader: 'sid=test', dryRun: true })
  await assert.rejects(
    () => dryClient.postJson('/api/pet/world/visit/9002', { kind: 'all', i: 0 }),
    /DRY_RUN_WRITE_FIREWALL/
  )

  // 5) Session cookie parser normalizes common user copy-paste formats & rejects unreplaced placeholders
  assert.equal(normalizeCookieHeaderString('abc123token'), 'sid=abc123token')
  assert.equal(normalizeCookieHeaderString('Sid=abc123token'), 'sid=abc123token')
  assert.equal(normalizeCookieHeaderString('Cookie: sid=abc123token; cf_clearance=xyz'), 'sid=abc123token; cf_clearance=xyz')
  assert.equal(normalizeCookieHeaderString('session=abc123token'), 'sid=abc123token')
  assert.throws(() => normalizeCookieHeaderString('sid=YOUR_SID_COOKIE_VALUE'), /Unreplaced placeholder cookie/)
  assert.throws(() => normalizeCookieHeaderString('session=YOUR_SESSION_COOKIE_VALUE'), /Unreplaced placeholder cookie/)

  const sessTmp = makeTempDir('p7-sess-')
  const bareSessFile = path.join(sessTmp, '.session.json')
  fs.writeFileSync(bareSessFile, JSON.stringify({ cookie: 'raw_sid_val_99' }), 'utf8')
  assert.equal(parseSessionCookieHeader(bareSessFile), 'sid=raw_sid_val_99')
})

test('Phase 7.2: Deterministic same-day visit:unknown reconciliation via cnt["st"+id] + rev guard & cross-midnight safety', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tmp = makeTempDir('p7-reconcile-')
  const lockDir = path.join(tmp, 'locks')

  // Case A: Network timeout on `visit`, then freshWorld shows `cnt.st9002` incremented & coins fined `-5000`
  const jA = new ContentAddressedJournal({ rootDir: path.join(tmp, 'jA'), account: 'main' })
  const w0 = adapter.cloneWorld(baseWorld)
  w0.now = 1794360000
  w0.rev = 500
  w0.coins = 100000
  w0.state.day = adapter.R.worldDay(w0.now)
  w0.state.cnt = { ...(w0.state.cnt || {}), steal: 3, st9002: 0 }

  const txTimeout = await executeTransaction({
    journal: jA,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    operation: 'op-visit-timeout-lose',
    kind: 'visit',
    budgetKind: 'steal',
    budgetLimitPerIsleDay: 5,
    worldBefore: w0,
    requestPayload: { targetId: 9002, expectedSpots: 8, expectedEnergyCost: 12 },
    sendFn: async () => { throw new Error('ETIMEDOUT') },
  })
  assert.equal(txTimeout.status, 'unknown')
  assert.equal(jA.countOccupiedBudget('steal', adapter.R.isleIndex(w0.now)), 1)

  const wAfterLose = adapter.cloneWorld(w0)
  wAfterLose.now = w0.now + 6
  wAfterLose.rev = 501
  wAfterLose.coins = 95000
  wAfterLose.state.cnt.steal = 4
  wAfterLose.state.cnt.st9002 = 1

  const callbacksA = []
  const recA = reconcileUnknownWithFreshWorld(jA, adapter, wAfterLose, {
    onReconciledVisitFn: (info) => callbacksA.push(info),
  })
  assert.equal(recA.reconciled, 1)
  assert.equal(recA.remainingUnknown, 0)
  assert.equal(callbacksA.length, 1)
  assert.equal(callbacksA[0].status, 'confirmed')
  assert.equal(callbacksA[0].inferredVisitOutcome, 'lose')
  assert.equal(jA.reconstructTransactions().txMap.get('op-visit-timeout-lose').status, 'confirmed')

  // Case B: Network timeout before reaching server -> `cnt.st9002` unchanged AND `rev` unchanged after 26s -> `rejected`, freeing budget!
  const jB = new ContentAddressedJournal({ rootDir: path.join(tmp, 'jB'), account: 'main' })
  await executeTransaction({
    journal: jB,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    operation: 'op-visit-never-arrived',
    kind: 'visit',
    budgetKind: 'steal',
    budgetLimitPerIsleDay: 1,
    worldBefore: w0,
    requestPayload: { targetId: 9002, expectedSpots: 4, expectedEnergyCost: 8 },
    sendFn: async () => ({ ok: false, status: null, networkError: true }),
  })
  assert.equal(jB.countOccupiedBudget('steal', adapter.R.isleIndex(w0.now)), 1)

  // Before silence window (10s < 25s): stays `unknown`
  const wTooEarly = adapter.cloneWorld(w0)
  wTooEarly.now = w0.now + 10
  const recEarly = reconcileUnknownWithFreshWorld(jB, adapter, wTooEarly, { visitSilenceWindowSec: 25 })
  assert.equal(recEarly.remainingUnknown, 1)

  // After silence window (26s >= 25s) with `rev === revBefore` and `st9002 === 0`: deterministically `rejected` & frees budget!
  const wSilent = adapter.cloneWorld(w0)
  wSilent.now = w0.now + 26
  const recB = reconcileUnknownWithFreshWorld(jB, adapter, wSilent, { visitSilenceWindowSec: 25 })
  assert.equal(recB.reconciled, 1)
  assert.equal(recB.remainingUnknown, 0)
  assert.equal(jB.reconstructTransactions().txMap.get('op-visit-never-arrived').status, 'rejected')
  assert.equal(jB.countOccupiedBudget('steal', adapter.R.isleIndex(w0.now)), 0)

  // Case C: `cnt.st9002` unchanged after 26s BUT `rev` advanced -> safe `unknown-state-reanchored` (never falsely rejects!)
  const jC = new ContentAddressedJournal({ rootDir: path.join(tmp, 'jC'), account: 'main' })
  await executeTransaction({
    journal: jC,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    operation: 'op-visit-draw-or-concurrent',
    kind: 'visit',
    budgetKind: 'steal',
    budgetLimitPerIsleDay: 2,
    worldBefore: w0,
    requestPayload: { targetId: 9002, expectedSpots: 4, expectedEnergyCost: 8 },
    sendFn: async () => ({ ok: false, status: null, networkError: true }),
  })
  const wRevMoved = adapter.cloneWorld(w0)
  wRevMoved.now = w0.now + 30
  wRevMoved.rev = w0.rev + 1
  const recC = reconcileUnknownWithFreshWorld(jC, adapter, wRevMoved, { visitSilenceWindowSec: 25 })
  assert.equal(recC.reconciled, 1)
  assert.equal(jC.reconstructTransactions().txMap.get('op-visit-draw-or-concurrent').status, 'unknown-state-reanchored')

  // Case D: Cross-midnight (`state.day` reset) -> safe `unknown-state-reanchored`
  const jD = new ContentAddressedJournal({ rootDir: path.join(tmp, 'jD'), account: 'main' })
  await executeTransaction({
    journal: jD,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    operation: 'op-visit-midnight',
    kind: 'visit',
    budgetKind: 'steal',
    budgetLimitPerIsleDay: 2,
    worldBefore: w0,
    requestPayload: { targetId: 9002, expectedSpots: 4, expectedEnergyCost: 8 },
    sendFn: async () => ({ ok: false, status: null, networkError: true }),
  })
  const wNextDay = adapter.cloneWorld(w0)
  wNextDay.now = adapter.nextNaturalDayBoundary(w0.now) + 10
  wNextDay.state.day = adapter.R.worldDay(wNextDay.now)
  wNextDay.state.cnt = {}
  const recD = reconcileUnknownWithFreshWorld(jD, adapter, wNextDay)
  assert.equal(recD.reconciled, 1)
  assert.equal(jD.reconstructTransactions().txMap.get('op-visit-midnight').status, 'unknown-state-reanchored')
})

test('Phase 7.3: Receipt-first ordering persists HTTP receipt BEFORE onReceiptFn/fetchAfterWorldFn & replaces dogmatic 2-loss ban with unified EV re-evaluation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tmp = makeTempDir('p7-receipt-first-')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })
  const profilePath = path.join(tmp, 'opponent-profiles.json')
  const schedPath = path.join(tmp, 'snipe-schedule.json')
  const scheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: schedPath,
    profileStorePath: profilePath,
    gearLockRoot: path.join(tmp, 'locks'),
  })

  const w0 = adapter.advanceTimeOnly(baseWorld, 1794361000)

  // 0) Even if BOTH `onReceiptFn` and `fetchAfterWorldFn` throw, raw HTTP receipt is ALREADY durable in journal!
  let sawResponseRefInsideCallback = false
  const durableTx = await executeTransaction({
    journal,
    adapter,
    lockRootDir: path.join(tmp, 'locks'),
    account: 'main',
    operation: 'op-receipt-durable-before-callback',
    kind: 'visit',
    budgetKind: 'steal',
    budgetLimitPerIsleDay: 10,
    worldBefore: w0,
    requestPayload: { targetId: 88800, expectedSpots: 2, expectedEnergyCost: 6 },
    sendFn: async () => ({
      ok: true,
      status: 200,
      networkError: false,
      body: { result: { outcome: 'win', spots: 2, n: 4 } },
    }),
    onReceiptFn: () => {
      const txDuringCb = journal.reconstructTransactions().txMap.get('op-receipt-durable-before-callback')
      sawResponseRefInsideCallback = Boolean(txDuringCb?.status === 'confirmed' && txDuringCb?.responseRef)
      throw new Error('simulated callback crash after receipt')
    },
    fetchAfterWorldFn: async () => {
      throw new Error('post-receipt fetchWorld network timeout!')
    },
  })
  assert.equal(durableTx.status, 'confirmed')
  assert.equal(sawResponseRefInsideCallback, true, 'responseRef + confirmed status MUST already be in journal BEFORE onReceiptFn runs!')

  for (let i = 1; i <= 2; i++) {
    const txOut = await executeTransaction({
      journal,
      adapter,
      lockRootDir: path.join(tmp, 'locks'),
      account: 'main',
      operation: `op-lose-receipt-${i}`,
      kind: 'visit',
      budgetKind: 'steal',
      budgetLimitPerIsleDay: 10,
      worldBefore: w0,
      requestPayload: { targetId: 88801, expectedSpots: 6, expectedEnergyCost: 10 },
      sendFn: async () => ({
        ok: true,
        status: 200,
        networkError: false,
        body: {
          result: { outcome: 'lose', fine: 5000, spots: 6 },
          battle: {
            battle: {
              id: 9000 + i,
              created_at: w0.now + i,
              winner: 1,
              fighters: [
                { id: 100001, name: 'me', level: 13, hp: 310, atk: 52, def: 15, agi: 26, spd: 23 },
                { id: 88801, name: 'TitanGuard', level: 15, hp: 520, atk: 78, def: 30, agi: 35, spd: 32, gear: { weapon: { id: 'w1' } } },
              ],
            },
          },
        },
      }),
      onReceiptFn: ({ rawResp }) => {
        scheduler.recordSnipeReceipt(adapter, 88801, rawResp, w0.now + i, { visitorWorld: w0 })
      },
      fetchAfterWorldFn: async () => {
        throw new Error('post-receipt fetchWorld network timeout!')
      },
    })
    // Even though `fetchAfterWorldFn` threw, the HTTP 200 receipt is NEVER lost or demoted to `unknown`!
    assert.equal(txOut.status, 'confirmed')
  }

  // Guard snapshot from wrapped `{ battle: { fighters } }` MUST be persisted in `opponent-profiles.json`
  const store = loadProfileStore(profilePath)
  assert.equal(store.profiles['88801']?.guard?.hp, 520)
  assert.equal(store.profiles['88801']?.guard?.level, 15)

  // Pure RNG independence: 2 consecutive losses MUST NOT trigger a dogmatic 20-minute `two-loss-circuit-breaker`!
  const targetEntry = scheduler.data.targets['88801']
  assert.equal(targetEntry.lossCount, 2)
  assert.notEqual(targetEntry.blockedReason, 'two-loss-circuit-breaker')
  assert.equal(scheduler.isTargetBlocked(targetEntry, w0.now + 60), false)

  // Instead, re-evaluating `88801` with `TitanGuard` (`hp: 520, atk: 78`) on a modest crop rejects by negative unified EV,
  // whereas an island with a weak guard (`hp: 45, atk: 10`) stays `readyEligible === true` even after `lossCount === 2`!
  const cheapCropId = adapter.R.CROPS[0].id
  const richCropId = [...adapter.R.CROPS].sort((a, b) => b.price - a.price)[0].id
  const gearMock = makeSyntheticGearCatalog(13, 0)
  const wNoStealth = adapter.cloneWorld(w0)
  wNoStealth.coins = 50
  wNoStealth.state.en = 6
  wNoStealth.state.inv = {}
  wNoStealth.state.plots = []
  wNoStealth.state.barn = []
  wNoStealth.state.iq = { d: adapter.R.isleIndex(wNoStealth.now), mine: 0, craft: 0 }
  wNoStealth.state.b12 = {}
  const titanEvalEntry = scheduler.recordVisitSnapshot(adapter, wNoStealth, 88801, {
    now: wNoStealth.now + 10,
    owner: { id: 88801, name: 'TitanGuard', level: 15, guard: true, newbie: false },
    isle: { plots: [{ c: cheapCropId, stage: 3, steal: true, stolen: 0 }], barn: [] },
  }, { gearData: gearMock, allowThiefBuffPurchase: false })
  assert.equal(titanEvalEntry.readyEligible, false, 'TitanGuard panel rejects unprofitable raid via unified EV, not hardcoded ban')

  recordBattleSnapshot({
    id: 9010,
    created_at: w0.now + 10,
    winner: 0,
    fighters: [
      { id: 100001, name: 'me', level: 13, hp: 310, atk: 52, def: 15, agi: 26, spd: 23 },
      { id: 88802, name: 'WeakGuardUnluckyRng', level: 6, hp: 45, atk: 10, def: 2, agi: 5, spd: 5, gear: { weapon: { id: 'w0' } } },
    ],
  }, 'guard', { storePath: profilePath })
  scheduler.data.targets['88802'] = { id: 88802, name: 'WeakGuardUnluckyRng', level: 6, guard: true, lossCount: 2 }
  const weakAfterTwoLosses = scheduler.recordVisitSnapshot(adapter, w0, 88802, {
    now: w0.now + 15,
    owner: { id: 88802, name: 'WeakGuardUnluckyRng', level: 6, guard: true, newbie: false },
    isle: { plots: Array.from({ length: 4 }, () => ({ c: richCropId, stage: 3, steal: true, stolen: 0 })), barn: [] },
  }, { gearData: gearMock })
  assert.equal(weakAfterTwoLosses.lossCount, 2)
  assert.equal(weakAfterTwoLosses.readyEligible, true, 'High-win-rate target remains eligible after 2 unlucky RNG losses!')
})

test('Phase 7.4: Exact 1800s protection timing, <=50s background preemption, pre-unlock staging & finally gear restore', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tmp = makeTempDir('p7-staged-snipe-')
  const lockDir = path.join(tmp, 'locks')
  const profilePath = path.join(tmp, 'opponent-profiles.json')
  const schedPath = path.join(tmp, 'snipe-schedule.json')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })

  // Pick highest base-price crop dynamically from rules table (zero hardcoded catalog names!)
  const sortedCrops = [...adapter.R.CROPS].sort((a, b) => b.price - a.price)
  const targetCrop = sortedCrops[0]

  // Construct an opponent profile where `test_charm_first` 1-hit KOs a fast glass-cannon guard that otherwise kills resting gear!
  recordBattleSnapshot({
    id: 501,
    created_at: 1794362000,
    winner: 0,
    fighters: [
      { id: 100001, name: 'me', level: 13, hp: 300, atk: 50, def: 15, agi: 25, spd: 20 },
      { id: 9002, name: 'TargetIsle', level: 11, hp: 48, atk: 420, def: 0, agi: 0, spd: 60, gear: { weapon: { id: 'x' } } },
    ],
  }, 'guard', { storePath: profilePath })

  const scheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: schedPath,
    profileStorePath: profilePath,
    gearLockRoot: lockDir,
  })

  // Create a ripe-in-protection 6-plot island that matured at `matureAt = T_now - 1792` -> exact `unlockAt = matureAt + 1800 = T_now + 8`!
  const T_now = 1794362100
  const iDay = adapter.R.isleDay(T_now)
  const isRain = adapter.R.weatherOf(iDay) === 1
  const fast = T_now >= adapter.R.ISLE_LAUNCH
  const baseGrowSec = targetCrop.grow * 60 * (fast ? 0.8 : 1) * (isRain ? 0.6 : 1)
  const desiredMatureAt = T_now - 1792
  const plantedAt = Math.floor(desiredMatureAt - baseGrowSec)

  const visitSnapshot = {
    now: T_now,
    clockStart: baseWorld.clockStart,
    owner: { id: 9002, name: 'TargetIsle', level: 11, guard: true, newbie: false },
    rules: { protect: 1800, perPlot: 2, perPen: 2, perOwner: 999 },
    left: { today: 999, owner: 999 },
    isle: {
      plots: Array.from({ length: 6 }, () => ({
        c: targetCrop.id,
        stage: 3,
        left: 0,
        steal: false,
        stolen: 0,
      })),
      barn: [],
    },
    state: {
      tools: { spr: 0 },
      plots: Array.from({ length: 6 }, () => ({
        c: targetCrop.id,
        t: plantedAt,
        w: isRain ? 3 : 0,
        g: 0,
        h: 0,
      })),
      barn: [],
    },
  }

  const wVisitor = adapter.advanceTimeOnly(baseWorld, T_now)
  wVisitor.coins = 500000
  wVisitor.state.en = 4 // Intentionally low (with synced `enT = T_now`) so staged prep MUST replenish stamina + buy `sack` BEFORE unlock!
  wVisitor.state.b12 = { ...(wVisitor.state.b12 || {}), effects: {} }

  const gearMock = makeSyntheticGearCatalog(13, 0)
  const entry = scheduler.recordVisitSnapshot(adapter, wVisitor, 9002, visitSnapshot, { gearData: gearMock })
  assert.equal(entry.upcomingEligible, true)
  assert.equal(entry.exactUnlockKnown, true)
  assert.equal(entry.upcomingSpots, 6)
  // Verify exact 1800s protection rule (around `T_now + 8`, NEVER premature `900s`!)
  assert.ok(entry.expectedUnlockAt >= T_now + 7 && entry.expectedUnlockAt <= T_now + 9)

  // 1) Priority Preemption: within `<= 50s` of exact unlock, background discovery MUST abort with 0 HTTP requests!
  assert.equal(scheduler.shouldBlockBackgroundWork(T_now, 50), true)
  let bgHttpCalls = 0
  const bgClient = new KernelHttpClient({
    cookieHeader: 'sid=test',
    nowMsFn: () => T_now * 1000,
    fetchImpl: async () => { bgHttpCalls++; throw new Error('must not be called') },
  })
  const discOut = await scheduler.runIncrementalDiscoverySlice(adapter, bgClient, wVisitor)
  assert.equal(discOut.status, 'preempted-by-snipe')
  assert.equal(bgHttpCalls, 0)

  // 2) Pre-Unlock Staged Execution: trace exact chronological ordering of HTTP calls & server clock timestamps!
  let simClockMs = T_now * 1000 + 500
  let curWorld = adapter.cloneWorld(wVisitor)
  let curGear = structuredClone(gearMock)
  const eventTimeline = []

  const stagedClient = new KernelHttpClient({
    cookieHeader: 'sid=test',
    nowMsFn: () => simClockMs,
    sleepMsFn: async (ms) => { simClockMs += ms },
    fetchImpl: async (url, init) => {
      const p = new URL(url).pathname
      const body = init.body ? JSON.parse(init.body) : null
      eventTimeline.push({ atMs: simClockMs, method: init.method, path: p, body })

      if (init.method === 'GET' && p === '/api/pet/world') {
        curWorld.now = Math.floor(simClockMs / 1000)
        return { status: 200, headers: new Map(), text: async () => JSON.stringify(curWorld) }
      }
      if (init.method === 'POST' && p === '/api/pet/world/act') {
        const sim = adapter.simulateBatch(curWorld, body.actions, { t: Math.floor(simClockMs / 1000), prices: curWorld.prices })
        assert.equal(sim.allOk, true, 'staged prep batch must be 100% valid in rules engine')
        curWorld = sim.afterWorld
        curWorld.rev = Number(curWorld.rev || 0) + 1
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true, rev: curWorld.rev, state: curWorld.state, coins: curWorld.coins, now: curWorld.now }) }
      }
      if (init.method === 'GET' && p === '/api/pet/battle/gear') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify(curGear) }
      }
      if (init.method === 'POST' && p === '/api/pet/battle/equip') {
        curGear.gear[body.slot] = { id: body.item, enh: 2 }
        return { status: 200, headers: new Map(), text: async () => JSON.stringify(curGear) }
      }
      if (init.method === 'POST' && p === '/api/pet/world/visit/9002') {
        curWorld.rev = Number(curWorld.rev || 0) + 1
        curWorld.state.en = Math.max(0, curWorld.state.en - 10)
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            ok: true,
            result: { outcome: 'win', spots: 6, n: 12, items: [[targetCrop.id, 12]] },
          }),
        }
      }
      throw new Error(`Unexpected call: ${init.method} ${p}`)
    },
  })
  stagedClient.observeServerTimestampSec(T_now)

  const snipeRes = await scheduler.executeStagedSnipe({
    adapter,
    httpClient: stagedClient,
    journal,
    lockRootDir: lockDir,
    fetchWorldFn: () => stagedClient.getJson('/api/pet/world'),
    userConstraints: { allowThiefBuffPurchase: true, cashReserveFloor: 10 },
    stageWindowSec: 15,
    postUnlockOffsetMs: 25,
  })

  assert.equal(snipeRes.status, 'confirmed')
  assert.equal(snipeRes.restoreOk, true)
  assert.ok(snipeRes.prepActionsSent >= 2, 'must buy sack and replenish stamina during physical cooldown staging')

  const actCall = eventTimeline.find((e) => e.method === 'POST' && e.path === '/api/pet/world/act')
  assert.equal(
    actCall.body.actions.some((a) => a.a === 'buy' && a.id === 'cloak'),
    false,
    'Against a 100%-win guard (FirstCharm 1-hit KO), unified 4-outcome model skips cloak so guard-win drops 3x/spot instead of 2x/spot!'
  )
  const visitPostCall = eventTimeline.find((e) => e.method === 'POST' && e.path === '/api/pet/world/visit/9002')
  const preVisitEquips = eventTimeline.filter((e) => e.method === 'POST' && e.path === '/api/pet/battle/equip' && e.atMs < visitPostCall.atMs)
  const postVisitEquips = eventTimeline.filter((e) => e.method === 'POST' && e.path === '/api/pet/battle/equip' && e.atMs > visitPostCall.atMs)
  const anyVisitGet = eventTimeline.filter((e) => e.method === 'GET' && e.path === '/api/pet/world/visit/9002')

  // Verify strict causal ordering & sub-100ms (<1s) post-unlock wire latency:
  // `POST /world/act` (prep) < `POST /battle/equip` (tactical swap) < `reserved-and-durable` < `unlockAt * 1000` <= `POST /world/visit/9002` < `POST /battle/equip` (restore resting gear)!
  assert.ok(actCall, 'prep batch must execute before unlock')
  assert.ok(actCall.atMs < entry.expectedUnlockAt * 1000, 'thief buff + stamina prep must finish BEFORE unlockAt')
  assert.ok(preVisitEquips.length >= 1, 'tactical loadout must pre-equip BEFORE unlockAt')
  assert.ok(preVisitEquips.every((e) => e.atMs < entry.expectedUnlockAt * 1000), 'all tactical equips must finish BEFORE unlockAt')
  assert.equal(anyVisitGet.length, 0, 'ZERO extra GET /visit/:id round-trips when exactUnlockKnown is true!')
  assert.ok(
    visitPostCall.atMs >= entry.expectedUnlockAt * 1000 + 25 &&
    visitPostCall.atMs <= entry.expectedUnlockAt * 1000 + 100,
    `POST /visit/:id must fire within [25ms, 100ms] after T_unlock (<1s requirement; got offset +${visitPostCall.atMs - entry.expectedUnlockAt * 1000}ms)`
  )
  assert.equal(postVisitEquips.length, preVisitEquips.length, 'resting defense gear must be restored in finally')
  const finalGearSt = readAccountGearState('main', lockDir)
  assert.equal(finalGearSt.dirty, false)
  assert.equal(curGear.gear.weapon.id, 'test_blade_rest')
  assert.equal(curGear.gear.charm.id, 'test_charm_revive')
})

test('Phase 7.5: Imminent snipe stamina reservation prevents domestic mining starvation with ZERO Layer-3 audit regret', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tmp = makeTempDir('p7-stam-reserve-')
  const scheduler = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'sched.json'),
  })

  const w = adapter.cloneWorld(baseWorld)
  w.now = 1794363000
  w.state.en = 9
  w.state.inv = {} // Empty rations so current stamina `9` is scarce!
  w.coins = 50 // Below coffee/stockBuy so solver cannot buy extra stamina

  // Inject an imminent high-EV snipe unlocking in `120s` (< 180s regen tick, requiring `8` stamina)
  scheduler.data.targets['55501'] = {
    id: 55501,
    name: 'CornWhale',
    level: 8,
    guard: false,
    upcomingEligible: true,
    exactUnlockKnown: true,
    upcomingSpots: 4,
    expectedUnlockAt: w.now + 120,
    projectedScore: 42000,
    projectedEnergyCost: 8,
    blockedUntil: 0,
    cooldownUntil: 0,
  }

  const resv = scheduler.computeImminentSnipeStaminaReservation(adapter, w, w.now)
  assert.equal(resv.staminaReserveFloor, 8)
  assert.equal(resv.staminaReserveUntilSec, w.now + 120)

  const env = buildObservationEnvelope(adapter, {
    account: 'main',
    world: w,
    userConstraints: {
      staminaReserveFloor: resv.staminaReserveFloor,
      staminaReserveUntilSec: resv.staminaReserveUntilSec,
    },
  })
  const objCfg = buildObjectiveConfig({ horizonSec: 3600 })
  const plan = solveUnifiedPlan(adapter, env, objCfg, {
    allowedActionTypes: ['mine', 'sell', 'craft', 'wait'],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
  })
  const b0Acts = plan.trunkBuckets[0]?.domesticActions || []
  const mineActs = b0Acts.filter((a) => a.a === 'mine')
  // With `en = 9` and `staminaReserveFloor = 8`, `mine` (`cost = 3`) would drop `en` to `6 < 8`, so `0` mines are allowed!
  assert.equal(mineActs.length, 0)

  // Verify `audit/report.mjs` (`reference-solver.mjs`) honors the identical `staminaReserveFloor` with `0` regret!
  const auditRep = await buildAuditDecisionReport({
    adapter,
    worldBefore: env.observed.world,
    actualFirstActions: [],
    scenarios: [{ id: 'baseline', weight: 1.0, externalSupplyFactor: 0.96 }],
    objectiveCfg: objCfg,
    constraints: env.constraints,
    allowedActionTypes: ['sell', 'craft', 'wait'],
    maxSteps: 2,
    maxSearchNodes: 200,
  })
  assert.equal(auditRep.identifiableDecisionRegretLowerBound, 0)
})

test('Phase 7.6: Pure unified-model EV steal gating (profitable 1-spot target IS stolen; negative-EV 1-spot target is rejected) & domestic-only 0-steal isolation', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const mainC = normalizeUserConstraints({}, 'main')
  const secondaryC = normalizeUserConstraints({}, 'secondary')
  assert.equal(mainC.minStealSpots, 0, 'main must NOT have any hardcoded >=2 spot threshold by default')
  assert.equal(secondaryC.maxStealsPerIsleDay, 0)
  assert.equal(secondaryC.allowThiefBuffPurchase, false)

  const highValCropId = adapter.R.CROPS[adapter.R.CROPS.length - 1].id
  const lowValCropId = adapter.R.CROPS[0].id

  const profitableOneSpot = {
    id: 77701,
    owner: { id: 77701, name: 'ProfitableOneSpot', level: 5, guard: false, newbie: false },
    isle: {
      plots: [{ c: highValCropId, stage: 3, steal: true, stolen: 0 }],
      barn: [],
    },
  }
  const losingOneSpot = {
    id: 77702,
    owner: { id: 77702, name: 'HeavilyGuardedLowCrop', level: 30, guard: true, newbie: false },
    posterior: { sampleCount: 30, winInterval: [0.0, 0.02], lossInterval: [0.98, 1.0] },
    isle: {
      plots: [{ c: lowValCropId, stage: 3, steal: true, stolen: 0 }],
      barn: [],
    },
  }

  const w = adapter.cloneWorld(baseWorld)
  w.state.en = 50
  w.state.plots = []
  w.state.barn = []
  const envProfitable = buildObservationEnvelope(adapter, {
    account: 'main',
    world: w,
    neighborTargets: [profitableOneSpot],
  })
  const planProfitable = solveUnifiedPlan(adapter, envProfitable, buildObjectiveConfig({ horizonSec: 3600 }), {
    allowedActionTypes: ['sell', 'craft', 'wait', 'visit'],
  })
  assert.equal(
    planProfitable.trunkBuckets[0]?.visitActions?.length || 0,
    1,
    'Profitable 1-spot target MUST be selected purely by unified economic EV (zero >=2 spot gate!)'
  )
  const compiledProfitable = compileExecutablePrefix(adapter, envProfitable.observed.world, planProfitable)
  assert.equal(compiledProfitable.status, 'ready')
  assert.equal(compiledProfitable.nextTransactionKind, 'visit')

  // SnipeScheduler also marks profitable 1-spot target as readyEligible with minStealSpots = 1!
  const mainSched = new SnipeScheduler({ accountKey: 'main' })
  assert.equal(mainSched.minStealSpots, 1)
  const snapEntry = mainSched.recordVisitSnapshot(adapter, w, 77701, {
    now: w.now,
    owner: profitableOneSpot.owner,
    isle: profitableOneSpot.isle,
  })
  assert.equal(snapEntry.readyEligible, true)

  // Conversely, without pre-existing stealth buff (`b12 = {}`, `pDet = 0.55`) and scarce 60s stamina (`en = 6`),
  // a heavily-guarded 1-spot cheap crop has strictly negative unified-model net EV (`0.45*V - 0.55*0.98*1.2*V < 0` + lost mines) and is rejected!
  const wScarce = adapter.cloneWorld(baseWorld)
  wScarce.state.en = 6
  wScarce.state.b12 = {}
  wScarce.state.iq = { d: adapter.R.isleIndex(wScarce.now), mine: 0, craft: 0 }
  wScarce.state.inv = {}
  wScarce.coins = 50
  wScarce.state.plots = []
  wScarce.state.barn = []
  const envLosing = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wScarce,
    neighborTargets: [losingOneSpot],
  })
  const planLosing = solveUnifiedPlan(adapter, envLosing, buildObjectiveConfig({ horizonSec: 60 }), {
    allowedActionTypes: ['mine', 'sell', 'craft', 'wait', 'visit'],
  })
  assert.equal(planLosing.trunkBuckets[0]?.visitActions?.length || 0, 0, 'Negative-net-surplus 1-spot target must be rejected by unified model')

  // Secondary scheduler hard isolation (`0` HTTP requests)
  let secondaryCalls = 0
  const secondarySched = new SnipeScheduler({ accountKey: 'secondary' })
  assert.equal(secondarySched.isStealEnabled(), false)
  const secondaryClient = new KernelHttpClient({
    cookieHeader: 'sid=secondary',
    fetchImpl: async () => { secondaryCalls++; throw new Error('forbidden') },
  })
  const bSlice = await secondarySched.runIncrementalDiscoverySlice(adapter, secondaryClient, w)
  assert.equal(bSlice.status, 'disabled-for-account')
  assert.equal(secondaryCalls, 0)
})

test('Phase 7.7: Strict Pet -> Gear/Points -> Arena causal ordering (Lv12->Lv13 before fight), ascending history cursor, cooldown preemption & Huancai 22:30 CST floor', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tmp = makeTempDir('p7-combat-order-')
  const lockDir = path.join(tmp, 'locks')
  const profilePath = path.join(tmp, 'opponent-profiles.json')
  const journal = new ContentAddressedJournal({ rootDir: path.join(tmp, 'journal'), account: 'main' })

  let simMs = 1_794_364_000_000
  let petTotalXp = 1430 // Lv12 (1320..1439); +10 XP crosses 1440 -> Lv13 (+3 free stat points!)
  let petRev = 7
  let serverLevel = 12
  let serverFreePoints = 0
  let serverPoints = { str: 21, vit: 6, agi: 0, spd: 6 }
  let battleExecutedAtLevel = null
  let battleExecutedWithPoints = null
  const callOrder = []

  // Prepare an idle world where domestic plan waits so `runLiveAccountTick` enters Phase C background pipeline
  const idleWorld = adapter.cloneWorld(baseWorld)
  idleWorld.now = 1794364000
  idleWorld.coins = 500
  idleWorld.state.en = 0
  idleWorld.state.inv = {}
  idleWorld.state.plots = []
  idleWorld.state.barn = []
  idleWorld.state.traps = []

  const liveClient = new KernelHttpClient({
    cookieHeader: 'sid=main',
    nowMsFn: () => simMs,
    sleepMsFn: async (ms) => { simMs += ms },
    fetchImpl: async (url, init) => {
      const u = new URL(url)
      const p = u.pathname
      const body = init.body ? JSON.parse(init.body) : null
      callOrder.push(`${init.method} ${p}`)

      if (p === '/api/pet/world') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ...idleWorld, now: Math.floor(simMs / 1000) }) }
      }
      if (init.method === 'GET' && p === '/api/pet/state') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            user_id: 100001,
            revision: petRev,
            progress: { total: petTotalXp, level: serverLevel, day: '2026-11-11#2', day_xp: 0, cap: 167 },
            state: { level: serverLevel, xp: 110, hunger: 60, mood: 70, clean: 70, energy: 70, ts: Math.floor(simMs / 1000) - 600 },
          }),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/state') {
        petRev++
        petTotalXp = 1480
        serverLevel = 13
        serverFreePoints += 3 // Pet level-up 12 -> 13 grants +3 battle stat points on server!
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ ok: true, revision: petRev, progress: { total: petTotalXp, level: 13 } }),
        }
      }
      if (init.method === 'GET' && p === '/api/pet/battle/home') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            adopted: true,
            today: { used: 0, limit: 5 },
            chests: [{ tier: 1, ready: true, opened: false }],
            // Newest-first history IDs 105..101 to verify ascending cursor ordering!
            history: [{ id: 105 }, { id: 104 }, { id: 103 }, { id: 102 }, { id: 101 }],
          }),
        }
      }
      if (init.method === 'GET' && p.startsWith('/api/pet/battle/') && /^\/api\/pet\/battle\/\d+$/.test(p)) {
        const bid = Number(p.split('/').pop())
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            id: bid,
            created_at: 1794363900 + bid,
            xp: 10,
            fighters: [
              { id: 100001, name: 'me', level: 12, hp: 280, atk: 45, def: 12, agi: 22, spd: 20 },
              { id: 60000 + bid, name: `Foe${bid}`, level: 10, hp: 210, atk: 35, def: 8, agi: 18, spd: 16 },
            ],
          }),
        }
      }
      if (init.method === 'GET' && p === '/api/pet/world/guard-log') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ battles: [] }) }
      }
      if (init.method === 'POST' && p === '/api/pet/battle/chest') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true }) }
      }
      if (init.method === 'GET' && p === '/api/pet/battle/gear') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify(makeSyntheticGearCatalog(serverLevel, serverFreePoints, serverPoints)),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/battle/equip') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify(makeSyntheticGearCatalog(serverLevel, serverFreePoints, serverPoints)),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/battle/points') {
        serverPoints = { ...body.points }
        serverFreePoints = 0
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify(makeSyntheticGearCatalog(serverLevel, 0, serverPoints)),
        }
      }
      if (init.method === 'GET' && p === '/api/pet/battle/opponents') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            opponents: [
              { id: 902, name: 'HighLv', level: 14, left: 3, power: 900 },
              { id: 901, name: 'LowLvTarget', level: 9, left: 3, power: 420 },
            ],
          }),
        }
      }
      if (init.method === 'POST' && p === '/api/pet/battle') {
        battleExecutedAtLevel = serverLevel
        battleExecutedWithPoints = { ...serverPoints }
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            id: 888,
            created_at: Math.floor(simMs / 1000),
            xp: 15,
            result: 'win',
            coins: 300,
            fighters: [
              { id: 100001, name: 'me', level: serverLevel, hp: 310, atk: 54, def: 15, agi: 26, spd: 24 },
              { id: 901, name: 'LowLvTarget', level: 9, hp: 180, atk: 30, def: 5, agi: 15, spd: 14 },
            ],
          }),
        }
      }
      if (init.method === 'GET' && p === '/api/huancai') {
        return {
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({ balance: 500, round: { day: '2026-11-11', price: 10, closed: false } }),
        }
      }
      if (init.method === 'GET' && p === '/api/huancai/orders') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ orders: [] }) }
      }
      if (init.method === 'POST' && p === '/api/huancai/buy') {
        return { status: 200, headers: new Map(), text: async () => JSON.stringify({ ok: true }) }
      }
      throw new Error(`Unhandled mock endpoint: ${init.method} ${p}`)
    },
  })
  liveClient.observeServerTimestampSec(idleWorld.now)

  const runtimeState = {
    lastPetCareAtSec: 0,
    lastBattlePrepAtSec: 0,
    lastBoutFinishedAtMs: 0,
    lastHuancaiCheckAtSec: 0,
    arenaRemaining: null,
  }

  const tickRes = await runLiveAccountTick({
    account: 'main',
    adapter,
    httpClient: liveClient,
    journal,
    snipeScheduler: null,
    lockRootDir: lockDir,
    profileStorePath: profilePath,
    huancaiStatePath: path.join(tmp, 'huancai.json'),
    runtimeState,
    baseUserConstraints: { cashReserveFloor: 10 },
    solverOptions: { checkHorizonStability: false, maxSteps: 2 },
  })

  // Assert strict causal sequence: `POST /api/pet/state` -> `POST /api/pet/battle/chest` -> `POST /api/pet/battle/points` -> `POST /api/pet/battle`!
  const idxPetSave = callOrder.indexOf('POST /api/pet/state')
  const idxChestOpen = callOrder.indexOf('POST /api/pet/battle/chest')
  const idxPointsAlloc = callOrder.indexOf('POST /api/pet/battle/points')
  const idxArenaFight = callOrder.indexOf('POST /api/pet/battle')
  assert.ok(idxPetSave >= 0, 'pet care must save')
  assert.ok(idxChestOpen > idxPetSave, 'battle chest opens after pet care')
  assert.ok(idxPointsAlloc > idxChestOpen, 'stat points allocate after pet level-up & chest open')
  assert.ok(idxArenaFight > idxPointsAlloc, 'arena bout executes AFTER Lv13 stat points are allocated!')
  assert.equal(battleExecutedAtLevel, 13)
  assert.equal(battleExecutedWithPoints.str + battleExecutedWithPoints.vit + battleExecutedWithPoints.agi + battleExecutedWithPoints.spd, 36)
  assert.equal(tickRes.backgroundReport.arenaBout.opponent.id, 901, 'lowest-level available opponent selected')

  // Verify ascending history cursor (`maxFetch = 2` on `[205, 204, 203]` fetches `203, 204` and sets `lastHomeHistoryId = 204`, NEVER skipping `203`!)
  const histCalls = []
  const histClient = {
    getJson: async (p) => {
      histCalls.push(p)
      const id = Number(p.split('/').pop())
      return {
        id,
        created_at: 1794364100 + id,
        xp: 10,
        fighters: [
          { id: 100001, name: 'me', level: 13, hp: 300, atk: 50, def: 15, agi: 25, spd: 20 },
          { id: 70000 + id, name: `Hist${id}`, level: 10, hp: 200, atk: 30, def: 5, agi: 15, spd: 15 },
        ],
      }
    },
  }
  const profilePath2 = path.join(tmp, 'hist-profiles.json')
  await syncHomeHistoryProfiles(histClient, { history: [{ id: 205 }, { id: 204 }, { id: 203 }] }, 'main', {
    maxFetch: 2,
    storePath: profilePath2,
  })
  assert.deepEqual(histCalls, ['/api/pet/battle/203', '/api/pet/battle/204'])
  assert.equal(loadProfileStore(profilePath2).lastHomeHistoryId.main, 204)

  // Verify `runSingleArenaBout` sleeps cooldown OUTSIDE gear lock and preempts immediately on `shouldAbortFn`!
  let abortFlag = false
  let sleepChunks = 0
  const preemptClient = new KernelHttpClient({
    cookieHeader: 'sid=main',
    nowMsFn: () => simMs,
    sleepMsFn: async (ms) => {
      simMs += ms
      sleepChunks++
      // Verify gear lock file does NOT exist while sleeping arena cooldown!
      assert.equal(fs.existsSync(path.join(lockDir, '.battle-gear.main.lock')), false)
      if (sleepChunks >= 2) abortFlag = true
    },
    fetchImpl: async () => ({
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ adopted: true, today: { used: 1, limit: 5 } }),
    }),
  })
  const preemptOut = await runSingleArenaBout(preemptClient, {
    accountKey: 'main',
    lockRoot: lockDir,
    storePath: profilePath,
    lastBoutFinishedAtMs: simMs,
    minBoutGapMs: 8500,
    shouldAbortFn: () => abortFlag,
  })
  assert.equal(preemptOut.status, 'preempted-by-snipe')
  assert.equal(preemptOut.stage, 'during-cooldown')

  // Verify Huancai `22:30 CST` cycle boundary & mode isolation & cash reserve guard
  const t2229Cst = Date.UTC(2026, 10, 10, 14, 29, 59) / 1000 // 2026-11-10 22:29:59 CST
  const t2230Cst = Date.UTC(2026, 10, 10, 14, 30, 0) / 1000  // 2026-11-10 22:30:00 CST
  assert.ok(huancaiCycleStartSec(t2230Cst) - huancaiCycleStartSec(t2229Cst) === 86400)
  assert.equal(planHuancaiFloor({ accountKey: 'secondary', overview: { balance: 9999, round: { day: 'd1' } }, nowSec: t2230Cst }).shouldBuy, false)
  assert.equal(planHuancaiFloor({ accountKey: 'main', cashReserveFloor: 100, overview: { balance: 105, round: { day: 'd1', price: 10 } }, nowSec: t2230Cst }).shouldBuy, false)
  assert.equal(planHuancaiFloor({ accountKey: 'main', cashReserveFloor: 100, overview: { balance: 110, round: { day: 'd1', price: 10 } }, nowSec: t2230Cst }).shouldBuy, true)
})

test('Phase 7.8: Convergence regressions — 3x/spot guard-win loot, zero unlock coalescing delay, equip try/finally recovery, causal multi-plot harvest batching & cross-day remSupply sale schedule', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: baseWorld.clockStart })
  const tmp = makeTempDir('p7-convergence-')
  const lockDir = path.join(tmp, 'locks')
  const profilePath = path.join(tmp, 'profiles.json')

  // 1) 4-outcome guard-win 3x/spot (+1/spot) valuation:
  //    Pick a crop and set its quote P = 1000, with 1 spot and 3 domestic mines (3 en each -> 6 en raid costs 2 mines).
  //    Let mine expected value be adjusted via ore prices so 2x/spot (2000 D) < stamina cost (2250 D) < 2.55x/spot (2550 D = 0.45*2000 + 0.55*3000)!
  const testCrop = adapter.R.CROPS[0]
  let wGuardBonus = adapter.advanceTimeOnly(baseWorld, 1794365000)
  wGuardBonus.coins = 500000
  wGuardBonus.state.en = 6
  wGuardBonus.state.inv = {}
  wGuardBonus.state.plots = []
  wGuardBonus.state.barn = []
  wGuardBonus.state.traps = []
  wGuardBonus.state.b12 = {}
  wGuardBonus.prices = Object.fromEntries(adapter.graph.sellableIds.map((id) => [id, 0]))
  wGuardBonus.prices[testCrop.id] = 1000
  // Buy `sack` through real rules engine so `carry` buff is genuinely active (`2x` undetected, `3x` on guard win!)
  wGuardBonus = adapter.simulateBatch(wGuardBonus, [{ a: 'buy', id: 'sack' }], {
    t: wGuardBonus.now,
    prices: wGuardBonus.prices,
  }).afterWorld

  const envUnGuarded2x = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wGuardBonus,
    neighborTargets: [{
      id: 91001,
      owner: { id: 91001, name: 'Unguarded2x', level: 10, guard: false, newbie: false },
      isle: { plots: [{ c: testCrop.id, stage: 3, steal: true, stolen: 0 }], barn: [] },
    }],
    userConstraints: { allowThiefBuffPurchase: false },
  })
  const envGuarded100Win = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wGuardBonus,
    neighborTargets: [{
      id: 91002,
      owner: { id: 91002, name: 'Guarded3xOnWin', level: 10, guard: true, newbie: false },
      posterior: { simulated: true, winInterval: [1.0, 1.0], lossInterval: [0.0, 0.0], drawRate: 0 },
      isle: { plots: [{ c: testCrop.id, stage: 3, steal: true, stolen: 0 }], barn: [] },
    }],
    userConstraints: { allowThiefBuffPurchase: false },
  })
  assert.equal(envGuarded100Win.beliefs.visitBeliefs[0].unitsPerSpot, 2)
  assert.equal(envGuarded100Win.beliefs.visitBeliefs[0].guardWinUnitsPerSpot, 3)

  const plan2x = solveUnifiedPlan(adapter, envUnGuarded2x, buildObjectiveConfig({ horizonSec: 60 }), {
    allowedActionTypes: ['sell', 'wait', 'visit'],
  })
  const plan3x = solveUnifiedPlan(adapter, envGuarded100Win, buildObjectiveConfig({ horizonSec: 60 }), {
    allowedActionTypes: ['sell', 'wait', 'visit'],
  })
  const v2x = plan2x.trunkBuckets[0].visitActions[0]
  const v3x = plan3x.trunkBuckets[0].visitActions[0]
  assert.ok(
    Math.abs((v3x.expectedDeltaObjectiveMid - v2x.expectedDeltaObjectiveMid) - 385) < 1e-6,
    `100%-win guarded target (${v3x.expectedDeltaObjectiveMid}) must exceed unguarded 2x target (${v2x.expectedDeltaObjectiveMid}) by exact +0.55 * 1000 * 0.70 = +385 D after 30% b12 tax`
  )

  // 2) Zero coalesceUnlockWindowSec delay:
  //    Plot 0 unlocks at T+5 (already positive EV), Plot 1 unlocks at T+15 (+10s, inside legacy 12s coalesce window).
  //    SnipeScheduler MUST schedule at earliest positive-EV T+5, NEVER delaying to T+15!
  const T0 = 1794366000
  const richCrop = [...adapter.R.CROPS].sort((a, b) => b.price - a.price)[0]
  const iDay = adapter.R.isleDay(T0)
  const isRain = adapter.R.weatherOf(iDay) === 1
  const growSec = richCrop.grow * 60 * 0.8 * (isRain ? 0.6 : 1)
  const plantedEarly = Math.floor((T0 - 1795) - growSec) // unlockAt = T0 + 5
  const plantedLater = Math.floor((T0 - 1785) - growSec) // unlockAt = T0 + 15
  const schedNoCoalesce = new SnipeScheduler({
    accountKey: 'main',
    scheduleFilePath: path.join(tmp, 'no-coalesce.json'),
  })
  const wRich = adapter.advanceTimeOnly(baseWorld, T0)
  wRich.state.en = 50
  const noCoalEntry = schedNoCoalesce.recordVisitSnapshot(adapter, wRich, 92001, {
    now: T0,
    clockStart: baseWorld.clockStart,
    owner: { id: 92001, name: 'TwoWaves10sApart', level: 8, guard: false, newbie: false },
    rules: { protect: 1800, perPlot: 2, perPen: 2, perOwner: 999 },
    left: { today: 999, owner: 999 },
    isle: {
      plots: [
        { c: richCrop.id, stage: 3, left: 0, steal: false, stolen: 0 },
        { c: richCrop.id, stage: 3, left: 0, steal: false, stolen: 0 },
      ],
      barn: [],
    },
    state: {
      tools: { spr: 0 },
      plots: [
        { c: richCrop.id, t: plantedEarly, w: isRain ? 3 : 0, g: 0, h: 0 },
        { c: richCrop.id, t: plantedLater, w: isRain ? 3 : 0, g: 0, h: 0 },
      ],
      barn: [],
    },
  })
  assert.equal(noCoalEntry.upcomingEligible, true)
  assert.ok(
    noCoalEntry.expectedUnlockAt <= T0 + 6,
    `Must schedule earliest positive-EV plot at T0+5 (got +${noCoalEntry.expectedUnlockAt - T0}s, never delayed +15s!)`
  )

  // 3) executeWithTacticalLoadout try/finally recovery when 2nd slot equip throws!
  recordBattleSnapshot({
    id: 9301,
    created_at: T0,
    winner: 0,
    fighters: [
      { id: 100001, name: 'me', level: 13, hp: 300, atk: 50, def: 15, agi: 25, spd: 20 },
      { id: 93001, name: 'TwoSlotSwapFoe', level: 11, hp: 48, atk: 420, def: 0, agi: 0, spd: 60, gear: { weapon: { id: 'x' } } },
    ],
  }, 'guard', { storePath: profilePath })
  const curGearState = makeSyntheticGearCatalog(13, 0)
  const equipCalls = []
  let actionInvoked = false
  const tacFail = await executeWithTacticalLoadout({
    accountKey: 'main',
    lockRoot: lockDir,
    opponentId: 93001,
    mode: 'guard',
    storePath: profilePath,
    precomputedDecision: {
      switched: true,
      switchedSlots: ['weapon', 'charm'],
      targetIds: { weapon: 'test_spear_fast', armor: 'test_plate_rest', charm: 'test_charm_first' },
    },
    getGearFn: async () => structuredClone(curGearState),
    equipSlotFn: async (slot, item) => {
      equipCalls.push({ slot, item })
      if (slot === 'charm' && item === 'test_charm_first') {
        throw new Error('network error during 2nd combat slot equip')
      }
      curGearState.gear[slot] = { id: item, enh: 2 }
      return { ok: true, status: 200 }
    },
    actionFn: async () => {
      actionInvoked = true
      return { ok: true }
    },
  })
  assert.equal(actionInvoked, false, 'actionFn must NOT run when pre-equip fails mid-loop')
  assert.ok(tacFail.preEquipError, 'preEquipError must be reported')
  assert.equal(curGearState.gear.weapon.id, 'test_blade_rest', '1st equipped slot MUST be restored to resting gear in finally!')
  assert.equal(readAccountGearState('main', lockDir).dirty, false)

  // 4a) Causal multi-plot harvest batching: 6 mature plots batch into 1 POST /world/act, truncating ONLY before selling that crop!
  const tRipe = 1794355200 // Real timestamp where baseWorld's 24 corn plots are mature!
  const wHarv = adapter.advanceTimeOnly(baseWorld, tRipe)
  wHarv.state.en = 50
  wHarv.state.inv = {} // Empty inventory so selling harvested crop causally depends on the unobserved harvest yield!
  const ripeCropId = wHarv.state.plots[0].c
  const fakePlan = {
    planId: 'p-batch-harv',
    serverNow: tRipe,
    trunkBuckets: [{
      bucketIndex: 0,
      atSec: tRipe,
      nextAtSec: tRipe + 600,
      domesticActions: [
        ...Array.from({ length: 6 }, (_, i) => ({ a: 'harvest', i })),
        { a: 'sell', id: ripeCropId, q: 0, n: 1 },
      ],
      visitActions: [],
    }],
  }
  const compHarv = compileExecutablePrefix(adapter, wHarv, fakePlan)
  assert.equal(compHarv.status, 'ready')
  assert.equal(compHarv.domesticBatch.filter((a) => a.a === 'harvest').length, 6, 'All 6 independent mature harvests must batch in 1 request!')
  assert.equal(compHarv.domesticBatch.some((a) => a.a === 'sell'), false, 'Downstream sell depending on unobserved harvest yield must wait for receipt!')
  assert.equal(compHarv.truncatedAfterStochastic, true)

  // 4b) Cross-day future supply (`remSupply`) in `emitOptimalBucketSells`:
  //     Day 1 price = 1000, Day 2 price = 1100 (85% tier = 935 < 1000!).
  //     With 150 crop on Day 1 and +400 arriving on Day 2 (`sc` tier cap = 400),
  //     Day 1 MUST sell >=150 at 1000 today instead of holding into Day 2's 85% tier (935)!
  const nextNatMidnight = adapter.nextNaturalDayBoundary(T0)
  const tBeforeMid = nextNatMidnight - 600
  const wCrossDay = adapter.advanceTimeOnly(baseWorld, tBeforeMid)
  wCrossDay.coins = 10000
  wCrossDay.state.en = 0
  wCrossDay.state.plots = []
  wCrossDay.state.barn = []
  wCrossDay.state.traps = []
  wCrossDay.state.cnt = { sc: 0 }
  wCrossDay.state.inv = { [testCrop.id]: [100, 0, 50] }
  wCrossDay.prices = Object.fromEntries(adapter.graph.sellableIds.map((id) => [id, 500]))
  wCrossDay.prices[testCrop.id] = 1000

  const envCross = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wCrossDay,
    scenarios: [{ id: 's1', weight: 1.0, externalSupplyFactor: 1.05 }],
  })
  // Override next isle day quote cleanly via scenario where Day 2 arrival is +400
  const planCross = solveUnifiedPlan(
    adapter,
    envCross,
    buildObjectiveConfig({ horizonSec: 3600 }),
    {
      deterministicArrivals: [{ atSec: nextNatMidnight + 60, items: [{ id: testCrop.id, q: 0, n: 450 }] }],
      allowedActionTypes: ['sell', 'wait'],
    }
  )
  const soldToday = (planCross.trunkBuckets[0]?.domesticActions || [])
    .filter((a) => a.a === 'sell' && a.id === testCrop.id)
    .reduce((sum, a) => sum + Number(a.n || 0), 0)
  assert.equal(soldToday, 150, 'Day-1 crop must sell in full at 100% tier when Day-2 +450 arrival already saturates Day-2 100% tier!')

  // 5) P1-1 Regression: Guard-loss branch MUST retain sunk prep cost (`(d + l) * wEmptyExpected - l * fine`),
  //    never refunding `pDet * pLoss * 15,000 D` coffee prep on guard defeat!
  const wLossPrep = adapter.advanceTimeOnly(baseWorld, T0)
  wLossPrep.rev = 500
  wLossPrep.coins = 50000
  wLossPrep.state.en = 0 // Forces 15,000 D coffee prep (no food in inv)
  wLossPrep.state.enT = T0
  wLossPrep.state.inv = {}
  wLossPrep.state.plots = []
  wLossPrep.state.barn = []
  wLossPrep.state.traps = []
  wLossPrep.state.b12 = {}
  wLossPrep.state.cnt = { coffee: 0, sc: 0 }
  wLossPrep.prices = Object.fromEntries(adapter.graph.sellableIds.map((id) => [id, 0]))
  // 8 spots * 2x = 16 units undetected, 8 * 3x = 24 units on guard win -> at 1465 D/unit * 0.70 (30% b12 tax):
  //   undet loot = 16 * 1025.5 = 16,408 D; guardWin loot = 24 * 1025.5 = 24,612 D.
  //   With pDet = 0.55, w = 0.20, l = 0.80:
  //   Gross expected loot = 0.45 * 16,408 + 0.55 * 0.20 * 24,612 = 7,383.6 + 2,707.32 = 10,090.92 D < 15,000 D coffee!
  //   True EV < -4,900 D (strictly unprofitable!), whereas omitting `0.55 * 0.80 * (-15,000) = -6,600 D` falsely made EV > +1,600 D!
  wLossPrep.prices[testCrop.id] = 1465
  let wWithSackZeroEn = adapter.simulateBatch(wLossPrep, [{ a: 'buy', id: 'sack' }], {
    t: wLossPrep.now,
    prices: wLossPrep.prices,
  }).afterWorld
  wWithSackZeroEn.coins = 500000
  for (const st of adapter.R.b12Stock(T0, wWithSackZeroEn.prices)) {
    const left = adapter.R.b12StockLeft(wWithSackZeroEn.state, st, T0)
    if (left > 0) {
      wWithSackZeroEn = adapter.simulateBatch(
        wWithSackZeroEn,
        [{ a: 'stockBuy', id: st.id, n: left, day: adapter.R.isleDay(T0) }],
        { t: T0, prices: wWithSackZeroEn.prices }
      ).afterWorld
    }
  }
  wWithSackZeroEn.state.inv = {}
  wWithSackZeroEn.coins = 50000
  wWithSackZeroEn.state.en = 0

  const guardedHighLossTarget = {
    id: 93001,
    owner: { id: 93001, name: 'HighLossGuard', level: 20, guard: true, newbie: false },
    posterior: { simulated: true, winInterval: [0.20, 0.20], lossInterval: [0.80, 0.80], drawRate: 0 },
    isle: {
      plots: Array.from({ length: 8 }, () => ({ c: testCrop.id, stage: 3, steal: true, stolen: 0 })),
      barn: [],
    },
  }
  const envLossPrep = buildObservationEnvelope(adapter, {
    account: 'main',
    world: wWithSackZeroEn,
    neighborTargets: [guardedHighLossTarget],
    userConstraints: { allowThiefBuffPurchase: false, cashReserveFloor: 0 },
  })
  const planLossPrep = solveUnifiedPlan(adapter, envLossPrep, buildObjectiveConfig({ horizonSec: 60 }), {
    allowedActionTypes: ['coffee', 'sell', 'wait', 'visit'],
  })
  assert.equal(
    planLossPrep.trunkBuckets[0].visitActions.length,
    0,
    'Negative-EV raid requiring 15,000 D coffee with 80% guard loss MUST be rejected (no phantom coffee refund on loss!)'
  )
  const raidEvalLossPrep = createUnifiedRaidEvaluator(adapter, wWithSackZeroEn, {
    account: 'main',
    objectiveCfg: buildObjectiveConfig({ horizonSec: 60 }),
    userConstraints: { allowThiefBuffPurchase: false, cashReserveFloor: 0 },
  })
  const waveLossOut = raidEvalLossPrep.evaluateTargetWave(guardedHighLossTarget, T0)
  assert.equal(waveLossOut.profitable, false, 'Resident unified evaluator must also reject negative-EV coffee+loss raid')

  // 6) P1-2 Regression: `primeUnifiedBaseline` MUST reject stale `marginalContext` when `visitorWorld.rev` advanced!
  assert.equal(planLossPrep.marginalContext?.sourceWorldRev, wWithSackZeroEn.rev)
  const postTxWorld = structuredClone(wWithSackZeroEn)
  postTxWorld.rev = Number(wWithSackZeroEn.rev || 0) + 1
  const schedRevGuard = new SnipeScheduler({ accountKey: 'main' })
  const primedStale = schedRevGuard.primeUnifiedBaseline(adapter, postTxWorld, planLossPrep.marginalContext, {
    allowThiefBuffPurchase: false,
  })
  assert.equal(primedStale, null, 'primeUnifiedBaseline must refuse to bind R0 marginalContext onto R1 post-tx world')
  assert.equal(schedRevGuard._evaluatorCache.evaluator, null)
  const freshEvaluator = schedRevGuard.getUnifiedEvaluator(adapter, postTxWorld, {
    userConstraints: { allowThiefBuffPurchase: false },
  })
  assert.equal(freshEvaluator.marginalContext.sourceWorldRev, postTxWorld.rev, 'Cache miss must rebuild fresh R1 marginalContext')
})
