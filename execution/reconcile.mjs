import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeWorldSnapshot } from '../model/observations.mjs'

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withAccountLock(lockRootDir, account, fn, { timeoutMs = 15000, retryMs = 20 } = {}) {
  fs.mkdirSync(lockRootDir, { recursive: true })
  const lockFile = path.join(lockRootDir, `.kernel.${account}.lock`)
  const gateFile = `${lockFile}.gate`
  const deadline = Date.now() + timeoutMs
  let acquired = false

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
      fs.closeSync(fd)
      acquired = true
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      // Gate-serialized dead-PID recovery so two processes never unlink a newly created live lock
      try {
        const gfd = fs.openSync(gateFile, 'wx')
        try {
          const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
          if (raw && !isProcessAlive(raw.pid)) {
            fs.unlinkSync(lockFile)
          }
        } catch {} finally {
          fs.closeSync(gfd)
          try { fs.unlinkSync(gateFile) } catch {}
        }
      } catch {}
      await sleepMs(retryMs)
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire account lock for ${account} within ${timeoutMs}ms`)
  }

  try {
    return await fn()
  } finally {
    try { fs.unlinkSync(lockFile) } catch {}
  }
}

/**
 * Recovers crashed pre-send reservations and expands cross-isle-day `unknown` spans:
 * - `reserved-and-durable` (process crashed before `submitted` was written): safely marked `aborted-before-send`.
 * - `submitted` without receipt: promoted to `unknown` and its `possibleIsleIndices` conservatively spans
 *   all isle indices from `sentIsleIdx` through `currentIsleIdx` until explicitly reconciled.
 */
export function recoverPendingTransactions(journal, adapter, currentServerNow) {
  const { transactions } = journal.reconstructTransactions()
  const curIsleIdx = Number.isFinite(currentServerNow) ? adapter.R.isleIndex(currentServerNow) : null
  const summary = { abortedPreSend: 0, activeUnknown: 0 }

  for (const tx of transactions) {
    if (tx.status === 'reserved-and-durable') {
      journal.appendEvent({
        recordType: 'tx-transition',
        operation: tx.operation,
        decisionId: tx.decisionId,
        kind: tx.kind,
        status: 'aborted-before-send',
        reason: 'recovered-unsubmitted-reservation',
      })
      summary.abortedPreSend++
    } else if (tx.status === 'submitted' || tx.status === 'unknown') {
      const indices = new Set(tx.possibleIsleIndices || [])
      if (curIsleIdx != null && indices.size > 0) {
        const minIdx = Math.min(...indices)
        for (let d = minIdx; d <= Math.max(minIdx, curIsleIdx); d++) indices.add(d)
      } else if (curIsleIdx != null) {
        indices.add(curIsleIdx)
      }
      journal.appendEvent({
        recordType: 'tx-transition',
        operation: tx.operation,
        decisionId: tx.decisionId,
        kind: tx.kind,
        status: 'unknown',
        possibleIsleIndices: [...indices].sort((a, b) => a - b),
      })
      summary.activeUnknown++
    }
  }
  return summary
}

/**
 * Explicitly reconciles unresolved `unknown` transactions against a newly fetched server snapshot
 * before allowing further resource-mutating actions on the same state.
 *
 * Strictly separates world-resource re-anchoring from operation outcome attribution:
 * - If an explicit operation receipt (`receiptsByOperation[tx.operation]`) is available, confirms or rejects `tx`.
 * - If `tx.kind === 'act'` and server clock strictly advanced (`freshWorld.now > tx.serverNow`) while `rev` NEVER
 *   incremented (`freshWorld.rev <= tx.revBefore`), proves no `act` mutation occurred -> `status: 'rejected'`.
 * - Otherwise (e.g. `freshWorld.rev > tx.revBefore` without operation receipt, or non-`rev` endpoint like `visit`),
 *   re-anchors world resources (`stateAfterRef`) so fresh planning is unblocked, while keeping `status: 'unknown-state-reanchored'`
 *   (never falsely attributing a global `rev` bump to `tx.operation`, and keeping `possibleIsleIndices` quota occupied!).
 */
export function reconcileUnknownWithFreshWorld(
  journal,
  adapter,
  freshWorld,
  {
    receiptsByOperation = null,
    visitSilenceWindowSec = 25,
    onReconciledVisitFn = null,
  } = {}
) {
  if (!freshWorld || typeof freshWorld !== 'object') return { reconciled: 0, remainingUnknown: 0 }
  adapter.syncClock(freshWorld.clockStart)
  const { transactions } = journal.reconstructTransactions()
  const stateRef = journal.writeBlob(sanitizeWorldSnapshot(freshWorld))
  let reconciled = 0
  let remainingUnknown = 0
  let remainingNonVisitUnknown = 0
  let inFlightVisitEnergyReserved = 0
  let inFlightVisitFineReserved = 0

  for (const tx of transactions) {
    if (tx.status !== 'unknown' && tx.status !== 'submitted') continue

    // 1) Explicit operation receipt evidence takes priority
    if (receiptsByOperation && Object.hasOwn(receiptsByOperation, tx.operation)) {
      const rec = receiptsByOperation[tx.operation]
      const responseRef = journal.writeBlob(rec)
      const isOk = rec?.ok !== false
      const settledIdx = freshWorld.now != null ? adapter.R.isleIndex(freshWorld.now) : (tx.possibleIsleIndices?.[0] ?? 0)
      journal.appendEvent({
        recordType: 'tx-transition',
        operation: tx.operation,
        decisionId: tx.decisionId,
        kind: tx.kind,
        status: isOk ? 'confirmed' : 'rejected',
        reconciledFromUnknown: true,
        reconcileOutcome: 'explicit-operation-receipt',
        revAfter: freshWorld.rev ?? null,
        responseRef,
        stateAfterRef: stateRef,
        possibleIsleIndices: isOk ? [settledIdx] : [],
      })
      reconciled++
      continue
    }

    if (tx.kind === 'act' && tx.revBefore != null && freshWorld.rev != null) {
      if (freshWorld.rev <= tx.revBefore && tx.serverNow != null && freshWorld.now != null && freshWorld.now <= tx.serverNow) {
        // Stale or same-second snapshot cannot prove an in-flight request failed; keep unknown until server clock advances
        remainingUnknown++
        remainingNonVisitUnknown++
        continue
      }
      if (freshWorld.rev <= tx.revBefore) {
        journal.appendEvent({
          recordType: 'tx-transition',
          operation: tx.operation,
          decisionId: tx.decisionId,
          kind: tx.kind,
          status: 'rejected',
          reconciledFromUnknown: true,
          reconcileOutcome: 'reconciled-rev-unchanged',
          revAfter: freshWorld.rev,
          stateAfterRef: stateRef,
          possibleIsleIndices: [],
        })
        reconciled++
      } else {
        // Global `rev` advanced, but without an operation receipt we cannot attribute that `rev` bump to THIS operation!
        // Re-anchor world resources (`stateAfterRef`) while preserving `unknown-state-reanchored` and conservative quota occupation.
        const curIsleIdx = freshWorld.now != null ? adapter.R.isleIndex(freshWorld.now) : null
        const indices = new Set(tx.possibleIsleIndices || [])
        if (curIsleIdx != null && indices.size > 0) {
          const minIdx = Math.min(...indices)
          for (let d = minIdx; d <= Math.max(minIdx, curIsleIdx); d++) indices.add(d)
        }
        journal.appendEvent({
          recordType: 'tx-transition',
          operation: tx.operation,
          decisionId: tx.decisionId,
          kind: tx.kind,
          status: 'unknown-state-reanchored',
          reconciledFromUnknown: true,
          reconcileOutcome: 'global-rev-advanced-unattributed',
          revAfter: freshWorld.rev,
          stateAfterRef: stateRef,
          possibleIsleIndices: [...indices].sort((a, b) => a - b),
        })
        reconciled++
      }
      continue
    }

    // 2) Deterministic same-day `visit` reconciliation via server `state.cnt['st' + targetId]` & `state.cnt.steal`!
    //    Eliminates permanent `visit:unknown` deadlocks when `POST /api/pet/world/visit/:id` times out in transit:
    //    - Same `state.day` & `cnt['st' + targetId]` incremented -> PROVEN `confirmed` (with `inferredVisitOutcome` so loss circuit-breaker fires!).
    //    - Same `state.day` & `cnt['st' + targetId]` unchanged after `visitSilenceWindowSec` -> PROVEN `rejected` (frees steal budget!).
    //    - Cross-midnight (`state.day` changed and `cnt` reset) -> safe `unknown-state-reanchored` (never falsely rejects!).
    if (tx.kind === 'visit') {
      const beforeWorld = tx.stateBeforeRef ? journal.readBlob(tx.stateBeforeRef) : null
      const reqObj = tx.requestRef ? journal.readBlob(tx.requestRef) : null
      const targetId = reqObj?.targetId ?? null
      const beforeDay = beforeWorld?.state?.day ?? (tx.serverNow != null ? adapter.R.worldDay(tx.serverNow) : null)
      const afterDay = freshWorld?.state?.day ?? (freshWorld?.now != null ? adapter.R.worldDay(freshWorld.now) : null)

      if (beforeWorld && targetId != null && beforeDay != null && afterDay === beforeDay) {
        const stKey = `st${targetId}`
        const stBefore = Number(beforeWorld.state?.cnt?.[stKey] || 0)
        const stAfter = Number(freshWorld.state?.cnt?.[stKey] || 0)
        if (stAfter > stBefore) {
          const settledIdx = freshWorld.now != null ? adapter.R.isleIndex(freshWorld.now) : (tx.possibleIsleIndices?.[0] ?? 0)
          const coinDelta = Number(freshWorld.coins || 0) - Number(beforeWorld.coins || 0)
          const inferredVisitOutcome = coinDelta < 0 ? 'lose' : 'executed'
          const synthReceipt = journal.writeBlob({
            reconciledFromCounter: true,
            targetId,
            counterKey: stKey,
            counterBefore: stBefore,
            counterAfter: stAfter,
            inferredVisitOutcome,
            inferredCoinDelta: coinDelta,
          })
          journal.appendEvent({
            recordType: 'tx-transition',
            operation: tx.operation,
            decisionId: tx.decisionId,
            kind: tx.kind,
            status: 'confirmed',
            reconciledFromUnknown: true,
            reconcileOutcome: 'reconciled-visit-counter-incremented',
            inferredVisitOutcome,
            inferredCoinDelta: coinDelta,
            revAfter: freshWorld.rev ?? null,
            responseRef: synthReceipt,
            stateAfterRef: stateRef,
            possibleIsleIndices: [settledIdx],
          })
          if (typeof onReconciledVisitFn === 'function') {
            try {
              onReconciledVisitFn({
                tx,
                targetId,
                status: 'confirmed',
                inferredVisitOutcome,
                inferredCoinDelta: coinDelta,
                beforeWorld,
                freshWorld,
              })
            } catch {}
          }
          reconciled++
          continue
        }

        const wallSentMs = tx.localSentAt ? Date.parse(tx.localSentAt) : NaN
        const wallElapsedSec = Number.isFinite(wallSentMs) ? Math.max(0, (Date.now() - wallSentMs) / 1000) : 0
        const elapsedSec = (freshWorld.now != null && tx.serverNow != null)
          ? (Number(freshWorld.now) - Number(tx.serverNow))
          : wallElapsedSec
        if (elapsedSec < visitSilenceWindowSec) {
          remainingUnknown++
          inFlightVisitEnergyReserved += Math.min(15, Math.max(6, Number(reqObj?.expectedEnergyCost || 15)))
          inFlightVisitFineReserved += 5000
          continue
        }

        // If `rev` advanced while `st<targetId>` stayed unchanged (e.g. external mutation or rare guard `draw`),
        // re-anchor state safely without falsely rejecting!
        if (tx.revBefore != null && freshWorld.rev != null && Number(freshWorld.rev) > Number(tx.revBefore)) {
          const curIsleIdx = freshWorld.now != null ? adapter.R.isleIndex(freshWorld.now) : null
          const indices = new Set(tx.possibleIsleIndices || [])
          if (curIsleIdx != null && indices.size > 0) {
            const minIdx = Math.min(...indices)
            for (let d = minIdx; d <= Math.max(minIdx, curIsleIdx); d++) indices.add(d)
          }
          journal.appendEvent({
            recordType: 'tx-transition',
            operation: tx.operation,
            decisionId: tx.decisionId,
            kind: tx.kind,
            status: 'unknown-state-reanchored',
            reconciledFromUnknown: true,
            reconcileOutcome: 'visit-rev-advanced-counter-unchanged',
            revAfter: freshWorld.rev,
            stateAfterRef: stateRef,
            possibleIsleIndices: [...indices].sort((a, b) => a - b),
          })
          reconciled++
          continue
        }

        journal.appendEvent({
          recordType: 'tx-transition',
          operation: tx.operation,
          decisionId: tx.decisionId,
          kind: tx.kind,
          status: 'rejected',
          reconciledFromUnknown: true,
          reconcileOutcome: 'reconciled-visit-counter-unchanged',
          revAfter: freshWorld.rev ?? null,
          stateAfterRef: stateRef,
          possibleIsleIndices: [],
        })
        if (typeof onReconciledVisitFn === 'function') {
          try {
            onReconciledVisitFn({
              tx,
              targetId,
              status: 'rejected',
              inferredVisitOutcome: 'not-executed',
              inferredCoinDelta: 0,
              beforeWorld,
              freshWorld,
            })
          } catch {}
        }
        reconciled++
        continue
      }
    }

    if (freshWorld.now != null && tx.serverNow != null && freshWorld.now > tx.serverNow) {
      // Non-rev endpoints without same-day counter proof (e.g. `help`, or cross-midnight `visit`):
      // state resources (`en`/`inv`/`coins`) are re-anchored by `freshWorld`, while quota budget remains conservatively occupied!
      const curIsleIdx = adapter.R.isleIndex(freshWorld.now)
      const indices = new Set(tx.possibleIsleIndices || [])
      if (indices.size > 0) {
        const minIdx = Math.min(...indices)
        for (let d = minIdx; d <= Math.max(minIdx, curIsleIdx); d++) indices.add(d)
      }
      journal.appendEvent({
        recordType: 'tx-transition',
        operation: tx.operation,
        decisionId: tx.decisionId,
        kind: tx.kind,
        status: 'unknown-state-reanchored',
        reconcileOutcome: 'non-rev-endpoint-state-reanchored',
        stateAfterRef: stateRef,
        possibleIsleIndices: [...indices].sort((a, b) => a - b),
      })
      reconciled++
    } else {
      remainingUnknown++
      if (tx.kind !== 'visit') remainingNonVisitUnknown++
    }
  }
  return {
    reconciled,
    remainingUnknown,
    remainingNonVisitUnknown,
    inFlightVisitEnergyReserved,
    inFlightVisitFineReserved,
  }
}

function worldPrestateMatches(plannedWorld, liveWorld) {
  if (!plannedWorld || !liveWorld) return false
  if (plannedWorld.rev != null && liveWorld.rev != null && Number(plannedWorld.rev) !== Number(liveWorld.rev)) {
    return false
  }
  if (Number(plannedWorld.coins || 0) !== Number(liveWorld.coins || 0)) {
    return false
  }
  if (Number(plannedWorld.state?.en || 0) !== Number(liveWorld.state?.en || 0)) {
    return false
  }
  if (JSON.stringify(plannedWorld.prices || {}) !== JSON.stringify(liveWorld.prices || {})) {
    return false
  }
  if (JSON.stringify(plannedWorld.state?.iq || {}) !== JSON.stringify(liveWorld.state?.iq || {})) {
    return false
  }
  return true
}

/**
 * Executes a single side-effect transaction under cross-process account lock with strict state boundaries:
 * `planned -> reserved-and-durable -> submitted -> confirmed | rejected | unknown | stale-prestate-aborted`
 * Enforces authoritative in-lock pre-state verification so stale plans never spend resources after a concurrent mutation.
 */
export async function executeTransaction({
  journal,
  adapter,
  lockRootDir,
  alreadyLocked = false,
  account = journal.account,
  decisionId = crypto.randomUUID(),
  operation = crypto.randomUUID(),
  kind = 'act',
  budgetKind = null,
  budgetLimitPerIsleDay = null,
  nearIsleBoundaryBufferSec = 90,
  worldBefore,
  envelope = null,
  objectiveCfg = null,
  planSummary = null,
  objectiveHash = null,
  constraintsHash = null,
  requestPayload,
  waitBeforeSendFn = null,
  sendFn,
  onReceiptFn = null,
  verifyLiveWorldFn = null,
  fetchAfterWorldFn = null,
}) {
  if (adapter.rulesSourceText) {
    journal.archiveRulesSource(adapter.rulesHash, adapter.rulesSourceText)
  }

  const runInCriticalSection = async () => {
    const nowSec = Number(worldBefore?.now || 0)
    adapter.syncClock(worldBefore?.clockStart)
    const pendingSummary = recoverPendingTransactions(journal, adapter, nowSec)
    const reconstructed = journal.reconstructTransactions()
    const existing = reconstructed.txMap.get(operation)
    if (!existing && pendingSummary.activeUnknown > 0) {
      const unresolvedTxs = reconstructed.transactions
        .filter((t) => t.status === 'unknown' || t.status === 'submitted')
      // Domestic `act` (harvesting/planting/crafting) is ONLY blocked by unresolved `act`/non-visit mutations,
      // NEVER by an in-flight `visit:unknown` (eliminates the 08:21 steal-blocks-harvest outage)!
      const blockingTxs = kind === 'act'
        ? unresolvedTxs.filter((t) => t.kind !== 'visit')
        : unresolvedTxs
      if (blockingTxs.length > 0) {
        return {
          status: 'blocked-pending-reconcile',
          operation,
          decisionId,
          unresolvedOperations: blockingTxs.map((t) => t.operation),
        }
      }
    }

    const curIsleIdx = adapter.R.isleIndex(nowSec)
    const nextBoundary = adapter.nextIsleBoundary(nowSec)
    const candidateIsleIndices = [curIsleIdx]
    if (nextBoundary - nowSec <= nearIsleBoundaryBufferSec) {
      candidateIsleIndices.push(curIsleIdx + 1)
    }

    // Budget reservation check runs before generic pre-state revision checks so budget-capped side-effect races
    // (`visit` steal/help) deterministically report `budget-exhausted` once quota is occupied!
    if (!existing && budgetKind && Number.isFinite(budgetLimitPerIsleDay)) {
      if (budgetLimitPerIsleDay <= 0) {
        return {
          status: 'budget-exhausted',
          operation,
          decisionId,
          usedBudget: 0,
          limit: budgetLimitPerIsleDay,
        }
      }
      for (const idx of candidateIsleIndices) {
        const used = journal.countOccupiedBudget(budgetKind, idx)
        if (used >= budgetLimitPerIsleDay) {
          return {
            status: 'budget-exhausted',
            operation,
            decisionId,
            usedBudget: used,
            limit: budgetLimitPerIsleDay,
            blockedIsleIndex: idx,
          }
        }
      }
    }

    // Authoritative In-Lock Pre-State Check #1: Journal causal version & mutation history!
    // If another transaction already confirmed or advanced `revAfter` past `worldBefore.rev` (or executed a side-effect
    // against the same `revBefore`), abort pre-send immediately before spending any coins/stamina!
    if (!existing) {
      let maxKnownRev = -Infinity
      let priorConfirmedOnSameRev = false
      for (const priorTx of reconstructed.transactions) {
        if (priorTx.status === 'rejected' || priorTx.status === 'aborted-before-send') continue
        if (priorTx.revAfter != null) maxKnownRev = Math.max(maxKnownRev, Number(priorTx.revAfter))
        if (
          worldBefore?.rev != null &&
          priorTx.revBefore != null &&
          Number(priorTx.revBefore) === Number(worldBefore.rev) &&
          priorTx.kind === 'act' &&
          priorTx.status === 'confirmed'
        ) {
          priorConfirmedOnSameRev = true
        }
      }
      if ((worldBefore?.rev != null && maxKnownRev > Number(worldBefore.rev)) || priorConfirmedOnSameRev) {
        journal.appendEvent({
          recordType: 'tx-transition',
          operation,
          decisionId,
          kind,
          status: 'aborted-before-send',
          reason: 'stale-prestate-journal-rev-advanced',
          revBefore: worldBefore?.rev ?? null,
          latestKnownRev: Number.isFinite(maxKnownRev) ? maxKnownRev : null,
        })
        return {
          status: 'stale-prestate-aborted',
          reason: 'journal-rev-advanced',
          operation,
          decisionId,
          plannedRev: worldBefore?.rev ?? null,
          latestKnownRev: Number.isFinite(maxKnownRev) ? maxKnownRev : null,
        }
      }
    }

    // Authoritative In-Lock Pre-State Check #2: Optional live server world re-verification inside lock!
    if (!existing && typeof verifyLiveWorldFn === 'function') {
      const liveWorld = await verifyLiveWorldFn()
      if (!worldPrestateMatches(worldBefore, liveWorld)) {
        journal.appendEvent({
          recordType: 'tx-transition',
          operation,
          decisionId,
          kind,
          status: 'aborted-before-send',
          reason: 'stale-prestate-live-mismatch',
          revBefore: worldBefore?.rev ?? null,
          liveRev: liveWorld?.rev ?? null,
        })
        return {
          status: 'stale-prestate-aborted',
          reason: 'live-world-prestate-mismatch',
          operation,
          decisionId,
          plannedRev: worldBefore?.rev ?? null,
          liveRev: liveWorld?.rev ?? null,
          liveWorld: liveWorld ? sanitizeWorldSnapshot(liveWorld) : null,
        }
      }
    }

    const stateBeforeRef = worldBefore ? journal.writeBlob(sanitizeWorldSnapshot(worldBefore)) : null
    const envelopeRef = envelope ? journal.writeBlob(envelope) : null
    const objectiveCfgRef = objectiveCfg ? journal.writeBlob(objectiveCfg) : null
    const planRef = planSummary ? journal.writeBlob(planSummary) : null
    const requestWithOp = {
      ...requestPayload,
      operation,
      expectedRev: worldBefore?.rev ?? null,
    }
    const requestRef = journal.writeBlob(requestWithOp)

    journal.appendEvent({
      recordType: 'tx-transition',
      operation,
      decisionId,
      kind,
      status: 'reserved-and-durable',
      serverNow: nowSec,
      revBefore: worldBefore?.rev ?? null,
      rulesHash: adapter.rulesHash,
      objectiveHash,
      constraintsHash,
      stateBeforeRef,
      envelopeRef,
      objectiveCfgRef,
      planRef,
      requestRef,
      budgetKind,
      possibleIsleIndices: candidateIsleIndices,
    })

    // Pre-Staged Exact-Unlock Hook: all blob hashing, pre-state validation & durable reservation I/O
    // are ALREADY flushed to disk BEFORE sleeping to `T_unlock + 25ms`, achieving <50ms post-unlock wire latency!
    if (typeof waitBeforeSendFn === 'function') {
      try {
        await waitBeforeSendFn({ operation, decisionId, request: requestWithOp })
      } catch (err) {
        journal.appendEvent({
          recordType: 'tx-transition',
          operation,
          decisionId,
          kind,
          status: 'aborted-before-send',
          reason: `wait-before-send-aborted:${err?.message || String(err)}`,
        })
        throw err
      }
    }

    const localSentAt = new Date().toISOString()
    journal.appendEvent({
      recordType: 'tx-transition',
      operation,
      decisionId,
      kind,
      status: 'submitted',
      localSentAt,
      possibleIsleIndices: candidateIsleIndices,
    })

    let transportRes = null
    try {
      transportRes = await sendFn({ operation, request: requestWithOp })
    } catch (err) {
      transportRes = { networkError: true, error: err?.message || String(err) }
    }
    const localReceivedAt = new Date().toISOString()

    if (!transportRes || transportRes.networkError || transportRes.status == null || transportRes.status >= 500) {
      // Persist raw transport failure/timeout receipt BEFORE attempting `fetchAfterWorldFn`!
      const responseRef = transportRes ? journal.writeBlob(transportRes) : null
      journal.appendEvent({
        recordType: 'tx-transition',
        operation,
        decisionId,
        kind,
        status: 'unknown',
        responseRef,
        stateAfterRef: null,
        possibleIsleIndices: [...candidateIsleIndices].sort((a, b) => a - b),
        provenance: { localSentAt, localReceivedAt },
      })

      let postWorld = null
      if (typeof fetchAfterWorldFn === 'function') {
        try { postWorld = await fetchAfterWorldFn() } catch {}
      }
      const postIsleIdx = postWorld?.now ? adapter.R.isleIndex(postWorld.now) : null
      if (postIsleIdx != null && postIsleIdx > curIsleIdx) {
        const unknownIndices = new Set(candidateIsleIndices)
        for (let d = curIsleIdx; d <= Math.max(curIsleIdx, postIsleIdx); d++) unknownIndices.add(d)
        journal.appendEvent({
          recordType: 'tx-transition',
          operation,
          decisionId,
          kind,
          status: 'unknown',
          possibleIsleIndices: [...unknownIndices].sort((a, b) => a - b),
        })
      }
      return {
        status: 'unknown',
        operation,
        decisionId,
        worldAfter: postWorld ? sanitizeWorldSnapshot(postWorld) : null,
        response: transportRes,
      }
    }

    const body = transportRes.body || {}
    const isRejected = transportRes.status >= 400 && transportRes.status < 500
      || (body.ok === false && (!Array.isArray(body.out) || body.out.every((o) => !o?.ok)))
    const finalStatus = isRejected ? 'rejected' : 'confirmed'

    // Persist HTTP receipt (`responseRef` + `finalStatus`) to journal FIRST, strictly BEFORE
    // `onReceiptFn` or `fetchAfterWorldFn` can throw, hang, or time out!
    const embeddedWorld = (body.world && body.world.state)
      ? sanitizeWorldSnapshot(body.world)
      : ((body.state && body.now != null) ? sanitizeWorldSnapshot(body) : null)
    const responseRef = journal.writeBlob({ status: transportRes.status, body })
    const initialStateAfterRef = embeddedWorld ? journal.writeBlob(embeddedWorld) : null
    const initialIsleIdx = embeddedWorld?.now ? adapter.R.isleIndex(embeddedWorld.now) : curIsleIdx

    journal.appendEvent({
      recordType: 'tx-transition',
      operation,
      decisionId,
      kind,
      status: finalStatus,
      revAfter: embeddedWorld?.rev ?? body.rev ?? null,
      responseRef,
      stateAfterRef: initialStateAfterRef,
      possibleIsleIndices: finalStatus === 'confirmed' ? [initialIsleIdx] : [],
      provenance: { localSentAt, localReceivedAt },
    })

    if (typeof onReceiptFn === 'function') {
      try {
        await onReceiptFn({
          status: finalStatus,
          httpStatus: transportRes.status,
          body,
          rawResp: transportRes,
          operation,
          decisionId,
          kind,
          request: requestWithOp,
        })
      } catch {}
    }

    let confirmedAfterWorld = embeddedWorld
    if (!confirmedAfterWorld && !isRejected && typeof fetchAfterWorldFn === 'function') {
      try {
        const fetched = await fetchAfterWorldFn()
        if (fetched) {
          confirmedAfterWorld = sanitizeWorldSnapshot(fetched)
          const settledIsleIdx = confirmedAfterWorld.now
            ? adapter.R.isleIndex(confirmedAfterWorld.now)
            : curIsleIdx
          const stateAfterRef = journal.writeBlob(confirmedAfterWorld)
          journal.appendEvent({
            recordType: 'tx-transition',
            operation,
            decisionId,
            kind,
            status: finalStatus,
            revAfter: confirmedAfterWorld.rev ?? body.rev ?? null,
            stateAfterRef,
            possibleIsleIndices: [settledIsleIdx],
          })
        }
      } catch {}
    }

    return {
      status: finalStatus,
      operation,
      decisionId,
      response: { status: transportRes.status, body },
      worldAfter: confirmedAfterWorld,
    }
  }

  if (alreadyLocked || !lockRootDir) {
    return runInCriticalSection()
  }
  return withAccountLock(lockRootDir, account, runInCriticalSection)
}
