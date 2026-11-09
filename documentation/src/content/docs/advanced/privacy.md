---
title: "Privacy"
description: "What chromosomix reads and sends, to whom and when, what your browser keeps between visits, and how to clear it."
---

chromosomix has no server: no account, no upload, no database. Your browser talks only to the site that serves the app and the hosts you point it at.

## Your files stay on your machine

Files you drop, pick or open from a connected folder are read in place and never uploaded, so unpublished or patient-derived data can be opened offline. chromosomix never changes a file: what it writes is a new file that you save. A link cannot carry a local file; whoever opens it is asked for the file.

## What is fetched, and from where

| What | From | When |
| --- | --- | --- |
| The app itself | chromosomix.app, or your lab's [own copy](/advanced/self-hosting/) | when you load the page; for offline use the site keeps the app, never your data |
| A remote file | its own host, directly, by range | when you open it |
| A data store | the built-in ones from the site, Roadmap from WashU, any other from its own host | when you open it, or a link that names it; never on load |
| The example sessions and the tutorial | the public buckets their files are on | when you press one |
| Google's sign-in | Google | when you press **sign in to Google** |
| A short link | is.gd | only when you press **shorten with is.gd** |

Each request tells its host which file was asked for, and from where. Nothing goes anywhere else. **There is no telemetry**; only the website's 0.17 and 0.18 sent anonymous counts, which **About** could turn off.

## Signing in

You sign in only to read your own private files. A sign-in's token stays in this tab's memory, never in storage, and the page is not told whose account it is. **sign out**, or closing the tab, ends it.

- **sign in to Google** asks to read *all* of your Drive (`drive.readonly`) and the Cloud Storage your account can see (`devstorage.read_only`). The token expires about an hour after you sign in. Google's sign-in code loads only when you press the button.
- **sign in to Dropbox** lets the site's Dropbox app read your whole Dropbox, or its own folder in it (`files.metadata.read`, `files.content.read`). Dropbox's longer-lived token is refused, and files are read through links that last four hours.
- **connect a bucket…** keeps a private bucket's key in this browser, in plain text, where any script on the viewer's site could read it. Use a key that can only read the prefix you need ([A private bucket](/advanced/hosting/#a-private-bucket)).

## Links you share

- **Share this tab as a link** writes the tab after the address's `#`, which a browser never sends to a server. It holds addresses and settings, never data.
- **shorten with is.gd** sends that link, file addresses included, to is.gd, a third party. It is not offered for a tab over a local file.
- A presigned address, or a Dropbox file's temporary link, lets anyone it reaches read the file until it expires. To share for good, use a public address or Dropbox's own share link.

## What this browser remembers

**What this browser is remembering**, under Help in the command palette (<kbd>Ctrl</kbd>+<kbd>P</kbd>, or <kbd>⌘</kbd>+<kbd>P</kbd> on a Mac), lists everything chromosomix keeps on this computer, never a copy of your data:

| On the screen | What it is |
| --- | --- |
| Remembered workspace | the tabs you had open, offered back with **restore** when you next open the app afresh, never reopened unasked |
| Console | the commands, files and exports of the last week, 500 lines at most |
| Files you allowed | local files this browser may read again without your picking them (Chrome, Edge and the desktop app) |
| Folders you connected | folders the installed app may read until you disconnect them |
| Where your files are | each file's path inside the folder it came from |
| This window | the open tabs, filters, marks and bookmarks, until the window closes |
| Stores you connected | a name and an address each |
| Drive folders you connected | a name and a folder id each, no token |
| Preferences | the theme, column widths, overlays |
| Buckets you connected | public bucket addresses, with no key |
| Bucket keys | access keys for private buckets, in plain text |

Nothing of a sign-in is kept. Only an installed app (the desktop app, the single HTML file, the site installed as an app) keeps a connected folder; in a browser tab it lasts for the visit, and its button says *this visit*.

## Clearing it

**forget everything**, at the foot of that screen, clears all of it; what is open stays open until you close it. Or one at a time: a folder or bucket by its × in the Files panel, a store by **forget this store**, the remembered workspace by the × on its **restore** offer, the console by its **clear**. Clearing the site's data in your browser removes the same things.

## The desktop app, the single file and embeds

- **The desktop app** reads files as the website does, refuses every permission but reading the files and folders you choose, opens links in your own browser and never checks for updates. It has no Google sign-in; Dropbox's opens in your browser, and you paste its code into the app. It reads built-in stores from chromosomix.app when you open one.
- **The single HTML file** makes no network request at all, so it opens local files only. Pages opened from your disk share one storage, so two copies of it share what they remember.
- **An embedded view** writes no tabs, no remembered workspace and no console.
- **The notebook widgets** serve the kernel's files from that machine, and upload nothing ([Jupyter notebooks](/embed/jupyter/)).
