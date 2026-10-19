/**
 * The commands a session answers: what the palette lists, what a key runs and
 * what the shortcuts dialog prints, for the tab on screen.
 *
 * Every command is rebuilt each time it is asked for, so `enabled`, `state` and
 * the hint say what is true *now* — which file is open, which view is mounted,
 * whether a deck is up, where `<` and `>` would step. That is why this holds
 * nothing: it is a reading of the session in the vocabulary of `ui/commands.ts`,
 * and the shell merges it with its own list (`App.ts`).
 *
 * Separate from `Session` because it is one long reading — a list for a 1D
 * browser and one for a map, four hundred lines between them — and nothing in
 * it is anything but a question asked of the session and a `run` that hands
 * the work back to it.
 */

import { devFeature } from '../state/devFeatures'
import { overviewLevel } from '../state/ViewState'
import { MAX_PANELS, parseMaps } from '../panels/deck'
import { KEYS, type Command } from '../ui/commands'
import { diagonalLocked, toggleDiagonalLock } from '../ui/diagonalLock'
import type { Session } from './Session'

export class SessionCommands {
  constructor(private readonly session: Session) {}

  /** Every command the session answers, in the order a key is matched against them. */
  all(): Command[] {
    // The cells' own, after the session's: a structure cell's keys (§25.3).
    // The marks' switch after both, map or browser alike: an enlarged model
    // binds `a` to the whole model, and the first binding matched is the one a
    // key runs, so it keeps the letter there as it keeps `f`, `l` and `r`.
    return [...this.own(), ...(this.session.deck.grid?.cellCommands() ?? []), this.marks()]
  }

  /**
   * The reader's marks, off and back on (§8.1): `A`, the eye over the Manual
   * annotations card's list from anywhere — on a map, in the 1D browser, over
   * a model. One command in both lists, because the marks are one set drawn by
   * every picture, and a key that hid them beside the map and did nothing in
   * the browser would be saying they were two.
   *
   * A switch, titled by its noun and wearing its state (§26.4); greyed with no
   * mark to hide, as a control with nothing to act on is (§26.3).
   */
  private marks(): Command {
    const manual = this.session.annotations?.manual
    const any = manual !== undefined && manual.marks.length > 0
    return {
      id: 'marks-toggle',
      group: 'View',
      title: 'Manual annotations',
      hint:
        'Every line, arrowhead and rectangle drawn by hand, on every map, track and model. ' +
        'Off hides them; on brings back the ones it hid.',
      keys: KEYS.marks,
      ...(any ? { state: manual.anyShown ? ('on' as const) : ('off' as const) } : {}),
      enabled: any,
      run: () => {
        manual?.toggleAll()
      },
    }
  }

  /**
   * The ideogram (§5.10), `Z`: every chromosome whole, side by side, with the
   * tracks beside each — from the browser, or from a map, which is put down as
   * `v` puts it down. A switch titled by its noun and wearing its state
   * (§26.4); a dev feature (§29), so absent while the switch is off.
   */
  private ideogram(): Command[] {
    if (!devFeature('ideogram')) return []
    const shown = this.session.ideogramShown
    return [
      {
        id: 'ideogram',
        group: 'View',
        title: 'Ideogram',
        hint: shown
          ? 'Back to the tracks along one axis, where the browser was.'
          : 'Every chromosome whole, side by side, with the tracks beside each; a contact map is put down first, as V puts it down.',
        keys: KEYS.ideogram,
        state: shown ? 'on' : 'off',
        enabled: this.session.assembly !== null || this.session.canHideMap,
        run: () => this.session.toggleIdeogram(),
      },
    ]
  }

  private own(): Command[] {
    const state = this.session.store.state
    const file = this.session.file
    const isMetacool = this.session.isMetacool
    const isScool = this.session.isScool
    // A browser session answers a different set: there is no genomes table and
    // no whole-metagenome scan, and the two things it *does* have — a locus and
    // a zoom — have no counterpart on a map. Listing a map's actions beside a
    // browser (greyed out, every one of them) would be a palette that mostly
    // says no.
    // One word for the list `<` and `>` walk, and it is the word §26.4 gives a
    // stretch of DNA in prose: a **sequence**. The two branches used to name it
    // differently — "Previous sequence" here, "Previous genome or contig" on a
    // map — so pressing `v` rewrote half the palette, and on a plain cooler
    // "genome or contig" named neither of the things the key steps through. A
    // genome view is the one place the step really is a genome, and says so.
    const stepNoun = state?.view === 'genome' ? 'genome' : 'sequence'
    const chip = (on: boolean): 'on' | 'off' => (on ? 'on' : 'off')
    const expected = this.session.current?.panel?.expectedLit ?? null
    if (this.session.assembly !== null) {
      return [
        {
          id: 'browser-whole',
          group: 'Go',
          title: 'Whole genome',
          hint: 'Every sequence, end to end. Also the 0 key, and a double click on the tracks.',
          keys: KEYS.whole,
          run: () => this.session.store.patch({ locus: undefined }),
        },
        // `0` is the map's refit, and the browser's whole genome is what a refit
        // is here: the same key in both, so a reader who learnt it on one picture
        // does not find it dead on the other.
        {
          id: 'browser-fit',
          group: 'View',
          title: 'Fit the view',
          hint: 'The whole genome across, as W and a double click on the tracks do.',
          keys: KEYS.fit,
          run: () => this.session.store.patch({ locus: undefined }),
        },
        // The same two keys a map has, walking the same list. They were left out
        // of this branch, which made the browser the one view where the plainest
        // thing anybody does with a genome — look at the next chromosome — had to
        // be typed into the locus box.
        {
          id: 'go-prev',
          group: 'Go',
          title: `Previous ${stepNoun}`,
          hint: this.session.stepTarget(-1) ?? undefined,
          keys: KEYS.previous,
          enabled: this.session.stepTarget(-1) !== null,
          run: () => this.session.step(-1),
        },
        {
          id: 'go-next',
          group: 'Go',
          title: `Next ${stepNoun}`,
          hint: this.session.stepTarget(1) ?? undefined,
          keys: KEYS.next,
          enabled: this.session.stepTarget(1) !== null,
          run: () => this.session.step(1),
        },
        {
          id: 'fit-tracks',
          group: 'View',
          title: 'Stretch the tracks to fill the height',
          hint: 'One height for all of them, and that height the one that fills the space.',
          // `s` for stretch, which is what the button does and what a reader
          // calls it. It cost `s` its old meaning — autoscale, which is now `y`,
          // the axis it acts on — and that trade is the right way round: this is
          // the one a reader reaches for several times a session, while
          // autoscale is a repair for a bound typed into the wrong box.
          keys: KEYS.stretch,
          run: () => this.session.browser?.fitTracks(),
        },
        {
          id: 'shrink-tracks',
          group: 'View',
          title: 'Shrink the tracks to the shortest of them',
          // No key of its own. Stretch is the one a reader reaches for several
          // times a session; this is its way back, and a second letter for it
          // would be a letter spent on the rarer half of a pair.
          hint: 'One height for all of them, and that height the smallest one on screen.',
          run: () => this.session.browser?.shrinkTracks(),
        },
        {
          id: 'browser-export',
          group: 'File',
          title: 'Save this plot as a figure',
          hint: 'The Export card decides the format and the resolution; this is its button.',
          keys: KEYS.savePlot,
          run: () => this.session.browser?.savePlot(),
        },
        {
          id: 'browser-copy',
          group: 'File',
          title: 'Copy this plot to the clipboard',
          hint:
            'The figure as a PNG, at the Export card\'s resolution, ready to paste — though with text ' +
            'selected the same key still copies the text.',
          keys: KEYS.copyPlot,
          yieldsToText: true,
          run: () => this.session.browser?.copyPlot(),
        },
        {
          id: 'browser-autoscale',
          group: 'View',
          title: 'Autoscale every track',
          hint: 'Hand every value axis back to what is in view; a group resolves as a group.',
          keys: KEYS.autoscale,
          run: () => this.session.browser?.autoscaleAll(),
        },
        {
          id: 'browser-search',
          group: 'Go',
          // *Find*, as on a map, because it is the same key over the same one
          // box; what the box takes here is the hint's business and differs by
          // view, which is why the hint is written per view and the title is
          // not.
          title: 'Find',
          // One command, because there is one box. It used to be two — `/` to
          // find and `l` to go — over the same field, and `l` was also the
          // labels overlay: in a browser session the overlay could not be
          // toggled at all, because the command list is searched in order and
          // this half of it comes first. Two names for one box is not worth a
          // key that silently does nothing somewhere else.
          hint:
            'One box takes all three: chrI:1,000-20,000, a sequence name, or a gene name from ' +
            'the starred model.',
          keys: KEYS.find,
          run: () => this.session.browser?.focusSearch(),
        },
        ...this.ideogram(),
        {
          id: 'show-map',
          group: 'View',
          title: 'The contact map on its own',
          hint:
            'The map was never unloaded — this is the same picture, where it was left, with the ' +
            'tracks put away. The same key brings them back.',
          keys: KEYS.mapToggle,
          enabled: this.session.canShowMap,
          run: () => this.session.cycleView(),
        },
        {
          id: 'browser-map',
          group: 'File',
          title: 'Open a contact map on this genome',
          // Still here, and not the same command as the one above it: this
          // browser may have no map behind it at all, in which case opening one
          // is the only way to get one.
          hint: 'Or drop a .cool anywhere on the tracks; the tracks come with it.',
          run: () => this.session.host.openFileDialog(this.session),
        },
      ]
    }
    return [
      {
        id: 'find',
        group: 'Go',
        title: 'Find',
        // Every view of a map has exactly one box you type a name into — the
        // region box on a heatmap, the search field above a table — and `/` is
        // where a reader's hand goes to reach it. It used to be the browser's
        // alone, so the same key that found a gene one moment did nothing at all
        // the moment a `.cool` was dropped on the same tab.
        hint: this.searchNoun(),
        keys: KEYS.find,
        enabled: this.session.current?.focusSearch !== undefined,
        run: () => this.session.current?.focusSearch?.(),
      },
      {
        id: 'add-map',
        group: 'File',
        title: 'Add a map beside this one',
        // One line, and no section number: a reader who could follow "(§16)"
        // would be reading SPECS, and this app never links it. What the deck's
        // side-by-side claim is weaker *than* is argued in §16 and in
        // `panels/PanelDeck.ts`, which is where an argument belongs.
        hint: 'Another file, in a panel of its own, moving with this one.',
        enabled:
          file !== null && parseMaps(state?.maps).length + 1 < MAX_PANELS && this.session.deck.possible,
        run: () => this.session.deck.addMap(),
      },
      // The stage that edits the reference (§27.3), a dev feature (§29): absent,
      // not greyed, while the switch is off.
      ...(devFeature('edit') && file !== null
        ? [
            {
              id: 'edit-reference',
              group: 'View',
              // On a metagenome, one genome at a time (§27.10).
              title: isMetacool ? (this.session.genomeInView() === undefined ? 'Edit a genome' : `Edit genome ${this.session.genomeInView()}`) : 'Edit the reference',
              hint: isMetacool
                ? 'One genome of the metagenome: its contigs scaffolded, turned, split, or sent to another genome, with the map redrawn as you go.'
                : 'Cut, turn, move, copy and join stretches of the assembly, with the map redrawn as you go.',
              enabled: this.session.reader !== null && this.session.editStage === null,
              run: () => void this.session.openEditStage(),
            },
          ]
        : []),
      {
        id: 'hide-map',
        group: 'View',
        title: this.session.mapOnly ? 'The map and its tracks' : 'Read this genome as tracks',
        hint: this.session.mapOnly
          ? 'Puts the tracks back beside the map — nothing was hidden while they were away.'
          : 'Takes the matrix out of the picture and lays its chromosomes end to end; the map ' +
            'stays open, and the same key comes back to it.',
        keys: KEYS.mapToggle,
        enabled: this.session.canHideMap,
        run: () => this.session.cycleView(),
      },
      ...this.ideogram(),
      {
        id: 'map-export',
        group: 'File',
        title: 'Save this plot as a figure',
        hint: 'The Export card decides the format and the resolution; this is its button.',
        keys: KEYS.savePlot,
        enabled: this.session.current?.panel !== undefined,
        run: () => this.session.current?.panel?.savePlot(),
      },
      {
        id: 'map-copy',
        group: 'File',
        // The key means "copy the figure", and with a deck up the figure is the
        // deck: six maps are on screen because the reader arranged six, and
        // handing back the first cell of the arrangement is answering a question
        // they did not ask. One command rather than two, because there is only
        // ever one picture in front of them — see `PanelDeck.copyDeck`.
        title: this.session.deck.grid === null ? 'Copy this plot to the clipboard' : 'Copy the deck to the clipboard',
        hint:
          this.session.deck.grid === null
            ? 'The figure as a PNG, at the Export card\'s resolution, ready to paste — though with text ' +
              'selected the same key still copies the text.'
            : 'Every panel as one PNG, laid out as it is on screen, ready to paste — though with text ' +
              'selected the same key still copies the text.',
        keys: KEYS.copyPlot,
        yieldsToText: true,
        enabled: this.session.current?.panel !== undefined || this.session.deck.grid !== null,
        run: () => {
          const deck = this.session.deck.grid
          if (deck !== null) void deck.copyDeck()
          else this.session.current?.panel?.copyPlot()
        },
      },
      {
        id: 'fit-tracks',
        group: 'View',
        title: 'Stretch the tracks to fill the height',
        // The same key as in the browser, and for the same reason the autoscale
        // below it shares one: the lanes beside a map and the stack under a
        // browser are one set of tracks, and a key that stopped working the
        // moment a `.cool` was dropped would be saying otherwise.
        hint: 'One height for every lane on both edges, sharing the room the map leaves.',
        keys: KEYS.stretch,
        enabled: this.session.current?.panel !== undefined && this.session.annotations !== null,
        run: () => this.session.current?.panel?.fitTracks(),
      },
      {
        id: 'shrink-tracks',
        group: 'View',
        title: 'Shrink the tracks to the shortest of them',
        hint: 'One height for every lane on both edges, and that height the smallest on screen.',
        enabled: this.session.current?.panel !== undefined && this.session.annotations !== null,
        run: () => this.session.current?.panel?.shrinkTracks(),
      },
      {
        id: 'map-autoscale',
        group: 'View',
        title: 'Autoscale every track',
        // The same key as in the browser, because it is the same act on the same
        // tracks: the lanes beside a map and the stack under a browser are one
        // store, and a key that worked in one of the two would be a key that
        // stopped working when a `.cool` was dropped.
        hint: 'Hand every value axis back to what is in view; a group resolves as a group.',
        keys: KEYS.autoscale,
        enabled: this.session.current?.panel !== undefined && this.session.annotations !== null,
        run: () => this.session.current?.panel?.autoscaleTracks(),
      },
      {
        id: 'map-diagonal',
        group: 'View',
        // A switch, titled by its noun and wearing its state (§26.4). Every map's,
        // as a deck's windows move together (`ui/diagonalLock.ts`).
        title: 'Diagonal lock',
        hint:
          'The view slid onto the diagonal and held there — every drag, scroll and box runs along ' +
          'it — until the same key lets go; a focused button or tickbox keeps Space for itself.',
        keys: KEYS.diagonal,
        yieldsToControls: true,
        state: chip(diagonalLocked()),
        // Live wherever there is a diagonal to hold, and wherever the lock is on,
        // so it can always be let go of.
        enabled: this.session.current?.panel?.canCentreOnDiagonal === true || diagonalLocked(),
        run: () => void toggleDiagonalLock(),
      },
      {
        id: 'map-fit',
        group: 'View',
        title: 'Fit the view',
        // The first map's, which in a deck is every map's, as Space's is.
        hint: 'Every pan and zoom undone, the block back to its canvas — as a double click on the plot does.',
        keys: KEYS.fit,
        enabled: this.session.current?.panel !== undefined,
        run: () => this.session.current?.panel?.fit(),
      },
      {
        id: 'map-expected',
        group: 'View',
        title: 'Observed over expected',
        // The lead's toggle, the one on the Map card: a companion of a deck keeps
        // an O/E of its own (§16.2), on its own card.
        hint: 'Every cell divided by what its distance from the diagonal predicts — the O/E toggle on the Map card.',
        keys: KEYS.expected,
        ...(expected === null ? {} : { state: chip(expected) }),
        enabled: this.session.current?.panel?.canToggleExpected === true,
        run: () => this.session.current?.panel?.toggleExpected(),
      },
      // The resolution bar's stops, one at a time (§3.4): the lead's rung, which
      // in a deck every map follows, exactly as a press on a stop would. The
      // hint names the rung it goes to, as `<` and `>` name the sequence.
      {
        id: 'resolution-coarser',
        group: 'View',
        title: 'Coarser resolution',
        hint: this.session.rungHint(1),
        keys: KEYS.coarser,
        enabled: this.session.rungStep(1) !== null,
        run: () => this.session.stepRung(1),
      },
      {
        id: 'resolution-finer',
        group: 'View',
        title: 'Finer resolution',
        hint: this.session.rungHint(-1),
        keys: KEYS.finer,
        enabled: this.session.rungStep(-1) !== null,
        run: () => this.session.stepRung(-1),
      },
      // One command and one key for the file's own landing table, whichever
      // of the two it is: a metacool's genomes, or an scool's cells. No file
      // has both, so a second entry would be a second key that is disabled on
      // every file the first one works on. While the multi-genome format is a
      // dev feature that is off (§29), it is the Cells table or nothing: a
      // greyed *Genomes table* in the palette of every tab would be the one
      // place a reader was told the format exists.
      ...(isScool || devFeature('metacool')
        ? [
            {
              id: 'go-genomes',
              group: 'Go',
              title: isScool ? 'Cells table' : 'Genomes table',
              keys: KEYS.genomes,
              enabled: file !== null && (isMetacool || isScool),
              run: () => {
                if (state !== null) {
                  this.session.navigate({ uri: state.uri, view: isScool ? 'cells' : 'genomes' })
                }
              },
            },
          ]
        : []),
      {
        id: 'go-contigs',
        group: 'Go',
        // The file's own word for its own table, which is the one surface §26.4
        // keeps the file-kind noun for: the crumb over a cooler says
        // *Chromosomes* and its tooltip *Back to Chromosomes (C)*, so a
        // shortcuts dialog printing "C  Contigs table" named a table that
        // screen does not have. The command above it already switches its title
        // per file kind for the same reason.
        title: isMetacool ? 'Contigs table' : 'Chromosomes table',
        keys: KEYS.contigs,
        enabled: file !== null,
        run: () => {
          if (state !== null) this.session.navigate({ uri: state.uri, view: 'contigs' })
        },
      },
      {
        id: 'go-overview',
        group: 'Go',
        // One question — the whole file at once — answered two ways, exactly as
        // the root menu offers it: a metacool scans every pixel to build the
        // genome x genome matrix, a cooler reads its single matrix in one
        // bounded block (§9). Binding the key to only the first left `w` dead on
        // every cool file, beside a `C` that worked.
        title: isMetacool ? 'Whole metagenome' : 'Whole genome',
        hint: isMetacool
          ? 'Costs a full pixel scan; it never starts on its own.'
          : 'One bounded read: it asks first when the block is large, and is refused if it would not fit this machine.',
        keys: KEYS.whole,
        enabled: file !== null,
        run: () => {
          if (state !== null) {
            this.session.navigate({ uri: state.uri, view: isMetacool ? 'overview' : 'whole' })
          }
        },
      },
      {
        id: 'go-prev',
        group: 'Go',
        title: `Previous ${stepNoun}`,
        hint: this.session.stepTarget(-1) ?? undefined,
        keys: KEYS.previous,
        enabled: this.session.stepTarget(-1) !== null,
        run: () => this.session.step(-1),
      },
      {
        id: 'go-next',
        group: 'Go',
        title: `Next ${stepNoun}`,
        hint: this.session.stepTarget(1) ?? undefined,
        keys: KEYS.next,
        enabled: this.session.stepTarget(1) !== null,
        run: () => this.session.step(1),
      },
      // The button beside `go`, and the card's own *save this view*: one act,
      // which answers on the card — a row, or the reason there is none.
      {
        id: 'bookmark-view',
        group: 'Go',
        title: 'Bookmark this view',
        hint: 'The place on screen, at this resolution, kept on the Bookmarks card.',
        keys: KEYS.bookmark,
        enabled: this.session.bookmarksCard !== null && this.session.current?.panel !== undefined,
        run: () => this.session.bookmarksCard?.saveFramed(),
      },
    ]
  }

  /**
   * What `/` reaches, in the view that is mounted.
   *
   * Written per view rather than as one sentence covering all of them, because
   * the boxes genuinely differ: a table's filters the rows in front of you, a
   * heatmap's opens something else. A palette entry that said "the search box"
   * would be true and useless.
   */
  private searchNoun(): string {
    const state = this.session.store.state
    const view = state?.view
    if (view === 'genomes' || view === 'contigs') return 'The filter above the table.'
    // A gene model beside the map makes the box a *third* thing, and one worth
    // saying: a whole-genome view is three pixels per chromosome arm, so
    // "go to MYC" is a question only typing can ask there.
    const genes = this.session.annotations?.store.searchSource() !== null && this.session.annotations !== null
    if (view === 'region') {
      return genes
        ? 'The region box, which is also this view’s title — a contig, a range, or a gene name.'
        : 'The region box, which is also this view’s title.'
    }
    // Two boxes wear the same view kind: the scan's takes a genome, and the
    // `bin × bin` level is `WholeView`, whose box takes a contig and a range in
    // one. Told apart by the level, which is what the shell routes on.
    if (view === 'overview' && state !== null && overviewLevel(state) !== 'bin') {
      return 'Name a genome of this file, or one of its contigs.'
    }
    return genes
      ? 'Name a contig, a range within one, or a gene from the starred model.'
      : 'Name a contig, or a range within one, and open it.'
  }
}
