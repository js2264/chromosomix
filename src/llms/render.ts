/**
 * Every file the site serves to language models, as the app writes it now:
 * `llms.txt` and the pages it links, by the path each is served at.
 *
 * The one entry point the site build and the dev server load
 * (`scripts/llms.mjs`, through a Vite SSR server), so that what is deployed is
 * what this commit's app says about itself. `llms-full.txt` is put together
 * there, after this, because it carries the README, which is a file of the
 * repository rather than anything the app knows.
 *
 * The dev features are off for the render, whatever the environment says:
 * these are static text, read by somebody with no switch to turn (§29.5), and
 * a module loaded under Node with no page would otherwise find them on.
 */

import { resetDevFeatures } from '../state/devFeatures'
import { indexPage } from './index'
import { AGENT_PAGES } from './pages'

/** One file: where it is served under the site's root, and its text. */
export interface AgentFile {
  path: string
  text: string
}

export function renderAgentFiles(): AgentFile[] {
  resetDevFeatures(false)
  return [
    { path: 'llms.txt', text: indexPage() },
    ...AGENT_PAGES.map((agentPage) => ({ path: agentPage.path, text: agentPage.render() })),
  ]
}
