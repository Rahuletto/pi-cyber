import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
// @ts-expect-error Runtime JavaScript module consumes the engine's CDP events.
import { attachRecorder } from "../src/tools/browser-network.mjs";

test("network history persists, evicts old entries, and excludes credentials", async () => {
  const cdp = Object.assign(new EventEmitter(), {send: async () => {}, detach: async () => {}});
  let sessions = 0;
  const context = {newCDPSession: async () => {sessions++; return cdp;}};
  const page = new EventEmitter();
  const recorder = await attachRecorder(context, page);
  for (let i = 0; i < 205; i++) cdp.emit("Network.requestWillBeSent", {
    requestId: String(i), timestamp: i, type: "Fetch", request: {method:"GET", url:`https://example.test/${i}`,
      headers:{Authorization:"private", Cookie:"private", Accept:"application/json"}},
  });
  cdp.emit("Network.responseReceived", {requestId:"204", response:{status:200, headers:{"Set-Cookie":"private", "Content-Type":"application/json"}}});
  cdp.emit("Network.loadingFinished", {requestId:"204", timestamp:204.25, encodedDataLength:12});
  expect(await attachRecorder(context, page)).toBe(recorder);
  expect(sessions).toBe(1);
  expect(recorder.total()).toBe(205);
  const records = recorder.take();
  expect(records).toHaveLength(200);
  expect(records[0].url).toBe("https://example.test/5");
  expect(records.at(-1)).toMatchObject({status:200, size:12, durationMs:250,
    requestHeaders:{Accept:"application/json"}, responseHeaders:{"Content-Type":"application/json"}});
  expect(JSON.stringify(records)).not.toContain("private");
});

test("explicit response capture is size bounded and only exposes a local capture reference", async () => {
  const cdp = Object.assign(new EventEmitter(), {send: async (name: string) => name === "Network.getResponseBody" ? {body:"fixture-body", base64Encoded:false} : undefined, detach: async () => {}});
  const context = {newCDPSession: async () => cdp};
  const page = new EventEmitter();
  const recorder = await attachRecorder(context, page);
  cdp.emit("Network.requestWillBeSent", {requestId:"secret-cdp-id", timestamp:1, request:{method:"GET", url:"http://127.0.0.1/fixture", headers:{Authorization:"hidden"}}});
  cdp.emit("Network.responseReceived", {requestId:"secret-cdp-id", response:{status:200, mimeType:"text/plain", headers:{"Set-Cookie":"hidden"}}});
  cdp.emit("Network.loadingFinished", {requestId:"secret-cdp-id", timestamp:2, encodedDataLength:12});
  const [entry] = recorder.take();
  expect(entry.captureId).toMatch(/^n[a-f0-9]{32}$/);
  expect(JSON.stringify(entry)).not.toContain("secret-cdp-id");
  expect(await recorder.capture(entry.captureId, 64)).toMatchObject({captureId:entry.captureId, bytes:12, contentType:"text/plain", dataBase64:Buffer.from("fixture-body").toString("base64")});
  await expect(recorder.capture(entry.captureId, 4)).rejects.toThrow(/capture limit/);
});

test("capture refs cannot be reused across page recorders even when request IDs match", async () => {
  const context = {newCDPSession: async () => Object.assign(new EventEmitter(), {
    send: async (name: string) => name === "Network.getResponseBody" ? {body:"response", base64Encoded:false} : undefined,
    detach: async () => {},
  })};
  const pageA = new EventEmitter();
  const pageB = new EventEmitter();
  const recorderA = await attachRecorder(context, pageA);
  const recorderB = await attachRecorder(context, pageB);
  for (const cdp of [recorderA.cdp, recorderB.cdp]) {
    cdp.emit("Network.requestWillBeSent", {requestId:"same-cdp-id", timestamp:1, request:{method:"GET", url:"http://127.0.0.1/fixture"}});
    cdp.emit("Network.responseReceived", {requestId:"same-cdp-id", response:{status:200, mimeType:"text/plain", headers:{}}});
    cdp.emit("Network.loadingFinished", {requestId:"same-cdp-id", timestamp:2, encodedDataLength:8});
  }
  const captureA = recorderA.take()[0].captureId;
  const captureB = recorderB.take()[0].captureId;
  expect(captureA).not.toBe(captureB);
  await expect(recorderB.capture(captureA, 64)).rejects.toThrow(/unavailable/);
  expect(await recorderB.capture(captureB, 64)).toMatchObject({captureId:captureB, bytes:8});
});
