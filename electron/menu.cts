/**
 * The native menu bar, written out item by item.
 *
 * An explicit template rather than Electron's default, because the default is a
 * *browser's* menu — reload, force reload, zoom in, zoom out, actual size — and
 * three of those actively break this application. What is here is a menu that
 * names the things the viewer can do, in the places a user of the platform
 * looks for them.
 *
 * ---
 *
 * **The accelerator rule, which is the whole reason this file needs a comment.**
 *
 * Electron handles a *registered* accelerator in the main process, before the
 * page's `keydown` listener runs. The page never sees the keystroke. So an item
 * mirroring an in-page command must be declared with
 * `registerAccelerator: false`: the key is still *displayed* beside the menu
 * item, which is the point of putting it there, but delivery stays with
 * `src/main.ts`'s own handler and the command registry stays the single source
 * of truth.
 *
 * Register them for real and two things go wrong at once, both silently. The
 * shortcuts dialog starts documenting less than the app responds to — because
 * half the bindings are now in a file the dialog does not read. And a bare
 * letter, which is what most of these are, is swallowed *everywhere*: a
 * registered `G` means the letter `g` can no longer be typed into the contigs
 * filter box.
 *
 * `Open…` is the one real accelerator here, and it is safe for a reason worth
 * checking rather than assuming: it is `CmdOrCtrl+O`, and `matchesKeys`
 * (`src/ui/commands.ts:63`) refuses to fire a bare-letter binding while ⌘ or
 * Ctrl is held. So the page's `o` and the menu's `⌘O` cannot collide.
 *
 * `CmdOrCtrl+P` is reserved for the command palette and must never be given to
 * a menu item — on a platform where that is conventionally Print, an item here
 * would take it and the palette would stop opening with no error.
 */

import { BrowserWindow, Menu, app, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import { CHANNEL_COMMAND, type MenuCommandId } from './contract.cjs'

const REPO_URL = 'https://github.com/js2264/metacooler.js'

/** Send a command id to the focused window's page. */
function send(id: MenuCommandId): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  target?.webContents.send(CHANNEL_COMMAND, id)
}

/**
 * A menu item that mirrors an in-page command.
 *
 * `registerAccelerator: false` is not optional and is not a style choice; see
 * the note at the top of this file. It is factored into a helper precisely so
 * that adding an item cannot forget it.
 */
function mirror(label: string, id: MenuCommandId, accelerator?: string): MenuItemConstructorOptions {
  return {
    label,
    ...(accelerator === undefined ? {} : { accelerator, registerAccelerator: false }),
    click: () => send(id),
  }
}

export function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    // The application menu: About, Services, Hide, Quit. On macOS its absence
    // is not a missing feature but a broken-looking app -- there is no other
    // place ⌘Q lives.
    template.push({
      label: app.name,
      submenu: [
        { label: 'About (meta)cooler', click: () => send('about') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push({
    label: '&File',
    submenu: [
      // The one real accelerator. It returns to the picker, which is what
      // "open a different file" means in an app whose open *is* a drop target.
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
      mirror('New session', 'new-session', 'O'),
      // The session, not the figure: everything about this tab as a file that
      // opens it again. The figure has its own button in the Plot card.
      mirror('Save session…', 'save-session', 'CmdOrCtrl+S'),
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  })

  // Cut/copy/paste/select-all. The app has text inputs -- the URL box, every
  // table filter -- and on macOS these roles are what bind ⌘C and ⌘V at all.
  template.push({
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  })

  template.push({
    label: '&Go',
    submenu: [
      // A static menu cannot follow the page's dev features switch (§29.5), so
      // its words are the ones true for every page: the file's own landing
      // table is a metagenome's genomes or an scool's cells, and a step is a
      // step to the next sequence, whichever kind it is.
      mirror('Landing table', 'go-genomes', 'G'),
      mirror('Contigs table', 'go-contigs', 'C'),
      mirror('Whole genome', 'go-overview', 'W'),
      { type: 'separator' },
      mirror('Previous sequence', 'go-prev', '<'),
      mirror('Next sequence', 'go-next', '>'),
    ],
  })

  const view: MenuItemConstructorOptions[] = [
    // `1`, the first of the digit row that folds the columns in the order they
    // stand (`src/ui/SidePanel.ts`). Displayed, never registered, like the rest.
    mirror('File info sidebar', 'fold-sidebar', '1'),
    mirror('Cycle the theme', 'theme', 'T'),
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]

  // Deliberately absent from this menu, each for a reason that is not obvious:
  //
  // - `reload` / `forceReload`. ⌘R tears down the reader worker and the mounted
  //   `File`, and a dropped file cannot be re-read without the user dropping it
  //   again -- so the browser reflex costs them their open file. It also sits
  //   next to ⌘T, which is the theme.
  // - the three page-zoom roles. They change the canvas's *CSS* size, which
  //   `largestDpiThatFits` (`src/ui/export.ts:215`) reads -- so the same
  //   "300 dpi" click yields a different pixel count at 125 %, and an exported
  //   figure silently stops matching the number printed on it.
  //
  // Devtools stays while developing and is gone from what ships: a packaged app
  // with an inspector is a debugging surface on a machine we do not control.
  if (!app.isPackaged) {
    view.push({ type: 'separator' }, { role: 'toggleDevTools' })
  }

  template.push({ label: '&View', submenu: view })

  template.push({ role: 'windowMenu' })

  template.push({
    label: '&Help',
    submenu: [
      mirror('Keyboard shortcuts', 'shortcuts', '?'),
      { label: 'About (meta)cooler', click: () => send('about') },
      { type: 'separator' },
      {
        label: 'Source and issues on GitHub',
        click: () => void shell.openExternal(REPO_URL),
      },
    ],
  })

  return Menu.buildFromTemplate(template)
}
