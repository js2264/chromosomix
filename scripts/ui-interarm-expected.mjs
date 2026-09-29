/**
 * The baseline's inter-arm half on the map, in headless Chromium (§7.5, §8.15).
 *
 * *P. aeruginosa* PAK from the DNA Bacterial Zoo at 8 kb, opened on its
 * chromosome for the first time — so the circle is ticked by the first open
 * *after* the view is built, and the score picker has to be told to offer
 * `inter-arm` rather than being built with it. Then the three baselines side
 * by side, framed on the origin with `ori` first — a press of it is a
 * navigation, which starts from the file's own score as every navigation does:
 * `expected`, the same along the arms, and `inter-arm`, the O/E and `arms`
 * greyed under it, the key and a hover under the pointer; then the link to it,
 * from the sequence's first base; the circle unticked on the Chromosomes table,
 * where that link lands on counts, and ticked again; and the yeast demo, which
 * has no circle and is not offered it. Every step prints the picker's options,
 * what is selected, the key, the toggles' state and the hash.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-interarm-expected.mjs [out-dir]
 *
 * The zoo is read over the network. Behind a proxy (`HTTPS_PROXY`) the browser
 * is sent through it, the dev server excepted; `GALLERY_DATA` names a folder
 * served with byte ranges and CORS that holds `PAK_MM142.mcool` instead.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
const DATA = process.env.GALLERY_DATA ?? 'https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/PAK_MM142'
const MAP = `${DATA}/PAK_MM142.mcool::/resolutions/8000`
const SEQUENCE = 'LR657304.1'
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath = browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const proxy = process.env.HTTPS_PROXY

// Chromium's own proxy flag rather than Playwright's, which would send the dev
// server's plain HTTP through a proxy that only tunnels HTTPS.
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    ...(proxy === undefined || proxy === '' ? [] : [`--proxy-server=${proxy}`]),
  ],
})
const errors = []
// A fresh context each time one is asked for: a tab's sessions are kept in its
// storage, so a second demo opened in the same one comes back as the first.
const fresh = async () => {
  const next = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })).newPage()
  next.on('pageerror', (e) => errors.push(String(e)))
  next.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return next
}
let page = await fresh()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name, clip) => {
  await page.mouse.move(5, 5)
  await sleep(300)
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip === undefined ? {} : { clip }) })
  console.log('shot', name)
}
const until = (text, timeout = 180000) =>
  page.waitForFunction((t) => (document.body.innerText ?? '').includes(t), text, { timeout })
    .catch(() => console.log('never saw:', text))
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) { await b.click(); await sleep(600); return true }
  }
  return false
}
const word = (text) => page.locator('button').filter({ has: page.locator(`.btn-word-text:text-is("${text}")`) }).first()
/** The Map card's score picker, found by its label. */
const scoreSelect = () => page.locator('.field').filter({ has: page.locator('.field-label:text-is("score")') }).locator('select').first()
/** What the card and the map say: the picker's options and choice, the key, the two toggles. */
const report = async (when) => {
  const said = await page.evaluate(() => {
    const field = [...document.querySelectorAll('.field')].find((node) => node.querySelector('.field-label')?.textContent === 'score')
    const select = field?.querySelector('select')
    const words = Object.fromEntries([...document.querySelectorAll('.btn-word')].filter((node) => node.offsetParent !== null).map((node) => [
      node.textContent?.trim(),
      `${node.getAttribute('aria-pressed') === 'true' ? 'lit' : 'unlit'}${node.disabled ? ', greyed' : ''}`,
    ]))
    return {
      options: [...(select?.options ?? [])].map((option) => option.textContent).join(' | '),
      chosen: select?.selectedOptions[0]?.textContent ?? '',
      key: document.querySelector('.map-key-title')?.textContent ?? '',
      words,
      hash: decodeURIComponent(location.hash).match(/(score|balance|arms|oe)=[^&]*/g)?.join(' ') ?? '',
    }
  })
  console.log(`\n${when}\n  score: ${said.chosen}   [${said.options}]\n  key: ${said.key}\n  ` +
    `${Object.entries(said.words).map(([k, v]) => `${k}: ${v}`).join(' · ')}\n  hash: ${said.hash}`)
}
const pick = async (value) => {
  await scoreSelect().selectOption(value)
  await sleep(6000)
}
/** The Map card's picture row and score, close up. */
const card = async (name) => {
  const box = await page.locator('.field').filter({ has: page.locator('.field-label:text-is("picture")') }).first().boundingBox()
  const score = await scoreSelect().boundingBox()
  if (box === null || score === null) return
  const top = Math.min(box.y, score.y) - 12
  const bottom = Math.max(box.y + box.height, score.y + score.height) + 12
  await shot(name, { x: Math.max(0, box.x - 12), y: Math.max(0, top), width: Math.max(box.width, 260) + 24, height: bottom - top })
}
const heatmap = () => page.locator('.heatmap-canvas').first()
/**
 * The picker's whole list, shot: a native dropdown's popup is not in a page
 * screenshot, so the select is opened out as a list box for the one shot.
 */
const options = async (name) => {
  await scoreSelect().evaluate((select) => { select.size = select.options.length })
  await sleep(300)
  const box = await scoreSelect().boundingBox()
  if (box !== null) {
    await shot(name, { x: Math.max(0, box.x - 110), y: Math.max(0, box.y - 20), width: box.width + 130, height: box.height + 40 })
  }
  await scoreSelect().evaluate((select) => { select.size = 0 })
  await sleep(300)
}

try {
  // The chromosome itself, on the file's first open: the circle is measured
  // and ticked once the view is already on screen, so the picker is offered
  // `inter-arm` after it was built.
  await page.goto(`${BASE}/#uri=${encodeURIComponent(MAP)}&view=region&region=${SEQUENCE}`)
  await until('reads as circular')
  await sleep(6000)
  for (const name of ['General', 'Annotations', 'Analysis']) await fold(`Fold the ${name} panel`)
  await sleep(3000)
  await report('opened, the circle ticked by the first open')
  await options('ie01-picker-on-a-circle')

  // Framed on the origin first: `ori` is a navigation, and a navigation starts
  // from the file's own score, as it does for every score.
  await word('ori').click()
  await sleep(8000)
  await report('framed on the origin')
  await shot('ie02-ori')

  await pick('baseline')
  await report('expected')
  await shot('ie03-expected')

  await word('arms').click()
  await sleep(6000)
  await report('expected, arms on')
  await shot('ie04-expected-along-the-arms')

  await pick('interarm')
  await report('inter-arm')
  await shot('ie05-inter-arm')
  await card('ie06-inter-arm-card')
  console.log('  inter-arm option title:', await scoreSelect().locator('option[value="interarm"]').getAttribute('title'))
  console.log('  arms title:', await word('arms').getAttribute('title'))
  console.log('  O/E title:', await word('O/E').getAttribute('title'))

  // A cell on the secondary diagonal, three quarters of the way up it, and the
  // readout it gives.
  const box = await heatmap().boundingBox()
  if (box !== null) {
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.2)
    await sleep(800)
    console.log('  hover:', await page.evaluate(() => document.querySelector('.status-coords')?.textContent ?? ''))
    await page.screenshot({ path: `${OUT}/ie07-inter-arm-hover.png` })
    console.log('shot ie07-inter-arm-hover')
  }

  // The link, as a reader would send it — this one, with the region put back
  // to the whole sequence from its first base: the secondary diagonal is then
  // the square's antidiagonal, crossing the main one at the terminus.
  await page.evaluate((sequence) => {
    location.hash = location.hash.replace(/region=[^&]*/, `region=${sequence}`)
  }, SEQUENCE)
  await sleep(8000)
  await report('a link naming it, from the first base')
  await shot('ie08-inter-arm-first-base')

  // Unticked on the Chromosomes table: the entry goes, and a link naming it
  // lands on counts; ticked again, it is back. A link with the score alone, so
  // what it lands on is the counts and not the O/E `arms` turned on above.
  await page.evaluate(({ map, sequence }) => {
    location.hash = `#uri=${encodeURIComponent(map)}&view=region&region=${sequence}&balance=false&score=interarm`
  }, { map: MAP, sequence: SEQUENCE })
  await sleep(8000)
  const tick = async (on) => {
    await page.evaluate(() => { location.hash = location.hash.replace(/view=region/, 'view=contigs') })
    await sleep(4000)
    await page.evaluate((on) => {
      const box = [...document.querySelectorAll('input.tcheck')].find((node) => /circle/.test(node.title) && node.checked !== on)
      box?.click()
    }, on)
    await sleep(1500)
    await page.goBack()
    await sleep(8000)
  }
  await tick(false)
  await report('the circle unticked, back on the link')
  await shot('ie09-unticked')
  await tick(true)
  await report('ticked again')
  await shot('ie10-ticked-again')

  // No circle, and not offered: the yeast demo, in a tab of its own.
  page = await fresh()
  await page.goto(`${BASE}/?config=${encodeURIComponent('/demo/yeast/Yeast_microC.metacooler.json')}`)
  await page.waitForFunction(() => [...document.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.value === 'baseline')), null, { timeout: 120000 })
  await scoreSelect().waitFor({ timeout: 60000 })
  await sleep(4000)
  await report('yeast demo, a linear chromosome')
  await options('ie11-picker-on-a-line')
} finally {
  if (errors.length > 0) console.log('\npage errors:\n' + [...new Set(errors)].join('\n'))
  await browser.close()
}
