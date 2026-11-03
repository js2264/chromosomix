---
title: "Running your own copy"
description: "Serve chromosomix from your lab's own web server, from the npm package's copy or a build of a release, under any path, with the built-in stores and the Google and Dropbox sign-ins your readers need."
---

chromosomix is static files. There is no server program to run and no database: a copy is a folder
you put on any web server, and it does in your readers' browsers what
[chromosomix.app](https://chromosomix.app/) does. Your server sends the viewer and nothing else — the
data is still read from wherever it is published, and a file a reader drops never leaves their
machine.

## Do you need one?

- **For a view that must not change**, a release may be enough: every release stays at
  `https://chromosomix.app/v/<tag>/` for good and takes the same links as the root (see
  [Link keys](/reference/links/)). **About** lists the builds that are published.
- **For a machine with no network**, every release also comes as one HTML file,
  `chromosomix-<tag>.html` on the [releases page](https://github.com/js2264/chromosomix/releases),
  which opens local files with no server at all (see [Web, desktop or one file](/start/where-to-run/)).
- **Your own copy** is for when the viewer itself must come from your address: an intranet, a portal
  that will not depend on another domain, a page that embeds the viewer and must keep working whatever
  happens to this project's site.

## The npm package's copy

Every release is published to npm, and the package's `dist/` folder is the viewer, built to be served
from any path:

```sh
npm pack chromosomix@<version>             # downloads chromosomix-<version>.tgz
tar -xzf chromosomix-<version>.tgz         # unpacks it into package/
cp -R package/dist /var/www/html/viewer    # the viewer, ready to serve
```

Then open `https://lab.example.org/viewer/`. Four things to know about this copy:

- **Its address must end in `/`, or name `index.html`.** At `…/viewer` without the slash it looks for
  its files one folder too high.
- **It has no offline mode.** It registers no service worker, since it cannot know whose site it is
  on, so it is not installable and does not open without its server; and its **About** lists no
  other versions.
- **It has no Google or Dropbox sign-in, and opens no public Google Drive link.** Those need
  registrations made for one web address, and this copy can be served from any. Build a copy with your
  own ([below](#signing-in-to-google-and-dropbox)) if your readers need them. Dropbox share links, and
  everything else, open as on the site.
- **Keep `THIRD-PARTY-NOTICES.txt` beside `index.html`.** It holds the licences of the work the copy
  carries; chromosomix itself is under the GNU General Public License, version 3 or later.

Several versions can sit side by side, each unpacked under a path of its own.

## Building it from a release

With Node 22.12 or later:

```sh
git clone https://github.com/js2264/chromosomix
cd chromosomix
git checkout v<version>     # a release; leave this out for the newest code
npm ci
npm run build               # writes dist/
```

`dist/` is the site's own build: served from the root of a domain, installable as an app, and working
offline after one visit. To serve it under a path instead, give the path when you build — a build
made for `/` is a blank page anywhere else — and preview it the same way before you copy it:

```sh
BASE_PATH=/viewer/ npm run build
BASE_PATH=/viewer/ npm run preview    # http://localhost:4173/viewer/
```

`npm run build:package` builds the package's portable copy instead, and `npm run build:standalone`
the single HTML file.

## Serving it

- **Any static server will do.** The viewer needs no special response headers, and no rewrite rules:
  everything a view is lives in the address after `#`, and `?config=`, `?store=` and `?embed=1` are
  read by the page itself.
- **Do not add a `Content-Security-Policy` header.** The page carries its own policy. A browser
  enforces both, the stricter clause by clause, and a policy forbidding frames would blank every page
  that embeds your copy.
- **Data on the same server is on the viewer's own site**, so it needs no CORS — but it still has to
  answer byte ranges and not compress: see [Hosting your data](/advanced/hosting/).

## The built-in stores

Four of the built-in [stores](/files/stores/) — IGV genomes, 4DN open data, ENCODE and DNA Zoo — are
files the project regenerates every week, and a copy reads them from a `stores/` folder beside its own
`index.html`. They are published on the repository's `stores` branch; copy its JSON files and its
`sessions/` folder in:

```sh
git clone --depth 1 --branch stores https://github.com/js2264/chromosomix stores-branch
mkdir -p /var/www/html/viewer/stores
cp stores-branch/*.json /var/www/html/viewer/stores/
cp -R stores-branch/sessions /var/www/html/viewer/stores/sessions
```

Without them, those four tiles say *Nothing has been published for … yet*, and the
[guided tutorial](/start/tutorial/), which is played on 4DN's store, has nothing to play on.
**RSG lab data** is built into the app and **Roadmap** is read from WashU, so both open regardless.
Copy the branch again to follow its weekly updates.

## Signing in to Google and Dropbox

Three registrations, made once by whoever runs the copy and given to the build. None is a secret —
each ends up in the page — and none is ever asked of a reader:

| Variable | What it is | What it gives your readers |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | an OAuth client id, ending `.apps.googleusercontent.com`, registered for your copy's address | signing in with Google to read a private Drive file or folder, or a private Cloud Storage object |
| `GOOGLE_API_KEY` | an API key of the same Google project, restricted to your copy's address | opening a public Google Drive link |
| `DROPBOX_APP_KEY` | the key of a Dropbox app | signing in to browse their Dropbox |

```sh
GOOGLE_CLIENT_ID=… GOOGLE_API_KEY=… DROPBOX_APP_KEY=… BASE_PATH=/viewer/ npm run build
```

A copy built without one says so where that sign-in would be, and names the variable it lacks.

**Google**, in a Google Cloud project of your own:

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**, of type
   **Web application**.
2. Under **Authorized JavaScript origins**, add your copy's exact origin — scheme, host and port, no
   path and no trailing slash: `https://lab.example.org`. Leave **Authorized redirect URIs** empty.
3. On the **OAuth consent screen**, add the two scopes the viewer asks for and no others:
   `https://www.googleapis.com/auth/drive.readonly` and
   `https://www.googleapis.com/auth/devstorage.read_only`.
4. Copy the client id, and make an API key in the same project, restricted to your copy's address.

`drive.readonly` is a restricted scope: until Google has verified the app, which includes a security
assessment, it works for up to 100 test users you add by address on the consent screen — usually
enough for a lab.

**Dropbox**, in the Dropbox App Console:

1. **Create app**, with **Scoped access**.
2. Choose **App folder**, which confines the app to one folder of each reader's Dropbox, or
   **Full Dropbox**.
3. On the **Permissions** tab, tick `files.metadata.read` and `files.content.read`, and submit.
4. On the **Settings** tab, copy the **App key**, and leave **Redirect URIs** empty: the reader copies
   a code from Dropbox's page back into the viewer, which is why one key works at any address.

The client secret and the app secret are for server applications, and a copy never uses them.

## Opening on your own data

Links to your copy take the same keys as links to the site. Two are worth knowing for a lab:

- `?config=<address>` opens a saved workspace, and a relative address is read against the page, so
  `https://lab.example.org/viewer/?config=figures/fig1.chromosomix.json` opens the workspace in the
  `figures/` folder beside the viewer;
- `?store=<address>` opens your lab's [store](/advanced/data-store/) in the drawer.

## What differs from chromosomix.app

- **What a browser remembers is kept per address.** Stores, bucket keys, preferences and the console a
  reader built up on chromosomix.app are not there on your copy, and the reverse.
- **A bucket whose CORS rule names the sites it admits** must name your copy's too.
- **Links your copy writes point at your copy**, so they last as long as it does.
