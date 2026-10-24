/**
 * The notebook widgets write a view into their frame's fragment in the app's
 * own key order (SPECS §21.5), from a copy of it each keeps —
 * `widgets/python/src/chromosomix/widget.py` and `widgets/r/R/widget.R` —
 * since neither package can read the app's source where it is installed. A key
 * the app adds and a copy lacks still reaches the frame, written after the rest
 * in the order the caller gave it, so nothing there fails: the lower triangle's
 * eight keys (§5.10) went unnoticed so. This holds both copies to
 * `state/ViewState.ts`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** The quoted words of the first `KEY_ORDER` list in a file, in order, its opening and closing given. */
function keyOrder(text: string, opening: RegExp, closing: string): string[] {
  const start = text.search(opening)
  expect(start, String(opening)).toBeGreaterThanOrEqual(0)
  const body = text.slice(start, text.indexOf(closing, start))
  return [...body.matchAll(/['"]([a-z0-9]+)['"]/g)].map(([, key]) => key)
}

const APP = keyOrder(read('src/state/ViewState.ts'), /const KEY_ORDER = \[/, '] as const')

describe("the widgets' copies of the app's key order", () => {
  it('reads the app’s', () => {
    expect(APP.slice(0, 3)).toEqual(['uri', 'uri2', 'maps'])
    expect(APP).toContain('vmax2')
  })

  it('are the app’s, key for key, in the Jupyter widget', () => {
    expect(keyOrder(read('widgets/python/src/chromosomix/widget.py'), /^KEY_ORDER = \(/m, ')')).toEqual(APP)
  })

  it('are the app’s, key for key, in the R widget', () => {
    expect(keyOrder(read('widgets/r/R/widget.R'), /^KEY_ORDER <- c\(/m, ')')).toEqual(APP)
  })
})
