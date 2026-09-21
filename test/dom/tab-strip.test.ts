// @vitest-environment jsdom
/**
 * The tab strip, and the one gesture it has that is not a click: renaming.
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
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
  const strip = new TabStrip({
    onSelect: () => undefined,
    onClose: () => undefined,
    onNew: () => undefined,
    onRename: (index, name) => renames.push({ index, name }),
  })
  document.body.append(strip.el)
  return {
    strip,
    render: (tabs) => strip.render(tabs.map(tab), true),
    renames: () => renames,
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
