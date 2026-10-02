/**
 * Whether a sequence joins its own ends, read off its contacts.
 *
 * §8.15 argued that nobody can infer it from the data, and the argument was
 * about the wrong test. A **bright far corner** is not evidence — a
 * translocation, an assembly error and arms zipped end to end all make one. The
 * test that separates them is the shape of the corner at its very tip: on a
 * circle the last bin and the first are **neighbours**, so the cells joining
 * them hold what the diagonal holds at the same separation — a few bins apart,
 * the most contacts there are. Anything else that brightens a corner brightens
 * it by a factor, not to the level of the diagonal itself.
 *
 * So the score is the contacts across the junction at a circular separation of
 * `s` bins, over the contacts along the diagonal at the same `s`, measured at the
 * two ends the junction joins, for `s = 1 … k` — and its median over at least two
 * of them, each with contacts at both ends, so one noisy cell does not decide.
 * About one on a circle (0.65 on the *Pseudomonas aeruginosa* PAK chromosome,
 * 1.1 on a *Borrelia* circular plasmid), about zero on a line (under 0.03 on the
 * linear chromosomes of *Borrelia burgdorferi* and *Streptomyces coelicolor*,
 * whose telomeres are known to meet).
 *
 * Pure: three small blocks in, one number out — and, for a whole map, the
 * blocks read through whichever host holds it.
 */

/** Separations, in bins, the junction is compared at. */
export const JUNCTION_BINS = 3

/**
 * The fewest bins a sequence needs, at the rung it is read at, for the test to
 * mean anything.
 *
 * On a line of `n` bins the cells joining its ends are `n − s` bins apart, so
 * the junction reads as a line's only where that is far down the decay — and a
 * few dozen bins can fall short of it, where contacts flatten out across a
 * chromosome's territory or its two ends are held together, as clustered
 * telomeres are. Over thirty-two maps, linear chromosomes read with 12 to 49
 * bins scored up to 0.9 (yeast chromosome I at 16 kb, six mouse chromosomes at
 * 2.56 Mb); with {@link junctionQuorum}'s two separations, none read with fifty
 * or more reached 0.2. It is half the {@link JUNCTION_TARGET_BINS} the session
 * measures at wherever the ladder lets it, so it binds only where the rung read
 * gives a sequence fewer than fifty bins — a file opened coarsely, or a short
 * sequence — and what it costs is a small circle read there, left undecided
 * rather than ticked: the yeast mitochondrion is 43 bins at 2 kb.
 */
export const MIN_JUNCTION_SEQUENCE_BINS = 50

/** At or above this the sequence is read as circular. */
export const CIRCULAR_SCORE = 0.2

/** A dense block of the sequence, in its own bins, 0-based. */
export interface JunctionBlock {
  rows: [number, number]
  cols: [number, number]
  values: ArrayLike<number>
}

/**
 * The fewest separations a score is decided on: more than half of the `k`
 * compared — two of the three — so the median is never one cell's.
 */
export function junctionQuorum(k = JUNCTION_BINS): number {
  return Math.floor(k / 2) + 1
}

/**
 * The junction score, from the three blocks the test needs.
 *
 * - `head`: rows and columns `[0, 2k)` — the diagonal at the start;
 * - `tail`: rows and columns `[n − 2k, n)` — the diagonal at the end;
 * - `corner`: rows `[0, k)` against columns `[n − k, n)` — the cells joining them,
 *   whose circular separation is `row + n − col`.
 *
 * A separation is compared only where all three hold something at it: a
 * junction cell the balancer kept, and contacts on the diagonal at **each** end
 * — the junction joins the two ends, so it is held against both ends' diagonal,
 * never against one end's alone. And the score needs {@link junctionQuorum}
 * such separations. A median of three was meant to keep one noisy cell from
 * deciding, and stopped doing so once ends went missing: on chrY of a mouse map
 * at 640 kb the balancer had dropped the last two bins, one junction cell was
 * left — one read pair, beside an end whose own diagonal held nothing at that
 * separation — and its ratio of 0.41 was the median of itself.
 *
 * `NaN` where fewer separations than that can be compared — a balancer-dropped
 * end, an end with nothing on its diagonal, a sequence too short — which the
 * caller reads as *undecided*, never as linear.
 */
export function junctionScore(
  n: number,
  head: JunctionBlock,
  tail: JunctionBlock,
  corner: JunctionBlock,
  k = JUNCTION_BINS,
): { score: number; ratios: number[] } {
  /** The diagonal of one end's block, summed and counted by separation. */
  const diagonal = (block: JunctionBlock): { sum: Float64Array; count: Float64Array } => {
    const sum = new Float64Array(k + 1)
    const count = new Float64Array(k + 1)
    const width = block.cols[1] - block.cols[0]
    for (let r = block.rows[0]; r < block.rows[1]; r++) {
      for (let c = block.cols[0]; c < block.cols[1]; c++) {
        const s = c - r
        if (s < 1 || s > k) continue
        const value = block.values[(r - block.rows[0]) * width + (c - block.cols[0])]
        if (!Number.isFinite(value)) continue
        sum[s] += value
        count[s] += 1
      }
    }
    return { sum, count }
  }
  const ends = [diagonal(head), diagonal(tail)]
  const junctionSum = new Float64Array(k + 1)
  const junctionCount = new Float64Array(k + 1)
  const width = corner.cols[1] - corner.cols[0]
  for (let r = corner.rows[0]; r < corner.rows[1]; r++) {
    for (let c = corner.cols[0]; c < corner.cols[1]; c++) {
      const s = r + n - c
      if (s < 1 || s > k) continue
      const value = corner.values[(r - corner.rows[0]) * width + (c - corner.cols[0])]
      if (!Number.isFinite(value)) continue
      junctionSum[s] += value
      junctionCount[s] += 1
    }
  }
  const ratios: number[] = []
  for (let s = 1; s <= k; s++) {
    if (junctionCount[s] === 0) continue
    if (!ends.every((end) => end.count[s] > 0 && end.sum[s] > 0)) continue
    const along = (ends[0].sum[s] + ends[1].sum[s]) / (ends[0].count[s] + ends[1].count[s])
    ratios.push(junctionSum[s] / junctionCount[s] / along)
  }
  if (ratios.length < junctionQuorum(k)) return { score: Number.NaN, ratios }
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const score = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return { score, ratios }
}

/**
 * How many sequences the test measures, longest first.
 *
 * A declaration is about a chromosome or a plasmid, and those are the longest
 * sequences of any assembly; a draft's ten-thousandth contig is not a molecule
 * anybody declares round, and three reads for each would be a burst of range
 * requests on every open of one.
 */
export const CIRCULAR_DETECTION_LIMIT = 50

/** A sequence the test is run on: its first bin on the map, and how many it has. */
export interface JunctionCandidate {
  name: string
  from: number
  n: number
}

/**
 * The sequences worth measuring, from each one's name and length on a grid of
 * `binsize`: long enough for the test to mean anything, the longest first, at
 * most `limit` of them.
 *
 * Each one's first bin and count are cooler's convention, `ceil(length /
 * binsize)` a sequence, which not every file's levels keep — see
 * {@link placeCandidate}, which a caller reading the map puts each one through.
 */
export function junctionCandidates(
  pairs: ReadonlyArray<readonly [string, number]>,
  binsize: number,
  limit = CIRCULAR_DETECTION_LIMIT,
): JunctionCandidate[] {
  const candidates: JunctionCandidate[] = []
  let startBin = 0
  for (const [name, length] of pairs) {
    const n = Math.ceil(length / binsize)
    if (n >= MIN_JUNCTION_SEQUENCE_BINS) candidates.push({ name, from: startBin, n })
    startBin += n
  }
  candidates.sort((a, b) => b.n - a.n)
  return candidates.slice(0, limit)
}

/**
 * A candidate where the file puts it: its first bin and its count as the
 * reader's own table has them, or `null` where that leaves it short of
 * {@link MIN_JUNCTION_SEQUENCE_BINS}.
 *
 * A level written by flooring each sequence's last part-bin into the bin before
 * it has one bin fewer than `ceil(length / binsize)` for every sequence that does
 * not end on a bin, so a first bin summed from that rule drifts a bin further
 * with each sequence before it. On the yeast and *M. pneumoniae* demo at 2 kb
 * the mitochondrion's was five bins out — its tail and its corner were read
 * from the next sequence — and it scored 0; seven of thirty-two maps tried have
 * levels written that way.
 */
export function placeCandidate(
  candidate: JunctionCandidate,
  extent: readonly [number, number],
): JunctionCandidate | null {
  const n = extent[1] - extent[0]
  return n >= MIN_JUNCTION_SEQUENCE_BINS ? { name: candidate.name, from: extent[0], n } : null
}

/**
 * The bins a sequence is measured on where the file's ladder lets it be — see
 * {@link junctionRung}.
 */
export const JUNCTION_TARGET_BINS = 100

/**
 * The bin size to measure one sequence's junction at: the coarsest of `rungs`,
 * no finer than the one open, that still gives it {@link JUNCTION_TARGET_BINS}
 * bins; the open one where none does.
 *
 * The test reads six bins at each end and three at the corner, so what it
 * costs is never the pixels. It is what reading any window at a rung costs —
 * that rung's index, its weights for the sequence, a block — and at a fine rung
 * of a large file that is megabytes a read: on a 5 GB 4DN map opened at 1 kb,
 * 111 MiB for three reads on each of 21 chromosomes. The score is a ratio of
 * the junction to the diagonal at the same separation, so it does not depend
 * on the bin size so long as the ends are a small part of the sequence, which a
 * hundred bins is. A short sequence keeps the rung it was opened at, where it
 * has the bins it has.
 */
export function junctionRung(length: number, open: number, rungs: readonly number[]): number {
  let best = open
  for (const rung of rungs) {
    if (rung > best && Math.ceil(length / rung) >= JUNCTION_TARGET_BINS) best = rung
  }
  return best
}

/** A dense block of the whole map, by bins of the whole map: what a host reads the test through. */
export type JunctionReader = (rows: [number, number], cols: [number, number]) => Promise<ArrayLike<number>>

/**
 * The test over each candidate: its score where it could be decided, and the
 * sequences at or above {@link CIRCULAR_SCORE}. Three reads a sequence — the
 * diagonal at each end and the corner joining them — through whichever host
 * holds the map: the session's reader worker on a first open, the file itself
 * in `metacooler-run circular`. `null` when `alive` says the answer is no
 * longer wanted.
 */
export async function measureJunctions(
  candidates: readonly JunctionCandidate[],
  read: JunctionReader,
  alive: () => boolean = () => true,
  k = JUNCTION_BINS,
): Promise<{ scores: Record<string, number>; circular: string[] } | null> {
  const scores: Record<string, number> = {}
  const circular: string[] = []
  for (const { name, from, n } of candidates) {
    const local = async (rows: [number, number], cols: [number, number]): Promise<JunctionBlock> => ({
      rows: [rows[0] - from, rows[1] - from],
      cols: [cols[0] - from, cols[1] - from],
      values: await read(rows, cols),
    })
    const head = await local([from, from + 2 * k], [from, from + 2 * k])
    const tail = await local([from + n - 2 * k, from + n], [from + n - 2 * k, from + n])
    const corner = await local([from, from + k], [from + n - k, from + n])
    if (!alive()) return null
    const { score } = junctionScore(n, head, tail, corner, k)
    if (!Number.isFinite(score)) continue
    scores[name] = score
    if (score >= CIRCULAR_SCORE) circular.push(name)
  }
  return { scores, circular }
}
