import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Unified Combat Simulator, Tactical Loadout Optimizer & Cross-Process Gear Lock (`execution/combat-engine.mjs`)
 *
 * Strictly 100% table-driven from `rules/pet-battle-rules.json` and `/api/pet/battle/gear` `catalog`:
 * - Zero hardcoded catalog item IDs anywhere in source code.
 * - Common-Random-Numbers (CRN) paired Monte Carlo loadout selection (`weapon`, `armor`, `charm`).
 * - Strict separation between `arena` and `guard` opponent snapshots + `isAssist` (`oppLv + 1`) level-cap rule.
 * - Cross-process `.battle-gear.<account>.lock` + `.gate` dead-PID recovery, pre-unlock staging hook,
 *   and mandatory `finally` restoration to resting defense gear (`dirty: true` fail-closed on failure).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BATTLE_RULES_PATH = path.resolve(__dirname, '../rules/pet-battle-rules.json')
const BATTLE_RULES = JSON.parse(fs.readFileSync(BATTLE_RULES_PATH, 'utf8'))

export const BATTLE_SKILLS = BATTLE_RULES.battleSkills
export const WEAPON_SKILLS = BATTLE_RULES.weaponSkills
export const LEVEL_GROWTH = BATTLE_RULES.levelGrowth
export const POINT_MULT = BATTLE_RULES.pointMult
export const POINT_KEY = BATTLE_RULES.pointKey
export const SLOTS = ['weapon', 'armor', 'charm']

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function wilsonInterval(wins, total, z = 1.28) {
  if (!(total > 0)) return null
  const phat = wins / total
  const denom = 1 + (z * z) / total
  const center = (phat + (z * z) / (2 * total)) / denom
  const half = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total)) / denom
  return [Math.max(0, Number((center - half).toFixed(4))), Math.min(1, Number((center + half).toFixed(4)))]
}

function pickSkill(f, meS, foeS, rng) {
  const ws = f.wskill ? WEAPON_SKILLS[f.wskill] : null
  if (ws) {
    if (!(ws.kind === 'heal' && meS.hp >= f.hp * 0.85) && rng() < ws.chance) return ws
  }
  const lv = f.level || f.lv || 10
  const skillSet = f._skillSet || (Array.isArray(f.skills) && f.skills.length > 0 ? new Set(f.skills) : null)
  for (const sk of BATTLE_SKILLS) {
    if (skillSet ? !skillSet.has(sk.id) : sk.level > lv) continue
    if (sk.kind === 'heal' && meS.hp >= f.hp * 0.85) continue
    if (sk.kind === 'shield' && meS.sh > 0) continue
    if (sk.kind === 'burn' && foeS.burn > 0) continue
    if (sk.kind === 'evade' && meS.evade > 0) continue
    if (sk.kind === 'focus' && meS.focus) continue
    if (rng() < sk.chance) return sk
  }
  return BATTLE_SKILLS[BATTLE_SKILLS.length - 1]
}

function applyDmg(targetS, dmg) {
  if (targetS.sh > 0) {
    const abs = Math.min(targetS.sh, dmg)
    targetS.sh -= abs
    targetS.hp -= (dmg - abs)
  } else {
    targetS.hp -= dmg
  }
}

/**
 * Simulates one 20-round battle: returns `0` (A wins), `1` (B wins), or `-1` (draw).
 */
export function simSingleBattle(A, B, rng = Math.random) {
  const s = [
    { hp: A.hp, sh: 0, stun: false, weak: 0, weakMul: 0.8, burn: 0, burnDmg: 0, evade: 0, focus: false, revived: false },
    { hp: B.hp, sh: 0, stun: false, weak: 0, weakMul: 0.8, burn: 0, burnDmg: 0, evade: 0, focus: false, revived: false },
  ]
  const F = [A, B]
  const checkDeath = (idx) => {
    if (s[idx].hp <= 0) {
      s[idx].hp = 0
      const rev = F[idx].passive?.revive
      if (rev && !s[idx].revived) {
        s[idx].revived = true
        s[idx].hp = Math.max(1, Math.round(F[idx].hp * rev))
        return false
      }
      return true
    }
    return false
  }

  for (let r = 1; r <= 20; r++) {
    let order
    const aFirst = Boolean(A.passive?.first)
    const bFirst = Boolean(B.passive?.first)
    if (r === 1 && aFirst !== bFirst) {
      order = aFirst ? [0, 1] : [1, 0]
    } else if (A.spd !== B.spd) {
      order = A.spd > B.spd ? [0, 1] : [1, 0]
    } else {
      order = rng() < 0.5 ? [0, 1] : [1, 0]
    }

    for (const by of order) {
      const foe = 1 - by
      const meF = F[by]
      const foeF = F[foe]
      const meS = s[by]
      const foeS = s[foe]

      if (meS.burn > 0) {
        meS.burn--
        applyDmg(meS, meS.burnDmg)
        if (checkDeath(by)) return foe
      }
      if (meS.stun) {
        meS.stun = false
        if (meS.weak > 0) meS.weak--
        if (meS.evade > 0) meS.evade--
        continue
      }

      const sk = pickSkill(meF, meS, foeS, rng)
      if (sk.kind === 'heal') {
        meS.hp = Math.min(meF.hp, meS.hp + Math.round(meF.hp * sk.power))
        if (sk.cleansesDebuffs) {
          meS.weak = 0
          meS.burn = 0
        } else if (sk.extra) {
          meS.sh += Math.round(meF.hp * sk.extra)
        }
        if (meS.weak > 0) meS.weak--
        if (meS.evade > 0) meS.evade--
        continue
      }
      if (sk.kind === 'shield') {
        meS.sh = Math.round(meF.hp * sk.power)
        if (meS.weak > 0) meS.weak--
        if (meS.evade > 0) meS.evade--
        continue
      }
      if (sk.kind === 'evade') {
        meS.evade = sk.turns || 2
        if (meS.weak > 0) meS.weak--
        continue
      }
      if (sk.kind === 'focus') {
        meS.focus = true
        if (meS.weak > 0) meS.weak--
        if (meS.evade > 0) meS.evade--
        continue
      }

      const hits = sk.hits || 1
      const foeEvadeBuff = foeS.evade > 0 ? 0.25 : 0
      const dodgeChance = Math.max(0.02, Math.min(0.40, 0.04 + ((foeF.agi || 10) - (meF.agi || 10)) * 0.006 + (foeF.passive?.evade || 0) + foeEvadeBuff))
      const critChance = Math.min(0.35, 0.10 + (meF.agi || 10) * 0.003)
      const atkEff = meF.atk * (meS.weak > 0 ? meS.weakMul : 1.0)
      const defMul = 100 / (100 + (foeF.def || 0))
      const forceCrit = sk.kind === 'crit' || meS.focus
      meS.focus = false

      let totalDmg = 0
      let anyHit = false
      for (let h = 0; h < hits; h++) {
        if (rng() < dodgeChance) continue
        anyHit = true
        const isCrit = (h === 0 && forceCrit) || sk.kind === 'crit' || rng() < critChance
        const dmg = Math.max(1, Math.round(atkEff * sk.power * (0.6 + rng() * 0.8) * (isCrit ? 1.7 : 1.0) * defMul))
        totalDmg += dmg
        applyDmg(foeS, dmg)
      }

      if (anyHit) {
        if (sk.kind === 'stun' && rng() < (sk.extra || 0.25)) foeS.stun = true
        if (sk.kind === 'weak') {
          foeS.weak = sk.turns || 2
          foeS.weakMul = Math.max(0.1, 1 - (sk.extra || 0.2))
        }
        if (sk.kind === 'burn') {
          foeS.burn = sk.turns || 3
          foeS.burnDmg = Math.max(1, Math.round(atkEff * (sk.extra || 0.25)))
        }
        if (sk.kind === 'drain' && totalDmg > 0) {
          meS.hp = Math.min(meF.hp, meS.hp + Math.round(totalDmg * (sk.extra || 0.5)))
        }
        if (meF.passive?.lifesteal && totalDmg > 0) {
          meS.hp = Math.min(meF.hp, meS.hp + Math.round(totalDmg * meF.passive.lifesteal))
        }
      }

      if (meS.weak > 0) meS.weak--
      if (meS.evade > 0) meS.evade--
      if (checkDeath(foe)) return by

      if (anyHit && foeF.passive?.thorns && totalDmg > 0) {
        const tDmg = Math.max(1, Math.round(totalDmg * foeF.passive.thorns))
        applyDmg(meS, tDmg)
        if (checkDeath(by)) return foe
      }
      if (anyHit && !foeS.stun && foeF.passive?.counter && rng() < foeF.passive.counter) {
        const cDmg = Math.max(1, Math.round(foeF.atk * (foeS.weak > 0 ? foeS.weakMul : 1.0) * 0.65 * (0.85 + rng() * 0.3) * (100 / (100 + (meF.def || 0)))))
        applyDmg(meS, cDmg)
        if (checkDeath(by)) return foe
      }
    }
  }

  const pctA = s[0].hp / A.hp
  const pctB = s[1].hp / B.hp
  return pctA === pctB ? -1 : pctA > pctB ? 0 : 1
}

export function simulateMatchup(meOrSampler, opp, { trials = 2000, seed = 20261110, mode = 'guard' } = {}) {
  const n = Math.max(1, Math.floor(trials))
  let wins = 0
  let draws = 0
  let losses = 0
  const utilities = new Float64Array(n)
  const oppReady = opp._skillSet ? opp : {
    ...opp,
    _skillSet: Array.isArray(opp.skills) && opp.skills.length > 0 ? new Set(opp.skills) : null,
  }
  const isFn = typeof meOrSampler === 'function'

  for (let i = 0; i < n; i++) {
    const me = isFn ? meOrSampler((i + 0.5) / n) : meOrSampler
    const rng = mulberry32((seed + Math.imul(i, 0x9e3779b9)) >>> 0)
    const r = simSingleBattle(me, oppReady, rng)
    let u
    if (r === 0) {
      wins++
      u = 1.0
    } else if (r === -1) {
      draws++
      u = mode === 'arena' ? 0.5 : 0.0
    } else {
      losses++
      u = mode === 'arena' ? 0.0 : -0.2
    }
    utilities[i] = u
  }

  const winRate = wins / n
  const drawRate = draws / n
  const lossRate = losses / n
  const utility = mode === 'arena' ? (winRate + 0.5 * drawRate) : (winRate - 0.2 * lossRate)
  return { wins, draws, losses, winRate, drawRate, lossRate, score: winRate + 0.5 * drawRate, utility, utilities }
}

function calcPairedSe(uA, uB) {
  const n = Math.min(uA.length, uB.length)
  if (n <= 1) return 0
  let mean = 0
  for (let i = 0; i < n; i++) mean += (uA[i] - uB[i])
  mean /= n
  let sq = 0
  for (let i = 0; i < n; i++) {
    const d = (uA[i] - uB[i]) - mean
    sq += d * d
  }
  return Math.sqrt(sq / (n * (n - 1)))
}

function calcSlotGearFloat(byId, equippedObj) {
  const out = { hp: 0, atk: 0, def: 0, agi: 0, spd: 0 }
  for (const slot of SLOTS) {
    const eq = equippedObj?.[slot]
    if (!eq?.id) continue
    const cat = byId.get(eq.id)
    if (!cat?.stats) continue
    const m = 0.30 * (1 + 0.04 * (eq.enh || 0))
    for (const k of Object.keys(out)) out[k] += (cat.stats[k] || 0) * m
  }
  return out
}

export function observedPanelKey(gearData, charmId, charmEnh, level, equipOverride = null) {
  const w = equipOverride?.weapon ?? gearData?.gear?.weapon
  const a = equipOverride?.armor ?? gearData?.gear?.armor
  const p = gearData?.points || {}
  return `${charmId}:${charmEnh ?? 0}:${level}|w:${w?.id || '-'}:${w?.enh || 0}|a:${a?.id || '-'}:${a?.enh || 0}|p:${p.str || 0},${p.vit || 0},${p.agi || 0},${p.spd || 0}`
}

export function recordObservedPanel(st, g) {
  if (!st || !g) return
  st.observedPanels ||= {}
  const cId = g?.gear?.charm?.id
  const cEnh = g?.gear?.charm?.enh || 0
  const lv = g?.level || 0
  const bd = g?.breakdown
  if (cId && lv && bd?.hp?.total != null) {
    st.observedPanels[observedPanelKey(g, cId, cEnh, lv)] = {
      hp: bd.hp.total,
      atk: bd.atk?.total ?? 10,
      def: bd.def?.total ?? 0,
      agi: bd.agi?.total ?? 10,
      spd: bd.spd?.total ?? 10,
    }
  }
}

export function buildCandidateLoadoutInterval(gearData, loadout = {}, { assistLevel = null, observedPanels = null } = {}) {
  const byId = new Map((gearData.catalog || []).map((c) => [c.id, c]))
  const ownedMap = new Map((gearData.items || []).map((it) => [it.id, it.enh || 0]))
  const realLv = gearData.level || 10
  const pts = gearData.points || {}
  const bd = gearData.breakdown || {}
  const curFloat = calcSlotGearFloat(byId, gearData.gear)

  const baseBounds = {}
  for (const k of ['hp', 'atk', 'def', 'agi', 'spd']) {
    if (k === 'def') {
      baseBounds.def = { lo: 0, hi: 0 }
      continue
    }
    const pKey = POINT_KEY[k]
    const pVal = (pts[pKey] || 0) * POINT_MULT[k]
    const bDisp = bd[k]?.base ?? 0
    const totDisp = bd[k]?.total ?? bDisp
    const lo = Math.max(bDisp - 0.499999, totDisp - 0.499999 - pVal - curFloat[k])
    const hi = Math.min(bDisp + 0.499999, totDisp + 0.499999 - pVal - curFloat[k])
    if (lo <= hi) baseBounds[k] = { lo, hi }
    else {
      const est = totDisp - pVal - curFloat[k]
      baseBounds[k] = { lo: est, hi: est }
    }
  }

  if (observedPanels && typeof observedPanels === 'object') {
    for (const [kStr, panel] of Object.entries(observedPanels)) {
      if (!panel || typeof panel !== 'object') continue
      const parts = String(kStr).split('|')
      if (parts.length !== 4) continue
      const [cPart, wPart, aPart, pPart] = parts
      const [obsCId, obsCEnhStr, obsLvStr] = cPart.split(':')
      if (Number(obsLvStr) !== realLv) continue
      const [, obsWId, obsWEnhStr] = wPart.split(':')
      const [, obsAId, obsAEnhStr] = aPart.split(':')
      const [oStr, oVit, oAgi, oSpd] = (pPart.slice(2) || '').split(',').map(Number)
      if (![oStr, oVit, oAgi, oSpd].every(Number.isFinite)) continue
      const obsPts = { str: oStr, vit: oVit, agi: oAgi, spd: oSpd }
      const obsFloat = calcSlotGearFloat(byId, {
        weapon: obsWId && obsWId !== '-' ? { id: obsWId, enh: Number(obsWEnhStr) || 0 } : null,
        armor: obsAId && obsAId !== '-' ? { id: obsAId, enh: Number(obsAEnhStr) || 0 } : null,
        charm: obsCId && obsCId !== '-' ? { id: obsCId, enh: Number(obsCEnhStr) || 0 } : null,
      })
      for (const k of ['hp', 'atk', 'agi', 'spd']) {
        if (panel[k] == null) continue
        const pVal = (obsPts[POINT_KEY[k]] || 0) * POINT_MULT[k]
        const candLo = panel[k] - 0.499999 - pVal - obsFloat[k]
        const candHi = panel[k] + 0.499999 - pVal - obsFloat[k]
        const nextLo = Math.max(baseBounds[k].lo, candLo)
        const nextHi = Math.min(baseBounds[k].hi, candHi)
        if (nextLo <= nextHi) {
          baseBounds[k] = { lo: nextLo, hi: nextHi }
        }
      }
    }
  }

  const resolveSlot = (slot, overrideId) => {
    const id = overrideId !== undefined ? overrideId : (gearData.gear?.[slot]?.id || null)
    if (!id) return null
    const enh = ownedMap.get(id) ?? (gearData.gear?.[slot]?.id === id ? (gearData.gear[slot].enh || 0) : 0)
    return { id, enh }
  }

  const modEquip = {
    weapon: resolveSlot('weapon', loadout?.weapon),
    armor: resolveSlot('armor', loadout?.armor),
    charm: resolveSlot('charm', loadout?.charm),
  }
  const candFloat = calcSlotGearFloat(byId, modEquip)

  const effLv = (assistLevel != null && assistLevel < realLv) ? Math.max(1, assistLevel) : realLv
  const lvDrop = realLv - effLv
  const ptScale = (lvDrop > 0 && realLv > 1) ? Math.max(0, (effLv - 1) / (realLv - 1)) : 1

  const charmId = modEquip.charm?.id || null
  const candEnh = modEquip.charm?.enh || 0
  const charmCat = charmId ? byId.get(charmId) : null
  const passive = {}
  if (charmCat?.passive?.kind) {
    const kind = charmCat.passive.kind
    passive[kind] = kind === 'first' ? 1 : charmCat.passive.value * (1 + 0.03 * candEnh)
  }
  const wId = modEquip.weapon?.id
  const wskill = wId ? 'w-' + wId : null

  const sameAsWorn =
    (modEquip.weapon?.id || null) === (gearData.gear?.weapon?.id || null) &&
    (modEquip.armor?.id || null) === (gearData.gear?.armor?.id || null) &&
    (modEquip.charm?.id || null) === (gearData.gear?.charm?.id || null)

  if (lvDrop === 0 && sameAsWorn && bd.hp?.total != null) {
    const exactCur = {
      level: effLv,
      hp: bd.hp.total,
      atk: bd.atk?.total ?? 10,
      def: bd.def?.total ?? 0,
      agi: bd.agi?.total ?? 10,
      spd: bd.spd?.total ?? 10,
      wskill,
      passive,
    }
    return { lo: exactCur, mid: exactCur, hi: exactCur, sample: () => exactCur }
  }

  const obsKey = charmId ? observedPanelKey(gearData, charmId, candEnh, realLv, modEquip) : null
  const obsPanel = (lvDrop === 0 && obsKey) ? observedPanels?.[obsKey] : null
  if (obsPanel) {
    const fixed = { level: effLv, ...obsPanel, wskill, passive }
    return { lo: fixed, mid: fixed, hi: fixed, sample: () => fixed }
  }

  const atQuantile = (q) => {
    const stats = {}
    for (const k of ['hp', 'atk', 'def', 'agi', 'spd']) {
      const pKey = POINT_KEY[k]
      const pVal = pKey ? (pts[pKey] || 0) * POINT_MULT[k] * ptScale : 0
      const baseVal = baseBounds[k].lo + (baseBounds[k].hi - baseBounds[k].lo) * q
      const bScaled = Math.max(0, baseVal - lvDrop * LEVEL_GROWTH[k])
      stats[k] = Math.round(bScaled + pVal + candFloat[k])
    }
    return { level: effLv, ...stats, wskill, passive }
  }

  const loF = atQuantile(0)
  const midF = atQuantile(0.5)
  const hiF = atQuantile(1)
  const identical = loF.hp === hiF.hp && loF.atk === hiF.atk && loF.def === hiF.def && loF.agi === hiF.agi && loF.spd === hiF.spd
  return {
    lo: loF,
    mid: midF,
    hi: hiF,
    sample: identical ? () => midF : atQuantile,
  }
}

/**
 * Purely catalog- & weaponSkill-driven resting defense gear scorer (zero hardcoded item IDs!).
 */
export function scoreGearItem(catItem, enh = 0) {
  if (!catItem) return 0
  const st = catItem.stats || {}
  const statMult = 0.30 * (1 + 0.04 * (enh || 0))
  const statScore = ((st.atk || 0) * 10
    + (st.spd || 0) * 8
    + (st.agi || 0) * 8
    + (st.def || 0) * 3
    + (st.hp || 0) * 0.5) * statMult
  const pasKind = catItem.passive?.kind
  const pasVal = (catItem.passive?.value || 0) * (pasKind === 'first' ? 1 : (1 + 0.03 * (enh || 0)))
  const pasBonus = pasKind === 'revive' ? pasVal * 1200
    : pasKind === 'lifesteal' ? pasVal * 620
    : pasKind === 'counter' ? pasVal * 320
    : catItem.passive ? 35 : 0
  const ws = catItem.id ? WEAPON_SKILLS['w-' + catItem.id] : null
  const skillBonus = ws?.kind === 'crit' ? 30 : (catItem.skill || ws ? 18 : 0)
  const rarityAndSkill = (catItem.rarity || 1) * 15 + skillBonus
  return Math.round((statScore + pasBonus + rarityAndSkill) * 100) / 100
}

/**
 * Computes optimal resting defense gear and stat-point breakpoint allocation.
 * Dynamically identifies zero-speed guaranteed-crit legendary weapons from `WEAPON_SKILLS` + `catalog.stats`.
 */
export function planGearAndPoints(gearData) {
  const byId = new Map((gearData.catalog || []).map((c) => [c.id, c]))
  const owned = (gearData.items || []).map((it) => ({ id: it.id, enh: it.enh || 0 }))
  const equip = []
  const detail = {}
  for (const slot of SLOTS) {
    let best = null
    for (const o of owned) {
      const cat = byId.get(o.id)
      if (!cat || cat.slot !== slot) continue
      const score = scoreGearItem(cat, o.enh)
      if (!best || score > best.score) best = { slot, item: o.id, name: cat.name, score, enh: o.enh }
    }
    const cur = gearData.gear?.[slot]?.id ?? null
    detail[slot] = { best: best?.item ?? null, current: cur, score: best?.score ?? 0, name: best?.name }
    if (best && cur !== best.item) equip.push({ slot, item: best.item, name: best.name, score: best.score })
  }

  const curPoints = gearData.points || {}
  const points = {
    str: curPoints.str || 0,
    vit: curPoints.vit || 0,
    agi: curPoints.agi || 0,
    spd: curPoints.spd || 0,
  }
  const free = gearData.free || 0

  if (free > 0) {
    let rem = free
    const bestWeaponId = detail.weapon?.best || gearData.gear?.weapon?.id || null
    const bestWeaponCat = bestWeaponId ? byId.get(bestWeaponId) : null
    const bestWeaponSkill = bestWeaponId ? WEAPON_SKILLS['w-' + bestWeaponId] : null
    const isZeroSpdCritWeapon = Boolean(bestWeaponSkill?.kind === 'crit' && !(bestWeaponCat?.stats?.spd > 0))
    const wearingBestCritWeapon = isZeroSpdCritWeapon && gearData.gear?.weapon?.id === bestWeaponId
    const curSpdPts = points.spd || 0
    const wornSpdTotal = wearingBestCritWeapon ? gearData.breakdown?.spd?.total : null
    const wornAtkTotal = wearingBestCritWeapon ? gearData.breakdown?.atk?.total : null

    let minSpdPts = 3
    let reserveForSpdObs = 0
    if (isZeroSpdCritWeapon) {
      if (!wearingBestCritWeapon || wornSpdTotal == null || curSpdPts < 4) {
        minSpdPts = 4
        const afterReach4 = Math.max(0, rem - Math.max(0, 4 - curSpdPts))
        reserveForSpdObs = afterReach4 >= 2 ? 2 : 0
      } else if (wornSpdTotal < 19) {
        minSpdPts = Math.min(6, curSpdPts + 1)
        const afterNextSpd = Math.max(0, rem - Math.max(0, minSpdPts - curSpdPts))
        reserveForSpdObs = (minSpdPts < 6 && afterNextSpd >= 1) ? 1 : 0
      } else {
        minSpdPts = curSpdPts
        reserveForSpdObs = 0
      }
    }

    while (rem > 0 && (points.spd || 0) < minSpdPts) {
      points.spd = (points.spd || 0) + 1
      rem--
    }

    let spendableRem = Math.max(0, rem - reserveForSpdObs)
    const isLv13Balanced = isZeroSpdCritWeapon && (gearData.level || 0) >= 13

    if (isLv13Balanced) {
      const LV13_EARLY_STR_BPS = [2, 4, 7, 9, 12, 14, 17, 19, 22, 24]
      const LV14_PLUS_STR_BPS = [26, 29, 32, 34, 37, 39, 42, 44]
      while (spendableRem > 0 && (points.str || 0) < 24) {
        const curStr = points.str || 0
        const nextBp = LV13_EARLY_STR_BPS.find((bp) => bp > curStr) || 24
        const need = nextBp - curStr
        if (need <= spendableRem) {
          points.str = curStr + need
          spendableRem -= need
        } else if (reserveForSpdObs > 0) {
          break
        } else {
          points.vit = (points.vit || 0) + spendableRem
          spendableRem = 0
        }
      }
      if (spendableRem > 0 && (points.str || 0) >= 24 && (points.vit || 0) < 8) {
        const addVit = Math.min(spendableRem, 8 - (points.vit || 0))
        points.vit = (points.vit || 0) + addVit
        spendableRem -= addVit
      }
      while (spendableRem > 0 && reserveForSpdObs === 0) {
        const curStr = points.str || 0
        const nextBp = LV14_PLUS_STR_BPS.find((bp) => bp > curStr)
        const need = nextBp ? nextBp - curStr : 999
        if (need <= spendableRem) {
          points.str = curStr + need
          spendableRem -= need
        } else {
          points.vit = (points.vit || 0) + spendableRem
          spendableRem = 0
        }
      }
    } else {
      const STR_BREAKPOINTS = isZeroSpdCritWeapon
        ? (reserveForSpdObs > 0
            ? [2, 4, 7, 9, 12, 14, 17, 19, 22, 24, 26]
            : [2, 4, 7, 9, 12, 14, 17, 19, 22, 24, 26, 29, 32, 34, 37, 39, 42, 44])
        : [3, 5, 8, 10, 13, 15, 18, 20, 23, 25, 28, 30, 33, 35, 38, 40, 43, 45]

      if (
        isZeroSpdCritWeapon &&
        wearingBestCritWeapon &&
        reserveForSpdObs === 0 &&
        (points.str || 0) === 26 &&
        wornAtkTotal != null &&
        wornAtkTotal < 43 &&
        spendableRem >= 1
      ) {
        points.str = 27
        spendableRem -= 1
      }

      while (spendableRem > 0) {
        const curStr = points.str || 0
        const nextBp = STR_BREAKPOINTS.find((bp) => bp > curStr)
        const need = nextBp ? nextBp - curStr : 999
        if (need <= spendableRem) {
          points.str = curStr + need
          spendableRem -= need
        } else if (reserveForSpdObs > 0) {
          break
        } else {
          points.vit = (points.vit || 0) + spendableRem
          spendableRem = 0
        }
      }
    }
  }

  const pointsChanged =
    points.str !== (curPoints.str || 0) ||
    points.vit !== (curPoints.vit || 0) ||
    points.agi !== (curPoints.agi || 0) ||
    points.spd !== (curPoints.spd || 0)
  return { equip, detail, points, free, allocate: free > 0 && pointsChanged }
}

// ---------- Opponent Profile Store (arena vs guard strictly isolated) ----------
const _profileMemCache = new Map()

function defaultProfileStore() {
  return { updatedAt: 0, lastGuardLogId: {}, lastHomeHistoryId: {}, profiles: {} }
}

function isAssistFighter(f) {
  return Boolean(f?.assist || /静潮协防/.test(String(f?.name || '')))
}

function cleanFighterSnap(f, nowSec, { sourceMode = 'arena', battleId = null } = {}) {
  if (!f || !f.id) return null
  const realNow = Math.floor(Date.now() / 1000)
  const safeTs = nowSec > realNow + 86400 ? realNow : nowSec
  const wId = f.gear?.weapon?.id
  return {
    id: Number(f.id),
    name: String(f.name || '').replace(/\s*·\s*静潮协防$/, ''),
    level: f.level || 1,
    hp: f.hp,
    atk: f.atk,
    def: f.def || 0,
    agi: f.agi || 10,
    spd: f.spd || 10,
    wskill: f.wskill || (wId ? 'w-' + wId : null),
    passive: f.passive || {},
    gear: f.gear || {},
    skills: Array.isArray(f.skills) && f.skills.length > 0 ? [...f.skills] : null,
    isAssist: isAssistFighter(f),
    sourceMode,
    battleId,
    updatedAt: safeTs,
  }
}

export function loadProfileStore(storePath) {
  if (!storePath) return defaultProfileStore()
  try {
    if (fs.existsSync(storePath)) {
      const st = fs.statSync(storePath)
      const cached = _profileMemCache.get(storePath)
      if (cached && cached.mtimeMs === st.mtimeMs) return cached.store
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed && typeof parsed.profiles === 'object') {
        parsed.lastGuardLogId ||= {}
        parsed.lastHomeHistoryId ||= {}
        _profileMemCache.set(storePath, { mtimeMs: st.mtimeMs, store: parsed })
        return parsed
      }
    }
  } catch {}
  return defaultProfileStore()
}

export function saveProfileStore(store, storePath) {
  if (!storePath) return
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  store.updatedAt = Math.floor(Date.now() / 1000)
  const tmp = `${storePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  fs.renameSync(tmp, storePath)
  const st = fs.statSync(storePath)
  _profileMemCache.set(storePath, { mtimeMs: st.mtimeMs, store })
}

export function recordBattleSnapshot(rawBattleOrWrapper, mode = 'arena', { storePath } = {}) {
  const battle = rawBattleOrWrapper?.fighters ? rawBattleOrWrapper : rawBattleOrWrapper?.battle
  if (!storePath || !battle?.fighters || battle.fighters.length < 2) return false
  const effMode = (battle.xp != null && battle.xp > 0) ? 'arena' : mode
  const nowSec = battle.created_at || Math.floor(Date.now() / 1000)
  const battleId = battle.id ?? null
  const [A, B] = battle.fighters
  const store = loadProfileStore(storePath)
  let changed = false

  if (effMode === 'arena') {
    for (const f of [A, B]) {
      if (!f?.id || isAssistFighter(f)) continue
      const snap = cleanFighterSnap(f, nowSec, { sourceMode: 'arena', battleId })
      if (!snap) continue
      const key = String(snap.id)
      const prev = store.profiles[key] || { id: snap.id, name: snap.name }
      if (!prev.arena || snap.updatedAt >= (prev.arena.updatedAt || 0)) {
        prev.name = snap.name || prev.name
        prev.arena = snap
        store.profiles[key] = prev
        changed = true
      }
    }
  } else {
    if (B?.id) {
      const snapB = cleanFighterSnap(B, nowSec, { sourceMode: 'guard', battleId })
      if (snapB) {
        const keyB = String(snapB.id)
        const prevB = store.profiles[keyB] || { id: snapB.id, name: snapB.name }
        if (!prevB.guard || snapB.updatedAt >= (prevB.guard.updatedAt || 0)) {
          prevB.name = snapB.name || prevB.name
          prevB.guard = snapB
          store.profiles[keyB] = prevB
          changed = true
        }
      }
    }
    if (A?.id && !isAssistFighter(A) && (A.level || 1) <= (B?.level || 1) && A.gear && Object.keys(A.gear).length > 0) {
      const snapA = cleanFighterSnap(A, nowSec, { sourceMode: 'guard-attacker-uncapped', battleId })
      if (snapA) {
        const keyA = String(snapA.id)
        const prevA = store.profiles[keyA] || { id: snapA.id, name: snapA.name }
        if (!prevA.arena) {
          prevA.name = snapA.name || prevA.name
          prevA.arena = snapA
          store.profiles[keyA] = prevA
          changed = true
        }
      }
    }
  }

  if (changed) saveProfileStore(store, storePath)
  return changed
}

function adaptSnapToKnownLevel(snap, knownLevel) {
  if (!snap || !knownLevel || snap.isAssist || snap.level === knownLevel) return snap
  const diff = knownLevel - (snap.level || 1)
  if (diff <= 0) return snap
  return {
    ...snap,
    level: knownLevel,
    hp: Math.max(1, Math.round(snap.hp + diff * LEVEL_GROWTH.hp)),
    atk: Math.max(1, Math.round(snap.atk + diff * LEVEL_GROWTH.atk)),
    agi: Math.max(1, Math.round((snap.agi || 10) + diff * LEVEL_GROWTH.agi)),
    spd: Math.max(1, Math.round((snap.spd || 10) + diff * LEVEL_GROWTH.spd)),
    skills: null,
    levelAdjustedFrom: snap.level,
  }
}

export function getOpponentSnap(opponentId, mode = 'guard', { storePath, knownOpponentLevel = null, homeHpMult = 1.1 } = {}) {
  const store = loadProfileStore(storePath)
  const entry = store.profiles?.[String(opponentId)]
  if (!entry) return null
  if (mode === 'arena') {
    if (entry.arena && !entry.arena.isAssist) {
      return adaptSnapToKnownLevel(entry.arena, knownOpponentLevel)
    }
    return null
  }
  let chosen = entry.guard || null
  if (
    knownOpponentLevel &&
    chosen &&
    !chosen.isAssist &&
    entry.arena &&
    !entry.arena.isAssist &&
    entry.arena.level === knownOpponentLevel &&
    chosen.level < knownOpponentLevel
  ) {
    chosen = entry.arena
  } else if (!chosen && entry.arena && !entry.arena.isAssist) {
    chosen = entry.arena
  }
  if (!chosen) return null
  const adapted = adaptSnapToKnownLevel(chosen, knownOpponentLevel)
  // If falling back from uncapped `arena` snapshot to `guard` mode, apply server's `rules.homeHp = 1.1` defender HP buff!
  if (chosen.sourceMode !== 'guard' && homeHpMult > 1) {
    return { ...adapted, hp: Math.max(1, Math.round(adapted.hp * homeHpMult)) }
  }
  return adapted
}

function getCandidateOwnedLoadouts(gearData, restingLoadout) {
  const byId = new Map((gearData.catalog || []).map((c) => [c.id, c]))
  const owned = (gearData.items || []).map((it) => ({ id: it.id, enh: it.enh || 0, cat: byId.get(it.id) })).filter((x) => x.cat)

  const pickTopBySlot = (slot, limit = 4) => {
    const list = owned
      .filter((x) => x.cat.slot === slot)
      .map((x) => ({ ...x, score: scoreGearItem(x.cat, x.enh) }))
      .sort((a, b) => b.score - a.score)
    const ids = list.slice(0, limit).map((x) => x.id)
    const restId = restingLoadout?.[slot] || gearData.gear?.[slot]?.id || null
    if (restId && !ids.includes(restId)) ids.unshift(restId)
    return ids.length > 0 ? ids : [null]
  }

  const weapons = pickTopBySlot('weapon', 4)
  const armors = pickTopBySlot('armor', 3)
  const charms = pickTopBySlot('charm', 5)

  const seen = new Set()
  const combos = []
  const pushCombo = (w, a, c) => {
    const key = `${w || '-'}|${a || '-'}|${c || '-'}`
    if (seen.has(key)) return
    seen.add(key)
    combos.push({ key, weapon: w || null, armor: a || null, charm: c || null })
  }

  const rw = restingLoadout?.weapon || gearData?.gear?.weapon?.id || weapons[0] || null
  const ra = restingLoadout?.armor || gearData?.gear?.armor?.id || armors[0] || null
  const rc = restingLoadout?.charm || gearData?.gear?.charm?.id || charms[0] || null
  pushCombo(rw, ra, rc)

  for (const w of weapons) {
    for (const a of armors) {
      for (const c of charms) pushCombo(w, a, c)
    }
  }
  return combos
}

export function gearLoadoutPlanSignature(gearData, restingLoadout = {}) {
  const pts = gearData?.points || {}
  const ownedSig = (gearData?.items || [])
    .map((x) => `${x.id}:${x.enh || 0}`)
    .sort()
    .join(',')
  return `${gearData?.level || 0}|${pts.str || 0},${pts.vit || 0},${pts.agi || 0},${pts.spd || 0}|r:${restingLoadout.weapon || '-'}/${restingLoadout.armor || '-'}/${restingLoadout.charm || '-'}|${ownedSig}`
}

export function pickOptimalLoadout(gearData, opponentId, {
  mode = 'guard',
  restingLoadout = null,
  trials = 2000,
  minGain = 0.005,
  zThreshold = 2.0,
  knownOpponentLevel = null,
  observedPanels = null,
  storePath = null,
} = {}) {
  const bestRestPlan = planGearAndPoints(gearData)
  const effResting = {
    weapon: restingLoadout?.weapon || bestRestPlan.detail.weapon?.best || gearData?.gear?.weapon?.id || null,
    armor: restingLoadout?.armor || bestRestPlan.detail.armor?.best || gearData?.gear?.armor?.id || null,
    charm: restingLoadout?.charm || bestRestPlan.detail.charm?.best || gearData?.gear?.charm?.id || null,
  }
  const combos = getCandidateOwnedLoadouts(gearData, effResting)
  const fallback = combos[0] || { key: '-|-|-', ...effResting }
  const fallbackLoadout = { weapon: fallback.weapon, armor: fallback.armor, charm: fallback.charm }
  const planGearSig = gearLoadoutPlanSignature(gearData, fallbackLoadout)

  if (combos.length <= 1) {
    return {
      loadout: fallbackLoadout,
      restingLoadout: fallbackLoadout,
      switched: false,
      switchedSlots: [],
      reason: 'single-loadout',
      planGearSig,
    }
  }

  const opp = getOpponentSnap(opponentId, mode, { storePath, knownOpponentLevel })
  if (!opp) {
    return {
      loadout: fallbackLoadout,
      restingLoadout: fallbackLoadout,
      switched: false,
      switchedSlots: [],
      reason: 'unknown-opponent',
      planGearSig,
    }
  }

  const realLv = gearData.level || 10
  const effOppLv = knownOpponentLevel ?? opp.level ?? 1
  const assistLevel = (mode === 'guard' && opp.isAssist && effOppLv + 1 < realLv)
    ? effOppLv + 1
    : null

  const seed = (20261110 ^ (Number(opponentId) || 0)) >>> 0
  const outcomes = new Map()
  const diffSlotsCount = (c) =>
    (c.weapon !== fallback.weapon ? 1 : 0) +
    (c.armor !== fallback.armor ? 1 : 0) +
    (c.charm !== fallback.charm ? 1 : 0)

  for (const combo of combos) {
    const interval = buildCandidateLoadoutInterval(gearData, combo, { assistLevel, observedPanels })
    const res = simulateMatchup(interval.sample, opp, { trials, seed, mode })
    outcomes.set(combo.key, res)
  }

  const baseOut = outcomes.get(fallback.key)
  let bestCombo = fallback
  let bestOut = baseOut
  for (const combo of combos) {
    const out = outcomes.get(combo.key)
    if (
      out.utility > bestOut.utility + 1e-9 ||
      (Math.abs(out.utility - bestOut.utility) <= 1e-9 && diffSlotsCount(combo) < diffSlotsCount(bestCombo))
    ) {
      bestOut = out
      bestCombo = combo
    }
  }

  const rawGain = bestOut.utility - baseOut.utility
  const se = bestCombo.key !== fallback.key ? calcPairedSe(bestOut.utilities, baseOut.utilities) : 0
  const zScore = se > 0 ? rawGain / se : (rawGain > 0 ? Infinity : 0)
  const shouldSwitch = bestCombo.key !== fallback.key && rawGain >= minGain && zScore >= zThreshold

  const chosenCombo = shouldSwitch ? bestCombo : fallback
  const chosenOut = shouldSwitch ? bestOut : baseOut
  const chosenLoadout = { weapon: chosenCombo.weapon, armor: chosenCombo.armor, charm: chosenCombo.charm }
  const switchedSlots = SLOTS.filter((s) => chosenLoadout[s] !== fallbackLoadout[s])

  return {
    loadout: chosenLoadout,
    restingLoadout: fallbackLoadout,
    switched: shouldSwitch && switchedSlots.length > 0,
    switchedSlots,
    winRate: chosenOut.winRate,
    drawRate: chosenOut.drawRate,
    lossRate: chosenOut.lossRate,
    utility: chosenOut.utility,
    defaultWinRate: baseOut.winRate,
    defaultLossRate: baseOut.lossRate,
    gain: rawGain,
    se,
    zScore,
    oppName: opp.name,
    oppLevel: effOppLv,
    isAssist: Boolean(opp.isAssist),
    planGearSig,
  }
}

const _tacticalDecisionCache = new Map()

function opponentSnapSignature(opp) {
  if (!opp) return 'none'
  const f = opp.fighter || opp
  return JSON.stringify({
    id: opp.id ?? null,
    lv: f.level ?? opp.level ?? null,
    hp: f.hp ?? null,
    atk: f.atk ?? null,
    def: f.def ?? null,
    spd: f.spd ?? null,
    cri: f.cri ?? null,
    dod: f.dod ?? null,
    skills: f.skills ?? null,
    gear: f.gear ?? null,
    updatedAt: opp.updatedAt ?? null,
  })
}

/**
 * Computes simulated guard matchup `{ winInterval, lossInterval, optimalLoadout, decision }`
 * from `opponent-profiles.json` + player's `gearData`, cached by `(targetId, oppSnapSig, planGearSig)`
 * so discovery, unified economic planning, and pre-unlock equipping share the exact same loadout & rates!
 */
export function computeGuardPosteriorForTarget(gearData, targetId, {
  knownOpponentLevel = null,
  observedPanels = null,
  storePath = null,
  trials = 800,
} = {}) {
  if (!gearData || !storePath) return null
  const opp = getOpponentSnap(targetId, 'guard', { storePath, knownOpponentLevel })
  if (!opp) return null

  const bestRest = planGearAndPoints(gearData)
  const effResting = {
    weapon: bestRest.detail.weapon?.best || gearData?.gear?.weapon?.id || null,
    armor: bestRest.detail.armor?.best || gearData?.gear?.armor?.id || null,
    charm: bestRest.detail.charm?.best || gearData?.gear?.charm?.id || null,
  }
  const gearSig = gearLoadoutPlanSignature(gearData, effResting)
  const oppSig = opponentSnapSignature(opp)
  const cacheKey = `${targetId}|${oppSig}|${gearSig}|${trials}`

  let dec = _tacticalDecisionCache.get(cacheKey)
  if (!dec) {
    dec = pickOptimalLoadout(gearData, targetId, {
      mode: 'guard',
      restingLoadout: effResting,
      trials,
      knownOpponentLevel,
      observedPanels,
      storePath,
    })
    if (_tacticalDecisionCache.size > 512) _tacticalDecisionCache.clear()
    _tacticalDecisionCache.set(cacheKey, dec)
  }
  if (dec.winRate == null || dec.lossRate == null) return null

  const drawRate = Math.max(0, 1 - dec.winRate - dec.lossRate)
  return {
    simulated: true,
    trials,
    winInterval: [dec.winRate, dec.winRate],
    lossInterval: [dec.lossRate, dec.lossRate],
    drawRate,
    optimalLoadout: dec.loadout,
    restingLoadout: effResting,
    numGearChanges: SLOTS.filter((s) => dec.loadout?.[s] && dec.loadout[s] !== effResting[s]).length,
    switched: dec.switched,
    winRateMid: dec.winRate,
    lossRateMid: dec.lossRate,
    planGearSig: dec.planGearSig,
    decision: dec,
  }
}

// ---------- Cross-Process Gear Lock & Atomic Swap/Restore ----------
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

export function gearLockPathFor(accountKey, lockRoot) {
  return path.join(lockRoot, `.battle-gear.${accountKey || 'main'}.lock`)
}

export function gearStatePathFor(accountKey, lockRoot) {
  return path.join(lockRoot, `.battle-gear-state.${accountKey || 'main'}.json`)
}

export function readAccountGearState(accountKey, lockRoot) {
  const fp = gearStatePathFor(accountKey, lockRoot)
  try {
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '')) || {}
    }
  } catch {}
  return {}
}

export function writeAccountGearState(stateObj, accountKey, lockRoot) {
  if (!lockRoot) return
  fs.mkdirSync(lockRoot, { recursive: true })
  const fp = gearStatePathFor(accountKey, lockRoot)
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(stateObj, null, 2), 'utf8')
  fs.renameSync(tmp, fp)
}

export async function withGearLock(lockRoot, accountKey, fn, {
  timeoutMs = 20000,
  retryMs = 25,
  aliveFn = isProcessAlive,
} = {}) {
  fs.mkdirSync(lockRoot, { recursive: true })
  const lockFile = gearLockPathFor(accountKey, lockRoot)
  const gateFile = `${lockFile}.gate`
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`
  const deadline = Date.now() + timeoutMs
  let acquired = false

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
      fs.closeSync(fd)
      acquired = true
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      // Dead-PID-only reclamation serialized behind `.gate` so live long-running requests are NEVER stolen!
      try {
        const gfd = fs.openSync(gateFile, 'wx')
        try {
          const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
          if (raw && Number.isInteger(raw.pid) && !aliveFn(raw.pid)) {
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
    throw new Error(`Failed to acquire gear lock for ${accountKey} within ${timeoutMs}ms`)
  }

  try {
    return await fn()
  } finally {
    try {
      const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (raw?.token === token) fs.unlinkSync(lockFile)
    } catch {}
  }
}

export function extractEquippedIds(gearData) {
  return {
    weapon: gearData?.gear?.weapon?.id || null,
    armor: gearData?.gear?.armor?.id || null,
    charm: gearData?.gear?.charm?.id || null,
  }
}

/**
 * Executes a single arena bout or urgent neighbor raid inside `.battle-gear.<account>.lock`:
 * 1. Verifies live `gear` (`getGearFn`) and recovers any prior crashed `dirty` state.
 * 2. Recomputes CRN optimal loadout if `planGearSig` changed since pre-check.
 * 3. Equips tactical slots BEFORE `waitBeforeActionFn` (so urgent snipes pre-swap at `T - 2.5s` and fire at `T + 35ms` with 0ms swap lag!).
 * 4. Runs `actionFn`, then in `finally` ALWAYS restores `restingLoadout` (2 attempts + `getGearFn` check + fail-closed `dirty: true` if restore fails).
 */
export async function executeWithTacticalLoadout({
  accountKey = 'main',
  lockRoot,
  opponentId,
  mode = 'guard',
  knownOpponentLevel = null,
  storePath = null,
  precomputedDecision = null,
  getGearFn,
  equipSlotFn,
  waitBeforeActionFn = null,
  actionFn,
}) {
  return withGearLock(lockRoot, accountKey, async () => {
    const st = readAccountGearState(accountKey, lockRoot)
    let gearSnap = await getGearFn()
    recordObservedPanel(st, gearSnap)

    const bestRest = planGearAndPoints(gearSnap)
    const effResting = {
      weapon: bestRest.detail.weapon?.best || st.restingGear?.weapon || gearSnap?.gear?.weapon?.id || null,
      armor: bestRest.detail.armor?.best || st.restingGear?.armor || gearSnap?.gear?.armor?.id || null,
      charm: bestRest.detail.charm?.best || st.restingGear?.charm || gearSnap?.gear?.charm?.id || null,
    }
    st.restingGear = effResting
    st.restingCharm = effResting.charm

    const liveSig = gearLoadoutPlanSignature(gearSnap, effResting)
    let decision = (precomputedDecision && precomputedDecision.planGearSig === liveSig)
      ? precomputedDecision
      : null
    if (!decision) {
      const opp = storePath ? getOpponentSnap(opponentId, mode, { storePath, knownOpponentLevel }) : null
      const oppSig = opponentSnapSignature(opp)
      for (const [k, cachedDec] of _tacticalDecisionCache.entries()) {
        if (k.startsWith(`${opponentId}|${oppSig}|${liveSig}|`)) {
          decision = cachedDec
          break
        }
      }
    }
    if (!decision) {
      decision = pickOptimalLoadout(gearSnap, opponentId, {
        mode,
        restingLoadout: effResting,
        knownOpponentLevel,
        observedPanels: st.observedPanels,
        storePath,
      })
    }

    const targetLoadout = decision.loadout || effResting
    let curEquipped = extractEquippedIds(gearSnap)
    let preEquipError = null
    let actionResult = null
    let actionError = null
    let restoreError = null
    const uncertainSlots = new Set()

    try {
      for (const slot of SLOTS) {
        const wantId = targetLoadout[slot]
        if (wantId && curEquipped[slot] !== wantId) {
          st.dirty = true
          writeAccountGearState(st, accountKey, lockRoot)
          try {
            const eqRes = await equipSlotFn(slot, wantId)
            if (eqRes?.status === 200) {
              if (eqRes.body?.breakdown) {
                gearSnap = eqRes.body.catalog ? eqRes.body : { ...gearSnap, ...eqRes.body }
                recordObservedPanel(st, gearSnap)
              }
              curEquipped[slot] = wantId
            } else {
              uncertainSlots.add(slot)
              preEquipError ||= `equip-${slot}-status-${eqRes?.status ?? 'unknown'}`
            }
          } catch (eqErr) {
            uncertainSlots.add(slot)
            preEquipError ||= `equip-${slot}-throw:${eqErr?.message || String(eqErr)}`
          }
        }
      }

      st.activeGear = { ...curEquipped }
      st.activeCharm = curEquipped.charm
      st.dirty = uncertainSlots.size > 0 || SLOTS.some((s) => effResting[s] && curEquipped[s] !== effResting[s])
      st.updatedAt = Date.now()
      st.gearSnap = gearSnap
      writeAccountGearState(st, accountKey, lockRoot)

      if (!preEquipError) {
        if (typeof waitBeforeActionFn === 'function') {
          await waitBeforeActionFn({ decision, gear: gearSnap, activeGear: curEquipped })
        }
        actionResult = await actionFn({ decision, gear: gearSnap, activeGear: curEquipped, observedPanels: st.observedPanels })
      }
    } catch (err) {
      actionError = err
    } finally {
      if (uncertainSlots.size > 0) {
        try {
          const gVerify = await getGearFn()
          if (gVerify?.gear) {
            gearSnap = gVerify
            recordObservedPanel(st, gVerify)
            curEquipped = extractEquippedIds(gVerify)
          }
        } catch {}
      }
      const slotsToRestore = SLOTS.filter((s) => effResting[s] && (curEquipped[s] !== effResting[s] || uncertainSlots.has(s)))
      if (slotsToRestore.length > 0 || st.dirty) {
        st.dirty = true
        writeAccountGearState(st, accountKey, lockRoot)
        for (const slot of slotsToRestore) {
          const wantRest = effResting[slot]
          let slotRestored = false
          let lastErr = null
          for (let attempt = 0; attempt < 2 && !slotRestored; attempt++) {
            try {
              const rBack = await equipSlotFn(slot, wantRest)
              lastErr = rBack?.status ?? null
              if (rBack?.status === 200) {
                if (rBack.body?.breakdown) {
                  gearSnap = rBack.body.catalog ? rBack.body : { ...gearSnap, ...rBack.body }
                  recordObservedPanel(st, gearSnap)
                }
                curEquipped[slot] = wantRest
                slotRestored = true
              }
            } catch (e) {
              lastErr = e?.message || 'network-error'
            }
          }
          if (!slotRestored) {
            try {
              const gCheck = await getGearFn()
              if (gCheck?.gear?.[slot]?.id === wantRest) {
                gearSnap = gCheck
                recordObservedPanel(st, gCheck)
                curEquipped[slot] = wantRest
                slotRestored = true
              } else if (gCheck?.gear?.[slot]?.id) {
                curEquipped[slot] = gCheck.gear[slot].id
              }
            } catch {}
          }
          if (!slotRestored) {
            restoreError = `restore-${slot}-to-${wantRest}-failed:${lastErr}`
          }
        }
        st.activeGear = { ...curEquipped }
        st.activeCharm = curEquipped.charm
        st.dirty = Boolean(restoreError) || SLOTS.some((s) => effResting[s] && curEquipped[s] !== effResting[s])
        st.updatedAt = Date.now()
        st.gearSnap = gearSnap
        writeAccountGearState(st, accountKey, lockRoot)
      }
    }

    if (actionError) {
      actionError.restoreError = restoreError
      throw actionError
    }

    return {
      ok: !preEquipError && !restoreError,
      preEquipError,
      restoreOk: !restoreError,
      restoreError,
      decision,
      activeGear: curEquipped,
      restingGear: effResting,
      gear: gearSnap,
      result: actionResult,
    }
  })
}

export async function syncHomeHistoryProfiles(httpClient, homeData, accountKey, { maxFetch = 6, storePath } = {}) {
  if (!httpClient || !storePath || !Array.isArray(homeData?.history)) return 0
  const store = loadProfileStore(storePath)
  const lastId = Number(store.lastHomeHistoryId?.[accountKey] || 0)
  // Sort ascending FIRST so `slice(0, maxFetch)` processes oldest unseen IDs without ever skipping middle records!
  const unseen = homeData.history
    .filter((h) => Number(h?.id || 0) > lastId)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, maxFetch)
  if (unseen.length === 0) return 0
  let synced = 0
  let maxSeen = lastId
  for (const item of unseen) {
    try {
      const detail = await httpClient.getJson(`/api/pet/battle/${item.id}`)
      if (detail?.fighters || detail?.battle?.fighters) {
        recordBattleSnapshot(detail, 'arena', { storePath })
        synced++
      }
      if (Number(item.id) > maxSeen) maxSeen = Number(item.id)
    } catch {
      break
    }
  }
  if (maxSeen > lastId) {
    const freshStore = loadProfileStore(storePath)
    freshStore.lastHomeHistoryId ||= {}
    freshStore.lastHomeHistoryId[accountKey] = maxSeen
    saveProfileStore(freshStore, storePath)
  }
  return synced
}

export async function syncGuardLogProfiles(httpClient, accountKey, { maxFetch = 8, storePath } = {}) {
  if (!httpClient || !storePath) return 0
  let d = null
  try {
    d = await httpClient.getJson('/api/pet/world/guard-log')
  } catch {
    return 0
  }
  if (!Array.isArray(d?.battles) || d.battles.length === 0) return 0
  const store = loadProfileStore(storePath)
  const lastId = Number(store.lastGuardLogId?.[accountKey] || 0)
  // Sort ascending FIRST so `slice(0, maxFetch)` processes oldest unseen IDs without ever skipping middle records!
  const unseen = d.battles
    .filter((b) => Number(b?.id || 0) > lastId)
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, maxFetch)
  if (unseen.length === 0) return 0
  let synced = 0
  let maxSeen = lastId
  for (const item of unseen) {
    try {
      const detail = await httpClient.getJson(`/api/pet/battle/${item.id}`)
      if (detail?.fighters || detail?.battle?.fighters) {
        recordBattleSnapshot(detail, 'guard', { storePath })
        synced++
      }
      if (Number(item.id) > maxSeen) maxSeen = Number(item.id)
    } catch {
      break
    }
  }
  if (maxSeen > lastId) {
    const freshStore = loadProfileStore(storePath)
    freshStore.lastGuardLogId ||= {}
    freshStore.lastGuardLogId[accountKey] = maxSeen
    saveProfileStore(freshStore, storePath)
  }
  return synced
}
