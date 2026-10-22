import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { containsSecretLike, SECRET_REFUSAL_MESSAGE } from "../evidence/secrets.ts";

export interface ArtifactRef {
  id: string;
  kind: string;
  contentType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface ArtifactRead {
  artifact: ArtifactRef;
  offset: number;
  nextOffset: number | null;
  data: string;
}

const ID_PATTERN = /^[a-f0-9]{32}$/;
const ENGAGEMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const TEXT_CONTENT_TYPE = /^(?:text\/|application\/(?:json|xml|[^;]+\+json|[^;]+\+xml))/i;

function artifactRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CYBER_EVIDENCE_DIR?.trim() || join(import.meta.dir, "..", "..", "config", "cyber", "evidence");
  const engagement = env.CYBER_ENGAGEMENT_ID?.trim() || "default";
  if (!ENGAGEMENT_PATTERN.test(engagement)) throw new Error("invalid engagement id for artifact storage.");
  return join(base, engagement, "artifacts");
}

function validateId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error("invalid artifact id.");
}

export function resolveArtifactPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  validateId(id);
  const root = artifactRoot(env);
  const dataPath = join(root, `${id}.bin`);
  const metaPath = join(root, `${id}.json`);
  let ref: ArtifactRef;
  try {
    const dataStat = lstatSync(dataPath);
    const metaStat = lstatSync(metaPath);
    if (!dataStat.isFile() || !metaStat.isFile() || (dataStat.mode & 0o777) !== 0o600 || (metaStat.mode & 0o777) !== 0o600) throw new Error("artifact not found.");
    ref = loadArtifactRef(id, env);
    if (dataStat.size !== ref.bytes) throw new Error("artifact integrity check failed.");
  } catch (error) {
    if (error instanceof Error && error.message === "artifact integrity check failed.") throw error;
    throw new Error("artifact not found.");
  }
  const bytes = readFileSync(dataPath);
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("artifact integrity check failed.");
  return dataPath;
}

function metadataPath(id: string, env: NodeJS.ProcessEnv): string {
  validateId(id);
  return join(artifactRoot(env), `${id}.json`);
}

function sourceIndexPath(source: string, env: NodeJS.ProcessEnv): string {
  const sourceId = createHash("sha256").update(source).digest("hex");
  return join(artifactRoot(env), "sources", `${sourceId}.json`);
}

function loadArtifactRef(id: string, env: NodeJS.ProcessEnv): ArtifactRef {
  let artifact: ArtifactRef;
  try {
    artifact = JSON.parse(readFileSync(metadataPath(id, env), "utf8")) as ArtifactRef;
  } catch {
    throw new Error("artifact not found.");
  }
  if (!artifact || artifact.id !== id || typeof artifact.kind !== "string" || typeof artifact.contentType !== "string" ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > MAX_ARTIFACT_BYTES ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) || typeof artifact.createdAt !== "string") {
    throw new Error("artifact metadata is invalid.");
  }
  if (containsSecretLike(artifact.kind) || containsSecretLike(artifact.contentType)) throw new Error(SECRET_REFUSAL_MESSAGE);
  return artifact;
}

export function getArtifactMetadata(id: string, env: NodeJS.ProcessEnv = process.env): ArtifactRef {
  const path = resolveArtifactPath(id, env);
  const artifact = loadArtifactRef(id, env);
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("artifact integrity check failed.");
  return artifact;
}

export function findArtifactBySource(source: string, env: NodeJS.ProcessEnv = process.env): ArtifactRef | undefined {
  if (!source || source.length > 200 || containsSecretLike(source)) throw new Error("invalid artifact source.");
  let index: { source?: unknown; id?: unknown };
  try { index = JSON.parse(readFileSync(sourceIndexPath(source, env), "utf8")) as { source?: unknown; id?: unknown }; }
  catch { return undefined; }
  if (index.source !== source || typeof index.id !== "string" || !ID_PATTERN.test(index.id)) return undefined;
  return getArtifactMetadata(index.id, env);
}

function assertSafeText(text: string): void {
  if (containsSecretLike(text)) throw new Error(SECRET_REFUSAL_MESSAGE);
}

export function storeArtifact(
  data: Uint8Array | string,
  options: { kind: string; contentType?: string; source?: string },
  env: NodeJS.ProcessEnv = process.env,
): ArtifactRef {
  if (!options || typeof options.kind !== "string" || options.kind.length < 1 || options.kind.length > 80 || containsSecretLike(options.kind)) {
    throw new Error("artifact kind must be a nonempty string of at most 80 characters.");
  }
  const contentType = options.contentType ?? (typeof data === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
  if (typeof contentType !== "string" || contentType.length > 160 || /[\r\n]/.test(contentType) || containsSecretLike(contentType)) throw new Error("invalid artifact content type.");
  if (options.source !== undefined && (options.source.length > 200 || containsSecretLike(options.source))) throw new Error("invalid artifact source.");
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES || (typeof data === "string" && bytes.byteLength > MAX_TEXT_BYTES)) {
    throw new Error("artifact exceeds the storage size limit.");
  }
  if (typeof data === "string" || TEXT_CONTENT_TYPE.test(contentType)) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("text artifacts must contain valid UTF-8."); }
    assertSafeText(text);
  }

  const id = randomBytes(16).toString("hex");
  const ref: ArtifactRef = {
    id,
    kind: options.kind,
    contentType,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: new Date().toISOString(),
  };
  const target = join(artifactRoot(env), `${id}.bin`);
  const meta = metadataPath(id, env);
  const sourcePath = options.source === undefined ? undefined : sourceIndexPath(options.source, env);
  const sourceTemp = sourcePath === undefined ? undefined : `${sourcePath}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(dirname(target), 0o700);
  if (sourcePath !== undefined) mkdirSync(dirname(sourcePath), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(8).toString("hex");
  const dataTemp = `${target}.${nonce}.tmp`;
  const metaTemp = `${meta}.${nonce}.tmp`;
  try {
    writeFileSync(dataTemp, bytes, { mode: 0o600, flag: "wx" });
    writeFileSync(metaTemp, JSON.stringify(ref), { mode: 0o600, flag: "wx" });
    renameSync(dataTemp, target);
    renameSync(metaTemp, meta);
    if (sourcePath !== undefined && sourceTemp !== undefined) {
      if (existsSync(sourcePath)) throw new Error("artifact source already has a stored artifact.");
      writeFileSync(sourceTemp, JSON.stringify({ source: options.source, id }), { mode: 0o600, flag: "wx" });
      renameSync(sourceTemp, sourcePath);
    }
  } catch (error) {
    // A partial pair is never returned as a reference; remove temporary/partially
    // published files so callers cannot mistake an incomplete write for success.
    for (const path of [dataTemp, metaTemp, target, meta, ...(sourceTemp ? [sourceTemp] : [])]) {
      try { rmSync(path, { force: true }); } catch { /* preserve the original write error */ }
    }
    throw error;
  }
  return ref;
}

export function readArtifact(
  id: string,
  options: { offset?: number; limit?: number; encoding?: "utf8" | "base64" } = {},
  env: NodeJS.ProcessEnv = process.env,
): ArtifactRead {
  const path = resolveArtifactPath(id, env);
  const artifact = loadArtifactRef(id, env);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_READ_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.bytes) throw new Error("offset exceeds artifact size.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_BYTES) throw new Error(`limit must be between 1 and ${MAX_READ_BYTES} bytes.`);
  const actualSize = lstatSync(path).size;
  if (actualSize !== artifact.bytes) throw new Error("artifact integrity check failed.");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("artifact integrity check failed.");
  const encoding = options.encoding ?? "utf8";
  let start = offset;
  let end = Math.min(offset + limit, artifact.bytes);
  if (encoding === "utf8") {
    // Move a requested byte offset back to the beginning of its UTF-8 scalar.
    for (let n = 0; start > 0 && n < 3 && (bytes[start] & 0xc0) === 0x80; n++) start--;
    // Do not split a scalar at the end. `end` becomes the next byte cursor.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let validEnd: number | undefined;
    for (let candidate = end; candidate >= start; candidate--) {
      try { decoder.decode(bytes.subarray(start, candidate)); validEnd = candidate; break; }
      catch { /* move the end to a scalar boundary */ }
    }
    if (validEnd === start && start < bytes.length) {
      // A limit smaller than the next UTF-8 scalar would otherwise return an
      // empty page with the same cursor. Include that scalar, at most 3 bytes
      // beyond the requested window, so every non-EOF page advances.
      for (let candidate = start + 1; candidate <= Math.min(start + 4, bytes.length); candidate++) {
        try { decoder.decode(bytes.subarray(start, candidate)); validEnd = candidate; break; }
        catch { /* extend through this scalar, no farther than 4 bytes */ }
      }
    }
    if (validEnd === undefined) throw new Error("artifact contains invalid UTF-8 at the requested window.");
    end = validEnd;
  }
  const raw = bytes.subarray(start, end);
  const data = encoding === "base64" ? raw.toString("base64") : raw.toString("utf8");
  if (encoding === "utf8") assertSafeText(data);
  const next = start + raw.byteLength;
  return { artifact, offset: start, nextOffset: next < artifact.bytes ? next : null, data };
}
