// @vitest-environment jsdom
/**
 * The score picker on a panel that has no sidebar — a companion of a deck.
 *
 * A companion carries its controls on the picture, in a menu that opens out of
 * its bottom-left corner (`MatrixPanel`'s `cornerControls`), and the score was
 * the one thing in that menu's remit that never reached it: the panel was built
 * without a picker on the argument that the score is something a deck *shares*.
 * That argument is right about the default and wrong about the choice — two
 * ordinary cases need one map read differently from the rest, and both ended at
 * a control that did not exist.
 *
 * What is asserted here is where the picker lives, that it reports what was
 * picked, and that it can be told what is actually being drawn without
 * announcing it back — which is what keeps it honest while the panel is still
 * following the deck.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MatrixPanel } from '@/ui/MatrixPanel'
import { scoreChoices, type ScoreChoice } from '@/ui/scores'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: MatrixPanel[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
})

afterEach(() => {
  for (const panel of built.splice(0, built.length)) panel.destroy()
  teardown()
})

/** A file that has been balanced and carries one extra column of its own. */
function choices(): readonly ScoreChoice[] {
  return scoreChoices({ hasWeights: true, scoreColumns: ['expected'] })
}

function harness(options: { current?: string; corner?: boolean } = {}): {
  panel: MatrixPanel
  picked: ScoreChoice[]
  select(): HTMLSelectElement
} {
  const picked: ScoreChoice[] = []
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    cornerControls: options.corner ?? true,
    hideTitle: true,
    scores: {
      choices: choices(),
      current: options.current ?? 'count',
      onChange: (choice) => picked.push(choice),
    },
  })
  built.push(panel)
  document.body.append(panel.el)
  // The card is *detached* — a companion never mounts one — so it is reached
  // through the panel rather than through the tree, which is how the views that
  // do mount it reach it too.
  document.body.append(panel.controlsEl)
  return {
    panel,
    picked,
    select: () => {
      const node = scoreSelectIn(panel.el) ?? scoreSelectIn(panel.controlsEl)
      if (node === null) throw new Error('the panel has no score picker')
      return node
    },
  }
}

/** The one `<select>` under a field labelled `score`, if this root has it. */
function scoreSelectIn(root: Element | null): HTMLSelectElement | null {
  for (const field of root?.querySelectorAll('.field') ?? []) {
    if (field.querySelector('.field-label')?.textContent !== 'score') continue
    const select = field.querySelector<HTMLSelectElement>('select')
    if (select !== null) return select
  }
  return null
}

/** Every field under a root, by its label. */
function fieldsIn(root: Element | null): string[] {
  if (root === null) return []
  return Array.from(root.querySelectorAll('.field-label')).map((node) => node.textContent ?? '')
}

describe('a companion’s score picker', () => {
  it('is in the menu on the picture, where a panel with no sidebar keeps its controls', () => {
    const fit = harness()
    expect(fieldsIn(fit.panel.el.querySelector('.map-settings'))).toContain('score')
  })

  it('is offered once, not once per container', () => {
    // One set of widgets over one setting: a second copy is two controls that
    // drift, and a node has one parent anyway — appending to both containers
    // silently moves it into whichever was built last, which is how the corner
    // menu once came up empty.
    const fit = harness()
    expect(scoreSelectIn(fit.panel.el.querySelector('.map-settings'))).toBe(fit.select())
    expect(fieldsIn(fit.panel.controlsEl)).not.toContain('score')
  })

  it('opens on whatever the deck resolved, not on the file’s own default', () => {
    const fit = harness({ current: 'balanced' })
    expect(fit.select().value).toBe('balanced')
  })

  it('reports the choice, resolved to the entry rather than to its id', () => {
    const fit = harness()
    fit.select().value = 'balanced'
    fit.select().dispatchEvent(new Event('change'))
    expect(fit.picked).toHaveLength(1)
    expect(fit.picked[0]?.id).toBe('balanced')
    expect(fit.picked[0]?.balance).toBe(true)
  })

  it('offers this file’s own extra column, under its own name', () => {
    const fit = harness()
    const offered = Array.from(fit.select().options).map((option) => option.value)
    expect(offered).toContain('expected')
    expect(offered).toContain('count')
  })

  it('can be told what is drawn without announcing it back', () => {
    // The panel follows the deck until the reader picks here, and the deck's
    // score moves from the lead's picker, a link or the back button. A dropdown
    // left on the previous answer is a control lying about the map under it —
    // and one that announced the correction would be a loop.
    const fit = harness()
    fit.panel.syncScoreChoice('balanced')
    expect(fit.select().value).toBe('balanced')
    expect(fit.picked).toHaveLength(0)
  })

  it('ignores a score this file cannot serve rather than going blank', () => {
    const fit = harness()
    fit.panel.syncScoreChoice('nothing-of-the-sort')
    expect(fit.select().value).toBe('count')
  })

  it('is in the card instead where the panel has one', () => {
    // The same one set of widgets, in the other place: a panel with a sidebar
    // keeps its value fields in the Map card, and building a corner menu for it
    // would be a second control over one scale.
    const fit = harness({ corner: false })
    expect(fit.panel.el.querySelector('.map-settings')).toBeNull()
    expect(fieldsIn(fit.panel.controlsEl)).toContain('score')
  })
})
