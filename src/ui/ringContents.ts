/**
 * What a ring of the circle, or a lane of the two lines, draws (§7.6): each
 * track the map draws, its numbers reduced into the picture's bins — a signal's
 * mean, a column of the file's genomes or contigs, a set of features at their
 * own coordinates — with its limits and its look resolved, and an overlay
 * group's tracks in one ring as they are in one lane.
 *
 * Shared by `ui/CircleView.ts` and `ui/LinesView.ts`, which differ in where
 * they draw a bin and not in what one holds: both bin along the sections'
 * sequences laid end to end (`render/circleRings.ts`), the circle by angle and
 * the lines by x.
 */

import { planStack, resolveGroupExtents, extentFor, OVERLAY_DIM, type GroupSettings } from '../annotations/groups'
import { colormapOf, type AnnotationEntry, type AnnotationKind } from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import type { MapId } from '../annotations/placement'
import type { MetaBlock } from '../annotations/metadata'
import type { SampleCache } from '../annotations/samples'
import { LocusAxis, type LocusSegment } from '../render/locus'
import { resolveLimits } from '../render/tracks'
import type { CircleGeometry, CircleModel } from '../render/circle'
import {
  binCells,
  binSamples,
  featureArcs,
  type BinnedClasses,
  type BinnedValues,
  type CircleBins,
  type RingContent,
  type RingPaint,
  type SequenceIndex,
} from '../render/circleRings'
import type { MetaSource } from './AnnotationLanes'

/** The kinds a ring can be drawn from, by what is drawn. */
export const SIGNAL_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>(['track', 'sequence', 'alignments'])
export const META_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>(['metadata', 'classes'])
export const FEATURE_KINDS: ReadonlySet<AnnotationKind> = new Set<AnnotationKind>([
  'segments',
  'gtf',
  'variants',
  'ideogram',
  'barchart',
])

/** Whether a row can be a ring, or a lane of the two lines, at all. */
export function drawsAsRing(entry: AnnotationEntry): boolean {
  return SIGNAL_KINDS.has(entry.kind) || META_KINDS.has(entry.kind) || FEATURE_KINDS.has(entry.kind)
}

/**
 * One ring's tracks, as one lane's: a track, or an overlay group's tracks
 * drawn into the band of the first of them (`planStack`, the lanes' own plan).
 */
export interface RingSlot {
  host: AnnotationEntry
  overlaid: AnnotationEntry[]
}

/** A ring as drawn: its slot's tracks, each with its numbers and its look resolved. */
export interface RingDrawn {
  /** The first track's id, which the ring is held and moved by. */
  id: string
  /** What is written beside it: the track's name, or an overlay group's. */
  label: string
  /** Each track, with the bins its numbers are in. */
  members: Array<RingPaint & { bins: CircleBins }>
}

/** A binned ring, kept until its inputs change. */
export interface HeldRing {
  key: unknown
  content: RingContent
}

/** The rings in the Tracks card's order: every row the map draws that can be one, an overlay group's sharing a ring. */
export function ringSlotsOf(store: AnnotationStore, map: MapId, groups: GroupSettings | undefined): RingSlot[] {
  const rows = store.drawnAnywhereOn(map).filter(drawsAsRing)
  return planStack(rows, {
    groupOf: (entry) => entry.style.group,
    modeOf: (group) => groups?.modeOf(group) ?? 'stacked',
    sizeOf: (entry) => entry.style.size,
    gap: 0,
    minimum: 1,
  }).map((slot) => ({ host: slot.host, overlaid: slot.overlaid }))
}

/**
 * What a ring is called: its track's name, or an overlay group's, as the reader
 * named it — the tooltip names each of its tracks beside its value.
 */
export function ringLabel(slot: RingSlot): string {
  return slot.overlaid.length > 0 && slot.host.style.group !== '' ? slot.host.style.group : slot.host.label
}

/**
 * The rings drawn: each slot's tracks with their numbers — whatever `member`
 * gives for each — and their axes resolved, a group's over every ring that
 * holds one of its tracks, as a group's lanes share one beside the map
 * (`resolveGroupExtents`), unless the group is set to scale each on its own.
 */
export function drawRings(
  slots: readonly RingSlot[],
  groups: GroupSettings | undefined,
  member: (entry: AnnotationEntry) => { content: RingContent; bins: CircleBins },
): RingDrawn[] {
  const built = slots.map((slot) => ({
    slot,
    members: [slot.host, ...slot.overlaid].map((entry) => ({ entry, ...member(entry) })),
  }))
  const extents = resolveGroupExtents(
    built.flatMap(({ members }) => members).map(({ entry, content }) => ({
      group: entry.style.group,
      extent: content.kind === 'values' ? content.values.extent : null,
    })),
    (group) => groups?.scalingOf(group) ?? 'shared',
  )
  return built.map(({ slot, members }) => ({
    id: slot.host.id,
    label: ringLabel(slot),
    members: members.map(({ entry, content, bins }) => ({
      id: entry.id,
      label: entry.label,
      colour: entry.style.colour,
      bins,
      // Overlaid tracks are translucent by necessity, as in their lane: two
      // opaque areas in one band hide each other.
      opacity: members.length > 1 ? entry.style.opacity * OVERLAY_DIM : entry.style.opacity,
      content:
        content.kind === 'values'
          ? valuesContent(entry, content.values, undefined, extentFor(entry, content.values.extent, extents))
          : content,
    })),
  }))
}

/** A row's numbers with its limits and look resolved, against its own extent or its group's. */
export function valuesContent(
  entry: AnnotationEntry,
  values: BinnedValues,
  note?: string,
  extent: BinnedValues['extent'] = values.extent,
): RingContent {
  const limits = resolveLimits(entry.style.limits, extent)
  if (values.extent === null && note !== undefined && note !== '') return { kind: 'empty', note }
  return {
    kind: 'values',
    values,
    limits,
    mode: entry.style.mode,
    colormap: colormapOf(entry.style, limits),
    flip: entry.style.flip === true,
  }
}

/** What a ring's numbers are read from and binned into. */
export interface RingSource {
  model: CircleModel
  bins: CircleBins
  index: SequenceIndex
  axis: LocusAxis | null
  /** Where each section is, for a feature's own coordinates — the fitted circle's angles, or the lines' x. */
  geometry: Pick<CircleGeometry, 'arcs'>
  samples: SampleCache | null
  metadata: MetaSource | undefined
  /** What was binned before, by track, kept until its inputs change. */
  held: Map<string, HeldRing>
  /** The sample cache's scope for the whole picture's read: the circle's and the lines' kept apart. */
  scope: string
}

/**
 * A track's numbers in the picture's bins: a signal read for the sections'
 * sequences end to end, a column of the file put on them, a feature at its own
 * coordinates — or, while a read is on its way, nothing, and why.
 */
export function ringContentOf(entry: AnnotationEntry, source: RingSource): RingContent {
  const { model, bins, index, held } = source
  if (model.units.every((unit) => unit.sequences.length === 0)) {
    return { kind: 'empty', note: 'The contigs of these genomes are still being read.' }
  }
  if (SIGNAL_KINDS.has(entry.kind)) {
    const axis = source.axis
    if (axis === null || source.samples === null) return { kind: 'empty', note: '' }
    const samples = source.samples.samplesFor({
      entry: entry.id,
      scope: source.scope,
      axis,
      domain: [0, axis.unitEnd],
      pixels: bins.count,
      ...(entry.derivedFrom === undefined ? {} : { derived: entry.derivedFrom }),
      ...(entry.style.reads === undefined ? {} : { reads: entry.style.reads }),
    })
    if (samples === null) return { kind: 'empty', note: 'reading…' }
    const kept = held.get(entry.id)
    const values =
      kept !== undefined && kept.key === samples && kept.content.kind === 'values'
        ? kept.content.values
        : binSamples(samples, bins, index)
    const content = valuesContent(entry, values, samples.note)
    held.set(entry.id, { key: samples, content })
    return content
  }
  if (META_KINDS.has(entry.kind)) {
    const metadata = source.metadata
    if (metadata === undefined) return { kind: 'empty', note: '' }
    const key = `${metadata.revision()}`
    const kept = held.get(entry.id)
    if (kept !== undefined && kept.key === key && kept.content.kind !== 'empty') {
      return kept.content.kind === 'values' ? valuesContent(entry, kept.content.values) : kept.content
    }
    const cells = metadata.cellsFor(entry, sequenceBlock(model))
    if (cells === null) {
      return {
        kind: 'empty',
        note:
          entry.source.kind === 'metadata' && entry.source.table === 'bins'
            ? 'A column of /bins is drawn beside a map, where a cell is a bin.'
            : 'reading…',
      }
    }
    const binned = binCells(cells, model, bins)
    const content: RingContent =
      binned.kind === 'qualitative'
        ? { kind: 'classes', classes: binned as BinnedClasses }
        : valuesContent(entry, binned as BinnedValues)
    held.set(entry.id, { key, content })
    return content
  }
  if (FEATURE_KINDS.has(entry.kind) && entry.payload?.kind === 'features') {
    const set = entry.payload.data
    const kept = held.get(entry.id)
    const key = { set, geometry: source.geometry }
    if (kept !== undefined && sameKey(kept.key, key)) return kept.content
    const content: RingContent = { kind: 'features', arcs: featureArcs(set, model, source.geometry, index) }
    held.set(entry.id, { key, content })
    return content
  }
  return { kind: 'empty', note: '' }
}

function sameKey(a: unknown, b: { set: unknown; geometry: unknown }): boolean {
  return (
    typeof a === 'object' &&
    a !== null &&
    (a as { set?: unknown }).set === b.set &&
    (a as { geometry?: unknown }).geometry === b.geometry
  )
}

/**
 * The sections' sequences as one axis, end to end, a base pair a unit — what
 * the sample cache asks the worker for, one region a sequence.
 */
export function circleAxis(model: CircleModel): LocusAxis {
  const segments: LocusSegment[] = []
  let at = 0
  for (const unit of model.units) {
    for (const sequence of unit.sequences) {
      const length = Math.max(0, sequence.length)
      if (length === 0) continue
      segments.push({
        contig: sequence.name,
        unitStart: at,
        unitEnd: at + length,
        bpStart: 0,
        bpPerUnit: 1,
        contigLength: length,
      })
      at += length
    }
  }
  return new LocusAxis(segments)
}

/**
 * The sections' sequences as a contig-level block, one cell a sequence — the
 * shape the metadata index resolves a `/genomes` or `/contigs` column onto, a
 * genome's value broadcast to each of its contigs (§8.12).
 */
export function sequenceBlock(model: CircleModel): MetaBlock {
  const runs: Array<{ label: string; start: number; end: number }> = []
  for (const unit of model.units) {
    for (const sequence of unit.sequences) {
      runs.push({ label: sequence.name, start: runs.length, end: runs.length + 1 })
    }
  }
  return { level: 'contig', runs, cells: runs.length, blockStart: 0, binsPerCell: 1 }
}
