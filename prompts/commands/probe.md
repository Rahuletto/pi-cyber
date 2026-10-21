---
description: Bounded read-only probe of a scoped target — what is there, what is exposed, what to hit first
argument-hint: "<target> [--depth quick|standard|deep] [--focus host|web|auth|data]"
---

Run a bounded reconnaissance pass against `<target>` and return an attributed map
of the surface with a ranked shortlist. This is discovery, not exploitation.

## Scope and budget

- Act only inside the scope recorded in `cyber_state`. If `<target>` is not in
  it, resolve scope first and say what you need — do not widen scope yourself.
- Read-only. No writes, no state changes, no exploitation. If a path looks
  exploitable, record it as a candidate with the exact next test.
- `--depth quick` — service inventory and version fingerprinting only.
  `--depth standard` (default) — add route and parameter discovery.
  `--depth deep` — add directory brute force and content discovery.
- `--focus host` — network surface: ports, services, banners, IP ranges.
  `--focus web` — HTTP surface: routes, verbs, parameters, auth surface.
  `--focus auth` — identity surface: login endpoints, session shape, roles.
  `--focus data` — datastore surface: databases, buckets, exposed dumps.
- Default budget: 40 tool calls, 10 minutes. State the budget you used.

## Method

1. Read `cyber_state` for scope, objective, permitted effects, identities and
   stop conditions. Read the objective — the probe is in service of it.
2. Load the relevant area before acting: `cyber_spec` with the package that
   matches (`doctrine` for the phase loop, `doors` for the bypass catalogue,
   `exfil` when a datastore is in play). Do not improvise a format that is
   written down.
3. Establish first: what is the success evidence for this probe? Write it down
   before you start.
4. Map: attribute every asset to the method that found it. Record the method,
   exact target, time, result and limitation for every observation.
5. Enumerate breadth before depth. A single deep path does not map a surface.
6. Fingerprint everything: product, version, the header or banner that proved
   it, the exact path.
7. Note what each method could not observe. A probe that reports "nothing
   found" without saying what it looked at is not a result.
8. Rank the shortlist: impact against the objective, prerequisites, evidence
   already held, cost, and neglected surface. Record the score and the reason
   so the queue stays reviewable.
9. Stop at the budget. Report what you did not reach.

## Output

Return, in this order and nothing else:

1. `SURFACE` — the attributed asset table: host, port, product, version,
   method that found it, evidence id.
2. `EXPOSED` — what is reachable without credentials, each with the evidence.
3. `CANDIDATES` — promising attack paths, each with the exact next test that
   would confirm it. Candidates, not findings.
4. `GAPS` — what you did not cover and why. With a denominator.
5. `NEXT` — the ranked next actions, each with the effect it buys.

Then write the same content to `recon/<target>/probe-<timestamp>.md` and the
evidence rows into `cyber_evidence`. Reference the paths, do not paste bulk
output into the conversation.

Every claim carries a reference. Observed stays separate from inferred. A
version match is a lead, not a finding. Never report a finding you did not
demonstrate.
