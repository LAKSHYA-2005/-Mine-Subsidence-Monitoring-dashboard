/* ============================================================
   SENSE-MINE CONSOLE — APP LOGIC
   Two data sources, never mixed at the same time:
     - LIVE   : Firestore `nodes_latest` (realtime) + `readings` (history)
     - CSV    : an offline export (e.g. from the Node-RED USB path)
                loaded via the "Import CSV" button
   Switching sources tears down/rebuilds the whole render — there is
   no attempt to merge live and imported data, mirroring the
   firmware's own "the two modes are not synced" design.
   ============================================================ */

// ---------------- state ----------------
let dataSource = "live";           // "live" | "csv"
let liveNodes = {};                // { nodeId: latestDoc }
let liveHistoryUnsub = null;
let liveLatestUnsub = null;
let csvLatestByNode = {};          // { nodeId: latestRow }
let csvHistoryByNode = {};         // { nodeId: [rows...] }
let selectedNode = null;
let map = null;
let mapMarkers = {};
let trendChart = null;

const nodeGridEl = document.getElementById("nodeGrid");
const nodeSelectEl = document.getElementById("nodeSelect");
const metricSelectEl = document.getElementById("metricSelect");
const sourcePillEl = document.getElementById("sourcePill");
const sourceDotEl = document.getElementById("sourceDot");
const sourceLabelEl = document.getElementById("sourceLabel");
const worstStateValueEl = document.getElementById("worstStateValue");
const alertBannerEl = document.getElementById("alertBanner");
const alertTextEl = document.getElementById("alertText");
const featureNodeTagEl = document.getElementById("featureNodeTag");
const trendFootnoteEl = document.getElementById("trendFootnote");
const lastSyncEl = document.getElementById("lastSync");
const toastStackEl = document.getElementById("toastStack");

// ---------------- toasts ----------------
function showToast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " error" : "");
  el.textContent = message;
  toastStackEl.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function touchLastSync() {
  lastSyncEl.textContent = "Last update " + new Date().toLocaleTimeString();
}

// ---------------- page navigation ----------------
document.querySelectorAll(".page-tab").forEach((btn) => {
  btn.addEventListener("click", () => goToPage(btn.dataset.page));
});
document.querySelectorAll("[data-goto]").forEach((btn) => {
  btn.addEventListener("click", () => goToPage(btn.dataset.goto));
});

function goToPage(pageId) {
  document.querySelectorAll(".page-tab").forEach((b) => b.classList.toggle("active", b.dataset.page === pageId));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === pageId));
  if (pageId === "sim") initSimMapIfNeeded();
  if (pageId === "dashboard" && map) setTimeout(() => map.invalidateSize(), 50);
}

// ---------------- generic alert log (used by both Dashboard and Simulation) ----------------
// Tracks the last-known state per node so an entry is only logged on a
// genuine change, not on every snapshot -- mirrors the DPR's hysteresis
// principle (§9.3): react to a state change, not repeated noisy samples.
function createAlertLog(feedEl, emptyText) {
  const lastState = {};
  const lastStale = {};

  function push(nodeId, severity, text) {
    feedEl.querySelectorAll(".alert-feed-empty").forEach((e) => e.remove());
    const li = document.createElement("li");
    li.className = "sev-" + severity;
    li.innerHTML = `<span class="alert-feed-time">${new Date().toLocaleTimeString()}</span><span class="alert-feed-text">${text}</span>`;
    feedEl.prepend(li);
    while (feedEl.children.length > 50) feedEl.removeChild(feedEl.lastChild);
  }

  function evaluate(nodeId, doc, isStale) {
    // Node-health vs. subsidence distinction (DPR §9.4): a comms gap is
    // reported as a comms failure, never conflated with a deformation alert.
    if (isStale && !lastStale[nodeId]) {
      push(nodeId, "comm", `Node ${nodeId}: NODE COMMUNICATION FAILURE — no packet received recently.`);
    }
    lastStale[nodeId] = isStale;
    if (isStale) return;

    const state = (doc.deformation_state || "UNKNOWN").toUpperCase();
    if (lastState[nodeId] !== state) {
      const risk = classifyRiskLevel(state, doc.confidence);
      if (HIGH_RISK_STATES.has(state) || state === "INITIATION") {
        push(nodeId, risk, `Node ${nodeId}: deformation state changed to ${state} (risk ${risk}, confidence ${((doc.confidence||0)*100).toFixed(0)}%).`);
      } else if (lastState[nodeId] && HIGH_RISK_STATES.has(lastState[nodeId])) {
        push(nodeId, "GREEN", `Node ${nodeId}: recovered to ${state}.`);
      }
    }
    lastState[nodeId] = state;
  }

  function reset() {
    feedEl.innerHTML = `<li class="alert-feed-empty">${emptyText}</li>`;
    Object.keys(lastState).forEach((k) => delete lastState[k]);
    Object.keys(lastStale).forEach((k) => delete lastStale[k]);
  }

  return { evaluate, reset };
}

const liveAlertLog = createAlertLog(document.getElementById("liveAlertFeed"), "No alerts yet this session.");
const simAlertLog = createAlertLog(document.getElementById("simAlertFeed"), "Start the simulation to generate alerts.");

const LIVE_STALE_MS = 60000; // matches DPR's "missed heartbeat" framing (§9.4), tuned for this phase-1 tick rate

// ---------------- theme ----------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("iconMoon").hidden = theme === "dark";
  document.getElementById("iconSun").hidden = theme === "light";
  localStorage.setItem("sense-mine-theme", theme);
}

function initTheme() {
  const saved = localStorage.getItem("sense-mine-theme");
  const systemPrefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(saved || (systemPrefersLight ? "light" : "dark"));
}

document.getElementById("themeToggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "light" ? "dark" : "light");
});

// ---------------- mobile menu ----------------
const menuToggleEl = document.getElementById("menuToggle");
const topbarRightEl = document.getElementById("topbarRight");

menuToggleEl.addEventListener("click", () => {
  const isOpen = topbarRightEl.classList.toggle("open");
  menuToggleEl.setAttribute("aria-expanded", String(isOpen));
});

document.addEventListener("click", (e) => {
  if (!topbarRightEl.classList.contains("open")) return;
  if (topbarRightEl.contains(e.target) || menuToggleEl.contains(e.target)) return;
  topbarRightEl.classList.remove("open");
  menuToggleEl.setAttribute("aria-expanded", "false");
});

// ---------------- Firebase init ----------------
let auth, db;
try {
  firebase.initializeApp(FIREBASE_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
} catch (e) {
  console.error("Firebase init failed — check config.js", e);
  setSourcePill("error", "CONFIG ERROR");
}

function setSourcePill(kind, label) {
  sourceDotEl.className = "dot " + kind;
  sourceLabelEl.textContent = label;
}

async function startLive() {
  dataSource = "live";
  document.getElementById("liveModeBtn").disabled = true;
  setSourcePill("offline", "SIGNING IN…");

  if (!auth) return;

  try {
    await auth.signInAnonymously();
  } catch (e) {
    console.error("Anonymous sign-in failed", e);
    setSourcePill("error", "AUTH FAILED — check Firestore rules / config.js");
    return;
  }

  setSourcePill("live", "LIVE · FIRESTORE");
  subscribeLiveLatest();
}

function subscribeLiveLatest() {
  if (liveLatestUnsub) liveLatestUnsub();
  liveLatestUnsub = db.collection("nodes_latest").onSnapshot(
    (snap) => {
      liveNodes = {};
      snap.forEach((doc) => { liveNodes[doc.id] = doc.data(); });
      touchLastSync();
      if (dataSource === "live") {
        renderNodeCards(liveNodes);
        rebuildNodeSelect(Object.keys(liveNodes));
        renderMap(liveNodes);
        if (selectedNode) subscribeLiveHistory(selectedNode);
      }
    },
    (err) => {
      console.error("nodes_latest listener error", err);
      setSourcePill("error", "FIRESTORE READ FAILED");
    }
  );
}

function subscribeLiveHistory(nodeId) {
  if (liveHistoryUnsub) liveHistoryUnsub();
  liveHistoryUnsub = db.collection("readings")
    .where("node_id", "==", Number(nodeId))
    .orderBy("timestamp", "desc")
    .limit(200)
    .onSnapshot(
      (snap) => {
        const rows = [];
        snap.forEach((doc) => rows.push(doc.data()));
        rows.reverse(); // chronological for the chart
        renderTrendChart(rows, nodeId);
        trendFootnoteEl.textContent = rows.length
          ? `${rows.length} readings from Firestore for node ${nodeId}.`
          : "No history yet for this node — waiting on the next LoRa packet.";
      },
      (err) => {
        console.error("readings query failed", err);
        trendFootnoteEl.textContent =
          "History query failed — this needs a Firestore composite index on (node_id, timestamp). Check the browser console for the create-index link Firestore prints.";
      }
    );
}

// ---------------- CSV import ----------------
document.getElementById("csvInput").addEventListener("change", (evt) => {
  const file = evt.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete: (results) => {
      ingestCsvRows(results.data);
      evt.target.value = ""; // allow re-importing the same file later
    },
    error: (err) => {
      showToast("CSV parse failed: " + err.message, "error");
    },
  });
});

// ---------------- CSV export (current trend view) ----------------
document.getElementById("exportBtn").addEventListener("click", () => {
  if (!lastLiveRows.length) {
    showToast("Nothing to export yet — no readings loaded for this node.");
    return;
  }
  const header = ["node_id", "timestamp", "deformation_state", "confidence", "data_quality", ...FEATURE_NAMES];
  const lines = [header.join(",")];
  lastLiveRows.forEach((r) => {
    const ts = r.timestamp && typeof r.timestamp.toDate === "function" ? r.timestamp.toDate().toISOString() : (r.timestamp || "");
    const row = [selectedNode ?? "", ts, r.deformation_state ?? "", r.confidence ?? "", r.data_quality ?? "",
      ...FEATURE_NAMES.map((f) => r.features?.[f] ?? "")];
    lines.push(row.join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sense-mine_node${selectedNode}_export.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${lastLiveRows.length} rows for node ${selectedNode}.`);
});

function ingestCsvRows(rows) {
  if (liveLatestUnsub) { liveLatestUnsub(); liveLatestUnsub = null; }
  if (liveHistoryUnsub) { liveHistoryUnsub(); liveHistoryUnsub = null; }

  dataSource = "csv";
  document.getElementById("liveModeBtn").disabled = false;
  setSourcePill("offline", "OFFLINE · IMPORTED CSV");

  csvLatestByNode = {};
  csvHistoryByNode = {};

  rows.forEach((row) => {
    const nodeId = row.node_id ?? row.nodeId ?? row.NODE_ID ?? 1;
    const normalized = normalizeCsvRow(row, nodeId);
    if (!csvHistoryByNode[nodeId]) csvHistoryByNode[nodeId] = [];
    csvHistoryByNode[nodeId].push(normalized);
    csvLatestByNode[nodeId] = normalized; // last row wins — CSV assumed chronological
  });

  renderNodeCards(csvLatestByNode);
  rebuildNodeSelect(Object.keys(csvLatestByNode));
  renderMap(csvLatestByNode);

  const firstNode = Object.keys(csvHistoryByNode)[0];
  if (firstNode) {
    renderTrendChart(csvHistoryByNode[firstNode], firstNode);
    trendFootnoteEl.textContent =
      `${csvHistoryByNode[firstNode].length} rows imported for node ${firstNode}. Not synced with live Firestore data.`;
  }
  touchLastSync();
  showToast(`Imported ${rows.length} CSV rows across ${Object.keys(csvHistoryByNode).length} node(s).`);
}

// Accepts either the flat printNodeJSON()-style shape (features.crack_width_mm
// nested) or a flattened CSV export (a column per feature name, as Node-RED's
// CSV node would typically produce).
function normalizeCsvRow(row, nodeId) {
  const features = {};
  FEATURE_NAMES.forEach((name) => {
    if (row[name] !== undefined) features[name] = row[name];
    else if (row["features." + name] !== undefined) features[name] = row["features." + name];
  });
  return {
    node_id: nodeId,
    timestamp: row.timestamp ?? row.time ?? null,
    deformation_state: (row.deformation_state ?? row.state ?? "UNKNOWN").toString().toUpperCase(),
    confidence: Number(row.confidence ?? 0),
    data_quality: row.data_quality ?? "OK",
    rssi: row.rssi ?? null,
    snr: row.snr ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    site_label: row.site_label ?? null,
    features,
  };
}

document.getElementById("liveModeBtn").addEventListener("click", () => {
  csvLatestByNode = {};
  csvHistoryByNode = {};
  startLive();
});

// ---------------- node cards ----------------
function renderNodeCards(nodesObj) {
  const ids = Object.keys(nodesObj);
  nodeGridEl.innerHTML = "";

  if (ids.length === 0) {
    nodeGridEl.innerHTML = `<div class="node-card empty">No node data yet.</div>`;
    updateWorstState([]);
    return;
  }

  ids.sort((a, b) => Number(a) - Number(b)).forEach((id) => {
    const n = nodesObj[id];
    const state = (n.deformation_state || "UNKNOWN").toUpperCase();
    const color = RISK_COLOR[state] || RISK_COLOR.UNKNOWN;
    const conf = n.confidence != null ? (n.confidence * 100).toFixed(0) : "—";
    const ageStr = ageLabel(n.timestamp);
    const stale = (ageMs(n.timestamp) ?? 0) > LIVE_STALE_MS;

    liveAlertLog.evaluate(id, n, stale);

    const card = document.createElement("article");
    card.className = `node-card risk-${state}`;
    card.innerHTML = `
      <div class="node-card-head">
        <span class="node-id">NODE ${id}</span>
        <span class="node-age">${ageStr}</span>
      </div>
      <div class="node-state" style="color:${color}">${state}</div>
      <div class="node-confidence">confidence ${conf}%</div>
      <div class="node-metrics">
        <span class="node-metric-label">Crack width</span>
        <span class="node-metric-value">${fmt(n.features?.crack_width_mm)} mm</span>
        <span class="node-metric-label">Vert. displ.</span>
        <span class="node-metric-value">${fmt(n.features?.vertical_displacement_mm)} mm</span>
        <span class="node-metric-label">RSSI</span>
        <span class="node-metric-value">${n.rssi ?? "—"} dBm</span>
        <span class="node-metric-label">SNR</span>
        <span class="node-metric-value">${fmt(n.snr)} dB</span>
      </div>
      <span class="node-quality ${n.data_quality || "OK"}">${n.data_quality || "OK"}</span>
    `;
    card.addEventListener("click", () => selectNode(id));
    nodeGridEl.appendChild(card);
  });

  updateWorstState(ids.map((id) => (nodesObj[id].deformation_state || "UNKNOWN").toUpperCase()));
  renderNodeHealthTable(nodesObj);

  if (!selectedNode || !ids.includes(String(selectedNode))) {
    selectNode(ids[0]);
  } else {
    renderFeatureTable(nodesObj[selectedNode]);
    renderAiCard(nodesObj[selectedNode]);
  }
}

// ---------------- node health page ----------------
function renderNodeHealthTable(nodesObj) {
  const tbody = document.querySelector("#healthTable tbody");
  const ids = Object.keys(nodesObj).sort((a, b) => Number(a) - Number(b));
  if (ids.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="feature-table-empty">No node data yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = ids.map((id) => {
    const n = nodesObj[id];
    const state = (n.deformation_state || "UNKNOWN").toUpperCase();
    const uptime = n.device_uptime_ms != null ? (n.device_uptime_ms / 1000 / 60).toFixed(1) + " min" : "—";
    return `
      <tr>
        <td class="fname">Node ${id}</td>
        <td style="color:${RISK_COLOR[state] || RISK_COLOR.UNKNOWN}">${state}</td>
        <td class="fval">${n.confidence != null ? (n.confidence * 100).toFixed(0) + "%" : "—"}</td>
        <td class="fval">${n.rssi ?? "—"}</td>
        <td class="fval">${fmt(n.snr)}</td>
        <td>${n.data_quality || "—"}</td>
        <td>${ageLabel(n.timestamp)}</td>
        <td class="fval">${uptime}</td>
        <td class="unavailable">not reported</td>
        <td class="unavailable">not reported</td>
      </tr>`;
  }).join("");
}

// ---------------- AI-derived risk card (Dashboard — real data only) ----------------
function renderAiCard(nodeDoc) {
  if (!nodeDoc) return;
  const state = (nodeDoc.deformation_state || "UNKNOWN").toUpperCase();
  const conf = nodeDoc.confidence ?? 0;
  const risk = classifyRiskLevel(state, conf);

  document.getElementById("aiCardNodeTag").textContent = `Node ${nodeDoc.node_id ?? selectedNode}`;
  const badgeEl = document.getElementById("aiRiskLevel");
  badgeEl.textContent = risk;
  badgeEl.style.color = RISK_LEVEL_COLOR[risk];
  document.getElementById("aiRiskMeaning").textContent = RISK_LEVEL_MEANING[risk];
  document.getElementById("aiState").textContent = state;
  document.getElementById("aiConfidence").textContent = (conf * 100).toFixed(0) + "%";
}

function fmt(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(2);
}

function ageMs(ts) {
  if (!ts) return null;
  let ms;
  if (typeof ts.toDate === "function") ms = ts.toDate().getTime();
  else ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return null;
  return Date.now() - ms;
}

function ageLabel(ts) {
  if (!ts) return "no timestamp";
  let ms;
  if (typeof ts.toDate === "function") ms = ts.toDate().getTime(); // Firestore Timestamp
  else ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return "no timestamp";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

const RISK_RANK = { RAPID: 5, ACCELERATING: 5, PROGRESSIVE: 4, INITIATION: 2, STABILIZING: 1, STABLE: 0, UNKNOWN: -1 };

function updateWorstState(states) {
  if (states.length === 0) {
    worstStateValueEl.textContent = "NO DATA";
    worstStateValueEl.style.color = RISK_COLOR.UNKNOWN;
    worstStateValueEl.classList.remove("is-live");
    hideAlert();
    return;
  }
  let worst = states[0];
  states.forEach((s) => { if ((RISK_RANK[s] ?? -1) > (RISK_RANK[worst] ?? -1)) worst = s; });
  worstStateValueEl.textContent = worst;
  worstStateValueEl.style.color = RISK_COLOR[worst] || RISK_COLOR.UNKNOWN;
  worstStateValueEl.classList.add("is-live");

  if (HIGH_RISK_STATES.has(worst)) {
    showAlert(`At least one node is reporting ${worst}. Review the trend chart and feature vector before dismissing.`);
  } else {
    hideAlert();
  }
}

function showAlert(text) {
  alertTextEl.textContent = text;
  alertBannerEl.hidden = false;
}
function hideAlert() { alertBannerEl.hidden = true; }
document.getElementById("alertDismiss").addEventListener("click", hideAlert);

// ---------------- node select / feature table ----------------
function rebuildNodeSelect(ids) {
  const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
  const current = nodeSelectEl.value;
  nodeSelectEl.innerHTML = sorted.map((id) => `<option value="${id}">Node ${id}</option>`).join("");
  if (sorted.includes(current)) nodeSelectEl.value = current;
}

function selectNode(id) {
  selectedNode = id;
  nodeSelectEl.value = id;
  featureNodeTagEl.textContent = `Node ${id}`;

  const source = dataSource === "live" ? liveNodes : csvLatestByNode;
  if (source[id]) {
    renderFeatureTable(source[id]);
    renderAiCard(source[id]);
  }

  if (dataSource === "live") {
    subscribeLiveHistory(id);
  } else if (csvHistoryByNode[id]) {
    renderTrendChart(csvHistoryByNode[id], id);
  }
}

nodeSelectEl.addEventListener("change", (e) => selectNode(e.target.value));
metricSelectEl.addEventListener("change", () => {
  const rows = dataSource === "live" ? lastLiveRows : (csvHistoryByNode[selectedNode] || []);
  renderTrendChart(rows, selectedNode);
});

function renderFeatureTable(nodeDoc) {
  const tbody = document.querySelector("#featureTable tbody");
  tbody.innerHTML = "";
  const entries = FEATURE_NAMES.map((name) => [name, nodeDoc.features?.[name]]);
  for (let i = 0; i < entries.length; i += 2) {
    const [n1, v1] = entries[i];
    const pair = entries[i + 1] || ["", undefined];
    const [n2, v2] = pair;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="fname">${n1}</td><td class="fval">${fmt(v1)}</td>
      <td class="fname">${n2 || ""}</td><td class="fval">${n2 ? fmt(v2) : ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------------- trend chart ----------------
let lastLiveRows = [];

function renderTrendChart(rows, nodeId) {
  lastLiveRows = rows;
  const metric = metricSelectEl.value;
  const labels = rows.map((r, i) => timestampLabel(r.timestamp, i));
  const values = rows.map((r) =>
    metric === "confidence" ? r.confidence : r.features?.[metric]
  );

  const ctx = document.getElementById("trendChart").getContext("2d");
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `Node ${nodeId} — ${metricSelectEl.selectedOptions[0]?.textContent || metric}`,
        data: values,
        borderColor: "#22D3EE",
        backgroundColor: "rgba(34,211,238,0.12)",
        tension: 0.25,
        pointRadius: 2,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8393AD", font: { family: "IBM Plex Mono", size: 11 } } } },
      scales: {
        x: { ticks: { color: "#8393AD", maxTicksLimit: 8 }, grid: { color: "#1E2A3F" } },
        y: { ticks: { color: "#8393AD" }, grid: { color: "#1E2A3F" } },
      },
    },
  });
}

function timestampLabel(ts, fallbackIndex) {
  if (!ts) return `#${fallbackIndex}`;
  let d;
  if (typeof ts.toDate === "function") d = ts.toDate();
  else d = new Date(ts);
  if (Number.isNaN(d.getTime())) return `#${fallbackIndex}`;
  return d.toLocaleTimeString();
}

// ---------------- GIS map ----------------
function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([24.55, 87.46], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
}

function renderMap(nodesObj) {
  if (!map) return;
  const bounds = [];

  Object.keys(nodesObj).forEach((id) => {
    const n = nodesObj[id];
    const loc = NODE_LOCATIONS[id] || (n.latitude && n.longitude
      ? { lat: n.latitude, lon: n.longitude, label: n.site_label || `Node ${id}`, note: n.location_source || "" }
      : null);
    if (!loc) return;

    const state = (n.deformation_state || "UNKNOWN").toUpperCase();
    const color = RISK_COLOR[state] || RISK_COLOR.UNKNOWN;

    if (mapMarkers[id]) map.removeLayer(mapMarkers[id]);

    const marker = L.circleMarker([loc.lat, loc.lon], {
      radius: 11,
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 2,
    }).addTo(map);

    marker.bindPopup(`
      <strong>Node ${id} — ${state}</strong><br/>
      ${loc.label}<br/>
      <em style="font-size:11px;">${loc.note || "Reference/demo coordinates."}</em>
    `);

    mapMarkers[id] = marker;
    bounds.push([loc.lat, loc.lon]);
  });

  if (bounds.length === 1) map.setView(bounds[0], 15);
  else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
}

function initSimMapIfNeeded() {
  if (!simMap) {
    simMap = L.map("simMap", { zoomControl: true, attributionControl: true }).setView([24.55, 87.46], 14);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(simMap);
    renderSimMap();
  }
  setTimeout(() => simMap.invalidateSize(), 50);
}

// ================= SIMULATION ENGINE =================
// Six synthetic nodes generated entirely client-side. Baseline feature
// values are the model's own training-data medians (see SIM_FEATURE_BASELINE
// in config.js, sourced from preprocessing_rf.h) rather than arbitrary
// numbers, so "normal" here means what the model was actually trained to
// consider normal. Spatial gradient/coherence ARE genuinely computed
// across the 6 simulated nodes using the DPR's own formulas (§8.4) — only
// the deformation-state classification, anomaly score, and forecast are
// simplified stand-ins for the real Random Forest / Isolation Forest / XGBoost.
const SIM_NODE_IDS = [1, 2, 3, 4, 5, 6];
let simRunning = false;
let simIntervalId = null;
let simNodes = {};
let simHistory = {};
let simSelectedNode = "1";
let simMap = null;
let simMapMarkers = {};
let simTrendChartInstance = null;
let simAnomalyActive = false;

function simBaselineFeatures() {
  const f = {};
  FEATURE_NAMES.forEach((name, i) => { f[name] = SIM_FEATURE_BASELINE[i]; });
  return f;
}

function initSimNodes() {
  simNodes = {};
  simHistory = {};
  SIM_NODE_IDS.forEach((id) => {
    simNodes[id] = {
      node_id: id,
      timestamp: new Date(),
      deformation_state: "STABLE",
      confidence: 0.9,
      data_quality: "OK",
      rssi: -65,
      snr: 9,
      device_uptime_ms: 0,
      features: simBaselineFeatures(),
    };
    simHistory[id] = [];
  });
  rebuildSimNodeSelect();
  renderSimNodeCards();
  renderSimAiCard(simNodes[simSelectedNode]);
  if (simMap) renderSimMap();
  simAlertLog.reset();
}

function simRandomWalk(value, baseline, stepScale, bound) {
  const pull = (baseline - value) * 0.04;
  const noise = (Math.random() - 0.5) * stepScale;
  let v = value + pull + noise;
  if (bound) v = Math.max(bound[0], Math.min(bound[1], v));
  return v;
}

function simClassifyState(node) {
  const f = node.features;
  const crackDelta = f.crack_width_mm - SIM_FEATURE_BASELINE[0];
  const dispDelta = f.vertical_displacement_mm - SIM_FEATURE_BASELINE[1];
  const growth = f.crack_growth_rate_mm_day;
  const magnitude = Math.abs(crackDelta) + Math.abs(dispDelta);

  if (magnitude > 6 && growth > 20) return "RAPID";
  if (magnitude > 4 && growth > 8) return "ACCELERATING";
  if (magnitude > 2.5) return "PROGRESSIVE";
  if (magnitude > 1) return "INITIATION";
  if (growth < -2 && magnitude > 0.4) return "STABILIZING";
  return "STABLE";
}

function simTickFn() {
  const nowDate = new Date();

  SIM_NODE_IDS.forEach((id) => {
    const node = simNodes[id];
    const f = node.features;
    const isAnomalyNode = simAnomalyActive && (id === 3 || id === 4);
    const prevCrack = f.crack_width_mm;
    const prevDisp = f.vertical_displacement_mm;

    if (isAnomalyNode) {
      f.crack_width_mm += 0.08 + Math.random() * 0.05;
      f.vertical_displacement_mm += 0.15 + Math.random() * 0.08;
      f.tilt_x_deg = simRandomWalk(f.tilt_x_deg, 0.6, 0.03, [-5, 5]);
    } else {
      f.crack_width_mm = simRandomWalk(f.crack_width_mm, SIM_FEATURE_BASELINE[0], 0.03, [0, 20]);
      f.vertical_displacement_mm = simRandomWalk(f.vertical_displacement_mm, SIM_FEATURE_BASELINE[1], 0.04, [0, 30]);
      f.tilt_x_deg = simRandomWalk(f.tilt_x_deg, 0, 0.02, [-3, 3]);
    }
    f.tilt_y_deg = simRandomWalk(f.tilt_y_deg, 0, 0.02, [-3, 3]);
    f.vibration_rms_g = Math.max(0, simRandomWalk(f.vibration_rms_g, SIM_FEATURE_BASELINE[4], 0.005));
    f.vibration_peak_g = f.vibration_rms_g * (2 + Math.random());
    f.temperature_C = simRandomWalk(f.temperature_C, SIM_FEATURE_BASELINE[7], 0.15, [15, 35]);

    f.crack_growth_rate_mm_day = (f.crack_width_mm - prevCrack) * 86400;
    f.vertical_displacement_velocity_mm_day = (f.vertical_displacement_mm - prevDisp) * 86400;
    f.cumulative_crack_growth_mm = Math.max(0, f.crack_width_mm - SIM_FEATURE_BASELINE[0]);
    f.cumulative_subsidence_mm = Math.max(0, f.vertical_displacement_mm - SIM_FEATURE_BASELINE[1]);

    node.rssi = Math.round(simRandomWalk(node.rssi, -70, 2, [-100, -40]));
    node.snr = simRandomWalk(node.snr, 9, 0.4, [-5, 15]);
    node.device_uptime_ms = (node.device_uptime_ms || 0) + Number(simSpeedSelectEl.value);
    node.timestamp = nowDate;
  });

  // Spatial fusion across all 6 simulated nodes — DPR §8.4's own formulas.
  const displacements = SIM_NODE_IDS.map((id) => simNodes[id].features.vertical_displacement_mm);
  const gradient = Math.max(...displacements) - Math.min(...displacements);
  const mean = displacements.reduce((a, b) => a + b, 0) / displacements.length;
  const variance = displacements.reduce((a, b) => a + (b - mean) ** 2, 0) / displacements.length;
  const coherence = Math.max(0, 1 - Math.sqrt(variance) / (mean + 1));

  const gradientEl = document.getElementById("fusionGradient");
  const coherenceEl = document.getElementById("fusionCoherence");
  if (gradientEl) gradientEl.textContent = gradient.toFixed(2) + " mm";
  if (coherenceEl) coherenceEl.textContent = coherence.toFixed(2);

  SIM_NODE_IDS.forEach((id) => {
    const node = simNodes[id];
    node.features.spatial_displacement_gradient = gradient;
    node.features.spatial_coherence = coherence;
    node.deformation_state = simClassifyState(node);
    node.confidence = Math.min(0.99, 0.72 + Math.random() * 0.25);

    simHistory[id].push(JSON.parse(JSON.stringify(node)));
    if (simHistory[id].length > 200) simHistory[id].shift();

    simAlertLog.evaluate(id, node, false);
  });

  renderSimNodeCards();
  renderSimMap();
  renderSimTrendChart(simHistory[simSelectedNode] || [], simSelectedNode);
  renderSimAiCard(simNodes[simSelectedNode]);
}

function rebuildSimNodeSelect() {
  simNodeSelectEl.innerHTML = SIM_NODE_IDS.map((id) => `<option value="${id}">Node ${id}</option>`).join("");
  simNodeSelectEl.value = simSelectedNode;
}

function renderSimNodeCards() {
  const gridEl = document.getElementById("simNodeGrid");
  gridEl.innerHTML = "";
  SIM_NODE_IDS.forEach((id) => {
    const n = simNodes[id];
    const state = n.deformation_state;
    const color = RISK_COLOR[state] || RISK_COLOR.UNKNOWN;
    const card = document.createElement("article");
    card.className = `node-card risk-${state}`;
    card.innerHTML = `
      <div class="node-card-head">
        <span class="node-id">NODE ${id}</span>
        <span class="node-age">${simRunning ? "live" : "idle"}</span>
      </div>
      <div class="node-state" style="color:${color}">${state}</div>
      <div class="node-confidence">confidence ${(n.confidence * 100).toFixed(0)}%</div>
      <div class="node-metrics">
        <span class="node-metric-label">Crack width</span>
        <span class="node-metric-value">${fmt(n.features.crack_width_mm)} mm</span>
        <span class="node-metric-label">Vert. displ.</span>
        <span class="node-metric-value">${fmt(n.features.vertical_displacement_mm)} mm</span>
        <span class="node-metric-label">RSSI</span>
        <span class="node-metric-value">${n.rssi} dBm</span>
        <span class="node-metric-label">SNR</span>
        <span class="node-metric-value">${fmt(n.snr)} dB</span>
      </div>
    `;
    card.addEventListener("click", () => {
      simSelectedNode = String(id);
      simNodeSelectEl.value = simSelectedNode;
      renderSimTrendChart(simHistory[simSelectedNode] || [], simSelectedNode);
      renderSimAiCard(simNodes[simSelectedNode]);
    });
    gridEl.appendChild(card);
  });
}

function renderSimMap() {
  if (!simMap) return;
  const bounds = [];
  SIM_NODE_IDS.forEach((id) => {
    const loc = SIM_NODE_LOCATIONS[id];
    const n = simNodes[id];
    const color = RISK_COLOR[n.deformation_state] || RISK_COLOR.UNKNOWN;
    if (simMapMarkers[id]) simMap.removeLayer(simMapMarkers[id]);
    const marker = L.circleMarker([loc.lat, loc.lon], { radius: 11, color, fillColor: color, fillOpacity: 0.75, weight: 2 }).addTo(simMap);
    marker.bindPopup(`<strong>Node ${id} — ${n.deformation_state}</strong><br/><em style="font-size:11px;">Simulated position, demo layout only.</em>`);
    simMapMarkers[id] = marker;
    bounds.push([loc.lat, loc.lon]);
  });
  simMap.fitBounds(bounds, { padding: [30, 30] });
}

function renderSimTrendChart(rows, nodeId) {
  const metric = simMetricSelectEl.value;
  const labels = rows.map((r, i) => new Date(r.timestamp).toLocaleTimeString());
  const values = rows.map((r) => (metric === "confidence" ? r.confidence : r.features?.[metric]));

  const ctx = document.getElementById("simTrendChart").getContext("2d");
  if (simTrendChartInstance) simTrendChartInstance.destroy();
  simTrendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `Node ${nodeId} (simulated) — ${simMetricSelectEl.selectedOptions[0]?.textContent || metric}`,
        data: values,
        borderColor: "#9B7EDE",
        backgroundColor: "rgba(155,126,222,0.15)",
        tension: 0.25,
        pointRadius: 1.5,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#8393AD", font: { family: "IBM Plex Mono", size: 11 } } } },
      scales: {
        x: { ticks: { color: "#8393AD", maxTicksLimit: 8 }, grid: { color: "#1E2A3F" } },
        y: { ticks: { color: "#8393AD" }, grid: { color: "#1E2A3F" } },
      },
    },
  });
}

function renderSimAiCard(node) {
  if (!node) return;
  const state = node.deformation_state;
  const risk = classifyRiskLevel(state, node.confidence);
  document.getElementById("simAiNodeTag").textContent = `Node ${node.node_id}`;
  const levelEl = document.getElementById("simAiRiskLevel");
  levelEl.textContent = simRunning ? risk : "—";
  levelEl.style.color = RISK_LEVEL_COLOR[risk];
  document.getElementById("simAiRiskMeaning").textContent = simRunning ? RISK_LEVEL_MEANING[risk] : "Not running";
  document.getElementById("simAiState").textContent = state;
  document.getElementById("simAiConfidence").textContent = (node.confidence * 100).toFixed(0) + "%";

  // Fabricated demo stand-ins, clearly labeled as such in the panel footnote:
  const anomalyScore = Math.min(0.99, Math.abs(node.features.crack_width_mm - SIM_FEATURE_BASELINE[0]) / 8 + Math.abs(node.features.vertical_displacement_mm - SIM_FEATURE_BASELINE[1]) / 12);
  document.getElementById("simAiAnomaly").textContent = simRunning ? anomalyScore.toFixed(2) : "—";
  const forecast1h = node.features.vertical_displacement_mm + node.features.vertical_displacement_velocity_mm_day * (1 / 24);
  document.getElementById("simAiForecast").textContent = simRunning ? forecast1h.toFixed(2) + " mm" : "—";
}

// ---------------- simulation controls ----------------
const simStartBtn = document.getElementById("simStartBtn");
const simStopBtn = document.getElementById("simStopBtn");
const simResetBtn = document.getElementById("simResetBtn");
const simAnomalyBtn = document.getElementById("simAnomalyBtn");
const simSpeedSelectEl = document.getElementById("simSpeedSelect");
const simNodeSelectEl = document.getElementById("simNodeSelect");
const simMetricSelectEl = document.getElementById("simMetricSelect");

simStartBtn.addEventListener("click", () => {
  if (simRunning) return;
  simRunning = true;
  simStartBtn.disabled = true;
  simStopBtn.disabled = false;
  simAnomalyBtn.disabled = false;
  simIntervalId = setInterval(simTickFn, Number(simSpeedSelectEl.value));
  showToast("Simulation started — 6 synthetic nodes ticking.");
});

simStopBtn.addEventListener("click", () => {
  simRunning = false;
  clearInterval(simIntervalId);
  simStartBtn.disabled = false;
  simStopBtn.disabled = true;
  simAnomalyBtn.disabled = true;
  renderSimNodeCards();
});

simResetBtn.addEventListener("click", () => {
  simRunning = false;
  simAnomalyActive = false;
  clearInterval(simIntervalId);
  simStartBtn.disabled = false;
  simStopBtn.disabled = true;
  simAnomalyBtn.disabled = true;
  simAnomalyBtn.textContent = "Trigger coherent anomaly (N3 + N4)";
  initSimNodes();
  showToast("Simulation reset to baseline.");
});

simAnomalyBtn.addEventListener("click", () => {
  simAnomalyActive = !simAnomalyActive;
  simAnomalyBtn.textContent = simAnomalyActive
    ? "Stop coherent anomaly"
    : "Trigger coherent anomaly (N3 + N4)";
});

simSpeedSelectEl.addEventListener("change", () => {
  if (simRunning) {
    clearInterval(simIntervalId);
    simIntervalId = setInterval(simTickFn, Number(simSpeedSelectEl.value));
  }
});

simNodeSelectEl.addEventListener("change", (e) => {
  simSelectedNode = e.target.value;
  renderSimTrendChart(simHistory[simSelectedNode] || [], simSelectedNode);
  renderSimAiCard(simNodes[simSelectedNode]);
});

simMetricSelectEl.addEventListener("change", () => {
  renderSimTrendChart(simHistory[simSelectedNode] || [], simSelectedNode);
});

// ---------------- boot ----------------
initTheme();
initMap();
initSimNodes();
startLive();
