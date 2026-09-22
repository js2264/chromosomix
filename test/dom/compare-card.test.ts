// @vitest-environment jsdom
/**
 * The Contact maps card, and the gesture it has that is not a click: renaming.
 *
 * A map is labelled by its file, which is the right default and a poor name for
 * the work — two conditions being compared are `mat_G1.mcool::1000` and
 * `mat_G2M.mcool::1000`, whose two informative characters are the last thing
 * anybody reads. The name a reader gives instead is on the picture, in the
 * readout under the pointer and in the exported figure, so the box that sets it
 * has to behave the way every other name box in this application behaves.
 *
 * Which is: **Enter commits**, **Escape abandons**, and an **empty box hands the
 * map back to its file name**, because that is what makes a rename undoable.
 * The card is rendered from the session on every change, so what it *asks* for
 * is checked here rather than what it stores — the store is
 * `test/unit/map-names.test.ts`'s.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CompareCard } from '@/ui/CompareCard'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

interface Mounted {
  card: CompareCard
  renames: () => Array<{ which: 1 | 2; name: string | null }>
  boxes: () => HTMLInputElement[]
  names: () => string[]
}

function mount(options: { rename?: boolean } = {}): Mounted {
  const renames: Array<{ which: 1 | 2; name: string | null }> = []
  const labels: Record<1 | 2, string> = { 1: 'rep1.mcool::1000', 2: 'rep2.mcool::1000' }
  const card = new CompareCard({
    onOpen: () => undefined,
    onToggleShown: () => undefined,
    isShown: () => true,
    onClose: () => undefined,
    onSwap: () => undefined,
    primaryLabel: () => labels[1],
    secondLabel: () => labels[2],
    hasPrimary: () => true,
    ...(options.rename === false
      ? {}
      : {
          onRename: (which, name) => {
            renames.push({ which, name })
            // What the session does: the name is written down and the card is
            // asked to redraw from it.
            labels[which] = name ?? `rep${which}.mcool::1000`
            card.sync()
          },
        }),
  })
  card.set({
    kind: 'open',
    label: 'rep2.mcool::1000',
    info: {
      uri: 'https://example.org/rep2.mcool::/resolutions/1000',
      nContigs: 16,
      binsize: 1000,
      sourceBytes: 1024,
    } as never,
  })
  document.body.append(card.el)
  return {
    card,
    renames: () => renames,
    boxes: () => [...card.el.querySelectorAll<HTMLInputElement>('input.ann-name')],
    names: () =>
      [...card.el.querySelectorAll<HTMLElement>('.ann-name')].map((node) =>
        node instanceof HTMLInputElement ? node.value : (node.textContent ?? ''),
      ),
  }
}

/** Type into a box and leave it the way the reader does. */
function type(box: HTMLInputElement, text: string, key = 'Enter'): void {
  box.value = text
  box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  // Enter blurs the box, and it is the `change` a blur provokes that commits —
  // jsdom does not synthesise one, so the gesture is completed by hand.
  if (key === 'Enter') box.dispatchEvent(new Event('change'))
}

describe('naming the two maps', () => {
  it('offers a box per map, filled with what each is called', () => {
    const ui = mount()
    expect(ui.names()).toEqual(['rep1.mcool::1000', 'rep2.mcool::1000'])
    expect(ui.boxes()).toHaveLength(2)
  })

  it('reports what was typed, per map', () => {
    const ui = mount()
    type(ui.boxes()[0], 'G1 phase')
    expect(ui.renames()).toEqual([{ which: 1, name: 'G1 phase' }])
    type(ui.boxes()[1], 'G2/M phase')
    expect(ui.renames()[1]).toEqual({ which: 2, name: 'G2/M phase' })
    expect(ui.names()).toEqual(['G1 phase', 'G2/M phase'])
  })

  it('reads an empty box as "call it what its file is called"', () => {
    // `null` rather than `''`, because the two say different things: one hands
    // the map back to its file name and the other would be a name that is blank.
    const ui = mount()
    type(ui.boxes()[0], 'G1 phase')
    type(ui.boxes()[0], '   ')
    expect(ui.renames()[1]).toEqual({ which: 1, name: null })
    expect(ui.names()[0]).toBe('rep1.mcool::1000')
  })

  it('abandons on Escape, and puts the name back in the box', () => {
    const ui = mount()
    type(ui.boxes()[0], 'G1 phase', 'Escape')
    expect(ui.renames()).toEqual([])
    expect(ui.boxes()[0].value).toBe('rep1.mcool::1000')
  })

  it('reports nothing for a name that is the one it already has', () => {
    const ui = mount()
    type(ui.boxes()[0], 'rep1.mcool::1000')
    expect(ui.renames()).toEqual([])
  })

  it('draws plain text where a session offers no rename', () => {
    const ui = mount({ rename: false })
    expect(ui.boxes()).toHaveLength(0)
    expect(ui.names()).toEqual(['rep1.mcool::1000', 'rep2.mcool::1000'])
  })
})

/**
 * What the card asks for when there is nothing to compare against.
 *
 * §5.7's second file goes into the lower-left triangle **of an existing map**,
 * so with no map open there is no triangle and nothing to match a bin size
 * against. The card drew both rectangles anyway, the lower one promising that
 * triangle, and both of them opened the same file the same way — two
 * identical-looking targets and a reader wondering which their `.cool` belonged
 * on (§8.5: a control the file cannot answer is not shown).
 */
describe('a session with no map', () => {
  it('asks for a contact map, and for nothing to compare it with', () => {
    const card = new CompareCard({
      onOpen: () => undefined,
      onToggleShown: () => undefined,
      isShown: () => false,
      onClose: () => undefined,
      onSwap: () => undefined,
      primaryLabel: () => 'rep1.mcool::1000',
      hasPrimary: () => false,
    })
    document.body.append(card.el)
    const zones = [...card.el.querySelectorAll<HTMLElement>('.ann-drop')]
    expect(zones).toHaveLength(1)
    expect(zones[0].querySelector('.ann-drop-label')?.textContent).toBe('Load a contact map')
    expect(card.el.textContent).not.toContain('lower triangle')
  })

  it('offers the triangle once a map is open, named for where the file goes', () => {
    const ui = mount()
    ui.card.set({ kind: 'empty' })
    const zones = [...ui.card.el.querySelectorAll<HTMLElement>('.ann-drop')]
    expect(zones).toHaveLength(1)
    expect(zones[0].querySelector('.ann-drop-label')?.textContent).toBe(
      'Load a map into the lower triangle',
    )
    // The same last sentence every zone in the column says (§20.2).
    expect(zones[0].querySelector('.ann-drop-hint')?.textContent).toContain(
      'Drop one here, or click to choose.',
    )
  })
})
