/**
 * The portal adapter: the URL it builds, the hub it makes, and the two answers
 * that are not an error.
 *
 * Neither portal is reachable from the machine this was written on, and neither
 * will be from CI — which is the normal state of a test against somebody else's
 * web service and the reason the fixtures exist. They are shaped exactly like a
 * snovault search response (`@graph`, `total`, facets) and their accessions,
 * labs, assemblies, sizes and open-data URLs are the real ones, taken from
 * igv-data's `hic.txt` and `4dn_hic.txt` and from the 4DN bucket census in
 * `docs/remote-sources.md` §2.2. What is *not* real is exercised on purpose:
 * a file with no `cloud_metadata` (ENCODE's older records), one with no
 * `open_data_url` (a released 4DN file not yet copied to the public bucket),
 * and two with no `track_and_facet_info` at all.
 *
 * Three things here would each silently produce a table that looks right and
 * opens nothing:
 *
 * - **The query.** A `field=` the portal does not know is ignored, so a typo
 *   costs a column rather than an error, and an unencoded query with an `&` in
 *   it becomes two parameters and changes what was searched for.
 * - **Which URL a row carries.** ENCODE's `href` is a redirect to a link
 *   presigned for `GET`, and 4DN's `@@download` wants a logged-in user; the
 *   unsigned bucket object is the one that opens, and it is a different field
 *   on each portal.
 * - **A 404.** snovault answers a search that matched nothing with one, so
 *   reading it as a failure turns "no hits" into a red error box.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PORTALS, searchPortal, type Portal } from '@/state/portal'
import { ViewerError } from '@/errors'

const ENCODE = PORTALS[0]
const FOURDN = PORTALS[1]

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures-portals/${name}`, import.meta.url)), 'utf8'),
  )
}

const ENCODE_BODY = fixture('encode-search.json')
const FOURDN_BODY = fixture('4dn-search.json')

/** A `fetch` that answers one body, and records what it was asked. */
function serve(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): { fetchImpl: typeof fetch; asked: string[]; headers: Array<Record<string, string>> } {
  const asked: string[] = []
  const headers: Array<Record<string, string>> = []
  const fetchImpl = (async (url: string, request: RequestInit) => {
    asked.push(url)
    headers.push((request.headers ?? {}) as Record<string, string>)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
    })
  }) as unknown as typeof fetch
  return { fetchImpl, asked, headers }
}

describe('the portals on offer', () => {
  it('leads with ENCODE, whose CORS is a checked-in line of its web configuration', () => {
    expect(PORTALS.map((portal) => portal.id)).toEqual(['encode', '4dn'])
  })

  it('names its columns in the order the table draws them', () => {
    expect(ENCODE.columns.map((column) => column.key)).toEqual([
      'assembly',
      'biosample',
      'target',
      'output',
      'lab',
    ])
    expect(FOURDN.columns.map((column) => column.key)).toEqual([
      'assembly',
      'biosource',
      'assay',
      'dataset',
      'lab',
    ])
  })
})

describe('the ENCODE query', () => {
  it('asks for released hic Files, one page, with every field a row shows', () => {
    expect(ENCODE.searchUrl('GM12878', 50)).toBe(
      'https://www.encodeproject.org/search/?type=File&file_format=hic&status=released' +
        '&searchTerm=GM12878&limit=50&format=json' +
        '&field=accession&field=href&field=cloud_metadata.url&field=assembly&field=file_size' +
        '&field=output_type&field=dataset&field=lab.title&field=biosample_ontology.term_name' +
        '&field=target.label&field=date_released',
    )
  })

  /**
   * A query with a space and an ampersand in it is ordinary — "K562 & GM12878"
   * is what a hand types — and unencoded the `&` ends the parameter, so the
   * portal is asked for `K562` and given a parameter called ` GM12878` it
   * ignores. The search would answer, with the wrong rows.
   */
  it('encodes the query rather than letting it become more parameters', () => {
    const url = ENCODE.searchUrl('K562 & "CTCF"', 10)
    expect(url).toContain('&searchTerm=K562%20%26%20%22CTCF%22&')
    expect(new URL(url).searchParams.get('searchTerm')).toBe('K562 & "CTCF"')
  })

  it('drops searchTerm entirely for an empty query, which means everything', () => {
    const url = ENCODE.searchUrl('   ', 25)
    expect(url).not.toContain('searchTerm')
    expect(url).toContain('&limit=25&')
  })
})

describe('the 4DN query', () => {
  it('asks for every format this viewer reads, not only hic', () => {
    expect(FOURDN.searchUrl('HCT116', 50)).toBe(
      'https://data.4dnucleome.org/search/?type=FileProcessed' +
        '&file_format.file_format=mcool&file_format.file_format=hic&file_format.file_format=cool' +
        '&status=released&q=HCT116&limit=50&format=json' +
        '&field=accession&field=open_data_url&field=genome_assembly&field=file_size' +
        '&field=file_type&field=file_format.file_format&field=track_and_facet_info' +
        '&field=lab.display_title&field=experiment_sets.accession',
    )
  })

  it('encodes its own free-text parameter, which is q and not searchTerm', () => {
    const url = FOURDN.searchUrl('RAD21-AID & auxin', 5)
    expect(url).toContain('&q=RAD21-AID%20%26%20auxin&')
    expect(new URL(url).searchParams.get('q')).toBe('RAD21-AID & auxin')
  })

  it('drops q for an empty query', () => {
    expect(FOURDN.searchUrl('', 50)).not.toContain('&q=')
  })
})

describe('parsing an ENCODE page', () => {
  const { entries, total } = ENCODE.parse(ENCODE_BODY)

  it('reports how many matched, which is not how many came back', () => {
    expect(total).toBe(176)
    expect(entries).toHaveLength(7)
  })

  it('opens each row at the unsigned bucket object, not at the download redirect', () => {
    expect(entries[0].uri).toBe(
      'https://encode-public.s3.amazonaws.com/2016/11/03/' +
        '6cbb4eb4-f6d1-4b6c-9de5-6b4a29e9d5a3/ENCFF014VMM.hic',
    )
    expect(entries.every((entry) => /^https:\/\//.test(entry.uri))).toBe(true)
  })

  /**
   * A handful of older ENCODE files have no `cloud_metadata`, and the portal's
   * own `@@download` path is what is left. It 307s to a link presigned for
   * `GET`, which the probe path allows for (§23.6) — so the row opens, and it
   * is second because that link expires and a catalogue row should not.
   */
  it('falls back to the portal download URL for a file with no cloud_metadata', () => {
    const fallback = entries.find((entry) => entry.label === 'mammary epithelial cell')
    expect(fallback?.uri).toBe(
      'https://www.encodeproject.org/files/ENCFF706SFK/@@download/ENCFF706SFK.hic',
    )
  })

  it('labels a row by what it is, and files the facets under the columns', () => {
    expect(entries[0]).toEqual({
      label: 'GM12878',
      uri: entries[0].uri,
      kind: 'map',
      size: 4184862209,
      note: 'ENCFF014VMM · ENCSR968KAY · released 2016-11-04',
      fields: {
        assembly: 'hg19',
        biosample: 'GM12878',
        output: 'contact matrix',
        lab: 'Erez Aiden, Baylor',
      },
    })
  })

  it('puts a target in the label and in its column when the file has one', () => {
    const chia = entries.find((entry) => entry.note?.startsWith('ENCFF509JQH'))
    expect(chia?.label).toBe('K562, CTCF')
    expect(chia?.fields?.target).toBe('CTCF')
  })

  /**
   * The note is what the table's filter reads beside the name, so the two
   * accessions a reader might paste — the file's and its experiment's — belong
   * in it. The experiment arrives as a link path, `/experiments/ENCSR968KAY/`,
   * and the accession inside it is the part anybody uses.
   */
  it('keeps the accession out of a link path in the note', () => {
    expect(entries.map((entry) => entry.note)).toEqual([
      'ENCFF014VMM · ENCSR968KAY · released 2016-11-04',
      'ENCFF876OWE · ENCSR846DUS · released 2020-02-19',
      'ENCFF013TGD · ENCSR545YBD · released 2016-11-04',
      'ENCFF121YPY · ENCSR662QKG · released 2021-06-10',
      'ENCFF509JQH · ENCSR752QCX · released 2022-03-15',
      'ENCFF706SFK · ENCSR080ODG · released 2016-11-04',
      'ENCFF150DKS',
    ])
  })

  /**
   * `field=` says what to embed and a record may carry less than was asked for.
   * A row with nothing but an accession and a URL is still a row that opens;
   * refusing the page over it would lose six good rows to one thin one.
   */
  it('keeps a record that carries almost nothing, labelled by its accession', () => {
    const thin = entries[6]
    expect(thin.label).toBe('ENCFF150DKS')
    expect(thin.fields).toBeUndefined()
    expect(thin.size).toBe(2450931744)
  })

  it('routes every row through the app’s own name table', () => {
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(new Set(['map']))
  })
})

describe('parsing a 4DN page', () => {
  const { entries, total } = FOURDN.parse(FOURDN_BODY)

  it('counts the whole collection and returns one page of it', () => {
    expect(total).toBe(2367)
    expect(entries).toHaveLength(6)
  })

  /**
   * 4DN's `@@download` calls `check_user_is_logged_in` before it redirects, so
   * a file with no `open_data_url` has no URL an anonymous browser can read.
   * A row for it would be a row that 403s on the click.
   */
  it('drops a file that is not on the open-data bucket rather than offering a 403', () => {
    expect(entries.map((entry) => entry.uri).join(' ')).not.toContain('4DNFIHSUIRFY')
    expect(entries.every((entry) => entry.uri.startsWith('https://4dn-open-data-public.s3.'))).toBe(
      true,
    )
  })

  it('names the biosource, the assay and the format, because both formats come back', () => {
    expect(entries[0]).toEqual({
      label:
        'HCT116 with Crispr generated mClover and AID-tagged RAD21, in situ Hi-C (hic)',
      uri:
        'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/' +
        '000789fe-9a22-4280-a71c-7ad228fd4cac/4DNFIM7ZVQOQ.hic',
      kind: 'map',
      size: 839405381,
      note: '4DNFIM7ZVQOQ · 4DNESD117NVX · untreated · merged replicates',
      fields: {
        assembly: 'GRCh38',
        biosource: 'HCT116 with Crispr generated mClover and AID-tagged RAD21',
        assay: 'in situ Hi-C · MboI',
        dataset: 'Hi-C on RAD21-AID tagged HCT-116',
        lab: 'Erez Lieberman Aiden, BCM',
      },
    })
  })

  /**
   * Two files of one dataset differ by the condition and the replicate, and
   * that is the whole of what a note has to carry for somebody choosing between
   * them. An absent one is left out rather than printed as a gap.
   */
  it('notes the accessions and what separates two rows of one dataset', () => {
    expect(entries.map((entry) => entry.note)).toEqual([
      '4DNFIM7ZVQOQ · 4DNESD117NVX · untreated · merged replicates',
      '4DNFIQRTP7NM · 4DNES4KDIQNN · auxin treated, 6 hours · merged replicates',
      '4DNFI7J8BQ4P · 4DNESLLTENG9 · merged replicates',
      '4DNFI916JQ1Y · 4DNESDADW6RV · merged replicates',
      '4DNFIOKRZ21H',
      '4DNFIQ9FG7RR',
    ])
  })

  it('reads an mcool as a map and says so in the label', () => {
    const mcool = entries[4]
    expect(mcool.label).toBe('4DNFIOKRZ21H (mcool)')
    expect(mcool.kind).toBe('map')
    expect(mcool.size).toBe(2191787975)
    expect(mcool.fields).toEqual({ assembly: 'GRCh38' })
  })

  it('falls back to the file type when a record carries no facet block', () => {
    expect(entries[5].label).toBe('intra-chromosomal contact matrix (mcool)')
  })
})

describe('tolerance', () => {
  const bodies: Array<[string, unknown]> = [
    ['a body that is not an object', 'not json at all'],
    ['a body with no @graph', { total: 3 }],
    ['a @graph that is not an array', { '@graph': { rows: [] } }],
    ['rows that are not objects', { '@graph': [null, 7, 'x'] }],
    ['rows with no URL at all', { '@graph': [{ accession: 'ENCFF000AAA' }] }],
  ]
  for (const portal of [ENCODE, FOURDN]) {
    for (const [what, body] of bodies) {
      it(`${portal.id}: answers ${what} with no rows rather than throwing`, () => {
        expect(portal.parse(body).entries).toEqual([])
      })
    }
  }

  it('reports an absent total as absent, rather than inventing a number', () => {
    expect(ENCODE.parse({ '@graph': [] }).total).toBeNull()
    expect(ENCODE.parse({ '@graph': [], total: 12 }).total).toBe(12)
  })

  /**
   * A link arrives as a path, as an embedded object, or as an object carrying
   * only an `@id`, depending on what the query asked to embed and what the
   * portal decided to give for it. The accession a reader would paste back is
   * the same in all three, and so is the note.
   */
  it('finds the ENCODE experiment accession however the link was serialised', () => {
    const body = (dataset: unknown): unknown => ({
      '@graph': [
        { accession: 'ENCFF000AAA', cloud_metadata: { url: 'https://example.org/x.hic' }, dataset },
      ],
    })
    for (const dataset of [
      '/experiments/ENCSR968KAY/',
      { accession: 'ENCSR968KAY' },
      { '@id': '/experiments/ENCSR968KAY/' },
    ]) {
      expect(ENCODE.parse(body(dataset)).entries[0].note).toBe('ENCFF000AAA · ENCSR968KAY')
    }
  })

  it('finds the 4DN experiment set accession however the link was serialised', () => {
    const body = (sets: unknown): unknown => ({
      '@graph': [
        {
          accession: '4DNFI000AAA',
          open_data_url: 'https://4dn-open-data-public.s3.amazonaws.com/x/4DNFI000AAA.mcool',
          experiment_sets: sets,
        },
      ],
    })
    for (const sets of [
      ['/experiment-set-replicates/4DNESD117NVX/'],
      [{ accession: '4DNESD117NVX' }],
      [{ '@id': '/experiment-set-replicates/4DNESD117NVX/' }],
    ]) {
      expect(FOURDN.parse(body(sets)).entries[0].note).toBe('4DNFI000AAA · 4DNESD117NVX')
    }
  })
})

describe('one search', () => {
  it('asks the URL it built, for JSON, with nothing that needs a preflight', async () => {
    const { fetchImpl, asked, headers } = serve(ENCODE_BODY)
    await searchPortal(ENCODE, 'GM12878', { fetchImpl, limit: 7 })
    expect(asked[0]).toBe(ENCODE.searchUrl('GM12878', 7))
    // `Accept` is CORS-safelisted, so this stays a simple request: a portal
    // that answers a plain GET answers it, with no OPTIONS to configure.
    expect(headers[0]).toEqual({ Accept: 'application/json' })
  })

  it('comes back as a hub the table can draw, with its provenance on it', async () => {
    const { fetchImpl } = serve(ENCODE_BODY)
    const hub = await searchPortal(ENCODE, 'GM12878', { fetchImpl })
    expect(hub.kind).toBe('metacooler.hub')
    expect(hub.version).toBe(1)
    expect(hub.name).toBe('ENCODE: "GM12878"')
    expect(hub.source).toBe(ENCODE.searchUrl('GM12878', 50))
    expect(hub.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(hub.columns).toEqual(ENCODE.columns)
    expect(hub.base).toBeUndefined()
    expect(hub.entries).toHaveLength(7)
  })

  /**
   * A hub's relative names resolve against its `base`, or against its own URL's
   * directory — and this hub's URL is a *search query*. A row that came through
   * relative would resolve against `…/search/` and 404 in a way that reads as
   * the portal having lost a file.
   */
  it('carries absolute rows, because a search URL is no directory to resolve against', async () => {
    const { fetchImpl } = serve(FOURDN_BODY)
    const hub = await searchPortal(FOURDN, 'HCT116', { fetchImpl })
    expect(hub.entries.every((entry) => /^https?:\/\//.test(entry.uri))).toBe(true)
  })

  it('says how many matched when the page is not all of them', async () => {
    const { fetchImpl } = serve(FOURDN_BODY)
    const hub = await searchPortal(FOURDN, 'HCT116', { fetchImpl })
    expect(hub.description).toContain('Showing 6 of 2367 matches')
  })

  it('says nothing extra when the page is the whole answer', async () => {
    const { fetchImpl } = serve({ '@graph': [], total: 0 })
    const hub = await searchPortal(ENCODE, 'nothing', { fetchImpl })
    expect(hub.description).toBeUndefined()
  })

  it('names an empty query as what it is, rather than as a search for ""', async () => {
    const { fetchImpl } = serve(ENCODE_BODY)
    const hub = await searchPortal(ENCODE, '  ', { fetchImpl })
    expect(hub.name).toBe('ENCODE: all released Hi-C')
    expect(hub.source).not.toContain('searchTerm')
  })
})

describe('when a portal will not answer', () => {
  /**
   * The one failure this file exists for. A browser refuses a response whose
   * origin the server did not allow and hands script a bare `TypeError` with no
   * detail — by design, so a page cannot probe a host it was not allowed to
   * read. ENCODE's Apache sets `Access-Control-Allow-Origin "*"`; 4DN's answer
   * was not verifiable when this was written, and if it refuses then this
   * message is the whole of what a reader gets, so it has to carry the way out:
   * the generated hub in the picker, which lists the same files.
   */
  it('reports a refusal as the portal refusing, and names the hub that needs no portal', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const error = await searchPortal(FOURDN, 'HCT116', { fetchImpl }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ViewerError)
    const viewerError = error as ViewerError
    expect(viewerError.code).toBe('remote-cors')
    expect(viewerError.message).toContain('did not let this page read its search results')
    expect(viewerError.message).toContain('"4DN open data"')
    expect(viewerError.message).toContain('Failed to fetch')
    expect(viewerError.detail['portal']).toBe('4dn')
  })

  it('names the ENCODE hub in ENCODE’s own refusal', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    await expect(searchPortal(ENCODE, 'x', { fetchImpl })).rejects.toThrow(/"ENCODE Hi-C"/)
  })

  /** Never a proxy. SPECS C1, §23.4, and the message says as much. */
  it('offers no way round it', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    await expect(searchPortal(ENCODE, 'x', { fetchImpl })).rejects.toThrow(
      /nothing to proxy through/,
    )
  })

  /**
   * snovault answers a search that matched nothing with `404` and a JSON body
   * saying so — recorded for 4DN in SPECS §23.3, and true of ENCODE's identical
   * stack. Read as a failure it turns "no hits" into a red box; and since the
   * path is a constant in the adapter, a 404 here cannot mean a mistyped URL.
   */
  it('reads a 404 as zero results, on either portal', async () => {
    for (const portal of [FOURDN, ENCODE] as Portal[]) {
      const { fetchImpl } = serve({ code: 404, description: 'No results found.' }, {
        status: 404,
        statusText: 'Not Found',
      })
      const hub = await searchPortal(portal, 'nothing at all', { fetchImpl })
      expect(hub.entries).toEqual([])
      expect(hub.name).toBe(`${portal.label}: "nothing at all"`)
      expect(hub.description).toBeUndefined()
    }
  })

  it('carries the status of any other HTTP failure', async () => {
    const { fetchImpl } = serve('<html>gateway</html>', { status: 502, statusText: 'Bad Gateway' })
    const error = await searchPortal(ENCODE, 'x', { fetchImpl }).catch((err: unknown) => err)
    expect((error as ViewerError).message).toContain('answered 502 Bad Gateway')
    expect((error as ViewerError).detail['status']).toBe(502)
  })

  it('refuses a body that is not JSON, naming what was asked for', async () => {
    const { fetchImpl } = serve('<html>a login page</html>')
    await expect(searchPortal(FOURDN, 'x', { fetchImpl })).rejects.toThrow(/is not JSON/)
  })
})
