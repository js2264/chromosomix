/**
 * Record the read plans the landing page's examples ship with (§6.1, §12,
 * §24.11): press the example's button on a fresh profile, wait until the reader
 * has written down what each of its maps' opens and first views read, and
 * print them as `src/ui/exampleSessions.ts` holds them, ready to paste.
 *
 *   human     Human Hi-C data's map            → HUMAN_PLAN
 *   compare   Comparing data's two maps        → CHICKEN_G2_PLAN, CHICKEN_MITOSIS_PLAN
 *
 * Run it again when a file or the way the reader walks it changes: a new chunk
 * size, a dataset read that was not, a window moved. A stale plan is never
 * wrong — the walk fetches what it misses, and the plan's surplus is the whole
 * cost — but it stops being the head start it exists to be. It needs the
 * network: the maps are on the lab's bucket. Where the network is behind a
 * proxy, `HTTPS_PROXY` is honoured, the app's own address bypassing it.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/record-plan.mjs [app-url] [human|compare]
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const APP = process.argv[2] ?? 'http://127.0.0.1:5173/'
const WHICH = process.argv[3] ?? 'human'

/** Each example: its button, and each map's constant, the end of its address and its window's name. */
const EXAMPLES = {
  human: { label: 'Human Hi-C data', maps: [['HUMAN_PLAN', '4DNFI18UHVRO.mcool::resolutions/10000', 'HUMAN_REGION']] },
  compare: {
    label: 'Comparing data',
    maps: [
      ['CHICKEN_G2_PLAN', '4DNFIT479GDR.mcool::resolutions/100000', 'COMPARISON_REGION'],
      ['CHICKEN_MITOSIS_PLAN', '4DNFIWHQLZTL.mcool::resolutions/100000', 'COMPARISON_REGION'],
    ],
  },
}
const example = EXAMPLES[WHICH]
if (example === undefined) {
  console.error(`no example called ${WHICH}; these are: ${Object.keys(EXAMPLES).join(', ')}`)
  process.exit(2)
}

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: proxy !== undefined })
const page = await context.newPage()
await page.goto(APP)
await page.waitForFunction((label) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith(label)), example.label)
await page.evaluate((label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(label)).click(), example.label)
// Until every map's plan is written down with its window's half: each is asked
// for once its map has a first picture, so this is the moment the view is drawn.
const ends = example.maps.map(([, end]) => end)
await page.waitForFunction(
  (wanted) => {
    const stored = JSON.parse(localStorage.getItem('chromosomix:read-plans') ?? '{}')
    return wanted.every((end) => Object.entries(stored).some(([uri, plan]) => uri.endsWith(end) && Object.keys(plan.views ?? {}).length > 0))
  },
  ends,
  { timeout: 180_000, polling: 250 },
)
const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('chromosomix:read-plans'))) ?? '{}')
await browser.close()

const ranges = (list, indent) => `[\n${list.map(([a, b]) => `${indent}  [${a}, ${b}],\n`).join('')}${indent}]`
for (const [name, end, region] of example.maps) {
  const key = Object.keys(stored).find((uri) => uri.endsWith(end))
  const plan = stored[key]
  const views = Object.entries(plan.views)
  if (views.length !== 1) console.error(`${name}: expected one window's plan, found ${views.length}`)
  console.log(`const ${name}: StoredPlans | undefined = {
  size: ${plan.size},
  open: ${ranges(plan.open, '  ')},
  views: {
    [${region}]: ${ranges(views[0]?.[1] ?? [], '    ')},
  },
  at: 0,
}`)
}
