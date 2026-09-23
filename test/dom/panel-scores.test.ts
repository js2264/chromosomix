// @vitest-environment jsdom
/**
 * The score picker on a companion of a deck.
 *
 * A companion's settings are its *Map* card, which the Aesthetics column shows
 * while that map is starred (§16.5). It used to carry the score, the transform,
 * the ramp and the clip in a menu out of its picture's bottom-left corner; that
 * menu is gone, and nothing is drawn on the picture any more.
 *
 * What is asserted here is where the picker lives, that it reports what was
 * picked, and that it can be told what is actually being drawn without
 * announcing it back.
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

function harness(options: { current?: string } = {}): {
  panel: MatrixPanel
  picked: ScoreChoice[]
  select(): HTMLSelectElement
} {
  const picked: ScoreChoice[] = []
  const panel = new MatrixPanel({
    binsize: 1000,
    detachedControls: true,
    hideTitle: true,
    scores: {
      choices: choices(),
      current: options.current ?? 'count',
      onChange: (choice) => picked.push(choice),
    },
  })
  built.push(panel)
  document.body.append(panel.el)
  // The card is *detached* — the Aesthetics column mounts it, not the panel —
  // so it is reached through the panel, which is how the session reaches it.
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
  it('is on the Map card, and nothing is drawn on the picture', () => {
    const fit = harness()
    expect(fieldsIn(fit.panel.controlsEl)).toContain('score')
    // No corner menu and no button to open one.
    expect(fit.panel.el.querySelector('.map-settings')).toBeNull()
    expect(fit.panel.el.querySelector('.map-settings-toggle')).toBeNull()
  })

  it('is offered once', () => {
    const fit = harness()
    const pickers = Array.from(fit.panel.controlsEl.querySelectorAll('.field')).filter(
      (field) => field.querySelector('.field-label')?.textContent === 'score',
    )
    expect(pickers).toHaveLength(1)
    expect(fit.panel.el.contains(fit.select())).toBe(false)
  })

  it('opens on whatever the deck resolved, not on the file’s own default', () => {
    const fit = harness({ current: 'balanced' })
    expect(fit.select().value).toBe('balanced')
  })

  it('leads the value fields of the card', () => {
    // What the numbers *are*, before how they are transformed, ramped and
    // clipped — the question the other three answer about.
    const VALUES = ['score', 'smooth', 'transform', 'colours', 'clip']
    const card = fieldsIn(harness().panel.controlsEl)
    expect(card.filter((label) => VALUES.includes(label))[0]).toBe('score')
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
    // A dropdown left on the previous answer is a control lying about the map
    // under it — and one that announced the correction would be a loop.
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
})

describe('the Map card’s line saying which map it sets (§16.5)', () => {
  it('is hidden until a deck says what it sets', () => {
    const fit = harness()
    expect(fit.panel.controlsEl.querySelector('.map-card-for')?.classList.contains('hidden')).toBe(true)
  })

  it('names the starred map, or says every map while none is starred', () => {
    const fit = harness()
    const line = (): HTMLElement | null => fit.panel.controlsEl.querySelector<HTMLElement>('.map-card-for')
    fit.panel.setCardFor({ kind: 'starred', name: 'rep2.cool' })
    expect(line()?.classList.contains('hidden')).toBe(false)
    expect(line()?.textContent).toBe('rep2.cool')
    expect(line()?.classList.contains('is-every')).toBe(false)
    fit.panel.setCardFor({ kind: 'every', maps: 3 })
    expect(line()?.textContent).toBe('every map — all 3')
    expect(line()?.classList.contains('is-every')).toBe(true)
    fit.panel.setCardFor(null)
    expect(line()?.classList.contains('hidden')).toBe(true)
  })
})
