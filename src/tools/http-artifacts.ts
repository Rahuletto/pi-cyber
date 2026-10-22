import { readFileSync } from "node:fs";
import { resolveArtifactPath, storeArtifact, type ArtifactRef } from "../artifacts/store.ts";

export interface HttpMultipartFile {
  field: string;
  artifactId: string;
  filename: string;
  contentType?: string;
}

export function artifactBytes(id: string): Uint8Array {
  return readFileSync(resolveArtifactPath(id));
}

export function artifactPath(id: string): string {
  return resolveArtifactPath(id);
}

export function validateMultipart(files: HttpMultipartFile[]): void {
  if (files.length > 8) throw new Error("at most 8 multipart files are allowed.");
  for (const file of files) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(file.field)) throw new Error("invalid multipart field name.");
    if (!/^[A-Za-z0-9_. -]{1,160}$/.test(file.filename) || file.filename === "." || file.filename === "..") throw new Error("invalid multipart filename.");
    if (file.contentType && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.contentType)) throw new Error("invalid multipart content type.");
  }
}

export function saveHttpResponseArtifact(bytes: Uint8Array, contentType: string, source: string): ArtifactRef {
  return storeArtifact(bytes, { kind: "http-response", contentType: contentType || "application/octet-stream", source });
}

export function redactResponseHeaders(raw: string): Array<{ name: string; value: string }> {
  const sensitive = /(?:cookie|auth|token|secret|password|api.?key)/i;
  const rows: Array<{ name: string; value: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    if (!/^[!#$%&'*+\-.^_`A-Za-z0-9~]+$/.test(name)) continue;
    const value = line.slice(i + 1).trim();
    rows.push({ name, value: sensitive.test(name) ? "[redacted]" : name.toLowerCase() === "location" ? sanitizeLocation(value) : value.slice(0, 2048) });
    if (rows.length >= 100) break;
  }
  return rows;
}

/** Return headers from the final response block; redirects remain separate provenance. */
export function finalResponseHeaders(raw: string): string {
  const blocks = raw.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/\S+\s+\d{3}/im.test(block));
  return blocks.at(-1) ?? "";
}

function sanitizeLocation(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2048);
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 2048);
  }
}

export function parseRedirectHeaders(raw: string): Array<{ status: number; location: string | null }> {
  return raw.split(/\r?\n\r?\n/).map((block) => {
    const status = /^HTTP\/\S+\s+(\d{3})/im.exec(block)?.[1];
    if (!status) return null;
    const rawLocation = /^location:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? null;
    const location = rawLocation ? sanitizeLocation(rawLocation) : null;
    return { status: Number(status), location };
  }).filter((x): x is { status: number; location: string | null } => x !== null).slice(0, 9);
}
