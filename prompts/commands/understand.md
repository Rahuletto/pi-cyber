---
description: Deep comprehension of a scoped application, service or codebase — architecture, trust boundaries, roles, flows
argument-hint: "<target> [--aspect code|config|api|auth|infra] [--focus <path|host>]"
---

Build a working model of `<target>`: what it is, how it is put together, where
its trust boundaries are, and who can cross them. This is comprehension, not
attack.

## Scope and budget

- Act only inside the scope recorded in `cyber_state`, and only read. No
  writes, no state changes, no exploitation, no credential use beyond what the
  engagement already grants.
- `--aspect code` — source, build graph, entry points, data flow.
  `--aspect config` — deployment, environment, secrets wiring, defaults.
  `--aspect api` — endpoints, schemas, error contracts, version history.
  `--aspect auth` — identity model, roles, permissions, session lifecycle.
  `--aspect infra` — hosts, containers, storage, network edges, CI.
- `--focus` narrows to one path, host or module.
- Default budget: 60 tool calls, 20 minutes. State the budget you used.

## Method

1. Read `cyber_state` for scope, objective, permitted effects, identities and
   stop conditions. Read the objective — the understanding is in service of
   it, and the objective decides which aspects matter.
2. Load the area before acting: `cyber_spec` with the matching package
   (`doctrine`, `doors`, `evidence`). Do not improvise a format that is
   written down.
3. **Inventory the real surface.** Files, routes, services, containers,
   dependencies. What exists, not what the README claims.
4. **Trace the flows.** For each significant flow: entry point, processing,
   data touched, sink, and the check that guards it. Name the file, function
   and line.
5. **Map the trust boundaries.** Every place where data crosses a boundary it
   did not originate in — user input to query, request to shell, one tenant to
   another, untrusted to trusted, internal to external. Each boundary gets a
   row: where it is, what crosses it, what is supposed to stop it, what
   actually stops it.
6. **Map identity.** Who the actors are, what each can do, how they are
   checked, where the check is missing or optional.
7. **Map the data.** What data exists, where it lives, what is sensitive, what
   is masked or protected, and where the protection is only a UI convention.
8. **Say what you could not determine.** A missing piece is a gap, not a
   conclusion.
9. Keep observed, inferred and unknown separate. An architecture you inferred
   from two files is an inference.

## Output

Return, in this order and nothing else:

1. `WHAT IT IS` — the short description, stack, and the evidence for both.
2. `COMPONENTS` — the table: component, role, entry points, source location.
3. `FLOWS` — per significant flow: entry, sink, data, guard, evidence.
4. `BOUNDARIES` — the trust-boundary table, one row per crossing.
5. `IDENTITY` — actors, roles, permissions, how each is checked.
6. `DATA` — what data exists, where, sensitivity, protection.
7. `GAPS` — what you could not determine, and the exact observation that
   would settle it.
8. `IMPLICATIONS` — what the shape of this system suggests, as hypotheses with
   the next test for each. Not findings.

Then write the same content to `recon/<target>/understand-<timestamp>.md` and
record the evidence rows in `cyber_evidence`.

Every claim carries a reference. A boundary you did not read the guard for is
inferred, and must be labelled as such.
