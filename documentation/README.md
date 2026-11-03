# chromosomix documentation

The source of **<https://doc.chromosomix.app>**, the documentation for people who use chromosomix:
the browser, the files it opens, its analyses, the command line, the notebook widgets, and hosting
data of your own. It is an [Astro](https://astro.build) site built with
[Starlight](https://starlight.astro.build) and the
[Rapide](https://github.com/HiDeoo/starlight-theme-rapide) theme, dressed in the app's own look.
SPECS §32 is its contract.

## Building it

From the repository's root, once:

```sh
npm ci                       # the app's dependencies: the site reads the app's source
npm ci --prefix documentation
```

Then:

```sh
npm run docs:dev             # http://localhost:4321, rebuilt as you edit a page
npm run docs:build           # documentation/dist, every internal link checked
```

Both run `scripts/docs-data.mjs` first, which writes what the site reads from the app (below).

## What is written by hand, and what is not

| Where | What | Written by |
| --- | --- | --- |
| `src/content/docs/**` | the guides, and each task's explanation | hand |
| `src/content/docs/analyses/<task>.mdx` | one page per task: the prose is by hand; the summary, the command, the parameters and the outputs are components that read the registry | hand + generated |
| `src/content/docs/reference/` | links, command line, embedding, files and stores | generated from `src/llms/` |
| `src/content/docs/releases/` | one page per release | generated from `CHANGELOG.md` |
| `src/generated/` | the tasks' data, the app's colour tokens, the mark | generated |
| `src/lib/sidebar.mjs` | the table of contents | hand |

Nothing generated is committed. A task added to the registry needs a page under `analyses/` before
the site builds again, and a page for a task that no longer exists stops the build too.

## Versions

Every release has its own copy of the site, built from its tag, at `doc.chromosomix.app/v<version>/`;
the latest release is also at the root, and `main` is at `/dev/`. The header's menu lists them all
from the site's `versions.json`. `.github/workflows/docs.yml` builds and publishes them into the
`gh-pages` branch of [js2264/chromosomix-docs](https://github.com/js2264/chromosomix-docs), which
GitHub Pages serves. Pages are written as if the site were at the root; the build puts every
root-relative link under the copy's path.

## Writing a page

**Who reads it.** People who use chromosomix: biologists and bioinformaticians with a map to look at
or an analysis to run. Not people who work on its code: that is SPECS.md, GLOSSARY.md and the
docblocks. Say what a reader does and what they see, not how the code does it — unless it changes
what they can do (nothing is uploaded; a remote file is read by range; the map stays live while a
task runs).

**What is true.** Every sentence must be something the app does in this version. The sources are
SPECS.md (the contract: a section marked *built* is what the app does), the README, `docs/*.md`, and
the code for the exact words on screen (`src/ui/`). Name a control as the app labels it, in **bold**:
**Load files**, **Analysis**, **Run**. If a detail cannot be checked — a shortcut, a default, a limit
— leave it out rather than guess. **Dev features are not documented at all**, not even by name
(SPECS §29): the multi-genome format (`.metacool`, `.mmetacool`) with its genomes table, genome views
and metagenome tasks; editing the reference (§27); the dot plot (§28); the DNA Bacterial Zoo store;
and the switch itself.

**How it reads.** Second person, present tense, plain words, short paragraphs. British spelling, as
the app writes: *colour*, *normalise*, *centre*. Headings in sentence case, starting at `##` (the
title is the page's `#`). Lead with what the reader wants to do; put the why after the how.

**The parts.**

- Front matter: a `title` in sentence case, and a `description` of one plain sentence (it is the
  search result's line and the link preview's).
- Links to other pages are root-relative, with the trailing slash: `[Opening files](/files/opening/)`.
  Never `../`: the build refuses relative links. Every link is checked when the site is built.
- Links to the app are absolute (`https://chromosomix.app/`), and so are links to the repository's
  files (`https://github.com/js2264/chromosomix/blob/main/README.md`).
- Asides: `:::note`, `:::tip`, `:::caution` and `:::danger`, each with an optional `[title]`.
- Code blocks name their language: `sh`, `json`, `python`, `r`, `html`.
- Keys as `<kbd>`: <kbd>Shift</kbd>.
- `.md` for a page of prose; `.mdx` only for a page that uses a component. In MDX, `{`, `}` and `<`
  in prose are code: write them in backticks.
- No pictures yet. Where one would help, leave a comment saying what it should show —
  `<!-- screenshot: the Analysis panel with insulation run on chr15 -->`, or `{/* … */}` in MDX —
  and the screenshot step fills it from the real app.

**A task's page** keeps its components and its four headings — *Running it*, *Parameters*, *What it
writes*, *Reading the result* — and its prose says what the task answers and when to reach for it,
where it is and what it needs, what appears when it has run, and how to read the result: what a
value means, what a good one looks like, and what to watch for.
