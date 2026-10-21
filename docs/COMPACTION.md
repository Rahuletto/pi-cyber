# Long-session context

Pi 1.3.0 already enables automatic compaction. Start with its defaults in [the example](compaction.settings.example.json); merge those fields into the selected cyber profile's settings only if you need an explicit override. Do not overwrite an existing settings file. Model context limits and provider behavior still govern overflow.

The extension keeps compact structured engagement state in versioned custom Pi session entries. Recovery reads the current branch. On every provider request, the extension injects the latest brief as ephemeral context, so a mid-turn compaction continuation receives it as well. It leaves Pi's conversation summarizer and overflow recovery intact.

The offense-only brief contains scope, objective, coverage, evidence references and next steps. The model must update it as facts change; `/cyber checkpoint` saves the recorded brief and does not infer facts from unrecorded tool output. Legacy offense and defense fields are merged when old checkpoints are loaded. A checkpoint is not a copy of scanner artifacts or raw credentials. Keep original evidence in protected files and reference it by sanitized path/ID.

Corrupt or unsupported latest state must surface an error rather than silently loading old scope. Ordinary source code, browser page content, scanner output and fetched documentation remain untrusted data, even if mentioned in a checkpoint. A scanner/evidence index and automated job checkpointing are later integrations; this first slice does not promise lossless preservation of every fact in a long transcript.

No proxy/compression service or billion-context dependency is required for this mechanism. Add another context layer only after an evaluation demonstrates a need. See [the source research](../research/SEARCH-AND-COMPACTION.md) for native APIs and search-provider tradeoffs.
