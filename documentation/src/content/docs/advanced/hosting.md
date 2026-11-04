---
title: "Hosting your data"
description: "Publish contact maps and tracks on Amazon S3, Cloudflare R2, Google Cloud Storage or your own web server so that chromosomix reads them by range, check the host, and see what readers cost."
---

Publish the file you already have, unconverted, on a host that serves byte ranges to other websites: readers' browsers read it from there directly. To open files already published, see [Opening files](/files/opening/).

## What a host must do

- Answer a `Range` request with `206 Partial Content` and `Accept-Ranges: bytes`. A contact map on a host that ignores ranges is refused.
- Let other sites read the file (CORS): allow `GET`, `HEAD` and the `Range` header, and expose `Content-Length` and `Content-Range`, the part most often forgotten.
- Send the file as it is, with no `Content-Encoding`: a `.gz` as the `.gz` it is.
- Send `Content-Type: application/octet-stream`, so that a CDN leaves the body alone.
- Give a long cache lifetime to files whose name changes when their contents do.

A ranged read on such a host answers:

```text
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-1023/839405381
Content-Length: 1024
Content-Type: application/octet-stream
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag
```

and the `OPTIONS` preflight the browser sends first:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Range
Access-Control-Max-Age: 86400
```

`Access-Control-Allow-Origin: *` admits every copy of the viewer. A list admits only the origins it names: `https://chromosomix.app` (the site, its releases and its embeds), `app://viewer` (the desktop app), your [own copy](/advanced/self-hosting/).

:::caution[Compression is the failure you will not see]
A host that compresses on the way out (`Content-Encoding: gzip`) breaks byte ranges. The website then reads such a file whole, up to 128 MiB as sent, and refuses larger ones; the [desktop app](/start/where-to-run/) still reads it by range. GitHub Pages always compresses these files: it can serve the app, not data.
:::

### Indexes go beside their files

Publish each index in its file's folder, under the file's name plus its suffix:

- a **BAM**'s `.bai` (or `.csi`): without one, each window costs more requests;
- a bgzipped **text file**'s tabix `.tbi` (BED, bedGraph, GTF, VCF): without one, the file is read whole;
- a **FASTA**'s `.fai`, used over 64 MB. Without one, a FASTA is read whole up to 300 MB and refused past it; a bgzipped FASTA is always read whole.

```sh
samtools faidx genome.fa      # writes genome.fa.fai
samtools index reads.bam      # writes reads.bam.bai
```

An index elsewhere is named after the file's address: `https://…/reads.bam#index=https://…/elsewhere/reads.bam.bai`.

## Amazon S3

1. Upload the files as they are, with a long cache lifetime for the data and a short one for files you will edit in place. Publish a new version under a new name.

   ```sh
   # The data: unchanged under its name, so cached for a year
   aws s3 sync ./hic/ s3://my-lab/hic/ --exclude '*.json' \
     --content-type application/octet-stream \
     --cache-control 'public, max-age=31536000, immutable'

   # Stores and workspaces, which you will edit: cached for five minutes
   aws s3 sync ./hic/ s3://my-lab/hic/ --exclude '*' --include '*.json' \
     --content-type application/json \
     --cache-control 'public, max-age=300'
   ```

2. Make the objects public with a bucket policy, which the account's *Block Public Access* setting must not override: an anonymous read answering `403` means one or the other.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PublicRead",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::my-lab/hic/*"
       }
     ]
   }
   ```

3. Set the bucket's CORS configuration, in the S3 console:

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
       "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   or from the command line:

   ```sh
   aws s3api put-bucket-cors --bucket my-lab --cors-configuration '{
     "CORSRules": [{
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
       "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
       "MaxAgeSeconds": 86400
     }]
   }'
   ```

   Keep `MaxAgeSeconds`, or every range request costs a preflight too.

4. [Check it with curl](#check-a-host-with-curl), then open `https://my-lab.s3.eu-west-3.amazonaws.com/hic/sample.mcool`, or `s3://my-lab/hic/sample.mcool`.

`put-bucket-cors` replaces the bucket's whole configuration: a bucket with a private prefix too needs both rules in one ([A private bucket](#a-private-bucket)).

## Cloudflare R2

R2, the host this project recommends for public data, works like S3 and does not charge for the bytes it sends.

1. Allow public access in the bucket's settings.
2. Add the CORS rule above.
3. Upload the files as they are, as `application/octet-stream` with no `Content-Encoding`.
4. [Check](#check-a-host-with-curl) the public address your readers will use.

MinIO, Ceph, Wasabi and Backblaze B2 take the same rule, in their own settings.

## Google Cloud Storage

Make the objects public, upload them as they are, and share `gs://` addresses. Like `https://storage.cloud.google.com/…` addresses, they are read through Google's JSON API and need no CORS. A `https://storage.googleapis.com/…` address, and connecting the bucket as a folder in the Files panel, need a CORS policy on the bucket: S3's rule, in Google's format. A private object opens once the reader signs in with a Google account that can read it.

## A web server of your own

1. Serve the files over HTTPS; plain `http://` is read only from `localhost` or `127.0.0.1`.
2. Answer `Range` with `206`, as most static servers do for plain files.
3. Add the CORS headers [above](#what-a-host-must-do), and answer the `OPTIONS` preflight.
4. Turn off on-the-fly compression for the data files.
5. [Check it with curl](#check-a-host-with-curl).

Data beside [your own copy of the viewer](/advanced/self-hosting/) needs no CORS, but still needs byte ranges and no compression.

## Hosts that work, and hosts that cannot

| Host | What it needs |
| --- | --- |
| Amazon S3, by its virtual-hosted or path-style address | the CORS rule above |
| Azure Blob Storage, a public container or a SAS address | CORS on the storage account |
| A Dropbox share link | nothing: it is read from Dropbox's own content host |
| A Google Drive share link | nothing for a public file on chromosomix.app; a private one needs the reader to sign in |
| GitHub Pages | cannot: it compresses these files and cannot be told not to |
| GEO and SRA | cannot: no ranges and no CORS. Deposit there for the record, and serve a copy from a bucket for viewing |

Drive and Dropbox are for reading, not publishing: each Drive request is slow and counts against a Google quota, and a connected Dropbox's file links last four hours.

## Check a host with curl

Run these against the address you will publish, not a redirect:

```sh
URL=https://my-lab.s3.eu-west-3.amazonaws.com/hic/sample.mcool

# 1. Range support, the file's size and its type.
curl -sSI "$URL" | grep -iE 'accept-ranges|content-length|content-type'

# 2. A real range read, and the CORS headers a browser would get.
curl -sS -o /dev/null -D - -H 'Range: bytes=0-1023' -H 'Origin: https://chromosomix.app' "$URL" \
  | grep -iE '^http/|content-range|access-control-'

# 3. What a browser gets, which always offers compression.
curl -sSI -H 'Accept-Encoding: gzip, deflate, br' "$URL" | grep -iE 'content-encoding|content-length'
```

- The first must show `accept-ranges: bytes`, and the file's size as `content-length`.
- The second must show a `206`, a `content-range`, and an `access-control-expose-headers` naming `Content-Range`. A `200` means the host ignores ranges.
- The third must show no `content-encoding`, and the file's size as `content-length`. Without its `Accept-Encoding` header it would miss a host that fails a browser.

A host exposing neither `Content-Length` nor `Content-Range` still opens if it allows `HEAD`, at one more request per file.

## What it costs

A reader costs a few requests, not a download: a map's header and indexes, then one bounded read per new place. The whole-genome view reads the whole file, so it waits for a button. **read** on the status bar shows a file's requests and bytes, in total and for the last view.

Object stores bill requests and the bytes sent out (egress), which grow with a popular dataset; R2 does not charge for egress. Keep `MaxAgeSeconds` and long cache lifetimes.

## Public or private

Everything above is for public files, readable by anyone with the address. Readers can also sign in to Google or Dropbox to read their own private files ([Privacy](/advanced/privacy/)).

### A public bucket that can be browsed

Opening a file needs `s3:GetObject`. Browsing its folder with **connect a bucket…** also needs `s3:ListBucket`, which most published buckets do not grant. Add it, limited to the prefix so the rest of the bucket stays unlisted:

```json
{
  "Sid": "PublicBrowse",
  "Effect": "Allow",
  "Principal": "*",
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::my-lab",
  "Condition": { "StringLike": { "s3:prefix": ["hic/*"] } }
}
```

The CORS rule stays as it is. Without this grant every file still opens by URL, and the viewer says which grant is missing.

### A private bucket

Each reader gives the viewer a key. On the landing page, **connect a bucket…** takes the prefix (`https://` or `s3://bucket/prefix/`), and **additional settings** under it the **region**, the **access key ID**, the **secret key** and, for temporary credentials, a **session token**. Requests under that prefix are then signed; the rest are not.

Give readers a key that can only read and list that prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-lab/collections/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-lab",
      "Condition": { "StringLike": { "s3:prefix": ["collections/*"] } }
    }
  ]
}
```

Signed requests need a second CORS rule, after the public one and in the same configuration, since S3 uses the first rule that matches:

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
    "AllowedOrigins": ["https://chromosomix.app"],
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

Add your own copy's address, or `app://viewer` for the desktop app, to its `AllowedOrigins` if readers use them. The preflight a browser sends before a signed read checks it with no key, and must print `200`:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X OPTIONS "$URL" \
  -H 'Origin: https://chromosomix.app' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,x-amz-date,x-amz-content-sha256'
```

:::danger[The key is in the reader's browser]
The key is kept in the reader's browser, in plain text, where any script on the viewer's site could read it. Only its own permissions protect your data: grant two actions on one prefix, never an administrator key. See [Privacy](/advanced/privacy/).
:::

### Links that expire

A presigned S3 address, a signed Google Cloud Storage address or an Azure SAS works until it expires; then the host answers `403`. Until then anyone it reaches can read the file, through every link written from that view too: use one for a colleague, not a citation.

## Links to share

A link carries addresses, never data: whoever opens it reads your host, with their own access.

- **A place in a file.** Go there and use **Share this tab as a link**, or write `https://chromosomix.app/#uri=<address>&view=region&region=chr2:10000000-14000000` with the keys in [Link keys](/reference/links/).
- **A composed figure.** Put a workspace saved with **Save every tab as a file** beside the data, and link to `https://chromosomix.app/?config=<its address>` ([Sessions, workspaces and links](/browse/sessions-and-links/)).
- **The whole collection.** List it in a [data store](/advanced/data-store/) and link to `https://chromosomix.app/?store=<its address>`.
- **In a paper.** Name a release, kept for good: `https://chromosomix.app/v/<tag>/`, with the same query and fragment.
- **In a web page.** Add `?embed=1` and put the link in an `<iframe>` ([Embedding in a web page](/embed/web-page/)).
