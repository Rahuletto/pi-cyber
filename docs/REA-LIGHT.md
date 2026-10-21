# REA Light Lane

## Scope and stance

Reverse engineering on this host runs as a reduced "light lane": the `reverse-engineer-anything` (REA) skill
and its server are the pinned instruction and tool surface, and deep static analysis runs through
Apple-native inspection tools plus LLDB. The validatable-now toolkit is `file`, `lipo`, `otool`, `strings`,
`nm`, `dwarfdump`, `dyld_info`, `swift-demangle`, `plutil`, `codesign`, `spctl`, and LLDB. These ship with
the Xcode/Command Line Tools installation, but research recorded that Apple CLI availability varies by tool
and OS release — presence is not assumed, and doctor's inventory is the check that decides whether each
tool is actually there. In the current recorded state they are `available` (on disk and on PATH on this
darwin/arm64 host), not `validated`; validated requires the gate described under States. Ghidra and JDK 21
are deliberately deferred (operator decision, 2026-10-21), so deep decompilation is unavailable until
revisited. Native-lane work is limited to inspection of Mach-O structure, symbols, strings, DWARF info,
load commands, architecture slices, code signatures, gatekeeper state, and controlled dynamic sessions in
LLDB. No REA run of any kind was performed during this build-out: the lane's state derives entirely from
the parent design docs (`PI-CYBER-RESEARCH-PLAN.md`, `research/BROWSER-REA-TOOLS.md`); it is a
research-only posture, and nothing in this repo has exercised the REA skill, server, or its analysis paths
on a real target.

## Boundaries

- `capture_browser_scenario` is Chrome-family only: it launches a caller-selected installed Chrome
  executable with a temporary profile. Obscura is NOT established as a supported executable for that path;
  Obscura's own CDP compatibility does not prove the pairing works. Do not point the scenario path at
  Obscura.
- No second browser may be downloaded silently inside REA setup. If a scenario needs a Chrome-family
  binary that is not installed, the gap is surfaced explicitly and resolved by operator decision, never
  an automatic download.
- One owner per REA provider session. Two agents must not open or annotate the same live provider session
  concurrently; parallel work uses separate sessions, and handoff is through exchanged immutable
  evidence, not shared live state.
- Export Evidence bundles (`export_evidence_bundle`) before `close_binary`. `close_binary` clears that
  connection's retained Evidence ledger, and a previously exported bundle is the only durable copy
  afterward. Export is a separate operation; rely on it only if the pinned server advertises it.

## Standing up REA

The REA server is NOT run or registered during this build-out. Setup is an operator-invoked step —
`rea setup` per upstream Pi documentation — done when binary assessment actually starts. Until then REA
stays `cataloged` in the tool manifest, and no MCP registration for it exists in the cyber profile.
Nothing is auto-installed, auto-registered, or prewarmed; the catalog entry is a pointer for the
operator, not a provisioned capability.

## States

The five tool states (`cataloged | installed | available | enabled | validated`) retain their global
meanings, applied to this lane as follows:

- `cataloged` — recorded in the manifest with a known version/disposition; a catalog record only, making
  no claim about what is on disk. Ghidra, JDK 21, and REA stay here until the operator stands up the lane.
- `installed` — a pinned artifact downloaded to its recorded path with a recorded SHA-256.
- `available` — on disk where the harness expects it (PATH for system tools such as the Apple CLT
  toolchain, or a pinned path) and resolvable by doctor. This is the current state of the Apple-native
  toolkit in this lane.
- `enabled` — wired into extension tooling and reachable from a mode.
- `validated` — has passed the validation gate below; the only state that licenses reliance on output.

Doctor PATH presence alone is never readiness — it is exactly the `available` check, no more. The
validation gate is a real `<bin> --version` (or `-version`, per-tool flag) probe with exit 0 and a
recorded version string, plus one benign fixture artifact analysis against a checked-in fixture file —
for this lane, a known-good small Mach-O checked through `otool`/`dwarfdump`/`codesign` with expected
output matched. Only after both pass is the tool marked `validated` in the state file.

## Revisit criteria

When an engagement actually requires decompilation the light lane cannot provide — cross-referenced
function recovery, struct/type recovery, large multi-binary corroboration, or any question that outgrows
symbol/strings-level inspection — the pre-planned upgrade is the REA + Ghidra 12.1.4 + native arm64
JDK 21 route. The research record (`research/BROWSER-REA-TOOLS.md`, sourced from REA's installation and
testing docs on macOS 15.6 arm64) describes the build: compile the native decompiler with
`ARCH_TYPE="-arch arm64" OSDIR=mac_arm_64` overrides, keep the Ghidra app and JDK arm64 (a Rosetta JDK
can make doctor report healthy while analysis fails), then validate with a small real arm64 Mach-O
decompilation on this exact host before reliance. The revisit decision is operator-invoked; deferral is
a scope boundary, not a permanent exclusion.
