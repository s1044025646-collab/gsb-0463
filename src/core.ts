export type Term =
  | { kind: "var"; name: string }
  | { kind: "lam"; param: string; body: Term }
  | { kind: "app"; fn: Term; arg: Term };

export interface Rename {
  path: Path;
  oldName: string;
  newName: string;
  reason: string;
}

export type Path = Array<"body" | "fn" | "arg">;

export interface Limits {
  maxDepth: number;
  maxNodes: number;
  maxInputBytes: number;
  maxIntermediateNodes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 200,
  maxNodes: 10000,
  maxInputBytes: 256 * 1024,
  maxIntermediateNodes: 50000,
};

export class LambdaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validateTerm(t: unknown, limits: Limits = DEFAULT_LIMITS): Term {
  let nodes = 0;
  function check(n: unknown, depth: number): Term {
    if (depth > limits.maxDepth)
      throw new LambdaError("LIMIT_EXCEEDED", `term depth exceeds ${limits.maxDepth}`);
    if (++nodes > limits.maxNodes)
      throw new LambdaError("LIMIT_EXCEEDED", `term node count exceeds ${limits.maxNodes}`);
    if (typeof n !== "object" || n === null)
      throw new LambdaError("INVALID_TERM", "node must be an object");
    const k = (n as Record<string, unknown>).kind;
    if (k === "var") {
      const name = (n as Record<string, unknown>).name;
      if (typeof name !== "string" || name.length === 0)
        throw new LambdaError("INVALID_TERM", "var requires a non-empty string name");
      return { kind: "var", name };
    }
    if (k === "lam") {
      const o = n as Record<string, unknown>;
      if (typeof o.param !== "string" || o.param.length === 0)
        throw new LambdaError("INVALID_TERM", "lam requires a non-empty string param");
      if (!("body" in o))
        throw new LambdaError("INVALID_TERM", "lam requires body");
      return { kind: "lam", param: o.param, body: check(o.body, depth + 1) };
    }
    if (k === "app") {
      const o = n as Record<string, unknown>;
      if (!("fn" in o) || !("arg" in o))
        throw new LambdaError("INVALID_TERM", "app requires fn and arg");
      return { kind: "app", fn: check(o.fn, depth + 1), arg: check(o.arg, depth + 1) };
    }
    throw new LambdaError("INVALID_TERM", `unknown kind: ${String(k)}`);
  }
  return check(t, 1);
}

export function countNodes(t: Term): number {
  switch (t.kind) {
    case "var":
      return 1;
    case "lam":
      return 1 + countNodes(t.body);
    case "app":
      return 1 + countNodes(t.fn) + countNodes(t.arg);
  }
}

// Free variables in deterministic order: first free occurrence, left-to-right.
export function freeVars(t: Term): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function go(n: Term, bound: Set<string>): void {
    switch (n.kind) {
      case "var":
        if (!bound.has(n.name) && !seen.has(n.name)) {
          seen.add(n.name);
          out.push(n.name);
        }
        break;
      case "lam": {
        const b2 = new Set(bound);
        b2.add(n.param);
        go(n.body, b2);
        break;
      }
      case "app":
        go(n.fn, bound);
        go(n.arg, bound);
        break;
    }
  }
  go(t, new Set());
  return out;
}

function allNames(t: Term, into: Set<string>): Set<string> {
  switch (t.kind) {
    case "var":
      into.add(t.name);
      break;
    case "lam":
      into.add(t.param);
      allNames(t.body, into);
      break;
    case "app":
      allNames(t.fn, into);
      allNames(t.arg, into);
      break;
  }
  return into;
}

// Deterministic fresh-name rule: a..z, then a1..z1, a2..z2, ... first name not in use.
export function freshName(used: Set<string>): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (const c of letters) if (!used.has(c)) return c;
  for (let i = 1; ; i++) {
    for (const c of letters) {
      const cand = `${c}${i}`;
      if (!used.has(c)) return cand;
    }
  }
}

// Rename occurrences bound by the outermost binder of name `oldName` within `t`.
// Stops at inner abstractions that rebind `oldName` (shadowing).
function renameBound(t: Term, oldName: string, newName: string): Term {
  switch (t.kind) {
    case "var":
      return t.name === oldName ? { kind: "var", name: newName } : t;
    case "lam":
      if (t.param === oldName) return t; // shadowed inner binder, untouched
      return { kind: "lam", param: t.param, body: renameBound(t.body, oldName, newName) };
    case "app":
      return { kind: "app", fn: renameBound(t.fn, oldName, newName), arg: renameBound(t.arg, oldName, newName) };
  }
}

export interface SubstResult {
  result: Term;
  renames: Rename[];
}

// Capture-avoiding substitution: body[varName := arg].
export function substitute(body: Term, varName: string, arg: Term, basePath: Path = []): SubstResult {
  const renames: Rename[] = [];
  const fvArg = new Set(freeVars(arg));
  const argNames = allNames(arg, new Set<string>());

  function go(t: Term, path: Path): Term {
    switch (t.kind) {
      case "var":
        return t.name === varName ? arg : t;
      case "app":
        return { kind: "app", fn: go(t.fn, [...path, "fn"]), arg: go(t.arg, [...path, "arg"]) };
      case "lam": {
        if (t.param === varName) return t; // binder shadows: stop
        const fvBody = freeVars(t.body);
        if (fvArg.has(t.param) && fvBody.includes(varName)) {
          const used = allNames(t.body, new Set<string>(argNames));
          used.add(varName);
          const fresh = freshName(used);
          renames.push({
            path: [...path],
            oldName: t.param,
            newName: fresh,
            reason: `binder '${t.param}' occurs free in the inserted argument; renamed to avoid capture`,
          });
          const renamedBody = renameBound(t.body, t.param, fresh);
          return { kind: "lam", param: fresh, body: go(renamedBody, [...path, "body"]) };
        }
        return { kind: "lam", param: t.param, body: go(t.body, [...path, "body"]) };
      }
    }
  }
  return { result: go(body, basePath), renames };
}

// De Bruijn canonical form for alpha-equivalence checking.
type DB =
  | { tag: "bound"; index: number }
  | { tag: "free"; name: string }
  | { tag: "lam"; body: DB }
  | { tag: "app"; fn: DB; arg: DB };

function toDeBruijn(t: Term, env: string[]): DB {
  switch (t.kind) {
    case "var": {
      for (let i = env.length - 1; i >= 0; i--) {
        if (env[i] === t.name) return { tag: "bound", index: env.length - 1 - i };
      }
      return { tag: "free", name: t.name };
    }
    case "lam":
      return { tag: "lam", body: toDeBruijn(t.body, [...env, t.param]) };
    case "app":
      return { tag: "app", fn: toDeBruijn(t.fn, env), arg: toDeBruijn(t.arg, env) };
  }
}

function dbEq(a: DB, b: DB): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "bound":
      return a.index === (b as { index: number }).index;
    case "free":
      return a.name === (b as { name: string }).name;
    case "lam":
      return dbEq(a.body, (b as { body: DB }).body);
    case "app": {
      const bb = b as { fn: DB; arg: DB };
      return dbEq(a.fn, bb.fn) && dbEq(a.arg, bb.arg);
    }
  }
}

export function alphaEquivalent(a: Term, b: Term): boolean {
  return dbEq(toDeBruijn(a, []), toDeBruijn(b, []));
}

export function getAtPath(t: Term, path: Path): Term {
  let cur = t;
  for (const p of path) {
    if (p === "body" && cur.kind === "lam") cur = cur.body;
    else if (p === "fn" && cur.kind === "app") cur = cur.fn;
    else if (p === "arg" && cur.kind === "app") cur = cur.arg;
    else throw new LambdaError("INVALID_PATH", "path does not exist in term");
  }
  return cur;
}

function setAtPath(t: Term, path: Path, value: Term): Term {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (head === "body" && t.kind === "lam") return { kind: "lam", param: t.param, body: setAtPath(t.body, rest, value) };
  if (head === "fn" && t.kind === "app") return { kind: "app", fn: setAtPath(t.fn, rest, value), arg: t.arg };
  if (head === "arg" && t.kind === "app") return { kind: "app", fn: t.fn, arg: setAtPath(t.arg, rest, value) };
  throw new LambdaError("INVALID_PATH", "path does not exist in term");
}

export interface StepInfo {
  path: Path;
  replacedVar: string;
  renames: Rename[];
  result: Term;
}

// One leftmost-outermost beta step. Returns null if the term is in normal form.
export function betaStep(t: Term, limits: Limits = DEFAULT_LIMITS): StepInfo | null {
  const path = findRedex(t);
  if (path === null) return null;
  const redex = getAtPath(t, path);
  if (redex.kind !== "app" || redex.fn.kind !== "lam")
    throw new LambdaError("INTERNAL", "redex is not an application of a lambda");
  const lam = redex.fn;
  const { result: substituted, renames } = substitute(lam.body, lam.param, redex.arg, [...path, "fn", "body"]);
  const result = setAtPath(t, path, substituted);
  const nodes = countNodes(result);
  if (nodes > limits.maxIntermediateNodes) {
    throw new LambdaError(
      "LIMIT_EXCEEDED",
      `step result would have ${nodes} nodes, exceeding limit ${limits.maxIntermediateNodes}; step not committed`
    );
  }
  return { path, replacedVar: lam.param, renames, result };
}

// Leftmost-outermost: root redex first, then fn, then arg, then inside lambda bodies.
function findRedex(t: Term): Path | null {
  if (t.kind === "app") {
    if (t.fn.kind === "lam") return [];
    const inFn = findRedex(t.fn);
    if (inFn !== null) return ["fn", ...inFn];
    const inArg = findRedex(t.arg);
    if (inArg !== null) return ["arg", ...inArg];
    return null;
  }
  if (t.kind === "lam") {
    const inBody = findRedex(t.body);
    if (inBody !== null) return ["body", ...inBody];
    return null;
  }
  return null;
}

export function hasRedex(t: Term): boolean {
  return findRedex(t) !== null;
}

export function render(t: Term): string {
  switch (t.kind) {
    case "var":
      return t.name;
    case "lam":
      return `(L${t.param}.${render(t.body)})`;
    case "app":
      return `(${render(t.fn)} ${render(t.arg)})`;
  }
}
