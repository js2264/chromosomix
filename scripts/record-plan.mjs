/**
 * Record the read plan the *Human Hi-C data* example ships with (§6.1, §12,
 * §24.11): press the button on a fresh profile, wait for the map and its
 * tracks, and print what the reader wrote down of the open's walk and the
 * window's — `HUMAN_PLAN` in `src/ui/exampleSessions.ts`, ready to paste.
 *
 * Run it again when the file or the way the reader walks it changes: a new
 * chunk size, a dataset read that was not, a window moved. A stale plan is
 * never wrong — the walk fetches what it misses, and the plan's surplus is the
 * whole cost — but it stops being the head start it exists to be. It needs the
 * network: the map is on 4DN's bucket. Where the network is behind a proxy,
 * `HTTPS_PROXY` is honoured, the app's own address bypassing it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/record-plan.mjs [app-url]
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const APP = process.argv[2] ?? 'http://127.0.0.1:5173/'
const LABEL = 'Human Hi-C data'
const MAP = '4DNFI18UHVRO.mcool::resolutions/10000'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: proxy !== undefined })
await context.addInitScript(() => {
  window.__reports = []
  window.addEventListener('chromosomix:rendered', (event) => window.__reports.push(event.detail))
})
const page = await context.newPage()
await page.goto(APP)
await page.waitForFunction((label) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith(label)), LABEL)
await page.evaluate((label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(label)).click(), LABEL)
await page.waitForFunction(() => window.__reports.some((r) => r.status === 'drawn' && r.maps.length > 0), null, { timeout: 180_000 })
// The plan is asked for once the map has its first picture; give it the moment.
await sleep(3000)
const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('chromosomix:read-plans'))) ?? '{}')
await browser.close()

const key = Object.keys(stored).find((uri) => uri.endsWith(MAP))
if (key === undefined) {
  console.error(`no plan was kept for ${MAP}; kept: ${Object.keys(stored).join(', ') || 'none'}`)
  process.exit(1)
}
const plan = stored[key]
const views = Object.entries(plan.views)
if (views.length !== 1) console.error(`expected one window's plan, found ${views.length}`)
const ranges = (list, indent) => `[\n${list.map(([a, b]) => `${indent}  [${a}, ${b}],\n`).join('')}${indent}]`
console.log(`const HUMAN_PLAN: StoredPlans | undefined = {
  size: ${plan.size},
  open: ${ranges(plan.open, '  ')},
  views: {
    [HUMAN_REGION]: ${ranges(views[0]?.[1] ?? [], '    ')},
  },
  at: 0,
}`)
