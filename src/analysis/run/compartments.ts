/**
 * Compartments, run: expected → observed/expected → correlation → eigenvectors,
 * then phasing, then the saddle.
 *
 * Everything mathematical is in `analysis/compartments.ts` and
 * `analysis/linalg.ts`. What is here is the chain, the places it can refuse, and
 * the two things neither kernel can do for itself — **assembling the square** a
 * set of ticked sequences implies, and building the *signal* a component's sign
 * is attached to, which means reading a gene model or a FASTA's GC content over
 * the same bins.
 *
 * ## One correlation over the ticked sequences, cis and trans
 *
 * The reader ticks sequences and gets **one** eigenvector over all of them,
 * computed from a square that holds their cis blocks *and* the trans blocks
 * between them. That is a different quantity from the per-chromosome one and not
 * an average of it: two chromosomes in the same compartment touch each other in
 * trans, and it is exactly that signal a genome-wide E1 is carried by. Ticking
 * one sequence gives the per-chromosome answer, which is the degenerate case of
 * the same arithmetic rather than a second code path.
 *
 * The expectation is where cis and trans part company, and
 * {@link ExpectedPlan} is the whole of it: a cis cell is divided by its own
 * sequence's decay at that separation — never a pooled curve, which would divide
 * a small chromosome by the average behaviour of the large ones and show up as a
 * gradient along the eigenvector — and a trans cell, which has no separation at
 * all, is divided by the mean of its own pair's block.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import type { FeatureSet } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import {
  compartmentSegments,
  correlationMatrix,
  observedOverExpected,
  phaseComponent,
  saddle,
  usableBins,
  type ExpectedPlan,
  type Phasing,
} from '../compartments'
import { ExpectedAccumulator } from '../expected'
import {
  boolParam,
  chosenInput,
  idParam,
  listParam,
  numParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import type { Params } from '../types'
import { leadingEigenpairs } from '../linalg'
import { MAX_CORRELATION_BINS } from '../tasks/compartments'
import type { MatrixOutput, ProfileOutput, TaskOutput } from '../types'
import { usableBlock, type Span } from './blocks'

/**
 * The fraction of a bin's row that must carry data for it to take part.
 *
 * A constant rather than a control. It was one, in a *Quality* section beside
 * the balancing tickbox, and neither belonged there: this is the threshold below
 * which a row of the correlation matrix is noise, not a knob anybody sweeps to
 * change an answer — moving it does not produce a different reading of the
 * chromosome, it produces the same reading with more or less rubbish in it. The
 * bins it drops are named in a note either way, which is the part a reader
 * actually needs.
 */
const MIN_COVERAGE = 0.1

/**
 * The square a set of ticked sequences implies.
 *
 * `bin` and `group` are the two arrays everything downstream reads: which file
 * bin each row of the square is, and which ticked sequence it belongs to. The
 * groups are **contiguous runs** of the square by construction, which is what
 * lets a cis separation be `|col − row|` rather than needing a lookup per cell.
 *
 * `spans` is the *coalesced* form, and it is what makes the common case cheap:
 * every sequence ticked coalesces to one run over the whole file and reads as one
 * block, while a scattered subset reads one rectangle per pair. Adjacent ticked
 * sequences coalesce too, so ticking chromosomes I–IV is one read and not ten.
 */
interface Selection {
  /** Ticked contig ids, in file order. */
  contigs: number[]
  /** Coalesced runs of absolute bins, ascending and non-touching. */
  spans: Span[]
  /** Where each span starts in the square. */
  spanAt: number[]
  /** Absolute file bin of each row of the square; `n` long. */
  bin: Int32Array
  /** Index into {@link contigs} for each row of the square; `n` long. */
  group: Int32Array
  n: number
}

/**
 * The ticked sequences, as a square to read.
 *
 * A contig with no bins is dropped rather than made into an empty group: an
 * `ExpectedAccumulator` of zero length and a trans block with no cells are two
 * ways to get a `NaN` into the plan for a sequence the reader ticked and cannot
 * see anything wrong with.
 */
function selectionOf(job: JobContext, names: readonly string[]): Selection {
  const contigs: number[] = []
  for (let cid = 0; cid < job.mc.chromnames.length; cid++) {
    if (!names.includes(job.mc.chromnames[cid])) continue
    const [from, to] = job.mc.contigExtent(cid)
    if (to > from) contigs.push(cid)
  }

  let n = 0
  const bins: number[] = []
  const group: number[] = []
  for (let g = 0; g < contigs.length; g++) {
    const [from, to] = job.mc.contigExtent(contigs[g])
    for (let bin = from; bin < to; bin++) {
      bins.push(bin)
      group.push(g)
    }
    n += to - from
  }

  // Coalesced *after* the rows are laid out, so the square's order is the file's
  // whatever the runs turn out to be.
  const spans: Span[] = []
  const spanAt: number[] = []
  for (let i = 0; i < bins.length; i++) {
    const last = spans[spans.length - 1]
    if (last !== undefined && bins[i] === last.to) {
      last.to++
      continue
    }
    spanAt.push(i)
    spans.push({ from: bins[i], to: bins[i] + 1 })
  }

  return { contigs, spans, spanAt, bin: Int32Array.from(bins), group: Int32Array.from(group), n }
}

/**
 * The square itself: every ticked bin against every other, cis and trans.
 *
 * From the view's own block where it covers the lot — the common case, since a
 * reader usually presses **Run** while looking at the thing they want measured —
 * and otherwise one dense read per pair of coalesced runs. Pairs rather than one
 * covering read, because a covering read over a scattered selection is the whole
 * genome: ticking chromosomes I and XVI would otherwise read everything between
 * them and throw it away.
 *
 * Both triangles are filled from each read. `mc.matrix` answers a rectangle
 * honestly whichever side of the diagonal it is on, so the mirror is a transpose
 * of what was read rather than a second request.
 */
async function readSquare(
  job: JobContext,
  selection: Selection,
  options: { balance: boolean; value: string },
): Promise<Float32Array> {
  const { spans, spanAt, n } = selection
  const out = new Float32Array(n * n).fill(Number.NaN)
  const block = usableBlock(job, spans, options.balance)
  const reads = (spans.length * (spans.length + 1)) / 2
  let done = 0

  const place = (
    values: Float32Array,
    ncols: number,
    rowSpan: number,
    colSpan: number,
  ): void => {
    const rows = spans[rowSpan].to - spans[rowSpan].from
    const cols = spans[colSpan].to - spans[colSpan].from
    const rowAt = spanAt[rowSpan]
    const colAt = spanAt[colSpan]
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const value = values[r * ncols + c]
        out[(rowAt + r) * n + colAt + c] = value
        out[(colAt + c) * n + rowAt + r] = value
      }
    }
  }

  for (let i = 0; i < spans.length; i++) {
    for (let j = i; j < spans.length; j++) {
      job.throwIfCancelled()
      job.progress(done, reads, 'Reading')
      done++
      if (block !== null) {
        // The block is dense over its own extents, so the two runs index into it
        // directly — no request, and no copy of anything but the cells wanted.
        const rowSkip = spans[i].from - block.rowExtent[0]
        const colSkip = spans[j].from - block.colExtent[0]
        const rows = spans[i].to - spans[i].from
        const cols = spans[j].to - spans[j].from
        const cut = new Float32Array(rows * cols)
        for (let r = 0; r < rows; r++) {
          const at = (rowSkip + r) * block.ncols + colSkip
          cut.set(block.values.subarray(at, at + cols), r * cols)
        }
        place(cut, cols, i, j)
        continue
      }
      const dense = await job.mc.matrix({
        rows: [spans[i].from, spans[i].to],
        cols: [spans[j].from, spans[j].to],
        balance: options.balance,
        value: options.value,
      })
      place(dense.values, dense.ncols, i, j)
    }
  }
  return out
}

/**
 * What each cell is divided by: a decay curve per sequence, a mean per pair.
 *
 * Accumulated from the square that is already in hand rather than from the P(s)
 * task, and that is not a shortcut — an O/E over one chromosome wants that
 * chromosome's own decay, and the whole-file curve is a different denominator.
 */
function planExpected(values: Float32Array, selection: Selection): ExpectedPlan {
  const { group, n } = selection
  const k = selection.contigs.length
  const starts: number[] = []
  const ends: number[] = []
  for (let g = 0; g < k; g++) {
    starts.push(group.indexOf(g))
    ends.push(group.lastIndexOf(g) + 1)
  }

  const cis = starts.map((start, g) => {
    const length = ends[g] - start
    const accumulator = new ExpectedAccumulator(Math.max(0, length - 1))
    for (let r = start; r < ends[g]; r++) {
      for (let c = start; c < ends[g]; c++) {
        accumulator.add(Math.abs(c - r), values[r * n + c])
      }
    }
    return accumulator.finish()
  })

  const trans = new Float64Array(k * k).fill(Number.NaN)
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      let total = 0
      let seen = 0
      for (let r = starts[a]; r < ends[a]; r++) {
        for (let c = starts[b]; c < ends[b]; c++) {
          const value = values[r * n + c]
          if (!Number.isFinite(value)) continue
          total += value
          seen++
        }
      }
      // The mean of the pair's own block. `NaN` where the pair has nothing in it
      // at all, which `observedOverExpected` reads as *no expectation* and
      // answers with a gap rather than with the raw count.
      const mean = seen === 0 ? Number.NaN : total / seen
      trans[a * k + b] = mean
      trans[b * k + a] = mean
    }
  }

  return { group, cis, trans, contacts: 'both' }
}

/** Which contacts enter the correlation; see {@link ExpectedPlan.contacts}. */
function contactsOf(params: Params): 'cis' | 'trans' | 'both' {
  const value = params.contacts
  return value === 'cis' || value === 'trans' ? value : 'both'
}

/**
 * One square, from reading it to the outputs it produced.
 *
 * The whole chain, run over whatever selection it is handed — every ticked
 * sequence at once, or one of them. `null` where this square produced nothing,
 * and every one of those paths leaves a note naming the selection: a chromosome
 * silently missing from a genome-wide track is the failure this could most
 * easily have.
 *
 * The eigenvectors are written into `tracks` rather than returned, because a
 * track is a track: E1 of chromosome IV and E1 of chromosome V are the same
 * quantity on two stretches of one axis, and two rows on the Synthetic tracks
 * card saying `E1 · IV` and `E1 · V` would be a card the reader reassembles by
 * eye.
 */
async function runSquare(
  job: JobContext,
  selection: Selection,
  options: {
    contacts: 'cis' | 'trans' | 'both'
    wanted: number
    tracks: Float32Array[]
    segments: FeatureBuilder
    label: string
    /** Reported as `done of total` while several squares are being run. */
    step: { at: number; of: number }
  },
): Promise<{ saddle: MatrixOutput | null } | null> {
  const { label } = options
  const balance = boolParam(job.params, 'balance', true)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const square = await readSquare(job, selection, { balance, value })
  job.throwIfCancelled()

  const plan: ExpectedPlan = { ...planExpected(square, selection), contacts: options.contacts }
  const index = usableBins(square, selection.n, MIN_COVERAGE)
  if (index.length < 8) {
    job.note(
      `${label}: only ${index.length} bins carry enough data to correlate, which is too few for ` +
        'a component to mean anything.',
    )
    return null
  }
  if (index.length < selection.n) {
    job.note(
      `${label}: ${(selection.n - index.length).toLocaleString()} of ` +
        `${selection.n.toLocaleString()} bins were left out for want of data. They are gaps in ` +
        'the track rather than zeros.',
    )
  }

  const oe = observedOverExpected(square, selection.n, index, plan)
  job.throwIfCancelled()

  // Cubic in the bin count, and the one step of the chain that is — so it
  // reports where it has got to and can be stopped from inside its own loop.
  const correlation = correlationMatrix(oe, index.length, (row) => {
    job.throwIfCancelled()
    if (row % 64 === 0) {
      job.progress(options.step.at, options.step.of, `Correlating ${label}`)
    }
  })

  // The correlation matrix is consumed in place by the deflation, so the saddle
  // below uses `oe` — which is the matrix it wants anyway.
  const pairs = leadingEigenpairs(correlation, index.length, options.wanted)
  if (pairs.length === 0) {
    job.note(`${label}: the correlation matrix has no leading component; it may be too sparse.`)
    return null
  }

  const signal = phasingSignal(job, selection, index)
  let phased: Phasing | null = null

  for (let component = 0; component < pairs.length && component < options.tracks.length; component++) {
    const vector = pairs[component].vector
    if (signal !== null) {
      const result = phaseComponent(vector, signal, numParam(job.params, 'minR', 0.1))
      if (component === 0) {
        phased = result
        job.note(
          result.confident
            ? `${label}: E1 phased against ${result.signal} (r = ${fmt(result.r)})` +
                `${result.flipped ? ', sign flipped' : ''}.`
            : `${label}: phasing against ${result.signal} was ambiguous (r = ${fmt(result.r)}), ` +
                'so E1’s sign is arbitrary and should not be compared with another run.',
        )
      }
    } else if (component === 0) {
      job.note('Nothing was chosen to phase against, so the sign of each component is arbitrary.')
    }

    // Back over the full bin grid, with every bin that took no part restored as
    // a gap — which is the whole reason the chain worked over an index (§18.8).
    const track = options.tracks[component]
    for (let i = 0; i < index.length; i++) track[selection.bin[index[i]]] = vector[i]
  }

  addCompartmentSegments(job, options.segments, selection, index, pairs[0].vector)

  if (!boolParam(job.params, 'saddle', true)) return { saddle: null }
  const bins = Math.max(5, Math.min(100, Math.round(numParam(job.params, 'quantiles', 50))))
  const result = saddle(oe, index.length, pairs[0].vector, bins)
  return {
    saddle: {
      kind: 'matrix',
      id: `compartment-saddle-${label}`,
      label: `Saddle · ${label}`,
      nrows: bins,
      ncols: bins,
      values: result.values,
      xLabel: 'E1 quantile',
      yLabel: 'E1 quantile',
      xTicks: [],
      yTicks: [],
      colormap: DEFAULT_DIVERGING_COLORMAP,
      centre: 1,
      stats: [
        { label: 'AA', value: result.strength.aa, digits: 2 },
        { label: 'BB', value: result.strength.bb, digits: 2 },
        { label: 'AB', value: result.strength.ab, digits: 2 },
        ...(phased === null || phased.confident
          ? []
          : [
              {
                label: 'phasing r',
                value: phased.r,
                digits: 2,
                hint: 'Too weak to fix the sign, so AA and BB may be the wrong way round.',
              },
            ]),
      ],
    } satisfies MatrixOutput,
  }
}

export const runCompartments: TaskRunner = async (job) => {
  const names = listParam(job.params, 'sequences')
  if (names.length === 0) {
    job.note('No sequence is ticked, so there is nothing to correlate.')
    return []
  }
  const whole = selectionOf(job, names)
  if (whole.n === 0) {
    job.note('None of the ticked sequences has any bins in it.')
    return []
  }

  const contacts = contactsOf(job.params)
  if (contacts === 'trans' && whole.contigs.length < 2) {
    throw new Error(
      'A trans correlation is between sequences, so it needs at least two ticked. Tick more, ' +
        'or read this one’s cis contacts instead.',
    )
  }

  /**
   * **Cis-only is one square per sequence; the other two are one square.**
   *
   * Not a preference. A single square with its trans blocks removed has no
   * finite cell shared between a row of chromosome IV and a row of chromosome V,
   * so every correlation across that boundary is undefined and enters the matrix
   * as a zero — leaving it block-diagonal, and the leading eigenvector of a
   * block-diagonal matrix lives entirely inside whichever block has the largest
   * eigenvalue and is zero on all the others. A genome-wide cis-only run done
   * that way returns one chromosome's compartments and fifteen flat lines, which
   * is wrong in a way that looks like data.
   *
   * So cis-only loops, exactly as somebody would by hand, and each pass is the
   * per-chromosome run in full. It is also the cheaper shape by a long way — the
   * correlation is cubic, so sixteen squares of 1,500 bins is a fraction of one
   * of 24,000 — which is what makes cis-only the mode that works at a fine
   * resolution.
   */
  const squares =
    contacts === 'cis'
      ? whole.contigs.map((cid) => selectionOf(job, [job.mc.chromnames[cid]]))
      : [whole]

  const wanted = Math.max(1, Math.min(3, Math.round(numParam(job.params, 'components', 1))))
  const tracks: Float32Array[] = []
  for (let i = 0; i < wanted; i++) tracks.push(new Float32Array(job.mc.nBins).fill(Number.NaN))
  const segments = new FeatureBuilder()
  const outputs: TaskOutput[] = []
  let ran = 0

  for (let s = 0; s < squares.length; s++) {
    job.throwIfCancelled()
    const selection = squares[s]
    const label = describe(job, selection)
    if (selection.n > MAX_CORRELATION_BINS) {
      const message =
        `${label} is ${selection.n.toLocaleString()} bins, past the ` +
        `${MAX_CORRELATION_BINS.toLocaleString()}-bin limit on a correlation matrix`
      // Naming one sequence and being refused is a refusal — the reader asked
      // for that and got nothing. Meeting one in a sweep is not a reason to
      // throw away the others.
      if (squares.length === 1) {
        throw new Error(`Refusing to build it: ${message}. Untick some, or open the file coarser.`)
      }
      job.note(`${message}, so it was skipped. Open the file at a coarser resolution to include it.`)
      continue
    }
    job.progress(s, squares.length, `Compartments on ${label}`)
    const done = await runSquare(job, selection, {
      contacts,
      wanted,
      tracks,
      segments,
      label,
      step: { at: s, of: squares.length },
    })
    if (done === null) continue
    ran++
    if (done.saddle !== null) outputs.push(done.saddle)
  }

  if (ran === 0) {
    job.note('Nothing produced a component. See the notes above.')
    return []
  }

  // The tracks first, then the calls, then the pictures: a reader scanning the
  // drawer meets the thing they will keep before the thing they will look at.
  const label = `${describe(job, whole)} · ${CONTACT_WORDS[contacts]}`
  outputs.unshift(
    ...tracks.map(
      (values, i) =>
        ({
          kind: 'profile',
          id: `compartment-e${i + 1}`,
          label: `E${i + 1} · ${label}`,
          values,
          extent: [0, job.mc.nBins],
          binsize: job.mc.binsize,
          unit: '',
        }) satisfies ProfileOutput,
    ),
    {
      kind: 'intervals',
      id: 'compartment-ab',
      label: `A/B compartments · ${label}`,
      payload: { kind: 'features', data: segments.finish() },
    },
  )

  job.progress(squares.length, squares.length, 'Done')
  return outputs
}

/** How each mode is named on a lane label and in a provenance line. */
const CONTACT_WORDS: Record<'cis' | 'trans' | 'both', string> = {
  cis: 'cis',
  trans: 'trans',
  both: 'cis + trans',
}

/**
 * What to call this run: the sequence, or how many of them.
 *
 * One name where one sequence was ticked, because that is what a reader would
 * write on it; a count otherwise, because sixteen names on a lane label is not a
 * label. "Genome-wide" is reserved for the case where it is true.
 */
function describe(job: JobContext, selection: Selection): string {
  const k = selection.contigs.length
  if (k === 1) return job.mc.chromnames[selection.contigs[0]]
  const total = job.mc.chromnames.length
  return k === total ? 'genome-wide' : `${k.toLocaleString()} of ${total.toLocaleString()} sequences`
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '—'
}

/**
 * The A/B call, as a `FeatureSet` the Annotations panel can draw and a BED can
 * carry.
 *
 * The arithmetic is `compartmentSegments`, run **per sequence**: a run of one
 * sign cannot cross a chromosome boundary, and feeding it the whole selection at
 * once would join the last bin of one to the first of the next wherever they
 * happened to agree — a segment spanning two chromosomes, which is not a thing.
 */
function addCompartmentSegments(
  job: JobContext,
  builder: FeatureBuilder,
  selection: Selection,
  index: Int32Array,
  vector: Float64Array,
): void {
  const binsize = job.mc.binsize
  for (let g = 0; g < selection.contigs.length; g++) {
    const cid = selection.contigs[g]
    const name = job.mc.chromnames[cid]
    const [from] = job.mc.contigExtent(cid)
    // The sequence's own length, so the last segment stops where the chromosome
    // does rather than at the end of a bin that runs past it.
    const length = job.mc.chromsizes.get(name) ?? Number.POSITIVE_INFINITY
    const rows: number[] = []
    const values: number[] = []
    for (let i = 0; i < index.length; i++) {
      if (selection.group[index[i]] !== g) continue
      rows.push(selection.bin[index[i]])
      values.push(vector[i])
    }
    if (rows.length === 0) continue
    for (const segment of compartmentSegments(Int32Array.from(rows), Float64Array.from(values))) {
      builder.add(
        name,
        (segment.from - from) * binsize,
        Math.min(length, (segment.to - from + 1) * binsize),
        {
          name: segment.side,
          score: segment.mean,
          detail: `E1 mean ${segment.mean.toFixed(3)} · ${segment.bins} bins`,
        },
      )
    }
  }
}

/**
 * The signal a component's sign is attached to, over the bins that took part.
 *
 * A gene model first, because gene density is the conventional phasing signal
 * and the one a reader will recognise; a FASTA's GC content second, because it
 * is the fallback every tool offers and it needs no annotation at all. Both are
 * read over the ticked sequences and nothing else — which for a genome-wide run
 * is what makes one sign hold across all of them, rather than each chromosome
 * being phased against its own copy of the signal and drifting apart.
 *
 * **GC is not computed here, and it does not need to be.** The residues live in
 * the annotations worker and are megabytes; what this task wants is one number
 * per bin, which is exactly what that worker's `sample` already produces for the
 * lane it draws. So the main thread asks for the vector and ships it in
 * `inputs.vectors`, under the parameter's own key — the same channel a chosen
 * bigWig arrives on. That is why this file has no idea a FASTA was involved, and
 * why phasing by GC did not cost the task a third venue.
 */
function phasingSignal(
  job: JobContext,
  selection: Selection,
  index: Int32Array,
): { name: string; values: Float64Array } | null {
  // By the **parameter key**, `phaseFeatures`, exactly as the GC vector below is
  // read under `phaseSequence` — see `chosenInput`.
  const set = chosenInput(job.inputs.features, job.params, 'phaseFeatures').value
  if (set !== undefined) {
    return { name: 'gene density', values: densityOf(job, set, selection, index) }
  }

  const sequenceId = idParam(job.params, 'phaseSequence')
  if (sequenceId === null) return null
  const gc = job.inputs.vectors?.['phaseSequence']
  if (gc === undefined) {
    // The row was dropped between the form being filled in and Run being
    // pressed, or the file has no sequence for these contigs. Named rather than
    // ignored: a component whose sign was left alone looks exactly like one that
    // was phased and came out this way round.
    job.note(
      'The sequence chosen for phasing could not be read, so the sign was left alone. ' +
        'Re-open the FASTA, or choose a gene model instead.',
    )
    return null
  }
  const out = new Float64Array(index.length)
  for (let i = 0; i < index.length; i++) {
    const bin = selection.bin[index[i]]
    out[i] = bin >= 0 && bin < gc.length ? gc[bin] : Number.NaN
  }
  return { name: 'GC content', values: out }
}

/** Features per bin, over the ticked sequences, in the order the index gives. */
function densityOf(
  job: JobContext,
  set: FeatureSet,
  selection: Selection,
  index: Int32Array,
): Float64Array {
  const perBin = new Float64Array(job.mc.nBins)
  for (const cid of selection.contigs) {
    const name = job.mc.chromnames[cid]
    const setContig = set.contigs.indexOf(name)
    if (setContig < 0) continue
    for (let i = 0; i < set.length; i++) {
      if (set.contig[i] !== setContig) continue
      // Every bin the feature covers, not only the one it starts in: a gene
      // spanning ten bins is evidence about ten bins, and counting only its
      // start would make density a picture of where genes begin.
      const first = job.mc.coords.binIndex(cid, set.start[i])
      const last = job.mc.coords.binIndex(cid, Math.max(set.start[i], set.end[i] - 1))
      for (let bin = first; bin <= last; bin++) {
        if (bin >= 0 && bin < perBin.length) perBin[bin] += 1
      }
    }
  }
  const out = new Float64Array(index.length)
  for (let i = 0; i < index.length; i++) out[i] = perBin[selection.bin[index[i]]]
  return out
}
