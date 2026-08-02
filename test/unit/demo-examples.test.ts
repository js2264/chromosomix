/**
 * Every example the picker offers actually opens.
 *
 * This is the one test that reads `public/demo/` rather than a generated
 * fixture, and it exists because of the failure mode it catches: the demo
 * datasets get replaced, `ui/examples.ts` keeps naming the old ones, and the
 * landing page ships a dropdown in which every choice 404s. Nothing else in the
 * suite touches those files, so nothing else notices.
 *
 * It follows the app's own path rather than just stat-ing the files: `main.ts`
 * answers a collection opened at its root by calling {@link firstEntry} and
 * re-opening the entry it names (§3.4), so what the picker promises is "this
 * choice lands on a readable map", not "this byte range parses". A ladder whose
 * entries had gone missing would pass a file-exists check and fail here.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'

import { DEMO_FILES } from '../../src/ui/examples'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { firstEntry } from '../../src/ui/FilePicker'

const DIR = decodeURIComponent(new URL('../../public/demo/', import.meta.url).pathname)

describe('the picker examples', () => {
  it('names at least one file', () => {
    expect(DEMO_FILES.length).toBeGreaterThan(0)
  })

  for (const file of DEMO_FILES) {
    it(`opens ${file}`, async () => {
      const path = `${DIR}${file}`
      expect(existsSync(path), `${file} is offered by the picker but not in public/demo/`).toBe(true)

      let mc: MetaCooler
      try {
        mc = await MetaCooler.open(path, await LocalFileSource.open(path))
      } catch (err) {
        // Exactly what `App.open` does with an `.mmetacool` or `.mcool` root.
        const landing = firstEntry(err)
        expect(landing, `${file} did not open and named no entry: ${String(err)}`).not.toBeNull()
        const uri = `${path}::${landing?.group}/${landing?.entry}`
        mc = await MetaCooler.open(uri, await LocalFileSource.open(path))
      }

      // The §3.2 gate the picker cannot pre-check: a variable-bin file is
      // refused, so a demo file that is one is a broken choice, not a slow one.
      expect(mc.binsize).toBeGreaterThan(0)
      expect(mc.nContigs).toBeGreaterThan(0)
      mc.close()
    })
  }
})
