/**
 * One colour picker for every `<input type="color">` in the app (§26.6).
 *
 * The platform's own picker was the control until now, and it failed in three
 * ways a reader noticed. It led with three boxes of red, green and blue, when a
 * colour is copied between tools as six hex digits. It forgot: a colour given to
 * one track had to be found again by eye for the next. And a drag across its
 * square closed it after the first step — every swatch writes on `input`, the
 * write rebuilds the card, the rebuild replaces the `<input>`, and the browser
 * closes a picker whose input has left the page.
 *
 * So the inputs stay — they are still the swatch on screen, still keyboard
 * reachable, still what every caller listens to — and only the *popup* is ours.
 * {@link installColourPicker} listens for the click that would have opened the
 * platform's, prevents it, and opens this one under the swatch. The popup lives
 * in `document.body`, so a rebuild of the card under it takes nothing with it.
 * What it writes it writes into the input it was opened from, with the events
 * the platform fires: `input` on every step of a drag, `change` when the drag
 * or the typed value ends. A caller does not know which picker it got.
 *
 * Hex first: a box of six digits with the `#` outside it, taking three or six,
 * pasted with or without the `#`. Under it, the colours last chosen, shared by
 * every picker in the app and kept in `localStorage` for §5.5's reason — what a
 * reader has been picking is not *what is being looked at*.
 */

import { el } from './dom'
import { icon } from './icons'

const KEY = 'metacooler-viewer:recent-colours'

/** How many recent colours a picker offers — two rows of the popup's width. */
export const RECENT_LIMIT = 16

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

interface Hsv {
  /** 0–360. */
  h: number
  /** 0–1. */
  s: number
  /** 0–1. */
  v: number
}

/**
 * `#rrggbb`, lower case, from what a reader typed or pasted — or `null`.
 *
 * Three digits or six, with or without the `#`, and surrounding space ignored:
 * `56B4E9`, `#56b4e9`, ` #5be ` are all answers, and so are the `#rrggbbaa`
 * strings some tools copy, with the alpha dropped because an input of type
 * colour has none.
 */
export function parseHex(text: string): string | null {
  const bare = text.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(bare)) return `#${[...bare].map((digit) => digit + digit).join('')}`
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(bare)) return `#${bare.slice(0, 6)}`
  return null
}

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

function hsvOf(hex: string): Hsv {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255)
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  let h = 0
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max }
}

function hexOfHsv({ h, s, v }: Hsv): string {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6
    return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))
  }
  return hexOf(f(5), f(3), f(1))
}

// ---------------------------------------------------------------------------
// The recent colours
// ---------------------------------------------------------------------------

/** Newest first. Stored state outlives the code that wrote it, so each is checked. */
export function recentColours(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const item of parsed) {
      const hex = typeof item === 'string' ? parseHex(item) : null
      if (hex !== null && !out.includes(hex)) out.push(hex)
    }
    return out.slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/** Put a colour at the front of the list, once. */
export function rememberColour(colour: string): void {
  const hex = parseHex(colour)
  if (hex === null) return
  const next = [hex, ...recentColours().filter((item) => item !== hex)].slice(0, RECENT_LIMIT)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A private window, or storage full: the list is a convenience.
  }
}

// ---------------------------------------------------------------------------
// The popup
// ---------------------------------------------------------------------------

interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>
}

type EyeDropperCtor = new () => EyeDropperLike

/** The one open picker, if any. */
let open: Picker | null = null

class Picker {
  readonly root: HTMLElement
  private hsv: Hsv
  /** What the input held when it opened — remembered only if it changed. */
  private readonly start: string
  /** Whether an `input` has been sent that no `change` has closed yet. */
  private pending = false
  private readonly field: HTMLElement
  private readonly fieldKnob: HTMLElement
  private readonly hue: HTMLElement
  private readonly hueKnob: HTMLElement
  private readonly preview: HTMLElement
  private readonly hexBox: HTMLInputElement
  private readonly recent: HTMLElement

  constructor(readonly target: HTMLInputElement) {
    this.start = parseHex(target.value) ?? '#000000'
    this.hsv = hsvOf(this.start)

    this.fieldKnob = el('span', { class: 'cpick-knob' })
    this.field = el('div', {
      class: 'cpick-field',
      attrs: { tabindex: '0', role: 'slider', 'aria-label': 'Saturation and brightness' },
    }, this.fieldKnob)
    this.hueKnob = el('span', { class: 'cpick-knob' })
    this.hue = el('div', {
      class: 'cpick-hue',
      attrs: { tabindex: '0', role: 'slider', 'aria-label': 'Hue', 'aria-valuemin': '0', 'aria-valuemax': '360' },
    }, this.hueKnob)
    this.preview = el('span', { class: 'cpick-preview' })
    this.hexBox = el('input', {
      class: 'cpick-hex',
      type: 'text',
      title: 'Hex: three or six digits, with or without the #',
      attrs: { spellcheck: 'false', autocomplete: 'off', maxlength: '9', 'aria-label': 'Hex colour' },
    })
    this.recent = el('div', { class: 'cpick-recent' })

    const Dropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
    const dropper =
      Dropper === undefined
        ? null
        : el(
            'button',
            { class: 'btn btn-icon cpick-dropper', type: 'button', title: 'Pick a colour from the screen' },
            icon('pipette', { size: 14 }),
          )
    dropper?.addEventListener('click', () => {
      void new Dropper!()
        .open()
        .then(({ sRGBHex }) => {
          const hex = parseHex(sRGBHex)
          if (hex !== null) this.set(hsvOf(hex), true)
        })
        .catch(() => undefined)
    })

    this.root = el(
      'div',
      { class: 'cpick', attrs: { role: 'dialog', 'aria-label': target.title || 'Colour' } },
      this.field,
      this.hue,
      el(
        'div',
        { class: 'cpick-row' },
        this.preview,
        el('label', { class: 'cpick-hex-wrap' }, el('span', { class: 'cpick-hash', text: '#' }), this.hexBox),
        dropper,
      ),
      this.recent,
    )

    this.drag(this.field, (x, y) => this.set({ ...this.hsv, s: x, v: 1 - y }, false))
    this.drag(this.hue, (x) => this.set({ ...this.hsv, h: x * 360 }, false))
    this.field.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.01
      const move: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, step],
        ArrowDown: [0, -step],
      }
      const by = move[event.key]
      if (by === undefined) return
      event.preventDefault()
      this.set({ ...this.hsv, s: clamp(this.hsv.s + by[0]), v: clamp(this.hsv.v + by[1]) }, true)
    })
    this.hue.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1
      const by = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step : 0
      if (by === 0) return
      event.preventDefault()
      this.set({ ...this.hsv, h: (this.hsv.h + by + 360) % 360 }, true)
    })
    this.hexBox.addEventListener('input', () => {
      const hex = parseHex(this.hexBox.value)
      this.hexBox.classList.toggle('is-invalid', hex === null)
      if (hex !== null) this.set(hsvOf(hex), false, { keepText: true })
    })
    this.hexBox.addEventListener('change', () => this.commit())
    this.hexBox.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      this.commit()
      close()
    })

    this.paint({ keepText: false })
    this.paintRecent()
  }

  /** Put the popup under its swatch — above it where there is no room below. */
  place(): void {
    const box = this.target.getBoundingClientRect()
    const gap = 6
    const { width, height } = this.root.getBoundingClientRect()
    const below = box.bottom + gap
    const top = below + height > window.innerHeight - 8 && box.top - gap - height >= 8 ? box.top - gap - height : below
    const left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8))
    this.root.style.top = `${Math.max(8, top)}px`
    this.root.style.left = `${left}px`
  }

  focus(): void {
    this.hexBox.focus()
    this.hexBox.select()
  }

  /** The colour now, as the input's value. */
  get value(): string {
    return hexOfHsv(this.hsv)
  }

  /**
   * Take a new colour: paint it, write it into the input and say so with
   * `input`; `final` closes it with `change` as well.
   */
  private set(hsv: Hsv, final: boolean, options: { keepText?: boolean } = {}): void {
    this.hsv = { h: hsv.h, s: clamp(hsv.s), v: clamp(hsv.v) }
    this.paint(options)
    const hex = this.value
    if (this.target.value !== hex) {
      this.target.value = hex
      this.target.dispatchEvent(new Event('input', { bubbles: true }))
      this.pending = true
    }
    if (final) this.commit()
  }

  /** The `change` that ends a gesture, if anything has changed since the last. */
  commit(): void {
    if (!this.pending) return
    this.pending = false
    this.target.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /** Closing remembers the colour, where it is a new one. */
  finish(): void {
    this.commit()
    const hex = parseHex(this.target.value)
    if (hex !== null && hex !== this.start) rememberColour(hex)
  }

  private paint({ keepText }: { keepText?: boolean }): void {
    const hex = this.value
    this.field.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hexOfHsv({ h: this.hsv.h, s: 1, v: 1 })}`
    this.fieldKnob.style.left = `${this.hsv.s * 100}%`
    this.fieldKnob.style.top = `${(1 - this.hsv.v) * 100}%`
    this.fieldKnob.style.background = hex
    this.field.setAttribute('aria-valuetext', `saturation ${Math.round(this.hsv.s * 100)}%, brightness ${Math.round(this.hsv.v * 100)}%`)
    this.hueKnob.style.left = `${(this.hsv.h / 360) * 100}%`
    this.hueKnob.style.background = hexOfHsv({ h: this.hsv.h, s: 1, v: 1 })
    this.hue.setAttribute('aria-valuenow', String(Math.round(this.hsv.h)))
    this.preview.style.background = hex
    if (keepText !== true) {
      this.hexBox.value = hex.slice(1)
      this.hexBox.classList.remove('is-invalid')
    }
    for (const chip of this.recent.querySelectorAll<HTMLElement>('.cpick-chip')) {
      chip.classList.toggle('is-current', chip.dataset.colour === hex)
    }
  }

  private paintRecent(): void {
    const colours = recentColours()
    this.recent.replaceChildren(
      el('span', { class: 'cpick-recent-label', text: colours.length === 0 ? 'Colours you pick are kept here' : 'Recent' }),
      ...colours.map((colour) => {
        const chip = el('button', {
          class: 'cpick-chip',
          type: 'button',
          title: colour,
          style: { background: colour },
          attrs: { 'data-colour': colour, 'aria-label': `Use ${colour}` },
        })
        chip.classList.toggle('is-current', colour === this.value)
        chip.addEventListener('click', () => this.set(hsvOf(colour), true))
        return chip
      }),
    )
  }

  /**
   * A press on the square or the bar, and the drag that follows it, wherever the
   * pointer goes: the pointer is captured, so leaving the popup mid-drag keeps
   * the drag rather than ending it. `change` on the release.
   */
  private drag(node: HTMLElement, onMove: (x: number, y: number) => void): void {
    const at = (event: PointerEvent): void => {
      const box = node.getBoundingClientRect()
      const x = box.width > 0 ? clamp((event.clientX - box.left) / box.width) : 0
      const y = box.height > 0 ? clamp((event.clientY - box.top) / box.height) : 0
      onMove(x, y)
    }
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      node.focus()
      node.setPointerCapture?.(event.pointerId)
      at(event)
      const move = (next: PointerEvent): void => at(next)
      const up = (): void => {
        node.removeEventListener('pointermove', move)
        node.removeEventListener('pointerup', up)
        node.removeEventListener('pointercancel', up)
        this.commit()
      }
      node.addEventListener('pointermove', move)
      node.addEventListener('pointerup', up)
      node.addEventListener('pointercancel', up)
    })
  }
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n))
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

/** Open this app's picker for a colour input, closing any other. */
export function openColourPicker(target: HTMLInputElement): void {
  close()
  const picker = new Picker(target)
  open = picker
  document.body.append(picker.root)
  picker.place()
  picker.focus()
}

/** Close the open picker, if any, keeping what it chose. */
export function closeColourPicker(): void {
  close()
}

function close(): void {
  const picker = open
  if (picker === null) return
  open = null
  picker.finish()
  picker.root.remove()
}

/** The picker open now, for a test to look into. */
export function openPickerElement(): HTMLElement | null {
  return open?.root ?? null
}

let installed = false

/**
 * Take over every colour input in the document, now and to come.
 *
 * One listener on the document, in the capture phase, rather than a call in
 * each of the dozen places that build a swatch — so a swatch added next year
 * gets this picker without anyone remembering to ask for it. A press outside
 * the popup closes it, and so does Escape; a second click on the same swatch
 * closes it as the platform's did.
 */
export function installColourPicker(doc: Document = document): void {
  if (installed) return
  installed = true
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || target.type !== 'color' || target.disabled) return
      event.preventDefault()
      if (open?.target === target) close()
      else openColourPicker(target)
    },
    true,
  )
  doc.addEventListener(
    'pointerdown',
    (event) => {
      if (open === null) return
      const target = event.target
      if (target instanceof Node && (open.root.contains(target) || target === open.target)) return
      close()
    },
    true,
  )
  // On the window, and registered before any dialog is opened, so that Escape
  // in the picker closes the picker and not the dialog it was opened from:
  // `Modal` listens at the same place, later, and is stopped here.
  window.addEventListener(
    'keydown',
    (event) => {
      if (open === null || event.key !== 'Escape') return
      const target = event.target
      if (!(target instanceof Node) || !open.root.contains(target)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const swatch = open.target
      close()
      if (swatch.isConnected) swatch.focus()
    },
    true,
  )
  window.addEventListener('resize', () => close())
}

/** For a test: forget the installation, and close what is open. */
export function resetColourPickerForTests(): void {
  open?.root.remove()
  open = null
}
