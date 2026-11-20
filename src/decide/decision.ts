// The scope decision for one candidate: question, options, recommendation and
// facts. The summary is added by the caller.
import type { DatabaseSync } from "node:sqlite";
import { STATS_SQL, TIER_LABEL, tierKey, tiersOf } from "../whitelist.ts";
import type { Candidate } from "./select.ts";

/**
 * Answer keys of a scope decision. The step that applies answers reads these
 * keys (never free text):
 * - take: in scope for core; keep open, PRs go to review.
 * - close: out of scope; close with a short reason.
 * - need-info: ask how it should behave (docs, roadmap or upstream) before deciding.
 * Answers stored with the keys small-extra and plugin, which the question offered
 * before the label set changed, still load: core/rules.ts LEGACY_SCOPE_ANSWERS
 * reads small-extra as take and plugin as close.
 */
export const SCOPE_OPTIONS = {
  take: { key: "take", label: "Wanted in core", hint: "In the project's scope (docs, roadmap or upstream). Keep open; PRs go to review." },
  close: { key: "close", label: "Out of scope", hint: "Not wanted. Close with a short reason." },
  "need-info": { key: "need-info", label: "Check the scope", hint: "Ask how it should behave (docs, roadmap or upstream) before deciding." },
} as const;
export type OptionKey = keyof typeof SCOPE_OPTIONS;

type Shape = { question: string; options: OptionKey[] };

/** Question and options by the settled label, or by the two labels in a disagreement. The decision asks because the item needs a maintainer's call, so no option is recommended here (see prepare.ts). */
export function shapeOf(c: Candidate): Shape {
  const s = c.settled;
  const options: OptionKey[] = ["take", "need-info", "close"];
  if (c.reason === "scope-disagreement") return { question: "Is this in the project's scope, and do we want it in core?", options };
  switch (s.label) {
    case "new feature": case "enhancement": return { question: "Is this wanted in core?", options };
    case "bug": return { question: "Is this change in behaviour wanted?", options };
    default: return { question: "Is this wanted?", options };
  }
}

export const decisionId = (c: { repo: string; number: number }): string => `${c.repo}#${c.number}:scope`;

type ItemRow = {
  kind: "pr" | "issue"; author: string | null; created_at: string | null; labels: string | null;
  additions: number | null; deletions: number | null; changed_files: number | null; comments_count: number | null;
  closing_issues: string | null; author_id: number | null;
};

const list = (s: string | null): unknown[] => {
  try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; }
};

function authorFact(db: DatabaseSync, login: string | null, id: number | null): string {
  if (!login) return "author: unknown (deleted account)";
  const s = db.prepare(`${STATS_SQL} AND author = ?`).get(login) as { merged: number | null; closed: number | null };
  const merged = s.merged ?? 0, closed = s.closed ?? 0;
  const tier = tiersOf(db, [{ login, id }]).get(tierKey({ login, id })) ?? "not";
  return `author: ${login}, ${TIER_LABEL[tier]} (${merged} merged PR${merged === 1 ? "" : "s"}, ${closed} closed unmerged)`;
}

/** Up to five facts: what and how big, author and tier, classifiers, GitHub labels, linked items. */
export function factsOf(db: DatabaseSync, c: Candidate, now = Date.now()): string[] {
  const i = db.prepare(`SELECT kind, author, created_at, labels, additions, deletions, changed_files, comments_count, closing_issues, author_id
    FROM items WHERE repo = ? AND number = ?`).get(c.repo, c.number) as ItemRow;
  const days = i.created_at ? Math.max(0, Math.floor((now - Date.parse(i.created_at)) / 86_400_000)) : null;
  const age = days === null ? "" : days === 0 ? ", opened today" : `, opened ${days} day${days === 1 ? "" : "s"} ago`;
  const comments = i.comments_count ?? 0;
  const size = i.kind === "pr" ? `, +${i.additions ?? 0} −${i.deletions ?? 0} in ${i.changed_files ?? 0} file${i.changed_files === 1 ? "" : "s"}` : "";
  const facts = [`${c.repo} ${i.kind === "pr" ? "PR" : "issue"}${size}${age}, ${comments} comment${comments === 1 ? "" : "s"}`, authorFact(db, i.author, i.author_id)];
  const s = c.settled;
  const conf = s.confidence === null ? "" : ` (${s.confidence.toFixed(2)})`;
  facts.push(`Basal: ${s.basalLabel ?? "none"}${conf}; Haiku: ${s.haikuLabel ?? "not asked"}${s.status === "settled" ? `; settled: ${s.label}` : ""}`);
  const labels = list(i.labels).filter((x): x is string => typeof x === "string");
  if (labels.length) facts.push(`GitHub labels: ${labels.join(", ")}`);
  const linked: string[] = [];
  const fixes = list(i.closing_issues).filter((n): n is number => typeof n === "number");
  if (fixes.length) linked.push(`fixes ${fixes.map((n) => `#${n}`).join(", ")}`);
  if (i.kind === "issue") {
    const prs = db.prepare(`SELECT number FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN'
      AND EXISTS (SELECT 1 FROM json_each(closing_issues) WHERE value = ?) ORDER BY number`).all(c.repo, c.number) as { number: number }[];
    if (prs.length) linked.push(`open PRs that fix it: ${prs.map((p) => `#${p.number}`).join(", ")}`);
  }
  const dups = db.prepare(`SELECT DISTINCT dup_of FROM classifications WHERE repo = ? AND number = ? AND dup_of IS NOT NULL`).all(c.repo, c.number) as { dup_of: number }[];
  if (dups.length) linked.push(`possible duplicate of ${dups.map((d) => `#${d.dup_of}`).join(", ")}`);
  if (linked.length) facts.push(linked.join("; "));
  return facts.slice(0, 5);
}

export function contextOf(c: Candidate): string {
  const s = c.settled;
  if (c.reason === "scope-disagreement") return `Basal says ${s.basalLabel}, Haiku says ${s.haikuLabel}: a scope call either way.`;
  return `The classifiers settled on ${s.label} and flagged it as needing a maintainer's call.`;
}

/** The question in the shape `ask()` takes; summary fields are added by the caller. */
export type Question = Record<string, unknown> & { id: string; repo: string; number: number };

export function buildDecision(db: DatabaseSync, c: Candidate, now = Date.now()): Question {
  const shape = shapeOf(c);
  return {
    id: decisionId(c), kind: "scope", repo: c.repo, number: c.number,
    question: shape.question, context: contextOf(c), facts: factsOf(db, c, now),
    options: shape.options.map((k) => ({ ...SCOPE_OPTIONS[k] })), recommended: null,
    asked_by: "decide",
  };
}
