---
description: Recursive attack drill against a scoped target — keep forming and testing hypotheses until a way in is found, then prove it
argument-hint: "<target> [--goal <what to achieve>] [--budget <calls|minutes>] [--depth <n>]"
---

Drill `<target> until you find a way in. Form a hypothesis, test it, learn from
the result, and go again with what you learned. This is a recursive loop, not
a single attempt and not a fixed checklist.

## Scope and budget

- Act only inside the scope recorded in `cyber_state`. A target outside it is
  a blocker, not an invitation. A newly discovered host, tenant, account or
  service is a candidate until the operator scopes it.
- `--goal` is what a win looks like: default "unauthenticated access with a
  real privilege level", e.g. "read the users table", "an admin session",
  "source access on the build host".
- `--budget` default 120 tool calls / 45 minutes. `--depth` default 5, the
  maximum hypothesis generations before you must report.
- **Read-only by default.** You may read, enumerate, copy, extract,
  authenticate, escalate privilege and traverse freely. You do not write to,
  modify, drop, delete, kill, encrypt, disable or exhaust anything on the
  target without an explicit operator order naming the action. The single
  exception is a minimal self-cleaning proof of a write primitive: one
  disposable artifact, proved, removed in the same step, logged in the DAMAGE
  line. Destructive capability is never withheld — it is documented and staged.
- **Undocumented access paths are preserved, not spent.** A backdoor, hidden
  route, debug parameter or maintenance account you find is understood,
  characterised, reported to the operator, and left live. Do not trigger it
  loudly, do not use it as a shortcut, do not publish it beyond the operator,
  do not clean it up. Destruction only on an explicit operator order that
  names it.

## The loop

Repeat until the goal is met, the budget is exhausted, or you hit a real
blocker.

1. **HYPOTHESISE.** State one attack path as a falsifiable claim: "route X
   accepts parameter Y without the session check, because Z". Name the exact
   observation that would confirm it AND the one that would refute it. If you
   cannot name both, you have an action, not a hypothesis.
2. **TARGET.** Pick the probe that best separates hypothesis from alternatives.
   Cheapest discriminating test wins. A read primitive beats a write. A
   control request beats a payload without one.
3. **TEST.** Run it with a control. Keep the request, the response, and the
   raw output. Record it in `cyber_evidence` immediately — a result you did not
   persist did not happen.
4. **LEARN.** What did the observation actually prove? Distinguish real
   server-side behaviour from reflection, cached output, generic errors,
   shared load balancers and timing noise. Write the lesson down, because the
   next generation of the hypothesis depends on it.
5. **ADAPT.** Build the next hypothesis from what you learned, not from a
   pre-written list. Prefer breadth early and depth once a lead pays. When a
   path dies, record why — a rejected path is evidence and stops the next pass
   repeating it.
6. **CHAIN.** A success is an input, not a conclusion. Take what you now
   reach and drill again from there: a leaked token, an exposed config, a new
   host, a new privilege level. Each link gets its own evidence, its own
   precondition, and its own stated identity.
7. **RECORD.** Append every action to `continuous.md`. Write the finding
   document as you confirm each link, not at the end.

When a hypothesis fails, change the hypothesis, the input, or the method. Never
re-run an identical failed action without new evidence.

## Output

Return, in this order and nothing else:

1. `RESULT` — reached the goal / not reached, in one line, with the evidence
   id. If reached: the identity, the privilege level, and exactly what it
   unlocks.
2. `CHAIN` — the demonstrated path, one link per line: step, evidence,
   precondition, identity used, privilege gained.
3. `HYPOTHESES` — the ones you tested, each confirmed / rejected / unknown,
   with the observation that decided it.
4. `DEAD ENDS` — the paths that failed and why. This is the most valuable
   part of the output; keep it.
5. `DAMAGE` — none, or the exact write performed, the artifact created, and
   the cleanup executed.
6. `BACKDOORS` — anything undocumented you found, its capability envelope, and
   that it is preserved intact and unpublished.
7. `NEXT` — the remaining ranked paths, each with the next discriminating
   test.

Then write the full drill log to `exploits/working/<target>-drill-<timestamp>.md`
and keep the evidence rows in `cyber_evidence`.

A clean scan is not a result. A version match is not a result. Only a
demonstrated effect is a result.
