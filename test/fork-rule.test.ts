// Where the pipeline's own branches go: the repository itself for the default owner's repos (the box account writes to
// them, and a repo's CI may run only for its own branches) and under the app identity; a fork for any other owner. PR
// look-ups count both head owners, and a push to the repository itself replaces only the pipeline's branch names.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Grant, GuardedRepo } from "../src/core/guard.ts";
import { connect } from "../src/db.ts";
import { branchesInRepo, forkOf, headOwnersOf } from "../src/fixissue/index.ts";
import type { Exec, ExecResult } from "../src/fixup/git.ts";
import { pushOwnBranch } from "../src/github/write.ts";
import { DEFAULT_OWNER, loadOwners } from "../src/owners.ts";

function setup() {
  const db = connect(":memory:");
  db.prepare("INSERT INTO repos (name, owner, visibility) VALUES ('poka', ?, 'private'), ('egui', 'emilk', 'public')").run(DEFAULT_OWNER);
  loadOwners(db);
  const calls: string[] = [];
  const run: Exec = async (cmd, args): Promise<ExecResult> => {
    calls.push(`${cmd} ${args.join(" ")}`);
    // The box account's fork of egui exists already.
    if (cmd === "gh" && args[1] === "repos/pipeline-bot/egui") return { code: 0, stdout: "emilk/egui\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { db, calls, run };
}

test("with the box identity a default-owner repo's branches go to the repository itself; another owner's to the fork", async () => {
  const { db, calls, run } = setup();
  const g = { repo: "poka" } as unknown as GuardedRepo;
  assert.equal(branchesInRepo(db, "poka"), true);
  assert.equal(await forkOf({ db, login: "fixissue" }, g, run, "pipeline-bot", "poka"), `${DEFAULT_OWNER}/poka`);
  assert.deepEqual(calls, [], "no fork is looked up or created");
  assert.deepEqual(headOwnersOf(db, "poka", "pipeline-bot"), ["pipeline-bot", DEFAULT_OWNER], "a PR from the old fork is still adopted");
  assert.equal(branchesInRepo(db, "egui"), false);
  assert.equal(await forkOf({ db, login: "fixissue" }, { repo: "egui" } as unknown as GuardedRepo, run, "pipeline-bot", "egui"), "pipeline-bot/egui");
  assert.deepEqual(headOwnersOf(db, "egui", "pipeline-bot"), ["pipeline-bot"]);
});

test("a push to the repository itself may replace only an autocraft/ or integration- branch", async () => {
  const { db } = setup();
  const g = { scope: "repo", need: "main-fix", repo: "poka" } as unknown as Grant;
  const pushes: string[][] = [];
  const git = { git: async (args: string[]) => { pushes.push(args); return { code: 0, stdout: "", stderr: "" }; } };
  const sha = "a".repeat(40);
  assert.throws(() => pushOwnBranch({ db, login: "mainfix" }, g, git, "main-fix-push", { repo: "poka", remote: `${DEFAULT_OWNER}/poka`, branch: "main", sha }), /autocraft\/ or integration- branch/);
  assert.equal(pushes.length, 0);
  const r = await pushOwnBranch({ db, login: "mainfix" }, g, git, "main-fix-push", { repo: "poka", remote: `${DEFAULT_OWNER}/poka`, branch: "autocraft/main-ci-test-abc1234", sha });
  assert.equal(r.code, 0);
  assert.ok(pushes[0]!.includes(`https://github.com/${DEFAULT_OWNER}/poka.git`) && pushes[0]!.includes("--force"));
});
