# Deploying the viewer to GitHub Pages

The app is a static bundle — no backend, no server-side rendering, no API (SPECS C1) — so hosting it
is a file copy. `.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist/`
through the official Pages actions.

**What is published is the app plus three demo files** (see below). Real datasets are served from a
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

`public/demo/` holds four published datasets, so the deployed site opens something real without
anyone first standing up a bucket:

| file | data | provenance |
| --- | --- | --- |
| `Mock_microbial_community.metacool` (14 MB) | 49 MAGs over 20,566 contigs, 1 kb bins, 7.1 M pixels | SRA `SRR32680160`, binned with MetaTOR |
| `Mock_microbial_community.mmetacool` (35 MB) | the same map zoomified to 1 / 2 / 4 kb | derived from the metacool above |
| `Yeast_mpneumoniae_G2M.mcool` (17 MB) | 18 contigs (16 yeast chromosomes, the mitochondrion, *M. pneumoniae*), 19.6 M contacts, 1–16 kb | GEO `GSM6703657` |
| `Ecoli.mcool` (46 MB) | one 4.64 Mb chromosome, 111 M contacts, 500 bp – 100 kb | wild type of Bignaud et al., *Nat. Struct. Mol. Biol.* |

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

- The two `.mcool`s carry no genome layer, and that is deliberate: they are what exercises the
  plain-cooler path on the deployed site — the resolution ladder landing on its finest level, and
  a contig-only view with the genomes table absent rather than empty.
- This is ~112 MB in git history and in every Pages artifact. It is a fixed cost, not a per-release
  one — keep it that way. New or larger datasets belong on a bucket and in the catalog, not here.

They are offered in the example dropdown on the picker (`ui/examples.ts`), with URLs built from
`BASE_URL` and made absolute against the page: the base differs between dev and Pages, and a
*relative* URI in a shared link would not re-open, because `inferSource` follows a link only when
its path is `http(s)://`.

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
