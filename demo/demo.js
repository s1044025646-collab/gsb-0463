import { Store } from "../dist/db.js";
import { Service } from "../dist/service.js";
import { readFileSync } from "node:fs";

const svc = new Service(new Store("data/demo.db"));
const load = (f) => JSON.parse(readFileSync(f, "utf8"));

function banner(s) { console.log("\n=== " + s + " ==="); }

banner("demo 1: (Lx.Ly.x) y  -- capture-avoiding reduction");
let r = svc.createReduction({ term: load("examples/const-y.json"), budget: 10 });
svc.run(r.id);
let info = svc.getReduction(r.id);
for (const s of info.steps) {
  console.log(`step ${s.stepIndex} path=[${s.path}] replace=${s.replacedVar} renames=${JSON.stringify(s.renames)}`);
}
console.log("status:", info.status);
console.log("final:", JSON.stringify(info.current));
const alpha = svc.alphaEquivalent(info.current, load("examples/lam-z-y.json"));
console.log("alpha-equivalent to (Lz.y) with y free:", alpha.equivalent);

banner("demo 2: (Lx.Lx.x) y  -- inner shadowing preserved");
r = svc.createReduction({ term: load("examples/shadow.json"), budget: 10 });
svc.run(r.id);
info = svc.getReduction(r.id);
console.log("status:", info.status, "final:", JSON.stringify(info.current));

banner("demo 3: Omega with budget 3 -- budget_exhausted, not a termination claim");
r = svc.createReduction({ term: load("examples/omega.json"), budget: 3 });
svc.run(r.id);
info = svc.getReduction(r.id);
console.log("status:", info.status, "stepsDone:", info.stepsDone);

banner("demo 4: (Lx.z) Omega -- normal order discards Omega in ONE step");
r = svc.createReduction({ term: load("examples/discard-omega.json"), budget: 10 });
svc.run(r.id);
info = svc.getReduction(r.id);
console.log("status:", info.status, "stepsDone:", info.stepsDone, "final:", JSON.stringify(info.current));
