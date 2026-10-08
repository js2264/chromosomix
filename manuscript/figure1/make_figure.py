#!/usr/bin/env python
"""Fig. 1 (proposal): write figure1.svg from 4DN mouse data and run_analyses.sh's results.

    python manuscript/figure1/make_figure.py        # figure1.svg
    node manuscript/figure1/svg2pdf.mjs             # figure1.pdf and figure1.png

Needs numpy, cooler, pyBigWig and Pillow. Everything drawn is either an input
run_analyses.sh fetched into build/mouse/ (the F123 mESC Hi-C map, three ChIP-seq
tracks, mm10 genes; a few hundred bases of mm10 are read by byte range) or a
result the app's command line wrote (results/); the one picture of the app
itself is ui-session.png, which capture-ui.mjs shoots. The heatmaps are rasters,
everything else — tracks, models, text, arrows — is vector.

The page is 180 mm wide, in millimetres throughout (1 user unit = 1 mm), and
type is set in points: Helvetica/Arial, 5–8 pt, panel letters 8 pt bold.
"""

from __future__ import annotations

import base64
import io
import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import cooler
import numpy as np
import pyBigWig
from PIL import Image, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RES = HERE / "results"
BUILD = HERE / "build"
MOUSE = BUILD / "mouse"
MAP = MOUSE / "4DNFI5QJNFAT.mcool"
UI_SHOT = HERE / "ui-session.png"
MM10_FA = "https://ngi-igenomes.s3.amazonaws.com/igenomes/Mus_musculus/UCSC/mm10/Sequence/WholeGenomeFasta/genome.fa"
CHROMS = [f"chr{i}" for i in range(1, 20)] + ["chrX"]

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

# Data colours stay clear of the three above, which belong to the dimensions alone.
CTCF = "#A6761D"
K27AC = "#1B9E77"
K4ME3 = "#7570B3"  # not grey: on a model, grey and ink are the zoom's own colours
COMP_A = "#C0504D"
COMP_B = "#4F81BD"
INSUL = "#2B2F36"
COVER = "#8B939C"
HILITE = "#FFE7A3"  # the window the next column zooms into, on the tracks
MODEL_REST = "#C9CED5"  # a model, in grey…
MODEL_HI = "#2B2F36"  # …with that window drawn dark along it
LOOP = "#2E3A59"
BASES = {"A": "#3d9950", "C": "#2f6fb5", "G": "#d59225", "T": "#c8483f", "N": "#8b939c"}

# The app's `default` ramp (src/render/colormaps.ts, DEFAULT_STOPS) and RdBu_r.
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


LUT = ramp(DEFAULT_STOPS)
LUT_RDBU = ramp(RDBU_R_STOPS)


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


def curve_arrow(x1, y1, x2, y2, stroke=INK2, sw=0.3, bend=0.5, head=0.9, dash=None, horizontal=True,
                controls=None) -> str:
    """A cubic from (x1, y1) to (x2, y2) that leaves and arrives horizontally, with a head;
    `controls` sets its two control points where that S would cut a corner."""
    if controls is not None:
        c1, c2 = controls
    elif horizontal:
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


def elbow_arrow(x1, y1, gx, x2, y2, stroke=INK2, sw=0.3, r=1.2, head=0.9) -> str:
    """Across to x = gx, down (or up) to y2 and across again into (x2, y2), with rounded corners:
    the way round something an S-curve would cut through."""
    s = 1 if y2 > y1 else -1
    ex = x2 - head * 0.6
    d = (f"M{f(x1)},{f(y1)} H{f(gx - r)} Q{f(gx)},{f(y1)} {f(gx)},{f(y1 + s * r)} V{f(y2 - s * r)} "
         f"Q{f(gx)},{f(y2)} {f(gx + r)},{f(y2)} H{f(ex)}")
    return path(d, stroke=stroke, sw=sw, extra='stroke-linecap="round" stroke-linejoin="round"') + \
        arrow_head(x2, y2, 0.0, head, stroke)


def group(content: list[str] | str, transform: str | None = None, extra: str = "") -> str:
    body = content if isinstance(content, str) else "\n".join(content)
    t = f' transform="{transform}"' if transform else ""
    return f"<g{t} {extra}>\n{body}\n</g>"


# --------------------------------------------------------------------------- data: maps

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
    t = np.clip(np.nan_to_num(t, nan=0.0, posinf=1.0, neginf=0.0), 0.0, 1.0)
    idx = np.round(t * (len(lut) - 1)).astype(int)
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


def despeckle(m: np.ndarray, radius: int = 1) -> np.ndarray:
    """The app's fixed smoothing (src/render/smooth.ts, `smoothValues`): every cell the mean of the
    finite cells in the (2r+1)² window around it, itself included; a NaN cell stays NaN."""
    fin = np.isfinite(m)
    v, c = np.pad(np.where(fin, m, 0.0), radius), np.pad(fin.astype(float), radius)
    k = 2 * radius + 1
    s = sum(v[i:i + m.shape[0], j:j + m.shape[1]] for i in range(k) for j in range(k))
    n = sum(c[i:i + m.shape[0], j:j + m.shape[1]] for i in range(k) for j in range(k))
    out = np.where(n > 0, s / np.maximum(n, 1), m)
    out[np.isnan(m)] = np.nan
    return out


def square(m: np.ndarray, vmin: float, vmax: float, scale: int, lut: np.ndarray, log=False) -> np.ndarray:
    rgb = colorize(m, vmin, vmax, lut, log)
    rgb = np.repeat(np.repeat(rgb, scale, 0), scale, 1)
    return np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)])


# --------------------------------------------------------------------------- data: tracks

class Tracks:
    FILES = {"ctcf": "4DNFIFFXFV82.bw", "h3k27ac": "4DNFIXE23VC7.bw", "h3k4me3": "4DNFIQYJLKKH.bw"}

    def __init__(self):
        self.bw = {k: pyBigWig.open(str(MOUSE / v)) for k, v in self.FILES.items()}
        self.bw["insulation"] = pyBigWig.open(str(next((RES / "insulation").glob("*insulation-w10.bw"))))
        self.bw["e1"] = pyBigWig.open(str(next((RES / "compartments").glob("*e1.bw"))))

    def bins(self, key: str, chrom: str, start: int, end: int, n: int) -> np.ndarray:
        b = self.bw[key]
        end = min(end, b.chroms(chrom))
        return np.array(b.stats(chrom, start, end, nBins=n, type="mean", exact=True), dtype=float)

    def genome(self, key: str, layout: list[tuple[str, int]], per_bp: float) -> np.ndarray:
        out = []
        for chrom, length in layout:
            k = max(1, int(round(length * per_bp)))
            out.append(self.bins(key, chrom, 0, length, k))
        return np.concatenate(out)


def load_genes(chrom: str) -> list[dict]:
    """Genes of one sequence from the mm10 GTF, which holds exons and no gene rows: each
    gene is the span of its transcripts, on its strand."""
    spans: dict[str, list] = {}
    with open(MOUSE / "genes.gtf") as fh:
        for line in fh:
            if not line.startswith(chrom + "\t"):
                continue
            p = line.split("\t")
            if p[2] != "exon":
                continue
            name = re.search(r'gene_name "([^"]+)"', p[8]) or re.search(r'gene_id "([^"]+)"', p[8])
            g = name.group(1)
            a, b = int(p[3]) - 1, int(p[4])
            if g in spans:
                spans[g][0] = min(spans[g][0], a)
                spans[g][1] = max(spans[g][1], b)
            else:
                spans[g] = [a, b, p[6]]
    return [{"chrom": chrom, "start": a, "end": b, "strand": s, "name": g} for g, (a, b, s) in spans.items()]


def mm10(chrom: str, start: int, end: int) -> str:
    """mm10 bases [start, end), read by byte range from the iGenomes FASTA through its index
    (fetched by run_analyses.sh) and kept in build/mouse/ after the first read."""
    cache = MOUSE / f"{chrom}_{start}_{end}.txt"
    if cache.exists():
        return cache.read_text()
    fai = {l.split()[0]: l.split() for l in open(MOUSE / "genome.fa.fai")}
    _, _, offset, per_line, line_bytes = fai[chrom][:5]
    offset, per_line, line_bytes = int(offset), int(per_line), int(line_bytes)

    def at(pos):
        return offset + (pos // per_line) * line_bytes + pos % per_line

    raw = subprocess.run(["curl", "-sS", "--fail", "-r", f"{at(start)}-{at(end)}", MM10_FA], capture_output=True,
                         check=True).stdout.decode()
    seq = raw.replace("\n", "")[: end - start].upper()
    cache.write_text(seq)
    return seq


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


def load_model(folder: str) -> Model:
    p = next((RES / folder).glob("*.bed3d"))
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
               fog: float = 0.55, depth_range: tuple[float, float] | None = None, halo_w: float = 0.22,
               width_of=None) -> str:
    """The model as a depth-sorted tube, in orthographic projection.

    Each chain of consecutive beads is splined through every bead and cut into runs
    of `run` spline steps (three to a bead); the runs are drawn far to near, each a
    coloured line over a white halo, thinner and paler with depth. The halo stops one
    step short of either end, so a run never cuts the one it continues — it only
    parts strands that cross. `width_of` scales the tube bead by bead."""
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
            wd = width * (0.72 + 0.56 * depth) * (width_of(bead) if width_of else 1.0)
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
               arrows=True, hero=None) -> list[str]:
    """Genes as boxes on two rows (+ above, − below); names for the ones listed. A `hero` gene
    is drawn dark over paler neighbours (Sox2 lies inside Sox2ot, on the same strand) and named
    beside its box, in the other strand's row."""
    out = []
    span = end - start
    mid = y + h / 2
    out.append(line(x, mid, x + w, mid, stroke=RULE, sw=0.12))
    if hero is not None:
        genes = sorted(genes, key=lambda g: g["name"] == hero)
    for g in genes:
        if g["chrom"] != chrom or g["end"] <= start or g["start"] >= end:
            continue
        is_hero = hero is not None and g["name"] == hero
        colour_g = INK if is_hero else (mix(colour, "#ffffff", 0.45) if hero is not None else colour)
        a = x + (max(g["start"], start) - start) / span * w
        b = x + (min(g["end"], end) - start) / span * w
        plus = g["strand"] == "+"
        gy = mid - h * 0.42 if plus else mid + h * 0.06
        gh = h * 0.36
        out.append(rect(a, gy, max(b - a, 0.12), gh, fill=colour_g))
        if is_hero:
            hy = (mid + h * 0.42) if plus else (mid - h * 0.06)
            out.append(text(b + 0.35, hy, g["name"], size=name_size, fill=INK, italic=True))
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

def panel_letter(x, y, letter) -> str:
    return text(x, y, letter, size=8, weight="bold", fill="#000000")


def rich(x, y, parts: list[tuple[str, bool]], size=5.0, fill=INK, anchor="start", weight=None, halo=None) -> str:
    """One line of text whose pieces may be italic — a gene symbol inside a label."""
    attrs = [f'x="{f(x)}"', f'y="{f(y)}"', f'font-size="{f(size * PT)}"', f'fill="{fill}"']
    if weight:
        attrs.append(f'font-weight="{weight}"')
    if anchor != "start":
        attrs.append(f'text-anchor="{anchor}"')
    if halo:
        attrs.append(f'stroke="{halo}" stroke-width="{f(0.5)}" paint-order="stroke" stroke-linejoin="round"')
    body = "".join(f'<tspan font-style="italic">{esc(s)}</tspan>' if it else esc(s) for s, it in parts)
    return f"<text {' '.join(attrs)}>{body}</text>"


def chip(x, y, label, size=5.0, fill="#ffffff", stroke=None, colour=INK, pad=0.75, h=None, mono=False,
         bold=False, rx=None) -> tuple[list[str], float]:
    h = h or size * PT * 1.55
    wdt = tw(label, size, bold=bold, mono=mono) + 2 * pad
    out = [rect(x, y, wdt, h, fill=fill, stroke=stroke, sw=0.15, rx=rx if rx is not None else h / 2),
           text(x + pad, y + h / 2 + size * PT * 0.35, label, size=size, fill=colour, mono=mono,
                weight="bold" if bold else None)]
    return out, wdt


def dims_badge(x, y, a: str, b: str, size=5.0) -> tuple[list[str], float]:
    """`2D → 1D`, each dimension in its colour, on a pale pill."""
    h = size * PT * 1.6
    wa, wo, wb = tw(a, size, bold=True), tw(" → ", size), tw(b, size, bold=True)
    wdt = wa + wo + wb + 1.4
    yb = y + h / 2 + size * PT * 0.35
    out = [rect(x, y, wdt, h, fill="#ffffff", stroke=RULE, sw=0.15, rx=h / 2),
           text(x + 0.7, yb, a, size=size, weight="bold", fill=DIM.get(a, INK2)),
           text(x + 0.7 + wa, yb, " → ", size=size, fill=INK3),
           text(x + 0.7 + wa + wo, yb, b, size=size, weight="bold", fill=DIM.get(b, INK2))]
    return out, wdt


def dim_icon(dim: str, gx: float, gy: float) -> list[str]:
    """The glyph each dimension wears: a signal, a map's triangle, a folded chain."""
    col = DIM[dim]
    if dim == "1D":
        return [path(f"M{f(gx)},{f(gy + 1.9)} l0.8,-0.5 l0.7,-1.7 l0.8,1.4 l0.8,-0.6 l0.8,1.0 l0.7,0.4",
                     stroke=col, sw=0.3, extra='stroke-linejoin="round" stroke-linecap="round"')]
    if dim == "2D":
        return [path(f"M{f(gx)},{f(gy + 2.2)} L{f(gx + 2.3)},{f(gy - 0.1)} L{f(gx + 4.6)},{f(gy + 2.2)} Z",
                     fill=mix(col, "#ffffff", 0.6), stroke=col, sw=0.22),
                path(f"M{f(gx)},{f(gy + 2.2)} L{f(gx + 1.15)},{f(gy + 1.05)} L{f(gx + 2.3)},{f(gy + 2.2)} Z",
                     fill=col)]
    return [path(f"M{f(gx + 0.2)},{f(gy + 1.8)} C{f(gx + 0.6)},{f(gy - 0.9)} {f(gx + 3.1)},{f(gy + 2.9)} "
                 f"{f(gx + 2.6)},{f(gy + 0.4)} S{f(gx + 4.8)},{f(gy - 0.3)} {f(gx + 4.6)},{f(gy + 1.9)}",
                 stroke=col, sw=0.42, extra='stroke-linecap="round"')]


# ---- a: the app itself

CALLOUTS = [  # number, where on the screenshot (pixels of its 3,200 across), what it says
    (1, (700, 146), "Read in place from public data stores, nothing uploaded"),
    (2, (1262, 218), "Only the queried view is read"),
    (3, (2080, 550), "A 3-cell deck: a 2D map with its tracks, a 3D model and a 1D browser"),
    (4, (2905, 305), "30 analyses, in a background worker"),
    (5, (2768, 140), "Each step logged as its command line"),
]


def panel_a(x0, y0, w) -> tuple[list[str], float]:
    """The real window, on the same mouse session as c and d, with numbered markers."""
    out = [panel_letter(x0, y0 + 2.9, "a")]
    im = Image.open(UI_SHOT).convert("RGB")
    crop_h = 1270
    im = im.crop((0, 0, im.width, crop_h))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    wx, wy, ww = x0 + 3.8, y0 + 0.8, w - 4.0
    wh = ww * crop_h / im.width
    for k, op in enumerate([0.035, 0.03, 0.025, 0.02]):
        d = 0.25 * (k + 1)
        out.append(rect(wx - d * 0.3, wy + d * 0.6, ww + d * 0.6, wh + d * 0.4, fill="#0b1220", rx=1.2 + d,
                        opacity=op))
    out.append(f'<clipPath id="win"><rect x="{f(wx)}" y="{f(wy)}" width="{f(ww)}" height="{f(wh)}" rx="1.2"/></clipPath>')
    out.append(group([image(wx, wy, ww, wh, buf.getvalue(), smooth=True)], extra='clip-path="url(#win)"'))
    out.append(rect(wx, wy, ww, wh, stroke="#c4c9d0", sw=0.2, rx=1.2))

    def at(px, py):
        return wx + px / im.width * ww, wy + py / im.width * ww

    for n, (px, py), _ in CALLOUTS:
        mx, my = at(px, py)
        out.append(circle(mx, my, 1.15, fill=INK, stroke="#ffffff", sw=0.3))
        out.append(text(mx, my + 0.62, str(n), size=5, weight="bold", fill="#ffffff", anchor="middle"))
    # the key under the window, in two columns: 1-3, then 4-5, the first wide enough for 3 on one line
    ky, step = wy + wh + 3.2, 2.3
    bottom = ky
    for cx, col_w, members in ((wx, ww * 0.6, CALLOUTS[:3]), (wx + ww * 0.6, ww * 0.4, CALLOUTS[3:])):
        cy = ky
        for n, _, label in members:
            out.append(circle(cx + 1.0, cy - 0.62, 1.0, fill=INK))
            out.append(text(cx + 1.0, cy - 0.02, str(n), size=5, weight="bold", fill="#ffffff", anchor="middle"))
            lines_ = wrap(label.split(" "), col_w - 4.0, 5.5, sep=" ")
            for li, ln in enumerate(lines_):
                out.append(text(cx + 2.7, cy + li * 2.2, ln, size=5.5, fill=INK2))
                bottom = max(bottom, cy + li * 2.2)
            cy += step + 2.2 * (len(lines_) - 1)
    return out, bottom


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


# ---- b: what it reads and runs, by dimension — the colour code the rest of the figure uses

SCOPE = [  # dimension, what, file types, analyses (Supplementary Tables 2 and 3), some formats, some analyses
    ("3D", "Spatial models", 3, 3, ".g3d, .3dg, .bed3d", ["pastis-NB and ShRec3D models", "model vs map", "spatial tracks"]),
    ("2D", "Contact maps & interactions", 9, 18, ".cool, .mcool, .hic, .pairs, HiC-Pro, BEDPE, …",
     ["P(s)", "insulation", "compartments", "loops & borders", "APA pile-ups", "virtual 4C"]),
    ("1D", "Sequences, signals, intervals, alignments", 15, 9, "bigWig, BED, BAM, VCF, FASTA, GTF, …",
     ["peaks", "metaplots", "track correlation", "motif search"]),
]


def runs(x, y, parts: list[tuple[str, str, bool]], size=5.0) -> str:
    """One line in several inks, as one text element so its spaces survive: (text, fill, bold)."""
    weight = ' font-weight="bold"'
    body = "".join(f'<tspan fill="{fill}"{weight if bold else ""}>{esc(s)}</tspan>' for s, fill, bold in parts)
    return f'<text x="{f(x)}" y="{f(y)}" font-size="{f(size * PT)}" xml:space="preserve">{body}</text>'


def panel_b(x0, y0, w, h) -> list[str]:
    """Three cards in the order c stacks its rows, each a count and a few names rather than a list: the
    lists are Supplementary Tables 2 and 3, and what this panel has to carry is the colour of each dimension."""
    out = [panel_letter(x0, y0 + 2.9, "b")]
    foot, gap = 3.0, 1.1
    bx, bw = x0 + 3.8, w - 3.8
    bh = (h - foot - 2 * gap) / 3
    y = y0 + 0.8
    chip_h = 5.0 * PT * 1.55
    for dim, what, n_files, n_tasks, formats, examples in SCOPE:
        col = DIM[dim]
        out.append(rect(bx, y, bw, bh, fill=mix(col, "#ffffff", 0.94), rx=1.2))
        out.append(rect(bx, y, 0.9, bh, fill=col))
        out.append(text(bx + 2.3, y + 4.2, dim, size=8, weight="bold", fill=col))
        out += dim_icon(dim, bx + 2.4, y + 6.0)
        left = bx + 10.0
        out.append(text(left, y + 3.4, what, size=6, weight="bold", fill=INK))
        cy = y + 6.1
        out.append(runs(left, cy, [(f"{n_files}", INK, True), (" file types · ", INK2, False),
                                   (f"{n_tasks}", INK, True), (" analyses", INK2, False)], size=5.5))
        cy += 2.2
        out.append(runs(left, cy, [("reads ", INK3, False), (formats, INK2, False)]))
        cy += 1.0
        cx = left
        right = bx + bw - 1.2
        for it in examples:
            wdt = tw(it, 5) + 1.5
            if cx + wdt > right and cx > left:
                cx = left
                cy += chip_h + 0.5
            c, _ = chip(cx, cy, it, fill=mix(col, "#ffffff", 0.8), colour=INK)
            out += c
            cx += wdt + 0.5
        y += bh + gap
    out.append(text(bx + bw, y0 + h - 0.4, "every file type and analysis: Supplementary Tables 2 and 3",
                    size=5, fill=INK3, anchor="end"))
    return out


# ---- c: one session, every scale

def map_key(x, y, w, title, lo: str, hi: str, lut: np.ndarray, note: str | None = None) -> list[str]:
    """The app's key, in a map's top-right corner: what the colour is, and its two ends; `note` is the
    line the app adds under it when the picture was smoothed."""
    kw = max(tw(title, 5) + 1.6, tw(note, 5) + 1.6 if note else 0.0, 13.0)
    kx, ky = x + w - kw - 0.6, y + 0.6
    dy = 2.0 if note else 0.0
    out = [rect(kx, ky, kw, 5.3 + dy, fill="#ffffff", stroke="#c9ced5", sw=0.12, rx=0.5, opacity=0.94),
           text(kx + kw / 2, ky + 1.9, title, size=5, fill=INK2, anchor="middle")]
    if note:
        out.append(text(kx + kw / 2, ky + 3.9, note, size=5, fill=INK3, anchor="middle"))
    rx, rw, rh = kx + 0.8, kw - 1.6, 0.95
    for t in np.linspace(0, 1, 32):
        out.append(rect(rx + t * rw * 31 / 32, ky + 2.45 + dy, rw / 32 + 0.02, rh, fill=lut_hex(lut, t)))
    out.append(rect(rx, ky + 2.45 + dy, rw, rh, stroke=INK3, sw=0.08))
    out.append(text(rx, ky + 4.95 + dy, lo, size=5, fill=INK2))
    out.append(text(rx + rw, ky + 4.95 + dy, hi, size=5, fill=INK2, anchor="end"))
    return out


def num(v: float, digits: int = 1) -> str:
    """A key's limit with a real minus sign."""
    s = f"{v:.{digits}f}"
    return s.replace("-", "−")


def window_box(x, y, w, frac: tuple[float, float], dash="0.6 0.45") -> str:
    """The window the next column zooms into, as a square on the map's diagonal."""
    a, b = frac
    side = max((b - a) * w, 0.5)
    return rect(x + a * w, y + a * w, side, side, stroke=INK, sw=0.22, extra=f'stroke-dasharray="{dash}"')


def panel_c(x0, y0, data) -> tuple[list[str], float]:
    out = [panel_letter(x0, y0 + 2.9, "c")]
    cols = data["cascade"]
    n = len(cols)
    g = 2.2
    lab = 8.8
    cw = (W - lab - (n - 1) * g) / n
    xs = [x0 + lab + k * (cw + g) for k in range(n)]
    y_head = y0 + 0.6
    y3, h3 = y_head + 6.4, 15.5
    y2, h2 = y3 + h3 + 0.9, cw
    y1, h1 = y2 + h2 + 1.3, 10.8
    for label, yy, hh in (("3D", y3, h3), ("2D", y2, h2), ("1D", y1, h1)):
        out.append(text(x0 + 0.2, yy + hh / 2 - 0.4, label, size=7, weight="bold", fill=DIM[label]))
        out += dim_icon(label, x0 + 0.3, yy + hh / 2 + 0.9)
    for k, col in enumerate(cols):
        x = xs[k]
        out.append(rich(x, y_head + 2.0, col["title"], size=6, weight="bold", fill=INK))
        out.append(text(x, y_head + 4.4, col["sub"], size=5, fill=INK3))
        if k < n - 1:
            zx = x + cw
            out.append(path(f"M{f(zx - 0.55)},{f(y_head + 0.55)} l0.55,0.65 l-0.55,0.65", stroke=INK2, sw=0.22,
                            extra='stroke-linecap="round" stroke-linejoin="round"'))
            out.append(text(zx - 1.1, y_head + 2.0, col["zoom"], size=5, weight="bold", fill=INK2, anchor="end"))
        # 3D
        out.append(f'<clipPath id="c3d{k}"><rect x="{f(x)}" y="{f(y3)}" width="{f(cw)}" height="{f(h3)}"/></clipPath>')
        out.append(group(col["model3d"](x, y3, cw, h3), extra=f'clip-path="url(#c3d{k})"'))
        # 2D
        out += col["map2d"](x, y2, cw, h2, y1)
        # 1D: the window the next column reads, then the tracks
        if col.get("next") is not None:
            a, b = col["next"]
            out.append(rect(x + a * cw, y1 - 0.3, max((b - a) * cw, 0.3), h1 + 0.3, fill=HILITE))
        out += col["tracks1d"](x, y1, cw, h1)
    return out, y1 + h1


def track_label(x, y, label, colour, size=5.0) -> str:
    return text(x + 0.3, y + 1.75, label, size=size, fill=colour, halo="#ffffff")


# ---- d: see, measure, see again

def task_pill(x, y, w, title, dims, cmd, against=None) -> tuple[list[str], float]:
    """A task: its name, the dimensions it crosses, the command that reruns it, and the
    second input it reads from the view, if any."""
    h = 6.3 if against is None else 9.0
    out = [rect(x, y, w, h, fill="#ffffff", stroke="#c9ced5", sw=0.18, rx=1.0)]
    out.append(text(x + 1.1, y + 2.5, title, size=6, weight="bold", fill=INK))
    b, bw = dims_badge(0, 0, *dims)
    out.append(group(b, transform=f"translate({f(x + w - bw - 0.8)} {f(y + 0.62)})"))
    out.append(text(x + 1.1, y + 4.95, cmd, size=5, mono=True, fill=INK2))
    if against:
        out.append(text(x + 1.1, y + 7.75, "against", size=5, fill=INK3))
        cx = x + 1.1 + tw("against ", 5)
        for label, colour in against:
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


def column_head(cx, top, kind) -> list[str]:
    label = "SEE" if kind == "see" else "MEASURE"
    sub = "drawn in the browser" if kind == "see" else "a task computes outputs"
    lw = tw(label, 5.4, bold=True) + len(label) * 0.12
    icon = eye_icon if kind == "see" else gauge_icon
    return [icon(cx - lw / 2 - 1.9, top + 2.05, 0.95),
            text(cx - lw / 2, top + 2.65, label, size=5.4, weight="bold", fill=INK2, spacing=0.12),
            text(cx, top + 4.75, sub, size=5, fill=INK3, anchor="middle")]


def panel_d(x0, y0, data) -> tuple[list[str], float]:
    out = [panel_letter(x0, y0 + 2.9, "d")]
    S1, M1, S2, M2 = (x0 + 3.8, x0 + 33.0), (x0 + 33.0, x0 + 68.2), (x0 + 68.2, x0 + 103.5), (x0 + 103.5, x0 + 180)
    top, bottom = y0 + 0.4, y0 + 45.6
    px2, pw2 = M2[0] + 1.6, 33.0  # M2's tasks, with what each returned to their right
    for a, b in (M1, M2):
        out.append(rect(a + 0.6, top, b - a - 1.2, bottom - top, fill=WASH, rx=1.4))
    for (a, b), kind in ((S1, "see"), (M1, "measure"), (S2, "see"), (M2, "measure")):
        out += column_head(px2 + pw2 / 2 if (a, b) == M2 else (a + b) / 2, top, kind)
    laneA, laneB = (y0 + 6.6, y0 + 26.0), (y0 + 28.0, y0 + 45.0)

    # ---- S1: the map both chains start from, with the tracks drawn under it
    mx, mw = S1[0] + 0.4, S1[1] - S1[0] - 1.2
    mh = mw / 2
    my = y0 + 8.0 + mh
    out.append(image(mx, my - mh, mw, mh, data["d_map"]))
    ty = my + 0.4
    for label, key, colour in (("CTCF", "ctcf", CTCF), ("H3K27ac", "h3k27ac", K27AC), ("H3K4me3", "h3k4me3", K4ME3)):
        v = data["d_tracks"][key]
        out.append(area(mx, ty, mw, 2.5, v, colour, vmax=float(np.nanpercentile(v, 99.5))))
        out.append(track_label(mx, ty - 0.2, label, colour))
        ty += 2.9
    out.append(rect(mx, my - 0.05, mw, ty - my, stroke="#c9ced5", sw=0.12))
    out.append(text(mx + mw / 2, ty + 2.2, "mouse ES cells, Hi-C, 10 kb", size=5, fill=INK2, anchor="middle"))
    out.append(text(mx + mw / 2, ty + 4.3, "chr3:32–36 Mb", size=5, fill=INK3, anchor="middle"))

    # ---- M1: the two tasks run on it
    px1, pw1 = M1[0] + 1.6, M1[1] - M1[0] - 3.2
    P = data["d_pills"]
    yA1 = laneA[0] + 5.6
    p, hA1 = task_pill(px1, yA1, pw1, *P["insulation"])
    out += p
    yB1 = laneB[0] + 6.6
    p, hB1 = task_pill(px1, yB1, pw1, *P["model"])
    out += p

    # ---- S2: what they gave back, drawn in the view
    sx, sw_ = S2[0] + 1.0, S2[1] - S2[0] - 2.0
    out += data["d_borders"](sx, laneA[0] + 0.6, sw_, laneA[1] - laneA[0] - 0.8)
    out += data["d_model"](sx, laneB[0] + 0.6, sw_, laneB[1] - laneB[0] - 0.6)

    # ---- M2: three tasks on those outputs, each with what it returned beside it
    ox = px2 + pw2 + 4.0
    rows = [("metaplot", laneA[0] + 0.4, data["d_metaplot"], C1D),
            ("pileup", laneA[0] + 11.6, data["d_pileup"], C2D),
            ("distance", laneB[0] + 6.6, data["d_versus"], C2D)]
    centres = {}
    for key, yp, draw, colour in rows:
        p, hp = task_pill(px2, yp, pw2, *P[key])
        out += p
        centres[key] = yp + hp / 2
        out += draw(ox, yp - 0.6, M2[1] - ox - 1.2, hp + 1.2)
        out.append(curve_arrow(px2 + pw2, yp + hp / 2, ox - 0.5, yp + hp / 2, stroke=colour, sw=0.42))

    # ---- arrows: grey into a task (what is in view), coloured out of it (what it returns)
    a_in = INK3
    fx, fy = mx + mw * 0.8, my - mh * 0.4  # on the map's right flank
    out.append(curve_arrow(fx, fy, px1, yA1 + hA1 / 2, stroke=a_in, sw=0.3))
    # the second goes down between the tracks and the column of tasks rather than through the tracks
    out.append(elbow_arrow(fx, fy, (mx + mw + M1[0] + 0.6) / 2, px1, yB1 + hB1 / 2, stroke=a_in, sw=0.3))
    out.append(curve_arrow(px1 + pw1, yA1 + hA1 / 2, sx - 0.3, yA1 + hA1 / 2, stroke=C1D, sw=0.42))
    out.append(curve_arrow(px1 + pw1, yB1 + hB1 / 2, sx - 0.3, yB1 + hB1 / 2, stroke=C3D, sw=0.42))
    srcA, srcB = laneA[0] + 9.6, laneB[0] + 8.0
    out.append(curve_arrow(sx + sw_ + 0.4, srcA, px2, centres["metaplot"], stroke=a_in, sw=0.3))
    out.append(curve_arrow(sx + sw_ + 0.4, srcA, px2, centres["pileup"], stroke=a_in, sw=0.3))
    out.append(curve_arrow(sx + sw_ + 0.4, srcB, px2, centres["distance"], stroke=a_in, sw=0.3))
    return out, bottom


# --------------------------------------------------------------------------- the data each panel draws

def correlation(m: np.ndarray, radius: int = 1) -> np.ndarray:
    """Pearson correlation of the observed-over-expected rows, the expected being each diagonal's mean:
    the compartment checkerboard, as a reader asks for it on one chromosome. Despeckled first, as the
    app does when a smoothing is picked: the observed and the expected each averaged over the same
    windows, then divided."""
    n = m.shape[0]
    exp = np.array([np.nanmean(d) if np.isfinite(d := np.diagonal(m, k)).any() else np.nan for k in range(n)])
    D = np.abs(np.subtract.outer(np.arange(n), np.arange(n)))
    with np.errstate(invalid="ignore", divide="ignore"):
        oe = despeckle(m, radius) / despeckle(exp[D], radius)
    valid = np.isfinite(oe).mean(1) > 0.5
    sub = oe[np.ix_(valid, valid)]
    sub = np.where(np.isfinite(sub), sub, 1.0)
    out = np.full((n, n), np.nan)
    out[np.ix_(valid, valid)] = np.corrcoef(sub)
    return out


def square_png(m: np.ndarray, lo: float, hi: float, lut: np.ndarray, log: bool, min_px: int = 600) -> bytes:
    rep = max(1, -(-min_px // m.shape[0]))
    return png_bytes(square(m, lo, hi, rep, lut, log=log))


def prepare() -> dict:
    tracks = Tracks()
    clr = {r: cooler.Cooler(f"{MAP}::/resolutions/{r}") for r in (2000, 5000, 10000, 250000, 2500000)}
    sizes = clr[10000].chromsizes
    layout = [(c, int(sizes[c])) for c in CHROMS]
    total = sum(n for _, n in layout)
    chr3_len = dict(layout)["chr3"]
    genes3 = load_genes("chr3")

    # the cascade's windows: each column reads the one marked in the column before
    W_CHR3 = ("chr3", 0, chr3_len)
    W_REGION = ("chr3", 27_000_000, 37_000_000)
    W_LOCUS = ("chr3", 34_000_000, 35_000_000)
    W_GENE = ("chr3", 34_550_000, 34_800_000)
    ATG = 34_650_415  # Sox2's start codon, 0-based (mm10 chr3:34,650,416)
    SCR = 34_760_000  # the Sox2 control region, ~110 kb downstream
    W_BP = ("chr3", ATG - 500, ATG + 500)

    def frac(win, inside):
        return ((win[1] - inside[1]) / (inside[2] - inside[1]), (win[2] - inside[1]) / (inside[2] - inside[1]))

    offsets, pos = {}, 0
    for c, n in layout:
        offsets[c] = pos
        pos += n
    chr3_frac = (offsets["chr3"] / total, (offsets["chr3"] + chr3_len) / total)

    # ---- the maps
    print("maps")
    g = clr[2500000]
    gbins = g.bins()[:]
    keep = gbins["chrom"].astype(str).isin(CHROMS).to_numpy()
    m_genome = g.matrix(balance=True)[:][np.ix_(keep, keep)]
    gchrom = gbins["chrom"].astype(str).to_numpy()[keep]
    trans = (gchrom[:, None] != gchrom[None, :]) & np.isfinite(m_genome) & (m_genome > 0)
    lt = np.log10(m_genome[trans])
    # the genome on the scale of its trans contacts, so the plaid between chromosomes shows and the
    # chromosomes themselves saturate — the clip a reader sets for a whole-genome view
    lim_genome = (float(np.percentile(lt, 5)), float(np.percentile(lt, 99.9)))
    cov_genome = np.nansum(g.matrix(balance=False)[:][np.ix_(keep, keep)], 1).astype(float)

    def symmetric(values: np.ndarray) -> float:
        """A diverging key's half-width by the app's auto rule (src/render/scale.ts, `autoSymmetricRange`):
        the 99th percentile of the distance from neutral, here to 0.1."""
        return round(float(np.nanpercentile(np.abs(values[np.isfinite(values)]), 99)), 1)

    m_chr3 = clr[250000].matrix(balance=True).fetch("chr3")
    corr_chr3 = correlation(m_chr3)
    corr_lim = symmetric(corr_chr3[~np.eye(len(corr_chr3), dtype=bool)])
    m_region = clr[10000].matrix(balance=True).fetch("chr3:27000001-37000000")
    lim_region = auto_range(m_region)
    # observed over expected at 5 kb, the expected read off 22 Mb of the chromosome around the locus, and
    # the app's 3 × 3 despeckle on both before dividing — at 5 kb a single cell is a few contacts
    wide = clr[5000].matrix(balance=True).fetch("chr3:24000001-46000000")
    m_locus = clr[5000].matrix(balance=True).fetch("chr3:34000001-35000000")
    nl = m_locus.shape[0]
    exp5 = np.array([np.nanmean(np.diagonal(wide, k)) for k in range(nl)])
    del wide
    with np.errstate(invalid="ignore", divide="ignore"):
        oe_locus = np.log2(despeckle(m_locus) / despeckle(exp5[np.abs(np.subtract.outer(np.arange(nl), np.arange(nl)))]))
    oe_lim = symmetric(oe_locus)
    m_gene = clr[2000].matrix(balance=True).fetch("chr3:34550001-34800000")
    lim_gene = auto_range(m_gene)

    png_genome = square_png(m_genome, *lim_genome, LUT, True)
    png_chr3 = square_png(corr_chr3, -corr_lim, corr_lim, LUT_RDBU, False)
    png_region = square_png(m_region, *lim_region, LUT, True)
    png_locus = square_png(oe_locus, -oe_lim, oe_lim, LUT_RDBU, False)
    png_gene = square_png(m_gene, *lim_gene, LUT, True)

    loops = load_bedpe(next((RES / "loops").glob("*.bedpe")))
    loops_locus = [l for l in loops if l[0] == "chr3" and l[1] >= W_LOCUS[1] and l[5] <= W_LOCUS[2]]

    def map_genome(x, y, w, h, _y1):
        out = [image(x, y, w, h, png_genome)]
        for c, n in layout[1:]:  # chromosome borders, faint
            a = offsets[c] / total
            out.append(line(x + a * w, y, x + a * w, y + h, stroke="#ffffff", sw=0.06, opacity=0.7))
            out.append(line(x, y + a * w, x + w, y + a * w, stroke="#ffffff", sw=0.06, opacity=0.7))
        out.append(window_box(x, y, w, chr3_frac))
        out += map_key(x, y, w, "Balanced (log10)", num(lim_genome[0]), num(lim_genome[1]), LUT)
        return out

    def map_chr3(x, y, w, h, _y1):
        return [image(x, y, w, h, png_chr3), window_box(x, y, w, frac(W_REGION, W_CHR3))] + \
            map_key(x, y, w, "Correlation", num(-corr_lim), num(corr_lim), LUT_RDBU, note="smoothed 3 × 3")

    def map_region(x, y, w, h, _y1):
        return [image(x, y, w, h, png_region), window_box(x, y, w, frac(W_LOCUS, W_REGION))] + \
            map_key(x, y, w, "Balanced (log10)", num(lim_region[0]), num(lim_region[1]), LUT)

    def map_locus(x, y, w, h, _y1):
        out = [image(x, y, w, h, png_locus)]
        s0, s1 = W_LOCUS[1], W_LOCUS[2]
        for _, a1, b1, _, a2, b2, *_ in loops_locus:
            u, v = ((a1 + b1) / 2 - s0) / (s1 - s0), ((a2 + b2) / 2 - s0) / (s1 - s0)
            out.append(circle(x + v * w, y + u * w, 0.55, stroke=LOOP, sw=0.14))
        out.append(window_box(x, y, w, frac(W_GENE, W_LOCUS)))
        out += map_key(x, y, w, "Obs./exp. (log2)", num(-oe_lim), num(oe_lim), LUT_RDBU, note="smoothed 3 × 3")
        return out

    def map_gene(x, y, w, h, _y1):
        out = [image(x, y, w, h, png_gene)]
        u, v = frac(("chr3", ATG, SCR), W_GENE)
        cx_, cy_ = x + v * w, y + u * w  # the promoter's row, the enhancer's column: above the diagonal
        out.append(path(f"M{f(cx_ - 1.25)},{f(cy_)} a1.25,1.25 0 1,0 2.5,0 a1.25,1.25 0 1,0 -2.5,0", stroke=INK,
                        sw=0.2, extra='stroke-dasharray="0.45 0.35"'))
        # named above the circle, away from the diagonal, and kept inside the map
        lw = tw("Sox2–SCR", 5)
        out.append(rich(min(cx_ + lw / 2, x + w - 0.5), cy_ - 1.85, [("Sox2", True), ("–SCR", False)], size=5,
                        fill=INK, anchor="end", halo="#ffffff"))
        out += map_key(x, y, w, "Balanced (log10)", num(lim_gene[0]), num(lim_gene[1]), LUT)
        return out

    # ---- the last column: single bases, which a map at 2 kb and a model at 2 kb cannot show
    seq_bp = mm10("chr3", W_BP[1], W_BP[2])
    letters_start = ATG - 6
    letters = seq_bp[letters_start - W_BP[1]: letters_start - W_BP[1] + 21]
    codons = {"ATG": "M", "TAT": "Y", "AAC": "N", "GAG": "E", "ACG": "T", "CTG": "L", "AAG": "K", "CCG": "P"}

    def map_bp(x, y, w, h, y1):
        out = []
        size = 5.4
        cwid = tw("A", size, bold=True, mono=True)
        n = len(letters)
        bw = n * cwid + 1.4
        bx, by, bh = x + (w - bw) / 2, y + h - 12.6, 11.6
        out.append(rect(bx, by, bw, bh, fill="#ffffff", stroke="#c9ced5", sw=0.18, rx=0.9))
        sa = x + (letters_start - W_BP[1]) / (W_BP[2] - W_BP[1]) * w
        sb = x + (letters_start + n - W_BP[1]) / (W_BP[2] - W_BP[1]) * w
        out.append(line(bx, by + bh, sa, y1 + 0.1, stroke=INK3, sw=0.12, dash="0.5 0.4"))
        out.append(line(bx + bw, by + bh, sb, y1 + 0.1, stroke=INK3, sw=0.12, dash="0.5 0.4"))
        ty = by + 4.2
        for i, ch in enumerate(letters):
            out.append(text(bx + 0.7 + (i + 0.5) * cwid, ty, ch, size=size, fill=BASES.get(ch, INK3), weight="bold",
                            mono=True, anchor="middle"))
        k0 = 6
        out.append(rect(bx + 0.7 + k0 * cwid - 0.1, ty - 2.3, 3 * cwid + 0.2, 3.0, stroke=INK, sw=0.18, rx=0.4))
        for c in range(5):
            cod = letters[k0 + 3 * c:k0 + 3 * c + 3]
            cxm = bx + 0.7 + (k0 + 3 * c + 1.5) * cwid
            out.append(rect(cxm - 1.5 * cwid + 0.12, ty + 1.0, 3 * cwid - 0.24, 2.2, fill="#eef0f3", rx=0.3))
            out.append(text(cxm, ty + 2.65, codons.get(cod, "?"), size=5, fill=INK, anchor="middle", weight="bold"))
        out.append(text(bx + 0.8, by + bh - 0.9, f"chr3:{letters_start + 1:,}", size=5, fill=INK3))
        out.append(rich(bx + bw - 0.8, by + bh - 0.9, [("Sox2", True), (" start", False)], size=5, fill=INK2,
                        anchor="end"))
        return out

    # ---- the models, one per scale, each inferred from the map at that scale's resolution
    print("models")
    models = {k: load_model(f"model-{k}") for k in ("genome", "chr3", "region", "locus", "gene")}

    def bead_track(model, key):
        vals = []
        for c, s in zip(model.chrom, model.start):
            vals.append(tracks.bw[key].stats(c, int(s), int(min(s + model.binsize, sizes[c])), type="mean")[0])
        return np.array([np.nan if v is None else v for v in vals], float)

    def projector(model, yaw=0.35, pitch=-0.55, roll=0.15):
        R = rotation(model.xyz, yaw=yaw, pitch=pitch, roll=roll)
        centre = model.xyz.mean(0)
        P = (model.xyz - centre) @ R.T
        zr = (float(P[:, 2].min()), float(P[:, 2].max()))

        def fit(keep_, x, y, w, h, pad=0.9):
            Q = P[keep_]
            lo, hi = Q[:, :2].min(0), Q[:, :2].max(0)
            s = min(w * pad / (hi[0] - lo[0]), h * pad / (hi[1] - lo[1]))
            mid = (lo + hi) / 2
            return s, x + w / 2 - mid[0] * s, y + h / 2 + mid[1] * s

        return R, centre, P, zr, fit

    def thread(name, window, width, whole_width=None):
        """A model in grey with the next column's window drawn dark along it: the zoom, in 3D."""
        model = models[name]
        R, c0, _, zr, fit = projector(model)
        everything = np.ones(len(model.chrom), bool)
        if window is None:
            inside = model.chrom == "chr3"
        else:
            inside = (model.chrom == window[0]) & (model.start >= window[1]) & (model.start < window[2])

        def draw(x, y, w, h):
            s, cx, cy = fit(everything, x, y, w, h, 0.94)
            if whole_width is not None:  # the genome: every other chromosome thin, chromosome 3 over it
                return [draw_model(model, R, c0, s, cx, cy, lambda i: MODEL_REST, whole_width, ~inside, depth_range=zr,
                                   fog=0.45),
                        draw_model(model, R, c0, s, cx, cy, lambda i: MODEL_HI, width, inside, depth_range=zr, fog=0.2)]
            return [draw_model(model, R, c0, s, cx, cy, lambda i: MODEL_HI if inside[i] else MODEL_REST, width,
                               everything, depth_range=zr, fog=0.3, run=3)]

        return draw

    mgene = models["gene"]
    # seen from the other side from the rest: Sox2's promoter and its control region, where the marks are,
    # face the reader rather than lying behind the chain
    Rg, cg, _, zg, fitg = projector(mgene, yaw=0.35 + math.pi)
    k27_gene, k4_gene = bead_track(mgene, "h3k27ac"), bead_track(mgene, "h3k4me3")
    atg_bead = int(np.argmin(np.abs(mgene.start + mgene.binsize / 2 - ATG)))

    model_low = mix(MODEL_REST, "#ffffff", 0.3)  # a model coloured by a track: pale where the track is low

    def ramp_of(values, colour):
        """A track on a model by the app's rule (src/structure/colour.ts, `robustRangeOf`): linear from its
        2nd to its 98th percentile, here from pale grey to the track's colour. Returns the colour and the
        position on the ramp, bead by bead, and the two ends."""
        lo, hi = float(np.nanpercentile(values, 2)), float(np.nanpercentile(values, 98))

        def at(i):
            v = values[i]
            return 0.0 if not np.isfinite(v) else float(np.clip((v - lo) / (hi - lo), 0, 1))

        def of(i):
            return model_low if not np.isfinite(values[i]) else mix(model_low, colour, at(i))

        return of, at, lo, hi

    def m3d_gene(x, y, w, h):
        out = []
        half = (w - 1.0) / 2
        for k, (vals, colour, label) in enumerate(((k27_gene, K27AC, "H3K27ac"), (k4_gene, K4ME3, "H3K4me3"))):
            hx = x + k * (half + 1.0)
            s, cx, cy = fitg(np.ones(len(mgene.chrom), bool), hx, y, half, h - 3.0, 0.95)
            of, at, _, _ = ramp_of(vals, colour)
            # marked beads drawn thicker as well as darker: the marks sit in a few beads of 125
            out.append(draw_model(mgene, Rg, cg, s, cx, cy, of, 0.42, np.ones(len(mgene.chrom), bool),
                                  depth_range=zg, fog=0.15, run=3, width_of=lambda i, at=at: 0.85 + 0.9 * at(i)))
            P = (mgene.xyz[atg_bead] - cg) @ Rg.T
            out.append(circle(cx + P[0] * s, cy - P[1] * s, 0.8, stroke=INK, sw=0.2))
            kx, ky, kw = hx + 0.3, y + h - 2.4, 3.2
            for t in np.linspace(0, 1, 12):
                out.append(rect(kx + t * kw * 11 / 12, ky, kw / 12 + 0.02, 0.8, fill=mix(model_low, colour, t)))
            out.append(text(kx + kw + 0.5, ky + 0.8, label, size=5, fill=INK2))
        out.append(line(x + half + 0.5, y + 1.0, x + half + 0.5, y + h - 1.0, stroke=RULE, sw=0.15, dash="0.5 0.5"))
        return out

    def m3d_units(x, y, w, h):
        """What the last column can draw that the others cannot: the finest unit of each dimension."""
        out = [text(x + 1.4, y + 2.6, "finest unit drawn", size=5, fill=INK3)]
        for r_, (dim_, unit_, size_) in enumerate([("3D", "bead", "2 kb"), ("2D", "bin", "2 kb"),
                                                   ("1D", "base", "1 bp")]):
            yy_ = y + 5.4 + r_ * 2.6
            lx = x + 2.4
            if dim_ == "3D":
                out.append(circle(lx, yy_ - 0.6, 0.75, fill=C3D))
            elif dim_ == "2D":
                out.append(rect(lx - 0.7, yy_ - 1.3, 1.4, 1.4, fill=C2D))
            else:
                out.append(text(lx, yy_, "A", size=5.2, weight="bold", mono=True, fill=BASES["A"], anchor="middle"))
            out.append(text(lx + 1.6, yy_, dim_, size=5, weight="bold", fill=DIM[dim_]))
            out.append(text(lx + 1.6 + tw("3D ", 5, bold=True), yy_, f"one {unit_}: {size_}", size=5, fill=INK2))
        return out

    # ---- the tracks under each column, chosen for what that scale shows
    e1 = tracks.bins("e1", "chr3", 0, chr3_len, m_chr3.shape[0])
    # 10 Mb of a 10-kb track in 27 mm: averaged to 40 kb, about a third of a millimetre each, so it reads
    # as a profile rather than as ink
    ins_region = tracks.bins("insulation", *W_REGION, 250)
    borders = load_bed(next((RES / "insulation").glob("*boundaries.bed")))
    domains = load_bed(next((RES / "insulation").glob("*domains.bed")))
    b_region = [(a + b) / 2 for c, a, b in borders if c == "chr3" and W_REGION[1] <= a < W_REGION[2]]
    ctcf_locus = tracks.bins("ctcf", *W_LOCUS, 250)
    k27_gene_t, k4_gene_t = tracks.bins("h3k27ac", *W_GENE, 250), tracks.bins("h3k4me3", *W_GENE, 250)

    def t_genome(x, y, w, h):
        out = []
        bh = 2.3
        for i, (c, n) in enumerate(layout):
            a, b = x + offsets[c] / total * w, x + (offsets[c] + n) / total * w
            colour = MODEL_HI if c == "chr3" else ("#c3c8cf" if i % 2 else "#d6dae0")
            out.append(rect(a + 0.05, y + 0.6, max(b - a - 0.1, 0.1), bh, fill=colour, rx=bh * 0.45))
        a, b = chr3_frac
        out.append(text(x + (a + b) / 2 * w, y + 0.6 + bh / 2 + 0.62, "3", size=5, weight="bold", fill="#ffffff",
                        anchor="middle"))
        cy = y + 4.0
        out.append(area(x, cy, w, h - 4.4, cov_genome, COVER, vmax=float(np.nanpercentile(cov_genome, 99.5))))
        out.append(track_label(x, cy - 0.2, "contacts", INK2))
        return out

    def t_chr3(x, y, w, h):
        v = np.nan_to_num(e1)
        top = float(np.nanpercentile(np.abs(e1), 98)) or 1.0
        mid = y + h / 2 + 0.4
        hh = h - 3.4
        out = [line(x, mid, x + w, mid, stroke=RULE, sw=0.1)]
        step = w / len(v)
        for sign, colour in ((1, COMP_A), (-1, COMP_B)):
            d = []
            for i, val in enumerate(v):
                if val * sign > 0:
                    bar = min(abs(val) / top, 1) * hh / 2
                    d.append(f"M{f(x + i * step)},{f(mid)} h{f(step)} v{f(-sign * bar)} h{f(-step)} Z")
            out.append(path(" ".join(d), fill=colour))
        out.append(track_label(x, y - 0.3, "E1", INK2))
        out.append(text(x + w - 0.2, y + 1.6, "A", size=5, weight="bold", fill=COMP_A, anchor="end"))
        out.append(text(x + w - 0.2, y + h + 0.3, "B", size=5, weight="bold", fill=COMP_B, anchor="end"))
        return out

    def t_region(x, y, w, h):
        v = np.array(ins_region, float)
        lo_i, hi_i = np.nanpercentile(v, 1), np.nanpercentile(v, 99)
        top, th = y + 1.6, h - 6.0
        out = []
        if lo_i < 0 < hi_i:
            z = top + th * hi_i / (hi_i - lo_i)
            out.append(line(x, z, x + w, z, stroke=RULE, sw=0.1))
        out.append(polyline(x, top, w, th, np.nan_to_num(v), INSUL, lo_i, hi_i, sw=0.18))
        out.append(track_label(x, y - 0.4, "insulation", INSUL))
        # the borders on a lane of their own, under a label of their own
        out.append(text(x + 0.3, y + h - 2.3, "borders", size=5, fill=INSUL))
        for p_ in b_region:
            u = (p_ - W_REGION[1]) / (W_REGION[2] - W_REGION[1])
            out.append(line(x + u * w, y + h - 1.9, x + u * w, y + h - 0.2, stroke=INSUL, sw=0.16))
        return out

    def t_locus(x, y, w, h):
        out = genes_lane(x, y + 0.2, w, 3.2, genes3, "chr3", W_LOCUS[1], W_LOCUS[2], arrows=False)
        out.append(area(x, y + 4.6, w, h - 4.8, ctcf_locus, CTCF, vmax=float(np.nanpercentile(ctcf_locus, 99.5))))
        out.append(track_label(x, y + 4.4, "CTCF", CTCF))
        return out

    def t_gene(x, y, w, h):
        out = genes_lane(x, y + 0.2, w, 3.2, genes3, "chr3", W_GENE[1], W_GENE[2], hero="Sox2")
        a = (SCR - W_GENE[1]) / (W_GENE[2] - W_GENE[1])
        out.append(text(x + a * w, y + 3.0, "SCR", size=5, fill=INK, anchor="middle"))
        th = (h - 4.4) / 2
        for k_, (v, colour, label) in enumerate(((k27_gene_t, K27AC, "H3K27ac"), (k4_gene_t, K4ME3, "H3K4me3"))):
            yy = y + 4.0 + k_ * (th + 0.2)
            out.append(area(x, yy, w, th, v, colour, vmax=float(np.nanpercentile(v, 99.5))))
            out.append(track_label(x, yy - 0.2, label, colour))
        return out

    sox2 = next(g_ for g_ in genes3 if g_["name"] == "Sox2")
    gc = np.array([sum(ch in "GC" for ch in seq_bp[max(0, i - 25):i + 25]) / len(seq_bp[max(0, i - 25):i + 25])
                   for i in range(0, len(seq_bp), 5)])
    cpg = [i for i in range(len(seq_bp) - 1) if seq_bp[i:i + 2] == "CG"]

    def t_bp(x, y, w, h):
        out = []
        span = W_BP[2] - W_BP[1]
        gy = y + 1.6
        tss = x + max(0, sox2["start"] - W_BP[1]) / span * w
        atg = x + (ATG - W_BP[1]) / span * w
        out.append(rect(tss, gy - 0.45, atg - tss, 0.9, fill="#5b6169"))  # 5' UTR
        out.append(rect(atg, gy - 0.85, x + w - atg, 1.7, fill=INK))  # coding, from the start codon on
        out.append(path(f"M{f(tss)},{f(gy - 0.45)} v-1.2 h1.4", stroke=INK, sw=0.18))
        out.append(arrow_head(tss + 1.9, gy - 1.65, 0.0, 0.7, INK))
        # named past the arrow, over its own 5' UTR, inside the column
        out.append(rich(tss + 2.5, gy - 0.85, [("Sox2", True)], size=5, fill=INK))
        out.append(area(x, y + 3.6, w, 2.9, gc, INK3, vmax=1.0))
        out.append(track_label(x, y + 3.4, "GC", INK2))
        # CpGs on a lane of their own, under a label of their own
        out.append(text(x + 0.3, y + h - 2.3, "CpG", size=5, fill=CTCF))
        for i in cpg:
            cx_ = x + (i + 1) / span * w
            out.append(line(cx_, y + h - 1.9, cx_, y + h - 0.2, stroke=CTCF, sw=0.14))
        return out

    def zoom(a, b):
        return f"×{(a[2] - a[1]) / (b[2] - b[1]):.0f}"

    def mb(v):
        return f"{v / 1e6:g}"

    cascade = [
        dict(title=[("Genome", False)], sub=f"{total / 1e9:.1f} Gb | 2.5 Mb bins", zoom=f"×{total / chr3_len:.0f}",
             model3d=thread("genome", None, 0.34, whole_width=0.2), map2d=map_genome, tracks1d=t_genome,
             next=chr3_frac),
        dict(title=[("Chromosome 3", False)], sub=f"{chr3_len / 1e6:.0f} Mb | 250 kb bins", zoom=zoom(W_CHR3, W_REGION),
             model3d=thread("chr3", W_REGION, 0.32), map2d=map_chr3, tracks1d=t_chr3, next=frac(W_REGION, W_CHR3)),
        dict(title=[(f"chr3:{mb(W_REGION[1])}–{mb(W_REGION[2])} Mb", False)], sub="10 Mb | 10 kb bins",
             zoom=zoom(W_REGION, W_LOCUS), model3d=thread("region", W_LOCUS, 0.24), map2d=map_region,
             tracks1d=t_region, next=frac(W_LOCUS, W_REGION)),
        dict(title=[(f"chr3:{mb(W_LOCUS[1])}–{mb(W_LOCUS[2])} Mb", False)], sub="1 Mb | 5 kb bins",
             zoom=zoom(W_LOCUS, W_GENE), model3d=thread("locus", W_GENE, 0.42), map2d=map_locus, tracks1d=t_locus,
             next=frac(W_GENE, W_LOCUS)),
        dict(title=[("chr3:34.55–34.80 Mb", False)], sub="250 kb | 2 kb bins", zoom=zoom(W_GENE, W_BP),
             model3d=m3d_gene, map2d=map_gene, tracks1d=t_gene, next=frac(W_BP, W_GENE)),
        dict(title=[("Sox2", True), (" start codon", False)], sub="1 kb | single bases", model3d=m3d_units,
             map2d=map_bp, tracks1d=t_bp, next=None),
    ]

    # ---- d: the chain, on the map at 10 kb
    print("chain")
    W_D = ("chr3", 32_000_000, 36_000_000)
    m_d = clr[10000].matrix(balance=True).fetch("chr3:32000001-36000000")
    lo_d, hi_d = auto_range(m_d)
    d_map = png_bytes(triangle(m_d, lo_d, hi_d, 900))
    nd = m_d.shape[0]
    d_tracks = {k: tracks.bins(k, *W_D, 200) for k in ("ctcf", "h3k27ac", "h3k4me3")}
    depth = 140
    band_png = png_bytes(triangle(m_d, lo_d, hi_d, 1000, depth))
    ins = tracks.bins("insulation", *W_D, nd)
    b_in = [(a, b) for c, a, b in borders if c == W_D[0] and W_D[1] <= a < W_D[2]]
    d_in = [(a, b) for c, a, b in domains if c == W_D[0] and a >= W_D[1] and b <= W_D[2]]

    def d_borders(x, y, w, h):
        out = []
        th = w * depth / (2 * nd)
        out.append(image(x, y, w, th, band_png))
        span_max = depth / nd
        for a, b in d_in:
            u, v = (a - W_D[1]) / (W_D[2] - W_D[1]), (b - W_D[1]) / (W_D[2] - W_D[1])
            xa, xb = x + u * w, x + v * w
            if v - u <= span_max:
                d = f"M{f(xa)},{f(y + th)} L{f((xa + xb) / 2)},{f(y + th - (v - u) * w / 2)} L{f(xb)},{f(y + th)}"
            else:
                yt = y + th - span_max * w / 2
                d = (f"M{f(xa)},{f(y + th)} L{f(xa + span_max * w / 2)},{f(yt)} L{f(xb - span_max * w / 2)},{f(yt)} "
                     f"L{f(xb)},{f(y + th)}")
            out.append(path(d, stroke=INSUL, sw=0.2, extra='stroke-linejoin="round"'))
        ty = y + th + 0.7
        thh = 3.6
        v = np.nan_to_num(ins)
        lo_i, hi_i = np.nanpercentile(ins, 1), np.nanpercentile(ins, 99)
        if lo_i < 0 < hi_i:
            out.append(line(x, ty + thh * (hi_i / (hi_i - lo_i)), x + w, ty + thh * (hi_i / (hi_i - lo_i)),
                            stroke=RULE, sw=0.1))
        out.append(polyline(x, ty, w, thh, v, INSUL, lo_i, hi_i, sw=0.26))
        for a, b in b_in:
            u = ((a + b) / 2 - W_D[1]) / (W_D[2] - W_D[1])
            out.append(line(x + u * w, ty + thh + 0.35, x + u * w, ty + thh + 1.25, stroke=INSUL, sw=0.22))
        out.append(text(x, ty + thh + 3.3, "insulation track, borders and domains", size=5, fill=INK2))
        out.append(text(x, ty + thh + 5.4, f"{len(borders):,} borders, {len(domains):,} domains", size=5,
                        fill=INK3))
        return out

    mc = models["chr3"]
    Rc, cc, _, zc, fitc = projector(mc)
    ctcf_chr3 = bead_track(mc, "ctcf")
    ctcf_ramp, ctcf_at, c_lo, c_hi = ramp_of(ctcf_chr3, CTCF)

    def d_model(x, y, w, h):
        out = []
        frame_h = h - 4.0
        out.append(rect(x, y, w, frame_h, fill="#ffffff", stroke="#c9ced5", sw=0.12))
        s, cx, cy = fitc(np.ones(len(mc.chrom), bool), x + 0.6, y + 0.4, w - 5.0, frame_h - 0.8, 0.98)
        out.append(draw_model(mc, Rc, cc, s, cx, cy, ctcf_ramp, 0.36, np.ones(len(mc.chrom), bool),
                              depth_range=zc, fog=0.15, run=3, width_of=lambda i: 0.85 + 0.6 * ctcf_at(i)))
        # the key, inside the frame: CTCF's 2nd percentile at the foot, its 98th at the head
        kx, ky, kh = x + w - 2.6, y + 2.6, frame_h - 5.2
        for t in np.linspace(0, 1, 24):
            out.append(rect(kx, ky + (1 - t) * kh - kh / 24, 0.9, kh / 24 + 0.02, fill=mix(model_low, CTCF, t)))
        out.append(text(kx + 0.45, ky - 0.5, num(c_hi), size=5, fill=INK3, anchor="middle"))
        out.append(text(kx + 0.45, ky + kh + 1.75, num(c_lo), size=5, fill=INK3, anchor="middle"))
        out.append(text(x, y + frame_h + 2.3, "chromosome 3, coloured by CTCF", size=5, fill=INK2))
        beads = fit_rows.get("Beads", "").split(" of ")[0]
        out.append(text(x, y + frame_h + 4.3, f"{beads} beads of 250 kb", size=5, fill=INK3))
        return out

    mp_path = next((RES / "metaplot").glob("*metaplot.tsv"))
    mp_rows = [l.rstrip("\n").split("\t") for l in open(mp_path) if not l.startswith("#")]
    mp_head, mp = mp_rows[0], np.array([[float(v) for v in r] for r in mp_rows[1:]])
    dist = mp[:, 0]
    flank = np.abs(dist) > 80_000
    centre_i = np.argsort(np.abs(dist))[:2]
    quartiles = []
    for gi in range(1, 5):
        col = next(i for i, hname in enumerate(mp_head) if hname.endswith(f"group {gi}"))
        v = mp[:, col] / mp[flank, col].mean()
        quartiles.append((v, float(v[centre_i].mean())))
    # strongest quarter darkest, weakest palest, far enough apart to tell at 5 pt
    q_colours = [mix(CTCF, "#000000", 0.45), CTCF, mix(CTCF, "#ffffff", 0.45), mix(CTCF, "#ffffff", 0.72)]

    def d_metaplot(x, y, w, h):
        out = []
        pw, ph = 12.5, h - 3.0
        px, py = x, y + 0.5
        hi_f = max(v.max() for v, _ in quartiles) * 1.04
        lo_f = min(v.min() for v, _ in quartiles) * 0.98
        out.append(line(px, py + ph, px + pw, py + ph, stroke=INK3, sw=0.12))
        out.append(line(px + pw / 2, py, px + pw / 2, py + ph, stroke=INK3, sw=0.12, dash="0.5 0.4"))
        for (v, _), colour in reversed(list(zip(quartiles, q_colours))):
            xs_ = px + (dist - dist.min()) / (dist.max() - dist.min()) * pw
            ys_ = py + ph - (v - lo_f) / (hi_f - lo_f) * ph
            out.append(path("M" + " L".join(f"{f(a)},{f(b)}" for a, b in zip(xs_, ys_)), stroke=colour, sw=0.32,
                            extra='stroke-linejoin="round"'))
        out.append(text(px, py + ph + 2.0, "−100 kb", size=5, fill=INK3))
        out.append(text(px + pw, py + ph + 2.0, "+100", size=5, fill=INK3, anchor="end"))
        tx = px + pw + 1.5
        out.append(text(tx, y + 2.3, "CTCF at domain borders", size=5.5, weight="bold", fill=INK))
        out.append(text(tx, y + 4.4, "by quarter of border strength", size=5, fill=INK2))
        # the four quarters on two rows, strongest first, each with its centre-over-flank fold
        col_w = max(tw(f"Q{qi + 1} {fold:.1f}×", 5) for qi, (_, fold) in enumerate(quartiles)) + 3.4
        for qi, ((_, fold), colour) in enumerate(zip(quartiles, q_colours)):
            cx_, cy_ = tx + (qi % 2) * col_w, y + 6.6 + (qi // 2) * 2.1
            out.append(line(cx_, cy_ - 0.5, cx_ + 1.3, cy_ - 0.5, stroke=colour, sw=0.7))
            out.append(text(cx_ + 1.6, cy_, f"Q{qi + 1} {fold:.1f}×", size=5, fill=INK))
        return out

    _, pile = load_table(next((RES / "domains").glob("*apa-0.tsv")))
    pile = pile[:, :pile.shape[0]]
    pile_png = png_bytes(square(np.log2(pile), -0.5, 0.5, 12, LUT_RDBU))

    def d_pileup(x, y, w, h):
        out = []
        side = h - 0.6
        out.append(image(x, y + 0.3, side, side, pile_png))
        out.append(rect(x, y + 0.3, side, side, stroke=INK3, sw=0.1))
        tx = x + side + 1.5
        out.append(text(tx, y + 2.3, f"{len(domains):,} domains", size=5.5, weight="bold", fill=INK))
        out.append(text(tx, y + 4.5, "rescaled and piled up", size=5, fill=INK2))
        out.append(text(tx, y + 6.6, "against matched controls", size=5, fill=INK2))
        ky = y + 8.9
        out.append(text(tx, ky, "0.7", size=5, fill=INK3))
        kx = tx + tw("0.7 ", 5)
        for t in np.linspace(0, 1, 30):
            out.append(rect(kx + t * 7.5, ky - 1.25, 7.5 / 30 + 0.02, 1.0, fill=lut_hex(LUT_RDBU, t)))
        out.append(text(kx + 8.4, ky, "1.4 O/E", size=5, fill=INK3))
        return out

    fit_rows = {l.split("\t")[0]: l.rstrip("\n").split("\t")[1] for l in open(next((RES / "model-chr3").glob("*fit.tsv")))
                if not l.startswith("#") and "\t" in l}

    agree = {}
    for l in open(next((RES / "model-vs-map").glob("*agreement.tsv"))):
        if l.startswith("#") or l.startswith("sequence"):
            continue
        q = l.rstrip("\n").split("\t")
        agree[q[0]] = float(q[3])
    obs = m_chr3
    _, pred = load_table(next((RES / "model-vs-map").glob("*predicted--1.tsv")))
    pred = pred[:, :pred.shape[0]]
    n5 = min(obs.shape[0], pred.shape[0])
    obs, pred = obs[:n5, :n5], pred[:n5, :n5]
    lo_o, hi_o = auto_range(obs)
    lo_m, hi_m = auto_range(pred)
    both = colorize(pred, lo_m, hi_m, LUT)
    iu = np.triu_indices(n5, 0)
    both[iu] = colorize(obs, lo_o, hi_o, LUT)[iu]
    rep = max(1, 1200 // n5)
    both = np.repeat(np.repeat(both, rep, 0), rep, 1)
    versus_png = png_bytes(np.dstack([both, np.full(both.shape[:2], 255, np.uint8)]))
    rho3 = agree.get("chr3", float("nan"))

    def d_versus(x, y, w, h):
        out = []
        side = h - 0.6
        out.append(image(x, y + 0.3, side, side, versus_png))
        out.append(rect(x, y + 0.3, side, side, stroke=INK3, sw=0.1))
        out.append(line(x, y + 0.3, x + side, y + 0.3 + side, stroke="#ffffff", sw=0.15))
        out.append(text(x + side - 0.5, y + 2.2, "map", size=5, fill=INK, anchor="end", halo="#ffffff"))
        out.append(text(x + 0.5, y + side - 0.2, "model", size=5, fill=INK, halo="#ffffff"))
        tx = x + side + 1.5
        out.append(text(tx, y + 2.3, f"Spearman ρ = {rho3:.2f}", size=5.5, weight="bold", fill=INK))
        out.append(text(tx, y + 4.5, "chromosome 3, contacts", size=5, fill=INK2))
        out.append(text(tx, y + 6.6, "vs 1/distance in the model", size=5, fill=INK2))
        return out

    pills = {
        "insulation": ("Diamond insulation", ("2D", "1D"), "insulation --window 10"),
        "model": ("Model from the map", ("2D", "3D"), "reconstruct3d --region chr3"),
        "metaplot": ("Metaplot", ("1D", "1D"), "metaplot --rankBy score", [("CTCF track", CTCF)]),
        "pileup": ("Domain APA pile-up", ("1D", "2D"), "apa --mode scaled", [("the map", C2D)]),
        "distance": ("Distance-based map", ("3D", "2D"), "structuremap --region chr3"),
    }
    fits = {k: {l.split("\t")[0]: l.rstrip("\n").split("\t")[1]
                for l in open(next((RES / f"model-{k}").glob("*fit.tsv"))) if not l.startswith("#") and "\t" in l}
            for k in ("genome", "chr3", "region", "locus", "gene")}
    numbers = dict(borders=len(borders), domains=len(domains), ctcf_quartiles=[round(q, 2) for _, q in quartiles],
                   rho3=rho3, loops_in_locus=len(loops_locus), oe_lim=oe_lim, corr_lim=corr_lim,
                   ctcf_on_model=(round(c_lo, 2), round(c_hi, 2)),
                   limits=dict(genome=lim_genome, region=lim_region, gene=lim_gene),
                   beads={k: v.get("Beads", "") for k, v in fits.items()},
                   model_rho={k: v.get("Spearman ρ (1/d vs contacts)", "") for k, v in fits.items()},
                   genome_gb=total / 1e9, zoom_genome=total / chr3_len)
    print(numbers)
    return dict(cascade=cascade, d_map=d_map, d_tracks=d_tracks, d_pills=pills, d_borders=d_borders,
                d_metaplot=d_metaplot, d_pileup=d_pileup, d_model=d_model, d_versus=d_versus, numbers=numbers)


def main() -> None:
    data = prepare()
    parts: list[str] = []
    a, a_bottom = panel_a(0.0, 0.0, 120.0)
    parts += a
    top_h = a_bottom + 1.0
    parts += panel_b(123.0, 0.0, 57.0, top_h)
    c, c_bottom = panel_c(0.0, top_h + 2.4, data)
    parts += c
    d, d_bottom = panel_d(0.0, c_bottom + 3.0, data)
    parts += d
    height = round(d_bottom + 0.8, 1)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'width="{W}mm" height="{height}mm" viewBox="0 0 {W} {height}" font-family="{FONT}">\n'
           f'<rect width="{W}" height="{height}" fill="#ffffff"/>\n' + "\n".join(parts) + "\n</svg>\n")
    (HERE / "figure1.svg").write_text(svg)
    print(f"wrote figure1.svg ({len(svg) / 1e6:.1f} MB, {W:.0f} x {height:.0f} mm)")


if __name__ == "__main__":
    main()
