# Monthly Budget (AED)

A mobile-first progressive web app (PWA) for a personal 12-month budget in AED. It runs entirely in the browser: no backend, no AI calls and no build step. It installs on Android, iPhone/iPad and desktop browsers, and works fully offline. Google Drive sync is optional.

**Setup steps for non-developers are in [guide/SETUP-GUIDE.md](guide/SETUP-GUIDE.md).**

## What's where

| Path | What it is |
|---|---|
| `docs/` | The app itself. GitHub Pages serves this folder. |
| `docs/js/config.js` | **The only setting you edit:** the Google client ID. While it's empty, sync is hidden. |
| `docs/js/doc.js` | Data model: value-level registers, merging and defaults |
| `docs/js/calc.js` | Budget calculations |
| `docs/js/sync.js`, `drive.js`, `auth.js`, `crypto.js` | Drive sync, Drive REST client, Google sign-in and passphrase encryption |
| `docs/sw.js` | Service worker. Its scope is limited to the app folder, and its caches are prefixed. |
| `tests/unit/` | Node tests for calculations, merging, sync with a mocked Drive, and encryption |
| `tests/e2e/` | Browser tests (Playwright) for the mobile layout, offline use, backup and restore, start-month changes, isolation, and sync with mocked Google |

## Running the tests

These need Node 20+ and, for the browser tests, Playwright with Chromium.

```bash
npm test
```

```bash
npm run e2e
```

```bash
npm run serve
```

`npm test` runs the unit tests, and `npm run e2e` runs the browser tests. `npm run serve` serves the app locally at http://127.0.0.1:8080/budget-app/.

All test data is invented. Screenshots from the browser tests are saved to `test-output/`, which git ignores.

## Design notes

- **Storage:** IndexedDB database `mbapp-monthly-budget-aed`, localStorage prefix `mbapp.monthly-budget-aed.`, and cache prefix `mbapp-monthly-budget-aed-`. The app never reads or removes storage it didn't create. It asks for persistent storage, which browsers grant to the whole origin.
- **Merging:** Every value has its own timestamp and device ID, and the newest value wins. Deletions are stored as markers. The defaults use fixed IDs, so two fresh devices never create duplicate groups.
- **Amounts are stored per month of the period (1–12),** so changing the start month relabels the months without losing figures.
- **Sign-in:** The app requests only the `drive.file` scope. It reads the email address from Drive's `about` endpoint, which needs no extra scope. The account picker is always shown (`prompt=select_account`). No client secret is used.
