/**
 * The bar under a deck cell that sets its height (§25.3).
 *
 * A structure cell and a tracks cell are as tall as the row gives them, which
 * is right in a row *beside* a map — the cells line up — and wrong in a column
 * **under** one, where the row is whatever the tallest cell asks for and a
 * model or a stack of tracks got the 16 rem floor and nothing more. Neither has
 * a block to keep square, so their height is the reader's business: this bar,
 * dragged, holds the picture at the height the hand let go at; double-clicked,
 * gives it back to the row; and the arrow keys step it, for a hand that is not
 * on a mouse.
 *
 * One control for both cells, so the gesture, the limits and the words are the
 * same wherever it appears. What the height *is* — which element holds it, and
 * where it is remembered — is each cell's own: the structure cell lends its
 * picture to the enlarged dialog and back, so the height lives on the cell and
 * never on the picture (`panels/StructurePanel.ts`).
 */

import { el } from '../ui/dom'

/** The shortest a resized cell may be, in pixels — below this the picture is not one. */
export const CELL_MIN_H = 120

/** The tallest, so a drag cannot push the rest of the page off the screen. */
export const CELL_MAX_H = 2000

/** How far one press of an arrow key moves the bar, in pixels. */
const KEY_STEP = 24

/** A height held inside the two limits, in whole pixels. */
export function clampCellHeight(height: number): number {
  return Math.round(Math.min(CELL_MAX_H, Math.max(CELL_MIN_H, height)))
}

/** A height remembered in storage, if it is one a cell can take; `null` otherwise. */
export function cellHeightOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clampCellHeight(value) : null
}

export interface HeightBarOptions {
  /** The bar's own class, beside the shared `cell-resize`: which cell it is under. */
  className: string
  /** The picture the height is measured from: the bar sets where its bottom is. */
  picture(): HTMLElement
  /** Hold the picture at this height while the hand moves, or give it back to the row. */
  preview(height: number | null): void
  /** The height settled — a drag let go, a double-click, a key: hold it and remember it. */
  commit(height: number | null): void
}

/** The bar itself, wired: drag, double-click, arrow keys. */
export function heightBar(options: HeightBarOptions): HTMLElement {
  const bar = el('div', {
    class: `cell-resize ${options.className}`,
    attrs: { role: 'separator', 'aria-orientation': 'horizontal', tabindex: '0' },
    title: 'Drag to make this cell taller or shorter · double-click to fit the row again',
  })
  bar.addEventListener('pointerdown', (event) => {
    bar.setPointerCapture(event.pointerId)
    bar.classList.add('is-dragging')
    event.preventDefault()
    const from = options.picture().getBoundingClientRect()
    const heightAt = (clientY: number): number => clampCellHeight(clientY - from.top)
    const move = (moved: PointerEvent): void => options.preview(heightAt(moved.clientY))
    const up = (ended: PointerEvent): void => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      bar.classList.remove('is-dragging')
      if (bar.hasPointerCapture(ended.pointerId)) bar.releasePointerCapture(ended.pointerId)
      options.commit(heightAt(ended.clientY))
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
  })
  // Back to the row's own height, which is the state there is no other way
  // out of once a height has been set.
  bar.addEventListener('dblclick', () => options.commit(null))
  bar.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowUp' ? -KEY_STEP : event.key === 'ArrowDown' ? KEY_STEP : 0
    if (step === 0) return
    event.preventDefault()
    options.commit(clampCellHeight(options.picture().getBoundingClientRect().height + step))
  })
  return bar
}
