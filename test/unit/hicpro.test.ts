/**
 * A HiC-Pro pair, read as a map — against the cooler it was written from.
 *
 * `scripts/make_hicpro_fixtures.py` builds a small cooler, writes it out in
 * HiC-Pro's two-file form four times over (one per `MATRIX_FORMAT`), and puts
 * **cooler's own dense matrix** in the manifest. So the question every case here
 * asks is the one that matters: does this pair of text files mean the same
 * matrix as the cooler it came from?
 *
 * That is a round trip through the format checked against the implementation
 * this application is a port of, which is a stronger oracle than any hand-built
 * fixture — and it is only available because the format is text, so a cooler
 * can be written out as one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ViewerError } from '@/errors'
import { hicProHandle } from '@/hicpro/handle'
import { parseBins, parseMatrix } from '@/hicpro/parse'
import { MetaCooler } from '@/metacooler/MetaCooler'
import { LocalFileSource } from '@/sources/LocalFileSource'
import { binsFor, openMap } from '@/worker/open'

const FIXTURES = decodeURIComponent(new URL('../fixtures/', import.meta.url).pathname)
const MANIFEST = `${FIXTURES}_hicpro.json`

interface HicProManifest {
  binsize: number
  nbins: number
  dense: number[][]
  pixels: Record<string, number>
  variants: Array<{ format: string; matrix: string; bins: string }>
  fragment: { matrix: string; bins: string }
}

const present = existsSync(MANIFEST)
const manifest: HicProManifest = present
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as HicProManifest)
  : ({ binsize: 0, nbins: 0, dense: [], pixels: {}, variants: [], fragment: { matrix: '', bins: '' } } as HicProManifest)

const VARIANTS: Array<[string, string, string]> = manifest.variants.map((v) => [
  v.format,
  v.matrix,
  v.bins,
])

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(`${FIXTURES}${name}`))

/** Open a pair the way the worker will: parse both halves, then build the map. */
async function open(matrixName: string, binsName: string): Promise<MetaCooler> {
  const bins = parseBins(read(binsName), binsName)
  const pixels = await parseMatrix(read(matrixName), bins.nBins, matrixName)
  return MetaCooler.fromHicPro(`${FIXTURES}${matrixName}`, {
    bins,
    pixels,
    matrixName,
    binsName,
  })
}

describe.skipIf(!present)('the fixtures', () => {
  it('cover all four MATRIX_FORMAT variants', () => {
    expect(VARIANTS.map(([fmt]) => fmt).sort()).toEqual(['asis', 'complete', 'lower', 'upper'])
  })
})

describe.skipIf(!present)('the pair opens as a cooler-class map', () => {
  it.each(VARIANTS)('%s: the coordinate system comes off the BED', async (_f, m, b) => {
    const mc = await open(m, b)
    try {
      expect(mc.layout.kind).toBe('hicpro')
      expect(mc.binsize).toBe(manifest.binsize)
      expect(mc.nBins).toBe(manifest.nbins)
      expect(mc.chromnames).toEqual(['chr1', 'chr2'])
      // No genome layer, exactly as a cooler has none — so the app lands on the
      // chromosomes table rather than inventing a genomes one.
      expect(mc.hasGenomes).toBe(false)
      // …and no weights, which is a decision rather than a gap (§3.8).
      expect(mc.hasWeights).toBe(false)
    } finally {
      mc.close()
    }
  })

  it.each(VARIANTS)('%s: the whole matrix is the one cooler computed', async (_f, m, b) => {
    const mc = await open(m, b)
    try {
      const n = manifest.nbins
      const block = await mc.matrix({ rows: [0, n] })
      const got: number[][] = []
      for (let r = 0; r < n; r++) {
        got.push(Array.from(block.values.subarray(r * n, (r + 1) * n), Number))
      }
      expect(got).toEqual(manifest.dense)
    } finally {
      mc.close()
    }
  })

  it.each(VARIANTS)('%s: a sub-window agrees with the whole', async (_f, m, b) => {
    const mc = await open(m, b)
    try {
      const n = manifest.nbins
      const whole = await mc.matrix({ rows: [0, n] })
      // An off-diagonal rectangle, which is the read the CSR index has to get
      // right and the one a transposed plan would silently mirror.
      const win = await mc.matrix({ rows: [0, 2], cols: [3, 5] })
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          expect(win.values[r * 2 + c], `(${r},${c + 3})`).toBe(whole.values[r * n + (c + 3)])
        }
      }
    } finally {
      mc.close()
    }
  })

  it.each(VARIANTS)('%s: reports the pixel count and total it actually read', async (_f, m, b) => {
    const mc = await open(m, b)
    try {
      // Six distinct pixels, whichever triangle they were stored in — a
      // `complete` file holds eleven rows for them and must still say six.
      expect(mc.nnz).toBe(Object.keys(manifest.pixels).length)
      const total = Object.values(manifest.pixels).reduce((a, v) => a + v, 0)
      expect(Number(mc.info['sum'])).toBe(total)
    } finally {
      mc.close()
    }
  })
})

describe.skipIf(!present)('a region of one sequence', () => {
  it('is addressed by name, as any cooler is', async () => {
    const [, m, b] = VARIANTS[0]
    const mc = await open(m, b)
    try {
      const chr2 = mc.coords.contigBinExtent(1)
      expect([...chr2]).toEqual([3, 5])
      const block = await mc.matrix({ rows: chr2 })
      // chr2 holds bins 3 and 4, and (3,4) = 9 — mirrored onto (4,3).
      expect(block.values[1]).toBe(9)
      expect(block.values[2]).toBe(9)
    } finally {
      mc.close()
    }
  })
})

describe.skipIf(!present)('a fragment-level pair', () => {
  it('is refused by name, with the config key that produced it', async () => {
    const bins = parseBins(read(manifest.fragment.bins), manifest.fragment.bins)
    expect(bins.fixed).toBe(false)
    const pixels = await parseMatrix(read(manifest.fragment.matrix), bins.nBins, 'frag')
    let thrown: unknown
    try {
      MetaCooler.fromHicPro('frag', {
        bins,
        pixels,
        matrixName: manifest.fragment.matrix,
        binsName: manifest.fragment.bins,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ViewerError)
    expect((thrown as ViewerError).code).toBe('variable-bins')
    expect((thrown as ViewerError).message).toContain('GENOME_FRAGMENT')
  })
})

describe.skipIf(!present)('the road both workers open a file by', () => {
  // The reader worker and the analysis worker mount the same file on two
  // threads, and for a while they disagreed about what a file *is*: the reader
  // grew the HiC-Pro road and the analysis worker went on calling
  // `MetaCooler.open`, so it reached h5wasm with a `.matrix` and failed inside
  // it — `error - name not defined!` — for every task on a map that was drawn
  // and perfectly fine. What is asserted here is that there is one road, and
  // that it is the one that knows about both containers.
  const specOf = (name: string): { kind: 'local'; file: File } => ({
    kind: 'local',
    file: new File([readFileSync(`${FIXTURES}${name}`)], name),
  })

  it('opens a HiC-Pro pair, where the plain HDF5 road cannot', async () => {
    const [, matrixName, binsName] = VARIANTS[0]
    // The failure this test exists for, stated first so it cannot silently stop
    // being one: HDF5 does not recognise a text file, and says so unhelpfully.
    await expect(
      MetaCooler.open(`${FIXTURES}${matrixName}`, await LocalFileSource.fromPath(`${FIXTURES}${matrixName}`)),
    ).rejects.toThrow(/name not defined/)

    const { mc } = await openMap(`${FIXTURES}${matrixName}`, {
      ...specOf(matrixName),
      bins: specOf(binsName),
    })
    try {
      expect(mc.layout.kind).toBe('hicpro')
      expect(mc.nBins).toBe(manifest.nbins)
      // And it is a *map*, not merely an open handle — which is what a task
      // reaches for the moment it starts.
      const block = await mc.matrix({ rows: [0, manifest.nbins] })
      expect(Array.from(block.values.subarray(0, manifest.nbins), Number)).toEqual(manifest.dense[0])
    } finally {
      mc.close()
    }
  })

  it('sends everything else down the HDF5 road, untouched', async () => {
    // The branch, rather than the open behind it: mounting HDF5 needs a
    // `FileReaderSync`, which exists in a worker and not here, and the road
    // itself is what these two tests are about. `null` *is* the statement that
    // this file is not a HiC-Pro pair.
    await expect(binsFor(specOf('hicpro_oracle.cool'))).resolves.toBeNull()
    await expect(binsFor({ kind: 'remote', url: 'https://x/y.mcool' })).resolves.toBeNull()
  })

  it('refuses a matrix with no bin file, by name and with the three ways out', async () => {
    const [, matrixName] = VARIANTS[0]
    const error = await binsFor(specOf(matrixName)).then(
      () => null,
      (err: unknown) => err as ViewerError,
    )
    expect(error).toBeInstanceOf(ViewerError)
    expect(error?.code).toBe('hicpro-no-bins')
    expect(error?.message).toContain('#bins=')
  })
})

describe.skipIf(!present)('the handle serves the cooler datasets honestly', () => {
  it('so CoolerStore reads it with no second implementation', async () => {
    // The property that deletes a module: unlike a `.hic`, this container can
    // answer `pixels/*` and `indexes/bin1_offset`, because it was read whole.
    const [, m, b] = VARIANTS[0]
    const bins = parseBins(read(b), b)
    const pixels = await parseMatrix(read(m), bins.nBins, m)
    const h = hicProHandle('x', { bins, pixels, matrixName: m, binsName: b })
    expect(h.has('indexes/bin1_offset')).toBe(true)
    expect(h.has('pixels/bin1_id')).toBe(true)
    expect(h.keys('pixels')).toEqual(['bin1_id', 'bin2_id', 'count'])
    expect(h.datasetLength('pixels/bin1_id')).toBe(pixels.nnz)
    expect([...h.readNumeric('indexes/bin1_offset')]).toEqual([...pixels.binOffset])
    expect([...h.readInt32('pixels/bin1_id', 0, 2)]).toEqual([...pixels.bin1.subarray(0, 2)])
  })
})
