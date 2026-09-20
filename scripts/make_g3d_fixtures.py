#!/usr/bin/env python
"""Build the binary g3d test fixtures, with ``g3dtools`` as their writer.

Run it alone — it needs only ``g3dtools`` (which brings ``msgpack``)::

    python scripts/make_g3d_fixtures.py

``npm run fixtures:g3d`` runs it.

**The container is written by g3dtools itself, and that is the whole design.**
The reader under ``src/annotations/g3dBinary.ts`` is an in-house port of what
``g3dtools load`` writes and the WashU browser reads, so the file it is tested
against has to be one of theirs: a text model is written here, deterministic
down to the row order, and ``g3dtools load`` turns it into the ``.g3d``.  The
JS oracle test then reads that file with both the in-house reader and the
``g3djs`` package, bead for bead — two implementations of one container over a
file the reference tool produced, rather than this repository against itself.

Three fixtures, all under ``test/fixtures/structure/``:

- ``toy.g3d.txt`` and ``toy.g3d`` — a phased model: ``chr1`` (40 beads) and
  ``chr2`` (25 beads) at 20 kb, haplotypes ``m`` and ``p``, each chain a smooth
  helix with its own phase so no two beads coincide, coordinates to 4 decimals,
  rows shuffled with a fixed seed because the text format is unsorted and the
  writer sorts.  Loaded with ``-s 2,4`` for three resolutions: 20, 40 and 80 kb.
- ``plain.g3d.txt`` and ``plain.g3d`` — a haploid model: one chromosome, five
  columns and no haplotype, so the ``shared`` category and the single-resolution
  header are covered.
- ``msgpack.bin`` and ``msgpack.json`` — one value packed by Python's
  ``msgpack`` and the same value as JSON, for the decoder's round-trip test.
  A second value, a float packed with ``use_single_float=True``, follows the
  first in the ``.bin`` so the decoder's "where did the object end" answer is
  exercised too.  The JSON holds the ``bin`` as base64 and the integer keys as
  the strings JSON forces them to be; the test undoes both.

**One workaround, recorded so nobody removes it.** ``g3dtools`` 0.2.3 opens a
plain text input with ``open(fn, 'rU')``, a mode Python 3.11 removed, and opens
a ``.gz`` input with ``gzip.open`` — so the text is also written gzipped (with
a zero mtime, to keep it deterministic) and *that* copy is handed to
``g3dtools load``.  The ``.txt`` beside it is what the JS test parses with the
text reader.

**Checked against g3dtools' own ``meta`` and ``query``** every time it runs:
``g3dtools meta`` must report version 2, the resolutions and the categories
this script expects, and ``g3dtools query -G`` at the base resolution must
give back every row that was written, coordinate for coordinate.  The counts
``query`` reports at every resolution are recorded in ``g3d-manifest.json``
so the JS side can assert them without re-deriving the scaling rule.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import logging
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "test" / "fixtures" / "structure"

log = logging.getLogger("make_g3d_fixtures")

#: The phased model: chromosomes and how many beads each has.
TOY_CHROMS = {"chr1": 40, "chr2": 25}
TOY_RESOLUTION = 20_000
#: The two haplotype letters the text carries, and the words g3dtools writes.
TOY_HAPLOTYPES = {"m": "maternal", "p": "paternal"}
TOY_SCALES = (2, 4)
TOY_SEED = 20250916

#: The haploid model: one chromosome, no haplotype column.
PLAIN_CHROMS = {"chr1": 30}
PLAIN_RESOLUTION = 10_000


def helix(bead: int, count: int, phase: float, radius: float, lift: float) -> tuple[float, float, float]:
    """One bead of a helix: consecutive beads a short step apart, the chain a few turns round."""
    t = bead / max(count - 1, 1)
    angle = t * 4 * math.pi + phase
    return (
        round(radius * math.cos(angle), 4),
        round(radius * math.sin(angle), 4),
        round(t * 60.0 - 30.0 + lift, 4),
    )


def toy_rows() -> list[tuple[str, int, float, float, float, str]]:
    """Every bead of the phased model, in genomic order, before the shuffle."""
    rows = []
    for index, (chrom, count) in enumerate(TOY_CHROMS.items()):
        for hap_index, hap in enumerate(TOY_HAPLOTYPES):
            # A different phase per haplotype and a different radius and lift
            # per chromosome, so no two chains share a bead and no chromosome
            # sits inside another.
            phase = hap_index * math.pi / 2 + index * 0.3
            radius = 10.0 + 5.0 * index + 2.0 * hap_index
            lift = 80.0 * index
            for bead in range(count):
                x, y, z = helix(bead, count, phase, radius, lift)
                rows.append((chrom, bead * TOY_RESOLUTION, x, y, z, hap))
    return rows


def plain_rows() -> list[tuple[str, int, float, float, float]]:
    """Every bead of the haploid model, in genomic order."""
    rows = []
    for chrom, count in PLAIN_CHROMS.items():
        for bead in range(count):
            x, y, z = helix(bead, count, 0.7, 12.0, 0.0)
            rows.append((chrom, bead * PLAIN_RESOLUTION, x, y, z))
    return rows


def format_row(row: tuple) -> str:
    """The row as the text format spells it: tab-separated, 4 decimals on the coordinates."""
    chrom, start, x, y, z, *rest = row
    fields = [chrom, str(start), f"{x:.4f}", f"{y:.4f}", f"{z:.4f}", *rest]
    return "\t".join(fields)


def write_text(path: Path, rows: list[tuple]) -> None:
    """The text and its gzipped twin, byte-for-byte reproducible."""
    text = "".join(format_row(row) + "\n" for row in rows)
    path.write_text(text)
    with open(path.with_suffix(path.suffix + ".gz"), "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            gz.write(text.encode())
    log.info("wrote %s (%d rows)", path.name, len(rows))


def run(args: list[str]) -> str:
    """Run a g3dtools command and return its stdout, failing loudly."""
    log.info("$ %s", " ".join(args))
    done = subprocess.run(args, check=True, capture_output=True, text=True)
    return done.stdout


def load(text_gz: Path, out_stem: Path, resolution: int, scales: tuple[int, ...], name: str) -> Path:
    """``g3dtools load`` over the gzipped text, returning the ``.g3d`` it wrote."""
    args = [
        "g3dtools",
        "load",
        str(text_gz),
        "-o",
        str(out_stem),
        "-r",
        str(resolution),
        "-n",
        name,
        "-g",
        "toy",
    ]
    if scales:
        args += ["-s", ",".join(str(s) for s in scales)]
    run(args)
    return out_stem.with_suffix(".g3d")


def query(g3d: Path, resolution: int) -> list[tuple[str, int, float, float, float, str]]:
    """Every row ``g3dtools query -G`` prints at one resolution."""
    out = run(["g3dtools", "query", str(g3d), "-r", str(resolution), "-G"])
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        chrom, start, x, y, z, cat = line.split("\t")
        rows.append((chrom, int(start), float(x), float(y), float(z), cat))
    return rows


def meta(g3d: Path) -> dict:
    """``g3dtools meta``, which prints the header minus its offsets as JSON."""
    return json.loads(run(["g3dtools", "meta", str(g3d)]))


def check(g3d: Path, written: list[tuple], resolution: int, resolutions: list[int], categories: list[str],
          haplotype_words: dict[str, str] | None) -> dict:
    """Hold the file to what g3dtools says about it, and record what query reports per resolution."""
    header = meta(g3d)
    assert header["version"] == 2, header
    assert header["resolutions"] == resolutions, header
    assert header["categories"] == categories, header

    expected = {}
    for row in written:
        chrom, start, x, y, z, *rest = row
        cat = haplotype_words[rest[0]] if haplotype_words else "shared"
        expected[(chrom, start, cat)] = (x, y, z)
    got = query(g3d, resolution)
    assert len(got) == len(expected), (len(got), len(expected))
    for chrom, start, x, y, z, cat in got:
        ex, ey, ez = expected[(chrom, start, cat)]
        assert abs(x - ex) < 1e-9 and abs(y - ey) < 1e-9 and abs(z - ez) < 1e-9, (chrom, start, cat)

    counts: dict[str, dict[str, dict[str, int]]] = {}
    for reso in resolutions:
        per: dict[str, dict[str, int]] = {}
        for chrom, _start, _x, _y, _z, cat in query(g3d, reso):
            per.setdefault(cat, {})
            per[cat][chrom] = per[cat].get(chrom, 0) + 1
        counts[str(reso)] = per
    return {
        "file": g3d.name,
        "genome": header["genome"],
        "name": header["name"],
        "resolutions": resolutions,
        "categories": categories,
        "beads": counts,
        "bytes": g3d.stat().st_size,
    }


#: The value the decoder is held to. Chosen so every MessagePack form Python's
#: packer emits for ordinary data appears at least once: both fixints, every
#: unsigned and signed width up to 64 bits, float64, fixstr/str8/str16/str32,
#: bin8, fixarray/array16, fixmap/map16, integer keys, nil and both booleans.
MSGPACK_VALUE = {
    "nil": None,
    "bools": [True, False],
    "ints": [
        0, 1, 127,
        128, 255,
        256, 65535,
        65536, 4294967295,
        4294967296, 2 ** 53 - 1,
        -1, -32,
        -33, -128,
        -129, -32768,
        -32769, -2147483648,
        -2147483649, -(2 ** 53 - 1),
    ],
    "float": math.pi,
    "floats": [0.0, -0.5, 1e-300, 1e300],
    "str": "héllo wörld — 🧬",
    "str8": "s" * 40,
    "str16": "m" * 300,
    "str32": "l" * 70000,
    "bin": base64.b64encode(b"\x00\x01\x02\xff").decode(),
    "nested": {"a": [1, [2, [3, []]]], "b": {}},
    "intkeys": {1: "one", -2: "minus two", 300: "three hundred", 70000: "seventy thousand"},
    "wide": {f"k{i}": i for i in range(20)},
    "empty": [],
}

#: The one float packed as float32, which the packer only does on request.
MSGPACK_SINGLE = 1.5


def write_msgpack_cases(out: Path) -> None:
    import msgpack

    value = json.loads(json.dumps(MSGPACK_VALUE))  # a deep copy with string keys …
    value["intkeys"] = dict(MSGPACK_VALUE["intkeys"])  # … except where the keys are ints
    value["bin"] = base64.b64decode(MSGPACK_VALUE["bin"])
    packed = msgpack.packb(value, use_bin_type=True) + msgpack.packb(MSGPACK_SINGLE, use_single_float=True)
    (out / "msgpack.bin").write_bytes(packed)
    (out / "msgpack.json").write_text(
        json.dumps({"value": MSGPACK_VALUE, "second": MSGPACK_SINGLE, "first_end": len(packed) - 5}, indent=1)
        + "\n"
    )
    log.info("wrote msgpack.bin (%d bytes) and msgpack.json", len(packed))


def build(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    if shutil.which("g3dtools") is None:
        log.error("g3dtools is not on PATH; `pip install g3dtools` and rerun")
        sys.exit(2)

    toy = toy_rows()
    random.Random(TOY_SEED).shuffle(toy)
    toy_text = out / "toy.g3d.txt"
    write_text(toy_text, toy)
    toy_g3d = load(toy_text.with_suffix(".txt.gz"), out / "toy", TOY_RESOLUTION, TOY_SCALES, "toy")
    toy_resolutions = [TOY_RESOLUTION] + [TOY_RESOLUTION * s for s in TOY_SCALES]
    toy_manifest = check(
        toy_g3d, toy, TOY_RESOLUTION, toy_resolutions, list(TOY_HAPLOTYPES.values()), TOY_HAPLOTYPES,
    )

    plain = plain_rows()
    plain_text = out / "plain.g3d.txt"
    write_text(plain_text, plain)
    plain_g3d = load(plain_text.with_suffix(".txt.gz"), out / "plain", PLAIN_RESOLUTION, (), "plain")
    plain_manifest = check(plain_g3d, plain, PLAIN_RESOLUTION, [PLAIN_RESOLUTION], ["shared"], None)

    write_msgpack_cases(out)

    manifest = {
        "g3dtools": run(["g3dtools", "--version"]).strip(),
        "toy": toy_manifest,
        "plain": plain_manifest,
    }
    (out / "g3d-manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output directory (default: {DEFAULT_OUT})")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")
    manifest = build(args.out)
    for key in ("toy", "plain"):
        entry = manifest[key]
        log.info(
            "%s: %s, resolutions %s, categories %s",
            entry["file"], f"{entry['bytes']:,} bytes", entry["resolutions"], entry["categories"],
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
