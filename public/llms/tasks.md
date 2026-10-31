# chromosomix analysis tasks

> Every analysis chromosomix runs — 29 tasks, in the app’s Analysis panel and from the `chromosomix` command line, with the same parameters and the same results — with what each reads, what it writes, and every parameter: its flag, what it takes, its default and what it does. Generated from the app’s own task registry, so it is exactly what this release accepts.

## Reading this page

- A task is run as its section’s command shows; installing the command and its shared flags (`--window`, `--no-balance`, `--contacts`, `--coarsen`…) are on the [command line page](https://chromosomix.app/llms/cli.md).
- A parameter’s flag is its key: `--window 20`. A switch takes no value — `--call` turns it on, `--no-call` or `--call=false` off. A list is the flag repeated or one comma-separated value.
- A choice is one of the values listed, exactly, and a number is a number: anything else is refused before a file is opened, with exit status 2 and a sentence naming what the flag takes.
- A locus is written as the app displays it: 1-based and inclusive, digits grouped or not, `IV:1,000,001-1,400,000`.
- A map is read balanced wherever the file carries balancing weights; `--no-balance` reads the raw counts. An `.mcool` names one resolution: `sample.mcool::/resolutions/10000`.
- A task that reads tracks rather than a matrix runs with no map at all, over the assembly its files declare — but then needs a track (`--tracks`, or `--track <file.bw>`) or a reference (`--sequence`) among them; with interval files alone, name a map.
- *Read only under other settings* marks a parameter the app’s form hides at the task’s defaults: it takes effect once another parameter is set to what it belongs to.
- `chromosomix tasks --json` prints all of this as one JSON document, for the installed version.

### Inputs that are files

| A parameter that takes | Formats, and how a command names one |
|---|---|
| a feature set | BED, narrowPeak, GTF/GFF3, genePred, VCF, cytoBand, barChart or splice junctions. Load the file with `--features <file>` and name it in the parameter by its file name; where the parameter is itself called `features`, that one flag does both. |
| a set of pairs | BEDPE, interact or longrange. Load the file with `--pairs <file>` (or `--features <file>`) and name it in the parameter by its file name; where the parameter is itself called `pairs`, that one flag does both. |
| a signal track | bigWig, bedGraph or wig, or a FASTA read as its GC content, by path or address. The file the parameter names is the file loaded. |
| a reference sequence | FASTA, gzipped or not (read by range where its `.fai` is beside it), or `.2bit`. Load it with `--sequence <file>` and give the parameter the same path; where the parameter is itself called `sequence`, that one flag does both. |

### What a task writes

Every result goes into `--out` (default `.`) as `<file stem>.<task>.<output>.<ext>`, and each TSV opens with `#` lines naming the build, the file and every parameter that produced it.

| Result | Files |
|---|---|
| `profile` | a value per bin: TSV, bedGraph and bigWig |
| `curve` | a curve: TSV |
| `matrix` | a matrix, a pileup or a heatmap: TSV |
| `table` | a table: TSV |
| `intervals` | a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model) |

## Index

| Task | Command | Kind | What it does |
|---|---|---|---|
| Coverage and marginals | `coverage` | 2D tasks | How much contact each bin carries, and how much of it stays at home. |
| Cis and trans per sequence | `cistrans` | 2D tasks | How much of each sequence’s contact stays on it, and which pairs touch. |
| Per-cell contact QC | `cellqc` | 2D tasks | What each cell’s contacts look like, and where in the cycle that puts it. |
| Contact probability P(s) | `expected` | 2D tasks | How contact frequency falls with genomic separation. |
| Pairs QC | `pairsqc` | 2D tasks | A library’s records: pairtools stats, P(s) by orientation, and restriction fragments. |
| Scalogram | `scalogram` | 2D tasks | How far each bin’s contacts reach, as nested quantile bands. |
| 4C profile from an anchor | `fourc` | 2D tasks | What one locus touches, as a track you can export. |
| Diamond insulation | `insulation` | 2D tasks | How much contact crosses each bin, and where the boundaries are. |
| Directionality index | `di` | 2D tasks | Which way each bin looks, and the domains the sign flips call. |
| HiC score | `hicscore` | 2D tasks | The mean contact a bin makes with its near neighbourhood. |
| Compartments | `compartments` | 2D tasks | Observed/expected, correlated or taken as it is, and its leading components. |
| Inter-arm alignment | `interarm` | 2D tasks | How strongly the two arms of a bacterial chromosome touch, from origin to terminus. |
| Loop calling | `loops` | 2D tasks | Call loops as pixels enriched over their local background. |
| Pattern detection | `chromosight` | 2D tasks | Find loops, borders, hairpins, centromeres or stripes by template matching. |
| Reproducibility | `hicrep` | 2D tasks | How much the maps on screen agree, stratum by stratum and pooled. |
| Aggregate peak analysis | `apa` | 2D tasks | Pile up the matrix at a set of loops or features, against a control. |
| Model from the map | `reconstruct3d` | 3D tasks | A 3D model of what is loaded: contacts read as distances, beads placed to honour them. |
| Model versus map | `structuremap` | 3D tasks | How well a 3D model’s distances agree with the contacts the map counted. |
| Spatial tracks | `spatialtracks` | 3D tasks | The model as tracks: radial position, distance to a locus, local compaction. |
| Find a motif | `motif` | 1D tasks | Every place a motif occurs, as sites and as a density track. |
| Restriction sites | `restriction` | 1D tasks | Where an enzyme cuts the reference, as sites and as a density track. |
| Peak calling | `peaks` | 1D tasks | Narrow peaks from a coverage track, where its smoothed signal curves down (yapc). |
| Base composition | `composition` | 1D tasks | GC content, GC skew and AT skew per bin, as tracks. |
| Origin and terminus | `oriter` | 1D tasks | Where replication starts and ends, from the GC skew, parS, matS and coverage. |
| Metaplot over a feature set | `metaplot` | 1D tasks | Average track signal at a set of places, with a band and a heatmap. |
| Track correlation | `trackcorr` | 1D tasks | How much every pair of loaded tracks agrees. |
| Fraction of signal in features | `frip` | 1D tasks | How much of each track sits inside a feature set, against how much of the genome it is. |
| Signal by group | `groupsignal` | 1D tasks | A track’s values in each group of the genome — A against B — compared and tested. |
| Interval set overlap | `overlap` | 1D tasks | Jaccard, shared bases, how many features touch — and whether that is more than chance. |

## 2D tasks

### Coverage and marginals — `coverage`

How much contact each bin carries, and how much of it stays at home.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** depth, marginal, balancing, weights.

```sh
chromosomix coverage <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--total / --no-total` | on or off | on | Total coverage: Every contact touching the bin, and flat on a correctly balanced file. |
| `--fraction / --no-fraction` | on or off | off | Cis fraction: Of the contacts a bin has, how many stay on its own sequence. |
| `--cis / --no-cis` | on or off | off | Cis coverage. |
| `--trans / --no-trans` | on or off | off | Trans coverage. |
| `--balance / --balance=false` | on or off | off | Use balancing weights: Worth turning on to check the balancing itself: a balanced file should have a flat total, so one that is not is a file whose weights do not fit it. |

### Cis and trans per sequence — `cistrans`

How much of each sequence’s contact stays on it, and which pairs touch.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a table: TSV; a curve: TSV; a matrix, a pileup or a heatmap: TSV.
- **Also known as:** interchromosomal, trans ratio, karyotype, cis/trans.

```sh
chromosomix cistrans <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--bars <value>` | `cis`, `trans` or `both` | `cis` | Bars per sequence: Fractions of each sequence’s own contact, so a deep sequence and a shallow one compare. `both` — the two sum to one, so every bar is full and the split is the cis fraction. |
| `--normalise <value>` | `enrichment`, `raw` or `bins` | `enrichment` | Off-diagonal value. `enrichment` — contacts over what the two sequences’ own trans coverage predicts. 1 is what any two sequences of that depth would give; a fusion is far above it; `raw` — raw contacts; `bins` — divided by the two sequences’ bin counts. |
| `--minContacts <n>` | a whole number, at least 0 | `10` | Least contact worth listing: Raw contacts, before any normalisation, which keeps one stray read out of the table’s top. |
| `--maxEdges <n>` | a whole number, at least 10 | `500` | Pairs to list. |
| `--matrix / --no-matrix` | on or off | on | Draw the square: Skipped above 512 sequences, where it is not a picture. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Per-cell contact QC — `cellqc`

What each cell’s contacts look like, and where in the cycle that puts it.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a table: TSV; a curve: TSV.
- **Also known as:** single cell, scool, cell cycle, quality.

```sh
chromosomix cellqc <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--cells <value>` | `all` or `selected` | `all` | Cells. `all` — what the choice is made from, so this is the answer that helps make it; `selected` — the ticked ones only. |
| `--nearFrom <n>` | a whole number, at least 0, in bp | `23000` | *Bands.* Near band, from: Below this a contact is mostly self-ligation and unligated ends rather than structure. |
| `--nearTo <n>` | a whole number, at least 1, in bp | `2000000` | *Bands.* Near band, to. |
| `--mitoticTo <n>` | a whole number, at least 1, in bp | `12000000` | *Bands.* Mitotic band, to: The near band’s upper edge is this band’s lower one; beyond it is the far band. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Contact probability P(s) — `expected`

How contact frequency falls with genomic separation.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a curve: TSV.
- **Also known as:** P(s), Ps, decay, distance, scaling, expected, slope.

```sh
chromosomix expected <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--scope <value>` | `contig` or `file` | `contig` | Scope. `contig` — one curve per sequence; `file` — every sequence pooled into one curve. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--quantity <value>` | `density` or `expected` | `density` | Quantity. `density` — share of all cis contacts, per base pair. HiContacts' norm_p; `expected` — mean contact per pair of bins that far apart. What cooltools expected-cis reports. |
| `--factor <n>` | a number, 1.01 to 2 | `1.1` | Log bins per step: Each separation bin is this many times wider than the last. |
| `--minSeparation <n>` | a whole number, at least 0, in bins | `2` | Minimum separation: Drops the near-diagonal, where unligated fragments dominate. |
| `--derivative / --no-derivative` | on or off | on | Log-log slope: The shoulder and the plateau are visible there and not on the curve. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Pairs QC — `pairsqc`

A library’s records: pairtools stats, P(s) by orientation, and restriction fragments.

- **Reads:** a contact map, named as the positional argument.
- **Runs first:** `restriction`, at its defaults, and reads its result.
- **Writes:** a curve: TSV; a table: TSV.
- **Also known as:** pairtools, stats, QC, orientation, strand, convergence, restriction, enzyme, fragment, dangling, self-circle, duplicates, pair types.

```sh
chromosomix pairsqc <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--pairs <file>` | a file or address: `.pairs` or `.pairs.gz` | — | *From the .pairs file.* .pairs file: Read for its records alone: nothing is binned and no map changes. *Not asked of a file that answers it itself.* |
| `--reference <file>` | a file: a reference sequence; optional | not used | *Restriction enzyme.* Reference: The FASTA or .2bit the reads were mapped to, where the enzyme’s sites are found. |
| `--enzyme <value>` | `none`, `DpnII`, `HindIII`, `NcoI`, `EcoRI`, `BglII`, `HinfI`, `DdeI`, `MseI`, `NlaIII`, `CviQI`, `AluI`, `Arima` or `custom` | `none` | *Restriction enzyme.* Enzyme: The enzyme the library was cut with, or a kit that cuts with several. `none` — no enzyme: a library cut with a nuclease, as Micro-C and Omni-C are; `DpnII` — dpnII (^GATC); `HindIII` — hindIII (A^AGCTT); `NcoI` — ncoI (C^CATGG); `EcoRI` — ecoRI (G^AATTC); `BglII` — bglII (A^GATCT); `HinfI` — hinfI (G^ANTC); `DdeI` — ddeI (C^TNAG); `MseI` — mseI (T^TAA); `NlaIII` — nlaIII (CATG^); `CviQI` — cviQI (G^TAC); `AluI` — aluI (AG^CT); `Arima` — arima (DpnII + HinfI); `custom` — enzymes by name, aliases such as MboI included, or sites typed with a ^ where they cut. |
| `--sites <text>` | text | empty | *Restriction enzyme.* Sites: Enzyme names or IUPAC sites with a ^ where the top strand is cut, separated by commas. *Read only under other settings of this task.* |

### Scalogram — `scalogram`

How far each bin’s contacts reach, as nested quantile bands.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** reach, distance, quantiles.

```sh
chromosomix scalogram <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--quantiles <value>` | `standard`, `quartiles` or `deciles` | `standard` | Quantiles: One band per quantile, nested in a single lane. `standard` — lioy et al.’s bands, and what HiContacts draws; `quartiles` — the quartiles alone; `deciles` — a finer picture; nine lanes of ink. |
| `--reach <n>` | a whole number, at least 0, in bins | `0` | Look out to: 0 is the whole sequence; a cut makes every quantile a quantile of what is within it, and the lane says so. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--ignoreDiags <n>` | a whole number, at least 0 | `1` | *Quality.* Diagonals to ignore: 1 drops the bin’s contact with itself, which is not a contact at a distance. |
| `--minValid <n>` | a number, 0 to 1 | `0.5` | *Quality.* Minimum coverage of the distribution: Below this fraction of usable separations the bin gets no bands at all. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### 4C profile from an anchor — `fourc`

What one locus touches, as a track you can export.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** virtual 4C, v4C, viewpoint, anchor.

```sh
chromosomix fourc <map> --anchor <locus> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--anchor <locus>` | a locus, display form | None. | Anchor. |
| `--normalise <value>` | `none`, `coverage`, `ps` or `ps+coverage` | `none` | Normalisation. `none` — contacts as they were counted; `coverage` — each bin divided by how much it is seen at all, so a dead bin is not a dip; `ps` — observed over expected at that separation, from this sequence’s own decay; `ps+coverage` — both divisions: the decay out of the shape, the depth out of each bin. |
| `--cis / --no-cis` | on or off | on | Cis only: On, this reads one sequence and costs a handful of requests; off, it walks the pixel table for the contacts leaving that sequence. |
| `--excludeAnchor / --no-excludeAnchor` | on or off | off | Exclude anchor region: Leave the anchor and one bin either side empty, so its contact with itself does not set the scale. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Diamond insulation — `insulation`

How much contact crosses each bin, and where the boundaries are.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig; a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model).
- **Also known as:** TAD, domains, boundaries, insulation score.

```sh
chromosomix insulation <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--window <n>` | a whole number, at least 1, in bins | `10` | Window: The diamond is a square this many bins on a side, cornered on the bin it scores. |
| `--scales <n>` | a whole number, 1 to 4 | `1` | Scales: One track per scale, each twice the width of the last. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--ignoreDiags <n>` | a whole number, at least 0 | `2` | *Quality.* Diagonals to ignore: 0 counts every cell; 2 leaves out the corner of the diamond on the diagonal. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |
| `--call / --no-call` | on or off | on | *Boundaries.* Call boundaries: Adds the calls as a set of their own, a 1D track under the score to begin with. |
| `--prominence <n>` | a number, 0 to 3 | `0.2` | *Boundaries.* Minimum prominence: How far the track must climb from a minimum before it falls lower, in log2 units. |
| `--minValid <n>` | a number, 0 to 1 | `0.5` | *Boundaries.* Diamond coverage to call: Bins whose diamond holds less than this share of the fullest one’s cells are not called. |
| `--spacing <n>` | a whole number, at least 0, in bins | `0` | *Boundaries.* Minimum spacing: Two calls closer than this many bins keep only the stronger. |
| `--domains / --no-domains` | on or off | on | *Boundaries.* Domains between them: A second set, the span from each call to the next, drawn as corners along the diagonal to begin with. |

### Directionality index — `di`

Which way each bin looks, and the domains the sign flips call.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig; a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model).
- **Also known as:** DI, TAD, domains, boundaries.

```sh
chromosomix di <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--window <n>` | a whole number, at least 1, in bins | `50` | Window: Contacts are summed this many bins each way of every bin, 50 being Dixon et al.’s 2 Mb at the 40 kb they worked at. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--ignoreDiags <n>` | a whole number, at least 0 | `0` | *Quality.* Diagonals to ignore: 0 counts every cell; the bin’s contact with itself is never in either sum. |
| `--minValid <n>` | a number, 0 to 1 | `0.5` | *Quality.* Minimum coverage of each side: Below this fraction of usable cells — on either side — the bin gets no score. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |
| `--call / --no-call` | on or off | on | *Borders.* Call borders: Adds the borders as a set of their own, a 1D track under the index to begin with. |
| `--prominence <n>` | a number, 0 to 200 | `10` | *Borders.* Minimum prominence: How many bins of steady bias the track must carry on both sides of a flip. |
| `--spacing <n>` | a whole number, at least 0, in bins | `0` | *Borders.* Minimum spacing: Two calls closer than this many bins keep only the stronger. |
| `--domains / --no-domains` | on or off | on | *Borders.* Domains between them: A second set, the span from each border to the next, drawn as corners along the diagonal to begin with. |

### HiC score — `hicscore`

The mean contact a bin makes with its near neighbourhood.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** contact density, local contacts.

```sh
chromosomix hicscore <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--diagonals <n>` | a whole number, at least 1 | `3` | Diagonals: How many diagonals the bin’s line crosses, counting the main one — at 3 that is five cells, reaching two bins each way. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--ignoreDiags <n>` | a whole number, at least 0 | `0` | *Quality.* Diagonals to ignore: 0 counts every cell, including the bin’s contact with itself, which at three diagonals is most of the score and is where self-ligation lands. |
| `--minValid <n>` | a number, 0 to 1 | `0.5` | *Quality.* Minimum coverage of the line: Below this fraction of usable cells the bin gets no score at all. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Compartments — `compartments`

Observed/expected, correlated or taken as it is, and its leading components.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig; a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a matrix, a pileup or a heatmap: TSV; a table: TSV.
- **Also known as:** A/B, eigenvector, E1, PCA, saddle, correlation.

```sh
chromosomix compartments <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences: One correlation per sequence under “cis only”, and one over all of them under “cis and trans” or “trans only”. |
| `--contacts <value>` | `cis`, `both` or `trans` | `cis` | Contacts. `cis` — one correlation per sequence, over its own contacts. The cheapest, and per chromosome; `both` — one correlation over everything ticked. Each half keeps its own expectation; `trans` — between sequences alone, so no distance decay enters the answer. Needs two or more. |
| `--ignoreDiags <n>` | a whole number, at least 0 | `2` | Diagonals to ignore: 0 keeps every cell; 1 drops the main diagonal; 2 drops it and the two beside it. |
| `--expected <value>` | `distance` or `arms` | `distance` | Expected. `distance` — the mean of each diagonal: the ordinary observed/expected; `arms` — also removes the secondary diagonal of a bacterial chromosome whose arms are aligned, reading the arms from the origin on the Chromosomes table — the first base unless set. |
| `--armWindow <n>` | a whole number, at least 0, in bins | `50` | Window along the arms: Each cell is compared within this far along the arms; 0 is the whole chromosome. *Read only under other settings of this task.* |
| `--method <value>` | `cooltools` or `correlation` | `cooltools` | Method. `cooltools` — observed/expected itself, clipped at its 99.9th percentile and less one, decomposed; `correlation` — the Pearson correlation of observed/expected’s rows, decomposed. |
| `--components <n>` | a whole number, 1 to 3 | `1` | Components: E1 is the compartment track; E2 and E3 occasionally say something. |
| `--phaseFeatures <file>` | a file: a feature set; optional | not used | *Phasing.* Phase by gene density: Positive is made to mean the compartment these features are dense in. |
| `--phaseTrack <file>` | a file: a signal track; optional | not used | *Phasing.* Phase by a track: Positive is made to follow this track, when no gene model is chosen. |
| `--phaseSequence <file>` | a file: a reference sequence; optional | not used | *Phasing.* Phase by GC content: Used when neither a gene model nor a track is chosen. |
| `--minR <n>` | a number, 0 to 1 | `0.1` | *Phasing.* Least convincing correlation: Below this the sign is left alone and the drawer says the phasing was ambiguous. |
| `--saddle / --no-saddle` | on or off | on | *Saddle.* Draw the saddle: The compartment claim in one square, with AA, BB and AB under it. |
| `--quantiles <n>` | a whole number, 5 to 100 | `50` | *Saddle.* Quantile groups. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Inter-arm alignment — `interarm`

How strongly the two arms of a bacterial chromosome touch, from origin to terminus.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a curve: TSV; a value per bin: TSV, bedGraph and bigWig; a table: TSV.
- **Also known as:** arms, secondary diagonal, bacteria, SMC, ParB.

```sh
chromosomix interarm <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--band <n>` | a whole number, 0 to 50, in bins | `2` | Band: Cells this close to the secondary diagonal are averaged; 0 is the diagonal alone. |
| `--armWindow <n>` | a whole number, at least 0, in bins | `50` | Window along the arms: For the enrichment after detrend: each cell is compared within this far along the arms, as the map’s arms and Compartments do; 0 is the whole chromosome. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Loop calling — `loops`

Call loops as pixels enriched over their local background.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a curve: TSV; a table: TSV.
- **Also known as:** loops, dots, call loops, hiccups, peaks, cooltools dots.

```sh
chromosomix loops <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--outer <n>` | a whole number, 1 to 50, in bins | Worked out from the map's bin size when left out; 5 where there is no map. | Outer half-width: w: how far the donut and the other three neighbourhoods reach from a pixel. |
| `--inner <n>` | a whole number, 0 to 49, in bins | Worked out from the map's bin size when left out; 2 where there is no map. | Inner half-width: p: the square about a pixel none of the four counts, a loop’s own size. |
| `--maxSeparation <n>` | a whole number, at least 1, in bins | Worked out from the map's bin size when left out; 1000 where there is no map. | Furthest from the diagonal: Loops whose anchors are farther apart are not looked for; 10 Mb unless changed. |
| `--fdr <n>` | a number, 0.001 to 0.5 | `0.1` | *Statistics.* False discovery rate: Benjamini–Hochberg, within each λ-chunk of pixels of a like local expected. |
| `--lambdaBins <n>` | a whole number, 40 to 50 | `40` | *Statistics.* Λ-chunks: Log-spaced chunks of local expected, each corrected on its own; 40 to 50 of them. |
| `--clusteringRadius <n>` | a number, at least 0, in bins | Worked out from the map's bin size when left out; 2 where there is no map. | *Clusters.* Clustering radius: Enriched pixels this close are one loop, at its brightest; 0 keeps every pixel, unfiltered. |
| `--filter / --no-filter` | on or off | on | *Clusters.* Enrichment filter: 1.5–2× over the four neighbourhoods, and a lone pixel only at q ≤ 0.02 summed over them. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Pattern detection — `chromosight`

Find loops, borders, hairpins, centromeres or stripes by template matching.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a matrix, a pileup or a heatmap: TSV; a curve: TSV; a table: TSV.
- **Also known as:** template, borders, stripes, hairpins, centromeres.

```sh
chromosomix chromosight <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--pattern <value>` | `loops`, `loops_small`, `borders`, `hairpins`, `centromeres`, `stripes_left` or `stripes_right` | `loops` | Pattern: Every threshold below follows the template: they were tuned together. `loops` — focal contacts between two anchors — the classic dot off the diagonal; `loops_small` — the same, at a tighter 7×7 template, for short-range dots; `borders` — domain boundaries: the corner where one self-interacting block ends and the next begins; `hairpins` — the fold-back signal of a hairpin, on the diagonal; `centromeres` — the large-scale depletion around a centromere; `stripes_left` — an architectural stripe running left from an anchor; `stripes_right` — an architectural stripe running right from an anchor. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--thresholds <value>` | `preset` or `custom` | `preset` | *Scan.* Thresholds. `preset` — the template’s own numbers, tuned for it and published with it; `custom` — the boxes start at the loops preset; check them against the pattern you picked. |
| `--pearson <n>` | a number, 0 to 1 | `0.3` | *Scan.* Score threshold: The correlation a pixel must reach to be a candidate; lower finds more, and more of it is noise. *Read only under other settings of this task.* |
| `--minDist <n>` | a whole number, at least 0, in bins | `10` | *Scan.* Nearest to the diagonal. *Read only under other settings of this task.* |
| `--maxDist <n>` | a whole number, at least 0, in bins | `1000` | *Scan.* Furthest from the diagonal: The scan band: widening it costs time in proportion, and zero puts the pattern on the diagonal. *Read only under other settings of this task.* |
| `--minSeparation <n>` | a whole number, at least 0, in bins | `3` | *Scan.* Nearest two calls may be: Closer than this on both axes and only the higher-scoring one is kept. *Read only under other settings of this task.* |
| `--iterations <n>` | a whole number, 1 to 5 | `1` | *Scan.* Refinement passes: Each pass re-scans with the pileup of what the last one found as its template. |
| `--maxPercUndetected <n>` | a number, 0 to 100, in % | `50` | *Quality.* Most undetectable pixels a window may hold. *Read only under other settings of this task.* |
| `--maxPercZero <n>` | a number, 0 to 100, in % | `10` | *Quality.* Most empty pixels a window may hold. *Read only under other settings of this task.* |
| `--nMads <n>` | a number, 1 to 20 | `5` | *Quality.* Detectability cut: Median absolute deviations below the median coverage, and only read where the file has no weights. |
| `--maxQvalue <n>` | a number, 0 to 1 | `1` | *Quality.* Report down to a q-value of: Benjamini-Hochberg over every call; 1 keeps them all and still reports the number. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Reproducibility — `hicrep`

How much the maps on screen agree, stratum by stratum and pooled.

- **Reads:** a contact map, named as the positional argument, and the maps it is compared with, by `--against`.
- **Writes:** a table: TSV; a matrix, a pileup or a heatmap: TSV; a curve: TSV.
- **Also known as:** HiCRep, SCC, replicates, similarity, correlation.

```sh
chromosomix hicrep <map> --against <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--against <file>` | a file or address: | — | Other maps: The other contact maps to compare with; repeat the flag for each. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences: Each is scored on its own as well as pooled. |
| `--maxDistance <n>` | a whole number, 1 to 500, in bins | `500` | Furthest separation compared: Every stratum out to here counts, weighted by the positions it compares — so this moves the answer, as hicrep’s dBPMax does: 5 Mb is 50 strata at 100 kb. |
| `--smooth <n>` | a whole number, 0 to 20, in bins | `1` | Smoothing half-width: The 2D mean filter HiCRep applies before correlating; 0 measures depth as much as structure on any sparse pair of maps. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Aggregate peak analysis — `apa`

Pile up the matrix at a set of loops or features, against a control.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a matrix, a pileup or a heatmap: TSV; a table: TSV; a curve: TSV.
- **Also known as:** APA, pileup, aggregate, loops, coolpup.

```sh
chromosomix apa <map> --pairs <pairs.bedpe> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--anchors <value>` | `pairs`, `features`, `allpairs` or `consecutive` | `pairs` | Anchors. `pairs` — off the diagonal, between two anchors; `features` — on the diagonal, at each feature; `allpairs` — off the diagonal, between every two features within a separation range — the test of whether a set of places contacts itself; `consecutive` — off the diagonal, between each feature and the next one along its sequence — the pairs of neighbouring sites, such as consecutive CTCF peaks. |
| `--pairs <file>` | a file: a set of pairs | — | Pairs. |
| `--features <file>` | a file: a feature set | — | Features. *Read only under other settings of this task.* |
| `--mode <value>` | `fixed` or `scaled` | `fixed` | Mode. `fixed` — centre plus or minus a number of bins; `scaled` — flank, the feature, flank — every window on one grid. Over a set of domains this is the domain pileup: the TAD in the middle and its two boundaries as the cross through it. |
| `--at <value>` | `centre`, `start` or `end` | `centre` | Anchor on. `centre` — half way along the feature; `start` — its 5′ end — a TSS, on a gene model; `end` — its 3′ end. *Read only under other settings of this task.* |
| `--window <n>` | a whole number, 1 to 200, in bins | `21` | Half-width. |
| `--grid <n>` | a whole number, 11 to 201 | `51` | Grid: Every window resampled to this many cells a side; a multiple of four puts the feature’s two ends on axis ticks. *Read only under other settings of this task.* |
| `--flankFraction <n>` | a number, 0 to 2 | `0.5` | Flank: As a fraction of the feature’s own length each side: at 0.5 the feature is the middle half of the picture, at 1 the middle third. *Read only under other settings of this task.* |
| `--minDiag <n>` | a whole number, 0 to 50 | `2` | Diagonals left out: The main diagonal and the ones beside it, left out of every window; 0 keeps every one. |
| `--norm <value>` | `matched`, `oe`, `none` or `chromosight` | `oe` | Normalisation. `matched` — against shifted anchors at the same separations. Controls for local background too; `oe` — each window over its sequence’s own P(s). Controls for the distance decay only; `none` — the raw pileup; `chromosight` — the map detrended by its own distance law, then averaged — and every anchor scored against the template. |
| `--csPattern <value>` | `loops`, `loops_small`, `borders`, `hairpins`, `centromeres`, `stripes_left` or `stripes_right` | `loops` | Template: What each window is scored against, and how wide it is. `loops` — focal contacts between two anchors — the classic dot off the diagonal; `loops_small` — the same, at a tighter 7×7 template, for short-range dots; `borders` — domain boundaries: the corner where one self-interacting block ends and the next begins; `hairpins` — the fold-back signal of a hairpin, on the diagonal; `centromeres` — the large-scale depletion around a centromere; `stripes_left` — an architectural stripe running left from an anchor; `stripes_right` — an architectural stripe running right from an anchor. *Read only under other settings of this task.* |
| `--controls <n>` | a whole number, 1 to 25 | `5` | *Control.* Controls per pair. *Read only under other settings of this task.* |
| `--minShift <n>` | a whole number, at least 0, in bins | `50` | *Control.* Smallest shift: A control nearer than the window’s own width overlaps the anchors it stands in for. *Read only under other settings of this task.* |
| `--maxShift <n>` | a whole number, at least 1, in bins | `500` | *Control.* Largest shift. *Read only under other settings of this task.* |
| `--minShiftScale <n>` | a number, 0 to 20 | `1` | *Control.* Smallest shift: As a multiple of the window’s own width; below 1 a control overlaps the feature. *Read only under other settings of this task.* |
| `--maxShiftScale <n>` | a number, 0.5 to 50 | `3` | *Control.* Largest shift. *Read only under other settings of this task.* |
| `--seed <n>` | a seed, a whole number | `1` | *Control.* Seed: The same seed gives the same control twice. *Read only under other settings of this task.* |
| `--minDist <n>` | a whole number, at least 0, in bins | `5` | *Separation.* Nearest loop: Loops nearer the diagonal than this are left out, 0 keeping every one; from twice the half-width and two, no window reaches the first two diagonals. |
| `--minSep <n>` | a whole number, at least 0, in bins | `2` | *Separation.* Nearest two features may be: Below this a pair is mostly the diagonal it sits on rather than a contact between two places. *Read only under other settings of this task.* |
| `--maxSep <n>` | a whole number, at least 1, in bins | `200` | *Separation.* Furthest two features may be. *Read only under other settings of this task.* |
| `--byDistance <n>` | a whole number, 0 to 6 | `0` | *Separation.* Split by separation into: Log-spaced bands, each piled up on its own with its own control; one band averages a 30 kb contact and a 2 Mb one into a picture of neither. |
| `--rankBy <column>` | a numeric column of the set `--features` names; optional | not used | *Ranking.* Rank by. *Read only under other settings of this task.* |
| `--subset <value>` | `all`, `top` or `groups` | `all` | *Ranking.* Then. `all` — one pileup; `top` — top N; `groups` — k groups. *Read only under other settings of this task.* |
| `--count <n>` | a whole number, at least 1 | `500` | *Ranking.* N. *Read only under other settings of this task.* |
| `--groups <n>` | a whole number, 2 to 6 | `4` | *Ranking.* Groups. *Read only under other settings of this task.* |
| `--tracks <file,…>` | files: a signal track; optional | not used | *Tracks.* Track aggregates: Each is averaged over the same windows the pileup is taken from and drawn along its two edges — the aggregate signal above and beside the aggregate map. |
| `--symmetric / --no-symmetric` | on or off | on | *Tracks.* Same profile both sides: One aggregate over every anchor, drawn identically above and beside. Untick to keep each pair’s two anchors apart — the second along the top, the first down the right. *Read only under other settings of this task.* |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

## 3D tasks

### Model from the map — `reconstruct3d`

A 3D model of what is loaded: contacts read as distances, beads placed to honour them.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a table: TSV.
- **Also known as:** 3D, structure, reconstruction, ShRec3D, negative binomial.

```sh
chromosomix reconstruct3d <map> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--method <value>` | `nb` or `shrec3d` | `nb` | Method: The two published readings of a contact count, which give different models of the same map. `nb` — fits the model the counts are likeliest under, so a pair counted zero times is evidence rather than a distance to invent; `shrec3d` — faster, and what most published models were made with, but it has to invent a distance for every pair the map never counted. |
| `--region <locus,…>` | loci, comma-separated, display form | Every sequence of the file when left out. | Sequences: A locus or comma-separated sequences, empty for the whole file, one bead per bin. |
| `--alpha <n>` | a number, 0.5 to 6 | `3` | Exponent α: How steeply contacts fall off with distance: 3 is the fractal-globule value, 1 flattens the near diagonal, 6 stretches it. |
| `--weights <value>` | `contacts`, `sqrt` or `equal` | `contacts` | Weight pairs by: How strongly a pair’s count holds its beads at the distance it implies. `contacts` — a pair seen a thousand times is a thousand times as sure as one seen once; `sqrt` — a weak pair is still heard on a deep map; `equal` — one vote each, which lets the far, weak pairs outvote the near diagonal. *Read only under other settings of this task.* |
| `--seed <n>` | a seed, a whole number | `0` | Seed: Where pastis’ MDS places the beads before the fit; another seed can settle in another optimum. |
| `--iterations <n>` | a whole number, 0 to 2000 | `150` | Refinement steps: How many steps refine the beads after the start, stopping earlier once a step stops buying anything. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Model versus map — `structuremap`

How well a 3D model’s distances agree with the contacts the map counted.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a matrix, a pileup or a heatmap: TSV; a curve: TSV; a table: TSV.
- **Also known as:** 3D, structure, distances.

```sh
chromosomix structuremap <map> --features <structure.bed3d> --structure <structure.bed3d> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--structure <file>` | a file: a feature set | — | Structure: The model to read: a row of the Structures card. |
| `--region <locus,…>` | loci, comma-separated, display form | Every sequence of the file when left out. | Sequences: The matrices are drawn for the first named; the table covers them all. |
| `--alpha <n>` | a number, 0.5 to 6 | `3` | Exponent α: Contacts fall as 1/dᵅ in the predicted map; only the picture depends on it. |
| `--no-balance` | a switch | On wherever the file carries balancing weights; --no-balance reads the raw counts. | Use balancing weights. |

### Spatial tracks — `spatialtracks`

The model as tracks: radial position, distance to a locus, local compaction.

- **Reads:** a contact map, named as the positional argument.
- **Writes:** a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** 3D, structure, radial position, compaction.

```sh
chromosomix spatialtracks <map> --features <structure.bed3d> --structure <structure.bed3d> --locus <locus> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--structure <file>` | a file: a feature set | — | Structure: The model to read: a row of the Structures card. |
| `--locus <locus>` | a locus, display form | None. | Distance to: A locus to measure every bead’s distance from — the spatial virtual 4C — and empty leaves the other two tracks alone. |
| `--window <n>` | a whole number, 1 to 100 | `5` | Compaction window: How many beads either side a bead is compared with, for the local compaction track. |

## 1D tasks

### Find a motif — `motif`

Every place a motif occurs, as sites and as a density track.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** sequence, pattern, sites, GATC, restriction.

```sh
chromosomix motif [<map>] --sequence <sequence.fa> --pattern <pattern> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequence <file>` | a file: a reference sequence | — | Reference: The FASTA or .2bit to search — its own sequences, in its own order. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--pattern <text>` | text | None. | Motif: IUPAC — A C G T U and the ambiguity codes R Y S W K M B D H V N — with spaces and case ignored and every overlapping match counted. |
| `--bothStrands / --no-bothStrands` | on or off | on | Both strands: A palindrome is still reported once, not twice. |
| `--mismatches <n>` | a whole number, 0 to 4 | `0` | Mismatches: Positions a site may differ from the motif by; N in the motif is always free. |
| `--limit <n>` | a whole number, 1 to 500000 | `500000` | Most sites: A backstop against a pattern like N: up to 500,000, and the run says so when it bites. |

### Restriction sites — `restriction`

Where an enzyme cuts the reference, as sites and as a density track.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** enzyme, digest, fragments, cut sites, DpnII, MboI, HindIII, Arima.

```sh
chromosomix restriction [<map>] --sequence <sequence.fa> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequence <file>` | a file: a reference sequence | — | Reference: The FASTA or .2bit to cut, with its own sequences in its own order. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--enzyme <value>` | `none`, `DpnII`, `HindIII`, `NcoI`, `EcoRI`, `BglII`, `HinfI`, `DdeI`, `MseI`, `NlaIII`, `CviQI`, `AluI`, `Arima` or `custom` | `none` | Enzyme: The enzyme the library was cut with, or a kit that cuts with several. `none` — no enzyme: a library cut with a nuclease, as Micro-C and Omni-C are; `DpnII` — dpnII (^GATC); `HindIII` — hindIII (A^AGCTT); `NcoI` — ncoI (C^CATGG); `EcoRI` — ecoRI (G^AATTC); `BglII` — bglII (A^GATCT); `HinfI` — hinfI (G^ANTC); `DdeI` — ddeI (C^TNAG); `MseI` — mseI (T^TAA); `NlaIII` — nlaIII (CATG^); `CviQI` — cviQI (G^TAC); `AluI` — aluI (AG^CT); `Arima` — arima (DpnII + HinfI); `custom` — enzymes by name, aliases such as MboI included, or sites typed with a ^ where they cut. |
| `--sites <text>` | text | empty | Sites: Enzyme names or IUPAC sites with a ^ where the top strand is cut, separated by commas. *Read only under other settings of this task.* |

### Peak calling — `peaks`

Narrow peaks from a coverage track, where its smoothed signal curves down (yapc).

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a table: TSV; a curve: TSV.
- **Also known as:** peaks, yapc, narrowPeak, ChIP, ATAC.

```sh
chromosomix peaks [<map>] --signal <signal.bw> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--signal <file>` | a file: a signal track | — | Track: The coverage to call on, as normalised; a bigWig, a bedGraph or a wig. |
| `--replicate <file>` | a file: a signal track; optional | not used | Replicate: A second replicate of the same experiment; with one, IDR tests every peak. |
| `--idr <value>` | `0.001`, `0.005`, `0.01`, `0.05`, `0.1` or `0.2` | `0.05` | IDR threshold: Keep peaks whose global IDR is at most this. *Read only under other settings of this task.* |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--perPeak / --no-perPeak` | on or off | off | List every peak: One row per peak, with its summit, its scores and its IDR; long on a large genome. |
| `--width <n>` | a whole number, 1 to 2000, in bp | `150` | *Smoothing.* Smoothing window: yapc’s default; 75 to 200 bp suits most narrow peaks. |
| `--times <n>` | a whole number, 0 to 10 | `3` | *Smoothing.* Smoothing passes: Rolling means applied to the second derivative. |
| `--minWidth <n>` | a whole number, at least 1, in bp | `75` | *Peaks.* Narrowest peak: Concave stretches narrower than this are dropped. |
| `--halfWidth <n>` | a whole number, at least 0, in bp | `0` | *Peaks.* Fixed half-width: 0 keeps each peak’s concave bounds; otherwise this many bases each side of its summit. |
| `--truncate <n>` | a whole number, at least 1 | `100000` | *Peaks.* Keep the strongest: By each track’s curvature rank, before IDR; with one track, the only cut. |

### Base composition — `composition`

GC content, GC skew and AT skew per bin, as tracks.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** GC, GC skew, AT skew.

```sh
chromosomix composition [<map>] --sequence <sequence.fa> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequence <file>` | a file: a reference sequence | — | Reference: The FASTA to read, under the names of the sequences open. |
| `--resolution <n>` | a whole number, at least 1, in bp | Worked out from the map's bin size when left out; 10000 where there is no map. | Bin size: The open map’s resolution unless changed, and 10 kb with no map open. |
| `--window <n>` | a whole number, at least 0, in bp | `0` | Window: 0 reads each bin alone; wider reads that many bases centred on it. |
| `--gc / --no-gc` | on or off | on | *Tracks.* GC content. |
| `--gcSkew / --no-gcSkew` | on or off | on | *Tracks.* GC skew: (G − C) / (G + C), which changes sign at the origin and the terminus. |
| `--atSkew / --no-atSkew` | on or off | on | *Tracks.* AT skew: (A − T) / (A + T). |
| `--cumulative / --no-cumulative` | on or off | on | *Tracks.* Cumulative GC skew: Its minimum is the origin and its maximum the terminus. |

### Origin and terminus — `oriter`

Where replication starts and ends, from the GC skew, parS, matS and coverage.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model); a table: TSV; a value per bin: TSV, bedGraph and bigWig.
- **Also known as:** ori, ter, replication, GC skew, dif.

```sh
chromosomix oriter [<map>] --sequence <sequence.fa> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--sequence <file>` | a file: a reference sequence | — | Reference: The FASTA to read the skew and the sites from. |
| `--sequences <name,…>` | sequence names, comma-separated | Every sequence of the file when left out. | Sequences. |
| `--coverage <file>` | a file: a signal track; optional | not used | Coverage: Raw Hi-C coverage: breaks a tie, and gives the ori/ter ratio. |
| `--window <n>` | a whole number, at least 100, in bp | `5000` | *GC skew.* Skew window. |
| `--step <n>` | a whole number, at least 10, in bp | `1000` | *GC skew.* Skew step. |
| `--parS <text>` | text | `TGTTNCACGTGNAACA` | *Sites.* ParS motif: Sites cluster round the origin; empty skips them. |
| `--parSMismatches <n>` | a whole number, 0 to 4 | `1` | *Sites.* ParS mismatches. |
| `--matS <text>` | text | `GTGACRNYGTCAC` | *Sites.* MatS motif: Ten or more sites place the terminus; empty skips them. |
| `--matSMismatches <n>` | a whole number, 0 to 4 | `0` | *Sites.* MatS mismatches. |
| `--knots <n>` | a whole number, 4 to 40 | `10` | *Coverage.* Spline knots: Of the cubic spline the coverage is smoothed with. *Read only under other settings of this task.* |

### Metaplot over a feature set — `metaplot`

Average track signal at a set of places, with a band and a heatmap.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a curve: TSV; a matrix, a pileup or a heatmap: TSV.
- **Also known as:** profile, aggregate, average, TSS, deeptools.

```sh
chromosomix metaplot [<map>] --tracks <tracks.bw> --features <features.bed> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--tracks <file,…>` | files: a signal track | — | Tracks. |
| `--features <file>` | a file: a feature set | — | Features. |
| `--mode <value>` | `reference` or `scaled` | `reference` | Mode. `reference` — a fixed flank around one point; `scaled` — every feature body resampled to one width. |
| `--at <value>` | `start`, `centre` or `end` | `start` | Anchor on. |
| `--flank <n>` | a number, at least 0, in bp | `2000` | Flank: Read this far either side of the anchor. |
| `--step <n>` | a number, at least 1, in bp | `50` | Resolution: One column of the plot per this many base pairs. |
| `--body <n>` | a whole number, at least 10 | `100` | Body columns. *Read only under other settings of this task.* |
| `--stranded / --no-stranded` | on or off | on | Respect strand: A minus-strand feature is read right to left, or an asymmetric signal cancels itself. |
| `--rankBy <column>` | a numeric column of the set `--features` names; optional | not used | *Ranking.* Rank by. |
| `--subset <value>` | `all`, `top`, `bottom` or `groups` | `all` | *Ranking.* Then. `all` — rank only; still one average; `top` — top N; `bottom` — bottom N; `groups` — one line per equal-sized group. *Read only under other settings of this task.* |
| `--count <n>` | a whole number, at least 1 | `500` | *Ranking.* N. *Read only under other settings of this task.* |
| `--groups <n>` | a whole number, 2 to 10 | `4` | *Ranking.* Groups. *Read only under other settings of this task.* |
| `--zscore / --no-zscore` | on or off | off | *Summary.* Z-score tracks first: Centre and scale each track by its own mean and SD over this run’s windows, so tracks in different units share one axis. |
| `--average <value>` | `mean`, `median` or `trimmed` | `mean` | *Summary.* Average. |
| `--band <value>` | `bootstrap`, `sd` or `none` | `bootstrap` | *Summary.* Band. `bootstrap` — bootstrap CI; `sd` — SD. |
| `--iterations <n>` | a whole number, 20 to 2000 | `200` | *Summary.* Bootstrap draws. |
| `--seed <n>` | a seed, a whole number | `1` | *Summary.* Seed: The same seed gives the same band twice. |
| `--heatmap / --no-heatmap` | on or off | on | *Summary.* Per-feature heatmap: The mean of a bimodal set is a line that describes nothing. |

### Track correlation — `trackcorr`

How much every pair of loaded tracks agrees.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a matrix, a pileup or a heatmap: TSV; a table: TSV.
- **Also known as:** Pearson, Spearman, compare tracks.

```sh
chromosomix trackcorr [<map>] --tracks <tracks.bw> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--tracks <file,…>` | files: a signal track | — | Tracks. |
| `--over <value>` | `bins` or `features` | `bins` | Compare over. `bins` — everywhere, including the empty majority; `features` — only where something is happening. |
| `--binsize <n>` | a whole number, at least 1, in bp | `100` | Window. |
| `--features <file>` | a file: a feature set | — | Features. *Read only under other settings of this task.* |
| `--method <value>` | `spearman` or `pearson` | `spearman` | Method. `spearman` — rank-based; robust to one very deep locus; `pearson` — pearson. |

### Fraction of signal in features — `frip`

How much of each track sits inside a feature set, against how much of the genome it is.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a table: TSV.
- **Also known as:** FRiP, reads in peaks, enrichment.

```sh
chromosomix frip [<map>] --tracks <tracks.bw> --features <features.bed> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--tracks <file,…>` | files: a signal track | — | Tracks. |
| `--features <file>` | a file: a feature set | — | Features. |
| `--resolution <n>` | a whole number, at least 0, in bp | `0` | Read features at: 0 is auto: about 50 samples across a feature of the set’s median width. |
| `--perFeature / --no-perFeature` | on or off | off | Score every feature: One row per feature, so a FRiP carried by a handful of them can be seen to be. |

### Signal by group — `groupsignal`

A track’s values in each group of the genome — A against B — compared and tested.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a curve: TSV; a table: TSV; a set of intervals: TSV, and BED (or BEDPE for pairs, or bed3d and PDB for a 3D model).
- **Also known as:** A versus B, compartment signal, box plot, test.

```sh
chromosomix groupsignal [<map>] --tracks <tracks.bw> --features <features.bed> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--tracks <file,…>` | files: a signal track | — | Tracks: The values compared between the groups. |
| `--groupBy <value>` | `features` or `track` | `features` | Groups from. `features` — its intervals, split by what is written on them: A and B on a compartment call; `track` — its bins, cut by sign or into quantiles: an eigenvector’s two compartments. |
| `--features <file>` | a file: a feature set | — | Features. |
| `--split <value>` | `name`, `strand`, `score` or `none` | `name` | Split the set by. `name` — one group per name the features carry; `score` — score, in quantiles; `none` — nothing: one group. |
| `--outside / --no-outside` | on or off | on | The rest as a group: Every base the set does not cover, as one more group. |
| `--groupTrack <file>` | a file: a signal track; optional | not used | Grouping track. *Read only under other settings of this task.* |
| `--cut <value>` | `sign` or `quantiles` | `sign` | Cut it by. `sign` — above zero and below it; `quantiles` — equal numbers of bins, lowest to highest. *Read only under other settings of this task.* |
| `--quantiles <n>` | a whole number, 2 to 10 | `4` | Quantiles. *Read only under other settings of this task.* |
| `--resolution <n>` | a whole number, at least 0, in bp | `0` | Bin size: 0 compares one value per entry — a run of features, the stretch between two, a run of bins in one group — and any other size compares stretches of at most that many bases. |
| `--perFeature / --no-perFeature` | on or off | off | Score every feature: A row per feature of the set, its mean on every track. |

### Interval set overlap — `overlap`

Jaccard, shared bases, how many features touch — and whether that is more than chance.

- **Reads:** tracks and interval files, with or without a contact map.
- **Writes:** a table: TSV.
- **Also known as:** intersect, Jaccard, bedtools.

```sh
chromosomix overlap <map> --features <a.bed> --a <a.bed> --features <b.bed> --b <b.bed> [--<parameter> <value> …] --out <dir>
```

| Flag | Takes | Default | What it is |
|---|---|---|---|
| `--a <file>` | a file: a feature set | — | First set. |
| `--b <file>` | a file: a feature set | — | Second set. |
| `--minFraction <n>` | a number, 0 to 1 | `0.000001` | Least of a feature covered: A feature counts as hit when this fraction of it is inside the other set. |
| `--shuffle / --no-shuffle` | on or off | off | Shuffled null: Relocates one set at random within the sequences it already occupies, keeping its count and its lengths, and reports the observed overlap against that null. |
| `--shuffleWhich <value>` | `a` or `b` | `a` | Set that moves. `a` — “Are the first set’s features on the second’s?”; `b` — the second. *Read only under other settings of this task.* |
| `--iterations <n>` | a whole number, 20 to 100000 | `1000` | Shuffles: The smallest p a run can report is one over this, plus one. *Read only under other settings of this task.* |
| `--seed <n>` | a seed, a whole number | `1` | Seed: The same seed gives the same null twice. *Read only under other settings of this task.* |
