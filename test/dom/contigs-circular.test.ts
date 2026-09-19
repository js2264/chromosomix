// @vitest-environment jsdom
/**
 * *This sequence is circular*, as a column of the Chromosomes table (§8.15).
 *
 * The declaration used to be a tickbox on the map's own card, which could only
 * ever ask about the one sequence on screen and gave a reader no way to read
 * back which sequences had been declared. It is a column of its own now, last
 * after everything the file brought, on a table where every sequence is a row —
 * so what is worth checking is that the boxes
 * are the store's, in both directions: a click writes, and a write from anywhere
 * else re-ticks them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContigsTable, type CircularColumn } from '@/ui/ContigsTable'
import type { ContigsResult } from '@/worker/protocol'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const NAMES = ['chr', 'plasmid_A', 'plasmid_B']
const LENGTHS = [4_000_000, 90_000, 5_000]

const DATA: ContigsResult = {
  table: {
    length: NAMES.length,
    columns: ['name', 'length'],
    data: { name: [...NAMES], length: Float64Array.from(LENGTHS) },
  },
}

/** A store of the shape the session hands over, with its listeners. */
function store(): CircularColumn & { names: Set<string> } {
  const names = new Set<string>()
  const listeners = new Set<() => void>()
  return {
    names,
    has: (name) => names.has(name),
    set: (name, on) => {
      if (on) names.add(name)
      else names.delete(name)
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function table(circular?: CircularColumn): ContigsTable {
  const view = new ContigsTable({
    data: DATA,
    title: 'Chromosomes',
    ...(circular === undefined ? {} : { circular }),
    onOpenContig: () => {},
  })
  document.body.appendChild(view.el)
  return view
}

/** The tick boxes of the circular column, in row order. */
function boxes(view: ContigsTable): HTMLInputElement[] {
  return [...view.el.querySelectorAll<HTMLElement>('.tr')].map((row) => {
    const cell = row.querySelector<HTMLInputElement>('.td-check .tcheck')
    if (cell === null) throw new Error('no circular box on this row')
    return cell
  })
}

describe('the circular column', () => {
  it('is absent where the session offers no store', () => {
    const view = table()
    expect([...view.el.querySelectorAll('.th')].map((cell) => cell.textContent)).not.toContain(
      'circular',
    )
    view.destroy()
  })

  it('sits last, after every column the file brought', () => {
    const view = table(store())
    const heads = [...view.el.querySelectorAll('.th')].map((cell) => cell.textContent)
    expect(heads).toEqual(['name', 'length', 'circular'])
    view.destroy()
  })

  it('writes the declaration when a box is ticked', () => {
    const held = store()
    const view = table(held)
    const box = boxes(view)[1]
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect([...held.names]).toEqual(['plasmid_A'])
    view.destroy()
  })

  it('does not open the sequence when the box is clicked', () => {
    const held = store()
    let opened: string | null = null
    const view = new ContigsTable({
      data: DATA,
      circular: held,
      onOpenContig: (name) => {
        opened = name
      },
    })
    document.body.appendChild(view.el)
    boxes(view)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(opened).toBeNull()
    view.destroy()
  })

  it('re-ticks when the declaration changes somewhere else', () => {
    const held = store()
    const view = table(held)
    expect(boxes(view)[2].checked).toBe(false)
    held.set('plasmid_B', true)
    expect(boxes(view)[2].checked).toBe(true)
    view.destroy()
  })

  it('drops its listener with the table', () => {
    const held = store()
    const view = table(held)
    view.destroy()
    // The rows are gone; a store that still spoke to them would throw rather
    // than repaint nothing.
    expect(() => held.set('chr', true)).not.toThrow()
  })

  it('offers a tick, not a text box, to filter by', () => {
    const held = store()
    held.set('plasmid_A', true)
    const view = table(held)
    const only = view.el.querySelectorAll<HTMLInputElement>('.tf-check .tf-check-box')
    // One in the circular column; the selection gutter's own is absent here,
    // this table having been built without `onOpenSelection`.
    expect(only).toHaveLength(1)
    only[0].checked = true
    only[0].dispatchEvent(new Event('change'))
    const names = [...view.el.querySelectorAll('.tr')].map(
      (row) => row.querySelector('.td')?.textContent,
    )
    expect(names).toEqual(['plasmid_A'])
    view.destroy()
  })

  it('leaves the length where a reader expects it, beside the name', () => {
    const view = table(store())
    const first = view.el.querySelector('.tr')
    const cells = [...(first?.querySelectorAll('.td') ?? [])].map((cell) => cell.textContent)
    expect(cells.slice(0, 2)).toEqual(['chr', '4,000,000'])
    view.destroy()
  })
})
