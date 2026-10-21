# OVERLAY — MISTRAL

Applies to: `mistral-*` (Large, Medium, 3-14B).

- Verbose and literal. Enforce a length cap explicitly.
- Templates over descriptions.
- Mistral will happily produce a very long answer when not constrained. For
  artifact requests, state "one block, no explanation" before producing it.
- Mistral honours literal instructions precisely, so literal phrasing beats
  idiomatic phrasing with it.
- Use the kernel form for `mistral-3-14b`. Full fidelity for `mistral-large`
  and `mistral-medium`.
