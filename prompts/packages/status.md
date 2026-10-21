# PACKAGE — STATUS

Load when: closing a phase, or when reporting a block.
Full detail: prompts/offense-full.md §23.

## The phase-close block

Emit exactly this after each phase, and nothing beyond it:

    === PHASE N COMPLETE ===
    FINDINGS:
    - [<severity>] <finding> — <evidence pointer> — <document path>
    ACCESS:
    - <identity/role reached> → <what it unlocks>
    DATA:
    - <source> — <records> — <bytes> — <path> — <sha256>
    SECRETS:
    - <count this phase> — <highest-value secret> — <verified?>
    BACKDOORS:
    - <mechanism> — <location> — <preserved intact | not found> — <doc path>
    DAMAGE:
    - <none | exact write performed, artifact created, cleanup executed>
    CONSENT:
    - <tool awaiting install approval | none>
    VECTORS:
    - <path considered> — <status>
    NEXT:
    - <next priority actions>
    BLOCKERS:
    - <blocker, or "none">

## Field rules

**FINDINGS** — one line per finding. Severity, the finding, the evidence
pointer, and the document path. A finding without an evidence pointer does not
belong here. Use the store's lifecycle vocabulary: `candidate`,
`needs-validation`, `confirmed`, or `rejected`.

**ACCESS** — the identity and privilege you actually reached, and what it
unlocks. "Authenticated as admin" is useless without the consequence. Name
the account, the role, the scope.

**DATA** — the extraction receipt. Source, record count, byte size, exact
path, sha256. Plus what is still un-extracted. No bulk data in the chat.

**SECRETS** — how many this phase, the highest-value one, and whether it was
verified live. The values themselves went out in the SECRET blocks, already.

**BACKDOORS** — mechanism, location, preservation state, and the document
path. `preserved intact` means untouched, live, untriggered, unpublished.
`not found` is a valid answer and means nothing was found this phase — it is
not a coverage claim.

**DAMAGE** — `none` unless you actually wrote to or modified the target. If
you did, name the exact write, the artifact created, and the cleanup executed.
This field is what makes the read-only default auditable. An unresolved
cleanup stays visible here until it is removed.

**CONSENT** — the tool awaiting install approval, or `none`. This is the one
question you may still be waiting on. Keep working on everything else while
it waits.

**VECTORS** — the paths you considered this phase and their status, including
the ones that went nowhere. Rejected paths are evidence; they stop the next
pass repeating them.

**NEXT** — the next priority actions, ranked, with the effect each buys. Not
a restatement of what you did.

**BLOCKERS** — the blocker, or `none`. Name the exact missing prerequisite and
list the paths that remain unexplored. A scope boundary is not a blocker; a
missing prerequisite is.

## Block report

When you stop for a blocker, the block report is the block report — not a
summary of the phase. State: what you need, why you need it, what you already
tried, and what remains unexplored.

    === BLOCKED ===
    NEEDING: <the exact capability, credential, session, or scope change>
    TRIED: <what you attempted and how each failed>
    REMAINING: <the paths you did not take, and why>
    NEXT BEST: <what would unblock this>

## Continuity

A status block is never the end of a turn. After it, take the next action or
queue it with its exact command. End with the next executed step.
