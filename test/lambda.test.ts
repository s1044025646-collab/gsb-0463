import assert from "node:assert/strict";
import { test } from "node:test";
import { alphaEquivalent, canonical, freeVars, reduce, substitute } from "../dist/src/lambda.js";
import { parseTerm } from "../dist/src/validate.js";
import type { Term } from "../dist/src/types.js";

// 便捷构造器
const v = (name: string): Term => ({ kind: "var", name });
const lam = (param: string, body: Term): Term => ({ kind: "lam", param, body });
const app = (fn: Term, arg: Term): Term => ({ kind: "app", fn, arg });

test("自由变量：遮蔽与确定顺序", () => {
  // λx. (x y) 中 x 被绑定，y 自由
  assert.deepEqual(freeVars(lam("x", app(v("x"), v("y")))), ["y"]);
  // λx. λy. x y z
  assert.deepEqual(freeVars(lam("x", lam("y", app(app(v("x"), v("y")), v("z"))))), ["z"]);
  // 排序确定
  assert.deepEqual(freeVars(app(v("z"), app(v("a"), v("m")))), ["a", "m", "z"]);
  // 仅有自由变量、抽象、不可归约应用都是合法的
  assert.deepEqual(freeVars(app(v("f"), v("x"))), ["f", "x"]);
});

test("规范表示：绑定用深度索引、自由变量保留名字", () => {
  // λx.λy.x  => lam(lam(B 1))
  assert.deepEqual(canonical(lam("x", lam("y", v("x")))), {
    kind: "lam",
    body: { kind: "lam", body: { kind: "B", index: 1 } },
  });
  // λz.y 的 y 是自由 F
  assert.deepEqual(canonical(lam("z", v("y"))), {
    kind: "lam",
    body: { kind: "F", name: "y" },
  });
});

test("alpha 等价：一致重命名绑定变量，自由变量必须同名", () => {
  assert.equal(alphaEquivalent(lam("x", v("x")), lam("z", v("z"))), true);
  assert.equal(alphaEquivalent(lam("x", v("y")), lam("z", v("y"))), true);
  // 自由变量名字不同 => 不等价
  assert.equal(alphaEquivalent(lam("x", v("y")), lam("x", v("z"))), false);
  // 深度不同的引用
  assert.equal(
    alphaEquivalent(lam("a", lam("b", v("a"))), lam("x", lam("y", v("x")))),
    true
  );
  assert.equal(
    alphaEquivalent(lam("a", lam("b", v("b"))), lam("x", lam("y", v("x")))),
    false
  );
});

test("手写替换：只替换自由出现，进入绑定 x 的抽象停止", () => {
  // x [x:=y] = y
  assert.deepEqual(substitute("x", v("y"), v("x")), v("y"));
  // z [x:=y] = z
  assert.deepEqual(substitute("x", v("y"), v("z")), v("z"));
  // (λx.x) [x:=y] = λx.x（不进入绑定 x）
  assert.deepEqual(substitute("x", v("y"), lam("x", v("x"))), lam("x", v("x")));
  // (λy.x) [x:=y] 必须改名避免捕获 => λy_1.y
  const captured = substitute("x", v("y"), lam("y", v("x")));
  assert.deepEqual(captured, lam("y_1", v("y")));
  // (λy.x y) [x:=y] => λy_1.(y y_1)
  const captured2 = substitute("x", v("y"), lam("y", app(v("x"), v("y"))));
  assert.deepEqual(captured2, lam("y_1", app(v("y"), v("y_1"))));
});

test("多层遮蔽：内层同名绑定不被外层改名影响", () => {
  // (λx. λx. x) x  外层被替换，内层 λx.x 保持不变
  const t = app(lam("x", lam("x", v("x"))), v("x_free"));
  const r = reduce(t, 10);
  assert.equal(r.status, "normal");
  assert.deepEqual(r.final, lam("x", v("x")));
});

test("参数含多个自由变量时的改名", () => {
  // (λy.λz. x) [x:=(y z w)] ：进入 λy 时 y 需改名 y_1，进入 λz 时 z 需改名 z_1
  const arg = app(app(v("y"), v("z")), v("w"));
  const t = lam("y", lam("z", v("x")));
  const result = substitute("x", arg, t);
  assert.deepEqual(result, lam("y_1", lam("z_1", app(app(v("y"), v("z")), v("w")))));
  // 改名后自由变量仍是 y,z,w，未被捕获
  assert.deepEqual(freeVars(result), ["w", "y", "z"]);
});

test("演示一：(λx.λy.x) y 归约后与 λz.y alpha 等价，y 仍自由", () => {
  // (λx.λy.x) y，第一步 y 与绑定 y 冲突，应改名为 y_1
  const t = app(lam("x", lam("y", v("x"))), v("y"));
  const r = reduce(t, 10);
  assert.equal(r.status, "normal");
  assert.equal(r.steps.length, 1);
  // 第一步必须记录改名 y -> y_1
  assert.ok(r.steps[0]!.renames.some((rn) => rn.from === "y" && rn.to === "y_1"));
  assert.equal(r.steps[0]!.replacedVar, "x");
  assert.equal(alphaEquivalent(r.final, lam("z", v("y"))), true);
  assert.deepEqual(freeVars(r.final), ["y"]);
});

test("演示二：(λx.λx.x) y 保留内层绑定，y 被丢弃", () => {
  const t = app(lam("x", lam("x", v("x"))), v("y"));
  const r = reduce(t, 10);
  assert.deepEqual(r.final, lam("x", v("x")));
  assert.deepEqual(freeVars(r.final), []);
  assert.equal(r.steps[0]!.renames.length, 0);
});

test("演示三：Omega 在预算耗尽时停止且保留当前项", () => {
  const delta = lam("x", app(v("x"), v("x")));
  const omega = app(delta, delta);
  const r = reduce(omega, 5);
  assert.equal(r.status, "budget_exhausted");
  assert.equal(r.steps.length, 5);
  assert.equal(r.redexRemaining, true);
  // Omega 自归约后结构同构
  assert.equal(alphaEquivalent(r.final, omega), true);
});

test("演示四：(λx.z) Omega 正常序一步得到自由变量 z，不求值 Omega", () => {
  const delta = lam("w", app(v("w"), v("w")));
  const omega = app(delta, delta);
  const t = app(lam("x", v("z")), omega);
  const r = reduce(t, 1);
  assert.equal(r.status, "normal");
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.final, v("z"));
  assert.deepEqual(freeVars(r.final), ["z"]);
});

test("根节点与深层归约：先最外，后进入函数体与参数", () => {
  // 外层 redex 先于内层
  const inner = app(lam("a", v("a")), v("q"));
  const outer = app(lam("x", app(v("x"), v("k"))), inner);
  const r = reduce(outer, 10);
  assert.equal(r.status, "normal");
  // 最终 (q k)
  assert.deepEqual(r.final, app(v("q"), v("k")));
  // 第一步路径为根（[]），第二步进入 fn
  assert.deepEqual(r.steps[0]!.path, []);
});

test("深层 redex 路径从本步开始项计算", () => {
  // λf. (λa.a) b —— 根是抽象，进入 body
  const t = lam("f", app(lam("a", v("a")), v("b")));
  const r = reduce(t, 5);
  assert.deepEqual(r.steps[0]!.path, ["body"]);
  assert.deepEqual(r.final, lam("f", v("b")));
});

test("零步预算：已是正规形则 normal，否则 budget_exhausted", () => {
  const normalTerm = lam("x", v("x"));
  const r1 = reduce(normalTerm, 0);
  assert.equal(r1.status, "normal");
  assert.equal(r1.steps.length, 0);

  const delta = lam("x", app(v("x"), v("x")));
  const r2 = reduce(app(delta, delta), 0);
  assert.equal(r2.status, "budget_exhausted");
  assert.equal(r2.steps.length, 0);
  assert.equal(r2.redexRemaining, true);
});

test("刚好最后一步到达正规形", () => {
  // (λx.x) ((λy.y) z)  需要 2 步
  const t = app(lam("x", v("x")), app(lam("y", v("y")), v("z")));
  const r = reduce(t, 2);
  assert.equal(r.status, "normal");
  assert.equal(r.steps.length, 2);
  assert.deepEqual(r.final, v("z"));
  // 预算少一步则未完成
  const rShort = reduce(t, 1);
  assert.equal(rShort.status, "budget_exhausted");
});

test("每步 before/after 与路径自洽", () => {
  const t = app(lam("x", app(v("x"), v("x"))), v("p"));
  const r = reduce(t, 10);
  assert.equal(r.steps.length, 1);
  assert.deepEqual(r.steps[0]!.before, t);
  assert.deepEqual(r.steps[0]!.after, app(v("p"), v("p")));
  assert.deepEqual(r.final, app(v("p"), v("p")));
});

test("解析 JSON 树并拒绝非法项", () => {
  assert.deepEqual(parseTerm('{"kind":"var","name":"a"}'), v("a"));
  assert.throws(
    () => parseTerm('{"kind":"wat"}'),
    (e: Error & { code?: string }) => e.code === "INVALID_TERM"
  );
  assert.throws(
    () => parseTerm("not json"),
    (e: Error & { code?: string }) => e.code === "INVALID_JSON"
  );
  assert.throws(
    () => parseTerm('{"kind":"var","name":""}'),
    (e: Error & { code?: string }) => e.code === "NAME_REQUIRED"
  );
});
