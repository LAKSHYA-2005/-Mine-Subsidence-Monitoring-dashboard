/* ============================================================
   SENSE-MINE CONSOLE — CONFIG
   Fill in the SAME apiKey / projectId you used in the Command
   Centre firmware's FIREBASE_API_KEY / FIREBASE_PROJECT_ID.

   Do not put DEVICE_EMAIL / DEVICE_PASSWORD here — the website
   never signs in as the device account. It uses Firebase
   Anonymous Auth (read-only, per the Firestore rules note that
   shipped with the firmware). Anonymous sessions have auth !=
   null but no email claim, so they can read and cannot write.

   Keep this file out of a public repo if you don't want the
   project visible before you're ready to show it — the apiKey
   itself is not secret (Firebase's own docs say so; access
   control lives in your Firestore rules, not the key), but
   projectId reveals which project to poke at.
   ============================================================ */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBwdXQLuA4vffr9BPH9egR6FIRTyd7bgyA",
  authDomain: "mine-subsidence-monitoring.firebaseapp.com",
  projectId: "mine-subsidence-monitoring",
};

// Static node install locations — mirrors kNodeLocations[] in the
// Command Centre firmware. Add nodes 2 and 3 here once they exist;
// until then the map only ever shows node 1.
const NODE_LOCATIONS = {
  1: {
    lat: 24.550896,
    lon: 87.460226,
    label: "Pachhwara North Coal Block, Pakur, Jharkhand",
    note: "Reference/demo site — testbed hardware is NOT physically installed here.",
  },
};

// Matches kClassNames[] order in both firmware files exactly.
const CLASS_NAMES = ["ACCELERATING", "INITIATION", "PROGRESSIVE", "RAPID", "STABILIZING", "STABLE"];

// Matches isHighRisk() in the Command Centre firmware exactly —
// ACCELERATING, PROGRESSIVE, RAPID are alert-worthy.
const HIGH_RISK_STATES = new Set(["ACCELERATING", "PROGRESSIVE", "RAPID"]);

// Matches kFeatureNames[23] order in both firmware files exactly.
const FEATURE_NAMES = [
  "crack_width_mm", "vertical_displacement_mm", "tilt_x_deg", "tilt_y_deg",
  "vibration_rms_g", "vibration_peak_g", "dominant_frequency_hz", "temperature_C",
  "crack_growth_rate_mm_day", "vertical_displacement_velocity_mm_day",
  "displacement_acceleration_mm_day2", "tilt_rate_deg_day",
  "cumulative_crack_growth_mm", "cumulative_subsidence_mm",
  "spatial_displacement_gradient", "spatial_coherence",
  "mining_depth_m", "seam_thickness_m", "mining_height_m",
  "panel_width_m", "panel_length_m", "face_advance_rate_m_day", "extraction_ratio",
];

// Simplified client-side proxy for the DPR's downstream risk engine (§9.1).
// The real engine also needs multi-node spatial coherence + sensor-health
// validation (§8.6), which a single-node live feed cannot supply — this
// is a stand-in using only state + confidence, not the real thing.
function classifyRiskLevel(state, confidence) {
  const c = confidence ?? 0;
  if (state === "ACCELERATING" || state === "RAPID") return c >= 0.6 ? "RED" : "ORANGE";
  if (state === "PROGRESSIVE") return c >= 0.6 ? "ORANGE" : "YELLOW";
  if (state === "INITIATION") return "YELLOW";
  return "GREEN"; // STABLE, STABILIZING
}

const RISK_LEVEL_COLOR = { GREEN: "#3DDC97", YELLOW: "#F5C542", ORANGE: "#FF9142", RED: "#FF3B3B" };
const RISK_LEVEL_MEANING = {
  GREEN: "Normal",
  YELLOW: "Early abnormality — single-node or low-confidence signal",
  ORANGE: "Persistent / spatially coherent deformation across neighbouring nodes",
  RED: "Rapid or accelerating deformation with multi-node confirmation",
};

// Simulated 6-node layout for the Simulation page only — approximate
// offsets around the same reference point used for the live node, arranged
// to mirror the DPR's N1-N2-N3 / N6-N5-N4 topology sketch (§3.1). These are
// NOT surveyed coordinates.
const SIM_NODE_LOCATIONS = {
  1: { lat: 24.550896 + 0.0015, lon: 87.460226 - 0.0010 },
  2: { lat: 24.550896 + 0.0015, lon: 87.460226 },
  3: { lat: 24.550896 + 0.0015, lon: 87.460226 + 0.0010 },
  4: { lat: 24.550896 - 0.0015, lon: 87.460226 + 0.0010 },
  5: { lat: 24.550896 - 0.0015, lon: 87.460226 },
  6: { lat: 24.550896 - 0.0015, lon: 87.460226 - 0.0010 },
};

// Simulation baseline: the model's own training-data medians, in the exact
// FEATURE_NAMES order, taken from preprocessing_rf.h's kPreprocess[].median
// column. Using the model's real "typical" values instead of made-up
// numbers means the simulator's baseline is grounded in the actual trained
// model, not fabricated from scratch.
const SIM_FEATURE_BASELINE = [
  0.754870157, 0.109746365, -0.00183623265, -0.00242252078, 0.0252062612,
  0.0491453957, 2.25, 20.5625, 0.0935631701, 0.0368537964, 0.0,
  0.00000343436713, 0.727300398, 0.0584980481, 0.000288543629, 0.919588756,
  369.722737, 3.1695394, 2.92597966, 203.755042, 1302.87264, 5.64663119, 0.873984452,
];

const RISK_COLOR = {
  STABLE: "#3DDC97",
  STABILIZING: "#4FD1C5",
  INITIATION: "#F5C542",
  PROGRESSIVE: "#FF9142",
  ACCELERATING: "#FF5252",
  RAPID: "#FF3B3B",
  UNKNOWN: "#5A6B85",
};
