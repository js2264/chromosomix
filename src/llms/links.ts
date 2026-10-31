/**
 * `llms/links.md`: every view is a URL, and this is the grammar of one.
 *
 * The page a model reads before it writes a link to somebody's file. It is the
 * part of the app a model acts on most — a link is a thing it can hand a reader
 * with no install on either side — and the part where a mistake is quietest:
 * the hash reader drops what it cannot read (§5.5), so a misspelt key opens a
 * picture that is merely not the one asked for.
 *
 * So the keys are written here once, beside the reader's own list
 * (`state/ViewState.ts`'s `KEY_ORDER`), and the test holds the two to each
 * other in both directions: no key documented that the reader does not take,
 * none taken that the page leaves out but those of the multi-genome format,
 * which is a dev feature (§29.5) and is named nowhere a reader without the
 * switch can see. Every value list that the app keeps as a list — views,
 * transforms, colour maps, comparisons, smoothings — is read from that list.
 */

import { COLORMAP_NAMES } from '../render/colormaps'
import { COMPARE_OPS } from '../render/compare'
import { SMOOTH_CHOICES } from '../render/smooth'
import { TRANSFORMS } from '../state/ViewState'
import type { ViewKind } from '../types'
import { block, code, either, page, SITE, table } from './markdown'

/** One key of the hash, as the page documents it. */
export interface LinkKey {
  key: string
  /** What it takes, as a reader would write it. */
  values: string
  meaning: string
}

/** The demo map every example opens: Micro-C of synthetic yeast chromosome IV. */
export const DEMO = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/'
const MAP = `${DEMO}Yeast_microC_G2M_1kb.cool`

/**
 * The views a link may open, and what each is. The multi-genome format's four
 * (`genomes`, `genome`, `pair`, `overview`) are a dev feature's and left out.
 */
export const LINK_VIEWS: ReadonlyArray<{ view: ViewKind; meaning: string }> = [
  { view: 'contigs', meaning: 'the table of the file’s sequences, with their lengths and contacts' },
  {
    view: 'whole',
    meaning:
      'the whole matrix, every sequence against every other. It reads the whole file, so it opens on a button ' +
      'that says what that costs, and draws once the reader presses it',
  },
  { view: 'region', meaning: 'a block of the map, named by `region` (and `region2` for an off-diagonal one)' },
  { view: 'selection', meaning: 'several sequences side by side, named by `regions`' },
  { view: 'browser', meaning: 'the 1D genome browser over the file’s assembly, at `locus`' },
  { view: 'cells', meaning: 'the table of an `.scool`’s cells, to pick the ones summed into the map' },
]

/** Keys the reader takes that this page does not name: the multi-genome format's (§29). */
export const UNDOCUMENTED_KEYS: readonly string[] = ['genome', 'genome2', 'genomes']

const SMOOTHS = SMOOTH_CHOICES.map((choice) => choice.id)

/** Every key, in the order the app writes them. */
export const LINK_KEYS: readonly LinkKey[] = [
  {
    key: 'uri',
    values: 'an address',
    meaning:
      '**Required.** The file: a contact map (`.cool`, `.mcool`, `.hic`, `.scool`), or a reference or track ' +
      '(a FASTA, a `.2bit`, a bigWig…), which opens the 1D browser over its assembly. `https://`, `s3://`, ' +
      '`gs://` and Dropbox or Google Drive share links all work. For one resolution of a multi-resolution ' +
      'file, append `::/resolutions/<bin size>`: `sample.mcool::/resolutions/10000`.',
  },
  {
    key: 'uri2',
    values: 'an address',
    meaning:
      'A second map on the same bins, drawn in the lower triangle of the same square. `op` says how the two ' +
      'are put together.',
  },
  {
    key: 'maps',
    values: 'addresses joined by `|`',
    meaning:
      'More cells beside the first map, as a deck panned and zoomed together. A member is a map’s address, ' +
      '`3d` for the session’s 3D model, `tracks` for its tracks on their own, or `~` for a local file that ' +
      'a link cannot carry.',
  },
  {
    key: 'view',
    values: either(LINK_VIEWS.map((entry) => entry.view)),
    meaning: 'What is shown (see the table below). A value it does not know opens the file’s table.',
  },
  {
    key: 'region',
    values: '`<sequence>` or `<sequence>:<start>-<end>`, machine form',
    meaning: 'The block a `region` view reads: its rows, and its columns too unless `region2` is given.',
  },
  {
    key: 'region2',
    values: 'as `region`',
    meaning: 'The columns of an off-diagonal block: the contacts between `region` and this.',
  },
  {
    key: 'focus',
    values: '`<sequence>:<start>-<end>`, machine form',
    meaning:
      'A window inside `region` that the map opens zoomed to, with the rest of the block still there to pan ' +
      'into. Applied once, on opening; it does not follow the reader.',
  },
  {
    key: 'regions',
    values: 'sequence names joined by `,`',
    meaning: 'The sequences of a `selection` view.',
  },
  {
    key: 'cells',
    values: 'cell names joined by `,`, or `*`',
    meaning: 'The cells of an `.scool` summed into the map, in file order; `*` is every cell, the default.',
  },
  {
    key: 'contacts',
    values: 'a whole number',
    meaning:
      'Every map drawn to this many contacts before it is shown or analysed: an exact subsample below the ' +
      'file’s own total, an oversample through Boost-HiC above it, with a fixed seed.',
  },
  {
    key: 'locus',
    values: '`<sequence>:<start>-<end>`, display form',
    meaning: 'The window of the 1D browser (`view=browser`). Absent is the whole genome.',
  },
  {
    key: 'level',
    values: either(['bin', 'contig']),
    meaning: 'What one row of the matrix is: a bin (the default), or a whole sequence summed into one cell.',
  },
  {
    key: 'coarsen',
    values: 'a bin size in bp',
    meaning:
      'A resolution the file does not store, a whole multiple of the one `uri` names: the stored bins are ' +
      'summed as they are read. A value the file cannot reach is ignored.',
  },
  {
    key: 'transform',
    values: either(TRANSFORMS),
    meaning: 'How values are mapped to colour.',
  },
  {
    key: 'colormap',
    values: either(COLORMAP_NAMES),
    meaning: '`RdBu_r`, `BuWtRd` and `seismic` are diverging, for a ratio or an observed over expected.',
  },
  {
    key: 'vmin',
    values: 'a number',
    meaning:
      'The bottom of the colour scale, in transformed units (`-1` under `log10` is 0.1). Absent is automatic. ' +
      'Not applied to a ratio — `oe`, or `op=ratio` or `difference` — whose scale opens centred on no change.',
  },
  {
    key: 'vmax',
    values: 'a number',
    meaning: 'The top of the colour scale, in transformed units. Absent is automatic; the two are independent.',
  },
  {
    key: 'balance',
    values: either(['true', 'false']),
    meaning: 'Balanced values, with the weights the file carries, or raw counts.',
  },
  {
    key: 'score',
    values: `${either(['count', 'balanced', 'vc', 'vcsqrt', 'ice', 'baseline', 'correlation'])}, or a column of the file`,
    meaning:
      'What each cell is drawn from: the raw counts, the balanced counts, a normalisation computed on the fly ' +
      '(VC, square-root VC, ICE), the expected count at that distance, the Pearson correlation of the ' +
      'observed over expected (on a balanced file), or another column of the file’s pixel table. Overrides ' +
      '`balance`. A value the file cannot answer falls back to the counts.',
  },
  {
    key: 'oe',
    values: either(['true', 'false']),
    meaning: 'Observed over expected: each cell divided by what its distance from the diagonal predicts.',
  },
  {
    key: 'arms',
    values: 'a whole number of bins, `0` for all',
    meaning:
      'With `oe=true`, on a circular bacterial chromosome whose origin is set: the expected is read along ' +
      'both arms, within this many bins, rather than along the diagonal alone.',
  },
  {
    key: 'smooth',
    values: either(SMOOTHS),
    meaning:
      'Despeckling: `0` is off, a number is a fixed radius (`1` is 3 × 3), `a50` grows a window per cell until ' +
      'it holds enough contacts.',
  },
  {
    key: 'op',
    values: either(COMPARE_OPS),
    meaning:
      'With `uri2`: the two files on either side of the diagonal (`split`), or one derived map over the whole ' +
      'square, their `ratio` or their `difference`.',
  },
  {
    key: 'flip',
    values: either(['true', 'false']),
    meaning: 'Turn a map of one sequence 45°: position along the bottom, distance from the diagonal up the side.',
  },
  {
    key: 'lower',
    values: either(['true', 'false']),
    meaning:
      'Draw the lower triangle in a reading of its own, set by the six keys below; ignored with `uri2` or ' +
      '`maps`.',
  },
  { key: 'score2', values: 'as `score`', meaning: 'The lower triangle’s `score`.' },
  { key: 'oe2', values: 'as `oe`', meaning: 'The lower triangle’s `oe`.' },
  { key: 'smooth2', values: 'as `smooth`', meaning: 'The lower triangle’s `smooth`.' },
  { key: 'transform2', values: 'as `transform`', meaning: 'The lower triangle’s `transform`.' },
  { key: 'colormap2', values: 'as `colormap`', meaning: 'The lower triangle’s `colormap`.' },
  { key: 'vmin2', values: 'a number', meaning: 'The lower triangle’s `vmin`.' },
  { key: 'vmax2', values: 'a number', meaning: 'The lower triangle’s `vmax`.' },
]

/** The example links, each with what it shows. The test opens every one through the hash reader. */
export const LINK_EXAMPLES: ReadonlyArray<{ what: string; link: string }> = [
  {
    what: 'A window of chromosome IV, balanced, on a log scale',
    link: `${SITE}#uri=${MAP}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`,
  },
  {
    what: 'The same window as observed over expected, on a diverging colour map',
    link: `${SITE}#uri=${MAP}&view=region&region=IV:1000000-1400000&balance=true&oe=true&transform=log2&colormap=RdBu_r`,
  },
  {
    what: 'The same window, its colour scale clipped to 10⁻³–10⁻¹·⁵',
    link: `${SITE}#uri=${MAP}&view=region&region=IV:1000000-1400000&transform=log10&balance=true&vmin=-3&vmax=-1.5`,
  },
  {
    what: 'All of chromosome IV read, opened zoomed to 100 kb of it',
    link: `${SITE}#uri=${MAP}&view=region&region=IV&focus=IV:1150000-1250000&transform=log10&balance=true`,
  },
  {
    what: 'The whole genome, every chromosome against every other — once the reader agrees to read it all',
    link: `${SITE}#uri=${MAP}&view=whole&transform=log10&balance=true`,
  },
  {
    what: 'The contacts between two chromosomes',
    link: `${SITE}#uri=${MAP}&view=region&region=IV&region2=XII&transform=log10&balance=true`,
  },
  {
    what: 'The 1D browser over an ATAC-seq bigWig, at a locus',
    link: `${SITE}#uri=${DEMO}Yeast_ATAC.bw&view=browser&locus=IV:1,150,001-1,250,000`,
  },
]

export function linksPage(): string {
  return page([
    '# chromosomix links: a view as a URL',
    '> Every view in chromosomix is a URL, and a link is the simplest way to show somebody a file at a ' +
      'place: no install, no upload, no account at either end. This page is the grammar — the keys of the ' +
      'fragment and the values each takes, the two forms of a coordinate, and the query parameters that ' +
      'mount the app differently. A link written to it opens in the web app, in a pinned release, in an ' +
      'embed and in the notebook widgets alike.',
    '## The shape',
    block(`${SITE}[?<query>]#<key>=<value>&<key>=<value>…`),
    [
      '- The view is in the fragment, after `#`: `key=value` pairs joined by `&`. Each value is ' +
        'percent-encoded as `encodeURIComponent` does it; `/`, `:`, `,` and `|` may be left as they are, `&` ' +
        'and `=` may not.',
      '- `uri` is required. A fragment without one is ignored and the app opens on its landing page.',
      '- Keys are case-sensitive, and the app drops what it cannot read rather than refusing the link: a ' +
        '`view` it does not know opens the file’s table, and a `transform`, a `smooth` or a `vmin` it cannot ' +
        'read is left out. A misspelt key therefore does nothing at all — check each against the table below.',
      '- The fragment is never sent to a server. The reader’s browser reads the file, from where it is, by ' +
        'HTTP range requests; nothing is uploaded.',
      '- A link can only name a file the reader can reach: a public address, or one their own browser holds ' +
        'credentials for. A file on the sender’s disk cannot be linked to.',
    ].join('\n'),
    '## Coordinates',
    'A locus has two written forms, and the keys do not share one:',
    [
      '- **Machine form**, for `region`, `region2` and `focus`: cooler’s, 0-based and half-open, with no ' +
        'separators — `IV:1000000-1400000` is shown in the app as `IV:1,000,001-1,400,000`. A sequence name ' +
        'alone is the whole sequence.',
      '- **Display form**, for `locus`: 1-based and inclusive, as the app, IGV and UCSC print it — ' +
        '`IV:1,000,001-1,400,000`, digits grouped or not.',
      '- Write a sequence name as the file spells it: `chr4` for a file that says `chr4`, `4` for one that ' +
        'says `4`.',
    ].join('\n'),
    'The command line takes the display form everywhere (`--window`, `--anchor`): see the ' +
      `[command line](${SITE}llms/cli.md).`,
    '## The keys of the fragment',
    table(
      ['Key', 'Values', 'What it does'],
      LINK_KEYS.map((entry) => [code(entry.key), entry.values, entry.meaning]),
    ),
    '### Views',
    table(['`view`', 'What it opens'], LINK_VIEWS.map((entry) => [code(entry.view), entry.meaning])),
    '## Examples',
    'Micro-C of synthetic yeast chromosome IV, and its tracks, from the public demo bucket:',
    LINK_EXAMPLES.map((example) => `${example.what}:\n\n    ${example.link}`).join('\n\n'),
    '## The query: how the app is mounted',
    'The query string, before the `#`, changes what the page around the view is rather than what it shows:',
    table(
      ['Parameter', 'What it does'],
      [
        [
          '`embed=1`',
          'The bare view, for an `<iframe>`: no header, no tabs, the side panels folded. See ' +
            `[embedding](${SITE}llms/embed.md).`,
        ],
        [
          '`config=<URL>`',
          'Opens a saved workspace — a `.chromosomix.json`, every tab with its tracks, colours and marks — ' +
            'instead of one file. Names inside it resolve against its own URL. See ' +
            `[files and workspaces](${SITE}llms/data.md).`,
        ],
        [
          '`store=<id or URL>`',
          'Opens a data store’s catalogue over the page: a built-in one by its id, or a store file or a UCSC ' +
            '`hub.txt` by its address. `q=<text>` searches it, `<column>=<value>` ticks a facet, and ' +
            '`view=matrix&axes=<a>,<b>` shows it as a matrix of two columns.',
        ],
      ],
    ),
    'Examples:',
    [
      `    ${SITE}?embed=1#uri=${MAP}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`,
      `    ${SITE}?config=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/Yeast_microC.chromosomix.json`,
      `    ${SITE}?store=4dn&q=HCT116`,
    ].join('\n'),
    '## A link that never changes',
    `The root, ${SITE}, is the newest build, and changes with it. Every release is also kept for good at its own address, ` +
      `\`${SITE}v/<tag>/\` — \`${SITE}v/v0.13.0/\`, say — which takes the same query and fragment. A link in ` +
      'a paper, a figure legend or a notebook that must draw the same picture in five years should name ' +
      'one.',
    '## Writing a link from code',
    'Build the fragment from an object, encoding each value; this is what the app itself does:',
    block(
      [
        'const view = { uri: "https://example.org/sample.mcool::/resolutions/10000",',
        '               view: "region", region: "chr2:10000000-14000000", transform: "log10", balance: true }',
        'const hash = Object.entries(view)',
        '  .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)',
        '  .join("&")',
        `const link = "${SITE}#" + hash`,
      ].join('\n'),
      'js',
    ),
  ])
}
