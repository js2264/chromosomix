/**
 * The structure cell's ghosting and its rotation, driven for real (§25.5).
 *
 * Two things `ui-gallery.mjs` cannot show, because both are about what a
 * *gesture* does rather than what the page looks like on arrival: whether the
 * ghost-opacity slider actually reaches transparent at zero, and whether the
 * model can be turned past the pole instead of stopping halfway through a drag.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-structure-look.mjs [out-dir]
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
mkdirSync(OUT, { recursive: true })
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
const executablePath =
  browsers !== undefined && existsSync(join(browsers, 'chromium')) ? join(browsers, 'chromium') : undefined

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1100 }, deviceScaleFactor: 1 })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const fold = async (title) => {
  for (const b of await page.$$(`button[title^="${title}"]`)) {
    if (await b.isVisible()) {
      await b.click()
      await sleep(600)
      return
    }
  }
}

/** Set a range input by its settings-row label, the way a reader drags it. */
const setSlider = async (label, value) => {
  const ok = await page.evaluate(
    ({ label, value }) => {
      const rows = [...document.querySelectorAll('*')].filter(
        (el) => el.children.length > 0 && (el.textContent ?? '').trim().startsWith(label),
      )
      for (const row of rows.reverse()) {
        const input = row.querySelector('input[type=range]')
        if (input === null) continue
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
      return false
    },
    { label, value },
  )
  await sleep(900)
  return ok
}

/** How much of the cell is not the page colour — a crude "is anything drawn". */
const inkShare = async () => {
  const box = await (await page.$('canvas.structure-canvas')).boundingBox()
  const shot = await page.screenshot({ clip: box })
  // Count non-white-ish pixels off the PNG through the page's own canvas.
  return await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let ink = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 242 || data[i + 1] < 242 || data[i + 2] < 242) ink++
    }
    return +(ink / (data.length / 4)).toFixed(4)
  }, [...shot])
}

try {
  await page.goto(`${BASE}/?config=${BASE}/demo/yeast/Yeast_microC.metacooler.json`)
  await page.waitForFunction(
    () => !document.body.textContent.includes('Opening ') && document.querySelector('.heatmap-canvas') !== null,
    null,
    { timeout: 180000 },
  )
  await sleep(2500)
  await fold('Show the Annotations panel')

  // The demo structure, dropped on the Structures card, as the gallery does it.
  await page.evaluate(async (url) => {
    const card = document.querySelector('.structure-card')
    if (card === null) throw new Error('no Structures card')
    const response = await fetch(url)
    const file = new File([await response.blob()], 'Yeast_structure.g3d.gz')
    const dt = new DataTransfer()
    dt.items.add(file)
    for (const type of ['dragenter', 'dragover', 'drop']) {
      card.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
  }, `${BASE}/demo/yeast/Yeast_structure.g3d.gz`)
  await page.waitForFunction(() => /beads/.test(document.body.textContent ?? ''), null, { timeout: 60000 })
  await sleep(3000)
  await fold('Fold the General panel')
  await fold('Fold the Aesthetics panel')
  await fold('Show the Aesthetics panel')
  await sleep(800)

  // Ghosting only shows against a window, so frame the maps on one sequence.
  await shot('g0-before')
  for (const value of [1, 0.5, 0.15, 0]) {
    const ok = await setSlider('outside window', value)
    const ink = await inkShare()
    console.log(`outside window · ghost opacity ${value}: slider ${ok ? 'set' : 'NOT FOUND'}, ink ${ink}`)
    await shot(`g-ghost-${String(value).replace('.', '_')}`)
  }

  // Rotation: one long vertical drag, which used to stop dead at the pole.
  await setSlider('outside window', 0.15)
  // **The structure's own canvas**, by class: a bare `canvas` selector finds
  // the map's heatmap first, and a drag there is a hover the cell echoes — which
  // looks like a rotation that did nothing.
  const canvas = await page.$('canvas.structure-canvas')
  const box = await canvas.boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await shot('r0-before-turn')
  await page.mouse.move(cx, cy - 200)
  await page.mouse.down()
  for (let k = 1; k <= 40; k++) {
    await page.mouse.move(cx, cy - 200 + k * 12)
    if (k % 10 === 0) await sleep(120)
  }
  await page.mouse.up()
  await sleep(1200)
  await shot('r1-turned-past-the-pole')
  // …and keep going the same way, which a clamp would have made a no-op.
  await page.mouse.move(cx, cy - 200)
  await page.mouse.down()
  for (let k = 1; k <= 40; k++) {
    await page.mouse.move(cx, cy - 200 + k * 12)
    if (k % 10 === 0) await sleep(120)
  }
  await page.mouse.up()
  await sleep(1200)
  await shot('r2-turned-further')
  // ---- the controls added beside these two -------------------------------
  await setSlider('outside window', 1)

  /** A settings toggle by the start of its title. */
  const pressToggle = async (title) =>
    await page.evaluate((title) => {
      const button = [...document.querySelectorAll('button')].find((b) => (b.title ?? '').startsWith(title))
      if (button === undefined) return false
      button.click()
      return true
    }, title)

  /** A settings select by its row label. */
  const setSelect = async (label, value) =>
    await page.evaluate(
      ({ label, value }) => {
        const rows = [...document.querySelectorAll('*')].filter(
          (el) => el.children.length > 0 && (el.textContent ?? '').trim().startsWith(label),
        )
        for (const row of rows.reverse()) {
          const select = row.querySelector('select')
          if (select === null) continue
          const wanted = [...select.options].find((o) => o.value === value || o.textContent?.trim() === value)
          if (wanted === undefined) continue
          select.value = wanted.value
          select.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        }
        return false
      },
      { label, value },
    )

  console.log('telomere toggle:', await pressToggle('Mark the telomeres'))
  await sleep(1200)
  await shot('t1-telomeres-on')

  // The colour scale only exists for a ramp, so a ramp is chosen first.
  console.log('colour by position:', await setSelect('colour by', 'linear position along the sequence'))
  await sleep(1000)
  await shot('t2-ramp-own-scale')
  console.log('colour scale row present:', await page.evaluate(() =>
    [...document.querySelectorAll('*')].some((el) => (el.textContent ?? '').trim().startsWith('colour scale')),
  ))
  console.log('colour scale -> magma:', await setSelect('colour scale', 'magma'))
  await sleep(1000)
  await shot('t3-ramp-magma')
  // …and it is not offered for a colouring that is levels rather than a ramp.
  await setSelect('colour by', 'sequence')
  await sleep(900)
  console.log('colour scale hidden for levels:', await page.evaluate(() =>
    ![...document.querySelectorAll('*')].some((el) => (el.textContent ?? '').trim().startsWith('colour scale')),
  ))

  // The three sticky modes, pressed.
  await page.evaluate(() => document.querySelector('.structure-select')?.click())
  await sleep(700)
  await shot('t4-mark-mode-on')
  await page.evaluate(() => document.querySelector('.structure-loop')?.click())
  await sleep(700)
  await shot('t5-loop-mode-on')
  console.log('mode classes:', await page.evaluate(() =>
    ['select', 'loop', 'measure']
      .map((m) => `${m}=${document.querySelector(`.structure-${m}`)?.classList.contains('is-on')}`)
      .join(' '),
  ))
  await page.evaluate(() => document.querySelector('.structure-loop')?.click())
  await sleep(500)

  // The grips on the Structures card.
  console.log('structure grips:', await page.evaluate(() =>
    document.querySelectorAll('.structure-card .ann-grip').length,
  ))
  await shot('t6-structures-card-grips')
} catch (e) {
  console.log('FAILED', e)
  await shot('z-failure')
} finally {
  console.log('page errors:', errors.length === 0 ? 'none' : errors.join('\n'))
  await browser.close()
}
