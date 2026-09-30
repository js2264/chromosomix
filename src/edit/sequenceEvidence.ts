/**
 * Evidence beyond the map, from the sequence (SPECS §27.5): what the session's
 * FASTA or `.2bit` says about the assembly an edit is made on — which ends of
 * its sequences carry **telomeric repeats**, and where inside them the
 * assembler left **gaps of `N`**.
 *
 * A telomere is the end of a chromosome: a join that would bury one is a join no
 * curator takes, and a sequence with one at each end is a chromosome already.
 * A gap of `N` is where the assembler stopped being sure, and a break the map
 * finds beside one is placed at it, to the base.
 *
 * Read once per stage, through the same ranged reads the FASTA export uses:
 * each sequence's two terminal kilobases, and — for an assembly small enough to
 * read whole in a few seconds — every base, for its gaps.
 */

import type { ReadBases } from './lifted'

/** Bases read at each end of a sequence for its telomere. */
export const TELOMERE_SPAN = 1000

/** The fewest `N` in a row that are a gap the assembler left. */
export const LEAST_GAP = 10

/** An assembly read whole for its gaps only up to this many bases. */
export const GAPS_READ_UP_TO = 100_000_000

/** What the sequence says about one original sequence. */
export interface SequenceFacts {
  /** Its length, in base pairs: which base is its last. */
  length: number
  /** The telomeric repeat at its start and its end, by family, or `null`. */
  start: string | null
  end: string | null
  /** Runs of at least {@link LEAST_GAP} `N`, 0-based half-open. */
  gaps: Array<[number, number]>
}

/** What the sequence says about the assembly, by original sequence. */
export interface SequenceEvidence {
  /** The sequence track it was read from. */
  from: string
  facts: Map<string, SequenceFacts>
  /** Whether every base was read, so that no gap listed means none there. */
  gapsRead: boolean
}

/** The repeat families looked for, each a tandem unit read on either strand. */
const MOTIFS: Array<{ family: string; unit: string }> = [
  { family: 'TTAGGG', unit: 'TTAGGG' },
  { family: 'TTTAGGG', unit: 'TTTAGGG' },
  { family: 'TTAGG', unit: 'TTAGG' },
  { family: 'TTGGGG', unit: 'TTGGGG' },
]

function complementOf(unit: string): string {
  const pairs: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' }
  return [...unit].reverse().map((base) => pairs[base] ?? base).join('')
}

/** The share of a window's bases covered by tandem copies of `unit`, in any phase. */
function tandemShare(text: string, unit: string): number {
  if (text.length === 0) return 0
  let covered = 0
  let i = 0
  while (i + unit.length <= text.length) {
    // The unit in any rotation starting here.
    let hit = false
    for (let r = 0; r < unit.length && !hit; r++) {
      const rotated = unit.slice(r) + unit.slice(0, r)
      if (text.startsWith(rotated, i)) hit = true
    }
    if (hit) {
      covered += unit.length
      i += unit.length
    } else {
      i++
    }
  }
  return covered / text.length
}

/** Bases a telomere is read in, from the end inwards. */
const TELOMERE_CHUNK = 50

/** The fewest bases of repeat that are a telomere. */
const LEAST_TELOMERE = 100

/**
 * The repeat family a stretch of bases is, or `null`:
 *
 * - the canonical tandem repeats — `TTAGGG` (vertebrates, most fungi and
 *   protists), `TTTAGGG` (plants), `TTAGG` (insects), `TTGGGG` (ciliates) — on
 *   either strand, covering half of it, the family covering most: a plant's
 *   `TTTAGGG` holds `TTAGGG` in six of its seven bases;
 * - and the irregular `TG₁₋₃` of budding yeasts, which is no fixed unit: nine
 *   in ten of its bases `T` and `G` on one strand, a third or more of them `G`
 *   — not a run of `T`, which is poly-A read backwards.
 */
function repeatOf(text: string): string | null {
  let best: string | null = null
  let bestShare = 0.5
  for (const { family, unit } of MOTIFS) {
    const share = Math.max(tandemShare(text, unit), tandemShare(text, complementOf(unit)))
    if (share > bestShare) {
      best = family
      bestShare = share
    }
  }
  if (best !== null) return best
  let tg = 0
  let g = 0
  let ca = 0
  let c = 0
  for (const base of text) {
    if (base === 'T' || base === 'G') tg++
    if (base === 'G') g++
    if (base === 'C' || base === 'A') ca++
    if (base === 'C') c++
  }
  const n = text.length
  return (tg >= 0.9 * n && g >= 0.33 * n) || (ca >= 0.9 * n && c >= 0.33 * n) ? 'TG1-3' : null
}

/**
 * The telomeric repeat at one end of a sequence, or `null`: its terminal
 * bases read from the end inwards, fifty at a time, for an unbroken run of one
 * of the repeats {@link repeatOf} knows, at least a hundred bases long and
 * starting within the outermost hundred — a yeast's telomere is some 300 bases,
 * an assembly often keeps less of it, and a read's last bases are sometimes
 * not its own. The run's commonest family is the answer.
 *
 * `bases` are the end's own, outermost first or last as `side` says.
 */
export function telomereAt(bases: Uint8Array, side: 'start' | 'end'): string | null {
  const text = new TextDecoder().decode(bases).toUpperCase()
  const chunks = Math.floor(Math.min(text.length, TELOMERE_SPAN) / TELOMERE_CHUNK)
  const families = new Map<string, number>()
  let run = 0
  for (let k = 0; k < chunks; k++) {
    const from = side === 'start' ? k * TELOMERE_CHUNK : text.length - (k + 1) * TELOMERE_CHUNK
    const family = repeatOf(text.slice(from, from + TELOMERE_CHUNK))
    if (family !== null) {
      run++
      families.set(family, (families.get(family) ?? 0) + 1)
    } else if (run > 0 || (k + 1) * TELOMERE_CHUNK >= LEAST_TELOMERE) break
  }
  if (run * TELOMERE_CHUNK < LEAST_TELOMERE) return null
  return [...families].sort((a, b) => b[1] - a[1])[0][0]
}

/** Runs of at least `least` `N` (or `n`) in some bases, offset to where they lie. */
export function gapsIn(bases: Uint8Array, offset = 0, least = LEAST_GAP): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let run = -1
  for (let i = 0; i <= bases.length; i++) {
    const isN = i < bases.length && (bases[i] === 78 || bases[i] === 110)
    if (isN && run < 0) run = i
    if (!isN && run >= 0) {
      if (i - run >= least) out.push([offset + run, offset + i])
      run = -1
    }
  }
  return out
}

/** The most bases asked for at once. */
const CHUNK = 400_000

/**
 * What the sequence says about an assembly: each sequence's two ends read for
 * a telomere, and — where the whole assembly is at most
 * {@link GAPS_READ_UP_TO} bases — every base for its gaps. A sequence the file
 * does not have says nothing.
 *
 * @returns `null` where `cancelled` said so.
 */
export async function readSequenceEvidence(
  from: string,
  names: readonly string[],
  lengths: readonly number[],
  read: ReadBases,
  options: { cancelled?: () => boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<SequenceEvidence | null> {
  const facts = new Map<string, SequenceFacts>()
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const gapsRead = total <= GAPS_READ_UP_TO
  let done = 0
  for (let s = 0; s < names.length; s++) {
    if (options.cancelled?.() === true) return null
    const name = names[s]
    const length = lengths[s]
    const span = Math.min(TELOMERE_SPAN, length)
    const head = await read(name, 0, span)
    if (head === null) continue
    const tail = length <= span ? head : await read(name, length - span, length)
    const gaps: Array<[number, number]> = []
    if (gapsRead) {
      // Chunks overlap by a gap's least length, so a run across a boundary is
      // found once, whole: a run is kept where it starts in the chunk's own part.
      for (let at = 0; at < length; at += CHUNK) {
        const end = Math.min(length, at + CHUNK + LEAST_GAP)
        const bases = at === 0 && end <= span ? head : await read(name, at, end)
        if (bases === null) break
        for (const run of gapsIn(bases, at)) {
          const last = gaps[gaps.length - 1]
          if (last !== undefined && run[0] <= last[1]) last[1] = Math.max(last[1], run[1])
          else gaps.push(run)
        }
        done += Math.min(CHUNK, length - at)
        options.onProgress?.(done, total)
      }
    }
    facts.set(name, { length, start: telomereAt(head, 'start'), end: tail === null ? null : telomereAt(tail, 'end'), gaps })
  }
  return { from, facts, gapsRead }
}
