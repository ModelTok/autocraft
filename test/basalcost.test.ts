import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { askBasal, runBasal, saveUsage, setBasalRunner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

const answers = {
  type: { type: "choice", choice: "performance", confidence: 0.8, probabilities: { performance: 0.8, bugfix: 0.2 } },
  security: { type: "noul", noul: 0.7 }, needs_decision: { type: "noul", noul: 0.1 },
};
const fresh = () => connect(join(mkdtempSync(join(SCRATCH, "basalcost-")), "t.db"));
const row = (db: ReturnType<typeof fresh>, agent: string) =>
  db.prepare("SELECT cost_usd AS c, input_tokens AS input FROM token_usage WHERE agent = ?").get(agent) as { c: number | null; input: number };

test("a basal call answered by basal-serve records its tokens and no charge, and the old-basal pricing migration leaves it alone", async () => {
  const dir = mkdtempSync(join(SCRATCH, "basalcost-"));
  const path = join(dir, "t.db");
  const db = connect(path);
  const restore = setBasalRunner(async () => ({ code: 0, stderr: "", status: 200, stdout: JSON.stringify({ model: "basal-2.0-4.5B", answers, usage: { input_tokens: 1_000_000, output_tokens: 0 } }) }));
  try {
    const item = { repo: "a", number: 1, kind: "pr" as const, title: "t", body: "b", lines_changed: 1, files_changed: 1, author_association: null };
    await runBasal(db, "run1", [item], 1);
  } finally { restore(); }
  assert.equal(row(db, "basal-a#1").input, 1_000_000);
  assert.equal(row(db, "basal-a#1").c, 0);
  db.close();
  const again = connect(path);
  assert.equal(row(again, "basal-a#1").c, 0);
});

test("the migration prices unpriced rows of the hosted model basal replaced, renames their agents, and leaves other models alone", () => {
  const dir = mkdtempSync(join(SCRATCH, "basalcost-"));
  const path = join(dir, "t.db");
  const db = connect(path);
  const u = { input: 2_000_000, output: 5, cacheRead: 0, cacheWrite: 0, cost: null };
  saveUsage(db, "r", "jev-x", "classify", "jev-latest", 1, u, "s", "e");
  db.prepare("DELETE FROM settings WHERE key = 'provider_renamed_basal'").run();
  saveUsage(db, "r", "haiku-x", "classify", "haiku", 1, u, "s", "e");
  db.close();
  const again = connect(path);
  assert.ok(Math.abs(row(again, "basal-x").c! - 0.084) < 1e-9);
  assert.equal(row(again, "haiku-x").c, null);
});

test("priority and dupes basal calls are saved under their own stage", async () => {
  const db = fresh();
  const restore = setBasalRunner(async () => ({ code: 0, stderr: "", status: 200, stdout: JSON.stringify({ answers: {}, usage: { input_tokens: 500_000, output_tokens: 0 } }) }));
  try {
    const item = { repo: "a", number: 1, kind: "pr" as const, title: "t", body: "b", lines_changed: 1, files_changed: 1, author_association: null };
    await askBasal("priority.basal", item, db);
  } finally { restore(); }
  const r = db.prepare("SELECT stage, model, input_tokens AS input FROM token_usage").get() as { stage: string; model: string; input: number };
  assert.equal(r.stage, "priority");
  assert.equal(r.model, "basal");
  assert.equal(r.input, 500_000);
});
