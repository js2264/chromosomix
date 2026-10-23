/**
 * What the pointer is over, said twice: on the status bar's readout line, and
 * on the card that follows the pointer across the map and its lanes.
 *
 * Both on purpose — the card answers *what is under my cursor* without a glance
 * away from the picture, and the line keeps the last answer once the pointer has
 * moved on — and both from one reading of the cell, so that they cannot
 * disagree: the names, the positions, the distance apart, the derived value and
 * the counts behind it, each read through the square block however the map is
 * drawn.
 *
 * Its own class rather than part of `ui/MatrixPanel.ts` because the card has
 * state nothing else touches — its fixed nodes, and the cached geometry that
 * keeps placing it free of layout reads on the busiest path in the app — and
 * because saying what a cell holds is a long piece of wording with one
 * question in it. The panel keeps the hover itself: who else is told the
 * pointer moved — the lanes' crosshair, a deck, a structure cell — is its
 * business, and it hands this the cell to describe.
 */

import { originalOf } from '../edit/axis'
import { baseLabel, formatPosition } from '../genome/assembly'
import type { Cell } from '../render/heatmap'
import { bandAt, type RotatedBlock } from '../render/rotate'
import { alongAxis } from '../render/turnGeometry'
import type { AxisGroup, MatrixResult } from '../worker/protocol'
import type { LaneReadout } from './AnnotationLanes'
import { bpWithin, groupAt, separationOf } from './blockAxes'
import { el, fmt } from './dom'
import type { MatrixPanel, MatrixPanelOptions } from './MatrixPanel'
import { getPlotOptions } from './plotOptions'
import { setReadout } from './readout'

/**
 * What the readout needs of the panel: the block it reads, and the panel's own
 * words for what the cells hold.
 */
export interface ReadoutHost {
  /**
   * The panel's options object, held by reference: the bin size moves with
   * every block and the comparison's labels with a rename, and the edit is
   * asked for at each reading.
   */
  readonly options: MatrixPanelOptions
  /** The block on screen, or `null` before one has arrived. */
  data(): MatrixResult | null
  /** The band on screen where the map is turned, or `null` for a square map. */
  turned(): RotatedBlock | null
  /** The second file's block, while two files are drawn as one square. */
  second(): { data: MatrixResult } | null
  /** The cell of the square block under a pointer on the picture: {@link MatrixPanel}'s `squareCell`. */
  squareCell(cell: Cell): Cell
  /** What the cells hold, in the word the key uses. */
  scoreWord(): string
  /** The derived value at a cell of the square block, or `null` where nothing is derived. */
  derivedReading(row: number, col: number): string | null
  /**
   * The lower reading under a pointer (§5.10) — what its cells hold and its
   * derived value there — or `null` where the pointer is not over one.
   */
  lower?(cell: Cell, square: Cell): { word: string; reading: string | null; value: number } | null
}

/** The readout line and the card beside the pointer, for one map and its lanes. */
export class MapReadout {
  /**
   * The card itself, parented by the panel's grid so that it can float over the
   * map and over any of its lanes.
   */
  readonly tooltip: HTMLElement
  /** The tooltip's fixed nodes; only their text changes (see {@link describe}). */
  private readonly tip: {
    matrix: HTMLElement
    rowGenome: HTMLElement
    genomeTimes: HTMLElement
    colGenome: HTMLElement
    genomes: HTMLElement
    rowName: HTMLElement
    times: HTMLElement
    colName: HTMLElement
    pos: HTMLElement
    distance: HTMLElement
    count: HTMLElement
    /** The lane tooltip's block: a heading and however many lines it has. */
    lane: HTMLElement
    laneTitle: HTMLElement
    laneLines: HTMLElement
  }
  /** Cached geometry for {@link positionTooltip}; never read during a pointer move. */
  private tipSize = { width: 0, height: 0 }
  /**
   * The size of the grid the card is placed in, written by the panel whenever it
   * measures the grid — its resize observer, its first frame, `remeasure`.
   */
  hostSize = { width: 0, height: 0 }
  private tipAt: { x: number; y: number } | null = null
  private tipFrame = 0
  /** The panel's options, held by reference; see {@link ReadoutHost.options}. */
  private readonly options: MatrixPanelOptions

  constructor(private readonly host: ReadoutHost) {
    this.options = host.options
    // A tooltip follows the pointer with the same three facts as the readout.
    // Both exist on purpose: the tooltip answers "what is under my cursor"
    // without a glance away from the matrix, and the readout keeps the last
    // answer visible after the pointer has moved on.
    // Two shapes in one card: the matrix's row × column × count, and a lane's
    // heading with however many lines the feature under the pointer has. One
    // element rather than two, because there is one pointer and it can only be
    // over one of them — and because the placement logic is fiddly enough that
    // a second copy of it would drift.
    this.tip = {
      matrix: el('div', { class: 'cell-tip-block' }),
      rowGenome: el('span', { class: 'cell-tip-name' }),
      genomeTimes: el('span', { class: 'cell-tip-x', text: '×' }),
      colGenome: el('span', { class: 'cell-tip-name' }),
      genomes: el('div', { class: 'cell-tip-pair cell-tip-genomes hidden' }),
      rowName: el('span', { class: 'cell-tip-name' }),
      times: el('span', { class: 'cell-tip-x', text: '×' }),
      colName: el('span', { class: 'cell-tip-name' }),
      pos: el('div', { class: 'cell-tip-pos' }),
      distance: el('div', { class: 'cell-tip-distance hidden' }),
      count: el('div', { class: 'cell-tip-count' }),
      lane: el('div', { class: 'cell-tip-block hidden' }),
      laneTitle: el('div', { class: 'cell-tip-title' }),
      laneLines: el('div', { class: 'cell-tip-lines' }),
    }
    this.tip.genomes.append(this.tip.rowGenome, this.tip.genomeTimes, this.tip.colGenome)
    this.tip.matrix.append(
      // The genome leads, where there is one: it is the coarser fact, and on a
      // metagenome it is the one that says what you are looking at. The contig
      // under it is the finer answer to the same question.
      this.tip.genomes,
      el('div', { class: 'cell-tip-pair' }, this.tip.rowName, this.tip.times, this.tip.colName),
      this.tip.pos,
      this.tip.distance,
      this.tip.count,
    )
    this.tip.lane.append(this.tip.laneTitle, this.tip.laneLines)
    this.tooltip = el('div', { class: 'cell-tip hidden' }, this.tip.matrix, this.tip.lane)
  }

  /** The block on screen, as the panel holds it now. */
  private get data(): MatrixResult | null {
    return this.host.data()
  }

  /** The turned band on screen, as the panel holds it now. */
  private get turned(): RotatedBlock | null {
    return this.host.turned()
  }

  /** The second file's block, as the panel holds it now. */
  private get second(): { data: MatrixResult } | null {
    return this.host.second()
  }

  /**
   * Say what the pointer is over, on the line and on the card; `null` clears
   * both.
   *
   * The words of the panel's hover: `MatrixPanel.describe` records the cell and
   * tells whoever else is listening, then hands it here.
   */
  describe(cell: Cell | null, at?: { x: number; y: number; span?: boolean }): void {
    if (cell === null || this.data === null) {
      setReadout('')
      this.tooltip.classList.add('hidden')
      return
    }
    this.tip.matrix.classList.remove('hidden')
    this.tip.lane.classList.add('hidden')
    const data = this.data
    // A pointer over a turned map is over a band row and a half-bin column, and
    // neither is a coordinate of the block the readout describes. Mapped back
    // first, so everything below — the two names, the positions, the distance,
    // the counts — is the same code reading the same square block it always did.
    const square = this.host.squareCell(cell)
    const rowGroup = groupAt(data.rowGroups, square.row)
    const colGroup = groupAt(data.colGroups, square.col)
    // Positions are measured in absolute bin space, so each axis needs the bin
    // its own block starts at — they differ on a rectangular two-contig block.
    const rowStart = data.rowExtent[0]
    const colStart = data.colExtent[0]
    // Through an edit, each place with the original beside it (§27.7): where
    // the base was in the file, and whether the piece reads it backwards.
    const edited = this.options.annotations?.edited?.() ?? null
    const beside = (group: AxisGroup | undefined, offset: number, blockStart: number): string => {
      if (edited === null || group === undefined || data.level !== 'bin' || (group.merged?.length ?? 0) > 1) return ''
      const at = originalOf(edited, group.label, bpWithin(group, offset, blockStart, this.options.binsize))
      if (at === null) return ''
      return at === 'gap' ? ' · in a gap' : ` ← ${formatPosition(at.sequence, at.bp)}${at.strand === -1 ? ', turned' : ''}`
    }
    const rowLabel = describeAxis(rowGroup, square.row, data.level, this.options.binsize, rowStart) + beside(rowGroup, square.row, rowStart)
    const colLabel = describeAxis(colGroup, square.col, data.level, this.options.binsize, colStart) + beside(colGroup, square.col, colStart)

    // A turned map with a span modifier held is a reader about to name a stretch
    // of the genome, and the whole of what they are pointing at is *where along
    // the bottom* the pointer is. The pair of loci and the distance between them
    // answer the question the pointer was asking a moment ago — they are a fact
    // about the cell under it, and the cell is not what the next drag will
    // select. The crosshair already says so, standing up as one vertical line
    // where the readout went on describing a contact ({@link spanGuide}).
    if (at?.span === true && this.turned !== null) {
      this.describeAlong(square, data, at)
      return
    }
    // `cell.value` is what was *drawn*, which below the diagonal of a compared
    // map is the second file's count, and under a ratio neither file's. So the
    // numbers here come from the blocks themselves: each file's own count at
    // this cell.
    const compare = this.options.compare
    const slot = square.row * data.ncols + square.col
    // Below the diagonal of a map read two ways (§5.10), the cell is the lower
    // reading's, named as its own key names it, with the number it was read as
    // beside its derived value.
    const below = this.host.lower?.(cell, square) ?? null
    const mine = below !== null ? below.value : this.second === null ? cell.value : data.values[slot]
    const count = Number.isNaN(mine) ? 'NaN (unbalanced)' : fmt.num(mine)
    const counts =
      this.second === null || compare === undefined
        ? `${below?.word ?? this.host.scoreWord()} ${count}`
        : `${compare.labels[0]} ${count} · ${compare.labels[1]} ${
            Number.isNaN(this.second.data.values[slot])
              ? 'NaN (unbalanced)'
              : fmt.num(this.second.data.values[slot])
          }`
    // A derived cell is two questions, and answering only the second is what
    // makes a ratio map unreadable: "1.8× expected" is the reading, and "37
    // contacts" is what tells you whether to believe it. A departure computed
    // from three counts against a baseline of two is noise, and only the raw
    // numbers beside it say so.
    //
    // **Transposed in the mirrored band**, because that is the band's own file:
    // the drawn square holds the first file above the matrix diagonal and the
    // second below it, and a pointer under the shared axis is on the second.
    // Read the untransposed cell there and a reader hovering the lower band is
    // told the upper one's O/E, which is a real number from a real cell and not
    // the cell they are pointing at.
    const lower = this.turned !== null && bandAt(this.turned, cell.row) === 1
    const reading =
      below !== null
        ? below.reading
        : lower
          ? this.host.derivedReading(square.col, square.row)
          : this.host.derivedReading(square.row, square.col)
    // The genome each end belongs to, read before the distance because the
    // distance needs them: two MAGs may each have a `contig_1`, and on a
    // coarsened axis the name is most of what is left to tell them apart.
    const rowGenome = groupAt(data.rowGenomes, square.row)?.label
    const colGenome = groupAt(data.colGenomes, square.col)?.label
    const distance = separationOf(
      { group: rowGroup, offset: square.row, blockStart: rowStart, genome: rowGenome },
      { group: colGroup, offset: square.col, blockStart: colStart, genome: colGenome },
      data.level,
      this.options.binsize,
    )

    // On a turned map the separation *is* the y axis, so it leads: the reader's
    // eye is already on a height and the number under it is what they are asking
    // to have confirmed.
    // ` · ` between the parts, which is the separator the 1D browser's readout
    // uses in the same slot of the same status bar. Three spaces looked like a
    // separator on a wide window and like nothing at all on a narrow one, where
    // `115.0 kb apart balanced 0.000417` ran together as one phrase. The
    // `  ×  ` inside the pair stays: that one names a pair rather than joining
    // two facts.
    const parts = [
      this.turned === null ? `${rowLabel}  ×  ${colLabel}` : rowLabel,
      ...(distance === null ? [] : [`${fmt.bp(distance)} apart`]),
      ...(reading === null ? [] : [reading]),
      counts,
    ]
    setReadout(parts.join(' · '))

    // The names in full, unabbreviated, and each name written *once*: the axis
    // labels are elided when the blocks are narrow, so the tooltip is often the
    // only place the pair is spelled out — but on the diagonal of a contig map
    // the old layout printed `NODE_8524_len_441121` four times, and the number
    // the pointer is actually asking about was the last thing on the card.
    const sameBlock = rowGroup !== undefined && colGroup !== undefined && rowGroup.label === colGroup.label
    // `square`, like everything above: a turned cell's own row is a *separation*
    // and its column is a half-bin, so read through the block's own arithmetic
    // they name a position half way along the picture and a distance up it. The
    // two names and the "apart" line were mapped back and these two were not,
    // which is why the card could show the right sequence, the right separation
    // and a pair of coordinates belonging to neither.
    const rowPos = positionIn(rowGroup, square.row, data.level, this.options.binsize, rowStart)
    const colPos = positionIn(colGroup, square.col, data.level, this.options.binsize, colStart)

    // Written in place rather than rebuilt. `replaceChildren` with five fresh
    // elements ran on every pointer move — 4-6 allocations and as many
    // detachments per event, on the highest-frequency path in the app — to
    // produce a card whose *shape* almost never changes. Only the text does.
    const tip = this.tip
    tip.rowName.textContent = sameBlock ? rowGroup.label : (rowGroup?.label ?? '—')
    tip.times.classList.toggle('hidden', sameBlock)
    tip.colName.classList.toggle('hidden', sameBlock)
    if (!sameBlock) tip.colName.textContent = colGroup?.label ?? '—'
    const hasPos = rowPos !== null && colPos !== null
    tip.pos.classList.toggle('hidden', !hasPos)
    if (hasPos) tip.pos.textContent = `${rowPos}  ×  ${colPos}`

    // The genome line, on the same "written once when it is one name" rule as
    // the contigs above it. Absent entirely where the reader sent no genomes —
    // a plain cooler, or any view that already is one genome. Read above, where
    // the separation needed them.
    const hasGenome = rowGenome !== undefined || colGenome !== undefined
    tip.genomes.classList.toggle('hidden', !hasGenome)
    if (hasGenome) {
      const oneGenome = rowGenome === colGenome
      tip.rowGenome.textContent = rowGenome ?? '—'
      tip.genomeTimes.classList.toggle('hidden', oneGenome)
      tip.colGenome.classList.toggle('hidden', oneGenome)
      if (!oneGenome) tip.colGenome.textContent = colGenome ?? '—'
    }

    tip.distance.classList.toggle('hidden', distance === null)
    if (distance !== null) tip.distance.textContent = `${fmt.bp(distance)} apart`

    // With two files open the count line carries both — the whole question a
    // compared map is asked at every position is how the two differ *here*, and
    // answering it with only the visible half would mean reading the picture
    // twice, once on each side of the diagonal, to compare one locus.
    tip.count.classList.remove('hidden')
    tip.count.textContent = counts
    this.showTip(at)
  }

  /**
   * The readout for a pointer naming a **place** rather than a cell.
   *
   * One coordinate, because that is the whole of what the gesture is about: a
   * span drag on a turned map names a stretch of the genome, and where the
   * pointer is along the bottom is the only thing about it that is being chosen.
   * The midpoint of the cell's two ends *is* that position — a turned column
   * stands over the middle of the pair it draws (`render/rotate.ts`) — so this
   * is the same number the ruler under the pointer is printing, and the same one
   * the guide is standing on.
   *
   * No distance and no count. Both are facts about the cell, both were on the
   * card a moment ago, and leaving them there while the crosshair has already
   * become a single vertical line is the card describing a different gesture
   * from the one the hand is making.
   */
  private describeAlong(
    square: { row: number; col: number },
    data: MatrixResult,
    at?: { x: number; y: number },
  ): void {
    const along = alongAxis(square)
    // The group is asked for at a whole cell — a midpoint may land half way
    // between two — while the *position* is measured at the midpoint itself.
    const group = groupAt(data.rowGroups, Math.floor(along))
    const start = data.rowExtent[0]
    const genome = groupAt(data.rowGenomes, Math.floor(along))?.label
    setReadout(describeAxis(group, along, data.level, this.options.binsize, start))

    const tip = this.tip
    tip.rowName.textContent = group?.label ?? '—'
    tip.times.classList.add('hidden')
    tip.colName.classList.add('hidden')
    const pos = positionIn(group, along, data.level, this.options.binsize, start)
    tip.pos.classList.toggle('hidden', pos === null)
    if (pos !== null) tip.pos.textContent = pos
    tip.genomes.classList.toggle('hidden', genome === undefined)
    if (genome !== undefined) {
      tip.rowGenome.textContent = genome
      tip.genomeTimes.classList.add('hidden')
      tip.colGenome.classList.add('hidden')
    }
    tip.distance.classList.add('hidden')
    tip.count.classList.add('hidden')
    this.showTip(at)
  }

  /**
   * The card for a pointer on a lane: the position, and a line for each track
   * there — or put away where the lane has nothing to say.
   *
   * `x` and `y` are in the canvas's own pixels. The card is placed in the
   * grid's, through the canvas's offset in it, which is read only once there is
   * a card to place.
   */
  lane(readout: LaneReadout | null, canvas: HTMLCanvasElement, x: number, y: number): void {
    if (readout === null) {
      this.tooltip.classList.add('hidden')
      return
    }
    this.tip.matrix.classList.add('hidden')
    this.tip.lane.classList.remove('hidden')
    // The position, and only the position. Naming the hovered lane here as
    // well was saying what the pointer already says: the tooltip is beside the
    // lane it is about, and the row for that lane is marked below.
    this.tip.laneTitle.textContent = readout.position
    this.tip.laneLines.replaceChildren(
      ...readout.rows.map((row) =>
        el(
          'div',
          { class: row.here ? 'cell-tip-line cell-tip-here' : 'cell-tip-line' },
          el('span', { class: 'cell-tip-chip', style: { background: row.colour } }),
          // In the track's own colour, which is the legend the picture already
          // uses — the lane is drawn in it and so is its name on the lane.
          el('span', {
            class: 'cell-tip-key',
            text: `${row.label}:`,
            style: { color: row.colour },
          }),
          el('span', { class: 'cell-tip-val', text: row.value }),
        ),
      ),
      ...readout.detail.map((line) => el('div', { class: 'cell-tip-line', text: line })),
    )
    // The one gate for the card on this surface. Everything above it still runs
    // — the readout the status line shows is the same measurement — so turning
    // the card off costs a hover nothing and gives back the few hundred square
    // pixels it was covering.
    if (!getPlotOptions().tooltip) {
      this.tooltip.classList.add('hidden')
      return
    }
    this.tooltip.classList.remove('hidden')
    this.placeTooltip(canvas.offsetLeft + x, canvas.offsetTop + y)
  }

  /** Put the card away. */
  hide(): void {
    this.tooltip.classList.add('hidden')
  }

  /**
   * Put the card up where the pointer is, or leave it down.
   *
   * The one gate for the card on this surface, and it is deliberately the last
   * thing rather than the first: everything above it still runs, because the
   * readout on the status line is the same measurement, so turning the card off
   * costs a hover nothing and gives back the few hundred square pixels it was
   * covering.
   */
  private showTip(at?: { x: number; y: number }): void {
    if (!getPlotOptions().tooltip) {
      this.tooltip.classList.add('hidden')
      return
    }
    this.tooltip.classList.remove('hidden')
    if (at !== undefined) this.placeTooltip(at.x, at.y)
  }

  /**
   * Keep the tooltip inside the panel.
   *
   * Offset from the pointer so it never sits under it, and flipped to the other
   * side near an edge — a tooltip clipped by the panel border is worse than no
   * tooltip, because it looks like the value is missing.
   *
   * Both measurements it needs are *cached*, and that is the whole point. The
   * old version read `offsetWidth`/`offsetHeight` immediately after writing the
   * card's contents, which forces the browser to lay out the document
   * synchronously — twice per pointer move, at whatever rate the device reports
   * them. The host's size now comes from the `ResizeObserver` that already
   * watches it, and the tooltip's own size is re-measured at most once per
   * frame, inside a `requestAnimationFrame` where layout is already clean.
   */
  private placeTooltip(x: number, y: number): void {
    this.tipAt = { x, y }
    this.positionTooltip()
    if (this.tipFrame !== 0) return
    this.tipFrame = requestAnimationFrame(() => {
      this.tipFrame = 0
      const width = this.tooltip.offsetWidth
      const height = this.tooltip.offsetHeight
      if (width === this.tipSize.width && height === this.tipSize.height) return
      this.tipSize = { width, height }
      this.positionTooltip()
    })
  }

  /** Write the transform from the cached geometry. No reads, no layout. */
  private positionTooltip(): void {
    const at = this.tipAt
    if (at === null) return
    const pad = 14
    const { width, height } = this.tipSize
    const host = this.hostSize
    const left = at.x + pad + width > host.width ? at.x - pad - width : at.x + pad
    const top = at.y + pad + height > host.height ? at.y - pad - height : at.y + pad
    this.tooltip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, top)}px)`
  }

  /** Drop a measurement still waiting on the next frame: the panel is going away. */
  destroy(): void {
    if (this.tipFrame !== 0) cancelAnimationFrame(this.tipFrame)
  }
}

/**
 * One side of the hover readout. At bin level the position inside the contig is
 * exact arithmetic from the bin size (§3.3) — `/bins` is never consulted.
 */
function describeAxis(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  blockStart: number,
): string {
  if (group === undefined) return '—'
  // A cell that several small sequences share has no position inside any one of
  // them, so it is named by what it holds rather than by a coordinate. Saying
  // `Contig_184898:0 bp` there names one of two sequences and invents a
  // coordinate for it; the pixel is both, and the readout says so.
  if (group.merged !== undefined && group.merged.length > 1) {
    const [first, ...rest] = group.merged
    return rest.length === 1
      ? `${first.label} + ${rest[0].label}`
      : `${first.label} + ${fmt.int(rest.length)} more`
  }
  if (level !== 'bin') return group.label
  // `formatPosition`, so the bin under the pointer is named the way every
  // other coordinate on screen is: 1-based, grouped (§26.1). It used to print
  // the 0-based bin start, so hovering a cell said `1,162,000` while dragging
  // from the same pixel said `1,162,001` and the browser cell agreed with the
  // drag — the app off by a base on the one number a reader writes down.
  return formatPosition(group.label, bpWithin(group, offset, blockStart, binsize))
}

/**
 * The offset inside a block, without its name — the tooltip's second line.
 *
 * `null` above bin level, where a cell *is* the block and a position inside it
 * would be an invention.
 */
function positionIn(
  group: AxisGroup | undefined,
  offset: number,
  level: 'bin' | 'contig' | 'genome',
  binsize: number,
  blockStart: number,
): string | null {
  if (group === undefined || level !== 'bin') return null
  // The bin's first base, 1-based, as {@link formatPosition} writes it — the
  // contig is on the line above, so the number goes on its own, through the
  // helper that writes it without the name.
  return baseLabel(bpWithin(group, offset, blockStart, binsize))
}
