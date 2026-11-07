---
title: "Web, desktop or one file"
description: "chromosomix runs as a web app, a desktop app for macOS and Linux, or one HTML file: how to get each, what differs between them, and how to keep to one release."
---

The web app, the desktop app and the single HTML file open the same files, draw the same pictures and
run the same analyses, and none uploads your data. Start with **the web app**; **the desktop app**
(macOS and Linux) is for a machine that cannot reach the website, or for an icon rather than a
bookmark, and **one HTML file** for a machine with no network at all.
[Ways to use chromosomix](/start/ways/) lists the others.

## At a glance

| | Web app | Desktop app | One HTML file |
| --- | --- | --- | --- |
| Get it | open <https://chromosomix.app/> | an installer from the [releases page](https://github.com/js2264/chromosomix/releases) | `chromosomix-<tag>.html` from the releases page |
| Install | none, or install it as an app | yes | none |
| Version | the newest build, or any release at its own address | the release you downloaded | the release you downloaded |
| Updates | offered as a reload | a new download | a new download |
| Works offline | after one visit | yes | yes, and never uses the network |
| Remote files, data stores, example sessions, the tutorial | yes | yes | no |
| Signing in to Google Drive | yes | no | no |
| Signing in to Dropbox, connecting a bucket | yes | yes | no |
| A connected folder on your disk, kept across restarts | when installed as an app, in Chrome and Edge | yes | yes, in Chrome and Edge |

## The web app

Open <https://chromosomix.app/> in a recent Chrome, Edge, Firefox or Safari; there is no account. It
serves the newest build, which can be ahead of the latest release: *About this viewer* names it, and
[pinned releases](#pinned-releases) keep a version still.

After one visit it works offline, through a reload too; only remote files, the data stores and the
example sessions need a connection. A new version waits in a bar, *A new version of the viewer is
ready*, until you press **reload**. If the copy your browser kept cannot start, the new version
replaces it without asking and reloads the page.

### Install it as an app

- **Chrome** or **Edge**: the install button at the right-hand end of the address bar.
- **Safari**: **Share → Add to Dock**.
- **Firefox** does not offer to install it; use it in a tab.

Installed, it opens in a window of its own, from the dock or the start menu. In Chrome and Edge it
also keeps a folder you connect on your disk across restarts (in a tab, and in Safari, the folder
lasts the visit and its row in the Files column says *this visit*), and reads restored tabs' files
again without asking; in a tab, the landing page asks once, with a button that allows access to
them. A bucket you connect is remembered either way.

## The desktop app

Download the installer for your system from the
[releases page](https://github.com/js2264/chromosomix/releases). Its files are named
`chromosomix-<version>-<os>-<arch>.<ext>`:

| System | File |
| --- | --- |
| macOS, Apple silicon | `…-mac-arm64.dmg`, or the `.zip` |
| macOS, Intel | `…-mac-x64.dmg` |
| Linux | `…-linux-x64.AppImage`: make it executable (`chmod +x`) and run it |
| Linux, Debian and Ubuntu | `…-linux-x64.deb` |

**There is no Windows installer for now**; on Windows, use the web app or the single HTML file.

### The unsigned-app warning

The installers are not code-signed, so the first time you open the app, macOS says it cannot be
opened because the developer cannot be verified. The warning is expected. To open the app:

- in **Applications**, right-click (or Control-click) **chromosomix**, choose **Open**, then **Open**
  again in the dialog. You do this once. If the dialog offers no **Open**, go to
  **System Settings → Privacy & Security** and press **Open Anyway**;
- or, in a terminal:

  ```sh
  xattr -d com.apple.quarantine /Applications/chromosomix.app
  ```

### What is different from the web app

Besides the table above:

- **No updates of its own**: no update bar, and no list of other builds in *About*.
- **Remote hosts see it as `app://viewer`.** A bucket whose CORS settings allow the website by name
  refuses the desktop app; allowing every origin (`*`) works for both
  ([Hosting your data](/advanced/hosting/)).
- **A host that compresses what it serves** is read by range, where the web app has to download such
  a file whole and refuses one over 128 MiB.
- **The files you opened are kept** across restarts, as in the installed web app.
- **A menu bar of its own**, with no reload and no page zoom.

## One HTML file

Every release attaches the whole viewer as one file, `chromosomix-<tag>.html` (about 14 MB), which
opens in your browser with a double-click: for an air-gapped workstation, a laptop holding
unpublished data, or a reviewer who will not install an unsigned app.

**It opens local files only**, as its drop area says: the browser refuses every network read from it.
So it has no URL box, and **Connect a folder** offers this machine alone; maps, tracks, 3D models,
analyses, figures and the console are all there. A BAM needs its index dropped with it.

:::caution
The single file is checked only in Chromium browsers, such as Chrome and Edge. Two copies of it share
their saved sessions and preferences: every page opened from your disk shares one browser storage.
:::

## Pinned releases

Every release is kept for good at its own address, `https://chromosomix.app/v/<tag>/`
(`https://chromosomix.app/v/v0.13.0/`, say), which takes the same links as the root: name one in a
paper or a notebook that must draw the same picture in five years ([Link keys](/reference/links/)).

Recent builds are kept too, by commit: **Run build**, in *About this viewer*, opens one in place of
yours, with your view and tabs. Files from your disk do not come along: open them again there.

A pinned build's corner bar, *You are running the build from commit …*, has **newest build** to go
back. Pinned builds cannot be installed and do not work offline. The desktop app and the single file
are pinned by nature; to pin the command line, see [Installing it](/cli/install/).
