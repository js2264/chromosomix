// @vitest-environment jsdom
/**
 * The tracks published beside a **genome**, offered in the 1D browser.
 *
 * The map path has offered its shelf since the demo map shipped with ten
 * annotation files: one click, and a reader who brought no tracks has a picture
 * (`ui/examples.ts`). The browser path never did — and nobody noticed, because
 * until now the only thing that registered a shelf was a store row whose file
 * was a contact map.
 *
 * A **track hub** changes that, and changes it for the row that matters most:
 * an assembly hub's genome is its `.2bit` and its whole trackDb is the shelf
 * that rides along (§24.10), so *open with its tracks* on a hub's heading was
 * opening the genome and dropping every track on the way. An IGV genome row
 * carries the same shelf and was losing it the same way.
 *
 * Two claims, which together are the fix:
 *
 * - a shelf registered against a **sequence** file is answered for it, `.2bit`
 *   and all — the keying is on the URI and has never cared what the file is;
 * - the Tracks card **draws the offer in a browser session**, so the prop
 *   `Session.setUpBrowserAnnotations` now passes is not dead.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { AnnotationStore } from '@/annotations/store'
import { AnnotationLoader } from '@/annotations/loader'
import { AnnotationCard } from '@/ui/AnnotationCard'
import {
  clearShelves,
  demoAnnotationsFor,
  demoAnnotationsToOffer,
  registerShelf,
} from '@/ui/examples'

afterEach(() => {
  clearShelves()
  document.body.replaceChildren()
})

/** A card with no worker behind it: nothing here loads, it only draws. */
function card(demo?: { label: string; hint: string; run(): void }): AnnotationCard {
  const store = new AnnotationStore(`shelf-${Math.random()}.2bit`, { persist: false })
  const loader = new AnnotationLoader(
    store,
    { request: () => Promise.resolve(null), drop: () => {} } as never,
    [],
  )
  const built = new AnnotationCard({
    store,
    loader,
    context: 'browser',
    ...(demo === undefined ? {} : { demo }),
  })
  document.body.appendChild(built.el)
  return built
}

describe('a shelf on a genome', () => {
  const genome = 'https://lab.example.org/myHub/galGal7.2bit'

  it('is answered for a .2bit exactly as for a map', () => {
    registerShelf(genome, [
      { label: 'Rep 1', url: 'https://lab.example.org/myHub/rep1.bw' },
      { label: 'Loops', url: 'https://lab.example.org/myHub/loops.longrange' },
    ])
    expect(demoAnnotationsFor(genome).map((link) => link.label)).toEqual(['Rep 1', 'Loops'])
    // Through the same gate: a restored session is bringing its own tracks back
    // and must not be offered these on top of them.
    expect(demoAnnotationsToOffer(genome, { restoring: true })).toEqual([])
    expect(demoAnnotationsToOffer(genome, { restoring: false })).toHaveLength(2)
  })

  it('is drawn as an offer by the Tracks card in a browser session', () => {
    let ran = 0
    const built = card({
      label: 'load the 8 tracks published with this genome',
      hint: 'the hub’s own tracks',
      run: () => {
        ran++
      },
    })
    const offer = built.el.querySelector('.ann-demo') as HTMLButtonElement
    expect(offer).not.toBeNull()
    expect(offer.textContent).toBe('load the 8 tracks published with this genome')
    offer.click()
    expect(ran).toBe(1)
  })

  it('draws no offer when there is nothing published, rather than an empty one', () => {
    expect(card().el.querySelector('.ann-demo')).toBeNull()
  })
})
