# Comics — iPhone Comic Reader (v2.0)

**Comics** is a dark-themed, installable web app (PWA) for reading CBZ / ZIP comic archives on an iPhone 7 (iOS 15) or a desktop browser. It runs entirely in the browser, needs no Mac or App Store account, and has **no server-side account, advertising, tracking or analytics**.

## What's included

- Animated swipe-to-turn pages: **Slide** or **3D Turn** effect.
- **One-page, two-page spread, and Auto (two pages in landscape/wide screens)** reader layouts; left-to-right and right-to-left manga order.
- Fit page / fit width, pinch / double-tap zoom, page slider and reading progress.
- **Comics read** count, reading/in-progress/unread totals, automatic started/finished dates, and manually editable dates in **Edit details**.
- **Up Next** suggestions for *consecutive, numbered issues in the library*, based on the previous issue being finished. Comic filenames like `Batman #001.cbz` or `Batman 002 (2022).cbz` are recognized; you can adjust the series and issue number in Edit details. This does not automatically fetch or identify unrelated sequel titles.
- A sample CBZ comic, *The Last Signal*, for testing without a Google account.
- **ZIP/CBZ archive indexing up to 3 GiB**. Pages are decompressed one at a time, not the whole archive. Supports stored/DEFLATE ZIP entries, conventional ZIP and single-disk ZIP64, and JPG/PNG/WebP/GIF images.
- Optional **read-only Google Drive browsing and range streaming**, with no access token persisted to disk.

## Install on iPhone 7

1. Extract the `comics-v2.zip` archive on your computer.
2. Create a public GitHub repository, for example **comics-reader**, and upload **the contents of the `comics-app` folder** to its root. Only upload the app files and the included sample, **not your personal comics or private information**.
3. Open **GitHub repository → Settings → Pages → Deploy from a branch**, choose branch `main` and folder `/(root)`. After GitHub Pages publishes the site, your URL should resemble `https://YOURUSERNAME.github.io/comics-reader/`.
4. Open the URL in **Safari on iPhone 7**, use **Share → Add to Home Screen**, and launch **Comics**. The web app needs HTTPS for secure Google authorization and PWA installation.
5. Tap **Open the sample comic** to test the reader. In **Settings → Page layout**, choose **2 pages** or **Auto**. The reader's top-right button also toggles one/two pages.
6. Tap **Add** in Library to select CBZ/ZIP files using iOS Files.

If installing or Drive authorization doesn't work in Home Screen mode, try the same HTTPS website in Safari first. iOS may keep separate data for Safari and Home Screen apps.

## How 3 GiB comics work

**3 GiB is an archive-size acceptance and indexed-reading target, not a promise of 3 GiB of offline storage or guaranteed performance on an iPhone 7.** On iOS 15, memory, file selection, image dimensions, Safari quotas and file-provider behavior can still prevent a particular giant CBZ from opening.

- **Small local imports (up to 100 MiB):** store the original archive in local IndexedDB for offline reading.
- **Large local imports (over 100 MiB, up to 3 GiB):** keep only the comic's metadata and cover. The original File object stays available in the running session. **After restarting the app**, tap the comic and select the *same local file (matching filename and size)* again. Comics remembers your progress and metadata.
- **Google Drive imports:** store metadata and cover locally, then request byte ranges for the current page and nearby pages. They require an active Google connection and authorization; **no giant file is downloaded in full or stored offline**.
- Each compressed/decompressed image entry is limited to **48 MiB** for predictable memory use. Oversized pages, malformed/encrypted archives, unsupported formats, ZIP bombs and multi-volume ZIPs are rejected. ZIP64 is supported but not every ZIP extension is.
- On the small iPhone 7 screen, **2-page spreads will be tiny in portrait**. Rotate the phone to landscape for a better view.

**Always preserve the original comics in your personal Google Drive/Files.** Browser storage can be removed by the OS, by clearing website data, or by installing the app in a different container.

## Connect Google Drive safely (optional)

**Important:** The Google Drive permission used is `https://www.googleapis.com/auth/drive.readonly`. It grants the application *read/download access to all files in that Google Drive account*, **not just your comics**. It does not permit modifying or deleting Drive files, but it is still a **broad and sensitive permission**. Only consent if you trust the copy of Comics running on a website that you control. You can avoid this permission entirely by importing from the iOS Files app instead.

1. In [Google Cloud Console](https://console.cloud.google.com/) create or select a project.
2. Enable **Google Drive API**.
3. In **Google Auth Platform** configure the consent screen, set *External → Testing*, and add **your Gmail address** to the permitted Test users. Add the `drive.readonly` scope if requested. For a public app, Google may require verification and additional security compliance because the scope is restricted.
4. Under **Clients**, create an **OAuth 2.0 Client ID → Web application**. Add your deployed **Authorized JavaScript origin**, for example `https://YOURUSERNAME.github.io` (no path). The popup token model doesn't require a redirect URL for this workflow.
5. Copy **only the Web Client ID** (it ends in `.apps.googleusercontent.com`). Never publish a `client_secret`, API keys, access tokens, or refresh tokens in the website.
6. In **Comics → Settings**, paste the Client ID and tap **Save Client ID**.
7. In **Drive → Connect Google Drive**, Google will display the account/consent flow. Check the *origin* and read-only permission carefully before allowing it.
8. Browse a folder and tap a comic. The app will index it using partial requests, keep only cover/progress, and load pages when needed.

Security design:

- All Google sign-in takes place via the official Google Identity Services pop-up; the app never requests a Google password.
- The OAuth access token is stored in **JavaScript memory only**, not in localStorage, IndexedDB, the repository, cookies, or a Comics server.
- The app uses a read-only permission and GET requests only. Requested Drive API URLs are restricted to `https://www.googleapis.com/drive/v3/files…` with no cross-origin redirect allowed.
- Browser Content Security Policy limits script, network, image, frame and object sources. GitHub Pages supports only a **meta-CSP** in this package; a server-managed CSP header is stronger.
- Drive streaming requires HTTP `206 Partial Content` for byte-range reads. If Google does not honor a range, the app fails rather than silently downloading an entire multi-gigabyte file.
- Pressing **Disconnect** requests revocation of the current access token and aborts in-flight reads. Review or revoke account-wide access any time at [Google Account → Third-party connections](https://myaccount.google.com/connections).

**This is a personal prototype, not a security audit.** Do not host modified copies on unknown domains and then authorize them against your personal Drive. Google authorization is not preconfigured; you must register your own site.

## Run locally for desktop testing

From the folder containing `index.html`:

```bash
python -m http.server 8000
```

Visit `http://localhost:8000/` to test local imports and the sample. To test Drive locally, localhost must also be registered as an Authorized JavaScript origin in Google Cloud. For real iPhone installation, use HTTPS.

## Technical details / testing

The app is plain HTML, CSS and JavaScript: no build tools or app backend. Metadata and reading history use IndexedDB (`folio-comics-1`, **intentionally retaining the old database name** so users upgrading from Folio don't lose their library). The v2 reader uses a custom ZIP central-directory reader and vendored **pako 1.0.11** inflation library (MIT AND Zlib, license included in `lib/PAKO-LICENSE.txt`). Google OAuth uses the Google-hosted GIS script.

**Checks performed:** syntax checks on JavaScript files; successful extraction of the included compressed sample CBZ; a fabricated *almost-3-GiB* archive indexed and accessed with ~66 KB read (verifies the random-access architecture, **not** a physical device performance benchmark); and issue-number / Up Next logic tests. **Not verified yet:** Google sign-in against an actual configured OAuth project, cloud range/CORS behavior on iOS 15, full browser integration/UI flow, or real iPhone 7 performance. iOS file-provider limitations and unusually high-resolution pages may still require improvements.
