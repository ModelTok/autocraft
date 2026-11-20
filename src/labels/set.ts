// The label set AutoCraft writes to GitHub. Type labels are exclusive (one per item); flags sit next to the type.
// The names are the ones the tracked repos already use on GitHub (bug, enhancement, chore, documentation,
// needs-owner, ...), so `labels ensure` creates only the ones a repo lacks and never a near-duplicate.
// Internally a classification stores a type id (classify/rules.ts LABELS) and flag names; githubTypeLabel and
// githubFlagLabel turn them into the GitHub label names.

export type LabelDef = { name: string; color: string; description: string };

/** One per type id, in the order of classify/rules.ts LABELS. The name is the type id and, except bug on a PR, the GitHub label. */
export const TYPE_LABELS: LabelDef[] = [
  { name: "bug", color: "d73a4a", description: "Something is broken: wrong result, crash, hang or data loss" },
  { name: "enhancement", color: "a2eeef", description: "Makes an existing feature better or extends it" },
  { name: "new feature", color: "0e8a16", description: "Something the product does not do yet, in the project's scope" },
  { name: "performance", color: "fbca04", description: "Same behaviour, faster, smaller or lighter" },
  { name: "chore", color: "bfd4f2", description: "Tests, CI, build, packaging, release, tooling, dependency bumps" },
  { name: "documentation", color: "0075ca", description: "Docs only" },
  { name: "gtm", color: "f9d0c4", description: "Go to market: marketing, launch, pricing, sales, outreach" },
  { name: "task", color: "d4c5f9", description: "No code or product change: a plan, research, an audit or an organisational to-do" },
];

/** The GitHub label of type bug on a pull request (an issue gets "bug"). */
export const BUGFIX_LABEL: LabelDef = { name: "bugfix", color: "d73a4a", description: "Fixes something that is broken: wrong result, crash, hang or data loss" };

/** The internal name of the needs-decision flag, as classifications store it. */
export const NEEDS_DECISION = "needs decision";

export const FLAG_LABELS: LabelDef[] = [
  { name: "security", color: "b60205", description: "A real security hole is fixed, or security hardening" },
  { name: "needs-owner", color: "e99695", description: "A decision only the owner can make (pricing, scope, legal, marketing)" },
];

/** Every label AutoCraft may write to GitHub, by its GitHub name. */
export const ALL_LABELS: LabelDef[] = [...TYPE_LABELS, BUGFIX_LABEL, ...FLAG_LABELS];

/** The GitHub label name of a type id on an item of `kind` ("pr" or "issue"): bug is "bugfix" on a PR, every other id is its own name. */
export function githubTypeLabel(type: string, kind: string): string {
  return type.toLowerCase() === "bug" && kind === "pr" ? BUGFIX_LABEL.name : type;
}

/** The GitHub label name of a flag: the needs-decision flag is "needs-owner", security is itself. */
export function githubFlagLabel(flag: string): string {
  return flag.toLowerCase() === NEEDS_DECISION ? "needs-owner" : flag;
}

const lower = (s: string) => s.toLowerCase();
const TYPE_SET = new Set([...TYPE_LABELS, BUGFIX_LABEL].map((l) => lower(l.name)));

/** A type label by GitHub name or type id (bugfix counts: it is bug's PR label). */
export const isTypeLabel = (name: string): boolean => TYPE_SET.has(lower(name));
export const sameLabel = (a: string, b: string): boolean => lower(a) === lower(b);
const BUG_NAMES = new Set(["bug", BUGFIX_LABEL.name]);
/** Two type labels of the same type: equal names, or bug and bugfix (an issue AutoCraft labelled "bugfix" before the split needs no "bug" too). */
export const sameType = (a: string, b: string): boolean => sameLabel(a, b) || (BUG_NAMES.has(lower(a)) && BUG_NAMES.has(lower(b)));
