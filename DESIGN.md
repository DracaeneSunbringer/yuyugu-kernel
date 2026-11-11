# 52dmeme-pets 全新统一经济决策内核与独立反事实审计契约（Clean-Slate v1.0）

本工程采用零硬编码物品 ID 的统一滚动时域经济决策内核（Unified Rolling-Horizon Economic Kernel）与独立三层反事实无偏审计引擎（Counterfactual Audit Engine）双闭环设计。

---

## 1. 核心架构红线（根除旧系统五大结构病因）

1. **单一主规划器唯一接管（Single Brain, Zero Split-Brain）**
   - 系统中**不存在**旧式 `policy.analyze` 启发式流水线。
   - `cli/controller.mjs` 唯一调用链：
     `buildDecisionContext(observations)` → `solveUnifiedPlan(ctx)` → `compileExecutablePrefix(ctx, plan)` → `executeTransaction(journal, prefix)`。
   - 播种、浇水、收获、清理、牧场收喂摸、蟹笼、钓鱼、挖矿、炸矿、货船采购（`stockBuy`）、商店补给（`buy`）、工坊加工（含多原料超边与任意深度配方链如 `gold+coal -> ingot -> crown`、`coal+copper -> bomb -> bomb`）、口粮补能（`eat` 作物 / `tide_snack` / `coffee`）、原果与成品售卖（`sell`）、每日目标领奖（`goal`）、基建扩建（受用户授权约束）以及串门偷菜批次（`visit`）全部在**同一份跨期资源守恒账本 $\Pi^*$** 中竞争同一份库存、现金、体力、土地、工坊 80 次/岛日额度与自然日 `150/400` 阶梯。
2. **计划即执行（One Shared Plan Across Valuation & Action Generation）**
   - `solveUnifiedPlan` 输出唯一的结构化跨期分配方案 $\Pi^* = (\text{buckets}[0..B-1], \text{terminalTail}, \text{quality})$。
   - `compileExecutablePrefix` **只从 $\Pi^*.\text{buckets}[0]$ 直接编译当前时刻动作序列**，绝不在下游二次重排另一套加工队列、口粮曲线或售卖预留表。
   - 前缀逐动作在规则沙箱中经 `rulesAdapter.applyActions` 验真；遇到首条随机转移（`harvest` / `fish` / `mine` / `bomb` / `trap` 或外部 `visit`）立即截断前缀，必须拿服务端真实回执重规划，严禁把 `rand = 0.5` 的影子状态当作真实后态。
3. **四类信息严格分层（Truth vs. Observation vs. Belief vs. User Constraint）**
   - `model/rules-adapter.mjs`：纯机械规则真值（指定 `rulesHash` 下的转移、扣料顺序 `q0 -> q1 -> q2`、计数归属、长夜时钟 `b12ConfigureClock`、仓库掩码 `vault` 隔离、渐进售卖税 `b12SaleQuote`、单批 40 动作、单动作 `craft <= 20`）。
   - `model/observations.mjs`：服务器当时可见观察（`now / rev / prices / state / neighborIsles`）与未知环境信念分离；价格反推显式区分实际供需因子区间 $[S_{\min}, S_{\max}]$ 与相对无销量报价比率 $S / 1.06$；对手战斗胜/平/负输出区间与样本来源，拒绝把未验证常数伪装成确定性真值。
   - `userConstraints`：运行模式硬边界（如默认不买未授权基建、每岛日访问预算上限；`--domestic-only` 纯内政模式下严守 `stealBudget = 0`）直接裁剪合法动作空间，绝不随利润优化自动解除。
4. **零硬编码商品/星级/配方名单（100% Rule-Table Driven）**
   - `model/`、`planner/`、`execution/`、`audit/`、`cli/` 全源码**零硬编码具体物品 ID**（不出现 `'strawberry'`、`'corn'`、`'popcorn'`、`'crown'` 等策略特判）。
   - 所有商品属性、季节、成熟时长、配方输入超边、拓扑依赖链、阶梯适用性均由注入的 `rules` 动态解析；将全部物品 ID 同构重命名后，规划目标值严格不变。
5. **诚实上下界、可执行终端尾段与独立三层审计**
   - **上界 $U(\mu)$**（`planner/bounds.mjs`）：对同一时域、同一行情情景、同一终端估值模型放松跨动作耦合约束，内层子问题**精确求解至数学上确界 $\sup$**（严禁对内层做束搜索裁剪或候选过滤后冒充上界；一旦启用任何非完备裁剪，`validUpperBound` 强制输出 `null`）。在小规模问题上由单测验证 $L \le \text{opt}^* \le U$。
   - **可执行终端清算尾段**（`model/objective.mjs`）：期末剩余可售持仓通过构造真实合法的 `sell` 动作序列并调用 `applyActions` 实证结算（含当时市场因子、负商闻、当日剩余 `sc_<crop>` 阶梯、`q2 -> q1 -> q0` 排序、取整与 `b12SaleQuote` 税费），不可售物品不赋虚假现金值；内置 $H$ vs $H + \Delta H$ 首动作稳定性检查与滚动延期检测器。
   - **零耦合独立审计**（`audit/*`）：严禁 `import` 任何 `planner/*` 模块。独立实现状态回放对账（`replay.mjs`）、独立全候选枚举与精确分支定界小参考解/反事实改进搜索（`reference-solver.mjs`）、以及严格区分「事前可识别决策 Regret 下界 `R_lower`」「相对参考轨迹估计差」「计划兑现偏差」「事后机会差」与 `not-identifiable` 的报告器（`report.mjs`）。

---

## 2. 唯一目标函数与跨期联合资源分配数学模型

### 2.1 显式唯一目标函数
给定当前时刻 $t_0$ 的观察状态 $s_0$、观察行情 $P_0$ 与外部销量情景分布 $\Omega = \{(\omega, p_\omega)\}$，条件策略树 $\Pi$ 最大化：
$$J(\Pi \mid s_0, \mathcal{I}_0) = \sum_{\omega \in \Omega} p_\omega \left[ C_0 + \sum_{k} \gamma(t_k - t_0)\,\Delta C_{k}(\omega) + \gamma(t_H - t_0)\,V_{\text{tail}}\big(s_H(\omega), t_H, P_H(\omega)\big) \right]$$
其中：
- $\gamma(\Delta t) = (1 + \rho)^{-\Delta t / 3600}$ 为显式配置的小时时间偏好折现因子（默认 $\rho = 0$）；
- $\Delta C_k(\omega) = \text{earn}_k(\omega) - \text{spend}_k(\omega)$ 为动作转移真实产生的净现金流（含渐进售卖税 `b12SaleQuote`）；所有体力、原料、配额消耗均通过状态转移精确扣减，**严禁在目标中二次重复扣除影子价格 $\lambda$**；
- $V_{\text{tail}}(s_H, t_H, P_H)$ 为**固定在截止时刻 $t_H$、受有限批次预算约束的可执行终端清算尾段净现金**：仅将 $t_H$ 当时可用可售库存按 `q2 -> q1 -> q0` 构造合法 `sell` 动作并在 $t_H$ 当日剩余阶梯与税基下经 `applyActions` 实证结算，绝不跨入 $t_H$ 之后的未来新自然日骗取新阶梯，也不赋任何未经验证的启发式残值；
- 我方在岛日 $d$ 的计划销量 $Q^{\text{self}}_{i,d}(\omega)$ 按真实规则斜率 $-0.3 / \text{marketDepth}(i)$ 内生传播至下一岛日 $d+1$ 的情景报价 $P_{d+1}(\omega)$。

### 2.2 状态、事件轴与真实规则边界
设滚动规划窗口包含离散事件桶 $b \in \{0, 1, \dots, B-1\}$，对应严格递增时间点 $t_0 < t_1 < \dots < t_{B-1} < t_B = t_0 + H$，在自然日 `00:00` 零点、岛日切换边界 `b12NextIsleBoundary`、长夜 `22:00 / 08:00`（长夜仅冻结岛钟，绝不暂停自然日、体力回复、作物生长或动物真实产出）、在田作物成熟/浇水点、动物产出/断粮点处精确切分桶。

在每个桶 $b$ 内，状态严格服从 `pet-world-rules.js`：
- 可用库存 $I_{b}[i, q] \ge 0$（已扣除 `b12.vault` 锁定库存，绝不动用预留仓）；
- 可用现金 $C_b \ge 0$ 与当日累计税基 `taxPaid`；
- 可用体力 $E_b \ge 0$ 与回复相位 `enT`：**严格区分 `eat`/`tide_snack`/自然回复受 `energyMax(s)` 上限截断，而 `coffee` 与 `upgrade('house')` 允许合法突破 `energyMax(s)`**；
- 农田槽位 `plots[0..plotN-1]`、畜栏 `barn[0..barnN-1]`、蟹笼 `traps[0..trapN-1]`、工具等级 `tools`、守家/偷菜增益有效期 `b12.effects`；
- 全部配额与目标阈值一律从注入的 `rules` 目录动态读取（如 `WORLD.daily.craft/fish/mine/bomb/coffee`、`B12_SNACK.daily`、`CROP_TIERS`、`GOAL_POOL`）；运行边界按启动配置裁剪（全功能模式 `maxStealsPerIsleDay: null` 不设人为格数卡口；纯内政模式 `maxStealsPerIsleDay: 0` 关闭出访）。

所有用途满足严格逐桶守恒：
1. **库存守恒**：
   $$I_{b+1}[i, q] = I_b[i, q] + A^{\text{harvest}}_{b}[i, q] + A^{\text{barn}}_{b}[i, q] + A^{\text{trap/fish/mine/bomb}}_{b}[i, q] + A^{\text{buy/cargo/goal/steal}}_{b}[i, q] + \sum_{r: \text{out}(r)=(i,q)} x_{r,b} - \sum_{r} c^{\text{craft}}_{i,q,r,b} - z^{\text{sell}}_{i,q,b} - e^{\text{eat}}_{i,q,b} - u^{\text{use}}_{i,q,b} \ge 0$$
   其中加工消耗 $c^{\text{craft}}_{i,q,r,b}$ 严格遵循服务端 `q=0 -> q=1 -> q=2` 低星优先扣除语义，并在动作序列级验证先后顺序。
2. **工坊与配方链超边约束**：
   $$\sum_{r} x_{r, b} \le K^{\text{craft}}_{id(b)} - \text{usedCraft}_{id(b), <b}$$
   中间产物（如 `ingot`、`bomb`）在桶内按动作序真实生成并消耗工坊额度与体力（`ingot -> crown` 精确消耗 2 次工坊额度与 2 点体力）。
3. **自然日全星级共享阶梯与渐进税**：
   同一自然日 $nd$ 内，作物 $i$ 的总销量按动作顺序累计进同一 `sc_i` 计数器；桶内已选定的出售量按 `q=2 -> q=1 -> q=0` 吃高阶梯，并逐笔通过精确 `b12SaleQuote(wallet, paid, gross)` 计算税后实收。
4. **全历史非预知约束（Full Observation-History Non-Anticipativity）**：
   任意两个情景 $\omega_1, \omega_2 \in \Omega$ 在任意桶 $b$ 若拥有相同的已揭晓观察历史 $H_b(\omega_1) = H_b(\omega_2)$（例如在首个岛日切换点 `nextIsleAt` 之前的所有桶 $b$，未来外部供需尚未揭晓），策略树强制采取完全一致的动作决策 $\pi_b(\omega_1) = \pi_b(\omega_2)$；仅当跨越信息揭晓边界后才允许按已观察到的情景节点分支。
5. **编译失败零静默丢弃 & 未决 `unknown` 冻结**：
   - `compileExecutablePrefix` 对 `buckets[0]` 有序动作逐条沙箱验真；若任一计划动作验证失败，立即返回 `status: 'plan-invalid'` 阻断提交并触发重规划，绝不静默跳过失败动作继续执行残缺尾部。
   - 若账本存在尚未对账消除的 `unknown` 事务，除了冻结其可能跨越的所有岛日配额，控制器在获得新 `rev/serverNow` 完成状态对账前拒绝重复动用受影响资源。
6. **对偶符号与零启发式泄漏审计**：
   - 上界松弛中，容量不等式约束乘子严格满足 $\mu \ge 0$，流守恒等式乘子 $\nu \in \mathbb{R}$ 无符号限制；含随机转移的评估显式标注 `deterministicExact` 或 `conditionalScenarioExpectation`。
   - `model/objective.mjs` 仅包含纯规则结算的现金流与 `applyActions` 实证清算尾段（零启发式估分），彻底杜绝 `audit/*` 通过 `model/*` 间接继承生产启发式。

---

## 3. 模块职责映射表

| 模块路径 | 核心职责 | 依赖边界 |
| :--- | :--- | :--- |
| `model/rules-adapter.mjs` | 规则加载、SHA256 版本、动态目录提取（零硬编码 ID）、深拷贝精确转移、时钟/日界计算、随机动作检测 | 仅依赖 `rules/pet-world-rules.js` |
| `model/observations.mjs` | 观察快照校验、供需区间反推（$S$ 与 $S/1.06$ 分离）、多场景未来价格树、对手胜负区间、用户硬约束模型 | 仅依赖 `model/rules-adapter.mjs` |
| `model/objective.mjs` | 续期目标 $W$、实证可执行终端清算尾段、$H$ 稳定性诊断与滚动延期探针 | 仅依赖 `model/*` |
| `planner/resources.mjs` | 事件轴切分、跨期资源账本、动作级精确材料束/体力/配额传播 | 依赖 `model/*` |
| `planner/bounds.mjs` | 弱对偶拉格朗日松弛上界 $U(\mu)$（内层精确 $\sup$；裁剪时强制返回 `null`） | 依赖 `model/*`, `planner/resources.mjs` |
| `planner/solve.mjs` | 唯一主规划求解器（构造可行下界 + 局部增广交换/分支定界搜索跨期联合计划 $\Pi^*$，含访问背包 $\Delta W$ 统一重算） | 依赖 `model/*`, `planner/*` |
| `planner/compile-prefix.mjs` | 从 $\Pi^*.\text{buckets}[0]$ 编译动作前缀、沙箱验真、首随机动作截断 | 依赖 `model/*` |
| `execution/reconcile.mjs` | 跨进程锁、幂等 `operation` 账本、跨岛日 `unknown` 预算保守占用、真实回执对账 | 依赖 `model/*`, `audit/journal.mjs` |
| `audit/journal.mjs` | 内容寻址前后快照、规则源码归档、`wait` 决策记录、白名单脱敏 | 仅依赖 Node 内置库 |
| `audit/replay.mjs` | 独立回放对账、物理与经济账本守恒检验、模型漂移报警 | 仅依赖 `model/*`, `audit/journal.mjs` |
| `audit/reference-solver.mjs` | 独立全合法动作枚举、微型精确穷举/分支定界解、全规模独立反事实轨迹搜索 | **严禁导入 `planner/*`**；仅依赖 `model/*` |
| `audit/report.mjs` | 可识别 `R_lower`、轨迹估计差、计划兑现偏差、事后机会差、`not-identifiable` 分级报告 | 仅依赖 `model/*`, `audit/*` |
| `cli/controller.mjs` | 唯一统一主控制器入口（驱动单步决策、事务执行与离线实盘影子对撞） | 依赖全部顶层模块 |
