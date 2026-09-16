/**
 * UCSC **track hubs**, read as stores (§24.10).
 *
 * ## Why a hub is a store and not a new idea
 *
 * A store is somebody's shelf of data written down once, with enough about each
 * row to choose without opening it (`state/store.ts`). A track hub is the same
 * object, declared in a format that predates this one by fifteen years and is
 * what most of the world's published genomics data is actually indexed by: a
 * `hub.txt` naming a `genomes.txt` naming a `trackDb.txt` per assembly, each
 * track a stanza with a `bigDataUrl` and a `type`.
 *
 * So this module is a **translation**, not a second catalogue system. It reads
 * the three files and produces a `StoreFile`, and from that point on a hub *is*
 * a store: the same table, the same facets, the same two verbs on every row, the
 * same `?store=` in the address bar, the same *remember this store*, the same
 * download. Nothing downstream of {@link hubStore} knows what a hub is, which is
 * the whole of what makes them first-class rather than bolted on.
 *
 * ## What a reader has to do
 *
 * Paste the `hub.txt` URL into the same box every other store URL goes into.
 * `fetchStore` recognises a hub and comes here, so a hub URL works in `?store=`,
 * in the Connect dialog, as a remembered tile and in a shared link — every road
 * a store URL already travels.
 *
 * ## The genome row, and why `.2bit` had to come first
 *
 * A hub's genome is one of two things, and the split runs through everything
 * here.
 *
 * An **assembly hub** carries its own sequence, as `twoBitPath` — always, and
 * only, a `.2bit`. That is why `annotations/twobit.ts` is part of this release
 * rather than a separate nicety: without it, every assembly hub in the world
 * opens as a set of tracks over coordinates this viewer cannot read. With it,
 * the genome row *is* the sequence, at two bits a base, read by range.
 *
 * A **db hub** names an assembly UCSC already hosts (`genome hg38`) and carries
 * no sequence at all. There is then nothing to open as the genome — so the row
 * falls back, in order, to the `chromSizes` the hub declares, and failing that
 * to the **first drawable bigWig or bigBed in its own trackDb**, whose header
 * carries every sequence and its exact length (§5.8). That last is not a
 * guess: it is the same door a dropped bigWig opens a browser through, and it
 * keeps the whole arrangement inside files the hub itself names. What this
 * deliberately does *not* do is reach for `hgdownload.soe.ucsc.edu` to fetch a
 * `chrom.sizes` nobody asked for: C1 says nothing leaves the machine that the
 * reader did not ask for, and a third-party request invented by a translation
 * layer is exactly that.
 *
 * ## What is refused, and where it is said
 *
 * A track whose `type` this viewer cannot draw gets **no row**, and is counted
 * in the store's description rather than being silently absent — `docs/stores.md`'s
 * rule for the IGV generator, applied here at read time. `cram` and `halSnake`
 * are the two that matter: the first is refused on its own grounds (GAPS.md, and
 * `browse/route.ts` says so where a reader meets one), and the second is a
 * server-side alignment format with no file behind it at all.
 */

import { canonicalUrl } from '../sources/rewrite'
import { STORE_KIND, STORE_VERSION, type StoreColumn, type StoreEntry, type StoreFile } from './store'

/** The columns a hub's rows are narrowed by. */
export const HUB_COLUMNS: readonly StoreColumn[] = [
  { key: 'assembly', label: 'Assembly' },
  { key: 'genome', label: 'Genome' },
  { key: 'role', label: 'Role' },
  { key: 'format', label: 'Format' },
  // The composite, super-track or view a subtrack hangs under. A hub's own
  // grouping, which is the thing its author spent their time on, and the one
  // column a reader of somebody else's hub will actually narrow by.
  { key: 'group', label: 'Group' },
]

// ---------------------------------------------------------------------------
// The stanza format
// ---------------------------------------------------------------------------

/** One stanza: `key value` lines, in the order they were written. */
export type Stanza = Map<string, string>

/**
 * Split a hub file into stanzas.
 *
 * The format is UCSC's `ra`: `key value` a line, a blank line between records,
 * `#` for a comment, and a trailing `\` continuing a line. Three details are
 * worth stating because real hubs exercise all of them.
 *
 * **Leading whitespace is meaningless.** Subtracks are conventionally indented
 * under their composite, and that indentation is presentation: what nests a
 * track is its `parent` line and nothing else. Stripping it is therefore not a
 * convenience, it is the format.
 *
 * **A repeated `startKey` begins a new record even with no blank line between.**
 * The specification asks for the blank line; hubs in the wild do not always have
 * one, particularly around indented subtracks, and a parser that insisted would
 * merge a composite and its first subtrack into one stanza whose `bigDataUrl`
 * belongs to neither. Keying on the record's *first* key is what the file means
 * either way.
 *
 * **A repeated key inside one stanza keeps the first.** `ra` is order-sensitive
 * and the first wins; the case that matters is a hub that sets `type` twice.
 */
export function parseStanzas(text: string, startKey?: string | readonly string[]): Stanza[] {
  const starts =
    startKey === undefined ? null : new Set(typeof startKey === 'string' ? [startKey] : startKey)
  const out: Stanza[] = []
  let current: Stanza | null = null
  let pending = ''
  for (const raw of text.split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // A continuation joins before anything else looks at the line, so a stanza
    // break cannot fall in the middle of one.
    if (pending !== '') {
      line = `${pending} ${line.trim()}`
      pending = ''
    }
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1).trimEnd()
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '') {
      current = null
      continue
    }
    if (trimmed.startsWith('#')) continue
    const at = trimmed.search(/\s/)
    const key = at < 0 ? trimmed : trimmed.slice(0, at)
    const value = at < 0 ? '' : trimmed.slice(at + 1).trim()
    if (current === null || (starts !== null && starts.has(key) && current.size > 0)) {
      current = new Map()
      out.push(current)
    }
    if (!current.has(key)) current.set(key, value)
  }
  return out
}

// ---------------------------------------------------------------------------
// hub.txt, genomes.txt, trackDb.txt
// ---------------------------------------------------------------------------

export interface HubHeader {
  /** `hub` — the hub's short identifier. */
  name: string
  shortLabel: string
  longLabel: string
  /** Relative to the `hub.txt`, or absent on a one-file hub. */
  genomesFile: string
  /** `useOneFile on`: the genome and track stanzas are in this same file. */
  oneFile: boolean
  descriptionUrl: string
  email: string
}

/**
 * Whether these bytes are a `hub.txt`.
 *
 * The `hub` key, and a `shortLabel` beside it. One key alone would match a
 * `trackDb.txt` whose first track is called `hub`, and neither appears in a
 * JSON store — which is the discrimination this is really for, since the two
 * arrive through the same box.
 */
export function looksLikeHub(text: string): boolean {
  const stanzas = parseStanzas(text)
  const first = stanzas[0]
  if (first === undefined) return false
  return first.has('hub') && (first.has('shortLabel') || first.has('genomesFile'))
}

/** `…/hub.txt` — the name the convention fixes, which is what a reader pastes. */
export function looksLikeHubUrl(url: string): boolean {
  return /(^|\/)[^/?#]*hub[^/?#]*\.txt(\?|#|$)/i.test(url)
}

/**
 * Whether this text carries the genomes as well as the hub line.
 *
 * What tells a whole hub from its first file — and so what decides whether a
 * pasted text can be read at all, since pasting leaves nothing to fetch the
 * rest from.
 */
export function hasGenomeStanzas(text: string): boolean {
  return parseStanzas(text, ['hub', 'genome', 'track']).some((stanza) => stanza.has('genome'))
}

export function parseHubHeader(text: string): HubHeader | null {
  const stanza = parseStanzas(text)[0]
  if (stanza === undefined || !stanza.has('hub')) return null
  return {
    name: stanza.get('hub') ?? '',
    shortLabel: stanza.get('shortLabel') ?? '',
    longLabel: stanza.get('longLabel') ?? '',
    genomesFile: stanza.get('genomesFile') ?? '',
    oneFile: /^on$/i.test(stanza.get('useOneFile') ?? ''),
    descriptionUrl: stanza.get('descriptionUrl') ?? '',
    email: stanza.get('email') ?? '',
  }
}

export interface HubGenome {
  /** The assembly name: `hg38`, or an assembly hub's own identifier. */
  assembly: string
  /** A human name where the hub gives one — `organism`, else `description`. */
  label: string
  /** Relative to `genomes.txt`. Absent on a one-file hub. */
  trackDb: string
  /** An assembly hub's own sequence. The reason `.2bit` is in this release. */
  twoBitPath: string
  chromSizes: string
  description: string
  defaultPos: string
}

export function parseHubGenomes(text: string): HubGenome[] {
  const out: HubGenome[] = []
  for (const stanza of parseStanzas(text, 'genome')) {
    const assembly = stanza.get('genome') ?? ''
    if (assembly === '') continue
    const organism = stanza.get('organism') ?? ''
    const description = stanza.get('description') ?? ''
    out.push({
      assembly,
      label: organism !== '' ? organism : description !== '' ? description : assembly,
      trackDb: stanza.get('trackDb') ?? '',
      twoBitPath: stanza.get('twoBitPath') ?? '',
      chromSizes: stanza.get('chromSizes') ?? '',
      description,
      defaultPos: stanza.get('defaultPos') ?? stanza.get('defaultPosition') ?? '',
    })
  }
  return out
}

/** One stanza of a `trackDb.txt` that names a file. */
export interface HubTrack {
  track: string
  shortLabel: string
  longLabel: string
  /** The `type` word, lower-cased: `bigwig`, `bigbed`, `vcftabix`, `hic`, … */
  type: string
  /** Relative to the `trackDb.txt`. */
  bigDataUrl: string
  /** A sidecar the hub names outright — a `.tbi` or `.bai` at an odd address. */
  bigDataIndex: string
  /** The `parent` or `superTrack` this hangs under, by track name. */
  parent: string
  /** `true` for a composite, super-track or view: a heading, not a file. */
  container: boolean
}

export function parseTrackDb(text: string): HubTrack[] {
  const out: HubTrack[] = []
  for (const stanza of parseStanzas(text, 'track')) {
    const track = stanza.get('track') ?? ''
    if (track === '') continue
    // `parent <name> [on|off]` — the visibility word is not part of the name.
    const parent = (stanza.get('parent') ?? stanza.get('superTrack') ?? '').split(/\s+/)[0] ?? ''
    const container =
      /^on$/i.test(stanza.get('compositeTrack') ?? '') ||
      /^on$/i.test(stanza.get('superTrack') ?? '') ||
      stanza.has('container') ||
      (stanza.get('view') ?? '') !== ''
    out.push({
      track,
      shortLabel: stanza.get('shortLabel') ?? '',
      longLabel: stanza.get('longLabel') ?? '',
      // `type bigBed 9 +` — the format is the first word and the rest is its
      // arity, which nothing here needs: this viewer reads a bigBed's real
      // column count out of the file.
      type: (stanza.get('type') ?? '').split(/\s+/)[0].toLowerCase(),
      bigDataUrl: stanza.get('bigDataUrl') ?? '',
      bigDataIndex: stanza.get('bigDataIndex') ?? '',
      parent: parent === track ? '' : parent,
      container,
    })
  }
  return out
}

/** `include other.txt` lines, which a trackDb may use to split itself up. */
export function includesOf(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('include ')) continue
    const named = line.slice('include '.length).trim()
    if (named !== '') out.push(named)
  }
  return out
}

// ---------------------------------------------------------------------------
// What this viewer can draw
// ---------------------------------------------------------------------------

/**
 * A hub `type` word → what this viewer calls the format, or `null` to refuse.
 *
 * The list is UCSC's own set of remote data types, and every entry in it is a
 * decision this release either already made or has just made. The five new ones
 * are the reason a hub is worth reading at all: before them, `bigInteract`,
 * `longTabix` and `bigMethyl` tracks would each have got a row that drew the
 * wrong picture when it was pressed, which is worse than no row.
 */
const HUB_TYPES: Record<string, string> = {
  bigwig: 'bigWig',
  bigbed: 'bigBed',
  bignarrowpeak: 'bigNarrowPeak',
  biggenepred: 'bigGenePred',
  bigpsl: 'bigPsl',
  bigchain: 'bigChain',
  bigmaf: 'bigMaf',
  biglolly: 'bigLolly',
  bigdbsnp: 'bigDbSnp',
  bigrmsk: 'bigRmsk',
  bigbarchart: 'bigBarChart',
  barchart: 'barChart',
  biginteract: 'bigInteract',
  interact: 'interact',
  bigmethyl: 'bigMethyl',
  bedmethyl: 'bedMethyl',
  longtabix: 'longrange',
  vcftabix: 'VCF',
  bam: 'BAM',
  hic: 'hic',
}

/**
 * Why a track is not offered, or `null` when it is.
 *
 * Named rather than counted, because the two refusals here are the two a reader
 * is most likely to go looking for — and because "your hub has 40 tracks and
 * this shows 38" with no reason is the kind of silence this project spends its
 * comments avoiding.
 */
export function hubRefusal(type: string): string | null {
  if (HUB_TYPES[type] !== undefined) return null
  if (type === 'cram') {
    return 'CRAM needs the exact reference its records were compressed against, which this viewer will not fetch'
  }
  if (type === 'halsnake' || type === 'hal') {
    return 'HAL alignments are drawn by a server, and there is no file behind one to read'
  }
  if (type === '') return 'the stanza names no type'
  return `no reader for type ${type}`
}

/** The format label for a drawable type. */
export function hubFormat(type: string): string | null {
  return HUB_TYPES[type] ?? null
}

/** `true` for the two types whose header carries an assembly (§5.8). */
function declaresAssembly(type: string): boolean {
  return type.startsWith('big') && type !== 'bigmethyl' && type !== 'bigbarchart'
}

// ---------------------------------------------------------------------------
// Hub → store
// ---------------------------------------------------------------------------

/** One genome's trackDb, as read. */
export interface HubGenomeTracks {
  genome: HubGenome
  tracks: readonly HubTrack[]
  /** The URL its `trackDb` was read from, which its `bigDataUrl`s resolve against. */
  trackDbUrl: string
}

export interface HubStoreOptions {
  header: HubHeader
  /** The URL the `hub.txt` was read from. */
  hubUrl: string
  genomes: readonly HubGenomeTracks[]
  /** The URL `genomes.txt` was read from; an assembly's own files resolve against it. */
  genomesUrl: string
}

/**
 * A hub, as the store it is.
 *
 * Two rows per drawable track is tempting and wrong: one row is the file, and
 * what a reader wants of a *genome* is the sequence with its tracks on it. So
 * the genome gets one row carrying `tracks`, which the shell turns into the
 * shelf offered after it opens (`App.noteShelf`), and every track gets a row of
 * its own for the reader who wants one file over their own map. That is exactly
 * the arrangement the IGV store arrived at (`docs/stores.md`), reached
 * independently from the same two questions.
 */
export function hubStore(options: HubStoreOptions): StoreFile {
  const { header, hubUrl, genomes, genomesUrl } = options
  const entries: StoreEntry[] = []
  let refused = 0
  const reasons = new Map<string, number>()

  for (const held of genomes) {
    const { genome, tracks, trackDbUrl } = held
    const drawable: Array<{ track: HubTrack; url: string; format: string }> = []
    for (const track of tracks) {
      if (track.bigDataUrl === '') continue // a composite, a view, a heading
      const format = hubFormat(track.type)
      if (format === null) {
        refused++
        const why = hubRefusal(track.type) ?? 'unreadable'
        reasons.set(why, (reasons.get(why) ?? 0) + 1)
        continue
      }
      drawable.push({ track, url: withIndex(resolve(track.bigDataUrl, trackDbUrl), track, trackDbUrl), format })
    }

    const label = genome.label === genome.assembly ? genome.assembly : `${genome.label} (${genome.assembly})`
    // The shelf is **annotations**, and a contact map is not one. A `type hic`
    // track has a row of its own that opens through the map door, and putting
    // it here as well would hand it to the annotation loader, which reads it as
    // text, sniffs it as a BED and reports that all 32,918 of its lines failed
    // the contig/start/end test — a true sentence about the wrong question.
    // What a reader wants from a hub's map is to open it as a map, and that row
    // already does.
    const shelf = drawable
      .filter((held_) => !isContactMap(held_.track))
      .map((held_) => ({ label: labelOf(held_.track), url: held_.url }))
    const sequence = sequenceFor(genome, genomesUrl, drawable)
    if (sequence !== null) {
      entries.push({
        label,
        uri: sequence.uri,
        kind: 'genome',
        note: sequence.note,
        fields: {
          assembly: genome.assembly,
          genome: genome.label,
          role: 'sequence',
          format: sequence.format,
          ...(genome.description === '' ? {} : { group: genome.description }),
        },
        ...(shelf.length === 0 ? {} : { tracks: shelf }),
      })
    }

    for (const { track, url, format } of drawable) {
      // A `.hic` is a contact map and goes through the map door; everything else
      // annotates a genome. `kindOf` would work this out from the name, and is
      // not asked: a hub states the type outright, which is better evidence than
      // any suffix, and plenty of `bigDataUrl`s end in `?token=…`.
      entries.push({
        label: labelOf(track),
        uri: url,
        kind: track.type === 'hic' ? 'map' : 'genome',
        ...(track.longLabel === '' || track.longLabel === track.shortLabel
          ? {}
          : { note: track.longLabel }),
        fields: {
          assembly: genome.assembly,
          genome: genome.label,
          role: 'annotation',
          format,
          ...(track.parent === '' ? {} : { group: track.parent }),
        },
      })
    }
  }

  return {
    kind: STORE_KIND,
    version: STORE_VERSION,
    name: header.shortLabel !== '' ? header.shortLabel : header.name !== '' ? header.name : hubUrl,
    description: describe(header, genomes.length, refused, reasons),
    source: hubUrl,
    columns: [...HUB_COLUMNS],
    entries,
  }
}

/**
 * What the genome row opens, and what to call it.
 *
 * The ladder the module header describes. `null` where a db hub carries neither
 * a `chromSizes` nor a track whose header declares an assembly — a hub of
 * nothing but BAMs and VCFs against `hg38`, which is legal and which this cannot
 * open a genome from. The tracks still get their rows; what is missing is the
 * one row that would have been the assembly, and inventing a `hgdownload` URL
 * for it is the third-party request this refuses to make.
 */
function sequenceFor(
  genome: HubGenome,
  genomesUrl: string,
  drawable: ReadonlyArray<{ track: HubTrack; url: string; format: string }>,
): { uri: string; note: string; format: string } | null {
  if (genome.twoBitPath !== '') {
    return {
      uri: resolve(genome.twoBitPath, genomesUrl),
      note: `The hub’s own sequence for ${genome.assembly}, two bits a base.`,
      format: '2bit',
    }
  }
  if (genome.chromSizes !== '') {
    return {
      uri: resolve(genome.chromSizes, genomesUrl),
      note: `${genome.assembly}: the sequence names and lengths this hub declares.`,
      format: 'chrom.sizes',
    }
  }
  const declaring = drawable.find((held) => declaresAssembly(held.track.type))
  if (declaring === undefined) return null
  return {
    uri: declaring.url,
    note:
      `${genome.assembly}: this hub names no sequence of its own, so the browser opens on the ` +
      `lengths in ${labelOf(declaring.track)}’s header.`,
    format: declaring.format,
  }
}

/**
 * Whether this track is a contact map rather than something drawn along an axis.
 *
 * One type, and it is the app's *primary* object rather than an annotation of
 * one — which is why it takes the map door in `hubStore` and is kept off the
 * track shelf.
 */
function isContactMap(track: HubTrack): boolean {
  return track.type === 'hic'
}

/** A track's display name: its `shortLabel`, or the identifier it was declared under. */
function labelOf(track: HubTrack): string {
  return track.shortLabel !== '' ? track.shortLabel : track.track
}

/**
 * `#index=` for a hub that names its sidecar somewhere unguessable.
 *
 * `bigDataIndex` exists precisely for the BAM or tabix file whose index is not
 * `<url>.bai` — which is the one case `annotations/sidecar.ts`'s guess cannot
 * cover — and the fragment is how this app carries that fact alongside the
 * address (§8.13). Where the hub is silent the guess still applies, exactly as
 * it does for a pasted URL.
 */
function withIndex(url: string, track: HubTrack, base: string): string {
  if (track.bigDataIndex === '') return url
  return `${url}#index=${resolve(track.bigDataIndex, base)}`
}

/**
 * A hub-relative path against the file that named it.
 *
 * `canonicalUrl` first, so a hub pointing at `s3://` or a Drive share link
 * resolves to the address that will actually be fetched (§24.5) — hubs do carry
 * those, and a bucket URL run through `new URL(…, base)` would come out as a
 * path under the hub.
 */
function resolve(path: string, base: string): string {
  const canonical = canonicalUrl(path)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(canonical)) return canonical
  try {
    return new URL(canonical, base).href
  } catch {
    return canonical
  }
}

// ---------------------------------------------------------------------------
// Reading one
// ---------------------------------------------------------------------------

/**
 * How this module asks for a file.
 *
 * `null` for anything that did not come back — a 404 on one genome's trackDb is
 * a genome without tracks, not the end of a hub, and this returns what it read
 * rather than a diagnosis. `state/store.ts` owns the fetching, the signing and
 * the error wording, and hands the bytes here; the same separation
 * `annotations/fai.ts` keeps, and it is what lets every case below be pinned by
 * a test with no network in it.
 */
export type ReadHubFile = (url: string) => Promise<string | null>

/** How many `include` hops a trackDb may take before this stops following. */
const INCLUDE_DEPTH = 4

/** How many files one hub may read in total, so a cycle cannot become a crawl. */
const FILE_BUDGET = 64

/**
 * Read a hub, from its `hub.txt` text, into the store it stands for.
 *
 * Three shapes, and the first is increasingly the common one.
 *
 * **One file.** `useOneFile on` puts the hub, genome and track stanzas in the
 * single file already read, which is what UCSC now recommends for a hub of a
 * handful of tracks. Nothing further is fetched.
 *
 * **hub.txt → genomes.txt → trackDb.txt**, the original arrangement, and the one
 * every large hub uses.
 *
 * **A hub whose genomes cannot be read** — a `genomesFile` that 404s — comes
 * back as a store with no entries rather than as an error, because the hub
 * header is still worth showing and the reason is in the description. What is
 * refused outright is text that is not a hub at all, which `fetchStore` has
 * already decided before calling this.
 */
export async function readHub(
  hubUrl: string,
  text: string,
  read: ReadHubFile,
): Promise<StoreFile | null> {
  const header = parseHubHeader(text)
  if (header === null) return null
  let budget = FILE_BUDGET
  const fetchOne = async (url: string): Promise<string | null> => {
    if (budget <= 0) return null
    budget--
    return read(url)
  }

  // `useOneFile on` — **or** a text that simply has genome stanzas in it, which
  // is the same file by another route and is what a **pasted** hub looks like:
  // somebody's `hub.txt`, `genomes.txt` and `trackDb.txt` one after another in a
  // box (§24.10). Concatenating them *is* a one-file hub in every respect that
  // matters here, because the only keys it loses are the two that say where the
  // next file is, and the next file is already in hand. A real three-file
  // `hub.txt` has no `genome` stanza, so this can never fire on one by mistake.
  if (header.oneFile || hasGenomeStanzas(text)) {
    return hubStore({
      header,
      hubUrl,
      genomes: oneFileGenomes(text, hubUrl),
      genomesUrl: hubUrl,
    })
  }

  const genomesUrl = header.genomesFile === '' ? hubUrl : resolve(header.genomesFile, hubUrl)
  const genomesText = header.genomesFile === '' ? null : await fetchOne(genomesUrl)
  const genomes = genomesText === null ? [] : parseHubGenomes(genomesText)
  const held: HubGenomeTracks[] = []
  for (const genome of genomes) {
    if (genome.trackDb === '') {
      held.push({ genome, tracks: [], trackDbUrl: genomesUrl })
      continue
    }
    const trackDbUrl = resolve(genome.trackDb, genomesUrl)
    const tracks = await readTrackDb(trackDbUrl, fetchOne, INCLUDE_DEPTH)
    held.push({ genome, tracks, trackDbUrl })
  }
  return hubStore({ header, hubUrl, genomes: held, genomesUrl })
}

/**
 * A `trackDb.txt` and whatever it `include`s.
 *
 * An included file's `bigDataUrl`s resolve against **its own** address, not the
 * including one, which is why the tracks come back already resolved rather than
 * as stanzas to be resolved later by a caller holding the wrong base. Depth is
 * bounded because `include` cycles exist and a hub is somebody else's file.
 */
async function readTrackDb(
  url: string,
  read: ReadHubFile,
  depth: number,
  seen = new Set<string>(),
): Promise<HubTrack[]> {
  if (depth <= 0 || seen.has(url)) return []
  seen.add(url)
  const text = await read(url)
  if (text === null) return []
  const out = parseTrackDb(text).map((track) => ({
    ...track,
    // Resolved here, against the file that named it, and marked absolute so
    // `hubStore` leaves it alone.
    bigDataUrl: track.bigDataUrl === '' ? '' : resolve(track.bigDataUrl, url),
    bigDataIndex: track.bigDataIndex === '' ? '' : resolve(track.bigDataIndex, url),
  }))
  for (const named of includesOf(text)) {
    out.push(...(await readTrackDb(resolve(named, url), read, depth - 1, seen)))
  }
  return out
}

/**
 * A `useOneFile on` hub's genomes, with each one's tracks under it.
 *
 * The file is stanzas in order — the hub, then a genome, then its tracks, then
 * perhaps another genome — so the tracks belong to whichever `genome` stanza
 * they follow. Ordering *is* the nesting here, which is the one place in this
 * format where that is true, and it is why this cannot go through
 * {@link parseTrackDb} over the whole text: that would give one flat list with
 * no way back to which assembly each track was under.
 *
 * A track before any genome stanza is dropped. There is no assembly to draw it
 * against, and a one-file hub that begins with tracks is malformed rather than
 * ambiguous.
 */
export function oneFileGenomes(text: string, url: string): HubGenomeTracks[] {
  const out: HubGenomeTracks[] = []
  let current: { genome: HubGenome; tracks: HubTrack[] } | null = null
  for (const stanza of parseStanzas(text, ['hub', 'genome', 'track'])) {
    if (stanza.has('hub')) continue
    if (stanza.has('genome')) {
      const parsed = parseHubGenomes(stanzaText(stanza))[0]
      if (parsed === undefined) continue
      current = { genome: parsed, tracks: [] }
      out.push({ genome: parsed, tracks: current.tracks, trackDbUrl: url })
      continue
    }
    if (!stanza.has('track') || current === null) continue
    const track = parseTrackDb(stanzaText(stanza))[0]
    if (track === undefined) continue
    current.tracks.push({
      ...track,
      bigDataUrl: track.bigDataUrl === '' ? '' : resolve(track.bigDataUrl, url),
      bigDataIndex: track.bigDataIndex === '' ? '' : resolve(track.bigDataIndex, url),
    })
  }
  return out
}

/**
 * A stanza back as text, so one parser reads it however it arrived.
 *
 * The alternative is a second reader for each record type — one over a `Map`
 * and one over lines — and two readers of one format is how the one-file hub
 * and the three-file hub come to disagree about what `superTrack` means.
 */
function stanzaText(stanza: Stanza): string {
  return [...stanza].map(([key, value]) => `${key} ${value}`).join('\n')
}

/** The line under the store's name: what the hub says it is, and what was dropped. */
function describe(
  header: HubHeader,
  genomes: number,
  refused: number,
  reasons: ReadonlyMap<string, number>,
): string {
  const parts: string[] = []
  if (header.longLabel !== '' && header.longLabel !== header.shortLabel) parts.push(header.longLabel)
  parts.push(`${genomes} ${genomes === 1 ? 'assembly' : 'assemblies'}`)
  if (refused > 0) {
    const why = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} — ${reason}`)
      .join('; ')
    parts.push(`${refused} ${refused === 1 ? 'track' : 'tracks'} not offered (${why})`)
  }
  return parts.join(' · ')
}
