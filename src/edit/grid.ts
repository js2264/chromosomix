/**
 * The lens at the picture's grid (SPECS §27.2, §27.9): which cell of the
 * picture every cell of the edited axis shows.
 *
 * The picture is held in the file's order (`metacooler/picture.ts`) and never
 * changes; an edit changes this, and only this. Each piece is placed on the
 * grid by rounding its two ends to the nearest cell edge — **bins move whole**,
 * so every cell inside a piece is a cell of the picture, and what is
 * approximate is the junction, at most a cell of it (§27.2) — then read forward
 * or backwards, and a gap is cells that show nothing. What comes out is one
 * number per cell of the edited axis ({@link LensGrid.cellMap}), which is all
 * the painter needs, and one stretch of the axis per piece
 * ({@link LensGrid.axis}), which is all the lanes need: they fetch in original
 * coordinates and draw through it, as §27.7 has them.
 *
 * The edited positions the stage speaks — a cut *here*, this stretch moved
 * *there* — are base pairs of edited sequences, the coordinates a step is
 * recorded in. {@link LensGrid.place} and {@link LensGrid.unitOf} are the two
 * directions between those and the axis, and a junction is exact both ways:
 * the edge of a cell there is the base pair the parts meet at.
 */

import { isGap, type EditedAssembly, type Piece } from '../genome/edit'
import { LocusAxis, bpAt, unitAt, type LocusSegment } from '../render/locus'

/** The picture's grid over the original assembly, as the reader reported it. */
export interface GridLayout {
  /** Base pairs a cell a side. */
  binsize: number
  /** The original sequences, in file order, each with the cells it spans. */
  sequences: ReadonlyArray<{ name: string; length: number; firstCell: number; cells: number }>
}

/** One part of an edited sequence, placed on the edited axis. */
export interface GridPart {
  /** The edited sequence it is in, and its place in that sequence's parts. */
  sequence: string
  index: number
  /** Where it begins in its sequence, and how long it is, in base pairs. */
  offset: number
  length: number
  /** Its cells on the edited axis, half-open. Equal where it is too short for one. */
  from: number
  to: number
  /** The piece, or `null` for a gap. */
  piece: Piece | null
  /** The original sequence's place in the file, for its colour; `-1` for a gap. */
  original: number
  /** The stretch of the axis the lanes are drawn through; `null` for a gap or an empty part. */
  segment: LocusSegment | null
}

/** One edited sequence on the axis. */
export interface GridSequence {
  name: string
  /** In base pairs. */
  length: number
  /** Its cells, half-open. */
  from: number
  to: number
  /** Its parts in {@link LensGrid.parts}, half-open. */
  partFrom: number
  partTo: number
}

/** An edited position: a base pair of an edited sequence, and the part it is in. */
export interface EditedLocus {
  sequence: string
  bp: number
  part: GridPart
}

export class LensGrid {
  readonly binsize: number
  /** Cells on the edited axis. */
  readonly n: number
  readonly parts: readonly GridPart[]
  readonly sequences: readonly GridSequence[]
  /** The picture's cell each edited cell shows; `-1` in a gap. */
  readonly cellMap: Int32Array
  /** The picture's cell count a side, so a caller can check a map against it. */
  readonly pictureCells: number
  private axisHeld: LocusAxis | null | undefined

  private constructor(fields: {
    binsize: number
    n: number
    parts: GridPart[]
    sequences: GridSequence[]
    cellMap: Int32Array
    pictureCells: number
  }) {
    this.binsize = fields.binsize
    this.n = fields.n
    this.parts = fields.parts
    this.sequences = fields.sequences
    this.cellMap = fields.cellMap
    this.pictureCells = fields.pictureCells
  }

  /** Place an edited assembly on the picture's grid. */
  static of(assembly: EditedAssembly, layout: GridLayout): LensGrid {
    const size = layout.binsize
    const byName = new Map(layout.sequences.map((sequence, index) => [sequence.name, { ...sequence, index }]))
    const pictureCells = layout.sequences.reduce((total, sequence) => Math.max(total, sequence.firstCell + sequence.cells), 0)

    // Where a base pair of an original sequence falls among its cells: the
    // nearest edge, and the sequence's own last edge for its end — its last
    // cell is short in general, and rounding would drop it.
    const edge = (cells: number, length: number, bp: number): number =>
      bp >= length ? cells : Math.max(0, Math.min(cells, Math.round(bp / size)))

    const parts: GridPart[] = []
    const sequences: GridSequence[] = []
    const map: number[] = []
    for (const sequence of assembly.sequences) {
      const first = map.length
      const partFrom = parts.length
      let offset = 0
      sequence.parts.forEach((part, index) => {
        const from = map.length
        if (isGap(part)) {
          const cells = Math.round(part.gap / size)
          for (let k = 0; k < cells; k++) map.push(-1)
          parts.push({
            sequence: sequence.name,
            index,
            offset,
            length: part.gap,
            from,
            to: map.length,
            piece: null,
            original: -1,
            segment: null,
          })
          offset += part.gap
          return
        }
        const source = byName.get(part.sequence)
        const length = part.end - part.start
        if (source === undefined) {
          // A piece of a sequence the picture does not have: the edit was made
          // on another file, which the caller refuses before it gets here.
          parts.push({ sequence: sequence.name, index, offset, length, from, to: from, piece: part, original: -1, segment: null })
          offset += length
          return
        }
        const low = edge(source.cells, source.length, part.start)
        const high = edge(source.cells, source.length, part.end)
        const cells = Math.max(0, high - low)
        for (let k = 0; k < cells; k++) {
          map.push(part.strand === 1 ? source.firstCell + low + k : source.firstCell + high - 1 - k)
        }
        const to = map.length
        const segment: LocusSegment | null =
          cells === 0
            ? null
            : {
                contig: part.sequence,
                unitStart: from,
                unitEnd: to,
                // The left edge of the first cell: the piece's low end read
                // forward, its high end read backwards.
                bpStart: (part.strand === 1 ? low : high) * size,
                bpPerUnit: size,
                contigLength: source.length,
                strand: part.strand,
                bpFrom: part.start,
                bpTo: part.end,
              }
        parts.push({ sequence: sequence.name, index, offset, length, from, to, piece: part, original: source.index, segment })
        offset += length
      })
      sequences.push({
        name: sequence.name,
        length: offset,
        from: first,
        to: map.length,
        partFrom,
        partTo: parts.length,
      })
    }
    return new LensGrid({
      binsize: size,
      n: map.length,
      parts,
      sequences,
      cellMap: Int32Array.from(map),
      pictureCells,
    })
  }

  /** The stretches the lanes are drawn through, one per piece; `null` with no cell to draw on. */
  get axis(): LocusAxis | null {
    if (this.axisHeld === undefined) {
      const segments = this.parts.flatMap((part) => (part.segment === null ? [] : [part.segment]))
      this.axisHeld = segments.length === 0 ? null : new LocusAxis(segments)
    }
    return this.axisHeld
  }

  /** The part a unit of the axis is in — never one too short for a cell — or `null` outside. */
  partAt(unit: number): GridPart | null {
    if (!(unit >= 0 && unit < this.n)) return null
    let low = 0
    let high = this.parts.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const part = this.parts[mid]
      if (unit < part.from) high = mid - 1
      else if (unit >= part.to) low = mid + 1
      else return part
    }
    return null
  }

  /** The sequence a unit of the axis is in, or `null` outside. */
  sequenceAt(unit: number): GridSequence | null {
    if (!(unit >= 0 && unit < this.n)) return null
    let low = 0
    let high = this.sequences.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const sequence = this.sequences[mid]
      if (unit < sequence.from) high = mid - 1
      else if (unit >= sequence.to) low = mid + 1
      else return sequence
    }
    return null
  }

  /** A sequence by name, or `null`. */
  sequence(name: string): GridSequence | null {
    return this.sequences.find((sequence) => sequence.name === name) ?? null
  }

  /**
   * The edited position at a unit of the axis: the base pair of the original
   * under it, carried into the edited sequence — so a place named on the map is
   * the place a track under it names — and in a gap, the fraction of the gap.
   */
  place(unit: number): EditedLocus | null {
    const part = this.partAt(unit)
    if (part === null) return null
    const piece = part.piece
    if (piece === null || part.segment === null) {
      const fraction = part.to > part.from ? (unit - part.from) / (part.to - part.from) : 0
      return { sequence: part.sequence, bp: part.offset + fraction * part.length, part }
    }
    const original = Math.max(piece.start, Math.min(piece.end, bpAt(part.segment, unit)))
    const within = piece.strand === 1 ? original - piece.start : piece.end - original
    return { sequence: part.sequence, bp: part.offset + within, part }
  }

  /**
   * An edited position as a unit of the axis: where a step recorded in base
   * pairs is drawn. Exact at a junction — the edge of the cell where its part
   * begins — and at a sequence's end. `null` for a name the assembly lacks.
   */
  unitOf(sequence: string, bp: number): number | null {
    const found = this.sequence(sequence)
    if (found === null) return null
    if (bp <= 0) return found.from
    if (bp >= found.length) return found.to
    for (let i = found.partFrom; i < found.partTo; i++) {
      const part = this.parts[i]
      if (bp < part.offset || bp >= part.offset + part.length) continue
      if (bp === part.offset) return part.from
      const piece = part.piece
      if (piece === null || part.segment === null) {
        const fraction = (bp - part.offset) / part.length
        return part.from + fraction * (part.to - part.from)
      }
      const within = bp - part.offset
      const original = piece.strand === 1 ? piece.start + within : piece.end - within
      return Math.max(part.from, Math.min(part.to, unitAt(part.segment, original)))
    }
    return found.to
  }

  /** Every edge between two parts of one sequence, in units, ascending and each once. */
  junctions(): number[] {
    const out: number[] = []
    for (const sequence of this.sequences) {
      for (let i = sequence.partFrom + 1; i < sequence.partTo; i++) {
        const at = this.parts[i].from
        if (at > sequence.from && at < sequence.to && out[out.length - 1] !== at) out.push(at)
      }
    }
    return out
  }

  /** Every edge between two sequences, and the axis's two ends, in units. */
  boundaries(): number[] {
    const out = [0]
    for (const sequence of this.sequences) if (out[out.length - 1] !== sequence.to) out.push(sequence.to)
    return out
  }
}
