/**
 * Tracks named on the command line, opened where they lie.
 *
 * The annotations worker holds a bigWig handle per loaded track and answers
 * `sample` from it, and for a long time that was the whole reason three tasks —
 * `metaplot`, `trackcorr` and `frip` — were refused at the shell: the reader for
 * a bigWig is `@gmod/bbi`, the README's second layering rule says it is imported
 * by the annotations worker and by nothing else, and `cli/main.ts` took the rule
 * at its word. So the console recorded those three runs as a sentence with a
 * refusal under it, which for a reader who runs a metaplot over two hundred
 * files is the one line they most wanted to paste.
 *
 * The rule's *reason* is what decides this, and it is stated beside the rule:
 * *no file parser belongs in the main-thread bundle*. This module is not in
 * that bundle. It is reached from `cli/main.ts` alone, which `vite.cli.config.ts`
 * builds into a Node program of its own, where `@gmod/bbi` is already declared
 * external and already a runtime dependency for exactly this reason. Importing
 * it here puts nothing on a main thread, because a shell has none.
 *
 * ## What a track is here
 *
 * Whatever the annotations worker would have made of the same file: a bigWig
 * through `@gmod/bbi`'s own filehandle, a bedGraph or a wig through the same
 * parser and the same `IntervalTrack` the worker samples, and a FASTA as a GC
 * track through the same `gcBins`. The answer is a {@link TrackSampleSet} in the
 * worker's own shape, so the runners cannot tell which venue they are in — which
 * is the property `test/unit/analysis-golden.test.ts` checks the metaplot
 * against pyBigWig for, and the reason this file has no arithmetic of its own.
 *
 * ## The names
 *
 * A track is filed under the **path the reader typed**, because that string is
 * what comes back out of `params.tracks`: there is no entry store here to
 * allocate an `a3` from, which is the absence `cli/main.ts`'s `bindInputs` is a
 * whole paragraph about. A replayed workspace *does* hold an `a3`, so
 * {@link trackFor} falls back the way `readerFor` does for a reference — by base
 * name, then to the only track loaded, there being nothing else it could have
 * meant.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { BigWig } from '@gmod/bbi'
import { LocalFile } from 'generic-filehandle2'

import { decodeAnnotationBytes, decodeAnnotationText } from '../annotations/parse'
import { gcBins, looksLikeFasta, parseFasta, type SequenceStore } from '../annotations/fasta'
import { IntervalTrack, parseBedGraph, parseWig, sniffSignal } from '../annotations/signal'
import type { Region, TrackSampleSet, TrackSamples } from '../annotations/types'
import { bbiMagic } from '../annotations/worker/protocol'
import type { Contig } from '../genome/assembly'
import { contigIndexOf } from '../genome/naming'

/** One loaded track, sampled the way the annotations worker samples it. */
export interface LoadedTrack {
  /** The path as it was typed — the key `params.tracks` holds. */
  readonly path: string
  /** The file's base name, which is what a figure calls it. */
  readonly name: string
  readonly format: 'bigwig' | 'bedgraph' | 'wig' | 'fasta'
  /** The sequences the file itself names, with the lengths it states. */
  readonly contigs: readonly Contig[]
  sample(regions: readonly Region[], basesPerPixel: number): Promise<TrackSampleSet>
}

/**
 * Open every path, by whichever reader its bytes call for.
 *
 * Sniffed rather than judged by extension, exactly as the worker's `load` is:
 * the four bytes of a bigWig's magic, the `>` of a FASTA, and a text file's
 * first data rows for a bedGraph or a wig. A file that is none of those is
 * refused by name, before any map is opened, since a track that cannot be read
 * is a fault in the command line and not in the two hundredth file.
 */
export async function loadTracks(paths: readonly string[]): Promise<Map<string, LoadedTrack>> {
  const held = new Map<string, LoadedTrack>()
  for (const path of paths) {
    if (held.has(path)) continue
    held.set(path, await loadTrack(path))
  }
  return held
}

async function loadTrack(path: string): Promise<LoadedTrack> {
  const name = basename(path)
  const raw = new Uint8Array(await readFile(path))
  if (bbiMagic(raw.subarray(0, 4)) === 'bigwig') return openBigWig(path, name)
  if (bbiMagic(raw.subarray(0, 4)) === 'bigbed') {
    throw new Error(
      `${name} is a bigBed, which is a feature set and not a signal: name it with --features.`,
    )
  }
  const bytes = await decodeAnnotationBytes(raw)
  if (looksLikeFasta(bytes)) return gcTrack(path, name, parseFasta(bytes))
  const text = await decodeAnnotationText(bytes)
  const format = sniffSignal(text)
  if (format === null) {
    throw new Error(
      `${name} is not a track this command can sample: a bigWig, a bedGraph, a wig, or a FASTA ` +
        '(read as GC content) are.',
    )
  }
  const set = format === 'wig' ? parseWig(text) : parseBedGraph(text)
  return signalTrack(path, name, format, new IntervalTrack(set), set)
}

// ---------------------------------------------------------------------------
// bigWig
// ---------------------------------------------------------------------------

async function openBigWig(path: string, name: string): Promise<LoadedTrack> {
  const bigwig = new BigWig({ filehandle: new LocalFile(path) })
  const header = await bigwig.getHeader()
  const contigs: Contig[] = Object.values(header.refsByNumber)
    .sort((a, b) => a.id - b.id)
    .map((ref) => ({ name: ref.name, length: ref.length }))
  const refNames = Object.keys(header.refsByName)
  // The file's own spelling for a name a map spells otherwise (§5.9), remembered
  // once found so a run over ten thousand windows resolves each name once.
  const refOf = new Map<string, string>()
  const resolve = (contig: string): string | undefined => {
    const held = refOf.get(contig)
    if (held !== undefined) return held
    const at = contigIndexOf(refNames, contig)
    if (at < 0) return undefined
    refOf.set(contig, refNames[at])
    return refNames[at]
  }

  return {
    path,
    name,
    format: 'bigwig',
    contigs,
    sample: async (regions, basesPerPixel) => {
      const wanted = regions.filter(
        (region) => resolve(region.contig) !== undefined && region.end > region.start,
      )
      if (wanted.length === 0) return { basesPerPixel, regions: [], extent: null }
      // The worker's own call, with the worker's own choice of zoom level: one
      // request for the whole batch, never below base resolution.
      const packed = await bigwig.getFeaturesAsArraysMulti(
        wanted.map((region) => ({
          refName: resolve(region.contig) ?? region.contig,
          start: Math.max(0, Math.floor(region.start)),
          end: Math.ceil(region.end),
        })),
        { basesPerSpan: Math.max(1, basesPerPixel) },
      )
      const out: TrackSamples[] = []
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (let i = 0; i < wanted.length; i++) {
        const from = packed.regionOffsets[i]
        const to = packed.regionOffsets[i + 1]
        const values = packed.scores.slice(from, to)
        for (const value of values) {
          if (!Number.isFinite(value)) continue
          if (value < min) min = value
          if (value > max) max = value
        }
        out.push({
          contig: wanted[i].contig,
          start: wanted[i].start,
          end: wanted[i].end,
          starts: packed.starts.slice(from, to),
          ends: packed.ends.slice(from, to),
          values,
          min: packed.isSummary ? packed.minScores.slice(from, to) : null,
          max: packed.isSummary ? packed.maxScores.slice(from, to) : null,
          variant: null,
          summary: packed.isSummary,
        })
      }
      return { basesPerPixel, regions: out, extent: min <= max ? { min, max } : null }
    },
  }
}

// ---------------------------------------------------------------------------
// bedGraph and wig
// ---------------------------------------------------------------------------

function signalTrack(
  path: string,
  name: string,
  format: 'bedgraph' | 'wig',
  track: IntervalTrack,
  set: { contigs: ReadonlyArray<{ name: string; ends: Int32Array }> },
): LoadedTrack {
  // A text signal states no lengths, so the furthest coordinate stands in —
  // the same answer the worker's `note(ends, …)` arrives at for one.
  const contigs: Contig[] = set.contigs.map((contig) => ({
    name: contig.name,
    length: contig.ends.length === 0 ? 0 : contig.ends[contig.ends.length - 1],
  }))
  return {
    path,
    name,
    format,
    contigs,
    sample: async (regions, basesPerPixel) => {
      const out: TrackSamples[] = []
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (const region of regions) {
        if (!track.has(region.contig) || region.end <= region.start) continue
        const got = track.samples(region.contig, region.start, region.end, basesPerPixel)
        if (got === null) continue
        for (const value of got.values) {
          if (!Number.isFinite(value)) continue
          if (value < min) min = value
          if (value > max) max = value
        }
        out.push({
          contig: region.contig,
          start: region.start,
          end: region.end,
          variant: null,
          ...got,
        })
      }
      return { basesPerPixel, regions: out, extent: min <= max ? { min, max } : null }
    },
  }
}

// ---------------------------------------------------------------------------
// FASTA, as GC content
// ---------------------------------------------------------------------------

export function gcTrack(path: string, name: string, store: SequenceStore): LoadedTrack {
  const basesOf = (contig: string): Uint8Array | undefined => {
    const direct = store.bases.get(contig)
    if (direct !== undefined) return direct
    const at = contigIndexOf(store.contigs, contig)
    return at < 0 ? undefined : store.bases.get(store.contigs[at].name)
  }
  return {
    path,
    name,
    format: 'fasta',
    contigs: store.contigs,
    sample: async (regions, basesPerPixel) => {
      const out: TrackSamples[] = []
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (const region of regions) {
        const seq = basesOf(region.contig)
        if (seq === undefined || !(region.end > region.start)) continue
        const bins = gcBins(seq, region.start, region.end, basesPerPixel)
        for (const value of bins.values) {
          if (!Number.isFinite(value)) continue
          if (value < min) min = value
          if (value > max) max = value
        }
        out.push({
          contig: region.contig,
          start: region.start,
          end: region.end,
          starts: bins.starts,
          ends: bins.ends,
          values: bins.values,
          min: null,
          max: null,
          variant: null,
          summary: true,
        })
      }
      return { basesPerPixel, regions: out, extent: min <= max ? { min, max } : null }
    },
  }
}

// ---------------------------------------------------------------------------
// Looking one up
// ---------------------------------------------------------------------------

/**
 * A loaded track, by whatever string the `tracks` parameter holds.
 *
 * Three roads, as `cli/main.ts`'s `readerFor` walks them for a reference. Typed
 * on the command line it is a **path**, the key it was filed under. Recorded in
 * a workspace it is an **entry id** the app's store allocated — `a3` — so a
 * replay that loaded one track gets that one, and a replay that loaded several
 * matches by base name where it can. Several tracks and an id that matches none
 * is genuinely ambiguous, and `undefined` is what the runners turn into a
 * sentence rather than a guess.
 */
export function trackFor(
  held: ReadonlyMap<string, LoadedTrack>,
  entry: string,
): LoadedTrack | undefined {
  return (
    held.get(entry) ??
    [...held.values()].find((track) => track.name === basename(entry)) ??
    (held.size === 1 ? [...held.values()][0] : undefined)
  )
}

/**
 * The `sample` a {@link TrackJobContext} is handed, over what was loaded.
 *
 * Throws by name for a track nobody loaded, which is the worker's own answer
 * to a handle it no longer holds — a runner that got an empty set back instead
 * would average over nothing and report a clean line.
 */
export function samplerOver(
  held: ReadonlyMap<string, LoadedTrack>,
): (entry: string, regions: Region[], basesPerPixel: number) => Promise<TrackSampleSet> {
  return (entry, regions, basesPerPixel) => {
    const track = trackFor(held, entry)
    if (track === undefined) {
      throw new Error(
        `${entry} is not a loaded track. Name the file with --tracks (a bigWig, bedGraph, wig or ` +
          'FASTA), or with --track when replaying a workspace.',
      )
    }
    return track.sample(regions, basesPerPixel)
  }
}

/**
 * The lengths every loaded file states, first answer per name.
 *
 * What `inputs.contigLengths` carries in a session with no contact map: the
 * annotations worker has no assembly of its own, so the runner sends what the
 * loaded files declare, and this is the same list read off the same headers.
 */
export function lengthsOf(
  tracks: ReadonlyMap<string, LoadedTrack>,
  sequences: ReadonlyMap<string, SequenceStore>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const track of tracks.values()) {
    for (const contig of track.contigs) {
      if (!(contig.name in out) && contig.length > 0) out[contig.name] = contig.length
    }
  }
  for (const store of sequences.values()) {
    for (const contig of store.contigs) {
      if (!(contig.name in out) && contig.length > 0) out[contig.name] = contig.length
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// One value per bin
// ---------------------------------------------------------------------------

/** The bin grid a vector is read onto: the map's contigs, in bin space. */
export interface VectorGrid {
  contigs: ReadonlyArray<{ name: string; startBin: number; length: number }>
  binsize: number
  nBins: number
}

/**
 * A track as one value per bin of a map, for a task in the other venue.
 *
 * `analysis/workspace.ts`'s `binVector`, step for step: the session asks the
 * annotations worker to sample the track over every sequence at the map's bin
 * size and averages what comes back onto the grid, weighted by covered bases,
 * `NaN` where nothing landed. That is how a FASTA reaches `compartments` as
 * `inputs.vectors.phaseSequence` (§18.6), and a shell that loaded the FASTA and
 * never did this left the phasing silently unphased — the note said the
 * sequence *could not be read*, about a file the command had just parsed.
 */
export async function vectorOver(track: LoadedTrack, grid: VectorGrid): Promise<Float32Array> {
  const regions = grid.contigs
    .filter((contig) => contig.length > 0)
    .map((contig) => ({ contig: contig.name, start: 0, end: contig.length }))
  const samples = await track.sample(regions, grid.binsize)
  const startOf = new Map(grid.contigs.map((contig) => [contig.name, contig.startBin]))
  const out = new Float32Array(grid.nBins).fill(Number.NaN)
  const weight = new Float64Array(grid.nBins)
  const total = new Float64Array(grid.nBins)
  const binsize = grid.binsize
  for (const region of samples.regions) {
    const base = startOf.get(region.contig)
    if (base === undefined) continue
    for (let i = 0; i < region.values.length; i++) {
      const value = region.values[i]
      if (!Number.isFinite(value)) continue
      const from = region.starts[i]
      const to = region.ends[i]
      if (!(to > from)) continue
      const firstBin = Math.floor(from / binsize)
      const lastBin = Math.floor((to - 1) / binsize)
      for (let bin = firstBin; bin <= lastBin; bin++) {
        const absolute = base + bin
        if (absolute < 0 || absolute >= out.length) continue
        const overlap = Math.min(to, (bin + 1) * binsize) - Math.max(from, bin * binsize)
        if (!(overlap > 0)) continue
        total[absolute] += value * overlap
        weight[absolute] += overlap
      }
    }
  }
  for (let bin = 0; bin < out.length; bin++) {
    if (weight[bin] > 0) out[bin] = total[bin] / weight[bin]
  }
  return out
}
