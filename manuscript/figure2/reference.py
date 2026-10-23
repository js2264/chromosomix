#!/usr/bin/env python3
"""Fig. 2's reference panels: the app's chain on chr19, each link run by the package it reproduces and
drawn by that package's own plotting.

    YAPC_PYTHON=yapc-env/bin/python refs/bin/python manuscript/figure2/reference.py

The environments are the validation notebook's (notebooks/validation.qmd, *To render*): `refs` with
cooler, cooltools, coolpuppy, deepTools and pyBigWig, and yapc's own. Everything is chr19 of GM12878,
as the store's Fig. 2 tab runs it in the app (`manuscript/figure2/chromosomix_panels.mjs`):

1. insulation — `cooltools.insulation` with windows of 50, 100, 200 and 400 kb on the map's 10-kb rung,
   § 1's settings (notebooks/scripts/cooltools_insulation_scales.py), each window's log2 score a bigWig;
2. peaks — yapc 0.1 with IDR 2.0.3 on CTCF Broad and CTCF Stanford as the two replicates, § 5's
   settings and seed 0, the peaks at IDR ≤ 0.05;
3. APA — each of those peaks with the next along chr19, piled up by `coolpuppy.coolpup.pileup` on the
   2-kb rung, ±20 kb (ten bins), `mindist='auto'` (22 bins), each window over cooltools'
   `expected_cis`, and drawn by `coolpuppy.plotpup.plot`;
4. metaplots — deepTools' `computeMatrix reference-point --referencePoint center` on those peaks, of
   both CTCF tracks and ATAC-seq ±2 kb in 50-bp bins and of the four insulation tracks ±500 kb in 10-kb
   bins, drawn by `plotProfile --perGroup --plotType se` (the mean with its standard error: deepTools
   has no bootstrap) and `plotHeatmap`, its regions sorted as it sorts them by default and its heatmaps
   without the profile it can draw over them, which is the panel beside.

Each tool draws its own figure; what is set to the app's is only what makes two pictures readable
side by side — the colour map and its range (RdBu_r symmetric about 1 for the pile-up, viridis from 0
to the 99th percentile for a heatmap, symmetric about 0 for a signed one, by the app's own rules) and
the curves' colours, the app's palette in the app's order. The figures are written to manuscript/figure2/reference/, with the numbers they
draw in numbers.tsv; the inputs and the tools' working files to manuscript/figure2/build/.

coolpuppy's plotting, and cooltools' colour maps it imports, call `matplotlib.cm.register_cmap` and
`matplotlib.cm.get_cmap`, both gone since matplotlib 3.9: the two are put back below, before the
import, as the colormap registry they were spelled for, and nothing else of either package is touched.
"""

from __future__ import annotations

import hashlib
import math
import os
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

import matplotlib

matplotlib.use("Agg")
import matplotlib.cm  # noqa: E402
import matplotlib.colors  # noqa: E402

matplotlib.cm.register_cmap = lambda name, cmap: matplotlib.colormaps.register(cmap, name=name, force=True)
matplotlib.cm.get_cmap = lambda name=None, lut=None: (
    name if isinstance(name, matplotlib.colors.Colormap)
    else matplotlib.colormaps[name] if lut is None else matplotlib.colormaps[name].resampled(lut))

import cooler  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pyBigWig  # noqa: E402
from coolpuppy import coolpup, plotpup  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from make_rsg_store import GM, GM_ENCODE  # noqa: E402  — the store's names, said once

BUILD = HERE / "build"
DATA, RUNS = BUILD / "data", BUILD / "runs"
OUT = HERE / "reference"
SCRIPTS = ROOT / "notebooks" / "scripts"
MANIFEST = ROOT / "demo" / "store" / "MANIFEST.tsv"
PAPER = "chromosomix_paper/"
PYTHON = sys.executable
#: deepTools' commands, from the same environment as this interpreter.
BIN = Path(sys.executable).parent
YAPC_PYTHON = Path(os.environ.get("YAPC_PYTHON", ROOT / "yapc-env" / "bin" / "python"))
THREADS = int(os.environ.get("THREADS", "4"))

SEQUENCE = "chr19"
#: The pile-up: ten 2-kb bins either side, coolpuppy's floor for that window (2 × 10 + 2 bins).
RES, HALF = 2000, 10
WINDOWS = [50_000, 100_000, 200_000, 400_000]
#: The app's chart palette (`CATEGORY_PALETTE`, src/render/meta.ts), in the order it hands it out: the
#: curves of one metaplot are its first colours in the order of the tracks.
PALETTE = ["#0072b2", "#d55e00", "#009e73", "#cc79a7"]
#: The app's names for the tracks, in ASCII and in one word: deepTools decodes its matrix's header as
#: ASCII, and breaks a label at its spaces.
SIGNAL = [("ENCFF734CUT", "CTCF-Broad"), ("ENCFF485CGE", "CTCF-Stanford"), ("ENCFF487LOB", "ATAC")]
#: § 5's settings, which the app's recipe takes too.
YAPC = ["--smoothing-window-width", "150", "--smoothing-times", "3", "--min-concave-region-width", "75",
        "--truncate-idr-input", "100000"]


def shown(argv) -> str:
    return " ".join(shlex.quote(str(a).replace(str(ROOT) + "/", "")) for a in argv)


def call(argv, env=None) -> None:
    print("$", shown(argv), flush=True)
    subprocess.run([str(a) for a in argv], check=True, env=env)


# --------------------------------------------------------------------------- the inputs


def sources() -> dict[str, str]:
    rows = {}
    for line in MANIFEST.read_text().splitlines():
        if line.startswith("#") or line.startswith("path\t") or not line.strip():
            continue
        path, source, _ = line.split("\t", 2)
        rows[path] = source
    return rows


def address(source: str) -> str:
    bucket, key = source[len("s3://"):].split("/", 1)
    return f"https://{bucket}.s3.amazonaws.com/{quote(key)}"


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 24), b""):
            digest.update(block)
    return digest.hexdigest()


def encode(accession: str) -> Path:
    """One of ENCODE's GM12878 bigWigs, read once and held to its MD5."""
    target = DATA / "human" / f"{accession}.bigWig"
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    url = address(sources()[PAPER + f"human/{accession}.bigWig"])
    partial = target.with_name(target.name + ".part")
    print(f"fetching {url}", flush=True)
    with urllib.request.urlopen(url) as response, open(partial, "wb") as handle:
        shutil.copyfileobj(response, handle)
    if md5(partial) != GM_ENCODE[accession][1]:
        raise SystemExit(f"{url}: not ENCODE's {accession}, its MD5 differs")
    partial.rename(target)
    return target


def chr19(source: Path) -> Path:
    """The track with chr19 only, interval for interval (validation.qmd § 24's cut)."""
    target = DATA / f"{source.name.split('.')[0]}.{SEQUENCE}.bw"
    if target.exists():
        return target
    handle = pyBigWig.open(str(source))
    out = pyBigWig.open(str(target), "w")
    out.addHeader([(SEQUENCE, handle.chroms()[SEQUENCE])])
    entries = handle.intervals(SEQUENCE) or ()
    out.addEntries([SEQUENCE] * len(entries), [int(a) for a, _, _ in entries], ends=[int(b) for _, b, _ in entries],
                   values=[float(v) for _, _, v in entries])
    out.close()
    handle.close()
    return target


def rung(resolution: int) -> Path:
    """chr19 of the map at one resolution, every contact within it, read by range from 4DN's bucket."""
    target = DATA / f"{GM}_{resolution}.{SEQUENCE}.cool"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".part")
        call([PYTHON, SCRIPTS / "cool_subset.py", address(sources()[PAPER + f"human/{GM}.mcool"]), resolution, partial,
              "--sequences", SEQUENCE])
        partial.rename(target)
    return target


# --------------------------------------------------------------------------- the app's colour rules


def clip_of(values: np.ndarray) -> tuple[float, float]:
    """`clipOf` (src/analysis/run/metaplot.ts): 0 to the 99th percentile, or symmetric about 0 over the
    1st and 99th for a signed track, from a sample of at most 100,000 cells in order."""
    flat = values.ravel()
    stride = max(1, len(flat) // 100_000)
    sample = np.sort(flat[::stride][np.isfinite(flat[::stride])])
    at = lambda p: sample[min(len(sample) - 1, int(math.floor(p * (len(sample) - 1))))]  # noqa: E731
    if sample[0] >= 0:
        return 0.0, float(at(0.99))
    top = max(abs(at(0.01)), abs(at(0.99)))
    return -float(top), float(top)


def p2ll(pileup: np.ndarray) -> float:
    """The app's P2LL, as validation.qmd computes it: the centre over the lower-left corner."""
    quadrant = max(1, min(pileup.shape) // 5)
    half, centre = quadrant // 2, pileup.shape[0] // 2
    return float(np.nanmean(pileup[centre - half:centre + half + 1, centre - half:centre + half + 1])
                 / np.nanmean(pileup[-quadrant:, :quadrant]))


# --------------------------------------------------------------------------- the chain


def insulation(cool10: Path) -> list[Path]:
    """cooltools' insulation at the four windows, each window's log2 score as a bigWig."""
    table_path = RUNS / "insulation" / "cooltools.tsv"
    if not table_path.exists():
        table_path.parent.mkdir(parents=True, exist_ok=True)
        call([PYTHON, SCRIPTS / "cooltools_insulation_scales.py", cool10, table_path, THREADS, *WINDOWS])
    table = pd.read_csv(table_path, sep="\t")
    length = int(cooler.Cooler(str(cool10)).chromsizes[SEQUENCE])
    out = []
    for window in WINDOWS:
        target = RUNS / "insulation" / f"insulation-{window // 1000}kb.bw"
        if not target.exists():
            rows = table[table["chrom"] == SEQUENCE]
            keep = np.isfinite(rows[f"log2_insulation_score_{window}"].to_numpy(float))
            rows = rows[keep]
            handle = pyBigWig.open(str(target), "w")
            handle.addHeader([(SEQUENCE, length)])
            handle.addEntries([SEQUENCE] * len(rows), rows["start"].astype(int).tolist(),
                              ends=rows["end"].astype(int).tolist(),
                              values=rows[f"log2_insulation_score_{window}"].astype(float).tolist())
            handle.close()
        out.append(target)
    return out


def peaks(broad: Path, stanford: Path) -> Path:
    """yapc on the two labs' CTCF as replicates, the peaks at IDR ≤ 0.05, as a BED of three columns."""
    folder = RUNS / "yapc"
    called = folder / "yapc_0.05.bed"
    if not called.exists():
        folder.mkdir(parents=True, exist_ok=True)
        environment = {**os.environ, "PATH": f"{YAPC_PYTHON.parent}{os.pathsep}{os.environ['PATH']}"}
        call([YAPC_PYTHON, SCRIPTS / "yapc_idr.py", 0, folder / "yapc", "cond", broad, stanford, *YAPC], env=environment)
    target = folder / "peaks.bed"
    table = pd.read_csv(called, sep="\t", header=None, comment="#", usecols=[0, 1, 2], names=["chrom", "start", "end"])
    table.sort_values(["chrom", "start", "end"]).to_csv(target, sep="\t", header=False, index=False)
    return target


def consecutive(peaks_bed: Path) -> Path:
    """Each peak with the next along its sequence, in the order of their centres."""
    table = pd.read_csv(peaks_bed, sep="\t", header=None, names=["chrom", "start", "end"])
    table = table.assign(centre=(table["start"] + table["end"]) / 2).sort_values(["chrom", "centre"])
    following = table.shift(-1)
    same = table["chrom"] == following["chrom"]
    pairs = pd.DataFrame({"chrom1": table["chrom"], "start1": table["start"], "end1": table["end"],
                          "chrom2": following["chrom"], "start2": following["start"], "end2": following["end"]})[same]
    target = RUNS / "apa" / "consecutive.bedpe"
    target.parent.mkdir(parents=True, exist_ok=True)
    pairs.astype({"start2": int, "end2": int}).to_csv(target, sep="\t", header=False, index=False)
    return target


def apa(cool2: Path, pairs_bedpe: Path, numbers: list) -> None:
    folder = RUNS / "apa"
    expected = folder / "expected.tsv"
    if not expected.exists():
        call([PYTHON, SCRIPTS / "cooltools_expected_cis.py", cool2, expected, THREADS])
    features = pd.read_csv(pairs_bedpe, sep="\t", header=None, names=["chrom1", "start1", "end1", "chrom2", "start2", "end2"])
    print(f"coolpup.pileup({cool2.name}, {pairs_bedpe.name}, features_format='bedpe', flank={HALF * RES}, "
          f"min_diag=2, mindist='auto', expected_df=expected.tsv, ooe=True)", flush=True)
    pup = coolpup.pileup(cooler.Cooler(str(cool2)), features, features_format="bedpe", flank=HALF * RES, min_diag=2,
                         expected_df=pd.read_csv(expected, sep="\t"), ooe=True, nproc=THREADS)
    matrix = np.asarray(pup["data"].iloc[0], dtype=float)
    np.savetxt(OUT / "apa.tsv", matrix, delimiter="\t", fmt="%.10g")
    finite = matrix[np.isfinite(matrix)]
    half = max(abs(finite.max() - 1), abs(finite.min() - 1))
    grid = plotpup.plot(pup, score=False, cmap="RdBu_r", scale="linear", vmin=1 - half, vmax=1 + half, height=3,
                        plot_ticks=True, font_scale=0.6)
    grid.savefig(OUT / "apa.pdf")
    numbers += [("APA: consecutive pairs on chr19", f"{len(features):,}"),
                ("APA: pairs piled up (coolpuppy's n)", f"{int(pup['n'].iloc[0]):,}"),
                ("APA: centre pixel, observed / expected", f"{matrix[HALF, HALF]:.3f}"),
                ("APA: P2LL, the app's formula", f"{p2ll(matrix):.3f}"),
                ("APA: colour scale", f"{1 - half:.3f} to {1 + half:.3f}")]


def metaplot(name: str, tracks: list[Path], labels: list[str], colours: list[str], peaks_bed: Path, flank: int, step: int,
             ylabel: str, numbers: list) -> None:
    folder = RUNS / name
    folder.mkdir(parents=True, exist_ok=True)
    matrix_path = folder / "matrix.gz"
    if not matrix_path.exists():
        call([BIN / "computeMatrix", "reference-point", "--referencePoint", "center", "-S", *tracks, "-R", peaks_bed,
              "-b", flank, "-a", flank, "--binSize", step, "--samplesLabel", *labels, "-p", THREADS, "-o", matrix_path])
    values = pd.read_csv(matrix_path, sep="\t", header=None, skiprows=1).iloc[:, 6:].to_numpy(float)
    columns = 2 * flank // step
    ranges = [clip_of(values[:, i * columns:(i + 1) * columns]) for i in range(len(tracks))]
    call([BIN / "plotProfile", "-m", matrix_path, "-out", OUT / f"{name}-profile.pdf", "--perGroup", "--plotType", "se",
          "--colors", *colours, "--refPointLabel", "0", "--yAxisLabel", ylabel, "--regionsLabel", "CTCF-peaks", "--plotHeight", "6", "--plotWidth", "10", "--legendLocation", "upper-right"])
    call([BIN / "plotHeatmap", "-m", matrix_path, "-out", OUT / f"{name}-heatmap.pdf", "--colorMap", "viridis",
          "--zMin", *[f"{lo:.6g}" for lo, _ in ranges], "--zMax", *[f"{hi:.6g}" for _, hi in ranges],
          "--refPointLabel", "0", "--heatmapHeight", "2.6", "--heatmapWidth", "4.4", "--regionsLabel", "CTCF-peaks",
          "--xAxisLabel", "", "--whatToShow", "heatmap and colorbar"])
    with np.errstate(invalid="ignore"):
        profile = np.nanmean(values, axis=0)
    for i, label in enumerate(labels):
        block = profile[i * columns:(i + 1) * columns]
        at = int(np.nanargmax(np.abs(block - np.nanmedian(block))))
        numbers.append((f"{name}: {label}, its extreme column, mean", f"{block[at]:.4g}"))
        numbers.append((f"{name}: {label}, heatmap scale", f"{ranges[i][0]:.4g} to {ranges[i][1]:.4g}"))
    numbers.append((f"{name}: regions", f"{len(values):,}"))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    numbers: list[tuple[str, str]] = []
    cool10, cool2 = rung(10_000), rung(RES)
    tracks = {accession: chr19(encode(accession)) for accession, _ in SIGNAL}
    insulated = insulation(cool10)
    called = peaks(tracks["ENCFF734CUT"], tracks["ENCFF485CGE"])
    numbers.append(("peaks at IDR ≤ 0.05 (yapc 0.1, seed 0)", f"{sum(1 for _ in open(called)):,}"))
    apa(cool2, consecutive(called), numbers)
    metaplot("metaplot-signal", [tracks[a] for a, _ in SIGNAL], [label for _, label in SIGNAL], PALETTE[:3], called,
             2000, 50, "fold change", numbers)
    # The widest window first, as the app lists a run of four scales.
    metaplot("metaplot-insulation", insulated[::-1], [f"{w // 1000}kb" for w in WINDOWS[::-1]], PALETTE, called,
             500_000, 10_000, "insulation (log2)", numbers)
    (OUT / "numbers.tsv").write_text("".join(f"{k}\t{v}\n" for k, v in [("quantity", "value"), *numbers]))
    print("wrote", ", ".join(sorted(p.name for p in OUT.iterdir())))


if __name__ == "__main__":
    main()
