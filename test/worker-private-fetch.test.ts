// Private source downloads (worker config privateFetch): the token goes only to api.github.com for the configured
// owner's repos, the one redirect to codeload.github.com drops it, every other target is refused, it never shows in an
// error, a log or a result, and the coordinator hands a private repo's task only to an environment an operator flagged
// whose worker reported the token.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";
import { createEnv, hello, updateEnv } from "../src/build/envs.ts";
import { buildableRepo, privateBuildsReady } from "../src/build/private.ts";
import { claim, createTask } from "../src/build/tasks.ts";
import { connect } from "../src/db.ts";
import { DEFAULT_OWNER } from "../src/owners.ts";
import { detectCapabilities, parseWorkerConfig } from "../src/worker/config.ts";
import { executeTask } from "../src/worker/executor.ts";
import { PrivateSource, codeloadUrl, loadPrivateSource } from "../src/worker/private-source.ts";
import type { ClaimedTask } from "../src/worker/types.ts";
import { makeTarGz } from "./tar-util.ts";
import { SCRATCH } from "./scratch.ts";

const TOKEN = "github_pat_11TESTTOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA = "c".repeat(40);
const TGZ = makeTarGz([{ name: "app-c/" }, { name: "app-c/Cargo.toml", data: "[package]\n" }]);
const CODELOAD = "https://codeload.github.com/ModelTok/app/legacy.tar.gz/refs/heads/x?token=SHORTLIVED";

type Call = { url: string; auth: string | null; redirect: string | undefined };

/** A fake fetch that records every request and answers with `answer`. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    return answer(url);
  }) as typeof fetch;
  return { calls, fetch: f };
}

const github = (location: string | null = CODELOAD) => (url: string): Response => {
  if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 302, headers: location === null ? {} : { location } });
  if (url.startsWith("https://codeload.github.com/")) return new Response(new Uint8Array(TGZ), { status: 200 });
  return new Response("not here", { status: 404 });
};

const dest = () => {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, "pf-"));
};

test("the token goes only to api.github.com for the configured owner; the codeload hop goes without it and follows nothing more", async () => {
  const src = new PrivateSource(DEFAULT_OWNER, TOKEN);
  const f = fakeFetch(github());
  const d = dest();
  assert.equal(await src.downloadTarball(DEFAULT_OWNER.toLowerCase(), "app", SHA, d, 1 << 20, undefined, f.fetch), 1);
  assert.equal(readFileSync(join(d, "Cargo.toml"), "utf8"), "[package]\n");
  assert.deepEqual(f.calls, [
    { url: `https://api.github.com/repos/${DEFAULT_OWNER.toLowerCase()}/app/tarball/${SHA}`, auth: `Bearer ${TOKEN}`, redirect: "manual" },
    { url: CODELOAD, auth: null, redirect: "error" },
  ]);
});

test("a redirect anywhere but https://codeload.github.com/ is refused before it is fetched", async () => {
  for (const loc of ["https://evil.example/x.tar.gz", "http://codeload.github.com/x", "https://codeload.github.com:8443/x", "https://u:p@codeload.github.com/x", "https://codeload.github.com.evil.example/x", "/relative", null]) {
    const f = fakeFetch(github(loc));
    await assert.rejects(new PrivateSource(DEFAULT_OWNER, TOKEN).downloadTarball(DEFAULT_OWNER, "app", SHA, dest(), 1 << 20, undefined, f.fetch), /refused: GitHub redirected somewhere other than/, String(loc));
    assert.equal(f.calls.length, 1, String(loc));
  }
  assert.throws(() => codeloadUrl("https://api.github.com/x"), /refused/);
  assert.equal(codeloadUrl("https://codeload.github.com/a/b"), "https://codeload.github.com/a/b");
});

test("another owner, a bad repo name or a short sha never reaches the network", async () => {
  const src = new PrivateSource(DEFAULT_OWNER, TOKEN);
  const f = fakeFetch(github());
  await assert.rejects(src.downloadTarball("someone-else", "app", SHA, dest(), 1 << 20, undefined, f.fetch), /fetches private code only of/);
  await assert.rejects(src.downloadTarball(DEFAULT_OWNER, "../app", SHA, dest(), 1 << 20, undefined, f.fetch), /repo name/);
  await assert.rejects(src.downloadTarball(DEFAULT_OWNER, "app", "abc", dest(), 1 << 20, undefined, f.fetch), /commit id/);
  await assert.rejects(src.fileText("someone-else", "app", SHA, "ci.yml", 1000, f.fetch), /fetches private code only of/);
  await assert.rejects(src.fileText(DEFAULT_OWNER, "app", SHA, "../secrets", 1000, f.fetch), /path/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => new PrivateSource("someone-else", TOKEN), /default owner/);
});

test("a token echoed in a failing answer or an exception never reaches the error", async () => {
  const src = new PrivateSource(DEFAULT_OWNER, TOKEN);
  const answers: ((url: string) => Response)[] = [
    () => new Response(`bad credentials ${TOKEN}`, { status: 500 }),
    () => { throw new Error(`connect failed for Bearer ${TOKEN}`); },
    (url) => { if (url.startsWith("https://codeload")) throw new Error(`hop failed ${TOKEN}`); return github()(url); },
  ];
  for (const a of answers) {
    const err = await src.downloadTarball(DEFAULT_OWNER, "app", SHA, dest(), 1 << 20, undefined, fakeFetch(a).fetch).then(() => null, (e: Error) => e);
    assert.ok(err, "the download fails");
    assert.ok(!err.message.includes(TOKEN) && !String(err.stack).includes(TOKEN), err.message);
  }
  const e500 = await src.downloadTarball(DEFAULT_OWNER, "app", SHA, dest(), 1 << 20, undefined, fakeFetch(answers[0]!).fetch).catch((e: Error) => e.message);
  assert.equal(e500, "private source download failed: HTTP 500");
  assert.equal(await src.fileText(DEFAULT_OWNER, "app", SHA, "ci.yml", 1000, fakeFetch(() => { throw new Error(`x ${TOKEN}`); }).fetch).catch((e: Error) => e.message), "x ***");
  // The object itself never prints the token.
  assert.ok(!JSON.stringify({ src }).includes(TOKEN) && !inspect(src).includes(TOKEN));
});

test("CI files of a private repo are read through the API with the token and no redirect; a missing file is null", async () => {
  const src = new PrivateSource(DEFAULT_OWNER, TOKEN);
  const f = fakeFetch((url) => (url.includes("/contents/craft-i18n.rev") ? new Response("nope", { status: 404 }) : new Response("jobs: {}\n")));
  assert.equal(await src.fileText(DEFAULT_OWNER, "app", SHA, ".github/workflows/ci.yml", 1000, f.fetch), "jobs: {}\n");
  assert.equal(await src.fileText(DEFAULT_OWNER, "app", SHA, "craft-i18n.rev", 1000, f.fetch), null);
  assert.deepEqual(f.calls[0], { url: `https://api.github.com/repos/${DEFAULT_OWNER}/app/contents/.github/workflows/ci.yml?ref=${SHA}`, auth: `Bearer ${TOKEN}`, redirect: "error" });
  await assert.rejects(src.fileText(DEFAULT_OWNER, "app", SHA, "big.yml", 3, f.fetch), /too large/);
});

test("the worker reads privateFetch at start: the default owner only, a token file readable by its owner alone", () => {
  const dir = dest();
  const base = { coordinatorUrl: "https://c.example", keyFile: "/k", workDir: dir };
  const tokenFile = join(dir, "token");
  assert.throws(() => parseWorkerConfig({ ...base, privateFetch: { tokenFile, owner: "someone-else" } }), /default owner/);
  assert.throws(() => parseWorkerConfig({ ...base, privateFetch: { tokenFile: "token", owner: DEFAULT_OWNER } }), /absolute/);
  assert.throws(() => parseWorkerConfig({ ...base, privateFetch: { tokenFile, owner: DEFAULT_OWNER, url: "https://x" } }), /tokenFile, owner/);
  const cfg = parseWorkerConfig({ ...base, privateFetch: { tokenFile, owner: DEFAULT_OWNER } });
  assert.equal(detectCapabilities(cfg).privateOwner, DEFAULT_OWNER);
  assert.equal(detectCapabilities(parseWorkerConfig(base)).privateOwner, undefined);
  assert.equal(loadPrivateSource(undefined), undefined);
  writeFileSync(tokenFile, "not a token\nsecond line\n", { mode: 0o600 });
  assert.throws(() => loadPrivateSource(cfg.privateFetch), (e: Error) => /does not hold one GitHub token/.test(e.message) && !e.message.includes("second line"));
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  assert.equal(loadPrivateSource(cfg.privateFetch)!.owner, DEFAULT_OWNER);
  if (process.platform !== "win32") {
    chmodSync(tokenFile, 0o644);
    assert.throws(() => loadPrivateSource(cfg.privateFetch), /readable by other users/);
  }
});

test("a worker refuses a private task for another owner or without privateFetch, keeps public tasks anonymous, and scrubs what it reports", async () => {
  const dir = dest();
  const cfg = parseWorkerConfig({ coordinatorUrl: "https://c.example", keyFile: "/k", workDir: join(dir, "work"), warmDir: join(dir, "warm") });
  const src = new PrivateSource(DEFAULT_OWNER, TOKEN);
  const base: ClaimedTask = { id: 1, repo: "app", headSha: SHA, baseSha: null, requires: {}, plan: [], sourceUrl: `https://codeload.github.com/${DEFAULT_OWNER}/app/tar.gz/${SHA}` };
  const run = async (task: ClaimedTask, privateSource: PrivateSource | undefined, answer: (url: string) => Response) => {
    const f = fakeFetch(answer);
    const logs: string[] = [];
    const r = await executeTask(cfg, task, { log: async (_s, c) => void logs.push(c), artifact: async () => {} }, new AbortController().signal, { fetchImpl: f.fetch, privateSource });
    return { r, logs, calls: f.calls };
  };
  const other = await run({ ...base, private: { owner: "someone-else" } }, src, github());
  assert.match(other.r.summary, /^refused: app is a private repo of someone-else and this worker fetches private code only of/);
  assert.equal(other.calls.length, 0);
  const none = await run({ ...base, private: { owner: DEFAULT_OWNER } }, undefined, github());
  assert.match(none.r.summary, /this worker has no privateFetch/);
  assert.equal(none.calls.length, 0);
  assert.match((await run({ ...base, private: { owner: "bad owner!" } } as ClaimedTask, src, github())).r.summary, /^malformed task: private.owner/);

  // A public task on a worker that holds the token: anonymous, from the URL the coordinator gave.
  const pub = await run(base, src, () => new Response("gone", { status: 404 }));
  assert.deepEqual(pub.calls, [{ url: base.sourceUrl, auth: null, redirect: "follow" }]);
  assert.equal(pub.r.summary, "source failed: source download failed: HTTP 404");

  // A private task whose download fails with the token in the answer and in an exception.
  for (const answer of [() => new Response(TOKEN, { status: 401 }), () => { throw new Error(`boom ${TOKEN}`); }]) {
    const priv = await run({ ...base, private: { owner: DEFAULT_OWNER } }, src, answer);
    assert.equal(priv.calls[0]!.url, `https://api.github.com/repos/${DEFAULT_OWNER}/app/tarball/${SHA}`);
    assert.match(priv.r.summary, /^source failed: /);
    assert.ok(![JSON.stringify(priv.r), ...priv.logs].some((s) => s.includes(TOKEN)), JSON.stringify([priv.r, priv.logs]));
  }
});

test("a private repo's task goes only to an operator-flagged environment whose worker reported a token for the default owner", () => {
  const db = connect(":memory:");
  db.prepare("INSERT INTO repos (name, owner, visibility) VALUES ('pub-app', ?, 'public'), ('priv-app', ?, 'private'), ('other-app', 'someone-else', 'private')").run(DEFAULT_OWNER, DEFAULT_OWNER);
  db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES ('pub-app', 1), ('priv-app', 1), ('other-app', 1)").run();
  const caps = { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] };
  const make = (id: string, privateCode: boolean, privateOwner?: string) => {
    createEnv(db, { id, label: id, kind: "remote", slots: 4, ...(privateCode && { privateCode }) }, "op");
    // What a worker says about itself never sets the operator's flag.
    hello(db, id, { version: "1", capabilities: { ...caps, privateCode: true, ...(privateOwner && { privateOwner }) }, slots: 4 });
  };
  make("plain", false, DEFAULT_OWNER);
  make("no-token", true);
  make("wrong-owner", true, "someone-else");
  assert.equal(buildableRepo(db, "pub-app"), true);
  assert.equal(buildableRepo(db, "priv-app"), false, "no environment takes private code yet");
  assert.equal(privateBuildsReady(db), false);
  const t = { plan: [{ name: "t", cmd: ["true"], network: "none" as const, timeoutSec: 10 }], step: "verify", headSha: SHA };
  const pub = createTask(db, { ...t, repo: "pub-app" });
  const priv = createTask(db, { ...t, repo: "priv-app" });
  createTask(db, { ...t, repo: "other-app" });
  const requeue = () => db.prepare("UPDATE build_tasks SET state = 'queued', env_id = NULL").run();
  for (const id of ["plain", "no-token", "wrong-owner"]) {
    assert.deepEqual(claim(db, id, 4).tasks.map((x) => x.id), [pub], id);
    requeue();
  }
  make("trusted", true, DEFAULT_OWNER.toLowerCase());
  assert.equal(buildableRepo(db, "priv-app"), true);
  assert.equal(buildableRepo(db, "other-app"), false, "another owner's private repo is never built");
  const got = claim(db, "trusted", 4).tasks;
  assert.deepEqual(got.map((x) => [x.id, x.private ?? null]), [[pub, null], [priv, { owner: DEFAULT_OWNER }]]);
  requeue();
  updateEnv(db, "trusted", { enabled: false }, "op");
  assert.equal(buildableRepo(db, "priv-app"), false);
  updateEnv(db, "trusted", { enabled: true, privateCode: false }, "op");
  assert.deepEqual(claim(db, "trusted", 4).tasks.map((x) => x.id), [pub], "the flag turned off: no private task");
  assert.ok((db.prepare("SELECT details FROM audit WHERE action = 'env-change' ORDER BY rowid DESC LIMIT 1").get() as { details: string }).details.includes("privateCode"));
});
