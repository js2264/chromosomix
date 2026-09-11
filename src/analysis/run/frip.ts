/**
 * Fraction of signal in features, run.
 *
 * Two area integrals per track and a division. What the module is mostly made of
 * is the three ways that division goes wrong, each guarded once:
 *
 * - **A set that overlaps itself** — a GTF with one row per transcript is the
 *   usual case — would have its shared bases counted once per row, so the
 *   numerator can exceed the denominator and a FRiP comes out above 1. The
 *   features are merged into runs first, exactly as `analysis/overlap.ts` merges
 *   them, and the per-feature table is scored separately from the *unmerged*
 *   intervals because that is what the reader loaded.
 * - **A sample that hangs off the end of its region.** The worker answers with
 *   the zoom bins that *overlap* the request, so the first and last of them
 *   reach outside it. Every span is clipped to the region before it is weighted,
 *   or a 300 bp peak read at 100 bp resolution collects up to 200 bp of its
 *   neighbours' signal.
 * - **A track and an assembly that do not share names.** Answered by
 *   `TrackJobContext.lengthOf`, which resolves §5.9's renaming, and reported as
 *   a note rather than as a zero.
 */

import type { FeatureSet, Region } from '../../annotations/types'
import {
  chosenInput,
  listParam,
  missingInput,
  numParam,
  boolParam,
  type TrackJobContext,
  type TrackTaskRunner,
} from '../job'
import { nanMedian } from '../stats'
import { FEATURE_SAMPLES, GENOME_SAMPLE_TARGET } from '../tasks/frip'
import type { TableOutput, TaskOutput } from '../types'

/** How much area a track carries over a set of regions, and over how many bases. */
interface Area {
  /** `Σ value × width`, over the covered part of the regions. */
  signal: number
  /** Bases the regions span, whether the track covered them or not. */
  span: number
  /** Bases the track actually had a value for. */
  covered: number
}

export const runFrip: TrackTaskRunner = async (job) => {
  const entries = listParam(job.params, 'tracks')
  if (entries.length === 0) {
    job.note('No track was chosen. Load a bigWig and tick it under Tracks.')
    return []
  }
  const found = chosenInput(job.inputs.features, job.params, 'features')
  const set = found.value
  if (set === undefined) {
    job.note(
      missingInput(found, {
        unchosen: 'A FRiP needs the features to measure inside, and none was chosen.',
        gone: 'The feature set chosen is no longer loaded. Re-open the file, or pick another.',
      }) ?? '',
    )
    return []
  }

  // Merged, so a set that overlaps itself cannot count a base twice. This is the
  // denominator's other half as well: *how much of the assembly the set covers*
  // is a question about bases, and an unmerged GTF answers it with a number
  // above the genome size.
  const runs: Region[] = []
  let mergedBases = 0
  for (let cid = 0; cid < set.contigs.length; cid++) {
    const contig = set.contigs[cid]
    let openFrom = Number.NaN
    let openTo = Number.NaN
    const close = (): void => {
      if (Number.isNaN(openFrom)) return
      runs.push({ contig, start: openFrom, end: openTo })
      mergedBases += openTo - openFrom
    }
    for (let i = set.contigAt[cid]; i < set.contigAt[cid + 1]; i++) {
      const start = set.start[i]
      const end = set.end[i]
      if (end <= start) continue
      if (Number.isNaN(openFrom)) {
        openFrom = start
        openTo = end
      } else if (start <= openTo) {
        openTo = Math.max(openTo, end)
      } else {
        close()
        openFrom = start
        openTo = end
      }
    }
    close()
  }
  if (runs.length === 0) {
    job.note('The feature set covers no bases, so there is nothing to measure inside.')
    return []
  }

  const lengths = job.inputs.contigLengths ?? {}
  let assemblyBases = 0
  for (const length of Object.values(lengths)) assemblyBases += length
  if (assemblyBases <= 0) {
    job.note(
      'This session knows no sequence lengths, so the fraction of the assembly the set covers ' +
        'cannot be worked out and the enrichment column is left empty. Load a chrom.sizes, or ' +
        'the map itself.',
    )
  }

  // The features' own scale decides how finely they are read: a set of 300 bp
  // peaks read at 10 kb is a set of 10 kb windows wearing the peaks' names.
  const widths = new Float64Array(runs.length)
  for (let i = 0; i < runs.length; i++) widths[i] = runs[i].end - runs[i].start
  const typical = nanMedian(widths)
  const asked = Math.max(0, Math.round(numParam(job.params, 'resolution', 0)))
  const featureStep =
    asked > 0 ? asked : Math.max(1, Math.round(typical / FEATURE_SAMPLES))
  const genomeStep =
    assemblyBases > 0 ? Math.max(1, Math.round(assemblyBases / GENOME_SAMPLE_TARGET)) : featureStep

  const wholeContigs: Region[] = []
  for (const [contig, length] of Object.entries(lengths)) {
    if (length > 0) wholeContigs.push({ contig, start: 0, end: length })
  }

  const nameOf = (id: string): string => job.inputs.labels?.[id] ?? id
  const rows: Array<Record<string, string | number>> = []
  const perFeature: Array<Record<string, string | number>> = []
  const wantPerFeature = boolParam(job.params, 'perFeature', false)

  for (let i = 0; i < entries.length; i++) {
    job.throwIfCancelled()
    const entry = entries[i]
    const name = nameOf(entry)
    job.progress(i, entries.length, `${name} · features`)
    const inside = await areaOver(job, entry, runs, featureStep)
    job.throwIfCancelled()
    job.progress(i + 0.5, entries.length, `${name} · assembly`)
    const total =
      wholeContigs.length > 0
        ? await areaOver(job, entry, wholeContigs, genomeStep)
        : { signal: Number.NaN, span: Number.NaN, covered: Number.NaN }

    const frip = total.signal > 0 ? inside.signal / total.signal : Number.NaN
    const coveredFraction = assemblyBases > 0 ? mergedBases / assemblyBases : Number.NaN
    rows.push({
      track: name,
      frip,
      covered: coveredFraction,
      // The column to read. A FRiP of 0.3 over a set covering 30 % of the
      // assembly is a track with no preference whatever; the same FRiP over
      // 0.5 % is a sixtyfold enrichment, and nothing but this ratio tells the
      // two apart.
      enrichment: coveredFraction > 0 ? frip / coveredFraction : Number.NaN,
      signal: inside.signal,
      totalSignal: total.signal,
      // Of the set's bases, how many the track had any value for at all. A low
      // number here means the FRiP above is a statement about a small part of
      // the set rather than about the set.
      inFeature: inside.span > 0 ? inside.covered / inside.span : Number.NaN,
    })

    if (wantPerFeature) {
      const scored = await scoreFeatures(job, entry, set, featureStep)
      job.throwIfCancelled()
      for (const row of scored) {
        perFeature.push({
          track: name,
          ...row,
          share: total.signal > 0 ? Number(row.signal) / total.signal : Number.NaN,
        })
      }
    }
  }
  job.progress(entries.length, entries.length, 'Done')

  job.note(
    `Features read at ${featureStep.toLocaleString()} bp and the assembly at ` +
      `${genomeStep.toLocaleString()} bp — a span-weighted sum estimates the same area at either, ` +
      'and the finer one is spent where the boundaries are.',
  )

  const outputs: TaskOutput[] = [
    {
      kind: 'table',
      id: 'frip',
      label: `In ${runs.length.toLocaleString()} merged feature${runs.length === 1 ? '' : 's'}`,
      columns: [
        { key: 'track', label: 'Track', kind: 'text' },
        { key: 'frip', label: 'FRiP', kind: 'number', digits: 4, hint: 'Signal inside over signal everywhere.' },
        {
          key: 'covered',
          label: 'Genome covered',
          kind: 'number',
          digits: 4,
          hint: 'Merged bases of the set over the assembly.',
        },
        {
          key: 'enrichment',
          label: 'Enrichment',
          kind: 'number',
          digits: 2,
          hint: 'FRiP over the covered fraction. 1 is a track with no preference.',
        },
        { key: 'signal', label: 'Signal inside', kind: 'number', digits: 0 },
        { key: 'totalSignal', label: 'Signal total', kind: 'number', digits: 0 },
        {
          key: 'inFeature',
          label: 'Set with data',
          kind: 'number',
          digits: 3,
          hint: 'Of the set’s bases, how many the track has a value for.',
        },
      ],
      rows: rows.sort((a, b) => Number(b.enrichment) - Number(a.enrichment)),
    } satisfies TableOutput,
  ]

  if (wantPerFeature && perFeature.length > 0) {
    outputs.push({
      kind: 'table',
      id: 'frip-features',
      label: 'Per feature',
      columns: [
        { key: 'track', label: 'Track', kind: 'text' },
        { key: 'contig', label: 'Sequence', kind: 'text' },
        { key: 'start', label: 'Start', kind: 'number', digits: 0 },
        { key: 'end', label: 'End', kind: 'number', digits: 0 },
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'signal', label: 'Signal', kind: 'number', digits: 2 },
        { key: 'mean', label: 'Mean', kind: 'number', digits: 4 },
        {
          key: 'share',
          label: 'Share of total',
          kind: 'number',
          digits: 6,
          hint: 'This feature’s signal over the track’s whole signal.',
        },
      ],
      rows: perFeature.sort((a, b) => Number(b.signal) - Number(a.signal)),
    } satisfies TableOutput)
  }

  return outputs
}

/**
 * One track's area over a set of regions, sampled per sequence.
 *
 * Per sequence because that is what the worker's `sample` is built for: it picks
 * one zoom level for the whole request and coalesces the on-disk blocks across
 * region boundaries (§8.2), so a chromosome's worth of peaks is one call rather
 * than one call per peak.
 */
async function areaOver(
  job: TrackJobContext,
  entry: string,
  regions: readonly Region[],
  step: number,
): Promise<Area> {
  const byContig = new Map<string, Region[]>()
  for (const region of regions) {
    const held = byContig.get(region.contig)
    if (held === undefined) byContig.set(region.contig, [region])
    else held.push(region)
  }

  let signal = 0
  let span = 0
  let covered = 0
  for (const [, wanted] of byContig) {
    job.throwIfCancelled()
    for (const region of wanted) span += region.end - region.start
    const sampled = await job.sample(entry, wanted, step)
    const bounds = new Map<string, Region>()
    for (const region of wanted) bounds.set(keyOf(region), region)
    for (const answer of sampled.regions) {
      const region = bounds.get(keyOf(answer))
      if (region === undefined) continue
      for (let k = 0; k < answer.values.length; k++) {
        const value = answer.values[k]
        if (!Number.isFinite(value)) continue
        // Clipped, always. The worker answers with the zoom bins that *overlap*
        // the request, so the first and last of them reach outside it — and a
        // narrow feature read at a coarse zoom would otherwise be credited with
        // its neighbours' signal.
        const from = Math.max(region.start, answer.starts[k])
        const to = Math.min(region.end, answer.ends[k])
        if (to <= from) continue
        signal += value * (to - from)
        covered += to - from
      }
    }
  }
  return { signal, span, covered }
}

/** Every feature of the set, scored on its own — unmerged, as the reader loaded it. */
async function scoreFeatures(
  job: TrackJobContext,
  entry: string,
  set: FeatureSet,
  step: number,
): Promise<Array<Record<string, string | number>>> {
  const out: Array<Record<string, string | number>> = []
  const byContig = new Map<string, number[]>()
  for (let i = 0; i < set.length; i++) {
    const contig = set.contigs[set.contig[i]]
    const held = byContig.get(contig)
    if (held === undefined) byContig.set(contig, [i])
    else held.push(i)
  }

  for (const [, indices] of byContig) {
    job.throwIfCancelled()
    const wanted = indices.map((i) => featureRegion(set, i))
    const sampled = await job.sample(entry, wanted, step)
    const answers = new Map<string, (typeof sampled.regions)[number]>()
    for (const answer of sampled.regions) answers.set(keyOf(answer), answer)
    for (let at = 0; at < indices.length; at++) {
      const region = wanted[at]
      const answer = answers.get(keyOf(region))
      if (answer === undefined) continue
      let signal = 0
      let covered = 0
      for (let k = 0; k < answer.values.length; k++) {
        const value = answer.values[k]
        if (!Number.isFinite(value)) continue
        const from = Math.max(region.start, answer.starts[k])
        const to = Math.min(region.end, answer.ends[k])
        if (to <= from) continue
        signal += value * (to - from)
        covered += to - from
      }
      out.push({
        contig: region.contig,
        start: region.start,
        end: region.end,
        name: set.name[indices[at]] ?? '',
        signal,
        // Over the bases that *had* a value, so a feature half of which the
        // track does not cover reports the mean of the half it does rather than
        // half the mean of it.
        mean: covered > 0 ? signal / covered : Number.NaN,
      })
    }
  }
  return out
}

function featureRegion(set: FeatureSet, i: number): Region {
  return { contig: set.contigs[set.contig[i]], start: set.start[i], end: set.end[i] }
}

function keyOf(region: { contig: string; start: number; end: number }): string {
  return `${region.contig}:${region.start}-${region.end}`
}
