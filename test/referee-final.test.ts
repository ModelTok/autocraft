import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/classify/settled.ts";

const basal = { label: "bug", flags: [], top: 0.5, nd: 0.1 };
const haiku = { label: "new feature", flags: [] };

test("a sure referee settles the label with no flag", () => {
  const s = settle(basal, haiku, { label: "bug", sure: true, reason: "" });
  assert.deepEqual([s.status, s.label, s.flags], ["settled", "bug", []]);
});

test("an unsure first referee leaves the disagreement for the next one", () => {
  assert.equal(settle(basal, haiku, { label: "bug", sure: false, reason: "" }).status, "disagree");
});

test("an unsure final referee settles the label and flags a scope decision", () => {
  const s = settle(basal, haiku, { label: "new feature", sure: false, reason: "", final: true });
  assert.deepEqual([s.status, s.label, s.flags], ["settled", "new feature", ["needs decision"]]);
});

test("three failed Opus calls end the referee's turn like an unsure Opus", () => {
  const s = settle(basal, haiku, { label: "bug", sure: false, reason: "", failures: 3 });
  assert.deepEqual([s.status, s.flags], ["settled", ["needs decision"]]);
  assert.equal(settle(basal, haiku, { label: "bug", sure: false, reason: "", failures: 2 }).status, "disagree");
});
