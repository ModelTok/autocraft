// Companion sources on the worker (ClaimedTask.companions): another repo of the task's owner, such as a sample corpus,
// fetched at the commit the coordinator recorded, unpacked once per commit under <warmDir>/companions, made read-only,
// and mounted read-only into the steps marked `companions`. A private companion is fetched only through the worker's
// privateFetch token for that owner; any other owner's private companion is refused. A copy in use by a running task is
// never removed; the copies of a companion's older commits go once no task uses them. Every failure here is a note for
// the task's log: the steps then run without the companion's variable.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freeDiskGb, type WorkerConfig } from "./config.ts";
import type { PrivateSource } from "./private-source.ts";
import { removeTree } from "./rmtree.ts";
import { downloadAndExtract } from "./tarball.ts";
import type { ClaimedCompanion } from "./types.ts";
import { OWNER } from "../owners.ts";

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Variables the worker sets itself or that change how cargo, rustup or the loader behave; a companion never sets one. */
const RESERVED_ENV = /^(?:HOME|PATH|USER|SHELL|TMPDIR|CI|LANG|TERM|CARGO|RUSTC|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|CARGO_.*|RUSTUP_.*|RUST_.*|LD_.*|CRAFT_.*|GIT_.*|SSL_.*)$/;
export const MAX_TASK_COMPANIONS = 4;
/** Where a companion is mounted in a step's container. */
export const companionTarget = (repo: string): string => `/companions/${repo}`;

/** Whether a claimed task's `companions` field is absent or well formed; the problem otherwise. */
export function companionsFieldProblem(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > MAX_TASK_COMPANIONS) return `companions must be a list of at most ${MAX_TASK_COMPANIONS}`;
  const seen = new Set<string>();
  for (const c of v as Record<string, unknown>[]) {
    if (!c || typeof c !== "object" || Object.keys(c).some((k) => !["repo", "owner", "env", "sha", "private", "note"].includes(k))) return "a companion must be { repo, owner, env, sha?, private?, note? }";
    if (typeof c.repo !== "string" || !REPO_RE.test(c.repo) || c.repo === "." || c.repo === "..") return "a companion's repo is not a repository name";
    if (typeof c.owner !== "string" || !OWNER.test(c.owner)) return "a companion's owner is not a GitHub owner name";
    if (typeof c.env !== "string" || !ENV_RE.test(c.env) || RESERVED_ENV.test(c.env)) return `a companion's variable is not allowed: ${String(c.env)}`;
    if (c.sha !== undefined && (typeof c.sha !== "string" || !SHA_RE.test(c.sha))) return "a companion's sha is not a full commit id";
    if (c.private !== undefined && c.private !== true) return "a companion's private must be true or absent";
    if (c.note !== undefined && (typeof c.note !== "string" || c.note.length > 300)) return "a companion's note must be a short string";
    if (c.sha === undefined && c.note === undefined) return "a companion needs a sha or a note";
    if (seen.has(c.repo) || seen.has(`$${c.env}`)) return "each companion and variable may appear once";
    seen.add(c.repo);
    seen.add(`$${c.env}`);
  }
  return null;
}

/** The directory under the warm dir that holds the companion copies, <owner>/<repo>/<sha>. */
export const COMPANIONS_DIR = "companions";
const keyOf = (c: { owner: string; repo: string }): string => `${c.owner.toLowerCase()}/${c.repo}`;
const rootOf = (cfg: WorkerConfig, c: { owner: string; repo: string }): string => join(cfg.warmDir, COMPANIONS_DIR, c.owner.toLowerCase(), c.repo);

/** At startup: removes copies a crash left unfinished. The finished copies stay for the next task. */
export function cleanCompanions(cfg: WorkerConfig, note: (s: string) => void = () => {}): void {
  const top = join(cfg.warmDir, COMPANIONS_DIR);
  if (!existsSync(top)) return;
  for (const owner of readdirSync(top)) {
    for (const repo of readdirSync(join(top, owner))) {
      for (const e of readdirSync(join(top, owner, repo))) {
        const path = join(top, owner, repo, e);
        if (SHA_RE.test(e) && existsSync(join(path, ".complete"))) continue;
        try {
          removeTree(path);
        } catch (err) {
          note(`could not remove the companion copy ${e} (${(err as Error).message})`);
        }
      }
    }
  }
}

/** Running tasks per unpacked copy, and the newest commit asked for per companion: the copies the pruning keeps. */
const inUse = new Map<string, number>();
const newest = new Map<string, string>();
const unpacking = new Map<string, Promise<string>>();

/** Removes the companion's copies of other commits that no running task uses. */
function prune(cfg: WorkerConfig, c: { owner: string; repo: string }, note: (s: string) => void): void {
  const root = rootOf(cfg, c);
  if (!existsSync(root)) return;
  const keep = newest.get(keyOf(c));
  for (const e of readdirSync(root)) {
    const path = join(root, e);
    // Only finished copies: a .tmp- directory may be one being unpacked right now.
    if (!SHA_RE.test(e) || e === keep || (inUse.get(path) ?? 0) > 0 || unpacking.has(path)) continue;
    try {
      removeTree(path);
    } catch (err) {
      note(`could not remove the companion copy ${e} (${(err as Error).message})`);
    }
  }
}

/** Drops write permission below `dir`: the copy on the host stays as fetched, whatever a step does to its mount. */
function makeReadOnly(dir: string): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) makeReadOnly(p);
    else chmodSync(p, st.mode & 0o555);
  }
  chmodSync(dir, 0o555);
}

export type CompanionDeps = { fetchImpl?: typeof fetch; privateSource?: PrivateSource; freeDiskGb?: (path: string) => number; note?: (s: string) => void };

/**
 * The directory holding `c` at its commit, unpacked once and reused across tasks. The caller holds it until `release`.
 * Throws (a message for the task's log) when it may not or cannot be fetched.
 */
export async function acquireCompanion(cfg: WorkerConfig, c: ClaimedCompanion & { sha: string }, d: CompanionDeps = {}): Promise<{ dir: string; release: () => void }> {
  const note = d.note ?? (() => {});
  if (c.private && !d.privateSource?.covers(c.owner)) {
    throw new Error(d.privateSource ? `${c.owner}/${c.repo} is private and this worker fetches private code only of ${d.privateSource.owner}` : `${c.owner}/${c.repo} is private and this worker has no privateFetch`);
  }
  const root = rootOf(cfg, c);
  const dir = join(root, c.sha);
  newest.set(keyOf(c), c.sha);
  inUse.set(dir, (inUse.get(dir) ?? 0) + 1);
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    const n = (inUse.get(dir) ?? 1) - 1;
    if (n > 0) inUse.set(dir, n);
    else inUse.delete(dir);
    prune(cfg, c, note);
  };
  try {
    if (!existsSync(join(dir, ".complete"))) {
      let job = unpacking.get(dir);
      if (!job) {
        job = unpack(cfg, c, root, dir, d).finally(() => unpacking.delete(dir));
        unpacking.set(dir, job);
      }
      await job;
    }
    prune(cfg, c, note);
    return { dir, release };
  } catch (e) {
    release();
    throw e;
  }
}

async function unpack(cfg: WorkerConfig, c: ClaimedCompanion & { sha: string }, root: string, dir: string, d: CompanionDeps): Promise<string> {
  // The free-disk pause stops claims below limits.minFreeDiskGb; a companion this size is not unpacked below it either.
  const free = (d.freeDiskGb ?? freeDiskGb)(cfg.warmDir);
  if (free < cfg.limits.minFreeDiskGb + cfg.maxCompanionMb / 1024) throw new Error(`only ${free.toFixed(1)} GB free under the warm dir; ${c.repo} is not unpacked`);
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `.tmp-${randomBytes(4).toString("hex")}`);
  mkdirSync(tmp);
  try {
    const maxBytes = cfg.maxCompanionMb * 1024 * 1024;
    // A corpus unpacks to several times its archive; entries as for any source tarball, with room for many small files.
    const limits = { maxBytes: maxBytes * 4, maxEntries: 500_000 };
    if (c.private) await d.privateSource!.downloadTarball(c.owner, c.repo, c.sha, tmp, maxBytes, limits, d.fetchImpl);
    else await downloadAndExtract(`https://codeload.github.com/${c.owner}/${c.repo}/tar.gz/${c.sha}`, tmp, maxBytes, limits, d.fetchImpl);
    writeFileSync(join(tmp, ".complete"), "");
    makeReadOnly(tmp);
    try {
      renameSync(tmp, dir);
    } catch (e) {
      if (!existsSync(join(dir, ".complete"))) throw e; // another worker process stored the same commit first
    }
    return dir;
  } finally {
    if (existsSync(tmp)) removeTree(tmp);
  }
}

/** Test hook: forgets which copies are in use. */
export function resetCompanions(): void {
  inUse.clear();
  newest.clear();
  unpacking.clear();
}
