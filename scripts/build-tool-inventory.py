#!/usr/bin/env python3
"""Regenerate the tool-inventory artefacts from the four research reports.

The machine-readable inventory (``docs/research/tool-inventory.json``) and the
human-readable catalogue (``docs/TOOLS.md``) are both derived from the markdown
tables in these reports:

* ``docs/research/RECON-WEB-TOOLS.md``            -> category ``recon-web``
* ``docs/research/DEFENSE-CLOUD-IDENTITY-TOOLS.md`` -> category ``defense-cloud-identity``
* ``docs/research/BROWSER-REA-TOOLS.md``            -> category ``browser-reverse``
* ``docs/research/ECOSYSTEM-PATTERNS.md``           -> category ``ecosystem-reference``

Every data row of every candidate table becomes one inventory entry, in source
file order, numbered by a single running index (``<category>-<n>``).  Each entry
records the raw table cells, the section heading the row sits under, and the
source line number.

``docs/TOOLS.md`` is regenerated from the same entries: only the category
sections are rewritten, while the hand-written header and the trailing
``## Package and infrastructure choices`` section are copied unchanged from the
file that is already on disk.

Usage: ``python3 scripts/build-tool-inventory.py``
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = ROOT / "docs"
INVENTORY_PATH = DOCS_DIR / "research" / "tool-inventory.json"
TOOLS_PATH = DOCS_DIR / "TOOLS.md"

# (category, research report file name) in catalogue order.
CATEGORIES = [
    ("recon-web", "RECON-WEB-TOOLS.md"),
    ("defense-cloud-identity", "DEFENSE-CLOUD-IDENTITY-TOOLS.md"),
    ("browser-reverse", "BROWSER-REA-TOOLS.md"),
    ("ecosystem-reference", "ECOSYSTEM-PATTERNS.md"),
]

# The first and last headings of the region of docs/TOOLS.md that is generated.
TOOLS_FIRST_HEADING = "## recon-web"
TOOLS_LAST_HEADING = "## Package and infrastructure choices"

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
SEPARATOR_CELL_RE = re.compile(r"^:?-+:?$")
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]*)\)")


def split_cells(row: str) -> list[str]:
    """Split one markdown table row into its stripped cells."""
    return [cell.strip() for cell in row.strip()[1:-1].split("|")]


def is_separator(cells: list[str]) -> bool:
    """True for a ``|---|---|`` rule row."""
    return bool(cells) and all(SEPARATOR_CELL_RE.match(cell) for cell in cells)


def candidate_column(header: list[str]) -> int | None:
    """Index of the column holding the candidate name, or None for other tables."""
    lowered = [cell.lower() for cell in header]
    for index, cell in enumerate(lowered):
        if "candidate" in cell:
            return index
    for index, cell in enumerate(lowered):
        if "tool" in cell:
            return index
    return None


def parse_report(path: Path) -> list[dict]:
    """Collect the candidate rows of one research report.

    A candidate table is a markdown table whose header names a candidate column
    ("Candidate ..." or "Tool/capability").  Every data row of such a table
    yields a dict with the raw cells, the index of the candidate column, the
    nearest preceding heading and the 1-based source line number, in file order.
    Tables without a candidate column (ledgers, coverage matrices) are skipped.
    """
    lines = path.read_text(encoding="utf-8").split("\n")
    rows: list[dict] = []
    section = ""
    index = 0
    while index < len(lines):
        line = lines[index]
        heading = HEADING_RE.match(line)
        if heading:
            section = heading.group(2).strip()
            index += 1
            continue
        if not TABLE_ROW_RE.match(line):
            index += 1
            continue

        # Gather the whole table block.
        block: list[tuple[int, str]] = []
        while index < len(lines) and TABLE_ROW_RE.match(lines[index]):
            block.append((index + 1, lines[index]))
            index += 1
        if not block:
            continue

        header = split_cells(block[0][1])
        column = candidate_column(header)
        if column is None:
            # Not a candidate table (ledger, coverage matrix, ...).
            continue

        for line_number, raw in block[1:]:
            cells = split_cells(raw)
            if len(cells) != len(header) or is_separator(cells):
                continue
            rows.append(
                {
                    "cells": cells,
                    "column": column,
                    "section": section,
                    "line": line_number,
                }
            )
    return rows


def build_inventory() -> list[dict]:
    """Build the machine-readable inventory from the four research reports."""
    inventory: list[dict] = []
    counter = 0
    for category, filename in CATEGORIES:
        source = f"docs/research/{filename}"
        for row in parse_report(DOCS_DIR / "research" / filename):
            counter += 1
            cells = row["cells"]
            candidate = cells[row["column"]]
            link = LINK_RE.search(candidate)
            inventory.append(
                {
                    "id": f"{category}-{counter}",
                    "category": category,
                    "candidate": candidate,
                    "name": link.group(1) if link else candidate,
                    "upstream": link.group(2) if link else None,
                    "section": row["section"],
                    "source": source,
                    "line": row["line"],
                    "columns": cells,
                    "installed": False,
                }
            )
    return inventory


def render_category_sections(inventory: list[dict]) -> list[str]:
    """Render the per-category markdown sections of docs/TOOLS.md."""
    sections: list[str] = []
    for category, _filename in CATEGORIES:
        sections.append(f"## {category}")
        sections.append("")
        sections.append("| Candidate | Source details |")
        sections.append("|---|---|")
        for entry in inventory:
            if entry["category"] != category:
                continue
            report = Path(entry["source"]).name
            sections.append(
                f"| {entry['candidate']} | [{entry['section']}](research/{report}) |"
            )
        sections.append("")
    return sections


def write_inventory(inventory: list[dict]) -> None:
    """Write docs/research/tool-inventory.json."""
    payload = json.dumps(inventory, indent=2, ensure_ascii=True) + "\n"
    INVENTORY_PATH.write_text(payload, encoding="utf-8", newline="")


def write_tools_md(inventory: list[dict]) -> None:
    """Rewrite only the generated category sections of docs/TOOLS.md."""
    if not TOOLS_PATH.exists():
        raise SystemExit(
            f"missing {TOOLS_PATH}: the hand-written header and tail of TOOLS.md "
            "are preserved from the existing file, so it must exist"
        )
    lines = TOOLS_PATH.read_text(encoding="utf-8").split("\n")
    try:
        start = lines.index(TOOLS_FIRST_HEADING)
        end = lines.index(TOOLS_LAST_HEADING)
    except ValueError as exc:  # pragma: no cover - defensive
        raise SystemExit(
            f"cannot locate '{TOOLS_FIRST_HEADING}' / '{TOOLS_LAST_HEADING}' in {TOOLS_PATH}"
        ) from exc
    if end <= start:
        raise SystemExit(f"unexpected heading order in {TOOLS_PATH}")

    updated = lines[:start] + render_category_sections(inventory) + lines[end:]
    TOOLS_PATH.write_text("\n".join(updated), encoding="utf-8", newline="")


def main() -> int:
    inventory = build_inventory()
    write_inventory(inventory)
    write_tools_md(inventory)
    print(f"wrote {INVENTORY_PATH.relative_to(ROOT)} ({len(inventory)} entries)")
    print(f"wrote {TOOLS_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
