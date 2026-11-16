"""Phase 10, Step 1: dump the office's two Word schedules as plain JSON for scripts/eval/manual-parse.js.

    ../intellisched_backend/.venv/Scripts/python scripts/eval/dump_docx_tables.py

Reads (python-docx)  docs/2nd-semester_2025-2026/Class Schedule.docx   (19 tables, one per section)
                     docs/2nd-semester_2025-2026/Room Schedule.docx    (10 tables, one per room and week group)
Writes               docs/eval/phase10/manual_tables.json

For every table: the paragraphs between it and the table before (its heading), and every row's cells in
grid order with the vertical merge state (restart | continue | none) and the cell's text lines. Nothing is
interpreted here; the blocks, codes, teachers and sections are read by manual-parse.js (tested).
"""
import json
from pathlib import Path

import docx
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "docs" / "2nd-semester_2025-2026"
FILES = {"class": "Class Schedule.docx", "room": "Room Schedule.docx"}


def cell_of(tc):
    pr = tc.tcPr
    merge, span = "none", 1
    if pr is not None:
        v = pr.find(qn("w:vMerge"))
        if v is not None:
            merge = "restart" if v.get(qn("w:val")) == "restart" else "continue"
        g = pr.find(qn("w:gridSpan"))
        if g is not None:
            span = int(g.get(qn("w:val")))
    lines = []
    for p in tc.iter(qn("w:p")):
        text = "".join(t.text or "" for t in p.iter(qn("w:t"))).strip()
        if text:
            lines.append(text)
    return {"merge": merge, "span": span, "lines": lines}


def dump(path):
    d = docx.Document(str(path))
    tables, heading = [], []
    for child in d.element.body.iterchildren():
        if child.tag == qn("w:p"):
            text = "".join(t.text or "" for t in child.iter(qn("w:t"))).strip()
            if text:
                heading.append(text)
        elif child.tag == qn("w:tbl"):
            rows = []
            for tr in child.findall(qn("w:tr")):
                cells, col = [], 0
                for tc in tr.findall(qn("w:tc")):
                    c = cell_of(tc)
                    c["col"] = col
                    col += c["span"]
                    cells.append(c)
                rows.append(cells)
            tables.append({"heading": heading, "rows": rows})
            heading = []
    return tables


def main():
    out = {kind: {"file": f"docs/2nd-semester_2025-2026/{name}", "tables": dump(SRC / name)} for kind, name in FILES.items()}
    target = ROOT / "docs" / "eval" / "phase10" / "manual_tables.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print({k: len(v["tables"]) for k, v in out.items()})


if __name__ == "__main__":
    main()
