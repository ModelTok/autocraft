// Per-repo build settings (src/repo-build.ts): a repo's Rust tasks require its own toolchain; its companion sources are
// recorded in each task with a commit and reach only the test steps; held paths keep fix issues from opening a PR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnv, hello } from "../src/build/envs.ts";
import { claim, createTask } from "../src/build/tasks.ts";
import { knownHead, refreshCompanionHeads } from "../src/build/companions.ts";
import { connect } from "../src/db.ts";
import { DEFAULT_OWNER } from "../src/owners.ts";
import { heldPath, parseCompanionArgs, repoCompanions, rustToolchain, setRepoCompanions, setRepoHoldPaths, setRepoToolchain } from "../src/repo-build.ts";
import { rustPlan } from "../src/worker/rust.ts";

const SHA = "a".repeat(40);
const CORPUS = "c".repeat(40);
const CAPS = { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false };

function setup() {
  const db = connect(":memory:");
  db.prepare("INSERT INTO repos (name, owner, visibility) VALUES ('poka', ?, 'private'), ('app', ?, 'public'), ('lib', ?, 'public')").run(DEFAULT_OWNER, DEFAULT_OWNER, DEFAULT_OWNER);
  db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('poka', 1), ('app', 1), ('lib', 1)").run();
  const env = (id: string, toolchains: string[], privateCode = false) => {
    createEnv(db, { id, label: id, kind: "remote", slots: 4, ...(privateCode && { privateCode }) }, "op");
    hello(db, id, { version: "1", capabilities: { ...CAPS, toolchains, ...(privateCode && { privateOwner: DEFAULT_OWNER }) }, slots: 4 });
  };
  const requeue = () => db.prepare("UPDATE build_tasks SET state = 'queued', env_id = NULL").run();
  const audits = (action: string) => (db.prepare("SELECT target FROM audit WHERE action = ?").all(action) as { target: string }[]).map((r) => r.target);
  return { db, env, requeue, audits };
}

const rustTask = (repo: string) => ({ step: "verify", repo, headSha: SHA, requires: { os: "linux" as const, toolchains: ["rust-stable"] }, plan: rustPlan({ cargoArgs: ["-p", "x"] }) });

test("a repo's toolchain setting replaces rust-stable in its tasks; a task no environment can run waits in the queue", () => {
  const { db, env, requeue, audits } = setup();
  assert.equal(rustToolchain(db, "app"), "rust-stable");
  assert.equal(setRepoToolchain(db, "op", "app", "rust-poka"), true);
  assert.equal(setRepoToolchain(db, "op", "app", "rust-poka"), false, "an unchanged value is no change");
  assert.throws(() => setRepoToolchain(db, "op", "app", "rust poka"), /not a toolchain name/);
  assert.deepEqual(audits("repo-toolchain-set"), ["app"]);
  const app = createTask(db, rustTask("app"));
  const lib = createTask(db, rustTask("lib"));
  const nightly = createTask(db, { ...rustTask("app"), step: "nightly", requires: { os: "linux", toolchains: ["rust-nightly"] } });
  const req = (id: number) => JSON.parse((db.prepare("SELECT requires FROM build_tasks WHERE id = ?").get(id) as { requires: string }).requires).toolchains;
  assert.deepEqual(req(app), ["rust-poka"]);
  assert.deepEqual(req(lib), ["rust-stable"], "other repos keep rust-stable");
  assert.deepEqual(req(nightly), ["rust-nightly"], "a task that names another toolchain keeps it");
  env("stock", ["rust-stable"]);
  const stock = claim(db, "stock", 4).tasks.map((t) => t.id);
  assert.ok(stock.includes(lib) && !stock.includes(app), "no environment reports rust-poka: the task stays queued");
  assert.equal((db.prepare("SELECT state FROM build_tasks WHERE id = ?").get(app) as { state: string }).state, "queued");
  requeue();
  env("poka-image", ["rust-poka", "rust-stable"]);
  assert.ok(claim(db, "poka-image", 4).tasks.some((t) => t.id === app));
  setRepoToolchain(db, "op", "app", null);
  assert.deepEqual(audits("repo-toolchain-clear"), ["app"]);
  assert.equal(rustToolchain(db, "app"), "rust-stable");
});

test("the companions setting accepts only same-owner repos with a variable of their own", () => {
  const { db, audits } = setup();
  assert.deepEqual(parseCompanionArgs(["poka-samples=POKA_SAMPLES"]), [{ repo: "poka-samples", env: "POKA_SAMPLES" }]);
  assert.throws(() => parseCompanionArgs(["poka-samples"]), /<repo>=<ENV_VAR>/);
  for (const [list, why] of [
    [[{ repo: "other/poka-samples", env: "POKA_SAMPLES" }], /not a repository name/],
    [[{ repo: "poka", env: "POKA_SAMPLES" }], /not its own companion/],
    [[{ repo: "poka-samples", env: "CARGO_HOME" }], /pick another name/],
    [[{ repo: "poka-samples", env: "poka_samples" }], /not an environment variable name/],
    [[{ repo: "a", env: "X" }, { repo: "a", env: "Y" }], /appear once/],
  ] as const) assert.throws(() => setRepoCompanions(db, "op", "poka", [...list]), why);
  assert.equal(setRepoCompanions(db, "op", "poka", [{ repo: "poka-samples", env: "POKA_SAMPLES" }]), true);
  assert.equal(setRepoCompanions(db, "op", "poka", [{ repo: "poka-samples", env: "POKA_SAMPLES" }]), false);
  assert.deepEqual(repoCompanions(db, "poka"), [{ repo: "poka-samples", env: "POKA_SAMPLES" }]);
  assert.deepEqual(audits("repo-companions-set"), ["poka"]);
});

test("a task records each companion's commit and marks only its test steps; claim hands a private one only to an environment that may take it", async () => {
  const { db, env, requeue } = setup();
  setRepoCompanions(db, "op", "poka", [{ repo: "poka-samples", env: "POKA_SAMPLES" }]);
  // No head known yet: the task records none, and claim fills it from the head resolved in the meantime.
  const early = createTask(db, rustTask("poka"));
  const calls: string[] = [];
  await refreshCompanionHeads(db, { resolve: async (owner, repo) => { calls.push(`${owner}/${repo}`); return { sha: CORPUS, private: true }; } });
  assert.deepEqual(calls, [`${DEFAULT_OWNER}/poka-samples`]);
  await refreshCompanionHeads(db, { resolve: async () => { throw new Error("must not be asked again within the TTL"); } });
  assert.equal(knownHead(db, DEFAULT_OWNER, "poka-samples")!.sha, CORPUS);
  const later = createTask(db, rustTask("poka"));
  const row = db.prepare("SELECT plan, companions FROM build_tasks WHERE id = ?").get(later) as { plan: string; companions: string };
  assert.deepEqual(JSON.parse(row.companions), [{ repo: "poka-samples", owner: DEFAULT_OWNER, env: "POKA_SAMPLES", sha: CORPUS, private: true }]);
  const flagged = (JSON.parse(row.plan) as { name: string; companions?: boolean }[]).filter((s) => s.companions).map((s) => s.name);
  assert.deepEqual(flagged, ["test"], "fetch and build steps never see the companion");
  const other = createTask(db, rustTask("app"));
  assert.equal((db.prepare("SELECT companions FROM build_tasks WHERE id = ?").get(other) as { companions: string | null }).companions, null);

  env("public-only", ["rust-stable"]);
  const plain = claim(db, "public-only", 4).tasks.find((t) => t.repo === "app")!;
  assert.equal(plain.companions, undefined);
  requeue();
  // poka itself is private, so only a private-code environment takes its tasks; there the corpus has a commit.
  env("private", ["rust-stable"], true);
  const got = claim(db, "private", 4).tasks;
  for (const id of [early, later]) {
    const t = got.find((x) => x.id === id)!;
    assert.deepEqual(t.companions, [{ repo: "poka-samples", owner: DEFAULT_OWNER, env: "POKA_SAMPLES", private: true, sha: CORPUS }], `task ${id}`);
  }
  assert.equal(JSON.parse((db.prepare("SELECT companions FROM build_tasks WHERE id = ?").get(early) as { companions: string }).companions)[0].sha, CORPUS, "the filled commit is kept for a retry");
});

test("a private companion of a public repo goes to a public environment only as a note", async () => {
  const { db, env } = setup();
  setRepoCompanions(db, "op", "app", [{ repo: "corpus", env: "CORPUS_DIR" }]);
  await refreshCompanionHeads(db, { resolve: async () => ({ sha: CORPUS, private: true }) });
  createTask(db, rustTask("app"));
  env("public-only", ["rust-stable"]);
  const [t] = claim(db, "public-only", 4).tasks;
  assert.equal(t!.companions![0]!.sha, undefined);
  assert.match(t!.companions![0]!.note!, /private and this environment does not take/);
});

test("held paths match whole path segments and are audited", () => {
  const { db, audits } = setup();
  assert.throws(() => setRepoHoldPaths(db, "op", "poka", ["/abs"]), /not a repository path prefix/);
  assert.throws(() => setRepoHoldPaths(db, "op", "poka", ["docs/*.md"]), /no globs/);
  assert.equal(setRepoHoldPaths(db, "op", "poka", ["6-hosts/web/", "FILE_FORMATS.csv", "docs/status"]), true);
  assert.deepEqual(audits("repo-hold-paths-set"), ["poka"]);
  assert.deepEqual(heldPath(db, "poka", ["parsers/x/src/lib.rs", "6-hosts/web/src/app.js"]), { path: "6-hosts/web/src/app.js", prefix: "6-hosts/web/" });
  assert.equal(heldPath(db, "poka", ["6-hosts/webby/x.rs", "docs/statusx/a.md", "FILE_FORMATS.csv.bak"]), null, "a prefix is a path, not a string prefix");
  assert.ok(heldPath(db, "poka", ["docs/status/kpi.md"]));
  assert.ok(heldPath(db, "poka", ["FILE_FORMATS.csv"]));
  assert.equal(heldPath(db, "app", ["6-hosts/web/x"]), null, "per repo");
});
