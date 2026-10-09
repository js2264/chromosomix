/**
 * What a model is coloured **by**, when it is something outside the file
 * (§25.5): a track's values, a feature set's colours, the reader's marks, the
 * distance to a pinned bead, the map's own row through it — and which pairs
 * of beads a loops file joins.
 *
 * Pure, over arrays: each helper takes a structure and what it is read
 * against and answers a `ColourSource` for `resolveColours`, or a list of
 * chords. Reading the store, the sample cache and the map is the cell's
 * business (`panels/StructurePanel.ts`); what the numbers mean once in hand
 * is decided here, where a test can hold them still.
 *
 * Two rules, carried from the modules these reuse: **fit the colouring to the
 * file, not to the window**, so turning the model never changes what a colour
 * means; and **use the lane's own limits** for a track, so a bead coloured by
 * a bigWig agrees with the lane at every value.
 */

import { isShown, type ManualMark } from '../annotations/manual'
import type { FeatureSet, Limits, PairSet, TrackSampleSet } from '../annotations/types'
import { featureRange } from '../annotations/featureset'
import { LocusAxis, type LocusSegment } from '../render/locus'
import { OTHER_NAME, nameLevels, namePalette, type NameOverrides } from '../render/nameColours'
import { transformValue } from '../render/scale'
import type { ColorScale } from '../types'
import { sampleValueAt } from '../ui/AnnotationLanes'
import type { ColourSource } from './colour'
import { beadsAt, beadsIn, distanceBetween, type Structure } from './scene'

/** The most chords a loops file draws: past this a model is a cage. */
export const MAX_CHORDS = 600

/**
 * The model's sequences as one axis at a base pair per unit, laid end to end
 * — what a sample request is made against. Each sequence runs to its last
 * bead, which is as far as the model knows it.
 */
export function structureAxis(structure: Structure): LocusAxis {
  const set = structure.set
  const segments: LocusSegment[] = []
  let at = 0
  for (let c = 0; c < set.contigs.length; c++) {
    let length = 0
    for (let i = set.contigAt[c]; i < set.contigAt[c + 1]; i++) length = Math.max(length, set.end[i])
    if (length <= 0) continue
    segments.push({
      contig: set.contigs[c],
      unitStart: at,
      unitEnd: at + length,
      bpStart: 0,
      bpPerUnit: 1,
      contigLength: length,
    })
    at += length
  }
  return new LocusAxis(segments)
}

/** The middle of a bead, which is where its value is read. */
function midpoint(structure: Structure, bead: number): { contig: string; bp: number } {
  const set = structure.set
  return { contig: set.contigs[set.contig[bead]], bp: (set.start[bead] + set.end[bead]) / 2 }
}

/** Every bead's middle, in order — what the map is asked about. */
export function midpointsOf(structure: Structure): Array<{ contig: string; bp: number }> {
  return Array.from({ length: structure.set.length }, (_, i) => midpoint(structure, i))
}

/**
 * A track's value at each bead, on the lane's limits where they are fixed.
 *
 * Read at the bead's midpoint out of samples requested over the whole model
 * at one bucket per bead, so the number is the covered-base-weighted mean the
 * lane itself draws at that zoom. A bead no sample covers is unset.
 */
export function trackSource(
  structure: Structure,
  samples: TrackSampleSet | null,
  label: string,
  limits: Limits,
): ColourSource {
  const n = structure.set.length
  const values = new Float32Array(n).fill(Number.NaN)
  if (samples !== null) {
    for (let i = 0; i < n; i++) {
      const at = midpoint(structure, i)
      const value = sampleValueAt(samples, at.contig, at.bp)
      if (value !== null) values[i] = value
    }
  }
  return {
    label,
    values,
    ...(limits.auto ? {} : { range: { min: limits.min, max: limits.max } }),
  }
}

/**
 * A feature set's colour on every bead it overlaps.
 *
 * The first feature at a bead decides, in file order, which is what the lane
 * draws on top; a bead with none stays unset. `colourOf` is the feature
 * colouring's own answer per feature index, or `undefined` for one colour.
 */
export function featureSource(
  structure: Structure,
  features: FeatureSet,
  label: string,
  colour: string,
  colourOf?: (index: number) => string,
): ColourSource {
  const n = structure.set.length
  const colours = new Array<string | null>(n).fill(null)
  const set = structure.set
  const byName = new Map<string, number>()
  features.contigs.forEach((name, index) => byName.set(name, index))
  for (let i = 0; i < n; i++) {
    const contig = byName.get(set.contigs[set.contig[i]])
    if (contig === undefined) continue
    const [lo, hi] = featureRange(features, contig, set.start[i], set.end[i])
    if (hi <= lo) continue
    colours[i] = colourOf === undefined ? colour : colourOf(lo)
  }
  return { label, colours }
}

/**
 * Which name of a feature set each bead is under (§25.5): the name that
 * overlaps the bead by the most base pairs, summed per name — a tie goes to
 * the name met first in file order — and `''` for a bead no named feature
 * overlaps.
 *
 * Summed per name rather than per feature because the question is *which
 * compartment is this bead in*, and a compartment called as two touching
 * intervals is still one compartment.
 */
export function beadNames(structure: Structure, features: FeatureSet): string[] {
  const set = structure.set
  const n = set.length
  const out = new Array<string>(n).fill('')
  const byName = new Map<string, number>()
  features.contigs.forEach((name, index) => byName.set(name, index))
  const cover = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const contig = byName.get(set.contigs[set.contig[i]])
    if (contig === undefined) continue
    const lo = set.start[i]
    const hi = Math.max(set.end[i], lo + 1)
    const [from, to] = featureRange(features, contig, lo, hi)
    if (to <= from) continue
    cover.clear()
    let best = ''
    let most = 0
    for (let f = from; f < to; f++) {
      const name = features.name[f] ?? ''
      if (name === '') continue
      // `featureRange` answers every feature that *could* reach the bead; the
      // ones that end before it are not over it.
      const overlap = Math.min(hi, features.end[f]) - Math.max(lo, features.start[f])
      if (overlap <= 0) continue
      const total = (cover.get(name) ?? 0) + overlap
      cover.set(name, total)
      if (total > most) {
        most = total
        best = name
      }
    }
    out[i] = best
  }
  return out
}

/**
 * A feature set's **names** as categories on the model (§25.5): each bead the
 * colour of the name over it ({@link beadNames}), from the one name→colour
 * mapping the set's lane uses (`render/nameColours.ts`), the reader's own
 * colours over the default. The key lists only the names some bead is
 * actually under — a legend naming a colour nothing is drawn in is a legend
 * for a model that is not there — each with its override key, so a swatch
 * picked on it knows what to write.
 */
export function nameSource(
  structure: Structure,
  features: FeatureSet,
  label: string,
  overrides: NameOverrides = {},
): ColourSource {
  const palette = namePalette(nameLevels(features), overrides)
  const own = new Set(palette.levels.map((level) => level.name).filter((name) => name !== OTHER_NAME))
  const names = beadNames(structure, features)
  const colours = new Array<string | null>(names.length).fill(null)
  const used = new Set<string>()
  for (let i = 0; i < names.length; i++) {
    if (names[i] === '') continue
    colours[i] = palette.colourOf(names[i])
    // A name without a colour of its own is in the `other` bucket.
    used.add(own.has(names[i]) ? names[i] : OTHER_NAME)
  }
  const levels = palette.levels.filter((level) => used.has(level.name))
  return { label, colours, levels }
}

/**
 * The reader's marks on the model: a line colours the beads at its place, a
 * rectangle the beads of its two spans. Later marks paint over earlier ones.
 */
export function marksSource(structure: Structure, marks: readonly ManualMark[]): ColourSource {
  const n = structure.set.length
  const colours = new Array<string | null>(n).fill(null)
  for (const mark of marks) {
    // A mark the reader has put away colours nothing, here as on every map
    // (§8.1): its beads are drawn as unmarked until it is shown again.
    if (!isShown(mark)) continue
    if (mark.kind === 'line') {
      for (const bead of beadsAt(structure, mark.at.contig, mark.at.bp)) colours[bead] = mark.colour
    } else if (mark.kind === 'arrowhead') {
      for (const point of [mark.a, mark.b]) {
        for (const bead of beadsAt(structure, point.contig, point.bp)) colours[bead] = mark.colour
      }
    } else {
      for (const span of [mark.a, mark.b]) {
        for (const bead of beadsIn(structure, span.contig, span.from, span.to)) colours[bead] = mark.colour
      }
    }
  }
  return { label: 'manual annotations', colours }
}

/** Distance in the model's own units from one bead to every other. */
export function distanceSource(structure: Structure, from: number): ColourSource {
  const n = structure.set.length
  const values = new Float32Array(n).fill(Number.NaN)
  if (from >= 0 && from < n) {
    for (let i = 0; i < n; i++) values[i] = distanceBetween(structure, from, i)
  }
  return { label: from < 0 ? 'spatial distance to pinned bin — pin one' : 'spatial distance to pinned bin', values }
}

/**
 * The map's row through one bead, on the map's own scale: each value put
 * through the map's transform and clipped to its `vmin`–`vmax`, in its
 * colormap — the virtual 4C, drawn in space, agreeing with the picture cell
 * for cell.
 */
export function contactsSource(
  structure: Structure,
  contacts: Float32Array | null,
  scale: ColorScale | null,
): ColourSource {
  const n = structure.set.length
  const values = new Float32Array(n).fill(Number.NaN)
  if (contacts !== null && scale !== null) {
    for (let i = 0; i < Math.min(n, contacts.length); i++) {
      const raw = contacts[i]
      if (!Number.isFinite(raw)) continue
      // **A zero is the bottom of the scale, not `log10(0) → 0`.** That clamp
      // is numpy's and it is right on a map, whose scale starts at zero; here
      // the scale is the map's *transformed* range, and on a balanced map that
      // runs from about −3.6 to about 0 — so the clamp put every pair the map
      // never counted at the top of the ramp, and a 4C drawn in space came out
      // with its darkest beads exactly where there was no contact at all.
      values[i] = raw > 0 ? transformValue(raw, scale.transform) : scale.vmin
    }
  }
  const label =
    contacts === null
      ? 'contacts with pinned bin — pin one on a map’s sequences'
      : 'contacts with pinned bin'
  return {
    label,
    values,
    ...(scale === null ? {} : { range: { min: scale.vmin, max: scale.vmax }, colormap: scale.colormap }),
  }
}

/**
 * A loops file as chords: for each pair, the bead at each anchor's middle,
 * where both anchors land on the model and are not one bead. Where a window
 * is given, pairs with neither end in it are left out — the reader is looking
 * somewhere, and the loops that matter are the ones that touch it. Capped,
 * in file order.
 */
export function loopChords(
  structure: Structure,
  pairs: PairSet,
  lit: Uint8Array | null,
  cap = MAX_CHORDS,
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  for (let i = 0; i < pairs.length && out.length < cap; i++) {
    const a = beadsAt(structure, pairs.contigs[pairs.contig1[i]], (pairs.start1[i] + pairs.end1[i]) / 2)[0]
    const b = beadsAt(structure, pairs.contigs[pairs.contig2[i]], (pairs.start2[i] + pairs.end2[i]) / 2)[0]
    if (a === undefined || b === undefined || a === b) continue
    if (lit !== null && lit[a] === 0 && lit[b] === 0) continue
    out.push([a, b])
  }
  return out
}
