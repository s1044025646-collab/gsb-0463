import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Term, StepInfo } from "./core.js";

export const STRATEGY_VERSION = "normal-order-beta-v1";

export type ReductionStatus = "running" | "normal_form" | "budget_exhausted" | "failed";

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS reductions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term_id INTEGER NOT NULL REFERENCES terms(id),
        original_json TEXT NOT NULL,
        current_json TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        budget INTEGER NOT NULL,
        steps_done INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS steps (
        reduction_id INTEGER NOT NULL REFERENCES reductions(id),
        step_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        replaced_var TEXT NOT NULL,
        renames TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (reduction_id, step_index)
      );
    `);
  }

  createTerm(json: string): number {
    const r = this.db.prepare("INSERT INTO terms (json) VALUES (?)").run(json);
    return Number(r.lastInsertRowid);
  }

  getTerm(id: number): { id: number; json: string; created_at: string } | null {
    return (this.db.prepare("SELECT * FROM terms WHERE id = ?").get(id) as never) ?? null;
  }

  createReduction(termId: number, originalJson: string, budget: number): number {
    const r = this.db
      .prepare(
        "INSERT INTO reductions (term_id, original_json, current_json, strategy_version, budget) VALUES (?,?,?,?,?)"
      )
      .run(termId, originalJson, originalJson, STRATEGY_VERSION, budget);
    return Number(r.lastInsertRowid);
  }

  getReduction(id: number): {
    id: number; term_id: number; original_json: string; current_json: string;
    strategy_version: string; budget: number; steps_done: number;
    status: ReductionStatus; error: string | null; created_at: string;
  } | null {
    return (this.db.prepare("SELECT * FROM reductions WHERE id = ?").get(id) as never) ?? null;
  }

  // Commits one step atomically. Returns false if the step index already exists
  // (idempotent retry: caller should read the stored step instead).
  commitStep(reductionId: number, stepIndex: number, step: StepInfo, newStatus: ReductionStatus, error: string | null): boolean {
    const tx = this.db;
    tx.exec("BEGIN");
    try {
      tx.prepare(
        "INSERT INTO steps (reduction_id, step_index, path, replaced_var, renames, result_json) VALUES (?,?,?,?,?,?)"
      ).run(
        reductionId,
        stepIndex,
        JSON.stringify(step.path),
        step.replacedVar,
        JSON.stringify(step.renames),
        JSON.stringify(step.result)
      );
      tx.prepare("UPDATE reductions SET current_json = ?, steps_done = ?, status = ?, error = ? WHERE id = ?").run(
        JSON.stringify(step.result),
        stepIndex + 1,
        newStatus,
        error,
        reductionId
      );
      tx.exec("COMMIT");
      return true;
    } catch (e) {
      tx.exec("ROLLBACK");
      if (e instanceof Error && e.message.includes("UNIQUE")) return false;
      throw e;
    }
  }

  updateStatus(id: number, status: ReductionStatus, error: string | null): void {
    this.db.prepare("UPDATE reductions SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  getStep(reductionId: number, stepIndex: number): {
    step_index: number; path: string; replaced_var: string; renames: string; result_json: string;
  } | null {
    return (this.db.prepare("SELECT * FROM steps WHERE reduction_id = ? AND step_index = ?").get(reductionId, stepIndex) as never) ?? null;
  }

  getSteps(reductionId: number, offset: number, limit: number): Array<{
    step_index: number; path: string; replaced_var: string; renames: string; result_json: string;
  }> {
    return this.db
      .prepare("SELECT * FROM steps WHERE reduction_id = ? ORDER BY step_index LIMIT ? OFFSET ?")
      .all(reductionId, limit, offset) as never;
  }

  countSteps(reductionId: number): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM steps WHERE reduction_id = ?").get(reductionId) as { c: number };
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}

export function parseTerm(json: string): Term {
  return JSON.parse(json) as Term;
}
