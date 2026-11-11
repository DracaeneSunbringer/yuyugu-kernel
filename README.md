# 鱼鱼谷自动化内核 (yuyugu-kernel)

面向 `52dmeme.com` 宠物世界（鱼鱼谷）的全自动托管程序，基于 Node.js 原生模块实现，无任何第三方依赖。

覆盖农田种植、牧场养殖、工坊加工、货船采购、行情出货、体力调配、挖矿钓鱼、邻居出访、宠物养成、竞技场配装及每日幻彩。

## 快速开始

### 1. 环境要求

仅需安装 **Node.js >= 22**（无需 `npm install`）：

```bash
git clone https://github.com/DracaeneSunbringer/yuyugu-kernel.git
cd yuyugu-kernel
node -v
```

可选执行测试集验证本地环境：

```bash
npm test
```

### 2. 配置 Cookie

浏览器登录 `https://52dmeme.com/pets`，按 `F12` 打开开发者工具获取登录 `sid`：
- **方式 A（Network）**：打开 `Network` 面板，任选一个 `/api/pet/world` 请求，复制请求头中的 `Cookie`（形如 `sid=xxxx`）；
- **方式 B（Application）**：打开 `Application -> Cookies -> https://52dmeme.com`，复制 `sid` 对应的 `Value`（程序会自动补全 `sid=` 前缀）。

将 `.session.example.json` 复制为 `.session.json` 并填入（`.gitignore` 已默认忽略所有 `.session*.json`）：

```json
{
  "cookie": "sid=粘贴你的sid值"
}
```

### 3. 只读预检

首次启动前建议执行一次只读检查（`--dry-run` 在底层拦截所有非 `GET` 请求，不会改动账号状态）：

```bash
node cli/live-daemon.mjs --dry-run --once
```

输出 JSON 中 `controllerStatus` 为 `"shadow-ready"` 即表示登录态与规划正常。

## 部署运行

### Linux / macOS 后台运行

```bash
mkdir -p logs/live
nohup node cli/live-daemon.mjs \
  --self-ids 你的UID \
  </dev/null >> logs/live/live-daemon.main.out 2>&1 &
```

- 发育期如需自动买地、扩建谷仓与升级工具（仅在预计回本周期 `<= 72h` 时触发），加上 `--allow-capex`。
- 若只运行本岛生产、不扫描邻居也不出访偷菜，加上 `--domestic-only`。

### systemd 常驻守护（Linux 推荐）

新建 `~/.config/systemd/user/yuyugu.service`：

```ini
[Unit]
Description=Yuyugu Kernel
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/yuyugu-kernel
ExecStart=/usr/bin/node cli/live-daemon.mjs --self-ids 你的UID
Restart=always
RestartSec=10
StandardOutput=append:/path/to/yuyugu-kernel/logs/live/live-daemon.main.out
StandardError=append:/path/to/yuyugu-kernel/logs/live/live-daemon.main.out

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now yuyugu.service
```

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force logs/live | Out-Null
Start-Process node `
  -ArgumentList "cli/live-daemon.mjs --self-ids 你的UID" `
  -RedirectStandardOutput "logs/live/live-daemon.main.out" `
  -RedirectStandardError "logs/live/live-daemon.main.err" `
  -WindowStyle Hidden
```

### 常用参数与日常维护

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--session <path>` | `./.session.json` | 指定 Cookie 文件路径 |
| `--self-ids <id>` | 空 | 自身数字 UID，巡检出访时自动跳过 |
| `--domestic-only` | 关 | 纯内政模式，不拉取邻居列表、不执行出访 |
| `--allow-capex` | 关 | 回本周期合理时自动买地与升级建筑、工具 |
| `--no-capex` | 关 | 强制关闭自动买地与基建升级 |
| `--data-dir <dir>` | `./logs/live` | 日志、排期表、对手面板与文件锁目录 |
| `--dry-run` | 关 | 只读模式，拦截一切 `POST` 请求 |
| `--once` | 关 | 执行单轮后打印结果并退出 |

查看日志与优雅停止：

```bash
tail -f logs/live/live-daemon.main.out
kill -TERM $(cat logs/live/live-daemon.main.pid)
```

## 收益来源

鱼鱼谷的工坊次数、每日全价出货额度、体力和货船库存彼此制约，按固定优先级拆开执行容易浪费稀缺配额。本程序将各模块放在同一套估值下统一调度，主要收益来自五部分：

1. **工坊配额与货船差价**  
   工坊每岛日（4 小时，`22:00–08:00` 静潮期停表）限加工 80 次。程序按单位工坊次数和体力的净增值对全部配方（含多步合成链路）排序，优先排果酱、果酒、爆米花、皇冠等高毛利产物，避免被面粉、沙拉占满额度。当工坊尚有余量且货船刷出低价玉米、小麦、矿石、羊毛时，自动买入原料加工赚取差价；80 次用满后自动停止按加工价采购。

2. **跨期报价与星级分流**  
   收购价每 4 小时轮换，单日出售过多会触发 `100% -> 85% -> 70%` 阶梯折价，单轮抛售过猛还会压低次轮价格。程序结合当前报价与在途产量决定出货时机：若次日产量已够填满次日全价档，当期遇到高价即落袋，避免拖到次日掉入折价档。由于工坊成品不继承原料星级，出售原作物时按 `金星 -> 银星 -> 普通` 优先吃满全价额度，普通品质留给工坊加工。

3. **体力边际核算与预留**  
   挖矿（含买炸弹）、钓鱼、工坊和出访共用体力。程序实时比较 1 点体力的边际产出与仓库作物、货船食物、咖啡（15,000 金币，可突破体力上限）的单点成本，仅在净收益为正时补体。临近计划出访时间会自动锁住所需保底体力，防止被挖矿提前耗空。

4. **保护期卡点出访与期望过滤**  
   邻居作物成熟后有 30 分钟保护期。后台巡检记录解锁时间，临近解锁前自动中断耗时计算、补足体力、切换克制装备并准时发包。对有守卫的岛屿，综合计算未发现（2 倍）、战胜（3 倍）、平局、战败罚款及盗贼道具成本的数学期望，负期望目标直接跳过；出访结束后自动切回驻守防御装。

5. **养成、针对性配装与日常保底**  
   自动完成宠物喂食、清洁、互动、开箱与攻速断点加点；竞技场与守卫战前根据历史记录中的对手属性，在本地模拟选出最高胜率配装；每日按 `22:30` 开奖周期自动检查并购买一注 10 金币幻彩保底。

## 规则更新与目录结构

代码中未硬编码任何物品或配方 ID，所有数值均在启动时从 `rules/pet-world-rules.js` 动态解析。若站点前端更新了规则文件，直接覆盖 `rules/pet-world-rules.js` 并重启进程即可生效。

```text
cli/               守护进程入口（live-daemon / shadow-daemon）与单步控制器
planner/           种植、工坊、出货、体力与出访联合规划求解
execution/         HTTP 限流与时钟校准、事务对账、出访调度、战斗配装模拟
model/             规则解析与资产估值
audit/             本地事务流水记录与复盘工具
rules/             游戏前端规则文件
test/              自动化测试集（52 项）
architecture.html  交互式系统架构与时序图谱（浏览器直接打开）
```

## License

[MIT](./LICENSE)。仅供个人学习与技术交流，请合理控制请求频率并自行承担账号使用风险。
