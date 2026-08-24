# AffiliateOS Worker (Chrome Extension v0.5.1)

Browser automation worker for the AffiliateOS web app. This extension is the
implementation of the protocol expected by the web app's WorkerService
(`src/lib/worker/chromeWorkerAdapter.js`). It is **not** part of the Base44 app
build — it is a separate, self-contained Chrome extension loaded via
`chrome://extensions`.

## Load it into Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select this `chrome-worker/` folder.
5. Copy the **extension ID** shown on the card (e.g. `abcdefghijklmnopqrstuvwxyz`).

## Connect it to the web app

The web app sends messages to a specific extension ID configured in
`src/lib/worker/workerService.js`:

```js
export const DEV_EXTENSION_ID = "maidkmjdafpndonlhnncoleapnnilaip";
```

Set `DEV_EXTENSION_ID` to the ID shown in `chrome://extensions` for this
unpacked extension. There is no silent fallback — the web app only ever talks
to this one configured ID.

> Production: set `PRODUCTION_EXTENSION_ID` to the Chrome Web Store ID at launch
> and flip `AFFILIATEOS_WORKER_EXTENSION_ID` to it.

## Allowed origins

Only these sites may message the Worker (set in `manifest.json`
`externally_connectable.matches`):

- `https://affiliate-os.base44.app/*`
- `https://affiliate-flow-os.base44.app/*`

Add the production AffiliateOS domain to this list later — no redesign needed.

## Protocol (matches the web app exactly)

| Web app sends (`type`) | Worker responds |
|---|---|
| `AFFILIATEOS_PING` | `{ ok, type:"AFFILIATEOS_PONG", requestId, workerOnline:true, version, execution, mode }` |
| `AFFILIATEOS_STATUS` | `{ ok, type:"AFFILIATEOS_STATUS_RESPONSE", requestId, workerOnline, version, phase, workspace, flow, tiktok, lastJobId }` |
| `AFFILIATEOS_START_JOB` | Immediate `{ ok, event:"WORKER_RECEIVED", job_id, requestId }`, then runs async |
| `AFFILIATEOS_CANCEL_JOB` | `{ ok, type:"AFFILIATEOS_JOB_CANCELLED", requestId }` |

The web app polls `AFFILIATEOS_STATUS` and reads the `phase` field
(`OPENING_WORKSPACE` → `WORKSPACE_READY` → `FLOW_READY` → `TIKTOK_READY`) plus
the `workspace/flow/tiktok` readiness flags to advance the AutomationJob.

## What this build does (bridge proof)

- Responds to PING immediately (Worker Online) — no popup needed.
- Accepts START_JOB, returns `WORKER_RECEIVED` at once, then reuses the existing
  Chrome window that contains the AffiliateOS tab (never creates a new window,
  never opens about:blank). Opens Google Flow and TikTok Studio as new tabs in
  that same window: `AffiliateOS | Google Flow | TikTok Studio`.
- Reports `WORKSPACE_READY`, `FLOW_PAGE_VALIDATED`, `FLOW_READY` via STATUS as the
  Flow tab loads and validates.

## What this build does NOT do

- No real Google Flow video generation yet.
- No real TikTok publishing yet.
- No fake "Completed" or fake published URLs.
- Never asks for Google/TikTok/AffiliateOS passwords.

## Configure workspace URLs

Edit the constants at the top of `background.js`:

```js
const GOOGLE_FLOW_URL = "https://flow.google/";
const TIKTOK_STUDIO_URL = "https://www.tiktok.com/tiktokstudio/upload";
```

`flow.google/` is the canonical launch URL. Google redirects it to
`https://labs.google/fx/tools/flow` — both are accepted by `isFlowUrl()`. The
legacy `https://labs.google.com/flow` URL is a 404 and is rejected.

## Files

- `manifest.json` — MV3 manifest + `externally_connectable`
- `background.js` — service worker (external + internal listeners, workspace, job runner)
- `popup.html` / `popup.js` — diagnostics-only popup
- `README.md` — this file