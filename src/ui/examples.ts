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
 * four `.metacooler.json` files that live next to the data they name, and
 * choosing one is the same gesture as dropping a workspace somebody sent you.
 * Nothing here is a second way of opening a file.
 *
 * The four are ordered as an argument rather than by dataset: **one map with
 * its tracks**, then **the same assembly with no map at all**, then **two maps
 * side by side**, and only then **the metagenome**. A reader meeting this
 * viewer for the first time should meet the simplest complete thing it does
 * first; the multi-genome file it exists for is the last of the four because it
 * is the one that needs the other three to be legible.
 *
 * A note on the format, because it is what made every one of these stop
 * opening once: `App.openWorkspaceFile` reads `kind: "metacooler.workspace"`
 * and refuses anything else, so a published file still written in the older
 * single-session shape (`kind: "metacooler.session"`) is a picker entry that
 * fails on click with "not a workspace". The four files in `demo/` are the
 * current shape; the copies on the bucket are only as current as the last run
 * of `scripts/publish-demo.sh`, which is the step that makes the catalogue
 * true.
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

import { splitUri } from './labels'
import type { Hub, HubEntry, HubRef } from '../state/hub'
import { HUB_KIND, HUB_VERSION } from '../state/hub'
import { HOMEPAGE } from '../version'
import { SITE_BASE } from '../versions'

export type { HubRef } from '../state/hub'

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

/**
 * The catalogue, in the order it is offered.
 *
 * Each `note` names the accession the data came from, because a demo with no
 * provenance is a screenshot: it shows the viewer working and tells you nothing
 * you could check. And each one says what the *session* adds on top of the
 * file, because that is the part a reader cannot see from the name.
 *
 * `folder` is the dataset's own directory under {@link DEMO_BUCKET}, and it is
 * where every file that session names is looked for: entries sharing a folder —
 * as the three yeast sessions do — are that many figures over one copy of the
 * data, not that many copies of it. It may be nested (`metagenomics/mock-community`),
 * which is how a bucket groups datasets by the kind of experiment they are.
 */
const DEMO: Array<{
  folder: string
  file: string
  label: string
  note: string
  /** The value of the Demos hub's `assembly` column for this entry. */
  assembly: string
}> = [
  {
    folder: 'yeast',
    file: 'Yeast_microC.metacooler.json',
    label: 'Yeast micro-C, G2/M — one map, tracks on both edges (cool)',
    assembly: 'S288C (syn XIII-40)',
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
    label: 'Yeast chromatin and transcription — the browser, no map (bigWig)',
    assembly: 'S288C (syn XIII-40)',
    note:
      'The same assembly with no contact map at all: eleven lanes over 50 kb of chromosome IV — ' +
      'the sequence as GC content, the gene model, MNase and ATAC grouped on pinned axes, both ' +
      'peak call sets, the micro-C anchors as an interval lane, the two RNA strands on one ' +
      'shared axis with the reverse read downwards, and the loop calls as arcs. Drop a .cool on ' +
      'it to turn the same session into a map.',
  },
  {
    folder: 'yeast',
    file: 'Yeast_deck.metacooler.json',
    label: 'Yeast micro-C beside Hi-C — two maps in a deck (cool + hic)',
    assembly: 'S288C (syn XIII-40)',
    note:
      'The same locus read out of two files in two different formats, in two locked columns: ' +
      'the micro-C .cool on the left and a Juicer .hic on the right, both balanced, both at ' +
      'IV:1.0–1.4 Mb. IV is one of the sequences the two assemblies agree about to the base, ' +
      'which is why the window is there. Panning either panel pans both. ' +
      '(DOI: 10.1126/science.adm9466)',
  },
  {
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.metacooler.json',
    label: 'Mock microbial community — 49 MAGs over 20,566 contigs (metacool)',
    assembly: 'mock community',
    note:
      'A MetaTOR binning of a mock community profiled by metaHiC: 49 genomes over 20,566 ' +
      'contigs in one 1 kb .metacool (14 MB). Lands on the genomes table, largest MAG first — ' +
      'the multi-genome file this viewer exists for. ' +
      '(SRA SRR32680160; DOI: 10.1038/s41564-025-02108-2)',
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
 * Two sources, asked in this order, and the order is the argument. A hub row
 * that carried `tracks` said so **about this exact file** — the catalogue's
 * publisher named them beside the URI the reader just clicked — where the table
 * below matches on a *file name*, which is a guess that happens to be a good
 * one. A specific answer beats a general one, so a registered shelf wins
 * outright rather than being concatenated: a hub naming three bigWigs for a map
 * that happens to be called `Yeast_microC_G2M_1kb.cool` means three, not
 * thirteen.
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
 * A separate question from {@link demoAnnotationsFor}, and worth its own name
 * because the two are about different things: that one asks what is published
 * beside this map, and this one asks whether the reader should be shown a button
 * that loads it. The button says *here is a set of tracks to look at*, which is
 * an offer to somebody who has none.
 *
 * A **restored session already names the tracks it wants** and is a moment away
 * from putting them on screen. Offered anyway, the button appeared under rows
 * that were already appearing and proposed ten more, most of them the same files
 * a second time — and worst on the published sessions, which are saved over
 * exactly this map, so a reader opening one met a viewer volunteering to
 * duplicate what it had just handed them.
 *
 * `restoring` covers an imported workspace, a `?config=` link and a plain
 * reload alike, because all three arrive the same way: rows in session memory,
 * written before the column is built.
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
 *
 * A separate export rather than a `map` over {@link builtinHubs} because the
 * thing worth checking is the file on disk, which is what the sync uploads, not
 * the URL built around it.
 */
export const DEMO_FILES: readonly string[] = DEMO.map((entry) => `${entry.folder}/${entry.file}`)


// ---------------------------------------------------------------------------
// The demos, as a hub — and the two generated ones beside them
// ---------------------------------------------------------------------------

/**
 * Where the demos are read from, absolute, wherever this is running.
 *
 * Resolved against the page when there is one, even though both candidates are
 * already absolute: it costs nothing, and it is what lets the escape hatch be a
 * *relative* base — `DEMO_BASE=/demo/ npm run build` for a copy served beside
 * the app. The `typeof` guard is for the node test runtime, which has no
 * `window` and in which this is still worth calling: a test that walks the
 * built-in hub is checking the entries, not the origin.
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
 * The columns the Demos hub declares.
 *
 * Four, and three of them are empty on every demo — which is part of why they
 * are there. The Demos hub is the first table a reader ever sees and it is also
 * the shape the 4DN and ENCODE hubs arrive in; a first table with one column
 * would teach that a hub is a list, and the second one would then be a surprise.
 * The two 4DN rows below fill all four, so the header row is honest about what
 * a column is for the moment anybody looks at it.
 */
const DEMO_COLUMNS = [
  { key: 'assembly', label: 'Assembly' },
  { key: 'biosource', label: 'Biosource' },
  { key: 'assay', label: 'Assay' },
  { key: 'lab', label: 'Lab' },
]

/**
 * Two files on the 4DN open-data bucket, offered beside the lab's own demos.
 *
 * They are here because of what they prove, which no file on the lab's bucket
 * can: that a reader's *next* file does not have to be published by us. Both
 * were opened in the unmodified viewer on 2026-09-11 straight off 4DN's public
 * bucket, by range, with no key and no proxy — which is the claim §24 makes and
 * the one a first-time reader has no way to check from a demo folder this
 * project controls end to end.
 *
 * Sizes are recorded rather than guessed, because a size in a hub is what lets
 * the table say what a row costs before it is clicked (§24.1) — and these two
 * are exactly the rows worth saying it about.
 */
const DEMO_4DN: HubEntry[] = [
  {
    label: 'Hi-C, HCT116 RAD21-AID (Rao 2017) — 4DN open data (hic)',
    uri:
      'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/' +
      '000789fe-9a22-4280-a71c-7ad228fd4cac/4DNFIM7ZVQOQ.hic',
    kind: 'map',
    size: 839405381,
    fields: {
      assembly: 'GRCh38',
      biosource: 'HCT116 with Crispr generated mClover and AID-tagged RAD21',
      assay: 'in situ Hi-C (MboI)',
      lab: 'Erez Lieberman Aiden, BCM',
    },
    note:
      '4DNFIM7ZVQOQ · Rao SSP et al. (2017) PMID:28985562 · read by range straight off the ' +
      '4DN bucket',
  },
  {
    label: 'Hi-C, human, 13 resolutions — 4DN open data (mcool)',
    uri:
      'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/' +
      '00034edc-e0dc-45b1-b2a1-7db3a13ef869/4DNFIOKRZ21H.mcool',
    kind: 'map',
    size: 2191787975,
    fields: { assembly: 'GRCh38' },
    note:
      '4DNFIOKRZ21H · 2.2 GB, 24 chromosomes, 1 kb to 10 Mb · a multi-resolution cooler the ' +
      '4DN hub will name in full',
  },
]

/**
 * Where the generated hubs are read from: the site's own `hubs/` directory.
 *
 * `.github/workflows/hubs.yml` writes them to the `hubs` branch, and
 * `.github/workflows/deploy.yml` copies the current three files from that
 * branch into `hubs/` beside the app on every deploy — which the hubs workflow
 * asks for as soon as it has published, so a fresh hub is on the site minutes
 * later with no push to `main` (§24.3). The branch is where the workflow
 * *writes*; the site is where a browser *reads*, and the reason that
 * distinction exists took a private repository to notice: the first design
 * read the branch straight off `raw.githubusercontent.com`, which answers 404
 * to anyone not logged in when the repository is private — and a Pages site is
 * public whether or not its repository is. Same origin as the page, so no CORS
 * enters into it; an archived build or a preview reaches up to the site root
 * through `SITE_BASE`, since the hubs are published once and not per copy.
 *
 * A build with no site to be relative to — the desktop's `app://viewer`, a
 * standalone file — reads the deployed site by its absolute address, which is
 * `package.json`'s `homepage`; GitHub Pages serves every file with
 * `Access-Control-Allow-Origin: *`, so that read is allowed from anywhere. With
 * no homepage either, the path is left relative and answers 404, which the
 * table reports as the state it is.
 *
 * **Both 404 until `hubs.yml` has run once and the deploy it asks for has
 * finished**, which is a state rather than a failure and is the reason
 * `fetchHub` tells 404 apart from every other answer: the table says "not
 * generated yet" and names the workflow.
 */
function hubsBase(): string {
  const onSite = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
  if (onSite) {
    try {
      return `${new URL(SITE_BASE, window.location.href).href}hubs/`
    } catch {
      // Fall through to the deployed site: a base that does not resolve is not
      // a site this page is on.
    }
  }
  return `${HOMEPAGE}hubs/`
}

/** The Demos hub: the four published workspaces, and two files that are not ours. */
function demosHub(): Hub {
  const base = demoBase()
  return {
    kind: HUB_KIND,
    version: HUB_VERSION,
    name: 'Demos',
    description:
      'Four composed sessions on the lab’s bucket, and two maps on 4DN’s. Every one of them ' +
      'is read over the network exactly as a file on your own bucket would be.',
    base,
    columns: DEMO_COLUMNS,
    entries: [
      ...DEMO.map(
        (entry): HubEntry => ({
          label: entry.label,
          // Absolute already, so `resolveHub` has nothing left to do to them:
          // an inline hub has no URL of its own to be relative to.
          uri: `${base}${entry.folder}/${entry.file}`,
          // Every demo is a *workspace*, which is the argument this module's
          // header makes at length: a `.cool` in the list could only offer what
          // dropping that file offers, and what a first-time reader should meet
          // is the application doing its job.
          kind: 'workspace',
          note: entry.note,
          fields: { assembly: entry.assembly },
        }),
      ),
      ...DEMO_4DN,
    ],
  }
}

/**
 * The hubs this build ships a pointer to, in the order they are offered.
 *
 * Demos first and inline, because it is the only one that costs no request and
 * the only one that is certainly there. The two generated ones follow as URLs:
 * nothing is fetched until a reader selects one (§24.2), which is what keeps
 * "open the viewer" from being a third-party request.
 */
export function builtinHubs(): HubRef[] {
  return [
    { id: 'demos', label: 'Demos', hub: demosHub(), builtin: true },
    { id: '4dn', label: '4DN open data', url: `${hubsBase()}4dn.json`, builtin: true },
    { id: 'encode', label: 'ENCODE Hi-C', url: `${hubsBase()}encode.json`, builtin: true },
  ]
}

// ---------------------------------------------------------------------------
// Shelves a hub brought with it
// ---------------------------------------------------------------------------

/**
 * The tracks a hub row named, held until the file it belongs to is opened.
 *
 * A hub entry may carry `tracks` — the bigWigs the same experiment published
 * beside the map (§24.1) — and they are the same *offer* the demo map's ten
 * annotations are: here is a set of tracks to look at, for a reader who has
 * none. So they are answered through the same question rather than a second
 * one, and `Session` needs no idea that a hub exists.
 *
 * In memory and never in storage, deliberately. The offer is about the file
 * being opened right now; a shelf that outlived the tab would be a promise to
 * fetch URLs out of a catalogue the reader has since forgotten.
 */
const shelves = new Map<string, DemoAnnotationLink[]>()

/**
 * Remember the tracks published beside `uri`, so the Tracks card can offer them.
 *
 * Keyed on the **absolute URI's file half**, so it answers for the same file
 * opened at an entry (`file.mcool::resolutions/1000`) as for the file itself —
 * which is the common case rather than the exotic one, since a collection
 * opened at its root lands on one of its entries and the URI the session ends
 * up on is not the one the hub row carried.
 *
 * Last registration wins: two hubs naming the same map is not a conflict worth
 * a policy, and the one the reader has just clicked is the one they mean.
 */
export function registerShelf(
  uri: string,
  tracks: ReadonlyArray<{ label: string; url: string }>,
): void {
  const key = splitUri(uri).path
  if (key === '') return
  if (tracks.length === 0) {
    shelves.delete(key)
    return
  }
  shelves.set(
    key,
    tracks.map((track) => ({
      // The file name is what a track row falls back to when it has no label,
      // and what `demo-examples.test.ts` checks the published set against;
      // derived here rather than asked for, since a hub carries a label and a
      // URL and nothing in between.
      file: track.url.split('?')[0].split('#')[0].split('/').pop() ?? track.url,
      label: track.label,
      url: track.url,
    })),
  )
}

/** Forget every registered shelf. Tests only — the map is otherwise per page. */
export function clearShelves(): void {
  shelves.clear()
}
