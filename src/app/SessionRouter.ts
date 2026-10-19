/**
 * Routing: what a view state means for the session it arrives in (§5.5).
 *
 * Every change to the store, and every door that wants the screen rebuilt,
 * ends here, and the answer is a switch over `ViewState.view` with the cases a
 * state can need first: no file at all, a genome browsed as tracks, a map put
 * down behind the browser, a file still to open, a view this file cannot
 * answer and so another it can, a second file and a deck to reconcile, and a
 * change that only repaints. There is no route table and no router library,
 * because the whole navigable surface is ten view kinds and one URL hash.
 *
 * Separate from `Session` because it is the one method every navigation runs
 * through, and it reads best whole and on its own. It holds nothing but what a
 * render needs for itself — the marker for a mount in progress, and the latch
 * on a grant being asked for. What the session *is* — the file, the mounted
 * view, the reader — stays the session's, read and written through it; and so
 * does the half of the cancellation contract the mounts keep
 * (`Session.rendering`, `Session.stale`), because the mounts are the session's
 * too.
 *
 * `render` is reached through `Session.render` and never directly, and every
 * step it takes — reconciling the deck, the cells, the contacts, each mount —
 * is called through the session rather than lifted out of it: the DOM tests
 * replace those on the session instance, and a step taken anywhere else would
 * step round their stand-ins.
 */

import { el } from '../ui/dom'
import { begin } from '../perf/rendered'
import {
  differsOnlyInFocus,
  differsOnlyInPresentation,
  differsOnlyInPresentationOrScore,
  matrixLevel,
} from '../state/ViewState'
import type { ViewState } from '../types'
import type { SourceSpec } from '../worker/protocol'
import { inferSource, resolveSource } from './resolve'
import type { Session } from './Session'

export class SessionRouter {
  /**
   * The state whose view a render began to mount and has not finished.
   *
   * `mounted` is written before the mount, because the mount reads it, so it
   * cannot say whether the view on screen was built for it. While this is set
   * the repaint shortcuts in `render` are not taken: a colour change arriving
   * while a region still waits on its contigs table repainted the *outgoing*
   * view, called itself mounted, and the region's own mount — superseded —
   * never drew. The newer render mounts in full instead, and clears this once a
   * mount has finished as the newest.
   */
  private mounting: ViewState | null = null
  /**
   * The URI a *resolve* is in flight for, which is one step earlier than
   * {@link Session.opening}.
   *
   * Asking whether this browser still holds a grant for a local file is
   * asynchronous, and the question is asked from inside `render` — between the
   * `opening` guard and the call it protects. Without a latch of its own, two
   * renders both pass that guard, both resolve, and both open: two workers, two
   * h5wasm instances, and every panel's memory budget halved, with nothing
   * thrown and nothing logged.
   *
   * Mirrors `opening` rather than reusing it, because the two mean different
   * things to everything else that reads them — a session that is *resolving* is
   * not yet opening anything and must not be described as busy with a file.
   */
  private resolving: string | null = null

  constructor(private readonly session: Session) {}

  /**
   * Bring the screen in line with `state`: the picker, the 1D browser, a file
   * to open, a redirect, or the view the state names, mounted or repainted.
   *
   * Reached through {@link Session.render} alone — every change to the store,
   * and the doors that rebuild a view on purpose.
   *
   * Counted as a wait for the picture it ends in (`perf/rendered.ts`): until it
   * returns, the view it routes to may not even have been built, and nothing
   * on screen can say it is still to come.
   */
  async render(state: ViewState | null): Promise<void> {
    const end = begin()
    try {
      await this.route(state)
    } finally {
      end()
    }
  }

  /** What {@link render} does. */
  private async route(state: ViewState | null): Promise<void> {
    if (this.session.destroyed) return
    this.session.rendering.abort()
    const run = new AbortController()
    this.session.rendering = run
    const signal = run.signal
    this.session.painted = true
    this.session.host.sessionChanged(this.session)
    // What this session said is about the file it had open, and a state naming
    // another, or none, takes it down — before anything below opens the next
    // file and has something of its own to say about it (§5.6).
    this.session.unsay(state?.uri)

    if (state === null) {
      this.session.file = null
      this.session.assembly = null
      this.session.assemblySource = null
      this.session.mounted = null
      this.session.breadcrumb = null
      this.session.breadcrumbHost.replaceChildren()
      // The annotation worker belongs to the open file, and there is no longer
      // one. Its cache is megabytes of parsed features; leaving it running would
      // hold them until the tab closed.
      this.session.annotations?.client.destroy()
      this.session.annotations = null
    this.session.knownStructures = null
      this.session.manualCard = null
      this.session.metadataCard = null
      this.session.bookmarksCard = null
      // Destroyed rather than dropped: it holds a `ResizeObserver` and a
      // text-scale subscription, and `setGeneral([])` below replaces the column
      // without telling anything in it that it is going.
      this.session.minimap?.destroy()
      this.session.minimap = null
      // The second file too, and for the same reason: it is a second map *of a
      // file that is no longer open*, and with no state there is no `uri2` left
      // to reconcile against — so nothing downstream would ever reach it again,
      // and its worker would sit on an h5wasm instance and an open handle for as
      // long as this tab stayed on the picker. Every other teardown here already
      // released it; this was the one that did not.
      this.session.compare.drop()
      this.session.compareCard = null
      // …and every companion panel, each of which is another worker on another
      // file of the same shape. A deck is a picture *beside* this session's
      // file, and there is no longer one for it to be beside — nor for a map
      // hidden from it.
      this.session.deck.putDown()
      // For the same reason, and it is the one view the session holds: a cached
      // whole-file matrix is a picture of a file nobody can now navigate to,
      // and the scan that produced it may still be running.
      this.session.wholeFile?.view.destroy()
      this.session.wholeFile = null
      this.session.setGeneral([])
      // The cards described a file that is no longer open, and they hold the
      // stores that were just destroyed. Cleared with the column, so returning
      // to the picker does not leave three dropzones wired to nothing.
      this.session.setAnnotations([])
      this.session.showContent(this.session.picker.el)
      this.session.warmReader()
      return
    }

    // The browser branch comes first, because it is the one shape of session
    // that has no `file` at all — falling through to the check below would
    // re-open the assembly's source file on every navigation inside it.
    if (state.view === 'browser') {
      if (this.session.assembly?.uri === state.uri) {
        this.session.breadcrumb?.render(state)
        this.session.breadcrumbHost.replaceChildren(this.session.breadcrumb?.el ?? el('div'))
        this.session.mounted = state
        if (this.session.browser === null) this.session.mountBrowser(state)
        else {
          // The ideogram first (§5.10): a click on a chromosome puts it away and
          // names the window in one step, and the window is the browser's own.
          this.session.browser.applyIdeogram(state.ideogram)
          this.session.browser.applyLocus(state.locus)
        }
        this.session.host.activity(this.session)
        return
      }
      // The map this session is already holding, asked for as tracks. The Back
      // button reaches this — hiding the map pushes a `view=browser` entry, so
      // going forward to it again arrives here — and so does a shared link. Put
      // the map down rather than closing and re-opening the file, which is both
      // slower and lossy.
      if (this.session.file?.uri === state.uri && this.session.canHideMap) {
        // …as the ideogram, where that is what was asked for (§5.10).
        this.session.hideMap(state.ideogram)
        return
      }
      if (this.session.opening !== null || this.resolving !== null) return
      const source = await this.sourceFor(state.uri)
      if (this.session.stale(state, signal)) return
      if (source === null) {
        this.session.showContent(this.session.pickerWithNote(state.uri))
        return
      }
      await this.session.openGenome(state.uri, source, state.locus, true)
      return
    }

    // A genome's own sequence list (§5.8): the Chromosomes table with no map
    // behind it. Before the file check below, which would otherwise read a
    // genome's address as a map to open.
    if (state.view === 'contigs' && this.session.file === null && this.session.assembly?.uri === state.uri) {
      this.session.breadcrumb?.render(state)
      this.session.breadcrumbHost.replaceChildren(this.session.breadcrumb?.el ?? el('div'))
      this.session.mounted = state
      this.session.mountAssemblyContigs(state)
      this.session.host.activity(this.session)
      return
    }

    // …and the way back. A parked map has an assembly *and* a file, so any
    // state that is not the browser's is the map being asked for again — by the
    // Back button, or by a card that navigated. Unpark before anything below
    // reads `assembly` and concludes this is still a browser.
    if (this.session.parkedMap !== null && this.session.file?.uri === state.uri) {
      this.session.parkedMap = null
      this.session.assembly = null
      this.session.browser = null
      this.session.annotations?.store.turnAxesForBrowser()
      // The same live-card rebuild {@link Session.showMap} does, for the other
      // door back.
      this.session.paintSequences()
      this.session.setGeneral(this.session.infoPanel === null ? [] : [this.session.infoPanel.el])
      this.session.syncCompareCard()
      this.session.mounted = null
      this.session.host.sessionChanged(this.session)
    }

    if (this.session.file === null || this.session.file.uri !== state.uri) {
      if (this.session.opening !== null || this.resolving !== null) return
      const source = await this.sourceFor(state.uri)
      if (this.session.stale(state, signal)) return
      if (source === null) {
        this.session.showContent(this.session.pickerWithNote(state.uri))
        // Asking for a map's file: the reader starts while it is found.
        this.session.warmReader()
        return
      }
      await this.session.open(state.uri, source)
      return
    }

    // A cooler has no genome layer (§9), and `genomes` is both the parse
    // default for a hash with no `view=` and the fallback of every incomplete
    // view below. Rewriting it here — rather than at each of those sites —
    // covers the shared link, the hand-edited hash and the three redirects at
    // once, and leaves nobody on an empty table with no way off it.
    // A link can carry `balance=true` to a file with no weight column; every
    // read would then be refused for a reason the recipient did not choose.
    if (state.balance === true && !this.session.file.info.hasWeights) {
      this.session.navigate({ ...state, balance: undefined }, { replace: true })
      return
    }

    if (state.view === 'genomes' && !this.session.file.info.hasGenomes) {
      // An scool's landing table is its cells, and `genomes` is the default a
      // hash with no `view` in it parses to — so without this, dropping one or
      // following a bare link to one arrived on Chromosomes, past the table the
      // file exists to offer. A cooler has no such table and keeps going to
      // its chromosomes, which is the case this redirect was written for.
      const instead = this.session.isScool ? 'cells' : 'contigs'
      this.session.navigate({ ...state, view: instead }, { replace: true })
      return
    }

    // The mirror, for a link that names a cells table on a file that has none.
    // Every other container answers `cells` with an empty view and no way off
    // it, which is the failure this whole block exists to prevent.
    if (state.view === 'cells' && !this.session.isScool) {
      this.session.navigate(
        { uri: state.uri, view: this.session.file.info.hasGenomes ? 'genomes' : 'contigs' },
        { replace: true },
      )
      return
    }

    // The same rewrite for the other view a cooler cannot answer. `overview`
    // scans for a genome × genome matrix, and a file with no genome layer has
    // none — but it does have the other half of the same menu entry, the whole
    // map in one bounded read, which is what "Whole genome" means there.
    if (state.view === 'overview' && !this.session.file.info.hasGenomes) {
      this.session.navigate({ uri: state.uri, view: 'whole' }, { replace: true })
      return
    }

    // And the last of them: a link that names a genome on a file with no genome
    // layer — the genome view, the pair view, or a region or a selection that
    // carries one. None can be answered by a cooler, and each ended on a
    // refusal about genomes: a sentence about a format the file is not, and,
    // while that format is a dev feature that is off (§29), about one this
    // page does not read. A view of genomes lands on the file's chromosomes; a
    // view that merely carries a genome name is the same view without it.
    if (!this.session.file.info.hasGenomes) {
      if (state.view === 'genome' || state.view === 'pair') {
        this.session.navigate({ uri: state.uri, view: 'contigs' }, { replace: true })
        return
      }
      if (state.genome !== undefined || state.genome2 !== undefined || state.genomes !== undefined) {
        const next: ViewState = { ...state }
        delete next.genome
        delete next.genome2
        delete next.genomes
        this.session.navigate(
          next.view === 'selection' && next.regions === undefined ? { uri: state.uri, view: 'contigs' } : next,
          { replace: true },
        )
        return
      }
    }

    // …and the mirror of it. A metagenome's whole-file map is the `bin` level of
    // `overview` rather than a view kind of its own (§7.3), so a link naming the
    // cooler's kind lands on the one this file has, at the level it asked for —
    // `matrixLevel` because that is what `whole` would have drawn. Without this
    // the picker in the sidebar there would patch a level nothing routes on.
    if (state.view === 'whole' && this.session.isMetacool) {
      this.session.navigate({ ...state, view: 'overview', level: matrixLevel(state) }, { replace: true })
      return
    }

    // A link may carry a second file (`uri2`), and the tab may already hold one
    // — or the wrong one. Reconciled here rather than at the drop, so a pasted
    // comparison and a dropped one arrive by the same road.
    //
    // The mount below is *not* deferred until the second file has opened: the
    // first file's map is a complete picture on its own, and showing it while
    // the second is read is better than showing nothing. `remount` brings the
    // comparison in when it lands.
    if (this.session.compare.reconcile(state)) return

    // …and the same reconciliation for the deck (§16), one line lower because
    // it is the same question asked of N files rather than of one: the hash
    // names the companions, and this is where a pasted link, a restored tab and
    // a panel opened by hand all arrive. Before the repaint short-circuit
    // below, because a deck follows the *view* and a colour-only change is
    // still a view its panels have to be handed — a link that pins `vmax` and
    // nothing else must not leave four maps unreconciled.
    await this.session.syncDeck(state)
    // Nothing below may act on the view for a render that has been overtaken
    // while the deck was reconciled: the newer one reconciles again and paints.
    if (this.session.stale(state, signal)) return

    // A colour change is a repaint, not a navigation.
    //
    // Every control in the colour card patches the view state so the URL stays
    // shareable, and the store notifies for it like any other change. Without
    // this branch that notification fell straight through to the `switch`
    // below, which builds a *new* view whose constructor re-reads the matrix
    // from the worker — so nudging a clip bound ten times cost thirty worker
    // round trips, ten matrix re-reads and ten full DOM rebuilds, for a picture
    // whose data never changed.
    //
    // `applyScale` rather than "do nothing": the change does not always come
    // from the panel. A pasted link or the back button moves the *hash* first,
    // and the mounted panel has to follow it.
    //
    // A *derivation* (§7.5) takes the same road for the same reason and one
    // more: it is arithmetic over cells already in memory, so rebuilding to
    // apply it would pay a worker round trip for nothing — and on a gated
    // whole-genome map it would put the scan back behind its button.
    //
    // **So is a score that reads the same cells.** `VC`, `ICE`, the baseline and
    // the correlation are arithmetic over the block in memory exactly as the O/E
    // is, and picking one rebuilt the view and read the whole block again — two
    // seconds of a 4,096-bin square spent before the correlation could start, to
    // fetch the numbers already on screen. Only a change of the column read, or
    // of the balancing *in force*, is a new read — `balance=1` written away on a
    // file balanced by default is the same one; the picker is pointed at the
    // choice, which a link or the back button can make as well as the picker.
    const scoreOnly =
      this.mounting === null &&
      this.session.mounted !== null &&
      this.session.current?.panel !== undefined &&
      differsOnlyInPresentationOrScore(this.session.mounted, state) &&
      this.session.valueOf(this.session.mounted) === this.session.valueOf(state) &&
      this.session.balanceOf(this.session.mounted) === this.session.balanceOf(state)
    if (
      this.mounting === null &&
      this.session.mounted !== null &&
      this.session.current !== null &&
      (differsOnlyInPresentation(this.session.mounted, state) || scoreOnly)
    ) {
      this.session.current.applyScale?.(this.session.scaleOf(state))
      if (scoreOnly) this.session.current.panel?.syncScoreChoice(this.session.scoreOf(state).id)
      this.session.rederive()
      // …and stand back on the saved place, if the view is at one. Turning a map
      // re-cuts it and therefore refits it — which the reader asked for, and which
      // on a focused view meant pressing the turn toggle at a bookmark threw you
      // back to the whole chromosome. `rederive` is synchronous, so the place is
      // restored in the same frame as the shape and nothing flashes.
      this.session.current.showFocus?.(state.focus)
      this.session.mounted = state
      this.session.breadcrumb?.render(state)
      this.session.host.activity(this.session)
      return
    }

    // Going to a second saved place on the same chromosome is a *zoom*, not a
    // navigation (§8.10). The block on screen already covers it — that is what
    // `focus` means, a window over a region read whole — so rebuilding the view
    // would pay a worker round trip and a re-read of the picture already in front
    // of the reader, for a change of transform. Walking a BED of forty peaks made
    // that forty reads of one chromosome.
    //
    // Guarded on `showFocus` rather than on the view kind, so a view that has no
    // diagonal to stand a locus on falls through to the rebuild and lands
    // wherever the hash actually says.
    if (
      this.mounting === null &&
      this.session.mounted !== null &&
      this.session.current?.showFocus !== undefined &&
      differsOnlyInFocus(this.session.mounted, state)
    ) {
      this.session.current.showFocus(state.focus)
      this.session.mounted = state
      this.session.breadcrumb?.render(state)
      this.session.host.activity(this.session)
      return
    }

    this.session.breadcrumb?.render(state)
    this.session.breadcrumbHost.replaceChildren(this.session.breadcrumb?.el ?? el('div'))
    // Before the view mounts, because the view is what issues the reads and a
    // block drawn from the previous set would be a picture of the wrong cells.
    await this.session.syncCells(state)
    if (this.session.stale(state, signal)) return
    // …and the total the maps are drawn to (§6.5), for the same reason. Told,
    // not awaited: the view's reads queue behind the census in the worker, under
    // the view's own veil, and the answer arrives for the box and the captions.
    this.session.syncContacts(state)
    this.session.mounted = state
    this.mounting = state

    switch (state.view) {
      case 'genomes':
        this.session.mountGenomes(state)
        break
      case 'cells':
        await this.session.mountCells(state)
        break
      case 'contigs':
        await this.session.mountContigs(state)
        break
      case 'genome':
        this.session.mountGenome(state)
        break
      case 'pair':
        this.session.mountPair(state)
        break
      case 'region':
        await this.session.mountRegion(state)
        break
      case 'whole':
        this.session.mountWhole(state)
        break
      case 'overview':
        this.session.mountOverview(state)
        break
      case 'selection':
        await this.session.mountSelection(state)
        break
      default:
        // Every view the address can name has a case above, and `satisfies`
        // keeps the compiler holding the list to that. What reaches here came
        // by another road — a stored workspace, a share link, a `?config=` file —
        // naming a view this build does not have; it matched nothing and left the
        // tab on "Opening…" for ever. It lands on the file's first table instead.
        void (state.view satisfies never)
        this.mounting = null
        this.session.navigate(
          { uri: state.uri, view: this.session.file.info.hasGenomes ? 'genomes' : 'contigs' },
          { replace: true },
        )
        return
    }
    // A mount overtaken while it awaited leaves the marker up, so the newer
    // render mounts in full rather than repainting a view nobody finished.
    if (this.session.stale(state, signal)) return
    this.mounting = null
    // After the switch, not before: a region view reads the contigs table on the
    // way in, and there is no row to show until it has arrived.
    this.session.infoPanel?.setRecords(this.session.recordsFor(state))
    // …and for the same reason, since the ticks are read against that table: a
    // link straight to a region arrives before anything has opened one.
    this.session.syncSequenceTicks(state)
    this.session.paintLevel(state)
    // Here rather than beside the mount, because a *pan* mounts nothing: the
    // browser reports its window into the store (`onLocusChange`), which comes
    // back through this same path, so this is the one place a jump and a drag
    // are both visible.
    this.session.syncMinimap(state)
    this.session.host.activity(this.session)
  }

  /**
   * The bytes for a URI that arrived in a view state, or `null` for the picker.
   *
   * The one place `render` asks. A remote URL is answered synchronously and
   * costs nothing, which keeps every demo, every published session and every
   * shared link on exactly the path they were on before this existed; only a
   * local name reaches storage.
   *
   * **No `prompt`.** Rendering is not a gesture — the boot path reaches here
   * through `App.restore` → `activate` → `render` with no activation at all —
   * and asking for permission without it resolves without ever showing a
   * dialog. So this asks whether the grant is *already* good; re-granting one
   * that has lapsed is a click's work, and the picker's note is where the click
   * lives.
   */
  private async sourceFor(uri: string): Promise<SourceSpec | null> {
    const remote = inferSource(uri)
    if (remote !== null) return remote
    this.resolving = uri
    try {
      return await resolveSource(uri)
    } finally {
      this.resolving = null
    }
  }
}
