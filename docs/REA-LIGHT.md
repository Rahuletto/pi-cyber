# REA Light Lane

## Scope and stance

Reverse engineering on this host runs as a reduced "light lane": the
`reverse-engineer-anything` (REA) skill and its server are the pinned
instruction and tool surface, and deep static analysis runs through Apple-native
inspection tools plus LLDB. The validated-now toolkit is `file`, `otool`,
`strings`, `nm`, `dwarfdump`, `dyld_info`, `swift-demangle`, `plutil`,
`codesign`, `spctl`, and LLDB — all present from the Xcode/Command Line Tools
installation on this darwin/arm64 host. Ghidra and JDK 21 are deliberately
deferred (operator decision, 2026-10-21). Until that deferral is revisited,
deep decompilation is unavailable in this lane; native-lane work is limited to
inspection of Mach-O structure, symbols, strings, DWARF info, load commands,
code signatures, gatekeeper state, and controlled dynamic sessions in LLDB.
Recon-only framing also applies: no REA run of any kind was performed during
this build-out. The lane's state derives entirely from the parent design docs
(`PI-CYBER-RESEARCH-PLAN.md`, `research/BROWSER-REA-TOOLS.md`); it is
research-only posture, and nothing in this repo has exercised the REA skill,
server, or its analysis paths on a real target.

## Boundaries

- `capture_browser_scenario` is Chrome-family only: it launches a
  caller-selected installed Chrome executable with a temporary profile. Obscura
  is NOT established as a supported executable for that path; Obscura's own
  CDP compatibility does not prove the pairing works. Do not point the scenario
  path at Obscura.
- No second browser may be downloaded silently inside REA setup. If a scenario
  needs a Chrome-family binary that is not installed, the gap is surfaced
  explicitly and resolved by operator decision, never an automatic download.
- One owner per REA provider session. Two agents must not open or annotate the
  same live provider session concurrently; parallel work uses separate
  sessions, and handoff is through exchanged immutable evidence, not shared
  live state.
- Export Evidence bundles (`export_evidence_bundle`) before `close_binary`.
  `close_binary` clears that connection's retained Evidence ledger; anything
  not exported is lost.

## States

The five tool states (`cataloged | installed | available | enabled | validated`)
retain their global meanings, applied to this lane as follows:

- `cataloged` — listed with a known version/disposition, not on disk. Ghidra
  and JDK 21 stay here until the deferral is revisited.
- `installed` — the pinned artifact exists at its recorded path with recorded
  SHA-256.
- `available` — resolvable by the harness (on PATH, or pinned path reachable).
- `enabled` — wired into extension tooling and reachable from a mode.
- `validated` — has passed the validation gate below; the only state that
  licenses reliance on output.

Doctor PATH presence alone is never readiness: a binary appearing on PATH is
`available`, not `validated`. The validation gate is a real `<bin> --version`
(exit 0, recorded version string) plus one benign fixture artifact analysis
against a checked-in fixture file — for this lane, a known-good small Mach-O
checked through `otool`/`dwarfdump`/`codesign` with expected output matched.
Only after both pass is the tool marked `validated` in the state file.

## Revisit criteria

When an engagement actually requires decompilation the light lane cannot
provide — cross-referenced function recovery, struct/type recovery, large
multi-binary corroboration, or any question that outgrows symbol/strings-level
inspection — the pre-planned upgrade is the REA + Ghidra 12.1.4 + native arm64
JDK 21 route. The research record (`research/BROWSER-REA-TOOLS.md`, sourced
from REA's installation and testing docs on macOS 15.6 arm64) describes the
build: compile the native decompiler with `ARCH_TYPE="-arch arm64"
OSDIR=mac_arm_64` overrides, keep the Ghidra app and JDK arm64 (a Rosetta JDK
can make doctor report healthy while analysis fails), then validate with a
small real arm64 Mach-O decompilation on this exact host before reliance.
The revisit decision is operator-invoked; deferral is a scope boundary, not a
permanent exclusion.
