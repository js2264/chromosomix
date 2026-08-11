/**
 * A `.hic` writer, for fixtures only.
 *
 * The application does not write contact matrices and is not going to (SPECS
 * §13, §18.9). This exists for the reason `scripts/make_golden.py` exists: a
 * reader is only as trustworthy as the thing it was checked against, and there
 * is no small public `.hic` to check one against. So the suite writes files
 * whose contents it knows exactly, reads them back, and compares record for
 * record.
 *
 * **A writer is not an oracle for its own reader**, and that limit is the
 * reason `hic-straw` is a devDependency: a mutual misunderstanding of the block
 * numbering would produce a file this reader reads perfectly and no other tool
 * can open. `hic-roundtrip.test.ts` therefore reads every fixture with straw as
 * well, which is the same discipline `bigwig-write.test.ts` applies through
 * `@gmod/bbi`.
 *
 * Every encoding the format allows is reachable from here on purpose — short
 * and float values, short and int positions, list-of-rows and dense blocks,
 * v8's grid numbering and v9's diagonal numbering — because a real file mixes
 * them block by block and a reader tested against one of each is a reader
 * tested against the easy half.
 */

/** One contact, in chromosome-local bins. */
export interface HicRecord {
  x: number
  y: number
  value: number
}

export interface HicWriteChrom {
  name: string
  length: number
}

export interface HicWriteOptions {
  version: 7 | 8 | 9
  genomeId?: string
  chroms: HicWriteChrom[]
  /** Bin sizes to write. Every pair is written at every one of them. */
  resolutions: number[]
  /** Records per `"<chr1Idx>_<chr2Idx>"`, in *file* chromosome indices. */
  records: Record<string, HicRecord[]>
  /** Bins per block side. Small values exercise the block maths. */
  blockBinCount?: number
  /** Store values as int16 rather than float32. */
  shortValues?: boolean
  /** v9 only: store positions as int16 rather than int32. */
  shortPositions?: boolean
  /** Write blocks in the dense encoding (type 2) instead of list-of-rows. */
  dense?: boolean
  /** Normalisation vectors per `"<type>/<chromIdx>/<binSize>"`, as divisors. */
  norms?: Record<string, Float64Array>
  /** Free-form header attributes, as a real file carries. */
  attributes?: Record<string, string>
  /**
   * Prepend the synthetic `All` chromosome every Juicer file carries.
   *
   * On by default because that is what a real file looks like, and because the
   * reader dropping it is the behaviour most worth pinning: with `All` present
   * every real chromosome's *file* index is one higher than its display index,
   * so a reader that confuses the two reads the wrong matrix rather than
   * failing.
   */
  withAllChrom?: boolean
}

/**
 * A growable **little-endian** byte writer.
 *
 * Juicer writes through a `LittleEndianOutputStream`, against the Java default
 * and against every instinct about a binary genomics format. See
 * `hic/format.ts`'s `Cursor` for what reading it the other way produces.
 */
class Writer {
  private buffer = new Uint8Array(1 << 16)
  private view = new DataView(this.buffer.buffer)
  private at = 0

  get length(): number {
    return this.at
  }

  private need(bytes: number): void {
    if (this.at + bytes <= this.buffer.length) return
    let size = this.buffer.length
    while (size < this.at + bytes) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.buffer.subarray(0, this.at))
    this.buffer = grown
    this.view = new DataView(grown.buffer)
  }

  int8(value: number): this {
    this.need(1)
    this.view.setInt8(this.at, value)
    this.at += 1
    return this
  }

  int16(value: number): this {
    this.need(2)
    this.view.setInt16(this.at, value, true)
    this.at += 2
    return this
  }

  int32(value: number): this {
    this.need(4)
    this.view.setInt32(this.at, value, true)
    this.at += 4
    return this
  }

  int64(value: number): this {
    this.need(8)
    this.view.setBigInt64(this.at, BigInt(value), true)
    this.at += 8
    return this
  }

  float32(value: number): this {
    this.need(4)
    this.view.setFloat32(this.at, value, true)
    this.at += 4
    return this
  }

  float64(value: number): this {
    this.need(8)
    this.view.setFloat64(this.at, value, true)
    this.at += 8
    return this
  }

  string(value: string): this {
    const bytes = new TextEncoder().encode(value)
    this.need(bytes.length + 1)
    this.buffer.set(bytes, this.at)
    this.at += bytes.length
    return this.int8(0)
  }

  raw(bytes: Uint8Array): this {
    this.need(bytes.length)
    this.buffer.set(bytes, this.at)
    this.at += bytes.length
    return this
  }

  /** Overwrite an int64 already written — how the footer offset is patched in. */
  patchInt64(offset: number, value: number): void {
    this.view.setBigInt64(offset, BigInt(value), true)
  }

  /** The same, for the v8 footer's 32-bit length field. */
  patchInt32(offset: number, value: number): void {
    this.view.setInt32(offset, value, true)
  }

  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.at).slice()
  }
}

/** Bins a chromosome occupies at a bin size. */
function binsOf(length: number, binSize: number): number {
  return Math.ceil(length / binSize)
}

/**
 * Which block a record belongs in — the writer's half of `blocks.ts`.
 *
 * Written from the format's definition rather than by calling the reader, so
 * that a mistake in one does not cancel a mistake in the other. That is the
 * whole value of having both.
 */
function blockNumberOf(
  version: number,
  intra: boolean,
  x: number,
  y: number,
  blockBinCount: number,
  blockColumnCount: number,
): number {
  if (intra && version >= 9) {
    const positionAlongDiagonal = Math.floor((x + y) / 2 / blockBinCount)
    const depth = Math.floor(Math.log2(1 + Math.abs(x - y) / Math.SQRT2 / blockBinCount))
    return depth * blockColumnCount + positionAlongDiagonal
  }
  const col = Math.floor(x / blockBinCount)
  const row = Math.floor(y / blockBinCount)
  return row * blockColumnCount + col
}

/** How many block columns a matrix declares. */
function blockColumnCountOf(
  version: number,
  intra: boolean,
  nBinsX: number,
  nBinsY: number,
  blockBinCount: number,
): number {
  if (intra && version >= 9) {
    // Positions along the diagonal, plus one so the last is addressable.
    return Math.floor((nBinsX + nBinsY) / 2 / blockBinCount) + 1
  }
  return Math.max(1, Math.ceil(nBinsX / blockBinCount))
}

/** Serialise one block's records in the list-of-rows encoding (type 1). */
function encodeRows(
  records: HicRecord[],
  shortValues: boolean,
  shortPositions: boolean,
  version: number,
): Uint8Array {
  const binXOffset = Math.min(...records.map((r) => r.x))
  const binYOffset = Math.min(...records.map((r) => r.y))
  const rows = new Map<number, HicRecord[]>()
  for (const record of records) {
    const held = rows.get(record.y)
    if (held === undefined) rows.set(record.y, [record])
    else held.push(record)
  }
  const w = new Writer()
  w.int32(records.length)
  w.int32(binXOffset)
  w.int32(binYOffset)
  // The three flags are negatives: a zero byte selects the *narrow* encoding.
  w.int8(shortValues ? 0 : 1)
  if (version > 8) {
    w.int8(shortPositions ? 0 : 1)
    w.int8(shortPositions ? 0 : 1)
  }
  w.int8(1)
  const shortX = version > 8 ? shortPositions : true
  const shortY = shortX
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0])
  if (shortY) w.int16(ordered.length)
  else w.int32(ordered.length)
  for (const [y, cells] of ordered) {
    if (shortY) w.int16(y - binYOffset)
    else w.int32(y - binYOffset)
    if (shortX) w.int16(cells.length)
    else w.int32(cells.length)
    for (const cell of cells.sort((a, b) => a.x - b.x)) {
      if (shortX) w.int16(cell.x - binXOffset)
      else w.int32(cell.x - binXOffset)
      if (shortValues) w.int16(cell.value)
      else w.float32(cell.value)
    }
  }
  return w.bytes()
}

/** Serialise one block's records in the dense encoding (type 2). */
function encodeDense(records: HicRecord[], shortValues: boolean, version: number): Uint8Array {
  const binXOffset = Math.min(...records.map((r) => r.x))
  const binYOffset = Math.min(...records.map((r) => r.y))
  const maxX = Math.max(...records.map((r) => r.x))
  const maxY = Math.max(...records.map((r) => r.y))
  const width = maxX - binXOffset + 1
  const height = maxY - binYOffset + 1
  const grid = new Float64Array(width * height).fill(Number.NaN)
  for (const record of records) {
    grid[(record.y - binYOffset) * width + (record.x - binXOffset)] = record.value
  }
  const w = new Writer()
  w.int32(records.length)
  w.int32(binXOffset)
  w.int32(binYOffset)
  w.int8(shortValues ? 0 : 1)
  if (version > 8) {
    w.int8(1)
    w.int8(1)
  }
  w.int8(2)
  w.int32(grid.length)
  w.int16(width)
  for (let i = 0; i < grid.length; i++) {
    const value = grid[i]
    if (shortValues) w.int16(Number.isNaN(value) ? -32768 : value)
    else w.float32(Number.isNaN(value) ? Number.NaN : value)
  }
  return w.bytes()
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Everything the caller needs to assert against what came back. */
export interface HicFixture {
  bytes: Uint8Array
  /** Display chromosomes — what the reader should expose, `All` removed. */
  chroms: HicWriteChrom[]
  /** Display index → file index, for building expectations. */
  fileIndexOf: number[]
}

export async function writeHic(options: HicWriteOptions): Promise<HicFixture> {
  const version = options.version
  const withAll = options.withAllChrom ?? true
  const blockBinCount = options.blockBinCount ?? 64
  const shortValues = options.shortValues ?? false
  const shortPositions = options.shortPositions ?? false

  const displayChroms = options.chroms
  const fileChroms: HicWriteChrom[] = withAll
    ? [{ name: 'All', length: displayChroms.reduce((sum, c) => sum + c.length, 0) }, ...displayChroms]
    : [...displayChroms]
  const shift = withAll ? 1 : 0
  const fileIndexOf = displayChroms.map((_, at) => at + shift)

  // ---- blocks, per pair per resolution -------------------------------------
  interface PendingBlock {
    number: number
    payload: Uint8Array
    position: number
  }
  interface PendingZoom {
    binSize: number
    blockBinCount: number
    blockColumnCount: number
    sumCounts: number
    blocks: PendingBlock[]
  }
  const pending = new Map<string, PendingZoom[]>()

  for (const [key, records] of Object.entries(options.records)) {
    const [a, b] = key.split('_').map((part) => Number.parseInt(part, 10))
    const intra = a === b
    const chromA = fileChroms[a]
    const chromB = fileChroms[b]
    const zooms: PendingZoom[] = []
    for (const binSize of options.resolutions) {
      const nBinsX = binsOf(chromA.length, binSize)
      const nBinsY = binsOf(chromB.length, binSize)
      const columns = blockColumnCountOf(version, intra, nBinsX, nBinsY, blockBinCount)
      const grouped = new Map<number, HicRecord[]>()
      let sum = 0
      for (const record of records) {
        // Intra records are stored upper-triangular, exactly as Juicer writes
        // them; a fixture that wrote both halves would let a reader that
        // mirrors twice pass.
        const x = intra ? Math.min(record.x, record.y) : record.x
        const y = intra ? Math.max(record.x, record.y) : record.y
        const number = blockNumberOf(version, intra, x, y, blockBinCount, columns)
        const held = grouped.get(number)
        if (held === undefined) grouped.set(number, [{ x, y, value: record.value }])
        else held.push({ x, y, value: record.value })
        sum += record.value
      }
      const blocks: PendingBlock[] = []
      for (const [number, group] of [...grouped.entries()].sort((p, q) => p[0] - q[0])) {
        const body =
          options.dense === true
            ? encodeDense(group, shortValues, version)
            : encodeRows(group, shortValues, shortPositions, version)
        blocks.push({ number, payload: await deflate(body), position: 0 })
      }
      zooms.push({ binSize, blockBinCount, blockColumnCount: columns, sumCounts: sum, blocks })
    }
    pending.set(key, zooms)
  }

  // ---- header --------------------------------------------------------------
  const w = new Writer()
  w.string('HIC')
  w.int32(version)
  const footerSlot = w.length
  w.int64(0)
  w.string(options.genomeId ?? 'testGenome')
  const normSlot = version >= 9 ? w.length : -1
  if (version >= 9) {
    w.int64(0)
    w.int64(0)
  }
  const attributes = options.attributes ?? { software: 'metacooler.js test fixture' }
  w.int32(Object.keys(attributes).length)
  for (const [key, value] of Object.entries(attributes)) {
    w.string(key)
    w.string(value)
  }
  w.int32(fileChroms.length)
  for (const chrom of fileChroms) {
    w.string(chrom.name)
    if (version >= 9) w.int64(chrom.length)
    else w.int32(chrom.length)
  }
  w.int32(options.resolutions.length)
  for (const binSize of options.resolutions) w.int32(binSize)
  w.int32(0) // no fragment resolutions

  // ---- block payloads ------------------------------------------------------
  for (const zooms of pending.values()) {
    for (const zoom of zooms) {
      for (const block of zoom.blocks) {
        block.position = w.length
        w.raw(block.payload)
      }
    }
  }

  // ---- matrix records ------------------------------------------------------
  const matrixPositions = new Map<string, { position: number; size: number }>()
  for (const [key, zooms] of pending.entries()) {
    const [a, b] = key.split('_').map((part) => Number.parseInt(part, 10))
    const position = w.length
    w.int32(a)
    w.int32(b)
    w.int32(zooms.length)
    zooms.forEach((zoom, index) => {
      w.string('BP')
      w.int32(index)
      w.float32(zoom.sumCounts)
      w.float32(0)
      w.float32(0)
      w.float32(0)
      w.int32(zoom.binSize)
      w.int32(zoom.blockBinCount)
      w.int32(zoom.blockColumnCount)
      w.int32(zoom.blocks.length)
      for (const block of zoom.blocks) {
        w.int32(block.number)
        w.int64(block.position)
        w.int32(block.payload.length)
      }
    })
    matrixPositions.set(key, { position, size: w.length - position })
  }

  // ---- normalisation vectors ----------------------------------------------
  const normPositions = new Map<string, { position: number; nBytes: number }>()
  for (const [key, vector] of Object.entries(options.norms ?? {})) {
    const position = w.length
    if (version >= 9) {
      w.int64(vector.length)
      for (const value of vector) w.float32(value)
    } else {
      w.int32(vector.length)
      for (const value of vector) w.float64(value)
    }
    normPositions.set(key, { position, nBytes: w.length - position })
  }

  // ---- footer --------------------------------------------------------------
  const footerPosition = w.length
  w.patchInt64(footerSlot, footerPosition)

  // The v5-compatible length is patched once its extent is known.
  const leadSlot = w.length
  if (version >= 9) w.int64(0)
  else w.int32(0)
  const bodyStart = w.length

  w.int32(matrixPositions.size)
  for (const [key, at] of matrixPositions.entries()) {
    w.string(key)
    w.int64(at.position)
    w.int32(at.size)
  }
  // The plain expected-value section, empty. Real files carry it populated; the
  // reader walks past it, and an empty one still exercises the walk.
  w.int32(0)
  // **The declared length stops here**, and that is the format rather than a
  // choice: the field is the size of the master index *plus the expected values*
  // and excludes everything after them, which is how a reader locates the
  // normalised-expected section — `footerPosition + <lead> + nBytes`. Counting
  // the later sections into it puts that pointer past them, and the
  // normalisation index is then read as whatever happens to be there.
  const bodyEnd = w.length
  if (version >= 9) w.patchInt64(leadSlot, bodyEnd - bodyStart)
  else w.patchInt32(leadSlot, bodyEnd - bodyStart)
  // The normalised-expected section, likewise empty, outside the declared length.
  w.int32(0)

  const normEntries = Object.entries(options.norms ?? {})
  // v9's header carries a pointer straight to *this* section, so a reader can
  // reach the normalisations without walking the expected-value blocks. Pointing
  // it at the footer as a whole — which is the obvious mistake, the footer being
  // where the section lives — makes a reader parse the master index as a
  // normalisation index, and the counts it finds there allocate gigabytes.
  const normIndexStart = w.length
  w.int32(normEntries.length)
  for (const [key] of normEntries) {
    const [type, chromIdx, binSize] = key.split('/')
    const at = normPositions.get(key)
    w.string(type)
    w.int32(Number.parseInt(chromIdx, 10))
    w.string('BP')
    w.int32(Number.parseInt(binSize, 10))
    w.int64(at?.position ?? 0)
    if (version >= 9) w.int64(at?.nBytes ?? 0)
    else w.int32(at?.nBytes ?? 0)
  }
  if (version >= 9 && normSlot >= 0) {
    w.patchInt64(normSlot, normIndexStart)
    w.patchInt64(normSlot + 8, w.length - normIndexStart)
  }

  return { bytes: w.bytes(), chroms: displayChroms, fileIndexOf }
}
