/**
 * The Files column against every kind of file a folder holds (§20.5): what it
 * offers, what it draws dimmed and why, and what each offered row does.
 *
 * The folder is the yeast demo's own directory — its map, its loop table, its
 * cytobands, its model, its workspace, its BAM and index, its track hub — with
 * the model again as the PDB this app writes, a narrowPeak bgzipped as `.bgz`,
 * a page of prose under `.txt`, and five names nothing here opens: a CSV, a
 * CRAM, a bzip2'd BED, a Markdown note and a FASTQ. It stands in the
 * origin-private file system as `run2`, handed back by a stand-in folder
 * dialog — a real directory handle, read by the code a folder on disk is.
 *
 * - **fr01** the column as connected, every row's state, drag and tooltip printed;
 *   **fr01b** the column alone, close up;
 * - **fr02** the map opened from its row, at IV:1–1.4 Mb;
 * - **fr03** the loop table added by its `+` — a `.tsv` the column dimmed;
 * - **fr04** the model added — a `.g3d.gz` the column dimmed — in its cell;
 * - **fr05** the PDB added beside it, read back bead for bead;
 * - **fr06** the `.bgz` narrowPeak added as a track;
 * - **fr07** the workspace's one mark: its tabs appended beside this one, and
 *   no empty tab left between (the strip printed);
 * - **fr08** the prose `.txt` opened in a tab of its own: what an offered text
 *   that is not a table says.
 *
 *   npm run dev -- --host 127.0.0.1 --port 5173 &
 *   node scripts/ui-files-routes.mjs [out-dir]
 */

import { readFileSync, existsSync } from 'node:fs'
import { crc32, deflateRawSync } from 'node:zlib'
import { gallery, sleep } from './gallery-lib.mjs'

const OUT = process.argv[2] ?? 'gallery'
const { page: first, close, base, browser } = await gallery(OUT, { width: 1600, height: 1000 })
await first.close()

/** BGZF, as `bgzip` writes it: deflate blocks of at most 64 KiB, each its own gzip member, then the EOF block. */
function bgzf(payload) {
  const blocks = []
  for (let at = 0; at < payload.length; at += 0xff00) {
    const chunk = payload.subarray(at, at + 0xff00)
    const deflated = deflateRawSync(chunk, { level: 6 })
    const head = Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0, 0, 0])
    head.writeUInt16LE(18 + deflated.length + 8 - 1, 16)
    const tail = Buffer.alloc(8)
    tail.writeUInt32LE(crc32(chunk), 0)
    tail.writeUInt32LE(chunk.length, 4)
    blocks.push(head, deflated, tail)
  }
  blocks.push(Buffer.from('1f8b08040000000000ff0600424302001b0003000000000000000000', 'hex'))
  return Buffer.concat(blocks)
}

/** Files the demo does not have, written here: name → base64 of the bytes. */
const made = {
  'Yeast_ATAC.narrowPeak.bgz': bgzf(readFileSync('demo/yeast/Yeast_ATAC.narrowPeak')).toString('base64'),
  'methods_notes.txt': Buffer.from(
    'Micro-C, G2/M arrest, two biological replicates merged.\nBinned at 1 kb with cooler, balanced with ICE.\n',
  ).toString('base64'),
  'tracing.csv': Buffer.from('trace,x,y,z\n1,0.1,0.2,0.3\n').toString('base64'),
  'reads.cram': Buffer.from('CRAM\x03\x01').toString('base64'),
  'peaks.bed.bz2': Buffer.from('BZh91AY&SY').toString('base64'),
  'README.md': Buffer.from('# run2\n').toString('base64'),
  'reads.fastq.gz': Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]).toString('base64'),
}
// The model as the PDB this app writes, from the saves gallery (`ui-saves.mjs`)
// when it has run, so the folder holds the file a reader would have saved.
const pdb = `${OUT}/x2b-model.pdb`
if (existsSync(pdb)) made['Yeast_structure.pdb'] = readFileSync(pdb).toString('base64')
else console.log(`no ${pdb}: run scripts/ui-saves.mjs first for the PDB row`)

/** The demo's own files, fetched from the dev server into the folder. */
const DEMO = [
  'Yeast_microC_G2M_1kb.cool',
  'Yeast_microC_loops.tsv',
  'Yeast_cytobands.txt',
  'Yeast_structure.g3d.gz',
  'Yeast_microC.chromosomix.json',
  'Yeast_ONT_basemods.sim.bam',
  'Yeast_ONT_basemods.sim.bam.bai',
  'hub.txt',
  'genomes.txt',
  'trackDb.txt',
]

const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.addInitScript(() => {
  window.showDirectoryPicker = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle('run2', { create: true })
  window.showSaveFilePicker = undefined
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

const shot = async (name, clip) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip === undefined ? {} : { clip }) })
  console.log('wrote', `${name}.png`)
}
const row = (name) => page.locator('.folder-entry', { hasText: name }).first()
const add = async (name) => {
  await row(name).locator('.row-verb-add').click()
  await sleep(6000)
}
const tracks = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ann-name, .track-name')].map((n) => (n instanceof HTMLInputElement ? n.value : n.textContent)),
  )
const tabs = () => page.evaluate(() => [...document.querySelectorAll('.tabs .tab-label')].map((n) => n.textContent))

try {
  await page.goto(`${base}/`)
  await sleep(2500)
  await page.evaluate(
    async ({ at, demo, made }) => {
      const root = await navigator.storage.getDirectory()
      const run2 = await root.getDirectoryHandle('run2', { create: true })
      const put = async (name, bytes) => {
        const handle = await run2.getFileHandle(name, { create: true })
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
      }
      for (const name of demo) await put(name, await (await fetch(`${at}/demo/yeast/${name}`)).arrayBuffer())
      for (const [name, b64] of Object.entries(made)) {
        await put(name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
      }
    },
    { at: base, demo: DEMO, made },
  )
  await page.getByRole('button', { name: /^choose a folder/ }).first().click()
  await sleep(2000)
  const listed = await page.evaluate(() =>
    [...document.querySelectorAll('.folder-entry')].map((node) => ({
      name: node.querySelector('.folder-entry-name')?.textContent,
      offered: node.classList.contains('folder-entry-file'),
      drags: node.draggable,
      verbs: [...node.querySelectorAll('.row-verb')].map((verb) => verb.getAttribute('title')),
      why: node.getAttribute('title'),
    })),
  )
  for (const entry of listed) {
    console.log(
      `${entry.offered ? 'offered' : 'DIMMED '} ${entry.drags ? 'drags' : '     '}  ${entry.name?.padEnd(32)} ${entry.offered ? entry.verbs.join(' | ') : entry.why}`,
    )
  }
  await shot('fr01-folder-listed')
  const column = await page.locator('.files-card').first().boundingBox()
  if (column !== null) {
    await shot('fr01b-folder-close', { x: column.x - 8, y: column.y - 8, width: column.width + 16, height: Math.min(column.height + 16, 1000 - column.y) })
  }

  // The map, from its row, at the window the demo's workspace shows.
  await row('Yeast_microC_G2M_1kb.cool').click()
  await page.waitForSelector('.input-region', { timeout: 120000 })
  await sleep(1500)
  const box = page.locator('.input-region').first()
  await box.fill('IV:1,000,001-1,400,000')
  await box.press('Enter')
  await page.waitForFunction(() => document.querySelector('.heatmap-canvas') !== null, null, { timeout: 120000 })
  await sleep(4000)
  await shot('fr02-map-from-folder')

  await add('Yeast_microC_loops.tsv')
  console.log('after the loop table:', JSON.stringify(await tracks()))
  await shot('fr03-loops-tsv-added')

  await add('Yeast_structure.g3d.gz')
  await page.waitForSelector('.deck-structure', { timeout: 60000 }).catch(() => {})
  await sleep(4000)
  console.log('3D cells after the g3d:', await page.locator('.deck-structure').count())
  await shot('fr04-g3d-added')

  if (made['Yeast_structure.pdb'] !== undefined) {
    await add('Yeast_structure.pdb')
    await sleep(4000)
    console.log('3D cells after the PDB:', await page.locator('.deck-structure').count())
    const card = await page.evaluate(() =>
      [...document.querySelectorAll('.structure-card .structure-row, .structure-card .ann-row')].map((n) => n.textContent?.replace(/\s+/g, ' ').trim()),
    )
    console.log('Structures card:', JSON.stringify(card))
    await shot('fr05-pdb-added')
  }

  await add('Yeast_ATAC.narrowPeak.bgz')
  console.log('after the .bgz:', JSON.stringify(await tracks()))
  await shot('fr06-bgz-added')

  console.log('tabs before the workspace:', JSON.stringify(await tabs()))
  await row('Yeast_microC.chromosomix.json').locator('.row-verb-new').click()
  await sleep(9000)
  console.log('tabs after the workspace:', JSON.stringify(await tabs()))
  await shot('fr07-workspace-appended')

  // The prose `.txt`, in a tab of its own.
  await page.locator('.tab-new').first().click()
  await sleep(1500)
  await row('methods_notes.txt').click()
  await sleep(6000)
  console.log(
    'the prose .txt says:',
    await page.evaluate(() =>
      [...document.querySelectorAll('.view-error .error-title, .view-error .error-message')].map((n) => n.textContent).join(' — '),
    ),
  )
  await shot('fr08-prose-txt')
  console.log(errors.length === 0 ? 'no page errors' : `page errors:\n${errors.join('\n')}`)
} finally {
  await context.close()
  await close()
}
