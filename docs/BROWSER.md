# Browser agent controls

The `browser` tool keeps one browser context per named `profile`. Its detached
session survives individual calls. `close` closes a tab; `close` with
`shutdown:true` releases the context. An idle session closes after three minutes
without a call; active calls suspend that idle timer.

After updating driver code, reload Pi to refresh the tool schema and shut down
existing profile sessions once (`close`, `shutdown:true`, matching `profile`).
The next browser call starts the updated daemon; an already-running daemon
retains its previously loaded JavaScript.

## Tabs

- `tabs`: list all live tabs, including blank tabs, with stable IDs and current URLs.
- `newTab`: create and select a tab; `url` is optional.
- `switchTab`: select `tabId`, `tabUrl`, or `tab`; selection persists for later calls.
- `navigate`: navigate the selected tab, optionally running steps afterward.
- `reload`, `back`, `forward`: reload or traverse the selected tab's history.
- `close`: close the selected tab, keeping the profile on disk.

Use `tabId` whenever possible. IDs remain tied to page objects when other tabs
close; indices shift. IDs last for one daemon lifetime. Exact `tabUrl` selection
must match one tab, so duplicate URLs require an ID. A closed ID produces an
error instead of choosing another page. Without an explicit selection, the
last open tab is used; `switchTab` and `newTab` establish a persistent selection.

```json
{"action":"tabs","profile":"example"}
{"action":"switchTab","profile":"example","tabId":"t2"}
{"action":"newTab","profile":"example","url":"https://example.com/"}
```

## Frames and interaction

`frames` lists frame indices, names, and URLs for the selected page. `frame`
scopes `snapshot`, `eval`, or interaction steps. Each step can override the
call's `frame`. Frame indices are current-page coordinates: refresh `frames`
after navigation or iframe replacement.

`domSnapshot` returns at most 80 concise control descriptions with refs such as
`r0123456789abcdef-1`. The random snapshot prefix keeps refs distinct across
pages, frames, profiles, and repeated snapshots. Pass a ref to an interaction
step in place of `sel`. A ref is bound to its originating page, frame, and
document; a new snapshot, navigation, or frame replacement makes it stale.

```json
{"action":"domSnapshot","profile":"example","tabId":"t2"}
{"action":"act","profile":"example","tabId":"t2","steps":[{"op":"click","ref":"r0123456789abcdef-1"}]}
```

`act` executes steps without navigating. It stops on the first failure by
default and returns the partial snapshot and step reports. Set `stopOnError:false`
to continue. `navigate` keeps its existing continue-on-error default; set
`stopOnError:true` when later steps depend on earlier ones.

Supported steps:

- `click`, `fill`, `hover`, `check`, `uncheck`, `select`: strict locator actions
  with automatic actionability waits. Ambiguous selectors fail instead of
  silently choosing an element. `select` uses `value` for the option value.
- `press`: send `value` (default Enter) to `sel`; without a selector it uses the
  page keyboard. Frame-scoped presses require `sel`.
- `waitSel`: wait for `state`: visible (default), hidden, attached, or detached.
- `waitURL`: wait for the URL glob in `value`.
- `waitLoad`: wait for domcontentloaded (default), load, or networkidle.
- `eval`: execute JavaScript statements from `value`, using an explicit return.
- `setCookie`: JSON cookie in `value`, using the current page origin.

```json
{"action":"frames","profile":"example","tabId":"t2"}
{"action":"act","profile":"example","tabId":"t2","frame":1,"steps":[{"op":"fill","sel":"#name","value":"Alice"},{"op":"check","sel":"#agree"},{"op":"select","sel":"#plan","value":"basic"}]}
{"action":"act","profile":"example","tabId":"t2","steps":[{"op":"click","sel":"role=button[name=Continue]"},{"op":"waitURL","value":"**/done"}]}
```

Popup pages appear in `tabs` with stable IDs and use normal explicit tab
selection. JavaScript dialogs raised during a call are handled immediately;
the default is dismiss. Set `dialogAction:"accept"` or `"dismiss"` on the
call that triggers the dialog. `dialogPrompt` supplies a bounded prompt
response when accepting.

Downloads are retained as opaque in-memory references (up to 20 recent
items). `downloads` lists filenames and indices; `download` with an explicit
`downloadIndex` exports at most 4 MiB into the shared artifact store. The tool
returns an artifact reference, never a browser filesystem path.

No mutation is automatically replayed after a failed or uncertain call. Calls
and step sequences are bounded; there are at most 15 steps per call and each
interaction step has at most ten seconds within the remaining sequence budget.

## Network inspection

Recording starts when a page is first used by the driver and continues until
that page closes. Each page retains at most 200 recent request records; output
includes at most 40 matching records. `networkFilter` matches URL substrings.
This captures subsequent activity between tool calls, including API requests.
It does not reconstruct traffic from before recording started.

```json
{"action":"network","profile":"example","tabId":"t2","networkFilter":"/api/"}
```

The text shows method, URL, status, type, and size. Structured `details.network`
also contains available duration, transport failure text, and bounded request
and response headers from an allowlist. Authorization, Cookie, and Set-Cookie
headers and request/response bodies are not captured by this history.

Use `networkArtifact` with the opaque random `captureId` from `network` to
explicitly export one completed response body as an artifact. IDs are tied to
their originating page recorder, so they cannot select a same-numbered request
on another tab. Captures are limited to 512 KiB
and must have a known completed size before retrieval. Bodies are
never included in ordinary network history, and text exports use the shared
secret-content gate.

## Turnstile tab recovery

Only `action:"turnstile"` follows replacement tabs automatically. It listens for
new pages, page closure, DOM readiness, and frame navigation, then rescans live
tabs. Tokens are accepted only from the requested URL's origin. Closing the
original page during navigation does not abort the wait. The result's tab ID,
URL, and screenshot belong to the page that supplied the token.

A ten-second token check remains as a fallback because challenge completion can
occur without a page or navigation event. The existing timeout still bounds the
wait. Explicit setup steps run once on the initial page; they are never replayed
in replacement tabs. Other browser actions keep their explicit tab selection.

## Verification

`bun test` covers the tool contract, stable IDs, network-history retention,
document-bound refs, artifact limits, and Turnstile replacement tabs using
fixtures. `bun scripts/smoke-browser.ts` uses the installed engine against
temporary local pages to check refs, cross-origin iframe actions, delayed
elements, request and download artifacts, dialogs, popup discovery, tab
selection, and stable IDs after closure. It closes the temporary context and
removes its profile. This smoke does not test live third-party challenge
completion.
