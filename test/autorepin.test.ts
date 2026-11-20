// Autorepin: `@<app> autorepin <pull request>` on a PR, and the commit that repins its Cargo dependencies once that pull request is merged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { exec, type Exec, type ExecResult } from "../src/fixup/git.ts";
import { drainCommands, parseCommand } from "../src/github/commands.ts";
import { handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import type { Querier } from "../src/mirror.ts";
import { advancePreapprovals, preapprovalOf, preapproveMerge } from "../src/preapproval/index.ts";
import { anyRepinDue } from "../src/repin/due.ts";
import { drainRepins, MAX_TRIES, requestRepin, type RepinDeps } from "../src/repin/index.ts";
import { lockRefusal, repinManifest } from "../src/repin/manifest.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

process.env.AUTOCRAFT_ARTIFACT_DIR = join(SCRATCH, "artifacts");

const SLUG = "autocraft-bot";
const OLD = "1".repeat(40);
/** The dependency's repository as GitHub has it: `main` holds the merge commit SHA; STRAY is a commit no branch of it holds any more. */
const LIBS_GIT = join(SCRATCH, "libs.git");
const [SHA, STRAY] = (() => {
  const work = mkdtempSync(join(SCRATCH, "libs-work-"));
  git(work, "init", "-q", "-b", "main");
  git(work, "commit", "-q", "--allow-empty", "-m", "the merge of #12");
  const sha = git(work, "rev-parse", "HEAD");
  git(work, "clone", "-q", "--bare", work, LIBS_GIT);
  git(work, "commit", "-q", "--allow-empty", "-m", "dropped from main since");
  const stray = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", LIBS_GIT, `${stray}:refs/heads/elsewhere`);
  return [sha, stray];
})();
const LIBS = "https://github.com/ModelTok/libs";
const MANIFEST = `[workspace]\nmembers = ["app"]\n\n[workspace.dependencies]\ncraft-ui = { git = "${LIBS}", rev = "${OLD}" }\nserde = "1"\n`;
const CRATES = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
const lockOf = (rev: string, extra = ""): string =>
  `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "craft-ui"\nversion = "0.1.0"\nsource = "git+${LIBS}?rev=${rev}#${rev}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n${CRATES}\nchecksum = "aa"\n${extra}`;

describe("the autorepin command", () => {
  test("names the pull request by slug, bare repo name or URL; off drops it", () => {
    const ref = { owner: "ModelTok", name: "libs", number: 12 };
    assert.deepEqual(parseCommand(`@${SLUG} autorepin ModelTok/libs#12`, SLUG), { command: "autorepin", ref });
    assert.deepEqual(parseCommand(`thanks!\n@${SLUG} auto-repin ${LIBS}/pull/12`, SLUG), { command: "autorepin", ref });
    assert.deepEqual(parseCommand(`@${SLUG} autorepin libs#12`, SLUG), { command: "autorepin", ref: { ...ref, owner: null } });
    assert.deepEqual(parseCommand(`@${SLUG} autorepin OFF`, SLUG), { command: "autorepin", ref: null });
  });
  test("a number alone, a missing target or a quoted line is no command", () => {
    for (const body of [`@${SLUG} autorepin 12`, `@${SLUG} autorepin #12`, `@${SLUG} autorepin`, `> @${SLUG} autorepin libs#12`, `@${SLUG} autorepin libs#12 please`]) assert.equal(parseCommand(body, SLUG), null, body);
  });
});

describe("repinManifest", () => {
  test("moves every rev on the repository, in inline and section tables, and nothing else", () => {
    const text = `[dependencies]\ncraft-ui = { git = "${LIBS}.git", rev = "${OLD}" } # ui\nother = { git = "https://github.com/ModelTok/elsewhere", rev = "2222222" }\n\n[dev-dependencies.craft-test]\ngit = "${LIBS}"\nrev = '${OLD}'\n`;
    const r = repinManifest(text, "ModelTok/libs", SHA);
    assert.ok(r.ok);
    assert.deepEqual(r.from, [OLD]);
    assert.equal(r.text, text.replace(`"${OLD}"`, `"${SHA}"`).replace(`'${OLD}'`, `"${SHA}"`));
  });
  test("a manifest already at the commit, or with no rev on the repository, comes back unchanged", () => {
    const at = MANIFEST.replace(OLD, SHA);
    const same = repinManifest(at, "ModelTok/libs", SHA);
    assert.ok(same.ok && same.text === at && same.from.length === 0 && same.pinned === 1);
    const branch = repinManifest(`[dependencies]\ncraft-ui = { git = "${LIBS}", branch = "wip" }\n`, "ModelTok/libs", SHA);
    assert.ok(branch.ok && branch.from.length === 0 && branch.pinned === 0 && branch.unpinned === 1);
  });
  test("a git and rev outside the dependency tables are not a dependency", () => {
    const text = `[package]
name = "app"

[package.metadata.release]
git = "${LIBS}"
rev = "${OLD}"

[target.'cfg(unix)'.dependencies]
craft-ui = { git = "${LIBS}", rev = "${OLD}" }

[patch.crates-io]
craft-io = { git = "${LIBS}", rev = "${OLD}" }
`;
    const r = repinManifest(text, "ModelTok/libs", SHA);
    // Refused, not rewritten: the metadata's rev is the same text, so the edit cannot leave it alone.
    assert.ok(!r.ok);
    const apart = repinManifest(text.replace(`rev = "${OLD}"`, 'rev = "2222222"'), "ModelTok/libs", SHA);
    assert.ok(apart.ok && apart.pinned === 2 && apart.text.includes('rev = "2222222"') && !apart.text.includes(OLD));
  });
  test("is refused when the rewrite would also change another repository's rev", () => {
    const r = repinManifest(`[dependencies]\ncraft-ui = { git = "${LIBS}", rev = "${OLD}" }\nother = { git = "https://github.com/else/where", rev = "${OLD}" }\n`, "ModelTok/libs", SHA);
    assert.ok(!r.ok);
  });
});

describe("lockRefusal", () => {
  const ok = (after: string) => lockRefusal(lockOf(OLD), after, "ModelTok/libs", SHA);
  test("accepts the dependency at the commit, with new crates.io packages", () => {
    assert.equal(ok(lockOf(SHA, `\n[[package]]\nname = "itoa"\nversion = "1.0.0"\n${CRATES}\nchecksum = "bb"\n`)), null);
  });
  test("refuses another source, the dependency at another commit, and a changed checksum", () => {
    assert.ok(ok(lockOf(SHA, `\n[[package]]\nname = "evil"\nversion = "1.0.0"\nsource = "git+https://github.com/else/where?rev=abc#abc"\n`)));
    assert.ok(ok(lockOf(OLD)));
    assert.ok(ok(lockOf(SHA).replace('"aa"', '"zz"')));
  });
  test("refuses a new version of a package the old lockfile has from the same source, a downgrade included", () => {
    assert.ok(ok(lockOf(SHA).replace('version = "1.0.0"', 'version = "0.9.0"')));
    assert.ok(ok(lockOf(SHA, `\n[[package]]\nname = "serde"\nversion = "2.0.0"\n${CRATES}\nchecksum = "cc"\n`)));
  });
  test("reads the lockfile as TOML: a source written another way than Cargo writes it still counts", () => {
    const app = 'name = "app"\nversion = "0.1.0"\n';
    assert.ok(ok(lockOf(SHA).replace(app, `${app}source = "git+https://example.org/foreign#abc" # source\n`)));
    assert.ok(ok(`${lockOf(SHA)}\n[[package]]\nname = 1\n`));
  });
});

// ---- the whole flow against real git, with GitHub replaced ---------------------

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type Setup = { w: World; fork: string; head: string; comments: string[]; pushes: number; live: { head: string; state: string; ref: string; base: string; sha: string }; deps: RepinDeps; branch: () => string; at: (path: string) => string };
let current: World | null = null;
afterEach(() => current?.close());

/** app#1 from the fork contrib/app (branch `fix`), pinned to libs at OLD; libs#12 is open in the mirror. */
function setup(o: { lock?: boolean; off?: Parameters<World["repo"]>[0] } = {}): Setup {
  const root = mkdtempSync(join(SCRATCH, "repin-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "fix");
  writeFileSync(join(work, "Cargo.toml"), MANIFEST);
  if (o.lock !== false) writeFileSync(join(work, "Cargo.lock"), lockOf(OLD));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "contributor");
  const head = git(work, "rev-parse", "HEAD");
  const fork = join(root, "fork.git");
  git(root, "clone", "-q", "--bare", work, fork);
  git(fork, "update-ref", "refs/pull/1/head", head);

  const w = (current = world().repo(o.off).pr(1, { head }));
  w.db.prepare("UPDATE access SET github_id = 101 WHERE login = ?").run(OPERATOR);
  w.db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES ('libs', ?, '2026-01-01T00:00:00Z')").run(OPERATOR);
  w.db.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES ('libs', 'public', 'main')").run();
  w.db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at, updated_at) VALUES ('libs', 12, 'pr', 'OPEN', 'lib change', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();

  const s: Setup = {
    w, fork, head, comments: [], pushes: 0, live: { head, state: "OPEN", ref: "MERGED", base: "main", sha: SHA },
    deps: null as never,
    branch: () => git(fork, "rev-parse", "refs/heads/fix"),
    at: (path) => git(fork, "show", `refs/heads/fix:${path}`),
  };
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(q: string) {
      if (q.includes("mergeCommit")) return { repository: { defaultBranchRef: { name: "main" }, pullRequest: { state: s.live.ref, baseRefName: s.live.base, mergeCommit: s.live.ref === "MERGED" ? { oid: s.live.sha } : null } } };
      return { repository: { pullRequest: { state: s.live.state, headRefOid: s.live.head, headRefName: "fix", maintainerCanModify: true, headRepository: { nameWithOwner: "contrib/app" }, headRef: null } } };
    },
  });
  const run: Exec = async (cmd, args, opts = {}): Promise<ExecResult> => {
    if (cmd === "gh") {
      if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }), stderr: "" };
      s.comments.push(String(opts.input ?? ""));
      return { code: 0, stdout: "https://github.com/ModelTok/app/pull/1#issuecomment-9", stderr: "" };
    }
    if (args.includes("push")) s.pushes++;
    const net = args.some((a) => a.startsWith("https://github.com/"));
    const local = args.map((a) => (a.startsWith("https://github.com/ModelTok/libs") ? LIBS_GIT : a.startsWith("https://github.com/") ? fork : a)).filter((a, i, all) => !(a === "-c" && all[i + 1] === "protocol.file.allow=never") && a !== "protocol.file.allow=never");
    return exec("git", net ? local : args, { ...opts });
  };
  s.deps = { querier, exec: run, root: join(root, "cache"), permission: async () => "ok" };
  return s;
}

const set = (s: Setup) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: { owner: "ModelTok", name: "libs", number: 12 } });
const merged = (s: Setup, state = "MERGED") => s.w.db.prepare("UPDATE items SET state = ? WHERE repo = 'libs' AND number = 12").run(state);
const row = (s: Setup) => ({ ...s.w.db.prepare("SELECT state, tries, to_head, result, notice FROM autorepins").get() }) as { state: string; tries: number; to_head: string | null; result: string | null; notice: string | null };
const task = (s: Setup) => s.w.db.prepare("SELECT id, patch, plan, head_sha FROM build_tasks WHERE step = 'autorepin' ORDER BY id DESC").get() as { id: number; patch: string; plan: string; head_sha: string } | undefined;
/** The lockfile task ended with `lock` as its Cargo.lock. */
function locked(s: Setup, lock: string | null, state = "done"): void {
  const id = task(s)!.id;
  s.w.db.prepare("UPDATE build_tasks SET state = ?, ended_at = '2026-01-03T00:00:00Z' WHERE id = ?").run(state, id);
  if (lock === null) return;
  const tmp = tempPath(id);
  writeFileSync(tmp, lock);
  storeArtifact(s.w.db, id, "Cargo.lock", tmp);
}

/** Delivers a comment on app#1 holding `body` and carries it out; `now`: the comment's text when the runner reads it again. */
async function comment(s: Setup, body: string, now = body): Promise<void> {
  const raw = Buffer.from(JSON.stringify({
    action: "created", repository: { full_name: "ModelTok/app", name: "app" }, issue: { number: 1, pull_request: { url: "x" } },
    comment: { id: 5000, body, created_at: new Date().toISOString(), user: { login: OPERATOR, id: 101, type: "User" } },
  }));
  handleDelivery(s.w.db, "secret", { event: "issue_comment", signature: signatureOf("secret", raw) }, raw, safeEqual, SLUG);
  await drainCommands(s.w.db, {
    querier: s.deps.querier, exec: s.deps.exec, slug: SLUG,
    permission: async () => ({ kind: "ok", permission: "write" }),
    comment: async () => ({ kind: "ok", authorId: 101, body: now }),
  });
}

describe("autorepin", () => {
  test("a comment sets it, and nothing happens while the dependency's pull request is open", async () => {
    const s = setup();
    await comment(s, `@${SLUG} autorepin ModelTok/libs#12`);
    assert.equal(s.comments.length, 1);
    assert.match(s.comments[0]!, new RegExp(`@${OPERATOR} Autorepin set: once ModelTok/libs#12 is merged`));
    assert.equal(row(s).state, "waiting");
    assert.equal(anyRepinDue(s.w.db), false);
    assert.equal(await drainRepins(s.w.db, s.deps), 0);
    assert.equal(task(s), undefined);
  });

  test("after the merge the lockfile task gets the repinned manifest, and its lockfile is pushed with it on top of the head", async () => {
    const s = setup();
    await set(s);
    merged(s);
    await drainRepins(s.w.db, s.deps);
    const t = task(s)!;
    assert.equal(row(s).state, "locking");
    assert.equal(t.head_sha, s.head);
    assert.ok(t.patch.includes(`+craft-ui = { git = "${LIBS}", rev = "${SHA}" }`) && !t.patch.includes("Cargo.lock"), t.patch);
    assert.equal((JSON.parse(t.plan) as { network: string }[])[0]!.network, "fetch");
    assert.equal(s.pushes, 0, "nothing is pushed before the lockfile is back");
    assert.equal(anyRepinDue(s.w.db), false, "it waits for the task");

    locked(s, lockOf(SHA));
    assert.equal(await drainRepins(s.w.db, s.deps), 1);
    const r = row(s);
    assert.equal(r.state, "pushed");
    assert.equal(s.branch(), r.to_head);
    assert.equal(git(s.fork, "rev-parse", `${r.to_head}^`), s.head, "one commit on the head");
    assert.equal(s.at("Cargo.toml"), MANIFEST.replace(OLD, SHA).trim());
    assert.equal(s.at("Cargo.lock"), lockOf(SHA).trim());
    assert.deepEqual(git(s.fork, "diff-tree", "-r", "--name-only", s.head, r.to_head!).split("\n").sort(), ["Cargo.lock", "Cargo.toml"]);
    assert.equal(s.comments.length, 1);
    assert.ok(s.comments[0]!.includes(`@${OPERATOR} Repinned ModelTok/libs`), s.comments[0]);
    assert.equal(await drainRepins(s.w.db, s.deps), 0, "done once");
    assert.equal(s.pushes, 1);
  });

  test("a merge pre-approved at the old head goes on at the repinned head, to be reviewed again", async () => {
    const s = setup({ lock: false });
    preapproveMerge(s.w.db, { repo: "app", number: 1, by: OPERATOR });
    await set(s);
    merged(s);
    await drainRepins(s.w.db, s.deps);
    const to = row(s).to_head!;
    s.w.synced(1, to);
    advancePreapprovals(s.w.db);
    const p = preapprovalOf(s.w.db, "app", 1)!;
    assert.deepEqual([p.state, p.head], ["review", to]);
  });

  test("without a lockfile the manifest is pushed at once", async () => {
    const s = setup({ lock: false });
    await set(s);
    merged(s);
    await drainRepins(s.w.db, s.deps);
    assert.equal(row(s).state, "pushed");
    assert.equal(task(s), undefined);
    assert.equal(s.at("Cargo.toml"), MANIFEST.replace(OLD, SHA).trim());
  });

  test("a lockfile that names another source is not pushed, and the comment says why", async () => {
    const s = setup();
    await set(s);
    merged(s);
    await drainRepins(s.w.db, s.deps);
    locked(s, lockOf(SHA, `\n[[package]]\nname = "evil"\nversion = "1.0.0"\nsource = "git+https://github.com/else/where?rev=abc#abc"\n`));
    await drainRepins(s.w.db, s.deps);
    assert.equal(row(s).state, "failed");
    assert.equal(s.pushes, 0);
    assert.equal(s.branch(), s.head);
    assert.match(s.comments[0]!, /Autorepin of ModelTok\/libs failed: .*evil/);
  });

  test("a head that moved while the lockfile was written starts over instead of pushing", async () => {
    const s = setup();
    await set(s);
    merged(s);
    await drainRepins(s.w.db, s.deps);
    locked(s, lockOf(SHA));
    s.live.head = "d".repeat(40);
    await drainRepins(s.w.db, s.deps);
    assert.deepEqual([row(s).state, row(s).tries, s.pushes], ["waiting", 1, 0]);
    assert.equal(anyRepinDue(s.w.db), false, "not again within the minute");
    assert.equal(anyRepinDue(s.w.db, new Date(Date.now() + 120_000)), true);
  });

  test("a lockfile task that keeps failing ends it with a comment", async () => {
    const s = setup();
    await set(s);
    merged(s);
    for (let i = 0; i < MAX_TRIES; i++) {
      const later = () => new Date(Date.now() + (i + 1) * 120_000);
      await drainRepins(s.w.db, { ...s.deps, now: later });
      locked(s, null, "failed");
      await drainRepins(s.w.db, { ...s.deps, now: later });
    }
    assert.equal(row(s).state, "failed");
    assert.equal(s.pushes, 0);
    assert.equal(s.comments.length, 1);
  });

  test("a dependency pull request closed without merging drops it and says so", async () => {
    const s = setup();
    await set(s);
    merged(s, "CLOSED");
    await drainRepins(s.w.db, s.deps);
    assert.equal(row(s).state, "cancelled");
    assert.equal(s.pushes, 0);
    assert.match(s.comments[0]!, /closed without merging/);
  });

  test("a merge into another branch than the default one is not repinned to", async () => {
    const s = setup();
    await set(s);
    merged(s);
    s.live.base = "release-1";
    await drainRepins(s.w.db, s.deps);
    assert.equal(row(s).state, "failed");
    assert.equal(task(s), undefined);
  });

  test("a merge commit the default branch no longer holds is not repinned to", async () => {
    const s = setup();
    await set(s);
    merged(s);
    s.live.sha = STRAY;
    await drainRepins(s.w.db, s.deps);
    assert.equal(row(s).state, "failed");
    assert.equal(task(s), undefined);
    assert.match(s.comments[0]!, /no longer on/);
  });

  test("whoever asked must still have write access when the merge comes", async () => {
    const s = setup();
    await set(s);
    merged(s);
    await drainRepins(s.w.db, { ...s.deps, permission: async () => "no" });
    assert.equal(row(s).state, "failed");
    assert.equal(task(s), undefined);
  });

  test("is refused on an issue, for a repo that is not tracked, and where pushes are not approved", async () => {
    const s = setup({ off: ["push"] });
    const ask = (o: Partial<Parameters<typeof requestRepin>[1]>) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: { owner: null, name: "libs", number: 12 }, ...o });
    await assert.rejects(ask({ pr: false }), /pull requests/);
    await assert.rejects(ask({ ref: { owner: null, name: "nowhere", number: 1 } }), /not a repository AutoCraft tracks/);
    await assert.rejects(ask({ ref: { owner: "someone-else", name: "libs", number: 12 } }), /not a repository AutoCraft tracks/);
    await assert.rejects(ask({ canWrite: false }), /write access/);
    await assert.rejects(ask({}), /not approved/);
    assert.equal(s.w.db.prepare("SELECT COUNT(*) AS n FROM autorepins").get()!.n, 0);
  });

  test("is refused while the repo is outside the pipeline's scope and the pull request is not fast-tracked, since no worker would take its task", async () => {
    const s = setup();
    s.w.db.prepare("UPDATE tracked_repos SET pipeline = 0 WHERE name = 'app'").run();
    await assert.rejects(set(s), /pipeline is off for ModelTok\/app/);
    assert.equal(s.w.db.prepare("SELECT COUNT(*) AS n FROM autorepins").get()!.n, 0);
  });

  test("an autorepin command carried out after a later off does not set it again", async () => {
    const s = setup();
    const ask = (ref: Parameters<typeof requestRepin>[1]["ref"], at: string) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref, at: new Date(at) });
    const libs = { owner: null, name: "libs", number: 12 };
    await ask(libs, "2026-02-01T10:00:00Z");
    await ask(null, "2026-02-01T10:10:00Z");
    // The command of 10:05, whose permission read GitHub settled only now.
    await assert.rejects(ask(libs, "2026-02-01T10:05:00Z"), /later autorepin/);
    assert.equal(row(s).state, "cancelled");
    await ask(libs, "2026-02-01T10:20:00Z");
    assert.equal(row(s).state, "waiting");
  });

  test("off drops a waiting autorepin", async () => {
    const s = setup();
    await set(s);
    await requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref: null });
    merged(s);
    assert.equal(await drainRepins(s.w.db, s.deps), 0);
    assert.equal(row(s).state, "cancelled");
    assert.equal(s.comments.length, 0);
  });

  test("an off given before any autorepin was set still stops an older command carried out later", async () => {
    const s = setup();
    const ask = (ref: Parameters<typeof requestRepin>[1]["ref"], at: string) => requestRepin(s.w.db, { login: OPERATOR, githubId: 101, role: "operator", canWrite: true, repo: "app", number: 1, pr: true, ref, at: new Date(at) });
    const libs = { owner: null, name: "libs", number: 12 };
    await ask(null, "2026-02-01T10:10:00Z");
    await assert.rejects(ask(libs, "2026-02-01T10:05:00Z"), /later autorepin off/);
    assert.equal(s.w.db.prepare("SELECT COUNT(*) AS n FROM autorepins").get()!.n, 0);
    await ask(libs, "2026-02-01T10:20:00Z");
    assert.equal(row(s).state, "waiting");
  });

  test("a comment edited to name another pull request before it is carried out sets nothing", async () => {
    const s = setup();
    s.w.db.prepare("INSERT INTO items (repo, number, kind, state, title, created_at, updated_at) VALUES ('libs', 13, 'pr', 'OPEN', 'other change', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
    await comment(s, `@${SLUG} autorepin ModelTok/libs#12`, `@${SLUG} autorepin ModelTok/libs#13`);
    assert.equal(s.w.db.prepare("SELECT COUNT(*) AS n FROM autorepins").get()!.n, 0);
    assert.equal(s.w.db.prepare("SELECT state FROM github_commands").get()!.state, "ignored");
  });
});
