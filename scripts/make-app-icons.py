#!/usr/bin/env python
"""
metacooler.js — app icon generator.

Draws the "Field" mark (a block-diagonal contact map with long-range contacts)
on a macOS-style plate: continuous-curvature squircle, hairline border, subtle
vertical gradient, soft drop shadow.

    npm run icons:app          # or: python3 scripts/make-app-icons.py
    pip install pillow numpy

**The dark variant is the one that ships**, at every size and on every target.
The light one is still drawn, into `out/`, because a mark that exists in only
one value is one nobody can place on a light background later — but nothing in
the build reads it, and nothing should start to without changing this comment.

What this writes, and who reads it:

    public/icon-192.png          the web manifest's install icon
    public/icon-512.png          the same, and the Android splash
    public/apple-touch-icon.png  the iOS home screen — full bleed, see `bleed`
    build/icon.png               1024, the one square electron-builder derives
                                 every macOS, Windows and Linux icon from
    index.html                   the `<link rel="icon">` data URI, rewritten in
                                 place from the constants below

    out/icon_{dark,light}_NNNN.png   the full ladder, for anything that wants a
                                     PNG by hand. Read by nothing; not committed.

All five are *committed*, because they are build inputs rather than build
output: a fresh clone builds the site and packs an installer without a Python
interpreter anywhere near it. Rerun this after changing anything above the
fold, and commit what it changes.

There is no `.icns` step. electron-builder converts `build/icon.png` into the
`.icns`, the `.ico` and the Linux hicolor ladder itself, and a hand-assembled
iconset beside it is a second copy to keep in step with this one.
"""

from __future__ import annotations

import colorsys
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------- palette
PAPER_HI = (255, 252, 248)   # light plate, top of gradient
PAPER_LO = (216, 203, 183)   # light plate, bottom
INK_HI   = (44, 35, 30)      # dark plate, top of gradient
INK_LO   = (15, 11, 9)       # dark plate, bottom
EMBER    = (180, 65, 29)     # cells on the light plate
EMBER_LT = (206, 92, 48)     # cells on the dark plate
RIM_HI   = (96, 70, 54)      # light plate's edge, top — warm, so it is not a grey line
RIM_LO   = (21, 16, 13)      # light plate's edge, bottom, where the plate is in shade

# Which variant every target gets. One name, one line, because the icon has to
# be the same object in the dock, in the tab and on the home screen — picking
# per target is how a set of icons stops being a set.
SHIPPED = "dark"

# What separates the two, which is more than a background colour.
#
# `rim` is the outermost hairline and `bevel` the highlight immediately inside
# it; both are vertical gradients, top colour to bottom, RGBA. That is the whole
# difference between a flat rounded square and something that reads as an
# object: a plate lit from above is brightest along its top edge and darkest
# along the bottom, and the eye reads those two lines before it reads anything
# in the middle.
#
# The dark plate needs no bevel — on ink, the white rim *is* the highlight, and
# a second one inside it only muddies the corners. The light plate does: its
# rim has to be dark enough to hold an edge against white, and a dark line
# straight against pale paper looks drawn on rather than lit, until a highlight
# sits between them.
VARIANTS = {
    "dark": {
        "plate": (INK_HI, INK_LO),
        "cells": EMBER_LT,
        "rim": ((255, 255, 255, 85), (255, 255, 255, 32)),
        "bevel": None,
    },
    "light": {
        "plate": (PAPER_HI, PAPER_LO),
        "cells": EMBER,
        "rim": ((*RIM_HI, 185), (*RIM_LO, 232)),
        "bevel": ((255, 255, 255, 245), (255, 255, 255, 0)),
    },
}

# ----------------------------------------------------------------- geometry
OUT_DIR   = ROOT / "out"
OUT       = 1024             # nominal icon size
SS        = 4                # supersampling factor for antialiasing
C         = OUT * SS         # working canvas
ICON      = int(C * 824 / 1024)   # Apple's large-icon footprint in the canvas
R_FRAC    = 0.2237           # corner radius as a fraction of the plate width
SPAN      = 0.845            # the map's width as a fraction of the plate width
CELL_GAP  = 0.085            # gap around each cell, as a fraction of the pitch
CELL_ROUND = 0.17            # cell corner radius, as a fraction of cell size
RIM_W     = 0.0085           # edge hairline width, as a fraction of the plate
BEVEL_W   = 0.010            # highlight width just inside it, likewise
SIZES     = (512, 256, 128, 64, 32, 16)

# ----------------------------------------------------------------- the mark
N       = 7                                   # cells along the diagonal
BLOCKS  = [(0, 3), (3, 5), (5, 7)]            # three genomes / MAGs
ACCENTS = {(0, 6): 0.60, (6, 0): 0.60,        # longest-range contact
           (1, 4): 0.34, (4, 1): 0.34}        # mid-range contact
DECAY_IN  = 1.7      # intensity falloff within a block
FLOOR_IN  = 0.30     # minimum intensity within a block
BG_LEVEL  = 0.15     # background level between blocks
DECAY_OUT = 2.4      # intensity falloff between blocks
CUTOFF    = 0.06     # cells fainter than this are not drawn

# ----------------------------------------------------------- the two tracks
# A row of seven under the map and a column of seven to the left of it, which
# is where this application puts a track: the lanes grow towards the matrix
# from the bottom and the left edges, and a reader who has opened a bigWig
# beside a cooler has seen exactly this picture.
#
# The grid is therefore 8 x 8 rather than 7 x 7 — one lane, the map, and one
# lane — with the corner where the two lanes would meet left empty, because
# nothing is plotted against both axes at once.
#
# Each lane is a **hue and a saturation of its own**, which is the one thing a
# reader has to be able to do with two tracks on one screen: tell them apart at
# a glance and without a legend. Neither is the map's ember, and neither is the
# other's. Written as HSV rather than as hex for that reason — the two knobs
# that matter are named, and a hue can be turned without recomputing a triple
# by hand. Value falls on the light plate, where ink is dark on paper, and
# rises on the dark one; saturation stays put, because it is the identity.
# **One hue, two readings of it, and neither of them a cell.**
#
# The first attempt gave each lane a whole row of the grid and a hue of its
# own, and it cost more than it bought. Three hues on one plate is a generic
# analytics icon and breaks the rule the application is built on — colour means
# something here, and the map owns it. A full row of seven solid cells also
# outlasts a sparse diagonal at every downsample, so at 24 px the decoration
# became the identity and the matrix did not survive. And the 8 x 8 grid it
# needed took an eighth off the map, which is the subject.
#
# So the lanes are **slivers in the margin the plate already had**: a third of a
# pitch wide, a fifth of a pitch clear of the map, laid in the 7.75% of the
# plate that the 0.845 span leaves on every side. The map goes back to the size
# and the position it has always had — this is additive now, in the literal
# sense that nothing else moved.
#
# The two are one hue at two saturations and two values, which is how a browser
# draws two tracks that are not the same measurement, and is enough to read as
# two at any size a lane is still visible at. Beside ember they are the cool
# end of the same picture rather than a second and third opinion about it.
LANE_HUE = 202
LANE_W   = 0.30      # a lane's thickness, as a fraction of the map's pitch
LANE_GAP = 0.20      # clear air between the map's edge and the lane, likewise
LANE_ROUND = 0.34    # a sliver's corner radius, as a fraction of its thickness

TRACKS = {
    #                sat    value-on-dark / value-on-light
    "left":   {"s": 0.58, "v": {"dark": 0.88, "light": 0.58}},
    "bottom": {"s": 0.30, "v": {"dark": 0.60, "light": 0.38}},
}

# What each lane reads, as seven levels.
#
# Not a mirror of each other, because two tracks that agree everywhere are one
# track drawn twice. Both rise at the first bin of each block — 0, 3 and 5, the
# starts of the three genomes — so the lanes and the blocks are visibly about
# the same thing, and they disagree in between, which is what having two of
# them is for.
TRACK_LEVELS = {
    "left":   [1.00, 0.52, 0.30, 0.86, 0.44, 0.74, 0.36],
    "bottom": [0.82, 0.38, 0.55, 1.00, 0.34, 0.68, 0.46],
}


def mark_origin(extent, span, pitch):
    """Where the map's top-left corner goes, given that it is not alone.

    Centring the map centres the *map*, and the mark is now a map with a lane
    off its left edge and another off its bottom one — so the ink runs from the
    left lane to the map's right edge and from the map's top edge to the bottom
    lane, and centring the square inside that leaves the two lanes hard against
    the rim with a margin twice their size on the other two sides.

    So the map is nudged half a lane's footprint right and half of it up, which
    puts the *whole mark* in the middle: both margins come out at 4.6% of the
    plate instead of 1.7% and 7.8%. It is optical centring, and it is the one
    thing the lanes ask of the map — the size and the spacing of the field are
    untouched, which is what this drawing of the lanes was for.
    """
    half = pitch * (LANE_W + LANE_GAP) / 2
    base = (extent - span) / 2
    return (base + half, base - half)


def lane_geometry(which, ox, oy, span, pitch, n=N):
    """Yield (x0, y0, x1, y1, level) for one lane, in canvas units.

    A sliver per bin, on the bin's own extent, so a lane lines up with the map
    cell it is about — which is the whole claim the mark is making. The gap
    between bins is the map's own `CELL_GAP`, for the same reason.
    """
    w = pitch * LANE_W
    gap = pitch * LANE_GAP
    pad = pitch * CELL_GAP
    size = pitch - 2 * pad
    for k, level in enumerate(TRACK_LEVELS[which]):
        if which == "left":
            x0 = ox - gap - w
            y = oy + k * pitch + pad
            yield (x0, y, x0 + w, y + size, level)
        else:
            y0 = oy + span + gap
            x = ox + k * pitch + pad
            yield (x, y0, x + size, y0 + w, level)

# ----------------------------------------------------------------- targets
# (path relative to the repository root, pixel size, full bleed).
#
# Only the iOS icon bleeds, and that is a platform rule rather than taste: iOS
# applies its *own* rounded mask and composites anything transparent onto black,
# so shipping the dock icon's inset squircle there produces a small plate inside
# a black square inside Apple's mask. A plain full-bleed square is what the mask
# expects.
TARGETS = (
    ("public/icon-192.png", 192, False),
    ("public/icon-512.png", 512, False),
    ("public/apple-touch-icon.png", 180, True),
    ("build/icon.png", 1024, False),
)


def squircle(cx, cy, half, r_frac=R_FRAC, n=5.0, steps=220):
    """Rounded square with Apple-style continuous-curvature corners: straight
    edges joined by superelliptical corner transitions."""
    R = 2 * half * r_frac
    a = half - R                       # where the corner box starts on each axis
    t = np.linspace(0, np.pi / 2, steps)
    ux = np.abs(np.cos(t)) ** (2.0 / n) * R
    uy = np.abs(np.sin(t)) ** (2.0 / n) * R
    pts = []
    pts += [(a + x, -(a + y)) for x, y in zip(ux, uy)]     # top-right
    pts += [(-(a + x), -(a + y)) for x, y in zip(uy, ux)]  # top-left
    pts += [(-(a + x), a + y) for x, y in zip(ux, uy)]     # bottom-left
    pts += [(a + x, a + y) for x, y in zip(uy, ux)]        # bottom-right
    return [(cx + x, cy + y) for x, y in pts]


def vgradient(size, top, bottom):
    """Vertical linear gradient as an RGB image."""
    ramp = np.linspace(0, 1, size)[:, None]
    g = np.zeros((size, size, 3), dtype=np.uint8)
    for k in range(3):
        g[:, :, k] = (top[k] * (1 - ramp) + bottom[k] * ramp).astype(np.uint8)
    return Image.fromarray(g, "RGB")


def field_cells(n=N):
    """Yield (row, col, intensity) for the block-diagonal contact map.

    Row 0 is the top row, so the main diagonal runs top-left to bottom-right.
    The map is symmetric, as a real contact matrix is.
    """
    def block_of(i):
        for k, (lo, hi) in enumerate(BLOCKS):
            if lo <= i < hi:
                return k
        return -1

    cells = []
    for i in range(n):
        for j in range(n):
            d = abs(i - j)
            if (i, j) in ACCENTS:
                a = ACCENTS[(i, j)]
            elif block_of(i) == block_of(j):
                a = max(np.exp(-d / DECAY_IN), FLOOR_IN)
            else:
                a = BG_LEVEL * np.exp(-d / DECAY_OUT)
            if a >= CUTOFF:
                cells.append((i, j, float(min(a, 1.0))))
    return cells


def track_rgb(which, variant):
    """One lane's colour on one plate, from the hue and the two knobs above."""
    spec = TRACKS[which]
    r, g, b = colorsys.hsv_to_rgb(LANE_HUE / 360.0, spec["s"], spec["v"][variant])
    return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))


def clip_to(layer, mask):
    """Intersect a layer's alpha with the plate mask."""
    layer.putalpha(Image.fromarray(
        np.minimum(np.array(layer.split()[3]), np.array(mask))))
    return layer


def disc(half):
    """A filled squircle, as an 8-bit mask."""
    m = Image.new("L", (C, C), 0)
    ImageDraw.Draw(m).polygon(squircle(C / 2, C / 2, half), fill=255)
    return np.array(m)


def band(half, width):
    """The ring between two concentric squircles, as an 8-bit mask.

    A difference of two filled shapes, deliberately, and not a stroked outline.
    `ImageDraw.line` along the silhouette puts half its width *outside* the
    plate, so it has to be clipped back — and clipping it against a mask whose
    own edge is antialiased eats most of what was drawn. That is why the light
    plate's border used to be a suggestion rather than a border: it was there
    at full strength in the layer and then thrown away in the compositing.
    Subtracting one disc from another is exact on both edges, and the result
    needs no clipping because it is inside the plate by construction.
    """
    return np.clip(disc(half).astype(np.int16) - disc(half - width), 0, 255).astype(np.uint8)


def band_layer(mask, top, bottom):
    """A ring filled with a vertical RGBA gradient, ready to composite.

    The alpha is part of the gradient rather than a constant, which is what
    lets one band be a bright highlight along the top edge and nothing at all
    along the bottom.
    """
    ramp = np.linspace(0, 1, C)[:, None]
    px = np.zeros((C, C, 4), dtype=np.uint8)
    for k in range(4):
        px[:, :, k] = (top[k] * (1 - ramp) + bottom[k] * ramp).astype(np.uint8)
    px[:, :, 3] = np.minimum(px[:, :, 3], mask)
    return Image.fromarray(px, "RGBA")


def build(variant=SHIPPED, n=N, bleed=False):
    """Render the mark and downsample it to OUT.

    `bleed` takes the plate to the edge of the canvas, square, with no drop
    shadow and no edge treatment: the inset squircle is right for a dock, where
    the icon floats and casts, and wrong anywhere the platform draws its own
    silhouette around it (see TARGETS). A rim under someone else's mask is a
    rim with a bite out of it.
    """
    spec = VARIANTS[variant]
    bg_top, bg_bot = spec["plate"]
    cell_col = spec["cells"]

    img = Image.new("RGBA", (C, C), (0, 0, 0, 0))
    extent = C if bleed else ICON
    poly = None if bleed else squircle(C / 2, C / 2, ICON / 2)

    if poly is None:
        mask = Image.new("L", (C, C), 255)
    else:
        mask = Image.new("L", (C, C), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)

        # soft drop shadow, offset low the way dock icons sit
        shadow = Image.new("RGBA", (C, C), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).polygon(
            squircle(C / 2, C / 2 + ICON * 0.018, ICON / 2), fill=(0, 0, 0, 74))
        img = Image.alpha_composite(
            img, shadow.filter(ImageFilter.GaussianBlur(ICON * 0.024)))

    # background plate
    plate = vgradient(C, bg_top, bg_bot).convert("RGBA")
    plate.putalpha(mask)
    img = Image.alpha_composite(img, plate)

    # the contact map, with a lane down its left side and another under it
    art = Image.new("RGBA", (C, C), (0, 0, 0, 0))
    draw = ImageDraw.Draw(art)
    span = extent * SPAN
    pitch = span / n
    ox, oy = mark_origin(C, span, pitch)
    pad = pitch * CELL_GAP
    size = pitch - 2 * pad
    for i, j, a in field_cells(n):
        x = ox + j * pitch + pad
        y = oy + i * pitch + pad
        draw.rounded_rectangle([x, y, x + size, y + size],
                               radius=size * CELL_ROUND,
                               fill=(*cell_col, int(round(a * 255))))
    for which in TRACKS:
        colour = track_rgb(which, variant)
        r = pitch * LANE_W * LANE_ROUND
        for x0, y0, x1, y1, level in lane_geometry(which, ox, oy, span, pitch, n):
            draw.rounded_rectangle([x0, y0, x1, y1], radius=r,
                                   fill=(*colour, int(round(level * 255))))
    img = Image.alpha_composite(img, clip_to(art, mask))

    # the edge: highlight first, hairline over it, both inside the silhouette
    if poly is not None:
        rim_w = ICON * RIM_W
        if spec["bevel"] is not None:
            img = Image.alpha_composite(
                img, band_layer(band(ICON / 2 - rim_w, ICON * BEVEL_W), *spec["bevel"]))
        img = Image.alpha_composite(img, band_layer(band(ICON / 2, rim_w), *spec["rim"]))

    return img.resize((OUT, OUT), Image.LANCZOS)


# ------------------------------------------------------------------ favicon
def _num(v):
    """A coordinate, as short as SVG will take it: `.83`, not `0.830`."""
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return s[1:] if s.startswith("0.") else s


# The favicon's rim, which is not RIM_W and cannot be.
#
# RIM_W is a hairline on a 1024 px plate. Scaled to the sixteen pixels a browser
# tab gives an icon it is a seventh of a pixel — which is to say, nothing. The
# rim is load-bearing at that size rather than decorative: it is the only thing
# separating a pale plate from a pale tab strip, so it is drawn heavy enough to
# survive the resampling and accepted as heavier than it should be at 512.
FAVICON_RIM_W = 0.028


def favicon_svg(variant=SHIPPED, n=N):
    """The shipped mark as an SVG, for the `<link rel="icon">` data URI.

    Full bleed, like the iOS icon and for a related reason: a browser tab gives
    the icon sixteen pixels, and the dock icon's transparent margin would spend
    three of them on nothing. The shadow goes with it — nothing casts at 16 px.

    Generated from the constants above rather than drawn a second time by hand.
    That is the point of it being here at all: the favicon this replaces was an
    independent two-rectangle drawing that the app icon was then asked to
    imitate, and "keep these two in step" is not a thing anybody does.

    One `<rect>` in `<defs>`, `<use>`d under a transform that puts the grid on
    integer coordinates. Thirty-three cells written out at full coordinates is
    three kilobytes of `index.html`; this is under two.
    """
    spec = VARIANTS[variant]
    (plate_hi, plate_lo), cells = spec["plate"], spec["cells"]
    (rim_hi, rim_lo) = spec["rim"]
    span = OUT * SPAN
    pitch = span / n
    ox, oy = mark_origin(OUT, span, pitch)
    cell = 1 - 2 * CELL_GAP                      # in grid units, so `<use>` is integral
    rim_w = OUT * FAVICON_RIM_W
    uses = "".join(
        f"<use href='#c' x='{j}' y='{i}'"
        + ("" if a > 0.995 else f" opacity='{_num(a)}'")
        + "/>"
        for i, j, a in field_cells(n)
    )

    # The lanes are in canvas units rather than grid units: they are a third of
    # a pitch across, which is not a whole number of anything, so a `<use>` of
    # the square in `<defs>` would need a second scale per lane to undo.
    lanes = "".join(
        f"<g fill='#{'%02x%02x%02x' % track_rgb(which, variant)}'>"
        + "".join(
            f"<rect x='{_num(x0)}' y='{_num(y0)}'"
            f" width='{_num(x1 - x0)}' height='{_num(y1 - y0)}'"
            f" rx='{_num(pitch * LANE_W * LANE_ROUND)}'"
            + ("" if level > 0.995 else f" opacity='{_num(level)}'")
            + "/>"
            for x0, y0, x1, y1, level in lane_geometry(which, ox, oy, span, pitch, n)
        )
        + "</g>"
        for which in TRACKS
    )
    grid = (
        f"<g fill='#{'%02x%02x%02x' % cells}'"
        f" transform='translate({_num(ox)} {_num(oy)}) scale({_num(pitch)})'>"
        f"{uses}</g>{lanes}"
    )
    return (
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {OUT} {OUT}'>"
        "<defs>"
        "<linearGradient id='p' x2='0' y2='1'>"
        f"<stop stop-color='#{'%02x%02x%02x' % plate_hi}'/>"
        f"<stop offset='1' stop-color='#{'%02x%02x%02x' % plate_lo}'/>"
        "</linearGradient>"
        "<linearGradient id='r' x2='0' y2='1'>"
        f"<stop stop-color='#{'%02x%02x%02x' % rim_hi[:3]}' stop-opacity='{_num(rim_hi[3] / 255)}'/>"
        f"<stop offset='1' stop-color='#{'%02x%02x%02x' % rim_lo[:3]}'"
        f" stop-opacity='{_num(rim_lo[3] / 255)}'/>"
        "</linearGradient>"
        f"<rect id='c' x='{_num(CELL_GAP)}' y='{_num(CELL_GAP)}'"
        f" width='{_num(cell)}' height='{_num(cell)}'"
        f" rx='{_num(cell * CELL_ROUND)}'/>"
        "</defs>"
        f"<rect width='{OUT}' height='{OUT}' rx='{_num(OUT * R_FRAC)}' fill='url(#p)'/>"
        f"{grid}"
        # Inset by half its width, because an SVG stroke straddles the path and
        # the outer half would be clipped away by the viewBox.
        f"<rect x='{_num(rim_w / 2)}' y='{_num(rim_w / 2)}'"
        f" width='{_num(OUT - rim_w)}' height='{_num(OUT - rim_w)}'"
        f" rx='{_num(OUT * R_FRAC - rim_w / 2)}'"
        f" fill='none' stroke='url(#r)' stroke-width='{_num(rim_w)}'/>"
        "</svg>"
    )


def favicon_data_uri(svg):
    """Percent-encode exactly what an HTML attribute and a URL each require.

    Not `urllib.parse.quote`, which escapes the spaces and the apostrophes too
    and doubles the length for nothing: inside a double-quoted attribute those
    are literal. `%` leads, or it would re-encode the escapes that follow it.
    `#` is the one that is not cosmetic — unescaped, it truncates the URI at the
    first colour and the icon is a blank plate.
    """
    for ch, code in (("%", "%25"), ("<", "%3C"), (">", "%3E"), ("#", "%23"), ('"', "%22")):
        svg = svg.replace(ch, code)
    return "data:image/svg+xml," + svg


# The whole element, however it happens to be wrapped: `[^>]` matches newlines,
# so a tag prettier has broken over four lines is still one match. `\brel="icon"`
# does not match `rel="apple-touch-icon"`, which is a different link and a real
# file rather than a data URI.
FAVICON_TAG = re.compile(r'^[ \t]*<link\s[^>]*\brel="icon"[^>]*>[ \t]*\r?\n', re.M)


def write_favicon(path):
    """Rewrite the `<link rel="icon">` element in `index.html`, or explain why not.

    Refuses on anything but exactly one match. A silent no-op here is the worst
    outcome available: every PNG target updates, the tab icon does not, and the
    two drift apart with nothing to notice it — which is the failure this
    function exists to have already fixed once.
    """
    html = path.read_text(encoding="utf-8")
    found = FAVICON_TAG.findall(html)
    if len(found) != 1:
        raise SystemExit(
            f'{path.name}: expected exactly one <link rel="icon"> element on its own '
            f"line, found {len(found)}. The favicon is written from "
            f"{Path(__file__).name}; fix the tag rather than editing it by hand."
        )
    tag = f'    <link rel="icon" href="{favicon_data_uri(favicon_svg())}" />\n'
    path.write_text(FAVICON_TAG.sub(lambda _: tag, html, count=1), encoding="utf-8")
    print(f"wrote {path.name} (favicon data URI, {len(tag)} bytes)")


def main():
    dark, light = build("dark"), build("light")
    bleed = build("dark", bleed=True)

    OUT_DIR.mkdir(exist_ok=True)
    for variant, icon in (("dark", dark), ("light", light)):
        icon.save(OUT_DIR / f"icon_{variant}_{OUT}.png")
        for px in SIZES:
            icon.resize((px, px), Image.LANCZOS).save(
                OUT_DIR / f"icon_{variant}_{px:04d}.png")
        print(f"wrote out/icon_{variant}_*: {OUT} + {', '.join(map(str, SIZES))}")

    for name, px, wants_bleed in TARGETS:
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        (bleed if wants_bleed else dark).resize((px, px), Image.LANCZOS).save(path)
        print(f"wrote {name} ({px} px{', full bleed' if wants_bleed else ''})")

    write_favicon(ROOT / "index.html")


if __name__ == "__main__":
    main()
