# Optional structural source tools

Goal: implement the useful AST search/staged-edit idea from oh-my-pi without importing the fork or adding an IDE runtime.

Add a separately loaded Pi extension, excluded from the default `pi.extensions` manifest. Use a pinned ast-grep engine and explicit bounded workspace files. Expose `ast_grep` plus `ast_edit` preview/apply for one file per proposal. AST matching is syntactic evidence; ordinary source review, compiler checks and tests still establish behavior.

Requirements: actual structural pattern and metavariable support; matched path/line and truncation; bounded file sizes/match counts; supported language reporting; no parser-error file mutation; preview without writes; opaque proposal handle bound to original hash and workspace/session; explicit apply rechecks hash and path; reject stale proposals, path escapes, symlinks and overlapping rewrites; atomic per-file write preserving mode. No shell command interpolation, target network operations, browser downloads, OMP native stack, or generic LSP service.

Use meaningful test-first real temporary file fixtures and the real AST engine. Test Unicode source, unchanged preview, replacement captures, stale file refusal, no writes on invalid output, and scope containment. Verify through Pi SDK loader and typecheck. Single-file editing is an intentional first boundary; no implied cross-file transaction or semantic refactoring guarantees.
