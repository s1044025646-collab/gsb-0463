import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LambdaError, type ErrorCode } from "./errors.js";
import { LIMITS, STRATEGY_VERSION } from "./limits.js";
import { Store, type AnalysisRow } from "./db.js";
import { alphaEquivalent, canonical, freeVars, reduce, substitute } from "./lambda.js";
import { assertWithinInputLimits, nodeCount, parseTerm, validateTerm } from "./validate.js";
import type { Rename, Term } from "./types.js";

const DATA_DIR = process.env.LAMBDA_DATA_DIR
  ? resolve(process.env.LAMBDA_DATA_DIR)
  : resolve(process.cwd(), "data");
const DB_PATH = resolve(DATA_DIR, "lambda.db");

export const store = new Store(DB_PATH);

type JsonResponse = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: JsonResponse): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.maxInputBytes) {
      throw new LambdaError(
        "INPUT_TOO_LARGE",
        `请求体超过限制 ${LIMITS.maxInputBytes} 字节`
      );
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LambdaError("BAD_REQUEST", "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof LambdaError) throw e;
    throw new LambdaError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

// 从 { term: 对象 | 字符串 } 读取并校验项。
function termFrom(body: Record<string, unknown>, field = "term"): Term {
  if (!(field in body)) throw new LambdaError("INVALID_TERM", `缺少字段 ${field}`);
  const value = body[field];
  const t =
    typeof value === "string" ? parseTerm(value) : validateTerm(value);
  assertWithinInputLimits(t, JSON.stringify(t).length);
  return t;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new LambdaError("BAD_REQUEST", `字段 ${field} 必须是非空字符串`);
  }
  return v;
}

function requireBudget(v: unknown, field = "maxSteps"): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new LambdaError("BUDGET_INVALID", `字段 ${field} 必须是非负整数`);
  }
  if (v > LIMITS.maxBudget) {
    throw new LambdaError("BUDGET_TOO_LARGE", `字段 ${field} 超过上限 ${LIMITS.maxBudget}`);
  }
  return v;
}

function requireId(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new LambdaError("BAD_REQUEST", `字段 ${field} 必须是正整数`);
  }
  return v;
}

function storedStepToJson(raw: ReturnType<Store["getSteps"]>[number]) {
  return {
    stepIndex: raw.stepIndex,
    path: JSON.parse(raw.pathJson) as (string | number)[],
    replacedVar: raw.replacedVar,
    renames: JSON.parse(raw.renamesJson) as Rename[],
    before: JSON.parse(raw.beforeJson) as Term,
    after: JSON.parse(raw.afterJson) as Term,
  };
}

function analysisJson(a: AnalysisRow) {
  return {
    id: a.id,
    termId: a.termId,
    strategyVersion: a.strategyVersion,
    maxSteps: a.maxSteps,
    status: a.status,
    stepsUsed: a.stepsUsed,
    redexRemaining: a.redexRemaining === 1,
    finalTerm: a.finalTerm,
    error: a.errorCode ? { code: a.errorCode, message: a.errorMessage } : null,
    createdAt: a.createdAt,
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, strategyVersion: STRATEGY_VERSION, dataDir: DATA_DIR });
    return;
  }

  // ---- 无状态分析 ----
  if (method === "POST" && path === "/api/free-vars") {
    const body = await readJson(req);
    const t = termFrom(body);
    sendJson(res, 200, { freeVars: freeVars(t) });
    return;
  }

  if (method === "POST" && path === "/api/substitute") {
    const body = await readJson(req);
    const t = termFrom(body, "term");
    const name = requireString(body.name, "name");
    const arg = termFrom(body, "arg");
    const result = substitute(name, arg, t);
    if (nodeCount(result) > LIMITS.maxIntermediateNodes) {
      throw new LambdaError(
        "INTERMEDIATE_TOO_LARGE",
        `替换结果超过中间结果限制 ${LIMITS.maxIntermediateNodes}`
      );
    }
    sendJson(res, 200, { term: result });
    return;
  }

  if (method === "POST" && path === "/api/alpha-equivalent") {
    const body = await readJson(req);
    const a = termFrom(body, "a");
    const b = termFrom(body, "b");
    sendJson(res, 200, {
      alphaEquivalent: alphaEquivalent(a, b),
      canonicalA: canonical(a),
      canonicalB: canonical(b),
    });
    return;
  }

  // ---- 持久化：导入项 ----
  if (method === "POST" && path === "/api/terms") {
    const body = await readJson(req);
    const t = termFrom(body);
    const label = body.label === undefined ? null : requireString(body.label, "label");
    const id = store.insertTerm(t, label);
    sendJson(res, 201, { id, term: t, label, freeVars: freeVars(t) });
    return;
  }

  const termMatch = path.match(/^\/api\/terms\/(\d+)$/);
  if (method === "GET" && termMatch) {
    const id = Number(termMatch[1]);
    const row = store.getTerm(id);
    if (!row) throw new LambdaError("NOT_FOUND", `项 ${id} 不存在`);
    sendJson(res, 200, {
      id: row.id,
      label: row.label,
      term: row.term,
      freeVars: freeVars(row.term),
      createdAt: row.createdAt,
    });
    return;
  }

  // ---- 创建归约（幂等：同 term + 同预算复用已有分析，绝不追加步数）----
  if (method === "POST" && path === "/api/reductions") {
    const body = await readJson(req);
    const termId = requireId(body.termId, "termId");
    const maxSteps = requireBudget(body.maxSteps);
    const termRow = store.getTerm(termId);
    if (!termRow) throw new LambdaError("NOT_FOUND", `项 ${termId} 不存在`);

    const existing = store.findAnalysis(termId, maxSteps);
    if (existing) {
      sendJson(res, 200, { idempotent: true, analysis: analysisJson(existing) });
      return;
    }

    let status;
    let result;
    try {
      result = reduce(termRow.term, maxSteps);
      status = 201;
    } catch (e) {
      if (e instanceof LambdaError && e.code === "INTERMEDIATE_TOO_LARGE") {
        // 失败分析单独落库：步数不提交，终态保留为上一步完整树（此处即原项）。
        const id = store.createAnalysis(
          termId,
          STRATEGY_VERSION,
          maxSteps,
          "budget_exhausted",
          termRow.term,
          [],
          { code: e.code, message: e.message }
        );
        const row = store.getAnalysis(id)!;
        sendJson(res, 422, { idempotent: false, analysis: analysisJson(row) });
        return;
      }
      throw e;
    }
    const id = store.createAnalysis(
      termId,
      STRATEGY_VERSION,
      maxSteps,
      result.status,
      result.final,
      result.steps,
      null
    );
    const row = store.getAnalysis(id)!;
    sendJson(res, status, { idempotent: false, analysis: analysisJson(row) });
    return;
  }

  const reductionMatch = path.match(/^\/api\/reductions\/(\d+)$/);
  if (method === "GET" && reductionMatch) {
    const id = Number(reductionMatch[1]);
    const a = store.getAnalysis(id);
    if (!a) throw new LambdaError("NOT_FOUND", `归约分析 ${id} 不存在`);
    sendJson(res, 200, analysisJson(a));
    return;
  }

  const stepsMatch = path.match(/^\/api\/reductions\/(\d+)\/steps$/);
  if (method === "GET" && stepsMatch) {
    const id = Number(stepsMatch[1]);
    if (!store.getAnalysis(id)) {
      throw new LambdaError("NOT_FOUND", `归约分析 ${id} 不存在`);
    }
    // 分页只读，不继续执行。
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 500);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? "0") || 0, 0);
    const total = store.countSteps(id);
    const steps = store.getSteps(id, limit, offset).map(storedStepToJson);
    sendJson(res, 200, { analysisId: id, total, limit, offset, steps });
    return;
  }

  // ---- 导出 ----
  if (method === "GET" && path.startsWith("/api/export/")) {
    const id = Number(path.split("/").pop());
    const a = store.getAnalysis(id);
    if (!a) throw new LambdaError("NOT_FOUND", `归约分析 ${id} 不存在`);
    const termRow = store.getTerm(a.termId)!;
    const steps = store.getSteps(id, LIMITS.maxBudget, 0).map(storedStepToJson);
    sendJson(res, 200, {
      originalTerm: termRow.term,
      strategyVersion: a.strategyVersion,
      maxSteps: a.maxSteps,
      status: a.status,
      stepsUsed: a.stepsUsed,
      redexRemaining: a.redexRemaining === 1,
      finalTerm: a.finalTerm,
      error: a.errorCode ? { code: a.errorCode, message: a.errorMessage } : null,
      steps,
      exportedAt: new Date().toISOString(),
    });
    return;
  }

  sendJson(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${method} ${path}` } });
}

export function createApp(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof LambdaError) {
        const httpStatus =
          e.code === "NOT_FOUND"
            ? 404
            : e.code === "INTERMEDIATE_TOO_LARGE"
              ? 422
              : 400;
        sendJson(res, httpStatus, { error: { code: e.code, message: e.message, details: e.details } });
      } else {
        sendJson(res, 500, {
          error: { code: "BAD_REQUEST", message: e instanceof Error ? e.message : "内部错误" },
        });
      }
    });
  });
}

function isMain(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  const port = Number.isInteger(requested) && requested >= 0 ? requested : 0;
  const server = createApp();
  // 端口 0：由操作系统选择空闲端口（默认行为）。
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const actual = typeof addr === "object" && addr ? addr.port : port;
    console.log(`[lambda] 服务已启动: http://127.0.0.1:${actual}`);
    console.log(`[lambda] 数据目录: ${DATA_DIR}`);
    console.log(`[lambda] 策略版本: ${STRATEGY_VERSION}`);
  });
}
