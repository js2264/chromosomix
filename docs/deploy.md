# Deploying the viewer to GitHub Pages

The app is a static bundle — no backend, no server-side rendering, no API (SPECS C1) — so hosting it
is a file copy. `.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist/`
through the official Pages actions.

**What Pages publishes is the app and nothing else.** The five demo datasets and eleven track
resources it used to carry now live on the lab's S3 bucket, configured per
[hosting.md](hosting.md) and uploaded by `scripts/publish-demo.sh` (see
[below](#the-demo-files)). Nothing under `data/` is committed or uploaded, and a dropped local file
still never leaves the browser.

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
| Desktop build | `./`, written by `vite.desktop.config.ts` — never by `BASE_PATH` |

The desktop row is the odd one out and stays that way on purpose. A packaged renderer is served from
`app://viewer/`, where there is no site root for a `/assets/…` URL to resolve against, so its base is
relative and is set in its own config rather than passed in. `BASE_PATH` is not read by that build at
all: a variable left in the environment must not be able to change the shape of an installer, and a
`VAR=value command` prefix is not parsed by the Windows runner's shell in any case. See
[docs/desktop.md](desktop.md).

To reproduce a Pages build locally, pass the same value:

```bash
BASE_PATH=/<repo>/ npm run build
BASE_PATH=/<repo>/ npm run preview   # then open http://localhost:4173/<repo>/
```

`preview` needs the variable too: it reads the same `vite.config.ts`, and without it the server
mounts at `/` while the bundle asks for `/<repo>/assets/...`. Its 404 fallback answers those
requests with `index.html` and a `200`, so the mismatch shows up as a blank page rather than as a
missing file.

## The site's own domain: chromosomix.app

`public/CNAME` names the domain the site is served from, `chromosomix.app`, and does two things in
this repository's workflows: the base path above becomes `/`, and a pull request's preview is
announced at `https://chromosomix.app/pr/<number>/`. What the file cannot do is make the domain
point here. That is four settings outside the repository, and until they agree the site is a blank
page or no page at all:

1. **DNS, at the registrar.** The apex, `chromosomix.app`, as `A` records to GitHub Pages' four
   addresses — `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` — and as
   `AAAA` records to `2606:50c0:8000::153` through `2606:50c0:8003::153`; `www` as a `CNAME` to
   `js2264.github.io`, which Pages then redirects to the apex.
2. **Settings → Pages → Custom domain: `chromosomix.app`**, then **Enforce HTTPS** once the
   certificate has been issued. `.app` is on every browser's HSTS preload list, so there is no
   plain-HTTP fallback in the meantime: until the certificate exists the domain does not load at
   all. Verify the domain under the account's own **Settings → Pages** as well (a `TXT` record), so
   that no other repository can claim it.
3. **The site's registrations** ([below](#the-sites-google-and-dropbox-registrations)): add
   `https://chromosomix.app` to the Google OAuth client's *Authorized JavaScript origins* and to the
   API key's allowed referrers, and to the Dropbox app's settings.
4. **The bucket's CORS.** `scripts/publish-demo.sh` lists `https://chromosomix.app` among the origins
   allowed to make *signed* requests, so running it once applies the change
   ([hosting.md](hosting.md)). Unsigned reads — every demo, every public file — are allowed from
   any origin already.

Set the custom domain and merge the commit that adds `public/CNAME` back to back: in between, the
address serves a build made for the other one, and that is a blank page.

**What the move does to what is already published.** Every archived build and preview was built
for `/<repo>/v/<commit>/` or `/<repo>/pr/<number>/`. The deploy step *Move the archived builds to
the site's base* (`scripts/archive-rebase.mjs`) rewrites each of them, once, for the new base, so
all of them — the releases included — still open at their new address. Pages redirects the old
address to the new one, and the `#…` of a link travels with the redirect, so a view somebody shared
still opens there; check one old link once the domain is live.

Two things do not move, and both belong to the browser rather than to this repository:

- **Storage is per origin.** Workspaces kept in the browser, the restore slot, the recent files and
  the settings stay with the old address. Export what matters before the move.
- **An installed copy keeps the old build.** The service worker answers every page load at the old
  address from its cache, so a reader who has used it there is never shown the redirect — and its
  update check, a request for `sw.js` at the old address, is redirected too, which a browser refuses
  for a service worker. That reader keeps the last build from before the move until they go to
  `chromosomix.app` themselves or clear the site's data.

## The site's Google and Dropbox registrations

Signing in to Google Drive or GCS needs an OAuth client id registered for the site's origin, a
public Drive link needs an API key, and browsing a Dropbox needs an app key: the three
registrations [docs/hosting.md](hosting.md) walks through making. None is a secret — each is served
in the page of any site that uses it and authorises nothing by itself — so they are three
**repository variables** (Settings → Secrets and variables → Actions → Variables), not secrets:

| Variable | What it holds | What a reader of the site gets |
|---|---|---|
| `GOOGLE_CLIENT_ID` | the OAuth client id, `…apps.googleusercontent.com`, registered for the site's origin (`https://<owner>.github.io`, or the custom domain) | **Connect → Google Drive** offers *sign in with Google* at once |
| `GOOGLE_API_KEY` | an API key of the same project, restricted to the site's referrer | a public Drive link opens with nothing pasted |
| `DROPBOX_APP_KEY` | the scoped-access app's key | **Connect → Dropbox** offers *sign in with Dropbox* at once |

The deploy, the pull-request preview and the desktop release pass them to the build, which bakes
them in as `SITE_DEFAULTS` (`src/config/siteDefaults.ts`, SPECS §24.7). They are the only source:
the dialog has no box for any of them and a reader's browser stores nothing of them. A variable
left unset builds a page whose dialog says that sign-in is not set up and names the variable. A
fork on another domain sets its own three: a client id is bound to an origin and a key to a
referrer, so this site's do nothing there. The single-file build is made without them — a `file://`
page has no origin to register and no referrer to restrict a key to — and the desktop build carries
the Dropbox key and the API key, which work from `app://viewer`, while its Google sign-in stays
absent because Google registers only `http` and `https` origins ([docs/hosting.md](hosting.md)).

Locally, the same names in the environment do the same thing, for a dev server as for a build:

```bash
GOOGLE_CLIENT_ID=… GOOGLE_API_KEY=… DROPBOX_APP_KEY=… npm run dev
```

`http://localhost:5173` has to be among the client's authorised JavaScript origins for the Google
sign-in to work from there; the Dropbox key needs nothing registered per address.

## The demo files

The five published datasets live on the lab bucket, one folder per dataset under
`https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/`:

| file | data | provenance |
| --- | --- | --- |
| `metagenomics/mock-community/Mock_microbial_community.metacool` (14 MB) | 49 MAGs over 20,566 contigs, 1 kb bins, 7.1 M pixels | SRA `SRR32680160`, binned with MetaTOR |
| `metagenomics/mock-community/Mock_microbial_community.mmetacool` (35 MB) | the same map zoomified to 1 / 2 / 4 kb | derived from the metacool above |
| `yeast-mpneumoniae/Yeast_mpneumoniae_G2M.mcool` (17 MB) | 18 contigs (16 yeast chromosomes, the mitochondrion, *M. pneumoniae*), 19.6 M contacts, 1–16 kb | GEO `GSM6703657` |
| `ecoli/Ecoli.mcool` (46 MB) | one 4.64 Mb chromosome, 111 M contacts, 500 bp – 100 kb | wild type of Bignaud et al., *Nat. Struct. Mol. Biol.* |
| `yeast/Yeast_microC_G2M_1kb.cool` (19 MB) | 16 chromosomes of synthetic yeast (`XIII-syn40` carries a 40 kb insertion), 12,118 bins of 1 kb, 13.7 M pixels, 179 M contacts, balanced | mitotic micro-C, Dauban et al., *Science* (DOI `10.1126/science.adm9466`) |

`Yeast_microC_G2M_1kb.cool` is the **single-resolution** cooler in the set: every other map here is
either a metacool or an `.mcool` ladder, so it is what exercises the path where there is no
resolution to choose and no `resolutions/` group to land in. It is one level lifted out of a
seven-level `.mcool` (100 bp – 10 kb) whose finest levels are far too large to publish; 1 kb is the
grid the loop calls below were made on. **The `_1kb` in the name is load-bearing** — read it back
from `bin-size` before renaming it, since an earlier copy of this file was called `_2kb` and was
not.

### Why they are not in `public/` any more

They were, and being same-origin with the app removed one class of failure
[hosting.md](hosting.md) is written about: no CORS preflight, no `AllowedOrigins`, no
`ExposeHeaders`. It did not remove the rest, and Pages fails one of them. Pages honours `Range`, but
it also **gzips `application/octet-stream`**, which is what it serves every `.metacool` and `.mcool`
as — so ranges address the compressed stream and the reader gets bytes from the wrong offsets. The
measured headers and the reasoning are in
[hosting.md](hosting.md#transfer-compression-breaks-ranges); the short version is that no browser
can opt out, because `Accept-Encoding` is a forbidden header name.

Every demo therefore opened by a **fallback**: the probe saw `Content-Encoding`, refused the ranged
path, and the worker downloaded the object whole into memory instead (`worker/sources.ts`). That
works — a complete gzip stream inflates correctly — but it transfers the entire file, which is the
one property the remote path exists to avoid. The landing page was demonstrating the fallback rather
than the reader.

Moving the data to S3 fixes both halves of that at once, and costs the CORS configuration back:

- **The app is 19 MB instead of ~265 MB.** That is every Pages artifact, every `npm run build`, and
  the ~12 MB source map is most of what is left.
- **The demos are read the way §11 says a published dataset is read.** S3 does not compress
  `application/octet-stream`, so the probe succeeds and the reader takes the bounded-range path —
  the same path a reader's own bucket will take.
- **The bucket must answer a preflight** and expose `Content-Length` and `Content-Range`.
  `scripts/publish-demo.sh --cors` applies that policy, and the same script verifies it afterwards
  with hosting.md's three `curl` calls.

The `demo/` directory in the repository is the upload source, and `test/unit/demo-examples.test.ts`
reads it: disk and bucket are one tree, so a renamed file is a red CI run rather than a landing page
where every choice 404s. The datasets stay in git history either way — deleting them from the tree
would not shrink a clone — so keeping them checked out is what lets CI open a real `.cool` rather
than trust a URL it cannot reach.

One thing to keep in mind: the three plain coolers carry no genome layer, and that is deliberate.
They are what exercises the plain-cooler path on the deployed site — the resolution ladder landing on
its finest level, the single-resolution file with no ladder at all, and a contig-only view with the
genomes table absent rather than empty.

### Publishing them

```bash
./scripts/publish-demo.sh --dry-run   # what would be uploaded
./scripts/publish-demo.sh             # sync demo/ -> s3://rsglab-data/demo/, apply CORS, verify
```

It needs the AWS CLI and credentials with `s3:PutObject` on the bucket, from any source the CLI's
usual chain accepts. It is **not** part of `npm run build` and not part of the deploy workflow: the
data changes on the order of once a year and the app deploys on every push, so coupling them would
mean re-uploading 250 MB to publish a CSS fix.

Each of them is also a row of the lab's store, under the figures, so a reader can open one on its
own; what the store leads with is the workspaces below, and those name these.

## The published workspaces

The drawer's **RSG lab data** store (`demosStore()` in `ui/examples.ts`, offered through
`ui/stores/registry.ts`, SPECS §24.2) leads with **workspace files**, drawn as figures under two
headings. All but the metagenome's are in one folder, `demo/store/`, a directory a card or a dataset:

| section | file | opens |
| --- | --- | --- |
| Demo | `yeast/Yeast_microC.chromosomix.json` | micro-C of A364A (GSE151553) at 1.6 kb on 400 kb of chromosome XIV, balanced, with the sequence and genes on both edges, RNA-seq as one chart per gene, ATAC, MNase, shotgun and SNPs under it, and its loops drawn on it |
| Demo | `yeast/Yeast_landscape.chromosomix.json` | the same tracks with **no contact map**, at 5.5 kb of chromosome XIV, the sequence lane drawing the six reading frames |
| Demo | `yeast/Yeast_HiC_microC_PCP.chromosomix.json` | Hi-C (Meneu et al. 2025, G1), micro-C and PCP of chrXV:200–400 kb in a deck of three, MNase and the genes under each |
| Demo | `human/Human_chrX_splicing.chromosomix.json` | the 1D browser opened from UCSC's hg19 cytoBand alone, at RPL10 in Xq28: the ideogram, the chrX gene model, one Geuvadis sample's reads with their splice arcs, and two samples' STAR junctions on one typed axis (SPECS §8.22, §8.23) |
| Demo | `gibcus2018/Gibcus2018_mitosis.chromosomix.json` | DT40 Hi-C from G2 into prometaphase (Gibcus et al. 2018, from 4DN), three tabs of decks: chromosome 7 whole, compartments on chromosome 1, domains on 4 Mb of it |
| Demo | `metagenomics/mock-community/Mock_microbial_community.chromosomix.json` | the `.mmetacool` ladder at its finest level, on the genomes table sorted by length — a dev feature |
| Papers | `chromosomix_paper/Chromosomix_paper.chromosomix.json` | the Chromosomix paper, five tabs, a panel each: Fig. 1c, 4DN's mouse ES-cell Hi-C at five scales from the genome to *Sox2*, each with its tracks and the model the figure inferred at that scale; Fig. 1d, chr3:32–36 Mb at 10 kb with its insulation, borders and CTCF beside chromosome 3's model; Fig. 2a, *C. necator* over the decay along the diagonal and along both arms; Fig. 2b, the *B. subtilis* ParB time course; Fig. 2c, *P. aeruginosa* WT, SMC-ScpAB– and MksBEF– with each one's E1 |
| Papers | `meneu2025/Meneu2025_bacterial_chromosomes.chromosomix.json` | Meneu et al. 2025 (GSE217022): the *M. mycoides* and *M. pneumoniae* chromosomes in yeast at G2/M with MNase, RNA-seq, Pol II and Scc1, then both strains whole in G1 |

The store's folder is the one part of `demo/` that is **not** a copy of the repository. Its maps run
to 7 GB, so they are copied into it on the bucket and never pass through git: the repository keeps
the workspaces and `demo/store/MANIFEST.tsv`, one line a file saying where it comes from — a key on
the lab's bucket or on 4DN's open-data one, a file of this repository, or a file
`scripts/make_rsg_store.py derive` computes. That script writes the workspaces and the manifest from
one table; `scripts/publish-store.sh` makes the bucket match the manifest and checks every file
anonymously afterwards. It copies and uploads and never deletes.

```bash
python3 scripts/make_rsg_store.py derive --work ~/rsg-store   # the computed files (pysam, numpy, hictkpy[pyarrow])
python3 scripts/make_rsg_store.py workspaces                  # demo/store/**/*.chromosomix.json and the manifest
./scripts/publish-store.sh --work ~/rsg-store --dry-run       # what would be copied
./scripts/publish-store.sh --work ~/rsg-store                 # copy, upload, verify
```

`make_rsg_store.py stage --out DIR --local URL` writes the same workspaces pointed at where each file
is today — the bucket, 4DN, a local server for the rest — to look at one before it is published.

They are ordinary `chromosomix.workspace` files — the exact format the save button in the top bar
writes (`state/workspace.ts`) — so choosing one from the list and dropping one somebody sent you are
the same gesture, through the same code. A `.json` on a URL is fetched, parsed and applied;
everything it names is then opened by the ordinary paths.

Most are a workspace of **one tab**, which is what the format collapses to when a window holds one;
the time course and the Meneu paper carry several, and `demo-examples.test.ts` walks every tab of
every entry rather than the first.

The reason to publish workspaces rather than the data files themselves is that a `.cool` in a
dropdown can only ever offer what dropping that `.cool` offers — a map at its landing view, with
nothing beside it. A first-time reader should meet the application doing its job: a window worth
looking at, tracks on both edges, two strands sharing a lane. All of that is already writable as a
file, so it is written as one.

**Names inside a workspace are relative, and must stay that way.** The URL of the workspace itself is
absolute — built from the bucket prefix in `ui/examples.ts` — because a *relative* URI in a shared
link would not re-open: `inferSource` follows a link only when its path is `http(s)://`. But the
files a published workspace names are resolved against its own URL (`resolveConfig`), which is what
makes a dataset folder self-contained: `demo/store/` holds its workspaces and everything they name,
and it opens from the bucket, from a copy on another bucket, or from `python3 -m http.server` over
the directory. It is also why moving 250 MB from Pages to S3 changed no line of any
`.chromosomix.json`. A *saved* workspace names absolute URLs and is left untouched by that step, so
the two kinds can be mixed in one file.

Resolution covers **everything a tab names**, not only its map and its tracks: the second file of a
comparison, every companion in a deck (`state.maps`), and the lane each track was drawn on. The deck
and the lanes were the half that used to be missed, and the failure was quiet — a bare `rep2.cool`
fetched against the *site root*, so the cell read as a broken panel rather than as an unresolved
name. Two things are deliberately **dropped** rather than resolved on the way in, because they can
only ever have named a file on the sender's own disk: a local second file, and a local deck
companion. The `~` placeholder keeps the slot, so the count and the order survive and the reader gets
a drop rectangle.

## The track resources

> The store no longer offers anything below: its yeast is on R64 (`demo/store/yeast/`), and the
> one-click shelf is now beside the store's micro-C map, `GSE151553_A364_merged.mcool` — seven tracks:
> the genes, RNA-seq, ATAC, MNase, shotgun, SNPs and the loops. `demo/yeast/` stays in the
> repository and on the bucket as the test suite's fixtures, which is what this section describes.

`demo/yeast/` also carries eleven files that are **not maps**. They are what the annotation cards
(SPECS §8) draw: a real signal beside a real map rather than a fixture. Every one of them is aligned
to `Yeast_microC_G2M_1kb.cool` and is meant to be used with it. Ten of the eleven are named by the
two yeast sessions above, placed, coloured and grouped — `Yeast_Shotgun.bw` is the one neither uses,
because a flat control track is what you reach for to check another one, not what a composed figure
opens with. This section is about all eleven.

Opening that map offers **ten** of them as one click, from the Linear annotations card — the
sequence is the exception, and deliberately: a FASTA is not an annotation of a genome, it *is* the
genome, it is read whole and held whole, and adding twelve megabytes of residues to a button labelled
"load the tracks" would be a surprise rather than a convenience. The two yeast sessions name it
explicitly, which is where a reader who wants it asks for it. The pairing lives in `ui/examples.ts`
beside the picker's own catalogue, and is keyed on the map's **file name** rather than its URL, so it
survives the base path differing between dev and Pages. It is offered only when the map itself came
from a URL: a *local* file that happens to be called `Yeast_microC_G2M_1kb.cool` is somebody else's
data under a familiar name, and drawing ten yeast tracks on it would be a serious mistake rather than
a convenience.

| file | data |
| --- | --- |
| `S288c_syn40-XIII.fa` (12 MB) | the map's own 16 sequences — drawn as GC content zoomed out, as residues zoomed in |
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

- all six bigWigs declare the map's **16 contig names with byte-identical lengths** — no `Mito`, and
  `XIII-syn40` at 964,431. So the intersection SPECS §8.2 asks for is 16 of 16, and the overlap
  report the card shows has nothing to complain about.
- the FASTA holds those same 16 at those same lengths, residue for residue: `III` at 315,525 and
  `XIII-syn40` at 964,431, no `Mito`. It is the strongest of these claims and the easiest to check —
  `awk '/^>/{...}'` over the file against the map's own contig table — because unlike a bigWig header
  the lengths are not declared, they are the count of what is there.
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
`DEMO_FILES`, which holds the four workspace files. `test/unit/demo-examples.test.ts` reads each of
them with the app's own parser, resolves it as the app resolves it, checks that **every file it
names is in this directory** — map, comparison, companions, lanes and tracks alike — and opens the
map ones. That is the check that matters here: renaming a bigWig no longer breaks a dropdown entry,
it breaks a workspace that opens to a map with six error rows beside it, and nothing else in the
suite would notice.

## Every push stays reachable

Because the site is built from `main` on every push, "the viewer" is not one artifact but a stream of
them, and the site only ever serves the newest. That is fine until a figure comes out different from
one made last month, or a `.metacool` that opened in July does not open now — at which point the
only useful question is *which build*, and the only useful answer is one you can go and run.

So every deploy publishes **two** things:

```
https://<owner>.github.io/<repo>/                 the newest build
https://<owner>.github.io/<repo>/v/<commit>/      a copy of it, and of the recent ones before it
https://<owner>.github.io/<repo>/v/v0.5.1/        a release, by its tag — kept for ever
https://<owner>.github.io/<repo>/versions.json    what is published, newest first
```

**About → version** carries a dropdown of the builds in that manifest (`src/ui/VersionPicker.ts`).
Picking one is a navigation, not a swap: the two builds are different documents, and the query
string, the hash and the `sessionStorage` tab strip come along, so a link and a view survive the
move. A file opened from local disk does not, for the reason it does not survive a reload either.
An archived build says so in a corner bar, with one button back to the newest.

Nothing about this is on the desktop build, and the archived copies are deliberately **not**
installable — a dock icon must not open a version somebody pinned once to check a figure.

### What is archived, and what it costs

`npm run build:pinned` (`vite.pinned.config.ts`) is a third invocation of the bundler over the same
source, spreading `vite.config.ts` exactly as the desktop config does. It differs in four ways, all
of them consequences of being a *copy*:

| | site build | archived copy |
| --- | --- | --- |
| base | `/<repo>/` | `/<repo>/v/<commit>/`, from `PINNED_BASE` |
| service worker | emitted and registered | neither |
| installable | yes | no — `stripPwaTags()`, shared with the desktop build |
| `public/` | copied (icons and manifest, ~50 KB) | not copied |
| source maps | yes, ~13 MB | no |

That leaves **~5 MB per commit**, against a Pages site limit of 1 GB — all of which is now the app's,
since the demo data moved to the bucket. Most of those 5 MB are the HDF5 build, whose chunk is content-hashed and identical
between builds — so git stores one copy of it however many commits are kept, and the archive branch
grows by a few hundred kilobytes per push rather than by five megabytes.

Every one of those four rows is asserted after the build, by `scripts/check-pinned-build.mjs`,
because every one of them fails quietly and late: an archived build is the artifact nobody opens
for months, so a wrong base is a blank page a reader finds in November, and a `publicDir` left on
exhausts the site's budget several deploys after the change that caused it. The rules are in
`scripts/pinned-shape.mjs` and are held by `test/unit/pinned-shape.test.ts`, the same arrangement
`check-desktop-build.mjs` uses and for the same reason.

### Where the old builds live between deploys

Pages replaces the whole site on every deployment, so the previous builds have to be kept somewhere
and put back. They live on a **`pages-archive`** branch — its own history, sharing no commit with
`main` — which is storage and nothing else: the repository's Pages source stays *GitHub Actions*,
and there is no setting to change.

1. the deploy job builds the site, then builds this commit's archived copy;
2. it shallow-clones `pages-archive`, which holds `versions.json` and one directory per kept build;
3. `scripts/archive-versions.mjs` adds this commit, applies the retention rules, deletes the
   directories that fall out, and rewrites the manifest;
4. it commits and pushes that branch — **non-fatally**: a site that publishes but fails to record
   that it did is a better outcome than one that does not publish, and the script is idempotent per
   commit, so the next push re-adds it;
5. the archive is copied into `dist/` and the whole thing is uploaded as the Pages artifact.

The build job therefore needs `contents: write`, which it did not before. It is the only job that
has it: the deploy job was narrowed to `pages: write` and `id-token: write` in the same change.

Two builds pushing that branch at once would each write a manifest missing the other's build. They
cannot: the workflow's `concurrency: pages` group already serialises runs, which is what makes a
plain push safe here rather than a merge.

### What is kept, and how releases are treated

Three rules, in `scripts/versions-manifest.mjs`, pinned by `test/unit/versions-manifest.test.ts`
because this is the one thing the deploy does that pushing again cannot undo:

1. **the last 20 pushes**, which is the debugging window — "it worked on Tuesday" is a question
   about a handful of commits, and by the time it is about fifty the answer is a bisect;
2. **every tagged commit, for ever.** A release is what somebody cites in a methods section, and
   one that answers 404 two months later is worse than never having offered it;
3. **the oldest build of each distinct `package.json` version, for ever** — rule 2 for the case
   where the tag is not visible yet.

Rule 3 wants explaining, because the obvious version of it is wrong and was wrong here first.
`npm version minor` bumps `package.json` **and tags that same commit**, so the release is the
*oldest* build carrying a version; the *newest* one carrying it is whatever was pushed just before
the next bump. A rule that kept the newest would keep a build that calls itself `0.6.0`, is labelled
`0.6.0` in the menu, and is not `v0.6.0` — worse than keeping nothing, because it is wrong rather
than absent. Keeping the oldest also stops the archive churning: the pinned build is decided the
moment a version first appears and never moves.

Rules 2 and 3 overlap on purpose. `git push --follow-tags` sends the commit and the tag together, so
the tag is normally visible to the deploy — but a release pushed in two steps deploys before its tag
exists, and rule 3 catches that build anyway. The cost of rule 3 is one extra kept build per version
(on a fresh archive, its first entry is not a release at all, just the oldest one it ever saw).

**Tags are read with `git ls-remote --tags`, not by fetching them.** `actions/checkout` clones at
depth 1, and asking it for tags would drag down an object per tag in a repository carrying 250 MB of
demo data in its history. `ls-remote` asks the server for its ref names — a few kilobytes, no
objects. Annotated tags are advertised twice (`refs/tags/v1` and the peeled `refs/tags/v1^{}`); the
peeled line is the one that matches a commit.

Each kept release also gets a **directory of its own** — `v/v0.5.1/` — holding a one-kilobyte
redirect to `v/<commit>/`. That is the address worth writing down: a commit URL is equally permanent
but says nothing to a reader. The redirect carries the query and the hash across, so a citation can
name a *view* of a release and not just the build; the `meta refresh` beside it is the no-JavaScript
path and loses the hash, which is the right order of failure. The About dialog shows this URL
whenever the build in front of you is a release.

Tag names are filtered to `[A-Za-z0-9][A-Za-z0-9._+-]*` — a tag is a path segment and is written
into that HTML page unescaped, so `release/1.0` gets no alias (the build is still archived and still
in the menu, it just has no name of its own). A tag spelt like a short hash is refused too, since it
would claim the directory a *build* is published in.

To reset the archive, delete the `pages-archive` branch; the next deploy starts a new one holding
that build alone. To change the window, change `KEEP_RECENT` — and read the arithmetic above first,
because 20 builds is ~100 MB and the budget is what it is.

### The service worker had to be taught about this

The worker is registered at `/<repo>/`, so `/<repo>/v/<commit>/` is inside its scope, and its
navigation handler answers **every** navigation in scope from the precached shell. Left alone it
would serve the newest app at a pinned address: the right URL, the wrong code, and no symptom.
`src/sw.js` now passes navigations under `<scope>v/` straight through.

That fix only reaches a visitor once their worker updates, and a worker updates only when a page it
controls is loaded — so a reader carrying an older one can still land on this exact bug.
`recoverPinnedNavigation()` in `src/pwa.ts` detects it (a document built for the site root, at an
address under the archive prefix — two things that cannot both be true of a correctly served page),
unregisters and reloads, once per tab.

**Deleting `pages-archive` is not enough to unpublish a build**, incidentally: whoever has the site
cached has the copy they were served. The archive controls what is *offered*, not what has been.

### "The newest build" is something you take, not somewhere you go

The same worker causes a second problem, and this one looks like it works. A visitor at the site
root is served by their worker, whose cache may be a build or two old — by design, since an update
installs and **waits** for consent rather than swapping code under a half-read file. So the menu
correctly shows them running `0.6.0` with `0.6.1` marked *latest*; they pick `0.6.1`; the picker
navigates to the site root; the worker answers that navigation from the same cache. The page
flickers and comes back unchanged, for ever, because nothing in the round trip asked the network
for anything.

`takeNewestBuild()` in `src/pwa.ts` is the answer, and it is three steps rather than a navigation:

1. `registration.update()` — check now, rather than whenever the browser would have;
2. if something is **waiting**, take it with the same `skip-waiting` handshake the update bar uses.
   `controllerchange` reloads the page, the cache is replaced rather than dropped, and offline
   survives. This is the path that normally runs;
3. only if the shell is *known* stale and nothing is waiting, unregister and navigate. That costs
   one page load of offline and is the only thing left that certainly works.

`isStaleShell()` is what distinguishes step 3 from an ordinary click: running the root build, and
not the one the root publishes. A reader on an archived build asking for the newest is not evidence
that anything is wrong at the root, so it does not drop a working worker.

The dialog also *says* so when it holds — which build is on screen, which one the site has, and
that an ordinary reload will not fetch it. It was silent about that first, which is what made the
bug hard to read from the outside.

Note what this cannot do: **a visitor already stuck on an older build is running that build's
code**, so a fix shipped afterwards is not code they are executing. Their way out is the update bar
(`src/pwa.ts` offers it within a second or two of any load, because `updateViaCache: 'none'` forces
a real check), or a hard reload. There is no way to reach back into a shell that is already being
served — which is the argument for the update bar existing at all.

### Pull requests get a preview

Every pull request from a branch of this repository is published the same way a push is, at

```
https://<owner>.github.io/<repo>/pr/<number>/
```

so a reviewer opens the change rather than reading it, and a figure made on a branch can be shown
before it lands. `.github/workflows/preview.yml` runs on `opened`, `synchronize`, `reopened` and
`closed`: it checks out the pull request's **head** (not the merge commit, so the build stamps
itself with the hash the reviewer sees on the branch), typechecks, builds a pinned copy with
`PINNED_BASE=<base>pr/<number>/` — `vite.pinned.config.ts` accepts that second shape, and the same
`check-pinned-build.mjs` asserts it — and puts it on `pages-archive` beside the archived pushes,
under `pr/<number>/`, with one row in `versions.json`'s `pulls` list (`scripts/archive-preview.mjs`,
whose rules are in `versions-manifest.mjs` beside the retention rules and are held by the same
test). Then it posts one comment on the pull request with the address, updated on every push rather
than repeated.

Three things differ from an archived push, and each is a decision:

- **A preview is replaced, not accumulated.** A pull request is pushed to many times, and every
  push is a new preview under the same number. The row says which commit is in it now, and the
  About dialog on a preview says so too; the picker selects the preview's row only when the running
  commit is the one the manifest names, so a page loaded before a push is offered the row unselected
  rather than told it is something it is not.
- **A preview is removed when the pull request closes**, merged or not. A review copy that
  outlives its review is a stale build with a permanent address; a merged change is reachable at
  `v/<commit>/` of the push that carried it, which is the address to cite. The `closed` run deletes
  the directory and the row and republishes — and **the deploy reconciles behind it**, dropping any
  preview in the manifest whose pull request is no longer open.

  The second half is not belt and braces; the first half alone loses previews. Merging fires
  `pull_request: closed` and `push` to `main` in the same instant, both land in the `pages`
  concurrency group, and GitHub keeps only the newest *pending* run in a group — so if anything was
  already deploying, the removal is cancelled about a second after it queues and the preview
  outlives its review. That is exactly what happened to #49 and #50, whose removals were cancelled
  behind a deploy the Stores workflow had dispatched a minute earlier. An event-shaped write that can
  be evicted needs something that asks the question again, so the deploy asks
  `repos/<owner>/<repo>/pulls/<n>` for each row before it publishes; a pull request the API will not
  answer for is left alone, because *I could not ask* must not read as *it closed*. It also covers
  the removals that failed, and the previews written before the removal step existed.
- **The preview job does not deploy.** Pages replaces the whole site on every deployment, and the
  site's root is `main`'s build, which a pull-request job does not have. So the job writes the
  archive branch and dispatches `deploy.yml`, which builds `main`, copies `v/` *and* `pr/` back in,
  and deploys — one publisher, one `pages` concurrency group, nothing to keep in step. The comment
  on the pull request says the address appears a few minutes after it, which is that deploy. One
  wrinkle of sharing the group, and it cuts both ways: GitHub holds a single *pending* run per group
  and cancels it when another joins the queue. In its favour, a job whose pull request has been
  pushed to again while it was building leaves the dispatch to the run waiting behind it — otherwise
  its own dispatch would cancel that run and publish a preview the branch had already moved past, so
  a burst of pushes ends with the newest preview published, once. Against it, the `closed` run is
  evicted the same way and its removal is simply lost, which is why the deploy reconciles the
  previews rather than trusting that event (above).

The About dialog lists previews under **Pull request previews**, after the builds and never among
them: a preview is somebody's work in progress, and a reviewer should not have to tell it apart from
a release by its label. The service worker passes navigations under `pr/` through exactly as it does
under `v/`, and `recoverPinnedNavigation()` covers both prefixes, for the reason given above.

**Whose code runs.** A pull request from a fork carries a read-only token and no secrets, and this
job needs to write a branch. It is skipped for forks at the job's `if` rather than granted
`pull_request_target`, which would run the fork's code with this repository's permissions. A
maintainer who wants a preview of a fork's change pushes it to a branch here.

**What it costs.** One pinned build per open pull request, ~5 MB, inside the same 1 GB budget the
archive lives in, and gone when the pull request is. A pull request open for a month with fifty
pushes still costs one directory.

### The generated stores are published here too

The drawer's **IGV genomes**, **4DN open data** and **ENCODE** stores are JSON files that
`.github/workflows/stores.yml` regenerates weekly and commits to the `stores` branch (docs/stores.md).
The deploy copies the current files from that branch into `stores/` beside the app, so the
viewer reads them from its own origin, and the stores workflow dispatches a deploy as soon as it has
published something new — the arrangement the previews use, on the same `pages` concurrency group.
The branch was first meant to be read directly over `raw.githubusercontent.com`; that host answers
404 to anyone not logged in when the repository is private, and a Pages site is public whether or
not its repository is, which is why the copy lives here. Absent until the stores workflow has run
once, hence the test in the assembly step.

### So are the rendered notebooks

`/validation/` and `/timings/` are `notebooks/validation.qmd` and `notebooks/timing.qmd` as
`.github/workflows/notebooks.yml` last rendered them (SPECS §18.10). That workflow runs when a
release is published — `release.yml` makes the release a draft and a person publishes it, which is
the event that reaches it — and from **Actions → Notebooks → Run workflow** on any branch or tag,
with the number of timed runs (five by default) and whether to publish. It installs everything on a
fresh runner, renders both notebooks (about three hours, most of it the timings), force-pushes the
two pages and the files beside them to the `notebooks` branch as one commit, attaches them to the
release with both tables, and dispatches this deploy, which copies `validation/` and `timings/` from
that branch on every run after — the stores' arrangement exactly. Every run also keeps what it
rendered as an artifact for 90 days, even when it fails — the validation alone, with the timing
rounds it finished, when the timings fail — and its summary lists every verdict.

Each page says, in a block under its title, when it was rendered, from which version, commit and
release, by which run, and on what machine; `rendered.json` beside it says the same for a script.
The service worker leaves both addresses to the network (`src/sw.js`), as it does `v/` and `pr/`:
they are pages of their own, and the app's shell answered there would be the app wearing their
address. A reader whose worker predates this sees the app at those two addresses until they take
the update the app offers. Absent until the workflow has published once; the first run is by
hand, or the next release.

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

### The page carries its own Content-Security-Policy

For the same reason — Pages sends no header a site chooses — the policy is a `<meta>` that the build
writes into `index.html` (`scripts/csp.mjs`, SPECS §11), and so is the archived copy's and the
package's. A host that *can* send headers should not add a second `Content-Security-Policy` beside
it: the browser enforces both, the stricter wins clause by clause, and a header copied from the
desktop build would bring `frame-ancestors 'none'` with it and blank every embed. To watch the policy
hold on a build, `npx vite build && node scripts/ui-csp.mjs site`.

## After the first deploy

- **Add the Pages origin to the bucket's CORS `AllowedOrigins`** — `https://<owner>.github.io`, or the
  custom domain (below) —
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
manifest and the three icons — about 5 MB, most of it the HDF5 build that makes opening a file
possible offline at all. The demo datasets and track resources are 250 MB on the bucket and are *not* cached, and
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

`npm version` runs the typecheck and the fixture-free suite first (`preversion`), bumps
`package.json`, then renames `## [Unreleased]` to `## [0.3.0] - <today>` and stages it (`version`,
via `scripts/changelog-check.mjs`), then commits the bump together with the changelog and tags it.

Write the entries *before* running it, under `## [Unreleased]`, and **leave that heading alone**.
Naming it by hand is what the hook is for, and doing it early is not a shortcut but a deadlock: the
two hooks want opposite states of the file. `preversion` runs `version.test.ts`, which compares the
newest section with the version `package.json` still claims — so a `## [0.3.0]` heading fails there,
before the bump that would justify it ever happens. Between the bump and the commit, which is where
the hook runs, the number is known and the rename is unambiguous.

A changelog with neither an `[Unreleased]` section nor one already named for the new number is
refused, and a section already named for it is left exactly as written — that is the re-run. Note
that a refusal is not a no-op: npm has already written the new version into `package.json` and has
not committed it, so recovery is `git checkout -- package.json` before trying again.

What "major" means here is not an API: this is an application, so the contract is the **file format
it opens and the URL hash it publishes**. A major bump is a `.metacool` the previous version could
open and this one cannot, or a shared `#uri=…` link that no longer resolves to the same view.

### What the tag sets off: the installers, the single page and the npm package

Pushing the tag is the release. `.github/workflows/release.yml` runs on every `v*` tag and

1. **refuses a tag that is not `v` and the version `package.json` carries**, before anything is
   built or published (its `version` job, which every other job waits on). A tag `npm version` did
   not make has been through none of the checks above, and what it built would call itself the
   previous version;
2. builds the macOS and Linux installers (the Windows leg is off for now) and the single-file page,
   and attaches them to a **draft** release for the tag whose body is that version's CHANGELOG
   section — look at it, then press publish;
3. publishes the package to npm (§22 of SPECS) by trusted publishing (below), unless the version is
   on the registry already or the run is not in the repository npm trusts.

**Never make the tag or the release by hand.** GitHub's release form makes a tag for any name typed
into it, on whatever `main` is: `v0.14.0` was made that way, on the commit that merged #114, whose
`package.json` still said 0.13.0. Its installers would have called themselves 0.13.0 and its npm
job packed `chromosomix@0.13.0`, which only the registry refusing the token kept from being
published under the wrong tag for good — a version on npm can never be replaced. The workflow now
stops at the first step instead, but a tag and a release made by hand stay where they are, and the
site keeps that build under the tag's name (below). If a release goes wrong, cut the next version
rather than moving a tag somebody may already have cited: that is why there is no 0.14.0.

**npm trusts the workflow, not a token.** The `npm` job publishes by npm's *trusted publishing*:
GitHub gives the run a short-lived identity (`id-token: write`), npm swaps it for a one-off
credential because the package names this repository and `release.yml` as its trusted publisher,
and the version is published with provenance — a signed statement of the commit and the run that
built it, shown on its npm page. There is no secret to store, rotate or leak. It is configured once,
on npmjs.com, which only allows it on a package that already exists — so 0.15.0, the first
version, went up with a token:

1. the package's **Settings** → **Trusted Publisher** → **GitHub Actions**: owner `js2264`,
   repository `chromosomix`, workflow file `release.yml`, no environment;
2. on the same page, **Publishing access**: require two-factor authentication and disallow
   tokens, so that nothing but this workflow and a person with their second factor can publish;
3. revoke the token in **Access Tokens**, and delete the repository's `NPM_TOKEN` secret, which
   nothing reads any more.

A fork's release skips the registry instead of failing on it: its repository is not the one
`package.json` names, which is the one npm trusts. npm may still hold a version back for a
maintainer to approve (*staged publishing*, which 0.15.0 went through, behind a placeholder named
`0.0.0-stage`): approve it with two-factor authentication on npmjs.com, or with `npm stage list`
and `npm stage approve <id>` from npm 11.15 on, and it is published.

Re-running a leg against an existing tag is `workflow_dispatch` with the tag as input, or *Re-run
failed jobs* on the run itself — so a version whose upload failed goes up once the cause is fixed,
and a version already on the registry is skipped rather than failed. Publishing a draft does not
re-fire anything: nothing has changed to rebuild.

The tag does one other thing, from the moment it is pushed rather than when a release is published:
the deploy that publishes that commit records the tag in `versions.json`, keeps that build for ever,
and gives it a permanent address at `/v/<tag>/`. See
[What is kept, and how releases are treated](#what-is-kept-and-how-releases-are-treated) — and push
the commit and the tag *together* (`--follow-tags`), or the deploy runs before the tag exists and
the build is kept by its version number without a name.

The trigger is the tag rather than the release because a release saved as a draft fires no workflow
at all, which is what this used to wait on (`release.yml`'s header has the history). The two
workflows stay independent all the same — different events, different commands, different outputs,
different concurrency groups — so a failed installer leg cannot delay or undo a site deployment
that has already happened.

Packaging is deliberately *not* part of `preversion`: `npm version patch` would otherwise download
Electron and build a `.dmg` to bump a number.

### How a build says what it is

`vite.config.ts` bakes three facts into the bundle: the version from `package.json`, the short
commit, and that commit's date (`src/version.ts`). They appear in **About → version** and in the
`/Producer` field of every exported PDF, which is what turns "it broke on the website" into a diff.

The commit *date* rather than the build date is deliberate: rebuilding identical source must not
produce a bundle that claims to be newer than the one beside it. A build with no git repository —
from a source tarball, say — reports the version alone rather than failing.

That stamp is also the *anchor* for the version dropdown directly beneath it: the commit it names is
how the picker knows which of the published builds is the one currently running. See
[Every push stays reachable](#every-push-stays-reachable).

## What CI does not do

The deploy workflow typechecks (`npm run build` runs `tsc --noEmit` first) and builds. It does
**not** run `vitest`: the unit tests read `test/fixtures/`, which is generated by
`npm run fixtures` and needs a Python environment with h5py. Wiring that into a separate CI job is
worthwhile, but it is a test-infrastructure change, not a deployment one — keeping it out of the
deploy path means a fixture-generation problem cannot block publishing a working app.
