/**
 * The command registry: one description of every action, used three ways.
 *
 * The palette lists it, the shortcuts dialog documents it, and the global key
 * handler dispatches it. Keeping them one list is the point — a shortcut that
 * works but is not in the dialog, or a palette entry whose key has drifted, is
 * how command surfaces rot.
 *
 * Keys are written as `mod+p`, `?`, `[`. `mod` is ⌘ on a Mac and Ctrl
 * elsewhere, which is what {@link matchesKeys} resolves and {@link keyLabel}
 * renders.
 */

import { el } from './dom'
import { icon, type IconName } from './icons'

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
 * The three panel folds are not here. Their keys live on the {@link
 * SidePanelSpec}s, next to the columns' names and widths, and each is already
 * printed beside its own heading.
 */
export const KEYS = {
  palette: 'mod+p',
  newSession: 'o',
  saveSession: 'mod+s',
  closeSession: 'mod+w',
  /**
   * Call the tab in front something other than its file.
   *
   * `F2`, which is what every list with renameable rows has used since file
   * managers had rows — and the one binding here that costs nothing else: the
   * single-letter space is spent (`ui/plotOptions.ts` explains giving up `f`),
   * and the browser claims every chord a rename would otherwise want.
   */
  renameSession: 'F2',
  nextSession: 'mod+]',
  prevSession: 'mod+[',
  theme: 't',
  /**
   * The console (§23), on the key every terminal in every editor is behind.
   *
   * A backtick rather than a letter, and not only because the single-letter
   * space is spent (`ui/plotOptions.ts` explains giving up `f`): a reader who
   * has ever pressed ctrl-` in an editor already knows what this opens, and a
   * mark of punctuation cannot collide with the letters the views are driven by.
   */
  console: '`',
  shortcuts: 'mod+/',
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
  previous: '[',
  next: ']',
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
} as const

/**
 * `'Autoscale every track'` + `'y'` → `'Autoscale every track (Y)'`.
 *
 * `undefined` gives the text back unchanged, so a control that has no shortcut
 * can be described by the same call as one that has. Not every control does:
 * `ui/plotOptions.ts` gave `f` to the Files panel and left its `fills` toggle
 * keyless, and the single-letter space is spent enough that it will not be the
 * last. Absorbed here rather than at the call sites, because a `?? ''` at each
 * of them would print `Track fill — … ()`.
 */
export function withKey(text: string, keys: string | undefined): string {
  return keys === undefined ? text : `${text} (${keyLabel(keys)})`
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

/** `true` on a platform where `mod` means ⌘. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
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
  return keys
    .split('+')
    .map((part) => (part === 'mod' ? (mac ? '⌘' : 'Ctrl') : part.length === 1 ? part.toUpperCase() : part))
    .join(mac ? '' : '+')
}

/** Does this event match a binding such as `mod+p` or `?`. */
export function matchesKeys(event: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+')
  const wantsMod = parts.includes('mod')
  const key = parts[parts.length - 1]
  const hasMod = isMac() ? event.metaKey : event.ctrlKey
  if (wantsMod !== hasMod) return false
  // A bare letter must not fire while a modifier is held: `mod+s` is the
  // browser's, and stealing it from a user trying to save the page is rude.
  if (!wantsMod && (event.ctrlKey || event.metaKey || event.altKey)) return false
  return event.key.toLowerCase() === key.toLowerCase()
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
