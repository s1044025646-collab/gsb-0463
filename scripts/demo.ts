// 端到端演示：通过 HTTP API 完成题目要求的全部示例，数据落到项目内 data/ 目录。
import { AddressInfo } from "node:net";
import { createApp, store } from "../src/server.js";

const v = (name: string) => ({ kind: "var" as const, name });
const lam = (param: string, body: unknown) => ({ kind: "lam" as const, param, body });
const app = (fn: unknown, arg: unknown) => ({ kind: "app" as const, fn, arg });

function start(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createApp();
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, any>;
}

async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return (await res.json()) as Record<string, any>;
}

function hr(title: string): void {
  console.log("\n=== " + title + " ===");
}

const { base, close } = await start();
console.log(`演示服务: ${base}`);

hr("1. (λx.λy.x) y → 与 λz.y alpha 等价，y 仍自由（记录改名 y→y_1）");
{
  const term = app(lam("x", lam("y", v("x"))), v("y"));
  const imp = await post(base, "/api/terms", { term, label: "capture-demo" });
  const r = await post(base, "/api/reductions", { termId: imp.id, maxSteps: 5 });
  console.log("状态:", r.analysis.status, " 步数:", r.analysis.stepsUsed);
  const steps = await get(base, `/api/reductions/${r.analysis.id}/steps`);
  console.log("改名:", JSON.stringify(steps.steps[0].renames));
  const alpha = await post(base, "/api/alpha-equivalent", {
    a: r.analysis.finalTerm,
    b: lam("z", v("y")),
  });
  const fv = await post(base, "/api/free-vars", { term: r.analysis.finalTerm });
  console.log("终态:", JSON.stringify(r.analysis.finalTerm));
  console.log("与 λz.y alpha 等价:", alpha.alphaEquivalent, " 自由变量:", fv.freeVars);
}

hr("2. (λx.λx.x) y 保留内层绑定");
{
  const term = app(lam("x", lam("x", v("x"))), v("y"));
  const imp = await post(base, "/api/terms", { term });
  const r = await post(base, "/api/reductions", { termId: imp.id, maxSteps: 5 });
  console.log("终态:", JSON.stringify(r.analysis.finalTerm), "（内层 λx.x 未被改名/替换）");
}

hr("3. Omega = (λx.x x)(λx.x x)，预算 4 步后预算耗尽");
{
  const delta = lam("x", app(v("x"), v("x")));
  const omega = app(delta, delta);
  const imp = await post(base, "/api/terms", { term: omega, label: "omega" });
  const r = await post(base, "/api/reductions", { termId: imp.id, maxSteps: 4 });
  console.log(
    "状态:",
    r.analysis.status,
    " 已用步数:",
    r.analysis.stepsUsed,
    " 仍有 redex:",
    r.analysis.redexRemaining
  );
}

hr("4. (λx.z) Omega 正常序一步得到 z（不预先归约 Omega）");
{
  const delta = lam("w", app(v("w"), v("w")));
  const omega = app(delta, delta);
  const term = app(lam("x", v("z")), omega);
  const imp = await post(base, "/api/terms", { term });
  const r = await post(base, "/api/reductions", { termId: imp.id, maxSteps: 3 });
  console.log(
    "终态:",
    JSON.stringify(r.analysis.finalTerm),
    " 步数:",
    r.analysis.stepsUsed,
    " 状态:",
    r.analysis.status
  );
}

hr("5. 零步预算");
{
  const id = (await post(base, "/api/terms", { term: lam("x", v("x")) })).id;
  const r = await post(base, "/api/reductions", { termId: id, maxSteps: 0 });
  console.log("正规形 + 0 步 =>", r.analysis.status);
}

store.close();
await close();
console.log("\n演示完成。");
