#!/usr/bin/env python3
"""The RSG lab's data store: the files its cards are made of, and the workspaces that open them.

    python3 scripts/make_rsg_store.py derive --work DIR    # the files the store computes (needs pysam)
    python3 scripts/make_rsg_store.py workspaces           # demo/store/**/*.metacooler.json and MANIFEST.tsv
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

Nothing here invents data. `derive` reshapes six files and calls loops on one map (it needs pysam,
numpy and `hictkpy[pyarrow]`, and `npm run build:cli` for the loops):

- ``Yeast_RNAseq.barChart`` — the counts table in `demo/store/yeastRNAseq_counts.txt`, as counts
  per million per sample, one chart per gene at the gene's coordinates in `S288c.gtf` (§8.17).
- ``Yeast_snps.vcf.gz`` and its ``.tbi`` — `Yeast_snps.vcf`, bgzipped and indexed, so a reader
  fetches one chromosome of its 162,311 records rather than 108 MB (§8.11).
- ``mm10_genes.gtf.gz`` and its ``.tbi`` — iGenomes' UCSC mm10 `genes.gtf`, sorted, bgzipped and
  indexed, for the Chromlens card's map of a 2.7-Gb genome.
- ``Yeast_microC_loops.bedpe`` — loops called on the micro-C map the card opens, with this app's
  own Chromosight port (`metacooler-run chromosight`), replacing the calls the old demo carried,
  which were made on a map with a synthetic chromosome XIII.
- ``S288c.2bit`` — `S288c.fa` at two bits a base, and ``GSE151553_A364_merged.hic`` — the micro-C
  map's counts as a Juicer .hic: the two files the paste box's hub example names (`exampleHubText`),
  which an assembly hub can only name in these formats.
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

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "demo" / "store"
BUCKET = "https://rsglab-data.s3.eu-west-3.amazonaws.com/"
FOURDN = "https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/"
IGENOMES = "https://ngi-igenomes.s3.amazonaws.com/igenomes/Mus_musculus/UCSC/mm10/"

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
    cli = ROOT / "dist-cli" / "metacooler-run.mjs"
    if not cli.exists():
        raise SystemExit("npm run build:cli first: the loops are called with metacooler-run")
    dest = work / "loops"
    shutil.rmtree(dest, ignore_errors=True)
    subprocess.run(["node", str(cli), "chromosight", f"{mcool}::resolutions/{resolution}",
                    "--pattern", "loops", "--out", str(dest), "--quiet"], check=True)
    bedpe = next(dest.glob("*patterns.bedpe"))
    lines = [l for l in bedpe.read_text().splitlines() if l and not l.startswith("#")]
    out.write_text(
        f"# Loops called on GSE151553_A364_merged.mcool at {resolution} bp with metacooler-run chromosight\n"
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


def derive(work: Path) -> None:
    work.mkdir(parents=True, exist_ok=True)
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


def repo(path: str) -> str:
    """A file of this repository."""
    return f"repo:{path}"


def work(name: str) -> str:
    """A file `derive` wrote into its work directory."""
    return f"work:{name}"


MENEU = "public-data/2025_Meneu_et_al/"
CHICKEN = "demo/chicken/"
FIG1 = "manuscript/figure1/results/"

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
    # -- Chromlens, Fig. 1: 4DN's mouse ES-cell Hi-C and ChIP-seq, and what the app computed on them
    ("chromlens_fig1/4DNFI5QJNFAT.mcool", fourdn("ef0eba47-ada0-42bc-9329-5145b57ff33a", "4DNFI5QJNFAT.mcool"),
     "In situ Hi-C, F123 mouse ES cells (Kubo et al. 2021)"),
    ("chromlens_fig1/4DNFIFFXFV82.bw", fourdn("6dd5c984-eccf-4d2d-8118-38ea2a4d30fb", "4DNFIFFXFV82.bw"),
     "CTCF ChIP-seq (Huang et al. 2021)"),
    ("chromlens_fig1/4DNFIXE23VC7.bw", fourdn("8ee59614-5b5f-4c8b-a29e-86d0c8047c30", "4DNFIXE23VC7.bw"),
     "H3K27ac ChIP-seq (Huang et al. 2021)"),
    ("chromlens_fig1/4DNFIQYJLKKH.bw", fourdn("f1ae271a-971a-4611-a6d0-fd971f1e693f", "4DNFIQYJLKKH.bw"),
     "H3K4me3 ChIP-seq (Huang et al. 2021)"),
    ("chromlens_fig1/mm10_genes.gtf.gz", work("mm10_genes.gtf.gz"), "Genes, UCSC mm10 (iGenomes), bgzipped"),
    ("chromlens_fig1/mm10_genes.gtf.gz.tbi", work("mm10_genes.gtf.gz.tbi"), "…and its tabix index"),
    ("chromlens_fig1/4DNFI5QJNFAT_10000.insulation-w10.bw",
     repo(FIG1 + "insulation/4DNFI5QJNFAT_10000.insulation.insulation-w10.bw"),
     "Diamond insulation at 10 kb, computed by the app (Fig. 1d)"),
    ("chromlens_fig1/4DNFI5QJNFAT_5000.Sox2-locus.bed3d",
     repo(FIG1 + "model-locus/4DNFI5QJNFAT_5000.reconstruct3d.reconstructed-model.bed3d"),
     "pastis-NB model of chr3:34.2–35.2 Mb at 5 kb, computed by the app (Fig. 1c)"),
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
          card: str = "linear", bottom: bool = True, right: bool = False, primary: bool = False,
          **style) -> dict:
    """One `StoredEntry`, written in full: `readTab` fills nothing in for a track."""
    base = {"colour": colour, "size": size, "mode": "line" if kind == "sequence" else "area",
            "limits": {"auto": kind != "sequence", "min": 0, "max": 1}, "group": "", "shape": "element",
            "radius": 7, "opacity": 0.9 if kind == "pairs" else 1, "flip": False}
    entry = {"id": tid, "card": card, "kind": kind, "label": label,
             "source": {"kind": "remote", "name": url.rsplit("/", 1)[-1], "url": url},
             "visible": True, "placement": edges(bottom=bottom, right=right), "style": {**base, **style}}
    if primary:
        entry["primary"] = True
    return entry


def edges(*, bottom: bool = False, right: bool = False) -> dict:
    """A placement with all four edges said, as the app writes one."""
    return {"top": False, "right": right, "bottom": bottom, "left": False}


def limits(lo: float, hi: float) -> dict:
    return {"auto": False, "min": lo, "max": hi}


def tab(name: str, state: dict, tracks: list[dict], *, sequences=(), plot=PLOT_MAP, **extra) -> dict:
    return {"version": 1, "createdAt": CREATED, "name": name, "state": state, "tracks": tracks, "manual": [],
            "sequences": list(sequences), "groups": extra.pop("groups", {}), "scaling": extra.pop("scaling", {}),
            "compareNormalise": False, "tables": {}, "plot": plot, **extra}


def workspace(*tabs: dict) -> dict:
    return {"kind": "metacooler.workspace", "version": 1, "createdAt": CREATED, "active": 0, "tabs": list(tabs)}


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
    src = json.loads((ROOT / "demo" / "human" / "Human_chrX_RNA.metacooler.json").read_text())
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


def chromlens() -> dict:
    tracks = [
        track("fig1-genes", "gtf", "genes", "mm10_genes.gtf.gz", COLOURS["genes"], 62, right=True, primary=True),
        track("fig1-ctcf", "track", "CTCF", "4DNFIFFXFV82.bw", "#e69f00", 60),
        track("fig1-h3k27ac", "track", "H3K27ac", "4DNFIXE23VC7.bw", "#009e73", 60),
        track("fig1-h3k4me3", "track", "H3K4me3", "4DNFIQYJLKKH.bw", "#56789a", 60, bottom=False, right=True),
        track("fig1-insulation", "track", "insulation · 100 kb", "4DNFI5QJNFAT_10000.insulation-w10.bw",
              "#0072b2", 50),
        track("fig1-model", "structure", "model · Sox2 locus, 5 kb", "4DNFI5QJNFAT_5000.Sox2-locus.bed3d",
              "#cc79a7", 24, card="structure", bottom=False,
              structure={"colourBy": "track:fig1-h3k27ac"}),
    ]
    state = {"uri": "4DNFI5QJNFAT.mcool::resolutions/5000", "maps": "3d", "view": "region",
             "region": "chr3:34200001-35200000", "level": "bin", "balance": True, "transform": "log10",
             "colormap": "default"}
    return workspace(tab("Chromlens, Fig. 1", state, tracks, deck={"columns": 2},
                         mapNames={"4DNFI5QJNFAT.mcool": "Hi-C · mouse ES cells (4DN)"}))


#: path under demo/store/ → the workspace written there
WORKSPACES = {
    "yeast/Yeast_microC.metacooler.json": yeast_microc,
    "yeast/Yeast_landscape.metacooler.json": yeast_landscape,
    "yeast/Yeast_HiC_microC_PCP.metacooler.json": yeast_deck,
    "human/Human_chrX_splicing.metacooler.json": human,
    "gibcus2018/Gibcus2018_mitosis.metacooler.json": gibcus,
    "meneu2025/Meneu2025_bacterial_chromosomes.metacooler.json": meneu,
    "chromlens_fig1/Chromlens_fig1.metacooler.json": chromlens,
}


def named_files(path: str, ws: dict) -> set[str]:
    """Every file a workspace names, as its path under demo/store/."""
    import posixpath
    folder = posixpath.dirname(path)
    out = set()
    for t in ws["tabs"]:
        uris = [t["state"]["uri"], *[m for m in t["state"].get("maps", "").split("|") if m and m not in ("3d", "tracks")]]
        uris += [e["source"]["url"] for e in t["tracks"]] + [lane["uri"] for lane in t.get("lanes", [])]
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
            where[dest] = BUCKET + source[len("s3://rsglab-data/"):]
        elif source.startswith("s3://4dn-open-data-public/"):
            where[dest] = "https://4dn-open-data-public.s3.amazonaws.com/" + source[len("s3://4dn-open-data-public/"):]
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
    sub.add_parser("workspaces")
    st = sub.add_parser("stage")
    st.add_argument("--out", type=Path, required=True, help="a folder the dev server serves")
    st.add_argument("--local", required=True, help="the URL the repository is served at")
    st.add_argument("--work", type=Path, help="derive's work directory, for the files it wrote")
    args = parser.parse_args(argv)
    if args.cmd == "derive":
        derive(args.work)
    elif args.cmd == "workspaces":
        write_workspaces()
    else:
        stage(args.out.resolve(), args.local, args.work)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
