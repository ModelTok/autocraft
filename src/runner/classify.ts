// The classify steps: Basal on every item that needs a verdict, then Haiku on the
// items basal is under 90 % sure of. When basal is unavailable (src/agents/basal-availability.ts),
// Haiku classifies the due items itself and its verdict settles them. Uses the
// classifiers in src/classify/run.ts.
//
// "Changed" means the classifier's input changed: input_hash is a hash of the
// classification scheme (labels and rules) and the item as the classifier sees
// it (title, body, size). A new scheme or an edited title or body makes the item
// due again; a new comment or label does not. Verdicts from before input_hash
// existed count as changed when the item was updated after the verdict.
import type { DatabaseSync } from "node:sqlite";
import { refOf, type Item } from "../classify/parse.ts";
import { takersFirst } from "../agents/call.ts";
import { freeSlots } from "../agents/accounts.ts";
import { basalAvailable } from "../agents/basal-availability.ts";
import { haikuBatches, runHaiku, runBasal } from "../classify/run.ts";
import { fillClassHashes } from "../itemhash.ts";
import { itemOf, plannedItems } from "../core/select-items.ts";
import type { StepContext } from "./steps.ts";
import { latestRun } from "../classify/settled.ts";
import { assignAreas, type AssignResult } from "../areas/assign.ts";

export { inputHash } from "../itemhash.ts";

// Basal's top probability from which its label stands without a second opinion.
export const SURE = 0.9;
// Area questions per classify job, not counted against its limit: bulk assignment is the areas-rescan step.
const AREAS_PER_CLASSIFY_JOB = 100;
const BASAL_CHUNK = 40, HAIKU_PER_CALL = 25;


/**
 * runBasal and runHaiku write one token_usage row per agent name (`basal-<ref>`,
 * `haiku-NN`) with INSERT OR REPLACE. Rows from earlier passes with those
 * names are renamed first so their cost stays on record.
 */
function keepUsage(db: DatabaseSync, run: string, agents: string[]): void {
  const q = db.prepare("UPDATE main.token_usage SET agent = agent || '@' || COALESCE(started_at, '') WHERE run_id = ? AND agent = ?");
  for (const a of agents) q.run(run, a);
}

/** Items sent to a model so far in this job, saved as the job's handled count. */
const sentCounter = (ctx: StepContext) => {
  let sent = 0;
  return (n: number) => ctx.handled((sent += n));
};

async function basalPass(ctx: StepContext, run: string, todo: Item[], hashes: Map<string, string>, sent: (n: number) => void): Promise<Set<string>> {
  const { db } = ctx;
  const setHash = db.prepare("UPDATE main.classifications SET input_hash = ? WHERE repo = ? AND number = ? AND classifier = 'basal' AND run_id = ? AND at >= ?");
  const done = new Set<string>();
  for (let i = 0; i < todo.length && !ctx.cancelled() && basalAvailable(db); i += BASAL_CHUNK) {
    const chunk = todo.slice(i, i + BASAL_CHUNK);
    keepUsage(db, run, chunk.map((x) => `basal-${refOf(x)}`));
    const t0 = new Date().toISOString();
    sent(chunk.length);
    await runBasal(db, run, chunk);
    for (const x of chunk) if (setHash.run(hashes.get(refOf(x))!, x.repo, x.number, run, t0).changes) done.add(refOf(x));
    ctx.progress(`Basal: ${Math.min(i + BASAL_CHUNK, todo.length)} of ${todo.length} items`);
  }
  return done;
}

/** The items the Plans send to Haiku for a second opinion in `run`: Basal is unsure of the type or of a flag and Haiku has no verdict as new as basal's. */
function haikuItems(db: DatabaseSync, run: string, limit: number): Item[] {
  return takersFirst(db, plannedItems(db, "classify", { run, bucket: "haiku" }), (p) => [p.facts.repo]).slice(0, limit).map((p) => itemOf(db, p.facts.repo, p.facts.number));
}

async function haikuPass(ctx: StepContext, run: string, todo: Item[], sent: (n: number) => void): Promise<number> {
  const { db } = ctx;
  const count = db.prepare("SELECT COUNT(*) AS n FROM classifications WHERE classifier = 'haiku' AND run_id = ? AND at >= ?");
  const t0 = new Date().toISOString();
  // A chunk holds one batch for every call the accounts can take at once (at least 4), so the calls fill the free slots.
  for (let i = 0, size = 0; i < todo.length && !ctx.cancelled(); i += size) {
    size = HAIKU_PER_CALL * Math.max(4, freeSlots(db));
    const chunk = todo.slice(i, i + size);
    keepUsage(db, run, Array.from({ length: haikuBatches(db, chunk, HAIKU_PER_CALL).length }, (_, n) => `haiku-${String(n).padStart(2, "0")}`));
    // The first call of the pass runs alone and writes the prompt cache; the rest read it. Items no Task Runner may take are not sent.
    sent(await runHaiku(db, run, chunk, HAIKU_PER_CALL, undefined, { cold: i === 0 }));
    ctx.progress(`Haiku: ${Math.min(i + size, todo.length)} of ${todo.length} items`);
  }
  return (count.get(run, t0) as { n: number }).n;
}

/**
 * Haiku classifies the items alone. Its verdict carries the item's input hash, which keeps the item from being due for basal
 * until it changes, and replaces a basal verdict of the item's earlier text. Returns the number of items Haiku answered.
 */
async function haikuOnlyPass(ctx: StepContext, run: string, items: Item[], hashes: Map<string, string>, sent: (n: number) => void): Promise<number> {
  const { db } = ctx;
  const t0 = new Date().toISOString();
  await haikuPass(ctx, run, items, sent);
  const setHash = db.prepare("UPDATE main.classifications SET input_hash = ? WHERE repo = ? AND number = ? AND classifier = 'haiku' AND run_id = ? AND at >= ?");
  // A basal row of the item's earlier text goes; one without a hash (older rows) is kept, it is current until the item changes.
  const dropStale = db.prepare("DELETE FROM main.classifications WHERE repo = ? AND number = ? AND classifier = 'basal' AND run_id = ? AND input_hash IS NOT NULL AND input_hash <> ?");
  let n = 0;
  for (const x of items) {
    if (!setHash.run(hashes.get(refOf(x))!, x.repo, x.number, run, t0).changes) continue;
    dropStale.run(x.repo, x.number, run, hashes.get(refOf(x))!);
    n++;
  }
  return n;
}

/**
 * Open items the Plans send to basal in `run`, with each due item's input hash. "all" takes only items without a verdict.
 * The hashes are stored on the item row (src/itemhash.ts), so no body is read for items that are up to date.
 */
function basalItems(db: DatabaseSync, run: string, mode: "new" | "all"): { open: number; due: Item[]; hashes: Map<string, string> } {
  fillClassHashes(db);
  const open = (db.prepare("SELECT COUNT(*) AS n FROM items i JOIN tracked_repos t ON t.name = i.repo WHERE i.state = 'OPEN'").get() as { n: number }).n;
  const hash = db.prepare("SELECT class_hash AS h FROM items WHERE repo = ? AND number = ?");
  const due: Item[] = [], hashes = new Map<string, string>();
  for (const p of plannedItems(db, "classify", { run, bucket: "basal" })) {
    if (mode === "all" && p.facts.classification.basal) continue;
    const x = itemOf(db, p.facts.repo, p.facts.number);
    due.push(x);
    hashes.set(refOf(x), (hash.get(x.repo, x.number) as { h: string }).h);
  }
  return { open, due, hashes };
}

async function pass(ctx: StepContext, run: string, mode: "new" | "all"): Promise<{ areas: AssignResult; basal: number; due: number; haiku: number; haikuDue: number; haikuAlone: number; aloneDue: number; left: number }> {
  const limit = Number(ctx.params.limit);
  ctx.usageRun(run);
  ctx.progress("Finding items to classify");
  const { open, due, hashes } = basalItems(ctx.db, run, mode);
  const todo = takersFirst(ctx.db, due, (x) => [x.repo]).slice(0, limit);
  ctx.log(`run ${run}: ${open} open items, ${due.length} due for basal, taking ${todo.length}`);
  const sent = sentCounter(ctx);
  const basalDone = await basalPass(ctx, run, todo, hashes, sent);
  // Items basal did not answer because it is unavailable go to Haiku, which settles them.
  const alone = ctx.cancelled() || basalAvailable(ctx.db) ? [] : todo.filter((x) => !basalDone.has(refOf(x)));
  const haikuAlone = alone.length ? await haikuOnlyPass(ctx, run, alone, hashes, sent) : 0;
  if (alone.length) ctx.log(`Basal unavailable: Haiku classified ${haikuAlone} of ${alone.length} items`);
  const aloneRefs = new Set(alone.map(refOf));
  const unsure = ctx.cancelled() ? [] : haikuItems(ctx.db, run, limit).filter((x) => !aloneRefs.has(refOf(x)));
  ctx.log(`Haiku: ${unsure.length} items where basal is unsure of the type (under ${SURE * 100} %) or of a flag`);
  const haiku = await haikuPass(ctx, run, unsure, sent);
  const basal = basalDone.size;
  // Items of repos with an area list that were not asked against its current version; basal's answers share the job's limit with the type pass.
  const areas = ctx.cancelled() ? { due: 0, basal: 0, haiku: 0, none: 0, left: 0 } : await assignAreas(ctx.db, { limit: Math.min(limit, AREAS_PER_CLASSIFY_JOB), usageRun: run, cancelled: ctx.cancelled, progress: ctx.progress, log: ctx.log });
  return { areas, basal, due: due.length, haiku, haikuDue: unsure.length, haikuAlone, aloneDue: alone.length, left: due.length - basal - haikuAlone };
}

const areaNote = (r: { areas: AssignResult }): string => (r.areas.due ? ` Areas: ${r.areas.basal} by basal, ${r.areas.haiku} by Haiku of ${r.areas.due} items asked.` : "");

const aloneNote = (r: { haikuAlone: number; aloneDue: number }): string => (r.aloneDue ? `Basal unavailable: Haiku classified ${r.haikuAlone} items. ` : "");

export async function classifyNew(ctx: StepContext): Promise<string> {
  const run = latestRun(ctx.db);
  if (!run) throw new Error("There is no classification run yet; start a classification pass first.");
  const r = await pass(ctx, run, "new");
  if (!r.due && !r.haikuDue && !r.areas.due) return `Nothing to classify in run ${run}.`;
  return `Run ${run}: ${aloneNote(r)}basal classified ${r.basal} of ${r.due} new or changed items${r.left ? ` (${r.left} left)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}`;
}

export async function classifyAll(ctx: StepContext): Promise<string> {
  const run = String(ctx.params.run);
  const r = await pass(ctx, run, "all");
  const complete = r.left === 0 && !ctx.cancelled();
  if (complete) ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('classify_run', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(run);
  return `Run ${run}: ${aloneNote(r)}basal classified ${r.basal} of ${r.due} items without a verdict${r.left ? ` (${r.left} left; start it again to continue)` : ""}; Haiku gave a second opinion on ${r.haiku} of ${r.haikuDue}.${areaNote(r)}${complete ? " The run is now the current one." : ""}`;
}
