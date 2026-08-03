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

/** CSS pixels are defined as 1/96 inch, which is what makes DPI meaningful. */
export const CSS_DPI = 96

/** Offered resolutions. 96 is "what is on screen"; 300 is print. */
export const EXPORT_DPI_CHOICES = [96, 150, 300, 600] as const

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

/** Hand a blob to the browser as a download, then release the object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
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
async function deflate(bytes: Uint8Array): Promise<{ data: Uint8Array; filter: string | null }> {
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
  options: { dpi: number; title?: string },
): Promise<Blob> {
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Could not read the canvas back for export.')
  const { width, height } = canvas
  const { data, filter } = await deflate(toRgb(ctx.getImageData(0, 0, width, height)))

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
  const title = (options.title ?? 'contact map').replace(/[()\\]/g, '')
  push(`6 0 obj\n<< /Title (${title}) /Producer ((meta)cooler) >>\nendobj\n`)

  const xrefAt = length
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  push(xref)
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  )

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}
