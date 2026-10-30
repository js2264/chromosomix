/**
 * The K562 showcase: one tab, opened from the landing page, that puts three
 * stores' data on one screen (§24.11).
 *
 * The stores each open their own data, and a reader who wants to see what the
 * viewer is *for* has to know which three rows of which three stores belong
 * together — a cell line both consortia profiled, a map on the assembly the
 * signal is on, a gene model on the same one. This is that answer, made once:
 * K562, the cell line 4DN and ENCODE share most, on GRCh38.
 *
 * - **The map** is 4DN's in situ Hi-C of K562 (Rao et al. 2014, 4DNESI7DEJTM),
 *   907 million contacts — deep enough for domains and their loops at 10 kb.
 * - **Above it**, IGV's hg38: the gene model, the sequence and the bands. Two
 *   of the three are read from IGV's own bucket rather than from the addresses
 *   IGV's genome table names, because those do not answer a page: UCSC's
 *   `ncbiRefSeq.txt.gz` carries no CORS header, and the FASTA of IGV's own
 *   `hg38` is on a bucket that refuses an anonymous reader (§24.3) — which is
 *   why the IGV store's human genome is `hg38_1kg`, and so is this one.
 * - **Down its left side**, the structure 4DN's pipeline computed on the same
 *   map — the insulation score, the boundaries called on it and the first
 *   eigenvector — and ENCODE's subcompartments of the same cells.
 * - **On it**, ENCODE's CTCF ChIA-PET loops of K562, as rings.
 * - **Under it**, ENCODE's ChIP-seq, ATAC-seq and DNase-seq of K562, as five
 *   lanes of two tracks each. Overlaid in pairs that are read *against* each
 *   other — CTCF where cohesin is, H3K4me3 at promoters against H3K27ac at
 *   enhancers too, Pol II at starts against H3K36me3 down gene bodies, the two
 *   kinds of repression, the two assays of accessibility — each on its own
 *   axis. Ten lanes under a map leave it at its floor on a laptop; five leave
 *   it a map.
 *
 * Built here rather than published on the lab's bucket beside the demos, for
 * the reason the rows it names are where they are: every file is on its own
 * consortium's bucket already, so the session is the only thing to publish, and
 * a few kilobytes in the bundle is a session that cannot go missing from a
 * bucket. It is a `SessionConfig` like any a workspace file holds, opened by
 * the road a dropped one takes (`Session.openConfig`), and its test reads it
 * back through `parseWorkspaceFile`, the validator every such file meets.
 *
 * **One tab and one map, no deck**: the point is the three edges of one
 * picture, and a deck would split them across cells.
 */

import { FIELD_NAME } from '../annotations/fields'
import { defaultStyle, placementOn } from '../annotations/types'
import type { AnnotationCard, AnnotationKind, LaneEdge, StoredEntry } from '../annotations/types'
import { CONFIG_VERSION, type SessionConfig } from '../state/SessionConfig'
import type { ViewState } from '../types'
import { getPlotOptions } from './plotOptions'

/** 4DN's open-data bucket, as the 4DN store reads it. */
const FOURDN = 'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/'
/** ENCODE's public bucket, as the ENCODE store reads it. */
const ENCODE = 'https://encode-public.s3.amazonaws.com/'
/** IGV's own copy of its hg38 annotations, which answers a page where UCSC's does not. */
const IGV_HG38 = 'https://s3.amazonaws.com/igv.org.genomes/hg38/'
/** The FASTA of IGV's `hg38_1kg`, read by range through the index beside it. */
const HG38_FASTA =
  'https://1000genomes.s3.amazonaws.com/technical/reference/GRCh38_reference_genome/GRCh38_full_analysis_set_plus_decoy_hla.fa'

/** The map: 4DN's in situ Hi-C of K562, merged replicates (4DNESI7DEJTM). */
export const SHOWCASE_MAP = `${FOURDN}230ad652-0232-47f2-97ef-296c7a040bd9/4DNFI18UHVRO.mcool`

/**
 * Where it opens: MYC, PVT1 and the blood enhancer cluster downstream of them,
 * at 10 kb — a sharp compartment edge, domains with loops at their corners, and
 * the locus K562 is known for.
 */
export const SHOWCASE_REGION = 'chr8:126800000-130200000'
const SHOWCASE_BINSIZE = 10_000

/** What the button says, what the tab is called, and the one line beside the button. */
export const SHOWCASE = {
  kicker: 'Just looking?',
  button: 'open K562 in one tab',
  tab: 'K562 · 4DN, ENCODE and IGV',
  line: '4DN’s Hi-C of K562 with its insulation and compartments, ENCODE’s ChIP-seq, ATAC and DNase, and IGV’s hg38 genes.',
} as const

/** One row of the Tracks card, on one edge — or, for an overlay, on the map. */
function row(
  id: string,
  kind: AnnotationKind,
  label: string,
  url: string,
  edge: LaneEdge,
  colour: string,
  size: number,
  more: { card?: AnnotationCard; index?: string; group?: string; style?: Partial<StoredEntry['style']>; primary?: boolean } = {},
): StoredEntry {
  return {
    id: `k562-${id}`,
    card: more.card ?? 'linear',
    kind,
    label,
    source: {
      kind: 'remote',
      name: url.slice(url.lastIndexOf('/') + 1),
      url,
      ...(more.index === undefined ? {} : { index: more.index }),
    },
    visible: true,
    placement: placementOn(edge),
    style: { ...defaultStyle(kind, colour), size, group: more.group ?? '', ...more.style },
    ...(more.primary === true ? { primary: true } : {}),
  }
}

/**
 * The subcompartments' own colours, by the cluster number each row is named
 * with: the file's itemRgb, which a segment lane does not read, carried as the
 * colours its names are drawn in. Numbers rather than *A1*…*B3*, because the
 * file says which cluster and not which label.
 */
const SUBCOMPARTMENT_COLOURS: Record<string, string> = {
  '1': '#228b22',
  '2': '#98fb98',
  '3': '#dc143c',
  '4': '#ffff00',
  '5': '#708090',
}

/** The pairs under the map: each group is one lane, its two tracks overlaid, each on its own axis. */
const PAIRS: ReadonlyArray<{
  group: string
  tracks: ReadonlyArray<readonly [id: string, label: string, path: string, colour: string]>
}> = [
  {
    group: 'CTCF and cohesin',
    tracks: [
      // ENCSR000AKO, Bernstein (Broad); ENCSR000FAD, Weissman (Yale).
      ['ctcf', 'CTCF', '2020/09/26/85161a5a-d6b5-49d2-bc0a-db0b217ff0d5/ENCFF979PWH.bigWig', '#0072b2'],
      ['rad21', 'RAD21', '2020/12/12/5dd3b2bc-d063-45a9-a1a2-d72d954abc8d/ENCFF320RTQ.bigWig', '#e69f00'],
    ],
  },
  {
    group: 'promoters and enhancers',
    tracks: [
      // ENCSR000AKU and ENCSR000AKP, Bernstein (Broad).
      ['h3k4me3', 'H3K4me3', '2020/09/30/127536f7-16c3-4f65-b621-134645ea90d3/ENCFF660WUG.bigWig', '#d55e00'],
      ['h3k27ac', 'H3K27ac', '2022/06/14/a3a5887a-bfe4-4c51-856e-986d8d40cfe2/ENCFF381NDD.bigWig', '#f0c419'],
    ],
  },
  {
    group: 'transcription',
    tracks: [
      // ENCSR000EHL, Snyder (Stanford); ENCSR000AKR, Bernstein (Broad).
      ['polr2a', 'Pol II', '2020/12/27/1d26d5d9-f56e-48d8-9ea8-eb31fae4f2cd/ENCFF937ZPS.bigWig', '#cc79a7'],
      ['h3k36me3', 'H3K36me3', '2022/06/14/9727529c-4692-4a48-b004-440358d2a5a8/ENCFF317VHO.bigWig', '#009e73'],
    ],
  },
  {
    group: 'repression',
    tracks: [
      // ENCSR000AKQ and ENCSR000APE, Bernstein (Broad).
      ['h3k27me3', 'H3K27me3', '2022/06/16/c9e15712-7cb9-453e-8b49-80e70709b234/ENCFF242ENK.bigWig', '#7b5ea7'],
      ['h3k9me3', 'H3K9me3', '2020/10/29/c38d5ac9-2cb8-4d12-b0d9-843fadfafe92/ENCFF601JGK.bigWig', '#8c8c8c'],
    ],
  },
  {
    group: 'accessibility',
    tracks: [
      // ENCSR868FGK, Snyder (Stanford); ENCSR000EOT, Stamatoyannopoulos (UW).
      ['atac', 'ATAC', '2021/03/16/b790ea43-824d-4934-840b-cb3612634cfd/ENCFF102ARJ.bigWig', '#117733'],
      ['dnase', 'DNase', '2025/08/14/a5f81aa9-187f-4c0b-8018-fcf749307768/ENCFF957ZCO.bigWig', '#56b4e9'],
    ],
  },
]

/**
 * Every row, in the order each edge stacks them outward from the map: the
 * first row on an edge is the lane against the picture.
 */
function showcaseTracks(): StoredEntry[] {
  return [
    // Above: IGV's hg38 — genes against the map, then the sequence, then the bands.
    row('genes', 'gtf', 'RefSeq genes (IGV)', `${IGV_HG38}ncbiRefSeq.txt.gz`, 'top', '#5b6169', 44, { primary: true }),
    row('sequence', 'sequence', 'hg38 sequence (IGV)', HG38_FASTA, 'top', '#5b6169', 24, { index: `${HG38_FASTA}.fai` }),
    row('bands', 'ideogram', 'hg38 bands (IGV)', `${IGV_HG38}annotations/cytoBandIdeo.txt.gz`, 'top', '#5b6169', 20),
    // Left: what the map is made of, 4DN's on this very map and ENCODE's on the same cells.
    row('insulation', 'track', 'insulation (4DN)', `${FOURDN}e6af9802-c6b9-4db7-bb1f-7a8070c931a0/4DNFIXU7QLG6.bw`, 'left', '#1aa0b8', 48),
    row('boundaries', 'segments', 'boundaries (4DN)', `${FOURDN}76dc2907-2bdc-4e78-87aa-dc0fcd0ab993/4DNFI4EFYN3Q.bed.gz`, 'left', '#1aa0b8', 16),
    row('e1', 'track', 'E1 · compartments (4DN)', `${FOURDN}1643fcdf-1258-4684-a835-89eb19ad5654/4DNFIWUAO2QI.bw`, 'left', '#8c8c8c', 48),
    row(
      'subcompartments',
      'segments',
      'subcompartments (ENCODE)',
      `${ENCODE}2022/10/10/f84d155e-5cce-4ad6-a8cb-990de539a929/ENCFF955KEB.bed.gz`,
      'left',
      '#8c8c8c',
      16,
      {
        style: {
          features: {
            colourBy: FIELD_NAME,
            arrows: false,
            bars: 'file',
            display: 'collapsed',
            nameColours: SUBCOMPARTMENT_COLOURS,
          },
        },
      },
    ),
    // On the map: CTCF ChIA-PET loops of K562 (ENCSR597AKG, Ruan lab), one ring a pair.
    row(
      'loops',
      'pairs',
      'CTCF ChIA-PET loops (ENCODE)',
      `${ENCODE}2020/08/16/fd75d5ae-d6d3-459d-a2ef-9b7e14483957/ENCFF118PBQ.bedpe.gz`,
      'bottom',
      '#0072b2',
      16,
      { card: 'overlay' },
    ),
    // Below: ENCODE's 1D signal of K562, fold change over control for ChIP and ATAC.
    ...PAIRS.flatMap(({ group, tracks }) =>
      tracks.map(([id, label, path, colour]) =>
        row(id, 'track', label, `${ENCODE}${path}`, 'bottom', colour, 36, { group }),
      ),
    ),
  ]
}

/** The tab, as a workspace holds it. */
export function showcaseConfig(now: Date = new Date()): SessionConfig {
  const groups = PAIRS.map(({ group }) => group)
  const state: ViewState = {
    uri: `${SHOWCASE_MAP}::resolutions/${SHOWCASE_BINSIZE}`,
    view: 'region',
    region: SHOWCASE_REGION,
    level: 'bin',
    balance: true,
    transform: 'log10',
    colormap: 'default',
  }
  return {
    version: CONFIG_VERSION,
    createdAt: now.toISOString(),
    name: SHOWCASE.tab,
    state,
    tracks: showcaseTracks(),
    manual: [],
    bookmarks: [],
    sequences: [],
    groups: Object.fromEntries(groups.map((group) => [group, 'overlay'])),
    scaling: Object.fromEntries(groups.map((group) => [group, 'each'])),
    tables: {},
    deck: {},
    analysis: {},
    // The reader's own overlays, so that opening this changes none of them: a
    // workspace's `plot` is applied on import, and this one has no opinion.
    plot: getPlotOptions(),
    mapNames: { [SHOWCASE_MAP]: 'Hi-C · K562 (Rao et al. 2014, 4DN)' },
  }
}
