import { sanitizeWorldSnapshot } from '../model/observations.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld, withAccountLock } from './reconcile.mjs'

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]

function cellStrength(b, N, x, y, who) {
  let total = 0
  let threats = 0
  for (const [dx, dy] of DIRS) {
    let n = 1
    let open = 0
    for (const sg of [-1, 1]) {
      let k = 1
      while (true) {
        const X = x + dx * k * sg
        const Y = y + dy * k * sg
        if (X < 0 || Y < 0 || X >= N || Y >= N) break
        const v = b[Y * N + X]
        if (v !== who) {
          if (!v) open++
          break
        }
        n++
        k++
      }
    }
    total += n >= 5
      ? 1000000
      : n === 4
        ? (open === 2 ? 60000 : open ? 12000 : 0)
        : n === 3
          ? (open === 2 ? 4200 : open ? 320 : 0)
          : n === 2
            ? (open === 2 ? 220 : open ? 35 : 0)
            : open * 4
    if (n >= 3 && open === 2) threats++
    for (let start = -4; start <= 0; start++) {
      let count = 0
      let valid = true
      for (let k = start; k < start + 5; k++) {
        const X = x + dx * k
        const Y = y + dy * k
        if (X < 0 || Y < 0 || X >= N || Y >= N) {
          valid = false
          break
        }
        const v = k === 0 ? who : b[Y * N + X]
        if (v && v !== who) {
          valid = false
          break
        }
        if (v === who) count++
      }
      if (valid) {
        total += count >= 4 ? 2600 : count === 3 ? 110 : count === 2 ? 10 : 0
      }
    }
  }
  return total + (threats >= 2 ? 15000 : 0)
}

function collectLocalCands(b, N, r = 2) {
  const cand = []
  let hasStone = false
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (b[y * N + x]) {
        hasStone = true
        continue
      }
      let near = false
      for (let dy = -r; dy <= r && !near; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const X = x + dx
          const Y = y + dy
          if (X >= 0 && Y >= 0 && X < N && Y < N && b[Y * N + X]) {
            near = true
            break
          }
        }
      }
      if (near) cand.push([x, y])
    }
  }
  if (!hasStone) {
    const c = N >> 1
    return [[c, c]]
  }
  return cand
}

function countImmediateWins(b, N, cands, who, gomokuLineFn) {
  let cnt = 0
  let maxMy = 0
  let maxFoe = 0
  for (let i = 0; i < cands.length; i++) {
    const [x, y] = cands[i]
    if (gomokuLineFn(b, x, y, who, N) >= 5) cnt++
    const ms = cellStrength(b, N, x, y, 1)
    const fs = cellStrength(b, N, x, y, 2)
    if (ms > maxMy) maxMy = ms
    if (fs > maxFoe) maxFoe = fs
  }
  return { wins: cnt, maxMy, maxFoe }
}

function rankCandidateMoves(R, b, N, maxBranch = 7) {
  const cands = collectLocalCands(b, N, 2)
  if (cands.length === 0) return []
  for (const p of cands) {
    if (R.gomokuLine(b, p[0], p[1], 1, N) >= 5) {
      return [{ p, winNow: true, score: 1e9 }]
    }
  }
  const foeFives = []
  for (const p of cands) {
    if (R.gomokuLine(b, p[0], p[1], 2, N) >= 5) foeFives.push(p)
  }
  if (foeFives.length === 1) {
    return [{ p: foeFives[0], forcedBlock: true, score: 5e8 }]
  }
  const pool = foeFives.length > 1 ? foeFives : cands
  const center = N >> 1
  const scored = pool.map((p) => {
    const myS = cellStrength(b, N, p[0], p[1], 1)
    const aiS = cellStrength(b, N, p[0], p[1], 2)
    const centerBias = (Math.abs(p[0] - center) + Math.abs(p[1] - center)) * 0.25
    return {
      p,
      myS,
      aiS,
      mix: myS * 1.15 + aiS * 1.05 - centerBias,
    }
  })
  const picked = []
  const seen = new Set()
  const addTop = (arr, limit) => {
    for (let i = 0; i < arr.length && picked.length < maxBranch && limit > 0; i++) {
      const k = arr[i].p[1] * N + arr[i].p[0]
      if (!seen.has(k)) {
        seen.add(k)
        picked.push(arr[i])
        limit--
      }
    }
  }
  addTop([...scored].sort((a, b2) => b2.mix - a.mix), Math.min(4, maxBranch))
  addTop([...scored].sort((a, b2) => b2.myS - a.myS), 2)
  addTop([...scored].sort((a, b2) => b2.aiS - a.aiS), 2)
  return picked
}

function evaluateMoveAgainstOracle(R, b, N, seed, step, d, candItem) {
  const [px, py] = candItem.p
  const pi = py * N + px
  if (b[pi] !== 0) return null
  if (candItem.winNow || R.gomokuLine(b, px, py, 1, N) >= 5) {
    return { p: candItem.p, terminal: 'win', score: 1e12, boardAfter: null }
  }
  const bNext = b.slice()
  bNext[pi] = 1
  if (bNext.every(Boolean)) {
    return { p: candItem.p, terminal: 'draw', score: -5e8, boardAfter: bNext }
  }
  const [ax, ay] = R.gomokuAI(bNext.slice(), seed, step, d, N)
  const ai = ay * N + ax
  bNext[ai] = 2
  if (R.gomokuLine(bNext, ax, ay, 2, N) >= 5) {
    return null
  }
  if (bNext.every(Boolean)) {
    return { p: candItem.p, terminal: 'draw', score: -5e8, boardAfter: bNext }
  }

  const nextCands = collectLocalCands(bNext, N, 2)
  let myFiveCnt = 0
  let aiFiveCnt = 0
  let maxMy = 0
  let maxAi = 0
  for (let i = 0; i < nextCands.length; i++) {
    const [cx, cy] = nextCands[i]
    if (R.gomokuLine(bNext, cx, cy, 1, N) >= 5) myFiveCnt++
    if (R.gomokuLine(bNext, cx, cy, 2, N) >= 5) aiFiveCnt++
    const ms = cellStrength(bNext, N, cx, cy, 1)
    const as = cellStrength(bNext, N, cx, cy, 2)
    if (ms > maxMy) maxMy = ms
    if (as > maxAi) maxAi = as
  }

  let score = 0
  if (myFiveCnt > 0 && aiFiveCnt === 0) {
    score = 5e8 + myFiveCnt * 1e5
  } else if (aiFiveCnt >= 2) {
    score = -2e8 - aiFiveCnt * 1e6
  } else if (aiFiveCnt === 1) {
    score = maxMy >= 50000 ? -2e5 : -8e5
  } else if (maxAi >= 50000) {
    score = -1.5e6
  } else {
    score = maxMy * 1.25 - maxAi * 1.1 + myFiveCnt * 50000 + (candItem.myS || 0) * 0.1
  }

  return {
    p: candItem.p,
    terminal: null,
    score,
    boardAfter: bNext,
  }
}

function runGreedyPlaythrough(R, seed, d, N, firstMove = null, maxMoves = Math.ceil((N * N) / 2), maxBranch = 6) {
  const b = new Array(N * N).fill(0)
  const mv = []
  for (let step = 0; step < maxMoves; step++) {
    if (step === 0 && Array.isArray(firstMove)) {
      const ev = evaluateMoveAgainstOracle(R, b, N, seed, step, d, { p: firstMove, myS: 0 })
      if (!ev || !ev.boardAfter) break
      mv.push(ev.p)
      for (let i = 0; i < b.length; i++) b[i] = ev.boardAfter[i]
      continue
    }
    const ranked = rankCandidateMoves(R, b, N, maxBranch)
    let bestEv = null
    for (const cand of ranked) {
      const ev = evaluateMoveAgainstOracle(R, b, N, seed, step, d, cand)
      if (!ev) continue
      if (ev.terminal === 'win') {
        mv.push(ev.p)
        return { mv, outcome: 'win' }
      }
      if (!bestEv || ev.score > bestEv.score) {
        bestEv = ev
      }
    }
    if (!bestEv) {
      // Fall back to any legal move if all top candidates hit an immediate tactical loss
      const allCands = collectLocalCands(b, N, 2)
      for (const p of allCands) {
        const pi = p[1] * N + p[0]
        if (b[pi] === 0) {
          mv.push(p)
          b[pi] = 1
          if (R.gomokuLine(b, p[0], p[1], 1, N) >= 5) return { mv, outcome: 'win' }
          if (b.every(Boolean)) return { mv, outcome: 'draw' }
          const [ax, ay] = R.gomokuAI(b.slice(), seed, step, d, N)
          b[ay * N + ax] = 2
          if (R.gomokuLine(b, ax, ay, 2, N) >= 5) return { mv, outcome: 'lose' }
          if (b.every(Boolean)) return { mv, outcome: 'draw' }
          bestEv = { boardAfter: b }
          break
        }
      }
      if (!bestEv) break
      continue
    }
    mv.push(bestEv.p)
    if (bestEv.terminal === 'draw') return { mv, outcome: 'draw' }
    for (let i = 0; i < b.length; i++) b[i] = bestEv.boardAfter[i]
  }
  return { mv, outcome: R.gomokuReplay(seed, mv, d, N) }
}

function runBeamSearchPlaythrough(R, seed, d, N, {
  beamWidth = 4,
  branchK = 5,
  firstMove = null,
  maxSteps = Math.ceil((N * N) / 2),
} = {}) {
  const c = N >> 1
  const initBoard = new Array(N * N).fill(0)
  let beam = [{ b: initBoard, mv: [], score: 0 }]
  if (Array.isArray(firstMove)) {
    const ev = evaluateMoveAgainstOracle(R, initBoard, N, seed, 0, d, { p: firstMove, myS: 0 })
    if (ev?.boardAfter) {
      beam = [{ b: ev.boardAfter, mv: [ev.p], score: ev.score }]
    }
  }

  let fallbackDraw = null
  const startStep = beam[0].mv.length
  for (let step = startStep; step < maxSteps && beam.length > 0; step++) {
    const nextBeam = []
    for (const node of beam) {
      const cands = rankCandidateMoves(R, node.b, N, step === 0 ? 3 : branchK)
      for (const cand of cands) {
        const ev = evaluateMoveAgainstOracle(R, node.b, N, seed, step, d, cand)
        if (!ev) continue
        if (ev.terminal === 'win') {
          const mv = [...node.mv, ev.p]
          return { mv, outcome: 'win' }
        }
        if (ev.terminal === 'draw') {
          if (!fallbackDraw) fallbackDraw = { mv: [...node.mv, ev.p], outcome: 'draw' }
          continue
        }
        nextBeam.push({
          b: ev.boardAfter,
          mv: [...node.mv, ev.p],
          score: ev.score,
        })
      }
    }
    if (nextBeam.length === 0) break
    nextBeam.sort((a, b2) => b2.score - a.score)
    beam = nextBeam.slice(0, beamWidth)
  }

  if (fallbackDraw) return fallbackDraw
  return runGreedyPlaythrough(R, seed, d, N, [c, c])
}

/**
 * Computes a deterministic winning (or at worst legal draw/completed) move sequence `mv`
 * against the server's exact deterministic `R.gomokuAI` oracle for a given game `seed` & difficulty `d`.
 */
export function solveGomokuForSeed(R, seed, d = 3, N = R?.GOMOKU_N || 15) {
  if (typeof R?.gomokuAI !== 'function' || typeof R?.gomokuReplay !== 'function') {
    throw new Error('RulesAdapter R.gomokuAI / R.gomokuReplay is required to solve Gomoku')
  }
  const c = N >> 1
  const openings = [[c, c], [c - 1, c], [c, c - 1], [c - 1, c - 1]]
  let bestFallback = null

  for (const openMove of openings) {
    const greedy = runGreedyPlaythrough(R, seed, d, N, openMove, Math.ceil((N * N) / 2), 6)
    const verified = R.gomokuReplay(seed, greedy.mv, d, N)
    if (verified === 'win') {
      return { mv: greedy.mv, outcome: 'win' }
    }
    if (!bestFallback && verified !== 'bad') {
      bestFallback = { mv: greedy.mv, outcome: verified }
    }
  }

  for (const openMove of openings.slice(0, 3)) {
    const beam = runBeamSearchPlaythrough(R, seed, d, N, {
      beamWidth: 5,
      branchK: 5,
      firstMove: openMove,
    })
    const verified = R.gomokuReplay(seed, beam.mv, d, N)
    if (verified === 'win') {
      return { mv: beam.mv, outcome: 'win' }
    }
    if (verified === 'draw' && (!bestFallback || bestFallback.outcome === 'lose')) {
      bestFallback = { mv: beam.mv, outcome: 'draw' }
    }
  }

  if (bestFallback && R.gomokuReplay(seed, bestFallback.mv, d, N) !== 'bad') {
    return bestFallback
  }
  throw new Error(`solveGomokuForSeed failed to find valid non-bad replay for seed=${seed} d=${d} N=${N}`)
}

/**
 * Computes the next server timestamp (epoch seconds) when the 52D Toy Stall (`NPC`) has pending work
 * (either finishing an active `npcG` game or completing the `NPC.daily = 52` daily quota).
 */
export function computeNextNpcWakeSec(adapter, world, nowSec, npcOptions = { enabled: true }) {
  if (npcOptions?.enabled === false || !adapter || !world?.state) return Infinity
  const nowFloor = Math.floor(Number(nowSec || world.now || 0))
  const w = adapter.advanceTimeOnly(world, Math.max(Number(world.now || 0), nowFloor))
  const dailyCap = Number(adapter.R.NPC?.daily || 52)
  const used = Number(w.state?.cnt?.npc || 0)
  const npcG = w.state?.npcG
  const hasUnfinishedRealGame = Boolean(npcG && !npcG.p)
  if (hasUnfinishedRealGame || used < dailyCap) {
    return nowFloor + 2
  }
  if (typeof adapter.nextNaturalDayBoundary === 'function') {
    return adapter.nextNaturalDayBoundary(nowFloor) + 5
  }
  const shift = 8 * 3600
  return (Math.floor((nowFloor + shift) / 86400) + 1) * 86400 - shift + 5
}

/**
 * Phase C.5b Background Execution Slice for 「52弟 的玩具摊」 (`NPC`):
 *   - Consumes 0 stamina and 0 D-coins; eligible for 0.1% 1,000,000 D jackpot + coins/items/gems.
 *   - Plays first `GOMOKU_PAID = 10` paid 15×15 Hard Gomoku games (`d = 3`, `1.5×` reward) using exact
 *     deterministic oracle solver `solveGomokuForSeed`.
 *   - Completes remaining `52 - used` daily quota via safe batched `{ a: 'npc', g: 'card' }` calls (`<= 40`/TX),
 *     guaranteeing zero quota overflow (`used + nCards <= dailyCap`) and full Layer-1/Layer-3 journal auditability.
 *   - Preemptible between transactions (`shouldAbortFn`), executing at most ONE `POST /api/pet/world/act` per call.
 */
export async function runNpcToyStallSlice({
  account = 'main',
  adapter,
  httpClient,
  journal = null,
  lockRootDir,
  observedWorld = null,
  shouldAbortFn = null,
  npcOptions = { enabled: true },
  maxCardBatch = 40,
  dryRun = false,
} = {}) {
  if (npcOptions?.enabled === false) {
    return { status: 'disabled', nextNpcWakeSec: Infinity }
  }
  if (!adapter || !httpClient) {
    return { status: 'missing-deps', nextNpcWakeSec: Infinity }
  }

  const dailyCap = Number(adapter.R.NPC?.daily || 52)
  const gomokuPaidCap = Number(adapter.R.GOMOKU_PAID || 10)
  const estNowSec = Math.floor(Number(httpClient.estimatedServerNowSec?.() ?? observedWorld?.now ?? 0))

  // Zero-HTTP / Zero-Lock fast exit when observed snapshot already completed today's 52 games
  if (observedWorld?.state) {
    const obsRefreshed = adapter.advanceTimeOnly(observedWorld, Math.max(Number(observedWorld.now || 0), estNowSec))
    const obsUsed = Number(obsRefreshed.state?.cnt?.npc || 0)
    const obsNpcG = obsRefreshed.state?.npcG
    if (obsUsed >= dailyCap && !(obsNpcG && !obsNpcG.p)) {
      return {
        status: 'quota-complete',
        usedToday: obsUsed,
        dailyCap,
        nextNpcWakeSec: computeNextNpcWakeSec(adapter, obsRefreshed, estNowSec, npcOptions),
      }
    }
  }

  if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
    return { status: 'preempted-by-snipe', stage: 'before-lock' }
  }

  return withAccountLock(lockRootDir, account, async () => {
    if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
      return { status: 'preempted-by-snipe', stage: 'in-lock' }
    }

    const rawWorld = await httpClient.getJson('/api/pet/world')
    let liveWorld = sanitizeWorldSnapshot(rawWorld)

    if (journal) {
      const recOut = await reconcileUnknownWithFreshWorld({
        journal,
        adapter,
        freshWorld: liveWorld,
        lockRootDir,
        alreadyLocked: true,
        account,
      })
      if (recOut.remainingNonVisitUnknown > 0) {
        return {
          status: 'blocked-pending-unknown',
          remainingNonVisitUnknown: recOut.remainingNonVisitUnknown,
        }
      }
    }

    const refreshed = adapter.advanceTimeOnly(liveWorld, liveWorld.now)
    const state = refreshed.state || {}
    const used = Number(state.cnt?.npc || 0)
    const paid = Number(state.cnt?.gomokuPaid || 0)
    const npcG = state.npcG

    let actions = null
    if (npcG && npcG.g === 'gomoku' && !npcG.p) {
      const gN = npcG.n === adapter.R.GOMOKU_N ? adapter.R.GOMOKU_N : (npcG.n || 11)
      const gD = npcG.d || 2
      const solved = solveGomokuForSeed(adapter.R, npcG.seed, gD, gN)
      actions = [{ a: 'npc', g: 'gomoku', k: 'end', mv: solved.mv }]
    } else if (npcG && npcG.g === 'box') {
      const pickedSet = new Set(npcG.pk || [])
      let pickIdx = 0
      while (pickIdx < 9 && pickedSet.has(pickIdx)) pickIdx++
      if (pickIdx < 9) {
        actions = [{ a: 'npc', g: 'box', k: 'pick', i: pickIdx }]
      }
    }

    if (!actions) {
      if (used >= dailyCap) {
        return {
          status: 'quota-complete',
          usedToday: used,
          dailyCap,
          worldAfter: liveWorld,
          nextNpcWakeSec: computeNextNpcWakeSec(adapter, liveWorld, liveWorld.now, npcOptions),
        }
      }
      if (paid < gomokuPaidCap) {
        actions = [{ a: 'npc', g: 'gomoku', k: 'start', d: 3 }]
      } else {
        const nCards = Math.max(1, Math.min(maxCardBatch, dailyCap - used))
        actions = Array.from({ length: nCards }, () => ({ a: 'npc', g: 'card' }))
      }
    }

    if (dryRun) {
      return {
        status: 'dry-run-ready',
        actions,
        usedToday: used,
        dailyCap,
        nextNpcWakeSec: Number(liveWorld.now || estNowSec) + 2,
      }
    }

    if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
      return { status: 'preempted-by-snipe', stage: 'before-send' }
    }

    const txRes = await executeTransaction({
      journal,
      adapter,
      lockRootDir,
      alreadyLocked: true,
      account,
      decisionId: `npc:${account}:${liveWorld.rev ?? 'na'}:${liveWorld.now ?? '0'}`,
      kind: 'npc-act',
      worldBefore: liveWorld,
      requestPayload: { actions },
      sendFn: ({ operation }) => httpClient.postJson('/api/pet/world/act', { actions, operation }),
      fetchAfterWorldFn: async () => sanitizeWorldSnapshot(await httpClient.getJson('/api/pet/world')),
    })

    const worldAfter = txRes.worldAfter || null
    const refWorld = worldAfter || liveWorld
    return {
      status: txRes.status,
      actions,
      txResult: txRes,
      worldAfter,
      usedToday: Number(adapter.advanceTimeOnly(refWorld, refWorld.now).state?.cnt?.npc || used),
      dailyCap,
      nextNpcWakeSec: computeNextNpcWakeSec(adapter, refWorld, refWorld.now, npcOptions),
    }
  })
}
