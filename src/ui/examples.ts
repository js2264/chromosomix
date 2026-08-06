/**
 * The demo sessions published beside the app.
 *
 * `public/demo/` is copied into the build verbatim, so these are served from
 * the app's own origin (see docs/deploy.md). That is not a shortcut around
 * §11: the reader takes exactly the remote path it takes for a bucket — a
 * `HEAD`, then bounded range `GET`s — and only the CORS half of the hosting
 * requirements falls away, because there is no second origin to negotiate with.
 *
 * **Every entry in the picker is a session file, not a data file.** A `.cool`
 * in the list could only ever offer what dropping that file offers: a map at
 * its landing view, with nothing beside it. What a first-time reader should
 * meet is the application doing its job — a window worth looking at, tracks on
 * both edges of the map, a group of two strands sharing a lane — and all of
 * that is exactly what `state/SessionConfig.ts` already writes down. So the
 * catalogue is three `.metacooler.json` files that live next to the data they
 * name, and choosing one is the same gesture as dropping a session somebody
 * sent you. Nothing here is a second way of opening a file.
 *
 * URLs are built from `BASE_URL` and made absolute against the page, for two
 * reasons: the base is `/` in dev and `/<repo>/` on Pages, and a view state
 * carrying a *relative* URI would not survive being shared — `inferSource` in
 * `app/Session.ts` re-opens a link only when its path is `http(s)://`. The
 * files each config *names* stay relative inside it, and are resolved against
 * the config's own URL on the way in (`resolveConfig`), which is what lets one
 * directory of sessions work in dev, on Pages and in the desktop build.
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
   * Both are "open this and see something", and the picker lists them together
   * for that reason — but a reader choosing one is choosing between two
   * different applications, so the list says which.
   */
  kind?: 'map' | 'genome'
}

/**
 * The catalogue, in the order it is offered.
 *
 * Each `note` names the accession the data came from, because a demo with no
 * provenance is a screenshot: it shows the viewer working and tells you nothing
 * you could check. And each one says what the *session* adds on top of the
 * file, because that is the part a reader cannot see from the name.
 */
const DEMO: Array<{ file: string; label: string; note: string; kind: 'map' | 'genome' }> = [
  {
    file: 'Mock_microbial_community.metacooler.json',
    label: 'Mock microbial community — 49 MAGs, 1/2/4 kb ladder (mmetacool)',
    kind: 'map',
    note:
      'A MetaTOR binning of a mock community profiled by metaHiC, zoomified: 49 genomes over ' +
      '20,566 contigs at 1, 2 and 4 kb in one collection, opened at the finest (35 MB). Lands on ' +
      'the genomes table, largest MAG first. ' +
      '(SRA SRR32680160; DOI: 10.1038/s41564-025-02108-2)',
  },
  {
    file: 'Yeast_microC.metacooler.json',
    label: 'Yeast micro-C, G2/M — a map with tracks on both edges (cool)',
    kind: 'map',
    note:
      'A mitotic micro-C map of synthetic yeast at 1 kb (XIII carries a 40 kb insertion, hence ' +
      'XIII-syn40), balanced, opened at IV:1.0–1.4 Mb. The sequence and the gene model run along ' +
      'both edges; ATAC and its peak calls sit under the map, Pol II over input and its peaks ' +
      'beside it, and 1,506 loop calls are drawn on it. ' +
      '(DOI: 10.1126/science.adm9466)',
  },
  {
    file: 'Yeast_tracks.metacooler.json',
    label: 'Yeast chromatin and transcription — a genome browser, no map (bigWig)',
    kind: 'genome',
    note:
      'The same assembly with no contact map at all: ten lanes over 50 kb of chromosome IV — the ' +
      'sequence as GC content, the gene model, MNase and ATAC grouped on pinned axes, both peak ' +
      'call sets, the two RNA strands on one shared axis with the reverse read downwards, and ' +
      'the loop calls as arcs. Drop a .cool on it to turn the same session into a map.',
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
 * The session files this module offers, for the test that reads every one of
 * them out of `public/demo/` and opens what it names.
 *
 * A separate export rather than `demoExamples().map(...)` because that function
 * needs `import.meta.env.BASE_URL` and `window.location`, neither of which
 * exists in the node test runtime — and because the thing worth checking is the
 * file on disk, not the URL built around it.
 */
export const DEMO_FILES: readonly string[] = DEMO.map((entry) => entry.file)

/**
 * Absolute URLs for the published sessions, in the order they should be
 * offered — the metagenomic ladder first, because a multi-genome map is the
 * file type this viewer exists for; then the same yeast assembly twice, as a
 * map with tracks around it and as the tracks with no map at all.
 */
export function demoExamples(): Example[] {
  // An absolute base wins over the second argument to `new URL`, so the line
  // below is unchanged in either case and nothing downstream can tell which one
  // it got: `inferSource` still sees `http(s)://`, and a view state naming a
  // demo re-opens in the desktop build exactly as it does on the website.
  const base = DEMO_BASE !== '' ? DEMO_BASE : import.meta.env.BASE_URL
  return DEMO.map((entry) => ({
    label: entry.label,
    url: new URL(`${base}demo/${entry.file}`, window.location.href).href,
    note: entry.note,
    kind: entry.kind,
  }))
}
