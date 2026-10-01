/**
 * Write the base-modification demo: a small, simulated long-read BAM with
 * `MM`/`ML` tags over yeast chromosome IV, and its `.bai` (§8.13).
 *
 *   node scripts/make-basemods-demo.mjs
 *
 * → demo/yeast/Yeast_ONT_basemods.sim.bam and .bam.bai
 *
 * **Simulated, and named so.** Budding yeast has essentially no DNA
 * methylation; these reads are drawn from the demo FASTA's own chromosome IV
 * (`S288c_syn40-XIII.fa`) so they line up with its sequence lane, and the
 * modification calls are made up to look like a nanopore run's: 5mC and 5hmC
 * at every CpG (`C+m?` and `C+h?`, both strands — a reverse read's calls fall
 * on the CpG's G, since its sequence as read is the other strand), methylated
 * at about 85% except across two promoter-sized islands that are nearly bare,
 * and 6mA at the adenine of every `GATC` (`A+a.`, so every other A is an
 * explicit "unmodified"). Probabilities are spread the way a real caller's
 * are — most calls sure, a tenth of them coin-flips.
 *
 * The reads carry about two percent substitutions, short insertions and
 * deletions, and the odd soft clip, so the CIGAR walk that places calls is
 * exercised by the demo as well as by the tests. Deterministic: the same seed
 * writes the same bytes.
 */

import { deflateRawSync, crc32 } from 'node:zlib'
import { readFileSync, writeFileSync, statSync } from 'node:fs'

const FASTA = 'demo/yeast/S288c_syn40-XIII.fa'
const OUT = 'demo/yeast/Yeast_ONT_basemods.sim.bam'
const CONTIG = 'IV'
// 0-based, half-open: IV:1,266,001-1,274,000 — NCB2, UTP5, HPT1, URH1, DIT1/2.
const FROM = 1_266_000
const TO = 1_274_000
const DEPTH = 18
/** Nearly unmethylated stretches: UTP5's and HPT1's promoters. */
const ISLANDS = [
  [1_266_900, 1_267_520],
  [1_269_620, 1_270_120],
]

// ---------------------------------------------------------------------------
// A seeded generator
// ---------------------------------------------------------------------------

let seed = 0x5eed1234
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => a + Math.floor(random() * (b - a + 1))
const pick = (text) => text[Math.floor(random() * text.length)]

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

const refs = []
let reference = ''
{
  const text = readFileSync(FASTA, 'utf8')
  let name = null
  let parts = []
  const close = () => {
    if (name === null) return
    const seq = parts.join('')
    refs.push({ name, length: seq.length })
    if (name === CONTIG) reference = seq.toUpperCase()
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      close()
      name = line.slice(1).trim().split(/\s/)[0]
      parts = []
    } else parts.push(line.trim())
  }
  close()
}
if (reference === '') throw new Error(`no ${CONTIG} in ${FASTA}`)
const refId = refs.findIndex((ref) => ref.name === CONTIG)

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const COMPLEMENT = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }
const revcomp = (seq) => [...seq].reverse().map((base) => COMPLEMENT[base] ?? 'N').join('')

/** How methylated a CpG at this position is, as a fraction of molecules. */
function cpgLevel(pos) {
  for (const [a, b] of ISLANDS) {
    if (pos >= a && pos < b) return 0.06
    // A shore a couple of hundred bases wide either side, rising to the body.
    const near = pos < a ? a - pos : pos - b
    if (near < 250) return 0.06 + (0.8 * near) / 250
  }
  return 0.86
}

/** A caller's probability for a base whose truth is `modified`. */
function callProbability(modified) {
  if (random() < 0.1) return 0.3 + random() * 0.4
  const sure = 0.78 + random() * 0.22
  return modified ? sure : 1 - sure
}
const byteOf = (p) => Math.max(0, Math.min(255, Math.floor(p * 256)))

/**
 * One simulated read: its alignment, its sequence as stored, and its tags.
 * Modification truth is decided per reference site and read, so the tags of a
 * forward and a reverse read over one CpG describe one molecule each.
 */
function simulate(index) {
  const length = between(700, 2400)
  const start = between(FROM - length + 200, TO - 200)
  const reverse = random() < 0.5
  const ops = []
  let seq = ''
  // Which base of the read (stored orientation) each reference base became.
  const truth = new Map()
  const clipStart = random() < 0.25 ? between(5, 40) : 0
  const clipEnd = random() < 0.25 ? between(5, 40) : 0
  if (clipStart > 0) {
    ops.push([clipStart, 'S'])
    for (let i = 0; i < clipStart; i++) seq += pick('ACGT')
  }
  let ref = Math.max(0, start)
  const end = Math.min(reference.length, start + length)
  let run = 0
  const flush = () => {
    if (run > 0) ops.push([run, 'M'])
    run = 0
  }
  while (ref < end) {
    const roll = random()
    if (roll < 0.006 && run > 10) {
      flush()
      const del = between(1, 3)
      ops.push([del, 'D'])
      ref += del
      continue
    }
    if (roll < 0.011 && run > 10) {
      flush()
      const ins = between(1, 2)
      ops.push([ins, 'I'])
      for (let i = 0; i < ins; i++) seq += pick('ACGT')
      continue
    }
    const base = reference[ref]
    truth.set(ref, seq.length)
    seq += roll < 0.025 ? pick('ACGT'.replace(base, '')) : base
    run++
    ref++
  }
  flush()
  if (clipEnd > 0) {
    ops.push([clipEnd, 'S'])
    for (let i = 0; i < clipEnd; i++) seq += pick('ACGT')
  }
  const refEnd = ref

  // The read as sequenced, which is what MM counts on.
  const asRead = reverse ? revcomp(seq) : seq
  const storedOf = (i) => (reverse ? seq.length - 1 - i : i)
  // Reference position of each stored base, for deciding the truth there.
  const refOfStored = new Map()
  for (const [pos, at] of truth) refOfStored.set(at, pos)

  /** Is the base at as-read index `i` the C of a CpG (on the read's own strand)? */
  const cpgAt = (i) => asRead[i] === 'C' && asRead[i + 1] === 'G'
  const gatcAt = (i) => asRead[i] === 'A' && asRead[i - 1] === 'G' && asRead[i + 1] === 'T' && asRead[i + 2] === 'C'

  const mSkips = []
  const mBytes = []
  const hBytes = []
  let skipped = 0
  for (let i = 0; i < asRead.length; i++) {
    if (asRead[i] !== 'C') continue
    if (!cpgAt(i)) {
      skipped++
      continue
    }
    const pos = refOfStored.get(storedOf(i))
    // A CpG the read has but the reference does not (an error made it) is
    // called like any other — a caller sees the read, not the reference.
    const level = pos === undefined ? 0.5 : cpgLevel(pos)
    const methylated = random() < level
    const hydroxy = !methylated && random() < 0.08
    mSkips.push(skipped)
    skipped = 0
    const pm = callProbability(methylated)
    const ph = hydroxy ? 0.75 + random() * 0.2 : Math.min(1 - pm, random() * 0.08)
    mBytes.push(byteOf(pm))
    hBytes.push(byteOf(ph))
  }
  const aSkips = []
  const aBytes = []
  skipped = 0
  for (let i = 0; i < asRead.length; i++) {
    if (asRead[i] !== 'A') continue
    if (!gatcAt(i)) {
      skipped++
      continue
    }
    aSkips.push(skipped)
    skipped = 0
    aBytes.push(byteOf(callProbability(random() < 0.8)))
  }
  const list = (skips) => (skips.length === 0 ? '' : `,${skips.join(',')}`)
  // `C+m?` and `C+h?` as two groups over the same cytosines, and the ML bytes
  // group by group: modkit's own spelling of a 5mC/5hmC model's output.
  const mm = `C+m?${list(mSkips)};C+h?${list(mSkips)};A+a.${list(aSkips)};`
  const ml = [...mBytes, ...hBytes, ...aBytes]
  return {
    name: `sim_ont_${String(index).padStart(4, '0')}`,
    pos: Math.max(0, start),
    end: refEnd,
    flag: reverse ? 0x10 : 0,
    ops,
    seq,
    mm,
    ml,
  }
}

const reads = []
const total = Math.round(((TO - FROM) * DEPTH) / 1550)
for (let i = 0; i < total; i++) reads.push(simulate(i + 1))
reads.sort((a, b) => a.pos - b.pos || a.end - b.end)

// ---------------------------------------------------------------------------
// BAM bytes
// ---------------------------------------------------------------------------

const OP = { M: 0, I: 1, D: 2, N: 3, S: 4, H: 5, P: 6, '=': 7, X: 8 }
const SEQ = '=ACMGRSVTWYHKDBN'

function reg2bin(beg, end) {
  end -= 1
  if (beg >> 14 === end >> 14) return ((1 << 15) - 1) / 7 + (beg >> 14)
  if (beg >> 17 === end >> 17) return ((1 << 12) - 1) / 7 + (beg >> 17)
  if (beg >> 20 === end >> 20) return ((1 << 9) - 1) / 7 + (beg >> 20)
  if (beg >> 23 === end >> 23) return ((1 << 6) - 1) / 7 + (beg >> 23)
  if (beg >> 26 === end >> 26) return ((1 << 3) - 1) / 7 + (beg >> 26)
  return 0
}

function tag(name, type, payload) {
  return Buffer.concat([Buffer.from(name + type, 'latin1'), payload])
}

function record(read) {
  const name = Buffer.from(read.name + '\0', 'latin1')
  const cigar = Buffer.alloc(read.ops.length * 4)
  read.ops.forEach(([length, op], i) => cigar.writeUInt32LE((length << 4) | OP[op], i * 4))
  const packed = Buffer.alloc((read.seq.length + 1) >> 1)
  for (let i = 0; i < read.seq.length; i++) {
    const code = SEQ.indexOf(read.seq[i])
    packed[i >> 1] |= i % 2 === 0 ? code << 4 : code
  }
  const qual = Buffer.alloc(read.seq.length, 0xff)
  const ml = Buffer.alloc(5 + read.ml.length)
  ml.write('C', 0, 'latin1')
  ml.writeInt32LE(read.ml.length, 1)
  Buffer.from(read.ml).copy(ml, 5)
  const mn = Buffer.alloc(4)
  mn.writeInt32LE(read.seq.length, 0)
  const tags = Buffer.concat([
    tag('MM', 'Z', Buffer.from(read.mm + '\0', 'latin1')),
    tag('ML', 'B', ml),
    tag('MN', 'i', mn),
  ])
  const fixed = Buffer.alloc(36)
  const size = 32 + name.length + cigar.length + packed.length + qual.length + tags.length
  fixed.writeInt32LE(size, 0)
  fixed.writeInt32LE(refId, 4)
  fixed.writeInt32LE(read.pos, 8)
  fixed.writeUInt8(name.length, 12)
  fixed.writeUInt8(60, 13)
  fixed.writeUInt16LE(reg2bin(read.pos, Math.max(read.pos + 1, read.end)), 14)
  fixed.writeUInt16LE(read.ops.length, 16)
  fixed.writeUInt16LE(read.flag, 18)
  fixed.writeInt32LE(read.seq.length, 20)
  fixed.writeInt32LE(-1, 24)
  fixed.writeInt32LE(-1, 28)
  fixed.writeInt32LE(0, 32)
  return Buffer.concat([fixed, name, cigar, packed, qual, tags])
}

function bgzf(payload) {
  const deflated = deflateRawSync(payload, { level: 9 })
  const head = Buffer.from([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0, 0, 0])
  head.writeUInt16LE(18 + deflated.length + 8 - 1, 16)
  const tail = Buffer.alloc(8)
  tail.writeUInt32LE(crc32(payload), 0)
  tail.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, deflated, tail])
}

const headerText =
  '@HD\tVN:1.6\tSO:coordinate\n' +
  refs.map((ref) => `@SQ\tSN:${ref.name}\tLN:${ref.length}\n`).join('') +
  '@RG\tID:sim\tSM:yeast_sim\tPL:ONT\n' +
  '@PG\tID:make-basemods-demo\tPN:metacooler\tCL:node scripts/make-basemods-demo.mjs\n' +
  '@CO\tSIMULATED reads and modification calls over S288c chrIV, for the base-modification demo only.\n'
const head = [Buffer.from('BAM\x01', 'latin1')]
{
  const length = Buffer.alloc(4)
  length.writeInt32LE(Buffer.byteLength(headerText, 'latin1'), 0)
  head.push(length, Buffer.from(headerText, 'latin1'))
  const count = Buffer.alloc(4)
  count.writeInt32LE(refs.length, 0)
  head.push(count)
  for (const ref of refs) {
    const name = Buffer.from(ref.name + '\0', 'latin1')
    const size = Buffer.alloc(4)
    size.writeInt32LE(name.length, 0)
    const len = Buffer.alloc(4)
    len.writeInt32LE(ref.length, 0)
    head.push(size, name, len)
  }
}

const blocks = [bgzf(Buffer.concat(head))]
let compressed = blocks[0].length
/** Each record's virtual offset, and the one just past it. */
const offsets = []
let pending = []
let pendingBytes = 0
const BLOCK = 60_000
const flushBlock = () => {
  if (pending.length === 0) return
  const block = bgzf(Buffer.concat(pending.map((one) => one.bytes)))
  let within = 0
  for (const one of pending) {
    offsets[one.index] = { from: (BigInt(compressed) << 16n) | BigInt(within) }
    within += one.bytes.length
  }
  blocks.push(block)
  compressed += block.length
  pending = []
  pendingBytes = 0
}
reads.forEach((read, index) => {
  const bytes = record(read)
  if (pendingBytes + bytes.length > BLOCK) flushBlock()
  pending.push({ index, bytes })
  pendingBytes += bytes.length
})
flushBlock()
const endOffset = BigInt(compressed) << 16n
reads.forEach((_, index) => {
  offsets[index].to = index + 1 < reads.length ? offsets[index + 1].from : endOffset
})
const EOF = Buffer.from('1f8b08040000000000ff0600424302001b0003000000000000000000', 'hex')
writeFileSync(OUT, Buffer.concat([...blocks, EOF]))

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

const bins = new Map()
const linear = []
reads.forEach((read, index) => {
  const bin = reg2bin(read.pos, Math.max(read.pos + 1, read.end))
  const chunks = bins.get(bin) ?? []
  const last = chunks[chunks.length - 1]
  if (last !== undefined && last[1] === offsets[index].from) last[1] = offsets[index].to
  else chunks.push([offsets[index].from, offsets[index].to])
  bins.set(bin, chunks)
  for (let w = read.pos >> 14; w <= (Math.max(read.pos + 1, read.end) - 1) >> 14; w++) {
    if (linear[w] === undefined || offsets[index].from < linear[w]) linear[w] = offsets[index].from
  }
})
for (let w = 0; w < linear.length; w++) if (linear[w] === undefined) linear[w] = 0n
const parts = [Buffer.from('BAI\x01', 'latin1')]
const int32 = (value) => {
  const buf = Buffer.alloc(4)
  buf.writeInt32LE(value, 0)
  return buf
}
const uint64 = (value) => {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(value, 0)
  return buf
}
parts.push(int32(refs.length))
for (let id = 0; id < refs.length; id++) {
  if (id !== refId) {
    parts.push(int32(0), int32(0))
    continue
  }
  parts.push(int32(bins.size))
  for (const [bin, chunks] of bins) {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(bin, 0)
    head.writeInt32LE(chunks.length, 4)
    parts.push(head)
    for (const [from, to] of chunks) parts.push(uint64(from), uint64(to))
  }
  parts.push(int32(linear.length))
  for (const offset of linear) parts.push(uint64(offset))
}
writeFileSync(`${OUT}.bai`, Buffer.concat(parts))

const calls = reads.reduce((sum, read) => sum + read.ml.length, 0)
console.log(
  `${OUT}: ${reads.length} reads, ${calls} calls, ${statSync(OUT).size} bytes; ` +
    `index ${statSync(`${OUT}.bai`).size} bytes`,
)
