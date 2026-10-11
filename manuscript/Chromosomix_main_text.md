# Chromosomix — main text with the rewritten Fig. 2 section (draft, v4)

Notes for the authors:

- **What changed.**
  - Paragraphs 1–3 and the closing paragraph are yours, verbatim.
  - Paragraphs 4 and 5 are rewritten. They make the browser the subject: two new analyses, the
    inter-arm alignment measured on 76 genomes and a mutant, and then what removing it shows in
    PAK.
  - There is no compartment survey across species.
  - Paragraph 4 opens by echoing paragraph 1's "turns a pattern seen by eye into a result", and
    picks up paragraph 3's closing point about replaying a chain.
- **How Bignaud et al. (2026) is used.**
  - What they report (Results, first section; Fig. 1D–E): "a plaid-like pattern at larger scales
    and visible across the entire contact map", "compartment-like" (compartments 1 and 2),
    "detectable using the third eigenvector of the matrix", with "a clear enrichment of
    transcription activity in the second compartment". Their Fig. 1D is a 2–3.5 Mb zoom at 5 kb.
  - What we add, from the same PAK map: under the standard expected, none of the first three
    eigenvectors follows GC content (|r| ≤ 0.06). Once the arm alignment is removed, the pattern
    is E1 over the whole chromosome and follows base composition, with the two compartments apart
    in the 3D model.
  - That is the "mechanism" angle: the compartments are set by DNA composition and position, not
    only by local transcription.
- **The transcription test is still a placeholder.** It is the direct link to their result. They
  used the RNA-seq of Chevallereau et al. (2016), GEO GSE76513, which I could not download here
  (GEO and ENA are blocked from this environment). Load it in Chromosomix with the A/B call and run
  *Signal by group*; the numbers slot into paragraph 5.
- **Check the 3D result against their Discussion.** They cite work showing that transcribed DNA
  moves to the nucleoid periphery in *E. coli* (their refs 16 and 40: Bignaud et al. 2024 *NSMB*;
  Yang et al. 2019 *Nat Commun*). Our model puts A, the GC-rich compartment, at the centre. If the
  transcription test shows A is the more transcribed, the two readings disagree. Our 3D position
  comes from a model inferred from contacts (Pastis-NB), not from imaging, and the text says so;
  decide whether to discuss it.
- **The mechanistic clause is a hypothesis; cut it if you prefer.** It names MvaT/MvaU, citing
  Castang et al. 2008, as a possible reader of AT-rich DNA. Check that the reference supports
  "bind AT-rich DNA". The data support composition and position, not the protein.
- **The mutant needs its data source.** The likely *B. subtilis* sources are Wang et al. 2015
  *Genes Dev* (Δsmc, ΔparB) and Marbouty et al. 2015 *Mol Cell*.
- **Timing: please re-measure.** Measured here on three genomes, on four 2.1-GHz Xeon cores with
  Node 22:
  - the chain behind the inter-arm survey (circularity test, raw coverage, ori/ter call,
    alignment) took 3.7–6.2 s per genome;
  - the whole PAK chain, with both compartment runs, the group test and the 3D model, took
    8–13 s.

  Re-measure on the laptop you will cite.
- **Where the numbers come from.** Every number is from `notebooks/dbz-chromosome-figures.qmd`,
  under the app's defaults: 8 kb, balanced, cooltools preparation. The notebook writes them with
  their tests to `figures/numbers.tsv`. The A/B P value is the app's own group-comparison task.
- **An optional copyedit, not applied.** In the closing paragraph, "will allow to seamlessly
  integrate" could become "will make it straightforward to integrate".

---

## Main text

Chromosome conformation capture methods such as Hi-C have shown that genomes fold into loops, domains
or compartments in all domains of life. These structural features are systematically interpreted in
relation to other data modalities, for example a domain border in a 2D contact map against 1D
transcriptional or protein abundance profiles, a loop anchor against a CTCF DNA binding motif, a
euchromatin chromosome compartment against a 3D model of chromosome spatial organization. Testing such
relationships is what turns a pattern seen by eye into a result. However, current tools separate
seeing from measuring (Supplementary Table 1). Linear genome browsers such as igv.js and JBrowse 2
read alignments, variants and signal tracks directly from files, but offer limited support for contact
maps. Contact map viewers such as HiGlass, Juicebox.js and 3D Genome Browser 2.0 display maps across
scales, but rely on a server that pre-computes image tiles, or on a single file format. Platforms that
combine 1D, 2D and 3D data, such as the WashU Epigenome Browser and Nucleome Browser, are hosted
services organised around consortium data collections. On the other hand, quantification largely
happens separately with command-line tools, so comparing features on a contact map to a linear track
or a 3D model often means leaving the browser and writing code.

Chromosomix is a genome browser in which quantitative analysis across 1D, 2D and 3D data is part of
browsing itself (Fig. 1). It runs entirely in the user's web browser, with no installation, account or
server. Files are opened from a local disk, private or public cloud storage, or public resources such
as 4DN, ENCODE and UCSC track hubs, and are read in place, so unpublished or clinical data never leave
the machine. The browser accepts any combination of file formats, including most contact map formats
(.cool, .mcool, .scool, .hic, HiC-Pro and .pairs binned on the fly), linear tracks (BAM, VCF, bigWig,
bedGraph, BED, GTF, FASTA, bedMethyl and others) and 3D models (g3d, 3dg and bed3d; Supplementary
Table 2), by aligning them to a shared abstract genomic coordinate system. Each map can be browsed
across its full range of scales, from compartments spanning a whole genome to the finest bins the file
holds, with linear tracks and the 3D model following the region in view (Fig. 1a). Because Chromosomix
reads only the region and resolution a view requires, interactive browsing on a laptop is possible for
genomes of any size and at any resolution: a 300-million-contact map of mouse chromosome 1 at 10-kb
resolution displays in under 3 s, and a 100-million-contact map of the whole Saccharomyces cerevisiae
genome at subnucleosome-scale resolution (50-bp) in about 10 s (Supplementary Table 3). A deck can
offer multiple genomic facets side-by-side (displaying contact maps and/or tracks or structures), with
synchronised or uncoupled navigation (Fig. 1a).

Importantly, Chromosomix fills the existing gap between interactive browsing and quantitative analysis.
Data can be analysed directly in the browser, where they are displayed, within and across dimensions
(Fig. 1b and Supplementary Table 4). On contact maps, analyses include contact decay with genomic
distance, diamond insulation and directionality profiles, compartments with saddle plots, loop and
border detection with Chromosight, virtual 4C, aggregate peak analysis, and reproducibility between
maps with HiCRep. On linear tracks, they include metaplots, track correlation, fraction of signal in
peaks, sequence bias and motif search, and interval overlap against shuffled controls. Contact maps can
be modelled in 3D using either Pastis-NB or ShRec3D algorithms, and single-cell contact maps get
per-cell quality control with cell-cycle phasing. Every quantitative result becomes an ordinary track
or feature set that other analyses can take as input, so analyses chain across dimensions. For
example, borders detected on a contact map can be correlated with a ChIP-seq track, then used to pile
up every domain they delimit; peaks from a linear track can be used to perform aggregate peak analysis
on contact maps; and a 3D model of chromosome spatial organization, inferred from a contact map or from
imaging experiments, can be coloured by any linear track. None of these steps requires code,
exploration is fully reproducible, and a full session can be shared as a link. The command-line
equivalent of each analysis is registered in a dedicated console, so a chain built interactively on
one map can be re-run on another map, in the browser or programmatically.

<!-- Paragraphs 4 and 5: rewritten. -->

To illustrate how measuring inside the browser turns a pattern seen by eye into a result, we turned
to bacterial chromosomes. In many bacteria, SMC complexes loaded near the origin of replication (ori)
hold the two chromosome arms together as they travel towards the terminus (ter), so that loci at the
same distance from ori on opposite arms contact each other (Le et al. 2013; Wang et al. 2017; Lioy et
al. 2020). This inter-arm alignment draws a secondary diagonal across the contact map, perpendicular
to the main one, and can mask other features. In *Pseudomonas aeruginosa* strain PAK, for instance,
Bignaud et al. (2026) observed a plaid-like pattern reminiscent of eukaryotic compartments, detectable
in the third eigenvector of the map, with transcription enriched in one of its two compartments. We implemented two new analyses in Chromosomix to measure inter-arm alignment
and to remove it (Fig. 2a; Methods). The first locates ori from the sequence (cumulative GC skew, parS
and matS sites) and centres the map on it. It then compares the contacts between each locus and its
mirror image on the opposite arm with the contact decay, yielding an alignment profile from ori to
ter, its reach and a score per chromosome. The second computes the expected contact frequency in the
frame of the two arms, removing the main and the secondary diagonals together. In PAK, the arms were
aligned over 2.7 of their 3.2 Mb, with a mean enrichment of 2.9-fold along the secondary diagonal.
Replaying the same session from the command line on 76 published bacterial Hi-C maps took [n ± sd] s
per genome on a standard laptop. Inter-arm alignment ranged from [x] in [species] to [y] in [species]
(Fig. 2b). As expected for a readout of SMC activity, it was absent in *Escherichia coli* (1.05-fold),
whose MukBEF condensin does not align the arms (Lioy et al. 2018). It was also lost in [*Bacillus
subtilis smc* or *parB* mutants] ([score] against [score] in the wild type; Fig. 2c; [Wang et al.
2015; Marbouty et al. 2015]).

Removing the alignment then revealed the PAK compartments across the whole chromosome (Fig. 2d).
Arm-frame detrending lowered the enrichment along the secondary diagonal from 2.9-fold to 0.96-fold.
Before detrending, the leading eigenvector of the map (E1, explaining 31% of it) followed the distance
from ori (|Spearman ρ| = 0.74), and none of the first three eigenvectors followed GC content
(|r| ≤ 0.06). After detrending, the plaid pattern extended over the whole map and E1 captured it. E1
explained 28% of the detrended map, no longer followed the ori–ter axis (|ρ| = 0.05) and correlated
with GC content (r = 0.35, *P* = 8 × 10⁻²⁴). Chaining analyses in the same session then characterised
the two compartments. The A compartment, 73% of the chromosome, was richer in GC than B (66.9% against
65.2%, Mann–Whitney *P* = 7 × 10⁻²²) [and more transcribed (effect, *P*), in line with the enrichment
reported by Bignaud et al. (2026)]. In a 3D model inferred from the same map, A lay towards the centre
and B towards the periphery (Spearman ρ between E1 and radial position = −0.74, *P* = 4 × 10⁻¹³⁹).
Because E1 is ranked by eigenvalue alone and GC content only sets its sign, none of these comparisons
is circular. The compartments glimpsed in PAK are therefore a chromosome-wide organisation that sets
AT-rich DNA apart from GC-rich DNA, much as the A and B compartments of eukaryotic nuclei do. This
suggests that base composition contributes to them, possibly through the H-NS-family proteins MvaT and
MvaU, which bind AT-rich DNA in *P. aeruginosa* (Castang et al. 2008).

<!-- Closing paragraph: yours, verbatim. -->

By making quantitative analysis an integrated part of interactive data exploration, Chromosomix lets
biologists test what they see in chromosome folding data without leaving the view in which they saw
it, from a bacterial genome to a mammalian one. Running entirely inside a browser tab also imposes
practical limits: the total working memory is necessarily bounded by both the device's reported
capacity and the browser's own ceiling. However, we have carefully optimized the data parsers, and a
standard portable machine can run ten concurrent sessions without experiencing any slowdown. The
genome browser is available as a web application, a desktop app or a standalone HTML page, and can be
embedded in any static HTML page. We envision that the flexibility of Chromosomix will allow to
seamlessly integrate new file formats, for example data containers dedicated to metagenomics contact
maps.

---

*Suggested Fig. 2 panels.*
- **a**, the two analyses, on PAK:
  - the map centred on ori, with the alignment profile from ori to ter;
  - the arm-frame expected and the detrended map.
- **b**, inter-arm alignment across the 76 genomes: score and reach per species [by phylum], and the
  time per genome.
- **c**, wild type against the [*smc*/*parB*] mutant: alignment profiles and scores.
- **d**, the PAK compartments:
  - the first three eigenvectors before detrending and E1 after, each against the distance from
    ori and against GC content;
  - A against B for GC content [and transcription];
  - E1 against radial position in the 3D model.

---

## Methods

**Circular chromosomes**
When a contact map is first opened, the 50 longest sequences of at least 50 bins are tested for
circularity. For each separation *s* of 1–3 bins, the mean contact across the junction of the two
ends is divided by the mean contact at the same separation along the main diagonal at those ends,
counting a separation only where the junction has data and the diagonal has contacts at both ends.
The junction score is the median of these ratios, close to 1 for a circular molecule and close to 0
for a linear one; it needs two of the three separations, and a sequence with fewer is left
undecided. Sequences scoring 0.2 or more are marked as circular. The score is kept with the
call and shown on the sequence's tick box, which the user can change in the chromosome table. On a
circular sequence, genomic separations are measured the short way round the circle by every task
that uses them, from the expected contact decay to insulation and compartments.

**Base composition, replication origin and terminus**
GC content, GC skew (G − C)/(G + C), AT skew (A − T)/(A + T) and the cumulative GC skew are computed
from a FASTA file per bin of the open map, or at a user-defined bin size (10 kb by default when no map
is open), and stored as tracks. The origin and terminus of replication are called with the rules of
Bacchus (Lamy-Besnier et al. 2023). The cumulative GC skew (Grigoriev 1998) is computed in 5-kb
windows with a 1-kb step, and its minimum and maximum are the two candidate loci. parS sites
(TGTTNCACGTGNAACA, up to one mismatch; Livny et al. 2007) and matS sites (GTGACRNYGTCAC, exact
matches; Mercier et al. 2008) are searched on both strands with the motif search task. The terminus
is the candidate nearer the matS cluster when at least ten matS sites are found. Otherwise it is the
candidate farther from the parS cluster, or, if neither rule applies, the candidate with the lower
Hi-C coverage. When a coverage track is given, it is binned at 5 kb and fitted with a cubic spline,
and the ori/ter ratio is the ratio of the fit's maximum to its minimum. The ori and ter loci and the
parS and matS sites are stored as feature sets, and the origin is written into the chromosome table,
where it can also be entered by hand. Without either, the first base of the sequence is taken as the
origin, since complete bacterial genome sequences conventionally start at *dnaA*, next to it. A
circular sequence with an origin can be shown with the origin at the centre of the view: the view
runs across the junction from half a chromosome before the origin to half a chromosome after it.

**Inter-arm alignment**
Each bin *i* is assigned its signed offset *u*ᵢ from the origin, measured the short way round the
circle. The sign of *u*ᵢ gives the arm (replichore) and |*u*ᵢ| the distance from the origin.
Alignment is read from the observed/expected map, with the expected given by the contact decay with
(circular) separation. Cells joining the two arms (*u*ᵢ*u*ⱼ < 0) within *b* bins of the secondary
diagonal (||*u*ᵢ| − |*u*ⱼ|| ≤ *b*, *b* = 2 by default) are averaged by their distance from the
origin, (|*u*ᵢ| + |*u*ⱼ|)/2, to give an alignment profile, and by bin, to give an alignment track
along the chromosome. Cells closer than 2*b* + 2 bins to the main diagonal are excluded. There the
two diagonals cross near the origin and the terminus, and the ratio reflects local compaction rather
than alignment. Each chromosome is summarised by three numbers:
- its score, the mean log2 enrichment over the arms;
- its peak, the maximum of the profile smoothed by a running mean over 2% of the arm;
- its reach, the distance from the origin at which the smoothed profile first falls below half its
  peak.

**Anti-diagonal (arm-frame) detrending**
To remove the main and the secondary diagonals together, the expected contact frequency is computed
in the frame of the arms. For bins *i* and *j*, the longitudinal separation Δ = ||*u*ᵢ| − |*u*ⱼ||
is the genomic separation for two bins on the same arm and the distance from the secondary diagonal
for two bins on opposite arms. The position of the pair along the ori–ter axis is Σ = |*u*ᵢ| +
|*u*ⱼ|. The expected value of a cell is the mean of all cells of the same kind (same arm or opposite
arms) with the same Δ and with Σ within a window of *w* bins (*w* = 50 by default, 400 kb at 8-kb
resolution). The mean over Σ is a box filter applied to Σ bucketed in steps of *w*/4. The window lets
the expected follow the gradual loss of alignment from origin to terminus, but not the faster
alternation of compartments; *w* = 0 averages over the whole chromosome. The same expected can be
used to display the contact map as observed/expected. The residual enrichment of the secondary
diagonal is the mean log2 of this observed/expected over the cells that give the inter-arm score.

**Compartments**
Compartments are called from the cis observed/expected map, with either expected model, ignoring
the main diagonal and its two neighbours. By default the map is prepared as in cooltools (Open2C et
al. 2024):
1. It is clipped at 0 and at its 99.9th percentile.
2. 1 is subtracted, so that each cell is its departure from expected.
3. Missing cells are set to 0, that is, to expected.

Its leading eigenvectors are computed by power iteration with deflation. They are ranked by the
absolute value of their eigenvalues λ and scaled by √|λ|, as in cooltools. The share of the map
explained by an eigenvector is λ²/Σλ²: the fraction of the map's sum of squares that it captures.
On the PAK, *C. necator* and *E. coli* maps, read as linear with the distance-decay expected, the
three leading eigenvectors agreed with those of cooltools' `eigs_cis` (v0.7.1) to |r| = 1.000,
with eigenvalues within 0.03%.

Alternatively, as in Lieberman-Aiden et al. (2009), the Pearson correlation matrix of the
observed/expected rows is decomposed; an eigenvector then explains λ/*n* of its variance, *n* being
the number of bins.

The sign of each eigenvector is set so that it correlates positively with a phasing signal: GC
content, gene density from an annotation, or any track. This applies when the absolute Pearson
correlation is at least 0.1; below that, the sign is left unchanged, and for E1 the user is warned.
The phasing signal never selects among eigenvectors, so E1 is always the eigenvector with the largest
eigenvalue, and comparing the phasing signal between compartments is not circular. Runs of bins with
positive and negative E1 are exported as A and B intervals, and a saddle plot gives the mean AA, BB
and AB interactions.

**Comparing tracks between compartments**
Any track can be compared between groups of genomic intervals: the named intervals of a feature set,
such as A and B compartments, or the bins of a track split by sign or into quantiles, with the rest of
the genome as an optional group. Each group's intervals are cut into stretches of at most one bin,
and each stretch is summarised by the mean of the track over it. Groups are compared with two-sided
Mann–Whitney U tests, reported with the rank-biserial effect size, and with a Kruskal–Wallis test
when there are three groups or more. Both are corrected for ties, and P values are adjusted by
Benjamini–Hochberg across all tests of a run.

**Analysis of bacterial genomes (Fig. 2)**
Maps were read at 8 kb with their balancing weights, Chromosomix's default, for every step. The ori/ter
call also used the raw (unbalanced) total Hi-C coverage at 500 bp; the origin it placed in *E. coli*
MG1655, 3,924,501, lies 1.4 kb from the annotated *oriC* at 3,925,860.

- **Inter-arm survey.** The circularity test, the ori/ter call and the inter-arm alignment were
  replayed with the `chromosomix` command line on each of the 76 maps [sources, Supplementary Table X], and on the
  [*smc*/*parB*] mutant and wild-type maps of [refs]. The inter-arm score varied by less than 0.05
  between 4, 8 and 16 kb.
- **PAK compartments.** Compartments were called twice, once with the distance-decay expected and
  once with the arm-frame expected (*w* = 50 bins). Both runs used cis contacts, the cooltools
  preparation, and three eigenvectors ranked by eigenvalue and signed by GC content computed from
  the reference at the map's resolution. The E1 of the detrended map was nearly the same with the
  Lieberman-Aiden preparation (|r| = 0.90).
- **Transcription.** [Transcription in exponential phase was taken from Chevallereau et al. (2016;
  GEO GSE76513), as in Bignaud et al. (2026), and processed with [processing].]
- **3D model.** The model was inferred with Pastis-NB from the 8-kb map (Spearman ρ = 0.93 between
  inverse model distances and contacts). The radial position of a bin is the distance of its bead to
  the centroid of the model.
- **Statistics.** GC content [and transcription] were compared between A and B over 8-kb stretches
  with the group comparison above. Correlations used all bins with finite values (*n* = 800) and
  were computed with SciPy (v1.17) on tracks exported by Chromosomix:
  - Pearson's r of each eigenvector with GC content;
  - Spearman's ρ with radial position;
  - Spearman's ρ with the distance from ori, measured the short way round the circle and reported
    as |ρ|, since an eigenvector's sign is arbitrary where GC content cannot set it.

Every step was run with the `chromosomix` command line from a Quarto notebook distributed with Chromosomix, which
also draws the figure panels and writes every number reported here with its test.

**Command-line interface and reproducibility** *(addition to the existing paragraph)*
Maps are read with their balancing weights by default, as in the browser, and `--no-balance` reads
the raw counts. Circularity and origins are part of an analysis' record: a saved workspace carries
them, and the command line reads them from `--circular NAME` and `--origin NAME:POSITION`. A
replayed chain therefore reads each chromosome from the same origin as in the browser.

---

## References to add

- Bignaud A, Lamy-Besnier Q, Conti DE, Thierry A, Girard F, Misson P, Koszul R, Debarbieux L,
  Marbouty M (2026) Bacteriophage PAK_P3 genome structuration and dynamics during infection of
  *Pseudomonas aeruginosa* reveal specific interaction patterns. *Sci Adv* 12:eaef2512.
- Castang S, McManus HR, Turner KH, Dove SL (2008) H-NS family members function coordinately in an
  opportunistic pathogen. *PNAS* 105:18947–18952.
- Chevallereau A, Blasdel BG, De Smet J, Monot M, Zimmermann M, Kogadeeva M, Sauer U, Jorth P,
  Whiteley M, Debarbieux L, Lavigne R (2016) Next-generation "-omics" approaches reveal a massive
  alteration of host RNA metabolism during bacteriophage infection of *Pseudomonas aeruginosa*.
  *PLOS Genet* 12:e1006134.
- Grigoriev A (1998) Analyzing genomes with cumulative skew diagrams. *Nucleic Acids Res*
  26:2286–2290.
- Lamy-Besnier Q, et al. (2023) Bacchus. [full reference as in your source for the tip]
- Le TBK, Imakaev MV, Mirny LA, Laub MT (2013) High-resolution mapping of the spatial organization of
  a bacterial chromosome. *Science* 342:731–734.
- Lieberman-Aiden E, et al. (2009) Comprehensive mapping of long-range interactions reveals folding
  principles of the human genome. *Science* 326:289–293.
- Lioy VS, et al. (2018) Multiscale structuring of the *E. coli* chromosome by nucleoid-associated and
  condensin proteins. *Cell* 172:771–783.
- Lioy VS, Junier I, Lagage V, Vallet I, Boccard F (2020) Distinct activities of bacterial condensins
  for chromosome management in *Pseudomonas aeruginosa*. *Cell Rep* 33:108344.
- Livny J, Yamaichi Y, Waldor MK (2007) Distribution of centromere-like parS sites in bacteria:
  insights from comparative genomics. *J Bacteriol* 189:8693–8703.
- Marbouty M, Le Gall A, Cattoni DI, Cournac A, Koh A, Fiche J-B, Mozziconacci J, Murray H, Koszul R,
  Nollmann M (2015) Condensin- and replication-mediated bacterial chromosome folding and origin
  condensation revealed by Hi-C and super-resolution imaging. *Mol Cell* 59:588–602. [if the mutant
  maps are from here]
- Mercier R, et al. (2008) The MatP/matS site-specific system organizes the terminus region of the
  *E. coli* chromosome into a macrodomain. *Cell* 135:475–485.
- Open2C, Abdennur N, et al. (2024) Cooltools: enabling high-resolution Hi-C analysis in Python.
  *PLoS Comput Biol* 20:e1012067.
- Wang X, Le TBK, Lajoie BR, Dekker J, Laub MT, Rudner DZ (2015) Condensin promotes the
  juxtaposition of DNA flanking its loading site in *Bacillus subtilis*. *Genes Dev* 29:1661–1675.
  [if the mutant maps are from here]
- Wang X, Brandão HB, Le TBK, Laub MT, Rudner DZ (2017) *Bacillus subtilis* SMC complexes juxtapose
  chromosome arms as they travel from origin to terminus. *Science* 355:524–527.
- Only if you discuss the nucleoid periphery:
  - Bignaud A, et al. (2024) Transcription-induced domains form the elementary constraining building
    blocks of bacterial chromosomes. *Nat Struct Mol Biol* 31:489–497.
  - Yang S, et al. (2019) Transcription and translation contribute to gene locus relocation to the
    nucleoid periphery in *E. coli*. *Nat Commun* 10:5131.
