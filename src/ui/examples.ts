/**
 * The demo files published beside the app.
 *
 * `public/demo/` is copied into the build verbatim, so these are served from
 * the app's own origin (see docs/deploy.md). That is not a shortcut around
 * §11: the reader takes exactly the remote path it takes for a bucket — a
 * `HEAD`, then bounded range `GET`s — and only the CORS half of the hosting
 * requirements falls away, because there is no second origin to negotiate with.
 *
 * URLs are built from `BASE_URL` and made absolute against the page, for two
 * reasons: the base is `/` in dev and `/<repo>/` on Pages, and a view state
 * carrying a *relative* URI would not survive being shared — `inferSource` in
 * `main.ts` re-opens a link only when its path is `http(s)://`.
 */

declare const __DEMO_BASE__: string

/**
 * Where the demos are, when they are not beside the app.
 *
 * Empty on the web, where `BASE_URL` resolved against the page is right by
 * construction — the files are in `public/demo/` and ship with the bundle. Set
 * to an absolute origin in the desktop build, which serves its renderer from
 * `app://viewer` and publishes no demos of its own; those URLs then go through
 * the *remote* reader, which needs a `HEAD` and bounded range `GET`s that a
 * static handler over a packaged directory does not answer.
 *
 * `typeof` because `vitest` applies no `define` block (see `version.ts`).
 */
const DEMO_BASE: string = typeof __DEMO_BASE__ === 'string' ? __DEMO_BASE__ : ''

export interface Example {
  label: string
  url: string
  note?: string
  /**
   * What opening it produces: a contact map, or a 1D genome browser.
   *
   * Both are "open this file and see something", and the picker lists them
   * together for that reason — but a reader choosing one is choosing between two
   * different applications, so the list says which.
   */
  kind?: 'map' | 'genome'
}

/**
 * The catalogue, in the order it is offered. Each `note` names the accession
 * the data came from, because a demo file with no provenance is a screenshot:
 * it shows the viewer working and tells you nothing you could check.
 */
const DEMO: Array<{ file: string; label: string; note: string }> = [
  {
    file: 'Mock_microbial_community.metacool',
    label: 'Mock microbial community — 49 MAGs (metacool)',
    note:
      'A MetaTOR binning of a mock community profiled by metaHiC: ' +
      '49 genomes over 20,566 contigs, 1 kb bins, 7.1 M pixels (14 MB).' +
      '(SRA SRR32680160; DOI: 10.1038/s41564-025-02108-2)',
  },
  {
    file: 'Mock_microbial_community.mmetacool',
    label: 'Mock microbial community — 1/2/4 kb ladder (mmetacool)',
    note:
      'The same map zoomified: three resolutions in one collection, opened at the finest (35 MB).',
  },
  {
    file: 'Yeast_mpneumoniae_G2M.mcool',
    label: 'Yeast + M. pneumoniae, G2/M (mcool)',
    note:
      'A Hi-C library of synthetic yeast with a supernumerary chromosome of ' +
      'the M. pneumoniae genome: 19.6 M contacts over five resolutions from 1 ' +
      'to 16 kb (DOI: 10.1126/science.adm9466; GEO GSM6703657)'
  },
  {
    file: 'Ecoli.mcool',
    label: 'E. coli, wild type (mcool)',
    note:
      'Wild-type E. coli Hi-C map revealing transcription-induced ' +
      'domains: one 4.64 Mb chromosome, 111 M contacts over eight ' +
      'resolutions from 500 bp to 100 kb (46 MB). ' +
      '(DOI: 10.1038/s41594-023-01178-2)'
  },
  {
    file: 'Yeast_microC_G2M_1kb.cool',
    label: 'Yeast micro-C, G2/M — single 1 kb map (cool)',
    note:
      'A mitotic micro-C map of synthetic yeast: 16 chromosomes ' +
      '(XIII carries a 40 kb insertion, hence XIII-syn40), 12,118 bins of ' +
      '1 kb, 13.7 M pixels, 179 M contacts, balanced (19 MB).',
  },
]

/**
 * The demos that open a *genome browser* rather than a map.
 *
 * One entry, and one is enough to make the point: a bigWig declares its own
 * assembly in its header, so dropping one is all it takes to get a browser over
 * a real genome with a real track already in it. Everything else — the gene
 * model, the peak calls, the loops — is then a drop away, and they are the same
 * ten files the map beside them offers.
 */
const DEMO_GENOMES: Array<{ file: string; label: string; note: string }> = [
  {
    file: 'Yeast_ATAC.bw',
    label: 'Yeast ATAC — a genome browser, no map (bigWig)',
    note:
      'Opens the 1D browser on the sixteen chromosomes this bigWig’s header names, with the ' +
      'track already drawn across all of them. Drop the gene model, the peak calls or the ' +
      'loops on it — or drop a .cool to turn the same session into a contact map.',
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
 */
interface DemoAnnotation {
  file: string
  /** A short name, since the file's own is a sentence about the experiment. */
  label: string
}

const DEMO_ANNOTATIONS: Record<string, DemoAnnotation[]> = {
  'Yeast_microC_G2M_1kb.cool': [
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
}

/** One loadable annotation, with the URL resolved for wherever this is served. */
export interface DemoAnnotationLink extends DemoAnnotation {
  url: string
}

/**
 * The annotations published beside the map at `uri`, or `[]`.
 *
 * Matched on the file name at the end of the URI, so it works for the published
 * site, for `vite dev`, and for a copy of `public/demo/` served from anywhere
 * else — and not for a *local* file of the same name, which would be someone
 * else's data under a familiar name.
 */
export function demoAnnotationsFor(uri: string): DemoAnnotationLink[] {
  if (!/^https?:\/\//i.test(uri)) return []
  const name = uri.split('?')[0].split('#')[0].split('/').pop() ?? ''
  const entries = DEMO_ANNOTATIONS[name]
  if (entries === undefined) return []
  const base = uri.slice(0, uri.length - name.length)
  return entries.map((entry) => ({ ...entry, url: `${base}${entry.file}` }))
}

/** Every published annotation file, for the test that checks they are on disk. */
export const DEMO_ANNOTATION_FILES: readonly string[] = Object.values(DEMO_ANNOTATIONS)
  .flat()
  .map((entry) => entry.file)

/**
 * The bare file names this module offers, for the test that opens every one of
 * them out of `public/demo/`.
 *
 * A separate export rather than `demoExamples().map(...)` because that function
 * needs `import.meta.env.BASE_URL` and `window.location`, neither of which
 * exists in the node test runtime — and because the thing worth checking is the
 * file on disk, not the URL built around it.
 */
export const DEMO_FILES: readonly string[] = DEMO.map((entry) => entry.file)

/**
 * The genome-browser demos, for the test that checks they are on disk.
 *
 * Checked for existence only, and not opened as a cooler, because they are not
 * one: what makes them valid is that the annotations worker can read an assembly
 * out of them, which `annotation-parse` already covers for this very file.
 */
export const DEMO_GENOME_FILES: readonly string[] = DEMO_GENOMES.map((entry) => entry.file)

/**
 * Absolute URLs for the published demo files, in the order they should be
 * offered — the metacool first, because it is the file type this viewer exists
 * for, then the plain coolers, as the fallback path they exercise: the `.mcool`s
 * for the resolution ladder, the single `.cool` last for the case where there is
 * no ladder to land on.
 */
export function demoExamples(): Example[] {
  // An absolute base wins over the second argument to `new URL`, so the line
  // below is unchanged in either case and nothing downstream can tell which one
  // it got: `inferSource` still sees `http(s)://`, and a view state naming a
  // demo re-opens in the desktop build exactly as it does on the website.
  const base = DEMO_BASE !== '' ? DEMO_BASE : import.meta.env.BASE_URL
  const absolute = (file: string): string =>
    new URL(`${base}demo/${file}`, window.location.href).href
  return [
    ...DEMO.map((entry) => ({
      label: entry.label,
      url: absolute(entry.file),
      note: entry.note,
      kind: 'map' as const,
    })),
    ...DEMO_GENOMES.map((entry) => ({
      label: entry.label,
      url: absolute(entry.file),
      note: entry.note,
      kind: 'genome' as const,
    })),
  ]
}
