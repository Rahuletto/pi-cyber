/**
 * Long-lived browser session, one per profile directory.
 *
 * The one-shot driver exits after every call, which throws away the window —
 * so a tab the operator opens by hand (closing a suspected Cloudflare tab and
 * reopening a fresh one that finally passes) lives in a browser the next call
 * never sees. This module keeps the context alive in a detached daemon and
 * lets later calls attach to it over a localhost socket.
 *
 * Protocol: one JSON spec per connection, one JSON result line back, then the
 * connection closes. The daemon exits itself after the context is shut down.
 * The endpoint file `<profileDir>/.browser-session.json` holds {port, token};
 * its token is checked on every call so a stray client cannot drive it.
 */
import { createServer, connect } from "node:net";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const ENDPOINT_FILE = ".browser-session.json";

export function endpointPath(profileDir) {
  return join(profileDir, ENDPOINT_FILE);
}

/** Read a live endpoint, or null when none is published. */
export function readEndpoint(profileDir) {
  try {
    const parsed = JSON.parse(readFileSync(endpointPath(profileDir), "utf8"));
    if (typeof parsed.port === "number" && typeof parsed.token === "string") return parsed;
  } catch { /* no session yet */ }
  return null;
}

/**
 * Send one spec to a running daemon and resolve its JSON result. Rejects when
 * nothing is listening, so the caller can fall back to launching.
 */
export function sendSpec(port, token, spec) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.setTimeout(Math.min(Math.max(Number(spec.timeoutMs ?? 60_000), 1_000), 180_000) + 45_000, () => fail(new Error("browser session did not answer")));
    socket.on("error", fail);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ ...spec, sessionToken: token }) + "\n");
    });
    socket.setEncoding("utf8");
    socket.on("end", () => { if (!buffer.includes("\n")) fail(new Error("browser session closed without a result")); });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      socket.end();
      try { resolve(JSON.parse(buffer.slice(0, nl))); }
      catch (error) { reject(error); }
    });
  });
}

/**
 * Become the daemon for this context. Listens on an ephemeral localhost port,
 * publishes the endpoint, and dispatches each spec through `handle(spec)`.
 * Resolves once the endpoint is ready, returning a `closed` promise that
 * resolves after a shutdown spec releases the context.
 */
export function serve(profileDir, context, handle) {
  const token = randomBytes(24).toString("hex");
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  return new Promise((resolve, reject) => {
    // Calls share one context; serialize them so actions cannot interleave.
    const IDLE_MS = 3 * 60 * 1000;
    let idle;
    let queue = Promise.resolve();
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(idle);
      server.close();
      try { rmSync(endpointPath(profileDir), { force: true }); } catch { /* already gone */ }
      await context.close().catch(() => {});
      resolveClosed();
    };
    const arm = () => {
      clearTimeout(idle);
      if (!stopping) idle = setTimeout(() => { void shutdown(); }, IDLE_MS);
    };
    const server = createServer((socket) => {
      let buffer = "";
      let received = false;
      socket.setEncoding("utf8");
      socket.on("error", () => { /* a caller can leave before its action ends */ });
      socket.on("data", (chunk) => {
        if (received) return;
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        received = true;
        clearTimeout(idle);
        queue = queue.then(async () => {
          clearTimeout(idle);
          let result;
          try {
            const spec = JSON.parse(buffer.slice(0, nl));
            if (spec.sessionToken !== token) throw new Error("browser session rejected the call");
            result = await handle(spec);
          } catch (error) {
            result = { ok: false, error: String(error?.message ?? error).slice(0, 300) };
          }
          socket.end(JSON.stringify(result) + "\n");
          if (result?.shutdown) await shutdown();
          else arm();
        });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      try {
        const port = server.address().port;
        writeFileSync(endpointPath(profileDir), JSON.stringify({ port, token }), { mode: 0o600 });
        arm();
        resolve({ closed });
      } catch (error) { server.close(); reject(error); }
    });
  });
}
