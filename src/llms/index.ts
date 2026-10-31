/**
 * `llms.txt`: what chromosomix is, for a reader that is a language model, in the
 * shape llmstxt.org gives one — a heading, a one-paragraph summary, what a model
 * most needs to act without following a link, then sections of links (SPECS
 * §11).
 *
 * The prose is written here once; **every list in it is read from the app** —
 * the tasks from the catalogue, the store ids from the shelf, the transforms,
 * colour maps and comparisons from the lists the hash reader checks against,
 * and the reference pages from `llms/pages.ts` — so the file the site serves
 * changes when the app does, with nobody remembering to. It was a file kept by
 * hand under `public/`, held to the app by a test that failed when it drifted;
 * the test still reads what is written here, and nothing can drift.
 */

import { taskCatalogue } from '../analysis/catalogue'
import { COLORMAP_NAMES } from '../render/colormaps'
import { COMPARE_OPS } from '../render/compare'
import { TRANSFORMS } from '../state/ViewState'
import { builtinStores } from '../ui/stores/registry'
import { DEMO } from './links'
import { either, page, REPOSITORY, SITE } from './markdown'
import { AGENT_PAGES } from './pages'

/** A few words after the tasks whose ids do not say what they are. */
const TASK_GLOSSES: Readonly<Record<string, string>> = {
  expected: 'P(s)',
  fourc: 'virtual 4C',
  di: 'directionality index',
  loops: 'HiCCUPS-style loop calling',
  chromosight: 'loops, borders and other patterns',
  hicrep: 'reproducibility between maps',
  apa: 'aggregate peak analysis',
}

/** The same for the stores. */
const STORE_GLOSSES: Readonly<Record<string, string>> = {
  rsg: 'the lab’s demo and paper data',
}

/** `a`, `b` and `c`, each id followed by its gloss where it has one. */
const glossed = (ids: readonly string[], glosses: Readonly<Record<string, string>>): string =>
  either(ids, 'and').replace(/`([^`]+)`/g, (match, id: string) => (glosses[id] === undefined ? match : `${match} (${glosses[id]})`))

const MAP = `${DEMO}Yeast_microC_G2M_1kb.cool`
const VIEW = `uri=${MAP}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`

/** A section of links, as llmstxt.org writes one: `- [name](address): what it is`. */
function links(heading: string, rows: ReadonlyArray<readonly [string, string, string]>): string {
  return [`## ${heading}`, rows.map(([name, address, what]) => `- [${name}](${address}): ${what}`).join('\n')].join(
    '\n\n',
  )
}

export function indexPage(): string {
  const tasks = taskCatalogue().map((task) => task.id)
  const stores = builtinStores().map((store) => store.id)
  const raw = (path: string): string => `${REPOSITORY.replace('://github.com/', '://raw.githubusercontent.com/')}/main/${path}`
  return page([
    '# chromosomix',
    '> A unified, serverless genome browser for multi-dimensional genomic data: chromatin contact maps (Hi-C, ' +
      'Micro-C), genome tracks and 3D chromatin models, side by side, read straight from standard files in a web ' +
      'browser. Nothing is uploaded and nothing needs preprocessing. The same analyses run in the browser or from ' +
      'the `chromosomix` command line, with the same parameters and the same results.',
    'chromosomix is a static single-page application, free software under the GNU General Public License, version ' +
      '3 or later. It reads files where they are: a file on the user’s disk is read in place and never leaves the ' +
      'machine, and a remote file is read by HTTP range requests, a few kilobytes at a time. It runs at ' +
      `${SITE}, as an installable web app, as a desktop app (macOS, Linux), as one standalone HTML file attached ` +
      'to every GitHub release, inside any web page as an `<iframe>`, in Jupyter and R as a widget, and from npm ' +
      'as a command-line interface. A newcomer can press *play the tutorial*, on the landing page or in About, for ' +
      'a first session on a public 4DN Hi-C map, played one control at a time in the live app.',
    'There are four ways for an agent to use it, each documented on its own page below:',
    [
      '1. **Write a link** that opens a user’s file at a place. Every view is a URL; there is nothing to install ' +
        'at either end. See *Links*.',
      '2. **Run an analysis** from a shell or a pipeline with the `chromosomix` command. See *Command line* and ' +
        '*Analysis tasks*.',
      '3. **Embed the viewer** in a page, a notebook or a Shiny app, and drive it by `postMessage`, Python or R. ' +
        'See *Embedding and driving*.',
      '4. **Publish data** for others to browse: a host that serves byte ranges, a store (a catalogue) and ' +
        'workspaces (composed views). See *Files, hosting, stores and workspaces*.',
    ].join('\n'),
    'Formats it opens as they are:',
    [
      '- Contact maps: `.cool`, `.mcool`, `.hic`, `.scool`, HiC-Pro matrices, `.pairs` and `.pairs.gz`.',
      '- Tracks and annotations: bigWig, bedGraph, wig, bigBed, BED, narrowPeak, GTF/GFF3, genePred, VCF, BAM ' +
        '(with its `.bai`), FASTA (with its `.fai`), `.2bit`, barChart, bedMethyl, chrom.sizes, and UCSC track ' +
        'hubs (`hub.txt`).',
      '- Interactions: BEDPE, `interact`/`bigInteract` and `longrange`.',
      '- 3D models: g3d (text or binary), `.3dg`, bed3d, and the PDB it writes for PyMOL and the other molecular ' +
        'viewers.',
    ].join('\n'),
    'A remote file has to be served with CORS and HTTP range requests, which S3, Google Cloud Storage, Cloudflare ' +
      'R2 and most static web servers do. Dropbox and Google Drive share links work too. GEO and SRA downloads do ' +
      'not.',
    '**Linking to a view.** The state is in the fragment, as `key=value` pairs joined by `&`, with each value ' +
      'percent-encoded. To show a file at a place, write a link:',
    `    ${SITE}#uri=<file URL>&view=region&region=<sequence>:<start>-<end>&transform=log10&balance=true`,
    [
      '- `uri` (required): the address of the file. For one resolution of an `.mcool`, append ' +
        '`::/resolutions/<bin size>`, as in `sample.mcool::/resolutions/10000`.',
      '- `view`: `contigs` (the table of chromosomes), `whole` (the whole matrix), `region` (a window of the map) ' +
        'or `browser` (the 1D track browser over the file). A value it does not know opens the file’s table.',
      '- `region`: `<sequence>:<start>-<end>`, 0-based and half-open, without thousands separators, as cooler ' +
        'writes it: `IV:1000000-1400000` is shown as IV:1,000,001-1,400,000. A sequence name alone is the whole ' +
        'sequence. `region2` adds the column side of an off-diagonal block.',
      '- `locus`, with `view=browser`: the window of the 1D browser, written as it is displayed, 1-based and ' +
        'inclusive: `IV:1,000,001-1,400,000`.',
      `- \`transform\`: ${either(TRANSFORMS)}.`,
      '- `balance`: `true` for balanced values, with the weights the file carries, or `false` for raw counts.',
      `- \`colormap\`: ${either(COLORMAP_NAMES)}. \`vmin\` and \`vmax\` clip the colour scale, in transformed ` +
        'units.',
      '- `oe`: `true` for observed over expected.',
      `- \`uri2\`: a second map, drawn in the lower triangle of the same square; \`op\` is ${either(COMPARE_OPS)}.`,
      '- `maps`: more maps beside the first, as a deck, their addresses joined by `|`.',
    ].join('\n'),
    'Every other key, and every value each takes, is on the *Links* page. Put `?embed=1` before the `#` for the ' +
      'bare view, to frame in an `<iframe>`, and `?config=<URL>` to open a saved workspace (a `.chromosomix.json` ' +
      'file) instead of a single file. For a link whose picture must never change, use a release’s permanent copy ' +
      `in place of the root: \`${SITE}v/<tag>/\`, such as \`${SITE}v/v0.13.0/\`. \`${SITE}?store=<id>&q=<text>\` ` +
      `opens a public data store filtered by a search; the store ids are ${glossed(stores, STORE_GLOSSES)}.`,
    'An example, Micro-C of synthetic yeast chromosome IV from the public demo bucket:',
    `    ${SITE}#${VIEW}`,
    'The same view, embedded in a page:',
    `    <iframe src="${SITE}?embed=1#${VIEW}" width="100%" height="640" style="border: 0" ` +
      'title="Micro-C of yeast chromosome IV"></iframe>',
    '**The command line.** The analyses without the interface, for scripts and pipelines: `npm install -g ' +
      'chromosomix`, with Node 22.12 or later, or `npx chromosomix@<version>` to run a pinned release without ' +
      'installing anything.',
    [
      '    chromosomix tasks                      # every task, with its parameters and their defaults',
      '    chromosomix tasks --json               # the same as JSON, with every value a choice takes',
      '    chromosomix insulation sample.mcool::/resolutions/10000 --window 10 --out results/',
      '    chromosomix expected sample.cool --out results/',
      '    chromosomix metaplot --tracks ATAC.bw --features peaks.narrowPeak --out results/',
      '    chromosomix --version',
    ].join('\n'),
    'Each task writes its results into `--out` as TSV, and as BED, bedGraph or bigWig where those apply, named ' +
      '`<file stem>.<task>.<output>.<ext>`; a text output opens with the version, the file and the parameters ' +
      'that produced it. A map is read balanced wherever the file carries weights, and `--no-balance` reads the ' +
      'raw counts. A locus on the command line is 1-based and inclusive, as the app displays it. A command that ' +
      'is wrong — an unknown flag, a choice that is none of its values — is refused before any file is opened, ' +
      `with exit status 2 and a sentence naming what was expected. The tasks are ${glossed(tasks, TASK_GLOSSES)}.`,
    'Every analysis is held to the package it reproduces (cooltools, coolpuppy, chromosight, deepTools, bedtools ' +
      'and others) on public data, command for command, in a notebook rendered with every release.',
    links('Docs', [
      ...AGENT_PAGES.map((agentPage) => [agentPage.title, `${SITE}${agentPage.path}`, agentPage.summary] as const),
      [
        'The documentation in one file',
        `${SITE}llms-full.txt`,
        'the README and the pages above, for tools that read a single document',
      ],
      ['README', raw('README.md'), 'features, installation, the command line, embedding and licences'],
    ]),
    links('Evidence', [
      ['Validation', `${SITE}validation/`, 'each analysis compared with its reference implementation'],
      ['Timings', `${SITE}timings/`, 'how long each command takes beside its reference'],
      [
        'Parity',
        `${SITE}parity/`,
        'ten tasks run in the app and from the command line its console writes, file for file',
      ],
      [
        'Laptop',
        `${SITE}laptop/`,
        'the time and peak memory of 23 analyses run genome-wide, up to a 1.08-billion-contact map',
      ],
    ]),
    links('Get it', [
      ['Web app', SITE, 'nothing to install'],
      [
        'Releases',
        `${REPOSITORY}/releases`,
        'the desktop installers and the standalone HTML page, for every version',
      ],
      [
        'npm package',
        'https://www.npmjs.com/package/chromosomix',
        'the `chromosomix` command line, and the viewer as static files to host',
      ],
      [
        'Python widget',
        `${REPOSITORY}/blob/main/widgets/python/README.md`,
        '`pip install chromosomix`, for Jupyter, VS Code, Colab and marimo',
      ],
      [
        'R widget',
        `${REPOSITORY}/blob/main/widgets/r/README.md`,
        'an htmlwidget for R Markdown, Quarto, RStudio and Shiny',
      ],
      ['Source code', REPOSITORY, 'the repository, under the GNU General Public License, version 3 or later'],
    ]),
    links('Optional', [
      ['Changelog', raw('CHANGELOG.md'), 'what changed in each release'],
      ['Specification', raw('SPECS.md'), 'the complete behavioural contract, section by section, over a megabyte'],
      ['Glossary', raw('GLOSSARY.md'), 'the words the interface uses, defined'],
      ['Third-party notices', `${SITE}THIRD-PARTY-NOTICES.txt`, 'the licences of the work the app carries'],
    ]),
  ])
}
