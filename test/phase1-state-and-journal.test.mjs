import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import {
  executeTransaction,
  reconcileUnknownWithFreshWorld,
  recoverPendingTransactions,
} from '../execution/reconcile.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ukernel-${prefix}-`))
}

function makeBaseWorld(adapter, nowSec = 1794340000) {
  const s = adapter.R.newWorld(nowSec)
  const prices = {}
  const iDay = adapter.R.isleDay(nowSec)
  for (const id of adapter.graph.sellableIds) {
    prices[id] = adapter.R.priceOf(id, iDay, 0)
  }
  return {
    now: nowSec,
    clockStart: 1794212939,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, 1794212939),
    rev: 10,
    coins: 100000,
    prices,
    state: s,
  }
}

test('Phase 1.1: Two concurrent workers racing for steal budget = 1 never oversubscribe', async () => {
  const dir = makeTempDir('race')
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: 1794212939 })
  const journal1 = new ContentAddressedJournal({ rootDir: path.join(dir, 'journal'), account: 'main' })
  const journal2 = new ContentAddressedJournal({ rootDir: path.join(dir, 'journal'), account: 'main' })
  const lockDir = path.join(dir, 'locks')
  const world = makeBaseWorld(adapter)

  let serverCalls = 0
  const slowSend = async ({ operation }) => {
    serverCalls++
    await new Promise((r) => setTimeout(r, 40))
    return {
      status: 200,
      body: { ok: true, operation, world: { ...world, rev: world.rev + 1 } },
    }
  }

  const [r1, r2] = await Promise.all([
    executeTransaction({
      journal: journal1,
      adapter,
      lockRootDir: lockDir,
      account: 'main',
      kind: 'visit',
      budgetKind: 'steal',
      budgetLimitPerIsleDay: 1,
      worldBefore: world,
      requestPayload: { targetId: 101 },
      sendFn: slowSend,
    }),
    executeTransaction({
      journal: journal2,
      adapter,
      lockRootDir: lockDir,
      account: 'main',
      kind: 'visit',
      budgetKind: 'steal',
      budgetLimitPerIsleDay: 1,
      worldBefore: world,
      requestPayload: { targetId: 102 },
      sendFn: slowSend,
    }),
  ])

  const statuses = [r1.status, r2.status].sort()
  assert.deepEqual(statuses, ['budget-exhausted', 'confirmed'])
  assert.equal(serverCalls, 1)
  assert.equal(journal1.countOccupiedBudget('steal', adapter.R.isleIndex(world.now)), 1)
})

test('Phase 1.2: Pre-send crash releases budget cleanly; post-send timeout freezes resources until explicit reconcile', async () => {
  const dir = makeTempDir('unknown')
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: 1794212939 })
  const journal = new ContentAddressedJournal({ rootDir: path.join(dir, 'journal'), account: 'main' })
  const lockDir = path.join(dir, 'locks')
  const world = makeBaseWorld(adapter, 1794369550) // 50s before nextIsleAt = 1794369600!
  const curIsleIdx = adapter.R.isleIndex(world.now)

  // Simulate a crashed pre-send `reserved-and-durable` record
  journal.appendEvent({
    recordType: 'tx-transition',
    operation: 'op-crashed-pre-send',
    kind: 'visit',
    status: 'reserved-and-durable',
    budgetKind: 'steal',
    possibleIsleIndices: [curIsleIdx],
  })
  assert.equal(journal.countOccupiedBudget('steal', curIsleIdx), 1)

  const rec1 = recoverPendingTransactions(journal, adapter, world.now)
  assert.equal(rec1.abortedPreSend, 1)
  assert.equal(journal.countOccupiedBudget('steal', curIsleIdx), 0)

  // Now execute an `act` transaction right near isle-day boundary that suffers a network timeout
  const txTimeout = await executeTransaction({
    journal,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    kind: 'act',
    budgetKind: 'custom-op',
    budgetLimitPerIsleDay: 1,
    nearIsleBoundaryBufferSec: 90,
    worldBefore: world,
    requestPayload: { actions: [{ a: 'sell', id: 'turnip', q: 0, n: 1 }] },
    sendFn: async () => {
      throw new Error('ECONNRESET socket hang up after write')
    },
  })

  assert.equal(txTimeout.status, 'unknown')
  // Cross-isle-day boundary uncertainty: both curIsleIdx AND curIsleIdx + 1 conservatively occupied!
  assert.equal(journal.countOccupiedBudget('custom-op', curIsleIdx), 1)
  assert.equal(journal.countOccupiedBudget('custom-op', curIsleIdx + 1), 1)

  // Any subsequent new transaction MUST fail-closed with `blocked-pending-reconcile` before touching resources!
  const blockedAttempt = await executeTransaction({
    journal,
    adapter,
    lockRootDir: lockDir,
    account: 'main',
    kind: 'act',
    worldBefore: world,
    requestPayload: { actions: [{ a: 'sell', id: 'turnip', q: 0, n: 1 }] },
    sendFn: async () => ({ status: 200, body: { ok: true } }),
  })
  assert.equal(blockedAttempt.status, 'blocked-pending-reconcile')

  // Stale/same-second snapshot (`now <= tx.serverNow` with unchanged `rev`) MUST NOT prematurely clear `unknown`!
  const staleSameSec = { ...world, now: world.now, rev: world.rev }
  const recStale = reconcileUnknownWithFreshWorld(journal, adapter, staleSameSec)
  assert.equal(recStale.reconciled, 0)
  assert.equal(recStale.remainingUnknown, 1)

  // Now reconcile with a fresh server snapshot whose clock advanced AND `rev` is UNCHANGED (proving server never committed it!)
  const freshUnchanged = { ...world, now: world.now + 120, rev: world.rev }
  const recRes = reconcileUnknownWithFreshWorld(journal, adapter, freshUnchanged)
  assert.equal(recRes.reconciled, 1)
  assert.equal(recRes.remainingUnknown, 0)
  assert.equal(journal.countOccupiedBudget('custom-op', curIsleIdx), 0)
  assert.equal(journal.countOccupiedBudget('custom-op', curIsleIdx + 1), 0)
})

test('Phase 1.3: Wait decisions are persisted and secrets are strictly stripped across envelope and journal', async () => {
  const dir = makeTempDir('secrets')
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: 1794212939 })
  const journal = new ContentAddressedJournal({ rootDir: path.join(dir, 'journal'), account: 'main' })
  const dirtyWorld = {
    ...makeBaseWorld(adapter),
    cookie: 'sid=TOP_SECRET_COOKIE_123',
    sessionToken: 'BEARER_SECRET_XYZ',
    headers: { authorization: 'Bearer super-secret' },
  }

  const env = buildObservationEnvelope(adapter, { account: 'main', world: dirtyWorld })
  const envJson = JSON.stringify(env)
  assert.ok(!envJson.includes('TOP_SECRET_COOKIE_123'))
  assert.ok(!envJson.includes('BEARER_SECRET_XYZ'))
  assert.ok(!envJson.includes('super-secret'))

  journal.recordWaitDecision({
    worldBefore: dirtyWorld,
    rulesHash: adapter.rulesHash,
    rulesSourceText: adapter.rulesSourceText,
    objectiveHash: 'obj-1',
    constraintsHash: env.constraintsHash,
    plannedWakeSec: dirtyWorld.now + 180,
    reason: 'awaiting-arrival',
    planSummary: { secretToken: 'SHOULD_BE_STRIPPED', ok: true },
  })

  const reconstructed = journal.reconstructTransactions()
  assert.equal(reconstructed.waitDecisions.length, 1)
  assert.equal(reconstructed.waitDecisions[0].plannedWakeSec, dirtyWorld.now + 180)

  // Verify raw files on disk contain zero secret substrings
  const allBlobFiles = fs.readdirSync(journal.blobsDir)
  for (const f of allBlobFiles) {
    const content = fs.readFileSync(path.join(journal.blobsDir, f), 'utf8')
    assert.ok(!content.includes('TOP_SECRET_COOKIE_123'))
    assert.ok(!content.includes('SHOULD_BE_STRIPPED'))
  }
})
