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

import { ContigsTable, type CircularColumn, type OriginColumn } from '@/ui/ContigsTable'
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

  // A named toggle, not a text box and not a second bare checkbox. The box it
  // used to be was identical to the one in the selection gutter at the other end
  // of the same row, which ticks every row showing — one glyph, two verbs, told
  // apart only by hovering.
  it('offers a named toggle, not a text box, to filter by', () => {
    const held = store()
    held.set('plasmid_A', true)
    const view = table(held)
    const only = view.el.querySelectorAll<HTMLButtonElement>('.tf-only')
    expect(only).toHaveLength(1)
    expect(only[0].textContent).toBe('ticked')
    expect(view.el.querySelectorAll('.tfilter-row .tf-check-box')).toHaveLength(0)
    only[0].click()
    expect(only[0].getAttribute('aria-pressed')).toBe('true')
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

/**
 * The origin each sequence's arms are read from, beside the circle it is on
 * (§8.15) — and what the first open's junction test measured, on the box it
 * ticked.
 */
describe('the origin column', () => {
  function origins(): OriginColumn & { put(name: string, at: number): void } {
    const held = new Map<string, { at: number; by: 'reader' | 'task' }>()
    const listeners = new Set<() => void>()
    return {
      get: (name) => held.get(name),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      put: (name, at) => {
        held.set(name, { at, by: 'task' })
        for (const listener of listeners) listener()
      },
    }
  }

  function withOrigins(held: OriginColumn): ContigsTable {
    const view = new ContigsTable({ data: DATA, circular: store(), origins: held, onOpenContig: () => {} })
    document.body.appendChild(view.el)
    return view
  }

  const originCells = (view: ContigsTable): string[] =>
    [...view.el.querySelectorAll('.tr')].map((row) => {
      const cells = row.querySelectorAll('.td')
      return cells[cells.length - 1]?.textContent ?? ''
    })

  it('comes after the circle, 1-based, and is blank where nothing is declared', () => {
    const held = origins()
    held.put('chr', 6_374_500)
    const view = withOrigins(held)
    const heads = [...view.el.querySelectorAll('.th')].map((cell) => cell.textContent)
    expect(heads).toEqual(['name', 'length', 'circular', 'origin'])
    expect(originCells(view)).toEqual(['6,374,501', '', ''])
    view.destroy()
  })

  it('follows the store when a run places one', () => {
    const held = origins()
    const view = withOrigins(held)
    held.put('plasmid_A', 999)
    expect(originCells(view)[1]).toBe('1,000')
    view.destroy()
  })

  it('says on the box what the junction test measured', () => {
    const held = store()
    const measured: CircularColumn = { ...held, evidence: (name) => (name === 'chr' ? 0.65 : undefined) }
    held.set('chr', true)
    const view = table(measured)
    expect(boxes(view)[0].title).toContain('0.65×')
    expect(boxes(view)[1].title).not.toContain('×')
    view.destroy()
  })
})
