/**
 * What a segment is drawn in, once the reader has said what it is *about*.
 *
 * Every lane that draws intervals — a BED, a peak set, a gene model, a VCF —
 * takes its ink from one field of the file, and this is the only place that
 * decides which colour that field's values earn. `annotations/fields.ts` says
 * what the file holds; this says what it looks like.
 *
 * ## Three rules, each with a reason it is not the other two
 *
 * **Strand is the lane's own colour, turned.** Forward keeps the colour on the
 * row's chip exactly, reverse is the same hue rotated most of the way round,
 * and a feature whose file carries no strand takes the neutral this application
 * already uses for *no single answer* (`render/sequence.ts`'s fifth base
 * colour, which the variant lane borrows for the same claim in §8.14). That is
 * three colours, which is what strand has to say, and it keeps two peak files
 * on one screen telling themselves apart by the colour their reader gave them —
 * which a fixed blue-and-red pair, however conventional, throws away.
 *
 * **A category is the categories' own palette.** §8.12 settled this for
 * metadata strips and the argument is the same here: one swatch cannot describe
 * six biotypes, so `CATEGORY_PALETTE` — Okabe–Ito, colour-vision-safe, the same
 * twelve a metadata lane uses — is handed out commonest-first, and the lane's
 * label chip becomes the first category's colour so that the name on the row is
 * still a colour that is in the picture.
 *
 * **A number is a ramp**, in the colormap a heatmap lane defaults to, for the
 * reason that one does: `viridis` is this repository's colour-vision-safe
 * sequential map, and a score has an order that a categorical palette would
 * throw away.
 *
 * ## What is deliberately not here
 *
 * A colouring that changes with the window. Every one of these is fitted to the
 * **file**, not to what is on screen, which is the opposite of what a track's
 * autoscale does — and deliberately: a track's axis is redrawn with its numbers
 * beside it, so a reader can see it move, while a colour that meant
 * `protein_coding` before a pan and `lncRNA` after it is a legend that lies
 * without saying so.
 */

import {
  ABSENT_LEVEL,
  OTHER_LEVEL,
  featureFields,
  fieldFor,
  fieldLevels,
  fieldNumber,
  fieldRange,
  fieldText,
  strandBands,
  type FeatureField,
} from '../annotations/fields'
import {
  DEFAULT_HEATMAP_LANE_COLORMAP,
  type AnnotationKind,
  type FeatureSet,
} from '../annotations/types'
import { stainOf } from '../annotations/cytoband'
import { barColours } from './barchart'
import { STAIN_ORDER, stainColour, stainLabel } from './ideogram'
import { colormapCss } from './colormaps'
import { rotateHue } from './hue'
import { categoryColour } from './meta'
import { BASE_COLOURS } from './sequence'
import { variantInk } from './variants'

/**
 * How far the reverse strand is turned from the forward one.
 *
 * Most of the way round rather than a neighbouring hue: the two strands are the
 * one distinction on this lane a reader resolves from the corner of their eye,
 * at glyph sizes of a few pixels, and 150° is where a blue lane's reverse comes
 * out a warm red and a green lane's comes out a violet — two colours nobody
 * reads as a shade of one.
 */
export const STRAND_TURN = 150

/**
 * The ink for a feature whose file does not answer.
 *
 * `BASE_COLOURS`' fifth slot: the grey the sequence lane writes an `N` in, the
 * grey `render/variants.ts` gives a record with no single base behind it, and
 * now the grey an unstranded feature and a row with no value for the chosen
 * column take. One neutral for one claim, which is what stops a reader learning
 * three different greys.
 */
export const NO_ANSWER = BASE_COLOURS[4]

/** One row of the key under the picker. */
export interface KeyLevel {
  label: string
  colour: string
}

/** What the settings card draws under the picker, and the lane label reads. */
export interface FeatureKey {
  field: FeatureField
  /** A chip per value — a strand, a category. Empty for a ramp and for one colour. */
  levels: KeyLevel[]
  /** The ends of a numeric ramp, or `null` where the field is not one. */
  ramp: { min: number; max: number } | null
}

/** A colouring, ready to hand to `render/features.ts`. */
export interface FeatureColouring {
  /**
   * The ink for one feature, or `undefined` for the whole lane in one colour.
   *
   * `undefined` rather than a function returning a constant, because that is
   * what puts a ten-thousand-box lane back on the single-path fast case
   * `drawSegments` keeps for it.
   */
  /**
   * A feature's colour, by its index — and whether it is placed on a reversed
   * piece of an edited sequence (§27.2), where a colour that says *strand* says
   * the strand it has there.
   */
  colourOf: ((index: number, reversed?: boolean) => string) | undefined
  key: FeatureKey
  /**
   * The colour the lane's **name** should be chipped in.
   *
   * The lane's own wherever that colour is in the picture, and the first
   * category's where it is not — §8.12's rule, for §8.12's reason: a green chip
   * over a lane of blue and orange is a legend for a track that is not there.
   */
  chip: string
}

/**
 * Resolve one lane's colouring, from the field its style names.
 *
 * A key the file no longer has — a stored session reopened against another
 * build of the same annotation, or against a different file under the same name
 * — falls back to the lane's own colour rather than colouring every feature
 * `not set`, which would look like a broken file rather than a missing column.
 */
export function featureColouring(
  set: FeatureSet | undefined,
  kind: AnnotationKind,
  colourBy: string,
  colour: string,
): FeatureColouring {
  const fields = featureFields(set, kind)
  const field = fieldFor(fields, colourBy) ?? fields[0]
  const plain: FeatureColouring = {
    colourOf: undefined,
    key: { field, levels: [], ramp: null },
    chip: colour,
  }
  // A karyotype's ink is its stains' and is not a choice (§8.22), whatever the
  // picker would have said — which is why the card offers none and shows only
  // this key. Asked before `one colour`, because no field of the file is what
  // this lane is coloured by.
  if (kind === 'ideogram' && set !== undefined) return stainColouring(set, field, colour)
  if (field.kind === 'lane' || set === undefined) return plain

  // A barChart's ink is not a choice (§8.17). Its glyph is one bar per
  // category and every bar is its category's colour, so there is no column to
  // pick and nothing a picker could change — which is why the card offers none
  // and shows only this key. `colourOf` stays `undefined` because the renderer
  // never consults it: `drawBarCharts` reads the categories directly, and a
  // function here would be a second, disagreeing answer to the same question.
  if (kind === 'barchart' && set.bars !== undefined) {
    const colours = barColours(set.bars)
    return {
      colourOf: undefined,
      key: { field, levels: barLevels(set.bars.labels, colours), ramp: null },
      // §8.12's rule again: the name on the row is chipped in a colour that is
      // in the picture, and on this lane the lane's own colour never is.
      chip: colours[0] ?? colour,
    }
  }

  if (field.kind === 'strand') {
    const bands = strandBands(set)
    // A file with no strand in it at all — a peak set, a call set, most BEDs.
    // *Every* feature would take the neutral, which costs the reader the colour
    // they chose to tell this lane from the three beside it and says nothing in
    // exchange: a grey that means "no strand" only means something where some
    // neighbour has one. One colour, the lane's own, is the honest picture of a
    // file with nothing to distinguish.
    if (bands.length === 1 && bands[0] === 0) return plain
    const colours = strandPalette(colour)
    const named: Record<number, string> = { 0: 'unstranded', 1: 'forward', [-1]: 'reverse' }
    return {
      colourOf: (index, reversed) => {
        const strand = reversed === true ? -set.strand[index] : set.strand[index]
        return colours[strand > 0 ? 0 : strand < 0 ? 1 : 2]
      },
      key: {
        field,
        // In band order, which is the order they are drawn down the lane — so
        // the key can be read against the picture rather than matched to it.
        // Only the bands this file has: naming a colour nothing is drawn in is
        // a legend for a track that is not there.
        levels: bands.map((band) => ({
          label: named[band],
          colour: colours[band > 0 ? 0 : band < 0 ? 1 : 2],
        })),
        ramp: null,
      },
      chip: colours[0],
    }
  }

  if (field.kind === 'base') {
    // §8.14's rule, unchanged and still the only reader of it: the lane's own
    // colour is what the *density* rung is drawn in, so it stays the chip.
    return {
      colourOf: (index) => variantInk(set.detail[index] ?? '', colour),
      key: {
        field,
        levels: 'ACGT'
          .split('')
          .map((base, i) => ({ label: base, colour: BASE_COLOURS[i] }))
          .concat([{ label: 'no single base', colour: NO_ANSWER }]),
        ramp: null,
      },
      chip: colour,
    }
  }

  if (field.kind === 'number') {
    const { min, max } = fieldRange(set, field.key)
    const span = max - min
    return {
      colourOf: (index) => {
        const value = fieldNumber(set, index, field.key)
        if (!Number.isFinite(value)) return NO_ANSWER
        // A column with one value in it is every feature at the top of the
        // ramp, which says "all the same" — dividing by the zero span would
        // say `NaN`, and `colormapCss` would draw whatever that clamps to.
        const t = span > 0 ? (value - min) / span : 1
        return colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, Math.max(0, Math.min(1, t)))
      },
      key: { field, levels: [], ramp: { min, max } },
      chip: colour,
    }
  }

  const levels = fieldLevels(set, field.key)
  if (levels.length === 0) return plain
  const codes = new Map(levels.map((level, i) => [level, i]))
  const otherAt = codes.get(OTHER_LEVEL)
  return {
    colourOf: (index) => {
      const value = fieldText(set, index, field.key)
      if (value === '') return NO_ANSWER
      const code = codes.get(value)
      if (code !== undefined) return categoryColour(code)
      return otherAt === undefined ? NO_ANSWER : categoryColour(otherAt)
    },
    key: {
      field,
      levels: [
        ...levels.map((label, i) => ({ label, colour: categoryColour(i) })),
        { label: ABSENT_LEVEL, colour: NO_ANSWER },
      ],
      ramp: null,
    },
    chip: categoryColour(0),
  }
}

/**
 * How many categories a barChart's key names before it stops.
 *
 * Far above {@link MAX_LEVELS}, and deliberately: that cap exists because
 * `CATEGORY_PALETTE` runs out of colours, and these categories carry their own
 * — the file's, or a ramp across their positions — so there is no thirteenth
 * colour nobody can name to protect the reader from. What is left is the length
 * of the list itself, and a GTEx track's fifty-four tissues is a legend a
 * scrolling card can hold where a lane sixteen pixels tall cannot.
 *
 * Bounded at all because a file may declare any number, and a key with four
 * thousand chips in it is not a key — it is the card, gone.
 */
const MAX_BAR_LEVELS = 64

/** A barChart's categories as key chips, with a count where there are too many. */
function barLevels(labels: readonly string[], colours: readonly string[]): KeyLevel[] {
  const shown = labels.slice(0, MAX_BAR_LEVELS).map((label, at) => ({
    label,
    colour: colours[at],
  }))
  if (labels.length > MAX_BAR_LEVELS) {
    // Named as a count rather than given a chip: there is no one colour these
    // share, and a swatch beside them would be claiming there is.
    shown.push({ label: `+ ${labels.length - MAX_BAR_LEVELS} more`, colour: 'transparent' })
  }
  return shown
}

/**
 * A karyotype's colours: each band its stain's, from the function the
 * ideogram is drawn with, and a key naming the stains this file has in the
 * order UCSC's own legend gives them — so the card reads as the lane does.
 *
 * The name on the row is chipped in the centromere's red where the file has
 * one, the one colour every ideogram shares, and in the darkest stain's where
 * it has not: §8.12's rule, a chip in a colour that is in the picture.
 */
function stainColouring(set: FeatureSet, field: FeatureField, colour: string): FeatureColouring {
  const present = new Set<string>()
  const stains: string[] = new Array(set.length)
  for (let i = 0; i < set.length; i++) {
    const stain = stainOf(set.detail[i])
    stains[i] = stain
    present.add(stain)
  }
  const ordered = [
    ...STAIN_ORDER.filter((stain) => present.has(stain)),
    ...[...present].filter((stain) => stain !== '' && !STAIN_ORDER.includes(stain)).sort(),
  ]
  const levels = ordered.map((stain) => ({ label: stainLabel(stain), colour: stainColour(stain) }))
  // `STAIN_ORDER` runs the `gpos` stains light to dark, so the last of them
  // present is the darkest; a file of nothing but `gneg` — an unbanded
  // cytoBandIdeo — keeps the lane's own colour, since a chip in the unstained
  // one would be white on white.
  const stained = ordered.filter((stain) => stain.startsWith('gpos'))
  const chip = present.has('acen')
    ? stainColour('acen')
    : stained.length > 0
      ? stainColour(stained[stained.length - 1])
      : colour
  return {
    colourOf: (index) => stainColour(stains[index] ?? ''),
    key: { field, levels, ramp: null },
    chip,
  }
}

/** Forward, reverse, and the file that does not say. See {@link STRAND_TURN}. */
export function strandPalette(colour: string): [string, string, string] {
  return [colour, rotateHue(colour, STRAND_TURN), NO_ANSWER]
}

/**
 * The ramp as CSS, for the strip the settings card draws under the picker.
 *
 * Eleven stops rather than two: `viridis` is not a straight line through colour
 * space, and a two-stop gradient between its ends is a different picture from
 * the one the lane is drawn with.
 */
export function rampStops(steps = 11): string[] {
  return Array.from({ length: steps }, (_, i) =>
    colormapCss(DEFAULT_HEATMAP_LANE_COLORMAP, i / (steps - 1)),
  )
}
