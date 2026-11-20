// In the user-local mode, duplicate pairs of a repo no Task Runner takes are not sent to basal, and pairs whose Haiku batch no
// Task Runner took do not count as handled, so the dupes job ends idle and the planner parks it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VectorIndex } from "../src/embed/vectors.ts";
import { checkPairs, type PairKey } from "../src/dupes/check.ts";
import { runDupes } from "../src/dupes/index.ts";
import { fillEmbedHashes } from "../src/itemhash.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { T0, world } from "./world-db.ts";

test("pairs of a repo no Task Runner takes are neither sent to basal nor counted as handled", async () => {
  const w = world().repo().issue(1, { title: "crash on open" }).issue(2, { title: "crashes when opening" });
  fillEmbedHashes(w.db);
  const hash = (n: number) => (w.db.prepare("SELECT embed_hash FROM items WHERE repo = 'app' AND number = ?").get(n) as { embed_hash: string }).embed_hash;
  const key: PairKey = { repo: "app", a: 1, b: 2, a_hash: hash(1), b_hash: hash(2), similarity: 0.9 };
  w.db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, created_at) VALUES ('app', 1, 2, ?, ?, 0.9, ?)").run(key.a_hash, key.b_hash, T0);
  const index = { embedder: { id: "m" }, ready: async () => {} } as unknown as VectorIndex;
  const lines: string[] = [];
  await runDupes(w.db, { dryRun: true }, (l) => lines.push(l), { index, check: {} as never });
  assert.match(lines.join("\n"), /1 pairs to check/, "in the server-account mode the pair is checked");
  setInferenceMode(w.db, "user-local", "test");

  let basal = 0, haiku = 0;
  const handled: number[] = [];
  const check = { basal: async () => (basal++, 0.5), haiku: async () => (haiku++, null), now: () => new Date(T0) };
  const s = await runDupes(w.db, { onHandled: (n) => handled.push(n) }, () => {}, { index, check });
  assert.deepEqual([basal, haiku, s.checked, handled.length], [0, 0, 0, 0], "no pair was sent and none counted");

  // A pair basal was unsure of whose Haiku batch nobody took: Basal's call counted while it ran, the skipped batch is taken off again.
  const c = await checkPairs(w.db, [key], check, (n) => handled.push(n));
  assert.deepEqual([basal, haiku, c.unanswered], [1, 0, 1]);
  assert.equal(handled.at(-1), 0, "the job ends with nothing handled");
});
