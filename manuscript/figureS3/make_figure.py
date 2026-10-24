#!/usr/bin/env python3
"""Fig. S3 of the Chromosomix paper: bacterial chromosomes read along their two arms.

    npm run build:cli                                  # the chromosomix command every analysis runs on
    python -m pip install numpy scipy matplotlib h5py
    python manuscript/figureS3/make_figure.py          # figureS3.pdf, figureS3.png and numbers.tsv

The data are the paper store's (`demo/store/chromosomix_paper/`, listed in `demo/store/MANIFEST.tsv`):
*C. necator* N-1 (a), the *B. subtilis* PY79 ParB time course (b), and *P. aeruginosa* wild type and
two condensin mutants (c, d), with RNA-seq of PAK (GEO GSE76513) for d's gene expression. Each file is read once into build/data/, from the store's folder on the
lab's bucket or, while that folder is not published, from where the manifest says it comes from.

Everything computed is the `chromosomix` command's, run here and kept in build/runs/: the origins
(*Origin and terminus*), the inter-arm alignment and its decays, E1 and the A/B compartments along
both arms, the base composition, the 3D model and its radial positions, and the A-against-B tests.
The maps are drawn from the .mcool with the app's own arithmetic, ported line for line as
notebooks/dbz-chromosome-figures.qmd ports it and checks it against the CLI: balanced contacts, the
distance decay the short way round the circle, `armExpected` (src/analysis/arms.ts) and the
compartment chain's correlation. Every map has its origin in the middle, and is coloured with the
app's ramps and its automatic ranges.

The page is 180 mm wide; type is Helvetica/Arial (Liberation Sans where neither is installed),
5–7 pt, panel letters 8 pt bold. The maps are images, everything else is vector.
"""

from __future__ import annotations

import math
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

import h5py
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from make_rsg_store import PAO1_STRAINS, SUBTILIS_COURSE  # noqa: E402  — the store's names, said once

BUILD = HERE / "build"
DATA, RUNS = BUILD / "data", BUILD / "runs"
CLI = ROOT / "dist-cli" / "chromosomix.mjs"
MANIFEST = ROOT / "demo" / "store" / "MANIFEST.tsv"
BUCKET = "https://rsglab-data.s3.eu-west-3.amazonaws.com/"
PAPER = "chromosomix_paper/"

#: How far along the arms each cell's expectation reaches, in bins: 400 kb at 8 kb, as the paper reads
#: every bacterial map (Methods, "Analysis of bacterial genomes").
ARM_WINDOW = 50
#: The inter-arm band, in bins either side of the secondary diagonal.
BAND = 2

CNECATOR = dict(map="C_necator/C_necator_N1_VJ_MM260.mcool", fasta="C_necator/C_necator_N1_VJ.fa",
                chrom="chromosome1", res=8000)
SUBTILIS = dict(fasta="B_subtilis/PY79.fa", chrom="NC_022898.1", res=10000)
AERUGINOSA = dict(fasta="P_aeruginosa/PAO1_v3.fa", chrom="PAO1", res=8000,
                  rna="P_aeruginosa/GSE76513_PAK_T0_pooled.unstranded.CPM.bw")

# --------------------------------------------------------------------------- style

MM = 1 / 25.4
W, H = 180.0, 262.0
INK, INK2, INK3, RULE = "#1c1e21", "#4b5058", "#80868f", "#d5d9df"
COMP_A, COMP_B = "#C0504D", "#4F81BD"
E1_FILL, E1_LINE = "#E8A33D", "#7a4a00"
E1_HEIGHT = 12.0
CURVES = {"along the diagonal": "#1c1e21", "within an arm": "#D55E00", "across the arms": "#0072B2"}

# The app's `default` ramp (src/render/colormaps.ts, DEFAULT_STOPS) and RdBu_r, as Fig. 1 draws them.
DEFAULT_STOPS = ["#FFFEF9", "#FCF9CE", "#FFF2A9", "#FDE188", "#FFCA67", "#FAAA4B", "#F78E40",
                 "#F15C34", "#ED3024", "#D42027", "#B01F29", "#7A1128", "#1A0A10"]
RDBU_R_STOPS = ["#053061", "#2166AC", "#4393C3", "#92C5DE", "#D1E5F0", "#F7F7F7", "#FDDBC7",
                "#F4A582", "#D6604D", "#B2182B", "#67001F"]


def ramp(stops: list[str], size: int = 256) -> np.ndarray:
    """`rampFromStops`: hex stops spread evenly, linearly interpolated, as uint8 RGB."""
    pts = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in stops], float)
    t = np.linspace(0, 1, size)
    at = np.linspace(0, 1, len(stops))
    return np.stack([np.round(np.interp(t, at, pts[:, c])) for c in range(3)], 1).astype(np.uint8)


LUT, LUT_RDBU = ramp(DEFAULT_STOPS), ramp(RDBU_R_STOPS)

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


def fetch(path: str) -> Path:
    """One file of the paper's folder on this disk, read once."""
    source = SOURCES[PAPER + path]
    if source.startswith("repo:"):
        return ROOT / source[len("repo:"):]
    target = DATA / path
    if target.exists():
        return target
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
        partial.rename(target)
        print(f"fetched {path} ({target.stat().st_size / 1e6:.1f} MB) from {url}")
        return target
    raise FileNotFoundError(f"{path}: neither the store's folder nor {source} answers")


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


def table(path: Path) -> list[dict[str, str]]:
    """A chromosomix table: `#` lines are its provenance, the first other line its header."""
    lines = [line for line in path.read_text().splitlines() if line and not line.startswith("#")]
    header = lines[0].split("\t")
    return [dict(zip(header, line.split("\t"))) for line in lines[1:]]


def number(text: str) -> float:
    try:
        return float(text)
    except ValueError:
        return math.nan


def profile(path: Path, chrom: str, n: int, res: int) -> np.ndarray:
    """A bedGraph as a vector over the n bins of one sequence, NaN where it has no value."""
    out = np.full(n, np.nan)
    for line in path.read_text().splitlines():
        cells = line.split("\t")
        if len(cells) < 4 or line.startswith(("#", "track")) or cells[0] != chrom:
            continue
        out[int(cells[1]) // res] = float(cells[3])
    return out


def by_group(path: Path) -> dict[str, np.ndarray]:
    """*Signal by group*'s values, a column a group: what its test compared, one value a bin."""
    rows = table(path)
    groups = [name for name in rows[0] if name != next(iter(rows[0]))]
    return {g: np.array([number(row[g]) for row in rows if row.get(g, "") != ""]) for g in groups}


def compartments(path: Path, chrom: str, n: int, res: int) -> np.ndarray:
    """The A/B call of each bin, from the BED of segments the task writes; '' where none."""
    out = np.full(n, "", dtype="<U1")
    for line in path.read_text().splitlines():
        cells = line.split("\t")
        if len(cells) < 4 or line.startswith(("#", "track")) or cells[0] != chrom:
            continue
        out[int(cells[1]) // res:-(-int(cells[2]) // res)] = cells[3][:1]
    return out


def beads(path: Path, chrom: str, n: int, res: int) -> np.ndarray:
    """A bed3d over the n bins of one sequence: x, y, z a bead, NaN where none was placed."""
    xyz = np.full((n, 3), np.nan)
    for line in path.read_text().splitlines():
        cells = line.split("\t")
        if len(cells) < 6 or line.startswith(("#", "track")) or cells[0] != chrom:
            continue
        try:
            xyz[int(cells[1]) // res] = [float(value) for value in cells[3:6]]
        except ValueError:
            pass
    return xyz


# --------------------------------------------------------------------------- the app's arithmetic
# Ported from notebooks/dbz-chromosome-figures.qmd, which checks each against the CLI.


def balanced(mcool: Path, chrom: str, res: int) -> np.ndarray:
    """The balanced contacts of one sequence, dense; NaN where a bin has no weight."""
    with h5py.File(mcool, "r") as f:
        g = f[f"resolutions/{res}"]
        names = [name.decode() if isinstance(name, bytes) else str(name) for name in g["chroms/name"][:]]
        cid = names.index(chrom)
        lo, hi = int(g["indexes/chrom_offset"][cid]), int(g["indexes/chrom_offset"][cid + 1])
        first, last = int(g["indexes/bin1_offset"][lo]), int(g["indexes/bin1_offset"][hi])
        bin1 = g["pixels/bin1_id"][first:last]
        bin2 = g["pixels/bin2_id"][first:last]
        count = g["pixels/count"][first:last].astype(float)
        weight = g["bins/weight"][lo:hi] if "weight" in g["bins"] else np.ones(hi - lo)
    inside = bin2 < hi
    n = hi - lo
    square = np.zeros((n, n))
    square[bin1[inside] - lo, bin2[inside] - lo] = count[inside]
    square[bin2[inside] - lo, bin1[inside] - lo] = count[inside]
    return square * weight[:, None] * weight[None, :]


def separations(n: int) -> np.ndarray:
    """How far apart two bins are, the short way round the circle."""
    i = np.arange(n)
    straight = np.abs(i[:, None] - i[None, :])
    return np.minimum(straight, n - straight)


def over_distance(square: np.ndarray) -> np.ndarray:
    """Observed/expected over the distance decay: each cell over the mean of every cell as far apart."""
    s = separations(len(square))
    finite = np.isfinite(square)
    sums = np.bincount(s[finite], weights=square[finite], minlength=s.max() + 1)
    counts = np.bincount(s[finite], minlength=s.max() + 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return square / (sums / counts)[s]


def arm_expected(square: np.ndarray, origin: int, window: int) -> np.ndarray:
    """armExpected of src/analysis/arms.ts over the whole square: the decay along both arms."""
    n = len(square)
    i = np.arange(n)
    u = ((i - origin + n // 2) % n) - n // 2
    a = np.abs(u)
    longest = int(a.max())
    max_delta, max_sigma = longest + 1, 2 * longest + 1
    whole = not window > 0
    bucket = max_sigma if whole else max(1, window // 4)
    buckets = -(-max_sigma // bucket)
    reach = buckets if whole else max(1, -(-window // bucket))
    kind = ((u[:, None] >= 0) != (u[None, :] >= 0)).astype(int)
    delta = np.abs(a[:, None] - a[None, :])
    slot = (a[:, None] + a[None, :]) // bucket
    finite = np.isfinite(square)
    expected = np.full(square.shape, np.nan)
    lo = np.maximum(0, np.arange(buckets) - reach)
    hi = np.minimum(buckets, np.arange(buckets) + reach + 1)
    for k in (0, 1):
        cells = finite & (kind == k)
        at = delta[cells] * buckets + slot[cells]
        sums = np.bincount(at, weights=square[cells], minlength=max_delta * buckets).reshape(max_delta, buckets)
        counts = np.bincount(at, minlength=max_delta * buckets).reshape(max_delta, buckets).astype(float)
        prefix_sum = np.concatenate([np.zeros((max_delta, 1)), np.cumsum(sums, 1)], 1)
        prefix_count = np.concatenate([np.zeros((max_delta, 1)), np.cumsum(counts, 1)], 1)
        with np.errstate(invalid="ignore", divide="ignore"):
            means = (prefix_sum[:, hi] - prefix_sum[:, lo]) / (prefix_count[:, hi] - prefix_count[:, lo])
        mine = kind == k
        expected[mine] = means[delta[mine], slot[mine]]
    return expected


def correlation(oe: np.ndarray, square: np.ndarray, ignore: int = 2) -> np.ndarray:
    """The compartment chain's correlation, put back on the whole square with dropped bins as gaps."""
    n = len(square)
    usable = np.isfinite(square).sum(1) >= max(1, math.ceil(n * 0.1))
    x = oe.copy()
    x[separations(n) < ignore] = np.nan
    x = x[np.ix_(usable, usable)]
    valid = np.isfinite(x).astype(float)
    x0 = np.where(valid > 0, x, 0.0)
    pairs = valid @ valid.T
    sx = x0 @ valid.T
    sxx = (x0 * x0) @ valid.T
    with np.errstate(invalid="ignore", divide="ignore"):
        cov = x0 @ x0.T - sx * sx.T / pairs
        var_x, var_y = sxx - sx * sx / pairs, sxx.T - sx.T * sx.T / pairs
        c = cov / np.sqrt(var_x * var_y)
    c[(pairs < 3) | ~(var_x > 0) | ~(var_y > 0) | ~np.isfinite(c)] = 0.0
    np.fill_diagonal(c, 1.0)
    out = np.full((n, n), np.nan)
    out[np.ix_(usable, usable)] = c
    return out


class Circle:
    """One circular chromosome's frame: its bins, and the turn that puts its origin in the middle."""

    def __init__(self, n: int, res: int, origin: int):
        self.n, self.res, self.origin = n, res, origin
        self.o = min(n - 1, (origin - 1) // res)
        self.rot = (np.arange(n) + (self.o + (n + 1) // 2) % n) % n

    def square(self, m: np.ndarray) -> np.ndarray:
        return m[np.ix_(self.rot, self.rot)]

    def line(self, v: np.ndarray) -> np.ndarray:
        return v[self.rot]


def origin_of(name: str, mcool: Path, fasta: Path, chrom: str, res: int) -> int:
    """The origin *Origin and terminus* calls, 1-based, with the sequence read as a circle."""
    out = run(f"{name}-oriter", "oriter", f"{mcool}::/resolutions/{res}", "--sequence", fasta,
              "--sequences", chrom, "--circular", chrom)
    return int(next(row for row in table(one(out, "*oriter-table.tsv")) if row["sequence"] == chrom)["ori"])


def interarm(name: str, mcool: Path, chrom: str, res: int, origin: int) -> Path:
    return run(f"{name}-interarm", "interarm", f"{mcool}::/resolutions/{res}", "--sequences", chrom,
               "--band", BAND, "--circular", chrom, "--origin", f"{chrom}:{origin}")


def e1_along_arms(name: str, mcool: Path, fasta: Path, chrom: str, res: int, origin: int) -> Path:
    """E1 along both arms, as the store's tracks are made (make_rsg_store.py, write_e1_arms)."""
    return run(f"{name}-compartments-arms", "compartments", f"{mcool}::/resolutions/{res}",
               "--circular", chrom, "--origin", f"{chrom}:{origin}", "--sequence", fasta,
               "--phaseSequence", fasta, "--ignoreDiags", 2, "--components", 3, "--minR", 0.1,
               "--saddle=false", "--expected", "arms", "--armWindow", ARM_WINDOW, "--method", "cooltools")


def curve(path: Path) -> tuple[np.ndarray, np.ndarray]:
    rows = [line.split("\t") for line in path.read_text().splitlines() if line and not line.startswith("#")][1:]
    return np.array([number(r[0]) for r in rows]), np.array([number(r[1]) for r in rows])


# --------------------------------------------------------------------------- the panels' data


def panel_a() -> dict:
    mcool, fasta = fetch(CNECATOR["map"]), fetch(CNECATOR["fasta"])
    chrom, res = CNECATOR["chrom"], CNECATOR["res"]
    origin = origin_of("cnecator", mcool, fasta, chrom, res)
    square = balanced(mcool, chrom, res)
    frame = Circle(len(square), res, origin)
    expected = arm_expected(square, frame.o, ARM_WINDOW)
    oe_distance, oe_arms = over_distance(square), square / expected
    out = interarm("cnecator", mcool, chrom, res, origin)
    decay = [line.split("\t") for line in one(out, "*interarm-decay.tsv").read_text().splitlines()
             if line and not line.startswith("#")]
    return dict(
        frame=frame, origin=origin,
        maps=[[frame.square(square), frame.square(oe_distance), frame.square(correlation(oe_distance, square))],
              [frame.square(expected), frame.square(oe_arms), frame.square(correlation(oe_arms, square))]],
        profile=curve(one(out, "*interarm-curve.tsv")), detrended=curve(one(out, "*interarm-detrended-curve.tsv")),
        decay=(np.array([number(r[0]) for r in decay[1:]]),
               {name: np.array([number(r[k]) for r in decay[1:]]) for k, name in enumerate(CURVES, start=1)}),
        row=table(one(out, "*interarm-table.tsv"))[0],
    )


def panel_b() -> dict:
    fasta = fetch(SUBTILIS["fasta"])
    chrom, res = SUBTILIS["chrom"], SUBTILIS["res"]
    maps = [fetch(f"B_subtilis/Bsubtilis_{name}.mcool") for name, _, _ in SUBTILIS_COURSE]
    # One strain, one reference: the origin is called once, on the wild type's map.
    origin = origin_of("bsubtilis", maps[0], fasta, chrom, res)
    squares = [balanced(m, chrom, res) for m in maps]
    frame = Circle(len(squares[0]), res, origin)
    rows = [table(one(interarm(f"bsubtilis-{name}", m, chrom, res, origin), "*interarm-table.tsv"))[0]
            for (name, _, _), m in zip(SUBTILIS_COURSE, maps)]
    return dict(frame=frame, origin=origin, maps=[frame.square(s) for s in squares],
                labels=[label for _, _, label in SUBTILIS_COURSE],
                reach=np.array([number(row["reach"]) for row in rows]),
                enrichment=np.array([number(row["enrichment"]) for row in rows]))


def panel_cd() -> dict:
    fasta = fetch(AERUGINOSA["fasta"])
    chrom, res = AERUGINOSA["chrom"], AERUGINOSA["res"]
    maps = [fetch(f"P_aeruginosa/{sample}.mcool") for sample, _ in PAO1_STRAINS]
    origin = origin_of("aeruginosa", maps[0], fasta, chrom, res)
    strains = []
    for (sample, label), mcool in zip(PAO1_STRAINS, maps):
        square = balanced(mcool, chrom, res)
        frame = Circle(len(square), res, origin)
        oe_arms = square / arm_expected(square, frame.o, ARM_WINDOW)
        comp = e1_along_arms(sample, mcool, fasta, chrom, res, origin)
        strains.append(dict(
            sample=sample, label=label, frame=frame,
            maps=[frame.square(square), frame.square(correlation(over_distance(square), square)),
                  frame.square(correlation(oe_arms, square))],
            e1=frame.line(profile(one(comp, "*compartment-e1.bedGraph"), chrom, frame.n, res)),
            comp=comp))

    # d: the wild type's compartments against its sequence and its model.
    wt = strains[0]
    at = f"{maps[0]}::/resolutions/{res}"
    n = wt["frame"].n
    ab_bed = one(wt["comp"], "*compartment-ab.bed")
    composition = run("aeruginosa-composition", "composition", at, "--sequence", fasta, "--circular", chrom)
    model = one(run("aeruginosa-model", "reconstruct3d", at, "--region", chrom, "--method", "nb",
                    "--alpha", 3, "--iterations", 150, "--circular", chrom), "*reconstructed-model.bed3d")
    spatial = run("aeruginosa-spatial", "spatialtracks", at, "--features", model, "--structure", model,
                  "--circular", chrom, "--origin", f"{chrom}:{origin}")
    tests, values = {}, {}
    for key, track in (("gc", one(composition, "*composition-gc.bw")), ("radial", one(spatial, "*radial*.bw")),
                       ("rna", fetch(AERUGINOSA["rna"]))):
        out = run(f"aeruginosa-groups-{key}", "groupsignal", "--tracks", track, "--features", ab_bed,
                  "--outside=false", "--resolution", res, "--circular", chrom)
        tests[key] = table(one(out, "*groupsignal-tests.tsv"))
        values[key] = by_group(one(out, "*groupsignal-1.tsv"))
    return dict(
        strains=strains, origin=origin,
        ab=compartments(ab_bed, chrom, n, res),
        gc=profile(one(composition, "*composition-gc.bedGraph"), chrom, n, res),
        radial=profile(one(spatial, "*radial*.bedGraph"), chrom, n, res),
        rna=values["rna"], model=beads(model, chrom, n, res), tests=tests)


# --------------------------------------------------------------------------- drawing


def finite(v: np.ndarray) -> np.ndarray:
    return v[np.isfinite(v)]


def positive_log10(m: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(m > 0, np.log10(m), np.nan)


def auto_range(values: np.ndarray) -> tuple[float, float]:
    """The app's auto range for a map: the 1st to the 99th percentile of the cells with contacts."""
    v = finite(values)
    return float(np.percentile(v, 1)), float(np.percentile(v, 99))


def auto_half(values: np.ndarray) -> float:
    """…and for a ratio or a correlation: the 99th percentile of the distance from neutral."""
    return float(np.percentile(np.abs(finite(values)), 99))


def painted(values: np.ndarray, lut: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Values through a ramp as the app paints them, a gap white."""
    t = np.clip((values - lo) / (hi - lo), 0, 1)
    rgb = lut[np.nan_to_num(t * (len(lut) - 1)).astype(int)]
    rgb[~np.isfinite(values)] = 255
    return rgb


def without_diagonal(m: np.ndarray, k: int = 2) -> np.ndarray:
    """A square's cells away from the diagonal, for a correlation's range (its diagonal is one)."""
    n = len(m)
    keep = separations(n) >= k
    return m[keep]


def heat(m: np.ndarray, kind: str, clip: tuple[float, float] | None = None) -> tuple[np.ndarray, str, float, float]:
    """A map as an image, with its key: `contacts` (log10, the app's default ramp), `ratio` (log2,
    RdBu_r, symmetric) or `correlation` (RdBu_r, symmetric). `clip` puts a contact map on another's
    range, as the deck's *match all scales* does."""
    if kind == "contacts":
        v = positive_log10(m)
        lo, hi = auto_range(v) if clip is None else clip
        return painted(v, LUT, lo, hi), "log10", lo, hi
    if kind == "ratio":
        with np.errstate(divide="ignore", invalid="ignore"):
            v = np.where(m > 0, np.log2(m), np.nan)
        half = auto_half(v)
        return painted(v, LUT_RDBU, -half, half), "log2", -half, half
    half = auto_half(without_diagonal(m))
    return painted(m, LUT_RDBU, -half, half), "r", -half, half


class Page:
    """A figure laid out in millimetres from the top-left corner, as Fig. 1's is."""

    def __init__(self) -> None:
        self.fig = plt.figure(figsize=(W * MM, H * MM))

    def axes(self, x: float, y: float, w: float, h: float, **kw):
        return self.fig.add_axes([x / W, 1 - (y + h) / H, w / W, h / H], **kw)

    def text(self, x: float, y: float, s: str, **kw):
        kw.setdefault("va", "top")
        return self.fig.text(x / W, 1 - y / H, s, **kw)

    def letter(self, x: float, y: float, s: str) -> None:
        self.text(x, y, s, fontsize=8, fontweight="bold", ha="left")


def draw_map(page: Page, x: float, y: float, s: float, m: np.ndarray, kind: str, key: bool = True,
             clip: tuple[float, float] | None = None) -> None:
    ax = page.axes(x, y, s, s)
    rgb, unit, lo, hi = heat(m, kind, clip)
    ax.imshow(rgb, interpolation="nearest", aspect="equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_color(INK3)
        spine.set_linewidth(0.3)
    if key:
        draw_key(page, x + s, y, kind, unit, lo, hi)


def draw_key(page: Page, right: float, top: float, kind: str, unit: str, lo: float, hi: float) -> None:
    """A map's key as the app draws its legend, in the map's top-right corner: what the colour is, the
    ramp, and the two ends of the range it is clipped to."""
    bw, bh = 12.0, 5.6
    bx, by = right - bw - 0.5, top + 0.5
    box = page.axes(bx, by, bw, bh)
    box.set_facecolor((1, 1, 1, 0.88))
    box.set_xticks([])
    box.set_yticks([])
    for spine in box.spines.values():
        spine.set_linewidth(0.25)
        spine.set_color(INK3)
    words = {"contacts": "balanced (log10)", "ratio": "obs./exp. (log2)", "correlation": "correlation"}[kind]
    page.text(bx + 0.7, by + 0.5, words, fontsize=4.2, color=INK2, ha="left")
    strip = page.axes(bx + 0.7, by + 2.3, bw - 1.4, 0.9)
    strip.imshow((LUT if kind == "contacts" else LUT_RDBU)[None, :, :], aspect="auto", interpolation="bilinear")
    strip.set_xticks([])
    strip.set_yticks([])
    for spine in strip.spines.values():
        spine.set_linewidth(0.2)
        spine.set_color(INK3)
    digits = 2 if kind == "correlation" else 1
    page.text(bx + 0.7, by + 3.5, f"{lo:.{digits}f}".replace("-", "\u2212"), fontsize=4.2, color=INK2, ha="left")
    page.text(bx + bw - 0.7, by + 3.5, f"{hi:.{digits}f}".replace("-", "\u2212"), fontsize=4.2, color=INK2,
              ha="right")


def side_label(page: Page, x: float, y: float, h: float, s: str) -> None:
    """A row's name, set up the left side of its map, as the draft has them."""
    page.fig.text(x / W, 1 - (y + h / 2) / H, s, rotation=90, ha="center", va="center", fontsize=6,
                  linespacing=1.05)


def style_axes(ax) -> None:
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.tick_params(length=1.6, pad=1)


def draw_a(page: Page, a: dict, top: float) -> float:
    page.letter(2, top, "a")
    s, left, pitch = 31.0, 13.0, 41.5
    labels = [["Balanced scores", "Observed/expected\n(standard decay)", "Correlation scores\n(standard decay)"],
              ["Decay over both arms", "Observed/expected\n(both arms decay)", "Correlation scores\n(both arms decay)"]]
    kinds = [["contacts", "ratio", "correlation"], ["contacts", "ratio", "correlation"]]
    for r in range(2):
        y = top + 2 + r * (s + 3.5)
        for c in range(3):
            x = left + c * pitch
            side_label(page, x - 3.6, y, s, labels[r][c])
            draw_map(page, x, y, s, a["maps"][r][c], kinds[r][c])
    # Beside the maps: what the standard decay leaves along the secondary diagonal, and what dividing
    # by the decay along both arms takes away — the inter-arm task's profile and its two decays.
    bx, bw = left + 3 * pitch + 6.5, W - (left + 3 * pitch + 6.5) - 3
    row = a["row"]
    ax = page.axes(bx, top + 4, bw, s - 6)
    (x1, y1), (x2, y2) = a["profile"], a["detrended"]
    ax.axhline(0, color=RULE, lw=0.5)
    ax.plot(x1 / 1e6, y1, color=INK, lw=0.8, label="standard decay")
    ax.plot(x2 / 1e6, y2, color=COMP_B, lw=0.8, label="both arms decay")
    ax.set_xlabel("distance from the origin (Mb)", fontsize=5.5, labelpad=1)
    ax.set_ylabel("secondary diagonal,\nlog2 obs./exp.", fontsize=5.5, labelpad=1)
    ax.legend(frameon=False, fontsize=4.8, loc="upper right", handlelength=1.2, borderaxespad=0.2)
    style_axes(ax)
    ax.set_title(f"{number(row['enrichment']):.2f}×, then {number(row['detrended']):.2f}× detrended;\n"
                 f"aligned over {number(row['reach']) / 1e6:.2f} of {number(row['armLength']) / 1e6:.2f} Mb",
                 fontsize=5, color=INK2, pad=2, loc="left")
    ax = page.axes(bx, top + 2 + s + 3.5 + 2, bw, s - 6)
    separation, decays = a["decay"]
    for name, values in decays.items():
        ax.loglog(separation, values, color=CURVES[name], lw=0.8, label=name)
    ax.set_xlabel("separation (bp)", fontsize=5.5, labelpad=1)
    ax.set_ylabel("contacts (balanced)", fontsize=5.5, labelpad=1)
    ax.legend(frameon=False, fontsize=4.8, loc="lower left", handlelength=1.2, borderaxespad=0.2)
    style_axes(ax)
    return top + 2 + 2 * s + 3.5


def draw_b(page: Page, b: dict, top: float) -> float:
    page.letter(2, top, "b")
    s, left, pitch, title = 27.0, 9.0, 29.5, 3.2
    # One scale for the eight, the wild type's, as *match all scales* sets a deck from its starred map.
    clip = auto_range(positive_log10(b["maps"][0]))
    for k, (m, label) in enumerate(zip(b["maps"], b["labels"])):
        r, c = divmod(k, 4)
        x, y = left + c * pitch, top + 2 + r * (s + title + 1.5)
        page.text(x, y, label, fontsize=6.5, ha="left")
        draw_map(page, x, y + title, s, m, "contacts", key=(k == 0), clip=clip)
    side_label(page, 4.6, top + 2 + title, 2 * s + title + 1.5, "Balanced scores")
    # Beside the maps: how far from the origin the arms are aligned, after ParB is induced.
    labels, reach = b["labels"], b["reach"] / 1e6
    timed = [(int(label.split()[1]), value) for label, value in zip(labels, reach) if label.startswith("+parB")]
    minutes, values = np.array([t for t, _ in timed]), np.array([v for _, v in timed])
    under_way = minutes >= 15
    slope, intercept = np.polyfit(minutes[under_way], values[under_way], 1)
    predicted = slope * minutes[under_way] + intercept
    r2 = 1 - ((values[under_way] - predicted) ** 2).sum() / ((values[under_way] - values[under_way].mean()) ** 2).sum()
    bx = left + 4 * pitch + 7.5
    ax = page.axes(bx, top + 6, W - bx - 3, 2 * s + title + 1.5 - 9)
    for name, value, style in (("WT", reach[0], (0, (3, 2))), ("ΔparAB", reach[1], (0, (1, 1.5)))):
        ax.axhline(value, color=INK3, lw=0.6, ls=style)
        ax.text(46.5, value, name, fontsize=4.8, color=INK2, va="bottom", ha="right")
    ax.plot(minutes[~under_way], values[~under_way], "o", ms=2.6, mfc="white", mec=INK, mew=0.6)
    ax.plot(minutes[under_way], values[under_way], "o", ms=2.6, color=INK)
    span = np.array([14, 46])
    ax.plot(span, slope * span + intercept, color="#D55E00", lw=0.8)
    ax.set_xlim(-3, 48)
    ax.set_xlabel("minutes after ParB is induced", fontsize=5.5, labelpad=1)
    ax.set_ylabel("arms aligned from the origin (Mb)", fontsize=5.5, labelpad=1)
    ax.text(0.97, 0.04, f"{slope * 1e3:.0f} kb/min, r² = {r2:.3f}\n(least squares, 15–45 min)",
            transform=ax.transAxes, fontsize=4.8, va="bottom", ha="right", color="#D55E00")
    style_axes(ax)
    b["fit"] = (slope, intercept, r2)
    return top + 2 + 2 * (s + title) + 1.5


def draw_c(page: Page, cd: dict, top: float) -> float:
    page.letter(2, top, "c")
    s, left, pitch, title = 31.0, 13.0, 33.5, 3.2
    rows = ["Balanced scores", "Correlation scores\n(detrended)", "Correlation scores\n(both arms detrended)"]
    kinds = ["contacts", "correlation", "correlation"]
    for c, strain in enumerate(cd["strains"]):
        x = left + c * pitch
        page.text(x, top + 2, strain["label"], fontsize=6.5, ha="left")
        for r in range(3):
            draw_map(page, x, top + 2 + title + r * (s + 2), s, strain["maps"][r], kinds[r])
    for r, label in enumerate(rows):
        side_label(page, 6.5, top + 2 + title + r * (s + 2), s, label)
    # E1 along both arms, in the maps' frame, on one axis for the three strains.
    y = top + 2 + title + 3 * (s + 2) + 0.5
    reach = max(np.nanmax(np.abs(strain["e1"])) for strain in cd["strains"])
    limit = math.ceil(reach * 10) / 10
    for c, strain in enumerate(cd["strains"]):
        ax = page.axes(left + c * pitch, y, s, E1_HEIGHT)
        e1 = strain["e1"]
        xs = np.arange(len(e1))
        ax.fill_between(xs, 0, e1, color=E1_FILL, lw=0, step="mid")
        ax.step(xs, e1, where="mid", color=E1_LINE, lw=0.2)
        ax.axhline(0, color=INK3, lw=0.3)
        ax.set_xlim(-0.5, len(e1) - 0.5)
        ax.set_ylim(-limit, limit)
        ax.set_xticks([])
        ax.set_yticks([-1, 0, 1] if c == 0 else [])
        for spine in ax.spines.values():
            spine.set_linewidth(0.3)
            spine.set_color(INK3)
    side_label(page, 6.5, y, E1_HEIGHT, "E1")
    return y + E1_HEIGHT


def faded(colour: str, t: float) -> tuple[float, float, float]:
    """A colour mixed toward white by t: the depth cue, without the dark dots overlapping
    transparent segments leave at every bead."""
    rgb = [int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(c + (1 - c) * t for c in rgb)


def violin(ax, a: np.ndarray, b: np.ndarray, p: float | None, label: str) -> None:
    parts = ax.violinplot([finite(a), finite(b)], positions=[0, 1], widths=0.75, showextrema=False)
    for body, colour in zip(parts["bodies"], (COMP_A, COMP_B)):
        body.set_facecolor(colour)
        body.set_edgecolor("#1c1e21")
        body.set_linewidth(0.35)
        body.set_alpha(1)
    ax.set_xlim(-0.6, 1.6)
    ax.set_xticks([0, 1], ["A", "B"] if label == "radial" else ["", ""])
    ax.grid(axis="y", color=RULE, lw=0.35, ls=(0, (3, 2)))
    ax.set_axisbelow(True)
    lo, hi = ax.get_ylim()
    top = hi + (hi - lo) * 0.04
    if p is not None:
        ax.plot([0, 0, 1, 1], [top, top + (hi - lo) * 0.03, top + (hi - lo) * 0.03, top], color=INK, lw=0.45,
                clip_on=False)
        ax.text(0.5, top + (hi - lo) * 0.05, f"{p:.2e}", ha="center", va="bottom", fontsize=5.5)
    ax.set_ylim(lo, hi)
    for side in ("top", "right"):
        ax.spines[side].set_visible(True)
        ax.spines[side].set_linewidth(0.35)


def draw_d(page: Page, cd: dict, top: float, left: float) -> dict:
    page.letter(left - 4, top, "d")
    ab, gc, radial = cd["ab"], cd["gc"], cd["radial"]
    p = {key: next((number(row.get("P", row.get("p", "nan"))) for row in rows), math.nan)
         for key, rows in cd["tests"].items()}
    w, h, gap = W - left - 4, 17.0, 7.5
    ax = page.axes(left + 8, top + 6, w - 8, h)
    violin(ax, gc[ab == "A"], gc[ab == "B"], p["gc"], "gc")
    ax.set_ylabel("GC%", fontsize=6, labelpad=1)
    # Expression spans four decades from bin to bin, so it is drawn on log10 CPM; the test is of ranks,
    # which the logarithm does not move.
    ax = page.axes(left + 8, top + 6 + h + gap, w - 8, h)
    rna = {g: np.log10(v[v > 0]) for g, v in cd["rna"].items()}
    violin(ax, rna["A"], rna["B"], p["rna"], "rna")
    ax.set_ylabel("Gene expression\n(log10 CPM)", fontsize=6, labelpad=1)
    ax = page.axes(left + 8, top + 6 + 2 * (h + gap), w - 8, h)
    violin(ax, radial[ab == "A"], radial[ab == "B"], p["radial"], "radial")
    ax.set_ylabel("Radial distance from\nbarycenter", fontsize=6, labelpad=1)
    # The model, flattened onto its first two principal axes, coloured by compartment; the farther
    # a stretch on the third axis, the paler.
    xyz = cd["model"]
    placed = np.isfinite(xyz).all(1)
    rolled = np.stack([np.roll(xyz, k, 0) for k in (-1, 0, 1)])
    xyz = np.where(np.isfinite(rolled).all(2)[..., None], rolled, np.nan)
    with np.errstate(invalid="ignore"):
        xyz = np.nanmean(xyz, 0)
    centred = xyz[placed] - xyz[placed].mean(0)
    _, _, axes3 = np.linalg.svd(centred, full_matrices=False)
    flat = centred @ axes3.T
    order = np.flatnonzero(placed)
    calls = ab[order]
    segments, colours, depth = [], [], []
    for k in range(len(order) - 1):
        if order[k + 1] != order[k] + 1:
            continue
        segments.append(flat[k:k + 2, :2])
        colours.append(COMP_A if calls[k] == "A" else COMP_B if calls[k] == "B" else INK3)
        depth.append(flat[k:k + 2, 2].mean())
    depth = np.array(depth)
    shade = (depth - depth.min()) / (depth.max() - depth.min() + 1e-12)
    model_top = top + 6 + 3 * h + 2 * gap + 9
    ax = page.axes(left + 2, model_top + 3, w, H - model_top - 6)
    keep = np.argsort(shade)  # the far side first, the near side over it
    lc = LineCollection([segments[i] for i in keep],
                        colors=[faded(colours[i], 0.4 * (1 - shade[i])) for i in keep],
                        linewidths=[1.4 + 1.6 * shade[i] for i in keep], capstyle="round", joinstyle="round")
    ax.add_collection(lc)
    ax.set_aspect("equal")
    ax.autoscale()
    ax.axis("off")
    page.text(left + 2, model_top, "3D model of the WT map (pastis-NB),\nits first two principal axes",
              fontsize=5, color=INK2, ha="left")
    for k, (name, colour) in enumerate((("A", COMP_A), ("B", COMP_B))):
        page.fig.patches.append(Rectangle(((W - 15 + 7 * k) / W, 1 - (model_top + 2.2) / H), 1.6 / W, 1.6 / H,
                                          transform=page.fig.transFigure, color=colour))
        page.text(W - 13 + 7 * k, model_top + 0.4, name, fontsize=5, ha="left")
    return p


def numbers(a: dict, b: dict, cd: dict, p: dict) -> list[tuple[str, str]]:
    row = a["row"]
    gc, ab = cd["gc"], cd["ab"]
    slope, intercept, r2 = b["fit"]
    out = [
        ("a · C. necator origin (1-based)", f"{a['origin']:,}"),
        ("a · inter-arm enrichment", f"{number(row['enrichment']):.3f}"),
        ("a · after detrending along both arms", f"{number(row['detrended']):.3f}"),
        ("a · arms aligned over (Mb)", f"{number(row['reach']) / 1e6:.3f} of {number(row['armLength']) / 1e6:.3f}"),
        ("b · B. subtilis origin (1-based)", f"{b['origin']:,}"),
    ]
    out += [(f"b · reach, {label} (Mb)", f"{value / 1e6:.3f}") for label, value in zip(b["labels"], b["reach"])]
    out += [("b · reach against minutes, 15–45 min", f"{slope * 1e3:.1f} kb/min, intercept {intercept:.3f} Mb, r² = {r2:.3f}")]
    out += [("c · P. aeruginosa origin (1-based)", f"{cd['origin']:,}")]
    out += [(f"c · E1 along both arms, {strain['label']}: range", f"{np.nanmin(strain['e1']):.3f} to {np.nanmax(strain['e1']):.3f}")
            for strain in cd["strains"]]
    out += [
        ("d · bins A / B", f"{(ab == 'A').sum()} / {(ab == 'B').sum()}"),
        ("d · GC A / B (mean)", f"{np.nanmean(gc[ab == 'A']):.4f} / {np.nanmean(gc[ab == 'B']):.4f}"),
        ("d · GC, A against B: P", f"{p['gc']:.3g}"),
        ("d · radial A / B (mean)",
         f"{np.nanmean(cd['radial'][ab == 'A']):.3f} / {np.nanmean(cd['radial'][ab == 'B']):.3f}"),
        ("d · radial, A against B: P", f"{p['radial']:.3g}"),
        ("d · RNA-seq A / B (median CPM per 8-kb bin)",
         f"{np.nanmedian(cd['rna']['A']):.2f} / {np.nanmedian(cd['rna']['B']):.2f}"),
        ("d · RNA-seq, A against B: P", f"{p['rna']:.3g}"),
    ]
    return out


def main() -> int:
    a, b, cd = panel_a(), panel_b(), panel_cd()
    page = Page()
    y = draw_a(page, a, 3.0)
    y = draw_b(page, b, y + 5.0)
    y_cd = y + 5.0
    draw_c(page, cd, y_cd)
    p = draw_d(page, cd, y_cd, 13.0 + 3 * 33.5 + 6)
    for suffix in ("pdf", "svg"):
        page.fig.savefig(HERE / f"figureS3.{suffix}")
    page.fig.savefig(HERE / "figureS3.png", dpi=300)
    rows = numbers(a, b, cd, p)
    (HERE / "numbers.tsv").write_text("".join(f"{k}\t{v}\n" for k, v in rows))
    for k, v in rows:
        print(f"{k:<48} {v}")
    print("wrote", ", ".join(str((HERE / f"figureS3.{s}").relative_to(ROOT)) for s in ("pdf", "svg", "png")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
