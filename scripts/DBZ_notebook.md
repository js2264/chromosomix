## Store

```sh
repo=~/Documents/Koszul/__Bioinfo/repos/metacooler.js
cd ${repo}

# The metacooler-run the suite drives, built from this checkout.
npm run build:cli

# Every map of scripts/DBZ_species.tsv, and its reference, found at any depth under
# ~/Downloads/metacooler/data/dbz; every step written straight into
# ~/Downloads/metacooler/data/dbz/store, which is then indexed: store.json lists every
# file of every species, and each species' session opens the map with its HiC score,
# insulation and E1 along both arms. `scripts/dbz-store.sh --help` for the settings;
# `scripts/dbz-store.sh PAK_MM142` for one sample, `STEPS="oriter compartments-arms"`
# for two steps again.
scripts/dbz-store.sh

# Serve it with byte ranges and CORS, then open the link it prints
# (or paste http://127.0.0.1:8765/store.json under "Add a custom store").
python3 scripts/DBZ_store.py serve ~/Downloads/metacooler/data/dbz/store

# Publish it: the viewer's "DNA Bacterial Zoo" tile reads
# https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.json
# The TSVs (tables, provenance) and the run logs stay on this machine.
aws s3 sync ~/Downloads/metacooler/data/dbz/store/ s3://rsglab-data/dbz/ --delete \
  --exclude '*.tsv' --exclude '*.log'
```
