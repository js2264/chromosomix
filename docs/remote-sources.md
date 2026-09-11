# Remote sources beyond S3

Where the viewer stands against juicebox.js on remote files, what each further provider would
cost, and the ways a reader could arrive **pre-connected** to a public server such as 4DN or ENCODE
with sessions ready to open. Everything measured here was measured on 2026-09-11 against the live
hosts; the commands are in the [appendix](#appendix-how-the-measurements-were-taken).

This is the design note the build was made from. **Since: built.** SPECS §24 is the specification
that came out of it — hubs, the rewrite table, links that expire, credentials that are not a bucket
key, live portal search (built, then withdrawn — see B below), Google sign-in, and past this
note's own scope a Drive folder and a
Dropbox as connected folders (§24.9) — and `docs/hubs.md` is the operator's page; the
`[Unreleased]` section of `CHANGELOG.md` says what landed. The measurements below stand as they
were made. It touches SPECS §11 (hosting), §20 (connected folders), §21 (`?config=`), GAPS G10 (a
catalogue) and the constraints at §1.

## The short version

- **The byte layer already reaches 4DN and ENCODE.** Both portals mirror their released files to
  public S3 buckets with CORS and range support, and the unmodified viewer opens them: a 2.2 GB 4DN
  `.mcool` lands on its chromosomes table in 7.8 s over 13 requests (11.5 MB), a 839 MB 4DN `.hic`
  in 6.7 s over 6 requests (22 MB), and a workspace JSON pointing at the `.mcool` opens a balanced
  12 Mb window through `?config=` exactly as the demos do. There are **2,367 contact maps** on the
  4DN open-data bucket today (1,166 `.mcool`, 1,182 `.hic`, 19 `.cool`), plus 5,327 bigWigs and 722
  bigBeds. No new reader code is needed for any of them.
- **What is missing is discovery, not access.** The viewer has no notion of a *server*: the only
  catalogue is a compile-time array of four demo workspaces (`src/ui/examples.ts`), the only
  remembered connections are S3 prefixes (`src/s3/credentials.ts`), and a connected 4DN bucket is
  39,800 UUID-named folders under one prefix, capped at 1,000 by §20.1 — a listing nobody can use.
  juicebox.js's advantage on this axis is entirely a *menu*: three static catalogues — 571 Aiden
  Lab maps shipped with the app, 606 4DN and 176 ENCODE `.hic` files in two TSVs that a script
  regenerates from the portals' APIs and the app fetches from GitHub. It does not talk to either
  portal live.
- **Consumer clouds are URL rewrites, not readers.** Dropbox and Google Drive share links do not
  serve ranges as pasted; igv-utils turns them into URLs that do. Dropbox is a host swap and
  needs no credential. Google Drive needs an **API key** for public files (measured: the API
  answers CORS and allows `Range` and `Authorization`, and refuses without a key) and an OAuth
  token for private ones — and juicebox-web has removed Drive from its menus, which says
  something about how well that path wore.
  Google Cloud Storage works today through its JSON-API media endpoint, which answers CORS for any
  origin; the plain `storage.googleapis.com/<bucket>/<object>` host only does with a bucket CORS
  policy, like S3.
- **The recommendation is a hub format plus a generator script**, in that order: a static JSON
  that names maps and sessions, served from any CORS-enabled host, offered from the picker and
  addressable as `?hub=<url>`; built-in hubs for 4DN open data and ENCODE produced offline from the
  portals' search APIs; then live portal search where the portal's CORS allows it; then the Dropbox
  and Drive rewrites; OAuth pickers last, if at all. All of it fits C1 and C5.

## 1. What the viewer does today

Every decision about a remote file is made at a handful of seams. They are listed here because the
rest of this note is about which of them each option touches.

| Seam | Where | What it decides |
|---|---|---|
| `inferSource` | `src/app/resolve.ts:59-62` | `/^https?:\/\//` is remote; everything else is local. This is also the **shareability** test that gates what may be written into the URL hash. |
| `SourceLocation` | `src/worker/protocol.ts:81-87` | The remote arm is `{ kind: 'remote', url, credential?: S3Credential }`. There is nowhere to put a bearer token, an API key or a per-host header today. |
| `withCredential` and the scopes | `src/s3/attach.ts:93-114`, `src/s3/credentials.ts` | A `localStorage` array of `BucketScope { base, region?, accessKeyId?, … }`, matched by longest URL prefix, stamped onto the message at the two `postMessage` boundaries. A scope with no key is a *public* prefix somebody wants to browse. |
| `createSource` | `src/worker/sources.ts:25-84` | The one place a `ByteSource` is constructed: `RemoteRangeSource.open`, the whole-object fallback, the `.px2` sidecar guess. |
| `RemoteRangeSource.open` | `src/sources/RemoteRangeSource.ts:106-229` | `HEAD`, then the `Content-Encoding` refusal, then `Accept-Ranges` + `Content-Length` → done, else a `Range: bytes=0-0` probe. `Content-Type` is not checked. A missing `Content-Range` is tolerated (`windowOf`) as long as `Content-Length` is readable, which it always is: it is a CORS-safelisted response header. `Accept-Ranges` is not safelisted, so a bucket that does not expose it (4DN) sends a browser down the one-byte probe path — one extra request per open, then the same source. |
| `handleFor` | `src/annotations/worker/annotations.worker.ts:853-869` | The **second** remote path — bigWig, bigBed, BAM, tabix — through `generic-filehandle2`'s `RemoteFile` with a `fetch` override that signs. It shares nothing with `RemoteRangeSource`: no LRU, no §12 counter, no compression refusal. |
| `ConnectedFolder` | `src/browse/folder.ts:94-116` | `{ id, label, kind: 'local' \| 'bucket', root, durable, list(path), pick(entry) }`. Two backends, a directory and a key prefix; `kind` is the only closed part. |
| `DEMO` | `src/ui/examples.ts:113-167` | Four workspace URLs on the lab's bucket, resolved against `DEMO_BUCKET` at build time. The only catalogue. |
| `?config=` and `#session=` | `src/embed.ts:101-122`, `src/app/Session.ts:1821-1851`, `src/state/shareLink.ts` | The pointer form and the payload form of a session. A `?config=` is one `GET`, signed when a scope covers it, with relative names resolved against the file's own URL (`resolveConfig`). |

Two consequences worth stating before the options:

- **Anything reachable as `https://` with ranges and CORS already opens.** There is no allow-list
  of hosts and no host-specific code. That is why 4DN and ENCODE work unannounced.
- **There is no URL rewriting anywhere.** A pasted Dropbox or Drive link fails at the `HEAD` with
  the generic CORS message, which is accurate and unhelpful.

## 2. Measured: which public hosts work as pasted

All against the live hosts, with an `Origin:` header set so the answer is what a browser sees.

| Host | Ranges | CORS | Exposes `Content-Range` | Verdict |
|---|---|---|---|---|
| `4dn-open-data-public.s3.amazonaws.com` | `206`, `Accept-Ranges: bytes` | `*`, preflight allows `range` | no (only `ETag`) | **Opens.** Neither `Accept-Ranges` nor `Content-Range` is exposed, so a browser takes the one-byte probe path and learns the size from `Content-Length`, which is safelisted; `windowOf` copes without `Content-Range`. `Content-Type` is `binary/octet-stream`, which nothing checks. Listing is public: 72,973 keys, 39,800 of them under `wfoutput/`. |
| `encode-public.s3.amazonaws.com` | `206`, `Accept-Ranges: bytes` | `*`, preflight allows `range` | yes | **Opens.** Listing is public. The portal host `www.encodeproject.org` could not be reached from this environment (egress policy), so `@@download` redirects and the search API were not measured here; igv.js loads both from the browser, so both are known to answer CORS. |
| `hicfiles.s3.amazonaws.com` (Aiden Lab) | `206` — to an `IGV` user agent | `*` | — | **Does not open in any browser.** The bucket lists publicly, but its objects answer `403` unless the `User-Agent` starts with `IGV`, which a browser cannot send (§3.2). Not a bucket configuration this viewer can meet; juicebox.js itself needs a proxy for it. |
| `storage.googleapis.com/<bucket>/<object>` (GCS XML host) | `206` | **none** unless the bucket has a CORS policy | — | Same rule as S3: the owner must set CORS. The Broad public-references bucket has none. |
| `storage.googleapis.com/storage/v1/b/<b>/o/<o>?alt=media` (GCS JSON API) | `206` | echoes the origin, exposes `Content-Length` and `Content-Range` | yes | **Opens as pasted**, for a public bucket with no CORS policy at all. A `gs://` rewrite would make GCS work everywhere. |
| `www.googleapis.com/drive/v3/files/<id>?alt=media` | (403 without a key) | echoes the origin; preflight allows `range,authorization` | — | Needs `key=<API key>` for a public file, `Authorization: Bearer` for a private one. The transport is fine. |
| `dl.dropboxusercontent.com` | not measured (egress policy) | | | igv-utils and hic-straw swap the host of a `www.dropbox.com` share link to this one and nothing more; it serves ranges with CORS `*` and needs no credential. Unverified here. |
| `s3.amazonaws.com/igv.org.genomes/genomes.json` | — | `*`, exposes `Content-Range` | — | The igv.js genome registry: a plain JSON on a public bucket. The shape a *hub* takes in that ecosystem. |

### 2.1 The browser runs

On this branch, dev server, headless Chromium, no code changes:

| What | Result | Requests to S3 | Bytes read | Time to table |
|---|---|---|---|---|
| `#uri=…/4DNFIOKRZ21H.mcool` (2.19 GB, 13 resolutions) | chromosomes table, 24 sequences, 3,088 Mb, redirected to `::resolutions/1000` | 13 (1 `HEAD`, 12 `206`) | 11.5 MB | 7.8 s |
| `#uri=…/4DNFIM7ZVQOQ.hic` (839 MB) | chromosomes table, 24 sequences | 6 (1 `HEAD`, 5 `206`) | 22.0 MB | 6.7 s |
| `?config=<workspace.json>` naming the `.mcool` at `::resolutions/25000`, `chr2:100000000-112000000`, balanced, log10 | the window, 480 × 480 bins, effective resolution 25 kb, 11.99 Mb | 19 | 17.8 MB | — |

The `.hic` reads twice the bytes in half the requests, which is the §3.6 trade stated in SPECS: a
`.hic` block index is one contiguous read where an HDF5 chunk index is several.

### 2.2 The 4DN open-data bucket, by extension

72,973 objects under `fourfront-webprod/`: 39,800 processed files under
`wfoutput/<uuid>/<accession>.<ext>`, one folder per file, and 33,173 raw submissions under `files/`
(27,357 `.gz` and almost nothing else), which is why a catalogue only ever walks `wfoutput/`:

| Extension, under `wfoutput/` | Files | Size |
|---|---|---|
| `mcool` | 1,166 | 2.71 TB |
| `hic` | 1,182 | 3.31 TB |
| `cool` | 19 | 0.18 TB |
| `bw` | 5,327 | 0.67 TB |
| `bb` | 722 | — |
| `px2` (pairs indexes) | 4,281 | 0.05 TB |
| `gz` (pairs, mostly) | 10,011 | 22.2 TB |
| `bam` | 9,976 | 209 TB |

Every one of the 2,367 maps is openable by URL today. None of them has a name: the bucket knows
`4DNFIOKRZ21H.mcool`, and the portal knows it is a Hi-C of a particular cell line, assembly and lab.
That is the whole gap, and it is a metadata gap. The portal's JSON API carries an
`open_data_url` calculated property per file (`fourfront/src/encoded/types/file.py`,
`open_data_url()`), which is the join.

## 3. What juicebox.js supports, and how

Read from the sources at their 2026-09-10 heads: `igvteam/juicebox.js` 4.4.0, `igvteam/juicebox-web`
2.6.0 (the app at aidenlab.org/juicebox and igv.org/juicebox), `aidenlab/hic-straw` 4.0.0 (the
`.hic` reader), `igvteam/igv-utils` 1.8.4 (the transport igv.js and the track layer share),
`igvteam/igv-data` (the catalogues). The paper — Robinson et al., *Cell Systems* 2018 — lists "any
standard file server, and … Amazon S3, Dropbox, and Google Drive" and says the app is "designed to
automatically connect to ENCODE servers"; the code today is narrower on Google Drive and wider on
4DN.

### 3.1 The byte layer

- **The contact map** is read by hic-straw's `src/io/remoteFile.js`: one `fetch` per block with a
  `Range` header, `mode: 'cors'`, `redirect: 'follow'`; an optional `Authorization: Bearer` from
  `config.oauthToken` (a string, or a function returning one); `config.headers` merged in; and a
  `mapUrl` hook (`hic.setUrlMapper`) applied to every URL before it is fetched, with the
  *unmapped* URL going into the session. That is the whole transport: no Google or GCS
  translation, no API key, no proxy.
- **Tracks and 2D annotations** go through igv-utils `igvxhr.js`: `XMLHttpRequest` with
  `Range`; per-request `oauthToken`, `headers` and `withCredentials`; **host-scoped tokens**
  (`setOauthToken(token, host)`, matched as a wildcard pattern such as `*.myinstitute.org`);
  `setApiKey`; a `corsProxy` (`igv.setCORSProxy`) tried once as `proxy?url=…` when a request
  fails with status 0; a retired-URL table (`igv.org/data/url_mappings.tsv`) consulted after a
  403/404/410; and an 8 requests-per-second throttle on Drive and Dropbox hosts.

### 3.2 Provider by provider

| Provider | What juicebox.js / igv-utils actually do | Verified where |
|---|---|---|
| Dropbox | A **host swap only**: `//www.dropbox.com` → `//dl.dropboxusercontent.com`, in both hic-straw and igvxhr. There is no `dl=0` → `dl=1` rewrite anywhere in the five repositories. The app's *Dropbox File* menu is the Dropbox Chooser (`dropins.js`, app key in the HTML, `linkType: 'preview'`), whose links then take the swap. | `igv-utils/src/igvxhr.js:582-591`, `hic-straw/src/io/remoteFile.js`, `juicebox-web/js/contactMapLoad.js:47-66` |
| Google Drive | igvxhr recognises only the API form `www.googleapis.com/drive/v3/files/<id>` and then "always require[s] oAuth" (`drive.file` scope), adds `key=` and `supportsAllDrives=true`, and retries once with a fresh token on 401/403/404. The share-link conversion (`drive.google.com/file/d/<id>` → API URL) and the Google Picker existed in igv-utils ≤ 1.5.x and are gone from master. **juicebox-web has dropped Drive**: "Google Drive paths are intentionally omitted — juicebox-web does not enable Google integration." igv.js warns that Drive URLs in a shared session "will not work when shared". | `igvxhr.js:168-177, 368-389, 543-573`, `juicebox-web/js/widgets/fileLoad.js:4-5`, `igv.js/js/util/sessionResourceValidator.js:16-17` |
| Google Cloud Storage | `gs://`, `storage.cloud.google.com/…` and `storage.googleapis.com/<b>/<o>` are all rewritten to the JSON-API media URL `…/storage/v1/b/<bucket>/o/<object>?alt=media` (object percent-encoded), with `key=` and a token on demand; a signed URL (`X-Goog-Signature`) passes through untouched. Tracks only — hic-straw does none of this. | `igv-utils/src/google-utils/googleUtils.js:7-73`, `igvxhr.js:489-491` |
| Amazon S3 | Plain `https://` only. **`s3://` is not supported**, nor requester-pays. A `RETIRED_HOSTS` table remaps old Broad hosts, and the session codec expands shortcuts `*s3/`, `*s3e/` (the Aiden Lab bucket) and `*enc/` (`www.encodeproject.org/files/`). | `igvxhr.js:611-617`, `juicebox.js/js/normalizeSession.js:323-329` |
| Aiden Lab (`hicfiles.s3.amazonaws.com`) | The bucket serves `403` unless the `User-Agent` starts with `IGV` — "No browser can comply: `User-Agent` is a forbidden header name". **Reproduced here**: the same object answers `403` to a Chrome user agent and `206` to `IGV/2.19.1`. juicebox.js ships a *development-only* Vite proxy for it; how the production site reads these 571 maps was not established from here. | `juicebox.js/README.md:179-187`, `docs/adr/0001-dev-proxy-for-waf-protected-hosts.md`; measured 2026-09-11 |
| ENCODE | `https://www.encodeproject.org/files/<acc>/@@download/<acc>.hic` → `307` to a presigned URL on `encode-public`; the portal's Apache config sets `Access-Control-Allow-Origin "*"`, allows `Range`, exposes `Content-Length, Content-Range, Content-Type`. The file JSON's `cloud_metadata.url` is the same object unsigned. | `ENCODE-DCC/encoded/src/encoded/types/file.py:613-633, 1059-1098`, `ENCODE-DCC/snovault/etc/snovault-apache.conf:54-62` |
| 4DN | Open-data S3 URLs only. `@@download` calls `check_user_is_logged_in` and 307s to a presigned URL, so an anonymous browser must use `open_data_url` — which is what the portal's own **"Visualize with JuiceBox"** button does: `aidenlab.org/juicebox/?hicUrl=<open_data_url>`. | `4dn-dcic/fourfront/src/encoded/types/file.py:867-896, 1553-1670`, `src/encoded/static/components/item-pages/FileView.js:251-306` |
| htsget | Reads and variants only (igv.js `htsgetReader.js`). Not a contact-map transport. | `igv.js/js/htsget/htsgetReader.js` |

### 3.3 The menus — this is what "pre-connected" means there

`juicebox-web/js/juiceboxConfig.js` is the entire server configuration of the site:

```js
genome:      'https://igv.org/genomes/genomes3.json',
mapMenu:     { items: 'res/hicfiles.json' },
trackMenu:   { items: 'https://hicfiles.s3.amazonaws.com/internal/tracksMenu_$GENOME_ID.txt' },
trackMenu2D: { items: 'https://hicfiles.s3.amazonaws.com/internal/tracksMenu_2D.$GENOME_ID.txt' },
trackRegistryFile: 'res/tracks/encodeRegistry.json',
```

and the *Load Contact Map* menu has six entries: **Select Contact Map** (Aiden Lab), **ENCODE**,
**4DN**, Local File, Dropbox File, URL. Each of the first three is a **static catalogue**:

| Menu | Source | Rows | Shape |
|---|---|---|---|
| Aiden Lab | `public/res/hicfiles.json`, shipped with the app | 571 | JSON keyed by URL: `NVI`, `name`, `author`, `journal`, `year`, `organism`, `reference genome`, `cell type`, `experiment type`, `protocol`. Each row opens `<url>?nvi=<NVI>`. |
| ENCODE | `igv-data/data/encode/hic.txt`, fetched from `raw.githubusercontent.com` at runtime | 176 | TSV: `HREF Assembly Biosample Description BioRep TechRep Lab Accession Experiment`; `HREF` is the portal's `@@download` path. 125 hg19, 33 GRCh38, 18 mm9. |
| 4DN | `igv-data/data/4dn/4dn_hic.txt`, likewise | 606 | TSV: `url Project Assembly Biosource Assay Replicate Dataset Description Lab Publications Accession Experiment`; every `url` is an open-data S3 URL. 429 GRCh38, 126 GRCm38, 40 galGal5, 9 GRCz11, 2 dm6. |

Both portal tables are produced **offline** by `igv-data/scripts/updateEncode.py` and
`update4DN.py`, which query the portals' search APIs once (`format=json&limit=all`, keeping
`processed_files[].open_data_url` for 4DN and `files.href` for ENCODE) and commit the result.
**juicebox.js does not talk to ENCODE or 4DN live**; it ships a menu somebody regenerated. The
track menus are `label<TAB>url` text files on the Aiden Lab bucket, and the ENCODE track tables
are pre-built TSVs on `s3.amazonaws.com/igv.org.app/encode/`. A static `js/nvi.js` table maps
known URLs to their normalisation-vector index so a menu entry skips one read — the same idea as
G10's per-file metadata and this viewer's `?edges=` sidecar.

That is shape A plus shape C of §5, and nothing else. The interesting consequence for this
viewer: 4DN publishes each experiment set as `.hic` *and* `.mcool` (1,182 and 1,166 on the
bucket), juicebox.js reads only the first, and this viewer reads both — so a 4DN hub here is not
smaller than juicebox's.

### 3.4 Sessions and links

- **Written form**: `?session=blob:<BGZip-compressed, base64url session JSON>` — the only form
  juicebox writes; `session=<url>` is fetched and sniffed. Legacy read-only forms: `hicUrl=&name=&state=&colorScale=&tracks=&nvi=…`,
  `?juicebox={…}` and `?juiceboxData=`; the bit.ly `juiceboxURL=` was removed in August 2026.
  Short links go through TinyURL with an API key (`t.3dg.io`). A local file serialises to `null`
  and is dropped, as `forSharing` drops one here. (`juicebox.js/docs/url.md`, `js/sessionCodec.js`.)
- **Session files**: the same JSON, saved and reloaded from Local File / Dropbox / URL through
  `hic.restoreSession`; `embed.html` reads the same `session=`.
- **A session registry**: igv-webapp's `sessionRegistryFile` is
  `{"sessions": [{"label", "description", "url"} | {"label"} (a section header)]}`, rendered as
  a menu — a hub of sessions. igv.js also takes `sessionURL=`, `hubURL=` (a UCSC `hub.txt`) and a
  `genomes` registry URL. (`igv-webapp/resources/sessions/sessionRegistry.json`, `js/widgets/sessionWidgets.js:73-83`.)
- **Accession short links**: `https://jb.3dg.io/ENCFF…` and `/4DNF…` are a Cloudflare Worker
  that queries the portal API and 302s to `?hicUrl=`. That is a server-side component, which C1
  refuses here; a hub keyed by accession gives the same link without one.

### 3.5 The comparison, in one table

| | juicebox.js | this viewer today |
|---|---|---|
| Formats over the network | `.hic` | `.hic`, `.cool`, `.mcool`, `.scool`, `.metacool`, HiC-Pro, `.pairs` |
| Plain HTTPS with ranges and CORS | yes | yes, with the compression refusal and the whole-object fallback |
| Private buckets | no (a bearer token per host, supplied by the page) | SigV4 signing per prefix, browsing, stored-data accounting |
| Presigned S3 URLs | yes (no `HEAD`) | refused at the `HEAD` (§11) |
| Dropbox | host swap + Chooser | nothing |
| Google Drive | API form + forced OAuth (tracks); dropped from the app | nothing |
| GCS | `gs://` rewrite (tracks) | nothing, but the JSON-API URL works as pasted |
| `s3://` | no | no |
| ENCODE / 4DN / Aiden Lab menus | static catalogues, 176 / 606 / 571 rows | four demo workspaces |
| Live portal search | no | no |
| Share link | `?session=blob:` + TinyURL | `#session=` + is.gd, `?config=`, `#uri=` |
| Session registry | igv-webapp only | no |
| CORS proxy hook | `setCORSProxy` (tracks) | none, by C1 |

## 4. Provider by provider: what each would require

The cost column is an estimate of code in this repository, on the seams of §1, with tests.

### 4.1 Dropbox — a rewrite, no credential

A Dropbox share link (`https://www.dropbox.com/s/<id>/<name>?dl=0`, or the newer
`/scl/fi/<id>/<name>?rlkey=…&dl=0`) is an HTML page. The same path on
`dl.dropboxusercontent.com` is the file, with ranges and CORS `*`. That host swap is the whole
of what igv-utils and hic-straw do (§3.2), and it has been enough for them since 2018.

- **Change:** one pure function `canonicalUrl(url)` applied where a URL enters — the picker's URL
  box, `resolveConfig`, the Tracks card, `#uri=` — before `inferSource`. The hash then carries the
  rewritten URL, so a shared link is already the working form.
- **Seams:** `src/app/resolve.ts` (or a new `src/sources/rewrite.ts` it imports), plus the four
  URL boxes. Nothing in the worker.
- **Cost:** small. Table-driven tests on the two link shapes.
- **Risk:** Dropbox has changed its share-link format twice; the rewrite is a table, and a link it
  does not recognise must pass through untouched.

### 4.2 Google Drive — a rewrite plus an API key, and a token for private files

`https://drive.google.com/file/d/<id>/view` is a page. The file is
`https://www.googleapis.com/drive/v3/files/<id>?alt=media`, and the API refuses that without a
`key=` (measured: `403 The request is missing a valid API key`). With a key, a **public** file is
range-readable cross-origin — the preflight allows `range` and `authorization`, and
`Content-Length` is exposed. A **private** file additionally needs `Authorization: Bearer <OAuth
token>` on every request.

- **Change:** the rewrite of §4.1 for the two Drive link shapes; a per-host **header bag** on the
  remote arm of `SourceLocation` (`{ kind: 'remote', url, credential?, headers? }`), applied in
  `fetchRange`, in `open`'s `HEAD`, and in `handleFor`'s fetch override — the same three places
  the SigV4 headers go; an API key kept like a bucket scope (a `localStorage` row, shown in the
  stored-data screen). Presenting the key as a query parameter (`key=`) rather than a header keeps
  the request *simple* in the CORS sense and avoids a preflight per range read.
- **For private files:** an OAuth 2 token obtained client-side (Google Identity Services, implicit
  flow, `drive.readonly` scope), which needs a **client id** registered for the app's origin —
  a Google Cloud project owned by the lab, not a server. igv-webapp ships one; juicebox-web has
  taken Drive out altogether (§3.2), and igv-utils forces OAuth even for a public file. The
  token lives in memory, expires in an hour, and the Drive API's per-project quota applies.
- **Seams:** `resolve.ts`, `protocol.ts`, `RemoteRangeSource.ts`, `annotations.worker.ts`,
  `s3/attach.ts` (generalised to "attach whatever this URL needs"), `credentials.ts` (a second
  row kind), `stored.ts`.
- **Cost:** medium for public-with-key; medium again for OAuth, most of it UI and the
  stored-data accounting. **Not available in the standalone build** (§19: opaque origin, no
  redirect URI) — the same rule that already hides the bucket half there.
- **Risk:** Drive throttles ranged reads on large files and has a daily quota per project; a
  contact map is thousands of range requests per session. The rewrite is worth having; making
  Drive the *recommended* host is not. `docs/hosting.md` should say so.

### 4.3 Google Cloud Storage — a `gs://` scheme, free

A public object is readable *today* through the JSON-API media URL with no bucket configuration,
because that endpoint answers CORS for every origin (measured). The XML host does not, unless the
bucket owner sets a policy, exactly as on S3.

- **Change:** `gs://<bucket>/<object>` → `https://storage.googleapis.com/storage/v1/b/<bucket>/o/<url-encoded object>?alt=media`
  in the rewrite table; `inferSource` learns the scheme so it can travel in a link. Private
  buckets take the same bearer token as §4.2 (scope `devstorage.read_only`).
- **Cost:** small. It is one more row in the rewrite table and one regex in `inferSource`.
- **Browsing, and private buckets:** the XML host answers the exact query `s3/list.ts` sends —
  `list-type=2`, `delimiter`, `prefix`, `max-keys` — with S3's element names, a `KeyCount` and a
  `NextContinuationToken` (measured on a public bucket), so the existing lister parses it. GCS also
  accepts AWS-style SigV4 with HMAC interoperability keys, which would make a private GCS prefix an
  ordinary bucket scope with no new code; not measured here. Both need a bucket CORS policy, because
  the XML host sends no CORS headers without one — the JSON-API endpoint does, but it is not what
  the lister speaks.

### 4.4 Azure Blob Storage — nothing, or a SAS in the query string

A public container serves ranges; CORS is set per storage account. A **SAS token** is a query
string that is not scoped to one method, so — unlike a presigned S3 URL — the `HEAD` probe passes
and the URL works as pasted, expiring when the SAS does.

- **Change:** none for the byte layer. A note in `docs/hosting.md`. If a lab wants *browsing*,
  the container listing (`?restype=container&comp=list`) is a third `ConnectedFolder` backend of
  the size of `browse/bucket.ts`.

### 4.5 S3-compatible stores, presigned URLs and `s3://`

- **Any S3-compatible endpoint already works** for reading: a scope is a URL prefix, and
  `addressOf` understands both virtual-hosted and path-style addresses (R2, MinIO, Ceph). What is
  missing is a way to write `s3://bucket/key` — a scheme `inferSource` refuses. Resolving it needs
  an endpoint and a region, which is exactly what a scope holds; a `s3://` URI could resolve
  against the scope whose bucket matches, and otherwise against `https://<bucket>.s3.amazonaws.com/`.
- **Presigned URLs** fail at the `HEAD` because the signature is for `GET` (§11). The open probe
  could recognise `X-Amz-Signature` in the query and skip straight to the `Range: bytes=0-0` probe,
  which is what `open` already does when `HEAD` says nothing. Two lines and a test; it turns a
  documented refusal into a supported case for links that expire.

### 4.6 A plain HTTP directory — a third folder backend

Many institutional data servers are Apache or nginx with `autoindex`. A `ConnectedFolder` over an
HTML or JSON index (`nginx` can emit `autoindex_format json`) is one backend of the size of
`browse/bucket.ts`; the files it lists open through the existing remote path. This is the cheapest
way to make "my institute's download server" browsable, and it fails the same way S3 does when
the host has no CORS.

### 4.7 htsget

Not applicable: htsget serves reads and variants by region, not byte ranges of a matrix. The BAM
lane could take a `htsget://` source one day; nothing here depends on it.

## 5. "Pre-connect" to a server: the four shapes, and one to build first

The phrase covers four different things, and they compose.

### A. A hub: a static catalogue of maps and sessions

A JSON file on any CORS-enabled host — a lab bucket, GitHub raw, the 4DN bucket itself — listing
maps and workspaces with names and enough metadata to choose one without opening it. This is
what `DEMO` in `examples.ts` is, made into a file:

```json
{
  "kind": "metacooler.hub",
  "version": 1,
  "name": "4DN open data — Hi-C and micro-C",
  "base": "https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/",
  "columns": ["assembly", "biosource", "assay", "lab"],
  "entries": [
    {
      "label": "Hi-C, GM12878, in situ (Rao 2014 reprocessed)",
      "uri": "00034edc-e0dc-45b1-b2a1-7db3a13ef869/4DNFIOKRZ21H.mcool",
      "kind": "map",
      "size": 2191787975,
      "fields": { "assembly": "GRCh38", "biosource": "GM12878", "assay": "in situ Hi-C", "lab": "Dekker" },
      "note": "4DNESVKLYDOL",
      "session": "sessions/4DNFIOKRZ21H.metacooler.json",
      "tracks": [{ "label": "CTCF ChIP", "url": "…/4DNFIK9NBYGJ.bw" }]
    }
  ]
}
```

- **Offered where the demos are, as a table rather than a tree.** Six hundred rows are chosen by
  *filtering* — assembly, biosource, assay, lab — and then sorting, and `FolderListing` has nowhere
  to put a biosource; forcing a hub through `ConnectedFolder.list()` would draw the flat folder of
  opaque accessions that juicebox deliberately does not show. So a hub declares its `columns`, each
  entry carries `fields`, and the picker renders a filterable table that ends in the same
  `PickedFile` a folder row does. It is addressable as `?hub=<url>` so a lab can send colleagues a
  link that lands on *its* shelf, and a remembered hub is one more row kind in the stored-data
  screen, beside bucket scopes — connected by pasting a URL, exactly as a bucket is.
- **A row carries its byte size**, so the load gate can ask its question before the first request
  rather than after the `HEAD`, and a table can warn about the 5 GB row before it is clicked.
- **Entries carry relative names resolved against `base`**, as workspaces already do against their
  own URL, so a hub can be copied with its data.
- **A hub entry may point at a session**, not only a file: `session` is a `.metacooler.json`,
  opened through the `?config=` path that already exists. That is the "pre-configured session".
- **Cost:** small-to-medium. A parser with a `ConfigRefusal`-style result, a picker section, a
  `?hub=` mounting parameter beside `?config=`, a `localStorage` row kind, tests. No worker
  change. It is GAPS G10 with a different emphasis — G10 describes the file, this describes
  where the viewer offers it.
- **Constraint check:** C1 holds (a static file), C5 holds (a public object), C3 holds (a map with
  no hub still opens). The standalone build can read a hub the way it reads nothing remote:
  not at all, and says so.

### B. Live search over a portal's API

An adapter that queries `https://data.4dnucleome.org/search/?type=FileProcessed&file_format.file_format=mcool&format=json`
or `https://www.encodeproject.org/search/?type=File&file_format=hic&status=released&format=json`
from the browser, shows the hits as a table (cell line, assay, lab, assembly), and opens the
`open_data_url` (4DN) or `cloud_metadata.url` / `href` (ENCODE) of the chosen row.

- **Needs the portal to answer CORS**, which was not measurable from this environment. ENCODE's
  does: its Apache configuration sets `Access-Control-Allow-Origin "*"` and answers `OPTIONS`
  (§3.2). 4DN's is unverified — nothing in the fourfront or snovault sources sets a CORS header,
  so it would be a web-tier setting — and if it does not, the adapter cannot exist without a
  proxy, which C1 refuses, and shapes A and C are the whole answer for 4DN. Note that juicebox.js
  does not do this for either portal; it ships the generated tables.
- **It produces a hub, not a folder.** A query's hits are rows with fields, so the adapter fills
  the same table shape A renders and ends in the same `PickedFile`. Mapping it onto
  `ConnectedFolder.list()` was the first draft here and is wrong for the reason given under A: a
  hit has a biosource, and a folder row has a name. §20.1's one-level rule maps onto a paged query.
- **Cost:** medium per portal; each portal's facet vocabulary is its own. Tests against recorded
  responses.
- **Outcome (2026-09-11):** built as `state/portal.ts` and `ui/PortalSearch.ts`, then withdrawn.
  From the deployed preview, 4DN's portal answered the search with no `Access-Control-Allow-Origin`
  — the case above: the browser discards the response and reports nothing, and there is no proxy
  to reach for. ENCODE answered, and a form that worked for the one portal whose files the
  generated hub already lists did not earn its place on the picker. Shapes A and C are the whole
  answer; SPECS §24.4 records the withdrawal.

### C. Sessions generated from the portal, offline

The join that shape A needs — accession to cell line, assay, assembly, lab — is a script's job,
not the browser's: a `scripts/make_hub.py` (the `make_catalog.py` M8 already promises, aimed at a
portal rather than a bucket) that queries the portal API once, writes the hub of shape A, and
optionally a `.metacooler.json` per map with a sensible landing view and the bigWigs the same
experiment set published beside it. Published to the lab bucket, it is a hub anybody can point
`?hub=` at, and it needs no CORS from the portal at all.

- **Cost:** a script and a workflow to refresh it. The 4DN census in §2.2 is two-thirds of it,
  and `igv-data`'s two tables (§3.3, MIT-licensed) are a ready seed: 606 4DN `.hic` rows with
  biosource, assay, lab and assembly already joined, and 176 ENCODE rows — plus the 1,166 `.mcool`
  twins on the 4DN bucket that juicebox.js has no use for and this viewer does. Seed from them
  offline; do not fetch them at runtime. A hub that hot-links another project's data file inherits
  that project's release cadence and schema, and the point of the format is that the viewer owns
  what it offers.

### D. Being linked *from* the portal

The other direction: juicebox.js is reachable from 4DN because 4DN builds a link to it — the
portal's *Visualize with JuiceBox* button is `aidenlab.org/juicebox/?hicUrl=<open_data_url>`
(§3.2). The viewer already has the two link forms a portal would need — `#uri=<open-data-url>`
and `?config=<url>` — and a build pinned at `/v/<commit>/` for a link that must render the same
picture in five years. Nothing to build; something to ask the 4DN DCIC for once shapes A–C make
the viewer worth linking to. The accession short-link worker juicebox runs (`jb.3dg.io`, §3.4) is
the one piece of that arrangement C1 rules out; a hub entry keyed by accession is its static twin.

### The order

0. **Say what already works.** R2, MinIO, Ceph, Azure with a SAS, and GCS through its JSON-API URL
   open today, and neither the README nor `docs/hosting.md` says so; "supports S3" reads as one
   vendor when what is supported is object storage. Hours, and the cheapest win on this list.
1. **A + C**: the hub format, `?hub=`, the table in the picker, and the generator script with two
   generated hubs (4DN open data; ENCODE released `.hic`). This is what turns "2,367 openable
   files" into "a menu of named experiments", and it is the one item that reaches every reader.
2. **§4.5** (presigned URLs, `s3://`) and **§4.3** (`gs://`): a few lines each on `resolve.ts` and
   `RemoteRangeSource.open`.
3. **B** for ENCODE (known CORS) and for 4DN if its API allows it.
4. **§4.1 and §4.2** (Dropbox, Drive with a key): the rewrite table and the header bag.
5. **OAuth** for Drive and GCS private files — last, because it needs a registered client id
   and a UI for a credential that expires, and because a lab with private data on Drive is better
   served by the bucket path the app already has.

## 6. Constraints check

- **C1, no server-side component.** A hub is a file; a portal adapter is a browser-side query;
  an OAuth client id is a registration, not a service. A CORS proxy for portals that refuse CORS
  is the one thing on this list that would break C1, and it is refused: a portal without CORS gets
  shape C.
- **C5, static hosting.** Every URL a hub names is an object on somebody's bucket. A Drive file is
  an object on Google's, read through Google's API; the reasons not to *recommend* it are quota and
  throttling, not the constraint.
- **§11, private files never leave the machine.** Unchanged. An OAuth token is the reader's own,
  held in memory, and reads go from Google to the browser. A hub fetch reveals only that somebody
  opened the viewer, which the demos already do — and it should happen **on a gesture, not on
  load**, so a reader who never opens the shelf makes no third-party request at all.
- **§13, no accounts.** The app still has none. Signing in to Google to read one's own Drive is
  the reader's account with Google, which is the same bargain a bucket key already makes, stated
  at `docs/hosting.md` under *The key is in the browser*.
- **§19, the standalone build.** Hubs, portals and OAuth are all absent there, for the reason the
  bucket half already is.

## 7. What each phase touches

| Phase | Files | Tests |
|---|---|---|
| Say what already works | `README.md`, `docs/hosting.md`; a 4DN open-data example beside the demos | `demo-examples.test.ts` |
| Hub format and `?hub=` | new `src/state/hub.ts` (parse, `columns` and `fields`, resolve against `base`, `ConfigRefusal`), new `src/ui/HubTable.ts` (a filterable table ending in `PickedFile`), `src/embed.ts` (`hub` beside `config`), `src/ui/FilePicker.ts`, `src/ui/examples.ts` (the four demos become the built-in hub), `src/state/stored.ts`, `src/app/App.ts` `restore()` | `test/unit/hub.test.ts` (parse, relative names, refusals), a DOM test for the table's filters, `demo-examples.test.ts` extended to the built-in hub |
| Generator | `scripts/make_hub.py` (4DN and ENCODE queries → hub JSON, optional per-map workspaces) | a fixture response per portal |
| Presigned and `s3://`, `gs://` | `src/app/resolve.ts`, new `src/sources/rewrite.ts`, `src/sources/RemoteRangeSource.ts` (skip `HEAD` on `X-Amz-Signature`) | `resolve.test.ts`, `remote-open.test.ts` |
| Portal adapter | new `src/browse/portal.ts` (`ConnectedFolder` of kind `'portal'`), `src/browse/folder.ts` (widen `kind`), `src/browse/connected.ts`, `src/ui/ConnectCard.ts` (a third section) | `browse-folders.test.ts` with recorded responses |
| Dropbox and Drive | `src/sources/rewrite.ts`, `src/worker/protocol.ts` (`headers?`), `src/sources/RemoteRangeSource.ts`, `src/annotations/worker/annotations.worker.ts`, `src/s3/attach.ts` → a general `attach.ts`, `src/s3/credentials.ts` (API-key row), `docs/hosting.md` | `rewrite.test.ts`, `remote-open.test.ts` (headers on `HEAD` and on ranges) |
| OAuth | new `src/auth/google.ts`, `src/ui/ConnectCard.ts`, `src/state/stored.ts` | DOM tests with a stubbed token client |

## Appendix: how the measurements were taken

Headers, with an origin so the CORS answer is the browser's:

```bash
U=https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/00034edc-e0dc-45b1-b2a1-7db3a13ef869/4DNFIOKRZ21H.mcool
curl -sSI -H 'Origin: https://js2264.github.io' "$U"
curl -sS -o /dev/null -D - -H 'Range: bytes=0-1023' -H 'Origin: https://js2264.github.io' "$U"
curl -sS -o /dev/null -D - -X OPTIONS -H 'Origin: https://js2264.github.io' \
  -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: range' "$U"
```

The census walks the bucket with `list-type=2` and continuation tokens (74 pages of 1,000 across
the two prefixes), parsing each `<Contents>` block on its own. That last clause is a pitfall worth
recording for `make_hub.py`: newer objects carry a `<ChecksumAlgorithm>` element between `ETag`
and `Size`, and a regex that assumes the four-element order silently drops them — a first pass here
undercounted every category by about a quarter for exactly that reason. The
browser runs drive the dev server with Playwright's Chromium, counting responses from the S3 host
and reading the DOM for the chromosomes table or the error view; the workspace for the `?config=`
run was the demo shape with `state.uri` set to the `.mcool` at `::resolutions/25000`.

Two hosts could not be reached from the environment the measurements were made in
(`data.4dnucleome.org`, `www.encodeproject.org`, `hicfiles.tc4ga.com`, `dl.dropboxusercontent.com`
were refused by its egress policy), which is why the portal APIs and Dropbox are marked unverified
above rather than measured.
