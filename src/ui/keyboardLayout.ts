/**
 * What the reader's keyboard types, as far as this page can tell.
 *
 * Five of the app's keys are bound by **where they are** rather than by what they
 * type: the digit row's `1` to `4` and the key to the left of `1` fold the side
 * columns, in the order the columns stand on the screen (`ui/SidePanel.ts`). A
 * position is what the browser reports as `KeyboardEvent.code`, whatever the
 * layout prints on the key — on AZERTY the bare `1` key types `&`, and the digit
 * takes Shift or Caps Lock — so matching a press needs nothing from here
 * (`ui/commands.ts` → `matchesKeys`). What this module answers is the two
 * questions `code` cannot:
 *
 * - **What to print on the key left of 1.** A backtick on a QWERTY keyboard,
 *   `²` on a French or Belgian PC, `@` on a French Mac, `^` on a German one. A
 *   badge reading *backtick* beside the Files column sends an AZERTY reader
 *   looking for a key that is AltGr and 7 on their keyboard.
 * - **Where the minus went.** `-` and `+` are bound by what they type, since
 *   they are not at one place across layouts — but an AZERTY PC puts `-` bare on
 *   its 6 key, so Shift or Caps Lock turn the very press a reader makes for the
 *   minus into a `6`. Whether a `6` from that key was a minus is a question about
 *   the layout, and every QWERTY layout types the same `6` under Caps Lock.
 *
 * Two sources, and neither is required. Chromium — and so the desktop build —
 * hands over the whole layout (`navigator.keyboard.getLayoutMap()`), which is
 * asked once ({@link readLayout}). Every browser shows it a key at a time, in the
 * keystrokes the reader makes anyway ({@link learnKey}): a key pressed with
 * nothing held says what it types bare, and a letter says it under Shift or Caps
 * Lock too, its case being all they change. Nothing is stored: a layout is a fact
 * about the machine in front of the reader, and the next one may be another.
 */

/** What each physical key types with nothing held, by `KeyboardEvent.code`. */
const bare = new Map<string, string>()
const listeners = new Set<() => void>()
/** The labels last handed out, so a listener hears about a change and not about every key. */
let told = labels()
let asked = false

/** `navigator.keyboard`, which no `lib.dom` declares: it is Chromium's alone. */
interface LayoutSource {
  getLayoutMap(): Promise<{ forEach(each: (key: string, code: string) => void): void }>
}

/** Whether the browser reports this modifier as on; `false` where it cannot say. */
export function modifierOn(event: KeyboardEvent, name: string): boolean {
  return typeof event.getModifierState === 'function' && event.getModifierState(name)
}

/** One character a keycap could carry: not a key name, not a space, not a control. */
function printable(text: string | undefined): text is string {
  return text !== undefined && [...text].length === 1 && /\S/u.test(text) && !/\p{Cc}/u.test(text)
}

const DIGIT_ROW = /^Digit\d$/

/**
 * Note what a keystroke says about the layout.
 *
 * Called for every keydown in the window, typing included — a locus typed into a
 * box is as good an answer as a shortcut — and before anything decides what the
 * keystroke does, so the press that teaches is also the first one read with it.
 */
export function learnKey(event: KeyboardEvent): void {
  // ⌘, Ctrl and Alt make a key type something else or nothing; AltGraph, which
  // Windows reports as Ctrl and Alt together, is the third level of the key.
  if (event.ctrlKey || event.metaKey || event.altKey || modifierOn(event, 'AltGraph')) return
  const { code, key } = event
  if (typeof code !== 'string' || code === '' || !printable(key)) return
  const caps = modifierOn(event, 'CapsLock')
  if (!event.shiftKey && !caps) {
    record(code, key)
    return
  }
  // A letter under exactly one of the two is its own capital, on every layout:
  // case is all either of them changes about a letter. Not so for the digit
  // row, whose other half Caps Lock types on an AZERTY PC.
  if (event.shiftKey !== caps && key.toLowerCase() !== key.toUpperCase()) record(code, key.toLowerCase())
}

function record(code: string, key: string): void {
  if (bare.get(code) === key) return
  // **A digit row types digits bare or it does not.** A key of it that
  // disagrees with what the others said is a layout switched under the page —
  // the reader's menu bar, mid-session — and the rest of the row is stale.
  if (DIGIT_ROW.test(code)) {
    const digit = /^\d$/.test(key)
    for (const [other, typed] of [...bare]) {
      if (DIGIT_ROW.test(other) && /^\d$/.test(typed) !== digit) bare.delete(other)
    }
  }
  bare.set(code, key)
  tell()
}

/**
 * Ask the browser for the whole layout, once.
 *
 * Chromium's alone, and refused there in a frame the embedding page did not
 * grant `keyboard-map` to — so a failure is the ordinary case and answers
 * nothing. What a keystroke has already said wins over what this brings back,
 * since it was said about the layout in use now.
 */
export async function readLayout(): Promise<void> {
  if (asked) return
  asked = true
  const keyboard =
    typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { keyboard?: Partial<LayoutSource> }).keyboard
  if (typeof keyboard?.getLayoutMap !== 'function') return
  try {
    const map = await keyboard.getLayoutMap()
    map.forEach((key, code) => {
      if (!bare.has(code) && printable(key)) bare.set(code, key)
    })
  } catch {
    return
  }
  tell()
}

/** What a physical key types bare, where something has said. */
export function bareKey(code: string): string | undefined {
  return bare.get(code)
}

/**
 * `true` where the digit row types digits bare, as on QWERTY; `false` where they
 * are its shifted half, as on AZERTY; `undefined` until a key of it has said.
 */
export function digitsBare(): boolean | undefined {
  for (const [code, key] of bare) if (DIGIT_ROW.test(code)) return /^\d$/.test(key)
  return undefined
}

/**
 * Whether the keys typed so far are AZERTY's.
 *
 * Read off the letters and the digit row, which are the two places AZERTY
 * differs from everything else, and which a reader presses whatever they are
 * doing — `w` for the whole genome is the key QWERTY calls Z.
 */
export function looksAzerty(): boolean {
  return (
    bare.get('KeyQ') === 'a' ||
    bare.get('KeyW') === 'z' ||
    bare.get('KeyA') === 'q' ||
    bare.get('KeyZ') === 'w' ||
    bare.get('Semicolon') === 'm' ||
    bare.get('Digit1') === '&' ||
    bare.get('Digit2') === 'é'
  )
}

/**
 * The character on the key left of `1`, or `undefined` where nothing has said.
 *
 * On a PC that key is always `Backquote`. A Mac is the awkward one: an ISO
 * keyboard — every European one — reports its top-left key as `IntlBackslash`
 * and the key beside the left Shift as `Backquote`, which is why both are bound
 * there (`ui/commands.ts`). So the label prefers `IntlBackslash`'s character
 * unless the layout is American or British, whose `Backquote` types a backtick:
 * on an American keyboard that *is* the top-left key, and on a British one it is
 * the key by Shift, which folds the column too. On a French or a German Mac the
 * key by Shift types `<`, which steps to the sequence before this one rather
 * than folding anything (`ui/commands.ts`), so it says nothing about this label.
 */
export function leftOfOne(mac: boolean): string | undefined {
  const grave = bare.get('Backquote')
  if (!mac) return grave ?? (looksAzerty() ? '²' : undefined)
  const beside = grave === '<' || grave === '>' ? undefined : grave
  const section = bare.get('IntlBackslash')
  if (section !== undefined && beside !== '`') return section
  if (beside !== undefined) return beside
  return looksAzerty() ? '@' : undefined
}

/**
 * Hear when the label of the key left of `1` changes; returns the unsubscribe.
 *
 * For the controls that print it, which are built once and would otherwise go
 * on saying *backtick* after the layout had answered.
 */
export function onLayoutChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * What the key left of `1` is labelled, on both platforms.
 *
 * Both rather than this one's: which platform this is, is `ui/commands.ts`'s to
 * say, and that module reads this one.
 */
function labels(): string {
  return `${leftOfOne(false) ?? ''}\n${leftOfOne(true) ?? ''}`
}

function tell(): void {
  const now = labels()
  if (now === told) return
  told = now
  for (const listener of [...listeners]) listener()
}

/** Forget every key, for a test that wants a keyboard nobody has touched. */
export function resetLayout(): void {
  bare.clear()
  told = labels()
  asked = false
}
