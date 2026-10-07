import { LambdaError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { Term } from "./types.js";

const MAX_NAME_LEN = 128;

// 解析并校验外部 JSON。返回项树，绝不信任未校验输入。
export function parseTerm(json: string): Term {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new LambdaError("INVALID_JSON", "输入不是合法 JSON");
  }
  return validateTerm(raw);
}

export function validateTerm(raw: unknown, depth = 1): Term {
  if (depth > LIMITS.maxDepth) {
    throw new LambdaError("TREE_TOO_DEEP", `树深度超过限制 ${LIMITS.maxDepth}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LambdaError("INVALID_TERM", "项必须是对象，且 kind 为 var | lam | app");
  }
  const node = raw as Record<string, unknown>;
  if (node.kind === "var") {
    validateName(node.name);
    return { kind: "var", name: node.name as string };
  }
  if (node.kind === "lam") {
    validateName(node.param);
    if (!("body" in node)) {
      throw new LambdaError("INVALID_TERM", "lam 必须包含 body");
    }
    return { kind: "lam", param: node.param as string, body: validateTerm(node.body, depth + 1) };
  }
  if (node.kind === "app") {
    if (!("fn" in node) || !("arg" in node)) {
      throw new LambdaError("INVALID_TERM", "app 必须包含 fn 与 arg");
    }
    return {
      kind: "app",
      fn: validateTerm(node.fn, depth + 1),
      arg: validateTerm(node.arg, depth + 1),
    };
  }
  throw new LambdaError("INVALID_TERM", "未知节点 kind，仅允许 var | lam | app");
}

function validateName(value: unknown): void {
  if (typeof value !== "string") {
    throw new LambdaError("NAME_REQUIRED", "变量名必须是非空字符串");
  }
  if (value.length === 0) {
    throw new LambdaError("NAME_REQUIRED", "变量名不能为空");
  }
  if (value.length > MAX_NAME_LEN) {
    throw new LambdaError("NAME_TOO_LONG", `变量名长度超过 ${MAX_NAME_LEN}`);
  }
}

export function nodeCount(t: Term): number {
  switch (t.kind) {
    case "var":
      return 1;
    case "lam":
      return 1 + nodeCount(t.body);
    case "app":
      return 1 + nodeCount(t.fn) + nodeCount(t.arg);
  }
}

export function assertWithinInputLimits(t: Term, byteLength: number): void {
  if (byteLength > LIMITS.maxInputBytes) {
    throw new LambdaError(
      "INPUT_TOO_LARGE",
      `输入 ${byteLength} 字节超过限制 ${LIMITS.maxInputBytes}`
    );
  }
  const n = nodeCount(t);
  if (n > LIMITS.maxNodes) {
    throw new LambdaError("TOO_MANY_NODES", `节点数 ${n} 超过限制 ${LIMITS.maxNodes}`);
  }
}
