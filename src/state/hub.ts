/**
 * A hub: somebody else's shelf of maps, as one static JSON file.
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
 * So a hub is that join, written down once by whoever publishes the data: a
 * JSON file on any CORS-enabled host, listing entries with enough about each one
 * to pick without opening it (§23.1). `scripts/make_hub.py` writes them from the 4DN and
 * ENCODE APIs; a lab writes one by hand for its own bucket; `ui/examples.ts`
 * carries one inline for the demos. All three are the same file, and this module
 * is the only thing that reads it.
 *
 * ## Why it is not a folder listing
 *
 * `browse/folder.ts` already lists a bucket prefix, and mapping a hub onto it
 * was the first draft. It is wrong for one reason that decides the whole shape:
 * a folder row has a *name*, and six hundred rows are chosen by **filtering** on
 * things that are not names. `FolderListing` has nowhere to put a biosource, so
 * a hub forced through it would draw exactly the flat list of opaque accessions
 * the format exists to replace. A hub therefore declares its own `columns`,
 * every entry carries `fields`, and `ui/HubTable.ts` renders a table rather than
 * a tree.
 *
 * ## Why entries may be relative
 *
 * The same argument `resolveConfig` makes for a workspace, and the same
 * machinery: a folder of data is a thing that gets copied — to another bucket,
 * to a colleague's, to a directory served off a laptop — and a catalogue naming
 * its own files absolutely is right in exactly one of those places. So a name is
 * resolved against the hub's `base`, or against the hub's own URL when it
 * declares none, and a hub with no `base` and relative names is a self-contained
 * folder exactly as `demo/yeast/` is.
 *
 * ## What this module refuses
 *
 * Identity is strict and fields are forgiving (§23.1), which is `state/workspace.ts`'s
 * rule and is here for the same reason: a JSON that does not say it is a hub is
 * not one — a reader who points `?hub=` at a `package.json` should be told so,
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

/** What a hub file must call itself. */
export const HUB_KIND = 'metacooler.hub'

/**
 * The format version this build reads.
 *
 * Bumped only when a field this build already reads comes to mean something
 * else — the rule `state/workspace.ts` states at length. A *new* field is not a
 * bump: unknown keys are ignored here, so a v1 reader meeting a v1 file written
 * by a later generator loses the new column and keeps the catalogue.
 */
export const HUB_VERSION = 1

/** A table column after the implicit Name column; every column is filterable and sortable. */
export interface HubColumn {
  key: string
  label: string
}

/** Which of the app's front doors an entry goes through. */
export type HubEntryKind = 'map' | 'genome' | 'workspace'

/** One row of a hub. */
export interface HubEntry {
  /** Required. The Name column. */
  label: string
  /**
   * Required. Relative to the hub's `base` (or to the hub's own URL directory
   * when `base` is absent), or absolute. May carry `::group` and
   * `#index=`/`#bins=` exactly as any URI. An absolute URI with any scheme
   * (`https:`, `s3:`, `gs:`) passes through untouched.
   */
  uri: string
  /** Defaulted from the file name when absent: `.json` → workspace, else `routeOf(uri)`. */
  kind: HubEntryKind
  /** Bytes, when known; lets the table warn about a 5 GB row before it is clicked. */
  size?: number
  /** Free text: accession, publication, condition. Shown in the row, searchable. */
  note?: string
  /** Values for the hub's columns, by column key. Missing keys render empty. */
  fields?: Record<string, string>
  /** Companion tracks to offer after the entry opens (resolved like `uri`). */
  tracks?: Array<{ label: string; url: string }>
}

/** A whole hub file. */
export interface Hub {
  kind: typeof HUB_KIND
  version: number
  name: string
  description?: string
  /** ISO 8601, when a generator wrote it. */
  generatedAt?: string
  /** Provenance: the query or repository the entries came from. */
  source?: string
  /** Absolute URL prefix ending in `/`. Default: the directory of the hub's own URL. */
  base?: string
  columns: HubColumn[]
  entries: HubEntry[]
}

/**
 * A hub the viewer can offer, before anything has been fetched.
 *
 * Two arms and they are the point: a built-in catalogue that ships inside the
 * bundle costs no request at all, and every other one is a URL that is not
 * touched until a reader asks for it. Nothing in this app fetches a hub on load
 * (SPECS C1's neighbour: nothing leaves the machine that the reader did not
 * ask for; §23.2), so a reference is what the picker holds and `fetchHub` is
 * what a gesture runs.
 *
 * It lives here rather than in `ui/examples.ts` because three modules name it —
 * the built-in list, the remembered-rows store, and the table — and the one
 * that owns the *type* of a hub should own the type of a pointer to one.
 */
export interface HubRef {
  /** `'demos' | '4dn' | 'encode'` for the built-ins, `'hub:<n>'` for a remembered one. */
  id: string
  label: string
  /** Inline hub (the demos), already absolute. */
  hub?: Hub
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
 * The columns a hub declares, in the order it declares them.
 *
 * A column with no `key` is dropped — the key is what an entry's `fields` are
 * looked up by, so a keyless column is a header over a permanently empty cell —
 * and a column with no `label` is drawn under its key, because a header that
 * says `biosource` is a worse table than one that says `Biosource` and a much
 * better one than a blank.
 */
function readColumns(value: unknown): HubColumn[] {
  if (!Array.isArray(value)) return []
  const out: HubColumn[] = []
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
 * a hub row and a dropped file cannot come to disagree about what a `.bedpe` is.
 *
 * A name the router has no route for lands on `'map'` rather than being dropped,
 * and that is deliberate. A folder listing draws what it cannot open, dimmed,
 * because it must agree with the folder; a hub is a **curated** list, and the
 * names it carries are routinely ones no extension can settle — an S3 key with
 * no suffix, a presigned URL whose name is buried in its query, a portal's
 * `@@download` address. Refusing those would silently shorten somebody's
 * catalogue; offering them puts the reader where pasting the same URL puts
 * them, which is the file's own error message if it is not a map after all.
 */
export function kindOf(uri: string): HubEntryKind {
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
 * Read a hub out of a file's text, or refuse it.
 *
 * The three refusals are `state/SessionConfig.ts`'s, plus one of this format's
 * own: `'not-a-hub'`, for a JSON file that parses and is something else. It is a
 * separate reason from `'not-a-workspace'` because the two files are offered
 * through different doors and the fix differs — one is written by the save
 * button, the other by a generator — and a reader who pasted a workspace URL
 * into the hub box deserves to be told which of the two they have.
 */
export function parseHub(text_: string): Hub | ConfigRefusal {
  let parsed: unknown
  try {
    parsed = JSON.parse(text_)
  } catch {
    return { reason: 'not-json' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { reason: 'not-a-hub' }
  const row = parsed as Record<string, unknown>
  if (row['kind'] !== HUB_KIND) return { reason: 'not-a-hub' }

  // The same gate `parseWorkspaceFile` applies, for the same reason: a version
  // is a claim about what every other field in the file *means*, so a file from
  // a newer build is refused rather than read as though it were current. A
  // `version` that is not a whole number is not a version at all — this format
  // has no minor versions to be at — so it fails identity rather than being
  // rounded into one.
  const declared = row['version']
  if (declared !== undefined && (typeof declared !== 'number' || !Number.isInteger(declared))) {
    return { reason: 'not-a-hub' }
  }
  const version = typeof declared === 'number' ? declared : HUB_VERSION
  if (version > HUB_VERSION) {
    const producer = row['producer']
    return {
      reason: 'newer',
      version,
      ...(typeof producer === 'string' && producer !== '' ? { producer } : {}),
    }
  }

  const entries: HubEntry[] = []
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
    kind: HUB_KIND,
    version,
    // An unnamed hub is legal and common — a `make_hub.py bucket` run over a
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
 * Point every name in a hub at wherever the hub itself was found.
 *
 * `resolveConfig`'s job, over a catalogue instead of a session, and through the
 * same `parseUri`/`formatUri` pair so that `::entries/rep1` survives being
 * resolved: the group names a path *inside* the file and is no part of the URL
 * arithmetic. Absolute URIs are untouched whatever their scheme, so a hub may
 * mix the two — a catalogue of a lab's own bucket that also points at two files
 * on 4DN is a reasonable thing to write.
 *
 * `base` wins over the hub's own URL when it is there, which is what lets a hub
 * published at the root of a site describe a bucket somewhere else. It is itself
 * resolved against `hubUrl` first, so `"base": "data/"` means what it looks
 * like, and a missing trailing slash is repaired rather than refused — URL
 * resolution would otherwise quietly drop the last segment of the prefix and
 * every entry would land one directory up.
 *
 * ## The index fragment is resolved too
 *
 * `#index=<url>` names a sidecar that is a *separate file* (`annotations/
 * sidecar.ts`), and plain URL resolution leaves the inside of a fragment alone —
 * so a hub naming `reads.bam#index=reads.bam.bai` relatively would come out with
 * an absolute BAM and a `.bai` that resolves against the page the viewer is
 * served from. That is the one place where "copy the folder with its data" quietly
 * stops holding, so both halves are resolved. An absolute index is untouched,
 * which is what every generated hub writes.
 */
export function resolveHub(hub: Hub, hubUrl: string): Hub {
  const base = resolveBase(hub.base, hubUrl)
  const at = (uri: string): string => {
    let parsed
    try {
      parsed = parseUri(uri)
    } catch {
      // A URI with no file half is not one this can repair. `parseHub` already
      // dropped an entry naming nothing, so this is a `tracks[]` URL that is
      // only a group.
      return uri
    }
    return formatUri(resolveAddress(parsed.path, base), parsed.group)
  }

  return {
    ...hub,
    ...(base === null ? {} : { base }),
    entries: hub.entries.map((entry) => ({
      ...entry,
      uri: at(entry.uri),
      ...(entry.tracks === undefined
        ? {}
        : { tracks: entry.tracks.map((track) => ({ ...track, url: at(track.url) })) }),
    })),
  }
}

/** The absolute prefix entries are resolved against, or `null` when there is none. */
function resolveBase(base: string | undefined, hubUrl: string): string | null {
  if (base === undefined) return hubUrl === '' ? null : hubUrl
  const text_ = base.endsWith('/') ? base : `${base}/`
  if (hubUrl === '') return text_
  try {
    return new URL(text_, hubUrl).href
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
  // Canonicalised once absolute (§23.5): a hub may name a Dropbox share link, a
  // Drive file or a `gs://` object, and the row should carry the form that
  // opens — the same rewrite every URL box applies — so that what the picker
  // hands over, and what a shared link then carries, is already the working one.
  return `${canonicalUrl(absolute(address, base))}${resolveFragment(fragment, base)}`
}

/** `value` against `base`, or `value` when it is already absolute or will not resolve. */
function absolute(value: string, base: string): string {
  // Any scheme, not just `http(s):` — an `s3://` or `gs://` name in a hub is an
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
 * What asking for a hub answered with.
 *
 * A union rather than a throw, and **404 told apart from every other failure**,
 * because the table has a different sentence for it: the two generated hubs the
 * app ships references to do not exist until the Hubs workflow has run once, and
 * "the host answered 404" sends a reader to check a URL that is perfectly
 * correct. Everything else collapses to a message, since there is nothing a
 * reader can do differently about a 503 and a CORS refusal.
 */
export type HubFetch =
  | { ok: true; hub: Hub }
  /** The host has no such file. For a built-in, that means "not published yet". */
  | { ok: false; reason: 'missing'; message: string }
  /** The host answered, and not with the file. */
  | { ok: false; reason: 'http'; status: number; message: string }
  /** Nothing came back: no route, no CORS header, the tab went offline. */
  | { ok: false; reason: 'network'; message: string }
  /** Something came back and it is not a hub. */
  | { ok: false; reason: 'refused'; refusal: ConfigRefusal; message: string }

export interface FetchHubOptions {
  /** The `fetch` to use. Tests pass one; the app never does. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch one hub, on a gesture, and hand back what came of it.
 *
 * One plain `GET` — a hub is kilobytes and there is nothing to range over —
 * signed exactly as `Session.openConfigUrl` signs the fetch of a published
 * workspace, and for the same reason: a hub in a private prefix is the natural
 * way for a lab to publish its own shelf, and this request being the one
 * unsigned link would make the whole arrangement fail at its first step.
 *
 * It never throws. Every road out is a value, because the caller is a table that
 * has to draw *something* whatever happened, and a rejected promise at a `<select>`
 * change handler is an empty table with the reason in the console.
 */
export async function fetchHub(url: string, options: FetchHubOptions = {}): Promise<HubFetch> {
  const run = options.fetchImpl ?? fetch
  let response: Response
  try {
    // Signed when a bucket scope covers the URL, and carrying whatever static
    // headers the URL needs (§23.7) — a hub published on a Drive or GCS JSON-API
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
  let body: string
  try {
    body = await response.text()
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      message: `${url} was cut off: ${err instanceof Error ? err.message : String(err)}.`,
    }
  }
  const parsed = parseHub(body)
  if ('reason' in parsed) {
    return { ok: false, reason: 'refused', refusal: parsed, message: '' }
  }
  return { ok: true, hub: resolveHub(parsed, url) }
}
