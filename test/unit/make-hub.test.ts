/**
 * `scripts/make_hub.py`, run for real, against recorded portal responses.
 *
 * The generator writes the file `src/state/hub.ts` parses, and the two halves
 * are in different languages, in different processes, checked by different
 * suites. Nothing but a test that runs the script and reads its output can
 * catch the failure that matters: a hub that is *valid JSON and wrong* — a
 * column renamed, a size that became a string, a relative name with no base to
 * resolve it against. The viewer's parser is deliberately forgiving (an entry
 * with no label is dropped, an unknown key ignored, SPECS §24.1), which is
 * right for a hub somebody else wrote and is exactly why the generator's own
 * output has to be pinned somewhere. This is that somewhere.
 *
 * ## A spine and an enrichment
 *
 * Both portal front ends now read two sources, and the tests below are shaped
 * by which is which (SPECS §24.3): the **spine** says what files exist — 4DN's
 * bucket listing, ENCODE's file manifest — and the **enrichment** says what
 * each one is of. A row exists because an object exists, so the tests that
 * matter most are the ones where the two disagree: a file the portal does not
 * describe (kept, with empty cells), and a portal record for a file that is not
 * on the bucket (no row at all).
 *
 * ## Where the fixtures come from
 *
 * `test/fixtures-hubs/*` are recorded-*shape* responses, not recordings:
 * neither portal is reachable from a development sandbox or from this suite, so
 * they were built from the portals' own schemas (`file_processed.json` and
 * `types/file.py`'s `open_data_url` and `track_and_facet_info` at 4DN;
 * `schemas/file.json` and the column list of `encode_file_manifest.tsv` at
 * ENCODE) and filled with values lifted from igv-data's generated tables (MIT)
 * and from a real walk of the two public buckets. Every 4DN accession, UUID and
 * byte count here is a real object on `4dn-open-data-public` — including the
 * five keys in `4dn-bucket/`, which were read off a live `ListObjectsV2` — and
 * so are the ENCODE keys under `2020/09/03/`. `igv-genomes.json` is five
 * records copied verbatim out of IGV's own table, plus two written by hand and
 * marked as such. The rest — the ENCODE experiment metadata, the newer ENCODE
 * manifest rows — is plausible rather than measured, because the portal that
 * holds the join was not reachable. That is honest for a fixture whose job is
 * to pin the *shape* of the mapping, and it is the reason the first live run is
 * worth watching.
 *
 * Each fixture carries records that must be skipped entirely, because the
 * skipping is the part with a decision in it:
 *
 * - 4DN's `4DNES4TZF88L` has three processed files and publishes none of them
 *   *as the portal sees it*: one with a `genome_assembly` and **no
 *   `open_data_url`**, one whose `open_data_url` is a `.pairs.gz`, and one with
 *   an `open_data_url` and **no `genome_assembly`**. Under the old
 *   format-filtered, portal-only design all three were dropped. Under this one
 *   the `.pairs.gz` is a row — because it is an object on the bucket and this
 *   viewer opens pairs — and the other two are not, because no object on the
 *   bucket answers to them. That inversion is the change these tests exist to
 *   pin.
 * - 4DN's `4DNFIXZUM5P9.txt.gz` is a real object with no route: skipped by
 *   name, which is the only filter this front end has left.
 * - ENCODE's manifest carries an `archived` BED, a `.tsv`, the bulk
 *   `footprints` dump and a row with no object URL at all. The first three are
 *   each skipped for their own reason and the fourth is the `s3_uri` fallback.
 * - IGV's `hg38` publishes one track and it is a `refgene`, which this viewer
 *   has no reader for: the genome is a row and its session has a sequence and
 *   nothing else, which is the honest answer rather than a track that fails
 *   when it is clicked.
 *
 * The bucket pages are the `ListObjectsV2` XML, in two parts with a
 * continuation token between them, and several of their objects carry the
 * `<ChecksumAlgorithm>`/`<ChecksumType>` pair that sits between `<ETag>` and
 * `<Size>` on anything written recently. A parser that reads the block
 * positionally drops those and says nothing, which is how the first census of
 * the 4DN bucket came out a quarter short (SPECS §24.3).
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

/** A generated session, likewise. */
interface RawSession {
  kind?: unknown
  version?: unknown
  active?: unknown
  producer?: unknown
  tabs?: Array<{
    name?: unknown
    state?: Record<string, unknown>
    tracks?: Array<Record<string, unknown>>
  }>
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

function read(name: string): RawHub {
  return JSON.parse(readFileSync(join(out, name), 'utf8')) as RawHub
}

/**
 * Run one front end into `out/<name>`, and answer with what it wrote there.
 *
 * Every call names its recorded sources, and that is not only for speed: a
 * front end handed no fixture would walk a live bucket, and a suite that
 * reaches the network is a suite that fails on an aeroplane.
 */
function built(front: string, name: string, ...extra: string[]): RawHub {
  const run = make(front, '--out', join(out, name), ...extra)
  expect(run.stderr, run.stderr).not.toMatch(/Traceback/)
  expect(run.status, run.stderr).toBe(0)
  return read(name)
}

/** The 4DN front end's two fixtures, which it always needs both of. */
const FROM_4DN = [
  '--from-json',
  join(FIXTURES, '4dn-search.json'),
  '--from-xml',
  join(FIXTURES, '4dn-bucket'),
]

/** ENCODE's: the manifest is the spine, the search is the enrichment. */
const FROM_ENCODE = [
  '--from-json',
  join(FIXTURES, 'encode-search.json'),
  '--from-tsv',
  join(FIXTURES, 'encode-manifest.tsv'),
]

/** IGV's, with the probe switched off: a request per row is a network call. */
const FROM_IGV = ['--from-json', join(FIXTURES, 'igv-genomes.json'), '--probe', 'off']

/** Every entry's absolute URL, resolved the way `resolveHub` will resolve it. */
function absolute(hub: RawHub): string[] {
  const base = typeof hub.base === 'string' ? hub.base : undefined
  return (hub.entries ?? []).map((entry) => {
    const uri = String(entry.uri)
    return base === undefined ? uri : new URL(uri, base).href
  })
}

/** One entry by the accession in its label, for a test that should not count rows. */
function row(hub: RawHub, accession: string): Record<string, unknown> | undefined {
  return (hub.entries ?? []).find((entry) => String(entry.label).includes(accession))
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
    hub = built('4dn', '4dn.json', ...FROM_4DN, '--check')
  })

  it('writes the Contract-1 envelope, with both sources in its provenance', () => {
    expect(hub.kind).toBe('metacooler.hub')
    expect(hub.version).toBe(1)
    expect(hub.name).toBe('4DN open data')
    expect(typeof hub.description).toBe('string')
    // A shelf with no provenance is a screenshot (SPECS §24.3): the instant it
    // was written is in the file, and so is *each* of the two places it came
    // from — the bucket that decided which rows exist and the query that
    // decided what is in their cells.
    expect(hub.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(String(hub.source)).toContain('4dn-open-data-public')
    expect(String(hub.source)).toContain('data.4dnucleome.org/search/')
    expect(String(hub.source)).toContain('type=ExperimentSetReplicate')
    // No experiment-type filter, which is the whole difference from igv-data's
    // query and the reason the Micro-C row below survives.
    expect(String(hub.source)).not.toContain('experiment_type.display_title=')
  })

  it('declares its columns in the fixed order, assembly first and format fourth', () => {
    expect(hub.columns?.map((column) => column.key)).toEqual([
      'assembly',
      'biosource',
      'assay',
      'format',
      'dataset',
      'lab',
      'project',
    ])
    expect(hub.columns?.map((column) => column.label)).toEqual([
      'Assembly',
      'Biosource',
      'Assay',
      'Format',
      'Dataset',
      'Lab',
      'Project',
    ])
  })

  it('keeps every object the viewer has a route for, whatever the format', () => {
    // Ten objects in the two listing pages; nine rows. The one that goes is the
    // `.txt.gz`, and the filter that dropped it is `route_of` and nothing else.
    expect(hub.entries).toHaveLength(9)
    const text = JSON.stringify(hub)
    expect(text, '4DNFIXZUM5P9.txt.gz has no route').not.toContain('4DNFIXZUM5P9')
    // The four that the Hi-C-only version of this front end dropped, and the
    // reason this change exists: a reader who asked for "any and all the data"
    // gets the tracks, the peaks, the reads and the pairs too.
    for (const kept of [
      '4DNFIK9NBYGJ', // .bw
      '4DNFI24F7GRY', // .bam
      '4DNFIYZL5V6A', // .bed.gz
      '4DNFIRZ9WSAO', // .pairs.gz
    ]) {
      expect(text, `${kept} must now be a row`).toContain(kept)
    }
  })

  it('has no row for a file the portal named and the bucket does not hold', () => {
    // `4DNFI111EI3K` is released to project — no `open_data_url` — and
    // `4DNFIH8XQ2KM` has one and no assembly. Neither is an object in the
    // listing, and the spine is what decides: a portal record with nothing
    // behind it is not a row.
    const text = JSON.stringify(hub)
    expect(text).not.toContain('4DNFI111EI3K')
    expect(text).not.toContain('4DNFIH8XQ2KM')
  })

  it('joins the three file arrays the set-level query used to leave out', () => {
    // A per-experiment processed file. Nine of 4DN's openable files in ten live
    // here rather than in the set's own `processed_files`, and the version of
    // this generator that read only the set array published a catalogue missing
    // them — silently, which is the failure worth a test.
    expect(row(hub, '4DNFI24F7GRY')?.fields).toEqual({
      assembly: 'GRCh38',
      biosource: 'HFFc6',
      assay: 'in situ Hi-C (DpnII)',
      format: 'bam',
      dataset: 'Hi-C on HFF cells - protocol variations',
      lab: 'Job Dekker, UMMS',
      project: '4DN',
    })
    // And a supplementary group, which is the *other* shape: a list of groups,
    // each with its own `files` array.
    expect(row(hub, '4DNFIYZL5V6A')?.fields).toMatchObject({
      assembly: 'GRCh38',
      format: 'bed.gz',
      dataset: 'Hi-C on RAD21-AID tagged HCT-116',
    })
  })

  it('keeps a row the portal says nothing about, with its cells empty', () => {
    // A real object on the bucket that no `@graph` record names. The
    // alternative is a catalogue that quietly omits whatever a search API's
    // facets happened to miss, which is the bug the spine exists to prevent.
    const reference = row(hub, '4DNFIMOUSEREF')
    expect(reference?.kind).toBe('genome')
    expect(reference?.size).toBe(2731234567)
    // Only the one cell the file name itself answers.
    expect(reference?.fields).toEqual({ format: 'fasta' })
  })

  it('takes every size from the bucket, not from the portal', () => {
    // The portal gives no `file_size` for the Micro-C map and the listing gives
    // 412876800. The object is what is about to be fetched, and the two
    // genuinely disagree after a re-upload.
    expect(row(hub, '4DNFIO2TD17P')?.size).toBe(412876800)
    expect(row(hub, '4DNFIM7ZVQOQ')?.size).toBe(839405381)
  })

  it('names every entry relative to one base, which rejoins to the object', () => {
    // The base is the *common* prefix of both walked prefixes, so a row under
    // `files/` and a row under `wfoutput/` share it.
    expect(hub.base).toBe('https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/')
    for (const entry of hub.entries ?? []) {
      expect(String(entry.uri)).not.toMatch(/^https?:/)
    }
    expect(absolute(hub)).toContain(
      'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/' +
        '000789fe-9a22-4280-a71c-7ad228fd4cac/4DNFIM7ZVQOQ.hic',
    )
  })

  it('sorts by assembly and then label', () => {
    // Which is the order the table opens in and therefore the order a diff
    // between two weeks is readable in: a hub sorted by whatever the bucket
    // answered would show four hundred moved rows the week S3 changed its
    // listing order.
    const keys = (hub.entries ?? []).map((entry): [string, string] => [
      (entry.fields as Record<string, string>).assembly ?? '',
      String(entry.label),
    ])
    expect(keys).toEqual([...keys].sort())
    // The undescribed FASTA has no assembly at all, and sorts first rather
    // than being dropped for want of one.
    expect(keys[0][0]).toBe('')
    expect(keys[0][1]).toContain('4DNFIMOUSEREF')
  })

  it('carries the kind, the size and the facets of one row in full', () => {
    expect(row(hub, '4DNFIM7ZVQOQ')).toEqual({
      label: 'Hi-C on RAD21-AID tagged HCT-116 — 4DNFIM7ZVQOQ (hic)',
      uri: 'wfoutput/000789fe-9a22-4280-a71c-7ad228fd4cac/4DNFIM7ZVQOQ.hic',
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
        format: 'hic',
        dataset: 'Hi-C on RAD21-AID tagged HCT-116',
        lab: 'Erez Lieberman Aiden, BCM',
        project: 'External',
      },
    })
  })

  it('reads the set accession off @id when the field list did not ask for one', () => {
    // `field=` returns only what it names, and the contract fixes that list; a
    // set that carries no `accession` of its own still has to be named.
    expect(String(row(hub, '4DNFIM7ZVQOQ')?.note)).toContain('4DNESD117NVX')
  })

  it('falls back to the set when a file has no track_and_facet_info', () => {
    expect(row(hub, '4DNFIO2TD17P')?.fields).toEqual({
      assembly: 'GRCh38',
      // No `biosource_name` anywhere on this file: the organism the set names
      // is a worse answer than a cell line and a much better one than blank.
      biosource: 'human',
      // From `experiments_in_set[].experiment_type.display_title`, with no
      // enzyme to put in brackets.
      assay: 'Micro-C',
      format: 'mcool',
      dataset: 'Micro-C on HFF cells',
      lab: 'Job Dekker, UMMS',
      project: '4DN',
    })
  })

  it('accepts its own output', () => {
    expect(make('check', join(out, '4dn.json')).status).toBe(0)
  })
})

describe.skipIf(!havePython)('the 4DN front end, narrowed and unenriched', () => {
  it('keeps only the formats --formats named', () => {
    const hub = built('4dn', 'hic-only.json', ...FROM_4DN, '--formats', 'hic,mcool')
    // In assembly-then-label order, which is why the two `.mcool` rows are not
    // adjacent: the format is a cell, not the sort key.
    expect((hub.entries ?? []).map((entry) => (entry.fields as Record<string, string>).format))
      .toEqual(['mcool', 'hic', 'mcool', 'hic'])
  })

  it('--portal skip publishes the spine with its metadata columns empty', () => {
    // The week a portal is unreachable, and every day on a development machine
    // that can reach an object store and not a search API. Every row is still
    // there; what is missing is what only the portal knows.
    const hub = built('4dn', 'spine.json', '--from-xml', join(FIXTURES, '4dn-bucket'), '--portal', 'skip')
    expect(hub.entries).toHaveLength(9)
    expect(String(hub.source)).toContain('--portal skip')
    for (const entry of hub.entries ?? []) {
      // The one cell a file name answers by itself, and nothing else.
      expect(Object.keys(entry.fields as Record<string, string>)).toEqual(['format'])
    }
  })

  it('--portal optional keeps the rows when the query itself fails', () => {
    const run = make(
      '4dn',
      '--out',
      join(out, 'optional.json'),
      '--from-xml',
      join(FIXTURES, '4dn-bucket'),
      '--from-json',
      join(FIXTURES, 'does-not-exist.json'),
      '--portal',
      'optional',
    )
    expect(run.status).toBe(0)
    expect(run.stderr).toMatch(/--portal optional/)
    expect(read('optional.json').entries).toHaveLength(9)
  })

  it('--portal require fails the run instead, and writes nothing', () => {
    const target = join(out, 'required.json')
    const run = make(
      '4dn',
      '--out',
      target,
      '--from-xml',
      join(FIXTURES, '4dn-bucket'),
      '--from-json',
      join(FIXTURES, 'does-not-exist.json'),
    )
    expect(run.status).toBe(1)
    expect(existsSync(target)).toBe(false)
  })
})

describe.skipIf(!havePython)('the ENCODE front end', () => {
  let shards: string[]

  beforeAll(() => {
    const run = make('encode', '--out', join(out, 'encode.json'), ...FROM_ENCODE, '--check')
    expect(run.stderr, run.stderr).not.toMatch(/Traceback/)
    expect(run.status, run.stderr).toBe(0)
    shards = readdirSync(out).filter((name) => name.startsWith('encode-')).sort()
  })

  it('writes one hub per assembly and output category, and no combined file', () => {
    // SPECS §24.3: 1.2 million openable files is a quarter of a gigabyte of
    // JSON and a table nothing can draw, so the shelf is split on the two
    // things a reader arrives already knowing — which genome, and whether they
    // want signal, peaks or reads.
    expect(existsSync(join(out, 'encode.json'))).toBe(false)
    expect(shards).toEqual([
      'encode-GRCh38-alignment.json',
      'encode-GRCh38-annotation.json',
      'encode-GRCh38-signal.json',
      'encode-hg19-annotation.json',
      'encode-mm10-annotation.json',
      'encode-other-signal.json',
    ])
  })

  it('names each shard after what is in it, and carries the same columns throughout', () => {
    const signal = read('encode-GRCh38-signal.json')
    expect(signal.name).toBe('ENCODE — GRCh38 signal')
    expect(read('encode-mm10-annotation.json').name).toBe('ENCODE — mouse peaks and annotations')
    expect(read('encode-other-signal.json').name).toBe('ENCODE — other assemblies signal')
    // One column list across twelve shelves, because they are twelve views of
    // one catalogue and a reader who learns the table once has learnt it.
    for (const name of shards) {
      expect(read(name).columns?.map((column) => column.key)).toEqual([
        'assembly',
        'biosample',
        'assay',
        'format',
        'target',
        'output',
        'lab',
      ])
    }
  })

  it('records both of its sources and the breadth it was run at', () => {
    const source = String(read('encode-GRCh38-signal.json').source)
    expect(source).toContain('encode_file_manifest.tsv')
    expect(source).toContain('www.encodeproject.org/search/')
    expect(source).toContain('type=Experiment')
    expect(source).toContain('--breadth representative')
  })

  it('files a mouse assembly the shard list folds in under the mouse shelf', () => {
    // `mm9` has no shelf of its own — two thousand files would be a menu entry
    // that reads as noise — and must not vanish for want of one.
    const mouse = read('encode-mm10-annotation.json')
    expect((mouse.entries ?? []).map((entry) => (entry.fields as Record<string, string>).assembly))
      .toEqual(['mm9'])
  })

  it('collapses a dataset to one file per assembly and format, and says what it collapsed', () => {
    const signal = read('encode-GRCh38-signal.json')
    // Three bigWigs of ENCSR683EDC on GRCh38 in the manifest; one row. The one
    // kept is the file made from the most libraries, then the newest — so the
    // single-library 2019 file and the older of the two pooled ones both go.
    expect(signal.entries).toHaveLength(1)
    expect(String(signal.entries?.[0].label)).toContain('ENCFF640PLW')
    // And the row says so where the reader is choosing, rather than in a
    // docstring: a row standing for three files is not the same claim as a row.
    expect(String(signal.entries?.[0].note)).toContain('1 of 3 bigwig files here')
  })

  it('keeps one row per format of the same dataset, and one per assembly', () => {
    // The peaks of ENCSR683EDC are a different format and keep their own row;
    // its hg19 map is a different assembly and keeps its own shard.
    expect(String(read('encode-GRCh38-annotation.json').entries?.[1].label)).toContain('ENCFF412PKS')
    expect(String(read('encode-hg19-annotation.json').entries?.[0].label)).toContain('ENCFF177TYX')
  })

  it('prefers the unsigned bucket object, and builds one from the s3 URI when there is none', () => {
    // SPECS §24.3: `@@download` answers 307 to a URL presigned for GET alone,
    // which this viewer opens but a year-old catalogue should not depend on. A
    // handful of manifest rows carry only the `s3://` name, and the https form
    // of the same object is what the row must carry.
    const hg19 = read('encode-hg19-annotation.json')
    expect(absolute(hg19)).toContain(
      'https://encode-public.s3.amazonaws.com/2018/07/21/' +
        '112233ab-cdef-4012-8345-6789abcdef01/ENCFF706SFK.hic',
    )
    expect(JSON.stringify(hg19)).not.toContain('@@download')
  })

  it('skips what must never be a row, each for its own reason', () => {
    const text = shards.map((name) => JSON.stringify(read(name))).join('')
    for (const [skipped, why] of [
      ['ENCFF444TKN', 'archived'],
      ['ENCFF156BIL', 'a .tsv, which has no route'],
      ['ENCFF798HAP', 'the bulk footprints dump'],
      ['ENCFF802KNB', 'released, and no object URL at all'],
    ]) {
      expect(text, `${skipped} should have been skipped: ${why}`).not.toContain(skipped)
    }
  })

  it('fills one row completely from the two sources at once', () => {
    expect(read('encode-GRCh38-alignment.json').entries?.[0]).toEqual({
      label: 'Homo sapiens GM12878 — ENCFF317BAM (bam)',
      uri: 'ENCFF317BAM.bam',
      kind: 'genome',
      size: 5368709120,
      note: 'ENCFF317BAM · ENCSR000CAC · ChIA-PET against CTCF on GM12878',
      fields: {
        assembly: 'GRCh38',
        biosample: 'Homo sapiens GM12878',
        assay: 'in situ ChIA-PET',
        format: 'bam',
        // "CTCF (Homo sapiens)" on the portal: the species is the assembly's
        // business, and a Target column of binomials filters on nothing.
        target: 'CTCF',
        output: 'alignments',
        lab: 'Michael Snyder, Stanford',
      },
    })
  })

  it('falls back to the lab slug the manifest carries for a dataset the portal missed', () => {
    // Half of ENCODE's openable files belong to annotations, which the
    // enrichment query deliberately does not ask for (500,000 datasets). Those
    // rows keep everything the manifest knows — and a slug is a poor Lab cell
    // and a much better one than blank.
    const other = read('encode-other-signal.json')
    expect(other.entries?.[0].fields).toEqual({
      assembly: 'dm6',
      format: 'bigwig',
      output: 'fold change over control',
      lab: 'kevin-white',
    })
    // Contract 1 renders a missing key as empty anyway, so an empty cell is
    // left out rather than written as `""`.
    expect(other.entries?.[0].fields).not.toHaveProperty('biosample')
  })

  it('--breadth full lists every file but the bulk dump', () => {
    const run = make(
      'encode',
      '--out',
      join(out, 'full', 'encode.json'),
      ...FROM_ENCODE,
      '--breadth',
      'full',
      '--shards',
      'off',
    )
    expect(run.status, run.stderr).toBe(0)
    const hub = read(join('full', 'encode.json'))
    // All three bigWigs now, and still no footprints, no .tsv, no archived row.
    expect(JSON.stringify(hub)).toContain('ENCFF999ZZZ')
    expect(JSON.stringify(hub)).not.toContain('ENCFF798HAP')
    // And nothing says "1 of 3": a row now stands for itself.
    expect(JSON.stringify(hub)).not.toContain('1 of 3')
  })

  it('--breadth all lists the bulk dump too', () => {
    const run = make(
      'encode',
      '--out',
      join(out, 'all', 'encode.json'),
      ...FROM_ENCODE,
      '--breadth',
      'all',
      '--shards',
      'off',
    )
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.stringify(read(join('all', 'encode.json')))).toContain('ENCFF798HAP')
  })

  it('refuses a manifest whose columns it reads by name have been renamed', () => {
    // ENCODE has added columns to this file before, so it is read by name — and
    // a *missing* name has to fail the run rather than fill every cell with the
    // wrong column's value.
    const path = join(out, 'renamed.tsv')
    const manifest = readFileSync(join(FIXTURES, 'encode-manifest.tsv'), 'utf8').split('\n')
    manifest[0] = manifest[0].replace('output_type', 'outputType')
    writeFileSync(path, manifest.join('\n'), 'utf8')
    const run = make('encode', '--out', join(out, 'never.json'), '--from-tsv', path, '--portal', 'skip')
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/missing columns this reads by name: output_type/)
  })
})

describe.skipIf(!havePython)('the IGV front end', () => {
  let hub: RawHub

  beforeAll(() => {
    hub = built('igv', 'igv.json', ...FROM_IGV, '--check')
  })

  it('writes the Contract-1 envelope and its own columns', () => {
    expect(hub.kind).toBe('metacooler.hub')
    expect(hub.name).toBe('IGV genomes')
    expect(String(hub.source)).toContain('igv.org.genomes/genomes.json')
    expect(hub.columns?.map((column) => column.key)).toEqual([
      'assembly',
      'genome',
      'role',
      'format',
      'host',
    ])
  })

  it('lists the sequence and every track the viewer can draw, as separate rows', () => {
    // Both, rather than only the genome: a reader who wants hg38's genes over
    // their own map wants the track on its own, and a reader who wants hg38
    // wants the FASTA. The session below is the third answer.
    const roles = (hub.entries ?? []).map((entry) => (entry.fields as Record<string, string>).role)
    expect(roles.filter((role) => role === 'sequence')).toHaveLength(6)
    expect(roles.filter((role) => role === 'annotation')).toHaveLength(9)
  })

  it('skips a refgene track rather than writing a row that cannot open', () => {
    // 29 of IGV's 63 tracks are UCSC genePred tables in a `.txt.gz`, which this
    // viewer has no parser for. A row for one would fail when it was clicked,
    // and the count is logged so the gap is known rather than discovered.
    const text = JSON.stringify(hub)
    expect(text).not.toContain('ncbiRefSeq.txt.gz')
    expect(text).not.toContain('refGene.sorted.txt.gz')
    // hg38 publishes exactly one track and it is a refgene, so the genome is a
    // row with no tracks at all — which is the honest answer.
    const hg38 = (hub.entries ?? []).find(
      (entry) => (entry.fields as Record<string, string>).assembly === 'hg38',
    )
    expect(hg38?.tracks).toBeUndefined()
    expect(String(hg38?.note)).toContain('no tracks this viewer can draw')
  })

  it('hangs the genome row’s companions off it, as the demos hang theirs', () => {
    const hs1 = (hub.entries ?? []).find(
      (entry) =>
        (entry.fields as Record<string, string>).assembly === 'hs1' &&
        (entry.fields as Record<string, string>).role === 'sequence',
    )
    // Offered from the Tracks card once the genome is open, which is the same
    // offer the demo annotations are (§24.1).
    expect((hs1?.tracks as Array<{ label: string }>).map((track) => track.label)).toEqual([
      'CAT/Liftoff Genes',
      'Augustus',
      'Genes',
    ])
  })

  it('names a sidecar only where the viewer would not have guessed it', () => {
    const text = JSON.stringify(hub)
    // IGV names `<url>.tbi` for almost every gzipped track, which is exactly
    // what `annotations/loader.ts` guesses — so writing the fragment would be
    // noise on forty rows.
    expect(text).not.toContain('.gff3.gz%23index=')
    expect(text).not.toContain('.gff3.gz#index=https://s3.amazonaws.com/igv.org.genomes/GCA_011100615.1/Macaca_fascicularis.Macaca_fascicularis_6.0.108.sorted.gff3.gz.tbi')
    // And names it where the index is somewhere else entirely, which is what
    // `#index=` is for (§8.13).
    expect(text).toContain('genes.bed.gz#index=https://s3.amazonaws.com/igv.org.genomes/sacCer3/index/genes.tbi')
  })

  it('names no index for a FASTA, which this viewer reads without one', () => {
    for (const entry of hub.entries ?? []) {
      if ((entry.fields as Record<string, string>).role !== 'sequence') continue
      expect(String(entry.uri)).not.toContain('#index=')
    }
  })

  it('drops a genome with no sequence and keeps its neighbours', () => {
    expect(JSON.stringify(hub)).not.toContain('No sequence at all')
    expect((hub.entries ?? []).length).toBeGreaterThan(10)
  })

  it('declares no base, because IGV’s rows are on four different hosts', () => {
    expect(hub.base).toBeUndefined()
    for (const entry of hub.entries ?? []) expect(String(entry.uri)).toMatch(/^https:\/\//)
    const hosts = new Set(
      (hub.entries ?? []).map((entry) => (entry.fields as Record<string, string>).host),
    )
    expect(hosts.size).toBeGreaterThan(1)
  })

  it('accepts its own output', () => {
    expect(make('check', join(out, 'igv.json')).status).toBe(0)
  })
})

describe.skipIf(!havePython)('pre-configured sessions', () => {
  let hub: RawHub

  function session(name: string): RawSession {
    return JSON.parse(readFileSync(join(out, 'sessions', name), 'utf8')) as RawSession
  }

  beforeAll(() => {
    const run = make(
      'igv',
      '--out',
      join(out, 'igv-with-sessions.json'),
      ...FROM_IGV,
      '--sessions-dir',
      join(out, 'sessions'),
      '--sessions-out',
      join(out, 'igv-sessions.json'),
      '--check',
    )
    expect(run.stderr, run.stderr).not.toMatch(/Traceback/)
    expect(run.status, run.stderr).toBe(0)
    hub = read('igv-sessions.json')
  })

  it('writes one session per genome, and a hub of its own listing them', () => {
    expect(hub.name).toBe('IGV genome sessions')
    expect(hub.entries).toHaveLength(6)
    expect(hub.columns?.map((column) => column.key)).toEqual([
      'assembly',
      'subject',
      'tracks',
      'source',
    ])
    for (const entry of hub.entries ?? []) {
      // A workspace row is a pre-configured session, opened through the same
      // road as `?config=` (§24.1) — which is why this needs no viewer change.
      expect(entry.kind).toBe('workspace')
      expect(existsSync(join(out, String(entry.uri)))).toBe(true)
    }
  })

  it('names them relative to the hub, with no base, so the pair travels together', () => {
    // `resolveHub`'s self-contained folder: the hub is published beside the
    // directory it names, so a preview build serving both from one place
    // resolves them against each other rather than against the deployed site.
    expect(hub.base).toBeUndefined()
    for (const entry of hub.entries ?? []) {
      expect(String(entry.uri)).toMatch(/^sessions\/[a-z0-9._-]+\.metacooler\.json$/)
    }
  })

  it('places the sequence and every track of the genome, in IGV’s order', () => {
    const pombe = session('igv-asm294v2.metacooler.json')
    expect(pombe.kind).toBe('metacooler.workspace')
    expect(pombe.version).toBe(1)
    expect(pombe.active).toBe(0)
    expect(pombe.tabs).toHaveLength(1)
    const tab = pombe.tabs?.[0]
    expect(tab?.name).toBe('IGV ASM294v2')
    // A genome opens in the 1D browser: there is no matrix for it to be a view
    // of (`state/ViewState.ts`'s `landingState`).
    expect(tab?.state?.view).toBe('browser')
    expect(String(tab?.state?.uri)).toContain('Schizosaccharomyces_pombe_all_chromosomes.fa')
    expect((tab?.tracks ?? []).map((track) => track.kind)).toEqual(['sequence', 'gtf', 'gtf'])
    expect((tab?.tracks ?? []).map((track) => track.label)).toEqual([
      'sequence',
      'Pombase forward strand',
      'Pombase reverse strand',
    ])
  })

  it('writes each lane in full, because the reader fills nothing in', () => {
    // `readTab` hands `tracks` through as `StoredEntry[]` without defaulting
    // anything, so a field left out here is a field the lane draws without.
    const track = session('igv-hs1.metacooler.json').tabs?.[0]?.tracks?.[1]
    expect(track).toMatchObject({
      card: 'linear',
      kind: 'segments',
      visible: true,
      placement: { bottom: true, right: false },
    })
    expect(Object.keys(track?.style as Record<string, unknown>).sort()).toEqual([
      'colour',
      'flip',
      'group',
      'limits',
      'mode',
      'opacity',
      'radius',
      'shape',
      'size',
    ])
    expect((track?.source as Record<string, unknown>).kind).toBe('remote')
    expect(String((track?.source as Record<string, unknown>).url)).toMatch(/^https:\/\//)
  })

  it('carries a named sidecar as source.index rather than in the URL', () => {
    // `#index=` is the URL box's spelling and `source.index` is the session's
    // (`annotations/types.ts`): a session names its sidecar in the field the
    // loader reads, so the pair survives a resolution change.
    const track = session('igv-saccer3_fixture.metacooler.json').tabs?.[0]?.tracks?.[1]
    expect((track?.source as Record<string, unknown>).index).toBe(
      'https://s3.amazonaws.com/igv.org.genomes/sacCer3/index/genes.tbi',
    )
    expect(String((track?.source as Record<string, unknown>).url)).not.toContain('#')
  })

  it('writes a session for a genome with no drawable track, holding just its sequence', () => {
    const hg38 = session('igv-hg38.metacooler.json')
    expect((hg38.tabs?.[0]?.tracks ?? []).map((track) => track.kind)).toEqual(['sequence'])
  })

  it('opens a 4DN session on its map, and never mixes two assemblies into one', () => {
    const run = make(
      '4dn',
      '--out',
      join(out, '4dn-sessions-run.json'),
      ...FROM_4DN,
      '--sessions-dir',
      join(out, 'sessions-4dn'),
      '--sessions-out',
      join(out, '4dn-sessions.json'),
      '--check',
    )
    expect(run.status, run.stderr).toBe(0)
    const sessions = read('4dn-sessions.json')
    // Two of the fixture's six sets have both a map and something to draw on
    // it; the rest are skipped rather than opened on a track, because a session
    // whose lead is a bigWig is not what picking an experiment set means.
    expect(sessions.entries).toHaveLength(2)
    const held = JSON.parse(
      readFileSync(join(out, 'sessions-4dn', '4dn-4dnesnmaan97-grch38.metacooler.json'), 'utf8'),
    ) as RawSession
    const tab = held.tabs?.[0]
    // A contact map opens on its genome list, which is the one view of a map
    // that needs no region to have been chosen.
    expect(tab?.state?.view).toBe('genomes')
    // And the richest map of the set leads it: a multi-resolution cooler beats
    // a single-resolution one, because the session opens at whatever zoom the
    // reader lands on.
    expect(String(tab?.state?.uri)).toContain('4DNFIQ9FG7RR.mcool')
    // In the catalogue's own order, which is by label: the `.bam` of this set
    // comes before its `.bw`.
    expect((tab?.tracks ?? []).map((track) => track.kind)).toEqual(['alignments', 'track'])
    // The assembly is in the id because it is in the key: ENCODE publishes one
    // experiment against GRCh38 and hg19 both, and a session that grouped on
    // the dataset alone drew hg19 tracks over a GRCh38 map with nothing on
    // screen saying so.
    expect((sessions.entries ?? []).every((entry) => String(entry.uri).includes('grch38'))).toBe(
      true,
    )
  })
})

describe.skipIf(!havePython)('the bucket front end', () => {
  let hub: RawHub

  beforeAll(() => {
    hub = built(
      'bucket',
      'bucket.json',
      'https://lab-hic-public.s3.amazonaws.com/maps/',
      '--from-xml',
      join(FIXTURES, 'bucket-listing'),
      '--name',
      'Lab Hi-C',
      '--check',
    )
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
    const target = join(out, 'never-written.json')
    const run = make(
      '4dn',
      '--from-json',
      join(FIXTURES, '4dn-search.json'),
      '--from-xml',
      join(FIXTURES, '4dn-bucket-empty'),
      '--out',
      target,
    )
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/No entries/)
    expect(existsSync(target)).toBe(false)
  })

  it('reads a JSON-bodied 404 from a portal as zero results, not as a failure', () => {
    // 4DN answers a search matching nothing with HTTP 404 and an
    // `HTTPNotFound` body (SPECS §24.3). `4dn-empty.json` is that body: the
    // enrichment finds nothing and every row the bucket holds is still written.
    const hub = built(
      '4dn',
      'unenriched.json',
      '--from-json',
      join(FIXTURES, '4dn-empty.json'),
      '--from-xml',
      join(FIXTURES, '4dn-bucket'),
    )
    expect(hub.entries).toHaveLength(9)
  })
})

describe.skipIf(!havePython)('--check', () => {
  it('refuses a hub whose entries lost what the table draws them from', () => {
    const good = read('4dn.json')
    const broken = {
      ...good,
      base: undefined,
      entries: [
        { ...(good.entries ?? [])[0], label: '', uri: 'x/y.hic' },
        { label: 'later', uri: 'https://host/z.hic', kind: 'contact map', size: '2 GB' },
      ],
    }
    const target = join(out, 'broken.json')
    writeFileSync(target, JSON.stringify(broken), 'utf8')

    const run = make('check', target)
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/has no label/)
    expect(run.stderr).toMatch(/kind 'contact map'/)
    expect(run.stderr).toMatch(/not a byte count/)
    // The one that would publish silently and resolve against whatever host is
    // serving the page: relative names *mixed with* absolute ones and no base
    // to join either to. All-relative with no base is the self-contained folder
    // the session hubs use and is not a fault.
    expect(run.stderr).toMatch(/declares no base/)
  })

  it('accepts an all-relative hub with no base, which is the self-contained folder', () => {
    expect(make('check', join(out, 'igv-sessions.json')).status).toBe(0)
  })

  it('refuses a session the viewer would open with no lanes, or refuse outright', () => {
    const path = join(out, 'broken.metacooler.json')
    writeFileSync(
      path,
      JSON.stringify({
        kind: 'metacooler.workspace',
        version: 1,
        active: 4,
        tabs: [
          { state: { uri: 'relative.fa', view: 'browser' }, tracks: [{ kind: 'nonsense' }] },
          { tracks: [] },
        ],
      }),
      'utf8',
    )
    const run = make('check', path)
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/active is 4/)
    expect(run.stderr).toMatch(/which is not absolute/)
    expect(run.stderr).toMatch(/kind 'nonsense', which draws nothing/)
    expect(run.stderr).toMatch(/no state\.uri/)
  })
})

describe.skipIf(!havePython)('a recorded response in pieces', () => {
  it('reads a directory of pages as one response', () => {
    // A live `limit=all` answer is tens of megabytes; recording one in pieces
    // has to work, and the seam between two pages is where a concatenation
    // that only ever saw one file is wrong.
    const pages = join(out, 'pages')
    mkdirSync(pages, { recursive: true })
    const whole = JSON.parse(readFileSync(join(FIXTURES, '4dn-search.json'), 'utf8')) as {
      '@graph': unknown[]
    }
    writeFileSync(
      join(pages, 'page-1.json'),
      JSON.stringify({ '@graph': whole['@graph'].slice(0, 3) }),
    )
    writeFileSync(join(pages, 'page-2.json'), JSON.stringify({ '@graph': whole['@graph'].slice(3) }))

    const hub = built(
      '4dn',
      'paged.json',
      '--from-json',
      pages,
      '--from-xml',
      join(FIXTURES, '4dn-bucket'),
    )
    expect(hub.entries).toHaveLength(9)
    // And the join still happened across the seam: the row described by the
    // record on page 2 has its cells.
    expect(row(hub, '4DNFIOTPSS3L')?.fields).toMatchObject({ assembly: 'dm6' })
  })
})

describe.skipIf(!havePython)('--timestamp and --limit', () => {
  it('writes a dated copy beside the hub, and caps the rows when asked', () => {
    const target = join(out, 'dated.json')
    const run = make(
      '4dn',
      ...FROM_4DN,
      '--out',
      target,
      '--limit',
      '2',
      '--timestamp',
    )
    expect(run.status).toBe(0)
    const hub = read('dated.json')
    expect(hub.entries).toHaveLength(2)
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const dated = join(out, `dated-${stamp}.json`)
    expect(existsSync(dated)).toBe(true)
    expect(readFileSync(dated, 'utf8')).toBe(readFileSync(target, 'utf8'))
  })
})
