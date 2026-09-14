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

Several ways, and they are for different situations: a file on this machine, a prefix on a bucket
the lab controls, and a file on somebody's Google Drive that was shared with the reader.

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
Tracks card, the Contact maps card, an empty map cell, the deck's add row — carries a *from a
connected place…* button beside its *add*, and all four open the same folder view over every place
the window is connected to, buckets among them. That is what the
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

### Reading from Google Drive and GCS with an account

A **public** Drive file needs an API key and nothing else — the Drive API refuses a request without
one even for a file anyone can read — and a public GCS object needs neither. Both are one box in
**Connect → A Google API key**. This section is the other case: a file that is *not* public, which
needs the reader's own Google account and therefore a **client id the lab registers**. SPECS §24.7
is the specification; `src/auth/google.ts` is the implementation.

There is no client id in this repository and there cannot be one. An OAuth client is registered
against **the origin the page is served from**, so a fork on another domain needs its own. Making
one, in a Google Cloud project the lab owns:

1. In the Google Cloud console, pick (or create) the project, then **APIs & Services → Credentials
   → Create credentials → OAuth client ID**, application type **Web application**.
2. Under **Authorized JavaScript origins**, add the exact origin the viewer is served from — scheme,
   host and port, no path and no trailing slash. `https://js2264.github.io` for the published site,
   and `http://localhost:5173` as well while developing, which Google's documentation allows for
   `localhost` specifically.
   **Authorized redirect URIs stay empty**: this is the implicit token flow through Google Identity
   Services, which hands the token to the page and redirects nowhere.
3. On the **OAuth consent screen**, add the two scopes the viewer asks for, and no others:

   | Scope | What it grants |
   |---|---|
   | `https://www.googleapis.com/auth/drive.readonly` | Read access to **all** of the signed-in reader's Drive |
   | `https://www.googleapis.com/auth/devstorage.read_only` | Read access to the Cloud Storage that account can see |

4. Copy the client id — it ends in `.apps.googleusercontent.com` — and paste it into **Connect → A
   Google account**. It is not a secret: it is served in the page of every site that uses this flow,
   and it authorises nothing on its own. The client *secret* beside it in the console is for server
   applications and is never used here; there is no server to keep it in (C1).

**`drive.readonly` is a restricted scope** in Google's own classification, and that is the fact that
decides everything about how this is offered. An app asking for it has to go through Google's
verification — which for a restricted scope includes an independent security assessment — before it
may be used by anyone outside the project. An **unverified** app, with its publishing status left at
*Testing*, works immediately for **up to 100 test users**, each added by address on the consent
screen. That is the realistic arrangement for a lab: a handful of named colleagues, no verification,
no assessment. It is also exactly why the lab supplies its own client id rather than this project
shipping one — a single shared client would be one hundred test users for everybody, or a
verification submission on behalf of every fork.

**What the reader is agreeing to**, which the dialog says in two sentences because Google's consent
screen says neither: `drive.readonly` is read access to *all* of their Drive, where a bucket key is
a grant over one prefix of one bucket; and the token this produces is held **in this tab's memory
only** — never written to storage, gone when the tab closes, and expiring on the `expires_in` Google
returns with it, which the dialog shows as a clock time. When it expires, a Drive or GCS read
answers `401` and the error screen offers *sign in again* rather than the CORS explanation.

**Drive is a host this viewer reads, not one it recommends.** Requests are metered against the
project that owns the client id, and a fine-resolution pan over a contact map is thousands of ranged
reads where opening one is a dozen. The current limits and the project's own usage are in the Cloud
console under **APIs & Services → Quotas**; no number is quoted here because it is Google's to
change. A bucket (§20.3, above) is the host to publish on; Drive is how a reader opens the file a
collaborator already shared with them.

**The manual check**, which is the only way to verify this end to end — the flow needs
`accounts.google.com`, a real consent screen and a real private file, none of which a test
environment has:

1. Serve the viewer from an origin registered on the client (`npm run dev` on `http://localhost:5173`
   is the quickest), and open it.
2. **Connect → A Google account**: paste the client id, press *save*. The line under the box should
   print the id back, and *sign in with Google* should stop being disabled.
3. Press *sign in with Google*. A Google popup asks for the two scopes; grant them. The section
   should then say **signed in**, with the time the token is good until, and offer *sign out*.
4. Take a Drive share link for a `.mcool`, `.cool`, `.metacool` or `.hic` that is **not** public —
   one shared with the signed-in account only — and paste it into the URL box. The link
   (`https://drive.google.com/file/d/<id>/view`) is rewritten to the API's media URL and the map
   opens.
5. Press *sign out*, then reload and open the same link again. It must fail — a `401` or `403` from
   `www.googleapis.com`, with a *sign in* button on the error screen, not a map.

Step 5 is the one worth doing twice: it is the assertion that the token is actually what opened the
file, and that nothing was written down that keeps opening it afterwards.

**A whole Drive folder, browsed in the Files panel** (SPECS §20), needs nothing this section has not
already set up: the same client id, the same sign-in, the same `drive.readonly` grant. It is not
the API key — a key opens a public *file* and cannot list anything — so a folder is the one Drive
feature that does not work at all without an account. **Connect → A Google Drive folder** takes the
address bar of a folder open in Drive (`https://drive.google.com/drive/folders/<id>`, with or
without the `/u/0` account segment) or the bare id; an empty box is all of My Drive. What this
browser then keeps is the folder's name and its id, listed under **About → what is stored**; the
token is not kept, so the folder survives a reload and the sign-in does not.

The listing asks `drive/v3/files` for the files whose `parents` contains that id, one level at a
time and a thousand entries at most (§20.1), and it sends `supportsAllDrives=true` and
`includeItemsFromAllDrives=true` — so a folder on a **shared drive**, which is how most labs
actually hold shared data, lists and opens exactly as one in My Drive does. Google's own document
types (Docs, Sheets, Slides, shortcuts) are not listed: they have no bytes behind them, so there is
no file to offer. Everything else is listed, including the formats this viewer cannot open, which
the panel draws dimmed with the reason (§20.5). The quota paragraph above applies with more force
here than to a pasted link, because browsing is itself requests against the same project.

**The manual check for a folder**, on top of the five steps above and for the same reason — it needs
a real Drive, a real consent screen and a real folder:

1. Signed in as above, open **Connect → A Google Drive folder**. Before the sign-in the section
   offers nothing to press and says which of the two things is missing; after it, it has a name box
   and a link box.
2. Paste the address bar of a Drive folder holding a `.mcool`, `.cool`, `.metacool` or `.hic`, name
   it, and press *connect this folder*. The Files panel opens on it.
3. The listing should show sub-folders first, then files with their sizes, and no Docs or Sheets.
   Click into a sub-folder: it lists, and the crumb trail above names the folders rather than
   printing their ids.
4. Click a contact map. It opens in the tab that is open, and the address it opens under is
   `https://www.googleapis.com/drive/v3/files/<id>?alt=media&supportsAllDrives=true` — the same URL
   a pasted share link for that file is rewritten to, which is what keeps a file opened from the
   folder and the same file opened from a link one file rather than two.
5. Repeat step 2 with a folder on a **shared drive**. It must list; a folder that answers as though
   it did not exist is `includeItemsFromAllDrives` missing from the request.
6. Press *sign out* and reload. The folder is still in the list — it is a row in this browser, not a
   token — and it does not list until you sign in again, which takes no reconnecting.

**Where it is absent.** The single-file build (§19) has an opaque origin, so there is no origin to
register and no sign-in section in its dialog. The desktop build serves itself from `app://viewer`,
and Google's console accepts only `http`/`https` JavaScript origins, so it has none to register
either and the section is absent there too; a public Drive file still opens there with the API key.

### Reading from Dropbox

Two different things live behind that name, and only the second needs anything set up.

A Dropbox **share link** pasted into the URL box opens today, with no account and nothing
registered: the viewer swaps the host to `dl.dropboxusercontent.com`, which serves ranges and
answers CORS for every origin (SPECS §24.5). Nothing below applies to it.

**Browsing** a Dropbox — the folder in the Files panel, one level at a time — is the other thing,
and it needs the reader's own account: the listing API takes a bearer token and nothing else, so
there is no public way to browse a Dropbox the way a public bucket can be browsed. That needs an
**app key the lab registers**. SPECS §20 and §24.7 are the specification; `src/auth/dropbox.ts` and
`src/browse/dropbox.ts` are the implementation.

There is no app key in this repository, for the reason there is no Google client id: it names the
lab's own registration, and a shared one would be everybody's. Making one, in the Dropbox App
Console:

1. **App Console → Create app → Scoped access.**
2. Choose the access the app gets: **App folder** or **Full Dropbox**. App folder confines it to a
   single directory Dropbox creates for it, which is the narrower grant and the one to prefer where
   the data can live there; Full Dropbox is read access to the whole account. The viewer shows
   whichever it was given and cannot tell from the outside which one it has — the App Console entry
   is where that is written down.
3. **Permissions tab:** tick `files.metadata.read` and `files.content.read`, and submit. Those two
   and no others: there is no `account_info.read`, so the app never learns whose account it is, and
   the dialog says as much rather than printing an address it does not have. A permission added
   *after* somebody has signed in does not apply to the token they are holding — they sign out and
   in again.
4. **Settings tab:** copy the **App key** and paste it into **Connect → Dropbox**. Leave
   **Redirect URIs empty.** The viewer asks for a code with no `redirect_uri`, which is what makes
   Dropbox display the code on its own page for the reader to copy — and that is why one app key
   works for the published site, a fork of it on another domain, the desktop build and a local
   `npm run dev`, with nothing registered per address. The **App secret** beside it is for server
   applications and is never used here: there is no server to keep it in (C1), and PKCE (RFC 7636)
   is what stands in for it — the page proves it asked for the code by presenting a random verifier
   whose SHA-256 it sent with the request.

**What the reader is agreeing to**, which the dialog says in two sentences: the app is granted read
access to everything in their Dropbox, or to the app's own folder inside it, depending on step 2 —
and the token this produces is held **in this tab's memory only**, never written to storage, gone
when the tab closes, and expiring on the `expires_in` Dropbox returns with it, which the dialog
shows as a clock time. `token_access_type=online`, so no refresh token comes back: a refresh token
is a long-lived credential, and storing one is the thing §24.8 refuses outright.

**A picked file's link lasts four hours.** Clicking a file in a Dropbox folder calls
`/2/files/get_temporary_link`, which answers a URL on `dl.dropboxusercontent.com` that carries its
own authorisation and, by Dropbox's own documentation, expires four hours later. Two consequences
worth knowing before they happen:

- The share link this viewer produces for such a file **is that URL**, so a session link sent to a
  colleague stops working the same afternoon. For something durable, send them the Dropbox share
  link instead — the viewer rewrites it to the content host, and it lasts as long as the share does.
- A map left open past the expiry fails on its next read, the way any expired link fails. Picking
  the file again in the panel mints a new one; there is deliberately nothing in the viewer that
  watches the clock and re-mints behind the reader's back.

**The manual check**, which is the only way to verify this end to end — the flow needs
`www.dropbox.com`, a real authorization page and a real Dropbox, none of which a test environment
has:

1. Register the app as above, serve the viewer (`npm run dev` is the quickest), and open it.
2. **Connect → Dropbox:** paste the app key, press *save*. The line under the box should print it
   back, and *sign in with Dropbox* should stop being disabled.
3. Press *sign in with Dropbox*. A Dropbox tab opens asking to allow the app; allow it, and Dropbox
   shows a code instead of returning to the viewer. Copy the code into the box that has appeared and
   press *finish*. The section should then say **signed in**, with the time the token is good until,
   and offer *browse my Dropbox* and *sign out*.
4. Press *browse my Dropbox*. The Files panel opens on the root of what the app was granted, folders
   first; walking into a folder lists that folder and nothing below it. Click a `.mcool`, `.cool`,
   `.metacool` or `.hic` and the map opens. A file this viewer has no route for is listed, dimmed,
   with the reason in its tooltip — it is not hidden (§20.5).
5. Press *sign out*, then click a folder in the panel again. It must refuse, in words, with an offer
   to sign in to Dropbox — not list, and not report a CORS problem.
6. Reload the page. The Dropbox is still in the Files panel, because the app key is stored; it is
   not usable until you sign in again, because the token never was.

Steps 5 and 6 are the pair worth doing carefully: together they are the assertion that the token is
what read the folder, and that nothing was written down that goes on reading it afterwards.

**Where it is absent.** The single-file build (§19) has an opaque origin, so every request to
Dropbox fails before a byte moves and the section is absent from its dialog. The desktop build keeps
it, unlike the Google sign-in above: nothing here is registered against an origin, so `app://viewer`
signs in as well as a website does — the authorize page opens in the machine's real browser
(`electron/main.cts` sends every `window.open` there), and the code is pasted back into the app.

## A host that hides Content-Range

Expose `Content-Range` and `Content-Length` (above) and the viewer learns a file's size from its
first ranged read. A bucket that exposes neither — 4DN's open-data bucket exposes `ETag` and
nothing else — still works, at the cost of one more request: the viewer asks for the size with a
`HEAD`, whose `Content-Length` every page may read without being told it may, so allow `HEAD` in
the policy (the `AllowedMethod` list above does). A host that answers neither still gets a bounded
header read for a BAM, and a sentence rather than a download for the index it cannot address.

## A FASTA, and its index

A genome's sequence is the one file whose size decides how it is read (SPECS §8.8). Under 64 MB
the viewer reads it whole — one request, every zoom draws GC content, the motif search can run.
Over it, the viewer reads the **`.fai`** beside it and then the sequence by range, a window at a
time, so a mammalian genome is on screen the moment the index has arrived and nothing of the
sequence is fetched until a lane asks for it. So publish the index with the file:

```bash
samtools faidx genome.fa          # writes genome.fa.fai
aws s3 cp genome.fa     s3://my-lab/ref/
aws s3 cp genome.fa.fai s3://my-lab/ref/
```

`<url>.fai` is guessed, never probed; an index published under another name is given as
`https://…/genome.fa#index=https://…/other.fai`, the same fragment a BAM's `.bai` takes. A large
FASTA with no index is read whole up to 300 MB and refused past it, by a sentence naming the size
and the command above. Compress a reference only if you must: a bgzipped FASTA is read whole
whatever its size, its `.fai` needing a `.gzi` this viewer does not read.

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
| Google Drive share link | with a Google API key (public file) or a signed-in account (private) | a Google project of the lab's own — see [above](#reading-from-google-drive-and-gcs-with-an-account) |
| Google Drive folder, browsed in the Files panel | with a signed-in account | the same client id; shared drives included — see [above](#reading-from-google-drive-and-gcs-with-an-account) |
| Dropbox share link | yes | nothing; the link is rewritten to the content host |
| Dropbox folder, browsed in the Files panel | with a signed-in account | a Dropbox app of the lab's own — see [above](#reading-from-dropbox) |
| Presigned S3 or signed GCS URL, Azure SAS | yes, until it expires | nothing |
| GitHub Pages, GEO, SRA | no | cannot be fixed by the owner (compression; no ranges; no CORS) |
| Aiden Lab `hicfiles.s3.amazonaws.com` | no browser can | the bucket refuses every browser user agent |

Publishing a **store** — a JSON that names the files on a bucket with columns to filter on, so a
reader can choose without opening any — is `scripts/make_store.py bucket <prefix>`; SPECS §24 is the
format and the drawer's side of it.
