/**
 * Every example the picker offers actually opens.
 *
 * This is the one test that reads `public/demo/` rather than a generated
 * fixture, and it exists because of the failure mode it catches: the demo
 * datasets get replaced, `ui/examples.ts` keeps naming the old ones, and the
 * landing page ships a dropdown in which every choice 404s. Nothing else in the
 * suite touches those files, so nothing else notices.
 *
 * The catalogue is now a list of **published sessions** rather than of data
 * files, which puts one more link in the chain and one more way to break it: a
 * session names a file *and every track around it*, by relative name, and a
 * renamed bigWig is a session that opens to a map with six error rows beside
 * it. So each config is parsed with the reader's own parser, resolved as the
 * app resolves it, and every file it names is checked — the map by opening it.
 *
 * It follows the app's own path rather than just stat-ing the files: `main.ts`
 * answers a collection opened at its root by calling {@link firstEntry} and
 * re-opening the entry it names (§3.4), so what the picker promises is "this
 * choice lands on a readable map", not "this byte range parses". A ladder whose
 * entries had gone missing would pass a file-exists check and fail here.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

import {
  DEMO_ANNOTATION_FILES,
  DEMO_FILES,
  demoAnnotationsFor,
} from '../../src/ui/examples'
import { parseConfig, resolveConfig, type SessionConfig } from '../../src/state/SessionConfig'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { firstEntry } from '../../src/ui/FilePicker'
import { parseUri } from '../../src/uri'

const DIR = decodeURIComponent(new URL('../../public/demo/', import.meta.url).pathname)

/**
 * Where a config is served from, for the resolution step.
 *
 * Any absolute base does: what is being checked is that the *names* inside a
 * config resolve to files in the directory the config is in, and a `https://`
 * origin is what the app will always hand `resolveConfig` on the web.
 */
const ORIGIN = 'https://example.org/metacooler.js/demo/'

/** The file name a resolved URI ends in, which is what `public/demo/` holds. */
function nameOf(uri: string): string {
  return parseUri(uri).path.split('/').pop() ?? ''
}

/** Read one of the published sessions, as the app reads it. */
function published(file: string): SessionConfig {
  const config = parseConfig(readFileSync(`${DIR}${file}`, 'utf8'))
  expect(config, `${file} is offered by the picker but is not a session file`).not.toBeNull()
  return resolveConfig(config as SessionConfig, `${ORIGIN}${file}`)
}

describe('the picker examples', () => {
  it('names at least one session', () => {
    expect(DEMO_FILES.length).toBeGreaterThan(0)
  })

  it('offers sessions and nothing else', () => {
    for (const file of DEMO_FILES) {
      expect(file, 'the picker offers published sessions, not data files').toMatch(
        /\.metacooler\.json$/,
      )
    }
  })

  for (const file of DEMO_FILES) {
    it(`ships ${file}`, () => {
      expect(existsSync(`${DIR}${file}`), `${file} is offered by the picker but not in public/demo/`)
        .toBe(true)
    })

    it(`resolves every file ${file} names`, () => {
      const config = published(file)
      // Relative inside the file, absolute after resolution — that is the whole
      // of what lets one directory of sessions work in dev, on Pages and in the
      // desktop build, and a config that had absolute URLs baked in would pass
      // every other check here and open nowhere but the machine that wrote it.
      expect(config.state.uri.startsWith(ORIGIN), `${file} names ${config.state.uri}`).toBe(true)
      const named = [config.state.uri, ...config.tracks.map((track) => track.source.url ?? '')]
      for (const uri of named) {
        expect(
          existsSync(`${DIR}${nameOf(uri)}`),
          `${file} names ${nameOf(uri)}, which is not in public/demo/`,
        ).toBe(true)
      }
    })

    it(`opens what ${file} names`, async () => {
      const config = published(file)
      const path = `${DIR}${nameOf(config.state.uri)}`

      // A browser session names a bigWig, a bigBed or a sizes file — not a
      // cooler — so `MetaCooler` is the wrong check for one. What makes it
      // valid is that the annotations worker can read an assembly out of it,
      // which `annotation-parse` covers for these very files.
      if (config.state.view === 'browser') {
        expect(existsSync(path)).toBe(true)
        return
      }

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

  /**
   * A group named by a track is a group the session also describes.
   *
   * The two halves live in different places — `style.group` on each track,
   * the mode and scaling in records beside them — and a config that put two
   * tracks in a group it then said nothing about would open with the defaults
   * silently: the picture would be right by luck, and editing either half
   * without the other would be the bug nobody could see.
   */
  it('describes every group its tracks are in', () => {
    for (const file of DEMO_FILES) {
      const config = published(file)
      for (const track of config.tracks) {
        if (track.style.group === '') continue
        expect(
          config.groups[track.style.group],
          `${file} puts ${track.label} in "${track.style.group}" and never says how it is drawn`,
        ).toBeDefined()
        expect(config.scaling[track.style.group]).toBeDefined()
      }
    }
  })
})

/**
 * The annotations offered beside a demo map are there too.
 *
 * The same failure mode one layer up: the card offers "load the ten tracks
 * published with this map", the files get renamed, and the button produces ten
 * rows that all fail to load. Only the presence is checked here — the *parsing*
 * of every one of them is `annotation-parse.test.ts`'s job, and the
 * contig-for-contig agreement with the map is checked there too.
 */
describe('the annotations published beside a demo map', () => {
  for (const file of DEMO_ANNOTATION_FILES) {
    it(`ships ${file}`, () => {
      expect(
        existsSync(`${DIR}${file}`),
        `${file} is offered beside a demo map but is not in public/demo/`,
      ).toBe(true)
    })
  }

  it('offers them only for a map that is itself published', () => {
    for (const link of demoAnnotationsFor('https://example.org/demo/Yeast_microC_G2M_1kb.cool')) {
      expect(DEMO_FILES).not.toContain(link.file)
    }
  })
})
