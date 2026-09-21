/**
 * Diamond insulation, run.
 *
 * One dense square per sequence, one pass per scale, and a bin vector assembled
 * over the whole assembly so the result is a lane rather than a picture (§18.5).
 * The kernels are in `analysis/insulation.ts`; what is here is the plan, the
 * reads, and the two conversions that turn contig-local answers into
 * genome-wide objects.
 *
 * Both conversions are places to be careful. A score is computed in bins local
 * to a contig and has to land at `startBin + local` in a vector over every bin
 * in the file — off by the wrong offset and the track is a plausible picture of
 * the wrong chromosome. And a boundary is called at a bin and has to be written
 * as a *base-pair interval* clamped to the sequence, because it leaves as a BED
 * and a BED that runs past the end of a chromosome is one every tool downstream
 * will complain about, or worse, will not.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import {
  callBoundaries,
  diamondCells,
  diamondSums,
  diamondSumsBanded,
  domainsBetween,
  insulationScore,
  type Boundary,
} from '../insulation'
import {
  boolParam,
  contigIdFor,
  numParam,
  readsAsCircular,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { windowLadder } from '../tasks/insulation'
import type { IntervalsOutput, ProfileOutput, TaskOutput } from '../types'
import {
  bandFor,
  displayableContigs,
  forEachDiagonalTile,
  spanOfContig,
  usableBlock,
  type Span,
} from './blocks'
import { formatBp } from './labels'

/** One sequence this run will score. */
interface Unit {
  name: string
  span: Span
  /** Base pairs of the sequence, for clamping the last interval of a BED. */
  length: number
  /** Whether the reader has declared it circular (SPECS §8.15). */
  circular: boolean
}

/**
 * The sequences to score, and how long each one is.
 *
 * A region names a *sequence* and not a window of one, for the reason
 * `analysis/run/expected.ts` gives about P(s): insulation is computed against
 * the mean over a whole sequence, so a score taken from whatever happened to be
 * on screen but labelled `chrIV` is a different quantity wearing the same name.
 */
function planUnits(job: JobContext, region: string): Unit[] {
  const mc = job.mc
  const lengths = mc.chromsizes
  const unitFor = (cid: number): Unit | null => {
    const span = spanOfContig(mc, cid)
    if (span === null) return null
    const name = mc.chromnames[cid]
    return {
      name,
      span,
      length: lengths.get(name) ?? (span.to - span.from) * mc.binsize,
      circular: readsAsCircular(job, name),
    }
  }

  if (region !== '') {
    // Through {@link contigIdFor}, because the name is the *reader's* rather
    // than this file's: it was typed against whichever map the Analysis column
    // is pointed at, and a batch (§18.2) then asks every panel of the deck for
    // it. `mc.contigId` is literal and threw `unknown-label` on the one panel
    // that spells the sequence another way (§5.9).
    const cid = contigIdFor(mc, parseRegionString(region)[0])
    const unit = cid < 0 ? null : unitFor(cid)
    return unit === null ? [] : [unit]
  }
  const out: Unit[] = []
  for (const cid of displayableContigs(mc)) {
    const unit = unitFor(cid)
    if (unit !== null) out.push(unit)
  }
  return out
}

/**
 * What the scales of one run are grouped under.
 *
 * A name rather than an id, because it is shown to the reader and they can
 * change it: from the moment the rows exist it is an ordinary group, and the
 * only thing this constant decides is what it is called before anyone asks.
 */
const INSULATION_GROUP = 'Insulation'

export const runInsulation: TaskRunner = async (job) => {
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const minValid = Math.max(0, Math.min(1, numParam(job.params, 'minValid', 0.5)))
  // cooltools' `ignore_diags`, and its arithmetic: `|col - row| < n`.
  const ignoreDiags = Math.max(0, Math.round(numParam(job.params, 'ignoreDiags', 2)))
  const windows = windowLadder(job.params)
  const widest = windows[windows.length - 1]

  // A diamond spans separations `1 … 2w − 1`, so ignoring `2w` diagonals or more
  // leaves it with nothing to sum. Said here rather than discovered as an empty
  // lane: every bin would score `NaN`, which is indistinguishable from a file
  // with no contacts in it, and the reader's next move would be to doubt the
  // data rather than the setting.
  const empty = windows.filter((window) => diamondCells(window, ignoreDiags) <= 0)
  if (empty.length === windows.length) {
    throw new Error(
      `Ignoring ${ignoreDiags} diagonals leaves nothing in a diamond ` +
        `${windows.length === 1 ? `${widest} bins` : `up to ${widest} bins`} wide: it spans ` +
        `separations 1 to ${2 * widest - 1}, so every cell is inside the cut. Ignore fewer, or ` +
        'use a wider window.',
    )
  }
  if (empty.length > 0) {
    job.note(
      `Ignoring ${ignoreDiags} diagonals empties the ${empty.join(', ')} bin ` +
        `${empty.length === 1 ? 'window' : 'windows'} — a diamond of ${empty[0]} bins spans only ` +
        `${2 * empty[0] - 1} separations — so ${empty.length === 1 ? 'that scale is' : 'those scales are'} ` +
        'all gaps.',
    )
  }

  const region = strParam(job.params, 'region', '').trim()
  const planned = planUnits(job, region)
  // Two ways to end with nothing, and they need two sentences. A region that
  // named a sequence this file has not got is a batch across a deck of two
  // assemblies (§18.2), and answering it with the window advice sends the reader
  // to change a number that was never the problem.
  if (region !== '' && planned.length === 0) {
    job.note(
      `This file has no sequence called ${parseRegionString(region)[0]}, under that spelling or ` +
        `any this viewer knows of (§5.9). It has ` +
        `${job.mc.chromnames.slice(0, 6).join(', ')}${job.mc.chromnames.length > 6 ? ', …' : ''}.`,
    )
    return []
  }
  const units = planned.filter(
    // A sequence with no bin whose whole diamond fits produces a column of NaN
    // at full cost. Dropped here and counted, rather than read and thrown away.
    (unit) => unit.span.to - unit.span.from > widest * 2,
  )
  if (units.length === 0) {
    job.note(
      'No sequence in this file is long enough for a whole diamond of this width either side ' +
        'of any bin. Use a narrower window.',
    )
    return []
  }

  const nBins = job.mc.nBins
  // One vector per scale, over every bin in the file, gaps everywhere nothing is
  // scored — which is most of it when a region was named, and is correct: a
  // track that claims a value for a sequence this run never looked at is a track
  // that lies about its own coverage.
  const scores = windows.map(() => new Float32Array(nBins).fill(Number.NaN))
  const block = usableBlock(job, units.map((unit) => unit.span), balance)
  const calls: Array<{ unit: Unit; boundaries: Boundary[]; window: number }> = []

  const call = boolParam(job.params, 'call', true)
  const prominence = numParam(job.params, 'prominence', 0.2)
  // In bins, as the form now asks for it: a spacing between two calls on a
  // track whose x axis is bins was being typed in base pairs and divided here.
  const spacing = Math.max(1, Math.round(numParam(job.params, 'spacing', 0)))

  /**
   * One sequence's sums, turned into the lane and (at the base scale) the calls.
   *
   * A closure rather than two copies, because the two read paths above it —
   * tiled squares for a line, one band for a circle — differ only in how the
   * sums are filled in, and everything after that is the same for both. Two
   * copies of it is two places for the local-to-absolute conversion to be
   * written, and that conversion is the one `run/insulation.ts` opens by warning
   * about.
   */
  const finish = (unit: Unit, size: number, sums: Float64Array[]): void => {
    for (let w = 0; w < windows.length; w++) {
      const score = insulationScore(sums[w])
      for (let local = 0; local < size; local++) {
        scores[w][unit.span.from + local] = score[local]
      }
      // Called from the *base* scale only. Boundaries at four widths are four
      // overlapping sets of the same features at different smoothings, and
      // merging them is a decision this task has no basis for making; the reader
      // who wants the wider set runs it again with that width as the base.
      if (call && w === 0) {
        calls.push({ unit, boundaries: callBoundaries(score, { prominence, spacing }), window: windows[w] })
      }
    }
  }

  for (let u = 0; u < units.length; u++) {
    const unit = units[u]
    const size = unit.span.to - unit.span.from

    // **The sums are accumulated over tiles and the score is taken once.** The
    // diamond at a bin reaches `window` bins each side of it and no further, so
    // a sequence is a band and never a square — and reading it as a square put a
    // ceiling on this task that had nothing to do with its arithmetic: one
    // `Float32Array` of `n²` is refused past 23,170 bins whatever the machine
    // has (`MAX_DENSE_ARRAY_BYTES`), which is 116 Mb at 5 kb. Mouse chr9 is 125.
    //
    // The split is between the *sums*, which are per bin and local, and the
    // *score*, which is a log2 ratio against the mean over the whole sequence.
    // So each tile fills in the sums for the bins whose whole diamond it holds,
    // and `insulationScore` runs once at the end over the assembled vector —
    // which makes the answer identical to the whole-square one cell for cell,
    // rather than merely close. `diamondSums` is unchanged and still goldened
    // against cooltools; it simply sees a smaller square.
    const sums = windows.map(() => new Float64Array(size).fill(Number.NaN))

    // **A circular sequence is read as a band, not as tiled squares.** The
    // diamond at a bin spans separations `1 … 2w − 1`, so it *is* a band — the
    // square was only ever needed for the two ends of a linear sequence, where
    // the window hangs off and the bin scores `NaN`. A circle has no such ends,
    // and the one thing a tiled square walk cannot give it is the cell joining
    // its last bin to its first, which lives in the far corner of the contig's
    // own square and which `bandFor` reads with one extra request (§8.15).
    if (unit.circular) {
      await job.breathe()
      job.progress(u, units.length, unit.name)
      const band = await bandFor(job, unit.span, {
        hi: 2 * widest,
        block,
        balance,
        value,
        circular: true,
        onTile: async (done, total) => {
          await job.breathe()
          job.progress(
            u,
            units.length,
            total === 1 ? unit.name : `${unit.name} · strip ${Math.min(done + 1, total)} of ${total}`,
          )
        },
      })
      for (let w = 0; w < windows.length; w++) {
        const local = diamondSumsBanded(band, {
          window: windows[w],
          minValid,
          ignoreDiags,
        })
        sums[w].set(local)
      }
      finish(unit, size, sums)
      continue
    }

    await forEachDiagonalTile(
      job,
      unit.span,
      { halo: widest, block, balance, value },
      async (tile) => {
        // Once per tile: the diamonds below are a double loop that yields
        // nothing, so this is the only place a cancel can be heard.
        await job.breathe()
        job.progress(
          u,
          units.length,
          tile.total === 1 ? unit.name : `${unit.name} · part ${tile.index + 1} of ${tile.total}`,
        )
        for (let w = 0; w < windows.length; w++) {
          const tileSums = diamondSums(
            { size: tile.size, values: tile.values },
            { window: windows[w], minValid, ignoreDiags },
          )
          for (let local = tile.ownFrom; local < tile.ownTo; local++) {
            sums[w][local] = tileSums[local - tile.from]
          }
        }
      },
    )

    finish(unit, size, sums)
  }
  job.progress(units.length, units.length, 'done')

  const round = units.filter((unit) => unit.circular).length
  if (round > 0) {
    job.note(
      `${round.toLocaleString()} of ${units.length.toLocaleString()} ` +
        `${units.length === 1 ? 'sequence was' : 'sequences were'} read as circular, so the ` +
        'diamond wraps past the end and every bin is scored — including the ones at the ' +
        'junction, which a linear reading leaves as gaps.',
    )
  }

  // **Widest first, because the stack reads top-down.** A multi-scale run is one
  // picture — the same score at doubling smoothings — and the lanes are laid out
  // in the order they are adopted, so emitting them narrowest-first would put
  // the finest detail at the top and the smoothest at the bottom. Every published
  // version of this figure runs the other way (fanc's `-p scores`, cooltools'
  // multi-window insulation): the widest window on top, sharpening downwards, so
  // a boundary that survives every scale reads as a column through the whole
  // stack.
  const outputs: TaskOutput[] = windows
    .map((window, index) => profileFor(job, scores[index], window, windows.length > 1))
    .reverse()

  if (call) {
    const total = calls.reduce((sum, entry) => sum + entry.boundaries.length, 0)
    if (total === 0) {
      job.note(
        `No minimum was prominent enough to call at a threshold of ${prominence}. ` +
          'Lower it, or widen the window.',
      )
    } else {
      outputs.push(boundaryOutput(job, calls))
      job.note(`${total.toLocaleString()} boundaries called across ${calls.length} sequences.`)
      if (boolParam(job.params, 'domains', true)) {
        const domains = domainOutput(job, calls)
        if (domains === null) {
          // Every sequence had one call or none, so there is no interior with
          // both its edges. Said out loud rather than left as a missing lane:
          // the tickbox is on, so a reader who sees no domains row is owed the
          // reason.
          job.note(
            'No sequence had two calls, so no domain has both of its edges and none was made.',
          )
        } else {
          outputs.push(domains.output)
          job.note(
            `${domains.count.toLocaleString()} domains between them, from each call to the next.`,
          )
        }
      }
    }
  }
  return outputs
}

/**
 * One scale, as a lane.
 *
 * `stack` is true when the run produced more than one, and it is the whole of
 * what this task asks the Annotations panel for (§18.11): one group, drawn as
 * stacked heatmaps. The reasoning is that a score per bin *per window* is a
 * matrix, and one line per window is what a matrix looks like when it is drawn
 * as a bundle of curves — four of them crossing each other, autoscaled to four
 * different axes, in four lanes' worth of height. As colour it is what it is: a
 * boundary is a vertical stripe through every row it survives, and the height
 * cost of the fourth scale is a few pixels rather than another lane.
 *
 * A single-scale run is left exactly as it was — an ordinary ungrouped line —
 * because there is no set for it to be part of and a heatmap of one row is a
 * worse picture of one track than the track.
 */
function profileFor(
  job: JobContext,
  values: Float32Array,
  window: number,
  stack: boolean,
): ProfileOutput {
  const bp = window * job.mc.binsize
  return {
    kind: 'profile',
    id: `insulation-w${window}`,
    label: `Insulation · ${formatBp(bp)}`,
    values,
    extent: [0, job.mc.nBins],
    binsize: job.mc.binsize,
    // log2 of a ratio against the sequence mean, so zero is average and the
    // sign is the whole reading. Named rather than left blank, because a lane
    // whose axis runs −2 to 2 with no unit invites being read as a count.
    unit: 'log2 ratio',
    ...(stack
      ? { group: INSULATION_GROUP, mode: 'heatmap' as const, groupMode: 'overlay' as const }
      : {}),
  }
}

/**
 * The calls, as a `FeatureSet` the Annotations panel can draw.
 *
 * Each boundary is one bin wide — it is a position, and the bin is the finest
 * this file can place one at — clamped to the sequence so the last bin of a
 * contig does not produce an interval past its end. The prominence goes in the
 * score column, so the overlay can be filtered on it and a downstream BED keeps
 * the number the call was made on.
 */
function boundaryOutput(
  job: JobContext,
  calls: ReadonlyArray<{ unit: Unit; boundaries: Boundary[]; window: number }>,
): TaskOutput {
  const builder = new FeatureBuilder()
  for (const { unit, boundaries } of calls) {
    for (const boundary of boundaries) {
      const start = boundary.bin * job.mc.binsize
      builder.add(unit.name, start, Math.min(unit.length, start + job.mc.binsize), {
        score: boundary.prominence,
        name: '',
        detail: `insulation ${boundary.score.toFixed(3)} · prominence ${boundary.prominence.toFixed(3)}`,
      })
    }
  }
  return {
    kind: 'intervals',
    id: 'insulation-boundaries',
    label: 'Insulation boundaries',
    payload: { kind: 'features', data: builder.finish() },
    noun: { one: 'boundary', many: 'boundaries' },
  }
}

/**
 * The spans between the calls, as a second `FeatureSet` — the domains.
 *
 * Consecutive calls on **one sequence**, which is why this walks the same
 * per-unit list the boundaries came from rather than a flat set: "consecutive"
 * is a property of a sequence, and the last call on `chr1` and the first on
 * `chr2` are adjacent in any sorted list and are not two ends of anything.
 *
 * Each domain runs from the bin one call was made at to the bin the next was
 * made at, so consecutive domains tile and the lane reads as a segmentation —
 * the picture the compartment track makes, which is what a reader already knows
 * how to read. Clamped to the sequence for the same reason the boundaries are:
 * it leaves as a BED, and a BED past the end of a chromosome is one every tool
 * downstream complains about, or worse, does not.
 *
 * `null` where there is nothing to report, so the caller can say why rather than
 * adopting an empty overlay onto the Annotations panel.
 */
function domainOutput(
  job: JobContext,
  calls: ReadonlyArray<{ unit: Unit; boundaries: Boundary[]; window: number }>,
): { output: IntervalsOutput; count: number } | null {
  const builder = new FeatureBuilder()
  let count = 0
  for (const { unit, boundaries } of calls) {
    for (const domain of domainsBetween(boundaries)) {
      const start = domain.from * job.mc.binsize
      const end = Math.min(unit.length, domain.to * job.mc.binsize)
      if (end <= start) continue
      count++
      builder.add(unit.name, start, end, {
        // The weaker edge, so the overlay can be filtered on it and a reader
        // ranking the set in APA is ranking on how well *both* sides are held.
        score: domain.strength,
        // No name, because a domain has none. Compartments write `A` or `B`
        // into the box because there are two kinds; here every box is the same
        // kind and a label per domain would be ink saying nothing.
        name: '',
        detail: `${domain.to - domain.from} bins · weaker boundary prominence ${domain.strength.toFixed(3)}`,
      })
    }
  }
  if (count === 0) return null
  return {
    count,
    output: {
      kind: 'intervals',
      id: 'insulation-domains',
      label: 'Insulation domains',
      payload: { kind: 'features', data: builder.finish() },
      noun: { one: 'domain', many: 'domains' },
    },
  }
}

