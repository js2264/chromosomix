/**
 * A store: somebody else's shelf of maps, as one static JSON file.
 *
 * The viewer opens a file a reader already has the URL of. That is the whole of
 * what it could do for a published collection until now, and it is the wrong
 * shape for one: the 4DN open-data bucket holds 2,367 files this app can read,
 * every one of them named by an accession, and a reader who wants *in situ Hi-C
 * on GM12878* cannot get there from a list of names. Choosing needs the metadata
 * the accession stands for — assembly, biosource, assay, lab — and that metadata
 * is a join a browser has no business doing at runtime (docs/remote-sources.md
 * §5, shape A).
 *
 * So a store is that join, written down once by whoever publishes the data: a
 * JSON file on any CORS-enabled host, listing entries with enough about each one
 * to pick without opening it (§24.1). `scripts/make_store.py` writes them from the 4DN and
 * ENCODE APIs; a lab writes one by hand for its own bucket; `ui/examples.ts`
 * carries one inline for the demos. All three are the same file, and this module
 * is the only thing that reads it.
 *
 * ## Why it is not a folder listing
 *
 * `browse/folder.ts` already lists a bucket prefix, and mapping a store onto it
 * was the first draft. It is wrong for one reason that decides the whole shape:
 * a folder row has a *name*, and six hundred rows are chosen by **filtering** on
 * things that are not names. `FolderListing` has nowhere to put a biosource, so
 * a store forced through it would draw exactly the flat list of opaque accessions
 * the format exists to replace. A store therefore declares its own `columns`,
 * every entry carries `fields`, and `ui/StoreTable.ts` renders a table rather than
 * a tree.
 *
 * ## Why entries may be relative
 *
 * The same argument `resolveConfig` makes for a workspace, and the same
 * machinery: a folder of data is a thing that gets copied — to another bucket,
 * to a colleague's, to a directory served off a laptop — and a catalogue naming
 * its own files absolutely is right in exactly one of those places. So a name is
 * resolved against the store's `base`, or against the store's own URL when it
 * declares none, and a store with no `base` and relative names is a self-contained
 * folder exactly as `demo/yeast/` is.
 *
 * ## What this module refuses
 *
 * Identity is strict and fields are forgiving (§24.1), which is `state/workspace.ts`'s
 * rule and is here for the same reason: a JSON that does not say it is a store is
 * not one — a reader who points `?store=` at a `package.json` should be told so,
 * not shown an empty table — while an entry missing a field is dropped rather
 * than made fatal, because a catalogue of six hundred rows with one bad row is
 * still a catalogue of 599 good ones, and refusing the file would hide all of
 * them to complain about one.
 */

import { formatUri, parseUri } from '../uri'
import { routeOf } from '../browse/route'
import { accessHeadersFor, credentialFor } from '../s3/credentials'
import { applyAccess } from '../sources/access'
import { canonicalUrl } from '../sources/rewrite'
import { looksLikeConfig, type ConfigRefusal } from './SessionConfig'
import { hasGenomeStanzas, looksLikeHub, parseHubHeader, readHub } from './hub'

/** What a store file must call itself. */
export const STORE_KIND = 'metacooler.store'

/**
 * The format version this build reads.
 *
 * Bumped only when a field this build already reads comes to mean something
 * else — the rule `state/workspace.ts` states at length. A *new* field is not a
 * bump: unknown keys are ignored here, so a v1 reader meeting a v1 file written
 * by a later generator loses the new column and keeps the catalogue.
 */
export const STORE_VERSION = 1

/** A table column after the implicit Name column; every column is filterable and sortable. */
export interface StoreColumn {
  key: string
  label: string
}

/** Which of the app's front doors an entry goes through. */
export type StoreEntryKind = 'map' | 'genome' | 'workspace'

/** One row of a store. */
export interface StoreEntry {
  /** Required. The Name column. */
  label: string
  /**
   * Required. Relative to the store's `base` (or to the store's own URL directory
   * when `base` is absent), or absolute. May carry `::group` and
   * `#index=`/`#bins=` exactly as any URI. An absolute URI with any scheme
   * (`https:`, `s3:`, `gs:`) passes through untouched.
   */
  uri: string
  /** Defaulted from the file name when absent: `.json` → workspace, else `routeOf(uri)`. */
  kind: StoreEntryKind
  /** Bytes, when known; lets the table warn about a 5 GB row before it is clicked. */
  size?: number
  /** Free text: accession, publication, condition. Shown in the row, searchable. */
  note?: string
  /** Values for the store's columns, by column key. Missing keys render empty. */
  fields?: Record<string, string>
  /** Companion tracks to offer after the entry opens (resolved like `uri`). */
  tracks?: Array<{ label: string; url: string }>
}

/** A whole store file. */
export interface StoreFile {
  kind: typeof STORE_KIND
  version: number
  name: string
  description?: string
  /** ISO 8601, when a generator wrote it. */
  generatedAt?: string
  /** Provenance: the query or repository the entries came from. */
  source?: string
  /** Absolute URL prefix ending in `/`. Default: the directory of the store's own URL. */
  base?: string
  columns: StoreColumn[]
  entries: StoreEntry[]
}

/**
 * A store the viewer can offer, before anything has been fetched.
 *
 * Two arms and they are the point: a built-in catalogue that ships inside the
 * bundle costs no request at all, and every other one is a URL that is not
 * touched until a reader asks for it. Nothing in this app fetches a store on
 * load (SPECS C1's neighbour: nothing leaves the machine that the reader did
 * not ask for; §24.2), so a reference is what a front holds and `fetchStore`
 * is what a gesture runs.
 *
 * It lives here rather than in `ui/stores/registry.ts` because three modules
 * name it — the registry, the remembered-rows store, and the fronts — and the
 * one that owns the *type* of a store should own the type of a pointer to one.
 */
export interface StoreRef {
  /** `'rsg' | 'igv' | '4dn' | 'encode-sessions' | …` for the built-ins, `'store:<n>'` for a remembered one. */
  id: string
  label: string
  /** Inline file (the lab's own demos), already absolute. */
  inline?: StoreFile
  /** Or a URL to fetch on the reader's gesture. */
  url?: string
  builtin: boolean
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A field of `row`, when it is a non-empty string. */
function text(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The columns a store declares, in the order it declares them.
 *
 * A column with no `key` is dropped — the key is what an entry's `fields` are
 * looked up by, so a keyless column is a header over a permanently empty cell —
 * and a column with no `label` is drawn under its key, because a header that
 * says `biosource` is a worse table than one that says `Biosource` and a much
 * better one than a blank.
 */
function readColumns(value: unknown): StoreColumn[] {
  if (!Array.isArray(value)) return []
  const out: StoreColumn[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const key = text(row, 'key')
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    out.push({ key, label: text(row, 'label') ?? key })
  }
  return out
}

/** `fields`, keeping only the string values a table cell can hold. */
function readFields(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
    if (typeof held === 'string' && held !== '') out[key] = held
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** `tracks`, keeping only the pairs that name both halves. */
function readTracks(value: unknown): Array<{ label: string; url: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Array<{ label: string; url: string }> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const url = text(row, 'url')
    if (url === undefined) continue
    out.push({ label: text(row, 'label') ?? url, url })
  }
  return out.length === 0 ? undefined : out
}

/**
 * What opening an entry would do, when the file does not say.
 *
 * `.json` is a workspace — it is the only name in this app that means *a whole
 * session* rather than a byte source — and everything else is routed by the one
 * table that routes every other name in the application (`browse/route.ts`), so
 * a store row and a dropped file cannot come to disagree about what a `.bedpe` is.
 *
 * A name the router has no route for lands on `'map'` rather than being dropped,
 * and that is deliberate. A folder listing draws what it cannot open, dimmed,
 * because it must agree with the folder; a store is a **curated** list, and the
 * names it carries are routinely ones no extension can settle — an S3 key with
 * no suffix, a presigned URL whose name is buried in its query, a portal's
 * `@@download` address. Refusing those would silently shorten somebody's
 * catalogue; offering them puts the reader where pasting the same URL puts
 * them, which is the file's own error message if it is not a map after all.
 */
export function kindOf(uri: string): StoreEntryKind {
  const path = parseUriPath(uri)
  if (looksLikeConfig(path.split(/[?#]/)[0])) return 'workspace'
  return routeOf(uri) === 'genome' ? 'genome' : 'map'
}

/** The file half of a URI, without throwing on one that names no file. */
function parseUriPath(uri: string): string {
  try {
    return parseUri(uri).path
  } catch {
    return uri
  }
}

/**
 * Read a store out of a file's text, or refuse it.
 *
 * The three refusals are `state/SessionConfig.ts`'s, plus one of this format's
 * own: `'not-a-store'`, for a JSON file that parses and is something else. It is a
 * separate reason from `'not-a-workspace'` because the two files are offered
 * through different doors and the fix differs — one is written by the save
 * button, the other by a generator — and a reader who pasted a workspace URL
 * into the store box deserves to be told which of the two they have.
 */
export function parseStore(text_: string): StoreFile | ConfigRefusal {
  let parsed: unknown
  try {
    parsed = JSON.parse(text_)
  } catch {
    return { reason: 'not-json' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { reason: 'not-a-store' }
  const row = parsed as Record<string, unknown>
  if (row['kind'] !== STORE_KIND) return { reason: 'not-a-store' }

  // The same gate `parseWorkspaceFile` applies, for the same reason: a version
  // is a claim about what every other field in the file *means*, so a file from
  // a newer build is refused rather than read as though it were current. A
  // `version` that is not a whole number is not a version at all — this format
  // has no minor versions to be at — so it fails identity rather than being
  // rounded into one.
  const declared = row['version']
  if (declared !== undefined && (typeof declared !== 'number' || !Number.isInteger(declared))) {
    return { reason: 'not-a-store' }
  }
  const version = typeof declared === 'number' ? declared : STORE_VERSION
  if (version > STORE_VERSION) {
    const producer = row['producer']
    return {
      reason: 'newer',
      version,
      ...(typeof producer === 'string' && producer !== '' ? { producer } : {}),
    }
  }

  const entries: StoreEntry[] = []
  for (const held of Array.isArray(row['entries']) ? (row['entries'] as unknown[]) : []) {
    if (typeof held !== 'object' || held === null) continue
    const entry = held as Record<string, unknown>
    const label = text(entry, 'label')
    const uri = text(entry, 'uri')
    // Dropped, not fatal. A row with no name cannot be offered and a row with
    // no address cannot be opened; either way it is one row of a catalogue and
    // not a reason to hide the rest of it.
    if (label === undefined || uri === undefined) continue
    const declaredKind = entry['kind']
    const kind =
      declaredKind === 'map' || declaredKind === 'genome' || declaredKind === 'workspace'
        ? declaredKind
        : kindOf(uri)
    const size = entry['size']
    const note = text(entry, 'note')
    const fields = readFields(entry['fields'])
    const tracks = readTracks(entry['tracks'])
    entries.push({
      label,
      uri,
      kind,
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
      ...(note === undefined ? {} : { note }),
      ...(fields === undefined ? {} : { fields }),
      ...(tracks === undefined ? {} : { tracks }),
    })
  }

  const description = text(row, 'description')
  const generatedAt = text(row, 'generatedAt')
  const source = text(row, 'source')
  const base = text(row, 'base')
  return {
    kind: STORE_KIND,
    version,
    // An unnamed store is legal and common — a `make_store.py bucket` run over a
    // prefix has no name but the one the reader gave the row it arrived on — so
    // the table falls back to the reference's label rather than this refusing.
    name: text(row, 'name') ?? '',
    ...(description === undefined ? {} : { description }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(source === undefined ? {} : { source }),
    ...(base === undefined ? {} : { base }),
    columns: readColumns(row['columns']),
    entries,
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Point every name in a store at wherever the store itself was found.
 *
 * `resolveConfig`'s job, over a catalogue instead of a session, and through the
 * same `parseUri`/`formatUri` pair so that `::entries/rep1` survives being
 * resolved: the group names a path *inside* the file and is no part of the URL
 * arithmetic. Absolute URIs are untouched whatever their scheme, so a store may
 * mix the two — a catalogue of a lab's own bucket that also points at two files
 * on 4DN is a reasonable thing to write.
 *
 * `base` wins over the store's own URL when it is there, which is what lets a store
 * published at the root of a site describe a bucket somewhere else. It is itself
 * resolved against `storeUrl` first, so `"base": "data/"` means what it looks
 * like, and a missing trailing slash is repaired rather than refused — URL
 * resolution would otherwise quietly drop the last segment of the prefix and
 * every entry would land one directory up.
 *
 * ## The index fragment is resolved too
 *
 * `#index=<url>` names a sidecar that is a *separate file* (`annotations/
 * sidecar.ts`), and plain URL resolution leaves the inside of a fragment alone —
 * so a store naming `reads.bam#index=reads.bam.bai` relatively would come out with
 * an absolute BAM and a `.bai` that resolves against the page the viewer is
 * served from. That is the one place where "copy the folder with its data" quietly
 * stops holding, so both halves are resolved. An absolute index is untouched,
 * which is what every generated store writes.
 */
export function resolveStore(store: StoreFile, storeUrl: string): StoreFile {
  const base = resolveBase(store.base, storeUrl)
  const at = (uri: string): string => {
    let parsed
    try {
      parsed = parseUri(uri)
    } catch {
      // A URI with no file half is not one this can repair. `parseStore` already
      // dropped an entry naming nothing, so this is a `tracks[]` URL that is
      // only a group.
      return uri
    }
    return formatUri(resolveAddress(parsed.path, base), parsed.group)
  }

  return {
    ...store,
    ...(base === null ? {} : { base }),
    entries: store.entries.map((entry) => ({
      ...entry,
      uri: at(entry.uri),
      ...(entry.tracks === undefined
        ? {}
        : { tracks: entry.tracks.map((track) => ({ ...track, url: at(track.url) })) }),
    })),
  }
}

/** The absolute prefix entries are resolved against, or `null` when there is none. */
function resolveBase(base: string | undefined, storeUrl: string): string | null {
  if (base === undefined) return storeUrl === '' ? null : storeUrl
  const text_ = base.endsWith('/') ? base : `${base}/`
  if (storeUrl === '') return text_
  try {
    return new URL(text_, storeUrl).href
  } catch {
    return text_
  }
}

/** One address — the file half of a URI — made absolute, fragment and all. */
function resolveAddress(path: string, base: string | null): string {
  if (base === null) return path
  const hash = path.indexOf('#')
  const address = hash < 0 ? path : path.slice(0, hash)
  const fragment = hash < 0 ? '' : path.slice(hash)
  // Canonicalised once absolute (§24.5): a store may name a Dropbox share link, a
  // Drive file or a `gs://` object, and the row should carry the form that
  // opens — the same rewrite every URL box applies — so that what the picker
  // hands over, and what a shared link then carries, is already the working one.
  return `${canonicalUrl(absolute(address, base))}${resolveFragment(fragment, base)}`
}

/** `value` against `base`, or `value` when it is already absolute or will not resolve. */
function absolute(value: string, base: string): string {
  // Any scheme, not just `http(s):` — an `s3://` or `gs://` name in a store is an
  // address this app understands (`sources/rewrite.ts`), and `new URL` would
  // either mangle it or leave it alone depending on the scheme's own rules.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  if (value === '') return value
  try {
    return new URL(value, base).href
  } catch {
    return value
  }
}

/** `#index=<url>` / `#bins=<url>` with the URL inside them resolved. */
function resolveFragment(fragment: string, base: string): string {
  const named = /^#(index|bins)=(.+)$/.exec(fragment)
  if (named === null) return fragment
  return `#${named[1]}=${canonicalUrl(absolute(named[2], base))}`
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * What asking for a store answered with.
 *
 * A union rather than a throw, and **404 told apart from every other failure**,
 * because the table has a different sentence for it: the two generated stores the
 * app ships references to do not exist until the Stores workflow has run once, and
 * "the host answered 404" sends a reader to check a URL that is perfectly
 * correct. Everything else collapses to a message, since there is nothing a
 * reader can do differently about a 503 and a CORS refusal.
 */
export type StoreFetch =
  | { ok: true; store: StoreFile }
  /** The host has no such file. For a built-in, that means "not published yet". */
  | { ok: false; reason: 'missing'; message: string }
  /** The host answered, and not with the file. */
  | { ok: false; reason: 'http'; status: number; message: string }
  /** Nothing came back: no route, no CORS header, the tab went offline. */
  | { ok: false; reason: 'network'; message: string }
  /** Something came back and it is not a store. */
  | { ok: false; reason: 'refused'; refusal: ConfigRefusal; message: string }

export interface FetchStoreOptions {
  /** The `fetch` to use. Tests pass one; the app never does. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch one store, on a gesture, and hand back what came of it.
 *
 * One plain `GET` — a store is kilobytes and there is nothing to range over —
 * signed exactly as `Session.openConfigUrl` signs the fetch of a published
 * workspace, and for the same reason: a store in a private prefix is the natural
 * way for a lab to publish its own shelf, and this request being the one
 * unsigned link would make the whole arrangement fail at its first step.
 *
 * …or **three or more**, when those bytes turn out to be a UCSC track hub
 * (§24.10): a `hub.txt` names a `genomes.txt` which names a `trackDb.txt` per
 * assembly, and every one of them is read through the same signed `GET` below.
 * Still one gesture, and still nothing fetched before it.
 *
 * It never throws. Every road out is a value, because the caller is a table that
 * has to draw *something* whatever happened, and a rejected promise at a `<select>`
 * change handler is an empty table with the reason in the console.
 */
export async function fetchStore(url: string, options: FetchStoreOptions = {}): Promise<StoreFetch> {
  const run = options.fetchImpl ?? fetch
  const first = await fetchText(url, run)
  if (!first.ok) return first

  // A **track hub** is the other thing a reader pastes into the store box, and
  // it is one of these bytes rather than a second road: UCSC's `hub.txt` is the
  // format most published genomics data is indexed by, and `state/hub.ts`
  // translates one into exactly the `StoreFile` this function already returns.
  //
  // Recognised by the *content* and not by the URL, for §8.3's reason applied a
  // level up: a hub is routinely served from an address that says nothing — a
  // bucket key with no suffix, a `?download=1`, a redirect — and the first
  // stanza of the file says what it is without ambiguity. The name is consulted
  // nowhere, which is also why a store named `hub.txt` still opens as a store.
  //
  // Doing it *here* is what makes hubs first class: every road a store URL
  // travels — `?store=`, the Connect box, a remembered tile, a shared link, the
  // drawer's download — goes through this function, so none of them needed to
  // learn what a hub is.
  if (looksLikeHub(first.text)) {
    const store = await readHub(url, first.text, async (at) => {
      const got = await fetchText(at, run)
      return got.ok ? got.text : null
    })
    if (store !== null) return { ok: true, store: resolveStore(store, url) }
  }

  const parsed = parseStore(first.text)
  if ('reason' in parsed) {
    return { ok: false, reason: 'refused', refusal: parsed, message: '' }
  }
  return { ok: true, store: resolveStore(parsed, url) }
}

/**
 * One signed `GET`, as text, or the reason there is none.
 *
 * Split out of {@link fetchStore} because a hub is three files and each of them
 * wants the same signing, the same 404-is-a-state and the same CORS wording —
 * and because a second copy of that is a second place for a private bucket to
 * stop working.
 */
async function fetchText(
  url: string,
  run: typeof fetch,
): Promise<{ ok: true; text: string } | Exclude<StoreFetch, { ok: true }>> {
  let response: Response
  try {
    // Signed when a bucket scope covers the URL, and carrying whatever static
    // headers the URL needs (§24.7) — a store published on a Drive or GCS JSON-API
    // URL is read with the same key its rows will be.
    const credential = credentialFor(url)
    response = await run(
      url,
      applyAccess(undefined, {
        url,
        method: 'GET',
        headers: accessHeadersFor(url),
        ...(credential === null ? {} : { credential }),
      }),
    )
  } catch (err) {
    // A `TypeError` here is almost always the CORS answer the host did not
    // give, and saying so is more use than the browser's own "Failed to fetch":
    // the fix is a bucket setting, on a host the reader may well control.
    return {
      ok: false,
      reason: 'network',
      message:
        `${url} could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
        'The host must allow a cross-origin GET from this page.',
    }
  }
  if (response.status === 404) {
    return { ok: false, reason: 'missing', message: `${url} is not there: the host answered 404.` }
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'http',
      status: response.status,
      message: `${url} could not be read: the host answered ${response.status} ${response.statusText}.`,
    }
  }
  try {
    return { ok: true, text: await response.text() }
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      message: `${url} was cut off: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }
}

// ---------------------------------------------------------------------------
// …or pasted
// ---------------------------------------------------------------------------

/**
 * The same two formats, read from text somebody pasted rather than from a URL.
 *
 * ## Why this exists
 *
 * Because a URL is not always readable and is not always what a reader has.
 *
 * **CORS.** A store or a hub is fetched by the *page*, so the host has to allow
 * a cross-origin `GET`. Plenty do not — `genome.ucsc.edu` among them, which
 * means UCSC's own example hubs cannot be read from any browser-only viewer,
 * this one included. The file is public, the reader can see it in another tab,
 * and the one thing standing between them is a response header on somebody
 * else's server. Pasting the text is the way past that which does not involve
 * routing a reader's traffic through a proxy this project would then be asking
 * them to trust (C1).
 *
 * **Writing one.** A lab assembling its own shelf edits, pastes, sees what
 * broke and edits again. Asking them to publish a file to a bucket between each
 * of those is a loop nobody will run twice.
 *
 * ## One box, not three
 *
 * A hub is three files, and a paste box for each would be three boxes to keep
 * in step. It is not needed: `useOneFile on` is a hub in a single file, and a
 * `hub.txt`, `genomes.txt` and `trackDb.txt` **concatenated** are the same
 * thing — the only keys the concatenation loses are the two saying where the
 * next file is, and the next file is already in the box (`state/hub.ts`). So
 * one textarea reads every hub that can be read without fetching, and a text
 * that is *only* a `hub.txt` is refused by name rather than coming back as an
 * empty shelf.
 *
 * ## The base
 *
 * A pasted file has no address, so there is nothing for a relative
 * `bigDataUrl` or a relative `uri` to resolve against. Absolute names need no
 * base and are the common case; relative ones are refused with the count and
 * the first of them, so the reader knows what to paste into the base box rather
 * than being handed a shelf whose rows fail one at a time when they are
 * pressed.
 */
export async function storeFromText(text: string, base = ''): Promise<StoreFetch> {
  if (text.trim() === '') {
    return { ok: false, reason: 'refused', refusal: { reason: 'not-json' }, message: 'Nothing pasted.' }
  }
  const store = looksLikeHub(text) ? await hubFromText(text, base) : storeJsonFromText(text, base)
  if (!store.ok) return store
  // Relative names, which a pasted file has nothing to resolve against.
  const loose = store.store.entries.filter((entry) => !isAbsolute(entry.uri))
  if (loose.length > 0) {
    return {
      ok: false,
      reason: 'network',
      message:
        `${loose.length} ${loose.length === 1 ? 'row names its file' : 'rows name their files'} ` +
        `relatively — ${loose[0].uri} — and pasted text has no address for those to be relative ` +
        'to. Give the base URL they hang off, or paste a version with absolute URLs.',
    }
  }
  return store
}

/** `https:`, `s3:`, `gs:` — anything with a scheme, which needs no base. */
function isAbsolute(uri: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(uri)
}

async function hubFromText(text: string, base: string): Promise<StoreFetch> {
  if (!hasGenomeStanzas(text)) {
    const header = parseHubHeader(text)
    const named = header === null || header.genomesFile === '' ? 'genomes.txt' : header.genomesFile
    return {
      ok: false,
      reason: 'refused',
      refusal: { reason: 'not-a-store' },
      message:
        `This is the hub.txt alone: it names ${named}, which is not in the box and cannot be ` +
        'fetched from pasted text. Paste the genomes.txt and the trackDb.txt after it — a hub in ' +
        'one file is read exactly as three are — or give the hub’s URL instead.',
    }
  }
  // Nothing to fetch: every file a pasted hub has is the one in hand, so the
  // reader hands back nothing and `readHub` takes the one-file road.
  const store = await readHub(base, text, async () => null)
  if (store === null) {
    return {
      ok: false,
      reason: 'refused',
      refusal: { reason: 'not-a-store' },
      message: 'This starts like a hub and has no `hub` line this could read.',
    }
  }
  return { ok: true, store: base === '' ? store : resolveStore(store, base) }
}

function storeJsonFromText(text: string, base: string): StoreFetch {
  const parsed = parseStore(text)
  if ('reason' in parsed) return { ok: false, reason: 'refused', refusal: parsed, message: '' }
  return { ok: true, store: base === '' ? parsed : resolveStore(parsed, base) }
}
