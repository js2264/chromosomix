#!/usr/bin/env python
"""Check PDBs this app wrote against PyMOL itself (SPECS §25.7).

Needs only PyMOL's open-source build, which pip installs as a wheel::

    pip install pymol-open-source-whl
    python scripts/check_pdb_pymol.py model.pdb [more.pdb …] [--png out/]

The PDBs are the ones the Structures card's **PDB** button writes, or
``chromosomix reconstruct3d --out`` writes beside its bed3d.

**What the writer promises is a claim about PyMOL, so PyMOL is the judge.**
``test/unit/pdb.test.ts`` holds the file to the format's columns; this holds it
to what the format's columns are *for*. For every file, PyMOL must load:

- one atom per HETATM record;
- **exactly the bonds the CONECT records declare** — none guessed from
  distance, which is what PyMOL does to a file without CONECT records, and
  what turns a model a unit per step into a lattice;
- no bond between two chains (a chain being its letter and its segment);
- the atoms in the file's order, so a rainbow along a chain runs along it;
- neighbouring beads at a median of 3.8 apart, the step the writer scales to;

and the PyMOL lines in the file's own REMARK 250 block must run as written.
With ``--png DIR`` each file is also drawn twice, by those lines: as the
cartoon trace and as beads, coloured by chain.

Exits 1 on the first file that fails any of them, naming the file and the check.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

try:
    import pymol2
except ImportError:  # pragma: no cover - the message is the point
    sys.exit("PyMOL is not installed: pip install pymol-open-source-whl")

STEP = 3.8


def declared_bonds(text: str) -> set[tuple[int, int]]:
    """Every bond the CONECT records list, as ordered pairs of serials."""
    pairs: set[tuple[int, int]] = set()
    for line in text.splitlines():
        if not line.startswith("CONECT"):
            continue
        serials = [int(line[at:at + 5]) for at in range(6, len(line), 5) if line[at:at + 5].strip()]
        for other in serials[1:]:
            pairs.add((min(serials[0], other), max(serials[0], other)))
    return pairs


def pymol_lines(text: str) -> tuple[list[str], list[str]]:
    """The cartoon lines and the beads line from the file's REMARK 250 block."""
    remarks = [line[11:].strip() for line in text.splitlines() if line.startswith("REMARK 250")]
    at = remarks.index("In PyMOL, drawn as chromosomix draws it:")
    return remarks[at + 1:at + 3], remarks[at + 4:at + 5]


def check(path: Path, png: Path | None) -> list[str]:
    text = path.read_text()
    records = sum(1 for line in text.splitlines() if line.startswith("HETATM"))
    declared = declared_bonds(text)
    failures: list[str] = []
    with pymol2.PyMOL() as session:
        cmd = session.cmd
        # Errors and warnings still print; what PyMOL says about every setting does not.
        cmd.feedback("disable", "all", "results actions details blather")
        cmd.load(str(path), "fibre")
        molecule = cmd.get_model("fibre")
        atoms = molecule.atom
        bonds = {tuple(sorted((atoms[b.index[0]].id, atoms[b.index[1]].id))) for b in molecule.bond}
        chain_of = {atom.id: (atom.chain, atom.segi) for atom in atoms}
        where = {atom.id: atom.coord for atom in atoms}
        if len(atoms) != records:
            failures.append(f"{len(atoms)} atoms loaded from {records} HETATM records")
        if bonds != declared:
            failures.append(
                f"{len(bonds - declared)} bonds PyMOL added and {len(declared - bonds)} it dropped, "
                f"of {len(declared)} declared"
            )
        crossing = [pair for pair in bonds if chain_of[pair[0]] != chain_of[pair[1]]]
        if crossing:
            failures.append(f"{len(crossing)} bonds between two chains")
        serials = [atom.id for atom in atoms]
        if serials != sorted(serials):
            failures.append("PyMOL reordered the atoms")
        lengths = sorted(math.dist(where[a], where[b]) for a, b in bonds)
        if lengths and abs(lengths[len(lengths) // 2] - STEP) > 0.01:
            failures.append(f"median step {lengths[len(lengths) // 2]:.3f}, not {STEP}")
        cartoon, beads = pymol_lines(text)
        for label, lines in (("cartoon", cartoon), ("beads", beads)):
            cmd.hide("everything")
            for line in lines:
                cmd.do(line)
            if png is not None:
                cmd.bg_color("white")
                cmd.orient("fibre")
                cmd.png(str(png / f"{path.stem}-{label}.png"), width=1000, height=800, ray=1)
        print(
            f"{path.name}: {len(atoms)} atoms, {len(cmd.get_chains('fibre'))} chains, {len(bonds)} bonds"
            + (f", median step {lengths[len(lengths) // 2]:.2f}" if lengths else "")
            + ("" if failures else " — as written")
        )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("pdbs", nargs="+", type=Path)
    parser.add_argument("--png", type=Path, help="draw each file into this folder by its own PyMOL lines")
    args = parser.parse_args()
    if args.png is not None:
        args.png.mkdir(parents=True, exist_ok=True)
    for path in args.pdbs:
        failures = check(path, args.png)
        if failures:
            for failure in failures:
                print(f"{path}: {failure}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
