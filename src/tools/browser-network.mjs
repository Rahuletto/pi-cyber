import { randomBytes } from "node:crypto";

/** Per-page, bounded CDP history shared by successive driver calls. */
const clampStr = (value, limit) => String(value ?? "").slice(0, limit);
const recorders = new WeakMap();
const SAFE_HEADERS = new Set(["accept", "content-type", "content-length", "user-agent", "origin", "cache-control", "server"]);
function safeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => SAFE_HEADERS.has(key.toLowerCase())).slice(0, 12).map(([key, value]) => [key, clampStr(value, 256)]));
}
export async function attachRecorder(context, page) {
  if (recorders.has(page)) return recorders.get(page);

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable").catch(() => {});
  const entries = new Map();
  const captureIds = new Map();
  const order = [];
  let total = 0;
  cdp.on("Network.requestWillBeSent", (params) => {
    const url = clampStr(params?.request?.url, 300);
    if (!/^https?:/.test(url)) return;
    const entry = {
      captureId: `n${randomBytes(16).toString("hex")}`,
      started: params.timestamp,
      requestHeaders: safeHeaders(params?.request?.headers),
      method: clampStr(params?.request?.method, 10),
      url,
      status: null,
      size: null,
      resourceType: clampStr(params?.type, 24),
    };
    if (order.includes(params.requestId)) {
      const previous = entries.get(params.requestId);
      if (previous) captureIds.delete(previous.captureId);
      order.splice(order.indexOf(params.requestId), 1);
    }
    entries.set(params.requestId, entry);
    captureIds.set(entry.captureId, params.requestId);
    total++;
    if (order.length >= 200) {
      const removedId = order.shift();
      const removed = entries.get(removedId);
      if (removed) captureIds.delete(removed.captureId);
      entries.delete(removedId);
    }
    order.push(params.requestId);
  });
  cdp.on("Network.responseReceived", (params) => {
    const entry = entries.get(params?.requestId);
    if (!entry) return;
    entry.responseHeaders = safeHeaders(params?.response?.headers);
    const declaredLength = Number(entry.responseHeaders["content-length"] ?? entry.responseHeaders["Content-Length"]);
    if (Number.isFinite(declaredLength) && declaredLength >= 0) entry.declaredSize = Math.floor(declaredLength);
    if (typeof params?.response?.status === "number") entry.status = params.response.status;
    if (params?.type) entry.resourceType = clampStr(params.type, 24);
    const mime = clampStr(params?.response?.mimeType, 60);
    if (mime) entry.mimeType = mime;
  });
  cdp.on("Network.loadingFinished", (params) => {
    const entry = entries.get(params?.requestId);
    if (!entry) return;
    entry.durationMs = Math.max(0, Math.round((params.timestamp - entry.started) * 1000));
    if (typeof params?.encodedDataLength === "number") {
      entry.size = Math.max(0, Math.floor(params.encodedDataLength));
    }
  });
  cdp.on("Network.loadingFailed", (params) => {
    const entry = entries.get(params.requestId);
    if (entry) entry.error = clampStr(params.errorText, 200);
  });
  const recorder = {
    cdp,
    take: () => order.map((id) => entries.get(id)).filter(Boolean),
    total: () => total,
    async capture(captureId, maxBytes = 512 * 1024) {
      const entry = order.map((id) => entries.get(id)).find((candidate) => candidate?.captureId === captureId);
      if (!entry) throw new Error("network captureId is unavailable; use action network again");
      if (entry.size == null) throw new Error("response has not completed; use action network after it finishes");
      if (Math.max(entry.size, entry.declaredSize ?? 0) > maxBytes) throw new Error(`response exceeds ${maxBytes} byte capture limit`);
      const requestId = captureIds.get(captureId);
      if (!requestId) throw new Error("network captureId is no longer available; use action network again");
      const response = await cdp.send("Network.getResponseBody", {requestId});
      const bytes = response.base64Encoded ? Buffer.from(response.body, "base64") : Buffer.from(response.body, "utf8");
      if (bytes.byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} byte capture limit`);
      return {captureId, contentType: entry.mimeType || "application/octet-stream", bytes: bytes.byteLength, dataBase64: bytes.toString("base64")};
    },
    async detach() { await cdp.detach().catch(() => {}); },
  };
  recorders.set(page, recorder);
  page.once("close", () => { void recorder.detach(); });
  return recorder;
}

