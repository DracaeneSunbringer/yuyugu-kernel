// b16 云梦仙途：静态数据。服务端与前端共用；只放数据，不放逻辑。标识符一经上线不得改名。
export const XIAN_V=1;
export const XIAN_EL={metal:'金',wood:'木',water:'水',fire:'火',earth:'土',thunder:'雷',ice:'冰',wind:'风'};
export const XIAN_BEAT={metal:'wood',wood:'earth',earth:'water',water:'fire',fire:'metal',thunder:'water',ice:'fire',wind:'earth'};
export const XIAN_ROOT_GRADES=[
 {g:0,name:'伪灵根',n:5,w:12,speed:.7,bonus:0},
 {g:1,name:'伪灵根',n:4,w:23,speed:.8,bonus:.02},
 {g:2,name:'杂灵根',n:3,w:30,speed:.9,bonus:.04},
 {g:3,name:'真灵根',n:2,w:22,speed:1.05,bonus:.07},
 {g:4,name:'天灵根',n:1,w:9,speed:1.3,bonus:.1},
 {g:5,name:'变异灵根',n:1,w:4,speed:1.5,bonus:.12,variant:true}
];
export const XIAN_Q=['凡品','灵品','玄品','地品','天品'];
export const XIAN_QMUL=[1,1.2,1.45,1.75,2.1];
export const XIAN_HERBS=[
 {id:'dew',name:'清露草',el:'wood',hours:2,seed:4,price:3,icon:[3,0]},
 {id:'gold',name:'金盏苔',el:'earth',hours:4,seed:8,price:6,icon:[3,5]},
 {id:'moon',name:'月华露',el:'metal',hours:6,seed:14,price:10,icon:[3,3]},
 {id:'lotus',name:'玄冰莲',el:'water',hours:8,seed:20,price:15,icon:[3,1]},
 {id:'fire',name:'火灵芝',el:'fire',hours:12,seed:30,price:24,icon:[3,2]},
 {id:'bamboo',name:'雷纹竹',el:'thunder',hours:24,seed:60,price:50,icon:[3,4]}
];
export const XIAN_PILLS=[
 {id:'heal',name:'回春丹',in:{dew:3},hours:1,price:14,icon:[2,0],desc:'带入战斗：生命低于35%时自动服下，恢复30%生命（品质加成）'},
 {id:'qi',name:'聚气丹',in:{dew:2,moon:2},hours:2,price:30,icon:[2,1],desc:'服下立得修为 60（品质加成）'},
 {id:'rage',name:'狂暴丹',in:{fire:2,gold:1},hours:2,price:40,icon:[2,0],hue:30,desc:'接下来3场战斗攻击 +20%（品质加成）'},
 {id:'stone',name:'金刚丹',in:{gold:2,moon:1},hours:2,price:30,icon:[2,2],desc:'接下来3场战斗防御 +30%（品质加成）'},
 {id:'beast',name:'兽元丹',in:{gold:3,dew:3},hours:2,price:28,icon:[2,3],desc:'喂给灵宠：成长 +40（品质加成）'},
 {id:'spirit',name:'洗灵露',in:{lotus:3,moon:2},hours:3,price:60,icon:[2,3],hue:120,desc:'重洗当前灵宠的词条（可选保留旧词条）'},
 {id:'insight',name:'悟道丹',in:{moon:3,bamboo:2},hours:4,price:160,icon:[2,4],desc:'重悟一格天赋（可选保留旧天赋），另需 50 万 D 币'},
 {id:'marrow',name:'洗髓丹',in:{bamboo:2,lotus:2,dew:5},hours:4,price:180,icon:[2,5],desc:'重洗灵根（可选保留旧灵根），另需 100 万 D 币'},
 {id:'found',name:'筑基丹',in:{dew:5,lotus:3,moon:3},hours:4,price:120,icon:[2,2],hue:-30,desc:'练气九层突破筑基'},
 {id:'core',name:'凝金丹',in:{fire:4,lotus:4,bamboo:2},hours:6,price:300,icon:[2,2],hue:20,desc:'筑基圆满突破金丹'},
 {id:'yuan',name:'元婴丹',in:{bamboo:5,fire:5,lotus:5},hours:8,price:800,icon:[2,4],hue:60,desc:'金丹圆满突破元婴'}
];
export const XIAN_BREAK={9:'found',13:'core',17:'yuan'};
export const XIAN_STAGES=['练气','筑基','金丹','元婴'];
export const XIAN_MAX_LV=21;
export const XIAN_TALENTS=[
 {id:'t_hp1',r:1,name:'体魄强健',e:{hp:.08}},{id:'t_atk1',r:1,name:'力大无穷',e:{atk:.06}},{id:'t_def1',r:1,name:'铜皮',e:{def:.08}},
 {id:'t_spd1',r:1,name:'身轻如燕',e:{spd:.08}},{id:'t_farm1',r:1,name:'药农世家',e:{herbQ:.04}},{id:'t_cult1',r:1,name:'勤修不辍',e:{cult:.08}},
 {id:'t_hp2',r:2,name:'先天道体',e:{hp:.15}},{id:'t_atk2',r:2,name:'锐金之体',e:{atk:.12}},{id:'t_dodge2',r:2,name:'灵巧',e:{dodge:.06}},
 {id:'t_crit2',r:2,name:'会心一击',e:{crit:.08}},{id:'t_pill2',r:2,name:'丹心',e:{pillRate:.06}},{id:'t_farm2',r:2,name:'灵植亲和',e:{herbQ:.08}},{id:'t_pet2',r:2,name:'兽语者',e:{petGrow:.25}},
 {id:'t_first3',r:3,name:'剑心通明',e:{firstCrit:1},desc:'首次出手必定暴击'},{id:'t_thorn3',r:3,name:'睚眦必报',e:{thorns:.2}},{id:'t_steal3',r:3,name:'吸星',e:{lifesteal:.1}},
 {id:'t_double3',r:3,name:'连环',e:{double:.15}},{id:'t_late3',r:3,name:'厚积薄发',e:{late:.3},desc:'第5回合起攻击 +30%'},{id:'t_alch3',r:3,name:'丹道奇才',e:{pillRate:.1,pillQ:.3}},{id:'t_luck3',r:3,name:'气运之子',e:{drop:.15}},
 {id:'t_shield4',r:4,name:'不灭金身',e:{shield:.2},desc:'开战获得20%生命的护盾'},{id:'t_low4',r:4,name:'背水一战',e:{lowAtk:.4},desc:'生命低于30%时攻击 +40%'},
 {id:'t_eye4',r:4,name:'天眼',e:{crit:.15,critDmg:.3}},{id:'t_five4',r:4,name:'五行通明',e:{elem:.15}},
 {id:'t_fate5',r:5,name:'天命之人',e:{hp:.1,atk:.1,def:.1,spd:.1,drop:.1}},{id:'t_zen5',r:5,name:'太上忘情',e:{cult:.4}},{id:'t_gun5',r:5,name:'鸡关枪传人',e:{gun:1,double:.1},desc:'鸡关枪每段伤害 +30%，并有连击'}
];
export const XIAN_TALENT_W=[0,45,28,16,8,3];
export const XIAN_BASES=[
 {id:'wood',k:'weapon',name:'木剑',s:{atk:1},icon:[5,0]},
 {id:'fly',k:'weapon',name:'飞剑',s:{atk:1.1,spd:.3},icon:[1,2]},
 {id:'whisk',k:'weapon',name:'拂尘',s:{atk:.9,dodge:.02},icon:[1,5]},
 {id:'gun',k:'weapon',name:'鸡关枪',s:{atk:.85},sp:'gun',icon:[1,0],desc:'每次出手连射三段，每段45%伤害'},
 {id:'cannon',k:'weapon',name:'汝知炮',s:{atk:.9},sp:'cannon',icon:[1,1],desc:'每第3次出手轰出250%伤害'},
 {id:'token',k:'charm',name:'玉令牌',s:{def:1,hp:.5},icon:[0,4]},
 {id:'mirror',k:'charm',name:'八卦镜',s:{def:.9},sp:'mirror',icon:[1,4],desc:'反弹10%所受伤害'},
 {id:'talisman',k:'charm',name:'护身符',s:{def:.7,dodge:.03},icon:[4,5]},
 {id:'gourd',k:'relic',name:'金葫芦',s:{hp:1},sp:'regen',icon:[1,3],desc:'每回合恢复3%生命'},
 {id:'whale',k:'relic',name:'蓝鲸玩偶',s:{hp:.8},sp:'shield',icon:[5,5],desc:'开战获得10%生命护盾'},
 {id:'abacus',k:'relic',name:'金算盘',s:{hp:.6,crit:.04},icon:[5,4]}
];
export const XIAN_SLOTS={weapon:'武器',charm:'护符',relic:'灵器'};
export const XIAN_AFFIX=[
 {id:'atk',t:'p',name:'锋锐',v:.06,f:'攻击 +{p}'},{id:'hp',t:'p',name:'坚韧',v:.08,f:'生命 +{p}'},{id:'def',t:'p',name:'磐石',v:.08,f:'防御 +{p}'},
 {id:'spd',t:'p',name:'灵动',v:.06,f:'速度 +{p}'},{id:'crit',t:'p',name:'会心',v:.04,f:'暴击率 +{p}'},{id:'critDmg',t:'p',name:'裂魂',v:.12,f:'暴击伤害 +{p}'},
 {id:'dodge',t:'p',name:'飘渺',v:.03,f:'闪避 +{p}'},
 {id:'lifesteal',t:'s',name:'吸血',v:.05,f:'伤害的 {p} 转为生命'},{id:'double',t:'s',name:'连击',v:.06,f:'{p} 概率再出手一次'},
 {id:'burn',t:'s',name:'灼烧',v:.06,f:'附加灼烧，3回合每回合 {p} 攻击'},{id:'freeze',t:'s',name:'冰封',v:.04,f:'{p} 概率冻住对手一回合'},
 {id:'pierce',t:'s',name:'破甲',v:.08,f:'无视 {p} 防御'},{id:'thorns',t:'s',name:'反震',v:.06,f:'反弹 {p} 所受伤害'},
 {id:'shield',t:'s',name:'护体',v:.05,f:'开战获得 {p} 生命护盾'},{id:'regen',t:'s',name:'回元',v:.012,f:'每回合恢复 {p} 生命'}
];
export const XIAN_GRADE=['凡器','灵器','宝器','仙器','神器'];
export const XIAN_PETS=[
 {id:'deer',name:'灵鹿',emoji:'🦌',el:'wood',sp:'regen',v:.03,desc:'每回合为主人恢复3%生命'},
 {id:'turtle',name:'玄龟',emoji:'🐢',el:'water',sp:'guard',v:.12,desc:'主人所受伤害 -12%'},
 {id:'bird',name:'青鸟',emoji:'🐦',el:'wind',sp:'dodge',v:.08,desc:'主人闪避 +8%'},
 {id:'fox',name:'火狐',emoji:'🦊',el:'fire',sp:'burn',v:.06,desc:'主人攻击附带灼烧'},
 {id:'mink',name:'雷貂',emoji:'🐿️',el:'thunder',sp:'crit',v:.1,desc:'主人暴击率 +10%'}
];
export const XIAN_PET_STAGE=[{at:0,name:'幼年'},{at:100,name:'成年'},{at:300,name:'灵化'}];
export const XIAN_ECON={
 startStone:200,
 stoneTiers:[[300,1000],[700,2000],[1000,4000]],
 plotBase:6,plotMax:18,
 springPrice:[0,500000,1500000,4500000,13500000],
 furnacePrice:[0,300000,1000000,3000000,10000000],
 egg:800,lockPerAffix:500000,insightD:500000,marrowD:1000000,
 towerFree:5,towerExtraBase:50000,towerExtraMax:5,
 bagMax:30,petMax:3,logMax:8,feedDaily:10
};
export const xianPlotPrice=k=>Math.round(200000*Math.pow(1.5,k-6));
export const XIAN_NPCS=[
 {id:'52d',name:'52弟',title:'仙渡引路人',map:'ferry',x:.42,y:.66,lv:3,el:'earth',lines:['欢迎来到云梦仙途！先去秘境开几块灵田，种子在茶寮买。','灵石只能拿D币换，换不回去的哦，想清楚再换～','突破要丹药，丹药要仙草，仙草要灵田……修仙就是种田嘛。'],gift:{stone:30}},
 {id:'fas',name:'法斯',title:'潮库书记',map:'ferry',x:.62,y:.46,lv:6,el:'metal',lines:['今日灵石兑换额度我都记在账本上，算盘一响就知道。','D币进来容易出去难，这叫宗门财政纪律。','账对不上？不可能，我的算盘从不出错。'],gift:{stone:40}},
 {id:'melon',name:'西瓜',title:'集市司会',map:'ferry',x:.3,y:.44,lv:4,el:'water',lines:['仙市开张啦！仙草丹药都收，价钱公道！','叮叮当——今天也是切西瓜的好日子。','卖之前看看品质，天品的可别贱卖了。'],gift:{seed:'lotus',n:2}},
 {id:'duck',name:'蓝嘎',title:'巡潮水手',map:'ferry',x:.22,y:.66,lv:5,el:'water',lines:['咕咕嘎嘎！','咕咕……嘎嘎嘎！（她指了指渡船）','嘎！（递来一张潮汐图）'],gift:{stone:25}},
 {id:'rollbin',name:'洛宾',title:'游方客',map:'ferry',x:.76,y:.7,lv:13,el:'earth',lines:['嘘……我这有一卷神秘鱼谱，编号保密。','（左右张望后从袖子里掏出卷轴，又塞了回去）','想要？先赢我一场。'],gift:{seed:'bamboo',n:1}},
 {id:'echo',name:'回声',title:'传音使',map:'ferry',x:.88,y:.44,lv:5,el:'wind',lines:['{echo}'],gift:{stone:20}},
 {id:'rainbow',name:'虹夏',title:'节拍行者',map:'ferry',x:.56,y:.82,lv:8,el:'thunder',lines:['咚咚哒！跟上节拍！','修炼也要有节奏感～','来一首？'],gift:{stone:35}},
 {id:'egg',name:'荷包',title:'试炼丹师',map:'sect',x:.2,y:.34,lv:8,el:'fire',lines:['文火稳，武火险，险中出好丹。','丹炉越好，一炉出丹越多，这钱省不得。','仙草品质越高，丹药品质越高，别拿凡品糊弄丹炉。'],gift:{pill:'heal',n:1}},
 {id:'iron',name:'铁衣',title:'锻器师',map:'sect',x:.7,y:.7,lv:12,el:'metal',lines:['滴——提醒：该喝水了。','滴——提醒：提肛运动，一、二、三、四。','打造法宝要灵石和你岛上的铁矿，词条看天意。'],gift:{stone:50}},
 {id:'lafish',name:'辣鱼',title:'潮火厨修',map:'sect',x:.93,y:.72,lv:15,el:'fire',lines:['嘿嘿，新做的炸弹，要不要试试？','鸡关枪、汝知炮，拿岛上的炸药来换！','炸矿？不，这叫炸丹炉——开玩笑的。'],gift:{stone:60}},
 {id:'meow',name:'琦喵',title:'灵圃掌柜',map:'sect',x:.22,y:.76,lv:7,el:'wood',lines:['来猜个词吧？猜对了给你发红包～','今天的红包已经包好了，喵。','灵圃的种子都是我亲手挑的。'],gift:{stone:66}},
 {id:'water',name:'止水',title:'济世居士',map:'sect',x:.42,y:.38,lv:14,el:'water',lines:['在下乃正人君子，绝不偷看他人丹方。','……刚才那是风吹的，不是我翻的。','君子切磋，点到为止。'],gift:{pill:'qi',n:1}},
 {id:'sup',name:'风祝',title:'祈风使',map:'sect',x:.6,y:.34,lv:18,el:'wind',lines:['风神庇佑，祈风顺遂。','……不要再叫我妈妈了！','视线往上一点！看哪里呢！'],gift:{stone:80}},
 {id:'soup',name:'无极',title:'说书客',map:'sect',x:.38,y:.8,lv:9,el:'earth',lines:['（啪！）上回说到，有一位道友把汝知炮塞进了丹炉……','话说那鸡关枪，原是一只母鸡的心愿。','欲知后事如何，明日请早。'],gift:{stone:30}},
 {id:'earthcat',name:'地喵',title:'符书匠',map:'sect',x:.72,y:.36,lv:10,el:'earth',lines:['一张符，三分画，七分灵力。','护身符要贴在心口才灵。','喵（落笔）。'],gift:{stone:40}},
 {id:'wheat',name:'麦穗',title:'巡田使',map:'secret',x:.2,y:.72,lv:10,el:'earth',lines:['唉，红尘俗事，我早已看破。','种田就好，种田使人平静。','（抱着麦穗打坐，没理你）'],gift:{seed:'gold',n:3}},
 {id:'ant',name:'时蚁',title:'渡阵师',map:'secret',x:.18,y:.34,lv:16,el:'thunder',lines:['秘境塔入口在洞里，每天免费进五次。','再想进？传送阵耗灵力，得交些D币。','塔里都是心魔幻影，长得像谁可别奇怪。'],gift:{stone:60}},
 {id:'blessing',name:'福鱼',title:'食禄使',map:'secret',x:.64,y:.74,lv:9,el:'water',lines:['大肥鱼会平等地祝福每个干饭人。','灵宠也要干饭，记得每天喂。','（双手合十）愿你今天出天品。'],gift:{pill:'beast',n:1}},
 {id:'whitebird',name:'白羽',title:'归巢营造师',map:'secret',x:.84,y:.44,lv:11,el:'wind',lines:['！','！！','（头顶冒出一个巨大的感叹号）'],gift:{stone:45}},
 {id:'flower',name:'九一',title:'探花客',map:'secret',x:.44,y:.3,lv:17,el:'wood',lines:['拈花一笑，剑在花中。','花开堪折直须折。','我的剑，比花还快。'],gift:{stone:70}},
 {id:'castle',name:'结城',title:'守灯剑客',map:'secret',x:.88,y:.78,lv:19,el:'ice',lines:['灯不灭，人不退。','……','要切磋？按剑相候。'],gift:{stone:90}}
];
export const XIAN_MAPS={
 ferry:{name:'云梦渡口',spots:[{id:'boat',x:.1,y:.5,label:'渡船 · 回小岛'},{id:'market',x:.5,y:.26,label:'茶寮 · 仙市'},{id:'gate',x:.84,y:.16,label:'山门 · 宗门'},{id:'path',x:.5,y:.94,label:'小径 · 秘境'}]},
 sect:{name:'宗门广场',spots:[{id:'alchemy',x:.2,y:.2,label:'丹房'},{id:'library',x:.84,y:.18,label:'藏经阁 · 修炼'},{id:'envelope',x:.2,y:.6,label:'红包亭'},{id:'bombs',x:.84,y:.42,label:'炸药坊 · 炼器'},{id:'arena',x:.5,y:.5,label:'论剑台 · 切磋'},{id:'back',x:.5,y:.95,label:'下山 · 渡口'}]},
 secret:{name:'秘境',spots:[{id:'tower',x:.12,y:.16,label:'妖兽洞 · 秘境塔'},{id:'spring',x:.5,y:.5,label:'灵泉'},{id:'field',x:.3,y:.88,label:'灵田'},{id:'nest',x:.74,y:.26,label:'灵兽巢'},{id:'back',x:.66,y:.95,label:'返回渡口'}]}
};
