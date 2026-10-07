import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "lambda-api-"));
process.env.LAMBDA_DATA_DIR = dir;

const { createApp, store } = await import("../dist/src/server.js");
import type { Server } from "node:http";

let server: Server;
let base: string;

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

test("无状态接口：自由变量 / 替换 / alpha", async () => {
  const fv = await call("POST", "/api/free-vars", { term: { kind: "lam", param: "x", body: { kind: "var", name: "y" } } });
  assert.deepEqual(fv.json.freeVars, ["y"]);

  const sub = await call("POST", "/api/substitute", {
    term: { kind: "lam", param: "y", body: { kind: "var", name: "x" } },
    name: "x",
    arg: { kind: "var", name: "y" },
  });
  assert.deepEqual(sub.json.term, { kind: "lam", param: "y_1", body: { kind: "var", name: "y" } });

  const alpha = await call("POST", "/api/alpha-equivalent", {
    a: { kind: "lam", param: "x", body: { kind: "var", name: "x" } },
    b: { kind: "lam", param: "z", body: { kind: "var", name: "z" } },
  });
  assert.equal(alpha.json.alphaEquivalent, true);
});

test("导入、创建归约、分页读取与导出", async () => {
  const omega = {
    kind: "app",
    fn: { kind: "lam", param: "x", body: { kind: "app", fn: { kind: "var", name: "x" }, arg: { kind: "var", name: "x" } } },
    arg: { kind: "lam", param: "x", body: { kind: "app", fn: { kind: "var", name: "x" }, arg: { kind: "var", name: "x" } } },
  };
  const imp = await call("POST", "/api/terms", { term: omega, label: "omega" });
  assert.equal(imp.status, 201);
  const termId = imp.json.id as number;

  const created = await call("POST", "/api/reductions", { termId, maxSteps: 3 });
  assert.equal(created.status, 201);
  assert.equal((created.json.analysis as { status: string }).status, "budget_exhausted");
  const analysisId = (created.json.analysis as { id: number }).id;

  // 幂等：重复请求复用，不多归约
  const again = await call("POST", "/api/reductions", { termId, maxSteps: 3 });
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);
  assert.equal((again.json.analysis as { id: number }).id, analysisId);
  assert.equal((again.json.analysis as { stepsUsed: number }).stepsUsed, 3);

  // 分页只读
  const page = await call("GET", `/api/reductions/${analysisId}/steps?limit=2&offset=0`);
  assert.equal((page.json.steps as unknown[]).length, 2);
  assert.equal(page.json.total, 3);

  const page2 = await call("GET", `/api/reductions/${analysisId}/steps?limit=2&offset=2`);
  assert.equal((page2.json.steps as unknown[]).length, 1);

  const exported = await call("GET", `/api/export/${analysisId}`);
  assert.equal((exported.json.steps as unknown[]).length, 3);
  assert.equal(exported.json.strategyVersion, "normal-order-v1");
});

test("不同预算创建独立分析，旧轨迹保留", async () => {
  const term = { kind: "lam", param: "x", body: { kind: "var", name: "x" } };
  const imp = await call("POST", "/api/terms", { term });
  const termId = imp.json.id as number;
  const a1 = await call("POST", "/api/reductions", { termId, maxSteps: 0 });
  const a2 = await call("POST", "/api/reductions", { termId, maxSteps: 5 });
  assert.notEqual((a1.json.analysis as { id: number }).id, (a2.json.analysis as { id: number }).id);
  assert.equal((a1.json.analysis as { status: string }).status, "normal");
});

test("错误码：非法项、未知资源、预算非法", async () => {
  const bad = await call("POST", "/api/free-vars", { term: { kind: "nope" } });
  assert.equal(bad.status, 400);
  assert.equal((bad.json.error as { code: string }).code, "INVALID_TERM");

  const missing = await call("GET", "/api/terms/9999");
  assert.equal(missing.status, 404);
  assert.equal((missing.json.error as { code: string }).code, "NOT_FOUND");

  const imp = await call("POST", "/api/terms", { term: { kind: "var", name: "q" } });
  const badBudget = await call("POST", "/api/reductions", { termId: imp.json.id, maxSteps: -1 });
  assert.equal((badBudget.json.error as { code: string }).code, "BUDGET_INVALID");
});
