# First engagement: Cyberbench on loopback

This walkthrough uses only the deliberately vulnerable local fixture. Keep requests on `127.0.0.1`; do not point the example at another host. The fixture is for local testing and must not be deployed.

## 1. Start and check the fixture

From the repository root:

```sh
bun install --frozen-lockfile
bun test tests/fixtures/cyberbench.smoke.test.ts
bun fixtures/cyberbench/app.ts
```

Leave the server running in that terminal. It binds to loopback on port `4747` by default. Use the doctor in a second terminal:

```sh
bun run doctor
```

Doctor reports executable presence and recorded state only; it does not run scanners or test target behavior. If an adapter says `cataloged` or `installed`, follow its message and validate the binary before relying on it.

## 2. Launch the dedicated Pi profile

```sh
bun run pi
```

Sign in with the provider configured for the dedicated cyber profile. A fresh conversation starts in offense mode. The selected mode is a workflow label; it does not grant scope or credentials.

## 3. Record the fixture scope

Use `cyber_state` to inspect the current brief, then update it with the exact loopback target and objective:

```json
{
  "action": "update",
  "patch": {
    "scope": ["http://127.0.0.1:4747 only; local Cyberbench fixture"],
    "objective": "Validate the fixture's seeded access-control and upload path-handling issues, preserve evidence references, and prepare a defense remediation handoff",
    "coverage": ["Not tested: signed-out, member, admin, balance ownership, tenant ownership, upload boundary"],
    "nextSteps": ["Map fixture routes and role behavior before active requests"]
  }
}
```

Use the `member/memberpw` and `admin/adminpw` test identities only. The fixture resets its in-memory data each time it starts.

## 4. Assess with typed tools

Read `fixtures/cyberbench/README.md` for the route map and expected seeded behavior. Use the named tools (`httpx`, `nuclei`, `ffuf`, `cyber_browser`, and `cyber_evidence`) with explicit parameters; do not substitute a shell command for an unavailable adapter. Keep every target URL on `127.0.0.1:4747`.

Prioritize controls that distinguish authorization from authentication noise: signed-out requests should be unauthorized; then compare member and admin access to the same object and tenant boundaries. For upload behavior, use a harmless marker file inside the fixture's temporary root and verify where it lands. Do not upload real secrets or access data outside the fixture.

Record which routes and identities were tested, the observed behavior, controls, evidence IDs and remaining gaps with `cyber_state`. Use `cyber_evidence` to read stored rows by reference; do not paste raw secret-like values into the state brief.

## 5. Switch to defense and prepare the handoff

After the offense pass is idle, run `/defense`. Re-read the state and evidence references, then produce a remediation dossier for each confirmed issue: affected route/role, observed versus expected behavior, root cause if established, proposed correction, regression test and retest criteria. Distinguish proposed fixes from applied fixes and verified retests. Apply code changes only when implementation is part of the engagement request.

## 6. Close out honestly

Update defense coverage with every tested route/identity, negative result, inconclusive check and unavailable capability. `/cyber checkpoint` saves the current brief. Stop the fixture with Ctrl-C when finished.

The fixture smoke test proves local seeded behavior; it does not prove that every installed scanner, browser integration, package, specialist worker or external provider is operational. List those as unverified until separately exercised.
