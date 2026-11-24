/**
 * The curation stage's parts, as the stage builds them (`CurateStage.ts`'s
 * `CurateParts`): the three pictures, the inspector's cards and the chooser.
 * Kept apart so a test can build the stage with stand-ins.
 */

import { Chooser } from './Chooser'
import { ContactPane } from './ContactPane'
import type { CurateContext } from './context'
import type { CurateParts } from './CurateStage'
import { HostPane } from './HostPane'
import { ScatterPane } from './ScatterPane'
import { AboutCard } from './cards/AboutCard'
import { ExportCard } from './cards/ExportCard'
import { HistoryCard } from './cards/HistoryCard'
import { SelectionCard } from './cards/SelectionCard'
import { SuggestionsCard } from './cards/SuggestionsCard'

export const curateParts: CurateParts = {
  contacts: (ctx: CurateContext) => new ContactPane(ctx),
  hosts: (ctx) => new HostPane(ctx),
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
