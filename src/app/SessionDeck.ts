/**
 * The deck of panels (§16) as a session holds it: further files beside this
 * one, under one navigation.
 *
 * `panels/PanelDeck.ts` is the deck itself — the cells, the lock, the toolbar —
 * and knows nothing about a session. This is the other half: whether a deck
 * may exist at all, when one is built and when it is put down, how it is kept
 * in line with the `maps` the hash names, what frames the view on screen (the
 * deck, or the `+` edges round a map that has none yet), and every question the
 * deck asks back — which map leads, what its turn and its score are, which
 * tracks and models its cells draw. The answers are the session's, and they
 * are read through it at the moment they are asked, never captured.
 *
 * Separate from `Session` because it was the largest thing in it that the rest
 * of the session only ever *uses*: a drop, a structure row or a command builds
 * a deck with `ensure`, asks `possible`, or frames a view with `framed`, and
 * none of them needs to know how. The maps the eye took out of the deck are
 * held here too, beside the deck they were taken from.
 *
 * Reconciling stays callable as `Session.syncDeck`, and `render` goes through
 * that: the DOM tests replace it on the session to stand the deck aside, and a
 * render that called {@link SessionDeck.sync} directly would step round them.
 */

import { formatLocus, type Assembly } from '../genome/assembly'
import { NameIndex } from '../genome/naming'
import { placementOn } from '../annotations/types'
import type { PickedFile } from '../browse/folder'
import { DeckFrame } from '../panels/DeckFrame'
import { parseMaps, type DeckLocal, type GrowDirection } from '../panels/deck'
import { PanelDeck } from '../panels/PanelDeck'
import { recall } from '../state/UiMemory'
import { viewStateEquals } from '../state/ViewState'
import type { ViewState } from '../types'
import { offerLanding, type LaneSurface } from '../ui/laneCarry'
import { MATRIX_OPTIONS, TRACK_OPTIONS } from '../ui/plotOptions'
import { resolveSource } from './resolve'
import type { OpenFile, Session } from './Session'

export class SessionDeck {
  /**
   * Further files, each in a panel of its own beside this one (§16).
   *
   * The other generalisation of "two files", and orthogonal to
   * {@link Session.compare} rather than a replacement for it: the triangle is
   * two files in one square, this is N squares under one navigation, and a
   * session may hold both. Built on demand and put down when the last companion
   * is closed, so a session with one map is exactly the session it was before
   * decks existed — no grid, no lock, no toolbar.
   */
  grid: PanelDeck | null = null
  /**
   * The `+` edges round a map that has no deck yet (§16.9).
   *
   * The session holds one because the gesture has to exist *before* the feature
   * does: a reader with one map has nothing on screen telling them this viewer
   * can put another beside it, and the command palette is not a place anybody
   * looks for a thing they do not know exists. Once a deck is built it grows its
   * own edges round its grid and this one goes back to holding nothing — the
   * same component either way, so pressing `+` on a deck of four is visibly the
   * same act as pressing it on a map of one.
   */
  private readonly edges = new DeckFrame({
    onGrow: (direction, picked) => this.grow(direction, picked),
    // The map's own row off the Contact maps card, dropped on an edge before
    // there is a deck: the deck, with a second picture of it in the new cell.
    onGrowWithMap: (direction, row) => {
      if (this.possible) this.ensure().growWithMap(direction, row)
    },
    // A model or a track off the Annotations panel, the same way: the deck,
    // with that one in the new cell (§16.9).
    onGrowWithStructure: (direction, id) => {
      if (this.possible) this.ensure().growWithStructure(direction, id)
    },
    onGrowWithTrack: (direction, id) => {
      if (this.possible) this.ensure().growWithTrack(direction, id)
    },
  })
  /**
   * Those edges as places a lane carried off the map by its grip can land
   * (`ui/laneCarry.ts`): the deck, with the lane moved into its new cell. Only
   * while they are round a lone map — once there is a deck, its own edges are
   * the ones on screen, and it answers for them.
   */
  private readonly edgeLanding: LaneSurface = {
    landingAt: (x, y) => {
      if (this.grid !== null || !this.possible) return null
      const direction = this.edges.edgeAt(x, y)
      if (direction === null) return null
      return {
        light: (on) => this.edges.lightEdge(direction, on),
        take: (carry) => this.ensure().landLaneGrowing(direction, carry),
      }
    },
  }
  private readonly stopEdgeLanding = offerLanding(this.edgeLanding)
  /**
   * The maps the eye on a Contact maps row took out of the deck (§16.9): still
   * this session's, still listed, drawn in no cell until the eye or a drop puts
   * them back. Held here and not by the deck, because a deck left with nothing
   * beside the first map puts itself down — and the maps hidden from it are
   * exactly the ones it no longer has a cell for. The ids are the session's
   * own, in a namespace the deck's `p1`, `p2`… cannot reach.
   */
  hidden: Array<{ id: string; picked: PickedFile }> = []
  private hiddenCount = 0
  /** The lead file's sequences as an assembly, for a tracks cell of the deck (§25.3). */
  private tracksAssembly: { file: OpenFile; assembly: Assembly } | null = null
  /**
   * What was last handed to {@link Session.showContent}, so a deck built
   * *after* a view was mounted can frame it without re-reading its block.
   */
  contentNode: HTMLElement | null = null

  constructor(private readonly session: Session) {}

  /**
   * The local companions this session wrote down, still in range of the hash.
   *
   * The hash keeps a `~` for each of them (§16.6) and this says which file each
   * `~` was, so the two have to agree about *how many* cells there are: a
   * remembered index past the end of the current `maps` is from a deck that has
   * since shrunk, and promoting it would grow the deck back by a cell the reader
   * closed. Filtered here rather than in `withLocalCompanions`, which is a pure
   * function over one list and cannot know which is the newer.
   */
  private rememberedCompanions(state: ViewState): Array<{ index: number; uri: string }> {
    const width = parseMaps(state.maps).length
    if (width === 0) return []
    const stored = recall<DeckLocal[]>(this.session.memoryKey(state.uri), 'deck:locals')
    if (!Array.isArray(stored)) return []
    return stored.filter(
      (local) =>
        typeof local?.uri === 'string' &&
        local.uri !== '' &&
        Number.isInteger(local?.index) &&
        local.index >= 0 &&
        local.index < width,
    )
  }

  /**
   * Bring the companions in line with the hash, and put the deck down when the
   * last of them is closed.
   *
   * Built lazily and destroyed eagerly, so a session with one map holds no
   * deck, no lock and no toolbar — it is byte for byte the session it was
   * before panels existed, which is the property that makes this feature
   * additive rather than a rewrite of the router.
   */
  async sync(state: ViewState): Promise<void> {
    // A hash naming companions is not a reason to build a deck the file cannot
    // have (§16, {@link possible}). A link outlives the file it was made
    // from, and one made against a cooler and opened on a metagenome would
    // otherwise put five panels round a map none of them can follow.
    if (this.session.file?.info.hasGenomes === true) return
    const remembered = this.rememberedCompanions(state)
    if (this.grid === null && parseMaps(state.maps).length === 0 && remembered.length === 0) return
    // Asked *before* the deck is handed the state, because resolving a grant is
    // asynchronous and nothing inside `PanelDeck` may be. All of them at once:
    // four companions are four independent files and there is nothing to gain
    // from asking one after another.
    const locals = await Promise.all(
      remembered.map(async (local) => ({
        ...local,
        source: await resolveSource(local.uri),
      })),
    )
    if (this.session.destroyed) return
    // **Only the state still in force reconciles the deck.** Dropping eight
    // coolers adds seven companions one after another, and each publish is a
    // render of its own: `~`, then `~|~`, up to seven. Every one of those waited
    // here for its grants, and came back after the last map had been added —
    // so the render of `~` shrank a deck of seven to one, and the renders after
    // it grew it back from the stored record, which cannot re-open a dropped
    // file. What a reader got was two maps and six cells reading *this cell
    // held that file and it could not be re-opened*. A state the store has
    // since moved past has a render of its own on the way, which is the one
    // that says what the deck is.
    if (!viewStateEquals(this.session.store.state, state)) return
    const deck = this.ensure()
    deck.apply(state, locals)
    // A deck read back from the address does not publish — it *is* what the
    // address says — so the Contact maps card, which lists its maps (§16.9),
    // is told here rather than by `onMapsChange`.
    this.session.syncCompareCard()
    if (!deck.isEmpty) return
    deck.destroy()
    this.grid = null
    // Its models went with it, and their eyes on the Structures card go dark.
    this.session.structureCard?.refresh()
    // The frame has gone with it, so the mounted view has to be put back on its
    // own — back inside the `+` edges, which is where it was before anybody
    // pressed one. Directly rather than through a re-render: the view is intact
    // and re-reading its block to change what it is parented into would make
    // closing the last companion cost a fetch.
    if (this.contentNode !== null) this.session.contentEl.replaceChildren(this.framed(this.contentNode))
  }

  /**
   * What actually goes in the content area: the view, and one frame round it.
   *
   * Exactly one, and which one is the whole of the logic here. A view a
   * companion cannot answer gets neither — a table or an overview is of *this
   * file* and nothing else, so framing one put a genomes table into a sixth of
   * the column beside five rectangles each saying they had nothing to draw
   * (§16.8), and offering a `+` there would offer to open a cell for a picture
   * nothing can fill. A view with a **deck** gets the deck, which grows its own
   * edges round its grid. A view with neither gets the bare edges, so the
   * gesture that builds the first deck is on screen from the first map.
   */
  framed(node: HTMLElement): HTMLElement {
    // Released on both of the paths that leave a frame off screen, because
    // every one of them holds the last view it framed until told otherwise — a
    // *destroyed* view, whose canvas is still a full-resolution backing store.
    // Re-parenting into a frame empties the other for free (a node has one
    // parent); a bare mount does not, so a reader who opens the chromosomes
    // table pins the map they left.
    //
    // Both frames, and that used to be one: the deck was left out, so the whole
    // argument above applied to it and nothing acted on it. A deck holds its
    // lead in `leadCell` and the lead's own heading up in its bar, so the
    // retention was two nodes rather than one — see `PanelDeck.release`, which
    // is why this is a call rather than an inlined `replaceChildren` here.
    const deck = this.grid
    if (!this.possible) {
      this.edges.release()
      deck?.release()
      return node
    }
    if (deck !== null) {
      this.edges.release()
      return deck.frame(node)
    }
    return this.edges.hold(node)
  }

  /**
   * The deck, built if this session has none yet.
   *
   * The build re-frames immediately rather than waiting for the next render,
   * because the two ways a deck comes into existence are a hash that already
   * names companions — where a render is about to happen anyway — and the "add
   * a map" command, where one is not and where a grid that appeared on the next
   * navigation would read as a bug.
   */
  ensure(): PanelDeck {
    if (this.grid !== null) return this.grid
    const deck = new PanelDeck({
      // `replace`, always. Building a deck one file at a time should leave one
      // history entry rather than five that each undo a file — the same rule
      // the colour controls follow, and for the same reason: adding a map to
      // what is on screen is not a navigation away from it.
      onDrawn: () => this.session.contactsBox?.sync(),
      onMapsChange: (maps) => {
        this.session.store.patch({ maps }, { replace: true })
        // The Contact maps card lists the deck's maps, so it follows the list.
        this.session.syncCompareCard()
        // A structure cell can arrive or go after the view was mounted — a g3d
        // dropped, a reconstruction landing, the cell's heading closed — and
        // its card in the Aesthetics column (§25.3) follows the cell, not the
        // view.
        this.session.refreshAesthetics()
      },
      memoryKey: () => this.session.memoryKey(this.session.file?.uri ?? this.session.assembly?.uri ?? ''),
      // The browser as lead is named for its assembly (§25.3); a map for
      // its file, under whatever the reader called it.
      leadName: () =>
        this.session.store.state?.view === 'browser'
          ? this.session.assembly?.name
          : this.session.file === null
            ? undefined
            : this.session.mapLabel(this.session.file.uri),
      // The picker on the first map's heading (§16.3): the session's own
      // sequences, and its own road to one of them — the locus box's, the view
      // as it is on another sequence; from a whole-file map, at bin level.
      leadSequences: () => this.session.contigNames(),
      onLeadSequence: (name) => {
        const state = this.session.store.state
        if (state === null) return
        const {
          region2: _pair,
          focus: _focus,
          regions: _ticked,
          genomes: _genomes,
          locus: _locus,
          level: _level,
          ...rest
        } = state
        this.session.navigate({ ...rest, view: 'region', region: name })
      },
      mapsAllowed: () => this.mapsAllowed,
      // Without the handler: §7.5's controls belong to the lead, and every
      // companion draws what they say without offering a second copy of them.
      derive: () => {
        const state = this.session.store.state
        if (state === null) return undefined
        const { onExpectedChange: _own, arms, ...shared } = this.session.derivePresentation(state)
        if (arms === undefined) return shared
        // The arms go with it (§8.15): the frame is the molecule's — its length
        // and its origin, placed on each companion's block by base pairs — and
        // `ori` is the deck's, since the region every map reads is one. The
        // toggle is each companion's own (`MapPanel.useArms`), as its O/E is.
        const { onChange: _lead, ...frame } = arms
        return { ...shared, arms: frame }
      },
      // The circles the session declares, for the companions to read a window
      // across the origin of the same molecule (§8.15).
      circular: () => this.session.circularStore()?.list() ?? [],
      annotations: (map) => this.session.annotationContext(map),
      /**
       * The star moved, or the map it was on finished reading its tables.
       *
       * Every answer the Analysis column gives is about one file — what a task
       * costs, which sequences its form lists, whether a task applies at all —
       * so a star that has moved invalidates all of them at once. `refresh` is
       * the same call a navigation makes, for the same reason.
       */
      onStarChange: () => {
        this.session.analysis.workspace?.refresh()
        // The File card is the starred map's too, and this is also the call
        // that says its file has opened (`MapPanel.prepareAnalysis`).
        this.session.syncFileCard()
      },
      // A map of the deck opened, moved rung or left: the maps a comparison
      // can be made against have changed under the column (§18.1).
      onPeersChange: () => {
        this.session.analysis.workspace?.refresh()
      },
      // The column's *Map* card is the starred map's (§16.5), so the star
      // moving, or the starred companion's card being built, changes the card
      // that column holds — and the session is what puts cards in it.
      onMapCardChange: () => {
        this.session.refreshAesthetics()
      },
      // The Structures card's eyes say which models the deck draws, so they
      // follow every change to that — a cell's × and a row dropped on a `+`
      // among them, which the card's own eye does not see.
      onStructuresChange: () => {
        this.session.structureCard?.refresh()
      },
      // A tracks cell renamed: the location rows name it (§25.3).
      onCellRenamed: () => this.session.trackCard?.renamed(),
      // A track dropped on an empty cell, loaded onto the tracks cell the deck
      // opened there: the same road a file aimed at a map's edge takes, with
      // the cell's own id as the map (§16.9).
      onTrackFile: (picked, map) => {
        void this.session.addPicked(picked, placementOn('bottom'), map)
      },
      // The two maps of the session's own square, as files a cell can open: a
      // row of the Contact maps card dropped on a cell names one of them.
      leadPicked: () => {
        const file = this.session.file
        return file === null ? null : { uri: file.uri, source: file.source }
      },
      comparePicked: () => {
        const second = this.session.compare.second
        return second === null ? null : { uri: second.uri, source: second.source }
      },
      hiddenPicked: (id) => this.takeHidden(id),
      onMapHidden: (picked) => {
        this.holdHidden(picked)
        this.session.syncCompareCard()
      },
      // The session's own cell hidden or put back (§16.9): the eye on its row
      // of the Contact maps card follows, and the deck's memory has changed
      // under the durable record.
      onLeadShownChange: () => {
        this.session.syncCompareCard()
        this.session.host.sessionChanged(this.session)
      },
      // The *3D structure* card is the starred cell's (§25.3), so the star
      // moving is the column's card changing under it — and the session is
      // what puts a card in that column.
      onStructureStarChange: () => {
        this.session.refreshAesthetics()
      },
      // Through the memoised index rather than `contextOf` directly: this is
      // asked once per block read per panel, and recomputing it over a 154 k
      // contig table is 71 ms of a frame that has a matrix to draw.
      leadNaming: () => {
        const names = this.session.contigNames()
        return names === null ? undefined : NameIndex.for(names).context
      },
      leadLabel: () =>
        this.session.store.state?.view === 'browser' && this.session.assembly !== null
          ? this.session.assembly.name
          : this.session.mapLabel(this.session.file?.uri ?? ''),
      mapLabel: (uri) => this.session.mapLabel(uri),
      onRenameMap: (uri, name) => this.session.renameMap(uri, name),
      onRenameLead: (name) => {
        const uri = this.session.file?.uri
        if (uri !== undefined) this.session.renameMap(uri, name)
      },
      // With its `onChange`, since the column's *Map* card is a companion's
      // own while that companion is starred (§16.5) and the turn has to be on
      // it: the turn is the one setting there that is the deck's rather than
      // the map's, because the lock's rows are separation on a band and
      // position on a square. Still one control on screen — the column holds
      // one card. Without `onAvailable`, which would let a companion whose
      // block has no diagonal un-turn the whole deck: a fact about that one
      // file deciding what every other one is drawn as.
      turn: () => {
        const state = this.session.store.state
        if (state === null) return undefined
        const { onAvailable: _grey, ...shared } = this.session.turnPresentation(state)
        return shared
      },
      binsize: () => this.session.file?.info.binsize ?? undefined,
      // The two directions "fix all …" needs that the deck cannot take itself.
      //
      // A clip written straight onto the lead's panel is one the next render
      // puts back — the lead's view is rebuilt from the *state*, which is where
      // its colour lives — so it goes through the store, exactly as the
      // Aesthetics column's own controls do, and travels in the link with them.
      onLeadScale: (scale) => this.session.store.patch(scale, { replace: true }),
      // And its resolution is the breadcrumb's entry picker from the other end:
      // changing the first map's rung means reopening the file the session *is*.
      // Answers whether it *could*, so the deck can name it in the one line it
      // has for a map with no frame of its own.
      onLeadBinsize: (binsize) => this.session.openAtBinsize(binsize),
      score: () => {
        const state = this.session.store.state
        return state === null ? undefined : this.session.scoreOf(state).id
      },
      // A companion's clip is not a navigation, so nothing on the state road
      // fires for one — and the durable record and the exported workspace are
      // both rebuilt from this session's memory on `sessionChanged`. The same
      // line the annotation store subscribes with, for the same reason.
      onLooksChange: () => this.session.host.sessionChanged(this.session),
      // What a structure cell draws and where its gestures go (§25). The store
      // is asked each time rather than captured: a browser session replaces
      // its annotation machinery when its lengths are, and a cell holding the
      // old store would draw a row nobody can see in the Tracks card.
      structure: {
        store: () => this.session.annotations?.store,
        manual: () => this.session.annotations?.manual,
        client: () => this.session.annotations?.client,
        bookmarks: () => this.session.bookmarkStore ?? undefined,
        // The lead map's own block, read in place: the row through the
        // pinned bead, on the scale the map draws with (§25.5).
        contacts: (from, to) => this.session.current?.panel?.contactsBetween(from, to) ?? null,
        contactsScale: () => this.session.current?.panel?.shownScale() ?? null,
        // What the rest of this column already offers of the shared
        // preferences (§26.3), so the model's card fills the gap rather than
        // doubling a control. A view with a **Map card** offers all three the
        // model reads; the **1D browser** offers the crosshair and the hover
        // card but has no key of its own to hide, so the model's own key
        // toggle is the gap. Read at paint time, not captured, because a
        // session becomes a browser and a browser becomes a map.
        sharedElsewhere: () =>
          this.session.current?.panel?.controlsEl === undefined ? TRACK_OPTIONS : MATRIX_OPTIONS,
        onGoTo: (range) => this.session.goToLocus(formatLocus(range)),
        onDrop: (file) => this.session.dropped(file),
        onDropUrl: (url) => {
          void this.session.addRemote(url, { kind: 'remote', url })
        },
      },
      // What a tracks cell draws from (§25.3): the lead file's own sequences
      // as an assembly — the one `closeMap` would build — and the machinery
      // the session's browser has. The assembly is kept per file, because the
      // cell rebuilds its browser when the assembly object changes and a fresh
      // one per call would rebuild it on every pan.
      tracks: {
        context: () => {
          const held = this.session.annotations
          const file = this.session.file
          if (held === null) return undefined
          // Beside a browser the axis is the browser's own assembly (§25.3);
          // beside a map, the map's sequences, kept per file.
          let assembly: Assembly | null
          if (this.session.store.state?.view === 'browser' || file === null) assembly = this.session.assembly
          else {
            if (this.tracksAssembly === null || this.tracksAssembly.file !== file) {
              const made = this.session.assemblyOfFile(file)
              if (made === null) return undefined
              this.tracksAssembly = { file, assembly: made }
            }
            assembly = this.tracksAssembly.assembly
          }
          if (assembly === null) return undefined
          return {
            assembly,
            store: held.store,
            client: held.client,
            groups: held.groups,
            manual: held.manual,
          }
        },
      },
    })
    this.grid = deck
    // `isConnected`, because the node this holds may be one a render in
    // progress is about to replace — and framing a detached view would put the
    // outgoing picture on screen inside a grid, one frame before the incoming
    // one arrives through `showContent` and does it properly.
    if (this.contentNode !== null && this.contentNode.isConnected && this.possible) {
      this.session.contentEl.replaceChildren(this.framed(this.contentNode))
      this.syncLead(deck)
    }
    return deck
  }

  /** The "add a map" command: open a deck if there is none, and ask for a file. */
  addMap(): void {
    // The command is already disabled where this is false; the guard is for the
    // other door into it — a keyboard shortcut fired before a render has
    // re-read the state (§16, {@link possible}).
    if (this.session.file === null || !this.possible) return
    this.ensure().promptAdd()
  }

  /**
   * The `+` on an edge of the map: draw the deck, or make the one there bigger.
   *
   * The entry point §16.9 exists to provide, and it deliberately opens **cells**
   * rather than maps: what comes back from one press is the arrangement the
   * reader asked for with their own map in the first cell of it, every other
   * cell standing empty and taking a drop. A file arriving with the press — one
   * dropped on the edge rather than a click — goes straight into the first of
   * them, so the impatient gesture and the deliberate one reach the same deck.
   */
  private grow(direction: GrowDirection, picked?: PickedFile): void {
    if (!this.possible) return
    this.ensure().grow(direction, picked)
  }

  /**
   * Whether a second panel would have anything to draw.
   *
   * The deck answers views that name a *place* — a region, a genome, a pair, a
   * selection, the whole file — and there are three that name a **file**
   * instead: the two tables and the whole-metagenome scan. A second file's
   * genomes table is not this file's genomes table with more in it, it is
   * another table, so offering a panel there would be offering to put two
   * unrelated pages side by side. The command is disabled rather than hidden,
   * so the answer to "can this viewer do that" is *yes, from a map*.
   *
   * **And never on a file with a genome layer.** §16 is built on the one thing
   * a deck's panels must share — a coordinate system — and two metagenomes have
   * none: their axes are contigs from two independent assemblies, so a region
   * that names a place in one names nothing in the other, and the lock that
   * moves five maps together would be moving them to five different places. It
   * is the same argument §8.5 makes about a track and `compareRefusal` makes
   * about the lower-left triangle, and it is stronger here because a deck
   * *navigates*: the reader would not be shown a wrong picture once, they would
   * drag one about. So the `+` edges are absent rather than disabled, which is
   * what this predicate decides — see {@link framed}.
   */
  get possible(): boolean {
    if (this.session.file?.info.hasGenomes === true) return false
    const view = this.session.store.state?.view
    // The browser names a place too (§25.3): a deck beside it holds
    // tracks and a structure, drawn against the assembly its axis is. What may
    // *not* join it is a map — {@link mapsAllowed} — since a map beside a
    // browser has no lead to follow.
    if (view === 'browser') return this.session.assembly !== null && this.session.annotations !== null
    return view === 'region' || view === 'genome' || view === 'pair' || view === 'whole' || view === 'selection'
  }

  /** Whether a map may join the deck: only beside a map (§25.3). */
  private get mapsAllowed(): boolean {
    return this.session.file !== null && this.session.store.state?.view !== 'browser'
  }

  /**
   * Tell the deck which lead the session just mounted, in whichever shape.
   *
   * A map's panel drives the lock; the browser drives the cells by loci
   * ({@link PanelDeck.setLeadAxis}). Exactly one of the two, and `null` for
   * the other, so a deck that outlives a navigation from one to the other is
   * not left following the view that went away.
   */
  syncLead(deck: PanelDeck): void {
    const panel = this.session.current?.panel ?? null
    deck.setLead(panel)
    const browser = this.session.browser
    deck.setLeadAxis(
      panel === null && browser !== null && this.session.store.state?.view === 'browser'
        ? {
            windows: () => ({ rows: [], cols: browser.framedWindows() }),
            show: (range) => {
              browser.showLocus(formatLocus(range))
              return true
            },
            figure: () => browser.deckFigure(),
            setDeckExport: (hook) => browser.setDeckExport(hook),
          }
        : null,
    )
  }

  /**
   * The eye on a deck map's row (§16.9). A map in a cell leaves it and is held
   * hidden; a hidden one opens in the deck again — the first empty cell, or a
   * new one — as a Structures row's eye opens its model's cell (§25.3).
   */
  toggleMap(id: string): void {
    if (this.hidden.some((held) => held.id === id)) {
      if (!this.possible) return
      const picked = this.takeHidden(id)
      if (picked !== null) this.ensure().showMap(picked)
    } else {
      const picked = this.grid?.takeMap(id) ?? null
      if (picked !== null) this.holdHidden(picked)
    }
    this.session.syncCompareCard()
  }

  /**
   * Keep a map the reader put down in the deck, hidden, on the Contact maps
   * card (§16.9) — from the eye, or from the × on its cell's own heading.
   *
   * Once per file: a map already held hidden is not listed twice, and one still
   * on screen — in another cell, as the first map, or in its lower triangle —
   * is not listed as hidden at all, since the card already lists it as shown
   * and nothing about it has been lost.
   */
  private holdHidden(picked: PickedFile): void {
    const uri = picked.uri
    const shown =
      this.session.file?.uri === uri ||
      this.session.compare.second?.uri === uri ||
      (this.grid?.companionMaps() ?? []).some((map) => map.uri === uri)
    if (shown || this.hidden.some((held) => held.picked.uri === uri)) return
    this.hidden.push({ id: `hidden-${++this.hiddenCount}`, picked })
  }

  /** Stop holding a hidden map, and hand back what opens it. */
  takeHidden(id: string): PickedFile | null {
    const at = this.hidden.findIndex((held) => held.id === id)
    if (at < 0) return null
    const [held] = this.hidden.splice(at, 1)
    return held?.picked ?? null
  }

  /**
   * Put the deck down and forget the maps hidden from it: the tab holds no
   * file for either to be beside.
   */
  putDown(): void {
    this.grid?.destroy()
    this.grid = null
    this.hidden = []
  }

  /** Everything the deck holds, with the tab: its panels, and its edges as a landing. */
  destroy(): void {
    this.stopEdgeLanding()
    this.grid?.destroy()
    this.grid = null
  }
}
