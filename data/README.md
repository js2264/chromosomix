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
