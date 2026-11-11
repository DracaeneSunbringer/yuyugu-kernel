// 由 src/shared/pet-world.ts 生成，请勿手改。
// 大肥鱼的小岛 v2：农场 / 牧场 / 海边 / 矿洞 / 集市。规则与数值表前后端共用；结算只在服务端（applyActions）。
// 状态是每个用户一行的紧凑 JSON，生长、产出、体力、蟹笼全部按时间戳惰性计算，不需要定时任务。
//
// 2026-11-05 降门槛：扩建 / 工具 / 动物 / 小屋 / 咖啡 / 管家约减半，种子 ×0.6（产出不变，回本更快）。
// 经济目标（详见 research/pet-world-20261104/ECONOMY.md，由 sim-economy.mjs 校验）：
//   认真玩（每天 5–6 次上线、用完体力）中后期 ≈ 100–150 万 D币 / 天；
//   挂机（每天上线 1 次收菜收蛋收蟹笼）中后期 ≈ 20–35 万 D币 / 天；
//   新号第一天 ≈ 5–10 万。限制主要来自：体力、作物真实生长时间、动物仓位上限、每日钓鱼 / 挖矿次数、每日卖出上限。
// 防脚本：所有产出都耗体力或受真实时间约束，脚本刷得再快也拿不到更多；服务端每 2 秒最多受理一次提交（批量 40 个动作）。
export const WORLD = {
    // 体力：上限 100（小屋每级 +20），每 regen 秒回 1 点（一天约 480 点）。只来一次的人只能用到上限，常来的人能把回复都用掉。
    energyBase: 100, energyPerHouse: 20, regen: 180, dailyEarn: 1800000, maxActions: 40, minGap: 2,
    plotsStart: 6, plotsMax: 24, plotPrice: (n) => 10000 * n, // 第 n 块（从第 7 块起）
    barnStart: 2, barnMax: 8, barnPrice: (n) => 80000 * n,
    trapMax: 4, trapPrice: (n) => 30000 * n, trapEvery: 180, trapCap: 4,
    houseMax: 5, housePrice: [100000, 250000, 600000, 1200000, 2500000],
    // 鱼竿 / 镐子 1–4 级；洒水器 0–3 级（覆盖前 8 / 16 / 24 块地，自动浇水）
    tools: { rod: [0, 80000, 300000, 1000000], pick: [0, 80000, 300000, 1000000], spr: [150000, 500000, 1500000] },
    sprCover: [0, 8, 16, 24],
    cost: { plant: 2, water: 1, harvest: 1, clear: 1, feed: 1, fish: 4, mine: 3 },
    daily: { fish: 80, mine: 100, coffee: 3 },
    xp: { harvest: 6, collect: 6, fish: 9, mine: 6 }, // 11-07：小岛经验 ×3，计入大肥鱼等级
    coffee: { price: 15000, energy: 60 },
};
export const SEASONS = ['春', '夏', '秋', '冬'];
export const WEATHERS = ['晴', '雨', '风', '雪'];
// 北京时间按周换季：以 2026-11-02（周一）为春季第一周
export const worldDay = (t) => new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10);
const dayNum = (day) => Math.floor(Date.parse(day) / 86400000);
export const seasonOf = (day) => isIsleDay(day) ? ((Math.floor((dayNum(day) - isleIndex(ISLE_LAUNCH)) / ISLE_SEASON_DAYS) % 4) + 4) % 4 : ((Math.floor((dayNum(day) - dayNum('2026-11-02')) / 7) % 4) + 4) % 4;
export const hourOf = (t) => new Date((t + 8 * 3600) * 1000).getUTCHours();
// ---------- 11-07 时间流：现实 4 小时 = 岛上一天 ----------
export const ISLE_SPAN = 4 * 3600, ISLE_LAUNCH = 1794052800, ISLE_SEASON_DAYS = 12;
export const isleIndex = (t) => Math.floor(b12ClockSeconds(t) / ISLE_SPAN);
export const isleDay = (t) => new Date(isleIndex(t) * 86400000).toISOString().slice(0, 10); // 虚拟日期（远在 2300 年以后，不会和真实日期混）
export const isleHour = (t) => Math.floor((b12ClockSeconds(t) % ISLE_SPAN) / (ISLE_SPAN / 24));
export const isleMinute = (t) => Math.floor(((b12ClockSeconds(t) % ISLE_SPAN) % (ISLE_SPAN / 24)) / (ISLE_SPAN / 1440));
export const isleDayNo = (t) => isleIndex(t) - isleIndex(ISLE_LAUNCH) + 1; // 第几个岛日（时间流上线那天算第 1 天）
export const isleSeasonLeft = (t) => ISLE_SEASON_DAYS - 1 - (((isleIndex(t) - isleIndex(ISLE_LAUNCH)) % ISLE_SEASON_DAYS) + ISLE_SEASON_DAYS) % ISLE_SEASON_DAYS; // 本季还剩几个岛日（0 = 最后一天）
export const isIsleDay = (day) => Date.parse(day) > Date.parse('2100-01-01');
export const CROPS = [
    { id: 'turnip', name: '小白萝卜', seasons: [0, 3], seed: 110, grow: 30, price: 540, eat: 8 },
    { id: 'carrot', name: '胡萝卜', seasons: [0, 2], seed: 180, grow: 60, price: 960, eat: 10 },
    { id: 'wheat', name: '小麦', seasons: [1, 2], seed: 220, grow: 120, price: 1400, eat: 6 },
    { id: 'strawberry', name: '草莓', seasons: [0], seed: 720, grow: 240, price: 3300, eat: 14, regrow: 180, times: 4 },
    { id: 'tomato', name: '番茄', seasons: [1], seed: 540, grow: 180, price: 2550, eat: 12, regrow: 150, times: 4 },
    { id: 'corn', name: '玉米', seasons: [1, 2], seed: 900, grow: 360, price: 4800, eat: 14, regrow: 240, times: 3 },
    { id: 'grape', name: '葡萄', seasons: [2], seed: 1080, grow: 360, price: 5700, eat: 12, regrow: 240, times: 4 },
    { id: 'pumpkin', name: '南瓜', seasons: [2, 3], seed: 1440, grow: 600, price: 9000, eat: 20 },
    { id: 'cabbage', name: '冬白菜', seasons: [3], seed: 450, grow: 150, price: 2350, eat: 12 },
];
export const ANIMALS = [
    { id: 'chicken', name: '小鸡', price: 12000, every: 240, cap: 3, product: 'egg', productName: '鸡蛋', productPrice: 1350 },
    { id: 'duck', name: '鸭子', price: 24000, every: 300, cap: 3, product: 'duckegg', productName: '鸭蛋', productPrice: 2500 },
    { id: 'cow', name: '奶牛', price: 60000, every: 480, cap: 2, product: 'milk', productName: '牛奶', productPrice: 5850 },
    { id: 'sheep', name: '绵羊', price: 90000, every: 1440, cap: 1, product: 'wool', productName: '羊毛', productPrice: 19000 },
    { id: 'pig', name: '小猪', price: 150000, every: 720, cap: 1, product: 'truffle', productName: '松露', productPrice: 13500 },
];
// 鱼：季节 / 时段（北京时间小时，可跨午夜）/ 权重 / 鱼竿等级要求
export const FISH = [
    { id: 'sardine', name: '沙丁鱼', price: 1200, w: 40, rod: 1, seasons: [0, 1, 2, 3], hours: [0, 24] },
    { id: 'carp', name: '鲤鱼', price: 2000, w: 30, rod: 1, seasons: [0, 2, 3], hours: [0, 24] },
    { id: 'bass', name: '鲈鱼', price: 3600, w: 22, rod: 1, seasons: [1, 2], hours: [6, 20] },
    { id: 'salmon', name: '三文鱼', price: 7200, w: 14, rod: 2, seasons: [2, 3], hours: [0, 24] },
    { id: 'squid', name: '鱿鱼', price: 8800, w: 12, rod: 2, seasons: [3, 0], hours: [18, 30] },
    { id: 'tuna', name: '金枪鱼', price: 14500, w: 8, rod: 3, seasons: [1, 3], hours: [0, 24] },
    { id: 'puffer', name: '河豚', price: 21000, w: 6, rod: 3, seasons: [1, 0], hours: [12, 20] },
    { id: 'whale', name: '迷你鲸', price: 96000, w: 1, rod: 4, seasons: [0, 1, 2, 3], hours: [0, 24] },
];
// 矿：最低层数 / 权重
export const ORES = [
    { id: 'coal', name: '煤', price: 480, w: 40, floor: 1 }, { id: 'copper', name: '铜矿', price: 900, w: 35, floor: 1 },
    { id: 'iron', name: '铁矿', price: 1900, w: 25, floor: 6 }, { id: 'amethyst', name: '紫水晶', price: 7200, w: 6, floor: 8 },
    { id: 'gold', name: '金矿', price: 4200, w: 14, floor: 12 }, { id: 'emerald', name: '祖母绿', price: 12000, w: 4, floor: 15 },
    { id: 'ruby', name: '红宝石', price: 18000, w: 3, floor: 20 }, { id: 'diamond', name: '钻石', price: 36000, w: 1.2, floor: 25 },
];
export const PICK_FLOOR = [0, 8, 16, 24, 30]; // 镐子等级 1–4 可达最深层
export const SHOP = { feed: { name: '饲料', price: 150 }, bait: { name: '鱼饵', price: 400 } };
// 物品基础价（集市按日浮动）
export const BASE_PRICE = Object.fromEntries([
    ...CROPS.map((c) => [c.id, c.price]), ...ANIMALS.map((a) => [a.product, a.productPrice]), ...FISH.map((f) => [f.id, f.price]), ...ORES.map((o) => [o.id, o.price]),
]);
export const ITEM_NAME = Object.fromEntries([
    ...CROPS.map((c) => [c.id, c.name]), ...ANIMALS.map((a) => [a.product, a.productName]), ...FISH.map((f) => [f.id, f.name]), ...ORES.map((o) => [o.id, o.name]), ['feed', '饲料'], ['bait', '鱼饵'],
]);
export const QUALITY = [1, 1.25, 1.5]; // 普通 / 银星 / 金星
// 作物阶梯价：每人每天同一种作物，前 150 个全价，151–400 个 85%，之后 70%
export const CROP_TIERS = [[150, 1], [400, 0.85], [Infinity, 0.7]];
export function cropTierValue(before, n, unit) {
    let v = 0, k = before;
    for (const [upTo, pct] of CROP_TIERS) { if (k >= upTo) continue; const m = Math.min(n - (k - before), upTo - k); if (m <= 0) break; v += m * unit * pct; k += m; }
    return v;
}
export const cropFullLeft = (s, id) => Math.max(0, CROP_TIERS[0][0] - ((s.cnt && s.cnt['sc_' + id]) || 0));
// ---------- 确定性随机 ----------
function worldHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    // 末尾做一次雪崩混合：相邻日期的输入只差一位，FNV 输出高位相关性很强
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
// 天气：每天一种，全站一致。雨：作物自动浇水、鱼更好钓；风：蟹笼翻倍；雪（只在冬天）：矿洞宝石更多。
export function weatherOf(day) {
    const r = worldHash('weather:' + day), s = seasonOf(day);
    if (s === 3)
        return r < 0.35 ? 3 : r < 0.5 ? 1 : r < 0.65 ? 2 : 0;
    return r < 0.3 ? 1 : r < 0.45 ? 2 : 0;
}
// ---------- 集市价格：确定性随机游走 × 季节 × 偶发事件 × 供需 ----------
export function marketFactor(item, day) {
    const d = dayNum(day);
    let walk = 0;
    const W = [1, 0.6, 0.35, 0.15];
    for (let k = 0; k < W.length; k++)
        walk += (worldHash(item + ':' + (d - k)) - 0.5) * W[k];
    const isle = isIsleDay(day);
    const event = worldHash('event:' + item + ':' + d) < (isle ? 0.015 : 0.04) ? (worldHash('ev2:' + item + d) < 0.5 ? (isle ? 0.8 : 0.7) : (isle ? 1.3 : 1.45)) : 1; // 偶发暴涨暴跌
    const crop = CROPS.find((c) => c.id === item), season = seasonOf(day);
    const seasonal = crop ? (crop.seasons.includes(season) ? 0.92 : 1.3) : 1;
    return isle ? Math.max(0.65, Math.min(1.7, Math.exp(walk * 0.5 - 0.02) * seasonal * event)) : Math.max(0.5, Math.min(2, Math.exp(walk * 0.7 - 0.03) * seasonal * event));
}
// 供需：前一天全站卖出量越多，今天越便宜（以「正常量」为基准）。
export const supplyFactor = (soldYesterday, normal) => Math.max(0.8, Math.min(1.06, 1.06 - 0.3 * (soldYesterday / Math.max(1, normal))));
export const NORMAL_VOLUME = 400;
// 集市基础库存：便宜的东西库存深（1600000 ÷ 基础价，800–6000 个），全站上一个岛日卖出量占基础库的比例越高，价格越低（最多 -20%）
export const marketDepth = (item) => Math.max(800, Math.min(6000, Math.round(1600000 / Math.max(1, BASE_PRICE[item] || 1000))));
export function priceOf(item, day, soldYesterday = 0) {
    const base = BASE_PRICE[item];
    if (!base)
        return 0;
    return Math.max(1, Math.round(base * marketFactor(item, day) * supplyFactor(soldYesterday, isIsleDay(day) ? marketDepth(item) : NORMAL_VOLUME) * eventFactor(item, day)));
}
// ---------- 每日目标（公告栏）：每天全站同一组 3 个，完成一个领 6000，全部完成再领 12000 ----------
export const GOALS = [
    { id: 'plant', name: '播种', n: 10 }, { id: 'water', name: '浇水', n: 8 }, { id: 'harvest', name: '收获作物', n: 8 },
    { id: 'collect', name: '收动物产物', n: 3 }, { id: 'fish', name: '钓鱼', n: 6 }, { id: 'mine', name: '敲矿石', n: 15 }, { id: 'sold', name: '卖货收入', n: 30000 },
];
export const GOAL_REWARD = 6000, GOAL_BONUS = 12000;
export const WELCOME_GIFT = 1000000; // 第一次进鱼鱼谷的新人礼（每个账号一次，不计入每日卖出上限）

// ---------- 11-07 b4 加工坊：作物 / 畜产 / 矿物加工成更值钱的东西（卖价都比原料高 20%–40%，也受商闻影响） ----------
export const RECIPES = [
    { id: 'salad', name: '田园沙拉', in: { turnip: 3, carrot: 3 }, price: 6500 },
    { id: 'flour', name: '面粉', in: { wheat: 5 }, price: 9200 },
    { id: 'jam', name: '草莓果酱', in: { strawberry: 4 }, price: 17000 },
    { id: 'ketchup', name: '番茄酱', in: { tomato: 4 }, price: 13500 },
    { id: 'popcorn', name: '爆米花', in: { corn: 3 }, price: 18500 },
    { id: 'wine', name: '葡萄酒', in: { grape: 4 }, price: 31000 },
    { id: 'pie', name: '南瓜派', in: { pumpkin: 2, egg: 2 }, price: 26000 },
    { id: 'kimchi', name: '泡菜', in: { cabbage: 4 }, price: 12500 },
    { id: 'mayo', name: '蛋黄酱', in: { duckegg: 3 }, price: 9800 },
    { id: 'cheese', name: '奶酪', in: { milk: 3 }, price: 23500 },
    { id: 'sweater', name: '羊绒毛衣', in: { wool: 2 }, price: 50000 },
    { id: 'ironbar', name: '铁锭', in: { iron: 4, coal: 2 }, price: 10200 },
    { id: 'ingot', name: '金锭', in: { gold: 4, coal: 2 }, price: 23000 },
    { id: 'jewel', name: '宝石项链', in: { ruby: 1, emerald: 1, gold: 1 }, price: 46000 },
    { id: 'crown', name: '钻石王冠', in: { diamond: 2, ingot: 1 }, price: 108000 },
    { id: 'bomb', name: '炸药', in: { coal: 3, copper: 2 }, price: 0 }, // 不能卖：拿去矿洞炸矿
];
for (const r of RECIPES) { ITEM_NAME[r.id] = r.name; if (r.price) BASE_PRICE[r.id] = r.price }
ITEM_NAME.bomb = '炸药';
for (const c of CROPS) ITEM_NAME['sd_' + c.id] = c.name + '种子';
SHOP.bomb = { name: '炸药', price: 2500 };
WORLD.cost.craft = 1; WORLD.cost.bomb = 6; WORLD.daily.craft = 80; WORLD.daily.bomb = 10; WORLD.xp.craft = 2;
// ---------- 11-07 b4 守家道具：杂货铺卖，便宜、按时长生效（再买同级续时长），提升大肥鱼守家时的战斗力 ----------
export const GUARD_ITEMS={
 guard1:{name:'潮铃',price:800,h:24,slot:'alert',detect:.10,desc:'发现率增加 10 个百分点，持续 24 小时；占警戒槽'},
 guard2:{name:'贝壳护具',price:1600,h:24,slot:'combat',hp:.08,desc:'守家生命额外增加 8%，持续 24 小时；占护具槽'},
 guard3:{name:'珊瑚挡板',price:1800,h:24,slot:'combat',def:4,desc:'守家防御增加 4，持续 24 小时；占护具槽'},
 guard4:{name:'萤火灯',price:650,h:24,slot:'alert',detect:.06,desc:'发现率增加 6 个百分点，持续 24 小时；占警戒槽，白天也有效'},
};
export const THIEF_ITEMS={
 cloak:{name:'轻步斗篷',price:1200,h:24,slot:'stealth',detect:-.10,desc:'被发现率降低 10 个百分点，持续 24 小时；占潜行槽'},
 whistle:{name:'风声口哨',price:1400,h:24,slot:'stealth',detect:-.06,energy:1,desc:'被发现率降低 6 个百分点，每次偷菜少耗 1 体力，持续 24 小时；占潜行槽'},
 sack:{name:'折叠菜篮',price:2500,h:24,slot:'carry',desc:'成功偷取每处多得 1 个，不额外扣主人产物；持续 24 小时，占携带槽'},
};
const b12EffectItems={...GUARD_ITEMS,...THIEF_ITEMS};
for(const[id,item]of Object.entries(b12EffectItems))ITEM_NAME[id]=item.name;
export const guardBoost=()=>0; // Old compounded combat strength is retired.
export function b12Effect(s,slot,t){
 const x=s?.b12?.effects?.[slot];if(x&&x.until>t&&b12EffectItems[x.id]?.slot===slot)return x;
 if(slot==='stealth'&&s?.thief?.cloak>t)return {id:'cloak',until:s.thief.cloak,legacy:true};
 if(slot==='carry'&&s?.thief?.sack>t)return {id:'sack',until:s.thief.sack,legacy:true};
 return null;
}
export const thiefBuff=(s,k,t)=>b12Effect(s,THIEF_ITEMS[k]?.slot,t)?.id===k;
export function b12Detection(owner,visitor,t,friend=0){
 const alert=b12Effect(owner,'alert',t),stealth=b12Effect(visitor,'stealth',t);
 return Math.min(.75,Math.max(.35,.55+(GUARD_ITEMS[alert?.id]?.detect||0)+(stealth?.legacy?-.15:THIEF_ITEMS[stealth?.id]?.detect||0)+Math.min(.06,Math.max(0,friend))));
}
export function b12StealCost(s,t,spots,base,per,max){
 return Math.max(1,Math.min(max,base+(spots-1)*per)-(THIEF_ITEMS[b12Effect(s,'stealth',t)?.id]?.energy||0));
}
export function b12GuardRefundQuote(s){
 if(!b12ClockStart()||s.b12?.guardRefund)return 0;
 const old=[{m:.15,price:800,h:24},{m:.3,price:2000,h:24},{m:.5,price:5000,h:48}].find(g=>g.m===s.guard?.m);
 if(!old||!Number.isSafeInteger(s.guard.until))return 0;
 return Math.floor(old.price*Math.min(8*86400,Math.max(0,s.guard.until-b12ClockStart()))/(old.h*3600));
}
function b12GuardAction(s,act,ctx){
 if(act.a==='guardRefund'){
  const amount=b12GuardRefundQuote(s);if(!amount)return {a:act.a,ok:false,msg:'没有待领取的旧守家道具补偿'};
  s.b12.guardRefund={at:ctx.t,amount};delete s.guard;
  return {a:act.a,ok:true,earn:amount,refund:amount,msg:'旧守家道具补偿 '+amount+' D 已到账'};
 }
 const item=act.a==='buy'&&Object.hasOwn(b12EffectItems,String(act.id))?b12EffectItems[String(act.id)]:null;if(!item)return null;
 const fail=msg=>({a:act.a,ok:false,msg}),cur=b12Effect(s,item.slot,ctx.t);
 if(cur?.legacy&&cur.id==='cloak')return fail('旧夜行斗篷保留原效果，到期后可购买新版道具');
 if(cur&&cur.id!==act.id)return fail('同槽已有'+ITEM_NAME[cur.id]+'，到期后再选择其他道具');
 const from=Math.max(ctx.t,cur?.until||0),until=from+item.h*3600;
 if(until-ctx.t>7*86400)return fail('同一效果最多预付 7 天');
 if(ctx.coins<item.price)return fail('D币不足');
 (s.b12.effects||={})[item.slot]={id:act.id,until};
 return {a:act.a,ok:true,spend:item.price,msg:item.name+'已生效'};
}

// ---------- 11-07 b4 市场商闻：每个岛日按季节和天气抽 2 条（不同商会），影响对应商品价格 ----------
export const GUILDS = { longgong: '东海龙宫', kunlun: '昆仑玉坊', fusang: '扶桑神农社', yingzhou: '瀛洲酒肆', qingqiu: '青丘狐市', penglai: '蓬莱仙市', buzhou: '不周山工坊', guixu: '归墟商号' };
const FISH_IDS = FISH.map((f) => f.id), GEMS = ['amethyst', 'emerald', 'ruby', 'diamond'], METAL = ['coal', 'copper', 'iron', 'gold'], ANIMAL_PROD = ANIMALS.map((a) => a.product);
export const MARKET_EVENTS = [
    { id: 'feast', g: 'longgong', text: '东海龙宫大摆水族宴，四处高价收鲜鱼', items: FISH_IDS, m: 1.35, w: (s, w) => (w === 1 ? 3 : 1) },
    { id: 'seal', g: 'longgong', text: '龙王闭关，渔市冷清', items: FISH_IDS, m: 0.82, w: () => 0.7 },
    { id: 'storm', g: 'longgong', text: '大风封港，鲜鱼紧俏', items: FISH_IDS, m: 1.5, w: (s, w) => (w === 2 ? 3 : 0) },
    { id: 'jade', g: 'kunlun', text: '昆仑玉坊开窑，收宝石和首饰', items: [...GEMS, 'jewel', 'crown'], m: 1.4, w: (s, w) => (w === 3 ? 3 : 1) },
    { id: 'jadeglut', g: 'kunlun', text: '昆仑玉坊库房堆满，宝石压价', items: GEMS, m: 0.8, w: () => 0.7 },
    { id: 'forge', g: 'buzhou', text: '不周山工坊开炉铸器，矿石和锭子抢手', items: [...METAL, 'ironbar', 'ingot'], m: 1.35, w: (s) => (s === 3 ? 2 : 1) },
    { id: 'quake', g: 'buzhou', text: '不周山地动，矿道封闭，矿价飞涨', items: [...METAL, ...GEMS], m: 1.55, w: () => 0.35 },
    { id: 'harvest', g: 'fusang', text: '扶桑神农社丰收祭，当季作物满街', items: 'season', m: 0.8, w: (s) => (s === 2 ? 2.5 : 1) },
    { id: 'locust', g: 'fusang', text: '扶桑闹虫灾，作物紧缺', items: 'crops', m: 1.4, w: (s) => (s === 1 ? 2 : 0.6) },
    { id: 'frost', g: 'fusang', text: '寒潮南下，冬菜涨价', items: ['cabbage', 'turnip', 'carrot', 'kimchi', 'salad'], m: 1.45, w: (s, w) => (s === 3 ? (w === 3 ? 3 : 2) : 0) },
    { id: 'rain', g: 'fusang', text: '甘霖普降，菜农丰收', items: 'crops', m: 0.85, w: (s, w) => (w === 1 ? 2 : 0) },
    { id: 'brew', g: 'yingzhou', text: '瀛洲酒肆酿新酒，收葡萄和小麦', items: ['grape', 'wheat', 'wine', 'flour'], m: 1.45, w: (s) => (s === 2 ? 2.5 : 1) },
    { id: 'lantern', g: 'qingqiu', text: '青丘狐市办灯会，南瓜和点心热卖', items: ['pumpkin', 'egg', 'duckegg', 'pie', 'jam', 'popcorn'], m: 1.35, w: (s) => (s >= 2 ? 2 : 0.7) },
    { id: 'fox', g: 'qingqiu', text: '青丘九尾狐出嫁，毛衣和首饰被抢购', items: ['wool', 'sweater', 'jewel'], m: 1.5, w: (s) => (s === 3 ? 1.5 : 0.4) },
    { id: 'peach', g: 'penglai', text: '蓬莱仙市开蟠桃会，鲜果供不应求', items: ['strawberry', 'tomato', 'corn', 'jam', 'ketchup', 'salad'], m: 1.35, w: (s) => (s <= 1 ? 2 : 0.6) },
    { id: 'immortal', g: 'penglai', text: '蓬莱仙人下山采办，松露奶酪价翻倍', items: ['truffle', 'cheese', 'wine'], m: 1.6, w: () => 0.35 },
    { id: 'hoard', g: 'guixu', text: '归墟商号大量抛售畜产', items: [...ANIMAL_PROD, 'cheese', 'mayo'], m: 0.78, w: () => 1 },
    { id: 'caravan', g: 'guixu', text: '归墟商号的商队到港，奇货高价收', items: ['truffle', 'wool', 'cheese', 'crown', 'wine', 'sweater'], m: 1.4, w: () => 0.8 },
];
const eventCache = new Map();
export function marketEvents(day) {
    if (!isIsleDay(day)) return [];
    if (eventCache.has(day)) return eventCache.get(day);
    const s = seasonOf(day), w = weatherOf(day), out = [];
    let pool = MARKET_EVENTS.map((e) => ({ e, w: e.w(s, w) })).filter((x) => x.w > 0);
    for (let k = 0; k < 2 && pool.length; k++) {
        const total = pool.reduce((a, b) => a + b.w, 0);
        let x = worldHash('mkt:' + day + ':' + k) * total, i = 0;
        for (; i < pool.length - 1; i++) { x -= pool[i].w; if (x < 0) break; }
        const e = pool[i].e;
        pool = pool.filter((p) => p.e.g !== e.g);
        const items = e.items === 'season' ? CROPS.filter((c) => c.seasons.includes(s)).map((c) => c.id) : e.items === 'crops' ? CROPS.map((c) => c.id) : e.items;
        out.push({ id: e.id, gid: e.g, guild: GUILDS[e.g], text: e.text, m: e.m, items });
    }
    if (eventCache.size > 40) eventCache.delete(eventCache.keys().next().value);
    eventCache.set(day, out);
    return out;
}
export const eventFactor = (item, day) => marketEvents(day).reduce((f, e) => (e.items.includes(item) ? f * e.m : f), 1);
// ---------- 11-07 b4 每日目标：按自己的岛况出题（洒水器全覆盖就不出浇水…），简单 2 / 中等 1 / 困难 1，奖励随难度提高 ----------
export const GOAL_POOL = [
    { id: 'plant', name: '播种', n: 10, t: 1 }, { id: 'harvest', name: '收获作物', n: 8, t: 1 }, { id: 'water', name: '手动浇水', n: 8, t: 1, ok: (s) => WORLD.sprCover[s.tools.spr] < s.plotN },
    { id: 'collect', name: '收动物产物', n: 3, t: 1, ok: (s) => s.barn.length > 0 }, { id: 'fish', name: '钓鱼', n: 6, t: 1 }, { id: 'mine', name: '敲矿石', n: 15, t: 1 },
    { id: 'harvest', name: '收获作物', n: 25, t: 2 }, { id: 'fish', name: '钓鱼', n: 20, t: 2 }, { id: 'mine', name: '敲矿石', n: 40, t: 2 },
    { id: 'sold', name: '卖货收入', n: 80000, t: 2 }, { id: 'craft', name: '加工', n: 5, t: 2 }, { id: 'collect', name: '收动物产物', n: 10, t: 2, ok: (s) => s.barn.length >= 2 },
    { id: 'harvest', name: '收获作物', n: 60, t: 3, ok: (s) => s.plotN >= 10 }, { id: 'sold', name: '卖货收入', n: 300000, t: 3 }, { id: 'mine', name: '敲矿石', n: 80, t: 3 },
    { id: 'craft', name: '加工', n: 15, t: 3 }, { id: 'fish', name: '钓鱼', n: 45, t: 3 },
];
export const GOAL_COINS = [0, 5000, 15000, 40000], GOAL_BONUS_COINS = 30000;
function pickGoals(day, s) {
    const used = new Set(), list = [];
    for (const [t, n] of [[1, 2], [2, 1], [3, 1]]) {
        const pool = GOAL_POOL.map((g, i) => ({ g, i, r: worldHash('goal2:' + day + ':' + i) })).filter((x) => x.g.t === t && (!x.g.ok || x.g.ok(s))).sort((a, b) => a.r - b.r);
        for (const x of pool) { if (list.length >= [0, 2, 3, 4][t]) break; if (used.has(x.g.id)) continue; used.add(x.g.id); list.push(x.i); }
    }
    return list;
}
export function dailyGoals(day, s) {
    if (s) { if (!s.goals || s.goals.day !== day) s.goals = { day, list: pickGoals(day, s) }; return s.goals.list.map((i) => GOAL_POOL[i]); }
    return pickGoals(day, { tools: { spr: 0 }, plotN: 6, barn: [] }).map((i) => GOAL_POOL[i]);
}
// 奖励：D币 + 物品（当季种子 / 鱼饵 / 饲料 / 矿石 / 炸药 / 宝石）；困难目标和全部完成还送擂台装备（服务端发）
export function goalReward(k, goal, day, t) {
    const season = seasonOf(isleDay(t)), seeds = CROPS.filter((c) => c.seasons.includes(season)), r = (salt) => worldHash('gr:' + day + ':' + k + ':' + salt);
    const seed = (n, rich) => { const pool = rich ? seeds.slice(-2) : seeds; const c = pool[Math.floor(r('s') * pool.length)] || CROPS[0]; return ['sd_' + c.id, n]; };
    if (k === 4) return { coins: GOAL_BONUS_COINS, items: [['emerald', 1], ['bomb', 2]], pet: 3 };
    const t3 = goal?.t || 1, opts = t3 === 1 ? [() => ['feed', 10], () => ['bait', 6], () => seed(6), () => ['copper', 6]] : t3 === 2 ? [() => seed(12, true), () => ['bait', 15], () => ['bomb', 2], () => ['iron', 8]] : [() => ['bomb', 3], () => ['ruby', 1], () => seed(20, true)];
    return { coins: GOAL_COINS[t3], items: [opts[Math.floor(r('o') * opts.length)]()], pet: t3 === 3 ? 2 : null };
}

// ---------- 11-07 b7 52弟 玩具摊 ----------
export const NPC = { daily: 52, jackpot: 0.001, jackpotCoins: 1000000 };
export const NPC_GAMES = { rps: '剪刀石头布', card: '抽牌比大小', gomoku: '五子棋', box: '盲盒夺宝' };
export const BOX_SET = [50, 30, 20, 10, 5, 0, -10, -20, -30];
export const GOMOKU_N = 11;
function npcPrize(s, ctx, mult = 1) {
    const r = ctx.rand();
    if (r < NPC.jackpot) return { coins: NPC.jackpotCoins, jackpot: true, got: [] };
    if (r < 0.62) { const c = Math.round((1000 + Math.floor(ctx.rand() ** 2 * 7000)) * mult / 100) * 100; return { coins: c, got: [] }; }
    const season = seasonOf(isleDay(ctx.t)), crop = CROPS.filter((c) => c.seasons.includes(season));
    const pool = [['bomb', 1 + Math.floor(ctx.rand() * 2)], ['bait', 10], ['feed', 10], ['sd_' + (crop[Math.floor(ctx.rand() * crop.length)] || CROPS[0]).id, 8], ['amethyst', 1], ['emerald', 1], ['ruby', 1], ['iron', 6], ['gold', 3]];
    const [id, n] = pool[Math.floor(ctx.rand() * pool.length)];
    return { coins: 0, got: [[id, Math.max(1, Math.round(n * mult))]] };
}
// b8 五子棋：必胜优先、必败防守、活形与断点威胁评分；固定种子只用于同分选择。
function rng32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
export function gomokuLine(b, x, y, who) {
    let best = 0;
    for (const [dx, dy] of DIRS) { let n = 1; for (const sg of [1, -1]) { let k = 1; while (true) { const X = x + dx * k * sg, Y = y + dy * k * sg; if (X < 0 || Y < 0 || X >= GOMOKU_N || Y >= GOMOKU_N || b[Y * GOMOKU_N + X] !== who) break; n++; k++; } } best = Math.max(best, n); }
    return best;
}
export function gomokuAI(b, seed, step) {
    const N = GOMOKU_N, r = rng32(seed * 31 + step * 7919), cand = [];
    for (let y=0;y<N;y++) for(let x=0;x<N;x++) {
        if(b[y*N+x]) continue;
        let near=false;
        for(let dy=-2;dy<=2&&!near;dy++) for(let dx=-2;dx<=2;dx++) {const X=x+dx,Y=y+dy;if(X>=0&&Y>=0&&X<N&&Y<N&&b[Y*N+X]) {near=true;break;}}
        if(near) cand.push([x,y]);
    }
    if(!cand.length) return [N>>1,N>>1];
    const win=cand.find(([x,y])=>gomokuLine(b,x,y,2)>=5);if(win)return win;
    const block=cand.find(([x,y])=>gomokuLine(b,x,y,1)>=5);if(block)return block;
    const strength=([x,y],who)=>{
        let total=0,threats=0;
        for(const [dx,dy] of DIRS){
            let n=1,open=0;
            for(const sg of [-1,1]){let k=1;while(true){const X=x+dx*k*sg,Y=y+dy*k*sg;if(X<0||Y<0||X>=N||Y>=N)break;const v=b[Y*N+X];if(v!==who){if(!v)open++;break;}n++;k++;}}
            total+=n>=4?(open===2?50000:open?10000:0):n===3?(open===2?3500:open?250:0):n===2?(open===2?180:open?30:0):open*3;
            if(n>=3&&open===2)threats++;
            // 五格窗口包括断开的四子和三子，不能只比较连续长度。
            for(let start=-4;start<=0;start++){let count=0,valid=true;for(let k=start;k<start+5;k++){const X=x+dx*k,Y=y+dy*k;if(X<0||Y<0||X>=N||Y>=N){valid=false;break;}const v=k===0?who:b[Y*N+X];if(v&&v!==who){valid=false;break;}if(v===who)count++;}if(valid)total+=count===4?2500:count===3?100:count===2?8:0;}
        }
        return total+(threats>=2?12000:0);
    };
    let best=-Infinity,choices=[];
    for(const p of cand){const value=strength(p,2)+strength(p,1)*1.1-(Math.abs(p[0]-5)+Math.abs(p[1]-5))*0.2;if(value>best){best=value;choices=[p];}else if(value===best)choices.push(p);}
    return choices[Math.floor(r()*choices.length)];
}
// 复盘：玩家先手；mv 是玩家的落子序列；返回 'win' / 'lose' / 'bad'
export function gomokuReplay(seed, mv) {
    const N = GOMOKU_N, b = new Array(N * N).fill(0);
    for (let k = 0; k < mv.length; k++) {
        const [x, y] = mv[k] || [];
        if (!(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < N && y < N) || b[y * N + x]) return 'bad';
        b[y * N + x] = 1;
        if (gomokuLine(b, x, y, 1) >= 5) return k === mv.length - 1 ? 'win' : 'bad';
        if (b.every(Boolean)) return 'lose';
        const [ax, ay] = gomokuAI(b, seed, k); b[ay * N + ax] = 2;
        if (gomokuLine(b, ax, ay, 2) >= 5) return k === mv.length - 1 ? 'lose' : 'bad';
    }
    return 'bad';
}
// ---------- 11-07 b7 鱼彩 ----------
export const SCRATCH = [{ name: '小鱼刮刮乐', price: 1000 }, { name: '金鲸刮刮乐', price: 10000 }];
// 倍数 → 概率（期望返还约 74%）
export const SCRATCH_TABLE = [[1000, 0.00005], [50, 0.002], [10, 0.01], [5, 0.03], [2, 0.08], [1, 0.18]];
export const LOTTO = { price: 500, max: 30, nums: 30, pick: 5, balls: 10 };
export const LOTTO_PRIZE = [['5+1', 1000000], ['5', 100000], ['4+1', 20000], ['4', 3000], ['3+1', 1000], ['3', 300], ['2+1', 200]];
export const lottoDrawId = (t) => isleDayNo(t);
export const isleCount = (s, k, t = Math.floor(Date.now() / 1000)) => (s.iq && s.iq.d === isleIndex(t) ? s.iq[k] || 0 : 0);
export function lottoPrize(tk, dr) {
    const m = tk.n.filter((x) => dr.n.includes(x)).length, b = tk.b === dr.b;
    const key = m + (b ? '+1' : ''), hit = LOTTO_PRIZE.find(([k]) => k === key) || (b && m < 2 ? null : null);
    return hit ? { key, coins: hit[1] } : { key, coins: 0 };
}
export function lottoFromBytes(u8) { const pool = Array.from({ length: LOTTO.nums }, (_, i) => i + 1), n = []; for (let k = 0; k < LOTTO.pick; k++) n.push(pool.splice(u8[k] % pool.length, 1)[0]); return { n: n.sort((a, b) => a - b), b: (u8[LOTTO.pick] % LOTTO.balls) + 1 }; }

export function dailyGoalsOld(day) {
    const pool = GOALS.map((g, i) => ({ g, r: worldHash('goal:' + day + ':' + i) })).sort((a, b) => a.r - b.r);
    return pool.slice(0, 3).map((x) => x.g);
}
export function newWorld(t) {
    return { v: 2, en: WORLD.energyBase, enT: t, enDay: worldDay(t), plotN: WORLD.plotsStart, plots: Array(WORLD.plotsStart).fill(null), barnN: WORLD.barnStart, barn: [], traps: [],
        inv: { turnip: [4, 0, 0], feed: [6, 0, 0] }, tools: { rod: 1, pick: 1, spr: 0, house: 0 }, mine: { max: 1 }, earn: { day: worldDay(t), amt: 0 }, cnt: {}, log: 0 };
}
export const energyMax = (s) => WORLD.energyBase + WORLD.energyPerHouse * s.tools.house;
// 体力按时间回复（满了不再累计）；每天北京时间 0 点每日计数清零
export function refresh(s, t) {
    const day = worldDay(t), max = energyMax(s);
    if (s.en >= max)
        s.enT = Math.max(s.enT, t);
    else {
        const n = Math.floor((t - s.enT) / WORLD.regen);
        if (n > 0) {
            s.en = Math.min(max, s.en + n);
            s.enT = s.en >= max ? t : s.enT + n * WORLD.regen;
        }
    }
    if (s.enDay !== day) {
        s.enDay = day;
        s.cnt = {};
    }
    if (s.earn.day !== day)
        s.earn = { day, amt: 0 };
    return s;
}
export const sprinkled = (s, i) => i < WORLD.sprCover[s.tools.spr];
// 作物生长：stage 0–3（3 = 成熟），-1 = 反季枯萎。浇水（或洒水器、雨天）每阶段让剩余时间缩短 25%。
export function cropStage(p, t, auto = false) {
    const crop = CROPS.find((c) => c.id === p.c);
    if (p.t >= ISLE_LAUNCH ? !crop.seasons.includes(seasonOf(isleDay(p.t))) : !crop.seasons.includes(seasonOf(worldDay(t))))
        return { stage: -1, left: 0, total: 1, crop };
    const fast = p.t >= ISLE_LAUNCH;
    const base = (p.h && crop.regrow ? crop.regrow * (fast ? 0.8 : 1) : crop.grow) * 60 * (fast ? 0.8 : 1);
    const total = base * (auto ? 0.6 : 1) - p.g, el = t - p.t;
    if (el >= total)
        return { stage: 3, left: 0, total, crop };
    return { stage: Math.min(2, Math.floor((el / total) * 3)), left: total - el, total, crop };
}
// 动物：喂一次管 24 小时，期间每 every 分钟产 1 个，窝里最多攒 cap 个。
export function trapReady(tr, t, windy = false) {
    const n = Math.min(WORLD.trapCap, Math.floor((t - tr.p) / (WORLD.trapEvery * 60)) * (windy ? 2 : 1));
    return { n: Math.min(WORLD.trapCap, n), left: Math.max(0, WORLD.trapEvery * 60 - ((t - tr.p) % (WORLD.trapEvery * 60))) };
}
const invAdd = (inv, id, q = 0, n = 1) => { (inv[id] || (inv[id] = [0, 0, 0]))[q] += n; };
const invTake = (inv, id, q, n) => { const a = Object.hasOwn(inv, id) ? inv[id] : null; if (!a || !(a[q] >= n))
    return false; a[q] -= n; if (!a.some(Boolean))
    delete inv[id]; return true; };
const pickWeighted = (pool, w, r) => { let x = r * w.reduce((a, b) => a + b, 0); for (let k = 0; k < pool.length; k++) {
    x -= w[k];
    if (x < 0)
        return pool[k];
} return pool[pool.length - 1]; };
export function fishPool(s, t, maxRod = s.tools.rod) {
    const season = seasonOf(isleDay(t)), h = isleHour(t);
    return FISH.filter((f) => f.rod <= maxRod && f.seasons.includes(season) && ((h >= f.hours[0] && h < f.hours[1]) || (h + 24 >= f.hours[0] && h + 24 < f.hours[1])));
}
// 逐个执行；单个动作失败不影响其他动作（返回原因）。spend / earn 由调用方合并成一次扣款 / 入账。
export function b12BaseApplyActions(s, actions, ctx) {
    refresh(s, ctx.t);
    const out = [];
    let spend = 0, earn = 0, xp = 0;
    const weather = weatherOf(isleDay(ctx.t));
    const coinsLeft = () => ctx.coins - spend + earn;
    const fail = (a, msg) => out.push({ ok: false, a, msg });
    const count = (k) => (s.cnt[k] || 0);
    if (!s.iq || s.iq.d !== isleIndex(ctx.t)) s.iq = { d: isleIndex(ctx.t) };
    const icount = (k) => s.iq[k] || 0, ibump = (k, n = 1) => { s.iq[k] = icount(k) + n; };
    for (const act of actions.slice(0, WORLD.maxActions)) {
        const a = String(act.a), i = Math.floor(Number(act.i));
        // 管家代劳钓鱼 / 挖矿每次多花 1 点体力（亲手玩更划算）
        const cost = (WORLD.cost[a] ?? 0) + (ctx.auto && (a === 'fish' || a === 'mine') ? AUTO.surcharge : 0);
        if (cost && s.en < cost) {
            fail(a, '体力不足');
            continue;
        }
        const extra=b12ExtraAction(s,act,{...ctx,coins:coinsLeft()});
        if(extra){out.push(extra);spend+=extra.spend||0;earn+=extra.earn||0;continue;}
        if (a === 'plant') {
            const crop = CROPS.find((c) => c.id === act.c);
            if (!crop || !(i >= 0 && i < s.plotN) || s.plots[i]) {
                fail(a, '这块地不能种');
                continue;
            }
            if (!crop.seasons.includes(seasonOf(isleDay(ctx.t)))) {
                fail(a, `${crop.name}不是这个季节的作物`);
                continue;
            }
            const freeSeed = invTake(s.inv, 'sd_' + crop.id, 0, 1);
            if (!freeSeed && coinsLeft() < crop.seed) {
                fail(a, 'D币不足');
                continue;
            }
            if (!freeSeed) spend += crop.seed;
            s.en -= cost;
            s.plots[i] = { c: crop.id, t: ctx.t, w: 0, g: 0, h: 0 };
            s.cnt.plant = count('plant') + 1;
            out.push({ ok: true, a, spend: freeSeed ? 0 : crop.seed, seed: freeSeed || undefined });
        }
        else if (a === 'water') {
            const p = s.plots[i];
            if (!p) {
                fail(a, '没有作物');
                continue;
            }
            if (sprinkled(s, i) || weather === 1) {
                fail(a, '已经自动浇过了');
                continue;
            }
            const st = cropStage(p, ctx.t);
            if (st.stage < 0 || st.stage >= 3 || p.w > st.stage) {
                fail(a, '这阶段已经浇过了');
                continue;
            }
            s.en -= cost;
            p.w++;
            s.cnt.water = count('water') + 1;
            p.g += Math.floor(st.left * 0.25);
            out.push({ ok: true, a });
        }
        else if (a === 'harvest') {
            const p = s.plots[i];
            const auto = !!p && (sprinkled(s, i) || weather === 1);
            const st = p && cropStage(p, ctx.t, auto);
            if (!p || !st || st.stage < 3) {
                fail(a, st?.stage === -1 ? '过季枯萎了，清理掉吧' : '还没成熟');
                continue;
            }
            const w = auto ? 3 : p.w;
            const roll = ctx.rand(), gold = 0.05 + 0.1 * w, silver = 0.2 + 0.08 * w;
            // 管家手艺一般：收获只有普通品质、不会多收一个
            const q = ctx.auto ? 0 : roll < gold ? 2 : roll < gold + silver ? 1 : 0;
            // 被串门偷过就少收 1 个（不管几个人偷），主人至少留 1 个
            const n = Math.max(1, (ctx.auto ? 1 : 1 + (ctx.rand() < 0.3 + 0.08 * w ? 1 : 0)) - (p.sv && p.sv.length ? 1 : 0)); // 被偷过最多少收 1 个，保证主人收成
            invAdd(s.inv, p.c, q, n);
            s.en -= cost;
            xp += WORLD.xp.harvest;
            s.cnt.harvest = count('harvest') + 1;
            const crop = st.crop;
            // 可重复采收的作物留在地里重新长，次数用完才清空
            if (crop.regrow && p.h + 1 < (crop.times || 1))
                s.plots[i] = { c: p.c, t: ctx.t, w: 0, g: 0, h: p.h + 1 };
            else
                s.plots[i] = null;
            out.push({ ok: true, a, got: [{ id: p.c, q, n }] });
        }
        else if (a === 'clear') {
            if (!s.plots[i]) {
                fail(a, '空地');
                continue;
            }
            s.plots[i] = null;
            s.en -= cost;
            out.push({ ok: true, a });
        }
        else if (a === 'buyAnimal') {
            const def = ANIMALS.find((x) => x.id === act.k);
            if (!def || s.barn.length >= s.barnN) {
                fail(a, '畜栏已满');
                continue;
            }
            if (coinsLeft() < def.price) {
                fail(a, 'D币不足');
                continue;
            }
            spend += def.price;
            s.barn.push({ k: def.id, f: ctx.t, p: ctx.t, m: 60, born: ctx.t });
            out.push({ ok: true, a, spend: def.price });
        }
        else if (a === 'sellAnimal') {
            const pen = s.barn[i];
            if (!pen) {
                fail(a, '没有这只动物');
                continue;
            }
            const def = ANIMALS.find((x) => x.id === pen.k), gross = Math.round(def.price * 0.4), tax=b12TaxSale(s,ctx,coinsLeft(),gross), value=gross-tax;
            s.barn.splice(i, 1);
            earn += value;
            out.push({ ok: true, a, earn: value, gross, tax });
        }
        else if (a === 'feed') {
            const pen = s.barn[i];
            if (!pen) {
                fail(a, '没有这只动物');
                continue;
            }
            if(b12AnimalStage(pen,ctx.t).retired){fail(a,'动物已退休，不再需要喂食');continue;}
            if (ctx.t - pen.f < 8 * 3600) {
                fail(a, '还饱着呢');
                continue;
            }
            if (!invTake(s.inv, 'feed', 0, 1)) {
                fail(a, '没有饲料');
                continue;
            }
            const st = animalReady(pen, ctx.t);
            // 饿过的动物重新开始计时（饿着的时间不产出）；没饿的续上 24 小时
            b12FeedAnimal(pen,ctx.t);
            s.en -= cost;
            pen.f = ctx.t;
            pen.m = Math.min(100, pen.m + 8);
            out.push({ ok: true, a });
        }
        else if (a === 'pet') {
            const pen = s.barn[i];
            if (!pen) {
                fail(a, '没有这只动物');
                continue;
            }
            if(b12AnimalStage(pen,ctx.t).retired){fail(a,'动物已退休，待收产物仍可收取');continue;}
            if (count('pet' + i) >= 1) {
                fail(a, '今天已经摸过了');
                continue;
            }
            s.cnt['pet' + i] = 1;
            pen.m = Math.min(100, pen.m + 6);
            out.push({ ok: true, a });
        }
        else if (a === 'collect') {
            const pen = s.barn[i];
            if (!pen) {
                fail(a, '没有这只动物');
                continue;
            }
            const st = animalReady(pen, ctx.t);
            if (!st.ready) {
                fail(a, st.retired?'动物已退休，待收产物已收完':st.stage<2?'动物还在成长，距成年约 '+st.daysLeft+' 个岛日':st.fed ? '还没产出' : '饿了，先喂食');
                continue;
            }
            const got = [];
            for (let k = 0; k < st.n; k++) {
                const q = ctx.auto ? 0 : st.qualities[k];
                invAdd(s.inv, st.def.product, q, 1);
                got.push({ id: st.def.product, q, n: 1 });
            }
            // 窝满了以后的时间不累计；没满则保留余下的进度
            const until = Math.min(ctx.t, pen.f + 24 * 3600);
            b12TakeAnimal(pen,ctx.t,st.n);
            pen.m = Math.max(20, pen.m - 2);
            xp += WORLD.xp.collect;
            s.cnt.collect = count('collect') + 1;
            out.push({ ok: true, a, got });
        }
        else if (a === 'buyTrap') {
            if (s.traps.length >= WORLD.trapMax) {
                fail(a, '蟹笼已经放满');
                continue;
            }
            const price = WORLD.trapPrice(s.traps.length + 1);
            if (coinsLeft() < price) {
                fail(a, 'D币不足');
                continue;
            }
            spend += price;
            s.traps.push({ p: ctx.t });
            out.push({ ok: true, a, spend: price });
        }
        else if (a === 'trap') {
            const tr = s.traps[i];
            if (!tr) {
                fail(a, '没有这个蟹笼');
                continue;
            }
            const st = trapReady(tr, ctx.t, weather === 2);
            if (!st.n) {
                fail(a, '笼子里还是空的');
                continue;
            }
            const pool = fishPool(s, ctx.t, 1), got = [];
            for (let k = 0; k < st.n; k++) {
                const f = pickWeighted(pool, pool.map((x) => x.w), ctx.rand());
                invAdd(s.inv, f.id, 0, 1);
                got.push({ id: f.id, q: 0, n: 1 });
            }
            tr.p = st.n >= WORLD.trapCap ? ctx.t : tr.p + Math.ceil(st.n / (weather === 2 ? 2 : 1)) * WORLD.trapEvery * 60;
            out.push({ ok: true, a, got });
        }
        else if (a === 'fish') {
            if (icount('fish') >= WORLD.daily.fish) {
                fail(a, `这个岛日已经钓了 ${WORLD.daily.fish} 竿，鱼都躲起来了（谷内换天就刷新）`);
                continue;
            }
            const useBait = !!act.bait && invTake(s.inv, 'bait', 0, 1);
            s.en -= cost;
            xp += WORLD.xp.fish;
            s.cnt.fish = count('fish') + 1; ibump('fish');
            const pool = fishPool(s, ctx.t);
            // 没咬钩的概率：鱼竿越好越低；雨天、鱼饵更好钓；鱼饵和雨天让贵鱼权重变高
            const miss = Math.max(0.05, 0.22 - 0.04 * s.tools.rod - (useBait ? 0.08 : 0) - (weather === 1 ? 0.05 : 0));
            if (ctx.rand() < miss) {
                out.push({ ok: true, a, got: [], msg: '鱼跑掉了' });
                continue;
            }
            const boost = (useBait ? 2 : 1) * (weather === 1 ? 1.5 : 1);
            const pick = pickWeighted(pool, pool.map((f) => f.w * (f.price >= 9000 ? boost : 1)), ctx.rand());
            const q = ctx.auto ? 0 : ctx.rand() < 0.08 + 0.05 * s.tools.rod ? 2 : ctx.rand() < 0.28 ? 1 : 0;
            invAdd(s.inv, pick.id, q, 1);
            out.push({ ok: true, a, got: [{ id: pick.id, q, n: 1 }] });
        }
        else if (a === 'mine') {
            if (icount('mine') >= WORLD.daily.mine) {
                fail(a, `这个岛日已经挖了 ${WORLD.daily.mine} 下，矿洞要休息（谷内换天就刷新）`);
                continue;
            }
            const floor = Math.max(1, Math.min(Number(act.f) || 1, s.mine.max, PICK_FLOOR[s.tools.pick]));
            s.en -= cost;
            xp += WORLD.xp.mine;
            s.cnt.mine = count('mine') + 1; ibump('mine');
            const pool = ORES.filter((o) => o.floor <= floor);
            const got = [];
            const hits = 1 + (ctx.rand() < 0.25 + 0.05 * s.tools.pick ? 1 : 0);
            for (let k = 0; k < hits; k++) {
                const pick = pickWeighted(pool, pool.map((o) => o.w * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor) / 40)), ctx.rand());
                invAdd(s.inv, pick.id, 0, 1);
                got.push({ id: pick.id, q: 0, n: 1 });
            }
            // 找到下一层的梯子
            let msg;
            if (floor === s.mine.max && s.mine.max < PICK_FLOOR[s.tools.pick] && ctx.rand() < 0.25) {
                s.mine.max++;
                msg = `发现通往第 ${s.mine.max} 层的梯子！`;
            }
            out.push({ ok: true, a, got, msg });
        }
        else if (a === 'craft') {
            const r = RECIPES.find((x) => x.id === act.id), n = Math.max(1, Math.min(20, Math.floor(Number(act.n)) || 1));
            if (!r) { fail(a, '没有这个配方'); continue; }
            if (icount('craft') + n > WORLD.daily.craft) { fail(a, '这个岛日加工坊已经忙不过来了（谷内换天就刷新）'); continue; }
            if (s.en < cost * n) { fail(a, '体力不足'); continue; }
            const have = (id) => (s.inv[id] || [0, 0, 0]).reduce((x, y) => x + y, 0);
            if (Object.entries(r.in).some(([id, need]) => have(id) < need * n)) { fail(a, '材料不够'); continue; }
            for (const [id, need] of Object.entries(r.in)) { let left = need * n; for (let q = 0; q < 3 && left > 0; q++) { const m = Math.min(left, s.inv[id]?.[q] || 0); if (m) { invTake(s.inv, id, q, m); left -= m; } } }
            invAdd(s.inv, r.id, 0, n);
            s.en -= cost * n; xp += WORLD.xp.craft * n; s.cnt.craft = count('craft') + n; ibump('craft', n);
            out.push({ ok: true, a, got: [{ id: r.id, q: 0, n }] });
        }
        else if (a === 'bomb') {
            if (icount('bomb') >= WORLD.daily.bomb) { fail(a, '这个岛日的炸药额度用完了（谷内换天就刷新）'); continue; }
            if (!invTake(s.inv, 'bomb', 0, 1)) { fail(a, '没有炸药，去集市杂货或加工坊弄一个'); continue; }
            const floor = Math.max(1, Math.min(Number(act.f) || 1, s.mine.max, PICK_FLOOR[s.tools.pick]));
            s.en -= cost; s.cnt.bomb = count('bomb') + 1; ibump('bomb'); s.cnt.mine = count('mine') + 6; xp += WORLD.xp.mine * 4;
            const pool = ORES.filter((o) => o.floor <= floor), got = [];
            const n = 6 + (ctx.rand() < 0.3 + 0.05 * s.tools.pick ? 2 : 0);
            for (let k = 0; k < n; k++) { const pick = pickWeighted(pool, pool.map((o) => o.w * (o.price >= 7000 ? 1.35 : 1) * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor) / 40)), ctx.rand()); invAdd(s.inv, pick.id, 0, 1); got.push({ id: pick.id, q: 0, n: 1 }); }
            let msg;
            if (floor === s.mine.max && s.mine.max < PICK_FLOOR[s.tools.pick] && ctx.rand() < 0.6) { s.mine.max++; msg = '炸出了通往第 ' + s.mine.max + ' 层的梯子！'; }
            out.push({ ok: true, a, got, msg });
        }
        else if (a === 'npc') {
            const g = String(act.g), k = String(act.k || 'play'), used = count('npc');
            if (!NPC_GAMES[g]) { fail(a, '没有这个游戏'); continue; }
            if (used >= NPC.daily && !(k === 'pick' || k === 'end')) { fail(a, '52弟 今天玩累了，明天再来'); continue; }
            const pay = (res, mult = 1) => { const o = { ok: true, a, g, res }; if (res === 'win') { const p = npcPrize(s, ctx, mult); earn += p.coins; for (const [id, n] of p.got) invAdd(s.inv, id, 0, n); o.earn = p.coins || undefined; o.got = p.got.map(([id, n]) => ({ id, q: 0, n })); o.jackpot = p.jackpot || undefined; } if (res !== 'draw') s.cnt.npc = count('npc') + 1; if (res === 'win') s.cnt.npcWin = count('npcWin') + 1; return o; };
            if (g === 'rps') {
                const m = Math.floor(Number(act.m)); if (!(m >= 0 && m <= 2)) { fail(a, '出什么？'); continue; }
                const npc = Math.floor(ctx.rand() * 3), res = npc === m ? 'draw' : npc === (m + 1) % 3 ? 'win' : 'lose';
                const o = pay(res); o.npc = npc; out.push(o); // 双方按实际手势比较，不预设胜负
            } else if (g === 'card') {
                const me = 1 + Math.floor(ctx.rand() * 13), np = 1 + Math.floor(ctx.rand() * 13);
                const res = me === np ? 'draw' : me > np ? 'win' : 'lose';
                const o = pay(res); o.me = me; o.np = np; o.suit = [Math.floor(ctx.rand() * 4), Math.floor(ctx.rand() * 4)]; out.push(o);
            } else if (g === 'gomoku') {
                if (k === 'start') { s.npcG = { g, seed: 1 + Math.floor(ctx.rand() * 1e9), t: ctx.t }; out.push({ ok: true, a, g, seed: s.npcG.seed }); continue; }
                if (!s.npcG || s.npcG.g !== g) { fail(a, '先开一局'); continue; }
                const mv = Array.isArray(act.mv) ? act.mv.slice(0, 70) : [], res = gomokuReplay(s.npcG.seed, mv);
                delete s.npcG;
                if (res === 'bad') { fail(a, '棋局对不上，重新开一局吧'); continue; }
                out.push(pay(res, 1.5));
            } else {
                if (k === 'start') { s.npcG = { g, left: BOX_SET.slice(), me: [], np: [] }; out.push({ ok: true, a, g, box: s.npcG }); continue; }
                const G = s.npcG; if (!G || G.g !== g) { fail(a, '先开一局'); continue; }
                const i = Math.floor(Number(act.i)); if (!(i >= 0 && i < 9) || (G.pk || []).includes(i)) { fail(a, '这个盒子开过了'); continue; }
                const take = (idx) => G.left.splice(idx, 1)[0];
                const mine = take(Math.floor(ctx.rand() * G.left.length));
                // 双方从同一个剩余池均匀无放回抽取。
                const theirs = take(Math.floor(ctx.rand() * G.left.length));
                const free = Array.from({length:9},(_,j)=>j).filter(j=>j!==i&&!(G.pk||[]).includes(j));
                const j = free[Math.floor(ctx.rand()*free.length)];
                G.me.push(mine); G.np.push(theirs); G.pk = [...(G.pk || []), i, j];
                if (G.me.length < 3) { out.push({ ok: true, a, g, mine, theirs, j, box: G }); continue; }
                const sa = G.me.reduce((x, y) => x + y, 0), sb = G.np.reduce((x, y) => x + y, 0), res = sa === sb ? 'draw' : sa > sb ? 'win' : 'lose';
                delete s.npcG;
                const o = pay(res); o.mine = mine; o.theirs = theirs; o.j = j; o.box = { ...G, done: 1 }; o.sa = sa; o.sb = sb; out.push(o);
            }
        }
        else if (a === 'scratch') {
            const k = Math.floor(Number(act.k)), T = SCRATCH[k], n = act.n === undefined ? 1 : act.n;
            if (!T) { fail(a, '没有这种刮刮乐'); continue; }
            if (n !== 1 && n !== 10) { fail(a, '一次购买1张或10张'); continue; }
            if (coinsLeft() < T.price * n) { fail(a, 'D币不足，整批未购买'); continue; }
            const tickets = []; let total = 0;
            for (let i = 0; i < n; i++) {
                let r = ctx.rand(), mult = 0; for (const [m, p] of SCRATCH_TABLE) { if (r < p) { mult = m; break; } r -= p; }
                const win = Math.round(T.price * mult); total += win; tickets.push({ mult, earn: win, jackpot: mult >= 1000 || undefined });
            }
            spend += T.price * n; earn += total; s.cnt.scratch = count('scratch') + n;
            s.scratchLast = { t: ctx.t, k, n, spend: T.price * n, earn: total, tickets };
            out.push({ ok: true, a, k, n, spend: T.price * n, earn: total || undefined, tickets, ...(n === 1 ? { mult: tickets[0].mult, jackpot: tickets[0].jackpot } : {}) });
        }
        else if (a === 'lotto') {
            const n = Array.isArray(act.n) ? [...new Set(act.n.map((x) => Math.floor(Number(x))))].filter((x) => x >= 1 && x <= LOTTO.nums) : [], b = Math.floor(Number(act.b));
            if (n.length !== LOTTO.pick || !(b >= 1 && b <= LOTTO.balls)) { fail(a, '选 5 个红球（1–30）+ 1 个蓝球（1–10）'); continue; }
            s.lotto = s.lotto || [];
            if (s.lotto.length >= LOTTO.max) { fail(a, '手里的彩票太多了，先兑奖'); continue; }
            if (coinsLeft() < LOTTO.price) { fail(a, 'D币不足'); continue; }
            spend += LOTTO.price; s.lotto.push({ d: lottoDrawId(ctx.t), n: n.sort((x, y) => x - y), b });
            out.push({ ok: true, a, spend: LOTTO.price, d: lottoDrawId(ctx.t) });
        }
        else if (a === 'lottoClaim') {
            const cur = lottoDrawId(ctx.t), res = [];
            if (!ctx.draws) { out.push({ ok: true, a, pending: true }); continue; }
            s.lotto = (s.lotto || []).filter((tk) => { if (tk.d >= cur || !ctx.draws[tk.d]) return true; const p = lottoPrize(tk, ctx.draws[tk.d]); earn += p.coins; res.push({ ...tk, dr: ctx.draws[tk.d], ...p }); return false; });
            s.lottoLog = [...res.filter((x) => x.coins).map((x) => ({ d: x.d, key: x.key, coins: x.coins })), ...(s.lottoLog || [])].slice(0, 10);
            out.push({ ok: true, a, tickets: res, earn: res.reduce((x, y) => x + y.coins, 0) || undefined });
        }
        else if (a === 'eat') {
            const crop = CROPS.find((c) => c.id === act.id), q = Math.floor(Number(act.q)) || 0;
            if (!crop || !(q >= 0 && q <= 2) || !invTake(s.inv, crop.id, q, 1)) {
                fail(a, '没有这个');
                continue;
            }
            if (s.en >= energyMax(s)) {
                invAdd(s.inv, crop.id, q, 1);
                fail(a, '体力是满的');
                continue;
            }
            s.en = Math.min(energyMax(s), s.en + Math.round(crop.eat * QUALITY[q]));
            out.push({ ok: true, a });
        }
        else if (a === 'coffee') {
            if (count('coffee') >= WORLD.daily.coffee) {
                fail(a, `每天最多喝 ${WORLD.daily.coffee} 杯`);
                continue;
            }
            if (coinsLeft() < WORLD.coffee.price) {
                fail(a, 'D币不足');
                continue;
            }
            spend += WORLD.coffee.price;
            s.cnt.coffee = count('coffee') + 1;
            s.en += WORLD.coffee.energy;
            out.push({ ok: true, a, spend: WORLD.coffee.price });
        }
        else if (a === 'buy') {
            const item = Object.hasOwn(SHOP, String(act.id)) ? SHOP[String(act.id)] : null, n = Math.max(1, Math.min(99, Math.floor(Number(act.n)) || 1));
            if (!item) {
                fail(a, '没有这个商品');
                continue;
            }
            if (coinsLeft() < item.price * n) {
                fail(a, 'D币不足');
                continue;
            }
            spend += item.price * n;
            invAdd(s.inv, String(act.id), 0, n);
            out.push({ ok: true, a, spend: item.price * n });
        }
        else if (a === 'sell') {
            const id = String(act.id), q = Math.floor(Number(act.q)) || 0, n = Math.max(1, Math.min(999, Math.floor(Number(act.n)) || 1));
            const price = Object.hasOwn(BASE_PRICE, id) && Object.hasOwn(ctx.prices, id) ? Number(ctx.prices[id]) : 0;
            if (!(price > 0) || !(q >= 0 && q <= 2) || !Object.hasOwn(s.inv, id) || !(s.inv[id][q] >= n)) {
                fail(a, '库存不足');
                continue;
            }
            const unit = Math.round(price * QUALITY[q]), isCrop = CROPS.some((c) => c.id === id), soldBefore = isCrop ? count('sc_' + id) : 0;
            const gross = Math.round((isCrop ? cropTierValue(soldBefore, n, unit) : unit * n) * (ctx.auto ? 1 - AUTO.fee : 1)), tax=b12TaxSale(s,ctx,coinsLeft(),gross), value=gross-tax; // 管家代卖抽成
            if (isCrop) s.cnt['sc_' + id] = soldBefore + n;
            // 每日售卖上限已取消：卖得再多也照常结算。
            invTake(s.inv, id, q, n);
            earn += value;
            s.cnt.sold = count('sold') + value;
            out.push({ ok: true, a, earn: value, gross, tax });
        }
        else if (a === 'expand') {
            const kind = act.k;
            if (kind === 'plot') {
                if (s.plotN >= WORLD.plotsMax) {
                    fail(a, '已经最大');
                    continue;
                }
                const price = WORLD.plotPrice(s.plotN + 1);
                if (coinsLeft() < price) {
                    fail(a, 'D币不足');
                    continue;
                }
                spend += price;
                s.plotN++;
                s.plots.push(null);
                out.push({ ok: true, a, spend: price });
            }
            else if (kind === 'barn') {
                if (s.barnN >= WORLD.barnMax) {
                    fail(a, '已经最大');
                    continue;
                }
                const price = WORLD.barnPrice(s.barnN + 1);
                if (coinsLeft() < price) {
                    fail(a, 'D币不足');
                    continue;
                }
                spend += price;
                s.barnN++;
                out.push({ ok: true, a, spend: price });
            }
            else
                fail(a, '无效');
        }
        else if (a === 'upgrade') {
            const tool = String(act.k);
            const price = upgradePrice(s, tool);
            if (price == null) {
                fail(a, '已经满级');
                continue;
            }
            if (coinsLeft() < price) {
                fail(a, 'D币不足');
                continue;
            }
            spend += price;
            if (tool === 'house') {
                s.tools.house++;
                s.en += WORLD.energyPerHouse;
            }
            else
                s.tools[tool]++;
            out.push({ ok: true, a, spend: price });
        }
        else if (a === 'goal') {
            const k = Math.floor(Number(act.k)), goals = dailyGoals(ctx.day, s);
            if (!(k >= 0 && k <= 4) || count('goal' + k)) {
                fail(a, '已经领过了');
                continue;
            }
            if (k < 4 ? !goals[k] || count(goals[k].id) < goals[k].n : goals.some((g, j) => !count('goal' + j))) {
                fail(a, '还没完成');
                continue;
            }
            const rw = goalReward(k, goals[k], ctx.day, ctx.t), value = rw.coins;
            s.cnt['goal' + k] = 1;
            earn += value;
            for (const [id, n] of rw.items) invAdd(s.inv, id, 0, n);
            out.push({ ok: true, a, earn: value, got: rw.items.map(([id, n]) => ({ id, q: 0, n })), pet: rw.pet || undefined });
        }
        else
            fail(a, '未知操作');
    }
    // 图鉴：第一次得到的物品打上 new 标记
    const seen = (s.seen || (s.seen = []));
    for (const o of out)
        for (const g of o.got || [])
            if (!seen.includes(g.id)) {
                seen.push(g.id);
                g.new = 1;
            }
    s.earn.amt += earn;
    s.log++;
    b12RecordActivity(s,ctx.t,out);
    return { out, spend, earn, xp, tax:out.reduce((sum,o)=>sum+(o.tax||0),0) };
}
// 下一级价格；null = 满级 / 无效
export function upgradePrice(s, tool) {
    if (!['rod', 'pick', 'spr', 'house'].includes(tool))
        return null;
    if (tool === 'house')
        return s.tools.house < WORLD.houseMax ? WORLD.housePrice[s.tools.house] : null;
    // rod / pick 从 1 级开始、spr 从 0 级开始；table[lv] 都是升到 lv+1 的价格
    const table = WORLD.tools[tool], lv = s.tools[tool];
    return table && lv != null && lv < table.length ? table[lv] : null;
}
// ---------- 挂机管家 ----------
// 不跑定时任务：玩家回来（或做任何操作）时，服务端按「每 4 小时巡视一次」把离开期间的巡视补算出来，最多补 2 天（12 轮）。
// 每轮巡视：收蟹笼 → 收动物产物、喂食（饲料不够自动买）→ 收菜、清枯萎、浇水、补种 → 剩余体力按比例钓鱼 / 挖矿 → 按策略卖货。
// 雇佣一次 30 万 D币，之后每轮巡视付 5000 工钱（付不起就歇一轮）。
// 和亲手玩的差别：钓鱼 / 挖矿每次多耗 2 点体力；收获 / 产物 / 鱼都只有普通品质、不会多收；代卖抽成 20%；没有咖啡；每 4 小时巡视一次。
// 经济（sim-auto.mjs）：只挂机约为认真玩的一半左右。
export const AUTO = { every: 4 * 3600, maxBack: 48 * 3600, maxVisits: 12, fee: 0.2, surcharge: 2, budgetMax: 5000000, hire: 150000, wage: 3000 };
export const AUTO_DEFAULT = { on: false, crop: 'best', water: true, feed: true, fishPct: 50, keep: 30, sell: true, minPct: 90, budget: 100000, craft: false, bomb: false, goals: true, guard: 0 };
// 校验前端提交的策略（未知字段丢弃、数值夹到范围内）
export function autoConfig(raw, prev = AUTO_DEFAULT) {
    const r = (raw && typeof raw === 'object' ? raw : {});
    const num = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const crop = typeof r.crop === 'string' && (r.crop === 'best' || r.crop === 'none' || CROPS.some((c) => c.id === r.crop)) ? r.crop : prev.crop;
    return { on: bool(r.on, prev.on), crop, water: bool(r.water, prev.water), feed: bool(r.feed, prev.feed), fishPct: num(r.fishPct, 0, 100, prev.fishPct), keep: num(r.keep, 0, 300, prev.keep), sell: bool(r.sell, prev.sell), minPct: num(r.minPct, 0, 200, prev.minPct), budget: num(r.budget, 0, AUTO.budgetMax, prev.budget), craft: bool(r.craft, prev.craft ?? false), bomb: bool(r.bomb, prev.bomb ?? false), goals: bool(r.goals, prev.goals ?? true), guard: num(r.guard, 0, 4, prev.guard ?? 0) };
}
// 「当季最赚」：按 3 小时巡视节奏估算每分钟净收益
export function bestCrop(season, gapMin = AUTO.every / 60) {
    const v = (c) => (c.price * 1.4 * (c.regrow ? Math.min(c.times || 1, 3) : 1) - c.seed) / Math.max(gapMin, c.grow * 0.6);
    return CROPS.filter((c) => c.seasons.includes(season)).sort((a, b) => v(b) - v(a))[0];
}
export const autoDue = (s, now) => !!s.auto?.on && now - s.auto.t >= AUTO.every;
export function b12BaseAutoSettle(s, ctx) {
    const a = s.auto;
    if (!a?.on || ctx.now - a.t < AUTO.every)
        return null;
    let spend = 0, earn = 0, xp = 0, tax=0, visits = 0, wage = 0, skipped = 0;
    const got = {}, acts = {}, soldN = {};
    const priceCache = new Map();
    const pricesFor = (day) => {
        if (day === ctx.today)
            return ctx.prices;
        if (!priceCache.has(day))
            priceCache.set(day, Object.fromEntries(Object.keys(BASE_PRICE).map((id) => [id, priceOf(id, day)])));
        return priceCache.get(day);
    };
    const run = (list, t) => {
        for (let k = 0; k < list.length; k += WORLD.maxActions) {
            const part = list.slice(k, k + WORLD.maxActions), day = worldDay(t);
            const r = applyActions(s, part, { t, day, rand: ctx.rand, prices: pricesFor(isleDay(t)), coins: ctx.coins - spend + earn, auto: true, taxTime:ctx.now });
            spend += r.spend;
            earn += r.earn;
            xp += r.xp;tax+=r.tax||0;
            r.out.forEach((o, j) => {
                if (!o.ok)
                    return;
                acts[o.a] = (acts[o.a] || 0) + 1;
                for (const g of o.got || [])
                    got[g.id] = (got[g.id] || 0) + g.n;
                if (o.a === 'sell') {
                    const id = String(part[j].id);
                    soldN[id] = (soldN[id] || 0) + (Number(part[j].n) || 1);
                }
            });
        }
    };
    // 超过 2 天的部分跳过（管家也要休息）：从「最近 2 天内」的第一个巡视点开始补算
    let t = a.t + AUTO.every;
    const oldest = ctx.now - AUTO.maxBack;
    if (t < oldest)
        t += Math.ceil((oldest - t) / AUTO.every) * AUTO.every;
    const from = t;
    for (; t <= ctx.now && visits + skipped < AUTO.maxVisits; t += AUTO.every) {
        // 工钱：每轮先付；付不起这一轮就歇着
        if (ctx.coins - spend + earn < AUTO.wage) {
            skipped++;
            a.t = t;
            continue;
        }
        spend += AUTO.wage;
        wage += AUTO.wage;
        refresh(s, t);
        const weather = weatherOf(isleDay(t)), season = seasonOf(isleDay(t));
        let budget = a.budget;
        // 1. 蟹笼
        run(s.traps.map((tr, i) => (trapReady(tr, t, weather === 2).n ? { a: 'trap', i } : null)).filter(Boolean), t);
        // 2. 牧场
        const animal = [];
        s.barn.forEach((pen, i) => { if (animalReady(pen, t).ready)
            animal.push({ a: 'collect', i }); });
        if (a.feed) {
            const hungry = s.barn.map((pen, i) => (!b12AnimalStage(pen,t).retired && t - pen.f >= 8 * 3600 ? i : -1)).filter((i) => i >= 0);
            const lack = hungry.length - (s.inv.feed?.[0] || 0);
            if (lack > 0 && lack * SHOP.feed.price <= budget) {
                const n = Math.min(99, lack + 5);
                animal.push({ a: 'buy', id: 'feed', n });
                budget -= n * SHOP.feed.price;
            }
            hungry.forEach((i) => animal.push({ a: 'feed', i }));
        }
        run(animal, t);
        // 3. 农田：收、清、浇、种（种地优先用体力）
        const farm = [];
        s.plots.forEach((p, i) => { if (!p)
            return; const st = cropStage(p, t, sprinkled(s, i) || weather === 1); if (st.stage === 3)
            farm.push({ a: 'harvest', i });
        else if (st.stage === -1)
            farm.push({ a: 'clear', i }); });
        run(farm, t);
        const crop = a.crop === 'none' ? null : a.crop === 'best' ? bestCrop(season) : CROPS.find((c) => c.id === a.crop && c.seasons.includes(season));
        const tend = [];
        if (a.water && weather !== 1)
            s.plots.forEach((p, i) => { if (!p || sprinkled(s, i))
                return; const st = cropStage(p, t); if (st.stage >= 0 && st.stage < 3 && p.w <= st.stage)
                tend.push({ a: 'water', i }); });
        if (crop)
            s.plots.forEach((p, i) => { if (!p && i < s.plotN && budget >= crop.seed && s.en - a.keep >= WORLD.cost.plant) {
                tend.push({ a: 'plant', i, c: crop.id });
                budget -= crop.seed;
            } });
        run(tend, t);
        // 4.5 炸矿 / 加工 / 续守家 / 领每日目标
        if (a.bomb) { const nb = Math.min(3, s.inv.bomb?.[0] || 0, Math.floor(Math.max(0, s.en - a.keep) / WORLD.cost.bomb)); run(Array.from({ length: nb }, () => ({ a: 'bomb', f: 99 })), t); }
        if (a.craft) {
            const pr = pricesFor(worldDay(t)), have = (id) => (s.inv[id] || [0, 0, 0]).reduce((x, y) => x + y, 0), cl = [];
            for (const r of RECIPES) {
                if (!r.price || !(pr[r.id] > Object.entries(r.in).reduce((x, [id, n]) => x + (pr[id] || 0) * n, 0) * 1.1)) continue;
                const n = Math.min(20, Math.max(0, s.en - a.keep), ...Object.entries(r.in).map(([id, k]) => Math.floor(have(id) / k)));
                if (n > 0) cl.push({ a: 'craft', id: r.id, n });
            }
            run(cl, t);
        }
        if(a.guard){const id='guard'+a.guard,g=GUARD_ITEMS[id];if(g&&!b12Effect(s,g.slot,t)&&g.price<=budget){run([{a:'buy',id}],t);budget-=g.price;}}
        if (a.goals) { const gs = dailyGoals(worldDay(t), s); run([0, 1, 2, 3].filter((k) => gs[k] && gs[k].t < 3).map((k) => ({ a: 'goal', k })), t); }
        // 4. 剩余体力：钓鱼 / 挖矿
        const spare = Math.max(0, s.en - a.keep), fishCost = WORLD.cost.fish + AUTO.surcharge, mineCost = WORLD.cost.mine + AUTO.surcharge;
        const nf = Math.floor((spare * a.fishPct) / 100 / fishCost), nm = Math.floor((spare - nf * fishCost) / mineCost);
        const work = [];
        for (let k = 0; k < nf; k++)
            work.push({ a: 'fish', bait: (s.inv.bait?.[0] || 0) > k });
        for (let k = 0; k < nm; k++)
            work.push({ a: 'mine', f: 99 });
        run(work, t);
        b12ReplenishWarehouse(s);
        // 5. 卖货（只卖作物 / 畜产 / 鱼 / 矿；低于「基础价 × minPct%」的留着等涨价）
        if (a.sell) {
            const pr = pricesFor(isleDay(t)), sells = [];
            for (const [id, qs] of Object.entries(s.inv)) {
                if (!BASE_PRICE[id] || !(pr[id] >= (BASE_PRICE[id] * a.minPct) / 100))
                    continue;
                qs.forEach((n, q) => { if (n)
                    sells.push({ a: 'sell', id, q, n }); });
            }
            run(sells, t);
        }
        visits++;
        a.t = t;
    }
    const log = { from, to: a.t, visits, got, earn, spend, xp, tax, acts, wage, skipped };
    s.autoLog = log;
    return { spend, earn, xp, tax, log, sold: soldN };
}

// One deployment anchor shared by website and mini app. Never replaces Date.now,
// worldDay, energy, crop elapsed time, adult production or real-time butler visits.
let b12ClockEpoch=0;
export function b12ConfigureClock(epoch) {
    const value=Number(epoch);
    if(!Number.isSafeInteger(value) || value<ISLE_LAUNCH || value>4000000000)throw new RangeError('长夜时钟配置无效');
    b12ClockEpoch=value;
    return value;
}
export function b12ClockStart() {return b12ClockEpoch;}
function b12ActiveSeconds(t) {
    const local=t+8*3600,day=Math.floor(local/86400),second=local-day*86400;
    return day*14*3600+Math.max(0,Math.min(14*3600,second-8*3600));
}
export function b12ClockSeconds(t) {
    if(!b12ClockEpoch || t<=b12ClockEpoch)return t+8*3600;
    return b12ClockEpoch+8*3600+b12ActiveSeconds(t)-b12ActiveSeconds(b12ClockEpoch);
}
export function b12IsLongNight(t) {
    const hour=hourOf(t);return hour>=22 || hour<8;
}
export function b12NextIsleBoundary(t) {
    let left=ISLE_SPAN-(b12ClockSeconds(t)%ISLE_SPAN),cursor=t;
    if(!b12ClockEpoch || t<b12ClockEpoch)return t+left;
    for(let i=0;i<3;i++){
        const second=((cursor+8*3600)%86400+86400)%86400;
        if(second<8*3600){cursor+=8*3600-second;continue;}
        if(second>=22*3600){cursor+=86400-second+8*3600;continue;}
        const room=22*3600-second;
        if(left<=room)return cursor+left;
        left-=room;cursor+=room;
    }
    // At most one long night lies between adjacent island days (14h > 4h).
    return cursor+left;
}
export const b12NightKey=t=>worldDay(t-22*3600);

// Shared rules extension injected into the frozen b11 client and Worker.
// inv remains the sole stock ledger. vault is a reserved subset, never extra stock.
const b12WarehouseMasks = new WeakMap();
const b12Own = (object,key) => !!object && Object.hasOwn(object,key);
const b12Count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

export function b12State(s) {
    let d=s.b12;
    if(!d || typeof d!=='object' || Array.isArray(d)) d=s.b12={v:1};
    for(const field of ['vault','keep']){
        const raw=d[field],clean={};
        if(raw && typeof raw==='object' && !Array.isArray(raw)) for(const id of Object.keys(raw).slice(0,256)){
            if(!b12Own(ITEM_NAME,id) || !Array.isArray(raw[id])) continue;
            const values=[0,1,2].map(q=>Math.min(b12Count(raw[id][q]),field==='vault'?b12Count(s.inv?.[id]?.[q]):Number.MAX_SAFE_INTEGER));
            if(values.some(Boolean)) clean[id]=values;
        }
        d[field]=clean;
    }
    d.v=1;
    if(d.guardVersion!==1){d.guardVersion=1;if(s.auto)s.auto.guard=0;}
    return d;
}

export function b12Available(s,id,q) {
    const quantity=b12Count(s.inv?.[id]?.[q]);
    return b12WarehouseMasks.has(s)?quantity:Math.max(0,quantity-b12Count(s.b12?.vault?.[id]?.[q]));
}

function b12WarehouseAction(s,act) {
    const d=b12State(s),id=String(act.id||''),q=act.q,n=act.n;
    if(!b12Own(ITEM_NAME,id) || !Number.isInteger(q) || q<0 || q>2 || !Number.isSafeInteger(n) || n<0 || n>b12Count(s.inv?.[id]?.[q])) return {ok:false,a:'warehouse',msg:'预留数量无效或超过当前库存'};
    const values=d.vault[id] || [0,0,0];values[q]=n;
    if(values.some(Boolean))d.vault[id]=values;else delete d.vault[id];
    if(typeof act.keep==='boolean'){
        const target=d.keep[id] || [0,0,0];target[q]=act.keep?n:0;
        if(target.some(Boolean))d.keep[id]=target;else delete d.keep[id];
    }
    return {ok:true,a:'warehouse',id,q,n,msg:n?'已存入仓库，自动出售和加工会保留这些物品':'已解除预留'};
}

// Reveal only the reserved ingredients necessary for this explicit operation.
// Available higher-quality stock is consumed before any reserved lower quality.
function b12ExposeReserved(s,act,hidden) {
    if(act?.includeWarehouse!==true) return;
    const reveal=(id,need,quality)=>{
        const qs=quality===undefined?[0,1,2]:[quality];
        let left=Math.max(0,need-qs.reduce((sum,q)=>sum+b12Count(s.inv?.[id]?.[q]),0));
        for(const q of qs){
            const amount=Math.min(left,b12Count(hidden[id]?.[q]));
            if(amount){(s.inv[id] ||= [0,0,0])[q]+=amount;hidden[id][q]-=amount;left-=amount;}
        }
    };
    if(act.a==='craft'){
        const recipe=RECIPES.find(r=>r.id===act.id),count=Math.max(1,Math.min(20,Math.floor(Number(act.n))||1));
        if(recipe)for(const [id,need]of Object.entries(recipe.in))reveal(id,need*count);
    }else if(act.a==='sell')reveal(String(act.id),Math.max(1,Math.min(999,Math.floor(Number(act.n))||1)),Math.floor(Number(act.q))||0);
    else if(act.a==='eat')reveal(String(act.id),1,Math.floor(Number(act.q))||0);
    else if(act.a==='feed')reveal('feed',1,0);
    else if(act.a==='bomb')reveal('bomb',1,0);
    else if(act.a==='fish' && act.bait)reveal('bait',1,0);
    else if(act.a==='plant')reveal('sd_'+String(act.c),1,0);
}

function b12WithAvailableInventory(s,act,run) {
    const d=b12State(s),hidden={},available={};
    for(const [id,qs]of Object.entries(s.inv)){
        available[id]=[0,1,2].map(q=>b12Count(qs[q])-b12Count(d.vault[id]?.[q]));
        if(d.vault[id]) hidden[id]=d.vault[id].slice();
    }
    s.inv=available;
    b12ExposeReserved(s,act,hidden);
    b12WarehouseMasks.set(s,{hidden});
    try{return run();}
    finally{
        const complete={};
        for(const id of new Set([...Object.keys(s.inv),...Object.keys(hidden)])){
            const qs=[0,1,2].map(q=>b12Count(s.inv[id]?.[q])+b12Count(hidden[id]?.[q]));
            if(qs.some(Boolean))complete[id]=qs;
        }
        s.inv=complete;b12WarehouseMasks.delete(s);b12State(s);
    }
}

// Before the butler sells a round's new harvest, fill configured reserve targets.
export function b12ReplenishWarehouse(s) {
    const masked=b12WarehouseMasks.get(s),d=masked?s.b12:b12State(s);
    for(const [id,target]of Object.entries(d.keep))for(let q=0;q<3;q++){
        const existing=b12Count(d.vault[id]?.[q]),amount=Math.min(Math.max(0,target[q]-existing),b12Available(s,id,q));
        if(!amount)continue;
        (d.vault[id] ||= [0,0,0])[q]=existing+amount;
        if(masked){(masked.hidden[id] ||= [0,0,0])[q]+=amount;s.inv[id][q]-=amount;}
    }
}

export function applyActions(s,actions,ctx) {
    if(b12WarehouseMasks.has(s)) return b12BaseApplyActions(s,actions,ctx);
    b12State(s);
    let spend=0,earn=0,xp=0;const out=[],beforeLog=s.log;
    for(const act of actions.slice(0,WORLD.maxActions)){
        if(act?.a==='warehouse'){out.push(b12WarehouseAction(s,act));continue;}
        const hadReserved=Object.keys(s.b12.vault).length>0;
        const result=b12WithAvailableInventory(s,act,()=>b12BaseApplyActions(s,[act],{...ctx,coins:ctx.coins-spend+earn}));
        if(hadReserved && act?.includeWarehouse!==true)for(const row of result.out){
            if(!row.ok && /库存不足|材料不够|没有饲料|没有炸药/.test(row.msg||''))row.msg+='（仓库预留未计入，可选择包含仓库）';
        }
        spend+=result.spend;earn+=result.earn;xp+=result.xp;out.push(...result.out);
    }
    s.log=(Number(beforeLog)||0)+1;
    return {out,spend,earn,xp,tax:out.reduce((sum,o)=>sum+(o.tax||0),0)};
}

export function autoSettle(s,ctx) {
    if(!autoDue(s,ctx.now))return null;
    b12ReplenishWarehouse(s);
    return b12WithAvailableInventory(s,null,()=>b12BaseAutoSettle(s,ctx));
}

// Daily cargo is deterministic; stock limits belong to each island, never a race.
ITEM_NAME.tide_snack='潮汐饭团';
export const B12_SNACK={energy:20,daily:2,price:6500};
export function b12Stock(t,prices={}) {
    const day=isleDay(t),pick=(ids,n,salt)=>ids.map(id=>({id,r:worldHash('b12-cargo:'+day+':'+salt+':'+id)})).sort((a,b)=>a.r-b.r||a.id.localeCompare(b.id)).slice(0,n).map(x=>x.id);
    const groups=[
        ['crop',pick(CROPS.map(x=>x.id),4,'crop'),24],
        ['animal',pick(ANIMALS.map(x=>x.product),2,'animal'),8],
        ['crafted',pick(RECIPES.filter(x=>x.price).map(x=>x.id),2,'crafted'),4],
        ['material',pick([...FISH,...ORES].map(x=>x.id),2,'material'),6],
        ['supply',worldHash('b12-rare:'+day)<.15?['tide_snack',pick(['feed','bait','bomb'],1,'supply')[0]]:pick(['feed','bait','bomb'],2,'supply'),12],
    ];
    return groups.flatMap(([kind,ids,limit])=>ids.map(id=>({id,name:ITEM_NAME[id],kind,limit:id==='tide_snack'?1:limit,rare:id==='tide_snack',price:id==='tide_snack'?B12_SNACK.price:SHOP[id]?.price??BASE_PRICE[id]})));
}
export function b12StockLeft(s,item,t) {
    return Math.max(0,item.limit-(s.b12?.shop?.d===isleDay(t)?s.b12.shop.n?.[item.id]||0:0));
}
function b12ExtraAction(s,act,ctx) {
    const story=b12StoryAction(s,act,ctx);if(story)return story;
    const guard=b12GuardAction(s,act,ctx);if(guard)return guard;
    if(act.a==='stockBuy'){
        const day=isleDay(ctx.t),item=b12Stock(ctx.t,ctx.prices).find(x=>x.id===act.id),n=act.n;
        const fail=msg=>({a:act.a,ok:false,msg});
        if(act.day!==day)return fail('货船已换货，请刷新货架后购买');
        if(!item||!Number.isSafeInteger(n)||n<1)return fail('商品或数量无效');
        if(n>b12StockLeft(s,item,ctx.t))return fail('超过本岛日个人购买额度');
        const spend=item.price*n;if(ctx.coins<spend)return fail('D币不足');
        const d=b12WarehouseMasks.has(s)?s.b12:b12State(s);if(d.shop?.d!==day)d.shop={d:day,n:{}};
        d.shop.n[item.id]=(d.shop.n[item.id]||0)+n;invAdd(s.inv,item.id,0,n);
        return {a:act.a,ok:true,id:item.id,n,spend,msg:'货物已放入背包'};
    }
    if(act.a==='eat'&&act.id==='tide_snack'){
        const fail=msg=>({a:act.a,ok:false,msg});
        if((s.cnt.tide_snack||0)>=B12_SNACK.daily)return fail('今天已吃过两份潮汐饭团');
        if(s.en>=energyMax(s))return fail('体力已满');
        if(!invTake(s.inv,'tide_snack',0,1))return fail('库存不足');
        const add=Math.min(B12_SNACK.energy,energyMax(s)-s.en);s.en+=add;s.cnt.tide_snack=(s.cnt.tide_snack||0)+1;
        return {a:act.a,ok:true,energy:add,msg:'潮汐饭团恢复 '+add+' 点体力'};
    }
    return null;
}

export const B12_GROW_DAYS={chicken:2,duck:3,cow:5,sheep:5,pig:6};
export const B12_ADULT_DAYS={chicken:24,duck:36,cow:48,sheep:60,pig:72};
export function b12AfterActive(t,seconds) {
    if(!b12ClockStart())return t+seconds;
    let cursor=t,left=seconds;
    if(cursor<b12ClockStart()){const legacy=Math.min(left,b12ClockStart()-cursor);cursor+=legacy;left-=legacy;if(!left)return cursor;}
    for(let i=0;i<1000;i++){
        const second=((cursor+28800)%86400+86400)%86400;
        if(second<28800){cursor+=28800-second;continue;}
        if(second>=79200){cursor+=86400-second+28800;continue;}
        const room=79200-second;if(left<=room)return cursor+left;
        left-=room;cursor+=room;
    }
    throw new RangeError('成长时间超出范围');
}
export function b12AnimalStage(a,t) {
    const days=B12_GROW_DAYS[a.k]||2,legacy=!Number.isSafeInteger(a.born),adultAt=legacy?b12ClockStart():b12AfterActive(a.born,days*ISLE_SPAN);
    const retireAt=b12ClockStart()?b12AfterActive(adultAt,B12_ADULT_DAYS[a.k]*ISLE_SPAN):0;
    const adultLeft=retireAt?Math.max(0,Math.ceil((b12ClockSeconds(retireAt)-b12ClockSeconds(t))/ISLE_SPAN)):B12_ADULT_DAYS[a.k];
    if(retireAt&&t>=retireAt)return {stage:3,days,left:0,adultLeft:0,retireAt,retired:true};
    if(legacy)return {stage:2,days,left:0,adultLeft,retireAt,retired:false};
    const elapsed=Math.max(0,(b12ClockSeconds(t)-b12ClockSeconds(a.born))/ISLE_SPAN);
    return {stage:elapsed>=days?2:elapsed>=Math.ceil(days/2)?1:0,days,left:Math.max(0,Math.ceil(days-elapsed)),adultLeft,retireAt,retired:false};
}
export function b12AnimalPeriod(kind,t) {
    const def=ANIMALS.find(x=>x.id===kind);
    if(!b12ClockStart()||t<b12ClockStart())return def.every*60;
    const day=isleDay(t),season=seasonOf(day),weather=weatherOf(day);
    const factors={chicken:[.98,1.02,1,1],duck:[.96,1,1.02,1.02],cow:[.98,1.04,.98,1],sheep:[1,1.02,.98,1],pig:[1,1.02,.96,1.02]};
    const climate=weather===1?(kind==='duck'?.97:1.01):weather===3?1.02:1;
    return Math.round(def.every*60*factors[kind][season]*climate);
}
const b12AnimalQuality=(a,start)=>{
    const day=isleDay(start),bonus=weatherOf(day)===0?.02:weatherOf(day)===3?-.02:0;
    const r=worldHash('b12-animal:'+a.k+':'+(a.born||0)+':'+start),gold=Math.max(0,Math.min(.45,(a.m||0)/250+bonus)),silver=Math.max(0,Math.min(.8,(a.m||0)/120));
    return r<gold?2:r<gold+(1-gold)*silver?1:0;
};
export function animalReady(a,t) {
    const def=ANIMALS.find(x=>x.id===a.k),age=b12AnimalStage(a,t),fed=!age.retired&&t-a.f<86400,until=Math.min(t,a.f+86400,age.retireAt||Infinity);
    const adult=Number.isSafeInteger(a.born)?b12AfterActive(a.born,(B12_GROW_DAYS[a.k]||2)*ISLE_SPAN):0;
    let cursor=Math.max(a.p,adult),qualities=Array.isArray(a.held)?a.held.slice(0,def.cap).map(q=>q===1||q===2?q:0):[],firstReady=qualities.length?(a.heldAt||cursor):0;
    while(qualities.length<def.cap){
        const period=b12AnimalPeriod(a.k,cursor),end=cursor+period;
        if(end>until)break;
        if(!qualities.length)firstReady=end;
        qualities.push(b12AnimalQuality(a,cursor));cursor=end;
    }
    const n=qualities.length,period=b12AnimalPeriod(a.k,cursor);
    return {def,fed,n,ready:n>0,stage:age.stage,daysLeft:age.left,adultLeft:age.adultLeft,retireAt:age.retireAt,retired:age.retired,qualities,firstReady,period,
        nextP:n>=def.cap?Math.max(cursor,until):cursor,
        left:age.retired||n>=def.cap?0:Math.max(0,cursor+period-until)};
}
export function b12FeedAnimal(a,t) {
    if(b12AnimalStage(a,t).retired)return false;
    const st=animalReady(a,t);a.held=st.qualities;a.heldAt=st.firstReady;
    // Resume earned progress; shift only the hungry interval. At the exact
    // 24-hour boundary no progress is lost, including cycles longer than a day.
    a.p=st.fed?st.nextP:Math.max(st.nextP,t-Math.max(0,a.f+86400-st.nextP));
}
export function b12TakeAnimal(a,t,n) {
    const st=animalReady(a,t),count=Math.max(0,Math.min(st.n,n));
    a.p=st.nextP;a.held=st.qualities.slice(count);a.heldAt=a.held.length?st.firstReady:0;
    return st.qualities.slice(0,count);
}

export const B12_TAX={free:3000000,high:10000000,subsidyCap:1000000};
const b12Integer=n=>BigInt(Number.isSafeInteger(n)&&n>0?n:0);
const b12Marginal=(capital,lowRate,highRate,denominator)=>{
    const excess=capital>3000000n?capital-3000000n:0n,low=excess>7000000n?7000000n:excess,high=excess-low;
    return (low*lowRate+high*highRate)/denominator;
};
export const b12BalanceTax=balance=>Number(b12Marginal(b12Integer(balance),1n,3n,1000n));
export function b12SaleQuote(wallet,paid,gross) {
    const carried=wallet<B12_TAX.free?0:paid,basis=b12Integer(wallet)+b12Integer(carried),income=b12Integer(gross);
    const tax=Number(b12Marginal(basis+income,1n,3n,100n)-b12Marginal(basis,1n,3n,100n));
    return {tax:Math.max(0,Math.min(gross,Math.max(0,wallet+gross-B12_TAX.free),tax)),carried};
}
export function b12TaxSale(s,ctx,wallet,gross) {
    const t=ctx.taxTime??ctx.t;if(!gross||!b12ClockStart()||t<b12ClockStart())return 0;
    const d=s.b12||b12State(s),day=worldDay(t);if(d.tax?.day!==day)d.tax={day,paid:0};
    const q=b12SaleQuote(wallet,d.tax.paid||0,gross);d.tax.paid=q.carried+q.tax;return q.tax;
}
export const b12Season=t=>Math.floor((isleDayNo(t)-1)/ISLE_SEASON_DAYS);
export function b12RecordActivity(s,t,out) {
    if(!b12ClockStart()||t<b12ClockStart()||!out.some(x=>x.ok&&['plant','water','harvest','collect','feed','fish','mine','craft','sell','sellAnimal','bomb','trap'].includes(x.a)))return;
    const d=s.b12||b12State(s),season=b12Season(t),slot=((isleDayNo(t)-1)%ISLE_SEASON_DAYS+ISLE_SEASON_DAYS)%ISLE_SEASON_DAYS;
    if(d.activity?.season!==season)d.activity={season,mask:0};d.activity.mask|=1<<slot;
}
// Weighted water filling: capped recipients release their excess to the others.
// Integer remainders stay in the treasury. Inputs and money remain exact integers.
export function b12AllocateSubsidies(rows,budget) {
    const result=rows.map(x=>({id:x.id,gap:Math.max(0,Math.floor(x.gap)),amount:0}));
    let left=b12Integer(budget),active=result.filter(x=>x.gap>0);
    while(active.length&&left>0n){
        const total=active.reduce((sum,x)=>sum+b12Integer(x.gap),0n);
        const capped=active.filter(x=>left*b12Integer(x.gap)/total>=b12Integer(Math.min(x.gap,B12_TAX.subsidyCap)));
        if(!capped.length){for(const x of active)x.amount=Number(left*b12Integer(x.gap)/total);break;}
        const ids=new Set(capped.map(x=>x.id));for(const x of capped){x.amount=Math.min(x.gap,B12_TAX.subsidyCap);left-=b12Integer(x.amount);}active=active.filter(x=>!ids.has(x.id));
    }
    return result.map(({id,amount})=>({id,amount}));
}

export const B12_CHAPTERS=[
 {id:1,title:'重开海路',body:'第一艘货船靠岸时，猫猫摊主把旧航海图铺在了木箱上。图上的四条航线通向不同的季节：春芽湾、长夏港、金叶岬和雪灯岸。岛民修好了码头，船上的东西终于不再只来自眼前这片田。',note:'货船按基础价售货，每个岛日换货。你可以囤下材料加工，也可以等待合适的行情；每人都有自己的购买额度，不必抢船。',close:'摊主在账本最后写道：“让海路带来选择，让收获留在自己手里。”'},
 {id:2,title:'暖棚与仓灯',body:'仓库旧门打开后，里面只剩一盏灯和一本饲养手册。手册记录着小动物第一次站稳、第一次产出，以及最后一次安静归栏的日子。岛民把灯重新点亮，约定先留下明天需要的种子和饲料，再把剩下的收获送去集市。',note:'仓库预留会避开自动出售和消耗。动物经历幼年、成长、成年与老年；老年不再生产，退休前的产物会保留，可以收完后出售换养。',close:'长夜里不用守着仓门。作物继续生长，成年动物照常积攒产物，清晨回来时仍能见到它们。'},
 {id:3,title:'静潮公约',body:'旧潮钟在夜潮里失去了刻度，岛民起初轮流熬夜看守。后来鲸群带回一个办法：每晚十点合上航标，让岛钟停到清晨八点。大家把一部分商路收入存进暖潮公库，也请鲸群为经验落后的家园协防。',note:'每天北京时间22:00—08:00不换岛日，商店和岛日额度不刷新；现实生产继续。季末第11、12岛日举行归港节，公库按规则向资金较少、持续经营的玩家发放补贴。',close:'公约末尾没有“熬夜者优先”。偶尔的漂流瓶和修灯留言会留到次日，来得早与来得晚，都只属于同一段夜潮。'}
];
const B12_NIGHT_EVENTS=[
 {title:'漂流瓶里的种植札记',text:'瓶里画着一排春芽，背面写着“替明天留一份”。猫猫摊主随信放下了一颗小白萝卜。',id:'turnip',n:1},
 {title:'修灯人的回礼',text:'巡灯人给码头补好了灯芯，离开时留下一小袋鱼饵。他说，海面总会等到天亮。',id:'bait',n:2},
 {title:'暖棚门前',text:'邻岛的饲养员经过暖棚，留下两份饲料和一句叮嘱：“老伙伴退休后，不必再催它赶路。”',id:'feed',n:2},
 {title:'鲸群的潮汐便笺',text:'鲸群带来一张新海图，角落压着一颗小白萝卜。航线会继续延伸，今晚先安心休息。',id:'turnip',n:1}
];
export function b12NightView(s,t){
 const key=b12NightKey(t),start=Date.parse(key+'T22:00:00+08:00')/1000,seed=s.b12?.storySeed;
 const available=!!b12ClockStart()&&start>=b12ClockStart()&&Number.isSafeInteger(seed),roll=worldHash('b12-night:'+seed+':'+key),event=available&&roll<.2?Math.min(3,Math.floor(roll/.05)):-1;
 const content=B12_NIGHT_EVENTS[event],claimed=s.b12?.night?.key===key;
 return {key,available,event,claimed,title:content?.title||'平静的夜潮',text:available?(content?.text||'灯已经熄了，海路静静等着天亮。这个夜晚没有奇缘，刷新和反复访问不会改变结果。'):'下一次长夜开始后，纪事会留在这里。',got:content?[{id:content.id,n:content.n,q:0}]:[],claimable:!!content&&!claimed};
}
function b12StoryAction(s,act,ctx){
 if(act.a==='storyRead'){
  if(!Number.isInteger(act.chapter)||act.chapter<1||act.chapter>3)return {a:act.a,ok:false,msg:'章节无效'};
  s.b12.chapters=(s.b12.chapters||0)|(1<<(act.chapter-1));return {a:act.a,ok:true,msg:'已记入山谷纪事'};
 }
 if(act.a==='nightClaim'){
  const v=b12NightView(s,ctx.t);if(act.key!==v.key)return {a:act.a,ok:false,msg:'夜潮已经变化，请重新打开纪事'};
  if(!v.claimable)return {a:act.a,ok:false,msg:v.claimed?'这段夜潮的礼物已经领取':'这个夜晚没有待领取的礼物'};
  for(const item of v.got)invAdd(s.inv,item.id,0,item.n);
  s.b12.night={key:v.key,at:ctx.t,event:v.event};return {a:act.a,ok:true,got:v.got,msg:'夜潮小礼已放入背包'};
 }
 return null;
}
