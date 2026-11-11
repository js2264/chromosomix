#!/usr/bin/env python
"""Build the oracles the restriction digest and its pair statistics are held to.

Run with the interpreter ``fixtures:pairstats`` uses — pairtools 1.1.2 under
Python 3.12 or older — with bioframe and Biopython beside it, which
``bioframe.digest`` needs::

    uv pip install -p .venv-pairtools bioframe==0.8.0 biopython==1.88
    METACOOLER_PYTHON=.venv-pairtools/bin/python npm run fixtures:restriction

Writes three files under ``test/golden/restriction/``, all committed, which
``test/unit/restriction-golden.test.ts`` holds ``src/genome/restriction.ts`` to:

``digest.json.gz``
    ``bioframe.digest`` of the repository's yeast reference,
    ``demo/yeast/S288c_syn40-XIII.fa``, for every preset of the enzyme table
    and for two typed sites: ``G^GWCC``, degenerate, against Biopython's AvaII, and
    ``C^ACGAG``, which is not a palindrome, against BssSI — whose bottom strand
    is cut symmetrically (``C^ACGA_G``), as the app takes a typed site's to be,
    so Biopython's top-strand cut for a reverse match is the one the app makes.
    Each sequence's boundaries are written as the gaps between them, from ``0``
    to its length. A kit is not written: bioframe digests one enzyme at a
    time, and the Arima kit's boundaries are DpnII's and HinfI's merged, which
    the test makes from the two written here. Beside them, the site and cut
    Biopython has for each preset and alias, so the table is checked against it
    rather than typed from a catalogue.

``restrict.tsv.gz``
    ``pairtools restrict`` over ``test/golden/pairs_stats/sample.pairs.gz`` with
    the DpnII fragments, run twice — on the top-strand fragments and on the
    bottom-strand ones — and each end's six columns taken from the run of the
    strand it was read on. One row per record of the fixture in its order,
    the 300 on ``mito`` left out (below), with ``rfrag1 back1 ahead1 rfrag2
    back2 ahead2``: the fragment, and its 1-based ``rfrag_start`` and
    ``rfrag_end`` as distances from the end's ``pos`` — ``back = pos -
    rfrag_start`` and ``ahead = rfrag_end - pos`` — which are a few hundred
    where the coordinates are a million, and are the same numbers.

``stats.json``
    The restriction statistics of that file, computed here from restrict's
    columns by the definitions the app implements — classes, by orientation,
    the distance to the next cut by strand, the ends per fragment — so the
    app's counter is held to an independent computation of the same rules.

bioframe is two bases late
--------------------------
Biopython's ``search`` returns the 1-based first base after the cut, and
``bioframe.digest`` adds one more on its way to a 0-based start
(``np.r_[0, np.array(cut_finder(seq)) + 1, len(seq)]``; cooler's ``digest`` is
the same code). So for EcoRI's ``GAATTC`` at 0-based ``s`` — top strand cut
after the ``G``, at ``s + 1`` — Biopython says ``s + 2`` and bioframe ``s + 3``.
The app's cut is ``s + cut``, the 0-based first base after it, so bioframe's
boundaries are the app's plus two at every site, and the test holds them to
exactly that. ``pairtools restrict`` is therefore given bioframe's BED shifted
back by two (the first fragment still starting at ``0``), so the fragments it
assigns are the true ones and the ones the app assigns.

Two strands
-----------
A ``-`` read's 5′ end is on the bottom strand, which DpnII cuts four bases
after the top (``^GATC``: top at ``s``, bottom at ``s + 4``, in top-strand
coordinates). The app places a ``+`` end by the top-strand boundaries and a
``-`` end by the bottom-strand ones, fragment ``i`` being one fragment in both.
So restrict is run on the top-strand BED for the ``+`` ends and on the
bottom-strand BED — every interior boundary four bases later — for the ``-``
ends, and the statistics below read each end's columns from its own run.

pairtools restrict and a sequence it was not given
---------------------------------------------------
``find_rfrag`` looks a record's chromosome up in the fragment table and catches
``ValueError`` for one it lacks — but the lookup raises ``KeyError``, so
restrict stops at the first such record. The fixture has 300 records on
``mito``, which the yeast reference has not got (``make_pairstats_golden.py``
puts them there on purpose). They are left out of what restrict is given, and
counted here as the definitions count them: unassigned when mapped and not
duplicates.

restrict's convention, checked here
-----------------------------------
restrict keeps ``R = [0] + (end + 1)`` per chromosome from the BED and assigns
``pos`` (1-based) to ``min(max(0, searchsorted(R, pos, 'right') - 1), n - 1)``.
That is ``searchsorted(B, pos - 1, 'right') - 1``, clamped to the sequence's
fragments, for ``B = [0, …cuts, N]``; and its columns are 1-based,
``rfrag_start = B[i] + 1`` (``0`` for the first fragment) and
``rfrag_end = B[i + 1] + 1``. The script asserts both, on both runs, before
it writes the pairs goldens.
"""

from __future__ import annotations

import gzip
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import bioframe
import numpy as np
import pandas as pd
from Bio import Restriction
from pairtools.lib.stats import PairCounter

ROOT = Path(__file__).resolve().parent.parent
FASTA = ROOT / "demo" / "yeast" / "S288c_syn40-XIII.fa"
PAIRS = ROOT / "test" / "golden" / "pairs_stats" / "sample.pairs.gz"
OUT = ROOT / "test" / "golden" / "restriction"

# The enzyme table of `src/genome/restriction.ts`, by Biopython's names: its
# presets, then the aliases it resolves.
PRESETS = ["DpnII", "HindIII", "NcoI", "EcoRI", "BglII", "HinfI", "DdeI", "MseI", "NlaIII", "CviQI", "AluI"]
ALIASES = {"MboI": "DpnII", "Sau3AI": "DpnII", "Csp6I": "CviQI"}
KITS = {"Arima": ["DpnII", "HinfI"]}
# A typed site, and the enzyme Biopython knows it as.
TYPED = {"G^GWCC": "AvaII", "C^ACGAG": "BssSI"}

ORIENTATIONS = ["++", "+-", "-+", "--"]
CLASSES = ["valid", "re-ligation", "dangling", "self-circle", "same-strand", "trans"]


def load_fasta(path: Path) -> dict[str, str]:
    """The reference as ``bioframe.digest`` takes it, a dict of sequences.

    Read here rather than with ``bioframe.load_fasta``, whose pysam backend
    writes a ``.fai`` beside the FASTA in ``demo/``. ``digest`` reads a record
    as ``str(record[:])``, which a plain string answers as well.
    """
    records: dict[str, list[str]] = {}
    name = None
    with open(path) as f:
        for line in f:
            line = line.rstrip("\r\n")
            if line.startswith(">"):
                name = line[1:].split()[0]
                records[name] = []
            elif line and name is not None:
                records[name].append(line)
    return {name: "".join(parts) for name, parts in records.items()}


def boundaries(frags: pd.DataFrame, names: list[str]) -> dict[str, np.ndarray]:
    """Each sequence's boundaries, ``[0, …, length]``, from a fragment table."""
    out = {}
    for name in names:
        rows = frags[frags["chrom"] == name]
        out[name] = np.r_[rows["start"].to_numpy(), rows["end"].to_numpy()[-1:]].astype(np.int64)
    return out


def gaps(bounds: np.ndarray) -> str:
    return ",".join(str(int(v)) for v in np.diff(bounds))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    records = load_fasta(FASTA)
    names = list(records.keys())
    lengths = {name: len(records[name]) for name in names}

    # The table, as Biopython has it: the site and the bases before the top
    # strand's cut. A palindrome all, which is what lets one cut stand for a site.
    table = {}
    for name in PRESETS + list(ALIASES):
        enzyme = getattr(Restriction, name)
        assert enzyme.is_palindromic(), name
        table[name] = {"site": str(enzyme.site), "cut": int(enzyme.fst5)}

    digests: dict[str, dict[str, np.ndarray]] = {}
    for name in PRESETS:
        digests[name] = boundaries(bioframe.digest(records, name), names)
    for site, enzyme in TYPED.items():
        digests[site] = boundaries(bioframe.digest(records, enzyme), names)
    for alias, preset in ALIASES.items():
        alias_bounds = boundaries(bioframe.digest(records, alias), names)
        assert all(np.array_equal(alias_bounds[n], digests[preset][n]) for n in names), alias

    digest = {
        "reference": str(FASTA.relative_to(ROOT)),
        "lengths": lengths,
        "table": table,
        "typed": TYPED,
        "kits": KITS,
        "boundaries": {key: {n: gaps(b) for n, b in value.items()} for key, value in digests.items()},
    }
    with open(OUT / "digest.json.gz", "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        gz.write(json.dumps(digest, separators=(",", ":")).encode())

    # The true DpnII fragments: bioframe's, two bases earlier at every cut on
    # the top strand, and those four bases later again on the bottom.
    dpnii = getattr(Restriction, "DpnII")
    shift = len(dpnii.site) - 2 * int(dpnii.fst5)
    top_bounds, bottom_bounds = {}, {}
    for name in names:
        b = digests["DpnII"][name].copy()
        b[1:-1] -= 2
        top_bounds[name] = b
        bottom = b.copy()
        bottom[1:-1] = np.minimum(bottom[1:-1] + shift, lengths[name])
        bottom_bounds[name] = bottom

    pairs = pd.read_csv(PAIRS, sep="\t", comment="#", header=None,
                        names=["readID", "chrom1", "pos1", "chrom2", "pos2", "strand1", "strand2", "pair_type"],
                        dtype={"chrom1": str, "chrom2": str})
    known = set(names) | {"!"}
    given = pairs[pairs["chrom1"].isin(known) & pairs["chrom2"].isin(known)].reset_index(drop=True)
    columns = ["rfrag1", "rfrag_start1", "rfrag_end1", "rfrag2", "rfrag_start2", "rfrag_end2"]
    runs = {}
    with tempfile.TemporaryDirectory() as scratch:
        header = [line for line in gzip.open(PAIRS, "rt") if line.startswith("#")]
        source = Path(scratch) / "known.pairs"
        with open(source, "w") as f:
            f.writelines(header)
            given.to_csv(f, sep="\t", header=False, index=False)
        pairtools = str(Path(sys.executable).with_name("pairtools"))
        for strand, bounds in (("+", top_bounds), ("-", bottom_bounds)):
            bed = Path(scratch) / "fragments.bed"
            with open(bed, "w") as f:
                for name in names:
                    b = bounds[name]
                    for i in range(len(b) - 1):
                        f.write(f"{name}\t{b[i]}\t{b[i + 1]}\n")
            restricted = Path(scratch) / "restricted.pairs"
            subprocess.run([pairtools, "restrict", "-f", str(bed), str(source), "-o", str(restricted)], check=True)
            run = pd.read_csv(restricted, sep="\t", comment="#", header=None,
                              names=list(pairs.columns) + columns, dtype={"chrom1": str, "chrom2": str})
            assert len(run) == len(given)
            assert (run["readID"].to_numpy() == given["readID"].to_numpy()).all()
            check_convention(run, names, bounds)
            runs[strand] = run

    # Each end's columns from the run of the strand it was read on.
    out = given.copy()
    for side in "12":
        minus = (given[f"strand{side}"] == "-").to_numpy()
        for column in ("rfrag", "rfrag_start", "rfrag_end"):
            key = f"{column}{side}"
            out[key] = np.where(minus, runs["-"][key].to_numpy(), runs["+"][key].to_numpy())

    compact = pd.DataFrame({
        f"{name}{side}": values
        for side in "12"
        for name, values in (
            ("rfrag", out[f"rfrag{side}"]),
            ("back", out[f"pos{side}"] - out[f"rfrag_start{side}"]),
            ("ahead", out[f"rfrag_end{side}"] - out[f"pos{side}"]),
        )
    })
    with open(OUT / "restrict.tsv.gz", "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        gz.write(compact.to_csv(sep="\t", index=False).encode())

    stats = statistics(pairs, out, names, top_bounds)
    (OUT / "stats.json").write_text(json.dumps(stats, indent=1) + "\n")
    print(f"wrote {OUT / 'digest.json.gz'}, {OUT / 'restrict.tsv.gz'} and {OUT / 'stats.json'}")
    return 0


def check_convention(run: pd.DataFrame, names: list[str], bounds: dict[str, np.ndarray]) -> None:
    """restrict's assignment and columns, as the docstring states them, before anything is built on them."""
    for side in "12":
        mapped = run[f"chrom{side}"] != "!"
        for name in names:
            rows = run[mapped & (run[f"chrom{side}"] == name)]
            b = bounds[name]
            x = rows[f"pos{side}"].to_numpy() - 1
            frag = np.clip(np.searchsorted(b, x, "right") - 1, 0, len(b) - 2)
            assert np.array_equal(frag, rows[f"rfrag{side}"].to_numpy()), (name, side)
            assert np.array_equal(np.where(frag == 0, 0, b[frag] + 1), rows[f"rfrag_start{side}"].to_numpy())
            assert np.array_equal(b[frag + 1] + 1, rows[f"rfrag_end{side}"].to_numpy())


def statistics(pairs: pd.DataFrame, out: pd.DataFrame, names: list[str], bounds: dict[str, np.ndarray]) -> dict:
    """The restriction statistics by the shared definitions, from restrict's columns."""
    duplicate = pairs["pair_type"] == "DD"
    mapped = (
        (pairs["chrom1"] != "!") & (pairs["chrom2"] != "!")
        & pairs["strand1"].isin(["+", "-"]) & pairs["strand2"].isin(["+", "-"])
    )
    in_reference = pairs["chrom1"].isin(names) & pairs["chrom2"].isin(names)
    unassigned = int((mapped & ~duplicate & ~in_reference).sum())

    keep = (
        (out["chrom1"] != "!") & (out["chrom2"] != "!")
        & out["strand1"].isin(["+", "-"]) & out["strand2"].isin(["+", "-"])
        & (out["pair_type"] != "DD")
    )
    rows = out[keep]
    x1 = rows["pos1"].to_numpy() - 1
    x2 = rows["pos2"].to_numpy() - 1
    f1 = rows["rfrag1"].to_numpy()
    f2 = rows["rfrag2"].to_numpy()
    s1 = rows["strand1"].to_numpy()
    s2 = rows["strand2"].to_numpy()
    cis = (rows["chrom1"] == rows["chrom2"]).to_numpy()

    # Order the ends of a cis pair by position, the file's order on a tie.
    swap = cis & (x2 < x1)
    fa, fb = np.where(swap, f2, f1), np.where(swap, f1, f2)
    sa, sb = np.where(swap, s2, s1), np.where(swap, s1, s2)
    same = fa == fb
    klass = np.full(len(rows), "valid", dtype=object)
    klass[same & (sa == "+") & (sb == "-")] = "dangling"
    klass[same & (sa == "-") & (sb == "+")] = "self-circle"
    klass[same & (sa == sb)] = "same-strand"
    klass[~same & (np.abs(fb - fa) == 1) & (sa == "+") & (sb == "-")] = "re-ligation"
    klass[~cis] = "trans"
    # A trans pair's orientation is its ends' strands in the file's order.
    orientation = np.char.add(np.where(cis, sa, s1).astype(str), np.where(cis, sb, s2).astype(str))

    classes = {name: int((klass == name).sum()) for name in CLASSES}
    by_orientation = {
        name: {o: int(((klass == name) & (orientation == o)).sum()) for o in ORIENTATIONS} for name in CLASSES
    }

    # The distance to the next cut, in the direction the read reads, from
    # restrict's 1-based columns of the end's own strand: s = max(rfrag_start - 1, 0),
    # e = rfrag_end - 1, so a + end gives B[i+1] - x and a - end x - B'[i] + 1.
    edges = np.asarray(PairCounter()._dist_bins)
    distance = {"+": np.zeros(len(edges), dtype=np.int64), "-": np.zeros(len(edges), dtype=np.int64)}
    for side in "12":
        x = rows[f"pos{side}"].to_numpy() - 1
        s = np.maximum(rows[f"rfrag_start{side}"].to_numpy() - 1, 0)
        e = rows[f"rfrag_end{side}"].to_numpy() - 1
        strand = rows[f"strand{side}"].to_numpy()
        d = np.where(strand == "+", e - x, x - s + 1)
        assert (d >= 1).all()
        at = np.searchsorted(edges, d, "right") - 1
        for which in "+-":
            np.add.at(distance[which], at[strand == which], 1)

    # Ends per fragment, over every fragment of the reference.
    first = {}
    total = 0
    for name in names:
        first[name] = total
        total += len(bounds[name]) - 1
    ends = np.zeros(total, dtype=np.int64)
    for side in "12":
        offset = rows[f"chrom{side}"].map(first).to_numpy()
        np.add.at(ends, offset + rows[f"rfrag{side}"].to_numpy(), 1)
    bins = np.where(ends == 0, 0, np.ceil(np.log2(np.maximum(ends, 1))).astype(int) + 1)
    counts = np.bincount(bins)
    labels = []
    for b in range(len(counts)):
        labels.append(str(b) if b <= 2 else f"{2 ** (b - 2) + 1}–{2 ** (b - 1)}")

    return {
        "enzymes": "DpnII",
        "counted": int(len(rows)),
        "unassigned": unassigned,
        "classes": classes,
        "byOrientation": by_orientation,
        "distanceEdges": [int(v) for v in edges],
        "distance": {k: [int(v) for v in d] for k, d in distance.items()},
        "fragments": {
            "total": int(total),
            "seen": int((ends > 0).sum()),
            "binLabels": labels,
            "counts": [int(v) for v in counts],
        },
    }


if __name__ == "__main__":
    sys.exit(main())
