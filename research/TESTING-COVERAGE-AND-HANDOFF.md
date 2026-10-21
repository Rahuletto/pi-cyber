# Testing coverage, role validation, and remediation handoff

Design requirements, 2026-10-21. This is a planning artifact, not a statement that tests ran or vulnerabilities were found.

## Shared assessment coverage

Both modes should investigate relevant pentesting paths, including authentication/session handling, authorization, tenant/object boundaries, SQL injection and other data-flow weaknesses, server-side code/command execution paths, file access/upload behavior, exposed secrets, dependency/configuration issues, and packaged application behavior. Use source analysis or decompilation according to the supplied artifact. Coverage is selected from the actual application's surfaces and features, with relevance and omissions recorded explicitly.

Offense actively develops and validates paths toward the objective, including supported exploit chains and relevant post-access investigation. Defense uses equally rigorous probing and root-cause analysis, then prepares a precise implementation handoff by default. The two modes differ in deliverable and priorities, not in whether they examine difficult vulnerabilities.

## Real sign-in and identity matrix

Use separate identities for signed-out, member, and admin states. Where the application supports multiple users or tenants, include member A/member B and relevant tenant boundaries. Obtain authenticated sessions through the application's real sign-in flow using supplied/approved accounts. Record the effective identity/role and session establishment; do not manufacture an admin session or edit client state and call it authenticated admin coverage.

Preserve each identity in its own browser process/profile and test-session context. Include sign-out, expired/revoked session, and relevant role-change behavior. A missing account, MFA step, inaccessible identity provider, or unavailable role is a specific blocker. It cannot be silently recorded as a pass. Browser storage import can support a separately identified supplied-session test, but does not satisfy real-sign-in coverage on its own.

Build the route inventory from observed browser/network traffic, normal crawling, provided API specifications, source route definitions where available, and relevant client/package inspection. Record inventory sources and unresolved discovery gaps. Include UI pages and their API endpoints; test direct server behavior as well as whether the UI hides a control.

Each test case is keyed by:

`route/template + HTTP method or protocol operation + identity + tenant/object ownership + authentication state + test class`

For GraphQL, distinguish relevant operations/resolvers and object ownership rather than calling the one transport URL one completed route. For a WebSocket or other stateful protocol, track connection authentication and operation-level authorization separately when applicable.

For each authenticated route/operation, determine expected signed-out/member/admin access and permitted effects. Validate those expectations against actual responses and side effects, including horizontal and vertical authorization. Do not infer correct authorization solely from a status code: inspect relevant body, object identity, state change, and server observations when available.

Coverage states: discovered, queued, tested, confirmed-issue, no-issue-observed, inconclusive, blocked, or not-applicable-with-reason. “No issue observed” describes the executed tests, not a proof of absence. Include source of the expected rule, test identity alias, timestamps, job IDs, evidence IDs, and retest status. Coverage percentages must name their denominator; newly discovered operations reopen the corresponding work.

## RCE, SQL injection, and data-access validation

Track the hypothesis, entry point, controllable input, prerequisites, applicable identity, expected effect, and discriminating observation. A product/version match or scanner signature starts investigation; it does not confirm execution or data access.

For a claimed execution path, retain evidence distinguishing actual target-side execution from reflection, a browser-side effect, a callback from another component, or a guessed response. For SQL injection or database access, distinguish query influence, error disclosure, accessible schema, confirmed readable records, write permissions, and inferred impact. Record exactly which effect was demonstrated and which remains untested.

Use representative evidence sufficient to establish access and impact; data acquisition amount and persistence follow the engagement's objective and permissions. Preserve relevant acquired data in restricted evidence storage with provenance and sensitivity metadata. A configuration value or application error is not proof the database was accessed.

## Keys and secrets

Inspect relevant in-scope source, configuration, frontend bundles, artifacts, responses, and authorized post-access resources for exposed credentials or keys. Classify what was found: public identifier, intentionally public client key, potential secret, credential, or confirmed active secret. Retain location, permissions, exposure path, owner/service if known, and verification status.

Store raw values in a protected evidence area and use fingerprints/redacted excerpts in ordinary reports and worker handoffs. Any attempted use must fit the engagement's permitted destinations and effects; finding a credential does not expand target scope. Distinguish discovery from validation, access, and remediation. Defense handoffs include removal, rotation/revocation, configuration changes, and regression checks as relevant; deleting a string alone may not resolve prior exposure.

## Defense deliverable for implementation agents

Default output is an implementation-ready Markdown dossier plus machine-readable JSON, not automatic modification or deployment. A later implementation task may consume it under its own authorized scope.

Each finding handoff contains:

1. Finding ID, title, confidence, severity rationale, affected build/version, asset, route/operation, role, and tenant/object context.
2. Reproduction prerequisites, real sign-in steps, minimal reproducer or request sequence, expected/observed behavior, and evidence references.
3. Root cause, source location/symbol/configuration where known, trust boundary, affected variants, and explicit unknowns when source is absent.
4. Proposed correction, implementation constraints, affected modules/interfaces, migration/backward-compatibility implications, and sensitive-data handling.
5. Relevant regression tests and before/after validation procedure, including negative cases and the complete affected role matrix.
6. Fix acceptance criteria, deployment/rotation/cleanup dependencies, and residual risks or unsupported scenarios.
7. A bounded task brief for the implementation agent, with file/module ownership, allowed changes, required validation, and reporting contract.

The overall dossier includes summary, confirmed findings, unresolved candidates, rejected leads, route/identity coverage, blocked tests, evidence index, remediation order/dependencies, and implementation-task index. Preserve unredacted artifacts separately. A document without enough evidence or root-cause information should identify the additional investigation required before implementation.

## Completion rules

Neither mode can promise to find every possible flaw. Require an explicit account of coverage, remaining leads, blockers, and stopping conditions. Do not close an assessment because the first scan is clean. Do not mark a fix complete because a patch was proposed. Distinguish an assessed issue, a documented fix, an implemented fix, and a verified retest.
