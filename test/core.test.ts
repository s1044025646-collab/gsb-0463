import { test } from "node:test";
import assert from "node:assert/strict";
import {
  freeVars, substitute, alphaEquivalent, betaStep, validateTerm,
  DEFAULT_LIMITS, LambdaError,
} from "../dist/core.js";
import type { Term } from "../dist/core.js";
import { Store } from "../dist/db.js";
import { Service } from "../dist/service.js";

const v = (name: string): Term => ({ kind: "var", name });
const lam = (param: string, body: Term): Term => ({ kind: "lam", param, body });
const app = (fn: Term, arg: Term): Term => ({ kind: "app", fn, arg });

// ---- Independent de Bruijn specification (no shared code with core) ----
type DBT = ["b", number] | ["f", string] | ["lam", DBT] | ["app", DBT, DBT];
function specDB(t: Term, env: string[] = []): DBT {
  if (t.kind === "var") {
    const i = env.lastIndexOf(t.name);
    return i >= 0 ? ["b", env.length - 1 - i] : ["f", t.name];
  }
  if (t.kind === "lam") return ["lam", specDB(t.body, [...env, t.param])];
  return ["app", specDB(t.fn, env), specDB(t.arg, env)];
}
const specAlpha = (a: Term, b: Term) => assert.deepEqual(specDB(a), specDB(b));
const specNotAlpha = (a: Term, b: Term) => assert.notDeepEqual(specDB(a), specDB(b));
function specFV(t: Term, bound: string[] = [], acc: string[] = []): string[] {
  if (t.kind === "var") {
    if (!bound.includes(t.name) && !acc.includes(t.name)) acc.push(t.name);
    return acc;
  }
  if (t.kind === "lam") return specFV(t.body, [...bound, t.param], acc);
  specFV(t.fn, bound, acc);
  return specFV(t.arg, bound, acc);
}

// ---- free variables ----
test("freeVars: deterministic order, shadowing respected", () => {
  const t = lam("x", app(v("x"), lam("y", app(v("y"), app(v("z"), v("x"))))));
  assert.deepEqual(freeVars(t), ["z"]);
  assert.deepEqual(freeVars(t), specFV(t));
  const t2 = app(v("b"), app(v("a"), v("b")));
  assert.deepEqual(freeVars(t2), ["b", "a"]);
  assert.deepEqual(freeVars(t2), specFV(t2));
});

// ---- substitution ----
test("subst: (Lx.Ly.x)[x:=y] renames y, result alpha-equivalent to Lz.y", () => {
  const body = lam("y", v("x"));
  const { result, renames } = substitute(body, "x", v("y"));
  assert.equal(renames.length, 1);
  assert.equal(renames[0].oldName, "y");
  specAlpha(result, lam("z", v("y")));
  assert.ok(alphaEquivalent(result, lam("z", v("y"))));
  assert.deepEqual(freeVars(result), ["y"]);
});

test("subst: stops at shadowing binder, inner binding preserved", () => {
  const body = lam("x", app(v("x"), v("x")));
  const { result, renames } = substitute(body, "x", v("y"));
  assert.equal(renames.length, 0);
  assert.deepEqual(result, body);
});

test("subst: (Lx.Lx.x) y keeps inner binder, no rename", () => {
  const omega = app(lam("x", lam("x", v("x"))), v("y"));
  const step = betaStep(omega)!;
  assert.deepEqual(step.result, lam("x", v("x")));
  assert.equal(step.renames.length, 0);
});

test("subst: renaming does not touch inner same-name binder (shadowing)", () => {
  // (Lx. Ly. (x, Ly. y))[x := y]  -> inner Ly.y must NOT be renamed
  const body = lam("y", app(v("x"), lam("y", v("y"))));
  const { result, renames } = substitute(body, "x", v("y"));
  assert.equal(renames.length, 1);
  specAlpha(result, lam("z", app(v("y"), lam("y", v("y")))));
  const r = result as { kind: "lam"; body: Term };
  const inner = (r.body as { kind: "app"; arg: Term }).arg;
  assert.deepEqual(inner, lam("y", v("y")));
});

test("subst: argument with multiple free variables", () => {
  // (Ly. Lw. x)[x := (y w)] -> both y and w must be renamed
  const body = lam("y", lam("w", v("x")));
  const arg = app(v("y"), v("w"));
  const { result, renames } = substitute(body, "x", arg);
  assert.equal(renames.length, 2);
  assert.deepEqual(freeVars(result), ["y", "w"]);
  specAlpha(result, lam("a", lam("b", app(v("y"), v("w")))));
});

test("subst: no rename needed when binder not free in arg", () => {
  const { result, renames } = substitute(lam("y", v("x")), "x", v("z"));
  assert.equal(renames.length, 0);
  assert.deepEqual(result, lam("y", v("z")));
});

test("subst: only free occurrences replaced", () => {
  const body = app(lam("x", v("x")), v("x"));
  const { result } = substitute(body, "x", v("q"));
  assert.deepEqual(result, app(lam("x", v("x")), v("q")));
});

// ---- alpha equivalence ----
test("alpha: equivalent renamings, free names must match", () => {
  assert.ok(alphaEquivalent(lam("x", v("x")), lam("y", v("y"))));
  assert.ok(!alphaEquivalent(lam("x", v("x")), lam("y", v("z"))));
  assert.ok(!alphaEquivalent(v("x"), v("y")));
  assert.ok(alphaEquivalent(
    lam("x", lam("x", v("x"))),
    lam("a", lam("b", v("b")))
  ));
  assert.ok(!alphaEquivalent(
    lam("x", lam("y", v("x"))),
    lam("a", lam("b", v("b")))
  ));
});

// ---- beta reduction ----
const OMEGA = app(lam("x", app(v("x"), v("x"))), lam("x", app(v("x"), v("x"))));

test("beta: (Lx.Ly.x) y reduces to term alpha-equivalent to Lz.y, y free", () => {
  const t = app(lam("x", lam("y", v("x"))), v("y"));
  const step = betaStep(t)!;
  assert.deepEqual(step.path, []);
  assert.equal(step.replacedVar, "x");
  assert.equal(step.renames.length, 1);
  specAlpha(step.result, lam("z", v("y")));
  assert.deepEqual(freeVars(step.result), ["y"]);
  assert.equal(betaStep(step.result), null);
});

test("beta: (Lx.z) Omega -> z in exactly one normal-order step", () => {
  const t = app(lam("x", v("z")), OMEGA);
  const step = betaStep(t)!;
  assert.deepEqual(step.result, v("z"));
  assert.equal(betaStep(step.result), null);
});

test("beta: Omega never reaches normal form (budget stops it)", () => {
  let cur = OMEGA;
  for (let i = 0; i < 5; i++) {
    const s = betaStep(cur)!;
    assert.ok(s, "omega always has a redex");
    cur = s.result;
  }
  assert.ok(betaStep(cur) !== null);
});

test("beta: normal order is leftmost-outermost; paths computed per step", () => {
  // (Lx.x) ((Ly.y) z): root is a redex -> path []
  const inner = app(lam("y", v("y")), v("z"));
  const t = app(lam("x", v("x")), inner);
  const s1 = betaStep(t)!;
  assert.deepEqual(s1.path, []);
  assert.deepEqual(s1.result, inner);
  const s2 = betaStep(s1.result)!;
  assert.deepEqual(s2.path, []);
  assert.deepEqual(s2.result, v("z"));

  // deep redex inside lambda body: Lq. (Lx.x) z -> path ["body"]
  const t2 = lam("q", app(lam("x", v("x")), v("z")));
  const s3 = betaStep(t2)!;
  assert.deepEqual(s3.path, ["body"]);
  assert.deepEqual(s3.result, lam("q", v("z")));

  // redex in fn before arg: ((Lx.x) (Ly.y)) ((Lw.w) q)
  const t3 = app(app(lam("x", v("x")), lam("y", v("y"))), app(lam("w", v("w")), v("q")));
  const s4 = betaStep(t3)!;
  assert.deepEqual(s4.path, ["fn"]);
});

test("beta: multi-level shadowing", () => {
  // (Lx. Lx. Lx. x) a -> Lx. Lx. x (outer x shadowed immediately)
  const t = app(lam("x", lam("x", lam("x", v("x")))), v("a"));
  const s = betaStep(t)!;
  assert.deepEqual(s.result, lam("x", lam("x", v("x"))));
});

// ---- validation & limits ----
test("validate: rejects bad terms", () => {
  assert.throws(() => validateTerm({ kind: "var" }), (e: unknown) => (e as LambdaError).code === "INVALID_TERM");
  assert.throws(() => validateTerm({ kind: "nope" }), (e: unknown) => (e as LambdaError).code === "INVALID_TERM");
  assert.throws(() => validateTerm(null), (e: unknown) => (e as LambdaError).code === "INVALID_TERM");
});

test("limits: depth and node caps", () => {
  let deep: Term = v("x");
  for (let i = 0; i < 300; i++) deep = lam("x", deep);
  assert.throws(() => validateTerm(deep), (e: unknown) => (e as LambdaError).code === "LIMIT_EXCEEDED");
});

// ---- service / persistence ----
function makeService(): { svc: Service; dbPath: string } {
  const dbPath = `:memory:`;
  return { svc: new Service(new Store(dbPath)), dbPath };
}

test("service: zero budget leaves term untouched; status reflects redexes", () => {
  const { svc } = makeService();
  const { id } = svc.createReduction({ term: app(lam("x", v("x")), v("z")), budget: 0 });
  const r = svc.step(id);
  assert.equal(r.status, "budget_exhausted");
  const info = svc.getReduction(id) as { stepsDone: number; current: Term };
  assert.equal(info.stepsDone, 0);
  assert.deepEqual(info.current, app(lam("x", v("x")), v("z")));
});

test("service: zero budget on normal form completes normally", () => {
  const { svc } = makeService();
  const { id } = svc.createReduction({ term: lam("x", v("x")), budget: 0 });
  const r = svc.step(id);
  assert.equal(r.status, "normal_form");
});

test("service: exact budget reaching normal form on last step", () => {
  const { svc } = makeService();
  const t = app(lam("x", v("x")), app(lam("y", v("y")), v("z"))); // 2 steps
  const { id } = svc.createReduction({ term: t, budget: 2 });
  svc.step(id);
  const r2 = svc.step(id);
  assert.equal(r2.status, "normal_form");
  const info = svc.getReduction(id) as { stepsDone: number; current: Term };
  assert.equal(info.stepsDone, 2);
  assert.deepEqual(info.current, v("z"));
});

test("service: Omega with budget stops as budget_exhausted, keeps current term", () => {
  const { svc } = makeService();
  const { id } = svc.createReduction({ term: OMEGA, budget: 3 });
  svc.step(id); svc.step(id);
  const r = svc.step(id);
  assert.equal(r.status, "budget_exhausted");
  const again = svc.step(id);
  assert.equal(again.status, "budget_exhausted");
  const info = svc.getReduction(id) as { stepsDone: number };
  assert.equal(info.stepsDone, 3);
});

test("service: idempotent step via expectedStepIndex does not reduce twice", () => {
  const { svc } = makeService();
  const { id } = svc.createReduction({ term: app(lam("x", v("x")), app(lam("y", v("y")), v("z"))), budget: 5 });
  const s1 = svc.step(id, 0);
  const s1again = svc.step(id, 0);
  assert.equal((s1again as { alreadyCommitted?: boolean }).alreadyCommitted, true);
  const info = svc.getReduction(id) as { stepsDone: number };
  assert.equal(info.stepsDone, 1);
  assert.deepEqual(
    (s1again as { step: unknown }).step,
    (s1 as { step: unknown }).step
  );
});

test("service: reads/pagination never advance reduction", () => {
  const { svc } = makeService();
  const { id } = svc.createReduction({ term: app(lam("x", v("x")), v("z")), budget: 5 });
  svc.getReduction(id); svc.getReduction(id, 0, 10);
  const info = svc.getReduction(id) as { stepsDone: number };
  assert.equal(info.stepsDone, 0);
});

test("service: persistence across reopen keeps renames and step count", () => {
  const path = `data/test-persist-${Date.now()}.db`;
  const t = app(lam("x", lam("y", v("x"))), v("y"));
  {
    const svc = new Service(new Store(path));
    const { id } = svc.createReduction({ term: t, budget: 5 });
    svc.step(id);
    const info = svc.getReduction(id) as { steps: Array<{ renames: unknown[] }> };
    assert.equal(info.steps[0].renames.length, 1);
  }
  {
    const svc = new Service(new Store(path));
    const info = svc.getReduction(1) as { stepsDone: number; status: string; steps: Array<{ renames: Array<{ oldName: string }> }> };
    assert.equal(info.stepsDone, 1);
    assert.equal(info.steps[0].renames[0].oldName, "y");
    assert.equal(info.status, "running");
  }
});

test("service: failed analysis has distinct status", () => {
  const { svc } = makeService();
  const tiny = { ...DEFAULT_LIMITS, maxIntermediateNodes: 2 };
  const svc2 = new Service(new Store(":memory:"), tiny);
  const { id } = svc2.createReduction({ term: app(lam("x", app(v("x"), v("x"))), lam("a", v("a"))), budget: 5 });
  const r = svc2.step(id);
  assert.equal(r.status, "failed");
  const info = svc2.getReduction(id) as { status: string; error: string; stepsDone: number };
  assert.equal(info.status, "failed");
  assert.equal(info.stepsDone, 0);
  assert.match(info.error, /not committed/);
});

test("service: free variables of unbound names are legal", () => {
  const { svc } = makeService();
  const { id } = svc.importTerm(app(v("x"), lam("y", v("z"))));
  assert.deepEqual(svc.freeVariables(id).freeVariables, ["x", "z"]);
});

test("service: alpha endpoint agrees with spec", () => {
  const { svc } = makeService();
  const r = svc.alphaEquivalent(lam("x", lam("y", v("x"))), lam("p", lam("q", v("p"))));
  assert.equal(r.equivalent, true);
  const r2 = svc.alphaEquivalent(lam("x", v("y")), lam("x", v("x")));
  assert.equal(r2.equivalent, false);
});
