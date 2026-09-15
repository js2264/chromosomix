/**
 * Generate `src/ui/stores/rsg-mark.generated.ts`: the RSG store's tile mark.
 *
 *     npm run icons:rsg
 *
 * The mark is a Hi-C map 100 bins square whose diagonal spells *RSG*. That is
 * the whole idea: every other store's tile is a lettermark because its logo is
 * not ours to ship (`ui/stores/registry.ts` on `StoreMark.image`), but this one
 * is the lab's own, so it can be the thing the viewer actually draws — a
 * contact map, in the viewer's own colour scale, with the letters standing
 * where the main diagonal normally does.
 *
 * Three things make it read as Hi-C rather than as a gradient behind type:
 *
 * 1. **Distance decay.** Contact frequency falls with genomic separation, so
 *    the corners furthest from the diagonal are paper and the map is warm only
 *    near it. It is the one feature every Hi-C map has.
 * 2. **Domains.** Three of them, one framing each letter, denser inside than
 *    across a boundary — so each letter sits in its own TAD, which is also what
 *    gives the three letters their spacing.
 * 3. **Loops.** The corner peak a pair of domain boundaries makes, off the
 *    diagonal, at the three pairs the three domains form.
 *
 * The letters break the symmetry a real contact map has, and are meant to: a
 * mirrored *R* under the diagonal is a butterfly, not a letter. Everything
 * under them is symmetric, so what a reader sees is a Hi-C map with writing on
 * it rather than a picture that is neither.
 *
 * ## Why a data URI in a generated module, and not a file
 *
 * `public/` is not emitted by the standalone build (`vite.standalone.config.ts`
 * sets `publicDir: false`, and inlines what it needs by reading the bytes at
 * build time), so a `/store-rsg.png` would be a hole in the one build that has
 * no server to ask. A committed constant is what `icons.generated.ts` already
 * does for the icon set, for the same reason: it costs no request, it is in
 * every build target without any of them having to agree on asset handling,
 * and a CSP that blocks remote images cannot block it.
 *
 * ## Why an indexed PNG
 *
 * Colour type 3 is not a size trick here, though it is smaller. A Hi-C map *is*
 * a matrix of values plus a lookup table, and an indexed PNG is a matrix of
 * values plus a lookup table: the palette written below is the viewer's own
 * `default` ramp, the 256 entries of it, and each pixel is the index a cell's
 * value lands on. `test/unit/store-rsg-mark.test.ts` asserts the palette is
 * byte-for-byte `applyColormap('default')`, so the logo cannot drift away from
 * the ramp the maps beside it are drawn in.
 */

import { deflateSync, crc32 } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Bins a side. The brief's ceiling, and the mark is drawn at 72 at the largest. */
const N = 100

/** Entries in the palette, matching `COLORMAP_SIZE`. */
const LEVELS = 256

// --- the colour scale ------------------------------------------------------

/**
 * `DEFAULT_STOPS` from `src/render/colormaps.ts`, copied rather than imported
 * because this is a `.mjs` script and that is TypeScript. The test named in the
 * header is what keeps the copy honest.
 */
const DEFAULT_STOPS = [
  '#FFFEF9', '#FCF9CE', '#FFF2A9', '#FDE188', '#FFCA67', '#FAAA4B', '#F78E40',
  '#F15C34', '#ED3024', '#D42027', '#B01F29', '#7A1128', '#1A0A10',
]

/** `rampFromStops` from the same module, in the even-spacing case these stops want. */
function rampFromStops(stops, size) {
  const points = stops.map((hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ])
  const last = points.length - 1
  const out = new Uint8Array(size * 3)
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1)
    let lo = 0
    while (lo < last - 1 && t >= (lo + 1) / last) lo++
    const frac = (t - lo / last) / (1 / last)
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(points[lo][c] + (points[lo + 1][c] - points[lo][c]) * frac)
    }
  }
  return out
}

// --- the letterforms -------------------------------------------------------

/**
 * Each letter is drawn in its own box, `LETTER` bins square, in box
 * coordinates: x right, y *down*, origin top-left.
 *
 * Built from primitives rather than typed, for the reason `ui/icons.ts` gives
 * for drawing its icons instead of setting them in a font: a glyph is whatever
 * shape the machine happens to have, at whatever weight, and this one has to
 * survive being resampled to 26 pixels on a small tile. Built from primitives
 * rather than hand-plotted as a bitmap because the strokes then keep one weight
 * and the curves stay curves — the rasteriser below is what turns them into
 * pixels, at the resolution of the matrix, which is where the letters get their
 * blocky edges honestly.
 */
const LETTER = 26

/** Angles run counterclockwise from *east*, so 90 is the top of the box. */
const R_SHAPE = [
  // The stem, full height, and the widest stroke — the letter's spine.
  { kind: 'rect', x0: 0, y0: 0, x1: 6, y1: 26 },
  // The bowl: the right half of an elliptical ring, so its top and bottom bars
  // land thinner than the stem, which is what a bowl does on a real face.
  { kind: 'ring', cx: 6, cy: 7, rxO: 15, ryO: 7, rxI: 9.5, ryI: 3.2, a0: 270, a1: 90 },
  // The leg, from under the bowl to the bottom-right corner.
  { kind: 'seg', x0: 9.5, y0: 12.5, x1: 22, y1: 26, w: 6 },
]

const S_SHAPE = [
  // Upper bowl: from the top-right terminal, over the top, down the left, to
  // the waist. Lower bowl picks the waist up and mirrors it to the lower left.
  { kind: 'ring', cx: 13, cy: 7, rxO: 11, ryO: 7, rxI: 5.5, ryI: 3.2, a0: 20, a1: 270 },
  { kind: 'ring', cx: 13, cy: 19, rxO: 11, ryO: 7, rxI: 5.5, ryI: 3.2, a0: 200, a1: 90 },
]

const G_SHAPE = [
  // A ring with the upper right quadrant left open, which is the aperture.
  { kind: 'ring', cx: 13, cy: 13, rxO: 12, ryO: 13, rxI: 6.5, ryI: 8, a0: 60, a1: 359.9 },
  // The spur: what tells a G from a C, jutting in from the right at the waist.
  { kind: 'rect', x0: 12.5, y0: 10.5, x1: 25, y1: 15.5 },
]

/** Is `a` (degrees, `[0, 360)`) inside the arc from `a0` to `a1`, which may wrap? */
function inArc(a, a0, a1) {
  return a0 <= a1 ? a >= a0 && a <= a1 : a >= a0 || a <= a1
}

/** Is the point inside the primitive? One sample, no coverage — see `ink`. */
function hits(shape, x, y) {
  if (shape.kind === 'rect') {
    return x >= shape.x0 && x < shape.x1 && y >= shape.y0 && y < shape.y1
  }
  if (shape.kind === 'ring') {
    const dx = x - shape.cx
    const dy = y - shape.cy
    const outer = (dx / shape.rxO) ** 2 + (dy / shape.ryO) ** 2
    const inner = (dx / shape.rxI) ** 2 + (dy / shape.ryI) ** 2
    if (outer > 1 || inner < 1) return false
    // `-dy` because the box counts y downwards and the angles count it up.
    const a = (Math.atan2(-dy, dx) * 180) / Math.PI
    return inArc(a < 0 ? a + 360 : a, shape.a0, shape.a1)
  }
  // A thick segment: the distance from the point to the segment, capped round.
  const vx = shape.x1 - shape.x0
  const vy = shape.y1 - shape.y0
  const len2 = vx * vx + vy * vy
  const t = Math.max(0, Math.min(1, ((x - shape.x0) * vx + (y - shape.y0) * vy) / len2))
  const px = x - (shape.x0 + t * vx)
  const py = y - (shape.y0 + t * vy)
  return px * px + py * py <= (shape.w / 2) ** 2
}

/** How much of bin `(x, y)` the letter covers, `0` to `1`, by 4x4 supersampling. */
function ink(shape, x, y) {
  let hit = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4
      const py = y + (sy + 0.5) / 4
      if (shape.some((part) => hits(part, px, py))) hit++
    }
  }
  return hit / 16
}

// --- the map ---------------------------------------------------------------

/**
 * Where each letter's box sits: `at` is both its first row and its first
 * column, which is what puts the box square on the diagonal and the letter
 * standing on it rather than beside it.
 *
 * Evenly spaced, and the spacing owes nothing to `DOMAINS` — see there for why
 * the two are deliberately out of step.
 */
const LETTERS = [
  { shape: R_SHAPE, at: 4 },
  { shape: S_SHAPE, at: 37 },
  { shape: G_SHAPE, at: 70 },
]

/**
 * The domains, as `[first, last]` bins.
 *
 * Six of them, of six different widths, and deliberately *not* one per letter:
 * three domains with a letter centred in each drew a noughts-and-crosses grid,
 * three coloured squares on a pale ground, which is a diagram of a tiling and
 * not a picture of a genome. Boundaries that fall across the letters instead
 * make the map something the letters are written on.
 */
const DOMAINS = [
  [1, 14],
  [15, 33],
  [34, 52],
  [53, 63],
  [64, 84],
  [85, 98],
]

/**
 * Loop anchors, as pairs of bins: a few of the domains' own corner peaks, and a
 * few longer-range pairs between them. Drawn on both sides of the diagonal,
 * because a contact between two loci is one fact and the matrix records it
 * twice.
 */
const LOOPS = [
  [15, 33], [34, 52], [64, 84],
  [15, 52], [34, 84], [1, 63], [53, 98],
]

/**
 * Where bin `i` sits in the A/B compartment track: about `+1` in one and about
 * `-1` in the other.
 *
 * Two waves rather than one, so the alternation is uneven the way a real one is
 * instead of a regular stripe — and saturated hard, because a compartment is a
 * *label* a bin carries and not a level it sits at. Left as the smooth sum, the
 * product of two of these peaks in the middle of each block and falls away
 * round the edges, which stamps a lattice of round dots across the map. The
 * plaid a real map shows is rectangular: sharp where the track changes sign,
 * flat in between.
 */
function compartment(i) {
  return Math.tanh(9 * (Math.sin(i / 6) + 0.5 * Math.sin(i / 2.6)))
}

/** Which domain bin `i` is in, or `-1` between them. */
function domainOf(i) {
  return DOMAINS.findIndex(([first, last]) => i >= first && i <= last)
}

/**
 * Deterministic grain in `[0, 1)`, symmetric in its arguments.
 *
 * Symmetric because the matrix is: a contact map with independent noise either
 * side of the diagonal is a picture of two experiments. Deterministic because
 * the generated file is committed and a re-run that changed every byte would
 * make its diff unreadable.
 */
function grain(i, j) {
  const lo = Math.min(i, j)
  const hi = Math.max(i, j)
  let h = Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Contact frequency at `(i, j)` before the letters, in `[0, 1]`. */
function contacts(i, j) {
  const d = Math.abs(i - j)
  // Decay: contacts fall away with separation, so the corners are paper.
  // Steep enough that the fall is the first thing read, because with the
  // diagonal given away it is the only cue left that this is a contact map
  // and not a plaid.
  let v = 0.5 / (1 + (d / 9) ** 1.35)
  const a = domainOf(i)
  const b = domainOf(j)
  // Inside a domain contacts are denser, and denser *near the diagonal* — a
  // domain is a gradient with an edge, not a block of one colour.
  if (a >= 0 && a === b) v += 0.26 / (1 + (d / 9) ** 1.3)
  // Across a boundary they are insulated, though never to nothing: two domains
  // on the same chromosome still see each other.
  else if (a >= 0 && b >= 0) v *= 0.72
  // A and B compartments: the plaid that fills the off-diagonal of a real map,
  // where like meets like oftener than like meets unlike. Without it the far
  // corners are an empty wash and the only thing out there is the loops, which
  // then read as dirt on the lens rather than as peaks.
  v *= 1 + 0.2 * compartment(i) * compartment(j)
  for (const [p, q] of LOOPS) {
    for (const [x, y] of [[p, q], [q, p]]) {
      const e = ((i - x) ** 2 + (j - y) ** 2) / (2 * 2.2 ** 2)
      if (e < 12) v += 0.22 * Math.exp(-e)
    }
  }
  // The diagonal itself is given over to the letters, so the band that would
  // carry it is damped. Damped rather than erased: what is hot near the
  // diagonal here is the writing, but a map with a white stripe down it is a
  // map with a fault in it.
  v *= 1 - 0.55 * Math.exp(-((d / 8) ** 2))
  // Contacts are counted, and counts are read on a log scale — every Hi-C
  // figure ever published is. Linear, the bottom three quarters of the ramp do
  // the work, and that end of it is white through cream through pale yellow:
  // the decay and the plaid are both *there* and neither is visible. The
  // exponent is what puts the structure into the part of the scale that has
  // colours in it.
  return v ** 0.72 * (0.92 + 0.16 * grain(i, j))
}

/** The 100x100 matrix, as one palette index a bin. */
function matrix() {
  const out = new Uint8Array(N * N)
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const base = Math.max(0, Math.min(1, contacts(i, j)))
      let covered = 0
      for (const { shape, at } of LETTERS) {
        const x = j - at
        const y = i - at
        if (x >= 0 && x < LETTER && y >= 0 && y < LETTER) covered = ink(shape, x, y)
      }
      // The letters take the top of the ramp, keeping a little grain so they
      // read as the hottest bins of a map rather than as type laid over one.
      // Partial coverage blends, which is what gives the strokes their edge
      // when the mark is resampled down to 26 pixels on a small tile.
      const hot = 0.97 * (0.93 + 0.07 * grain(i, j))
      const v = base + Math.max(0, covered * (hot - base))
      out[i * N + j] = Math.max(0, Math.min(LEVELS - 1, Math.round(v * (LEVELS - 1))))
    }
  }
  return out
}

// --- the file --------------------------------------------------------------

/** One PNG chunk: length, type, payload, CRC. */
function chunk(type, payload) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])) >>> 0, 0)
  return Buffer.concat([head, payload, crc])
}

/** Paeth's predictor, as the spec defines it. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Filter the scanlines, choosing per row by the spec's own heuristic — the
 * filter whose output has the smallest sum of absolute signed bytes.
 *
 * Worth doing even for an indexed image, where a byte is usually a palette
 * index and the difference between two of them means nothing. Here it means
 * something: the palette is a ramp, so neighbouring indices are neighbouring
 * colours, and a map that shades smoothly filters down to almost nothing.
 */
function filtered(pixels) {
  const rows = []
  const prev = new Uint8Array(N)
  for (let y = 0; y < N; y++) {
    const row = pixels.subarray(y * N, y * N + N)
    let best = null
    for (let type = 0; type < 5; type++) {
      const out = Buffer.alloc(N + 1)
      out[0] = type
      let score = 0
      for (let x = 0; x < N; x++) {
        const left = x > 0 ? row[x - 1] : 0
        const above = prev[x]
        const upperLeft = x > 0 ? prev[x - 1] : 0
        const predictor =
          type === 0 ? 0
          : type === 1 ? left
          : type === 2 ? above
          : type === 3 ? (left + above) >> 1
          : paeth(left, above, upperLeft)
        const byte = (row[x] - predictor) & 0xff
        out[x + 1] = byte
        score += byte < 128 ? byte : 256 - byte
      }
      if (best === null || score < best.score) best = { score, out }
    }
    rows.push(best.out)
    prev.set(row)
  }
  return Buffer.concat(rows)
}

/** The mark as PNG bytes: colour type 3, the ramp as its palette. */
function png(pixels, palette) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(N, 0)
  ihdr.writeUInt32BE(N, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 3 // colour type: indexed
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from(palette)),
    chunk('IDAT', deflateSync(filtered(pixels), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const palette = rampFromStops(DEFAULT_STOPS, LEVELS)
const bytes = png(matrix(), palette)
const uri = `data:image/png;base64,${bytes.toString('base64')}`

const out = `/**
 * The RSG store's tile mark: a Hi-C map ${N} bins square whose diagonal spells
 * *RSG*, as a data URI.
 *
 * Generated — run \`npm run icons:rsg\` after editing
 * \`scripts/make-rsg-mark.mjs\`, which is where the letterforms, the contact
 * field and the reasoning behind both live. Committed so that the mark costs no
 * request and is in every build target, including the standalone one, which
 * emits no \`public/\` to hold a file.
 *
 * The palette is the viewer's own \`default\` ramp, all ${LEVELS} entries of it,
 * and each pixel is the index a bin's contact frequency lands on — the same two
 * things any map in the viewer is drawn from.
 */
export const RSG_MARK_IMAGE =
  '${uri}'
`

writeFileSync(join(root, 'src/ui/stores/rsg-mark.generated.ts'), out)
console.log(
  `src/ui/stores/rsg-mark.generated.ts: ${N}x${N}, ${bytes.length} B PNG, ${uri.length} B data URI`,
)
