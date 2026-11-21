// Companion sources of a build task (setting repo_companions, repo-build.ts): other repos of the task repo's owner whose
// source the test steps also read, such as poka's sample corpus poka-samples (POKA_SAMPLES). The coordinator keeps each
// companion's default-branch head and visibility resolved (at most every HEAD_TTL_MS, through gh) in the settings table,
// so createTask, which cannot wait for GitHub, records the commit in the task; claim fills a commit that was not known
// yet. A private companion goes only to an environment that takes the owner's private code (build/private.ts), and the
// worker refuses it otherwise; one the task cannot get is named with a note, and the steps run without its variable.
import type { DatabaseSync } from "node:sqlite";
import type { Capabilities } from "../../web/src/api/types.ts";
import { allCompanions, repoCompanions, type CompanionSpec } from "../repo-build.ts";
import { ownerOf } from "../owners.ts";
import { takesPrivate } from "./private.ts";

/** A companion as a task row stores it: the commit is null when no head was known at creation. */
export type TaskCompanion = { repo: string; owner: string; env: string; sha: string | null; private?: true };
/** What a worker gets: no `sha` and a `note` when the coordinator cannot hand the companion to it. */
export type ClaimedCompanion = { repo: string; owner: string; env: string; sha?: string; private?: true; note?: string };

export const HEAD_TTL_MS = 5 * 60_000;
/** A failed look-up is tried again after this long, so a broken companion does not cost a GitHub call per claim. */
export const FAILED_TTL_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/;

type Head = { sha: string | null; private: boolean; at: string; error?: string };
const headKey = (owner: string, repo: string): string => `companion_head:${owner.toLowerCase()}/${repo}`;

export function knownHead(db: DatabaseSync, owner: string, repo: string): Head | null {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(headKey(owner, repo)) as { value: string } | undefined;
  if (!row) return null;
  try {
    const h = JSON.parse(row.value) as Head;
    return typeof h.at === "string" ? { sha: typeof h.sha === "string" && SHA.test(h.sha) ? h.sha : null, private: h.private === true, at: h.at, ...(h.error ? { error: h.error } : {}) } : null;
  } catch {
    return null;
  }
}

function storeHead(db: DatabaseSync, owner: string, repo: string, h: Head): void {
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(headKey(owner, repo), JSON.stringify(h));
}

/** The default-branch head and visibility of `owner/repo` on GitHub; throws when it cannot be read. */
export type HeadResolver = (owner: string, repo: string) => Promise<{ sha: string; private: boolean }>;

export const ghHead: HeadResolver = async (owner, repo) => {
  const { ghApi } = await import("../verify/crates.ts");
  const visibility = (await ghApi(`repos/${owner}/${repo}`, ".visibility")).trim().toLowerCase();
  const sha = (await ghApi(`repos/${owner}/${repo}/commits/HEAD`, ".sha")).trim();
  if (!SHA.test(sha)) throw new Error(`no commit id for ${owner}/${repo}`);
  return { sha, private: visibility !== "public" };
};

const fresh = (h: Head | null, nowMs: number): boolean => !!h && nowMs - Date.parse(h.at) < (h.sha ? HEAD_TTL_MS : FAILED_TTL_MS);

/**
 * Resolves the heads of every configured companion whose stored head is older than its TTL (or of `only`'s companions).
 * Never throws: a failure is stored (and the old commit kept), and the next refresh after FAILED_TTL_MS tries again.
 */
export function refreshCompanionHeads(db: DatabaseSync, o: { resolve?: HeadResolver; nowMs?: number; only?: string; force?: boolean } = {}): Promise<void> {
  // Claims of several workers at once share one read.
  if (!o.only && !o.force && !o.resolve) return (running ??= refresh(db, o).finally(() => { running = null; }));
  return refresh(db, o);
}
let running: Promise<void> | null = null;

async function refresh(db: DatabaseSync, o: { resolve?: HeadResolver; nowMs?: number; only?: string; force?: boolean }): Promise<void> {
  const resolve = o.resolve ?? ghHead;
  const nowMs = o.nowMs ?? Date.now();
  const wanted = new Map<string, { owner: string; repo: string }>();
  for (const r of o.only ? [{ repo: o.only, companions: repoCompanions(db, o.only) }] : allCompanions(db)) {
    const owner = ownerOf(r.repo);
    for (const c of r.companions) wanted.set(headKey(owner, c.repo), { owner, repo: c.repo });
  }
  for (const { owner, repo } of wanted.values()) {
    const old = knownHead(db, owner, repo);
    if (!o.force && fresh(old, nowMs)) continue;
    const at = new Date(nowMs).toISOString();
    try {
      const h = await resolve(owner, repo);
      storeHead(db, owner, repo, { sha: h.sha, private: h.private, at });
    } catch (e) {
      // The last known commit stays usable; the error shows on the CLI.
      storeHead(db, owner, repo, { sha: old?.sha ?? null, private: old?.private ?? true, at, error: String((e as Error).message ?? e).slice(0, 200) });
    }
  }
}

/** The companions a new task of `repo` records: its setting with the heads known now (owner: the repo's owner). */
export function companionsForTask(db: DatabaseSync, repo: string, specs: CompanionSpec[] = repoCompanions(db, repo)): TaskCompanion[] {
  const owner = ownerOf(repo);
  return specs.map((c) => {
    const h = knownHead(db, owner, c.repo);
    // Unknown visibility counts as private: only an environment that may hold the owner's token gets it.
    return { repo: c.repo, owner, env: c.env, sha: h?.sha ?? null, ...(h && !h.private ? {} : { private: true as const }) };
  });
}

/** Steps whose containers get the companions: the ones that run tests. */
export const COMPANION_STEP = /^(?:test(?: \d+)?|tests|regression)$/;

/**
 * The companions a claimed task carries to this environment. A commit still unknown is filled from the stored head and
 * written back to the row, so a retry gets the same one. A private companion an environment may not take is sent as a note.
 */
export function claimCompanions(db: DatabaseSync, taskId: number, stored: TaskCompanion[], env: { private_code: number }, caps: Pick<Capabilities, "privateOwner"> | null): ClaimedCompanion[] {
  let changed = false;
  const filled = stored.map((c) => {
    if (c.sha) return c;
    const h = knownHead(db, c.owner, c.repo);
    if (!h?.sha) return c;
    changed = true;
    const { private: _was, ...rest } = c;
    return { ...rest, sha: h.sha, ...(h.private ? { private: true as const } : {}) };
  });
  if (changed) db.prepare("UPDATE build_tasks SET companions = ? WHERE id = ?").run(JSON.stringify(filled), taskId);
  return filled.map((c): ClaimedCompanion => {
    const base = { repo: c.repo, owner: c.owner, env: c.env, ...(c.private ? { private: true as const } : {}) };
    if (!c.sha) return { ...base, note: `no commit of ${c.owner}/${c.repo} was known when the task was handed out` };
    if (c.private && !takesPrivate(env, caps, c.owner)) return { ...base, note: `${c.owner}/${c.repo} is private and this environment does not take ${c.owner}'s private code` };
    return { ...base, sha: c.sha };
  });
}
