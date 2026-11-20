// Autorepin: a pull request that depends on an unmerged pull request of another tracked repository (a craft-libs change,
// say) pins that repository's crates to a commit of its branch. Someone who may queue items on the repo comments
//
//   @<app-slug> autorepin ModelTok/craft-libs#12        (also `craft-libs#12`, the pull request's URL, or `off`)
//
// and once that pull request is merged into its default branch, this one gets a commit that sets the `rev` of every Cargo
// git dependency on that repository to the merge commit, with Cargo.lock updated to match. No model is involved:
//  - the manifests are rewritten here (src/repin/manifest.ts): only `rev` strings change;
//  - Cargo.lock is written by `cargo update --workspace` in a build environment, never on this host, and is accepted only
//    if it adds nothing but crates.io packages and the dependency at the merge commit;
//  - the commit is pushed with a lease on the head it was made on (pushRepin in src/github/write.ts), under the repo's
//    Pushes approval, after the access of the person who asked is read again.
// The outcome (pushed, failed with the reason, or dropped because the dependency's pull request closed unmerged) is a
// comment on the pull request, unless the pull request is quiet. Only reasons written here reach the comment; any other
// error is logged and the comment gives a fixed reason.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { absolute } from "../build/artifacts.ts";
import { cancelTask, createTask, getTask, TERMINAL } from "../build/tasks.ts";
import { guardRepo } from "../core/guard.ts";
import { audit } from "../dash/audit.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { HttpError } from "../dash/server/util.ts";
import { ensureAuthorWrites, type PermissionReader } from "../fixup/author-permission.ts";
import { exec as defaultExec, fixupDir, Git, type Exec } from "../fixup/git.ts";
import { longLivedOf, pushable } from "../fixup/pushable.ts";
import { boundAccess } from "../github/commands.ts";
import { commitIdentity } from "../github/identity.ts";
import { pipelineAccount } from "../github/pipeline-account.ts";
import { ghComment, pushRepin, WritePacedError } from "../github/write.ts";
import type { Querier } from "../mirror.ts";
import { ownerOf, slugOf } from "../owners.ts";
import { appPermission } from "../remote/permission.ts";
import { isFastTracked } from "../fasttrack.ts";
import { baseScopeRepos } from "../pilot.ts";
import { isQuiet } from "../security/quiet.ts";
import { settleRefusal } from "../settlers.ts";
import { fetchScript } from "../worker/rust.ts";
import { LOCK_MAX_MS, repinsDue, type RepinRow } from "./due.ts";
import { lockRefusal, repinManifest, safePath, type PrRef } from "./manifest.ts";

/** Attempts that may end unfinished (GitHub unreadable, the head moved, the lockfile task failed) before the repin is given up. */
export const MAX_TRIES = 5;
/** Cargo.toml files read in one pull request. */
const MAX_MANIFESTS = 500;
const LOCK = "Cargo.lock";
const AUDIT_LOGIN = "autorepin";
/** The reason given on GitHub for an attempt that ended on an error this module did not word. */
const UNEXPECTED = "an unexpected error stopped it (the AutoCraft log has the details)";

/**
 * The lockfile step: the manifests arrive repinned (the task's patch), Cargo brings Cargo.lock in line with them, changing
 * nothing else it does not have to (`--workspace`), and the result is the task's artifact. The environment is the fetch
 * step's (src/worker/rust.ts): no repository cargo config, no toolchain file, and nothing of the repository runs.
 */
export const LOCK_SCRIPT = fetchScript(["/usr/local/cargo/bin/cargo update --workspace", `/bin/cp ${LOCK} /out/${LOCK}`]);

const MERGE_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $n) { state baseRefName mergeCommit { oid } }
  }
}`;
const PR_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      state headRefOid headRefName maintainerCanModify
      headRepository { nameWithOwner }
      headRef { branchProtectionRule { id } }
    }
  }
}`;
type MergeRead = { repository?: { defaultBranchRef?: { name: string } | null; pullRequest?: { state: string; baseRefName: string; mergeCommit?: { oid: string } | null } | null } | null };
type PrRead = { repository?: { pullRequest?: { state: string; headRefOid: string; headRefName: string; maintainerCanModify: boolean; headRepository: { nameWithOwner: string } | null; headRef?: { branchProtectionRule?: { id: string } | null } | null } | null } | null };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
const short = (sha: string): string => sha.slice(0, 12);
const refOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;
const depRefOf = (r: { ref_repo: string; ref_number: number }): string => `${slugOf(r.ref_repo)}#${r.ref_number}`;
type Item = { kind: string; state: string };
const itemOf = (db: DatabaseSync, repo: string, number: number): Item | undefined =>
  db.prepare("SELECT kind, state FROM main.items WHERE repo = ? AND number = ?").get(repo, number) as Item | undefined;

// ---- the command ---------------------------------------------------------------

/**
 * Why no build worker would take the pull request's lockfile task, or null: workers take pipeline tasks only for repos in
 * scope or for fast-tracked items (claim in src/build/tasks.ts).
 */
function outOfBuildScope(db: DatabaseSync, repo: string, number: number): string | null {
  return baseScopeRepos(db).has(repo) || isFastTracked(db, repo, number) ? null : `AutoCraft's pipeline is off for ${slugOf(repo)}, so no build worker would write its lockfile`;
}

/** Cancels a lockfile task that is no longer wanted; one that already ended is left as it is. */
function stopTask(db: DatabaseSync, id: number | null): void {
  if (id === null) return;
  try { cancelTask(db, id, AUDIT_LOGIN); } catch { /* already ended, or gone */ }
}

/** A refusal worded for the answer on GitHub. */
const refused = (why: string): HttpError => new HttpError(409, why);

/**
 * Sets (or with `ref` null, drops) the autorepin of a pull request for the commenter of a command. Who may is the rule of
 * every write a person starts (settleRefusal in src/settlers.ts). Returns what the answer says; throws an HttpError with the
 * reason when refused. `at` orders the commands of a pull request: a command older than an `off` or than the command that set
 * the row sets nothing.
 */
export async function requestRepin(db: DatabaseSync, o: { login: string; githubId: number; role: string; canWrite: boolean; repo: string; number: number; pr: boolean; ref: PrRef | null; /** When the command was given (the comment's time). */ at?: Date }): Promise<string> {
  if (!o.pr) throw refused("autorepin is for pull requests");
  const refusal = await settleRefusal(db, { login: o.login, role: o.role, canWrite: async (r) => r === o.repo && o.canWrite }, [o.repo], `sets autorepin on ${o.repo}`);
  if (refusal) throw refused(refusal);
  const at = (o.at ?? new Date()).toISOString();
  const me = itemOf(db, o.repo, o.number);
  if (me?.kind !== "pr" || me.state !== "OPEN") throw refused("this pull request is not open");
  if (!o.ref) {
    // Kept even when nothing waits, so an older `autorepin` command still to be carried out (a retry) does not set it again.
    db.prepare(`INSERT INTO main.autorepin_offs (repo, number, off_at) VALUES (?, ?, ?)
      ON CONFLICT (repo, number) DO UPDATE SET off_at = excluded.off_at WHERE excluded.off_at > autorepin_offs.off_at`).run(o.repo, o.number, at);
    const tasks = db.prepare("SELECT task_id FROM main.autorepins WHERE repo = ?2 AND number = ?3 AND state = 'locking' AND requested_at <= ?1").all(at, o.repo, o.number) as { task_id: number | null }[];
    const n = db.prepare("UPDATE main.autorepins SET state = 'cancelled', result = NULL, done_at = ?1, requested_at = ?1, notice = 'none' WHERE repo = ?2 AND number = ?3 AND state IN ('waiting', 'locking') AND requested_at <= ?1").run(at, o.repo, o.number).changes;
    for (const t of tasks) stopTask(db, t.task_id);
    audit(db, o.login, "autorepin-off", refOf(o), { cancelled: Number(n) });
    return n ? "Autorepin is off for this pull request" : "No autorepin was waiting on this pull request; it stays off";
  }
  const off = (db.prepare("SELECT off_at FROM main.autorepin_offs WHERE repo = ? AND number = ?").get(o.repo, o.number) as { off_at: string } | undefined)?.off_at;
  if (off !== undefined && off > at) throw refused("a later autorepin off on this pull request stands");
  const dep = (db.prepare("SELECT name FROM main.tracked_repos WHERE name = ? COLLATE NOCASE").get(o.ref.name) as { name: string } | undefined)?.name;
  if (!dep || (o.ref.owner !== null && o.ref.owner.toLowerCase() !== ownerOf(dep).toLowerCase())) throw refused(`${o.ref.owner ? `${o.ref.owner}/` : ""}${o.ref.name} is not a repository AutoCraft tracks`);
  const depRef = `${slugOf(dep)}#${o.ref.number}`;
  if (dep === o.repo) throw refused("the pull request to wait for must be in another repository");
  const other = itemOf(db, dep, o.ref.number);
  if (other?.kind !== "pr") throw refused(`${depRef} is not a pull request AutoCraft has read`);
  if (other.state === "CLOSED") throw refused(`${depRef} was closed without merging`);
  const g = guardRepo(db, o.repo, "push", { operator: o.login }, undefined, o.login);
  if ("refused" in g) throw refused(g.refused);
  const scope = outOfBuildScope(db, o.repo, o.number);
  if (scope) throw refused(scope);
  // Only over a row of an earlier command: a later `off`, or a later command for the same repository, stands.
  const set = db.prepare(`INSERT INTO main.autorepins (repo, number, ref_repo, ref_number, login, github_id, requested_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')
    ON CONFLICT (repo, number, ref_repo) DO UPDATE SET ref_number = excluded.ref_number, login = excluded.login, github_id = excluded.github_id, requested_at = excluded.requested_at, state = 'waiting',
      sha = NULL, head = NULL, task_id = NULL, tries = 0, tried_at = NULL, to_head = NULL, result = NULL, done_at = NULL, notice = NULL
      WHERE excluded.requested_at >= autorepins.requested_at`)
    .run(o.repo, o.number, dep, o.ref.number, o.login, o.githubId, at).changes;
  if (!set) throw refused(`a later autorepin command for ${slugOf(dep)} on this pull request stands`);
  audit(db, o.login, "autorepin-set", refOf(o), { on: depRef });
  return other.state === "MERGED"
    ? `Autorepin set: ${depRef} is already merged, so ${slugOf(dep)} is repinned to its merge commit here now`
    : `Autorepin set: once ${depRef} is merged, ${slugOf(dep)} is repinned to its merge commit here, in a commit pushed to this branch`;
}

// ---- the work ------------------------------------------------------------------

export type RepinDeps = {
  querier: Querier;
  /** Runs git and gh. */
  exec?: Exec;
  /** Directory holding one bare cache repository per repo (default: the fix-ups'). */
  root?: string;
  /** Reads the asker's live write permission (default: through the app installation, as comment commands read it). */
  permission?: (q: Querier, repo: string, login: string) => Promise<"ok" | "no" | "transient">;
  /** Reads a same-repo PR author's permission (default: gh). */
  authorPermission?: PermissionReader;
  now?: () => Date;
  log?: (l: string) => void;
  /** Autorepins that call GitHub in one drain. */
  limit?: number;
};

/** The step ended for good; `notice` "none": nothing is said on GitHub (the pull request itself is closed). */
class Ended extends Error {
  readonly state: "failed" | "cancelled" | "pushed";
  readonly notice: "none" | null;
  readonly toHead: string | null;
  constructor(state: "failed" | "cancelled" | "pushed", result: string | null, o: { notice?: "none"; toHead?: string } = {}) {
    super(result ?? "");
    this.state = state;
    this.notice = o.notice ?? null;
    this.toHead = o.toHead ?? null;
  }
}
/** `why` is worded here and safe to post. */
const failed = (why: string): Ended => new Ended("failed", oneLine(why));
/** The attempt did not finish and is tried again; the reason is worded here and is the outcome's when the tries run out. */
class Retry extends Error {}

const KEY = "repo = ? AND number = ? AND ref_repo = ?";
const keyOf = (r: RepinRow): [string, number, string] => [r.repo, r.number, r.ref_repo];

function finish(db: DatabaseSync, r: RepinRow, e: Ended, at: Date): void {
  stopTask(db, r.task_id);
  db.prepare(`UPDATE main.autorepins SET state = ?, result = ?, done_at = ?, to_head = ?, notice = ? WHERE ${KEY}`).run(e.state, e.message || null, at.toISOString(), e.toHead, e.notice, ...keyOf(r));
  audit(db, AUDIT_LOGIN, "autorepin", refOf(r), { on: depRefOf(r), by: r.login, state: e.state, ...(e.message ? { result: e.message } : {}), ...(e.toHead ? { commit: e.toHead } : {}) });
}

/** One step of an autorepin: from `waiting` it queues the lockfile task (or pushes, without a lockfile); from `locking` it takes the task's lockfile and pushes. Throws `Ended` when it is over, anything else to try again. */
async function step(db: DatabaseSync, r: RepinRow, d: RepinDeps): Promise<void> {
  const q = d.querier, run = d.exec ?? defaultExec;
  const dep = slugOf(r.ref_repo), depRef = depRefOf(r);
  if (r.state === "locking" && r.task_id !== null) {
    // A task no build worker finished in time ends the autorepin instead of holding it.
    const t = getTask(db, r.task_id);
    if (t && !TERMINAL.includes(t.state) && (d.now ?? (() => new Date()))().getTime() - Date.parse(t.queuedAt) > LOCK_MAX_MS) {
      try { cancelTask(db, t.id, AUDIT_LOGIN); } catch { /* it ended meanwhile */ }
      throw failed("the lockfile task did not end within 3 hours");
    }
  }
  const me = itemOf(db, r.repo, r.number);
  if (me?.kind !== "pr" || me.state !== "OPEN") throw new Ended("cancelled", null, { notice: "none" });
  const other = itemOf(db, r.ref_repo, r.ref_number);
  if (!other) throw failed(`AutoCraft no longer has ${depRef}`);
  if (other.state === "CLOSED") throw new Ended("cancelled", `${depRef} was closed without merging, so nothing was repinned`);

  // The merge commit, from GitHub: it must be on the default branch, where the dependency's revs are to come from.
  const m = await q.query(MERGE_QUERY, { owner: ownerOf(r.ref_repo), name: r.ref_repo, n: r.ref_number }) as MergeRead;
  const merged = m.repository?.pullRequest;
  if (!merged) throw new Retry(`GitHub returned no ${depRef}`);
  if (merged.state === "CLOSED") throw new Ended("cancelled", `${depRef} was closed without merging, so nothing was repinned`);
  if (merged.state !== "MERGED") throw new Retry(`${depRef} is not merged on GitHub yet`);
  const main = m.repository?.defaultBranchRef?.name;
  if (!main) throw new Retry(`GitHub returned no default branch for ${dep}`);
  if (merged.baseRefName !== main) throw failed(`${depRef} was merged into ${merged.baseRefName}, not into ${dep}'s default branch ${main}`);
  const sha = merged.mergeCommit?.oid ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Retry(`GitHub returned no merge commit for ${depRef}`);
  // The branch as it is now: a default branch rewritten since the merge may no longer hold the commit.
  const root = d.root ?? fixupDir();
  mkdirSync(root, { recursive: true });
  const depGit = new Git(run, root, r.ref_repo);
  const tip = await depGit.fetchBase(ownerOf(r.ref_repo), r.ref_repo, main);
  // The fetch brought every commit the branch holds: one that is not here is not on it.
  const have = (await depGit.git(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
  const on = have ? await depGit.git(["merge-base", "--is-ancestor", sha, tip]) : { code: 1, stderr: "" };
  if (on.code === 1) throw failed(`the merge commit of ${depRef} is no longer on ${dep}'s default branch ${main}`);
  if (on.code !== 0) throw new Error(`the merge commit of ${depRef} could not be looked up on ${dep}'s ${main}: ${oneLine(on.stderr)}`);

  // Whoever asked must still be allowed to, with the login still bound to the GitHub account that asked, and the repo must
  // still approve pushes.
  const permission = d.permission ?? (async (_q: Querier, repo: string, login: string) => {
    const a = await appPermission(db, login, repo);
    return a.kind === "ok" ? (WRITE_PERMISSIONS.has(a.permission) ? "ok" as const : "no" as const) : "transient" as const;
  });
  const p = await permission(q, r.repo, r.login).catch(() => "transient" as const);
  if (p === "transient") throw new Retry(`GitHub could not tell ${r.login}'s access to ${slugOf(r.repo)}`);
  const access = boundAccess(db, r);
  if (!access) throw failed(`${r.login} no longer has an AutoCraft login bound to the GitHub account that asked`);
  if (access.role !== "operator" && isQuiet(db, r.repo, r.number)) throw failed("the pull request is quiet until its fix is published");
  const refusal = await settleRefusal(db, { login: r.login, role: access.role, canWrite: async (x) => x === r.repo && p === "ok" }, [r.repo], `repins on ${r.repo}`);
  if (refusal) throw failed(refusal);
  const g = guardRepo(db, r.repo, "push", { operator: r.login }, undefined, r.login);
  if ("refused" in g) throw failed(g.refused);

  const l = await q.query(PR_QUERY, { owner: ownerOf(r.repo), name: r.repo, n: r.number }) as PrRead;
  const pr = l.repository?.pullRequest;
  if (!pr) throw new Retry(`GitHub returned no ${refOf(r)}`);
  if (pr.state !== "OPEN") throw new Ended("cancelled", null, { notice: "none" });
  const head = pr.headRefOid;
  if (r.state === "locking" && r.head !== head) throw new Retry("the head moved while the lockfile was written");
  const headRepo = pr.headRepository?.nameWithOwner;
  const writes = headRepo ? await ensureAuthorWrites(db, r.repo, r.number, headRepo, d.authorPermission) : "no";
  if (writes === "unknown") throw new Retry("the author's permission could not be read yet");
  if (!headRepo || !pushable(headRepo, r.repo, pr.maintainerCanModify, pr.headRefName, longLivedOf(db, r.repo), !!pr.headRef?.branchProtectionRule, writes === "yes")) {
    throw failed("AutoCraft cannot push to this pull request's branch (a fork that does not allow maintainer edits, or a protected or shared branch)");
  }

  const git = new Git(run, root, r.repo);
  const fetched = await git.fetchPr(ownerOf(r.repo), r.repo, r.number);
  if (fetched !== head) throw new Retry(`the fetched head ${short(fetched)} is not the head GitHub reports`);
  const paths = (await git.must(["ls-tree", "-r", "--name-only", "-z", head])).split("\0").filter(Boolean);
  const manifests = paths.filter((p) => /(^|\/)Cargo\.toml$/.test(p));
  if (manifests.length > MAX_MANIFESTS) throw failed(`the pull request has more than ${MAX_MANIFESTS} Cargo.toml files`);
  // Only the root Cargo.lock is written by the task; a workspace below the root with its own lockfile would keep a stale one.
  const nested = paths.find((x) => x !== LOCK && /\/Cargo\.lock$/.test(x));
  if (nested) throw failed(`${safePath(nested, "a Cargo.lock")} is a lockfile below the repository root, which autorepin does not update`);
  const name = r.ref_repo.toLowerCase();
  const files: { path: string; mode: string; content: string }[] = [];
  let pinned = 0, unpinned = 0;
  for (const path of manifests) {
    const f = await git.file(head, path);
    // Every manifest is read: one that cannot be (a failed read, a link, too large) ends the try, so a repin never covers only some of them.
    if (!f.ok) {
      d.log?.(`autorepin ${refOf(r)}: ${path}: ${oneLine(f.reason)}`);
      throw new Retry(`${safePath(path, "a Cargo.toml")} could not be read`);
    }
    // A manifest that never names the repository (a test fixture, say) is not read as TOML at all.
    if (!f.content.toLowerCase().includes(name)) continue;
    const out = repinManifest(f.content, dep, sha);
    if (!out.ok) {
      d.log?.(`autorepin ${refOf(r)}: ${path}: ${out.reason}${out.detail ? `: ${oneLine(out.detail)}` : ""}`);
      throw failed(`${safePath(path, "a Cargo.toml")}: ${out.reason}`);
    }
    pinned += out.pinned;
    unpinned += out.unpinned;
    if (out.from.length) files.push({ path, mode: f.mode, content: out.text });
  }
  if (!pinned) throw failed(`no Cargo.toml of this pull request pins ${dep} by rev${unpinned ? ` (${unpinned} use a branch, a tag or no rev, which autorepin leaves alone)` : ""}`);
  if (!files.length) {
    // The head is the commit an earlier try pushed (the outcome was not recorded): keep it, so a merge pre-approved at the old head carries on (ownPush in src/preapproval).
    if (r.to_head !== null && r.to_head === head) throw new Ended("pushed", `Repinned ${dep} to ${short(sha)}, the merge of ${depRef}, in ${short(head)}`, { toHead: head });
    throw new Ended("pushed", `${dep} is already pinned to ${short(sha)}, the merge of ${depRef}; nothing to change`);
  }

  const scratch = mkdtempSync(join(root, ".index-"));
  try {
    let tree = await git.withFiles(head, files, join(scratch, "index"));
    const changed = files.map((f) => f.path);
    if (paths.includes(LOCK)) {
      const lock = await git.file(head, LOCK);
      if (!lock.ok) {
        d.log?.(`autorepin ${refOf(r)}: ${LOCK}: ${oneLine(lock.reason)}`);
        throw failed(`${LOCK} could not be read`);
      }
      if (r.state !== "locking") {
        const scope = outOfBuildScope(db, r.repo, r.number);
        if (scope) throw failed(scope);
        const id = createTask(db, {
          step: "autorepin", repo: r.repo, number: r.number, headSha: head, requires: { os: "linux", toolchains: ["rust-stable"] }, patch: await git.diffText(head, tree),
          plan: [{ name: "lock", cmd: ["sh", "-c", LOCK_SCRIPT], network: "fetch", timeoutSec: 900, artifacts: [LOCK] }],
        });
        db.prepare(`UPDATE main.autorepins SET state = 'locking', sha = ?, head = ?, to_head = NULL, task_id = ? WHERE ${KEY}`).run(sha, head, id, ...keyOf(r));
        d.log?.(`autorepin ${refOf(r)}: lockfile task ${id} queued for ${dep} at ${short(sha)}`);
        return;
      }
      const t = db.prepare("SELECT state FROM main.build_tasks WHERE id = ?").get(r.task_id) as { state: string } | undefined;
      if (t?.state !== "done") throw new Retry(`the lockfile task ${t ? t.state : "is gone"}`);
      const art = db.prepare("SELECT file FROM main.build_artifacts WHERE task_id = ? AND name = ?").get(r.task_id, LOCK) as { file: string } | undefined;
      const file = art ? absolute(art.file) : null;
      if (!file) throw new Retry("the lockfile task returned no Cargo.lock");
      const after = readFileSync(file, "utf8");
      const no = lockRefusal(lock.content, after, dep, sha);
      if (no) throw failed(no);
      if (after !== lock.content) {
        tree = await git.withFiles(tree, [{ path: LOCK, mode: lock.mode, content: after }], join(scratch, "index"));
        changed.push(LOCK);
      }
    }
    const who = await commitIdentity(db, r.repo, () => pipelineAccount(run));
    const commit = await git.commit(tree, head, `Repin ${r.ref_repo} to ${short(sha)}\n\nThe merge commit of ${depRef}.\n`, { name: who.name, email: who.email });
    // The commit is exactly the rewritten manifests and the lockfile: contents of files that exist, nothing added, removed or re-moded.
    const changes = await git.rawChanges(head, commit);
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1]) || changes.map((x) => x[3]!).sort().join("\n") !== [...changed].sort().join("\n")) throw failed("the commit would change more than the revs and the lockfile");
    // Written before the push, so a head that reaches the mirror before the outcome is recorded is already known as this commit (ownPush in src/preapproval).
    db.prepare(`UPDATE main.autorepins SET head = ?, to_head = ? WHERE ${KEY}`).run(head, commit, ...keyOf(r));
    const push = await pushRepin({ db, login: AUDIT_LOGIN }, g, git, { repo: r.repo, number: r.number, remote: headRepo, branch: pr.headRefName, head, sha: commit }, { on: depRef, rev: sha, files: changed, by: r.login });
    if (push.code !== 0) {
      const err = oneLine(push.stderr);
      if (/stale info|rejected|fetch first/i.test(err)) throw new Retry("the branch moved before the push");
      if (/denied|403|permission|not allowed|protected branch|declined|GH013/i.test(err)) throw failed("GitHub refused the push to this pull request's branch");
      throw new Error(`the push failed: ${err}`);
    }
    throw new Ended("pushed", `Repinned ${dep} to ${short(sha)}, the merge of ${depRef}, in ${short(commit)} (${changed.join(", ")})`, { toHead: commit });
  } finally {
    // A scratch folder that cannot be removed must not replace the outcome (a push that was made, a task that was queued).
    try { rmSync(scratch, { recursive: true, force: true }); } catch (e) { d.log?.(`autorepin ${refOf(r)}: scratch folder not removed: ${oneLine(String((e as Error)?.message ?? e))}`); }
  }
}

/** The comment that tells the outcome on the pull request. */
export function noticeText(r: Pick<RepinRow, "login" | "state" | "result" | "ref_repo">): string {
  if (r.state === "pushed") return `@${r.login} ${r.result}.`;
  return r.state === "cancelled" ? `@${r.login} Autorepin is off: ${r.result}.` : `@${r.login} Autorepin of ${slugOf(r.ref_repo)} failed: ${r.result}.`;
}

/** Posts the outcome. A paced write leaves it for the next drain; any other failure is logged and not retried. Nothing is posted on a quiet pull request. */
async function notify(db: DatabaseSync, r: RepinRow, d: RepinDeps): Promise<"posted" | "failed" | "paced" | "none"> {
  // A quiet pull request (a security fix not yet published) gets no comment.
  if (isQuiet(db, r.repo, r.number)) {
    db.prepare(`UPDATE main.autorepins SET notice = 'none' WHERE ${KEY}`).run(...keyOf(r));
    return "none";
  }
  const g = guardRepo(db, r.repo, null, { operator: r.login }, undefined, r.login);
  let notice: "posted" | "failed" = "failed";
  if ("refused" in g) d.log?.(`autorepin ${refOf(r)}: no comment: ${g.refused}`);
  else {
    try {
      const out = await ghComment({ db, login: AUDIT_LOGIN }, g, d.exec ?? defaultExec, "autorepin-comment", { repo: r.repo, number: r.number, pr: true }, { by: "fixed-operator" }, noticeText(r), { on: depRefOf(r), state: r.state });
      if (out.code === 0) notice = "posted";
      else d.log?.(`autorepin ${refOf(r)}: the comment failed: ${oneLine(out.stderr || out.stdout)}`);
    } catch (e) {
      if (e instanceof WritePacedError) return "paced";
      d.log?.(`autorepin ${refOf(r)}: the comment failed: ${oneLine(String((e as Error)?.message ?? e))}`);
    }
  }
  db.prepare(`UPDATE main.autorepins SET notice = ? WHERE ${KEY}`).run(notice, ...keyOf(r));
  return notice;
}

/** Takes the next step of every autorepin that has one (src/repin/due.ts) and posts the outcomes. Returns how many ended. */
export async function drainRepins(db: DatabaseSync, deps: RepinDeps): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  let ended = 0, calls = 0;
  for (const r0 of repinsDue(db, clock())) {
    if (calls++ >= (deps.limit ?? 5)) break;
    let r = r0;
    if (r.state === "waiting" || r.state === "locking") {
      try {
        await step(db, r, deps);
        continue;
      } catch (e) {
        if (e instanceof WritePacedError) break;
        if (e instanceof Ended) finish(db, r, e, clock());
        else {
          // Not finished: from the start again after a minute, and given up with the reason after MAX_TRIES. Only a reason
          // worded here (Retry) is posted. head and to_head stay: a push that went out before the error is still known as ours.
          const raw = oneLine(String((e as Error)?.message ?? e));
          deps.log?.(`autorepin ${refOf(r)}: try ${r.tries + 1} of ${MAX_TRIES}: ${raw}`);
          if (r.tries + 1 >= MAX_TRIES) finish(db, r, failed(e instanceof Retry ? raw : UNEXPECTED), clock());
          else {
            stopTask(db, r.task_id);
            db.prepare(`UPDATE main.autorepins SET state = 'waiting', task_id = NULL, tries = tries + 1, tried_at = ? WHERE ${KEY}`).run(clock().toISOString(), ...keyOf(r));
            continue;
          }
        }
      }
      ended++;
      r = db.prepare(`SELECT * FROM main.autorepins WHERE ${KEY}`).get(...keyOf(r)) as RepinRow;
      deps.log?.(`autorepin ${refOf(r)}: ${r.state}${r.result ? `: ${r.result}` : ""}`);
    }
    if (r.notice === null && (await notify(db, r, deps)) === "paced") break;
  }
  return ended;
}
