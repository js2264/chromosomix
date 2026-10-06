/**
 * The window: header, tab strip, five columns, status bar, address bar.
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
import type { SourceSpec } from '../worker/protocol'
import { openCommandPalette } from '../ui/CommandPalette'
import { LoadBox } from '../ui/LoadBox'
import { CONNECT_FOLDER_TITLE, CONNECT_PLACES, type ProviderId } from '../ui/connectFronts'
import { Modal } from '../ui/Modal'
import { StoreDrawer } from '../ui/StoreDrawer'
import { registerShelf } from '../ui/examples'
import type { StoreEntry } from '../state/store'
import { splitUri } from '../ui/labels'
import {
  AESTHETICS_PANEL,
  ANALYSIS_PANEL,
  ANNOTATION_PANEL,
  FILES_PANEL,
  GENERAL_PANEL,
  SidePanel,
  type PanelLayout,
  type SidePanelSpec,
} from '../ui/SidePanel'
import { CardArranger } from '../ui/cardLayout'
import { FilesCard } from '../ui/FilesCard'
import { dragHasFileRow, readFileDrag } from '../ui/fileDrag'
import { connectedFolders, hydrateFolders, subscribeFolders } from '../browse/connected'
import type { PickedFile } from '../browse/folder'
import '../browse/backends'
import { StatusBar } from '../ui/StatusBar'
import { ConsolePanel } from '../ui/ConsolePanel'
import { ThemeToggle } from '../ui/ThemeToggle'
import { desktop } from '../desktop'
import {
  KEYS,
  isChord,
  isTypingTarget,
  keyLabel,
  matchesKeys,
  wantsSpace,
  wantsTextCopy,
  withKey,
  type Command,
} from '../ui/commands'
import { learnKey, readLayout } from '../ui/keyboardLayout'
import { openAbout, openShortcuts } from '../ui/dialogs'
import { button, dragHasFiles, el } from '../ui/dom'
import { filesFrom } from '../ui/chooseFiles'
import { icon, iconButton } from '../ui/icons'
import { downloadBlob, fileStamp } from '../ui/export'
import {
  applyConfig,
  isRefusal,
  refusalMessage,
  resolveConfig,
  type SessionConfig,
} from '../state/SessionConfig'
import { fileMemoryKey } from '../state/UiMemory'
import {
  WORKSPACE_VERSION,
  buildWorkspaceFile,
  flushWorkspace,
  parseWorkspaceFile,
  seatWorkspace,
  workspaceFileName,
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
import { noticeBanner, openStoredData, restoreBanner } from '../ui/RestoreCard'
import { decodeShare, readShareHash } from '../state/shareLink'
import { openShareDialog } from '../ui/ShareDialog'
import { appMark } from '../ui/mark'
import {
  PLOT_OPTION_KEYS,
  PLOT_OPTION_LABELS,
  getPlotOptions,
  setPlotOptions,
  togglePlotOption,
} from '../ui/plotOptions'
import { refineEnabled, toggleRefine } from '../ui/refine'
import { embedded, mounting } from '../embed'
import { IS_STANDALONE } from '../version'
import { Session, reserveSessionIds, type SessionHost } from './Session'
import { EmbedChannel, embedChannel } from './EmbedChannel'
import { TabStrip } from './TabStrip'
import { highestId, readSessions, writeSessions, type SessionSnapshot } from './sessions'

/** Where "source" points, from the about dialog and the header. */
const REPO_URL = 'https://github.com/js2264/metacooler.js'

/** The document title with nothing open; the file name is prefixed to it. */
const APP_TITLE = '(meta)cooler'

/**
 * What the header's `+` promises, read by its tooltip and by its command.
 *
 * It names what the file *becomes* rather than the gesture, because the gesture
 * is the one thing the mark already says. What a reader cannot guess from a file
 * with a plus on it is the half that matters: a second cooler comes up beside
 * this one rather than over it, which is the difference between this button and
 * every other door to a file in the app.
 */
const ADD_FILE_HINT =
  'A second map comes up beside the one open, and anything else is drawn on top.'

/**
 * What the header's plug promises, read by its tooltip and by its command.
 *
 * It names the four kinds in one clause, because that is the claim that makes
 * this one control rather than four: a directory, a bucket, a Drive folder and
 * a Dropbox are browsed identically, which is true of the code rather than a
 * slogan (`browse/folder.ts`). "Kept in the Files panel" carries the lasting
 * half — what a reader gets is not a file but a column they can keep working
 * out of — in the one line a hint is allowed (§26.4). The kinds are the build's
 * (`CONNECT_PLACES`): the standalone has the first and none of the others (§19).
 */
const CONNECT_HINT = `${CONNECT_PLACES}, kept in the Files panel.`

/**
 * How many sessions may be open at once.
 *
 * Not a rendering limit — the tab strip scrolls — but a memory one. Each session
 * that has opened something owns a worker, an h5wasm instance and, for a
 * whole-file view, a matrix held whole in memory (§2). Twelve is well past what
 * anyone opens deliberately and well short of what makes a laptop swap.
 */
const MAX_SESSIONS = 12

/**
 * A toggle command's state, in §26.7's words.
 *
 * Written once here because eleven overlay rows, five panel folds, the console,
 * the stores and refine-on-zoom all wear it, and a second spelling — `(on)`,
 * `shown`, `open` — would make one kind of thing look like four in one list.
 */
const chipOf = (on: boolean): 'on' | 'off' => (on ? 'on' : 'off')

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
   * Where a session's passing remarks go — see {@link notify}.
   *
   * Its own slot beside the restore offer rather than the same one, because the
   * two are answers to different questions and clobbering one with the other
   * would lose whichever arrived first.
   */
  private readonly noticeSlot = el('div', { class: 'notice-slot' })
  /**
   * The note in {@link noticeSlot}, and whose it is.
   *
   * A tab's note is about the file it has open, so it is shown while that tab
   * is the one in front and goes when the tab withdraws it — on moving to
   * another file, or to none, or closing. The window's own, about the window,
   * stays until it is dismissed.
   */
  private notice: { message: string; owner: Session | null } | null = null
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
   * The fifth, and the one that is not about the open file at all.
   *
   * Window furniture in a stronger sense than its four siblings: they hold the
   * *active session's* cards and are re-parented on every tab switch, and this
   * one holds the same folders whichever tab is in front, because a place you
   * connected is not a fact about a file. So it is built once, filled once, and
   * never told about a session — which is also why it is the one panel that
   * stays available with nothing open.
   */
  private readonly filesPanel: SidePanel
  private readonly files: FilesCard
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
  /**
   * The cards a reader has moved by their headings, within a column and across
   * them (`ui/cardLayout.ts`): put back after every rebuild of every column, and
   * remembered with the columns' widths.
   */
  private readonly cards: CardArranger
  private readonly tabs: TabStrip
  /**
   * The console (§23), or `null` in an embed.
   *
   * Window furniture in the strongest sense — it is a record of what *this
   * window* has done, across every tab, and it outlives all of them. So it is
   * built once here rather than by a session, on the same reasoning the Files
   * column is: a place you connected is not a fact about a file, and neither is
   * a command you ran an hour ago in a tab you have since closed.
   *
   * Not built at all in an embed, exactly as the status bar is not: what an
   * embed would be logging is the page author's own afternoon, its bar has no
   * room for the button, and a panel nobody can open is a keydown listener
   * taking Escape inside somebody else's page (§21.2).
   */
  private readonly consolePanel: ConsolePanel | null
  /**
   * The stores, as a drawer down the left (§24.2).
   *
   * Window-level like the console rather than per session like the Analysis
   * drawer, on the Files column's argument: a store is not a fact about the
   * file in front, and a catalogue somebody was half way through narrowing
   * should survive a switch of tab. `null` in an embed, which has no header to
   * open it from and no business fetching a catalogue into somebody's figure,
   * and in the single file, which has no network to read one over (§19).
   */
  private readonly storeDrawer: StoreDrawer | null
  private readonly theme: ThemeToggle
  /**
   * The footer, or `null` in an embed.
   *
   * Not built rather than built and hidden, and the difference is a timer: the
   * bar measures memory and CPU once a second for as long as the window is open
   * (`ui/StatusBar.ts`), which is a fair price for a readout somebody can see
   * and none at all for one mounted nowhere.
   */
  private readonly status: StatusBar | null
  /** At most one dialog at a time; it owns the keyboard while it is up. */
  private modal: Modal | null = null
  /** Set while this class is the one moving the hash, so it ignores the echo. */
  private writingHash = false
  /**
   * Whether this page was mounted as an embed (`?embed=1`, `src/embed.ts`).
   *
   * Read once into a field rather than asked for at each use. It decides what
   * the constructor appends, what every navigation does to the history, and
   * whether this window remembers itself — and a window that answered the
   * question differently in three of those places would be a bug nobody could
   * see from any one of them.
   */
  private readonly embed = embedded()
  /**
   * The host page's end of the conversation, or `null`.
   *
   * `null` for every top-level page, which is the ordinary case: the app is then
   * the whole window and the host it would be answering is the reader.
   */
  private readonly channel: EmbedChannel | null = null
  /**
   * The embed bar's brand, which is also the way out to the full viewer.
   *
   * Held so that {@link writeHash} can keep its `href` on the view the reader is
   * actually looking at. An anchor whose address is a navigation behind is worse
   * than one with no address at all: it is right often enough to be trusted and
   * wrong exactly when somebody copies it.
   */
  private readonly brandLink: HTMLAnchorElement | null = null
  /**
   * The header's link button, held so that {@link syncShare} can withdraw it.
   *
   * There is nothing to put in a link until something is open, and §8.5's rule
   * is that such a control is unavailable rather than live-and-refusing: it is
   * disabled with the reason in its tooltip, exactly as the palette's own
   * *Share* row has been all along.
   */
  private readonly shareButton: HTMLButtonElement = iconButton(
    'link',
    'Share this tab as a link',
    () => this.openShareDialog(),
  )

  constructor(root: HTMLElement) {
    this.breadcrumbSlot = el('div', { class: 'breadcrumb-slot' })
    this.content = el('main', { class: 'content' })
    this.drawerSlot = el('div', { class: 'drawer-slot' })
    // Folding or dragging a column changes how much room the plot has and where
    // its centre is. A `ResizeObserver` inside the view cannot see all of that:
    // the plot is usually sized by the window's *height*, so widening its column
    // changes no box the observer watches while still moving where the plot
    // should sit. Telling the mounted view directly is the reliable half.
    const relayout = (): void => {
      this.current?.relayout()
      this.storeDrawer?.relayout()
    }
    // The shape of the columns is part of a saved workspace, so a fold or a
    // finished drag is worth recording — and only *finished*, because
    // `rememberDurably` gathers a config per tab out of session storage and
    // doing that on every pixel of a drag would put storage between the hand and
    // the repaint. Debounced downstream like every other write of the record.
    const settled = (): void => this.rememberDurably()
    // The fourth argument is *whether this window's columns are the reader's*.
    // In an embed they are not, in both directions: a column must not open
    // inside somebody's figure because the reader once left it open on the app's
    // own site, and a reader who opens one *in* a figure must not find the app
    // rearranged next time they go to it. So an embed's columns start folded and
    // leave no trace (`ui/SidePanel.ts`).
    const remembers = !this.embed
    this.generalPanel = new SidePanel(GENERAL_PANEL, relayout, settled, remembers)
    this.annotationsPanel = new SidePanel(ANNOTATION_PANEL, relayout, settled, remembers)
    this.aestheticsPanel = new SidePanel(AESTHETICS_PANEL, relayout, settled, remembers)
    this.analysisPanel = new SidePanel(ANALYSIS_PANEL, relayout, settled, remembers)
    this.filesPanel = new SidePanel(FILES_PANEL, relayout, settled, remembers)
    this.files = new FilesCard({
      // The panel's arrow means what the header's `+` means, so it goes to the
      // same place: a second map beside the one that is open, anything else on
      // top, an empty tab filled rather than added to. A tab has to exist for
      // that, and on the landing page one always does.
      onLoad: (picked) => void this.current?.addPicked(picked),
      // A session of its own: the empty tab in front, or a new one — the
      // same choice a store row makes ({@link openStoreEntry}), and through
      // `addPicked` so that an empty tab is *filled* by the same road a
      // dropped file takes, index and name included.
      onOpenNew: (picked) => {
        const session = this.tabEmpty() ? this.current : this.newSession()
        void session?.addPicked(picked)
      },
      tabEmpty: () => this.tabEmpty(),
      onConnect: () => this.openConnectDialog(),
    })
    this.filesPanel.setContent([this.files.el])
    this.refreshFilesPanel()
    this.cards = new CardArranger({
      columns: () => this.columns().map(([, column]) => column),
      remembers,
      // A column the reader has carried a card into stays on screen for it,
      // even on a view that gives that column nothing of its own.
      onChange: () => {
        const session = this.current
        if (session !== undefined) this.applyPanels(session)
      },
    })
    // The list this column is of can change from four other screens, and two of
    // them — the landing page's *choose a folder…* and the Connect dialog — are
    // how it comes into existence in the first place.
    subscribeFolders(() => this.refreshFilesPanel())

    this.status = this.embed
      ? null
      : new StatusBar({ client: () => this.current?.client ?? null })
    this.consolePanel = this.embed
      ? null
      : new ConsolePanel({
          // A third of the window's height is a change the mounted view has to
          // be told about, for the reason the columns are: a plot sized by the
          // window's height moves and no box a `ResizeObserver` watches does.
          onLayout: relayout,
        })
    // Built in neither of the two mounts that have no use for it. An embed has
    // no header to put its button in (§21.2). The single file has no network
    // (§19), and a store is a list of addresses: every catalogue but the lab's
    // is a fetch that fails before a byte moves, and every figure on the lab's
    // is a file on a bucket. A drawer there is the URL box that build leaves
    // out, one door over — so it is absent rather than offered, and so is
    // everything that opens it: the header's button, the key, the palette's
    // row and a `?store=` link.
    this.storeDrawer = this.embed || IS_STANDALONE
      ? null
      : new StoreDrawer({
          host: {
            // Opening folds the drawer away, because the reader chose what
            // they came for and it is about to appear behind it; adding keeps
            // it up, because a reader adding one track is likely adding three.
            open: (entry) => {
              this.openStoreEntry(entry)
              this.storeDrawer?.close()
            },
            openWithTracks: (entry) => {
              this.openStoreEntry(entry, { tracks: true })
              this.storeDrawer?.close()
            },
            add: (entry) => this.addStoreEntry(entry),
            openTogether: (entries) => {
              void this.openStoreEntries(entries)
              this.storeDrawer?.close()
            },
            tabEmpty: () => this.tabEmpty(),
          },
          onLayout: relayout,
        })
    this.theme = new ThemeToggle()
    this.tabs = new TabStrip({
      onSelect: (index) => this.activate(index),
      onClose: (index) => this.closeSession(index),
      onNew: () => this.newSession(),
      onRename: (index, name) => this.renameSession(index, name),
    })

    // The title is the way home. It reads as one, so it should behave as one:
    // clicking it goes to the file picker, which is the only view above every
    // other (§5.1).
    //
    // **In a new tab, whenever this one holds something.** It used to call
    // `toPicker()`, which empties the tab in front — the file let go of, the
    // annotation worker stopped, the deck and the comparison destroyed — and
    // that is the one thing the way home must not do: every web page has
    // taught a reader that the logo is safe to press, and a dropped local
    // file cannot be re-opened without another gesture (§11). The file crumb
    // stopped navigating to the picker for exactly this reason, and two doors
    // one row apart with opposite safety is the kind of thing a reader learns
    // by losing an afternoon's tracks. An empty tab *is* the picker, so the
    // new tab is the whole answer; a tab that is already empty has nothing to
    // lose and goes straight there.
    const home = button('(meta)cooler', () => this.goHome(), {
      class: 'brand-name brand-home',
      title: 'The file picker — in a new tab, so this one is kept',
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

    const head = el(
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
        // …and the ways files get into this tab, not before. They are
        // controls over the window's own furniture, and a row that opened
        // with unlabelled marks made a reader identify them before reaching
        // the thing that says what they are looking at. The strapline that
        // used to hold this side of the header is gone with them: it
        // explained the app to somebody who has already opened it.
        el(
          'div',
          { class: 'head-files' },
          // The stores first — somebody else's shelf, in a drawer, and the
          // door most readers arrive through — then the Files column, the
          // reader's own places. Nothing else: the two buttons that stood
          // here, a plug that connected a place and a `+` that added a file,
          // were the Files column's own *connect a local or remote folder* and the
          // file crumb's *Open a file* said a second time, one row up, and a
          // header with three doors to a file reads as three different
          // things. Dropping is still the gesture the app is opened with and
          // the whole content area still takes it (see {@link addFileDialog}
          // for why a drop *adds* rather than replaces), and both verbs stay
          // in the palette.
          ...(this.storeDrawer === null ? [] : [this.storeDrawer.toggle]),
          this.filesPanel.toggle,
        ),
        // Past a divider, because these four are not about getting a file in —
        // they are controls over the picture of one that is already open.
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
        // Share one tab as a link, save the whole window as a file, theme,
        // shortcuts, source, about. The two leftmost are a deliberate pair and
        // say different things: a link is *what is being looked at* (§5.5) and
        // there is one of those on screen, while a file is the window.
        //
        // Nothing here *opens* a file, and the doors that do are elsewhere:
        // the file crumb's *Open a file* adds one to this tab, and the brand —
        // whose hover says so — goes back to the picker and replaces. That is
        // the same add-versus-replace line this side draws between a dropped
        // workspace and the startup offer.
        // Held, because it is the one header button whose promise depends on
        // the tab: with nothing open there is no view to put in a link, and an
        // always-live button that answers with a refusal dialog is §8.5's own
        // failure — the palette's copy of this command has been gated on the
        // same test all along.
        this.shareButton,
        iconButton(
          'save',
          withKey('Save every tab as a file, to open again later', KEYS.saveSession),
          () => this.exportWorkspace(),
        ),
        // Before the theme, and after the two that take something *out* of this
        // window: a link and a file are what a reader hands to somebody else,
        // and this is the third of them — the commands that repeat the day.
        // Everything to its right is about the window rather than the work in
        // it, which is the line this button sits on.
        ...(this.consolePanel === null ? [] : [this.consolePanel.toggle]),
        this.theme.el,
        iconButton('keyboard', withKey('Keyboard shortcuts', KEYS.shortcuts), () =>
          this.openShortcutsDialog(),
        ),
        source,
        iconButton('info', 'About this viewer', () => this.openAboutDialog()),
      ),
    )

    // **Two of the five columns in an embed**, and the line between them is what
    // they are *about*: Annotations and Aesthetics are controls over the picture
    // on screen — which lanes are drawn, how they are coloured, scaled and
    // clipped — and a reader looking at somebody's figure has every reason to
    // want them. The other three are about the window and the work around it:
    // Files is the places this window has been connected to, General is a
    // reference card about the file, and Analysis starts jobs and writes
    // results. One on each side, as they are in a window: Annotations at
    // `order: -1`, Aesthetics at `order: 1`.
    //
    // They arrive **folded**, whatever anything else says, and stand as their own
    // named spines until the reader asks (`SidePanel.spine`). A column is open
    // unless it has been folded — a fresh browser has nothing stored, and a
    // session may carry a layout of its own — so the first real embed of a
    // published figure came up in a 1,200-pixel frame behind five open columns,
    // with thirty-two pixels of map between them. An embed is a picture first;
    // the controls over it are one click away on either edge, and the bar above
    // carries the same two toggles for folding them again.
    //
    // Each column carries its own `order`, so the DOM order here is free — and
    // it is content-first, which is what the tab order should be. The drawer is
    // last, so it paints over whatever is beside it without needing a stacking
    // context of its own beyond the one its `z-index` gives it.
    const body = el(
      'div',
      { class: 'app-body' },
      this.content,
      ...(this.embed
        ? [this.annotationsPanel.el, this.aestheticsPanel.el]
        : [
            this.filesPanel.el,
            this.generalPanel.el,
            this.annotationsPanel.el,
            this.aestheticsPanel.el,
            this.analysisPanel.el,
          ]),
      this.drawerSlot,
      // The stores, down the left, over the Files column: the same kind of
      // surface as the Analysis drawer on the right, and it stops at the
      // console's roof for the same reason.
      ...(this.storeDrawer === null ? [] : [this.storeDrawer.el]),
      // Under everything, across the whole body: the drawer is beside the map
      // and this is below it, so the two can be up at once — the drawer stops at
      // the console's roof rather than running under it (§23, and the
      // `--console-height` rule in the stylesheet).
      ...(this.consolePanel === null ? [] : [this.consolePanel.el]),
    )

    // **The one row an embed has**, and it is the breadcrumb row with three
    // things added rather than a header made smaller. What is on it is what a
    // figure in somebody else's page owes its reader: whose viewer this is, what
    // file they are looking at and where in it, the two controls over the
    // picture, and the way to find out what any of it means.
    //
    // The brand is a **link out** rather than the way home. In a window it is a
    // button back to the picker, which is right there and catastrophic here — it
    // would throw away the figure the page named, in a frame with no back
    // button to return by (`writeHash`). So it opens this same view in the full
    // viewer, in a new tab, with `embed` dropped from the address: the reader
    // gets the whole application, the page keeps its figure, and the href is
    // rewritten on every navigation so copying the link copies where they
    // actually are.
    const brand = this.embed
      ? el(
          'a',
          {
            class: 'embed-brand',
            href: this.fullViewerUrl(),
            title: 'Open this view in the full viewer, in a new tab',
            attrs: { target: '_blank', rel: 'noopener noreferrer' },
          },
          appMark(20),
          el('span', { class: 'embed-brand-name', text: APP_TITLE }),
        )
      : null
    this.brandLink = brand

    // Right of the bar, and the toggles are the *same objects* the header holds
    // in a window — a panel owns its button, so there is one fold path and not a
    // second one written for frames. Each hides itself when its column has
    // nothing to show (`SidePanel.paint`), which is what lets this group be
    // built once and never told about a session.
    const bar = this.embed
      ? el(
          'div',
          { class: 'embed-bar' },
          brand as HTMLElement,
          this.breadcrumbSlot,
          el(
            'div',
            { class: 'embed-tools' },
            this.annotationsPanel.toggle,
            this.aestheticsPanel.toggle,
            // The same dialog the window's header opens, and it is the answer to
            // every question this bar raises: what this viewer is, that nothing
            // is uploaded, which build is in the frame, and where the source is.
            iconButton('info', 'About this viewer', () => this.openAboutDialog()),
          ),
        )
      : null

    // **The whole of what an embed does to the DOM**, and it is a subtraction
    // with one row added back: everything that is mounted — the view, the
    // drawer, the content area and its drop handling — is built exactly as it is
    // for a top-level page. That is what keeps `Session` ignorant of any of
    // this: it parents its cards into the same panels and mounts into the same
    // slot whether or not anybody can see them, so there is no second layout to
    // keep in step. The header and the three unmounted columns are built and
    // left where they are, since furniture nobody appends costs its nodes once;
    // the status bar is the one thing not built at all, because what it costs is
    // a timer rather than nodes.
    //
    // What goes, and why: the **header** is controls over a window (tabs,
    // panels, theme, share, save) and its useful half is on the bar above; the
    // **tab strip** offers tabs an embed does not keep; the **restore slot**
    // offers the reader's own previous workspace, which inside somebody's
    // article would be six of their files on a page that never asked for them
    // (§11); and the **status bar** is a byte counter under a figure. The notice
    // slot stays: it is where a session's remarks and refusals land, and an
    // embed that swallowed those would fail silently for the one reader who
    // could report it.
    root.append(
      ...(bar === null
        ? [head, this.tabs.el, this.restoreSlot, this.noticeSlot, this.breadcrumbSlot]
        : [bar, this.noticeSlot]),
      body,
      ...(this.status === null ? [] : [this.status.el]),
    )

    window.addEventListener('keydown', (event) => this.onKeyDown(event))
    // What the keyboard puts where, for the keys bound by their place on it
    // (`ui/keyboardLayout.ts`): asked of the browser once, where it will say,
    // and read off every keystroke from here on.
    void readLayout()
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
      // Files only — from the operating system, or out of the Files panel, which
      // are the same gesture with the bytes in a different place. A track row
      // dragged out of the Tracks card is also a drag across this area — it is
      // on its way to the map's edge rectangles — and outlining the whole
      // content area for it would say the content area is where it goes.
      if (!dragHasFiles(event) && !dragHasFileRow(event)) return
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
      // A row out of the Files panel, which carries a name rather than bytes.
      // Read before `filesFrom`, because it is the only branch that can be told
      // apart cheaply and a drag is never both.
      if (dragHasFileRow(event)) {
        event.preventDefault()
        void readFileDrag(event).then((picked) => {
          if (picked !== null) void this.current?.addPicked(picked)
        })
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
    // The same arrangement, for the same reason, one level up: reading the
    // connected directories in is what lets the Files panel open on the folder
    // a previous visit left, and a database that is slow must not hold up the
    // picker. Unlike the file grants, this one has something to do when it
    // lands — the panel is already on screen, empty — so it is chained rather
    // than dropped.
    void hydrateFolders().then(() => {
      // Nothing announces a hydration — it is the store being read rather than
      // written — so the column is told here that it may now have something to
      // be, before it is asked to open on it.
      this.refreshFilesPanel()
      this.files.showFirst()
    })

    // Built before the tabs are seated so that a view state settling during the
    // boot has somewhere to be reported to, and **started after**, because
    // `start` announces this window as ready to be addressed and the first thing
    // a host does with that is ask where the view is. Announcing from an empty
    // window would answer that question wrongly once, at the only moment a host
    // is certain to be listening.
    //
    // Only in an embed. A top-level page has a reader rather than a host, and a
    // frame that was not asked to be one has nothing to say to whoever framed
    // it — see `app/EmbedChannel.ts` on why the channel is opt-in at all.
    if (this.embed) {
      this.channel = embedChannel({
        state: () => this.current?.state ?? null,
        navigate: (state) => this.goTo(state),
      })
    }

    this.restore()
    this.channel?.start()
  }

  /**
   * The Connect dialog, imported on demand.
   *
   * A dynamic import for `ui/FilePicker.ts`'s reason and with the same
   * honesty about what it buys: the dialog pulls in the bucket form and the
   * two sign-in panes, which a session opening a public demo never touches. It
   * does not keep the *browsing* out of the entry chunk and was never going to
   * — the Files panel is built with the shell and holds the folder view, and
   * the directory pickers are reached from the landing page without this
   * dialog at all — so the split is worth having for the form and the panes,
   * and nothing more is claimed for it.
   *
   * `provider` is which pane to land on, and it is what the landing page's
   * *mount a folder* buttons carry: a reader who pressed *sign in to Dropbox*
   * on a page with four buttons on it has already chosen, and a dialog that
   * opened on this machine would ask them to choose again. Absent from the
   * header's plug and the palette, which name no place, so those still open on
   * the one that needs no account (`ui/connectFronts.ts`).
   */
  private openConnectDialog(provider?: ProviderId): void {
    if (this.modal !== null) return
    void import('../ui/ConnectCard').then(({ openConnect }) => {
      const modal = openConnect({
        ...(provider === undefined ? {} : { provider }),
        onConnected: (id) => this.folderConnected(id),
        onClose: () => {
          this.modal = null
        },
      })
      this.modal = modal
    })
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
   *
   * ## What decides what an embed shows
   *
   * The same list with its last entry removed, which is the whole of the
   * difference: a shared session in the fragment, then a view state in it, then
   * `?config=`, and the picker when none of the three says anything. **Nothing
   * remembered**, because an embed does not remember (see {@link remember}) —
   * so a frame reloaded a month later shows what the page's `src` says, every
   * time, rather than the corner of the figure somebody last dragged it to.
   */
  private restore(): void {
    // A shared link is not a view state and must not be read as one. It is
    // opened *after* the tabs are restored and mounted, because opening a
    // session needs a session to open it into — so the boot proceeds as though
    // the fragment were empty, and the link lands in the active tab a moment
    // later.
    const shared = readShareHash(window.location.hash) !== null
    const linked = shared ? null : parseViewState(window.location.hash)
    const stored = this.embed ? { sessions: [], active: null } : readSessions()
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
    // The three seeds, in the order they override one another, and each one is
    // only reached because the ones above it said nothing. A **payload** in the
    // fragment is the most specific thing anybody can hand this window; a *view
    // state* in it is what a navigation leaves behind, so it has to beat the
    // `src=` the page was mounted with or a reload would undo the reader's last
    // click; and `?config=` is the seed the page itself named, which is exactly
    // what a window with nothing else to go on should open.
    if (shared) void this.openSharedHash()
    else if (linked === null && this.sessions.every((session) => session.state === null)) {
      const seed = mounting().config
      if (seed !== null) void this.current?.openConfigUrl(seed)
    }
    this.current?.activate()
    // `?store=` is not a seed and competes with none of them: it names a
    // **shelf** rather than a picture (§24.2), and the shelf is a drawer over
    // whatever the window shows, so a link naming both a config and a store
    // gets both — the figure in the tab and the catalogue beside it. A link is
    // a gesture, which is what licenses the fetch: nothing here runs unless
    // somebody clicked a URL naming this store. A window with no drawer — an
    // embed, the single file — has nothing for the link to open, and fetches
    // nothing for it either.
    const shelf = mounting().store
    if (shelf !== null) this.storeDrawer?.openLink(shelf, mounting().storeView)
    // Only when session storage had nothing, which is exactly "the browser was
    // closed" — a reload has its own, fresher answer above and must not be
    // asked a question it already knows. Last, and asynchronous, so a database
    // that is slow or refuses to open delays nothing on the boot path.
    //
    // A reload settles immediately: there is no question to ask, so the record
    // may be written from this moment. The other branch settles when the read
    // comes back, which is what keeps an empty startup window from deleting the
    // workspace it is about to be offered.
    //
    // An embed asks nothing and settles at once: it has no record to offer back
    // and writes none, so both halves are answered before the question.
    if (this.embed || stored.sessions.length > 0) this.durableSettled = true
    else void this.offerWorkspace()
  }

  /** A tile on a landing page was pressed: open the drawer on that store. */
  openStore(id: string): void {
    this.storeDrawer?.open(id)
  }

  /** A place on a landing page was pressed: open the Connect dialog on it. */
  openConnect(provider: ProviderId): void {
    this.openConnectDialog(provider)
  }

  /**
   * A folder was connected — by the dialog, or by the landing page's own
   * *choose a folder…* — so show it.
   *
   * Straight into the folder that was just connected, which is the only thing
   * a reader who has connected one wants next, and the column is opened for
   * them because a column they cannot see is not an answer. The two doors call
   * this rather than each deciding what happens next: whatever a connected
   * folder is worth on screen, it is worth the same from both.
   */
  folderConnected(id: string): void {
    this.filesPanel.reveal()
    this.files.showConnected(id)
  }

  /** Whether the tab in front holds nothing — which decides what a store row's verbs say. */
  private tabEmpty(): boolean {
    const session = this.current
    return session === undefined || (!session.hasFile && !session.isBrowsing)
  }

  /**
   * The store row's *open*: fill an empty tab, or open a new one.
   *
   * Never the tab in front when it holds something — `ui/stores/host.ts` says
   * why a row never destroys a tab. A workspace row goes through the config
   * road whatever the tab holds, because `openWorkspaceFile` already appends
   * its tabs beside what is open and consumes only an empty one.
   */
  private openStoreEntry(entry: StoreEntry, options: { tracks?: boolean } = {}): void {
    this.noteShelf(entry, options.tracks === true)
    const source = { kind: 'remote', url: splitUri(entry.uri).path } as const
    if (entry.kind === 'workspace') {
      void this.current?.openPicked(entry.uri, source)
      return
    }
    const session = this.tabEmpty() ? this.current : this.newSession()
    if (session === undefined || session === null) return
    void this.openNamed(session, entry)
  }

  /**
   * A store row as a `PickedFile`: the file, and the name the store gave it.
   *
   * The name is the whole point (§24.2). A 4DN file is called by its accession
   * on the bucket — `4DNFI24F7GRY.mcool` — and by *Hi-C on HFF cells, protocol
   * variations* on the shelf, and the second is what a reader picked it by. So
   * the row's line goes with the file: onto the map it becomes, onto the track
   * it becomes, and onto the tab it opens, through the same road a file named
   * by a Drive folder takes.
   */
  private pickedFrom(entry: StoreEntry): PickedFile {
    return {
      uri: entry.uri,
      source: { kind: 'remote', url: splitUri(entry.uri).path },
      name: entry.label,
    }
  }

  /** Open a store row into an empty session, and call the tab what the store called the row. */
  private async openNamed(session: Session, entry: StoreEntry): Promise<void> {
    await session.addPicked(this.pickedFrom(entry))
    if (this.sessions.includes(session) && session.name === null) session.rename(entry.label)
  }

  /** The store row's *add*: the routing a dropped file takes, into the tab in front. */
  private addStoreEntry(entry: StoreEntry): void {
    this.noteShelf(entry)
    void this.current?.addPicked(this.pickedFrom(entry))
  }

  /**
   * Several store rows as one picture: the lead opens, the rest join it.
   *
   * The first map is the lead; with no map, the first row is, which opens a
   * genome browser the rest become tracks on. `Session.openFiles` makes the same
   * choice for a handful of dropped local files. The lead is awaited before the
   * rest are added, because a track joins the tab that is *open*, and a
   * collection at its root redirects to an entry on the way.
   */
  private async openStoreEntries(entries: readonly StoreEntry[]): Promise<void> {
    const files = entries.filter((entry) => entry.kind !== 'workspace')
    if (files.length === 0) {
      for (const entry of entries) this.openStoreEntry(entry)
      return
    }
    const lead = files.find((entry) => entry.kind === 'map') ?? files[0]
    const session = this.tabEmpty() ? this.current : this.newSession()
    if (session === undefined || session === null) return
    this.noteShelf(lead)
    await this.openNamed(session, lead)
    for (const entry of files) {
      if (entry === lead) continue
      this.noteShelf(entry)
      await session.addPicked(this.pickedFrom(entry))
    }
  }

  /**
   * The shelf a store row brought with it, answered later through the same
   * question the demo map's annotations are (`ui/examples.ts`). Registered
   * before the open, because the Tracks card is built while the file is
   * opening.
   */
  private noteShelf(entry: StoreEntry, asked = false): void {
    if (entry.tracks !== undefined && entry.tracks.length > 0) {
      registerShelf(splitUri(entry.uri).path, entry.tracks, { asked })
    }
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
          // The banner outlives the picker: a reader who opened a file while it
          // stood and then presses Restore has two things they want, and
          // replacing the one they just opened with the one they had would be
          // throwing away the newer of them. So a window with anything open is
          // *appended to*, the way a dropped workspace file is; only an empty
          // one is replaced, which for an empty window is the same thing.
          const busy = this.sessions.some((session) => session.state !== null)
          this.adoptWorkspace(workspace as Workspace, busy ? 'append' : 'replace')
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
  private adoptWorkspace(workspace: Workspace, mode: 'replace' | 'append' = 'replace'): void {
    if (mode === 'replace') {
      for (const session of this.sessions) session.destroy()
      this.sessions.length = 0
      reserveSessionIds(highestId(workspace.sessions.map((row) => ({ id: row.id, hash: '' }))))
    }

    const open = this.sessions.filter((session) => session.state !== null).length
    const plan = seatWorkspace({
      open,
      emptyTab: this.sessions.length === 1 && this.sessions[0].state === null,
      incoming: workspace.sessions.length,
      max: MAX_SESSIONS,
    })
    if (plan.consumeEmpty) {
      // A window showing only the picker is a window with nothing in it, and
      // leaving that tab beside the imports would be a picker nobody asked for.
      for (const session of this.sessions) session.destroy()
      this.sessions.length = 0
    }

    const first = this.sessions.length
    for (const row of workspace.sessions.slice(0, plan.take)) {
      // **Fresh ids on append.** Reusing the file's is safe only where the
      // window was emptied first: two tabs with one id share every `UiMemory`
      // scope keyed on it, so one tab's tracks would appear in the other's card
      // (`state/workspace.ts`). `applyConfig` is therefore keyed on the id this
      // window mints, not on the one the file carried.
      const id = mode === 'append' ? undefined : row.id
      this.seat(id, row.config)
    }
    if (this.sessions.length === 0) this.sessions.push(new Session(this))

    // **Nothing seated is nothing changed.** A window already holding the twelve
    // tabs it may hold takes none of the incoming ones, and then no tab "ends up
    // in front" at all: there is no tab to take the window's preferences from,
    // and no reason to move the reader off the one they are reading. All of this
    // used to run regardless, so an import that imported *nothing* still
    // overwrote the reader's overlays and column layout with the sender's and
    // threw them back to the first tab — underneath a notice that correctly said
    // nothing had come in.
    //
    // `take === 0` also means nothing was destroyed above: an empty tab is
    // consumed only where nothing else is open (`state/workspace.ts`), which is
    // a window with room for all twelve. So the window is exactly as it was, and
    // there is nothing to repaint either.
    if (plan.take > 0) {
      // Which tab ends up in front. On replace the ids are the file's own, so
      // the active one is found by name; on append they have been re-minted, so
      // it is found by *position* in the incoming list and offset past whatever
      // was already here — which is also what puts the reader on the tab the
      // sender was looking at rather than on the first one they happened to
      // open.
      const incoming = workspace.sessions.findIndex((row) => row.id === workspace.active)
      const wanted =
        mode === 'append'
          ? first + Math.max(0, Math.min(incoming, plan.take - 1))
          : this.sessions.findIndex((session) => session.id === workspace.active)
      this.active = wanted >= 0 && wanted < this.sessions.length ? wanted : 0
      // **The window's own preferences, from the tab that ends up in front.**
      //
      // `plot` and `panels` are window-level and every tab in the file carries a
      // copy, so restoring six of them would be five windows' worth of overlays
      // applied and discarded — the one that means anything is the tab the
      // reader is about to be looking at. `Session.openConfig` does exactly this
      // for the one-tab roads; this road does not go through it, which is why a
      // saved workspace used to come back with the sender's tracks and the
      // *importing* window's overlays, silently, and looking like the toggles
      // had not saved.
      //
      // Read back off `this.active` rather than off the file's own active index,
      // because the two part company the moment the sender's active tab is one
      // of the ones that did not fit: the window then opens on the last tab that
      // *did*, and the sentence above was false — the overlays came from a tab
      // this window never seated.
      const seated = mode === 'append' ? this.active - first : this.active
      const front = workspace.sessions[seated >= 0 && seated < plan.take ? seated : 0]?.config
      if (front !== undefined) {
        setPlotOptions(front.plot)
        this.applyPanelLayout(front.panels)
      }
      this.paintTabs()
      this.mountActive()
      this.writeHash(this.current?.state ?? null, { replace: true })
      this.current?.activate()
      this.remember()
    }
    if (plan.dropped > 0) {
      // Named rather than dropped in silence: a partial import is useful, and a
      // reader who is quietly given nine of twelve tabs has no way to find out.
      this.notify(
        `${plan.dropped} more ${plan.dropped === 1 ? 'tab was' : 'tabs were'} in that file than ` +
          `this window can hold. ${MAX_SESSIONS} is the limit — close a few and open it again.`,
      )
    }
  }

  /**
   * Put one remembered tab in the window.
   *
   * Shared by both modes for the ordering alone: **`applyConfig` runs before
   * `prime`**, because a primed tab's session memory is empty until it is
   * written and `exportConfig` would otherwise gather an empty config over the
   * good record on the first click. `adoptWorkspace`'s own comment records what
   * that cost the restore road; an append path that re-derived the order would
   * pay it again.
   */
  private seat(id: string | undefined, config: SessionConfig): void {
    const session = id === undefined ? new Session(this) : new Session(this, id)
    applyConfig(config, fileMemoryKey(session.id, config.state.uri))
    session.prime(config.state)
    this.sessions.push(session)
  }

  /**
   * Call one tab something.
   *
   * A pass-through, and it is here rather than as a direct call from the strip
   * because the strip holds an index into a list it was handed and the sessions
   * are this class's. The repaint follows from `sessionChanged`, which the
   * session raises for itself — a rename changes the label and nothing else, so
   * there is nothing to mount and nothing to navigate.
   */
  private renameSession(index: number, name: string): void {
    this.sessions[index]?.rename(name)
  }

  private newSession(): Session | null {
    if (this.sessions.length >= MAX_SESSIONS) {
      this.warn(
        `${MAX_SESSIONS} tabs is the limit. Each one holds a worker and, for a whole-file ` +
          'view, a matrix in memory — close one to open another.',
        'Too many tabs',
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
    // **And the bar under it**, because what it counts is a property of what is
    // mounted. Its own contract is that the numbers are the active tab's and
    // change when the tab does, and the only thing that called it was
    // `activity()` — which a session raises when it has *read* something. A tab
    // that has read nothing never raises it, so opening a second tab left the
    // first file's bytes under an empty landing page and switching back kept
    // whatever the other one had counted. Here rather than in
    // {@link activate}, because the boot parents a session without going
    // through it.
    this.status?.refresh()
    // …and the note, which is either the window's or the tab's own.
    this.paintNotice()
    // The tab's own name where it has one (a Drive file's, a store row's), the
    // file's otherwise — the same line the tab strip shows.
    document.title = session.state === null ? APP_TITLE : `${session.label} — ${APP_TITLE}`
  }

  private applyPanels(session: Session): void {
    const panels = session.panels
    // `cards` is not there yet on the first mount, which happens while the
    // shell is still being built; nothing has been moved by then either.
    const holds = (panel: SidePanel): boolean => this.cards?.holdsForeign(panel.id) === true
    this.generalPanel.setAvailable(panels.general || holds(this.generalPanel))
    this.annotationsPanel.setAvailable(panels.annotations || holds(this.annotationsPanel))
    this.aestheticsPanel.setAvailable(panels.aesthetics || holds(this.aestheticsPanel))
    this.analysisPanel.setAvailable(panels.analysis || holds(this.analysisPanel))
  }

  /**
   * Whether the Files column has anything to be, which is now a question.
   *
   * It used to be available from the first paint and never withdrawn, and the
   * reason was a good one: its own *connect a local or remote folder* was the only
   * door to a folder, and a door nobody can see is not a door. The landing
   * page now offers the four places itself (§24.2), so that argument has moved
   * out of this column — and what is left on the first screen without it is an
   * empty column beside a row of buttons that say the same thing. §8.5's rule
   * then applies as it does to the four columns beside it: a panel with
   * nothing to show leaves altogether.
   *
   * So the column exists **exactly when this window has a place connected**,
   * on every screen and not only the first. The doors are elsewhere and stay
   * elsewhere: the landing page, which a new tab is, and *connect a local or remote
   * folder* in the command palette.
   *
   * Connecting one *reveals* it as well ({@link folderConnected}), so the
   * column a reader has just earned is open rather than a tab they have to
   * find.
   */
  private refreshFilesPanel(): void {
    this.filesPanel.setAvailable(connectedFolders().length > 0)
  }

  private paintTabs(): void {
    this.tabs.render(
      this.sessions.map((session, index) => ({
        id: session.id,
        label: session.label,
        hint: session.tabHint,
        // A tab with nothing open has nowhere to keep a name — the memory is
        // keyed on the file — so the strip does not offer the gesture there
        // rather than taking a name and losing it (`Session.rename`).
        nameable: session.state !== null,
        named: session.name !== null,
        active: index === this.active,
        pending: session.isPrimed,
      })),
      this.sessions.length < MAX_SESSIONS,
    )
    this.syncShare()
  }

  /**
   * The picker, without taking the tab in front down with it.
   *
   * A new tab where there is anything to keep, and this tab where there is
   * not: an empty tab is the picker already, so opening a second one would
   * answer "take me home" with two identical empty tabs. At the tab limit
   * {@link newSession} refuses and says why, which is the honest answer to
   * *and one more* — nothing is emptied on the way.
   */
  private goHome(): void {
    const session = this.current
    if (session === undefined || session.state === null) session?.toPicker()
    else this.newSession()
  }

  /**
   * Whether there is anything in this tab to put in a link.
   *
   * The state, not `exportConfig()`, and they are the same answer: that method
   * returns `null` exactly when the tab has no view state, and asking it
   * instead would serialise every track, mark and bookmark in the session — on
   * every repaint, which is every track loaded and every mark placed — to
   * discover a boolean. The palette's *Share* row is gated on this same getter,
   * because a header button that opens a refusal while the palette greys the
   * same command out is one of the two lying about the state.
   */
  private get canShare(): boolean {
    return (this.current?.state ?? null) !== null
  }

  private syncShare(): void {
    const ready = this.canShare
    this.shareButton.disabled = !ready
    const title = ready
      ? 'Share this tab as a link'
      : 'Share this tab as a link — open a file first'
    this.shareButton.title = title
    this.shareButton.setAttribute('aria-label', title)
  }

  /**
   * Write the tab strip down, unless this window is not one.
   *
   * **An embed remembers nothing**, and the guard is here rather than at each
   * call site because both roads out of this method — the strip in
   * `sessionStorage` and the durable record under it — are answers to the same
   * question, *what was this window holding*, which an embed does not have.
   * What it has is a URL that says what to show, and it must say it on every
   * load: a reader who panned an embedded figure last month and comes back to
   * the article should meet the figure the page names, not the corner of it they
   * left. Remembering would also be remembering into a store partitioned per
   * embedding site, that the reader has no interface to and no way to clear.
   */
  private remember(): void {
    if (this.embed) return
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
    // Its own guard, and not only `remember`'s: this is reached from a panel
    // fold, from a tab change and from `pagehide` as well as from a navigation,
    // so a single check one level up would leave three roads open. An embed
    // writing here would be worse than the strip it does not write — the record
    // is what the *landing page* offers back, so an embedded figure would seed
    // the offer a reader meets on the real site.
    if (this.embed) return
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

  /**
   * Say something to the reader that is worth knowing and not worth stopping
   * for.
   *
   * The third channel this shell has, after the modal and the error view, and
   * the only quiet one. A session uses it for facts about what it just opened —
   * that the file it was handed is not quite the file its session was made from,
   * for instance — where refusing would be wrong and silence would be worse.
   */
  notify(message: string, owner?: Session): void {
    this.notice = { message, owner: owner ?? null }
    this.paintNotice()
  }

  withdrawNotice(owner: Session): void {
    if (this.notice?.owner !== owner) return
    this.notice = null
    this.paintNotice()
  }

  /**
   * The note, where it is the window's or the tab in front's.
   *
   * A tab's is about its own file, and a banner naming chrY over another tab's
   * map of a chicken is the error it exists to prevent, so it waits behind
   * its tab until that tab is in front again.
   */
  private paintNotice(): void {
    const notice = this.notice
    const shown = notice !== null && (notice.owner === null || notice.owner === this.current)
    this.noticeSlot.replaceChildren(
      ...(shown
        ? [
            noticeBanner(notice.message, () => {
              this.notice = null
              this.paintNotice()
            }),
          ]
        : []),
    )
  }

  /**
   * The window's columns, keyed the way they are stored.
   *
   * The Files panel is in it like the other four, and deliberately: §16.5's
   * distinction — four columns describe the file and one describes the places
   * this window has been connected to — is about *what they hold*, not about how
   * much room a reader gave them. Somebody who folded the file list away and
   * saved a workspace meant it folded.
   */
  panelLayout(): PanelLayout {
    const layout: PanelLayout = {}
    for (const [spec, column] of this.columns()) layout[spec.key] = column.layout
    return layout
  }

  /**
   * Put a saved arrangement of columns back. Absent is *leave them alone*.
   *
   * And so is an embed, for the reason its columns do not read the stored fold
   * either: a layout describes the window somebody saved from, and a frame is not
   * one. The two columns an embed mounts arrive folded whatever this is handed,
   * and are opened by the reader — from the bar, or from their own spines.
   */
  applyPanelLayout(layout: PanelLayout | undefined): void {
    if (this.embed || layout === undefined) return
    for (const [spec, column] of this.columns()) column.applyLayout(layout[spec.key])
  }

  /**
   * The five columns beside their specs, so the two methods above cannot name
   * four of them each and a different four.
   */
  private columns(): ReadonlyArray<readonly [SidePanelSpec, SidePanel]> {
    return [
      [FILES_PANEL, this.filesPanel],
      [GENERAL_PANEL, this.generalPanel],
      [ANNOTATION_PANEL, this.annotationsPanel],
      [AESTHETICS_PANEL, this.aestheticsPanel],
      [ANALYSIS_PANEL, this.analysisPanel],
    ]
  }

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
    // The tab's own name where it has one (a Drive file's, a store row's), the
    // file's otherwise — the same line the tab strip shows.
    document.title = session.state === null ? APP_TITLE : `${session.label} — ${APP_TITLE}`
  }

  stateChanged(session: Session, options: { replace: boolean }): void {
    this.remember()
    if (session !== this.current) return
    // A navigation is how a tab comes to hold something, or stops holding it,
    // so it is also when the link button becomes available or goes.
    this.syncShare()
    this.writeHash(session.state, options)
    // The other bar, for a window that has one. `moved` is silent until a host
    // has asked to be told, so an embed nobody is driving posts nothing at all
    // — which is why this can sit on the navigation path unconditionally.
    this.channel?.moved()
  }

  panelsChanged(session: Session): void {
    if (session !== this.current) return
    this.applyPanels(session)
  }

  landingFileOpened(session: Session): void {
    if (session !== this.current) return
    this.filesPanel.conceal()
  }

  activity(session: Session): void {
    if (session !== this.current) return
    this.status?.refresh()
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
   * *Replaces* is what separates this door from {@link addFileDialog}, which is
   * the same box with the other verb behind it. Both go through
   * {@link loadDialog}, so the two dialogs cannot drift apart in anything but
   * the thing they differ in. Neither offers the stores: a store is a drawer
   * over the window, one press away in the header, and every row on one opens
   * without destroying the tab in front.
   */
  openFileDialog(session: Session): void {
    this.loadDialog({
      title: 'Open a file',
      onOpen: (uri, source) => void session.openPicked(uri, source),
      onOpenFiles: (files) => void session.openFiles(files),
    })
  }

  /**
   * The header's `+`: one more file *in* this tab, from wherever the reader is.
   *
   * Dropping onto the content area adds rather than replaces in every case it
   * can (`Session.dropFiles`) — a second cooler comes up beside the first, a
   * bigWig joins the tracks — but a drop needs somewhere to drag from, and this
   * is the click-sized door to the same thing. On an empty tab the distinction
   * does not exist — there is nothing to add to — so it opens there instead,
   * which is the same answer the landing page gives.
   */
  private addFileDialog(): void {
    const session = this.current
    if (session === undefined) return
    const empty = !session.hasFile && !session.isBrowsing
    this.loadDialog({
      title: empty ? 'Open a file' : 'Add a file to this tab',
      onOpen: (uri, source) =>
        void (empty ? session.openPicked(uri, source) : session.addRemote(uri, source)),
      onOpenFiles: (files) => void (empty ? session.openFiles(files) : session.dropFiles(files)),
    })
  }

  /**
   * The load box, over whatever is on screen, however it was asked for.
   *
   * A `LoadBox` of its own, not the landing page: that element is the landing
   * view and moving it into a dialog would empty the page behind it. What
   * differs between the two callers is the *verb* — replace this tab's file, or
   * add one to it — so that is all this takes: one box, one modal, two sets of
   * doors out of it.
   */
  private loadDialog(props: {
    title: string
    onOpen(uri: string, source: SourceSpec): void
    onOpenFiles(files: readonly File[]): void
  }): void {
    if (this.modal !== null) return
    const modal: Modal = new Modal({
      title: props.title,
      variant: 'modal-wide',
      body: () =>
        el(
          'div',
          { class: 'modal-body load-dialog' },
          new LoadBox({
            compact: true,
            onOpen: (uri, source) => {
              modal.close()
              props.onOpen(uri, source)
            },
            onOpenFiles: (files) => {
              modal.close()
              props.onOpenFiles(files)
            },
          }).el,
        ),
      onClose: () => {
        this.modal = null
      },
    })
    this.modal = modal
  }

  /**
   * The whole window, written to a file.
   *
   * **Every tab, not the one in front**, and that is what the button says. A
   * window of six maps with their tracks, marks and bookmarks is a project
   * rather than a picture, and the reader who presses Save meant the project —
   * the picture already has its own two buttons, the figure export and the
   * share link.
   *
   * What travels is everything about a tab that is not the bytes of its data:
   * the view, the window, the colour scale, every track with its settings, the
   * groups, the ticked sequences, the hand-placed marks, the saved places and
   * the analysis recipes. Dropping the file back on the page brings all of it
   * up again — asking for the files themselves, where those are local ones no
   * page can re-open by name.
   */
  private exportWorkspace(): void {
    const tabs: SessionConfig[] = []
    let active = -1
    for (const session of this.sessions) {
      const config = session.exportConfig()
      if (config === null) continue
      if (session === this.current) active = tabs.length
      tabs.push(config)
    }
    if (tabs.length === 0) {
      this.warn('There is nothing open in this window to save.', 'Nothing to save')
      return
    }
    const now = new Date()
    void downloadBlob(
      new Blob([JSON.stringify(buildWorkspaceFile(tabs, active, now), null, 2)], {
        type: 'application/json',
      }),
      workspaceFileName(fileStamp(now)),
    )
  }

  /**
   * Open a saved workspace, beside whatever is already here.
   *
   * **Appended, never replacing.** `adoptWorkspace('replace')` closes every open
   * tab, which is right where it runs — an empty startup window whose reader has
   * just been asked — and would be catastrophic here: six tabs gone on a drop,
   * with no message and no undo. `Session.dropFiles` states the doctrine this
   * follows: adds rather than replaces in every case it can.
   */
  openWorkspaceFile(text: string, label: string, base?: string): void {
    const read = parseWorkspaceFile(text)
    if (isRefusal(read)) {
      this.warn(refusalMessage(read, label), 'That workspace could not be read')
      return
    }
    // A published workspace names its files relative to its own folder, so they
    // are pointed at wherever it was found. A dropped file has no folder a page
    // can see, and its names are already absolute or already local.
    const tabs =
      base === undefined ? read.tabs : read.tabs.map((tab) => resolveConfig(tab, base))
    this.adoptWorkspace(
      {
        version: read.version,
        savedAt: read.createdAt,
        sessions: tabs.map((config, index) => ({ id: `imported-${index}`, config })),
        active: `imported-${read.active}`,
      },
      'append',
    )
  }

  /**
   * This tab as a link, and the offer to shorten it.
   *
   * The same *format* {@link exportWorkspace} writes to a file, carrying one tab
   * rather than the window — a workspace of one, so both roads are read by one
   * parser and neither can drift from the other (`state/shareLink.ts`). The
   * difference between the two buttons is the honest one: a link is what you are
   * looking at, a file is everything you have open.
   */
  private openShareDialog(): void {
    const config = this.current?.exportConfig() ?? null
    if (config === null) {
      this.warn('There is nothing open in this tab to share.', 'Nothing to share')
      return
    }
    this.modal?.close()
    this.modal = openShareDialog({
      config,
      base: `${window.location.origin}${window.location.pathname}${window.location.search}`,
      // Every opener owes the field this, and this one used not to pay it: the
      // dialog closed, `this.modal` went on pointing at it, and `modal !== null`
      // — which is how the shell says "a dialog owns the keyboard" — stayed true
      // for the life of the tab. One press of Escape here killed every shortcut
      // and every other dialog until the page was reloaded.
      onClose: () => {
        this.modal = null
      },
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
    const read = await decodeShare(payload)
    if (read === null || isRefusal(read)) {
      // Two different failures, and only one of them is the link's fault. A
      // payload that did not inflate was cut short in transit; anything past
      // that arrived intact, and a session this build cannot read is a fact
      // about the build. Sending a reader back for a fresh copy of a link that
      // will fail identically is the outcome worth avoiding.
      this.warn(
        read === null
          ? 'That shared link could not be read. It may have been cut short in transit.'
          : refusalMessage(read, 'That shared link'),
        'That link could not be opened',
      )
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return false
    }
    const config = read
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
    // **An embed never pushes.** A frame's `pushState` writes into the *joint*
    // session history — the one the reader's Back button walks — so a figure
    // embedded in an article would quietly take that button over: clicking a
    // genome, then Back, would step the map instead of leaving the page, and the
    // number of presses needed to get out would be however many times the reader
    // touched the picture. §5.5's own argument, one level up: the back button
    // should walk the breadcrumb of *this window*, and inside a frame that
    // history is not this window's to spend.
    //
    // The bar is still written, and that is not a contradiction. It is what a
    // reload reads, what "copy this link" copies, and what makes an embed's
    // current view addressable at all — only the *stack* is left alone.
    if (options.replace || this.embed) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    this.writingHash = false
    if (this.brandLink !== null) this.brandLink.href = this.fullViewerUrl()
  }

  /**
   * This page, in the full application.
   *
   * The whole of the difference is `embed` leaving the query string: the
   * fragment goes across untouched, so the window that opens is looking at
   * exactly what the frame was — same file, same view, same colour limits — with
   * the header, the tabs and the other three columns around it. `?config=` stays
   * too, which costs nothing (the fragment overrides it) and means a reader who
   * lands there and reloads gets the figure back rather than the picker.
   */
  private fullViewerUrl(): string {
    const url = new URL(window.location.href)
    url.searchParams.delete('embed')
    return url.href
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
    // and a shared session is not a view: `parseViewState` would read
    // `session=…` as an unknown key, ignore it, and navigate to the default
    // view of nothing.
    if (readShareHash(window.location.hash) !== null) {
      void this.openSharedHash()
      return
    }
    this.goTo(parseViewState(window.location.hash))
  }

  /**
   * Move the active tab to a view state that came from outside this window.
   *
   * Three roads arrive here and they are one gesture: the address bar (a pasted
   * link, a hand-edited hash), the back button, and — in an embed — the host
   * page over `postMessage`. Sharing the road is the point rather than a
   * saving: the host channel has no business knowing that a state naming a
   * different file has to open it, which is a rule `Session.render` already
   * holds and would otherwise be restated in a second place.
   */
  private goTo(state: ViewState | null): void {
    const session = this.current
    if (session === undefined) return
    if (viewStateEquals(state, session.state)) return
    // `set` notifies, which reaches `stateChanged`, which writes the hash — and
    // finds it already exactly this and does nothing. That is the loop closing
    // rather than a guard against it: one comparison, in one place.
    session.store.set(state)
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
        id: 'add-file',
        group: 'File',
        title: 'Add a file to this tab',
        hint: ADD_FILE_HINT,
        run: () => this.addFileDialog(),
      },
      {
        id: 'connect-folder',
        group: 'File',
        // *Connect*, because that is what happens to a folder everywhere else in
        // the app (§24.2): a file is opened, a place is connected, and this row
        // was the last one that said "open" about a folder.
        // The same name the landing page and the Files column give the door,
        // which has no remote half in the standalone build (§19).
        title: CONNECT_FOLDER_TITLE,
        hint: CONNECT_HINT,
        // Greyed in an embed, which mounts no Files column for a folder to go
        // into (§21.2): the landing page there offers no place to connect, and
        // the palette must not be the one door left to a column nobody sees.
        enabled: !this.embed,
        run: () => this.openConnectDialog(),
      },
      // Absent from the single file rather than greyed (§19). Greying is for a
      // command another state of this window could make work — the palette
      // keeps its shape for that (§26.6) — and that build has no state in which
      // a store opens: there is no drawer, so the key goes with the row. An
      // embed keeps the row greyed, as it keeps the console's: the web build's
      // own command, in a frame with no room for its panel (§21.2).
      ...(IS_STANDALONE
        ? []
        : [
            {
              id: 'open-store',
              group: 'File',
              title: 'Stores',
              // Not a list of them, which named four of the seven that ship: the
              // drawer's tiles are the list, read off the registry (§24.2).
              hint: 'Every data store this viewer ships with, and any you connected, as a drawer down the left.',
              keys: KEYS.stores,
              enabled: this.storeDrawer !== null,
              ...(this.storeDrawer === null ? {} : { state: chipOf(this.storeDrawer.isOpen) }),
              run: () => this.storeDrawer?.toggle.click(),
            },
          ]),
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
        title: 'New tab',
        hint: 'Another tab, with its own file, tracks and settings.',
        // `o`, not ⌘T: every browser claims ⌘T for a tab of its own and never
        // lets the page see it, so the binding was one a reader could read in
        // this dialog and never once perform.
        keys: KEYS.newSession,
        enabled: this.sessions.length < MAX_SESSIONS,
        run: () => this.newSession(),
      },
      {
        id: 'save-workspace',
        group: 'File',
        title: 'Save every tab as a file',
        // One line, which is what the registry promises for a hint. The
        // paragraph that was here listed what the file holds and then pointed
        // at "the link button beside it" — a header button that is beside
        // nothing in this list, and whose command is three rows down.
        hint: 'Every tab, its tracks and its settings, as one file you can drop back on the page.',
        keys: KEYS.saveSession,
        enabled: file,
        run: () => this.exportWorkspace(),
      },
      {
        id: 'rename-session',
        group: 'File',
        title: 'Rename this tab',
        // Five lines of rationale used to stand here — why a name helps, what
        // it travels in, how to clear it, and the gesture that does the same
        // thing — with the file name in Markdown backticks that nothing on
        // this surface renders. A palette is scanned, so the row keeps the one
        // sentence that says what the command is for; the rest is in the
        // rename box's own tooltip and in §5.6.
        hint: 'Name the tab for its condition or its figure; the name travels with the link.',
        keys: KEYS.renameSession,
        enabled: file,
        run: () => {
          const id = this.current?.id
          if (id !== undefined) this.tabs.beginRename(id)
        },
      },
      {
        id: 'close-session',
        group: 'File',
        title: 'Close this tab',
        hint:
          this.sessions.length === 1
            ? 'The last tab is emptied rather than closed — there would be nothing to drop a file on.'
            : undefined,
        run: () => this.closeSession(this.active),
      },
      {
        id: 'next-session',
        group: 'Go',
        title: 'Next tab',
        keys: KEYS.nextSession,
        enabled: this.sessions.length > 1,
        run: () => this.activate((this.active + 1) % this.sessions.length),
      },
      {
        id: 'prev-session',
        group: 'Go',
        title: 'Previous tab',
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
    //
    // Iterated over the **labels**, not over the bindings. Not every overlay has
    // a key — `legend` has none (`ui/plotOptions.ts`) — and iterating the keys
    // would have dropped that one out of the palette altogether, which is the
    // one place in this app that promises to list everything it can do. A
    // command with no `keys` is a palette-only command, which is a state the
    // registry already has a word for.
    //
    // **Titled by the noun, with the state as a chip** (§26.4). They were
    // `${overlays[key] ? 'Hide' : 'Show'} label`, which made the shortcuts
    // dialog — a reference card, printed from this same list — read "N Hide
    // track text · U Show name column · D Show dividers": ten rows whose verb
    // records what the app happened to be doing when the dialog was opened, so
    // a reader looking for "the labels key" scans for two words and one looking
    // for *Show crosshair* does not find it at all. The noun is the same row
    // whichever way it is set, and `Command.state` says which way that is.
    for (const key of Object.keys(PLOT_OPTION_LABELS) as Array<keyof typeof PLOT_OPTION_LABELS>) {
      const { label } = PLOT_OPTION_LABELS[key]
      list.push({
        id: `overlay-${key}`,
        group: 'View',
        title: label.charAt(0).toUpperCase() + label.slice(1),
        hint: PLOT_OPTION_LABELS[key].hint,
        state: chipOf(overlays[key]),
        ...(PLOT_OPTION_KEYS[key] === undefined ? {} : { keys: PLOT_OPTION_KEYS[key] }),
        run: () => void togglePlotOption(key),
      })
    }

    list.push(
      {
        id: 'refine-on-zoom',
        group: 'View',
        title: 'Refine on zoom',
        // One line, and it no longer sends the reader to a button that is not
        // there: `MatrixPanel`'s `OFFER_REFINE` is false, because refinement is
        // one preference across a whole deck rather than a property of one
        // map, so the picture row holds the turn and the baseline and this is a
        // palette command only (§2).
        hint: 'Zooming past the block in hand reads the window again at a finer grid.',
        state: chipOf(refineEnabled()),
        run: () => void toggleRefine(),
      },
      {
        id: 'fold-sidebar',
        group: 'View',
        title: 'General panel',
        hint: 'A reference card about the open file: what it is, its genome, its metadata.',
        keys: GENERAL_PANEL.keys,
        enabled: file && !this.embed,
        state: chipOf(!this.generalPanel.isCollapsed),
        run: () => this.generalPanel.toggle.click(),
      },
      {
        id: 'fold-files',
        group: 'View',
        title: 'Files panel',
        // Gated like its four siblings, which it was not. The argument for
        // leaving it live — that its own *connect a folder* was the one door to
        // one, so the column had to be reachable before anything was open — has
        // moved out of this column: the landing page offers the four places
        // itself and §20.4 now says the column exists exactly when a folder is
        // connected. Which makes its key with none connected the very thing the
        // Annotations gate exists to prevent: a key that folds an invisible
        // column, and so appears to do nothing.
        hint:
          connectedFolders().length > 0
            ? 'The folders you have connected, and what is in them.'
            : 'Connect a folder first — there is no Files column until you have one.',
        keys: FILES_PANEL.keys,
        enabled: connectedFolders().length > 0 && !this.embed,
        state: chipOf(!this.filesPanel.isCollapsed),
        run: () => this.filesPanel.toggle.click(),
      },
      {
        id: 'fold-annotations',
        group: 'View',
        // The hint is computed from the state, because it is the *reason*. It
        // had a third branch, "Absent on a metacool, which carries no
        // annotations", from the release the cards were gated off a file with a
        // genome layer; the gate went (§8.5), the column came up on a metacool
        // with the rest, and the row stayed greyed beside it.
        title: 'Annotations panel',
        hint: file ? 'The tracks, structures, marks and bookmarks on this file.' : 'Open a file first.',
        keys: ANNOTATION_PANEL.keys,
        // The same gate the button is under — the column's own availability,
        // which is whether the session put any cards in it — so a shortcut never
        // folds an invisible column, a key that appears to do nothing.
        enabled: session?.panels.annotations === true,
        state: chipOf(!this.annotationsPanel.isCollapsed),
        run: () => this.annotationsPanel.toggle.click(),
      },
      {
        id: 'fold-aesthetics',
        group: 'View',
        title: 'Aesthetics panel',
        hint: file ? 'How the picture is drawn: colours, scales, overlays, export.' : 'Open a file first.',
        keys: AESTHETICS_PANEL.keys,
        enabled: file,
        state: chipOf(!this.aestheticsPanel.isCollapsed),
        run: () => this.aestheticsPanel.toggle.click(),
      },
      {
        id: 'fold-analysis',
        group: 'View',
        title: 'Analysis panel',
        hint: 'What can be computed from this file, as against what is drawn on it.',
        keys: ANALYSIS_PANEL.keys,
        enabled: file && !this.embed,
        state: chipOf(!this.analysisPanel.isCollapsed),
        run: () => this.analysisPanel.toggle.click(),
      },
      {
        id: 'console',
        group: 'View',
        title: 'Console',
        hint: 'Every run, open and export this window has made, as commands that repeat them.',
        keys: KEYS.console,
        // Absent in an embed, where there is no panel to open — the command
        // list is the shortcuts dialog and the palette, and both must describe
        // what this window actually answers.
        enabled: this.consolePanel !== null,
        ...(this.consolePanel === null ? {} : { state: chipOf(this.consolePanel.isOpen) }),
        run: () => this.consolePanel?.toggle.click(),
      },
      {
        id: 'theme',
        group: 'View',
        // Not "system, light, dark" any more: the cycle is ordered against the
        // machine's own scheme, so on a light OS it is system, dark, light
        // (`ui/ThemeToggle.ts` argues why). The row names the control and the
        // button's own tooltip says what the next press will do.
        title: 'Cycle the theme',
        hint: 'System follows the machine; every press changes what is on screen.',
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
        id: 'reset-cards',
        group: 'View',
        title: 'Put every card back in its own panel',
        hint: this.cards.arranged
          ? 'Undo every card you have moved by its heading, in every panel.'
          : 'No card has been moved — drag one by its heading to move it.',
        enabled: this.cards.arranged,
        run: () => this.cards.reset(),
      },
      {
        id: 'share',
        group: 'File',
        title: 'Share this tab as a link',
        run: () => this.openShareDialog(),
        enabled: this.canShare,
      },
      {
        id: 'stored-data',
        group: 'Help',
        title: 'What this browser is remembering',
        hint: 'Everything this computer has kept, with a button that clears all of it.',
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
   * input belongs to that input — `?` and `<` are legal in a contig name, and
   * `o` is legal in every name there is. Chords survive both, because ⌘P from a
   * text box is still ⌘P.
   */
  private onKeyDown(event: KeyboardEvent): void {
    // First, and whatever the key turns out to be for: a word typed into a box
    // says as much about the layout as a shortcut does, and the press that
    // teaches is the first one read with what it taught.
    learnKey(event)
    // **A key the focused control has already answered is not the app's too.**
    // The pictures with keys of their own say so the way the drawers' Escape
    // does: a dot plot's canvas zooms on `+` and `−` and refits on `0`, a 1D
    // browser's zooms and shows the whole genome, a plot's edge goes back to its
    // default on `0` — and each of those, heard here as well, stepped the map's
    // resolution or refitted it under a press that was about something else.
    if (event.defaultPrevented) return
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
      // ⌘ or Ctrl, and Control on a Mac: the tabs' `ctrl+<` from a filter box is
      // still the next tab, as `mod+p` there is still the palette.
      if (typing && !/^(mod|ctrl)\+/.test(command.keys)) continue
      // ⌘C is the browser's before it is ours whenever there is text under it.
      if (command.yieldsToText === true && wantsTextCopy(event.target)) continue
      // …and Space is a focused button's, tickbox's or menu row's before ours.
      if (command.yieldsToControls === true && wantsSpace(event.target)) continue

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

  /**
   * A refusal that is not about a file, so it has no error view to live in.
   *
   * The caller names the subject, because the caller is the only one who knows
   * it. A dialog headed "Not this time" for every refusal told the reader that
   * something had been declined and made them read the paragraph to find out
   * what — and read it again, later, to remember which of the three refusals
   * they had seen. "Nothing to share" is answered before it is finished being
   * read.
   */
  private warn(message: string, title: string): void {
    if (this.modal !== null) return
    this.modal = new Modal({
      title,
      body: () => el('p', { text: message }),
      onClose: () => {
        this.modal = null
      },
    })
  }
}

/** Re-exported so the bootstrap can name the one error type it may see. */
export { ViewerError }
