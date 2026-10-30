/**
 * The landing page's example sessions (§24.11): four buttons under *Just
 * looking?*, each opening one tab of somebody's published data, for the reader
 * who wants to see what the viewer is for before choosing any of it.
 *
 * - **Human Hi-C data** — three stores on one map, built here (below).
 * - **Yeast micro-C data** — the lab's store's micro-C figure, read from the
 *   lab's bucket as its card in the drawer reads it.
 * - **Linear tracks** — the lab's store's yeast landscape: the same tracks with
 *   no map, in the 1D browser, close enough to read the reading frames.
 * - **Comparing data** — two moments of one cell cycle in one square, built
 *   here (below).
 *
 * Each button carries a `?` (`questionMark.ts`, the Analysis column's) whose tip
 * says what the tab holds and where it is from, so the button itself is a name
 * and nothing else.
 *
 * ## Human Hi-C data: three stores on one map
 *
 * The stores each open their own data, and a reader who wants to see them
 * together has to know which rows of which stores belong together — a cell line
 * both consortia profiled, a map on the assembly the signal is on, a gene model
 * on the same one. This is that answer, made once: K562, the cell line 4DN and
 * ENCODE share most, on GRCh38, in one tab with **no deck**, since the point is
 * the three edges of one picture and a deck would split them across cells.
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
 * ## Comparing data: G2 against mitosis in one square
 *
 * Chicken DT40 cells released from a G2 block into mitosis (Gibcus et al.
 * 2018), from 4DN's bucket: the G2 map above the diagonal and the one 60 min
 * on — the time course's last point, which 4DN calls a prometaphase block —
 * below it (§5.7), on one colour scale, the two libraries within a percent of
 * one depth. Each map's compartment eigenvector and insulation score is on the
 * edge beside its own triangle — G2's along the top, the mitotic one's down the
 * left — on one fixed axis per kind, so the checkerboard and the domains of G2
 * are read against their flattening in mitosis on the map and on its edges at
 * once. 40 Mb of chromosome 1 at 100 kb: wide enough for compartments, and for
 * the mitotic band that replaces them.
 *
 * ## Why two of them are built here
 *
 * Every file they name is on its own consortium's bucket already, so the
 * session is the only thing to publish, and a few kilobytes in the bundle is a
 * session that cannot go missing from a bucket. Each is a `SessionConfig` like
 * any a workspace file holds, opened by the road a dropped one takes
 * (`Session.openConfig`), and its test reads it back through
 * `parseWorkspaceFile`, the validator every such file meets.
 */

import { FIELD_NAME } from '../annotations/fields'
import { defaultStyle, placementOn } from '../annotations/types'
import type { AnnotationCard, AnnotationKind, LaneEdge, StoredEntry } from '../annotations/types'
import { CONFIG_VERSION, type SessionConfig } from '../state/SessionConfig'
import type { ViewState } from '../types'
import { demoFigure } from './examples'
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

/** What the column says over its buttons. */
export const EXAMPLES = {
  kicker: 'Just looking?',
  prompt: 'Pick an example session',
} as const

/** One example: its button, its tip's two lines, and what it opens. */
export interface ExampleSession {
  id: 'human' | 'yeast' | 'linear' | 'compare'
  /** The button's words: the name of what it opens, as a store tile's are. */
  label: string
  /** The tip's first line: what is on screen. */
  about: string
  /** Its second: where the data is from. */
  from: string
  /** Built here, or a workspace of the lab's store, by its address. */
  open: { config(): SessionConfig } | { workspace: string }
}

/** The four, in the order the column stands. */
export function exampleSessions(): ExampleSession[] {
  const microC = demoFigure('Yeast_microC.chromosomix.json')
  const landscape = demoFigure('Yeast_landscape.chromosomix.json')
  return [
    {
      id: 'human',
      label: 'Human Hi-C data',
      about:
        'K562 at MYC: 4DN’s Hi-C with its insulation and compartments, ENCODE’s ChIP-seq, ATAC and DNase of the same cells, and IGV’s hg38 genes.',
      from: 'Rao et al. 2014 (4DN) · ENCODE · IGV',
      open: { config: () => humanConfig() },
    },
    {
      id: 'yeast',
      label: 'Yeast micro-C data',
      about: microC.line,
      from: `${microC.title}, from the RSG lab data · ${microC.provenance}`,
      open: { workspace: microC.uri },
    },
    {
      id: 'linear',
      label: 'Linear tracks',
      about: landscape.line,
      from: `${landscape.title}, from the RSG lab data · ${landscape.provenance}`,
      open: { workspace: landscape.uri },
    },
    {
      id: 'compare',
      label: 'Comparing data',
      about:
        'Chicken Hi-C in G2 above the diagonal and 60 min into mitosis below it, each with its compartments and insulation.',
      from: 'Gibcus et al. 2018 (4DN)',
      open: { config: () => comparisonConfig() },
    },
  ]
}

/** Human Hi-C data's map: 4DN's in situ Hi-C of K562, merged replicates (4DNESI7DEJTM). */
export const HUMAN_MAP = `${FOURDN}230ad652-0232-47f2-97ef-296c7a040bd9/4DNFI18UHVRO.mcool`

/**
 * Where it opens: MYC, PVT1 and the blood enhancer cluster downstream of them,
 * at 10 kb — a sharp compartment edge, domains with loops at their corners, and
 * the locus K562 is known for.
 */
export const HUMAN_REGION = 'chr8:126800000-130200000'

/** Comparing data's two maps: DT40 at the G2 block (4DNES9LEZXN7) and 60 min after it (4DNESEQNSXSD). */
export const CHICKEN_G2 = `${FOURDN}b829095a-28e6-49ec-bd18-2b4bc319d0eb/4DNFIT479GDR.mcool`
export const CHICKEN_MITOSIS = `${FOURDN}6bc6bab2-1319-46ce-b296-cb2be777274b/4DNFIWHQLZTL.mcool`
export const COMPARISON_REGION = 'chr1:20000000-60000000'

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
    id,
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
function humanTracks(): StoredEntry[] {
  return [
    // Above: IGV's hg38 — genes against the map, then the sequence, then the bands.
    row('k562-genes', 'gtf', 'RefSeq genes (IGV)', `${IGV_HG38}ncbiRefSeq.txt.gz`, 'top', '#5b6169', 44, { primary: true }),
    row('k562-sequence', 'sequence', 'hg38 sequence (IGV)', HG38_FASTA, 'top', '#5b6169', 24, { index: `${HG38_FASTA}.fai` }),
    row('k562-bands', 'ideogram', 'hg38 bands (IGV)', `${IGV_HG38}annotations/cytoBandIdeo.txt.gz`, 'top', '#5b6169', 20),
    // Left: what the map is made of, 4DN's on this very map and ENCODE's on the same cells.
    row('k562-insulation', 'track', 'insulation (4DN)', `${FOURDN}e6af9802-c6b9-4db7-bb1f-7a8070c931a0/4DNFIXU7QLG6.bw`, 'left', '#1aa0b8', 48),
    row('k562-boundaries', 'segments', 'boundaries (4DN)', `${FOURDN}76dc2907-2bdc-4e78-87aa-dc0fcd0ab993/4DNFI4EFYN3Q.bed.gz`, 'left', '#1aa0b8', 16),
    row('k562-e1', 'track', 'E1 · compartments (4DN)', `${FOURDN}1643fcdf-1258-4684-a835-89eb19ad5654/4DNFIWUAO2QI.bw`, 'left', '#8c8c8c', 48),
    row(
      'k562-subcompartments',
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
      'k562-loops',
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
        row(`k562-${id}`, 'track', label, `${ENCODE}${path}`, 'bottom', colour, 36, { group }),
      ),
    ),
  ]
}

/**
 * Comparing data's four rows: each map's E1 and insulation on the edge beside
 * its own triangle — G2's above, the mitotic map's down the left — on one fixed
 * axis per kind, so the two sides are read on one scale as the map is.
 */
function comparisonTracks(): StoredEntry[] {
  const e1 = { limits: { auto: false, min: -1.5, max: 1.5 } }
  const insulation = { limits: { auto: false, min: -1, max: 1 } }
  return [
    row('dt40-g2-e1', 'track', 'E1 · G2 (4DN)', `${FOURDN}1091e6d5-b6e9-4b5c-8b5e-e37f369ec91e/4DNFILLAMSTE.bw`, 'top', '#7b3294', 44, { style: e1 }),
    row('dt40-g2-insulation', 'track', 'insulation · G2 (4DN)', `${FOURDN}a1f0586f-2b91-49b3-93ea-2f1f53e28657/4DNFI1PRBI5L.bw`, 'top', '#0072b2', 44, { style: insulation }),
    row('dt40-60min-e1', 'track', 'E1 · 60 min (4DN)', `${FOURDN}ba2e9238-0812-4715-9b0d-043dca03f962/4DNFIX92O41A.bw`, 'left', '#7b3294', 44, { style: e1 }),
    row('dt40-60min-insulation', 'track', 'insulation · 60 min (4DN)', `${FOURDN}3be0a8f1-c7e7-4434-aab5-e7f343228c3a/4DNFI12IF3LX.bw`, 'left', '#0072b2', 44, { style: insulation }),
  ]
}

/** One tab, as a workspace holds it: a map in a window, its rows and its names. */
function tab(
  now: Date,
  name: string,
  state: ViewState,
  tracks: StoredEntry[],
  more: Pick<SessionConfig, 'groups' | 'scaling' | 'mapNames'>,
): SessionConfig {
  return {
    version: CONFIG_VERSION,
    createdAt: now.toISOString(),
    name,
    state,
    tracks,
    manual: [],
    bookmarks: [],
    sequences: [],
    tables: {},
    deck: {},
    analysis: {},
    // The reader's own overlays, so that opening this changes none of them: a
    // workspace's `plot` is applied on import, and these have no opinion.
    plot: getPlotOptions(),
    ...more,
  }
}

/** Human Hi-C data, as a workspace holds it. */
export function humanConfig(now: Date = new Date()): SessionConfig {
  const groups = PAIRS.map(({ group }) => group)
  return tab(
    now,
    'K562 · 4DN, ENCODE and IGV',
    {
      uri: `${HUMAN_MAP}::resolutions/10000`,
      view: 'region',
      region: HUMAN_REGION,
      level: 'bin',
      balance: true,
      transform: 'log10',
      colormap: 'default',
    },
    humanTracks(),
    {
      groups: Object.fromEntries(groups.map((group) => [group, 'overlay'])),
      scaling: Object.fromEntries(groups.map((group) => [group, 'each'])),
      mapNames: { [HUMAN_MAP]: 'Hi-C · K562 (Rao et al. 2014, 4DN)' },
    },
  )
}

/** Comparing data, as a workspace holds it: the second map in the lower triangle (§5.7). */
export function comparisonConfig(now: Date = new Date()): SessionConfig {
  return tab(
    now,
    'Chicken DT40 · G2 and mitosis',
    {
      uri: `${CHICKEN_G2}::resolutions/100000`,
      uri2: `${CHICKEN_MITOSIS}::resolutions/100000`,
      view: 'region',
      region: COMPARISON_REGION,
      level: 'bin',
      balance: true,
      transform: 'log10',
      colormap: 'default',
    },
    comparisonTracks(),
    {
      groups: {},
      scaling: {},
      mapNames: {
        [CHICKEN_G2]: 'G2 (Gibcus et al. 2018, 4DN)',
        [CHICKEN_MITOSIS]: 'prometaphase, 60 min (Gibcus et al. 2018, 4DN)',
      },
    },
  )
}
