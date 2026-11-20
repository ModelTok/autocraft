// The default owner: ModelTok in this fork, and `AUTOCRAFT_OWNER` overrides it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/** Loads src/owners.ts in a fresh process whose AUTOCRAFT_OWNER is `owner` (unset when null) and returns what it reports. */
function owners(owner: string | null): { def: string; lower: boolean; other: boolean; bare: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTOCRAFT_OWNER;
  if (owner !== null) env.AUTOCRAFT_OWNER = owner;
  const code = `
    const o = await import(${JSON.stringify(new URL("../src/owners.ts", import.meta.url).href)});
    console.log(JSON.stringify({ def: o.DEFAULT_OWNER, lower: o.isDefaultOwner("modeltok"), other: o.isDefaultOwner("acme"), bare: o.splitSlug("poka").owner }));`;
  return JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env, encoding: "utf8" }));
}

test("the default owner is ModelTok, compared without regard to case, and a bare name means it", () => {
  const r = owners(null);
  assert.equal(r.def, "ModelTok");
  assert.equal(r.lower, true);
  assert.equal(r.other, false);
  assert.equal(r.bare, "ModelTok");
});

test("AUTOCRAFT_OWNER overrides the default owner", () => {
  const r = owners("acme");
  assert.equal(r.def, "acme");
  assert.equal(r.other, true);
  assert.equal(r.lower, false);
});

test("an AUTOCRAFT_OWNER that is not a GitHub owner name is ignored", () => {
  assert.equal(owners("not/an owner").def, "ModelTok");
  assert.equal(owners("").def, "ModelTok");
});
