/**
 * The demo workspaces published on the lab's bucket.
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
 * **Every entry in the picker is a workspace file, not a data file.** A `.cool`
 * in the list could only ever offer what dropping that file offers: a map at
 * its landing view, with nothing beside it. What a first-time reader should
 * meet is the application doing its job — a window worth looking at, tracks on
 * both edges of the map, a group of two strands sharing a lane — and all of
 * that is exactly what `state/workspace.ts` writes down. So the catalogue is
 * three `.metacooler.json` files that live next to the data they name, and
 * choosing one is the same gesture as dropping a workspace somebody sent you.
 * Nothing here is a second way of opening a file.
 *
 * Each is a workspace of **one tab**, which is what the format's `active` index
 * and `tabs` list collapse to when there is one of them. Nothing stops a
 * published example being several — a map and the genome browser over the same
 * assembly, say — and `demo-examples.test.ts` walks every tab of every entry
 * rather than the first, so a second one would be checked the day it arrives.
 *
 * Each workspace sits in the bucket folder holding the files it names, and the
 * names *inside* it stay relative — resolved against the file's own URL on the
 * way in (`resolveConfig`). That is what keeps a dataset folder a
 * self-contained thing: `demo/yeast/` can be copied to another bucket, or
 * served off a laptop, and both of its workspaces still open. It is also why
 * moving the data to S3 changed no line of any `.metacooler.json`.
 */

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
 * desktop target read the identical URLs — the demos are no longer "beside the
 * app" in either one, so there is no longer a per-target base to get wrong.
 * The override survives as a build-time escape hatch (`DEMO_BASE=… vite build`)
 * for the two cases that want it: a fork publishing its own bucket, and
 * `python3 -m http.server` over a local copy of `demo/` when the network is
 * not available.
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
 *
 * `folder` is the dataset's own directory under {@link DEMO_BUCKET}, and it is
 * where every file that session names is looked for: two entries sharing a
 * folder — as the two yeast sessions do — are two figures over one copy of the
 * data, not two copies of it.
 */
const DEMO: Array<{
  folder: string
  file: string
  label: string
  note: string
  kind: 'map' | 'genome'
}> = [
  {
    folder: 'mock-community',
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
    folder: 'yeast',
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
    folder: 'yeast',
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

/**
 * The shelf beside one map: the dataset folder it lives in, and what is in it.
 *
 * The folder is recorded even though {@link demoAnnotationsFor} never reads it
 * — that function resolves against the *map's own URL*, which is the only thing
 * that also works for a copy of the folder served from somewhere else. It is
 * here for the test, which has to find these files on disk, and writing it down
 * once beside the names is what keeps the two from disagreeing about where the
 * data lives.
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
 * Matched on the file name at the end of the URI, so it works for the bucket,
 * for a local copy of `demo/yeast/` served from anywhere else, and for a fork
 * publishing the same folder under its own name — and not for a *local* file of
 * the same name, which would be someone else's data under a familiar name.
 */
export function demoAnnotationsFor(uri: string): DemoAnnotationLink[] {
  if (!/^https?:\/\//i.test(uri)) return []
  const name = uri.split('?')[0].split('#')[0].split('/').pop() ?? ''
  const shelf = DEMO_ANNOTATIONS[name]
  if (shelf === undefined) return []
  const base = uri.slice(0, uri.length - name.length)
  return shelf.entries.map((entry) => ({ ...entry, url: `${base}${entry.file}` }))
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
 *
 * A separate export rather than `demoExamples().map(...)` because that function
 * needs `window.location`, which does not exist in the node test runtime — and
 * because the thing worth checking is the file on disk, which is what the sync
 * uploads, not the URL built around it.
 */
export const DEMO_FILES: readonly string[] = DEMO.map((entry) => `${entry.folder}/${entry.file}`)

/**
 * Absolute URLs for the published workspaces, in the order they should be
 * offered — the metagenomic ladder first, because a multi-genome map is the
 * file type this viewer exists for; then the same yeast assembly twice, as a
 * map with tracks around it and as the tracks with no map at all.
 */
export function demoExamples(): Example[] {
  const base = DEMO_BASE !== '' ? DEMO_BASE : DEMO_BUCKET
  // Still resolved against the page, even though both candidates are already
  // absolute: it costs nothing, and it is what lets the escape hatch be a
  // *relative* base — `DEMO_BASE=/demo/ npm run build` for a copy served beside
  // the app. Whatever comes out is `http(s)://`, which is the shape
  // `inferSource` in `app/resolve.ts` needs to re-open a shared link.
  return DEMO.map((entry) => ({
    label: entry.label,
    url: new URL(`${base}${entry.folder}/${entry.file}`, window.location.href).href,
    note: entry.note,
    kind: entry.kind,
  }))
}
