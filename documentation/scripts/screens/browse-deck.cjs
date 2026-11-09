/**
 * Pictures for browse/deck.md: a 2 × 2 deck of four yeast contact maps at one
 * locus, IV:1.0–1.4 Mb, each with the ATAC-seq track under it — the lab's
 * G2/M Micro-C cooler at 1 kb, the Micro-C of Costantino et al. 2020 (GEO
 * GSE151553), whose sequences are spelt `chrIV`, at 1.6 kb, and the G1 and G2/M
 * Hi-C of Meneu et al. 2025 at 2 kb — every file read from the lab's bucket.
 *
 * The deck is a workspace, written here and handed to the page at an address
 * of the dev server's (a route, so nothing is written to disk): its `maps`
 * open the three cells beside the first, its `lanes` put the track on each of
 * them as the Tracks card's location row would, and its `mapNames` name the
 * cells as a reader would by clicking their headings.
 *
 *   node documentation/scripts/screens/browse-deck.cjs [out-dir]   # dk-four
 */

const { BASE, BUCKET, sleep, start } = require('./browse-lib.cjs')

const MICROC = `${BUCKET}/yeast/Yeast_microC_G2M_1kb.cool`
const COSTANTINO = `${BUCKET}/yeast/GSE151553_A364_merged.mcool::/resolutions/1600`
const HIC_G1 = `${BUCKET}/meneu/HiC/HiC_Mpneumo_G1.mcool::/resolutions/2000`
const HIC_G2M = `${BUCKET}/meneu/HiC/HiC_Mpneumo_G2M.mcool::/resolutions/2000`
const ATAC = `${BUCKET}/yeast/Yeast_ATAC.bw`
const BOTTOM = { top: false, bottom: true, left: false, right: false }

const workspace = {
  kind: 'chromosomix.workspace',
  version: 1,
  createdAt: '2026-11-03T00:00:00.000Z',
  active: 0,
  tabs: [
    {
      version: 1,
      createdAt: '2026-11-03T00:00:00.000Z',
      state: {
        uri: MICROC,
        maps: [COSTANTINO, HIC_G1, HIC_G2M].join('|'),
        view: 'region',
        region: 'IV:1000000-1400000',
        level: 'bin',
        balance: true,
        transform: 'log10',
        colormap: 'default',
      },
      tracks: [
        {
          id: 'atac',
          card: 'linear',
          kind: 'track',
          label: 'ATAC',
          source: { kind: 'remote', name: 'Yeast_ATAC.bw', url: ATAC },
          visible: true,
          placement: BOTTOM,
          style: {
            colour: '#d55e00',
            size: 44,
            mode: 'area',
            limits: { auto: true, min: 0, max: 1 },
            group: '',
            shape: 'element',
            radius: 7,
            opacity: 1,
            flip: false,
          },
        },
      ],
      lanes: [COSTANTINO, HIC_G1, HIC_G2M].map((uri) => ({ track: 'atac', uri, placement: BOTTOM, borrowedLead: false })),
      manual: [],
      sequences: [],
      groups: {},
      scaling: {},
      compareNormalise: false,
      tables: {},
      name: 'four maps',
      deck: { columns: 2 },
      mapNames: {
        [MICROC]: 'Micro-C, G2/M',
        [COSTANTINO]: 'Micro-C, Costantino 2020',
        [HIC_G1]: 'Hi-C, G1',
        [HIC_G2M]: 'Hi-C, G2/M',
      },
    },
  ],
}

;(async () => {
  const app = await start(process.argv[2])
  const { page, context } = app
  // By path, not by glob: the page's own address ends with this path too, in its query.
  await context.route(
    (url) => url.pathname === '/__screens/four-maps.chromosomix.json',
    (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(workspace) }),
  )
  try {
    await app.open(`?config=${BASE}/__screens/four-maps.chromosomix.json`)
    await app.until(() => document.querySelectorAll('.heatmap-canvas').length >= 4)
    await app.press('Fold the General panel')
    await app.press('Fold the Aesthetics panel')
    await app.until(() => true)
    // A deck's cells are as tall as they are wide, so two rows of them run past
    // a 900-pixel window: the window is made as tall as the deck, at the same
    // width, so that the whole grid is in one picture.
    const overflow = await page.evaluate(() => {
      let node = document.querySelector('.heatmap-canvas')
      while (node !== null && node !== document.body) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node.scrollHeight - node.clientHeight
        node = node.parentElement
      }
      return 0
    })
    console.log('deck runs past the window by', overflow, 'px')
    if (overflow > 0) {
      await page.setViewportSize({ width: 1440, height: 900 + overflow + 8 })
      await app.until(() => true)
    }
    await page.mouse.move(8, (await page.viewportSize()).height - 8)
    await sleep(800)
    console.log(
      'cells:',
      await page.evaluate(() => [...document.querySelectorAll('.map-key-title')].map((n) => n.textContent)),
    )
    await app.shot('dk-four')
  } finally {
    await app.close()
  }
})()
