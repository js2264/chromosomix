/**
 * Turning a dropped file into a row on a card.
 *
 * Separate from the cards because three callers need it — the drop areas, the
 * URL box, and the one-click demo loader — and because the interesting part is
 * not the DOM but the routing: a *zone* says what the reader meant, the file's
 * bytes say what it is, and where those disagree the file wins and the reader is
 * told (spec §8.3).
 */

import type { NamedSequence } from '../genome/naming'

import type { AnnotationStore } from './store'
import { defaultStyle } from './types'
import type {
  AnnotationCard,
  AnnotationEntry,
  AnnotationKind,
  AnnotationSource,
  ComputedSource,
  Placement,
  StoredEntry,
} from './types'
import type { AnnotationClient } from './worker/client'
import type { DetectedFormat, WireSource } from './worker/protocol'
import { hasHandle, rememberHandle, resolveHandle } from '../state/handles'
import {
  basesForIndex,
  indexNamesFor,
  isIndexName,
  leadOf,
  pairIndexes,
  splitIndexFragment,
  type PairedDrop,
} from './sidecar'

// Re-exported because the pairing rules used to live here and three layers
// import them from here. See `annotations/sidecar.ts` for why they moved.
export {
  basesForIndex,
  indexNamesFor,
  isIndexName,
  leadOf,
  pairIndexes,
  splitIndexFragment,
  type PairedDrop,
}
import { grantFor } from '../ui/chooseFiles'
import { logAction } from '../state/actions'
import { fmt } from '../ui/dom'

/**
 * What a file's *name* suggests it is.
 *
 * A guess, and only ever used for the placeholder row while the bytes are being
 * read: §8.3 makes the content decide, and it corrects this a moment later. It
 * exists at all because a row that says "reading…" under the wrong colour and
 * the wrong height is a row that jumps when it lands.
 */
function guessOf(name: string): { card: AnnotationCard; kind: AnnotationKind } {
  if (/\.bedpe(\.gz)?$/i.test(name)) return { card: 'overlay', kind: 'pairs' }
  if (/\.(bw|bigwig)(\.gz)?$/i.test(name)) return { card: 'linear', kind: 'track' }
  if (/\.(bdg|bedgraph|wig)(\.gz)?$/i.test(name)) return { card: 'linear', kind: 'track' }
  if (/\.(fa|fasta|fna|fas)(\.gz)?$/i.test(name)) return { card: 'linear', kind: 'sequence' }
  if (/\.(gtf|gff3?)(\.gz)?$/i.test(name)) return { card: 'linear', kind: 'gtf' }
  if (/\.vcf(\.gz)?$/i.test(name)) return { card: 'linear', kind: 'variants' }
  if (/\.bam$/i.test(name)) return { card: 'linear', kind: 'alignments' }
  return { card: 'linear', kind: 'segments' }
}

export class AnnotationLoader {
  constructor(
    private readonly store: AnnotationStore,
    private readonly client: AnnotationClient,
    /**
     * The map's sequences, for the §8.2 overlap report and for the rename that
     * precedes it (§5.9). Lengths where the map has them: they are the only
     * thing that can veto a match made across two nomenclatures.
     */
    private readonly mapContigs: NamedSequence[],
    /**
     * Told about every file handed to {@link addFiles}, before it is read.
     *
     * The session uses it to ask a dropped track whether it also knows the
     * assembly's real lengths, and it is a hook here rather than a line at the
     * one call site because there is not one call site. A file reaches a loader
     * from `Session.dropped`, from the Tracks card's own file button, from the
     * sizes path when a `chrom.sizes`-shaped name turns out not to be one, and
     * from the pair a BAM opens with — and a browser whose lengths were fixed by
     * dragging a bigWig onto the plot but *not* by choosing the same bigWig from
     * the button two inches away is the kind of difference nobody can see the
     * rule behind. So the notice is raised where every road already converges.
     *
     * The *paired* files, not the raw list: a `.tbi` beside its BAM is an index
     * rather than a file with an opinion about the genome, and passing it on
     * would buy a wasted read of a sidecar that can never answer.
     *
     * Optional because a loader is a loader without it, and the deck's
     * companions build one where nothing is watching.
     */
    private readonly onFilesAdded?: (files: readonly File[]) => void,
  ) {
    // Tell the worker when a row goes. Nothing did, before this: `client.drop`
    // had exactly one caller — the refusal path below — and `AnnotationStore.remove`
    // dropped the row, its lanes and its placements and said nothing to the
    // thread holding the file. So closing a bigWig left its open handle, and
    // closing a BAM left its parsed index — single-digit megabytes for a human
    // WGS file — alive for the life of the tab.
    //
    // Reconciled against the store rather than driven by a removal event, which
    // is the same choice `SampleCache.prune` makes and for the same reason: the
    // worker's stores are *derived*, and a subscription that fires on every
    // change cannot miss one, where an event somebody forgets to send is a leak
    // nobody sees.
    // Never unsubscribed, and nothing to unsubscribe *from*: a loader is built
    // beside the store it watches and the client it speaks to, and a session
    // that changes genome replaces all three at once (`Session.setUpBrowser-
    // Annotations`), destroying the worker as it goes.
    store.subscribe(() => this.release())
  }

  /** Entries this loader has told the worker about, so it can say when they go. */
  private readonly held = new Set<string>()

  /**
   * Drop what the store no longer has.
   *
   * By id rather than by count, because a row can come *back* under the same id
   * — `reattach` re-issues `load` for a detached local file — and a reference
   * count over a channel that can repeat itself is a count that never reaches
   * zero.
   */
  private release(): void {
    if (this.held.size === 0) return
    const live = new Set(this.store.entries.map((entry) => entry.id))
    for (const id of [...this.held]) {
      if (live.has(id)) continue
      this.held.delete(id)
      this.client.drop(id)
    }
  }

  /**
   * Load one or more files, whatever they are.
   *
   * No zone and no card: the reader drops a file on the tracks, and *what it
   * is* — a lane beside the map, or a mark on it — is a property of the format,
   * which only the bytes can settle (§8.3). Asking a reader to route a file
   * into one of five rectangles was asking them to know the answer to a
   * question the application is about to answer anyway, and to be told off when
   * they guessed wrong.
   *
   * A file whose name matches a row this session **put down** is that row. A
   * reload leaves every local track detached with a "re-open this file" button
   * beside it, and a reader who drops the same files back in is answering that
   * question with the gesture they use for everything else — so it is taken as
   * the answer. A second row would leave the colours, the limits and the
   * placement on the dead one and start the live one from the defaults, which
   * is the reload having lost the workspace it went to the trouble of keeping.
   *
   * @param placement Which of the map's two edges a lane is drawn on, when the
   * drop said so. Not the same kind of claim: it does not decide what the file
   * is, only where a track ends up if that is what it turns out to be, and a
   * file dropped anywhere else omits it and takes the default.
   */
  addFiles(files: readonly File[], placement?: Placement): void {
    // A tabix sidecar is not a track and is never a row of its own: it is the
    // index for the file dropped beside it, and pairing them here is what makes
    // "select both and drag" the whole of the gesture. A `.tbi` dropped alone
    // has nothing to index and is passed through to be refused by name, which
    // is more use than silently doing nothing.
    const paired = pairIndexes(files)
    this.onFilesAdded?.(paired.map((pair) => pair.file))
    for (const { file, index } of paired) {
      // The console's line for a track (§23), on the two doors a *reader* drives
      // — this one and {@link addUrl} — and not on the paths the app drives
      // itself: `restore` brings back what a previous visit remembered and
      // `carry` moves a row across a change of resolution. Neither is something
      // somebody did this afternoon, and a console that opened with nine lines
      // after every reload would be a console nobody reads.
      //
      // A drop that lands on a *detached* row is recorded like any other, even
      // though it ends in `reattach` rather than in `begin`: the reader dropped
      // a file, which is the thing being recorded, and what the store does with
      // it afterwards is the store's business.
      logAction({
        kind: 'track',
        line: `loaded ${file.name}`,
        detail: [
          `# file: ${file.name}`,
          `# size: ${fmt.bytes(file.size)}`,
          ...(index === undefined ? [] : [`# index: ${index.name}`]),
        ],
        where: file.name,
      })
      // Every detached row of that name, not the first. A BAM comes back from a
      // reload as two of them (§8.13), and reattaching one would leave a reader
      // who dropped the file again looking at a depth lane with the pile still
      // asking to be pointed at the same file they had just pointed at.
      const held = this.store.entries.filter(
        (entry) => entry.status === 'detached' && entry.source.name === file.name,
      )
      if (held.length > 0) {
        for (const row of held) this.reattach(row.id, file, index)
        continue
      }
      this.begin(
        { kind: 'local', file, name: file.name, ...(index === undefined ? {} : { index }) },
        undefined,
        undefined,
        placement,
      )
    }
  }

  /**
   * Load a file named by URL — a published track, or one of the demo files.
   *
   * @param placement Which of the map's two edges the lane is drawn on, when a
   * drop said so. The same parameter {@link addFiles} takes and for the same
   * reason: a row dragged out of the Files panel onto the bottom edge of a map
   * is a reader saying which stack they want it in, and a remote file has no
   * business taking the default just because its bytes are somewhere else.
   */
  addUrl(url: string, label?: string, placement?: Placement): void {
    const trimmed = url.trim()
    if (trimmed === '') return
    const { address, index } = splitIndexFragment(trimmed)
    const name = address.split('/').pop() ?? address
    logAction({
      kind: 'track',
      line: `loaded ${label ?? name}`,
      detail: [
        `# url: ${address}`,
        ...(index === undefined ? [] : [`# index: ${index}`]),
      ],
      where: label ?? name,
    })
    this.begin(
      { kind: 'remote', url: address, name, ...(index === undefined ? {} : { index }) },
      label,
      undefined,
      placement,
    )
  }

  /**
   * Re-open what a previous visit left in session storage (§8.6).
   *
   * A remote entry is fetched again, since its URL is all that was ever needed.
   * A local one is re-opened where this browser still holds a grant for the file
   * (`state/handles.ts`), and otherwise comes back `detached` exactly as it
   * always has — holding its colours and limits, waiting for the same file to be
   * dropped on it again.
   *
   * The re-open is asynchronous and the row is seated before it finishes, so a
   * remembered track appears saying *reopening…* and then fills in. That is the
   * same two-step a remote row has always taken, and it is deliberately not
   * awaited: eight tracks resolve in parallel rather than one after another, and
   * a grant that turns out to be spent leaves a row the reader can still fix by
   * hand.
   */
  restore(stored: readonly StoredEntry[]): void {
    for (const row of stored) {
      // A **metadata** row is not this loader's (§8.12): there is no file
      // behind it, so there is nothing to re-fetch and nothing to re-attach —
      // its column is in the map that is open. `Session.restoreMetadata` brings
      // it back, ready rather than detached, and taking it here would put a
      // "re-open the file" button under a row that never had one.
      if (row.source.kind === 'metadata') continue
      if (row.source.kind === 'remote' && row.source.url !== undefined) {
        this.begin(
          {
            kind: 'remote',
            url: row.source.url,
            name: row.source.name,
            // A named sidecar comes back with the row. Without it a restored
            // BAM on a presigned URL reopens with a guessed `<url>.bai` that
            // cannot exist, and refuses.
            ...(row.source.index === undefined ? {} : { index: row.source.index }),
          },
          row.label,
          row,
        )
        continue
      }
      // A **computed** row keeps its own source across a reload, and that is the
      // whole point of persisting one. There is no file to re-open — the values
      // are not stored, only the recipe is (§18.5) — so replacing the source with
      // a `detached` placeholder would throw away the one thing that could bring
      // the row back and leave a Recompute button with nothing to recompute.
      const computed =
        row.source.kind === 'computed' &&
        row.source.task !== undefined &&
        row.source.recipe !== undefined
          ? ({
              kind: 'computed',
              name: row.source.name,
              task: row.source.task,
              recipe: row.source.recipe,
              framing: row.source.framing ?? '',
            } satisfies ComputedSource)
          : null
      const source = computed ?? ({ kind: 'detached', name: row.source.name } as const)
      // Asked synchronously, and only to choose the wording: `hasHandle` reads a
      // set hydrated at boot, so it costs nothing and cannot be wrong in the
      // direction that matters — a row it calls remembered and then fails to
      // open falls back to the detached wording a moment later.
      const remembered = computed === null && hasHandle(row.source.name)
      const summary =
        computed !== null
          ? `computed by ${computed.task} · recompute to draw it again`
          : remembered
            ? 'reopening…'
            : 'dropped file — re-open it to draw it again'
      this.store.begin({
        card: row.card,
        kind: row.kind,
        source: source as never,
        id: row.id,
        label: row.label,
        placement: row.placement,
        style: row.style,
        // As on the remote road above: where the *lead* draws it, which is not
        // the same question as which edge the track defaults to.
        lead: row.lead,
        // …and the other row over the same BAM. A pair that came back unlinked
        // would look right and behave as two files, so a filter set on the pile
        // would stop reaching the depth beside it.
        ...(row.partner === undefined ? {} : { partner: row.partner }),
      })
      this.store.update(row.id, {
        status: 'detached',
        source,
        summary,
        visible: row.visible,
      })
      // A `computed` row has no file to re-open, and a `detached` one may still
      // have a grant behind it — including one this browser learnt about after
      // `hasHandle` was asked above, which is why the attempt is unconditional
      // and the flag above only chose a word.
      if (computed === null) void this.reopenRemembered(row.id, row.source.name)
    }
  }

  /**
   * Re-open a restored local row from a remembered grant, or leave it detached.
   *
   * The whole of the difference this makes is that the reader is not asked to
   * find a file the browser can already reach. Where the grant has lapsed — the
   * file moved, the permission withdrawn, a different file now wearing the name
   * — nothing is reported: the row is put back into exactly the state it was
   * already in, with the button beside it that has always been the way back.
   */
  private async reopenRemembered(id: string, name: string): Promise<void> {
    const file = await resolveHandle(name)
    const entry = this.store.byId(id)
    // Gone while we were asking — the tab was closed, the file re-dropped by
    // hand, the row removed. Any of those makes this answer stale.
    if (entry === undefined || entry.status !== 'detached') return
    if (file === null) {
      this.store.update(id, { summary: 'dropped file — re-open it to draw it again' })
      return
    }
    // And the sidecar, under whichever name it was remembered by. Re-attaching
    // the file alone is why a reloaded `.gz` used to come back reading itself
    // whole; for a BAM it is the difference between a row that reopens and one
    // that reopens refusing, since there is no whole-file fallback (§8.13).
    let index: File | undefined
    for (const candidate of indexNamesFor(name)) {
      const held = await resolveHandle(candidate)
      if (held !== null) {
        index = held
        break
      }
    }
    if (this.store.byId(id)?.status !== 'detached') return
    this.reattach(id, file, index)
  }

  /**
   * Re-attach a detached row to the file it was made from.
   *
   * The id is kept, so the row does not jump to the bottom of the card and the
   * settings the reader chose stay attached to the thing they chose them for.
   */
  reattach(id: string, file: File, index?: File): void {
    const entry = this.store.byId(id)
    if (entry === undefined) return
    const source: AnnotationSource = {
      kind: 'local',
      file,
      name: file.name,
      ...(index === undefined ? {} : { index }),
    }
    this.store.update(id, { status: 'loading', source, error: undefined })
    void this.read(id, toWire(source), false)
  }

  /**
   * Take over a row from the file this session was showing before.
   *
   * The live source, the id, the label and every setting — so a genome browser
   * that becomes a map keeps its tracks *as they were*, rather than as eight
   * names to drop again. Distinct from {@link restore}, which reads a previous
   * visit out of storage and can only bring a local file back detached: here the
   * `File` handle is still open, because the tab never went away.
   */
  carry(entry: AnnotationEntry): void {
    // Nothing without a file behind it. `detached` has lost its handle, the 4C
    // profile never had one, and a **computed** row is an answer about the file
    // being closed: it is a reading of the map that is being put away, so
    // carrying it to the next file would be carrying a picture of somewhere the
    // reader never pointed at. `computed` also has no bytes for {@link toWire}
    // to describe, so carrying one would not merely be wrong — it would throw
    // on the way out, which is the failure this line is here to prevent.
    if (
      entry.source.kind === 'detached' ||
      entry.source.kind === 'derived' ||
      entry.source.kind === 'computed'
    ) {
      return
    }
    this.begin(entry.source, entry.label, {
      id: entry.id,
      card: entry.card,
      kind: entry.kind,
      label: entry.label,
      source:
        entry.source.kind === 'remote'
          ? {
              kind: 'remote',
              name: entry.source.name,
              url: entry.source.url,
              ...(entry.source.index === undefined ? {} : { index: entry.source.index }),
            }
          : { kind: 'local', name: entry.source.name },
      visible: entry.visible,
      placement: entry.placement,
      style: entry.style,
      ...(entry.primary === true ? { primary: true } : {}),
      // A BAM's two rows are carried one at a time, and each brings the other's
      // id. Both are in the list being carried — `carry` is called for every
      // row — so the link points at a row that is arriving too.
      ...(entry.partner === undefined ? {} : { partner: entry.partner }),
    })
  }

  /**
   * @param placement Which lane stack this row is drawn in, when the caller
   * knows — a file dropped on one edge of the map. Left out everywhere else, so
   * the store's own default decides, and always overruled by a *stored*
   * placement: a restored row goes back where the reader put it.
   */
  private begin(
    source: AnnotationSource,
    label?: string,
    stored?: StoredEntry,
    placement?: Placement,
  ): AnnotationEntry {
    // Where the browser gave a grant for this file, write it down: a track is as
    // worth remembering as the map it is drawn beside, and eight bigWigs to
    // re-drop is the larger share of what a reload used to cost. Keyed on the
    // file's name, which is what a restored row carries and looks itself up by.
    if (source.kind === 'local') {
      // The sidecar as well as the file. Remembering only the file is why a
      // reloaded `.gz` used to come back having lost its `.tbi` and read
      // itself whole — and for a BAM the same omission is the difference
      // between a row that reopens and one that reopens refusing (§8.13).
      for (const file of [source.file, source.index]) {
        if (file === undefined) continue
        void grantFor(file).then(
          (handle) => {
            if (handle !== null) void rememberHandle(file.name, handle, file)
          },
          () => undefined,
        )
      }
    }
    const guess = guessOf(source.name)
    const entry = this.store.begin({
      card: stored?.card ?? guess.card,
      kind: stored?.kind ?? guess.kind,
      source,
      ...(placement === undefined ? {} : { placement }),
      ...(stored === undefined
        ? {}
        : {
            id: stored.id,
            placement: stored.placement,
            style: stored.style,
            // Including whether it is drawn. A restored or carried row brings
            // every decision the reader made about it, and "not this one" is
            // one of them.
            visible: stored.visible,
            // …and *where*. `placement` is the track's default edge; this is
            // what the session's own map does with it, up to and including not
            // drawing it (`annotations/types.ts`'s `StoredEntry.lead`). Passed
            // through even when absent, which the store reads as "on the lead,
            // as `placement` says" — the behaviour every restore has had.
            lead: stored.lead,
            // The other row over the same BAM, where this row had one. A pair
            // that came back unlinked would look right and behave as two files:
            // a filter set on the pile would stop reaching the depth above it.
            ...(stored.partner === undefined ? {} : { partner: stored.partner }),
          }),
      ...(label === undefined ? {} : { label }),
    })
    // `stored === undefined` is what makes the style a *guess*: a restored row
    // brings the settings a reader chose, and those are never re-derived.
    void this.read(entry.id, toWire(source), stored === undefined)
    return entry
  }

  /**
   * Open the pile beside a BAM's depth (§8.13).
   *
   * A second row over the same file, and deliberately a *row* rather than a
   * second band of the first one. The two are different pictures with nothing
   * in common — one is a curve against a value axis, drawn at every zoom and on
   * both surfaces; the other is a stack of rectangles that exists only in the
   * 1D browser and only once a read is wider than a pixel — and sharing a lane
   * made every question about them conditional: how tall is this, what does the
   * ceiling drag do, which band did that click land in. As two rows each is
   * resized, moved, hidden and closed like any other track, and the reader who
   * wants only the depth closes the other one.
   *
   * The colour is the depth row's, because they are one file. Everything about
   * *which reads count* is kept in step through {@link AnnotationEntry.partner}.
   */
  private pileFor(id: string): void {
    const entry = this.store.byId(id)
    if (entry === undefined) return
    const source = entry.source
    // Only a row with bytes behind it. Nothing else reaches here today — a
    // `derived` or `computed` row is never a BAM — but `toWire` throws on one,
    // and this is the call that would do it.
    if (source.kind !== 'local' && source.kind !== 'remote') return
    const pile = this.store.begin({
      card: 'linear',
      kind: 'reads',
      source,
      // Named apart, because the Tracks list is a list of names and two rows
      // called `H3K9me3` differ there only by the picture beside them.
      label: `${entry.label} · reads`,
      placement: entry.placement,
      style: defaultStyle('reads', entry.style.colour),
      partner: entry.id,
    })
    this.store.update(entry.id, { partner: pile.id })
    // `guessed: false`: this row's kind is not a guess to be corrected, and a
    // pile that forked again would open a third row for every second one.
    void this.read(pile.id, toWire(source), false)
  }

  /**
   * Read a file and settle what it is.
   *
   * The zone the file landed on is deliberately not consulted here: it decided
   * only what the placeholder row looked like while this was in flight. What
   * comes back decides the rest (§8.3).
   */
  private async read(
    id: string,
    source: WireSource,
    /** The style is the placeholder's, and may be corrected by what arrives. */
    guessed: boolean,
  ): Promise<void> {
    try {
      // Noted before the request rather than after it: a row removed while its
      // own load is still in flight must still be released, and the reply may
      // never come.
      this.held.add(id)
      const result = await this.client.request<'load'>({
        kind: 'load',
        entry: id,
        source,
        mapContigs: this.mapContigs,
      })
      const card = cardFor(result.format)
      // What a *file* of this format is, which for a BAM is its depth — and the
      // row's own kind wins where the row is the second one over that file. A
      // pile is a BAM read a second way (§8.13), so re-deriving its kind from
      // the format would fold it back into the coverage row it was made beside,
      // on every restore and every reattach.
      const already = this.store.byId(id)?.kind
      const kind =
        card === null
          ? null
          : already === 'reads' && result.format === 'bam'
            ? 'reads'
            : kindFor(card, result.format)
      if (card === null || kind === null) {
        this.store.update(id, { status: 'error', error: refusal(result.format) })
        this.client.drop(id)
        return
      }
      // The placeholder took the *zone's* kind, and with it that kind's
      // defaults — a lane height, a drawing mode, a value axis. Where the bytes
      // say otherwise those defaults are wrong for what is about to be drawn: a
      // FASTA dropped on the tracks area would come out 90 pixels tall with its
      // GC autoscaled to whatever fraction this window happens to span, which is
      // an axis that means nothing and changes as you pan. The colour is kept,
      // because it is the store's and the row is already wearing it.
      const held = this.store.byId(id)
      const restyle =
        guessed && held !== undefined && held.kind !== kind
          ? { style: defaultStyle(kind, held.style.colour) }
          : {}
      this.store.update(id, {
        card,
        kind,
        ...restyle,
        status: 'ready',
        // A BAM's two rows come back from the same file with the same sentence
        // under them — "2 references · BAI" — and in the Tracks panel their
        // names are one truncated string apart. So each says which picture it
        // is, first, where the column shows it (§8.13).
        summary:
          kind === 'alignments'
            ? `coverage · ${result.summary}`
            : kind === 'reads'
              ? `reads · ${result.summary}`
              : result.summary,
        overlap: result.overlap,
        ...(result.payload === undefined ? {} : { payload: result.payload }),
        ...(result.fileExtent === undefined ? {} : { fileExtent: result.fileExtent }),
        error: undefined,
      })
      // A BAM is two pictures and they are now two rows. Made here rather than
      // in `begin`, because until the bytes came back this was a file whose
      // name ended in `.bam` — and a second row for a file that turns out to be
      // something else is a row with nothing in it.
      //
      // `guessed` is what keeps this to *fresh imports*: a restored or carried
      // row brings its own partner, and a reader who closed the pile and kept
      // the depth would otherwise be handed the pile again on every reload.
      if (guessed && kind === 'alignments') this.pileFor(id)
    } catch (err) {
      this.store.update(id, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * A `File` is structured-cloneable, so a local file crosses by reference (§11).
 *
 * A **computed** source has no bytes anywhere — it is a recipe, and the lane it
 * belongs to is filled by the analysis worker rather than read from a file
 * (§18.5) — so one arriving here is a routing mistake rather than a file that
 * failed to load. It says so instead of being quietly coerced into a remote
 * source with an `undefined` URL, which is what the previous two-case ternary
 * would have done the moment the third case existed.
 */

function toWire(source: AnnotationSource): WireSource {
  if (source.kind === 'local') {
    return {
      kind: 'local',
      file: source.file,
      name: source.name,
      ...(source.index === undefined ? {} : { index: source.index }),
    }
  }
  if (source.kind === 'remote') {
    const index = remoteIndexFor(source)
    return {
      kind: 'remote',
      url: source.url,
      name: source.name,
      ...(index === undefined ? {} : { index }),
    }
  }
  throw new Error(`${source.name} is a computed track and has no file to load.`)
}

/**
 * The sidecar URL for a remote file, guessed or given.
 *
 * A given one always wins: a presigned URL, or one carrying a query string,
 * can never usefully have `.bai` appended to it, so `#index=<url>` is the way
 * a reader says where the index really is — and it is the only way, because
 * there is no second place to put it (§8.13).
 *
 * Otherwise it is **guessed optimistically and never probed**. A `HEAD` to find
 * out costs the same round trip the miss does, and §12 does not have a request
 * to spend on finding out that a file has no index. For a `.gz` the guess is
 * free either way — the worker treats every index failure as "read it whole",
 * which is what would have happened anyway. For a `.bam` the guess is the whole
 * of how the pair is found, so both spellings `samtools index` writes are
 * offered, the exact one first.
 */
function remoteIndexFor(source: { url: string; index?: string }): string | undefined {
  if (source.index !== undefined) return source.index
  if (/\.gz$/i.test(source.url)) return `${source.url}.tbi`
  if (/\.bam$/i.test(source.url)) return `${source.url}.bai`
  return undefined
}

/**
 * Where a format is *drawn*, which is the only thing the two store cards mean.
 *
 * A pair joins two places, so beside a map it is an arc across the matrix and
 * belongs on it; everything else is a value or an interval along one axis and
 * belongs in a lane. That is a fact about the format, not a choice, which is
 * why the reader is no longer asked to make it.
 */
export function cardFor(format: DetectedFormat): AnnotationCard | null {
  switch (format) {
    case 'bedpe':
      return 'overlay'
    case 'bigwig':
    case 'bigbed':
    case 'bedgraph':
    case 'wig':
    case 'gtf':
    case 'bed':
    case 'vcf':
    case 'fasta':
    case 'bam':
      return 'linear'
    default:
      return null
  }
}

/**
 * What a card does with a file of this format, or `null` if it does nothing.
 *
 * The **format decides**, not the zone. Dropping a BED on the tracks area is a
 * near-miss the app can simply absorb; dropping a bedpe on a card that draws
 * lanes is not, because there is no lane a pair belongs in.
 */
export function kindFor(card: AnnotationCard, format: DetectedFormat): AnnotationKind | null {
  if (card === 'linear') {
    // A bedGraph and a wig are a bigWig written out, and become the same kind
    // of thing: values sampled per view, with a range, a ceiling, an autoscale
    // and every other affordance a bigWig lane already has.
    if (format === 'bigwig' || format === 'bedgraph' || format === 'wig') return 'track'
    if (format === 'fasta') return 'sequence'
    if (format === 'bam') return 'alignments'
    if (format === 'gtf') return 'gtf'
    // Called variants (§8.14). A `FeatureSet` like the two below, and its own
    // kind because a reader means something different by a row of it.
    if (format === 'vcf') return 'variants'
    // A bigBed is read whole and parsed as the BED it holds, so from here it is
    // one: boxes on a lane, and a BED12 with exons draws them.
    if (format === 'bed' || format === 'bigbed') return 'segments'
    return null
  }
  if (format === 'bed' || format === 'bigbed') return 'segments'
  if (format === 'bedpe') return 'pairs'
  return null
}

/**
 * Why this file cannot be a track.
 *
 * Two cases left, and both are files that are *something else* rather than
 * files in the wrong place: one declares a genome and the other is a contact
 * map. Every format that annotates a genome now lands wherever it was dropped.
 */
function refusal(format: DetectedFormat): string {
  if (format === 'sizes') {
    return (
      'This is a chrom.sizes: two columns naming an assembly. It declares a genome rather than ' +
      'annotating one, so it opens a browser rather than joining this map.'
    )
  }
  if (format === 'hdf5') {
    return 'This is a contact map, not an annotation. Open it as a file, or drop it to compare.'
  }
  return 'This file is not one this viewer can draw along a genome.'
}
