/**
 * The notices a build writes for what it carries (`scripts/third-party-notices.mjs`).
 *
 * The plugin itself runs inside a build; what is held here is the part that
 * decides — which module is whose, what an output carried, and what the text
 * says — and, against the packages actually installed, that each licence is
 * found where it lives. A notice that silently stops being written looks like a
 * build that succeeded, which is why the vendored files are checked to exist:
 * renaming one would otherwise drop its upstream's licence without a word.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  NOTICES_TITLE,
  VENDORED,
  collect,
  noticesComment,
  noticesText,
  packageDirOf,
  renderNotices,
} from '../../scripts/third-party-notices.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

describe('which package a module is', () => {
  it('files a module under the package its path is in', () => {
    expect(packageDirOf(`${root}/node_modules/echarts/lib/echarts.js`)).toBe(`${root}/node_modules/echarts`)
    expect(packageDirOf(`${root}/node_modules/@gmod/bbi/esm/index.js`)).toBe(`${root}/node_modules/@gmod/bbi`)
  })

  it('files a nested copy as that copy', () => {
    // echarts' tslib is not the one at the top, and is not the same version.
    expect(packageDirOf(`${root}/node_modules/echarts/node_modules/tslib/tslib.es6.js`)).toBe(
      `${root}/node_modules/echarts/node_modules/tslib`,
    )
  })

  it("reads past a bundler's virtual prefix, its query and a Windows separator", () => {
    expect(packageDirOf(`\0${root}/node_modules/zrender/lib/core/util.js?commonjs-proxy`)).toBe(
      `${root}/node_modules/zrender`,
    )
    expect(packageDirOf('C:\\work\\node_modules\\three\\build\\three.module.js')).toMatch(/\/node_modules\/three$/)
  })

  it('files nothing for our own modules or the bundler’s helpers', () => {
    expect(packageDirOf(`${root}/src/render/luts.ts`)).toBeNull()
    expect(packageDirOf('\0vite/preload-helper.js')).toBeNull()
  })
})

describe('what an output carried', () => {
  it('records the packages and the vendored files that put code into a chunk, and nothing shaken out', () => {
    const into = { packages: new Set<string>(), vendored: new Set<string>() }
    collect(
      {
        'assets/index.js': {
          type: 'chunk',
          modules: {
            [`${root}/node_modules/echarts/lib/echarts.js`]: { renderedLength: 120 },
            // Kept by the bundler with nothing left of it: carried by nothing.
            [`${root}/node_modules/three/build/three.module.js`]: { renderedLength: 0 },
            [`${root}/src/ui/icons.generated.ts`]: { renderedLength: 300 },
            [`${root}/src/app/main.ts`]: { renderedLength: 900 },
          },
        },
        'assets/index.css': { type: 'asset', originalFileNames: [] },
      },
      into,
    )
    expect([...into.packages]).toEqual([`${root}/node_modules/echarts`])
    // The icons file holds two upstreams' work, and both are owed.
    expect([...into.vendored].sort()).toEqual(['Lucide', 'Simple Icons'])
  })

  it('records the package an asset was emitted from', () => {
    const into = { packages: new Set<string>(), vendored: new Set<string>() }
    collect({ 'assets/x.wasm': { type: 'asset', originalFileNames: ['node_modules/h5wasm/dist/x.wasm'] } }, into)
    expect([...into.packages]).toEqual([`${root}/node_modules/h5wasm`])
  })
})

describe('the text', () => {
  const entry = (name: string, extra: object = {}) => ({
    name,
    version: '1.0.0',
    licence: 'MIT',
    url: `https://example.org/${name}`,
    texts: [{ name: 'LICENSE', text: `${name}'s licence\r\n` }],
    ...extra,
  })

  it('lists what the build carries, then reproduces each licence in full', () => {
    const text = renderNotices({
      version: '1.2.3',
      repository: 'https://example.org/chromosomix',
      packages: [entry('alpha'), entry('beta', { author: 'Someone', texts: [] })],
      vendored: [entry('gamma', { version: '', licence: 'ISC', what: 'its icons', files: ['src/x.ts'] })],
    })
    expect(text.startsWith(`${NOTICES_TITLE} for chromosomix 1.2.3\n`)).toBe(true)
    expect(text).toContain('https://example.org/chromosomix')
    expect(text).toContain('Compiled in from npm:\n  alpha 1.0.0 — MIT\n  beta 1.0.0 — MIT\n')
    expect(text).toContain('Copied or ported into the source:\n  gamma — ISC\n')
    expect(text).toContain("alpha's licence")
    expect(text).toContain('What this build holds of it: its icons (src/x.ts).')
    // Said, not left blank: the package declares a licence and ships no text of it.
    expect(text).toContain('The package ships no licence text. Its package.json declares MIT, by Someone.')
    expect(text).not.toContain('\r')
  })

  it('reproduces chromosomix’s own licence first, for the builds that carry no LICENSE beside them', () => {
    const text = renderNotices({
      version: '1.2.3',
      repository: 'https://example.org/c',
      licence: 'GPL-3.0-or-later',
      own: 'GNU GENERAL PUBLIC LICENSE\r\n\r\nCopyright (c) 2026 Somebody\r\n',
      packages: [entry('alpha')],
      vendored: [],
    })
    expect(text).toContain(
      'released under the GNU General Public License, version 3 or (at your option) any later version, reproduced below',
    )
    expect(text).toContain('chromosomix 1.2.3 — GPL-3.0-or-later')
    expect(text.indexOf('Copyright (c) 2026 Somebody')).toBeLessThan(text.indexOf("alpha's licence"))
    expect(text).not.toContain('\r')
  })

  it('says so when a build carries nothing of anybody else’s', () => {
    const text = renderNotices({ version: '1.2.3', repository: 'https://example.org/c', packages: [], vendored: [] })
    expect(text).toContain('This build carries no third-party code.')
  })

  it('reads each licence from where it lives, once per package', () => {
    const text = noticesText({
      packages: new Set([
        `${root}/node_modules/echarts`,
        // One version nested twice is one entry.
        `${root}/node_modules/echarts/node_modules/tslib`,
        `${root}/node_modules/zrender/node_modules/tslib`,
      ]),
      vendored: new Set(['chromosight', 'matplotlib']),
    })
    // echarts' own NOTICE, as Apache-2.0 asks, and the licence of the d3 it embeds.
    expect(text).toContain('Apache ECharts')
    expect(text).toContain('--- licenses/LICENSE-d3 ---')
    expect(text.match(/^ {2}tslib /gm)).toHaveLength(1)
    // The version a generated file was made from, read off its own header.
    expect(text).toContain('matplotlib 3.10.9 — Matplotlib licence (PSF-based)')
    expect(text).toContain('Romain Koszul Laboratory')
  })

  it('reproduces the licence committed for a package that ships none', () => {
    const text = noticesText({ packages: new Set([`${root}/node_modules/generic-filehandle2`]), vendored: new Set() })
    expect(text).toContain('Its package.json declares MIT, by Colin Diesh, which is this.')
    expect(text).toContain('Copyright (c) Colin Diesh')
    // chromosomix's own, ahead of it: the licence package.json declares, in full.
    expect(text).toContain('chromosomix itself is released under the GNU General Public License, version 3')
    expect(text).toContain('Version 3, 29 June 2007')
  })

  it('reproduces every text of an upstream with several', () => {
    const text = noticesText({ packages: new Set(), vendored: new Set(['SciPy', 'NumPy']) })
    for (const file of ['licenses/scipy.txt', 'licenses/xsf.txt', 'licenses/cephes.txt', 'licenses/numpy-random.md']) {
      expect(text).toContain(`--- ${file} ---`)
    }
    expect(text).toContain('Stephen L. Moshier')
    expect(text).toContain('SciPy 1.16.3 — BSD-3-Clause')
  })

  it('names the GPL code chromosomix is ported from, at the version it came from', () => {
    const text = noticesText({ packages: new Set(), vendored: new Set(['yapc', 'IDR']) })
    expect(text).toContain('IDR 2.0.3 — GPL-2.0-or-later')
    expect(text).toContain('yapc 0.1 — GPL-3.0')
    // IDR's own text is version 2 of the GPL, which it licenses "or later".
    expect(text).toContain('Version 2, June 1991')
  })
})

describe('the vendored material', () => {
  it.each(VENDORED.map((entry) => [entry.name, entry] as const))(
    '%s: names files that exist, and a licence that can be read',
    (_name, entry) => {
      for (const file of entry.files) expect(existsSync(`${root}/${file}`)).toBe(true)
      for (const text of [entry.text ?? []].flat()) expect(existsSync(`${root}/${text}`)).toBe(true)
      if (entry.from !== undefined) expect(existsSync(`${root}/node_modules/${entry.from}`)).toBe(true)
    },
  )
})

describe('the single-file form', () => {
  it('is one comment, which nothing inside can end early', () => {
    const comment = noticesComment()
    expect(comment.startsWith(`<!--\n${NOTICES_TITLE}`)).toBe(true)
    expect(comment.endsWith('-->')).toBe(true)
    expect(comment.split('-->')).toHaveLength(2)
  })
})
