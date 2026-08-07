/**
 * SHA-256 and HMAC-SHA256, computed **synchronously**.
 *
 * The platform already has both, in `crypto.subtle`, and every one of its
 * methods returns a promise. That is normally a virtue and here it is
 * disqualifying: the remote reader's hot path is
 * `RemoteRangeSource.fetchRange`, which issues a *synchronous*
 * `XMLHttpRequest` because Emscripten's stream `read` op is synchronous and
 * returns a byte count rather than a promise. There is no `await` to be had
 * anywhere between HDF5 asking for bytes and the request going out, so a signer
 * built on `crypto.subtle` cannot sign that request. This can.
 *
 * The alternative was to presign every object URL up front, asynchronously, and
 * let the sync path use the presigned URL. That works — `Range` is not part of
 * a query-presigned signature — but it buys a second failure mode for free:
 * presigned URLs are scoped to one method, so the `HEAD` probe needs its own,
 * and they expire, so a tab left open over lunch comes back to 403s on a file
 * it had already opened. A hundred lines of hashing has no expiry.
 *
 * This is a plain FIPS 180-4 implementation with no cleverness in it, and it is
 * used only on the tiny inputs SigV4 hashes: a canonical request (a few hundred
 * bytes), a string to sign, four HMACs to derive the signing key. It is never
 * asked to hash a payload — see `sigv4.ts` on why the body hash is a constant
 * for every request this app makes.
 *
 * **Not a general-purpose crypto module.** It is constant-time about nothing and
 * must not be used to compare secrets or to verify a signature. Signing an
 * outbound request, where the attacker sees only the output, is the one job it
 * is fit for.
 */

/** FIPS 180-4 §4.2.2: the first 32 bits of the fractional parts of the cube
 * roots of the first sixty-four primes. */
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** The initial hash value: fractional parts of the square roots of the first
 * eight primes. */
// prettier-ignore
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

/** SHA-256's block size, which is also HMAC's — the two must agree. */
export const BLOCK_BYTES = 64

/** The digest size. */
export const DIGEST_BYTES = 32

/** Rotate right, on the 32-bit value `x`. */
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/**
 * The SHA-256 digest of `data`, as 32 bytes.
 *
 * The message schedule is allocated once per call rather than once per module:
 * a module-level scratch array would be faster and would be a landmine, since
 * `hmac` calls this twice and a future caller might reasonably interleave two
 * digests. At the sizes involved — a few hundred bytes, a few times per
 * request — the allocation does not register.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array(H0)
  const w = new Uint32Array(64)

  // FIPS 180-4 §5.1.1: append 0x80, then zeros, then the length in bits as a
  // 64-bit big-endian integer, padding to a multiple of the block size.
  const bitLength = data.length * 8
  const padded = new Uint8Array((Math.floor((data.length + 8) / BLOCK_BYTES) + 1) * BLOCK_BYTES)
  padded.set(data)
  padded[data.length] = 0x80
  // The high word of the length. `data.length` is a JS array length, so it is
  // below 2^53 bytes and the top eleven bits of the bit count are always zero —
  // but the split still has to happen, because a 512 MB input overflows 32 bits
  // and a truncated length is a wrong digest rather than an error.
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(padded.length - 4, bitLength >>> 0, false)

  for (let block = 0; block < padded.length; block += BLOCK_BYTES) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]
      const b = w[i - 2]
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  const out = new Uint8Array(DIGEST_BYTES)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false)
  return out
}

/**
 * HMAC-SHA256 of `data` under `key`, as 32 bytes (RFC 2104).
 *
 * A key longer than the block is hashed first, a shorter one is zero-padded —
 * both are the specification's own rules and both are reachable here, since
 * SigV4 derives its key by chaining four of these and the first key is
 * `"AWS4" + secret`.
 */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK_BYTES)
  block.set(key.length > BLOCK_BYTES ? sha256(key) : key)

  const inner = new Uint8Array(BLOCK_BYTES + data.length)
  const outer = new Uint8Array(BLOCK_BYTES + DIGEST_BYTES)
  for (let i = 0; i < BLOCK_BYTES; i++) {
    inner[i] = block[i] ^ 0x36
    outer[i] = block[i] ^ 0x5c
  }
  inner.set(data, BLOCK_BYTES)
  outer.set(sha256(inner), BLOCK_BYTES)
  return sha256(outer)
}

/** Lower-case hex, which is the only case AWS accepts in a signature. */
export function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * UTF-8 bytes of `text`.
 *
 * `TextEncoder` exists in every context this runs in — window, worker, and the
 * node runtime the tests use — and is the only part of this file that is not
 * hand-rolled, because it is synchronous and there was never a reason to.
 */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** The digest of the empty string, which is what SigV4 hashes for a body-less
 * request. Hard-coded so the common path does no hashing at all. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
