// @vitest-environment jsdom
/**
 * The small shared controls, and the DOM helpers underneath all of them.
 *
 * None of these is more than a hundred lines, which is exactly why they were
 * never tested: each one is obviously right by reading, and each one is also a
 * place where being obviously right and being right come apart. A stepper whose
 * disabled tooltip says "next" rather than the name it would have opened reads
 * as broken at the last genome instead of as finished. A theme toggle that
 * writes `data-theme="system"` gives a stylesheet a third palette to answer for
 * that it does not have. A clip whose low box accepts a number above the high
 * one hands `Scale.setDomain` a `RangeError`.
 *
 * `ui/dom.ts` is here for the same reason with more force: every view in the
 * application is built out of `el`, and `fmt` is what a genomes table's numbers
 * are read through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClipRange } from '@/ui/ClipRange'
import { append, button, clear, dragHasFiles, dragHasTrack, dropEffectFor, el, field, fmt, TRACK_DRAG_TYPE } from '@/ui/dom'
import { recordCard, recordFields } from '@/ui/RecordCard'
import { stepper } from '@/ui/Stepper'
import { ThemeToggle, initTheme } from '@/ui/ThemeToggle'
import type { TablePayload } from '@/worker/protocol'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
  window.localStorage.clear()
})

afterEach(() => {
  teardown()
  window.localStorage.clear()
})

// ---------------------------------------------------------------------------
// ui/dom.ts
// ---------------------------------------------------------------------------

describe('el', () => {
  it('sets what it was given and nothing else', () => {
    const node = el('a', {
      class: 'crumb',
      text: 'genomes',
      title: 'every genome',
      id: 'crumb-1',
      href: '#/genomes',
      attrs: { 'data-scope': 'file' },
    })
    expect(node.className).toBe('crumb')
    expect(node.textContent).toBe('genomes')
    expect(node.title).toBe('every genome')
    expect(node.id).toBe('crumb-1')
    expect(node.getAttribute('href')).toBe('#/genomes')
    expect(node.dataset.scope).toBe('file')
  })

  it('writes an input’s value as a property, not as an attribute', () => {
    const node = el('input', { type: 'text', value: 'chrI', placeholder: 'a region' })
    expect(node.value).toBe('chrI')
    expect(node.getAttribute('placeholder')).toBe('a region')
  })

  it('marks a control disabled only when asked', () => {
    expect(el('button', { disabled: true }).hasAttribute('disabled')).toBe(true)
    expect(el('button', { disabled: false }).hasAttribute('disabled')).toBe(false)
    expect(el('button', {}).hasAttribute('disabled')).toBe(false)
  })

  it('wires listeners handed in through `on`', () => {
    const clicks: string[] = []
    const node = el('button', { on: { click: () => clicks.push('hit') } })
    node.click()
    expect(clicks).toEqual(['hit'])
  })

  it('takes strings as children so a label can be written inline', () => {
    const node = el('p', {}, 'one ', el('b', { text: 'two' }))
    expect(node.textContent).toBe('one two')
  })

  it('skips the falsy children, so `cond && el(...)` reads well', () => {
    const node = el('div', {}, null, undefined, false, el('span', { text: 'kept' }))
    expect(node.childElementCount).toBe(1)
    expect(node.textContent).toBe('kept')
  })
})

describe('the other helpers', () => {
  it('appends into any node', () => {
    const node = document.createElement('div')
    append(node, ['a', el('b', { text: 'b' }), null])
    expect(node.textContent).toBe('ab')
  })

  it('empties a node', () => {
    const node = el('div', {}, el('span', {}), el('span', {}))
    clear(node)
    expect(node.childNodes).toHaveLength(0)
  })

  it('labels a control without repeating its title', () => {
    const control = el('input', { type: 'text' })
    const node = field('resolution', control, 'the level this is drawn at')
    expect(textsOf(node, '.field-label')).toEqual(['resolution'])
    expect(node.title).toBe('the level this is drawn at')
    expect(node.contains(control)).toBe(true)
  })

  it('builds a button that is a button and not a submit', () => {
    const clicks: string[] = []
    const node = button('go', () => clicks.push('go'), { title: 'open it' })
    expect(node.getAttribute('type')).toBe('button')
    expect(node.className).toBe('btn')
    expect(node.title).toBe('open it')
    node.click()
    expect(clicks).toEqual(['go'])
  })
})

describe('telling one drag from another', () => {
  function dragOf(...types: string[]): DragEvent {
    return { dataTransfer: { types } } as unknown as DragEvent
  }

  it('sees files', () => {
    expect(dragHasFiles(dragOf('Files'))).toBe(true)
    expect(dragHasFiles(dragOf('text/plain'))).toBe(false)
    expect(dragHasFiles({ dataTransfer: null } as unknown as DragEvent)).toBe(false)
  })

  it('sees a dragged track row, and is not fooled by dragged text', () => {
    // A row's drag sets `text/plain` too, and so does a word dragged out of any
    // input — so the custom type is the whole of the distinction.
    expect(dragHasTrack(dragOf(TRACK_DRAG_TYPE, 'text/plain'))).toBe(true)
    expect(dragHasTrack(dragOf('text/plain'))).toBe(false)
    expect(TRACK_DRAG_TYPE).toBe(TRACK_DRAG_TYPE.toLowerCase())
  })
})

/**
 * A target's drop effect has to be one the drag's source allows, or the browser
 * refuses the drop with no event at all — which is how an empty cell of the
 * deck, answering `copy`, refused every row of the Tracks card (`move` only),
 * and how the tests that dispatch a `drop` themselves never noticed.
 */
describe('answering a drag with an effect it allows', () => {
  const allowing = (effectAllowed: string) => ({ effectAllowed }) as unknown as DataTransfer

  it('gives what the target wants where the source allows it', () => {
    expect(dropEffectFor(allowing('copy'), 'copy')).toBe('copy')
    expect(dropEffectFor(allowing('copyMove'), 'copy')).toBe('copy')
    expect(dropEffectFor(allowing('copyMove'), 'move')).toBe('move')
    expect(dropEffectFor(allowing('linkMove'), 'link')).toBe('link')
  })

  it('falls back to what the source does allow, rather than to a refusal', () => {
    expect(dropEffectFor(allowing('move'), 'copy')).toBe('move')
    expect(dropEffectFor(allowing('link'), 'copy')).toBe('link')
  })

  it('takes anything from a source that said nothing — a file from the desktop', () => {
    expect(dropEffectFor(allowing('all'), 'copy')).toBe('copy')
    expect(dropEffectFor(allowing('uninitialized'), 'move')).toBe('move')
  })

  it('answers none only where the source allows nothing', () => {
    expect(dropEffectFor(allowing('none'), 'copy')).toBe('none')
  })
})

describe('fmt', () => {
  it('answers an em dash for a number that is not one', () => {
    for (const format of [fmt.int, fmt.num, fmt.pct, fmt.bp, fmt.bytes]) {
      expect(format(Number.NaN)).toBe('—')
      expect(format(Number.POSITIVE_INFINITY)).toBe('—')
    }
  })

  it('keeps an integer’s separators and a float’s places', () => {
    expect(fmt.num(4_573_673)).toBe(fmt.int(4_573_673))
    expect(fmt.num(0.5)).toBe('0.5')
  })

  it('writes base pairs in the unit a reader reads them in', () => {
    expect(fmt.bp(940)).toBe('940 bp')
    expect(fmt.bp(12_300)).toBe('12.3 kb')
    expect(fmt.bp(4_600_000)).toBe('4.60 Mb')
  })

  // Decimal, in thousands, because that is what the OS and every browser's
  // download dialog show the same reader about the same file — see `src/units.ts`.
  it('writes bytes in decimal units, as the operating system does', () => {
    expect(fmt.bytes(512)).toBe('512 B')
    expect(fmt.bytes(2000)).toBe('2.0 kB')
    expect(fmt.bytes(5_000_000)).toBe('5.0 MB')
    expect(fmt.bytes(18_100_000)).toBe('18.1 MB')
  })

  it('writes a fraction as a percentage', () => {
    expect(fmt.pct(0.083)).toBe('8.3%')
    expect(fmt.pct(0.083, 0)).toBe('8%')
  })
})

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

describe('the ‹ › pair', () => {
  it('names the neighbour it would open rather than saying “next”', () => {
    const node = stepper({
      neighbours: { prev: 'MAG_004', next: 'MAG_006' },
      onStep: () => {},
      noun: 'genome',
    })
    const [back, on] = all<HTMLButtonElement>(node, 'button')
    expect(back.title).toBe('Previous genome: MAG_004 ([)')
    expect(on.title).toBe('Next genome: MAG_006 (])')
    expect(back.disabled).toBe(false)
    expect(on.disabled).toBe(false)
  })

  it('looks spent at the end, and says so instead of looking broken', () => {
    const node = stepper({
      neighbours: { prev: 'MAG_004', next: null },
      onStep: () => {},
      noun: 'genome',
    })
    const [, on] = all<HTMLButtonElement>(node, 'button')
    expect(on.disabled).toBe(true)
    expect(on.title).toBe('No next genome')
  })

  it('steps one either way', () => {
    const steps: number[] = []
    const node = stepper({
      neighbours: { prev: 'a', next: 'c' },
      onStep: (delta) => steps.push(delta),
      noun: 'contig',
    })
    for (const item of all<HTMLButtonElement>(node, 'button')) item.click()
    expect(steps).toEqual([-1, 1])
  })
})

// ---------------------------------------------------------------------------
// ThemeToggle
// ---------------------------------------------------------------------------

describe('the theme toggle', () => {
  it('starts at system, which is the absence of an override', () => {
    expect(initTheme()).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  // Ordered against the machine, which reports light here, so the first press
  // is the one that repaints (`ui/ThemeToggle.next` argues why the silent step
  // is last rather than first).
  it('cycles system → dark → light → system on a light machine', () => {
    const toggle = new ThemeToggle()
    document.body.appendChild(toggle.el)
    toggle.el.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    toggle.el.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    toggle.el.click()
    // Back to system, and the attribute is *removed* rather than set to a third
    // value the stylesheet has no palette for.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('keeps an explicit choice and forgets the implicit one', () => {
    const toggle = new ThemeToggle()
    toggle.el.click()
    expect(window.localStorage.getItem('metacooler-viewer:theme')).toBe('dark')
    toggle.el.click()
    toggle.el.click()
    expect(window.localStorage.getItem('metacooler-viewer:theme')).toBeNull()
  })

  it('restores what was stored, before anything is mounted', () => {
    window.localStorage.setItem('metacooler-viewer:theme', 'dark')
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('treats a stored absurdity as system', () => {
    window.localStorage.setItem('metacooler-viewer:theme', 'chartreuse')
    expect(initTheme()).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('says what a press will do next, and says it to a screen reader too', () => {
    const toggle = new ThemeToggle()
    expect(toggle.el.title).toContain('Theme: system')
    // The *opposite* of what this machine reports, so the press changes the
    // page; the accessible name is the same sentence, which the constant
    // "colour theme" it used to carry never was.
    expect(toggle.el.title).toContain('dark')
    expect(toggle.el.getAttribute('aria-label')).toBe(toggle.el.title)
  })
})

// ---------------------------------------------------------------------------
// ClipRange
// ---------------------------------------------------------------------------

describe('the colour clip', () => {
  function make(): { clip: ClipRange; changes: Array<{ vmin: number; vmax: number } | null> } {
    const changes: Array<{ vmin: number; vmax: number } | null> = []
    const clip = new ClipRange({
      onChange: (value) => changes.push(value),
      format: (value) => `${value} counts`,
    })
    document.body.appendChild(clip.el)
    return { clip, changes }
  }

  function boxes(clip: ClipRange): [HTMLInputElement, HTMLInputElement] {
    const found = all<HTMLInputElement>(clip.el, '.clip-box')
    return [found[0], found[1]]
  }

  function typeInto(box: HTMLInputElement, text: string): void {
    box.value = text
    box.dispatchEvent(new Event('change'))
  }

  it('opens in auto, with nothing to hand back and nothing to say', () => {
    const { clip } = make()
    expect(clip.el.classList.contains('clip-manual')).toBe(false)
    expect(clip.el.querySelector<HTMLButtonElement>('.clip-auto')?.disabled).toBe(true)
    // **No caption until a block has been scaled.** It used to print
    // `auto · 0 – 1` from the placeholder the control starts on, which behind
    // the whole-genome gate is a caption for a picture that is not there.
    expect(textsOf(clip.el, '.clip-note')[0]).toBe('')
    clip.setValues({ vmin: 0, vmax: 42 }, true)
    expect(textsOf(clip.el, '.clip-note')[0].startsWith('auto ·')).toBe(true)
  })

  it('shows the bounds the renderer resolved, in the reader’s units', () => {
    const { clip } = make()
    clip.setValues({ vmin: 0, vmax: 42 }, true)
    expect(boxes(clip)[1].value).toBe('42')
    expect(textsOf(clip.el, '.clip-note')).toEqual(['auto · 0 counts – 42 counts'])
  })

  it('takes a typed bound, and stops calling itself auto', () => {
    const { clip, changes } = make()
    clip.setValues({ vmin: 0, vmax: 100 }, true)
    typeInto(boxes(clip)[1], '80')
    expect(changes).toEqual([{ vmin: 0, vmax: 80 }])
    expect(clip.el.classList.contains('clip-manual')).toBe(true)
    expect(textsOf(clip.el, '.clip-note')[0].startsWith('clipped ·')).toBe(true)
  })

  it('refuses an inverted pair, and snaps the box back', () => {
    const { clip, changes } = make()
    clip.setValues({ vmin: 0, vmax: 100 }, true)
    typeInto(boxes(clip)[0], '150')
    // `Scale.setDomain` throws a RangeError on `start > end`, which from a box is
    // an uncaught throw and a blank picture.
    expect(changes).toEqual([])
    expect(boxes(clip)[0].value).toBe('0')
  })

  it('refuses what is not a number at all', () => {
    const { clip, changes } = make()
    clip.setValues({ vmin: 0, vmax: 100 }, true)
    typeInto(boxes(clip)[1], 'lots')
    expect(changes).toEqual([])
  })

  it('hands the range back to the data', () => {
    const { clip, changes } = make()
    clip.setValues({ vmin: 0, vmax: 100 }, true)
    typeInto(boxes(clip)[1], '80')
    clip.el.querySelector<HTMLButtonElement>('.clip-auto')?.click()
    expect(changes.at(-1)).toBeNull()
    expect(clip.el.classList.contains('clip-manual')).toBe(false)
  })

  it('never rewrites the box under the caret', () => {
    const { clip } = make()
    const [low] = boxes(clip)
    low.focus()
    low.value = '0.00'
    clip.setValues({ vmin: 7, vmax: 9 }, true)
    expect(low.value).toBe('0.00')
  })
})

// ---------------------------------------------------------------------------
// RecordCard
// ---------------------------------------------------------------------------

describe('the record card', () => {
  const PAYLOAD: TablePayload = {
    length: 2,
    columns: ['name', 'length', 'n_bins', 'completeness', 'taxonomy'],
    data: {
      name: ['MAG_001', 'MAG_002'],
      length: Float64Array.from([4_573_673, 12]),
      n_bins: Float64Array.from([457, 1]),
      completeness: Float64Array.from([98.62, Number.NaN]),
      taxonomy: ['Bacteroides', ''],
    },
  }

  it('leads with the guaranteed columns and keeps the file’s own after them', () => {
    const fields = recordFields(PAYLOAD, 0)
    // With the divider between the two sets — see `RecordField.divider`.
    expect(fields.map((row) => row.key)).toEqual([
      'length',
      'n_bins',
      'joined in with the file',
      'completeness',
      'taxonomy',
    ])
  })

  it('reads an empty fixed-length string as missing, not as a value', () => {
    const fields = recordFields(PAYLOAD, 1)
    expect(fields.find((row) => row.key === 'taxonomy')?.value).toBe('—')
    expect(fields.find((row) => row.key === 'completeness')?.value).toBe('—')
  })

  it('renders a key and a value per field, both with their own tooltip', () => {
    const node = recordCard({
      heading: 'Genome',
      icon: 'dna',
      name: 'MAG_001',
      fields: recordFields(PAYLOAD, 0),
    })
    document.body.appendChild(node)
    expect(textsOf(node, '.record-name')).toEqual(['MAG_001'])
    expect(textsOf(node, '.k')).toEqual(['length', 'n_bins', 'completeness', 'taxonomy'])
    expect(textsOf(node, '.v')).toEqual(['4,573,673 bp', '457', '98.62', 'Bacteroides'])
    expect(all<HTMLElement>(node, '.v').map((cell) => cell.title)).toEqual(textsOf(node, '.v'))
  })

  it('never repeats the name inside the grid it titles', () => {
    expect(recordFields(PAYLOAD, 0).map((row) => row.key)).not.toContain('name')
  })

  it('answers nothing at all for a row that is not there', () => {
    expect(recordFields(PAYLOAD, -1)).toEqual([])
    expect(recordFields(PAYLOAD, 9)).toEqual([])
  })
})
