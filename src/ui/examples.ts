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

export interface Example {
  label: string
  url: string
  note?: string
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
  card: 'linear' | 'overlay'
  zone: 'gtf' | 'track' | 'segments' | 'pairs'
  label: string
}

const DEMO_ANNOTATIONS: Record<string, DemoAnnotation[]> = {
  'Yeast_microC_G2M_1kb.cool': [
    { file: 'Yeast_annotations.gtf', card: 'linear', zone: 'gtf', label: 'genes' },
    { file: 'Yeast_MNase.bw', card: 'linear', zone: 'track', label: 'MNase' },
    { file: 'Yeast_ATAC.bw', card: 'linear', zone: 'track', label: 'ATAC' },
    { file: 'Yeast_ChIP_Pol2-vs-input.bw', card: 'linear', zone: 'track', label: 'Pol II / input' },
    { file: 'Yeast_RNA_fwd.bw', card: 'linear', zone: 'track', label: 'RNA +' },
    { file: 'Yeast_RNA_rev.bw', card: 'linear', zone: 'track', label: 'RNA −' },
    { file: 'Yeast_Shotgun.bw', card: 'linear', zone: 'track', label: 'shotgun' },
    { file: 'Yeast_ATAC.narrowPeak', card: 'linear', zone: 'segments', label: 'ATAC peaks' },
    {
      file: 'Yeast_ChIP_Pol2-vs-input.narrowPeak',
      card: 'linear',
      zone: 'segments',
      label: 'Pol II peaks',
    },
    { file: 'Yeast_microC_loops.tsv', card: 'overlay', zone: 'pairs', label: 'loops' },
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
 * Absolute URLs for the published demo files, in the order they should be
 * offered — the metacool first, because it is the file type this viewer exists
 * for, then the plain coolers, as the fallback path they exercise: the `.mcool`s
 * for the resolution ladder, the single `.cool` last for the case where there is
 * no ladder to land on.
 */
export function demoExamples(): Example[] {
  const base = import.meta.env.BASE_URL
  return DEMO.map((entry) => ({
    label: entry.label,
    url: new URL(`${base}demo/${entry.file}`, window.location.href).href,
    note: entry.note,
  }))
}
