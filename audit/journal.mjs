import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeWorldSnapshot } from '../model/observations.mjs'

export class ContentAddressedJournal {
  constructor({ rootDir, account = 'main' }) {
    if (!rootDir) throw new Error('Journal rootDir is required')
    this.rootDir = path.resolve(rootDir)
    this.account = String(account || 'main')
    this.accountDir = path.join(this.rootDir, this.account)
    this.blobsDir = path.join(this.accountDir, 'blobs')
    this.rulesDir = path.join(this.rootDir, 'rules-archive')
    this.logPath = path.join(this.accountDir, 'events.jsonl')
    fs.mkdirSync(this.blobsDir, { recursive: true })
    fs.mkdirSync(this.rulesDir, { recursive: true })
  }

  writeBlob(obj) {
    const clean = stripForbiddenFields(obj)
    const text = JSON.stringify(clean)
    const ref = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    const file = path.join(this.blobsDir, `${ref}.json`)
    if (!fs.existsSync(file)) {
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
    }
    return ref
  }

  readBlob(ref) {
    if (!ref || typeof ref !== 'string') return null
    const file = path.join(this.blobsDir, `${ref}.json`)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  archiveRulesSource(rulesHash, sourceText) {
    if (!rulesHash || typeof sourceText !== 'string' || !sourceText.length) return null
    const file = path.join(this.rulesDir, `${rulesHash}.js`)
    if (!fs.existsSync(file)) {
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
      fs.writeFileSync(tmp, sourceText, 'utf8')
      fs.renameSync(tmp, file)
    }
    return file
  }

  readArchivedRulesSource(rulesHash) {
    if (!rulesHash) return null
    const file = path.join(this.rulesDir, `${rulesHash}.js`)
    if (!fs.existsSync(file)) return null
    return fs.readFileSync(file, 'utf8')
  }

  appendEvent(record) {
    const clean = stripForbiddenFields({
      schemaVersion: 1,
      account: this.account,
      recordedAt: new Date().toISOString(),
      ...record,
    })
    fs.appendFileSync(this.logPath, JSON.stringify(clean) + '\n', 'utf8')
    return clean
  }

  readAllEvents() {
    if (!fs.existsSync(this.logPath)) {
      return { events: [], corruptLines: 0, totalLines: 0 }
    }
    const raw = fs.readFileSync(this.logPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const events = []
    let corruptLines = 0
    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]))
      } catch {
        corruptLines++
      }
    }
    return { events, corruptLines, totalLines: lines.length }
  }

  /**
   * Reconstructs exact latest transaction state per operation UUID:
   * planned -> reserved-and-durable -> submitted -> confirmed | rejected | unknown | aborted-before-send
   */
  reconstructTransactions() {
    const { events, corruptLines, totalLines } = this.readAllEvents()
    const txMap = new Map()
    const waitDecisions = []

    for (const ev of events) {
      if (ev.recordType === 'wait-decision') {
        waitDecisions.push(ev)
        continue
      }
      if (!ev.operation) continue
      const prev = txMap.get(ev.operation) || {
        operation: ev.operation,
        decisionId: ev.decisionId || null,
        account: ev.account || this.account,
        kind: ev.kind || 'act',
        status: 'planned',
        possibleIsleIndices: [],
        history: [],
      }
      prev.history.push(ev)
      if (ev.status) prev.status = ev.status
      if (ev.decisionId) prev.decisionId = ev.decisionId
      if (ev.kind) prev.kind = ev.kind
      if (ev.rulesHash) prev.rulesHash = ev.rulesHash
      if (ev.objectiveHash) prev.objectiveHash = ev.objectiveHash
      if (ev.constraintsHash) prev.constraintsHash = ev.constraintsHash
      if (ev.serverNow != null) prev.serverNow = ev.serverNow
      if (ev.revBefore != null) prev.revBefore = ev.revBefore
      if (ev.revAfter != null) prev.revAfter = ev.revAfter
      if (ev.stateBeforeRef) prev.stateBeforeRef = ev.stateBeforeRef
      if (ev.stateAfterRef !== undefined) prev.stateAfterRef = ev.stateAfterRef
      if (ev.planRef) prev.planRef = ev.planRef
      if (ev.envelopeRef) prev.envelopeRef = ev.envelopeRef
      if (ev.objectiveCfgRef) prev.objectiveCfgRef = ev.objectiveCfgRef
      if (ev.requestRef) prev.requestRef = ev.requestRef
      if (ev.responseRef) prev.responseRef = ev.responseRef
      if (ev.reconcileOutcome) prev.reconcileOutcome = ev.reconcileOutcome
      if (ev.inferredVisitOutcome) prev.inferredVisitOutcome = ev.inferredVisitOutcome
      if (ev.inferredCoinDelta != null) prev.inferredCoinDelta = ev.inferredCoinDelta
      if (ev.budgetKind) prev.budgetKind = ev.budgetKind
      if (Array.isArray(ev.possibleIsleIndices)) {
        if (ev.status === 'confirmed' || ev.status === 'rejected') {
          prev.possibleIsleIndices = [...new Set(ev.possibleIsleIndices)].sort((a, b) => a - b)
        } else {
          const merged = new Set([...(prev.possibleIsleIndices || []), ...ev.possibleIsleIndices])
          prev.possibleIsleIndices = [...merged].sort((a, b) => a - b)
        }
      }
      txMap.set(ev.operation, prev)
    }

    return {
      transactions: [...txMap.values()],
      txMap,
      waitDecisions,
      coverage: {
        totalLines,
        corruptLines,
        totalTransactions: txMap.size,
        waitCount: waitDecisions.length,
        confirmedCount: [...txMap.values()].filter((t) => t.status === 'confirmed').length,
        rejectedCount: [...txMap.values()].filter((t) => t.status === 'rejected').length,
        unknownCount: [...txMap.values()].filter((t) => t.status === 'unknown' || t.status === 'submitted').length,
      },
    }
  }

  /**
   * Computes conservatively occupied budget for a given isleIndex:
   * counts both `confirmed` on that isleIndex AND any `submitted`/`unknown` transaction whose
   * `possibleIsleIndices` includes `isleIdx` (round2-design-review.md §1).
   */
  countOccupiedBudget(budgetKind, isleIdx) {
    const { transactions } = this.reconstructTransactions()
    let used = 0
    for (const tx of transactions) {
      if (tx.budgetKind !== budgetKind) continue
      if (tx.status === 'rejected' || tx.status === 'aborted-before-send') continue
      if (
        tx.status === 'confirmed' ||
        tx.status === 'reserved-and-durable' ||
        tx.status === 'submitted' ||
        tx.status === 'unknown' ||
        tx.status === 'unknown-state-reanchored'
      ) {
        if ((tx.possibleIsleIndices || []).includes(isleIdx)) {
          used += 1
        }
      }
    }
    return used
  }

  /**
   * Aggregates confirmed item sales per `isleIndex` from archived transaction requests/receipts
   * so endogenous next-isle-day market depth impact (`-0.3 * sold / depth`) is tracked accurately.
   */
  sumConfirmedSalesByIsleIndex(adapter) {
    const { transactions } = this.reconstructTransactions()
    const out = new Map()
    for (const tx of transactions) {
      if (tx.kind !== 'act' || tx.status !== 'confirmed' || !tx.requestRef) continue
      const req = this.readBlob(tx.requestRef)
      const resp = tx.responseRef ? this.readBlob(tx.responseRef) : null
      const actions = req?.actions || []
      if (!Array.isArray(actions) || actions.length === 0) continue
      const isleIdx = tx.serverNow != null ? adapter.R.isleIndex(tx.serverNow) : (tx.possibleIsleIndices?.[0] ?? null)
      if (isleIdx == null) continue
      const receiptRows = resp?.body?.out || resp?.out || null
      actions.forEach((act, idx) => {
        if (act?.a !== 'sell' || !act.id || !(Number(act.n) > 0)) return
        if (Array.isArray(receiptRows) && receiptRows[idx] && receiptRows[idx].ok !== true) return
        const row = out.get(isleIdx) || {}
        row[act.id] = (row[act.id] || 0) + Number(act.n)
        out.set(isleIdx, row)
      })
    }
    return out
  }

  recordWaitDecision({
    decisionId = crypto.randomUUID(),
    worldBefore,
    envelope = null,
    objectiveCfg = null,
    rulesHash,
    rulesSourceText = null,
    objectiveHash,
    constraintsHash,
    plannedWakeSec,
    reason,
    planSummary = null,
  }) {
    if (rulesHash && rulesSourceText) this.archiveRulesSource(rulesHash, rulesSourceText)
    const stateBeforeRef = worldBefore ? this.writeBlob(sanitizeWorldSnapshot(worldBefore)) : null
    const envelopeRef = envelope ? this.writeBlob(envelope) : null
    const objectiveCfgRef = objectiveCfg ? this.writeBlob(objectiveCfg) : null
    const planRef = planSummary ? this.writeBlob(planSummary) : null
    return this.appendEvent({
      recordType: 'wait-decision',
      decisionId,
      serverNow: worldBefore?.now ?? null,
      revBefore: worldBefore?.rev ?? null,
      rulesHash,
      objectiveHash,
      constraintsHash,
      stateBeforeRef,
      envelopeRef,
      objectiveCfgRef,
      planRef,
      plannedWakeSec,
      reason,
    })
  }
}

const SECRET_RE = /cookie|token|secret|authorization|session|password|set-cookie/i

function stripForbiddenFields(val) {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(stripForbiddenFields)
  const out = {}
  for (const [k, v] of Object.entries(val)) {
    if (SECRET_RE.test(k)) continue
    out[k] = stripForbiddenFields(v)
  }
  return out
}
