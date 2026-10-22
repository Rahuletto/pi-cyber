import { elementSelector } from "./browser-dom.mjs";

/** Stable page identities live for the lifetime of a profile daemon. */
const registries = new WeakMap();
function registry(context) {
  let state = registries.get(context);
  if (!state) { state = { ids: new WeakMap(), next: 1, selected: null }; registries.set(context, state); }
  return state;
}
export function openPages(context) {
  return context.pages().filter((page) => !page.isClosed());
}
export function describeTabs(context) {
  const state = registry(context);
  return openPages(context).map((page, index) => {
    if (!state.ids.has(page)) state.ids.set(page, `t${state.next++}`);
    return { index, id: state.ids.get(page), url: String(page.url()).slice(0, 500) };
  });
}
export function selectTab(context, spec) {
  const pages = openPages(context);
  const tabs = describeTabs(context);
  let index;
  if (spec.tabId !== undefined) index = tabs.findIndex((tab) => tab.id === spec.tabId);
  else if (spec.tabUrl !== undefined) {
    const matches = pages.map((page, index) => ({index, url: page.url()})).filter((tab) => tab.url === spec.tabUrl);
    if (matches.length !== 1) throw new Error(`tabUrl must match exactly one open tab (matched ${matches.length})`);
    index = matches[0].index;
  } else if (spec.tab !== undefined) index = spec.tab;
  else return pages.includes(registry(context).selected) ? registry(context).selected : pages.at(-1);
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error("requested tab is no longer open; use action tabs");
  return pages[index];
}
export function rememberTab(context, page) { registry(context).selected = page; }
export function tabMetadata(context, page) {
  const tabs = describeTabs(context);
  const tab = openPages(context).indexOf(page);
  return { tabs, tab, tabId: tabs[tab]?.id ?? null };
}
export function resolveFrame(page, index) {
  if (index === undefined) return page;
  const frame = page.frames()[index];
  if (!frame || frame.isDetached()) throw new Error(`frame ${index} is no longer available; use action frames`);
  return frame;
}
export function describeFrames(page) {
  return page.frames().map((frame, index) => ({ index, name: frame.name(), url: String(frame.url()).slice(0, 500) }));
}

/** Locator actions wait for actionability and re-resolve detached DOM nodes. */
export async function interact(page, step, timeout, defaultFrame) {
  const target = resolveFrame(page, step.frame ?? defaultFrame);
  const options = { timeout };
  const selector = step.ref ? await elementSelector(page, step.frame ?? defaultFrame, step.ref) : step.sel;
  const locator = selector ? target.locator(selector) : null;
  switch (step.op) {
    case "click": await locator.click(options); break;
    case "fill": await locator.fill(String(step.value ?? ""), options); break;
    case "hover": await locator.hover(options); break;
    case "check": await locator.check(options); break;
    case "uncheck": await locator.uncheck(options); break;
    case "select": return { ok: true, result: await locator.selectOption(String(step.value ?? ""), options) };
    case "press":
      if (locator) await locator.press(String(step.value ?? "Enter"), options);
      else if (step.frame !== undefined || defaultFrame !== undefined) throw new Error("press in a frame requires sel");
      else await page.keyboard.press(String(step.value ?? "Enter"));
      break;
    case "waitSel": await locator.waitFor({ ...options, state: step.state ?? "visible" }); break;
    case "waitURL": await target.waitForURL(String(step.value), { ...options, waitUntil: "domcontentloaded" }); break;
    case "waitLoad": await target.waitForLoadState(step.value || "domcontentloaded", options); break;
    default: throw new Error(`unsupported interaction ${step.op}`);
  }
  return { ok: true };
}
