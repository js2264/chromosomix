# Publishing a hub

A **hub** is one JSON file that names the maps, genome files and saved sessions on a bucket, with
columns to filter on, so a reader can choose one without opening any. The picker draws it as a
table; a lab connects one by pasting its URL or arrives on it with `?hub=<url>`. SPECS §24 is the
specification; this is the operator's page: how to write one, how to generate one, and how the two
portal hubs the app ships are kept fresh.

## The file

```json
{
  "kind": "metacooler.hub",
  "version": 1,
  "name": "Lab Hi-C",
  "description": "Everything under s3://my-lab/hic/, balanced at 1 kb.",
  "base": "https://my-lab.s3.eu-west-3.amazonaws.com/hic/",
  "columns": [
    { "key": "assembly", "label": "Assembly" },
    { "key": "condition", "label": "Condition" }
  ],
  "entries": [
    {
      "label": "WT, G2/M — map with tracks",
      "uri": "wt/WT_G2M.metacooler.json",
      "kind": "workspace",
      "fields": { "assembly": "S288C", "condition": "G2/M" },
      "note": "GSE000000 · rep1+rep2"
    },
    {
      "label": "WT, G2/M (mcool)",
      "uri": "wt/WT_G2M.mcool::resolutions/1000",
      "kind": "map",
      "size": 812345678,
      "fields": { "assembly": "S288C", "condition": "G2/M" },
      "tracks": [{ "label": "CTCF", "url": "wt/WT_CTCF.bw" }]
    }
  ]
}
```

- `kind` and `version` are what the parser checks first; anything else is tolerated, and unknown
  keys are ignored, so a generator can add a column before a viewer knows it.
- `base` is the prefix relative names resolve against. Leave it out and they resolve against the
  hub's own URL, which makes a hub *beside its data* a self-contained folder that can be copied to
  another bucket with everything it names — the same rule a saved workspace follows.
- `uri` may carry `::group` (`::resolutions/1000`) and `#index=`/`#bins=` sidecars exactly as any
  URI the viewer takes. Dropbox and Drive share links, `gs://` and `s3://` names are rewritten to
  the form that opens when the row is picked.
- `kind` is `map`, `genome` or `workspace`. Left out, it is read from the file name: `.json` is a
  workspace, the rest route as the folder view routes them. **A workspace row is a pre-configured
  session** — tracks placed, a colour scale, the window the figure used — opened through the same
  road as `?config=`.
- `size` is bytes. Give it when you know it: the table shows it, and the load gate can ask its
  question before the first request instead of after.
- `fields` hold one value per column key; a missing key is an empty cell. `note` is free text and
  is searched by the name filter.
- `tracks` are offered from the Tracks card once the row is open, the way the demo annotations are.

Serve it from anywhere that answers a cross-origin `GET` — a bucket with the public CORS policy in
[hosting.md](hosting.md), GitHub raw, a lab website. A hub in a **private** prefix is read with the
bucket key that covers it, and one on a Google host with the API key or the signed-in account,
exactly as its rows will be. Nothing is fetched until a reader chooses the hub.

## Generating one

`scripts/make_hub.py` needs nothing but Python 3.9 or newer — no `pip install`.

```bash
# A lab's own bucket: one row per openable object under the prefix, with sizes.
python3 scripts/make_hub.py bucket https://my-lab.s3.eu-west-3.amazonaws.com/hic/ \
    --name 'Lab Hi-C' --out hub.json

# The two portals, from their own search APIs (this is what the workflow runs).
python3 scripts/make_hub.py 4dn    --out out/4dn.json    --timestamp
python3 scripts/make_hub.py encode --out out/encode.json --timestamp

# Validate a hub somebody else wrote.
python3 scripts/make_hub.py check hub.json
```

`--timestamp` also writes a dated copy beside `--out`; `--limit N` caps the rows for a dry run;
`--formats hic,mcool,cool` narrows the 4DN front end; `--from-json` and `--from-xml` replay a
recorded response, which is how the tests run without a network. A run that finds **nothing exits
2 and writes nothing**, so a workflow never overwrites a good hub with an empty one.

The `bucket` front end lists with `ListObjectsV2`, so the prefix's bucket needs `s3:ListBucket`
granted to `*` for that prefix ([hosting.md](hosting.md), *Making a public bucket browsable*), or
run it from a machine whose AWS credentials cover it. It emits no columns: what a bucket knows about
a file is its name and its size. Add columns by hand, or generate them from your own sample sheet;
the format is plain JSON and the `check` front end will tell you if a row is malformed.

The `4dn` front end asks for every experiment set's processed files **with no experiment-type
filter**, so Micro-C and whatever the consortium publishes next are kept; the row's biosource, assay,
dataset, lab and condition come from the portal's `track_and_facet_info`. The `encode` front end
names each file by its `cloud_metadata.url`, the unsigned object on the `encode-public` bucket,
never by the portal's `@@download` path, which answers with a link presigned for `GET` alone.

## The two hubs the app ships

`.github/workflows/hubs.yml` — **Actions → Hubs** — runs both portal front ends every Monday and on
demand, uploads the pair as a timestamped workflow artifact (`hubs-<date>`, kept ninety days), and
publishes them to the `hubs` branch: `4dn.json`, `encode.json`, an `index.json` naming what is
there, and dated copies under `archive/`. The branch is the store, not the door: the deploy
(`.github/workflows/deploy.yml`) copies the three current files into `hubs/` beside the app on
every deploy, and the hubs workflow asks for a deploy as soon as it has published something new.
The picker's built-in **4DN open data** and **ENCODE Hi-C** hubs read `<site>/hubs/<name>.json` —
the same origin as the page, so no CORS is involved and a private repository changes nothing; the
desktop build reads the deployed site by the `homepage` in `package.json`.

Until the workflow has run once on a fork, those two menu entries answer *not generated yet* and
name the workflow to run. On the first run, check the "Generate both hubs" step's counts (well over
a thousand 4DN rows once the `.mcool` twins are in, around two hundred ENCODE rows), that `--check`
passed on both, that the deploy it asked for has finished, and that `<site>/hubs/4dn.json` answers
`200`. A second run must commit nothing when the portals answered the same thing, and then asks for
no deploy.

A fork that would rather publish its hubs elsewhere changes `hubsBase()` in `src/ui/examples.ts`
and the branch name in the two workflows; nothing else knows where they live.
