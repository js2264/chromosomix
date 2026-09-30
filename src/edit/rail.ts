/**
 * The rail (SPECS §27.3): beside the map, each suggestion's label at the
 * height of what it concerns, with a leader to a bracket that spans it, packed
 * so that no two labels overlap.
 *
 * It is the list, laid along the map: a reader reading down the map reads down
 * the rail, and a suggestion's label is where its evidence is. Hovering a label
 * lights its marks on the map, and hovering a mark lights its label — one
 * highlight in two places, the stage keeping which is lit. A press frames it.
 */

import { el } from '../ui/dom'
import type { StageInk } from './draw'

/** A suggestion as the rail shows it. */
export interface RailItem {
  key: string
  number: number
  /** Its label: kind and confidence. */
  text: string
  /** What it would do, in full. */
  title: string
  /** The stretch of the axis it concerns, lowest first, in units. */
  extent: readonly [number, number]
  lit: boolean
  /** The one review mode is on. */
  current: boolean
}

/** A label's height, and the least room between two, in pixels. */
const LABEL = 20
const GAP = 3
/** Where the brackets stand, from the rail's right edge. */
const BRACKET = 7

/** Where each label goes: at the middle of what it concerns, pushed apart, and kept inside the rail. */
export function packLabels(wanted: readonly number[], height: number, label = LABEL, gap = GAP): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  const top = new Array<number>(wanted.length)
  let floor = 0
  for (const { y, i } of order) {
    top[i] = Math.max(floor, Math.min(height - label, y - label / 2))
    floor = top[i] + label + gap
  }
  // Pushed off the bottom, the last few come back up, each above the next.
  let ceiling = height - label
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k].i
    if (top[i] > ceiling) top[i] = ceiling
    ceiling = top[i] - label - gap
  }
  return top.map((t) => Math.max(0, t))
}

export class Rail {
  readonly element: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly labels: HTMLElement
  private width = 0
  private height = 0

  constructor(private readonly on: { hover(key: string | null): void; pick(key: string): void }) {
    this.canvas = el('canvas', { class: 'edit-rail-canvas' })
    this.labels = el('div', { class: 'edit-rail-labels' })
    this.element = el('div', { class: 'edit-rail', attrs: { role: 'list', 'aria-label': 'Suggestions along the map' } }, this.canvas, this.labels)
    this.element.addEventListener('pointerleave', () => this.on.hover(null))
  }

  /** Where the rail sits in the plot, in CSS pixels. */
  place(x: number, y: number, width: number, height: number, dpr: number): void {
    this.width = width
    this.height = height
    for (const node of [this.element, this.canvas]) {
      node.style.width = `${width}px`
      node.style.height = `${height}px`
    }
    this.element.style.left = `${x}px`
    this.element.style.top = `${y}px`
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** Draw the items along the map, whose rows `toY` places. */
  paint(items: readonly RailItem[], toY: (unit: number) => number, ink: StageInk): void {
    const width = this.width
    const height = this.height
    const ctx = this.canvas.getContext('2d')
    ctx?.clearRect(0, 0, width, height)
    // Only what is in view: a label pointing off the map points at nothing.
    const shown = items
      .map((item) => {
        const a = toY(item.extent[0])
        const b = toY(item.extent[1])
        return { item, y0: Math.max(0, Math.min(a, b)), y1: Math.min(height, Math.max(a, b)), inView: Math.max(a, b) >= 0 && Math.min(a, b) <= height }
      })
      .filter((row) => row.inView)
    const tops = packLabels(
      shown.map((row) => (row.y0 + row.y1) / 2),
      height,
    )
    const bracketX = width - BRACKET
    const labelRight = width - BRACKET - 12
    if (ctx !== null) {
      ctx.lineCap = 'round'
      shown.forEach((row, i) => {
        const strong = row.item.lit || row.item.current
        ctx.globalAlpha = strong ? 1 : 0.55
        ctx.strokeStyle = ink.accent
        ctx.lineWidth = strong ? 2.5 : 1.5
        // The bracket: what it concerns, along the map's rows.
        const y0 = row.y0
        const y1 = Math.max(row.y1, y0 + 2)
        ctx.beginPath()
        ctx.moveTo(bracketX - 4, y0)
        ctx.lineTo(bracketX, y0)
        ctx.lineTo(bracketX, y1)
        ctx.lineTo(bracketX - 4, y1)
        ctx.stroke()
        // The leader, from the label to the bracket's middle.
        const ly = tops[i] + LABEL / 2
        const my = (y0 + y1) / 2
        ctx.lineWidth = strong ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(labelRight, ly)
        ctx.lineTo(labelRight + 5, ly)
        ctx.lineTo(bracketX - 5, my)
        ctx.stroke()
        ctx.globalAlpha = 1
      })
    }
    this.labels.replaceChildren(
      ...shown.map((row, i) => {
        const { item } = row
        const label = el('button', {
          class: `edit-rail-label${item.lit ? ' is-lit' : ''}${item.current ? ' is-current' : ''}`,
          title: `${item.title} — press to frame it`,
          attrs: { type: 'button', role: 'listitem', 'data-key': item.key },
          style: { top: `${tops[i]}px`, right: `${width - labelRight}px`, height: `${LABEL}px` },
          on: {
            pointerenter: () => this.on.hover(item.key),
            focus: () => this.on.hover(item.key),
            blur: () => this.on.hover(null),
            click: () => this.on.pick(item.key),
          },
        })
        label.append(el('span', { class: 'edit-rail-number', text: String(item.number) }), el('span', { text: item.text }))
        return label
      }),
    )
  }
}
