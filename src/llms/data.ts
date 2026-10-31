/**
 * `llms/data.md`: what the app opens, where it can be opened from, and the two
 * JSON formats a lab writes by hand or by script — a store and a workspace.
 *
 * The built-in stores are read from the shelf (`ui/stores/registry.ts`), as the
 * landing page's tiles are, with the dev features off; the two examples are
 * held by the test to the parsers that read them (`parseStore`,
 * `parseWorkspaceFile`), so neither can drift from a shape the app accepts.
 */

import { builtinStores } from '../ui/stores/registry'
import { block, code, page, SITE, table } from './markdown'

/** A store file that the store parser takes. */
export const STORE_EXAMPLE = {
  kind: 'chromosomix.store',
  version: 1,
  name: 'My lab’s maps',
  description: 'Micro-C and ATAC-seq of yeast, by condition.',
  base: 'https://example.org/data/',
  columns: [
    { key: 'assay', label: 'Assay' },
    { key: 'condition', label: 'Condition' },
  ],
  entries: [
    {
      label: 'Micro-C, G2/M',
      uri: 'microC_G2M.mcool',
      kind: 'map',
      size: 1250000000,
      fields: { assay: 'Micro-C', condition: 'G2/M' },
      note: 'GEO GSE000000',
      tracks: [{ label: 'ATAC-seq', url: 'ATAC_G2M.bw' }],
    },
    {
      label: 'Micro-C with its tracks, as in the paper',
      uri: 'figure2.chromosomix.json',
      kind: 'workspace',
      fields: { assay: 'Micro-C', condition: 'G2/M' },
    },
  ],
}

/** The smallest workspace file there is: one tab, one view. */
export const WORKSPACE_EXAMPLE = {
  kind: 'chromosomix.workspace',
  version: 1,
  active: 0,
  tabs: [
    {
      name: 'Chromosome IV',
      state: {
        uri: 'Yeast_microC_G2M_1kb.cool',
        view: 'region',
        region: 'IV:1000000-1400000',
        transform: 'log10',
        balance: true,
      },
    },
  ],
}

/**
 * `value` as JSON, two spaces deep, with every array of plain values and every
 * object of them on one line — how a person writes a config, and half the
 * length of what `JSON.stringify` writes.
 */
export function json(value: unknown, depth = 0): string {
  const pad = '  '.repeat(depth + 1)
  const close = '  '.repeat(depth)
  const flat = (item: unknown): boolean => item === null || typeof item !== 'object'
  if (Array.isArray(value)) {
    if (value.every(flat)) return JSON.stringify(value).replace(/,/g, ', ')
    return `[\n${value.map((item) => `${pad}${json(item, depth + 1)}`).join(',\n')}\n${close}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (depth > 0 && entries.every(([, item]) => flat(item)) && entries.length <= 3) {
      return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')} }`
    }
    return `{\n${entries.map(([key, item]) => `${pad}${JSON.stringify(key)}: ${json(item, depth + 1)}`).join(',\n')}\n${close}}`
  }
  return JSON.stringify(value)
}

export function dataPage(): string {
  const stores = builtinStores()
  return page([
    '# chromosomix files, hosting, stores and workspaces',
    '> What chromosomix opens, and how: files are read where they are — on the reader’s disk, never ' +
      'uploaded, or from any host that serves byte ranges with CORS — in their own formats, with no ' +
      'preprocessing. This page lists the formats and the sidecars they read, what a host must serve, the ' +
      'built-in data stores, and the two JSON files a lab writes to publish its data: a store, which is a ' +
      'catalogue, and a workspace, which is a composed view.',
    '## Formats',
    table(
      ['What', 'Formats'],
      [
        [
          'Contact maps',
          '`.cool`, `.mcool` (every resolution), `.hic` (versions 7 to 9, every resolution), `.scool` (cells ' +
            'summed), HiC-Pro maps (the `.matrix` with its `_abs.bed`, gzipped or not), `.pairs` and ' +
            '`.pairs.gz` (binned on opening, at a resolution the reader picks)',
        ],
        [
          'Signal',
          'bigWig, bedGraph, wig, bedMethyl and bigMethyl, barChart and bigBarChart',
        ],
        [
          'Intervals and annotations',
          'BED, narrowPeak and broadPeak, bigBed, GTF and GFF3, genePred, refFlat and bigGenePred, VCF, ' +
            'cytoBand, splice junctions (STAR’s `SJ.out.tab`, junctions BED)',
        ],
        ['Interactions', 'BEDPE, `interact` and `bigInteract`, `longrange`'],
        ['Reads', 'BAM, with its `.bai` beside it'],
        ['Sequence', 'FASTA (read by range with its `.fai` beside it), `.2bit`, `chrom.sizes`'],
        ['3D models', 'g3d (text or binary), `.3dg`, bed3d, PDB'],
        ['Collections', 'a UCSC track hub (`hub.txt`), a store, a workspace (`.chromosomix.json`)'],
      ],
    ),
    [
      '- A bgzipped text file with its tabix index (`.tbi`) beside it is read by range; one without is read ' +
        'whole.',
      '- A file is told by its name first and its bytes second, so a `.txt` or `.tsv` of a known format ' +
        'opens too.',
      '- A container’s group follows `::`: `sample.mcool::/resolutions/10000`, `sample.hic::/resolutions/5000`.',
      '- A map opens as a map; any other file opens as a track over it, or — with no map — as a 1D genome ' +
        'browser over the assembly it declares.',
    ].join('\n'),
    '## Where files can be read from',
    [
      '- **The reader’s own disk**: dropped on the window, picked, or in a connected folder. Read in place by ' +
        'the browser; nothing leaves the machine. A link cannot name such a file, since only the reader has it.',
      '- **Any `https://` address** whose host serves byte ranges with CORS: S3, Google Cloud Storage, ' +
        'Cloudflare R2, Azure, and most static web servers. `s3://bucket/key` and `gs://bucket/key` are ' +
        'read as the public addresses they stand for.',
      '- **Dropbox and Google Drive share links**, and a private Drive or Dropbox the reader signs in to.',
      '- **A private bucket**, with a key the reader enters, kept in their browser.',
      '- **Not GEO or SRA**: their downloads serve no ranges and no CORS. Deposit there, and serve a copy ' +
        'from a bucket for viewing.',
    ].join('\n'),
    '### What a host must serve',
    table(
      ['Requirement', 'Why'],
      [
        ['`Accept-Ranges: bytes`', 'Every read is a byte range; without them a 4 kB lookup downloads the file.'],
        [
          'CORS allowing `GET` and `HEAD` and the `Range` request header, and exposing `Content-Length` and ' +
            '`Content-Range`',
          'The app runs on another origin than the data. The exposed headers are what is most often forgotten.',
        ],
        [
          'No `Content-Encoding`',
          'A range of a compressed response is a range of the compressed bytes. Serve `.gz` files as they are.',
        ],
        ['`Content-Type: application/octet-stream`', 'Keeps a CDN from sniffing and transforming the body.'],
      ],
    ),
    'An S3-compatible bucket’s CORS rule:',
    block(
      json([
        {
          AllowedOrigins: ['https://chromosomix.app'],
          AllowedMethods: ['GET', 'HEAD'],
          AllowedHeaders: ['Range', 'If-Match', 'If-None-Match'],
          ExposeHeaders: ['Content-Length', 'Content-Range', 'ETag', 'Accept-Ranges'],
          MaxAgeSeconds: 86400,
        },
      ]),
      'json',
    ),
    '`["*"]` as the origin suits released data and lets every copy of the viewer read it. A presigned URL ' +
      'opens and works until it expires, so it is for sharing today, not for a paper.',
    '## Data stores',
    'A store is a searchable catalogue of files, opened over the app from the landing page or by ' +
      `\`${SITE}?store=<id>\`, with \`&q=<text>\` to search it and \`&<column>=<value>\` to tick a facet. ` +
      'The built-in ones:',
    table(
      ['`?store=`', 'Store', 'What it holds'],
      stores.map((store) => [
        code(store.id),
        store.home === undefined ? store.label : `[${store.label}](${store.home})`,
        store.blurb,
      ]),
    ),
    `Any UCSC track hub is a store too: \`${SITE}?store=<address of hub.txt>\` opens its genomes and ` +
      'tracks. So is a store file of a lab’s own, by its address.',
    '### A store file',
    'A JSON file, on any host that serves CORS, listing files with enough about each to choose one without ' +
      'opening it. A `uri` resolves against `base`, or against the store’s own address when there is no ' +
      '`base`, so a store beside its data can be copied anywhere with it. An entry’s `kind` is `map`, ' +
      '`genome` (a track or reference) or `workspace`, and is read from the file name when left out; ' +
      '`tracks` are offered beside a map once it is open. Unknown keys are ignored. The repository’s ' +
      '`scripts/make_store.py bucket <address>` writes one from a bucket’s listing, and ' +
      '`make_store.py check <store.json>` validates one.',
    block(json(STORE_EXAMPLE), 'json'),
    '## Workspaces',
    'A workspace is every tab of a window in one file, `<name>.chromosomix.json`: each tab’s view, as the ' +
      'keys of a link, and everything a link cannot carry — its tracks with their colours, heights and ' +
      'groups, marks and bookmarks, the deck beside the map, the analyses it ran and their parameters. The ' +
      'app’s save button writes one. It opens by being dropped on the window, by ' +
      `\`${SITE}?config=<address>\`, or as a store entry, and \`chromosomix replay\` runs its analyses again ` +
      'over other files.',
    [
      '- A relative name inside one resolves against the workspace’s own address, so a workspace published ' +
        'beside its data is self-contained.',
      '- `state` takes the keys of a link (see the [links page](' + SITE + 'llms/links.md)), as JSON values.',
      '- Only `kind`, and a `state.uri` in each tab, are required; a missing field is a default, and a tab ' +
        'that cannot be read is dropped while the others open.',
      '- A track is best recorded by the app: open the files, arrange them, and save. To write one by script, ' +
        'start from a saved workspace — the yeast demo’s is ' +
        'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/Yeast_microC.chromosomix.json — ' +
        'and change its addresses.',
      '- In an embed or a widget, `chromosomix:add` puts tracks beside a view without a workspace (see ' +
        `[embedding](${SITE}llms/embed.md)).`,
    ].join('\n'),
    'The smallest workspace, which opens one tab on chromosome IV of a map beside it:',
    block(json(WORKSPACE_EXAMPLE), 'json'),
  ])
}
