/**
 * The curation stage's parts, as the stage builds them (`CurateStage.ts`'s
 * `CurateParts`): the three pictures, the inspector's cards and the chooser.
 * Kept apart so a test can build the stage with stand-ins.
 */

import { Chooser } from './Chooser'
import { ContactPane } from './ContactPane'
import type { CurateContext, CuratePane } from './context'
import type { CurateParts } from './CurateStage'
import { ScatterPane } from './ScatterPane'
import { AboutCard } from './cards/AboutCard'
import { ExportCard } from './cards/ExportCard'
import { HistoryCard } from './cards/HistoryCard'
import { SelectionCard } from './cards/SelectionCard'
import { SuggestionsCard } from './cards/SuggestionsCard'

// A stand-in for the part still being built (SPECS §33.3): a picture that says so.
function standInPane(title: string): CuratePane {
  const element = document.createElement('div')
  element.className = 'curate-stand-in'
  element.dataset.pane = title
  element.textContent = `${title} · being built`
  return { element, title, update: () => {}, resize: () => {}, setLarge: () => {}, showSuggestion: () => {}, key: () => false, dropTargetAt: () => null, dispose: () => {} }
}

export const curateParts: CurateParts = {
  contacts: (ctx: CurateContext) => new ContactPane(ctx),
  hosts: () => standInPane('hosts'),
  scatter: (ctx) => new ScatterPane(ctx),
  selection: (ctx, hooks) => new SelectionCard(ctx, hooks),
  suggestions: (ctx, hooks) => new SuggestionsCard(ctx, hooks),
  history: (ctx, options) => new HistoryCard(ctx, options),
  exporting: (ctx, options) => new ExportCard(ctx, options),
  about: (ctx, options) => new AboutCard(ctx, options),
  chooser: (ctx, kind, anchor, onChoose) => {
    const chooser = Chooser.open(ctx, kind, anchor, onChoose)
    return {
      close: () => chooser.close(),
      // One chooser is open at a time, and the stage opens them all.
      get open() {
        return Chooser.isOpen()
      },
    }
  },
}
