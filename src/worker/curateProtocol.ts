/**
 * The curation stage's requests to the reader worker (SPECS §33): what the file's
 * binning is, the contig network's pass, and — counted again after every step —
 * what the method makes of the binning as it stands, and the contacts among a
 * few genomes' contigs for the stage's close-up.
 *
 * Every one is answered from the file as it is (`unlensed`), never through a
 * curation's lens, and none changes what a kept answer of the map depends on.
 */

import type { BaseBinning, Curation, CuratedLink, FileBinning, GenomeKind } from '../genome/curation'
import type { Background } from '../curate/method'
import type { FocusContacts, FocusPicture } from '../curate/focus'
import type { Quality } from '../curate/quality'
import type { ContigPlaces, GenomePairs, HostPair, KindWeights, Suggestion } from '../curate/suggest'

/** The file's binning, as the curation starts from it. */
export interface CurationBaseResult {
  base: BaseBinning
  file: FileBinning
  /** Elements, and how many of them only round `mge` names. */
  elements: { count: number; fromRoundOnly: number }
  /** Each contig's GC content, in percent; `null` where the map has none. */
  gc: Float64Array | null
  /** The marker sets the map holds, by name; `[]` without `metator markers`. */
  markerSets: string[]
  /** The stored pixels the network's pass will read, for the gate's price (§7.3). */
  pixels: number | null
  /** Whether the network is already held, and the pass need not be asked again. */
  networkHeld: boolean
}

/** The contig network's pass: what it read and kept. */
export interface CurationNetworkResult {
  contigs: number
  pairs: number
  pixels: number
  /** Contacts within contigs, and between two. */
  within: number
  between: number
  background: Background
}

/** What the method makes of the binning a curation folds into. */
export interface CurationStateResult {
  /** The curated binning's own fingerprint: the stage drops an answer to a binning it has left. */
  fingerprint: string
  /**
   * Whether the contacts were read: before the network's pass, the genomes,
   * their quality and the links are answered, and the pairs, the hosts, the
   * contigs' places and the suggestions are empty.
   */
  counted: boolean
  /** Each curated genome, in the binning's order. */
  genomes: Array<{
    id: string
    name: string
    kind: GenomeKind
    asInFile: boolean
    contigs: number
    length: number
    /** The contacts within it, between two of its contigs, and its visibility. */
    within: number
    visibility: number
    quality: Quality | null
  }>
  /** Each contig's curated genome, `-1` for the pool. */
  genomeOf: Int32Array
  links: CuratedLink[]
  pairs: GenomePairs
  hosts: HostPair[]
  contigs: ContigPlaces
  suggestions: Suggestion[]
}

/**
 * The contacts among some contigs, each pair once, for the stage's close-up:
 * the numbers its readout shows, and the picture it draws (`curate/focus.ts`).
 */
export interface CurationFocusResult extends FocusContacts {
  /** The contigs asked, in the order asked, as indices of the file's. */
  contigs: Int32Array
  /** Pairs `i < j` of indices into {@link contigs}, sorted by `i` then `j`, and their contacts. */
  i: Int32Array
  j: Int32Array
  contacts: Float64Array
  /** Each contig's contacts within itself. */
  within: Float64Array
  /** Each contig's visibility, and every contig's of the map summed. */
  visibility: Float64Array
  total: number
  /** The network's background ratio. */
  background: number
  /** One cell a contig; `null` past `FOCUS_PICTURE_CAP` contigs. */
  picture: FocusPicture | null
}

/** The requests, as `WorkerRequest` members. */
export type CurationRequest =
  | { id: number; kind: 'curationBase' }
  | { id: number; kind: 'curationNetwork'; background?: boolean }
  | { id: number; kind: 'curationState'; curation: Curation | null; weights?: KindWeights }
  | { id: number; kind: 'curationFocus'; contigs: Int32Array }

/** The results, as `ResultMap` members. */
export interface CurationResults {
  curationBase: CurationBaseResult
  curationNetwork: CurationNetworkResult
  curationState: CurationStateResult
  curationFocus: CurationFocusResult
}
