// @vitest-environment jsdom
/**
 * The one box a view is typed into.
 *
 * `/` is a key the whole application answers, and the reason it can be is that
 * four views stopped building four boxes and started sharing this one. What is
 * worth asserting about it is not the markup but the three decisions that make
 * a box with a hit list under it usable:
 *
 * - **the text wins when there is nothing to offer**, which is what lets
 *   `chrI:1-2000` through without coordinates being special-cased anywhere;
 * - **Escape empties the list rather than hiding it**, or Enter afterwards would
 *   jump to a hit nobody can see — a cancel that behaves like a deferred
 *   navigation;
 * - **focus selects what is there**, so typing a gene name into a box holding a
 *   region replaces it instead of appending to it.
 *
 * Each of those has a wrong version that looks entirely correct on screen.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SearchBox, type Suggestion } from '@/ui/SearchBox'
import { all, setUpDom, textsOf, type DomTeardown } from '../support/dom'

let teardown: DomTeardown

beforeEach(() => {
  teardown = setUpDom()
})

afterEach(() => {
  teardown()
})

const GENES: Suggestion[] = [
  { label: 'GAL4 · II:100 · genes.gff', value: 'II:100-200' },
  { label: 'GAL7 · II:900 · genes.gff', value: 'II:900-950' },
]

interface Made {
  box: SearchBox
  submitted: string[]
  typed: string[]
}

function make(options: { suggest?: boolean } = {}): Made {
  const submitted: string[] = []
  const typed: string[] = []
  const box = new SearchBox({
    placeholder: 'a region, or a gene',
    onSubmit: (text) => submitted.push(text),
    onInput: (text) => typed.push(text),
    ...(options.suggest === true
      ? {
          // What `featureSuggestions` does, stubbed to the one decision this
          // box makes about it: nothing for a string with a colon in it.
          suggest: (text: string) =>
            text.length < 2 || text.includes(':')
              ? []
              : GENES.filter((hit) => hit.label.toLowerCase().startsWith(text.toLowerCase())),
        }
      : {}),
  })
  document.body.appendChild(box.el)
  return { box, submitted, typed }
}

function enter(box: SearchBox): void {
  box.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

function typeInto(box: SearchBox, text: string): void {
  box.input.value = text
  box.input.dispatchEvent(new Event('input'))
}

describe('the box itself', () => {
  it('wears the key that reaches it', () => {
    const { box } = make()
    expect(textsOf(box.el, '.search-key')).toEqual(['/'])
  })

  it('grows no hit list where it has nothing to offer', () => {
    const { box } = make()
    expect(box.el.querySelector('.search-hits')).toBeNull()
  })

  it('reports every keystroke to a view that answers as you type', () => {
    const { box, typed } = make()
    typeInto(box, 'ch')
    typeInto(box, 'chr')
    expect(typed).toEqual(['ch', 'chr'])
  })

  it('submits the trimmed text on Enter', () => {
    const { box, submitted } = make()
    typeInto(box, '  chrI:1-2000  ')
    enter(box)
    expect(submitted).toEqual(['chrI:1-2000'])
  })

  it('submits the same thing when the go button beside it is pressed', () => {
    const { box, submitted } = make()
    typeInto(box, 'chrIV')
    box.submit()
    expect(submitted).toEqual(['chrIV'])
  })
})

describe('the hit list', () => {
  it('appears once there is something to offer, and says what it found', () => {
    const { box } = make({ suggest: true })
    typeInto(box, 'gal')
    const hits = box.el.querySelector('.search-hits')
    expect(hits?.classList.contains('hidden')).toBe(false)
    expect(textsOf(box.el, '.search-hit')).toEqual(GENES.map((hit) => hit.label))
  })

  it('stays away rather than reporting a search nobody ran', () => {
    const { box } = make({ suggest: true })
    typeInto(box, 'z')
    expect(box.el.querySelector('.search-hits')?.classList.contains('hidden')).toBe(true)
    expect(all(box.el, '.search-hit')).toHaveLength(0)
  })

  it('puts a clicked hit’s coordinates in the box and opens them', () => {
    const { box, submitted } = make({ suggest: true })
    typeInto(box, 'gal')
    all<HTMLButtonElement>(box.el, '.search-hit')[1].click()
    expect(box.input.value).toBe('II:900-950')
    expect(submitted).toEqual(['II:900-950'])
  })

  it('takes the first hit on Enter', () => {
    const { box, submitted } = make({ suggest: true })
    typeInto(box, 'gal')
    enter(box)
    expect(submitted).toEqual(['II:100-200'])
    expect(box.input.value).toBe('II:100-200')
  })

  it('lets coordinates through, because nothing is offered for them', () => {
    const { box, submitted } = make({ suggest: true })
    typeInto(box, 'GAL4:1-500')
    enter(box)
    expect(submitted).toEqual(['GAL4:1-500'])
  })

  it('puts the list away after a submission', () => {
    const { box } = make({ suggest: true })
    typeInto(box, 'gal')
    enter(box)
    expect(box.el.querySelector('.search-hits')?.classList.contains('hidden')).toBe(true)
  })
})

describe('Escape', () => {
  it('empties the list rather than merely hiding it', () => {
    const { box, submitted } = make({ suggest: true })
    typeInto(box, 'gal')
    box.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(all(box.el, '.search-hit')).toHaveLength(0)
    // And the next Enter is about the text, not about a hit nobody can see.
    enter(box)
    expect(submitted).toEqual(['gal'])
  })
})

describe('the caret', () => {
  it('selects what is there, so typing replaces rather than appends', () => {
    const { box } = make()
    box.input.value = 'IV:400,000-500,000'
    box.focus()
    expect(document.activeElement).toBe(box.input)
    expect(box.input.selectionStart).toBe(0)
    expect(box.input.selectionEnd).toBe('IV:400,000-500,000'.length)
  })
})

describe('a view that has moved', () => {
  it('writes the new place into the box', () => {
    const { box, submitted } = make()
    box.set('chrII:1-1000')
    expect(box.input.value).toBe('chrII:1-1000')
    expect(submitted).toEqual([])
  })

  it('refuses to overwrite what somebody is typing', () => {
    const { box } = make()
    box.input.value = 'half a locu'
    box.input.focus()
    box.set('chrII:1-1000')
    expect(box.input.value).toBe('half a locu')
  })
})
