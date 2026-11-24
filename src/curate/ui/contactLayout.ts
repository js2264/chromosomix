/**
 * The contact map's arithmetic (SPECS §33.3), apart from its canvas: which
 * genome each row of the map is, what a cell holds, the cells the review's
 * question marks and the number it wears, the close-up's contigs and the spans
 * they make, the contigs a suggestion would bring into a close-up, where a
 * framed run puts the view, and the words and ticks its readout and key print —
 * each where the names over it leave room.
 *
 * **One uniform cell a genome**, in the stage's order — MAGs, then elements,
 * never the pool (§7.4): a length axis would spend itself on the long genomes.
 * A cell is the **lower bound** of the two genomes' affinity, so a cell resting
 * on a read pair or two is pale whatever its ratio; the diagonal is a genome's
 * own density, 1 by definition. The bytes are drawn by `edit/paint.ts` as the
 * reference stage's picture is, and every number the readout prints comes from
 * the answer's floats, never from a byte.
 *
 * Pure: arrays in, arrays out, so the pane's logic is tested without a canvas.
 */

import type { CurationStep, GenomeKind } from '../../genome/curation'
import { encode, pyramid, triangleIndex, triangleSize, type PictureLevel, type Quantizer } from '../../metacooler/picture'
import { lowerAffinity } from '../method'
import type { GenomePairs, Suggestion } from '../suggest'

/** The affinity at the scale's top byte: past it, every cell is the darkest. */
export const AFFINITY_CEILING = 3
/** Where the colours stop deepening: twice as densely as a genome meets itself. */
export const AFFINITY_SATURATES = 2
/** The background the scale opens at before the contacts are read (the mock community's is 0.024). */
export const FALLBACK_BACKGROUND = 0.02
/** The most candidates a close-up adds after the genomes it shows. */
export const CANDIDATES_MOST = 200

// ---------------------------------------------------------------------------
// The genome map.
// ---------------------------------------------------------------------------

/** The map's axis: a slot a genome, MAGs then elements. */
export interface GenomeAxis {
  /** Each slot's genome, as an index of the answer's genomes. */
  genomes: Int32Array
  /** Each genome's slot, `-1` for none. */
  slotOf: Int32Array
  /** How many MAGs lead the axis: where the elements' section begins. */
  mags: number
}

/**
 * The genomes in the stage's order: the ids `order` gives, MAGs ahead of the
 * elements whatever their place in it, and a genome the order does not know
 * yet — one a previewed step would create — after the others of its kind.
 */
export function genomeAxis(genomes: ReadonlyArray<{ id: string; kind: GenomeKind }>, order: readonly string[]): GenomeAxis {
  const index = new Map<string, number>()
  genomes.forEach((genome, g) => index.set(genome.id, g))
  const placed = new Uint8Array(genomes.length)
  const mags: number[] = []
  const elements: number[] = []
  for (const id of order) {
    const g = index.get(id)
    if (g === undefined || placed[g] === 1) continue
    placed[g] = 1
    ;(genomes[g].kind === 'mag' ? mags : elements).push(g)
  }
  genomes.forEach((genome, g) => {
    if (placed[g] === 0) (genome.kind === 'mag' ? mags : elements).push(g)
  })
  const slots = Int32Array.from([...mags, ...elements])
  const slotOf = new Int32Array(genomes.length).fill(-1)
  slots.forEach((g, s) => (slotOf[g] = s))
  return { genomes: slots, slotOf, mags: mags.length }
}

/** The genome map's picture: a byte a pair of slots, and how to read it back. */
export interface GenomeMap {
  /** Slots a side. */
  n: number
  /** The picture, and the pyramid of means over it past 256 genomes. */
  levels: PictureLevel[]
  /** What a byte stands for, in base-10 logs of affinity. */
  q: Quantizer
  /** The colour scale: the background at its foot, twice its own density at its top. */
  vmin: number
  vmax: number
  /** The background it was scaled by. */
  background: number
  /** A pair's place in the answer's pairs, keyed `a · genomes + b`, `a < b`. */
  pairs: Map<number, number>
}

/**
 * The genome map: each pair the answer holds at the lower bound of its
 * affinity, each genome's own cell at 1, in the axis's slots. Before the
 * contacts are read (`counted` false) the picture is empty.
 */
export function genomeMap(
  answer: { genomes: ArrayLike<unknown>; pairs: GenomePairs; counted: boolean },
  axis: GenomeAxis,
  background: number | null,
): GenomeMap {
  const rho = background !== null && background > 0 ? background : FALLBACK_BACKGROUND
  const q: Quantizer = { low: Math.log10(rho) - 1, high: Math.log10(AFFINITY_CEILING) }
  const n = axis.genomes.length
  const cells = new Uint8Array(triangleSize(n))
  const pairs = new Map<number, number>()
  const genomes = answer.genomes.length
  const { a, b, contacts, affinity } = answer.pairs
  for (let k = 0; k < a.length; k++) pairs.set(Math.min(a[k], b[k]) * genomes + Math.max(a[k], b[k]), k)
  if (answer.counted) {
    const own = encode(1, q)
    for (let s = 0; s < n; s++) cells[triangleIndex(s, s, n)] = own
    for (let k = 0; k < a.length; k++) {
      const sa = axis.slotOf[a[k]] ?? -1
      const sb = axis.slotOf[b[k]] ?? -1
      if (sa < 0 || sb < 0) continue
      const lower = lowerAffinity(affinity[k], contacts[k])
      cells[sa <= sb ? triangleIndex(sa, sb, n) : triangleIndex(sb, sa, n)] = encode(lower, q)
    }
  }
  return {
    n,
    levels: n > 0 ? pyramid({ n, cells }, q) : [],
    q,
    vmin: Math.log10(rho),
    vmax: Math.log10(AFFINITY_SATURATES),
    background: rho,
    pairs,
  }
}

/** Where the pair of genomes `a`, `b` is in the answer's pairs; `-1` for none. */
export function pairOf(map: GenomeMap, genomes: number, a: number, b: number): number {
  if (a === b) return -1
  return map.pairs.get(Math.min(a, b) * genomes + Math.max(a, b)) ?? -1
}

// ---------------------------------------------------------------------------
// The review's question.
// ---------------------------------------------------------------------------

/** A suggestion, or a question of several (`curate/questions.ts`): its members, when it has them. */
type Asked = Suggestion & { members?: readonly Suggestion[] }

/** A cell a question marks on the genome map: two genomes, as indices of the answer's, and the mark. */
export interface MarkedPair {
  kind: 'merge' | 'link' | 'unlink'
  a: number
  b: number
}

/**
 * The cells a suggestion, or a question whole, marks on the genome map: a
 * merge's every pair among its genomes — an organism's fragments are one
 * question, so each block they would join is marked —, a host question's
 * every member at its own pair with its own mark (a link, an unlink); none for
 * a recruit or a move, which outline the genome they bring contigs into.
 */
export function markedPairs(s: Asked): MarkedPair[] {
  if (s.kind === 'merge') {
    const genomes = [...new Set(s.genomes)].filter((g) => g >= 0)
    const out: MarkedPair[] = []
    for (let i = 0; i < genomes.length; i++) for (let j = i + 1; j < genomes.length; j++) out.push({ kind: 'merge', a: genomes[i], b: genomes[j] })
    return out
  }
  if (s.kind !== 'link' && s.kind !== 'unlink') return []
  const out: MarkedPair[] = []
  const seen = new Set<string>()
  for (const member of s.members ?? [s]) {
    if (member.kind !== 'link' && member.kind !== 'unlink') continue
    const [a, b] = member.genomes
    if (a === undefined || b === undefined || a < 0 || b < 0) continue
    const key = `${member.kind}:${Math.min(a, b)}:${Math.max(a, b)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: member.kind, a, b })
  }
  return out
}

/**
 * A question's number as the review's band and the suggestions card print it
 * — the likely ones from 1, the less sure from 1 again — found by its key or a
 * member's (a member stepped into wears its question's); `null` for one the
 * queue does not hold.
 */
export function questionNumber(
  queue: ReadonlyArray<{ key: string; confidence: number; members: ReadonlyArray<{ key: string }> }>,
  key: string,
  likely: number,
): number | null {
  let at = queue.findIndex((q) => q.key === key)
  if (at < 0) at = queue.findIndex((q) => q.members.some((m) => m.key === key))
  if (at < 0) return null
  const first = queue.filter((q) => q.confidence >= likely).length
  return at < first ? at + 1 : at - first + 1
}

/**
 * The genomes previewed steps make or change, by id: where the binning as it
 * would be differs — a merge's survivor, the genome contigs move to, a new one,
 * a genome retyped or renamed, both ends of a link. A dissolved genome leaves
 * none: it is gone.
 */
export function stepTargets(steps: readonly CurationStep[]): string[] {
  const out = new Set<string>()
  for (const step of steps) {
    switch (step.op) {
      case 'move':
        if (step.to !== null) out.add(step.to)
        break
      case 'create':
        out.add(step.id)
        break
      case 'merge':
        out.add(step.into)
        break
      case 'retype':
      case 'rename':
        out.add(step.genome)
        break
      case 'link':
      case 'unlink':
        out.add(step.element)
        out.add(step.mag)
        break
      case 'dissolve':
        break
    }
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// The close-up.
// ---------------------------------------------------------------------------

/** A run of the close-up's axis: one genome's contigs, or the candidates (`id` null). */
export interface Span {
  id: string | null
  from: number
  to: number
}

/** The close-up's axis: a contig a unit, and the spans they make. */
export interface CloseUpAxis {
  /** Each unit's contig, as an index of the file's. */
  contigs: Int32Array
  spans: Span[]
}

/**
 * The close-up's contigs: each genome's in turn, in the order given, longest
 * first (ties in the file's order), then the candidates the binning has not
 * put in one of them, in the order given.
 */
export function closeUpAxis(
  binning: { genomeOf: ArrayLike<number>; genomes: ReadonlyArray<{ id: string }> },
  ids: readonly string[],
  lengths: ArrayLike<number>,
  candidates: readonly number[],
): CloseUpAxis {
  const wanted = new Map<number, number>()
  ids.forEach((id) => {
    const g = binning.genomes.findIndex((genome) => genome.id === id)
    if (g >= 0 && !wanted.has(g)) wanted.set(g, wanted.size)
  })
  const lists: number[][] = [...wanted.keys()].map(() => [])
  for (let c = 0; c < binning.genomeOf.length; c++) {
    const at = wanted.get(binning.genomeOf[c])
    if (at !== undefined) lists[at].push(c)
  }
  const units: number[] = []
  const spans: Span[] = []
  const order = [...wanted.entries()].sort((x, y) => x[1] - y[1])
  for (const [g, at] of order) {
    const list = lists[at].sort((x, y) => (lengths[y] ?? 0) - (lengths[x] ?? 0) || x - y)
    if (list.length === 0) continue
    spans.push({ id: binning.genomes[g].id, from: units.length, to: units.length + list.length })
    units.push(...list)
  }
  const placed = new Set(units)
  const from = units.length
  for (const c of candidates) {
    if (placed.has(c) || c < 0 || c >= binning.genomeOf.length) continue
    placed.add(c)
    units.push(c)
  }
  if (units.length > from) spans.push({ id: null, from, to: units.length })
  return { contigs: Int32Array.from(units), spans }
}

/**
 * The contigs an offered recruit or move would bring into one of `ids`, from
 * the pool or from another genome: the surest suggestion's first, at most
 * `most`.
 */
export function candidatesFor(
  answer: { genomeOf: ArrayLike<number>; genomes: ReadonlyArray<{ id: string }> },
  offered: readonly Suggestion[],
  ids: ReadonlySet<string>,
  most = CANDIDATES_MOST,
): number[] {
  const bringing = offered
    .filter((s) => (s.kind === 'recruit' || s.kind === 'move') && ids.has(answer.genomes[s.genomes[0]]?.id ?? ''))
    .sort((x, y) => y.confidence - x.confidence)
  const out: number[] = []
  const seen = new Set<number>()
  for (const s of bringing) {
    for (const c of s.contigs) {
      if (seen.has(c)) continue
      seen.add(c)
      const g = answer.genomeOf[c]
      if (g >= 0 && ids.has(answer.genomes[g]?.id ?? '')) continue
      out.push(c)
      if (out.length >= most) return out
    }
  }
  return out
}

/** The span holding unit `unit`, as an index of `spans`; `-1` outside them. */
export function spanAt(spans: readonly Span[], unit: number): number {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const span = spans[mid]
    if (unit < span.from) hi = mid - 1
    else if (unit >= span.to) lo = mid + 1
    else return mid
  }
  return -1
}

/** Each unit's place among the contigs a close-up's answer holds; `-1` where it holds none. */
export function cellMapOf(units: ArrayLike<number>, held: ArrayLike<number>): Int32Array {
  const at = new Map<number, number>()
  for (let k = 0; k < held.length; k++) if (!at.has(held[k])) at.set(held[k], k)
  return Int32Array.from({ length: units.length }, (_, u) => at.get(units[u]) ?? -1)
}

/** Whether a cell map reads the held picture in its own order: its pyramid then pools neighbours. */
export function isIdentity(map: ArrayLike<number>, n: number): boolean {
  if (map.length !== n) return false
  for (let u = 0; u < map.length; u++) if (map[u] !== u) return false
  return true
}

/** Whether two lists of contigs are the same, in the same order. */
export function sameUnits(a: ArrayLike<number> | null, b: ArrayLike<number> | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
  return true
}

/** Sorted units in runs of neighbours, `[from, to)` each: one outline a run. */
export function runsOf(units: Iterable<number>): Array<[number, number]> {
  const sorted = [...new Set(units)].filter((u) => u >= 0).sort((x, y) => x - y)
  const runs: Array<[number, number]> = []
  for (const u of sorted) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last[1] === u) last[1] = u + 1
    else runs.push([u, u + 1])
  }
  return runs
}

/** A contig's length as a share of the close-up's range, on a log scale: its block's height on the bar. */
export function lengthShare(length: number, least: number, most: number): number {
  if (!(length > 0) || !(most > least) || !(least > 0)) return 1
  return Math.max(0, Math.min(1, Math.log(length / least) / Math.log(most / least)))
}

// ---------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------

/** A view's start and end on one axis, kept inside `[0, n]` and no narrower than `least`. */
export function clampView(d0: number, d1: number, n: number, least: number): [number, number] {
  const whole = Math.max(n, 1e-9)
  const span = Math.min(whole, Math.max(Math.min(least, whole), d1 - d0))
  let start = d0
  if (start + span > whole) start = whole - span
  if (start < 0) start = 0
  return [start, start + span]
}

/**
 * A view centred on the run `[from, to)`: as wide as `span`, the view's width
 * now, or wider where the run and a little room either side need it.
 */
export function centredView(span: number, from: number, to: number, n: number, least: number): [number, number] {
  const wide = Math.min(n, Math.max(span, (to - from) * 1.3, least))
  const centre = (from + to) / 2
  return clampView(centre - wide / 2, centre + wide / 2, n, least)
}

// ---------------------------------------------------------------------------
// Words, and the key.
// ---------------------------------------------------------------------------

/** An affinity as the stage prints it: two significant figures below 1, two decimals from 1. */
export function affinityText(a: number): string {
  if (!Number.isFinite(a) || a <= 0) return '0'
  if (a >= 1) return a.toFixed(2)
  if (a < 1e-4) return a.toExponential(1)
  return a.toPrecision(2)
}

/** Observed over expected, as the close-up's readout prints it: `0.84×`, `3.2×`, `41×`. */
export function ratioText(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return '0×'
  if (r >= 10) return `${Math.round(r).toLocaleString('en-US')}×`
  if (r >= 1) return `${r.toFixed(1)}×`
  if (r < 1e-4) return `${r.toExponential(1)}×`
  return `${r.toPrecision(2)}×`
}

/** A tick of a key: where along the ramp (`0`–`1`), its value, and a word under it. */
export interface KeyTick {
  at: number
  label: string
  note?: string
}

/**
 * Where labels go along a line `total` long, each centred on its place as near
 * as the edges and the label before it allow, `gap` apart: the start of each,
 * or `null` for one that would stray more than `drift` from where it belongs
 * (or run off the end) and is left out. In the order given, which is left to
 * right.
 */
export function placeLabels(items: ReadonlyArray<{ at: number; width: number }>, total: number, gap: number, drift: number): Array<number | null> {
  let end = Number.NEGATIVE_INFINITY
  return items.map(({ at, width }) => {
    const ideal = Math.max(0, Math.min(total - width, at - width / 2))
    const from = Math.max(ideal, end + gap)
    if (from + width > total + 1e-9 || from - ideal > drift) return null
    end = from + width
    return from
  })
}

/**
 * Where a label `width` long goes along a stretch `[lo, hi]` without running
 * into what stands across it (`blocked`, intervals along the same line, as a
 * name's plate does over a section's label): its centre — `mid` where that is
 * clear, else the clear place nearest it, just past a blocked interval —, or
 * `null` where no place in the stretch is clear.
 */
export function clearPlace(mid: number, width: number, lo: number, hi: number, blocked: ReadonlyArray<readonly [number, number]>, gap = 4): number | null {
  const half = width / 2
  const fits = (c: number): boolean =>
    c - half >= lo - 1e-9 && c + half <= hi + 1e-9 && blocked.every(([b0, b1]) => c + half + gap <= b0 + 1e-9 || c - half - gap >= b1 - 1e-9)
  if (fits(mid)) return mid
  let best: number | null = null
  for (const [b0, b1] of blocked) {
    for (const c of [b0 - gap - half, b1 + gap + half]) {
      if (fits(c) && (best === null || Math.abs(c - mid) < Math.abs(best - mid))) best = c
    }
  }
  return best
}

/** Where a value sits along a ramp from `vmin` to `vmax`, base-10 logs both. */
function along(value: number, vmin: number, vmax: number): number {
  return (Math.log10(value) - vmin) / (vmax - vmin)
}

/** The genome map's key: the background, 0.1, and 1, *as its own*. */
export function affinityTicks(vmin: number, vmax: number, background: number): KeyTick[] {
  const ticks: KeyTick[] = [{ at: 0, label: affinityText(background), note: 'background' }]
  if (Math.log10(0.1) - vmin > 0.25 && 0.1 < 10 ** vmax) ticks.push({ at: along(0.1, vmin, vmax), label: '0.1' })
  if (vmax > 0) ticks.push({ at: along(1, vmin, vmax), label: '1', note: 'as its own' })
  return ticks.filter((tick) => tick.at >= 0 && tick.at <= 1)
}

/** The close-up's key: the background, then every decade of observed over expected up its range. */
export function ratioTicks(vmin: number, vmax: number, background: number): KeyTick[] {
  const ticks: KeyTick[] = []
  const start = background > 0 ? Math.log10(background) : vmin
  if (start >= vmin - 1e-9 && start <= vmax) ticks.push({ at: (start - vmin) / (vmax - vmin), label: affinityText(background), note: 'background' })
  for (let decade = Math.ceil(vmin); decade <= Math.floor(vmax); decade++) {
    if (decade - start < 0.3) continue
    const at = (decade - vmin) / (vmax - vmin)
    // A decade as it is written: `0.01`, `1`, `1,000`.
    const label = decade >= 0 ? (10 ** decade).toLocaleString('en-US') : String(Number((10 ** decade).toPrecision(1)))
    ticks.push({ at, label, note: decade === 0 ? 'as expected' : undefined })
  }
  return ticks
}
