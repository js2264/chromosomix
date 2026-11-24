/**
 * The curation stage's parts, as the stage builds them (`CurateStage.ts`'s
 * `CurateParts`): the three pictures, the inspector's cards and the chooser.
 * Kept apart so a test can build the stage with stand-ins.
 */

import { Chooser } from './Chooser'
import { ContactPane } from './ContactPane'
import type { CurateContext, CuratePane } from './context'
import type { CurateCard, CurateParts } from './CurateStage'
import { SelectionCard } from './cards/SelectionCard'

// Stand-ins for the parts still being built (SPECS §33.3): a picture or a card that says so.
function standInPane(title: string): CuratePane {
  const element = document.createElement('div')
  element.className = 'curate-stand-in'
  element.dataset.pane = title
  element.textContent = `${title} · being built`
  return { element, title, update: () => {}, resize: () => {}, setLarge: () => {}, showSuggestion: () => {}, key: () => false, dropTargetAt: () => null, dispose: () => {} }
}
function standInCard(head: string): CurateCard {
  const element = document.createElement('section')
  element.className = 'edit-card'
  element.innerHTML = `<h3 class="edit-card-head">${head}</h3><p class="edit-note">being built</p>`
  return { element, update: () => {} }
}

export const curateParts: CurateParts = {
  contacts: (ctx: CurateContext) => new ContactPane(ctx),
  hosts: () => standInPane('hosts'),
  scatter: () => standInPane('scatter'),
  selection: (ctx, hooks) => new SelectionCard(ctx, hooks),
  suggestions: () => standInCard('suggestions'),
  history: () => standInCard('history'),
  exporting: () => standInCard('export'),
  about: () => standInCard('about the map'),
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
