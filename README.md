# audit.ankayma.com — Realtime Audit, in your browser

The trial page for Ankayma Realtime Audit. It runs the [cause-justified change monitoring](https://github.com/baotnq/cause-justified-change-monitoring) engine (Apache 2.0), compiled to WebAssembly, on two files the visitor drops into the page:

- **causes**: one row per event allowed to move a balance (deposit, withdrawal, fill, transfer, fee);
- **changes**: one row per write to a balance, taken from the store.

Every write without an unspent cause behind it is a finding. The page opens with the engine repository's two-source example loaded (`examples/chain2`): a withdrawal is justified only by a user request from the frontend **and** an admin approval from the backoffice, and the example shows the four ways that pair can fail.

## Nothing leaves the browser

This is the page's main claim, so it is built to be checked rather than trusted:

- **No connection is possible.** The Content-Security-Policy, as a `<meta>` tag and as a header (`site/_headers`), sets `connect-src 'none'`. The browser refuses any `fetch`, XHR, WebSocket or beacon from the page. The engine runs in a worker created from a `blob:` URL, which inherits that policy.
- **Nothing is fetched after load.** The engine is embedded in `engine.js` (base64), the sample case and templates in `data.js`. Downloads (`alerts.jsonl`, templates) are generated in the page.
- **It works offline.** Load it, disconnect, run it again.
- **The bytes are verifiable.** `cjcm.lock` pins the engine commit and Go version. The page shows the SHA-256 of the engine published with the build, and the SHA-256 the visitor's browser computes from the bytes it is actually running. Anyone can rebuild and compare (below).

`tests/trial.spec.mjs` checks each of these in Chromium and WebKit: the sample alerts, zero requests after load, a blocked `fetch`, offline runs.

## Build

Needs Go (the version in `cjcm.lock`) and Node 20+.

```
npm install
node scripts/build.mjs                         # clones the engine at the pinned commit into .cache/
CJCM_DIR=../cause-justified-change-monitoring node scripts/build.mjs   # or use a checkout at that commit
npm run serve                                  # http://127.0.0.1:4173/
npx playwright install chromium webkit && npm test
```

The build refuses an engine checkout that is not at the pinned commit or has uncommitted changes. Output goes to `dist/`, with `SHA256SUMS` for every file.

### Reproducing the engine hash

```
git clone https://github.com/baotnq/cause-justified-change-monitoring && cd cause-justified-change-monitoring
git checkout <commit from cjcm.lock>
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w -buildid=" -o cjcm.wasm ./cmd/wasm
shasum -a 256 cjcm.wasm
```

With the Go version in `cjcm.lock` this gives the hash shown on the page. Go embeds the commit in the binary (`vcs.revision`), so the hash belongs to that commit: the same source at another commit builds different bytes.

## Deploy

`dist/` is a static site with no server code. It is published on GitHub Pages from the `gh-pages` branch at audit.ankayma.com (`site/CNAME`; `site/.nojekyll` keeps Jekyll from dropping `_headers`). GitHub Pages does not send custom headers, so the CSP comes from the `<meta>` tag in `index.html`; `_headers` applies on Cloudflare Pages and Netlify. Do not add analytics, fonts or any third-party script: each would need a CSP exception and would break the page's claim.

## Layout

| Path | What |
|---|---|
| `site/index.html` | The page, with the CSP |
| `site/app.js` | Inputs, column mapping, rendering; talks to the worker |
| `site/worker.js` | Loads the engine, computes its hash, runs `cjcmRun` |
| `site/_headers` | Security headers for the static host |
| `scripts/build.mjs` | Builds the engine at the pinned commit and assembles `dist/` |
| `scripts/serve.mjs` | Local server with the same headers |
| `cjcm.lock` | Engine repository, commit, Go version |

The input format, the column aliases and the replay live in the engine repository (`internal/ledger`, `schema/ledger-*.schema.json`, `docs/data-mapping.md`), so the page, the offline CLI (`cmd/audit`) and the tests all run the same code.

## Licence

Apache 2.0, the same as the engine.
