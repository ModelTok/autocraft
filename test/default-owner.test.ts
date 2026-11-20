// The default owner: ModelTok in this fork, `AUTOCRAFT_OWNER` overrides it, and nothing else names storytold.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/** Loads src/owners.ts in a fresh process whose AUTOCRAFT_OWNER is `owner` (unset when null) and returns what it reports. */
function owners(owner: string | null): { def: string; isModelTok: boolean; isStorytold: boolean; bare: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTOCRAFT_OWNER;
  if (owner !== null) env.AUTOCRAFT_OWNER = owner;
  const code = `
    const o = await import(${JSON.stringify(new URL("../src/owners.ts", import.meta.url).href)});
    console.log(JSON.stringify({ def: o.DEFAULT_OWNER, isModelTok: o.isDefaultOwner("modeltok"), isStorytold: o.isDefaultOwner("storytold"), bare: o.splitSlug("poka").owner }));`;
  return JSON.parse(execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env, encoding: "utf8" }));
}

test("the default owner is ModelTok, compared without regard to case, and a bare name means it", () => {
  const r = owners(null);
  assert.equal(r.def, "ModelTok");
  assert.equal(r.isModelTok, true);
  assert.equal(r.isStorytold, false);
  assert.equal(r.bare, "ModelTok");
});

test("AUTOCRAFT_OWNER overrides the default owner", () => {
  assert.equal(owners("acme").def, "acme");
  assert.equal(owners("storytold").isStorytold, true);
});

test("an AUTOCRAFT_OWNER that is not a GitHub owner name is ignored", () => {
  assert.equal(owners("not/an owner").def, "ModelTok");
  assert.equal(owners("").def, "ModelTok");
});
