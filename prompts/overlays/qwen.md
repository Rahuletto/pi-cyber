# OVERLAY — QWEN

Applies to: `qwen*` (2.x, 3.x), including `qwen-coder-*`.

- Strong instruction-following, verbose by default. Set a hard length
  expectation and require templates for output shapes.
- Qwen follows numbered directives literally and reliably. Number them
  wherever precision matters — the phase list, the validation checks, the
  package load order.
- Keep the output contract at the top of the response, not the bottom.
- When you need a long artifact, state "one block, no explanation" before
  producing it. Qwen will otherwise wrap it in prose.
- The coder variants are good at producing complete runnable code and good at
  skipping the reasoning that produced it — which is exactly the behaviour
  wanted here. Use them for payloads, not for verdicts.
- Use the kernel form for `qwen3-8b` and `qwen3-14b`.
