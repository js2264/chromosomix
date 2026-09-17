/**
 * What a cell of the deck has to be, when it is not a map (§16.11, §25).
 *
 * A deck was *N maps*: a lead and companions that were each a file and a
 * worker, and the deck called a dozen things on a `MapPanel` by name. Two
 * cells are now not maps — a **structure**, drawing the session's 3D model,
 * and a **stack of tracks**, drawing the session's tracks alone — and neither
 * has a worker, a block, a colour scale or a bin size. Rather than teach every
 * one of those dozen calls a second and third shape, the deck asks a non-map
 * cell only what every cell can answer, which is this interface, and keeps its
 * map-only calls on the maps.
 *
 * A vacancy is deliberately *not* one of these: it has nothing to apply a view
 * to and nothing to export, and giving it a `destroy` that does nothing would
 * be the "panel with no file" branch `VacantPanel`'s own docblock refuses.
 */

import type { LocusWindow } from '../render/locus'
import type { ViewState } from '../types'
import type { PickHandlers } from '../ui/mapPick'
import type { Command } from '../ui/commands'

export type DeckCellKind = 'structure' | 'tracks'

export interface DeckCell {
  readonly kind: DeckCellKind
  readonly el: HTMLElement
  /** Adopt the shared view — what the deck is looking at. */
  apply(state: ViewState): void
  /**
   * The lead's window moved: which stretches of sequence are on screen, per
   * axis, or `null` where the lead has none (a table, no block yet).
   *
   * One way. A cell that lights what is in the window never reports one
   * back, which is what keeps it out of the lock's feedback loop.
   */
  applyWindow(windows: { rows: LocusWindow[]; cols: LocusWindow[] } | null): void
  remeasure(): void
  repaint(): void
  /** The heading's name may have changed. */
  syncName(): void
  /** The picture at an export dpi, or `null` where there is nothing to draw. */
  exportCanvas(dpi: number, now: Date): HTMLCanvasElement | null
  /**
   * Another surface's pointer, as a mark at that place (§25.4), or `null` to
   * clear it. Optional: a cell that subscribes to the hover store itself, as
   * the structure cell does, has no use for the deck's relay.
   */
  showLocusEcho?(locus: { contig: string; bp: number } | null): void
  /**
   * Draw this structure row, of the several the session may hold (§25). Only
   * a structure cell answers; the deck asks the one it has.
   */
  showModel?(id: string): void
  /** The structure row the cell is drawing, or `null`. A structure cell only. */
  shownModel?(): string | null
  /** The cell's settings as a card for the Aesthetics panel (§25.3). A structure cell only. */
  settings?(): HTMLElement
  /** What the cell can be told to do, with keys, for the palette (§25.3). */
  commands?(): Command[]
  /**
   * Take part in a picking mode (`ui/mapPick.ts`): a click names a place for
   * the card that armed it, until it is cancelled. Optional, for a cell that
   * has places to click on.
   */
  armPicking?(handlers: PickHandlers, onEnd: () => void): () => void
  destroy(): void
}
