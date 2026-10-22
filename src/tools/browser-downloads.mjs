const states = new WeakMap();
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = {".txt":"text/plain", ".json":"application/json", ".csv":"text/csv", ".html":"text/html", ".xml":"application/xml", ".pdf":"application/pdf", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".zip":"application/zip"};

function state(context) {
  let value = states.get(context);
  if (!value) { value = {items: []}; states.set(context, value); }
  return value;
}
export function watchDownloads(context, page) {
  const s = state(context);
  const watched = new Map();
  const attach = (target) => {
    if (watched.has(target)) return;
    const onDownload = (download) => {
    if (s.items.length >= 20) s.items.shift();
    s.items.push({download, filename: String(download.suggestedFilename?.() ?? "download").replace(/[\\/\0-\x1f]/g, "_").slice(0, 160), createdAt: new Date().toISOString()});
    };
    target.on("download", onDownload);
    watched.set(target, onDownload);
  };
  const onPage = (target) => attach(target);
  context.on?.("page", onPage);
  attach(page);
  return () => { context.off?.("page", onPage); for (const [target, handler] of watched) target.off("download", handler); };
}
export function listDownloads(context) {
  return state(context).items.map((item, index) => ({index, filename: item.filename, createdAt: item.createdAt}));
}
export async function exportDownload(context, index) {
  const item = state(context).items[index];
  if (!item) throw new Error("download index is unavailable; use action downloads");
  const failure = await item.download.failure();
  if (failure) throw new Error(`download failed: ${String(failure).slice(0, 160)}`);
  const stream = await item.download.createReadStream();
  if (!stream) throw new Error("download content is unavailable from the browser engine");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BYTES) throw new Error(`download exceeds ${MAX_BYTES} byte capture limit`);
    chunks.push(buffer);
  }
  const ext = item.filename.includes(".") ? item.filename.slice(item.filename.lastIndexOf(".")).toLowerCase() : "";
  return {filename: item.filename, contentType: TYPES[ext] || "application/octet-stream", bytes, dataBase64: Buffer.concat(chunks, bytes).toString("base64")};
}
