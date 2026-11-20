// autocraft-server accounts list | set <id> [--label X] [--enabled yes|no] [--max-concurrent N] | basal [N | on | off] | pause [show | --five-hour N --weekly N]
import { connect } from "../db.ts";
import { basalEnabled, basalOutage, setBasalEnabled } from "./basal-availability.ts";
import { AccountError, basalParallel, listAccounts, setBasalParallel, setUsagePause, updateAccount, usagePause } from "./accounts.ts";

const USAGE = `usage: autocraft-server accounts list
       autocraft-server accounts set <id> [--label <text>] [--enabled yes|no] [--max-concurrent <N>]   (N from 1 to 100)
       autocraft-server accounts basal [<N> | on | off]   basal calls at once (1 to 100), or switch basal on or off; shows the setting and whether basal is in use
       autocraft-server accounts pause [show]   usage levels (%) at which an account stops taking calls
       autocraft-server accounts pause --five-hour <N> --weekly <N>   set them (each 1 to 100)`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const pct = (n: number | null) => (n === null ? "  - " : `${String(Math.round(n)).padStart(3)}%`);

function print(): void {
  const list = listAccounts(connect());
  if (!list.length) console.log("no accounts in the box config (AUTOCRAFT_ACCOUNTS)");
  for (const a of list) {
    console.log(`${a.id.padEnd(10)} ${a.enabled ? "enabled " : "disabled"} ${a.label.padEnd(24)} ${a.running}/${a.maxConcurrent} running  5h ${pct(a.usage.fiveHourPct)}  week ${pct(a.usage.weeklyPct)}${a.pausedReason ? `  ${a.pausedReason}` : ""}`);
  }
}

// Recorded as `cli`: only someone with a shell on the host can run this.
function set(args: string[]): void {
  const [id, ...rest] = args;
  if (!id) die(USAGE);
  const input: { label?: string; enabled?: boolean; maxConcurrent?: number } = {};
  for (let i = 0; i < rest.length; i += 2) {
    const v = rest[i + 1];
    if (v === undefined) die(USAGE);
    switch (rest[i]) {
      case "--label": input.label = v; break;
      case "--enabled": if (v !== "yes" && v !== "no") die(USAGE); input.enabled = v === "yes"; break;
      case "--max-concurrent": input.maxConcurrent = Number(v); break;
      default: die(USAGE);
    }
  }
  try {
    updateAccount(connect(), id, input, "cli");
  } catch (e) {
    if (e instanceof AccountError) die(e.message);
    throw e;
  }
  print();
}

function basal(args: string[]): void {
  const db = connect();
  if (args.length > 1) die(USAGE);
  if (args[0] === "on" || args[0] === "off") setBasalEnabled(db, args[0] === "on", "cli");
  else if (args[0] !== undefined) {
    try {
      setBasalParallel(db, Number(args[0]), "cli");
    } catch (e) {
      if (e instanceof AccountError) die(e.message);
      throw e;
    }
  }
  console.log(`Basal calls at once: ${basalParallel(db)}`);
  const o = basalOutage(db);
  console.log(o ? `Basal unavailable (${o.reason}) since ${o.since}; Haiku does its work` : basalEnabled(db) ? "Basal in use" : "Basal off");
}

function pause(args: string[]): void {
  const db = connect();
  if (args.length && args[0] !== "show") {
    const cur = usagePause(db);
    const input = { fiveHour: cur.fiveHour, weekly: cur.weekly };
    for (let i = 0; i < args.length; i += 2) {
      const v = args[i + 1];
      if (v === undefined) die(USAGE);
      if (args[i] === "--five-hour") input.fiveHour = Number(v);
      else if (args[i] === "--weekly") input.weekly = Number(v);
      else die(USAGE);
    }
    try {
      setUsagePause(db, input, "cli");
    } catch (e) {
      if (e instanceof AccountError) die(e.message);
      throw e;
    }
  } else if (args.length > 1) die(USAGE);
  const p = usagePause(db);
  console.log(`Pause at: 5-hour ${p.fiveHour} %, weekly ${p.weekly} %`);
}

export const commands = {
  accounts: {
    summary: "Claude accounts: list | set <id> [--label X] [--enabled yes|no] [--max-concurrent N] | basal [N | on | off] | pause [show | --five-hour N --weekly N]",
    run: (args: string[]) => {
      if (args[0] === "list") print();
      else if (args[0] === "set") set(args.slice(1));
      // `jev` is the command's name from before basal replaced the hosted model; kept as an alias.
      else if (args[0] === "basal" || args[0] === "jev") basal(args.slice(1));
      else if (args[0] === "pause") pause(args.slice(1));
      else die(USAGE);
    },
  },
};
