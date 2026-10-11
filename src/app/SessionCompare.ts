/**
 * The second file, drawn in the lower-left triangle of the first one's map
 * (`render/compare.ts`).
 *
 * A comparison has more states than the reader sees: a file being opened and
 * gated, one open with its eye shut, one carried across a change of the first
 * file's resolution, and one a link names that the tab does not hold yet. This
 * owns all four, with the reader that comes with the second file, and every
 * way in and out of them — open, close, swap, carry, restore, reconcile. The
 * session keeps one handle on the comparison and asks it, where it used to hold
 * five fields of it among ninety.
 *
 * Separate because it is the one feature with a worker of its own beside the
 * session's, and a refused file must not leave its h5wasm instance behind: the
 * rule that every exit terminates the second reader is easier to keep when all
 * the exits are in one file.
 *
 * What it does **not** own is the Contact maps card it reports into. That card
 * lists every map the session holds — the first file, this one, the deck's
 * companions, the hidden ones — and is rebuilt with the file, so it is the
 * session's, and this writes the second file's row through it.
 */

import type { CompareOp, ViewState } from '../types'
import { recall, remember } from '../state/UiMemory'
import { compareRefusal } from '../ui/CompareCard'
import type { CompareRead } from '../ui/compare'
import { fmt } from '../ui/dom'
import { firstEntry } from '../ui/FilePicker'
import { fileLabel, splitUri } from '../ui/labels'
import { rungsOf } from '../ui/refine'
import { ReaderClient } from '../worker/client'
import type { OpenResult, SourceSpec } from '../worker/protocol'
import { contigPairs } from './contigTable'
import { inferSource, resolveSource } from './resolve'
import type { Session } from './Session'

/** The second file of a comparison, and what the gate had to read to accept it. */
interface OpenCompare {
  uri: string
  source: SourceSpec
  client: ReaderClient
  info: OpenResult
  /** Name and length per chromosome, in file order — what the gate compared. */
  contigs: Array<[string, number]>
}

/**
 * The second file, held across a change of resolution rather than dropped with
 * the first.
 *
 * A comparison belongs to the file it is a comparison *of*, which is why
 * opening another file puts it down. Switching rung is the one case where that
 * reasoning does not apply: it is the same file at another bin size, the reader
 * did not close anything, and the two maps were being read against each other a
 * moment ago. Dropping the second there is losing a file the reader would have
 * to find and open again at every zoom level — and losing it *silently*, since
 * the first map is a complete picture on its own and nothing on screen says the
 * other one has gone.
 *
 * What is kept is deliberately not the worker: the second file has to be
 * re-opened at its *own* rung, because the gate refuses two different bin sizes
 * and is right to. So this is the four facts that address it again — where it
 * came from, which rungs it has, and how the reader was reading it — and
 * {@link SessionCompare.restore} is where they are spent.
 */
export interface CompareCarry {
  uri: string
  source: SourceSpec
  /** Sibling rungs of the second file's own collection; `[]` for a plain file. */
  entries: readonly string[]
  /** The group they live under — `resolutions` for an mcool. */
  entryGroup: string
  /** The bin size it was open at, so an unchanged one needs no arithmetic. */
  binsize: number | null
  /** Whether its triangle was hidden, which is a fact about the reading. */
  hidden: boolean
}

export class SessionCompare {
  /**
   * The second file, drawn in the lower-left triangle (`render/compare.ts`).
   *
   * A whole open file, with a reader of its own: the same shape as
   * {@link Session.file}'s, minus everything only the *first* file answers — no
   * genomes table, no annotations, no record card. That asymmetry is the feature
   * rather than a shortcut. The comparison is one map with two sets of numbers
   * in it, not two browsers side by side, so exactly one file decides what the
   * axes are, what the tracks are drawn against, and what the breadcrumb says.
   */
  second: OpenCompare | null = null
  /**
   * The second map is open and *not drawn* — its eye is shut.
   *
   * Distinct from having no second map at all: the reader stays alive and the
   * card keeps its row, so the lower-left triangle comes back on the next press
   * rather than on another read of another file. The same distinction the first
   * map's {@link Session.parkedMap} makes, and the same one a track's `visible`
   * makes.
   */
  hidden = false
  /** The URI a compare open is in flight for, so a re-render does not restart it. */
  private opening: string | null = null
  /**
   * The second file, waiting out a change of resolution — see {@link CompareCarry}.
   *
   * Set the moment an open is known to be a re-open of the file already here,
   * and spent by the first {@link restore} after it lands. `null` at every other
   * moment, including a failed open: the catch re-enters {@link Session.open}
   * for the entry it was redirected to, and the carry is taken again there from
   * a comparison that is still standing.
   */
  carried: CompareCarry | null = null

  constructor(private readonly session: Session) {}

  /**
   * Open a second cooler into the lower-left triangle, or refuse it with the
   * reason.
   *
   * The gate is read *before* anything is drawn and it is three questions —
   * cooler, same bin size, same chromosomes — because each of the three is a way
   * the merged picture would be a lie rather than a limitation of the code. See
   * {@link compareRefusal}, which owns the wording.
   *
   * A refused file leaves nothing behind: its worker is put down here, so a
   * reader trying three files in a row does not accumulate three h5wasm
   * instances for the two that were wrong.
   */
  async open(uri: string, source: SourceSpec): Promise<void> {
    const file = this.session.file
    if (file === null || this.opening === uri) return
    this.opening = uri
    this.session.compareCard?.set({ kind: 'loading', label: fileLabel(uri) })
    const client = new ReaderClient()
    try {
      const info = await client.request<'open'>({ kind: 'open', uri, source })
      const contigs = await client.request<'contigs'>({ kind: 'contigs' })
      // The primary file may have been replaced while this one was opening — a
      // resolution picked from the breadcrumb is enough. The gate is about *two*
      // files, so it has to be the two it started with, or it would compare one
      // file's bin size against another file's contigs and pass.
      if (this.session.destroyed || this.session.file !== file) {
        client.terminate()
        return
      }
      const mine = await this.session.contigs()
      if (this.session.destroyed || this.session.file !== file) {
        client.terminate()
        return
      }
      const refusal = compareRefusal(file.info, info, {
        primary: contigPairs(mine),
        second: contigPairs(contigs),
      })
      if (refusal !== null) {
        client.terminate()
        this.session.compareCard?.set({ kind: 'error', label: fileLabel(uri), message: refusal })
        this.forget(uri)
        return
      }
      this.second?.client.terminate()
      this.second = { uri, source, client, info, contigs: contigPairs(contigs) }
      // Drawn to the tab's total before the remount below reads it (§6.5): the
      // second triangle is a map like any other, and a comparison at one depth
      // is what the total is for.
      this.session.drawReader(client, this.session.contactsTarget)
      this.session.countOf(client, info)
      this.session.compareCard?.set({ kind: 'open', label: fileLabel(uri), info })
      this.session.infoPanel?.setCompare(info)
      // A remote second file survives being shared; a local one cannot be
      // reopened from a link any more than a local first file can (§11), so it
      // is deliberately kept out of the hash rather than written as a name
      // nobody's browser can act on.
      if (inferSource(uri) !== null) this.session.store.patch({ uri2: uri })
      // …and remembered *here* instead, in this session's own memory, where a
      // file name is as private as the file. The hash stays exactly as honest
      // as it was; what changes is that this browser can put the comparison
      // back on a reload, the way it now puts the first file back.
      else remember(this.session.memoryKey(this.session.store.state?.uri ?? uri), 'compare:local', uri)
      this.session.remount()
    } catch (err) {
      client.terminate()
      if (this.session.destroyed) return
      // A collection addressed at its root is a `KeyError` in Python and the
      // reader mirrors it faithfully (§3.4) — but somebody who dropped an
      // `.mcool` on the compare card meant "this map", so the entry is opened
      // for them, exactly as it is when the same file is dropped on the picker.
      // The resolution *this map is at*, where the collection has it: two files
      // with the same five levels are comparable at any of them, and landing on
      // the finest regardless meant a reader looking at 1 kb was told the bin
      // sizes differ by a file that has 1 kb in it. Where it does not, the
      // finest is the fallback and the gate's bin-size clause says so by name.
      const landing = firstEntry(err, file.info.binsize ?? undefined)
      if (landing !== null) {
        this.opening = null
        await this.open(`${splitUri(uri).path}::${landing.group}/${landing.entry}`, source)
        return
      }
      this.session.compareCard?.set({
        kind: 'error',
        label: fileLabel(uri),
        message: err instanceof Error ? err.message : String(err),
      })
      this.forget(uri)
    } finally {
      this.opening = null
    }
  }

  /**
   * Take a refused second file out of the view state.
   *
   * The state is what {@link Session.render} reconciles against, so a `uri2`
   * that will never open is a *standing* instruction to try opening it — a fresh
   * worker and a fresh header read on every navigation, for a file that was
   * already refused. The card keeps the reason; the hash stops claiming a comparison
   * that is not on screen.
   */
  private forget(uri: string): void {
    const held = this.session.store.state?.uri2
    if (held === undefined || this.second !== null) return
    // The *file*, not the URI: a link naming an `.mcool` at its root is refused
    // under the entry URI it was redirected to, and comparing the two strings
    // would leave the original in the hash to be retried for ever.
    if (held !== uri && splitUri(held).path !== splitUri(uri).path) return
    this.session.store.patch({ uri2: undefined }, { replace: true })
  }

  /**
   * Put the second file down.
   *
   * `which === 1` closes the *first* one, and the second takes its place: the
   * comparison is symmetric in everything except which triangle each file is
   * in, so closing either has to leave an ordinary one-file map behind. Closing
   * the first is therefore an `open` of the second, carrying nothing but the
   * view — the colour clip is in the first file's counts and means nothing in
   * the second's, exactly as it does not survive a change of resolution.
   */
  close(which: 1 | 2): void {
    const held = this.second
    if (held === null) return
    if (which === 2) {
      this.drop()
      this.session.store.patch({ uri2: undefined })
      this.session.remount()
      return
    }
    const state = this.session.store.state
    this.drop()
    const carry =
      state === null
        ? undefined
        : (({ vmin: _vmin, vmax: _vmax, uri2: _uri2, ...rest }) => ({ ...rest, uri: held.uri }))(
            state,
          )
    void this.session.open(held.uri, held.source, carry)
  }

  /**
   * Swap which file is above the diagonal — the same comparison, read the other
   * way.
   *
   * Reopening rather than relabelling, because "which file is first" is not a
   * label: the first file is the one whose contigs table the axes come from,
   * whose tracks are drawn, and whose breadcrumb is on screen. Both sources are
   * held here, so a *local* second file survives the swap — which a round trip
   * through `uri2` and `inferSource` could not manage (§11).
   */
  async swap(): Promise<void> {
    const held = this.second
    const file = this.session.file
    if (held === null || file === null) return
    const state = this.session.store.state
    const carry =
      state === null
        ? undefined
        : (({ vmin: _vmin, vmax: _vmax, uri2: _uri2, ...rest }) => ({ ...rest, uri: held.uri }))(
            state,
          )
    const previous = { uri: file.uri, source: file.source }
    this.drop()
    await this.session.open(held.uri, held.source, carry)
    if (this.session.destroyed) return
    await this.open(previous.uri, previous.source)
  }

  /**
   * What the whole-file view's cache key has to carry about the comparison.
   *
   * That slot holds the result of a full pass over every stored pixel, keyed on
   * *what was read*. A second file arriving, leaving, or being put together
   * with the first another way all change what the picture is of, so each of
   * them has to miss the cache — the alternative is a whole-genome map that
   * keeps showing one file after a second has been dropped on it.
   */
  key(): string {
    return this.second === null ? '' : `${this.second.uri}|${this.op()}`
  }

  /**
   * How the two open files are put together, from the view state.
   *
   * `split` wherever there is no second file, so that a link carrying `op=ratio`
   * and one file lands on that file's own map rather than on a comparison with
   * nothing — the same thing a `uri2` naming a local file does (§11).
   */
  private op(): CompareOp {
    if (this.second === null) return 'split'
    return this.session.store.state?.op ?? 'split'
  }

  /**
   * Put a remembered local comparison back, or forget it.
   *
   * Silent on failure, and that is the right shape: the reader did not ask for
   * this file *now* — they asked for it last week and closed their browser — so
   * a grant that has lapsed is not an error to report, it is a comparison that
   * simply is not there. The note is dropped with it so the next render does not
   * try again, and the Compare card is where they were always going to re-open
   * it from.
   */
  private async reopen(uri: string): Promise<void> {
    const source = await resolveSource(uri)
    if (this.session.destroyed) return
    const held = this.session.store.state?.uri
    if (source === null) {
      if (held !== undefined) remember(this.session.memoryKey(held), 'compare:local', undefined)
      return
    }
    // Re-checked after the await: the reader may have opened one by hand, or
    // navigated to another file entirely, while the grant was being asked for.
    if (this.second !== null || this.opening !== null) return
    await this.open(uri, source)
  }

  drop(): void {
    const local = this.second !== null && this.second.source.kind === 'local'
    this.second?.client.terminate()
    this.second = null
    this.hidden = false
    this.session.compareCard?.set({ kind: 'empty' })
    this.session.infoPanel?.setCompare(null)
    // Closing a local comparison has to forget it as well as put it down, or the
    // next reload would open again the one thing the reader just closed — the
    // `uri2` half of the same act is a patch on the hash, and this is its
    // counterpart for the half the hash never held.
    //
    // Not while one is being *carried* across a change of resolution: the note
    // is how a local second file finds its way back, and forgetting it there
    // would put down the very comparison the carry exists to keep. The re-open
    // writes it again under the same key — the key is the file rather than the
    // rung (`state/UiMemory.ts`) — so nothing has to be moved.
    const uri = this.session.store.state?.uri
    if (local && uri !== undefined && this.carried === null) {
      remember(this.session.memoryKey(uri), 'compare:local', undefined)
    }
  }

  /**
   * Hold on to the second file, if the open about to happen is a change of
   * resolution rather than a change of subject.
   *
   * The test is {@link Session.reopeningSameFile}'s, which is the path before
   * `::` and therefore already says "the same `.mcool` at another bin size".
   * Every other open — a different file, a genome, the picker — leaves this
   * `null` and the comparison is dropped with the file it belonged to, which is
   * what it has always meant.
   */
  carry(next: string): void {
    const held = this.second
    this.carried =
      held === null || !this.session.reopeningSameFile(next)
        ? null
        : {
            uri: held.uri,
            source: held.source,
            entries: held.info.entries,
            entryGroup: held.info.entryGroup,
            binsize: held.info.binsize,
            hidden: this.hidden,
          }
  }

  /**
   * Put the carried second file back, at the rung the first one has moved to.
   *
   * **The bin size carries, not the URI.** The second file has a ladder of its
   * own, so `rep2.mcool::/resolutions/1000` beside a 1 kb map is
   * `…/resolutions/5000` beside a 5 kb one — and the rung is looked up in the
   * second file's own entries rather than assumed to be spelled the same way.
   * A plain `.cool` has no entries and needs none: it is already at one bin size,
   * and if that is the new one it comes straight back.
   *
   * A file with no rung at the new resolution **cannot be compared there**, and
   * that is the gate's rule rather than a shortcoming here: two bin sizes in one
   * square would draw a pixel that means 1 kb on one side of the diagonal and
   * 5 kb on the other. So it is put down with the reason on the card, where the
   * reader is already looking for the name of the file that has gone — rather
   * than carried into a refusal they would have to read as a bug.
   */
  restore(carried: CompareCarry, uri: string, info: OpenResult): void {
    // Spent here, and here only: while it stands, `render` leaves the
    // comparison alone, and the whole point of the next two lines is that
    // something is about to be in flight for it.
    this.carried = null
    const moved = compareRung(carried, info.binsize)
    if (moved === null) {
      this.session.compareCard?.set({
        kind: 'error',
        label: fileLabel(carried.uri),
        message:
          `${fileLabel(carried.uri)} has no ${fmt.bp(info.binsize ?? 0)} level, so it cannot be ` +
          `compared at this resolution — two bin sizes in one square would draw a pixel that ` +
          `means one thing above the diagonal and another below it.`,
      })
      remember(this.session.memoryKey(uri), 'compare:local', undefined)
      return
    }
    // Restored before the open rather than after it: the eye is a fact about
    // the *reading* and the reader did not touch it, so a hidden triangle has
    // to stay hidden while the file behind it is read again. Set now because
    // `open` is asynchronous and `context` is consulted in between — and it is
    // only ever read with a second file open, which is exactly when this is true
    // again.
    this.hidden = carried.hidden
    void this.open(moved, carried.source)
  }

  /** What a heatmap view needs to read and label the second file, or `undefined`. */
  context(): CompareRead | undefined {
    const held = this.second
    const file = this.session.file
    if (held === null || file === null || this.hidden) return undefined
    return {
      client: held.client,
      labels: [this.session.mapLabel(file.uri), this.session.mapLabel(held.uri)],
      // In the view state rather than in session memory: it changes what is in
      // the picture, and a link naming a ratio has to produce a ratio.
      op: this.op(),
      onOpChange: (op) => {
        this.session.store.patch(op === 'split' ? { op: undefined } : { op })
        // A remount, unlike the baseline beside it: the split needs the second
        // file's own block kept per-file and the derived operations do not, and
        // the panel is built for one or the other at construction.
        this.session.remount()
      },
      onFailure: (message) => {
        // Terminating the second reader rejects its in-flight reads, which
        // arrive here as failures — of a comparison that is no longer on
        // screen, on a card that is now offering to start a new one.
        if (this.second !== held) return
        this.session.compareCard?.set({ kind: 'error', label: fileLabel(held.uri), message })
      },
    }
  }

  /**
   * Bring the second file in line with the state `render` is acting on, and
   * say whether that render has to stop here.
   *
   * `true` is a `uri2` that names a local file: there is nothing to open, the
   * hash is patched to stop claiming a comparison, and the patch starts a
   * render of its own that is the one to finish.
   */
  reconcile(state: ViewState): boolean {
    const wanted = state.uri2 ?? null
    // Only a *remote* second file is in the state, because only a remote one
    // can be re-opened from a link (§11) — so a local comparison is invisible
    // here, and reading its absence as "put it down" is exactly what happened:
    // `open` finished, called `remount`, and this line threw the file away again
    // before it could be drawn. A local comparison is left alone; the × on the
    // card is what closes it, and that goes through `close`.
    const shareable = this.second !== null && this.second.source.kind === 'remote'
    const held = shareable ? (this.second?.uri ?? null) : null
    // …and nothing at all while a second file is being **carried across a
    // change of resolution**. This runs during the open — the first file is
    // read, its annotations are rebuilt, and both of those are awaits — and the
    // state it reconciles against is still the one being left, whose `uri2`
    // names the previous rung. Acting on it opens the second file at the bin
    // size the reader has just moved away from, and the gate refuses the pair
    // it has itself just assembled: the comparison is on screen, and the card
    // beside it says the two files' resolutions differ.
    if (wanted !== held && this.carried === null) {
      if (wanted === null) {
        if (shareable) this.drop()
      } else {
        const source = inferSource(wanted)
        // The same refusal a local `uri` gets, for the same reason: no browser
        // re-reads a dropped file without a gesture, so a link naming one has
        // nothing to open. Dropped from the hash rather than left there
        // describing a comparison that is not on screen.
        if (source === null) {
          this.session.store.patch({ uri2: undefined }, { replace: true })
          return true
        }
        void this.open(wanted, source)
      }
    }

    // …and the half the hash never carried. A local comparison this session
    // wrote down is re-opened here, once, when nothing is holding the triangle
    // — which is the state a reload leaves. Guarded on `opening` as well as on
    // `second`, because the open is asynchronous and `render` runs many times
    // before it lands; without it a reload would start the same file four times
    // and each would terminate the last one's worker.
    if (
      this.second === null &&
      this.opening === null &&
      this.carried === null &&
      state.uri2 === undefined
    ) {
      const local = recall<string>(this.session.memoryKey(state.uri), 'compare:local')
      if (typeof local === 'string' && local !== '') void this.reopen(local)
    }
    return false
  }

  /**
   * Put the second reader down without a word: no card, no note, no carry.
   *
   * What closing the map and closing the tab both need, and the whole of what
   * they did here — a comparison of a file that is going is not one to
   * forget on its behalf, and neither has a card left to tell.
   */
  release(): void {
    this.second?.client.terminate()
    this.second = null
  }
}

/**
 * The same view with the second file **said to be gone**.
 *
 * Present and `undefined`, which is not the same thing as absent here and is
 * the whole of why this is a function rather than a destructuring at the call
 * site. {@link Session.withCompanions} carries `uri2` forward across a
 * navigation *unless the caller has said something about it*, and the test it
 * uses is `key in next` — so a state that merely omits the key is a state that
 * has said nothing, and the previous rung's second file is put straight back
 * into it. The hash is written from the keys whose value is defined
 * (`serialiseViewState`), so this serialises exactly as an absent key does.
 */
export function withoutSecond(state: ViewState): ViewState {
  return { ...state, uri2: undefined }
}

/**
 * Where a carried comparison is addressed at `binsize`, or `null` for a file
 * that has no rung there.
 *
 * `null` is not a failure to look it up: it is the answer that the two files
 * cannot be compared at this resolution, which is the gate's own rule seen from
 * the other side. **Exact**, on {@link Session.openAtBinsize}'s rule and for its
 * reason — the nearest rung is a different picture, and drawing it under a
 * label that says the reader's own resolution would be a lie the picture cannot
 * betray.
 *
 * Exported for the test: it is the one piece of arithmetic in the carry, and
 * everything around it needs a worker and two open files to reach.
 */
export function compareRung(carried: CompareCarry, binsize: number | null): string | null {
  if (binsize === null || !(binsize > 0)) return null
  if (carried.binsize === binsize) return carried.uri
  const match = rungsOf(carried.entries).find((rung) => rung.binsize === binsize)
  if (match === undefined) return null
  return `${splitUri(carried.uri).path}::${carried.entryGroup || 'entries'}/${match.name}`
}
