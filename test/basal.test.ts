// Jev through basal-serve: the request posted, the key sent, and which failures make Jev unavailable (Haiku then does
// its work) as against those retried as before.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { basalAsk } from "../src/agents/basal.ts";
import { JEV_RETRY_MS, JEV_UNREACHABLE_RETRY_MS, jevAvailable, jevFailure, markJevUnavailable } from "../src/agents/jev.ts";
import { connect } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

type Seen = { method: string; url: string; auth: string | undefined; body: string };
let server: Server;
let base = "";
const seen: Seen[] = [];
let reply: { status: number; body: string; delayMs?: number } = { status: 200, body: "{}" };

const read = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => ok(s)); });

before(async () => {
  server = createServer(async (req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: await read(req) });
    const r = reply;
    setTimeout(() => { res.writeHead(r.status, { "content-type": "application/json" }); res.end(r.body); }, r.delayMs ?? 0);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

test("a request body is posted to /v1/systemone with the key file's key, and the answer comes back as the reply", async () => {
  const dir = mkdtempSync(join(SCRATCH, "basal-"));
  writeFileSync(join(dir, "key"), "s3cret\n");
  const answer = JSON.stringify({ model: "basal-2.0-4.5B", answers: { same: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 0 } });
  reply = { status: 200, body: answer };
  seen.length = 0;
  const body = JSON.stringify({ state: "x", questions: { same: { type: "noul", instructions: "?" } } });
  const r = await basalAsk(body, 5_000, { AUTOCRAFT_BASAL_URL: `${base}/`, AUTOCRAFT_BASAL_KEY_FILE: join(dir, "key") });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, answer);
  assert.deepEqual(seen, [{ method: "POST", url: "/v1/systemone", auth: "Bearer s3cret", body }]);
  assert.equal(jevFailure(r), null);
});

test("a refused key makes Jev unavailable; a server error, a model warming up and a bad request do not", async () => {
  const env = { AUTOCRAFT_BASAL_URL: base };
  reply = { status: 401, body: JSON.stringify({ error: "invalid API key", code: "UNAUTHORIZED" }) };
  const refused = await basalAsk("{}", 5_000, env);
  assert.equal(jevFailure(refused)?.kind, "account");
  assert.match(refused.stderr, /401/);
  for (const status of [500, 503, 422]) {
    reply = { status, body: JSON.stringify({ error: "x", code: "Y" }) };
    const r = await basalAsk("{}", 5_000, env);
    assert.notEqual(r.code, 0);
    assert.equal(jevFailure(r), null, `HTTP ${status} is retried, not an outage`);
  }
});

test("a server that cannot be reached makes Jev unavailable; one that does not answer in time does not", async () => {
  const closed = createServer();
  await new Promise<void>((ok) => closed.listen(0, "127.0.0.1", ok));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((ok) => closed.close(() => ok()));
  const down = await basalAsk("{}", 5_000, { AUTOCRAFT_BASAL_URL: `http://127.0.0.1:${port}` });
  assert.equal(jevFailure(down)?.kind, "unreachable");

  const noKey = await basalAsk("{}", 5_000, { AUTOCRAFT_BASAL_URL: base, AUTOCRAFT_BASAL_KEY_FILE: join(SCRATCH, "no-such-basal-key") });
  assert.equal(jevFailure(noKey)?.kind, "unreachable", "an unreadable key file stops calls as an unreachable server does");

  reply = { status: 200, body: "{}", delayMs: 500 };
  const slow = await basalAsk("{}", 50, { AUTOCRAFT_BASAL_URL: base });
  assert.equal(slow.code, null);
  assert.equal(jevFailure(slow), null);
});

test("an unreachable server is tried again sooner than a refused key", () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "basal-")), "t.db"));
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  markJevUnavailable(db, "unreachable", "server unreachable", t0);
  assert.equal(jevAvailable(db, t0 + 1_000), false);
  assert.equal(jevAvailable(db, t0 + JEV_UNREACHABLE_RETRY_MS), true);
  markJevUnavailable(db, "account", "key rejected", t0);
  assert.equal(jevAvailable(db, t0 + JEV_UNREACHABLE_RETRY_MS), false);
  assert.equal(jevAvailable(db, t0 + JEV_RETRY_MS), true);
  db.close();
});
