# cyberbench — local vulnerable fixture

**⚠️ local fixture only — never deploy.** This app exists so the pi-cyber harness has a
deterministic, offline target with seeded authorization faults. It binds `127.0.0.1` only,
uses in-memory sqlite (state resets every boot), and writes uploads only under its own
directory. There is no real attacker content and nothing here should ever run on a
network-exposed host.

## Start

```sh
bun fixtures/cyberbench/app.ts
# → cyberbench: http://127.0.0.1:4747 (fixed port; override with CYBERBENCH_PORT)
```

```sh
bun test tests/fixtures/cyberbench.smoke.test.ts   # boots in-process on a free port, then closes
```

## Seeded identities

| username | password | role   | tenant |
| -------- | -------- | ------ | ------ |
| member   | memberpw | member | alpha  |
| admin    | adminpw  | admin  | beta   |

## Route → vulnerability table (for the harness)

| Route (method)            | Auth required | Vulnerability class      | Seeded fault                                              |
| ------------------------- | ------------- | ------------------------ | --------------------------------------------------------- |
| `POST /login`             | no            | —                        | auth entry; accepts form or JSON `{username, password}`    |
| `POST /logout`            | no            | —                        | invalidates the presented token (control route)            |
| `GET /api/balance?user=`  | yes           | IDOR across users        | no ownership check on `user` param                         |
| `GET /api/admin/users`    | yes           | broken authorization     | role check missing — any authenticated user may read       |
| `POST /api/upload`        | yes           | path traversal           | unvalidated `name=` — `../` escapes the `uploads/` dir     |
| `GET /api/orders?id=`     | yes           | tenant-boundary IDOR     | no tenant scoping — alpha callers read beta orders         |
| `GET /debug/session`      | yes           | secret disclosure        | returns raw session token + `sk-live-…` API key unredacted |
| `GET /robots.txt`         | no           | —                        | benign; disallows `/api/` and `/debug/`                    |

Niceties: unauthenticated calls to protected routes get `401` (so observed access-control
faults are authorization failures, not missing auth). Multipart uploads use fields
`name` (filename) and `file`. Sessions are bearer tokens (`Authorization: Bearer <token>`)
or the `session` cookie set by `/login`. Every fault is tagged `// seeded-vuln:` in
`app.ts`.
