/**
 * `hic-straw`, typed to the four calls the oracle makes.
 *
 * The package ships no declarations, and the alternative to this file is an
 * `any` import — which would silently accept a renamed method and turn the
 * oracle into a test that passes because it never ran. Narrow on purpose: what
 * is declared here is the contract the test depends on, so a straw upgrade that
 * breaks it fails at the typecheck rather than at midnight.
 */
declare module 'hic-straw/dist/hic-straw.esm.js' {
  interface StrawRegion {
    chr: string
    start?: number
    end?: number
  }

  interface StrawRecord {
    bin1: number
    bin2: number
    counts: number
  }

  interface StrawMetaData {
    version: number
    genomeId: string
    chromosomes: Array<{ index: number; name: string; size: number }>
    /** Base-pair bin sizes, in file order. */
    resolutions: number[]
  }

  export default class Straw {
    constructor(config: { file?: unknown; url?: string; path?: string })
    getMetaData(): Promise<StrawMetaData>
    getNormalizationOptions(): Promise<string[]>
    getContactRecords(
      normalization: string,
      region1: StrawRegion,
      region2: StrawRegion,
      units: 'BP' | 'FRAG',
      binsize: number,
    ): Promise<StrawRecord[]>
  }
}
