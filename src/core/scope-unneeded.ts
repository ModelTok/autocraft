// Open scope questions that no reason asks any more: an item the team wrote whose only reason was the classifier's
// "needs decision" flag (decide-item.ts scopeReason). The mirror pass withdraws them, so they leave the Decide stage
// without a person answering "Is this wanted?" about work the team asked for itself.
import type { DatabaseSync } from "node:sqlite";
import { withdrawScopeQuestions } from "../merge/withdraw.ts";
import { scopeReason } from "./decide-item.ts";
import { loadItemFacts } from "./issue-facts.ts";

export const TEAM_SCOPE_NOTE = "the team wrote this item, so it is wanted; the classifier's \"needs decision\" flag asks no scope question of it";

/** The open single-item scope questions of team-written items that scopeReason no longer gives a reason for. */
export function unneededScopeQuestions(db: DatabaseSync): { id: string; repo: string; number: number }[] {
  const open = db.prepare(`SELECT id, repo, number FROM decisions WHERE answer IS NULL AND kind = 'scope' AND number IS NOT NULL
    AND id = repo || '#' || number || ':scope'`).all() as { id: string; repo: string; number: number }[];
  if (!open.length) return [];
  const facts = new Map(loadItemFacts(db, { refs: open.map((d) => `${d.repo}#${d.number}`) }).map((f) => [`${f.repo}#${f.number}`, f]));
  return open.filter((d) => {
    const f = facts.get(`${d.repo}#${d.number}`);
    return !!f && f.open && f.teamAuthor && scopeReason(f) === null;
  });
}

/** Withdraws them; returns how many. */
export function withdrawUnneededScope(db: DatabaseSync, at: string): number {
  return withdrawScopeQuestions(db, unneededScopeQuestions(db), TEAM_SCOPE_NOTE, at);
}
