// The basal model is served by basal (github.com/rkinas/basal, Apache-2.0): a self-hosted `basal-serve` that answers typed
// questions about a state over HTTP (`POST /v1/systemone`), with a calibrated probability for each allowed answer.
// The request is the one the prompts in src/prompts register (`state` and named `choice` / `noul` questions); the answer
// has the same `answers` and `usage` fields the basal steps read.
//
// - AUTOCRAFT_BASAL_URL: the server's base URL, default http://127.0.0.1:8000.
// - AUTOCRAFT_BASAL_KEY_FILE: optional; a file holding the key of a server started with `--api-keys`, sent as a bearer
//   token. Never logged, never stored.
import { readFileSync } from "node:fs";
import { envVar } from "../env.ts";

export const BASAL_DEFAULT_URL = "http://127.0.0.1:8000";

/**
 * A finished basal request, in the shape of a finished process so the basal steps read it as before: `code` 0 with the
 * response body on `stdout`; 1 for an HTTP error (`status` says which); -1 when the server could not be reached
 * (`unreachable` says why) or the key file could not be read; null when no answer came within the time limit.
 */
export type BasalReply = { code: number | null; stdout: string; stderr: string; status?: number; unreachable?: string };

/** The `/v1/systemone` endpoint of the configured server. */
export function basalEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const base = (envVar("BASAL_URL", env) ?? "").trim() || BASAL_DEFAULT_URL;
  return `${base.replace(/\/+$/, "")}/v1/systemone`;
}

/** The key from AUTOCRAFT_BASAL_KEY_FILE, or null when the variable is not set. */
function basalKey(env: NodeJS.ProcessEnv): string | null {
  const file = envVar("BASAL_KEY_FILE", env);
  if (!file) return null;
  const key = readFileSync(file, "utf8").trim();
  if (!key) throw new Error("the basal key file is empty");
  return key;
}

/** The server's error text: basal answers `{"error": "...", "code": "..."}`, or with `--error-format openai` `{"error": {"message": ...}}`. */
function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown; code?: unknown };
    const e = j.error;
    const msg = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : "";
    return [typeof j.code === "string" ? j.code : "", msg].filter(Boolean).join(": ").slice(0, 300);
  } catch { return body.replace(/\s+/g, " ").slice(0, 300); }
}

/** Sends one request body (JSON text) to basal-serve and waits at most `timeoutMs` for the answer. Never throws. */
export async function basalAsk(body: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<BasalReply> {
  let key: string | null;
  try { key = basalKey(env); } catch (e) {
    return { code: -1, stdout: "", stderr: `basal: cannot read AUTOCRAFT_BASAL_KEY_FILE: ${String((e as Error).message ?? e)}` };
  }
  const url = basalEndpoint(env);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === "TimeoutError" || err.name === "AbortError") return { code: null, stdout: "", stderr: `basal: no answer within ${Math.round(timeoutMs / 1000)} s` };
    const why = err.cause?.code ?? err.cause?.message ?? err.message ?? String(e);
    return { code: -1, stdout: "", stderr: `basal: cannot reach ${url}: ${why}`, unreachable: why };
  }
  let text: string;
  try { text = await res.text(); } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") return { code: null, stdout: "", stderr: `basal: no answer within ${Math.round(timeoutMs / 1000)} s` };
    return { code: 1, stdout: "", stderr: `basal: HTTP ${res.status}: the answer could not be read: ${err.message}`, status: res.status };
  }
  if (res.ok) return { code: 0, stdout: text, stderr: "", status: res.status };
  return { code: 1, stdout: text, stderr: `basal: HTTP ${res.status}: ${errorText(text)}`, status: res.status };
}
