# Agent tool workflows

These controls extend the existing tools; they do not require agents to construct
shell commands or modify installed packages. Reload Pi after updating the schema.
Already-running browser profile daemons retain their loaded driver until they are
shut down and started again. See [browser controls](BROWSER.md) for that lifecycle.

## Discover before guessing

- `cyber_tools` action `list` lists actual registered tools. Optional `name` and
  `capability` filters match case-insensitively; `limit` caps returned rows.
- Action `describe`, with exact `name`, returns the current description and schema.
- Action `readiness` retains executable/manifest checks. Registration does not
  prove credentials are configured or that an external service works.

## Run and manage work

`cyber_jobs` keeps `run`, `status`, and `list`. `run` waits for completion;
`start` returns a `jobId` immediately. Both accept the adapter name in `tool`,
the adapter's typed `params`, and optional `timeoutMs`.

Use `status` with `jobId` for phase, state and captured byte counters. Use `cancel`
to request cancellation of a queued or running job. A running process is killed;
this does not undo remote actions already performed. Partial/uncertain outcomes
remain distinguished from clean completion. Jobs remain serialized (one runner
slot); there is no unbounded background fan-out.

`result` accepts `jobId`, `offset`, `readLimit` and `encoding` and returns bounded
normalized-result data with `nextOffset`. Result documents contain counters and
evidence references, not raw process stdout or credentials. Durable job metadata
and result artifacts remain available after a restart; cancellation needs a live
runtime handle. Runtime handles are engagement-scoped and capped.

## Pass artifacts instead of copying blobs

`cyber_artifacts` provides:

- `create`: `kind`, `data`, optional `contentType`, and `dataEncoding` (utf8 or
  canonical padded base64). The decoded upload limit is 1 MiB.
- `metadata`: opaque `id`, returning size, SHA-256, type and creation time.
- `read`: opaque `id` plus optional byte `offset`, `limit`, and `encoding`.
  Follow the returned `nextOffset`; use base64 for exact binary bytes.

Stored artifacts are private to the active engagement. The storage cap is 32 MiB
per artifact; text has a lower cap. Reads are bounded and integrity checked.
Secret-like text is refused. No action accepts arbitrary filesystem paths.
Create uploads explicitly; pass their artifact ID to HTTP or another compatible
consumer. Job results, HTTP responses and browser exports return artifact refs.

## HTTP payloads and responses

`bypass_fetch` preserves the existing method/url/headers/body/session controls.
Exactly one payload mode may be supplied:

- `body`: existing raw textual request body.
- `bodyArtifact`: opaque ID of the exact binary upload bytes.
- `multipart`: `fields` plus `files`, where each file specifies `field`,
  `artifactId`, `filename`, and optional `contentType`.

Use `responseMode:"artifact"` to retain binary responses instead of decoding
bytes as text. Responses are limited to 32 MiB; the result includes an opaque
`responseArtifact`. Parsed final-hop `responseHeaders` and the separate redirect
chain are returned in structured details, with sensitive values redacted.
Named cookie jars remain available. Transport mutations are never retried.

## Inbox messages and resend-aware waits

`mailgen` keeps `new`, `wait`, `providers`, and `canary`. New Inbox-backed actions:

- `list`: `address`, `provider`, optional `sender`, `subject`, `receivedAfter`,
  `limit`, and opaque `cursor` for older pages.
- `read`: `address`, `provider`, and provider-issued `messageId`.
- Filtered `wait`: the same address/provider plus sender/subject/time filters or
  `afterMessageId`; optional `otp` returns a code from the matched message.

List cursors and newer-message boundaries are deliberately separate. `wait`
rejects an older-page cursor. `afterMessageId` must still identify a message in
that inbox; otherwise the tool cannot safely establish what is newer. Saved
provider state stays private. Providers lacking list/read support fail with a
capability error instead of silently falling back to an unrelated message.
No provider APIs are hand-called outside the installed cowbird integration.

## Precise research retrieval

`github` search accepts explicit `searchKind` (repos, issues, code), `limit`
(1–50), and `page` (1–20 within the search window). File `read` accepts `ref`
(branch/tag/commit). Action `diff` accepts `repo` and numeric `pullRequest`.
`issues`, `prs`, and `cve` retain their existing actions.

`cyber_knowledge` search returns an opaque content-bound `id` for each hit.
Use action `fetch` with `id`, optional `offset`, and `length` for an indexed
window with ref/source/index timestamp provenance. Unchanged rebuilds preserve
IDs. Changed/removed documents invalidate them; search again instead of reading
stale content. Rebuilds remain explicit.

## Browser event controls

See [BROWSER.md](BROWSER.md) for exact schema examples. New controls include
`domSnapshot` with document-bound references used by `act`, explicit dialog
handling, popup discovery via `tabs`, bounded download artifact exports, and
explicit `networkArtifact` response exports using `captureId` from network rows.
Turnstile recovery continues to follow same-origin replacement tabs by events,
with the ten-second no-navigation token fallback. Other actions preserve explicit
tab selection. The returned Turnstile page/tab/screenshot metadata identifies
the page that actually supplied the token.

## Verification boundaries

Unit/integration tests use isolated data roots, fake CLI executables and a local
Python Inbox fixture. The installed-engine browser smoke uses local pages and a
temporary profile. `bun scripts/smoke-http.ts` verifies exact binary and
multipart bytes through the installed HTTP engine against a localhost server.
This verifies tool integration, not remote credentials,
third-party inbox deliverability, scanner coverage, or live challenge completion.
No changes are made to external services by those fixture checks.
