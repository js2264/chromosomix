---
title: "Your own data store"
description: "Write one JSON file that lists your lab's maps, tracks and saved sessions with columns to filter on, publish it beside the data, and open it in chromosomix as a searchable shelf."
---

A data store is a shelf of data written down once: one JSON file that lists maps, tracks,
reference genomes and saved sessions, with enough about each — the assay, the cell type, the
condition — to choose one without opening any. chromosomix draws it in the store drawer as a page of
its own: a facet for each column with every value counted, a search box, a matrix of any two columns,
and rows to open or to add to the tab in front. The built-in stores — 4DN, ENCODE, IGV's genomes and
the rest, described in [Data stores](/files/stores/) — are this same file.

A store is a door, not a copy. A row names a file where it already is; nothing is read until a reader
opens the store, and then nothing but the store file until they open a row.

<!-- screenshot: the store drawer open on a lab's own store, its facets down the side and its rows beside them -->

## A first store

```json
{
  "kind": "chromosomix.store",
  "version": 1,
  "name": "My lab’s maps",
  "description": "Micro-C and ATAC-seq of yeast, by condition.",
  "base": "https://example.org/data/",
  "columns": [
    { "key": "assay", "label": "Assay" },
    { "key": "condition", "label": "Condition" }
  ],
  "entries": [
    {
      "label": "Micro-C, G2/M",
      "uri": "microC_G2M.mcool",
      "kind": "map",
      "size": 1250000000,
      "fields": { "assay": "Micro-C", "condition": "G2/M" },
      "note": "GEO GSE000000",
      "tracks": [
        { "label": "ATAC-seq", "url": "ATAC_G2M.bw" }
      ]
    },
    {
      "label": "Micro-C with its tracks, as in the paper",
      "uri": "figure2.chromosomix.json",
      "kind": "workspace",
      "fields": { "assay": "Micro-C", "condition": "G2/M" }
    }
  ]
}
```

Two rows: a contact map, with an ATAC-seq bigWig offered beside it once it is open, and a saved
workspace. Both names are relative, so they are read from under `base`; the two columns become the
facets *Assay* and *Condition*.

For a store that opens real files, the **Add a custom store** door has **fill in an example** (see
[Opening it](#opening-it)): it puts a small working store over the demo data in the box, ready to
edit into your own.

## The file, field by field

### The store

| Field | | What it is |
| --- | --- | --- |
| `kind` | required | always `"chromosomix.store"`. A JSON file without it is refused as not a store. |
| `entries` | required | the rows, below. |
| `version` | | `1`, the format this viewer reads, as a whole number. A store of a later version is refused, with a message saying so. |
| `name` | | what the drawer calls the store, and the name of its tile once a reader remembers it. |
| `description` | | one line under the name. |
| `base` | | the address relative names resolve against. Left out, they resolve against the store file's own address. |
| `columns` | | the columns to narrow by, in order, each `{ "key": …, "label": … }`. The `key` is what each entry's `fields` are looked up by, and the `label` is what the facet is called — the key itself if there is none. |
| `group` | | the key of the column the rows belong to — a dataset, a species — so the list folds them under one heading per value. |
| `headline` | | the keys of the columns whose values a group's heading repeats. |
| `layout` | | `"list"`, the default, or `"cards"`: one card per value of `group` (see [Cards](#cards-one-per-group)). |
| `generatedAt`, `source` | | when, and from what, a script wrote the store: for people reading the file. |

### An entry

| Field | | What it is |
| --- | --- | --- |
| `label` | required | the row's name, and the name the file takes once open — on its tab, its map or its track. |
| `uri` | required | the file: a name relative to `base`, or a full address (see [Addresses](#addresses)). |
| `kind` | | `map`, `genome` or `workspace` (below). Left out, it is read from the file name. |
| `size` | | the file's size in bytes, drawn on the row so that a reader sees what a large file costs before pressing it. |
| `note` | | free text, shown on the row and matched by the search box: an accession, a paper, a replicate. |
| `fields` | | one value per column key, as text: `{ "assay": "Micro-C" }`. A number is written as a string, `"2"`. A column the entry has no value for is an empty cell. |
| `tracks` | | tracks published with this file, each `{ "label": …, "url": … }`, resolved like `uri`. Once the row is open, the Tracks card offers them in one press: *load the 2 tracks published with this map*. |

### Kinds of entry

- **`map`** — a contact map: `.cool`, `.mcool`, `.hic`, `.scool`, `.pairs` or a HiC-Pro matrix.
  Opened, it is the tab's map; added to a tab, it joins the deck beside the map in front.
- **`genome`** — anything else a file can be: a track, a reference sequence, a 3D model. Opened on its
  own it starts the [genome browser](/browse/genome-browser/) over its assembly; added to a tab with a
  map, it becomes a track — or a 3D model, in a cell of its own.
- **`workspace`** — a saved workspace, a `.chromosomix.json`, which opens as the tabs it holds (see
  [Saved sessions in a store](#saved-sessions-in-a-store)).

Left out, the kind is read from the file name: a `.json` is a workspace, a name the viewer opens as a
track or a sequence is a genome, and every other name is a map — including an address that does not
end in the file's own suffix. So give `kind` for any row whose address hides what the file is, such
as a Google Drive file, whose address ends in an id.

### What is refused, and what is dropped

The store as a whole is refused only when it is not one: not JSON, a JSON file with no
`"kind": "chromosomix.store"`, or a `version` this viewer does not read. A host that answers with a
web page — a sign-in wall does — is told apart from a missing file. Everything else is forgiving:

- an entry with no `label` or no `uri` is dropped, and the rest of the store opens;
- a value in `fields` that is not text, a track with no `url` and a column with no `key` are dropped;
- keys the viewer does not know are ignored, so a script can add a field before any viewer reads it.

The drawer draws the first thousand rows of what survives the reader's filters, and counts every row.

## Addresses

- **Relative to `base`.** `"base": "https://my-lab.s3.eu-west-3.amazonaws.com/hic/"` and
  `"uri": "wt/WT_G2M.mcool"` name `https://my-lab.s3.eu-west-3.amazonaws.com/hic/wt/WT_G2M.mcool`. A
  `base` with no trailing slash is given one, and a relative `base`, such as `"data/"`, is itself
  read against the store's address.
- **Relative to the store.** With no `base`, names are read against the store file's own address. A
  store published in the folder it describes is then self-contained: copy the folder to another
  bucket and it opens there unchanged.
- **Absolute.** A full address is left as it is, whatever its scheme, so one store can list your own
  bucket and a few files on 4DN's. Dropbox and Google Drive share links, `s3://` and `gs://` addresses
  are rewritten to the address that opens.
- **Inside a file, and beside it.** A `uri` may name one resolution of a multi-resolution map —
  `sample.mcool::/resolutions/10000` — and an index published elsewhere —
  `reads.bam#index=other/reads.bam.bai`, which is resolved like the name before it.

## Saved sessions in a store

A row can be a whole composed view rather than a bare file: the map with its tracks placed, its
colour scale, the window a figure used. Make it in the app — open the files, arrange them — and
use **Save every tab as a file**; publish the `.chromosomix.json` beside the data and list it as a
`workspace` row. Pressed, it opens as the tabs it holds, the way a `?config=` link opens one. A saved
workspace names its files by their full addresses; a name you make relative inside it is read against
the workspace's own address, like a store's.

### Cards, one per group

With `"layout": "cards"` and a `group`, the drawer draws a card for each value of the group instead of
a list, in the store's order — the shape of IGV's genome shelf:

- the card's button opens the group's first `workspace` row, or, where it has none, the row that
  carries `tracks`, with them;
- the chips under its name are the group's `headline` values, and the workspace row's own `tracks`
  field as a count — `"tracks": "8"` reads *8 tracks*;
- every other row of the group is under the card's fold, and a row whose name begins with the card's
  name is shown without it — *E. coli · insulation* reads *insulation* under the *E. coli* card;
- a row with no value for the group is kept, in a fold under the cards.

```json
{
  "kind": "chromosomix.store",
  "version": 1,
  "name": "Bacteria",
  "layout": "cards",
  "group": "species",
  "headline": ["strain"],
  "columns": [
    { "key": "species", "label": "Species" },
    { "key": "strain", "label": "Strain" }
  ],
  "entries": [
    {
      "label": "E. coli — map with tracks",
      "uri": "ecoli/ecoli.chromosomix.json",
      "kind": "workspace",
      "fields": { "species": "E. coli", "strain": "MG1655", "tracks": "8" }
    },
    {
      "label": "E. coli",
      "uri": "ecoli/ecoli.mcool",
      "kind": "map",
      "fields": { "species": "E. coli", "strain": "MG1655" }
    },
    {
      "label": "E. coli · insulation",
      "uri": "ecoli/insulation.bw",
      "kind": "genome",
      "fields": { "species": "E. coli" }
    }
  ]
}
```

A `layout` this viewer does not know, or `"cards"` with no `group`, is drawn as the list. In the list,
a `group` folds the rows under one heading per value, with the `headline` values on the heading and,
where a row of the group carries `tracks`, **open with its tracks**.

## Generating one from a bucket

A store of everything under a bucket prefix can be written by `make_store.py`, a single Python script
in the [repository](https://github.com/js2264/chromosomix/blob/main/scripts/make_store.py) that needs
Python 3.9 or later and nothing else installed:

```sh
curl -O https://raw.githubusercontent.com/js2264/chromosomix/main/scripts/make_store.py
python3 make_store.py bucket https://my-lab.s3.eu-west-3.amazonaws.com/hic/ \
  --name 'Lab Hi-C' --out store.json
python3 make_store.py check store.json
```

It writes one row for each file the viewer can open, with its size. A bucket knows nothing about a
file but its name and size, so the store has no columns — unless the folders under the prefix are
meaningful: `--folders Condition,Replicate` makes each level of folder a column, outermost first.
Add other columns by hand, or from your own sample sheet. `check` validates a store, and a saved
workspace, before you publish it.

The script lists the prefix as a public bucket is browsed, so the bucket must allow public listing of
it (see [A public bucket that can be browsed](/advanced/hosting/#a-public-bucket-that-can-be-browsed)).

## Hosting it

A store is published like any file, on a host that lets other sites read it — the CORS rule in
[Hosting your data](/advanced/hosting/) covers it. Two things differ from a data file:

- you will edit it in place, so give it a short cache lifetime: the repository's own scripts use
  `Content-Type: application/json` and `Cache-Control: public, max-age=300`. A year-long cache would
  go on showing readers the shelf as it was;
- it is read in one request, so it needs no byte ranges.

A store in a private bucket prefix is read with the bucket key that covers it, and one on Google
Drive or Cloud Storage with the site's Google key or the reader's Google sign-in — exactly as its rows
will be.

## Opening it

- **From the landing page.** Under **Connect to a data store**, press **Add a custom store**, paste
  the store's address and press **open**. The same tile is in the row at the head of the store drawer.
- **From a link.** `https://chromosomix.app/?store=https://my-lab.s3.eu-west-3.amazonaws.com/hic/store.json`
  opens the drawer on it, read. Percent-encode the address if it carries a `?` or an `&` of its own.
- **Narrowed.** The link button at the head of the drawer copies a link to the store as it is on
  screen: the search as `q=`, each ticked value as `<column>=<value>`, the matrix as
  `view=matrix&axes=<a>,<b>`.
- **Kept.** Once a store has been read from its address, **remember this store** makes it a tile of
  its own in this browser — its name and address, nothing more, listed under *What this browser is
  remembering*. **forget this store** on its page takes the tile away; nothing on the host changes.

While you are writing one, there is no need to publish between tries: **or paste the store** opens a
box for the JSON itself, with a box under it for the base address relative names hang off, and
**open what is pasted** reads it. **fill in an example** puts a working store in the box. A pasted
store is not remembered and not put in the address bar: a store worth keeping is one with an address.

The download button at the head of the drawer writes the catalogue as the drawer has it, with every
address made absolute, so the file it saves opens from anywhere.

## Keeping it up to date

The viewer keeps no copy of a store between visits: a remembered store is a name and an address, and
the file is read from your host each time a page opens it. So publishing a new version is uploading
the file again, and the next reader to open the store gets the new rows.

- Add new data under new names rather than replacing a file in place: a row, and every link that
  names it, then go on meaning the same file — and the data can keep its long cache lifetime.
- Run `make_store.py` again after an upload, or edit the rows you added by hand, then run `check`.
- Set `generatedAt` when a script writes the file, so readers of the JSON can tell which version
  they have.
