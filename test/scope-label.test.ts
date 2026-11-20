import { test } from "node:test";
import assert from "node:assert/strict";
import { labelWithScopeAnswer, scopeAnswerOf } from "../src/core/rules.ts";

test("a scope answer settles the label two scope classifiers left open, so the PR goes to review", () => {
  assert.equal(labelWithScopeAnswer(null, "take"), "new feature");
  assert.equal(labelWithScopeAnswer("enhancement", "take"), "enhancement");
  assert.equal(labelWithScopeAnswer("bug", "take"), "bug");
  // gtm and task get no code review, so a take answer makes the PR a new feature.
  assert.equal(labelWithScopeAnswer("gtm", "take"), "new feature");
  assert.equal(labelWithScopeAnswer("enhancement", "close"), "enhancement");
  assert.equal(labelWithScopeAnswer(null, "need-info"), null);
});

test("scope answers stored with the keys the question no longer offers still load: small-extra as take, plugin as close", () => {
  assert.equal(scopeAnswerOf("small-extra"), "take");
  assert.equal(scopeAnswerOf("plugin"), "close");
  for (const k of ["take", "close", "need-info", "backlog"]) assert.equal(scopeAnswerOf(k), k);
  assert.equal(labelWithScopeAnswer(null, "small-extra"), "new feature");
  assert.equal(labelWithScopeAnswer("enhancement", "small-extra"), "enhancement");
  assert.equal(labelWithScopeAnswer(null, "plugin"), null);
});
