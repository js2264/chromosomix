/**
 * Pairs QC and the restriction digest from a shell (§23.1).
 *
 * Both are subcommands because both are descriptors, and the lines here are the
 * ones the console writes for them (`analysis/cliCommand.ts`) — so each is held
 * to what the parser takes and to what the run writes. The composite runs from
 * a shell as it runs in the app: `pairsqc sample.pairs --bin-size … --sequence
 * ref.fa --enzyme DpnII` digests the reference first and reads the library once,
 * and `--sequence` answers Pairs QC's reference as it answers motif's.
 *
 * And the retired half of P(s) still takes its old line: `expected --stranded
 * --pairsUri` draws the four orientations it always drew.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { cliCommandFor } from '@/analysis/cliCommand'
import { taskById } from '@/analysis/registry'
import type { AnalysisFraming, Provenance } from '@/analysis/types'
import { main, parseCommandLine } from '@/cli/main'
import { writeHic, type HicRecord } from '../support/hicWriter'
import { rng } from '../support/pairs'

let directory = ''
let library = ''
let fasta = ''
let matrix = ''
const errors: string[] = []

const LENGTH = 40_000

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chromosomix-pairsqc-'))
  const next = rng(3)
  const letters = 'ACGT'
  let bases = ''
  for (let i = 0; i < LENGTH; i++) bases += letters[Math.floor(next() * 4)]
  fasta = join(directory, 'ref.fa')
  await writeFile(fasta, `>chrI\n${bases.replace(/(.{60})/g, '$1\n')}\n`)

  const strand = (): string => (next() < 0.5 ? '+' : '-')
  const rows: string[] = []
  for (let i = 0; i < 2_000; i++) {
    const separation = Math.floor(Math.exp(next() * Math.log(20_000)))
    const pos1 = 1 + Math.floor(next() * (LENGTH - separation - 1))
    rows.push(`r${i}\tchrI\t${pos1}\tchrI\t${pos1 + separation}\t${strand()}\t${strand()}\t${next() < 0.05 ? 'DD' : 'UU'}`)
  }
  rows.sort((a, b) => Number(a.split('\t')[2]) - Number(b.split('\t')[2]))
  library = join(directory, 'library.pairs')
  await writeFile(
    library,
    [
      '## pairs format v1.0',
      '#sorted: chr1-chr2-pos1-pos2',
      '#shape: upper triangle',
      `#chromsize: chrI ${LENGTH}`,
      '#columns: readID chrom1 pos1 chrom2 pos2 strand1 strand2 pair_type',
      ...rows,
    ].join('\n') + '\n',
  )

  // A matrix of the same sequence, for the map that keeps no records.
  const list: HicRecord[] = []
  for (let x = 0; x < 40; x++) for (let y = x; y < 40; y++) list.push({ x, y, value: Math.max(1, 40 - (y - x)) })
  matrix = join(directory, 'library.hic')
  const fixture = await writeHic({
    version: 9,
    chroms: [{ name: 'chrI', length: LENGTH }],
    resolutions: [1000],
    records: { '1_1': list },
    blockBinCount: 32,
  })
  await writeFile(matrix, fixture.bytes)

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  if (directory !== '') await rm(directory, { recursive: true, force: true })
})

const complained = (): string => errors.join('')
function reset(): void {
  errors.length = 0
}

/** A written table's header row, the first that is not provenance. */
async function headerOf(path: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  return text.split('\n').find((line) => line !== '' && !line.startsWith('#')) ?? ''
}

describe('chromosomix pairsqc', () => {
  it('runs the composite over a .pairs: the digest, then one pass over the records', async () => {
    reset()
    const where = join(directory, 'digested')
    expect(
      await main(['pairsqc', library, '--bin-size', '1000', '--sequence', fasta, '--enzyme', 'DpnII', '--out', where, '--quiet']),
      complained(),
    ).toBe(0)
    expect(complained()).not.toMatch(/failed:/)
    const files = await readdir(where)
    for (const id of [
      'pairsqc-orientation',
      'pairsqc-types',
      'pairsqc-cis',
      'pairsqc-stats',
      'pairsqc-classes',
      'pairsqc-classes-table',
      'pairsqc-distance',
      'pairsqc-fragments',
      'pairsqc-sites',
    ]) {
      expect(files, id).toContain(`library.pairsqc.${id}.tsv`)
    }
    // The required step's own files are not written: the reader asked for Pairs QC.
    expect(files.some((file) => file.includes('.restriction.'))).toBe(false)
    const table = await readFile(join(where, 'library.pairsqc.pairsqc-classes-table.tsv'), 'utf8')
    expect(table).toMatch(/^# param reference: .*ref\.fa$/m)
    expect(table).toMatch(/^# param enzyme: DpnII$/m)
    expect(await headerOf(join(where, 'library.pairsqc.pairsqc-classes-table.tsv'))).toBe(
      'class\tpairs\tshare\t++\t+-\t-+\t--',
    )
    expect(await headerOf(join(where, 'library.pairsqc.pairsqc-sites.tsv'))).toBe(
      'Restriction sites in the bin\tbins\tmean',
    )
    // A number of sites fewer than five bins share keeps its points and has no
    // mean: an empty cell, as the writer spells a value that is not there.
    const sites = (await readFile(join(where, 'library.pairsqc.pairsqc-sites.tsv'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .slice(1)
      .map((line) => line.split('\t'))
    expect(sites.some((row) => row[2] === '')).toBe(true)
    expect(sites.some((row) => row[2] !== '' && Number.isFinite(Number(row[2])))).toBe(true)
    expect(await headerOf(join(where, 'library.pairsqc.pairsqc-stats.tsv'))).toBe('statistic\tvalue')
    expect(complained()).not.toMatch(/no restriction statistics/)
  })

  it('loads the reference its own --reference names, as --tracks loads what it names', async () => {
    reset()
    const where = join(directory, 'named-reference')
    expect(
      await main(['pairsqc', library, '--bin-size', '1000', '--reference', fasta, '--enzyme', 'DpnII', '--out', where, '--quiet']),
      complained(),
    ).toBe(0)
    expect(await readdir(where)).toContain('library.pairsqc.pairsqc-classes.tsv')
  })

  it('runs the pairtools half alone with no enzyme, and reads nothing twice', async () => {
    reset()
    const where = join(directory, 'plain')
    expect(await main(['pairsqc', library, '--bin-size', '1000', '--out', where, '--quiet']), complained()).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('library.pairsqc.pairsqc-stats.tsv')
    expect(files).not.toContain('library.pairsqc.pairsqc-classes.tsv')
  })

  it('reads the .pairs named beside a matrix, which keeps no records of its own', async () => {
    reset()
    const where = join(directory, 'beside')
    expect(
      await main(['pairsqc', matrix, '--pairs', library, '--sequence', fasta, '--enzyme', 'DpnII', '--out', where, '--quiet']),
      complained(),
    ).toBe(0)
    const files = await readdir(where)
    expect(files).toContain('library.pairsqc.pairsqc-classes.tsv')
    expect(files).toContain('library.pairsqc.pairsqc-sites.tsv')
    // Its `--pairs` is the contact list, never a loop table to parse.
    expect(complained()).not.toMatch(/failed:/)
  })

  it('names the file a matrix needs, rather than running on nothing', async () => {
    reset()
    const where = join(directory, 'bare')
    expect(await main(['pairsqc', matrix, '--out', where, '--quiet'])).toBe(0)
    expect(complained()).toMatch(/opened as a matrix, which keeps no records/)
  })

  it('refuses a typed site with no cut in it, by the sentence the form gives', async () => {
    reset()
    expect(
      await main([
        'pairsqc', library, '--bin-size', '1000', '--sequence', fasta, '--enzyme', 'custom', '--sites', 'GATC',
        '--out', join(directory, 'refused'), '--quiet',
      ]),
    ).toBe(1)
    expect(complained()).toMatch(/needs a \^ where the enzyme cuts/)
  })
})

describe('chromosomix restriction', () => {
  it('writes the sites and the density for a map', async () => {
    reset()
    const where = join(directory, 'sites')
    expect(
      await main(['restriction', matrix, '--sequence', fasta, '--enzyme', 'DpnII', '--out', where, '--quiet']),
      complained(),
    ).toBe(0)
    const files = await readdir(where)
    expect(files.some((file) => /^library\.restriction\.restriction-[^.]+\.bed$/.test(file))).toBe(true)
    expect(files.some((file) => /^library\.restriction\.restriction-[^.]+-density\.bedGraph$/.test(file))).toBe(true)
  })
})

describe('P(s)’s retired four orientations, from a shell', () => {
  it('still draws them for a --stranded line, and says where they live now', async () => {
    reset()
    const where = join(directory, 'stranded')
    expect(
      await main(['expected', matrix, '--stranded', '--pairsUri', library, '--out', where, '--quiet']),
      complained(),
    ).toBe(0)
    expect(await readdir(where)).toContain('library.expected.ps-orientation.tsv')
    expect(complained()).toMatch(/have moved to Pairs QC/)
  })

  it('takes them as parameters and lists them nowhere', async () => {
    reset()
    const written: string[] = []
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    expect(await main(['tasks'])).toBe(0)
    const listing = written.join('')
    const ps = listing.slice(listing.indexOf('\nexpected\n'), listing.indexOf('\npairsqc\n'))
    expect(ps).not.toMatch(/--stranded|--pairsUri/)
    expect(listing).toMatch(/^pairsqc$/m)
    expect(listing).toMatch(/^restriction$/m)
    vi.mocked(process.stdout.write).mockImplementation(() => true)
  })
})

describe('the lines the console writes for them', () => {
  const framing = (uri: string): AnalysisFraming => ({
    uri,
    rows: [0, 40],
    cols: [0, 40],
    binsize: 1000,
    binsPerCell: 1,
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
    label: 'whole file',
  })
  const provenance = (task: string, uri: string, params: Provenance['params']): Provenance => ({
    task,
    taskVersion: 1,
    params,
    framing: framing(uri),
    app: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  const entries = [
    {
      id: 'a1',
      kind: 'sequence',
      label: 'ref.fa',
      source: { kind: 'local', name: 'ref.fa' },
    },
  ] as unknown as NonNullable<Parameters<typeof cliCommandFor>[0]['context']>['entries']

  it('writes pairsqc as the contract does: the reference once, under --sequence', () => {
    const task = taskById('pairsqc')!
    const { text } = cliCommandFor({
      task,
      provenance: provenance('pairsqc', 'data/sample.pairs.gz', {
        pairs: '',
        reference: 'a1',
        enzyme: 'DpnII',
        sites: '',
      }),
      context: { entries, contigs: [], nBins: 40, binsize: 1000 } as never,
    })
    expect(text).toBe('chromosomix pairsqc data/sample.pairs.gz --bin-size 1000 --no-balance --sequence ref.fa --enzyme DpnII')
    const parsed = parseCommandLine(text.split(' ').slice(1))
    expect(parsed.command).toBe('pairsqc')
    expect(parsed.flags.get('enzyme')).toEqual(['DpnII'])
  })

  it('writes restriction with a map positional, as motif is written', () => {
    const task = taskById('restriction')!
    const { text } = cliCommandFor({
      task,
      provenance: provenance('restriction', 'data/sample.mcool', {
        sequence: 'a1',
        sequences: null,
        enzyme: 'Arima',
        sites: '',
      }),
      context: { entries, contigs: [], nBins: 40, binsize: 1000 } as never,
    })
    expect(text).toBe('chromosomix restriction data/sample.mcool --no-balance --sequence ref.fa --enzyme Arima')
    expect(parseCommandLine(text.split(' ').slice(1)).command).toBe('restriction')
  })

  it('leaves P(s)’s retired keys off a line at their defaults, and keeps a stored answer', () => {
    const task = taskById('expected')!
    const base = {
      scope: 'contig',
      sequences: null,
      quantity: 'density',
      factor: 1.1,
      minSeparation: 2,
      derivative: true,
      balance: false,
    }
    const quiet = cliCommandFor({
      task,
      provenance: provenance('expected', 'sample.mcool', { ...base, stranded: false, pairsUri: '' }),
      context: null,
    }).text
    expect(quiet).not.toMatch(/stranded|pairsUri/)
    const asked = cliCommandFor({
      task,
      provenance: provenance('expected', 'sample.mcool', { ...base, stranded: true, pairsUri: 'lib.pairs' }),
      context: null,
    }).text
    expect(asked).toContain('--stranded --pairsUri lib.pairs')
  })
})
