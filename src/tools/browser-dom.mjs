import { randomBytes } from "node:crypto";

const pages = new WeakMap();
const LIMIT = 80;

export async function snapshotDom(page, frame = undefined) {
  const target = frame === undefined ? page : page.frames()[frame];
  if (!target || target.isDetached?.()) throw new Error("frame is no longer available; use action frames");
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const snapshotId = randomBytes(8).toString("hex");
  let states = pages.get(page);
  if (!states) { states = new Map(); pages.set(page, states); }
  const frameKey = frame ?? -1;
  const rows = await target.evaluate(({token, limit, snapshotId}) => {
    Object.defineProperty(window, "__cyberDomDocument", {value: token, configurable: true});
    const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link]"))
      .filter((el) => el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true");
    return nodes.slice(0, limit).map((el, index) => {
      const ref = `r${snapshotId}-${index + 1}`;
      el.setAttribute("data-cyber-ref", ref);
      return {ref, tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", text: String(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 160), type: String(el.getAttribute("type") || "").slice(0, 30), href: el instanceof HTMLAnchorElement ? el.href.slice(0, 300) : undefined, disabled: Boolean(el.disabled)};
    });
  }, {token, limit: LIMIT, snapshotId});
  const documentId = await target.evaluate(() => window.__cyberDomDocument);
  states.set(frameKey, {documentId, refs: new Set(rows.map((row) => row.ref))});
  return {dom: rows, domCount: rows.length, domTruncated: rows.length === LIMIT};
}

export async function elementSelector(page, frame, ref) {
  const states = pages.get(page);
  const state = states?.get(frame ?? -1);
  if (!state || !state.refs.has(ref)) throw new Error("unknown or stale element ref; request action domSnapshot again");
  const target = frame === undefined ? page : page.frames()[frame];
  if (!target || target.isDetached?.()) throw new Error("element ref frame is stale; request action domSnapshot again");
  const current = await target.evaluate(() => window.__cyberDomDocument).catch(() => null);
  if (current !== state.documentId) throw new Error("element ref is stale after navigation; request action domSnapshot again");
  return `[data-cyber-ref="${ref}"]`;
}
