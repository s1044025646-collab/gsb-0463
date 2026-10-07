import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./db.js";
import { Service } from "./service.js";
import { startServer } from "./server.js";
import { DEFAULT_LIMITS, LambdaError, render, Term } from "./core.js";

const DEFAULT_DB = resolve("data", "lambda.db");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readJson(source: string): unknown {
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  return JSON.parse(text);
}

function show(t: Term): string {
  return render(t);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const dbPath = argValue(args, "--db") ?? process.env.LAMBDA_DB ?? DEFAULT_DB;

  if (cmd === "serve") {
    const portArg = argValue(args, "--port");
    const port = portArg !== undefined ? Number(portArg) : process.env.PORT !== undefined ? Number(process.env.PORT) : 0;
    const service = new Service(new Store(dbPath));
    const { port: bound } = await startServer(service, port);
    console.log(`lambda service listening on http://127.0.0.1:${bound} (db: ${dbPath})`);
    return;
  }

  const service = new Service(new Store(dbPath));
  try {
    switch (cmd) {
      case "import": {
        const out = service.importTerm(readJson(args[0]));
        console.log(JSON.stringify(out));
        break;
      }
      case "fv": {
        console.log(JSON.stringify(service.freeVariables(Number(args[0]))));
        break;
      }
      case "subst": {
        const body = readJson(argValue(args, "--body") ?? "");
        const arg = readJson(argValue(args, "--arg") ?? "");
        const v = argValue(args, "--var") ?? "";
        const r = service.substitute(body, v, arg);
        console.log(JSON.stringify(r, null, 2));
        console.error(`result: ${show(r.result)}`);
        break;
      }
      case "alpha": {
        const r = service.alphaEquivalent(readJson(args[0]), readJson(args[1]));
        console.log(JSON.stringify(r));
        break;
      }
      case "reduce": {
        const budget = Number(argValue(args, "--budget") ?? "0");
        const termFile = argValue(args, "--term");
        const termId = argValue(args, "--term-id");
        const created = service.createReduction(
          termFile !== undefined
            ? { term: readJson(termFile), budget }
            : { termId: Number(termId), budget }
        );
        console.log(`reduction ${created.id} created (budget ${budget})`);
        const run = service.run(created.id);
        const final = run.final as { status: string; stepsDone: number; steps: Array<{ stepIndex: number; path: unknown[]; replacedVar: string; renames: unknown[]; result: Term }>; current: Term };
        for (const s of final.steps) {
          console.log(`step ${s.stepIndex}: path=[${s.path.join(",")}] replace ${s.replacedVar}` +
            (s.renames.length ? ` renames=${JSON.stringify(s.renames)}` : ""));
          console.log(`  => ${show(s.result)}`);
        }
        console.log(`status: ${final.status} after ${final.stepsDone} beta step(s)`);
        console.log(`final: ${show(final.current)}`);
        break;
      }
      case "step": {
        const expected = argValue(args, "--expected");
        const r = service.step(Number(args[0]), expected !== undefined ? Number(expected) : undefined);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case "show": {
        console.log(JSON.stringify(service.getReduction(Number(args[0])), null, 2));
        break;
      }
      case "export": {
        console.log(JSON.stringify(service.getReduction(Number(args[0]), 0, 100000), null, 2));
        break;
      }
      default:
        console.error(`usage:
  serve [--port N] [--db PATH]        start HTTP API (default port: auto)
  import <file|->                     import a JSON term
  fv <termId>                         list free variables
  subst --body f --var x --arg f      capture-avoiding substitution
  alpha <fileA> <fileB>               alpha-equivalence check
  reduce (--term f|--term-id N) --budget N   create reduction and run to completion
  step <reductionId> [--expected N]   execute exactly one beta step
  show <reductionId>                  show reduction state and steps
  export <reductionId>                export full reduction JSON`);
        process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof LambdaError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message } }));
      process.exitCode = 1;
    } else throw e;
  }
}

main();
