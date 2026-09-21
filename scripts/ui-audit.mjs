/**
 * Measure what a screenshot cannot be trusted to show.
 *
 * The gallery is the deliverable and a reader has to look at every picture — but
 * an eye is bad at exactly the things that matter most here. A clipped label and
 * a short one look alike; two elements that should share a right edge and miss
 * by six pixels look aligned; 4.2:1 and 4.6:1 on an 11 px caption look the same
 * grey. And a theme judged by eye off a rendered PNG can be got wrong outright.
 *
 * So this walks the same surfaces the tour walks and *measures* them: text that
 * does not fit its box, siblings that overlap, rows whose right edges disagree,
 * small text under the contrast floor, and strings that reach the DOM carrying
 * punctuation §26.4 does not allow. It prints findings, not pictures.
 */

import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
function playwright() {
  try {
    return require('playwright')
  } catch {
    return require(join(execSync('npm root -g').toString().trim(), 'playwright'))
  }
}
const { chromium } = playwright()
const BASE = process.env.GALLERY_BASE ?? 'http://127.0.0.1:5173'
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined
const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Everything measurable about one page, gathered in the page's own context. */
const AUDIT = () => {
  const out = { clipped: [], overlap: [], contrast: [], punctuation: [], ragged: [], casing: [], wordy: [], dimmed: [], undeclared: [], stateWords: [] }
  const vis = (n) => {
    const r = n.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'
  }
  const name = (n) => `${n.tagName.toLowerCase()}.${String(n.className).split(' ').slice(0, 2).join('.')}`
  const text = (n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 48)

  // 1. Text that does not fit the box it is in. `overflow: hidden` with an
  //    ellipsis is a choice; without one it is a value cut mid-character.
  for (const n of document.querySelectorAll('button, .kbd, .field-label, .clip-note, td, .td, option, input, select, .seq-len, .ann-name, .shortcut-text, .palette-title, .card-head span, .status-item')) {
    if (!vis(n)) continue
    const cs = getComputedStyle(n)
    if (cs.textOverflow === 'ellipsis') continue
    if (n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0) {
      out.clipped.push({ el: name(n), text: n.value ?? text(n), need: n.scrollWidth, got: n.clientWidth })
    }
  }

  // 2. Siblings drawn on top of one another. Only text against text, and only
  //    where they are laid out in a row: a badge over a sentence is the defect.
  const rows = document.querySelectorAll('.shortcut-row, .palette-row, .field, .ann-row, .seq-row, .kv, .status-bar')
  for (const row of rows) {
    if (!vis(row)) continue
    const kids = [...row.children].filter((k) => vis(k) && text(k) !== '')
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect()
      const b = kids[i + 1].getBoundingClientRect()
      if (b.left < a.right - 1 && b.top < a.bottom - 1 && a.top < b.bottom - 1) {
        out.overlap.push({ row: name(row), a: text(kids[i]), b: text(kids[i + 1]), by: Math.round(a.right - b.left) })
      }
    }
  }

  // 3. Contrast, for the sizes where 4.5:1 is the floor.
  const lum = (c) => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  // **Composited, not the first non-transparent layer.** A selected row is
  // `color-mix(in srgb, var(--accent) 12%, transparent)`, and read as though it
  // were opaque that is a dark blue — which made every sequence length on the
  // chosen row look like 2.85:1 against text that is in fact sitting on white
  // with a whisper of blue over it. The layers are stacked the way the compositor
  // stacks them, alpha and all, or the measurement is worse than no measurement.
  const parse = (c) => {
    const v = (c.match(/[\d.]+/g) ?? []).map(Number)
    return v.length >= 4 ? v : [...v.slice(0, 3), 1]
  }
  const backdrop = (n) => {
    const layers = []
    let p = n.parentElement
    while (p !== null) {
      const [r, g, b, a] = parse(getComputedStyle(p).backgroundColor)
      if (a > 0) layers.push([r, g, b, a])
      if (a >= 1) break
      p = p.parentElement
    }
    // Furthest back first, then paint forward.
    let [R, G, B] = [255, 255, 255]
    for (const [r, g, b, a] of layers.reverse()) {
      R = r * a + R * (1 - a)
      G = g * a + G * (1 - a)
      B = b * a + B * (1 - a)
    }
    return `rgb(${R}, ${G}, ${B})`
  }
  for (const n of document.querySelectorAll('.hint, .clip-note, .field-label, .seq-len, .palette-hint, .card-head, .status-item, .kbd, .cmd-state, .export-note')) {
    if (!vis(n) || text(n) === '') continue
    const cs = getComputedStyle(n)
    const size = parseFloat(cs.fontSize)
    const bold = Number(cs.fontWeight) >= 700
    const large = size >= 24 || (size >= 18.66 && bold)
    const a = lum(cs.color)
    const b = lum(backdrop(n))
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const floor = large ? 3 : 4.5
    if (ratio < floor) {
      out.contrast.push({ el: name(n), text: text(n), ratio: Math.round(ratio * 100) / 100, floor, size: Math.round(size * 10) / 10 })
    }
  }

  // 4. Punctuation §26.4 keeps out of a reader's way: a backtick, a section
  //    number, Markdown emphasis, the word `session`, an en dash inside a locus.
  const BAD = [
    ['backtick', /`/],
    ['section number', /§\s*\d/],
    ['markdown emphasis', /(^|\s)[*_][A-Za-z]/],
    ['the word session', /\bsessions?\b/i],
    ['en dash in a locus', /:\s*[\d,]+\s*–/],
  ]
  // A store's own rows are a *reader's file*, published by whoever generated the
  // store, and this section governs what the app says rather than how somebody
  // else's data is spelled — the same reason `portal-name` is not held to the
  // casing rule above.
  const STORE_DATA = /gallery-card-line|portal-name|portal-chip|genomes-card|gallery-card-title/
  for (const n of document.querySelectorAll('button, .hint, .clip-note, p, .field-label, .shortcut-text, .palette-title, .palette-hint, h1, h2, h3, option, label, .ann-note, .deck-note')) {
    if (!vis(n)) continue
    if (STORE_DATA.test(String(n.className))) continue
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (t === '') continue
    for (const [why, re] of BAD) if (re.test(t)) out.punctuation.push({ el: name(n), why, text: t.slice(0, 96) })
    const title = n.getAttribute('title')
    if (title !== null) for (const [why, re] of BAD) if (re.test(title)) out.punctuation.push({ el: name(n), why: `${why} (tooltip)`, text: title.slice(0, 96) })
  }

  // 5. A button label that is not lowercase (§26.4). Format names, proper nouns
  //    and the zoom steps are the stated exceptions, so they are listed rather
  //    than guessed at.
  const PROPER = /^(PDF|PNG|SVG|TSV|CSV|BED|BEDPE|BEDGRAPH|bedGraph|bigWig|bigBed|GTF|VCF|BAM|FASTA|JSON|O\/E|3D|bed3d|g3d|IGV|UCSC|ENCODE|4DN|DNA Zoo|Google Drive|Dropbox|RSG|Roadmap|WashU|Chromosight|Spearman|Pearson|SD|N|GC|MAG|K groups|\d+×|\d+ dpi|.*\(BED\)|.*\(BEDPE\)|.*\(image\)|.*\(vector\))/
  // Only the buttons whose content is a *label*. A crumb, a sequence row, a
  // column tab, a store tile and a task row are buttons whose content is data —
  // a file's name, a chromosome's name, a section's name — and §26.4 is about
  // what the app calls its own actions, not about how a reader's file is spelled.
  const DATA_BUTTON = /seq-go|crumb|panel-tab|action-bar|store-tile|picker-provider|analysis-task|tab-label|palette-row|shortcut-row|ann-name|search-hit|res-rung|tf-|structure-key|portal-name|gallery-card-title|genomes-card/
  for (const n of document.querySelectorAll('button.btn, button[class*="btn-"]')) {
    if (!vis(n)) continue
    if (DATA_BUTTON.test(String(n.className))) continue
    const t = (n.textContent ?? '').trim()
    if (t === '' || t.length > 48) continue
    if (PROPER.test(t)) continue
    // A label is lowercase when its first letter is, and it carries no run of
    // capitals of its own.
    const first = t.match(/[A-Za-z]/)
    if (first !== null && first[0] === first[0].toUpperCase() && first[0] !== first[0].toLowerCase()) {
      out.casing.push({ el: name(n), text: t })
    }
  }

  // 6. A hint is one sentence and never more (§26.4), with that section's two
  //    stated exceptions: a toggle may say what its off state does, and an
  //    empty state teaches the gesture that fills it.
  for (const n of document.querySelectorAll('.hint, .palette-hint, .ann-note, .deck-note, .clip-note')) {
    if (!vis(n)) continue
    const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (t === '') continue
    if (/(^|\.\s)Off\b/.test(t)) continue
    if (/^(No |Nothing |None )/.test(t)) continue
    const sentences = t.split(/[.!?](?:\s|$)/).filter((x) => x.trim() !== '').length
    if (sentences > 1 || t.length > 200) out.wordy.push({ el: name(n), sentences, chars: t.length, text: t.slice(0, 110) })
  }

  // 7. Nothing live is dimmed, and nothing lit is undeclared (§26.3).
  for (const n of document.querySelectorAll('button')) {
    if (!vis(n)) continue
    const cs = getComputedStyle(n)
    // A control held *inert* while it is invisible is not a dimmed live control:
    // the tab's × is `opacity: 0` with `pointer-events: none` and comes back on
    // hover and on `:focus-visible`, which is the argued shape (§5.8). And a
    // disclosure chevron is chrome with no state to misread; it is listed here so
    // that the exception is written down rather than silently passed over.
    const inert = cs.pointerEvents === 'none'
    const chrome = /card-fold|panel-column-fold/.test(String(n.className))
    const dim = parseFloat(cs.opacity) < 0.7
    if (dim && !n.disabled && !inert && !chrome) out.dimmed.push({ el: name(n), text: text(n), opacity: cs.opacity })
    const lit = cs.borderColor === getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    if (lit && n.getAttribute('aria-pressed') === null && n.getAttribute('aria-expanded') === null && !/is-on/.test(String(n.className))) {
      out.undeclared.push({ el: name(n), text: text(n) })
    }
  }

  // 8. The words for a state (§26.7), and no others.
  const STATES = ['never run', 'queued', 'running', 'done', 'failed', 'cancelled', 'reading']
  for (const n of document.querySelectorAll('.analysis-state, .task-state, .chip, .status-item')) {
    if (!vis(n)) continue
    const t = (n.textContent ?? '').trim().toLowerCase()
    if (t === '' || t.length > 24) continue
    if (/^(not run|scanning|idle|pending|waiting|error|ok|complete)/.test(t)) out.stateWords.push({ el: name(n), text: t })
  }

  // 9. Blocks in one column that should share a right edge and do not.
  for (const col of document.querySelectorAll('.view-picker, .panel-column-body, .shortcut-body')) {
    if (!vis(col)) continue
    const kids = [...col.children].filter(vis)
    if (kids.length < 3) continue
    const edges = kids.map((k) => Math.round(k.getBoundingClientRect().right))
    const widest = Math.max(...edges)
    const odd = kids.filter((_, i) => widest - edges[i] > 8)
    if (odd.length > 0 && odd.length < kids.length) {
      out.ragged.push({ col: name(col), widest, short: odd.map((k, i) => ({ el: name(k), right: Math.round(k.getBoundingClientRect().right) })) })
    }
  }
  return out
}

const findings = []
async function look(label, go, { width = 1920, height = 1100, dark = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light' })
  const page = await context.newPage()
  try {
    await go(page)
    const r = await page.evaluate(AUDIT)
    for (const [kind, items] of Object.entries(r)) {
      for (const item of items) findings.push({ where: label, kind, ...item })
    }
  } catch (err) {
    findings.push({ where: label, kind: 'scene-failed', text: String(err).slice(0, 160) })
  }
  await context.close()
}

const YEAST = `${BASE}/demo/yeast/Yeast_microC.metacooler.json`
const TRACKS = `${BASE}/demo/yeast/Yeast_tracks.metacooler.json`
const DECK = `${BASE}/demo/yeast/Yeast_deck.metacooler.json`
const MOCK = `${BASE}/demo/metagenomics/mock-community/Mock_microbial_community.metacooler.json`
const openAll = async (page) => {
  for (const t of ['Fold or show the General', 'Fold or show the Annotations', 'Fold or show the Aesthetics', 'Fold or show the Analysis']) {
    for (const b of await page.$$(`button[title^="${t}"]`)) {
      if (await b.isVisible() && (await b.getAttribute('aria-expanded')) !== 'true') { await b.click(); await sleep(400) }
    }
  }
  await sleep(1200)
}

await look('landing', async (p) => { await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(2500) })
await look('landing 900', async (p) => { await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(2500) }, { width: 900 })
await look('landing dark', async (p) => { await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(2500) }, { dark: true })
await look('shortcuts', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await p.keyboard.press('Control+/'); await sleep(900) })
await look('palette', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await p.keyboard.press('Control+p'); await sleep(900) })
await look('map', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await openAll(p) })
await look('map 1366', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await openAll(p) }, { width: 1366, height: 768 })
await look('map dark', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await openAll(p) }, { dark: true })
await look('browser', async (p) => { await p.goto(`${BASE}/?config=${TRACKS}`, { waitUntil: 'networkidle' }); await sleep(10000); await openAll(p) })
await look('deck', async (p) => { await p.goto(`${BASE}/?config=${DECK}`, { waitUntil: 'networkidle' }); await sleep(12000); await openAll(p) })
await look('metagenome', async (p) => { await p.goto(`${BASE}/?config=${MOCK}`, { waitUntil: 'networkidle' }); await sleep(10000) })
await look('chromosomes', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await p.keyboard.press('c'); await sleep(2500) })
await look('whole genome', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); await p.keyboard.press('w'); await sleep(3500) })
await look('drawer', async (p) => { await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000); const r = p.locator('.analysis-task', { hasText: 'Contact probability' }).first(); if (await r.count()) { await r.click(); await sleep(2500) } })
await look('embed', async (p) => { await p.goto(`${BASE}/?embed=1&config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000) }, { width: 1000, height: 640 })
await look('error view', async (p) => {
  await p.goto(`${BASE}/#uri=${BASE}/demo/yeast/does-not-exist.cool&view=region&region=IV:1-1000`)
  await p.waitForSelector('.view-error, .view-picker, .heatmap-canvas', { timeout: 60000 })
  await sleep(2500)
})
await look('connect dialog', async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(2500)
  const bucket = p.locator('.picker-provider', { hasText: /bucket/i }).first()
  if (await bucket.count()) { await bucket.click(); await sleep(1200) }
})
await look('store drawer', async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(2500)
  await p.keyboard.press('\\'); await sleep(1500)
})
await look('console', async (p) => {
  await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000)
  await p.keyboard.press('`'); await sleep(1200)
})
await look('stored data', async (p) => {
  await p.goto(BASE, { waitUntil: 'networkidle' }); await sleep(2500)
  await p.keyboard.press('Control+p'); await sleep(500)
  await p.keyboard.type('remember'); await sleep(400)
  await p.keyboard.press('Enter'); await sleep(1200)
})
await look('resolution dialog', async (p) => {
  await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000)
  const add = await p.$('.res-add'); if (add) { await add.click(); await sleep(900) }
})
await look('lane settings', async (p) => {
  await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000)
  const map = await p.locator('.heatmap-canvas').first().boundingBox()
  if (map) { await p.mouse.click(map.x + map.width * 0.45, map.y + map.height + 40); await sleep(1000) }
})
await look('map context menu', async (p) => {
  await p.goto(`${BASE}/?config=${YEAST}`, { waitUntil: 'networkidle' }); await sleep(9000)
  const map = await p.locator('.heatmap-canvas').first().boundingBox()
  if (map) { await p.mouse.click(map.x + map.width * 0.5, map.y + map.height * 0.5, { button: 'right' }); await sleep(900) }
})
await look('genome view', async (p) => {
  await p.goto(`${BASE}/?config=${MOCK}`, { waitUntil: 'networkidle' }); await sleep(10000)
  const row = p.locator('.view-genomes .tr .td:not(.td-check)').first()
  if (await row.count()) { await row.click(); await sleep(4000) }
  await openAll(p)
})
await look('deck dark', async (p) => { await p.goto(`${BASE}/?config=${DECK}`, { waitUntil: 'networkidle' }); await sleep(12000); await openAll(p) }, { dark: true })
await look('browser 1366', async (p) => { await p.goto(`${BASE}/?config=${TRACKS}`, { waitUntil: 'networkidle' }); await sleep(10000); await openAll(p) }, { width: 1366, height: 768 })

console.log(JSON.stringify(findings, null, 1))
console.log(`\n${findings.length} findings`)
const by = {}
for (const f of findings) by[f.kind] = (by[f.kind] ?? 0) + 1
console.log(by)
await browser.close()
