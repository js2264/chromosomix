/**
 * `file::group` parsing, table-driven against `metacooler/src/metacooler/uri.py`.
 *
 * Every expectation below was produced by running the *Python* `parse_uri` on
 * the same input, so this suite is an oracle comparison rather than a
 * restatement of what `src/uri.ts` happens to do. The URI is the one string
 * that has to mean the same thing in the CLI, in an error message and in the
 * URL hash (spec §3.5) — if the two implementations drift here, an mmetacool
 * entry link shared out of the browser opens the wrong group in the terminal.
 */

import { describe, expect, it } from 'vitest'

import { ViewerError } from '../../src/errors'
import { formatUri, parseUri } from '../../src/uri'

/**
 * `[input, path, group]`, verbatim from:
 *
 * ```
 * >>> from metacooler.uri import parse_uri
 * >>> parse_uri(<input>)
 * ```
 */
const ACCEPTED: [string, string, string][] = [
  ['f.metacool', 'f.metacool', '/'],
  ['  f.metacool  ', 'f.metacool', '/'],
  ['/abs/dir/f.metacool', '/abs/dir/f.metacool', '/'],
  ['file with spaces.metacool', 'file with spaces.metacool', '/'],
  ['C:/data/f.metacool', 'C:/data/f.metacool', '/'],
  // A single ':' is not a separator, so a Windows drive letter survives.
  ['f.mmetacool::entries/rep1', 'f.mmetacool', '/entries/rep1'],
  // Already absolute: no second slash is prepended.
  ['f.mmetacool::/entries/rep1', 'f.mmetacool', '/entries/rep1'],
  // An empty or root group part is the file root, not an error.
  ['f.mmetacool::', 'f.mmetacool', '/'],
  ['f.mmetacool::/', 'f.mmetacool', '/'],
  ['f.mmetacool::   ', 'f.mmetacool', '/'],
  // Only the *first* '::' splits, so a group path may contain one.
  ['f.mmetacool::entries/a::b', 'f.mmetacool', '/entries/a::b'],
  // Both halves are stripped independently.
  ['f.mmetacool  ::   entries/rep1   ', 'f.mmetacool', '/entries/rep1'],
  // Neither implementation normalises the group path.
  ['f.mmetacool::entries/rep1/', 'f.mmetacool', '/entries/rep1/'],
  ['f.mmetacool::entries//rep1', 'f.mmetacool', '/entries//rep1'],
  ['f.mmetacool::resolutions/1000', 'f.mmetacool', '/resolutions/1000'],
  ['f.mmetacool::entries/__unbinned__', 'f.mmetacool', '/entries/__unbinned__'],
]

/** Inputs whose file half is empty; Python raises `ValueError` on each. */
const REJECTED = ['', '   ', '::group', '   ::group', '::']

describe('parseUri', () => {
  it.each(ACCEPTED)('parse_uri(%j) === (%j, %j)', (raw, path, group) => {
    expect(parseUri(raw)).toEqual({ path, group })
  })

  it.each(REJECTED)('rejects %j with the Python message', (raw) => {
    let thrown: unknown
    try {
      parseUri(raw)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ViewerError)
    expect((thrown as ViewerError).code).toBe('bad-uri')
    // `f"URI has an empty file path: {raw!r}"` — the repr, not JSON quoting,
    // so the two implementations produce the same sentence.
    expect((thrown as ViewerError).message).toBe(
      `URI has an empty file path: '${raw}'`,
    )
    expect((thrown as ViewerError).detail).toEqual({ uri: raw })
  })

  it('keeps the file half exactly as written', () => {
    // The one place the two implementations differ, and deliberately so:
    // Python returns `Path(file_part)`, which normalises `./f.metacool` to
    // `f.metacool`. The JS keeps the raw string because it is handed straight
    // to a byte source — a File object's name, or a URL — where any
    // normalisation would be a corruption rather than a tidy-up.
    expect(parseUri('./f.metacool').path).toBe('./f.metacool')
    expect(parseUri('a//b.metacool').path).toBe('a//b.metacool')
  })

  it('round-trips through formatUri', () => {
    for (const [, path, group] of ACCEPTED) {
      const rebuilt = formatUri(path, group)
      expect(parseUri(rebuilt)).toEqual({ path, group })
    }
    expect(formatUri('f.metacool', '/')).toBe('f.metacool')
    expect(formatUri('f.mmetacool', '/entries/rep1')).toBe('f.mmetacool::/entries/rep1')
  })
})
