// Where a decision's link opens: its item's page, or the decision's own page when it has no item.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionPath } from "../web/src/lib/links.ts";

test("an item's decision opens the item page at its block", () => {
  assert.equal(decisionPath({ id: "poka#12:scope", repo: "poka", number: 12 }), "/items/poka/12#decision-poka%2312%3Ascope");
});

test("a repo-level question (number 0, a red default branch) opens its own page, not a missing item #0", () => {
  const id = "EnergyPlusMojo:main-fix:badge@be794a2324b6ef67954ae3d33b3a88cdc9be50a7";
  assert.equal(decisionPath({ id, repo: "EnergyPlusMojo", number: 0 }), `/needs/decisions/${encodeURIComponent(id)}`);
});

test("a decision with no number and no items opens its own page; a batch opens its first item", () => {
  assert.equal(decisionPath({ id: "x", repo: "poka", number: null }), "/needs/decisions/x");
  assert.equal(decisionPath({ id: "b", repo: "poka", number: null, items: [{ repo: "poka", number: 7 }] }), "/items/poka/7#decision-b");
});
