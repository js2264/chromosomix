---
title: "Hosting your data"
description: "How to publish contact maps and tracks on Amazon S3, Cloudflare R2, Google Cloud Storage or a web server of your own so that chromosomix reads them by range, how to check the host, and what readers cost."
---

chromosomix reads a remote file where it is. Your reader's browser asks your host for the few byte
ranges a view needs — a header, an index, the block on screen — and there is no server of ours in
between. So hosting data for chromosomix means publishing the file you already have, unconverted,
on a host that serves byte ranges to other websites. Anyone with its address can then open it, link
to a place in it, or find it in a [data store](/advanced/data-store/).

To open files that are already published, see [Opening files](/files/opening/).

## What a host must do

| The host must | Because |
| --- | --- |
| answer a `Range` request with `206 Partial Content`, and say `Accept-Ranges: bytes` | every read is a byte range; a host that ignores ranges and sends the whole file is refused rather than downloaded |
| let other sites read the file (CORS): allow `GET` and `HEAD` and the `Range` request header, and expose the `Content-Length` and `Content-Range` response headers | the viewer runs on its own site, not on yours; the two exposed headers are the part most often forgotten |
| send the file as it is, with no `Content-Encoding` | a range of a compressed response is a range of the compressed bytes; serve a `.gz` as the `.gz` it is |
| send `Content-Type: application/octet-stream` | it keeps a CDN from sniffing and transforming the body |
| give a long cache lifetime to files whose name changes when their contents change | readers ask for the same ranges again, and a cache can answer them |

In headers, a host that does all of this answers a ranged read like this:

```text
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-1023/839405381
Content-Length: 1024
Content-Type: application/octet-stream
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag
```

and answers the request the browser sends first, an `OPTIONS` preflight, like this:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD
Access-Control-Allow-Headers: Range
Access-Control-Max-Age: 86400
```

`Access-Control-Allow-Origin: *` lets every copy of the viewer read the file — the site, its pinned
releases, a lab's [own copy](/advanced/self-hosting/) — which suits released data. Naming
`https://chromosomix.app` instead admits the site alone; a figure embedded in somebody else's page is
still the site reading, so it needs nothing more.

:::caution[Compression is the failure you will not see]
A host that compresses files on the way out (`Content-Encoding: gzip`) breaks byte ranges, and no
browser can ask it not to. The website then downloads such a file whole, up to 128 MiB as sent, and
refuses anything larger. The [desktop app](/start/where-to-run/) can ask for an uncompressed transfer,
so it reads such a host by range. GitHub Pages compresses exactly these files and cannot be told
otherwise: it can serve the app, but not data for it.
:::

### Indexes go beside their files

Publish each index under the file's own name with its suffix added, in the same folder, and the
viewer finds it without being told:

- a **BAM** is read a window at a time through its `.bai` (or `.csi`). Without one, the viewer finds
  each window by searching the file, which works and costs more requests;
- a bgzipped **text file** — a BED, a bedGraph, a GTF, a VCF — is read by range through its tabix
  index (`.tbi`), and read whole without one;
- a **FASTA** over 64 MB is read by range through its `.fai`; a smaller one is read whole. Without
  an index a large FASTA is read whole up to 300 MB and refused past it, and a bgzipped FASTA is read
  whole whatever its size.

```sh
samtools faidx genome.fa      # writes genome.fa.fai
samtools index reads.bam      # writes reads.bam.bai
```

An index that cannot sit beside its file is named after the file's address:
`https://…/reads.bam#index=https://…/elsewhere/reads.bam.bai`.

## Amazon S3

1. Upload the files as they are, as bytes, with a long cache lifetime. Upload the files you will
   edit in place — a store, a saved workspace — separately, with a short one:

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

   A year-long cache is only right for a file that never changes under its name: publish a new
   version under a new name.

2. Make the objects publicly readable with a bucket policy:

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

   The account's *Block Public Access* setting must not override it. An upload that succeeded
   followed by an anonymous read that answers `403` is the policy or that setting, not the files.

3. Set the bucket's CORS configuration. In the S3 console it is this JSON:

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

   From the command line, the same rule goes inside `CORSRules`:

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

   Keep `MaxAgeSeconds`: without it the browser sends a preflight before every range request
   instead of once, which doubles the requests.

4. [Check it with curl](#check-a-host-with-curl), then open it by its address,
   `https://my-lab.s3.eu-west-3.amazonaws.com/hic/sample.mcool`. An `s3://my-lab/hic/sample.mcool`
   address is read as the `https://` address it stands for.

:::caution[One CORS configuration per bucket]
An S3 CORS configuration covers the whole bucket, and `put-bucket-cors` replaces it rather than adding
to it. A bucket that also has a private prefix needs both of its rules in one configuration: see
[A private bucket](#a-private-bucket).
:::

## Cloudflare R2

R2 is the host this project recommends for public data. It works like S3, and it does not charge for
the bytes it sends — and a Hi-C collection is a few large files read many times.

1. In the bucket's settings, allow public access, which gives the bucket a public address.
2. Add a CORS policy to the bucket with the rule above: `GET` and `HEAD`, the `Range` header, and
   `Content-Length` and `Content-Range` exposed.
3. Upload the files as they are, with `Content-Type: application/octet-stream` and no
   `Content-Encoding`.
4. [Check](#check-a-host-with-curl) the public address you will publish — the one your readers
   will use, not another way into the same bucket.

The same goes for MinIO, Ceph, Wasabi and Backblaze B2: each takes the same rule, in its own settings.

## Google Cloud Storage

A public object has two addresses, and they need different things from the bucket:

- `gs://my-lab/hic/sample.mcool` is read through Google's JSON API
  (`https://storage.googleapis.com/storage/v1/b/my-lab/o/…?alt=media`), which answers every site. A
  public object opens this way with no CORS configuration at all. So does a
  `https://storage.cloud.google.com/…` address, which is read the same way.
- `https://storage.googleapis.com/my-lab/hic/sample.mcool` is read as it is, and that host answers
  another site only once the bucket has a CORS policy — the same rule as S3's, in Google's own
  format. Connecting the bucket as a folder in the Files panel goes through this host too.

So: make the objects public, upload them as they are, and share `gs://` addresses — or give the bucket
a CORS policy if you want the other form, or want the bucket browsable. A private object opens once
the reader signs in with a Google account that can read it.

## A web server of your own

1. Serve the files over HTTPS. The viewer reads any `https://` host, and plain `http://` only from
   the reader's own computer (`localhost` or `127.0.0.1`).
2. Check that the server answers `Range` with `206`: most static servers do for plain files.
3. Add the CORS headers [above](#what-a-host-must-do) to the data's responses, and answer the
   `OPTIONS` preflight with the methods and the `Range` header.
4. Turn off on-the-fly compression for the data files.
5. [Check it with curl](#check-a-host-with-curl).

If the server also serves [your own copy of the viewer](/advanced/self-hosting/), the data is on the
viewer's own site and needs no CORS at all — but it still needs byte ranges and no compression.

## Hosts that work, and hosts that cannot

| Host | What it needs |
| --- | --- |
| Amazon S3, by its virtual-hosted or path-style address | the CORS rule above |
| Cloudflare R2, MinIO, Ceph, Wasabi, Backblaze B2 | the same rule, in their own settings |
| Google Cloud Storage | nothing for a public object by `gs://`; a CORS policy for `storage.googleapis.com/<bucket>/…` |
| Azure Blob Storage, a public container or a SAS address | CORS on the storage account |
| A Dropbox share link | nothing: it is read from Dropbox's own content host |
| A Google Drive share link | nothing for a public file on chromosomix.app; a private one needs the reader to sign in |
| GitHub Pages | cannot: it compresses these files and cannot be told not to |
| GEO and SRA | cannot: their downloads serve no ranges and no CORS. Deposit there for the record, and serve a copy from a bucket for viewing |

Drive and Dropbox are hosts the viewer reads rather than ones to publish on. Each Drive request takes
the better part of a second and counts against a Google project's quota — a fine-resolution pan over
a map is thousands of them — and a file picked from a connected Dropbox is read through a temporary
link that lasts four hours.

## Check a host with curl

Three requests answer every question. Run them against the address you will publish, not a redirect
to it:

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
- The second must show a `206`, a `content-range`, and an `access-control-expose-headers` naming
  `Content-Range`. A `200` means the host ignores ranges.
- The third must show no `content-encoding` at all, and a `content-length` equal to the file's size.
  Leave out the `Accept-Encoding` header and this check passes against a host that would fail a
  browser.

A host that exposes neither `Content-Length` nor `Content-Range` still opens, at the cost of one more
request per file, as long as it allows `HEAD`.

## What it costs

The viewer reads only what a view needs, so a reader costs a few requests rather than a download:

- opening a map reads its header and its indexes;
- each new place on the map is one bounded read. Panning and zooming within what has been read costs
  nothing, and a place visited again is answered from memory;
- the whole-genome view, every chromosome against every other, reads the whole file, so it waits for
  a button that says what it will read;
- a BAM costs its header and index once, then a few requests a window.

To see what a reader of your file costs, open it and look at **read** on the status bar: it gives the
requests and bytes, in total and for the last view.

Object stores bill for two things a reader causes: requests, and the bytes sent out (egress). Egress
is what grows with a popular dataset, which is why R2, which does not charge for it, is the
recommended host. Keep `MaxAgeSeconds` in the CORS rule, and long cache lifetimes on files that do
not change. The viewer itself costs you nothing: it runs in your readers' browsers.

## Public or private

A **public** file is readable by anyone who has its address, which is what a link in a paper needs.
Everything above is about public files.

### A public bucket that can be browsed

Opening a file by its address needs `s3:GetObject` on the objects. Browsing the folder it is in —
connecting the prefix with **connect a bucket…** and seeing it in the Files panel — needs
`s3:ListBucket` on the bucket, a separate grant that most published buckets do not give. Add it to
the bucket policy, limited to the prefix so the rest of the bucket's names stay private:

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

Listing needs no change to the CORS rule. A bucket without the grant still opens every file by URL,
and the viewer says which grant is missing.

### A private bucket

For data that should not be public — a collection under review, a lab's own — each reader gives the
viewer a key. On the landing page, **connect a bucket…** takes the prefix (`https://` or
`s3://bucket/prefix/`); **additional settings** under it take the **region**, the **access key ID**
and the **secret key**, and a **session token** for temporary credentials. Everything under that
prefix is then read with signed requests; everything else stays unsigned.

Give readers a dedicated key that can do two things on that prefix and nothing else:

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

A signed request carries headers the public rule does not allow, so the bucket needs a second CORS
rule for them. S3 answers with the first rule that matches, so the order matters and both go in one
configuration:

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

Add the address of any other copy of the viewer your readers use to the second rule's
`AllowedOrigins`. Check it with the preflight a browser sends before a signed read, which needs no key
and must print `200`:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X OPTIONS "$URL" \
  -H 'Origin: https://chromosomix.app' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,x-amz-date,x-amz-content-sha256'
```

:::danger[The key is in the reader's browser]
With no server, whatever signs a request holds the key: it is kept in that browser, in plain text,
where any script on the viewer's site could read it. What protects your data is the key's own
permissions, which is why the policy above grants two actions on one prefix. Never hand out an
administrator key. See [Privacy](/advanced/privacy/).
:::

### Links that expire

A presigned S3 address, a signed Google Cloud Storage address or an Azure SAS opens and keeps reading
until its signature expires; then the host answers `403` and the viewer says so. The signature is
part of the address, so anyone the link reaches can read the file until then, and it travels into
every link written from that view. Use one to hand a colleague a file today; a public object, or a
private bucket with a key, is what a citation should point at.

### Google Drive, Cloud Storage and Dropbox accounts

A reader can also sign in to read their own private files: a Google account for Drive and Cloud
Storage, a Dropbox account for a Dropbox. What each sign-in grants, and where its token is kept, is on
the [Privacy](/advanced/privacy/) page.

## Links to share

A link carries addresses, never data: whoever opens it reads the files from your host, with whatever
access they have. Once a file is hosted:

- **A place in a file.** Open it, go where you want, and use **Share this tab as a link**: the link
  holds the tab whole, its tracks and marks included. Or write the link yourself —
  `https://chromosomix.app/#uri=<address>&view=region&region=chr2:10000000-14000000` — with the keys
  in [Link keys](/reference/links/).
- **A composed figure.** Arrange the tabs, use **Save every tab as a file**, put the
  `.chromosomix.json` beside the data, and link to `https://chromosomix.app/?config=<its address>`.
  See [Sessions, workspaces and links](/browse/sessions-and-links/).
- **The whole collection.** List it in a [data store](/advanced/data-store/) and link to
  `https://chromosomix.app/?store=<its address>`.
- **In a paper.** Name a release, which is kept for good: `https://chromosomix.app/v/<tag>/` takes the
  same query and fragment as the root.
- **In a web page.** Add `?embed=1` and put the link in an `<iframe>`: see
  [Embedding in a web page](/embed/web-page/).
