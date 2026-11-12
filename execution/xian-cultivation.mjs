import { sanitizeWorldSnapshot } from '../model/observations.mjs'
import { executeTransaction, reconcileUnknownWithFreshWorld, withAccountLock } from './reconcile.mjs'
import {
  BREW_MAX,
  BREW_MIN,
  CAN_MAX,
  COST,
  EN_MAX,
  EN_REGEN,
  FUSIONS,
  HERBS,
  LV_NEED,
  MED_MAX,
  MED_MIN,
  PILL_DAILY,
  PILLS,
  PLOTS,
  REALMS,
  ROOT_GROW,
  STORY_END,
  TECH_PRICE,
  TECHS,
  act as xsAct,
  canMax,
  cvNeed,
  fuseKey,
  plotView,
  rootMult,
  tick as xsTick,
} from '../rules/xs-xian-rules.js'

/**
 * Actions reserved strictly for manual player interaction in 「大肥鱼修仙记」 (`state.xs`):
 *   - `xsRoot`, `xsStory`: Prologue & irreversible initial root element choice (`st < 4`).
 *   - `xsFight`, `xsWin`, `xsLose`: Client-side danmaku stages & NPC duels (also inferior stone/en to Lv2+ farming).
 * Additionally, `xsFuse` is gated behind `--xian-auto-fuse` (default OFF because root fusion is permanent),
 * and `xsBreak` is gated by `--xian-break-mode <smart|eager|manual>`.
 */
export const FORBIDDEN_XIAN_ACTIONS = new Set([
  'xsRoot',
  'xsStory',
  'xsFight',
  'xsWin',
  'xsLose',
])

export const VALID_XIAN_BREAK_MODES = new Set(['smart', 'eager', 'manual'])
export const VALID_XIAN_FUSE_TARGETS = new Set(['auto', 'ice', 'thunder', 'wind', 'lava', 'poison'])

export const MAX_XS_BATCH = 30
// Client `BREW_GAME` is 18s and server `BREW_MIN` is 15s; 19s guarantees `q=2` (上品, 3 pills) with 1s skew buffer.
export const BREW_READY_SEC = Math.max(BREW_MIN + 4, 19)

const HERB_ENTRIES_DESC = Object.entries(HERBS).sort((a, b) => b[1].lv - a[1].lv || b[1].sell - a[1].sell)
const PURE_CASH_HERBS = new Set(
  Object.keys(HERBS).filter((h) => !Object.values(PILLS).some((p) => Object.hasOwn(p.need, h)))
)
const VARIANT_TECH_PRIORITY = ['poison', 'ice', 'wind', 'fire', 'wood', 'metal', 'earth', 'water', 'thunder', 'lava']
const EQUIP_TECH_PRIORITY_SUB_LV5 = ['poison', 'fire', 'wind', 'ice', 'wood', 'metal', 'earth', 'water', 'thunder', 'lava']
const EQUIP_TECH_PRIORITY_LV5 = ['ice', 'poison', 'wind', 'fire', 'metal', 'wood', 'earth', 'water', 'thunder', 'lava']

function selectPreferredEquippedTech(x) {
  if (!Array.isArray(x?.techs) || x.techs.length === 0) return null
  const order = (x.lv || 1) < 5 ? EQUIP_TECH_PRIORITY_SUB_LV5 : EQUIP_TECH_PRIORITY_LV5
  return [...x.techs].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia >= 0 ? ia : 99) - (ib >= 0 ? ib : 99)
  })[0]
}

export function xsDay(nowSec) {
  return Math.floor((Number(nowSec || 0) + 28800) / 86400)
}

function nextCstMidnightSec(nowSec) {
  return (xsDay(nowSec) + 1) * 86400 - 28800
}

function cstSecondsUntilMidnight(nowSec) {
  return Math.max(0, nextCstMidnightSec(nowSec) - Number(nowSec || 0))
}

export function toWireXsAction(internalAct) {
  const short = String(internalAct?.a || '')
  const wire = { a: 'xs' + short[0].toUpperCase() + short.slice(1) }
  if (internalAct.i != null) wire.i = internalAct.i
  if (internalAct.herb != null) wire.herb = internalAct.herb
  if (internalAct.n != null) wire.n = internalAct.n
  if (internalAct.el != null) wire.el = internalAct.el
  return wire
}

export function fromWireXsAction(wireAct) {
  const raw = String(wireAct?.a || '')
  if (!raw.startsWith('xs') || raw.length < 3) return null
  const short = raw[2].toLowerCase() + raw.slice(3)
  if (!Object.hasOwn(COST, short)) return null
  const internal = { a: short }
  if (wireAct.i != null) internal.i = wireAct.i
  if (wireAct.herb != null) internal.herb = wireAct.herb
  if (wireAct.n != null) internal.n = wireAct.n
  if (wireAct.el != null) internal.el = wireAct.el
  return internal
}

export function normalizeXianOptions(raw = {}) {
  const breakRaw = String(raw?.breakMode || 'smart').trim().toLowerCase()
  const breakMode = VALID_XIAN_BREAK_MODES.has(breakRaw) ? breakRaw : 'smart'
  const fuseTargetRaw = String(raw?.fuseTarget || 'auto').trim().toLowerCase()
  const fuseTarget = VALID_XIAN_FUSE_TARGETS.has(fuseTargetRaw) ? fuseTargetRaw : 'auto'
  const maxActionsRaw = Number(raw?.maxActionsPerBatch ?? MAX_XS_BATCH)
  return {
    enabled: Boolean(raw?.enabled),
    breakMode,
    autoFuse: Boolean(raw?.autoFuse),
    fuseTarget,
    maxActionsPerBatch: Number.isFinite(maxActionsRaw)
      ? Math.max(1, Math.min(MAX_XS_BATCH, Math.floor(maxActionsRaw)))
      : MAX_XS_BATCH,
  }
}

export function assertSafeXianBatch(actions, _world = null, rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!Array.isArray(actions)) {
    throw new Error('Invalid xian batch: actions must be an array')
  }
  if (actions.length > opts.maxActionsPerBatch) {
    throw new Error(`Xian batch length ${actions.length} exceeds maxActionsPerBatch=${opts.maxActionsPerBatch}`)
  }
  for (const act of actions) {
    const name = String(act?.a || '')
    if (FORBIDDEN_XIAN_ACTIONS.has(name)) {
      throw new Error(`Forbidden manual-only xian action in automated batch: ${name}`)
    }
    const parsed = fromWireXsAction(act)
    if (!parsed) {
      throw new Error(`Illegal non-xs action in xian batch: ${name}`)
    }
    if (name === 'xsFuse' && !opts.autoFuse) {
      throw new Error('xsFuse is forbidden when autoFuse is disabled')
    }
    if (name === 'xsBreak' && opts.breakMode === 'manual') {
      throw new Error('xsBreak is forbidden when breakMode is manual')
    }
  }
}

function maxPentagonMatchingCount(baseElements) {
  if (!Array.isArray(baseElements) || baseElements.length < 2) return 0
  let best = 0
  for (let i = 0; i < baseElements.length; i++) {
    for (let j = i + 1; j < baseElements.length; j++) {
      const k = fuseKey(baseElements[i], baseElements[j])
      if (!FUSIONS[k]) continue
      const rest = baseElements.filter((_, idx) => idx !== i && idx !== j)
      const cand = 1 + maxPentagonMatchingCount(rest)
      if (cand > best) best = cand
    }
  }
  return best
}

/**
 * Selects an optimal adjacent root pair on the `C_5` pentagon (`metal-water-wood-earth-fire-metal`).
 * On a 4-root chain (`P_4`), strictly selects an endpoint edge (`totalReachableFusions === 2`) and
 * never picks the middle edge (`totalReachableFusions === 1`), preserving dual-variant fusion.
 */
export function selectOptimalFusionPair(roots, fuseTarget = 'auto') {
  const base = Array.isArray(roots?.e) ? roots.e : []
  if (base.length < 2) return null
  const candidates = []
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      const key = fuseKey(base[i], base[j])
      const f = FUSIONS[key]
      if (!f) continue
      if (fuseTarget !== 'auto' && f.id !== fuseTarget) continue
      const rest = base.filter((_, idx) => idx !== i && idx !== j)
      const totalReachableFusions = 1 + maxPentagonMatchingCount(rest)
      const rank = VARIANT_TECH_PRIORITY.indexOf(f.id)
      candidates.push({
        key,
        e1: base[i],
        e2: base[j],
        variantId: f.id,
        variantName: f.name,
        totalReachableFusions,
        priorityRank: rank >= 0 ? rank : 99,
      })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort(
    (a, b) =>
      b.totalReachableFusions - a.totalReachableFusions ||
      a.priorityRank - b.priorityRank ||
      a.key.localeCompare(b.key)
  )
  return candidates[0]
}

function countInGroundByHerb(x) {
  const counts = {}
  let total = 0
  for (const p of x.plots || []) {
    if (p?.c) {
      counts[p.c] = (counts[p.c] || 0) + 1
      total++
    }
  }
  return { counts, total }
}

function countOpenSoilPlots(x) {
  let open = 0
  let empty = 0
  for (const p of x.plots || []) {
    if (p?.s === 'soil') {
      open++
      if (!p.c) empty++
    }
  }
  return { open, empty }
}

function dpUsedToday(x, nowSec) {
  const d = xsDay(nowSec)
  return x.dp?.d === d ? Number(x.dp.n || 0) : 0
}

function shouldAllowBreakPolicy(x, opts) {
  if (opts.breakMode === 'manual') return false
  const r = Number(x.cv?.r || 0)
  if (r >= REALMS.length - 1) return false
  if (opts.breakMode === 'eager') return true

  // `smart` mode:
  // While Farm `lv < 5`, `peiyuan` (+40 Farm XP/pill) strongly prioritizes unlocking Lv5 `leizhu` first.
  // Only allow the cheap 1-pill `炼气 -> 筑基` (`r: 0 -> 1`) early when `autoFuse` is enabled (unlocking fusion)
  // or when `ROOT_GROW[n] > 1` (4/5-root where realm advancement increases `rootMult`).
  if ((x.lv || 1) < 5) {
    if (r > 0) return false
    const rootCount = (x.roots?.e?.length || 0) + (x.roots?.v?.length || 0)
    const grow = ROOT_GROW[rootCount] || 1
    return Boolean(opts.autoFuse) || grow > 1
  }
  return true
}

function computeHeldPeiyuanFloorWhileSubLv5(x, nowSec, opts) {
  if ((x.lv || 1) >= 5) return Infinity
  let hold = 0
  if (shouldAllowBreakPolicy(x, opts) && Number(x.cv?.s || 1) >= 8) {
    hold = Math.max(hold, Number(x.cv?.r || 0) + 1)
  }
  if (opts.autoFuse && !(Number(x.fuseCd || 0) > nowSec)) {
    const pair = selectOptimalFusionPair(x.roots, opts.fuseTarget)
    if (pair) {
      if (Number(x.cv?.r || 0) >= 1) {
        hold = Math.max(hold, 2)
      } else if (Number(x.cv?.s || 1) >= 8 && shouldAllowBreakPolicy(x, opts)) {
        // At 炼气 8~9 层 with `autoFuse` enabled, reserve `1 (break) + 2 (fuse) = 3` pills so the instant
        // `xsBreak` enters 筑基 1 层 (`xp = 0`), `xsFuse` fires in the exact same zero-XP-loss window!
        hold = Math.max(hold, 3)
      }
    }
  }
  return hold
}

function computeDesiredPeiyuanStock(x, nowSec, opts) {
  const r = Number(x.cv?.r || 0)
  const breakNeed = r < REALMS.length - 1 ? r + 1 : 0
  if ((x.lv || 1) < 5) {
    // Keep brewing `peiyuan` continuously until Farm Lv5!
    return Math.max(6, breakNeed + 3)
  }
  if (opts.breakMode === 'manual') {
    // Keep a convenient manual reserve (`max(2, r + 1)` pills) in bag for manual fusion or manual breakthrough,
    // then dedicate 100% of plots to Lv5 `leizhu`.
    const pair = selectOptimalFusionPair(x.roots, opts.fuseTarget)
    return Math.max(pair ? 2 : 0, breakNeed)
  }
  const fuseReserve = opts.autoFuse && r >= 1 && selectOptimalFusionPair(x.roots, opts.fuseTarget) ? 2 : 0
  const retryMultiplier = Number(x.cv?.s || 1) >= 8 ? 2 : 1
  return breakNeed * retryMultiplier + fuseReserve
}

function computeAlchemyHerbTargets(x, nowSec, opts) {
  const usedDp = dpUsedToday(x, nowSec)
  const targetHuilingPills = (PILL_DAILY - usedDp) + PILL_DAILY
  const haveHuiling = Number(x.pills?.huiling || 0) + (x.brew?.p === 'huiling' ? 3 : 0)
  const huilingBatches = Math.min(2, Math.max(0, Math.ceil((targetHuilingPills - haveHuiling) / 3)))

  const canGrowLinglan = (x.lv || 1) >= 2
  const desiredPeiyuan = computeDesiredPeiyuanStock(x, nowSec, opts)
  const havePeiyuan = Number(x.pills?.peiyuan || 0) + (x.brew?.p === 'peiyuan' ? 3 : 0)
  const peiyuanBatches = canGrowLinglan
    ? Math.min(2, Math.max(0, Math.ceil((desiredPeiyuan - havePeiyuan) / 3)))
    : 0

  return {
    huilingBatches,
    peiyuanBatches,
    needHerbs: {
      lingcao: huilingBatches * 3 + peiyuanBatches * 2,
      jingu: huilingBatches * 1,
      linglan: peiyuanBatches * 1,
    },
    bagReserve: {
      lingcao: Math.max(6, huilingBatches * 3 + peiyuanBatches * 2),
      jingu: Math.max(2, huilingBatches * 1),
      linglan: canGrowLinglan ? Math.max(2, peiyuanBatches * 1) : 0,
    },
  }
}

function chooseCropForEmptyPlot(x, nowSec, opts) {
  const { counts: inGround, total: totalInGround } = countInGroundByHerb(x)
  const { needHerbs } = computeAlchemyHerbTargets(x, nowSec, opts)
  const canUse = (herbId) => {
    const H = HERBS[herbId]
    if (!H || H.lv > (x.lv || 1)) return false
    return Number(x.seeds?.[herbId] || 0) > 0 || Number(x.stone || 0) >= H.seed
  }
  const projected = (herbId) => Number(x.bag?.[herbId] || 0) + Number(inGround[herbId] || 0)

  if (projected('jingu') < needHerbs.jingu && canUse('jingu')) return 'jingu'
  if (projected('lingcao') < needHerbs.lingcao && canUse('lingcao')) return 'lingcao'
  if ((x.lv || 1) >= 2 && projected('linglan') < needHerbs.linglan && canUse('linglan')) return 'linglan'

  // Pick highest unlocked herb; if temporarily short on stones for top herb, wait for in-ground harvest
  // unless field is sparse (`< 3` growing) or `xs.en` is near cap (`>= 85`).
  const unlocked = HERB_ENTRIES_DESC.filter(([, H]) => H.lv <= (x.lv || 1))
  const topHerbId = unlocked[0]?.[0] || 'lingcao'
  if (canUse(topHerbId)) return topHerbId

  if (totalInGround < 3 || Number(x.en || 0) >= 85) {
    for (const [herbId] of unlocked) {
      if (canUse(herbId)) return herbId
    }
  }
  return null
}

function findSellableHerb(x, nowSec, opts) {
  const { bagReserve } = computeAlchemyHerbTargets(x, nowSec, opts)
  // Sell pure cash herbs (`leizhu`, `chizhi`, `binglian`) first, then surplus alchemy herbs above reserve
  for (const [herbId] of HERB_ENTRIES_DESC) {
    const qty = Number(x.bag?.[herbId] || 0)
    if (qty <= 0) continue
    const keep = PURE_CASH_HERBS.has(herbId) ? 0 : Number(bagReserve[herbId] || 0)
    if (qty > keep) {
      return { herb: herbId, sellableQty: qty - keep }
    }
  }
  // Emergency dead-broke liquidity recovery if 0 crops in ground, 0 seeds, and `< 5` stones
  const { total: inGround } = countInGroundByHerb(x)
  const totalSeeds = Object.values(x.seeds || {}).reduce((s, n) => s + Number(n || 0), 0)
  if (inGround === 0 && totalSeeds === 0 && Number(x.stone || 0) < HERBS.lingcao.seed) {
    for (const [herbId] of HERB_ENTRIES_DESC) {
      const qty = Number(x.bag?.[herbId] || 0)
      if (qty > 0) return { herb: herbId, sellableQty: qty }
    }
  }
  return null
}

function computeUpcomingPlotEnergyNeed(x, nowSec, horizonSec = 1800) {
  let need = 0
  for (const p of x.plots || []) {
    if (!p) continue
    if (p.c && p.g >= 3) {
      need += COST.harvest + COST.plant + COST.water
    } else if (p.c && p.g < 3 && !p.w) {
      need += COST.water
    } else if (p.s === 'soil' && !p.c) {
      need += COST.plant + COST.water
    } else if (p.c && p.g < 3 && p.w) {
      const v = plotView(p, nowSec, x.tech)
      if (v.left <= horizonSec) {
        need += p.g === 2 ? (COST.harvest + COST.plant + COST.water) : COST.water
      }
    }
  }
  const regenSec = x.tech === 'wind' ? EN_REGEN * 0.75 : EN_REGEN
  const naturalRegenInHorizon = x.en < EN_MAX
    ? Math.floor((Math.max(0, nowSec - Number(x.enAt || nowSec)) + horizonSec) / regenSec)
    : 0
  return Math.max(0, need - naturalRegenInHorizon)
}

function computeSurplusEnergy(x, nowSec) {
  const upcomingNeed = computeUpcomingPlotEnergyNeed(x, nowSec, 1800)
  return Number(x.en || 0) - upcomingNeed
}

function hasBrewIngredients(x, pillId) {
  const P = PILLS[pillId]
  if (!P) return false
  return Object.entries(P.need).every(([h, n]) => Number(x.bag?.[h] || 0) >= n)
}

function findLearnableTech(x) {
  if (!x.roots) return null
  const learned = new Set(x.techs || [])
  const ownedRoots = [...(x.roots.v || []), ...(x.roots.e || [])]
  const ordered = [...ownedRoots].sort((a, b) => {
    const ia = VARIANT_TECH_PRIORITY.indexOf(a)
    const ib = VARIANT_TECH_PRIORITY.indexOf(b)
    return (ia >= 0 ? ia : 99) - (ib >= 0 ? ib : 99)
  })
  const unlearned = ordered.filter((el) => TECHS[el] && !learned.has(el))
  if (unlearned.length === 0) return null

  const { open } = countOpenSoilPlots(x)
  const topHerb = HERB_ENTRIES_DESC.find(([, H]) => H.lv <= (x.lv || 1))?.[1] || HERBS.lingcao
  // Learn first tech as soon as affordable with small seed buffer; learn remaining techs once working capital is comfortable
  const stoneBuffer = learned.size === 0 ? Math.max(24, topHerb.seed * 2) : Math.max(80, open * Math.min(topHerb.seed, 45))
  if (Number(x.stone || 0) >= TECH_PRICE + stoneBuffer) {
    return unlearned[0]
  }
  return null
}

function shouldEatHuilingNow(x, nowSec, pendingEnergyNeed = 0) {
  if (Number(x.pills?.huiling || 0) < 1) return false
  if (dpUsedToday(x, nowSec) >= PILL_DAILY) return false
  const en = Number(x.en || 0)
  if (en >= EN_MAX) return false
  const gainEn = PILLS.huiling.en + (x.tech === 'poison' ? 10 : 0)
  // Normal zero-waste rule: eat when `en + gainEn <= 99 < EN_MAX` (preserving `enAt` sub-tick timer!)
  // whenever farm/alchemy work needs energy or after 20:00 CST so daily 3-pill quota never expires.
  if (en <= EN_MAX - gainEn - 1 && (en < pendingEnergyNeed || cstSecondsUntilMidnight(nowSec) <= 4 * 3600)) {
    return true
  }
  // Final 25-minute pre-midnight rescue if daily quota would otherwise vanish unused at `00:00` CST
  if (cstSecondsUntilMidnight(nowSec) <= 1500 && en <= EN_MAX - 10) {
    return true
  }
  return false
}

function projectMeditationAfterRise(x, nowSec) {
  if (!x.med) return null
  const d = Math.min(Math.max(0, nowSec - Number(x.med.t || nowSec)), MED_MAX)
  if (d < MED_MIN) return { d, gainCv: 0, s: x.cv.s, xp: x.cv.xp }
  const gainCv = Math.floor((d / 60) * 10 * rootMult(x) * (x.tech === 'ice' ? 1.2 : 1))
  let s = Number(x.cv?.s || 1)
  let xp = Number(x.cv?.xp || 0) + gainCv
  const r = Number(x.cv?.r || 0)
  while (s < 9 && xp >= cvNeed(r, s)) {
    xp -= cvNeed(r, s)
    s++
  }
  return { d, gainCv, s, xp }
}

/**
 * Pure deterministic planner for 「大肥鱼修仙记」 (`state.xs`).
 * Spends 0 main-island D-coins and 0 main-island stamina.
 */
export function planXianActions(world, nowSec = Number(world?.now || 0), rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!opts.enabled) {
    return { enabled: false, actions: [], expectedSpendCoins: 0, followUpSoon: false, reason: 'disabled' }
  }

  const t = Math.floor(Number(nowSec || world?.now || 0))
  const rawXs = world?.state?.xs
  if (!rawXs?.v || !rawXs.roots || !Array.isArray(rawXs.roots.e) || Number(rawXs.st || 0) < STORY_END) {
    return {
      enabled: true,
      actions: [],
      expectedSpendCoins: 0,
      followUpSoon: false,
      reason: 'prologue-manual-standby',
    }
  }

  if (rawXs.fight && t - Number(rawXs.fight.t || 0) < 1800) {
    return {
      enabled: true,
      actions: [],
      expectedSpendCoins: 0,
      followUpSoon: false,
      reason: 'manual-fight-in-progress',
    }
  }

  const sim = structuredClone(rawXs)
  xsTick(sim, t)

  const actions = []
  let truncatedByBatchCap = false
  let emittedStochastic = false

  const emit = (internalAct) => {
    if (actions.length >= opts.maxActionsPerBatch) {
      truncatedByBatchCap = true
      return false
    }
    const res = xsAct(sim, internalAct, t, () => 0.99)
    if (!res?.ok) return false
    actions.push(toWireXsAction(internalAct))
    return true
  }

  // Will an already-ready `cv.xp >= cvNeed(r, 9)` use `sim.med` as an `xsBreak`-before-`xsRise` shield at the end?
  const isHoldingMedShieldForBreak = () =>
    Boolean(sim.med) &&
    shouldAllowBreakPolicy(sim, opts) &&
    Number(sim.cv?.s || 1) >= 9 &&
    Number(sim.cv?.xp || 0) >= cvNeed(Number(sim.cv?.r || 0), 9) &&
    Number(sim.pills?.peiyuan || 0) >= Number(sim.cv?.r || 0) + 1

  // Helper to advance `sim.log` toward `3 mod 4` using ONLY strictly productive actions before `xsHarvest`!
  const alignLogForDoubleHarvest = (upcomingHarvestCount) => {
    let guard = 0
    while (sim.log % 4 !== 3 && actions.length + 1 < opts.maxActionsPerBatch && guard++ < 6) {
      const preferredTech = selectPreferredEquippedTech(sim)
      if (preferredTech && (!sim.tech || (sim.te !== xsDay(t) && preferredTech !== sim.tech))) {
        if (emit({ a: 'equip', el: preferredTech })) continue
      }
      if (sim.brew && t - Number(sim.brew.t || 0) >= BREW_READY_SEC) {
        if (emit({ a: 'finish', n: 2 })) continue
      }
      if (shouldEatHuilingNow(sim, t, upcomingHarvestCount * (COST.harvest + COST.plant + COST.water))) {
        if (emit({ a: 'use', herb: 'huiling' })) continue
      }
      if (
        (sim.lv || 1) < 5 &&
        Number(sim.pills?.peiyuan || 0) > computeHeldPeiyuanFloorWhileSubLv5(sim, t, opts)
      ) {
        if (emit({ a: 'use', herb: 'peiyuan' })) continue
      }
      if (!sim.med) {
        if (emit({ a: 'sit' })) continue
      } else if (t - Number(sim.med.t || 0) >= MED_MAX && !isHoldingMedShieldForBreak()) {
        if (emit({ a: 'rise' })) continue
      }

      // Water an existing dry growing plot if doing so keeps `>= COST.harvest` energy for the mature plot
      const dryIdx = sim.plots.findIndex((p) => p?.c && p.g < 3 && !p.w)
      if (dryIdx >= 0 && sim.en >= COST.harvest + COST.water) {
        if (sim.can < 1) {
          if (emit({ a: 'refill' })) continue
        } else if (emit({ a: 'water', i: dryIdx })) {
          continue
        }
      }

      // Plant an already-empty soil plot (or buy 1 needed seed for it) if energy covers `harvest + plant`
      const emptyIdx = sim.plots.findIndex((p) => p?.s === 'soil' && !p.c)
      if (emptyIdx >= 0 && sim.en >= COST.harvest + COST.plant) {
        const crop = chooseCropForEmptyPlot(sim, t, opts)
        if (crop) {
          if (Number(sim.seeds?.[crop] || 0) < 1 && sim.stone >= HERBS[crop].seed) {
            if (emit({ a: 'buy', herb: crop, n: 1 })) continue
          } else if (Number(sim.seeds?.[crop] || 0) >= 1) {
            if (emit({ a: 'plant', i: emptyIdx, herb: crop })) continue
          }
        }
      }

      // Sell 1 surplus herb from bag (identical to 1 UI shop click)
      const sellCand = findSellableHerb(sim, t, opts)
      if (sellCand) {
        if (emit({ a: 'sell', herb: sellCand.herb, n: 1 })) continue
      }

      // Pre-buy 1 seed for the mature plot we are about to replant (`COST.buy = 0` `xs.en`!)
      if (sim.en >= COST.harvest) {
        const nextCrop = chooseCropForEmptyPlot(sim, t, opts)
        if (nextCrop) {
          const { empty } = countOpenSoilPlots(sim)
          const neededSeeds = empty + upcomingHarvestCount + 2
          if (Number(sim.seeds?.[nextCrop] || 0) < neededSeeds && sim.stone >= HERBS[nextCrop].seed) {
            if (emit({ a: 'buy', herb: nextCrop, n: 1 })) continue
          }
        }
      }

      const techToLearn = findLearnableTech(sim)
      if (techToLearn) {
        if (emit({ a: 'learn', el: techToLearn })) continue
      }

      if (sim.can < canMax(sim)) {
        if (emit({ a: 'refill' })) continue
      }

      break
    }
  }

  const isUrgentCauldronReady = () => {
    if (sim.brew) return false
    const needHuilingToday = Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t)
    if (needHuilingToday && hasBrewIngredients(sim, 'huiling')) return true
    const needPeiyuanUrgently =
      (sim.lv || 1) < 5 ||
      Number(sim.pills?.peiyuan || 0) < computeHeldPeiyuanFloorWhileSubLv5(sim, t, opts) ||
      (shouldAllowBreakPolicy(sim, opts) &&
        Number(sim.cv?.s || 1) >= 8 &&
        Number(sim.pills?.peiyuan || 0) < Number(sim.cv?.r || 0) + 1)
    if (needPeiyuanUrgently && hasBrewIngredients(sim, 'peiyuan')) return true
    return false
  }

  const minReservedEnForRipeOrBrew = () => {
    if (isUrgentCauldronReady()) return COST.brew
    if (sim.plots.some((pl) => pl?.c && pl.g >= 3)) return COST.harvest
    return 0
  }

  // 1. Finish ready cauldron immediately if no mature plots are waiting to claim its `log` step (or if `log % 4 !== 3`)
  if (sim.brew && t - Number(sim.brew.t || 0) >= BREW_READY_SEC) {
    const hasRipe = sim.plots.some((p) => p?.c && p.g >= 3)
    if (!hasRipe || sim.log % 4 !== 3) {
      const preferredTech = selectPreferredEquippedTech(sim)
      if (preferredTech && (!sim.tech || (sim.te !== xsDay(t) && preferredTech !== sim.tech))) {
        emit({ a: 'equip', el: preferredTech })
      }
      if (!hasRipe || sim.log % 4 !== 3) {
        emit({ a: 'finish', n: 2 })
      }
    }
  }

  // 1b. Urgent `huiling` cauldron BEFORE farm plots can drain `sim.en` below `COST.brew = 5`!
  //     Spending 5 `xs.en` here returns +90 `xs.en` today (+85 net `xs.en`), preventing farm energy starvation.
  if (
    !sim.brew &&
    sim.en >= COST.brew &&
    Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t) &&
    hasBrewIngredients(sim, 'huiling') &&
    (!sim.plots.some((p) => p?.c && p.g >= 3) || sim.log % 4 !== 3)
  ) {
    emit({ a: 'brew', herb: 'huiling' })
  }

  // 2. Harvest mature plots (`g >= 3`), prioritizing missing alchemy recipe herbs first, then highest-value herb,
  //    aligning onto `sim.log % 4 === 3` (`2x` yield!)
  const needHuilingNow = Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t)
  const needPeiyuanNow =
    (sim.lv || 1) < 5 ||
    Number(sim.pills?.peiyuan || 0) < computeHeldPeiyuanFloorWhileSubLv5(sim, t, opts) ||
    (shouldAllowBreakPolicy(sim, opts) &&
      Number(sim.cv?.s || 1) >= 8 &&
      Number(sim.pills?.peiyuan || 0) < Number(sim.cv?.r || 0) + 1)
  const isRecipeBottleneckHerb = (herb) => {
    if (needHuilingNow && PILLS.huiling.need[herb] && Number(sim.bag?.[herb] || 0) < PILLS.huiling.need[herb]) {
      return 1
    }
    if (needPeiyuanNow && PILLS.peiyuan.need[herb] && Number(sim.bag?.[herb] || 0) < PILLS.peiyuan.need[herb]) {
      return 1
    }
    return 0
  }

  const ripeIndices = sim.plots
    .map((p, idx) =>
      p?.c && p.g >= 3
        ? { idx, herb: p.c, sell: HERBS[p.c]?.sell || 0, urgentNeed: isRecipeBottleneckHerb(p.c) }
        : null
    )
    .filter(Boolean)
    .sort((a, b) => b.urgentNeed - a.urgentNeed || b.sell - a.sell || a.idx - b.idx)

  for (let k = 0; k < ripeIndices.length; k++) {
    if (actions.length >= opts.maxActionsPerBatch) {
      truncatedByBatchCap = true
      break
    }
    if (isUrgentCauldronReady()) {
      if (sim.en >= COST.brew && sim.log % 4 !== 3) {
        const needHuilingToday = Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t)
        if (needHuilingToday && hasBrewIngredients(sim, 'huiling')) {
          emit({ a: 'brew', herb: 'huiling' })
        } else if (hasBrewIngredients(sim, 'peiyuan')) {
          emit({ a: 'brew', herb: 'peiyuan' })
        }
      }
      if (isUrgentCauldronReady() && sim.en - COST.harvest < COST.brew) {
        // Hold `sim.en` so it reaches `COST.brew = 5` instead of draining `2` `xs.en` on extra harvests
        break
      }
    }
    const { idx } = ripeIndices[k]
    const p = sim.plots[idx]
    if (!p?.c || p.g < 3) continue
    const remainingRipe = ripeIndices.length - k
    if (sim.en < COST.harvest && shouldEatHuilingNow(sim, t, remainingRipe * 4)) {
      emit({ a: 'use', herb: 'huiling' })
    }
    if (sim.en < COST.harvest) break
    const stepsForDouble = (3 - (sim.log % 4) + 4) % 4
    if (stepsForDouble > 0 && actions.length + stepsForDouble + 1 > opts.maxActionsPerBatch) {
      // Defer this mature plot to the follow-up batch 3s later rather than sacrificing 2x harvest at batch tail!
      truncatedByBatchCap = true
      break
    }
    alignLogForDoubleHarvest(remainingRipe)
    if (!emit({ a: 'harvest', i: idx })) break
  }

  // Finish ready cauldron if still pending after harvests
  if (sim.brew && t - Number(sim.brew.t || 0) >= BREW_READY_SEC) {
    emit({ a: 'finish', n: 2 })
  }

  // Start urgent today's `huiling` (+85 net `xs.en`) or sub-Lv5/breakthrough `peiyuan` right after harvests!
  if (!sim.brew && sim.en >= COST.brew && actions.length < opts.maxActionsPerBatch) {
    const needHuilingToday = Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t)
    if (needHuilingToday && hasBrewIngredients(sim, 'huiling')) {
      emit({ a: 'brew', herb: 'huiling' })
    } else if (isUrgentCauldronReady() && hasBrewIngredients(sim, 'peiyuan')) {
      emit({ a: 'brew', herb: 'peiyuan' })
    }
  }

  // 3. Eat `peiyuan` while `lv < 5` so any Farm level-up unlocks higher-tier seeds BEFORE planting!
  while (
    (sim.lv || 1) < 5 &&
    Number(sim.pills?.peiyuan || 0) > computeHeldPeiyuanFloorWhileSubLv5(sim, t, opts) &&
    actions.length < opts.maxActionsPerBatch
  ) {
    if (!emit({ a: 'use', herb: 'peiyuan' })) break
  }

  // 4. Sell surplus herbs in compact batches (`n <= 99`) so stone capital is liquid before seed buying
  while (actions.length < opts.maxActionsPerBatch) {
    const sellCand = findSellableHerb(sim, t, opts)
    if (!sellCand) break
    const n = Math.min(99, sellCand.sellableQty)
    if (!emit({ a: 'sell', herb: sellCand.herb, n })) break
  }

  // 5. Water existing growing dry plots FIRST (`p.c && p.g < 3 && !p.w`) so no crop growth timer sits paused,
  //    UNLESS holding `1` `xs.en` for an already-mature plot (`COST.harvest = 2`) or ready cauldron (`COST.brew = 5`)!
  for (let i = 0; i < PLOTS; i++) {
    if (actions.length >= opts.maxActionsPerBatch) {
      truncatedByBatchCap = true
      break
    }
    const p = sim.plots[i]
    if (!p?.c || p.g >= 3 || p.w) continue
    if (sim.en - COST.water < minReservedEnForRipeOrBrew() && shouldEatHuilingNow(sim, t, COST.water + 4)) {
      emit({ a: 'use', herb: 'huiling' })
    }
    if (sim.en - COST.water < minReservedEnForRipeOrBrew()) break
    if (sim.can < 1 && !emit({ a: 'refill' })) break
    emit({ a: 'water', i })
  }

  // 6. Plant & water all open empty `soil` plots (respecting mature-harvest / urgent-cauldron `xs.en` reservation)
  for (let i = 0; i < PLOTS; i++) {
    if (actions.length >= opts.maxActionsPerBatch) {
      truncatedByBatchCap = true
      break
    }
    const p = sim.plots[i]
    if (!p || p.s !== 'soil' || p.c) continue
    if (sim.en - (COST.plant + COST.water) < minReservedEnForRipeOrBrew() && shouldEatHuilingNow(sim, t, COST.plant + COST.water + 4)) {
      emit({ a: 'use', herb: 'huiling' })
    }
    if (sim.en - COST.plant < minReservedEnForRipeOrBrew()) break
    let crop = chooseCropForEmptyPlot(sim, t, opts)
    if (!crop) break
    if (Number(sim.seeds?.[crop] || 0) < 1) {
      // Count how many empty plots remain so we buy up to `min(10, affordable)` in 1 action instead of 1 by 1
      const remEmpty = sim.plots.slice(i).filter((pl) => pl?.s === 'soil' && !pl.c).length
      const maxBuy = Math.min(10, remEmpty, Math.floor(sim.stone / HERBS[crop].seed))
      if (maxBuy < 1 || !emit({ a: 'buy', herb: crop, n: maxBuy })) break
    }
    if (!emit({ a: 'plant', i, herb: crop })) break
    if (sim.en - COST.water >= minReservedEnForRipeOrBrew()) {
      if (sim.can < 1) emit({ a: 'refill' })
      if (sim.can >= 1) emit({ a: 'water', i })
    }
  }

  // 7. Daily `huiling` quota top-up if late in CST day (`>= 20:00` or `< 25m` to midnight)
  while (shouldEatHuilingNow(sim, t, 0) && actions.length < opts.maxActionsPerBatch) {
    if (!emit({ a: 'use', herb: 'huiling' })) break
  }

  // 8. Alchemy Cauldron (`xsBrew`, `COST.brew = 5` `xs.en`)
  //    At `lv >= 5`, `peiyuan` yields 0 Farm XP and is strictly gated behind open-plot completion + surplus `xs.en`!
  if (!sim.brew && sim.en >= COST.brew && actions.length < opts.maxActionsPerBatch) {
    const usedDp = dpUsedToday(sim, t)
    const needHuilingToday = Number(sim.pills?.huiling || 0) < (PILL_DAILY - usedDp)
    const { huilingBatches, peiyuanBatches } = computeAlchemyHerbTargets(sim, t, opts)
    const surplusEn = computeSurplusEnergy(sim, t)
    const allOpenWatered = !sim.plots.some(
      (p) => p?.s === 'soil' && (!p.c || (p.g < 3 && !p.w) || p.g >= 3)
    )

    if (needHuilingToday && hasBrewIngredients(sim, 'huiling')) {
      emit({ a: 'brew', herb: 'huiling' })
    } else if (huilingBatches > 0 && hasBrewIngredients(sim, 'huiling') && (allOpenWatered || surplusEn >= COST.brew || sim.en >= 80)) {
      emit({ a: 'brew', herb: 'huiling' })
    } else if (
      peiyuanBatches > 0 &&
      hasBrewIngredients(sim, 'peiyuan') &&
      ((sim.lv || 1) < 5 || (allOpenWatered && (surplusEn >= COST.brew || sim.en >= 60)) || sim.en >= 85)
    ) {
      emit({ a: 'brew', herb: 'peiyuan' })
    }
  }

  // 9. Surplus-`xs.en` Weed Expansion (`xsHoe` `3` + `xsPlant` `1` + `xsWater` `1` = `5` `xs.en`)
  //    While `lv < 4`, 10 initial open plots of fast herbs (0.5h–3h) already exceed sustainable 325/day `xs.en`,
  //    so only hoe weeds below Lv4 if `sim.en >= 92` (anti-cap overflow); once `lv >= 4` (4.5h–6h herbs), expand with surplus `xs.en`!
  while (actions.length + 3 <= opts.maxActionsPerBatch) {
    const hasUnfinishedOpenPlot = sim.plots.some(
      (p) => p?.s === 'soil' && (!p.c || (p.g < 3 && !p.w) || p.g >= 3)
    )
    if (hasUnfinishedOpenPlot) break
    const weedIdx = sim.plots.findIndex((p) => p?.s === 'weed')
    if (weedIdx < 0) break
    const surplusEn = computeSurplusEnergy(sim, t)
    const canExpand = (sim.lv || 1) < 4
      ? sim.en >= 92
      : (surplusEn >= 8 || sim.en >= 65)
    if (!canExpand) break
    const crop = chooseCropForEmptyPlot(sim, t, opts)
    if (!crop) break
    if (Number(sim.seeds?.[crop] || 0) < 1) {
      if (sim.stone < HERBS[crop].seed) break
      if (!emit({ a: 'buy', herb: crop, n: 1 })) break
    }
    if (!emit({ a: 'hoe', i: weedIdx })) break
    if (!emit({ a: 'plant', i: weedIdx, herb: crop })) break
    if (sim.can < 1) emit({ a: 'refill' })
    if (sim.can >= 1 && sim.en >= COST.water) {
      emit({ a: 'water', i: weedIdx })
    }
  }

  // 10. Learn all matching root techniques (`50` stones each) BEFORE any root fusion can consume base roots!
  while (actions.length < opts.maxActionsPerBatch) {
    const techEl = findLearnableTech(sim)
    if (!techEl) break
    if (!emit({ a: 'learn', el: techEl })) break
  }
  const preferredTech = selectPreferredEquippedTech(sim)
  if (
    preferredTech &&
    (!sim.tech || (sim.te !== xsDay(t) && preferredTech !== sim.tech)) &&
    actions.length < opts.maxActionsPerBatch
  ) {
    emit({ a: 'equip', el: preferredTech })
  }

  // 11. Tail Stochastic & Meditation Section (`xsBreak` shield -> `xsRise` -> `xsSit` / `xsFuse`)
  const allowBreak = shouldAllowBreakPolicy(sim, opts)
  const curR = Number(sim.cv?.r || 0)
  const breakPillsNeed = curR + 1
  const haveBreakPills = Number(sim.pills?.peiyuan || 0) >= breakPillsNeed

  if (
    allowBreak &&
    haveBreakPills &&
    Number(sim.cv?.s || 1) >= 9 &&
    Number(sim.cv?.xp || 0) >= cvNeed(curR, 9) &&
    actions.length < opts.maxActionsPerBatch
  ) {
    // Case A: `cv.xp` is ALREADY full! Execute `xsBreak` BEFORE `xsRise` to shield in-flight `sim.med`!
    if (emit({ a: 'break' })) {
      emittedStochastic = true
      if (sim.med && t - Number(sim.med.t || 0) >= MED_MIN + 5 && actions.length + 1 < opts.maxActionsPerBatch) {
        if (emit({ a: 'rise' })) emit({ a: 'sit' })
      } else if (!sim.med && actions.length < opts.maxActionsPerBatch) {
        emit({ a: 'sit' })
      }
    }
  } else if (
    allowBreak &&
    haveBreakPills &&
    sim.med &&
    t - Number(sim.med.t || 0) >= MED_MIN + 5 &&
    actions.length + 2 <= opts.maxActionsPerBatch
  ) {
    // Case B: Check if rising right now reaches `s=9 && xp >= cvNeed(r, 9)` so we break without sitting past cap
    const proj = projectMeditationAfterRise(sim, t)
    if (proj && proj.s >= 9 && proj.xp >= cvNeed(curR, 9)) {
      if (emit({ a: 'rise' }) && emit({ a: 'break' })) {
        emittedStochastic = true
        if (actions.length < opts.maxActionsPerBatch) emit({ a: 'sit' })
      }
    }
  }

  // Normal 30-minute meditation cycle (continues even at `s=9` when break is deferred to build `>=1.43x` failure cushion!)
  if (!emittedStochastic) {
    if (sim.med && t - Number(sim.med.t || 0) >= MED_MAX && actions.length + 1 <= opts.maxActionsPerBatch) {
      if (emit({ a: 'rise' }) && actions.length < opts.maxActionsPerBatch) {
        emit({ a: 'sit' })
      }
    } else if (!sim.med && actions.length < opts.maxActionsPerBatch) {
      emit({ a: 'sit' })
    }

    // Optional Root Fusion (`--xian-auto-fuse`, default OFF):
    // Requires `r >= 1`, `!(fuseCd > t)`, `peiyuan >= 2`, `stone >= 200`, BOTH base root techs already learned in `sim.techs`,
    // and low `cv.xp` window (`<= max(15, 12% of cvNeed)`) so 45% failure loses ~0 XP!
    if (
      opts.autoFuse &&
      Number(sim.cv?.r || 0) >= 1 &&
      !(Number(sim.fuseCd || 0) > t) &&
      Number(sim.pills?.peiyuan || 0) >= 2 &&
      Number(sim.stone || 0) >= 200 &&
      actions.length < opts.maxActionsPerBatch
    ) {
      const pair = selectOptimalFusionPair(sim.roots, opts.fuseTarget)
      if (pair) {
        const learned = new Set(sim.techs || [])
        const bothBaseTechsLearned = learned.has(pair.e1) && learned.has(pair.e2)
        const lowXpCap = Math.max(15, Math.floor(cvNeed(Number(sim.cv?.r || 0), Number(sim.cv?.s || 1)) * 0.12))
        if (bothBaseTechsLearned && Number(sim.cv?.xp || 0) <= lowXpCap) {
          if (emit({ a: 'fuse', el: pair.key })) {
            emittedStochastic = true
          }
        }
      }
    }
  }

  assertSafeXianBatch(actions, world, opts)

  // If cauldron was just started (`t - brew.t < BREW_READY_SEC`), don't force 3s followUp; wake at `brew.t + 19` instead!
  const followUpSoon = Boolean(truncatedByBatchCap || emittedStochastic)
  return {
    enabled: true,
    actions,
    expectedSpendCoins: 0,
    followUpSoon,
    reason: actions.length > 0 ? 'actions-ready' : 'idle',
  }
}

export function computeNextXianWakeSec(world, nowSec = Number(world?.now || 0), rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!opts.enabled) return Infinity
  const t = Math.floor(Number(nowSec || world?.now || 0))
  const rawXs = world?.state?.xs
  if (!rawXs?.v || !rawXs.roots || !Array.isArray(rawXs.roots.e) || Number(rawXs.st || 0) < STORY_END) {
    return t + 120
  }
  if (rawXs.fight && t - Number(rawXs.fight.t || 0) < 1800) {
    return Math.min(t + 60, Number(rawXs.fight.t) + 1802)
  }

  // If actions are already executable right now, wake promptly (`t + 3s` > `GAP = 2.2s`).
  const preview = planXianActions(world, t, opts)
  if (preview.actions.length > 0) {
    return t + 3
  }

  // Otherwise, every candidate MUST be strictly `> t` so idle states never spin!
  const sim = structuredClone(rawXs)
  xsTick(sim, t)
  const candidates = [nextCstMidnightSec(t) + 3]

  if (sim.brew) {
    const brewReadyAt = Number(sim.brew.t || t) + BREW_READY_SEC
    if (brewReadyAt > t) candidates.push(brewReadyAt)
  }

  const growMult = sim.tech === 'wood' ? 0.8 : 1
  let waitingOnPlotEnergy =
    !sim.brew && (hasBrewIngredients(sim, 'huiling') || hasBrewIngredients(sim, 'peiyuan'))
  for (const p of sim.plots || []) {
    if (!p) continue
    if (p.c && p.g < 3 && p.w) {
      const stageReadyAt = Math.ceil(Number(p.w) + HERBS[p.c].grow * growMult + 1)
      if (stageReadyAt > t) candidates.push(stageReadyAt)
    } else if ((p.c && p.g >= 3) || (p.c && p.g < 3 && !p.w)) {
      waitingOnPlotEnergy = true
    } else if (p.s === 'soil' && !p.c && chooseCropForEmptyPlot(sim, t, opts)) {
      waitingOnPlotEnergy = true
    }
  }

  if (sim.en < EN_MAX) {
    const enBase = Number(sim.enAt || t)
    const regenSec = sim.tech === 'wind' ? EN_REGEN * 0.75 : EN_REGEN
    if (waitingOnPlotEnergy) {
      const nextTick = Math.ceil(enBase + regenSec + 1)
      candidates.push(nextTick > t ? nextTick : Math.ceil(t + regenSec))
    }
    const ticksTo88 = Math.max(1, 88 - Number(sim.en || 0))
    const nearCapAt = Math.ceil(enBase + ticksTo88 * regenSec + 1)
    if (nearCapAt > t) candidates.push(nearCapAt)
  }

  if (sim.med) {
    const medCapAt = Number(sim.med.t || t) + MED_MAX + 1
    if (medCapAt > t) candidates.push(medCapAt)

    // Exact early wake if in-flight meditation will hit `s=9 && cv.xp >= cvNeed(r, 9)` with breakthrough ready
    const curR = Number(sim.cv?.r || 0)
    if (shouldAllowBreakPolicy(sim, opts) && Number(sim.pills?.peiyuan || 0) >= curR + 1) {
      let remXp = 0
      const curS = Number(sim.cv?.s || 1)
      for (let s = curS; s <= 9; s++) remXp += cvNeed(curR, s)
      remXp -= Number(sim.cv?.xp || 0)
      const ratePerSec = (10 * rootMult(sim) * (sim.tech === 'ice' ? 1.2 : 1)) / 60
      if (remXp > 0 && ratePerSec > 0) {
        const secNeeded = Math.max(MED_MIN + 5, Math.ceil((remXp + 1) / ratePerSec))
        if (secNeeded < MED_MAX) {
          const breakReadyAt = Number(sim.med.t || t) + secNeeded
          if (breakReadyAt > t) candidates.push(breakReadyAt)
        }
      }
    }
  }

  if (opts.autoFuse && Number(sim.fuseCd || 0) > t) {
    candidates.push(Number(sim.fuseCd) + 2)
  }

  if (dpUsedToday(sim, t) < PILL_DAILY && Number(sim.pills?.huiling || 0) > 0) {
    const eveningTopUpAt = nextCstMidnightSec(t) - 4 * 3600 + 5
    if (eveningTopUpAt > t) candidates.push(eveningTopUpAt)
  }

  return Math.min(...candidates.filter((v) => Number.isFinite(v) && v > t))
}

/**
 * Executes a single preemptible, lock-serialized 「大肥鱼修仙记」 (`state.xs`) slice (`kind: 'xian-act'`).
 * Zero HTTP requests and zero lock contention when `observedWorld` shows no due `xs*` actions!
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
        reason: preview.reason,
        actions: [],
        expectedSpendCoins: 0,
        nextXianWakeSec: computeNextXianWakeSec(observedWorld, estNowSec, opts),
      }
    }
    if (dryRun || !journal) {
      return {
        status: 'dry-run-planned',
        reason: preview.reason,
        actions: preview.actions,
        expectedSpendCoins: 0,
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
      reason: preview.reason,
      actions: preview.actions,
      expectedSpendCoins: 0,
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
        reason: livePlan.reason,
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
        module: 'xs-xian',
        reason: livePlan.reason,
        breakMode: opts.breakMode,
        autoFuse: opts.autoFuse,
        expectedSpendCoins: 0,
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
    const nextXianWakeSec = txOut.status === 'confirmed' && livePlan.followUpSoon
      ? Math.min(computedWake, postNow + 3)
      : computedWake

    return {
      status: txOut.status,
      operation: txOut.operation,
      actions: livePlan.actions,
      expectedSpendCoins: 0,
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
