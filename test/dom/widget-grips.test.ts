// @vitest-environment jsdom
/**
 * The notebook widgets' grip (SPECS §21.5): under the frame, a drag or the
 * arrow keys change the viewer's height, a double click puts back the height
 * the notebook asked for, and the height the reader leaves it at is written
 * back — `widget.height` in Python, `input$<id>_height` in Shiny.
 *
 * Neither package's script is a module of this app, so each is loaded as its
 * notebook loads it: the Jupyter widget's `render` handed an anywidget model,
 * the R widget's IIFE run against an `HTMLWidgets` that keeps what it declares.
 * jsdom has no layout, so the heights read are the ones the scripts set.
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROOT = join(__dirname, '..', '..')

/** A pointer event of the given kind at a height on the page, as a hand makes one. */
function pointer(type: string, clientY: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}

function key(name: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
}

/** Drag the grip from one height on the page to another, reading the frame's pointer events mid-drag. */
function drag(grip: HTMLElement, frame: () => HTMLElement, from: number, to: number): string {
  grip.dispatchEvent(pointer('pointerdown', from))
  grip.dispatchEvent(pointer('pointermove', to))
  const during = frame().style.pointerEvents
  grip.dispatchEvent(pointer('pointerup', to))
  return during
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('the Jupyter widget’s grip', () => {
  /** An anywidget model: values, `change:<key>` handlers, and the writes made to it. */
  function model(values: Record<string, unknown>) {
    const handlers = new Map<string, Array<() => void>>()
    return {
      saved: 0,
      get: (name: string) => values[name],
      set(name: string, value: unknown) {
        values[name] = value
        for (const handler of handlers.get(`change:${name}`) ?? []) handler()
      },
      save_changes() {
        this.saved += 1
      },
      on(event: string, handler: () => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      },
      off(event: string, handler: () => void) {
        handlers.set(event, (handlers.get(event) ?? []).filter((one) => one !== handler))
      },
    }
  }

  async function mount(height = 600) {
    const { default: widget } = await import(join(ROOT, 'widgets/python/src/chromosomix/static/widget.js'))
    const m = model({ src: 'https://chromosomix.app/?embed=1#uri=a.cool', files: [], height, loads: 0, requests: [] })
    const el = document.createElement('div')
    document.body.append(el)
    widget.render({ model: m, el })
    const grip = el.querySelector<HTMLButtonElement>('button.chromosomix-grip')
    expect(grip, 'a grip under the frame').not.toBeNull()
    const frame = (): HTMLIFrameElement => el.querySelector('iframe') as HTMLIFrameElement
    return { m, el, grip: grip as HTMLButtonElement, frame }
  }

  it('sits under the frame', async () => {
    const { el, frame } = await mount()
    const children = [...el.children]
    expect(children.indexOf(frame())).toBeLessThan(children.findIndex((child) => child.contains(el.querySelector('.chromosomix-grip'))))
  })

  it('follows a drag, lets the pointer through the frame while it does, and writes the height back', async () => {
    const { m, grip, frame } = await mount()
    expect(drag(grip, frame, 100, 300)).toBe('none')
    expect(frame().style.pointerEvents).toBe('')
    expect(m.get('height')).toBe(800)
    expect(frame().style.height).toBe('800px')
    expect(m.saved).toBe(1)
  })

  it('never leaves a frame shorter than the viewer’s controls', async () => {
    const { m, grip, frame } = await mount()
    drag(grip, frame, 900, 0)
    expect(m.get('height')).toBe(288)
  })

  it('steps with the arrow keys, and a click that moves nothing writes nothing', async () => {
    const { m, grip, frame } = await mount()
    grip.dispatchEvent(key('ArrowDown'))
    grip.dispatchEvent(key('ArrowDown'))
    grip.dispatchEvent(key('ArrowUp'))
    expect(m.get('height')).toBe(632)
    const saved = m.saved
    drag(grip, frame, 400, 400)
    expect(m.saved).toBe(saved)
  })

  it('goes back to the height Python asked for on a double click, not to the reader’s', async () => {
    const { m, grip, frame } = await mount(500)
    drag(grip, frame, 100, 400)
    expect(m.get('height')).toBe(800)
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(m.get('height')).toBe(500)
    // Python's own change is the new height to go back to.
    m.set('height', 700)
    drag(grip, frame, 100, 200)
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(m.get('height')).toBe(700)
  })
})

describe('the R widget’s grip', () => {
  type Instance = { renderValue(value: unknown): void }
  type Definition = { factory(el: HTMLElement): Instance }

  /** The widget's declaration, from the script run as htmlwidgets runs it. */
  function declare(shiny: boolean): { definition: Definition; told: Array<[string, unknown]> } {
    const told: Array<[string, unknown]> = []
    let definition: Definition | null = null
    const globals = globalThis as unknown as Record<string, unknown>
    globals.HTMLWidgets = {
      shinyMode: shiny,
      widget: (declared: Definition) => {
        definition = declared
      },
      getInstance: () => null,
    }
    globals.Shiny = shiny
      ? { setInputValue: (name: string, value: unknown) => told.push([name, value]), addCustomMessageHandler: vi.fn() }
      : undefined
    const script = readFileSync(join(ROOT, 'widgets/r/inst/htmlwidgets/chromosomix.js'), 'utf8')
    new Function(script)()
    if (definition === null) throw new Error('the script declared no widget')
    return { definition, told }
  }

  function mount(shiny = false) {
    const { definition, told } = declare(shiny)
    const el = document.createElement('div')
    el.id = 'viewer'
    el.style.height = '600px'
    document.body.append(el)
    const instance = definition.factory(el)
    instance.renderValue({ src: 'https://chromosomix.app/?embed=1#uri=a.cool', title: 'x', files: [], requests: [] })
    const grip = el.querySelector<HTMLButtonElement>('button.chromosomix-grip')
    expect(grip, 'a grip under the frame').not.toBeNull()
    const frame = (): HTMLIFrameElement => el.querySelector('iframe') as HTMLIFrameElement
    return { el, grip: grip as HTMLButtonElement, frame, told }
  }

  it('resizes the widget, its frame filling it, and lets the pointer through mid-drag', () => {
    const { el, grip, frame } = mount()
    expect(drag(grip, frame, 100, 250)).toBe('none')
    expect(frame().style.pointerEvents).toBe('')
    expect(el.style.height).toBe('750px')
  })

  it('tells Shiny the height the reader left it at', () => {
    const { grip, frame, told } = mount(true)
    drag(grip, frame, 100, 250)
    grip.dispatchEvent(key('ArrowUp'))
    expect(told.filter(([name]) => name === 'viewer_height').map(([, value]) => value)).toEqual([750, 718])
  })

  it('goes back to the height R gave it on a double click, and keeps a floor', () => {
    const { el, grip, frame } = mount()
    drag(grip, frame, 100, 400)
    grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(el.style.height).toBe('600px')
    drag(grip, frame, 900, 0)
    expect(el.style.height).toBe('288px')
  })
})
