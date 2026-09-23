/**
 * The stores this build offers, and what each one is made of.
 *
 * A **store** is somebody's shelf of data: a catalogue this viewer can draw as
 * a page of its own, with the files, sessions and metadata behind it
 * (`state/store.ts` owns the file format). This module is the list of them —
 * the four the app ships and every one the reader has connected by URL — and
 * says, for each, which *front* draws it. The fronts differ on purpose (§24.2):
 * a lab's shelf of composed figures is a gallery, IGV's is a list of genomes,
 * and the two portals are catalogues to be narrowed, which is why one table for
 * all of them was the wrong shape and is gone.
 *
 * ## Nothing here fetches anything
 *
 * A front is a description: a label, a mark, and the URLs of the files behind
 * it. Opening a store in the drawer is the gesture that reads them (§24.2), so
 * the tiles on the landing page cost no request — which is what keeps *open
 * the viewer* from being a third-party request, as it has been since the demos
 * were a dropdown.
 *
 * ## Where the shipped stores are read from
 *
 * The site's own `stores/` directory. `.github/workflows/stores.yml` writes
 * them to the `stores` branch, and `deploy.yml` copies the current files from
 * that branch into `stores/` beside the app on every deploy — which the stores
 * workflow asks for as soon as it has published, so a fresh store is on the site
 * minutes later with no push to `main` (§24.3). Same origin as the page, so no
 * CORS enters into it; an archived build or a preview reaches up to the site
 * root through `SITE_BASE`. A build with no site to be relative to — the
 * desktop's `app://viewer`, a standalone file — reads the deployed site by
 * `package.json`'s `homepage`, which GitHub Pages serves with
 * `Access-Control-Allow-Origin: *`.
 *
 * **Every generated store answers 404 until `stores.yml` has run once**, which
 * is a state rather than a failure and the reason `fetchStore` tells 404 apart
 * from every other answer: the front says *not generated yet* and names the
 * workflow.
 */

import { demosStore } from '../examples'
import { DBZ_MARK_IMAGE } from './dbz-mark.generated'
import { RSG_MARK_IMAGE } from './rsg-mark.generated'
import { STORE_LOGOS } from './logos.generated'
import { rememberedStores } from '../../state/stores'
import { looksLikeHubUrl } from '../../state/hub'
import type { StoreRef } from '../../state/store'
import { HOMEPAGE } from '../../version'
import { SITE_BASE } from '../../versions'

/** Which page draws a store. */
/**
 * Which page draws a store.
 *
 * `hub` is a `custom` in everything but its wording: the same URL box, the same
 * portal behind it, the same *remember this store*. It is a kind of its own
 * because what a reader needs to be told at the box differs completely — one
 * asks for a JSON file a lab wrote for this viewer, the other for a `hub.txt`
 * that already exists and was written for somebody else — and a door whose help
 * text is right for only half its visitors is a door most of them walk past.
 */
export type StoreFrontKind = 'gallery' | 'genomes' | 'portal' | 'custom' | 'hub'

/** The tile's mark: a short word in a colour, and an image to prefer when there is one. */
export interface StoreMark {
  /** Two to six letters, set large. */
  text: string
  /** Two or three letters for the small tiles, where six would be unreadable. */
  short?: string
  /** A CSS colour the tile is painted in. */
  colour: string
  /**
   * An image to draw over the letters.
   *
   * Set for every shipped store, and from two places. The lab's two are
   * *drawn*, the lab's own marks being the lab's to draw: a Hi-C map whose
   * diagonal spells *RSG*, and a bacterial one — circular, its arms zipped into
   * an X — whose diagonal spells *DBZ* (`scripts/make-rsg-mark.mjs`). The
   * others are the projects' own published logos, carried here because this viewer was given them to
   * carry, and fitted to a square by `scripts/make-store-logos.mjs`. The icon
   * pipeline's rule holds over both — a brand mark is the published one or
   * nothing (`scripts/build-icons.mjs`) — and is why not one of the three is
   * an approximation of itself.
   *
   * A store connected by URL has none and stays a lettermark. A URL here is
   * drawn as an `<img>` with the letters behind it, which is what `text` and
   * `colour` go on doing for a store that has an image: they are what shows
   * while it loads, and what is left if it fails.
   */
  image?: string
}

/** One of the two facets that choose an ENCODE shard. */
export interface ShardFacet {
  key: string
  label: string
  values: ReadonlyArray<{ id: string; label: string }>
}

/**
 * A store as the drawer offers it.
 *
 * The rows come from one file or from several — ENCODE is 210,000 rows and is
 * published as twelve shards chosen by assembly and kind of file (§24.3) — and
 * may have a shelf of pre-configured sessions beside them. `group` names the
 * column the portal fronts fold rows under and match a session to, so that a
 * 4DN experiment set is one heading with its files under it and *open with its
 * tracks* on the heading.
 */
export interface StoreFront {
  /** `'rsg' | 'igv' | '4dn' | 'encode'` for the shipped ones, `'custom'` for the URL box, `'store:<n>'` for a remembered one. */
  id: string
  label: string
  /**
   * One line under the drawer's heading, where there is a column to say it in.
   */
  blurb: string
  /**
   * The tile's line, which is a different length of the same claim.
   *
   * A large tile is 10.5rem wide and gives its subtitle two lines at
   * `--step--2` — about fifty characters. Every `blurb` here is longer than
   * that, so the tile either clipped one mid-word or grew a third line and
   * pushed the row below it off the screen. Neither is a subtitle. Written out
   * rather than derived, because the first fifty characters of a sentence are
   * not a shorter sentence: *Every file on the 4DN open-data bucket, by cell
   * line…* is a truncation and *Every 4DN file, by cell line and assay.* is a
   * line. Absent falls back to the blurb, which is what a remembered store
   * does before `storeTiles` shortens its URL to a host.
   */
  tagline?: string
  kind: StoreFrontKind
  mark: StoreMark
  builtin: boolean
  /** The rows, as one file. */
  rows?: StoreRef
  /** Or as several, one per pair of shard values. */
  shards?: {
    facets: readonly [ShardFacet, ShardFacet]
    url(first: string, second: string): string
  }
  /** The pre-configured sessions published beside the rows, if any. */
  sessions?: StoreRef
  /** The column rows are grouped under and a session's `dataset` field names. */
  group?: string
  /** The columns whose values a group's heading repeats, in order. */
  headline?: readonly string[]
  /** The two facets a matrix opens on. */
  axes?: readonly [string, string]
  /**
   * Where this shelf comes from, on the web.
   *
   * A store is somebody else's data, and the row a reader is looking at is a
   * line in a catalogue this viewer translated — with none of the licence, the
   * citation, the release notes or the caveats that the people who made it
   * wrote down. The one honest thing to do about that is to say whose it is
   * and link to them, which is what the drawer's head does with this, beside
   * the download.
   */
  home?: string
}

/**
 * The colours the tiles are painted in, behind their marks.
 *
 * All four shipped stores now carry an image that covers the square, so what
 * these are is the ground beneath it: the square the letters are set on while
 * an image loads, and the whole of the tile if one ever fails to. Distinct, and
 * not anybody's brand — a fallback that imitated a logo would be the one thing
 * worse than a fallback that does not.
 */
const COLOURS = {
  rsg: '#c2652c',
  dbz: '#9a5b1e',
  igv: '#2f6fb5',
  fourdn: '#1f8a70',
  encode: '#5a4fa2',
  dnazoo: '#a8326a',
  // UCSC's own two, from the mark: the yellow frame over the navy the helix
  // and the wordmark are drawn in. It is the ground under the hub door's logo
  // and under Roadmap's, which is a UCSC hub.
  ucsc: '#1c3b6e',
  custom: '#5b6169',
} as const

/**
 * Where the generated stores are read from: the site's own `stores/`.
 *
 * See the module header for why it is the site and not the branch, and why a
 * build with no site reads the deployed one by its homepage.
 */
export function storesBase(): string {
  const onSite = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
  if (onSite) {
    try {
      return `${new URL(SITE_BASE, window.location.href).href}stores/`
    } catch {
      // Fall through to the deployed site: a base that does not resolve is not
      // a site this page is on.
    }
  }
  return `${HOMEPAGE}stores/`
}

/**
 * ENCODE's two shard facets, as the generator writes them (`scripts/make_store.py`).
 *
 * **These have to agree with the generator's shard list**, and
 * `test/dom/builtin-stores.test.ts` checks that they do: a name that drifted
 * would be a shelf answering 404 for a file that exists under another name,
 * which the front reports as *not generated yet* — the one failure that looks
 * like a normal state. Enumerated rather than discovered because §24.2 is not
 * negotiable: nothing may fetch an index on load to find out what exists.
 */
export const ENCODE_FACETS: readonly [ShardFacet, ShardFacet] = [
  {
    key: 'group',
    label: 'Genome',
    values: [
      { id: 'GRCh38', label: 'GRCh38' },
      { id: 'hg19', label: 'hg19' },
      { id: 'mm10', label: 'mouse' },
      { id: 'other', label: 'other assemblies' },
    ],
  },
  {
    key: 'category',
    label: 'Files',
    values: [
      { id: 'signal', label: 'signal' },
      { id: 'annotation', label: 'peaks and annotations' },
      { id: 'alignment', label: 'alignments' },
    ],
  },
]

/** Every ENCODE shard id, in the generator's order — `GRCh38-signal` and its eleven siblings. */
export function encodeShards(): string[] {
  return ENCODE_FACETS[0].values.flatMap((assembly) =>
    ENCODE_FACETS[1].values.map((category) => `${assembly.id}-${category.id}`),
  )
}

/**
 * Roadmap Epigenomics, as the track hub WashU publishes it (§24.10).
 *
 * The first shipped store that is **somebody else's hub rather than a file this
 * project generated**, and it is here to make the point that those are the same
 * thing now: no shard list, no workflow, no `stores/` entry — a `hub.txt` URL
 * and the grouping a hub always has, read by the same `fetchStore` every other
 * store URL goes through. The 111 reference epigenomes are the obvious first
 * one to ship, being the set most often wanted next to somebody's own data.
 *
 * Its rows are read from WashU on the gesture that opens it and not before, as
 * every store's are (§24.2), so the tile costs nothing to offer. If that host
 * will not allow a cross-origin GET the front says so in the ordinary way —
 * which is the same sentence any hub gets, and the reason there is nothing
 * special to write here for it.
 */
const ROADMAP: StoreFront = {
  id: 'roadmap',
  label: 'Roadmap (UCSC hub)',
  blurb: 'The Roadmap Epigenomics integrative tracks, as the hub WashU publishes them.',
  tagline: 'Roadmap Epigenomics, as WashU publishes it.',
  kind: 'portal',
  // Roadmap's own emblem, cropped from a logo five times as wide as it is tall
  // (`scripts/make-store-logos.mjs`). The colour under it is UCSC's, which is
  // what shows if the image ever fails and is the truer fallback of the two:
  // what this is *is* a UCSC hub.
  mark: { text: 'ROAD', short: 'RME', colour: COLOURS.ucsc, image: STORE_LOGOS.roadmap },
  builtin: true,
  rows: {
    id: 'roadmap',
    label: 'Roadmap (UCSC hub)',
    url: 'https://vizhub.wustl.edu/VizHub/RoadmapIntegrative.txt',
    builtin: true,
  },
  // A hub's own grouping, which `hubStore` writes and which is the same here as
  // it is for a hub the reader pastes: by assembly, with the genome's name on
  // the heading and the hub's composites as the facet worth narrowing by.
  group: 'assembly',
  headline: ['genome'],
  axes: ['format', 'group'],
  home: 'https://egg2.wustl.edu/roadmap/web_portal/',
}

/**
 * The DNA Bacterial Zoo: the lab's Hi-C maps of bacteria, one card a species
 * (§24.3).
 *
 * The one shipped store the Stores workflow does not write. Its rows are the
 * lab's own analyses — `hic-suite.sh` over each map, gathered by
 * `scripts/DBZ_store.py` into a folder whose names are all relative — so the
 * store lives **beside its data** on the lab's bucket, next to the demo files
 * (`DEMO_BUCKET` in `ui/examples.ts`), and is read from there on the gesture
 * that opens it. There is nothing for a workflow to regenerate: it changes when
 * the lab reruns the suite and uploads the folder again.
 */
export const DBZ_STORE = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.json'

/** The stores this build ships, in the order the tiles offer them. */
export function builtinStores(): StoreFront[] {
  const base = storesBase()
  return [
    {
      id: 'rsg',
      label: 'RSG lab data',
      blurb: 'Composed figures over the lab’s published yeast and metagenome data, one click each.',
      tagline: 'The lab’s published figures, one click each.',
      kind: 'gallery',
      mark: { text: 'RSG', colour: COLOURS.rsg, image: RSG_MARK_IMAGE },
      builtin: true,
      // Inline: the one store that costs no request and is certainly there.
      rows: { id: 'rsg', label: 'RSG lab data', inline: demosStore(), builtin: true },
      group: 'assembly',
      home: 'https://research.pasteur.fr/fr/team/spatial-regulation-of-genomes/',
    },
    {
      id: 'dbz',
      label: 'DNA Bacterial Zoo',
      blurb: 'The lab’s Hi-C maps of bacteria, one card a species: its map, its tracks, and a session opening both.',
      tagline: 'Bacterial Hi-C maps, one card a species.',
      // IGV's cards, from one file rather than two: the sessions are rows of
      // the store itself, so there is no `sessions` here, and that is what tells
      // `GenomesView` which of its two roads to take.
      kind: 'genomes',
      mark: { text: 'DBZ', colour: COLOURS.dbz, image: DBZ_MARK_IMAGE },
      builtin: true,
      rows: {
        id: 'dbz',
        label: 'DNA Bacterial Zoo',
        url: DBZ_STORE,
        builtin: true,
        publishedBy:
          'scripts/DBZ_store.py builds it from the lab’s Hi-C results, and the folder it writes is uploaded to s3://rsglab-data/dbz/',
      },
      group: 'species',
      // The sample a card is, and how many replicons its genome has.
      headline: ['id', 'sequences'],
      home: 'https://research.pasteur.fr/fr/team/spatial-regulation-of-genomes/',
    },
    {
      id: 'igv',
      label: 'IGV genomes',
      blurb: 'IGV’s reference genomes, each with the tracks it ships, ready for the 1D browser.',
      tagline: 'Reference genomes with the tracks they ship.',
      kind: 'genomes',
      mark: { text: 'IGV', colour: COLOURS.igv, image: STORE_LOGOS.igv },
      builtin: true,
      rows: { id: 'igv', label: 'IGV genomes', url: `${base}igv.json`, builtin: true },
      sessions: {
        id: 'igv-sessions',
        label: 'IGV genome sessions',
        url: `${base}igv-sessions.json`,
        builtin: true,
      },
      group: 'assembly',
      home: 'https://igv.org/doc/desktop/#FileFormats/Genomes',
    },
    {
      id: '4dn',
      label: '4DN open data',
      blurb: 'Every file on the 4DN open-data bucket, by cell line, assay, lab and experiment set.',
      tagline: 'Every 4DN file, by cell line and assay.',
      kind: 'portal',
      mark: { text: '4DN', colour: COLOURS.fourdn, image: STORE_LOGOS.fourdn },
      builtin: true,
      rows: { id: '4dn', label: '4DN open data', url: `${base}4dn.json`, builtin: true },
      sessions: {
        id: '4dn-sessions',
        label: '4DN experiment sets, with their tracks',
        url: `${base}4dn-sessions.json`,
        builtin: true,
      },
      group: 'set',
      headline: ['dataset', 'biosource', 'assay'],
      axes: ['assay', 'biosource'],
      home: 'https://data.4dnucleome.org/',
    },
    {
      id: 'encode',
      label: 'ENCODE',
      blurb: 'ENCODE’s released signal, peaks and alignments, one file per experiment, by assembly.',
      tagline: 'Signal, peaks and alignments by assembly.',
      kind: 'portal',
      mark: { text: 'ENCODE', short: 'ENC', colour: COLOURS.encode, image: STORE_LOGOS.encode },
      builtin: true,
      shards: {
        facets: ENCODE_FACETS,
        url: (group, category) => `${base}encode-${group}-${category}.json`,
      },
      sessions: {
        id: 'encode-sessions',
        label: 'ENCODE datasets, with their tracks',
        url: `${base}encode-sessions.json`,
        builtin: true,
      },
      group: 'dataset',
      headline: ['biosample', 'assay', 'target'],
      axes: ['assay', 'biosample'],
      home: 'https://www.encodeproject.org/matrix/?type=Experiment',
    },
    {
      id: 'dnazoo',
      label: 'DNA Zoo',
      blurb: 'Chromosome-length genome assemblies and the Hi-C maps behind them, a directory a species.',
      tagline: 'Chromosome-length assemblies and their maps.',
      kind: 'portal',
      // `DNA` behind the logo, not `DNAZOO`: the ladder in `ui/stores/marks.ts`
      // is tuned so that six letters just fill the square, and it was tuned
      // against *ENCODE* — measured in a browser, `DNAZOO` wants 74 pixels of
      // the 72 there are, its letters being the wide ones. There is no
      // conventional short form of this name to reach for instead, so the
      // fallback is the first of its two words, which is what `initialsOf`
      // does with a one-word label.
      mark: { text: 'DNA', colour: COLOURS.dnazoo, image: STORE_LOGOS.dnazoo },
      builtin: true,
      rows: { id: 'dnazoo', label: 'DNA Zoo', url: `${base}dnazoo.json`, builtin: true },
      // A species, which is what a directory on that bucket is — and the
      // heading carries the common name beside it, because *Asian
      // small-clawed otter* is how anybody but its authors looks for
      // `Aonyx_cinereus`.
      group: 'species',
      headline: ['common'],
      // Both of these are short lists where the species column is hundreds
      // long: which of a species' two assemblies a file belongs to, against
      // what kind of file it is.
      axes: ['assembly', 'format'],
      home: 'https://www.dnazoo.org/',
    },
    ROADMAP,
  ]
}

/**
 * The tile that adds a store: a URL box, and whatever it loads.
 *
 * A front with no rows, so the drawer draws the box; once a store has been
 * read from it and remembered, it comes back as a front of its own below.
 */
export function customStore(): StoreFront {
  return {
    id: 'custom',
    label: 'Add a custom store',
    blurb: 'A store file a lab published beside its data — paste its URL, or the config itself.',
    tagline: 'Paste a store file’s URL, or the file itself.',
    kind: 'custom',
    // This viewer's own icon, because the file behind this door is the one
    // format in the row that was written *for this viewer* — the others are
    // somebody else's index, read by translation. The `+` stays underneath as
    // the ground, which is what shows while the image loads and what is left
    // if it fails.
    mark: { text: '+', colour: COLOURS.custom, image: STORE_LOGOS.app },
    builtin: false,
  }
}

/**
 * The tile that opens a **UCSC track hub** (§24.10).
 *
 * Its own door rather than a line in the one above, and the argument is the
 * same one that gave the portals their own fronts: a hub is not a rarer kind of
 * store file, it is the format an enormous amount of published data is already
 * indexed by — every assembly hub, every paper that shipped its tracks, every
 * `genome browser` link in a supplementary table. A reader who has one does not
 * think of it as "a store"; they think of it as *the hub*, and a door that never
 * says the word is a door they will not try.
 *
 * Nothing behind it is hub-specific. `fetchStore` recognises a hub wherever a
 * store URL is read, so this tile is a URL box with the right sentence above it
 * — and a hub pasted into the *other* box works exactly as well.
 */
export function hubStoreFront(): StoreFront {
  return {
    id: 'hub',
    label: 'Connect to a UCSC hub',
    blurb: 'Any UCSC track hub — paste its hub.txt and its genomes and tracks become a store.',
    tagline: 'Paste a hub.txt; its tracks become a store.',
    kind: 'hub',
    mark: { text: 'HUB', colour: COLOURS.ucsc, image: STORE_LOGOS.ucsc },
    builtin: false,
    // Not a hub, but where hubs are: UCSC's own connect page, which is the
    // list a reader without one in hand goes to find one.
    home: 'https://genome-euro.ucsc.edu/cgi-bin/hgHubConnect',
    // A hub's rows are grouped by **assembly**, because that is what a hub is: a
    // set of tracks per genome. The heading then carries the genome's own name
    // and *open with its tracks*, which the assembly's sequence row supplies
    // (`ui/stores/ResultList.ts`) — so a hub's page reads like the portals'
    // without a session file existing anywhere.
    group: 'assembly',
    headline: ['genome'],
    // What a hub is worth crossing: which kind of file against which part of the
    // hub's own grouping. The two columns whose values a hub actually varies.
    axes: ['format', 'group'],
  }
}

/** Two or three letters for a remembered store's tile, out of its label. */
export function initialsOf(label: string): string {
  const words = label.split(/[\s_-]+/).filter((word) => /^[A-Za-z0-9]/.test(word))
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}

/** Every store the drawer offers: the shipped ones, then those the reader connected. */
export function storeFronts(): StoreFront[] {
  return [
    ...builtinStores(),
    ...rememberedStores().map((ref): StoreFront => {
      // A remembered hub keeps the hub mark and colour, so a row of tiles says
      // which of a reader's shelves are hubs and which are store files. Judged
      // by the URL, which is all there is to judge by before anything is
      // fetched — and the convention that makes `hub.txt` a name is exactly why
      // that is enough here, where `fetchStore` still decides by content.
      const hub = ref.url !== undefined && looksLikeHubUrl(ref.url)
      return {
        id: ref.id,
        label: ref.label,
        blurb: ref.url ?? '',
        kind: 'custom',
        // No `short`: `HUB` is already three letters, so it is legible on the
        // small tiles in the drawer's head — and the whole value of the mark is
        // that it says the same word at both sizes.
        mark: hub
          ? { text: 'HUB', colour: COLOURS.ucsc, image: STORE_LOGOS.ucsc }
          : { text: initialsOf(ref.label), colour: COLOURS.custom },
        builtin: false,
        rows: ref,
        // …and a remembered hub keeps the hub's page as well as its mark: the
        // grouping is a fact about the rows, so it cannot be left behind on the
        // door the reader happened to arrive through.
        ...(hub ? { group: 'assembly', headline: ['genome'], axes: ['format', 'group'] as const } : {}),
      }
    }),
  ]
}

/** The front with this id, the two doors for their own ids, or `null`. */
export function frontById(id: string): StoreFront | null {
  if (id === 'custom') return customStore()
  if (id === 'hub') return hubStoreFront()
  return storeFronts().find((front) => front.id === id) ?? null
}
