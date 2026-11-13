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
export const COST={hoe:3,plant:1,water:1,harvest:2,refill:0,buy:0,sell:0,story:0,root:0,brew:5,finish:0,use:0,sit:0,rise:0,break:0,fuse:0,learn:0,equip:0,fight:10,win:0,lose:0,talk:0,gift:0,chap:0,evroll:0,evpick:0,tasks:0,task:0,stipend:0,slots:0,peek:0,ab:0,rin:0,rgo:0,rbuy:0,rout:0};
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
 const r2=act2(x,a,now,rand);if(r2){if(r2.ok&&x.en>=EN_MAX)x.enAt=now;return r2}
 const r3=act3(x,a,now);if(r3){if(r3.ok)x.log++;return r3}
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
   const g=Math.floor(d/60*10*rootMult(x)*(x.tech==='ice'?1.2:1)*medBonus(x));x.cv.xp+=g;while(x.cv.s<9&&x.cv.xp>=cvNeed(x.cv.r,x.cv.s)){x.cv.xp-=cvNeed(x.cv.r,x.cv.s);x.cv.s++;out.lvUp2=REALMS[x.cv.r]+x.cv.s+'层'}
   out.msg='修为 +'+g;out.gainCv=g;break}
  case 'break':{const c=x.cv,need=c.r+1;if(c.s<9||c.xp<cvNeed(c.r,9))return fail('修为未满，还不能突破');if(c.r>=REALMS.length-1)return fail('已至大乘之巅');if((x.pills.peiyuan||0)<need)return fail('突破需要培元丹 ×'+need);
   x.pills.peiyuan-=need;if(!x.pills.peiyuan)delete x.pills.peiyuan;if(rand()<breakRate(x)){c.r++;c.s=1;c.xp=0;x.mind=Math.min(100,xsMind(x)+5);out.msg='突破成功！进入'+REALMS[c.r];out.realm=c.r}else{c.xp=Math.floor(c.xp*.7);x.mind=Math.max(0,xsMind(x)-8);out.msg='突破失败，修为受损，心境 −8';out.failBreak=1}break}
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
   if(x.tech==='lava')stone=Math.floor(stone*1.3);if(Object.values(x.npc||{}).some(v=>v[1]===3))stone=Math.floor(stone*1.1);{const dd=xsDay(now);x.tw=x.tw?.d===dd?x.tw:{d:dd,n:0};x.tw.n++}if(x.tech){x.tm||={};const L0=techLayer(x);x.tm[x.tech]=(x.tm[x.tech]||0)+1;const L1=techLayer(x);if(L1>L0)out.layer=L1}
   x.stone+=stone;out={...out,ok:true,msg:stone?'胜！灵石 +'+stone:'胜！（今天已经赢过这位，没有奖励）',stone,cap};if(f.s!=='duel'&&!x.clear[f.s]){x.clear[f.s]=1;x.pills.peiyuan=(x.pills.peiyuan||0)+1;out.first=1;out.msg+='，首胜奖励培元丹 ×1'}
   const g=Math.floor(15*rootMult(x)*(x.tech==='thunder'?1.5:1));x.cv.xp+=g;out.gainCv=g;if(out.layer)out.msg+='；'+TECHS[x.tech].name+'突破至第 '+out.layer+' 层';if(f.rlm)rlmDm(x,true,out);break}
  case 'lose':{if(!x.fight)return fail('没有在斗法');const rf=x.fight.rlm;x.fight=null;out.msg='败退';if(rf)rlmDm(x,false,out);break}
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

// ================= 修仙 2.0 · 第一批：人脉（好感/赠礼/往事）、机缘、宗门任务与心境气运 =================
// 文本在前端 content2.js；这里只放服务端要校验的条件与数值。存档字段：mind 心境 / luck 气运 / npc 人脉 / ev 机缘 / tk 任务 / rep 声望 / ctb 贡献 / sp 俸禄日 / ch 今日已叙话
export const NEW_NPCS={steward:'外门执事',apothecary:'丹房药师',keeper:'剑冢守墓人',demon:'魔修少年',merchant:'散修商人',fox:'狐妖少女',senior:'大师姐',ancestor:'闭关老祖'};
export const REL=['','师父','道侣','结拜','仇人'],REL_BONUS={1:'打坐修为 +10%',2:'打坐修为 +15%',3:'斗法灵石 +10%',4:'会在秘境里找你麻烦（秘境开放后）'};
export const FAV_TIER=[0,100,300,600,900],FAV_NAME=['陌生','熟识','好友','挚友','知己'];
export const favTier=f=>FAV_TIER.filter(t=>f>=t).length-1;
export const SECT_RANK=[[0,'外门弟子',10],[200,'内门弟子',25],[800,'真传弟子',50],[2000,'长老',90]];
export const sectRank=x=>{let k=0;SECT_RANK.forEach(([r],i)=>{if((x.rep||0)>=r)k=i});return k};
// 送礼偏好：喜欢 +40、普通 +15、讨厌 −10（每人每天一次）。可以送药材或丹药。
export const PREF={'52d':[['lingcao','huiling'],['leizhu']],sup:[['linglan','peiyuan'],['chizhi']],wheat:[['lingcao','jingu'],['huiling']],egg:[['chizhi','binglian'],['lingcao']],
 iron:[['leizhu','jingu'],['linglan']],water:[['binglian','peiyuan'],['jingu']],lafish:[['chizhi','leizhu'],['binglian']],castle:[['binglian','linglan'],['chizhi']],
 flower:[['linglan','lingcao'],['leizhu']],whitebird:[['jingu','lingcao'],['peiyuan']],fox:[['huiling','linglan'],['leizhu']],senior:[['peiyuan','binglian'],['lingcao']],
 merchant:[['leizhu','chizhi'],[]],demon:[['chizhi','leizhu'],['linglan']],keeper:[['binglian'],['huiling']],apothecary:[['linglan','chizhi'],[]],steward:[['jingu'],[]]};
// 往事（个人故事线）：need={fav,r 大境界}；每章 2 个抉择，效果由服务端按表执行
export const CHAPTERS={
 '52d':[{need:{fav:100},opt:[{fav:30,mind:5},{fav:60,luck:5}]},{need:{fav:300,r:1},opt:[{stone:50,luck:5},{fav:80,mind:10}]}],
 sup:[{need:{fav:100},opt:[{fav:40,mind:5},{fav:-20,luck:10}]},{need:{fav:300,r:1},opt:[{fav:50,pill:{peiyuan:1}},{luck:15,mind:-5}]}],
 wheat:[{need:{fav:100},opt:[{fav:40,mind:10},{fav:20,mind:5,luck:3}]},{need:{fav:300},opt:[{fav:-30,luck:10},{fav:80,mind:10,seed:{binglian:2}}]}],
 egg:[{need:{fav:100},opt:[{fav:30,pill:{huiling:2}},{fav:40,mind:5}]},{need:{fav:300,r:1},opt:[{cv:60,mind:-5},{fav:80,pill:{peiyuan:1}}]}],
 iron:[{need:{fav:100},opt:[{fav:30,luck:5},{fav:50,mind:5}]},{need:{fav:300,r:1},opt:[{fav:80,mind:10},{fav:20,stone:80}]}],
 water:[{need:{fav:100},opt:[{fav:-20,luck:10,stone:30},{fav:60,mind:-5}]},{need:{fav:300},opt:[{fav:50,rel:3},{mind:5,fav:10}]}],
 lafish:[{need:{fav:100},opt:[{fav:50,luck:5,en:-10},{fav:30,favOf:{water:-10}}]},{need:{fav:300,r:1},opt:[{stone:60,mind:-5},{fav:40,mind:10}]}],
 castle:[{need:{fav:100},opt:[{fav:60,mind:10},{fav:30,luck:5}]},{need:{fav:300,r:1},opt:[{fav:80,rel:1},{cv:80}]}],
 flower:[{need:{fav:100},opt:[{fav:40,mind:5},{fav:20,cv:40}]},{need:{fav:300,r:1},opt:[{fav:60,rel:3},{fav:40,luck:10}]}],
 whitebird:[{need:{fav:100},opt:[{fav:50,mind:5},{fav:80,luck:5}]},{need:{fav:300},opt:[{mind:15},{fav:60,stone:40}]}],
};
// 机缘：12 个事件（插画 xs-fortune 第 img 张），选项可有条件 need / 消耗 cost；结果按概率 rolls，气运越高越容易出前面的好结果
export const EVENTS=[
 {id:'relic',img:0,who:'ancestor',opt:[{rolls:[[.6,{cv:80,mind:5}],[.4,{cv:20,mind:-10}]]},{rolls:[[1,{luck:8,mind:5}]]}]},
 {id:'fox',img:1,who:'fox',opt:[{cost:{pill:{huiling:1}},rolls:[[1,{favOf:{fox:100},luck:10}]]},{rolls:[[1,{mind:-5}]]},{rolls:[[.5,{favOf:{fox:50}}],[.5,{herb:{lingcao:3}}]]}]},
 {id:'scroll',img:2,who:'merchant',opt:[{cost:{stone:40},rolls:[[.6,{tm:3,favOf:{merchant:20}}],[.4,{mind:-5,luck:5}]]},{rolls:[[1,{favOf:{merchant:5}}]]}]},
 {id:'thunder',img:3,who:null,opt:[{rolls:[[.5,{luck:10,cv:50}],[.5,{en:-10,mind:-5}]]},{rolls:[[1,{mind:10}]]}]},
 {id:'quarrel',img:4,who:'demon',opt:[{rolls:[[1,{mind:5,rep:20}]]},{rolls:[[1,{rep:30,favOf:{demon:-60}}]]},{rolls:[[1,{favOf:{demon:60},rep:-10}]]}]},
 {id:'crane',img:5,who:'apothecary',opt:[{rolls:[[1,{en:30}]]},{cost:{herb:{lingcao:2}},rolls:[[1,{luck:10,pill:{huiling:1},favOf:{apothecary:30}}]]}]},
 {id:'array',img:6,who:'senior',opt:[{need:{r:1},rolls:[[.6,{favOf:{senior:80},stone:40}],[.4,{mind:-10}]]},{rolls:[[1,{favOf:{senior:20},rep:10}]]}]},
 {id:'meteor',img:7,who:null,opt:[{rolls:[[1,{stone:60}]]},{rolls:[[1,{favOf:{iron:60},mind:5}]]}]},
 {id:'drunk',img:8,who:'keeper',opt:[{rolls:[[.5,{cv:60,mind:5}],[.5,{en:-20}]]},{rolls:[[1,{favOf:{keeper:50},luck:5}]]}]},
 {id:'snake',img:9,who:null,opt:[{rolls:[[.5,{stone:80}],[.5,{en:-20,mind:-5}]]},{cost:{herb:{jingu:1}},rolls:[[1,{luck:10,stone:30}]]}]},
 {id:'palace',img:10,who:null,opt:[{rolls:[[.4,{pill:{peiyuan:1}}],[.6,{mind:-5}]]},{rolls:[[1,{luck:5,flag:'palace'}]]}]},
 {id:'lotus',img:11,who:null,opt:[{rolls:[[1,{herb:{binglian:2}}]]},{rolls:[[1,{mind:10,luck:5}]]}]},
];
export const EV_DAILY=3,EV_GAP=600,EV_CHANCE=.4;
// 宗门任务：每天 3 条，交差得贡献、声望和灵石
export const TASK_KINDS=[['herb','lingcao',5],['herb','jingu',3],['herb','linglan',2],['pill','huiling',1],['pill','peiyuan',1],['win',null,1],['herb','binglian',1]];
const clampI=(v,a,b)=>Math.max(a,Math.min(b,Math.round(v)));
export const xsMind=x=>x.mind??50,xsLuck=x=>x.luck??0;
export const breakRate=x=>Math.max(.3,Math.min(.9,.6+(xsMind(x)-50)/250+xsLuck(x)/500));
export const medBonus=x=>{let k=.8+xsMind(x)/250;for(const v of Object.values(x.npc||{})){if(v[1]===1)k*=1.1;else if(v[1]===2)k*=1.15}return k};
const npcRow=(x,id)=>{x.npc||={};return x.npc[id]||=[0,0,0,0]};
function applyEff(x,e,who,out){const r=x.cv?.r||0,sc=1+.5*r,msgs=[];
 if(e.fav&&who){const v=npcRow(x,who);v[0]=clampI(v[0]+e.fav,-500,1000);msgs.push('好感'+(e.fav>0?'+':'')+e.fav)}
 if(e.favOf)for(const[id,n]of Object.entries(e.favOf)){const v=npcRow(x,id);v[0]=clampI(v[0]+n,-500,1000);if(v[0]<=-100&&!v[1])v[1]=4;msgs.push((NEW_NPCS[id]||id)+'好感'+(n>0?'+':'')+n)}
 if(e.mind){x.mind=clampI(xsMind(x)+e.mind,0,100);msgs.push('心境'+(e.mind>0?'+':'')+e.mind)}
 if(e.luck){x.luck=clampI(xsLuck(x)+e.luck,-50,50);msgs.push('气运'+(e.luck>0?'+':'')+e.luck)}
 if(e.stone){const s=Math.round(e.stone*sc);x.stone+=s;msgs.push('灵石 +'+s)}
 if(e.cv){const g=Math.round(e.cv*sc);x.cv.xp+=g;while(x.cv.s<9&&x.cv.xp>=cvNeed(x.cv.r,x.cv.s)){x.cv.xp-=cvNeed(x.cv.r,x.cv.s);x.cv.s++}msgs.push('修为 +'+g)}
 if(e.en){x.en=clampI(x.en+e.en,0,EN_MAX);msgs.push('灵力'+(e.en>0?'+':'')+e.en)}
 if(e.rep){x.rep=Math.max(0,(x.rep||0)+e.rep);msgs.push('声望'+(e.rep>0?'+':'')+e.rep)}
 if(e.tm&&x.tech){x.tm||={};x.tm[x.tech]=(x.tm[x.tech]||0)+e.tm;msgs.push('功法熟练 +'+e.tm)}
 for(const[k,n]of Object.entries(e.pill||{})){x.pills[k]=(x.pills[k]||0)+n;msgs.push(PILLS[k].name+' ×'+n)}
 for(const[k,n]of Object.entries(e.herb||{})){x.bag[k]=(x.bag[k]||0)+n;msgs.push(HERBS[k].name+' ×'+n)}
 for(const[k,n]of Object.entries(e.seed||{})){x.seeds[k]=(x.seeds[k]||0)+n;msgs.push(HERBS[k].name+'种子 ×'+n)}
 if(e.rel&&who){for(const v of Object.values(x.npc))if(v[1]===e.rel&&(e.rel===1||e.rel===2))v[1]=0;npcRow(x,who)[1]=e.rel;msgs.push('结为'+REL[e.rel])}
 if(e.flag){x.flag||=[];if(!x.flag.includes(e.flag))x.flag.push(e.flag)}
 out.eff=msgs;return msgs}
function payCost(x,c){for(const[k,n]of Object.entries(c.pill||{}))if((x.pills[k]||0)<n)return PILLS[k].name+'不够';for(const[k,n]of Object.entries(c.herb||{}))if((x.bag[k]||0)<n)return HERBS[k].name+'不够';if(c.stone&&x.stone<c.stone)return '灵石不够';
 for(const[k,n]of Object.entries(c.pill||{})){x.pills[k]-=n;if(!x.pills[k])delete x.pills[k]}for(const[k,n]of Object.entries(c.herb||{})){x.bag[k]-=n;if(!x.bag[k])delete x.bag[k]}if(c.stone)x.stone-=c.stone;return ''}
export const OLD_NPCS=['52d','fas','melon','duck','rollbin','echo','rainbow','egg','iron','lafish','meow','water','sup','soup','earthcat','wheat','ant','blessing','whitebird','flower','castle'];
const NPC_OK=id=>typeof id==='string'&&(OLD_NPCS.includes(id)||Object.hasOwn(NEW_NPCS,id));
export function act2(x,a,now,rand){
 const fail=msg=>({ok:false,msg}),d=xsDay(now);let out={ok:true};
 switch(a.a){
  case 'talk':{if(!NPC_OK(a.el))return fail('没有这个人');x.ch=x.ch?.d===d?x.ch:{d,ids:[]};if(x.ch.ids.includes(a.el)||x.ch.ids.length>=30)return {ok:true,msg:'',fav:0};x.ch.ids.push(a.el);const v=npcRow(x,a.el);v[0]=clampI(v[0]+5,-500,1000);if(x.ch.ids.length<=3)x.mind=clampI(xsMind(x)+1,0,100);out={ok:true,msg:'好感 +5',fav:5};break}
  case 'gift':{if(!NPC_OK(a.el))return fail('没有这个人');const k=a.herb,isPill=!!PILLS[k];if(!isPill&&!HERBS[k])return fail('送不了这个');const v=npcRow(x,a.el);if(v[3]===d)return fail('今天已经送过礼了');
   const err=payCost(x,isPill?{pill:{[k]:1}}:{herb:{[k]:1}});if(err)return fail(err);const p=PREF[a.el]||[[],[]],g=p[0].includes(k)?40:p[1].includes(k)?-10:15;v[0]=clampI(v[0]+g,-500,1000);v[3]=d;out={ok:true,msg:(g>=40?'很喜欢！':g<0?'似乎不太喜欢……':'收下了。')+'好感'+(g>0?'+':'')+g,fav:g,like:g>=40?1:g<0?-1:0};break}
  case 'chap':{const C=CHAPTERS[a.el],v=npcRow(x,a.el),n=a.n|0,c=C?.[n];if(!c)return fail('没有这段往事');if(v[2]!==n)return fail('往事要按顺序看');
   if(v[0]<(c.need.fav||0))return fail('好感还不够（要'+FAV_NAME[favTier(c.need.fav)]+'）');if((x.cv?.r||0)<(c.need.r||0))return fail('需要'+REALMS[c.need.r]+'修为');
   const e=c.opt[a.i===1?1:0];v[2]=n+1;applyEff(x,e,a.el,out);out.msg='往事 · '+out.eff.join('，');break}
  case 'evroll':{x.ev=x.ev?.d===d?x.ev:{d,n:0,last:0,cur:null};const ev=x.ev;if(ev.cur&&now-ev.cur.t<1800)return {ok:true,ev:ev.cur.id,msg:''};
   if(ev.n>=EV_DAILY||now-ev.last<EV_GAP)return {ok:true,ev:null,msg:''};ev.last=now;if(rand()>EV_CHANCE+xsLuck(x)/500)return {ok:true,ev:null,msg:''};
   const r=x.cv?.r||0,pool=EVENTS.filter(e=>!(e.id==='array'&&r<1)&&!(e.flag&&x.flag?.includes(e.flag)));const E=pool[Math.floor(rand()*pool.length)];ev.n++;ev.cur={id:E.id,t:now,r:Math.round(rand()*1e6)/1e6};out={ok:true,ev:E.id,msg:''};break}
  case 'evpick':{const ev=x.ev,cur=ev?.cur;if(!cur||now-cur.t>1800)return fail('机缘已经散了');const E=EVENTS.find(e=>e.id===cur.id),o=E?.opt[a.i|0];if(!o)return fail('没有这个选项');
   if(o.need?.r&&(x.cv?.r||0)<o.need.r)return fail('修为不足（要'+REALMS[o.need.r]+'）');if(o.cost){const err=payCost(x,o.cost);if(err)return fail(err)}
   let roll=(cur.r??.5)-xsLuck(x)/400,k=0;for(;k<o.rolls.length-1;k++){roll-=o.rolls[k][0];if(roll<0)break}ev.cur=null;applyEff(x,o.rolls[k][1],E.who,out);out.res=k;out.msg=out.eff.join('，')||'什么也没发生';break}
  case 'tasks':{if(x.tk?.d===d)return {ok:true,msg:''};const pool=TASK_KINDS.map((t,i)=>i).filter(i=>!(TASK_KINDS[i][0]==='herb'&&HERBS[TASK_KINDS[i][1]].lv>(x.lv||1)+1));const list=[];
   while(list.length<3&&pool.length){const i=pool.splice(Math.floor(rand()*pool.length),1)[0];list.push([i,0])}x.tk={d,list};out.msg='今日委托已更新';break}
  case 'task':{const t=x.tk?.d===d?x.tk.list[a.n|0]:null;if(!t)return fail('没有这条委托');if(t[1])return fail('已经交过了');const[kind,key,n]=TASK_KINDS[t[0]];
   if(kind==='win'){if(!(x.tw?.d===d&&x.tw.n>=n))return fail('今天还没有赢过斗法')}else{const err=payCost(x,kind==='pill'?{pill:{[key]:n}}:{herb:{[key]:n}});if(err)return fail(err)}
   t[1]=1;const rw=kind==='win'?30:kind==='pill'?40:20+n*4;x.ctb=(x.ctb||0)+rw;applyEff(x,{rep:rw,stone:Math.round(rw/2),favOf:{steward:5}},null,out);out.msg='委托完成：贡献 +'+rw+'，'+out.eff.join('，');break}
  case 'stipend':{if(x.sp===d)return fail('今天的俸禄领过了');x.sp=d;const g=SECT_RANK[sectRank(x)][2];x.stone+=g;out.msg=SECT_RANK[sectRank(x)][1]+'俸禄：灵石 +'+g;break}
  default:return null;
 }
 x.log++;return out;
}
// ===================== xs2-b：自动对战 + 秘境（前后端共用；所有结果由种子确定，服务端照算一遍） =====================
export const WHEEL={metal:'wood',wood:'earth',earth:'water',water:'fire',fire:'metal'}; // 金克木 木克土 土克水 水克火 火克金
export const EL_NAME={metal:'金',wood:'木',water:'水',fire:'火',earth:'土',ice:'冰',thunder:'雷',wind:'风',lava:'熔',poison:'毒'};
const SK_U={fire:{dmg:5,burn:[3,5]},water:{heal:24},wood:{dmg:4,stun:1.6},metal:{dmg:15,pierce:1,cast:1.1,cd:5},earth:{shield:30,cd:9},ice:{dmg:6,slow:5},thunder:{dmg:8,intr:1,cast:.4,cd:6},wind:{dmg:9,cast:.3,cd:2.4},lava:{dmg:10,burn:[4,4]},poison:{burn:[5,6],cast:.7}};
const SK_B={thunder:{intr:1},ice:{slow:4},lava:{burn:[3,4]},poison:{burn:[3,5]},wind:{cast:1.2},metal:{pierce:1}};
export function skill(id){
 if(id==='bolt')return {id,n:'灵弹',el:null,cast:.6,cd:1.2,dmg:7};
 if(id==='guard')return {id,n:'护体金光',el:null,cast:.8,cd:10,shield:22};
 if(typeof id!=='string')return null;const el=id.slice(0,-1),k=id.slice(-1),T=TECHS[el];if(!T||(k!=='1'&&k!=='2'))return null;
 return k==='1'?{id,n:T.spells[0],el,cast:1.8,cd:6,dmg:26,...SK_B[el]}:{id,n:T.spells[1],el,cast:.9,cd:4,...SK_U[el]};
}
export const skillsOf=x=>['bolt','guard',...(x.techs||[]).flatMap(e=>[e+'1',e+'2'])];
export function mySlots(x){const ok=skillsOf(x),s=x.sl;if(Array.isArray(s)&&s.length===4&&new Set(s).size===4&&s.every(i=>ok.includes(i)))return s.slice();return x.tech?[x.tech+'1',x.tech+'2','bolt','guard']:null}
export const myHp=x=>100+60*(x.cv?.r||0)+5*((x.cv?.s||1)-1);
export function hseed(...a){let h=2166136261;for(const ch of a.join('|')){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
export function rng(s){s|=0;return()=>{s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
// 同门 NPC 的属性与等级（与 content.js 一致；新人物见 NEW_NPCS）
export const NPC_FIGHT={'52d':['earth',3],fas:['metal',6],melon:['water',4],duck:['water',5],rollbin:['earth',13],echo:['wind',5],rainbow:['thunder',8],egg:['fire',8],iron:['metal',12],lafish:['fire',15],meow:['wood',7],water:['water',14],sup:['wind',18],soup:['earth',9],earthcat:['earth',10],wheat:['earth',10],ant:['thunder',16],blessing:['water',9],whitebird:['wind',11],flower:['wood',17],castle:['ice',19],
 steward:['earth',6],apothecary:['wood',7],keeper:['metal',14],demon:['poison',11],merchant:['metal',5],fox:['fire',9],senior:['water',16],ancestor:['thunder',30]};
const slotsFor=(el,key)=>{const b=[el+'1',el+'2','bolt','guard'],h=hseed(key)%4;return h?[...b.slice(h),...b.slice(0,h)].sort((a,c)=>(a===el+'1'?-1:c===el+'1'?1:0)):b};
export function npcFighter(id){const v=NPC_FIGHT[id];if(!v)return null;const[el,lv]=v;return {k:'npc',id,el,pw:+(.7+.06*lv).toFixed(2),hp:90+10*lv,mx:90+10*lv,sl:slotsFor(el,id)}}
export function meFighter(x,mul=1){const mx=Math.round(myHp(x)*mul);return {k:'me',el:x.tech,pw:+powerOf(x).toFixed(3),hp:mx,mx,sl:mySlots(x)}}
// 60 秒确定性模拟：每 0.1 秒一跳；按技能槽顺序找第一个冷却好的技能读条；被克制方伤害 −25%、读条 +20%
export function sim(A,B,seed,trace=false){
 const R=rng(seed),F=[A,B].map(f=>({...f,hp:Math.min(f.hp,f.mx),sh:0,cast:null,cd:[0,0,0,0],slow:0,stun:0,dot:[]})),log=[],DT=.1;
 const ctr=i=>WHEEL[F[1-i].el]===F[i].el,tr=trace?[]:null,snap=()=>tr&&tr.push([...F.map(f=>Math.max(0,Math.round(f.hp))),...F.map(f=>Math.max(0,Math.round(f.sh)))]);let k=0;
 for(;k<600;k++){snap();
  for(const f of F){for(const d of f.dot){f.hp-=d[0]*DT;d[1]-=DT}f.dot=f.dot.filter(d=>d[1]>1e-9)}
  if(F[0].hp<=0||F[1].hp<=0)break;
  for(let i=0;i<2;i++){const f=F[i],o=F[1-i];for(let j=0;j<4;j++)f.cd[j]-=DT;f.slow-=DT;if(f.stun>0){f.stun-=DT;continue}
   if(f.cast){f.cast.t-=DT;if(f.cast.t>1e-9)continue;const j=f.cast.j,S=skill(f.sl[j]);f.cast=null;f.cd[j]=S.cd;const ev=[k,i,j,0,0];
    if(S.dmg){let d=S.dmg*f.pw*(ctr(i)?.75:1)*(.9+.2*R());if(R()<.1){d*=1.5;ev[4]=1}d=Math.round(d);if(!S.pierce&&o.sh>0){const ab=Math.min(o.sh,d);o.sh-=ab;d-=ab;if(ab)ev[4]|=4}o.hp-=d;ev[3]=d}
    if(S.burn)o.dot.push([S.burn[0]*f.pw,S.burn[1]]);if(S.heal){const h=Math.round(S.heal*f.pw);f.hp=Math.min(f.mx,f.hp+h);ev[3]=-h}
    if(S.shield)f.sh=Math.round(S.shield*f.pw);if(S.stun)o.stun=S.stun;if(S.slow)o.slow=S.slow;if(S.intr&&o.cast){o.cast=null;ev[4]|=2}
    log.push(ev);if(o.hp<=0)break;continue}
   for(let j=0;j<4;j++){if(f.cd[j]>0)continue;const S=skill(f.sl[j]);if(S.heal&&f.hp>f.mx*.75)continue;if(S.shield&&f.sh>0)continue;
    f.cast={j,t:S.cast*(ctr(i)?1.2:1)*(f.slow>0?1.4:1)};log.push([k,i,j,-1,Math.round(f.cast.t*10)]);break}}
  if(F[0].hp<=0||F[1].hp<=0)break}
 const hp=F.map(f=>Math.max(0,Math.round(f.hp))),w=F[1].hp<=0&&F[0].hp>0?1:F[0].hp<=0?0:hp[0]/F[0].mx>hp[1]/F[1].mx?1:0;
 snap();return {w,hp,log,end:k,trace:tr}}
// ---------- 秘境 ----------
export const MOBS={bat:{n:'吸血蝠群',el:'wind'},spider:{n:'毒蛛',el:'poison'},fox:{n:'妖狐',el:'fire'},golem:{n:'石傀',el:'earth'},puppet:{n:'木傀儡',el:'wood'},cultist:{n:'魔修',el:'thunder'},swordghost:{n:'剑灵',el:'metal'},
 foxking:{n:'三尾妖狐',el:'fire'},demonlord:{n:'魔修长老',el:'poison'},swordtomb:{n:'剑冢之主',el:'metal'},thunderlord:{n:'雷云老怪',el:'thunder'}};
export const AREAS={bamboo:{n:'竹海迷踪',need:0,pw:.5,hp:45,mobs:['bat','fox','spider','puppet'],boss:'foxking',stage:'secret',herbs:['lingcao','jingu','linglan'],k:0},
 cave:{n:'地火洞窟',need:1,pw:.64,hp:62,mobs:['bat','golem','cultist','spider'],boss:'demonlord',stage:'demon',herbs:['linglan','chizhi'],k:1},
 tomb:{n:'古修洞府',need:2,pw:1.02,hp:100,mobs:['swordghost','puppet','golem','cultist'],boss:'swordtomb',stage:'sword',herbs:['binglian','chizhi'],k:2},
 cloud:{n:'云海仙岛',need:3,pw:1.1,hp:105,mobs:['swordghost','bat','fox','cultist'],boss:'thunderlord',stage:null,herbs:['binglian','leizhu'],k:3}};
export const MATS={xuantie:'玄铁',lingyu:'灵玉',yaodan:'妖丹'};
export const NODES=['fight','elite','boss','chest','spring','event','shop','trap','tele','camp','herb','gate']; // 与 xs-realm-nodes 图集顺序一致
const NODE_W=[['fight',38],['chest',10],['spring',8],['event',14],['shop',6],['trap',8],['camp',6],['herb',10]];
export const RLM_DAILY=3,RLM_EN=15,RLM_MUL=1.5;
export function rlmMap(sd){const R=rng(sd),L=[];for(let l=0;l<3;l++){const rows=[];for(let r=0;r<3;r++){const cols=[1];if(R()<.7)cols.unshift(0);if(R()<.7)cols.push(2);
  rows.push(cols.map(c=>{let p=R()*100,k='fight';for(const[n,w]of NODE_W){if(p<w){k=n;break}p-=w}return {c,k}}))}rows.push([{c:1,k:l<2?'elite':'boss'}]);L.push(rows)}return L}
export const rlmNext=(m,z)=>{const rows=m[z.L];if(z.R>=3)return [];const nx=rows[z.R+1];return z.R<0||z.R===2?nx:nx.filter(n=>Math.abs(n.c-z.c)<=1)};
export function mobFighter(a,kind,mul,sd){const A=AREAS[a],M=MOBS[kind],v=.85+.3*rng(sd)();return {k:'mob',id:kind,el:M.el,pw:+(A.pw*mul*v).toFixed(3),hp:Math.round(A.hp*mul*v),mx:Math.round(A.hp*mul*v),sl:slotsFor(M.el,kind)}}
const lootAdd=(lt,k,id,n)=>{lt[k]||={};lt[k][id]=(lt[k][id]||0)+n};
function rlmBank(x,z,frac,out){const lt=z.lt,got=[];const st=Math.floor((lt.st||0)*frac);if(st){x.stone+=st;got.push('灵石 +'+st)}
 for(const[id,n]of Object.entries(lt.h||{})){const m=Math.floor(n*frac);if(m){x.bag[id]=(x.bag[id]||0)+m;got.push(HERBS[id].name+' ×'+m)}}
 for(const[id,n]of Object.entries(lt.p||{})){const m=Math.floor(n*frac);if(m){x.pills[id]=(x.pills[id]||0)+m;got.push(PILLS[id].name+' ×'+m)}}
 for(const[id,n]of Object.entries(lt.m||{})){const m=Math.floor(n*frac);if(m){x.mat||={};x.mat[id]=(x.mat[id]||0)+m;got.push(MATS[id]+' ×'+m)}}
 out.bank=got;return got}
function rlmEnd(x,win,out,ambLose){const z=x.rlm;x.rlm=null;if(!z)return;const A=AREAS[z.a];
 if(win){const got=rlmBank(x,z,1,out);x.rc||={};if(!x.rc[z.a]){x.rc[z.a]=1;x.pills.peiyuan=(x.pills.peiyuan||0)+2;x.pills.huiling=(x.pills.huiling||0)+2;got.push('首通奖励：培元丹 ×2、回灵丹 ×2');out.first=1}
  out.msg=A.n+' 通关！带回：'+(got.join('、')||'无');out.end='win'}
 else{const got=ambLose?[]:rlmBank(x,z,.5,out);out.msg=(ambLose?'被仇人截杀，这一趟的收获全丢了':'败退出秘境，带回一半收获：'+(got.join('、')||'无'));out.end='lose'}}
function nodeLoot(x,z,kind,R,out){const A=AREAS[z.a],sc=1+.6*A.k,lt=z.lt,msgs=[];const st=n=>{const s=Math.round(n*sc*(.8+.4*R()));lt.st=(lt.st||0)+s;msgs.push('灵石 +'+s)};
 const herb=n=>{const id=A.herbs[Math.floor(R()*A.herbs.length)];lootAdd(lt,'h',id,n);msgs.push(HERBS[id].name+' ×'+n)};
 const mat=n=>{const ks=Object.keys(MATS),id=ks[Math.floor(R()*ks.length)];lootAdd(lt,'m',id,n);msgs.push(MATS[id]+' ×'+n)};
 if(kind==='fight'){st(6);if(R()<.3)herb(1);if(R()<.2)mat(1)}
 else if(kind==='elite'){st(20);mat(1+(R()<.5));if(R()<.3){lootAdd(lt,'p','peiyuan',1);msgs.push('培元丹 ×1')}}
 else if(kind==='boss'){st(50);mat(2+(R()<.5));lootAdd(lt,'p','peiyuan',1);msgs.push('培元丹 ×1')}
 else if(kind==='amb'){st(40)}
 else if(kind==='chest'){st(12);if(R()<.5)mat(1);if(R()<.3)herb(1)}
 else if(kind==='herb')herb(2+(R()<.4));
 out.loot=msgs;return msgs}
// 走到下一个节点：i = 列号；n=1 表示首领亲自出手（弹幕）
function rlmGo(x,a,now,out){const z=x.rlm;if(!z)return '没有在探索秘境';const m=rlmMap(z.sd),nx=rlmNext(m,z),node=nx.find(n=>n.c===(a.i|0));if(!node)return '走不到那里';
 const A=AREAS[z.a];
 if(node.k==='boss'&&a.n===1){if(!A.stage)return '这里只能自动对战';x.fight={s:A.stage,t:now,rlm:1};z.t=now;out.msg='亲自迎战 '+MOBS[A.boss].n;out.danmaku=A.stage;return ''}
 const R=rng(hseed(z.sd,z.L,z.R+1,node.c));z.R++;z.c=node.c;z.v=(z.v||'')+node.c;z.t=now;out.node=node.k;
 if(node.k==='fight'||node.k==='elite'||node.k==='boss'){
  let op,kind=node.k,foe=Object.entries(x.npc||{}).find(([,v])=>v[1]===4);
  if(kind==='fight'&&foe&&!z.amb&&R()<.3&&NPC_FIGHT[foe[0]]){z.amb=1;kind='amb';const nf=npcFighter(foe[0]),e=mobFighter(z.a,A.mobs[0],1.5,hseed(z.sd,'amb'));op={...nf,pw:e.pw,hp:e.hp,mx:e.mx}}
  else op=mobFighter(z.a,kind==='boss'?A.boss:A.mobs[Math.floor(R()*A.mobs.length)],kind==='boss'?1.7:kind==='elite'?1.4:1,hseed(z.sd,z.L,z.R,z.c,'m'));
  const me={...meFighter(x,RLM_MUL),hp:z.hp,mx:z.mx},sd=hseed(z.sd,z.L,z.R,z.c,'b'),res=sim(me,op,sd);out.fight={kind,me,op,sd,w:res.w};
  if(!res.w){z.hp=0;rlmEnd(x,false,out,kind==='amb');return ''}
  z.hp=Math.min(z.mx,res.hp[0]+Math.round(z.mx*.1));nodeLoot(x,z,kind,R,out);
  if(kind==='amb'){x.mind=Math.max(0,Math.min(100,xsMind(x)+5))}
  if(kind==='boss'){rlmEnd(x,true,out);return ''}}
 else if(node.k==='spring'){const h=Math.round(z.mx*.4);z.hp=Math.min(z.mx,z.hp+h);out.heal=h}
 else if(node.k==='camp'){const h=Math.round(z.mx*.3);z.hp=Math.min(z.mx,z.hp+h);out.heal=h;x.mind=Math.min(100,xsMind(x)+2)}
 else if(node.k==='trap'){const d=Math.round(z.mx*(.1+.1*R()));z.hp=Math.max(1,z.hp-d);out.hurt=d}
 else if(node.k==='event'){const p=R()+xsLuck(x)/200,ev=p<.2?0:p<.45?1:p<.7?2:p<.9?3:4;out.ev=ev;
  if(ev===0){const d=Math.round(z.mx*.12);z.hp=Math.max(1,z.hp-d);out.hurt=d}else if(ev===1)x.mind=Math.min(100,xsMind(x)+4);else if(ev===2)nodeLoot(x,z,'herb',R,out);
  else if(ev===3)nodeLoot(x,z,'chest',R,out);else{const g=Math.round(20*(1+A.k)*rootMult(x));x.cv.xp+=g;out.cv=g}}
 else if(node.k==='shop')out.shop=1;
 else nodeLoot(x,z,node.k,R,out);
 if(z.R===3){z.L++;z.R=-1;z.c=1}return ''}
// 首领用弹幕亲自打：win/lose 结算时调用
export function rlmDm(x,win,out){const z=x.rlm;if(!z)return;const o={};if(win){nodeLoot(x,z,'boss',rng(hseed(z.sd,'dm')),o);rlmEnd(x,true,o)}else rlmEnd(x,false,o);out.msg=(out.msg||'')+'；'+o.msg;out.end=o.end;out.bank=o.bank}
export const SHOP=[{n:'回春散（回复一半气血）',st:25,heal:.5},{n:'玄铁',st:80,mat:'xuantie'},{n:'灵玉',st:80,mat:'lingyu'}];
export function act3(x,a,now){const fail=msg=>({ok:false,msg}),d=xsDay(now);let out={ok:true};
 switch(a.a){
  case 'slots':{const ids=String(a.herb||'').split(',');if(ids.length!==4||new Set(ids).size!==4)return fail('要选 4 个不同的技能');const ok=skillsOf(x);if(!ids.every(i=>ok.includes(i)))return fail('还没学会这个技能');x.sl=ids;out.msg='技能槽已保存';break}
  case 'peek':{const op=npcFighter(a.el);if(!op)return fail('没有这个人');if(x.stone<20)return fail('灵石不够（观气要 20）');x.pk=x.pk?.d===d&&x.pk.o===a.el?x.pk:{d,o:a.el,n:0};if(x.pk.n>=4)return fail('已经全看穿了');x.stone-=20;x.pk.n++;out.msg='看穿了对方的「'+skill(op.sl[x.pk.n-1]).n+'」';out.n=x.pk.n;break}
  case 'ab':{const op=npcFighter(a.el);if(!op)return fail('没有这个人');if(!x.tech)return fail('先去藏经阁学一部功法');if(x.en<FIGHT_COST)return fail('灵力不足，歇一会儿再来');if(x.df?.d!==d)x.df={d,n:0};if(x.df.n>=FIGHT_DAILY)return fail('今日斗法次数已满');
   if(x.en>=EN_MAX)x.enAt=now;x.en-=FIGHT_COST;x.df.n++;const me=meFighter(x),sd=hseed(d,a.el,x.df.n,x.stone,x.cv?.xp||0),res=sim(me,op,sd);out.fight={kind:'duel',me,op,sd,w:res.w};
   const v=npcRow(x,a.el);v[0]=clampI(v[0]+3,-500,1000);
   if(res.w){if(x.dd?.d!==d)x.dd={d,w:[]};let stone=0;if(!x.dd.w.includes(a.el)){x.dd.w.push(a.el);stone=Math.round(15*(1+.5*(x.cv?.r||0)));if(x.tech==='lava')stone=Math.floor(stone*1.3);if(Object.values(x.npc).some(v=>v[1]===3))stone=Math.floor(stone*1.1)}
    x.stone+=stone;x.tw=x.tw?.d===d?x.tw:{d,n:0};x.tw.n++;x.tm||={};const L0=techLayer(x);x.tm[x.tech]=(x.tm[x.tech]||0)+1;const L1=techLayer(x);if(L1>L0)out.layer=L1;
    out.msg='胜！'+(stone?'灵石 +'+stone:'（今天已经赢过这位，没有灵石）')+'，好感 +3'+(out.layer?'；'+TECHS[x.tech].name+'突破至第 '+L1+' 层':'');out.stone=stone}
   else out.msg='惜败。好感 +3，回去练练再来';break}
  case 'rin':{const A=AREAS[a.herb];if(!A)return fail('没有这处秘境');if(!x.tech)return fail('先去藏经阁学一部功法');if((x.cv?.r||0)<A.need)return fail(A.n+'需要'+REALMS[A.need]+'修为');
   if(x.rlm){if(now-x.rlm.t<6*3600)return fail('还在秘境里，先走完或撤出');rlmEnd(x,false,out)}if(x.rd?.d!==d)x.rd={d,n:0};if(x.rd.n>=RLM_DAILY)return fail('今天进秘境的次数用完了');if(x.en<RLM_EN)return fail('灵力不足（要 '+RLM_EN+'）');
   if(x.en>=EN_MAX)x.enAt=now;x.en-=RLM_EN;x.rd.n++;const mx=meFighter(x,RLM_MUL).mx;x.rlm={a:a.herb,sd:hseed(d,x.rd.n,a.herb,x.stone,x.cv?.xp||0,x.log||0),L:0,R:-1,c:1,hp:mx,mx,lt:{},t:now};out.msg='进入'+A.n;break}
  case 'rgo':{const e=rlmGo(x,a,now,out);if(e)return fail(e);break}
  case 'rbuy':{const z=x.rlm,S=SHOP[a.i|0];if(!z||!S)return fail('这里没有商人');const m=rlmMap(z.sd),node=z.R>=0?m[z.L]?.[z.R]?.find(n=>n.c===z.c):null;if(node?.k!=='shop')return fail('这里没有商人');
   z.bought||=[];const key=z.L+'.'+z.R+'.'+(a.i|0);if(z.bought.includes(key))return fail('这件已经买过了');if(x.stone<S.st)return fail('灵石不够');x.stone-=S.st;z.bought.push(key);
   if(S.heal)z.hp=Math.min(z.mx,z.hp+Math.round(z.mx*S.heal));else{x.mat||={};x.mat[S.mat]=(x.mat[S.mat]||0)+1}out.msg='买下了'+S.n.replace(/（.*/,'');break}
  case 'rout':{if(!x.rlm)return fail('没有在探索秘境');rlmEnd(x,false,out);out.msg='撤出秘境。'+out.msg.replace('败退出秘境，','');break}
  default:return null}
 return out}
