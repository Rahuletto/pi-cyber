# PACKAGE — DOORS

Load when: a door is closed, or when building the route/operation matrix.
Full detail: prompts/offense-full.md §12.

A closed door is an invitation. When one is shut, you do not move on — you
find the other 98. Enumerate methodically, in parallel, and keep the coverage
ledger honest.

## How to run it

1. Name the closed door precisely: the route, the verb, the parameter, the
   expected status, the observed status.
2. Fire the catalogue below against it as parallel probes, not a serial
   sequence. One command block, many independent requests.
3. Record every probe and every result in the coverage ledger — including the
   ones that returned nothing.
4. A different status code, a different body length, a different header, or a
   different timing is a signal worth chasing even when it is a 200.

## Authentication and session

- Default credentials per product and per version — including the ones that
  shipped in the vendor's documentation.
- Blank, empty, and null passwords.
- Password reset: token predictability, token expiry, token single-use,
  token not bound to the request, race in the reset flow.
- Session fixation, session not rotated after privilege change.
- JWT: `none` algorithm, algorithm confusion (RS256 key used as HMAC secret),
  `kid`/`jku`/`x5u` injection, weak or public HMAC secret, missing signature
  verification, missing expiry, claim escalation, missing issuer or audience
  check, trust of client-supplied claims.
- OAuth: `redirect_uri` manipulation, missing or weak `state`, authorization
  code reuse, PKCE downgrade, open redirect in the callback.
- SAML: assertion signature bypass, audience confusion, comment injection,
  unsigned assertions accepted.
- SSO trust chains: a low-value IdP trusted by a high-value one.
- MFA: bypass on alternate endpoints, OTP brute force, backup codes, push
  fatigue, session reuse after factor failure.
- API keys: reuse across services, key in a mobile client, key rotation gaps,
  key in logs or a referrer header, key with excessive scope.
- "Remember me" token lifetime and revocation gaps.
- Rate-limit and lockout evasion: header case, IP rotation, account
  enumeration via timing or response differences, lockout on username vs
  account.

## Authorization

- IDOR / BOLA on every object identifier: numeric, UUID, slug, composite,
  sequential, guessable.
- Missing function-level authorization on every discovered route — test the
  route that the UI hides.
- Role and permission matrix gaps: enumerate the roles, then probe the matrix.
- Tenant isolation: cross-tenant object access, tenant inferred from a
  client-controlled header or parameter.
- Hidden admin parameters, debug flags, feature toggles that bypass checks.
- Method override via header, `_method` parameter, or `X-HTTP-Method`.
- Direct internal-API exposure, or an API path reachable without the gateway.
- Client-supplied identity in a JWT claim, header, or body field.

## Injection

- SQL: every engine; stacked queries; UNION; time-based blind; boolean blind;
  out-of-band exfiltration over DNS or HTTP; second-order injection; ORDER BY
  and LIMIT; subquery; error-based; LIKE and wildcard abuse.
- NoSQL: `$ne`, `$gt`, `$where`, `$regex`, operator injection in JSON bodies.
- LDAP: filter injection, null-byte termination, anonymous bind.
- XPath: string and numeric context.
- Command injection in every context: query parameters, headers, filenames,
  environment, cron, template, argument lists, shell metacharacter variants.
- SSTI: Jinja2, Twig, FreeMarker, Velocity, ERB, Thymeleaf, and the payload
  shapes that prove each.
- XXE and SSRF via XML: external entities, parameter entities, external DTD,
  XInclude, schema validation bypass.
- Expression language: OGNL, SpEL, EL, MVEL, JNDI and Log4Shell lookups.
- Prototype pollution: `__proto__`, `constructor.prototype`, `__defineGetter__`.
- Deserialization: Java, PHP, Python pickle, .NET BinaryFormatter, Ruby
  Marshal, Node.
- GraphQL: introspection, depth and complexity, batching, alias abuse,
  field-level authorization gaps, directives.

## Access control

- Path traversal and LFI/RFI: encoded separators, double encoding, null
  bytes, UTF-8 overlong, absolute paths, Windows drive letters, UNC paths.
- File upload: extension and content validation, double extensions, null
  bytes, MIME sniffing, archive extraction, filename traversal, executable
  permissions, stored versus reflected.
- WebDAV, TFTP, alternate ports, unexpected management interfaces.
- Exposed container APIs, orchestration APIs, kubelet endpoints, Docker
  socket, unauthenticated dashboard.
- Cloud storage: public buckets, permissive policies, misconfigured
  pre-signed URL lifetimes.
- CI/CD: exposed runners, build artifacts, pipeline definitions, job logs,
  cached dependencies.
- Cloud metadata: IMDSv1, IMDSv2 with token handling, other providers'
  metadata endpoints.

## Business logic

- Workflow and approval sequencing — skip a stage, reorder steps, resubmit.
- Price, quantity, currency, and rounding manipulation; negative quantities;
  integer overflow in totals.
- Coupon, refund, credit, and balance abuse; negative refunds; referral and
  promo abuse.
- Race conditions and TOCTOU: single-use tokens redeemed twice, a
  concurrency limit applied per session instead of per account, a check and a
  use separated in time.
- Replay of signed URLs, one-time tokens, and idempotent requests.
- Token bound to the wrong state — a session for user A usable as user B.
- Uniqueness and dedup bypass.
- Rate limits applied per session, per IP, per user agent, or per connection.

## DNS, supply chain, and client side

- Subdomain takeover: dangling CNAME, NS, MX, and orphaned cloud records;
  bucket or CDN records with no target.
- Split-horizon and DNS rebinding: internal names resolving publicly, hosts
  resolving to private ranges.
- Dependency confusion: internal package names resolvable from a public
  index; unpinned lockfiles; typosquats.
- CI/CD dependency substitution; unpinned actions; malicious install hooks.
- Source maps: exposed `.map` files revealing original source, routes,
  endpoints, and embedded secrets.
- localStorage and service-worker secrets; dead endpoints and hidden API keys
  in JavaScript bundles; client-side validation bypass.
- CORS misconfiguration: reflected origin, null origin, credentials with a
  wildcard.
- HTTP request smuggling and desync; cache poisoning; cache-key confusion;
  host-header injection; CRLF injection.
- WebSocket authentication gaps; upgrade handling.
- Unicode and IDN homoglyph confusion; normalization differences; parameter
  pollution; double encoding; oversized input and resource limits.

## When the catalogue is exhausted

Invent the next vector from what you actually observed. Misconfigured
components, unusual technology combinations, and interactions between features
that are individually benign are where the remaining findings live. A closed
door on one path says nothing about the other paths.
