#!/usr/bin/env python
"""Write the two synthetic 3D models the structure reader (§25) is demonstrated on.

``python3 scripts/make_structure_demo.py`` — no arguments, no network, idempotent.
Needs ``h5py`` (to read the chromosome tables out of the demo coolers) and
nothing else beyond the standard library.

Why this exists
---------------

§25 reads WashU's g3d text — `chromosome  start  x  y  z`, one bead per row, the
spacing inferred from the starts — and the demos had nothing to drop on it. A
real model of either demo genome would be a solver's output and a paper's
claim; this script writes two **made-up** ones instead, shaped like what a
biologist expects the organism to look like, so the reader, the lane, the
search and the export can be tried on a file whose every bead is at a known
place. **Neither model is inferred from the contact maps beside it.** They are
development fixtures at demo scale, and nothing in them is a finding.

What it writes, and what each one is for
----------------------------------------

``demo/ecoli/Ecoli.g3d.gz``
    The E. coli chromosome as a **closed ring**: one bead per 5 kb from the
    chromosome name and length in ``Ecoli.mcool``, laid on a circle in the xy
    plane with a few low-frequency harmonics of ``t = i/N`` added on every axis,
    so the chain closes on itself smoothly — the last bead is a neighbour of the
    first — and looks like a crumpled ring rather than a drawn circle. That
    closure is the thing to look at: a viewer that draws a genome as a line has
    to be shown a genome that is not one.

``demo/yeast/Yeast_structure.g3d.gz``
    The sixteen yeast chromosomes in a **Rabl configuration**: names and
    lengths from ``Yeast_microC_G2M_1kb.cool``, one bead per 5 kb per
    chromosome. The centromeres are clustered under one pole of a nucleus of
    radius ``R`` (the spindle pole body, at ``(0, 0, +R)``); from each
    centromere the two arms run away from the pole towards the periphery with a
    chromosome-specific bend and a small wobble, dipping into the interior on
    the way, so the telomeres lie near the surface and long arms reach further
    round — into the far hemisphere — than short ones. Centromere positions are
    the S288C midpoints (:data:`CENTROMERES`), matched to the file's names by
    Roman numeral so ``XIII-syn40`` finds ``XIII``, and clamped to the
    chromosome's length in case a synthetic chromosome is shorter than the
    reference. The rDNA of chromosome XII (450–490 kb on S288C, an array of a
    megabase or more collapsed to two copies in the reference) is drawn as a
    loop bulging towards the opposite pole, where the nucleolus sits; that is
    done only when the chromosome is long enough to hold the region, and
    :func:`yeast_beads` says where.

Both files are tab-separated ``chromosome  start  x  y  z`` — no header, no
haplotype column, chromosomes in the cooler's order and starts ascending
within each — and gzipped with the member's ``mtime`` pinned to zero, so
running the script twice gives byte-identical files and a re-run that changes
nothing shows up as nothing in ``git status``. Coordinates are in arbitrary
model units to four decimals; the ring has radius 60 and the nucleus radius
100, which is what the coordinates mean and all they mean.

The spacing is **not written anywhere**. The viewer infers it from the
consecutive starts (§25, `widthOf`), which is why both files are on a strict
5 kb grid from zero; the printed bead counts are ``ceil(length / 5000)`` per
chromosome.

What was checked
----------------

Both files were loaded with WashU's own tool, which is the reference reader
for the format::

    g3dtools load demo/ecoli/Ecoli.g3d.gz -o /tmp/check -r 5000 -n x -g y
    g3dtools meta /tmp/check.g3d
    g3dtools load demo/yeast/Yeast_structure.g3d.gz -o /tmp/check -r 5000 -n x -g y
    g3dtools meta /tmp/check.g3d

Both loads succeed: ``load`` prints ``Done read 929 records`` for E. coli
(``NC_000913.3``, 4,641,652 bp) and ``Done read 2431 records`` for yeast
(sixteen chromosomes, from 47 beads on I to 307 on IV), which are the counts
this script prints, and ``meta`` reports each output at resolution 5000 with
the one category ``shared``. `test/unit/structure-demo.test.ts` reads the same
two files through the viewer's own parser and holds the geometry to its word:
the ring closes, the centromeres sit under the pole and the arms run away from
it.

To rerun: ``python3 scripts/make_structure_demo.py`` from anywhere; it prints
the chromosomes it read and the bead count of each file it wrote.
"""

from __future__ import annotations

import gzip
import io
import math
import random
import re
import sys
from pathlib import Path
from typing import Iterator

import h5py

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent / "demo"

ECOLI_COOL = DEMO / "ecoli" / "Ecoli.mcool"
ECOLI_G3D = DEMO / "ecoli" / "Ecoli.g3d.gz"
YEAST_COOL = DEMO / "yeast" / "Yeast_microC_G2M_1kb.cool"
YEAST_G3D = DEMO / "yeast" / "Yeast_structure.g3d.gz"

#: One bead per this many bases, in both files.
SPACING = 5000

#: S. cerevisiae S288C centromere midpoints, by chromosome (SGD, R64).
CENTROMERES = {
    "I": 151465,
    "II": 238207,
    "III": 114385,
    "IV": 449711,
    "V": 151987,
    "VI": 148510,
    "VII": 496920,
    "VIII": 105586,
    "IX": 355629,
    "X": 436307,
    "XI": 440129,
    "XII": 150828,
    "XIII": 268031,
    "XIV": 628758,
    "XV": 326584,
    "XVI": 555957,
}

#: The rDNA array on chromosome XII, as the S288C reference has it (two
#: copies of the 9.1 kb repeat inside RDN1, roughly 451–469 kb, drawn a little
#: wider so the loop has a dozen beads to be a loop with).
RDNA = ("XII", 440_000, 500_000)

Bead = tuple[str, int, float, float, float]


# ---------------------------------------------------------------------------
# Chromosomes out of a cooler
# ---------------------------------------------------------------------------


def read_chroms(path: Path) -> list[tuple[str, int]]:
    """The ``chroms`` table of a cooler or an mcool, in file order.

    An mcool keeps one table per resolution and they are all the same table,
    so the coarsest is read — it is the smallest group to open.
    """
    with h5py.File(path, "r") as file:
        if "resolutions" in file:
            coarsest = max(file["resolutions"], key=int)
            group = file["resolutions"][coarsest]
        else:
            group = file
        names = [n.decode() if isinstance(n, bytes) else str(n) for n in group["chroms/name"][:]]
        lengths = [int(l) for l in group["chroms/length"][:]]
    return list(zip(names, lengths))


def roman_of(name: str) -> str | None:
    """The Roman numeral a yeast chromosome name carries, or ``None``.

    ``I``, ``chrI``, ``chrXIII-syn40`` and ``XIII-syn40`` all read as the
    numeral before the first character that is not part of one; ``chr12``
    is accepted as its Roman equivalent, since the table is keyed that way.
    """
    match = re.match(r"(?:chr)?([IVX]+)(?![A-Za-z0-9])", name, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    match = re.match(r"(?:chr)?(\d+)(?![A-Za-z0-9])", name)
    if match:
        numerals = list(CENTROMERES)
        index = int(match.group(1)) - 1
        if 0 <= index < len(numerals):
            return numerals[index]
    return None


def centromere_of(name: str, length: int) -> int:
    """Where the centromere is on this chromosome, clamped to it."""
    roman = roman_of(name)
    if roman is None or roman not in CENTROMERES:
        print(f"warning: {name!r} is not a chromosome the centromere table knows; using a third of its length")
        return length // 3
    cen = CENTROMERES[roman]
    if cen >= length:
        print(f"warning: {name!r} is shorter ({length}) than its S288C centromere ({cen}); clamping")
        cen = max(0, length - SPACING)
    return cen


# ---------------------------------------------------------------------------
# The two models
# ---------------------------------------------------------------------------


def bead_count(length: int) -> int:
    """Beads at :data:`SPACING` over ``[0, length)``: starts ``0, 5000, … < length``."""
    return (length + SPACING - 1) // SPACING


def harmonics(rng: random.Random, count: int, scale: float) -> list[tuple[int, float, float]]:
    """``count`` low-frequency terms ``(k, amplitude, phase)`` with amplitude falling as ``1/k``."""
    return [(k, scale / k * (0.6 + 0.4 * rng.random()), rng.random() * 2 * math.pi) for k in range(2, 2 + count)]


def ecoli_beads(name: str, length: int) -> Iterator[Bead]:
    """A crumpled ring: a circle of radius 60 plus periodic wobble, closed at ``t = 1``.

    Every term is a whole number of cycles in ``t = i / N``, so the curve at
    ``t = 1`` is the curve at ``t = 0`` and bead ``N - 1`` sits one step short
    of bead ``0``.
    """
    rng = random.Random(4641652)
    ring = 60.0
    radial = harmonics(rng, 5, 9.0)
    vertical = harmonics(rng, 5, 12.0)
    n = bead_count(length)
    for i in range(n):
        t = i / n
        a = 2 * math.pi * t
        r = ring + sum(amp * math.cos(k * a + phase) for k, amp, phase in radial)
        z = sum(amp * math.sin(k * a + phase) for k, amp, phase in vertical)
        yield name, i * SPACING, r * math.cos(a), r * math.sin(a), z


#: Radius of the yeast nucleus, in model units; the spindle pole body is at ``(0, 0, R)``.
R = 100.0
#: Radians of polar angle an arm sweeps per base: the longest arm (IV right,
#: 1.08 Mb) reaches all the way round to the far pole.
SWEEP = (math.pi - 0.25) / 1_100_000
#: Half the angle between a chromosome's two arms as they leave the centromere.
SPREAD = 0.30


def spherical(r: float, theta: float, phi: float) -> tuple[float, float, float]:
    """A point at radius ``r``, polar angle ``theta`` from ``+z`` and azimuth ``phi``."""
    return r * math.sin(theta) * math.cos(phi), r * math.sin(theta) * math.sin(phi), r * math.cos(theta)


def yeast_beads(chroms: list[tuple[str, int]]) -> Iterator[Bead]:
    """Sixteen chromosomes in Rabl orientation, in the cooler's order.

    Each chromosome gets an azimuth round the pole and a centromere just under
    it; each arm then runs its ``s ∈ (0, 1]`` from the centromere outwards,
    its polar angle growing in proportion to its length in bases, its azimuth
    drifting by a chromosome-specific bend, its radius dipping into the
    interior and returning to the periphery at the telomere, with a small
    sine wobble that is zero at the centromere so both arms leave one point.
    """
    rng = random.Random(288)
    count = len(chroms)
    for index, (name, length) in enumerate(chroms):
        n = bead_count(length)
        cen = centromere_of(name, length)
        cen_bead = min(cen // SPACING, n - 1)
        phi_c = 2 * math.pi * index / count + (rng.random() - 0.5) * 0.2
        theta_c = 0.10 + 0.06 * rng.random()
        r_c = R * (0.86 + 0.03 * rng.random())
        arms: dict[int, tuple] = {}
        for sign in (-1, +1):
            arm_beads = cen_bead if sign < 0 else n - 1 - cen_bead
            arm_bp = max(1, arm_beads) * SPACING
            reach = min(1.0, arm_bp / 500_000)
            arms[sign] = (
                arm_beads,
                min(math.pi - theta_c - 0.05, SWEEP * arm_bp),  # polar sweep
                sign * (0.4 + 0.5 * rng.random()),  # azimuth bend over the arm
                R * (0.93 + 0.07 * reach),  # telomere radius
                R * 0.30 * min(1.0, arm_bp / 400_000),  # mid-arm dip
                [(k, R * 0.02 / k, rng.random() * 2 * math.pi) for k in (2, 3, 5)],  # wobble
            )
        rdna = roman_of(name) == RDNA[0] and length >= RDNA[2]
        for i in range(n):
            if i == cen_bead:
                x, y, z = spherical(r_c, theta_c, phi_c)
            else:
                sign = -1 if i < cen_bead else +1
                arm_beads, sweep, bend, r_end, dip, wobble = arms[sign]
                s = abs(i - cen_bead) / arm_beads
                ease = 1 - (1 - s) ** 3
                theta = theta_c + sweep * s
                phi = phi_c + sign * SPREAD * ease + bend * s
                r = r_c + (r_end - r_c) * s - dip * math.sin(math.pi * s)
                x, y, z = spherical(r, theta, phi)
                for k, amp, phase in wobble:
                    x += amp * math.sin(k * math.pi * s + phase)
                    y += amp * math.sin(k * math.pi * s + phase * 1.7)
                    z += amp * math.sin(k * math.pi * s + phase * 2.3)
                if rdna and RDNA[1] <= i * SPACING < RDNA[2]:
                    # The nucleolus: the rDNA beads are pushed towards the far
                    # pole (0, 0, -R) by a raised-cosine bump, so the region
                    # stands out of the arm as a loop the arm returns from.
                    u = (i * SPACING - RDNA[1] + SPACING / 2) / (RDNA[2] - RDNA[1])
                    bump = 0.5 - 0.5 * math.cos(2 * math.pi * u)
                    dx, dy, dz = -x, -y, -R - z
                    norm = math.hypot(dx, dy, dz) or 1.0
                    push = 0.25 * R * bump / norm
                    x, y, z = x + dx * push, y + dy * push, z + dz * push
            yield name, i * SPACING, x, y, z


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def write_g3d(path: Path, beads: Iterator[Bead]) -> int:
    """Write ``beads`` as gzipped g3d text and return how many there were.

    The gzip member's ``mtime`` is pinned to zero (``GzipFile`` writes it into
    the header at construction, so ``gzip.open`` alone would stamp the file
    with the clock), and the text goes through it as ASCII with ``\\n`` ends.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with gzip.GzipFile(filename=str(path), mode="wb", mtime=0) as raw:
        with io.TextIOWrapper(raw, encoding="ascii", newline="\n") as out:
            for name, start, x, y, z in beads:
                out.write(f"{name}\t{start}\t{x:.4f}\t{y:.4f}\t{z:.4f}\n")
                count += 1
    return count


def main() -> int:
    ecoli = read_chroms(ECOLI_COOL)
    print(f"{ECOLI_COOL.name}: " + ", ".join(f"{name} ({length:,} bp)" for name, length in ecoli))
    if len(ecoli) != 1:
        print(f"warning: expected one chromosome in {ECOLI_COOL.name}, found {len(ecoli)}; ringing the first")
    name, length = ecoli[0]
    n = write_g3d(ECOLI_G3D, ecoli_beads(name, length))
    print(f"wrote {ECOLI_G3D.relative_to(DEMO.parent)}: {n:,} beads at {SPACING} bp, one circular chromosome")

    yeast = read_chroms(YEAST_COOL)
    print(f"{YEAST_COOL.name}: " + ", ".join(f"{name} ({length:,} bp)" for name, length in yeast))
    n = write_g3d(YEAST_G3D, yeast_beads(yeast))
    print(f"wrote {YEAST_G3D.relative_to(DEMO.parent)}: {n:,} beads at {SPACING} bp over {len(yeast)} chromosomes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
