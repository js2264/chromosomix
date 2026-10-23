#!/usr/bin/env python3
"""Fig. 2 of the Chromosomix paper: CTCF's sites in GM12878, piled up on the map and averaged along tracks.

    npm run build:cli                                  # the chromosomix command every analysis runs on
    python -m pip install numpy matplotlib h5py cooler pandas requests
    python manuscript/figure2/make_figure.py           # figure2.pdf, figure2.svg, figure2.png and numbers.tsv

The data are the paper store's GM12878 files (`demo/store/chromosomix_paper/human/`, listed in
`demo/store/MANIFEST.tsv`, the store's tab *Fig. 2*): 4DN's in situ Hi-C of Rao et al. 2014
(4DNFIXP4QG5B, 4.0 billion contacts), ENCODE's CTCF ChIP-seq of two labs and ATAC-seq as fold change
over control, the CTCF peaks the app's yapc called on the two ChIP-seq replicates (IDR ≤ 0.05), each
peak paired with the next along its sequence, and the map's diamond insulation at four windows.

Everything drawn is the `chromosomix` command's output, run here and kept in build/runs/:

a  APA between consecutive CTCF peaks on the map at 2 kb, ±10 bins, observed over expected — every
   pair 22 bins (44 kb, coolpuppy's floor for this window) to 1 Mb apart on chr1–22 and X.
b  The metaplot of both CTCF replicates and ATAC-seq about the peaks' centres, ±2 kb in 50-bp
   columns: the mean with its bootstrap band, and every peak's row, strongest first over the three.
c  The same about the same peaks for the insulation at its four windows, ±500 kb in 10-kb columns.

The map is the 27-GB file's 2-kb rung near the diagonal, read once by range into build/data/
(`notebooks/scripts/cool_subset.py`, about 6 GB read): every contact of chr1–22 and X within 1.05 Mb
of the diagonal, which is every one the pile-up and its expected read. The other inputs are read once
into build/data/ from the store's folder on the lab's bucket or from where the manifest says they come
from. Colours are the app's: RdBu_r centred on 1 for a pile-up over its expected, symmetric about it
over the furthest cell; viridis for a heatmap, from 0 to its 99th percentile, or symmetric about 0 over
its 1st and 99th for a signed track — `matrixScale` and `clipOf` (src/figures/matrixOption.ts,
src/analysis/run/metaplot.ts).

The page is 180 mm wide; type is Helvetica/Arial (Liberation Sans where neither is installed),
5–7 pt, panel letters 8 pt bold. The heatmaps are images, everything else is vector.
"""

from __future__ import annotations

import hashlib
import math
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import warnings
from pathlib import Path
from urllib.parse import quote

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, to_rgb  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from make_rsg_store import GM, GM_COLOURS, GM_ENCODE  # noqa: E402  — the store's names, said once

BUILD = HERE / "build"
DATA, RUNS = BUILD / "data", BUILD / "runs"
CLI = ROOT / "dist-cli" / "chromosomix.mjs"
SUBSET = ROOT / "notebooks" / "scripts" / "cool_subset.py"
MANIFEST = ROOT / "demo" / "store" / "MANIFEST.tsv"
BUCKET = "https://rsglab-data.s3.eu-west-3.amazonaws.com/"
PAPER = "chromosomix_paper/"

CHROMS = [f"chr{i}" for i in range(1, 23)] + ["chrX"]
#: The pile-up: the map's 2-kb rung, ten bins either side of each pair.
RES, HALF = 2000, 10
#: coolpuppy's `mindist='auto'` for that window, twice it and two: no window reaches the two diagonals
#: the pile-up leaves out (`autoMinDist`, src/analysis/tasks/apa.ts).
MIN_DIST = 2 * HALF + 2
#: The furthest pair piled up, and how deep a band of the map is read for it and its expected.
MAX_SEP = 1_000_000
BAND = 1_050_000
SIGNAL = [("ENCFF734CUT", "CTCF · Broad", "ENCSR000AKB", GM_COLOURS["ctcf"]),
          ("ENCFF485CGE", "CTCF · Stanford", "ENCSR000DZN", GM_COLOURS["ctcf2"]),
          ("ENCFF487LOB", "ATAC-seq", "ENCSR095QNB", GM_COLOURS["atac"])]
WINDOWS = [5, 10, 20, 40]  # the insulation's windows, in 10-kb bins

# --------------------------------------------------------------------------- style

MM = 1 / 25.4
W, H = 180.0, 100.0
INK, INK2, INK3, RULE = "#1c1e21", "#4b5058", "#80868f", "#d5d9df"
RDBU_R_STOPS = ["#053061", "#2166AC", "#4393C3", "#92C5DE", "#D1E5F0", "#F7F7F7", "#FDDBC7",
                "#F4A582", "#D6604D", "#B2182B", "#67001F"]
RDBU_R = LinearSegmentedColormap.from_list("app-RdBu_r", RDBU_R_STOPS)

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Helvetica", "Arial", "Liberation Sans", "DejaVu Sans"],
    "font.size": 6, "axes.linewidth": 0.4, "axes.edgecolor": INK2, "axes.labelcolor": INK,
    "xtick.color": INK2, "ytick.color": INK2, "xtick.major.width": 0.4, "ytick.major.width": 0.4,
    "xtick.major.size": 1.6, "ytick.major.size": 1.6, "xtick.labelsize": 5, "ytick.labelsize": 5,
    "text.color": INK, "pdf.fonttype": 42, "svg.fonttype": "none",
})

# --------------------------------------------------------------------------- the data


def manifest() -> dict[str, str]:
    """The store's files, each with where it comes from."""
    rows = {}
    for line in MANIFEST.read_text().splitlines():
        if line.startswith("#") or line.startswith("path\t") or not line.strip():
            continue
        path, source, _ = line.split("\t", 2)
        rows[path] = source
    return rows


SOURCES = manifest()


def address(source: str) -> str:
    """An `s3://` source as the public address a browser reads it at."""
    bucket, key = source[len("s3://"):].split("/", 1)
    host = "rsglab-data.s3.eu-west-3.amazonaws.com" if bucket == "rsglab-data" else f"{bucket}.s3.amazonaws.com"
    return f"https://{host}/{quote(key)}"


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 24), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(path: str) -> Path:
    """One file of the paper's folder on this disk, read once; an ENCODE file is held to its MD5."""
    source = SOURCES[PAPER + path]
    if source.startswith("repo:"):
        return ROOT / source[len("repo:"):]
    target = DATA / path
    accession = Path(path).name.split(".")[0]
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".part")
        for url in (f"{BUCKET}demo/store/{PAPER}{quote(path)}", address(source)):
            try:
                with urllib.request.urlopen(url) as response, open(partial, "wb") as handle:
                    shutil.copyfileobj(response, handle)
            except urllib.error.HTTPError as error:
                # Not there: S3 answers 403 rather than 404 for a key it does not hold, to a reader
                # who may not list the bucket.
                if error.code in (403, 404):
                    continue
                raise
            if accession in GM_ENCODE and md5(partial) != GM_ENCODE[accession][1]:
                raise SystemExit(f"{url}: not ENCODE's {accession}, its MD5 differs")
            partial.rename(target)
            print(f"fetched {path} ({target.stat().st_size / 1e6:.1f} MB) from {url}")
            break
        else:
            raise FileNotFoundError(f"{path}: neither the store's folder nor {source} answers")
    return target


def band_map() -> Path:
    """The map's 2-kb rung within BAND of the diagonal, chr1–22 and X, read once by range."""
    target = DATA / f"{GM}_2000.band-{BAND // 1000}kb.cool"
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    url = address(SOURCES[PAPER + f"human/{GM}.mcool"])
    print(f"reading the 2-kb rung of {url} within {BAND:,} bp of the diagonal (about 6 GB, by range)")
    subprocess.run([sys.executable, str(SUBSET), url, str(RES), str(partial), "--sequences", ",".join(CHROMS),
                    "--band", str(BAND)], check=True)
    partial.rename(target)
    return target


def consecutive_pairs() -> Path:
    """Each peak with the next, on chr1–22 and X and at most MAX_SEP apart, centre to centre."""
    target = DATA / f"GM12878_CTCF.consecutive.within-{MAX_SEP // 1000}kb.bedpe"
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    kept = []
    for line in fetch("human/GM12878_CTCF.consecutive.bedpe").read_text().splitlines():
        cells = line.split("\t")
        if line.startswith("#") or cells[0] not in CHROMS:
            continue
        separation = (int(cells[4]) + int(cells[5])) / 2 - (int(cells[1]) + int(cells[2])) / 2
        if separation <= MAX_SEP:
            kept.append("\t".join(cells[:7]))
    target.write_text("".join(f"{row}\n" for row in kept))
    return target


def run(name: str, task: str, *args) -> Path:
    """One `chromosomix` task into build/runs/<name>/, kept: a second render runs nothing again."""
    if not CLI.exists():
        raise SystemExit(f"{CLI} is not there: run `npm run build:cli` at the repository root")
    out = RUNS / name
    if out.is_dir() and any(out.iterdir()):
        return out
    shutil.rmtree(out, ignore_errors=True)
    argv = [str(arg) for arg in args]
    print("$ chromosomix", task, " ".join(shlex.quote(arg.replace(str(ROOT) + "/", "")) for arg in argv))
    done = subprocess.run(["node", str(CLI), task, *argv, "--out", str(out), "--quiet"],
                          capture_output=True, text=True)
    if done.returncode != 0:
        shutil.rmtree(out, ignore_errors=True)
        raise RuntimeError(f"chromosomix {task} failed:\n{done.stderr}")
    return out


def one(directory: Path, pattern: str) -> Path:
    found = sorted(directory.glob(pattern))
    if len(found) != 1:
        raise FileNotFoundError(f"{directory}: {len(found)} files match {pattern}")
    return found[0]


def read_output(path: Path) -> tuple[dict[str, str], list[str], np.ndarray]:
    """A chromosomix table: its `# key: value` lines, its header, and its numbers (the first column too)."""
    notes, header, rows = {}, None, []
    for line in path.read_text().splitlines():
        if line.startswith("#"):
            key, _, value = line[1:].strip().partition(": ")
            notes[key] = value
        elif header is None:
            header = line.split("\t")
        elif line:
            rows.append([float(cell) if cell not in ("", "NaN", "nan") else math.nan for cell in line.split("\t")])
    return notes, header, np.array(rows, float)


# --------------------------------------------------------------------------- the app's arithmetic


def clip_of(values: np.ndarray) -> tuple[float, float]:
    """`clipOf` (src/analysis/run/metaplot.ts): a heatmap's colour range, from a sample of its cells."""
    flat = values.ravel()
    stride = max(1, len(flat) // 100_000)
    sample = np.sort(flat[::stride][np.isfinite(flat[::stride])])
    at = lambda p: sample[min(len(sample) - 1, int(math.floor(p * (len(sample) - 1))))]  # noqa: E731
    hi = at(0.99)
    if sample[0] >= 0:
        return 0.0, float(hi)
    top = max(abs(at(0.01)), abs(hi))
    return -float(top), float(top)


def centred_scale(values: np.ndarray, centre: float = 1.0) -> tuple[float, float]:
    """`matrixScale` with a centre: symmetric about it, over the furthest cell."""
    finite = values[np.isfinite(values)]
    half = max(abs(finite.max() - centre), abs(finite.min() - centre)) or 1.0
    return centre - half, centre + half


def pooled(rows: np.ndarray, lines: int) -> tuple[np.ndarray, int]:
    """A heatmap's rows as a picture `lines` high draws them: each run of k rows, in order, as their mean."""
    k = max(1, math.ceil(len(rows) / lines))
    out = np.full((math.ceil(len(rows) / k), rows.shape[1]), np.nan)
    # A column with no value in a run is NaN, which is what is drawn: nanmean need not say so.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        for i in range(out.shape[0]):
            out[i] = np.nanmean(rows[i * k:(i + 1) * k], axis=0)
    return out, k


def shade(colour: str, t: float) -> tuple[float, float, float]:
    """`colour` toward white for t < 0 and toward the page's ink for t > 0: the longer the window, the
    darker its line."""
    a = np.array(to_rgb(colour))
    b = np.array(to_rgb("#ffffff" if t < 0 else INK))
    return tuple(a + (b - a) * abs(t))


# --------------------------------------------------------------------------- layout


def axes(fig, x, y, w, h):
    """An axes placed in millimetres from the page's top left."""
    return fig.add_axes([x / W, 1 - (y + h) / H, w / W, h / H])


def letter(fig, x, y, s):
    fig.text(x / W, 1 - y / H, s, fontsize=8, fontweight="bold", va="top", ha="left")


def note(fig, x, y, s, **kw):
    fig.text(x / W, 1 - y / H, s, va="top", ha=kw.pop("ha", "left"), fontsize=kw.pop("fontsize", 5.5),
             color=kw.pop("color", INK2), **kw)


def spines(ax, keep=("left", "bottom")):
    for side in ("left", "right", "top", "bottom"):
        ax.spines[side].set_visible(side in keep)


def kb(v: float) -> str:
    if v == 0:
        return "0"
    return f"{'+' if v > 0 else '−'}{abs(v) / 1000:g} kb"


def inward(ax):
    """The first and last labels of the x axis set inside its ends, so two axes side by side keep theirs
    apart."""
    labels = ax.get_xticklabels()
    labels[0].set_ha("left")
    labels[-1].set_ha("right")


def signed(v: float, digits: int = 1) -> str:
    return f"{'+' if v > 0 else '−' if v < 0 else ''}{abs(v):.{digits}f}"


def colour_bar(fig, x, y, w, cmap, lo, hi, ticks, labels, title=None, h=1.4):
    """A horizontal key, the app's ramp between the two ends of the scale."""
    ax = axes(fig, x, y, w, h)
    ax.imshow(np.linspace(0, 1, 256)[None, :], aspect="auto", cmap=cmap, extent=[lo, hi, 0, 1],
              interpolation="bilinear")
    ax.set_yticks([])
    ax.set_xticks(ticks, labels)
    ax.tick_params(axis="x", length=1.2, pad=1)
    inward(ax)
    for side in ax.spines.values():
        side.set_linewidth(0.3)
    if title:
        ax.set_title(title, fontsize=5, color=INK2, pad=1.5)
    return ax


# --------------------------------------------------------------------------- the panels


def panel_a(fig, apa, numbers):
    notes, header, rows = apa
    m = rows[:, 1:]
    side = m.shape[0]
    lo, hi = centred_scale(m)
    x, y, s = 12.0, 12.0, 52.0
    letter(fig, 2, 3, "a")
    fig.text(x / W, 1 - 3.2 / H, "APA between consecutive CTCF peaks", fontsize=7, fontweight="bold", va="top")
    note(fig, x, 7.0, f"GM12878 Hi-C at 2 kb, ±{HALF} bins · observed / expected")
    ax = axes(fig, x, y, s, s)
    ax.imshow(m, cmap=RDBU_R, vmin=lo, vmax=hi, interpolation="nearest", extent=[-0.5, side - 0.5, side - 0.5, -0.5])
    # The app's ticks, from the table's header: evenly spaced across the axis, the ends at the ends.
    labels = [t.strip().replace("-", "−") for t in notes["x ticks, evenly spaced across the axis"].split(",")]
    ticks = np.linspace(-0.5, side - 0.5, len(labels))
    ax.set_xticks(ticks, labels)
    ax.set_yticks(ticks, labels)
    inward(ax)
    ax.set_xlabel("from the downstream peak", fontsize=5.5, labelpad=1.5)
    ax.set_ylabel("from the upstream peak", fontsize=5.5, labelpad=1.5)
    for side_ in ax.spines.values():
        side_.set_linewidth(0.3)
    windows = int(float(notes["windows"].replace(",", "")))
    p2ll = float(notes["P2LL"]) if "P2LL" in notes else math.nan
    ax.text(0.03, 0.97, f"P2LL {p2ll:.2f}", transform=ax.transAxes, va="top", ha="left", fontsize=5.5,
            color=INK, bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="none", alpha=0.8))
    ax.text(0.97, 0.03, f"{windows:,} pairs", transform=ax.transAxes, va="bottom", ha="right", fontsize=5.5,
            color=INK, bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="none", alpha=0.8))
    colour_bar(fig, x + 8, y + s + 10, s - 16, RDBU_R, lo, hi, [lo, 1, hi], [f"{lo:.2f}", "1", f"{hi:.2f}"],
               title="observed / expected")
    numbers += [("APA: pairs piled up (44 kb to 1 Mb apart, chr1–22 and X)", f"{windows:,}"),
                ("APA: P2LL (centre over the lower-left corner), as the command writes it", notes["P2LL"]),
                ("APA: centre pixel, observed / expected", f"{m[HALF, HALF]:.3f}"),
                ("APA: colour scale", f"{lo:.3f} to {hi:.3f}")]


def metaplot(fig, x0, width, letter_, title, subtitle, curves, heatmaps, names, colours, unit, xlabel,
             ylabel, numbers, prefix, legend_at="upper right", legend_title=None, heat_h=40.0, gap=1.6):
    notes, header, rows = curves
    offsets = rows[:, 0]
    letter(fig, x0 - 7, 3, letter_)
    fig.text(x0 / W, 1 - 3.2 / H, title, fontsize=7, fontweight="bold", va="top")
    note(fig, x0, 7.0, subtitle)
    ax = axes(fig, x0 + 6, 12.0, width - 6, 26.0)
    spines(ax)
    tracks = [c for c in header[1:] if not c.endswith(("_low", "_high"))]
    for i, track in enumerate(tracks):
        k = header.index(track)
        mean, low, high = rows[:, k], rows[:, header.index(f"{track}_low")], rows[:, header.index(f"{track}_high")]
        ax.fill_between(offsets, low, high, color=colours[i], alpha=0.28, lw=0)
        ax.plot(offsets, mean, color=colours[i], lw=0.8, label=names[i])
        at = int(np.nanargmax(np.abs(mean - np.nanmedian(mean))))
        numbers.append((f"{prefix}: {names[i]} at its {'summit' if mean[at] >= np.nanmedian(mean) else 'trough'}"
                        f" ({offsets[at]:+g} {unit}), mean [95% CI]",
                        f"{mean[at]:.4g} [{low[at]:.4g}, {high[at]:.4g}]"))
    span = offsets[-1] - offsets[0] + (offsets[1] - offsets[0])
    edge = offsets[0] - (offsets[1] - offsets[0]) / 2
    ax.set_xlim(edge, edge + span)
    ticks = [edge, edge + span / 4, 0, edge + 3 * span / 4, edge + span]
    ax.set_xticks(ticks, [kb(round(t)) for t in ticks])
    inward(ax)
    ax.set_ylabel(ylabel, fontsize=5.5, labelpad=1.5)
    ax.tick_params(axis="x", labelsize=5)
    ax.legend(loc=legend_at, fontsize=5, frameon=False, handlelength=1.2, borderaxespad=0.2,
              title=legend_title, title_fontsize=5)
    n = int(notes[f"n {tracks[0]}"].replace(",", ""))
    ax.text(0.0, 1.02, f"mean of {n:,} peaks, 95% bootstrap band", transform=ax.transAxes, fontsize=5,
            color=INK3, va="bottom")
    # The heatmaps, side by side under the curve, one order for all of them: strongest first across
    # every track of the run, as the app lists them.
    count = len(heatmaps)
    each = (width - 6 - gap * (count - 1)) / count
    top = 12.0 + 26.0 + 8.0
    for i, (hm_notes, hm_header, hm_rows) in enumerate(heatmaps):
        values = hm_rows[:, 1:]
        lo, hi = clip_of(values)
        picture, k = pooled(values, 1000)
        hx = x0 + 6 + i * (each + gap)
        hax = axes(fig, hx, top, each, heat_h)
        hax.imshow(picture, aspect="auto", cmap="viridis", vmin=lo, vmax=hi, interpolation="none",
                   extent=[edge, edge + span, len(values), 0])
        hax.set_xticks([edge, 0, edge + span], [f"−{abs(edge) / 1000:g}", "0", f"+{(edge + span) / 1000:g}"])
        hax.tick_params(axis="x", labelsize=4.5, length=1.2, pad=1)
        inward(hax)
        hax.set_yticks([])
        for side in hax.spines.values():
            side.set_linewidth(0.3)
        hax.set_title(names[i], fontsize=5.5, color=colours[i], pad=2, fontweight="bold")
        if i == 0:
            hax.set_ylabel(f"{len(values):,} CTCF peaks, strongest first", fontsize=5.5, labelpad=1.5)
        negative = lo < 0
        colour_bar(fig, hx + 1, top + heat_h + 8.5, each - 2, "viridis", lo, hi,
                   [lo, 0, hi] if negative else [lo, hi],
                   [signed(lo), "", signed(hi)] if negative else ["0", f"{hi:.0f}"], h=1.2)
        numbers.append((f"{prefix}: {names[i]} heatmap, colour scale (each line the mean of {k} peaks)",
                        f"{lo:.4g} to {hi:.4g}"))
    note(fig, x0 + 6 + (width - 6) / 2, top + heat_h + 3.6, xlabel, fontsize=5, color=INK3, ha="center")


def main() -> None:
    numbers: list[tuple[str, str]] = []
    peaks = fetch("human/GM12878_CTCF.peaks.bed")
    apa_dir = run("apa", "apa", band_map(), "--pairs", consecutive_pairs(), "--mode", "fixed",
                  "--window", HALF, "--minDist", MIN_DIST, "--norm", "oe")
    signal_dir = run("metaplot-signal", "metaplot",
                     *[a for accession, *_ in SIGNAL for a in ("--tracks", fetch(f"human/{accession}.bigWig"))],
                     "--features", peaks, "--mode", "reference", "--at", "centre", "--stranded=false",
                     "--flank", 2000, "--step", 50)
    insulation_dir = run("metaplot-insulation", "metaplot",
                         *[a for w in WINDOWS for a in ("--tracks", fetch(f"human/{GM}_10000.insulation-w{w}.bw"))],
                         "--features", peaks, "--mode", "reference", "--at", "centre", "--stranded=false",
                         "--flank", 500_000, "--step", 10_000)

    peak_count = sum(1 for line in peaks.read_text().splitlines() if line and not line.startswith("#"))
    pairs_all = sum(1 for line in fetch("human/GM12878_CTCF.consecutive.bedpe").read_text().splitlines()
                    if line and not line.startswith("#"))
    pairs_kept = sum(1 for line in consecutive_pairs().read_text().splitlines() if line)
    numbers += [("CTCF peaks (yapc on both replicates, IDR ≤ 0.05)", f"{peak_count:,}"),
                ("consecutive pairs", f"{pairs_all:,}"),
                ("consecutive pairs on chr1–22 and X, at most 1 Mb apart", f"{pairs_kept:,}")]

    fig = plt.figure(figsize=(W * MM, H * MM))
    panel_a(fig, read_output(one(apa_dir, "*.apa-0.tsv")), numbers)

    def heatmaps(directory: Path, count: int):
        names = ["*.metaplot-heatmap.tsv"] + [f"*.metaplot-heatmap-{i}.tsv" for i in range(2, count + 1)]
        return [read_output(one(directory, name)) for name in names]

    metaplot(fig, 74.0, 50.0, "b", "CTCF and ATAC-seq at CTCF peaks",
             "fold change over control, ±2 kb, 50-bp columns",
             read_output(one(signal_dir, "*.metaplot.metaplot.tsv")), heatmaps(signal_dir, len(SIGNAL)),
             [name for _, name, _, _ in SIGNAL], [colour for *_, colour in SIGNAL], "bp",
             "kb from the peak's centre", "fold change", numbers, "b")
    insulation = GM_COLOURS["insulation"]
    metaplot(fig, 130.0, 48.0, "c", "Insulation at CTCF peaks",
             "the map's diamond insulation, ±500 kb, 10-kb columns",
             read_output(one(insulation_dir, "*.metaplot.metaplot.tsv")), heatmaps(insulation_dir, len(WINDOWS)),
             [f"{w * 10} kb" for w in WINDOWS], [shade(insulation, t) for t in (-0.35, 0.0, 0.35, 0.65)], "bp",
             "kb from the peak's centre", "insulation (log2)", numbers, "c", legend_at="lower left",
             legend_title="window", gap=1.2)

    for suffix in ("pdf", "svg"):
        fig.savefig(HERE / f"figure2.{suffix}")
    fig.savefig(HERE / "figure2.png", dpi=300)
    rows = [("quantity", "value")] + numbers
    (HERE / "numbers.tsv").write_text("".join(f"{k}\t{v}\n" for k, v in rows))
    print("wrote", ", ".join(str((HERE / f"figure2.{s}").relative_to(ROOT)) for s in ("pdf", "svg", "png")),
          "and numbers.tsv")


if __name__ == "__main__":
    main()
