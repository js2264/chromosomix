# Deploying the viewer to GitHub Pages

The app is a static bundle — no backend, no server-side rendering, no API (SPECS C1) — so hosting it
is a file copy. `.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist/`
through the official Pages actions.

**What is published is the app, five demo datasets and ten track resources** (see below). Real datasets are served from a
bucket configured per [hosting.md](hosting.md); nothing under `data/` is committed or uploaded, and
a dropped local file still never leaves the browser.

## One-time setup

1. Create the GitHub repository and push `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Without this the workflow
   runs and the `deploy` job fails at the last step; Pages will not enable itself.
3. Push (or run the workflow manually from the Actions tab). The site appears at
   `https://<owner>.github.io/<repo>/`.

Nothing else is required: no secrets, no tokens. The workflow authenticates with the OIDC identity
GitHub mints for it, which is what `id-token: write` in the permissions block is for.

## The base path is decided at build time

Vite bakes absolute asset URLs into `index.html` and into the worker's `new URL(...)` — including
`/assets/reader.worker-*.js`, which is resolved by the browser, not by the bundler. A project site
is served from `/<repo>/`, so a build made for `/` loads a blank page there with three 404s.

The workflow therefore resolves the base itself before building:

| Situation | Base |
|---|---|
| Project site (`<owner>.github.io/<repo>/`) | `/<repo>/` |
| User or org site (repo named `<name>.github.io`) | `/` |
| Custom domain (a `public/CNAME` file exists) | `/` |
| Anything else | set the `BASE_PATH` repository variable (Settings → Secrets and variables → Actions → Variables) and it wins over all of the above |

To reproduce a Pages build locally, pass the same value:

```bash
BASE_PATH=/<repo>/ npm run build
BASE_PATH=/<repo>/ npm run preview   # then open http://localhost:4173/<repo>/
```

`preview` needs the variable too: it reads the same `vite.config.ts`, and without it the server
mounts at `/` while the bundle asks for `/<repo>/assets/...`. Its 404 fallback answers those
requests with `index.html` and a `200`, so the mismatch shows up as a blank page rather than as a
missing file.

## The demo files

`public/demo/` holds five published datasets, so the deployed site opens something real without
anyone first standing up a bucket:

| file | data | provenance |
| --- | --- | --- |
| `Mock_microbial_community.metacool` (14 MB) | 49 MAGs over 20,566 contigs, 1 kb bins, 7.1 M pixels | SRA `SRR32680160`, binned with MetaTOR |
| `Mock_microbial_community.mmetacool` (35 MB) | the same map zoomified to 1 / 2 / 4 kb | derived from the metacool above |
| `Yeast_mpneumoniae_G2M.mcool` (17 MB) | 18 contigs (16 yeast chromosomes, the mitochondrion, *M. pneumoniae*), 19.6 M contacts, 1–16 kb | GEO `GSM6703657` |
| `Ecoli.mcool` (46 MB) | one 4.64 Mb chromosome, 111 M contacts, 500 bp – 100 kb | wild type of Bignaud et al., *Nat. Struct. Mol. Biol.* |
| `Yeast_microC_G2M_1kb.cool` (19 MB) | 16 chromosomes of synthetic yeast (`XIII-syn40` carries a 40 kb insertion), 12,118 bins of 1 kb, 13.7 M pixels, 179 M contacts, balanced | mitotic micro-C, Dauban et al., *Science* (DOI `10.1126/science.adm9466`) |

`Yeast_microC_G2M_1kb.cool` is the **single-resolution** cooler in the set: every other map here is
either a metacool or an `.mcool` ladder, so it is what exercises the path where there is no
resolution to choose and no `resolutions/` group to land in. It is one level lifted out of a
seven-level `.mcool` (100 bp – 10 kb) whose finest levels are far too large to publish; 1 kb is the
grid the loop calls below were made on. **The `_1kb` in the name is load-bearing** — read it back
from `bin-size` before renaming it, since an earlier copy of this file was called `_2kb` and was
not.

Vite copies `public/` into `dist/` verbatim, so they land at:

```
https://<owner>.github.io/<repo>/demo/Mock_microbial_community.metacool
```

They are deliberately **same-origin with the app**, which removes one class of failure
[hosting.md](hosting.md) is written about: no CORS preflight, no `AllowedOrigins`, no
`ExposeHeaders`.

It does not remove the rest, and Pages fails one of them. Pages honours `Range`, but it also
**gzips `application/octet-stream`**, which is what it serves every `.metacool` and `.mcool` as — so
ranges address the compressed stream and the reader gets bytes from the wrong offsets. The measured
headers and the reasoning are in
[hosting.md](hosting.md#transfer-compression-breaks-ranges); the short version is that no browser
can opt out, because `Accept-Encoding` is a forbidden header name.

So the demo files here open by a **fallback**: the probe sees `Content-Encoding`, refuses the ranged
path, and the worker downloads the object whole into memory instead (`worker/sources.ts`). A
complete gzip stream inflates correctly, so this works — but it transfers the entire file, which is
the one property the remote path exists to avoid. That is the real reason to keep this directory
small, and the reason **data belongs on a bucket, not on Pages**. Anything a reader is meant to
explore rather than glance at should be published per hosting.md and reached by URL.

Two things to keep in mind:

- The three plain coolers carry no genome layer, and that is deliberate: they are what exercises the
  plain-cooler path on the deployed site — the resolution ladder landing on its finest level, the
  single-resolution file with no ladder at all, and a contig-only view with the genomes table absent
  rather than empty.
- This is ~250 MB in git history and in every Pages artifact, counting the track resources below.
  It is a fixed cost, not a per-release one — keep it that way. New or larger datasets belong on a
  bucket and in the catalog, not here.

They are offered in the example dropdown on the picker (`ui/examples.ts`), with URLs built from
`BASE_URL` and made absolute against the page: the base differs between dev and Pages, and a
*relative* URI in a shared link would not re-open, because `inferSource` follows a link only when
its path is `http(s)://`.

## The track resources

`public/demo/` also carries ten files that are **not maps and are not in the picker**. Nothing reads
them yet: they are published ahead of M6 (bigWig tracks, SPECS §12) and of loop and annotation
overlays, so that when those land there is a real signal to draw beside a real map rather than a
fixture. Every one of them is aligned to `Yeast_microC_G2M_1kb.cool` and is meant to be used with it.

| file | data |
| --- | --- |
| `Yeast_Shotgun.bw` (18 MB) | shotgun DNA-seq coverage — the flat-ish control track |
| `Yeast_MNase.bw` (23 MB) | MNase-seq coverage; nucleosome positioning |
| `Yeast_ATAC.bw` (15 MB), `Yeast_ATAC.narrowPeak` (500 KB) | ATAC-seq accessibility, and 5,105 called peaks |
| `Yeast_ChIP_Pol2-vs-input.bw` (13 MB), `Yeast_ChIP_Pol2-vs-input.narrowPeak` (56 KB) | Pol II ChIP-seq as a **ratio over input**, and 527 called peaks |
| `Yeast_RNA_fwd.bw` (20 MB), `Yeast_RNA_rev.bw` (20 MB) | stranded RNA-seq coverage, forward and reverse as separate files |
| `Yeast_annotations.gtf` (9.5 MB) | R64-1-1 gene models: 7,071 genes and transcripts, 7,419 exons, 6,853 CDS |
| `Yeast_microC_loops.tsv` (115 KB) | 1,506 cis loop calls (chrompeaks-style: two anchors, bin indices, kernel, score, p/q) |

**They are on the map's assembly, not on the reference, and that is the property to preserve.** The
map is a synthetic strain: it has no `Mito`, its chromosome XIII is `XIII-syn40` and 40,000 bp longer
than R64's, and its `III` is 1,095 bp shorter. Every file above was regenerated or lifted to agree
with it, and as published:

- all five bigWigs declare the map's **16 contig names with byte-identical lengths** — no `Mito`, and
  `XIII-syn40` at 964,431. So the intersection SPECS §12 asks for is 16 of 16, and the
  "412 of 418 contigs matched" report has nothing to complain about.
- the GTF, both `.narrowPeak`s and the loops table name the same 16 and hold **no coordinate past the
  end of its contig**. The GTF earned that: an earlier copy carried `YCR108C` at 315,997–316,188 on
  `III`, entirely beyond the map's 315,525, because it was R64 annotation relabelled rather than
  lifted. That gene is gone.
- the last 40,629 bp of `XIII-syn40` carry no gene models, which is expected — that is the synthetic
  insert, and R64 has nothing to say about it.

An earlier version of these tracks was on plain R64 (17 sequences including `Mito`, `XIII` at
924,431), which made the overlap 15 of 16 with two lengths disagreeing. **If a future track is
regenerated from the reference, that is the state it will regress to** — check the contig names and
lengths against the cool before publishing it, because nothing in the build does.

Two reading notes for whoever writes the track renderer: `Yeast_ChIP_Pol2-vs-input.bw` is a ratio, so
its neutral value is **1, not 0**, and a renderer that baselines at zero will draw it as uniformly
positive; and `Yeast_microC_loops.tsv` is cis-only, so there is nothing to draw off the diagonal.

These are data by every rule in `scripts/sw-manifest.mjs`, so they are not precached and not in
`DEMO_FILES` — `test/unit/demo-examples.test.ts` opens what the picker offers, and offering a bigWig
in a picker that returns a `MetaCooler` would be a broken choice, not a track.

## Why Pages works at all for this app

Worth recording, because it is the usual reason a wasm app *cannot* be on Pages: GitHub Pages does
not let you set response headers, so `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
are unavailable and `SharedArrayBuffer` is off. This viewer needs neither — h5wasm 0.10.x is a
single-threaded, single-file build with the wasm binary embedded in the JS, so there is no `.wasm`
asset to fetch and no threading. The reader worker is a plain module worker.

The consequence to keep: **do not adopt a threaded HDF5 build or an h5wasm version that ships a
separate `.wasm`** without revisiting this page. The first breaks Pages outright; the second only
needs the base path to stay correct.

Routing is likewise safe. All view state lives in the URL *hash* (`state/ViewState.ts`), so there
are no deep paths for Pages to 404 on and no SPA-fallback `404.html` is needed.

## After the first deploy

- **Add the Pages origin to the bucket's CORS `AllowedOrigins`** — `https://<owner>.github.io` —
  or every remote file open fails with a CORS error that looks like a bucket misconfiguration.
  See [hosting.md](hosting.md).
- Assets are content-hashed and immutable; `index.html` is not, and Pages serves it with a short
  TTL. A hard refresh is only needed if a build changes `index.html` itself.
- Source maps are published (`vite.config.ts` sets `sourcemap: true`). They are ~12 MB of the
  bundle and make console errors legible in the field. Drop them if that ever matters — the site
  budget is 1 GB, so it does not today.

## Offline, and installable

The site registers a service worker (`src/sw.js`, generated at build time by the plugin in
`vite.config.ts`; registered by `src/pwa.ts`). After one visit the app works with **no network at
all** — reload included — and Chrome and Edge offer an "Install app" button that puts it in the dock
with no installer and no admin rights. For a viewer whose claim is that it reads your files without
uploading them, that claim becomes something a user can *check*: load the page, disconnect, drop a
file on it.

**What is cached is the app, never the data.** The precache is the built JS and CSS, the shell, the
manifest and the two icons — about 5 MB, most of it the HDF5 build that makes opening a file
possible offline at all. The demo datasets and track resources under `public/demo/` are 250 MB and are *not* cached, and
neither is anything the viewer opens: `fetch` in the worker answers only for URLs in that list, by
exact match, and every other request reaches the network untouched. That is not a nicety — a remote
`.metacool` is read with HTTP range requests, and a cache is the wrong shape for a 206.
`scripts/sw-manifest.mjs` draws that line and `test/unit/precache.test.ts` holds it.

**Updates are offered, not taken.** A new build installs and *waits*; the page shows a small bar
offering a reload, and only then does the new worker step forward. Swapping the code under a page
that is halfway through reading a file is not a courtesy. Two details make this work in production
and are easy to lose:

- the worker is registered with `updateViaCache: 'none'`, or the browser may answer its own
  update check from the HTTP cache — GitHub Pages serves `sw.js` with a `max-age`, which would pin
  every visitor to the build that was live when they first arrived;
- `activate` prunes both other caches *and* stale entries inside the current one, because two builds
  of the same commit share a cache name and `addAll` only ever adds.

To verify a change to any of this, build, `npm run preview`, then in devtools → Application →
Service Workers: tick "Offline" and reload. The page must come back and open a local file.

## Cutting a release

The site is built from `main` on every push, so a release is not what publishes the app — it is what
gives a published build a *name*. Three things have to agree, and one command makes them:

```bash
npm version minor        # or patch, or major
git push --follow-tags
```

`npm version` runs the typecheck and the test suite first (`preversion`), refuses to continue if
`CHANGELOG.md` has no section for the new number (`version`, via `scripts/changelog-check.mjs`),
then commits the bump together with the changelog and tags it. Write the changelog entry *before*
running it.

What "major" means here is not an API: this is an application, so the contract is the **file format
it opens and the URL hash it publishes**. A major bump is a `.metacool` the previous version could
open and this one cannot, or a shared `#uri=…` link that no longer resolves to the same view.

### How a build says what it is

`vite.config.ts` bakes three facts into the bundle: the version from `package.json`, the short
commit, and that commit's date (`src/version.ts`). They appear in **About → version** and in the
`/Producer` field of every exported PDF, which is what turns "it broke on the website" into a diff.

The commit *date* rather than the build date is deliberate: rebuilding identical source must not
produce a bundle that claims to be newer than the one beside it. A build with no git repository —
from a source tarball, say — reports the version alone rather than failing.

## What CI does not do

The deploy workflow typechecks (`npm run build` runs `tsc --noEmit` first) and builds. It does
**not** run `vitest`: the unit tests read `test/fixtures/`, which is generated by
`npm run fixtures` and needs a Python environment with h5py. Wiring that into a separate CI job is
worthwhile, but it is a test-infrastructure change, not a deployment one — keeping it out of the
deploy path means a fixture-generation problem cannot block publishing a working app.
