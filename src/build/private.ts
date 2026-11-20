// Builds of private repos. A worker downloads source anonymously; only an environment an operator marked for private
// code (build_envs.private_code), whose worker reported at hello that its privateFetch token covers the owner
// (capabilities.privateOwner), downloads a private repo, and only for the default owner. The flag alone is not enough
// (the worker may hold no token) and the report alone is not enough (a worker cannot make itself trusted).
import type { DatabaseSync } from "node:sqlite";
import type { Capabilities } from "../../web/src/api/types.ts";
import { DEFAULT_OWNER, isDefaultOwner } from "../owners.ts";

/**
 * The owner of `repo` when the mirror knows it is not public (private or internal), else null. A repo without a known
 * visibility counts as public here: its task downloads anonymously, which fails for a private repo and so shows no code.
 */
export function privateRepoOf(db: DatabaseSync, repo: string): { owner: string } | null {
  const r = db.prepare("SELECT owner, visibility FROM main.repos WHERE name = ?").get(repo) as { owner: string | null; visibility: string | null } | undefined;
  if (!r?.visibility || r.visibility.toLowerCase() === "public") return null;
  return { owner: r.owner || DEFAULT_OWNER };
}

/** Whether an environment may take a task of a private repo of `owner`: flagged by an operator, reporting a token for that owner, and the owner is the default one. */
export function takesPrivate(env: { private_code: number }, caps: Pick<Capabilities, "privateOwner"> | null, owner: string): boolean {
  return env.private_code === 1 && isDefaultOwner(owner) && typeof caps?.privateOwner === "string" && caps.privateOwner.toLowerCase() === owner.toLowerCase();
}

/** Whether some enabled environment may take private tasks of the default owner. */
export function privateBuildsReady(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT private_code, capabilities FROM build_envs WHERE enabled = 1 AND private_code = 1").all() as { private_code: number; capabilities: string | null }[];
  return rows.some((r) => {
    let caps: Capabilities | null = null;
    try {
      caps = r.capabilities ? (JSON.parse(r.capabilities) as Capabilities) : null;
    } catch { /* unreadable report: not ready */ }
    return takesPrivate(r, caps, DEFAULT_OWNER);
  });
}

/**
 * Whether the build stages may queue work for `repo`: a public repo, or a private repo of the default owner while an
 * environment can take it. Other owners' private repos stay out: no worker may hold a token for them.
 */
export function buildableRepo(db: DatabaseSync, repo: string): boolean {
  const r = db.prepare("SELECT visibility FROM main.repos WHERE name = ?").get(repo) as { visibility: string | null } | undefined;
  if (r?.visibility?.toLowerCase() === "public") return true;
  const priv = privateRepoOf(db, repo);
  return !!priv && isDefaultOwner(priv.owner) && privateBuildsReady(db);
}
