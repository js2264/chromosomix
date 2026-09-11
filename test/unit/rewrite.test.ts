/**
 * The rewrite table, and the two properties it is worthless without.
 *
 * A table is easy to test and easy to test badly: asserting each row against
 * itself proves the row was typed twice. So the cases below are written from the
 * *outside* — the link a reader actually copies out of Dropbox's share dialog,
 * out of Drive's, out of the GCS console, out of a data availability statement —
 * with the destination taken from `docs/remote-sources.md` §2, where each one was
 * measured against the live host.
 *
 * The two properties are what the callers depend on and what a row cannot state
 * for itself:
 *
 * - **Idempotence.** A URL is canonicalised when it is typed, again when the
 *   config naming it is resolved, and again when it arrives in somebody else's
 *   hash. A table whose output is not its own fixed point turns a working link
 *   into a broken one on the third hop, and nothing in between reports it.
 * - **Everything else is untouched.** `canonicalUrl` sits on the path of every
 *   URI in the application, including the ones that are bare filenames, so its
 *   commonest correct answer is its argument.
 *
 * The scopes are passed in rather than stored, which is what the second
 * parameter is for: this file runs under node, where there is no `localStorage`
 * to put one in, and the `s3://` rule is the only part of the table that depends
 * on anything but its input.
 */

import { describe, expect, it } from 'vitest'

import { canonicalUrl, isSignedUrl } from '@/sources/rewrite'
import type { BucketScope } from '@/s3/credentials'

function scope(base: string, id = 'b0'): BucketScope {
  return { id, label: base, base }
}

/** Every row of the table, as `[pasted, opened as]`. */
const TABLE: Array<[string, string]> = [
  // Dropbox: the host, and nothing else. Both share-link generations, because
  // the modern one carries `rlkey` in the query and losing it is a 404.
  [
    'https://www.dropbox.com/s/abc123/Hum53.metacool?dl=0',
    'https://dl.dropboxusercontent.com/s/abc123/Hum53.metacool?dl=0',
  ],
  [
    'https://www.dropbox.com/scl/fi/9xk2/rep1.mcool?rlkey=q7z1&st=abcd&dl=0',
    'https://dl.dropboxusercontent.com/scl/fi/9xk2/rep1.mcool?rlkey=q7z1&st=abcd&dl=0',
  ],

  // Drive, in all three shapes the share button and the old download links
  // produce. The query is dropped on purpose: `usp=sharing` means nothing to the
  // API, and `alt=media` is what makes it answer with the file.
  [
    'https://drive.google.com/file/d/1AbC_dEf-2Gh/view?usp=sharing',
    'https://www.googleapis.com/drive/v3/files/1AbC_dEf-2Gh?alt=media&supportsAllDrives=true',
  ],
  [
    'https://drive.google.com/open?id=1AbC_dEf-2Gh',
    'https://www.googleapis.com/drive/v3/files/1AbC_dEf-2Gh?alt=media&supportsAllDrives=true',
  ],
  [
    'https://drive.google.com/uc?export=download&id=1AbC_dEf-2Gh',
    'https://www.googleapis.com/drive/v3/files/1AbC_dEf-2Gh?alt=media&supportsAllDrives=true',
  ],

  // GCS: the JSON-API media endpoint, with the object as one percent-encoded
  // component — slashes included, which is what makes the object a path segment
  // rather than a path.
  [
    'gs://my-lab-data/hic/rep1.mcool',
    'https://storage.googleapis.com/storage/v1/b/my-lab-data/o/hic%2Frep1.mcool?alt=media',
  ],
  [
    'https://storage.cloud.google.com/my-lab-data/hic/rep1.mcool',
    'https://storage.googleapis.com/storage/v1/b/my-lab-data/o/hic%2Frep1.mcool?alt=media',
  ],
  [
    'gs://my-lab-data/Hi-C runs/rep 1.cool',
    'https://storage.googleapis.com/storage/v1/b/my-lab-data/o/Hi-C%20runs%2Frep%201.cool?alt=media',
  ],

  // `s3://` with no scope: AWS's virtual-hosted form, which is what the scheme
  // means in the CLI, in boto3 and in every data availability statement.
  [
    's3://4dn-open-data-public/fourfront-webprod/wfoutput/x/4DNFIM7ZVQOQ.hic',
    'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/x/4DNFIM7ZVQOQ.hic',
  ],
]

describe('canonicalUrl — the table', () => {
  for (const [pasted, opened] of TABLE) {
    it(`rewrites ${pasted}`, () => {
      expect(canonicalUrl(pasted, [])).toBe(opened)
    })
  }

  it('is idempotent on every row, which is what a third hop depends on', () => {
    for (const [pasted] of TABLE) {
      const once = canonicalUrl(pasted, [])
      expect(canonicalUrl(once, [])).toBe(once)
    }
  })
})

describe('canonicalUrl — what it leaves alone', () => {
  /**
   * The negative half of the table, and the more important one: a rewrite that
   * fires on a URL it does not understand produces an address that cannot be
   * debugged from the address bar, because the address bar no longer holds what
   * the reader typed.
   */
  const UNTOUCHED = [
    'https://bucket.example.org/Hum53.metacool',
    'http://localhost:5173/demo/yeast/scer.mcool',
    'https://4dn-open-data-public.s3.amazonaws.com/x/4DNFIM7ZVQOQ.hic',
    // The GCS XML host: a bucket scope's base, which the signer and the lister
    // both understand. Rewriting it would take a browsable prefix away.
    'https://storage.googleapis.com/broad-references/hg38/ref.fasta',
    // Already the destination. The same sentence as idempotence, from the front.
    'https://storage.googleapis.com/storage/v1/b/b/o/x.cool?alt=media',
    'https://dl.dropboxusercontent.com/s/abc/x.cool',
    'https://www.googleapis.com/drive/v3/files/1Ab?alt=media&supportsAllDrives=true',
    // A Google host with no file in it: nothing to rewrite to.
    'https://drive.google.com/drive/folders/1AbC',
    // Not URLs at all. These reach here through `inferSource`, which is asked
    // about every URI including a dropped file's bare name.
    'yeast.cool',
    '/home/js/yeast.cool',
    'file:///home/js/a.cool',
    '',
  ]

  for (const url of UNTOUCHED) {
    it(`leaves ${url === '' ? '(the empty string)' : url} exactly as it is`, () => {
      expect(canonicalUrl(url, [])).toBe(url)
    })
  }

  it('does not trim a URL it does not rewrite', () => {
    // "Anything else unchanged" is a rule about the string, not about a
    // normalised form of it: a caller trimming its own input must see the same
    // string back, or an equality test somewhere else fails for a reason that
    // has nothing to do with this table.
    expect(canonicalUrl('  yeast.cool  ', [])).toBe('  yeast.cool  ')
  })
})

describe('canonicalUrl — the parts of a URI that are not the address', () => {
  it('carries a ::group across a rewrite', () => {
    expect(canonicalUrl('gs://b/rep1.mcool::resolutions/1000', [])).toBe(
      'https://storage.googleapis.com/storage/v1/b/b/o/rep1.mcool?alt=media::resolutions/1000',
    )
  })

  it('carries a #bins= fragment across a rewrite', () => {
    // The escape hatch for a HiC-Pro pair published under unrelated keys (§3.9).
    // Dropping it would lose the half that carries every coordinate, and the
    // failure would be reported against the matrix.
    expect(
      canonicalUrl('https://www.dropbox.com/s/a/m.matrix?dl=0#bins=https://x/y_abs.bed', []),
    ).toBe('https://dl.dropboxusercontent.com/s/a/m.matrix?dl=0#bins=https://x/y_abs.bed')
  })

  it('leaves an #index= on a URL it does not rewrite', () => {
    const uri = 'https://host/reads.bam#index=https://host/reads.bam.bai'
    expect(canonicalUrl(uri, [])).toBe(uri)
  })
})

describe('canonicalUrl — s3:// against the stored scopes', () => {
  it('uses a virtual-hosted scope’s own endpoint, region and all', () => {
    // The reason the scope is consulted at all: `s3://` says nothing about which
    // region — or which *service* — the bucket is on, and the scope is this
    // browser's only statement of it.
    const scopes = [scope('https://lab-data.s3.eu-west-3.amazonaws.com/collections/')]
    expect(canonicalUrl('s3://lab-data/collections/rep1.cool', scopes)).toBe(
      'https://lab-data.s3.eu-west-3.amazonaws.com/collections/rep1.cool',
    )
  })

  it('uses a path-style scope’s endpoint, which is what MinIO and R2 hand out', () => {
    const scopes = [scope('https://minio.lab.example.org/lab-data/collections/')]
    expect(canonicalUrl('s3://lab-data/collections/rep1.cool', scopes)).toBe(
      'https://minio.lab.example.org/lab-data/collections/rep1.cool',
    )
  })

  it('ignores a scope over a different bucket', () => {
    const scopes = [scope('https://other.s3.eu-west-3.amazonaws.com/x/')]
    expect(canonicalUrl('s3://lab-data/collections/rep1.cool', scopes)).toBe(
      'https://lab-data.s3.amazonaws.com/collections/rep1.cool',
    )
  })

  it('escapes each key segment and keeps the separators', () => {
    expect(canonicalUrl('s3://lab-data/Hi-C runs/rep 1.cool', [])).toBe(
      'https://lab-data.s3.amazonaws.com/Hi-C%20runs/rep%201.cool',
    )
  })

  it('reads the stored scopes when none are passed, and survives having none', () => {
    // Under node there is no `localStorage`, so the default lookup throws and is
    // caught. That is the same answer a fresh browser gives, and it is the one
    // this has to give rather than propagating a `ReferenceError` up through
    // `inferSource` into the boot path.
    expect(canonicalUrl('s3://lab-data/rep1.cool')).toBe(
      'https://lab-data.s3.amazonaws.com/rep1.cool',
    )
  })
})

describe('isSignedUrl', () => {
  it('recognises a presigned S3 URL', () => {
    expect(
      isSignedUrl(
        'https://b.s3.amazonaws.com/x.cool?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600' +
          '&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host',
      ),
    ).toBe(true)
  })

  it('recognises a signed GCS URL', () => {
    expect(isSignedUrl('https://storage.googleapis.com/b/x.cool?X-Goog-Signature=abc')).toBe(true)
  })

  it('recognises an Azure SAS by both of its halves, and not by one', () => {
    const sas = 'https://acct.blob.core.windows.net/c/x.cool?sv=2022-11-02&sig=abc%3D'
    expect(isSignedUrl(sas)).toBe(true)
    // `sig` alone is a parameter name common enough to mean something else
    // entirely; `sv` is what makes it a storage SAS.
    expect(isSignedUrl('https://host/x.cool?sig=abc')).toBe(false)
    expect(isSignedUrl('https://host/x.cool?sv=2022-11-02')).toBe(false)
  })

  it('is case-insensitive about the parameter name', () => {
    expect(isSignedUrl('https://b.s3.amazonaws.com/x?x-amz-signature=abc')).toBe(true)
  })

  it('answers false for a plain URL, a name and a fragment that looks like a query', () => {
    expect(isSignedUrl('https://bucket.example.org/Hum53.metacool')).toBe(false)
    expect(isSignedUrl('yeast.cool')).toBe(false)
    expect(isSignedUrl('https://host/x.cool#index=https://host/y?sig=a&sv=b')).toBe(false)
  })
})
