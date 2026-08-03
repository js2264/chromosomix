/**
 * The bridge, which is two members wide.
 *
 * A preload runs with access to both the page and to Node, which makes it the
 * one place in an Electron app where a convenience can become an escape route.
 * So the rule here is that nothing general is exposed: not `ipcRenderer`, not a
 * `send`, not an `invoke`. Two values, one of them read-only data and the other
 * a listener over a closed set of strings.
 *
 * `.cts`, and CommonJS: a sandboxed preload cannot be an ES module. This is the
 * concrete reason the whole `electron/` directory compiles under `NodeNext`
 * while the package itself is `type: module`.
 */

import { contextBridge, ipcRenderer } from 'electron'

import { CHANNEL_COMMAND, isMenuCommandId, type DesktopPlatform } from './contract.cjs'

/**
 * Read at preload time, never written down.
 *
 * `process.versions` is the authority for all three; a version pinned in the
 * repository would be stale within a week and trusted anyway, because it
 * appears under the word "version" in a dialog.
 *
 * `signed: false` is a constant for as long as the releases are unsigned, and
 * it is deliberately *here* rather than inferred in the renderer: the page
 * cannot find out, and a hardcoded `false` in a file that also builds the
 * signed release would be a lie waiting to happen. When signing lands, this is
 * the one line that changes.
 */
const platform: DesktopPlatform = {
  electron: process.versions.electron ?? '',
  chrome: process.versions.chrome ?? '',
  node: process.versions.node ?? '',
  platform: process.platform,
  arch: process.arch,
  signed: false,
}

contextBridge.exposeInMainWorld('metacoolerDesktop', {
  platform,

  /**
   * Call `handler` when the user picks a menu item.
   *
   * The id is validated against the frozen list before the handler sees it —
   * a fixed set, not a passthrough. The page's command registry is the set of
   * everything this app can do, so forwarding an arbitrary string into it would
   * make the channel name the only thing standing between a message and any
   * action in the application.
   *
   * Returns nothing: there is no unsubscribe because there is exactly one
   * listener, installed once at startup, for the lifetime of the window.
   */
  onCommand(handler: (id: string) => void): void {
    if (typeof handler !== 'function') return
    ipcRenderer.on(CHANNEL_COMMAND, (_event, id: unknown) => {
      if (!isMenuCommandId(id)) return
      handler(id)
    })
  },
})
