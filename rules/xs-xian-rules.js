// 大肥鱼修仙记 · 规则（纯函数，前端与 Worker 共用）。存档放在小岛状态 JSON 的 state.xs 里，不新增 D1 表。
// 设计约束：灵力限制每一下操作；没有「一键全部」；每次动作只作用于一块田。
export const XS_VERSION=1;
export const EN_MAX=100,EN_REGEN=360; // 每 6 分钟回 1 点灵力
export const CAN_MAX=20,PLOTS=24,START_OPEN=8;
// row = herbs.webp 的行；grow = 每次浇水后长到下一阶段要的秒数（共 3 次）
export const HERBS={
 lingcao:{name:'灵草',row:0,seed:5,sell:12,grow:600,lv:1},
 jingu:{name:'金菇',row:1,seed:12,sell:30,grow:1200,lv:1},
 linglan:{name:'铃兰',row:2,seed:20,sell:55,grow:1800,lv:2},
 binglian:{name:'冰莲',row:3,seed:40,sell:120,grow:3600,lv:3},
 chizhi:{name:'赤芝',row:4,seed:60,sell:190,grow:5400,lv:4},
 leizhu:{name:'雷竹',row:5,seed:90,sell:300,grow:7200,lv:5},
};
export const COST={hoe:3,plant:1,water:1,harvest:2,refill:0,buy:0,sell:0,story:0,root:0,brew:5,finish:0,use:0,sit:0,rise:0,break:0,fuse:0,learn:0,equip:0,fight:10,win:0,lose:0};
// 丹药：need = 药材配方；炼制要守火候至少 BREW_MIN 秒，成色 q 0–2 → 出丹 1+q 颗
export const PILLS={
 huiling:{name:'回灵丹',need:{lingcao:3,jingu:1},desc:'服下回复 30 点灵力（每日至多 3 颗）',sell:60},
 peiyuan:{name:'培元丹',need:{lingcao:2,linglan:1},desc:'服下药园经验 +40',sell:90},
};
export const BREW_MIN=15,BREW_MAX=1800,PILL_DAILY=3;
export const QUALITY=['凡品','良品','上品'];
const xsDay=t=>Math.floor((t+28800)/86400);
export const ROOTS={metal:'金',wood:'木',water:'水',fire:'火',earth:'土'};
// 灵根资质：根数越少前期越快、越多后期越强。修炼倍率 = BASE[n] × GROW[n]^大境界
export const ROOT_BASE={1:2.0,2:1.5,3:1.15,4:.85,5:.6},ROOT_GROW={1:.85,2:.93,3:1,4:1.08,5:1.17};
export const ROOT_WEIGHT=[[1,8],[2,20],[3,32],[4,25],[5,15]];
// 融合：两种灵根合成一种变异灵根（根数 −1，前期效率升；变异灵根每个让成长 +12%）。有失败几率。
export const FUSIONS={'metal+water':{id:'ice',name:'冰'},'fire+metal':{id:'thunder',name:'雷'},'water+wood':{id:'wind',name:'风'},'earth+fire':{id:'lava',name:'熔'},'earth+wood':{id:'poison',name:'毒'}};
export const REALMS=['炼气','筑基','金丹','元婴','化神','炼虚','合体','大乘','渡劫'];
export const fuseKey=(a,b)=>[a,b].sort().join('+');
export function rootMult(x){const r=x.roots;if(!r)return 1;const n=r.e.length+r.v.length,R=x.cv?.r||0;return ROOT_BASE[n]*Math.pow(ROOT_GROW[n]*(1+.12*r.v.length),R)}
export const cvNeed=(r,s)=>Math.round(60*(r+1)*(r+1)*(1+s*.25));
export const MED_MIN=60,MED_MAX=1800;
// 功法：每种灵根一部（变异灵根各一部）。单灵根只能修本属性，但效率 ×1.5。
export const TECHS={
 fire:{name:'流火诀',el:'fire',spells:['火符「焚天环」','火符「流火扇」']},water:{name:'沧澜诀',el:'water',spells:['水符「千重浪」','水符「镜花水月」']},
 wood:{name:'青木诀',el:'wood',spells:['木符「万木春」','木符「藤缚」']},metal:{name:'庚金剑诀',el:'metal',spells:['剑符「万剑归宗」','剑符「一线天」']},
 earth:{name:'厚土诀',el:'earth',spells:['土符「山岳镇」','土符「流沙」']},ice:{name:'玄冰诀',el:'ice',spells:['冰符「千里冰封」','冰符「霜华」']},
 thunder:{name:'紫霄雷法',el:'thunder',spells:['雷符「九天落雷」','雷符「雷网」']},wind:{name:'御风诀',el:'wind',spells:['风符「青岚」','风符「回风」']},
 lava:{name:'熔岩诀',el:'lava',spells:['熔符「地火」','熔符「岩浆潮」']},poison:{name:'万毒经',el:'poison',spells:['毒符「瘴雾」','毒符「蛊潮」']},
};
export const TECH_PRICE=50;
// 主修功法的日常加成（只有主修那一部生效；主修每天只能换一次）
export const TECH_BUFF={fire:'炼丹出炉 +1 颗（良品及以上）',water:'水壶容量 +10',wood:'作物生长快 20%',metal:'卖药材多得 15% 灵石',earth:'锄地只耗 1 点灵力',
 ice:'打坐修为 +20%',thunder:'斗法胜利修为 ×1.5',wind:'灵力恢复快 25%',lava:'斗法胜利灵石 +30%',poison:'培元丹药园经验 +50%，回灵丹多回 10 点'};
// 功法层数：用这部功法每赢一场斗法 +1 熟练；层数 = 1 + ⌊√(熟练/2)⌋，最高 9 层
export const techLayer=(x,el=x.tech)=>el?Math.min(9,1+Math.floor(Math.sqrt((x.tm?.[el]||0)/2))):0;
export const layerNeed=L=>2*L*L; // 到第 L+1 层要的熟练
export const techPerks=L=>({power:1+.06*(L-1),bombs:2+(L>=3)+(L>=9),lives:3+(L>=6)});
export const canMax=x=>CAN_MAX+(x.tech==='water'?10:0);
export const techEff=x=>x.roots&&x.roots.e.length+x.roots.v.length===1?1.5:1;
export const powerOf=x=>(1+.3*(x.cv?.r||0)+.03*((x.cv?.s||1)-1))*techEff(x)*techPerks(techLayer(x)).power;
// 斗法关卡：min=服务端认可的最短通关秒数；need=大境界要求
export const STAGES={duel:{name:'切磋',min:40,stone:15,need:0,spells:2},secret:{name:'秘境竹林',min:70,stone:40,need:0,spells:3},demon:{name:'魔窟',min:100,stone:90,need:1,spells:4},sword:{name:'葬剑山',min:100,stone:150,need:2,spells:4}};
export const FIGHT_DAILY=8,FIGHT_COST=10;
export const STORY_END=4;
export function newXs(now){
 return {v:XS_VERSION,en:EN_MAX,enAt:now,stone:100,can:CAN_MAX,lv:1,xp:0,
  plots:Array.from({length:PLOTS},(_,i)=>i===14?{s:'soil',c:'lingcao',g:3,w:0}:i===15?{s:'soil',c:'lingcao',g:1,w:0}:({s:i<START_OPEN?'soil':'weed'})),
  seeds:{lingcao:6},bag:{},log:0,st:0,root:null,hv:0,pills:{},brew:null,dp:null,roots:null,cv:{r:0,s:1,xp:0},med:null,techs:[],tech:null,fight:null,df:null,clear:{}};
}
// 灵力随时间恢复；作物按浇水时间推进（每浇一次长一阶，长好后要再浇）
export function tick(x,now){
 const RG=x.tech==='wind'?EN_REGEN*.75:EN_REGEN;
 if(x.en<EN_MAX){const n=Math.floor((now-x.enAt)/RG);if(n>0){x.en=Math.min(EN_MAX,x.en+n);x.enAt=x.en>=EN_MAX?now:x.enAt+n*RG}}else x.enAt=now;
 for(const p of x.plots){if(!p.c||p.g>=3||!p.w)continue;const H=HERBS[p.c];if(now-p.w>=H.grow*(x.tech==='wood'?.8:1)){p.g++;p.w=0}}
 return x;
}
export function plotView(p,now){if(!p.c)return {...p};const H=HERBS[p.c];return {...p,left:p.w&&p.g<3?Math.max(0,H.grow-(now-p.w)):0}}
const xpNeed=lv=>40*lv*lv;
const fail=msg=>({ok:false,msg});
// a: {a:'hoe'|'plant'|'water'|'harvest'|'refill'|'buy'|'sell', i?, herb?, n?}
export function act(x,a,now,rand=Math.random){
 tick(x,now);const cost=a?.a==='hoe'&&x.tech==='earth'?1:COST[a?.a];if(cost===undefined)return fail('未知操作');
 if(x.en<cost)return fail('灵力不足，歇一会儿再来');
 const P=PILLS[a.herb];x.pills||={};
 const p=Number.isInteger(a.i)&&a.i>=0&&a.i<PLOTS?x.plots[a.i]:null,H=HERBS[a.herb];
 let out={ok:true};
 switch(a.a){
  case 'hoe':if(!p)return fail('选一块田');if(p.s==='soil'&&!p.c)return fail('这块田已经松好了');if(p.c&&p.g<3&&!p.dead)return fail('田里还长着'+HERBS[p.c].name);
   x.plots[a.i]={s:'soil'};out.msg='锄好了一块田';break;
  case 'plant':if(!p)return fail('选一块田');if(!H)return fail('选一种种子');if(p.s!=='soil'||p.c)return fail(p.s==='weed'?'先用锄头除草':'这块田已经种上了');
   if((x.seeds[a.herb]||0)<1)return fail(H.name+'种子用完了');if(H.lv>x.lv)return fail(H.name+'需要 '+H.lv+' 级药园');
   x.seeds[a.herb]--;x.plots[a.i]={s:'soil',c:a.herb,g:0,w:0};out.msg='种下'+H.name;break;
  case 'water':if(!p?.c)return fail('这里没有种东西');if(p.g>=3)return fail('已经成熟，可以收了');if(p.w)return fail('已经浇过水了');if(x.can<1)return fail('水壶空了，去灵泉井打水');
   x.can--;p.w=now;out.msg='浇好了';break;
  case 'harvest':{if(!p?.c||p.g<3)return fail('还没成熟');const k=p.c,n=1+(x.log%4===3?1:0);x.bag[k]=(x.bag[k]||0)+n;x.hv=(x.hv||0)+1;x.plots[a.i]={s:'soil'};out={ok:true,msg:'收获 '+HERBS[k].name+' ×'+n,herb:k,n};gain(x,HERBS[k].lv*4,out);break}
  case 'root':{if(x.st!==1||x.roots)return fail('灵根已测过');if(!ROOTS[a.el])return fail('没有这种灵根');let k=rand()*100,n=1;for(const[c,w]of ROOT_WEIGHT){if(k<w){n=c;break}k-=w}
   const rest=Object.keys(ROOTS).filter(e=>e!==a.el),e=[a.el];while(e.length<n)e.push(rest.splice(Math.floor(rand()*rest.length),1)[0]);x.roots={e,v:[]};x.root=a.el;out.msg=e.map(k=>ROOTS[k]).join('')+'灵根';out.roots=e;break}
  case 'sit':if(!x.roots)return fail('还没测灵根');if(x.med)return fail('已经在打坐');x.med={t:now};out.msg='入定';break;
  case 'rise':{if(!x.med)return fail('没有在打坐');const d=Math.min(now-x.med.t,MED_MAX);x.med=null;if(d<MED_MIN){out.msg='心神未定，这次没有收获';out.gainCv=0;break}
   const g=Math.floor(d/60*10*rootMult(x)*(x.tech==='ice'?1.2:1));x.cv.xp+=g;while(x.cv.s<9&&x.cv.xp>=cvNeed(x.cv.r,x.cv.s)){x.cv.xp-=cvNeed(x.cv.r,x.cv.s);x.cv.s++;out.lvUp2=REALMS[x.cv.r]+x.cv.s+'层'}
   out.msg='修为 +'+g;out.gainCv=g;break}
  case 'break':{const c=x.cv,need=c.r+1;if(c.s<9||c.xp<cvNeed(c.r,9))return fail('修为未满，还不能突破');if(c.r>=REALMS.length-1)return fail('已至大乘之巅');if((x.pills.peiyuan||0)<need)return fail('突破需要培元丹 ×'+need);
   x.pills.peiyuan-=need;if(!x.pills.peiyuan)delete x.pills.peiyuan;if(rand()<.6){c.r++;c.s=1;c.xp=0;out.msg='突破成功！进入'+REALMS[c.r];out.realm=c.r}else{c.xp=Math.floor(c.xp*.7);out.msg='突破失败，修为受损';out.failBreak=1}break}
  case 'fuse':{const r=x.roots;if(!r)return fail('还没测灵根');if((x.cv.r||0)<1)return fail('筑基之后才能融合灵根');const [e1,e2]=String(a.el||'').split('+'),F=FUSIONS[fuseKey(e1,e2)];
   if(!F||!r.e.includes(e1)||!r.e.includes(e2))return fail('这两种灵根无法融合');if(x.fuseCd>now)return fail('灵根还在震荡，明日再试');if((x.pills.peiyuan||0)<2||x.stone<200)return fail('融合需要培元丹 ×2、灵石 200');
   x.pills.peiyuan-=2;if(!x.pills.peiyuan)delete x.pills.peiyuan;x.stone-=200;if(rand()<.55){r.e=r.e.filter(e=>e!==e1&&e!==e2);r.v.push(F.id);out.msg='融合成功：'+F.name+'灵根';out.fused=F.id}else{x.cv.xp=Math.floor(x.cv.xp*.8);x.fuseCd=now+86400;out.msg='融合失败，灵根震荡（修为受损，一日后可再试）';out.failFuse=1}break}
  case 'story':{const n=a.n|0;if(n!==(x.st||0)+1||n>STORY_END)return fail('剧情进度不符');if(n===2&&!x.root)return fail('还没测灵根');if(n===3&&!(x.hv>=1))return fail('还没收获过');
   x.st=n;out.msg='剧情推进';if(n===4){x.stone+=30;x.seeds.jingu=(x.seeds.jingu||0)+3;out.msg='获得 灵石 30、金菇种子 ×3'}break}
  case 'brew':{if(!P)return fail('没有这张丹方');if(x.brew)return fail('炉里还有一炉丹');for(const[k,n]of Object.entries(P.need))if((x.bag[k]||0)<n)return fail(HERBS[k].name+'不够（要 '+n+'）');
   for(const[k,n]of Object.entries(P.need)){x.bag[k]-=n;if(!x.bag[k])delete x.bag[k]}x.brew={p:a.herb,t:now};out.msg='起炉：'+P.name;break}
  case 'finish':{if(!x.brew)return fail('炉里没有丹');const d=now-x.brew.t;if(d<BREW_MIN)return fail('火候未到');const k=x.brew.p,q=d>BREW_MAX?0:Math.max(0,Math.min(2,a.n|0)),n=1+q+(x.tech==='fire'&&q>=1?1:0);
   x.pills[k]=(x.pills[k]||0)+n;x.brew=null;out={ok:true,msg:'出炉 '+QUALITY[q]+PILLS[k].name+' ×'+n,pill:k,n,q};gain(x,6+q*4,out);break}
  case 'use':{if(!P||(x.pills[a.herb]||0)<1)return fail('没有这种丹药');if(a.herb==='huiling'){const d=xsDay(now);if(x.dp?.d!==d)x.dp={d,n:0};if(x.dp.n>=PILL_DAILY)return fail('今日丹毒已满，明日再服');if(x.en>=EN_MAX)return fail('灵力是满的');x.dp.n++;x.en=Math.min(EN_MAX,x.en+30+(x.tech==='poison'?10:0));if(x.en>=EN_MAX)x.enAt=now}
   else gain(x,x.tech==='poison'?60:40,out);x.pills[a.herb]--;if(!x.pills[a.herb])delete x.pills[a.herb];out.msg='服下'+P.name;break}
  case 'learn':{const T=TECHS[a.el];if(!T)return fail('没有这部功法');const r=x.roots;if(!r)return fail('还没测灵根');if(!r.e.includes(a.el)&&!r.v.includes(a.el))return fail('灵根不合，修不了'+T.name);
   x.techs||=[];if(x.techs.includes(a.el))return fail('已经学会了');if(x.stone<TECH_PRICE)return fail('灵石不够（要 '+TECH_PRICE+'）');x.stone-=TECH_PRICE;x.techs.push(a.el);x.tech||=a.el;out.msg='习得 '+T.name;break}
  case 'equip':{if(!(x.techs||[]).includes(a.el))return fail('还没学会');if(x.tech===a.el)return fail('已经在主修了');const d=xsDay(now);if(x.te===d)return fail('今天已经换过主修，明日再换');x.te=d;x.tech=a.el;out.msg='主修 '+TECHS[a.el].name;break}
  case 'fight':{const S=STAGES[a.herb];if(!S)return fail('没有这处战场');if(!x.tech)return fail('先去藏经阁学一部功法');if((x.cv?.r||0)<S.need)return fail(S.name+'需要'+REALMS[S.need]+'修为');if(x.fight&&now-x.fight.t<1800)return fail('上一场还没打完');
   const d=xsDay(now);if(x.df?.d!==d)x.df={d,n:0};if(x.df.n>=FIGHT_DAILY)return fail('今日斗法次数已满');x.df.n++;x.fight={s:a.herb,t:now,...(a.herb==='duel'&&typeof a.el==='string'?{npc:a.el.slice(0,24)}:{})};out.msg='进入'+S.name;break}
  case 'win':{const f=x.fight;if(!f)return fail('没有在斗法');const S=STAGES[f.s],d=now-f.t;if(d<S.min)return fail('战斗时间不足，结果作废');x.fight=null;if(d>1800)return fail('战斗超时');
   let cap=Math.max(0,Math.min(S.spells,a.n|0)),stone=S.stone+cap*5;
   if(f.s==='duel'){const d=xsDay(now);if(x.dd?.d!==d)x.dd={d,w:[]};if(x.dd.w.includes(f.npc)){stone=0;cap=0}else x.dd.w.push(f.npc)}
   if(x.tech==='lava')stone=Math.floor(stone*1.3);if(x.tech){x.tm||={};const L0=techLayer(x);x.tm[x.tech]=(x.tm[x.tech]||0)+1;const L1=techLayer(x);if(L1>L0)out.layer=L1}
   x.stone+=stone;out={...out,ok:true,msg:stone?'胜！灵石 +'+stone:'胜！（今天已经赢过这位，没有奖励）',stone,cap};if(f.s!=='duel'&&!x.clear[f.s]){x.clear[f.s]=1;x.pills.peiyuan=(x.pills.peiyuan||0)+1;out.first=1;out.msg+='，首胜奖励培元丹 ×1'}
   const g=Math.floor(15*rootMult(x)*(x.tech==='thunder'?1.5:1));x.cv.xp+=g;out.gainCv=g;if(out.layer)out.msg+='；'+TECHS[x.tech].name+'突破至第 '+out.layer+' 层';break}
  case 'lose':if(!x.fight)return fail('没有在斗法');x.fight=null;out.msg='败退';break;
  case 'refill':if(x.can>=canMax(x))return fail('水壶是满的');x.can=canMax(x);out.msg='水壶打满了';break;
  case 'buy':{const n=a.n|0;if(!H)return fail('没有这种种子');if(n<1||n>10)return fail('一次买 1–10 包');if(H.lv>x.lv)return fail('需要 '+H.lv+' 级药园');if(x.stone<H.seed*n)return fail('灵石不够');
   x.stone-=H.seed*n;x.seeds[a.herb]=(x.seeds[a.herb]||0)+n;out.msg='买了 '+H.name+'种子 ×'+n;break}
  case 'sell':{const n=a.n|0;if(!H)return fail('没有这种药材');if(n<1||n>99||(x.bag[a.herb]||0)<n)return fail('药材数量不够');
   x.bag[a.herb]-=n;if(!x.bag[a.herb])delete x.bag[a.herb];const got=Math.floor(H.sell*n*(x.tech==='metal'?1.15:1));x.stone+=got;out.msg='卖出 '+H.name+' ×'+n+'，得灵石 '+got;break}
 }
 if(cost){if(x.en>=EN_MAX)x.enAt=now;x.en-=cost}x.log++;return out;
}
function gain(x,n,out){x.xp+=n;while(x.lv<5&&x.xp>=xpNeed(x.lv)){x.xp-=xpNeed(x.lv);x.lv++;out.lvUp=x.lv}}
export const LV_NEED=xpNeed;
