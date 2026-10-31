/**
 * The pages the site serves to language models, beside `llms.txt` (SPECS §11).
 *
 * `public/llms.txt` is the summary, written by hand, and links here; these are
 * the references it links to, one Markdown file each under `public/llms/`, in
 * the shape llmstxt.org asks for — a page a model can fetch whole and act on.
 * Each is **generated from the app it describes**: the tasks from the registry,
 * the link keys beside the hash's own reader, the usage from the command, the
 * messages from the embed channel, the stores from the shelf. They are written
 * to `public/llms/` and committed, so a change to any of those shows in review
 * as a change to what agents are told; `test/dom/llms.test.ts` fails while a
 * committed page differs from what the app would write, and `npm run llms`
 * writes them again.
 *
 * The site build serves them as they are and folds them, after the README,
 * into `llms-full.txt` (`scripts/llms.mjs`), in the order `llms.txt` links them.
 */

import { cliPage } from './cli'
import { dataPage } from './data'
import { embedPage } from './embed'
import { linksPage } from './links'
import { tasksPage } from './tasks'

/** One page: where it is served under the site's root, and what writes it. */
export interface AgentPage {
  path: string
  render(): string
}

export const AGENT_PAGES: readonly AgentPage[] = [
  { path: 'llms/links.md', render: linksPage },
  { path: 'llms/cli.md', render: cliPage },
  { path: 'llms/tasks.md', render: tasksPage },
  { path: 'llms/embed.md', render: embedPage },
  { path: 'llms/data.md', render: dataPage },
]
