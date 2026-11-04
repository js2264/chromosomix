/**
 * A pull request's preview of the documentation (SPECS §32.5): built by the
 * preview workflow beside the pull request's app, at `pr/<number>/docs/`, with
 * its live views on that app.
 *
 * The workflow cannot be run here, so what is held is its shape: the docs are
 * built for the preview's path with the preview's app, copied into the
 * preview's own directory *before* the archive is written — which is what lets
 * the archive, the deploy and the removal on `closed` carry them with nothing
 * of their own — and built without the commit, so a page a push did not change
 * is the same bytes as before. And documentation that does not build costs the
 * pull request its documentation, not its app's preview.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { previewOf } from '../../documentation/src/lib/site.mjs'

const workflow = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'preview.yml'), 'utf8')

/** The text of the job's step named `name`, up to the next step. */
function step(name: string): string {
  const at = workflow.indexOf(`      - name: ${name}\n`)
  expect(at, `a step named ${name}`).toBeGreaterThanOrEqual(0)
  const rest = workflow.slice(at + 1)
  const next = rest.search(/\n {6}- /)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('a preview copy of the documentation', () => {
  it('is a pull request’s number, and nothing else is', () => {
    expect(previewOf('158')).toBe(158)
    expect(previewOf(' 12 ')).toBe(12)
    for (const value of [undefined, '', '0', '-3', 'abc', '1.5']) expect(previewOf(value)).toBeNull()
  })

  it('is built for the preview’s path, with the preview’s own app, and without the commit', () => {
    const build = step("Build the documentation's preview")
    expect(build).toContain('DOCS_BASE: ${{ steps.base.outputs.path }}pr/${{ github.event.number }}/docs/')
    expect(build).toContain('DOCS_APP_URL: ${{ steps.base.outputs.url }}')
    expect(build).toContain('DOCS_PREVIEW: ${{ github.event.number }}')
    // Set by no step: the comment that says why may name it.
    expect(workflow).not.toMatch(/^\s*DOCS_COMMIT:/m)
  })

  it('goes into the preview’s directory before the archive is written', () => {
    const copied = workflow.indexOf('cp -R documentation/dist dist-pinned/docs')
    const archived = workflow.indexOf('node scripts/archive-preview.mjs archive dist-pinned')
    expect(copied).toBeGreaterThan(0)
    expect(archived).toBeGreaterThan(copied)
  })

  it('may fail without taking the app’s preview with it', () => {
    const install = step("Install the documentation's own packages")
    const build = step("Build the documentation's preview")
    for (const one of [install, build]) expect(one).toContain('continue-on-error: true')
    expect(install).toContain('id: docs-install')
    expect(build).toContain('id: docs')
    expect(build).toContain("steps.docs-install.outcome == 'success'")
    // The copy is the build's last command, under `set -e`: a failed build copies nothing.
    expect(build).toMatch(/set -euo pipefail\n\s*npm run docs:build\n\s*cp -R documentation\/dist dist-pinned\/docs\n/)
  })

  it('is named in the pull request’s comment when it was built, and missed when it was not', () => {
    expect(workflow).toContain('DOCS: ${{ steps.docs.outcome }}')
    expect(workflow).toContain("const docs = DOCS === 'success'")
    expect(workflow).toContain('`**Documentation:** ${PREVIEW_URL}docs/`')
    expect(workflow).toMatch(/\*\*Documentation:\*\* not built from this push; \[its run\]\(\$\{RUN_URL\}\)/)
  })
})
