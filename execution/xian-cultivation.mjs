import { sanitizeWorldSnapshot } from '../model/observations.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld, withAccountLock } from './reconcile.mjs'
import {
  XIAN_BREAK,
  XIAN_ECON,
  XIAN_HERBS,
  XIAN_MAX_LV,
  XIAN_NPCS,
  XIAN_PILLS,
  XIAN_QMUL,
  XIAN_SLOTS,
} from '../rules/b16-xian-content.js'
import {
  XIAN_CULT_CAP,
  xianAccrued,
  xianAction,
  xianBase,
  xianBattle,
  xianBreakNeed,
  xianDay,
  xianEffects,
  xianFurnaceBatch,
  xianHerb,
  xianNeed,
  xianNpcEnemy,
  xianPill,
  xianPlotReady,
  xianQtyTotal,
  xianRate,
  xianSpringCharges,
  xianStats,
  xianStoneCost,
  xianStoneDailyMax,
  xianTalent,
  xianToday,
  xianTowerEnemy,
} from '../rules/b16-xian-rules.js'

/**
 * Actions that cross irreversible D-coin CapEx, manual reroll choices, or main-island
 * `iron`/`bomb` inventory boundaries. Strictly forbidden in automated cultivation batches.
 */
export const FORBIDDEN_XIAN_ACTIONS = new Set([
  'xianPlot',
  'xianSpringUp',
  'xianFurnaceUp',
  'xianTalentReroll',
  'xianRootReroll',
  'xianReforge',
  'xianPending',
  'xianForge',
  'xianBombForge',
  'xianPetWash',
  'xianPetRelease',
])

const HERBS_BY_SEED_ASC = [...XIAN_HERBS].sort((a, b) => a.seed - b.seed || a.hours - b.hours)
const CHEAPEST_HERB = HERBS_BY_SEED_ASC[0] || null
const BREAK_STEPS = Object.entries(XIAN_BREAK)
  .map(([lvStr, pillId]) => ({ breakLv: Number(lvStr), pillId }))
  .sort((a, b) => a.breakLv - b.breakLv)
const BREAK_PILL_IDS = new Set(BREAK_STEPS.map((s) => s.pillId))

export function normalizeXianOptions(raw = {}) {
  const dailyStoneQuotaRaw = Number(raw?.dailyStoneQuota ?? 0)
  const dailyStoneQuota = Number.isFinite(dailyStoneQuotaRaw) && dailyStoneQuotaRaw > 0
    ? Math.min(xianStoneDailyMax, Math.floor(dailyStoneQuotaRaw))
    : 0
  const cashReserveRaw = Number(raw?.cashReserveFloor ?? 10)
  const maxActionsRaw = Number(raw?.maxActionsPerBatch ?? 40)
  return {
    enabled: Boolean(raw?.enabled),
    dailyStoneQuota,
    cashReserveFloor: Number.isFinite(cashReserveRaw) ? Math.max(0, cashReserveRaw) : 10,
    maxActionsPerBatch: Number.isFinite(maxActionsRaw)
      ? Math.max(1, Math.min(40, Math.floor(maxActionsRaw)))
      : 40,
  }
}

function createMulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cstHourOf(nowSec) {
  const secInDay = (((Math.floor(nowSec) + 28800) % 86400) + 86400) % 86400
  return secInDay / 3600
}

function nextCstMidnightSec(nowSec) {
  return (xianDay(nowSec) + 1) * 86400 - 28800
}

function highestOwnedPillMultiplier(pills, pillId) {
  const arr = pills?.[pillId]
  if (!Array.isArray(arr)) return 0
  for (let q = 4; q >= 0; q--) {
    if ((arr[q] || 0) > 0) return XIAN_QMUL[q]
  }
  return 0
}

function bagTakeSim(bag, id, n, best = false) {
  const arr = bag?.[id]
  if (!arr || xianQtyTotal(bag, id) < n) return null
  let left = n
  const order = best ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4]
  for (const q of order) {
    const k = Math.min(left, arr[q] || 0)
    if (k > 0) {
      arr[q] -= k
      left -= k
    }
    if (!left) break
  }
  if (!arr.some(Boolean)) delete bag[id]
  return true
}

/**
 * Computes true combat effectiveness of a cultivation loadout (`eq` + active `pet`),
 * capturing weapon specials (`gun` 3x0.45x(1+gunBoost), `cannon` 1.5x avg), armor pierce,
 * freeze control, shield/regen/dodge/guard EHP, and speed initiative.
 */
export function effectiveCombatScore(x, { overrideEq = null, overridePet = undefined } = {}) {
  if (!x?.v) return 0
  const view = {
    ...x,
    eq: overrideEq ? { ...(x.eq || {}), ...overrideEq } : (x.eq || {}),
    pet: overridePet !== undefined ? overridePet : x.pet,
  }
  const s = xianStats(view, { pet: true, buff: false })
  const baseHitMult = s.wsp === 'gun'
    ? 3 * 0.45 * (1 + (s.gunBoost || 0))
    : (s.wsp === 'cannon' ? (1 + 1 + 2.5) / 3 : 1.0)
  const critFactor = 1 + s.crit * (s.critDmg - 1) + 0.08 * (s.firstCrit || 0)
  const doubleFactor = 1 + (s.double || 0)
  const pierceFactor = 1 + 0.25 * (s.pierce || 0)
  const burnFactor = 1 + 0.75 * (s.burn || 0)
  const controlFactor = 1 / Math.max(0.55, 1 - 0.75 * (s.freeze || 0))
  const lateLowFactor = 1 + 0.18 * (s.late || 0) + 0.12 * (s.lowAtk || 0) + 0.08 * (s.elem || 0)
  const dps = s.atk * baseHitMult * critFactor * doubleFactor * pierceFactor * burnFactor * controlFactor * lateLowFactor

  const K = 50 + (s.lv || 1) * 12
  const armorMitigation = 1 + s.def / K
  const sustainMult = 1 + (s.shield || 0) + 6 * (s.regen || 0) + 0.45 * (s.lifesteal || 0) + 0.25 * (s.thorns || 0)
  const avoidDenom = Math.max(0.25, (1 - (s.dodge || 0)) * (1 - (s.guard || 0)))
  const ehp = (s.hp * armorMitigation * sustainMult) / avoidDenom
  const spdFactor = 1 + 0.008 * s.spd
  return Math.sqrt(Math.max(1, dps * ehp)) * spdFactor
}

export function estimateBattleWinProb(x, enemy, { trials = 36, seed = 0x51a9b16, withCarry = undefined } = {}) {
  if (!x?.v || !enemy) return 0
  const me = { ...xianStats(x, { pet: true, buff: true }), name: '我' }
  const useCarry = withCarry !== undefined ? Boolean(withCarry) : Boolean(x.carry)
  const healPill = useCarry ? highestOwnedPillMultiplier(x.pills, 'heal') : 0
  const rng = createMulberry32(seed ^ ((enemy.lv || 1) * 2654435761))
  let wins = 0
  let pillTriggered = 0
  for (let i = 0; i < trials; i++) {
    const res = xianBattle(me, enemy, rng, { healPill })
    if (res.win) wins++
    if (healPill > 0 && res.log.some((row) => row[1] === 'pill' && row[0] === 0)) {
      pillTriggered++
    }
  }
  return {
    winProb: wins / trials,
    pillTriggerRate: pillTriggered / trials,
  }
}

function buildPillDemandPlan(x, confirmedPills, nowSec) {
  const lv = x.lv || 1
  const list = []

  // 1. Primary realm breakthrough pills derived table-driven from `XIAN_BREAK`
  const nextBreak = BREAK_STEPS.find((s) => lv <= s.breakLv)
  if (nextBreak) {
    const urgent = lv >= nextBreak.breakLv - 2
    list.push({ id: nextBreak.pillId, targetQty: 2, best: true, urgent, weight: urgent ? 3.2 : 2.2 })
  }

  // 2. Minimum combat heal pill buffer
  list.push({ id: 'heal', targetQty: 2, best: false, urgent: true, weight: 2.0 })

  // 3. Stockpile manual reroll pills (`marrow` / `insight`) so user can reroll anytime without waiting
  if ((x.root?.g ?? 0) < 4 && lv >= 5) {
    list.push({ id: 'marrow', targetQty: 2, best: false, urgent: false, weight: 1.35 })
  }
  const hasSuboptimalTalent = (x.talents || []).some((tid) => (xianTalent(tid)?.r || 1) < 4)
  if (hasSuboptimalTalent && lv >= 6) {
    list.push({ id: 'insight', targetQty: 2, best: false, urgent: false, weight: 1.25 })
  }

  // 4. Cultivation XP & pet growth & comfortable heal/buff reserves
  if (lv < XIAN_MAX_LV) {
    list.push({ id: 'qi', targetQty: 4, best: true, urgent: false, weight: 1.4 })
  }
  if ((x.pets || []).some((p) => nowSec >= p.h && (p.gr || 0) < 300)) {
    list.push({ id: 'beast', targetQty: 2, best: true, urgent: false, weight: 1.2 })
  }
  list.push({ id: 'heal', targetQty: 4, best: false, urgent: false, weight: 0.9 })
  if (lv >= 8) {
    list.push({ id: 'rage', targetQty: 2, best: true, urgent: false, weight: 0.85 })
    list.push({ id: 'stone', targetQty: 1, best: true, urgent: false, weight: 0.75 })
    if ((x.pets || []).some((p) => nowSec >= p.h)) {
      list.push({ id: 'spirit', targetQty: 1, best: false, urgent: false, weight: 0.7 })
    }
  }

  // Deduplicate keeping max targetQty per pill id while preserving first-seen priority order
  const merged = new Map()
  for (const row of list) {
    const have = xianQtyTotal(confirmedPills, row.id)
    const deficit = Math.max(0, row.targetQty - have)
    if (deficit <= 0) continue
    const prev = merged.get(row.id)
    if (!prev) {
      merged.set(row.id, { ...row, have, deficit })
    } else {
      prev.targetQty = Math.max(prev.targetQty, row.targetQty)
      prev.deficit = Math.max(0, prev.targetQty - have)
      prev.urgent = prev.urgent || row.urgent
      prev.weight = Math.max(prev.weight, row.weight)
    }
  }
  return [...merged.values()]
}

function chooseProtectedItemIds(x) {
  const protectedIds = new Set()
  for (const eqId of Object.values(x.eq || {})) {
    if (eqId != null) protectedIds.add(eqId)
  }
  if (x.pend?.k === 'i' && x.pend.i != null) {
    protectedIds.add(x.pend.i)
  }
  for (const it of x.items || []) {
    const base = xianBase(it.b)
    // Protect special-mechanic weapons (bomb-forged bases excluded from Tower drops) and high-grade gear (`仙器`/`神器`)
    if ((base?.k === 'weapon' && Boolean(base?.sp)) || (it.g || 0) >= 3) {
      protectedIds.add(it.id)
    }
  }
  for (const slot of Object.keys(XIAN_SLOTS)) {
    const slotItems = (x.items || [])
      .filter((it) => xianBase(it.b)?.k === slot)
      .map((it) => ({
        it,
        score: effectiveCombatScore(x, { overrideEq: { [slot]: it.id } }),
      }))
      .sort((a, b) => b.score - a.score || (b.it.g || 0) - (a.it.g || 0) || (b.it.lv || 0) - (a.it.lv || 0))
    for (const keep of slotItems.slice(0, 2)) {
      protectedIds.add(keep.it.id)
    }
  }
  return protectedIds
}

function npcGiftUtility(npc, x) {
  const g = npc.gift || {}
  let val = (npc.lv || 1) * 1.5
  if (g.stone) val += g.stone
  if (g.seed) {
    const h = xianHerb(g.seed)
    val += (h ? h.seed : 10) * (g.n || 1) * 1.25
  }
  if (g.pill) {
    const p = xianPill(g.pill)
    val += (p ? p.price : 20) * (g.n || 1) * 1.2
  }
  if ((x.lv || 1) >= XIAN_MAX_LV) val -= (npc.lv || 1) * 1.2
  return val
}

export function assertSafeXianBatch(actions, worldBefore, rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!Array.isArray(actions)) {
    throw new Error('Xian batch actions must be an array')
  }
  if (actions.length > opts.maxActionsPerBatch) {
    throw new Error(`Xian batch length ${actions.length} exceeds maxActionsPerBatch=${opts.maxActionsPerBatch}`)
  }
  let stoneBuyTotalCoins = 0
  const x = worldBefore?.state?.xian
  const nowSec = Number(worldBefore?.now || 0)
  let boughtToday = x?.v && x.dy?.d === xianDay(nowSec) ? Number(x.dy.stone || 0) : 0

  for (const act of actions) {
    const a = String(act?.a || '')
    if (!a.startsWith('xian')) {
      throw new Error(`Non-xian action leaked into xian batch: ${a}`)
    }
    if (FORBIDDEN_XIAN_ACTIONS.has(a)) {
      throw new Error(`Forbidden xian action blocked by firewall: ${a}`)
    }
    if (a === 'xianTower' && act.pay === true) {
      throw new Error('Paid xianTower is strictly forbidden by D-coin firewall')
    }
    if (a === 'xianStoneBuy') {
      if (opts.dailyStoneQuota <= 0) {
        throw new Error('xianStoneBuy blocked when dailyStoneQuota=0')
      }
      const n = Number(act.n || 0)
      if (!Number.isInteger(n) || n < 1 || boughtToday + n > opts.dailyStoneQuota) {
        throw new Error(`xianStoneBuy exceeds configured dailyStoneQuota=${opts.dailyStoneQuota}`)
      }
      const cost = xianStoneCost(boughtToday, n)
      if (cost == null) {
        throw new Error('Invalid xianStoneBuy tier cost')
      }
      stoneBuyTotalCoins += cost
      boughtToday += n
    }
  }
  if (stoneBuyTotalCoins > 0) {
    const availCoins = Number(worldBefore?.coins || 0) - opts.cashReserveFloor
    if (stoneBuyTotalCoins > availCoins) {
      throw new Error(`xianStoneBuy cost ${stoneBuyTotalCoins} violates cashReserveFloor=${opts.cashReserveFloor}`)
    }
  }
  return { expectedSpendCoins: stoneBuyTotalCoins }
}

/**
 * Deterministic single-batch planner for `b16 云梦仙途`.
 * Never guesses stochastic server drops/yields inside the same batch; if a stochastic action
 * (`xianEnter`, `xianHarvest`, `xianCollect`, `xianBreak`, `xianTower`, uncertain `xianDuel`)
 * executes, sets `followUpSoon: true` so the next tick inspects the authoritative server outcome.
 */
export function planXianActions(world, nowSec = Number(world?.now || 0), rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!opts.enabled) {
    return {
      enabled: false,
      actions: [],
      expectedSpendCoins: 0,
      followUpSoon: false,
      reason: 'disabled',
    }
  }
  if (!world || !world.state) {
    return {
      enabled: true,
      actions: [],
      expectedSpendCoins: 0,
      followUpSoon: false,
      reason: 'missing-world-state',
    }
  }

  const t = Math.floor(Number(nowSec || world.now || 0))
  const stateCopy = structuredClone(world.state)
  let simCoins = Number(world.coins || 0)
  let expectedSpendCoins = 0
  let followUpSoon = false
  const actions = []
  const simRng = createMulberry32((t ^ Number(world.rev || 1)) >>> 0)

  const canPush = (reserve = 0) => actions.length + reserve < opts.maxActionsPerBatch
  const emit = (act) => {
    if (!canPush(0)) return null
    if (!String(act?.a || '').startsWith('xian') || FORBIDDEN_XIAN_ACTIONS.has(act.a)) {
      throw new Error(`Blocked illegal xian action candidate: ${act?.a}`)
    }
    const res = xianAction(stateCopy, act, { t, coins: simCoins, rand: simRng })
    if (!res || !res.ok) return null
    const sp = Number(res.spend || 0)
    if (sp > 0) {
      simCoins -= sp
      expectedSpendCoins += sp
    }
    actions.push(act)
    return res
  }

  // Step 0: Free initial entry (`xianEnter`) + starter deterministic bootstrap
  if (!stateCopy.xian?.v) {
    emit({ a: 'xianEnter' })
    emit({ a: 'xianCarry', on: true })
    if (opts.dailyStoneQuota > 0 && canPush()) {
      const maxBuy = Math.min(opts.dailyStoneQuota, xianStoneDailyMax)
      for (let n = maxBuy; n >= 1; n--) {
        const c = xianStoneCost(0, n)
        if (c != null && simCoins - c >= opts.cashReserveFloor) {
          emit({ a: 'xianStoneBuy', n })
          break
        }
      }
    }
    for (const npc of XIAN_NPCS) {
      if (!canPush(4)) break
      emit({ a: 'xianTalk', id: npc.id })
    }
    if (CHEAPEST_HERB) {
      emit({ a: 'xianPlant', i: 'all', id: CHEAPEST_HERB.id })
    }
    emit({ a: 'xianWater', i: 'all' })
    assertSafeXianBatch(actions, world, opts)
    return {
      enabled: true,
      actions,
      expectedSpendCoins,
      followUpSoon: true,
      reason: 'bootstrap-enter',
    }
  }

  const x = stateCopy.xian
  const dy = xianToday(x, t)

  // Step 1: Optional configured daily D-coin -> spirit stone exchange (`0` by default)
  if (opts.dailyStoneQuota > dy.stone && canPush()) {
    const remQuota = Math.min(opts.dailyStoneQuota - dy.stone, xianStoneDailyMax - dy.stone)
    let chosenN = 0
    for (let n = remQuota; n >= 1; n--) {
      const c = xianStoneCost(dy.stone, n)
      if (c != null && simCoins - c >= opts.cashReserveFloor) {
        chosenN = n
        break
      }
    }
    if (chosenN >= 1) {
      emit({ a: 'xianStoneBuy', n: chosenN })
    }
  }

  // Step 2: Daily free talks with all 21 NPCs (~268 free spirit stones/day)
  for (const npc of XIAN_NPCS) {
    if (!canPush()) break
    if (!dy.talk.includes(npc.id)) {
      emit({ a: 'xianTalk', id: npc.id })
    }
  }

  // Snapshot pre-existing deterministic herbs & pills BEFORE stochastic `xianHarvest` / `xianCollect`
  const confirmedHerbs = structuredClone(x.herbs || {})
  const confirmedPills = structuredClone(x.pills || {})
  let confirmedStone = Number(x.stone || 0)

  // Step 3: Harvest ready spirit plots & collect finished furnace job
  if (x.plots.some((p) => xianPlotReady(p, t)) && canPush()) {
    if (emit({ a: 'xianHarvest' })) {
      followUpSoon = true
    }
  }
  if (x.job && t >= x.job.done && canPush()) {
    if (emit({ a: 'xianCollect' })) {
      followUpSoon = true
    }
  }
  // Sync deterministic stone balance (`xianTalk` added deterministic stones; `xianHarvest`/`xianCollect` do not change `x.stone`)
  confirmedStone = Number(x.stone || 0)

  // Step 4: Breakthrough (`xianBreak`) BEFORE `xianCultivate` / `xianEat('qi')` to shield accrued XP from 20% fail loss
  let attemptedBreak = false
  const brkNeed = xianBreakNeed(x)
  const xpNeed = xianNeed(x.lv)
  if (brkNeed && x.xp >= xpNeed && xianQtyTotal(confirmedPills, brkNeed) >= 1 && canPush()) {
    if (emit({ a: 'xianBreak' })) {
      bagTakeSim(confirmedPills, brkNeed, 1, true)
      attemptedBreak = true
      followUpSoon = true
    }
  }

  if (!attemptedBreak) {
    const acc = xianAccrued(x, t)
    const elapsedCult = Math.max(0, t - (x.cAt || t))
    const canLevelUpNow = x.lv < XIAN_MAX_LV && !brkNeed && (x.xp + acc) >= xpNeed
    const canReachBreakNow = Boolean(brkNeed) && x.xp < xpNeed && (x.xp + acc) >= xpNeed
    const nearCap = elapsedCult >= 12 * 3600
    if (acc > 0 && (canLevelUpNow || canReachBreakNow || nearCap) && canPush()) {
      emit({ a: 'xianCultivate' })
    }

    // Consume `qi` (`聚气丹`) when below max level and not sitting at a full-XP breakthrough wall
    while (canPush() && x.lv < XIAN_MAX_LV && xianQtyTotal(confirmedPills, 'qi') > 0) {
      const curBrk = xianBreakNeed(x)
      const curNeed = xianNeed(x.lv)
      if (curBrk && x.xp >= curNeed) break
      if (!emit({ a: 'xianEat', id: 'qi', best: true })) break
      bagTakeSim(confirmedPills, 'qi', 1, true)
    }
  }

  // Re-check if leveling / `qi` pills just unlocked a breakthrough in the same batch!
  if (!attemptedBreak && canPush()) {
    const brkAfter = xianBreakNeed(x)
    if (brkAfter && x.xp >= xianNeed(x.lv) && xianQtyTotal(confirmedPills, brkAfter) >= 1) {
      if (emit({ a: 'xianBreak' })) {
        bagTakeSim(confirmedPills, brkAfter, 1, true)
        attemptedBreak = true
        followUpSoon = true
      }
    }
  }

  // Step 5: Optimal gear equip (`xianEquip`) & safe bag cleanup (`xianSalvage`)
  for (let pass = 0; pass < 2; pass++) {
    let changed = false
    for (const slot of Object.keys(XIAN_SLOTS)) {
      if (!canPush()) break
      const candidates = (x.items || []).filter((it) => xianBase(it.b)?.k === slot)
      if (candidates.length === 0) continue
      let bestId = x.eq?.[slot] ?? null
      let bestScore = bestId != null ? effectiveCombatScore(x) : 0
      for (const it of candidates) {
        const sc = effectiveCombatScore(x, { overrideEq: { [slot]: it.id } })
        if (sc > bestScore + 1e-6) {
          bestScore = sc
          bestId = it.id
        }
      }
      if (bestId != null && x.eq?.[slot] !== bestId) {
        if (emit({ a: 'xianEquip', id: bestId })) {
          changed = true
        }
      }
    }
    if (!changed) break
  }

  const emptyPlotCountBeforePlant = x.plots.filter((p) => !p).length
  const totalSeedsOwned = Object.values(x.seeds || {}).reduce((s, v) => s + (v || 0), 0)
  const needStoneRescue = confirmedStone < 24 && emptyPlotCountBeforePlant > 0 && totalSeedsOwned === 0
  if (((x.items || []).length >= 22 || needStoneRescue) && canPush()) {
    const protectedIds = chooseProtectedItemIds(x)
    const salvageable = (x.items || [])
      .filter((it) => !protectedIds.has(it.id))
      .map((it) => {
        const slot = xianBase(it.b)?.k || 'weapon'
        return {
          it,
          score: effectiveCombatScore(x, { overrideEq: { [slot]: it.id } }),
        }
      })
      .sort((a, b) => a.score - b.score || (a.it.g || 0) - (b.it.g || 0))

    for (const cand of salvageable) {
      if (!canPush()) break
      const stillCrowded = (x.items || []).length > 20
      const stillNeedRescue = needStoneRescue && confirmedStone < 40
      if (!stillCrowded && !stillNeedRescue) break
      const gain = 20 * ((cand.it.g || 0) + 1) * ((cand.it.g || 0) + 1)
      if (emit({ a: 'xianSalvage', id: cand.it.id })) {
        confirmedStone += gain
      }
    }
  }

  // Step 6: Furnace alchemy (`xianBrew`) using pre-confirmed herbs so server success is 100% deterministic
  const pillPlan = buildPillDemandPlan(x, confirmedPills, t)
  if (!x.job && canPush()) {
    const eff = xianEffects(x)
    const hardRate = Math.min(0.98, 0.70 + ((x.furnace || 1) - 1) * 0.05 + (eff.pillRate || 0) - 0.10)
    for (const target of pillPlan) {
      const pDef = xianPill(target.id)
      if (!pDef) continue
      const maxByHerbs = Math.min(
        ...Object.entries(pDef.in).map(([hid, req]) => Math.floor(xianQtyTotal(confirmedHerbs, hid) / req))
      )
      if (maxByHerbs < 1) continue
      const batchCap = xianFurnaceBatch(x)
      const isSingleUsePill = BREAK_PILL_IDS.has(target.id) || ['marrow', 'insight', 'spirit'].includes(target.id)
      const wantCap = isSingleUsePill
        ? Math.min(batchCap, target.deficit + 1)
        : Math.min(batchCap, Math.max(target.deficit, 2))
      const n = Math.max(1, Math.min(maxByHerbs, wantCap))
      const fire = target.best && hardRate >= 0.85 ? 'hard' : 'soft'
      if (emit({ a: 'xianBrew', id: target.id, n, fire, best: target.best })) {
        for (const [hid, req] of Object.entries(pDef.in)) {
          bagTakeSim(confirmedHerbs, hid, req * n, target.best)
        }
        break
      }
    }
  }

  // Step 7: Spirit pets (activate best hatched pet, feed `beast` pills, daily herb feed -> claim feathers -> sell feathers, buy eggs)
  const hatchedPetIndices = (x.pets || [])
    .map((p, idx) => (t >= p.h ? idx : -1))
    .filter((idx) => idx >= 0)

  if (hatchedPetIndices.length > 0 && canPush()) {
    let bestPetIdx = x.pet
    let bestPetScore = x.pet >= 0 && t >= (x.pets[x.pet]?.h || Infinity) ? effectiveCombatScore(x) : -1
    for (const idx of hatchedPetIndices) {
      const sc = effectiveCombatScore(x, { overridePet: idx })
      if (sc > bestPetScore + 1e-6) {
        bestPetScore = sc
        bestPetIdx = idx
      }
    }
    if (bestPetIdx >= 0 && x.pet !== bestPetIdx) {
      emit({ a: 'xianPetActive', i: bestPetIdx })
    }

    while (canPush() && xianQtyTotal(confirmedPills, 'beast') > 0) {
      const growCandidates = hatchedPetIndices
        .filter((idx) => (x.pets[idx]?.gr || 0) < 300)
        .sort((a, b) => (a === x.pet ? -1 : b === x.pet ? 1 : (x.pets[b].gr || 0) - (x.pets[a].gr || 0)))
      if (growCandidates.length === 0) break
      const targetIdx = growCandidates[0]
      if (!emit({ a: 'xianEat', id: 'beast', i: targetIdx, best: true })) break
      bagTakeSim(confirmedPills, 'beast', 1, true)
    }

    // Feed 1 cheapest herb to any unfed hatched pet today to unlock its daily feathers (30~90 stones!),
    // plus surplus cheapest herbs for pets still growing toward `gr = 300` (`灵化`).
    for (const idx of hatchedPetIndices) {
      if (!canPush()) break
      const pet = x.pets[idx]
      const fedToday = pet.fd === dy.d ? (pet.fn || 0) : 0
      if (fedToday === 0) {
        for (const h of HERBS_BY_SEED_ASC.filter((cand) => cand.hours <= 8)) {
          if (xianQtyTotal(confirmedHerbs, h.id) >= 1) {
            if (emit({ a: 'xianPetFeed', i: idx, id: h.id, n: 1, best: false })) {
              bagTakeSim(confirmedHerbs, h.id, 1, false)
            }
            break
          }
        }
      }
      const fedNow = pet.fd === dy.d ? (pet.fn || 0) : 0
      const room = XIAN_ECON.feedDaily - fedNow
      if (CHEAPEST_HERB && (pet.gr || 0) < 300 && room > 0 && canPush()) {
        const spareCheap = Math.max(0, xianQtyTotal(confirmedHerbs, CHEAPEST_HERB.id) - 10)
        const feedN = Math.min(room, spareCheap)
        if (feedN >= 1) {
          if (emit({ a: 'xianPetFeed', i: idx, id: CHEAPEST_HERB.id, n: feedN, best: false })) {
            bagTakeSim(confirmedHerbs, CHEAPEST_HERB.id, feedN, false)
          }
        }
      }
    }

    if ((x.pets || []).some((p) => t >= p.h && p.fd === dy.d && p.pd !== dy.d) && canPush()) {
      emit({ a: 'xianPetClaim' })
    }
  }

  if ((x.mats?.feather || 0) > 0 && canPush()) {
    const fn = x.mats.feather
    if (emit({ a: 'xianSell', kind: 'mat', id: 'feather', q: 0, n: fn })) {
      confirmedStone += 30 * fn
    }
  }

  // Buy spirit pet eggs (`800` stones) once seed working reserve is comfortable
  const seedWorkingReserve = Math.max(120, x.plots.length * 25)
  while (
    canPush() &&
    (x.pets || []).length < XIAN_ECON.petMax &&
    confirmedStone >= XIAN_ECON.egg + seedWorkingReserve
  ) {
    if (!emit({ a: 'xianEggBuy' })) break
    confirmedStone -= XIAN_ECON.egg
  }

  // Step 8: Spirit field seed replenishment, planting (`xianPlant`), & spring watering (`xianWater`)
  const emptyIndices = x.plots.map((p, idx) => (p ? -1 : idx)).filter((idx) => idx >= 0)
  const minSeedCost = CHEAPEST_HERB?.seed || 4
  if (emptyIndices.length > 0 && canPush()) {
    // Emergency anti-deadlock: if 0 seeds and stones < minSeedCost, sell 1~2 surplus low-q herbs to fund starter seeds
    const ownedSeedsTotal = Object.values(x.seeds || {}).reduce((s, v) => s + (v || 0), 0)
    if (confirmedStone < minSeedCost && ownedSeedsTotal === 0) {
      for (const h of XIAN_HERBS) {
        if (confirmedStone >= minSeedCost * 3 || !canPush()) break
        for (let q = 0; q <= 2; q++) {
          const cnt = confirmedHerbs?.[h.id]?.[q] || 0
          if (cnt > 0) {
            const sellN = Math.min(cnt, 2)
            if (emit({ a: 'xianSell', kind: 'herb', id: h.id, q, n: sellN })) {
              confirmedHerbs[h.id][q] -= sellN
              confirmedStone += Math.floor(h.price * XIAN_QMUL[q] * sellN)
              break
            }
          }
        }
      }
    }

    const growingByHerb = {}
    for (const p of x.plots) {
      if (p?.h) growingByHerb[p.h] = (growingByHerb[p.h] || 0) + 1
    }

    // Aggregate weighted herb demand table-driven from `XIAN_HERBS` & active pill deficits
    const herbNeed = {}
    const herbWeight = {}
    for (const h of XIAN_HERBS) {
      if (h.hours <= 2) {
        herbNeed[h.id] = 9 + hatchedPetIndices.length * 2
      } else if (h.hours <= 6) {
        herbNeed[h.id] = 6
      } else if (h.hours <= 9) {
        herbNeed[h.id] = x.lv >= 4 ? 6 : 3
      } else {
        herbNeed[h.id] = x.lv >= Math.max(5, Math.floor(h.hours / 2)) ? 4 : 0
      }
      herbWeight[h.id] = 1 + Math.min(0.35, h.hours / 70)
    }
    for (const target of buildPillDemandPlan(x, confirmedPills, t)) {
      const pDef = xianPill(target.id)
      if (!pDef) continue
      for (const [hid, req] of Object.entries(pDef.in)) {
        herbNeed[hid] = (herbNeed[hid] || 0) + req * target.deficit
        herbWeight[hid] = Math.max(herbWeight[hid] || 1, target.weight)
      }
    }

    const totalPlots = x.plots.length
    const maxConcurrentForHerb = (h) => {
      if (h.hours >= 20) {
        const urgentLongHerb = BREAK_STEPS.some(
          (bs) =>
            x.lv >= bs.breakLv - 1 &&
            xianQtyTotal(confirmedPills, bs.pillId) < 1 &&
            (xianPill(bs.pillId)?.in?.[h.id] || 0) > 0
        )
        return urgentLongHerb ? Math.max(2, Math.ceil(totalPlots * 0.6)) : Math.max(1, Math.floor(totalPlots / 3))
      }
      if (h.hours >= 10) {
        return Math.max(2, Math.floor(totalPlots / 2))
      }
      return totalPlots
    }

    const plannedPerPlot = []
    const simSeeds = { ...(x.seeds || {}) }
    const simGrowing = { ...growingByHerb }
    let budgetStone = confirmedStone

    for (let slotIdx = 0; slotIdx < emptyIndices.length; slotIdx++) {
      const remEmptyAfterThis = emptyIndices.length - slotIdx - 1
      let chosenHerb = null
      let bestPriority = -Infinity

      for (const h of XIAN_HERBS) {
        if ((simGrowing[h.id] || 0) >= maxConcurrentForHerb(h)) continue
        const haveFreeSeed = (simSeeds[h.id] || 0) > 0
        // Keep enough stones (`minSeedCost * remEmptyAfterThis`) so remaining empty plots can afford starter seeds!
        if (!haveFreeSeed && budgetStone - h.seed < remEmptyAfterThis * minSeedCost) continue
        const projectedSupply =
          xianQtyTotal(confirmedHerbs, h.id) +
          (simGrowing[h.id] || 0) * 3.3 +
          Math.max(0, (simSeeds[h.id] || 0) - (haveFreeSeed ? 0 : 0)) * 3.3
        const deficit = (herbNeed[h.id] || 0) - projectedSupply
        const rootMatchBonus = (x.root?.e || []).includes(h.el) ? 0.15 : 0
        const score = deficit > 0
          ? (deficit / Math.max(3, herbNeed[h.id] || 3)) * 10 * (herbWeight[h.id] || 1) + rootMatchBonus + (haveFreeSeed ? 0.5 : 0)
          : -h.hours * 0.1 + rootMatchBonus + (haveFreeSeed ? 1.0 : 0)
        if (score > bestPriority) {
          bestPriority = score
          chosenHerb = h
        }
      }

      if (!chosenHerb) {
        const fallback = XIAN_HERBS.find((h) => (simSeeds[h.id] || 0) > 0 || budgetStone >= h.seed)
        if (!fallback) break
        chosenHerb = fallback
      }

      if ((simSeeds[chosenHerb.id] || 0) > 0) {
        simSeeds[chosenHerb.id]--
      } else {
        budgetStone -= chosenHerb.seed
      }
      simGrowing[chosenHerb.id] = (simGrowing[chosenHerb.id] || 0) + 1
      plannedPerPlot.push({ plotIndex: emptyIndices[slotIdx], herbId: chosenHerb.id })
    }

    // Aggregate seed purchases per herb id first so batch stays compact
    const buyCounts = {}
    const curSeedsSnapshot = { ...(x.seeds || {}) }
    for (const item of plannedPerPlot) {
      if ((curSeedsSnapshot[item.herbId] || 0) > 0) {
        curSeedsSnapshot[item.herbId]--
      } else {
        buyCounts[item.herbId] = (buyCounts[item.herbId] || 0) + 1
      }
    }
    for (const [hid, cnt] of Object.entries(buyCounts)) {
      if (cnt > 0 && canPush(2)) {
        if (emit({ a: 'xianSeedBuy', id: hid, n: cnt })) {
          confirmedStone = Number(x.stone || 0)
        }
      }
    }

    // If all planned plots share the same herb id and cover all empty plots, collapse into `{ a: 'xianPlant', i: 'all', id }`
    const distinctHerbs = [...new Set(plannedPerPlot.map((p) => p.herbId))]
    if (distinctHerbs.length === 1 && plannedPerPlot.length === emptyIndices.length && canPush()) {
      emit({ a: 'xianPlant', i: 'all', id: distinctHerbs[0] })
    } else {
      for (const item of plannedPerPlot) {
        if (!canPush()) break
        emit({ a: 'xianPlant', i: item.plotIndex, id: item.herbId })
      }
    }
  }

  // Water highest-value unwatered growing plots with remaining Spirit Spring charges
  const remWater = xianSpringCharges(x) - dy.water
  if (remWater > 0 && canPush()) {
    const cstHour = cstHourOf(t)
    const waterCandidates = x.plots
      .map((p, idx) => {
        if (!p || p.w || xianPlotReady(p, t)) return null
        const h = xianHerb(p.h)
        if (!h) return null
        // Preserve scarce spring charges for >2h herbs during daytime once past Lv3 unless matching root element
        if (
          h.hours <= 2 &&
          (x.lv || 1) >= 4 &&
          cstHour < 17 &&
          remWater <= 3 &&
          !(x.root?.e || []).includes(h.el)
        ) {
          return null
        }
        const rootMult = (x.root?.e || []).includes(h.el) ? 1.35 : 1.0
        return { idx, priority: h.price * rootMult }
      })
      .filter(Boolean)
      .sort((a, b) => b.priority - a.priority)

    const toWater = waterCandidates.slice(0, remWater)
    const allUnwateredCount = x.plots.filter((p) => p && !p.w && !xianPlotReady(p, t)).length
    if (toWater.length > 0 && toWater.length === allUnwateredCount && toWater.length <= remWater) {
      emit({ a: 'xianWater', i: 'all' })
    } else {
      for (const wc of toWater) {
        if (!canPush()) break
        emit({ a: 'xianWater', i: wc.idx })
      }
    }
  }

  // Step 9: Combat — NPC Duels (`xianDuel`, 10/day) & Free Secret Tower (`xianTower`, 5/day, NEVER paid!)
  const haveHealForCombat = xianQtyTotal(confirmedPills, 'heal') > 0
  const cstHour = cstHourOf(t)

  if (dy.duel < 10 && canPush(2)) {
    const unbeatenNpcs = XIAN_NPCS
      .filter((npc) => !dy.won.includes(npc.id))
      .map((npc) => {
        const enemy = xianNpcEnemy(npc)
        const sim = estimateBattleWinProb(x, enemy, {
          trials: 36,
          seed: (t ^ (npc.lv * 9973)) >>> 0,
          withCarry: haveHealForCombat,
        })
        return {
          npc,
          enemy,
          winProb: sim.winProb,
          pillTriggerRate: sim.pillTriggerRate,
          utility: npcGiftUtility(npc, x),
        }
      })

    const sureWins = unbeatenNpcs
      .filter((c) => c.winProb >= 0.98 && (!haveHealForCombat || c.pillTriggerRate <= 0.05))
      .sort((a, b) => b.utility - a.utility)

    if (sureWins.length > 0) {
      if (haveHealForCombat && !x.carry) emit({ a: 'xianCarry', on: true })
      const quotaLeft = 10 - dy.duel
      for (const sw of sureWins.slice(0, quotaLeft)) {
        if (!canPush()) break
        emit({ a: 'xianDuel', id: sw.npc.id })
      }
      if (dy.duel < 10 && unbeatenNpcs.length > sureWins.length) {
        followUpSoon = true
      }
    } else {
      const minDuelWinProb = cstHour >= 21 ? 0.08 : 0.45
      const viable = unbeatenNpcs
        .filter((c) => c.winProb >= minDuelWinProb)
        .sort((a, b) => (b.winProb * b.utility) - (a.winProb * a.utility))

      if (viable.length > 0 && canPush(2)) {
        const pick = viable[0]
        if (haveHealForCombat && !x.carry) emit({ a: 'xianCarry', on: true })
        if (pick.winProb < 0.85 && !x.buff?.atk && xianQtyTotal(confirmedPills, 'rage') > 0 && canPush(2)) {
          if (emit({ a: 'xianEat', id: 'rage', best: true })) {
            bagTakeSim(confirmedPills, 'rage', 1, true)
          }
        }
        if (emit({ a: 'xianDuel', id: pick.npc.id })) {
          followUpSoon = true
        }
      }
    }
  }

  // Secret Tower: strictly free tries only (`dy.tower < XIAN_ECON.towerFree`), 1 floor per batch so new gear equips immediately
  if (dy.tower < XIAN_ECON.towerFree && (x.items || []).length < XIAN_ECON.bagMax && canPush(2)) {
    const nextFloor = (x.tw?.f || 0) + 1
    const towerEnemy = xianTowerEnemy(nextFloor)
    const simWithHeal = estimateBattleWinProb(x, towerEnemy, {
      trials: 40,
      seed: (t ^ (nextFloor * 131071)) >>> 0,
      withCarry: haveHealForCombat,
    })
    const simNoHeal = estimateBattleWinProb(x, towerEnemy, {
      trials: 40,
      seed: (t ^ (nextFloor * 131071)) >>> 0,
      withCarry: false,
    })

    if (simWithHeal.winProb >= 0.25) {
      if (haveHealForCombat && !x.carry && canPush(2)) {
        emit({ a: 'xianCarry', on: true })
      }
      if (simWithHeal.winProb < 0.85 && nextFloor % 10 === 0) {
        if (!x.buff?.atk && xianQtyTotal(confirmedPills, 'rage') > 0 && canPush(2)) {
          if (emit({ a: 'xianEat', id: 'rage', best: true })) bagTakeSim(confirmedPills, 'rage', 1, true)
        }
        if (!x.buff?.def && xianQtyTotal(confirmedPills, 'stone') > 0 && canPush(2)) {
          if (emit({ a: 'xianEat', id: 'stone', best: true })) bagTakeSim(confirmedPills, 'stone', 1, true)
        }
      }
      if (emit({ a: 'xianTower' })) {
        followUpSoon = true
      }
    } else if (cstHour >= 21 && simWithHeal.winProb >= 0.03) {
      // Late-day free quota hail-mary; avoid wasting `heal` pill if heal doesn't meaningfully lift win rate
      const healHelps = haveHealForCombat && (simWithHeal.winProb - simNoHeal.winProb) >= 0.05
      if (!healHelps && x.carry && canPush(2)) {
        emit({ a: 'xianCarry', on: false })
      } else if (healHelps && !x.carry && canPush(2)) {
        emit({ a: 'xianCarry', on: true })
      }
      if (emit({ a: 'xianTower' })) {
        followUpSoon = true
      }
    }
  }

  assertSafeXianBatch(actions, world, opts)
  return {
    enabled: true,
    actions,
    expectedSpendCoins,
    followUpSoon,
    reason: actions.length > 0 ? 'actions-ready' : 'idle',
  }
}

export function computeNextXianWakeSec(world, nowSec = Number(world?.now || 0), rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!opts.enabled) return Infinity
  const t = Math.floor(Number(nowSec || world?.now || 0))
  const x = world?.state?.xian
  if (!x?.v) return t + 2

  const candidates = [nextCstMidnightSec(t) + 3]

  for (const p of x.plots || []) {
    if (!p?.h) continue
    const h = xianHerb(p.h)
    if (!h) continue
    const readyAt = p.t + h.hours * 3600
    candidates.push(readyAt <= t ? t + 2 : readyAt + 1)
  }

  if (x.job?.done) {
    candidates.push(x.job.done <= t ? t + 2 : x.job.done + 1)
  }

  for (const pet of x.pets || []) {
    if (pet?.h && pet.h > t) {
      candidates.push(pet.h + 1)
    }
  }

  const cAt = Number(x.cAt || t)
  const capSafeAt = cAt + Math.min(12 * 3600, XIAN_CULT_CAP - 1800)
  candidates.push(capSafeAt <= t ? t + 10 : capSafeAt)

  if ((x.lv || 1) < XIAN_MAX_LV) {
    const need = xianNeed(x.lv)
    const brk = xianBreakNeed(x)
    if (!brk || (x.xp || 0) < need) {
      const remXp = Math.max(1, need - (x.xp || 0))
      const rate = xianRate(x)
      if (rate > 0) {
        const secNeeded = Math.ceil((remXp * 3600) / rate)
        if (secNeeded <= XIAN_CULT_CAP) {
          const targetAt = cAt + secNeeded + 2
          candidates.push(targetAt <= t ? t + 5 : targetAt)
        }
      }
    }
  }

  const dy = x.dy?.d === xianDay(t) ? x.dy : { duel: 0, tower: 0 }
  if (cstHourOf(t) < 21 && ((dy.duel || 0) < 10 || (dy.tower || 0) < XIAN_ECON.towerFree)) {
    const today21Cst = xianDay(t) * 86400 - 28800 + 21 * 3600 + 5
    if (today21Cst > t) candidates.push(today21Cst)
  }

  return Math.min(...candidates.filter((v) => Number.isFinite(v)))
}

/**
 * Executes a single preemptible, lock-serialized `b16 云梦仙途` slice (`kind: 'xian-act'`).
 * Zero HTTP requests and zero lock contention when `observedWorld` shows no due `xian*` actions!
 */
export async function runXianCultivationSlice({
  account = 'main',
  adapter,
  httpClient,
  journal = null,
  lockRootDir = null,
  observedWorld = null,
  shouldAbortFn = null,
  xianOptions = {},
  dryRun = false,
}) {
  const opts = normalizeXianOptions(xianOptions)
  if (!opts.enabled) {
    return { status: 'disabled', actions: [], expectedSpendCoins: 0, nextXianWakeSec: Infinity }
  }
  if (shouldAbortFn?.()) {
    return { status: 'aborted-by-preemption', actions: [], expectedSpendCoins: 0, nextXianWakeSec: Infinity }
  }

  const estNowSec = Math.floor(Number(httpClient?.estimatedServerNowSec?.() ?? observedWorld?.now ?? Date.now() / 1000))
  if (observedWorld?.state) {
    const preview = planXianActions(observedWorld, estNowSec, opts)
    if (preview.actions.length === 0) {
      return {
        status: 'idle',
        actions: [],
        expectedSpendCoins: 0,
        nextXianWakeSec: computeNextXianWakeSec(observedWorld, estNowSec, opts),
      }
    }
    if (dryRun || !journal) {
      return {
        status: 'dry-run-planned',
        actions: preview.actions,
        expectedSpendCoins: preview.expectedSpendCoins,
        nextXianWakeSec: preview.followUpSoon
          ? estNowSec + 3
          : computeNextXianWakeSec(observedWorld, estNowSec, opts),
      }
    }
  } else if (dryRun || !journal) {
    let w = null
    try {
      const fetched = await httpClient.getJson('/api/pet/world')
      w = fetched?.state ? fetched : (fetched?.ok ? fetched.body : null)
    } catch {
      w = null
    }
    if (!w?.state) {
      return { status: 'fetch-world-failed', actions: [], expectedSpendCoins: 0, nextXianWakeSec: estNowSec + 30 }
    }
    const nowW = Math.floor(Number(w?.now || estNowSec))
    const preview = planXianActions(w, nowW, opts)
    return {
      status: preview.actions.length > 0 ? 'dry-run-planned' : 'idle',
      actions: preview.actions,
      expectedSpendCoins: preview.expectedSpendCoins,
      nextXianWakeSec: preview.followUpSoon
        ? nowW + 3
        : computeNextXianWakeSec(w, nowW, opts),
    }
  }

  const runCritical = async () => {
    if (shouldAbortFn?.()) {
      return { status: 'aborted-by-preemption', actions: [], expectedSpendCoins: 0, nextXianWakeSec: Infinity }
    }
    let liveWorld = null
    try {
      const worldRes = await httpClient.getJson('/api/pet/world')
      liveWorld = worldRes?.state ? worldRes : (worldRes?.ok ? worldRes.body : null)
    } catch {
      liveWorld = null
    }
    if (!liveWorld?.state) {
      return { status: 'fetch-world-failed', actions: [], expectedSpendCoins: 0, nextXianWakeSec: estNowSec + 30 }
    }
    const liveNow = Math.floor(Number(liveWorld.now || httpClient.estimatedServerNowSec()))

    const recSummary = reconcileUnknownWithFreshWorld(journal, adapter, liveWorld)
    if (recSummary.remainingNonVisitUnknown > 0) {
      return {
        status: 'blocked-pending-reconcile',
        actions: [],
        expectedSpendCoins: 0,
        worldAfter: sanitizeWorldSnapshot(liveWorld),
        nextXianWakeSec: liveNow + 10,
      }
    }

    if (shouldAbortFn?.()) {
      return {
        status: 'aborted-by-preemption',
        actions: [],
        expectedSpendCoins: 0,
        worldAfter: sanitizeWorldSnapshot(liveWorld),
        nextXianWakeSec: Infinity,
      }
    }

    const livePlan = planXianActions(liveWorld, liveNow, opts)
    if (livePlan.actions.length === 0) {
      return {
        status: 'idle',
        actions: [],
        expectedSpendCoins: 0,
        worldAfter: sanitizeWorldSnapshot(liveWorld),
        nextXianWakeSec: computeNextXianWakeSec(liveWorld, liveNow, opts),
      }
    }

    assertSafeXianBatch(livePlan.actions, liveWorld, opts)

    const txOut = await executeTransaction({
      journal,
      adapter,
      lockRootDir,
      alreadyLocked: true,
      account,
      kind: 'xian-act',
      worldBefore: liveWorld,
      planSummary: {
        module: 'b16-xian',
        reason: livePlan.reason,
        expectedSpendCoins: livePlan.expectedSpendCoins,
        actionCount: livePlan.actions.length,
      },
      requestPayload: {
        actions: livePlan.actions,
      },
      sendFn: async ({ operation }) => {
        const r = await httpClient.postJson('/api/pet/world/act', {
          rev: liveWorld.rev,
          operation,
          actions: livePlan.actions,
        })
        return { ok: r.ok, status: r.status, networkError: r.networkError, body: r.body }
      },
      fetchAfterWorldFn: async () => {
        try {
          const r = await httpClient.getJson('/api/pet/world')
          return r?.state ? r : (r?.ok ? r.body : null)
        } catch {
          return null
        }
      },
    })

    const postWorld = txOut.worldAfter || sanitizeWorldSnapshot(liveWorld)
    const postNow = Math.floor(Number(postWorld?.now || liveNow))
    const computedWake = computeNextXianWakeSec(postWorld, postNow, opts)
    const nextXianWakeSec = (txOut.status === 'confirmed' && livePlan.followUpSoon)
      ? Math.min(computedWake, postNow + 3)
      : computedWake

    return {
      status: txOut.status,
      operation: txOut.operation,
      actions: livePlan.actions,
      expectedSpendCoins: livePlan.expectedSpendCoins,
      response: txOut.response,
      worldAfter: postWorld,
      nextXianWakeSec,
    }
  }

  if (!lockRootDir) {
    return runCritical()
  }
  return withAccountLock(lockRootDir, account, runCritical)
}
