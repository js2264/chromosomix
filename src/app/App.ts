/**
 * The window: header, tab strip, three columns, status bar, address bar.
 *
 * Everything here is shared by every open session and owned by none of them. A
 * {@link Session} holds a file and the views of it; this holds the furniture
 * around them and decides which one is on screen.
 *
 * Three things are deliberately *not* per session, because they are preferences
 * about this window rather than facts about a file: the theme, and the fold and
 * width of each column. A user who narrowed the Annotations column did not
 * narrow it for one file.
 *
 * The **address bar names the active tab and nothing else** (§5.5). A hash is
 * one view state and there is exactly one of those on screen; writing all of
 * them would make every link a description of somebody else's workspace, and
 * make the back button walk a history that interleaves three files. The other
 * tabs live in `sessionStorage` instead, which is where the rest of the
 * per-session memory already lives (§8.6).
 */

import { ViewerError } from '../errors'
import { parseViewState, serialiseViewState, viewStateEquals } from '../state/ViewState'
import type { ViewState } from '../types'
import { openCommandPalette } from '../ui/CommandPalette'
import { FilePicker } from '../ui/FilePicker'
import { Modal } from '../ui/Modal'
import {
  AESTHETICS_PANEL,
  ANNOTATION_PANEL,
  GENERAL_PANEL,
  SidePanel,
} from '../ui/SidePanel'
import { StatusBar } from '../ui/StatusBar'
import { ThemeToggle } from '../ui/ThemeToggle'
import { IS_DESKTOP, desktop } from '../desktop'
import { isChord, isTypingTarget, keyLabel, matchesKeys, type Command } from '../ui/commands'
import { openAbout, openShortcuts } from '../ui/dialogs'
import { button, el } from '../ui/dom'
import { icon, iconButton } from '../ui/icons'
import { demoExamples } from '../ui/examples'
import { fileLabel } from '../ui/labels'
import { appMark } from '../ui/mark'
import { PLOT_OPTION_LABELS, getPlotOptions, togglePlotOption } from '../ui/plotOptions'
import { Session, reserveSessionIds, type SessionHost } from './Session'
import { TabStrip } from './TabStrip'
import { highestId, readSessions, writeSessions, type SessionSnapshot } from './sessions'

/** Where "source" points, from the about dialog and the header. */
const REPO_URL = 'https://github.com/js2264/metacooler.js'

/** The document title with nothing open; the file name is prefixed to it. */
const APP_TITLE = '(meta)cooler'

/**
 * How many sessions may be open at once.
 *
 * Not a rendering limit — the tab strip scrolls — but a memory one. Each session
 * that has opened something owns a worker, an h5wasm instance and, for a
 * whole-file view, a matrix held whole in memory (§2). Twelve is well past what
 * anyone opens deliberately and well short of what makes a laptop swap.
 */
const MAX_SESSIONS = 12

export class App implements SessionHost {
  private readonly sessions: Session[] = []
  private active = 0

  private readonly content: HTMLElement
  private readonly breadcrumbSlot: HTMLElement
  /**
   * The three columns beside the map, outward from it in order of how often
   * they are touched.
   *
   * Window furniture rather than parts of a view, for three reasons that apply
   * to all of them: they start under the breadcrumb instead of below the view's
   * own heading, they scroll on their own instead of dragging the heatmap up the
   * page when one grows a card too many, and they outlive every navigation *and*
   * every tab switch — what changes when a tab is switched is which session's
   * cards are parented into them, not the columns themselves.
   */
  private readonly generalPanel: SidePanel
  private readonly annotationsPanel: SidePanel
  private readonly aestheticsPanel: SidePanel
  private readonly tabs: TabStrip
  private readonly theme: ThemeToggle
  private readonly status: StatusBar
  /** At most one dialog at a time; it owns the keyboard while it is up. */
  private modal: Modal | null = null
  /** Set while this class is the one moving the hash, so it ignores the echo. */
  private writingHash = false

  constructor(root: HTMLElement) {
    this.breadcrumbSlot = el('div', { class: 'breadcrumb-slot' })
    this.content = el('main', { class: 'content' })
    // Folding or dragging a column changes how much room the plot has and where
    // its centre is. A `ResizeObserver` inside the view cannot see all of that:
    // the plot is usually sized by the window's *height*, so widening its column
    // changes no box the observer watches while still moving where the plot
    // should sit. Telling the mounted view directly is the reliable half.
    const relayout = (): void => this.current?.relayout()
    this.generalPanel = new SidePanel(GENERAL_PANEL, relayout)
    this.annotationsPanel = new SidePanel(ANNOTATION_PANEL, relayout)
    this.aestheticsPanel = new SidePanel(AESTHETICS_PANEL, relayout)

    this.status = new StatusBar({ client: () => this.current?.client ?? null })
    this.theme = new ThemeToggle()
    this.tabs = new TabStrip({
      onSelect: (index) => this.activate(index),
      onClose: (index) => this.closeSession(index),
      onNew: () => this.newSession(),
    })

    // The title is the way home. It reads as one, so it should behave as one:
    // clicking it returns to the file picker, which is the only view above
    // every other (§5.1).
    const home = button('(meta)cooler', () => this.current?.toPicker(), {
      class: 'brand-name brand-home',
      title: 'Back to the file picker',
    })

    const palette = button('', () => this.openPalette(), { class: 'action-bar' })
    palette.replaceChildren(
      el('span', { class: 'action-bar-text', text: 'Search commands…' }),
      el('kbd', { class: 'kbd', text: keyLabel('mod+p') }),
    )
    palette.title = 'Every action in this app, searchable'

    const source = el('a', {
      class: 'btn btn-icon',
      href: REPO_URL,
      title: 'Source, issues and the format specification on GitHub',
      attrs: { target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'source on GitHub' },
    })
    source.appendChild(icon('github'))

    root.append(
      el(
        'header',
        { class: 'app-head' },
        el(
          'div',
          { class: 'head-left' },
          this.generalPanel.toggle,
          this.annotationsPanel.toggle,
          this.aestheticsPanel.toggle,
          el(
            'div',
            { class: 'brand' },
            // Before the name: the same mark as the tab's favicon and the dock
            // icon, so the window and the taskbar entry agree about what this
            // app is. Sized against the name rather than the row — 26 px beside
            // a 16 px name is the proportion a favicon has to a tab title.
            appMark(26),
            home,
            el('span', {
              class: 'brand-sub',
              // The one string that genuinely differs between the targets.
              // "in the browser" is the web app's hook -- it is the surprising
              // half of what it does -- and it is simply false in a window that
              // is not one. Everything else about privacy is reworded to be
              // true of both rather than branched; see `FilePicker.ts`.
              text: IS_DESKTOP
                ? '(multi-genome) cool files, on your machine'
                : '(multi-genome) cool files, in the browser',
            }),
          ),
        ),
        palette,
        el(
          'div',
          { class: 'head-actions' },
          // Theme, shortcuts, source, about. No "open a file" button: the
          // title is the way back to the picker and says so on hover.
          this.theme.el,
          iconButton('keyboard', 'Keyboard shortcuts', () => this.openShortcutsDialog()),
          source,
          iconButton('info', 'About this viewer', () => this.openAboutDialog()),
        ),
      ),
      this.tabs.el,
      this.breadcrumbSlot,
      // Each column carries its own `order`, so the DOM order here is free —
      // and it is content-first, which is what the tab order should be.
      el(
        'div',
        { class: 'app-body' },
        this.content,
        this.generalPanel.el,
        this.annotationsPanel.el,
        this.aestheticsPanel.el,
      ),
      this.status.el,
    )

    window.addEventListener('keydown', (event) => this.onKeyDown(event))
    window.addEventListener('popstate', () => this.readHash())
    window.addEventListener('hashchange', () => this.readHash())

    // A menu click and a keystroke are the same thing arriving by a different
    // road, so they end at the same place: the command registry. The menu holds
    // no behaviour of its own, which is what keeps the shortcuts dialog honest
    // about everything the app responds to.
    desktop()?.onCommand((id) => {
      const command = this.commands().find((entry) => entry.id === id)
      if (command === undefined || command.enabled === false) return
      command.run()
    })

    // A file dropped anywhere *except* the dropzone otherwise navigates the
    // window to a binary blob — and in a desktop window there is no address bar
    // and no back button to return from it. The main process refuses that
    // navigation outright (`will-navigate`), which is the un-bypassable half;
    // this is the graceful one, and it is the only one the browser has.
    //
    // Unconditional, not gated on the target: the same miss on the website
    // replaces the app with a download prompt or a page of binary, which is no
    // better for being recoverable.
    document.addEventListener('dragover', (event) => event.preventDefault())
    document.addEventListener('drop', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('.dropzone') !== null) return
      event.preventDefault()
    })

    this.restore()
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private get current(): Session | undefined {
    return this.sessions[this.active]
  }

  /**
   * Rebuild the tabs a previous visit left behind, and open exactly one of them.
   *
   * Lazily by design: a restored tab holds its view state and nothing else until
   * it is clicked, so eight remembered files cost eight tab labels rather than
   * eight workers and eight fetches. The one that *is* opened is whichever the
   * address bar names — a link decides which tab you land on, and the remembered
   * choice only decides it when the link says nothing.
   */
  private restore(): void {
    const linked = parseViewState(window.location.hash)
    const stored = readSessions()
    reserveSessionIds(highestId(stored.sessions))

    for (const snapshot of stored.sessions.slice(0, MAX_SESSIONS)) {
      const state = parseViewState(snapshot.hash)
      if (state === null) continue
      const session = new Session(this, snapshot.id)
      session.prime(state)
      this.sessions.push(session)
    }

    // The link wins. If it names a file one of the restored tabs already holds,
    // that tab *is* the link's tab — reopening it in a ninth would leave two
    // tabs on one file, sharing neither their tracks nor their filters and
    // looking as though they should.
    let target = -1
    if (linked !== null) {
      target = this.sessions.findIndex((session) => session.state?.uri === linked.uri)
      if (target < 0) {
        const session = new Session(this)
        session.prime(linked)
        this.sessions.push(session)
        target = this.sessions.length - 1
      } else {
        this.sessions[target].prime(linked)
      }
    } else if (stored.active !== null) {
      target = this.sessions.findIndex((session) => session.id === stored.active)
    }

    if (this.sessions.length === 0) this.sessions.push(new Session(this))
    this.active = target >= 0 ? target : 0
    this.paintTabs()
    this.mountActive()
    this.current?.activate()
  }

  private newSession(): Session | null {
    if (this.sessions.length >= MAX_SESSIONS) {
      this.warn(
        `${MAX_SESSIONS} sessions is the limit. Each one holds a worker and, for a whole-file ` +
          'view, a matrix in memory — close one to open another.',
      )
      return null
    }
    const session = new Session(this)
    this.sessions.push(session)
    this.activate(this.sessions.length - 1)
    return session
  }

  private activate(index: number): void {
    if (index < 0 || index >= this.sessions.length) return
    this.active = index
    this.paintTabs()
    this.mountActive()
    const session = this.sessions[index]
    session.activate()
    this.writeHash(session.state, { replace: false })
    this.remember()
  }

  /**
   * Close a session and put its worker down.
   *
   * The last tab is never closed, it is emptied: a window with no tabs has
   * nothing to drop a file onto, and "close" would then read as "quit" in a
   * page that cannot quit.
   */
  private closeSession(index: number): void {
    const session = this.sessions[index]
    if (session === undefined) return
    if (this.sessions.length === 1) {
      session.toPicker()
      this.remember()
      return
    }
    const was = this.active
    session.destroy()
    this.sessions.splice(index, 1)
    // Closing a tab that is not the one you are reading must not move you. Only
    // closing the active one does, and then attention goes to the neighbour on
    // the left, which is where every other tab strip sends it.
    this.activate(index < was ? was - 1 : index > was ? was : Math.max(0, index - 1))
  }

  /** Parent the active session's DOM into the shell. */
  private mountActive(): void {
    const session = this.current
    if (session === undefined) return
    this.content.replaceChildren(session.contentEl)
    this.breadcrumbSlot.replaceChildren(session.breadcrumbHost)
    this.generalPanel.setContent([session.generalHost])
    this.annotationsPanel.setContent([session.annotationsHost])
    this.aestheticsPanel.setContent([session.aestheticsHost])
    this.applyPanels(session)
    document.title =
      session.state === null ? APP_TITLE : `${fileLabel(session.state.uri)} — ${APP_TITLE}`
  }

  private applyPanels(session: Session): void {
    const panels = session.panels
    this.generalPanel.setAvailable(panels.general)
    this.annotationsPanel.setAvailable(panels.annotations)
    this.aestheticsPanel.setAvailable(panels.aesthetics)
  }

  private paintTabs(): void {
    this.tabs.render(
      this.sessions.map((session, index) => ({
        id: session.id,
        label: session.label,
        hint: session.tabHint,
        active: index === this.active,
        pending: session.isPrimed,
      })),
      this.sessions.length < MAX_SESSIONS,
    )
  }

  private remember(): void {
    const snapshots: SessionSnapshot[] = []
    for (const session of this.sessions) {
      const state = session.state
      if (state === null) continue
      snapshots.push({ id: session.id, hash: serialiseViewState(state) })
    }
    writeSessions({ sessions: snapshots, active: this.current?.id ?? null })
  }

  // -------------------------------------------------------------------------
  // SessionHost
  // -------------------------------------------------------------------------

  sessionChanged(session: Session): void {
    this.paintTabs()
    if (session !== this.current) return
    document.title =
      session.state === null ? APP_TITLE : `${fileLabel(session.state.uri)} — ${APP_TITLE}`
  }

  stateChanged(session: Session, options: { replace: boolean }): void {
    this.remember()
    if (session !== this.current) return
    this.writeHash(session.state, options)
  }

  panelsChanged(session: Session): void {
    if (session !== this.current) return
    this.applyPanels(session)
  }

  activity(session: Session): void {
    if (session !== this.current) return
    this.status.refresh()
  }

  /**
   * Open a file over whatever is on screen, rather than going back to the
   * landing page for one.
   *
   * The file crumb used to *navigate* to the picker, which threw the current
   * view away to ask a question — and a user who then changed their mind had no
   * way back to the map they were reading, because the file they had dropped
   * cannot be re-opened without another gesture (§11). As a dialog it asks the
   * same question over the top: Escape, the close button or the backdrop leave
   * everything exactly as it was, and choosing a file replaces it deliberately.
   *
   * Its own {@link FilePicker}, not the one mounted in the content area: that
   * element is the landing view and moving it into a dialog would empty the
   * page behind it.
   */
  openFileDialog(session: Session): void {
    if (this.modal !== null) return
    const modal: Modal = new Modal({
      title: 'Open a file',
      variant: 'modal-wide',
      body: () =>
        new FilePicker({
          onOpen: (uri, source) => {
            modal.close()
            void session.open(uri, source)
          },
          examples: demoExamples(),
        }).el,
      onClose: () => {
        this.modal = null
      },
    })
    this.modal = modal
  }

  // -------------------------------------------------------------------------
  // The address bar
  // -------------------------------------------------------------------------

  private writeHash(state: ViewState | null, options: { replace: boolean }): void {
    const hash = state === null ? '' : `#${serialiseViewState(state)}`
    if (window.location.hash === hash) return
    this.writingHash = true
    const url = `${window.location.pathname}${window.location.search}${hash}`
    if (options.replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    this.writingHash = false
  }

  /**
   * Follow the address bar: the back button, a pasted link, a hand-edited hash.
   *
   * It moves the *active* tab, and only it. A hash is one view state and the
   * active tab is the one it is a picture of; opening a new tab for every step
   * of a back-button walk would turn a history into a pile of windows.
   */
  private readHash(): void {
    if (this.writingHash) return
    const session = this.current
    if (session === undefined) return
    const parsed = parseViewState(window.location.hash)
    if (viewStateEquals(parsed, session.state)) return
    // `set` notifies, which reaches `stateChanged`, which writes the hash — and
    // finds it already exactly this and does nothing. That is the loop closing
    // rather than a guard against it: one comparison, in one place.
    session.store.set(parsed)
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Every action, rebuilt on demand so `enabled` reflects the state the user is
   * actually in. One list feeds the palette, the shortcuts dialog and the key
   * handler; a shortcut that works but is undocumented is how these rot.
   *
   * Two halves: what this window does, and what the active session does. They
   * are merged rather than nested so the palette shows one flat list — a reader
   * looking for "next contig" is not thinking about which object owns it.
   */
  private commands(): Command[] {
    const session = this.current
    // A browser session has a genome rather than a file, and it fills all three
    // columns exactly as a map does — so everything gated on "is anything open"
    // has to count it, or half the View menu goes dead the moment a bigWig is
    // dropped instead of a cooler.
    const file = session?.hasFile === true || session?.isBrowsing === true
    const isMetacool = session?.isMetacool === true
    const overlays = getPlotOptions()
    const list: Command[] = [
      {
        id: 'palette',
        group: 'App',
        title: 'Search commands',
        keys: 'mod+p',
        run: () => this.openPalette(),
      },
      {
        id: 'open-file',
        group: 'File',
        title: 'Open a different file',
        keys: 'o',
        run: () => session?.toPicker(),
      },
      {
        id: 'new-session',
        group: 'File',
        title: 'New session',
        hint: 'Another tab, with its own file, tracks and settings.',
        keys: 'mod+t',
        enabled: this.sessions.length < MAX_SESSIONS,
        run: () => this.newSession(),
      },
      {
        id: 'close-session',
        group: 'File',
        title: 'Close this session',
        hint:
          this.sessions.length === 1
            ? 'The last tab is emptied rather than closed — there would be nothing to drop a file on.'
            : undefined,
        keys: 'mod+w',
        run: () => this.closeSession(this.active),
      },
      {
        id: 'next-session',
        group: 'Go',
        title: 'Next session',
        keys: 'mod+]',
        enabled: this.sessions.length > 1,
        run: () => this.activate((this.active + 1) % this.sessions.length),
      },
      {
        id: 'prev-session',
        group: 'Go',
        title: 'Previous session',
        keys: 'mod+[',
        enabled: this.sessions.length > 1,
        run: () =>
          this.activate((this.active - 1 + this.sessions.length) % this.sessions.length),
      },
      ...(session?.commands() ?? []),
    ]

    const overlayKeys: Array<[keyof typeof PLOT_OPTION_LABELS, string]> = [
      ['crosshair', 'x'],
      ['dividers', 'd'],
      ['breaks', 'e'],
      ['labels', 'l'],
      ['ticks', 'k'],
    ]
    for (const [key, binding] of overlayKeys) {
      list.push({
        id: `overlay-${key}`,
        group: 'View',
        title: `${overlays[key] ? 'Hide' : 'Show'} ${PLOT_OPTION_LABELS[key].label}`,
        hint: PLOT_OPTION_LABELS[key].hint,
        keys: binding,
        run: () => void togglePlotOption(key),
      })
    }

    list.push(
      {
        id: 'fold-sidebar',
        group: 'View',
        title: 'Fold or show the General panel',
        keys: 'b',
        enabled: file,
        run: () => this.generalPanel.toggle.click(),
      },
      {
        id: 'fold-annotations',
        group: 'View',
        title: 'Fold or show the Annotations panel',
        hint: 'A metacool carries no annotations (§8.5), so it has no panel to fold.',
        keys: 'a',
        // The same gate the button is under: it is `hidden` on a file with a
        // genome layer, and a shortcut that folds an invisible column is a key
        // that appears to do nothing.
        enabled: file && !isMetacool,
        run: () => this.annotationsPanel.toggle.click(),
      },
      {
        id: 'fold-aesthetics',
        group: 'View',
        title: 'Fold or show the Aesthetics panel',
        hint: 'A table view offers none, so there is nothing to fold there.',
        keys: 'm',
        enabled: file,
        run: () => this.aestheticsPanel.toggle.click(),
      },
      {
        id: 'theme',
        group: 'View',
        title: 'Cycle the theme: system, light, dark',
        keys: 't',
        run: () => this.theme.el.click(),
      },
      {
        id: 'shortcuts',
        group: 'Help',
        title: 'Keyboard shortcuts',
        keys: '?',
        run: () => this.openShortcutsDialog(),
      },
      { id: 'about', group: 'Help', title: 'About this viewer', run: () => this.openAboutDialog() },
      {
        id: 'source',
        group: 'Help',
        title: 'Source on GitHub',
        run: () => window.open(REPO_URL, '_blank', 'noopener'),
      },
    )
    return list
  }

  /**
   * Dispatch a keystroke.
   *
   * A dialog owns the keyboard while it is open, and anything typed into an
   * input belongs to that input — `?` and `[` are legal in a contig name, and
   * `o` is legal in every name there is. Chords survive both, because ⌘P from a
   * text box is still ⌘P.
   */
  private onKeyDown(event: KeyboardEvent): void {
    if (this.modal !== null) return
    const typing = isTypingTarget(event.target)
    // Above the loop, not inside it.
    //
    // `commands()` rebuilds twenty command objects and their closures, and two
    // of them call `stepTarget` twice each — which in a region view is a linear
    // scan of every contig name, four times over. That ran on **every keydown in
    // the document**, so typing into a filter box cost ~900,000 string
    // comparisons per character to discover that the only `mod+` binding does
    // not match a bare letter.
    if (typing && !isChord(event)) return
    for (const command of this.commands()) {
      if (command.keys === undefined || command.enabled === false) continue
      if (typing && !command.keys.startsWith('mod+')) continue

      if (!matchesKeys(event, command.keys)) continue
      event.preventDefault()
      command.run()
      return
    }
  }

  private openPalette(): void {
    if (this.modal !== null) return
    this.modal = openCommandPalette(this.commands(), () => {
      this.modal = null
    })
  }

  private openShortcutsDialog(): void {
    if (this.modal !== null) return
    this.modal = openShortcuts(this.commands(), () => {
      this.modal = null
    })
  }

  private openAboutDialog(): void {
    if (this.modal !== null) return
    // `desktop()?.platform` rather than a flag: on the website there is no
    // bridge and the dialog says exactly what it says today.
    this.modal = openAbout(REPO_URL, desktop()?.platform ?? null, () => {
      this.modal = null
    })
  }

  /** A refusal that is not about a file, so it has no error view to live in. */
  private warn(message: string): void {
    if (this.modal !== null) return
    this.modal = new Modal({
      title: 'Not this time',
      body: () => el('p', { text: message }),
      onClose: () => {
        this.modal = null
      },
    })
  }
}

/** Re-exported so the bootstrap can name the one error type it may see. */
export { ViewerError }
