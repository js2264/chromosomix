/**
 * What colour each bead is drawn in, and the key that says so (§25).
 *
 * One resolver, for the reason the map's colormap and the lanes' `featureInk`
 * are one function each: the three.js adapter wants an RGB triple per bead in
 * a `Float32Array` for its instance buffer, the vector painter wants a CSS
 * string per bead, and the key in the corner wants the levels or the ramp — and
 * three answers computed three ways would be three chances for the picture to
 * disagree with its own legend. Everything here resolves once into
 * {@link BeadColours}, which carries all three views of the same decision.
 *
 * ## Fitted to the file, never to the window
 *
 * `render/featureInk.ts`'s rule, kept: a ramp over the score column runs over
 * the whole file's range, a category palette is assigned over the whole file's
 * levels, and neither changes when the camera moves or the map zooms. A
 * colouring that meant something different after a rotation would be a legend
 * that lies.
 *
 * ## What is resolved here and what is not
 *
 * The built-ins — sequence, haplotype, position, score — and any field of the
 * file are resolved from the row alone. A colouring by *another* row (a bigWig,
 * a feature set) or by the pin (distance, contacts) needs things this module
 * does not hold, so it is handed a {@link ColourSource} that answers a value
 * per bead and stays a pure function of what it was given.
 */

import { featureColouring, type FeatureKey } from '../render/featureInk'
import { categoryColour } from '../render/meta'
import { colormapCss } from '../render/colormaps'
import type { StructureStyle } from '../annotations/types'
import {
  STRUCTURE_COLOUR_HAPLOTYPE,
  STRUCTURE_COLOUR_POSITION,
  STRUCTURE_COLOUR_SCORE,
  STRUCTURE_COLOUR_SEQUENCE,
} from '../annotations/types'
import type { Structure } from './scene'

/** The ramp a per-bead number is drawn on, where nothing else is said. */
export const STRUCTURE_RAMP = 'viridis'

/**
 * A value per bead from somewhere outside the row: a track sampled over each
 * bead's interval, a feature set's colour where a bead overlaps one, the
 * distance to the pinned bead. `NaN` is *no value* and draws as the ghost
 * colour.
 */
export interface ColourSource {
  /** What the key calls it. */
  label: string
  /** Either a number per bead (drawn on a ramp) or a colour per bead. */
  values?: Float32Array
  colours?: Array<string | null>
  /** The ramp's extent, where `values` are given; fitted to the values otherwise. */
  range?: { min: number; max: number }
  /** The ramp, where `values` are given. */
  colormap?: string
}

/** One resolved colouring: three views of the same decision. */
export interface BeadColours {
  /** `r, g, b` per bead in `0..1`, for an instance buffer. */
  rgb: Float32Array
  /** The same as CSS strings, for a 2D context. */
  css: string[]
  /** What the corner key draws. */
  key: StructureKey
}

/** The legend for a colouring, in the shapes the corner key can draw. */
export type StructureKey =
  | { kind: 'levels'; title: string; levels: Array<{ label: string; colour: string }> }
  | { kind: 'ramp'; title: string; colormap: string; min: number; max: number }
  | { kind: 'none'; title: string }

/** What a bead with nothing to say is drawn in — the grey a `not set` feature takes. */
export const UNSET_COLOUR = '#9a9a9a'

/**
 * Resolve the colouring a style names, over a structure.
 *
 * `source` is consulted only for a `colourBy` this module cannot resolve on
 * its own, and a style naming one with no source handed over falls back to
 * colouring by sequence — a stored session reopened without the track it was
 * coloured by is a model still worth looking at.
 */
export function resolveColours(
  structure: Structure,
  style: StructureStyle,
  source: ColourSource | null = null,
): BeadColours {
  const by = style.colourBy
  if (by === STRUCTURE_COLOUR_SEQUENCE || by === '') return bySequence(structure, style.sequenceColours)
  if (by === STRUCTURE_COLOUR_HAPLOTYPE) return byHaplotype(structure)
  if (by === STRUCTURE_COLOUR_POSITION) return byPosition(structure)
  if (by === STRUCTURE_COLOUR_SCORE) return byField(structure, STRUCTURE_COLOUR_SCORE)
  if (source !== null) return bySource(structure, source)
  if (by.includes(':')) return bySequence(structure, style.sequenceColours)
  return byField(structure, by)
}

/**
 * One hue per contig, from the categorical palette, in contig order.
 *
 * Takes the structure so that a caller cannot pass a contig index of some
 * other set, and so the day one palette per genome is wanted (a `.metacool`'s
 * MAGs) the signature already has what it needs.
 */
export function sequenceColour(
  structure: Structure,
  contig: number,
  /** The reader's own colours by sequence name (§25.5), over the palette's. */
  chosen: Readonly<Record<string, string>> = {},
): string {
  const own = chosen[structure.contigs[contig] ?? '']
  if (own !== undefined) return own
  return categoryColour(contig % Math.max(1, structure.contigs.length))
}

function bySequence(structure: Structure, chosen: Readonly<Record<string, string>> = {}): BeadColours {
  const set = structure.set
  const css = new Array<string>(set.length)
  for (let i = 0; i < set.length; i++) css[i] = sequenceColour(structure, set.contig[i], chosen)
  return {
    rgb: rgbOf(css),
    css,
    key: {
      kind: 'levels',
      title: 'sequence',
      levels: structure.contigs.map((name, at) => ({ label: name, colour: sequenceColour(structure, at, chosen) })),
    },
  }
}

/**
 * The sequence's hue at one lightness per homologue, so a homologue reads as
 * the *same* chromosome and the pair reads as a pair.
 *
 * Two lightnesses rather than two hues: a second hue per chromosome is
 * thirty-two colours on a sixteen-chromosome genome, which no legend can carry.
 */
function byHaplotype(structure: Structure): BeadColours {
  const set = structure.set
  const haps = structure.haplotypes.length
  const css = new Array<string>(set.length)
  for (let i = 0; i < set.length; i++) {
    const base = sequenceColour(structure, set.contig[i])
    css[i] = haps > 1 ? lightness(base, structure.model.hap[i] / Math.max(1, haps - 1)) : base
  }
  return {
    rgb: rgbOf(css),
    css,
    key: {
      kind: 'levels',
      title: 'haplotype',
      levels: structure.haplotypes.map((name, at) => ({
        label: name,
        colour: haps > 1 ? lightness('#666666', at / Math.max(1, haps - 1)) : '#666666',
      })),
    },
  }
}

/** A ramp from each chain's first bead to its last. */
function byPosition(structure: Structure): BeadColours {
  const set = structure.set
  const css = new Array<string>(set.length).fill(UNSET_COLOUR)
  for (const chain of structure.chains) {
    const n = chain.beads.length
    for (let k = 0; k < n; k++) {
      css[chain.beads[k]] = colormapCss(STRUCTURE_RAMP, n > 1 ? k / (n - 1) : 0)
    }
  }
  return {
    rgb: rgbOf(css),
    css,
    key: { kind: 'ramp', title: 'position along the sequence', colormap: STRUCTURE_RAMP, min: 0, max: 1 },
  }
}

/**
 * A field of the file — the score column, a haplotype, anything the g3d's
 * detail carries — through the §8.16 machinery the lanes already use, so the
 * model and the lane of the same row cannot disagree about a colour.
 */
function byField(structure: Structure, key: string): BeadColours {
  const set = structure.set
  const colouring = featureColouring(set, 'structure', key, UNSET_COLOUR)
  const css = new Array<string>(set.length)
  for (let i = 0; i < set.length; i++) {
    css[i] = colouring.colourOf === undefined ? UNSET_COLOUR : colouring.colourOf(i)
  }
  return { rgb: rgbOf(css), css, key: keyOf(colouring.key) }
}

/** A value or a colour per bead from outside the row. */
function bySource(structure: Structure, source: ColourSource): BeadColours {
  const n = structure.set.length
  const css = new Array<string>(n).fill(UNSET_COLOUR)
  if (source.colours !== undefined) {
    for (let i = 0; i < n; i++) css[i] = source.colours[i] ?? UNSET_COLOUR
    return { rgb: rgbOf(css), css, key: { kind: 'none', title: source.label } }
  }
  const values = source.values ?? new Float32Array(n).fill(Number.NaN)
  const colormap = source.colormap ?? STRUCTURE_RAMP
  const range = source.range ?? robustRangeOf(values)
  const span = range.max - range.min
  for (let i = 0; i < n; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) continue
    const t = span > 0 ? (value - range.min) / span : 0.5
    css[i] = colormapCss(colormap, Math.max(0, Math.min(1, t)))
  }
  return {
    rgb: rgbOf(css),
    css,
    key: { kind: 'ramp', title: source.label, colormap, min: range.min, max: range.max },
  }
}

/**
 * The 2nd to the 98th percentile of the finite values, or `[0, 1]` for none.
 *
 * What a colouring with no limits of its own is fitted to: a track sampled
 * over a whole genome has a spike somewhere — the rDNA, a collapsed repeat —
 * and a ramp stretched to it paints every other bead the same dark, which is
 * a picture of one outlier. The lane's own limits, where the reader set them,
 * still win (`ColourSource.range`).
 */
export function robustRangeOf(values: Float32Array): { min: number; max: number } {
  const finite = Array.from(values).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (finite.length === 0) return { min: 0, max: 1 }
  const at = (q: number): number => finite[Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))))]
  const min = at(0.02)
  const max = at(0.98)
  return max > min ? { min, max } : rangeOf(values)
}

/** The finite extent of a value array, or `[0, 1]` for one with none. */
export function rangeOf(values: Float32Array): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  return min <= max ? { min, max } : { min: 0, max: 1 }
}

/** The lanes' key, in the corner's vocabulary. */
function keyOf(key: FeatureKey): StructureKey {
  if (key.ramp !== null) {
    // The lanes draw a numeric field on `viridis` and say so nowhere but in
    // their own code; the key here names the same ramp so the two agree.
    return {
      kind: 'ramp',
      title: key.field.label,
      colormap: STRUCTURE_RAMP,
      min: key.ramp.min,
      max: key.ramp.max,
    }
  }
  if (key.levels.length > 0) {
    return {
      kind: 'levels',
      title: key.field.label,
      levels: key.levels.map((level) => ({ label: level.label, colour: level.colour })),
    }
  }
  return { kind: 'none', title: key.field.label }
}

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

/** CSS strings to an `r, g, b` triple per bead, in `0..1`. */
export function rgbOf(css: readonly string[]): Float32Array {
  const out = new Float32Array(css.length * 3)
  const cache = new Map<string, [number, number, number]>()
  for (let i = 0; i < css.length; i++) {
    let rgb = cache.get(css[i])
    if (rgb === undefined) {
      rgb = parseColour(css[i])
      cache.set(css[i], rgb)
    }
    out[i * 3] = rgb[0]
    out[i * 3 + 1] = rgb[1]
    out[i * 3 + 2] = rgb[2]
  }
  return out
}

/**
 * A CSS colour as `r, g, b` in `0..1`.
 *
 * Hex in its three lengths, `rgb()` and `hsl()` with either separator — which
 * is every colour this app writes: the palettes are hex, the pickers write hex,
 * `render/hue.ts` writes `hsl(h s% l%)` and the colormaps write `rgb(r, g, b)`.
 * Anything else is the unset grey rather than black, so a colour this parser
 * has not been taught is visible as *unknown* rather than as ink.
 */
export function parseColour(text: string): [number, number, number] {
  const value = text.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex !== null) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      return [
        parseInt(digits[0] + digits[0], 16) / 255,
        parseInt(digits[1] + digits[1], 16) / 255,
        parseInt(digits[2] + digits[2], 16) / 255,
      ]
    }
    if (digits.length === 6 || digits.length === 8) {
      return [
        parseInt(digits.slice(0, 2), 16) / 255,
        parseInt(digits.slice(2, 4), 16) / 255,
        parseInt(digits.slice(4, 6), 16) / 255,
      ]
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value)
  if (rgb !== null) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255].map(clamp01) as [
      number,
      number,
      number,
    ]
  }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value)
  if (hsl !== null) {
    return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100)
  }
  return parseColour(UNSET_COLOUR)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [clamp01(r + m), clamp01(g + m), clamp01(b + m)]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
  else if (max === g) h = ((b - r) / d + 2) * 60
  else h = ((r - g) / d + 4) * 60
  return [h, s, l]
}

/**
 * A colour at another lightness: `t = 0` is the colour a little darker, `t = 1`
 * a good deal lighter, so two homologues of one chromosome sit either side of
 * the sequence's own colour.
 */
export function lightness(colour: string, t: number): string {
  const [r, g, b] = parseColour(colour)
  const [h, s, l] = rgbToHsl(r, g, b)
  const dark = Math.max(0.15, l - 0.12)
  const light = Math.min(0.85, l + 0.28)
  const at = dark + (light - dark) * clamp01(t)
  const [rr, gg, bb] = hslToRgb(h, s, at)
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`
}

function hex(value: number): string {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, '0')
}

/** A colour string as a `0xrrggbb` number, for three.js's `Color.setHex`. */
export function hexOf(colour: string): number {
  const [r, g, b] = parseColour(colour)
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)
}
