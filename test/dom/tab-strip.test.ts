// @vitest-environment jsdom
/**
 * The tab strip, and the two gestures it has that are not a click: renaming,
 * and carrying a tab along the strip to move it.
 *
 * A tab is labelled by its file, which is the right default and a poor name for
 * the work: four tabs reading `matrix_1000.mcool` off four runs are four
 * identical labels whose only distinguishing part is the one they share. So a
 * tab can be called something, and three things about that are worth holding to.
 *
 * **The three ways out are three answers.** Enter commits what is in the box,
 * *including nothing* — that is how a name is taken back off. Escape reports
 * nothing at all, so a cleared box that changed its mind is not a rename to
 * blank. Blur commits, because clicking away from a box you have typed into
 * means what you typed everywhere else in this application.
 *
 * **A rebuild must not eat the edit.** The strip is rendered from a list on every
 * change, and the changes that arrive while somebody is typing a name are not
 * theirs — a track finishing, a companion's clip moving, a read settling. The
 * box has to survive those with its text, and the `blur` its removal provokes
 * must not be read as the reader clicking away.
 *
 * **A tab with nothing open cannot be named at all**, because the name is kept
 * against the file: one given to an empty tab would be written under a key
 * nothing reads and would look as though it had been forgotten.
 *
 * **A carry is a click until it travels** (§5.6), and once it has, the click
 * that ends it is not one: a tab carried is not selected, since selecting a
 * remembered tab reads its file. It reports one move, on the drop, against the
 * list the strip was last given — a rebuild while the tab is in the hand is
 * held, not drawn over it — and Escape reports nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TabStrip, type TabSpec } from '@/app/TabStrip'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

interface Mounted {
  strip: TabStrip
  render(tabs: readonly Partial<TabSpec>[]): void
  renames: () => Array<{ index: number; name: string }>
  moves: () => Array<[number, number]>
  selects: () => number[]
  labels: () => string[]
  box: () => HTMLInputElement | null
}

function tab(spec: Partial<TabSpec>, index: number): TabSpec {
  return {
    id: spec.id ?? `s${index + 1}`,
    label: spec.label ?? 'yeast.cool',
    hint: spec.hint ?? 'https://example.org/yeast.cool',
    nameable: spec.nameable ?? true,
    named: spec.named ?? false,
    active: spec.active ?? index === 0,
    pending: spec.pending ?? false,
  }
}

function mount(): Mounted {
  const renames: Array<{ index: number; name: string }> = []
  const moves: Array<[number, number]> = []
  const selects: number[] = []
  const strip = new TabStrip({
    onSelect: (index) => selects.push(index),
    onClose: () => undefined,
    onNew: () => undefined,
    onRename: (index, name) => renames.push({ index, name }),
    onMove: (from, to) => moves.push([from, to]),
  })
  document.body.append(strip.el)
  return {
    strip,
    render: (tabs) => strip.render(tabs.map(tab), true),
    renames: () => renames,
    moves: () => moves,
    selects: () => selects,
    labels: () =>
      [...strip.el.querySelectorAll('.tab-label')].map((node) => node.textContent ?? ''),
    box: () => strip.el.querySelector<HTMLInputElement>('.tab-rename'),
  }
}

/**
 * The double-click a reader makes on the label — as two clicks, which is what it
 * is, and re-read from the DOM between them.
 *
 * The strip counts the pair itself, by tab id and time, rather than leaning on
 * `dblclick` or on a `MouseEvent`'s click count: selecting a tab repaints the
 * strip, so on any tab that was not already in front the two clicks land on two
 * different buttons and the browser's own answer is that they were not a pair.
 */
function doubleClick(strip: TabStrip, index = 0): void {
  for (let click = 0; click < 2; click++) {
    const label = strip.el.querySelectorAll<HTMLElement>('.tab-label')[index]
    label.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  }
}

function press(box: HTMLInputElement, key: string): void {
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('naming a tab', () => {
  it('opens a box in the label’s place on a double click', () => {
    const strip = mount()
    strip.render([{ label: 'yeast.cool' }])
    expect(strip.box()).toBeNull()
    doubleClick(strip.strip)
    const box = strip.box()
    expect(box).not.toBeNull()
    // The label is *replaced*, not hidden beside it: two things naming the same
    // tab is two widths, and the strip is a fixed row.
    expect(strip.labels()).toEqual([])
    // Empty, with the file as the placeholder — a reader who types is naming it,
    // and one who presses Enter on the file's own name has named nothing.
    expect(box?.value).toBe('')
    expect(box?.getAttribute('placeholder')).toBe('yeast.cool')
    // Named in the reader's word, which is what a screen reader says (§5.6):
    // it said *Session name*, a word the strip never shows.
    expect(box?.getAttribute('aria-label')).toBe('Tab name')
  })

  it('opens on the name there is, when there is one', () => {
    const strip = mount()
    strip.render([{ label: 'wild type', named: true }])
    doubleClick(strip.strip)
    expect(strip.box()?.value).toBe('wild type')
  })

  it('commits what was typed on Enter', () => {
    const strip = mount()
    strip.render([{ label: 'yeast.cool' }])
    doubleClick(strip.strip)
    const box = strip.box() as HTMLInputElement
    box.value = 'wild type'
    press(box, 'Enter')
    expect(strip.renames()).toEqual([{ index: 0, name: 'wild type' }])
    // …and puts the label back, so the strip is a strip again.
    expect(strip.box()).toBeNull()
    expect(strip.labels()).toEqual(['yeast.cool'])
  })

  it('commits an empty box, which is how a name comes off', () => {
    const strip = mount()
    strip.render([{ label: 'wild type', named: true }])
    doubleClick(strip.strip)
    const box = strip.box() as HTMLInputElement
    box.value = ''
    press(box, 'Enter')
    expect(strip.renames()).toEqual([{ index: 0, name: '' }])
  })

  it('reports nothing at all on Escape', () => {
    const strip = mount()
    strip.render([{ label: 'wild type', named: true }])
    doubleClick(strip.strip)
    const box = strip.box() as HTMLInputElement
    box.value = ''
    press(box, 'Escape')
    // A cleared box that changed its mind is not a rename to blank — without
    // this there would be no gesture for abandoning one.
    expect(strip.renames()).toEqual([])
    expect(strip.labels()).toEqual(['wild type'])
  })

  it('commits on blur, like every other box in the app', () => {
    const strip = mount()
    strip.render([{ label: 'yeast.cool' }])
    doubleClick(strip.strip)
    const box = strip.box() as HTMLInputElement
    box.value = 'run 4'
    box.dispatchEvent(new window.FocusEvent('blur'))
    expect(strip.renames()).toEqual([{ index: 0, name: 'run 4' }])
  })

  it('answers only once, however many ways out arrive', () => {
    const strip = mount()
    strip.render([{ label: 'yeast.cool' }])
    doubleClick(strip.strip)
    const box = strip.box() as HTMLInputElement
    box.value = 'run 4'
    press(box, 'Enter')
    box.dispatchEvent(new window.FocusEvent('blur'))
    expect(strip.renames()).toHaveLength(1)
  })

  it('is not offered on a tab with nothing open', () => {
    const strip = mount()
    strip.render([{ label: 'New tab', nameable: false }])
    doubleClick(strip.strip)
    expect(strip.box()).toBeNull()
    // Nor through the palette's door, which arrives holding an id.
    strip.strip.beginRename('s1')
    expect(strip.box()).toBeNull()
  })

  it('opens on a tab that was not already in front', () => {
    // The regression this is written against: selecting a tab repaints the
    // strip, which replaces the very button between the two clicks — and a
    // `dblclick` is only synthesised when both land on the same element. So the
    // gesture fired on the tab you were already reading and nowhere else, which
    // is the one tab you least need to rename.
    const renames: Array<{ index: number; name: string }> = []
    let tabs: TabSpec[] = [tab({ id: 'a' }, 0), tab({ id: 'b', active: false }, 1)]
    const strip: TabStrip = new TabStrip({
      onSelect: (index) => {
        // What the shell does: activate, then rebuild the whole strip.
        tabs = tabs.map((held, at) => ({ ...held, active: at === index }))
        strip.render(tabs, true)
      },
      onClose: () => undefined,
      onNew: () => undefined,
      onRename: (index, name) => renames.push({ index, name }),
      onMove: () => undefined,
    })
    document.body.append(strip.el)
    strip.render(tabs, true)

    for (let click = 0; click < 2; click++) {
      strip.el
        .querySelectorAll<HTMLElement>('.tab-label')[1]
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    }
    const box = strip.el.querySelector<HTMLInputElement>('.tab-rename')
    expect(box).not.toBeNull()
    ;(box as HTMLInputElement).value = 'run 4'
    box?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(renames).toEqual([{ index: 1, name: 'run 4' }])
  })

  it('opens from the command palette, by id', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }])
    strip.strip.beginRename('b')
    expect(strip.box()).not.toBeNull()
    expect(strip.labels()).toHaveLength(1)
  })
})

describe('a rebuild while a name is being typed', () => {
  it('keeps the box, and what was typed into it', () => {
    const strip = mount()
    strip.render([{ label: 'yeast.cool' }])
    doubleClick(strip.strip)
    const box = strip.box() as HTMLInputElement
    box.value = 'wild ty'
    box.dispatchEvent(new window.Event('input'))
    // A track finishing, a clip moving, a read settling: none of them the reader.
    strip.render([{ label: 'yeast.cool' }])
    expect(strip.box()?.value).toBe('wild ty')
    // …and the box being taken out of the document is not a click away.
    expect(strip.renames()).toEqual([])
  })

  it('lets the tab go when the tab goes', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }])
    strip.strip.beginRename('b')
    ;(strip.box() as HTMLInputElement).value = 'run 4'
    strip.box()?.dispatchEvent(new window.Event('input'))
    strip.render([{ id: 'a' }])
    // There is nothing left to name, and nothing is reported about it.
    expect(strip.box()).toBeNull()
    expect(strip.renames()).toEqual([])
  })
})

/**
 * Lay the strip out as a browser would, which jsdom does not: every tab 80 px
 * wide on a 100 px pitch from x = 20, in the order the document has them, so a
 * tab moved in the row is measured where it now stands. The row itself spans
 * the window. A carried tab's own shift is not counted, as a browser's box for
 * a transformed node is — the strip strips the shift before it measures.
 */
function layOut(): () => void {
  const real = window.HTMLElement.prototype.getBoundingClientRect
  const spy = vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('tabs')) return new window.DOMRect(0, 0, 2000, 30)
    if (!this.classList.contains('tab')) return real.call(this)
    const at = [...(this.parentElement?.children ?? [])].indexOf(this)
    return new window.DOMRect(20 + 100 * at, 0, 80, 30)
  })
  return () => spy.mockRestore()
}

function pointer(type: string, target: EventTarget, x: number, options: PointerEventInit = {}): void {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: x,
      clientY: 10,
      ...options,
    }),
  )
}

/** A press on tab `index`'s label at `from`, carried in steps to `to` — and let go, unless told to hold. */
function carry(strip: TabStrip, index: number, from: number, to: number, hold = false): HTMLElement {
  const label = strip.el.querySelectorAll<HTMLElement>('.tab-label')[index]
  pointer('pointerdown', label, from)
  const steps = 6
  for (let step = 1; step <= steps; step++) pointer('pointermove', window, from + ((to - from) * step) / steps)
  if (!hold) {
    const id = label.closest<HTMLElement>('.tab')?.dataset['tab'] ?? ''
    pointer('pointerup', window, to)
    // The click a browser fires to end the press: on the button it began on,
    // which a drop's redraw has taken out of the document, and — the worst a
    // browser could do — on that tab's label as it now stands.
    label.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    const now = strip.el.querySelector<HTMLElement>(`.tab[data-tab="${id}"] .tab-label`)
    if (now !== null && now !== label) now.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  }
  return label
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

const order = (strip: TabStrip): string[] =>
  [...strip.el.querySelectorAll<HTMLElement>('.tab')].map((node) => node.dataset['tab'] ?? '')

describe('carrying a tab along the strip', () => {
  let restore: () => void
  beforeEach(() => {
    restore = layOut()
  })
  afterEach(async () => {
    restore()
    // The swallow a drop leaves for its own click lasts until the next task.
    await tick()
  })

  it('stands it past the middles it is carried over, and reports one move on the drop', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: false }])
    // From a's middle to past c's (260): a lands last.
    carry(strip.strip, 0, 60, 290, true)
    // The row closes up behind it while it is held, so the gap is the answer.
    expect(order(strip.strip)).toEqual(['b', 'c', 'a'])
    expect(strip.strip.el.querySelector('.tab.is-carried')?.getAttribute('data-tab')).toBe('a')
    expect(document.body.classList.contains('is-carrying-tab')).toBe(true)
    expect(strip.moves()).toEqual([])
    pointer('pointerup', window, 290)
    expect(strip.moves()).toEqual([[0, 2]])
    expect(document.body.classList.contains('is-carrying-tab')).toBe(false)
    expect(strip.strip.el.querySelector('.is-carried')).toBeNull()
  })

  it('moves one leftwards as well', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: false }])
    carry(strip.strip, 2, 260, 40)
    expect(strip.moves()).toEqual([[2, 0]])
  })

  it('does not select the tab it carried, nor count towards a rename', async () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }])
    carry(strip.strip, 1, 160, 40)
    // Selecting a remembered tab reads its file; moving it is not asking for that.
    expect(strip.selects()).toEqual([])
    expect(strip.moves()).toEqual([[1, 0]])
    // …and only that click is swallowed: the next is a click, and one alone.
    await tick()
    strip.strip.el.querySelectorAll<HTMLElement>('.tab-label')[0].dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    )
    expect(strip.selects()).toEqual([0])
    expect(strip.box()).toBeNull()
  })

  it('is a click until it travels', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }])
    carry(strip.strip, 1, 160, 163)
    expect(strip.moves()).toEqual([])
    expect(strip.selects()).toEqual([1])
  })

  it('reports nothing when let go where it started', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: false }])
    carry(strip.strip, 1, 160, 190)
    expect(strip.moves()).toEqual([])
    expect(order(strip.strip)).toEqual(['a', 'b', 'c'])
  })

  it('puts it back on Escape', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: false }])
    carry(strip.strip, 0, 60, 290, true)
    expect(order(strip.strip)).toEqual(['b', 'c', 'a'])
    const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(order(strip.strip)).toEqual(['a', 'b', 'c'])
    pointer('pointerup', window, 290)
    expect(strip.moves()).toEqual([])
  })

  it('holds a rebuild back while the tab is in the hand, and lands against the list it was given', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: false }])
    carry(strip.strip, 0, 60, 290, true)
    // A track finishing in another tab: the strip is told again, with a new tab
    // on the end and a label changed.
    strip.render([
      { id: 'a' },
      { id: 'b', active: false, label: 'renamed' },
      { id: 'c', active: false },
      { id: 'd', active: false },
    ])
    // Not drawn over the tab being carried…
    expect(order(strip.strip)).toEqual(['b', 'c', 'a'])
    expect(strip.labels()).not.toContain('renamed')
    pointer('pointerup', window, 290)
    // …and drawn on the drop, with the move reported against it: after c, which
    // in the new list is before d.
    expect(strip.labels()).toContain('renamed')
    expect(strip.moves()).toEqual([[0, 2]])
  })

  it('is not taken by the ×, a finger, or a strip of one', () => {
    const strip = mount()
    strip.render([{ id: 'a' }, { id: 'b', active: false }])
    const close = strip.strip.el.querySelector<HTMLElement>('.tab-close') as HTMLElement
    pointer('pointerdown', close, 90)
    pointer('pointermove', window, 200)
    pointer('pointerup', window, 200)
    expect(strip.strip.el.querySelector('.is-carried')).toBeNull()

    const label = strip.strip.el.querySelectorAll<HTMLElement>('.tab-label')[0]
    pointer('pointerdown', label, 60, { pointerType: 'touch' })
    pointer('pointermove', window, 200, { pointerType: 'touch' })
    expect(strip.strip.el.querySelector('.is-carried')).toBeNull()
    pointer('pointerup', window, 200, { pointerType: 'touch' })
    expect(strip.moves()).toEqual([])

    strip.render([{ id: 'a' }])
    carry(strip.strip, 0, 60, 300)
    expect(strip.moves()).toEqual([])
  })

  it('says so on the label, where there is another tab to move past', () => {
    const strip = mount()
    strip.render([{ id: 'a' }])
    expect(strip.strip.el.querySelector('.tab-label')?.getAttribute('title')).not.toContain('drag')
    strip.render([{ id: 'a' }, { id: 'b', active: false, nameable: false }])
    const [first, second] = strip.strip.el.querySelectorAll('.tab-label')
    expect(first.getAttribute('title')).toContain('Double-click to rename this tab, or drag it along the strip to move it.')
    expect(second.getAttribute('title')).toContain('Drag it along the strip to move it.')
  })
})
