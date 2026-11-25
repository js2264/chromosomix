// @vitest-environment jsdom
/**
 * A stage dialog's side (`ui/StageDialog.ts`): its toggle docked in the title
 * bar where the caller gives the bar an end, named for what the side is, and —
 * with `stageMin` — folded by itself where the stage would be narrower beside
 * it, opened over the stage as a drawer while it does not fit, and put back
 * beside the stage when it fits again, unless the reader folded it (§33.3).
 *
 * jsdom lays nothing out, so the shell's width and the side's are given here
 * and the shell's resize is the observer's callback, called by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { el } from '@/ui/dom'
import { stageDialog, type StageModal } from '@/ui/StageDialog'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const open: StageModal[] = []
let observers: Array<{ fit: () => void; disconnected: boolean }> = []

beforeEach(() => {
  teardown = setUpDom()
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: { fit: () => void; disconnected: boolean }
      constructor(fit: () => void) {
        this.entry = { fit, disconnected: false }
        observers.push(this.entry)
      }
      observe(): void {}
      disconnect(): void {
        this.entry.disconnected = true
      }
    },
  )
})

afterEach(() => {
  for (const modal of open.splice(0, open.length)) modal.close()
  vi.unstubAllGlobals()
  teardown()
})

function dialog(options: { stageMin?: () => number; end?: boolean } = {}): { modal: StageModal; tools: HTMLElement } {
  const tools = el('div', { class: 'tools' }, el('button', { text: 'tidy' }))
  const modal = stageDialog({
    title: 'Curate the genomes · MM133.metacool',
    stage: el('div', { class: 'picture' }),
    side: el('div', { class: 'cards' }),
    ...(options.end === false ? {} : { head: { end: tools } }),
    sideName: 'inspector',
    ...(options.stageMin === undefined ? {} : { stageMin: options.stageMin }),
    memoryKey: () => 'test',
    scope: 'test:side',
  })
  open.push(modal)
  return { modal, tools }
}

const side = (): HTMLElement => document.querySelector('.stage-side') as HTMLElement
const toggle = (): HTMLButtonElement => document.querySelector('.stage-side-toggle') as HTMLButtonElement
const grip = (): HTMLElement => document.querySelector('.stage-side-grip') as HTMLElement

/** The shell this wide, the side this wide, and the shell's resize answered. */
function resize(shell: number, sideWidth = 300): void {
  Object.defineProperty(document.querySelector('.stage-modal'), 'clientWidth', { configurable: true, value: shell })
  side().style.flexBasis = `${sideWidth}px`
  observers[0].fit()
}

describe('a stage dialog’s side', () => {
  it('docks its toggle at the end of the title bar, before the ✕, named for what the side is', () => {
    const { tools } = dialog()
    expect(tools.lastElementChild).toBe(toggle())
    expect(document.querySelector('.stage-modal > .stage-side-toggle')).toBeNull()
    expect([...(document.querySelector('.modal-head-end') as HTMLElement).children].map((node) => node.className)).toEqual(['tools', 'btn-close'])
    expect(toggle().getAttribute('aria-label')).toBe('Hide the inspector')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(grip().getAttribute('aria-label')).toBe('Resize the inspector')
    toggle().click()
    expect(side().classList.contains('hidden')).toBe(true)
    expect(toggle().getAttribute('aria-label')).toBe('Show the inspector')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('floats its toggle over the side’s foot where the bar has no end, as it did', () => {
    dialog({ end: false })
    expect(document.querySelector('.stage-modal > .stage-side-toggle')).not.toBeNull()
  })

  it('folds by itself where the stage would be too narrow beside it, opens over the stage there, and comes back when it fits', () => {
    const { modal } = dialog({ stageMin: () => 500 })
    expect(observers).toHaveLength(1)
    // 1000 wide, a side of 300: the stage keeps 700 beside it.
    resize(1000)
    expect(side().classList.contains('hidden')).toBe(false)
    expect(side().classList.contains('is-drawer')).toBe(false)
    // 700 wide: 400 beside it, under the 500 asked — folded by the width.
    resize(700)
    expect(side().classList.contains('hidden')).toBe(true)
    expect(toggle().getAttribute('aria-label')).toBe('Show the inspector')
    // Opened by the reader while it does not fit: over the stage, its grip gone,
    // at the width it had beside the stage rather than its words' widest.
    toggle().click()
    expect(side().classList.contains('hidden')).toBe(false)
    expect(side().classList.contains('is-drawer')).toBe(true)
    expect(side().style.width).toBe('300px')
    expect(grip().classList.contains('hidden')).toBe(true)
    // Escape's, in the caller's order: the drawer folded, and said so.
    expect(modal.foldDrawer()).toBe(true)
    expect(side().classList.contains('hidden')).toBe(true)
    expect(modal.foldDrawer()).toBe(false)
    // Wide again: back beside the stage, the width having folded it, sized by its basis again.
    resize(1000)
    expect(side().classList.contains('hidden')).toBe(false)
    expect(side().classList.contains('is-drawer')).toBe(false)
    expect(side().style.width).toBe('')
    expect(grip().classList.contains('hidden')).toBe(false)
  })

  it('puts a drawer back beside the stage when the window widens, and never opens a side the reader folded', () => {
    dialog({ stageMin: () => 500 })
    resize(700)
    toggle().click()
    expect(side().classList.contains('is-drawer')).toBe(true)
    resize(1000)
    expect(side().classList.contains('hidden')).toBe(false)
    expect(side().classList.contains('is-drawer')).toBe(false)
    // Folded by the reader: it stays folded, narrower and wider again.
    toggle().click()
    resize(700)
    resize(1000)
    expect(side().classList.contains('hidden')).toBe(true)
  })

  it('asks the caller’s width again when the caller says something changed, and stops watching once closed', () => {
    let least = 500
    const { modal } = dialog({ stageMin: () => least })
    resize(1000)
    // A column of the stage dragged wider: the stage wants more beside the side.
    least = 800
    modal.fitSide()
    expect(side().classList.contains('hidden')).toBe(true)
    open.splice(0, 1)[0].close()
    expect(observers[0].disconnected).toBe(true)
  })

  it('watches nothing, and folds nothing by itself, without `stageMin`', () => {
    const { modal } = dialog()
    expect(observers).toHaveLength(0)
    modal.fitSide()
    expect(side().classList.contains('hidden')).toBe(false)
    expect(modal.foldDrawer()).toBe(false)
  })
})
