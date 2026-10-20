/**
 * Whose work this viewer is built with, as *About* names it.
 *
 * The short form of `THIRD-PARTY-NOTICES.txt`, which every build writes
 * (`scripts/third-party-notices.mjs`, SPECS §22.4) and which is the record: it
 * is read off the bundle, version for version, and reproduces each licence in
 * full. This list is what a reader can take in at a glance — the project, what
 * it does here, and its licence — so it names a project by what it is for and
 * folds a dependency in with what pulls it in: the libraries compiled in, the
 * reference implementations an analysis is ported from, and the material a
 * generator copied. `test/unit/licences.test.ts`
 * holds it to the notices and to the README, so neither can name a project
 * this leaves out.
 */

import { HOMEPAGE, TARGET } from './version'

/** One line of *About*'s list. */
export interface Licensed {
  /** As the project calls itself. */
  name: string
  /** What it brings along that a build carries too, if anything: `with ZRender and tslib`. */
  with?: string
  /** Its home, which the name links to. */
  url: string
  /** What it does in this viewer. */
  what: string
  /** Its licence, or licences, by SPDX identifier where there is one. */
  licence: string
  /**
   * The names `THIRD-PARTY-NOTICES.txt` files it under: npm packages by name,
   * material copied into `src/` by its `VENDORED` entry.
   */
  covers: readonly string[]
}

export const LICENSED: readonly Licensed[] = [
  // Compiled in from npm.
  {
    name: 'three.js',
    url: 'https://threejs.org/',
    what: 'draws the 3D models',
    licence: 'MIT',
    covers: ['three'],
  },
  {
    name: 'Apache ECharts',
    with: 'with ZRender and tslib',
    url: 'https://echarts.apache.org/',
    what: 'draws the analysis charts',
    licence: 'Apache-2.0, BSD-3-Clause, 0BSD',
    covers: ['echarts', 'zrender', 'tslib'],
  },
  {
    name: 'h5wasm',
    with: 'with the HDF5 library',
    url: 'https://github.com/usnistgov/h5wasm',
    what: 'reads cooler and other HDF5 files',
    licence: 'NIST notice, BSD-style',
    covers: ['h5wasm'],
  },
  {
    name: '@gmod/bbi',
    with: 'with generic-filehandle2',
    url: 'https://github.com/GMOD/bbi-js',
    what: 'reads bigWig and bigBed files',
    licence: 'MIT',
    covers: ['@gmod/bbi', 'generic-filehandle2', '@gmod/abortable-promise-cache', '@jbrowse/quick-lru'],
  },
  // Ported: an analysis that follows its reference function for function.
  {
    name: 'cooltools',
    with: 'with cooler',
    url: 'https://github.com/open2c/cooltools',
    what: 'loop calling, insulation peaks, region strings',
    licence: 'MIT, BSD-3-Clause',
    covers: ['cooltools', 'cooler'],
  },
  {
    name: 'chromosight',
    url: 'https://github.com/koszullab/chromosight',
    what: 'pattern detection and its kernels',
    licence: 'MIT',
    covers: ['chromosight'],
  },
  {
    name: 'SciPy',
    with: 'with cephes',
    url: 'https://scipy.org/',
    what: 'the Poisson tail and a minimiser',
    licence: 'BSD-3-Clause',
    covers: ['SciPy'],
  },
  {
    name: 'NumPy',
    url: 'https://numpy.org/',
    what: 'exact sums and the resampling draws',
    licence: 'BSD-3-Clause, NCSA',
    covers: ['NumPy'],
  },
  {
    name: 'scikit-learn',
    url: 'https://scikit-learn.org/',
    what: 'the clustering of called loops',
    licence: 'BSD-3-Clause',
    covers: ['scikit-learn'],
  },
  {
    name: 'Boost-HiC',
    url: 'https://github.com/LeopoldC/Boost-HiC',
    what: 'enhancing a sparse map',
    licence: 'MIT',
    covers: ['Boost-HiC'],
  },
  {
    name: 'fdlibm',
    url: 'https://www.netlib.org/fdlibm/',
    what: 'the error function',
    licence: 'Sun Microsystems notice',
    covers: ['fdlibm'],
  },
  // Copied in by a generator.
  {
    name: 'matplotlib',
    with: 'with ColorBrewer',
    url: 'https://matplotlib.org/',
    what: 'the colour tables',
    licence: 'Matplotlib licence, Apache-2.0',
    covers: ['matplotlib', 'ColorBrewer'],
  },
  {
    name: 'Lucide',
    url: 'https://lucide.dev/',
    what: 'the interface icons',
    licence: 'ISC',
    covers: ['Lucide'],
  },
  {
    name: 'Simple Icons',
    url: 'https://simpleicons.org/',
    what: 'the brand marks',
    licence: 'CC0-1.0',
    covers: ['Simple Icons'],
  },
]

/**
 * Where this build's notices can be read, as a link.
 *
 * Beside the page wherever there is a page served from somewhere — the site,
 * an archived pin, the npm package's `dist/` — so a pinned or vendored copy
 * links the notices of what it actually carries. The desktop's are inside its
 * asar, where a link would replace the app rather than open a text file, and a
 * standalone page carries its own as a comment it cannot link to; both link
 * the site's, which names the same projects.
 */
export function noticesUrl(): string {
  const file = 'THIRD-PARTY-NOTICES.txt'
  if (TARGET !== 'web' && HOMEPAGE !== '') return new URL(file, HOMEPAGE).href
  if (typeof document === 'undefined') return file
  return new URL(file, document.baseURI).href
}
