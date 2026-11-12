// b16 云梦仙途：规则。服务端权威（ctx.rand 为真随机），前端只读这些函数做展示。
// 存档：s.xian（旧 s.realm 封存不读）。全部动作以 xian 开头，经 b12ExtraAction 进入，与小岛同批写入。
import {XIAN_V,XIAN_EL,XIAN_BEAT,XIAN_ROOT_GRADES,XIAN_Q,XIAN_QMUL,XIAN_HERBS,XIAN_PILLS,XIAN_BREAK,XIAN_STAGES,XIAN_MAX_LV,XIAN_TALENTS,XIAN_TALENT_W,XIAN_BASES,XIAN_SLOTS,XIAN_AFFIX,XIAN_GRADE,XIAN_PETS,XIAN_PET_STAGE,XIAN_ECON,xianPlotPrice,XIAN_NPCS} from './b16-xian-content.js';
export const xianDay=t=>Math.floor((t+28800)/86400);
const xInt=(n,max=1e12)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const xPick=(arr,r)=>arr[Math.min(arr.length-1,Math.floor(r*arr.length))];
const xWeighted=(items,weights,r)=>{let sum=weights.reduce((a,b)=>a+b,0),x=r*sum;for(let i=0;i<items.length;i++){x-=weights[i];if(x<0)return items[i]}return items[items.length-1]};
const xR2=v=>Math.round(v*1000)/1000;
export const xianHerb=id=>XIAN_HERBS.find(h=>h.id===id);
export const xianPill=id=>XIAN_PILLS.find(p=>p.id===id);
export const xianBase=id=>XIAN_BASES.find(b=>b.id===id);
export const xianAffix=id=>XIAN_AFFIX.find(a=>a.id===id);
export const xianTalent=id=>XIAN_TALENTS.find(a=>a.id===id);
export const xianPetKind=id=>XIAN_PETS.find(a=>a.id===id);
export const xianNpc=id=>XIAN_NPCS.find(a=>a.id===id);
export function xianQtyTotal(bag,id){return (bag?.[id]||[]).reduce((a,b)=>a+(b||0),0)}
function xBagAdd(bag,id,q,n){const a=bag[id]||(bag[id]=[0,0,0,0,0]);a[q]=(a[q]||0)+n}
// 按品质从低到高（best=true 时从高到低）取 n 个，返回取出的品质数组；不足返回 null 且不改动
function xBagTake(bag,id,n,best=false){
 const a=bag[id];if(!a||xianQtyTotal(bag,id)<n)return null;const got=[];let left=n;
 const order=best?[4,3,2,1,0]:[0,1,2,3,4];
 for(const q of order){const k=Math.min(left,a[q]||0);if(k){a[q]-=k;left-=k;for(let i=0;i<k;i++)got.push(q)}if(!left)break}
 if(!a.some(Boolean))delete bag[id];return got;
}
export function xianRollRoot(r){
 const g=xWeighted(XIAN_ROOT_GRADES,XIAN_ROOT_GRADES.map(x=>x.w),r());
 if(g.variant)return {g:g.g,e:[xPick(['thunder','ice','wind'],r())]};
 const pool=['metal','wood','water','fire','earth'],e=[];
 while(e.length<g.n){const x=xPick(pool.filter(p=>!e.includes(p)),r());e.push(x)}
 return {g:g.g,e};
}
export function xianRollTalent(r,exclude=[]){
 const pool=XIAN_TALENTS.filter(t=>!exclude.includes(t.id));
 const rar=xWeighted([1,2,3,4,5],XIAN_TALENT_W.slice(1),r());
 const cand=pool.filter(t=>t.r===rar);return xPick(cand.length?cand:pool,r()).id;
}
export function xianRootInfo(root){const g=XIAN_ROOT_GRADES[root?.g??0];return {...g,els:root?.e||[],label:(root?.e||[]).map(e=>XIAN_EL[e]).join('')+' · '+g.name}}
export function xianEffects(x){
 const e={};for(const id of x.talents||[]){const t=xianTalent(id);if(t)for(const[k,v]of Object.entries(t.e))e[k]=(e[k]||0)+v}
 return e;
}
// 修为与境界：lv 1–9 练气，10–13 筑基，14–17 金丹，18–21 元婴
export const xianNeed=lv=>Math.round(40*Math.pow(1.35,lv-1));
export function xianStageOf(lv){
 if(lv<=9)return {stage:0,name:'练气'+'一二三四五六七八九'[lv-1]+'层'};
 const st=Math.floor((lv-10)/4)+1,sub=(lv-10)%4;return {stage:st,name:XIAN_STAGES[st]+['初期','中期','后期','圆满'][sub]};
}
export function xianRate(x){ // 每小时修为
 const lv=x.lv||1,root=XIAN_ROOT_GRADES[x.root?.g??0],e=xianEffects(x);
 return 15*Math.pow(1.12,lv)*root.speed*(1+(e.cult||0));
}
export const XIAN_CULT_CAP=16*3600;
export function xianAccrued(x,t){const sec=Math.max(0,Math.min(XIAN_CULT_CAP,t-(x.cAt||t)));return Math.floor(xianRate(x)*sec/3600)}
export function xianBreakNeed(x){return XIAN_BREAK[x.lv]||null}
const XIAN_STAGE_MUL=[1,1.15,1.3,1.5];
function xBaseStats(lv,stage){const m=XIAN_STAGE_MUL[stage]||1;return {hp:(120+lv*45)*m,atk:(12+lv*5)*m,def:(6+lv*2.5)*m,spd:(10+lv*1.2)*m}}
export function xianItemPower(it){return (4+(it.lv||1)*2.2)*(1+.3*(it.g||0))}
export function xianAffixValue(id,g,r){const a=xianAffix(id);return xR2(a.v*(.6+.4*r)*(1+.25*g))}
export function xianAffixText(id,v){const a=xianAffix(id);if(!a)return '';const pct=Math.abs(v)<1?Math.round(v*1000)/10+'%':String(v);return a.name+'：'+a.f.replace('{p}',pct)}
const XIAN_TRIG=['lifesteal','double','burn','freeze','pierce','thorns','shield','regen','crit','critDmg','dodge'];
export function xianStats(x,{pet=true,buff=true}={}){
 const lv=x.lv||1,st=xianStageOf(lv).stage,b=xBaseStats(lv,st),root=XIAN_ROOT_GRADES[x.root?.g??0],e=xianEffects(x);
 const pct={hp:root.bonus+(e.hp||0),atk:root.bonus+(e.atk||0),def:root.bonus+(e.def||0),spd:root.bonus+(e.spd||0)};
 const o={lv,name:'',el:x.root?.e?.[0]||'earth',crit:.05+(e.crit||0),critDmg:1.5+(e.critDmg||0),dodge:e.dodge||0,lifesteal:e.lifesteal||0,double:e.double||0,burn:0,freeze:0,pierce:0,thorns:e.thorns||0,shield:e.shield||0,regen:0,guard:0,firstCrit:e.firstCrit||0,late:e.late||0,lowAtk:e.lowAtk||0,elem:e.elem||0,wsp:'',gunBoost:e.gun?.3:0,mirror:0};
 const add={hp:0,atk:0,def:0,spd:0};
 const applyAffixes=list=>{for(const[id,v]of list||[]){if(id in pct)pct[id]+=v;else if(XIAN_TRIG.includes(id))o[id]+=v}};
 for(const slot of Object.keys(XIAN_SLOTS)){
  const it=(x.items||[]).find(i=>i.id===x.eq?.[slot]);if(!it)continue;const base=xianBase(it.b);if(!base)continue;const P=xianItemPower(it);
  add.atk+=(base.s.atk||0)*P;add.def+=(base.s.def||0)*P*.8;add.hp+=(base.s.hp||0)*P*6;add.spd+=(base.s.spd||0)*P*.3;
  o.dodge+=base.s.dodge||0;o.crit+=base.s.crit||0;
  if(base.sp==='gun'||base.sp==='cannon')o.wsp=base.sp;if(base.sp==='mirror')o.thorns+=.1;if(base.sp==='regen')o.regen+=.03;if(base.sp==='shield')o.shield+=.1;
  if(slot==='weapon'&&it.el)o.el=it.el;
  applyAffixes(it.a);
 }
 const p=pet?(x.pets||[])[x.pet??-1]:null;
 if(p&&p.h){const k=xianPetKind(p.k),G=p.gr||0,sm=1+xianPetStage(G)*.25;add.atk+=G*.06*sm;add.hp+=G*.5*sm;
  if(k.sp==='regen')o.regen+=k.v;if(k.sp==='guard')o.guard+=k.v;if(k.sp==='dodge')o.dodge+=k.v;if(k.sp==='burn')o.burn+=k.v;if(k.sp==='crit')o.crit+=k.v;applyAffixes(p.a)}
 if(buff&&x.buff){if(x.buff.atk?.n>0)pct.atk+=x.buff.atk.v;if(x.buff.def?.n>0)pct.def+=x.buff.def.v}
 o.hp=Math.round((b.hp+add.hp)*(1+pct.hp));o.atk=Math.round((b.atk+add.atk)*(1+pct.atk));o.def=Math.round((b.def+add.def)*(1+pct.def));o.spd=Math.round((b.spd+add.spd)*(1+pct.spd));
 o.dodge=Math.min(.5,o.dodge);o.crit=Math.min(.75,o.crit);o.freeze=Math.min(.3,o.freeze);o.pierce=Math.min(.6,o.pierce);o.guard=Math.min(.5,o.guard);
 o.power=Math.round(o.hp*.25+o.atk*3+o.def*2+o.spd*1.5+(o.crit*o.critDmg+o.double+o.lifesteal+o.burn+o.thorns+o.shield)*o.atk*2);
 return o;
}
export function xianPetStage(gr){let s=0;XIAN_PET_STAGE.forEach((x,i)=>{if(gr>=x.at)s=i});return s}
// 敌人：秘境层 / 佬友切磋
export function xianEnemy(lv,{el='earth',mul=1,name='心魔',traits={}}={}){
 const st=lv>=18?3:lv>=14?2:lv>=10?1:0,b=xBaseStats(lv,st);
 return {lv,name,el,hp:Math.round(b.hp*mul),atk:Math.round(b.atk*mul),def:Math.round(b.def*mul),spd:Math.round(b.spd*Math.sqrt(mul)),crit:.06,critDmg:1.5,dodge:.03,lifesteal:0,double:0,burn:0,freeze:0,pierce:0,thorns:0,shield:0,regen:0,guard:0,firstCrit:0,late:0,lowAtk:0,elem:0,wsp:'',gunBoost:0,...traits};
}
export function xianTowerEnemy(f){
 const boss=f%10===0,npc=XIAN_NPCS[(f*7)%XIAN_NPCS.length],lv=Math.min(30,Math.max(1,Math.round(f*.6)));
 const mul=(.8+.035*f)*(boss?1.35:1),traits=boss?{shield:.1,double:.08}:{};
 return {...xianEnemy(lv,{el:npc.el,mul,name:(boss?'心魔·':'幻影·')+npc.name,traits}),npc:npc.id,boss};
}
export function xianNpcEnemy(n){return {...xianEnemy(n.lv,{el:n.el,mul:1.1,name:n.name,traits:{crit:.1,double:0.05}}),npc:n.id}}
// 自动回合制战斗。返回 {win,rounds,log}；log 条目 [出手方0/1, 类型, 数值, A血, B血]
export function xianBattle(A0,B0,rand,{healPill=0}={}){
 const mk=(s,side)=>({...s,side,max:s.hp,cur:s.hp,sh:Math.round(s.hp*s.shield),cnt:0,first:true,frozen:false,burnT:0,burnV:0,healed:false,pill:side===0?healPill:0});
 const F=[mk(A0,0),mk(B0,1)],log=[],L=(side,k,v)=>{if(log.length<80)log.push([side,k,Math.round(v),F[0].cur,F[1].cur])};
 const hurt=(d,dmg)=>{dmg=Math.max(1,Math.round(dmg));if(d.sh>0){const a=Math.min(d.sh,dmg);d.sh-=a;dmg-=a}d.cur=Math.max(0,d.cur-dmg);return dmg};
 const strike=(a,d,round,mult,kind)=>{
  if(rand()<d.dodge){L(a.side,'miss',0);return}
  const crit=(a.first&&a.firstCrit)||rand()<a.crit;a.first=false;
  let atk=a.atk*(1+(round>=5?a.late:0)+(a.cur<a.max*.3?a.lowAtk:0));
  let dmg=atk*mult*(.9+.2*rand())*(crit?a.critDmg:1);
  if(XIAN_BEAT[a.el]===d.el)dmg*=1.25+a.elem;else if(XIAN_BEAT[d.el]===a.el)dmg*=.85;
  const K=50+d.lv*12,ed=d.def*(1-a.pierce);dmg*=K/(K+ed);dmg*=1-d.guard;
  const real=hurt(d,dmg);L(a.side,crit?'crit':kind,real);
  if(a.lifesteal){a.cur=Math.min(a.max,a.cur+Math.round(real*a.lifesteal))}
  if(d.thorns&&d.cur>0){const back=hurt(a,real*d.thorns);L(d.side,'thorn',back)}
  if(a.burn){d.burnT=3;d.burnV=Math.max(d.burnV,a.atk*a.burn)}
  if(a.freeze&&rand()<a.freeze&&d.cur>0){d.frozen=true;L(a.side,'freeze',0)}
 };
 const act=(a,d,round,extra=false)=>{
  if(a.frozen){a.frozen=false;L(a.side,'frozen',0);return}
  if(a.wsp==='gun'){for(let i=0;i<3&&d.cur>0;i++)strike(a,d,round,.45*(1+a.gunBoost),'gun')}
  else if(a.wsp==='cannon'&&!extra){a.cnt++;strike(a,d,round,a.cnt%3===0?2.5:1,a.cnt%3===0?'cannon':'hit')}
  else strike(a,d,round,1,'hit');
  if(!extra&&d.cur>0&&a.cur>0&&rand()<a.double){L(a.side,'double',0);act(a,d,round,true)}
 };
 let round=0;
 for(round=1;round<=30;round++){
  const order=F[0].spd>F[1].spd||(F[0].spd===F[1].spd&&rand()<.5)?[0,1]:[1,0];
  for(const i of order){const a=F[i],d=F[1-i];if(a.cur<=0||d.cur<=0)break;act(a,d,round)}
  for(const f of F){if(f.cur<=0)continue;
   if(f.burnT>0){f.burnT--;const v=hurt(f,f.burnV);L(1-f.side,'burn',v)}
   if(f.cur>0&&f.regen){const v=Math.round(f.max*f.regen);f.cur=Math.min(f.max,f.cur+v);L(f.side,'regen',v)}
   if(f.cur>0&&f.pill&&!f.healed&&f.cur<f.max*.35){f.healed=true;const v=Math.round(f.max*.3*f.pill);f.cur=Math.min(f.max,f.cur+v);L(f.side,'pill',v)}
  }
  if(F[0].cur<=0||F[1].cur<=0)break;
 }
 const win=F[1].cur<=0&&F[0].cur>0||(F[0].cur>0&&F[1].cur>0&&F[0].cur/F[0].max>F[1].cur/F[1].max);
 return {win,rounds:Math.min(round,30),log,hp:[F[0].cur,F[1].cur],max:[F[0].max,F[1].max]};
}
export function xianRollItem(r,{slot,base,lv=1,floor=0,luck=0}={}){
 const bases=XIAN_BASES.filter(b=>(!slot||b.k===slot)&&(!base||b.id===base)&&(base||!['gun','cannon'].includes(b.id)));
 const b=xPick(bases,r());
 const w=[50,28,14,6,2].map((v,i)=>v*Math.pow(1+floor*.02+luck,i));const g=xWeighted([0,1,2,3,4],w,r());
 const n=Math.min(4,g+1),a=[],pool=XIAN_AFFIX.map(x=>x.id);
 while(a.length<n){const id=xPick(pool.filter(p=>!a.some(z=>z[0]===p)),r());a.push([id,xianAffixValue(id,g,r())])}
 const el=xPick(['metal','wood','water','fire','earth'],r());
 return {b:b.id,g,lv,a,...(b.k==='weapon'?{el}:{})};
}
function xIsleTake(s,id,n){const a=s.inv?.[id];if(!a||a.reduce((x,y)=>x+(y||0),0)<n)return false;let left=n;for(let q=0;q<a.length&&left;q++){const k=Math.min(left,a[q]||0);a[q]-=k;left-=k}if(!a.some(Boolean))delete s.inv[id];return true}
export function xianIsleCount(s,id){return (s.inv?.[id]||[]).reduce((x,y)=>x+(y||0),0)}
export function xianStoneCost(bought,n){let cost=0,start=0,pos=bought,left=n;for(const[size,price]of XIAN_ECON.stoneTiers){const end=start+size;if(pos<end&&left>0){const k=Math.min(left,end-pos);cost+=k*price;pos+=k;left-=k}start=end}return left>0?null:cost}
export const xianStoneDailyMax=XIAN_ECON.stoneTiers.reduce((a,t)=>a+t[0],0);
export function xianToday(x,t){const d=xianDay(t);if(x.dy?.d!==d)x.dy={d,stone:0,water:0,tower:0,extra:0,duel:0,talk:[],won:[]};return x.dy}
export function xianSpringCharges(x){return 2+(x.spring||1)*2}
export function xianFurnaceBatch(x){return (x.furnace||1)*2}
export function xianPlotReady(p,t){const h=xianHerb(p?.h);return !!(p&&h&&t>=p.t+h.hours*3600)}
function xNewItemId(x){x.nid=(x.nid||0)+1;return x.nid}
function xAfterBattle(x){if(!x.buff)return;for(const k of ['atk','def'])if(x.buff[k]){x.buff[k].n--;if(x.buff[k].n<=0)delete x.buff[k]}if(!Object.keys(x.buff).length)delete x.buff}
function xLog(x,row){(x.log||(x.log=[])).unshift(row);x.log.length=Math.min(x.log.length,XIAN_ECON.logMax)}
function xGainXp(x,n){x.xp=(x.xp||0)+Math.max(0,Math.round(n));let ups=0;while(x.lv<XIAN_MAX_LV&&!XIAN_BREAK[x.lv]&&x.xp>=xianNeed(x.lv)){x.xp-=xianNeed(x.lv);x.lv++;ups++}return ups}
function xHealPill(x){if(!x.carry)return 0;const a=x.pills?.heal;if(!a)return 0;for(let q=4;q>=0;q--)if(a[q])return {q,m:XIAN_QMUL[q]};return 0}
function xFight(x,enemy,r){
 const me=xianStats(x),hp=xHealPill(x),res=xianBattle({...me,name:'我'},enemy,r,{healPill:hp?hp.m:0});
 if(hp&&res.log.some(l=>l[1]==='pill'&&l[0]===0))xBagTake(x.pills,'heal',1,true);
 xAfterBattle(x);return {res,me};
}
function xReward(x,g,r){const got=[];if(g.stone){x.stone+=g.stone;got.push('灵石×'+g.stone)}if(g.seed){x.seeds[g.seed]=(x.seeds[g.seed]||0)+g.n;got.push(xianHerb(g.seed).name+'种子×'+g.n)}if(g.pill){xBagAdd(x.pills,g.pill,0,g.n);got.push(xianPill(g.pill).name+'×'+g.n)}return got}
export function xianAction(s,act,ctx){
 const a=String(act?.a||'');if(!a.startsWith('xian'))return null;
 const fail=msg=>({a,ok:false,msg}),ok=(msg,extra={})=>({a,ok:true,msg,...extra});
 if(ctx.ownerId!=null||ctx.visit)return fail('修仙操作只能在自己的存档中进行');
 const t=ctx.t,r=ctx.rand||Math.random,coins=ctx.coins??0;
 if(a==='xianEnter'){
  if(s.xian?.v)return fail('已经入道');
  const root=xianRollRoot(r),talents=[];while(talents.length<3)talents.push(xianRollTalent(r,talents));
  s.xian={v:XIAN_V,at:t,root,talents,lv:1,xp:0,cAt:t,stone:XIAN_ECON.startStone,seeds:{dew:6,gold:3},herbs:{},pills:{heal:[2,0,0,0,0]},mats:{},plots:Array(XIAN_ECON.plotBase).fill(null),spring:1,furnace:1,job:null,pets:[],pet:-1,items:[],eq:{},nid:0,tw:{f:0,best:0},log:[]};
  const x=s.xian,id=xNewItemId(x);x.items.push({id,b:'wood',g:0,lv:1,a:[['atk',.04]],el:'wood'});x.eq.weapon=id;
  const ri=xianRootInfo(root);return ok('入道成功：'+ri.label,{root,talents});
 }
 const x=s.xian;if(!x?.v)return fail('先在渡口入道');
 const dy=xianToday(x,t),n=act.n,id=String(act.id||''),best=act.best===true;
 switch(a){
 case 'xianCultivate':{const g=xianAccrued(x,t);x.cAt=t;if(!g)return fail('修为尚未积累，稍后再来打坐');const ups=xGainXp(x,g);return ok('打坐收获修为 '+g+(ups?'，境界提升 '+ups+' 层':'')+(XIAN_BREAK[x.lv]&&x.xp>=xianNeed(x.lv)?'；已到瓶颈，需要突破':''),{gainXp:g,ups})}
 case 'xianBreak':{
  const need=XIAN_BREAK[x.lv];if(!need)return fail('当前不需要突破');if(x.xp<xianNeed(x.lv))return fail('修为不足，先打坐积累');
  const got=xBagTake(x.pills,need,1,true);if(!got)return fail('缺少'+xianPill(need).name);
  const chance=Math.min(.95,.6+got[0]*.08+(x.bb||0));
  if(r()<chance){x.xp-=xianNeed(x.lv);x.lv++;x.bb=0;xLog(x,{t,k:'break',ok:1,lv:x.lv});return ok('突破成功！踏入'+xianStageOf(x.lv).name,{chance,success:true})}
  x.xp=Math.floor(x.xp*.8);x.bb=Math.min(.3,(x.bb||0)+.15);xLog(x,{t,k:'break',ok:0,lv:x.lv});return ok('突破失败，丹药已化，修为折损两成；下次突破成功率 +'+Math.round(x.bb*100)+'%',{chance,success:false});
 }
 case 'xianStoneBuy':{
  if(!xInt(n,xianStoneDailyMax)||n<1)return fail('数量无效');const cost=xianStoneCost(dy.stone,n);
  if(cost==null)return fail('超过今日兑换上限（剩余 '+(xianStoneDailyMax-dy.stone)+' 枚）');if(coins<cost)return fail('D币不足');
  dy.stone+=n;x.stone+=n;return ok('兑换灵石 '+n+' 枚，花费 '+cost.toLocaleString('zh-CN')+' D币',{spend:cost});
 }
 case 'xianSeedBuy':{const h=xianHerb(id);if(!h||!xInt(n,999)||n<1)return fail('种子或数量无效');const cost=h.seed*n;if(x.stone<cost)return fail('灵石不足');x.stone-=cost;x.seeds[id]=(x.seeds[id]||0)+n;return ok('买入'+h.name+'种子×'+n)}
 case 'xianSell':{
  if(!xInt(n,9999)||n<1)return fail('数量无效');const q=act.q;if(!xInt(q,4))return fail('品质无效');
  let price=0,bag;if(act.kind==='herb'){const h=xianHerb(id);if(!h)return fail('物品无效');price=h.price;bag=x.herbs}else if(act.kind==='pill'){const p=xianPill(id);if(!p)return fail('物品无效');price=p.price;bag=x.pills}else if(act.kind==='mat'&&id==='feather'){price=30;bag=null}else return fail('物品无效');
  if(bag){if(!((bag[id]||[])[q]>=n))return fail('数量不足');bag[id][q]-=n;if(!bag[id].some(Boolean))delete bag[id]}else{if(!((x.mats.feather||0)>=n))return fail('数量不足');x.mats.feather-=n}
  const got=Math.floor(price*XIAN_QMUL[q]*n);x.stone+=got;return ok('卖出得灵石 '+got,{stone:got});
 }
 case 'xianPlant':{
  const ids=act.i==='all'?x.plots.map((p,i)=>p?-1:i).filter(i=>i>=0):[act.i];const h=xianHerb(id);if(!h)return fail('种子无效');let k=0;
  for(const i of ids){if(!(Number.isInteger(i)&&i>=0&&i<x.plots.length)||x.plots[i])continue;if(!(x.seeds[id]>0))break;x.seeds[id]--;if(!x.seeds[id])delete x.seeds[id];x.plots[i]={h:id,t,w:0};k++}
  return k?ok('种下'+h.name+'×'+k,{n:k}):fail('没有空地或种子不足');
 }
 case 'xianWater':{
  const ids=act.i==='all'?x.plots.map((p,i)=>p&&!p.w&&!xianPlotReady(p,t)?i:-1).filter(i=>i>=0):[act.i];let k=0;
  for(const i of ids){const p=x.plots[i];if(!p||p.w||xianPlotReady(p,t))continue;if(dy.water>=xianSpringCharges(x))break;p.w=1;dy.water++;k++}
  return k?ok('引灵泉浇灌 '+k+' 块灵田（今日剩 '+(xianSpringCharges(x)-dy.water)+' 次）',{n:k}):fail(dy.water>=xianSpringCharges(x)?'今日灵泉已用尽':'没有需要浇灌的灵田');
 }
 case 'xianHarvest':{
  const e=xianEffects(x),got={};let k=0;
  x.plots.forEach((p,i)=>{if(!xianPlotReady(p,t))return;const h=xianHerb(p.h);
   const score=r()*.7+(p.w?.12+.03*(x.spring||1):0)+((x.root?.e||[]).includes(h.el)?.15:0)+(e.herbQ||0);
   const q=score<.45?0:score<.68?1:score<.82?2:score<.92?3:4,yieldN=3+(q>=2?1:0)+(r()<.15?1:0);
   xBagAdd(x.herbs,h.id,q,yieldN);got[h.name+'·'+XIAN_Q[q]]=(got[h.name+'·'+XIAN_Q[q]]||0)+yieldN;x.plots[i]=null;k++});
  return k?ok('采收 '+k+' 块：'+Object.entries(got).map(([a,b])=>a+'×'+b).join('、'),{gains:got}):fail('还没有成熟的仙草');
 }
 case 'xianPlot':{if(x.plots.length>=XIAN_ECON.plotMax)return fail('灵田已开满');const cost=xianPlotPrice(x.plots.length);if(coins<cost)return fail('D币不足');x.plots.push(null);return ok('开垦第 '+x.plots.length+' 块灵田',{spend:cost})}
 case 'xianSpringUp':{const lv=x.spring||1;if(lv>=5)return fail('灵泉已满级');const cost=XIAN_ECON.springPrice[lv];if(coins<cost)return fail('D币不足');x.spring=lv+1;return ok('灵泉升到 '+x.spring+' 级',{spend:cost})}
 case 'xianFurnaceUp':{const lv=x.furnace||1;if(lv>=5)return fail('丹炉已满级');if(x.job)return fail('炉中有丹，出炉后再升级');const cost=XIAN_ECON.furnacePrice[lv];if(coins<cost)return fail('D币不足');x.furnace=lv+1;return ok('丹炉升到 '+x.furnace+' 级',{spend:cost})}
 case 'xianBrew':{
  if(x.job)return fail('丹炉正在炼丹');const p=xianPill(id);if(!p)return fail('丹方无效');if(!xInt(n,99)||n<1||n>xianFurnaceBatch(x))return fail('一炉最多 '+xianFurnaceBatch(x)+' 颗');
  const fire=act.fire==='hard'?'hard':'soft';for(const[h,k]of Object.entries(p.in))if(xianQtyTotal(x.herbs,h)<k*n)return fail(xianHerb(h).name+'不足');
  const qs=[];for(const[h,k]of Object.entries(p.in))qs.push(...xBagTake(x.herbs,h,k*n,best));
  const dur=Math.round(p.hours*3600*(1-.08*((x.furnace||1)-1)));x.job={p:id,n,t,done:t+dur,f:fire,q:xR2(qs.reduce((a,b)=>a+b,0)/qs.length)};
  return ok(p.name+'×'+n+' 入炉（'+(fire==='hard'?'武火':'文火')+'）',{done:x.job.done});
 }
 case 'xianCollect':{
  const j=x.job;if(!j)return fail('丹炉是空的');if(t<j.done)return fail('丹药还没炼成');const p=xianPill(j.p),e=xianEffects(x);
  const rate=Math.min(.98,.7+(x.furnace-1)*.05+(e.pillRate||0)+(j.f==='hard'?-.1:.1));let okN=0;const got=[0,0,0,0,0];
  for(let i=0;i<j.n;i++){if(r()>=rate)continue;const raw=j.q+(e.pillQ||0)+(j.f==='hard'?.5:0)+(r()-.5)*1.2+(x.furnace-1)*.15;const q=Math.max(0,Math.min(4,Math.round(raw)));xBagAdd(x.pills,p.id,q,1);got[q]++;okN++}
  x.job=null;return ok(okN?'出炉 '+p.name+'：'+got.map((c,q)=>c?XIAN_Q[q]+'×'+c:'').filter(Boolean).join('、')+(okN<j.n?'；废丹 '+(j.n-okN):''):'炸炉了……这一炉全是废丹',{gains:got,okN});
 }
 case 'xianEat':{
  const p=xianPill(id);if(!p)return fail('丹药无效');
  if(id==='qi'){const g=xBagTake(x.pills,id,1,best);if(!g)return fail('没有聚气丹');const v=Math.round(60*XIAN_QMUL[g[0]]*(1+(x.lv||1)*.15));const ups=xGainXp(x,v);return ok('修为 +'+v+(ups?'，提升 '+ups+' 层':''),{gainXp:v})}
  if(id==='rage'||id==='stone'){const g=xBagTake(x.pills,id,1,best);if(!g)return fail('没有'+p.name);const k=id==='rage'?'atk':'def',v=xR2((id==='rage'?.2:.3)*XIAN_QMUL[g[0]]);(x.buff||(x.buff={}))[k]={n:3,v};return ok(p.name+'生效：接下来3场'+(k==='atk'?'攻击':'防御')+' +'+Math.round(v*100)+'%')}
  if(id==='beast'){const pet=x.pets[act.i??x.pet];if(!pet||t<pet.h)return fail('请选择已孵化的灵宠');const g=xBagTake(x.pills,id,1,best);if(!g)return fail('没有兽元丹');const v=Math.round(40*XIAN_QMUL[g[0]]*(1+(xianEffects(x).petGrow||0)));pet.gr=(pet.gr||0)+v;return ok(xianPetKind(pet.k).name+'成长 +'+v)}
  return fail('这种丹药不能直接服用');
 }
 case 'xianCarry':{x.carry=act.on===true?1:0;return ok(x.carry?'战斗中会自动服用回春丹':'不再携带回春丹')}
 case 'xianTalentReroll':{
  const i=act.i;if(!(i===0||i===1||i===2))return fail('天赋格无效');if(x.pend)return fail('先处理上一次的洗练结果');if(coins<XIAN_ECON.insightD)return fail('D币不足（需 50 万）');
  const g=xBagTake(x.pills,'insight',1,false);if(!g)return fail('缺少悟道丹');const nid=xianRollTalent(r,x.talents);x.pend={k:'t',i,v:nid};
  return ok('悟出新天赋：'+xianTalent(nid).name,{spend:XIAN_ECON.insightD,pend:x.pend});
 }
 case 'xianRootReroll':{
  if(x.pend)return fail('先处理上一次的洗练结果');if(coins<XIAN_ECON.marrowD)return fail('D币不足（需 100 万）');
  const g=xBagTake(x.pills,'marrow',1,false);if(!g)return fail('缺少洗髓丹');const root=xianRollRoot(r);x.pend={k:'r',v:root};
  return ok('洗出新灵根：'+xianRootInfo(root).label,{spend:XIAN_ECON.marrowD,pend:x.pend});
 }
 case 'xianPending':{
  const p=x.pend;if(!p)return fail('没有待确认的结果');delete x.pend;if(act.keep!=='new')return ok('保留原样');
  if(p.k==='t')x.talents[p.i]=p.v;else if(p.k==='r')x.root=p.v;else if(p.k==='p'){const pet=x.pets[p.i];if(pet)pet.a=p.v}else if(p.k==='i'){const it=x.items.find(z=>z.id===p.i);if(it)it.a=p.v}
  return ok('已采用新结果');
 }
 case 'xianEggBuy':{if(x.pets.length>=XIAN_ECON.petMax)return fail('灵兽巢最多养 '+XIAN_ECON.petMax+' 只');if(x.stone<XIAN_ECON.egg)return fail('灵石不足');x.stone-=XIAN_ECON.egg;
  const k=xPick(XIAN_PETS,r()).id,affix=xPick(XIAN_AFFIX,r()).id;x.pets.push({k,h:t+6*3600,gr:0,a:[[affix,xianAffixValue(affix,0,r())]]});return ok('买到一枚灵兽蛋，6 小时后孵化')}
 case 'xianPetActive':{const i=act.i;if(i===-1){x.pet=-1;return ok('灵宠留在巢里')}const p=x.pets[i];if(!p)return fail('灵宠无效');if(t<p.h)return fail('还没孵化');x.pet=i;return ok(xianPetKind(p.k).name+'随你出战')}
 case 'xianPetFeed':{
  const p=x.pets[act.i];if(!p||t<p.h)return fail('请选择已孵化的灵宠');const h=xianHerb(id);if(!h||!xInt(n,99)||n<1)return fail('喂食无效');
  if(p.fd!==dy.d){p.fd=dy.d;p.fn=0}if(p.fn+n>XIAN_ECON.feedDaily)return fail('今天最多再喂 '+(XIAN_ECON.feedDaily-p.fn)+' 份');
  const g=xBagTake(x.herbs,id,n,best);if(!g)return fail(h.name+'不足');p.fn+=n;const v=Math.round(g.reduce((s2,q)=>s2+2*(q+1),0)*(1+(xianEffects(x).petGrow||0)));const before=xianPetStage(p.gr||0);p.gr=(p.gr||0)+v;
  const after=xianPetStage(p.gr);if(after>before&&p.a.length<3){const af=xPick(XIAN_AFFIX.filter(z=>!p.a.some(y=>y[0]===z.id)),r()).id;p.a.push([af,xianAffixValue(af,after,r())])}
  return ok(xianPetKind(p.k).name+'成长 +'+v+(after>before?'，进阶为'+XIAN_PET_STAGE[after].name+'并领悟新词条':''));
 }
 case 'xianPetClaim':{let k=0;for(const p of x.pets){if(t<p.h||p.fd!==dy.d||p.pd===dy.d)continue;p.pd=dy.d;const v=1+xianPetStage(p.gr||0);x.mats.feather=(x.mats.feather||0)+v;k+=v}return k?ok('收集灵羽×'+k):fail('今天喂过的灵宠才会掉灵羽，且每天只能收一次')}
 case 'xianPetWash':{const i=act.i,p=x.pets[i];if(!p||t<p.h)return fail('请选择已孵化的灵宠');if(x.pend)return fail('先处理上一次的洗练结果');if(x.stone<300)return fail('灵石不足（需 300）');const g=xBagTake(x.pills,'spirit',1,false);if(!g)return fail('缺少洗灵露');x.stone-=300;
  const st=xianPetStage(p.gr||0),na=[];while(na.length<Math.max(1,p.a.length)){const af=xPick(XIAN_AFFIX.filter(z=>!na.some(y=>y[0]===z.id)),r()).id;na.push([af,xianAffixValue(af,st,r())])}x.pend={k:'p',i,v:na};return ok('洗出新词条',{pend:x.pend})}
 case 'xianPetRelease':{const i=act.i;if(!x.pets[i])return fail('灵宠无效');x.pets.splice(i,1);if(x.pet===i)x.pet=-1;else if(x.pet>i)x.pet--;return ok('放归山林')}
 case 'xianForge':{
  const slot=act.slot;if(!XIAN_SLOTS[slot])return fail('槽位无效');if(x.items.length>=XIAN_ECON.bagMax)return fail('法宝囊已满');if(x.stone<200)return fail('灵石不足（需 200）');
  if(xianIsleCount(s,'iron')<3)return fail('需要小岛铁矿×3');xIsleTake(s,'iron',3);x.stone-=200;
  const it={id:xNewItemId(x),...xianRollItem(r,{slot,lv:x.lv,luck:xianEffects(x).drop||0})};x.items.push(it);return ok('铁衣锻出 '+XIAN_GRADE[it.g]+'·'+xianBase(it.b).name,{item:it});
 }
 case 'xianBombForge':{
  const b=act.base;if(b!=='gun'&&b!=='cannon')return fail('辣鱼只做鸡关枪和汝知炮');if(x.items.length>=XIAN_ECON.bagMax)return fail('法宝囊已满');if(x.stone<300)return fail('灵石不足（需 300）');
  if(xianIsleCount(s,'bomb')<5)return fail('需要小岛炸药×5');xIsleTake(s,'bomb',5);x.stone-=300;
  const it={id:xNewItemId(x),...xianRollItem(r,{base:b,lv:x.lv,luck:xianEffects(x).drop||0})};x.items.push(it);return ok('辣鱼做好了 '+XIAN_GRADE[it.g]+'·'+xianBase(it.b).name+'！',{item:it});
 }
 case 'xianEquip':{const it=x.items.find(z=>z.id===act.id);if(!it)return fail('法宝无效');const k=xianBase(it.b).k;x.eq[k]=it.id;return ok('已装备'+xianBase(it.b).name)}
 case 'xianUnequip':{if(!XIAN_SLOTS[act.slot])return fail('槽位无效');delete x.eq[act.slot];return ok('已卸下')}
 case 'xianSalvage':{const i=x.items.findIndex(z=>z.id===act.id);if(i<0)return fail('法宝无效');const it=x.items[i];if(Object.values(x.eq).includes(it.id))return fail('先卸下再分解');if(x.pend?.k==='i'&&x.pend.i===it.id)delete x.pend;x.items.splice(i,1);const v=20*(it.g+1)*(it.g+1);x.stone+=v;return ok('分解得灵石 '+v)}
 case 'xianReforge':{
  const it=x.items.find(z=>z.id===act.id);if(!it)return fail('法宝无效');if(x.pend)return fail('先处理上一次的洗练结果');
  const lock=Array.isArray(act.lock)?[...new Set(act.lock)].filter(i=>Number.isInteger(i)&&i>=0&&i<it.a.length):[];if(lock.length>=it.a.length)return fail('至少留一条词条洗练');
  const sc=100*(it.g+1),dc=lock.length*XIAN_ECON.lockPerAffix;if(x.stone<sc)return fail('灵石不足（需 '+sc+'）');if(coins<dc)return fail('D币不足（锁定需 '+dc.toLocaleString('zh-CN')+'）');
  x.stone-=sc;const na=it.a.map((z,i)=>lock.includes(i)?z:null);
  for(let i=0;i<na.length;i++)if(!na[i]){const af=xPick(XIAN_AFFIX.filter(z=>!na.some(y=>y&&y[0]===z.id)),r()).id;na[i]=[af,xianAffixValue(af,it.g,r())]}
  x.pend={k:'i',i:it.id,v:na};return ok('洗出新词条',{spend:dc,pend:x.pend});
 }
 case 'xianTower':{
  let spend=0;if(dy.tower>=XIAN_ECON.towerFree){if(act.pay!==true)return fail('今日免费次数已用完');if(dy.extra>=XIAN_ECON.towerExtraMax)return fail('今日传送阵已到上限');spend=XIAN_ECON.towerExtraBase*Math.pow(2,dy.extra);if(coins<spend)return fail('D币不足');dy.extra++}
  dy.tower++;const f=(x.tw.f||0)+1,enemy=xianTowerEnemy(f),{res}=xFight(x,enemy,r);let got=[],item=null;
  if(res.win){x.tw.f=f;x.tw.best=Math.max(x.tw.best||0,f);const stone=10+f*3;x.stone+=stone;got.push('灵石×'+stone);const xp=f*4;xGainXp(x,xp);got.push('修为×'+xp);
   const luck=xianEffects(x).drop||0;if((enemy.boss||r()<.3+luck)&&x.items.length<XIAN_ECON.bagMax){item={id:xNewItemId(x),...xianRollItem(r,{lv:Math.max(1,Math.round(1+f*.6)),floor:f,luck})};x.items.push(item);got.push(XIAN_GRADE[item.g]+'·'+xianBase(item.b).name)}
   if(r()<.4){const h=xPick(XIAN_HERBS,r());x.seeds[h.id]=(x.seeds[h.id]||0)+2;got.push(h.name+'种子×2')}}
  xLog(x,{t,k:'tower',f,win:res.win?1:0});
  return ok(res.win?'第 '+f+' 层通关：'+got.join('、'):'第 '+f+' 层败退，修整后再来',{spend,battle:res,enemy:{name:enemy.name,npc:enemy.npc,lv:enemy.lv,el:enemy.el,boss:enemy.boss},win:res.win,gains:got,item});
 }
 case 'xianDuel':{
  const npc=xianNpc(id);if(!npc)return fail('佬友不在');if(dy.duel>=10)return fail('今天切磋够多了，明天再来');dy.duel++;
  const enemy=xianNpcEnemy(npc),{res}=xFight(x,enemy,r);let got=[];
  if(res.win&&!dy.won.includes(id)){dy.won.push(id);got=xReward(x,npc.gift,r);xGainXp(x,npc.lv*6);got.push('修为×'+npc.lv*6)}
  xLog(x,{t,k:'duel',npc:id,win:res.win?1:0});
  return ok(res.win?'切磋获胜'+(got.length?'：'+got.join('、'):'（今日奖励已领）'):'惜败于'+npc.name,{battle:res,enemy:{name:npc.name,npc:id,lv:enemy.lv,el:enemy.el},win:res.win,gains:got});
 }
 case 'xianTalk':{const npc=xianNpc(id);if(!npc)return fail('佬友不在');if(dy.talk.includes(id))return ok('今天已经聊过了',{line:xPick(npc.lines,r())});dy.talk.push(id);const got=npc.gift.stone?xReward(x,{stone:Math.ceil(npc.gift.stone/3)},r):[];return ok(got.length?'获赠 '+got.join('、'):'聊得很开心',{line:xPick(npc.lines,r()),gains:got})}
 }
 return fail('未知的修仙操作');
}
