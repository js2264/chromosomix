/**
 * The command registry: one description of every action, used three ways.
 *
 * The palette lists it, the shortcuts dialog documents it, and the global key
 * handler dispatches it. Keeping them one list is the point — a shortcut that
 * works but is not in the dialog, or a palette entry whose key has drifted, is
 * how command surfaces rot.
 *
 * Keys are written as `mod+p`, `?`, `<`. `mod` is ⌘ on a Mac and Ctrl
 * elsewhere, and `ctrl` is Control on both, which is what {@link matchesKeys}
 * resolves and {@link keyLabel} renders.
 *
 * Most keys are matched by what they type. The digits and the key left of `1`
 * are matched by **where they are**, since that is what they are chosen for:
 * the row folds the side columns in the order the columns stand, and on AZERTY
 * the bare `1` key types `&` (see {@link pressed}).
 */

import { el } from './dom'
import { icon, type IconName } from './icons'
import { bareKey, digitsBare, leftOfOne, modifierOn } from './keyboardLayout'

/**
 * Every key a *view* answers, in one object.
 *
 * The registry below is built fresh on demand from state the shell and the
 * session hold, so it cannot be read by the buttons that perform the same
 * actions — and a button's tooltip is where a reader actually discovers a key,
 * being what they are already pointing at when the thought "is there a faster
 * way to do this" arrives. This is the shared half: the command list binds
 * these, the tooltips name these, and a rebinding is one edit.
 *
 * The five panel folds are not here. Their keys live on the {@link
 * SidePanelSpec}s, next to the columns' names and widths, and each is already
 * printed beside its own heading.
 */
export const KEYS = {
  palette: 'mod+p',
  newSession: 'o',
  saveSession: 'mod+s',
  /**
   * Call the tab in front something other than its file.
   *
   * `F2`, which is what every list with renameable rows has used since file
   * managers had rows — and the one binding here that costs nothing else: the
   * single-letter space is spent, and the browser claims every chord a rename
   * would otherwise want.
   */
  renameSession: 'F2',
  /**
   * The tab beside this one: Control with the marks that step to the sequence
   * beside this one ({@link KEYS.next}), the same two marks one level up.
   *
   * Control on a Mac too, not ⌘, on the console's reasoning: a French Mac's
   * `<` is the key the system walks a program's windows with (⌘<, its ⌘`), and
   * ⌘ with the comma under QWERTY's `<` is every Mac program's settings.
   */
  nextSession: 'ctrl+>',
  prevSession: 'ctrl+<',
  theme: 't',
  /**
   * The console (§23), on the chord every terminal in every editor is behind.
   *
   * Control and the key left of `1` — ctrl-` on a QWERTY keyboard, which a
   * reader who has ever opened a terminal in an editor already presses, and
   * Ctrl-² on an AZERTY one, the same key. The key alone folds the Files column,
   * the first of the row the digits fold (`ui/SidePanel.ts`), so the console
   * took the chord. Control on a Mac as well, not ⌘: ⌘` is the system's, which
   * walks a program's windows and never reaches the page.
   */
  console: 'ctrl+`',
  /**
   * The store drawer (§24.2), at the other end of the keyboard from the console.
   *
   * A backslash: punctuation, so it cannot collide with the letters the views
   * are driven by, and the drawer is the console's sibling — a panel that folds
   * out of the window's edge rather than a dialog.
   */
  stores: '\\',
  /**
   * The shortcuts dialog, on the question mark — what every web application
   * that has such a card answers to, and the key a reader presses to ask.
   *
   * A bare key, so a box keeps it: `?` is a character of a URL and of a
   * contig name, and typed into one it is text (`App.onKeyDown`).
   */
  shortcuts: '?',
  /**
   * The one box every view has, whatever it is called there.
   *
   * The browser's is a locus bar *and* a search field, and it used to answer to
   * `l` as well — which was also the labels overlay, so in a browser session one
   * of the two silently lost. One box, one key.
   */
  find: '/',
  /**
   * The file's own landing table — Genomes on a metacool, Cells on an `.scool`.
   *
   * One binding rather than two, because it is one action: no file has both
   * tables, and a reader who learns `g` on one should not have to learn a
   * second letter for the other. The command's *title* is what changes.
   */
  genomes: 'g',
  contigs: 'c',
  whole: 'w',
  /**
   * The sequence before and after this one (§5.5), on the two marks that point
   * that way.
   *
   * They were `[` and `]`, which a French keyboard types with AltGr — a third
   * level, and so never a shortcut here — and a French Mac with ⇧⌥. Every
   * keyboard has `<` and `>` within reach of the left hand or under the right,
   * and {@link pressed} takes either half of the key they are on: QWERTY puts
   * them over the comma and the full stop, so those step too without Shift,
   * while AZERTY gives them a key of their own beside the left Shift, bare and
   * shifted.
   */
  previous: '<',
  next: '>',
  /**
   * Undo every pan and zoom: the map's block back to its canvas, the whole
   * genome across the 1D browser.
   *
   * The app's, heard on the window, like `−` and `+` beside it, rather than the
   * canvas's alone — which is where it used to be, so it did nothing until the
   * picture had been clicked. Bound by its place, as the digits that fold the
   * columns are: AZERTY's bare `0` key types `à`.
   */
  fit: '0',
  /**
   * *Bookmark this view* (§8.10): the place on screen, at the resolution it is
   * open at — the button beside `go`, from the keyboard.
   */
  bookmark: 'b',
  /**
   * The O/E toggle (§7.5): every cell divided by what its distance from the
   * diagonal predicts. `e` for expected; it was the breaks overlay's, which
   * took `m` for the margin they are drawn in (`ui/plotOptions.ts`).
   */
  expected: 'e',
  /**
   * One rung coarser and one finer on the resolution bar (§3.4): the same stops
   * the bar's radios are, walked from the keyboard.
   *
   * Bound by what they type, unlike the digit row: `-` and `+` stand in
   * different places on QWERTY and AZERTY, and a reader goes by the mark. Either
   * half of each key does — `_` and `=` as well — so neither needs Shift, which
   * `+` otherwise does on both; {@link matchesKeys} has the one layout whose
   * minus key types a 6.
   */
  coarser: '-',
  finer: '+',
  /**
   * Save what is on screen as a figure — the mounted view's own export.
   *
   * `s` for save, and it is the *plot* rather than the session: `⌘S` writes the
   * tab out as a config, this writes the picture out as a PDF or a PNG. The two
   * being one letter apart is the point — they are the two things a reader
   * means by "save this", and the modifier says which.
   */
  savePlot: 's',
  /**
   * The picture on the clipboard, ready to paste.
   *
   * The system copy chord, because that is the gesture: somebody looking at a
   * figure they want in a slide or a message presses ⌘C, and every other
   * application on their machine has taught them it works. It is the only
   * binding here that has to *give way* — with text selected, or the caret in a
   * box, ⌘C belongs to the browser and this yields (see `Command.yieldsToText`).
   *
   * A PNG, not the chosen export format: a clipboard holds an image, and a PDF
   * pasted into a slide is a file attachment rather than a figure. The Export
   * card's format still decides what the *download* beside it writes.
   */
  copyPlot: 'mod+c',
  /** Every track the same height, and that height the one that fills the space. */
  stretch: 'h',
  /** Every value axis back to what is in view. */
  autoscale: 'y',
  /**
   * The two pictures of one genome: the matrix, and the tracks along it.
   *
   * `v` for view, and a *switch* rather than two commands — a reader who puts
   * the map down to read a bigWig means to come back to it, and the same key
   * bringing it back is what makes putting it down safe to do. Nothing is
   * unloaded either way; see `Session.hideMap`.
   */
  mapToggle: 'v',
  /**
   * The diagonal lock (§7.2): onto the diagonal at the zoom the map is at, and
   * held there — the toggle beside the turn.
   *
   * Space, the one key a hand finds without looking, for the way a reader reads
   * a map along its diagonal. It used to put the view back on the line once,
   * and every pan and box after it landed a little off it again, so the key was
   * pressed after every gesture; now one press holds it and a second lets go.
   * It stands down wherever Space already has a job — a focused button it
   * presses, a box it ticks, a field it types into (see
   * `Command.yieldsToControls`).
   */
  diagonal: ' ',
} as const

/**
 * `'Autoscale every track'` + `'y'` → `'Autoscale every track (Y)'`.
 *
 * `undefined` gives the text back unchanged, so a control that has no shortcut
 * can be described by the same call as one that has. Not every control does:
 * `ui/plotOptions.ts` leaves the `legend` toggle keyless, and the single-letter
 * space is spent enough that it will not be the last. Absorbed here rather than
 * at the call sites, because a `?? ''` at each of them would print
 * `Legend — … ()`.
 */
export function withKey(text: string, keys: string | undefined): string {
  if (keys === undefined) return text
  const place = keyPlace(keys)
  return `${text} (${keyLabel(keys)}${place === undefined ? '' : `, ${place}`})`
}

/**
 * Where a key is, for the one bound by its place rather than by what it types.
 *
 * Its character is the reader's layout's, and before the page has heard from
 * that layout the badge is a guess — `backtick`, on a keyboard whose key there
 * says `²` — so wherever there is room for a sentence it says where the key is
 * as well. `undefined` for every other key, whose badge is what it types.
 */
export function keyPlace(keys: string): string | undefined {
  return parseKeys(keys).key === '`' ? 'the key left of 1' : undefined
}

/**
 * The key as a `<kbd>`, for a control with room to print it.
 *
 * A tooltip is discovered by hovering, which means it is discovered by someone
 * who already suspects there is something to discover. A badge on the button is
 * read by everyone who looks at the button.
 */
export function keyBadge(keys: string, options: { class?: string } = {}): HTMLElement {
  return el('kbd', {
    class: options.class === undefined ? 'kbd' : `kbd ${options.class}`,
    text: keyLabel(keys),
  })
}

/**
 * A text button that wears its key after the label, with a mark before it.
 *
 * The mark is a child for the same reason the badge is — see
 * {@link keyedButton} — and it earns its place on a control whose *label*
 * changes with the state: "contact map" and "1D browser" are two words for one
 * button, and the shape beside them is what a reader recognises before reading
 * either.
 */
export function keyedIconButton(
  name: IconName,
  label: string,
  keys: string,
  onClick: () => void,
  options: { class?: string; title?: string } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: options.class ?? 'btn btn-keyed',
    type: 'button',
    title: options.title ?? withKey(label, keys),
  })
  node.append(
    icon(name, { size: 14 }),
    el('span', { text: label }),
    keyBadge(keys, { class: 'kbd-inline' }),
  )
  node.addEventListener('click', onClick)
  return node
}

/**
 * A text button that wears its key after the label.
 *
 * The same shape as {@link button}, and separate from it because the badge is
 * a child rather than part of the text: `whole genome → W` as a string would be
 * a word, and would be read as one.
 */
export function keyedButton(
  label: string,
  keys: string,
  onClick: () => void,
  options: { class?: string; title?: string } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: options.class ?? 'btn',
    type: 'button',
    title: options.title ?? withKey(label, keys),
  })
  node.append(el('span', { text: label }), keyBadge(keys, { class: 'kbd-inline' }))
  node.addEventListener('click', onClick)
  return node
}

export interface Command {
  id: string
  title: string
  /** One line, shown under the title in the palette and the shortcuts list. */
  hint?: string
  /** Section heading in the palette and the shortcuts dialog. */
  group: string
  /** Key binding, or undefined for a palette-only command. */
  keys?: string
  /**
   * For a command that flips something: which way it is flipped right now.
   *
   * A palette that lists "Show the labels" and "Hide the labels" as the same
   * row under two names makes the reader read the row to find out what the app
   * is currently doing — and gets it backwards half the time, because the title
   * names the *outcome* and the eye reads it as the state. So a toggle is
   * titled once, by its noun, and wears its state as a chip: `Labels [on]` runs
   * the same command whichever way it reads, and the row says what pressing it
   * will change.
   */
  state?: 'on' | 'off'
  /**
   * Whether the command can act right now. A command that cannot is listed as
   * disabled rather than hidden: a palette that changes shape as you navigate
   * cannot be learned.
   */
  enabled?: boolean
  /**
   * Stand down when the keystroke is really about text.
   *
   * For the one binding that collides with something the browser already does:
   * ⌘C copies the figure, *unless* there is a selection to copy or a caret in a
   * box — and then it copies that, because taking a chord away from a reader
   * mid-word is a worse bug than not having the shortcut. Not `enabled`, which
   * would grey the entry out in a palette whose own filter box holds the focus
   * every time it is read; this is about the keystroke, not about the command.
   */
  yieldsToText?: boolean
  /**
   * Stand down when the keystroke is a focused control's.
   *
   * For Space, which a button, a tickbox, a menu row or a tab already answers:
   * a reader who has just pressed a button and presses Space again means that
   * button again, and the key going somewhere else instead is the shortcut
   * taking a gesture the page already had. See {@link wantsSpace}.
   */
  yieldsToControls?: boolean
  run(): void
}

/**
 * Whether ⌘C at this moment means "copy this text" rather than anything else.
 *
 * Two ways it can: the caret is in a field, or something on the page is
 * selected. `toString()` as well as `isCollapsed`, because a click on a canvas
 * can leave a range that spans no characters and is not collapsed either.
 */
export function wantsTextCopy(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  return selection !== null && !selection.isCollapsed && selection.toString() !== ''
}

/**
 * Whether Space, pressed now, belongs to what has the focus rather than to the
 * app: a field it types into, or a control it presses — a button, a link, a
 * tickbox, a menu row, a tab.
 */
export function wantsSpace(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true
  if (!(target instanceof Element)) return false
  return target.closest(SPACE_TAKERS) !== null
}

/** Everything the browser, or an ARIA role, gives Space a job on. */
const SPACE_TAKERS = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="slider"]',
].join(', ')

/** `true` on a platform where `mod` means ⌘. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/**
 * The modifier a map's selection takes, as the reader's keyboard prints it: ⌥
 * on a Mac, Alt elsewhere — never both, which asks a reader to work out which
 * half is theirs (`ui/dialogs.ts` on the gesture tables).
 */
export function optionKey(): string {
  return isMac() ? '⌥' : 'Alt'
}

/** Shift, as {@link optionKey} prints Option: ⇧ on a Mac, the word elsewhere. */
export function shiftKey(): string {
  return isMac() ? '⇧' : 'Shift'
}

/**
 * `mod+p` → `⌘P` or `Ctrl+P`, for display.
 *
 * The separator is joined *between* parts, so `mod` renders as the bare key
 * name and never carries its own trailing `+`. Spelling it `'Ctrl+'` and then
 * joining on `'+'` is what produced `Ctrl++P` in the action bar and in the
 * shortcuts dialog on every non-Mac browser.
 */
export function keyLabel(keys: string): string {
  const mac = isMac()
  const { mods, key } = parseKeys(keys)
  return [...mods.map((mod) => MODIFIERS[mod]?.[mac ? 0 : 1] ?? mod), keyGlyph(key, mac)].join(mac ? '' : '+')
}

/** Each modifier as a Mac writes it and as everything else does. */
const MODIFIERS: Record<string, readonly [string, string]> = { mod: ['⌘', 'Ctrl'], ctrl: ['⌃', 'Ctrl'] }

/**
 * A key's badge as the children of a `<kbd>`: {@link keyLabel}, with any
 * character a keycap prints high and small wrapped to be drawn larger and still
 * high (`.kbd-raised`).
 *
 * Which is the AZERTY PC's `²` on the key left of 1, and a German keyboard's
 * `^` there: printed as they are, at a badge's eleven pixels they were a speck
 * at the top of the cap beside a `1` that filled its own. Plain text for every
 * other key, so a badge is still read as its label wherever it is copied.
 */
export function keyCap(keys: string): Array<string | HTMLElement> {
  const parts: Array<string | HTMLElement> = []
  let plain = ''
  for (const char of keyLabel(keys)) {
    if (!RAISED.has(char)) {
      plain += char
      continue
    }
    if (plain !== '') parts.push(plain)
    plain = ''
    parts.push(el('span', { class: 'kbd-raised', text: char }))
  }
  if (plain !== '') parts.push(plain)
  return parts
}

/** The characters a layout puts high on a key, which a badge enlarges. */
const RAISED = new Set(['¹', '²', '³', '^', '°', '´', '¨'])

/**
 * What a key's badge says.
 *
 * The key left of `1` says what the reader's own keyboard has there, once the
 * page knows (`ui/keyboardLayout.ts`): `²` on an AZERTY PC, `@` on a French
 * Mac, a backtick on QWERTY — and a backtick, which is the commonest, until it
 * knows.
 */
function keyGlyph(key: string, mac: boolean): string {
  const shown = key === '`' ? (leftOfOne(mac) ?? '`') : key
  return NAMED_KEYS[shown] ?? (shown.length === 1 ? shown.toUpperCase() : shown)
}

/**
 * The keys whose glyph is not a name.
 *
 * A badge reading `` ` `` is a smudge at the top of a `<kbd>` — a reader cannot
 * tell it from `'` at 11 px, and cannot say it out loud to a colleague looking
 * over their shoulder. The word is longer and it is the thing they would say.
 * Only the marks that are genuinely unreadable are spelled out: `/` and `\\`
 * are unmistakable at any size and stay as they are. Space is the other
 * extreme — a badge with nothing in it at all. A hyphen is printed as the minus
 * sign it means, which is the width of the `+` beside it rather than a dash.
 */
const NAMED_KEYS: Record<string, string> = { '`': 'backtick', ' ': 'Space', '-': '−' }

/**
 * `mod+p` → `{ mods: ['mod'], key: 'p' }`.
 *
 * Not a plain split, because `+` is a key as well as the joint between keys: a
 * binding of `+` alone, or one ending `++`, ends on it.
 */
function parseKeys(keys: string): { mods: string[]; key: string } {
  if (keys === '+') return { mods: [], key: '+' }
  if (keys.endsWith('++')) return { mods: keys.slice(0, -2).split('+'), key: '+' }
  const parts = keys.split('+')
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] }
}

/**
 * The order the groups are printed in, wherever the whole registry is listed.
 *
 * The palette and the shortcuts dialog list the same commands and used to list
 * them in two different orders — insertion order in one, group-discovery order
 * in the other — so a reader who had learned where "Whole genome" sits in one
 * found it somewhere else in the other. One order, and it is the order of a
 * session: what the app is (App), what you open (File), where you go (Go), what
 * you see (View), and where the help is (Help).
 */
export const GROUP_ORDER = ['App', 'File', 'Go', 'View', 'Help'] as const

/** Group rank for a sort, with anything unlisted after the named ones. */
export function groupRank(group: string): number {
  const at = (GROUP_ORDER as readonly string[]).indexOf(group)
  return at < 0 ? GROUP_ORDER.length : at
}

/**
 * The state chip a toggle command wears — `on` / `off` — or nothing.
 *
 * One element, built in one place, because the palette row and the shortcuts
 * row are two printings of one fact and a second spelling of the chip would
 * make them look like two different things.
 */
export function stateChip(command: Command): HTMLElement[] {
  if (command.state === undefined) return []
  return [el('span', { class: 'kbd cmd-state', text: command.state })]
}

/** Does this event match a binding such as `mod+p`, `?`, `<` or `1`. */
export function matchesKeys(event: KeyboardEvent, keys: string): boolean {
  const { mods, key } = parseKeys(keys)
  if (mods.includes('mod')) {
    if (!(isMac() ? event.metaKey : event.ctrlKey)) return false
  } else if (mods.includes('ctrl')) {
    // Control itself, on a Mac too — see `KEYS.console`.
    if (!event.ctrlKey || event.metaKey || event.altKey) return false
  } else if (event.ctrlKey || event.metaKey || event.altKey) {
    // A bare key must not fire while a modifier is held: `mod+s` is the
    // browser's, and stealing it from a user trying to save the page is rude.
    // AltGraph is one of these too — Windows sends it as Ctrl and Alt — so the
    // third level of a key is never a shortcut.
    return false
  }
  return pressed(event, key)
}

/**
 * Whether the key a binding names is the one pressed — with or without Shift,
 * with or without Caps Lock, on QWERTY and on AZERTY alike.
 *
 * **The digits by position** (`Digit1`), or by the digit itself, which is how
 * the keypad arrives: AZERTY's bare `1` key types `&`, and a reader pressing the
 * key with the 1 on it means the 1 whichever half of it the layout puts first.
 *
 * **The key left of 1 by position as well** ({@link isLeftOfOne}): a backtick
 * on QWERTY, `²` on an AZERTY PC, `@` on a French Mac, and the binding is the
 * place.
 *
 * **`-`, `+`, `<` and `>` by what they type** ({@link isMinus}, {@link isPlus},
 * {@link isAngle}), either half of the key they are on, because they are not
 * at one place across layouts; and every other key the same way, letters
 * regardless of case.
 */
function pressed(event: KeyboardEvent, key: string): boolean {
  if (/^\d$/.test(key)) return event.code === `Digit${key}` || event.key === key
  if (key === '`') return isLeftOfOne(event)
  if (key === '-') return isMinus(event)
  if (key === '+') return isPlus(event)
  if (key === '<' || key === '>') return isAngle(event, key)
  return typeof event.key === 'string' && event.key.toLowerCase() === key.toLowerCase()
}

/**
 * The key left of `1`, wherever the keyboard reports it.
 *
 * A Mac's ISO keyboard — every European one — reports that key as
 * `IntlBackslash` and the one beside the left Shift as `Backquote`, so on a Mac
 * both answer: on a British one the second is a backtick too. **Never a key
 * that types `<` or `>`**, though, which is what that second key is on a French
 * or a German Mac — the sequence steps' (`KEYS.previous`), and a press of it
 * folded the Files column whenever there was no sequence to step to.
 */
function isLeftOfOne(event: KeyboardEvent): boolean {
  if (event.key === '<' || event.key === '>') return false
  return event.code === 'Backquote' || (event.code === 'IntlBackslash' && isMac()) || event.key === '`'
}

/**
 * `<` or `>`, either half of the key it is on.
 *
 * AZERTY, like most European layouts, gives the pair a key of its own beside
 * the left Shift, and there the two marks are its two halves. American and
 * British QWERTY put them over the comma and the full stop, so those count too
 * — by place as well as by character, since AZERTY types its comma on the M key
 * and its full stop as Shift and `;`, neither of which carries a mark.
 */
function isAngle(event: KeyboardEvent, mark: '<' | '>'): boolean {
  if (event.key === mark) return true
  return mark === '<'
    ? event.key === ',' && event.code === 'Comma'
    : event.key === '.' && event.code === 'Period'
}

const DIGIT_ROW = /^Digit\d$/

/**
 * The minus key, either half of it.
 *
 * `_` is Shift's half on QWERTY and on every Mac — but not the `_` an AZERTY PC
 * types bare on its 8, which is nowhere near a minus. And an AZERTY PC's minus
 * *is* its 6 key, bare, which Shift and Caps Lock turn into a `6`
 * ({@link minusUnderSix}).
 */
function isMinus(event: KeyboardEvent): boolean {
  const { key, code } = event
  if (key === '-') return true
  if (key === '_') return !DIGIT_ROW.test(code ?? '')
  return code === 'Digit6' && key === '6' && minusUnderSix(event)
}

/**
 * Whether a `6` from the 6 key is AZERTY's minus under Shift or Caps Lock.
 *
 * Bare, a `6` is a 6 on every layout there is; with both held they cancel, and
 * AZERTY's key types its minus as itself. Under one of them it is a question
 * about the layout: QWERTY types `^` there under Shift and ignores Caps Lock,
 * so a `6` under Shift is AZERTY's while under Caps Lock it is either's. Where
 * the 6 key has been seen typing something bare, that answers it
 * (`ui/keyboardLayout.ts`). Until then a `6` under Shift is the minus, and so is
 * one under Caps Lock unless the row has been seen typing bare digits: the one
 * press this reads wrong is a QWERTY reader's, with Caps Lock on, pressing 6 at
 * the map before any other key — and Chromium's layout map answers even that.
 */
function minusUnderSix(event: KeyboardEvent): boolean {
  if (event.shiftKey === modifierOn(event, 'CapsLock')) return false
  const six = bareKey('Digit6')
  if (six !== undefined) return six === '-'
  return event.shiftKey || digitsBare() !== true
}

/**
 * The plus key, either half of it.
 *
 * `=` is that key's bare half on QWERTY and on AZERTY. Shifted, `=` is a key of
 * its own — Shift and 0, on a German keyboard — and not this one.
 */
function isPlus(event: KeyboardEvent): boolean {
  return event.key === '+' || (event.key === '=' && !event.shiftKey)
}

/**
 * Whether a keystroke should be treated as text rather than as a command.
 *
 * Everything typed into an input belongs to that input — including `?`, which
 * is a legal character in a contig name and in a URL.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Whether a keystroke carries a command modifier — ⌘ or Ctrl.
 *
 * The one thing that can still be a command while the user is typing into an
 * input. Asked *before* the command list is built, so a bare letter typed into
 * a filter box costs one boolean rather than fifteen command objects and four
 * linear scans of the contig names.
 */
export function isChord(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}
