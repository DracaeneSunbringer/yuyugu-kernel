import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { ContentAddressedJournal } from '../audit/journal.mjs'
import { auditJournalReplayAll } from '../audit/replay.mjs'
import { runControllerStep } from '../cli/controller.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const FIXTURE_PATH = path.resolve('fixtures/sample-snapshot.json')

test('Phase 4.1: Live shadow & simulated closed-loop execution across full-mode and domestic-only snapshots', async () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8').replace(/^\uFEFF/, ''))
  const mainWorld = fixture.mainBundle.main
  const secondaryWorld = fixture.domestic
  const neighbors = fixture.mainBundle.sampleVisits || []

  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: mainWorld.clockStart })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-phase4-'))

  // 1) Closed-loop step on `main` (with mock server executing real `applyActions`!)
  const mainJournal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'main' })
  let currentMainWorld = structuredClone(mainWorld)

  const mainStep = await runControllerStep({
    adapter,
    journal: mainJournal,
    lockRootDir: path.join(tmpDir, 'locks'),
    account: 'main',
    fetchWorldFn: async () => currentMainWorld,
    fetchNeighborsFn: async () => neighbors,
    fetchPartnerWorldFn: async () => secondaryWorld,
    sendActFn: async ({ operation, actions }) => {
      const sim = adapter.simulateBatch(currentMainWorld, actions, {
        t: currentMainWorld.now,
        prices: currentMainWorld.prices,
      })
      assert.equal(sim.allOk, true, 'Every compiled main domestic action must succeed in real applyActions!')
      currentMainWorld = { ...sim.afterWorld, rev: (currentMainWorld.rev || 0) + 1 }
      return {
        status: 200,
        body: {
          ok: true,
          operation,
          out: sim.result.out,
          spend: sim.result.spend,
          earn: sim.result.earn,
          world: currentMainWorld,
        },
      }
    },
    sendVisitFn: async ({ operation, targetId }) => {
      const enCost = 4
      const nextState = structuredClone(currentMainWorld.state)
      nextState.en = Math.max(0, Number(nextState.en || 0) - enCost)
      currentMainWorld = { ...currentMainWorld, state: nextState, rev: (currentMainWorld.rev || 0) + 1 }
      return {
        status: 200,
        body: {
          ok: true,
          operation,
          targetId,
          energyCost: enCost,
          fine: 0,
          loot: {},
          world: currentMainWorld,
        },
      }
    },
    userConstraints: {},
    dryRun: false,
  })

  assert.ok(['confirmed', 'waiting'].includes(mainStep.status))
  // Verify `main` emitted ZERO CapEx actions
  const mainCapex = (mainStep.compiled.domesticBatch || []).filter((a) =>
    ['expand', 'buyAnimal', 'buyTrap', 'upgrade'].includes(a.a)
  )
  assert.equal(mainCapex.length, 0)

  // Replay `main` journal through independent Layer 1 auditor (`audit/replay.mjs`)
  const mainReplay = await auditJournalReplayAll(mainJournal, { fallbackAdapter: adapter })
  assert.equal(mainReplay.modelDriftCount, 0)
  assert.equal(mainReplay.shadowViolationCount, 0)
  assert.equal(mainReplay.illegalActionBatchCount, 0)
  assert.equal(mainReplay.notIdentifiableCount, 0)

  // 2) Closed-loop step in domestic-only mode (even when handed neighbor targets, must emit 0 visits!)
  const secondaryJournal = new ContentAddressedJournal({ rootDir: path.join(tmpDir, 'journal'), account: 'secondary' })
  let currentSecondaryWorld = structuredClone(secondaryWorld)

  const secondaryStep = await runControllerStep({
    adapter,
    journal: secondaryJournal,
    lockRootDir: path.join(tmpDir, 'locks'),
    account: 'secondary',
    fetchWorldFn: async () => currentSecondaryWorld,
    fetchNeighborsFn: async () => neighbors,
    fetchPartnerWorldFn: async () => currentMainWorld,
    sendActFn: async ({ operation, actions }) => {
      const sim = adapter.simulateBatch(currentSecondaryWorld, actions, {
        t: currentSecondaryWorld.now,
        prices: currentSecondaryWorld.prices,
      })
      assert.equal(sim.allOk, true, 'Every compiled secondary domestic action must succeed in real applyActions!')
      currentSecondaryWorld = { ...sim.afterWorld, rev: (currentSecondaryWorld.rev || 0) + 1 }
      return {
        status: 200,
        body: {
          ok: true,
          operation,
          out: sim.result.out,
          spend: sim.result.spend,
          earn: sim.result.earn,
          world: currentSecondaryWorld,
        },
      }
    },
    dryRun: false,
  })

  assert.ok(['confirmed', 'waiting'].includes(secondaryStep.status))
  assert.equal(secondaryStep.compiled.visitOperations.length, 0)
  assert.notEqual(secondaryStep.compiled.nextTransactionKind, 'visit')

  // Verify stochastic prefix truncation fired (`fish` was last action in compiled batch!)
  if (secondaryStep.compiled.domesticBatch.some((a) => adapter.isStochasticAction(a))) {
    const firstStochIdx = secondaryStep.compiled.domesticBatch.findIndex((a) => adapter.isStochasticAction(a))
    assert.equal(
      firstStochIdx,
      secondaryStep.compiled.domesticBatch.length - 1,
      'Stochastic action must strictly be the final action of the compiled prefix!'
    )
  }

  const secondaryReplay = await auditJournalReplayAll(secondaryJournal, { fallbackAdapter: adapter })
  assert.equal(secondaryReplay.modelDriftCount, 0)
  assert.equal(secondaryReplay.shadowViolationCount, 0)
  assert.equal(secondaryReplay.illegalActionBatchCount, 0)
  assert.equal(secondaryReplay.notIdentifiableCount, 0)
})
