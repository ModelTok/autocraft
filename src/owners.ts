// Owner (GitHub org or user) of each repo. Repo names are unique across owners, so items keep
// the bare name as key; the owner is a property of the `repos` row. Repos without a row belong to the default owner.

// A structural type: the web build imports this module through the templates and has no node types.
type DatabaseSync = { prepare(sql: string): { all(...params: never[]): unknown[] } };

export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// The GitHub org or user whose repos a bare name means. This fork serves ModelTok; `AUTOCRAFT_OWNER` overrides it
// (upstream's value is `storytold`). The web build has no `process`, so the lookup is guarded.
const envOwner = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.AUTOCRAFT_OWNER?.trim();
export const DEFAULT_OWNER = envOwner && OWNER.test(envOwner) ? envOwner : "ModelTok";

/** GitHub owner names are case-insensitive: whether `owner` is the default owner under any casing. */
export const isDefaultOwner = (owner: string | null | undefined): boolean => !!owner && owner.toLowerCase() === DEFAULT_OWNER.toLowerCase();

const REFRESH_MS = 30_000;
let cache = new Map<string, string>();
let source: DatabaseSync | null = null;
let loadedAt = 0;

/** Reads the owners from the `repos` table; the most recently loaded database also refreshes the cache later. */
export function loadOwners(db: DatabaseSync): void {
  source = db;
  const next = new Map<string, string>();
  for (const r of db.prepare("SELECT name, owner FROM main.repos").all() as { name: string; owner: string | null }[]) {
    if (r.owner) next.set(r.name, r.owner);
  }
  cache = next;
  loadedAt = Date.now();
}

export function ownerOf(repo: string): string {
  if (source && Date.now() - loadedAt > REFRESH_MS) {
    try { loadOwners(source); } catch { source = null; }
  }
  return cache.get(repo) ?? DEFAULT_OWNER;
}

/** `owner/name` of a tracked repo name. */
export const slugOf = (repo: string): string => `${ownerOf(repo)}/${repo}`;

/** Splits `owner/name` or a bare name (the default owner's). */
export function splitSlug(s: string): { owner: string; name: string } {
  const i = s.indexOf("/");
  return i < 0 ? { owner: DEFAULT_OWNER, name: s } : { owner: s.slice(0, i), name: s.slice(i + 1) };
}

/** Every owner with a tracked repo, plus the default one. */
export function trackedOwners(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT COALESCE(r.owner, ?) AS owner FROM main.tracked_repos t LEFT JOIN main.repos r ON r.name = t.name",
  ).all(DEFAULT_OWNER as never) as { owner: string }[];
  return [...new Set([DEFAULT_OWNER, ...rows.map((r) => r.owner)])].sort();
}

/** Test hook: forgets the cached owners and the database. */
export function resetOwners(): void {
  cache = new Map();
  source = null;
  loadedAt = 0;
}
