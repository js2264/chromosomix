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
  run(): void
}

/** `true` on a platform where `mod` means ⌘. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** `mod+p` → `⌘P` or `Ctrl+P`, for display. */
export function keyLabel(keys: string): string {
  const mod = isMac() ? '⌘' : 'Ctrl+'
  return keys
    .split('+')
    .map((part) => (part === 'mod' ? mod : part.length === 1 ? part.toUpperCase() : part))
    .join(isMac() ? '' : '+')
    .replace(/\+$/, '')
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
