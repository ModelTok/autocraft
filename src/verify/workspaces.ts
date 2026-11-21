// Which Cargo workspace a crate is built from. A repo may hold several independent workspaces, each with its own
// Cargo.lock (poka: the root workspace, and the desktop host's own under 6-hosts/desktop/src-tauri). Cargo finds a
// package's workspace by walking up from its directory to the nearest manifest with a [workspace] table that does not
// exclude it; a package that table does not list as a member is refused there ("did not match any packages"). Such a
// package can still be built as a path dependency of a package of another workspace (poka's core/poka-core is reached
// only through the desktop host), so it is run with `-p <name>` against that workspace's manifest.
// Pure, no Node imports: the plans are built from what the tree API returned.
import { joinPath } from "../core/cargo-manifest.ts";
import { parseToml, type TomlTable } from "../core/toml.ts";

/** Crate name -> directory of the workspace manifest cargo is run with, for crates not built from the root ("."). */
export type Workspaces = Record<string, string>;

type Manifest = { dir: string; pkg: string | null; ws: { members: string[]; exclude: string[] } | null; explicitRoot: string | null; pathDeps: string[] };

const isTable = (v: unknown): v is TomlTable => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const DEP_TABLES = ["dependencies", "dev-dependencies", "dev_dependencies", "build-dependencies", "build_dependencies"];

/** The parts of a manifest the workspace rules read, or null when it does not parse. `dir` is "." for the repo root. */
export function readManifest(dir: string, toml: string): Manifest | null {
  const r = parseToml(toml);
  if (!r.ok) return null;
  const d = r.data;
  const base = dir === "." ? "" : dir;
  const pkg = isTable(d["package"]) && typeof d["package"]["name"] === "string" ? d["package"]["name"] : null;
  const w = isTable(d["workspace"]) ? d["workspace"] : null;
  const explicit = isTable(d["package"]) && typeof d["package"]["workspace"] === "string" ? joinPath(base, d["package"]["workspace"]) : null;
  const deps: string[] = [];
  const tables: unknown[] = DEP_TABLES.map((t) => d[t]);
  if (w) tables.push(w["dependencies"]);
  if (isTable(d["target"])) for (const v of Object.values(d["target"])) if (isTable(v)) for (const t of DEP_TABLES) tables.push(v[t]);
  for (const t of tables) {
    if (!isTable(t)) continue;
    for (const spec of Object.values(t)) {
      if (isTable(spec) && typeof spec["path"] === "string") {
        const p = joinPath(base, spec["path"]);
        if (p !== null) deps.push(p || ".");
      }
    }
  }
  return { dir, pkg, ws: w ? { members: strings(w["members"]), exclude: strings(w["exclude"]) } : null, explicitRoot: explicit === null ? null : explicit || ".", pathDeps: deps };
}

const segments = (p: string): string[] => (p === "." || p === "" ? [] : p.split("/").filter((s) => s !== "" && s !== "."));

/** One path segment of a cargo member glob (`*`, `?`, `[...]`) as a regular expression. */
function segmentRe(seg: string): RegExp {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end < 0) { out += "\\["; continue; }
      const body = seg.slice(i + 1, end).replace(/\\/g, "\\\\");
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Whether `path` (segments) matches the glob `pattern` (segments); `**` matches any number of segments. */
function globMatch(pattern: string[], path: string[]): boolean {
  if (!pattern.length) return !path.length;
  const [p, ...rest] = pattern;
  if (p === "**") {
    for (let i = 0; i <= path.length; i++) if (globMatch(rest, path.slice(i))) return true;
    return false;
  }
  return path.length > 0 && segmentRe(p!).test(path[0]!) && globMatch(rest, path.slice(1));
}

const within = (root: string[], path: string[]): string[] | null => (root.every((s, i) => path[i] === s) && path.length >= root.length ? path.slice(root.length) : null);
const startsWith = (path: string[], prefix: string[]): boolean => prefix.every((s, i) => path[i] === s) && path.length >= prefix.length;

/**
 * The workspace each crate is built from, as cargo resolves it, for the crates that are not built from the root.
 * `manifests` maps a directory ("." for the root) to its Cargo.toml text; a manifest missing from it counts as absent.
 */
export function resolveWorkspaces(manifests: Map<string, string>, crates: { name: string; dir: string }[]): Workspaces {
  const read = new Map<string, Manifest>();
  for (const [dir, text] of manifests) {
    const m = readManifest(dir, text);
    if (m) read.set(dir, m);
  }
  const joinDir = (s: string[]): string => (s.length ? s.join("/") : ".");
  const isMemberOf = (root: Manifest, dir: string): boolean => {
    const rel = within(segments(root.dir), segments(dir));
    if (!rel) return false;
    if (!rel.length) return root.pkg !== null;
    return root.ws!.members.some((m) => globMatch(segments(m), rel));
  };
  const excludedBy = (root: Manifest, dir: string): boolean => {
    const rel = within(segments(root.dir), segments(dir));
    if (!rel) return false;
    const explicit = root.ws!.members.some((m) => globMatch(segments(m), rel) || startsWith(rel, segments(m)));
    return !explicit && root.ws!.exclude.some((e) => startsWith(rel, segments(e)));
  };
  /** The root cargo picks for the package at `dir`: a directory, or null for a package that is its own workspace. */
  const rootOf = (dir: string): string | null => {
    const own = read.get(dir);
    if (own?.ws) return dir;
    if (own?.explicitRoot) return own.explicitRoot;
    const s = segments(dir);
    for (let n = s.length - 1; n >= 0; n--) {
      const a = joinDir(s.slice(0, n));
      const m = read.get(a);
      if (m?.ws && !excludedBy(m, dir)) return a;
    }
    return null;
  };
  // Members of a root through path dependencies: every path dependency of a member that lies under the root and is not excluded.
  const implied = new Map<string, Set<string>>();
  const membersOf = (root: Manifest): Set<string> => {
    let set = implied.get(root.dir);
    if (set) return set;
    set = new Set([...read.values()].filter((m) => m.pkg && isMemberOf(root, m.dir)).map((m) => m.dir));
    const queue = [...set];
    while (queue.length) {
      for (const dep of read.get(queue.shift()!)?.pathDeps ?? []) {
        if (set.has(dep) || !read.get(dep)?.pkg || !within(segments(root.dir), segments(dep)) || excludedBy(root, dep)) continue;
        set.add(dep);
        queue.push(dep);
      }
    }
    implied.set(root.dir, set);
    return set;
  };
  /** Where cargo can build the package at `dir` as a member: its root's directory, its own, or null when its root refuses it. */
  const homeOf = (dir: string): string | null => {
    const root = rootOf(dir);
    if (root === null) return dir;
    const m = read.get(root);
    return m?.ws && membersOf(m).has(dir) ? root : null;
  };
  const dependents = new Map<string, string[]>();
  for (const m of read.values()) if (m.pkg) for (const d of m.pathDeps) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(m.dir);
  for (const list of dependents.values()) list.sort();
  /** A workspace that reaches the package at `dir` through path dependencies, nearest first. */
  const hostOf = (dir: string): string | null => {
    const seen = new Set([dir]);
    let level = [dir];
    while (level.length) {
      const next: string[] = [];
      for (const d of level) for (const up of dependents.get(d) ?? []) {
        if (seen.has(up)) continue;
        seen.add(up);
        const home = homeOf(up);
        if (home !== null) return home;
        next.push(up);
      }
      level = next;
    }
    return null;
  };
  const out: Workspaces = {};
  for (const c of crates) {
    if (c.name in out) continue;
    const dir = c.dir || ".";
    const ws = homeOf(dir) ?? hostOf(dir);
    if (ws !== null && ws !== ".") out[c.name] = ws;
  }
  return out;
}

/** The directories of the manifests the rules may need for a crate at `dir`: its own and each ancestor's. */
export function ancestorDirs(dir: string): string[] {
  const s = segments(dir);
  const out: string[] = [];
  for (let n = s.length; n >= 0; n--) out.push(n ? s.slice(0, n).join("/") : ".");
  return out;
}
