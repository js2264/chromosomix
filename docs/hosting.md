# Hosting `.metacool` files for the viewer

Implements SPECS.md §11. Everything here is object-storage configuration — there is no server-side
component to deploy, and adding one would violate constraint C1. Publishing the *app* is a separate
and much shorter story: [deploy.md](deploy.md).

## The short version

A published `.metacool` is a plain object on an S3-compatible bucket that satisfies four
requirements. Miss any one and the viewer fails in a way the error messages of §10 are written to
distinguish.

| Requirement | Why |
|---|---|
| `Accept-Ranges: bytes` | The whole design is bounded range reads. Without it the browser downloads the entire file to read a 4 kB table. |
| CORS allowing `GET` and `HEAD` and the `Range` **request** header, and exposing `Content-Length` and `Content-Range` | The app runs on a different origin from the data. Exposing the two response headers is the part most often forgotten: without them the reader cannot learn the file size or verify what it got back. |
| `Content-Type: application/octet-stream` | Some CDNs will otherwise sniff, transform or compress the body, which silently breaks byte offsets. |
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

## Verifying a bucket before you trust it

Two `curl` calls answer every question. Run them against the real published URL, not a redirect:

```bash
URL=https://<bucket-host>/<path>/Hum53.metacool

# 1. Range support and content type.
curl -sSI "$URL" | grep -iE 'accept-ranges|content-length|content-type'

# 2. An actual range read, and the CORS headers a browser would see.
curl -sSI -H 'Range: bytes=0-1023' -H 'Origin: https://example.org' "$URL" \
  | grep -iE 'http/|content-range|access-control-'
```

The second call must return `206 Partial Content`, a `Content-Range`, and
`access-control-expose-headers` naming `Content-Range`. A `200` instead of a `206` means ranges are
being ignored — the viewer refuses this case explicitly rather than silently downloading gigabytes.

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
