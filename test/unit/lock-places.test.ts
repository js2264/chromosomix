/**
 * The deck's lock across more than one sequence (§16.3): a block's cells as
 * places on the line its view's sequences make, end to end
 * (`ui/blockAxes.ts`, `frameOf` and `placesOnFrame`).
 *
 * The failure this pins down was the yeast deck on the whole genome, zoomed
 * fast. Each map's zoom read a window of its own inside the genome, one from
 * chrVII and one from chrI, and the lock counted each map's window from where
 * its block began *in its sequence*, so 378 kb into chrVII on one map was put
 * 378 kb into the genome on the other, which is chrII:148 kb. Panned slowly the
 * two blocks began in the same sequence and the maps agreed, which is why it
 * looked like a matter of speed.
 *
 * The blocks below are built as `MatrixPanel.locusAxesOf` builds them, from the
 * reader's runs, on the grid the reader anchors to each sequence's first base
 * (`snapToGrid`): every sequence starts a new cell and its last cell is short.
 */

import { describe, expect, it } from 'vitest'

import { ViewportLock, type CellSpan, type LockMember, type PlaceAxis } from '../../src/panels/lock'
import { locusAxisFrom, type AxisRun, type LocusAxis } from '../../src/render/locus'
import { frameOf, placesOnFrame } from '../../src/ui/blockAxes'

/** Saccharomyces cerevisiae R64, the sequences of the deck in question, in the file's order. */
const YEAST: ReadonlyArray<[string, number]> = [
  ['chrI', 230_218],
  ['chrII', 813_184],
  ['chrIII', 316_620],
  ['chrIV', 1_531_933],
  ['chrV', 576_874],
  ['chrVI', 270_161],
  ['chrVII', 1_090_940],
  ['chrVIII', 562_643],
  ['chrIX', 439_888],
]
const lengthOf = (name: string): number | undefined => YEAST.find(([n]) => n === name)?.[1]
/** Where a sequence begins on the line: the lengths of those before it. */
const startOf = (name: string): number => {
  let at = 0
  for (const [n, length] of YEAST) {
    if (n === name) return at
    at += length
  }
  throw new Error(name)
}

/**
 * A block of the genome at `grid` bp a cell, from `from` to `to` (each a
 * sequence and a base pair, snapped outward to the grid), as the reader sends
 * it and the panel builds its axis from it.
 */
function block(grid: number, from: [string, number], to: [string, number]): { axis: LocusAxis; cells: number } {
  // The file's bins at this grid: every sequence starts a new one.
  const firstBin = new Map<string, number>()
  let bins = 0
  for (const [name, length] of YEAST) {
    firstBin.set(name, bins)
    bins += Math.ceil(length / grid)
  }
  const at = ([name, bp]: [string, number], up: boolean): number =>
    (firstBin.get(name) as number) + (up ? Math.ceil(bp / grid) : Math.floor(bp / grid))
  const lo = at(from, false)
  const hi = at(to, true)
  const runs: AxisRun[] = []
  for (const [name, length] of YEAST) {
    const start = firstBin.get(name) as number
    const end = start + Math.ceil(length / grid)
    const a = Math.max(start, lo)
    const b = Math.min(end, hi)
    if (b > a) runs.push({ label: name, start: a - lo, end: b - lo, unitStart: start, unitLength: length })
  }
  const axis = locusAxisFrom({ runs, blockStart: lo, level: 'bin', binsize: grid, contigLength: lengthOf })
  if (axis === null) throw new Error('no axis')
  return { axis, cells: hi - lo }
}

/** The whole genome at a grid, which is the block every map of the view first draws. */
const whole = (grid: number) => block(grid, ['chrI', 0], ['chrIX', 439_888])

/** The line a whole-genome view lays its sequences on, as a panel takes it from its first block. */
const line = (grid = 12_800) => frameOf(whole(grid).axis)

/** A block's places on the whole genome's line. */
function placesOf(b: { axis: LocusAxis }, grid = 12_800): PlaceAxis {
  const places = placesOnFrame(line(grid), b.axis)
  if (places === null) throw new Error('no places')
  return places
}

describe('the line a view of several sequences is laid on', () => {
  it('lays each sequence its own length, whatever the grid its first block was drawn at', () => {
    for (const grid of [400, 1_600, 12_800]) {
      const stretches = line(grid)
      expect(stretches, `${grid}`).toHaveLength(YEAST.length)
      for (const [i, [name, length]] of YEAST.entries()) {
        expect(stretches?.[i], `${name} at ${grid}`).toEqual({
          contig: name,
          from: 0,
          to: length,
          strand: 1,
          start: startOf(name),
        })
      }
    }
  })

  it('begins at the first sequence’s own coordinate, as the lock always counted one sequence', () => {
    const region = block(1_000, ['chrIV', 1_000_000], ['chrIV', 1_400_000])
    expect(frameOf(region.axis)?.[0]).toMatchObject({ contig: 'chrIV', from: 1_000_000, start: 1_000_000 })
  })
})

describe('a block’s cells as places on that line', () => {
  it('puts a place in chrVII at the same place through every block that holds it', () => {
    // The user's deck: one map on a block a zoom read from chrVII at 400 bp,
    // the other still on the whole genome at 12.8 kb, or on a block of its own
    // zoom's that begins in chrI.
    const fromVII = block(400, ['chrVII', 373_600], ['chrVII', 640_000])
    const genome = whole(12_800)
    const fromI = block(1_600, ['chrI', 100_000], ['chrVIII', 50_000])
    const want = startOf('chrVII') + 400_000
    for (const [label, b] of [
      ['from chrVII at 400 bp', fromVII],
      ['whole at 12.8 kb', genome],
      ['from chrI at 1.6 kb', fromI],
    ] as const) {
      const places = placesOf(b)
      const cell = places.cell(want)
      // The cell of chrVII:400,000 on this block's own axis, as the readout has it.
      const own = b.axis.locusToUnit('chrVII', 400_000) as number
      expect(cell, label).toBeCloseTo(own, 6)
      expect(places.place(cell), label).toBeCloseTo(want, 3)
    }
  })

  it('is not a block’s own first cell counted from where it begins in its sequence', () => {
    // What the lock used to do: the block from chrVII, counted from its origin
    // (373.6 kb into chrVII), put its window 373.6 kb into the *genome* on a map
    // holding the whole of it — which is in chrII.
    const fromVII = block(400, ['chrVII', 373_600], ['chrVII', 640_000])
    const genome = whole(12_800)
    const atStart = placesOf(fromVII).place(0)
    expect(atStart).toBe(startOf('chrVII') + 373_600)
    expect(genome.axis.unitToLocus(placesOf(genome).cell(atStart))?.contig).toBe('chrVII')
    expect(genome.axis.unitToLocus(373_600 / 12_800)?.contig).toBe('chrII')
  })

  it('does not carry a sequence’s short last cell on into the next', () => {
    // chrI is 230,218 bp: 18 cells of 12.8 kb, the last 2,018 bp short. The
    // edge between chrI and chrII is the place 230,218 — not 18 × 12.8 kb —
    // and a cell inside that short last cell is held to chrI's end.
    const places = placesOf(whole(12_800))
    expect(places.place(18)).toBe(230_218)
    expect(places.place(17.99)).toBe(230_218)
    expect(places.place(17.5)).toBe(17.5 * 12_800)
    expect(places.cell(230_218)).toBe(18)
  })

  it('goes back and forth between cells and places inside the block', () => {
    const fromI = block(1_600, ['chrI', 100_000], ['chrVIII', 50_000])
    const places = placesOf(fromI)
    for (const cell of [0, 1, 50.5, 81, 600, 1_234.25, fromI.cells - 1]) {
      const segment = fromI.axis.segmentAt(cell)
      // Inside a sequence's short last cell the place is held to its end, and
      // that place is the next sequence's first cell edge.
      const end = segment === null ? null : (lengthOf(segment.contig) as number)
      const bp = segment === null ? 0 : segment.bpStart + (cell - segment.unitStart) * segment.bpPerUnit
      if (end !== null && bp > end) continue
      expect(places.cell(places.place(cell)), `cell ${cell}`).toBeCloseTo(cell, 6)
    }
  })

  it('goes on past either end of the block at the block’s step', () => {
    const fromVII = block(400, ['chrVII', 373_600], ['chrVII', 640_000])
    const places = placesOf(fromVII)
    // Before it, in its own sequence: exact, the same grid.
    expect(places.cell(startOf('chrVII') + 300_000)).toBeCloseTo((300_000 - 373_600) / 400, 6)
    expect(places.place(-10)).toBe(startOf('chrVII') + 373_600 - 4_000)
    // Past it in a sequence it does not carry: on from its edge.
    const pastEnd = places.cell(startOf('chrVIII') + 10_000)
    expect(pastEnd).toBeCloseTo(fromVII.cells + (startOf('chrVIII') + 10_000 - (startOf('chrVII') + 640_000)) / 400, 6)
    expect(places.place(pastEnd)).toBeCloseTo(startOf('chrVIII') + 10_000, 3)
  })

  it('leaves one sequence to its origin and step, a circle panned across its origin included', () => {
    const region = block(1_000, ['chrIV', 1_000_000], ['chrIV', 1_400_000])
    expect(placesOnFrame(frameOf(region.axis), region.axis)).toBeNull()
  })

  it('gives no places to a block carrying a sequence the line does not', () => {
    const genome = whole(12_800)
    const other = locusAxisFrom({
      runs: [{ label: 'chrXX', start: 0, end: 10, unitStart: 0, unitLength: 100_000 }],
      blockStart: 0,
      level: 'bin',
      binsize: 10_000,
      contigLength: () => 100_000,
    })
    expect(placesOnFrame(frameOf(genome.axis), other)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The lock, driving maps whose blocks begin in different sequences
// ---------------------------------------------------------------------------

/**
 * A map as the lock sees it, holding a block of the genome that can change
 * under it — a read landing — and keeping its view over the same places as it
 * does, as `MatrixPanel.regrid` keeps it.
 */
function map(id: string, grid: number, b: { axis: LocusAxis; cells: number }) {
  const held = { grid, ...b, places: placesOf(b) }
  const state = { rows: [0, b.cells] as CellSpan, cols: [0, b.cells] as CellSpan, shown: 0 }
  const reached: Array<{ rows: CellSpan; cols: CellSpan }> = []
  const member: LockMember = {
    id,
    unit: () => 'bp',
    bpPerCell: () => held.grid,
    cells: () => ({ rows: held.cells, cols: held.cells }),
    // Where its block begins in its first sequence: what the lock used to count from.
    origin: () => {
      const first = held.axis.segments[0]
      return { rows: first.bpStart, cols: first.bpStart }
    },
    places: () => ({ rows: held.places, cols: held.places }),
    locked: () => true,
    show: (rows, cols) => {
      state.rows = rows
      state.cols = cols
      state.shown += 1
      return true
    },
    reach: (rows, cols) => {
      reached.push({ rows, cols })
    },
  }
  const land = (next: number, b2: { axis: LocusAxis; cells: number }): void => {
    const places = placesOf(b2)
    const carried = (span: CellSpan): CellSpan => [
      places.cell(held.places.place(span[0])),
      places.cell(held.places.place(span[1])),
    ]
    state.rows = carried(state.rows)
    state.cols = carried(state.cols)
    Object.assign(held, { grid: next, ...b2, places })
  }
  /** The places it shows, lowest and highest, along the columns. */
  const showing = (): [number, number] => [held.places.place(state.cols[0]), held.places.place(state.cols[1])]
  return { member, state, reached, land, showing }
}

describe('the lock across the whole genome', () => {
  it('puts a map holding the whole genome on the place the first map’s chrVII block shows', () => {
    const lock = new ViewportLock()
    const lead = map('lead', 400, block(400, ['chrVII', 373_600], ['chrVII', 640_000]))
    const other = map('other', 12_800, whole(12_800))
    lock.join(lead.member)
    lock.join(other.member)
    // chrVII:377,600–632,000 on the first map.
    lock.report('lead', [10, 646], [10, 646])
    const [lo, hi] = other.showing()
    expect(lo).toBeLessThanOrEqual(startOf('chrVII') + 377_600)
    expect(hi).toBeGreaterThanOrEqual(startOf('chrVII') + 632_000)
    // …within a cell of it at each end, which is the outward rounding, and on chrVII.
    expect(startOf('chrVII') + 377_600 - lo).toBeLessThan(12_800)
    expect(hi - (startOf('chrVII') + 632_000)).toBeLessThan(12_800)
    const whole12 = whole(12_800).axis
    expect(whole12.unitToLocus(other.state.cols[0])?.contig).toBe('chrVII')
  })

  it('asks a map whose block begins in chrI to read chrVII, and shows it there when it lands', () => {
    const lock = new ViewportLock()
    const lead = map('lead', 400, block(400, ['chrVII', 373_600], ['chrVII', 640_000]))
    const other = map('other', 1_600, block(1_600, ['chrI', 100_000], ['chrIII', 200_000]))
    lock.join(lead.member)
    lock.join(other.member)
    lock.report('lead', [10, 646], [10, 646])
    // Its block holds none of the window: it is shown what it can, and asked for the rest…
    expect(other.reached).toHaveLength(1)
    const asked = other.reached[0].cols
    const places = placesOf(block(1_600, ['chrI', 100_000], ['chrIII', 200_000]))
    // …where the window is, in its own cells past the end of its block.
    expect(places.place(asked[0])).toBeCloseTo(startOf('chrVII') + 377_600, 3)
    expect(places.place(asked[1])).toBeCloseTo(startOf('chrVII') + 632_000, 3)

    // The read lands: its own zoom's block around chrVII, at 1.6 kb.
    other.land(1_600, block(1_600, ['chrVI', 200_000], ['chrVII', 900_000]))
    lock.landed('other')
    const [lo, hi] = other.showing()
    expect(startOf('chrVII') + 377_600 - lo).toBeGreaterThanOrEqual(0)
    expect(startOf('chrVII') + 377_600 - lo).toBeLessThan(1_600)
    expect(hi - (startOf('chrVII') + 632_000)).toBeGreaterThanOrEqual(0)
    expect(hi - (startOf('chrVII') + 632_000)).toBeLessThan(1_600)

    // Its redraws are echoes and move nobody, however many there are.
    for (let i = 0; i < 20; i++) lock.report('other', other.state.rows, other.state.cols)
    expect(lead.state.shown).toBe(0)
  })

  it('follows a gesture on a map whose block begins elsewhere, in the other direction', () => {
    const lock = new ViewportLock()
    const lead = map('lead', 400, block(400, ['chrVI', 100_000], ['chrVII', 300_000]))
    const other = map('other', 1_600, block(1_600, ['chrV', 300_000], ['chrVIII', 100_000]))
    lock.join(lead.member)
    lock.join(other.member)
    // The other map is dragged across the chrVI–chrVII edge: chrVI:250,000 to chrVII:50,000.
    const places = placesOf(block(1_600, ['chrV', 300_000], ['chrVIII', 100_000]))
    const from = places.cell(startOf('chrVI') + 250_000)
    const to = places.cell(startOf('chrVII') + 50_000)
    other.state.rows = [from, to]
    other.state.cols = [from, to]
    lock.report('other', [from, to], [from, to])
    const [lo, hi] = lead.showing()
    expect(lo).toBe(startOf('chrVI') + 250_000)
    expect(hi).toBe(startOf('chrVII') + 50_000)
  })

  it('stands still under a hundred echo exchanges between two grids', () => {
    const lock = new ViewportLock()
    const lead = map('lead', 400, block(400, ['chrVI', 100_000], ['chrVII', 300_000]))
    const other = map('other', 1_600, block(1_600, ['chrV', 300_000], ['chrVIII', 100_000]))
    lock.join(lead.member)
    lock.join(other.member)
    lead.state.rows = [123.4, 801.7]
    lead.state.cols = [123.4, 801.7]
    lock.report('lead', lead.state.rows, lead.state.cols)
    for (let i = 0; i < 2; i++) {
      lock.report('other', other.state.rows, other.state.cols)
      lock.report('lead', lead.state.rows, lead.state.cols)
    }
    const settled = { lead: [...lead.state.cols], other: [...other.state.cols] }
    for (let i = 0; i < 100; i++) {
      lock.report('other', other.state.rows, other.state.cols)
      lock.report('lead', lead.state.rows, lead.state.cols)
    }
    expect(lead.state.cols).toEqual(settled.lead)
    expect(other.state.cols).toEqual(settled.other)
  })

  it('seeds the deck’s window from the first map through its own places', () => {
    const lock = new ViewportLock()
    const lead = map('lead', 400, block(400, ['chrVII', 373_600], ['chrVII', 640_000]))
    const late = map('late', 12_800, whole(12_800))
    lock.join(lead.member)
    lock.join(late.member)
    lock.seedFrom('lead', [10, 646], [10, 646])
    expect(lock.window?.cols).toEqual({ lo: startOf('chrVII') + 377_600, hi: startOf('chrVII') + 632_000 })
    expect(lead.state.shown).toBe(0)
    lock.catchUp('late')
    expect(whole(12_800).axis.unitToLocus(late.state.cols[0])?.contig).toBe('chrVII')
  })
})

