/**
 * The lab's own store: the demo workspaces published on the lab's bucket, and
 * the data files they are made of.
 *
 * They used to ship inside the bundle, in `public/demo/`, which put 250 MB of
 * Hi-C into every Pages artifact and every desktop checkout — and made the
 * deployed site read them through the *whole-object fallback*, because Pages
 * gzips `application/octet-stream` and a gzipped body cannot be range-read
 * (docs/hosting.md). Moving them to S3 fixes both at once: the app is a few MB
 * again, and the demos are now read the way §11 says a published dataset is
 * read — a `HEAD`, then bounded range `GET`s — which means the landing page
 * exercises the same path a reader's own bucket will.
 *
 * The price is the half of the hosting requirements that same-origin hosting
 * used to waive: the bucket must answer a CORS preflight and expose
 * `Content-Length` and `Content-Range`. That is bucket configuration, not code,
 * and `scripts/publish-demo.sh` applies it alongside the upload.
 *
 * **Every figure in the store is a workspace file, not a data file.** A `.cool`
 * in the list could only ever offer what dropping that file offers: a map at
 * its landing view, with nothing beside it. What a first-time reader should
 * meet is the application doing its job — a window worth looking at, tracks on
 * both edges of the map, a group of two strands sharing a lane — and all of
 * that is exactly what `state/workspace.ts` writes down. So the figures are
 * four `.chromosomix.json` files that live next to the data they name, and
 * choosing one is the same gesture as dropping a workspace somebody sent you.
 * The data files are listed too, under the figures, for the reader who wants
 * the `.cool` alone — as rows, with the two verbs every store row has.
 *
 * The four are ordered as an argument rather than by dataset: **one map with
 * its tracks**, then **the same assembly with no map at all**, then **two maps
 * side by side**, and only then **the metagenome**. A reader meeting this
 * viewer for the first time should meet the simplest complete thing it does
 * first; the multi-genome file it exists for is the last of the four because it
 * is the one that needs the other three to be legible.
 *
 * A note on the format, because it is what made every one of these stop
 * opening once: `App.openWorkspaceFile` reads `kind: "chromosomix.workspace"`
 * and refuses anything else, so a published file still written in the older
 * single-session shape is a card that fails on click with "not a workspace".
 * The four files in `demo/` are the current shape; the copies on the bucket are
 * only as current as the last run of `scripts/publish-demo.sh`, which is the
 * step that makes the store true.
 *
 * Each workspace sits in the bucket folder holding the files it names, and the
 * names *inside* it stay relative — resolved against the file's own URL on the
 * way in (`resolveConfig`). That is what keeps a dataset folder a
 * self-contained thing: `demo/yeast/` can be copied to another bucket, or
 * served off a laptop, and both of its workspaces still open. It is also why
 * moving the data to S3 changed no line of any `.chromosomix.json`.
 */

import { splitUri } from './labels'
import type { StoreEntry, StoreFile } from '../state/store'
import { STORE_KIND, STORE_VERSION } from '../state/store'
import { devFeature, type DevFeature } from '../state/devFeatures'

declare const __DEMO_BASE__: string

/**
 * The published root, with its trailing slash: one folder per dataset under it.
 *
 * The repository's own `demo/` directory mirrors this exactly — it is what
 * `scripts/publish-demo.sh` uploads and what `demo-examples.test.ts` checks —
 * so the tree on disk and the tree on the bucket are the same tree, and a demo
 * that is broken on the site is broken in CI first.
 */
export const DEMO_BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/'

/**
 * Where to read the demos from, when it is not {@link DEMO_BUCKET}.
 *
 * Empty in both shipped builds, which is what makes the web target and the
 * desktop target read the identical URLs. The override survives as a
 * build-time escape hatch (`DEMO_BASE=… vite build`) for the two cases that
 * want it: a fork publishing its own bucket, and `python3 -m http.server` over
 * a local copy of `demo/` when the network is not available.
 *
 * `typeof` because `vitest` applies no `define` block (see `version.ts`).
 */
const DEMO_BASE: string = typeof __DEMO_BASE__ === 'string' ? __DEMO_BASE__ : ''

/**
 * The figures, in the order they are offered.
 *
 * Each card says enough to choose and no more: a `title`, one `line` on what
 * is on screen, the `assembly`, and where the data came from (`provenance`,
 * the accession or the DOI, because a demo with no provenance is a screenshot).
 * The paragraph that used to be the whole row is `detail`, behind a fold on the
 * card: it says what the *session* adds on top of the file, which is the part a
 * reader cannot see from the name.
 *
 * `folder` is the dataset's own directory under {@link DEMO_BUCKET}, and it is
 * where every file that session names is looked for: entries sharing a folder —
 * as the three yeast sessions do — are that many figures over one copy of the
 * data, not that many copies of it.
 */
const DEMO: Array<{
  folder: string
  file: string
  title: string
  line: string
  assembly: string
  provenance: string
  detail: string
  /** The data files the session is made of, by name in its folder — its card's *N files* fold. */
  files: string[]
  /** The dev feature this figure belongs to, if it is one (§29): absent from the store while it is off. */
  dev?: DevFeature
}> = [
  {
    folder: 'yeast',
    file: 'Yeast_microC.chromosomix.json',
    title: 'Yeast micro-C, G2/M',
    line: 'One map, with the sequence, genes, ATAC, Pol II and 1,506 loop calls on its edges.',
    assembly: 'S288C (syn XIII-40)',
    provenance: 'DOI 10.1126/science.adm9466',
    detail:
      'A mitotic micro-C map of synthetic yeast at 1 kb (XIII carries a 40 kb insertion, hence ' +
      'XIII-syn40), balanced, opened at IV:1.0–1.4 Mb. The sequence and the gene model run along ' +
      'both edges; ATAC and its peak calls sit under the map, Pol II over input and its peaks ' +
      'beside it, and 1,506 loop calls are drawn on it.',
    files: [
      'Yeast_microC_G2M_1kb.cool',
      'S288c_syn40-XIII.fa',
      'Yeast_annotations.gtf',
      'Yeast_ATAC.bw',
      'Yeast_ATAC.narrowPeak',
      'Yeast_ChIP_Pol2-vs-input.bw',
      'Yeast_ChIP_Pol2-vs-input.narrowPeak',
      'Yeast_microC_loops.tsv',
    ],
  },
  {
    folder: 'yeast',
    file: 'Yeast_tracks.chromosomix.json',
    title: 'Yeast chromatin and transcription',
    line: 'The 1D browser with no map: eleven lanes over 50 kb of chromosome IV.',
    assembly: 'S288C (syn XIII-40)',
    provenance: 'DOI 10.1126/science.adm9466',
    detail:
      'The same assembly with no contact map at all: the sequence as GC content, the gene ' +
      'model, MNase and ATAC grouped on pinned axes, both peak call sets, the micro-C anchors ' +
      'as an interval lane, the two RNA strands on one shared axis with the reverse read ' +
      'downwards, and the loop calls as arcs. Drop a .cool on it to turn the same session into ' +
      'a map.',
    files: [
      'S288c_syn40-XIII.fa',
      'Yeast_annotations.gtf',
      'Yeast_MNase.bw',
      'Yeast_ATAC.bw',
      'Yeast_ATAC.narrowPeak',
      'Yeast_microC_anchors.bed',
      'Yeast_ChIP_Pol2-vs-input.bw',
      'Yeast_ChIP_Pol2-vs-input.narrowPeak',
      'Yeast_RNA_fwd.bw',
      'Yeast_RNA_rev.bw',
      'Yeast_microC_loops.tsv',
    ],
  },
  {
    folder: 'yeast',
    file: 'Yeast_deck.chromosomix.json',
    title: 'Micro-C beside Hi-C',
    line: 'Two maps of one locus in two formats, a .cool and a .hic, locked side by side.',
    assembly: 'S288C (syn XIII-40)',
    provenance: 'DOI 10.1126/science.adm9466',
    detail:
      'The same locus read out of two files in two different formats, in two locked columns: ' +
      'the micro-C .cool on the left and a Juicer .hic on the right, both balanced, both at ' +
      'IV:1.0–1.4 Mb. IV is one of the sequences the two assemblies agree about to the base, ' +
      'which is why the window is there. Panning either panel pans both.',
    files: ['Yeast_microC_G2M_1kb.cool', 'Yeast_hic.hic', 'Yeast_annotations.gtf', 'Yeast_ATAC.bw'],
  },
  {
    folder: 'human',
    file: 'Human_chrX_RNA.chromosomix.json',
    title: 'Splicing on human chrX',
    line: 'The 1D browser over hg19’s karyotype: a sashimi plot from reads, and two samples’ junctions on one axis.',
    assembly: 'hg19 (GRCh37)',
    provenance: 'Geuvadis · DOI 10.1038/nature12531 · nf-core/test-datasets rnasplice',
    detail:
      'The browser opened from UCSC’s hg19 cytoBand alone — its bands tile each chromosome, so it ' +
      'declares the genome — at RPL10 in Xq28. Under the ideogram, the Ensembl gene model; one ' +
      'lymphoblastoid sample’s reads as depth, with the introns they skip drawn over it as arcs ' +
      'and counted; and STAR’s junction tables for a GBR and a YRI sample, both read against one ' +
      'typed axis of 1 to 400 reads so their arcs compare. Pan out to FLNA to see the reverse ' +
      'strand’s arcs hang below the line, or type a band — Xq13 — in the locus box.',
    files: [
      'hg19_cytoBand.txt',
      'Homo_sapiens.GRCh37.chrX.gtf.gz',
      'Geuvadis_chrX_GBR_ERR188428.bam',
      'Geuvadis_chrX_GBR_ERR188428.SJ.out.tab',
      'Geuvadis_chrX_YRI_ERR188454.SJ.out.tab',
    ],
  },
  {
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.chromosomix.json',
    title: 'Mock microbial community',
    line: '49 MAGs over 20,566 contigs in one .metacool — the multi-genome file this viewer exists for.',
    assembly: 'mock community',
    provenance: 'SRA SRR32680160 · DOI 10.1038/s41564-025-02108-2',
    detail:
      'A MetaTOR binning of a mock community profiled by metaHiC: 49 genomes over 20,566 ' +
      'contigs in one 1 kb .metacool (14 MB). Lands on the genomes table, largest MAG first.',
    files: ['Mock_microbial_community.metacool', 'Mock_microbial_community.mmetacool'],
    dev: 'metacool',
  },
]

/**
 * The data files under the figures, one row each.
 *
 * What the store lists *besides* the figures: every file the figures are made
 * of, and the two maps no figure uses, so a reader who wants the `.cool`
 * alone, the ATAC bigWig on their own map, or the metagenome as an
 * `.mmetacool` ladder, has a row to press. Each figure's card lists its own
 * rows under a fold (`ui/stores/GalleryView.ts`); the same tracks are also
 * offered beside the yeast map once it is open ({@link demoAnnotationsFor}).
 */
const DEMO_DATA: Array<{
  folder: string
  file: string
  label: string
  kind: 'map' | 'genome'
  format: string
  assembly: string
  dataset: string
  /** The dev feature this file belongs to, if it is one (§29). */
  dev?: DevFeature
}> = [
  {
    folder: 'yeast',
    file: 'Yeast_microC_G2M_1kb.cool',
    label: 'Yeast micro-C, G2/M, 1 kb',
    kind: 'map',
    format: 'cool',
    assembly: 'S288C (syn XIII-40)',
    dataset: 'Yeast',
  },
  {
    folder: 'yeast',
    file: 'Yeast_hic.hic',
    label: 'Yeast Hi-C, G2/M',
    kind: 'map',
    format: 'hic',
    assembly: 'S288C (syn XIII-40)',
    dataset: 'Yeast',
  },
  {
    folder: 'yeast',
    file: 'S288c_syn40-XIII.fa',
    label: 'S288C sequence, synthetic XIII',
    kind: 'genome',
    format: 'fasta',
    assembly: 'S288C (syn XIII-40)',
    dataset: 'Yeast',
  },
  {
    // The same sequence packed at two bits a base (§8.21). Published beside the
    // FASTA rather than instead of it, because the two are read by different
    // roads and both are worth having openable: a FASTA under the whole-read
    // limit is held whole, a `.2bit` is read by range and is what an
    // assembly hub names — which is why the hub example in the paste box points
    // at this file.
    folder: 'yeast',
    file: 'Yeast_reference.2bit',
    label: 'S288C sequence, as a .2bit',
    kind: 'genome',
    format: '2bit',
    assembly: 'S288C (syn XIII-40)',
    dataset: 'Yeast',
  },
  ...(
    [
      ['Yeast_annotations.gtf', 'Genes', 'gtf'],
      ['Yeast_MNase.bw', 'MNase-seq', 'bigwig'],
      ['Yeast_ATAC.bw', 'ATAC-seq', 'bigwig'],
      ['Yeast_ATAC.narrowPeak', 'ATAC peaks', 'narrowPeak'],
      ['Yeast_ChIP_Pol2-vs-input.bw', 'Pol II over input', 'bigwig'],
      ['Yeast_ChIP_Pol2-vs-input.narrowPeak', 'Pol II peaks', 'narrowPeak'],
      ['Yeast_RNA_fwd.bw', 'RNA-seq, forward strand', 'bigwig'],
      ['Yeast_RNA_rev.bw', 'RNA-seq, reverse strand', 'bigwig'],
      ['Yeast_Shotgun.bw', 'Shotgun coverage', 'bigwig'],
      ['Yeast_expression.barChart', 'Expression by condition (synthetic)', 'barChart'],
      ['Yeast_microC_anchors.bed', 'Micro-C anchors', 'bed'],
      ['Yeast_microC_loops.tsv', 'Micro-C loop calls', 'loops'],
      // The karyotype as a cytoBand (§8.22): arms, centromeres and the rDNA —
      // no bands, since yeast chromosomes take no G-banding.
      ['Yeast_cytobands.txt', 'Karyotype: arms, centromeres, rDNA', 'cytoBand'],
      // STAR's junctions for nf-core's chrI test subset of GSE110004 (§8.23).
      ['Yeast_RNA_junctions.SJ.out.tab', 'RNA-seq splice junctions, chrI subset', 'SJ.out.tab'],
    ] as const
  ).map(([file, label, format]) => ({
    folder: 'yeast',
    file,
    label,
    kind: 'genome' as const,
    format,
    assembly: 'S288C (syn XIII-40)',
    dataset: 'Yeast',
  })),
  ...(
    [
      ['hg19_cytoBand.txt', 'Human karyotype, UCSC’s bands', 'cytoBand'],
      ['Homo_sapiens.GRCh37.chrX.gtf.gz', 'Genes, chromosome X', 'gtf'],
      ['Geuvadis_chrX_GBR_ERR188428.bam', 'RNA-seq reads, GBR ERR188428', 'bam'],
      ['Geuvadis_chrX_GBR_ERR188383.SJ.out.tab', 'Splice junctions, GBR ERR188383', 'SJ.out.tab'],
      ['Geuvadis_chrX_GBR_ERR188428.SJ.out.tab', 'Splice junctions, GBR ERR188428', 'SJ.out.tab'],
      ['Geuvadis_chrX_YRI_ERR188454.SJ.out.tab', 'Splice junctions, YRI ERR188454', 'SJ.out.tab'],
      ['Geuvadis_chrX_YRI_ERR204916.SJ.out.tab', 'Splice junctions, YRI ERR204916', 'SJ.out.tab'],
      ['Geuvadis_chrX_GBR_ERR188428.junctions.bed', 'Splice junctions as regtools writes them', 'junctions.bed'],
    ] as const
  ).map(([file, label, format]) => ({
    folder: 'human',
    file,
    label,
    kind: 'genome' as const,
    format,
    assembly: 'hg19 (GRCh37)',
    dataset: 'Human, Geuvadis chrX',
  })),
  {
    folder: 'yeast-mpneumoniae',
    file: 'Yeast_mpneumoniae_G2M.mcool',
    label: 'Yeast with M. pneumoniae, G2/M',
    kind: 'map',
    format: 'mcool',
    assembly: 'S288C + M. pneumoniae',
    dataset: 'Yeast and M. pneumoniae',
  },
  {
    folder: 'ecoli',
    file: 'Ecoli.mcool',
    label: 'E. coli Hi-C',
    kind: 'map',
    format: 'mcool',
    assembly: 'E. coli',
    dataset: 'E. coli',
  },
  {
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.metacool',
    label: 'Mock community, 49 MAGs, 1 kb',
    kind: 'map',
    format: 'metacool',
    assembly: 'mock community',
    dataset: 'Mock microbial community',
    dev: 'metacool',
  },
  {
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.mmetacool',
    label: 'Mock community, resolution ladder',
    kind: 'map',
    format: 'mmetacool',
    assembly: 'mock community',
    dataset: 'Mock microbial community',
    dev: 'metacool',
  },
]

/**
 * The annotation files published beside a demo map, and where each belongs.
 *
 * Keyed by the map's file name rather than by its URL, because the URL depends
 * on where the app is served from and the pairing does not. All ten are on the
 * map's own assembly — same sixteen contig names, same lengths, `XIII-syn40`
 * included — which is exactly what makes them worth offering as one click: a
 * reader gets a complete, correct picture without hunting for ten URLs, and the
 * §8.2 overlap report has something to report success about.
 *
 * Not the same thing as the sessions above, and both are worth having. A
 * session is a composed figure — six of the ten, placed, coloured and grouped —
 * and this is the whole shelf, offered to a reader who opened the map by URL
 * and wants the rest of it.
 */
interface DemoAnnotation {
  file: string
  /** A short name, since the file's own is a sentence about the experiment. */
  label: string
}

/**
 * The shelf beside one map: the dataset folder it lives in, and what is in it.
 *
 * The folder is recorded even though {@link demoAnnotationsFor} never reads it
 * — that function resolves against the *map's own URL*, which is the only thing
 * that also works for a copy of the folder served from somewhere else. It is
 * here for the test, which has to find these files on disk.
 */
const DEMO_ANNOTATIONS: Record<string, { folder: string; entries: DemoAnnotation[] }> = {
  'Yeast_microC_G2M_1kb.cool': {
    folder: 'yeast',
    entries: [
      { file: 'Yeast_annotations.gtf', label: 'genes' },
      { file: 'Yeast_MNase.bw', label: 'MNase' },
      { file: 'Yeast_ATAC.bw', label: 'ATAC' },
      { file: 'Yeast_ChIP_Pol2-vs-input.bw', label: 'Pol II / input' },
      { file: 'Yeast_RNA_fwd.bw', label: 'RNA +' },
      { file: 'Yeast_RNA_rev.bw', label: 'RNA −' },
      { file: 'Yeast_Shotgun.bw', label: 'shotgun' },
      { file: 'Yeast_ATAC.narrowPeak', label: 'ATAC peaks' },
      { file: 'Yeast_ChIP_Pol2-vs-input.narrowPeak', label: 'Pol II peaks' },
      { file: 'Yeast_microC_loops.tsv', label: 'loops' },
    ],
  },
}

/** One loadable annotation, with the URL resolved for wherever this is served. */
export interface DemoAnnotationLink extends DemoAnnotation {
  url: string
}

/**
 * The annotations published beside the map at `uri`, or `[]`.
 *
 * Two sources, asked in this order, and the order is the argument. A store row
 * that carried `tracks` said so **about this exact file** — the catalogue's
 * publisher named them beside the URI the reader just clicked — where the table
 * below matches on a *file name*, which is a guess that happens to be a good
 * one. A specific answer beats a general one, so a registered shelf wins
 * outright rather than being concatenated.
 *
 * The table itself is matched on the file name at the end of the URI, so it
 * works for the bucket, for a local copy of `demo/yeast/` served from anywhere
 * else, and for a fork publishing the same folder under its own name — and not
 * for a *local* file of the same name, which would be someone else's data under
 * a familiar name.
 */
export function demoAnnotationsFor(uri: string): DemoAnnotationLink[] {
  const registered = shelves.get(splitUri(uri).path)
  if (registered !== undefined) return registered.map((link) => ({ ...link }))
  if (!/^https?:\/\//i.test(uri)) return []
  const name = uri.split('?')[0].split('#')[0].split('/').pop() ?? ''
  const shelf = DEMO_ANNOTATIONS[name]
  if (shelf === undefined) return []
  const base = uri.slice(0, uri.length - name.length)
  return shelf.entries.map((entry) => ({ ...entry, url: `${base}${entry.file}` }))
}

/**
 * The published tracks to *offer*, which is none once a session has its own.
 *
 * A **restored session already names the tracks it wants** and is a moment away
 * from putting them on screen. Offered anyway, the button appeared under rows
 * that were already appearing and proposed ten more, most of them the same files
 * a second time. `restoring` covers an imported workspace, a `?config=` link and
 * a plain reload alike, because all three arrive the same way.
 */
export function demoAnnotationsToOffer(
  uri: string,
  options: { restoring: boolean },
): DemoAnnotationLink[] {
  return options.restoring ? [] : demoAnnotationsFor(uri)
}

/**
 * Every published annotation, as its path under `demo/`, for the test that
 * checks they are on disk — and so for the sync that puts them on the bucket.
 */
export const DEMO_ANNOTATION_FILES: readonly string[] = Object.values(DEMO_ANNOTATIONS).flatMap(
  (shelf) => shelf.entries.map((entry) => `${shelf.folder}/${entry.file}`),
)

/**
 * The workspace files this module offers, as their paths under `demo/`, for the
 * test that reads every one of them off disk and opens what it names.
 */
export const DEMO_FILES: readonly string[] = DEMO.map((entry) => `${entry.folder}/${entry.file}`)

/** The data files the store lists, as their paths under `demo/`, for the same test. */
export const DEMO_DATA_FILES: readonly string[] = DEMO_DATA.map(
  (entry) => `${entry.folder}/${entry.file}`,
)

/**
 * Where the demos are read from, absolute, wherever this is running.
 *
 * Resolved against the page when there is one, even though both candidates are
 * already absolute: it costs nothing, and it is what lets the escape hatch be a
 * *relative* base — `DEMO_BASE=/demo/ npm run build` for a copy served beside
 * the app. The `typeof` guard is for the node test runtime, which has no
 * `window` and in which this is still worth calling.
 */
function demoBase(): string {
  const base = DEMO_BASE !== '' ? DEMO_BASE : DEMO_BUCKET
  if (typeof window === 'undefined') return base
  try {
    return new URL(base, window.location.href).href
  } catch {
    return base
  }
}

/**
 * The columns the lab's store declares.
 *
 * Every card and every file row is drawn from these, so what a column is
 * called here is what the gallery reads: `provenance` and `detail` are the
 * card's chip and its fold, `format` and `dataset` are the file rows' chip and
 * their grouping. A store somebody else writes may call its columns anything;
 * this one is read by a front that knows it.
 */
const DEMO_COLUMNS = [
  { key: 'assembly', label: 'Assembly' },
  { key: 'dataset', label: 'Dataset' },
  { key: 'format', label: 'Format' },
  { key: 'provenance', label: 'Provenance' },
  { key: 'detail', label: 'What is on screen' },
]

/**
 * The lab's store, inline: the figures, then the data files.
 *
 * Inline rather than fetched because it is the one store that costs no request
 * and the only one that is certainly there (§24.2). Every URI is absolute
 * already, so `resolveStore` has nothing left to do to them: an inline store
 * has no URL of its own to be relative to.
 */
export function demosStore(): StoreFile {
  const base = demoBase()
  return {
    kind: STORE_KIND,
    version: STORE_VERSION,
    name: 'RSG lab data',
    description:
      'Composed figures over the lab’s published data, and the files they are made of. Every ' +
      'one is read over the network exactly as a file on your own bucket would be.',
    base,
    columns: DEMO_COLUMNS,
    entries: [
      // A figure or a file that belongs to a dev feature is not listed while
      // the switch is off (§29): the store is on the landing page, which is
      // the first place a reader would learn of it.
      ...DEMO.filter(shown).map(
        (entry): StoreEntry => ({
          label: entry.title,
          uri: `${base}${entry.folder}/${entry.file}`,
          kind: 'workspace',
          note: entry.line,
          fields: {
            assembly: entry.assembly,
            provenance: entry.provenance,
            detail: entry.detail,
            // The files the figure is made of, as the URIs of the rows below,
            // so the card lists them under its fold without a second lookup.
            // `|`-joined because a field is one string; no URI carries a bar.
            files: entry.files.map((file) => `${base}${entry.folder}/${file}`).join('|'),
          },
        }),
      ),
      ...DEMO_DATA.filter(shown).map(
        (entry): StoreEntry => ({
          label: entry.label,
          uri: `${base}${entry.folder}/${entry.file}`,
          kind: entry.kind,
          fields: { assembly: entry.assembly, dataset: entry.dataset, format: entry.format },
        }),
      ),
    ],
  }
}

/** Whether a figure or a file of the lab's store is listed: always, unless its dev feature is off. */
function shown(entry: { dev?: DevFeature }): boolean {
  return entry.dev === undefined || devFeature(entry.dev)
}

// ---------------------------------------------------------------------------
// Shelves a store brought with it
// ---------------------------------------------------------------------------

/**
 * The tracks a store row named, held until the file it belongs to is opened.
 *
 * A store entry may carry `tracks` — the bigWigs the same experiment published
 * beside the map (§24.1) — and they are the same *offer* the demo map's ten
 * annotations are: here is a set of tracks to look at, for a reader who has
 * none. So they are answered through the same question rather than a second
 * one, and `Session` needs no idea that a store exists.
 *
 * In memory and never in storage, deliberately. The offer is about the file
 * being opened right now; a shelf that outlived the tab would be a promise to
 * fetch URLs out of a catalogue the reader has since forgotten.
 */
const shelves = new Map<string, DemoAnnotationLink[]>()

/**
 * The shelves that were **asked for** rather than merely brought along.
 *
 * *Open with its tracks* says what it does, so it has to do it: a reader who
 * presses those words and gets a genome and a button has been given the thing
 * they pressed past. Every other road to the same file — the row's own open
 * verb, a `?store=` link, a dropped copy — keeps the offer, because opening a
 * genome is not a request for eight more files.
 *
 * A set beside the map rather than a field on the link, because it is a fact
 * about the *gesture* and not about the tracks: the same shelf is asked for
 * through one door and offered through another, and a flag on each link would
 * have to be rewritten on every registration to say so.
 */
const asked = new Set<string>()

/**
 * Remember the tracks published beside `uri`, so the Tracks card can offer them.
 *
 * Keyed on the **absolute URI's file half**, so it answers for the same file
 * opened at an entry (`file.mcool::resolutions/1000`) as for the file itself —
 * which is the common case rather than the exotic one, since a collection
 * opened at its root lands on one of its entries and the URI the session ends
 * up on is not the one the store row carried.
 *
 * Last registration wins: two stores naming the same map is not a conflict worth
 * a policy, and the one the reader has just clicked is the one they mean.
 */
export function registerShelf(
  uri: string,
  tracks: ReadonlyArray<{ label: string; url: string }>,
  options: { asked?: boolean } = {},
): void {
  const key = splitUri(uri).path
  if (key === '') return
  if (tracks.length === 0) {
    shelves.delete(key)
    asked.delete(key)
    return
  }
  if (options.asked === true) asked.add(key)
  else asked.delete(key)
  shelves.set(
    key,
    tracks.map((track) => ({
      // The file name is what a track row falls back to when it has no label,
      // and what `demo-examples.test.ts` checks the published set against;
      // derived here rather than asked for, since a store carries a label and a
      // URL and nothing in between.
      file: track.url.split('?')[0].split('#')[0].split('/').pop() ?? track.url,
      label: track.label,
      url: track.url,
    })),
  )
}

/**
 * Whether this file's shelf was asked for, and should be loaded rather than
 * offered.
 *
 * Read once, by the session building its cards, and **cleared as it is read**:
 * the gesture is spent. Without that, closing the tracks and reopening the same
 * genome would bring all eight back, which is the one reading of *open with its
 * tracks* nobody wants — the reader has just said no to them.
 */
export function shelfWasAsked(uri: string): boolean {
  const key = splitUri(uri).path
  if (!asked.has(key)) return false
  asked.delete(key)
  return true
}

/** Forget every registered shelf. Tests only — the map is otherwise per page. */
export function clearShelves(): void {
  shelves.clear()
  asked.clear()
}

// ---------------------------------------------------------------------------
// Worked examples for the paste boxes
// ---------------------------------------------------------------------------

/**
 * A hub and a store, ready to paste — and **ready to open**.
 *
 * The point of an example beside a paste box is not to show syntax, which the
 * specification does better. It is to be something a reader can press *open*
 * on and then edit into their own: the two below name the published demo files,
 * so each of them draws a shelf on the first press wherever this build is
 * served from, and the reader's first edit is to a thing that already worked
 * rather than to a template they cannot tell the state of.
 *
 * Which means they are held to the same bar as any other demo: every URL is one
 * of {@link DEMO_DATA_FILES} or {@link DEMO_ANNOTATION_FILES}, so the test that
 * reads those off disk covers these too, and neither example can come to name a
 * file the bucket does not have.
 *
 * The hub is an **assembly hub**: it names the demo's own `.2bit` through
 * `twoBitPath`, which is the only way a hub carries its own sequence and the
 * rung of §24.10's ladder worth demonstrating. It is this exact text because it
 * is the one a reader wrote and checked against the bucket, rather than one
 * composed here and argued about — and the URLs are built from
 * {@link DEMO_BUCKET} rather than from {@link demoBase} for a reason that only
 * shows up under `DEMO_BASE`: a local copy of `demo/` has these files, but the
 * example is a thing to *press*, and a base that pointed it at a directory
 * somebody is still filling would break the one promise it makes.
 */
export function exampleHubText(): string {
  return [
    '# A UCSC track hub, in one file: the hub line, its genome, and its tracks.',
    '# Three separate files (hub.txt, genomes.txt, trackDb.txt) can be pasted',
    '# one after another in the same text box. ',
    '',
    'hub exampleHub',
    'shortLabel Example hub',
    'longLabel Yeast demo data from RSG lab',
    'useOneFile on',
    '',
    'genome sacCer3_syn40',
    'organism Saccharomyces cerevisiae',
    `    twoBitPath ${DEMO_BUCKET}yeast/Yeast_reference.2bit`,
    '',
    'track signal',
    'compositeTrack on',
    'shortLabel Signal',
    'longLabel Two tracks, grouped as their hub groups them',
    'type bigWig',
    '',
    '    track mnase',
    '    parent signal on',
    '    shortLabel MNase',
    '    longLabel Nucleosome occupancy',
    `    bigDataUrl ${DEMO_BUCKET}yeast/Yeast_MNase.bw`,
    '    type bigWig',
    '',
    '    track atac',
    '    parent signal on',
    '    shortLabel ATAC',
    '    longLabel ATAC-seq accessibility',
    `    bigDataUrl ${DEMO_BUCKET}yeast/Yeast_ATAC.bw`,
    '    type bigWig',
    '',
    'track contacts',
    'shortLabel Micro-C map',
    'longLabel A contact map, which opens through the map door',
    `bigDataUrl ${DEMO_BUCKET}yeast/Yeast_hic.hic`,
    'type hic',
    '',
  ].join('\n')
}

/**
 * The store-file counterpart: the same two demo files, as a shelf.
 *
 * Deliberately small. A store's whole shape is `kind`, `columns` and `entries`,
 * and an example with twenty rows would bury that under nineteen copies of the
 * one line worth reading.
 */
export function exampleStoreText(): string {
  const at = `${demoBase()}yeast/`
  return `${JSON.stringify(
    {
      kind: STORE_KIND,
      version: STORE_VERSION,
      name: 'Example shelf',
      description: 'Two of the demo files, as a store you can edit',
      columns: [
        { key: 'assay', label: 'Assay' },
        { key: 'assembly', label: 'Assembly' },
      ],
      entries: [
        {
          label: 'Yeast micro-C, G2/M, 1 kb',
          uri: `${at}Yeast_microC_G2M_1kb.cool`,
          kind: 'map',
          note: 'A contact map, which opens through the map door',
          fields: { assay: 'Micro-C', assembly: 'sacCer3_syn40' },
          tracks: [{ label: 'MNase', url: `${at}Yeast_MNase.bw` }],
        },
        {
          label: 'MNase',
          uri: `${at}Yeast_MNase.bw`,
          kind: 'genome',
          note: 'A bigWig, which opens as a browser over its own genome',
          fields: { assay: 'MNase-seq', assembly: 'sacCer3_syn40' },
        },
      ],
    },
    null,
    2,
  )}\n`
}

/**
 * Every URL the two examples name, as their paths under `demo/`.
 *
 * For the test that reads the published demo files off disk: an example that
 * names a file the bucket does not have is an example that fails on its first
 * press, which is the one thing worse than no example at all.
 */
export const EXAMPLE_FILES: readonly string[] = [
  'yeast/Yeast_reference.2bit',
  'yeast/Yeast_MNase.bw',
  'yeast/Yeast_ATAC.bw',
  'yeast/Yeast_hic.hic',
  'yeast/Yeast_microC_G2M_1kb.cool',
]
