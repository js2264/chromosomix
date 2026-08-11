#!/usr/bin/env python
"""Build the metacooler-viewer test fixtures.

Run with the interpreter that has metacooler installed::

    /pasteur/helix/users/jaseriza/repos/metacooler/.venv/bin/python \
        scripts/make_fixtures.py --force

Every ``.metacool`` / ``.mmetacool`` here is produced by the public
``metacooler`` CLI, and every ``.cool`` / ``.mcool`` by the public ``cooler``
CLI or API.  Nothing writes HDF5 by hand.  That constraint is the point: a
fixture the viewer is tested against must be a file a user could actually
produce, so a fixture that cannot be built from a documented command is a
signal that the viewer is claiming support it should not claim.

Raw inputs (assemblies, pairs, contig/MAG tables) are reused from the
metacooler test-data directory rather than regenerated — they are already small,
already checked in, and already the shape real MetaTOR output has.  The one
input that does not exist there (a float-count cooler) is synthesised into
``test/fixtures/_inputs/``.

**Nothing here has a non-ASCII name.** ``/contigs`` doubles as cooler's
``/chroms`` and cooler decodes it with an ASCII ``.astype("U")``, so metacooler
refuses to write such a file at all — ``check_ascii_names`` on the way in and
``schema.validate`` on the way out.  A fixture that cannot be built from a
documented command is a signal that the viewer is claiming support it should not
claim, and this was that signal: the two UTF-8 fixtures had to be generated
around the writer, and one of them carried a partial oracle because the
reference implementation could not open it.

The script is idempotent: every output is unlinked first and every CLI call
passes ``--force`` where the command supports it.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "test" / "fixtures"
DEFAULT_DATA = Path("/pasteur/helix/users/jaseriza/repos/metacooler/tests/data")

log = logging.getLogger("make_fixtures")


# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------


def _tool(name: str) -> list[str]:
    """Return the argv prefix for a console script from the running venv.

    Resolved next to ``sys.executable`` rather than through ``PATH`` so the
    script always drives the same metacooler it imports, even when a different
    one is first on the path.
    """
    candidate = Path(sys.executable).with_name(name)
    if candidate.exists():
        return [str(candidate)]
    found = shutil.which(name)
    if found:
        return [found]
    raise SystemExit(f"cannot find the {name!r} executable next to {sys.executable}")


def run(argv: list[str], *, quiet: bool = True) -> None:
    """Run a subprocess, echoing the command and failing loudly."""
    log.info("$ %s", " ".join(argv))
    proc = subprocess.run(argv, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit(f"command failed ({proc.returncode}): {' '.join(argv)}")
    if not quiet:
        sys.stderr.write(proc.stderr)


def fresh(path: Path) -> Path:
    """Remove *path* if it exists, so every run starts from nothing."""
    if path.exists():
        path.unlink()
    return path


# ---------------------------------------------------------------------------
# Derived input tables
# ---------------------------------------------------------------------------


def write_minimal_contigs(src: Path, dst: Path) -> None:
    """Project a metacooler contig table down to just name + genome.

    `basic.metacool` must have *no* optional columns, so that
    `metadata.metacool` is the only fixture that exercises the
    "render whatever extra columns exist" path (spec §5.1).
    """
    with src.open(newline="", encoding="utf-8") as fh, dst.open(
        "w", newline="", encoding="utf-8"
    ) as out:
        reader = csv.reader(fh, delimiter="\t")
        header = next(reader)
        i_contig = header.index("contig_name")
        i_genome = header.index("genome_name")
        out.write("contig_name\tgenome_name\n")
        for row in reader:
            out.write(f"{row[i_contig]}\t{row[i_genome]}\n")


def write_rich_genomes(src: Path, dst: Path) -> None:
    """Extend the MAG table with the columns a real binning pipeline emits.

    `taxonomy` in particular is a long string column, which is what makes the
    `S<n>` width of `/genomes/name` differ from the width of the metadata
    columns beside it.
    """
    lineages = [
        "d__Bacteria;p__Firmicutes;c__Clostridia;o__Eubacteriales;f__Lachnospiraceae",
        "d__Bacteria;p__Bacteroidota;c__Bacteroidia;o__Bacteroidales;f__Bacteroidaceae",
        "d__Bacteria;p__Pseudomonadota;c__Gammaproteobacteria;o__Enterobacterales",
    ]
    with src.open(newline="", encoding="utf-8") as fh, dst.open(
        "w", newline="", encoding="utf-8"
    ) as out:
        reader = csv.reader(fh, delimiter="\t")
        header = next(reader)
        out.write("\t".join([*header, "taxonomy", "checkm_quality", "n_markers"]) + "\n")
        for i, row in enumerate(reader):
            tax = lineages[i % len(lineages)]
            # completeness - 5 * contamination, the CheckM quality score.
            comp = float(row[header.index("completeness")]) * 100
            cont = float(row[header.index("contamination")]) * 100
            out.write(
                "\t".join([*row, tax, f"{comp - 5 * cont:.1f}", str(40 + 3 * i)]) + "\n"
            )


def write_float_cool(source_cool: Path, dst: Path) -> None:
    """Copy a cooler, turning its integer counts into genuinely fractional ones.

    ``+ 0.5`` rather than ``* 1.0``: a float column whose values all happen to be
    integers would let a reader that rounds pass, and correction #2 exists
    precisely because ``resolve_count_dtype`` refuses to truncate.
    """
    import cooler
    import numpy as np

    clr = cooler.Cooler(str(source_cool))
    bins = clr.bins()[:][["chrom", "start", "end"]]
    pixels = clr.pixels()[:]
    pixels["count"] = pixels["count"].astype(np.float64) + 0.5
    cooler.create_cooler(
        str(dst),
        bins=bins,
        pixels=pixels,
        dtypes={"count": np.float64},
        ordered=True,
        symmetric_upper=True,
        assembly="basic_assembly",
    )


# ---------------------------------------------------------------------------
# Fixture construction
# ---------------------------------------------------------------------------


def build(out: Path, data: Path) -> list[dict]:
    """Build every fixture and return the descriptor list."""
    metacooler = _tool("metacooler")
    cooler_cli = _tool("cooler")

    inputs = out / "_inputs"
    inputs.mkdir(parents=True, exist_ok=True)

    contigs_1 = data / "contigs_table_1.tsv"
    mags_1 = data / "mag_table_1.tsv"
    pairs_rep1 = data / "contacts_1_rep1.pairs.gz"
    pairs_rep2 = data / "contacts_1_rep2.pairs.gz"
    chromsizes_1 = data / "assembly_1.chrom.sizes"
    frags_1 = data / "assembly_1_DpnII-digested.bed"
    for required in (contigs_1, mags_1, pairs_rep1, pairs_rep2, chromsizes_1, frags_1):
        if not required.exists():
            raise SystemExit(f"missing metacooler test input: {required}")

    basic_contigs = inputs / "basic_contigs.tsv"
    write_minimal_contigs(contigs_1, basic_contigs)
    rich_genomes = inputs / "rich_mag_table.tsv"
    write_rich_genomes(mags_1, rich_genomes)

    def create_pairs(output: Path, *extra: str, contigs: Path, pairs: Path) -> None:
        run(
            [
                *metacooler,
                "create",
                "pairs",
                "--force",
                "--quiet",
                "--contigs",
                str(contigs),
                "--pairs",
                str(pairs),
                "--output",
                str(fresh(output)),
                *extra,
            ]
        )

    descriptors: list[dict] = []

    def note(name: str, kind: str, expect: str, description: str, **extra) -> None:
        path = out / name
        descriptors.append(
            {
                "name": name,
                "kind": kind,
                "expect": expect,
                "description": description,
                "bytes": path.stat().st_size,
                **extra,
            }
        )

    # -- basic ---------------------------------------------------------------
    # 44 contigs / 11 genomes (10 MAGs + __unbinned__ with 5 real contigs),
    # 1 kb fixed bins, genome-then-length. The reference accepted file.
    create_pairs(
        out / "basic.metacool",
        "--bins",
        "1000",
        "--assembly-name",
        "basic_assembly",
        "--contig-order",
        "genome-then-length",
        contigs=basic_contigs,
        pairs=pairs_rep1,
    )
    note(
        "basic.metacool",
        "metacool",
        "accept",
        "fixed 1 kb bins, genome-then-length, 10 MAGs + __unbinned__ with real contigs",
    )

    # -- metadata ------------------------------------------------------------
    # Same assembly, but every optional column populated: /contigs keeps
    # gc_content + coverage verbatim, /genomes gains phylum, completeness,
    # contamination, quality, taxonomy, checkm_quality, n_markers.
    create_pairs(
        out / "metadata.metacool",
        "--bins",
        "1000",
        "--assembly-name",
        "basic_assembly",
        "--genomes",
        str(rich_genomes),
        "--metadata",
        str(data / "metadata.yaml"),
        contigs=contigs_1,
        pairs=pairs_rep1,
    )
    note(
        "metadata.metacool",
        "metacool",
        "accept",
        "basic plus /genomes metadata columns (taxonomy, completeness, …) and /contigs extras",
    )

    # -- dropped -------------------------------------------------------------
    # drop_unassigned: no __unbinned__ row at all, so genome index 0 is MAG_01.
    # This is correction #4 — matching __unbinned__ by index would hide a MAG.
    create_pairs(
        out / "dropped.metacool",
        "--bins",
        "1000",
        "--assembly-name",
        "basic_assembly",
        "--drop-unassigned",
        contigs=basic_contigs,
        pairs=pairs_rep1,
    )
    note(
        "dropped.metacool",
        "metacool",
        "accept",
        "created with --drop-unassigned: no __unbinned__ row, genome 0 is a real MAG",
    )

    # -- int64 ---------------------------------------------------------------
    # binnify sums counts, so it writes pixels/count as int64 (the BigInt path).
    run(
        [
            *metacooler,
            "binnify",
            str(out / "basic.metacool"),
            "--output",
            str(fresh(out / "int64.metacool")),
            "--binsize",
            "2000",
            "--force",
            "--quiet",
        ]
    )
    note(
        "int64.metacool",
        "metacool",
        "accept",
        "product of `metacooler binnify`: pixels/count is int64, bins are 2 kb",
    )

    # -- floatcount ----------------------------------------------------------
    float_cool = inputs / "float_source.cool"
    fresh(float_cool)
    write_float_cool(out / "basic.metacool", float_cool)
    run(
        [
            *metacooler,
            "create",
            "cool",
            "--force",
            "--quiet",
            "--cool",
            str(float_cool),
            "--contigs",
            str(basic_contigs),
            "--output",
            str(fresh(out / "floatcount.metacool")),
        ]
    )
    note(
        "floatcount.metacool",
        "metacool",
        "accept",
        "float64 pixels/count preserved by resolve_count_dtype (correction #2)",
    )

    # -- ladder --------------------------------------------------------------
    run(
        [
            *metacooler,
            "zoomify",
            str(out / "basic.metacool"),
            "--output",
            str(fresh(out / "ladder.mmetacool")),
            "--resolutions",
            "1000,2000,4000",
            "--force",
            "--quiet",
        ]
    )
    note(
        "ladder.mmetacool",
        "mmetacool",
        "refuse:mmetacool-root",
        "zoomify output: integer entry names drive the zoom control",
        entries=["1000", "2000", "4000"],
        entry_expect="accept",
        entry_style="ladder",
    )

    # -- samples -------------------------------------------------------------
    rep2 = inputs / "rep2.metacool"
    create_pairs(
        rep2,
        "--bins",
        "1000",
        "--assembly-name",
        "basic_assembly",
        contigs=basic_contigs,
        pairs=pairs_rep2,
    )
    run(
        [
            *metacooler,
            "stack",
            str(out / "basic.metacool"),
            str(rep2),
            "--output",
            str(fresh(out / "samples.mmetacool")),
            "--names",
            "rep1,rep2",
            "--force",
            "--quiet",
        ]
    )
    note(
        "samples.mmetacool",
        "mmetacool",
        "refuse:mmetacool-root",
        "stack output: non-integer entry names, so an entry picker rather than a ladder",
        entries=["rep1", "rep2"],
        entry_expect="accept",
        entry_style="samples",
    )

    # -- fasta_order (refused) ----------------------------------------------
    create_pairs(
        out / "fasta_order.metacool",
        "--bins",
        "1000",
        "--assembly-name",
        "basic_assembly",
        "--contig-order",
        "fasta",
        contigs=basic_contigs,
        pairs=pairs_rep1,
    )
    note(
        "fasta_order.metacool",
        "metacool",
        "refuse:bad-ordering",
        "contig-ordering=fasta: genomes are not contiguous in bin space",
    )

    # -- variable (refused) --------------------------------------------------
    # Fragment-level bins. metacooler stores bin-size as the *string* "null"
    # here, which is correction #3: Number("null") is NaN and "null" is truthy.
    create_pairs(
        out / "variable.metacool",
        "--bins",
        str(frags_1),
        "--assembly-name",
        "basic_assembly",
        contigs=basic_contigs,
        pairs=pairs_rep1,
    )
    note(
        "variable.metacool",
        "metacool",
        "refuse:variable-bins",
        "DpnII fragment bins: bin-type='variable', bin-size stored as the string 'null'",
    )

    # -- plain cool / mcool --------------------------------------------------
    run(
        [
            *cooler_cli,
            "cload",
            "pairs",
            "-c1",
            "2",
            "-p1",
            "3",
            "-c2",
            "4",
            "-p2",
            "5",
            f"{chromsizes_1}:1000",
            str(pairs_rep1),
            str(fresh(out / "plain.cool")),
        ]
    )
    note(
        "plain.cool",
        "cool",
        "accept",
        "non-metagenomic cooler; genome level is synthesised (spec §9)",
    )

    run(
        [
            *cooler_cli,
            "zoomify",
            "--balance",
            "-r",
            "1000,2000,5000",
            "-o",
            str(fresh(out / "plain.mcool")),
            str(out / "plain.cool"),
        ]
    )
    note(
        "plain.mcool",
        "mcool",
        # The *root* of an mcool is a collection, not a cooler, and is refused
        # by name so the app can open a resolution; each entry accepts.
        "refuse:mcool-root",
        "multi-resolution cooler with a /bins/weight column (spec §6.4, §9)",
        entries=["1000", "2000", "5000"],
        entry_expect="accept",
        entry_style="ladder",
    )

    return descriptors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Accepted for symmetry with the CLI; every output is unlinked anyway.",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
        stream=sys.stderr,
    )
    # Keep the metacooler CLI's own logging out of the way; every call is
    # already checked for a non-zero exit.
    os.environ.setdefault("PYTHONWARNINGS", "ignore")

    args.out.mkdir(parents=True, exist_ok=True)
    descriptors = build(args.out, args.data)

    import cooler

    import metacooler

    manifest = {
        "generator": "scripts/make_fixtures.py",
        "metacooler_version": metacooler.__version__,
        "cooler_version": cooler.__version__,
        "fixtures": descriptors,
    }
    target = args.out / "_fixtures.json"
    target.write_text(
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    total = sum(d["bytes"] for d in descriptors)
    log.info("")
    for d in descriptors:
        log.info("  %-26s %9d B  %s", d["name"], d["bytes"], d["expect"])
    log.info("  %-26s %9d B  total", "", total)
    log.info("wrote %s", target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
