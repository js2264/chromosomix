/**
 * "Forget everything", and whether it stays forgotten.
 *
 * `test/unit/stored.test.ts` pins what the sweep clears. This file pins the
 * other half, which is the half that was missing and the half a reader actually
 * asked for: **that the record does not come straight back.**
 *
 * The failure it guards is not a bug anybody could see. `forgetEverything`
 * deleted the durable workspace and said so, and then `App.rememberDurably()` —
 * which sits on the state-change path and writes unconditionally once the boot
 * has settled — wrote a fresh one on the reader's next pan, or on `pagehide`
 * when they closed the browser. A reader on a borrowed laptop pressed the
 * button, was told it had worked, closed the lid, and the next person to open
 * the site was met by a banner naming the unpublished file they had been
 * reading (§11). A write already sitting on `writeWorkspace`'s debounce landed
 * the same way, half a second later, with no further gesture at all.
 *
 * ## Why each test resets the modules
 *
 * The suspension is module state that nothing clears — see
 * `state/workspace.ts`'s `suspendWorkspace`, and the paragraph there about why
 * `forgetWorkspace` deliberately does not re-arm it. A reload is what re-arms
 * it, so *one page load is one test*: `vi.resetModules()` before each set of
 * imports is that reload, and without it a later test would pass on the flag an
 * earlier one set rather than on its own sweep.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The modules of one page load, sharing one fresh registry. */
async function pageLoad() {
  vi.resetModules()
  const [stored, workspace, idb, sessionConfig, plotOptions] = await Promise.all([
    import('@/state/stored'),
    import('@/state/workspace'),
    import('@/state/idb'),
    import('@/state/SessionConfig'),
    import('@/ui/plotOptions'),
  ])
  /** One tab holding the file the reader would least like to leave behind. */
  const oneTab = () => ({
    version: workspace.WORKSPACE_VERSION,
    savedAt: '2026-09-09T09:00:00.000Z',
    sessions: [
      {
        id: 's1',
        config: sessionConfig.buildConfig({
          state: { uri: 'patient_04_hic.cool', view: 'region' },
          memoryKey: 'forget|patient_04_hic.cool',
          plot: plotOptions.DEFAULT_UI_PLOT_OPTIONS,
          now: new Date('2026-09-09T09:00:00Z'),
        }),
      },
    ],
    active: 's1',
  })
  /** What is in the store, read past the validator so nothing is excused. */
  const record = () => idb.store(idb.STORES.workspace).get('current')
  return { ...stored, ...workspace, oneTab, record }
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.resetModules()
})

describe('after the reader has asked for everything to be forgotten', () => {
  it('does not let a write already on the debounce land behind the sweep', async () => {
    const { forgetEverything, flushWorkspace, writeWorkspace, oneTab, record } = await pageLoad()
    // The precise moment `workspace.ts` says it guards: a pan half a second ago
    // queued a write, the reader pressed the button, and nothing else happens.
    // The record used to reappear on its own, which is the worst version of this
    // — there is no gesture to blame it on.
    writeWorkspace(oneTab())
    await forgetEverything()
    // `flushWorkspace` is what the debounce timer calls, and what `pagehide`
    // calls: whatever is still waiting, written now.
    await flushWorkspace()
    expect(await record()).toBeNull()
  })

  it('does not let the next state change write the record back', async () => {
    const { forgetEverything, flushWorkspace, storedItems, writeWorkspace, oneTab, record } =
      await pageLoad()
    writeWorkspace(oneTab())
    await flushWorkspace()
    expect(await record()).not.toBeNull()

    await forgetEverything()
    // One pan, one panel fold, one tab change — or the browser closing, which
    // is `pagehide` calling `rememberDurably()` and then flushing. Every one of
    // them reaches `writeWorkspace` with a full workspace in hand.
    writeWorkspace(oneTab())
    await flushWorkspace()

    expect(await record()).toBeNull()
    // And the dialog agrees, which is the sentence the reader is owed: the
    // account of what is kept must not grow a "Remembered workspace — 1 tab"
    // line back after they emptied it.
    expect(await storedItems()).toEqual([])
  })

  it('is not talked out of it by "Start fresh" or by the last tab closing', async () => {
    // Both of those call `forgetWorkspace`, and re-arming the suspension there
    // is the tempting shortcut. It hands the leak straight back: closing the
    // last tab is `recordAction`'s `'forget'`, so a reader who forgot everything
    // and then closed their one tab would be recorded again by the next file
    // they opened — having asked for exactly the opposite.
    const { forgetEverything, forgetWorkspace, flushWorkspace, writeWorkspace, oneTab, record } =
      await pageLoad()
    await forgetEverything()
    await forgetWorkspace()
    writeWorkspace(oneTab())
    await flushWorkspace()
    expect(await record()).toBeNull()
  })

  it('leaves the next page load free to remember again', async () => {
    // The limit of the promise, stated rather than left to be discovered. The
    // suspension is for *this window*: it is module state, so a reload re-arms
    // it, which is the same line `stored.ts` draws when it refuses to reload the
    // page on the reader's behalf. A window they have deliberately started again
    // is a new answer to the same question, not the old one being overruled.
    const first = await pageLoad()
    await first.forgetEverything()

    const second = await pageLoad()
    second.writeWorkspace(second.oneTab())
    await second.flushWorkspace()
    expect(await second.record()).not.toBeNull()
  })
})
