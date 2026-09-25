/**
 * Saving the picture: a raster at a chosen resolution, as PNG or as PDF.
 *
 * The figure is re-rendered rather than screen-grabbed. Everything the canvas
 * draws — the matrix, the separators, the labels, the ticks — is redrawn at the
 * requested device-pixel ratio, so a 300 dpi export is a 300 dpi *drawing*, not
 * an upscaled screenshot. The one thing that does not change is the layout: the
 * view is exported exactly as it is framed on screen, including the pan and the
 * zoom, because that framing is the thing the user is asking to keep.
 *
 * The PDF is written here, in about eighty lines, rather than by pulling in a
 * PDF library. A single-page document holding one image is four objects and a
 * cross-reference table; a dependency for that would be several hundred
 * kilobytes to do the same arithmetic, in an app whose entire point is that it
 * has no server and little else.
 */

import { PRODUCER } from '../version'
import { logAction } from '../state/actions'
import { fmt } from './dom'
import { messageToast } from './toast'

/** CSS pixels are defined as 1/96 inch, which is what makes DPI meaningful. */
export const CSS_DPI = 96

/** Offered resolutions. 96 is "what is on screen"; 300 is print. */
export const EXPORT_DPI_CHOICES = [96, 150, 300, 600] as const

/**
 * The two files a **map** writes, in the order they are offered.
 *
 * PDF leads because it is the default: a figure ends up in a manuscript, and a
 * one-page PDF carrying a lossless image is what a journal asks for. PNG is the
 * same picture for a slide or an email.
 *
 * `PDF (image)`, and the word earns its place: a contact map is a raster, so
 * this PDF is a page carrying one — pretending otherwise would mean writing
 * down a million rectangles. The 1D browser's own list says `PDF (vector)`
 * because nothing it draws is a raster, and a reader who saved a map as `PDF`
 * and opened it in Illustrator expecting paths had been told that by the other
 * card and nothing at all by this one.
 */
export const EXPORT_FORMATS = [
  { value: 'pdf', label: 'PDF (image)' },
  { value: 'png', label: 'PNG' },
] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]['value']

/** Device pixels per CSS pixel for a target DPI. */
export function scaleForDpi(dpi: number): number {
  return dpi / CSS_DPI
}

/** PDF user-space units are points, 1/72 inch. */
export function pointsForCssPixels(cssPixels: number): number {
  return (cssPixels * 72) / CSS_DPI
}

/**
 * A filename stem from whatever the view calls itself, with everything a
 * filesystem might object to removed. Empty in, `contact-map` out.
 */
export function exportBaseName(title: string): string {
  const cleaned = title
    .replace(/[×✓]/g, 'x')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return cleaned === '' ? 'contact-map' : cleaned
}

/**
 * `20260803-145233` — the stamp a saved file carries in its name.
 *
 * Local time, not UTC: the person reading the filename is the person who
 * pressed the button, and a figure saved at half past two in the afternoon
 * should say so. Sortable, so a directory of exports is in the order they were
 * made whatever they are called.
 */
export function fileStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** `2026-08-03 14:52` — the same instant, for a human reading the figure. */
export function captionStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

/** `D:20260803145233` — PDF's own date syntax, for `/CreationDate`. */
function pdfDate(now: Date): string {
  return `D:${fileStamp(now).replace('-', '')}`
}

/**
 * Where one file this app writes is going.
 *
 * Chosen before anything is made for it — see {@link chooseSaveTarget} — and
 * written once the bytes exist. `name` is what it will be called, which is the
 * reader's own where the save dialog let them type one, so the line a card
 * writes under its button after a save names the file that is actually there.
 */
export interface SaveTarget {
  readonly name: string
  write(blob: Blob): Promise<void>
}

/** The part of the File System Access API this module calls, where a browser has it. */
type SavePicker = (options: {
  suggestedName: string
  startIn?: 'downloads'
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<{ name: string; createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>

/**
 * Ask the reader where a file goes, with its name ready to change — the
 * platform's own save dialog, opened in their Downloads folder.
 *
 * **Asked before the file is made, not after.** A browser opens that dialog
 * only while the click that asked for it is still recent (a few seconds, in
 * Chromium), and an `.mcool`, a bigWig of a whole genome or a deck at 300 dpi
 * take longer than that to produce: asked afterwards, the dialog was refused
 * and the file went wherever the browser puts downloads — the very behaviour
 * this replaces. So every export asks first, from inside the click, and does
 * its work only once there is somewhere to put it; a reader who cancels has
 * not waited for a render nobody wanted.
 *
 * **Every file this app writes leaves through here**, and that is why the
 * console's record of one is written here too rather than at each of the
 * twenty-odd places that ask for one (§23): one choke point, one line, no road
 * around it. What is knowable here is the name and the size, which is exactly
 * what the console's line says; the provenance of what is inside the file is
 * the caller's, and already in the file's own header (§18.4).
 *
 * `null` is that cancel. Where there is no such dialog — Firefox, Safari, a
 * page not served over HTTPS — or the browser refused to open one, the target
 * is the download this app always made, under the name it suggested: the file
 * still arrives, in the one place that browser puts files.
 */
export async function chooseSaveTarget(filename: string, type = ''): Promise<SaveTarget | null> {
  const picker = typeof window === 'undefined' ? undefined : (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(window, {
        suggestedName: filename,
        startIn: 'downloads',
        ...acceptFor(filename, type),
      })
      return {
        name: handle.name,
        write: async (blob) => {
          const out = await handle.createWritable()
          await out.write(blob)
          await out.close()
          logWrite(handle.name, blob)
        },
      }
    } catch (err) {
      // The reader closed the dialog: nothing is written, and nothing is said.
      if (err instanceof DOMException && err.name === 'AbortError') return null
      // Anything else — the click too long ago, a sandboxed frame, a type the
      // dialog would not take — is the dialog failing, not the reader
      // declining, and the file is still owed to them.
    }
  }
  return { name: filename, write: async (blob) => downloadTo(blob, filename) }
}

/**
 * Save a blob the app already has: {@link chooseSaveTarget}, then its write.
 *
 * For the files that exist the moment the button is pressed — a BED of marks,
 * the console's log, a table — where there is no work to put after the dialog.
 * Resolves to the name it was written under, or `null` where the reader
 * cancelled.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<string | null> {
  const target = await chooseSaveTarget(filename, blob.type)
  if (target === null) return null
  try {
    await target.write(blob)
  } catch (err) {
    // A folder that went read-only, a disk that filled: said where the reader
    // is looking, since a save that silently wrote nothing is a file they will
    // go looking for later.
    messageToast(`Could not write ${target.name}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  return target.name
}

/**
 * The dialog's file-type filter: one entry, the kind this file is, so the
 * dialog's own list says *PNG image* rather than *All files*. Left out where the
 * name has no extension the dialog would accept, since a filter it refuses is a
 * dialog that does not open.
 */
function acceptFor(filename: string, type: string): { types?: Array<{ description: string; accept: Record<string, string[]> }> } {
  const extension = /\.[A-Za-z0-9]{1,15}$/.exec(filename)?.[0]
  if (extension === undefined) return {}
  const mime = /^[a-z]+\/[A-Za-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream'
  const kind = extension.slice(1).toLowerCase()
  const description = KIND_NAMES[kind] ?? `${extension.slice(1)} file`
  return { types: [{ description, accept: { [mime]: [extension] } }] }
}

/** What the save dialog's type list calls the files this app writes most. */
const KIND_NAMES: Record<string, string> = {
  png: 'PNG image',
  pdf: 'PDF document',
  tsv: 'Tab-separated table',
  json: 'JSON',
  bw: 'bigWig track',
  bedgraph: 'bedGraph track',
  bed: 'BED intervals',
  bedpe: 'BEDPE pairs',
  bed3d: 'bed3d structure',
  mcool: 'Multi-resolution cooler',
}

/** The console's line for a written file (§23): its name and its size. */
function logWrite(filename: string, blob: Blob): void {
  logAction({
    kind: 'write',
    line: `wrote ${filename}`,
    detail: [`# file: ${filename}`, `# size: ${fmt.bytes(blob.size)}`],
    where: filename,
  })
}

/** Hand a blob to the browser as a download, then release the object URL. */
function downloadTo(blob: Blob, filename: string): void {
  logWrite(filename, blob)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Late enough that the download has taken its reference; immediate revocation
  // cancels the save in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Put a PNG on the system clipboard.
 *
 * Takes the *promise*, not the blob, and that is not a convenience. Safari
 * requires the `ClipboardItem` to be constructed while the user gesture that
 * asked for it is still on the stack, and re-drawing a figure at export
 * resolution takes long enough to lose it — so the item is built first, holding
 * a promise the browser waits on itself. Chrome and Firefox accept the same
 * shape, so there is one path rather than a fork on the user agent.
 *
 * A rejected render surfaces as a rejection here, which is what the caller's
 * status line is for.
 */
export async function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
  const scope = globalThis as {
    ClipboardItem?: typeof ClipboardItem
    navigator?: { clipboard?: { write?: (items: ClipboardItem[]) => Promise<void> } }
  }
  const Item = scope.ClipboardItem
  const write = scope.navigator?.clipboard?.write
  if (Item === undefined || write === undefined) {
    // Awaited first, so a figure that could not be drawn says so rather than
    // being reported as a clipboard the browser does not have.
    await png
    throw new Error('This browser will not let a page put an image on the clipboard.')
  }
  await write.call(scope.navigator!.clipboard, [new Item({ 'image/png': png })])
}

/**
 * Put a line of text on the system clipboard.
 *
 * Absent in an insecure context — which is where a colleague's `file://` copy of
 * this app runs — and absent in some embeddings, so the API is read defensively
 * and the failure is an ordinary rejection rather than a `TypeError` from
 * calling `undefined`. The same reading {@link copyPngToClipboard} takes of the
 * neighbouring method.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  const write = (
    globalThis as {
      navigator?: { clipboard?: { writeText?(text: string): Promise<void> } }
    }
  ).navigator?.clipboard?.writeText
  if (write === undefined) {
    throw new Error('This browser will not let a page write to the clipboard.')
  }
  await write.call(navigator.clipboard, text)
}

/**
 * One picture onto the clipboard from a right-click menu — *copy this* (§7.2)
 * — with a line in the corner saying what happened.
 *
 * The corner and not a surface's own line, for `ui/toast.ts`'s reason: the menu
 * closes on the press and leaves nowhere nearer to answer in. The size is in
 * the line because it is the one fact about the picture that a paste does not
 * show until it lands. Synchronous up to the clipboard's own call, which a
 * browser only takes inside the press that asked for it.
 */
export function copyPicture(what: string, canvas: HTMLCanvasElement | null): void {
  if (canvas === null) {
    messageToast(`There is no ${what} drawn here to copy.`)
    return
  }
  copyPngToClipboard(canvasToPng(canvas)).then(
    () => messageToast(`Copied the ${what} · ${canvas.width} × ${canvas.height} px`),
    (err: unknown) =>
      messageToast(`The ${what} could not be copied: ${err instanceof Error ? err.message : String(err)}`),
  )
}

/** The canvas as a PNG blob. */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('The browser refused to encode the canvas as a PNG.')
  return blob
}

/**
 * zlib-compress, which is what PDF's `/FlateDecode` means.
 *
 * `CompressionStream` is in every browser this app targets. Where it is
 * missing the bytes go in uncompressed — a legal PDF that is simply large,
 * which beats refusing to export at all.
 */
export async function deflateBytes(
  bytes: Uint8Array,
): Promise<{ data: Uint8Array; filter: string | null }> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream
  if (Compression === undefined) return { data: bytes, filter: null }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Compression('deflate'))
  const packed = new Uint8Array(await new Response(stream).arrayBuffer())
  return { data: packed, filter: '/FlateDecode' }
}

/** Drop the alpha channel: the page is opaque, and PDF has no use for it. */
function toRgb(image: ImageData): Uint8Array {
  const rgba = image.data
  const rgb = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    rgb[o] = rgba[i]
    rgb[o + 1] = rgba[i + 1]
    rgb[o + 2] = rgba[i + 2]
  }
  return rgb
}

/**
 * A one-page PDF holding the canvas as a single lossless image.
 *
 * The page is sized in points from the *CSS* size, so the image lands at
 * exactly `dpi` dots per inch on paper however many pixels it carries; the two
 * are the same fact stated in the two units a PDF needs.
 */
export async function canvasToPdf(
  canvas: HTMLCanvasElement,
  options: { dpi: number; title?: string; subject?: string; created?: Date },
): Promise<Blob> {
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Could not read the canvas back for export.')
  const { width, height } = canvas
  const { data, filter } = await deflateBytes(toRgb(ctx.getImageData(0, 0, width, height)))

  const scale = scaleForDpi(options.dpi)
  const pageWidth = pointsForCssPixels(width / scale)
  const pageHeight = pointsForCssPixels(height / scale)
  const round = (n: number): string => n.toFixed(2)

  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const encoder = new TextEncoder()
  const push = (part: Uint8Array | string): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const startObject = (): void => {
    offsets.push(length)
  }

  const content = `q ${round(pageWidth)} 0 0 ${round(pageHeight)} 0 0 cm /Im0 Do Q\n`

  push('%PDF-1.4\n%âãÏÓ\n')
  startObject()
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  startObject()
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  startObject()
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(pageWidth)} ${round(pageHeight)}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
  )
  startObject()
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 ${filter === null ? '' : `/Filter ${filter} `}` +
      `/Length ${data.length} >>\nstream\n`,
  )
  push(data)
  push('\nendstream\nendobj\n')
  startObject()
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)
  startObject()
  // The caption drawn on the page, repeated as document metadata: a figure
  // dropped into a manuscript keeps its provenance even when the caption is
  // cropped off, and `pdfinfo` is where anyone looks for it first.
  const clean = (text: string): string => text.replace(/[()\\]/g, '')
  const title = clean(options.title ?? 'contact map')
  const subject = options.subject === undefined ? '' : ` /Subject (${clean(options.subject)})`
  const created =
    options.created === undefined ? '' : ` /CreationDate (${pdfDate(options.created)})`
  push(`6 0 obj\n<< /Title (${title})${subject}${created} /Producer (${PRODUCER}) >>\nendobj\n`)

  const xrefAt = length
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  push(xref)
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  )

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

/**
 * The largest canvas a browser will actually give you.
 *
 * Chrome caps the *area* at 2^28 px; Firefox caps each *side* at 32,767; iOS
 * Safari caps the area at 2^24 on memory-constrained devices. Past any of them
 * `getContext` hands back a blank canvas rather than throwing, so an export goes
 * silently white — which is why this is a pre-flight and not a `catch`.
 */
export const CANVAS_MAX_AREA = 268_435_456
export const CANVAS_MAX_SIDE = 32_767

/**
 * The largest offered DPI whose canvas fits, or `null` when even the smallest
 * does.
 *
 * Offered as advice rather than as a clamp: the user picked a DPI and is owed a
 * reason and a number, not a quietly different file.
 */
export function largestDpiThatFits(
  cssWidth: number,
  cssHeight: number,
  choices: readonly number[] = EXPORT_DPI_CHOICES,
): number | null {
  const fits = (dpi: number): boolean => {
    const scale = scaleForDpi(dpi)
    const w = Math.max(1, Math.round(cssWidth * scale))
    const h = Math.max(1, Math.round(cssHeight * scale))
    return w * h <= CANVAS_MAX_AREA && w <= CANVAS_MAX_SIDE && h <= CANVAS_MAX_SIDE
  }
  const ok = [...choices].sort((a, b) => b - a).find(fits)
  return ok ?? null
}

/**
 * The page colour an export is flattened onto — the theme in force.
 *
 * Here rather than beside the one figure that used to draw it, because a deck
 * flattens its cells onto the same ground and two readings of `--bg` are two
 * chances for a figure and the figure beside it to disagree about what white is.
 */
export function readPageBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  return value === '' ? '#ffffff' : value
}
