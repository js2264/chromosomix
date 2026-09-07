#!/usr/bin/env python
"""Build the `cooler cload pairs` oracle for the `.pairs` importer (spec §3.7).

Run with an interpreter that has cooler installed::

    METACOOLER_PYTHON=.venv/bin/python npm run fixtures:pairs

Writes ``test/fixtures/pairs/`` — a `.pairs` file, its `pairix` index where
`pairix` is on the PATH, and one cooler per resolution produced by **cooler
itself** — plus ``test/golden/pairs_cload.json``, which
``test/unit/pairs-cload-oracle.test.ts`` reads.

Why this exists, and why it is a separate command
-------------------------------------------------
SPECS §18.9 refuses to write a contact matrix the app *derived*, and narrows
that to permit the one this app does write: the primary reduction of a `.pairs`
file. The narrowing was allowed on a stated condition — that the writer is held
to the same bar §18.9 sets for a *port*, which is a golden built from the
reference implementation's own output rather than from a previous run of this
code.

`cooler cload pairs` is that reference. It is not a rough equivalent: it is the
command this repository's own `data/README.md` already runs on the same files,
so the comparison is between two implementations of one documented operation.

This is a second command rather than a flag on ``fixtures`` for the reason
``fixtures:analysis`` is: the two prove different layers against different
references and need different packages, and folding them together would mean a
run that half-succeeds on a machine missing one of them.

What is compared, and what is deliberately not
----------------------------------------------
**Compared, for exact equality**: the pixel table cell for cell (``bin1_id``,
``bin2_id``, ``count``), the ``chroms`` and ``bins`` tables, ``nnz`` and ``sum``.
Those are the numbers, and a tolerance would let through exactly the off-by-one
at a bin edge that this whole exercise exists to catch.

**Not compared**: HDF5 layout, chunking, compression, attribute ordering, and
the dtype of ``bins/chrom`` — cooler writes it as an enum and h5wasm cannot
construct one, so the viewer writes int32 codes. That difference is recorded in
``notes`` rather than silently tolerated, so a future reader of a failing test
knows which differences were known.

The 1-based question
--------------------
A `.pairs` file's positions are 1-based, and ``cooler cload pairs`` assumes so
unless told otherwise. Getting this wrong shifts every record at a bin boundary
into its neighbour, which is invisible in a picture and permanent in a file — so
the fixture deliberately places records **on** bin edges (see ``EDGE_CASES``),
and the golden would differ if either side changed its convention.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "test" / "fixtures" / "pairs"
GOLDEN_DIR = ROOT / "test" / "golden"

# Small, and every length chosen so at least one contig has a short final bin at
# every resolution below — which is the arithmetic §3.3 makes exact and the one
# a global `floor(bin / k)` gets wrong at every contig boundary.
CONTIGS = [("chrI", 2_300), ("chrII", 1_050), ("chrIII", 700)]
RESOLUTIONS = [100, 200, 500, 1000]

# Records that sit exactly on a bin edge, on the last base of a contig, and in
# the trans block. Written first and then followed by the pseudo-random bulk.
EDGE_CASES = [
    ("chrI", 1, "chrI", 1),
    ("chrI", 100, "chrI", 100),
    ("chrI", 101, "chrI", 101),
    ("chrI", 100, "chrI", 101),
    ("chrI", 2_300, "chrI", 2_300),
    ("chrI", 2_300, "chrII", 1),
    ("chrII", 1_050, "chrIII", 700),
    ("chrIII", 1, "chrIII", 700),
]

N_RANDOM = 20_000


def lcg(seed: int):
    """The same generator the JS fixtures use, so the two can be compared by eye."""
    state = seed & 0xFFFFFFFF

    def nxt() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 0x100000000

    return nxt


def build_records() -> list[tuple[str, int, str, int]]:
    rnd = lcg(7)
    records = list(EDGE_CASES)
    for _ in range(N_RANDOM):
        n1, l1 = CONTIGS[int(rnd() * len(CONTIGS))]
        n2, l2 = CONTIGS[int(rnd() * len(CONTIGS))]
        p1 = 1 + int(rnd() * l1)
        p2 = 1 + int(rnd() * l2)
        records.append((n1, p1, n2, p2))
    # The order `#sorted: chr1-chr2-pos1-pos2` declares. Sorting here rather
    # than trusting the generator is what lets the *unsorted* case be a separate
    # fixture rather than an accident of the seed.
    rank = {name: i for i, (name, _) in enumerate(CONTIGS)}
    records.sort(key=lambda r: (rank[r[0]], rank[r[2]], r[1], r[3]))
    return records


def write_pairs(path: Path, records) -> None:
    lines = [
        "## pairs format v1.0",
        "#sorted: chr1-chr2-pos1-pos2",
        "#shape: upper triangle",
        "#genome_assembly: testAsm",
    ]
    lines += [f"#chromsize: {name} {length}" for name, length in CONTIGS]
    lines.append("#columns: readID chr1 pos1 chr2 pos2 strand1 strand2")
    for i, (n1, p1, n2, p2) in enumerate(records):
        lines.append(f"SRR.{i}\t{n1}\t{p1}\t{n2}\t{p2}\t+\t-")
    path.write_text("\n".join(lines) + "\n")


def run(cmd: list[str]) -> None:
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep intermediate coolers")
    args = parser.parse_args()

    try:
        import cooler  # noqa: F401
        import h5py
    except ImportError as exc:  # pragma: no cover - environment dependent
        print(f"cooler and h5py are required: {exc}", file=sys.stderr)
        print("pip install cooler", file=sys.stderr)
        return 1

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)

    records = build_records()
    plain = FIXTURE_DIR / "oracle.pairs"
    write_pairs(plain, records)
    print(f"wrote {plain} ({len(records)} records)")

    # bgzip + pairix where they exist. Both are optional: the importer reads a
    # plain file, and the index is opportunistic (§3.7).
    gz = FIXTURE_DIR / "oracle.pairs.gz"
    indexed = False
    if shutil.which("bgzip"):
        run(["bgzip", "-f", "-k", str(plain)])
        if shutil.which("pairix"):
            run(["pairix", "-f", str(gz)])
            indexed = (FIXTURE_DIR / "oracle.pairs.gz.px2").exists()
    else:
        print("  bgzip not found — skipping the compressed fixture")

    # One bin table and one cooler per resolution, both from cooler itself.
    golden = {
        "contigs": [{"name": n, "length": l} for n, l in CONTIGS],
        "records": len(records),
        "assembly": "testAsm",
        "indexed": indexed,
        "resolutions": {},
        "notes": [
            "Produced by `cooler cload pairs`; positions are 1-based, which is that "
            "command's default for this format.",
            "bins/chrom dtype is not compared: cooler writes an HDF5 enum and h5wasm "
            "cannot construct one, so the viewer writes int32 codes. Every number is "
            "identical; only the dtype differs.",
        ],
    }

    sizes = FIXTURE_DIR / "chrom.sizes"
    sizes.write_text("".join(f"{n}\t{l}\n" for n, l in CONTIGS))

    source = gz if gz.exists() else plain
    for res in RESOLUTIONS:
        cool = FIXTURE_DIR / f"oracle.{res}.cool"
        run(
            [
                "cooler", "cload", "pairs",
                "-c1", "2", "-p1", "3", "-c2", "4", "-p2", "5",
                "--assembly", "testAsm",
                f"{sizes}:{res}", str(source), str(cool),
            ]
        )
        with h5py.File(cool, "r") as f:
            attrs = dict(f.attrs)
            golden["resolutions"][str(res)] = {
                "nbins": int(len(f["bins"]["start"])),
                "nnz": int(attrs.get("nnz", len(f["pixels"]["count"]))),
                "sum": int(attrs.get("sum", int(f["pixels"]["count"][:].sum()))),
                "storage_mode": str(attrs.get("storage-mode", "symmetric-upper")),
                "bin_start": [int(v) for v in f["bins"]["start"][:]],
                "bin_end": [int(v) for v in f["bins"]["end"][:]],
                "bin_chrom": [int(v) for v in f["bins"]["chrom"][:]],
                "bin1_id": [int(v) for v in f["pixels"]["bin1_id"][:]],
                "bin2_id": [int(v) for v in f["pixels"]["bin2_id"][:]],
                "count": [int(v) for v in f["pixels"]["count"][:]],
                "chrom_offset": [int(v) for v in f["indexes"]["chrom_offset"][:]],
                "bin1_offset": [int(v) for v in f["indexes"]["bin1_offset"][:]],
            }
        if not args.keep:
            cool.unlink()

    out = GOLDEN_DIR / "pairs_cload.json"
    out.write_text(json.dumps(golden, sort_keys=True, indent=1))
    print(f"wrote {out}")
    print(
        "  resolutions: "
        + ", ".join(
            f"{r} ({golden['resolutions'][str(r)]['nnz']} px)" for r in RESOLUTIONS
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
