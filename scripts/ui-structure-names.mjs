/**
 * Drive *colour by names* on the 3D model in headless Chromium, and write
 * what each step looks like (§8.16, §25.5).
 *
 * Opens the yeast demo, drops its structure, then drops a BED of A/B
 * compartments written over the model's own sequences: the colour-by menu
 * (opened as a list so the picture shows it) with the BED's `· names` row, the
 * model coloured A/B with its key, A recoloured from the key — the model and
 * the BED's own lane key taking the same colour — the lane coloured by name, a
 * second BED of thirty names that folds the tail into `other`, and the dark
 * theme. Prints each check to stdout as well as shooting it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-structure-names.mjs [out-dir]
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    const root = execSync('npm root -g').toString().trim()
    return require(join(root, 'playwright'))
  }
}
const { chromium } = playwright()

const OUT = process.argv[2] ?? 'gallery'
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

// ---------------------------------------------------------------------------
// The two BEDs, over the demo model's own sequences
// ---------------------------------------------------------------------------

const ends = new Map()
for (const line of gunzipSync(readFileSync(new URL('../demo/yeast/Yeast_structure.g3d.gz', import.meta.url))).toString().split('\n')) {
  const [contig, start] = line.split('\t')
  if (contig === undefined || start === undefined || contig.startsWith('#')) continue
  ends.set(contig, Math.max(ends.get(contig) ?? 0, Number(start) + 5000))
}
// A small, fixed generator, so the picture is the same every run.
let seed = 7
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const ab = []
const states = []
for (const [contig, end] of ends) {
  // Compartments: runs of 40–160 kb, alternating, B first at each start.
  let at = 0
  let name = 'B'
  while (at < end) {
    const to = Math.min(end, at + 40000 + Math.floor(random() * 120000))
    ab.push(`${contig}\t${at}\t${to}\t${name}`)
    name = name === 'A' ? 'B' : 'A'
    at = to
  }
  // Thirty states in 25 kb runs, with a few gaps that keep the neutral.
  for (let s = 0; s < end; s += 25000) {
    if (random() < 0.08) continue
    states.push(`${contig}\t${s}\t${Math.min(end, s + 25000)}\tstate${1 + Math.floor(random() * 30)}`)
  }
}
const dir = join(tmpdir(), 'metacooler-structure-names')
mkdirSync(dir, { recursive: true })
const abPath = join(dir, 'Yeast_compartments.bed')
const statesPath = join(dir, 'Yeast_states.bed')
writeFileSync(abPath, ab.join('\n') + '\n')
writeFileSync(statesPath, states.join('\n') + '\n')
console.log(`wrote ${ab.length} compartments and ${states.length} states over ${ends.size} sequences`)

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name, clip) => { await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) }); console.log('shot', name) }
/** Press a panel's fold button; tried again when a rebuild takes it away mid-press. */
const fold = async (title) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      for (const b of await page.$$(`button[title^="${title}"]`)) {
        if (await b.isVisible()) { await b.click(); await sleep(600); return true }
      }
      return false
    } catch {
      await sleep(800)
    }
  }
  return false
}
/** A select on the 3D structure card, by its row's label. */
const field = (label) =>
  page.locator('.structure-settings .field').filter({ has: page.locator('.field-label', { hasText: new RegExp(`^${label}$`) }) }).first().locator('select').first()
const colourBy = () => field('colour by')
/** The model's key: its title and each row's name and colour. */
const key = () =>
  page.evaluate(() => {
    const host = document.querySelector('.deck-structure .structure-key')
    return {
      title: host?.querySelector('.structure-key-title')?.textContent ?? null,
      rows: Array.from(host?.querySelectorAll('.structure-key-level') ?? []).map((row) => `${row.textContent} ${row.querySelector('input')?.value ?? ''}`),
    }
  })
const tracksCard = () => page.locator('.annotation-card').filter({ has: page.locator('.card-head', { hasText: /^\s*Tracks/ }) }).first()
/**
 * A BED dropped on the Tracks card, as a reader drags one there. The card has
 * no file input of its own, so the file written above is handed over as a
 * drop carrying its bytes.
 */
const addBed = async (path) => {
  const text = readFileSync(path, 'utf8')
  const name = path.split('/').pop()
  await tracksCard().evaluate((card, [text, name]) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], name, { type: 'text/plain' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, [text, name])
  await sleep(3000)
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.heatmap-canvas', { timeout: 120000 })
  await sleep(4000)
  await fold('Fold the General panel')
  await fold('Show the Annotations panel')
  await sleep(600)

  // The structure, dropped on the Structures card.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    const bytes = await (await fetch(url)).arrayBuffer()
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Yeast_structure.g3d.gz', { type: 'application/gzip' }))
    for (const kind of ['dragenter', 'dragover', 'drop']) card.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForSelector('.deck-structure', { timeout: 60000 })
  await sleep(6000)

  // The compartments BED, dropped on the Tracks card.
  console.log('tracks card found:', (await tracksCard().count()) > 0)
  await addBed(abPath)
  await page.click('.structure-frame').catch(() => {})
  await sleep(1500)

  // The colour-by menu, opened as a list so a screenshot can show it.
  await fold('Show the Aesthetics panel')
  await sleep(800)
  // The whole model in colour rather than the window alone: a genome of A and
  // B is the picture, and the map's 400 kb would light one arc of it.
  await field('outside window').selectOption('show')
  await page.locator('.structure-settings button', { hasText: /^everything$/ }).first().click().catch(() => console.log('no "everything" frame button'))
  await sleep(1500)
  const options = await colourBy().locator('option').allTextContents()
  console.log('colour by:', JSON.stringify(options))
  console.log('names offered:', options.filter((o) => /· names$/.test(o)))
  await colourBy().evaluate((select) => {
    select.size = select.options.length
    select.style.height = 'auto'
    select.style.position = 'relative'
    select.style.zIndex = '50'
    const option = Array.from(select.options).find((o) => /Yeast_compartments · names$/.test(o.text))
    if (option) option.style.background = '#cfe3ff'
    select.scrollIntoView({ block: 'center' })
  })
  await sleep(400)
  {
    const box = await page.locator('.structure-settings').first().boundingBox()
    const list = await colourBy().boundingBox()
    const top = Math.max(0, Math.min(box.y, list.y - 200))
    await shot('sn1-colour-by-menu', { x: box.x - 10, y: top, width: box.width + 20, height: Math.min(1100 - top, list.y + list.height - top + 20) })
  }
  await colourBy().evaluate((select) => {
    select.size = 0
    select.removeAttribute('style')
  })

  // The model coloured A/B, with its key.
  await colourBy().selectOption({ label: options.find((o) => /Yeast_compartments · names$/.test(o)) })
  await sleep(2500)
  console.log('key, A/B:', JSON.stringify(await key()))
  await shot('sn2-coloured-ab-with-key')

  // A recoloured from the key: green, and the model follows.
  await page.evaluate(() => {
    const swatch = document.querySelector('.deck-structure .structure-key-level input[type="color"]')
    swatch.value = '#1b9e3e'
    swatch.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(2000)
  console.log('key, A recoloured:', JSON.stringify(await key()))
  await shot('sn3-a-recoloured-from-key')

  // The BED's own lane, coloured by name from its row on the Tracks card: the
  // same green, from the same mapping.
  // A row's name is an input (it can be renamed), so it is found by value.
  const at = await tracksCard().evaluate((card) =>
    Array.from(card.querySelectorAll('.ann-row')).findIndex((row) =>
      Array.from(row.querySelectorAll('input')).some((input) => input.value === 'Yeast_compartments'),
    ),
  )
  console.log('compartments row at:', at)
  const row = tracksCard().locator('.ann-row').nth(at)
  await row.locator("button.ann-more").first().click()
  await sleep(800)
  const picker = row.locator('select').filter({ has: page.locator('option[value="name"]') }).first()
  if ((await picker.count()) > 0) {
    await picker.selectOption('name')
    await sleep(1500)
    const laneKey = await row.evaluate((host) =>
      Array.from(host.querySelectorAll('.ann-key .ann-key-item')).map((item) => `${item.textContent} ${item.querySelector('input')?.value ?? ''}`),
    )
    console.log('lane key, by name:', JSON.stringify(laneKey))
  } else {
    console.log('lane picker with name: not found')
  }
  await row.scrollIntoViewIfNeeded()
  await sleep(500)
  await shot('sn4-lane-coloured-by-name')
  await row.locator("button.ann-more").first().click().catch(() => {})
  await sleep(500)

  // Thirty names: the tail folded into `other`, and the key says how many.
  await addBed(statesPath)
  await fold('Show the Aesthetics panel')
  await sleep(800)
  const more = await colourBy().locator('option').allTextContents()
  await colourBy().selectOption({ label: more.find((o) => /Yeast_states · names$/.test(o)) })
  await sleep(2500)
  console.log('key, thirty names:', JSON.stringify(await key()))
  await shot('sn5-many-names-other')

  // Back to A/B, in the dark.
  await colourBy().selectOption({ label: more.find((o) => /Yeast_compartments · names$/.test(o)) })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await sleep(2500)
  await shot('sn6-dark')

  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await browser.close()
}
