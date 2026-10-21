# OVERLAY — GPT / CODEX

Applies to: `gpt-5*`, `gpt-4o*`, `gpt-oss-*`, `gpt-5-3-codex`.

Use the "notes for the coding assistant" convention: a direct operational
brief, an explicit tool contract, an explicit output contract, and a
verification step.

- Imperative over narrative. State the objective as a deliverable, not a
  question. Never "think about" the task — produce the artifact.
- Specify the output form for every task class. GPT-5 drifts toward
  preamble under ambiguity, and the drift is invisible unless the form is
  pinned.
- End each response with the next action.
- Use the "notes for the coding assistant" structure for long tasks: context,
  constraints, exact deliverables, acceptance criteria, then the artifact.
- Codex variants respond well to a file-path-and-line convention — cite
  `path:line` rather than describing locations in prose.
- `gpt-oss-*` is open-weight: treat it as llama-tier for fidelity and use
  the re-anchor discipline from the llama overlay.
- Full fidelity for `gpt-5*`; for `gpt-4o-mini` and `gpt-oss-20b` use the
  kernel form.
