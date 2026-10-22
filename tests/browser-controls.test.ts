import { expect, test } from "bun:test";
// @ts-expect-error JavaScript module owns Playwright runtime objects.
import { describeTabs, selectTab, rememberTab, resolveFrame, interact } from "../src/tools/browser-controls.mjs";
// @ts-expect-error JavaScript module owns document-bound references.
import { snapshotDom } from "../src/tools/browser-dom.mjs";

test("stable tab IDs survive closures and selection rejects ambiguous URLs", () => {
  const first = {url: () => "https://example.test/", isClosed: () => false};
  const second = {url: () => "https://example.test/", isClosed: () => false};
  let pages = [first, second];
  const context = {pages: () => pages};
  expect(describeTabs(context)).toMatchObject([{id:"t1"}, {id:"t2"}]);
  expect(() => selectTab(context, {tabUrl:"https://example.test/"})).toThrow(/exactly one/);
  rememberTab(context, first);
  expect(selectTab(context, {})).toBe(first);
  pages = [second];
  expect(selectTab(context, {tabId:"t2"})).toBe(second);
  expect(() => selectTab(context, {tabId:"t1"})).toThrow(/no longer open/);
  expect(describeTabs(context)).toMatchObject([{index:0, id:"t2"}]);
});

test("frame selection fails closed and frame presses require a selector", async () => {
  const frame = {isDetached: () => false};
  const page = {frames: () => [frame]};
  expect(resolveFrame(page, 0)).toBe(frame);
  expect(() => resolveFrame(page, 1)).toThrow(/no longer available/);
  await expect(interact(page, {op:"press",frame:0,value:"Enter"}, 100)).rejects.toThrow(/requires sel/);
});

test("DOM refs are snapshot-unique across pages and frames and stale after resnapshot/navigation", async () => {
  function makeTarget(label: string) {
    let documentId = `${label}-document`;
    const selectors: string[] = [];
    const target: any = {
      isDetached: () => false,
      evaluate: async (_fn: unknown, arg?: {token: string; snapshotId: string}) => arg
        ? (documentId = arg.token, [{ref:`r${arg.snapshotId}-1`, tag:"button", text:"Continue"}])
        : documentId,
      locator: (selector: string) => { selectors.push(selector); return {click: async () => {}}; },
      selectors,
      navigate: () => { documentId = `${label}-after-navigation`; },
    };
    return target;
  }
  function makePage(label: string) {
    const page = makeTarget(label);
    const childFrames = [makeTarget(`${label}-frame-a`), makeTarget(`${label}-frame-b`)];
    page.frames = () => [page, ...childFrames];
    return {page, childFrames};
  }

  const first = makePage("page-a");
  const second = makePage("page-b");
  const firstPageRef = (await snapshotDom(first.page)).dom[0].ref;
  const secondPageRef = (await snapshotDom(second.page)).dom[0].ref;
  expect(firstPageRef).not.toBe(secondPageRef);
  await expect(interact(second.page, {op:"click", ref:firstPageRef}, 100)).rejects.toThrow(/unknown or stale/);
  await interact(second.page, {op:"click", ref:secondPageRef}, 100);

  const frameARef = (await snapshotDom(first.page, 1)).dom[0].ref;
  const frameBRef = (await snapshotDom(first.page, 2)).dom[0].ref;
  expect(frameARef).not.toBe(frameBRef);
  await expect(interact(first.page, {op:"click", frame:2, ref:frameARef}, 100)).rejects.toThrow(/unknown or stale/);
  await interact(first.page, {op:"click", frame:2, ref:frameBRef}, 100);

  const refreshedRef = (await snapshotDom(first.page)).dom[0].ref;
  await expect(interact(first.page, {op:"click", ref:firstPageRef}, 100)).rejects.toThrow(/unknown or stale/);
  await interact(first.page, {op:"click", ref:refreshedRef}, 100);
  first.page.navigate();
  await expect(interact(first.page, {op:"click", ref:refreshedRef}, 100)).rejects.toThrow(/stale after navigation/);
});
