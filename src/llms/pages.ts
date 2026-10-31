/**
 * The pages the site serves to language models, beside `llms.txt` (SPECS §11).
 *
 * `llms.txt` is the summary (`llms/index.ts`) and links here; these are the
 * references it links to, one Markdown file each under `llms/` on the site, in
 * the shape llmstxt.org asks for — a page a model can fetch whole and act on.
 * Each is **generated from the app it describes**: the tasks from the
 * registry, the link keys beside the hash's own reader, the usage from the
 * command, the messages from the embed channel, the stores from the shelf.
 *
 * Nothing here is committed as output. The site build writes every file from
 * the source it is building (`scripts/llms.mjs`, through `llms/render.ts`), so
 * each deploy of `main` serves what that commit's app does, and the dev server
 * renders them on request. `test/dom/llms.test.ts` holds what they say to the
 * app: every link key to the reader's list, every flag to the parser, both JSON
 * examples to their parsers.
 */

import { cliPage } from './cli'
import { dataPage } from './data'
import { embedPage } from './embed'
import { linksPage } from './links'
import { tasksPage } from './tasks'

/** One page: where it is served under the site's root, what `llms.txt` calls it, and what writes it. */
export interface AgentPage {
  path: string
  title: string
  /** The line after its link in `llms.txt`. */
  summary: string
  render(): string
}

export const AGENT_PAGES: readonly AgentPage[] = [
  {
    path: 'llms/links.md',
    title: 'Links',
    summary:
      'every key of a link’s fragment and every value it takes, the two forms of a coordinate, the query ' +
      'parameters, pinned builds, and examples that open',
    render: linksPage,
  },
  {
    path: 'llms/cli.md',
    title: 'Command line',
    summary: 'installing `chromosomix`, writing a command, what it writes, exit statuses, examples, and the full usage',
    render: cliPage,
  },
  {
    path: 'llms/tasks.md',
    title: 'Analysis tasks',
    summary:
      'every task, with what it reads and writes and every parameter’s flag, values, default and meaning, ' +
      'generated from the app’s registry',
    render: tasksPage,
  },
  {
    path: 'llms/embed.md',
    title: 'Embedding and driving',
    summary: 'the viewer in an `<iframe>`, its `postMessage` protocol, and the Jupyter and R widgets',
    render: embedPage,
  },
  {
    path: 'llms/data.md',
    title: 'Files, hosting, stores and workspaces',
    summary:
      'the formats and their sidecars, what a host must serve, the built-in data stores, and the store and ' +
      'workspace JSON formats',
    render: dataPage,
  },
]
