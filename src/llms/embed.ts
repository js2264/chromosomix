/**
 * `llms/embed.md`: the viewer inside somebody else's page, and how that page
 * drives it (§21).
 *
 * The message names, the protocol's number and the cap on one `add` are read
 * from `app/EmbedChannel.ts`, so a message renamed there is renamed here; the
 * rules around them are §21.4's, said for a reader writing the host page.
 */

import {
  EMBED_ADD,
  EMBED_ADD_MAX,
  EMBED_NAVIGATE,
  EMBED_PROTOCOL,
  EMBED_READY,
  EMBED_STATE,
  EMBED_WHERE,
} from '../app/EmbedChannel'
import { RENDERED } from '../perf/rendered'
import { DEMO } from './links'
import { block, code, page, SITE, table } from './markdown'

const MAP = `${DEMO}Yeast_microC_G2M_1kb.cool`

/** The frame every example on the page holds. */
export const EMBED_EXAMPLE = `${SITE}?embed=1#uri=${MAP}&view=region&region=IV:1000000-1400000&transform=log10&balance=true`

export function embedPage(): string {
  return page([
    '# Embedding and driving chromosomix',
    '> The viewer goes inside any web page as an `<iframe>`, with nothing to install and no script to ' +
      'load: the `src` is a link to the view, with `?embed=1`. The page around it can then drive it by ' +
      '`postMessage` — move it, add tracks to it, and be told where the reader has taken it. The Jupyter ' +
      'widget and the R htmlwidget are this same frame, driven from Python and R.',
    '## An iframe',
    block(
      [
        '<iframe',
        `  src="${EMBED_EXAMPLE}"`,
        '  width="100%" height="640" loading="lazy" style="border: 0"',
        '  title="Micro-C of yeast chromosome IV"></iframe>',
      ].join('\n'),
      'html',
    ),
    [
      `- The \`src\` is a link to a view, as [the links page](${SITE}llms/links.md) writes one, with ` +
        '`?embed=1` before the `#`. Or `?embed=1&config=<URL>` for a saved workspace — several tabs, their ' +
        'tracks, colours and marks.',
      '- The frame is the view alone: no header, no tab strip, no status bar. The Annotations and Aesthetics ' +
        'panels are there, folded, because they are controls over the picture; the Files, General and ' +
        'Analysis panels are not. A reader can still drop a file of their own on it.',
      `- For a figure that must not change, pin a release: \`${SITE}v/<tag>/?embed=1#…\`. The root is ` +
        'the newest build, and changes with it.',
      '- Nothing is needed of the page around it — no `Cross-Origin-Opener-Policy`, no ' +
        '`Cross-Origin-Embedder-Policy` — and nothing of the data host beyond what any link needs: the ' +
        'frame’s requests come from the viewer’s origin, so a bucket whose CORS admits the viewer admits ' +
        'every page that embeds it.',
      '- An embed writes nothing to the reader’s storage and adds nothing to their back button: it shows ' +
        'what its `src` says, every time it loads.',
    ].join('\n'),
    '## The channel',
    `Six messages, each an object with a \`type\`. Protocol version ${EMBED_PROTOCOL}; a message is added ` +
      'without changing the number, so a host reads which messages a frame takes from its `ready`.',
    table(
      ['Message', 'Direction', 'Fields', 'What it is'],
      [
        [
          code(EMBED_READY),
          'frame → page',
          '`protocol`, `version`, `commit`, `accepts`',
          'Sent once, when the frame is listening. `accepts` lists the messages it takes. It carries nothing ' +
            'about what is on screen.',
        ],
        [
          code(EMBED_WHERE),
          'page → frame',
          '—',
          `Where is the view? Answered with \`${EMBED_STATE}\`.`,
        ],
        [
          code(EMBED_NAVIGATE),
          'page → frame',
          '`state`',
          'Go here. `state` is a **patch** laid over the view on screen: any key a link carries, so ' +
            '`{ locus: "IV:1,000,001-1,100,000" }` moves a 1D browser and `{ transform: "log2", oe: true }` ' +
            're-colours a map. A key given `null` is removed; `state: null` is the landing page. Answered ' +
            `with \`${EMBED_STATE}\`, saying where the view actually went.`,
        ],
        [
          code(EMBED_ADD),
          'page → frame',
          '`files`',
          'Put these addresses in the tab, in order, as the app’s `+` does: a track among the tracks, a map ' +
            `or a 3D model beside the map; on an empty tab the first is its file. \`http(s)\` only, at most ` +
            `${EMBED_ADD_MAX}. Waits for the first picture, and is answered with \`${EMBED_STATE}\` once ` +
            'every file is in. Builds before 0.17.0 do not take it.',
        ],
        [
          code(EMBED_STATE),
          'frame → page',
          '`state`',
          'The view: an object of the keys a link carries (`uri`, `view`, `region`, `locus`…), or `null` ' +
            'for the landing page. Sent in answer, and on every move once the page has spoken.',
        ],
        [
          code(RENDERED),
          'frame → page',
          '`report`',
          'A picture is finished: `report.status` is `drawn`, `gated` (waiting for the reader to agree to a ' +
            'large read) or `error`, with `report.maps` (each map’s `title`, `binsize`, `resolution`, ' +
            '`rows`, `cols`), `report.lanes` and `report.state`, the view as a hash string. What to take a ' +
            'screenshot on.',
        ],
      ],
    ),
    [
      '- **The page speaks first.** The frame answers only the window that framed it, and only once that ' +
        `window has sent it something; \`${EMBED_READY}\` is the one message it sends unasked. Listen before ` +
        'the frame loads — put the script ahead of the `<iframe>`, or set its `src` from the script — so as ' +
        'not to miss it.',
      '- **Replies go to the origin the page spoke from**, never to `*`: the reader may open their own file ' +
        'in the frame, and only the page that asked is told.',
      '- **Messages are carried out in the order they came.** A `navigate` sent after an `add` waits for ' +
        'the files to open, and is laid over the view they opened.',
      '- **A patch is read as a link is**: a key the frame does not know is dropped, a value it cannot read ' +
        'is ignored. Read the answer to know where the view went.',
    ].join('\n'),
    '### A host page',
    block(
      [
        'const frame = document.querySelector("iframe")',
        'const viewer = new URL(frame.src).origin',
        'const send = (message) => frame.contentWindow.postMessage(message, viewer)',
        '',
        'window.addEventListener("message", (event) => {',
        '  if (event.source !== frame.contentWindow) return',
        '  const message = event.data',
        `  if (message?.type === "${EMBED_READY}") {`,
        `    if (message.accepts?.includes("${EMBED_ADD}")) {`,
        `      send({ type: "${EMBED_ADD}", files: ["${DEMO}Yeast_ATAC.bw"] })`,
        '    }',
        `    send({ type: "${EMBED_NAVIGATE}", state: { region: "IV:1100000-1300000" } })`,
        '  }',
        `  if (message?.type === "${EMBED_STATE}") console.log("the view is at", message.state)`,
        `  if (message?.type === "${RENDERED}") console.log("drawn:", message.report.status)`,
        '})',
      ].join('\n'),
      'js',
    ),
    '## In a Jupyter notebook',
    'The same frame as an anywidget, in JupyterLab, Notebook 7, VS Code, Colab and marimo. A file is an ' +
      'address or a path on the kernel’s disk, which the kernel serves to the frame by byte range from ' +
      '`127.0.0.1`, sidecars and all; nothing is uploaded.',
    block(
      [
        '# pip install chromosomix',
        'from chromosomix import Chromosomix',
        'view = Chromosomix("sample.mcool::/resolutions/5000", region="chr2:10000000-14000000",',
        '                   tracks=["ATAC.bw", "genes.gtf.gz"], transform="log10")',
        'view                                        # the map, its tracks, its side panels',
        'view.goto("chr2:11000000-12000000")         # a region, or a locus in the 1D browser',
        'view.navigate(transform="log2", oe=True)    # any key a link carries; None removes one',
        'view.add("model.g3d.gz")                    # a track, a map or a 3D model beside the map',
        'view.state                                  # where the reader is: a traitlet to observe',
        'view.rendered                               # the last finished picture',
      ].join('\n'),
      'python',
    ),
    '`viewer="0.17.0"` pins the build in the frame to a release; `chromosomix.install_viewer()` fetches one ' +
      'to serve beside the data, which is what makes local files work behind JupyterHub and offline.',
    '## In R: R Markdown, Quarto and Shiny',
    block(
      [
        'remotes::install_github("js2264/chromosomix", subdir = "widgets/r")',
        '',
        'library(chromosomix)',
        'chromosomix("sample.mcool::/resolutions/5000", region = "chr2:10000000-14000000",',
        '            tracks = c("ATAC.bw", "genes.gtf.gz"), transform = "log10") |>',
        '  chromosomix_goto("chr2:11000000-12000000") |>',
        '  chromosomix_navigate(oe = TRUE) |>',
        '  chromosomix_add("model.g3d.gz")',
      ].join('\n'),
      'r',
    ),
    'In Shiny, `chromosomixOutput()`, `renderChromosomix()` and `chromosomixProxy()` drive a view on screen, ' +
      'and `input$<id>_state` follows the reader. A page knitted for others names its files by address: a ' +
      'local file is served only while the R session that rendered the page runs.',
    `Both widgets are documented in the repository: [Python](https://github.com/js2264/chromosomix/blob/main/widgets/python/README.md), ` +
      '[R](https://github.com/js2264/chromosomix/blob/main/widgets/r/README.md).',
  ])
}
