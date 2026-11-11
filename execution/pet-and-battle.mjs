import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  SLOTS,
  executeWithTacticalLoadout,
  extractEquippedIds,
  planGearAndPoints,
  readAccountGearState,
  recordBattleSnapshot,
  recordObservedPanel,
  syncGuardLogProfiles,
  syncHomeHistoryProfiles,
  withGearLock,
  writeAccountGearState,
} from './combat-engine.mjs'

/**
 * Causally-Ordered Pet Care, Battle Preparation, Single-Bout Arena & Huancai Floor (`execution/pet-and-battle.mjs`)
 *
 * Enforces strict execution-leaf causal ordering:
 *   1. `syncPetCareFirst`:
 *      Aligns server authoritative `progress.{total, day, day_xp, cap}`, simulates decay + `met` + `feed/clean/rest/play`,
 *      and commits `POST /api/pet/state` (with single-pass `409` conflict recovery) BEFORE any battle/gear step.
 *      Any pet level-up (`+3` free stat points) is therefore guaranteed visible on the server before combat!
 *   2. `syncBattleProfilesAndPreparation`:
 *      Syncs unseen `home.history` & `guard-log` opponent fighter snapshots -> acquires `.battle-gear.<account>.lock` ->
 *      opens ready battle chests FIRST -> equips optimal resting defense gear -> runs multi-pass `planGearAndPoints`
 *      stat allocation (resolving step-observed `spd`/`atk` breakpoints immediately) -> persists clean resting state.
 *   3. `runSingleArenaBout`:
 *      Preemptible by imminent snipes (`shouldAbortFn`) -> sleeps `minBoutGapMs` (`8.5s`) OUTSIDE gear lock while wearing
 *      resting defense gear -> picks lowest-level available opponent -> runs `executeWithTacticalLoadout` (`mode: 'arena'`)
 *      with server-deduplicated `operation` UUID -> records arena snapshot immediately -> restores resting gear in `finally`.
 *   4. `runHuancaiDailyCheck`:
 *      Enforces `22:30 CST` cycle boundary, domestic-only zero-buy isolation, cash reserve floor, and order-history deduplication.
 */

const XP_PER_LEVEL = 120
const DEFAULT_DAILY_XP_CAP = 167

const CARE_SPECS = {
  feed: { hunger: 28, mood: 4, clean: -2, energy: 0, xp: 12 },
  clean: { hunger: 0, mood: 3, clean: 32, energy: 0, xp: 10 },
  rest: { hunger: -4, mood: 4, clean: 0, energy: 30, xp: 8 },
  play: { hunger: -6, mood: 20, clean: -4, energy: -10, xp: 15 },
}

const clampStat = (v) => Math.max(0, Math.min(100, Math.round(Number(v || 0) * 10) / 10))

export function petLevelOfTotalXp(totalXp) {
  const safe = Math.max(0, Math.floor(Number(totalXp || 0)))
  return {
    level: Math.floor(safe / XP_PER_LEVEL) + 1,
    xp: safe % XP_PER_LEVEL,
    next: XP_PER_LEVEL,
  }
}

export function localCstDayStr(nowSec) {
  const cstMs = (Number(nowSec || 0) + 8 * 3600) * 1000
  const d = new Date(cstMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function applyPetDecay(stateObj, nowSec) {
  const s = structuredClone(stateObj)
  const prevTs = Number(s.ts || nowSec)
  const dtHours = Math.min(72, Math.max(0, (nowSec - prevTs) / 3600))
  if (dtHours >= 0.02) {
    s.hunger = clampStat((s.hunger ?? 80) - dtHours * 5)
    s.mood = clampStat((s.mood ?? 80) - dtHours * 3.5)
    s.clean = clampStat((s.clean ?? 80) - dtHours * 2.5)
    s.energy = clampStat((s.energy ?? 80) - dtHours * 2)
    s.ts = nowSec
  }
  return s
}

function gainPetXpInPlace(s, rawGain, authDay, dailyCap) {
  if (!s.daily || s.daily.day !== authDay) {
    s.daily = { day: authDay, xp: 0 }
  }
  const left = Math.max(0, dailyCap - Number(s.daily.xp || 0))
  const add = Math.max(0, Math.min(left, Math.floor(Number(rawGain || 0))))
  if (add <= 0) return 0
  s.daily.xp = Number(s.daily.xp || 0) + add
  const curTotal = (Math.max(1, Number(s.level || 1)) - 1) * XP_PER_LEVEL + Number(s.xp || 0) + add
  const lvInfo = petLevelOfTotalXp(curTotal)
  s.level = lvInfo.level
  s.xp = lvInfo.xp
  return add
}

/**
 * Pure deterministic planner for `/api/pet/state` care cycle.
 */
export function planPetCare(petStateResponse, nowSec = Math.floor(Date.now() / 1000)) {
  if (!petStateResponse || !petStateResponse.state) {
    return { adopted: false, shouldSave: false, actions: [], xpGained: 0, leveledUp: false }
  }

  const prog = petStateResponse.progress || {}
  const rawS = petStateResponse.state
  const authTotal = Number.isFinite(prog.total)
    ? Math.max(0, Math.floor(prog.total))
    : ((Math.max(1, Number(rawS.level || 1)) - 1) * XP_PER_LEVEL + Math.max(0, Math.floor(Number(rawS.xp || 0))))
  const startLvInfo = petLevelOfTotalXp(authTotal)
  const authDay = String(prog.day || rawS.daily?.day || localCstDayStr(nowSec))
  const authDayXp = prog.day
    ? Math.max(0, Math.floor(Number(prog.day_xp || 0)))
    : (rawS.daily?.day === authDay ? Math.max(0, Math.floor(Number(rawS.daily?.xp || 0))) : 0)
  const dailyCap = Number.isFinite(prog.cap) && prog.cap > 0
    ? Math.floor(prog.cap)
    : DEFAULT_DAILY_XP_CAP

  let s = structuredClone(rawS)
  s.level = startLvInfo.level
  s.xp = startLvInfo.xp
  s.daily = { day: authDay, xp: authDayXp }
  s = applyPetDecay(s, nowSec)

  const actions = []
  let xpGained = 0

  if (s.met_day !== authDay) {
    s.met_day = authDay
    s.mood = clampStat((s.mood ?? 80) + 3)
    const g = gainPetXpInPlace(s, 20, authDay, dailyCap)
    xpGained += g
    actions.push({ kind: 'met', xp: g })
  }

  for (let step = 0; step < 25; step++) {
    const xpLeft = Math.max(0, dailyCap - Number(s.daily?.xp || 0))
    const needHunger = (s.hunger ?? 100) < 92
    const needClean = (s.clean ?? 100) < 92
    const needEnergy = (s.energy ?? 100) < 90
    const needMood = (s.mood ?? 100) < 95

    let chosen = null
    if ((s.hunger ?? 100) < 45) chosen = 'feed'
    else if ((s.energy ?? 100) < 35) chosen = 'rest'
    else if ((s.clean ?? 100) < 45) chosen = 'clean'
    else if (needHunger && (s.hunger ?? 100) <= Math.min(s.clean ?? 100, s.energy ?? 100)) chosen = 'feed'
    else if (needClean && (s.clean ?? 100) <= (s.energy ?? 100)) chosen = 'clean'
    else if (needEnergy) chosen = 'rest'
    else if (needHunger) chosen = 'feed'
    else if (needClean) chosen = 'clean'
    else if ((needMood || xpLeft > 0) && (s.energy ?? 0) >= 20 && (s.hunger ?? 0) >= 20 && (s.clean ?? 0) >= 15) {
      chosen = 'play'
    }

    if (!chosen) break
    const spec = CARE_SPECS[chosen]
    s.hunger = clampStat((s.hunger ?? 80) + spec.hunger)
    s.mood = clampStat((s.mood ?? 80) + spec.mood)
    s.clean = clampStat((s.clean ?? 80) + spec.clean)
    s.energy = clampStat((s.energy ?? 80) + spec.energy)
    s.stats = s.stats && typeof s.stats === 'object' ? { ...s.stats } : {}
    const statCountKey = chosen === 'feed' ? 'feeds' : chosen === 'clean' ? 'cleans' : chosen === 'rest' ? 'rests' : 'plays'
    s.stats[statCountKey] = Number(s.stats[statCountKey] || 0) + 1
    const g = gainPetXpInPlace(s, spec.xp, authDay, dailyCap)
    xpGained += g
    s.ts = nowSec
    actions.push({ kind: chosen, xp: g })
  }

  const endTotal = (Math.max(1, Number(s.level || 1)) - 1) * XP_PER_LEVEL + Number(s.xp || 0)
  return {
    adopted: true,
    shouldSave: actions.length > 0,
    actions,
    xpGained,
    startLevel: startLvInfo.level,
    endLevel: s.level,
    leveledUp: s.level > startLvInfo.level,
    baseTotal: authTotal,
    projectedTotal: endTotal,
    revision: petStateResponse.revision,
    userId: petStateResponse.user_id,
    nextState: s,
  }
}

/**
 * Step 1 of Combat/Pet Causal Pipeline:
 * Synchronizes pet care and commits any XP / level-up BEFORE reading `/api/pet/battle/gear`!
 */
export async function syncPetCareFirst(httpClient, {
  dryRun = false,
  nowSec = null,
} = {}) {
  let petData
  try {
    petData = await httpClient.getJson('/api/pet/state')
  } catch (err) {
    return { ok: false, stage: 'fetch-pet-state', error: err?.message || String(err) }
  }

  const effNow = Number.isFinite(nowSec) ? nowSec : httpClient.estimatedServerNowSec()
  let plan = planPetCare(petData, effNow)
  if (!plan.adopted || !plan.shouldSave || dryRun) {
    return {
      ok: true,
      saved: false,
      adopted: plan.adopted,
      leveledUp: plan.leveledUp,
      startLevel: plan.startLevel ?? null,
      endLevel: plan.endLevel ?? null,
      xpGained: plan.xpGained,
      actionsCount: plan.actions.length,
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const postRes = await httpClient.postJson('/api/pet/state', {
      user_id: plan.userId,
      revision: plan.revision,
      base_total: plan.baseTotal,
      operation: crypto.randomUUID(),
      state: plan.nextState,
    })
    if (postRes.ok) {
      const savedLevel = postRes.body?.progress?.level ?? postRes.body?.state?.level ?? plan.endLevel
      return {
        ok: true,
        saved: true,
        adopted: true,
        leveledUp: Number(savedLevel || 0) > Number(plan.startLevel || 0),
        startLevel: plan.startLevel,
        endLevel: savedLevel,
        xpGained: plan.xpGained,
        actionsCount: plan.actions.length,
        conflictRetried: attempt > 0,
      }
    }
    if (postRes.status === 409 && attempt === 0) {
      petData = await httpClient.getJson('/api/pet/state')
      plan = planPetCare(petData, httpClient.estimatedServerNowSec())
      if (!plan.adopted || !plan.shouldSave) {
        return {
          ok: true,
          saved: false,
          adopted: plan.adopted,
          leveledUp: false,
          startLevel: plan.startLevel ?? null,
          endLevel: plan.endLevel ?? null,
          xpGained: 0,
          actionsCount: 0,
          conflictRetried: true,
        }
      }
      continue
    }
    return {
      ok: false,
      stage: 'save-pet-state',
      status: postRes.status,
      error: postRes.body?.error || postRes.error || `HTTP ${postRes.status}`,
    }
  }

  return { ok: false, stage: 'save-pet-state-exhausted' }
}

/**
 * Step 2 of Combat/Pet Causal Pipeline:
 * Syncs battle history + guard log profiles, opens ready daily chests, equips optimal resting defense gear,
 * and allocates free stat points (including newly earned level-up points + multi-pass breakpoint observation)
 * strictly inside `.battle-gear.<account>.lock`!
 */
export async function syncBattleProfilesAndPreparation(httpClient, {
  accountKey = 'main',
  lockRoot,
  storePath,
  dryRun = false,
} = {}) {
  let homeData
  try {
    homeData = await httpClient.getJson('/api/pet/battle/home')
  } catch (err) {
    return { ok: false, stage: 'fetch-battle-home', error: err?.message || String(err) }
  }

  if (!homeData?.adopted) {
    return { ok: true, adopted: false, homeData }
  }

  const syncedArenaCount = storePath
    ? await syncHomeHistoryProfiles(httpClient, homeData, accountKey, { storePath })
    : 0
  const syncedGuardCount = storePath
    ? await syncGuardLogProfiles(httpClient, accountKey, { storePath })
    : 0

  if (dryRun) {
    const gearSnap = await httpClient.getJson('/api/pet/battle/gear')
    const plan = planGearAndPoints(gearSnap)
    return {
      ok: true,
      adopted: true,
      dryRun: true,
      homeData,
      gearSnap,
      plan,
      syncedArenaCount,
      syncedGuardCount,
    }
  }

  return withGearLock(lockRoot, accountKey, async () => {
    const chestsOpened = []
    for (const ch of homeData.chests || []) {
      if (ch && ch.ready && !ch.opened && ch.tier != null) {
        const cr = await httpClient.postJson('/api/pet/battle/chest', { tier: ch.tier })
        if (cr.ok) chestsOpened.push(ch.tier)
      }
    }

    const st = readAccountGearState(accountKey, lockRoot)
    let gearSnap = await httpClient.getJson('/api/pet/battle/gear')
    recordObservedPanel(st, gearSnap)

    // First equip optimal resting defense gear ( recovers any prior `dirty` state as well! )
    let plan = planGearAndPoints(gearSnap)
    const equippedChanges = []
    let equipError = null

    for (const slot of SLOTS) {
      const wantId = plan.detail[slot]?.best
      const curId = gearSnap?.gear?.[slot]?.id || null
      if (wantId && wantId !== curId) {
        const eqRes = await httpClient.postJson('/api/pet/battle/equip', { slot, item: wantId })
        if (eqRes.ok) {
          gearSnap = eqRes.body?.catalog ? eqRes.body : await httpClient.getJson('/api/pet/battle/gear')
          recordObservedPanel(st, gearSnap)
          equippedChanges.push({ slot, from: curId, to: wantId })
        } else {
          equipError ||= `equip-${slot}-failed:${eqRes.status}`
        }
      }
    }

    // Multi-pass stat allocation: wearing the best weapon unlocks exact `wornSpdTotal`/`wornAtkTotal` observation,
    // and Pass 2 immediately spends any `reserveForSpdObs` points freed after Pass 1's panel observation!
    const pointAllocations = []
    for (let pass = 0; pass < 2; pass++) {
      plan = planGearAndPoints(gearSnap)
      if (!plan.allocate) break
      const ptRes = await httpClient.postJson('/api/pet/battle/points', { points: plan.points })
      if (!ptRes.ok) break
      pointAllocations.push({ pass: pass + 1, points: { ...plan.points } })
      gearSnap = ptRes.body?.catalog ? ptRes.body : await httpClient.getJson('/api/pet/battle/gear')
      recordObservedPanel(st, gearSnap)
    }

    const finalPlan = planGearAndPoints(gearSnap)
    const effResting = {
      weapon: finalPlan.detail.weapon?.best || gearSnap?.gear?.weapon?.id || null,
      armor: finalPlan.detail.armor?.best || gearSnap?.gear?.armor?.id || null,
      charm: finalPlan.detail.charm?.best || gearSnap?.gear?.charm?.id || null,
    }
    const curEquipped = extractEquippedIds(gearSnap)
    st.restingGear = effResting
    st.restingCharm = effResting.charm
    st.activeGear = curEquipped
    st.activeCharm = curEquipped.charm
    st.dirty = Boolean(equipError) || SLOTS.some((s) => effResting[s] && curEquipped[s] !== effResting[s])
    st.updatedAt = Date.now()
    st.gearSnap = gearSnap
    writeAccountGearState(st, accountKey, lockRoot)

    return {
      ok: !equipError,
      adopted: true,
      homeData,
      gearSnap,
      restingGear: effResting,
      chestsOpened,
      equippedChanges,
      pointAllocations,
      syncedArenaCount,
      syncedGuardCount,
      dirty: st.dirty,
      equipError,
    }
  })
}

export function pickArenaOpponent(opponentsList = [], excludeIds = null) {
  const candidates = (opponentsList || []).filter((o) => {
    if (!o || o.id == null) return false
    if (o.left != null && !(Number(o.left) > 0)) return false
    if (excludeIds && excludeIds.has(Number(o.id))) return false
    return true
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) =>
    (Number(a.level || 0) - Number(b.level || 0)) ||
    (Number(a.power || 0) - Number(b.power || 0)) ||
    (Number(a.id) - Number(b.id))
  )
  return candidates[0]
}

/**
 * Step 3 of Combat/Pet Causal Pipeline:
 * Executes AT MOST ONE preemptible arena bout per call:
 * - Sleeps `minBoutGapMs` (`8.5s`) OUTSIDE `.battle-gear.<account>.lock` while resting defense gear stays equipped!
 * - Aborts immediately on `shouldAbortFn()` so imminent crop/barn snipes are NEVER delayed by arena cooldowns!
 */
export async function runSingleArenaBout(httpClient, {
  accountKey = 'main',
  lockRoot,
  storePath,
  homeData = null,
  lastBoutFinishedAtMs = 0,
  minBoutGapMs = 8500,
  shouldAbortFn = null,
  excludeOpponentIds = null,
  dryRun = false,
} = {}) {
  if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
    return { status: 'preempted-by-snipe', stage: 'before-home' }
  }

  const home = homeData || await httpClient.getJson('/api/pet/battle/home')
  if (!home?.adopted) {
    return { status: 'not-adopted' }
  }

  const usedToday = Number(home.today?.used || 0)
  const dailyLimit = Number(home.today?.limit ?? home.today?.drops ?? 30)
  if (usedToday >= dailyLimit) {
    return { status: 'daily-quota-complete', usedToday, dailyLimit }
  }

  // Enforce inter-bout cooldown OUTSIDE gear lock in 500ms preemptible slices
  if (!dryRun && lastBoutFinishedAtMs > 0 && minBoutGapMs > 0) {
    while (true) {
      if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
        return { status: 'preempted-by-snipe', stage: 'during-cooldown' }
      }
      const remMs = lastBoutFinishedAtMs + minBoutGapMs - httpClient.nowMsFn()
      if (remMs <= 0) break
      await httpClient.sleepMsFn(Math.min(500, remMs))
    }
  }

  if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
    return { status: 'preempted-by-snipe', stage: 'before-opponents' }
  }

  const oppResp = await httpClient.getJson('/api/pet/battle/opponents?limit=20&q=')
  const opp = pickArenaOpponent(oppResp?.opponents || [], excludeOpponentIds)
  if (!opp) {
    return { status: 'no-eligible-opponents', usedToday, dailyLimit }
  }

  if (dryRun) {
    return { status: 'dry-run-ready', opponent: opp, usedToday, dailyLimit }
  }

  if (typeof shouldAbortFn === 'function' && shouldAbortFn()) {
    return { status: 'preempted-by-snipe', stage: 'before-gear-lock' }
  }

  const operation = crypto.randomUUID()
  const tacOut = await executeWithTacticalLoadout({
    accountKey,
    lockRoot,
    opponentId: opp.id,
    mode: 'arena',
    knownOpponentLevel: opp.level,
    storePath,
    getGearFn: () => httpClient.getJson('/api/pet/battle/gear'),
    equipSlotFn: (slot, item) => httpClient.postJson('/api/pet/battle/equip', { slot, item }),
    actionFn: async () => {
      const res = await httpClient.postJson('/api/pet/battle', {
        opponent_id: opp.id,
        operation,
      })
      const battleObj = res.body?.fighters ? res.body : res.body?.battle
      if (res.ok && battleObj?.fighters && storePath) {
        recordBattleSnapshot(battleObj, 'arena', { storePath })
      }
      return res
    },
  })

  const finishedAtMs = httpClient.nowMsFn()
  const boutResp = tacOut.result
  if (!boutResp) {
    return {
      status: 'pre-equip-aborted',
      preEquipError: tacOut.preEquipError,
      restoreOk: tacOut.restoreOk,
      finishedAtMs,
    }
  }

  // Open any newly unlocked chest right away inside gear lock
  const newlyOpenedChests = []
  const respChests = boutResp.body?.chests || boutResp.body?.home?.chests || []
  const readyChests = respChests.filter((c) => c && c.ready && !c.opened && c.tier != null)
  if (readyChests.length > 0) {
    await withGearLock(lockRoot, accountKey, async () => {
      for (const ch of readyChests) {
        const cr = await httpClient.postJson('/api/pet/battle/chest', { tier: ch.tier })
        if (cr.ok) newlyOpenedChests.push(ch.tier)
      }
    })
  }

  return {
    status: boutResp.ok ? 'bout-completed' : 'bout-rejected',
    httpStatus: boutResp.status,
    operation,
    opponent: { id: opp.id, name: opp.name, level: opp.level },
    switchedLoadout: tacOut.decision?.switched || false,
    switchedSlots: tacOut.decision?.switchedSlots || [],
    restoreOk: tacOut.restoreOk,
    restoreError: tacOut.restoreError,
    result: boutResp.body?.result ?? boutResp.body?.battle?.result ?? null,
    coinsEarned: boutResp.body?.coins ?? boutResp.body?.reward?.coins ?? 0,
    newlyOpenedChests,
    finishedAtMs,
  }
}

// ---------- Huancai Daily 10D Floor (22:30 CST Cycle Boundary) ----------

export function huancaiCycleStartSec(nowSec) {
  const shift = 8 * 3600 - (22 * 3600 + 30 * 60) // -52200s (aligns 22:30 CST to 00:00 of shifted day)
  return Math.floor((Number(nowSec || 0) + shift) / 86400) * 86400 - shift
}

function generateDeterministicOrRandomLottoTicket() {
  const redPool = Array.from({ length: 33 }, (_, i) => i + 1)
  for (let i = redPool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1)
    const tmp = redPool[i]
    redPool[i] = redPool[j]
    redPool[j] = tmp
  }
  const red = redPool.slice(0, 6).sort((a, b) => a - b)
  const blue = crypto.randomInt(1, 17)
  return { red, blue }
}

export function planHuancaiFloor({
  accountKey = 'main',
  allowHuancaiFloor = accountKey === 'main',
  cashReserveFloor = 0,
  overview,
  ordersData = null,
  localState = null,
  nowSec,
}) {
  if (!allowHuancaiFloor) {
    return { shouldBuy: false, reason: 'disabled-for-account' }
  }
  const round = overview?.round || overview?.current_round || overview?.lotto
  const roundDay = round?.day ?? overview?.day ?? null
  if (!roundDay || round?.closed || round?.status === 'closed') {
    return { shouldBuy: false, reason: 'round-closed-or-unavailable' }
  }

  const cycleStart = huancaiCycleStartSec(nowSec)
  if (localState && (localState.lastCycleStart === cycleStart || localState.lastRoundDay === roundDay)) {
    return { shouldBuy: false, reason: 'already-bought-in-local-state', cycleStart, roundDay }
  }

  const orderList = Array.isArray(ordersData?.orders)
    ? ordersData.orders
    : (Array.isArray(ordersData) ? ordersData : [])
  const boughtInOrders = orderList.some((o) => {
    if (!o) return false
    const isLotto = !o.kind || o.kind === 'lotto'
    if (!isLotto) return false
    if (o.day && String(o.day) === String(roundDay)) return true
    const ts = Number(o.created_at || o.ts || 0)
    return ts >= cycleStart
  })
  if (boughtInOrders) {
    return { shouldBuy: false, reason: 'already-bought-in-server-orders', cycleStart, roundDay }
  }

  const ticketPrice = Number(overview?.prices?.lotto || round?.price || 10)
  const balance = Number(overview?.balance ?? overview?.coins ?? 0)
  if (balance - ticketPrice < Math.max(0, Number(cashReserveFloor || 0))) {
    return {
      shouldBuy: false,
      reason: 'cash-below-reserve-floor',
      balance,
      ticketPrice,
      cashReserveFloor,
    }
  }

  return {
    shouldBuy: true,
    reason: 'eligible-daily-floor',
    cycleStart,
    roundDay,
    ticketPrice,
    balance,
  }
}

export async function runHuancaiDailyCheck(httpClient, {
  accountKey = 'main',
  allowHuancaiFloor = accountKey === 'main',
  cashReserveFloor = 10,
  stateFilePath = null,
  nowSec = null,
  dryRun = false,
} = {}) {
  if (!allowHuancaiFloor) {
    return { status: 'skipped', reason: 'disabled-for-account' }
  }

  const effNow = Number.isFinite(nowSec) ? nowSec : httpClient.estimatedServerNowSec()
  const cycleStart = huancaiCycleStartSec(effNow)

  let localState = {}
  if (stateFilePath && fs.existsSync(stateFilePath)) {
    try {
      localState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8').replace(/^\uFEFF/, '')) || {}
    } catch {}
  }
  if (localState.lastCycleStart === cycleStart) {
    return { status: 'already-satisfied', source: 'local-cache', cycleStart }
  }

  let overview
  let ordersData = null
  try {
    overview = await httpClient.getJson('/api/huancai')
    ordersData = await httpClient.getJson('/api/huancai/orders').catch(() => null)
  } catch (err) {
    return { status: 'fetch-error', error: err?.message || String(err) }
  }

  const decision = planHuancaiFloor({
    accountKey,
    allowHuancaiFloor,
    cashReserveFloor,
    overview,
    ordersData,
    localState,
    nowSec: effNow,
  })

  if (!decision.shouldBuy) {
    if (
      stateFilePath &&
      !dryRun &&
      (decision.reason === 'already-bought-in-server-orders' || decision.reason === 'already-bought-in-local-state')
    ) {
      fs.mkdirSync(path.dirname(stateFilePath), { recursive: true })
      fs.writeFileSync(
        stateFilePath,
        JSON.stringify({ lastCycleStart: cycleStart, lastRoundDay: decision.roundDay, updatedAt: effNow }, null, 2),
        'utf8'
      )
    }
    return { status: 'no-buy', ...decision }
  }

  if (dryRun) {
    return { status: 'dry-run-would-buy', ...decision }
  }

  const buyId = crypto.randomUUID()
  const buyRes = await httpClient.postJson('/api/huancai/buy', {
    id: buyId,
    kind: 'lotto',
    day: decision.roundDay,
    tickets: [generateDeterministicOrRandomLottoTicket()],
  })

  if (buyRes.ok && stateFilePath) {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true })
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        lastCycleStart: cycleStart,
        lastRoundDay: decision.roundDay,
        lastOrderId: buyId,
        updatedAt: effNow,
      }, null, 2),
      'utf8'
    )
  }

  return {
    status: buyRes.ok ? 'bought-daily-floor' : 'buy-rejected',
    httpStatus: buyRes.status,
    orderId: buyId,
    ...decision,
  }
}
