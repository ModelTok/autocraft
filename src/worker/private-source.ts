// Source downloads of the org's own private repos (config key `privateFetch`). The token is read once at start and
// used only in this file: it goes to api.github.com, only for a repo whose owner is the configured one, and only for a
// task the coordinator marked private. GitHub answers the tarball request with a redirect to a short-lived
// codeload.github.com URL; that one hop is followed without the token, and any other target is refused. Nothing here
// puts the token, or the codeload URL (it carries GitHub's own short-lived token), into an error, a log or a result;
// every error is scrubbed of the token as well.
import { readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { inspect } from "node:util";
import { OWNER, isDefaultOwner } from "../owners.ts";
import { DEFAULT_EXTRACT_LIMITS, TarError, downloadAndExtract, type ExtractLimits } from "./tarball.ts";

const API = "https://api.github.com";
const CODELOAD = "codeload.github.com";
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
/** Fine-grained tokens are `github_pat_<letters, digits, _>`; classic ones `ghp_...`. Anything else is refused at start. */
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export type PrivateFetchConfig = { tokenFile: string; owner: string };

/** Whether a claimed task's `private` field is absent or `{ owner }` with a valid owner name; the problem otherwise. */
export function privateFieldProblem(v: unknown): string | null {
  if (v === undefined) return null;
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "owner")) return "private must be { owner }";
  if (typeof o.owner !== "string" || !OWNER.test(o.owner)) return "private.owner is not a GitHub owner name";
  return null;
}

export class PrivateSource {
  readonly owner: string;
  readonly #token: string;

  constructor(owner: string, token: string) {
    if (!OWNER.test(owner) || !isDefaultOwner(owner)) throw new Error("privateFetch.owner must be the default owner (AUTOCRAFT_OWNER)");
    if (!TOKEN_RE.test(token)) throw new Error("privateFetch token is not a GitHub token");
    this.owner = owner;
    this.#token = token;
  }

  /** Whether `owner` is this source's owner; GitHub owner names compare without case. */
  covers(owner: string): boolean {
    return owner.toLowerCase() === this.owner.toLowerCase();
  }

  /** `s` without the token. */
  scrub(s: string): string {
    return s.split(this.#token).join("***");
  }

  // The token never reaches a log line through the object itself.
  toJSON(): { owner: string } {
    return { owner: this.owner };
  }
  [inspect.custom](): string {
    return `PrivateSource(${this.owner})`;
  }

  #check(owner: string, repo: string, sha: string): void {
    if (!this.covers(owner)) throw new TarError(`private source of ${owner} refused: this worker fetches private code only of ${this.owner}`);
    if (!REPO_RE.test(repo) || repo === "." || repo === "..") throw new TarError("private source refused: the repo name is not valid");
    if (!SHA_RE.test(sha)) throw new TarError("private source refused: not a full commit id");
  }

  #headers(accept: string): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, accept, "x-github-api-version": "2022-11-28", "user-agent": "autocraft-worker" };
  }

  /** Runs `f`, rethrowing any error as a TarError with the token scrubbed from its message. */
  async #scrubbed<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new TarError(this.scrub(msg));
    }
  }

  /**
   * Downloads `owner/repo` at `sha` into `dest` with the token: GET api.github.com/repos/<owner>/<repo>/tarball/<sha>,
   * then one redirect, only to https://codeload.github.com/, without the token. The safe extractor and the size cap of
   * an anonymous download apply. Returns the number of files written.
   */
  downloadTarball(owner: string, repo: string, sha: string, dest: string, maxBytes: number, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS, fetchImpl: typeof fetch = fetch): Promise<number> {
    return this.#scrubbed(async () => {
      this.#check(owner, repo, sha);
      const res = await fetchImpl(`${API}/repos/${owner}/${repo}/tarball/${sha}`, { redirect: "manual", headers: this.#headers("application/vnd.github+json"), signal: AbortSignal.timeout(60_000) });
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!REDIRECTS.has(res.status)) throw new TarError(`private source download failed: HTTP ${res.status}`);
      // The codeload URL is GitHub's own short-lived credential: it is checked and used, never logged.
      return await downloadAndExtract(codeloadUrl(location), dest, maxBytes, limits, fetchImpl, "error");
    });
  }

  /** A file of `owner/repo` at `sha` as text (the CI gate's inputs), or null when the repo has no such file. No redirect is followed. */
  fileText(owner: string, repo: string, sha: string, path: string, maxBytes: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    return this.#scrubbed(async () => {
      this.#check(owner, repo, sha);
      if (!PATH_RE.test(path) || path.split("/").some((p) => p === "." || p === "..")) throw new TarError("private file refused: the path is not valid");
      const res = await fetchImpl(`${API}/repos/${owner}/${repo}/contents/${path}?ref=${sha}`, { redirect: "error", headers: this.#headers("application/vnd.github.raw+json"), signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new TarError(`${path}: HTTP ${res.status}`);
      }
      const text = await res.text();
      if (text.length > maxBytes) throw new TarError(`${path}: file is too large`);
      return text;
    });
  }
}

/** The redirect target of the tarball request, when it is https://codeload.github.com/ (default port, no credentials). */
export function codeloadUrl(location: string | null): string {
  let u: URL | null = null;
  try {
    u = location ? new URL(location) : null;
  } catch {
    u = null;
  }
  if (!u || u.protocol !== "https:" || u.hostname !== CODELOAD || u.port !== "" || u.username !== "" || u.password !== "") {
    throw new TarError("private source download refused: GitHub redirected somewhere other than https://codeload.github.com/");
  }
  return u.href;
}

/**
 * The worker's private source, read once at start, or undefined without `privateFetch`. The token file must hold one
 * token and, on Linux and macOS, be readable by its owner alone. Errors name the file, never its content.
 */
export function loadPrivateSource(pf: PrivateFetchConfig | undefined): PrivateSource | undefined {
  if (!pf) return undefined;
  let text: string;
  try {
    if (platform() !== "win32" && (statSync(pf.tokenFile).mode & 0o077) !== 0) throw new Error("it is readable by other users; chmod 600 it");
    text = readFileSync(pf.tokenFile, "utf8").trim();
  } catch (e) {
    throw new Error(`config: cannot use privateFetch.tokenFile ${pf.tokenFile}: ${(e as Error).message}`);
  }
  if (!TOKEN_RE.test(text)) throw new Error(`config: privateFetch.tokenFile ${pf.tokenFile} does not hold one GitHub token`);
  return new PrivateSource(pf.owner, text);
}
