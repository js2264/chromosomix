/**
 * What the documentation site reads from the app (SPECS §32,
 * `scripts/docs-data.mjs` and `src/documentation/data.ts`).
 *
 * Three readers of the repository's own files — the changelog, the stylesheet
 * and the validation notebook — and the rule that every task has a page. The
 * site's build refuses a task with no page too; this test says so earlier, in
 * the suite a pull request already runs.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { taskCatalogue } from '@/analysis/catalogue'
import { USAGE } from '@/cli/main'
import { DOCS_URL } from '@/documentation/site'
import { TASK_REFERENCES } from '@/analysis/references'
import { asSitePage, PAGE_HOMES, unlabelled } from '@/documentation/data'
import { resetDevFeatures } from '@/state/devFeatures'

import { appTokens, changelogReleases, longDate, pandocId, validationAnchors } from '../../scripts/docs-data.mjs'

const ROOT = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

describe('the validation’s sections', () => {
  it('are addressed as pandoc writes a heading’s identifier', () => {
    expect(pandocId('1 · Diamond insulation')).toBe('diamond-insulation')
    expect(pandocId('8 · 3D model (pastis-NB)')).toBe('d-model-pastis-nb')
    expect(pandocId('12 · APA, chromosight’s score')).toBe('apa-chromosights-score')
    expect(pandocId('CTCF sites in GM12878 (Fig. 2)')).toBe('ctcf-sites-in-gm12878-fig.-2')
  })

  it('include every section a task cites', () => {
    const anchors = validationAnchors(read('notebooks/validation.qmd'))
    for (const [task, reference] of Object.entries(TASK_REFERENCES)) {
      if (reference.section === undefined) continue
      expect(anchors[reference.section], `${task} cites section ${reference.section}`).toMatch(/^https:\/\/chromosomix\.app\/validation\/#[a-z]/)
    }
  })
})

describe('the release notes', () => {
  const sample = [
    '# Changelog',
    '',
    'Intro.',
    '',
    '## [Unreleased]',
    '',
    '### Fixed',
    '',
    '- A thing.',
    '',
    '## [0.19.0] - 2026-11-01',
    '',
    '### Added',
    '',
    '#### Detail',
    '',
    '- Another.',
    '',
    '## [0.1.0] - unreleased',
    '',
    'Never tagged.',
  ].join('\n')

  it('are one per release, newest first, with their headings raised a level', () => {
    const releases = changelogReleases(sample)
    expect(releases.map((release) => release.version)).toEqual(['0.19.0', '0.1.0'])
    expect(releases[0].date).toBe('2026-11-01')
    expect(releases[0].body).toBe('## Added\n\n### Detail\n\n- Another.')
    expect(releases[1].date).toBeNull()
  })

  it('carry the unreleased changes only for main’s copy, and only when there are some', () => {
    expect(changelogReleases(sample, { unreleased: true })[0]).toEqual({ version: 'Unreleased', date: null, body: '## Fixed\n\n- A thing.' })
    expect(changelogReleases(sample.replace('### Fixed\n\n- A thing.\n', ''), { unreleased: true })[0].version).toBe('0.19.0')
  })

  it('read the real changelog', () => {
    const releases = changelogReleases(read('CHANGELOG.md'))
    expect(releases.length).toBeGreaterThan(10)
    expect(releases.every((release) => /^\d+\.\d+\.\d+$/.test(release.version))).toBe(true)
  })

  it('date a release as a reader writes it', () => {
    expect(longDate('2026-11-01')).toBe('1 November 2026')
  })
})

describe('the theme’s tokens', () => {
  it('are the app’s, dark on the root and light under its attribute', () => {
    const css = appTokens(read('src/ui/styles.css'))
    expect(css).toMatch(/:root,\n::backdrop \{\n {2}--cx-bg: #/)
    expect(css).toMatch(/:root\[data-theme='light'\],\n\[data-theme='light'\] ::backdrop \{\n {2}--cx-bg: #/)
    for (const token of ['accent', 'border', 'text-dim', 'shadow-1', 'sans', 'mono', 'radius']) expect(css).toContain(`--cx-${token}:`)
  })

  it('refuse a stylesheet that no longer declares one', () => {
    const css = read('src/ui/styles.css').replace(/--accent-soft:/g, '--accent-softer:')
    expect(() => appTokens(css)).toThrow(/--accent-soft/)
  })
})

describe('the pages written from the app', () => {
  it('lift the title and summary out, and point links to models’ pages at the site’s', () => {
    const page = asSitePage('reference/x.md', '# A title\n\n> A *short* summary,\n> on two lines.\n\nSee [tasks](https://chromosomix.app/llms/tasks.md) and [the app](https://chromosomix.app/).\n')
    expect(page.title).toBe('A title')
    expect(page.description).toBe('A short summary, on two lines.')
    expect(page.markdown).toBe(`See [tasks](${PAGE_HOMES['llms/tasks.md']}) and [the app](https://chromosomix.app/).\n`)
  })

  it('say what a parameter does without repeating its label', () => {
    expect(unlabelled('window', 'Window: The diamond is a square.')).toBe('The diamond is a square.')
    expect(unlabelled('sequences', 'Sequences.')).toBe('')
    expect(unlabelled('use balancing weights', 'Use balancing weights. *Read only under other settings of this task.*')).toBe(
      '*Read only under other settings of this task.*',
    )
  })
})

describe('every task', () => {
  it('has a page on the documentation site, and every page there is a task’s or a guide', () => {
    resetDevFeatures(false)
    const ids = taskCatalogue().map((task) => task.id)
    const directory = join(ROOT, 'documentation', 'src', 'content', 'docs', 'analyses')
    expect(existsSync(directory)).toBe(true)
    const pages = readdirSync(directory)
      .filter((name) => /\.mdx?$/.test(name))
      .map((name) => name.replace(/\.mdx?$/, ''))
      .filter((name) => name !== 'index' && name !== 'validation')
    expect([...pages].sort()).toEqual([...ids].sort())
  })
})

describe('the doors to the site', () => {
  it('open its root, which every copy is a menu away from', () => {
    expect(DOCS_URL).toBe('https://doc.chromosomix.app/')
  })

  it('end the command’s --help', () => {
    expect(USAGE.trimEnd().endsWith(DOCS_URL)).toBe(true)
  })
})
