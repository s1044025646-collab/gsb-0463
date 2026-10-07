// 服务级规模限制（可由环境变量覆盖）
export interface Limits {
  maxInputBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxIntermediateNodes: number;
  maxBudget: number;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const LIMITS: Limits = {
  maxInputBytes: num("LAMBDA_MAX_INPUT_BYTES", 64 * 1024),
  maxDepth: num("LAMBDA_MAX_DEPTH", 200),
  maxNodes: num("LAMBDA_MAX_NODES", 20_000),
  maxIntermediateNodes: num("LAMBDA_MAX_INTERMEDIATE_NODES", 200_000),
  maxBudget: num("LAMBDA_MAX_BUDGET", 1_000_000),
};

// 归约策略版本：改变归约顺序或改名规则时递增，便于历史轨迹区分
export const STRATEGY_VERSION = "normal-order-v1";
