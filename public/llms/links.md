# chromosomix links: a view as a URL

> Every view in chromosomix is a URL, and a link is the simplest way to show somebody a file at a place: no install, no upload, no account at either end. This page is the grammar — the keys of the fragment and the values each takes, the two forms of a coordinate, and the query parameters that mount the app differently. A link written to it opens in the web app, in a pinned release, in an embed and in the notebook widgets alike.

## The shape

```
https://chromosomix.app/[?<query>]#<key>=<value>&<key>=<value>…
```

- The view is in the fragment, after `#`: `key=value` pairs joined by `&`. Each value is percent-encoded as `encodeURIComponent` does it; `/`, `:`, `,` and `|` may be left as they are, `&` and `=` may not.
- `uri` is required. A fragment without one is ignored and the app opens on its landing page.
- Keys are case-sensitive, and the app drops what it cannot read rather than refusing the link: a `view` it does not know opens the file’s table, and a `transform`, a `smooth` or a `vmin` it cannot read is left out. A misspelt key therefore does nothing at all — check each against the table below.
- The fragment is never sent to a server. The reader’s browser reads the file, from where it is, by HTTP range requests; nothing is uploaded.
- A link can only name a file the reader can reach: a public address, or one their own browser holds credentials for. A file on the sender’s disk cannot be linked to.

## Coordinates

A locus has two written forms, and the keys do not share one:

- **Machine form**, for `region`, `region2` and `focus`: cooler’s, 0-based and half-open, with no separators — `IV:1000000-1400000` is shown in the app as `IV:1,000,001-1,400,000`. A sequence name alone is the whole sequence.
- **Display form**, for `locus`: 1-based and inclusive, as the app, IGV and UCSC print it — `IV:1,000,001-1,400,000`, digits grouped or not.
- Write a sequence name as the file spells it: `chr4` for a file that says `chr4`, `4` for one that says `4`.

The command line takes the display form everywhere (`--window`, `--anchor`): see the [command line](https://chromosomix.app/llms/cli.md).

## The keys of the fragment

| Key | Values | What it does |
|---|---|---|
| `uri` | an address | **Required.** The file: a contact map (`.cool`, `.mcool`, `.hic`, `.scool`), or a reference or track (a FASTA, a `.2bit`, a bigWig…), which opens the 1D browser over its assembly. `https://`, `s3://`, `gs://` and Dropbox or Google Drive share links all work. For one resolution of a multi-resolution file, append `::/resolutions/<bin size>`: `sample.mcool::/resolutions/10000`. |
| `uri2` | an address | A second map on the same bins, drawn in the lower triangle of the same square. `op` says how the two are put together. |
| `maps` | addresses joined by `\|` | More cells beside the first map, as a deck panned and zoomed together. A member is a map’s address, `3d` for the session’s 3D model, `tracks` for its tracks on their own, or `~` for a local file that a link cannot carry. |
| `view` | `contigs`, `whole`, `region`, `selection`, `browser` or `cells` | What is shown (see the table below). A value it does not know opens the file’s table. |
| `region` | `<sequence>` or `<sequence>:<start>-<end>`, machine form | The block a `region` view reads: its rows, and its columns too unless `region2` is given. |
| `region2` | as `region` | The columns of an off-diagonal block: the contacts between `region` and this. |
| `focus` | `<sequence>:<start>-<end>`, machine form | A window inside `region` that the map opens zoomed to, with the rest of the block still there to pan into. Applied once, on opening; it does not follow the reader. |
| `regions` | sequence names joined by `,` | The sequences of a `selection` view. |
| `cells` | cell names joined by `,`, or `*` | The cells of an `.scool` summed into the map, in file order; `*` is every cell, the default. |
| `contacts` | a whole number | Every map drawn to this many contacts before it is shown or analysed: an exact subsample below the file’s own total, an oversample through Boost-HiC above it, with a fixed seed. |
| `locus` | `<sequence>:<start>-<end>`, display form | The window of the 1D browser (`view=browser`). Absent is the whole genome. |
| `level` | `bin` or `contig` | What one row of the matrix is: a bin (the default), or a whole sequence summed into one cell. |
| `coarsen` | a bin size in bp | A resolution the file does not store, a whole multiple of the one `uri` names: the stored bins are summed as they are read. A value the file cannot reach is ignored. |
| `transform` | `log1p`, `log10`, `log2` or `none` | How values are mapped to colour. |
| `colormap` | `default`, `afmhot_r`, `afmhot`, `Reds`, `cividis`, `viridis`, `magma`, `RdBu_r`, `BuWtRd` or `seismic` | `RdBu_r`, `BuWtRd` and `seismic` are diverging, for a ratio or an observed over expected. |
| `vmin` | a number | The bottom of the colour scale, in transformed units (`-1` under `log10` is 0.1). Absent is automatic. Not applied to a ratio — `oe`, or `op=ratio` or `difference` — whose scale opens centred on no change. |
| `vmax` | a number | The top of the colour scale, in transformed units. Absent is automatic; the two are independent. |
| `balance` | `true` or `false` | Balanced values, with the weights the file carries, or raw counts. |
| `score` | `count`, `balanced`, `vc`, `vcsqrt`, `ice`, `baseline` or `correlation`, or a column of the file | What each cell is drawn from: the raw counts, the balanced counts, a normalisation computed on the fly (VC, square-root VC, ICE), the expected count at that distance, the Pearson correlation of the observed over expected (on a balanced file), or another column of the file’s pixel table. Overrides `balance`. A value the file cannot answer falls back to the counts. |
| `oe` | `true` or `false` | Observed over expected: each cell divided by what its distance from the diagonal predicts. |
| `arms` | a whole number of bins, `0` for all | With `oe=true`, on a circular bacterial chromosome whose origin is set: the expected is read along both arms, within this many bins, rather than along the diagonal alone. |
| `smooth` | `0`, `1`, `2`, `3` or `a50` | Despeckling: `0` is off, a number is a fixed radius (`1` is 3 × 3), `a50` grows a window per cell until it holds enough contacts. |
| `op` | `split`, `ratio` or `difference` | With `uri2`: the two files on either side of the diagonal (`split`), or one derived map over the whole square, their `ratio` or their `difference`. |
| `flip` | `true` or `false` | Turn a map of one sequence 45°: position along the bottom, distance from the diagonal up the side. |
| `lower` | `true` or `false` | Draw the lower triangle in a reading of its own, set by the six keys below; ignored with `uri2` or `maps`. |
| `score2` | as `score` | The lower triangle’s `score`. |
| `oe2` | as `oe` | The lower triangle’s `oe`. |
| `smooth2` | as `smooth` | The lower triangle’s `smooth`. |
| `transform2` | as `transform` | The lower triangle’s `transform`. |
| `colormap2` | as `colormap` | The lower triangle’s `colormap`. |
| `vmin2` | a number | The lower triangle’s `vmin`. |
| `vmax2` | a number | The lower triangle’s `vmax`. |

### Views

| `view` | What it opens |
|---|---|
| `contigs` | the table of the file’s sequences, with their lengths and contacts |
| `whole` | the whole matrix, every sequence against every other. It reads the whole file, so it opens on a button that says what that costs, and draws once the reader presses it |
| `region` | a block of the map, named by `region` (and `region2` for an off-diagonal one) |
| `selection` | several sequences side by side, named by `regions` |
| `browser` | the 1D genome browser over the file’s assembly, at `locus` |
| `cells` | the table of an `.scool`’s cells, to pick the ones summed into the map |

## Examples

Micro-C of synthetic yeast chromosome IV, and its tracks, from the public demo bucket:

A window of chromosome IV, balanced, on a log scale:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true

The same window as observed over expected, on a diverging colour map:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&balance=true&oe=true&transform=log2&colormap=RdBu_r

The same window, its colour scale clipped to 10⁻³–10⁻¹·⁵:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true&vmin=-3&vmax=-1.5

All of chromosome IV read, opened zoomed to 100 kb of it:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV&focus=IV:1150000-1250000&transform=log10&balance=true

The whole genome, every chromosome against every other — once the reader agrees to read it all:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=whole&transform=log10&balance=true

The contacts between two chromosomes:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV&region2=XII&transform=log10&balance=true

The 1D browser over an ATAC-seq bigWig, at a locus:

    https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_ATAC.bw&view=browser&locus=IV:1,150,001-1,250,000

## The query: how the app is mounted

The query string, before the `#`, changes what the page around the view is rather than what it shows:

| Parameter | What it does |
|---|---|
| `embed=1` | The bare view, for an `<iframe>`: no header, no tabs, the side panels folded. See [embedding](https://chromosomix.app/llms/embed.md). |
| `config=<URL>` | Opens a saved workspace — a `.chromosomix.json`, every tab with its tracks, colours and marks — instead of one file. Names inside it resolve against its own URL. See [files and workspaces](https://chromosomix.app/llms/data.md). |
| `store=<id or URL>` | Opens a data store’s catalogue over the page: a built-in one by its id, or a store file or a UCSC `hub.txt` by its address. `q=<text>` searches it, `<column>=<value>` ticks a facet, and `view=matrix&axes=<a>,<b>` shows it as a matrix of two columns. |

Examples:

    https://chromosomix.app/?embed=1#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true
    https://chromosomix.app/?config=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/store/yeast/Yeast_microC.chromosomix.json
    https://chromosomix.app/?store=4dn&q=HCT116

## A link that never changes

The root, https://chromosomix.app/, is the newest build, and changes with it. Every release is also kept for good at its own address, `https://chromosomix.app/v/<tag>/` — `https://chromosomix.app/v/v0.13.0/`, say — which takes the same query and fragment. A link in a paper, a figure legend or a notebook that must draw the same picture in five years should name one.

## Writing a link from code

Build the fragment from an object, encoding each value; this is what the app itself does:

```js
const view = { uri: "https://example.org/sample.mcool::/resolutions/10000",
               view: "region", region: "chr2:10000000-14000000", transform: "log10", balance: true }
const hash = Object.entries(view)
  .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
  .join("&")
const link = "https://chromosomix.app/#" + hash
```
