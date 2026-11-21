// Companion sources on the worker (src/worker/companions.ts): unpacked once per commit under the warm dir, mounted
// read-only with their variable only into the steps marked for them, reused by the next task, replaced when the commit
// changes, and refused for a private companion of another owner, in which case the steps still run without it.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_OWNER } from "../src/owners.ts";
import { acquireCompanion, companionsFieldProblem, resetCompanions } from "../src/worker/companions.ts";
import { parseWorkerConfig } from "../src/worker/config.ts";
import { executeTask } from "../src/worker/executor.ts";
import { PrivateSource } from "../src/worker/private-source.ts";
import { removeTree } from "../src/worker/rmtree.ts";
import type { ClaimedTask } from "../src/worker/types.ts";
import { makeTarGz } from "./tar-util.ts";
import { SCRATCH } from "./scratch.ts";

const SHA = "a".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const TOKEN = "github_pat_11TESTTOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SRC = makeTarGz([{ name: "app-a/" }, { name: "app-a/Cargo.toml", data: "[package]\n" }]);
const corpus = (marker: string) => makeTarGz([{ name: "poka-samples-x/" }, { name: "poka-samples-x/png/" }, { name: "poka-samples-x/png/a.png", data: marker }]);

// The copies are read-only: the scratch clean-up at exit could not remove them.
const made: string[] = [];
after(() => { for (const d of made) removeTree(d); });

function world() {
  resetCompanions();
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, "comp-"));
  made.push(dir);
  // A container runtime that only records how it was called: every step "passes".
  const log = join(dir, "runtime.log");
  const runtime = join(dir, "fake-podman");
  writeFileSync(runtime, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexit 0\n`);
  chmodSync(runtime, 0o755);
  const cfg = parseWorkerConfig({ coordinatorUrl: "https://c.example", keyFile: "/k", workDir: join(dir, "work"), warmDir: join(dir, "warm"), runtime });
  const fetched: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes("/poka-samples/tar.gz/")) return new Response(new Uint8Array(corpus(url.slice(-40))), { status: 200 });
    if (url.includes("/app/tar.gz/")) return new Response(new Uint8Array(SRC), { status: 200 });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const runs = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("run ")) : []);
  return { dir, cfg, fetched, fetchImpl, runs };
}

const task = (id: number, sha: string, extra: Partial<ClaimedTask> = {}): ClaimedTask => ({
  id, repo: "app", headSha: SHA, baseSha: null, requires: {}, sourceUrl: `https://codeload.github.com/${DEFAULT_OWNER}/app/tar.gz/${SHA}`,
  plan: [
    { name: "build", cmd: ["true"], network: "none", timeoutSec: 60 },
    { name: "test", cmd: ["true"], network: "none", timeoutSec: 60, companions: true },
  ],
  companions: [{ repo: "poka-samples", owner: DEFAULT_OWNER, env: "POKA_SAMPLES", sha }],
  ...extra,
});
const sink = (logs: string[]) => ({ log: async (_s: string, c: string) => void logs.push(c), artifact: async () => {} });
const freeDiskGb = () => 10_000;

test("the companion is mounted read-only with its variable in the test step alone, and reused by the next task", async () => {
  const w = world();
  const logs: string[] = [];
  const r = await executeTask(w.cfg, task(1, C1), sink(logs), new AbortController().signal, { fetchImpl: w.fetchImpl, freeDiskGb });
  assert.equal(r.summary, "2 steps passed");
  const [build, testRun] = w.runs();
  const copy = join(w.cfg.warmDir, "companions", DEFAULT_OWNER.toLowerCase(), "poka-samples", C1);
  assert.ok(testRun!.includes(`type=bind,source=${copy},target=/companions/poka-samples,readonly`) && testRun!.includes("POKA_SAMPLES=/companions/poka-samples"));
  assert.ok(!build!.includes("/companions/") && !build!.includes("POKA_SAMPLES"), "the build step gets neither the mount nor the variable");
  assert.equal(readFileSync(join(copy, "png/a.png"), "utf8"), C1);
  assert.equal(statSync(join(copy, "png")).mode & 0o222, 0, "the host copy is read-only");
  const corpusFetches = () => w.fetched.filter((u) => u.includes("/poka-samples/")).length;
  assert.equal(corpusFetches(), 1);
  await executeTask(w.cfg, task(2, C1), sink([]), new AbortController().signal, { fetchImpl: w.fetchImpl, freeDiskGb });
  assert.equal(corpusFetches(), 1, "the same commit is not fetched again");
  // A new commit replaces the old copy once no task uses it.
  await executeTask(w.cfg, task(3, C2), sink([]), new AbortController().signal, { fetchImpl: w.fetchImpl, freeDiskGb });
  assert.equal(corpusFetches(), 2);
  assert.ok(!existsSync(copy) && existsSync(join(w.cfg.warmDir, "companions", DEFAULT_OWNER.toLowerCase(), "poka-samples", C2)));
});

test("a copy in use by a running task is kept when a newer commit arrives", async () => {
  const w = world();
  const held = await acquireCompanion(w.cfg, { repo: "poka-samples", owner: DEFAULT_OWNER, env: "POKA_SAMPLES", sha: C1 }, { fetchImpl: w.fetchImpl, freeDiskGb });
  const next = await acquireCompanion(w.cfg, { repo: "poka-samples", owner: DEFAULT_OWNER, env: "POKA_SAMPLES", sha: C2 }, { fetchImpl: w.fetchImpl, freeDiskGb });
  assert.ok(existsSync(held.dir), "still mounted by the first task");
  held.release();
  assert.ok(!existsSync(held.dir) && existsSync(next.dir));
  next.release();
});

test("a private companion of another owner is refused without a request, and the steps run without its variable", async () => {
  const w = world();
  const privateSource = new PrivateSource(DEFAULT_OWNER, TOKEN);
  const logs: string[] = [];
  const t = task(4, C1, { companions: [{ repo: "poka-samples", owner: "someone-else", env: "POKA_SAMPLES", sha: C1, private: true }] });
  const r = await executeTask(w.cfg, t, sink(logs), new AbortController().signal, { fetchImpl: w.fetchImpl, privateSource, freeDiskGb });
  assert.equal(r.summary, "2 steps passed", "the task is not failed for its companion");
  assert.ok(logs.some((l) => /companion someone-else\/poka-samples not fetched: .*fetches private code only of .*; its steps run without POKA_SAMPLES/.test(l)));
  assert.ok(!w.fetched.some((u) => u.includes("poka-samples")));
  assert.ok(w.runs().every((l) => !l.includes("POKA_SAMPLES")));
  // A note from the coordinator (no commit, or an environment that may not take it) is logged the same way.
  const noted = await executeTask(w.cfg, task(5, C1, { companions: [{ repo: "poka-samples", owner: DEFAULT_OWNER, env: "POKA_SAMPLES", note: "not for this environment" }] }), sink(logs), new AbortController().signal, { fetchImpl: w.fetchImpl, freeDiskGb });
  assert.equal(noted.summary, "2 steps passed");
  assert.ok(logs.some((l) => l.includes("not fetched: not for this environment")));
});

test("a companion is not unpacked below the free-disk floor", async () => {
  const w = world();
  const logs: string[] = [];
  await executeTask(w.cfg, task(6, C1), sink(logs), new AbortController().signal, { fetchImpl: w.fetchImpl, freeDiskGb: () => 1 });
  assert.ok(logs.some((l) => /not fetched: only 1\.0 GB free/.test(l)));
  assert.ok(!w.fetched.some((u) => u.includes("poka-samples")));
});

test("malformed companion fields are refused before anything is fetched", () => {
  assert.equal(companionsFieldProblem(undefined), null);
  assert.match(companionsFieldProblem([{ repo: "x", owner: DEFAULT_OWNER, env: "LD_PRELOAD", sha: C1 }])!, /not allowed/);
  assert.match(companionsFieldProblem([{ repo: "../x", owner: DEFAULT_OWNER, env: "X", sha: C1 }])!, /not a repository name/);
  assert.match(companionsFieldProblem([{ repo: "x", owner: DEFAULT_OWNER, env: "X" }])!, /needs a sha or a note/);
  assert.match(companionsFieldProblem([{ repo: "x", owner: DEFAULT_OWNER, env: "X", sha: C1, extra: 1 }])!, /must be/);
});
