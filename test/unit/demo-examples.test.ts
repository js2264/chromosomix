/**
 * Every example the picker offers actually opens.
 *
 * This is the one test that reads `demo/` rather than a generated fixture, and
 * it exists because of the failure mode it catches: the demo datasets get
 * replaced, `ui/examples.ts` keeps naming the old ones, and the landing page
 * ships a dropdown in which every choice 404s. Nothing else in the suite
 * touches those files, so nothing else notices.
 *
 * That failure got *easier* to ship when the datasets moved to S3, because the
 * picker now points at a bucket no test can reach: a rename here is a 404 that
 * nothing on this machine can see. So the rule the checks below encode is that
 * `demo/` on disk and `demo/` on the bucket are one tree —
 * `scripts/publish-demo.sh` uploads this directory and nothing else — which
 * makes "the file exists on disk" the strongest statement about the bucket that
 * can be made without the network, and makes a missing file a red CI run rather
 * than a broken landing page.
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
  DEMO_BUCKET,
  DEMO_FILES,
  demoAnnotationsFor,
} from '../../src/ui/examples'
import {
  isRefusal,
  refusalMessage,
  resolveConfig,
  type SessionConfig,
} from '../../src/state/SessionConfig'
import { parseWorkspaceFile, type WorkspaceFile } from '../../src/state/workspace'
import { LocalFileSource } from '../../src/sources/LocalFileSource'
import { MetaCooler } from '../../src/metacooler/MetaCooler'
import { firstEntry } from '../../src/ui/FilePicker'
import { parseMaps } from '../../src/panels/deck'
import { parseUri } from '../../src/uri'

const DIR = decodeURIComponent(new URL('../../demo/', import.meta.url).pathname)

/**
 * Where a config is served from, for the resolution step.
 *
 * Deliberately *not* {@link DEMO_BUCKET}: what is being checked is that a
 * session's relative names resolve to files in the folder the session is in,
 * and using the real bucket here would let a check pass for the wrong reason —
 * an absolute S3 URL baked into a config would satisfy `startsWith` while being
 * exactly the thing that stops the folder from being copyable. A foreign origin
 * cannot be satisfied that way.
 */
const ORIGIN = 'https://example.org/published/demo/'

/**
 * A resolved URI as its path under `demo/`, which is what both the disk and the
 * bucket are keyed by.
 *
 * Slicing the origin off rather than taking the last path segment: the two were
 * the same thing when every demo sat in one flat directory, and are not now
 * that each dataset has a folder. It also asserts something on its way past —
 * a URI that did not resolve under `demo/` yields a path with a scheme still on
 * it, which no `existsSync` will accept.
 */
function underDemo(uri: string): string {
  const path = parseUri(uri).path
  return path.startsWith(ORIGIN) ? path.slice(ORIGIN.length) : path
}

/**
 * Read one of the published workspaces, as the app reads it — every tab of it.
 *
 * A published example is one tab today and the format holds a window, so this
 * answers with the list rather than with the first of it. A catalogue entry that
 * grew a second tab and only ever had its first checked would be exactly the
 * kind of half-checked thing this file exists to prevent.
 */
function published(file: string): SessionConfig[] {
  const read = parseWorkspaceFile(readFileSync(`${DIR}${file}`, 'utf8'))
  // Through `refusalMessage` rather than a bare `not.toBeNull()`, so a demo file
  // broken by an edit says *which* way it is broken in the failure output.
  expect(
    isRefusal(read) ? refusalMessage(read, file) : '',
    `${file} is offered by the picker but is not a workspace file`,
  ).toBe('')
  return (read as WorkspaceFile).tabs.map((tab) => resolveConfig(tab, `${ORIGIN}${file}`))
}

/**
 * Every file a session names, wherever in it the name lives.
 *
 * Written as one list rather than checked field by field because the failure it
 * guards is a name in a place nobody thought to look. `state.uri` and the
 * tracks were checked from the beginning; the deck's companions and the lanes
 * beside them arrived later and were resolved by nothing at all, so a published
 * session naming `rep2.cool` fetched it against the *site root* — a 404 on the
 * web and `app://viewer/rep2.cool` in the desktop build, in a cell that simply
 * read as a broken panel.
 *
 * A vacancy and a local track name no file by construction and are the two
 * omissions here; both are covered by `session-config.test.ts`.
 */
function namedFiles(config: SessionConfig): string[] {
  return [
    config.state.uri,
    ...(config.state.uri2 === undefined ? [] : [config.state.uri2]),
    ...parseMaps(config.state.maps).flatMap((ref) => (ref.kind === 'vacant' ? [] : [ref.uri])),
    // A second name for the same companion, matched against it by string
    // equality when the deck comes back (`annotations/store.ts`), so it has to
    // resolve to the same place rather than merely to *a* place.
    ...(config.lanes ?? []).map((lane) => lane.uri),
    ...config.tracks.flatMap((track) => (track.source.url === undefined ? [] : [track.source.url])),
  ]
}

describe('the picker examples', () => {
  it('names at least one session', () => {
    expect(DEMO_FILES.length).toBeGreaterThan(0)
  })

  it('offers workspaces and nothing else', () => {
    for (const file of DEMO_FILES) {
      expect(file, 'the picker offers published workspaces, not data files').toMatch(
        /\.metacooler\.json$/,
      )
    }
  })

  /**
   * Every session is in a dataset folder, and the folder is where its data is.
   *
   * The flat `demo/` directory is what the S3 move replaced, and a session left
   * at the root would still open — `resolveConfig` would find its files beside
   * it — right up until a second dataset arrived wanting a file of the same
   * name. Naming the folder is what keeps `demo/yeast/` a thing you can copy.
   */
  it('puts every session in a dataset folder', () => {
    for (const file of DEMO_FILES) {
      expect(file, `${file} is at the root of demo/ rather than in a dataset folder`).toMatch(
        /^[^/]+\/[^/]+$/,
      )
    }
  })

  /**
   * The bucket the picker reads is a directory prefix, not an object.
   *
   * `demoExamples()` concatenates `${base}${folder}/${file}`, so a base that had
   * lost its trailing slash would produce `…/demoyeast/…` — a 404 on every
   * example, and one that reads as a missing file rather than a broken
   * constant. It cannot be checked through `demoExamples()` here, which needs a
   * `window`, so it is checked on the constant.
   */
  it('reads them from an absolute prefix ending in a slash', () => {
    expect(DEMO_BUCKET).toMatch(/^https:\/\/.+\/demo\/$/)
  })

  for (const file of DEMO_FILES) {
    it(`ships ${file}`, () => {
      expect(existsSync(`${DIR}${file}`), `${file} is offered by the picker but not in demo/`).toBe(
        true,
      )
    })

    it(`resolves every file ${file} names`, () => {
      for (const config of published(file)) {
        // Relative inside the file, absolute after resolution — that is the
        // whole of what lets one dataset folder work on the bucket, in the
        // desktop build and off a laptop, and a config that had absolute URLs
        // baked in would pass every other check here and open nowhere but the
        // bucket it was written against.
        for (const uri of namedFiles(config)) {
          expect(uri.startsWith(ORIGIN), `${file} names ${uri}, which did not resolve`).toBe(true)
          expect(
            existsSync(`${DIR}${underDemo(uri)}`),
            `${file} names ${underDemo(uri)}, which is not in demo/`,
          ).toBe(true)
        }
      }
    })

    /**
     * A lane names a map the deck is actually showing.
     *
     * The two are matched by string equality when the deck comes back, so a
     * lane resolving to a *different* place than the companion it means puts
     * that track on the lead — a perfectly legal lane, drawn without complaint,
     * and not the figure that was published.
     */
    it(`places every track ${file} lays out on a map it opens`, () => {
      for (const config of published(file)) {
        const maps = new Set([
          config.state.uri,
          ...parseMaps(config.state.maps).flatMap((ref) => (ref.kind === 'vacant' ? [] : [ref.uri])),
        ])
        for (const lane of config.lanes ?? []) {
          expect(maps.has(lane.uri), `${file} puts a track on ${lane.uri}, which it never opens`).toBe(
            true,
          )
        }
      }
    })

    it(`opens what ${file} names`, async () => {
      for (const config of published(file)) {
        const path = `${DIR}${underDemo(config.state.uri)}`

        // A browser session names a bigWig, a bigBed or a sizes file — not a
        // cooler — so `MetaCooler` is the wrong check for one. What makes it
        // valid is that the annotations worker can read an assembly out of it,
        // which `annotation-parse` covers for these very files.
        if (config.state.view === 'browser') {
          expect(existsSync(path)).toBe(true)
          continue
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
      }
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
      for (const config of published(file)) {
        for (const track of config.tracks) {
          if (track.style.group === '') continue
          expect(
            config.groups[track.style.group],
            `${file} puts ${track.label} in "${track.style.group}" and never says how it is drawn`,
          ).toBeDefined()
          expect(config.scaling[track.style.group]).toBeDefined()
        }
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
        `${file} is offered beside a demo map but is not in demo/`,
      ).toBe(true)
    })
  }

  it('offers them only for a map that is itself published', () => {
    for (const link of demoAnnotationsFor('https://example.org/demo/Yeast_microC_G2M_1kb.cool')) {
      expect(DEMO_FILES).not.toContain(link.file)
    }
  })
})
