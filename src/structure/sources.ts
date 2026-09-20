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

import type { ManualMark } from '../annotations/manual'
import type { FeatureSet, Limits, PairSet, TrackSampleSet } from '../annotations/types'
import { featureRange } from '../annotations/featureset'
import { LocusAxis, type LocusSegment } from '../render/locus'
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
 * The reader's marks on the model: a line colours the beads at its place, a
 * rectangle the beads of its two spans. Later marks paint over earlier ones.
 */
export function marksSource(structure: Structure, marks: readonly ManualMark[]): ColourSource {
  const n = structure.set.length
  const colours = new Array<string | null>(n).fill(null)
  for (const mark of marks) {
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
  return { label: 'your marks', colours }
}

/** Distance in the model's own units from one bead to every other. */
export function distanceSource(structure: Structure, from: number): ColourSource {
  const n = structure.set.length
  const values = new Float32Array(n).fill(Number.NaN)
  if (from >= 0 && from < n) {
    for (let i = 0; i < n; i++) values[i] = distanceBetween(structure, from, i)
  }
  return { label: from < 0 ? 'distance to the pinned bead — pin one' : 'distance to the pinned bead', values }
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
      values[i] = transformValue(raw, scale.transform)
    }
  }
  const label =
    contacts === null
      ? 'contacts with the pinned bead — pin one on a map’s sequences'
      : 'contacts with the pinned bead'
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
