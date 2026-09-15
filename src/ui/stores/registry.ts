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
import { RSG_MARK_IMAGE } from './rsg-mark.generated'
import { STORE_LOGOS } from './logos.generated'
import { rememberedStores } from '../../state/stores'
import type { StoreRef } from '../../state/store'
import { HOMEPAGE } from '../../version'
import { SITE_BASE } from '../../versions'

/** Which page draws a store. */
export type StoreFrontKind = 'gallery' | 'genomes' | 'portal' | 'custom'

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
   * Set for all four shipped stores, and from two places. RSG's is *drawn*,
   * the lab's own mark being the lab's to draw: a Hi-C map whose diagonal
   * spells it (`scripts/make-rsg-mark.mjs`). The other three are the projects'
   * own published logos, carried here because this viewer was given them to
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
  /** One line under the tile and under the drawer's heading. */
  blurb: string
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
  igv: '#2f6fb5',
  fourdn: '#1f8a70',
  encode: '#5a4fa2',
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

/** The four stores this build ships, in the order the tiles offer them. */
export function builtinStores(): StoreFront[] {
  const base = storesBase()
  return [
    {
      id: 'rsg',
      label: 'RSG lab data',
      blurb: 'Composed figures over the lab’s published yeast and metagenome data, one click each.',
      kind: 'gallery',
      mark: { text: 'RSG', colour: COLOURS.rsg, image: RSG_MARK_IMAGE },
      builtin: true,
      // Inline: the one store that costs no request and is certainly there.
      rows: { id: 'rsg', label: 'RSG lab data', inline: demosStore(), builtin: true },
      group: 'assembly',
    },
    {
      id: 'igv',
      label: 'IGV genomes',
      blurb: 'IGV’s reference genomes, each with the tracks it ships, ready for the 1D browser.',
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
    },
    {
      id: '4dn',
      label: '4DN open data',
      blurb: 'Every file on the 4DN open-data bucket, by cell line, assay, lab and experiment set.',
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
    },
    {
      id: 'encode',
      label: 'ENCODE',
      blurb: 'ENCODE’s released signal, peaks and alignments, one file per experiment, by assembly.',
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
    },
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
    label: 'Your own store',
    blurb: 'A store file a lab published beside its data — paste its URL.',
    kind: 'custom',
    mark: { text: '+', colour: COLOURS.custom },
    builtin: false,
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

/** Every store the drawer offers: the four shipped ones, then those the reader connected. */
export function storeFronts(): StoreFront[] {
  return [
    ...builtinStores(),
    ...rememberedStores().map(
      (ref): StoreFront => ({
        id: ref.id,
        label: ref.label,
        blurb: ref.url ?? '',
        kind: 'custom',
        mark: { text: initialsOf(ref.label), colour: COLOURS.custom },
        builtin: false,
        rows: ref,
      }),
    ),
  ]
}

/** The front with this id, the custom one for `'custom'`, or `null`. */
export function frontById(id: string): StoreFront | null {
  if (id === 'custom') return customStore()
  return storeFronts().find((front) => front.id === id) ?? null
}
