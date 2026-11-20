// The label set of 2026-11: type ids and their GitHub names, the migration of stored old labels, scope answers stored
// with the keys the scope question no longer offers, and the per-repo scope line in the classifier input.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LABELS } from "../src/classify/rules.ts";
import { itemInput, type Item } from "../src/classify/parse.ts";
import { loadItems } from "../src/classify/run.ts";
import { itemOf } from "../src/core/select-items.ts";
import { connect, migrateTypeLabels, RENAMED_TYPE_LABELS } from "../src/db.ts";
import { shapeOf } from "../src/decide/decision.ts";
import { ALL_LABELS, githubFlagLabel, githubTypeLabel, isTypeLabel, NEEDS_DECISION, sameType, TYPE_LABELS } from "../src/labels/set.ts";
import { repoScope, setRepoScope } from "../src/repo-scope.ts";
import { scopeAnswers, settledScope } from "../src/review/candidates.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const fresh = (name: string) => connect(join(mkdtempSync(join(SCRATCH, `${name}-`)), "t.db"));

test("the type ids are the eight of the new set, one GitHub label each", () => {
  assert.deepEqual([...LABELS], ["bug", "enhancement", "new feature", "performance", "chore", "documentation", "gtm", "task"]);
  assert.deepEqual(TYPE_LABELS.map((l) => l.name), [...LABELS]);
  const names = ALL_LABELS.map((l) => l.name);
  assert.deepEqual(names, [...LABELS, "bugfix", "security", "needs-owner"]);
  assert.equal(new Set(names).size, names.length, "no label is listed twice");
  for (const old of ["missing feature", "small extra", "plugin candidate", "infra", "needs decision"]) assert.ok(!names.includes(old), `${old} is gone`);
});

test("githubTypeLabel: an issue gets bug, a PR gets bugfix; every other id is its own label", () => {
  assert.equal(githubTypeLabel("bug", "issue"), "bug");
  assert.equal(githubTypeLabel("bug", "pr"), "bugfix");
  for (const t of LABELS.filter((l) => l !== "bug")) {
    assert.equal(githubTypeLabel(t, "issue"), t);
    assert.equal(githubTypeLabel(t, "pr"), t);
  }
  assert.equal(githubFlagLabel(NEEDS_DECISION), "needs-owner");
  assert.equal(githubFlagLabel("security"), "security");
  assert.ok(isTypeLabel("bugfix") && isTypeLabel("Bug") && isTypeLabel("gtm"));
  assert.ok(!isTypeLabel("needs-owner") && !isTypeLabel("infra") && !isTypeLabel("roadmap"));
  assert.ok(sameType("bug", "bugfix") && sameType("BUGFIX", "bug") && !sameType("bug", "chore"));
});

test("the migration rewrites stored old type labels to the new ids, once", () => {
  assert.deepEqual({ ...RENAMED_TYPE_LABELS }, {
    bugfix: "bug", "missing feature": "new feature", "small extra": "enhancement", "plugin candidate": "new feature", infra: "chore",
  });
  for (const to of Object.values(RENAMED_TYPE_LABELS)) assert.ok((LABELS as readonly string[]).includes(to), `${to} is a type id`);
  const db = fresh("label-migration");
  const put = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags) VALUES ('app', ?, 'basal', 'r1', 't', ?, '[]')");
  const old = ["bugfix", "missing feature", "small extra", "plugin candidate", "infra", "performance", "task"];
  old.forEach((l, i) => put.run(i + 1, l));
  db.prepare("DELETE FROM settings WHERE key = 'type_labels_renamed_2026_11'").run();
  migrateTypeLabels(db);
  const got = (db.prepare("SELECT type_label FROM classifications ORDER BY number").all() as { type_label: string }[]).map((r) => r.type_label);
  assert.deepEqual(got, ["bug", "new feature", "enhancement", "new feature", "chore", "performance", "task"]);
  // Runs once: a row written later is left as it is.
  put.run(99, "bugfix");
  migrateTypeLabels(db);
  assert.equal((db.prepare("SELECT type_label FROM classifications WHERE number = 99").get() as { type_label: string }).type_label, "bugfix");
});

test("scope answers stored as small-extra and plugin load as take and close", () => {
  const db = fresh("legacy-scope");
  const put = db.prepare(`INSERT INTO decisions (id, kind, repo, number, question, options, asked_at, answer, answered_by, answered_at, answer_note)
    VALUES (?, 'scope', 'app', ?, 'q', '[]', 't', ?, 'someone', ?, 'kept')`);
  put.run("app#1:scope", 1, "small-extra", "2026-11-01");
  put.run("app#2:scope", 2, "plugin", "2026-11-01");
  put.run("app#3:scope", 3, "take", "2026-11-01");
  const a = scopeAnswers(db);
  assert.equal(a.get("app#1"), "take");
  assert.equal(a.get("app#2"), "close");
  assert.equal(a.get("app#3"), "take");
  // The keep-in-core answer of a legacy small-extra row is found with its answerer and note.
  assert.deepEqual(settledScope(db, "app", 1), { answer: "take", by: "someone", note: "kept" });
  assert.equal(settledScope(db, "app", 2), null);
});

test("the scope question offers take, need-info and close only", () => {
  const settled = (label: string | null, basalLabel: string | null = label, haikuLabel: string | null = null) =>
    ({ status: "settled", label, flags: [], basalLabel, haikuLabel, confidence: null }) as never;
  for (const label of ["new feature", "enhancement", "bug", "gtm"]) {
    assert.deepEqual(shapeOf({ repo: "app", number: 1, reason: "needs-decision", settled: settled(label) }).options, ["take", "need-info", "close"]);
  }
  const dis = shapeOf({ repo: "app", number: 1, reason: "scope-disagreement", settled: settled(null, "new feature", "enhancement") });
  assert.deepEqual(dis.options, ["take", "need-info", "close"]);
});

test("a repo's scope line reaches the classifier input as project, right after ref, and only when set", () => {
  const db = fresh("repo-scope");
  db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at) VALUES ('app', 1, 'issue', 'OPEN', 'Add EDL import', 'please', 'alice', 'a', 'a')").run();
  const keys = (i: Item) => Object.keys(itemInput(i));
  assert.equal(itemOf(db, "app", 1).project, undefined);
  assert.ok(!keys(itemOf(db, "app", 1)).includes("project"), "no project field without a scope line");
  assert.ok(!keys(loadItems(db, [{ repo: "app", number: 1 }])[0]!).includes("project"));

  assert.equal(setRepoScope(db, "op", "app", "  A video editor:\n cutting, colour and export  "), true);
  assert.equal(repoScope(db, "app"), "A video editor: cutting, colour and export");
  assert.equal(setRepoScope(db, "op", "app", "A video editor: cutting, colour and export"), false, "the same line changes nothing");
  for (const item of [itemOf(db, "app", 1), loadItems(db, [{ repo: "app", number: 1 }])[0]!]) {
    const input = itemInput(item);
    assert.deepEqual(Object.keys(input).slice(0, 3), ["ref", "project", "kind"]);
    assert.equal(input.project, "A video editor: cutting, colour and export");
  }

  assert.throws(() => setRepoScope(db, "op", "app", "   "), /empty/);
  assert.equal(setRepoScope(db, "op", "app", null), true);
  assert.equal(repoScope(db, "app"), undefined);
  assert.ok(!keys(itemOf(db, "app", 1)).includes("project"));
});
