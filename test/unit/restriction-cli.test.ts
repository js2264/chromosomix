/**
 * `chromosomix restriction` over the yeast demo: the files a shell writes, as
 * the validation notebook reads them (`notebooks/validation.qmd`).
 *
 * The notebook digests the reference with bioframe and compares the app's cut
 * sites file and its density with it, so the names of those files and the
 * meaning of their columns are a contract with it rather than a detail: each
 * cut is one line of a BED, `start` the top-strand cut and `end` one base
 * after, and the density is the cuts per bin of the map, summing to the cuts.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { main } from '@/cli/main'

const ROOT = resolve(__dirname, '../..')
const MAP = resolve(ROOT, 'demo/yeast/Yeast_microC_G2M_1kb.cool')
const FASTA = resolve(ROOT, 'demo/yeast/S288c_syn40-XIII.fa')

let directory = ''
const errors: string[] = []

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chromosomix-restriction-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk))
    return true
  })
})

afterAll(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

/** The lines of a file that are not its header. */
async function rows(path: string): Promise<string[][]> {
  const text = await readFile(path, 'utf8')
  return text
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('track'))
    .map((line) => line.split('\t'))
}

describe('chromosomix restriction on the yeast demo', () => {
  it('writes one BED line per DpnII cut, start at the cut, and the cuts per bin', async () => {
    const where = join(directory, 'dpnii')
    const code = await main(['restriction', MAP, '--sequence', FASTA, '--enzyme', 'DpnII', '--out', where, '--quiet'])
    expect(code, errors.join('')).toBe(0)
    const files = (await readdir(where)).sort()
    const stem = 'Yeast_microC_G2M_1kb.restriction.restriction-DpnII'
    expect(files).toEqual(
      expect.arrayContaining([`${stem}.bed`, `${stem}.tsv`, `${stem}-density.bedGraph`, `${stem}-density.tsv`]),
    )

    const bed = await rows(join(where, `${stem}.bed`))
    // 36,062 cuts on the sixteen chromosomes (`test/golden/restriction/`).
    expect(bed.length).toBe(36_062)
    // The first GATC of chromosome I has its G at 0-based 336.
    expect(bed[0].slice(0, 4)).toEqual(['I', '336', '337', 'DpnII'])
    for (const line of bed) expect(Number(line[2]) - Number(line[1])).toBe(1)

    const density = await rows(join(where, `${stem}-density.bedGraph`))
    expect(density[0].length).toBe(4)
    expect(density.reduce((sum, line) => sum + Number(line[3]), 0)).toBe(36_062)
    // Bins of the map's 1 kb: the bin holding 336 holds that cut.
    expect(density[0].slice(0, 3)).toEqual(['I', '0', '1000'])
  })

  it('names a kit’s files after the kit, and each cut after its enzyme', async () => {
    const where = join(directory, 'arima')
    const code = await main(['restriction', MAP, '--sequence', FASTA, '--enzyme', 'Arima', '--out', where, '--quiet'])
    expect(code, errors.join('')).toBe(0)
    const stem = 'Yeast_microC_G2M_1kb.restriction.restriction-Arima'
    expect(await readdir(where)).toEqual(expect.arrayContaining([`${stem}.bed`, `${stem}-density.bedGraph`]))
    const names = new Set((await rows(join(where, `${stem}.bed`))).map((line) => line[3]))
    expect(names).toEqual(new Set(['DpnII', 'HinfI']))
  })
})
