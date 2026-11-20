// A repo's one-line scope: the maintainers' own description of what the repository is for. Every classifier input
// carries it as `project` (classify/parse.ts itemInput), so basal, which sees only the item, can judge whether a
// request is in scope. Stored in settings under `repo_scope:<repo>`; set with `autocraft-server repos scope`.
// It is not part of the classifier hash (itemhash.ts), so editing it does not make every item reclassify.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "./dash/audit.ts";

/** The longest scope line kept: one line, not a document. */
export const SCOPE_MAX = 300;

const key = (repo: string) => `repo_scope:${repo}`;

/** The repo's scope line, or undefined when none is set. */
export function repoScope(db: DatabaseSync, repo: string): string | undefined {
  const row = db.prepare("SELECT value FROM main.settings WHERE key = ?").get(key(repo)) as { value: string | null } | undefined;
  const v = row?.value?.trim();
  return v ? v : undefined;
}

/** Every set scope line by repo, for loaders that read many items at once. */
export function repoScopes(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT key, value FROM main.settings WHERE key LIKE 'repo_scope:%'").all() as { key: string; value: string | null }[];
  return new Map(rows.flatMap((r) => (r.value?.trim() ? [[r.key.slice("repo_scope:".length), r.value.trim()] as [string, string]] : [])));
}

/** Sets the repo's scope line (whitespace collapsed to one line), or clears it with null. Returns false when nothing changed. */
export function setRepoScope(db: DatabaseSync, by: string, repo: string, text: string | null): boolean {
  const line = text === null ? null : text.replace(/\s+/g, " ").trim();
  if (line !== null && !line) throw new Error("the scope line is empty; use --clear to remove it");
  if (line !== null && line.length > SCOPE_MAX) throw new Error(`the scope line is ${line.length} characters; keep it to ${SCOPE_MAX}`);
  if ((repoScope(db, repo) ?? null) === line) return false;
  if (line === null) db.prepare("DELETE FROM main.settings WHERE key = ?").run(key(repo));
  else db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key(repo), line);
  audit(db, by, line === null ? "repo-scope-clear" : "repo-scope-set", repo, line === null ? undefined : { scope: line });
  return true;
}
