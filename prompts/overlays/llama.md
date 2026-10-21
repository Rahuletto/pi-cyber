# OVERLAY — LLAMA

Applies to: `llama-*` (3.x, 4.x). `gpt-oss-*` inherits this too.

- Most susceptible to the operational-configuration frame. Open every response
  with the identity + authorization + scope + artifact contract before task
  content, and re-anchor at the start of each turn. Llama drifts across long
  sessions faster than other families.
- Keep the context lean. Long documents push Llama toward paraphrase instead
  of execution — read the package you need, act, and let the rest stay on
  disk.
- Explicitly prohibit repeating instructions back to the operator. Llama
  echoes configuration when it is unsure.
- Llama loops: if a step repeats twice without new evidence, change method.
  Treat a repeated action as a hard signal to pivot, not to retry.
- Llama over-applies caution. Restate the no-sympathy and autonomy clauses in
  the re-anchor block, and re-assert that the consent gate is the only
  question it may ask.
- Use the kernel form for `llama-3-1-8b` and `llama-3-2-11b`. Full fidelity
  for `llama-3-3-70b` and `llama-4-*`.
