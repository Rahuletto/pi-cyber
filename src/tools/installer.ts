/**
 * Pinned-release resolver + resolved-manifest freezer for the pi-cyber tools installer.
 *
 * Design invariants (Task 3 rulings):
 * - The reviewed `tools/manifest.json` is NEVER mutated by the installer. The first verified
 *   download of a tool freezes `{name, repo, tag, assetUrl, sha256, resolvedAt}` into
 *   `tools/manifest.resolved.json` instead.
 * - Deterministic asset pick: only darwin/arm64 (this host is darwin/arm64 only; foreign
 *   platforms must never reach `validated`).
 * - Everything here is pure fn/fetch/fs — no shell strings (src/ constraint), so the freeze
 *   path is directly unit-testable with fixture data.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Default location of the frozen resolution ledger, next to the reviewed manifest. */
export const RESOLVED_FILE = resolve(import.meta.dir, "..", "..", "tools", "manifest.resolved.json");

export interface ReleaseAsset {
  /** Repo-supplied asset filename. */
  name: string;
  /** browser_download_url for the asset. */
  url: string;
}

export interface Resolution {
  tag: string;
  assetName: string;
  assetUrl: string;
}

/** Frozen-per-tool record. The six ruled keys plus the additive `binary_sha256` (digest of the
 *  installed executable; distinct from the archive `sha256`) that feeds the ledgered re-hash on
 *  later runs. Absent on records predating the field. */
export interface ResolvedRecord {
  name: string;
  repo: string;
  tag: string;
  assetUrl: string;
  sha256: string;
  resolvedAt: string;
  binary_sha256?: string;
}

/** Human-readable matching rule printed by install.sh --dry-run and referenced in failures. */
export const ASSET_PATTERN =
  'asset name matches (darwin|macos|osx) AND (arm64|aarch64); extension ∈ zip|tar.gz|tgz|tar.xz|tar.bz2|bare binary; excludes x86_64|x86|amd64|386|64bit|32bit, checksums/sbom/meta files, dmg|pkg|jar|sh|py';

const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** Not installable targets and pure metadata siblings that would otherwise false-match. */
const EXCLUDE_RE = /(x86_64|x86|amd64|i386|386|64bit|32bit|sbom|checksum|sha256|sha1|\.dmg|\.pkg|\.jar|\.py|\.sh|\.txt|\.json|\.md|\.sig|\.crt|\.release|\.yaml|\.yml)$/i;
const OS_RE = /(darwin|macos|osx)/i;
const ARM_RE = /(arm64|aarch64)/i;
const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2)$/i;

/**
 * Pick the darwin/arm64 install asset from a release asset list. Returns null when nothing
 * matches — the caller must surface that as an explicit per-tool failure, never a silent skip.
 */
export function pickDarwinArm64Asset(assets: ReleaseAsset[]): ReleaseAsset | null {
  const candidates = assets
    .filter((asset) => typeof asset.name === "string" && asset.name.length > 0 && typeof asset.url === "string")
    .filter((asset) => OS_RE.test(asset.name))
    .filter((asset) => ARM_RE.test(asset.name))
    .filter((asset) => !EXCLUDE_RE.test(asset.name))
    .filter((asset) => ARCHIVE_RE.test(asset.name) || !/\.[a-z0-9]+$/i.test(asset.name)); // archive or bare binary
  return candidates[0] ?? null;
}

/** Resolve the latest GitHub release of `repo` down to one installable darwin/arm64 artifact.
 *  Well-behaved toward api.github.com: 403/429/5xx are retried up to 3 times with 2s/5s/15s
 *  backoff (unauthenticated rate limits are common); 404 fails immediately with its own message.
 *  GITHUB_TOKEN or GH_TOKEN (whichever is set) is sent as `Authorization: Bearer <token>` — the
 *  token is never logged, persisted, or echoed in error messages. */
const RELEASE_RETRY_DELAYS_MS = [2000, 5000, 15000];

function isRetriableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

export async function resolveLatest(
  repo: string,
  deps: { fetchImpl?: typeof fetch; delayMs?: (ms: number) => Promise<void> } = {},
): Promise<Resolution> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const delayMs = deps.delayMs ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  if (!REPO_RE.test(repo)) throw new Error(`invalid repo slug "${repo}"`);
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "pi-cyber-installer" };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (typeof token === "string" && token.length > 0) headers.authorization = `Bearer ${token}`;

  const sleep = async (attemptIndex: number): Promise<void> => {
    const ms = RELEASE_RETRY_DELAYS_MS[attemptIndex];
    if (typeof ms === "number" && ms > 0) await delayMs(ms);
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RELEASE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(attempt - 1);
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, redirect: "follow" });
    } catch (error) {
      // Network hiccup — retriable.
      lastError = new Error(`GitHub API GET ${url} → network error: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(`GitHub API response for ${repo} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      return parseReleaseResponse(repo, body);
    }
    if (isRetriableStatus(response.status)) {
      const hint = response.status === 403
        ? " (rate limited — retriable with backoff; set GITHUB_TOKEN for higher limits)"
        : " (transient server error — retriable)";
      lastError = new Error(`GitHub API GET ${url} → HTTP ${response.status}${hint}`);
      continue;
    }
    if (response.status === 404) {
      throw new Error(`GitHub API GET ${url} → HTTP 404 (no published release — repo may not use GitHub Releases)`);
    }
    if (response.status === 401) {
      throw new Error(`GitHub API GET ${url} → HTTP 401 (authorization rejected — check GITHUB_TOKEN validity)`);
    }
    throw new Error(`GitHub API GET ${url} → HTTP ${response.status}`);
  }
  throw lastError ?? new Error(`GitHub API GET ${url} → retries exhausted`);
}

async function parseReleaseResponse(repo: string, body: unknown): Promise<Resolution> {
  if (typeof body !== "object" || body === null) throw new Error(`GitHub API response for ${repo} is not an object`);
  const record = body as Record<string, unknown>;
  const tag = record.tag_name;
  if (typeof tag !== "string" || tag.length === 0) throw new Error(`GitHub API response for ${repo} has no tag_name`);
  if (!Array.isArray(record.assets)) throw new Error(`GitHub API response for ${repo} has no assets array`);
  const assets: ReleaseAsset[] = record.assets.map((row) => {
    if (typeof row !== "object" || row === null) throw new Error(`GitHub API asset for ${repo} is not an object`);
    const asset = row as Record<string, unknown>;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
      throw new Error(`GitHub API asset for ${repo} is missing name or browser_download_url`);
    }
    return { name: asset.name, url: asset.browser_download_url };
  });
  const picked = pickDarwinArm64Asset(assets);
  if (picked === null) {
    throw new Error(`no darwin/arm64 asset on tag ${tag} (matcher: ${ASSET_PATTERN})`);
  }
  return { tag, assetName: picked.name, assetUrl: picked.url };
}

type ResolvedMap = Record<string, ResolvedRecord>;

function strictRecord(name: string, value: unknown): ResolvedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`installer: resolved record for "${name}" must be an object`);
  }
  const row = value as Record<string, unknown>;
  const expected: Array<keyof ResolvedRecord> = ["name", "repo", "tag", "assetUrl", "sha256", "resolvedAt"];
  for (const key of expected) {
    if (typeof row[key] !== "string" || (row[key] as string).length === 0) {
      throw new TypeError(`installer: resolved record for "${name}" has missing/empty "${key}"`);
    }
  }
  if (!SHA256_RE.test(row.sha256 as string)) {
    throw new TypeError(`installer: resolved record for "${name}" sha256 is not a 64-hex digest`);
  }
  if (Number.isNaN(Date.parse(row.resolvedAt as string))) {
    throw new TypeError(`installer: resolved record for "${name}" resolvedAt is not a parseable timestamp`);
  }
  const record: ResolvedRecord = {
    name: row.name as string,
    repo: row.repo as string,
    tag: row.tag as string,
    assetUrl: row.assetUrl as string,
    sha256: (row.sha256 as string).toLowerCase(),
    resolvedAt: row.resolvedAt as string,
  };
  // Additive field: archive sha256 (verified pin), binary_sha256 = installed executable digest.
  if (row.binary_sha256 !== undefined) {
    if (typeof row.binary_sha256 !== "string" || !SHA256_RE.test(row.binary_sha256)) {
      throw new TypeError(`installer: resolved record for "${name}" binary_sha256 must be a 64-hex digest when present`);
    }
    record.binary_sha256 = row.binary_sha256.toLowerCase();
  }
  return record;
}

/** Load the frozen ledger. A missing file is the documented fresh-start state; a corrupt file throws. */
export async function loadResolved(path: string = RESOLVED_FILE): Promise<ResolvedMap> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new TypeError(`installer: unreadable resolved file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`installer: unreadable resolved file ${path}: invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`installer: resolved file ${path} top level must be an object`);
  }
  const out: ResolvedMap = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = strictRecord(name, value);
  }
  return out;
}

function assertFreezeInput(record: ResolvedRecord): void {
  strictRecord(record.name, record);
}

/**
 * Freeze (insert or replace) one resolved record into the resolved ledger. The reviewed
 * manifest is untouched by construction; the write is atomic (temp file + rename).
 */
export async function freezeResolved(path: string, record: ResolvedRecord): Promise<void> {
  assertFreezeInput(record);
  const existing = await loadResolved(path);
  const merged = { ...existing, [record.name]: { ...record, sha256: record.sha256.toLowerCase(), ...(record.binary_sha256 ? { binary_sha256: record.binary_sha256.toLowerCase() } : {}) } };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
