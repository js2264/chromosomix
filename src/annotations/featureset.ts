/**
 * Building and querying a {@link FeatureSet}.
 *
 * Two jobs, kept together because they are two halves of one contract: the
 * builder establishes the sort and the per-contig index, and the query relies on
 * exactly those. Splitting them would let one drift from the other, and the way
 * that failure presents — a long gene silently missing from a window it overlaps
 * — is invisible rather than loud.
 */

import type { FeatureSet, PairSet } from './types'

/** One feature as the parsers hand it over, before anything is sorted. */
interface Raw {
  contig: number
  start: number
  end: number
  strand: number
  score: number
  name: string
  detail: string
  exons: number[] | null
  cds: [number, number] | null
}

/**
 * Accumulates features in whatever order a file lists them, then sorts once.
 *
 * A file is not required to be sorted and most are only sorted by accident:
 * this Ensembl GTF opens on chromosome IV. Sorting here — once, in the worker,
 * at parse time — is what lets every later query be a binary search.
 */
export class FeatureBuilder {
  private readonly rows: Raw[] = []
  private readonly contigIds = new Map<string, number>()
  readonly contigs: string[] = []

  /** The id for a contig name, minting one on first sight. */
  contigId(name: string): number {
    const existing = this.contigIds.get(name)
    if (existing !== undefined) return existing
    const id = this.contigs.length
    this.contigIds.set(name, id)
    this.contigs.push(name)
    return id
  }

  add(
    contig: string,
    start: number,
    end: number,
    extra: {
      strand?: number
      score?: number
      name?: string
      detail?: string
      /** Flattened `[start, end, start, end, …]`, in file order. */
      exons?: number[]
      cds?: [number, number]
    } = {},
  ): void {
    // A zero-length feature is legal in BED and unpaintable: give it one base so
    // it has somewhere to be drawn rather than dropping a row the file asserts.
    const lo = Math.min(start, end)
    const hi = Math.max(lo + 1, Math.max(start, end))
    this.rows.push({
      contig: this.contigId(contig),
      start: lo,
      end: hi,
      strand: extra.strand ?? 0,
      score: extra.score ?? Number.NaN,
      name: extra.name ?? '',
      detail: extra.detail ?? '',
      exons: extra.exons ?? null,
      cds: extra.cds ?? null,
    })
  }

  get length(): number {
    return this.rows.length
  }

  /**
   * Sort, index, and flatten into typed arrays.
   *
   * The exons of one feature are sorted too. A GTF lists a minus-strand
   * transcript's exons in transcript order, which is descending in genomic
   * coordinates, and a renderer that joined consecutive pairs would draw the
   * introns as overlapping backwards spans.
   */
  finish(): FeatureSet {
    const rows = this.rows
    rows.sort((a, b) => (a.contig - b.contig) || (a.start - b.start) || (a.end - b.end))
    const n = rows.length
    const set: FeatureSet = {
      contigs: this.contigs,
      length: n,
      contig: new Int32Array(n),
      start: new Int32Array(n),
      end: new Int32Array(n),
      strand: new Int8Array(n),
      score: new Float32Array(n),
      name: new Array<string>(n),
      detail: new Array<string>(n),
      exonAt: new Int32Array(n + 1),
      exonStart: new Int32Array(0),
      exonEnd: new Int32Array(0),
      cdsStart: new Int32Array(n),
      cdsEnd: new Int32Array(n),
      contigAt: new Int32Array(this.contigs.length + 1),
      maxSpan: new Int32Array(this.contigs.length),
    }

    let exonTotal = 0
    for (const row of rows) exonTotal += row.exons === null ? 0 : row.exons.length >> 1
    set.exonStart = new Int32Array(exonTotal)
    set.exonEnd = new Int32Array(exonTotal)

    let exonCursor = 0
    for (let i = 0; i < n; i++) {
      const row = rows[i]
      set.contig[i] = row.contig
      set.start[i] = row.start
      set.end[i] = row.end
      set.strand[i] = row.strand
      set.score[i] = row.score
      set.name[i] = row.name
      set.detail[i] = row.detail
      set.cdsStart[i] = row.cds === null ? -1 : row.cds[0]
      set.cdsEnd[i] = row.cds === null ? -1 : row.cds[1]
      set.exonAt[i] = exonCursor
      if (row.exons !== null) {
        const pairs: Array<[number, number]> = []
        for (let k = 0; k + 1 < row.exons.length; k += 2) pairs.push([row.exons[k], row.exons[k + 1]])
        pairs.sort((a, b) => a[0] - b[0])
        for (const [lo, hi] of pairs) {
          set.exonStart[exonCursor] = lo
          set.exonEnd[exonCursor] = hi
          exonCursor++
        }
      }
      const span = row.end - row.start
      if (span > set.maxSpan[row.contig]) set.maxSpan[row.contig] = span
    }
    set.exonAt[n] = exonCursor

    // Half-open run per contig. Written by counting forward rather than by
    // searching, because the rows are already grouped by the sort above.
    let cursor = 0
    for (let c = 0; c < this.contigs.length; c++) {
      set.contigAt[c] = cursor
      while (cursor < n && set.contig[cursor] === c) cursor++
    }
    set.contigAt[this.contigs.length] = cursor
    return set
  }
}

/** The contig's index in this set, or `-1` when the file never mentions it. */
export function contigIndexOf(set: { contigs: string[] }, name: string): number {
  return set.contigs.indexOf(name)
}

/**
 * The half-open index range worth *examining* for features overlapping
 * `[lo, hi)` on `contig`.
 *
 * Not the answer — the answer is whichever of those rows actually overlaps, and
 * the caller tests that as it draws. The rows are sorted by `start`, so a
 * feature can begin before `lo` and still end inside the window; backing the
 * lower bound off by the contig's longest feature is what makes the range a
 * superset rather than a plausible-looking undercount.
 */
export function featureRange(
  set: FeatureSet,
  contig: number,
  lo: number,
  hi: number,
): [number, number] {
  if (contig < 0 || contig >= set.contigs.length) return [0, 0]
  const from = set.contigAt[contig]
  const to = set.contigAt[contig + 1]
  if (to <= from) return [0, 0]
  const back = set.maxSpan[contig]
  const first = lowerBound(set.start, from, to, lo - back)
  const last = lowerBound(set.start, from, to, hi)
  return [first, last]
}

/** First index in `[from, to)` whose value is `>= target`, else `to`. */
function lowerBound(values: Int32Array, from: number, to: number, target: number): number {
  let low = from
  let high = to
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid] >= target) high = mid
    else low = mid + 1
  }
  return low
}

/** An empty set, for a file that parsed cleanly and held nothing. */
export function emptyFeatureSet(): FeatureSet {
  return new FeatureBuilder().finish()
}

/**
 * The names in a set that a map has never heard of, and the other way round.
 *
 * Spec §8.2: an overlap of zero has to be *said*, because it looks exactly like
 * a broken feature. Both directions are reported — a GTF using `chrI` against a
 * map using `I` is a naming mismatch, a GTF covering only chromosome I against
 * a whole-genome map is a partial annotation, and the two want different fixes.
 */
export function overlapWith(
  fileContigs: readonly string[],
  mapContigs: readonly string[],
  sample = 4,
): { matched: number; total: number; missing: string[]; extra: string[] } {
  const inFile = new Set(fileContigs)
  const inMap = new Set(mapContigs)
  const missing = mapContigs.filter((name) => !inFile.has(name))
  const extra = fileContigs.filter((name) => !inMap.has(name))
  return {
    matched: mapContigs.length - missing.length,
    total: mapContigs.length,
    missing: missing.slice(0, sample),
    extra: extra.slice(0, sample),
  }
}

/** Accumulates pairs; the bedpe counterpart of {@link FeatureBuilder}. */
export class PairBuilder {
  private readonly rows: Array<{
    c1: number
    s1: number
    e1: number
    c2: number
    s2: number
    e2: number
    score: number
    name: string
    detail: string
  }> = []
  private readonly contigIds = new Map<string, number>()
  readonly contigs: string[] = []

  contigId(name: string): number {
    const existing = this.contigIds.get(name)
    if (existing !== undefined) return existing
    const id = this.contigs.length
    this.contigIds.set(name, id)
    this.contigs.push(name)
    return id
  }

  add(
    contig1: string,
    start1: number,
    end1: number,
    contig2: string,
    start2: number,
    end2: number,
    extra: { score?: number; name?: string; detail?: string } = {},
  ): void {
    this.rows.push({
      c1: this.contigId(contig1),
      s1: start1,
      e1: Math.max(start1 + 1, end1),
      c2: this.contigId(contig2),
      s2: start2,
      e2: Math.max(start2 + 1, end2),
      score: extra.score ?? Number.NaN,
      name: extra.name ?? '',
      detail: extra.detail ?? '',
    })
  }

  get length(): number {
    return this.rows.length
  }

  finish(): PairSet {
    const n = this.rows.length
    const set: PairSet = {
      contigs: this.contigs,
      length: n,
      contig1: new Int32Array(n),
      start1: new Int32Array(n),
      end1: new Int32Array(n),
      contig2: new Int32Array(n),
      start2: new Int32Array(n),
      end2: new Int32Array(n),
      score: new Float32Array(n),
      name: new Array<string>(n),
      detail: new Array<string>(n),
    }
    for (let i = 0; i < n; i++) {
      const row = this.rows[i]
      set.contig1[i] = row.c1
      set.start1[i] = row.s1
      set.end1[i] = row.e1
      set.contig2[i] = row.c2
      set.start2[i] = row.s2
      set.end2[i] = row.e2
      set.score[i] = row.score
      set.name[i] = row.name
      set.detail[i] = row.detail
    }
    return set
  }
}
