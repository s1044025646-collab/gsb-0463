#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LambdaError } from "./errors.js";
import { STRATEGY_VERSION } from "./limits.js";
import { Store } from "./db.js";
import { alphaEquivalent, freeVars, reduce, substitute } from "./lambda.js";
import { parseTerm } from "./validate.js";
import { createApp } from "./server.js";
import type { Term } from "./types.js";

const DATA_DIR = process.env.LAMBDA_DATA_DIR
  ? resolve(process.env.LAMBDA_DATA_DIR)
  : resolve(process.cwd(), "data");

function loadTerm(spec: string, store: Store): Term {
  // 纯数字视为已存储项的 id，@path 从文件读取，其余按内联 JSON 解析。
  if (/^\d+$/.test(spec)) {
    const row = store.getTerm(Number(spec));
    if (!row) throw new LambdaError("NOT_FOUND", `已存储项 ${spec} 不存在`);
    return row.term;
  }
  const json = spec.startsWith("@") ? readFileSync(spec.slice(1), "utf-8") : spec;
  return parseTerm(json);
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`无类型 Lambda 归约后端 CLI

用法: lambda <命令> [参数]

项的传入方式（除非另作说明）:
  内联 JSON        '{"kind":"var","name":"y"}'
  @文件路径         @term.json
  纯数字            引用已导入项的 id（需要数据库的命令）

命令:
  import <项> [--label 文本]            导入项，返回 id
  free-vars <项>                        查看自由变量（确定顺序）
  substitute <项> <变量名> <参数项>      捕获避免替换
  alpha-eq <项A> <项B>                  alpha 等价比较
  reduce <项> <最大步数>                创建归约并打印摘要与每步
  reduction <分析id>                    读取归约状态（不继续执行）
  steps <分析id> [--limit N] [--offset N]  分页读取步记录
  export <分析id>                       导出完整 JSON（原项/步/终态）
  serve [--port 端口]                   启动 HTTP API（默认空闲端口）

环境变量:
  PORT                 HTTP 端口（默认 0 = 系统选空闲端口）
  LAMBDA_DATA_DIR      数据目录（默认 ./data）
`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const { positional, flags } = parseFlags(rest);
  const store = new Store(resolve(DATA_DIR, "lambda.db"));

  try {
    switch (command) {
      case "import": {
        if (positional.length < 1) throw new LambdaError("BAD_REQUEST", "需要 <项>");
        const t = loadTerm(positional[0]!, store);
        const label = flags.label ?? null;
        const id = store.insertTerm(t, label);
        out({ id, label, term: t, freeVars: freeVars(t) });
        break;
      }
      case "free-vars": {
        if (positional.length < 1) throw new LambdaError("BAD_REQUEST", "需要 <项>");
        out({ freeVars: freeVars(loadTerm(positional[0]!, store)) });
        break;
      }
      case "substitute": {
        if (positional.length < 3) throw new LambdaError("BAD_REQUEST", "需要 <项> <变量名> <参数项>");
        const t = loadTerm(positional[0]!, store);
        const name = positional[1]!;
        const arg = loadTerm(positional[2]!, store);
        out({ term: substitute(name, arg, t) });
        break;
      }
      case "alpha-eq": {
        if (positional.length < 2) throw new LambdaError("BAD_REQUEST", "需要 <项A> <项B>");
        const a = loadTerm(positional[0]!, store);
        const b = loadTerm(positional[1]!, store);
        out({ alphaEquivalent: alphaEquivalent(a, b) });
        break;
      }
      case "reduce": {
        if (positional.length < 2) throw new LambdaError("BAD_REQUEST", "需要 <项> <最大步数>");
        const t = loadTerm(positional[0]!, store);
        const maxSteps = Number(positional[1]);
        if (!Number.isInteger(maxSteps) || maxSteps < 0) {
          throw new LambdaError("BUDGET_INVALID", "最大步数必须是非负整数");
        }
        const termId = /^\d+$/.test(positional[0]!) ? Number(positional[0]) : store.insertTerm(t, null);
        const result = reduce(t, maxSteps);
        const id = store.createAnalysis(
          termId,
          STRATEGY_VERSION,
          maxSteps,
          result.status,
          result.final,
          result.steps,
          null
        );
        out({
          analysisId: id,
          termId,
          status: result.status,
          stepsUsed: result.steps.length,
          redexRemaining: result.redexRemaining,
          finalTerm: result.final,
          steps: result.steps.map((s) => ({
            stepIndex: s.index,
            path: s.path,
            replacedVar: s.replacedVar,
            renames: s.renames,
            after: s.after,
          })),
        });
        break;
      }
      case "reduction": {
        const id = Number(positional[0]);
        const a = store.getAnalysis(id);
        if (!a) throw new LambdaError("NOT_FOUND", `分析 ${id} 不存在`);
        out({
          id: a.id,
          termId: a.termId,
          strategyVersion: a.strategyVersion,
          maxSteps: a.maxSteps,
          status: a.status,
          stepsUsed: a.stepsUsed,
          redexRemaining: a.redexRemaining === 1,
          finalTerm: a.finalTerm,
          error: a.errorCode ? { code: a.errorCode, message: a.errorMessage } : null,
        });
        break;
      }
      case "steps": {
        const id = Number(positional[0]);
        if (!store.getAnalysis(id)) throw new LambdaError("NOT_FOUND", `分析 ${id} 不存在`);
        const limit = Math.min(Number(flags.limit ?? "100"), 500);
        const offset = Number(flags.offset ?? "0");
        const total = store.countSteps(id);
        const steps = store.getSteps(id, limit, offset).map((s) => ({
          stepIndex: s.stepIndex,
          path: JSON.parse(s.pathJson),
          replacedVar: s.replacedVar,
          renames: JSON.parse(s.renamesJson),
          before: JSON.parse(s.beforeJson),
          after: JSON.parse(s.afterJson),
        }));
        out({ analysisId: id, total, limit, offset, steps });
        break;
      }
      case "export": {
        const id = Number(positional[0]);
        const a = store.getAnalysis(id);
        if (!a) throw new LambdaError("NOT_FOUND", `分析 ${id} 不存在`);
        const termRow = store.getTerm(a.termId)!;
        const steps = store.getSteps(id, Number.MAX_SAFE_INTEGER, 0).map((s) => ({
          stepIndex: s.stepIndex,
          path: JSON.parse(s.pathJson),
          replacedVar: s.replacedVar,
          renames: JSON.parse(s.renamesJson),
          before: JSON.parse(s.beforeJson),
          after: JSON.parse(s.afterJson),
        }));
        out({
          originalTerm: termRow.term,
          strategyVersion: a.strategyVersion,
          maxSteps: a.maxSteps,
          status: a.status,
          stepsUsed: a.stepsUsed,
          redexRemaining: a.redexRemaining === 1,
          finalTerm: a.finalTerm,
          error: a.errorCode ? { code: a.errorCode, message: a.errorMessage } : null,
          steps,
        });
        break;
      }
      case "serve": {
        const port = Number(flags.port ?? process.env.PORT ?? "0");
        const server = createApp();
        server.listen(Number.isInteger(port) ? port : 0, "127.0.0.1", () => {
          const addr = server.address();
          console.log(
            `[lambda] http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`
          );
          console.log(`[lambda] 数据目录: ${DATA_DIR}`);
        });
        break;
      }
      default:
        usage();
    }
  } catch (e) {
    if (e instanceof LambdaError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message } }, null, 2));
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
