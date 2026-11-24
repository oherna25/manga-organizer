#!/usr/bin/env python3
"""Convert the manga spreadsheet (title / author / number of books) to src/collection.json.

Usage: python3 scripts/import-xlsx.py "/path/to/manga sheet.xlsx"
Uses only the standard library. The spreadsheet is never modified.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

N = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
OUT = Path(__file__).resolve().parent.parent / "src" / "collection.json"


def main(path):
    z = zipfile.ZipFile(path)
    strings = [
        "".join(t.text or "" for t in si.iter(N + "t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(N + "si")
    ]
    rows = []
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(N + "row"):
        cells = {}
        for c in row.findall(N + "c"):
            v = c.find(N + "v")
            if v is None:
                continue
            col = re.match("[A-Z]+", c.get("r")).group()
            cells[col] = strings[int(v.text)] if c.get("t") == "s" else v.text
        if cells:
            rows.append(cells)

    series, total = [], None
    for cells in rows[1:]:  # skip header
        title = " ".join((cells.get("A") or "").split())
        if title.lower() == "total":
            total = int(float(cells["C"]))
            continue
        series.append(
            {
                "title": title,
                "author": " ".join((cells.get("B") or "").split()),
                "count": int(float(cells["C"])),
            }
        )

    volumes = sum(s["count"] for s in series)
    if total is not None and total != volumes:
        sys.exit(f"Total row says {total} but the series add up to {volumes}")
    OUT.write_text(json.dumps(series, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(series)} series, {volumes} volumes -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1])
