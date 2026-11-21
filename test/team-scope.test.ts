// The team's own items: the classifier's "needs decision" flag asks no "Is this wanted?" question of an item an org member or
// the repo owner wrote, and each sync withdraws the open scope questions that rule leaves without a reason.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { connect } from "../src/db.ts";
import { ask, getDecision } from "../src/decisions.ts";
import { TEAM_SCOPE_NOTE, unneededScopeQuestions, withdrawUnneededScope } from "../src/core/scope-unneeded.ts";
import { teamAuthorTest } from "../src/outside.ts";

mkdirSync(SCRATCH, { recursive: true });
const T0 = "2026-01-01T00:00:00Z";
const OPTIONS = [{ key: "take", label: "Wanted" }, { key: "close", label: "Out of scope" }];

function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(SCRATCH, "team-scope-test-")), "t.db"));
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  db.prepare("INSERT INTO tracked_repos (name) VALUES ('app')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, author, author_association, author_type, created_at, updated_at, labels)
    VALUES ('app', ?, 'issue', 'OPEN', ?, 'Body', ?, ?, ?, '${T0}', '${T0}', '[]')`);
  item.run(1, "The owner's issue", "owner", "OWNER", "User");
  item.run(2, "A member's issue", "member", "MEMBER", "User");
  item.run(3, "An outsider's issue", "stranger", "NONE", "User");
  item.run(4, "A collaborator's issue", "helper", "COLLABORATOR", "User");
  item.run(5, "A bot's issue", "renovate[bot]", "MEMBER", "Bot");
  // Basal is sure of the type and of the flag, so each item settles as a bug with "needs decision".
  const cls = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, reason, probs)
    VALUES ('app', ?, 'basal', 'run1', '${T0}', 'bug', '["needs decision"]', 'r', '{"type":{"bug":0.97},"top":0.97,"security":0.01,"needs_decision":0.95}')`);
  for (const n of [1, 2, 3, 4, 5]) cls.run(n);
  return db;
}

describe("team-written items", () => {
  test("an org member and the repo owner are the team; an outsider, a collaborator and a bot are not", () => {
    const team = teamAuthorTest(fresh());
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => team("app", n)), [true, true, false, false, false]);
  });

  test("a sync withdraws the open scope questions of team-written items and keeps the others", () => {
    const db = fresh();
    ask(db, [1, 2, 3].map((n) => ({ id: `app#${n}:scope`, kind: "scope" as const, repo: "app", number: n, question: "Is this wanted?", options: OPTIONS })));
    assert.deepEqual(unneededScopeQuestions(db).map((d) => d.id), ["app#1:scope", "app#2:scope"]);
    assert.equal(withdrawUnneededScope(db, T0), 2);
    assert.equal(getDecision(db, "app#1:scope"), undefined, "the withdrawn question left its id");
    assert.equal(getDecision(db, "app#3:scope")!.answer, null, "the outsider's question stays open");
    const old = db.prepare("SELECT answer, answered_by, answer_note FROM decisions WHERE id LIKE 'app#2:scope~replaced-%'").get()!;
    assert.deepEqual({ ...old }, { answer: "withdrawn", answered_by: "pipeline", answer_note: TEAM_SCOPE_NOTE });
    assert.equal(withdrawUnneededScope(db, T0), 0, "nothing is left to withdraw");
  });
});
