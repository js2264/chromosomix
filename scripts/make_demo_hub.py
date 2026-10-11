#!/usr/bin/env python
"""Build the demo track hub, and the files the UCSC readers need to be tried on.

``python3 scripts/make_demo_hub.py`` — no arguments, no network, idempotent.

Why this exists
---------------

SPECS §24.10 reads UCSC track hubs and §8.18–§8.21 read five of UCSC's formats,
and every one of those was written against a fixture this repository wrote
itself. That is the right way to pin a *rule* and the wrong way to find out
whether a real file opens, so this script turns the yeast demo into a hub the
viewer can be pointed at with `npm run dev`:

    http://localhost:5173/demo/yeast/hub.txt

Same origin, so no CORS question stands between a reader and the answer — which
matters because CORS, and not the parser, is what usually stops a browser-only
viewer reading somebody's hub.

What it writes, and what each one is for
----------------------------------------

``Yeast_reference.2bit``
    The demo genome packed at two bits a base (§8.21), which is what makes the
    hub an **assembly hub**: `twoBitPath` is the only way a hub carries its own
    sequence. Written here because kent's `faToTwoBit` is not a dependency this
    project is going to take on, and validated with :func:`check_two_bit` —
    see the note there about what that validation is and is not worth.

``Yeast_microC_loops.longrange``
    The demo's loop calls in WashU/UCSC `longrange` (§8.18), a valid hub track
    type — and written **both ways round**, as the format's own convention
    requires and as a `tabix` index would need, so that the reader's folding of
    reciprocal lines is exercised by a real file rather than only by a fixture.

``Yeast_microC_loops.interact``
    The same calls as UCSC `interact` (§8.18), for dropping on the map. *Not* a
    hub track: UCSC's remote-data types are the `big*` ones plus `bam`, `cram`,
    `vcfTabix`, `hic` and `longTabix`, so a hub naming a plain `.interact`
    is one UCSC itself would refuse, and a demo hub that did so would be
    teaching the wrong thing.

``Yeast_annotations.genePred``
    The demo's GTF as a UCSC `genePredExt` table (§8.19) — the same transcripts,
    the same exons, spelled the other way — for dropping on the browser. Not a
    hub track either, and for the same reason.

Nothing here invents data. The two interaction files are a re-spelling of
`Yeast_microC_loops.tsv`, the gene models are a re-spelling of the GTF, and the
one derived number is documented at :func:`significance`.
"""

from __future__ import annotations

import math
import struct
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterator

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent / "demo" / "yeast"

FASTA = DEMO / "S288c_syn40-XIII.fa"
TWOBIT = DEMO / "Yeast_reference.2bit"
LOOPS = DEMO / "Yeast_microC_loops.tsv"
LONGRANGE = DEMO / "Yeast_microC_loops.longrange"
INTERACT = DEMO / "Yeast_microC_loops.interact"
GTF = DEMO / "Yeast_annotations.gtf"
GENEPRED = DEMO / "Yeast_annotations.genePred"

#: The assembly the demo files are on, as the hub names it.
ASSEMBLY = "sacCer3_syn40"


# ---------------------------------------------------------------------------
# FASTA in, .2bit out
# ---------------------------------------------------------------------------

#: `T C A G` are `0 1 2 3`; everything else is written as `T` and recorded as a
#: gap, which is what kent's own writer does. A two-bit alphabet has no room for
#: an `N`, so the N blocks are where that information lives — and are the reason
#: a reader must paint them back over the unpacked bases rather than trusting
#: the bits, which under a centromere are a convincing run of thymine.
_CODES = bytearray(256)
for _letter, _code in (("T", 0), ("C", 1), ("A", 2), ("G", 3)):
    _CODES[ord(_letter)] = _code
    _CODES[ord(_letter.lower())] = _code
CODES = bytes(_CODES)


def read_fasta(path: Path) -> list[tuple[str, bytes]]:
    """Every record as ``(name, residues)``, in file order, exactly as written.

    The case is kept, because it is what the mask blocks are computed from: a
    soft-masked assembly records its repeats that way and a reader that
    uppercased here would write a file claiming there are none.
    """
    out: list[tuple[str, bytes]] = []
    name: str | None = None
    parts: list[bytes] = []
    with path.open("rb") as handle:
        for raw in handle:
            line = raw.rstrip(b"\r\n")
            if line.startswith(b">"):
                if name is not None:
                    out.append((name, b"".join(parts)))
                # The name is the first word of the header, which is what every
                # tool that indexes a FASTA takes it to be.
                name = line[1:].split()[0].decode("ascii") if len(line) > 1 else ""
                parts = []
                continue
            parts.append(line)
    if name is not None:
        out.append((name, b"".join(parts)))
    return out


def runs(residues: bytes, wanted) -> list[tuple[int, int]]:
    """Half-open spans of consecutive bases for which ``wanted(byte)`` is true."""
    out: list[tuple[int, int]] = []
    start = -1
    for at, byte in enumerate(residues):
        if wanted(byte):
            if start < 0:
                start = at
        elif start >= 0:
            out.append((start, at))
            start = -1
    if start >= 0:
        out.append((start, len(residues)))
    return out


def is_gap(byte: int) -> bool:
    """Anything outside the two-bit alphabet: `N`, and the IUPAC ambiguities."""
    return CODES[byte] == 0 and byte not in (ord("T"), ord("t"))


def is_masked(byte: int) -> bool:
    return 0x61 <= byte <= 0x7A


def pack(residues: bytes) -> bytes:
    """Four bases a byte, two bits each, most significant pair first."""
    codes = residues.translate(CODES)
    pad = (-len(codes)) % 4
    if pad:
        codes = codes + bytes(pad)
    return bytes(
        (codes[i] << 6) | (codes[i + 1] << 4) | (codes[i + 2] << 2) | codes[i + 3]
        for i in range(0, len(codes), 4)
    )


def record_bytes(residues: bytes) -> bytes:
    """One sequence record: its size, its two block lists, and its packed DNA."""
    gaps = runs(residues, is_gap)
    masks = runs(residues, is_masked)
    out = bytearray()
    out += struct.pack("<I", len(residues))
    out += struct.pack("<I", len(gaps))
    out += b"".join(struct.pack("<I", start) for start, _ in gaps)
    out += b"".join(struct.pack("<I", end - start) for start, end in gaps)
    out += struct.pack("<I", len(masks))
    out += b"".join(struct.pack("<I", start) for start, _ in masks)
    out += b"".join(struct.pack("<I", end - start) for start, end in masks)
    out += struct.pack("<I", 0)  # reserved
    out += pack(residues)
    return bytes(out)


def write_two_bit(sequences: list[tuple[str, bytes]], path: Path) -> None:
    """A version-0, little-endian `.2bit`.

    Two passes, because the index holds each record's file offset and an index
    row is a length-prefixed name — so the index's own size is not known until
    every name has been seen, and no offset can be written before it is.
    """
    bodies = [record_bytes(residues) for _, residues in sequences]
    names = [name.encode("ascii") for name, _ in sequences]
    index_bytes = sum(1 + len(name) + 4 for name in names)

    header = struct.pack("<IIII", 0x1A412743, 0, len(sequences), 0)
    index = bytearray()
    at = len(header) + index_bytes
    for name, body in zip(names, bodies):
        index += bytes([len(name)]) + name + struct.pack("<I", at)
        at += len(body)
    path.write_bytes(header + bytes(index) + b"".join(bodies))


def check_two_bit(sequences: list[tuple[str, bytes]], path: Path) -> str:
    """Read the file back with kent's own code, and compare every base.

    **What this is worth.** `py2bit` is a thin wrapper around the C in kent's
    tree — the same code UCSC's browser reads a `.2bit` with — so a file this
    script wrote that `py2bit` reads correctly is a file UCSC would read
    correctly. That is an *independent* check of the writer above, which a
    round-trip through this repository's own TypeScript reader would not be:
    two implementations sharing one misunderstanding of the format agree
    perfectly with each other and with nothing else.

    Absent `py2bit` the check is skipped rather than faked, and says so.
    """
    try:
        import py2bit  # type: ignore
    except ImportError:
        return "py2bit is not installed, so the file was not read back — `pip install py2bit`"

    handle = py2bit.open(str(path))
    try:
        got = handle.chroms()
        for name, residues in sequences:
            if got.get(name) != len(residues):
                return f"{name}: kent reads {got.get(name)} bases, the FASTA has {len(residues)}"
            # Upper-cased on both sides: this FASTA carries no soft-masking, and
            # what is being checked here is the residues rather than the case.
            read = handle.sequence(name).upper()
            if read != residues.decode("ascii").upper():
                where = next(
                    (i for i, (a, b) in enumerate(zip(read, residues.decode())) if a != b.upper()),
                    -1,
                )
                return f"{name}: differs from the FASTA at base {where}"
        return f"read back with kent's own reader: {len(got)} sequences, every base identical"
    finally:
        handle.close()


# ---------------------------------------------------------------------------
# Loop calls in, two interaction formats out
# ---------------------------------------------------------------------------


def loops() -> Iterator[dict[str, str]]:
    """The demo's loop calls, by column name."""
    with LOOPS.open() as handle:
        header = handle.readline().rstrip("\n").split("\t")
        for line in handle:
            row = line.rstrip("\n").split("\t")
            if len(row) < len(header):
                continue
            yield dict(zip(header, row))


#: Where `-log10(q)` is capped. A q-value of exactly zero is a floating-point
#: floor rather than a claim of infinite significance, and `inf` is not a number
#: any of these formats can carry.
MAX_SIGNIFICANCE = 30.0


def significance(qvalue: str) -> float:
    """`-log10(q)`, capped — the one number here that is not read straight off.

    Both formats want a *value*, and a q-value is backwards for one: smaller is
    stronger, so a lane drawn on it would draw the weakest loops darkest. The
    standard transform is the negative log, and it is named here rather than
    applied quietly so that anybody reading the generated file can undo it.
    """
    try:
        q = float(qvalue)
    except ValueError:
        return 0.0
    if q <= 0:
        return MAX_SIGNIFICANCE
    return min(MAX_SIGNIFICANCE, -math.log10(q))


def write_interactions() -> tuple[int, int]:
    """The loop calls as `interact` and as `longrange`. Returns both counts."""
    interact_rows: list[str] = []
    longrange_rows: list[str] = []
    for at, row in enumerate(loops(), start=1):
        c1, c2 = row["chrom1"], row["chrom2"]
        s1, e1 = int(row["start1"]), int(row["end1"])
        s2, e2 = int(row["start2"]), int(row["end2"])
        value = significance(row.get("qvalue", ""))
        # The 0–1000 display score UCSC scales its greys from. Kept distinct
        # from `value` on purpose: §8.18 reads the second and not the first.
        score = max(0, min(1000, round(value / MAX_SIGNIFICANCE * 1000)))

        # BED5+13. `chromStart`/`chromEnd` bound the whole interaction, which
        # for a cis call is the span from the first anchor to the last.
        interact_rows.append(
            "\t".join(
                str(part)
                for part in (
                    c1,
                    min(s1, s2),
                    max(e1, e2),
                    f"loop{at}",
                    score,
                    f"{value:.6f}",
                    "microC",
                    "0",
                    c1,
                    s1,
                    e1,
                    f"anchor{at}a",
                    ".",
                    c2,
                    s2,
                    e2,
                    f"anchor{at}b",
                    ".",
                )
            )
        )

        # …and both ends of each, because that is what the format is for: a
        # `tabix` query returns rows whose first three columns overlap, so an
        # interaction recorded only under its left end is invisible to anybody
        # asking about its right (§8.18).
        longrange_rows.append(f"{c1}\t{s1}\t{e1}\t{c2}:{s2}-{e2},{value:.6f}")
        longrange_rows.append(f"{c2}\t{s2}\t{e2}\t{c1}:{s1}-{e1},{value:.6f}")

    INTERACT.write_text("\n".join(interact_rows) + "\n")
    # Sorted, as `tabix` requires and as anybody indexing this file next would
    # have to do anyway.
    longrange_rows.sort(key=lambda line: (line.split("\t")[0], int(line.split("\t")[1])))
    LONGRANGE.write_text("\n".join(longrange_rows) + "\n")
    return len(interact_rows), len(longrange_rows)


# ---------------------------------------------------------------------------
# GTF in, genePredExt out
# ---------------------------------------------------------------------------


def attribute(field: str, key: str) -> str:
    """One GTF attribute, or `''`. The `key "value";` spelling, which is GTF's."""
    marker = f'{key} "'
    at = field.find(marker)
    if at < 0:
        return ""
    at += len(marker)
    end = field.find('"', at)
    return field[at:end] if end > at else ""


def write_genepred() -> int:
    """The GTF's transcripts as a `genePredExt` table.

    The same objects, spelled the other way: one line a transcript with its
    exons as two parallel lists of **absolute** coordinates, where the GTF
    spreads them over a line each and joins them by an attribute. `name2` keeps
    the gene symbol, which is what `refFlat` puts in front instead and what
    §8.19 reads either of them out of.
    """
    exons: dict[str, list[tuple[int, int]]] = defaultdict(list)
    cds: dict[str, list[tuple[int, int]]] = defaultdict(list)
    where: dict[str, tuple[str, str]] = {}
    symbol: dict[str, str] = {}

    with GTF.open() as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            row = line.rstrip("\n").split("\t")
            if len(row) < 9:
                continue
            kind = row[2]
            # The stop codon is coding: the Sequence Ontology's CDS ends with it
            # and UCSC's own genePred tables count it in `cdsEnd`, but a GTF
            # writes it on a row of its own outside the last CDS row. Leaving it
            # out drew every gene three bases short of its stop (SPECS §8.16).
            if kind not in ("exon", "CDS", "stop_codon"):
                continue
            name = attribute(row[8], "transcript_id")
            if name == "":
                continue
            # GTF is 1-based and inclusive at both ends; genePred is 0-based and
            # half-open, exactly as BED is. One subtraction, in one place.
            span = (int(row[3]) - 1, int(row[4]))
            (exons if kind == "exon" else cds)[name].append(span)
            where[name] = (row[0], row[6])
            found = attribute(row[8], "gene_name") or attribute(row[8], "gene_id")
            if found != "":
                symbol.setdefault(name, found)

    rows: list[str] = []
    for name in sorted(exons):
        blocks = sorted(exons[name])
        contig, strand = where[name]
        tx_start, tx_end = blocks[0][0], max(end for _, end in blocks)
        coding = sorted(cds.get(name, []))
        # A transcript with no CDS writes an empty span at its end, which is the
        # convention every genePred writer follows for a non-coding gene.
        cds_start = coding[0][0] if coding else tx_end
        cds_end = max(end for _, end in coding) if coding else tx_end
        rows.append(
            "\t".join(
                (
                    name,
                    contig,
                    strand if strand in ("+", "-") else "+",
                    str(tx_start),
                    str(tx_end),
                    str(cds_start),
                    str(cds_end),
                    str(len(blocks)),
                    ",".join(str(start) for start, _ in blocks) + ",",
                    ",".join(str(end) for _, end in blocks) + ",",
                    "0",
                    symbol.get(name, name),
                    "cmpl" if coding else "none",
                    "cmpl" if coding else "none",
                    ",".join("0" for _ in blocks) + ",",
                )
            )
        )
    GENEPRED.write_text("\n".join(rows) + "\n")
    return len(rows)


# ---------------------------------------------------------------------------
# The hub itself
# ---------------------------------------------------------------------------

#: The six bigWigs, as one composite — which is what a hub is normally used for
#: and what exercises the container stanzas §24.10 has to tell from file ones.
SIGNAL_TRACKS = [
    ("mnase", "MNase", "Yeast_MNase.bw", "Nucleosome occupancy"),
    ("atac", "ATAC", "Yeast_ATAC.bw", "ATAC-seq accessibility"),
    ("pol2", "Pol II", "Yeast_ChIP_Pol2-vs-input.bw", "Pol II ChIP over input"),
    ("rnafwd", "RNA +", "Yeast_RNA_fwd.bw", "RNA-seq, forward strand"),
    ("rnarev", "RNA −", "Yeast_RNA_rev.bw", "RNA-seq, reverse strand"),
    ("shotgun", "Shotgun", "Yeast_Shotgun.bw", "Shotgun sequencing coverage"),
]


def write_hub() -> None:
    """`hub.txt`, `genomes.txt` and `trackDb.txt`, as UCSC would accept them.

    **Strictly valid**, which constrains what can be in it: a hub's tracks are
    the `big*` formats plus `bam`, `cram`, `vcfTabix`, `hic` and `longTabix`, so
    the demo's `.narrowPeak`, `.bed`, `.gtf` and `.barChart` cannot appear here
    without a `bedToBigBed` this project does not ship. A hub naming them anyway
    would open in this viewer and fail in UCSC's, which is the one thing a
    *demo* hub must not teach.
    """
    (DEMO / "hub.txt").write_text(
        "\n".join(
            (
                "hub chromosomixDemo",
                "shortLabel chromosomix demo",
                "longLabel The yeast demo data, as a UCSC assembly hub",
                "genomesFile genomes.txt",
                "email noreply@example.org",
                "",
            )
        )
    )

    (DEMO / "genomes.txt").write_text(
        "\n".join(
            (
                f"genome {ASSEMBLY}",
                "trackDb trackDb.txt",
                f"twoBitPath {TWOBIT.name}",
                "organism Saccharomyces cerevisiae",
                "description S288c with a synthetic chromosome XIII",
                "defaultPos IV:1-200000",
                "",
            )
        )
    )

    lines = [
        "track signal",
        "compositeTrack on",
        "shortLabel Signal",
        "longLabel Every signal track published with the yeast demo",
        "type bigWig",
        "visibility full",
        "",
    ]
    for name, short, file, long in SIGNAL_TRACKS:
        lines += [
            f"    track {name}",
            "    parent signal on",
            f"    shortLabel {short}",
            f"    longLabel {long}",
            f"    bigDataUrl {file}",
            "    type bigWig",
            "",
        ]
    lines += [
        "track loops",
        "shortLabel Micro-C loops",
        "longLabel Loop calls, as longrange — both ends of each, as the format asks",
        f"bigDataUrl {LONGRANGE.name}",
        "type longTabix",
        "",
        "track contacts",
        "shortLabel Micro-C map",
        "longLabel The demo contact map, which opens through the map door",
        "bigDataUrl Yeast_hic.hic",
        "type hic",
        "",
    ]
    (DEMO / "trackDb.txt").write_text("\n".join(lines))


def main() -> int:
    if not FASTA.exists():
        print(f"no {FASTA} — this script writes the demo hub beside the demo data", file=sys.stderr)
        return 1

    sequences = read_fasta(FASTA)
    write_two_bit(sequences, TWOBIT)
    bases = sum(len(residues) for _, residues in sequences)
    print(
        f"{TWOBIT.name}: {len(sequences)} sequences, {bases:,} bases, "
        f"{TWOBIT.stat().st_size:,} bytes (the FASTA is {FASTA.stat().st_size:,})"
    )
    print(f"  {check_two_bit(sequences, TWOBIT)}")

    interactions, longrange_lines = write_interactions()
    print(f"{INTERACT.name}: {interactions:,} interactions")
    print(f"{LONGRANGE.name}: {longrange_lines:,} lines, both ends of each interaction")

    transcripts = write_genepred()
    print(f"{GENEPRED.name}: {transcripts:,} transcripts")

    write_hub()
    print("hub.txt, genomes.txt, trackDb.txt: an assembly hub over the demo data")
    print("\nTry it with `npm run dev`, then paste into the *A track hub* tile:")
    print("  http://localhost:5173/demo/yeast/hub.txt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
