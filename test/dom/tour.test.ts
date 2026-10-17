// @vitest-environment jsdom
/**
 * The guided tour's engine (§30), on steps made up for the purpose.
 *
 * What is pinned is what a reader relies on and a gallery cannot show: that the
 * hole is where the control is and nothing of the tour's is in it, that a press
 * on the grey is kept from the app, that a step moves on when its state holds
 * rather than when one particular button is pressed, that *back* waits instead
 * of bouncing forward again, that a step whose drawer was closed goes back to
 * the step that opens it, and that *skip* and *finish* tell the caller which.
 * The tutorial's own thirty-five steps are driven end to end on real data by
 * `scripts/ui-tutorial.mjs`.
 *
 * The clock is faked — timers, frames and `performance` together — because the
 * engine reads the window on a tick and paints on a frame, and a test that
 * waited for either for real would be a slow test that sometimes fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tour, cardPlace, resumeIndex, type TourOptions, type TourStep } from '@/ui/Tour'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
let tours: Tour[] = []

beforeEach(() => {
  teardown = setUpDom()
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'Date',
    ],
  })
})

afterEach(() => {
  for (const tour of tours) tour.stop()
  tours = []
  vi.useRealTimers()
  teardown()
})

/** A control at a fixed place on screen: jsdom lays nothing out, so the box is said. */
function control(box: { left: number; top: number; width: number; height: number }): HTMLButtonElement {
  const node = document.createElement('button')
  node.textContent = 'press me'
  node.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    }) as DOMRect
  document.body.appendChild(node)
  return node
}

function step(id: string, extra: Partial<TourStep> = {}): TourStep {
  return { id, chapter: 'Part', title: `Do ${id}`, text: `The ${id} step.`, ...extra }
}

function tour(steps: TourStep[], options: Partial<TourOptions> = {}): Tour {
  const made = new Tour({ steps, start: 0, onStep: () => {}, onEnd: () => {}, ...options })
  tours.push(made)
  made.start()
  return made
}

const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector(selector) as T
const shown = (selector: string): boolean => !q(selector).classList.contains('hidden')
const on = (): string => q('.tour-card').dataset.step ?? ''
const nextLabel = (): string => q('.tour-next').textContent ?? ''

describe('the dim and the hole', () => {
  it('lights the target, with the grey round it and nothing of its own inside', () => {
    const target = control({ left: 100, top: 200, width: 80, height: 30 })
    tour([step('press', { target: () => target, done: () => false }), step('after')])
    vi.advanceTimersByTime(100)

    expect(shown('.tour-ring')).toBe(true)
    expect(shown('.tour-veil')).toBe(false)
    const ring = q('.tour-ring').style
    // Six pixels of air on every side.
    expect([ring.left, ring.top, ring.width, ring.height]).toEqual(['94px', '194px', '92px', '42px'])

    const [above, right, below, left] = Array.from(document.querySelectorAll<HTMLElement>('.tour-block'))
    expect(above.style.height).toBe('194px')
    expect(below.style.top).toBe('236px')
    expect([left.style.top, left.style.width, left.style.height]).toEqual(['194px', '94px', '42px'])
    expect([right.style.left, right.style.top, right.style.height]).toEqual(['186px', '194px', '42px'])
  })

  it('keeps a press on the grey from the app, and shows where to press instead', () => {
    const target = control({ left: 100, top: 200, width: 80, height: 30 })
    const heard = vi.fn()
    document.addEventListener('click', heard)
    tour([step('press', { target: () => target, done: () => false })])
    vi.advanceTimersByTime(100)

    const block = q('.tour-block')
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    block.dispatchEvent(down)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    block.dispatchEvent(click)

    expect(down.defaultPrevented).toBe(true)
    expect(click.defaultPrevented).toBe(true)
    expect(heard).not.toHaveBeenCalled()
    expect(q('.tour-ring').classList.contains('is-nudged')).toBe(true)
    vi.advanceTimersByTime(800)
    expect(q('.tour-ring').classList.contains('is-nudged')).toBe(false)

    // The control in the hole is the app's, as it would be with no tour.
    target.click()
    expect(heard).toHaveBeenCalledTimes(1)
    document.removeEventListener('click', heard)
  })

  it('greys the whole window and takes no press on a step that lights nothing', () => {
    tour([step('look'), step('after')])
    vi.advanceTimersByTime(100)
    expect(shown('.tour-veil')).toBe(true)
    expect(shown('.tour-ring')).toBe(false)
    expect(Array.from(document.querySelectorAll('.tour-block')).every((b) => b.classList.contains('hidden'))).toBe(
      true,
    )
  })

  it('says so when the thing to press is not on screen, and only on a step that waits for it', () => {
    let target: HTMLElement | null = null
    tour([
      step('press', { target: () => target, done: () => false, missing: 'Open the drawer first.' }),
      step('read', { target: () => null }),
    ])
    vi.advanceTimersByTime(1000)
    expect(shown('.tour-note')).toBe(false)
    vi.advanceTimersByTime(700)
    expect(shown('.tour-note')).toBe(true)
    expect(q('.tour-note').textContent).toBe('Open the drawer first.')

    // It turns up: the note goes and the hole is drawn on it.
    target = control({ left: 10, top: 10, width: 40, height: 20 })
    vi.advanceTimersByTime(200)
    expect(shown('.tour-note')).toBe(false)
    expect(shown('.tour-ring')).toBe(true)

    q<HTMLButtonElement>('.tour-next').click()
    vi.advanceTimersByTime(2000)
    expect(on()).toBe('read')
    expect(shown('.tour-note')).toBe(false)
  })

  it('does not call a control missing that a done step took away', () => {
    // A drawer's close button, gone because the drawer was closed: the step is
    // done, and *back* to it shows it done rather than lost.
    tour([step('close', { target: () => null, done: () => true }), step('look')], { start: 1 })
    q<HTMLButtonElement>('.tour-back').click()
    vi.advanceTimersByTime(3000)
    expect(on()).toBe('close')
    expect(shown('.tour-note')).toBe(false)
  })
})

describe('the card', () => {
  it('counts the steps, names the part, and sets an accession apart', () => {
    tour([
      step('first'),
      step('search', { chapter: 'The store', text: ['Type ', { name: '4DNES4296C5Q' }, ' in the box.'] }),
    ])
    expect(q('.tour-count').textContent).toBe('step 1 of 2')
    q<HTMLButtonElement>('.tour-next').click()
    expect(q('.tour-count').textContent).toBe('step 2 of 2')
    expect(q('.tour-chapter').textContent).toBe('The store')
    expect(q('.tour-text').textContent).toBe('Type 4DNES4296C5Q in the box.')
    expect(q('.tour-text code.tour-name').textContent).toBe('4DNES4296C5Q')
    expect(q('.tour-bar').style.width).toBe('100%')
  })

  it('offers a step that waits on the reader to be skipped, quietly, and a read one to be gone on from', () => {
    tour([step('press', { done: () => false }), step('read'), step('end')])
    expect(nextLabel()).toBe('skip step')
    expect(q('.tour-next').classList.contains('btn-quiet')).toBe(true)
    q<HTMLButtonElement>('.tour-next').click()
    expect(nextLabel()).toBe('next')
    expect(q('.tour-next').classList.contains('btn-primary')).toBe(true)
    q<HTMLButtonElement>('.tour-next').click()
    expect(nextLabel()).toBe('finish')
    expect(q<HTMLButtonElement>('.tour-back').disabled).toBe(false)
  })

  it('puts the helper on the step that has one, and only there', () => {
    const typed = vi.fn()
    tour([step('search', { assist: { label: 'type it for me', title: 'Type it', run: typed } }), step('after')])
    q<HTMLButtonElement>('.tour-assist button').click()
    expect(typed).toHaveBeenCalledTimes(1)
    q<HTMLButtonElement>('.tour-next').click()
    expect(document.querySelector('.tour-assist button')).toBeNull()
  })
})

describe('moving on', () => {
  it('moves on by itself a moment after the step’s state holds, however it came to', () => {
    let pressed = false
    const entered = vi.fn()
    tour([step('press', { done: () => pressed }), step('after')], { onStep: (_s, index) => entered(index) })
    vi.advanceTimersByTime(1000)
    expect(on()).toBe('press')

    pressed = true
    vi.advanceTimersByTime(300)
    // Still on it: the reader sees what they did land before the card moves.
    expect(on()).toBe('press')
    vi.advanceTimersByTime(500)
    expect(on()).toBe('after')
    expect(entered.mock.calls.map(([index]) => index)).toEqual([0, 1])
  })

  it('reads the window again just after the reader does something, not only on the tick', () => {
    let pressed = false
    tour([step('press', { done: () => pressed }), step('after')])
    vi.advanceTimersByTime(1000)
    expect(nextLabel()).toBe('skip step')
    pressed = true
    window.dispatchEvent(new Event('change'))
    vi.advanceTimersByTime(1)
    // Read on the event, fifty milliseconds before the next tick would have.
    expect(nextLabel()).toBe('next')
  })

  it('passes over a done step going forward, and waits on one reached by back', () => {
    const entered = vi.fn()
    tour([step('open', { done: () => true }), step('press', { done: () => false }), step('end')], {
      onStep: (_s, index) => entered(index),
    })
    expect(on()).toBe('press')
    expect(entered.mock.calls.map(([index]) => index)).toEqual([1])

    q<HTMLButtonElement>('.tour-back').click()
    vi.advanceTimersByTime(3000)
    // Shown and waiting: back means looking again, not bouncing forward.
    expect(on()).toBe('open')
    expect(nextLabel()).toBe('next')
    q<HTMLButtonElement>('.tour-next').click()
    expect(on()).toBe('press')
  })

  it('never passes over the last step, which says the tour is over, nor leaves it by itself', () => {
    const ended = vi.fn()
    let over = false
    tour([step('a', { done: () => true }), step('end', { done: () => over })], { onEnd: ended })
    expect(on()).toBe('end')
    over = true
    vi.advanceTimersByTime(3000)
    expect(on()).toBe('end')
    expect(nextLabel()).toBe('finish')
    expect(ended).not.toHaveBeenCalled()
  })

  it('goes back to the step that opens what a step points into, once it has been gone a moment', () => {
    let drawer = true
    tour([
      step('open', { done: () => drawer }),
      step('inside', { done: () => false, needs: { holds: () => drawer, back: 'open' } }),
      step('end'),
    ])
    expect(on()).toBe('inside')

    drawer = false
    vi.advanceTimersByTime(300)
    // A drawer closing and opening again in the same breath is not a reason.
    expect(on()).toBe('inside')
    vi.advanceTimersByTime(500)
    expect(on()).toBe('open')

    drawer = true
    vi.advanceTimersByTime(800)
    expect(on()).toBe('inside')
  })

  it('does not go back for a step that was done anyway', () => {
    let drawer = true
    let ran = false
    tour([
      step('open', { done: () => drawer }),
      step('run', { done: () => ran, needs: { holds: () => drawer, back: 'open' } }),
      step('end'),
    ])
    ran = true
    drawer = false
    vi.advanceTimersByTime(1000)
    expect(on()).toBe('end')
  })

  it('treats a reading that throws as not done', () => {
    tour([
      step('half-built', {
        done: () => {
          throw new Error('not yet')
        },
      }),
      step('after'),
    ])
    vi.advanceTimersByTime(1000)
    expect(on()).toBe('half-built')
  })
})

describe('leaving', () => {
  it('ends where the reader is on skip tutorial, and says it was a skip', () => {
    const ended = vi.fn()
    tour([step('a'), step('b'), step('c')], { onEnd: ended })
    q<HTMLButtonElement>('.tour-next').click()
    q<HTMLButtonElement>('.tour-skip').click()
    expect(ended).toHaveBeenCalledWith('skipped', 1)
    expect(document.querySelector('.tour')).toBeNull()
  })

  it('finishes on the last step’s button', () => {
    const ended = vi.fn()
    tour([step('a'), step('end')], { start: 1, onEnd: ended })
    q<HTMLButtonElement>('.tour-next').click()
    expect(ended).toHaveBeenCalledWith('finished', 1)
    expect(document.querySelector('.tour')).toBeNull()
  })

  it('steps aside while a dialog has the window, and moves on only once it is back', () => {
    let dialog = false
    let pressed = false
    tour([step('press', { done: () => pressed }), step('after')], { yielding: () => dialog })
    dialog = true
    pressed = true
    vi.advanceTimersByTime(1000)
    expect(q('.tour').classList.contains('is-yielding')).toBe(true)
    expect(on()).toBe('press')

    dialog = false
    vi.advanceTimersByTime(1000)
    expect(q('.tour').classList.contains('is-yielding')).toBe(false)
    expect(on()).toBe('after')
  })
})

describe('resumeIndex', () => {
  const steps = [
    step('store', { chapter: 'The store' }),
    step('search', { chapter: 'The store' }),
    step('open', { chapter: 'Compartments' }),
    step('tick', { chapter: 'Compartments' }),
    step('run', { chapter: 'Compartments' }),
  ]

  it('starts again at the first step of the part the reader left', () => {
    expect(resumeIndex(steps, 'run')).toBe(2)
    expect(resumeIndex(steps, 'open')).toBe(2)
    expect(resumeIndex(steps, 'search')).toBe(0)
  })

  it('starts from the beginning on a step this build does not have', () => {
    expect(resumeIndex(steps, 'gone')).toBe(0)
  })
})

describe('cardPlace', () => {
  const card = { width: 300, height: 150 }
  const view = { width: 1600, height: 1000 }

  it('puts the card under the hole, centred on it', () => {
    expect(cardPlace(card, { left: 500, top: 100, right: 600, bottom: 140 }, view)).toEqual({ left: 400, top: 152 })
  })

  it('puts it above when there is no room under', () => {
    expect(cardPlace(card, { left: 500, top: 800, right: 600, bottom: 900 }, view)).toEqual({ left: 400, top: 638 })
  })

  it('keeps it inside the window at an edge', () => {
    expect(cardPlace(card, { left: 0, top: 100, right: 40, bottom: 140 }, view).left).toBe(8)
  })

  it('stands it beside a hole as tall as the window', () => {
    expect(cardPlace(card, { left: 100, top: 0, right: 600, bottom: 1000 }, view)).toEqual({ left: 612, top: 425 })
  })

  it('puts it in the corner when the hole is the whole window', () => {
    expect(cardPlace(card, { left: 0, top: 0, right: 1600, bottom: 1000 }, view)).toEqual({ left: 1276, top: 826 })
  })

  it('sits it at the bottom, centred, with nothing lit', () => {
    expect(cardPlace(card, null, view)).toEqual({ left: 650, top: 814 })
  })
})
