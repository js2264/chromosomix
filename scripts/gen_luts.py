"""Regenerate ``src/render/luts.ts`` from matplotlib's own colormap tables.

Run with any Python that has matplotlib and numpy, e.g. metacooler's own venv::

    /path/to/metacooler/.venv/bin/python scripts/gen_luts.py

The tables are committed as TypeScript literals so the browser never depends on
matplotlib, but they must *originate* there: spec §7.1 requires the browser and
``metacooler show`` to produce the same picture, and an approximated ``afmhot_r``
would drift every figure in the paper away from what a reader reproduces.

Adding a colormap means adding a row to MAPS and re-running this script.
"""

from pathlib import Path

import matplotlib
import numpy as np

OUT = Path(__file__).resolve().parent.parent / "src" / "render" / "luts.ts"

MAPS = [
    (
        "AFMHOT_R",
        "afmhot_r",
        "The `metacooler show` default (`ops/show.py`): white background, black\n * hot. Reversed `afmhot`, so a contact map reads as ink on paper.",
    ),
    (
        "AFMHOT",
        "afmhot",
        "Black background, white hot — the un-reversed original, for dark figures.",
    ),
    (
        "VIRIDIS",
        "viridis",
        "Perceptually uniform, the matplotlib default. Not the metacooler default,\n * but the one most readers recognise.",
    ),
    (
        "MAGMA",
        "magma",
        "Perceptually uniform, dark background — closer in feel to the Hi-C\n * literature's usual red-on-white while staying uniform in lightness.",
    ),
    (
        "CIVIDIS",
        "cividis",
        "The colour-vision-safe option (spec §7.2). Designed so that a deuteranope\n * and a trichromat see the same ordering of values, unlike `afmhot_r`.",
    ),
]

HEADER = '''/**
 * Colormap lookup tables, copied verbatim from matplotlib.
 *
 * Generated from matplotlib {mplver} (`matplotlib.colormaps[name](np.arange(256),
 * bytes=True)`), which is exactly the table `imshow` indexes into. They are
 * literals rather than a hand-rolled gradient because spec §7.1 requires the
 * browser and `metacooler show` to produce the *same picture*: an eyeballed
 * approximation of `afmhot_r` would drift the paper's figures away from what a
 * reader reproduces locally.
 *
 * Stored as flat RGB triples, 256 × 3 = 768 entries. Alpha is a uniform 255 in
 * all five matplotlib tables (verified at generation time), so carrying it would
 * be 256 redundant bytes per map; `applyColormap` re-inserts it.
 *
 * Do not hand-edit. Regenerate with `scripts/gen_luts.py` if a colormap is added.
 */

'''


def emit(name: str, mpl: str, doc: str) -> str:
    rgba = matplotlib.colormaps[mpl](np.arange(256), bytes=True)
    assert bool((rgba[:, 3] == 255).all()), mpl
    flat = rgba[:, :3].reshape(-1).tolist()
    lines = []
    # 12 values per line == 4 colours per line, so a row of the source is a
    # readable stride of the table.
    for i in range(0, len(flat), 12):
        chunk = ", ".join(f"{v:3d}" for v in flat[i : i + 12])
        lines.append(f"  {chunk},")
    body = "\n".join(lines)
    return (
        f"/**\n * `{mpl}` — {doc}\n */\n"
        f"export const {name}_RGB: readonly number[] = [\n{body}\n]\n"
    )


def main() -> None:
    parts = [HEADER.format(mplver=matplotlib.__version__)]
    parts.extend(emit(*m) for m in MAPS)
    OUT.write_text("\n".join(parts))
    print("wrote", OUT)


main()
