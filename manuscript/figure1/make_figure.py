#!/usr/bin/env python
"""Fig. 1 (proposal): write figure1.svg from the yeast demo and run_analyses.sh's results.

    python manuscript/figure1/make_figure.py        # figure1.svg
    node manuscript/figure1/svg2pdf.mjs             # figure1.pdf and figure1.png

Needs numpy, cooler, pyBigWig and Pillow. Everything drawn is either a file of
demo/yeast/ or a result the app's command line wrote (results/, see
run_analyses.sh); the one picture of the app itself is ui-session.png, which
capture-ui.mjs shoots. The heatmaps are rasters, everything else —
tracks, models, text, arrows — is vector.

The page is 180 mm wide, in millimetres throughout (1 user unit = 1 mm), and
type is set in points: Helvetica/Arial, 5–7 pt, panel letters 8 pt bold.
"""

from __future__ import annotations

import base64
import io
import math
import re
import warnings
from dataclasses import dataclass
from pathlib import Path

import cooler
import numpy as np
import pyBigWig
from PIL import Image, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEMO = ROOT / "demo" / "yeast"
RES = HERE / "results"
BUILD = HERE / "build"
COOL = DEMO / "Yeast_microC_G2M_1kb.cool"
MCOOL = BUILD / "Yeast_microC_G2M.mcool"
UI_SHOT = HERE / "ui-session.png"

# --------------------------------------------------------------------------- style

PT = 25.4 / 72  # millimetres per point
W = 180.0
FONT = "Helvetica, Arial, 'Liberation Sans', sans-serif"
MONO = "Menlo, Consolas, 'DejaVu Sans Mono', monospace"
INK = "#1c1e21"
INK2 = "#4b5058"
INK3 = "#80868f"
RULE = "#d5d9df"
WASH = "#f3f5f8"

C1D = "#0072B2"  # one dimension: tracks, sequence, intervals
C2D = "#D55E00"  # two: contact maps
C3D = "#B5579A"  # three: models
DIM = {"1D": C1D, "2D": C2D, "3D": C3D}

ATAC = "#E69F00"
POL2 = "#009E73"
MNASE = "#56789A"
INSUL = C1D
HILITE = "#FFE7A3"  # the window the next column zooms into
LOOP = "#2E3A59"
BASES = {"A": "#3d9950", "C": "#2f6fb5", "G": "#d59225", "T": "#c8483f", "N": "#8b939c"}

# The app's `default` ramp (src/render/colormaps.ts, DEFAULT_STOPS) and RdBu_r.
DEFAULT_STOPS = ["#FFFEF9", "#FCF9CE", "#FFF2A9", "#FDE188", "#FFCA67", "#FAAA4B", "#F78E40",
                 "#F15C34", "#ED3024", "#D42027", "#B01F29", "#7A1128", "#1A0A10"]
RDBU_R_STOPS = ["#053061", "#2166AC", "#4393C3", "#92C5DE", "#D1E5F0", "#F7F7F7", "#FDDBC7",
                "#F4A582", "#D6604D", "#B2182B", "#67001F"]
VIRIDIS_STOPS = ["#440154", "#482878", "#3E4A89", "#31688E", "#26828E", "#1F9E89", "#35B779",
                 "#6DCD59", "#B4DE2C", "#FDE725"]


def ramp(stops: list[str], size: int = 256) -> np.ndarray:
    """`rampFromStops`: hex stops spread evenly, linearly interpolated, as uint8 RGB."""
    pts = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in stops], float)
    t = np.linspace(0, 1, size)
    at = np.linspace(0, 1, len(stops))
    return np.stack([np.round(np.interp(t, at, pts[:, c])) for c in range(3)], 1).astype(np.uint8)


LUT = ramp(DEFAULT_STOPS)
LUT_RDBU = ramp(RDBU_R_STOPS)
LUT_VIRIDIS = ramp(VIRIDIS_STOPS)


def lut_hex(lut: np.ndarray, t: float) -> str:
    r, g, b = lut[int(np.clip(t, 0, 1) * (len(lut) - 1))]
    return f"#{r:02x}{g:02x}{b:02x}"


def mix(hex_a: str, hex_b: str, t: float) -> str:
    a = [int(hex_a[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(hex_b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(a, b))


# --------------------------------------------------------------------------- text metrics

_FONT_FILES = {
    (False, False): "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    (True, False): "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    (False, True): "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    (True, True): "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
}
_FONTS: dict = {}


def tw(s: str, size: float, bold: bool = False, mono: bool = False) -> float:
    """Width in mm of `s` at `size` pt — Liberation Sans has Arial's metrics."""
    key = (bold, mono)
    if key not in _FONTS:
        _FONTS[key] = ImageFont.truetype(_FONT_FILES[key], 1000)
    return _FONTS[key].getlength(s) / 1000 * size * PT


# --------------------------------------------------------------------------- svg

def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def f(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".") if abs(v) < 1e6 else str(v)


def text(x, y, s, size=6.0, fill=INK, weight=None, anchor="start", mono=False, italic=False,
         spacing=None, raw=False, opacity=None, halo=None, rotate=None) -> str:
    attrs = [f'x="{f(x)}"', f'y="{f(y)}"', f'font-size="{f(size * PT)}"', f'fill="{fill}"']
    if mono:
        attrs.append(f'font-family="{MONO}"')
    if weight:
        attrs.append(f'font-weight="{weight}"')
    if italic:
        attrs.append('font-style="italic"')
    if anchor != "start":
        attrs.append(f'text-anchor="{anchor}"')
    if spacing is not None:
        attrs.append(f'letter-spacing="{f(spacing)}"')
    if opacity is not None:
        attrs.append(f'opacity="{opacity}"')
    if halo:
        attrs.append(f'stroke="{halo}" stroke-width="{f(0.5)}" paint-order="stroke" stroke-linejoin="round"')
    if rotate is not None:
        attrs.append(f'transform="rotate({f(rotate)} {f(x)} {f(y)})"')
    return f"<text {' '.join(attrs)}>{s if raw else esc(s)}</text>"


def rect(x, y, w, h, fill="none", stroke=None, sw=0.2, rx=0.0, opacity=None, extra="") -> str:
    a = f'x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{f(h)}" fill="{fill}"'
    if rx:
        a += f' rx="{f(rx)}"'
    if stroke:
        a += f' stroke="{stroke}" stroke-width="{f(sw)}"'
    if opacity is not None:
        a += f' opacity="{opacity}"'
    return f"<rect {a} {extra}/>"


def line(x1, y1, x2, y2, stroke=INK, sw=0.2, dash=None, cap="butt", opacity=None) -> str:
    a = f'x1="{f(x1)}" y1="{f(y1)}" x2="{f(x2)}" y2="{f(y2)}" stroke="{stroke}" stroke-width="{f(sw)}"'
    if dash:
        a += f' stroke-dasharray="{dash}"'
    if cap != "butt":
        a += f' stroke-linecap="{cap}"'
    if opacity is not None:
        a += f' opacity="{opacity}"'
    return f"<line {a}/>"


def path(d, fill="none", stroke=None, sw=0.2, opacity=None, extra="") -> str:
    a = f'd="{d}" fill="{fill}"'
    if stroke:
        a += f' stroke="{stroke}" stroke-width="{f(sw)}"'
    if opacity is not None:
        a += f' opacity="{opacity}"'
    return f"<path {a} {extra}/>"


def circle(cx, cy, r, fill="none", stroke=None, sw=0.2, opacity=None) -> str:
    a = f'cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="{fill}"'
    if stroke:
        a += f' stroke="{stroke}" stroke-width="{f(sw)}"'
    if opacity is not None:
        a += f' opacity="{opacity}"'
    return f"<circle {a}/>"


def image(x, y, w, h, png: bytes, extra="", smooth=False, mime="image/png") -> str:
    data = base64.b64encode(png).decode()
    rendering = "auto" if smooth else "pixelated"
    return (f'<image x="{f(x)}" y="{f(y)}" width="{f(w)}" height="{f(h)}" preserveAspectRatio="none" '
            f'style="image-rendering:{rendering}" xlink:href="data:{mime};base64,{data}" {extra}/>')


def png_bytes(rgba: np.ndarray, *, jpeg: bool = False) -> bytes:
    buf = io.BytesIO()
    im = Image.fromarray(rgba)
    if jpeg:
        im.convert("RGB").save(buf, "JPEG", quality=92, subsampling=0)
    else:
        im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def arrow_head(x, y, angle, size=0.9, fill=INK2) -> str:
    """A filled arrowhead with its tip at (x, y), pointing along `angle` (radians)."""
    a, s = angle, size
    p1 = (x - s * math.cos(a) + 0.42 * s * math.sin(a), y - s * math.sin(a) - 0.42 * s * math.cos(a))
    p2 = (x - s * math.cos(a) - 0.42 * s * math.sin(a), y - s * math.sin(a) + 0.42 * s * math.cos(a))
    return path(f"M{f(x)},{f(y)} L{f(p1[0])},{f(p1[1])} L{f(p2[0])},{f(p2[1])} Z", fill=fill)


def curve_arrow(x1, y1, x2, y2, stroke=INK2, sw=0.3, bend=0.5, head=0.9, dash=None, horizontal=True) -> str:
    """A cubic from (x1, y1) to (x2, y2) that leaves and arrives horizontally, with a head."""
    if horizontal:
        dx = (x2 - x1) * bend
        c1, c2 = (x1 + dx, y1), (x2 - dx, y2)
    else:
        dy = (y2 - y1) * bend
        c1, c2 = (x1, y1 + dy), (x2, y2 - dy)
    ang = math.atan2(y2 - c2[1], x2 - c2[0])
    # stop the stroke short of the tip so the head is clean
    ex, ey = x2 - head * 0.6 * math.cos(ang), y2 - head * 0.6 * math.sin(ang)
    d = f"M{f(x1)},{f(y1)} C{f(c1[0])},{f(c1[1])} {f(c2[0])},{f(c2[1])} {f(ex)},{f(ey)}"
    extra = 'stroke-linecap="round"' + (f' stroke-dasharray="{dash}"' if dash else "")
    return path(d, stroke=stroke, sw=sw, extra=extra) + arrow_head(x2, y2, ang, head, stroke)


def group(content: list[str] | str, transform: str | None = None, extra: str = "") -> str:
    body = content if isinstance(content, str) else "\n".join(content)
    t = f' transform="{transform}"' if transform else ""
    return f"<g{t} {extra}>\n{body}\n</g>"


# --------------------------------------------------------------------------- data: maps

def coarse_genome(clr: cooler.Cooler, binsize: int) -> tuple[np.ndarray, list[tuple[str, int, int]]]:
    """The whole genome on a `binsize` grid: the mean balanced contact over each block's
    valid fine cells, which is what a view of a coarser grid shows of a balanced map."""
    bins = clr.bins()[:]
    w = bins["weight"].to_numpy()
    ok = np.isfinite(w)
    starts = bins["start"].to_numpy()
    chroms = bins["chrom"].astype(str).to_numpy()
    sizes = clr.chromsizes
    offsets, layout, n = {}, [], 0
    for name, length in sizes.items():
        k = -(-int(length) // binsize)
        offsets[name] = n
        layout.append((name, n, n + k))
        n += k
    cid = np.array([offsets[c] for c in chroms]) + starts // binsize
    nvalid = np.bincount(cid[ok], minlength=n).astype(float)
    upper = np.zeros(n * n)
    fine_diag = np.zeros(n * n)
    for chunk in range(0, clr.info["nnz"], 2_000_000):
        px = clr.pixels()[chunk:chunk + 2_000_000]
        b1, b2, c = px["bin1_id"].to_numpy(), px["bin2_id"].to_numpy(), px["count"].to_numpy()
        v = c * w[b1] * w[b2]
        good = np.isfinite(v)
        b1, b2, v = b1[good], b2[good], v[good]
        key = cid[b1] * n + cid[b2]
        upper += np.bincount(key, weights=v, minlength=n * n)
        same = b1 == b2
        fine_diag += np.bincount(key[same], weights=v[same], minlength=n * n)
    upper = upper.reshape(n, n)
    fine_diag = fine_diag.reshape(n, n)
    full = upper + upper.T
    full[np.diag_indices(n)] = 2 * np.diag(upper) - np.diag(fine_diag)
    denom = np.outer(nvalid, nvalid)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(denom > 0, full / denom, np.nan)
    return mean, layout


def region_matrix(clr: cooler.Cooler, region: str, factor: int = 1) -> np.ndarray:
    """A balanced region, block-averaged by `factor` (NaN cells left out of each mean)."""
    m = clr.matrix(balance=True).fetch(region)
    if factor == 1:
        return m
    n = m.shape[0]
    k = -(-n // factor)
    pad = np.full((k * factor, k * factor), np.nan)
    pad[:n, :n] = m
    blocks = pad.reshape(k, factor, k, factor)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # a block of filtered bins is NaN, as it should be
        return np.nanmean(blocks, axis=(1, 3))


def auto_range(m: np.ndarray) -> tuple[float, float]:
    """The app's rule for a balanced map on log10: 1st to 99th percentile of the cells with contacts."""
    v = m[np.isfinite(m) & (m > 0)]
    lv = np.log10(v)
    return float(np.percentile(lv, 1)), float(np.percentile(lv, 99))


def colorize(values: np.ndarray, vmin: float, vmax: float, lut: np.ndarray, log: bool = True,
             nan_rgb=(255, 255, 255)) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        x = np.log10(values) if log else values
    t = (x - vmin) / (vmax - vmin)
    t = np.where(np.isfinite(values) & (values <= 0) if log else False, 0.0, t)
    idx = np.clip(np.round(np.nan_to_num(t, nan=0.0) * (len(lut) - 1)), 0, len(lut) - 1).astype(int)
    rgb = lut[idx]
    rgb[~np.isfinite(values)] = nan_rgb
    return rgb


def triangle(m: np.ndarray, vmin: float, vmax: float, width_px: int, depth: float | None = None,
             lut: np.ndarray = LUT, log: bool = True, flip: bool = False) -> np.ndarray:
    """The upper triangle of `m` turned 45° so its diagonal is the base: an RGBA image
    width_px wide, the apex up (down if `flip`). `depth` cuts it at that many bins apart."""
    n = m.shape[0]
    depth = n if depth is None else min(depth, n)
    h_px = max(1, int(round(width_px * depth / (2 * n))))
    xs = (np.arange(width_px) + 0.5) / width_px * n
    ys = (np.arange(h_px) + 0.5) / h_px * (depth / 2)
    if not flip:
        ys = ys[::-1]
    X, Y = np.meshgrid(xs, ys)
    A, B = X - Y, X + Y
    inside = (A >= 0) & (B < n) & (B - A <= depth)
    i = np.clip(np.floor(A).astype(int), 0, n - 1)
    j = np.clip(np.floor(B).astype(int), 0, n - 1)
    vals = m[i, j]
    rgb = colorize(vals, vmin, vmax, lut, log)
    alpha = np.where(inside, 255, 0).astype(np.uint8)
    return np.dstack([rgb, alpha])


def square(m: np.ndarray, vmin: float, vmax: float, scale: int, lut: np.ndarray, log=False) -> np.ndarray:
    rgb = colorize(m, vmin, vmax, lut, log)
    rgb = np.repeat(np.repeat(rgb, scale, 0), scale, 1)
    return np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)])


# --------------------------------------------------------------------------- data: tracks

class Tracks:
    def __init__(self):
        self.bw = {k: pyBigWig.open(str(DEMO / v)) for k, v in {
            "atac": "Yeast_ATAC.bw", "pol2": "Yeast_ChIP_Pol2-vs-input.bw", "mnase": "Yeast_MNase.bw",
            "rna+": "Yeast_RNA_fwd.bw", "rna-": "Yeast_RNA_rev.bw"}.items()}
        self.bw["insulation"] = pyBigWig.open(str(next((RES / "insulation").glob("*.bw"))))
        self.bw["radial"] = pyBigWig.open(str(next((RES / "spatial").glob("*radial--1.bw"))))

    def bins(self, key: str, chrom: str, start: int, end: int, n: int) -> np.ndarray:
        b = self.bw[key]
        end = min(end, b.chroms(chrom))
        v = np.array(b.stats(chrom, start, end, nBins=n, type="mean", exact=True), dtype=float)
        return v

    def genome(self, key: str, layout: list[tuple[str, int]], per_bp: float) -> np.ndarray:
        out = []
        for chrom, length in layout:
            k = max(1, int(round(length * per_bp)))
            out.append(self.bins(key, chrom, 0, length, k))
        return np.concatenate(out)


def load_genes() -> list[dict]:
    genes = []
    with open(DEMO / "Yeast_annotations.gtf") as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            p = line.split("\t")
            if len(p) < 9 or p[2] != "gene":
                continue
            name = re.search(r'gene_name "([^"]+)"', p[8])
            gid = re.search(r'gene_id "([^"]+)"', p[8])
            genes.append({"chrom": p[0], "start": int(p[3]) - 1, "end": int(p[4]), "strand": p[6],
                          "name": name.group(1) if name else (gid.group(1) if gid else "")})
    return genes


def load_sequence(chrom: str) -> str:
    seq, take = [], False
    with open(DEMO / "S288c_syn40-XIII.fa") as fh:
        for line in fh:
            if line.startswith(">"):
                if take:
                    break
                take = line[1:].split()[0] == chrom
                continue
            if take:
                seq.append(line.strip())
    return "".join(seq).upper()


def load_bed(p: Path) -> list[tuple[str, int, int]]:
    out = []
    for line in open(p):
        if line.startswith("#") or not line.strip():
            continue
        q = line.split("\t")
        out.append((q[0], int(q[1]), int(q[2])))
    return out


def load_bedpe(p: Path) -> list[tuple[str, int, int, str, int, int]]:
    out = []
    for line in open(p):
        if line.startswith("#") or not line.strip():
            continue
        q = line.split("\t")
        out.append((q[0], int(q[1]), int(q[2]), q[3], int(q[4]), int(q[5])))
    return out


def load_table(p: Path) -> tuple[list[str], np.ndarray]:
    rows = [l.rstrip("\n").split("\t") for l in open(p) if not l.startswith("#") and l.strip()]
    head = rows[0]
    body = np.array([[float(x) if x not in ("", "—") else np.nan for x in r[1:]] for r in rows[1:]])
    return head, body


# --------------------------------------------------------------------------- data: 3D

@dataclass
class Model:
    chrom: np.ndarray
    start: np.ndarray
    xyz: np.ndarray
    binsize: int


def load_model() -> Model:
    p = next((RES / "model").glob("*.bed3d"))
    rows = [l.split() for l in open(p) if l.strip() and not l.startswith("#")]
    chrom = np.array([r[0] for r in rows])
    start = np.array([int(r[1]) for r in rows])
    xyz = np.array([[float(v) for v in r[3:6]] for r in rows])
    return Model(chrom, start, xyz, int(rows[0][2]) - int(rows[0][1]))


def rotation(xyz: np.ndarray, yaw: float = 0.0, pitch: float = 0.0, roll: float = 0.0) -> np.ndarray:
    """Principal axes first (longest across), then a turn for a three-quarter view."""
    c = xyz - xyz.mean(0)
    _, _, vt = np.linalg.svd(c, full_matrices=False)
    R = vt.copy()
    if np.linalg.det(R) < 0:
        R[2] *= -1

    def rx(a):
        return np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])

    def ry(a):
        return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])

    def rz(a):
        return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])

    return rz(roll) @ rx(pitch) @ ry(yaw) @ R


def catmull(points: np.ndarray, k: int = 3) -> np.ndarray:
    """A Catmull–Rom spline through every bead, k points per segment."""
    if len(points) < 3:
        return points
    p = np.vstack([points[0], points, points[-1]])
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        for t in np.linspace(0, 1, k, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(points[-1])
    return np.array(out)


def chains(model: Model, keep: np.ndarray) -> list[np.ndarray]:
    """Runs of consecutive beads (same sequence, adjacent bins) among those kept: indices."""
    idx = np.flatnonzero(keep)
    runs, cur = [], [idx[0]] if len(idx) else []
    for a, b in zip(idx[:-1], idx[1:]):
        if model.chrom[a] == model.chrom[b] and model.start[b] - model.start[a] <= 2 * model.binsize:
            cur.append(b)
        else:
            runs.append(np.array(cur))
            cur = [b]
    if cur:
        runs.append(np.array(cur))
    return [r for r in runs if len(r) >= 2]


def draw_model(model: Model, R: np.ndarray, centre: np.ndarray, scale: float, cx: float, cy: float,
               colour_of, width: float, keep: np.ndarray, halo: str = "#ffffff", run: int = 9,
               fog: float = 0.55, depth_range: tuple[float, float] | None = None, halo_w: float = 0.22) -> str:
    """The model as a depth-sorted tube, in orthographic projection.

    Each chain of consecutive beads is splined through every bead and cut into runs
    of `run` spline steps (three to a bead); the runs are drawn far to near, each a
    coloured line over a white halo, thinner and paler with depth. The halo stops one
    step short of either end, so a run never cuts the one it continues — it only
    parts strands that cross."""
    P = (model.xyz - centre) @ R.T
    zs = P[keep, 2]
    zlo, zhi = depth_range if depth_range else (float(zs.min()), float(zs.max()))
    pieces = []
    for ch in chains(model, keep):
        pts = catmull(P[ch], 3)
        nseg = len(pts) - 1
        for s in range(0, nseg, run):
            e = min(nseg, s + run)
            seg = pts[s:e + 1]
            z = float(seg[:, 2].mean())
            depth = (z - zlo) / (zhi - zlo + 1e-9)  # 0 far, 1 near
            bead = ch[min(len(ch) - 1, (s + e) // 2 // 3)]
            col = colour_of(bead)
            if col is None:
                continue
            col = mix(col, "#ffffff", fog * (1 - depth) ** 1.5)
            wd = width * (0.72 + 0.56 * depth)
            xy = [(cx + x * scale, cy - y * scale) for x, y in seg[:, :2]]
            d = "M" + " L".join(f"{f(a)},{f(b)}" for a, b in xy)
            inner = xy[1:-1] if len(xy) >= 4 else xy
            dh = "M" + " L".join(f"{f(a)},{f(b)}" for a, b in inner)
            pieces.append((z, d, dh, col, wd))
    pieces.sort(key=lambda t: t[0])
    out = []
    for _, d, dh, col, wd in pieces:
        if halo_w > 0:
            out.append(path(dh, stroke=halo, sw=wd + halo_w, extra='stroke-linecap="butt" stroke-linejoin="round"'))
        out.append(path(d, stroke=col, sw=wd, extra='stroke-linecap="round" stroke-linejoin="round"'))
    return "\n".join(out)


# --------------------------------------------------------------------------- vector tracks

def area(x, y, w, h, v: np.ndarray, colour: str, vmax: float | None = None, baseline_at_bottom=True,
         sw: float = 0.0, opacity: float = 1.0, centred: bool = False) -> str:
    """A filled step profile of `v` over [x, x+w], scaled to h (or around a centre line)."""
    v = np.nan_to_num(np.asarray(v, float), nan=0.0)
    n = len(v)
    if centred:
        top = vmax if vmax else float(np.nanmax(np.abs(v)) or 1)
        mid = y + h / 2
        ys = mid - np.clip(v / top, -1, 1) * h / 2
        base = mid
    else:
        top = vmax if vmax else float(np.nanmax(v) or 1)
        ys = y + h - np.clip(v / top, 0, 1) * h
        base = y + h
    xs = x + np.arange(n + 1) * w / n
    d = [f"M{f(xs[0])},{f(base)}"]
    for i in range(n):
        d.append(f"L{f(xs[i])},{f(ys[i])} L{f(xs[i + 1])},{f(ys[i])}")
    d.append(f"L{f(xs[-1])},{f(base)} Z")
    return path(" ".join(d), fill=colour, opacity=opacity, stroke=colour if sw else None, sw=sw)


def polyline(x, y, w, h, v: np.ndarray, colour: str, lo: float, hi: float, sw=0.25) -> str:
    n = len(v)
    xs = x + (np.arange(n) + 0.5) * w / n
    ys = y + h - (np.clip(v, lo, hi) - lo) / (hi - lo) * h
    pts = [(a, b) for a, b in zip(xs, ys) if np.isfinite(b)]
    d = "M" + " L".join(f"{f(a)},{f(b)}" for a, b in pts)
    return path(d, stroke=colour, sw=sw, extra='stroke-linejoin="round" stroke-linecap="round"')


def genes_lane(x, y, w, h, genes, chrom, start, end, colour="#5b6169", names=None, name_size=4.6,
               arrows=True) -> list[str]:
    """Genes as boxes on two rows (+ above, − below); names for the ones listed."""
    out = []
    span = end - start
    mid = y + h / 2
    out.append(line(x, mid, x + w, mid, stroke=RULE, sw=0.12))
    for g in genes:
        if g["chrom"] != chrom or g["end"] <= start or g["start"] >= end:
            continue
        a = x + (max(g["start"], start) - start) / span * w
        b = x + (min(g["end"], end) - start) / span * w
        plus = g["strand"] == "+"
        gy = mid - h * 0.42 if plus else mid + h * 0.06
        gh = h * 0.36
        out.append(rect(a, gy, max(b - a, 0.12), gh, fill=colour))
        if arrows and b - a > 1.6:
            # a white chevron saying which way it reads
            cxm, cym = (a + b) / 2, gy + gh / 2
            s = gh * 0.32
            d = (f"M{f(cxm - s * 0.5)},{f(cym - s)} L{f(cxm + s * 0.5)},{f(cym)} L{f(cxm - s * 0.5)},{f(cym + s)}"
                 if plus else
                 f"M{f(cxm + s * 0.5)},{f(cym - s)} L{f(cxm - s * 0.5)},{f(cym)} L{f(cxm + s * 0.5)},{f(cym + s)}")
            out.append(path(d, stroke="#ffffff", sw=0.18, extra='stroke-linecap="round" stroke-linejoin="round"'))
        if names and g["name"] in names:
            ty = gy - 0.35 if plus else gy + gh + name_size * PT * 0.95
            out.append(text((a + b) / 2, ty, g["name"], size=name_size, fill=INK2, anchor="middle", italic=True))
    return out


# --------------------------------------------------------------------------- the panels

def panel_letter(x, y, letter, title) -> list[str]:
    return [text(x, y, letter, size=8, weight="bold", fill="#000000"),
            text(x + 3.6, y - 0.05, title, size=7, weight="bold", fill=INK)]


def chip(x, y, label, size=5.0, fill="#ffffff", stroke=None, colour=INK, pad=0.75, h=None, mono=False,
         bold=False, rx=None) -> tuple[list[str], float]:
    h = h or size * PT * 1.55
    wdt = tw(label, size, bold=bold, mono=mono) + 2 * pad
    out = [rect(x, y, wdt, h, fill=fill, stroke=stroke, sw=0.15, rx=rx if rx is not None else h / 2),
           text(x + pad, y + h / 2 + size * PT * 0.35, label, size=size, fill=colour, mono=mono,
                weight="bold" if bold else None)]
    return out, wdt


def dims_badge(x, y, a: str, b: str, op: str = "→", size=5.0) -> tuple[list[str], float]:
    """`2D → 1D`, each dimension in its colour, on a pale pill."""
    h = size * PT * 1.6
    wa, wo, wb = tw(a, size, bold=True), tw(f" {op} ", size), tw(b, size, bold=True)
    wdt = wa + wo + wb + 1.4
    yb = y + h / 2 + size * PT * 0.35
    out = [rect(x, y, wdt, h, fill="#ffffff", stroke=RULE, sw=0.15, rx=h / 2),
           text(x + 0.7, yb, a, size=size, weight="bold", fill=DIM.get(a, INK2)),
           text(x + 0.7 + wa, yb, f" {op} ", size=size, fill=INK3),
           text(x + 0.7 + wa + wo, yb, b, size=size, weight="bold", fill=DIM.get(b, INK2))]
    return out, wdt


def panel_a(x0, y0, w) -> list[str]:
    """The app itself: the real window, cropped to the deck, with numbered markers."""
    out = panel_letter(x0, y0 + 2.9, "a", "A Chromlens session in a browser tab")
    im = Image.open(UI_SHOT).convert("RGB")
    crop_h = 1362
    im = im.crop((0, 0, im.width, crop_h))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    wx, wy, ww = x0 + 3.0, y0 + 5.0, w - 3.4
    bar = 3.2
    sh = ww * crop_h / im.width
    wh = bar + sh
    # a soft vector shadow, then the window
    for k, op in enumerate([0.035, 0.03, 0.025, 0.02]):
        d = 0.25 * (k + 1)
        out.append(rect(wx - d * 0.3, wy + d * 0.6, ww + d * 0.6, wh + d * 0.4, fill="#0b1220", rx=1.5 + d,
                        opacity=op))
    out.append(rect(wx, wy, ww, wh, fill="#ffffff", rx=1.5))
    out.append(f'<clipPath id="win"><rect x="{f(wx)}" y="{f(wy)}" width="{f(ww)}" height="{f(wh)}" rx="1.5"/></clipPath>')
    inner = [rect(wx, wy, ww, bar, fill="#eceef2"), line(wx, wy + bar, wx + ww, wy + bar, stroke=RULE, sw=0.15)]
    for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        inner.append(circle(wx + 2.1 + i * 1.65, wy + bar / 2, 0.52, fill=c))
    url_w = 30
    inner.append(rect(wx + ww / 2 - url_w / 2, wy + 0.6, url_w, bar - 1.2, fill="#ffffff", rx=(bar - 1.2) / 2))
    inner.append(text(wx + ww / 2, wy + bar / 2 + 0.62, "chromlens.app", size=5, fill=INK2, anchor="middle"))
    inner.append(image(wx, wy + bar, ww, sh, buf.getvalue(), smooth=True))
    out.append(group(inner, extra='clip-path="url(#win)"'))
    out.append(rect(wx, wy, ww, wh, stroke="#c4c9d0", sw=0.2, rx=1.5))

    # markers, at screenshot pixels (3,200 across)
    def at(px, py):
        return wx + px / im.width * ww, wy + bar + py / im.width * ww

    marks = [
        (1, at(700, 146), "Files read in place, nothing uploaded"),
        (2, at(1150, 216), "Only the region and resolution in view"),
        (3, at(2080, 541), "A deck: 2D map, 3D model, 1D tracks"),
        (4, at(2905, 298), "Over 30 analyses, in a background worker"),
        (5, at(2768, 140), "Each step logged as its command line"),
    ]
    for n, (mx, my), _ in marks:
        out.append(circle(mx, my, 1.15, fill=INK, stroke="#ffffff", sw=0.3))
        out.append(text(mx, my + 0.62, str(n), size=5, weight="bold", fill="#ffffff", anchor="middle"))
    ky = wy + wh + 2.7
    col_w = ww / 2
    for k, (n, _, label) in enumerate(marks):
        cx = wx + (k // 3) * col_w
        cy = ky + (k % 3) * 2.3
        out.append(circle(cx + 1.0, cy - 0.62, 1.0, fill=INK))
        out.append(text(cx + 1.0, cy - 0.02, str(n), size=5, weight="bold", fill="#ffffff", anchor="middle"))
        out.append(text(cx + 2.6, cy, label, size=5, fill=INK2))
    return out


def wrap(words: list[str], width: float, size: float, sep: str = ", ") -> list[str]:
    lines_, cur = [], ""
    for i, wd in enumerate(words):
        piece = wd + (sep.rstrip() if i < len(words) - 1 else "")
        trial = (cur + " " + piece).strip() if cur else piece
        if cur and tw(trial, size) > width:
            lines_.append(cur)
            cur = piece
        else:
            cur = trial
    if cur:
        lines_.append(cur)
    return lines_


def panel_b(x0, y0, w) -> list[str]:
    """What it reads and what it computes, by dimension, on three cards."""
    out = panel_letter(x0, y0 + 2.9, "b", "1D, 2D and 3D data on one coordinate system")
    cards = [
        ("1D", "Sequence, reads, signal, intervals",
         ["FASTA", "2bit", "BAM", "VCF", "bigWig", "bedGraph", "wig", "BED", "bigBed", "GTF/GFF", "genePred",
          "bedMethyl", "barChart", "splice junctions", "cytoBand"],
         ["peaks (yapc, IDR)", "metaplots", "track correlation", "FRiP", "signal by group",
          "interval overlap", "motif search", "base composition", "ori/ter"]),
        ("2D", "Contact maps, interactions",
         [".cool", ".mcool", ".scool", ".hic", "HiC-Pro", "BEDPE", "interact", "longrange",
          ".pairs (binned on the fly)"],
         ["P(s)", "insulation", "directionality", "Hi-C score", "scalogram", "compartments, saddle",
          "loops, borders (Chromosight)", "APA, pile-ups", "virtual 4C", "HiCRep", "subsampling",
          "Boost-HiC", "inter-arm alignment", "single-cell QC"]),
        ("3D", "Models",
         ["g3d", "3dg", "bed3d"],
         ["pastis-NB", "ShRec3D", "model vs map", "spatial tracks"]),
    ]
    chip_h = 5.0 * PT * 1.55
    row_step = chip_h + 0.5
    gap = 0.5
    y = y0 + 5.0
    for dim, what, formats, tasks in cards:
        col = DIM[dim]
        left = x0 + 8.6
        label_w = 10.4
        cx0 = left + label_w
        right = x0 + w - 1.0
        body = []
        cy = y + 3.9
        # reads: the formats, as a line of text
        body.append(text(left, cy + 1.75, "reads", size=5, fill=INK3))
        for li, ln in enumerate(wrap(formats, right - cx0, 5)):
            body.append(text(cx0, cy + 1.75 + li * 2.2, ln, size=5, fill=INK))
            last = li
        cy += 2.2 * (last + 1) + 0.45
        # computes: the tasks, as chips
        body.append(text(left, cy + chip_h / 2 + 5 * PT * 0.35, "computes", size=5, fill=INK3))
        cx = cx0
        for it in tasks:
            wdt = tw(it, 5) + 1.5
            if cx + wdt > right and cx > cx0:
                cx = cx0
                cy += row_step
            c, _ = chip(cx, cy, it, fill=mix(col, "#ffffff", 0.82), colour=INK)
            body += c
            cx += wdt + gap
        cy += chip_h + 0.9
        h = cy - y
        out.append(rect(x0 + 0.2, y, w - 0.2, h, fill=mix(col, "#ffffff", 0.95), rx=1.2))
        out.append(rect(x0 + 0.2, y, 0.9, h, fill=col))
        out.append(text(x0 + 2.2, y + 3.5, dim, size=8, weight="bold", fill=col))
        gx, gy = x0 + 2.3, y + 5.0
        if dim == "1D":
            out.append(path(f"M{f(gx)},{f(gy + 1.9)} l0.8,-0.5 l0.7,-1.7 l0.8,1.4 l0.8,-0.6 l0.8,1.0 l0.7,0.4",
                            stroke=col, sw=0.3, extra='stroke-linejoin="round" stroke-linecap="round"'))
        elif dim == "2D":
            out.append(path(f"M{f(gx)},{f(gy + 2.2)} L{f(gx + 2.3)},{f(gy - 0.1)} L{f(gx + 4.6)},{f(gy + 2.2)} Z",
                            fill=mix(col, "#ffffff", 0.6), stroke=col, sw=0.22))
            out.append(path(f"M{f(gx)},{f(gy + 2.2)} L{f(gx + 1.15)},{f(gy + 1.05)} L{f(gx + 2.3)},{f(gy + 2.2)} Z",
                            fill=col))
        else:
            out.append(path(f"M{f(gx + 0.2)},{f(gy + 1.8)} C{f(gx + 0.6)},{f(gy - 0.9)} {f(gx + 3.1)},{f(gy + 2.9)} "
                            f"{f(gx + 2.6)},{f(gy + 0.4)} S{f(gx + 4.8)},{f(gy - 0.3)} {f(gx + 4.6)},{f(gy + 1.9)}",
                            stroke=col, sw=0.42, extra='stroke-linecap="round"'))
        out.append(text(left, y + 2.75, what, size=5.6, weight="bold", fill=INK))
        out += body
        y += h + 1.0
    return out


# --------------------------------------------------------------------------- panel c: the scales

def karyotype(x, y, w, h, layout, total, hilite: str | None, bands) -> list[str]:
    """Every chromosome as a rounded bar along the genome, the centromere as a waist."""
    out = []
    pos = 0
    for name, length in layout:
        a = x + pos / total * w
        b = x + (pos + length) / total * w
        is_hi = name == hilite
        colour = "#7d848d" if is_hi else ("#c3c8cf" if (layout.index((name, length)) % 2) else "#d6dae0")
        out.append(rect(a + 0.08, y, max(b - a - 0.16, 0.1), h, fill=colour, rx=min(h / 2, (b - a) / 2.5)))
        cen = bands.get(name)
        if cen is not None and b - a > 0.8:
            cxp = a + cen / length * (b - a)
            out.append(rect(cxp - 0.12, y - 0.05, 0.24, h + 0.1, fill="#ffffff"))
        pos += length
    return out


def ideogram(x, y, w, h, length, cen, colour="#9aa1aa") -> list[str]:
    cxp = x + cen / length * w
    out = [rect(x, y, cxp - x - 0.15, h, fill=colour, rx=h / 2),
           rect(cxp + 0.15, y, x + w - cxp - 0.15, h, fill=colour, rx=h / 2)]
    return out


def sequence_barcode(x, y, w, h, seq: str) -> list[str]:
    out = []
    n = len(seq)
    step = w / n
    # one path per base so the file stays small
    for base, colour in BASES.items():
        d = []
        for i, ch in enumerate(seq):
            if ch == base:
                d.append(f"M{f(x + i * step)},{f(y)} h{f(step)} v{f(h)} h{f(-step)} Z")
        if d:
            out.append(path(" ".join(d), fill=colour))
    return out


def panel_c(x0, y0, data) -> list[str]:
    out = panel_letter(x0, y0 + 2.9, "c", "One session, from the whole genome to single bases")
    cw, g = 32.2, 3.0
    xs = [x0 + 7.0 + k * (cw + g) for k in range(5)]
    y_head = y0 + 4.3
    y3, h3 = y0 + 10.3, 12.4
    y2, h2 = y3 + h3 + 0.7, cw / 2
    y1 = y2 + h2 + 1.2
    slots = [("annotation", 2.8), ("ATAC", 2.4), ("Pol II", 2.4), ("MNase", 2.4)]
    sgap = 0.5

    cols = data["cascade"]
    # row labels
    for label, sub, yy, hh in (("3D", "model", y3, h3), ("2D", "map", y2, h2)):
        out.append(text(x0, yy + hh / 2 + 0.2, label, size=7, weight="bold", fill=DIM[label]))
        out.append(text(x0, yy + hh / 2 + 2.3, sub, size=5, fill=INK3))
    out.append(text(x0, y1 + 2.45, "1D", size=7, weight="bold", fill=DIM["1D"]))

    for k, col in enumerate(cols):
        x = xs[k]
        out.append(text(x, y_head + 2.0, col["title"], size=6, weight="bold", fill=INK))
        out.append(text(x, y_head + 4.4, col["sub"], size=5, fill=INK3))
        if k < 4:
            # the zoom into the next column, at this one's right edge
            zx = x + cw
            out.append(path(f"M{f(zx - 0.55)},{f(y_head + 0.55)} l0.55,0.65 l-0.55,0.65", stroke=INK2, sw=0.22,
                            extra='stroke-linecap="round" stroke-linejoin="round"'))
            out.append(text(zx - 1.1, y_head + 2.0, col["zoom"], size=5, weight="bold", fill=INK2, anchor="end"))
        # ---- 3D
        if col.get("model3d") is not None:
            out.append(f'<clipPath id="c3d{k}"><rect x="{f(x)}" y="{f(y3)}" width="{f(cw)}" height="{f(h3)}"/></clipPath>')
            out.append(group(col["model3d"](x, y3, cw, h3), extra=f'clip-path="url(#c3d{k})"'))
        # ---- 2D
        if col.get("tri") is not None:
            out.append(image(x, y2, cw, h2, col["tri"]))
            out += col.get("tri_overlay", lambda *a: [])(x, y2, cw, h2)
        # ---- 1D
        yy = y1
        for s, (name, hh) in enumerate(slots):
            if s == 0:
                out += col["annotation"](x, yy, cw, hh)
            else:
                key = {"ATAC": "atac", "Pol II": "pol2", "MNase": "mnase"}[name]
                colour = {"ATAC": ATAC, "Pol II": POL2, "MNase": MNASE}[name]
                v = col["tracks"][key]
                out.append(area(x, yy, cw, hh, v, colour, vmax=col["vmax"][key]))
                out.append(line(x, yy + hh, x + cw, yy + hh, stroke=mix(colour, "#ffffff", 0.5), sw=0.1))
                if k == 0:
                    out.append(text(x0 + 6.6, yy + hh - 0.45, name, size=5, fill=colour, anchor="end"))
            yy += hh + sgap
        # the next column's window, as a band over the tracks
        if col.get("next") is not None:
            a, b = col["next"]
            out.insert(0, rect(x + a * cw, y1 - 0.4, max((b - a) * cw, 0.25), yy - y1 + 0.2, fill=HILITE))
        # the bp column's letters, in the room the 2D and 3D rows leave
        if col.get("letters") is not None:
            out += col["letters"](x, y3, cw, y2 + h2 - y3, y1)
    return out


# --------------------------------------------------------------------------- panel d: see ⇄ measure

def task_pill(x, y, w, title, dims, cmd, with_=None) -> tuple[list[str], float]:
    """A task: its name, the dimensions it crosses, the command that reruns it, and
    the second input it reads from the view, if any."""
    h = 6.3 if with_ is None else 9.0
    out = [rect(x, y, w, h, fill="#ffffff", stroke="#c9ced5", sw=0.18, rx=1.0)]
    out.append(text(x + 1.1, y + 2.5, title, size=6, weight="bold", fill=INK))
    b, bw = dims_badge(0, 0, *dims)
    out.append(group(b, transform=f"translate({f(x + w - bw - 0.8)} {f(y + 0.62)})"))
    out.append(text(x + 1.1, y + 4.95, cmd, size=5, mono=True, fill=INK2))
    if with_:
        out.append(text(x + 1.1, y + 7.75, "with", size=5, fill=INK3))
        cx = x + 1.1 + tw("with ", 5)
        for label, colour in with_:
            c, cwid = chip(0, 0, label, size=5, fill=mix(colour, "#ffffff", 0.8), colour=INK)
            out.append(group(c, transform=f"translate({f(cx)} {f(y + 5.85)})"))
            cx += cwid + 0.6
    return out, h


def eye_icon(x, y, s=1.0, colour=INK3) -> str:
    return (path(f"M{f(x - 1.3 * s)},{f(y)} Q{f(x)},{f(y - 1.25 * s)} {f(x + 1.3 * s)},{f(y)} "
                 f"Q{f(x)},{f(y + 1.25 * s)} {f(x - 1.3 * s)},{f(y)} Z", stroke=colour, sw=0.2) +
            circle(x, y, 0.42 * s, fill=colour))


def gauge_icon(x, y, s=1.0, colour=INK3) -> str:
    return (path(f"M{f(x - 1.2 * s)},{f(y + 0.6 * s)} A{f(1.2 * s)},{f(1.2 * s)} 0 0 1 {f(x + 1.2 * s)},{f(y + 0.6 * s)}",
                 stroke=colour, sw=0.22, extra='stroke-linecap="round"') +
            line(x, y + 0.6 * s, x + 0.65 * s, y - 0.25 * s, stroke=colour, sw=0.24, cap="round") +
            circle(x, y + 0.6 * s, 0.22 * s, fill=colour))


def panel_d(x0, y0, data) -> list[str]:
    # "See ⇄ measure", with the arrows drawn: neither Helvetica nor Arial has U+21C4
    out = [text(x0, y0 + 2.9, "d", size=8, weight="bold", fill="#000000"),
           text(x0 + 3.6, y0 + 2.85, "See", size=7, weight="bold", fill=INK)]
    ax = x0 + 3.6 + tw("See ", 7, bold=True)
    aw, ay = 3.0, y0 + 2.85 - 7 * PT * 0.36
    out.append(path(f"M{f(ax)},{f(ay - 0.42)} H{f(ax + aw)} l-0.7,-0.55", stroke=INK, sw=0.3,
                    extra='stroke-linecap="round" stroke-linejoin="round"'))
    out.append(path(f"M{f(ax + aw)},{f(ay + 0.42)} H{f(ax)} l0.7,0.55", stroke=INK, sw=0.3,
                    extra='stroke-linecap="round" stroke-linejoin="round"'))
    out.append(text(ax + aw + tw(" ", 7, bold=True) + 0.35, y0 + 2.85,
                    "measure: every output is the next input, across dimensions", size=7, weight="bold", fill=INK))
    S1, M1, S2, M2, S3 = ((x0, x0 + 29), (x0 + 29, x0 + 63.5), (x0 + 63.5, x0 + 97), (x0 + 97, x0 + 136),
                          (x0 + 136, x0 + 180))
    top, bottom = y0 + 4.6, y0 + 52.9
    laneA, laneB = (y0 + 9.6, y0 + 30.6), (y0 + 31.6, y0 + 52.6)
    for (a, b) in (M1, M2):
        out.append(rect(a + 0.6, top, b - a - 1.2, bottom - top, fill=WASH, rx=1.4))
    for (a, b), kind in ((S1, "see"), (M1, "measure"), (S2, "see"), (M2, "measure"), (S3, "see")):
        cx = (a + b) / 2
        label = "SEE" if kind == "see" else "MEASURE"
        sub = "drawn in the view" if kind == "see" else "a task, in the browser"
        lw = tw(label, 5.4, bold=True) + len(label) * 0.12
        icon = eye_icon if kind == "see" else gauge_icon
        out.append(icon(cx - lw / 2 - 1.9, top + 2.05, 0.95))
        out.append(text(cx - lw / 2, top + 2.65, label, size=5.4, weight="bold", fill=INK2, spacing=0.12))
        out.append(text(cx, top + 4.75, sub, size=5, fill=INK3, anchor="middle"))
    mid = (laneA[1] + laneB[0]) / 2
    out.append(line(S2[0] + 1, mid, x0 + 179, mid, stroke=RULE, sw=0.15, dash="0.6 0.6"))

    # ---- S1: the map both chains start from
    mx, mw = S1[0] + 0.8, 27.0
    mh = mw / 2
    my = mid + 3.2
    out.append(image(mx, my - mh, mw, mh, data["d_map"]))
    out.append(line(mx, my, mx + mw, my, stroke=INK3, sw=0.12))
    out.append(text(mx + mw / 2, my + 2.3, "yeast G2/M micro-C, 1 kb", size=5, fill=INK2, anchor="middle"))
    out.append(text(mx + mw / 2, my + 4.3, "shown: IV:1.0\u20131.4 Mb", size=5, fill=INK3, anchor="middle"))

    pw1, pw2 = M1[1] - M1[0] - 3.2, M2[1] - M2[0] - 3.2
    px1, px2 = M1[0] + 1.6, M2[0] + 1.6
    # ---- lane A: 2D -> 1D -> (1D x 1D, 1D -> 2D)
    yA1 = laneA[0] + 7.3
    p, hA1 = task_pill(px1, yA1, pw1, "Diamond insulation", ("2D", "1D"), "insulation --window 10")
    out += p
    yA2a, yA2b = laneA[0] + 0.5, laneA[0] + 10.9
    p, hA2a = task_pill(px2, yA2a, pw2, "Metaplot, correlation", ("1D", "1D"), "metaplot --features borders",
                        with_=[("Pol II ChIP-seq", POL2), ("ATAC", ATAC)])
    out += p
    p, hA2b = task_pill(px2, yA2b, pw2, "Domain pile-up", ("1D", "2D"), "apa --mode scaled",
                        with_=[("the map", C2D)])
    out += p
    out += data["d_borders"](S2[0] + 1.2, laneA[0] + 0.6, S2[1] - S2[0] - 2.4, laneA[1] - laneA[0] - 1.2)
    out += data["d_metaplot"](S3[0] + 1.4, yA2a, S3[1] - S3[0] - 1.4, hA2a)
    out += data["d_pileup"](S3[0] + 1.4, yA2b - 0.4, S3[1] - S3[0] - 1.4, hA2b + 0.8)

    # ---- lane B: 2D -> 3D -> (3D -> 2D, 3D -> 1D), coloured 1D -> 3D
    yB1 = laneB[0] + 7.3
    p, hB1 = task_pill(px1, yB1, pw1, "Model from the map", ("2D", "3D"), "reconstruct3d --method nb")
    out += p
    yB2a, yB2b = laneB[0] + 1.4, laneB[0] + 12.2
    p, hB2a = task_pill(px2, yB2a, pw2, "Model versus map", ("3D", "2D"), "structuremap --region IV")
    out += p
    p, hB2b = task_pill(px2, yB2b, pw2, "Spatial tracks", ("3D", "1D"), "spatialtracks")
    out += p
    out += data["d_model"](S2[0] + 1.2, laneB[0] + 0.4, S2[1] - S2[0] - 2.4, laneB[1] - laneB[0] - 0.8)
    out += data["d_versus"](S3[0] + 1.4, yB2a - 1.4, S3[1] - S3[0] - 1.4, hB2a + 2.8)
    out += data["d_radial"](S3[0] + 1.4, yB2b - 0.6, S3[1] - S3[0] - 1.4, hB2b + 1.2)

    # ---- arrows: grey into a task (what is in view), coloured out of it (by what it returns)
    a_in = INK3
    cA1, cB1 = yA1 + hA1 / 2, yB1 + hB1 / 2
    out.append(curve_arrow(mx + mw * 0.74, my - mh * 0.5, px1, cA1, stroke=a_in, sw=0.3))
    out.append(curve_arrow(mx + mw * 0.74, my - mh * 0.3, px1, cB1, stroke=a_in, sw=0.3))
    out.append(curve_arrow(px1 + pw1, cA1, S2[0] + 1.4, cA1, stroke=C1D, sw=0.42))
    out.append(curve_arrow(px1 + pw1, cB1, S2[0] + 1.4, cB1, stroke=C3D, sw=0.42))
    srcA, srcB = laneA[0] + 10.4, laneB[0] + 10.5
    for (yp, hp, src_y, colour) in ((yA2a, hA2a, srcA, C1D), (yA2b, hA2b, srcA, C2D),
                                     (yB2a, hB2a, srcB, C2D), (yB2b, hB2b, srcB, C1D)):
        cy = yp + hp / 2
        out.append(curve_arrow(S2[1] - 1.0, src_y, px2, cy, stroke=a_in, sw=0.3))
        out.append(curve_arrow(px2 + pw2, cy, S3[0] + 1.2, cy, stroke=colour, sw=0.42))

    # ---- the loop back: every result is in the session
    ry = y0 + 54.7
    d = (f"M{f(x0 + 178.6)},{f(laneB[1] - 0.6)} C{f(x0 + 179.6)},{f(ry)} {f(x0 + 178)},{f(ry)} {f(x0 + 172)},{f(ry)} "
         f"L{f(x0 + 9)},{f(ry)} C{f(x0 + 3.2)},{f(ry)} {f(x0 + 1.4)},{f(ry - 0.4)} {f(x0 + 1.4)},{f(my + 5.6)}")
    out.append(path(d, stroke=INK2, sw=0.35, extra='stroke-linecap="round" stroke-dasharray="1.1 0.7"'))
    out.append(arrow_head(x0 + 1.4, my + 5.2, -math.pi / 2, 1.0, INK2))
    msg = ("Every result is a track, a feature set, a map or a model of the session, so the next task can read it; "
           "each step is logged as its chromlens-run command and replays on other maps")
    mwid = tw(msg, 5)
    out.append(rect(x0 + 90 - mwid / 2 - 1.2, ry - 1.3, mwid + 2.4, 2.6, fill="#ffffff"))
    out.append(text(x0 + 90, ry + 0.65, msg, size=5, fill=INK2, anchor="middle"))
    return out


# --------------------------------------------------------------------------- the data each panel draws

def prepare() -> dict:
    clr = cooler.Cooler(str(COOL))
    tracks = Tracks()
    genes = load_genes()
    seq_iv = load_sequence("IV")
    model = load_model()
    layout = [(c, int(n)) for c, n in clr.chromsizes.items()]
    total = sum(n for _, n in layout)
    iv_len = dict(layout)["IV"]
    cen = {}
    for line_ in open(DEMO / "Yeast_cytobands.txt"):
        if line_.startswith("#") or not line_.strip():
            continue
        p = line_.rstrip("\n").split("\t")
        if len(p) >= 5 and p[4] == "acen":
            cen[p[0]] = (cen[p[0]] + int(p[2])) / 2 if p[0] in cen else int(p[1])
    loops = load_bedpe(next((RES / "loops").glob("*.bedpe")))
    domains = load_bed(next((RES / "insulation").glob("*domains.bed")))
    borders = load_bed(next((RES / "insulation").glob("*boundaries.bed")))

    # ---- the four maps of the cascade, and the window each column hands the next
    windows = [None, ("IV", 0, iv_len), ("IV", 1_000_000, 1_400_000), ("IV", 1_250_000, 1_290_000),
               ("IV", 1_267_150, 1_267_650)]
    print("maps: genome")
    m_genome, glayout = coarse_genome(clr, 32_000)
    print("maps: IV, locus, gene")
    m_iv = region_matrix(clr, "IV", 4)
    m_locus = region_matrix(clr, "IV:1000001-1400000")
    m_gene = region_matrix(clr, "IV:1250001-1290000")

    def tri_png(m, width_px=1000, depth=None, lut=LUT):
        lo, hi = auto_range(m)
        return png_bytes(triangle(m, lo, hi, width_px, depth, lut))

    tri = [tri_png(m_genome), tri_png(m_iv), tri_png(m_locus), tri_png(m_gene, 960)]

    offsets, pos = {}, 0
    for c, n in layout:
        offsets[c] = pos
        pos += n
    iv_frac = (offsets["IV"] / total, (offsets["IV"] + iv_len) / total)

    def outline(a, b, x, y, w, h, colour=INK, sw=0.22):
        # a sub-window's own triangle on the base of a full one
        xa, xb = x + a * w, x + b * w
        apex = y + h - (b - a) * w / 2
        return path(f"M{f(xa)},{f(y + h)} L{f((xa + xb) / 2)},{f(apex)} L{f(xb)},{f(y + h)}",
                    stroke=colour, sw=sw, extra='stroke-linejoin="round"')

    def ov_genome(x, y, w, h):
        out = []
        for c, n in layout[1:]:
            a = offsets[c] / total
            # chromosome edges, as the two 45° lines from the base
            xa = x + a * w
            out.append(path(f"M{f(xa)},{f(y + h)} L{f(xa - min(a, 1 - a) * w)},{f(y + h - min(a, 1 - a) * w)}",
                            stroke="#ffffff", sw=0.08, opacity=0.8))
            out.append(path(f"M{f(xa)},{f(y + h)} L{f(xa + min(a, 1 - a) * w)},{f(y + h - min(a, 1 - a) * w)}",
                            stroke="#ffffff", sw=0.08, opacity=0.8))
        out.append(outline(*iv_frac, x, y, w, h))
        return out

    def ov_iv(x, y, w, h):
        return [outline(1_000_000 / iv_len, 1_400_000 / iv_len, x, y, w, h)]

    def ov_locus(x, y, w, h):
        out = []
        s0, s1 = 1_000_000, 1_400_000
        for c1, a1, b1, c2, a2, b2 in loops:
            if c1 != "IV" or a1 < s0 or b2 > s1:
                continue
            u, v = ((a1 + b1) / 2 - s0) / (s1 - s0), ((a2 + b2) / 2 - s0) / (s1 - s0)
            out.append(circle(x + (u + v) / 2 * w, y + h - (v - u) / 2 * w, 0.36, stroke=LOOP, sw=0.1, opacity=0.85))
        out.append(outline(0.625, 0.725, x, y, w, h))
        return out

    def ov_gene(x, y, w, h):
        a = (1_267_471 - 1_250_000) / 40_000
        return [path(f"M{f(x + a * w)},{f(y + h + 0.05)} l-0.55,0.75 h1.1 Z", fill=INK)]

    # ---- tracks under each column
    def col_tracks(kind, win, n):
        out = {}
        for key in ("atac", "pol2", "mnase"):
            if kind == "genome":
                out[key] = tracks.genome(key, layout, n / total)
            else:
                out[key] = tracks.bins(key, win[0], win[1], win[2], n)
        return out

    tr = [col_tracks("genome", None, 160), col_tracks("r", windows[1], 160), col_tracks("r", windows[2], 200),
          col_tracks("r", windows[3], 200), col_tracks("r", windows[4], 250)]

    def vmax_of(t):
        return {k: float(np.nanpercentile(v, 99.5)) if np.isfinite(v).any() else 1.0 for k, v in t.items()}

    # ---- annotation lanes
    def ann_genome(x, y, w, h):
        out = karyotype(x, y + h * 0.1, w, h * 0.8, layout, total, "IV", cen)
        a, b = iv_frac
        out.append(text(x + (a + 0.66 * (b - a)) * w, y + h * 0.5 + 0.62, "IV", size=5, weight="bold",
                        fill="#ffffff", anchor="middle"))
        return out

    def ann_iv(x, y, w, h):
        return ideogram(x, y + h * 0.18, w, h * 0.64, iv_len, cen["IV"])

    def ann_locus(x, y, w, h):
        return genes_lane(x, y, w, h, genes, "IV", 1_000_000, 1_400_000, arrows=False)

    def ann_gene(x, y, w, h):
        return genes_lane(x, y, w, h, genes, "IV", 1_250_000, 1_290_000)

    seq_win = seq_iv[1_267_150:1_267_650]

    def ann_bp(x, y, w, h):
        out = sequence_barcode(x, y + 0.1, w, h * 0.5, seq_win)
        a = (1_267_470 - 1_267_150) / 500 * w
        gy = y + h * 0.78
        out.append(line(x + a, gy, x + w, gy, stroke="#5b6169", sw=0.55))
        out.append(path(f"M{f(x + w - 0.1)},{f(gy)} l-0.9,-0.6 v1.2 Z", fill="#5b6169"))
        out.append(text(x + a - 0.6, gy + 0.62, "UTP5", size=5, fill=INK2, anchor="end", italic=True))
        return out

    # the bases themselves, magnified, where the 2D and 3D rows have stopped
    letters_start = 1_267_470 - 9
    letters = seq_iv[letters_start:letters_start + 27]

    def letters_box(x, y, w, h, y_1d):
        out = []
        size = 5.2
        cwid = tw("A", size, bold=True, mono=True) * 1.04
        n = len(letters)
        bw = n * cwid + 1.6
        bx = x + (w - bw) / 2
        by = y + h - 13.6
        bh = 12.2
        # each dimension stops at its own finest unit
        lx, ly = x + 4.0, y + 2.4
        out.append(text(lx - 1.4, ly, "finest unit drawn", size=5, fill=INK3))
        rows_ = [("3D", "bead", "5 kb"), ("2D", "bin", "1 kb"), ("1D", "base", "1 bp")]
        for r_, (dim_, unit_, size_) in enumerate(rows_):
            yy_ = ly + 2.5 + r_ * 2.35
            if dim_ == "3D":
                out.append(circle(lx, yy_ - 0.6, 0.75, fill=C3D))
            elif dim_ == "2D":
                out.append(rect(lx - 0.7, yy_ - 1.3, 1.4, 1.4, fill=C2D))
            else:
                out.append(text(lx, yy_, "A", size=5.2, weight="bold", mono=True, fill=BASES["A"], anchor="middle"))
            out.append(text(lx + 1.6, yy_, f"{dim_}", size=5, weight="bold", fill=DIM[dim_]))
            out.append(text(lx + 1.6 + tw("3D ", 5, bold=True), yy_, f"one {unit_}: {size_}", size=5, fill=INK2))
        out.append(rect(bx, by, bw, bh, fill="#ffffff", stroke="#c9ced5", sw=0.18, rx=0.9))
        # where these bases are in the barcode below
        sa = x + (letters_start - 1_267_150) / 500 * w
        sb = x + (letters_start + n - 1_267_150) / 500 * w
        out.append(line(bx, by + bh, sa, y_1d + 0.1, stroke=INK3, sw=0.12, dash="0.5 0.4"))
        out.append(line(bx + bw, by + bh, sb, y_1d + 0.1, stroke=INK3, sw=0.12, dash="0.5 0.4"))
        ty = by + 4.3
        for i, ch in enumerate(letters):
            out.append(text(bx + 0.8 + (i + 0.5) * cwid, ty, ch, size=size, fill=BASES.get(ch, INK3), weight="bold",
                            mono=True, anchor="middle"))
        # the start codon and the reading frame from it
        k0 = 9
        out.append(rect(bx + 0.8 + k0 * cwid - 0.1, ty - 2.3, 3 * cwid + 0.2, 3.0, stroke=INK, sw=0.18, rx=0.4))
        codon = {"ATG": "M", "GAT": "D", "TCT": "S", "CCT": "P", "GTT": "V", "CTA": "L"}
        for c in range(6):
            cod = letters[k0 + 3 * c:k0 + 3 * c + 3]
            aa = codon.get(cod, "")
            cxm = bx + 0.8 + (k0 + 3 * c + 1.5) * cwid
            out.append(rect(cxm - 1.5 * cwid + 0.12, ty + 1.0, 3 * cwid - 0.24, 2.2, fill="#eef0f3", rx=0.3))
            out.append(text(cxm, ty + 2.65, aa, size=5, fill=INK, anchor="middle", weight="bold"))
        out.append(text(bx + 0.9, by + bh - 0.9, "IV:1,267,462", size=5, fill=INK3, mono=False))
        out.append(text(bx + bw - 0.9, by + bh - 0.9, "UTP5 start", size=5, fill=INK2, anchor="end", italic=True))
        return out

    # ---- the model: one projection for every column, zoomed onto the window
    R = rotation(model.xyz, yaw=0.35, pitch=-0.55, roll=0.15)
    P_all = (model.xyz - model.xyz.mean(0)) @ R.T
    iv = model.chrom == "IV"
    in_locus = iv & (model.start >= 1_000_000) & (model.start < 1_400_000)
    in_gene = iv & (model.start >= 1_250_000) & (model.start < 1_290_000)
    pol2_bead = np.array(tracks.bins("pol2", "IV", 0, iv_len, -(-iv_len // model.binsize)), float)
    pol2_all = {}
    for c, n in layout:
        pol2_all[c] = np.array(tracks.bins("pol2", c, 0, n, -(-n // model.binsize)), float)
    bead_pol2 = np.array([pol2_all[c][s // model.binsize] if s // model.binsize < len(pol2_all[c]) else np.nan
                          for c, s in zip(model.chrom, model.start)])
    lo_p, hi_p = np.nanpercentile(bead_pol2, 5), np.nanpercentile(bead_pol2, 97)

    def pol2_colour(i):
        v = bead_pol2[i]
        if not np.isfinite(v):
            return "#bfc4cb"
        return lut_hex(LUT_VIRIDIS, (v - lo_p) / (hi_p - lo_p))

    centre = model.xyz.mean(0)

    def fit(keep, x, y, w, h, pad=0.9):
        P = P_all[keep]
        lo, hi = P[:, :2].min(0), P[:, :2].max(0)
        s = min(w * pad / (hi[0] - lo[0]), h * pad / (hi[1] - lo[1]))
        mid = (lo + hi) / 2
        return s, x + w / 2 - mid[0] * s, y + h / 2 + mid[1] * s

    everything = np.ones(len(model.chrom), bool)
    zr = (float(P_all[:, 2].min()), float(P_all[:, 2].max()))

    def m3d_genome(x, y, w, h):
        s, cx, cy = fit(everything, x, y, w, h, 0.94)
        grey = draw_model(model, R, centre, s, cx, cy, lambda i: "#c3c8cf", 0.22, ~iv, depth_range=zr, fog=0.45)
        hi_ = draw_model(model, R, centre, s, cx, cy, lambda i: C3D, 0.36, iv, depth_range=zr, fog=0.25)
        return [grey, hi_]

    def m3d_iv(x, y, w, h):
        s, cx, cy = fit(iv, x, y, w, h, 0.92)
        ghost = draw_model(model, R, centre, s, cx, cy, lambda i: "#e6e9ed", 0.2, ~iv, depth_range=zr, fog=0.0)
        body = draw_model(model, R, centre, s, cx, cy, lambda i: C3D if in_locus[i] else "#8d949d", 0.42, iv,
                          depth_range=zr, fog=0.3)
        return [ghost, body]

    def m3d_locus(x, y, w, h):
        s, cx, cy = fit(in_locus, x - 2.0, y, w, h, 0.92)
        ghost = draw_model(model, R, centre, s, cx, cy, lambda i: "#e6e9ed", 0.3, ~in_locus, depth_range=zr, fog=0.0,
                           halo_w=0.0)
        body = draw_model(model, R, centre, s, cx, cy, pol2_colour, 0.6, in_locus, depth_range=zr, fog=0.2, run=3)
        out = [ghost, body]
        # its colour key, standing at the right edge
        kx, ky, kh = x + w - 1.2, y + 1.2, 6.0
        for t in np.linspace(0, 1, 24):
            out.append(rect(kx, ky + (1 - t) * kh - kh / 24, 0.9, kh / 24 + 0.02, fill=lut_hex(LUT_VIRIDIS, t)))
        out.append(text(kx - 0.5, ky + kh - 0.1, "Pol II", size=5, fill=INK2, anchor="end"))
        return out

    def m3d_gene(x, y, w, h):
        s, cx, cy = fit(in_gene, x, y, w, h, 0.62)
        ghost = draw_model(model, R, centre, s, cx, cy, lambda i: "#e6e9ed", 0.5, in_locus & ~in_gene,
                           depth_range=zr, fog=0.0)
        out = [ghost]
        idx = np.flatnonzero(in_gene)
        P = P_all[idx]
        pts = [(cx + p[0] * s, cy - p[1] * s) for p in P]
        out.append(path("M" + " L".join(f"{f(a)},{f(b)}" for a, b in pts), stroke="#9aa1aa", sw=0.25))
        order = np.argsort(P[:, 2])
        r = 1.15
        for o in order:
            (a, b), i = pts[o], idx[o]
            colour = pol2_colour(i)
            out.append(circle(a, b, r, fill=colour, stroke="#ffffff", sw=0.18))
            out.append(circle(a - r * 0.32, b - r * 0.32, r * 0.32, fill="#ffffff", opacity=0.35))
        return out

    cascade = [
        dict(title="Genome", sub="12.1 Mb · 32-kb bins", zoom="×8", tri=tri[0], tri_overlay=ov_genome,
             model3d=m3d_genome, annotation=ann_genome, tracks=tr[0], vmax=vmax_of(tr[0]), next=iv_frac),
        dict(title="Chromosome IV", sub="1.53 Mb · 4-kb bins", zoom="×4", tri=tri[1], tri_overlay=ov_iv,
             model3d=m3d_iv, annotation=ann_iv, tracks=tr[1], vmax=vmax_of(tr[1]),
             next=(1_000_000 / iv_len, 1_400_000 / iv_len)),
        dict(title="Locus", sub="400 kb · 1-kb bins · loops", zoom="×10", tri=tri[2], tri_overlay=ov_locus,
             model3d=m3d_locus, annotation=ann_locus, tracks=tr[2], vmax=vmax_of(tr[2]), next=(0.625, 0.725)),
        dict(title="Gene", sub="40 kb · 1-kb bins, 5-kb beads", zoom="×80", tri=tri[3], tri_overlay=ov_gene,
             model3d=m3d_gene, annotation=ann_gene, tracks=tr[3], vmax=vmax_of(tr[3]),
             next=((1_267_150 - 1_250_000) / 40_000, (1_267_650 - 1_250_000) / 40_000)),
        dict(title="Base pairs", sub="500 bp · single bases", tri=None, model3d=None,
             annotation=ann_bp, tracks=tr[4], vmax=vmax_of(tr[4]), letters=letters_box),
    ]

    # ---- panel d: the chain
    d_map = tri_png(m_locus, 900)

    s0, s1 = 1_000_000, 1_400_000
    lo_l, hi_l = auto_range(m_locus)
    depth = 180
    band_png = png_bytes(triangle(m_locus, lo_l, hi_l, 1000, depth))
    ins = tracks.bins("insulation", "IV", s0, s1, 400)
    b_in = [(a, b) for c, a, b in borders if c == "IV" and s0 <= a < s1]
    d_in = [(a, b) for c, a, b in domains if c == "IV" and a >= s0 and b <= s1]

    def d_borders(x, y, w, h):
        out = []
        th = w * depth / (2 * 400)
        out.append(image(x, y, w, th, band_png))
        for a, b in d_in:
            u, v = (a - s0) / (s1 - s0), (b - s0) / (s1 - s0)
            span = min(v - u, depth / 400)
            xa, xb = x + u * w, x + v * w
            if v - u <= depth / 400:
                d = f"M{f(xa)},{f(y + th)} L{f((xa + xb) / 2)},{f(y + th - (v - u) * w / 2)} L{f(xb)},{f(y + th)}"
            else:
                yt = y + th - span * w / 2
                d = (f"M{f(xa)},{f(y + th)} L{f(xa + span * w / 2)},{f(yt)} L{f(xb - span * w / 2)},{f(yt)} "
                     f"L{f(xb)},{f(y + th)}")
            out.append(path(d, stroke=C1D, sw=0.2, extra='stroke-linejoin="round"'))
        ty = y + th + 0.7
        thh = 4.2
        v = np.nan_to_num(ins)
        lo_i, hi_i = np.nanpercentile(ins, 1), np.nanpercentile(ins, 99)
        out.append(line(x, ty + thh * (hi_i / (hi_i - lo_i)), x + w, ty + thh * (hi_i / (hi_i - lo_i)),
                        stroke=RULE, sw=0.1))
        out.append(polyline(x, ty, w, thh, v, C1D, lo_i, hi_i, sw=0.28))
        for a, b in b_in:
            u = ((a + b) / 2 - s0) / (s1 - s0)
            out.append(line(x + u * w, ty + thh + 0.35, x + u * w, ty + thh + 1.25, stroke=C1D, sw=0.22))
        out.append(text(x, ty + thh + 3.5, "insulation track, borders, domains", size=5, fill=INK2))
        out.append(text(x, ty + thh + 5.6, f"{len(borders):,} borders, {len(domains):,} domains", size=5,
                        fill=INK3))
        return out

    head, mp = load_table(next((RES / "metaplot").glob("*metaplot.tsv")))
    dist = np.array([float(l.split("\t")[0]) for l in open(next((RES / "metaplot").glob("*metaplot.tsv")))
                     if not l.startswith("#") and re.match(r"^-?\d", l)])
    pol_mean, atac_mean = mp[:, 0], mp[:, 3]
    flank = np.abs(dist) > 8000
    pol_fold, atac_fold = pol_mean / pol_mean[flank].mean(), atac_mean / atac_mean[flank].mean()
    centre_i = np.argsort(np.abs(dist))[:2]
    pol_peak, atac_peak = float(pol_fold[centre_i].mean()), float(atac_fold[centre_i].mean())
    corr = {}
    for l in open(next((RES / "trackcorr").glob("*table.tsv"))):
        if l.startswith("#") or l.startswith("a\t"):
            continue
        a, b, r = l.rstrip("\n").split("\t")
        corr[(a, b)] = float(r)
    r_ins_pol = next(v for (a, b), v in corr.items() if "insulation" in a and "Pol2" in b)

    def d_metaplot(x, y, w, h):
        out = []
        pw, ph = 17.0, h - 3.2
        px, py = x, y + 0.6
        hi_f = max(atac_fold.max(), pol_fold.max()) * 1.05
        out.append(line(px, py + ph, px + pw, py + ph, stroke=INK3, sw=0.12))
        out.append(line(px + pw / 2, py, px + pw / 2, py + ph, stroke=INK3, sw=0.12, dash="0.5 0.4"))
        for v, colour in ((atac_fold, ATAC), (pol_fold, POL2)):
            xs_ = px + (dist - dist.min()) / (dist.max() - dist.min()) * pw
            ys_ = py + ph - (v - 0.8) / (hi_f - 0.8) * ph
            out.append(path("M" + " L".join(f"{f(a)},{f(b)}" for a, b in zip(xs_, ys_)), stroke=colour, sw=0.32,
                            extra='stroke-linejoin="round"'))
        out.append(text(px, py + ph + 2.0, "−10 kb", size=5, fill=INK3))
        out.append(text(px + pw / 2, py + ph + 2.0, "border", size=5, fill=INK3, anchor="middle"))
        out.append(text(px + pw, py + ph + 2.0, "+10", size=5, fill=INK3, anchor="end"))
        tx = px + pw + 1.6
        out.append(text(tx, y + 2.3, f"Pol II {pol_peak:.1f}×", size=5.5, weight="bold", fill=POL2))
        out.append(text(tx, y + 4.6, f"ATAC {atac_peak:.1f}×", size=5.5, weight="bold", fill=ATAC))
        out.append(text(tx, y + 6.9, "at the borders", size=5, fill=INK2))
        out.append(text(tx, y + 9.2, f"ρ(insulation, Pol II) = {r_ins_pol:.2f}".replace("-", "−"),
                        size=5, fill=INK2))
        return out

    head_p, pile = load_table(next((RES / "domains").glob("*apa-0.tsv")))
    pile = pile[:, :pile.shape[0]]
    pile_png = png_bytes(square(np.log2(pile), -0.5, 0.5, 12, LUT_RDBU))

    def d_pileup(x, y, w, h):
        out = []
        side = h - 0.6
        out.append(image(x, y + 0.3, side, side, pile_png))
        out.append(rect(x, y + 0.3, side, side, stroke=INK3, sw=0.1))
        tx = x + side + 1.6
        out.append(text(tx, y + 2.3, f"{len(domains):,} domains,", size=5.5, weight="bold", fill=INK))
        out.append(text(tx, y + 4.6, "rescaled and piled up", size=5, fill=INK2))
        out.append(text(tx, y + 6.9, "against matched controls", size=5, fill=INK2))
        ky = y + 9.2
        out.append(text(tx, ky, "0.7", size=5, fill=INK3))
        kx = tx + tw("0.7 ", 5)
        for t in np.linspace(0, 1, 30):
            out.append(rect(kx + t * 8, ky - 1.25, 8 / 30 + 0.02, 1.0, fill=lut_hex(LUT_RDBU, t)))
        out.append(text(kx + 9.0, ky, "1.4 O/E", size=5, fill=INK3))
        return out

    agree = {}
    for l in open(next((RES / "model-vs-map").glob("*agreement.tsv"))):
        if l.startswith("#") or l.startswith("sequence"):
            continue
        q = l.rstrip("\n").split("\t")
        agree[q[0]] = float(q[3])
    fit_rows = {l.split("\t")[0]: l.rstrip("\n").split("\t")[1] for l in open(next((RES / "model").glob("*fit.tsv")))
                if not l.startswith("#") and "\t" in l}

    def d_model(x, y, w, h):
        out = []
        s, cx, cy = fit(everything, x + 2.0, y + 1.6, w - 4.0, h - 5.6, 1.0)
        out.append(draw_model(model, R, centre, s, cx, cy, lambda i: "#dfe2e6", 0.26, ~iv, depth_range=zr,
                              fog=0.0, halo_w=0.12))
        out.append(draw_model(model, R, centre, s, cx, cy, pol2_colour, 0.5, iv, depth_range=zr, fog=0.2))
        beads = fit_rows.get("Beads", "").split(" of ")[0]
        out.append(text(x, y + h - 0.5, f"{beads} beads of 5 kb; IV coloured by Pol II", size=5, fill=INK2))
        # the colouring is a link too: a track of the view, onto the model
        c, cw_ = dims_badge(0, 0, "1D", "3D")
        out.append(group(c, transform=f"translate({f(x + w - cw_)} {f(y + 0.1)})"))
        kx, ky, kh = x + 0.2, y + 1.0, 6.0
        for t in np.linspace(0, 1, 24):
            out.append(rect(kx, ky + (1 - t) * kh - kh / 24, 0.9, kh / 24 + 0.02, fill=lut_hex(LUT_VIRIDIS, t)))
        out.append(text(kx + 1.5, ky + 2.0, "Pol II", size=5, fill=INK3))
        return out

    m5 = cooler.Cooler(f"{MCOOL}::/resolutions/5000")
    obs = m5.matrix(balance=True).fetch("IV")
    _, pred = load_table(next((RES / "model-vs-map").glob("*predicted--1.tsv")))
    pred = pred[:, :pred.shape[0]]
    n5 = min(obs.shape[0], pred.shape[0])
    obs, pred = obs[:n5, :n5], pred[:n5, :n5]
    lo_o, hi_o = auto_range(obs)
    lo_m, hi_m = auto_range(pred)
    t_obs = colorize(obs, lo_o, hi_o, LUT)
    t_pred = colorize(pred, lo_m, hi_m, LUT)
    iu = np.triu_indices(n5, 0)
    both = t_pred.copy()
    both[iu] = t_obs[iu]
    both = np.repeat(np.repeat(both, 3, 0), 3, 1)
    versus_png = png_bytes(np.dstack([both, np.full(both.shape[:2], 255, np.uint8)]))
    rho_iv = agree.get("IV", float("nan"))
    rhos = [v for k, v in agree.items()]

    def d_versus(x, y, w, h):
        out = []
        side = h - 0.6
        out.append(image(x, y + 0.3, side, side, versus_png))
        out.append(rect(x, y + 0.3, side, side, stroke=INK3, sw=0.1))
        out.append(line(x, y + 0.3, x + side, y + 0.3 + side, stroke="#ffffff", sw=0.15))
        out.append(text(x + side - 0.6, y + 2.4, "map", size=5, fill=INK, anchor="end", halo="#ffffff"))
        out.append(text(x + 0.6, y + side - 0.4, "model", size=5, fill=INK, halo="#ffffff"))
        tx = x + side + 1.6
        out.append(text(tx, y + 2.3, f"Spearman ρ = {rho_iv:.2f}", size=5.5, weight="bold", fill=INK))
        out.append(text(tx, y + 4.6, "chromosome IV, contacts", size=5, fill=INK2))
        out.append(text(tx, y + 6.9, "vs 1/distance in the model", size=5, fill=INK2))
        out.append(text(tx, y + 9.2, f"{min(rhos):.2f}–{max(rhos):.2f} on all 16", size=5, fill=INK3))
        return out

    radial = tracks.bins("radial", "IV", 0, iv_len, -(-iv_len // 5000))
    pol_iv = pol2_bead

    def d_radial(x, y, w, h):
        out = []
        pw, ph = w - 10.5, 3.6
        v = np.array(radial, float)
        lo_r, hi_r = np.nanpercentile(v, 1), np.nanpercentile(v, 99)
        out.append(polyline(x, y + 0.8, pw, ph, v, C1D, lo_r, hi_r, sw=0.3))
        out.append(line(x, y + 0.8 + ph + 0.3, x + pw, y + 0.8 + ph + 0.3, stroke=RULE, sw=0.1))
        out.append(text(x + pw + 0.8, y + 2.2, "periphery", size=5, fill=INK3))
        out.append(text(x + pw + 0.8, y + 0.8 + ph + 0.2, "centre", size=5, fill=INK3))
        out.append(text(x, y + ph + 3.7, "radial position along IV: a track like", size=5, fill=INK2))
        out.append(text(x, y + ph + 5.9, "any other, ready for the next task", size=5, fill=INK2))
        return out

    return dict(cascade=cascade, d_map=d_map, d_borders=d_borders, d_metaplot=d_metaplot, d_pileup=d_pileup,
                d_model=d_model, d_versus=d_versus, d_radial=d_radial)


def main() -> None:
    data = prepare()
    parts: list[str] = []
    parts += panel_a(0.0, 0.0, 91.6)
    parts += panel_b(94.6, 0.0, 85.4)
    parts += panel_c(0.0, 56.6, data)
    parts += panel_d(0.0, 113.6, data)
    height = 170.0
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'width="{W}mm" height="{height}mm" viewBox="0 0 {W} {height}" font-family="{FONT}">\n'
           f'<rect width="{W}" height="{height}" fill="#ffffff"/>\n' + "\n".join(parts) + "\n</svg>\n")
    (HERE / "figure1.svg").write_text(svg)
    print(f"wrote figure1.svg ({len(svg) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
