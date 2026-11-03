---
title: "Web, desktop or one file"
description: "chromosomix runs as a web app at chromosomix.app, as a desktop app for macOS and Linux, and as a single HTML file; this page says how to get each, what changes between them, and how to keep to one release."
---

chromosomix is one viewer built three ways. Each opens the same files, draws the same pictures and
runs the same analyses; what differs is where the app itself comes from, and so what it can reach.

- **The web app**, at <https://chromosomix.app/>: nothing to install, and the place to start.
- **The desktop app**, for macOS and Linux: for a machine that cannot reach the website, or for an
  icon rather than a bookmark.
- **One HTML file**: for a machine with no network at all.

Your data is read the same way by all three, on your own machine, and none of them uploads it.

## At a glance

| | Web app | Desktop app | One HTML file |
| --- | --- | --- | --- |
| Get it | open <https://chromosomix.app/> | an installer from the releases page | `chromosomix-<tag>.html` from the releases page |
| Install | none, or install it as an app | yes | none |
| Version | the newest build, or any release at its own address | the release you downloaded | the release you downloaded |
| Updates | offered as a reload | a new download | a new download |
| Works offline | after one visit | yes | yes, and never uses the network |
| Remote files, data stores, example sessions, the tutorial | yes | yes | no |
| Signing in to Google Drive | yes | no | no |
| Signing in to Dropbox, connecting a bucket | yes | yes | no |
| A connected folder on your disk, kept across restarts | when installed as an app, in Chrome and Edge | yes | yes, in Chrome and Edge |

The releases page is <https://github.com/js2264/chromosomix/releases>.

## The web app

Go to <https://chromosomix.app/> in a recent Chrome, Edge, Firefox or Safari. There is nothing to
install and no account to make. The address always serves the newest build, which can be ahead of the
latest numbered release; *About this viewer* says which build you are running, and
[pinned releases](#pinned-releases) keep a version still.

### Offline

After one visit the app works with no network at all, a reload included. What is kept is the app
itself, never your data: a file on your disk opens offline as it does online, while a remote file, a
data store and the example sessions need a connection, since they are read from where they are
published.

When a new version has been published, a bar offers it — *A new version of the viewer is ready* —
with **reload**. Nothing changes under you until you press it.

### Install it as an app

- In **Chrome** or **Edge**, press the install button at the right-hand end of the address bar.
- In **Safari**, choose **Share → Add to Dock**.
- **Firefox** does not offer to install it; use it in a tab.

Installed, it opens in a window of its own, from the dock or the start menu, and works offline as
above. Two things change, because an app you installed on your own machine is a place you have
chosen to keep things, where a browser tab may be anyone's:

- In Chrome and Edge, a folder on your disk that you connect stays connected across restarts. In a
  tab, and in Safari, it is connected for the visit, and its row in the Files column says
  *this visit*. A bucket you connect is remembered by any browser, installed or not.
- In Chrome and Edge, the files of tabs restored after a restart are read again without asking for
  your permission first. In a tab, the landing page asks once, with a button that allows access to
  them.

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

Each is built from the release's own tag when the release is made. **There is no Windows installer
for now**; on Windows, use the web app or the single HTML file below.

### The unsigned-app warning

The installers are not code-signed, so macOS warns you the first time you open the app, with a
message that it cannot be opened because the developer cannot be verified. This says nothing about
whether the app works: a signature only says who published a build. To open it:

- in **Applications**, right-click (or Control-click) **chromosomix**, choose **Open**, then **Open**
  again in the dialog that follows. You only do this once. If the dialog offers no **Open**, go to
  **System Settings → Privacy & Security** and press **Open Anyway**.
- or, in a terminal:

  ```sh
  xattr -d com.apple.quarantine /Applications/chromosomix.app
  ```

The app's About dialog says so too: the build is not code-signed, and the warning was expected.

### What is different from the web app

The desktop app opens what the web app opens, no more and no less. The differences are about where it
runs:

- **No updates of its own.** It never asks a server whether it is current. A new version is a new
  download, and the app you have stays the release you downloaded.
- **It is already on disk**, so it works offline from the start, with no update bar and no list of
  other builds in *About*.
- **Remote hosts see it as `app://viewer`.** A bucket whose CORS settings allow the website by name
  refuses the desktop app while the website works. Allowing every origin (`*`) works for both; see
  [Hosting your data](/advanced/hosting/).
- **A host that compresses what it serves** is read by range here like any other. The web app has to
  download such a file whole, and refuses one over 128 MiB.
- **No Google Drive sign-in.** Dropbox, buckets and folders on your disk work as on the web.
- **Folders on your disk, and the files you opened, are kept** across restarts, as in the installed
  web app.
- **A menu bar of its own**, whose entries do what the window's buttons and keys do. There is no
  reload and no page zoom: a reload would drop a file you had dropped, and page zoom would change the
  pixel size of an exported figure.

## One HTML file

Every release attaches the whole viewer as one file, `chromosomix-<tag>.html`, about 14 MB. Download
it and double-click it: it opens in your browser, from your disk, with no server and no install. Put
it on a USB stick, or send it to a reviewer who will not install an unsigned app.

It is for the machines the other two do not reach: one with no route to the website, such as an
air-gapped workstation, or a laptop holding unpublished data. Nothing can be uploaded from it,
because it cannot reach the network at all.

That is also its limit. **It opens local files only**, and says so under its drop area: *This copy
opens local files only: it is one HTML file with no server behind it, so the browser refuses every
network read. For remote files and the stores, use the hosted viewer.* So it has no URL box, no data
stores, no example sessions and no guided tutorial, and **Connect a folder** offers this machine
alone. Everything else — maps, tracks, 3D models, analyses, figures, the console — is there. A BAM
needs its index dropped with it.

:::caution
The single file is checked in Chromium browsers, such as Chrome and Edge; Firefox and Safari are
untested with it. Every page opened from your disk shares the same browser storage, so two copies of
the single file share their saved sessions and preferences.
:::

## Pinned releases

The web app at <https://chromosomix.app/> changes with every build. Every release is also kept for
good at its own address, `https://chromosomix.app/v/<tag>/` — `https://chromosomix.app/v/v0.13.0/`,
say — which takes the same links as the root. A link in a paper, a figure legend or a notebook that
must draw the same picture in five years should name one: everything after the address, the view
included, is carried across. [Link keys](/reference/links/) has the grammar.

The most recent builds are kept as well, by their commit, so a figure that changed since last week
can be checked against the build that drew it. In *About this viewer*, **Run build** lists every
published build; choosing one opens it in place of the one you are running, and your view and your
tabs come along. A file from your disk does not: open it again there.

A pinned build says so in a bar at the corner of the window — *You are running the build from
commit …* — with **newest build** to go back. Pinned builds cannot be installed and do not work
offline.

The desktop app and the single file are pinned by nature: each is the release it came from. To pin
the command line too, see [Installing it](/cli/install/).

## Elsewhere

The same viewer also runs inside a [Jupyter notebook](/embed/jupyter/), in
[R Markdown, Quarto and Shiny](/embed/r/), and in [any web page](/embed/web-page/) as an `<iframe>`.
To run it from your own server instead of chromosomix.app, see
[Running your own copy](/advanced/self-hosting/).
