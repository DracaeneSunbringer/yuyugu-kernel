import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRulesAdapterFromFile } from '../model/rules-adapter.mjs'
import { buildObservationEnvelope } from '../model/observations.mjs'
import { buildObjectiveConfig } from '../model/objective.mjs'
import { compileExecutablePrefix, computeCausalStochasticPrefix } from '../planner/compile-prefix.mjs'
import { solveUnifiedPlan } from '../planner/solve.mjs'
import { auditDecisionAgainstReference } from '../audit/reference-solver.mjs'
import { UpdateNotifier, compareSemver } from '../execution/update-notifier.mjs'

const RULES_PATH = path.resolve('rules/pet-world-rules.js')
const CLOCK_START = 1794212939

function makeBaseWorld(adapter, nowSec, overrides = {}) {
  const s = adapter.R.newWorld(nowSec)
  s.inv = {}
  s.plots = Array(s.plotN).fill(null)
  s.barn = []
  s.traps = []
  s.tools = { pick: 4, rod: 4, can: 4 }
  s.en = 80
  s.enT = nowSec
  s.enDay = adapter.R.worldDay(nowSec)
  s.iq = { d: adapter.R.isleIndex(nowSec), craft: 0, mine: 0, fish: 0, bomb: 0 }
  const prices = {}
  for (const id of adapter.graph.sellableIds) {
    prices[id] = Number(adapter.R.BASE_PRICE[id])
  }
  return {
    now: nowSec,
    clockStart: CLOCK_START,
    nextIsleAt: adapter.nextIsleBoundary(nowSec, CLOCK_START),
    rev: 1,
    coins: 200000,
    prices,
    ...overrides,
    state: { ...s, ...(overrides.state || {}) },
  }
}

test('Phase 9.1 (Pillar 1 + Pillar 2): Multi-season continuation scarcity + Renewal NPV Rate plants tomato in mid-late Summer, holds depressed 0.58x tomato stock, and switches to corn only when tomato can no longer harvest before Autumn wither', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R } = adapter

  // Locate mid-late Summer (`seasonOf(d) === 1` with ~36h before Autumn `seasonOf === 2`):
  const SUMMER = 1
  const AUTUMN = 2
  let tSummerMid = 1794340000
  for (let step = 0; step < 2000; step++, tSummerMid += 3600) {
    const s0 = R.seasonOf(R.isleDay(tSummerMid))
    const s24 = R.seasonOf(R.isleDay(tSummerMid + 24 * 3600))
    const s48 = R.seasonOf(R.isleDay(tSummerMid + 48 * 3600))
    if (s0 === SUMMER && s24 === SUMMER && s48 === AUTUMN) {
      break
    }
  }
  assert.equal(R.seasonOf(R.isleDay(tSummerMid)), SUMMER)

  // Case A: ~36h before Autumn — sprinkled 24-plot farm (`spr = 3`), Summer tomato depressed to 0.58x,
  // abundant corn already in stock (`[450, 0, 0]`), and existing tomato stock (`[30, 0, 20]`).
  const depressedTomatoPrice = Math.round(R.BASE_PRICE.tomato * 0.58)
  const worldMidSummer = makeBaseWorld(adapter, tSummerMid, {
    coins: 250000,
    prices: {
      ...Object.fromEntries([...adapter.graph.sellableIds].map((id) => [id, Number(R.BASE_PRICE[id])])),
      tomato: depressedTomatoPrice,
    },
    state: {
      plotN: 24,
      plots: Array(24).fill(null),
      spr: 3,
      house: 2,
      en: 100,
      enT: tSummerMid,
      enDay: R.worldDay(tSummerMid),
      inv: {
        corn: [450, 0, 0],
        tomato: [30, 0, 20],
      },
      iq: { d: R.isleIndex(tSummerMid), craft: 0, mine: 100, fish: 80, bomb: 10 },
    },
  })

  const objCfg = buildObjectiveConfig({ horizonSec: 86400 })
  assert.equal(objCfg.continuationIsleDays, 12, '24h horizon must activate 12-isle-day (1 full season) continuation tail')

  const envMid = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldMidSummer,
    userConstraints: { allowCapex: false },
  })
  const planMid = solveUnifiedPlan(adapter, envMid, objCfg)
  const b0Acts = planMid.trunkBuckets[0]?.domesticActions || []

  const plantedCrops = b0Acts.filter((a) => a.a === 'plant').map((a) => a.c)
  assert.ok(plantedCrops.length > 0, 'Empty sprinkled plots must be planted')
  const tomatoPlants = plantedCrops.filter((c) => c === 'tomato').length
  assert.ok(
    tomatoPlants > 0,
    `Mid-late Summer with full harvest window before Autumn must plant high-NPV/s scarce tomato (planted: ${JSON.stringify(plantedCrops)})`
  )

  // Depressed 0.58x raw tomato must NOT be dumped in Bucket 0 when Autumn off-season / ketchup continuation awaits!
  const rawTomatoSells0 = b0Acts.filter((a) => a.a === 'sell' && a.id === 'tomato')
  assert.equal(
    rawTomatoSells0.length,
    0,
    `Must hold 0.58x Summer tomato for multi-season ketchup/off-season premium instead of dumping raw (got ${JSON.stringify(rawTomatoSells0)})`
  )

  // Case B: Final <=2 hours of Summer right before Autumn (`seasonOf(d) === 1`, `seasonOf(nextB) === 2`):
  // Tomato (`g = 86400`, sprinkled `43200s = 12h` to first maturity) will 100% wither at Autumn boundary (`0` harvests),
  // so physical Renewal NPV Rate naturally switches to cross-season `corn` (`seasons: [1, 2]`)!
  let tLateSummer = tSummerMid
  for (let step = 0; step < 2000; step++, tLateSummer += 1800) {
    const dNow = R.isleDay(tLateSummer)
    const nextB = adapter.nextIsleBoundary(tLateSummer, CLOCK_START)
    const dNext = R.isleDay(nextB)
    if (R.seasonOf(dNow) === SUMMER && R.seasonOf(dNext) === AUTUMN && nextB - tLateSummer <= 7200) {
      break
    }
  }
  assert.equal(R.seasonOf(R.isleDay(tLateSummer)), SUMMER)
  assert.equal(R.seasonOf(R.isleDay(adapter.nextIsleBoundary(tLateSummer, CLOCK_START))), AUTUMN)

  const worldLateSummer = makeBaseWorld(adapter, tLateSummer, {
    coins: 250000,
    state: {
      plotN: 12,
      plots: Array(12).fill(null),
      spr: 3,
      house: 2,
      en: 80,
      enT: tLateSummer,
      enDay: R.worldDay(tLateSummer),
      inv: {},
      iq: { d: R.isleIndex(tLateSummer), craft: 80, mine: 100, fish: 80, bomb: 10 },
    },
  })
  const envLate = buildObservationEnvelope(adapter, {
    account: 'main',
    world: worldLateSummer,
    userConstraints: { allowCapex: false },
  })
  const planLate = solveUnifiedPlan(adapter, envLate, objCfg)
  const latePlants = (planLate.trunkBuckets[0]?.domesticActions || []).filter((a) => a.a === 'plant')
  assert.ok(latePlants.length > 0, 'Should plant a cross-season surviving crop right before Autumn')
  assert.equal(
    latePlants.some((a) => a.c === 'tomato'),
    false,
    'Must NEVER plant tomato <2h before Autumn when first harvest takes 12h and withers at season boundary'
  )
  assert.equal(
    latePlants.every((a) => R.CROPS.find((c) => c.id === a.c)?.seasons.includes(AUTUMN)),
    true,
    'Every crop planted <2h before Autumn must survive into Autumn'
  )
})

test('Phase 9.2 (Pillar 3): Overnight 22:04 CST reproduction — overnight free regen + 00:00 CST coffee reset + Just-In-Time stamina eats ZERO q=2 tomatoes across consecutive fish casts', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const { R } = adapter

  // Find exact `22:04 CST` timestamp on a Summer isle day whose `nextIsleAt` is `10:00 CST` next morning (~12h overnight window):
  const baseDayStartUtc = Math.floor((1794300000 + 8 * 3600) / 86400) * 86400 - 8 * 3600
  let t2204 = baseDayStartUtc + 22 * 3600 + 4 * 60
  for (let step = 0; step < 100 && R.seasonOf(R.isleDay(t2204)) !== 1; step++) {
    t2204 += 86400
  }
  const nextIsle = adapter.nextIsleBoundary(t2204, CLOCK_START)
  assert.ok(
    nextIsle - t2204 >= 10 * 3600,
    `Expected >=10h long-night isle window from 22:04 CST, got ${(nextIsle - t2204) / 3600}h`
  )
  assert.notEqual(
    R.worldDay(t2204),
    R.worldDay(nextIsle - 60),
    'Overnight isle window from 22:04 CST must cross 00:00 CST natural-day coffee reset'
  )

  const depressedTomato = Math.round(R.BASE_PRICE.tomato * 0.584)
  let curWorld = makeBaseWorld(adapter, t2204, {
    coins: 240000,
    prices: {
      ...Object.fromEntries([...adapter.graph.sellableIds].map((id) => [id, Number(R.BASE_PRICE[id])])),
      tomato: depressedTomato,
    },
    state: {
      plotN: 24,
      plots: Array.from({ length: 24 }, () => ({ c: 'corn', t: t2204 - 600, g: 0, w: 3, h: 0 })),
      spr: 3,
      house: 2, // enMax = 140
      tools: { pick: 4, rod: 4, can: 4 },
      en: 61,
      enT: t2204,
      enDay: R.worldDay(t2204),
      cnt: { coffee: 3 }, // Today's 3/3 coffee used before midnight, resets at 00:00 CST!
      iq: { d: R.isleIndex(t2204), mine: 100, bomb: 10, fish: 13, craft: 80 }, // 67 fish casts remaining = 268 en
      inv: {
        tomato: [0, 0, 94],
        bait: [25, 0, 0],
      },
    },
  })

  const objCfg = buildObjectiveConfig({ horizonSec: 86400 })

  // Step through 5 consecutive `fish` executions & replans (`en: 61 -> 57 -> 53 -> 49 -> 45 -> 41`):
  for (let step = 0; step < 5; step++) {
    const env = buildObservationEnvelope(adapter, {
      account: 'secondary',
      world: curWorld,
      userConstraints: { allowCapex: false },
    })
    const plan = solveUnifiedPlan(
      adapter,
      env,
      objCfg,
      step === 0 ? {} : { stochasticPolicySamples: 2, runStability: false }
    )
    const compiled = compileExecutablePrefix(adapter, curWorld, plan)

    const eatActs = compiled.domesticBatch.filter((a) => a.a === 'eat')
    assert.equal(
      eatActs.length,
      0,
      `Step ${step} (en=${curWorld.state.en}): must emit ZERO eat actions before fishing (got ${JSON.stringify(compiled.domesticBatch)})`
    )
    assert.equal(
      compiled.domesticBatch.some((a) => a.a === 'fish'),
      true,
      `Step ${step}: expected fish action when en=${curWorld.state.en} >= 4`
    )

    const sim = adapter.simulateBatch(curWorld, compiled.domesticBatch, {
      t: curWorld.now,
      prices: curWorld.prices,
      rand: adapter.makeSampleStreamPrng(step + 1, curWorld.now),
    })
    assert.equal(sim.allOk, true)
    curWorld = adapter.advanceTimeOnly(sim.afterWorld, curWorld.now + 3, { futurePrices: curWorld.prices })
    curWorld.rev += 1
  }

  assert.equal(
    curWorld.state.inv.tomato?.[2],
    94,
    'All 94 gold-star (q=2) tomatoes must remain 100% untouched across all 5 consecutive fish ticks!'
  )

  // Even when `en = 2` (`< 4` for fish) at `22:15 CST`, free overnight regen (~230 en) + 00:00 CST coffee (250 D/en)
  // still cover remaining fish casts, so domestic account waits for free regen instead of eating q=2 tomato!
  const lowEnWorld = structuredClone(curWorld)
  lowEnWorld.state.en = 2
  lowEnWorld.state.enT = lowEnWorld.now
  const lowEnEnv = buildObservationEnvelope(adapter, {
    account: 'secondary',
    world: lowEnWorld,
    userConstraints: { allowCapex: false },
  })
  const lowEnPlan = solveUnifiedPlan(adapter, lowEnEnv, objCfg)
  const lowEnCompiled = compileExecutablePrefix(adapter, lowEnWorld, lowEnPlan)
  assert.equal(
    lowEnCompiled.domesticBatch.some((a) => a.a === 'eat' && a.id === 'tomato'),
    false,
    `Even at en=2 at 22:04 CST, must wait for overnight free regen / 00:00 coffee rather than eating q=2 tomato (got ${JSON.stringify(lowEnCompiled.domesticBatch)})`
  )
})

test('Phase 9.3 (Pillar 3): Causal stochastic prefix strips trailing orphan eat/coffee after post-harvest truncation & Just-In-Time emits harvest before eat', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000
  const world = makeBaseWorld(adapter, t0, {
    state: {
      plotN: 4,
      plots: [
        { c: 'corn', t: t0 - 90000, g: 86400, w: 3, h: 0 },
        { c: 'corn', t: t0 - 90000, g: 86400, w: 3, h: 0 },
        null,
        null,
      ],
      en: 6,
      enT: t0,
    },
  })

  const rawSeq = [
    { a: 'harvest', i: 0 },
    { a: 'harvest', i: 1 },
    { a: 'eat', id: 'tomato', q: 2 },
    { a: 'coffee' },
    { a: 'fish', bait: true },
  ]
  const res = computeCausalStochasticPrefix(adapter, world, rawSeq, 40)
  assert.equal(res.truncatedAfterStochastic, true)
  assert.deepEqual(res.prefix, [
    { a: 'harvest', i: 0 },
    { a: 'harvest', i: 1 },
  ])
})

test('Phase 9.4 (Pillar 1): Certified Weak-Duality Upper Bound L <= U holds across 24h horizon with 12-isle-day multi-season continuation & matches Layer-2 reference auditor', async () => {
  const adapter = await loadRulesAdapterFromFile(RULES_PATH, { clockStart: CLOCK_START })
  const t0 = 1794340000

  const world = makeBaseWorld(adapter, t0, {
    coins: 50000,
    state: {
      en: 30,
      enT: t0,
      enDay: adapter.R.worldDay(t0),
      cnt: { sc_corn: 140 },
      iq: { d: adapter.R.isleIndex(t0), craft: 76, mine: 100, fish: 80, bomb: 10 },
      inv: {
        corn: [18, 4, 2],
        tomato: [12, 0, 6],
        gold: [6, 0, 0],
        coal: [3, 0, 0],
      },
    },
  })

  const objCfg = buildObjectiveConfig({ horizonSec: 86400 })
  assert.equal(objCfg.continuationIsleDays, 12)

  const env = buildObservationEnvelope(adapter, {
    account: 'main',
    world,
    scenarios: [{ id: 'det', weight: 1, externalSupplyFactor: 1.0 }],
  })
  const plan = solveUnifiedPlan(adapter, env, objCfg, {
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })

  assert.notEqual(plan.quality.solverStatus, 'bound-violation-error')
  assert.ok(Number.isFinite(plan.quality.validUpperBound), 'Must certify finite validUpperBound on deterministic craft+sell continuation')
  assert.ok(
    plan.quality.feasibleIncumbentValue <= plan.quality.validUpperBound + 1e-6,
    `Weak duality violated: L=${plan.quality.feasibleIncumbentValue} > U=${plan.quality.validUpperBound}`
  )

  const objCfg8h = buildObjectiveConfig({ horizonSec: 28800 })
  assert.equal(objCfg8h.continuationIsleDays, 12)
  const plan8h = solveUnifiedPlan(adapter, env, objCfg8h, {
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })
  assert.notEqual(plan8h.quality.solverStatus, 'bound-violation-error')
  assert.ok(plan8h.quality.feasibleIncumbentValue <= plan8h.quality.validUpperBound + 1e-6)
  const auditRep = auditDecisionAgainstReference(adapter, {
    worldBefore: world,
    actualFirstActions: plan8h.trunkBuckets[0]?.domesticActions || [],
    actualFullPolicyObjectiveValue: plan8h.quality.feasibleIncumbentValue,
    scenarios: env.beliefs.scenarios,
    objectiveCfg: objCfg8h,
    allowedActionTypes: ['sell', 'craft', 'wait'],
  })
  assert.equal(auditRep.actualLegal, true)
  assert.ok(
    (auditRep.identifiableRegretLowerBound ?? 0) <= 1e-6,
    `Expected 0 identifiable regret vs Layer-2 reference auditor, got ${auditRep.identifiableRegretLowerBound}`
  )
})

test('Phase 9.5: UpdateNotifier decodes GitHub API base64 manifest, falls back across endpoints, prints banner + inline tag, deduplicates webhooks, and detects un-restarted git pull on disk', async () => {
  assert.equal(compareSemver('1.1.0', '1.0.0'), 1)
  assert.equal(compareSemver('1.0.10', '1.0.2'), 1)
  assert.equal(compareSemver('v1.1.0', '1.1.0'), 0)
  assert.equal(compareSemver('1.0.0', '1.2.0'), -1)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ukernel-upd-'))
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'yuyugu-unified-kernel', version: '1.0.0' }),
    'utf8'
  )
  const statePath = path.join(tmpDir, 'logs', 'update-status.json')

  const remoteManifest = {
    name: 'yuyugu-unified-kernel',
    version: '1.2.0',
    repository: 'https://github.com/DracaeneSunbringer/yuyugu-kernel',
    releaseNotes: {
      date: '2026-11-12',
      severity: 'important',
      summary: '修复跨季节选种与夜间体力调度问题',
      upgradeCommand: 'git pull',
    },
  }
  const base64Body = Buffer.from(JSON.stringify(remoteManifest), 'utf8').toString('base64')

  const logged = []
  let webhookHits = 0
  let clockMs = 1_700_000_000_000

  // 1) Primary endpoint 503 -> fallback endpoint succeeds; webhook fires once
  let apiAttempt = 0
  const notifier = new UpdateNotifier({
    rootDir: tmpDir,
    stateFilePath: statePath,
    webhookUrl: 'https://webhook.example.local/notify',
    nowMsFn: () => clockMs,
    logger: (msg) => logged.push(msg),
    fetchFn: async (url, opts) => {
      if (url === 'https://webhook.example.local/notify') {
        assert.equal(opts.method, 'POST')
        webhookHits++
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      if (url.includes('api.github.com')) {
        apiAttempt++
        if (apiAttempt === 1) return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => ({ content: base64Body, encoding: 'base64' }) }
      }
      return { ok: true, status: 200, json: async () => remoteManifest }
    },
  })

  const st1 = await notifier.checkNow({ printBanner: true })
  assert.equal(st1.hasUpdate, true)
  assert.equal(st1.latestVersion, '1.2.0')
  assert.equal(logged.length, 1)
  assert.ok(logged[0].includes('v1.2.0'))
  assert.ok(notifier.inlineTag().includes('v1.2.0'))
  assert.equal(webhookHits, 1)

  // 2) Second check (including GitHub Contents base64 decode!) does NOT re-spam webhook or banner within repeat window
  clockMs += 60_000
  await notifier.checkNow({ printBanner: true })
  assert.equal(webhookHits, 1, 'Webhook must be deduplicated for the same version')
  assert.equal(logged.length, 1, 'Banner must not repeat within bannerRepeatMs')

  // 3) Simulate user running `git pull` on disk (`package.json` becomes 1.2.0 while daemon is still running 1.0.0 in memory!)
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'yuyugu-unified-kernel', version: '1.2.0' }),
    'utf8'
  )
  clockMs += 3 * 3600 * 1000
  const stPulled = await notifier.checkNow({ printBanner: true })
  assert.equal(stPulled.hasUpdate, true)
  assert.ok(stPulled.upgradeCommand.includes('重启'), 'Must remind user to restart process after git pull on disk')
  assert.equal(logged.length, 2, 'Banner repeats after bannerRepeatMs elapses')

  // 4) Offline resilience: network rejection never throws
  const offlineNotifier = new UpdateNotifier({
    rootDir: tmpDir,
    fetchFn: async () => {
      throw new Error('ENETUNREACH')
    },
  })
  const stOffline = await offlineNotifier.checkNow({ printBanner: true })
  assert.equal(stOffline.hasUpdate, false)
  assert.ok(stOffline.error.includes('ENETUNREACH'))
})
