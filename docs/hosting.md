# Hosting `.metacool` files for the viewer

Implements SPECS.md §11. Everything here is object-storage configuration — there is no server-side
component to deploy, and adding one would violate constraint C1. Publishing the *app* is a separate
and much shorter story: [deploy.md](deploy.md).

## The short version

A published `.metacool` is a plain object on an S3-compatible bucket that satisfies five
requirements. Miss any one and the viewer fails in a way the error messages of §10 are written to
distinguish.

| Requirement | Why |
|---|---|
| `Accept-Ranges: bytes` | The whole design is bounded range reads. Without it the browser downloads the entire file to read a 4 kB table. |
| **No `Content-Encoding`** | See [below](#transfer-compression-breaks-ranges). This is the one that fails silently and the one no client can work around. |
| CORS allowing `GET` and `HEAD` and the `Range` **request** header, and exposing `Content-Length` and `Content-Range` | The app runs on a different origin from the data. Exposing the two response headers is the part most often forgotten: without them the reader cannot learn the file size or verify what it got back. |
| `Content-Type: application/octet-stream` | Keeps a CDN from sniffing and transforming the body. Note that it does **not** keep every CDN from compressing it — GitHub Pages compresses exactly this type. |
| Long TTL on immutable, versioned object names | Range reads are repetitive; caching is what keeps the §12 budgets achievable on a cold connection. |

**Cloudflare R2 is the recommended host**, because egress is free and the Hi-C use case is
read-heavy with large objects. Any S3-compatible store that meets the four requirements works.

## Presigned links open, and they expire

The viewer probes a URL with a `HEAD` before its first `GET`, to find out whether the host serves
ranges. A presigned S3 URL is signed for a **single method**, so that `HEAD` used to come back 403
and the open failed before it started — a failure that looked like a CORS problem and was not one.

It no longer happens. The probe recognises a signature in the query — `X-Amz-Signature` for S3,
`X-Goog-Signature` for Google Cloud Storage, `sig=` beside `sv=` for an Azure SAS — and goes
straight to the one-byte `Range: bytes=0-0` request it already had for hosts that say nothing about
range support. A presigned link therefore opens, reads, and keeps reading until its signature
expires, at which point the bucket answers 403 and the viewer says so.

Two things follow, and both are about **what to publish**:

- **A link with an expiry is a link with an expiry.** Put one in a paper, a README or a workspace
  file and it stops working on a date nobody wrote down. Presigned URLs are for handing a colleague
  a file this afternoon; a public object, or a bucket entry holding a read-only key, is what a
  citation points at.
- **The signature is in the URL**, so anyone the link reaches can read the object until it expires,
  and it will be in the address bar, the session hash and any share link written from it. That is a
  property of presigning rather than of this viewer, and it is the reason a private bucket is better
  served by a bucket entry: the key stays in the reader's browser and the URL stays public-looking.

An Azure SAS is not scoped to one method and always worked; it is named here so the rule reads as
one rule.

## GEO and SRA cannot be hosts

Their download endpoints serve attachments without range support and without CORS. Files deposited
there are **inputs to publication, never live sources** for the viewer. Publish the same file to a
bucket and reference both: the archive for permanence, the bucket for browsing.

## CORS configuration

For an S3-compatible bucket:

```json
[
  {
    "AllowedOrigins": ["https://<your-github-pages-host>"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 86400
  }
]
```

Widen `AllowedOrigins` to `["*"]` only for genuinely public data; it is a reasonable choice for
released datasets and a poor one for anything under review.

## Transfer compression breaks ranges

A host that sets `Content-Encoding` on the response makes byte ranges meaningless, because `Range`
addresses the octets of the **encoded** representation. Concretely, measured against GitHub Pages
serving a 14,497,503-byte `.metacool`:

```
$ curl -sSI -H 'Accept-Encoding: gzip' "$URL"
content-type: application/octet-stream
content-encoding: gzip
accept-ranges: bytes
content-length: 11066465          # the compressed size, 3.4 MB short of the file
```

Two things follow, and the second is the dangerous one:

- The size the reader learns is the compressed size, so the mounted file claims a length HDF5 reads
  past.
- `bytes=0-2047` returns 2048 *compressed* octets, which the browser inflates to 6,990 bytes of a
  **correct prefix** of the file — so the superblock parses and the open looks like it worked. Any
  later range is a slice out of the middle of a gzip stream and inflates to nothing coherent. The
  symptom is `error - name not defined!` raised from inside the wasm, hundreds of frames from the
  cause.

**No client can work around this.** `Accept-Encoding` is a forbidden header name in the Fetch
standard, so neither `fetch` nor `XMLHttpRequest` may ask for an identity encoding; the browser
always offers gzip. It has to be fixed on the host.

S3, R2 and GCS do not compress `application/octet-stream`. GitHub Pages does, on a rule keyed to
content type — it serves `image/png` uncompressed and `application/octet-stream` gzipped — and
exposes no way to change response headers. **Pages cannot host data for this viewer**, only the app.

The viewer refuses the case rather than reading corrupt bytes: `RemoteRangeSource.open` checks
`Content-Encoding` on the probe, and `windowOf` checks every response body against the span its own
`Content-Range` claims, for browsers that do not expose the header to JS. The worker then falls back
to a single whole-object `GET` — a complete encoded stream *does* inflate correctly — at the cost of
the bounded-read property.

That fallback is what kept the demo files working while they were published on Pages beside the app,
and the reason they are not any more: they are on S3 now
(`scripts/publish-demo.sh`, [deploy.md](deploy.md#the-demo-files)), where
`application/octet-stream` is served uncompressed and the landing page exercises the ranged path
rather than the escape hatch. Keep the fallback — a reader will point the viewer at a host that
compresses — but do not design around it.

## Verifying a bucket before you trust it

Three `curl` calls answer every question. Run them against the real published URL, not a redirect:

```bash
URL=https://<bucket-host>/<path>/Hum53.metacool

# 1. Range support and content type.
curl -sSI "$URL" | grep -iE 'accept-ranges|content-length|content-type'

# 2. An actual range read, and the CORS headers a browser would see.
curl -sSI -H 'Range: bytes=0-1023' -H 'Origin: https://example.org' "$URL" \
  | grep -iE 'http/|content-range|access-control-'

# 3. What a browser gets, which always offers gzip. There must be no
#    content-encoding, and content-length must equal the real file size.
curl -sSI -H 'Accept-Encoding: gzip, deflate, br' "$URL" \
  | grep -iE 'content-encoding|content-length'
```

The second call must return `206 Partial Content`, a `Content-Range`, and
`access-control-expose-headers` naming `Content-Range`. A `200` instead of a `206` means ranges are
being ignored — the viewer refuses this case explicitly rather than silently downloading gigabytes.
The third must print no `content-encoding` at all; omitting the `Accept-Encoding` header is what
makes this check pass against a host that would have failed a browser.

## The catalog

A catalog JSON lists available files with enough metadata to browse the collection **without opening
any of them** — URI, `ngenomes`, `ncontigs`, `nnz`, `sum`, bin size, ordering, assembly, a taxonomy
summary, byte size and schema version. `scripts/make_catalog.py` generates it from existing
metacooler CLI output; it lives in this repo, not in metacooler, because nothing about publishing
belongs in the format library (M8, ground rule 1).

For each published file the catalog should also reference a genome-level edge list produced by:

```bash
metacooler network --level genome --header <file>.metacool -o <file>.genome-network.tsv
```

For a few hundred MAGs that is a few kB of text. It is what makes the genome × genome overview
(§7.3) instant on a remote file: one `fetch`, no HDF5, no range requests. Prefer it over
`aggregate --level genome`, which produces a whole `.cool` for the same information.

Both the catalog and the edge list are **opportunistic**. A plain `.metacool` with neither must
behave identically, minus the overview — the app never requires a companion file (C3).

## Private files

Two ways, and they are for different situations.

### Drag-and-drop

Local drag-and-drop, same code path, different byte source. Nothing is uploaded, so there are no
accounts, no storage cost and no GDPR review. The UI says so on screen, and the claim is testable:
a dropped file must render without a single network request leaving the browser.

### Making a public bucket browsable

A public prefix can be **connected as a folder** with nothing but its URL — no key, no region, no
account. **Connect → a bucket → public**, or the same form under *Buckets*. Everything under it is
then listed and read unsigned, which is what public data always took, and it shows up in the Files
panel as a tree beside any local folder you have connected.

One grant decides whether that works, and it is not the one that makes the files downloadable:

| What you want | Grant | Usually present on a published bucket |
|---|---|---|
| Open a file whose URL you have | `s3:GetObject` on the objects | yes |
| **Browse the prefix it lives in** | `s3:ListBucket` **on the bucket** | **no** |

So a bucket that serves every demo perfectly can still refuse to be listed, and that is an ordinary
configuration rather than a fault. There is nothing the viewer can do about it — it has no backend
to list on its behalf (SPECS C1) — so it says which of the two grants is missing and reminds you
that files under the prefix still open by URL.

To grant it, add the second statement to the **bucket policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicRead",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::rsglab-data/demo/*"
    },
    {
      "Sid": "PublicBrowse",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::rsglab-data",
      "Condition": { "StringLike": { "s3:prefix": ["demo/*"] } }
    }
  ]
}
```

The `s3:prefix` condition is what keeps this from publishing the names of everything else in the
bucket: without it, anyone could list the private prefixes' *keys* — not read them, but knowing that
`collections/hum53/2026-03-run2/` exists is often the sensitive half.

**No CORS change is needed for this.** An unsigned listing is a `GET` with no custom headers, which
is a *simple* request in the CORS sense and is therefore never preflighted — the public policy below
(`GET`, `HEAD`, `Range`) already answers it. That is the whole difference from the signed case in
the next section, which is preflighted and does need its headers named.

### A private bucket prefix

For data that lives on a bucket and should not be public — a lab's own collections, a dataset under
review — the viewer signs its requests with AWS Signature Version 4. **Open a file → private
buckets…** takes a URL prefix, a region and an access key, and everything under that prefix is then
read signed. Everything else, the public demos included, stays unsigned.

The scope is a **prefix, not a bucket**. `…/collections/` and not `…/rsglab-data/`, so a bucket whose
`demo/` prefix is public and whose `collections/` prefix is not works as one bucket: signing the
public half would add a preflight to every read for nothing, and would fail outright against a key
scoped as below.

**The key needs exactly two permissions.** Reading is `s3:GetObject` on the objects; *browsing* is
`s3:ListBucket` on the bucket, which is a different permission — a key with only the first works
fine for pasted URLs and cannot list, and the app says so rather than reporting a broken bucket.

**Browsing is offered wherever a URL is.** Every box in the application that takes a file URL — the
picker's *open a remote file*, the Tracks card, the Contact maps card, the deck's add row — carries
a `browse…` button beside its *add*, and all four open the same folder view. That is what the
`s3:ListBucket` half of the policy buys: the bigWigs beside a map are keys whose names came off a
run sheet, and nobody is holding their URLs. A file chosen from a listing is opened with the key
that listed it, rather than by a second lookup that could in principle resolve elsewhere. The filter
above a listing narrows **the level on screen** — S3 matches a key prefix and never a substring, so
there is no bucket-wide search to offer, and the line under the list says how many of how many are
showing rather than letting "not in this folder" read as "not in the bucket".

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::rsglab-data/collections/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::rsglab-data",
      "Condition": { "StringLike": { "s3:prefix": ["collections/*"] } }
    }
  ]
}
```

**CORS is not the public policy.** A signed request carries an `Authorization` header, which is not
safelisted, so the browser preflights it — and the public policy above names `Range` in
`AllowedHeaders` and stops there, so the preflight is refused with a 403 the browser reports to the
page as nothing more than `Failed to fetch`. The headers a signed request needs have to be named:

`AllowedOrigins` is *not* what fails here, and it is worth being exact about why, because widening
it is the first thing anyone tries. A "credentialed request" in the CORS sense is one carrying
cookies or TLS client certificates — `fetch` with `credentials: 'include'`. This app never sets
that; `Authorization` is a plain request header it computes and sets itself. So `["*"]` answers a
signed preflight perfectly well, and naming the app instead buys defence in depth rather than
access control: what actually bounds the key is the IAM policy above, since the key lives in the
browser on the app's own origin and no bucket setting can change that.

Note also that **an S3 CORS policy is bucket-wide.** The rules carry no prefix condition, and
`put-bucket-cors` replaces the whole document rather than adding to it. One policy therefore has to
cover the public prefix and the private one at once — which is why the policy below has two rules,
why `scripts/publish-demo.sh` writes both of them, and why applying a public-data policy on its own
silently switches private browsing off on a bucket where it was working:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 86400
  },
  {
    "AllowedOrigins": ["https://js2264.github.io", "https://jserizay.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": [
      "Range", "If-Match", "If-None-Match",
      "Authorization", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"
    ],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 86400
  }
]
```

S3 answers a preflight from the **first rule that matches** origin, method and every requested
header together, so the order matters and the second rule is not redundant: a signed preflight names
headers the first rule does not have, falls through it, and is answered by the second. An unsigned
range read from anywhere still matches the first. Add the origin the app is served from — including
`http://localhost:5173` while developing — to the second rule's `AllowedOrigins`, or set it to
`["*"]` as well, per the paragraph above.

`MaxAgeSeconds` is doing real work here: without it the browser preflights *every* range request
rather than once per prefix, which doubles the request count on the one path the §12 budgets are
about.

**The key is in the browser, and there is no arrangement in which it is not.** The app has no
backend by construction (C1), so whatever signs a request holds the key that signs it — the same
property that makes a dropped file never leave the machine. It is kept in `localStorage`, readable
by any script on the origin. What bounds that is the key's own permissions, which is why the policy
above grants two actions on one prefix and why the dialog says never to paste an administrator key.
Use a dedicated IAM user; if the lab uses SSO, the dialog takes a session token too and the
credential simply expires.

**Implementation.** `src/s3/sigv4.ts`, with its own SHA-256 in `src/s3/sha256.ts` rather than
`crypto.subtle`. That is not a preference: the reader's hot path is a *synchronous*
`XMLHttpRequest` — Emscripten's stream `read` op is synchronous — so there is no `await` between
HDF5 asking for bytes and the request going out, and every `crypto.subtle` method returns a promise.
Presigned URLs were the alternative and are worse here: they are scoped to one method, so the `HEAD`
probe needs its own, and they expire while a tab is open.

## What already works, host by host

"Supports S3" undersells it: what the reader supports is *object storage*, and the only two things
that ever break are CORS and transfer compression. Measured on 2026-09-11 (`docs/remote-sources.md`
§2 has the headers):

| Host | Opens as pasted? | What the owner has to set |
|---|---|---|
| Amazon S3, virtual-hosted or path-style | yes | the CORS policy above |
| Cloudflare R2, MinIO, Ceph RGW, Wasabi, Backblaze B2 | yes | a CORS policy — same rule, their own dialect |
| 4DN open data (`4dn-open-data-public`) | yes, today | nothing; the bucket already answers `*` and allows `Range` |
| ENCODE (`encode-public`) | yes, today | nothing; use the file's `cloud_metadata.url`, not `@@download` |
| Google Cloud Storage, `gs://…` or `storage.googleapis.com/storage/v1/b/…/o/…?alt=media` | yes, for a public object | nothing — the JSON-API endpoint answers CORS for any origin |
| Google Cloud Storage, `storage.googleapis.com/<bucket>/<object>` | only with a bucket CORS policy | a CORS policy, as on S3 |
| Azure Blob, public container or a SAS URL | yes | CORS on the storage account |
| Google Drive share link | with a Google API key (public file) or a signed-in account (private) | a Google project of the lab's own — see SPECS §23.7 |
| Dropbox share link | yes | nothing; the link is rewritten to the content host |
| Presigned S3 or signed GCS URL, Azure SAS | yes, until it expires | nothing |
| GitHub Pages, GEO, SRA | no | cannot be fixed by the owner (compression; no ranges; no CORS) |
| Aiden Lab `hicfiles.s3.amazonaws.com` | no browser can | the bucket refuses every browser user agent |

Publishing a **hub** — a JSON that names the files on a bucket with columns to filter on, so a
reader can choose without opening any — is `scripts/make_hub.py bucket <prefix>`; SPECS §23 is the
format and the picker's side of it.
