// The crates of a repo at one commit, from the GitHub tree API, cached by sha next to the diff cache.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffCacheDir } from "../review/diff.ts";
import type { Crate } from "./types.ts";
import { slugOf } from "../owners.ts";
import { readEnvFor } from "../github/read.ts";
import { ancestorDirs, resolveWorkspaces, type Workspaces } from "./workspaces.ts";

const REPO_DIR = fileURLToPath(new URL("../..", import.meta.url));
const MAX_MANIFESTS = 80;
const CRATE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `workspaces`: the crates not built from the root workspace, with the directory of the workspace manifest each is built from
 * (workspaces.ts). A repo with more manifests than the list reads (`truncated`) also keeps `manifests`, every Cargo.toml's
 * directory and blob id from the tree listing: cratesCovering then reads only the manifests above the paths a stage works
 * on, so a repo of 900 crates costs a few blob reads per item, not 900.
 */
export type CrateInfo = { rust: boolean; crates: Crate[]; workspaces?: Workspaces; truncated?: true; manifests?: Record<string, string> };
export type CratesResult = ({ ok: true } & CrateInfo) | { ok: false; error: string };
export type CratesFetcher = (repo: string, sha: string) => Promise<CratesResult>;

/** `gh api <path>` stdout; rejects with the error text. */
export async function ghApi(path: string, jq?: string): Promise<string> {
  const args = ["api", path, ...(jq ? ["--jq", jq] : [])];
  const env = await readEnvFor("gh", args);
  return new Promise((resolve, reject) => {
    const p = spawn("gh", args, { cwd: REPO_DIR, timeout: 60_000, ...(env ? { env } : {}) });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e));
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out).toString("utf8")) : reject(new Error(err.trim().slice(0, 300) || `gh exited ${code}`))));
  });
}

/** The package name in a Cargo.toml, or null for a virtual workspace manifest. */
export function packageName(toml: string): string | null {
  let inPackage = false;
  for (const line of toml.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) inPackage = t === "[package]";
    else if (inPackage) {
      const m = /^name\s*=\s*"([^"]+)"/.exec(t);
      if (m && CRATE_NAME.test(m[1]!)) return m[1]!;
    }
  }
  return null;
}

/**
 * Crates from a recursive tree listing and a reader for blobs. `rust` means a Cargo.toml at the root. The manifests of
 * every crate's ancestor directories are read too, beyond the cap, so each crate's workspace is the one cargo picks.
 */
export async function cratesFromTree(tree: { path: string; type: string; sha: string }[], readBlob: (sha: string) => Promise<string>): Promise<CrateInfo> {
  const manifests = tree.filter((e) => e.type === "blob" && (e.path === "Cargo.toml" || e.path.endsWith("/Cargo.toml")));
  const dirOf = (path: string): string => (path === "Cargo.toml" ? "." : path.slice(0, -"/Cargo.toml".length));
  const crates: Crate[] = [];
  const texts = new Map<string, string>();
  for (const m of manifests.slice(0, MAX_MANIFESTS)) {
    const text = await readBlob(m.sha);
    texts.set(dirOf(m.path), text);
    const name = packageName(text);
    if (name) crates.push({ name, dir: dirOf(m.path) });
  }
  const byDir = new Map(manifests.map((m) => [dirOf(m.path), m.sha]));
  for (const c of crates) {
    for (const a of ancestorDirs(c.dir)) {
      const sha = byDir.get(a);
      if (sha && !texts.has(a)) texts.set(a, await readBlob(sha));
    }
  }
  const truncated = manifests.length > MAX_MANIFESTS;
  return {
    rust: manifests.some((m) => m.path === "Cargo.toml"), crates, workspaces: resolveWorkspaces(texts, crates),
    ...(truncated ? { truncated: true as const, manifests: Object.fromEntries(byDir) } : {}),
  };
}

/** A manifest's text by blob id, for one repo. */
export type BlobReader = (blob: string) => Promise<string>;

export const ghBlobReader = (repo: string): BlobReader => async (blob) =>
  Buffer.from((await ghApi(`repos/${slugOf(repo)}/git/blobs/${blob}`, ".content")).trim().replace(/\\n/g, ""), "base64").toString("utf8");

/** Most paths one call resolves: a triage names at most 8 files, a diff's code files are many more but share crates. */
const MAX_COVER_PATHS = 200;

/**
 * `info` with the crates that own `paths` added: for each path, the nearest Cargo.toml above it with a [package] (as cargo
 * finds a file's package), and that crate's workspace from its ancestors' manifests (workspaces.ts). Only for a list
 * that is `truncated`; a complete list is returned as it is. What was added is stored with the commit's cached list, so
 * later stages (the round's tasks, the check tool) find the same workspaces. A manifest that cannot be read is skipped.
 */
export async function cratesCovering(repo: string, sha: string, info: CrateInfo, paths: string[], read: BlobReader = ghBlobReader(repo)): Promise<CrateInfo> {
  const manifests = info.manifests;
  if (!info.truncated || !manifests) return info;
  const known = new Set(info.crates.map((c) => c.dir));
  const texts = new Map<string, string>();
  const text = async (dir: string): Promise<string | null> => {
    if (texts.has(dir)) return texts.get(dir)!;
    const blob = manifests[dir];
    if (!blob) return null;
    try {
      const t = await read(blob);
      texts.set(dir, t);
      return t;
    } catch {
      return null;
    }
  };
  const added: Crate[] = [];
  const dirsOf = (path: string): string[] => ancestorDirs(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");
  for (const path of [...new Set(paths)].slice(0, MAX_COVER_PATHS)) {
    for (const dir of dirsOf(path)) {
      if (!(dir in manifests)) continue;
      if (known.has(dir)) break;
      const t = await text(dir);
      const name = t === null ? null : packageName(t);
      if (!name) continue;   // a virtual manifest: the package is further up, as cargo looks
      known.add(dir);
      if (!info.crates.some((c) => c.name === name) && !added.some((c) => c.name === name)) added.push({ name, dir });
      break;
    }
  }
  if (!added.length) return info;
  for (const c of added) for (const a of ancestorDirs(c.dir)) await text(a);
  const out: CrateInfo = { ...info, crates: [...info.crates, ...added], workspaces: { ...(info.workspaces ?? {}), ...resolveWorkspaces(texts, added) } };
  try {
    store(repo, sha, out);
  } catch { /* the cache is an optimisation: the crates are still returned */ }
  return out;
}

export const ghCrates: CratesFetcher = async (repo, sha) => {
  try {
    const raw = await ghApi(`repos/${slugOf(repo)}/git/trees/${sha}?recursive=1`, "[.tree[] | {path, type, sha}]");
    const tree = JSON.parse(raw) as { path: string; type: string; sha: string }[];
    const info = await cratesFromTree(tree, async (blob) => Buffer.from((await ghApi(`repos/${slugOf(repo)}/git/blobs/${blob}`, ".content")).trim().replace(/\\n/g, ""), "base64").toString("utf8"));
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
};

const cachePath = (repo: string, sha: string): string => join(diffCacheDir(), repo, `crates-${sha}.json`);

/** The cached answer for a commit, or null when none was fetched yet. An answer stored before workspaces were recorded counts as none. */
export function cachedCratesOf(repo: string, sha: string): CrateInfo | null {
  const f = cachePath(repo, sha);
  if (!existsSync(f)) return null;
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as CrateInfo;
    return v.workspaces ? v : null;
  } catch {
    return null;
  }
}

/** The workspace map of a commit's cached crate list; empty (everything from the root) when nothing is cached. */
export const workspacesOf = (repo: string, sha: string): Workspaces => cachedCratesOf(repo, sha)?.workspaces ?? {};

export async function cachedCrates(repo: string, sha: string, fetch: CratesFetcher): Promise<CratesResult> {
  const hit = cachedCratesOf(repo, sha);
  if (hit) return { ok: true, ...hit };
  const r = await fetch(repo, sha);
  if (r.ok) store(repo, sha, r);
  return r;
}

function store(repo: string, sha: string, r: CrateInfo): void {
  const f = cachePath(repo, sha);
  mkdirSync(join(diffCacheDir(), repo), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify({ rust: r.rust, crates: r.crates, workspaces: r.workspaces ?? {}, ...(r.truncated ? { truncated: true, manifests: r.manifests ?? {} } : {}) }));
  renameSync(`${f}.tmp`, f);
}
