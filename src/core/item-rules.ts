// Constants and pure helpers of the triage rules for issues and PRs, shared by decide-item.ts and the loader. Its one import,
// labels/set.ts, has none of its own. Each constant mirrors the old module named in its comment; test/decide-item.test.ts checks they stay equal.
import { githubFlagLabel, githubTypeLabel, isTypeLabel, NEEDS_DECISION, sameType } from "../labels/set.ts";

/** Labels that make a disagreement a scope call (decide/select.ts SCOPE_LABELS). */
export const SCOPE_LABELS = ["new feature", "enhancement"];
export const isScope = (l: string | null): boolean => l !== null && SCOPE_LABELS.includes(l);

/** Type ids, exclusive on an item (labels/set.ts TYPE_LABELS). */
export const TYPE_LABEL_NAMES = ["bug", "enhancement", "new feature", "performance", "chore", "documentation", "gtm", "task"];

/** Opus recommendation for a scope decision: tries and the wait after a failure (decide/prepare.ts). */
export const RECOMMEND_MAX_FAILURES = 3;
export const RECOMMEND_RETRY_MS = 60 * 60_000;

/** Opus answers the label referee may fail to give for an item before the item goes to an operator as a scope decision; a failed item is asked again after RECOMMEND_RETRY_MS. */
export const REFEREE_MAX_FAILURES = 3;

/**
 * The GitHub labels a pass would add to an item of `kind`: its settled type's GitHub label (bug is "bugfix" on a PR) and the
 * security and needs-owner flags. Null when nothing is settled or the item already has another type label (it is left alone).
 */
export function labelsToAdd(settled: { type: string; security: boolean; needsDecision: boolean } | null, kind: string, existing: string[]): string[] | null {
  if (!settled) return null;
  const type = githubTypeLabel(settled.type, kind);
  if (existing.some((l) => isTypeLabel(l) && !sameType(l, type))) return null;
  const want = [type, ...(settled.security ? ["security"] : []), ...(settled.needsDecision ? [githubFlagLabel(NEEDS_DECISION)] : [])];
  return want.filter((w) => !existing.some((e) => sameType(e, w)));
}

/** The previous label pass (its "labeled" stage note, "added: a, b") already added every label in `add`. */
export function alreadyLabeled(note: string | null, add: string[]): boolean {
  if (!note) return false;
  const done = note.replace(/^added: /, "").split(", ");
  return add.every((a) => done.some((d) => d.toLowerCase() === a.toLowerCase()));
}
