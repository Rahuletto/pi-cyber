# First engagement: Cyberbench on loopback

A runnable walkthrough of the harness against the repository's own vulnerable fixture.
Every command below exists in this repository or is a documented operator action on an
installed binary; nothing is invented. All traffic stays on `127.0.0.1`.

**Safety.** `fixtures/cyberbench/` is a local fixture. It binds loopback only, keeps state in
in-memory sqlite, and must never be deployed or pointed at another host. Use the seeded
identities `member/memberpw` and `admin/adminpw` only.

**What this walkthrough proves.** The launcher, the naabu typed-tool path, the evidence ledger,
the mode switch and the remediation loop were exercised on loopback. Several other adapters
still have documented flag or required-parameter drift. It does **not** prove a
real engagement, a real browser, an MCP registration or a provider call — see
[Unproven by this walkthrough](#unproven-by-this-walkthrough).

---

## 0. Preconditions (once per host)

```sh
export PATH="$HOME/.pi/tools/bin:$PATH"   # only needed when launching Pi directly
bun install --frozen-lockfile
bash tools/install.sh -n                   # dry run: prints the download plan, touches nothing
bash tools/validate.sh                    # probes installed binaries only (no network)
```

The typed adapters spawn `Bun.spawn([adapter.bin, ...])` and resolve binaries through `PATH`.
The `bun run pi` launcher adds `~/.pi/tools/bin` (or `$PI_TOOLS_DIR/bin`) automatically; direct
Pi invocations must add it themselves. Without it adapter tools fail with
`Executable not found in $PATH: "httpx"`. `tools/install.sh` installs
into `$PI_TOOLS_DIR/bin` (default `~/.pi/tools/bin`) and `tools/validate.sh` records
`installed` → `validated` in `$PI_TOOLS_DIR/state.json` (default `~/.pi/tools/state.json`).

---

## 1. Start the fixture

From the repository root:

```sh
bun fixtures/cyberbench/app.ts
# → cyberbench: http://127.0.0.1:4747 (local fixture only — never deploy)
```

- Fixed port `4747`; `CYBERBENCH_PORT=4748 bun fixtures/cyberbench/app.ts` overrides it
  (`defaultPort()` in `fixtures/cyberbench/app.ts`).
- Loopback only (`HOST = "127.0.0.1"`).
- State is in-memory: every restart resets the seeded users and orders.

Optional smoke check (boots on a free port, then closes):

```sh
bun test tests/fixtures/cyberbench.smoke.test.ts
```

Seeded route map (also in `fixtures/cyberbench/README.md`):

| Route (method) | Auth | Seeded fault |
| --- | --- | --- |
| `POST /login` | no | auth entry (form or JSON) |
| `POST /logout` | no | invalidates the presented token |
| `GET /api/balance?user=` | yes | IDOR across users — no ownership check |
| `GET /api/admin/users` | yes | broken authorization — role check missing |
| `POST /api/upload` | yes | path traversal — unvalidated upload filename |
| `GET /api/orders?id=` | yes | tenant-boundary IDOR — no tenant scoping |
| `GET /debug/session` | yes | secret disclosure — raw token + API key |
| `GET /robots.txt` | no | benign |

---

## 2. `bun run doctor` — expect the validated core

```sh
bun run doctor          # `bun run doctor --json` is accepted; the script always prints JSON
```

Expected on this host (platform `darwin` / `arm64`): 16 tools `validated`, 8 `cataloged`.

| Validated (16) | Cataloged (8) |
| --- | --- |
| `subfinder`, `dnsx`, `httpx`, `katana`, `nuclei`, `uncover`, `vulnx`, `interactsh-client`, `naabu`, `ffuf`, `obscura`, `semgrep`, `trivy`, `osv-scanner`, `gitleaks`, `syft` | `zap`, `nmap`, `rea`, `ghidra`, `jdk21`, `understand-anything`, `piebald-claude-code-system-prompts`, `awesome-claude-code` |

Runtime inventory: `bun`, `node`, `pi`, `rg`, `git` available; `ast-grep` / `sg` absent.

The doctor reads `PATH` metadata and the operator state file. It never executes a tool, never
probes a target and never claims a version — `vulnx` and `obscura` are `validated` on a
`--help` marker probe (`help-ok`), not on a version string.

---

## 3. Launch Pi

```sh
bun run pi
```

`scripts/pi.sh` resolves the repository root, defaults `PI_CODING_AGENT_DIR` to `config/cyber`
in this repo (override it to use another dedicated profile), `cd`s to the repository root so
specialist roles, the evidence store and job artifacts resolve, and finally runs
`node_modules/.bin/pi -e src/index.ts`. The AST extension is added with `AST=1 bun run pi`;
`scripts/pi.sh` forwards no other CLI arguments, so `bun run pi --help` starts a session rather
than printing help.

A fresh session starts in **OFFENSE**. The mode badge is red in offense and blue in defense;
the theme stays blue in both.

---

## 4. Record scope and objective (`cyber_state`)

Read first, then replace the fields (lists replace their previous values):

```json
{"action": "get"}
```

```json
{
  "action": "update",
  "patch": {
    "scope": ["http://127.0.0.1:4747 only — local Cyberbench fixture"],
    "objective": "Validate the seeded access-control and upload path-handling faults, keep evidence references, and prepare a defense remediation handoff",
    "coverage": ["Signed-out route behavior", "Member identity", "Admin identity"],
    "nextSteps": ["Map routes and role behavior before active requests"]
  }
}
```

`scope` and `objective` are shared across modes; `coverage`, `evidenceRefs` and `nextSteps` are
stored per mode. The state rejects raw-secret-looking text — keep credentials out of it.

---

## 5. Offense lane

### 5a. What the typed tools can actually reach on loopback

Measured on this host against `http://127.0.0.1:4747` with the installed binaries
(`~/.pi/tools/bin`, versions from `~/.pi/tools/state.json`):

| Tool | Feasible offline | Measured result |
| --- | --- | --- |
| `naabu` | yes | **2 rows** — `{"ip":"127.0.0.1","port":4747,"protocol":"tcp","tls":false}` (twice) |
| `httpx` | yes | Previously emitted no rows because targets were positional; adapter now passes repeated `-u` targets, retest pending |
| `katana` | yes | Previously emitted no rows because targets were positional; adapter now passes repeated `-u` targets, retest pending |
| `nuclei` | yes | Previously exited 2 on `-json`; adapter now emits `-jsonl`, retest pending |
| `ffuf` | yes | Set `CYBER_FFUF_WORDLIST` to an operator-owned wordlist path; the adapter passes it as `-w` |
| `subfinder`, `dnsx` | no | passive/active DNS against real domains; a loopback fixture has no domain to resolve |
| `uncover` | no | queries search indexes (Shodan/Censys) with credentials and free limits |
| `vulnx` | no | CVE advisory lookup against an upstream dataset |
| `interactsh` | no | needs an OOB callback server; the run ends at the job timeout |
| `semgrep` | yes (static, local paths) | job `succeeded`, exit 0, **0 findings** on the fixture source with `p/owasp-top-ten` and with `auto` — a clean scan is one observation, never proof of absence |

`semgrep` is installed with uv from its PyPI wheel (`~/.pi/tools/uv/semgrep/bin/semgrep`, symlinked
into `~/.pi/tools/bin`); the rule set is fetched from the semgrep registry on first use and
cached locally afterwards.

`naabu` produces evidence rows through the typed tools, while `semgrep` runs cleanly but finds
nothing on this fixture. The corrected web adapter flags are covered by argv tests; the
walkthrough still requires a loopback rerun to establish scanner execution and parsed
evidence.

Working typed call (this is the only adapter run that produced rows):

```json
{"hosts": ["127.0.0.1"], "ports": [4747]}
```

via the `naabu` tool, or through the generic runner:

```json
{"action": "run", "tool": "naabu", "params": {"hosts": ["127.0.0.1"], "ports": [4747]}}
```

Operator-side workaround for the drifted adapters (outside the model lane, run by the operator
in the same terminal, not by the coordinator):

```sh
PATH="$HOME/.pi/tools/bin:$PATH" httpx -u http://127.0.0.1:4747 -json     # → 1 JSON line, status_code 200
PATH="$HOME/.pi/tools/bin:$PATH" katana -u http://127.0.0.1:4747 -jsonl   # → 1 JSONL crawl record
PATH="$HOME/.pi/tools/bin:$PATH" nuclei -u http://127.0.0.1:4747 -jsonl   # → robots-txt + missing-security-headers findings
```

`nuclei` needs templates; it auto-downloads them into `~/nuclei-templates` on first run
(14,036 templates were installed on this host during this walkthrough). A template set is a
network fetch — run it deliberately, not inside a scoped engagement.

### 5b. Route × role matrix (member / admin sign-in)

The seeded faults are **authorization** faults: they need a session token. No adapter schema in
this repo carries a header or cookie parameter, so the adapter lane alone cannot reach them.
Two supported ways to get a token:

1. **Browser lane (optional, per the plan).** `cyber_browser` books the single-owner Obscura
   lease; it never launches or downloads a browser.

   ```json
   {"action": "acquire", "mode": "read", "purpose": "recon"}
   ```

   `mode: "read"` books the slot passively; `mode: "act"` additionally requires an installed
   `obscura`. The Obscura MCP server itself must be registered by the operator — **not
   registered and not verified on this host**, so the browser path is optional and unproven
   here. Release with `{"action": "release", "sessionId": "<id>"}`.
2. **Operator-approved HTTP client in the same session.** The fixture's own credentials are
   seeded test identities, so this is a documented local exercise.

Measured matrix (member = tenant `alpha`, admin = tenant `beta`):

| Route | Signed out | `member` | `admin` | Seeded fault |
| --- | --- | --- | --- | --- |
| `GET /api/balance?user=admin` | `401` | **`200` — reads another user's balance** | `200` (own) | IDOR, no ownership check |
| `GET /api/admin/users` | `401` | **`200` — member lists every account** | `200` | broken role check |
| `GET /api/orders?id=9001` (beta order) | `401` | **`200` — `tenantMismatch: true`** | `200` | tenant IDOR |
| `GET /api/orders?id=5001` (alpha order) | `401` | `200` | `404` after the fix, `200` before | tenant scoping |
| `POST /api/upload` `name=../escaped-marker.txt` | `401` | **`200` — stored outside `uploads/`** | same | path traversal |
| `GET /debug/session` | `401` | `200` — leaks raw token + `sk-live-…` key | same | secret disclosure |

Reproduction with the operator client (the token is a seeded fixture credential; it must never
be pasted into `cyber_state` or `cyber_evidence`):

```sh
B=http://127.0.0.1:4747
TOKEN=$(curl -s -X POST "$B/login" -H 'content-type: application/json' \
  -d '{"username":"member","password":"memberpw"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -s -w '\nstatus=%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$B/api/balance?user=admin"
curl -s -w '\nstatus=%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$B/api/admin/users"
curl -s -w '\nstatus=%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$B/api/orders?id=9001"
curl -s -w '\nstatus=%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$B/api/balance?user=member"   # 401 control

curl -s -w '\nstatus=%{http_code}\n' -X POST "$B/api/upload" -H "Authorization: Bearer $TOKEN" \
  -F 'name=../escaped-marker.txt' -F 'file=@/dev/null;filename=marker.txt'
```

Measured responses (this host, 2026-10-21):

```text
{"user":"admin","tenant":"beta","balance":900000}                status=200
{"users":[{"username":"member",...},{"username":"admin",...}],"requestedBy":"member"}   status=200
{"id":9001,"tenant":"beta",...,"tenantMismatch":true}             status=200
{"error":"authentication required"}                               status=401
{"stored":"escaped-marker.txt","bytes":0,"uploader":"member"}      status=200
```

`stored: "escaped-marker.txt"` (not `uploads/escaped-marker.txt`) is the traversal proof: the
write landed in the fixture root instead of `uploads/`. The fixture's own safety rail keeps the
write inside the fixture root, so the demonstrated impact is *write outside the intended upload
directory*, not an arbitrary filesystem write.

### 5c. Record the lane's state

Update `cyber_state` coverage with every route, identity, negative result and gap — including
the corrected adapters whose live retest is pending and the browser path that was not exercised.

---

## 6. Confirm evidence rows accumulate

```json
{"action": "summary"}
```

Expected shape (counters come from the ledger, not from the transcript):

```text
EVIDENCE · mode offense · events N · evidence N · findings N · jobs N · sessions N (0 active)
Recent: #12 2026-10-21T… job | #11 2026-10-21T… evidence | …
```

```json
{"action": "read", "limit": 20}
```

- Store path: `config/cyber/evidence/<engagement>/cyber.sqlite`; `CYBER_EVIDENCE_DIR` and
  `CYBER_ENGAGEMENT_ID` override it.
- Every adapter row lands as evidence with `kind` = the adapter's artifact kind (`jsonl`,
  `json`, `raw`, `sarif`) and `refs` = `[jobId, key]`.
- The store refuses secret-like text (`possible raw secret: store a redacted artifact
  reference instead.`). The seeded `sk-live-…` key and `Bearer <token>` strings are refused —
  store a redacted reference plus a fingerprint, never the value.
- `{"action": "findings"}` lists finding lifecycle rows; add `"diagram": true` for the mermaid
  lifecycle map.

---

## 7. Switch to defense

```text
/defense
```

The switch is guarded: it is refused while the agent is running, a tool is in flight, or
messages are queued. Scope and objective survive the switch; coverage, evidence references and
next steps are per mode, so re-record the defense-side coverage after switching. The theme stays
blue; the badge changes.

---

## 8. Remediation dossier (IDOR + path traversal)

The defense lane's default output is an implementation-ready dossier. Shape it like this, one
block per confirmed issue, with **proposed ≠ applied ≠ verified** kept distinct.

### F-01 — Cross-user balance disclosure (IDOR)

| Field | Value |
| --- | --- |
| Affected route | `GET /api/balance?user=` |
| Affected roles | any authenticated role (`member`, `admin`) |
| Observed | `member` reads `user=admin` → `200` + foreign balance |
| Expected | only the caller's own balance, or an explicit admin grant |
| Root cause | `fixtures/cyberbench/app.ts` — `balance()` queries `user` with no ownership comparison |
| Proposed correction | compare the requested `user` with the session username; allow the read only for an admin role, otherwise `403` |
| Regression | member→own `200`; member→other `403`; admin→own `200`; admin→other `200`; signed out→`401` |
| Retest criteria | the five status codes above, re-measured after the fix |

### F-02 — Missing role check on the admin route (broken function-level authorization)

| Field | Value |
| --- | --- |
| Affected route | `GET /api/admin/users` |
| Affected roles | `member` reaches an admin-only listing |
| Observed | `200` + every account with roles and tenants |
| Expected | `403` for non-admin; `200` for admin |
| Root cause | `fixtures/cyberbench/app.ts` — `adminUsers()` never inspects `session.user.role` |
| Proposed correction | role gate before the query |
| Regression | member→`403`; admin→`200`; signed out→`401` |
| Retest criteria | status codes above |

### F-03 — Tenant-boundary IDOR on orders

| Field | Value |
| --- | --- |
| Affected route | `GET /api/orders?id=` |
| Affected roles | `member` (tenant `alpha`) reads a `beta` order (`id=9001`) |
| Observed | `200` with `tenantMismatch: true` |
| Expected | cross-tenant order not retrievable (`404`, so existence is not disclosed) |
| Root cause | `fixtures/cyberbench/app.ts` — `orders()` returns the row without comparing `row.tenant` to the caller's tenant |
| Proposed correction | scope the query to the caller's tenant |
| Regression | member→own-tenant order `200`; member→other-tenant order `404` |
| Retest criteria | status codes above |

### F-04 — Unvalidated upload filename (path traversal)

| Field | Value |
| --- | --- |
| Affected route | `POST /api/upload` |
| Affected roles | any authenticated role |
| Observed | `name=../escaped-marker.txt` → `200`, `stored: "escaped-marker.txt"` (outside `uploads/`) |
| Expected | a filename that escapes the upload directory is rejected; the stored path is always inside `uploads/` |
| Root cause | `fixtures/cyberbench/app.ts` — `upload()` resolves `path.resolve(uploadsDir, name)` and only checks the fixture-root rail |
| Proposed correction | reject separators and `..` in the client-supplied name, and resolve against `uploadsDir` with a containment assertion on the final path |
| Regression | benign name → `200`, `stored: "uploads/<name>"`; traversal name → `400`, nothing written |
| Retest criteria | status codes above **plus** "no file created outside `uploads/`" |

Keep the raw session token and the seeded API key out of the dossier — reference the evidence
row id and a fingerprint instead. Note also that an exposed secret is an exposure-and-rotation
problem, not a string to delete from a response.

---

## 9. Retest criteria, measured after a fix is applied

A finding becomes **retest-passed** only when the retest passes. Measure by applying the fix to
a scratch copy of the fixture (so the committed fixture stays the vulnerable baseline), booting
it on another port and re-running the identical requests:

```sh
cp -R fixtures/cyberbench /tmp/cyberbench-fixed   # apply the corrections here
CYBERBENCH_PORT=4748 bun /tmp/cyberbench-fixed/app.ts
```

Measured on this host: pre-fix (committed fixture, port 4747) versus post-fix (patched scratch
copy, port 4748).

| # | Check | Pre-fix | Retest criterion | Post-fix measured |
| --- | --- | --- | --- | --- |
| R1 | member → `/api/balance?user=admin` | `200` (foreign balance) | `403` | `403` `{"error":"forbidden: not your account"}` |
| R2 | member → `/api/balance?user=member` | `200` | `200` (unchanged) | `200` `{"user":"member","tenant":"alpha","balance":4120}` |
| R3 | admin → `/api/balance?user=admin` | `200` | `200` (unchanged) | `200` `{"user":"admin","tenant":"beta","balance":900000}` |
| R4 | member → `/api/admin/users` | `200` (user list) | `403` | `403` `{"error":"forbidden: admin role required"}` |
| R5 | admin → `/api/admin/users` | `200` | `200` (unchanged) | `200` (user list) |
| R6 | member → `/api/orders?id=9001` (beta) | `200` `tenantMismatch: true` | `404` | `404` `{"error":"unknown order 9001"}` |
| R7 | member → `/api/orders?id=5001` (alpha) | `200` | `200` (unchanged) | `200` `tenantMismatch: false` |
| R8 | upload `name=../escaped-marker.txt` | `200`, stored outside `uploads/` | `400`, no file written | `400` `{"error":"invalid filename"}` |
| R9 | upload `name=inside.txt` | `200` `stored: "uploads/inside.txt"` | `200` (unchanged) | `200` `stored: "uploads/inside.txt"` |
| R10 | signed-out → `/api/balance?user=member` | `401` | `401` (unchanged) | `401` |

Record the retest in the dossier as **verified** only where the post-fix column was actually
measured; label the rest **applied, retest pending**. The scratch copy used for the table above
is not part of the repository.

---

## 10. Expected observed artifacts

| Artifact | Where | Expected |
| --- | --- | --- |
| Fixture banner | fixture terminal | `cyberbench: http://127.0.0.1:4747 (local fixture only — never deploy)` |
| Doctor report | doctor terminal | `platform darwin / arm64`; 16 `validated`, 8 `cataloged`; runtime `ast-grep`/`sg` absent |
| Pi session | Pi terminal | `Pi Cyber · OFFENSE` title, blue theme, red badge; `/cyber status` prints the recorded brief |
| Evidence database | `config/cyber/evidence/default/cyber.sqlite` | `jobs` row per adapter run, `evidence` rows per parsed finding, `events` for job summaries |
| Evidence summary | `cyber_evidence` `summary` | `EVIDENCE · mode offense · events N · evidence N · findings N · jobs N · sessions N (0 active)` |
| Upload side effects | `fixtures/cyberbench/uploads/` | benign uploads land here; a traversal attempt lands in the fixture root instead |
| Scanner artifacts | not persisted | adapter stdout is transient; only parsed rows reach the store |
| Session checkpoint | Pi session file | one `cyber.state.v1` entry per state update and mode change |
| Retest table | dossier | the R1–R10 table above, with measured status codes |

---

## Unproven by this walkthrough

- No live target engagement: every request went to `127.0.0.1`.
- No real browser: the Obscura MCP server is not registered, `cyber_browser` only books a lease,
  and no authenticated browser session was driven.
- No MCP registration of any kind (no Obscura, no REA server).
- No REA run: the REA server is an operator step (`rea setup`) and was never started.
- No provider call, no interactive terminal QA, no light-terminal visual check.
- `zap` remains uninstalled (dmg-only install path, no darwin/arm64 asset); `semgrep` was
  installed by the operator with uv from its PyPI wheel and is `validated`; `ghidra` and
  `jdk21` are deferred; `nmap`, `rea`, `understand-anything` and the two catalog-only sources
  are catalog entries, never installed.
- The httpx, katana and nuclei adapter flags have been corrected and contract-tested; end-to-end
  scanner runs remain pending. Configure `CYBER_FFUF_WORDLIST` before using ffuf.
- `vulnx` and `obscura` are validated on a `--help` marker probe only.
