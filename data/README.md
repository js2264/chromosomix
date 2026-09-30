```
## For Hum53 and Hum66

for i in Hum53 Hum66; do

    cd ~/repos/metacooler.js/data/
    cp ~/rsg_fast/mmarbout/projets/MetaG/metacool/contigs_data/"$i"_contig_data_final.txt .
    cp ~/rsg_fast/mmarbout/projets/MetaG/metacool/metadata/"$i"_metadata.yaml .
    cp ~/rsg_fast/mmarbout/projets/MetaG/metacool/MAGs_data/"$i"_genome_table.tsv .
    cp ~/rsg_fast/mmarbout/projets/MetaG/metacool/PAIRS/"$i".pairs.gz .
    time metacooler create pairs --contigs "$i"_contig_data_final.txt --contigs-format metator --genomes "$i"_genome_table.tsv --bins 1000 --pairs "$i".pairs.gz --output "$i".metacool --force
    time metacooler create cool --contigs "$i"_contig_data_final.txt --contigs-format metator --genomes "$i"_genome_table.tsv --cool "$i".cool --output "$i"_from-cool.metacool --force
    time cooler cload pairs -c1 2 -p1 3 -c2 4 -p2 5 chrom-bins.1000.bed "$i".pairs.gz "$i".cool
    time metacooler zoomify --levels 3 "$i".metacool --output "$i".mmetacool --force
    time metacooler binnify --binsize 2000 "$i".metacool --output "$i"_2kb.metacool --force

done
```

## The chrXVI–M. mycoides reassembly (SPECS §27.11)

A long-read assembly of a yeast strain whose chromosome XVI carries the
*Mycoplasma mycoides* genome (32 contigs, `SGPMJH_1_MP366_1_reference.fa`), a
Hi-C map of the strain on it, and the theoretical genome it was built to be
(`W303_chrXVI-Mmmyco_inv870kb.fa` and its `.gtf`). `edit-method-reassembly.test.ts`
reads them from here and is skipped without them.

```
B=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/reassemblies
curl -o SGPMJH_1_MP366_1_Hi-C.mcool "$B/MP339c%5Emapped_SGPMJH_1_MP366_1_reference%5EJTMX6T.mcool"
curl -O "$B/SGPMJH_1_MP366_1_reference.fa"
curl -O "$B/W303_chrXVI-Mmmyco_inv870kb.fa"
curl -O "$B/W303_chrXVI-Mmmyco_inv870kb.gtf"
```

## The scrambled yeast demo (SPECS §27.5)

The demo `.hic` with its assembly made wrong where no picture cell has an edge —
IV turned from 403 to 797 kb, 196 kb of XI moved into II at 303 kb turned, IX
joined to III — every rung lifted through the scramble and written as
`scrambled/Yeast_scrambled.mcool`, with a session config under `out/scrambled/`
for `scripts/ui-edit-refine.mjs`:

```
npx vite-node scripts/make-scrambled-demo.ts
```
