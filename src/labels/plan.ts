// Which labels each open item should get. Reads the mirror and classifications only.
import type { DatabaseSync } from "node:sqlite";
import { backlogHeldSql, notOwnIntegrationSql } from "../dupes/held.ts";
import { forRun, settleRows, type ClsRow } from "./settled.ts";
import { githubFlagLabel, githubTypeLabel, isTypeLabel, NEEDS_DECISION, sameType } from "./set.ts";
import { pilotSql } from "../pilot.ts";
import { quietFixPrs } from "../core/facts.ts";

export type PlanStatus = "add" | "already" | "unsettled" | "conflict";
export type PlanRow = {
  number: number; kind: string; url: string; status: PlanStatus;
  settled: string; existing: string[]; add: string[]; note: string;
};
export type PlanCounts = { toAdd: number; already: number; unsettled: number; conflicts: number };

export function planLabels(db: DatabaseSync, repo: string, runId?: string): PlanRow[] {
  const items = db.prepare(`SELECT number, kind, url, labels FROM main.items i WHERE repo = ? AND state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")} AND NOT ${backlogHeldSql("i")} ORDER BY number`).all(repo) as
    { number: number; kind: string; url: string | null; labels: string | null }[];
  const byItem = new Map<number, ClsRow[]>();
  const cls = db.prepare(`SELECT number, classifier, run_id, at, type_label, flags, probs, input_hash FROM main.classifications WHERE repo = ?
    ${runId ? "AND run_id = ?" : ""} ORDER BY at DESC`).all(...(runId ? [repo, runId] : [repo])) as (ClsRow & { number: number })[];
  for (const c of cls) (byItem.get(c.number) ?? byItem.set(c.number, []).get(c.number)!).push(c);

  const quiet = quietFixPrs(db, repo);
  return items.map((it) => {
    let existing: string[] = [];
    try {
      existing = (JSON.parse(it.labels ?? "[]") as unknown[]).map(String);
    } catch { /* unreadable labels count as none */ }
    const row = { number: it.number, kind: it.kind, url: it.url ?? "", settled: "", existing, add: [] as string[], note: "" };
    const s0 = settleRows(forRun(byItem.get(it.number) ?? [], runId));
    const s = s0 && quiet.has(`${repo}#${it.number}`) ? { ...s0, security: false } : s0;
    if (!s) return { ...row, status: "unsettled" as const };
    row.settled = s.type;
    // The GitHub name of the type (bug is "bugfix" on a PR); an item with another type label is left alone.
    const type = githubTypeLabel(s.type, it.kind);
    const other = existing.filter((l) => isTypeLabel(l) && !sameType(l, type));
    if (other.length) return { ...row, status: "conflict" as const, note: `has ${other.join(", ")}` };
    const want = [type, ...(s.security ? ["security"] : []), ...(s.needsDecision ? [githubFlagLabel(NEEDS_DECISION)] : [])];
    const add = want.filter((w) => !existing.some((e) => sameType(e, w)));
    return { ...row, add, status: add.length ? ("add" as const) : ("already" as const) };
  });
}

export function countPlan(rows: PlanRow[]): PlanCounts {
  const n = (s: PlanStatus) => rows.filter((r) => r.status === s).length;
  return { toAdd: n("add"), already: n("already"), unsettled: n("unsettled"), conflicts: n("conflict") };
}

const csvCell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
export function planCsv(repo: string, rows: PlanRow[]): string {
  const lines = [["repo", "number", "kind", "status", "settled_type", "existing_labels", "labels_to_add", "note", "url"].join(",")];
  for (const r of rows) lines.push([repo, r.number, r.kind, r.status, r.settled, r.existing.join("|"), r.add.join("|"), r.note, r.url].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
