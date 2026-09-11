/**
 * Asking a portal for its Hi-C files, and turning one page of hits into a hub.
 *
 * SPECS §23.4. The shelf in front of 4DN and ENCODE is a *generated* hub
 * (§23.3): a script queries the portal once a week and publishes a static
 * catalogue, which needs no CORS from the portal at all and is what juicebox.js
 * ships too. This file is the other half — the reader who wants the file that
 * was released yesterday, or who knows a cell line and not an accession, and
 * would rather ask the portal than wait for Monday's workflow.
 *
 * It is the same table either way, which is the whole reason this returns a
 * {@link Hub} rather than a listing: a portal hit has a biosource, an assay and
 * a lab, and a folder row has a name (§23.1, `docs/remote-sources.md` §5 shape
 * B). One page of hits *is* a small hub — columns, rows, fields, provenance —
 * so it goes to `HubTable.show` exactly as a fetched hub does, and the picker
 * has one table and not two.
 *
 * ## The URL each portal wants is not a preference, it is its schema
 *
 * Both portals run snovault, so both answer `/search/?…&format=json` with
 * `@graph`, `total` and facets, and both take `field=` to say which properties
 * to embed — without it a File comes back with sixty keys and the response is
 * megabytes. The field lists below are the ones igv-data's `updateEncode.py`
 * and `update4DN.py` have been running against the live portals for years
 * (`docs/remote-sources.md` §3.3), narrowed to what a row in this table shows.
 *
 * The two differ in the one place that matters, and it is not the query syntax:
 *
 * - **ENCODE** names each file's bytes at `cloud_metadata.url`, the unsigned
 *   object on the public `encode-public` bucket. The portal's own `href` is the
 *   `@@download` path, which answers `307` to a URL presigned for `GET` alone —
 *   the probe path handles that now (§23.6), but a catalogue should not depend
 *   on a link that expires, so `cloud_metadata.url` is preferred and `href` is
 *   the fallback for a file that has none (`docs/remote-sources.md` §3.2).
 * - **4DN** names them at `open_data_url`, and its `@@download` calls
 *   `check_user_is_logged_in` before it 307s — so an anonymous browser has
 *   nothing else to use, and a row without an `open_data_url` is dropped rather
 *   than offered as a link that will 403. That is the same choice the portal's
 *   own *Visualize with JuiceBox* button makes.
 *
 * ## CORS is the thing that can make this whole file useless, and it says so
 *
 * ENCODE's web tier sets `Access-Control-Allow-Origin "*"` in a checked-in
 * Apache configuration, so its search answers a browser. 4DN's was not
 * verifiable when this was written — nothing in fourfront or snovault sets a
 * CORS header, so it would be a web-tier setting nobody outside the DCIC can
 * read. If it does not, a browser refuses the response and hands script a bare
 * `TypeError` with no detail, by design. That refusal is reported **in those
 * words**, with the generated hub named as the alternative that lists the same
 * files, and it is never proxied: a proxy is the server SPECS C1 forbids, and
 * §23.3 is the answer that needs none.
 *
 * One small thing keeps that from being worse than it has to be: the only
 * header sent is `Accept`, which is CORS-safelisted, so this is a *simple*
 * request and is never preflighted. A portal that answers a plain `GET` from a
 * browser answers this one as it stands — there is no `OPTIONS` for anyone to
 * have to configure.
 */

import { ViewerError } from '../errors'
import { routeOf } from '../browse/route'
import {
  HUB_KIND,
  HUB_VERSION,
  type Hub,
  type HubColumn,
  type HubEntry,
  type HubEntryKind,
} from './hub'

export type PortalId = 'encode' | '4dn'

export interface Portal {
  id: PortalId
  label: string
  /** The search URL for a free-text query; `limit` caps the page. */
  searchUrl(query: string, limit: number): string
  /** Rows from one response body; tolerant of missing fields. */
  parse(body: unknown): { entries: HubEntry[]; total: number | null }
  columns: HubColumn[]
}

/**
 * How many hits one search asks for.
 *
 * A live search is a shelf, not a download: fifty rows fill the table, sort and
 * filter instantly, and cost a response of a few hundred kilobytes. When more
 * matched, the hub's `description` says how many — which is the honest version
 * of a "load more" button this table does not have, since the fix for *too many
 * matches* is a narrower query and not a longer list.
 */
const DEFAULT_LIMIT = 50

/**
 * The built-in hub that lists the same portal's files (Contract 2, §23.3).
 *
 * Named in the CORS refusal, because "this portal will not talk to your
 * browser" is only half an answer and the other half is already in the picker.
 */
const GENERATED_HUB: Record<PortalId, string> = {
  encode: 'ENCODE Hi-C',
  '4dn': '4DN open data',
}

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A dotted path through embedded objects — `lab.title`, `cloud_metadata.url` —
 * read as a string, and `''` for anything that is not there.
 *
 * Tolerant on purpose. `field=` controls what the portal embeds and a portal
 * may embed less than it was asked for: a File whose `target` is unset has no
 * `target` key at all rather than a null one, an un-migrated record may carry a
 * string where a later schema carries an object, and neither is a reason to
 * refuse a page of otherwise good rows. Every caller below treats `''` as
 * "absent", so a missing field costs a column cell and nothing else.
 */
function text(source: unknown, path: string): string {
  let at: unknown = source
  for (const step of path.split('.')) {
    if (!isRecord(at)) return ''
    at = at[step]
  }
  if (typeof at === 'string') return at.trim()
  if (typeof at === 'number' && Number.isFinite(at)) return String(at)
  return ''
}

/** Non-empty parts, joined — the whole of how a label and a note are built. */
function join(parts: readonly string[], separator: string): string {
  return parts.filter((part) => part !== '').join(separator)
}

/** `file_size` when the portal knew it, so the table can price a row before it is clicked. */
function sizeOf(row: unknown): number | undefined {
  const value = isRecord(row) ? row['file_size'] : undefined
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Column values, minus the empty ones: Contract 1 renders a missing key as empty. */
function fieldsOf(values: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) if (value !== '') out[key] = value
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * A hub row, with its optional halves left out rather than set to `undefined`.
 *
 * A hub is a document before it is an object — it is what `?hub=` fetches and
 * what a reader may save out of the table — and `"note": undefined` is not a
 * thing JSON has. Both parsers below therefore hand over what they found and
 * this decides what survives into the row.
 */
function entryOf(parts: {
  label: string
  uri: string
  size: number | undefined
  note: string
  fields: Record<string, string>
}): HubEntry {
  const fields = fieldsOf(parts.fields)
  return {
    label: parts.label,
    uri: parts.uri,
    kind: kindOf(parts.uri),
    ...(parts.size === undefined ? {} : { size: parts.size }),
    ...(parts.note === '' ? {} : { note: parts.note }),
    ...(fields === undefined ? {} : { fields }),
  }
}

/** The last path segment of a URL, which is the file name and the last-resort label. */
function nameOf(uri: string): string {
  return uri.split(/[?#]/)[0].split('/').filter((part) => part !== '').pop() ?? uri
}

/** `…/4DNFIM7ZVQOQ.mcool` → `mcool`, for the one thing a 4DN label must carry. */
function extensionOf(uri: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(nameOf(uri))
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * Whether a URI is already absolute — the promise {@link searchPortal} makes
 * about every row it returns.
 *
 * It matters more here than it reads. A hub's relative names resolve against
 * its `base` or against its own URL's directory (Contract 1), and this hub's
 * URL is a *search query*; a row that slipped through relative would resolve
 * against `https://www.encodeproject.org/search/` and 404 in a way that looks
 * like the portal losing a file.
 */
function isAbsolute(uri: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(uri)
}

/**
 * The kind a portal row gets.
 *
 * `routeOf` is the app's one table of what a name is (§20.5), so it answers
 * here too rather than a second regular expression drifting from it. Its third
 * answer, `unknown`, is not one of a hub's three kinds — and a row that came
 * back from a query filtered to `hic`, `mcool` and `cool` is a map whether or
 * not this build's router has met its extension yet, so that is what it is
 * called. A portal that starts publishing a format this viewer cannot open is
 * refused by the opener, with a message, which is where a refusal belongs.
 */
function kindOf(uri: string): HubEntryKind {
  return routeOf(uri) === 'genome' ? 'genome' : 'map'
}

/** One `key=value&…` string, in the order the portal's own examples write it. */
function queryString(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}

/** `field=` for each name, which is how snovault is told what to embed. */
function fieldParams(fields: readonly string[]): Array<readonly [string, string]> {
  return fields.map((field) => ['field', field] as const)
}

/** The `@graph` of a snovault search, or nothing at all. */
function graphOf(body: unknown): unknown[] {
  const graph = isRecord(body) ? body['@graph'] : undefined
  return Array.isArray(graph) ? graph : []
}

/**
 * The `total` a snovault search reports, which is how many matched rather than
 * how many came back.
 *
 * `null` when it is absent, and the difference is worth keeping: "50 rows, of
 * 312" and "50 rows, and nobody said how many there are" are different things
 * to tell a reader, and rounding the second into the first invents a number.
 */
function totalOf(body: unknown): number | null {
  const total = isRecord(body) ? body['total'] : undefined
  return typeof total === 'number' && Number.isFinite(total) ? total : null
}

/**
 * The accession inside an `@id` path: `/experiments/ENCSR968KAY/` → `ENCSR968KAY`.
 *
 * A File's `dataset` is a link, and snovault serialises a link the reader did
 * not ask to embed as its path. The path is noise in a note; the accession in
 * it is the thing a reader pastes back into the portal, and is what igv-data's
 * table has carried in its own Experiment column for years. Anything that is
 * not a path comes back untouched.
 */
function accessionIn(value: string): string {
  if (!value.startsWith('/')) return value
  return value.split('/').filter((part) => part !== '').pop() ?? value
}

/**
 * The accession of the first item in a linked array, however it arrived.
 *
 * `field=experiment_sets.accession` asks snovault to embed the accession, and
 * it usually does; the same array in a frame that embedded nothing is a list of
 * `@id` paths, and a record between the two carries objects with only an `@id`.
 * All three say the same thing and the row should read the same whichever the
 * portal sent.
 */
function firstAccession(row: unknown, key: string): string {
  const list = isRecord(row) ? row[key] : undefined
  if (!Array.isArray(list) || list.length === 0) return ''
  const first = list[0]
  if (typeof first === 'string') return accessionIn(first)
  return text(first, 'accession') || accessionIn(text(first, '@id'))
}

/**
 * The accession of a linked item — a File's `dataset`, which is its experiment.
 *
 * Same three shapes as {@link firstAccession}, and the usual one here is the
 * bare path: a `linkTo` the query did not ask to embed is serialised as its
 * `@id`, so `dataset` arrives as `/experiments/ENCSR968KAY/`.
 */
function linkedAccession(row: unknown, key: string): string {
  return (
    accessionIn(text(row, key)) ||
    text(row, `${key}.accession`) ||
    accessionIn(text(row, `${key}.@id`))
  )
}

/* ------------------------------------------------------------------- ENCODE */

const ENCODE_SEARCH = 'https://www.encodeproject.org/search/'

const ENCODE_FIELDS = [
  'accession',
  'href',
  'cloud_metadata.url',
  'assembly',
  'file_size',
  'output_type',
  'dataset',
  'lab.title',
  'biosample_ontology.term_name',
  'target.label',
  'date_released',
] as const

const ENCODE: Portal = {
  id: 'encode',
  label: 'ENCODE',
  columns: [
    { key: 'assembly', label: 'Assembly' },
    { key: 'biosample', label: 'Biosample' },
    { key: 'target', label: 'Target' },
    { key: 'output', label: 'Output' },
    { key: 'lab', label: 'Lab' },
  ],

  searchUrl(query, limit) {
    const term = query.trim()
    return `${ENCODE_SEARCH}?${queryString([
      ['type', 'File'],
      ['file_format', 'hic'],
      ['status', 'released'],
      // Omitted rather than sent empty for the empty query: `searchTerm=` is a
      // term that matches nothing on some snovault deployments and everything
      // on others, and "everything, first page" is a thing the reader asked for
      // deliberately by pressing search with an empty box.
      ...(term === '' ? [] : [['searchTerm', term] as const]),
      ['limit', String(limit)],
      ['format', 'json'],
      ...fieldParams(ENCODE_FIELDS),
    ])}`
  },

  parse(body) {
    const entries: HubEntry[] = []
    for (const row of graphOf(body)) {
      // The unsigned object first, the portal's own download path second. A
      // file with neither is not a row: there is nothing to open.
      const uri = text(row, 'cloud_metadata.url') || encodeHref(text(row, 'href'))
      if (!isAbsolute(uri)) continue

      const accession = text(row, 'accession')
      const biosample = text(row, 'biosample_ontology.term_name')
      const target = text(row, 'target.label')
      const released = text(row, 'date_released')
      entries.push(
        entryOf({
          // The columns carry the facets; the label is what the row *is*, read
          // left to right — "GM12878, CTCF". The accession is deliberately not
          // in it: the table's filter reads name and note together (Contract
          // 2), so it is findable from the note, and repeating it would cost
          // the widest column in the table eleven characters on every row.
          label: join([biosample, target], ', ') || accession || nameOf(uri),
          uri,
          size: sizeOf(row),
          // The file, then the experiment it belongs to, then when it was
          // released — which is the one fact that separates a current `.hic`
          // from the one it superseded, and the reason `date_released` is asked
          // for at all.
          note: join(
            [
              accession,
              linkedAccession(row, 'dataset'),
              released === '' ? '' : `released ${released}`,
            ],
            ' · ',
          ),
          fields: {
            assembly: text(row, 'assembly'),
            biosample,
            target,
            output: text(row, 'output_type'),
            lab: text(row, 'lab.title'),
          },
        }),
      )
    }
    return { entries, total: totalOf(body) }
  },
}

/**
 * `/files/ENCFF706SFK/@@download/ENCFF706SFK.hic` → an absolute portal URL.
 *
 * Only reached for a file with no `cloud_metadata`, which is a handful of older
 * records. It is a redirect to a presigned link, and that link is signed for
 * `GET` alone — which the probe path now allows for (§23.6), so the row opens;
 * it is second because a presigned link expires and a hub row should not.
 */
function encodeHref(href: string): string {
  if (href === '') return ''
  if (isAbsolute(href)) return href
  return `https://www.encodeproject.org${href.startsWith('/') ? '' : '/'}${href}`
}

/* ---------------------------------------------------------------------- 4DN */

const FOURDN_SEARCH = 'https://data.4dnucleome.org/search/'

const FOURDN_FIELDS = [
  'accession',
  'open_data_url',
  'genome_assembly',
  'file_size',
  'file_type',
  'file_format.file_format',
  'track_and_facet_info',
  'lab.display_title',
  'experiment_sets.accession',
] as const

const FOURDN: Portal = {
  id: '4dn',
  label: '4DN',
  columns: [
    { key: 'assembly', label: 'Assembly' },
    { key: 'biosource', label: 'Biosource' },
    { key: 'assay', label: 'Assay' },
    { key: 'dataset', label: 'Dataset' },
    { key: 'lab', label: 'Lab' },
  ],

  searchUrl(query, limit) {
    const term = query.trim()
    return `${FOURDN_SEARCH}?${queryString([
      ['type', 'FileProcessed'],
      // Three values of one facet, which is how snovault spells OR. Every
      // format this viewer reads over a range, and not only `.hic`: 4DN
      // publishes each experiment set as both, juicebox.js can use one of them
      // and this viewer both (`docs/remote-sources.md` §3.3).
      ['file_format.file_format', 'mcool'],
      ['file_format.file_format', 'hic'],
      ['file_format.file_format', 'cool'],
      ['status', 'released'],
      ...(term === '' ? [] : [['q', term] as const]),
      ['limit', String(limit)],
      ['format', 'json'],
      ...fieldParams(FOURDN_FIELDS),
    ])}`
  },

  parse(body) {
    const entries: HubEntry[] = []
    for (const row of graphOf(body)) {
      // No `open_data_url`, no row. The alternative is the portal's
      // `@@download`, which checks for a logged-in user before it redirects, so
      // offering one would be offering a link that 403s from a browser.
      const uri = text(row, 'open_data_url')
      if (!isAbsolute(uri)) continue

      const info = isRecord(row) ? row['track_and_facet_info'] : undefined
      const accession = text(row, 'accession')
      const biosource = text(info, 'biosource_name')
      const experimentType = text(info, 'experiment_type')
      // The embedded object when `field=file_format.file_format` was honoured,
      // the bare string when a record carries one, the extension when neither.
      const format =
        text(row, 'file_format.file_format') || text(row, 'file_format') || extensionOf(uri)
      const described =
        join([biosource, experimentType], ', ') || text(row, 'file_type') || accession
      entries.push(
        entryOf({
          // The format belongs in a 4DN label and not in an ENCODE one: this
          // query returns `.hic` beside `.mcool` beside `.cool`, often for the
          // same experiment, and which of them a row is decides what opens.
          label: join([described, format === '' ? '' : `(${format})`], ' '),
          uri,
          size: sizeOf(row),
          // Accessions first — the file's, then the experiment set's, which is
          // what a reader pastes back into the portal — then what separates two
          // rows of one dataset.
          note: join(
            [
              accession,
              firstAccession(row, 'experiment_sets'),
              text(info, 'condition'),
              text(info, 'replicate_info'),
            ],
            ' · ',
          ),
          fields: {
            assembly: text(row, 'genome_assembly'),
            biosource,
            // Two facets in one column: the experiment type is what was done
            // and the assay info is how (`in situ Hi-C · MboI`). They are one
            // answer to "what is this", and a sixth column would be narrower
            // than either of them on a phone.
            assay: join([experimentType, text(info, 'assay_info')], ' · '),
            dataset: text(info, 'dataset'),
            lab: text(row, 'lab.display_title') || text(info, 'lab_name'),
          },
        }),
      )
    }
    return { entries, total: totalOf(body) }
  },
}

/**
 * The portals, ENCODE first.
 *
 * Order is the select's order, and ENCODE leads because its CORS is a checked-in
 * line of somebody's Apache configuration and 4DN's is a hope. A reader meeting
 * this form for the first time should meet the half that is known to work.
 */
export const PORTALS: readonly Portal[] = [ENCODE, FOURDN]

/**
 * One search, as a hub.
 *
 * @param query Free text. Empty means "everything, first page" — which is a
 * perfectly good thing to ask a portal whose whole Hi-C collection is smaller
 * than one page of its ChIP-seq.
 */
export async function searchPortal(
  portal: Portal,
  query: string,
  options: { limit?: number; fetchImpl?: typeof fetch },
): Promise<Hub> {
  const term = query.trim()
  const url = portal.searchUrl(term, options.limit ?? DEFAULT_LIMIT)
  const doFetch = options.fetchImpl ?? globalThis.fetch

  let response: Response
  try {
    response = await doFetch(url, {
      // The only header, and it is CORS-safelisted, so this stays a simple
      // request with no preflight for anyone to have to allow.
      headers: { Accept: 'application/json' },
    })
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause)
    throw new ViewerError(
      'remote-cors',
      `${portal.label} did not let this page read its search results. A browser refuses a ` +
        'response whose origin the server did not allow and hands script no detail at all, so ' +
        'this is either that or the portal being unreachable — they look identical from here. ' +
        'There is nothing to configure at this end and nothing to proxy through: a proxy would ' +
        `be a server, and this viewer has none. The built-in "${GENERATED_HUB[portal.id]}" hub ` +
        'in the picker lists the same files — it is generated from this same query and served ' +
        `from a host that does answer browsers. Underlying error: ${why}`,
      { portal: portal.id, url },
    )
  }

  // A snovault search that matched nothing answers `404` with a JSON body
  // saying so — recorded for 4DN in Contract 4 and SPECS §23.3, and true of
  // ENCODE's identical stack. Zero results, not a failure: the path above is a
  // constant in this file, so a 404 here cannot mean a mistyped URL.
  if (response.status === 404) return hubOf(portal, term, url, [], 0)

  if (!response.ok) {
    throw new ViewerError(
      'bad-uri',
      `${portal.label} answered ${response.status} ${response.statusText} to this search. That ` +
        'is the portal refusing or failing, not this page: nothing here can retry it into ' +
        `working. The built-in "${GENERATED_HUB[portal.id]}" hub lists the same files without ` +
        'asking the portal anything.',
      { portal: portal.id, url, status: response.status },
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause)
    throw new ViewerError(
      'format',
      `${portal.label} answered this search with something that is not JSON, though it was ` +
        `asked for JSON twice — in the query and in the Accept header. Underlying error: ${why}`,
      { portal: portal.id, url },
    )
  }

  const { entries, total } = portal.parse(body)
  return hubOf(portal, term, url, entries, total)
}

/**
 * The hub a search comes back as.
 *
 * `source` is the query URL and `generatedAt` is now, for the reason every
 * generated hub carries them (§23.3): a shelf with no provenance is a
 * screenshot, and this one is a shelf that will be different tomorrow.
 */
function hubOf(
  portal: Portal,
  query: string,
  url: string,
  entries: HubEntry[],
  total: number | null,
): Hub {
  // Said only when it is true, and said as a count rather than as a "load more"
  // button: the fix for four hundred matches is a narrower query, and a second
  // page of a relevance-ordered list is rarely what anybody wanted.
  const description =
    total !== null && total > entries.length
      ? `Showing ${entries.length} of ${total} matches: one page of the portal's answer, minus ` +
        'any row with no public URL. Narrow the query to see the rest.'
      : undefined
  return {
    kind: HUB_KIND,
    version: HUB_VERSION,
    name: query === '' ? `${portal.label}: all released Hi-C` : `${portal.label}: "${query}"`,
    ...(description === undefined ? {} : { description }),
    generatedAt: new Date().toISOString(),
    source: url,
    // Copied, not shared: a hub is handed to a table that may sort its own
    // columns, and the portal's list outlives every hub built from it.
    columns: [...portal.columns],
    entries,
  }
}
