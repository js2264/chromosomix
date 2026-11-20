---
title: "Running your own copy"
description: "Serve chromosomix from your lab's own web server, from the npm package or a release build, under any path, with the built-in stores and the Google and Dropbox sign-ins."
---

A copy of chromosomix is a folder of static files on any web server, for when the viewer must come from your own address. Data is still read from wherever it is published. For a view that must not change, a release may be enough: each stays at `https://chromosomix.app/v/<tag>/` for good, and **About** lists them. For a machine with no network, use a release's single HTML file ([Web, desktop or one file](/start/where-to-run/)).

## The npm package's copy

The npm package's `dist/` folder is the viewer, built to be served from any path:

```sh
npm pack chromosomix@<version>             # downloads chromosomix-<version>.tgz
tar -xzf chromosomix-<version>.tgz         # unpacks it into package/
cp -R package/dist /var/www/html/viewer    # the viewer, ready to serve
```

Then open `https://lab.example.org/viewer/`.

- **Its address must end in `/`, or name `index.html`.**
- **It has no offline mode**, cannot be installed, and its **About** lists no other versions.
- **It has no Google or Dropbox sign-in, and opens no public Google Drive link**: [build a copy with your own](#signing-in-to-google-and-dropbox) for those. Dropbox share links still open.
- **Keep `THIRD-PARTY-NOTICES.txt` beside `index.html`**: it holds the licences of the work the copy carries.

Several versions can sit side by side, each under its own path.

## Building it from a release

With Node 22.12 or later:

```sh
git clone https://github.com/js2264/chromosomix
cd chromosomix
git checkout v<version>     # a release; leave this out for the newest code
npm ci
npm run build               # writes dist/
```

That build is the site's own, installable and offline, for the root of a domain; anywhere else it is a blank page. For a path, build and preview it with `BASE_PATH`:

```sh
BASE_PATH=/viewer/ npm run build
BASE_PATH=/viewer/ npm run preview    # http://localhost:4173/viewer/
```

`npm run build:package` builds the package's portable copy instead, and `npm run build:standalone` the single HTML file.

## Serving it

- **Any static server will do**, with no special headers or rewrite rules.
- **Do not add a `Content-Security-Policy` header.** The page carries its own, and one forbidding frames would blank every page that embeds your copy.
- **Data on the same server is on the viewer's own site**: it needs no CORS, but still byte ranges and no compression ([Hosting your data](/advanced/hosting/)).

## The built-in stores

Four built-in [stores](/files/stores/) — IGV genomes, 4DN open data, ENCODE and DNA Zoo — are read from a `stores/` folder beside `index.html`. Copy them from the repository's `stores` branch, and again for its weekly updates:

```sh
git clone --depth 1 --branch stores https://github.com/js2264/chromosomix stores-branch
mkdir -p /var/www/html/viewer/stores
cp stores-branch/*.json /var/www/html/viewer/stores/
cp -R stores-branch/sessions /var/www/html/viewer/stores/sessions
```

Without them, those tiles say *Nothing has been published for … yet* and the [guided tutorial](/start/tutorial/) has nothing to play on. **Example datasets** and **Roadmap** open regardless.

## Signing in to Google and Dropbox

Each sign-in needs a registration of your own, given to the build. None is a secret:

| Variable | What it is | What it gives your readers |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | an OAuth client id, ending `.apps.googleusercontent.com`, registered for your copy's address | signing in with Google to read a private Drive file or folder, or a private Cloud Storage object |
| `GOOGLE_API_KEY` | an API key of the same Google project, restricted to your copy's address | opening a public Google Drive link |
| `DROPBOX_APP_KEY` | the key of a Dropbox app | signing in to browse their Dropbox |

```sh
GOOGLE_CLIENT_ID=… GOOGLE_API_KEY=… DROPBOX_APP_KEY=… BASE_PATH=/viewer/ npm run build
```

A copy built without one says so where that sign-in would be, and names the missing variable.

**Google**, in a Google Cloud project of your own:

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**, of type **Web application**.
2. Under **Authorized JavaScript origins**, add your copy's exact origin — scheme, host and port, no path or trailing slash: `https://lab.example.org`. Leave **Authorized redirect URIs** empty.
3. On the **OAuth consent screen**, add only the two scopes the viewer asks for: `https://www.googleapis.com/auth/drive.readonly` and `https://www.googleapis.com/auth/devstorage.read_only`.
4. Copy the client id, and make an API key in the same project, restricted to your copy's address.

Until Google has verified the app, the restricted `drive.readonly` scope works only for up to 100 test users added on the consent screen.

**Dropbox**, in the Dropbox App Console:

1. **Create app**, with **Scoped access**.
2. Choose **App folder**, one folder of each reader's Dropbox, or **Full Dropbox**.
3. On the **Permissions** tab, tick `files.metadata.read` and `files.content.read`, and submit.
4. On the **Settings** tab, copy the **App key**, and leave **Redirect URIs** empty.

A copy never uses the client secret or the app secret.

## Opening on your own data

Links to your copy take the same keys as the site's. A relative `?config=` address is read against the page: `https://lab.example.org/viewer/?config=figures/fig1.chromosomix.json` opens the workspace in `figures/` beside the viewer.

## What differs from chromosomix.app

- **What a browser remembers is kept per address**: stores, bucket keys, preferences and the console from chromosomix.app are not on your copy.
- **A bucket whose CORS rule names the sites it admits** must name your copy too.
- **Links your copy writes point at your copy**, and last as long as it does.
