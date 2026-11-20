// Whether basal can be used right now. The basal model is served by basal-serve (src/agents/basal.ts). When it cannot be used,
// Haiku does basal's work (classify, priority, duplicates).
//
// - Switched off (settings.basal_enabled = 'no'): stays off until an operator turns it on.
// - The server cannot be reached (not running, wrong AUTOCRAFT_BASAL_URL, unreadable key file): tried again on the first
//   pass five minutes after the last failure.
// - The server refuses the key (HTTP 401 or 403): tried again on the first pass an hour after the last failure.
//
// The state is one settings row, settings.basal_unavailable, shown on the Accounts page.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";

export const BASAL_ENABLED_KEY = "basal_enabled";
export const BASAL_UNAVAILABLE_KEY = "basal_unavailable";
/** How long after the last account failure (a rejected key) the next pass tries basal again. */
export const BASAL_RETRY_MS = 60 * 60_000;
/** How long after the server was last found unreachable the next pass tries basal again. */
export const BASAL_UNREACHABLE_RETRY_MS = 5 * 60_000;

/** `missing` is the state an install before basal-serve recorded when the hosted model's command was not on PATH; it is read as `unreachable`. */
export type BasalOutage = { kind: "off" | "unreachable" | "missing" | "account"; reason: string; since: string; at: string };

const get = (db: DatabaseSync, key: string): string | undefined => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
const put = (db: DatabaseSync, key: string, value: string): void => void db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

export const basalEnabled = (db: DatabaseSync): boolean => get(db, BASAL_ENABLED_KEY) !== "no";

export function basalOutage(db: DatabaseSync): BasalOutage | null {
  try {
    const o = JSON.parse(get(db, BASAL_UNAVAILABLE_KEY) ?? "null") as BasalOutage | null;
    return o && typeof o.since === "string" && typeof o.reason === "string" ? o : null;
  } catch { return null; }
}

const clear = (db: DatabaseSync): void => void db.prepare("DELETE FROM settings WHERE key = ?").run(BASAL_UNAVAILABLE_KEY);

/** Turns basal on or off; turning it on also forgets an earlier failure so the next pass tries it. */
export function setBasalEnabled(db: DatabaseSync, on: boolean, by: string): void {
  const was = basalEnabled(db);
  put(db, BASAL_ENABLED_KEY, on ? "yes" : "no");
  if (on) clear(db);
  else put(db, BASAL_UNAVAILABLE_KEY, JSON.stringify({ kind: "off", reason: "switched off", since: new Date().toISOString(), at: new Date().toISOString() } satisfies BasalOutage));
  if (on !== was) audit(db, by, "account-change", "basal", { basalEnabled: on, was });
}

/** Whether a pass may call basal now. Also keeps the stored state in step with the switch. */
export function basalAvailable(db: DatabaseSync, nowMs: number = Date.now()): boolean {
  if (!basalEnabled(db)) {
    if (basalOutage(db)?.kind !== "off") put(db, BASAL_UNAVAILABLE_KEY, JSON.stringify({ kind: "off", reason: "switched off", since: new Date(nowMs).toISOString(), at: new Date(nowMs).toISOString() } satisfies BasalOutage));
    return false;
  }
  const o = basalOutage(db);
  if (!o) return true;
  if (o.kind === "unreachable" || o.kind === "missing") return nowMs - Date.parse(o.at) >= BASAL_UNREACHABLE_RETRY_MS;
  if (o.kind === "account") return nowMs - Date.parse(o.at) >= BASAL_RETRY_MS;
  clear(db);
  return true;
}

/** Records a failure; `since` stays at the first failure of an outage. */
export function markBasalUnavailable(db: DatabaseSync, kind: "unreachable" | "account", reason: string, nowMs: number = Date.now()): void {
  const prev = basalOutage(db);
  const at = new Date(nowMs).toISOString();
  put(db, BASAL_UNAVAILABLE_KEY, JSON.stringify({ kind, reason, since: prev?.kind === kind ? prev.since : at, at } satisfies BasalOutage));
}

/** A call that started at `startedMs` went through: an earlier outage is over. An outage recorded after the call started (by a parallel call) stays. */
export function markBasalWorking(db: DatabaseSync, startedMs: number): void {
  const o = basalOutage(db);
  if (o && o.kind !== "off" && Date.parse(o.at) < startedMs) clear(db);
}

/**
 * Whether a basal request failed because basal is unavailable (as opposed to a timeout, a server error, a model still
 * warming up (503) or a bad answer, which are retried): the server cannot be reached, or it refused the key.
 */
export function basalFailure(r: { code: number | null; stderr: string; status?: number; unreachable?: string }): { kind: "unreachable" | "account"; reason: string } | null {
  if (r.code === 0) return null;
  if (r.code === -1) return { kind: "unreachable", reason: r.unreachable ? `server unreachable (${r.unreachable})` : r.stderr.replace(/^basal: /, "").slice(0, 200) || "server unreachable" };
  if (r.status === 401) return { kind: "account", reason: "key rejected" };
  // basal-serve also answers 403 to a loopback-bound server reached under another host name (--allowed-hosts).
  if (r.status === 403) return { kind: "account", reason: "request refused (key or allowed hosts)" };
  return null;
}
