// @vitest-environment jsdom
/**
 * A tab moved along the strip (§5.6), from the shell's side.
 *
 * The strip reports *from* and *to*; what the window does with it is pinned
 * here. The tab in front stays in front wherever it now stands — the index is a
 * place in the strip and the one being read is a session — and nothing is
 * opened or navigated, so a remembered tab moved is still only remembered. The
 * order is what the window writes down, so a reload brings the tabs back in the
 * order they were left in. The palette's *Move this tab left* and *right* are
 * the keyboard's road to the same move, greyed at either end of the strip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import type { Session } from '@/app/Session'
import { resetMounting } from '@/embed'
import type { Command } from '@/ui/commands'
import { setUpDom, type DomTeardown, stopsWithTheDom } from '../support/dom'

/** A worker that is created, listened to, and never answers. */
class DeadWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let teardown: DomTeardown
let hadWorker: unknown

beforeEach(() => {
  teardown = setUpDom()
  hadWorker = (globalThis as Record<string, unknown>).Worker
  ;(globalThis as Record<string, unknown>).Worker = DeadWorker
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

afterEach(() => {
  ;(globalThis as Record<string, unknown>).Worker = hadWorker
  teardown()
  window.history.replaceState(null, '', '/')
  resetMounting()
})

interface Shell {
  sessions: Session[]
  active: number
  newSession(): Session | null
  moveSession(from: number, to: number): void
  commands(): Command[]
}

/** Three tabs, each naming a file it has not read, the third in front. */
function mount(): Shell {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = new App(root)
  stopsWithTheDom(app)
  const shell = app as unknown as Shell
  shell.sessions[0].prime({ uri: 'https://data.example/a.mcool', view: 'contigs' })
  shell.newSession()?.prime({ uri: 'https://data.example/b.mcool', view: 'contigs' })
  shell.newSession()?.prime({ uri: 'https://data.example/c.mcool', view: 'contigs' })
  return shell
}

const command = (shell: Shell, id: string): Command => {
  const found = shell.commands().find((each) => each.id === id)
  if (found === undefined) throw new Error(`no command ${id}`)
  return found
}

const strip = (): Array<{ label: string; active: boolean }> =>
  [...document.querySelectorAll<HTMLElement>('.tabstrip .tab')].map((node) => ({
    label: node.querySelector('.tab-label')?.textContent ?? '',
    active: node.getAttribute('aria-selected') === 'true',
  }))

const remembered = (): { order: string[]; active: string | null } => {
  const stored = JSON.parse(window.sessionStorage.getItem('chromosomix:sessions') ?? '{}') as {
    sessions: Array<{ id: string }>
    active: string | null
  }
  return { order: stored.sessions.map((row) => row.id), active: stored.active }
}

describe('moving a tab', () => {
  it('keeps the tab in front in front, wherever it now stands', () => {
    const shell = mount()
    const [a, b, c] = shell.sessions
    expect(shell.active).toBe(2)
    command(shell, 'move-session-left').run()
    expect(shell.sessions).toEqual([a, c, b])
    expect(shell.active).toBe(1)
    expect(strip()).toEqual([
      { label: 'a.mcool', active: false },
      { label: 'c.mcool', active: true },
      { label: 'b.mcool', active: false },
    ])
    // A tab moved past the one in front leaves it where it is being read.
    shell.moveSession(2, 0)
    expect(shell.sessions).toEqual([b, a, c])
    expect(shell.active).toBe(2)
    expect(strip().map((tab) => tab.label)).toEqual(['b.mcool', 'a.mcool', 'c.mcool'])
  })

  it('opens nothing: a remembered tab moved is still only remembered', () => {
    const shell = mount()
    shell.moveSession(0, 2)
    expect(shell.sessions[2].isPrimed).toBe(true)
    expect(document.querySelector('.tabstrip .tab:last-child')?.classList.contains('is-pending')).toBe(true)
  })

  it('writes the order down, so a reload brings the tabs back in it', () => {
    const shell = mount()
    const [a, b, c] = shell.sessions.map((session) => session.id)
    command(shell, 'move-session-left').run()
    expect(remembered()).toEqual({ order: [a, c, b], active: c })
  })

  it('greys the palette’s moves at either end of the strip', () => {
    const shell = mount()
    expect(command(shell, 'move-session-right').enabled).toBe(false)
    expect(command(shell, 'move-session-left').enabled).toBe(true)
    command(shell, 'move-session-left').run()
    command(shell, 'move-session-left').run()
    expect(shell.active).toBe(0)
    expect(command(shell, 'move-session-left').enabled).toBe(false)
    expect(command(shell, 'move-session-right').enabled).toBe(true)
    command(shell, 'move-session-right').run()
    expect(shell.active).toBe(1)
    expect(strip().map((tab) => tab.label)).toEqual(['a.mcool', 'c.mcool', 'b.mcool'])
  })

  it('ignores a move that goes nowhere or off the strip', () => {
    const shell = mount()
    const before = [...shell.sessions]
    shell.moveSession(1, 1)
    shell.moveSession(-1, 0)
    shell.moveSession(0, 3)
    expect(shell.sessions).toEqual(before)
  })
})
