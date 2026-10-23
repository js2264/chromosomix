#!/usr/bin/env python3
"""Fig. 2 of the Chromosomix paper: CTCF's sites on GM12878's chr19, each panel as chromosomix draws it
in the browser beside the same panel as the package it reproduces draws it.

    node manuscript/figure2/chromosomix_panels.mjs                           # chromosomix/, in the app
    YAPC_PYTHON=yapc-env/bin/python refs/bin/python manuscript/figure2/reference.py   # reference/
    python3 manuscript/figure2/make_figure.py                               # figure2.svg, .pdf, .png

a  APA between each CTCF peak and the next, at 2 kb, ±10 bins, over the expected — chromosomix's
   *Aggregate peak analysis* (each feature with the next) beside coolpuppy's `pileup` and `plotpup`.
b  Both CTCF tracks and ATAC-seq about the peaks, ±2 kb: chromosomix's *Metaplot over a feature set*,
   its profile with the bootstrap band and a heatmap a track, beside deepTools' `plotProfile` (the
   standard error) and `plotHeatmap`.
c  The insulation at its four windows about the same peaks, ±500 kb, the same way.

Nothing is redrawn: every panel is the PDF its tool wrote — the app's own export, and the reference
packages' own plotting — placed on the page as it came, its vectors kept (`pdftocairo -svg`, then
Chromium's print path, `manuscript/figure1/svg2pdf.mjs`). The numbers each side reports are gathered
into numbers.tsv. The page is 180 mm wide.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APP, REF = HERE / "chromosomix", HERE / "reference"
SVG2PDF = ROOT / "manuscript" / "figure1" / "svg2pdf.mjs"
WORK = HERE / "build" / "svg"

W = 180.0
FONT = "Helvetica, Arial, 'Liberation Sans', sans-serif"
INK, INK2, RULE = "#1c1e21", "#4b5058", "#d5d9df"


def drawn(pdf: Path, tag: str) -> tuple[float, float, float, float]:
    """Where a PDF's page has ink, in points: rendered once at 72 dpi, a pixel a point, and the box round
    every pixel that is not white. Both sides' exports leave wide margins — the app's figure is laid out
    for a window — and the page is laid out from what is drawn."""
    base = WORK / f"{tag}-ink"
    subprocess.run(["pdftoppm", "-gray", "-r", "72", "-singlefile", str(pdf), str(base)], check=True)
    raw = (WORK / f"{tag}-ink.pgm").read_bytes()
    fields = re.match(rb"P5\s+(\d+)\s+(\d+)\s+(\d+)\s", raw)
    width, height = int(fields.group(1)), int(fields.group(2))
    image = np.frombuffer(raw[fields.end():fields.end() + width * height], dtype=np.uint8).reshape(height, width)
    rows, cols = np.flatnonzero((image < 248).any(axis=1)), np.flatnonzero((image < 248).any(axis=0))
    pad = 2.0
    return (max(0.0, cols[0] - pad), max(0.0, rows[0] - pad), min(width, cols[-1] + 1 + pad) - max(0.0, cols[0] - pad),
            min(height, rows[-1] + 1 + pad) - max(0.0, rows[0] - pad))


class Panel:
    """One tool's PDF as SVG: its inner drawing, ids made its own, cut to where it has ink."""

    def __init__(self, pdf: Path, tag: str):
        WORK.mkdir(parents=True, exist_ok=True)
        out = WORK / f"{tag}.svg"
        subprocess.run(["pdftocairo", "-svg", "-f", "1", "-l", "1", str(pdf), str(out)], check=True)
        text = out.read_text()
        head = re.search(r"<svg[^>]*>", text)
        self.x, self.y, self.width, self.height = drawn(pdf, tag)
        body = text[head.end():text.rindex("</svg>")]
        # Every id is the panel's own: two PDFs both name a glyph `glyph-0-1`, and inside one document
        # the second would draw the first's.
        body = re.sub(r'id="([^"]+)"', lambda m: f'id="{tag}-{m.group(1)}"', body)
        body = re.sub(r'href="#([^"]+)"', lambda m: f'href="#{tag}-{m.group(1)}"', body)
        body = re.sub(r"url\(#([^)]+)\)", lambda m: f"url(#{tag}-{m.group(1)})", body)
        self.body = body
        self.tag = tag

    def height_at(self, width: float) -> float:
        return width * self.height / self.width

    def place(self, x: float, y: float, width: float) -> str:
        """The panel at (x, y) in millimetres, `width` wide, its own aspect kept."""
        return (f'<svg x="{x:.3f}" y="{y:.3f}" width="{width:.3f}" height="{self.height_at(width):.3f}" '
                f'viewBox="{self.x} {self.y} {self.width} {self.height}" overflow="hidden">{self.body}</svg>')


def text(x, y, s, size=2.6, weight=None, anchor="start", fill=INK) -> str:
    w = f' font-weight="{weight}"' if weight else ""
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-family="{FONT}" font-size="{size}" fill="{fill}"{w} '
            f'text-anchor="{anchor}">{s}</text>')


def numbers_of(path: Path) -> dict[str, str]:
    """The `# key: value` lines of a chromosomix table."""
    out = {}
    for line in path.read_text().splitlines():
        if line.startswith("# ") and ": " in line:
            key, _, value = line[2:].partition(": ")
            out.setdefault(key, value)
    return out


def main() -> None:
    for folder, how in ((APP, "node manuscript/figure2/chromosomix_panels.mjs"),
                        (REF, "refs/bin/python manuscript/figure2/reference.py")):
        if not folder.is_dir():
            raise SystemExit(f"{folder.relative_to(ROOT)} is not there: run `{how}` first")

    half = (W - 16) / 2  # two columns, a margin and a gutter
    left, right = 6.0, 6.0 + half + 4.0
    parts: list[str] = []
    y = 4.0
    parts.append(text(left + half / 2, y + 2.4, "chromosomix, in the browser", 3.0, "bold", "middle"))
    parts.append(text(right + half / 2, y + 2.4, "the reference tools", 3.0, "bold", "middle"))
    y += 6.0

    def row(letter: str, title: str, app: list[tuple], ref: list[tuple]) -> None:
        """One panel's two sides: each a stack of PDFs, each scaled to a share of the column's width, a
        group of several side by side — under the names given, where the PDF carries none: the app writes
        a heatmap's track in the drawer's head over it, not in the figure it exports."""
        nonlocal y
        parts.append(f'<line x1="{left}" y1="{y:.2f}" x2="{W - 6}" y2="{y:.2f}" stroke="{RULE}" stroke-width="0.25"/>')
        parts.append(text(left - 4.0, y + 4.0, letter, 3.6, "bold"))
        parts.append(text(left, y + 4.0, title, 2.6, None, "start", INK2))
        y += 6.0
        heights = []
        for x0, stack in ((left, app), (right, ref)):
            at = y
            for group in stack:
                pdfs, share, *names = group
                pdfs = pdfs if isinstance(pdfs, list) else [pdfs]
                each = half * share / len(pdfs)
                top = at
                if names:
                    for i, name in enumerate(names[0]):
                        parts.append(text(x0 + (i + 0.5) * each, at + 2.4, name, 2.3, "bold", "middle", INK2))
                    top += 3.4
                tallest = 0.0
                for i, pdf in enumerate(pdfs):
                    panel = Panel(pdf, f"{letter}-{x0:.0f}-{pdf.stem}")
                    parts.append(panel.place(x0 + i * each, top, each))
                    tallest = max(tallest, panel.height_at(each))
                at = top + tallest + 2.0
            heights.append(at - y)
        y += max(heights) + 2.0

    row("a", "APA between each CTCF peak and the next, chr19 at 2 kb, ±10 bins, over the expected",
        [(APP / "apa.pdf", 0.85)], [(REF / "apa.pdf", 0.85)])
    row("b", "CTCF (two labs) and ATAC-seq about the CTCF peaks, ±2 kb in 50-bp columns",
        [(APP / "metaplot-signal.pdf", 1.0),
         ([APP / f"metaplot-signal-heatmap-{i}.pdf" for i in (1, 2, 3)], 1.0, ["CTCF · Broad", "CTCF · Stanford", "ATAC"])],
        [(REF / "metaplot-signal-profile.pdf", 1.0), (REF / "metaplot-signal-heatmap.pdf", 1.0)])
    row("c", "The insulation at four windows about the same peaks, ±500 kb in 10-kb columns",
        [(APP / "metaplot-insulation.pdf", 1.0),
         ([APP / f"metaplot-insulation-heatmap-{i}.pdf" for i in (1, 2, 3, 4)], 1.0,
          ["400 kb", "200 kb", "100 kb", "50 kb"])],
        [(REF / "metaplot-insulation-profile.pdf", 1.0), (REF / "metaplot-insulation-heatmap.pdf", 1.0)])

    height = y + 2.0
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'width="{W}mm" height="{height:.2f}mm" viewBox="0 0 {W} {height:.2f}">'
           f'<rect width="{W}" height="{height:.2f}" fill="#ffffff"/>{"".join(parts)}</svg>')
    (HERE / "figure2.svg").write_text(svg)
    subprocess.run(["node", str(SVG2PDF), str(HERE / "figure2.svg")], check=True)

    rows = [("quantity", "chromosomix", "reference")]
    apa = numbers_of(APP / "apa.tsv")
    reference = dict(line.split("\t", 1) for line in (REF / "numbers.tsv").read_text().splitlines()[1:])
    rows.append(("APA: pairs piled up", apa.get("windows", ""), reference.get("APA: pairs piled up (coolpuppy's n)", "")))
    rows.append(("APA: P2LL", apa.get("P2LL", ""), reference.get("APA: P2LL, the app's formula", "")))
    for name in ("metaplot-signal", "metaplot-insulation"):
        notes = numbers_of(APP / f"{name}.tsv")
        counts = sorted({v for k, v in notes.items() if k.startswith("n ")})
        rows.append((f"{name}: features", ", ".join(counts), reference.get(f"{name}: regions", "")))
    (HERE / "numbers.tsv").write_text("".join("\t".join(r) + "\n" for r in rows))
    print("wrote figure2.svg, figure2.pdf, figure2.png and numbers.tsv")


if __name__ == "__main__":
    sys.exit(main())
