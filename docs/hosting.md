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

## Use public URLs, not presigned ones

h5wasm issues a `HEAD` before its first `GET` to test range support. A presigned S3 URL is signed
for a **single method**, so the `HEAD` returns 403 and the open fails before it starts. Plain public
bucket URLs avoid this entirely.

This is worth stating in the deployment runbook rather than leaving to be rediscovered: the failure
looks like a CORS problem and is not one.

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

Local drag-and-drop, same code path, different byte source. Nothing is uploaded, so there are no
accounts, no storage cost and no GDPR review. The UI says so on screen, and the claim is testable:
a dropped file must render without a single network request leaving the browser.
