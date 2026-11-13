import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRulesAdapter } from '../model/rules-adapter.mjs'
import { COST as XS_COST, act as xsAct } from '../rules/xs-xian-rules.js'

/**
 * Layer 1 Audit (`audit/replay.mjs`):
 * Replays recorded journal transactions against archived rule sources and server receipts.
 * Zero dependency on `planner/*`.
 */
export async function auditTransactionReplay(journal, tx, { fallbackAdapter = null } = {}) {
  if (!tx || !tx.operation) {
    return { status: 'not-identifiable', reason: 'invalid-transaction-record' }
  }

  if (tx.status === 'unknown' || tx.status === 'submitted' || tx.status === 'unknown-state-reanchored') {
    return {
      operation: tx.operation,
      status: 'pending-or-unknown-receipt',
      txStatus: tx.status,
      identifiable: false,
      reason: 'transaction-outcome-was-uncertain-at-transport-layer',
    }
  }

  if (!tx.stateBeforeRef) {
    return {
      operation: tx.operation,
      status: 'not-identifiable',
      identifiable: false,
      reason: 'missing-state-before-ref',
    }
  }

  const stateBefore = journal.readBlob(tx.stateBeforeRef)
  if (!stateBefore || !stateBefore.state) {
    return {
      operation: tx.operation,
      status: 'not-identifiable',
      identifiable: false,
      reason: 'missing-or-corrupt-state-before-blob',
    }
  }

  // Resolve exact historical RulesAdapter matching `tx.rulesHash`
  let adapter = null
  if (tx.rulesHash) {
    if (fallbackAdapter && fallbackAdapter.rulesHash === tx.rulesHash) {
      adapter = fallbackAdapter
    } else {
      const archivedSrc = journal.readArchivedRulesSource(tx.rulesHash)
      if (archivedSrc) {
        const ruleFile = path.join(journal.rulesDir, `${tx.rulesHash}.js`)
        if (fs.existsSync(ruleFile)) {
          const mod = await import(`${pathToFileURL(ruleFile).href}?t=${tx.rulesHash.slice(0, 8)}`)
          adapter = createRulesAdapter(mod, {
            clockStart: stateBefore.clockStart || 0,
            rulesSourceText: archivedSrc,
          })
        }
      }
    }
  }

  if (!adapter) {
    return {
      operation: tx.operation,
      status: 'not-identifiable',
      identifiable: false,
      reason: tx.rulesHash ? `missing-archived-rules-for-hash:${tx.rulesHash}` : 'missing-rules-hash',
    }
  }

  const request = tx.requestRef ? journal.readBlob(tx.requestRef) : null
  const response = tx.responseRef ? journal.readBlob(tx.responseRef) : null
  const stateAfter = tx.stateAfterRef ? journal.readBlob(tx.stateAfterRef) : null
  const planBlob = tx.planRef ? journal.readBlob(tx.planRef) : null

  if (!request) {
    return {
      operation: tx.operation,
      status: 'not-identifiable',
      identifiable: false,
      reason: 'missing-request-blob',
    }
  }

  if (tx.kind === 'visit') {
    if (!stateAfter) {
      return {
        operation: tx.operation,
        kind: 'visit',
        status: 'not-identifiable',
        identifiable: false,
        reason: 'missing-state-after-for-visit',
      }
    }
    const vBody = response?.body
    if (!vBody || typeof vBody.ok !== 'boolean') {
      return {
        operation: tx.operation,
        kind: 'visit',
        status: 'unverified-external-visit',
        identifiable: false,
        reason: 'missing-visit-receipt-for-conservation-check',
      }
    }
    const visitDrifts = []
    const evalVisitSec = Number(stateAfter.now ?? stateBefore.now ?? 0)
    const refreshedBefore = adapter.advanceTimeOnly(stateBefore, evalVisitSec)
    const expectedVisitCoins = Number(stateBefore.coins || 0) - Number(vBody.fine || 0) + Number(vBody.earn || 0)
    if (Number(stateAfter.coins) !== expectedVisitCoins) {
      visitDrifts.push({ field: 'visit.coins', expected: expectedVisitCoins, server: stateAfter.coins })
    }
    const explicitCost = vBody.energyCost ?? vBody.cost ?? (vBody.ok ? request.expectedEnergyCost : 0)
    if (Number.isFinite(explicitCost)) {
      const expectedVisitEn = Math.max(0, Number(refreshedBefore.state?.en || 0) - Number(explicitCost))
      if (Number(stateAfter.state?.en) !== expectedVisitEn) {
        visitDrifts.push({ field: 'visit.en', expected: expectedVisitEn, server: stateAfter.state?.en })
      }
    }
    const expectedVisitWorld = adapter.cloneWorld(refreshedBefore)
    if (Array.isArray(vBody.got)) {
      for (const g of vBody.got) {
        if (!g?.id || !(g.n > 0)) continue
        expectedVisitWorld.state.inv[g.id] ||= [0, 0, 0]
        expectedVisitWorld.state.inv[g.id][g.q || 0] += Number(g.n)
      }
    } else if (vBody.loot && typeof vBody.loot === 'object') {
      for (const [id, qty] of Object.entries(vBody.loot)) {
        if (!(Number(qty) > 0)) continue
        expectedVisitWorld.state.inv[id] ||= [0, 0, 0]
        expectedVisitWorld.state.inv[id][0] += Number(qty)
      }
    }
    if (vBody.got !== undefined || vBody.loot !== undefined || vBody.ok === false) {
      const expInv = JSON.stringify(adapter.availableInvSnapshot(expectedVisitWorld.state))
      const srvInv = JSON.stringify(adapter.availableInvSnapshot(stateAfter.state))
      if (expInv !== srvInv) {
        visitDrifts.push({ field: 'visit.availableInv', expected: JSON.parse(expInv), server: JSON.parse(srvInv) })
      }
    } else {
      return {
        operation: tx.operation,
        kind: 'visit',
        status: 'unverified-external-visit',
        identifiable: false,
        reason: 'visit-receipt-missing-loot-breakdown',
      }
    }
    return {
      operation: tx.operation,
      kind: 'visit',
      status: visitDrifts.length > 0 ? 'model-drift' : 'consistent-external-visit',
      identifiable: true,
      serverDrifts: visitDrifts,
    }
  }

  if (tx.kind === 'xian-act') {
    const xianActions = Array.isArray(request.actions) ? request.actions : []
    const isXsName = (name) => /^xs[A-Z]/.test(name) && Object.hasOwn(XS_COST, name[2].toLowerCase() + name.slice(3))
    const isLegacyXianName = (name) => name.startsWith('xian')
    const hasXs = xianActions.some((act) => isXsName(String(act?.a || '')))
    const hasLegacy = xianActions.some((act) => isLegacyXianName(String(act?.a || '')))
    const nonXian = xianActions
      .map((act, index) => {
        const name = String(act?.a || '')
        if (hasXs && hasLegacy) return { index, action: act, msg: 'mixed-xs-and-legacy-xian-actions' }
        if (!isXsName(name) && !isLegacyXianName(name)) return { index, action: act, msg: 'non-xian-action' }
        return null
      })
      .filter(Boolean)
    if (nonXian.length > 0) {
      return {
        operation: tx.operation,
        kind: 'xian-act',
        status: 'illegal-action-in-batch',
        identifiable: true,
        rejectedSimIndices: nonXian,
        serverDrifts: [],
      }
    }
    if (tx.status !== 'confirmed') {
      return {
        operation: tx.operation,
        kind: 'xian-act',
        status: 'clean-rejected-xian',
        identifiable: true,
        serverDrifts: [],
      }
    }
    const srvBody = response?.body || response
    if (!stateAfter && !srvBody) {
      return {
        operation: tx.operation,
        kind: 'xian-act',
        status: 'not-identifiable',
        identifiable: false,
        reason: 'confirmed-xian-tx-missing-both-response-and-state-after',
      }
    }
    const outRows = Array.isArray(srvBody?.out) ? srvBody.out : []
    const failedServerIndices = outRows
      .map((o, index) => (o && o.ok === false ? { index, action: xianActions[index], msg: o.msg || 'server-rejected' } : null))
      .filter(Boolean)
    if (failedServerIndices.length > 0) {
      return {
        operation: tx.operation,
        kind: 'xian-act',
        status: 'illegal-action-in-batch',
        identifiable: true,
        rejectedSimIndices: failedServerIndices,
        serverDrifts: [],
      }
    }
    const xianDrifts = []
    if (stateAfter) {
      const evalXianSec = Number(stateAfter.now ?? stateBefore.now ?? 0)
      const refreshedBefore = adapter.advanceTimeOnly(stateBefore, evalXianSec)
      if (Number(stateAfter.state?.en) !== Number(refreshedBefore.state?.en)) {
        xianDrifts.push({ field: 'xian.en', expected: refreshedBefore.state?.en, server: stateAfter.state?.en })
      }
      const totalSpend = hasXs
        ? 0
        : (Number.isFinite(srvBody?.spend)
            ? Number(srvBody.spend)
            : outRows.reduce((s, r) => s + (r?.ok ? Number(r.spend || 0) : 0), 0))
      const expectedCoins = Number(stateBefore.coins || 0) - totalSpend
      if (Number(stateAfter.coins) !== expectedCoins) {
        xianDrifts.push({ field: 'xian.coins', expected: expectedCoins, server: stateAfter.coins })
      }
      const expInv = JSON.stringify(adapter.availableInvSnapshot(refreshedBefore.state))
      const srvInv = JSON.stringify(adapter.availableInvSnapshot(stateAfter.state))
      if (expInv !== srvInv) {
        xianDrifts.push({ field: 'xian.availableInv', expected: JSON.parse(expInv), server: JSON.parse(srvInv) })
      }

      const hasStochasticXs = xianActions.some((a) => ['xsBreak', 'xsFuse', 'xsRoot', 'xsTasks', 'xsEvroll'].includes(String(a?.a || '')))
      const execSec = Number(srvBody?.now ?? stateAfter.now ?? stateBefore.now ?? 0)
      if (
        hasXs &&
        !hasStochasticXs &&
        stateBefore.state?.xs?.v &&
        stateAfter.state?.xs?.v &&
        Number(stateAfter.now) === execSec
      ) {
        const simXs = structuredClone(stateBefore.state.xs)
        const rejectedXsIndices = []
        xianActions.forEach((wireAct, index) => {
          const short = wireAct.a[2].toLowerCase() + wireAct.a.slice(3)
          const internal = { a: short }
          if (wireAct.i != null) internal.i = wireAct.i
          if (wireAct.herb != null) internal.herb = wireAct.herb
          if (wireAct.n != null) internal.n = wireAct.n
          if (wireAct.el != null) internal.el = wireAct.el
          const r = xsAct(simXs, internal, execSec)
          if (!r?.ok) rejectedXsIndices.push({ index, action: wireAct, msg: r?.msg || 'xs-sim-failed' })
        })
        if (rejectedXsIndices.length > 0) {
          return {
            operation: tx.operation,
            kind: 'xian-act',
            status: 'illegal-action-in-batch',
            identifiable: true,
            rejectedSimIndices: rejectedXsIndices,
            serverDrifts: [],
          }
        }
        for (const k of ['log', 'stone', 'en', 'lv', 'xp']) {
          if (Number(stateAfter.state.xs[k]) !== Number(simXs[k])) {
            xianDrifts.push({ field: `xs.${k}`, expected: simXs[k], server: stateAfter.state.xs[k] })
          }
        }
      }
    }
    return {
      operation: tx.operation,
      kind: 'xian-act',
      status: xianDrifts.length > 0 ? 'model-drift' : 'consistent-external-xian',
      identifiable: true,
      serverDrifts: xianDrifts,
    }
  }

  const actions = Array.isArray(request.actions) ? request.actions : []
  const evalSec = Number(stateAfter?.now ?? stateBefore.now ?? 0)
  const hasStochastic = actions.some((a) => adapter.isStochasticAction(a))

  const sim = adapter.simulateBatch(stateBefore, actions, {
    t: evalSec,
    prices: stateBefore.prices || {},
  })

  const rejectedSimIndices = []
  ;(sim.result.out || []).forEach((o, idx) => {
    if (!o || o.ok !== true) {
      rejectedSimIndices.push({ index: idx, action: actions[idx], msg: o?.msg || 'failed' })
    }
  })

  // Check if planner's claimed `expectedAfterCoins` or `expectedAfterInv` in `planBlob` violated mechanical rules!
  const plannerShadowViolations = []
  if (planBlob && !hasStochastic) {
    if (
      Number.isFinite(planBlob.claimedCoinsAfterBatch) &&
      Math.round(planBlob.claimedCoinsAfterBatch) !== Math.round(sim.afterWorld.coins)
    ) {
      plannerShadowViolations.push({
        field: 'claimedCoinsAfterBatch',
        claimed: planBlob.claimedCoinsAfterBatch,
        actualRuleValue: sim.afterWorld.coins,
      })
    }
    if (planBlob.claimedInvAfterBatch && typeof planBlob.claimedInvAfterBatch === 'object') {
      const actualAvail = adapter.availableInvSnapshot(sim.afterWorld.state)
      for (const [id, qRow] of Object.entries(planBlob.claimedInvAfterBatch)) {
        const realRow = actualAvail[id] || [0, 0, 0]
        for (let q = 0; q < 3; q++) {
          if (Number(qRow[q] || 0) !== Number(realRow[q] || 0)) {
            plannerShadowViolations.push({
              field: `claimedInvAfterBatch.${id}[${q}]`,
              claimed: Number(qRow[q] || 0),
              actualRuleValue: Number(realRow[q] || 0),
            })
          }
        }
      }
    }
  }

  // Compare against real server receipt & stateAfter if confirmed
  const serverDrifts = []
  if (tx.status === 'confirmed') {
    const srvBody = response?.body || response
    if (!stateAfter && !srvBody) {
      return {
        operation: tx.operation,
        status: 'not-identifiable',
        identifiable: false,
        reason: 'confirmed-tx-missing-both-response-and-state-after',
      }
    }

    const srvOut = srvBody?.out
    if (Array.isArray(srvOut) && srvOut.length === sim.result.out.length && !hasStochastic) {
      for (let i = 0; i < srvOut.length; i++) {
        if (Boolean(srvOut[i]?.ok) !== Boolean(sim.result.out[i]?.ok)) {
          serverDrifts.push({
            field: `out[${i}].ok`,
            simulated: sim.result.out[i]?.ok,
            server: srvOut[i]?.ok,
          })
        }
      }
    }

    if (stateAfter && !hasStochastic) {
      if (Number(sim.afterWorld.coins) !== Number(stateAfter.coins)) {
        serverDrifts.push({
          field: 'coins',
          simulated: sim.afterWorld.coins,
          server: stateAfter.coins,
        })
      }
      if (Number(sim.afterWorld.state?.en) !== Number(stateAfter.state?.en)) {
        serverDrifts.push({
          field: 'state.en',
          simulated: sim.afterWorld.state?.en,
          server: stateAfter.state?.en,
        })
      }
      const simInv = JSON.stringify(adapter.availableInvSnapshot(sim.afterWorld.state))
      const srvInv = JSON.stringify(adapter.availableInvSnapshot(stateAfter.state))
      if (simInv !== srvInv) {
        serverDrifts.push({
          field: 'availableInv',
          simulated: JSON.parse(simInv),
          server: JSON.parse(srvInv),
        })
      }
    } else if (stateAfter && hasStochastic) {
      if (!Array.isArray(srvOut) || srvOut.length !== actions.length) {
        return {
          operation: tx.operation,
          kind: tx.kind || 'act',
          status: 'not-identifiable',
          identifiable: false,
          reason: 'stochastic-batch-missing-per-action-receipt-out',
        }
      }
      // Receipt-conditioned physical conservation check across coins, availableInv, stamina, and daily quotas!
      const srvSpend = Number(srvBody?.spend ?? srvOut.reduce((s, o) => s + (o?.spend || 0), 0))
      const srvEarn = Number(srvBody?.earn ?? srvOut.reduce((s, o) => s + (o?.earn || 0), 0))
      const expectedCoins = Number(stateBefore.coins || 0) - srvSpend + srvEarn
      if (Number(stateAfter.coins) !== expectedCoins) {
        serverDrifts.push({
          field: 'stochasticBatchCoinsConservation',
          expectedFromReceipt: expectedCoins,
          server: stateAfter.coins,
        })
      }

      // Discover utility tokens dynamically from R (zero hardcoded item IDs)
      const { R, graph } = adapter
      const explosiveId = (R.RECIPES || []).find((r) => !(Number(r.price) > 0))?.id
        || Object.keys(R.SHOP || {}).find((id) => R.WORLD?.daily?.[id] != null)
        || null
      let feedId = null
      if (typeof R.newWorld === 'function') {
        const sample = R.newWorld(R.ISLE_LAUNCH || 0)
        feedId = Object.keys(sample?.inv || {}).find((id) => !graph.cropsById.has(id)) || null
      }
      const baitId = Object.keys(R.SHOP || {}).find((id) => id !== feedId && id !== explosiveId) || null

      let condWorld = adapter.advanceTimeOnly(stateBefore, evalSec, { futurePrices: stateBefore.prices || {} })
      const isleIdx = R.isleIndex(evalSec)
      if (condWorld.state.iq?.d !== isleIdx) {
        condWorld.state.iq = { d: isleIdx }
      }

      for (let i = 0; i < actions.length; i++) {
        const act = actions[i]
        const recOut = srvOut[i]
        if (!recOut || recOut.ok !== true) continue
        if (!adapter.isStochasticAction(act)) {
          condWorld = adapter.simulateBatch(condWorld, [act], {
            t: evalSec,
            prices: stateBefore.prices || {},
          }).afterWorld
          continue
        }
        // Apply deterministic input consumption, stamina cost, quota increment, and receipt `got` outputs!
        const enCost = Number(R.WORLD?.cost?.[act.a] || 0)
        condWorld.state.en = Math.max(0, Number(condWorld.state.en || 0) - enCost + Number(recOut.energy || 0))
        if (act.a === 'fish' || act.a === 'mine' || act.a === 'bomb') {
          condWorld.state.iq[act.a] = Number(condWorld.state.iq[act.a] || 0) + 1
        }
        if (act.a === 'bomb' && explosiveId && adapter.availableInv(condWorld.state, explosiveId, 0) > 0) {
          condWorld.state.inv[explosiveId][0] -= 1
        }
        if (act.a === 'fish' && act.bait && baitId && adapter.availableInv(condWorld.state, baitId, 0) > 0) {
          condWorld.state.inv[baitId][0] -= 1
        }
        if (Array.isArray(recOut.got)) {
          for (const g of recOut.got) {
            if (Array.isArray(g)) {
              const [id, n] = g
              if (!id || !(Number(n) > 0)) continue
              condWorld.state.inv[id] ||= [0, 0, 0]
              condWorld.state.inv[id][0] += Number(n)
            } else if (g?.id && Number(g.n) > 0) {
              const q = Math.max(0, Math.min(2, Math.floor(Number(g.q || 0))))
              condWorld.state.inv[g.id] ||= [0, 0, 0]
              condWorld.state.inv[g.id][q] += Number(g.n)
            }
          }
        } else if (recOut.got && typeof recOut.got === 'object') {
          for (const [id, n] of Object.entries(recOut.got)) {
            if (!id || !(Number(n) > 0)) continue
            condWorld.state.inv[id] ||= [0, 0, 0]
            condWorld.state.inv[id][0] += Number(n)
          }
        }
      }

      if (Number(condWorld.state?.en) !== Number(stateAfter.state?.en)) {
        serverDrifts.push({
          field: 'stochasticBatch.state.en',
          expectedFromReceipt: condWorld.state?.en,
          server: stateAfter.state?.en,
        })
      }
      const expInv = JSON.stringify(adapter.availableInvSnapshot(condWorld.state))
      const srvInv = JSON.stringify(adapter.availableInvSnapshot(stateAfter.state))
      if (expInv !== srvInv) {
        serverDrifts.push({
          field: 'stochasticBatch.availableInv',
          expectedFromReceipt: JSON.parse(expInv),
          server: JSON.parse(srvInv),
        })
      }
      for (const qk of ['fish', 'mine', 'bomb', 'craft']) {
        const expQ = condWorld.state?.iq?.d === stateAfter.state?.iq?.d ? Number(condWorld.state?.iq?.[qk] || 0) : null
        if (expQ != null && expQ !== Number(stateAfter.state?.iq?.[qk] || 0)) {
          serverDrifts.push({
            field: `stochasticBatch.iq.${qk}`,
            expectedFromReceipt: expQ,
            server: Number(stateAfter.state?.iq?.[qk] || 0),
          })
        }
      }
    }
  }

  let status = 'consistent'
  if (serverDrifts.length > 0) status = 'model-drift'
  else if (plannerShadowViolations.length > 0) status = 'shadow-conservation-violation'
  else if (rejectedSimIndices.length > 0) status = 'illegal-action-in-batch'

  return {
    operation: tx.operation,
    kind: tx.kind || 'act',
    status,
    verdict: status,
    identifiable: true,
    hasStochastic,
    receiptStateConservationOk: serverDrifts.length === 0,
    actionCount: actions.length,
    rejectedSimIndices,
    plannerShadowViolations,
    serverDrifts,
  }
}

export async function auditJournalReplayAll(journal, { fallbackAdapter = null } = {}) {
  const { transactions, waitDecisions, coverage } = journal.reconstructTransactions()
  const results = []
  for (const tx of transactions) {
    if (tx.status === 'aborted-before-send') continue
    results.push(await auditTransactionReplay(journal, tx, { fallbackAdapter }))
  }
  return {
    coverage,
    waitCount: waitDecisions.length,
    results,
    modelDriftCount: results.filter((r) => r.status === 'model-drift').length,
    shadowViolationCount: results.filter((r) => r.status === 'shadow-conservation-violation').length,
    illegalActionBatchCount: results.filter((r) => r.status === 'illegal-action-in-batch').length,
    notIdentifiableCount: results.filter((r) => r.status === 'not-identifiable').length,
  }
}
