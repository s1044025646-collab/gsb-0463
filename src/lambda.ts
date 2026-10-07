import { LambdaError } from "./errors.js";
import { LIMITS } from "./limits.js";
import { nodeCount } from "./validate.js";
import type { Rename, ReductionResult, ReductionStep, Term } from "./types.js";

// 去重并排序，保证自由变量集合顺序确定。
function sortedSet(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

// 自由变量：进入绑定 name 的抽象时，把 name 从作用域中移除（静态作用域 + 遮蔽）。
function fv(t: Term, bound: Set<string>, acc: Set<string>): void {
  switch (t.kind) {
    case "var":
      if (!bound.has(t.name)) acc.add(t.name);
      return;
    case "lam": {
      const inner = new Set(bound);
      inner.add(t.param);
      fv(t.body, inner, acc);
      return;
    }
    case "app":
      fv(t.fn, bound, acc);
      fv(t.arg, bound, acc);
      return;
  }
}

export function freeVars(t: Term): string[] {
  const acc = new Set<string>();
  fv(t, new Set(), acc);
  return sortedSet(acc);
}

// 收集项中出现的全部名字（绑定名与变量名都算），用于固定生成新名字。
function allNames(t: Term, acc: Set<string>): void {
  switch (t.kind) {
    case "var":
      acc.add(t.name);
      return;
    case "lam":
      acc.add(t.param);
      allNames(t.body, acc);
      return;
    case "app":
      allNames(t.fn, acc);
      allNames(t.arg, acc);
      return;
  }
}

function nameOccursFree(name: string, t: Term): boolean {
  return freeVars(t).includes(name);
}

// 固定生成规则：优先使用 base 本身，否则 base_1、base_2…，
// 避开 avoid 中所有名字。保证同一输入每次轨迹一致。
function freshName(base: string, avoid: Set<string>): string {
  if (!avoid.has(base)) return base;
  let i = 1;
  while (avoid.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

// 仅把 t 中 name 的“自由出现”改名（被内层同名绑定约束的出现保持不变）。
function renameFree(name: string, to: string, t: Term, bound: boolean): Term {
  switch (t.kind) {
    case "var":
      return t.name === name && !bound ? { kind: "var", name: to } : t;
    case "lam":
      if (t.param === name) return t; // 内层同名绑定遮蔽，停止
      return { kind: "lam", param: t.param, body: renameFree(name, to, t.body, bound) };
    case "app":
      return {
        kind: "app",
        fn: renameFree(name, to, t.fn, bound),
        arg: renameFree(name, to, t.arg, bound),
      };
  }
}

interface SubstOutcome {
  term: Term;
  renames: Rename[];
}

// 捕获避免替换 t[x := arg]。path 是 t 在本步开始项中的路径，用于记录改名位置。
function substTerm(x: string, arg: Term, t: Term, path: (string | number)[]): SubstOutcome {
  switch (t.kind) {
    case "var":
      return t.name === x ? { term: clone(arg), renames: [] } : { term: t, renames: [] };

    case "lam": {
      const y = t.param;
      if (y === x) {
        // 该绑定正是 x：替换在此处停止，体内 x 不再自由。
        return { term: t, renames: [] };
      }
      if (!nameOccursFree(y, arg) || !nameOccursFreeIn(x, t.body)) {
        // y 不会被捕获，或体内已无自由 x 需要进入：无需改名。
        const body = substTerm(x, arg, t.body, [...path, "body"]);
        return { term: { kind: "lam", param: y, body: body.term }, renames: body.renames };
      }
      // 需要改名：y 的绑定会捕获 arg 中的自由 y。
      const avoid = new Set<string>();
      allNames(t.body, avoid);
      allNames(arg, avoid);
      const z = freshName(y, avoid);
      const renamedBody = renameFree(y, z, t.body, false);
      const rename: Rename = {
        binderPath: path,
        from: y,
        to: z,
        reason: `绑定变量 ${y} 会捕获待插入项中的自由 ${y}，先一致改名为 ${z}`,
      };
      const body = substTerm(x, arg, renamedBody, [...path, "body"]);
      return {
        term: { kind: "lam", param: z, body: body.term },
        renames: [rename, ...body.renames],
      };
    }

    case "app": {
      const fn = substTerm(x, arg, t.fn, [...path, "fn"]);
      const a = substTerm(x, arg, t.arg, [...path, "arg"]);
      return {
        term: { kind: "app", fn: fn.term, arg: a.term },
        renames: [...fn.renames, ...a.renames],
      };
    }
  }
}

function nameOccursFreeIn(name: string, t: Term): boolean {
  return nameOccursFree(name, t);
}

function clone(t: Term): Term {
  return structuredClone(t);
}

// 显式替换（无路径记录需求）。
export function substitute(x: string, arg: Term, t: Term): Term {
  return substTerm(x, arg, t, []).term;
}

// alpha 等价：绑定变量用绑定深度（de Bruijn 索引）表示，自由变量必须同名。
type Canon =
  | { kind: "F"; name: string }
  | { kind: "B"; index: number }
  | { kind: "lam"; body: Canon }
  | { kind: "app"; fn: Canon; arg: Canon };

function canon(t: Term, env: string[]): Canon {
  switch (t.kind) {
    case "var": {
      const i = env.lastIndexOf(t.name);
      return i >= 0
        ? { kind: "B", index: env.length - 1 - i }
        : { kind: "F", name: t.name };
    }
    case "lam":
      return { kind: "lam", body: canon(t.body, [...env, t.param]) };
    case "app":
      return { kind: "app", fn: canon(t.fn, env), arg: canon(t.arg, env) };
  }
}

export function canonical(t: Term): Canon {
  return canon(t, []);
}

export function alphaEquivalent(a: Term, b: Term): boolean {
  return JSON.stringify(canon(a, [])) === JSON.stringify(canon(b, []));
}

type PathSegment = string | number;

// 最左最外 redex：当前 app（左部为 lam）→ fn → arg；lam 则进入 body。
function findRedexPath(t: Term, prefix: PathSegment[]): PathSegment[] | null {
  switch (t.kind) {
    case "var":
      return null;
    case "lam":
      return findRedexPath(t.body, [...prefix, "body"]);
    case "app": {
      if (t.fn.kind === "lam") return prefix;
      const inFn = findRedexPath(t.fn, [...prefix, "fn"]);
      if (inFn) return inFn;
      return findRedexPath(t.arg, [...prefix, "arg"]);
    }
  }
}

function atPath(t: Term, path: PathSegment[]): Term {
  let cur = t;
  for (const seg of path) {
    if (cur.kind === "lam" && seg === "body") cur = cur.body;
    else if (cur.kind === "app" && seg === "fn") cur = cur.fn;
    else if (cur.kind === "app" && seg === "arg") cur = cur.arg;
    else throw new LambdaError("BAD_REQUEST", "非法归约路径");
  }
  return cur;
}

function replaceAt(t: Term, path: PathSegment[], value: Term): Term {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (t.kind === "lam" && head === "body") {
    return { kind: "lam", param: t.param, body: replaceAt(t.body, rest, value) };
  }
  if (t.kind === "app" && head === "fn") {
    return { kind: "app", fn: replaceAt(t.fn, rest, value), arg: t.arg };
  }
  if (t.kind === "app" && head === "arg") {
    return { kind: "app", fn: t.fn, arg: replaceAt(t.arg, rest, value) };
  }
  throw new LambdaError("BAD_REQUEST", "非法归约路径");
}

// 执行一步 beta。若复制后超规模，抛出 INTERMEDIATE_TOO_LARGE，由调用方保留上一步树。
function betaOnce(t: Term, index: number): { next: Term; step: ReductionStep } {
  const path = findRedexPath(t, []);
  if (!path) throw new LambdaError("BAD_REQUEST", "当前项已无 redex");
  const redex = atPath(t, path);
  if (redex.kind !== "app" || redex.fn.kind !== "lam") {
    throw new LambdaError("BAD_REQUEST", "选中路径不是 redex");
  }
  const x = redex.fn.param;
  const body = redex.fn.body;
  const arg = redex.arg;
  const result = substTerm(x, arg, body, []);
  if (nodeCount(result.term) > LIMITS.maxIntermediateNodes) {
    throw new LambdaError(
      "INTERMEDIATE_TOO_LARGE",
      `本步结果节点数超过中间结果限制 ${LIMITS.maxIntermediateNodes}，该步不提交`
    );
  }
  const next = replaceAt(t, path, result.term);
  return {
    next,
    step: {
      index,
      path,
      replacedVar: x,
      renames: result.renames,
      before: clone(t),
      after: clone(next),
    },
  };
}

// 正常序归约至多 maxSteps 步，返回完整轨迹与终态（不预先计算会被丢弃的参数）。
export function reduce(initial: Term, maxSteps: number): ReductionResult {
  if (!Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new LambdaError("BUDGET_INVALID", "最大 beta 步数必须是非负整数");
  }
  const steps: ReductionStep[] = [];
  let current = clone(initial);
  for (let i = 1; i <= maxSteps; i++) {
    if (!findRedexPath(current, [])) break;
    const { next, step } = betaOnce(current, i);
    steps.push(step);
    current = next;
  }
  const redexRemaining = findRedexPath(current, []) !== null;
  return {
    status: redexRemaining ? "budget_exhausted" : "normal",
    steps,
    final: current,
    redexRemaining,
  };
}
