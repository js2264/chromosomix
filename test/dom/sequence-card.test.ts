// @vitest-environment jsdom
/**
 * The Sequences card, as a reader meets it.
 *
 * One card serves two surfaces — the 1D browser's axis and a contact map's
 * picture — so what is asserted here is the part that is the same on both: a
 * tick and a name per sequence, a filter above a list too long to scan, a line
 * under it saying how many of how many are showing, and a way back to the whole
 * genome. What differs is the sentence a tick's tooltip says, which is a prop
 * and is checked as one.
 *
 * The behaviour worth pinning is the *shared model*. The boxes are a view of a
 * {@link SequenceSelection} and not a state of their own, so a change made
 * anywhere — the card, a navigation, `ensure` on a locus nobody ticked — has to
 * reach every box. The card that gets this wrong looks completely fine and lies
 * about what is on screen.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SequenceSelection } from '@/genome/selection'
import { BROWSER_TICKS, GENOME_TICKS, MAP_TICKS, sequenceCard } from '@/ui/SequenceCard'
import { all, buttonNamed, mounted, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const YEAST = [
  { name: 'I', length: 230_218 },
  { name: 'II', length: 813_184 },
  { name: 'III', length: 316_620 },
  { name: 'IV', length: 1_531_933 },
]

function card(
  selection = new SequenceSelection(),
  contigs = YEAST,
  copy: { tickTitle(name: string): string; clearTitle: string } = MAP_TICKS,
): { el: HTMLElement; selection: SequenceSelection; went: string[] } {
  const went: string[] = []
  const el = sequenceCard({
    contigs,
    selection,
    onGoTo: (name) => went.push(name),
    ...copy,
  })
  return { el, selection, went }
}

function ticks(root: ParentNode): HTMLInputElement[] {
  return all<HTMLInputElement>(root, '.seq-tick')
}

describe('the list', () => {
  it('is a tick and a name per sequence, longest bar to the longest', () => {
    const { el } = card()
    expect(textsOf(el, '.seq-name')).toEqual(['I', 'II', 'III', 'IV'])
    expect(ticks(el)).toHaveLength(4)
    // The bar is the length against the longest, so chromosome IV fills its row.
    const rows = all(el, '.seq-row')
    expect(rows[3].style.getPropertyValue('--seq-share')).toBe('100%')
    expect(rows[0].style.getPropertyValue('--seq-share')).toBe(
      `${(230_218 / 1_531_933) * 100}%`,
    )
  })

  // Sixteen chromosomes do not need a filter and four thousand scaffolds cannot
  // be scanned without one.
  it('grows a filter box only when the list is long enough to need one', () => {
    expect(all(card().el, '.seq-filter')).toHaveLength(0)
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `scaffold_${i}`, length: 1000 }))
    const long = card(new SequenceSelection(), many)
    expect(all(long.el, '.seq-filter')).toHaveLength(1)
  })

  it('narrows to what was typed, and says when nothing matches', () => {
    const many = [...YEAST, ...Array.from({ length: 20 }, (_, i) => ({ name: `s${i}`, length: 9 }))]
    const { el } = card(new SequenceSelection(), many)
    const filter = all<HTMLInputElement>(el, '.seq-filter')[0]
    filter.value = 'ii'
    filter.dispatchEvent(new Event('input'))
    expect(textsOf(el, '.seq-name')).toEqual(['II', 'III'])

    filter.value = 'chrZ'
    filter.dispatchEvent(new Event('input'))
    expect(textsOf(el, '.seq-name')).toEqual([])
    expect((el.querySelector('.seq-note')?.textContent ?? '').trim()).toBe('nothing by that name')
  })
})

describe('the ticks', () => {
  it('write straight through to the selection', () => {
    const { el, selection } = card()
    mounted(el, () => {
      ticks(el)[1].checked = true
      ticks(el)[1].dispatchEvent(new Event('change'))
      expect([...selection.names]).toEqual(['II'])
    })
  })

  /**
   * The half that is easy to get wrong: the card is not the only thing that
   * writes to the model. A navigation beside a map re-ticks whatever the new
   * picture is of, and a tick that appears in the model and not in the box is
   * the one state this card must never be in.
   */
  it('follow the selection when something else moves it', () => {
    const { el, selection } = card()
    mounted(el, () => {
      selection.set(['I', 'IV'])
      expect(ticks(el).map((box) => box.checked)).toEqual([true, false, false, true])
      expect(all(el, '.seq-row.is-on')).toHaveLength(2)

      selection.clear()
      expect(ticks(el).map((box) => box.checked)).toEqual([false, false, false, false])
    })
  })

  it('say how many of how many, and offer the way back', () => {
    const { el, selection } = card()
    mounted(el, () => {
      expect(el.querySelector('.seq-chosen')?.classList.contains('hidden')).toBe(true)
      selection.set(['I', 'II'])
      const chosen = el.querySelector('.seq-chosen')
      expect(chosen?.classList.contains('hidden')).toBe(false)
      // `2 of 4 ticked`, not `showing 2 of 4`: under a list, *showing* is read
      // as a count of the rows on screen, and beside a map framed on one window
      // it contradicts the breadcrumb.
      expect(chosen?.textContent).toContain('2 of 4 ticked')

      buttonNamed(el, 'show the whole genome')?.click()
      expect(selection.isWhole).toBe(true)
    })
  })

  /**
   * A card that has left the document has no way to be told it is dead, so it
   * lets go of the model the first time it is spoken to afterwards. Without
   * this every file opened in a long session leaves a listener behind on a
   * selection that outlives it.
   */
  it('let go of the model once they are off the page', () => {
    const { el, selection } = card()
    document.body.appendChild(el)
    selection.set(['I'])
    expect(ticks(el)[0].checked).toBe(true)
    el.remove()
    // Two writes: the first is the one the detached card unsubscribes on.
    selection.set(['II'])
    selection.set(['III'])
    expect(ticks(el)[0].checked).toBe(true)
  })
})

describe('the sentence a tick says', () => {
  it('is about the axis in a browser and about the picture beside a map', () => {
    const browser = card(new SequenceSelection(), YEAST, BROWSER_TICKS)
    expect(ticks(browser.el)[0].title).toContain('makes it the axis')
    const map = card(new SequenceSelection(), YEAST, MAP_TICKS)
    expect(ticks(map.el)[0].title).toContain('draws its block')
  })
})

describe('a click on the name', () => {
  it('goes there, and does not tick anything on the way', () => {
    const { el, selection, went } = card()
    mounted(el, () => {
      all<HTMLButtonElement>(el, '.seq-go')[2].click()
      expect(went).toEqual(['III'])
      expect(selection.isWhole).toBe(true)
    })
  })
})

describe('the circular mark (§8.15)', () => {
  /** A declaration of the shape the session hands over, with its listeners. */
  function declared(...names: string[]): {
    has(name: string): boolean
    subscribe(listener: () => void): () => void
    set(name: string, on: boolean): void
  } {
    const held = new Set(names)
    const listeners = new Set<() => void>()
    return {
      has: (name) => held.has(name),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: (name, on) => {
        if (on) held.add(name)
        else held.delete(name)
        for (const listener of listeners) listener()
      },
    }
  }

  function withCircular(
    circular: ReturnType<typeof declared>,
  ): { el: HTMLElement; circular: ReturnType<typeof declared> } {
    const el = sequenceCard({
      contigs: YEAST,
      selection: new SequenceSelection(),
      circular,
      onGoTo: () => {},
      ...MAP_TICKS,
    })
    return { el, circular }
  }

  it('rides inside the name of a declared sequence, and nowhere else', () => {
    const { el } = withCircular(declared('II'))
    mounted(el, () => {
      const marked = all(el, '.seq-row').map(
        (row) => row.querySelector('.seq-circular') !== null,
      )
      expect(marked).toEqual([false, true, false, false])
    })
  })

  it('is absent altogether where nothing was declared', () => {
    const { el } = withCircular(declared())
    mounted(el, () => {
      expect(all(el, '.seq-circular')).toHaveLength(0)
    })
  })

  it('says so in the row’s own tooltip', () => {
    const { el } = withCircular(declared('IV'))
    mounted(el, () => {
      expect(all<HTMLButtonElement>(el, '.seq-go')[3].title).toContain('read as a circle')
      expect(all<HTMLButtonElement>(el, '.seq-go')[0].title).not.toContain('circle')
    })
  })

  it('appears when the Chromosomes table declares one', () => {
    const { el, circular } = withCircular(declared())
    mounted(el, () => {
      circular.set('III', true)
      const marked = all(el, '.seq-row').map((row) => row.querySelector('.seq-circular') !== null)
      expect(marked).toEqual([false, false, true, false])
    })
  })

  it('leaves the card alone once it is off the page', () => {
    const { el, circular } = withCircular(declared())
    // Never mounted, so the listener unsubscribes itself the first time it is
    // spoken to — the same teardown the selection's listener has.
    expect(() => circular.set('I', true)).not.toThrow()
    expect(el.querySelector('.seq-circular')).toBeNull()
  })
})

describe('a metagenome’s list of genomes (§5.8)', () => {
  const GENOMES = Array.from({ length: 14 }, (_, at) => ({ name: `MAG_${at}`, length: 1_000_000 }))

  it('speaks of genomes, and its way back is the whole metagenome', () => {
    const selection = new SequenceSelection()
    const el = sequenceCard({ contigs: GENOMES, selection, onGoTo: () => {}, ...GENOME_TICKS })
    mounted(el, () => {
      expect(el.querySelector('.card-title, .card-head')?.textContent).toContain('Genomes')
      expect(el.querySelector<HTMLInputElement>('.seq-filter')?.placeholder).toBe('filter 14 genomes…')
      selection.set(['MAG_1'])
      buttonNamed(el, 'show the whole metagenome')?.click()
      expect(selection.isWhole).toBe(true)
    })
  })

  it('carries what it is handed between its title and its list — the level', () => {
    const level = document.createElement('div')
    level.className = 'seq-level'
    const el = sequenceCard({
      contigs: GENOMES,
      selection: new SequenceSelection(),
      onGoTo: () => {},
      head: [level],
      ...GENOME_TICKS,
    })
    const order = Array.from(el.children).map((child) => child.className)
    expect(order.indexOf('seq-level')).toBeGreaterThan(0)
    expect(order.indexOf('seq-level')).toBeLessThan(order.findIndex((name) => name.includes('seq-list')))
  })
})
