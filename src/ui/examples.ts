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
]

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
 * for, and the plain `.mcool`s last, as the fallback path they exercise.
 */
export function demoExamples(): Example[] {
  const base = import.meta.env.BASE_URL
  return DEMO.map((entry) => ({
    label: entry.label,
    url: new URL(`${base}demo/${entry.file}`, window.location.href).href,
    note: entry.note,
  }))
}
