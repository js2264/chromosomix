/**
 * Pictures for advanced/track-hubs.md and advanced/data-store.md: the store
 * drawer, opened by `?store=<address>` as a link opens it.
 *
 * First the yeast demo's UCSC assembly hub, read from the lab's bucket
 * (demo/yeast/hub.txt, genomes.txt and trackDb.txt): its rows grouped under the
 * assembly's heading, with *open with its tracks* on it (hub-drawer).
 *
 * Then a lab's own store: a store file as data-store.md teaches one, written
 * here and handed to the page by a route (nothing is written to disk) at
 * https://example.org/data/store.json, the example address the page's own store
 * uses for a lab's server — so the drawer's address box reads as a published
 * store's would. Its rows are real files on the lab's bucket —
 * the yeast Micro-C cooler and its workspace, the G1 and G2/M Hi-C of Meneu et
 * al. 2025, and the demo's tracks — with the assay, condition and format of
 * each as its columns (store-drawer).
 *
 *   node documentation/scripts/screens/advanced-stores.cjs [out-dir]   # hub-drawer, store-drawer
 */

const { BASE, BUCKET, sleep, start } = require('./browse-lib.cjs')

const store = {
  kind: 'chromosomix.store',
  version: 1,
  name: 'My lab’s maps',
  description: 'Micro-C, Hi-C and tracks of yeast, by assay and condition.',
  base: `${BUCKET}/`,
  columns: [
    { key: 'assay', label: 'Assay' },
    { key: 'condition', label: 'Condition' },
    { key: 'format', label: 'Format' },
  ],
  entries: [
    {
      label: 'Micro-C, G2/M',
      uri: 'yeast/Yeast_microC_G2M_1kb.cool',
      kind: 'map',
      size: 18985732,
      fields: { assay: 'Micro-C', condition: 'G2/M', format: 'cool' },
      note: '1 kb bins, balanced',
      tracks: [
        { label: 'ATAC-seq', url: 'yeast/Yeast_ATAC.bw' },
        { label: 'genes', url: 'yeast/Yeast_annotations.gtf' },
      ],
    },
    {
      label: 'Micro-C, G2/M, with its tracks',
      uri: 'yeast/Yeast_microC.chromosomix.json',
      kind: 'workspace',
      fields: { assay: 'Micro-C', condition: 'G2/M', format: 'workspace' },
    },
    {
      label: 'Hi-C, G1',
      uri: 'meneu/HiC/HiC_Mpneumo_G1.mcool',
      kind: 'map',
      size: 19399135,
      fields: { assay: 'Hi-C', condition: 'G1', format: 'mcool' },
      note: 'Meneu et al. 2025',
    },
    {
      label: 'Hi-C, G2/M',
      uri: 'meneu/HiC/HiC_Mpneumo_G2M.mcool',
      kind: 'map',
      size: 17261315,
      fields: { assay: 'Hi-C', condition: 'G2/M', format: 'mcool' },
      note: 'Meneu et al. 2025',
    },
    {
      label: 'ATAC-seq',
      uri: 'yeast/Yeast_ATAC.bw',
      kind: 'track',
      size: 14565281,
      fields: { assay: 'ATAC-seq', format: 'bigWig' },
    },
    {
      label: 'ATAC-seq peaks',
      uri: 'yeast/Yeast_ATAC.narrowPeak',
      kind: 'track',
      size: 499564,
      fields: { assay: 'ATAC-seq', format: 'narrowPeak' },
    },
    {
      label: 'Pol II ChIP over input',
      uri: 'yeast/Yeast_ChIP_Pol2-vs-input.bw',
      kind: 'track',
      size: 12543169,
      fields: { assay: 'ChIP-seq', format: 'bigWig' },
    },
    {
      label: 'MNase-seq',
      uri: 'yeast/Yeast_MNase.bw',
      kind: 'track',
      size: 23431527,
      fields: { assay: 'MNase-seq', format: 'bigWig' },
    },
    {
      label: 'RNA-seq, forward strand',
      uri: 'yeast/Yeast_RNA_fwd.bw',
      kind: 'track',
      size: 19898042,
      fields: { assay: 'RNA-seq', format: 'bigWig' },
    },
    {
      label: 'RNA-seq, reverse strand',
      uri: 'yeast/Yeast_RNA_rev.bw',
      kind: 'track',
      size: 20339509,
      fields: { assay: 'RNA-seq', format: 'bigWig' },
    },
    {
      label: 'Genes',
      uri: 'yeast/Yeast_annotations.gtf',
      kind: 'track',
      size: 9545422,
      fields: { assay: 'annotation', format: 'GTF' },
    },
  ],
}

;(async () => {
  const app = await start(process.argv[2])
  const { page, context } = app
  await context.route('https://example.org/data/store.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(store),
    }),
  )
  const drawer = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.store-drawer .portal-row-text').length > 3, null, {
      timeout: 120000,
    })
    await sleep(2500)
  }
  try {
    await page.goto(`${BASE}/?store=${BUCKET}/yeast/hub.txt`)
    await drawer()
    await page.mouse.move(8, 892)
    await sleep(500)
    console.log('hub:', (await page.evaluate(() => document.querySelector('.store-drawer')?.innerText ?? '')).slice(0, 900))
    await app.shot('hub-drawer')

    await page.goto('about:blank')
    await page.goto(`${BASE}/?store=https://example.org/data/store.json`)
    await drawer()
    await page.mouse.move(8, 892)
    await sleep(500)
    console.log('store:', (await page.evaluate(() => document.querySelector('.store-drawer')?.innerText ?? '')).slice(0, 900))
    await app.shot('store-drawer')
  } finally {
    await app.close()
  }
})()
