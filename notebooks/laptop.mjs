#!/usr/bin/env node
/**
 * What genome-wide tasks cost on the machine this is run on: time and memory.
 *
 * `notebooks/timing.qmd` says how fast each analysis is against the package it reproduces, on a
 * GitHub runner, and needs the whole of validation.qmd's environment to say it. This answers the
 * question a reader asks first — *will it run on my laptop, and how long will I wait?* — with
 * nothing but Node and a clone. Each task below runs genome-wide through `chromosomix`, whose
 * kernels are the ones the Analysis panel runs in its worker (src/cli/main.ts says why they are the
 * same code), on the validation's own public data and on 4DN's 7 GB mouse map. All of them run once,
 * then all of them again, `--runs` times (three unless told), each run a fresh process, so that a
 * slow minute of the machine falls on every task rather than on one.
 *
 * ## What is measured
 *
 * - **Wall-clock seconds**, from starting the process to its exit: Node's own start and the
 *   bundle's load are in it, as they are in a reader's wait.
 * - **CPU seconds**, user and system, of every thread of the process. `chromosomix` computes on
 *   one, so the number of cores does not change the answer and the speed of one does; V8 collects
 *   and compiles on threads of its own beside it, which is why CPU time can exceed the wall clock.
 * - **Peak memory**: the largest resident set the process reached, the high-water mark the
 *   system keeps for it (`ru_maxrss`). The V8 heap, the WebAssembly memory h5wasm reads the file
 *   through, and every buffer are in it.
 *
 * CPU time and peak memory are read by the process itself as it exits, from a hook loaded with
 * `--import`: `process.resourceUsage()` is `getrusage` on every system Node runs on, so these are
 * the numbers `/usr/bin/time` reports, with no `/usr/bin/time` needed and the same units on macOS
 * as on Linux. A task's first run may read its files from the disk and the later ones from the
 * page cache; the range in the summary shows it where it matters.
 *
 * ## The data
 *
 * Fetched once, each file held to its size and MD5, into the folders the two notebooks fetch the
 * same files into — `notebooks/work/validation/data/` and `notebooks/work/viewers/data/` — so a
 * machine that rendered either already has them. About 12.4 GB in all, 7 GB of it the deep mouse
 * map; `--skip deep` leaves it out. The mm10 sequence is indexed beside itself (`mm10.fa.fai`),
 * as `samtools faidx` would, so that every task reads it by range.
 *
 * ## What it writes, in notebooks/work/laptop/
 *
 * - `runs.tsv`: one row per run — the task, the run, its seconds and megabytes, its status and the
 *   notes it printed — with the machine and the build in every row; rewritten after every run,
 *   so a benchmark stopped part of the way keeps what it finished.
 * - `summary.tsv` and `summary.md`: one row per task, the median wall-clock time with its range,
 *   the median CPU time and the peak memory of the largest run; the Markdown names the machine
 *   and lists every command, ready for a supplementary table.
 * - `out/<task>/`: each task's outputs from its last run. Two tasks read another's: the pileup
 *   the loops chromosight called, the overlap the peaks called.
 *
 * Usage, from the root of a clone, on a machine on mains power and otherwise idle:
 *
 *   npm ci
 *   node notebooks/laptop.mjs                    # every task, three runs each
 *   node notebooks/laptop.mjs --list             # the tasks, and what would be fetched
 *   node notebooks/laptop.mjs --runs 1 --skip deep,peaks
 *   node notebooks/laptop.mjs --only mouse       # a group, or tasks by name
 *
 * It builds the command line first (`vite build --config vite.cli.config.ts`); `--no-build` times
 * `dist-cli/` as it is.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, statfsSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, arch, totalmem, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(REPO, 'dist-cli', 'chromosomix.mjs')
const WORK = join(REPO, 'notebooks', 'work', 'laptop')
const VALIDATION_DATA = join(REPO, 'notebooks', 'work', 'validation', 'data')
const VIEWERS_DATA = join(REPO, 'notebooks', 'work', 'viewers', 'data')

const FOURDN = 'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput'
const IGENOMES = 'https://ngi-igenomes.s3.amazonaws.com/igenomes/Mus_musculus/UCSC/mm10'
const GEO = 'https://ftp.ncbi.nlm.nih.gov/geo/series'

/** Every file a task reads, by key: where it is published, its size and MD5, and where it is kept. */
const FILES = {
  mouse: { url: `${FOURDN}/727b405d-c9f5-4b13-ae58-1dbf29d19a8f/4DNFIOZ1TRUS.mcool`, dir: VALIDATION_DATA,
    bytes: 691_211_389, md5: '503fea3d171e9c5c7f8a5403af73481e' },
  deep: { url: `${FOURDN}/ef0eba47-ada0-42bc-9329-5145b57ff33a/4DNFI5QJNFAT.mcool`, dir: VIEWERS_DATA,
    bytes: 7_033_416_901, md5: '18bd736467fd20ca0181698e119595e3' },
  yeast: { url: `${GEO}/GSE151nnn/GSE151553/suppl/GSE151553_A364_merged.mcool`, dir: VALIDATION_DATA,
    bytes: 122_583_793, md5: '319a04a8d7e41d9eb88e2378ea3ea373' },
  atac1: { url: `${FOURDN}/7fb6d419-a8de-4bc8-9c17-f68f814496a2/4DNFIIY4QW2D.bw`, dir: VALIDATION_DATA,
    bytes: 957_735_625, md5: '9f8a3a413f54129a689548a93584cdf4' },
  atac2: { url: `${FOURDN}/e567a80e-c7d2-41ff-b12d-67047906c076/4DNFITBRHVZE.bw`, dir: VALIDATION_DATA,
    bytes: 735_410_469, md5: '99c928ea99ee1a2a7ec7091260f1e4be' },
  mm10: { url: `${IGENOMES}/Sequence/WholeGenomeFasta/genome.fa`, name: 'mm10.fa', dir: VALIDATION_DATA,
    bytes: 2_780_048_573, md5: '34d90c586dc92f5c3e8df3ed24530f4f' },
  genes: { url: `${IGENOMES}/Annotation/Genes/genes.gtf`, name: 'mm10.genes.gtf', dir: VALIDATION_DATA,
    bytes: 94_926_257, md5: '543ec24bb11a4ff0cf5aa4f695320b82' },
}
for (const file of Object.values(FILES)) {
  file.path = join(file.dir, file.name ?? decodeURIComponent(file.url.slice(file.url.lastIndexOf('/') + 1)))
}

/** Each group of tasks: the data it reads, as the summary names it. */
const GROUPS = {
  mouse: 'Mouse Hi-C, mm10, 69 M contacts (4DN 4DNFIOZ1TRUS)',
  deep: 'Mouse Hi-C, mm10, 1.07 billion contacts (4DN 4DNFI5QJNFAT)',
  yeast: 'Yeast Micro-C, 51 M contacts (GEO GSE151553)',
  tracks: 'Mouse ATAC-seq, two replicates, and the mm10 sequence and RefSeq genes',
}

/** A map's rung, as a path relative to the clone: what every command names. */
const at = (key, bp) => `${rel(FILES[key].path)}::/resolutions/${bp}`
const path = (key) => rel(FILES[key].path)
/** The first file in a task's output folder whose name ends with `suffix`: what a later task reads. */
const output = (id, suffix) => {
  const folder = join(WORK, 'out', id)
  const found = existsSync(folder) ? readdirSync(folder).sort().find((name) => name.endsWith(suffix)) : undefined
  if (found === undefined) throw new Error(`${id} wrote no *${suffix} for the task after it to read`)
  return rel(join(folder, found))
}

/** How many features a file holds: its lines, but for blank ones and a header. */
const count = (file) => readFileSync(join(REPO, file), 'utf8').split('\n')
  .filter((line) => line.trim() && !/^(#|track|browser)/.test(line)).length

/**
 * The tasks, in the order a round runs them. `size` is what the task works over, worked out from
 * the files once (they are held to their MD5s), or counted as it runs where it is another task's
 * output; `needs` is that task, which a round runs first; `args` are the command's words after
 * `chromosomix`, a function where they name the other task's output.
 */
const TASKS = [
  { id: 'coverage', group: 'mouse', what: 'Coverage, balanced', bp: 10_000, size: '272,564 bins',
    files: ['mouse'], args: ['coverage', at('mouse', 10_000), '--balance'] },
  { id: 'expected', group: 'mouse', what: 'P(s), the whole genome', bp: 10_000, size: '272,564 bins',
    files: ['mouse'], args: ['expected', at('mouse', 10_000), '--quantity', 'expected', '--scope', 'file'] },
  { id: 'insulation', group: 'mouse', what: 'Diamond insulation, 100 kb window, boundaries called', bp: 10_000,
    size: '272,564 bins', files: ['mouse'], args: ['insulation', at('mouse', 10_000), '--window', '10'] },
  { id: 'di', group: 'mouse', what: 'Directionality index, 2 Mb window, borders called', bp: 50_000,
    size: '54,520 bins', files: ['mouse'], args: ['di', at('mouse', 50_000), '--window', '40'] },
  { id: 'compartments', group: 'mouse', what: 'Compartments: 3 eigenvectors, phased by GC, saddle', bp: 100_000,
    size: '27,268 bins', files: ['mouse', 'mm10'],
    args: ['compartments', at('mouse', 100_000), '--components', '3', '--sequence', path('mm10'),
      '--phaseSequence', path('mm10')] },
  { id: 'loops', group: 'mouse', what: 'Loop calling (cooltools dots), to 10 Mb', bp: 10_000,
    size: '272,564 bins', files: ['mouse'], args: ['loops', at('mouse', 10_000)] },
  { id: 'chromosight', group: 'mouse', what: 'Pattern detection, loops (chromosight), to 2 Mb', bp: 10_000,
    size: '272,564 bins', files: ['mouse'], args: ['chromosight', at('mouse', 10_000), '--pattern', 'loops'] },
  { id: 'apa', group: 'mouse', what: 'Aggregate peak analysis over the loops chromosight called', bp: 10_000,
    size: () => `${grouped(count(output('chromosight', '.bedpe')))} loops`, files: ['mouse'],
    needs: 'chromosight', args: () => ['apa', at('mouse', 10_000), '--pairs', output('chromosight', '.bedpe')] },
  { id: 'model', group: 'mouse', what: '3D model of the genome (pastis-NB)', bp: 1_000_000, size: '2,737 bins',
    files: ['mouse'], args: ['reconstruct3d', at('mouse', 1_000_000), '--method', 'nb', '--alpha', '3'] },

  { id: 'deep-coverage', group: 'deep', what: 'Coverage, balanced', bp: 10_000, size: '272,564 bins',
    files: ['deep'], args: ['coverage', at('deep', 10_000), '--balance'] },
  { id: 'deep-expected', group: 'deep', what: 'P(s), the whole genome', bp: 10_000, size: '272,564 bins',
    files: ['deep'], args: ['expected', at('deep', 10_000), '--quantity', 'expected', '--scope', 'file'] },
  { id: 'deep-insulation', group: 'deep', what: 'Diamond insulation, 100 kb window, boundaries called',
    bp: 10_000, size: '272,564 bins', files: ['deep'], args: ['insulation', at('deep', 10_000), '--window', '10'] },
  { id: 'deep-compartments', group: 'deep', what: 'Compartments: 3 eigenvectors, phased by GC, saddle',
    bp: 100_000, size: '27,268 bins', files: ['deep', 'mm10'],
    args: ['compartments', at('deep', 100_000), '--components', '3', '--sequence', path('mm10'),
      '--phaseSequence', path('mm10')] },
  { id: 'deep-loops', group: 'deep', what: 'Loop calling (cooltools dots), to 10 Mb', bp: 10_000,
    size: '272,564 bins', files: ['deep'], args: ['loops', at('deep', 10_000)] },

  { id: 'yeast-expected', group: 'yeast', what: 'P(s), the whole genome', bp: 50, size: '243,150 bins',
    files: ['yeast'], args: ['expected', at('yeast', 50), '--quantity', 'expected', '--scope', 'file'] },
  { id: 'yeast-chromosight', group: 'yeast', what: 'Pattern detection, loops (chromosight)', bp: 800,
    size: '15,205 bins', files: ['yeast'], args: ['chromosight', at('yeast', 800), '--pattern', 'loops'] },
  { id: 'yeast-model', group: 'yeast', what: '3D model of the genome (pastis-NB)', bp: 12_800, size: '960 bins',
    files: ['yeast'], args: ['reconstruct3d', at('yeast', 12_800), '--method', 'nb', '--alpha', '3'] },

  { id: 'peaks', group: 'tracks', what: 'Peak calling (yapc) with IDR on the two replicates', bp: null,
    size: '1.7 GB of bigWig', files: ['atac1', 'atac2'],
    args: ['peaks', '--signal', path('atac1'), '--replicate', path('atac2'), '--width', '150', '--times', '3',
      '--minWidth', '75', '--truncate', '100000', '--idr', '0.05'] },
  { id: 'overlap', group: 'tracks', what: 'Interval overlap, peaks against transcripts, 1,000 shuffles', bp: null,
    size: () => `${grouped(count(output('peaks', '.bed')))} peaks, 35,119 transcripts`, files: ['mm10', 'genes'],
    needs: 'peaks',
    args: () => {
      const peaks = output('peaks', '.bed')
      return ['overlap', '--sequence', path('mm10'), '--features', peaks, '--features', path('genes'),
        '--a', peaks, '--b', path('genes'), '--shuffle', '--iterations', '1000', '--seed', '1']
    } },
  { id: 'metaplot', group: 'tracks', what: 'Metaplot of ATAC-seq at every RefSeq TSS, ±2 kb', bp: 50,
    size: '35,119 transcripts', files: ['atac1', 'genes'],
    args: ['metaplot', '--tracks', path('atac1'), '--features', path('genes'), '--mode', 'reference', '--at',
      'start', '--flank', '2000', '--step', '50', '--band', 'none'] },
  { id: 'trackcorr', group: 'tracks', what: 'Track correlation of the two replicates (Spearman)', bp: 1_000,
    size: '2.7 M windows', files: ['atac1', 'atac2'],
    args: ['trackcorr', '--tracks', `${path('atac1')},${path('atac2')}`, '--binsize', '1000', '--method',
      'spearman'] },
  { id: 'composition', group: 'tracks', what: 'Base composition: GC, GC and AT skews, cumulative skew',
    bp: 10_000, size: '2.7 Gb', files: ['mm10'],
    args: ['composition', '--sequence', path('mm10'), '--resolution', '10000'] },
  { id: 'motif', group: 'tracks', what: 'Motif search, the CTCF core, ≤ 1 mismatch, both strands', bp: null,
    size: '2.7 Gb', files: ['mm10'],
    args: ['motif', '--sequence', path('mm10'), '--pattern', 'CCGCGNGGNGGCAG', '--mismatches', '1'] },
]

/**
 * Loaded into every timed process with `--import`: on its way out, the process writes what the
 * system counted of it to the file `CHROMOSOMIX_USAGE` names.
 */
const HOOK = 'data:text/javascript,' + encodeURIComponent(
  "import { writeFileSync } from 'node:fs'\n" +
  "process.on('exit', () => writeFileSync(process.env.CHROMOSOMIX_USAGE, JSON.stringify(process.resourceUsage())))\n")

function rel(file) {
  return relative(REPO, file).split('\\').join('/')
}

// ---------------------------------------------------------------------------------------------------
// What is asked for

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : process.argv[at + 1]
}

const RUNS = Number(option('runs', 3))
const ONLY = option('only', '').split(',').filter(Boolean)
const SKIP = option('skip', '').split(',').filter(Boolean)
const named = (task, names) => names.includes(task.id) || names.includes(task.group)

/** The tasks asked for, and any task one of them reads the output of, in the list's order. */
function plan() {
  if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error('--runs takes a whole number, 1 or more')
  for (const name of [...ONLY, ...SKIP]) {
    if (!(name in GROUPS) && !TASKS.some((task) => task.id === name)) {
      throw new Error(`${name} is no task or group: ${[...Object.keys(GROUPS), ...TASKS.map((t) => t.id)].join(', ')}`)
    }
  }
  const wanted = new Set(TASKS.filter((task) => (ONLY.length === 0 || named(task, ONLY)) && !named(task, SKIP))
    .map((task) => task.id))
  for (const task of TASKS) if (wanted.has(task.id) && task.needs) wanted.add(task.needs)
  return TASKS.filter((task) => wanted.has(task.id))
}

// ---------------------------------------------------------------------------------------------------
// The machine

function run(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : ''
  } catch {
    return ''
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/** The computer's model, as the system names it: `MacBook Air (Mac14,2)`, `LENOVO 20XW00GWUS`. */
function model() {
  if (platform() === 'darwin') {
    const said = run('system_profiler', ['SPHardwareDataType'])
    const name = /Model Name:\s*(.+)/.exec(said)?.[1]
    const id = /Model Identifier:\s*(.+)/.exec(said)?.[1] ?? run('sysctl', ['-n', 'hw.model'])
    return name ? `${name} (${id})` : id
  }
  if (platform() === 'linux') {
    return [readText('/sys/devices/virtual/dmi/id/sys_vendor'), readText('/sys/devices/virtual/dmi/id/product_name')]
      .filter(Boolean).join(' ')
  }
  if (platform() === 'win32') {
    return run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_ComputerSystem).Model'])
  }
  return ''
}

/**
 * `mains` or `battery`, where the system says, and `no battery` for a machine with none: a laptop
 * on its battery runs slower, and a number to cite is taken on mains power.
 */
function power() {
  if (platform() === 'darwin') {
    const said = run('pmset', ['-g', 'batt'])
    return said.includes("'AC Power'") ? 'mains' : said.includes("'Battery Power'") ? 'battery' : ''
  }
  if (platform() === 'linux') {
    const root = '/sys/class/power_supply'
    const supplies = existsSync(root) ? readdirSync(root).map((name) => ({
      type: readText(join(root, name, 'type')), online: readText(join(root, name, 'online')),
    })) : []
    const mains = supplies.filter((supply) => supply.type === 'Mains')
    if (mains.length) return mains.some((supply) => supply.online === '1') ? 'mains' : 'battery'
    return supplies.some((supply) => supply.type === 'Battery') ? 'battery' : 'no battery'
  }
  return ''
}

function system() {
  if (platform() === 'darwin') return `macOS ${run('sw_vers', ['-productVersion'])} (${arch()})`
  if (platform() === 'linux') {
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readText('/etc/os-release'))
    return `${pretty ? pretty[1] : 'Linux'}, kernel ${release()} (${arch()})`
  }
  return `${platform()} ${release()} (${arch()})`
}

function machine() {
  return {
    computer: model(),
    processor: cpus()[0]?.model.trim() ?? '',
    cores: cpus().length,
    memory_gb: Math.round(totalmem() / 1024 ** 3),
    system: system(),
    power: power(),
    node: process.version,
  }
}

// ---------------------------------------------------------------------------------------------------
// The build and the data

function build() {
  const vite = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) throw new Error('vite is not installed here: run `npm ci` first, or pass --no-build')
  console.log('building the command line (vite.cli.config.ts)')
  const built = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.cli.config.ts', '--logLevel', 'warn'],
    { cwd: REPO, stdio: 'inherit' })
  if (built.status !== 0) throw new Error('the command line did not build')
}

/** `chromosomix 0.16.0 (8d8450d)`: the version and the commit the timed build was made from. */
function version() {
  if (!existsSync(CLI)) throw new Error(`${rel(CLI)} is not there: build it (npm run build:cli), or leave out --no-build`)
  const said = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' })
  return said.stdout.split('\n')[0].replace(/^chromosomix\s+/, '')
}

async function md5Of(file) {
  const hash = createHash('md5')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Which files on disk were found to be the ones published, by size and time, so the 2.8 GB sequence is hashed once. */
const VERIFIED = join(WORK, 'verified.json')

async function fetchAll(keys) {
  const verified = existsSync(VERIFIED) ? JSON.parse(readFileSync(VERIFIED, 'utf8')) : {}
  const missing = keys.filter((key) => !existsSync(FILES[key].path))
  const needed = missing.reduce((sum, key) => sum + FILES[key].bytes, 0)
  if (needed > 0) {
    for (const key of missing) mkdirSync(FILES[key].dir, { recursive: true })
    const { bavail, bsize } = statfsSync(FILES[missing[0]].dir)
    if (needed > bavail * bsize - 2e9) {
      throw new Error(`the data need ${(needed / 1e9).toFixed(1)} GB more and ${(bavail * bsize / 1e9).toFixed(1)} GB ` +
        'are free; --skip deep leaves out 7 GB of it')
    }
    const names = missing.map((key) => FILES[key].url.split('/').pop())
    console.log(`fetching ${(needed / 1e9).toFixed(1)} GB: ${names.join(', ')}`)
  }
  for (const key of keys) {
    const file = FILES[key]
    if (!existsSync(file.path)) await download(file)
    const { size, mtimeMs } = statSync(file.path)
    if (size !== file.bytes) {
      throw new Error(`${rel(file.path)} is ${size} bytes, and ${file.url} is ${file.bytes}: ` +
        'delete it, and it is fetched again')
    }
    const seen = verified[rel(file.path)]
    if (seen?.size !== size || seen?.mtimeMs !== mtimeMs) {
      process.stdout.write(`checking ${rel(file.path)} … `)
      const digest = await md5Of(file.path)
      if (digest !== file.md5) {
        throw new Error(`${rel(file.path)} has MD5 ${digest}, and ${file.url} ${file.md5}: ` +
          'delete it, and it is fetched again')
      }
      console.log('the published file')
      verified[rel(file.path)] = { size, mtimeMs }
      writeFileSync(VERIFIED, JSON.stringify(verified, null, 1))
    }
  }
  if (keys.includes('mm10')) await faidx(FILES.mm10.path)
}

/** One file, to a partial name, moved into place only once its size and MD5 are the published ones. */
async function download(file) {
  const partial = `${file.path}.part`
  const response = await fetch(file.url)
  if (!response.ok || response.body === null) throw new Error(`${file.url}: HTTP ${response.status}`)
  const hash = createHash('md5')
  let bytes = 0
  let said = Date.now()
  const counted = Readable.fromWeb(response.body).on('data', (chunk) => {
    hash.update(chunk)
    bytes += chunk.length
    if (Date.now() - said > 5000) {
      said = Date.now()
      const name = file.url.split('/').pop()
      process.stdout.write(`\r  ${name}: ${(bytes / 1e9).toFixed(2)} of ${(file.bytes / 1e9).toFixed(2)} GB`)
    }
  })
  await pipeline(counted, createWriteStream(partial))
  process.stdout.write('\n')
  const digest = hash.digest('hex')
  if (bytes !== file.bytes || digest !== file.md5) {
    rmSync(partial, { force: true })
    throw new Error(`${file.url}: got ${bytes} bytes with MD5 ${digest}, not ${file.bytes} with ${file.md5}`)
  }
  renameSync(partial, file.path)
}

/**
 * `samtools faidx`, for a FASTA with no index beside it: name, length, offset of the first residue,
 * residues and bytes per line. Without it a task would read the whole sequence into memory, and
 * time and measure that rather than the task.
 */
async function faidx(fasta) {
  const index = `${fasta}.fai`
  if (existsSync(index)) return
  console.log(`indexing ${rel(fasta)}`)
  const rows = []
  let current = null
  let offset = 0
  let line = []
  let lineStart = 0
  const endLine = (end) => {
    const text = Buffer.concat(line)
    line = []
    if (text[0] === 0x3e) {
      if (current) rows.push(current)
      current = { name: text.subarray(1).toString().trim().split(/\s/)[0], length: 0, start: end, bases: 0, width: 0 }
    } else if (current && text.length > 0) {
      const bases = text[text.length - 1] === 0x0d ? text.length - 1 : text.length
      if (current.bases === 0) Object.assign(current, { bases, width: end - lineStart })
      current.length += bases
    }
    lineStart = end
  }
  for await (const chunk of createReadStream(fasta, { highWaterMark: 1 << 22 })) {
    let from = 0
    for (let at = chunk.indexOf(0x0a); at >= 0; at = chunk.indexOf(0x0a, at + 1)) {
      line.push(chunk.subarray(from, at))
      endLine(offset + at + 1)
      from = at + 1
    }
    if (from < chunk.length) line.push(chunk.subarray(from))
    offset += chunk.length
  }
  if (line.length) endLine(offset)
  if (current) rows.push(current)
  const text = rows.map((row) => [row.name, row.length, row.start, row.bases, row.width].join('\t')).join('\n')
  writeFileSync(`${index}.part`, `${text}\n`)
  renameSync(`${index}.part`, index)
}

// ---------------------------------------------------------------------------------------------------
// The runs

/** One run of one task, as a fresh process from the clone's root: its seconds, its peak memory, its notes. */
function timed(args, out) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const usage = join(tmpdir(), `chromosomix-usage-${process.pid}.json`)
  rmSync(usage, { force: true })
  return new Promise((done) => {
    const start = process.hrtime.bigint()
    const child = spawn(process.execPath, ['--import', HOOK, CLI, ...args, '--out', rel(out), '--quiet'],
      { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CHROMOSOMIX_USAGE: usage } })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-65_536)
    })
    child.on('close', (code, signal) => {
      const wall = Number(process.hrtime.bigint() - start) / 1e9
      const counted = existsSync(usage) ? JSON.parse(readFileSync(usage, 'utf8')) : null
      rmSync(usage, { force: true })
      const notes = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('note:'))
        .map((l) => l.slice('note:'.length).trim())
      const status = code === 0 ? 'ok' : signal ? `killed (${signal})` : `failed (exit ${code})`
      done({
        status, wall_s: wall,
        cpu_s: counted ? (counted.userCPUTime + counted.systemCPUTime) / 1e6 : null,
        user_s: counted ? counted.userCPUTime / 1e6 : null,
        system_s: counted ? counted.systemCPUTime / 1e6 : null,
        // ru_maxrss, in kilobytes on every system once libuv has read it.
        peak_mb: counted ? counted.maxRSS / 1024 : null,
        notes: notes.join(' | '),
        error: code === 0 ? '' : stderr.trim().split('\n').slice(-5).join(' '),
      })
    })
  })
}

const COLUMNS = ['task', 'group', 'what', 'resolution_bp', 'size', 'run', 'status', 'wall_s', 'cpu_s', 'user_s',
  'system_s', 'peak_mb', 'started', 'chromosomix', 'computer', 'processor', 'cores', 'memory_gb', 'system', 'power',
  'node', 'command', 'notes', 'error']

function tsv(rows, columns) {
  const cell = (value) => (value === null || value === undefined ? ''
    : typeof value === 'number' ? String(+value.toFixed(3)) : String(value).replace(/[\t\n]/g, ' '))
  return [columns.join('\t'), ...rows.map((row) => columns.map((key) => cell(row[key])).join('\t'))].join('\n') + '\n'
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const seconds = (s) => (s >= 100 ? s.toFixed(0) : s.toFixed(1))
const grouped = (n) => n.toLocaleString('en-US')
const resolution = (bp) => (bp === null ? '—' : bp >= 1e6 ? `${bp / 1e6} Mb` : bp >= 1e3 ? `${bp / 1e3} kb` : `${bp} bp`)

/** One row per task: the median and range of its wall-clock time, its median CPU time, its largest peak. */
function summarise(tasks, rows) {
  return tasks.map((task) => {
    const mine = rows.filter((row) => row.task === task.id)
    const ok = mine.filter((row) => row.status === 'ok')
    const walls = ok.map((row) => row.wall_s)
    return {
      task: task.id, group: task.group, what: task.what, resolution_bp: task.bp,
      size: (ok[0] ?? mine[0])?.size ?? '', runs: mine.length, ok: ok.length,
      wall_median_s: ok.length ? median(walls) : null,
      wall_min_s: ok.length ? Math.min(...walls) : null,
      wall_max_s: ok.length ? Math.max(...walls) : null,
      cpu_median_s: ok.length ? median(ok.map((row) => row.cpu_s)) : null,
      peak_mb: ok.length ? Math.max(...ok.map((row) => row.peak_mb)) : null,
      status: mine.length === 0 ? 'not yet run' : ok.length === mine.length ? 'ok'
        : `${mine.length - ok.length} of ${mine.length} runs ${mine.find((row) => row.status !== 'ok').status}`,
      command: mine[0]?.command ?? '',
    }
  })
}

const minutes = (s) => (s < 90 ? `${s.toFixed(0)} s` : `${(s / 60).toFixed(0)} minutes`)
const POWER = { mains: ', on mains power', battery: ', on battery power', 'no battery': '', '': '' }

/** summary.md: the machine, then a table for each group of tasks, then every command as it ran. */
function markdown(summary, about, chromosomix) {
  const done = summary.filter((row) => row.ok > 0)
  const total = done.reduce((sum, row) => sum + row.wall_median_s, 0)
  const largest = done.reduce((most, row) => (row.peak_mb > (most?.peak_mb ?? 0) ? row : most), null)
  const lines = [
    `# chromosomix, genome-wide, on ${about.computer || 'this machine'}`,
    '',
    `${about.processor}, ${about.cores} cores, ${about.memory_gb} GB of memory; ${about.system}${POWER[about.power]}; ` +
      `Node ${about.node}; chromosomix ${chromosomix}.`,
    '',
    `Each task was run ${RUNS === 1 ? 'once' : RUNS === 2 ? 'twice' : `${RUNS} times`}, round robin, each run a fresh ` +
      'process (`notebooks/laptop.mjs`). Wall-clock time is the median over the runs, with its range; CPU time, ' +
      'user and system, counts every thread of the process — the task computes on one, and V8 collects and ' +
      'compiles on its own beside it, which is why it can exceed the wall-clock time; peak memory is the largest ' +
      'resident set of any run, in MB of 2²⁰ bytes.',
  ]
  for (const group of Object.keys(GROUPS)) {
    const rows = summary.filter((row) => row.group === group)
    if (rows.length === 0) continue
    lines.push('', `## ${GROUPS[group]}`, '', '| Task | Resolution | Over | Wall-clock, s | CPU, s | Peak memory, MB |',
      '|---|---|---|---:|---:|---:|')
    for (const row of rows) {
      const wall = row.ok === 0 ? row.status
        : `${seconds(row.wall_median_s)}${row.ok > 1 ? ` (${seconds(row.wall_min_s)}–${seconds(row.wall_max_s)})` : ''}`
      lines.push(`| ${row.what} | ${resolution(row.resolution_bp)} | ${row.size} | ${wall} | ` +
        `${row.ok ? seconds(row.cpu_median_s) : ''} | ${row.ok ? grouped(Math.round(row.peak_mb)) : ''} |`)
    }
  }
  if (done.length) {
    lines.push('', `${done.length} task${done.length === 1 ? '' : 's'}, ${minutes(total)} end to end at the median. ` +
      `The most memory a task took was ${grouped(Math.round(largest.peak_mb))} MB (\`${largest.task}\`).`)
  }
  lines.push('', '## The commands', '', 'From the root of a clone, each with `--out <folder> --quiet` after it:', '', '```')
  for (const row of summary) lines.push(row.command)
  lines.push('```', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------

function list(tasks) {
  for (const task of tasks) {
    console.log(`${task.id.padEnd(18)} ${GROUPS[task.group]}: ${task.what}, ${resolution(task.bp)}`)
  }
  const keys = [...new Set(tasks.flatMap((task) => task.files))]
  const missing = keys.filter((key) => !existsSync(FILES[key].path))
  console.log(`\nreads ${keys.map((key) => rel(FILES[key].path)).join(', ')}`)
  console.log(missing.length ? `to fetch: ${(missing.reduce((s, k) => s + FILES[k].bytes, 0) / 1e9).toFixed(1)} GB`
    : 'every file is here')
}

async function main() {
  const tasks = plan()
  if (process.argv.includes('--list')) return list(tasks)
  mkdirSync(WORK, { recursive: true })
  if (!process.argv.includes('--no-build')) build()
  const chromosomix = version()
  await fetchAll([...new Set(tasks.flatMap((task) => task.files))])
  const about = machine()
  console.log(`\n${about.computer || 'this machine'}: ${about.processor}, ${about.cores} cores, ${about.memory_gb} GB; ` +
    `${about.system}; Node ${about.node}; chromosomix ${chromosomix}`)
  if (about.power === 'battery') {
    console.log('warning: on battery power, which slows most laptops down; plug it in for numbers to cite')
  }
  console.log(`${tasks.length} tasks, ${RUNS} run${RUNS === 1 ? '' : 's'} each\n`)

  const rows = []
  for (let round = 1; round <= RUNS; round++) {
    for (const task of tasks) {
      const started = new Date().toISOString().slice(0, 19)
      const row = { task: task.id, group: task.group, what: task.what, resolution_bp: task.bp, run: round, started,
        chromosomix, ...about }
      let args
      try {
        args = typeof task.args === 'function' ? task.args() : task.args
        row.command = ['chromosomix', ...args].join(' ')
        row.size = typeof task.size === 'function' ? task.size() : task.size
      } catch (error) {
        rows.push({ ...row, status: 'not run', error: error.message })
        console.log(`[${round}/${RUNS}] ${task.id.padEnd(18)} not run: ${error.message}`)
        continue
      }
      const result = await timed(args, join(WORK, 'out', task.id))
      rows.push({ ...row, ...result })
      console.log(`[${round}/${RUNS}] ${task.id.padEnd(18)} ` + (result.status === 'ok'
        ? `${seconds(result.wall_s).padStart(6)} s wall, ${seconds(result.cpu_s).padStart(6)} s CPU, ` +
          `${grouped(Math.round(result.peak_mb)).padStart(6)} MB`
        : `${result.status}: ${result.error}`))
      // Rewritten after every run, so a stopped benchmark keeps every run it finished.
      const summary = summarise(tasks, rows)
      writeFileSync(join(WORK, 'runs.tsv'), tsv(rows, COLUMNS))
      writeFileSync(join(WORK, 'summary.tsv'), tsv(summary, Object.keys(summary[0])))
      writeFileSync(join(WORK, 'summary.md'), markdown(summary, about, chromosomix))
    }
  }
  console.log(`\n${readFileSync(join(WORK, 'summary.md'), 'utf8').split('## The commands')[0].trim()}`)
  console.log(`\nwritten: ${['runs.tsv', 'summary.tsv', 'summary.md'].map((name) => rel(join(WORK, name))).join(', ')}`)
}

main().catch((error) => {
  console.error(`\nlaptop.mjs: ${error.message}`)
  process.exit(1)
})
