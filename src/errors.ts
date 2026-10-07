export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_TERM"
  | "NAME_REQUIRED"
  | "NAME_TOO_LONG"
  | "TREE_TOO_DEEP"
  | "TOO_MANY_NODES"
  | "INPUT_TOO_LARGE"
  | "INTERMEDIATE_TOO_LARGE"
  | "BUDGET_INVALID"
  | "BUDGET_TOO_LARGE"
  | "NOT_FOUND"
  | "IDEMPOTENT_MISMATCH"
  | "BAD_REQUEST";

export class LambdaError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
