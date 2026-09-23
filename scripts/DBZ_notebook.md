## Data

```sh
cd ~/Downloads/Martial_DBZ
src=~/Documents/Koszul/__Bioinfo/repos/metacooler.js/scripts/DBZ_species.tsv

for species in $(cat ${src} | cut -f1); do
    file_basename=$(grep -e "${species}\t" $src | cut -f2)
    file=cool/${file_basename}.mcool
    ./hic-suite.sh ${file}
done
```

## Store

```sh
repo=~/Documents/Koszul/__Bioinfo/repos/metacooler.js

# store/ beside results/: maps, bigWigs, BEDs and BEDPEs hard-linked in, one session
# per species, and store.json listing them all. Re-run after hic-suite.sh.
python3 ${repo}/scripts/DBZ_store.py build ~/Downloads/Martial_DBZ

# Serve it with byte ranges and CORS, then open the link it prints
# (or paste http://127.0.0.1:8765/store.json under "Add a custom store").
python3 ${repo}/scripts/DBZ_store.py serve ~/Downloads/Martial_DBZ/store

# Publish it: the viewer's "DNA Bacterial Zoo" tile reads
# https://rsglab-data.s3.eu-west-3.amazonaws.com/dbz/store.json
aws s3 sync ~/Downloads/Martial_DBZ/store/ s3://rsglab-data/dbz/ --delete
```

