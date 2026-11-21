// Nested Cargo workspaces: a crate is built from the workspace cargo would pick for it, and a crate that its nearest
// workspace does not list (poka's core/poka-core) from a workspace that reaches it as a path dependency. A repo with one
// workspace keeps the plans it had.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";

// The crate lists this file stores go to a scratch cache, never the user's.
process.env.AUTOCRAFT_DIFF_CACHE = join(SCRATCH, "diffs");
import { tasksFor as fixTasks } from "../src/fixissue/index.ts";
import { checkPlan } from "../src/checktool/index.ts";
import { lintPlan } from "../src/prepush/index.ts";
import { cratesCovering, cratesFromTree, workspacesOf } from "../src/verify/crates.ts";
import { tasksFor as verifyTasks } from "../src/verify/tasks.ts";
import { resolveWorkspaces } from "../src/verify/workspaces.ts";
import { FETCH_SCRIPT, cargoTargets, rustPlan } from "../src/worker/rust.ts";

// Shaped like poka: a root workspace of globs with excludes, a vendored crate under a member, a library in neither list,
// and a host that is a workspace of its own (excluded from the root) and depends on that library by path.
const POKA: Record<string, string> = {
  ".": `[workspace]\nresolver = "2"\nmembers = [\n  "parsers/*", # every parser\n  "core/proto",\n]\nexclude = [\n  "parsers/pdf/vendor",\n  "hosts/desktop",\n]\n[workspace.dependencies]\nproto = { path = "core/proto" }\n`,
  "parsers/pdf": `[package]\nname = "poka-pdf"\nversion = "0.1.0"\n[dependencies]\nproto.workspace = true\nlopdf = { path = "vendor" }\n`,
  "parsers/pdf/vendor": `[package]\nname = "lopdf"\nversion = "0.1.0"\n`,
  "parsers/png": `[package]\nname = "poka-png"\nversion = "0.1.0"\n`,
  "core/proto": `[package]\nname = "proto"\nversion = "0.1.0"\n`,
  "core/engine": `[package]\nname = "poka-core"\nversion = "0.1.0"\n[dependencies]\nserde = "1"\n`,
  "hosts/desktop": `[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\npoka-core = { path = "../../core/engine" }\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n`,
};
const crates = Object.entries(POKA).filter(([d]) => d !== ".").map(([dir, t]) => ({ name: /name = "([^"]+)"/.exec(t)![1]!, dir }));

test("each crate maps to the workspace cargo builds it from; root members are left out of the map", () => {
  const ws = resolveWorkspaces(new Map(Object.entries(POKA)), crates);
  assert.equal(ws["poka-core"], "hosts/desktop", "a library no workspace lists is built through the host that depends on it");
  assert.equal(ws["app"], "hosts/desktop", "an excluded package is its own workspace");
  assert.ok(!("poka-png" in ws) && !("poka-pdf" in ws) && !("proto" in ws), "root members run from the root as before");
  // The vendored crate is a path dependency of a member, but excluded: cargo makes it a workspace of its own, not a root member.
  assert.equal(ws["lopdf"], "parsers/pdf/vendor");
});

test("a path dependency inside the root becomes a member, as cargo makes it one", () => {
  const m = new Map(Object.entries({ ".": `[workspace]\nmembers = ["app"]\n`, app: `[package]\nname = "app"\n[dependencies]\nutil = { path = "../libs/util" }\n`, "libs/util": `[package]\nname = "util"\n` }));
  assert.deepEqual(resolveWorkspaces(m, [{ name: "app", dir: "app" }, { name: "util", dir: "libs/util" }]), {});
});

test("a single-workspace plan is unchanged; a crate of a nested workspace runs with its manifest and fetches its lock", () => {
  assert.deepEqual(rustPlan({ targets: cargoTargets(["poka-png"], {}) }), rustPlan({ cargoArgs: ["-p", "poka-png"] }));
  assert.equal(rustPlan({ cargoArgs: ["-p", "poka-png"] })[0]!.cmd[2], FETCH_SCRIPT);
  const ws = resolveWorkspaces(new Map(Object.entries(POKA)), crates);
  const [head, base] = fixTasks({ repo: "poka", number: 7, main_sha: "a".repeat(40), crate: "poka-core", test: "autocraft_regression_7", workspaces: ws }, "diff", "diff");
  for (const name of ["build", "test", "regression"]) {
    const s = head!.plan.find((p) => p.name === name)!;
    const at = s.cmd.indexOf("--manifest-path");
    assert.ok(at > 0 && s.cmd[at + 1] === "hosts/desktop/Cargo.toml" && s.cmd.includes("poka-core"), `${name} runs against the host workspace`);
  }
  const fetch = head!.plan[0]!.cmd[2]!;
  assert.match(fetch, /cargo fetch --locked --manifest-path hosts\/desktop\/Cargo\.toml$/m, "the host's lock is fetched");
  assert.doesNotMatch(fetch, /cargo fetch --locked$/m, "the root lock, which the plan does not read, is not");
  const baseTest = base!.plan.find((p) => p.name === "test")!;
  assert.deepEqual(baseTest.cmd.slice(-2), ["--test", "autocraft_regression_7"], "the base task still runs only the regression test");
});

test("crates of two workspaces get a build and test step each, and fetch both locks", () => {
  const ws = resolveWorkspaces(new Map(Object.entries(POKA)), crates);
  const [t] = verifyTasks({ kind: "tests", reason: "r", crates: ["poka-png", "poka-core"], tests: ["decode"] }, { repo: "poka", number: 3, head: "b".repeat(40), base: "c".repeat(40) }, ws);
  const tests = t!.plan.filter((s) => s.name.startsWith("test"));
  assert.equal(tests.length, 2);
  assert.ok(tests.every((s) => s.cmd.slice(-2).join(" ") === "-- decode"), "the filters reach every test step");
  assert.ok(!tests[0]!.cmd.includes("--manifest-path") && tests[1]!.cmd.includes("hosts/desktop/Cargo.toml"));
  const fetch = t!.plan[0]!.cmd[2]!;
  assert.match(fetch, /cargo fetch --locked \|\| exit 1$/m);
  assert.match(fetch, /--manifest-path hosts\/desktop\/Cargo\.toml$/m);
});

test("the check tool and the pre-push tests run a nested crate from its workspace", () => {
  const ws = resolveWorkspaces(new Map(Object.entries(POKA)), crates);
  const plan = checkPlan({ patch: "x", command: "test", crate: "poka-core" }, ws)!;
  assert.equal(plan[1]!.cmd.at(-1), "hosts/desktop/Cargo.toml");
  assert.match(plan[0]!.cmd[2]!, /--manifest-path hosts\/desktop\/Cargo\.toml/);
  assert.deepEqual(checkPlan({ patch: "x", command: "test", crate: "poka-png" }, ws), checkPlan({ patch: "x", command: "test", crate: "poka-png" }));
  const lint = lintPlan(["core/engine/src/lib.rs"], ["poka-core"], "hosts/desktop/Cargo.toml")!;
  const tests = lint.find((s) => s.name === "tests")!;
  assert.deepEqual(tests.cmd.slice(3), ["tests", "hosts/desktop/Cargo.toml", "poka-core"]);
  assert.match(lint[0]!.cmd[2]!, /--manifest-path hosts\/desktop\/Cargo\.toml$/m, "the tests' lock is fetched with the root one clippy reads");
});

test("the crate list reads ancestor manifests past its cap, so a deep crate still finds its workspace", async () => {
  // The nested workspace's manifest comes after the first 80 manifests, which are all the capped loop reads.
  const tree = [
    { path: "Cargo.toml", type: "blob", sha: "root" },
    { path: "a/ws/inner/Cargo.toml", type: "blob", sha: "inner" },
    ...Array.from({ length: 84 }, (_, i) => ({ path: `b/c${i}/Cargo.toml`, type: "blob", sha: `m${i}` })),
    { path: "a/ws/Cargo.toml", type: "blob", sha: "ws" },
  ];
  const blobs: Record<string, string> = { root: `[workspace]
members = ["b/*"]
`, inner: `[package]
name = "inner"
`, ws: `[workspace]
members = ["inner"]
` };
  const info = await cratesFromTree(tree, async (sha) => blobs[sha] ?? `[package]
name = "c${sha.slice(1)}"
`);
  assert.equal(info.crates.length, 79, "the cap still bounds the crates listed");
  assert.equal(info.workspaces!["inner"], "a/ws");
  assert.ok(!("c3" in info.workspaces!), "root members stay on the root");
});

test("a repo of more crates than the list reads still finds a deep crate from the paths it works on, with a few reads", async () => {
  // 120 parser crates, the root workspace and a host workspace of its own: far past the 80 manifests the list reads.
  const tree = [
    { path: "Cargo.toml", type: "blob", sha: "root" },
    ...Array.from({ length: 120 }, (_, i) => ({ path: `parsers/p${i}/Cargo.toml`, type: "blob", sha: `p${i}` })),
    { path: "zz/host/Cargo.toml", type: "blob", sha: "host" },
  ];
  const blobs = (sha: string): string =>
    sha === "root" ? `[workspace]\nmembers = ["parsers/*"]\nexclude = ["zz/host"]\n` : sha === "host" ? `[package]\nname = "host"\n` : `[package]\nname = "poka-${sha.slice(1)}"\n`;
  const info = await cratesFromTree(tree, async (sha) => blobs(sha));
  assert.ok(info.truncated && info.crates.length < 121 && !info.crates.some((c) => c.name === "poka-110"), "the list itself stays capped");
  assert.equal(Object.keys(info.manifests!).length, 122, "every manifest's place is kept, without reading it");
  const reads: string[] = [];
  const read = async (sha: string) => { reads.push(sha); return blobs(sha); };
  const sha = "f".repeat(40);
  const got = await cratesCovering("big-repo", sha, info, ["parsers/p110/src/deep/nested/mod.rs", "parsers/p110/tests/x.rs", "zz/host/src/main.rs"], read);
  assert.deepEqual(got.crates.filter((c) => c.name === "poka-110" || c.name === "host").map((c) => c.dir).sort(), ["parsers/p110", "zz/host"]);
  assert.equal(got.workspaces!["host"], "zz/host", "the host crate is its own workspace, as cargo resolves it");
  assert.ok(!("poka-110" in got.workspaces!), "a root member stays on the root");
  assert.ok(reads.length <= 4, `only the manifests above the paths are read (${reads.join(", ")})`);
  // Stored with the commit's list, so the round's tasks and the check tool see the same workspaces.
  assert.equal(workspacesOf("big-repo", sha)["host"], "zz/host");
  const small = { rust: true, crates: [{ name: "a", dir: "." }] };
  assert.equal(await cratesCovering("small-repo", sha, small, ["src/lib.rs"], read), small, "a complete list is left alone");
});
