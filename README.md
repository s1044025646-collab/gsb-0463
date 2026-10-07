# 无类型 Lambda 项分析服务（教学用）

一个纯后端的捕获避免替换与 beta 归约服务：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker、无外部服务）。只提供 HTTP API 与 CLI，不含文本语法解析、字节码或类型系统。

## 项的 JSON 表示

```json
{ "kind": "var", "name": "x" }
{ "kind": "lam", "param": "x", "body": <term> }
{ "kind": "app", "fn": <term>, "arg": <term> }
```

只有自由变量、抽象或不可归约应用的项都是合法输入，不报"未定义变量"。

## 快速开始（Windows，Node >= 22.5，建议 24+）

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试
npm start          # 启动 HTTP 服务（默认自动选择空闲端口，--port 指定）
node demo/demo.js  # 运行四个演示场景
```

数据目录为项目内 `data/`（可用 `--db` 或环境变量 `LAMBDA_DB` 覆盖），端口用 `--port` 或 `PORT` 配置，默认 `0`（操作系统分配空闲端口），启动时会打印实际端口。

## 核心语义

### 捕获避免替换 `body[x := arg]`

- 只替换 `body` 中 `x` 的**自由出现**；遇到绑定 `x` 的内层抽象立即停止。
- 需要进入 `λy.M` 且 `y ∈ FV(arg)`、`M` 中仍有自由 `x` 时，先把该 `y` 绑定及**仅由它绑定的出现**一致改名（内层同名绑定因遮蔽而保持不变），再继续替换。
- 新名字按固定规则生成：依次尝试 `a..z`，再 `a1..z1`、`a2..z2`……取第一个未在相关项（被进入的 body 与 arg 的全部名字）中出现的名字。规则确定，同一输入永远得到同一轨迹。
- 每次改名记录 `{path, oldName, newName, reason}`，路径相对本步开始时的项。

### alpha 等价

内部转换为 de Bruijn 索引比较：绑定变量只看绑定结构，自由变量名称必须完全相同。测试中用一份独立手写的 de Bruijn 规范实现交叉核对。

### 正常序 beta 归约

每步选择**最左最外** redex：先看当前应用本身是否 redex，再递归函数侧、参数侧，最后进入抽象体内部（因此求的是完整 beta 正规形，不是弱头正规形）。不预先归约将被丢弃的参数——`(λx.z) Omega` 一步即得自由变量 `z`。

每步报告：节点路径（从本步开始时的项计算，不复用旧路径）、被替换变量、本步替换中发生的改名、归约后的项。

### 预算（不是停机判定器）

用户给定最大 beta 步数。alpha 改名是替换的一部分，**不消耗** beta 额度。额度用完后检查当前项：已无 redex 则状态为 `normal_form`（正常完成），否则为 `budget_exhausted` 并保留当前项——这**不**表示该项永不停止，只是预算用完了。本服务是有预算的执行器，不做停机判定。

### 资源限制

限制树深度（200）、节点数（10000）、输入字节（256KB）、中间结果节点数（50000），均可通过 `Service` 构造参数调整。若某一步的结果会超过中间结果上限，该步**不提交**，保留上一步完整树，分析状态置为 `failed`（与正常得到正规形的 `normal_form` 区分），并记录明确原因。

## HTTP API

所有错误返回 `{ "error": { "code", "message" } }`。错误码：`INVALID_TERM`、`INVALID_JSON`、`INVALID_REQUEST`、`INVALID_BUDGET`、`TERM_NOT_FOUND`、`REDUCTION_NOT_FOUND`、`STEP_INDEX_MISMATCH`、`LIMIT_EXCEEDED`、`REDUCTION_FAILED`、`NOT_FOUND`、`INTERNAL`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/terms` | 导入项，body `{term}`，返回 `{id}` |
| GET | `/terms/:id` | 读取项 |
| GET | `/terms/:id/free-variables` | 自由变量（按首次自由出现、从左到右的确定顺序） |
| POST | `/substitute` | `{body, var, arg}` → `{result, renames}` |
| POST | `/alpha-equivalent` | `{a, b}` → `{equivalent}` |
| POST | `/reductions` | `{termId}` 或 `{term}` 加 `{budget}`，创建归约（不执行） |
| GET | `/reductions/:id?offset&limit` | 读取状态与分页步摘要；**读取不会推进归约** |
| POST | `/reductions/:id/step` | 执行恰好一步；body 可带 `expectedStepIndex` 实现幂等 |
| GET | `/reductions/:id/export` | 导出完整 JSON（原始树、策略版本、预算、全部步、终态） |

幂等性：重复提交相同 `expectedStepIndex` 的请求返回已存储的步（`alreadyCommitted: true`），不会多归约；索引不匹配返回 `STEP_INDEX_MISMATCH`。

归约状态：`running` / `normal_form` / `budget_exhausted` / `failed`。

## CLI

```powershell
node dist/cli.js serve --port 8080          # 启动 API（默认自动选空闲端口）
node dist/cli.js import examples/const-y.json
node dist/cli.js fv 1
node dist/cli.js subst --body a.json --var x --arg b.json
node dist/cli.js alpha a.json b.json
node dist/cli.js reduce --term examples/const-y.json --budget 10
node dist/cli.js step 1 --expected 0
node dist/cli.js show 1
node dist/cli.js export 1
```

## 持久化

SQLite 保存：导入的原始树、策略版本（`normal-order-beta-v1`）、预算、逐步摘要（路径、被替换变量、改名记录、结果树）与终态。对同一项再次归约会创建新的分析记录，不覆盖旧轨迹；服务重启后仍可查到当时的改名与步数。

## 演示与测试覆盖

`node demo/demo.js` 展示：

1. `(λx.λy.x) y` → 改名后与 `λz.y` alpha 等价，`y` 仍自由；
2. `(λx.λx.x) y` → 保留内层绑定 `λx.x`；
3. `Omega = (λx.x x)(λx.x x)` 在预算 3 下以 `budget_exhausted` 停止；
4. `(λx.z) Omega` 正常序一步得到自由变量 `z`。

测试（26 个）覆盖：多层遮蔽、参数含多个自由变量、根节点与深层 redex 的路径、零步额度、刚好最后一步到达正规形、幂等步、读取不推进、重启持久化、超限失败状态，以及用独立 de Bruijn 规范核对 alpha 等价与自由变量。

## 限制

- 仅 JSON 树输入，无文本语法；无类型、无算术、无通用脚本执行。
- `node:sqlite` 在 Node 25 仍标记为实验特性（会有启动警告），API 变化时需适配。
- 单进程服务，无并发归约锁之外的横向扩展设计；幂等依赖 `expectedStepIndex`。
