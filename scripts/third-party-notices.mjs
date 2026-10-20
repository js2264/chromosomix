/**
 * The notices a build owes what it carries, written into what it built.
 *
 * chromosomix is MIT, and so is most of what it compiles in — but every one of
 * those licences is a condition on each copy, and a bundle is a copy. echarts
 * is Apache-2.0, which asks for its LICENSE and its NOTICE to travel with the
 * work; zrender, and the HDF5 inside h5wasm, are BSD-style and ask for their
 * notices in any redistribution in binary form; every MIT and ISC licence asks
 * for its copyright line in all copies or substantial portions. Minifying drops
 * the comments that carried them. three.js's two were the only notices that
 * reached `dist/`, and a tarball carried chromosomix's own LICENSE and nobody
 * else's.
 *
 * So every build lists what it carries and reproduces each licence in full, in
 * `THIRD-PARTY-NOTICES.txt` beside its `index.html` — beside the command, for
 * the CLI, and inside the page for the one build that may not be two files.
 *
 * ## Read off the bundle, not off `package.json`
 *
 * A dependency is not a copy, and a copy need not be a dependency. The CLI
 * leaves `h5wasm` and `@gmod/bbi` external, so npm installs each with its own
 * licence and the bundle owes them nothing; `zrender` is nobody's dependency
 * here but echarts', and is in every page that draws a figure. And a module the
 * bundler shook out to nothing is not carried at all. So what is listed is
 * every module that put code into an output, filed under where it came from:
 *
 * - **a package**, found by the `node_modules/` in the module's path, whose
 *   licence files are read from the package as installed;
 * - **material copied or ported into `src/`** — icons, colour tables, a
 *   detector's kernels, and the functions of a reference implementation an
 *   analysis reproduces step for step — found by the file that holds it
 *   (`VENDORED`), whose licence is the installed devDependency a generator
 *   read, or a text committed under `licenses/` where the upstream is not an
 *   npm package.
 *
 * And chromosomix's own licence leads the texts, because the desktop's asar and
 * the standalone page carry no `LICENSE` beside them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** What every build calls the file, beside what it built. */
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt'

/** How the text opens — what a shape check looks for. */
export const NOTICES_TITLE = 'Third-party notices'

/**
 * Material copied or ported into `src/`, by the files that hold it.
 *
 * Each names its upstream, what this repository holds of it and in what form —
 * the summary of changes matplotlib's licence asks a derivative to carry — and
 * where its licence is: `from`, the installed package the generator read, or
 * `text`, one file or several under `licenses/`. Where the file's header
 * records the upstream's version, `version` reads it from there, so the notice
 * names the version the material came from rather than whatever is installed
 * today.
 *
 * A **port** is here when its header says it follows a named implementation
 * function for function, in its order — a translation of that code rather than
 * an implementation of a published method — because a translation is a copy
 * in another language and owes its upstream's licence as a copy does.
 */
export const VENDORED = [
  {
    name: 'Boost-HiC',
    files: ['src/metacooler/boost.ts'],
    licence: 'MIT',
    url: 'https://github.com/LeopoldC/Boost-HiC',
    what: "its enhancement of a sparse map, main.py's BoostHiC and the functions it calls, ported from its Python",
    text: 'licenses/boost-hic.txt',
  },
  {
    name: 'chromosight',
    files: ['src/analysis/chromosightKernels.ts', 'src/analysis/chromosight.ts', 'src/analysis/chromosightPresets.ts'],
    licence: 'MIT',
    url: 'https://github.com/koszullab/chromosight',
    what:
      'its preset pattern kernels, transcribed to eight significant digits by scripts/make_chromosight_kernels.py, ' +
      'their presets, and the detection functions of chromosight/utils/, ported one by one',
    text: 'licenses/chromosight.txt',
  },
  {
    name: 'ColorBrewer',
    files: ['src/render/colormaps.ts'],
    licence: 'Apache-2.0',
    url: 'https://colorbrewer2.org/',
    what: 'the control points of its Reds and RdBu schemes, as matplotlib holds them, which the Reds and RdBu_r ramps are drawn through',
    text: 'licenses/colorbrewer.txt',
  },
  {
    name: 'cooler',
    files: ['src/metacooler/range.ts'],
    licence: 'BSD-3-Clause',
    url: 'https://github.com/open2c/cooler',
    what: 'its region parsing — parse_humanized, _tokenize, parse_region_string and parse_region — ported',
    text: 'licenses/cooler.txt',
  },
  {
    name: 'cooltools',
    files: ['src/analysis/hiccups.ts', 'src/analysis/insulation.ts'],
    version: /cooltools (\d[\w.-]*)/,
    licence: 'MIT',
    url: 'https://github.com/open2c/cooltools',
    what: "the HiCCUPS loop calling of dots(), in its order, and lib.peaks' find_peak_prominence, ported",
    text: 'licenses/cooltools.txt',
  },
  {
    name: 'fdlibm',
    files: ['src/analysis/idr.ts'],
    licence: 'fdlibm notice (Sun Microsystems)',
    url: 'https://www.netlib.org/fdlibm/',
    what: 'the error function of its s_erf.c, transcribed with its coefficients',
    text: 'licenses/fdlibm.txt',
  },
  {
    name: 'Lucide',
    files: ['src/ui/icons.generated.ts'],
    version: /lucide-static (\d[\w.-]*)/,
    licence: 'ISC',
    url: 'https://lucide.dev/',
    what: 'the interface icons, their SVG shapes copied verbatim from lucide-static by scripts/build-icons.mjs',
    from: 'lucide-static',
  },
  {
    name: 'matplotlib',
    files: ['src/render/luts.ts', 'src/render/colormaps.ts'],
    version: /Generated from matplotlib (\d[\w.-]*)/,
    licence: 'Matplotlib licence (PSF-based)',
    url: 'https://matplotlib.org/',
    what:
      'the afmhot, afmhot_r, viridis, magma and cividis colour tables, sampled at 256 entries and stored as RGB ' +
      'without their uniform alpha by scripts/gen_luts.py, and the segment ends of seismic',
    text: 'licenses/matplotlib.txt',
  },
  {
    name: 'NumPy',
    files: ['src/analysis/stats.ts', 'src/metacooler/sampling.ts'],
    licence: 'BSD-3-Clause; numpy.random: NCSA or BSD-3-Clause',
    url: 'https://numpy.org/',
    what:
      'its pairwise summation (pairwise_sum), and the binomial and hypergeometric samplers of numpy.random ' +
      '(random_binomial, random_hypergeometric), ported line for line',
    text: ['licenses/numpy.txt', 'licenses/numpy-random.md'],
  },
  {
    name: 'scikit-learn',
    files: ['src/analysis/birch.ts'],
    version: /scikit-learn (\d[\w.-]*)/,
    licence: 'BSD-3-Clause',
    url: 'https://scikit-learn.org/',
    what: "the BIRCH clustering of its _birch.py, ported",
    text: 'licenses/scikit-learn.txt',
  },
  {
    name: 'SciPy',
    files: ['src/analysis/poisson.ts', 'src/analysis/hiccupsTables.ts', 'src/analysis/idr.ts'],
    version: /SciPy (\d[\w.-]*)/,
    licence: 'BSD-3-Clause',
    url: 'https://scipy.org/',
    what:
      "the cephes functions its xsf carries behind the Poisson tail — pdtrc, igam, igamc, lgam, log1p, expm1 and " +
      'erfc — with the igam_asymp_coeff_d table, and the bounded Brent minimisation of fminbound, ported',
    text: ['licenses/scipy.txt', 'licenses/xsf.txt', 'licenses/cephes.txt'],
  },
  {
    name: 'Simple Icons',
    files: ['src/ui/icons.generated.ts'],
    version: /simple-icons (\d[\w.-]*)/,
    licence: 'CC0-1.0',
    url: 'https://simpleicons.org/',
    what: "the brand marks, their SVG shapes copied verbatim by scripts/build-icons.mjs; each mark remains its owner's trademark",
    from: 'simple-icons',
  },
]

/**
 * What the builds in this process carried: package directories, and the names
 * of the `VENDORED` entries whose files went into an output.
 *
 * Module-level, and that is the point. Vite builds every worker with a Rollup of
 * its own, whose plugins are `worker.plugins` rather than the page's, so the
 * page's plugin never sees a module only a worker compiled in — and the readers,
 * the analysis kernels and h5wasm all live in workers. Both report here instead.
 * A worker's build finishes while the page's is still loading modules, so by the
 * page's `generateBundle` everything is in; and one `vite build` is one config
 * in one process, whose `buildStart` empties this first.
 */
const carried = { packages: new Set(), vendored: new Set() }

/** A module id as a path: absolute, `/`-separated, with no `\0` and no `?query`. */
function pathOf(id) {
  const bare = id.replace(/^\0/, '').replace(/\?.*$/, '')
  return (isAbsolute(bare) ? bare : resolve(ROOT, bare)).split('\\').join('/')
}

/**
 * The directory of the package a module belongs to, or `null` for one of ours.
 *
 * The last `node_modules/` in the path decides, so a copy nested under another
 * package — `echarts/node_modules/tslib` — is that copy; the segment after it is
 * the name, and two segments for a scope.
 */
export function packageDirOf(id) {
  const path = pathOf(id)
  const at = path.lastIndexOf('/node_modules/')
  if (at === -1) return null
  const [first, second] = path.slice(at + '/node_modules/'.length).split('/')
  if (first === undefined || first === '' || first.startsWith('.')) return null
  if (first.startsWith('@') && (second === undefined || second === '')) return null
  return `${path.slice(0, at)}/node_modules/${first.startsWith('@') ? `${first}/${second}` : first}`
}

/**
 * Record every module that put code into `bundle`, and every file an asset was
 * emitted from.
 *
 * A module the bundler kept but rendered to nothing — its exports all shaken
 * out — is listed with `renderedLength: 0`, and carries nothing.
 */
export function collect(bundle, into = carried) {
  for (const output of Object.values(bundle)) {
    const ids =
      output.type === 'chunk'
        ? Object.entries(output.modules)
            .filter(([, module]) => module.renderedLength > 0)
            .map(([id]) => id)
        : (output.originalFileNames ?? [])
    for (const id of ids) {
      const dir = packageDirOf(id)
      if (dir !== null) {
        into.packages.add(dir)
        continue
      }
      const file = relative(ROOT, pathOf(id)).split('\\').join('/')
      for (const entry of VENDORED) if (entry.files.includes(file)) into.vendored.add(entry.name)
    }
  }
}

/** Licence first, then copying, then notice, then the rest; alphabetical within each. */
function rankOf(name) {
  const lower = name.toLowerCase()
  if (lower.startsWith('licen')) return 0
  if (lower.startsWith('copying')) return 1
  if (lower.startsWith('notice')) return 2
  return 3
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyrightnotice)/i

/**
 * Every licence, copying and notice file a package ships at its root — and
 * everything under `licenses/`, where echarts keeps the licences of the code it
 * embeds from elsewhere (d3's).
 */
function licenceTexts(dir) {
  const texts = []
  const read = (folder, every) => {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return
    const names = readdirSync(folder)
      .filter((name) => every || LICENCE_FILE.test(name))
      .sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
    for (const name of names) {
      const path = join(folder, name)
      if (!statSync(path).isFile()) continue
      texts.push({ name: relative(dir, path).split('\\').join('/'), text: readFileSync(path, 'utf8') })
    }
  }
  read(dir, false)
  read(join(dir, 'licenses'), true)
  return texts
}

/** A repository field as an address: `git+…`, `….git` and the `owner/repo` shorthand unwound. */
function repositoryOf(manifest) {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? '')
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
}

/**
 * The licence committed under `licenses/` for a package that ships none of its
 * own, or `null`: `generic-filehandle2` declares MIT in its package.json and
 * has no text of it, in the tarball or upstream, and MIT asks for the text.
 */
function committedLicence(name) {
  const file = `licenses/${name.replace(/^@/, '').replaceAll('/', '-')}.txt`
  return existsSync(join(ROOT, file)) ? { name: file, text: readFileSync(join(ROOT, file), 'utf8') } : null
}

function describePackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const declared =
    typeof manifest.license === 'string'
      ? manifest.license
      : (manifest.license?.type ??
        (Array.isArray(manifest.licenses) ? manifest.licenses.map((entry) => entry.type).join(' OR ') : 'UNKNOWN'))
  return {
    name: manifest.name ?? dir.split('/').pop(),
    version: manifest.version ?? '',
    // npm's spelling for a licence with no SPDX name — h5wasm's, NIST's notice
    // with HDF5's beside it — which reads as a sentence in a list of names.
    licence: declared.replace(/^SEE LICEN[CS]E IN (.+)$/i, 'see its $1, below'),
    url: manifest.homepage ?? repositoryOf(manifest),
    author: typeof manifest.author === 'string' ? manifest.author : (manifest.author?.name ?? ''),
    ...shipped(licenceTexts(dir), manifest.name ?? ''),
  }
}

/** A package's own licence texts, or the committed one standing in for none. */
function shipped(texts, name) {
  if (texts.length > 0) return { texts }
  const committed = committedLicence(name)
  return committed === null ? { texts } : { texts: [committed], substitute: true }
}

function describeVendored(entry) {
  const source = entry.files.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n')
  let texts
  if (entry.from !== undefined) {
    const dir = join(ROOT, 'node_modules', entry.from)
    if (!existsSync(dir)) {
      // Thrown rather than written around: a build that quietly drops a notice
      // is the failure this file exists to prevent.
      throw new Error(
        `third-party notices: ${entry.name}'s licence is read from node_modules/${entry.from}, ` +
          'which is not installed — run `npm ci`',
      )
    }
    texts = licenceTexts(dir)
    if (texts.length === 0) throw new Error(`third-party notices: node_modules/${entry.from} ships no licence text`)
  } else {
    texts = [entry.text].flat().map((file) => ({ name: file, text: readFileSync(join(ROOT, file), 'utf8') }))
  }
  return {
    name: entry.name,
    version: entry.version?.exec(source)?.[1] ?? '',
    licence: entry.licence,
    url: entry.url,
    what: entry.what,
    files: entry.files,
    texts,
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })

/**
 * The text, from what was found.
 *
 * Plain text and hard to misread: the list first, so a reader sees in ten lines
 * what the build carries, then each licence in full under a rule of its own.
 */
export function renderNotices({ version, repository, own, packages, vendored }) {
  const rule = '='.repeat(72)
  const titleOf = (entry) => `${entry.name}${entry.version === '' ? '' : ` ${entry.version}`} — ${entry.licence}`
  const out = [
    `${NOTICES_TITLE} for chromosomix ${version}`,
    '',
    own === undefined
      ? `chromosomix itself is released under the MIT licence: LICENSE, in the package and in its repository, ${repository}.`
      : `chromosomix itself is released under the MIT licence, reproduced below and in its repository, ${repository}.`,
  ]
  const ownText = () => {
    if (own === undefined) return
    out.push('', rule, `chromosomix ${version} — MIT`, repository, rule, '', own.replace(/\r\n?/g, '\n').trimEnd())
  }
  if (packages.length === 0 && vendored.length === 0) {
    out.push('', 'This build carries no third-party code.')
    ownText()
    return `${out.join('\n')}\n`
  }
  out.push(
    'This build also carries the work of the projects below, each under its own licence, which is reproduced in full after the list.',
  )
  if (packages.length > 0) out.push('', 'Compiled in from npm:', ...packages.map((entry) => `  ${titleOf(entry)}`))
  if (vendored.length > 0) {
    out.push('', 'Copied or ported into the source:', ...vendored.map((entry) => `  ${titleOf(entry)}`))
  }
  ownText()
  for (const entry of [...packages, ...vendored]) {
    out.push('', rule, titleOf(entry))
    if (entry.url !== '') out.push(entry.url)
    if (entry.what !== undefined) out.push(`What this build holds of it: ${entry.what} (${entry.files.join(', ')}).`)
    out.push(rule)
    if (entry.texts.length === 0) {
      out.push(
        '',
        `The package ships no licence text. Its package.json declares ${entry.licence}` +
          `${entry.author ? `, by ${entry.author}` : ''}.`,
      )
    } else if (entry.substitute === true) {
      out.push(
        '',
        `The package ships no licence text. Its package.json declares ${entry.licence}` +
          `${entry.author ? `, by ${entry.author}` : ''}, which is this.`,
      )
    }
    for (const text of entry.texts) {
      if (entry.texts.length > 1) out.push('', `--- ${text.name} ---`)
      out.push('', text.text.replace(/\r\n?/g, '\n').trimEnd())
    }
  }
  return `${out.join('\n')}\n`
}

/** The text for what the builds in this process carried. */
export function noticesText(from = carried) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const seen = new Map()
  for (const dir of from.packages) {
    const entry = describePackage(dir)
    // One package nested twice — echarts' tslib and zrender's — is one entry.
    seen.set(`${entry.name}@${entry.version}`, entry)
  }
  return renderNotices({
    version: manifest.version,
    repository: repositoryOf(manifest),
    own: readFileSync(join(ROOT, 'LICENSE'), 'utf8'),
    packages: [...seen.values()].sort(byName),
    vendored: VENDORED.filter((entry) => from.vendored.has(entry.name)).map(describeVendored).sort(byName),
  })
}

/**
 * The text as an HTML comment, for the build that is one file.
 *
 * A comment is the one place in a page that no parser, policy or script reads.
 * The only sequence that could end it early is `-->`, which no licence text
 * holds, and which is broken up should one ever do.
 */
export function noticesComment() {
  return `<!--\n${noticesText().replaceAll('-->', '-- >').replaceAll('--!>', '--! >')}-->`
}

/**
 * The page's plugin: it empties the record, collects the page's own chunks, and
 * emits the notices for those and for every worker's.
 *
 * `fileName: null` collects without emitting, for the standalone build, whose
 * single-file step writes the text into the page itself (`noticesComment`).
 * Last in a config's `plugins`, so that `generateBundle` runs after the
 * service worker's has listed the files to precache: the notices are for
 * reading, not for working offline.
 */
export function thirdPartyNotices({ fileName = NOTICES_FILE } = {}) {
  return {
    name: 'chromosomix-third-party-notices',
    apply: 'build',
    buildStart() {
      carried.packages.clear()
      carried.vendored.clear()
    },
    generateBundle(_options, bundle) {
      collect(bundle)
      if (fileName !== null) this.emitFile({ type: 'asset', fileName, source: noticesText() })
    },
  }
}

/** A worker's plugin, in `worker.plugins`: it collects, and the page's emits. */
export function thirdPartyCollector() {
  return {
    name: 'chromosomix-third-party-collector',
    apply: 'build',
    generateBundle(_options, bundle) {
      collect(bundle)
    },
  }
}
