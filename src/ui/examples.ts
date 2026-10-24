/**
 * The lab's own store: the demo workspaces published on the lab's bucket, and
 * the data files they are made of.
 *
 * They used to ship inside the bundle, in `public/demo/`, which put 250 MB of
 * Hi-C into every Pages artifact and every desktop checkout — and made the
 * deployed site read them through the *whole-object fallback*, because Pages
 * gzips `application/octet-stream` and a gzipped body cannot be range-read
 * (docs/hosting.md). Moving them to S3 fixes both at once: the app is a few MB
 * again, and the demos are now read the way §11 says a published dataset is
 * read — a `HEAD`, then bounded range `GET`s — which means the landing page
 * exercises the same path a reader's own bucket will.
 *
 * The price is the half of the hosting requirements that same-origin hosting
 * used to waive: the bucket must answer a CORS preflight and expose
 * `Content-Length` and `Content-Range`. That is bucket configuration, not code,
 * and `scripts/publish-demo.sh` applies it alongside the upload.
 *
 * **Every figure in the store is a workspace file, not a data file.** A `.cool`
 * in the list could only ever offer what dropping that file offers: a map at
 * its landing view, with nothing beside it. What a first-time reader should
 * meet is the application doing its job — a window worth looking at, tracks on
 * both edges of the map, three maps of one locus side by side — and all of that
 * is exactly what `state/workspace.ts` writes down. So the figures are
 * `.chromosomix.json` files that live next to the data they name, and choosing
 * one is the same gesture as dropping a workspace somebody sent you. The data
 * files are listed too, under each figure's fold, for the reader who wants the
 * `.mcool` alone — as rows, with the two verbs every store row has.
 *
 * The figures are filed under two headings (§24.2). **Demo** is what the viewer
 * does, ordered as an argument rather than by dataset: one map with its tracks,
 * then the same tracks with no map at all and close enough to read the reading
 * frames, then three maps of one locus side by side, then a human chromosome's
 * splicing in the 1D browser, then a time course in decks — the simplest
 * complete thing first. **Papers** is the figures of the lab's papers, each a
 * session over the data the paper published.
 *
 * A note on the format, because it is what made every one of these stop
 * opening once: `App.openWorkspaceFile` reads `kind: "chromosomix.workspace"`
 * and refuses anything else, so a published file still written in the older
 * single-session shape is a card that fails on click with "not a workspace".
 * The files in `demo/store/` are written by `scripts/make_rsg_store.py`, in the
 * current shape; the copies on the bucket are only as current as the last run
 * of `scripts/publish-store.sh`, which is the step that makes the store true.
 *
 * Each workspace sits in the bucket folder holding the files it names, and the
 * names *inside* it stay relative — resolved against the file's own URL on the
 * way in (`resolveConfig`). That is what keeps a card's folder a self-contained
 * thing: `demo/store/` can be copied to another bucket, or served off a laptop,
 * and every one of its workspaces still opens.
 */

import { splitUri } from './labels'
import type { StoreEntry, StoreFile } from '../state/store'
import { STORE_KIND, STORE_VERSION } from '../state/store'
import { devFeature, type DevFeature } from '../state/devFeatures'

declare const __DEMO_BASE__: string

/**
 * The published root, with its trailing slash: one folder per dataset under it.
 *
 * The repository's own `demo/` directory mirrors this — it is what
 * `scripts/publish-demo.sh` uploads and what `demo-examples.test.ts` checks —
 * with one exception: the store's folder, `demo/store/`, holds files of several
 * gigabytes that are copied into it on the bucket rather than kept in git, so
 * the repository carries its workspaces and `demo/store/MANIFEST.tsv`, which
 * names every file in it and where it comes from. The test reads the manifest
 * where it cannot read the file, so a name a workspace uses that the bucket
 * will not have is still a red CI run.
 */
export const DEMO_BUCKET = 'https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/'

/**
 * Where to read the demos from, when it is not {@link DEMO_BUCKET}.
 *
 * Empty in both shipped builds, which is what makes the web target and the
 * desktop target read the identical URLs. The override survives as a
 * build-time escape hatch (`DEMO_BASE=… vite build`) for the two cases that
 * want it: a fork publishing its own bucket, and `python3 -m http.server` over
 * a local copy of `demo/` when the network is not available.
 *
 * `typeof` because `vitest` applies no `define` block (see `version.ts`).
 */
const DEMO_BASE: string = typeof __DEMO_BASE__ === 'string' ? __DEMO_BASE__ : ''

/**
 * The headings the store's figures are filed under, in the order they stand.
 *
 * *Demo* is what the viewer does; *Papers* is the figures of the lab's papers,
 * each card a session over the data the paper published (§24.2).
 */
export type DemoSection = 'Demo' | 'Papers'

/**
 * The paper's GM12878 files (Figs. 1a and 2): the folder's path, its label, its kind, its format and its
 * assembly — 4DN's map, ENCODE's ChIA-PET map and tracks, UCSC's sequence and genes, and what the app
 * computed on them.
 */
const PAPER_HUMAN = [
  ['human/4DNFIXP4QG5B.mcool', 'GM12878 Hi-C, 4.0 billion contacts (Rao et al. 2014, 4DN)', 'map', 'mcool', 'hg38'],
  ['human/ENCFF379AWZ.hic', 'GM12878 CTCF ChIA-PET, Ruan lab (ENCODE ENCSR184YZV)', 'map', 'hic', 'hg38'],
  ['human/hg38.2bit', 'Human sequence, UCSC hg38', 'genome', '2bit', 'hg38'],
  ['human/hg38.refGene.txt.gz', 'RefSeq genes, UCSC hg38', 'genome', 'genepred', 'hg38'],
  ['human/ENCFF734CUT.bigWig', 'CTCF ChIP-seq, Broad (ENCODE ENCSR000AKB)', 'genome', 'bigwig', 'hg38'],
  ['human/ENCFF485CGE.bigWig', 'CTCF ChIP-seq, Stanford (ENCODE ENCSR000DZN)', 'genome', 'bigwig', 'hg38'],
  ['human/ENCFF156URE.bigBed', 'CTCF peaks, conservative IDR (ENCODE)', 'genome', 'bigbed', 'hg38'],
  ['human/ENCFF487LOB.bigWig', 'ATAC-seq (ENCODE ENCSR095QNB)', 'genome', 'bigwig', 'hg38'],
  ['human/ENCFF928SQL.bigBed', 'ATAC-seq peaks (ENCODE)', 'genome', 'bigbed', 'hg38'],
  ['human/ENCFF990PUN.bigWig', 'Total RNA-seq, plus strand (ENCODE ENCSR000AEC)', 'genome', 'bigwig', 'hg38'],
  ['human/ENCFF005BFP.bigWig', 'Total RNA-seq, minus strand (ENCODE ENCSR000AEC)', 'genome', 'bigwig', 'hg38'],
  ...([5, 10, 20, 40] as const).map(
    (w) =>
      [`human/4DNFIXP4QG5B_10000.insulation-w${w}.bw`, `Diamond insulation, 10 kb, ${w * 10}-kb window`, 'genome', 'bigwig', 'hg38'] as const,
  ),
  ['human/4DNFIXP4QG5B_10000.borders.bed', 'Borders on the insulation, 10 kb', 'genome', 'bed', 'hg38'],
  ['human/GM12878_CTCF.peaks.bed', 'CTCF peaks called on both labs’ ChIP-seq, IDR ≤ 0.05', 'genome', 'bed', 'hg38'],
  ['human/GM12878_CTCF.consecutive.bedpe', 'Consecutive CTCF peaks, paired', 'genome', 'bedpe', 'hg38'],
  ['human/4DNFIXP4QG5B_2000.chr14.insulation-w50.bw', 'Diamond insulation of chr14, 2 kb', 'genome', 'bigwig', 'hg38'],
  ['human/4DNFIXP4QG5B_2000.chr14.borders.bed', 'Borders on chr14’s insulation, 2 kb', 'genome', 'bed', 'hg38'],
  ['human/4DNFIXP4QG5B_250000.compartments-e1.bw', 'Compartments (E1), 250 kb', 'genome', 'bigwig', 'hg38'],
  ['human/4DNFIXP4QG5B_250000.compartments-ab.bed', 'A and B compartments, 250 kb', 'genome', 'bed', 'hg38'],
  ['human/4DNFIXP4QG5B_5000.4c-chr14-89150001-89180000.bw', '4C from chr14:89,150,001-89,180,000, O/E', 'genome', 'bigwig', 'hg38'],
  ['human/4DNFIXP4QG5B_2000.chr14-88.55-90.10Mb.bed3d', '3D model of chr14:88.55–90.10 Mb, 2 kb', 'genome', 'bed3d', 'hg38'],
  ['human/hg38.CTCF-motifs.bed', 'CTCF motif sites, hg38', 'genome', 'bed', 'hg38'],
] as const

/** The paper's *B. subtilis* time course, a map a condition: the store's name, and the condition as Fig. S3b says it. */
const PAPER_SUBTILIS = [
  ['WT', 'WT'],
  ['dparAB', 'ΔparAB'],
  ['induction_0min', '+parB 0 min'],
  ['induction_15min', '+parB 15 min'],
  ['induction_20min', '+parB 20 min'],
  ['induction_30min', '+parB 30 min'],
  ['induction_35min', '+parB 35 min'],
  ['induction_45min', '+parB 45 min'],
] as const

/** The paper's *P. aeruginosa* maps, a strain each: the lab's sample, and the genotype as Fig. S3c says it. */
const PAPER_AERUGINOSA = [
  ['PAO1_v3_MM38', 'WT'],
  ['PAO1_v3_FG0235', 'SMC-ScpAB–'],
  ['PAO1_v3_FG0238', 'MksBEF–'],
] as const

/**
 * The figures, in the order they are offered.
 *
 * Each card says enough to choose and no more: a `title`, one `line` on what
 * is on screen, the `assembly`, and where the data came from (`provenance`,
 * the accession or the DOI, because a demo with no provenance is a screenshot).
 * The paragraph that used to be the whole row is `detail`, behind a fold on the
 * card: it says what the *session* adds on top of the file, which is the part a
 * reader cannot see from the name.
 *
 * `folder` is the card's own directory under {@link DEMO_BUCKET}, and its
 * `files` are named from there: entries sharing a folder — as the three yeast
 * figures do — are that many figures over one copy of the data, not that many
 * copies of it, and a `../` reaches a file another card's folder holds.
 */
const DEMO: Array<{
  section: DemoSection
  folder: string
  file: string
  title: string
  line: string
  assembly: string
  provenance: string
  detail: string
  /** The data files the session is made of, from its folder — its card's *N files* fold. */
  files: string[]
  /** The dev feature this figure belongs to, if it is one (§29): absent from the store while it is off. */
  dev?: DevFeature
}> = [
  {
    section: 'Demo',
    folder: 'store/yeast',
    file: 'Yeast_microC.chromosomix.json',
    title: 'Yeast micro-C',
    line: 'One map at 1.6 kb, with the sequence, genes, RNA-seq, ATAC, MNase, shotgun, SNPs and its loops.',
    assembly: 'S288C (R64)',
    provenance: 'GEO GSE151553 · DOI 10.7554/eLife.59889',
    detail:
      'Micro-C XL of strain A364A (Costantino et al. 2020), balanced, opened on 400 kb of chromosome XIV ' +
      'at 1.6 kb — a window with a weight for every bin. The sequence and the gene model run along both ' +
      'edges; under the map, RNA-seq of a wild type and a mutant, two replicates each, drawn as one chart ' +
      'per gene; ATAC, MNase and shotgun coverage; and SNPs in sixteen samples of wine, ale, lager, bioethanol ' +
      'and other strains. The 636 loops drawn on it were called on this map by the app’s own Chromosight.',
    files: [
      'GSE151553_A364_merged.mcool',
      'S288c.fa',
      'S288c.gtf',
      'Yeast_RNAseq.barChart',
      'Yeast_ATAC.bw',
      'Yeast_MNase.bw',
      'Yeast_shotgun.bw',
      'Yeast_snps.vcf.gz',
      'Yeast_microC_loops.bedpe',
    ],
  },
  {
    section: 'Demo',
    folder: 'store/yeast',
    file: 'Yeast_landscape.chromosomix.json',
    title: 'Yeast chromatin landscape',
    line: 'No map, and close: 5.5 kb of chromosome XIV with its six reading frames, the genes, RNA-seq by sample, ATAC, MNase, shotgun and SNPs.',
    assembly: 'S288C (R64)',
    provenance: 'Ensembl R64-1-1 · GEO GSE151553 (the map’s tracks)',
    detail:
      'The same tracks with no contact map, opened from the FASTA alone at RHO5, RPS3 and MRPL22. Close ' +
      'enough for the sequence lane to draw the six reading frames under it — starts in green, stops in ' +
      'red — so an open reading frame reads as a run of grey between two red marks, and lines up with the ' +
      'gene above it. RNA-seq is one chart per gene, wild type against mutant on a 0–400 CPM axis; ATAC ' +
      'and MNase share a group and each keep their own axis, so the nucleosome-free promoter and the ' +
      'array beside it are read together.',
    files: [
      'S288c.fa',
      'S288c.gtf',
      'Yeast_RNAseq.barChart',
      'Yeast_ATAC.bw',
      'Yeast_MNase.bw',
      'Yeast_shotgun.bw',
      'Yeast_snps.vcf.gz',
    ],
  },
  {
    section: 'Demo',
    folder: 'store/yeast',
    file: 'Yeast_HiC_microC_PCP.chromosomix.json',
    title: 'Hi-C, micro-C and PCP',
    line: 'One locus by three methods, side by side, each map with MNase and the genes under it.',
    assembly: 'S288C (R64); W303 for the Hi-C',
    provenance: 'GEO GSE151553 · GSE217022 · GSM8476641',
    detail:
      'Three maps of chrXV:200–400 kb in one deck: Hi-C of G1 cells carrying the M. mycoides chromosome at ' +
      '1 kb (Meneu et al. 2025), micro-C XL of A364A at 1.6 kb (Costantino et al. 2020) and PCP — proximity ' +
      'copy paste — of G1 cells at 1 kb (Delamarre et al.), drawn as counts since the file carries no ' +
      'weights. The files share no resolution, so each is read at the one nearest the others. The Hi-C ' +
      'strain is W303, whose chromosome XV lies within 26 bp of S288C’s here, so one window is one place ' +
      'in all three; MNase and the S288C genes are under every map.',
    files: [
      'GSE151553_A364_merged.mcool',
      '../meneu2025/HiC/HiC_Mmyco_G1.mcool',
      'Yeast_PCP_GSM8476641_G1_rep1.mcool',
      'Yeast_MNase.bw',
      'S288c.gtf',
    ],
  },
  {
    section: 'Demo',
    folder: 'store/human',
    file: 'Human_chrX_splicing.chromosomix.json',
    title: 'Splicing on human chrX',
    line: 'The 1D browser over hg19’s karyotype: a sashimi plot from reads, and two samples’ junctions on one axis.',
    assembly: 'hg19 (GRCh37)',
    provenance: 'Geuvadis · DOI 10.1038/nature12531 · nf-core/test-datasets rnasplice',
    detail:
      'The browser opened from UCSC’s hg19 cytoBand alone — its bands tile each chromosome, so it ' +
      'declares the genome — at RPL10 in Xq28. Under the ideogram, the Ensembl gene model; one ' +
      'lymphoblastoid sample’s reads as depth, with the introns they skip drawn over it as arcs ' +
      'and counted; and STAR’s junction tables for a GBR and a YRI sample, both read against one ' +
      'typed axis of 1 to 500 reads so their arcs compare. Pan out to FLNA to see the reverse ' +
      'strand’s arcs hang below the line, or type a band — Xq13 — in the locus box.',
    files: [
      'hg19_cytoBand.txt',
      'Homo_sapiens.GRCh37.chrX.gtf.gz',
      'Geuvadis_chrX_GBR_ERR188428.bam',
      'Geuvadis_chrX_GBR_ERR188428.SJ.out.tab',
      'Geuvadis_chrX_YRI_ERR188454.SJ.out.tab',
    ],
  },
  {
    section: 'Demo',
    folder: 'store/gibcus2018',
    file: 'Gibcus2018_mitosis.chromosomix.json',
    title: 'Mitotic chromosome formation',
    line: 'Chicken DT40 cells from G2 into prometaphase: six Hi-C maps of the time course, in three decks.',
    assembly: 'galGal5',
    provenance: '4DN · Gibcus et al. 2018 · DOI 10.1126/science.aao6135',
    detail:
      'One synchronous release from a G2 block, at G2, 5, 10, 15, 30 and 60 min (Gibcus et al. 2018, from ' +
      'the 4DN Data Portal), in three tabs: chromosome 7 whole at 250 kb, where the checkerboard of ' +
      'compartments is gone by 10 min and a broad mitotic band takes the diagonal; 40 Mb of chromosome 1 ' +
      'at 100 kb with each time point’s first eigenvector under its map; and 4 Mb of it at 25 kb, at G2, ' +
      '5 and 60 min, with their insulation on one axis as the domains disappear.',
    files: [
      'G2_4DNFIT479GDR.mcool',
      '5m_4DNFINSJ2GYV.mcool',
      '10m_4DNFIYOEGHHV.mcool',
      '15m_4DNFILKIISAU.mcool',
      '30m_4DNFI165SFJU.mcool',
      '60m_4DNFIWHQLZTL.mcool',
      'G2_4DNFILLAMSTE_compartments.bw',
      '5m_4DNFI9HASBHH_compartments.bw',
      '10m_4DNFIG48YRMT_compartments.bw',
      '15m_4DNFIY1KBU1S_compartments.bw',
      '30m_4DNFIOCFXWMD_compartments.bw',
      '60m_4DNFIX92O41_compartments.bw',
      'G2_4DNFI1PRBI5L_diamond.bw',
      '5m_4DNFIIAPL9WO_insulation.bw',
      '60m_4DNFI12IF3LX_diamond.bw',
    ],
  },
  {
    section: 'Demo',
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.chromosomix.json',
    title: 'Mock microbial community',
    line: '49 MAGs over 20,566 contigs in one .metacool — the multi-genome file this viewer exists for.',
    assembly: 'mock community',
    provenance: 'SRA SRR32680160 · DOI 10.1038/s41564-025-02108-2',
    detail:
      'A MetaTOR binning of a mock community profiled by metaHiC: 49 genomes over 20,566 ' +
      'contigs in one 1 kb .metacool (14 MB). Lands on the genomes table, largest MAG first.',
    files: ['Mock_microbial_community.metacool', 'Mock_microbial_community.mmetacool'],
    dev: 'metacool',
  },
  {
    section: 'Papers',
    folder: 'store/chromosomix_paper',
    file: 'Chromosomix_paper.chromosomix.json',
    title: 'The Chromosomix paper',
    line: 'Seven tabs, a panel each: GM12878 Hi-C with its tracks and model (Fig. 1a) and at CTCF’s sites (Fig. 2), mouse ES-cell Hi-C from the whole genome down to Sox2 (Fig. 1c, d), and three bacteria read along their arms (Fig. S3a–c).',
    assembly: 'hg38 · mm10 · C. necator N-1 · B. subtilis PY79 · P. aeruginosa',
    provenance: '4DN 4DNFIXP4QG5B · Rao et al. 2014 · ENCODE · 4DN 4DNFI5QJNFAT · Kubo et al. 2021 · Huang et al. 2021 · GEO GSE76513',
    detail:
      'The data of the paper’s figures, a tab a panel. Fig. 1a: in situ Hi-C of GM12878 (Rao et al. 2014, a 27-GB ' +
      '.mcool of 4.0 billion contacts, from 4DN) at 5 kb over chr14:88.55–90.10 Mb, three cells across: the map, ' +
      'with ENCODE’s CTCF ChIA-PET of GM12878 (a .hic) in its lower triangle and both as observed over expected, ' +
      'its insulation and borders above it, its compartments and E1 at its left and the 4C profile from ' +
      'chr14:89,150,001-89,180,000 under it, and the TAD and its borders marked; a tracks cell with ENCODE’s CTCF, ' +
      'ATAC-seq and RNA-seq, CTCF’s motif, ATAC peaks, UCSC’s refGene and hg38 sequence; and the model the app ' +
      'inferred from the map, its TAD borders as beads and every bead coloured by its distance to one pinned in the ' +
      'central sub-TAD. Fig. 2: the same map ' +
      'on chr19 at 10 kb with two labs’ CTCF ChIP-seq and ATAC-seq, and nothing computed: the Analysis column opens ' +
      'each task of the figure’s chain on its recipe — insulation at four scales, the peaks on the two CTCF tracks, ' +
      'the APA between each peak and the next at 2 kb, and the metaplots. Fig. 1c: in situ Hi-C of F123 mouse embryonic stem ' +
      'cells (a 7-GB .mcool of 1.07 billion contacts) at five scales side by side — the genome at 2.5 Mb, chromosome 3 ' +
      'as the correlation of its observed/expected at 250 kb, chr3:27–37 Mb at 10 kb, the Sox2 locus as ' +
      'observed/expected at 5 kb with its loops, and Sox2 with its control region at 2 kb — each with the tracks the ' +
      'panel draws under it, and under each the model the app inferred at that scale. Fig. 1d: chr3:32–36 Mb at 10 kb ' +
      'with its insulation, borders and CTCF, beside chromosome 3’s model coloured by CTCF. Fig. S3a: C. necator’s ' +
      'first chromosome, its origin in the middle, over the decay along the diagonal and then along both arms. ' +
      'Fig. S3b: B. subtilis wild type, ΔparAB, and six times after ParB is induced. Fig. S3c: P. aeruginosa wild type, ' +
      'SMC-ScpAB– and MksBEF–, as the correlation along both arms, with each strain’s E1 under its map and the ' +
      'wild type’s RNA-seq (PAK, GEO GSE76513) under its own. A deck keeps ' +
      'one look a map, so a panel reading one map several ways opens on one of them; each map’s score picker has the ' +
      'others.',
    files: [
      ...PAPER_HUMAN.map(([file]) => file),
      'mouse/4DNFI5QJNFAT.mcool',
      'mouse/mm10_genes.gtf.gz',
      'mouse/4DNFIFFXFV82.bw',
      'mouse/4DNFIXE23VC7.bw',
      'mouse/4DNFIQYJLKKH.bw',
      'mouse/4DNFI5QJNFAT_250000.compartments-e1.bw',
      'mouse/4DNFI5QJNFAT_250000.compartments-ab.bed',
      'mouse/4DNFI5QJNFAT_10000.insulation-w10.bw',
      'mouse/4DNFI5QJNFAT_10000.borders.bed',
      'mouse/4DNFI5QJNFAT_10000.domains.bed',
      'mouse/4DNFI5QJNFAT_5000.loops.bedpe',
      'mouse/4DNFI5QJNFAT_2500000.genome.bed3d',
      'mouse/4DNFI5QJNFAT_250000.chr3.bed3d',
      'mouse/4DNFI5QJNFAT_10000.chr3-27-37Mb.bed3d',
      'mouse/4DNFI5QJNFAT_5000.chr3-34-35Mb.bed3d',
      'mouse/4DNFI5QJNFAT_2000.Sox2-SCR.bed3d',
      'C_necator/C_necator_N1_VJ_MM260.mcool',
      'C_necator/C_necator_N1_VJ.fa',
      'C_necator/C_necator_N1_VJ_MM260_4000.oriter-loci.bed',
      'C_necator/C_necator_N1_VJ_MM260_4000.gc-skew-cumulative.bw',
      ...PAPER_SUBTILIS.map(([name]) => `B_subtilis/Bsubtilis_${name}.mcool`),
      'B_subtilis/PY79.fa',
      'B_subtilis/PY79.gff3',
      ...PAPER_AERUGINOSA.map(([sample]) => `P_aeruginosa/${sample}.mcool`),
      'P_aeruginosa/PAO1_v3.fa',
      'P_aeruginosa/GSE76513_PAK_T0_pooled.unstranded.CPM.bw',
      ...PAPER_AERUGINOSA.map(([sample]) => `P_aeruginosa/${sample}_8000.e1-arms.bw`),
    ],
  },
  {
    section: 'Papers',
    folder: 'store/meneu2025',
    file: 'Meneu2025_bacterial_chromosomes.chromosomix.json',
    title: 'Bacterial chromosomes in a yeast nucleus',
    line: 'Yeast carrying an M. mycoides or an M. pneumoniae chromosome: each with its nucleosomes, transcription and cohesin, then both genomes whole.',
    assembly: 'W303 + M. mycoides; S288C + M. pneumoniae',
    provenance: 'GEO GSE217022 · DOI 10.1126/science.adm9466',
    detail:
      'Meneu et al. 2025, in two tabs. First the two bacterial chromosomes in G2/M, side by side at 4 kb ' +
      '— M. mycoides’s 1.2 Mb and M. pneumoniae’s 818 kb, each cell on its own chromosome — with the ' +
      'genes, MNase (130–200 bp fragments), RNA-seq on both strands, and Pol II and Scc1 ChIP over input ' +
      'under each. Then the two strains in G1, whole genome at 16 kb, each bacterial chromosome beside ' +
      'the sixteen of yeast.',
    files: [
      'HiC/HiC_Mmyco_G2M.mcool',
      'HiC/HiC_Mpneumo_G2M.mcool',
      'HiC/HiC_Mmyco_G1.mcool',
      'HiC/HiC_Mpneumo_G1.mcool',
      'genome_references/W303_Mmmyco.gff3',
      'genome_references/S288c_Mpneumo.gtf',
      'MNase/MNase_Mmyco_rep1.130-200.CPM.bw',
      'MNase/MNase_Mpneumo_rep1.130-200.CPM.bw',
      'RNA/RNAseq_Mmyco_rep1.fwd-CPM.bw',
      'RNA/RNAseq_Mmyco_rep1.rev-CPM.bw',
      'RNA/RNAseq_Mpneumo_rep1.fwd-CPM.bw',
      'RNA/RNAseq_Mpneumo_rep1.rev-CPM.bw',
      'ChIP/PolII_Mmyco_rep1.vs-input.bw',
      'ChIP/PolII_Mpneumo_rep1.vs-input.bw',
      'ChIP/Scc1_Mmyco_rep1.vs-input.bw',
      'ChIP/Scc1_Mpneumo_rep1.vs-input.bw',
    ],
  },
]

/**
 * The data files under the figures, one row each.
 *
 * What the store lists *besides* the figures: every file the figures are made
 * of, so a reader who wants the micro-C map alone, the MNase bigWig on their
 * own map, or the metagenome as an `.mmetacool` ladder, has a row to press.
 * Each figure's card lists its own rows under a fold (`ui/stores/GalleryView.ts`);
 * a row shared by two figures — the yeast tracks, the Meneu paper's G1 Hi-C —
 * is one row, under each.
 */
const DEMO_DATA: Array<{
  folder: string
  file: string
  label: string
  kind: 'map' | 'genome'
  format: string
  assembly: string
  dataset: string
  /** The dev feature this file belongs to, if it is one (§29). */
  dev?: DevFeature
}> = [
  ...(
    [
      ['GSE151553_A364_merged.mcool', 'Yeast micro-C, A364A', 'map', 'mcool'],
      // The same counts as a Juicer .hic, which is the only contact map an
      // assembly hub can name — the hub example in the paste box points at it.
      ['GSE151553_A364_merged.hic', 'Yeast micro-C, A364A, as a .hic', 'map', 'hic'],
      ['Yeast_PCP_GSM8476641_G1_rep1.mcool', 'Yeast PCP, G1', 'map', 'mcool'],
      ['S288c.fa', 'S288C sequence', 'genome', 'fasta'],
      // The same sequence packed at two bits a base (§8.21). Beside the FASTA
      // rather than instead of it, because the two are read by different roads:
      // a FASTA under the whole-read limit is held whole, a `.2bit` is read by
      // range and is what an assembly hub names.
      ['S288c.2bit', 'S288C sequence, as a .2bit', 'genome', '2bit'],
      ['S288c.gtf', 'Genes', 'genome', 'gtf'],
      ['Yeast_RNAseq.barChart', 'RNA-seq, wild type and mutant, CPM per gene', 'genome', 'barChart'],
      ['Yeast_ATAC.bw', 'ATAC-seq', 'genome', 'bigwig'],
      ['Yeast_MNase.bw', 'MNase-seq', 'genome', 'bigwig'],
      ['Yeast_shotgun.bw', 'Shotgun coverage', 'genome', 'bigwig'],
      ['Yeast_snps.vcf.gz', 'SNPs, 16 samples', 'genome', 'vcf'],
      ['Yeast_microC_loops.bedpe', 'Micro-C loop calls', 'genome', 'bedpe'],
    ] as const
  ).map(([file, label, kind, format]) => ({
    folder: 'store/yeast',
    file,
    label,
    kind,
    format,
    assembly: 'S288C (R64)',
    dataset: 'Yeast',
  })),
  ...(
    [
      ['hg19_cytoBand.txt', 'Human karyotype, UCSC’s bands', 'cytoBand'],
      ['Homo_sapiens.GRCh37.chrX.gtf.gz', 'Genes, chromosome X', 'gtf'],
      ['Geuvadis_chrX_GBR_ERR188428.bam', 'RNA-seq reads, GBR ERR188428', 'bam'],
      ['Geuvadis_chrX_GBR_ERR188383.SJ.out.tab', 'Splice junctions, GBR ERR188383', 'SJ.out.tab'],
      ['Geuvadis_chrX_GBR_ERR188428.SJ.out.tab', 'Splice junctions, GBR ERR188428', 'SJ.out.tab'],
      ['Geuvadis_chrX_YRI_ERR188454.SJ.out.tab', 'Splice junctions, YRI ERR188454', 'SJ.out.tab'],
      ['Geuvadis_chrX_YRI_ERR204916.SJ.out.tab', 'Splice junctions, YRI ERR204916', 'SJ.out.tab'],
      ['Geuvadis_chrX_GBR_ERR188428.junctions.bed', 'Splice junctions as regtools writes them', 'junctions.bed'],
    ] as const
  ).map(([file, label, format]) => ({
    folder: 'store/human',
    file,
    label,
    kind: 'genome' as const,
    format,
    assembly: 'hg19 (GRCh37)',
    dataset: 'Human, Geuvadis chrX',
  })),
  ...(
    [
      ['G2', 'G2_4DNFIT479GDR', 'G2_4DNFILLAMSTE', 'G2_4DNFI1PRBI5L_diamond'],
      ['5 min', '5m_4DNFINSJ2GYV', '5m_4DNFI9HASBHH', '5m_4DNFIIAPL9WO_insulation'],
      ['10 min', '10m_4DNFIYOEGHHV', '10m_4DNFIG48YRMT', null],
      ['15 min', '15m_4DNFILKIISAU', '15m_4DNFIY1KBU1S', null],
      ['30 min', '30m_4DNFI165SFJU', '30m_4DNFIOCFXWMD', null],
      ['60 min', '60m_4DNFIWHQLZTL', '60m_4DNFIX92O41', '60m_4DNFI12IF3LX_diamond'],
    ] as const
  ).flatMap(([when, map, e1, insulation]) => [
    { file: `${map}.mcool`, label: `DT40 Hi-C, ${when}`, kind: 'map' as const, format: 'mcool' },
    { file: `${e1}_compartments.bw`, label: `Compartments (E1), ${when}`, kind: 'genome' as const, format: 'bigwig' },
    ...(insulation === null
      ? []
      : [{ file: `${insulation}.bw`, label: `Insulation, ${when}`, kind: 'genome' as const, format: 'bigwig' }]),
  ]).map((row) => ({ ...row, folder: 'store/gibcus2018', assembly: 'galGal5', dataset: 'Gibcus et al. 2018' })),
  ...(
    [
      ['HiC/HiC_Mmyco_G2M.mcool', 'Hi-C, M. mycoides, G2/M', 'map', 'mcool', 'W303 + M. mycoides'],
      ['HiC/HiC_Mpneumo_G2M.mcool', 'Hi-C, M. pneumoniae, G2/M', 'map', 'mcool', 'S288C + M. pneumoniae'],
      ['HiC/HiC_Mmyco_G1.mcool', 'Hi-C, M. mycoides, G1', 'map', 'mcool', 'W303 + M. mycoides'],
      ['HiC/HiC_Mpneumo_G1.mcool', 'Hi-C, M. pneumoniae, G1', 'map', 'mcool', 'S288C + M. pneumoniae'],
      ['genome_references/W303_Mmmyco.gff3', 'Genes, W303 and M. mycoides', 'genome', 'gff3', 'W303 + M. mycoides'],
      ['genome_references/S288c_Mpneumo.gtf', 'Genes, S288C and M. pneumoniae', 'genome', 'gtf', 'S288C + M. pneumoniae'],
      ['MNase/MNase_Mmyco_rep1.130-200.CPM.bw', 'MNase-seq, M. mycoides', 'genome', 'bigwig', 'W303 + M. mycoides'],
      ['MNase/MNase_Mpneumo_rep1.130-200.CPM.bw', 'MNase-seq, M. pneumoniae', 'genome', 'bigwig', 'S288C + M. pneumoniae'],
      ['RNA/RNAseq_Mmyco_rep1.fwd-CPM.bw', 'RNA-seq +, M. mycoides', 'genome', 'bigwig', 'W303 + M. mycoides'],
      ['RNA/RNAseq_Mmyco_rep1.rev-CPM.bw', 'RNA-seq −, M. mycoides', 'genome', 'bigwig', 'W303 + M. mycoides'],
      ['RNA/RNAseq_Mpneumo_rep1.fwd-CPM.bw', 'RNA-seq +, M. pneumoniae', 'genome', 'bigwig', 'S288C + M. pneumoniae'],
      ['RNA/RNAseq_Mpneumo_rep1.rev-CPM.bw', 'RNA-seq −, M. pneumoniae', 'genome', 'bigwig', 'S288C + M. pneumoniae'],
      ['ChIP/PolII_Mmyco_rep1.vs-input.bw', 'Pol II over input, M. mycoides', 'genome', 'bigwig', 'W303 + M. mycoides'],
      ['ChIP/PolII_Mpneumo_rep1.vs-input.bw', 'Pol II over input, M. pneumoniae', 'genome', 'bigwig', 'S288C + M. pneumoniae'],
      ['ChIP/Scc1_Mmyco_rep1.vs-input.bw', 'Scc1 over input, M. mycoides', 'genome', 'bigwig', 'W303 + M. mycoides'],
      ['ChIP/Scc1_Mpneumo_rep1.vs-input.bw', 'Scc1 over input, M. pneumoniae', 'genome', 'bigwig', 'S288C + M. pneumoniae'],
    ] as const
  ).map(([file, label, kind, format, assembly]) => ({
    folder: 'store/meneu2025',
    file,
    label,
    kind,
    format,
    assembly,
    dataset: 'Meneu et al. 2025',
  })),
  ...(
    [
      ...PAPER_HUMAN,
      ['mouse/4DNFI5QJNFAT.mcool', 'Mouse ES-cell Hi-C (4DN)', 'map', 'mcool', 'mm10'],
      ['mouse/mm10_genes.gtf.gz', 'Genes, UCSC mm10', 'genome', 'gtf', 'mm10'],
      ['mouse/4DNFIFFXFV82.bw', 'CTCF ChIP-seq', 'genome', 'bigwig', 'mm10'],
      ['mouse/4DNFIXE23VC7.bw', 'H3K27ac ChIP-seq', 'genome', 'bigwig', 'mm10'],
      ['mouse/4DNFIQYJLKKH.bw', 'H3K4me3 ChIP-seq', 'genome', 'bigwig', 'mm10'],
      ['mouse/4DNFI5QJNFAT_250000.compartments-e1.bw', 'Compartments (E1) of chromosome 3, 250 kb', 'genome', 'bigwig', 'mm10'],
      ['mouse/4DNFI5QJNFAT_250000.compartments-ab.bed', 'A and B compartments of chromosome 3, 250 kb', 'genome', 'bed', 'mm10'],
      ['mouse/4DNFI5QJNFAT_10000.insulation-w10.bw', 'Diamond insulation, 10 kb', 'genome', 'bigwig', 'mm10'],
      ['mouse/4DNFI5QJNFAT_10000.borders.bed', 'Borders on the insulation, 10 kb', 'genome', 'bed', 'mm10'],
      ['mouse/4DNFI5QJNFAT_10000.domains.bed', 'Domains between the borders, 10 kb', 'genome', 'bed', 'mm10'],
      ['mouse/4DNFI5QJNFAT_5000.loops.bedpe', 'Loops on chromosome 3, 5 kb', 'genome', 'bedpe', 'mm10'],
      ['mouse/4DNFI5QJNFAT_2500000.genome.bed3d', '3D model of the genome, 2.5 Mb', 'genome', 'bed3d', 'mm10'],
      ['mouse/4DNFI5QJNFAT_250000.chr3.bed3d', '3D model of chromosome 3, 250 kb', 'genome', 'bed3d', 'mm10'],
      ['mouse/4DNFI5QJNFAT_10000.chr3-27-37Mb.bed3d', '3D model of chr3:27–37 Mb, 10 kb', 'genome', 'bed3d', 'mm10'],
      ['mouse/4DNFI5QJNFAT_5000.chr3-34-35Mb.bed3d', '3D model of the Sox2 locus, 5 kb', 'genome', 'bed3d', 'mm10'],
      ['mouse/4DNFI5QJNFAT_2000.Sox2-SCR.bed3d', '3D model of Sox2 and its control region, 2 kb', 'genome', 'bed3d', 'mm10'],
      ['C_necator/C_necator_N1_VJ_MM260.mcool', 'C. necator N-1 Hi-C (MM260)', 'map', 'mcool', 'C. necator N-1'],
      ['C_necator/C_necator_N1_VJ.fa', 'C. necator N-1 sequence', 'genome', 'fasta', 'C. necator N-1'],
      ['C_necator/C_necator_N1_VJ_MM260_4000.oriter-loci.bed', 'Origins and termini', 'genome', 'bed', 'C. necator N-1'],
      ['C_necator/C_necator_N1_VJ_MM260_4000.gc-skew-cumulative.bw', 'Cumulative GC skew, 4 kb', 'genome', 'bigwig', 'C. necator N-1'],
      ...PAPER_SUBTILIS.map(
        ([name, label]) =>
          [`B_subtilis/Bsubtilis_${name}.mcool`, `B. subtilis Hi-C, ${label}`, 'map', 'mcool', 'B. subtilis PY79'] as const,
      ),
      ['B_subtilis/PY79.fa', 'B. subtilis PY79 sequence', 'genome', 'fasta', 'B. subtilis PY79'],
      ['B_subtilis/PY79.gff3', 'Genes, B. subtilis PY79', 'genome', 'gff3', 'B. subtilis PY79'],
      ...PAPER_AERUGINOSA.map(
        ([sample, label]) =>
          [`P_aeruginosa/${sample}.mcool`, `P. aeruginosa Hi-C, ${label}`, 'map', 'mcool', 'P. aeruginosa (PAO1_v3)'] as const,
      ),
      ['P_aeruginosa/PAO1_v3.fa', 'P. aeruginosa sequence (PAO1_v3)', 'genome', 'fasta', 'P. aeruginosa (PAO1_v3)'],
      [
        'P_aeruginosa/GSE76513_PAK_T0_pooled.unstranded.CPM.bw',
        'RNA-seq, PAK, CPM (GEO GSE76513)',
        'genome',
        'bigwig',
        'P. aeruginosa (PAO1_v3)',
      ],
      ...PAPER_AERUGINOSA.map(
        ([sample, label]) =>
          [`P_aeruginosa/${sample}_8000.e1-arms.bw`, `E1 along both arms, ${label}, 8 kb`, 'genome', 'bigwig', 'P. aeruginosa (PAO1_v3)'] as const,
      ),
    ] as const
  ).map(([file, label, kind, format, assembly]) => ({
    folder: 'store/chromosomix_paper',
    file,
    label,
    kind,
    format,
    assembly,
    dataset: 'The Chromosomix paper',
  })),
  {
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.metacool',
    label: 'Mock community, 49 MAGs, 1 kb',
    kind: 'map',
    format: 'metacool',
    assembly: 'mock community',
    dataset: 'Mock microbial community',
    dev: 'metacool',
  },
  {
    folder: 'metagenomics/mock-community',
    file: 'Mock_microbial_community.mmetacool',
    label: 'Mock community, resolution ladder',
    kind: 'map',
    format: 'mmetacool',
    assembly: 'mock community',
    dataset: 'Mock microbial community',
    dev: 'metacool',
  },
]

/**
 * A file's path under `demo/`, from the folder that names it — `..` stepped up
 * out of, so a card's `../meneu2025/…` and the row the Meneu card lists are one
 * path and one row.
 */
function under(folder: string, file: string): string {
  const out: string[] = []
  for (const part of `${folder}/${file}`.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '' && part !== '.') out.push(part)
  }
  return out.join('/')
}

/**
 * The annotation files published beside a demo map, and where each belongs.
 *
 * Keyed by the map's file name rather than by its URL, because the URL depends
 * on where the app is served from and the pairing does not. All seven are on the
 * map's own assembly — Ensembl's R64-1-1, whose `I`…`XVI` the map spells
 * `chrI`…`chrXVI`, which §8.2 reads as the same names — which is exactly what
 * makes them worth offering as one click: a reader gets a complete, correct
 * picture without hunting for seven URLs, and the overlap report has something
 * to report success about.
 *
 * Not the same thing as the figures above, and both are worth having. A figure
 * is a composed session — the tracks placed, coloured and grouped — and this is
 * the whole shelf, offered to a reader who opened the map on its own (its row
 * under the yeast cards, or its URL) and wants the rest of it.
 */
interface DemoAnnotation {
  file: string
  /** A short name, since the file's own is a sentence about the experiment. */
  label: string
}

/**
 * The shelf beside one map: the dataset folder it lives in, and what is in it.
 *
 * The folder is recorded even though {@link demoAnnotationsFor} never reads it
 * — that function resolves against the *map's own URL*, which is the only thing
 * that also works for a copy of the folder served from somewhere else. It is
 * here for the test, which has to find these files on disk or in the manifest.
 */
const DEMO_ANNOTATIONS: Record<string, { folder: string; entries: DemoAnnotation[] }> = {
  'GSE151553_A364_merged.mcool': {
    folder: 'store/yeast',
    entries: [
      { file: 'S288c.gtf', label: 'genes' },
      { file: 'Yeast_RNAseq.barChart', label: 'RNA-seq' },
      { file: 'Yeast_ATAC.bw', label: 'ATAC' },
      { file: 'Yeast_MNase.bw', label: 'MNase' },
      { file: 'Yeast_shotgun.bw', label: 'shotgun' },
      { file: 'Yeast_snps.vcf.gz', label: 'SNPs' },
      { file: 'Yeast_microC_loops.bedpe', label: 'loops' },
    ],
  },
}

/** One loadable annotation, with the URL resolved for wherever this is served. */
export interface DemoAnnotationLink extends DemoAnnotation {
  url: string
}

/**
 * The annotations published beside the map at `uri`, or `[]`.
 *
 * Two sources, asked in this order, and the order is the argument. A store row
 * that carried `tracks` said so **about this exact file** — the catalogue's
 * publisher named them beside the URI the reader just clicked — where the table
 * below matches on a *file name*, which is a guess that happens to be a good
 * one. A specific answer beats a general one, so a registered shelf wins
 * outright rather than being concatenated.
 *
 * The table itself is matched on the file name at the end of the URI, so it
 * works for the bucket, for a local copy of `demo/store/yeast/` served from
 * anywhere else, and for a fork publishing the same folder under its own name — and not
 * for a *local* file of the same name, which would be someone else's data under
 * a familiar name.
 */
export function demoAnnotationsFor(uri: string): DemoAnnotationLink[] {
  const registered = shelves.get(splitUri(uri).path)
  if (registered !== undefined) return registered.map((link) => ({ ...link }))
  if (!/^https?:\/\//i.test(uri)) return []
  // The file half: an `.mcool` is opened at one of its entries, and the name
  // the table is keyed by is the file's, not `1600`.
  const file = splitUri(uri).path.split('?')[0].split('#')[0]
  const name = file.split('/').pop() ?? ''
  const shelf = DEMO_ANNOTATIONS[name]
  if (shelf === undefined) return []
  const base = file.slice(0, file.length - name.length)
  return shelf.entries.map((entry) => ({ ...entry, url: `${base}${entry.file}` }))
}

/**
 * The published tracks to *offer*, which is none once a session has its own.
 *
 * A **restored session already names the tracks it wants** and is a moment away
 * from putting them on screen. Offered anyway, the button appeared under rows
 * that were already appearing and proposed seven more, most of them the same files
 * a second time. `restoring` covers an imported workspace, a `?config=` link and
 * a plain reload alike, because all three arrive the same way.
 */
export function demoAnnotationsToOffer(
  uri: string,
  options: { restoring: boolean },
): DemoAnnotationLink[] {
  return options.restoring ? [] : demoAnnotationsFor(uri)
}

/**
 * Every published annotation, as its path under `demo/`, for the test that
 * checks they are on disk — and so for the sync that puts them on the bucket.
 */
export const DEMO_ANNOTATION_FILES: readonly string[] = Object.values(DEMO_ANNOTATIONS).flatMap(
  (shelf) => shelf.entries.map((entry) => under(shelf.folder, entry.file)),
)

/**
 * The workspace files this module offers, as their paths under `demo/`, for the
 * test that reads every one of them off disk and opens what it names.
 */
export const DEMO_FILES: readonly string[] = DEMO.map((entry) => under(entry.folder, entry.file))

/** The data files the store lists, as their paths under `demo/`, for the same test. */
export const DEMO_DATA_FILES: readonly string[] = DEMO_DATA.map((entry) =>
  under(entry.folder, entry.file),
)

/**
 * Where the demos are read from, absolute, wherever this is running.
 *
 * Resolved against the page when there is one, even though both candidates are
 * already absolute: it costs nothing, and it is what lets the escape hatch be a
 * *relative* base — `DEMO_BASE=/demo/ npm run build` for a copy served beside
 * the app. The `typeof` guard is for the node test runtime, which has no
 * `window` and in which this is still worth calling.
 */
function demoBase(): string {
  const base = DEMO_BASE !== '' ? DEMO_BASE : DEMO_BUCKET
  if (typeof window === 'undefined') return base
  try {
    return new URL(base, window.location.href).href
  } catch {
    return base
  }
}

/**
 * The columns the lab's store declares.
 *
 * Every card and every file row is drawn from these, so what a column is
 * called here is what the gallery reads: `section` is the heading a card stands
 * under, `provenance` and `detail` are the card's chip and its fold, `format`
 * and `dataset` are the file rows' chip and their grouping. A store somebody
 * else writes may call its columns anything; this one is read by a front that
 * knows it.
 */
const DEMO_COLUMNS = [
  { key: 'section', label: 'Section' },
  { key: 'assembly', label: 'Assembly' },
  { key: 'dataset', label: 'Dataset' },
  { key: 'format', label: 'Format' },
  { key: 'provenance', label: 'Provenance' },
  { key: 'detail', label: 'What is on screen' },
]

/**
 * The lab's store, inline: the figures, under their sections, then the data files.
 *
 * Inline rather than fetched because it is the one store that costs no request
 * and the only one that is certainly there (§24.2). Every URI is absolute
 * already, so `resolveStore` has nothing left to do to them: an inline store
 * has no URL of its own to be relative to.
 */
export function demosStore(): StoreFile {
  const base = demoBase()
  return {
    kind: STORE_KIND,
    version: STORE_VERSION,
    name: 'RSG lab data',
    description:
      'Composed figures over the lab’s published data, and the files they are made of. Every ' +
      'one is read over the network exactly as a file on your own bucket would be.',
    base,
    columns: DEMO_COLUMNS,
    entries: [
      // A figure or a file that belongs to a dev feature is not listed while
      // the switch is off (§29): the store is on the landing page, which is
      // the first place a reader would learn of it.
      ...DEMO.filter(shown).map(
        (entry): StoreEntry => ({
          label: entry.title,
          uri: `${base}${under(entry.folder, entry.file)}`,
          kind: 'workspace',
          note: entry.line,
          fields: {
            section: entry.section,
            assembly: entry.assembly,
            provenance: entry.provenance,
            detail: entry.detail,
            // The files the figure is made of, as the URIs of the rows below,
            // so the card lists them under its fold without a second lookup.
            // `|`-joined because a field is one string; no URI carries a bar.
            files: entry.files.map((file) => `${base}${under(entry.folder, file)}`).join('|'),
          },
        }),
      ),
      ...DEMO_DATA.filter(shown).map(
        (entry): StoreEntry => ({
          label: entry.label,
          uri: `${base}${under(entry.folder, entry.file)}`,
          kind: entry.kind,
          fields: { assembly: entry.assembly, dataset: entry.dataset, format: entry.format },
        }),
      ),
    ],
  }
}

/** Whether a figure or a file of the lab's store is listed: always, unless its dev feature is off. */
function shown(entry: { dev?: DevFeature }): boolean {
  return entry.dev === undefined || devFeature(entry.dev)
}

// ---------------------------------------------------------------------------
// Shelves a store brought with it
// ---------------------------------------------------------------------------

/**
 * The tracks a store row named, held until the file it belongs to is opened.
 *
 * A store entry may carry `tracks` — the bigWigs the same experiment published
 * beside the map (§24.1) — and they are the same *offer* the demo map's ten
 * annotations are: here is a set of tracks to look at, for a reader who has
 * none. So they are answered through the same question rather than a second
 * one, and `Session` needs no idea that a store exists.
 *
 * In memory and never in storage, deliberately. The offer is about the file
 * being opened right now; a shelf that outlived the tab would be a promise to
 * fetch URLs out of a catalogue the reader has since forgotten.
 */
const shelves = new Map<string, DemoAnnotationLink[]>()

/**
 * The shelves that were **asked for** rather than merely brought along.
 *
 * *Open with its tracks* says what it does, so it has to do it: a reader who
 * presses those words and gets a genome and a button has been given the thing
 * they pressed past. Every other road to the same file — the row's own open
 * verb, a `?store=` link, a dropped copy — keeps the offer, because opening a
 * genome is not a request for eight more files.
 *
 * A set beside the map rather than a field on the link, because it is a fact
 * about the *gesture* and not about the tracks: the same shelf is asked for
 * through one door and offered through another, and a flag on each link would
 * have to be rewritten on every registration to say so.
 */
const asked = new Set<string>()

/**
 * Remember the tracks published beside `uri`, so the Tracks card can offer them.
 *
 * Keyed on the **absolute URI's file half**, so it answers for the same file
 * opened at an entry (`file.mcool::resolutions/1000`) as for the file itself —
 * which is the common case rather than the exotic one, since a collection
 * opened at its root lands on one of its entries and the URI the session ends
 * up on is not the one the store row carried.
 *
 * Last registration wins: two stores naming the same map is not a conflict worth
 * a policy, and the one the reader has just clicked is the one they mean.
 */
export function registerShelf(
  uri: string,
  tracks: ReadonlyArray<{ label: string; url: string }>,
  options: { asked?: boolean } = {},
): void {
  const key = splitUri(uri).path
  if (key === '') return
  if (tracks.length === 0) {
    shelves.delete(key)
    asked.delete(key)
    return
  }
  if (options.asked === true) asked.add(key)
  else asked.delete(key)
  shelves.set(
    key,
    tracks.map((track) => ({
      // The file name is what a track row falls back to when it has no label,
      // and what `demo-examples.test.ts` checks the published set against;
      // derived here rather than asked for, since a store carries a label and a
      // URL and nothing in between.
      file: track.url.split('?')[0].split('#')[0].split('/').pop() ?? track.url,
      label: track.label,
      url: track.url,
    })),
  )
}

/**
 * Whether this file's shelf was asked for, and should be loaded rather than
 * offered.
 *
 * Read once, by the session building its cards, and **cleared as it is read**:
 * the gesture is spent. Without that, closing the tracks and reopening the same
 * genome would bring all eight back, which is the one reading of *open with its
 * tracks* nobody wants — the reader has just said no to them.
 */
export function shelfWasAsked(uri: string): boolean {
  const key = splitUri(uri).path
  if (!asked.has(key)) return false
  asked.delete(key)
  return true
}

/** Forget every registered shelf. Tests only — the map is otherwise per page. */
export function clearShelves(): void {
  shelves.clear()
  asked.clear()
}

// ---------------------------------------------------------------------------
// Worked examples for the paste boxes
// ---------------------------------------------------------------------------

/**
 * A hub and a store, ready to paste — and **ready to open**.
 *
 * The point of an example beside a paste box is not to show syntax, which the
 * specification does better. It is to be something a reader can press *open*
 * on and then edit into their own: the two below name the published demo files,
 * so each of them draws a shelf on the first press wherever this build is
 * served from, and the reader's first edit is to a thing that already worked
 * rather than to a template they cannot tell the state of.
 *
 * Which means they are held to the same bar as any other demo: every URL is one
 * of {@link DEMO_DATA_FILES} or {@link DEMO_ANNOTATION_FILES}, so the test that
 * checks those covers these too, and neither example can come to name a file
 * the bucket does not have.
 *
 * The hub is an **assembly hub**: it names the store's own `.2bit` through
 * `twoBitPath`, which is the only way a hub carries its own sequence and the
 * rung of §24.10's ladder worth demonstrating. It is the text a reader wrote and
 * checked against the bucket, rather than one composed here and argued about,
 * moved onto the store's R64 files with the rest of the yeast demo — the same
 * genome line, the same composite of two, the same map — and the URLs are built from
 * {@link DEMO_BUCKET} rather than from {@link demoBase} for a reason that only
 * shows up under `DEMO_BASE`: a local copy of `demo/` has these files, but the
 * example is a thing to *press*, and a base that pointed it at a directory
 * somebody is still filling would break the one promise it makes.
 */
export function exampleHubText(): string {
  return [
    '# A UCSC track hub, in one file: the hub line, its genome, and its tracks.',
    '# Three separate files (hub.txt, genomes.txt, trackDb.txt) can be pasted',
    '# one after another in the same text box. ',
    '',
    'hub exampleHub',
    'shortLabel Example hub',
    'longLabel Yeast demo data from RSG lab',
    'useOneFile on',
    '',
    'genome R64-1-1',
    'organism Saccharomyces cerevisiae',
    `    twoBitPath ${DEMO_BUCKET}store/yeast/S288c.2bit`,
    '',
    'track signal',
    'compositeTrack on',
    'shortLabel Signal',
    'longLabel Two tracks, grouped as their hub groups them',
    'type bigWig',
    '',
    '    track mnase',
    '    parent signal on',
    '    shortLabel MNase',
    '    longLabel Nucleosome occupancy',
    `    bigDataUrl ${DEMO_BUCKET}store/yeast/Yeast_MNase.bw`,
    '    type bigWig',
    '',
    '    track atac',
    '    parent signal on',
    '    shortLabel ATAC',
    '    longLabel ATAC-seq accessibility',
    `    bigDataUrl ${DEMO_BUCKET}store/yeast/Yeast_ATAC.bw`,
    '    type bigWig',
    '',
    'track contacts',
    'shortLabel Micro-C map',
    'longLabel A contact map, which opens through the map door',
    `bigDataUrl ${DEMO_BUCKET}store/yeast/GSE151553_A364_merged.hic`,
    'type hic',
    '',
  ].join('\n')
}

/**
 * The store-file counterpart: the same two demo files, as a shelf.
 *
 * Deliberately small. A store's whole shape is `kind`, `columns` and `entries`,
 * and an example with twenty rows would bury that under nineteen copies of the
 * one line worth reading.
 */
export function exampleStoreText(): string {
  const at = `${demoBase()}store/yeast/`
  return `${JSON.stringify(
    {
      kind: STORE_KIND,
      version: STORE_VERSION,
      name: 'Example shelf',
      description: 'Two of the demo files, as a store you can edit',
      columns: [
        { key: 'assay', label: 'Assay' },
        { key: 'assembly', label: 'Assembly' },
      ],
      entries: [
        {
          label: 'Yeast micro-C, A364A',
          uri: `${at}GSE151553_A364_merged.mcool`,
          kind: 'map',
          note: 'A contact map, which opens through the map door',
          fields: { assay: 'Micro-C', assembly: 'R64-1-1' },
          tracks: [{ label: 'MNase', url: `${at}Yeast_MNase.bw` }],
        },
        {
          label: 'MNase',
          uri: `${at}Yeast_MNase.bw`,
          kind: 'genome',
          note: 'A bigWig, which opens as a browser over its own genome',
          fields: { assay: 'MNase-seq', assembly: 'R64-1-1' },
        },
      ],
    },
    null,
    2,
  )}\n`
}

/**
 * Every URL the two examples name, as their paths under `demo/`.
 *
 * For the test that reads the published demo files off disk, or off the store's
 * manifest: an example that names a file the bucket does not have is an example
 * that fails on its first press, which is the one thing worse than no example at all.
 */
export const EXAMPLE_FILES: readonly string[] = [
  'store/yeast/S288c.2bit',
  'store/yeast/Yeast_MNase.bw',
  'store/yeast/Yeast_ATAC.bw',
  'store/yeast/GSE151553_A364_merged.hic',
  'store/yeast/GSE151553_A364_merged.mcool',
]
