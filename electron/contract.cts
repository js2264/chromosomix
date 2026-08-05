/**
 * The only things the main process and the renderer agree about.
 *
 * Deliberately tiny, and deliberately a *list* rather than a shape. The bridge
 * this describes carries menu clicks in one direction and nothing back — no
 * file paths, no bytes, no handles. Everything the viewer does it already does
 * in the page, so a wider bridge would be surface area bought with nothing.
 *
 * Imported by `main.cts`, `menu.cts` and `preload.cts`. The renderer has its own
 * declaration of the same shape in `src/desktop.ts`: the two files cannot share
 * a module, because one is compiled by the Node project and the other is in the
 * bundle that the *web* build also ships. Structural duplication of ten
 * identifiers was the cheaper of the two mistakes.
 */

/** The single IPC channel. Main sends, renderer listens. */
export const CHANNEL_COMMAND = 'metacooler:command'

/**
 * Every command a menu item is allowed to trigger.
 *
 * A fixed list, frozen, checked in the preload before anything is dispatched —
 * not a passthrough of whatever string arrived. The menu is built in the main
 * process, so a passthrough would let anything that can reach the channel name
 * invoke arbitrary command ids in the page, and the set of commands is exactly
 * the set of things this app can do.
 *
 * These are `src/main.ts`'s own command ids. A typo here is a menu item that
 * silently does nothing, which is why `menu.cts` is typed against this tuple
 * rather than against `string`.
 */
export const MENU_COMMAND_IDS = Object.freeze([
  'open-file',
  'new-session',
  'save-session',
  'go-genomes',
  'go-contigs',
  'go-overview',
  'go-prev',
  'go-next',
  'fold-sidebar',
  'theme',
  'shortcuts',
  'about',
] as const)

export type MenuCommandId = (typeof MENU_COMMAND_IDS)[number]

/** `true` when `id` is one of the commands a menu may send. */
export function isMenuCommandId(id: unknown): id is MenuCommandId {
  return typeof id === 'string' && (MENU_COMMAND_IDS as readonly string[]).includes(id)
}

/**
 * What the renderer is allowed to know about the machine it is running on.
 *
 * Versions are read from `process.versions` at preload time rather than pinned
 * anywhere: Electron's Chromium and Node move within a major, and a number
 * written down in this repository would be wrong within a week and believed
 * anyway, because it appears in an about dialog under the word "version".
 *
 * `signed` is here because it is the answer to a question the user has already
 * asked — they clicked through a warning to get this far, and the about dialog
 * is where they look to find out whether that was expected.
 */
export interface DesktopPlatform {
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  signed: boolean
}
