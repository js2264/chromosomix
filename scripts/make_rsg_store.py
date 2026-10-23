#!/usr/bin/env python3
"""The RSG lab's data store: the files its cards are made of, and the workspaces that open them.

    python3 scripts/make_rsg_store.py derive --work DIR    # the files the store computes (needs pysam)
    python3 scripts/make_rsg_store.py derive --work DIR --steps gm12878
                                                           # only GM12878's (needs cooler, h5py, requests)
    python3 scripts/make_rsg_store.py workspaces           # demo/store/**/*.chromosomix.json and MANIFEST.tsv
    python3 scripts/make_rsg_store.py stage --out DIR --local URL
                                                           # the same workspaces, pointed at where each
                                                           # file is today, for a look before publishing

The store is a folder on the lab's bucket, `s3://rsglab-data/demo/store/`, one directory a card or a
dataset, and every workspace in it names its files relatively, as every published workspace does
(`ui/examples.ts`). `demo/store/MANIFEST.tsv` is the list of what is in that folder and where each
file comes from — a copy inside the bucket, a copy from 4DN's open-data bucket, a file of this
repository, or a file `derive` wrote — and `scripts/publish-store.sh` is what makes the bucket match
it. The test that checks the store (`test/unit/demo-examples.test.ts`) reads the same file: a name a
workspace uses must be in it.

Nothing here invents data. `derive` reshapes six files, calls loops on one map and compartments on
three (it needs pysam, numpy and `hictkpy[pyarrow]`, and `npm run build:cli` for the loops and E1),
fetches UCSC's hg38 and computes GM12878's tracks:

- ``Yeast_RNAseq.barChart`` — the counts table in `demo/store/yeastRNAseq_counts.txt`, as counts
  per million per sample, one chart per gene at the gene's coordinates in `S288c.gtf` (§8.17).
- ``Yeast_snps.vcf.gz`` and its ``.tbi`` — `Yeast_snps.vcf`, bgzipped and indexed, so a reader
  fetches one chromosome of its 162,311 records rather than 108 MB (§8.11).
- ``mm10_genes.gtf.gz`` and its ``.tbi`` — iGenomes' UCSC mm10 `genes.gtf`, sorted, bgzipped and
  indexed, for the paper card's map of a 2.7-Gb genome.
- ``PAO1_v3_*_8000.e1-arms.bw`` — E1 along both arms of the three *P. aeruginosa* maps of the paper's
  Fig. S3c, by `chromosomix compartments` as the DNA Bacterial Zoo runs it.
- ``Yeast_microC_loops.bedpe`` — loops called on the micro-C map the card opens, with this app's
  own Chromosight port (`chromosomix chromosight`), replacing the calls the old demo carried,
  which were made on a map with a synthetic chromosome XIII.
- ``S288c.2bit`` — `S288c.fa` at two bits a base, and ``GSE151553_A364_merged.hic`` — the micro-C
  map's counts as a Juicer .hic: the two files the paste box's hub example names (`exampleHubText`),
  which an assembly hub can only name in these formats.
- ``hg38.2bit`` and ``hg38.refGene.txt.gz`` — UCSC's, as UCSC publishes them (`--steps ucsc`).
- What the paper's GM12878 panels draw (`--steps gm12878`, `write_gm12878`): insulation at four scales
  and CTCF peaks over the genome (Fig. 2), and insulation, compartments, a 4C profile, a model and
  CTCF's motif at Fig. 1a's window, all by the chromosomix command. 4DN's map is 27 GB and is never
  fetched whole: each task reads one rung of it, of one sequence or near the diagonal, fetched by range
  (`notebooks/scripts/cool_subset.py`). About a quarter of an hour on four cores, reading about 6 GB of
  the map by range and 0.7 GB of ENCODE's files.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "demo" / "store"
BUCKET = "https://rsglab-data.s3.eu-west-3.amazonaws.com/"
FOURDN = "https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/"
IGENOMES = "https://ngi-igenomes.s3.amazonaws.com/igenomes/Mus_musculus/UCSC/mm10/"
ENCODE = "https://encode-public.s3.amazonaws.com/"
UCSC_HG38 = "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/"

# GM12878, the paper's Figs. 1a and 2. The map is 4DN's in situ Hi-C of Rao et al. 2014, every
# replicate merged (4DNES3JX38V5): 4,010,478,943 contacts, 1 kb to 10 Mb, hg38's sequences.
GM, GM_UUID = "4DNFIXP4QG5B", "d6abea45-b0bb-4154-9854-1d3075b98097"
#: ENCODE's GM12878 files the paper reads, GRCh38: accession → (key under encode-public, MD5, what).
#: The two CTCF tracks are two labs' experiments, each its replicates pooled, which the app's peak
#: caller reads as two replicates; RNA-seq is one replicate's two strands.
GM_ENCODE = {
    "ENCFF734CUT": ("2020/10/01/a42c46dc-c33f-4906-8469-ba93e2cf30d3/ENCFF734CUT.bigWig",
                    "b68aeffbebeae3d03e734b51f43c0cb8",
                    "CTCF ChIP-seq, fold change over control, Bernstein lab, Broad (ENCODE ENCSR000AKB)"),
    "ENCFF485CGE": ("2020/09/25/ee64f56a-89ba-4f40-84f8-733a1994ea35/ENCFF485CGE.bigWig",
                    "ba43f52311258b2491d795504f6cfacc",
                    "CTCF ChIP-seq, fold change over control, Snyder lab, Stanford (ENCODE ENCSR000DZN)"),
    "ENCFF156URE": ("2020/10/01/bc71c9d1-2a24-421e-9a32-f78eaf297764/ENCFF156URE.bigBed",
                    "f999218d47dc27475c51d54869f3070f", "CTCF peaks, conservative IDR thresholded (ENCODE ENCSR000AKB)"),
    "ENCFF487LOB": ("2021/02/24/4c49a77a-edb2-4766-8328-d44ebe7446eb/ENCFF487LOB.bigWig",
                    "f95a4eeec1156e2e1dc392ab988ae28a", "ATAC-seq, fold change over control (ENCODE ENCSR095QNB)"),
    "ENCFF928SQL": ("2021/02/24/534b1381-d8a8-4ce3-b6c2-5745076db38b/ENCFF928SQL.bigBed",
                    "fcb25eef5ad745dd542994054a6f3cee", "ATAC-seq peaks, replicated (ENCODE ENCSR095QNB)"),
    "ENCFF990PUN": ("2021/04/06/b69b32c0-0298-484c-b218-37f22ebb0309/ENCFF990PUN.bigWig",
                    "24fc37e5048a519d74e31dbb90c94714",
                    "Total RNA-seq, plus strand, Gingeras lab, CSHL (ENCODE ENCSR000AEC)"),
    "ENCFF005BFP": ("2021/04/06/7bb368f1-3e6b-4b91-86a5-45ce68da0d94/ENCFF005BFP.bigWig",
                    "ec4c60a9be0dd8fc42621447b557e566", "Total RNA-seq, minus strand (ENCODE ENCSR000AEC)"),
}
#: What the app computes on them (`write_gm12878`), under the store's `chromosomix_paper/human/`.
GM_PEAKS, GM_PAIRS = "GM12878_CTCF.peaks.bed", "GM12878_CTCF.consecutive.bedpe"
#: Fig. 1a's window, the 4C anchor in it, and what is computed over them.
FIG1A_REGION, FIG1A_ANCHOR = "chr14:88,550,001-90,100,000", "chr14:89,150,001-89,180,000"
FIG1A_MODEL = f"{GM}_2000.chr14-88.55-90.10Mb.bed3d"
#: The TAD in Fig. 1a's window and its four sub-TADs, by the borders insulation calls on chr14 at 2 kb
#: (100-kb window), each written at the middle of its 2-kb bin: 89,021,000 | 89,165,000 | 89,431,000 |
#: 89,769,000 | 89,919,000.
FIG1A_TAD = (89_021_000, 89_919_000)
FIG1A_SUBTAD_BORDER = 89_165_000
#: The model's pinned bead: the middle bead of the central sub-TAD, 89.431–89.769 Mb, which holds the
#: TAD's own middle. The model is coloured by each bead's spatial distance to it.
FIG1A_PIN = "chr14:89601000"
#: The marks Fig. 1a draws on the map (§8.1), in the palette marks are drawn in: the TAD as a box, its
#: borders as green lines and the sub-TAD border by the 4C anchor as a black one.
FIG1A_MARKS = [
    {"id": "m-tad", "kind": "rect", "a": {"contig": "chr14", "from": FIG1A_TAD[0], "to": FIG1A_TAD[1]},
     "b": {"contig": "chr14", "from": FIG1A_TAD[0], "to": FIG1A_TAD[1]}, "colour": "#111318"},
    *[{"id": f"m-border-{k}", "kind": "line", "axis": "vertical", "at": {"contig": "chr14", "bp": bp},
       "colour": "#0f8a5f"} for k, bp in enumerate(FIG1A_TAD, 1)],
    {"id": "m-subtad", "kind": "line", "axis": "vertical", "at": {"contig": "chr14", "bp": FIG1A_SUBTAD_BORDER},
     "colour": "#111318"},
]
FIG1A_4C = f"{GM}_5000.4c-chr14-89150001-89180000.bw"
#: CTCF's core motif in IUPAC, read with one mismatch: about the density of the bound sites.
CTCF_MOTIF, CTCF_MOTIFS = "RCCASYAGRKGGCRS", "hg38.CTCF-motifs.bed"
HG38_AUTOSOMES_X = ",".join([*(f"chr{n}" for n in range(1, 23)), "chrX"])
HG38_PRIMARY = HG38_AUTOSOMES_X + ",chrY"

YEAST_ORDER = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
               "XI", "XII", "XIII", "XIV", "XV", "XVI", "Mito"]


# ---------------------------------------------------------------------------
# derive
# ---------------------------------------------------------------------------

def fetch(url: str, to: Path) -> Path:
    """Download once; the work directory is a cache."""
    if to.exists() and to.stat().st_size > 0:
        return to
    to.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-sS", "--fail", "-L", "-o", str(to), url], check=True)
    return to


GENE_ID = re.compile(r'gene_id "([^"]+)"')
GENE_NAME = re.compile(r'gene_name "([^"]+)"')


def write_barchart(counts: Path, gtf: Path, out: Path) -> str:
    """One chart per gene: the four samples' counts per million, at the gene's coordinates."""
    genes: dict[str, tuple[str, int, int, str, str]] = {}
    with gtf.open() as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            col = line.rstrip("\n").split("\t")
            if len(col) < 9 or col[2] != "gene":
                continue
            gid = GENE_ID.search(col[8]).group(1)
            name = GENE_NAME.search(col[8])
            genes[gid] = (col[0], int(col[3]) - 1, int(col[4]), col[6], name.group(1) if name else gid)

    rows = [line.rstrip("\n").split(";") for line in counts.open()]
    header = [h.strip('"') for h in rows[0][1:]]
    table = {r[0].strip('"'): [int(v) for v in r[1:]] for r in rows[1:]}
    # Wild type before mutant, each replicate beside its pair: the order a reader compares them in.
    order = sorted(range(len(header)), key=lambda i: (not header[i].startswith("wt"), header[i]))
    names = [header[i] for i in order]
    totals = [sum(v[i] for v in table.values()) for i in range(len(header))]

    kept = []
    for gid, values in table.items():
        if gid not in genes:
            continue
        chrom, start, end, strand, name = genes[gid]
        cpm = [values[i] / totals[i] * 1e6 for i in order]
        kept.append((YEAST_ORDER.index(chrom), start, chrom, end, gid, strand, name, cpm))
    kept.sort()
    dropped = len(table) - len(kept)

    colours = {"wt": ["#56789a", "#9ab4cc"], "mut": ["#d55e00", "#f0a35e"]}
    palette = []
    for n in names:
        group = "wt" if n.startswith("wt") else "mut"
        palette.append(colours[group][sum(1 for m in palette if m in colours[group])])
    with out.open("w") as fh:
        fh.write("# RNA-seq read counts per gene (yeastRNAseq_counts.txt), as counts per million in each\n")
        fh.write("# sample, at the gene's coordinates in Ensembl R64-1-1 (S288c.gtf).\n")
        fh.write(f"# {len(kept):,} genes; {dropped} counted genes have no row in the GTF and are left out.\n")
        fh.write(f'track type=barChart name="RNA-seq, wild type and mutant" barChartBars="{" ".join(names)}" '
                 f'barChartColors="{" ".join(palette)}" barChartLabel=Samples barChartMetric=CPM barChartUnit=CPM\n')
        for _, start, chrom, end, gid, strand, name, cpm in kept:
            fh.write(f"{chrom}\t{start}\t{end}\t{gid}\t0\t{strand}\t{name}\t{len(cpm)}\t"
                     + ",".join(f"{v:.2f}" for v in cpm) + "\n")
    return f"{out.name}: {len(kept):,} genes, {dropped} without coordinates, samples {names}"


def bgzip_and_index(src: Path, out: Path, preset: str, sort_key=None) -> str:
    """bgzip (sorted if asked) and index with tabix, through pysam — htslib's own code."""
    import pysam  # noqa: PLC0415 — only `derive` needs it

    plain = src
    if sort_key is not None:
        plain = out.with_suffix("")  # the sorted text, beside the output
        lines = src.read_text().splitlines(keepends=True)
        head = [l for l in lines if l.startswith("#")]
        body = sorted((l for l in lines if not l.startswith("#") and l.strip()), key=sort_key)
        plain.write_text("".join(head + body))
    pysam.tabix_compress(str(plain), str(out), force=True)
    pysam.tabix_index(str(out), preset=preset, force=True)
    if plain is not src:
        plain.unlink()
    return f"{out.name}: {out.stat().st_size:,} bytes, index {Path(str(out) + '.tbi').stat().st_size:,} bytes"


def gtf_sort_key(line: str):
    col = line.split("\t", 4)
    return (col[0], int(col[3]))


def call_loops(mcool: Path, resolution: int, out: Path, work: Path) -> str:
    """Loops on the micro-C map, by the app's own Chromosight port, as a BEDPE."""
    cli = ROOT / "dist-cli" / "chromosomix.mjs"
    if not cli.exists():
        raise SystemExit("npm run build:cli first: the loops are called with the chromosomix command")
    dest = work / "loops"
    shutil.rmtree(dest, ignore_errors=True)
    subprocess.run(["node", str(cli), "chromosight", f"{mcool}::resolutions/{resolution}",
                    "--pattern", "loops", "--out", str(dest), "--quiet"], check=True)
    bedpe = next(dest.glob("*patterns.bedpe"))
    lines = [l for l in bedpe.read_text().splitlines() if l and not l.startswith("#")]
    out.write_text(
        f"# Loops called on GSE151553_A364_merged.mcool at {resolution} bp with chromosomix chromosight\n"
        "# (the app's port of Chromosight, default parameters).\n" + "\n".join(lines) + "\n")
    return f"{out.name}: {len(lines):,} loops at {resolution} bp"


def write_twobit(fasta: Path, out: Path) -> str:
    """The FASTA packed at two bits a base, as UCSC's `faToTwoBit` writes it.

    Runs of anything but A, C, G and T are N blocks, lower-case runs are mask blocks, and the
    sequences keep the FASTA's order and names — so the hub that names this file
    (`exampleHubText`) declares the same sixteen chromosomes as the FASTA beside it.
    """
    import numpy as np  # noqa: PLC0415

    names: list[str] = []
    chunks: dict[str, list[bytes]] = {}
    with fasta.open("rb") as fh:
        for line in fh:
            if line.startswith(b">"):
                names.append(line[1:].split()[0].decode())
                chunks[names[-1]] = []
            else:
                chunks[names[-1]].append(line.strip())

    def runs(flags: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        edges = np.diff(np.concatenate(([0], flags.astype(np.int8), [0])))
        starts = np.flatnonzero(edges == 1)
        return starts, np.flatnonzero(edges == -1) - starts

    code = np.zeros(256, dtype=np.uint8)  # T=0 C=1 A=2 G=3; N is packed as T
    for base, value in zip(b"TCAG", range(4)):
        code[base] = code[base + 32] = value
    records = []
    for name in names:
        seq = np.frombuffer(b"".join(chunks[name]), dtype=np.uint8)
        upper = seq & 0xDF
        n_starts, n_sizes = runs(~np.isin(upper, np.frombuffer(b"ACGT", dtype=np.uint8)))
        m_starts, m_sizes = runs(seq >= ord("a"))
        packed = np.concatenate((code[seq], np.zeros(-len(seq) % 4, dtype=np.uint8))).reshape(-1, 4)
        packed = (packed[:, 0] << 6) | (packed[:, 1] << 4) | (packed[:, 2] << 2) | packed[:, 3]
        records.append(b"".join([
            np.array([len(seq), len(n_starts)], "<u4").tobytes(),
            n_starts.astype("<u4").tobytes(), n_sizes.astype("<u4").tobytes(),
            np.array([len(m_starts)], "<u4").tobytes(),
            m_starts.astype("<u4").tobytes(), m_sizes.astype("<u4").tobytes(),
            np.array([0], "<u4").tobytes(), packed.astype(np.uint8).tobytes(),
        ]))
    header = np.array([0x1A412743, 0, len(names), 0], "<u4").tobytes()
    offset = len(header) + sum(1 + len(n.encode()) + 4 for n in names)
    index = b""
    for name, record in zip(names, records):
        index += bytes([len(name.encode())]) + name.encode() + np.array([offset], "<u4").tobytes()
        offset += len(record)
    out.write_bytes(header + index + b"".join(records))
    return f"{out.name}: {len(names)} sequences, {out.stat().st_size:,} bytes"


def write_hic(mcool: Path, resolution: int, out: Path, work: Path) -> str:
    """The micro-C map as a Juicer .hic, its counts read from one rung of the .mcool, through hictkpy.

    Raw counts, as hictk writes them: the hub example names this file to show a `type hic` track
    taking the map door (§24.10), and the balanced map is the .mcool's.
    """
    import hictkpy  # noqa: PLC0415 — only `derive` needs it

    source = hictkpy.File(f"{mcool}::/resolutions/{resolution}")
    ladder = [resolution * 2 ** i for i in range(7)]
    out.unlink(missing_ok=True)
    writer = hictkpy.hic.FileWriter(str(out), source.chromosomes(), ladder, assembly="R64-1-1",
                                    n_threads=4, tmpdir=str(work))
    writer.add_pixels(source.fetch().to_df())
    writer.finalize()
    return f"{out.name}: {', '.join(str(r) for r in ladder)} bp, {out.stat().st_size:,} bytes"


def write_e1_arms(work: Path) -> str:
    """E1 along both arms of each P. aeruginosa map (Fig. S3c), as the zoo computes it (`dbz-store.sh`'s
    compartments-arms): 8 kb, the decay along both arms within 400 kb, three components, E1 the largest
    eigenvalue's, signed by GC content."""
    cli = ROOT / "dist-cli" / "chromosomix.mjs"
    if not cli.exists():
        raise SystemExit("npm run build:cli first: E1 is computed with the chromosomix command")
    out = STORE / PAPER / "P_aeruginosa"
    out.mkdir(parents=True, exist_ok=True)
    fasta = fetch(BUCKET + PAK + "PAO1_v3.fa", work / "PAO1_v3.fa")
    for sample, _ in PAO1_STRAINS:
        mcool = fetch(BUCKET + PAK + f"{sample}.mcool", work / f"{sample}.mcool")
        dest = work / "e1-arms" / sample
        shutil.rmtree(dest, ignore_errors=True)
        subprocess.run(["node", str(cli), "compartments", f"{mcool}::/resolutions/{BACTERIA_RES}",
                        "--circular", PAO1_CHROM, "--origin", f"{PAO1_CHROM}:{PAO1_ORIGIN + 1}",
                        "--sequence", str(fasta), "--phaseSequence", str(fasta),
                        "--ignoreDiags", "2", "--components", "3", "--minR", "0.1", "--saddle=false",
                        "--expected", "arms", "--armWindow", str(ARM_WINDOW), "--method", "cooltools",
                        "--out", str(dest), "--quiet"], check=True)
        shutil.copyfile(next(dest.glob("*compartment-e1.bw")), out / f"{sample}_{BACTERIA_RES}.e1-arms.bw")
    return f"E1 along both arms: {', '.join(sample for sample, _ in PAO1_STRAINS)} at {BACTERIA_RES} bp"


def fetch_checked(url: str, to: Path, md5: str) -> Path:
    """Download once, and refuse a file that is not the one its publisher's MD5 names."""
    import hashlib  # noqa: PLC0415

    fetch(url, to)
    digest = hashlib.md5()
    with to.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 22), b""):
            digest.update(block)
    if digest.hexdigest() != md5:
        raise SystemExit(f"{to} is not {url}: its MD5 is {digest.hexdigest()}, not {md5}. Delete it to fetch it again.")
    return to


def map_subset(work: Path, resolution: int, name: str, *, sequences: str | None = None,
               band: int | None = None) -> Path:
    """One rung of the GM12878 map, cis contacts only, read by range from 4DN's bucket into a .cool
    (`notebooks/scripts/cool_subset.py`): the 27-GB file never comes down whole, and every task run on
    the subset reads contacts within one sequence, which are the file's own, with its own weights."""
    out = work / name
    if out.exists():
        return out
    args = [sys.executable, str(ROOT / "notebooks" / "scripts" / "cool_subset.py"), FOURDN + f"{GM_UUID}/{GM}.mcool",
            str(resolution), str(out)]
    if sequences is not None:
        args += ["--sequences", sequences]
    if band is not None:
        args += ["--band", str(band)]
    subprocess.run(args, check=True)
    return out


def consecutive_pairs(peaks: Path, out: Path) -> int:
    """Every peak with the next one along its sequence, as a BEDPE: the pairs Fig. 2's APA piles up."""
    rows = [line.rstrip("\n").split("\t") for line in peaks.open() if line.strip() and not line.startswith("#")]
    rows.sort(key=lambda r: (r[0], int(r[1]), int(r[2])))
    pairs = [(a, b) for a, b in zip(rows, rows[1:]) if a[0] == b[0]]
    with out.open("w") as fh:
        fh.write(f"# Each CTCF peak of {peaks.name} with the next one along its sequence, {len(pairs):,} pairs: "
                 "chrom1 start1 end1 chrom2 start2 end2 name separation\n")
        for a, b in pairs:
            fh.write("\t".join([*a[:3], *b[:3], f"{a[3]}-{b[3]}", str(int(b[1]) - int(a[1]))]) + "\n")
    return len(pairs)


def write_gm12878(work: Path, sequence: Path | None) -> str:
    """What the app computes on GM12878 for the paper's Figs. 1a and 2, into the store's `human/` folder.

    Fig. 2: diamond insulation at four scales (50, 100, 200 and 400 kb windows at 10 kb) over the whole
    genome, and CTCF peaks called by the app's yapc on two labs' CTCF ChIP-seq (fold change over
    control, ENCSR000AKB and ENCSR000DZN) with IDR between them, and each peak paired with the next one
    along its sequence. Fig. 1a, chr14:88,550,001-90,100,000: insulation at 2 kb (100-kb window) and its
    borders, compartments at 250 kb phased by GC content, the 4C profile from chr14:89,150,001-89,180,000
    over the decay (5 kb, the finest rung whose chromosome-wide square the app will hold), the
    pastis-NB model of the window at 2 kb, and CTCF's core motif over the genome.

    `sequence` is any copy of UCSC's hg38 the app reads by range — the 2bit, or a FASTA with its .fai;
    UCSC's 2bit is fetched when none is given.
    """
    cli = ROOT / "dist-cli" / "chromosomix.mjs"
    if not cli.exists():
        raise SystemExit("npm run build:cli first: GM12878's tracks are computed with the chromosomix command")
    out = STORE / PAPER / "human"
    out.mkdir(parents=True, exist_ok=True)
    gm = work / "gm12878"
    gm.mkdir(parents=True, exist_ok=True)
    files = {acc: fetch_checked(ENCODE + key, work / key.rsplit("/", 1)[-1], md5)
             for acc, (key, md5, _) in GM_ENCODE.items() if acc in ("ENCFF734CUT", "ENCFF485CGE")}
    if sequence is None:
        sequence = fetch(UCSC_HG38 + "bigZips/hg38.2bit", work / "hg38.2bit")

    def run(task: str, *args, dest: str) -> Path:
        folder = gm / dest
        shutil.rmtree(folder, ignore_errors=True)
        subprocess.run(["node", str(cli), task, *[str(a) for a in args], "--out", str(folder), "--quiet"], check=True)
        return folder

    def keep(folder: Path, pattern: str, name: str) -> None:
        shutil.copyfile(next(folder.glob(pattern)), out / name)

    # Fig. 2 — the whole genome at 10 kb, every contact within 2 Mb of the diagonal: the widest diamond,
    # 40 bins a side, reaches 79 bins out.
    near = map_subset(work, 10000, f"{GM}_10000.band2Mb.cool", band=2_000_000)
    folder = run("insulation", near, "--window", 5, "--scales", 4, dest="insulation-10k")
    for window in (5, 10, 20, 40):
        keep(folder, f"*insulation-w{window}.bw", f"{GM}_10000.insulation-w{window}.bw")
    keep(folder, "*insulation-boundaries.bed", f"{GM}_10000.borders.bed")
    folder = run("peaks", "--signal", files["ENCFF734CUT"], "--replicate", files["ENCFF485CGE"], dest="peaks")
    keep(folder, "*.bed", GM_PEAKS)
    pairs = consecutive_pairs(out / GM_PEAKS, out / GM_PAIRS)

    # Fig. 1a — chr14 at 2 kb, and the genome at 100 kb for its compartments.
    chr14 = map_subset(work, 2000, f"{GM}_2000.chr14.cool", sequences="chr14")
    folder = run("insulation", chr14, "--window", 50, dest="insulation-2k")
    keep(folder, "*insulation-w50.bw", f"{GM}_2000.chr14.insulation-w50.bw")
    keep(folder, "*insulation-boundaries.bed", f"{GM}_2000.chr14.borders.bed")
    folder = run("reconstruct3d", chr14, "--method", "nb", "--region", FIG1A_REGION, "--threads", 4, dest="model")
    keep(folder, "*.bed3d", FIG1A_MODEL)
    folder = run("fourc", map_subset(work, 5000, f"{GM}_5000.chr14.cool", sequences="chr14"),
                 "--anchor", FIG1A_ANCHOR, "--normalise", "ps", dest="fourc")
    keep(folder, "*.bw", FIG1A_4C)
    folder = run("compartments", map_subset(work, 250000, f"{GM}_250000.cis.cool"), "--sequences", HG38_AUTOSOMES_X,
                 "--sequence", sequence, "--phaseSequence", sequence, "--saddle=false", dest="compartments")
    keep(folder, "*compartment-e1.bw", f"{GM}_250000.compartments-e1.bw")
    keep(folder, "*compartment-ab.bed", f"{GM}_250000.compartments-ab.bed")
    folder = run("motif", "--sequence", sequence, "--pattern", CTCF_MOTIF, "--mismatches", 1,
                 "--sequences", HG38_PRIMARY, dest="motif")
    keep(folder, "*.bed", CTCF_MOTIFS)
    return f"GM12878: insulation at four scales, {pairs:,} consecutive CTCF peak pairs, and Fig. 1a's tracks and model"


def fetch_ucsc(work: Path) -> str:
    """UCSC's hg38 sequence and RefSeq genes, as UCSC publishes them, for the store to copy."""
    fetch(UCSC_HG38 + "bigZips/hg38.2bit", work / "hg38.2bit")
    fetch(UCSC_HG38 + "database/refGene.txt.gz", work / "hg38.refGene.txt.gz")
    return "hg38.2bit and hg38.refGene.txt.gz, from UCSC"


def derive(work: Path, steps: list[str] | None = None, hg38: Path | None = None) -> None:
    """Every derived file, or only the `steps` named (`gm12878`, `ucsc`, `demo`)."""
    work.mkdir(parents=True, exist_ok=True)
    steps = steps or ["demo", "ucsc", "gm12878"]
    if "ucsc" in steps:
        print(fetch_ucsc(work))
    if "gm12878" in steps:
        print(write_gm12878(work, hg38 if hg38 is not None else (work / "hg38.2bit" if "ucsc" in steps else None)))
    if "demo" in steps:
        derive_demo(work)


def derive_demo(work: Path) -> None:
    yeast = STORE / "yeast"
    yeast.mkdir(parents=True, exist_ok=True)
    src = lambda key: fetch(BUCKET + key, work / key.split("/")[-1])  # noqa: E731
    print(write_barchart(src("demo/store/yeastRNAseq_counts.txt"), src("demo/store/S288c.gtf"),
                         yeast / "Yeast_RNAseq.barChart"))
    print(bgzip_and_index(src("demo/store/Yeast_snps.vcf"), work / "Yeast_snps.vcf.gz", "vcf"))
    genes = fetch(IGENOMES + "Annotation/Genes/genes.gtf", work / "mm10_genes.gtf")
    print(bgzip_and_index(genes, work / "mm10_genes.gtf.gz", "gff", sort_key=gtf_sort_key))
    microc = src("demo/store/GSE151553_A364_merged.mcool")
    print(call_loops(microc, LOOPS_RESOLUTION, yeast / "Yeast_microC_loops.bedpe", work))
    print(write_twobit(src("demo/store/S288c.fa"), work / "S288c.2bit"))
    print(write_hic(microc, LOOPS_RESOLUTION, work / "GSE151553_A364_merged.hic", work))
    print(write_e1_arms(work))


LOOPS_RESOLUTION = 1600


# ---------------------------------------------------------------------------
# where every file of the store comes from
# ---------------------------------------------------------------------------

def s3(key: str) -> str:
    """A copy inside the lab's bucket."""
    return f"s3://rsglab-data/{key}"


def fourdn(uuid: str, name: str) -> str:
    """A copy from 4DN's open-data bucket."""
    return f"s3://4dn-open-data-public/fourfront-webprod/wfoutput/{uuid}/{name}"


def encode(key: str) -> str:
    """A copy from ENCODE's open-data bucket."""
    return f"s3://encode-public/{key}"


def repo(path: str) -> str:
    """A file of this repository."""
    return f"repo:{path}"


def work(name: str) -> str:
    """A file `derive` wrote into its work directory."""
    return f"work:{name}"


MENEU = "public-data/2025_Meneu_et_al/"
CHICKEN = "demo/chicken/"
FIG1 = "manuscript/figure1/results/"
CNECATOR = "dbz/C_necator_N1_VJ_MM260/"
SUBTILIS = "demo/subtilis/"
PAK = "demo/pak/"
#: The paper's folder under demo/store/.
PAPER = "chromosomix_paper/"

#: B. subtilis PY79, a map a condition: (the store's name, the bucket's, the condition as Fig. S3b says it).
SUBTILIS_COURSE = [
    ("WT", "WT^mapped_PY79^FKEBR7", "WT"),
    ("dparAB", "dparAB^mapped_PY79^NT9IOH", "ΔparAB"),
    ("induction_0min", "induction_0min^mapped_PY79^14WJZP", "+parB 0 min"),
    ("induction_15min", "induction_15min^mapped_PY79^3JNIKY", "+parB 15 min"),
    ("induction_20min", "induction_20min^mapped_PY79^4WPQI3", "+parB 20 min"),
    ("induction_30min", "induction_30min^mapped_PY79^YKZ54M", "+parB 30 min"),
    ("induction_35min", "induction_35min^mapped_PY79^FSTYHN", "+parB 35 min"),
    ("induction_45min", "induction_45min^mapped_PY79^LW6QCG", "+parB 45 min"),
]
#: P. aeruginosa, a map a strain: (the lab's sample, the genotype as Fig. S3c says it).
PAO1_STRAINS = [
    ("PAO1_v3_MM38", "WT"),
    ("PAO1_v3_FG0235", "SMC-ScpAB–"),
    ("PAO1_v3_FG0238", "MksBEF–"),
]
#: RNA-seq of PAK at T0 (GEO GSE76513), its replicates pooled, both strands, as counts per million on
#: the maps' reference, so it reads bin for bin against them.
PAK_RNA = "GSE76513_PAK_T0_pooled.unstranded.CPM.bw"

#: (path under demo/store/, source, what it is). The order is the manifest's.
FILES: list[tuple[str, str, str]] = [
    # -- yeast: the three yeast cards share one folder and one copy of each file
    ("yeast/S288c.fa", s3("demo/store/S288c.fa"), "S. cerevisiae S288C, Ensembl R64-1-1"),
    ("yeast/S288c.gtf", s3("demo/store/S288c.gtf"), "Genes, Ensembl R64-1-1"),
    ("yeast/Yeast_ATAC.bw", s3("demo/store/Yeast_ATAC.bw"), "ATAC-seq"),
    ("yeast/Yeast_MNase.bw", s3("demo/store/Yeast_MNase_coverage.bw"), "MNase-seq coverage"),
    ("yeast/Yeast_shotgun.bw", s3("demo/store/Yeast_shotgun.bw"), "Shotgun (input) coverage"),
    ("yeast/Yeast_snps.vcf.gz", work("Yeast_snps.vcf.gz"), "SNPs of 16 samples: wine, ale, lager, bioethanol and other strains, bgzipped"),
    ("yeast/Yeast_snps.vcf.gz.tbi", work("Yeast_snps.vcf.gz.tbi"), "…and its tabix index"),
    ("yeast/yeastRNAseq_counts.txt", s3("demo/store/yeastRNAseq_counts.txt"), "RNA-seq counts per gene"),
    ("yeast/Yeast_RNAseq.barChart", repo("demo/store/yeast/Yeast_RNAseq.barChart"),
     "The counts as CPM, one chart per gene"),
    ("yeast/GSE151553_A364_merged.mcool", s3("demo/store/GSE151553_A364_merged.mcool"),
     "Micro-C, A364A (Costantino et al. 2020, GEO GSE151553)"),
    ("yeast/Yeast_microC_loops.bedpe", repo("demo/store/yeast/Yeast_microC_loops.bedpe"),
     "Loops called on the micro-C map"),
    ("yeast/Yeast_PCP_GSM8476641_G1_rep1.mcool", s3("demo/store/Yeast_PCP_GSM8476641_G1_rep1.mcool"),
     "PCP, G1 (Delamarre et al. 2025, GEO GSM8476641)"),
    ("yeast/S288c.2bit", work("S288c.2bit"), "The S288C sequence at two bits a base, for the hub example"),
    ("yeast/GSE151553_A364_merged.hic", work("GSE151553_A364_merged.hic"),
     "The micro-C map as a .hic (raw counts, 1.6–102.4 kb), for the hub example"),
    # -- human: the Geuvadis chrX subset, from this repository's demo/human/
    *[(f"human/{name}", repo(f"demo/human/{name}"), what) for name, what in [
        ("hg19_cytoBand.txt", "UCSC hg19 cytoBand"),
        ("Homo_sapiens.GRCh37.chrX.gtf.gz", "Ensembl GRCh37 genes, chromosome X"),
        ("Geuvadis_chrX_GBR_ERR188428.bam", "RNA-seq reads, GBR ERR188428, chrX"),
        ("Geuvadis_chrX_GBR_ERR188428.bam.bai", "…and its index"),
        ("Geuvadis_chrX_GBR_ERR188428.SJ.out.tab", "STAR junctions, GBR ERR188428"),
        ("Geuvadis_chrX_GBR_ERR188383.SJ.out.tab", "STAR junctions, GBR ERR188383"),
        ("Geuvadis_chrX_YRI_ERR188454.SJ.out.tab", "STAR junctions, YRI ERR188454"),
        ("Geuvadis_chrX_YRI_ERR204916.SJ.out.tab", "STAR junctions, YRI ERR204916"),
        ("Geuvadis_chrX_GBR_ERR188428.junctions.bed", "Junctions as regtools writes them"),
    ]],
    # -- Gibcus et al. 2018: DT40 through mitosis, 4DN's files as the lab's bucket holds them
    *[(f"gibcus2018/{name}", s3(CHICKEN + name), what) for name, what in [
        ("G2_4DNFIT479GDR.mcool", "Hi-C, G2 block (4DNES9LEZXN7)"),
        ("5m_4DNFINSJ2GYV.mcool", "Hi-C, prophase 5 min (4DNESNWWIFZU)"),
        ("10m_4DNFIYOEGHHV.mcool", "Hi-C, prophase 10 min (4DNESGDXKM2I)"),
        ("15m_4DNFILKIISAU.mcool", "Hi-C, prometaphase 15 min (4DNESIR416OW)"),
        ("30m_4DNFI165SFJU.mcool", "Hi-C, prometaphase 30 min (4DNESS8PTK6F)"),
        ("60m_4DNFIWHQLZTL.mcool", "Hi-C, prometaphase block 60 min (4DNESEQNSXSD)"),
        ("G2_4DNFILLAMSTE_compartments.bw", "Compartments (E1), G2"),
        ("5m_4DNFI9HASBHH_compartments.bw", "Compartments (E1), 5 min"),
        ("10m_4DNFIG48YRMT_compartments.bw", "Compartments (E1), 10 min"),
        ("15m_4DNFIY1KBU1S_compartments.bw", "Compartments (E1), 15 min"),
        ("30m_4DNFIOCFXWMD_compartments.bw", "Compartments (E1), 30 min"),
        ("60m_4DNFIX92O41_compartments.bw", "Compartments (E1), 60 min"),
        ("G2_4DNFI1PRBI5L_diamond.bw", "Insulation, G2"),
        ("5m_4DNFIIAPL9WO_insulation.bw", "Insulation, 5 min"),
        ("60m_4DNFI12IF3LX_diamond.bw", "Insulation, 60 min"),
    ]],
    # -- Meneu et al. 2025 (GEO GSE217022): yeast carrying a bacterial chromosome
    *[(f"meneu2025/{name}", s3(MENEU + name), what) for name, what in [
        ("HiC/HiC_Mmyco_G1.mcool", "Hi-C, yeast with M. mycoides, G1"),
        ("HiC/HiC_Mmyco_G2M.mcool", "Hi-C, yeast with M. mycoides, G2/M"),
        ("HiC/HiC_Mpneumo_G1.mcool", "Hi-C, yeast with M. pneumoniae, G1"),
        ("HiC/HiC_Mpneumo_G2M.mcool", "Hi-C, yeast with M. pneumoniae, G2/M"),
        ("MNase/MNase_Mmyco_rep1.130-200.CPM.bw", "MNase-seq, 130–200 bp fragments, M. mycoides"),
        ("MNase/MNase_Mpneumo_rep1.130-200.CPM.bw", "MNase-seq, 130–200 bp fragments, M. pneumoniae"),
        ("RNA/RNAseq_Mmyco_rep1.fwd-CPM.bw", "RNA-seq, forward strand, M. mycoides"),
        ("RNA/RNAseq_Mmyco_rep1.rev-CPM.bw", "RNA-seq, reverse strand, M. mycoides"),
        ("RNA/RNAseq_Mpneumo_rep1.fwd-CPM.bw", "RNA-seq, forward strand, M. pneumoniae"),
        ("RNA/RNAseq_Mpneumo_rep1.rev-CPM.bw", "RNA-seq, reverse strand, M. pneumoniae"),
        ("ChIP/PolII_Mmyco_rep1.vs-input.bw", "Pol II ChIP-seq over input, M. mycoides"),
        ("ChIP/PolII_Mpneumo_rep1.vs-input.bw", "Pol II ChIP-seq over input, M. pneumoniae"),
        ("ChIP/Scc1_Mmyco_rep1.vs-input.bw", "Scc1 (cohesin) ChIP-seq over input, M. mycoides"),
        ("ChIP/Scc1_Mpneumo_rep1.vs-input.bw", "Scc1 (cohesin) ChIP-seq over input, M. pneumoniae"),
        ("genome_references/W303_Mmmyco.gff3", "Genes, W303 with the M. mycoides chromosome"),
        ("genome_references/S288c_Mpneumo.gtf", "Genes, S288C with the M. pneumoniae chromosome"),
    ]],
    # -- The Chromosomix paper: the data of its figures, a folder an organism. Human (Figs. 1a and 2): 4DN's
    #    GM12878 map, ENCODE's GM12878 tracks, UCSC's hg38, and what the app computed on them (`derive`).
    (PAPER + f"human/{GM}.mcool", fourdn(GM_UUID, f"{GM}.mcool"),
     "In situ Hi-C, GM12878, 4,010,478,943 contacts (Rao et al. 2014; 4DN 4DNES3JX38V5)"),
    *[(PAPER + f"human/{key.rsplit('/', 1)[-1]}", encode(key), what) for key, _, what in GM_ENCODE.values()],
    (PAPER + "human/hg38.2bit", work("hg38.2bit"), "Human genome hg38, UCSC (bigZips)"),
    (PAPER + "human/hg38.refGene.txt.gz", work("hg38.refGene.txt.gz"), "RefSeq genes, UCSC hg38 refGene table"),
    *[(PAPER + f"human/{name}", repo(f"demo/store/{PAPER}human/{name}"), what) for name, what in [
        (f"{GM}_10000.insulation-w5.bw", "Diamond insulation at 10 kb, 50-kb window, computed by the app (Fig. 2)"),
        (f"{GM}_10000.insulation-w10.bw", "Diamond insulation at 10 kb, 100-kb window, computed by the app (Fig. 2)"),
        (f"{GM}_10000.insulation-w20.bw", "Diamond insulation at 10 kb, 200-kb window, computed by the app (Fig. 2)"),
        (f"{GM}_10000.insulation-w40.bw", "Diamond insulation at 10 kb, 400-kb window, computed by the app (Fig. 2)"),
        (f"{GM}_10000.borders.bed", "Borders called on the 50-kb insulation (Fig. 2)"),
        (GM_PEAKS, "CTCF peaks called by the app's yapc on ENCFF734CUT and ENCFF485CGE, IDR ≤ 0.05 (Fig. 2)"),
        (GM_PAIRS, "Each CTCF peak with the next one along its sequence (Fig. 2)"),
        (f"{GM}_2000.chr14.insulation-w50.bw", "Diamond insulation of chr14 at 2 kb, 100-kb window (Fig. 1a)"),
        (f"{GM}_2000.chr14.borders.bed", "Borders called on chr14's insulation at 2 kb (Fig. 1a)"),
        (f"{GM}_250000.compartments-e1.bw", "Compartments (E1) at 250 kb, phased by GC content (Fig. 1a)"),
        (f"{GM}_250000.compartments-ab.bed", "A and B compartments at 250 kb (Fig. 1a)"),
        (FIG1A_4C, "4C from chr14:89,150,001-89,180,000 over the decay, 5 kb (Fig. 1a)"),
        (FIG1A_MODEL, "pastis-NB model of chr14:88,550,001-90,100,000 at 2 kb (Fig. 1a)"),
        (CTCF_MOTIFS, f"CTCF's core motif {CTCF_MOTIF}, at most one mismatch, on hg38's chr1–22, X and Y (Fig. 1a)"),
    ]],
    #    Mouse (Fig. 1c, d): 4DN's ES-cell Hi-C and ChIP-seq, and what the app computed on them
    #    (manuscript/figure1/results/).
    (PAPER + "mouse/4DNFI5QJNFAT.mcool", fourdn("ef0eba47-ada0-42bc-9329-5145b57ff33a", "4DNFI5QJNFAT.mcool"),
     "In situ Hi-C, F123 mouse ES cells (Kubo et al. 2021)"),
    (PAPER + "mouse/4DNFIFFXFV82.bw", fourdn("6dd5c984-eccf-4d2d-8118-38ea2a4d30fb", "4DNFIFFXFV82.bw"),
     "CTCF ChIP-seq (Huang et al. 2021)"),
    (PAPER + "mouse/4DNFIXE23VC7.bw", fourdn("8ee59614-5b5f-4c8b-a29e-86d0c8047c30", "4DNFIXE23VC7.bw"),
     "H3K27ac ChIP-seq (Huang et al. 2021)"),
    (PAPER + "mouse/4DNFIQYJLKKH.bw", fourdn("f1ae271a-971a-4611-a6d0-fd971f1e693f", "4DNFIQYJLKKH.bw"),
     "H3K4me3 ChIP-seq (Huang et al. 2021)"),
    (PAPER + "mouse/mm10_genes.gtf.gz", work("mm10_genes.gtf.gz"), "Genes, UCSC mm10 (iGenomes), bgzipped"),
    (PAPER + "mouse/mm10_genes.gtf.gz.tbi", work("mm10_genes.gtf.gz.tbi"), "…and its tabix index"),
    *[(PAPER + f"mouse/4DNFI5QJNFAT_{name}", repo(FIG1 + source), what) for name, source, what in [
        ("250000.compartments-e1.bw", "compartments/4DNFI5QJNFAT_250000.compartments.compartment-e1.bw",
         "Compartments (E1) of chromosome 3 at 250 kb, signed by H3K27ac (Fig. 1c)"),
        ("250000.compartments-ab.bed", "compartments/4DNFI5QJNFAT_250000.compartments.compartment-ab.bed",
         "A and B compartments of chromosome 3 at 250 kb (Fig. 1c)"),
        ("10000.insulation-w10.bw", "insulation/4DNFI5QJNFAT_10000.insulation.insulation-w10.bw",
         "Diamond insulation at 10 kb, 100-kb window (Figs. 1c, 1d)"),
        ("10000.borders.bed", "insulation/4DNFI5QJNFAT_10000.insulation.insulation-boundaries.bed",
         "Borders called on the insulation (Figs. 1c, 1d)"),
        ("10000.domains.bed", "insulation/4DNFI5QJNFAT_10000.insulation.insulation-domains.bed",
         "Domains between the borders (Fig. 1d)"),
        ("5000.loops.bedpe", "loops/4DNFI5QJNFAT_5000.chromosight.chromosight-patterns.bedpe",
         "Loops on chromosome 3 at 5 kb, Chromosight (Fig. 1c)"),
        ("2500000.genome.bed3d", "model-genome/4DNFI5QJNFAT_2500000.reconstruct3d.reconstructed-model.bed3d",
         "pastis-NB model of the genome at 2.5 Mb (Fig. 1c)"),
        ("250000.chr3.bed3d", "model-chr3/4DNFI5QJNFAT_250000.reconstruct3d.reconstructed-model.bed3d",
         "pastis-NB model of chromosome 3 at 250 kb (Figs. 1c, 1d)"),
        ("10000.chr3-27-37Mb.bed3d", "model-region/4DNFI5QJNFAT_10000.reconstruct3d.reconstructed-model.bed3d",
         "pastis-NB model of chr3:27–37 Mb at 10 kb (Fig. 1c)"),
        ("5000.chr3-34-35Mb.bed3d", "model-locus/4DNFI5QJNFAT_5000.reconstruct3d.reconstructed-model.bed3d",
         "pastis-NB model of chr3:34–35 Mb, the Sox2 locus, at 5 kb (Fig. 1c)"),
        ("2000.Sox2-SCR.bed3d", "model-gene/4DNFI5QJNFAT_2000.reconstruct3d.reconstructed-model.bed3d",
         "pastis-NB model of chr3:34.55–34.80 Mb, Sox2 and its control region, at 2 kb (Fig. 1c)"),
    ]],
    #    C. necator N-1 (Fig. S3a): the lab's map, its reference, and its origin and GC skew as the app
    #    called them — copied from where the DNA Bacterial Zoo keeps them, which this card does not name.
    *[(PAPER + f"C_necator/{name}", s3(CNECATOR + source), what) for name, source, what in [
        ("C_necator_N1_VJ_MM260.mcool", "C_necator_N1_VJ_MM260.mcool", "Hi-C, C. necator N-1 (MM260)"),
        ("C_necator_N1_VJ.fa", "C_necator_N1_VJ.fa", "C. necator N-1: two chromosomes and two plasmids"),
        ("C_necator_N1_VJ_MM260_4000.oriter-loci.bed", "oriter/C_necator_N1_VJ_MM260_4000.oriter.oriter-loci.bed",
         "Origins and termini, called by the app"),
        ("C_necator_N1_VJ_MM260_4000.gc-skew-cumulative.bw",
         "composition/C_necator_N1_VJ_MM260_4000.composition.composition-cumulative.bw",
         "Cumulative GC skew, 4 kb"),
    ]],
    #    B. subtilis PY79 (Fig. S3b): wild type, ΔparAB, and the time course after ParB is induced.
    *[(PAPER + f"B_subtilis/Bsubtilis_{name}.mcool", s3(f"{SUBTILIS}Bsubtilis_{source}.mcool"), f"Hi-C, {label}")
      for name, source, label in SUBTILIS_COURSE],
    (PAPER + "B_subtilis/PY79.fa", s3(SUBTILIS + "PY79.fa"), "B. subtilis PY79"),
    (PAPER + "B_subtilis/PY79.gff3", s3(SUBTILIS + "PY79.gff3"), "Genes, B. subtilis PY79"),
    #    P. aeruginosa (Fig. S3c): wild type and two condensin mutants, and E1 along both arms of each.
    *[(PAPER + f"P_aeruginosa/{sample}.mcool", s3(f"{PAK}{sample}.mcool"), f"Hi-C, {label} ({sample.split('_')[-1]})")
      for sample, label in PAO1_STRAINS],
    (PAPER + "P_aeruginosa/PAO1_v3.fa", s3(PAK + "PAO1_v3.fa"), "P. aeruginosa, the maps' reference"),
    (PAPER + f"P_aeruginosa/{PAK_RNA}", s3(PAK + PAK_RNA), "RNA-seq, PAK at T0, counts per million (GEO GSE76513)"),
    *[(PAPER + f"P_aeruginosa/{sample}_8000.e1-arms.bw", repo(f"demo/store/{PAPER}P_aeruginosa/{sample}_8000.e1-arms.bw"),
       f"E1 along both arms at 8 kb, {label}, computed by the app") for sample, label in PAO1_STRAINS],
]


# ---------------------------------------------------------------------------
# the workspaces
# ---------------------------------------------------------------------------

CREATED = "2026-10-07T00:00:00.000Z"

#: The overlay preferences a map session is published with: every one on.
PLOT_MAP = {"text": True, "fills": True, "baseline": True, "outline": True, "gutter": False,
            "crosshair": True, "dividers": True, "breaks": True, "labels": True, "ticks": True}
#: …and a browser session's: the gutter on, no dividers, the labels in the gutter.
PLOT_BROWSER = {**PLOT_MAP, "gutter": True, "dividers": False, "labels": False}


def track(tid: str, kind: str, label: str, url: str, colour: str, size: int, *,
          card: str = "linear", bottom: bool = True, right: bool = False, top: bool = False, left: bool = False,
          primary: bool = False, visible: bool = True, **style) -> dict:
    """One `StoredEntry`, written in full: `readTab` fills nothing in for a track."""
    base = {"colour": colour, "size": size, "mode": "line" if kind == "sequence" else "area",
            "limits": {"auto": kind != "sequence", "min": 0, "max": 1}, "group": "", "shape": "element",
            "radius": 7, "opacity": 0.9 if kind == "pairs" else 1, "flip": False}
    entry = {"id": tid, "card": card, "kind": kind, "label": label,
             "source": {"kind": "remote", "name": url.rsplit("/", 1)[-1], "url": url},
             "visible": visible, "placement": edges(bottom=bottom, right=right, top=top, left=left),
             "style": {**base, **style}}
    if primary:
        entry["primary"] = True
    return entry


def edges(*, bottom: bool = False, right: bool = False, top: bool = False, left: bool = False) -> dict:
    """A placement with all four edges said, as the app writes one."""
    return {"top": top, "right": right, "bottom": bottom, "left": left}


def limits(lo: float, hi: float) -> dict:
    return {"auto": False, "min": lo, "max": hi}


def tab(name: str, state: dict, tracks: list[dict], *, sequences=(), plot=PLOT_MAP, **extra) -> dict:
    return {"version": 1, "createdAt": CREATED, "name": name, "state": state, "tracks": tracks, "manual": [],
            "sequences": list(sequences), "groups": extra.pop("groups", {}), "scaling": extra.pop("scaling", {}),
            "compareNormalise": False, "tables": {}, "plot": plot, **extra}


def workspace(*tabs: dict) -> dict:
    return {"kind": "chromosomix.workspace", "version": 1, "createdAt": CREATED, "active": 0, "tabs": list(tabs)}


def on(track_: dict, uri: str, edge: str = "bottom") -> dict:
    """A track's lane on a companion map, and the track taken off the lead (`lead: null`).

    What the app writes when a reader puts a track on one cell of a deck and nowhere else: the lane
    by the companion's file, exactly as `maps` spells it, and the lead told not to draw it.
    """
    track_["lead"] = None
    return {"track": track_["id"], "uri": uri, "placement": edges(**{edge: True}), "borrowedLead": True}


# The yeast files, as the three yeast cards name them.
FA, GTF = "S288c.fa", "S288c.gtf"
ATAC, MNASE, SHOTGUN = "Yeast_ATAC.bw", "Yeast_MNase.bw", "Yeast_shotgun.bw"
SNPS, RNA = "Yeast_snps.vcf.gz", "Yeast_RNAseq.barChart"
MICROC, PCP = "GSE151553_A364_merged.mcool", "Yeast_PCP_GSM8476641_G1_rep1.mcool"
LOOPS = "Yeast_microC_loops.bedpe"
HIC_MYCO_G1 = "../meneu2025/HiC/HiC_Mmyco_G1.mcool"

COLOURS = {"atac": "#d55e00", "mnase": "#009e73", "shotgun": "#8c8c8c", "snps": "#cc79a7",
           "loops": "#0072b2", "genes": "#5b6169", "sequence": "#8c6d31"}

#: Where each card opens. Chosen by looking (`stage`), and said in the card's line.
#: The micro-C map has a weight for every 1.6-kb bin of this window, and its loops are drawn on it.
YEAST_REGION = "chrXIV:100000-500000"
#: Inside it: RHO5, RPS3 and MRPL22 with their promoters, close enough for the reading frames to show the ORFs.
YEAST_LOCUS = "XIV:299,501-305,000"
#: Every bin weighted in both the micro-C and the Hi-C map, and W303's chromosome XV within 26 bp of
#: R64's here — so the Hi-C cell, on the W303 assembly, draws the same place as the two beside it.
DECK_REGION = "chrXV:200000-400000"


def yeast_microc() -> dict:
    tracks = [
        track("yeast-sequence", "sequence", "sequence", FA, COLOURS["sequence"], 46, right=True),
        track("yeast-genes", "gtf", "genes", GTF, COLOURS["genes"], 62, right=True, primary=True),
        track("yeast-rna", "barchart", "RNA-seq, CPM", RNA, "#56789a", 56, limits=limits(0, 400)),
        track("yeast-atac", "track", "ATAC", ATAC, COLOURS["atac"], 50),
        track("yeast-mnase", "track", "MNase", MNASE, COLOURS["mnase"], 50),
        track("yeast-shotgun", "track", "shotgun", SHOTGUN, COLOURS["shotgun"], 40),
        track("yeast-snps", "variants", "SNPs, 16 samples", SNPS, COLOURS["snps"], 34),
        track("yeast-loops", "pairs", "loops", LOOPS, COLOURS["loops"], 16, card="overlay"),
    ]
    state = {"uri": f"{MICROC}::resolutions/1600", "view": "region", "region": YEAST_REGION, "level": "bin",
             "balance": True, "transform": "log10", "colormap": "default"}
    return workspace(tab("Yeast micro-C", state, tracks, circular=["chrM"]))


def yeast_landscape() -> dict:
    tracks = [
        track("yeast-sequence", "sequence", "sequence", FA, COLOURS["sequence"], 46,
              translation={"frames": True, "code": 1}),
        track("yeast-genes", "gtf", "genes", GTF, COLOURS["genes"], 92, primary=True),
        track("yeast-rna", "barchart", "RNA-seq, CPM", RNA, "#56789a", 60, limits=limits(0, 400)),
        track("yeast-atac", "track", "ATAC", ATAC, COLOURS["atac"], 70, group="chromatin"),
        track("yeast-mnase", "track", "MNase", MNASE, COLOURS["mnase"], 70, group="chromatin"),
        track("yeast-shotgun", "track", "shotgun", SHOTGUN, COLOURS["shotgun"], 46),
        track("yeast-snps", "variants", "SNPs, 16 samples", SNPS, COLOURS["snps"], 60),
    ]
    state = {"uri": FA, "view": "browser", "locus": YEAST_LOCUS}
    return workspace(tab("Yeast chromatin landscape", state, tracks, sequences=["XIV"], plot=PLOT_BROWSER,
                         groups={"chromatin": "stacked"}, scaling={"chromatin": "each"}))


def yeast_deck() -> dict:
    """Hi-C, micro-C and PCP of one locus, three across, with MNase and the genes under each."""
    # One kilobase each: the three files share no rung (micro-C halves from 50 bp, the Hi-C doubles from
    # 1 kb, PCP runs 5 bp to 25 kb), so each cell is named at the closest it has to the others, and the
    # deck's own *match all resolutions* has nothing to move. A lane is matched to its cell by this very
    # string, which is why it is written once here and used for both.
    hic, pcp = f"{HIC_MYCO_G1}::resolutions/1000", f"{PCP}::resolutions/1000"
    maps = {hic: "Hi-C · Meneu et al. 2025, G1", pcp: "PCP · Delamarre et al. 2025, G1"}
    lead = f"{MICROC}::resolutions/1600"
    tracks, lanes = [], []
    for key, uri in (("microc", None), ("hic", hic), ("pcp", pcp)):
        mnase = track(f"deck-mnase-{key}", "track", "MNase", MNASE, COLOURS["mnase"], 56)
        genes = track(f"deck-genes-{key}", "gtf", "genes", GTF, COLOURS["genes"], 56, primary=key == "microc")
        tracks += [mnase, genes]
        if uri is not None:
            lanes += [on(mnase, uri), on(genes, uri)]
    state = {"uri": lead, "maps": "|".join(maps), "view": "region", "region": DECK_REGION, "level": "bin",
             "balance": True, "transform": "log10", "colormap": "default"}
    names = {uri.split("::")[0]: name for uri, name in maps.items()}
    # The session's own map, micro-C, stands second, so the deck reads as the card's title does:
    # Hi-C, micro-C, PCP (§16.9).
    return workspace(tab("Hi-C, micro-C and PCP", state, tracks, lanes=lanes,
                         deck={"columns": 3, "lead": {"at": 1, "hidden": False}},
                         circular=["chrM"],
                         mapNames={**names, MICROC: "Micro-C · Costantino et al. 2020"}))


def human() -> dict:
    """The splicing figure, as `demo/human/` had it, on the files it names, with an axis both samples fit on."""
    src = json.loads((ROOT / "demo" / "human" / "Human_chrX_RNA.chromosomix.json").read_text())
    t = src["tabs"][0]
    for entry in t["tracks"]:
        if entry["kind"] == "junctions":
            # YRI ERR188454 reads 439 at RPL10's longest junction: a 400 ceiling cut its arc off.
            entry["style"]["limits"] = limits(1, 500)
        if entry["kind"] == "alignments":
            entry["label"] = "reads · GBR ERR188428"
    t["createdAt"] = src["createdAt"] = CREATED
    t["name"] = "Human chrX, splicing"
    return src


GIBCUS = [  # (label, map, compartments, insulation)
    ("G2", "G2_4DNFIT479GDR.mcool", "G2_4DNFILLAMSTE_compartments.bw", "G2_4DNFI1PRBI5L_diamond.bw"),
    ("5 min", "5m_4DNFINSJ2GYV.mcool", "5m_4DNFI9HASBHH_compartments.bw", "5m_4DNFIIAPL9WO_insulation.bw"),
    ("10 min", "10m_4DNFIYOEGHHV.mcool", "10m_4DNFIG48YRMT_compartments.bw", None),
    ("15 min", "15m_4DNFILKIISAU.mcool", "15m_4DNFIY1KBU1S_compartments.bw", None),
    ("30 min", "30m_4DNFI165SFJU.mcool", "30m_4DNFIOCFXWMD_compartments.bw", None),
    ("60 min", "60m_4DNFIWHQLZTL.mcool", "60m_4DNFIX92O41_compartments.bw", "60m_4DNFI12IF3LX_diamond.bw"),
]
GIBCUS_WHOLE = "chr7:1-36946936"
GIBCUS_COMPARTMENTS = "chr1:20000000-60000000"
GIBCUS_TADS = "chr1:30000000-34000000"


def gibcus_deck(name: str, rows, region: str, resolution: int, *, compartments: bool, insulation: bool,
                columns: int) -> dict:
    lead_label, lead_map, *_ = rows[0]
    tracks, lanes = [], []
    for i, (label, mcool, e1, ins) in enumerate(rows):
        uri = None if i == 0 else f"{mcool}::resolutions/{resolution}"
        if compartments:
            t = track(f"e1-{i}", "track", f"E1 · {label}", e1, "#7b3294", 40, limits=limits(-1.5, 1.5))
            tracks.append(t)
            if uri is not None:
                lanes.append(on(t, uri))
        if insulation and ins is not None:
            t = track(f"ins-{i}", "track", f"insulation · {label}", ins, "#0072b2", 40, limits=limits(-1, 1))
            tracks.append(t)
            if uri is not None:
                lanes.append(on(t, uri))
    maps = [f"{mcool}::resolutions/{resolution}" for _, mcool, *_ in rows[1:]]
    state = {"uri": f"{lead_map}::resolutions/{resolution}", "maps": "|".join(maps), "view": "region",
             "region": region, "level": "bin", "balance": True, "transform": "log10", "colormap": "default"}
    names = {mcool: label for label, mcool, *_ in rows}
    return tab(name, state, tracks, lanes=lanes, deck={"columns": columns}, mapNames=names)


def gibcus() -> dict:
    return workspace(
        gibcus_deck("G2 to prometaphase, chromosome 7", GIBCUS, GIBCUS_WHOLE, 250000,
                    compartments=False, insulation=False, columns=3),
        gibcus_deck("Compartments fade", GIBCUS, GIBCUS_COMPARTMENTS, 100000,
                    compartments=True, insulation=False, columns=3),
        gibcus_deck("Domains fade", [GIBCUS[0], GIBCUS[1], GIBCUS[5]], GIBCUS_TADS, 25000,
                    compartments=False, insulation=True, columns=3),
    )


MENEU_MAPS = [  # (label, map, assembly's genes, MNase, RNA fwd, RNA rev, Pol II, Scc1)
    ("M. mycoides, G2/M", "HiC/HiC_Mmyco_G2M.mcool", "genome_references/W303_Mmmyco.gff3",
     "MNase/MNase_Mmyco_rep1.130-200.CPM.bw", "RNA/RNAseq_Mmyco_rep1.fwd-CPM.bw",
     "RNA/RNAseq_Mmyco_rep1.rev-CPM.bw", "ChIP/PolII_Mmyco_rep1.vs-input.bw", "ChIP/Scc1_Mmyco_rep1.vs-input.bw"),
    ("M. pneumoniae, G2/M", "HiC/HiC_Mpneumo_G2M.mcool", "genome_references/S288c_Mpneumo.gtf",
     "MNase/MNase_Mpneumo_rep1.130-200.CPM.bw", "RNA/RNAseq_Mpneumo_rep1.fwd-CPM.bw",
     "RNA/RNAseq_Mpneumo_rep1.rev-CPM.bw", "ChIP/PolII_Mpneumo_rep1.vs-input.bw",
     "ChIP/Scc1_Mpneumo_rep1.vs-input.bw"),
]
MENEU_REGION = "Mmmyco:1-1222199"
MENEU_PNEUMO_REGION = "Mpneumo:1-817946"


def meneu() -> dict:
    tracks, lanes = [], []
    for i, (label, mcool, genes, mnase, fwd, rev, pol2, scc1) in enumerate(MENEU_MAPS):
        key = "myco" if i == 0 else "pneumo"
        uri = None if i == 0 else f"{mcool}::resolutions/4000"
        row = [
            track(f"{key}-genes", "gtf", "genes", genes, COLOURS["genes"], 40, primary=i == 0),
            track(f"{key}-mnase", "track", "MNase", mnase, COLOURS["mnase"], 40),
            track(f"{key}-rna-fwd", "track", "RNA +", fwd, "#56789a", 40, group=f"rna-{key}"),
            track(f"{key}-rna-rev", "track", "RNA −", rev, "#56789a", 40, group=f"rna-{key}", flip=True),
            track(f"{key}-pol2", "track", "Pol II / input", pol2, "#d55e00", 40),
            track(f"{key}-scc1", "track", "Scc1 / input", scc1, "#cc79a7", 40),
        ]
        tracks += row
        if uri is not None:
            lanes += [on(t, uri) for t in row]
    lead = f"{MENEU_MAPS[0][1]}::resolutions/4000"
    state = {"uri": lead, "maps": f"{MENEU_MAPS[1][1]}::resolutions/4000", "view": "region",
             "region": MENEU_REGION, "level": "bin", "balance": True, "transform": "log10", "colormap": "default"}
    # Each cell on its own bacterial chromosome: the second map has no `Mmmyco`, so its chain is open and
    # it reads a window of its own (`DeckLook.place`, §16.3), keyed — as its lanes are — by its `maps` entry.
    looks = [{"uri": state["maps"], "locked": False, "place": {"rows": MENEU_PNEUMO_REGION}}]
    chromosomes = tab("The bacterial chromosomes, G2/M", state, tracks, lanes=lanes,
                      deck={"columns": 2, "looks": looks},
                      groups={"rna-myco": "stacked", "rna-pneumo": "stacked"},
                      scaling={"rna-myco": "shared", "rna-pneumo": "shared"},
                      mapNames={m: label for label, m, *_ in MENEU_MAPS})
    # The same two strains in G1, whole genome: each bacterial chromosome beside the sixteen of yeast.
    g1 = {"HiC/HiC_Mmyco_G1.mcool": "M. mycoides, G1", "HiC/HiC_Mpneumo_G1.mcool": "M. pneumoniae, G1"}
    myco_g1, pneumo_g1 = (f"{m}::resolutions/16000" for m in g1)
    nucleus = tab("In the yeast nucleus, G1", {"uri": myco_g1, "maps": pneumo_g1, "view": "whole", "level": "bin",
                                              "balance": True, "transform": "log10", "colormap": "default"},
                  [], deck={"columns": 2, "looks": [{"uri": pneumo_g1, "locked": False}]}, mapNames=g1)
    return workspace(chromosomes, nucleus)


# The Chromosomix paper: one tab a panel, each a deck of the panel's maps.
#
# A deck remembers one look a file (`DeckLook`, §16.2), so a panel that draws one map several ways —
# Fig. S3a's six readings of one map, Fig. S3c's three of each strain — is drawn here the one way of
# each file that the panel reads last, and the cell's own score picker has the others.

MOUSE_MAP = "mouse/4DNFI5QJNFAT.mcool"
MOUSE_NAMES = {MOUSE_MAP: "Hi-C · mouse ES cells (4DN)"}
PAPER_COLOURS = {"genes": COLOURS["genes"], "ctcf": "#e69f00", "h3k27ac": "#009e73", "h3k4me3": "#56789a",
                 "e1": "#7b3294", "insulation": "#0072b2", "borders": "#0072b2", "loops": "#000000",
                 "model": "#cc79a7", "skew": "#d95f02", "loci": "#000000", "rna": "#56789a"}
#: Each map is read balanced, on the app's default ramp, unless its panel says otherwise.
MAP_LOOK = {"level": "bin", "balance": True, "transform": "log10", "colormap": "default"}


def mouse(name: str) -> str:
    return f"mouse/4DNFI5QJNFAT_{name}"


def mouse_track(key: str, tid: str, **kw) -> dict:
    """One of Fig. 1's tracks, by what it is."""
    made = {
        "genes": lambda: track(tid, "gtf", "genes · mm10", "mouse/mm10_genes.gtf.gz", PAPER_COLOURS["genes"], 56,
                               **kw),
        "ctcf": lambda: track(tid, "track", "CTCF", "mouse/4DNFIFFXFV82.bw", PAPER_COLOURS["ctcf"], 48, **kw),
        "h3k27ac": lambda: track(tid, "track", "H3K27ac", "mouse/4DNFIXE23VC7.bw", PAPER_COLOURS["h3k27ac"], 48,
                                 **kw),
        "h3k4me3": lambda: track(tid, "track", "H3K4me3", "mouse/4DNFIQYJLKKH.bw", PAPER_COLOURS["h3k4me3"], 48,
                                 **kw),
        "e1": lambda: track(tid, "track", "E1 · 250 kb", mouse("250000.compartments-e1.bw"), PAPER_COLOURS["e1"],
                            44, **kw),
        "ab": lambda: track(tid, "segments", "A/B · 250 kb", mouse("250000.compartments-ab.bed"),
                            PAPER_COLOURS["e1"], 20, **kw),
        "insulation": lambda: track(tid, "track", "insulation · 100 kb", mouse("10000.insulation-w10.bw"),
                                    PAPER_COLOURS["insulation"], 44, **kw),
        "borders": lambda: track(tid, "segments", "borders", mouse("10000.borders.bed"), PAPER_COLOURS["borders"],
                                 20, **kw),
        "loops": lambda: track(tid, "pairs", "loops · 5 kb", mouse("5000.loops.bedpe"), PAPER_COLOURS["loops"], 16,
                               card="overlay", **kw),
    }
    return made[key]()


def model(tid: str, label: str, name: str, colour_by: str) -> dict:
    return track(tid, "structure", label, mouse(name), PAPER_COLOURS["model"], 24, card="structure", bottom=False,
                 structure={"colourBy": f"track:{colour_by}"})


#: Fig. 1c's columns, the genome first: (rung, the window the map reads for itself — none for the
#: genome, which is the deck's own view — its look, the tracks under it, and its model and what colours it).
FIG1C = [
    (2500000, None, {}, [], ("genome · 2.5 Mb", "2500000.genome.bed3d", "c-h3k27ac")),
    (250000, "chr3", {"score": "correlation", "smooth": "1"}, ["e1", "ab"],
     ("chr3 · 250 kb", "250000.chr3.bed3d", "c-e1")),
    (10000, "chr3:27000001-37000000", {}, ["insulation", "borders"],
     ("chr3:27–37 Mb · 10 kb", "10000.chr3-27-37Mb.bed3d", "c-insulation")),
    (5000, "chr3:34000001-35000000", {"oe": True, "transform": "log2", "smooth": "1"}, ["genes", "ctcf", "loops"],
     ("chr3:34–35 Mb · 5 kb", "5000.chr3-34-35Mb.bed3d", "c-ctcf")),
    (2000, "chr3:34550001-34800000", {}, ["genes", "h3k27ac", "h3k4me3"],
     ("Sox2 and its SCR · 2 kb", "2000.Sox2-SCR.bed3d", "c-h3k27ac")),
]


def paper_fig1c() -> dict:
    """One session from the whole genome to the 250 kb around Sox2: a map a scale, a model under each.

    The first map is the genome, which is the deck's own view; every other reads its own window at its
    own rung (an open chain with a `place`, §16.3), so the five maps are five files to the deck and each
    keeps its own look. The tracks sit under the map they were drawn under, by lanes; the models fill
    the second row, each cell falling to the first model no other cell is drawing (§25.3).
    """
    tracks, lanes, looks, maps, models = [], [], [], [], []
    for rung, window, look, under, (label, name, colour_by) in FIG1C:
        uri = f"{MOUSE_MAP}::resolutions/{rung}"
        for key in under:
            # The genes are under two maps: a copy each, as the store's decks have them.
            t = mouse_track(key, f"c-genes-{rung}" if key == "genes" else f"c-{key}",
                            primary=key == "genes" and rung == 5000)
            tracks.append(t)
            lanes.append(on(t, uri))
        # A model's colour names a row of this tab: the genome's H3K27ac is the one under the 2-kb map.
        models.append(model(f"c-model-{rung}", f"model · {label}", name, colour_by))
        if window is not None:
            maps.append(uri)
            looks.append({"uri": uri, "locked": False, "place": {"rows": window}, **look})
    state = {"uri": f"{MOUSE_MAP}::resolutions/{FIG1C[0][0]}", "maps": "|".join(maps + ["3d"] * len(models)),
             "view": "whole", **MAP_LOOK}
    return tab("Fig. 1c · one session, from the genome to Sox2", state, tracks + models, lanes=lanes,
               deck={"columns": len(FIG1C), "looks": looks}, mapNames=MOUSE_NAMES)


def paper_fig1d() -> dict:
    """The map at 10 kb, chr3:32–36 Mb, with the insulation chain under it and chromosome 3's model.

    The domains are in the folder and not in the tab: a BED from a file is a lane, whatever its card
    says (§8.3), and domains that abut tile a lane into one bar.
    """
    tracks = [mouse_track("insulation", "d-insulation"), mouse_track("borders", "d-borders"),
              mouse_track("ctcf", "d-ctcf"), mouse_track("genes", "d-genes", primary=True),
              model("d-model", "model · chr3 · 250 kb", "250000.chr3.bed3d", "d-ctcf")]
    state = {"uri": f"{MOUSE_MAP}::resolutions/10000", "maps": "3d", "view": "region",
             "region": "chr3:32000001-36000000", **MAP_LOOK}
    return tab("Fig. 1d · borders, CTCF and the model, chr3:32–36 Mb", state, tracks, deck={"columns": 2},
               mapNames=MOUSE_NAMES)


def centred(name: str, length: int, origin: int) -> str:
    """The whole circle with its origin in the middle, as the app's own button writes it.

    `Session.centreOnOrigin`: a window across the junction, its end below its start, from half a lap
    after the origin round to half a lap before it — one base short of a lap, which would otherwise
    be the whole sequence named from its first base.
    """
    start = (origin + -(-length // 2)) % length
    return f"{name}:{start}-{(start - 1 + length) % length}"


#: The bin size every bacterial map of Fig. S3 is read at but the time course's, and how far along the
#: arms the decay along both arms reaches, in bins: 400 kb (Methods, "Analysis of bacterial genomes").
BACTERIA_RES, ARM_WINDOW = 8000, 50
#: C. necator N-1. Origins are 0-based, as a workspace stores them (`state/origins.ts`), as *Origin and
#: terminus* called them on the zoo's copy of this map.
CNECATOR_MAP = "C_necator/C_necator_N1_VJ_MM260.mcool"
CNECATOR_ORIGINS = {"chromosome1": 8500, "chromosome2": 500, "pBB1": 5500, "pBB2": 342500}
CNECATOR_CHR1 = 3872936
#: B. subtilis PY79's one chromosome, whose sequence starts at dnaA: its origin is its first base.
SUBTILIS_CHROM, SUBTILIS_LENGTH, SUBTILIS_RES = "NC_022898.1", 4033459, 10000
#: P. aeruginosa's one chromosome in the maps' reference, and its origin as *Origin and terminus* calls
#: it with the sequence read as a circle (1-based 6,250,501, near the junction, as dnaA is in PAO1).
PAO1_CHROM, PAO1_LENGTH, PAO1_ORIGIN = "PAO1", 6271000, 6250500


def paper_figS3a() -> dict:
    """C. necator's first chromosome, origin in the middle, over the two decays the panel compares.

    One map, so one look (`DeckLook`): the first map divides by the decay along the diagonal, the
    second, the same file, by the decay along both arms. Balanced counts, the correlations and the
    decay along both arms itself are each cell's score picker.
    """
    uri = f"{CNECATOR_MAP}::resolutions/{BACTERIA_RES}"
    cn = lambda name: f"C_necator/C_necator_N1_VJ_MM260_4000.{name}"  # noqa: E731
    tracks = [track("a-loci", "segments", "origins and termini", cn("oriter-loci.bed"), PAPER_COLOURS["loci"], 20),
              track("a-skew", "track", "cumulative GC skew", cn("gc-skew-cumulative.bw"), PAPER_COLOURS["skew"], 44)]
    state = {"uri": uri, "maps": uri, "view": "region", "region": centred("chromosome1", CNECATOR_CHR1, 8500),
             **MAP_LOOK, "oe": True, "transform": "log2"}
    looks = [{"uri": uri, "oe": True, "arms": ARM_WINDOW, "transform": "log2"}]
    return tab("Fig. S3a · C. necator, obs./exp.: the decay along the diagonal, then along both arms", state,
               tracks, deck={"columns": 2, "looks": looks}, circular=list(CNECATOR_ORIGINS),
               origins=CNECATOR_ORIGINS, mapNames={CNECATOR_MAP: "C. necator N-1 (MM260)"})


def paper_figS3b() -> dict:
    """The B. subtilis time course, a map a condition, at 10 kb, the origin in the middle."""
    files = [f"B_subtilis/Bsubtilis_{name}.mcool" for name, _, _ in SUBTILIS_COURSE]
    rung = f"::resolutions/{SUBTILIS_RES}"
    names = {f: label for f, (_, _, label) in zip(files, SUBTILIS_COURSE)}
    state = {"uri": files[0] + rung, "maps": "|".join(f + rung for f in files[1:]), "view": "region",
             "region": centred(SUBTILIS_CHROM, SUBTILIS_LENGTH, 0), **MAP_LOOK}
    return tab("Fig. S3b · B. subtilis: WT, ΔparAB, and after ParB is induced", state, [], deck={"columns": 4},
               circular=[SUBTILIS_CHROM], origins={SUBTILIS_CHROM: 0}, mapNames=names)


def paper_figS3c() -> dict:
    """P. aeruginosa, wild type and two condensin mutants: the correlation over the decay along both
    arms, with each strain's E1 under its map and the wild type's RNA-seq under its own.

    The RNA-seq is drawn to 30 CPM, about the 95th percentile of its 8-kb bins: its rRNA operons
    reach two thousand, and an axis fitted to them leaves every other gene flat."""
    rung = f"::resolutions/{BACTERIA_RES}"
    files = [f"P_aeruginosa/{sample}.mcool" for sample, _ in PAO1_STRAINS]
    tracks, lanes = [], []
    for i, (sample, label) in enumerate(PAO1_STRAINS):
        e1 = track(f"pa-e1-{i}", "track", f"E1 · {label}", f"P_aeruginosa/{sample}_8000.e1-arms.bw",
                   PAPER_COLOURS["e1"], 44)
        tracks.append(e1)
        if i > 0:
            lanes.append(on(e1, files[i] + rung))
    tracks.append(track("pa-rna", "track", "RNA-seq · PAK, CPM", f"P_aeruginosa/{PAK_RNA}", PAPER_COLOURS["rna"], 44,
                        limits=limits(0, 30)))
    state = {"uri": files[0] + rung, "maps": "|".join(f + rung for f in files[1:]), "view": "region",
             "region": centred(PAO1_CHROM, PAO1_LENGTH, PAO1_ORIGIN), **MAP_LOOK,
             "score": "correlation", "arms": ARM_WINDOW, "transform": "none"}
    return tab("Fig. S3c · P. aeruginosa: WT, SMC-ScpAB– and MksBEF–, the correlation along both arms", state, tracks,
               lanes=lanes, deck={"columns": 3}, circular=[PAO1_CHROM], origins={PAO1_CHROM: PAO1_ORIGIN},
               mapNames={f: label for f, (_, label) in zip(files, PAO1_STRAINS)})


GM_MAP = f"human/{GM}.mcool"
GM_NAMES = {GM_MAP: "Hi-C · GM12878 (Rao et al. 2014, 4DN)"}
GM_COLOURS = {"insulation": "#1aa0b8", "e1": "#8c8c8c", "ab": "#d62728", "fourc": "#c45a9a", "ctcf": "#d55e00",
              "ctcf2": "#b2182b", "peaks": "#d55e00", "motifs": "#d55e00", "rna+": "#e69f00", "rna-": "#3a8fd0",
              "atac": "#9c6b1e", "genes": COLOURS["genes"], "sequence": COLOURS["genes"], "model": "#c45a9a"}


def gm(name: str) -> str:
    return f"human/{name}"


def machine(region: str) -> str:
    """A window as a reader writes it — 1-based, closed, with separators — in the form a session holds,
    0-based and half-open (§26.1): `chr14:88,550,001-90,100,000` is `chr14:88550000-90100000`."""
    contig, span = region.rsplit(":", 1)
    start, end = (int(x.replace(",", "")) for x in span.split("-"))
    return f"{contig}:{start - 1}-{end}"


def tracks_cell(seat: int = 0) -> str:
    """What a track on a deck's tracks cell is kept under: its seat (`tracksCellKey`, §16.11)."""
    return f"tracks:{seat + 1}"


def paper_fig1a() -> dict:
    """GM12878 at 2 kb over chr14:88.55–90.10 Mb, as Fig. 1a draws the window: three cells across.

    `circular` is declared, empty: the junction test the first open runs reads two human chromosomes as
    circles on this map, and a declaration is what records it as run.

    The map, with the insulation and its borders above it, the compartments and E1 at its left and the
    4C profile from chr14:89,150,001-89,180,000 under it; a tracks cell with CTCF and its motif, the two
    strands of RNA-seq, ATAC-seq and its peaks, the genes and the sequence; and the model inferred from
    the map, drawn as sticks and coloured by each bead's distance to one pinned inside the central
    sub-TAD, on the map's own ramp. The marks are the TAD, a box over it, and lines at its two borders and at the sub-TAD
    border by the 4C anchor: drawn across the map and its lanes, and as beads on the model.
    """
    on_map = [
        # An edge stacks its lanes outwards from the map in the list's order: the insulation next to the
        # map and its borders above it, E1 next to the map and the A/B calls beyond it, as Fig. 1a has them.
        track("a-insulation", "track", "diamond insulation · 100 kb", gm(f"{GM}_2000.chr14.insulation-w50.bw"),
              GM_COLOURS["insulation"], 48, top=True, bottom=False),
        track("a-borders", "segments", "insulation boundaries", gm(f"{GM}_2000.chr14.borders.bed"),
              GM_COLOURS["insulation"], 18, top=True, bottom=False),
        track("a-e1", "track", "E1 · 250 kb", gm(f"{GM}_250000.compartments-e1.bw"), GM_COLOURS["e1"], 48,
              left=True, bottom=False),
        track("a-ab", "segments", "compartments", gm(f"{GM}_250000.compartments-ab.bed"), GM_COLOURS["ab"], 18,
              left=True, bottom=False),
        track("a-4c", "track", f"4C · {FIG1A_ANCHOR} · O/E", gm(FIG1A_4C), GM_COLOURS["fourc"], 64),
    ]
    in_cell = [
        track("a-ctcf", "track", "CTCF", gm("ENCFF734CUT.bigWig"), GM_COLOURS["ctcf"], 44),
        track("a-motifs", "segments", "CTCF motifs", gm(CTCF_MOTIFS), GM_COLOURS["motifs"], 22),
        track("a-rna-plus", "track", "RNA+", gm("ENCFF990PUN.bigWig"), GM_COLOURS["rna+"], 40, group="rna"),
        track("a-rna-minus", "track", "RNA−", gm("ENCFF005BFP.bigWig"), GM_COLOURS["rna-"], 40, group="rna",
              flip=True),
        track("a-atac", "track", "ATAC", gm("ENCFF487LOB.bigWig"), GM_COLOURS["atac"], 44),
        track("a-atac-peaks", "segments", "ATAC peaks", gm("ENCFF928SQL.bigBed"), GM_COLOURS["atac"], 18),
        track("a-genes", "gtf", "hg38.refGene", gm("hg38.refGene.txt.gz"), GM_COLOURS["genes"], 56, primary=True),
        track("a-sequence", "sequence", "hg38.2bit", gm("hg38.2bit"), GM_COLOURS["sequence"], 40),
    ]
    lanes = [on(t, tracks_cell(0)) for t in in_cell]
    model = track("a-model", "structure", f"pastis-NB · {FIG1A_REGION}", gm(FIG1A_MODEL), GM_COLOURS["model"], 24,
                  card="structure", bottom=False,
                  structure={"beads": False, "sticks": True, "tube": False, "colourBy": "distance", "pin": FIG1A_PIN,
                             "colormap": "default"})
    state = {"uri": f"{GM_MAP}::resolutions/2000", "maps": "tracks|3d", "view": "region",
             "region": machine(FIG1A_REGION), **MAP_LOOK, "vmin": -4, "vmax": -2.2}
    return tab("Fig. 1a · GM12878, chr14:88.55–90.10 Mb at 2 kb: the map, its tracks and its model", state,
               on_map + in_cell + [model], lanes=lanes, deck={"columns": 3}, groups={"rna": "stacked"},
               scaling={"rna": "shared"}, circular=[], manual=FIG1A_MARKS, mapNames=GM_NAMES)


#: Where Fig. 2's tab opens: Fig. 1a's window and the domains either side of it, at 10 kb.
FIG2_REGION = "chr14:86,000,001-93,000,000"


def paper_fig2() -> dict:
    """GM12878 at 10 kb with what Fig. 2 aggregates at CTCF's sites: two labs' CTCF, the peaks the app
    called on the two, the insulation at four scales and ATAC-seq — and each peak paired with the next,
    loaded and not drawn, for APA to pile up (*every pair of a feature set* pairs every peak within a
    range; *consecutive* is this set)."""
    tracks = [
        track("b-ctcf-broad", "track", "CTCF · Broad", gm("ENCFF734CUT.bigWig"), GM_COLOURS["ctcf"], 44),
        track("b-ctcf-stanford", "track", "CTCF · Stanford", gm("ENCFF485CGE.bigWig"), GM_COLOURS["ctcf2"], 44),
        track("b-peaks", "segments", "CTCF peaks · IDR ≤ 0.05", gm(GM_PEAKS), GM_COLOURS["peaks"], 18),
        *[track(f"b-insulation-w{w}", "track", f"insulation · {w * 10} kb", gm(f"{GM}_10000.insulation-w{w}.bw"),
                GM_COLOURS["insulation"], 36, group="insulation") for w in (40, 20, 10, 5)],
        # The widest window on top, as the app stacks a run of four scales: a border that survives every
        # scale reads as a column down the stack, ending on the borders called on the narrowest.
        track("b-borders", "segments", "borders · 50 kb", gm(f"{GM}_10000.borders.bed"), GM_COLOURS["insulation"], 18),
        track("b-atac", "track", "ATAC", gm("ENCFF487LOB.bigWig"), GM_COLOURS["atac"], 44),
        track("b-pairs", "pairs", "consecutive CTCF peaks", gm(GM_PAIRS), "#000000", 16, card="overlay",
              visible=False),
    ]
    state = {"uri": f"{GM_MAP}::resolutions/10000", "view": "region", "region": machine(FIG2_REGION), **MAP_LOOK}
    return tab("Fig. 2 · CTCF sites in GM12878: two labs’ CTCF, the peaks called on both, insulation at four "
               "scales and ATAC", state, tracks, groups={"insulation": "stacked"}, scaling={"insulation": "each"},
               circular=[], mapNames=GM_NAMES)


def chromosomix_paper() -> dict:
    return workspace(paper_fig1a(), paper_fig1c(), paper_fig1d(), paper_fig2(), paper_figS3a(), paper_figS3b(),
                     paper_figS3c())


#: path under demo/store/ → the workspace written there
WORKSPACES = {
    "yeast/Yeast_microC.chromosomix.json": yeast_microc,
    "yeast/Yeast_landscape.chromosomix.json": yeast_landscape,
    "yeast/Yeast_HiC_microC_PCP.chromosomix.json": yeast_deck,
    "human/Human_chrX_splicing.chromosomix.json": human,
    "gibcus2018/Gibcus2018_mitosis.chromosomix.json": gibcus,
    "meneu2025/Meneu2025_bacterial_chromosomes.chromosomix.json": meneu,
    PAPER + "Chromosomix_paper.chromosomix.json": chromosomix_paper,
}


def named_files(path: str, ws: dict) -> set[str]:
    """Every file a workspace names, as its path under demo/store/."""
    import posixpath
    folder = posixpath.dirname(path)
    out = set()
    for t in ws["tabs"]:
        uris = [t["state"]["uri"], *[m for m in t["state"].get("maps", "").split("|") if m and m not in ("3d", "tracks")]]
        # A lane on a tracks cell is kept under the cell's seat, `tracks:1`, which is not a file.
        uris += [e["source"]["url"] for e in t["tracks"]] + [lane["uri"] for lane in t.get("lanes", [])
                                                             if not lane["uri"].startswith("tracks:")]
        for u in uris:
            out.add(posixpath.normpath(posixpath.join(folder, u.split("::")[0])))
    return out


def write_workspaces() -> None:
    import posixpath
    listed = {dest for dest, _, _ in FILES}
    for path, build in WORKSPACES.items():
        ws = build()
        missing = named_files(path, ws) - listed
        if missing:
            raise SystemExit(f"{path} names files the store does not list: {sorted(missing)}")
        out = STORE / path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(ws, indent=2, ensure_ascii=False) + "\n")
        print("wrote", out.relative_to(ROOT))
    rows = [*FILES, *[(path, repo(f"demo/store/{path}"), "Workspace") for path in WORKSPACES]]
    with (STORE / "MANIFEST.tsv").open("w") as fh:
        fh.write("# Every file of s3://rsglab-data/demo/store/, and where it comes from.\n")
        fh.write("# Written by scripts/make_rsg_store.py; published by scripts/publish-store.sh.\n")
        fh.write("path\tsource\tdescription\n")
        for dest, source, what in rows:
            fh.write(f"{dest}\t{source}\t{what}\n")
    print("wrote", (STORE / "MANIFEST.tsv").relative_to(ROOT), f"({len(rows)} files)")


def stage(out: Path, local: str, work_dir: Path | None) -> None:
    """The workspaces with every name pointed at where its file is today, for a look before publishing."""
    import posixpath
    where = {}
    for dest, source, _ in FILES:
        if source.startswith("s3://rsglab-data/"):
            # Quoted: a key of the bucket's may hold a `^`, which a browser sends as it is.
            where[dest] = BUCKET + quote(source[len("s3://rsglab-data/"):])
        elif source.startswith("s3://4dn-open-data-public/"):
            where[dest] = "https://4dn-open-data-public.s3.amazonaws.com/" + source[len("s3://4dn-open-data-public/"):]
        elif source.startswith("s3://encode-public/"):
            where[dest] = ENCODE + source[len("s3://encode-public/"):]
        elif source.startswith("repo:"):
            where[dest] = local.rstrip("/") + "/" + source[len("repo:"):]
        elif source.startswith("work:"):
            name = source[len("work:"):]
            if work_dir is not None:
                (out / "work").mkdir(parents=True, exist_ok=True)
                shutil.copy2(work_dir / name, out / "work" / name)
            where[dest] = local.rstrip("/") + "/" + str((out / "work" / name).relative_to(ROOT))
    for path, build in WORKSPACES.items():
        ws = build()
        folder = posixpath.dirname(path)
        absolute = lambda u: where[posixpath.normpath(posixpath.join(folder, u.split("::")[0]))] + (  # noqa: E731
            "::" + u.split("::", 1)[1] if "::" in u else "")
        for t in ws["tabs"]:
            st = t["state"]
            st["uri"] = absolute(st["uri"])
            if st.get("maps"):
                st["maps"] = "|".join(m if m in ("3d", "tracks") else absolute(m) for m in st["maps"].split("|"))
            for e in t["tracks"]:
                e["source"]["url"] = absolute(e["source"]["url"])
            for lane in t.get("lanes", []):
                if not lane["uri"].startswith("tracks:"):
                    lane["uri"] = absolute(lane["uri"])
            for look in t.get("deck", {}).get("looks", []):
                look["uri"] = absolute(look["uri"])
            if "mapNames" in t:
                t["mapNames"] = {absolute(k): v for k, v in t["mapNames"].items()}
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(ws, indent=2, ensure_ascii=False) + "\n")
        print("staged", target)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("derive")
    d.add_argument("--work", type=Path, required=True)
    d.add_argument("--steps", help="comma-separated: demo, ucsc, gm12878 (default: every one)")
    d.add_argument("--hg38", type=Path, help="a copy of UCSC's hg38 the app reads by range (a 2bit, or a FASTA "
                   "with its .fai) for GM12878's GC phasing and motif, rather than the 2bit fetched from UCSC")
    sub.add_parser("workspaces")
    st = sub.add_parser("stage")
    st.add_argument("--out", type=Path, required=True, help="a folder the dev server serves")
    st.add_argument("--local", required=True, help="the URL the repository is served at")
    st.add_argument("--work", type=Path, help="derive's work directory, for the files it wrote")
    args = parser.parse_args(argv)
    if args.cmd == "derive":
        derive(args.work, args.steps.split(",") if args.steps else None, args.hg38)
    elif args.cmd == "workspaces":
        write_workspaces()
    else:
        stage(args.out.resolve(), args.local, args.work)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
