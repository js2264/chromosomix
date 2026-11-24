# Curating the genomes — design note

> **Status, 2026-11-24.** Being built. `SPECS.md` §33 (curating the genomes) is the contract, and each
> subsection there says *built* as it lands; this note is the design it was written from — the
> decisions and who made them, the model of a curation, the lens the session is drawn through, the
> method behind the suggestions with the numbers it was held to, the stage, and the order it is built
> in. It is a **dev feature** (§29): on `main`, invisible to a reader who has not asked for it.

The feature in one sentence: **a stage where the reader curates a metagenome's binning — moves
contigs between genomes, merges the fragments of one organism, recruits the contigs binning left
out, gathers mobile genetic elements and says which genomes host them — guided by suggestions the app
computes from the contacts and the marker genes, with every genome's completeness and redundancy
recomputed as each step is made, and the whole session drawn through the curated binning.** It is the
work a curator does by hand with anvi'o's refine view, uBin or a spreadsheet of CheckM numbers, with
three differences that are the reason to build it here: nothing is installed or uploaded (C1, §11);
the contacts that a Hi-C binning rests on are on screen beside every decision; and the app says where
it thinks the binning is wrong, with the evidence, where the reader's eye already is.

It is the whole-metagenome sibling of §27.10, which edits one genome's contigs — their order, their
orientation, their joins — and can send a contig to another genome or bring one in. That stage stays
what it is: a genome's scaffolds. This one is the metagenome's membership.

---

## 1. What was decided, and by whom

Every line below was put to the author as a question on 2026-11-24 and is their answer, not a default.

| Question | Answer |
|---|---|
| Where it lives | **Its own full-window stage**, the shell the reference editor uses (§27.3), over the whole metagenome: a genomes list, the pictures, and an inspector with suggestions, history and export |
| How far a curation reaches | **The whole session, from the start**: the genomes table, the genome and genome-pair views, the genome × genome overview, the Binning QC card and every task see the curated genomes, through a lens over the unchanged file |
| What comes out | **Tables**: contig → genome for `metacooler reassign`, mobile element → contigs, element ↔ host with its evidence and who decided it |
| Completeness and redundancy | **metaTOR stores each contig's marker genes in the map** (`metator markers`), and the app recomputes miComplete's four numbers live for every genome a step changes |
| A mobile element and a MAG | **Exclusive; hosts are links.** Every contig is in exactly one MAG, one element, or no genome; a host is a many-to-many link between an element and a MAG, never a membership |
| Where elements come from | **The file** (metaTOR's round `mge` and the genomes it made of them) and **the hand** (contigs made an element, or added to one) |
| Host evidence | **chromosomix's own score**, not metaTOR's rule — admitted on its own validation (§7 below) |
| Suggestions | **Merge** the fragments of one organism, **recruit** an unbinned contig and **move** a misplaced one, **link** an element to its host and drop a link the binning no longer supports |
| Pictures | **A contact map** (genome × genome, then the contigs of the genomes selected), **a host map** (MAGs and elements, linked) and **a GC × coverage scatter** of the contigs |
| The ground truth of the mock community | **Validation only**: tests and this note score the method against it; nothing about it is in the app |
| Process | **Built directly** into the app, reviewed through the gallery's screenshots |
| Demo data | **The mock community's map is replaced** by MM133 — the same library, binned by metaTOR 1.4 with its mobile elements and their hosts, and the markers — and every gallery and test naming its genomes follows |
| The ~13 Mb of genomes the mock's reference does not have | **Not counted either way**: reported apart in the validation |
| The host of the *Vibrio* phages 115E34 and 191E37 and the hitchhiker | ***V. cholerae***, the mock's only *Vibrio* |
| The name | **Curate the genomes** — the palette's *Curate the genomes*, and the heading's word `genomes · as in the file`, then `genomes · curated · 7 steps` |

---

## 2. Words

The **original** binning is the file's: each contig in the genome `/contigs/genome_id` names, or in
none (`__unbinned__`). A **genome** is a **MAG** or a **mobile element** (an *element*): a MAG is a
genome the binning made of chromosomes; an element is a cluster of contigs that are a plasmid, a phage
or another mobile genetic element. A contig in no genome is **unbinned**; the unbinned contigs are a
**pool**, never a genome (§7.4). A **host link** says that a MAG hosts an element; an element may have
several hosts and a MAG several elements.

A **curation** is what the reader has done to the binning — an ordered **history** of **steps**, each
one operation — and the **curated binning** is its result: every contig's genome, every genome's
name and kind, every host link. The mapping from the file to the curated binning is the **lens**, and
the whole session is drawn through it. A **suggestion** is a step the app proposes, with its
**confidence** and its **evidence**.

**Affinity** is how densely something meets a genome, against how densely the genome's own contigs
meet each other: 1 is *as densely as its own*, 0 is never. It is the one number the stage weighs a
merge, a recruit, a move and a host link by (§5).

---

## 3. The model

### 3.1 A curation

```ts
type GenomeKind = 'mag' | 'element'

interface CurationStep {          // one of:
  // contigs moved to a genome, or to the pool (`to: null`)
  move: { contigs: string[]; to: string | null }
  // a new genome of these contigs, taken from wherever they were
  create: { name: string; kind: GenomeKind; contigs: string[] }
  // genomes of one kind made one, under the first's name
  merge: { into: string; genomes: string[] }
  // a genome's contigs sent to the pool, the genome gone
  dissolve: { genome: string }
  rename: { genome: string; name: string }
  // a MAG declared an element, or an element a MAG
  retype: { genome: string; kind: GenomeKind }
  link: { element: string; mag: string }
  unlink: { element: string; mag: string }
}

interface Curation {
  version: 1
  original: { contigs: number; digest: string }   // the binning it was made against
  history: HistoryEntry<CurationStep>[]             // oldest first; the curated binning is their fold
  cursor: number                                    // how many are applied (undo moves it back)
}
```

**Steps name contigs and genomes, never indices**, so a step means what it meant when it was made
whatever came before it, and a history replays from the file's binning in one pass — each step
touches the contigs it names, so a history of hundreds of steps folds in milliseconds over twenty
thousand contigs. Each step carries **who** made it (the reader, a suggestion, or auto mode), **when**,
and for a suggestion **the evidence it was accepted on**, frozen. **Undo** and **redo** move the
cursor; a step made after an undo drops the steps past it.

**Names.** A genome keeps its file name for as long as it exists, through every contig moved in or
out. A merge keeps the first genome's name. A genome the curation creates is named `<map>_curated_001`,
`_002`, … for a MAG and `<map>_element_001`, … for an element — never a name the file already uses —
and the reader renames; a rename is a step, refused for a name another genome has or `__unbinned__`.

**The fingerprint.** A curation carries the number of contigs of the file and a digest of the
binning it was made against — every contig's name, length and genome name, in the file's order, and
the elements of round `mge` with their contigs and hosts. Opened on a file whose binning differs — a
`reassign` since, another run of metaTOR — it is **kept, not applied**, and the stage says so, as a
reference edit made on another assembly is (§27.2).

### 3.2 The original binning, read

- A genome is a **MAG** unless it is an element. It is an **element** when its name is a cluster's of
  the clustering round `mge` (metaTOR made it a genome of the map) or its `mge` column says `True`.
- **The clusters of round `mge` are elements even where the file's genomes are not**: a map on which
  `metator mge` ran without making its clusters genomes holds them only in `/clusters`. Their contigs
  are the element's — taken out of whatever genome the file has them in, as `metator host` counts them
  — so the curated binning is exclusive from the first step.
- The **host links** of the file are the `hosts` of round `mge` (`metator host`): each a link the
  curation starts from, kept until a step drops it.
- `__unbinned__` is the pool, wherever it is, by name and never by index (§7.4).

### 3.3 The curated binning

The fold of the applied steps over the original: for every contig its genome or none; for every genome
its name, kind, contigs, and whether its contig set is **as in the file** — the same contigs as a genome
of the file under the same name — or **changed**; every host link and whether the file had it. It is a
plain value: the stage draws it, the lens presents the map through it, the exports write it.

### 3.4 Persistence

A fact about the file, kept as the reference edit is (`state/referenceEdit.ts`): per file in
`UiMemory` under its own scope, carried in a saved workspace and in a shared link's `#session=`
payload, read back through `readTab`, and **a dev feature's record** (§29.4): left as it was while the
switch is off. Kept separately from a genome's reference edit (§27.10), which is keyed by the genome's
name: curating the binning does not touch a genome's scaffolds, and a genome's edit whose contigs the
curation changed is kept, not applied, by the rule that edit already has.

---

## 4. The lens: the session through the curated binning

The file is never written (§13). The curated binning is **presented**: the reader opens the file as
it is and presents it as the map `metacooler reassign --layout genome-then-length` writes from the
curation's contig → genome table (§6) — its contigs regrouped in `reassign`'s order: `__unbinned__`
first where it holds a contig, then the genomes by name in code-point order, each genome's contigs
longest first and a tie by name — and a genome layer of the curated genomes: their names, kinds,
lengths, contigs and bins, their offsets, and their metadata columns. `reassign`'s order rather than
the file's, so that the session drawn through a curation is, bin for bin, the map its export makes —
and is tested against that map (SPECS §33.4).

- **Contigs move whole and forward**, so every bin is a stored bin and every count the integer the
  file stored: the lens is a permutation of contigs, the special case of a reference edit's lens
  (§27.7) in which every piece is a whole original sequence. A contig keeps its name everywhere.
- **The genome layer is replaced**: `n_contigs`, `n_bins` and `length` are counted; the file's other
  columns are kept for a genome **as in the file** and left empty for a **changed** one, since a
  completeness or a taxonomy measured on other contigs would be a claim about a genome that no longer
  exists; where the map holds the contigs' markers, Completeness, Redundancy, Weighted completeness and
  Weighted redundancy are **recomputed** for every genome — equal to the file's for a genome as in the
  file (§6) — and a `kind` column says MAG or element.
- **Every view and task reads through it** without knowing: the genomes table, the genome view, the
  genome-pair view, the genome × genome overview, the Binning QC card, the contigs table, every task.
  A link or a bookmark naming a genome the curation renamed or merged is carried to where it went, and
  one naming a genome that no longer exists falls back to the genomes table, as a place an edit set
  aside does (§27.7).
- **The heading says so**: the word on the genomes reads `genomes · curated · 7 steps`, lit; a press
  opens the stage; the arrow beside it puts the file's binning back, every step undone and kept to be
  redone.

---

## 5. The method

### 5.1 What it reads

One pass over the stored pixels, in the reader's worker, keeps the **contig network**: for every
two contigs in contact, the sum of the raw counts of the pixels between their bins — a pixel within
one contig left out — and for every contig its contacts within itself. Raw counts, so nothing depends
on a balancing the file may or may not carry. For MM133 it is 263,961 pairs of contigs in a few
megabytes; the pass is §7.3's cost class, priced and gated as that is.

From the network: each contig's **visibility** `t_c`, its contacts with every other contig; for a set
of contigs `X` and a genome `g`, `O_Xg` the contacts between them, `O_gg` the contacts within `g`
(between two of its contigs, counted once), `t_X` and `t_g` the sums of visibility, and `T` the sum of
every contig's.

### 5.2 Affinity

`A(X, g) = O_Xg · t_g / (2 · t_X · O_gg)`, with `g` taken without `X` where `X` is in it.

It is the observed over expected of `X` with `g` — random ligation expects `t_X · t_g / T` — divided by
the same ratio for `g` with itself, `2 · O_gg · T / t_g²`, so the library's depth, the genome's
abundance and the contig's own visibility all cancel: **1 is as densely as `g`'s own contigs meet
each other**. A contig that belongs to `g` scores about 1; one that does not, the spurious
ligation's level, a few hundredths. Between two genomes it is symmetric as the geometric mean of the
two directions, `O_ab / (2 √(O_aa · O_bb))`: about 1 for two halves of one genome.

Two guards make it safe on a few contacts:

- **The lower bound.** `A_lo` is `A` scaled by the one-sided 90% Poisson lower bound of the contacts
  it rests on, `χ²(0.1; 2o) / 2o`: one read pair between a contig and a three-contig genome is an
  affinity of five, and a lower bound of half a unit.
- **The background.** The rate of spurious ligation `ρ` is measured once per file from its own
  binning: the median observed over expected of every two MAGs whose expectation is a contact or more
  (0.0237 on MM133). A suggestion must stand out of it: `P(Poisson(ρ · t_X · t_g / T) ≥ o) ≤ 10⁻³`.

### 5.3 The suggestions

Each kind is a logistic over a few features, the weights round numbers stated in the code beside their
reason, and **the confidence is what is shown**: offered at 15%, at the top of the queue from 50%,
taken by auto mode from 80% (a step that moves contigs between organisms asks more than a cut does).

| Kind | What it proposes | Confidence = σ(…) |
|---|---|---|
| **merge** | two MAGs made one | `2·log₂(A/0.1) + 0.5·(log₁₀(1+o) − 2) − 6·overlap·min(1, m/10)` |
| **recruit** | an unbinned contig into a MAG | `2·clip(log₂(A_lo/0.5), −4, 2) + clip(log₂(A_lo/A₂), 0, 3) − 3·min(d, 2) − 3·[p > 10⁻³]` |
| **move** | a binned contig to another MAG | as a recruit, `A₂` its affinity with its own genome, less 2 (the binning put it there) |
| **link** | an element hosted by a MAG | `2·clip(log₂(A_lo/0.2), −4, 2) + 2·clip(log₂(s/0.1), −3, 2) − 3·[p > 10⁻³]` |
| **unlink** | a link the binning no longer supports | the link's own confidence under 15% |

`o` the contacts the step rests on; `A₂` the contig's next best affinity; `overlap` the share of the
smaller genome's present markers that the other has too, and `m` how many it has, so a fragment with
one marker neither helps nor harms; `d` the contig's markers the genome already has; `s` the share of
the element's contacts with MAGs that go to this one.

**Marker genes are the second witness.** Two fragments of one organism are complementary — *B.
cepacia*'s two halves, 67% and 34% complete, are 100% merged at the same redundancy — while two
organisms are not: *L. biflexa* and *M. tuberculosis*, whose contigs meet 33,016 times, share every
marker the smaller has, and merged would be twice redundant. So a merge that would duplicate markers is
turned down by the markers whatever the contacts say, and a recruit carrying a marker the genome has is
held back.

**Every suggestion is counted again after every step**, on the curated binning as it then is, so a
merge changes the affinities of the merged genome with every other and the queue follows.

### 5.4 Quality: miComplete, recomputed

`metator markers` stores, for every contig, the marker genes miComplete would find in it: genes
called by Prodigal trained on the contig's genome (metagenome mode under 20 kb and for unbinned
contigs) and searched with miComplete's Bact105 and Arch131 HMMs and its thresholds, as metaTOR
validates its bins; and in the map's metadata, both marker sets with their weights. For any set of
contigs the four numbers are miComplete's: the markers present over the markers of the set; every
accepted hit over the markers present; the weights of the markers present; and the weights of the
markers present twice or more, plus that, over that. Of the two sets, the one with the higher weighted
completeness, as metaTOR chooses. Recomputed this way, the 50 MAGs of MM133 give miComplete's own
numbers (§7).

---

## 6. What comes out

From the stage's export card, each a new file through the save dialog (§26.6), named after the map:

| File | What it holds |
|---|---|
| `<map>.contig-genome.tsv` | `contig_name	genome_name`, a header and every contig of the file — an unbinned one as `__unbinned__` — so `metacooler reassign --contigs` makes the curated binning the map's, elements included |
| `<map>.elements.tsv` | one row per element: its name, its contigs, its length and its hosts |
| `<map>.element-hosts.tsv` | one row per element and MAG in contact: the affinity, the contacts, the share, the confidence, and whether a link holds between them — from the file, taken, added by the hand or turned down — and who decided it |

---

## 7. Validation

The mock community MM133 has a truth: the reference genomes of most of its members. Every contig of
its assembly was aligned to them (minimap2's `asm10`), and a contig is an organism's where at least
half of it aligns and nine tenths of what aligns is that organism's; its replicon says whether it is
a chromosome, a plasmid or a phage. 14,340 contigs resolve; about 13 Mb of genomes — six whole MAGs —
match nothing in the reference and are counted neither way.

What metaTOR made of it, against the truth: MAGs nearly pure — 110 kb of contigs in another organism's
MAG — but fragmented: *K. pneumoniae* in six MAGs, *Y. pseudotuberculosis* and *B. cereus* in three,
*B. cepacia* and *K. oxytoca* in two; 868 kb of *Y. pseudotuberculosis* unbinned; 127 mobile elements,
each pure, but one *Y. pseudotuberculosis* plasmid in 26 of them; hosts right for 2.0 of 2.2 Mb of
elements.

What the method makes of it:

- **Merges**: at 50% and more, 13 offered and 13 right; at 15%, 16 offered and 15 right — the one wrong
  a *K. oxytoca* MAG with a *K. pneumoniae* fragment holding one marker, at 32%.
- **Recruits** of unbinned contigs: at 50%, 314 contigs and 1.58 Mb, 96.6% right of those the truth
  knows; at 80%, 98.6%; at 95%, 100%.
- **Host links**: at 50%, precision 0.969 and recall 0.888 over every element and MAG in contact whose
  truth is known; metaTOR's own rule, 0.945 and 0.804. The links it gets wrong are those the assembly
  makes ambiguous: contigs of the *Yersinia* virulence plasmids, nearly identical in both species, and an
  IncF backbone shared by *E. coli* and *K. pneumoniae*.
- **Quality**: miComplete's four numbers from the stored markers, against metaTOR's own run of
  miComplete on each of the 50 MAGs: equal for every MAG.

Held in tests: a fixed small curation of the demo map recovered exactly, and the numbers above
asserted on the demo map with its truth table.

---

## 8. The stage

*(Written with the stage's design; see SPECS §33.3.)*

---

## 9. Dev features

`curate` joins the registry (§29.3): the stage, its keys, the heading's word on the genomes, the
palette's *Curate the genomes*, the curation kept with a file, and every surface of the lens. Switched
off, none of it is drawn and a kept curation is left in storage as it was. It is on only with
`metacool`, which it cannot be without.

---

## 10. Build order

1. `metator markers` (metaTOR): the per-contig markers and their metadata, exact to miComplete.
2. The demo replaced by MM133 with its markers, and every test and gallery naming its genomes.
3. The model, its store and its persistence; the reader's `/clusters` and marker columns; the network
   pass; the method and the quality, held to the truth and to miComplete.
4. The stage: the genomes list, the three pictures, the inspector, the modes, the exports.
5. The lens: the session through the curated binning, and the heading's word.
6. SPECS §33, the documentation site's page, the gallery.

---

## 11. Risks, and what is still open

- **A merge of two strains.** Contacts and markers both say *one organism* for two strains of a
  species; the stage merges what the reader takes. Strain resolution is not this stage's.
- **An element with no contacts.** 46 of MM133's 127 elements touch no MAG: the host map collects them
  apart, and the method says nothing of them rather than guess.
- **The background on a map with no binning.** `ρ` is measured from the file's MAGs; a map with none
  takes the median over pairs of contigs instead, and says so.
- **Scale.** The network holds a pair per two contigs in contact: 0.26 million on MM133, and on a
  metagenome of two million contigs perhaps a hundred times that — the pass is gated as the overview's
  is, and what does not fit is refused with its size.
