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

const DEMO: Array<{ file: string; label: string; note: string }> = [
  {
    file: 'MM133.metacool',
    label: 'MM133 — 49 MAGs',
    note: 'A MetaTOR metagenome: 49 genomes over 20,566 contigs, 1 kb bins, 7.1 M pixels (14 MB).',
  },
  {
    file: 'MM133.mmetacool',
    label: 'MM133 — 1/2/4 kb ladder',
    note: 'The same map zoomified: three resolutions in one collection (35 MB).',
  },
  {
    file: 'MM133.cool',
    label: 'MM133 — plain cool',
    note: 'The same pixels without the genome hierarchy. Detected and refused for now: cool support is M7.',
  },
]

/**
 * Absolute URLs for the published demo files, in the order they should be
 * offered — the metacool first, because it is the file type this viewer exists
 * for.
 */
export function demoExamples(): Example[] {
  const base = import.meta.env.BASE_URL
  return DEMO.map((entry) => ({
    label: entry.label,
    url: new URL(`${base}demo/${entry.file}`, window.location.href).href,
    note: entry.note,
  }))
}
