---
title: "Sessions, workspaces and links"
description: "What a tab holds, what this browser remembers and how to make it forget, how to save every tab as a workspace file, and what a link can carry."
---

## Tabs

Each file you open, or each genome in the 1D browser, is a tab with its own views, tracks, marks,
bookmarks and settings. A window holds up to twelve tabs.

- **Open a new tab** with the **+** at the end of the tab strip, or <kbd>O</kbd>.
- **Move between tabs** with <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> and <kbd>Ctrl</kbd>+<kbd>&lt;</kbd>
  (Control on a Mac too), even while typing in a box.
- **Rename a tab** by double-clicking it or with <kbd>F2</kbd>: Enter keeps the name, Escape abandons
  it, an empty box gives back the file's name, and Tab moves on to the next tab. The name travels with
  a workspace and a shared link.
- **Close a tab** with its × or a middle-click; the last tab is emptied instead. No key closes a tab:
  <kbd>Ctrl</kbd>+<kbd>W</kbd> (<kbd>⌘</kbd><kbd>W</kbd>) belongs to your browser.

Two tabs on the same file share nothing.

## What this browser remembers

Everything is kept in your own browser, on this computer: which files were open and how you set them
up, never a copy of the data.

| What | How long |
| --- | --- |
| This window's tabs and all they hold | Until you close the browser tab or window; a reload keeps them |
| Every tab's setup, as a remembered workspace | Past closing the browser, until the × on its offer deletes it |
| Preferences: the theme, the columns' folds and widths, where cards are, the overlays, the figure caption switch | Until you forget everything |
| The [console](/browse/console/)'s record | Seven days, or 500 lines |
| Permission to read files from your disk, where the browser offers it | Until you forget everything |
| Folders, stores and buckets you connected, and bucket keys | Until you disconnect them, or forget everything |

After a reload, the front tab opens again; the others come back named and read their file when you
click them. A tab over a file from your disk asks for it: drop the same file and the tab opens on its
view. Chromium-based browsers can keep permission instead, and offer **allow access to** the file, or
**allow access to all 5 files**: one press for every file this browser remembers, the map's tracks and
other tabs' files included. Firefox and Safari cannot.

After you close the browser, the window offers your tabs back, but never reopens them on its own:
**restore** reopens them, and the × beside it deletes the remembered workspace.

### Making it forget

Run **What this browser is remembering**, under Help in the command palette
(<kbd>Ctrl</kbd>+<kbd>P</kbd>, <kbd>⌘</kbd><kbd>P</kbd>), to see by name everything kept.
**forget everything** there clears every remembered workspace, preference and saved bucket key, but
closes no tab ([Privacy](/advanced/privacy/)). A chromosomix view embedded in another page remembers
nothing.

## Workspaces: every tab in one file

A workspace, `workspace-<date>-<time>.chromosomix.json`, saves every open tab with all a link leaves
out: tracks, marks, bookmarks, the deck, the analyses you ran with their parameters and figure
settings, ticked and circular sequences, filters and added resolutions.

- **To save one**, press the save button in the header (**Save every tab as a file, to open again
  later**) or <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd><kbd>S</kbd>).
- **To open one**, drop it on the window, where its tabs join the open ones; open
  `https://chromosomix.app/?config=` followed by its address; or choose it in a
  [data store](/files/stores/) that lists it.

Tabs past the twelfth are counted in a note. A file named by a relative name is looked for beside the
workspace, so a workspace beside its data opens wherever the folder is copied. A file from your disk
cannot travel: its tab asks for it.

A workspace's analyses run again from the command line, over other files, with the same parameters;
`--tab <n>` picks the tab, by default the one in front when you saved:

```sh
chromosomix replay workspace.chromosomix.json --over data/*.hic --out results/
```

See [From the app to a script](/cli/from-the-app/), and
[files and workspaces](/reference/files-and-stores/) for the format.

## Links

### Every view is a link

The address bar always holds the front tab's view, after the `#`: the file, the view, the region, how
the map is drawn, a second file in the same square and the maps side by side. Copy it and send it. For
example, yeast chromosome IV on a log scale:

```text
https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true
```

Every key is on the [links reference](/reference/links/). A link opens on the region it names, not on
each pan and zoom inside it (in the 1D browser it carries the window), and carries no tracks, marks or
bookmarks.

### Sharing a whole tab

**Share this tab as a link**, the link button in the header, opens **Share this tab** with a link to
everything in the tab, tracks, marks and bookmarks included, already copied; its copy button copies
it again. The tab is packed into the link after `#session=`, so no server holds it, it cannot expire,
and the site serving the page never sees it.

- Past about 2,000 characters, where some chat and mail programs cut lines, the dialog gives the
  link's length; past 8,000 it suggests a workspace instead.
- **shorten with is.gd** sends the link, the file's address included, to is.gd; the short link depends
  on that service, and the long one still works. It is not offered for a file from your disk.
- A link holds one tab. For the whole window, save a workspace.

### What a link cannot carry

Whoever opens a link reads its files from their addresses, in their own browser, so each must be one
they can reach. A map from your disk in the deck arrives as an empty cell (`~` in the link); a shared
tab over one brings its tracks, marks and bookmarks and asks for the file.

### A link that never changes

`https://chromosomix.app/` is always the newest build. Each release also stays at
`https://chromosomix.app/v/<tag>/`, such as `https://chromosomix.app/v/v0.13.0/`, and takes the same
links: name a release in a paper or a figure legend that must draw the same picture in five years.

On the website, **Run build** in **About this viewer** switches to another published build, keeping
the view and the open tabs (drop files from your disk again), and gives a release's permanent address.
A pinned build says so in a bar at the corner of the window, with a **newest build** button.

To show a view inside another web page, see [Embedding in a web page](/embed/web-page/).
