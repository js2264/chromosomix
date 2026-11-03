/**
 * Pictures for embed/web-page.md: the viewer embedded in a page of our own, as
 * the page's first snippet writes it — `?embed=1` before the `#` of a link to
 * the yeast Micro-C demo on the lab's bucket, IV:1.0–1.4 Mb, balanced, log10,
 * in an `<iframe>` 640 high — framing the dev server's build of the app.
 *
 * The host page is a plain page of text written here and handed to the browser
 * by a route at http://example.org/figure.html (nothing is written to disk), so
 * that the frame is on another origin than the page, as it is on a lab's site.
 * The embed's one bar shows above the map, both side panels folded as strips.
 *
 *   node documentation/scripts/screens/embed-web-page.cjs [out-dir]   # em-page
 */

const { BASE, BUCKET, sleep, start } = require('./browse-lib.cjs')

const SRC =
  `${BASE}/?embed=1#uri=${BUCKET}/yeast/Yeast_microC_G2M_1kb.cool` +
  '&view=region&region=IV:1000000-1400000&transform=log10&balance=true'

const HOST = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Micro-C of yeast chromosome IV</title>
<style>
  body { margin: 0; background: #fff; color: #1d2126; font: 16px/1.55 Georgia, 'Times New Roman', serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 36px 40px 48px; }
  h1 { font-size: 30px; font-weight: normal; margin: 0 0 10px; }
  p { margin: 0 0 18px; max-width: 46em; }
  figure { margin: 26px 0 0; }
  figcaption { font-size: 14px; color: #555; margin-top: 8px; }
</style>
</head>
<body>
<main>
  <h1>Micro-C of yeast chromosome IV</h1>
  <p>The map below is live: pan and zoom it, change its colours, or open it in the full viewer from the
  name at its top left. It is read from where the data are published, a megabyte at a time.</p>
  <figure>
    <iframe src="${SRC}" width="100%" height="640" loading="lazy" style="border: 0"
            title="Micro-C of yeast chromosome IV"></iframe>
    <figcaption>Micro-C, G2/M, chromosome IV from 1.0 to 1.4 Mb at 1 kb, balanced.</figcaption>
  </figure>
</main>
</body>
</html>`

;(async () => {
  const app = await start(process.argv[2])
  const { page, context } = app
  await context.route('http://example.org/figure.html', (route) => route.fulfill({ contentType: 'text/html', body: HOST }))
  try {
    await page.goto('http://example.org/figure.html')
    const frame = await (await page.waitForSelector('iframe')).contentFrame()
    await frame.waitForSelector('.heatmap-canvas', { timeout: 180000 })
    await frame.waitForFunction(() => performance.getEntriesByName('chromosomix:rendered').length > 0, null, { timeout: 180000 })
    await sleep(2500)
    console.log('bar:', await frame.evaluate(() => document.querySelector('header, .app-header, .embed-bar')?.textContent?.replace(/\s+/g, ' ').trim()))
    await page.mouse.move(8, 8)
    await sleep(500)
    await app.shot('em-page', { fullPage: true })
  } finally {
    await app.close()
  }
})()
