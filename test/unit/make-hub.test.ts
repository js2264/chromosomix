/**
 * `scripts/make_hub.py`, run for real, against recorded portal responses.
 *
 * The generator writes the file `src/state/hub.ts` parses, and the two halves
 * are in different languages, in different processes, checked by different
 * suites. Nothing but a test that runs the script and reads its output can
 * catch the failure that matters: a hub that is *valid JSON and wrong* — a
 * column renamed, a size that became a string, a relative name with no base to
 * resolve it against. The viewer's parser is deliberately forgiving (an entry
 * with no label is dropped, an unknown key ignored, SPECS §23.1), which is
 * right for a hub somebody else wrote and is exactly why the generator's own
 * output has to be pinned somewhere. This is that somewhere.
 *
 * ## Where the fixtures come from
 *
 * `test/fixtures-hubs/*.json` are recorded-*shape* responses, not recordings:
 * neither portal is reachable from a development sandbox or from this suite, so
 * they were built from the portals' own schemas (`file_processed.json` and
 * `types/file.py`'s `open_data_url` and `track_and_facet_info` at 4DN;
 * `schemas/file.json` and `types/file.py`'s `cloud_metadata` at ENCODE) and
 * filled with values lifted from igv-data's generated tables (MIT) and from a
 * real walk of the two public buckets. Every 4DN accession, UUID and byte count
 * here is a real object on `4dn-open-data-public`; so are the four ENCODE keys
 * under `2020/09/03/`, whose sizes came from a `HEAD`. The rest — the ENCODE
 * experiment metadata for those four, and the two older `encode-public` keys —
 * is plausible rather than measured, because the portal that holds the join was
 * not reachable. That is honest for a fixture whose job is to pin the *shape*
 * of the mapping, and it is the reason the first live run is worth watching.
 *
 * Each fixture carries one record that must be skipped entirely, because the
 * skipping is the part with a decision in it:
 *
 * - 4DN's `4DNES4TZF88L` has three processed files and publishes none of them:
 *   one with a `genome_assembly` and **no `open_data_url`** (`released to
 *   project` — the calculated property is `None` off the open bucket), one
 *   whose `open_data_url` is a `.pairs.gz` (not a wanted format), and one with
 *   an `open_data_url` and **no `genome_assembly`**.
 * - ENCODE's `ENCSR481HGA` likewise: an **archived** `.hic`, a `bigWig`, and a
 *   released `.hic` with neither `cloud_metadata` nor `href`.
 *
 * And each carries a record that would have been lost by the obvious wrong
 * implementation: 4DN's Micro-C set, which igv-data's seven-experiment-type
 * filter drops and Contract 4 says to keep, and which also has no
 * `track_and_facet_info` and no `file_size` — so it proves both fallbacks and
 * the "size only when known" rule in one row.
 *
 * The bucket pages are the `ListObjectsV2` XML, in two parts with a
 * continuation token between them, and three of their objects carry the
 * `<ChecksumAlgorithm>`/`<ChecksumType>` pair that sits between `<ETag>` and
 * `<Size>` on anything written recently. A parser that reads the block
 * positionally drops those three and says nothing, which is how the first
 * census of the 4DN bucket came out a quarter short (SPECS §23.3).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = decodeURIComponent(new URL('../../', import.meta.url).pathname)
const SCRIPT = join(REPO, 'scripts', 'make_hub.py')
const FIXTURES = join(REPO, 'test', 'fixtures-hubs')

/**
 * A hub as it comes off disk — `unknown`-ish on purpose.
 *
 * The point of the assertions below is that the file has this shape; typing the
 * parse as `Hub` would assume the answer.
 */
interface RawHub {
  kind?: unknown
  version?: unknown
  name?: unknown
  description?: unknown
  generatedAt?: unknown
  source?: unknown
  base?: unknown
  columns?: Array<{ key?: unknown; label?: unknown }>
  entries?: Array<Record<string, unknown>>
}

/**
 * `python3` on the PATH, or nothing to run.
 *
 * Skipped by name rather than failing, the way `real-file.test.ts` skips a
 * gitignored dataset: a fresh clone on a machine with no Python must still see
 * a green suite, and the workflow that runs this generator sets up Python
 * itself.
 */
const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const havePython = probe.error === undefined && probe.status === 0

let out = ''

function make(...args: string[]): { status: number; stderr: string } {
  const result = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: result.status ?? -1, stderr: result.stderr ?? '' }
}

function built(front: string, fixture: string, name: string, ...extra: string[]): RawHub {
  const target = join(out, name)
  const flag = front === 'bucket' ? '--from-xml' : '--from-json'
  const positional = front === 'bucket' ? ['https://lab-hic-public.s3.amazonaws.com/maps/'] : []
  const run = make(front, ...positional, flag, join(FIXTURES, fixture), '--out', target, ...extra)
  expect(run.stderr, run.stderr).not.toMatch(/Traceback/)
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(readFileSync(target, 'utf8')) as RawHub
}

/** Every entry's absolute URL, resolved the way `resolveHub` will resolve it. */
function absolute(hub: RawHub): string[] {
  const base = typeof hub.base === 'string' ? hub.base : undefined
  return (hub.entries ?? []).map((entry) => {
    const uri = String(entry.uri)
    return base === undefined ? uri : new URL(uri, base).href
  })
}

beforeAll(() => {
  if (!havePython) return
  out = mkdtempSync(join(tmpdir(), 'metacooler-hub-'))
})

afterAll(() => {
  if (out !== '') rmSync(out, { recursive: true, force: true })
})

describe.skipIf(!havePython)('the 4DN front end', () => {
  let hub: RawHub

  beforeAll(() => {
    hub = built('4dn', '4dn-search.json', '4dn.json', '--check')
  })

  it('writes the Contract-1 envelope, with provenance', () => {
    expect(hub.kind).toBe('metacooler.hub')
    expect(hub.version).toBe(1)
    expect(hub.name).toBe('4DN open data')
    expect(typeof hub.description).toBe('string')
    // A shelf with no provenance is a screenshot (SPECS §23.3): the query it
    // came from and the instant it was written are both in the file.
    expect(hub.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(String(hub.source)).toContain('data.4dnucleome.org/search/')
    expect(String(hub.source)).toContain('type=ExperimentSetReplicate')
    // No experiment-type filter, which is the whole difference from igv-data's
    // query and the reason the Micro-C row below survives.
    expect(String(hub.source)).not.toContain('experiment_type.display_title=')
  })

  it('declares its columns in the fixed order, assembly first', () => {
    expect(hub.columns?.map((column) => column.key)).toEqual([
      'assembly',
      'biosource',
      'assay',
      'dataset',
      'lab',
      'project',
    ])
    expect(hub.columns?.map((column) => column.label)).toEqual([
      'Assembly',
      'Biosource',
      'Assay',
      'Dataset',
      'Lab',
      'Project',
    ])
  })

  it('keeps exactly the files that have an open-data URL, an assembly and a wanted format', () => {
    expect(hub.entries).toHaveLength(6)
    const text = JSON.stringify(hub)
    // The three ways the last record fails, and the bigWig beside a kept map.
    for (const skipped of [
      '4DNFI111EI3K', // released to project: no open_data_url
      '4DNFIRZ9WSAO', // .pairs.gz: not a wanted format
      '4DNFIH8XQ2KM', // no genome_assembly
      '4DNFIK9NBYGJ', // .bw beside a kept .hic
    ]) {
      expect(text, `${skipped} should have been skipped`).not.toContain(skipped)
    }
  })

  it('sorts by assembly and then label', () => {
    expect(hub.entries?.map((entry) => entry.label)).toEqual([
      'Hi-C on GM12878 cells - protocol variations — 4DNFI7J8BQ4P (hic)',
      'Hi-C on HFF cells - protocol variations — 4DNFIMROE6N4 (hic)',
      'Hi-C on HFF cells - protocol variations — 4DNFIQ9FG7RR (mcool)',
      'Hi-C on RAD21-AID tagged HCT-116 — 4DNFIM7ZVQOQ (hic)',
      'Micro-C on HFF cells — 4DNFIO2TD17P (mcool)',
      'HiC on S2 cells +/- Heat Shock — 4DNFIOTPSS3L (hic)',
    ])
    const assemblies = (hub.entries ?? []).map(
      (entry) => (entry.fields as Record<string, string>).assembly,
    )
    expect(assemblies).toEqual(['GRCh38', 'GRCh38', 'GRCh38', 'GRCh38', 'GRCh38', 'dm6'])
  })

  it('names every entry relative to one base, which rejoins to the object', () => {
    expect(hub.base).toBe(
      'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/',
    )
    for (const entry of hub.entries ?? []) {
      expect(String(entry.uri)).not.toMatch(/^https?:/)
    }
    // The measured file from the contract's reference data, byte for byte.
    expect(absolute(hub)[3]).toBe(
      'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/' +
        '000789fe-9a22-4280-a71c-7ad228fd4cac/4DNFIM7ZVQOQ.hic',
    )
  })

  it('carries the kind, the size and the facets of one row in full', () => {
    expect(hub.entries?.[3]).toEqual({
      label: 'Hi-C on RAD21-AID tagged HCT-116 — 4DNFIM7ZVQOQ (hic)',
      uri: '000789fe-9a22-4280-a71c-7ad228fd4cac/4DNFIM7ZVQOQ.hic',
      kind: 'map',
      size: 839405381,
      note:
        '4DNFIM7ZVQOQ · 4DNESD117NVX · Rao SSP et al. (2017) PMID:28985562 · ' +
        'RAD21 not depleted · merged replicates',
      fields: {
        assembly: 'GRCh38',
        biosource: 'HCT116 with Crispr generated mClover and AID-tagged RAD21',
        // The experiment type and the enzyme in one cell, which is what a
        // reader filters on and what the demo hub's hand-written row says.
        assay: 'in situ Hi-C (MboI)',
        dataset: 'Hi-C on RAD21-AID tagged HCT-116',
        lab: 'Erez Lieberman Aiden, BCM',
        project: 'External',
      },
    })
  })

  it('reads the set accession off @id when the field list did not ask for one', () => {
    // `field=` returns only what it names, and Contract 4 fixes that list; the
    // set that carries no `accession` of its own still has to be named.
    expect(String(hub.entries?.[3].note)).toContain('4DNESD117NVX')
    expect(String(hub.entries?.[0].note)).toContain('4DNESLLTENG9')
  })

  it('falls back to the set when a file has no track_and_facet_info, and omits an unknown size', () => {
    const microC = hub.entries?.[4] as Record<string, unknown>
    expect(microC.size).toBeUndefined()
    expect(microC.fields).toEqual({
      assembly: 'GRCh38',
      // No `biosource_name` anywhere on this file: the organism the set names
      // is a worse answer than a cell line and a much better one than blank.
      biosource: 'human',
      // From `experiments_in_set[].experiment_type.display_title`, with no
      // enzyme to put in brackets.
      assay: 'Micro-C',
      dataset: 'Micro-C on HFF cells',
      lab: 'Job Dekker, UMMS',
      project: '4DN',
    })
  })

  it('accepts its own output', () => {
    expect(make('check', join(out, '4dn.json')).status).toBe(0)
  })
})

describe.skipIf(!havePython)('the ENCODE front end', () => {
  let hub: RawHub

  beforeAll(() => {
    hub = built('encode', 'encode-search.json', 'encode.json')
  })

  it('writes the Contract-1 envelope and its own column order', () => {
    expect(hub.kind).toBe('metacooler.hub')
    expect(hub.version).toBe(1)
    expect(hub.name).toBe('ENCODE Hi-C')
    expect(hub.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(String(hub.source)).toContain('www.encodeproject.org/search/')
    expect(String(hub.source)).toContain('files.file_format=hic')
    expect(hub.columns?.map((column) => column.key)).toEqual([
      'assembly',
      'biosample',
      'assay',
      'target',
      'lab',
      'output',
    ])
  })

  it('keeps released .hic files and nothing else', () => {
    expect(hub.entries).toHaveLength(6)
    const text = JSON.stringify(hub)
    for (const skipped of [
      'ENCFF922ERE', // revoked
      'ENCFF465ESX', // archived
      'ENCFF640PLW', // bigWig
      'ENCFF311ZQF', // bigWig
      'ENCFF802KNB', // released .hic with no cloud_metadata and no href
    ]) {
      expect(text, `${skipped} should have been skipped`).not.toContain(skipped)
    }
  })

  it('prefers the unsigned bucket object, and falls back to the portal path', () => {
    // SPECS §23.3: `@@download` answers 307 to a URL presigned for GET alone,
    // which this viewer opens but a year-old catalogue should not depend on.
    expect(absolute(hub)[1]).toBe(
      'https://encode-public.s3.amazonaws.com/2020/09/03/' +
        'edc545e2-ffe0-48a3-b749-929486737094/ENCFF288DNV.hic',
    )
    expect(absolute(hub)[4]).toBe(
      'https://www.encodeproject.org/files/ENCFF706SFK/@@download/ENCFF706SFK.hic',
    )
  })

  it('declares no base when the entries do not share an origin, and is absolute throughout', () => {
    // One row on the portal and the rest on the bucket: `https://` is a common
    // prefix ending in a slash and would be a catastrophic base, so there is
    // none, and every name is absolute instead.
    expect(hub.base).toBeUndefined()
    for (const entry of hub.entries ?? []) {
      expect(String(entry.uri)).toMatch(/^https:\/\//)
    }
  })

  it('sorts by assembly then label, and fills one row completely', () => {
    expect(hub.entries?.map((entry) => entry.label)).toEqual([
      'Homo sapiens GM12878 — ENCFF995DKN (hic)',
      'Homo sapiens HL-60/S4 — ENCFF288DNV (hic)',
      'Homo sapiens hTERT RPE-1 — ENCFF876OWE (hic)',
      'Homo sapiens HL-60/S4 — ENCFF177TYX (hic)',
      'Homo sapiens mammary epithelial cell female — ENCFF706SFK (hic)',
      'Mus musculus strain B10.H-2aH-4bp/Wts CH12F3 — ENCFF759YCW (hic)',
    ])
    expect(hub.entries?.[0]).toEqual({
      label: 'Homo sapiens GM12878 — ENCFF995DKN (hic)',
      uri:
        'https://encode-public.s3.amazonaws.com/2020/09/03/' +
        '2d513131-0269-4866-97a6-cb6d3cc95835/ENCFF995DKN.hic',
      kind: 'map',
      size: 11330455239,
      note: 'ENCFF995DKN · ENCSR000CAC · biorep 1 · techrep 1_1',
      fields: {
        assembly: 'GRCh38',
        biosample: 'Homo sapiens GM12878',
        assay: 'in situ ChIA-PET',
        // "CTCF (Homo sapiens)" on the portal: the species is the assembly's
        // business, and a Target column of binomials filters on nothing.
        target: 'CTCF',
        lab: 'Michael Snyder, Stanford',
        output: 'contact matrix',
      },
    })
  })

  it('leaves an empty cell out rather than writing it as an empty string', () => {
    // Contract 1 renders a missing key as empty anyway, so the pair carries
    // nothing — and a hub that spells out every blank turns a diff into a wall.
    expect(hub.entries?.[1].fields).not.toHaveProperty('target')
  })

  it('accepts its own output', () => {
    expect(make('check', join(out, 'encode.json')).status).toBe(0)
  })
})

describe.skipIf(!havePython)('the bucket front end', () => {
  let hub: RawHub

  beforeAll(() => {
    hub = built('bucket', 'bucket-listing', 'bucket.json', '--name', 'Lab Hi-C', '--check')
  })

  it('follows the continuation token across both pages', () => {
    // Six rows out of nine objects, and three of the six are on the second
    // page: a walk that stopped at `IsTruncated` would find three.
    expect(hub.entries).toHaveLength(6)
    expect(JSON.stringify(hub)).toContain('Yeast_microC.pairs.gz')
  })

  it('reads a <Size> that a <ChecksumAlgorithm> was inserted in front of', () => {
    const sizes = Object.fromEntries(
      (hub.entries ?? []).map((entry) => [entry.label, entry.size]),
    )
    // All three of these carry <ChecksumAlgorithm>/<ChecksumType> between
    // <ETag> and <Size>. A positional parser reads them as zero, or not at all.
    expect(sizes['Yeast_microC_G2M_1kb.mcool']).toBe(128974848)
    expect(sizes['Yeast_ATAC.bw']).toBe(1014554)
    expect(sizes['Yeast_microC.pairs.gz']).toBe(3218866176)
    // And one without, so the absence of the element is not what is being read.
    expect(sizes['Yeast_hic.hic']).toBe(44359680)
  })

  it('routes each name to a door, and drops the names with none', () => {
    expect(
      (hub.entries ?? []).map((entry) => [entry.label, entry.kind, entry.uri]),
    ).toEqual([
      ['Yeast_ATAC.bw', 'genome', 'annotations/Yeast_ATAC.bw'],
      ['Yeast_annotations.gtf', 'genome', 'annotations/Yeast_annotations.gtf'],
      ['Yeast_hic.hic', 'map', 'Yeast_hic.hic'],
      ['Yeast_microC.pairs.gz', 'map', 'reads/Yeast_microC.pairs.gz'],
      ['Yeast_microC_G2M_1kb.mcool', 'map', 'Yeast_microC_G2M_1kb.mcool'],
      ['Yeast_tracks.metacooler.json', 'workspace', 'Yeast_tracks.metacooler.json'],
    ])
    const text = JSON.stringify(hub)
    // Two pairix indexes and the zero-byte key a console calls a folder.
    expect(text).not.toContain('.px2')
    expect(hub.base).toBe('https://lab-hic-public.s3.amazonaws.com/maps/yeast/')
  })

  it('has no columns, because a bucket knows a name and a size and nothing else', () => {
    expect(hub.columns).toEqual([])
    for (const entry of hub.entries ?? []) expect(entry.fields).toBeUndefined()
  })

  it('accepts its own output', () => {
    expect(make('check', join(out, 'bucket.json')).status).toBe(0)
  })
})

describe.skipIf(!havePython)('a run that found nothing', () => {
  it('exits 2 and writes no file, so a workflow can leave the good hub alone', () => {
    // The body 4DN answers a search with no hits: HTTP 404 with a JSON
    // `HTTPNotFound`, which the generator reads as zero results rather than as
    // a failure (SPECS §23.3) — and then refuses to publish zero rows.
    const target = join(out, 'never-written.json')
    const run = make('4dn', '--from-json', join(FIXTURES, '4dn-empty.json'), '--out', target)
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/No entries/)
    expect(existsSync(target)).toBe(false)
  })
})

describe.skipIf(!havePython)('--check', () => {
  it('refuses a hub whose entries lost what the table draws them from', () => {
    const good = JSON.parse(readFileSync(join(out, '4dn.json'), 'utf8')) as RawHub
    const broken = {
      ...good,
      base: undefined,
      entries: [
        { ...(good.entries ?? [])[0], label: '' },
        { label: 'later', uri: 'x/y.hic', kind: 'contact map', size: '2 GB' },
      ],
    }
    const target = join(out, 'broken.json')
    writeFileSync(target, JSON.stringify(broken), 'utf8')

    const run = make('check', target)
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/has no label/)
    expect(run.stderr).toMatch(/kind 'contact map'/)
    expect(run.stderr).toMatch(/not a byte count/)
    // The one that would publish silently and resolve against
    // raw.githubusercontent.com: a relative name with no base to join it to.
    expect(run.stderr).toMatch(/declares no base/)
  })
})

describe.skipIf(!havePython)('--formats and a recorded response in pieces', () => {
  it('keeps only the extensions it was asked for', () => {
    const target = join(out, 'hic-only.json')
    const run = make(
      '4dn',
      '--from-json',
      join(FIXTURES, '4dn-search.json'),
      '--out',
      target,
      '--formats',
      'hic',
    )
    expect(run.status).toBe(0)
    const hub = JSON.parse(readFileSync(target, 'utf8')) as RawHub
    // The two `.mcool` rows go, including the Micro-C one — which is the point:
    // the format filter is on the file and the experiment-type filter does not
    // exist, so narrowing the formats is the only way to lose an assay.
    expect(hub.entries).toHaveLength(4)
    expect(JSON.stringify(hub)).not.toContain('.mcool')
  })

  it('reads a directory of pages as one response', () => {
    // A live `limit=all` answer is tens of megabytes; recording one in pieces
    // has to work, and the seam between two pages is where a concatenation
    // that only ever saw one file is wrong.
    const pages = join(out, 'pages')
    mkdirSync(pages, { recursive: true })
    const whole = JSON.parse(readFileSync(join(FIXTURES, '4dn-search.json'), 'utf8')) as {
      '@graph': unknown[]
    }
    writeFileSync(join(pages, 'page-1.json'), JSON.stringify({ '@graph': whole['@graph'].slice(0, 3) }))
    writeFileSync(join(pages, 'page-2.json'), JSON.stringify({ '@graph': whole['@graph'].slice(3) }))

    const target = join(out, 'paged.json')
    expect(make('4dn', '--from-json', pages, '--out', target).status).toBe(0)
    const hub = JSON.parse(readFileSync(target, 'utf8')) as RawHub
    expect(hub.entries).toHaveLength(6)
  })
})

describe.skipIf(!havePython)('--timestamp and --limit', () => {
  it('writes a dated copy beside the hub, and caps the rows when asked', () => {
    const target = join(out, 'dated.json')
    const run = make(
      '4dn',
      '--from-json',
      join(FIXTURES, '4dn-search.json'),
      '--out',
      target,
      '--limit',
      '2',
      '--timestamp',
    )
    expect(run.status).toBe(0)
    const hub = JSON.parse(readFileSync(target, 'utf8')) as RawHub
    expect(hub.entries).toHaveLength(2)
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const dated = join(out, `dated-${stamp}.json`)
    expect(existsSync(dated)).toBe(true)
    expect(readFileSync(dated, 'utf8')).toBe(readFileSync(target, 'utf8'))
  })
})
