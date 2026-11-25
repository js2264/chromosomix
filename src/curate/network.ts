/**
 * The contig network (SPECS §33.5): one pass over a map's stored pixels, summed
 * by pair of contigs — the raw counts between two contigs' bins, a pixel within
 * one contig kept apart as that contig's own.
 *
 * Raw counts, so nothing depends on a balancing the file may or may not carry;
 * each contact once, so a map that stores both triangles (`square`) gives what a
 * map that stores the upper one does. The pixels of a cooler are sorted by their
 * first bin, so a contig's rows arrive together: they are summed in a dense row
 * of the contigs they meet, emitted when the next contig's rows begin, and the
 * memory is the contigs and the pairs, never the pixels. A row that arrives out
 * of that order — a store read in another — is summed apart and merged at the end.
 */

import type { ContigNetwork } from './method'

export class NetworkBuilder {
  private readonly row: Float64Array
  private readonly touched: Int32Array
  private touchedCount = 0
  private current = -1
  private readonly first: number[] = []
  private readonly second: number[] = []
  private readonly contacts: number[] = []
  private readonly within: Float64Array
  /** Rows that came after a later one: summed apart, merged once. */
  private readonly late = new Map<number, number>()
  private done = new Uint8Array(0)
  /** Pixels read. */
  pixels = 0

  /**
   * @param binContig Each bin's contig, as an index of the file's.
   * @param contigs The number of contigs.
   */
  constructor(
    private readonly binContig: Int32Array,
    private readonly contigs: number,
  ) {
    this.row = new Float64Array(contigs)
    this.touched = new Int32Array(contigs)
    this.within = new Float64Array(contigs)
    this.done = new Uint8Array(contigs)
  }

  /** One chunk of pixels: parallel arrays, `length` of them used. */
  add(bin1: ArrayLike<number>, bin2: ArrayLike<number>, count: ArrayLike<number>, length: number): void {
    for (let k = 0; k < length; k++) {
      const b1 = bin1[k]
      const b2 = bin2[k]
      // Each contact once: the lower triangle of a square map repeats the upper.
      if (b2 < b1) continue
      const v = count[k]
      if (!(v > 0)) continue
      const i = this.binContig[b1]
      const j = this.binContig[b2]
      if (i < 0 || j < 0) continue
      this.pixels++
      if (i === j) {
        this.within[i] += v
        continue
      }
      const [a, b] = i < j ? [i, j] : [j, i]
      if (a !== this.current) {
        if (this.done[a] === 1 || a < this.current) {
          // A row this pass has already emitted, or passed: summed apart.
          const key = a * this.contigs + b
          this.late.set(key, (this.late.get(key) ?? 0) + v)
          continue
        }
        this.flush()
        this.current = a
      }
      if (this.row[b] === 0) this.touched[this.touchedCount++] = b
      this.row[b] += v
    }
  }

  private flush(): void {
    if (this.current < 0) return
    const list = Array.from(this.touched.subarray(0, this.touchedCount)).sort((x, y) => x - y)
    for (const b of list) {
      this.first.push(this.current)
      this.second.push(b)
      this.contacts.push(this.row[b])
      this.row[b] = 0
    }
    this.touchedCount = 0
    this.done[this.current] = 1
  }

  /** The network: every pair once, `first < second`, sorted. */
  finish(): ContigNetwork {
    this.flush()
    this.current = -1
    let first = Int32Array.from(this.first)
    let second = Int32Array.from(this.second)
    let contacts = Float64Array.from(this.contacts)
    if (this.late.size > 0) {
      const merged = new Map<number, number>()
      for (let k = 0; k < first.length; k++) merged.set(first[k] * this.contigs + second[k], contacts[k])
      for (const [key, v] of this.late) merged.set(key, (merged.get(key) ?? 0) + v)
      const keys = [...merged.keys()].sort((x, y) => x - y)
      first = new Int32Array(keys.length)
      second = new Int32Array(keys.length)
      contacts = new Float64Array(keys.length)
      keys.forEach((key, k) => {
        const a = Math.floor(key / this.contigs)
        first[k] = a
        second[k] = key - a * this.contigs
        contacts[k] = merged.get(key) ?? 0
      })
    }
    return { contigs: this.contigs, first, second, contacts, within: this.within }
  }
}

/** Each bin's contig, from the contigs' bin offsets (`chrom_offset`). */
export function binContigs(offsets: ArrayLike<number>): Int32Array {
  const contigs = offsets.length - 1
  const out = new Int32Array(Number(offsets[contigs]))
  for (let c = 0; c < contigs; c++) out.fill(c, Number(offsets[c]), Number(offsets[c + 1]))
  return out
}
