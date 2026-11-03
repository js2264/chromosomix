---
title: "Privacy"
description: "What chromosomix reads and sends, to whom and when, what your browser keeps between visits, and how to clear it."
---

chromosomix has no server: no account, no upload, no database of ours. Everything it does happens in
your browser, and the only hosts it talks to are the ones that serve the app and the ones you point it
at.

## Your files stay on your machine

A file you drop on the window, pick, or open from a connected folder is read in place, a few kilobytes
at a time, by code running on your own computer. Nothing of it is uploaded, copied or indexed — the
landing page says so in one line, *Nothing you open here leaves this machine* — so unpublished or
patient-derived data can be opened with the network unplugged.

- chromosomix never changes a file it opened. Everything it writes — a figure, a BED of your marks, a
  track a task computed, a saved workspace — is a new file that you save.
- A link cannot carry a local file, since it names files by their address and a file on your disk has
  none. Whoever opens such a link gets your tracks, marks and view, and is asked for the file.

## What is fetched, and from where

| What | From | When |
| --- | --- | --- |
| The app itself | the site that serves it: chromosomix.app, or your lab's [own copy](/advanced/self-hosting/) | when you load the page; after one visit the site's copy works offline, and what is kept for that is the app, never your data |
| A remote file | its own host, directly, a byte range at a time | when you open it |
| A data store | the built-in ones from the site, Roadmap from WashU, any other from its own host | when you open the store, or follow a link that names it — never on load |
| The example sessions and the tutorial | the public buckets their files are on | when you press one |
| Google's sign-in | Google | when you press **sign in to Google** |
| A short link | is.gd | only when you press **shorten with is.gd** |

Like any web request, each of these tells its host which file was asked for, and from where. Nothing
is sent anywhere else on the way.

**There is no telemetry.** chromosomix counts nothing and reports nothing: no visit, no file, no task
and no error is sent anywhere on its behalf. Two earlier releases of the website, 0.17 and 0.18, sent
anonymous counts, with a switch in **About** to turn them off; 0.19.0 removed them altogether.

## Signing in

You only sign in to read your own private files, and each sign-in is between you and that provider.

- **Google** (**sign in to Google**) asks for two grants: `drive.readonly`, read access to *all* of
  your Drive, and `devstorage.read_only`, read access to the Cloud Storage your account can see. The
  token lives in this tab's memory only — never written to storage, gone when the tab closes, and
  expiring about an hour after you sign in. No address is asked for, so the page does not know which
  account it is. Google's sign-in code is loaded when you press the button, never before.
- **Dropbox** (**sign in to Dropbox**) gives the site's Dropbox app `files.metadata.read` and
  `files.content.read`: read access to everything in your Dropbox, or to the app's own folder in it if
  the site registered it that way. The token lives in this tab's memory only and expires on its own;
  the longer-lived token Dropbox also offers is refused. The page is not told whose Dropbox it is. A
  file you open from it is read through a temporary link that lasts four hours.
- **A private bucket** is read with a key you enter under **connect a bucket…**, and that key is kept
  in this browser, in plain text, where any script running on the viewer's site could read it. Use a
  key that can only read the one prefix you need, never an administrator key: see
  [A private bucket](/advanced/hosting/#a-private-bucket).

**sign out** ends a Google or Dropbox sign-in at once; closing the tab does too.

## Links you share

- **Share this tab as a link** writes the tab — its view, tracks, marks and bookmarks — after the `#`
  in the address, the part a browser never sends to a server: whoever serves the page does not see
  it. The link holds addresses and settings, never data.
- **shorten with is.gd** sends that link, the file's address included, to is.gd, a third party. It is
  not offered for a tab over a local file.
- A presigned address, or the temporary link of a file opened from Dropbox, carries its own access:
  anyone the link reaches can read the file until it expires. For something that must last, share a
  public address, or Dropbox's own share link for the file.

## What this browser remembers

Open the command palette (<kbd>Ctrl</kbd>+<kbd>P</kbd>, or <kbd>⌘</kbd>+<kbd>P</kbd> on a Mac) and
choose **What this browser is remembering**, under Help. It lists, by name, everything chromosomix
keeps in this browser. All of it is on this computer, and none of it is ever a copy of your data:
what is kept is which files were open and how you had them set up.

| On the screen | What it is |
| --- | --- |
| Remembered workspace | the tabs you had open, offered back with **restore** when you next open the app afresh — never reopened unasked |
| Console | the commands, files and exports of the last week, 500 lines at most |
| Files you allowed | local files this browser may read again without your picking them (Chrome, Edge and the desktop app) |
| Folders you connected | folders the installed app may list and read until you disconnect them |
| Where your files are | each file's path inside the folder it was opened from |
| This window | the open tabs, filters, marks and bookmarks, gone when the window closes |
| Stores you connected | the stores you chose to remember: a name and an address each |
| Drive folders you connected | a name and a folder id each, and no token |
| Preferences | the theme, column widths, overlays |
| Buckets you connected | public bucket addresses, kept with no key |
| Bucket keys | access keys for private buckets, in plain text |

Nothing of a Google or Dropbox sign-in is on the list, because nothing of one is kept.

A folder on your computer is kept only by an app you installed: the desktop app, the single HTML file,
or the site installed as an app. In an ordinary browser tab a connected folder lasts for the visit —
its button says *this visit* — so a shared computer does not keep it for the next person.

## Clearing it

- **forget everything**, at the foot of that screen, clears all of it from this browser at once.
  What is open on screen stays open until you close it.
- One thing at a time: a connected folder or bucket by its × in the Files panel; a remembered store
  by **forget this store** on its page; the remembered workspace by the × on its **restore** offer,
  which deletes it rather than hiding the note; the console by its **clear**.
- Your browser's own setting to clear a site's data removes the same things.

## The desktop app, the single file and embeds

- **The desktop app** reads files exactly as the website does. It refuses every permission a page can
  ask for — camera, microphone, location, notifications — except reading the files and folders you
  choose; it opens links in your own browser; and it has no automatic updates, so it never asks a
  server whether it is current. Signing in to Google is not offered there; signing in to Dropbox
  opens Dropbox in your browser, and you paste the code it shows back into the app. The built-in
  stores are read from chromosomix.app when you open one.
- **The single HTML file** makes no network request at all — its own security policy forbids them —
  so it opens local files only. A browser gives every page opened straight from your disk one shared
  storage, so two copies of the single file share what they remember.
- **An embedded view** in somebody's web page writes no tabs, no remembered workspace and no console:
  it shows what its page asks for, every time it loads.
- **The notebook widgets** serve the files on the kernel's machine to the viewer from that machine
  itself, by range, and upload nothing: see [Jupyter notebooks](/embed/jupyter/).
