# 无类型 Lambda 项分析后端（TypeScript + Node.js + SQLite）

教学用的**无类型 lambda 演算**分析服务，只提供 HTTP API 与命令行（CLI），无前端、无文本语法、
无字节码、无算术扩展、无通用脚本执行。项以 JSON 树表示：

```jsonc
{ "kind": "var", "name": "x" }
{ "kind": "lam", "param": "x", "body": <Term> }      // λx.body
{ "kind": "app", "fn": <Term>, "arg": <Term> }       // fn arg
```

功能：查看自由变量、**捕获避免替换**（含确定性 alpha 改名及原因）、alpha 等价比较、
按**最左最外正常序**逐步 beta 归约到完整正规形。所有分析持久化到项目内 SQLite，
服务重启后每一步的路径、被替换变量、改名记录仍可查询。

## 运行环境

- Windows、PowerShell；Node.js **v22.5+**（本项目在 v25 验证），使用内置实验模块 `node:sqlite`，
  **无需** Docker、WSL、Visual Studio 编译工具或任何外部在线服务，运行时依赖为零。
- 首次使用安装一次开发依赖（TypeScript 与 Node 类型定义，仅构建/测试需要）：

```powershell
npm install
```

## 构建 / 测试 / 启动 / 演示

```powershell
npm run build     # tsc 编译到 dist/
npm test          # 编译并运行 node --test（20 个测试，含 API 集成测试）
npm start         # 启动 HTTP API（默认端口 0 = 系统选择空闲端口，启动日志打印实际端口）
npm run demo      # 构建并跑通题目要求的 5 个端到端示例（数据写入 ./data）

# CLI（构建后可用）
node dist/src/cli.js --help
```

指定端口与数据目录：

```powershell
$env:PORT="8080"; $env:LAMBDA_DATA_DIR="./data"; npm start
```

## 语义说明

### beta 归约与作用域

- beta 规则：`(λx.body) arg → body[x:=arg]`。
- 替换只作用于 `body` 中 **x 的自由出现**；进入绑定 x 的内层抽象时**停止**。
- 内层同名绑定**遮蔽**外层：改外层绑定的名字不会触碰内层同名绑定及其出现。
- 仅有自由变量、抽象体、或不可归约应用都是合法项，**不报“未定义变量”**。

### 捕获避免改名（固定规则、可复现）

当需要进入 `λy.M`，且：

1. `y` 是待插入 `arg` 的自由变量，并且
2. `M` 中仍有需要替换的自由 `x`，

则先把该 `y` 绑定、以及**仅由它绑定的出现**一致改成新名字，再继续替换。新名字：

- 优先尝试 `y` 本身；冲突时依次尝试 `y_1`、`y_2`……
- 候选名必须避开“被改名函数体 + 待插入项”中出现的**所有名字**。

该规则是确定的：同样的输入永远得到同样的轨迹，不依赖随机数或全局计数器。
改名是**这一步替换的一部分**，记录在该 beta 步的 `renames` 中（含绑定位置与原因），
**不单独消耗 beta 预算**。原始项始终保留用户给的名字，改名只出现在归约结果里。

### 正常序（最左最外）

每个 beta 步在**本步开始的项**上按以下优先级选 redex，路径随之每步重新计算：

1. 当前应用本身：若 `fn` 是抽象，立即归约（**不预先计算将被丢弃的参数**）；
2. 否则递归 `fn` 侧，再递归 `arg` 侧；
3. 当前项是抽象时，进入其 `body` 内部归约。

因此可求到**完整 beta 正规形**，而不是弱头正规形（WHNF）。

### 预算（不是停机判定器）

- 用户给定最大 beta 步数（非负整数）。alpha 改名不消耗额度。
- 预算用完后**再次检查**当前项：已无 redex → 状态 `normal`；仍有 redex → 状态
  `budget_exhausted`，保留当前项。
- 预算为 0 时：项已正规则 `normal`，否则 `budget_exhausted`。
- 本服务**不断言一个项是否永不停机**；`budget_exhausted` 只表示“在给定步数内未完成”，
  例如 Omega 会稳定地耗尽任何有限预算。

### 规模限制（超限本步不提交）

默认限制可用环境变量覆盖：

| 限制 | 默认值 | 环境变量 |
| --- | --- | --- |
| 输入字节 | 65536 | `LAMBDA_MAX_INPUT_BYTES` |
| 树深度 | 200 | `LAMBDA_MAX_DEPTH` |
| 导入节点数 | 20000 | `LAMBDA_MAX_NODES` |
| 单步/中间结果节点数 | 200000 | `LAMBDA_MAX_INTERMEDIATE_NODES` |
| 最大预算 | 1000000 | `LAMBDA_MAX_BUDGET` |

复制导致中间结果超限的那一步**不提交**，保留上一步完整树，返回错误码
`INTERMEDIATE_TOO_LARGE`（HTTP 422），失败分析与正常分析以错误字段区分落库。

## Alpha 等价的规范表示

内部使用基于**绑定索引（de Bruijn 索引）**的独立规范表示交叉核对：

- 绑定变量引用规范化为“到最近同名绑定的深度”`B<index>`；
- 自由变量保留名字 `F<name>`。

因此 alpha 等价只允许一致重命名绑定变量；**自由变量名字必须相同**。
`/api/alpha-equivalent` 同时返回两侧的规范表示以便教学核对。

## HTTP API

监听 `127.0.0.1`。`term` 字段接受 JSON 对象（也接受 JSON 字符串）。

无状态分析：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/free-vars` | `{term}` → 自由变量（排序确定） |
| POST | `/api/substitute` | `{term,name,arg}` → 捕获避免替换结果 |
| POST | `/api/alpha-equivalent` | `{a,b}` → 是否等价 + 双侧规范表示 |

持久化分析：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/terms` | 导入项 `{term,label?}` → `id` |
| GET | `/api/terms/:id` | 读取原项（原树不被覆盖） |
| POST | `/api/reductions` | `{termId,maxSteps}` 创建归约 |
| GET | `/api/reductions/:id` | 读取状态/终态（**不继续执行**） |
| GET | `/api/reductions/:id/steps?limit=&offset=` | 分页读取逐步记录 |
| GET | `/api/export/:id` | 导出原项 + 策略版本 + 全部步 + 终态 |
| GET | `/health` | 健康检查 |

关键行为：

- **修改原项 = 新建 term**；分析挂在具体 term 上，旧轨迹永不被覆盖。
- 同 `termId + maxSteps` 的创建请求**幂等**：复用已有分析，不会多走几步。
- 读取状态与分页**只读**，不触发继续归约。
- 不同预算产生相互独立的分析记录。

每一步记录：

```jsonc
{
  "stepIndex": 1,
  "path": [],                       // 选中 redex 的路径，相对本步开始项；根为 []
  "replacedVar": "x",
  "renames": [                      // 本步替换内的 alpha 改名（不另耗预算）
    { "binderPath": [], "from": "y", "to": "y_1", "reason": "绑定变量 y 会捕获…" }
  ],
  "before": { /* 本步前完整树 */ },
  "after":  { /* 本步后完整树 */ }
}
```

路径段为 `"fn" | "arg" | "body"`，数字不出现（数组不用作树节点）。

### 错误码

`INVALID_JSON`、`INVALID_TERM`、`NAME_REQUIRED`、`NAME_TOO_LONG`、`TREE_TOO_DEEP`、
`TOO_MANY_NODES`、`INPUT_TOO_LARGE`、`INTERMEDIATE_TOO_LARGE`、`BUDGET_INVALID`、
`BUDGET_TOO_LARGE`、`NOT_FOUND`、`IDEMPOTENT_MISMATCH`、`BAD_REQUEST`。

## CLI 示例

```powershell
# 项可用内联 JSON（PowerShell 下建议用单引号包裹）、@文件，或已导入项的数字 id
node dist/src/cli.js free-vars '@examples/sample-lam.json'
node dist/src/cli.js import '@examples/sample-lam.json' --label demo
node dist/src/cli.js substitute '@examples/sample-lam.json' x '{"kind":"var","name":"q"}'
node dist/src/cli.js alpha-eq '{"kind":"lam","param":"a","body":{"kind":"var","name":"a"}}' '{"kind":"lam","param":"b","body":{"kind":"var","name":"b"}}'
node dist/src/cli.js reduce '@examples/sample-lam.json' 10
node dist/src/cli.js reduction 1
node dist/src/cli.js steps 1 --limit 1 --offset 0
node dist/src/cli.js export 1
node dist/src/cli.js serve --port 8080
```

## 四个关键示例（`npm run demo` 实跑）

1. `(λx.λy.x) y`：第一步记录改名 `y → y_1`，结果 `λy_1.y`，与 `λz.y` **alpha 等价**，
   其中 `y` 仍自由。
2. `(λx.λx.x) y`：内层 `λx.x` 被遮蔽而保留，结果 `λx.x`，无自由变量。
3. `Omega = (λx.x x)(λx.x x)`：任何有限预算都以 `budget_exhausted` 停止并保留当前项。
4. `(λx.z) Omega`：正常序**一步**得到自由变量 `z`，参数 Omega 从未被归约（不预计算丢弃项）。

测试另覆盖：多层遮蔽、参数含多个自由变量的连续改名、根节点与深层 redex 路径、
零步预算、以及“刚好最后一步到达正规形”。

## 项目结构

```
src/
  types.ts      项与归约数据类型
  limits.ts     规模限制与策略版本 normal-order-v1
  errors.ts     错误码
  validate.ts   JSON 解析与树校验
  lambda.ts     自由变量 / 捕获避免替换 / 规范表示 / alpha 等价 / 正常序归约
  db.ts         node:sqlite 持久化（terms / analyses / steps）
  server.ts     HTTP API（默认空闲端口）
  cli.ts        命令行
scripts/demo.ts 端到端演示
test/           语义单测 + HTTP 集成测试
examples/       样例 JSON 项
data/           运行后生成：lambda.db（SQLite，WAL）
```

## 已知限制

- 依赖 Node 内置实验模块 `node:sqlite`（会打印 ExperimentalWarning）；后续 Node 版本 API 若变化
  可能需要小幅调整。无第三方原生依赖，故不需要编译工具链。
- 归约深度与结果规模受上表限制保护；超限步不提交。
- 本服务是**有预算的逐步执行器**，不是停机判定器：它报告“预算内是否到达正规形”，
  不会也不可能判定任意项是否永不停机。
