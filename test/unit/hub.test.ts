/**
 * The hub format: what it refuses, what it tolerates, and where names end up.
 *
 * Two halves, and the second is the one with the failures nobody sees. Parsing
 * is a gate — a JSON that is not a hub has to be told apart from one that is,
 * and a hub from a newer build has to be refused rather than half-read — and a
 * gate that is wrong is wrong loudly.
 *
 * Resolution is quiet. A hub with relative names is the whole reason a dataset
 * folder can be copied to another bucket (§23.1), and every way of getting it
 * wrong produces a *plausible* URL: one directory up, the `::entries/rep1` half
 * swallowed into the path, a `#index=` left pointing at the page the viewer is
 * served from. None of those throws; all of them 404 on somebody else's machine
 * a week later. So the relative cases are enumerated here rather than sampled.
 */

import { describe, expect, it } from 'vitest'

import {
  HUB_KIND,
  HUB_VERSION,
  fetchHub,
  kindOf,
  parseHub,
  resolveHub,
  type Hub,
} from '@/state/hub'
import { isRefusal, refusalMessage } from '@/state/SessionConfig'

/** The smallest thing that is a hub, as text. */
function hubText(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind: HUB_KIND, version: HUB_VERSION, name: 'A hub', ...extra })
}

/** Parse and insist it was not refused, so the tests below read as one line. */
function parsed(text: string): Hub {
  const read = parseHub(text)
  expect(isRefusal(read) ? refusalMessage(read, 'hub.json') : '').toBe('')
  return read as Hub
}

describe('parsing a hub', () => {
  it('reads a valid one whole', () => {
    const hub = parsed(
      hubText({
        description: 'two files',
        generatedAt: '2026-09-11T04:17:00Z',
        source: 'https://data.4dnucleome.org/search/?type=FileProcessed',
        base: 'https://data.example/maps/',
        columns: [
          { key: 'assembly', label: 'Assembly' },
          { key: 'lab', label: 'Lab' },
        ],
        entries: [
          {
            label: 'GM12878 in situ',
            uri: 'a.mcool',
            kind: 'map',
            size: 2191787975,
            note: '4DNFIOKRZ21H',
            fields: { assembly: 'GRCh38', lab: 'Dekker' },
            tracks: [{ label: 'CTCF', url: 'ctcf.bw' }],
          },
        ],
      }),
    )
    expect(hub.kind).toBe(HUB_KIND)
    expect(hub.version).toBe(HUB_VERSION)
    expect(hub.name).toBe('A hub')
    expect(hub.description).toBe('two files')
    expect(hub.generatedAt).toBe('2026-09-11T04:17:00Z')
    expect(hub.source).toContain('4dnucleome')
    expect(hub.base).toBe('https://data.example/maps/')
    expect(hub.columns).toEqual([
      { key: 'assembly', label: 'Assembly' },
      { key: 'lab', label: 'Lab' },
    ])
    expect(hub.entries).toHaveLength(1)
    expect(hub.entries[0]).toEqual({
      label: 'GM12878 in situ',
      uri: 'a.mcool',
      kind: 'map',
      size: 2191787975,
      note: '4DNFIOKRZ21H',
      fields: { assembly: 'GRCh38', lab: 'Dekker' },
      tracks: [{ label: 'CTCF', url: 'ctcf.bw' }],
    })
  })

  it('refuses what is not JSON at all', () => {
    const read = parseHub('<!doctype html><title>404</title>')
    expect(isRefusal(read) && read.reason).toBe('not-json')
  })

  it('refuses a JSON file that does not name itself a hub', () => {
    // The case that matters: a *workspace* pasted into the hub box. Both are
    // `.json`, both are this app's, and only a distinct reason can say which of
    // the two the reader is holding.
    for (const text of [
      '{"kind":"metacooler.workspace","version":1,"tabs":[]}',
      '{"name":"dependencies"}',
      '[1, 2, 3]',
      '"a string"',
      'null',
    ]) {
      const read = parseHub(text)
      expect(isRefusal(read) && read.reason, text).toBe('not-a-hub')
    }
  })

  it('says what a file that is not a hub is missing, and names the fix', () => {
    const read = parseHub('{"kind":"metacooler.workspace","version":1}')
    const said = refusalMessage(read as { reason: 'not-a-hub' }, 'lab.json')
    expect(said).toContain('lab.json')
    expect(said).toContain('metacooler.hub')
    // A reason with no fix in it is a reason a reader can do nothing with.
    expect(said).toContain('make_hub.py')
  })

  it('refuses a hub from a newer build rather than half-reading it', () => {
    const read = parseHub(
      hubText({ version: HUB_VERSION + 1, producer: '(meta)cooler 9.0.0', entries: [] }),
    )
    expect(isRefusal(read)).toBe(true)
    expect(read).toMatchObject({
      reason: 'newer',
      version: HUB_VERSION + 1,
      producer: '(meta)cooler 9.0.0',
    })
    expect(refusalMessage(read as never, 'hub.json')).toContain('newer version')
  })

  it('treats a version that is not a whole number as a file that is not a hub', () => {
    // There are no minor versions of this format to be at, so `1.5` is not a
    // version at all — it fails identity rather than being rounded into one.
    expect(isRefusal(parseHub(hubText({ version: 1.5, entries: [] })))).toBe(true)
    expect(parseHub(hubText({ version: 1.5, entries: [] }))).toEqual({ reason: 'not-a-hub' })
    expect(parseHub(hubText({ version: 'one', entries: [] }))).toEqual({ reason: 'not-a-hub' })
  })

  it('takes a missing version as this one', () => {
    expect(parsed(JSON.stringify({ kind: HUB_KIND, entries: [] })).version).toBe(HUB_VERSION)
  })

  it('drops an entry with no label or no uri, and keeps the rest', () => {
    const hub = parsed(
      hubText({
        entries: [
          { label: 'kept', uri: 'a.cool' },
          { uri: 'no-label.cool' },
          { label: 'no uri' },
          { label: '', uri: 'empty-label.cool' },
          { label: 'empty uri', uri: '' },
          'not an object',
          null,
          { label: 'also kept', uri: 'b.cool' },
        ],
      }),
    )
    // Six bad rows do not cost the reader the two good ones.
    expect(hub.entries.map((entry) => entry.label)).toEqual(['kept', 'also kept'])
  })

  it('defaults the kind from the file name when the hub does not say', () => {
    const hub = parsed(
      hubText({
        entries: [
          { label: 'a', uri: 'figure.metacooler.json' },
          { label: 'b', uri: 'sample.mcool' },
          { label: 'c', uri: 'reads.bw' },
          { label: 'd', uri: 'x.mcool::resolutions/1000' },
          { label: 'e', uri: 'https://host.example/genes.gtf.gz' },
          // No extension to route on: a curated catalogue may name an S3 key
          // that has none, and dropping the row would silently shorten it.
          { label: 'f', uri: 'https://host.example/opaque-key' },
          // An explicit kind this build does not know is treated as absent.
          { label: 'g', uri: 'sample.mcool', kind: 'nonsense' },
        ],
      }),
    )
    expect(hub.entries.map((entry) => entry.kind)).toEqual([
      'workspace',
      'map',
      'genome',
      'map',
      'genome',
      'map',
      'map',
    ])
  })

  it('keeps an explicit kind over the name', () => {
    // A published `.json` that is a *map* in some other sense is not a thing;
    // the reverse is: a generator naming a `.hic` it wants opened as a
    // workspace has said so, and the file name is the weaker evidence.
    const hub = parsed(
      hubText({ entries: [{ label: 'a', uri: 'session.json', kind: 'map' }] }),
    )
    expect(hub.entries[0].kind).toBe('map')
  })

  it('defaults columns to [] and drops the ones that cannot be looked up', () => {
    expect(parsed(hubText({ entries: [] })).columns).toEqual([])
    expect(parsed(hubText({ columns: 'not a list', entries: [] })).columns).toEqual([])
    const hub = parsed(
      hubText({
        columns: [
          { key: 'assembly' },
          { label: 'no key' },
          { key: 'assembly', label: 'again' },
          { key: 'lab', label: 'Lab' },
        ],
        entries: [],
      }),
    )
    // A keyless column is a header over a cell nothing can fill; a repeated key
    // is the same column twice.
    expect(hub.columns).toEqual([
      { key: 'assembly', label: 'assembly' },
      { key: 'lab', label: 'Lab' },
    ])
  })

  it('ignores unknown keys, which is what lets a generator run ahead', () => {
    const hub = parsed(
      hubText({
        futureThing: { anything: true },
        entries: [{ label: 'a', uri: 'a.cool', futureField: 7 }],
      }),
    )
    expect(hub.entries[0]).toEqual({ label: 'a', uri: 'a.cool', kind: 'map' })
  })

  it('keeps only values a table cell can hold', () => {
    const hub = parsed(
      hubText({
        entries: [
          {
            label: 'a',
            uri: 'a.cool',
            size: 'big',
            fields: { assembly: 'hg38', count: 4, nested: { a: 1 } },
            tracks: [{ label: 'ok', url: 'x.bw' }, { label: 'no url' }, 'nonsense'],
          },
          { label: 'b', uri: 'b.cool', size: -1 },
        ],
      }),
    )
    expect(hub.entries[0].size).toBeUndefined()
    expect(hub.entries[0].fields).toEqual({ assembly: 'hg38' })
    expect(hub.entries[0].tracks).toEqual([{ label: 'ok', url: 'x.bw' }])
    expect(hub.entries[1].size).toBeUndefined()
  })
})

describe('kindOf', () => {
  it('is the app’s one routing table, plus the workspace name', () => {
    expect(kindOf('x.metacooler.json')).toBe('workspace')
    expect(kindOf('https://h/x.json?v=2')).toBe('workspace')
    expect(kindOf('x.hic')).toBe('map')
    expect(kindOf('x.pairs.gz')).toBe('map')
    expect(kindOf('x.bedpe')).toBe('genome')
    expect(kindOf('x.bam')).toBe('genome')
  })
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const AT = 'https://catalogue.example/hubs/lab.json'

/** A hub of one entry, for the resolution cases. */
function one(uri: string, extra: Partial<Hub> = {}, tracks?: Array<{ label: string; url: string }>): Hub {
  return {
    kind: HUB_KIND,
    version: HUB_VERSION,
    name: 'A hub',
    columns: [],
    entries: [{ label: 'a', uri, kind: 'map', ...(tracks === undefined ? {} : { tracks }) }],
    ...extra,
  }
}

describe('resolving a hub', () => {
  it('resolves a relative name against the declared base', () => {
    const hub = resolveHub(one('a.mcool', { base: 'https://data.example/maps/' }), AT)
    expect(hub.entries[0].uri).toBe('https://data.example/maps/a.mcool')
  })

  it('resolves a relative name against the hub’s own directory when there is no base', () => {
    // The property that makes a hub beside its data copyable: the folder moves,
    // the names do not change, and everything still opens.
    expect(resolveHub(one('a.mcool'), AT).entries[0].uri).toBe(
      'https://catalogue.example/hubs/a.mcool',
    )
    expect(resolveHub(one('sub/a.mcool'), AT).entries[0].uri).toBe(
      'https://catalogue.example/hubs/sub/a.mcool',
    )
    expect(resolveHub(one('../up/a.mcool'), AT).entries[0].uri).toBe(
      'https://catalogue.example/up/a.mcool',
    )
  })

  it('resolves the base itself, and repairs one that lost its slash', () => {
    expect(resolveHub(one('a.mcool', { base: 'data/' }), AT).entries[0].uri).toBe(
      'https://catalogue.example/hubs/data/a.mcool',
    )
    // Without the repair, URL resolution drops the last segment of the prefix
    // and every entry lands one directory up — a plausible 404 for every row.
    const hub = resolveHub(one('a.mcool', { base: 'https://data.example/maps' }), AT)
    expect(hub.entries[0].uri).toBe('https://data.example/maps/a.mcool')
    expect(hub.base).toBe('https://data.example/maps/')
  })

  it('leaves an absolute http(s) name alone', () => {
    for (const uri of ['https://other.example/a.mcool', 'http://other.example/a.mcool']) {
      expect(resolveHub(one(uri, { base: 'https://data.example/maps/' }), AT).entries[0].uri).toBe(
        uri,
      )
    }
  })

  /**
   * §23.5: a row carries the form that opens. The rewrite is the same one every
   * URL box applies, so a hub may name a `gs://` object or a Dropbox share link
   * and the picker hands over — and a shared link then carries — the working
   * URL rather than the page it stands for.
   */
  it('canonicalises an absolute name that is not yet the file', () => {
    const at = (uri: string): string =>
      resolveHub(one(uri, { base: 'https://data.example/maps/' }), AT).entries[0].uri
    expect(at('gs://bucket/dir/key.hic')).toBe(
      'https://storage.googleapis.com/storage/v1/b/bucket/o/dir%2Fkey.hic?alt=media',
    )
    expect(at('s3://bucket/key.hic')).toBe('https://bucket.s3.amazonaws.com/key.hic')
    expect(at('https://www.dropbox.com/s/abc/map.mcool?dl=0')).toBe(
      'https://dl.dropboxusercontent.com/s/abc/map.mcool?dl=0',
    )
    // The group half survives the rewrite, as it survives resolution (and is
    // written absolute, as `parseUri` reads it).
    expect(at('s3://bucket/key.mcool::resolutions/1000')).toBe(
      'https://bucket.s3.amazonaws.com/key.mcool::/resolutions/1000',
    )
  })

  it('keeps the ::group half out of the arithmetic', () => {
    // The group names a path *inside* the file. Folded into the URL it becomes
    // `…/a.mcool/resolutions/1000`, which is a 404 with no clue in it.
    const hub = resolveHub(one('a.mcool::resolutions/1000'), AT)
    expect(hub.entries[0].uri).toBe('https://catalogue.example/hubs/a.mcool::/resolutions/1000')
    expect(
      resolveHub(one('https://other.example/a.mcool::entries/rep1'), AT).entries[0].uri,
    ).toBe('https://other.example/a.mcool::/entries/rep1')
  })

  it('keeps an index fragment, and resolves a relative one with it', () => {
    // Preserved absolute…
    expect(
      resolveHub(one('reads.bam#index=https://other.example/reads.bam.bai'), AT).entries[0].uri,
    ).toBe('https://catalogue.example/hubs/reads.bam#index=https://other.example/reads.bam.bai')
    // …and resolved when relative, which is the case that would otherwise send
    // the sidecar probe at whatever origin the viewer happens to be served from.
    expect(resolveHub(one('reads.bam#index=reads.bam.bai'), AT).entries[0].uri).toBe(
      'https://catalogue.example/hubs/reads.bam#index=https://catalogue.example/hubs/reads.bam.bai',
    )
    expect(resolveHub(one('m.matrix.gz#bins=m.bed'), AT).entries[0].uri).toBe(
      'https://catalogue.example/hubs/m.matrix.gz#bins=https://catalogue.example/hubs/m.bed',
    )
  })

  it('resolves the tracks a row carries the same way', () => {
    const hub = resolveHub(
      one('a.mcool', { base: 'https://data.example/maps/' }, [
        { label: 'CTCF', url: 'ctcf.bw' },
        { label: 'elsewhere', url: 'https://other.example/x.bw' },
      ]),
      AT,
    )
    expect(hub.entries[0].tracks).toEqual([
      { label: 'CTCF', url: 'https://data.example/maps/ctcf.bw' },
      { label: 'elsewhere', url: 'https://other.example/x.bw' },
    ])
  })

  it('leaves everything that is not a name exactly as it was', () => {
    const hub = one('a.mcool', {
      description: 'd',
      generatedAt: 'g',
      source: 's',
      columns: [{ key: 'k', label: 'L' }],
    })
    const out = resolveHub(hub, AT)
    expect(out.name).toBe(hub.name)
    expect(out.description).toBe('d')
    expect(out.generatedAt).toBe('g')
    expect(out.source).toBe('s')
    expect(out.columns).toEqual([{ key: 'k', label: 'L' }])
    // And the input is not mutated: `show()` may be handed the same hub twice.
    expect(hub.entries[0].uri).toBe('a.mcool')
  })
})

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** A `fetch` that answers once, with whatever the case needs. */
function answering(
  status: number,
  body: string,
  seen: string[] = [],
): typeof fetch {
  return ((url: string) => {
    seen.push(String(url))
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'Error',
      text: () => Promise.resolve(body),
    } as unknown as Response)
  }) as unknown as typeof fetch
}

describe('fetching a hub', () => {
  it('reads one, and resolves it against where it was found', async () => {
    const seen: string[] = []
    const result = await fetchHub(AT, {
      fetchImpl: answering(200, hubText({ entries: [{ label: 'a', uri: 'a.mcool' }] }), seen),
    })
    expect(seen).toEqual([AT])
    expect(result.ok).toBe(true)
    expect(result.ok && result.hub.entries[0].uri).toBe('https://catalogue.example/hubs/a.mcool')
  })

  it('tells a 404 apart from every other failure', async () => {
    // The whole reason this answers with a union rather than a throw: the two
    // generated hubs do not exist until the workflow has run, and "the host
    // answered 404" sends somebody to check a URL that is perfectly correct.
    const result = await fetchHub(AT, { fetchImpl: answering(404, 'Not Found') })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('missing')
  })

  it('reports any other status as itself', async () => {
    const result = await fetchHub(AT, { fetchImpl: answering(503, '') })
    expect(!result.ok && result.reason).toBe('http')
    expect(!result.ok && result.reason === 'http' && result.status).toBe(503)
  })

  it('carries a refusal out rather than swallowing it', async () => {
    const result = await fetchHub(AT, { fetchImpl: answering(200, 'not json at all') })
    expect(!result.ok && result.reason).toBe('refused')
    expect(!result.ok && result.reason === 'refused' && result.refusal.reason).toBe('not-json')
  })

  it('answers a dead fetch with the CORS sentence rather than throwing', async () => {
    const dead = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    const result = await fetchHub(AT, { fetchImpl: dead })
    expect(!result.ok && result.reason).toBe('network')
    expect(!result.ok && result.message).toContain('cross-origin')
  })
})
