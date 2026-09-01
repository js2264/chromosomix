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
import { grantFor } from '../ui/chooseFiles'

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
  ) {}

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
    for (const { file, index } of pairIndexes(files)) {
      const held = this.store.entries.find(
        (entry) => entry.status === 'detached' && entry.source.name === file.name,
      )
      if (held !== undefined) {
        this.reattach(held.id, file, index)
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
          { kind: 'remote', url: row.source.url, name: row.source.name },
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
          ? { kind: 'remote', name: entry.source.name, url: entry.source.url }
          : { kind: 'local', name: entry.source.name },
      visible: entry.visible,
      placement: entry.placement,
      style: entry.style,
      ...(entry.primary === true ? { primary: true } : {}),
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
          }),
      ...(label === undefined ? {} : { label }),
    })
    // `stored === undefined` is what makes the style a *guess*: a restored row
    // brings the settings a reader chose, and those are never re-derived.
    void this.read(entry.id, toWire(source), stored === undefined)
    return entry
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
      const result = await this.client.request<'load'>({
        kind: 'load',
        entry: id,
        source,
        mapContigs: this.mapContigs,
      })
      const card = cardFor(result.format)
      const kind = card === null ? null : kindFor(card, result.format)
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
        summary: result.summary,
        overlap: result.overlap,
        ...(result.payload === undefined ? {} : { payload: result.payload }),
        ...(result.fileExtent === undefined ? {} : { fileExtent: result.fileExtent }),
        error: undefined,
      })
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
/**
 * Which of a dropped batch opens the session, once the sidecars are paired.
 *
 * A map first, then anything that can declare a genome, then whatever came
 * first — which is the order `Session.openFiles` has always used. What is new
 * is that it chooses among **pairs** rather than among files, and that is the
 * whole of why it is a function: choosing from the raw list picks `reads.bam`,
 * opens it without the `reads.bam.bai` sitting right beside it, and leaves the
 * index to be routed on its own. The result is a browser on the BAM's own
 * reference table, the BAM refused for want of an index, and an orphan row for
 * the index — from the one gesture the feature exists for (§8.13).
 *
 * `route` is passed in rather than imported so this stays in the annotations
 * layer, which does not know about the app's front doors.
 */
export function leadOf(
  paired: readonly PairedDrop[],
  route: (name: string) => 'map' | 'genome' | 'unknown',
): PairedDrop | undefined {
  return (
    paired.find((pair) => route(pair.file.name) === 'map') ??
    paired.find((pair) => route(pair.file.name) === 'genome') ??
    paired[0]
  )
}

/**
 * Split `<url>#index=<url>` into the two URLs it names.
 *
 * The one place a reader can say where an index really is, and it exists
 * because the guess cannot always be made: `<url>.bai` is meaningless against a
 * presigned URL, against one carrying a query string, and against any bucket
 * that publishes its index under a different key. A fragment rather than a
 * second input box, because a URL is what gets pasted into chat, into a
 * notebook and into this app's own box — so the pair travels as one string or
 * it does not travel (§8.13).
 *
 * The fragment is stripped from the address, since a `#` is never sent to a
 * server and leaving it on would only make the name shown for the file wrong.
 */
export function splitIndexFragment(url: string): { address: string; index?: string } {
  const at = url.indexOf('#index=')
  if (at < 0) return { address: url }
  const index = url.slice(at + '#index='.length).trim()
  const address = url.slice(0, at)
  return index === '' ? { address } : { address, index: decodeURIComponent(index) }
}

/**
 * The sidecar suffixes this app pairs with the file they index.
 *
 * `.tbi` indexes a bgzipped text file and is opportunistic — the file opens
 * without it (§8.11). `.bai` and `.csi` index a BAM and are not: there is no
 * whole-file fallback at §12's budgets, so the pair is the unit, and a BAM
 * arriving without its index is refused by name (§8.13). One regular
 * expression for all three, because *pairing* is the same gesture whichever it
 * is; what differs is only what happens when the pairing fails.
 */
const INDEX_SUFFIX = /\.(tbi|bai|csi)$/i

/** Whether this file is a sidecar index rather than something to draw. */
export function isIndexName(name: string): boolean {
  return INDEX_SUFFIX.test(name)
}

/**
 * The names a sidecar could be the index for.
 *
 * Two, because `samtools index` writes both spellings: `reads.bam.bai` beside
 * `reads.bam`, and — with an explicit output path, which is what every pipeline
 * that renames its outputs does — `reads.bai`. A reader who drops the pair they
 * have must not have to know which convention produced it.
 */
export function basesForIndex(name: string): string[] {
  const stem = name.replace(INDEX_SUFFIX, '')
  return /\.(bai|csi)$/i.test(name) && !/\.bam$/i.test(stem)
    ? [stem, `${stem}.bam`]
    : [stem]
}

/**
 * The names a sidecar for `base` could have been remembered under.
 *
 * The reverse of {@link basesForIndex}, and it exists for one road only: a
 * restored row knows the name of its file and nothing about its index, because
 * a `File` does not survive session storage. Both suffixes and both spellings
 * are offered, most specific first, and the first that a grant answers for is
 * the one taken.
 */
export function indexNamesFor(base: string): string[] {
  if (/\.bam$/i.test(base)) {
    const stem = base.replace(/\.bam$/i, '')
    return [`${base}.bai`, `${base}.csi`, `${stem}.bai`, `${stem}.csi`]
  }
  if (/\.gz$/i.test(base)) return [`${base}.tbi`]
  return []
}

/** A file to open, and the sidecar dropped alongside it if there was one. */
export interface PairedDrop {
  file: File
  index?: File
}

/**
 * Group a dropped batch into the files to open and the indexes that belong to them.
 *
 * The one implementation of the pairing rule, because there are two roads into
 * it and they used to disagree. {@link AnnotationLoader.addFiles} pairs what it
 * is handed; `Session.dropped` decides what a single file *is* — a workspace, a
 * map, a `chrom.sizes`, a track — and every caller was looping it over the
 * batch, so the loader was handed one file at a time and the pairing never
 * fired for a plain drop onto the window. A `.tbi` losing that race read a file
 * whole that it had an index for; a `.bai` losing it loses the file (§8.13).
 *
 * A sidecar whose file is not in the batch is returned as its own entry rather
 * than dropped, so it reaches the loader alone and is refused by name — more
 * use than silently doing nothing.
 */
export function pairIndexes(files: readonly File[]): PairedDrop[] {
  const bases = new Map<string, File>()
  for (const file of files) if (!isIndexName(file.name)) bases.set(file.name, file)

  const indexOf = new Map<File, File>()
  const spent = new Set<File>()
  for (const file of files) {
    if (!isIndexName(file.name)) continue
    for (const name of basesForIndex(file.name)) {
      const base = bases.get(name)
      // First claim wins, in the order `basesForIndex` offers: `reads.bam.bai`
      // names one file exactly, so a directory holding both spellings pairs
      // each with its own rather than both with the first.
      if (base === undefined || indexOf.has(base)) continue
      indexOf.set(base, file)
      spent.add(file)
      break
    }
  }

  const out: PairedDrop[] = []
  for (const file of files) {
    if (spent.has(file)) continue
    const index = indexOf.get(file)
    out.push(index === undefined ? { file } : { file, index })
  }
  return out
}

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
    return {
      kind: 'remote',
      url: source.url,
      name: source.name,
      ...(remoteIndexFor(source) === undefined ? {} : { index: remoteIndexFor(source) as string }),
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
