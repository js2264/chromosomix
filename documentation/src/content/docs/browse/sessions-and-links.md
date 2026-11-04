---
title: "Sessions, workspaces and links"
description: "What a tab holds, what this browser remembers and how to make it forget, how to save every tab as a workspace file and open it again, and what a link to a view can and cannot carry."
---

Each file you open in chromosomix is a tab. This page covers what a tab holds, what your browser
keeps of your work and for how long, how to save every tab to a file and open it again, and how a
view becomes a link you can send.

## Tabs

A tab holds one file, or one genome in the 1D browser, with its views, tracks, marks, bookmarks and
settings. A window holds up to twelve tabs.

- **Open a new tab** with the **+** at the end of the tab strip, or <kbd>O</kbd>.
- **Move between tabs** with <kbd>Ctrl</kbd>+<kbd>&gt;</kbd> and <kbd>Ctrl</kbd>+<kbd>&lt;</kbd>.
  This is Control on a Mac too, not ⌘, and it works while you are typing in a box.
- **Rename a tab** by double-clicking it or pressing <kbd>F2</kbd>. Enter keeps the name, Escape
  abandons it, an empty box gives the tab back its file's name, and Tab goes on to the next tab's
  name. The name is kept in a saved workspace and travels with a shared link.
- **Close a tab** with its ×, or a middle-click. The last tab is emptied rather than closed. No key
  closes a tab: <kbd>Ctrl</kbd>+<kbd>W</kbd> (<kbd>⌘</kbd><kbd>W</kbd>) belongs to your browser,
  and would close more than you meant.

Switching tabs keeps each one as you left it: the map comes back with its zoom and its pixels, and
nothing is read again. Two tabs on the same file share nothing, so a second tab starts with no
tracks, filters or marks of its own.

A few things belong to the window rather than to a tab: the theme, the fold and width of each
column, and where you have moved cards. The bar under the tab strip carries notes about the tab's
file, such as a sequence that reads as circular. A note belongs to its tab and goes when that tab
opens another file.

## What this browser remembers

chromosomix has no server, so everything it remembers is kept in your own browser, on this
computer. It keeps which files were open and how you had them set up, never a copy of the data.

| What | How long |
| --- | --- |
| The tabs of this window, and each tab's tracks, marks, bookmarks, filters and settings | Until you close the browser tab or window. A reload keeps them |
| Every tab's whole setup, as a remembered workspace | Kept up to date as you work, and outlives closing the browser. The × on its offer deletes it |
| Preferences: the theme, the columns' folds and widths, where cards are, the overlays, the figure caption switch | Until you forget everything |
| The [console](/browse/console/)'s record | Seven days, or 500 lines |
| Permission to read files you opened from your disk, where the browser offers it | Until you forget everything |
| Folders, stores and buckets you connected, and bucket keys | Until you disconnect them, or forget everything |

### After a reload

The tab in front opens again from the address bar. The other tabs come back named, and each reads
its file only when you click it. A tab over a file from your disk comes back to the drop area with
an explanation, because a browser does not re-read a file from your disk without a new gesture from
you. Drop the same file and the tab opens on the view it was showing.

Chromium-based browsers can keep permission to read the file again, and then the drop area offers a
button instead: **allow access to** and the file's name, or **allow access to all 5 files**, with the
number of files this browser remembers. One press asks for all of them at once, the map's tracks
and other tabs' files included. Firefox and Safari keep no such permission, so there you drop the
file again.

### After closing the browser

When you come back, the window offers your tabs back, but never reopens them on its own:

> You had 2 tabs open yesterday: yeast.mcool and ATAC.bw, with 3 tracks.

Press **restore** to reopen them, with their tracks, marks and filters. The × beside it deletes the
remembered workspace rather than just hiding the note.

### Making it forget

Open the command palette (<kbd>Ctrl</kbd>+<kbd>P</kbd>, <kbd>⌘</kbd><kbd>P</kbd> on a Mac) and run
**What this browser is remembering**, under Help. It lists everything kept: the remembered
workspace, the console, the files you allowed, the folders, stores and buckets you connected, this
window's tabs, your preferences, and whether any bucket keys are stored. Files and folders are named,
so you can see them before you decide.

**forget everything** clears every remembered workspace, preference and saved bucket key from this
browser. It does not close the tabs you have open. See also [Privacy](/advanced/privacy/).

A chromosomix view embedded in another page remembers nothing.

## Workspaces: every tab in one file

A workspace is every open tab in one file, `workspace-<date>-<time>.chromosomix.json`. It holds each
tab's view, and everything a link to the view leaves out: the tracks with their colours, heights and
groups, your marks and bookmarks, the maps side by side, the analyses you ran with their parameters
and the settings of their figures, the sequences you ticked, table filters, the sequences you
declared circular, and the resolutions you added.

**To save one**, press the save button in the header (**Save every tab as a file, to open again
later**) or <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd><kbd>S</kbd>).

**To open one**, do any of these:

- drop it on the window. Its tabs are added beside the ones already open, and never replace them.
  An empty tab is used rather than left beside them;
- open `https://chromosomix.app/?config=` followed by the address of a published workspace;
- choose it in a data store that lists it (see [Data stores](/files/stores/)).

A window holds twelve tabs at most. Tabs that do not fit are counted in a note rather than dropped
without a word.

A file named inside a workspace by a relative name is looked for beside the workspace itself, so a
workspace published in the same folder as its data opens wherever the folder is copied. A file that
was on your disk is named but cannot travel: the tab asks for it, and its tracks wait to be pointed
at the file again.

A workspace's analyses can run again from the command line, over other files, with the parameters
they were recorded with:

```sh
chromosomix replay workspace.chromosomix.json --over data/*.hic --out results/
```

`--tab <n>` chooses which tab to replay; the default is the tab that was in front when you saved.
See [From the app to a script](/cli/from-the-app/), and
[files and workspaces](/reference/files-and-stores/) for the file's format.

## Links

### Every view is a link

The address bar always holds the view of the tab in front, written after the `#`: the file, which
view, the region, how the map is drawn (the transform, colour map and clip, the score, observed over
expected, smoothing), a second file in the same square, and the maps side by side. Copy it from the
address bar and send it. For example, a window of yeast chromosome IV on a log scale:

```text
https://chromosomix.app/#uri=https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/yeast/Yeast_microC_G2M_1kb.cool&view=region&region=IV:1000000-1400000&transform=log10&balance=true
```

Every key it can hold is on the [links reference](/reference/links/).

A link records the region and how it is drawn, not each pan and zoom inside it, so it opens on the
region it names. The 1D browser is the exception: there the window is what you are looking at, so
the link carries it. The header's back and forward buttons walk the places you went to, such as a
crumb, a typed locus, a zoom step or the next sequence, but not each turn of the wheel. See
[Moving around](/browse/navigating/).

A link to a view carries no tracks, marks or bookmarks: those belong to the tab.

### Sharing a whole tab

The link button in the header, **Share this tab as a link** (also in the command palette), opens
**Share this tab**: a link that carries everything in the tab, which means the view, the tracks and
their colours, the marks and the bookmarks. It is copied to the clipboard as the dialog opens, and
the line under it says so. Its copy button copies it again.

The whole tab is packed into the link itself, after `#session=`. No server holds it, so it cannot
expire, and nothing about it reaches the site serving the page: a browser never sends the part of an
address after the `#`.

- Such a link is long. Past about 2,000 characters the dialog says how long it is, since some chat
  and mail programs cut lines there. Past 8,000 it suggests saving a workspace and sending the file
  instead.
- **shorten with is.gd** asks the is.gd service for a short link. This sends the link, including the
  file's address, to is.gd, and the short link then depends on that service. It is not offered for a
  tab over a file from your disk. The long link still works.
- A shared link holds one tab. To hand over the whole window, save a workspace.

### What a link cannot carry

A link names files by their addresses, and the person who opens it reads them from there, in their
own browser. So every file must be one they can reach: a public address, or one their own browser
has access to. A file on your disk cannot travel in a link.

- A map from your disk in the deck is written as `~`, and arrives as an empty cell to drop a file on.
  The other maps keep their places.
- A shared link over a file from your disk still brings its tracks, marks and bookmarks, and the
  person who opens it is asked for the file.

### A link that never changes

`https://chromosomix.app/` is always the newest build, and it changes with every release. Every
release is also kept for good at its own address, `https://chromosomix.app/v/<tag>/` (for example
`https://chromosomix.app/v/v0.13.0/`), which takes the same links. A link in a paper, a figure
legend or a notebook that must draw the same picture in five years should name a release.

On the website, **About this viewer** has **Run build**, which switches to another published build.
The view in the address bar and the open tabs come with you; a file from your own disk has to be
dropped again, as after any reload. A release also gives its permanent address there. A pinned build
says so in a bar at the corner of the window, with a **newest build** button to go back.

To show a view inside another web page, see [Embedding in a web page](/embed/web-page/).
