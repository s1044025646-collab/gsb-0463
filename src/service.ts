import {
  Term, validateTerm, freeVars, substitute, alphaEquivalent, betaStep, hasRedex,
  LambdaError, Limits, DEFAULT_LIMITS, countNodes,
} from "./core.js";
import { Store, ReductionStatus } from "./db.js";

export class Service {
  constructor(private store: Store, private limits: Limits = DEFAULT_LIMITS) {}

  importTerm(raw: unknown): { id: number } {
    const bytes = Buffer.byteLength(JSON.stringify(raw ?? ""), "utf8");
    if (bytes > this.limits.maxInputBytes)
      throw new LambdaError("LIMIT_EXCEEDED", `input exceeds ${this.limits.maxInputBytes} bytes`);
    const term = validateTerm(raw, this.limits);
    const id = this.store.createTerm(JSON.stringify(term));
    return { id };
  }

  getTerm(id: number): { id: number; term: Term } {
    const row = this.store.getTerm(id);
    if (!row) throw new LambdaError("TERM_NOT_FOUND", `term ${id} not found`);
    return { id, term: JSON.parse(row.json) as Term };
  }

  freeVariables(id: number): { id: number; freeVariables: string[] } {
    const { term } = this.getTerm(id);
    return { id, freeVariables: freeVars(term) };
  }

  substitute(rawBody: unknown, varName: string, rawArg: unknown): { result: Term; renames: unknown[] } {
    if (typeof varName !== "string" || varName.length === 0)
      throw new LambdaError("INVALID_REQUEST", "var must be a non-empty string");
    const body = validateTerm(rawBody, this.limits);
    const arg = validateTerm(rawArg, this.limits);
    const { result, renames } = substitute(body, varName, arg);
    if (countNodes(result) > this.limits.maxIntermediateNodes)
      throw new LambdaError("LIMIT_EXCEEDED", "substitution result exceeds intermediate size limit");
    return { result, renames };
  }

  alphaEquivalent(rawA: unknown, rawB: unknown): { equivalent: boolean } {
    const a = validateTerm(rawA, this.limits);
    const b = validateTerm(rawB, this.limits);
    return { equivalent: alphaEquivalent(a, b) };
  }

  createReduction(opts: { termId?: number; term?: unknown; budget: unknown }): { id: number; status: ReductionStatus } {
    let termId: number;
    let termJson: string;
    if (opts.termId !== undefined) {
      const row = this.store.getTerm(opts.termId);
      if (!row) throw new LambdaError("TERM_NOT_FOUND", `term ${opts.termId} not found`);
      termId = opts.termId;
      termJson = row.json;
    } else if (opts.term !== undefined) {
      const term = validateTerm(opts.term, this.limits);
      termJson = JSON.stringify(term);
      termId = this.store.createTerm(termJson);
    } else {
      throw new LambdaError("INVALID_REQUEST", "provide termId or term");
    }
    const budget = opts.budget;
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0)
      throw new LambdaError("INVALID_BUDGET", "budget must be a non-negative integer");
    const id = this.store.createReduction(termId, termJson, budget);
    return { id, status: "running" };
  }

  getReduction(id: number, offset = 0, limit = 100): Record<string, unknown> {
    const r = this.store.getReduction(id);
    if (!r) throw new LambdaError("REDUCTION_NOT_FOUND", `reduction ${id} not found`);
    const steps = this.store.getSteps(id, offset, limit).map((s) => ({
      stepIndex: s.step_index,
      path: JSON.parse(s.path),
      replacedVar: s.replaced_var,
      renames: JSON.parse(s.renames),
      result: JSON.parse(s.result_json),
    }));
    return {
      id: r.id,
      termId: r.term_id,
      strategyVersion: r.strategy_version,
      budget: r.budget,
      stepsDone: r.steps_done,
      status: r.status,
      error: r.error,
      original: JSON.parse(r.original_json),
      current: JSON.parse(r.current_json),
      totalSteps: this.store.countSteps(id),
      steps,
    };
  }

  // Executes exactly one beta step. Idempotent via expectedStepIndex: if the
  // caller repeats a request for an already-committed index, the stored step
  // is returned without reducing further.
  step(id: number, expectedStepIndex?: number): Record<string, unknown> {
    const r = this.store.getReduction(id);
    if (!r) throw new LambdaError("REDUCTION_NOT_FOUND", `reduction ${id} not found`);

    if (expectedStepIndex !== undefined) {
      const existing = this.store.getStep(id, expectedStepIndex);
      if (existing) {
        return {
          id, status: r.status, alreadyCommitted: true,
          step: {
            stepIndex: existing.step_index,
            path: JSON.parse(existing.path),
            replacedVar: existing.replaced_var,
            renames: JSON.parse(existing.renames),
            result: JSON.parse(existing.result_json),
          },
        };
      }
      if (expectedStepIndex !== r.steps_done)
        throw new LambdaError("STEP_INDEX_MISMATCH", `expected step ${expectedStepIndex} but next step is ${r.steps_done}`);
    }

    if (r.status === "failed")
      throw new LambdaError("REDUCTION_FAILED", `reduction ${id} previously failed: ${r.error}`);
    if (r.status === "normal_form")
      return { id, status: r.status, message: "term is already in normal form", step: null };
    if (r.status === "budget_exhausted")
      return { id, status: r.status, message: "budget exhausted; term still has redexes", step: null };

    const current = JSON.parse(r.current_json) as Term;

    if (r.steps_done >= r.budget) {
      const status: ReductionStatus = hasRedex(current) ? "budget_exhausted" : "normal_form";
      this.store.updateStatus(id, status, status === "budget_exhausted" ? "budget exhausted with redexes remaining" : null);
      return { id, status, message: status === "budget_exhausted" ? "budget exhausted; term still has redexes" : "term reached normal form exactly at budget", step: null };
    }

    let info;
    try {
      info = betaStep(current, this.limits);
    } catch (e) {
      if (e instanceof LambdaError && e.code === "LIMIT_EXCEEDED") {
        this.store.updateStatus(id, "failed", e.message);
        return { id, status: "failed", error: e.message, step: null };
      }
      throw e;
    }

    if (info === null) {
      this.store.updateStatus(id, "normal_form", null);
      return { id, status: "normal_form", message: "term is in normal form", step: null };
    }

    const nextStatus: ReductionStatus = r.steps_done + 1 >= r.budget
      ? hasRedex(info.result) ? "budget_exhausted" : "normal_form"
      : "running";
    const committed = this.store.commitStep(id, r.steps_done, info, nextStatus,
      nextStatus === "budget_exhausted" ? "budget exhausted with redexes remaining" : null);
    if (!committed) {
      const existing = this.store.getStep(id, r.steps_done)!;
      return {
        id, status: this.store.getReduction(id)!.status, alreadyCommitted: true,
        step: {
          stepIndex: existing.step_index,
          path: JSON.parse(existing.path),
          replacedVar: existing.replaced_var,
          renames: JSON.parse(existing.renames),
          result: JSON.parse(existing.result_json),
        },
      };
    }
    return {
      id, status: nextStatus,
      step: { stepIndex: r.steps_done, path: info.path, replacedVar: info.replacedVar, renames: info.renames, result: info.result },
    };
  }

  // Runs steps until normal form, budget exhaustion, or failure. Used by CLI demo.
  run(id: number): Record<string, unknown> {
    const out: unknown[] = [];
    for (;;) {
      const s = this.step(id);
      out.push(s);
      if (s.status !== "running") break;
      if (out.length > 100000) throw new LambdaError("INTERNAL", "runaway");
    }
    return { id, final: this.getReduction(id), trace: out };
  }
}
