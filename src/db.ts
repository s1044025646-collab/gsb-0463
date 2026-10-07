import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ReductionStatus, ReductionStep, Term } from "./types.js";

export interface TermRow {
  id: number;
  label: string | null;
  term: Term;
  createdAt: string;
}

export interface AnalysisRow {
  id: number;
  termId: number;
  strategyVersion: string;
  maxSteps: number;
  status: ReductionStatus;
  stepsUsed: number;
  redexRemaining: number;
  finalTerm: Term;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface StoredStep {
  analysisId: number;
  stepIndex: number;
  pathJson: string;
  replacedVar: string;
  renamesJson: string;
  beforeJson: string;
  afterJson: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT,
        term_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term_id INTEGER NOT NULL REFERENCES terms(id),
        strategy_version TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        status TEXT NOT NULL,
        steps_used INTEGER NOT NULL,
        redex_remaining INTEGER NOT NULL,
        final_term_json TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS steps (
        analysis_id INTEGER NOT NULL REFERENCES analyses(id),
        step_index INTEGER NOT NULL,
        path_json TEXT NOT NULL,
        replaced_var TEXT NOT NULL,
        renames_json TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        PRIMARY KEY (analysis_id, step_index)
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_term ON analyses(term_id, max_steps);
    `);
  }

  insertTerm(term: Term, label: string | null): number {
    const stmt = this.db.prepare("INSERT INTO terms (label, term_json) VALUES (?, ?)");
    const info = stmt.run(label, JSON.stringify(term));
    return Number(info.lastInsertRowid);
  }

  getTerm(id: number): TermRow | null {
    const row = this.db
      .prepare("SELECT id, label, term_json, created_at FROM terms WHERE id = ?")
      .get(id) as
      | { id: number; label: string | null; term_json: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      label: row.label,
      term: JSON.parse(row.term_json) as Term,
      createdAt: row.created_at,
    };
  }

  // 修改原项 = 新 term 行；分析只挂在具体 term 上，旧轨迹不被覆盖。
  findAnalysis(termId: number, maxSteps: number): AnalysisRow | null {
    const row = this.db
      .prepare(
        `SELECT id, term_id, strategy_version, max_steps, status, steps_used,
                redex_remaining, final_term_json, error_code, error_message, created_at
         FROM analyses WHERE term_id = ? AND max_steps = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(termId, maxSteps) as Record<string, unknown> | undefined;
    return row ? this.toAnalysisRow(row) : null;
  }

  getAnalysis(id: number): AnalysisRow | null {
    const row = this.db
      .prepare(
        `SELECT id, term_id, strategy_version, max_steps, status, steps_used,
                redex_remaining, final_term_json, error_code, error_message, created_at
         FROM analyses WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toAnalysisRow(row) : null;
  }

  private toAnalysisRow(row: Record<string, unknown>): AnalysisRow {
    return {
      id: Number(row.id),
      termId: Number(row.term_id),
      strategyVersion: String(row.strategy_version),
      maxSteps: Number(row.max_steps),
      status: String(row.status) as ReductionStatus,
      stepsUsed: Number(row.steps_used),
      redexRemaining: Number(row.redex_remaining),
      finalTerm: JSON.parse(String(row.final_term_json)) as Term,
      errorCode: (row.error_code as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  }

  createAnalysis(
    termId: number,
    strategyVersion: string,
    maxSteps: number,
    status: ReductionStatus,
    finalTerm: Term,
    steps: ReductionStep[],
    error: { code: string; message: string } | null
  ): number {
    const insertAnalysis = this.db.prepare(
      `INSERT INTO analyses
         (term_id, strategy_version, max_steps, status, steps_used, redex_remaining,
          final_term_json, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertStep = this.db.prepare(
      `INSERT INTO steps
         (analysis_id, step_index, path_json, replaced_var, renames_json, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec("BEGIN");
    try {
      const info = insertAnalysis.run(
        termId,
        strategyVersion,
        maxSteps,
        status,
        steps.length,
        status === "budget_exhausted" ? 1 : 0,
        JSON.stringify(finalTerm),
        error?.code ?? null,
        error?.message ?? null
      );
      const analysisId = Number(info.lastInsertRowid);
      for (const s of steps) {
        insertStep.run(
          analysisId,
          s.index,
          JSON.stringify(s.path),
          s.replacedVar,
          JSON.stringify(s.renames),
          JSON.stringify(s.before),
          JSON.stringify(s.after)
        );
      }
      this.db.exec("COMMIT");
      return analysisId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSteps(analysisId: number, limit: number, offset: number): StoredStep[] {
    const rows = this.db
      .prepare(
        `SELECT analysis_id, step_index, path_json, replaced_var, renames_json, before_json, after_json
         FROM steps WHERE analysis_id = ? ORDER BY step_index ASC LIMIT ? OFFSET ?`
      )
      .all(analysisId, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => ({
      analysisId: Number(r.analysis_id),
      stepIndex: Number(r.step_index),
      pathJson: String(r.path_json),
      replacedVar: String(r.replaced_var),
      renamesJson: String(r.renames_json),
      beforeJson: String(r.before_json),
      afterJson: String(r.after_json),
    }));
  }

  countSteps(analysisId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM steps WHERE analysis_id = ?")
      .get(analysisId) as { c: number | bigint };
    return Number(row.c);
  }

  close(): void {
    this.db.close();
  }
}
