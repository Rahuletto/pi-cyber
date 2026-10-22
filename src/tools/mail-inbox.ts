import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveCowbirdPython, resolveCowbirdCommand } from "./mailgen.ts";

const execFileAsync = promisify(execFile);
const SCRIPT = String.raw`
import asyncio, base64, contextlib, json, sys, time
from datetime import datetime
from cowbird.health import HealthStore, default_health_path
from cowbird.inbox import Inbox, aclose_default_pool, default_pool
from cowbird.models import Address
from cowbird.errors import NotSupported

async def main():
    action, provider_name, address, state, message_id, sender_filter, subject_filter, after, cursor, after_id, limit, timeout = sys.argv[1:13]
    pool = default_pool()
    with contextlib.suppress(Exception): pool.health.seed(HealthStore.load(default_health_path()))
    provider = pool.registry.get(provider_name)
    box = Inbox(provider, Address(address, provider_name, state=state or None))
    try:
        deadline = time.monotonic() + float(timeout)
        while True:
            try: rows = await box.messages()
            except NotSupported as exc:
                print(json.dumps({'capabilityError': True, 'message': str(exc)[:300]})); return
            rows = sorted(rows, key=lambda r: (r.received_at.timestamp() if r.received_at else 0, r.id), reverse=True)
            if action == 'read':
                row = next((r for r in rows if r.id == message_id), None)
                if row is None: raise ValueError('message id not found in this inbox')
                message = await box.get(row.id)
                print(json.dumps({'id': row.id, 'sender': str(row.sender or ''), 'subject': str(row.subject or ''), 'receivedAt': row.received_at.isoformat() if row.received_at else None, 'text': (message.text or '')[:4000], 'truncated': len(message.text or '') > 4000, 'links': list(message.links or [])[:8]}))
                return
            filtered = []
            anchor = None
            if cursor:
                try: anchor = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
                except Exception: raise ValueError('invalid cursor')
                if anchor.get('address') != address or anchor.get('provider') != provider_name: raise ValueError('cursor belongs to another inbox')
            wait_anchor = None
            if action == 'wait' and after_id:
                base = next((r for r in rows if r.id == after_id), None)
                if base is None: raise ValueError('afterMessageId not found in this inbox')
                wait_anchor = (base.received_at.timestamp() if base.received_at else 0, base.id)
            for row in rows:
                ts = row.received_at.timestamp() if row.received_at else 0
                sender = str(row.sender or '')
                subject = str(row.subject or '')
                if sender_filter and sender_filter.casefold() not in sender.casefold(): continue
                if subject_filter and subject_filter.casefold() not in subject.casefold(): continue
                if after:
                    try: cutoff = datetime.fromisoformat(after.replace('Z', '+00:00')).timestamp()
                    except Exception: raise ValueError('receivedAfter must be an ISO timestamp')
                    if ts <= cutoff: continue
                if anchor and (ts, row.id) >= (float(anchor['ts']), str(anchor['id'])): continue
                if wait_anchor and (ts, row.id) <= wait_anchor: continue
                filtered.append(row)
            if filtered or action == 'list' or time.monotonic() >= deadline: break
            await asyncio.sleep(min(2.0, max(0.1, deadline-time.monotonic())))
        cap = max(1, min(int(limit), 50))
        page = filtered[:cap]
        if action == 'wait' and page:
            row = page[0]
            try: message = await box.get(row.id)
            except NotSupported as exc:
                print(json.dumps({'capabilityError': True, 'message': str(exc)[:300]})); return
            print(json.dumps({'id': row.id, 'sender': str(row.sender or ''), 'subject': str(row.subject or ''), 'receivedAt': row.received_at.isoformat() if row.received_at else None, 'text': (message.text or '')[:4000], 'truncated': len(message.text or '') > 4000, 'links': list(message.links or [])[:8]}))
            return
        next_cursor = None
        if len(filtered) > cap:
            last = page[-1]
            token = {'address': address, 'provider': provider_name, 'ts': last.received_at.timestamp() if last.received_at else 0, 'id': last.id}
            next_cursor = base64.urlsafe_b64encode(json.dumps(token, separators=(',', ':')).encode()).decode().rstrip('=')
        output = []
        for row in page:
            output.append({'id': row.id, 'sender': str(row.sender or ''), 'subject': str(row.subject or ''), 'receivedAt': row.received_at.isoformat() if row.received_at else None})
        print(json.dumps({'messages': output, 'nextCursor': next_cursor, 'matched': len(filtered)}))
    finally: await aclose_default_pool()

asyncio.run(main())
`;

export interface InboxQuery {
  action: "list" | "read" | "wait";
  provider: string;
  address: string;
  messageId?: string;
  sender?: string;
  subject?: string;
  receivedAfter?: string;
  cursor?: string;
  afterMessageId?: string;
  limit?: number;
  timeoutSec?: number;
}

export async function queryCowbirdInbox(query: InboxQuery, signal?: AbortSignal): Promise<string> {
  let state = "";
  const registryPath = process.env.CYBER_MAILGEN_FILE?.trim() || join(homedir(), ".pi", "scanners", "mailgen-registry.json");
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { provider?: string; state?: string }>;
    const saved = registry[query.address];
    if (saved?.provider && saved.provider !== query.provider) {
      throw new Error(`inbox ${query.address} is registered to provider ${saved.provider}; refusing provider ${query.provider}.`);
    }
    if (saved?.state && !saved.provider) {
      throw new Error(`inbox ${query.address} has unbound provider state; refusing to send it to provider ${query.provider}.`);
    }
    state = saved?.state ?? "";
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("refusing provider") || message.includes("unbound provider state")) throw error;
    // Missing or malformed local registry means there is no state to replay.
  }
  const python = resolveCowbirdPython();
  if (!python || !resolveCowbirdCommand()) throw new Error("cowbird Inbox API unavailable; install its Python environment or configure CYBER_COWBIRD_PYTHON.");
  const args = ["-c", SCRIPT, query.action, query.provider, query.address, state, query.messageId ?? "", query.sender ?? "", query.subject ?? "", query.receivedAfter ?? "", query.cursor ?? "", query.afterMessageId ?? "", String(query.limit ?? 20), String(query.timeoutSec ?? 0)];
  try {
    const { stdout } = await execFileAsync(python, args, { encoding: "utf8", timeout: Math.max(20_000, (query.timeoutSec ?? 0) * 1000 + 10_000), maxBuffer: 2 * 1024 * 1024, signal });
    const output = stdout.trim();
    try {
      const payload = JSON.parse(output) as { capabilityError?: boolean; message?: string };
      if (payload.capabilityError) throw new Error(`provider does not support Inbox ${query.action}: ${payload.message ?? "operation unavailable"}`);
    } catch (error) {
      if ((error as Error).message.startsWith("provider does not support Inbox")) throw error;
    }
    return output;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const message = (err.stderr ?? err.message).trim().split("\n").slice(-1)[0] ?? "Inbox API failed";
    throw new Error(`cowbird Inbox ${query.action} failed: ${message.slice(0, 300)}`);
  }
}
