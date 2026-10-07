// 无类型 Lambda 项的 JSON 树表示
export type Term = Var | Lam | App;

export interface Var {
  kind: "var";
  name: string;
}

export interface Lam {
  kind: "lam";
  param: string;
  body: Term;
}

export interface App {
  kind: "app";
  fn: Term;
  arg: Term;
}

// 单步 beta 归约中发生的一次 alpha 改名
export interface Rename {
  // 被改名的绑定所在的抽象在“本步开始项”中的路径
  binderPath: (string | number)[];
  from: string;
  to: string;
  reason: string;
}

export interface ReductionStep {
  index: number; // 从 1 开始的 beta 步序号
  path: (string | number)[]; // 选中的 redex 路径，相对本步开始项
  replacedVar: string; // 该步 beta 中被替换的绑定变量
  renames: Rename[];
  before: Term;
  after: Term;
}

export type ReductionStatus = "normal" | "budget_exhausted";

export interface ReductionResult {
  status: ReductionStatus;
  steps: ReductionStep[];
  final: Term;
  redexRemaining: boolean;
}
