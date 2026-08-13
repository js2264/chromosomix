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
  ANALYSIS_PANEL,
  ANNOTATION_PANEL,
  GENERAL_PANEL,
  SidePanel,
} from '../ui/SidePanel'
import { StatusBar } from '../ui/StatusBar'
import { ThemeToggle } from '../ui/ThemeToggle'
import { desktop } from '../desktop'
import {
  KEYS,
  isChord,
  isTypingTarget,
  keyLabel,
  matchesKeys,
  wantsTextCopy,
  withKey,
  type Command,
} from '../ui/commands'
import { openAbout, openShortcuts } from '../ui/dialogs'
import { button, dragHasFiles, el } from '../ui/dom'
import { filesFrom } from '../ui/chooseFiles'
import { icon, iconButton } from '../ui/icons'
import { demoExamples } from '../ui/examples'
import { downloadBlob, exportBaseName, fileStamp } from '../ui/export'
import { applyConfig, configFileName } from '../state/SessionConfig'
import { fileMemoryKey } from '../state/UiMemory'
import {
  WORKSPACE_VERSION,
  flushWorkspace,
  forgetWorkspace,
  readWorkspace,
  recordAction,
  summariseWorkspace,
  writeWorkspace,
  type Workspace,
  type WorkspaceSession,
} from '../state/workspace'
import { forgetEverything, storedItems } from '../state/stored'
import { hydrateHandles } from '../state/handles'
import { openStoredData, restoreBanner } from '../ui/RestoreCard'
import { decodeShare, readShareHash } from '../state/shareLink'
import { openShareDialog } from '../ui/ShareDialog'
import { fileLabel } from '../ui/labels'
import { appMark } from '../ui/mark'
import {
  PLOT_OPTION_KEYS,
  PLOT_OPTION_LABELS,
  getPlotOptions,
  togglePlotOption,
} from '../ui/plotOptions'
import { refineEnabled, toggleRefine } from '../ui/refine'
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
  /**
   * Where the offer to reopen a previous workspace sits, when there is one.
   *
   * A slot the shell owns rather than something a session shows, because the
   * offer is about *N tabs* and a session deliberately knows nothing about the
   * window it is in (`app/Session.ts`). It is also why this is not on the
   * picker: a link opened into a fresh browser shows that file rather than the
   * picker, and the reader's other six tabs are exactly as worth offering then.
   */
  private readonly restoreSlot = el('div', { class: 'restore-slot' })
  /**
   * Whether the durable record may be written to yet.
   *
   * `false` for the moment between the shell existing and the boot deciding
   * what to do about a previous workspace. See {@link rememberDurably}.
   */
  private durableSettled = false
  /** `true` while the offer is on screen and has not been answered. */
  private offering = false
  private readonly breadcrumbSlot: HTMLElement
  /**
   * Where the active session parents its Analysis drawer.
   *
   * A slot rather than a drawer, for the reason the content area is a slot: an
   * open task is a fact about a *file*, so switching tabs must show the drawer
   * exactly when that tab had one open, and the shell has no business knowing
   * which. It also keeps `AnalysisDrawer` out of this module entirely.
   */
  private readonly drawerSlot: HTMLElement
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
  /**
   * The fourth, and the one that lists jobs rather than controls (§18.1).
   *
   * Furniture on the same terms as the other three: its fold is a preference
   * about this window, and what changes on a tab switch is whose rows are
   * parented into it. The *drawer* is not here at all — it is a per-session
   * thing, so the session owns it and this shell only lends it a place to sit,
   * exactly as it does for the content area.
   */
  private readonly analysisPanel: SidePanel
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
    this.drawerSlot = el('div', { class: 'drawer-slot' })
    // Folding or dragging a column changes how much room the plot has and where
    // its centre is. A `ResizeObserver` inside the view cannot see all of that:
    // the plot is usually sized by the window's *height*, so widening its column
    // changes no box the observer watches while still moving where the plot
    // should sit. Telling the mounted view directly is the reliable half.
    const relayout = (): void => this.current?.relayout()
    this.generalPanel = new SidePanel(GENERAL_PANEL, relayout)
    this.annotationsPanel = new SidePanel(ANNOTATION_PANEL, relayout)
    this.aestheticsPanel = new SidePanel(AESTHETICS_PANEL, relayout)
    this.analysisPanel = new SidePanel(ANALYSIS_PANEL, relayout)

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
      el('kbd', { class: 'kbd', text: keyLabel(KEYS.palette) }),
    )
    palette.title = withKey('Every action in this app, searchable', KEYS.palette)

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
          el(
            'div',
            { class: 'brand' },
            // Before the name: the same mark as the tab's favicon and the dock
            // icon, so the window and the taskbar entry agree about what this
            // app is. Sized against the name rather than the row — 26 px beside
            // a 16 px name is the proportion a favicon has to a tab title.
            appMark(26),
            home,
          ),
          // …and the four columns after it, not before. They are controls over
          // the window's own furniture, and a row that opens with four unlabelled
          // marks makes a reader identify them before reaching the thing that
          // says what they are looking at. The strapline that used to hold this
          // side of the header is gone with them: it explained the app to
          // somebody who has already opened it, and this is the row where the
          // panels are reached from.
          el(
            'div',
            { class: 'head-panels' },
            this.generalPanel.toggle,
            this.annotationsPanel.toggle,
            this.aestheticsPanel.toggle,
            this.analysisPanel.toggle,
          ),
        ),
        palette,
        el(
          'div',
          { class: 'head-actions' },
          // Save the session, theme, shortcuts, source, about. No "open a
          // file" button: the title is the way back to the picker and says so
          // on hover.
          iconButton('link', 'Share this session as a link', () => this.openShareDialog()),
          iconButton(
            'save',
            withKey('Save this session as a file, to open again later', KEYS.saveSession),
            () => this.exportSession(),
          ),
          this.theme.el,
          iconButton('keyboard', withKey('Keyboard shortcuts', KEYS.shortcuts), () =>
            this.openShortcutsDialog(),
          ),
          source,
          iconButton('info', 'About this viewer', () => this.openAboutDialog()),
        ),
      ),
      this.tabs.el,
      // Empty except on the first screen of a browser that was closed with work
      // in it. A row of its own rather than a floating bar, because what it
      // offers is the reader's own workspace and it must not cover the drop
      // target — see `ui/RestoreCard.ts`.
      this.restoreSlot,
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
        this.analysisPanel.el,
        // Last, so it paints over the columns beside it without needing a
        // stacking context of its own beyond the one its `z-index` gives it.
        this.drawerSlot,
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
    // The durable workspace is written on a trailing debounce, and a timer does
    // not survive the page going away — so without this the last few seconds of
    // a session are precisely the ones lost, and they are the ones the reader
    // remembers. `pagehide` rather than `beforeunload`: it fires for a tab put
    // into the back/forward cache too, and it does not make the browser offer to
    // block the navigation. `visibilitychange` covers the mobile case, where a
    // tab is often never "hidden" so much as switched away from and reaped.
    //
    // Both handlers **rebuild** the record before flushing it, and that is not
    // belt and braces. `remember()` runs on a *view state* change, and most of
    // what a workspace is does not touch the view state at all: loading eight
    // tracks, placing a mark, saving a bookmark, filtering a table. Each of
    // those persists itself into session memory and none of them navigates, so
    // a record written at the last navigation would come back to a reader
    // missing every one of them — the session as it was ten minutes before they
    // closed the window. Rebuilding here costs one pass over the open tabs at
    // the one moment it is certainly worth paying for.
    const save = (): void => {
      this.rememberDurably()
      void flushWorkspace()
    }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save()
    })

    document.addEventListener('dragover', (event) => event.preventDefault())
    document.addEventListener('drop', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('.dropzone') !== null) return
      event.preventDefault()
    })

    // Dropping is *the* gesture this app is opened with, so the whole content
    // area takes it and not only the marked rectangle on the landing page: a
    // reader who is already looking at a map and wants a track on it should not
    // have to find a drop zone in a column, and one who wants a second map
    // beside it should not have to find the `+` on its edge. What each file
    // means is the session's decision, by name — see `Session.dropFiles`, which
    // adds rather than replaces in every case it can.
    this.content.addEventListener('dragover', (event) => {
      // Files only. A track row dragged out of the Tracks card is also a drag
      // across this area — it is on its way to the map's edge rectangles — and
      // outlining the whole content area for it would say the content area is
      // where it goes.
      if (!dragHasFiles(event)) return
      event.preventDefault()
      this.content.classList.add('over')
    })
    this.content.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && this.content.contains(event.relatedTarget)) return
      this.content.classList.remove('over')
    })
    this.content.addEventListener('drop', (event) => {
      this.content.classList.remove('over')
      // Three targets answer for themselves. The landing page's drop zone
      // answers differently — it opens a file rather than adding one to what is
      // open — and the map's edge zones answer *more specifically*: the same
      // file, and the stack of lanes the reader aimed at. The deck's empty cells
      // and its `+` edges (§16.9) are the third: a cooler dropped on one is a
      // map for *that cell*, and without this line it was also imported here, so
      // one drop opened the companion the reader aimed at and loaded the same
      // file over the lead as a track. All three still bubble, so this handler
      // is what takes the highlight off.
      //
      // `Element`, not `HTMLElement`. An inline `<svg>` is an `SVGElement` and
      // is a live hit target across its whole box, so a drop on the `+` glyph
      // in the middle of a deck edge — the most obvious pixel on it — failed
      // the test, skipped the exemption entirely, and was imported here on top
      // of being opened there. `closest` is on `Element`, so nothing else has
      // to change; the two older targets never showed it because their children
      // are all `<div>` and `<span>`.
      if (
        event.target instanceof Element &&
        event.target.closest('.dropzone, .lane-drop, .deck-drop') !== null
      ) {
        return
      }
      const files = filesFrom(event.dataTransfer)
      if (files.length === 0) return
      event.preventDefault()
      void this.current?.dropFiles(files)
    })

    // Started here and deliberately **not** awaited. Reading the granted files
    // into memory is what lets a tab's tooltip be written synchronously and what
    // keeps a permission prompt off the far side of a storage read — but a
    // database that is slow, or refuses to open, must not hold up the picker.
    // Anything that genuinely needs the answer awaits the same promise.
    void hydrateHandles()

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
    // A shared link is not a view state and must not be read as one. It is
    // opened *after* the tabs are restored and mounted, because opening a
    // session needs a session to open it into — so the boot proceeds as though
    // the fragment were empty, and the link lands in the active tab a moment
    // later.
    const shared = readShareHash(window.location.hash) !== null
    const linked = shared ? null : parseViewState(window.location.hash)
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
    if (shared) void this.openSharedHash()
    this.current?.activate()
    // Only when session storage had nothing, which is exactly "the browser was
    // closed" — a reload has its own, fresher answer above and must not be
    // asked a question it already knows. Last, and asynchronous, so a database
    // that is slow or refuses to open delays nothing on the boot path.
    //
    // A reload settles immediately: there is no question to ask, so the record
    // may be written from this moment. The other branch settles when the read
    // comes back, which is what keeps an empty startup window from deleting the
    // workspace it is about to be offered.
    if (stored.sessions.length > 0) this.durableSettled = true
    else void this.offerWorkspace()
  }

  /**
   * Ask whether to pick up where a previous browser session stopped.
   *
   * An offer and not a restore, for two reasons that are not the same reason:
   * reopening six files a week later reverses the decision the reader made by
   * closing them, and on a shared machine it would put somebody's unpublished
   * figure on screen for whoever sat down next (§11). `ui/RestoreCard.ts` makes
   * the same argument at more length, beside the wording.
   *
   * Nothing here is awaited by the caller and nothing it does can fail visibly:
   * a record that will not load is a banner that does not appear, which is the
   * state every browser was in before this existed.
   */
  private async offerWorkspace(): Promise<void> {
    let workspace: Workspace | null = null
    try {
      workspace = await readWorkspace()
    } finally {
      // Whatever the answer, the question has now been asked, so the record may
      // be written from here on — including when the read failed, where the
      // right behaviour is simply the app as it was before any of this existed.
      this.durableSettled = true
    }
    if (workspace === null) return
    // The reader has been working while the record was read. Whatever they have
    // done since is theirs, and an offer to replace it would be an interruption
    // rather than a courtesy.
    if (this.sessions.some((session) => session.state !== null)) return
    this.offering = true
    const answered = (): void => {
      this.offering = false
      this.restoreSlot.replaceChildren()
    }
    this.restoreSlot.replaceChildren(
      restoreBanner({
        summary: summariseWorkspace(workspace),
        savedAt: workspace.savedAt,
        onRestore: () => {
          answered()
          this.adoptWorkspace(workspace as Workspace)
        },
        onDismiss: () => {
          answered()
          void forgetWorkspace()
        },
      }),
    )
  }

  /**
   * Seat a remembered workspace in this window.
   *
   * **The `applyConfig` below runs before a single `prime`, and that ordering is
   * the whole of why this method is not three lines.** A primed tab is one that
   * holds a view state and has read nothing (`Session.prime`), and
   * `exportConfig` builds a config by reading that tab's `UiMemory` — which,
   * after a browser restart, is empty. So the first `activate()` would call
   * `remember()`, gather eight empty configs, and overwrite the good record with
   * them. Silently, permanently, and looking exactly like "the restore lost my
   * tracks". Writing the workspace into memory first makes `exportConfig`
   * honest from the very first write, and costs a handful of `sessionStorage`
   * writes per tab.
   *
   * It is also the order `SessionConfig` already requires for a different
   * reason: `applyConfig` must precede the file opening, because the annotation
   * machinery reads those scopes on its way up.
   */
  private adoptWorkspace(workspace: Workspace): void {
    for (const session of this.sessions) session.destroy()
    this.sessions.length = 0
    reserveSessionIds(highestId(workspace.sessions.map((row) => ({ id: row.id, hash: '' }))))

    for (const row of workspace.sessions.slice(0, MAX_SESSIONS)) {
      applyConfig(row.config, fileMemoryKey(row.id, row.config.state.uri))
      const session = new Session(this, row.id)
      session.prime(row.config.state)
      this.sessions.push(session)
    }
    if (this.sessions.length === 0) this.sessions.push(new Session(this))

    const wanted = this.sessions.findIndex((session) => session.id === workspace.active)
    this.active = wanted >= 0 ? wanted : 0
    this.paintTabs()
    this.mountActive()
    this.writeHash(this.current?.state ?? null, { replace: true })
    this.current?.activate()
    this.remember()
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
    // Replace, never push. `readHash` moves the *active* tab and has no way to
    // switch tabs, so a history entry left by a tab switch would, when popped,
    // hand one tab's file to another — two tabs on one file, which §5.6 exists
    // to prevent. The back button then walks the active tab's own navigation,
    // which is the history a reader is actually thinking about.
    this.writeHash(session.state, { replace: true })
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
    this.analysisPanel.setContent([session.analysisHost])
    this.drawerSlot.replaceChildren(session.drawerHost)
    this.applyPanels(session)
    document.title =
      session.state === null ? APP_TITLE : `${fileLabel(session.state.uri)} — ${APP_TITLE}`
  }

  private applyPanels(session: Session): void {
    const panels = session.panels
    this.generalPanel.setAvailable(panels.general)
    this.annotationsPanel.setAvailable(panels.annotations)
    this.aestheticsPanel.setAvailable(panels.aesthetics)
    this.analysisPanel.setAvailable(panels.analysis)
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
    this.rememberDurably()
  }

  /**
   * The same act, written where closing the browser cannot reach it.
   *
   * An **addition** to the line above rather than a replacement for it, and the
   * two are not redundant. `sessionStorage` remains the truth for this browsing
   * context — it is strictly fresher, and a reload reads it and never looks at
   * the durable copy. This record exists for the one case that storage cannot
   * answer at all: the browser was closed.
   *
   * It carries a whole {@link SessionConfig} per tab rather than the hash that
   * satisfies the strip, because a hash names a file and a workspace is eight
   * tracks with their colours, a set of marks and forty bookmarks. The id
   * travels *beside* the config rather than inside it, since a config is
   * deliberately portable and folding a tab identity in would put one into every
   * exported session and every share link (`state/workspace.ts`).
   *
   * Debounced downstream, in `writeWorkspace`: this is called on every state
   * change, which includes every frame of a colour-slider drag.
   */
  private rememberDurably(): void {
    const sessions: WorkspaceSession[] = []
    for (const session of this.sessions) {
      const config = session.exportConfig()
      if (config === null) continue
      sessions.push({ id: session.id, config })
    }
    // The rule, and why an empty window is not always a reason to forget, is in
    // `recordAction` — it is subtle enough to be worth a pure function and a
    // test rather than three conditions here.
    const action = recordAction({
      settled: this.durableSettled,
      offering: this.offering,
      tabs: sessions.length,
    })
    if (action === 'wait') return
    // A window emptied down to the picker is a reader who closed everything, and
    // offering it back next week would be offering them nothing.
    if (action === 'forget') {
      void forgetWorkspace()
      return
    }
    writeWorkspace({
      version: WORKSPACE_VERSION,
      savedAt: new Date().toISOString(),
      sessions,
      active: this.current?.id ?? null,
    })
  }

  // -------------------------------------------------------------------------
  // SessionHost
  // -------------------------------------------------------------------------

  sessionChanged(session: Session): void {
    this.paintTabs()
    // The durable record follows the *workspace*, not only the view state.
    // Loading a track, placing a mark and saving a bookmark all arrive here and
    // none of them navigates, so without this the record would describe the
    // session as it stood at the last navigation — which for a reader who spent
    // ten minutes arranging tracks is everything they did. Debounced downstream,
    // and cheap: it reads session memory rather than the live objects.
    this.rememberDurably()
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
            // The landing picker's own door, not `open`: the example list is
            // the same list, and every entry on it is a published *session*.
            void session.openPicked(uri, source)
          },
          onOpenFiles: (files) => {
            modal.close()
            void session.openFiles(files)
          },
          examples: demoExamples(),
        }).el,
      onClose: () => {
        this.modal = null
      },
    })
    this.modal = modal
  }

  /**
   * Write the active tab out as a file.
   *
   * Everything about it that is not the bytes of its data: the view, the window,
   * the colour scale, every track with its own settings, the groups, the ticked
   * sequences, the hand-placed marks. Dropping it back on the page brings the
   * session up again — asking for the file itself, when that file is a local one
   * no page can re-open by name.
   */
  private exportSession(): void {
    const session = this.current
    const config = session?.exportConfig() ?? null
    if (session === undefined || config === null) {
      this.warn('There is nothing open in this tab to save.')
      return
    }
    const now = new Date()
    const name = configFileName(exportBaseName(fileLabel(config.state.uri)), fileStamp(now))
    downloadBlob(
      new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
      name,
    )
  }

  /**
   * The whole session as a link, and the offer to shorten it.
   *
   * The same object {@link exportSession} writes to a file — the link and the
   * file are two encodings of one thing, which is what keeps them from drifting
   * (`state/shareLink.ts`).
   */
  private openShareDialog(): void {
    const config = this.current?.exportConfig() ?? null
    if (config === null) {
      this.warn('There is nothing open in this tab to share.')
      return
    }
    this.modal?.close()
    this.modal = openShareDialog({
      config,
      base: `${window.location.origin}${window.location.pathname}${window.location.search}`,
    })
  }

  /**
   * Open a session that arrived in the fragment.
   *
   * Called before anything is mounted and again on every hash change, because a
   * shared link is as likely to be pasted into the address bar of a running app
   * as it is to be opened cold.
   *
   * The hash is **replaced** once the session is open, and that is deliberate
   * rather than tidying: leaving a two-kilobyte payload in the bar means every
   * subsequent navigation writes the view state *over* it, so the link the
   * reader still has in their history is a session and the one in the bar is a
   * view — two things that look alike and are not. Replacing it with the
   * ordinary view state makes the address bar mean one thing again.
   *
   * @returns `true` when a session was found and opened.
   */
  private async openSharedHash(): Promise<boolean> {
    const payload = readShareHash(window.location.hash)
    if (payload === null) return false
    const config = await decodeShare(payload)
    if (config === null) {
      this.warn('That shared link could not be read. It may have been cut short in transit.')
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return false
    }
    this.writingHash = true
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    this.writingHash = false
    await this.current?.openConfig(config)
    return true
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
    // Asked before the view state, because the two live in the same fragment
    // and a shared session is not a view: `parseViewState` would read `s=…` as
    // an unknown key, ignore it, and navigate to the default view of nothing.
    if (readShareHash(window.location.hash) !== null) {
      void this.openSharedHash()
      return
    }
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
        keys: KEYS.palette,
        run: () => this.openPalette(),
      },
      {
        id: 'open-file',
        group: 'File',
        title: 'Open a different file',
        hint: 'Empty this tab and go back to the drop area.',
        run: () => session?.toPicker(),
      },
      {
        id: 'new-session',
        group: 'File',
        title: 'New session',
        hint: 'Another tab, with its own file, tracks and settings.',
        // `o`, not ⌘T: every browser claims ⌘T for a tab of its own and never
        // lets the page see it, so the binding was one a reader could read in
        // this dialog and never once perform.
        keys: KEYS.newSession,
        enabled: this.sessions.length < MAX_SESSIONS,
        run: () => this.newSession(),
      },
      {
        id: 'save-session',
        group: 'File',
        title: 'Save this session',
        hint:
          'Everything about this tab as a file: the view, every track and its settings, the ' +
          'groups, the marks. Drop it back on the page to open it again.',
        keys: KEYS.saveSession,
        enabled: file,
        run: () => this.exportSession(),
      },
      {
        id: 'close-session',
        group: 'File',
        title: 'Close this session',
        hint:
          this.sessions.length === 1
            ? 'The last tab is emptied rather than closed — there would be nothing to drop a file on.'
            : undefined,
        keys: KEYS.closeSession,
        run: () => this.closeSession(this.active),
      },
      {
        id: 'next-session',
        group: 'Go',
        title: 'Next session',
        keys: KEYS.nextSession,
        enabled: this.sessions.length > 1,
        run: () => this.activate((this.active + 1) % this.sessions.length),
      },
      {
        id: 'prev-session',
        group: 'Go',
        title: 'Previous session',
        keys: KEYS.prevSession,
        enabled: this.sessions.length > 1,
        run: () =>
          this.activate((this.active - 1 + this.sessions.length) % this.sessions.length),
      },
      ...(session?.commands() ?? []),
    ]

    // The bindings come from `plotOptions.ts`, beside the labels and the marks,
    // because the two Tracks cards print them in their tooltips: a list of pairs
    // here and a lookup there is the same table written twice, and the copy
    // that goes stale is the one nothing tests.
    for (const key of Object.keys(PLOT_OPTION_KEYS) as Array<keyof typeof PLOT_OPTION_LABELS>) {
      list.push({
        id: `overlay-${key}`,
        group: 'View',
        title: `${overlays[key] ? 'Hide' : 'Show'} ${PLOT_OPTION_LABELS[key].label}`,
        hint: PLOT_OPTION_LABELS[key].hint,
        keys: PLOT_OPTION_KEYS[key],
        run: () => void togglePlotOption(key),
      })
    }

    list.push(
      {
        id: 'refine-on-zoom',
        group: 'View',
        title: refineEnabled()
          ? 'Stop reading finer data as you zoom'
          : 'Read finer data as you zoom',
        hint:
          'On, zooming past what the block in hand can show reads the window again at a finer ' +
          'grid — one bounded read, the map held still while it happens, and never below the ' +
          'file’s own bins. Off is the default and the older behaviour: one read per view, and a ' +
          'zoom that magnifies it. The same switch is the first button on a map’s picture row.',
        run: () => void toggleRefine(),
      },
      {
        id: 'fold-sidebar',
        group: 'View',
        title: 'Fold or show the General panel',
        keys: GENERAL_PANEL.keys,
        enabled: file,
        run: () => this.generalPanel.toggle.click(),
      },
      {
        id: 'fold-annotations',
        group: 'View',
        title: 'Fold or show the Annotations panel',
        hint: 'A metacool carries no annotations (§8.5), so it has no panel to fold.',
        keys: ANNOTATION_PANEL.keys,
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
        keys: AESTHETICS_PANEL.keys,
        enabled: file,
        run: () => this.aestheticsPanel.toggle.click(),
      },
      {
        id: 'fold-analysis',
        group: 'View',
        title: 'Fold or show the Analysis panel',
        hint: 'What can be computed from this file, as against what is drawn on it.',
        keys: ANALYSIS_PANEL.keys,
        enabled: file,
        run: () => this.analysisPanel.toggle.click(),
      },
      {
        id: 'theme',
        group: 'View',
        title: 'Cycle the theme: system, light, dark',
        keys: KEYS.theme,
        run: () => this.theme.el.click(),
      },
      {
        id: 'shortcuts',
        // `App`, not `Help`. The shortcuts dialog lists one section per group of
        // *bound* commands, and this was the only bound command in Help — so
        // that group existed to hold a single row, which then decided where the
        // two gesture tables below it landed. It belongs beside the palette in
        // any case: both are ways of asking the app what it can do.
        group: 'App',
        title: 'Keyboard shortcuts',
        keys: KEYS.shortcuts,
        run: () => this.openShortcutsDialog(),
      },
      {
        id: 'share',
        group: 'File',
        title: 'Share this session as a link',
        run: () => this.openShareDialog(),
        enabled: this.current?.exportConfig() !== null,
      },
      {
        id: 'stored-data',
        group: 'Help',
        title: 'What this browser is remembering',
        hint:
          'Everything kept on this computer — which files were open, how they were set up, and ' +
          'any bucket keys — with a button that clears all of it. No file contents are ever ' +
          'among it.',
        run: () => void this.openStoredDataDialog(),
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
      // ⌘C is the browser's before it is ours whenever there is text under it.
      if (command.yieldsToText === true && wantsTextCopy(event.target)) continue

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

  /**
   * Account for everything this browser is keeping, and offer to end it.
   *
   * The list is gathered here rather than in the dialog because the stores are
   * spread across three layers and `ui/RestoreCard.ts` has no business knowing
   * about any of them. What this owes the reader is that the account is
   * *complete*: a control that clears the durable workspace while thirteen
   * `localStorage` keys stay put — one of them holding an S3 secret in
   * cleartext — would be a worse lie than having no control at all.
   */
  private async openStoredDataDialog(): Promise<void> {
    if (this.modal !== null) return
    // Gathered before the dialog opens rather than filled in after it: the
    // account is the whole content, and a panel that appears empty and then
    // grows a list reads as though the first answer was "nothing".
    const items = await storedItems()
    if (this.modal !== null) return
    this.modal = openStoredData({
      items,
      onForgetAll: () => void forgetEverything(),
      onClose: () => {
        this.modal = null
      },
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
