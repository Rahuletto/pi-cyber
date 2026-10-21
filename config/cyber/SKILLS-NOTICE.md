# config/cyber/skills

Six skills copied verbatim from the pinned `bigpowers` package
(`node_modules/bigpowers/.pi/skills/<name>/SKILL.md`, bigpowers 2.88.9, MIT —
see `node_modules/bigpowers/LICENSE`). `scripts/install-packages.ts` refreshes
them from the installed package; the copies are committed so the profile is
usable without re-running the installer.

Selected on purpose: `survey-context`, `research-first`, `plan-work`,
`develop-tdd`, `verify-work`, `audit-code` — the bounded engineering loop used
for defense remediation. The other 75 bigpowers skills are **not** exposed:
`orchestrate-project` and the release lifecycle add mutable project state that
does not belong in an assessment run.

Caveat: these skills are written for a bigpowers-managed project and reference
helper scripts (`scripts/bp-timing.sh`, `scripts/bp-churn-rank.sh`) and
`specs/` state that the cyber harness does not provide. Those steps cannot
resolve here; treat the surrounding guidance as workflow intent, not as a
command to run. The bigpowers **extension** (`extensions/omp-hooks.ts`) is
deliberately not loaded — see `config/cyber/settings.json`.
