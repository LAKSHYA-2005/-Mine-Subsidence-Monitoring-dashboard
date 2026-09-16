# SENSE-MINE Console — setup

Plain HTML/CSS/JS, no build step, no framework. Five files matter: `index.html`, `styles.css`, `app.js`, `config.js`, plus the `icons/` folder.

## 1. What's on each page

- **Dashboard** — live node cards, deformation trend chart, GIS map, an AI risk-assessment card, a recent-alerts feed, and the full 23-feature vector for the selected node. Reads Firestore (`nodes_latest` + `readings`) by default, or an imported CSV.
- **Node Health** — per-node RSSI/SNR/confidence/data-quality/last-seen/uptime. Battery and Solar columns read "not reported" because the current firmware doesn't transmit them — see the callout on that page for why, and the Architecture page for the full DPR schema.
- **Simulation Lab** — a fully client-side simulation of the DPR's 6-node mesh: spatial gradient/coherence are *genuinely computed* each tick using the DPR's own §8.4 formulas, seeded from the trained model's actual median values (`preprocessing_rf.h`), not made-up numbers. Deformation-state classification, anomaly score and forecast are simplified stand-ins — clearly labeled as such — for the real Random Forest / Isolation Forest / XGBoost layers. A "Trigger coherent anomaly (N3+N4)" button demonstrates the DPR's core spatial-fusion claim: two neighbouring nodes moving together reads differently from one isolated node.
- **Architecture** — a diagram of the DPR's full locked design (§3.1), with solid-border boxes marking what's actually deployed today vs dashed-amber boxes marking DPR-planned work, plus the risk-level table and the report's own "what this system does not claim" section (§3.2/§19).

## 2. Honesty layer — read this before a demo

The deployed firmware you gave me is **not** the DPR's final architecture. It's a single ESP32(-S3) node writing straight to Firestore over Wi-Fi, running only the Random Forest 6-class classifier. There is no mesh, no FastAPI/PostgreSQL, no SIM800L, no Isolation Forest, no XGBoost forecast, and no battery/solar telemetry being sent. This console is built to never blur that line:

- Live pages only ever show fields the real firmware actually transmits — everything else reads "not reported" / "not deployed" rather than being faked.
- The Simulation Lab is visually distinct (purple accent, banner, separate page) and never mixes with live data.
- The Architecture page documents the target design and marks each piece LIVE or PLANNED.

If a judge asks "is this real," the honest answer is on the page itself.

## 3. Fill in `config.js`

```js
apiKey: "REPLACE_WITH_YOUR_FIREBASE_API_KEY",
authDomain: "REPLACE_WITH_YOUR_PROJECT_ID.firebaseapp.com",
projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
```

Use the same `apiKey`/`projectId` as your firmware's `FIREBASE_API_KEY`/`FIREBASE_PROJECT_ID`. Never put `DEVICE_EMAIL`/`DEVICE_PASSWORD` here — the website only ever uses Firebase Anonymous Auth (read-only).

## 4. Firestore setup (one-time)

1. **Authentication → Sign-in method** → enable **Anonymous** (in addition to whatever you already enabled for the device account).
2. **Firestore → Rules** — anonymous sessions should read, never write; only the device account should write:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /nodes_latest/{nodeId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.token.email == "YOUR_DEVICE_EMAIL";
    }
    match /readings/{docId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.token.email == "YOUR_DEVICE_EMAIL";
    }
  }
}
```

3. **Firestore → Indexes** — the history query filters `node_id` and orders by `timestamp`, which needs a composite index. Firestore throws a console error with a direct "create this index" link the first time you run the query — click it, wait ~1 minute, refresh. This can't be pre-created for you; it's generated from your live project.

## 5. Run it locally in VS Code

Needs a local static file server — opening `index.html` via `file://` breaks the Firebase SDK and Leaflet tiles (CORS).

**Option A — Live Server extension**
1. Install **"Live Server"** (Ritwick Dey) in VS Code.
2. Open the `sense-mine-dashboard` folder.
3. Right-click `index.html` → **"Open with Live Server"** → opens at `http://127.0.0.1:5500`.

**Option B — Node.js, no extension**
```bash
cd sense-mine-dashboard
npx serve .
```

**Option C — Python**
```bash
cd sense-mine-dashboard
python3 -m http.server 5500
```

## 6. Libraries used (all CDN, nothing to `npm install`)

| Library | Why |
|---|---|
| Firebase JS SDK (compat, v10) | Anonymous auth + Firestore realtime reads |
| Leaflet 1.9.4 | GIS maps (Dashboard + Simulation Lab, two independent instances) |
| Chart.js 4.4.4 | Trend charts (Dashboard + Simulation Lab) |
| PapaParse 5.4.1 | CSV import parsing |
| Google Fonts (Space Grotesk, IBM Plex Mono) | Typography |

No new dependencies were added for the Node Health / Simulation Lab / Architecture pages — same four libraries cover everything.

## 7. CSV import format

Header row + one row per reading. Recognized columns: `node_id`, `timestamp`, `deformation_state`, `confidence`, `data_quality`, `rssi`, `snr`, `latitude`, `longitude`, `site_label`, plus one column per feature name from `FEATURE_NAMES` in `config.js` — matches the flat JSON your firmware's `printNodeJSON()` already prints over USB, so a Node-RED CSV export should import without reshaping.

## 8. Before a public demo

- Rotate the Firebase device account password — it's currently in plaintext in a firmware comment block.
- Consider pinning the CA in `WiFiClientSecure` instead of `setInsecure()` if this leaves your lab network.
- Add nodes 2 and 3 to `NODE_LOCATIONS` in `config.js` once real hardware exists — the live map only ever plots node 1 until then.
