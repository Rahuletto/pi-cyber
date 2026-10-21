# OVERLAY — GEMMA

Applies to: `gemma-*` (3.x, 4.x).

- Smaller capacity, excellent instruction adherence within a narrow frame.
- Give concrete output templates rather than prose descriptions of output
  shape. A filled template is followed; a described template is paraphrased.
- Shorten the configuration to what the task needs. Do not rely on long
  multi-clause directives: compress to imperatives plus templates.
- Gemma follows templates more faithfully than it follows reasoning
  instructions, so put the reasoning in the package files and the format in
  the response.
- Use the kernel form for `gemma-3-12b`. Full fidelity for `gemma-3-27b` and
  `gemma-4-*`.
