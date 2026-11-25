// @vitest-environment jsdom
/**
 * The ideogram view behind the dev features switch (§29.3, §5.11).
 *
 * Switched off it leaves nothing: no switch in the browser's Tracks card — no
 * `picture` row at all — and none of the ideogram's rows; and a link naming the
 * ideogram is kept and not applied, the browser drawing its own picture of the
 * same window (§29.4). In the plain run, being what every reader gets (§29.6);
 * the ideogram itself is `browser-ideogram.test.ts`'s.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AnnotationClient } from '@/annotations/worker/client'
import { AnnotationStore } from '@/annotations/store'
import { GroupSettings } from '@/annotations/groups'
import { ManualStore } from '@/annotations/manual'
import { assemblyOf } from '@/genome/assembly'
import { SequenceSelection } from '@/genome/selection'
import type { KaryotypeOrientation } from '@/render/karyotype'
import { resetDevFeatures } from '@/state/devFeatures'
import { BrowserView } from '@/ui/BrowserView'
import { setUpDom, type DomTeardown } from '../support/dom'

let teardown: DomTeardown
const built: BrowserView[] = []

beforeEach(() => {
  teardown = setUpDom({ canvas: 'stub' })
  window.sessionStorage.clear()
  resetDevFeatures(false)
})

afterEach(() => {
  for (const view of built.splice(0, built.length)) view.destroy()
  teardown()
  window.sessionStorage.clear()
  resetDevFeatures(null)
})

/** A worker that takes every request and answers none. */
class SilentWorker {
  onmessage: unknown = null
  onerror: unknown = null
  postMessage(): void {}
  terminate(): void {}
}

/** A browser over two sequences with a bigWig lane, as a link that may name the ideogram opens it. */
async function mount(ideogram?: KaryotypeOrientation): Promise<BrowserView> {
  const key = `ideogram-gate-${Math.random()}.bw`
  const store = new AnnotationStore(key, { persist: false })
  const entry = store.begin({
    card: 'linear',
    kind: 'track',
    label: 'ATAC',
    source: { kind: 'remote', url: 'ATAC.bw', name: 'ATAC.bw' },
  })
  store.update(entry.id, { status: 'ready' })
  const view = new BrowserView({
    assembly: assemblyOf({
      uri: key,
      name: key,
      contigs: [
        { name: 'I', length: 230_218 },
        { name: 'II', length: 813_184 },
      ],
      origin: 'sizes',
    }),
    store,
    client: new AnnotationClient(() => new SilentWorker() as unknown as Worker),
    selection: new SequenceSelection(),
    groups: new GroupSettings(key),
    manual: new ManualStore(key),
    onLocusChange: () => {},
    ...(ideogram === undefined ? {} : { ideogram }),
    onIdeogramChange: () => {},
  })
  built.push(view)
  document.body.append(view.el, view.sideEl)
  view.remeasure()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  return view
}

/** The Tracks card in the browser's column. */
function tracksCard(view: BrowserView): HTMLElement {
  const card = [...view.sideEl.querySelectorAll<HTMLElement>('.controls-card')].find(
    (node) => node.querySelector('.controls-title')?.textContent?.trim() === 'Tracks',
  )
  if (card === undefined) throw new Error('no Tracks card')
  return card
}

describe('the ideogram, switched off', () => {
  it('has no switch, no picture row and none of the ideogram’s rows', async () => {
    const view = await mount()
    const card = tracksCard(view)
    expect(view.sideEl.querySelector('button[title^="Ideogram"]')).toBeNull()
    expect(view.el.querySelector('button[title^="Ideogram"]')).toBeNull()
    const labels = [...card.querySelectorAll('.field-label')].map((node) => node.textContent?.trim())
    expect(labels).not.toContain('picture')
    expect(card.querySelector('.ideogram-only')).toBeNull()
  })

  it('draws the browser’s own picture for a link that names the ideogram', async () => {
    const view = await mount('vertical')
    expect(view.ideogramShown).toBe(false)
    expect(view.el.dataset.karyotype).toBeUndefined()
    expect(view.el.classList.contains('is-ideogram')).toBe(false)
  })
})
