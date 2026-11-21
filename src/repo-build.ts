// Per-repo build settings, kept in the settings table and audited like the scope line (repo-scope.ts):
//   repo_toolchain:<repo>   the toolchain image name a repo's Rust tasks require instead of rust-stable (createTask)
//   repo_companions:<repo>  JSON [{ repo, env }]: other repos of the same owner whose source a task's test steps also get
//                           (build/companions.ts), each pointed at by one environment variable
//   repo_hold_paths:<repo>  JSON [prefix]: paths fix issues may not change on its own (fixissue); a fix that would is
//                           left to a person
// Set with `autocraft-server repos toolchain|companions|hold-paths`.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";

export const DEFAULT_RUST_TOOLCHAIN = "rust-stable";
/** The shape parseRequires (build/tasks.ts) accepts for a toolchain name. */
export const TOOLCHAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** A variable a step's own setup never sets: upper case, and none the worker, cargo, rustup or the loader read. */
export const COMPANION_ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = /^(?:HOME|PATH|USER|SHELL|TMPDIR|CI|LANG|TERM|CARGO|RUSTC|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|CARGO_.*|RUSTUP_.*|RUST_.*|LD_.*|CRAFT_.*|GIT_.*|SSL_.*)$/;
export const MAX_COMPANIONS = 4;
export const MAX_HOLD_PATHS = 40;

export type CompanionSpec = { repo: string; env: string };

const read = (db: DatabaseSync, key: string): string | undefined => {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  const v = row?.value?.trim();
  return v ? v : undefined;
};
const write = (db: DatabaseSync, key: string, value: string | null): void => {
  if (value === null) db.prepare("DELETE FROM main.settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};
const jsonList = <T>(text: string | undefined): T[] => {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

// ---- toolchain -------------------------------------------------------------------

/** The toolchain the repo's Rust tasks require, when an operator set one. */
export function repoToolchain(db: DatabaseSync, repo: string): string | undefined {
  const v = read(db, `repo_toolchain:${repo}`);
  return v && TOOLCHAIN_RE.test(v) ? v : undefined;
}

/** The toolchain of the repo's Rust tasks: its setting, else rust-stable. */
export const rustToolchain = (db: DatabaseSync, repo: string): string => repoToolchain(db, repo) ?? DEFAULT_RUST_TOOLCHAIN;

/** Sets the repo's toolchain, or clears it with null. Returns false when nothing changed. */
export function setRepoToolchain(db: DatabaseSync, by: string, repo: string, name: string | null): boolean {
  if (name !== null && !TOOLCHAIN_RE.test(name)) throw new Error(`"${name}" is not a toolchain name (letters, digits, . _ + -, at most 40)`);
  if ((repoToolchain(db, repo) ?? null) === name) return false;
  write(db, `repo_toolchain:${repo}`, name);
  audit(db, by, name === null ? "repo-toolchain-clear" : "repo-toolchain-set", repo, name === null ? undefined : { toolchain: name });
  return true;
}

// ---- companions ------------------------------------------------------------------

const companionProblem = (repo: string, c: CompanionSpec): string | null => {
  if (!REPO_NAME.test(c.repo) || c.repo === "." || c.repo === "..") return `"${c.repo}" is not a repository name (a companion is a repo of the same owner, by bare name)`;
  if (c.repo === repo) return "a repo is not its own companion";
  if (!COMPANION_ENV.test(c.env)) return `"${c.env}" is not an environment variable name (upper case, digits and _)`;
  if (RESERVED_ENV.test(c.env)) return `${c.env} is a variable the worker, cargo or the system reads; pick another name`;
  return null;
};

/** The repo's companions, when an operator set any; malformed entries are left out. */
export function repoCompanions(db: DatabaseSync, repo: string): CompanionSpec[] {
  return jsonList<CompanionSpec>(read(db, `repo_companions:${repo}`))
    .filter((c) => c && typeof c.repo === "string" && typeof c.env === "string" && companionProblem(repo, c) === null)
    .slice(0, MAX_COMPANIONS);
}

/** Every repo with companions, and the companions' names: the heads the coordinator keeps resolved. */
export function allCompanions(db: DatabaseSync): { repo: string; companions: CompanionSpec[] }[] {
  const rows = db.prepare("SELECT key FROM main.settings WHERE key LIKE 'repo_companions:%'").all() as { key: string }[];
  return rows.map((r) => r.key.slice("repo_companions:".length)).map((repo) => ({ repo, companions: repoCompanions(db, repo) })).filter((r) => r.companions.length);
}

/** Parses `name=ENV` words of the CLI. */
export function parseCompanionArgs(words: string[]): CompanionSpec[] {
  return words.map((w) => {
    const m = /^([^=]+)=(.+)$/.exec(w);
    if (!m) throw new Error(`"${w}" is not <repo>=<ENV_VAR>`);
    return { repo: m[1]!, env: m[2]! };
  });
}

/** Sets the repo's companions, or clears them with null. Returns false when nothing changed. */
export function setRepoCompanions(db: DatabaseSync, by: string, repo: string, list: CompanionSpec[] | null): boolean {
  if (list !== null) {
    if (!list.length) throw new Error("name at least one companion, or use --clear");
    if (list.length > MAX_COMPANIONS) throw new Error(`at most ${MAX_COMPANIONS} companions`);
    for (const c of list) {
      const bad = companionProblem(repo, c);
      if (bad) throw new Error(bad);
    }
    if (new Set(list.map((c) => c.repo)).size !== list.length || new Set(list.map((c) => c.env)).size !== list.length) throw new Error("each companion and each variable may appear once");
  }
  const value = list === null ? null : JSON.stringify(list.map((c) => ({ repo: c.repo, env: c.env })));
  const was = repoCompanions(db, repo);
  if ((was.length ? JSON.stringify(was) : null) === value) return false;
  write(db, `repo_companions:${repo}`, value);
  audit(db, by, list === null ? "repo-companions-clear" : "repo-companions-set", repo, list === null ? undefined : { companions: list });
  return true;
}

// ---- hold paths ------------------------------------------------------------------

/** A repo-relative path prefix: no leading slash, no `.` or `..` segment, no backslash. A trailing slash names a directory. */
const holdProblem = (p: string): string | null =>
  !p || p.length > 200 || p.startsWith("/") || p.includes("\\") || /[\s\0*?]/.test(p) || p.split("/").slice(0, p.endsWith("/") ? -1 : undefined).some((s) => s === "" || s === "." || s === "..")
    ? `"${p}" is not a repository path prefix (relative, no globs; end a directory with /)`
    : null;

/** The path prefixes fix issues may not change on its own in the repo. */
export function repoHoldPaths(db: DatabaseSync, repo: string): string[] {
  return jsonList<string>(read(db, `repo_hold_paths:${repo}`)).filter((p) => typeof p === "string" && holdProblem(p) === null).slice(0, MAX_HOLD_PATHS);
}

/** Sets the repo's held prefixes, or clears them with null. Returns false when nothing changed. */
export function setRepoHoldPaths(db: DatabaseSync, by: string, repo: string, prefixes: string[] | null): boolean {
  let list: string[] | null = null;
  if (prefixes !== null) {
    if (!prefixes.length) throw new Error("name at least one path prefix, or use --clear");
    for (const p of prefixes) {
      const bad = holdProblem(p);
      if (bad) throw new Error(bad);
    }
    list = [...new Set(prefixes)];
    if (list.length > MAX_HOLD_PATHS) throw new Error(`at most ${MAX_HOLD_PATHS} prefixes`);
  }
  const was = repoHoldPaths(db, repo);
  if (JSON.stringify(was) === JSON.stringify(list ?? [])) return false;
  write(db, `repo_hold_paths:${repo}`, list === null ? null : JSON.stringify(list));
  audit(db, by, list === null ? "repo-hold-paths-clear" : "repo-hold-paths-set", repo, list === null ? undefined : { prefixes: list });
  return true;
}

/** Whether `path` lies under the held `prefix`: the same path, or under it as a directory (`docs/status/` and `docs/status` alike). */
export function heldBy(path: string, prefix: string): boolean {
  const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path === prefix.replace(/\/$/, "") || path.startsWith(dir);
}

/** The first of `paths` the repo holds, with the prefix that holds it; null when none is held. */
export function heldPath(db: DatabaseSync, repo: string, paths: string[]): { path: string; prefix: string } | null {
  const held = repoHoldPaths(db, repo);
  for (const path of paths) for (const prefix of held) if (heldBy(path, prefix)) return { path, prefix };
  return null;
}
