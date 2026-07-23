// Systol — live heart rate over Web Bluetooth.
//
// Same pipeline as the Python/bleak experiments, browser edition:
//   requestDevice (scan+pick) -> connect -> Heart Rate service (0x180D)
//   -> Heart Rate Measurement characteristic (0x2A37) -> notifications.
//
// Organized by CONTAINER, mirroring index.html:
//   1. constants · elements · state
//   2. header           (scroll seam, brand→top, header-height sync,
//                        status pill, connect button)
//   3. dashboard        (hero/zones/heart, target alerts, chart,
//                        time-in-zones, readings table)
//   4. flipbook         (page snapping · footer mini-page · TOC · hints)
//   5. data pipeline    (bluetooth, battery, measurement parsing, ingest)
//   6. settings dialog  (shell/nav · theme · audio · zones · alerts ·
//                        accessibility · session data · about)
//   7. device dialog
//   8. overlays         (signal banner, audio hint, back-to-top, monitor mode)
//   9. demo mode
//   10. boot

"use strict";

/* ==================================================================
   1. CONSTANTS · ELEMENTS · STATE
   ================================================================== */

const APP_VERSION = "1.0.1"; // single source of truth (shown in the device dialog)
const WINDOW_SECONDS = 60;   // visible chart history
const KEEP_SECONDS = 300;    // samples retained for stats/table
const NO_PULSE_BPM = 25;     // below this, a reading is a "no pulse detected"
                             // REPORT from the sensor (devices send 0), not data

// Demo mode is decided by the URL, so it's known before anything renders.
// The body attribute is set here (not with the §9 demo engine) because the
// demo bar it reveals is sticky chrome: setHeaderVar() must be able to measure
// it on the very first pass, or the flipbook sizes its pages against a header
// height that's short by the bar.
const DEMO_MODE = new URLSearchParams(location.search).has("demo");
if (DEMO_MODE) document.body.dataset.demo = ""; // CSS hook: demo bar + "Exit demo" button

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  batteryChip: document.getElementById("batteryChip"),
  batteryPct: document.getElementById("batteryPct"),
  monitorBattery: document.getElementById("monitorBattery"),
  monitorBatteryPct: document.getElementById("monitorBatteryPct"),
  devBatteryRow: document.getElementById("devBatteryRow"),
  devBattery: document.getElementById("devBattery"),
  connectLabel: document.getElementById("connectLabel"),
  bpmBlock: document.getElementById("bpmBlock"),
  zoneLabel: document.getElementById("zoneLabel"),
  zoneAnnounce: document.getElementById("zoneAnnounce"),
  targetBadge: document.getElementById("targetBadge"),
  targetZone: document.getElementById("targetZone"),
  alertSoundToggle: document.getElementById("alertSoundToggle"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  zoneModerate: document.getElementById("zoneModerate"),
  zoneVigorous: document.getElementById("zoneVigorous"),
  zonePeak: document.getElementById("zonePeak"),
  zoneError: document.getElementById("zoneError"),
  zonesReset: document.getElementById("zonesReset"),
  settingsClose: document.getElementById("settingsClose"),
  settingsBack: document.getElementById("settingsBack"),
  settingsTitle: document.getElementById("settingsTitle"),
  connectBtn: document.getElementById("connectBtn"),
  unsupported: document.getElementById("unsupported"),
  signalBanner: document.getElementById("signalBanner"),
  signalBannerText: document.getElementById("signalBannerText"),
  bpm: document.getElementById("bpm"),
  heart: document.getElementById("heart"),
  heartSize: document.getElementById("heartSize"),
  headerBpm: document.getElementById("headerBpm"),
  headerBpmValue: document.getElementById("headerBpmValue"),
  headerHeart: document.getElementById("headerHeart"),
  statMin: document.getElementById("statMin"),
  statAvg: document.getElementById("statAvg"),
  statMax: document.getElementById("statMax"),
  statRR: document.getElementById("statRR"),
  statContact: document.getElementById("statContact"),
  canvas: document.getElementById("chart"),
  tooltip: document.getElementById("tooltip"),
  readingsBody: document.getElementById("readingsBody"),
  zoneTotal: document.getElementById("zoneTotal"),
  zonebarEmpty: document.getElementById("zonebarEmpty"),
  segLight: document.getElementById("segLight"),
  segModerate: document.getElementById("segModerate"),
  segVigorous: document.getElementById("segVigorous"),
  segPeak: document.getElementById("segPeak"),
  tLight: document.getElementById("tLight"),
  tModerate: document.getElementById("tModerate"),
  tVigorous: document.getElementById("tVigorous"),
  tPeak: document.getElementById("tPeak"),
  exportCsv: document.getElementById("exportCsv"),
  exportJson: document.getElementById("exportJson"),
  exportEmpty: document.getElementById("exportEmpty"),
  clearSession: document.getElementById("clearSession"),
  clearSessionQuick: document.getElementById("clearSessionQuick"),
  restoreDefaults: document.getElementById("restoreDefaults"),
  restoreConfirm: document.getElementById("restoreConfirm"),
  restoreInput: document.getElementById("restoreInput"),
  restoreCancel: document.getElementById("restoreCancel"),
  restoreConfirmBtn: document.getElementById("restoreConfirmBtn"),
  monitorBtn: document.getElementById("monitorBtn"),
  monitorExit: document.getElementById("monitorExit"),
  monitorCtls: document.getElementById("monitorCtls"),
  monitorMute: document.getElementById("monitorMute"),
  chartExpand: document.getElementById("chartExpand"),
  deviceBtn: document.getElementById("deviceBtn"),
  deviceDialog: document.getElementById("deviceDialog"),
  deviceBack: document.getElementById("deviceBack"),
  deviceClose: document.getElementById("deviceClose"),
  deviceLogo: document.getElementById("deviceLogo"),
  deviceName: document.getElementById("deviceName"),
  deviceStatusText: document.getElementById("deviceStatusText"),
  deviceConnectBtn: document.getElementById("deviceConnectBtn"),
  deviceConnectLabel: document.getElementById("deviceConnectLabel"),
  deviceInfo: document.getElementById("deviceInfo"),
  devInfoId: document.getElementById("devInfoId"),
  soundToggle: document.getElementById("soundToggle"),
  toneSelect: document.getElementById("toneSelect"),
  audioHint: document.getElementById("audioHint"),
  modeToggle: document.getElementById("modeToggle"),
  footer: document.getElementById("footer"),
  footerThin: document.getElementById("footerThin"),
  toTop: document.getElementById("toTop"),
  snapToggle: document.getElementById("snapToggle"),
  snapNote: document.getElementById("snapNote"),
  snapLockedNote: document.getElementById("snapLockedNote"),
  toc: document.getElementById("toc"),
  readingsTable: document.getElementById("readingsTable"),
  devVersion: document.getElementById("devVersion"),
  settingsVersion: document.getElementById("settingsVersion"),
  footerVersion: document.getElementById("footerVersion"),
};

// One source of truth (APP_VERSION) → every place the version appears:
// device dialog, Settings › About, and the always-visible footer.
els.devVersion.textContent = APP_VERSION;
els.settingsVersion.textContent = APP_VERSION;
els.footerVersion.textContent = ` · v${APP_VERSION}`; // separator lives here so the pre-JS footer stays clean

const state = {
  device: null,
  samples: [],     // { t: ms epoch, bpm, rr: [ms] } — trimmed to KEEP_SECONDS for the chart
  sessionLog: [],  // every reading this session, untrimmed — for export
  hover: null,     // { x, y } in CSS px, when pointer is over the chart
  zoneSeconds: { light: 0, moderate: 0, vigorous: 0, peak: 0 }, // whole-session totals
  lastSampleT: null, // last time ANY reading arrived (drives "signal lost")
  lastPulseT: null,  // last time a PULSED reading arrived (drives heart/beep/"no pulse")
  lastBpm: null,
  lastAnnouncedZone: null, // last zone spoken to screen readers (announce on CHANGE only)
  // Hero stats are SESSION-WIDE (unlike the chart's 5-minute window), so
  // they run as aggregates rather than re-scanning trimmed samples.
  sessionMin: null,
  sessionMax: null,
  sessionSum: 0,
  sessionN: 0,
};

/* ==================================================================
   2. HEADER — scroll seam · brand→top · header-height sync · status pill · connect
   ================================================================== */

// Header is flush with the background; a hairline seam fades in once scrolled.
const headerEl = document.querySelector("header");
window.addEventListener("scroll", () => {
  headerEl.classList.toggle("scrolled", window.scrollY > 4);
}, { passive: true });

// Brand → home. We're already on the home page, so scroll to the top (page 1)
// instead of navigating — a reload would drop a live Bluetooth connection.
// The href="index.html" is only the no-JS fallback.
document.querySelector(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  window.scrollTo({ top: 0 });
});

// Publish the header's REAL height as --header-h, so the CSS that sizes the
// flipbook pages and scroll-margins can never drift from reality — the
// stylesheet's 67px is only a pre-JS fallback. Re-measured on resize (the
// mobile header is static and shorter), and future-proof against header
// content changes (e.g. a live-BPM readout). Guard: in monitor mode the
// header is display:none and measures 0 — skip, the exit resize re-syncs.
function setHeaderVar() {
  if (headerEl.offsetHeight > 0) {
    document.documentElement.style.setProperty("--header-h", `${headerEl.offsetHeight}px`);
  }
}
window.addEventListener("resize", setHeaderVar);
setHeaderVar();

/* --- header · live BPM (desktop) ---
   Mirror the hero's BPM into the header, revealed only once the hero BPM has
   scrolled up behind the sticky header. An IntersectionObserver on the hero
   BPM block (root inset by the header height) tells us when it's off-screen;
   we reveal only when there's also a real reading to show. Value/zone/beat are
   kept in sync from the ingest path (§5) and applyZone/beatAt. Mobile hides
   the element in CSS; monitor mode hides the whole header. */
let heroBpmVisible = true;
function updateHeaderBpm() {
  const hasReading = els.bpm.textContent !== "--";
  els.headerBpm.classList.toggle("show", !heroBpmVisible && hasReading);
}
const heroBpmObserver = new IntersectionObserver(
  (entries) => { heroBpmVisible = entries[0].isIntersecting; updateHeaderBpm(); },
  { rootMargin: `-${headerEl.offsetHeight || 67}px 0px 0px 0px`, threshold: 0 }
);
heroBpmObserver.observe(els.bpmBlock);

// state: "idle" | "connecting" | "live" | "error" — drives the LED color/glow.
function setStatus(text, state = "idle") {
  // No-op when nothing changed. #status is a live region, and reassigning
  // identical text re-announces it to screen readers (demo mode calls this every
  // tick with the same string). Guard on BOTH fields so a state-only change (LED
  // color) still applies. Also spares the per-tick updateDeviceScreen() churn —
  // the device dialog refreshes itself on open regardless. (10.6.2)
  if (text === els.statusText.textContent && state === els.status.dataset.state) return;
  els.statusText.textContent = text;
  els.status.dataset.state = state;
  updateDeviceScreen(); // keep the mobile Device screen + Bluetooth icon in sync
}

// Reflect connection in the button: green "Connect" vs red-outline "Disconnect".
function setConnectButton(connected) {
  els.connectLabel.textContent = connected ? "Disconnect" : "Connect device";
  els.connectBtn.classList.toggle("connected", connected);
}

els.connectBtn.addEventListener("click", () => {
  state.device?.gatt.connected ? disconnect() : connect();
});

/* ==================================================================
   3. DASHBOARD — hero · target alerts · chart · zones bar · table
   ================================================================== */

/* --- dashboard · hero: zones ---
   Zone thresholds are the BPM where each zone STARTS; Light is everything
   below Moderate. Custom values persist in localStorage. */

const ZONE_DEFAULTS = { moderate: 115, vigorous: 135, peak: 160 };

function loadZones() {
  try {
    return { ...ZONE_DEFAULTS, ...JSON.parse(localStorage.getItem("systol-zones") || "{}") };
  } catch {
    return { ...ZONE_DEFAULTS };
  }
}
let zones = loadZones();

function zoneFor(bpm) {
  if (bpm >= zones.peak) return "peak";
  if (bpm >= zones.vigorous) return "vigorous";
  if (bpm >= zones.moderate) return "moderate";
  return "light";
}

function applyZone(bpm) {
  const zone = zoneFor(bpm);
  els.bpmBlock.dataset.zone = zone;
  els.headerBpm.dataset.zone = zone; // header mini-heart color mirror (§2)
  els.zoneLabel.textContent = zone;
  // Screen-reader announcement — on zone CHANGE only. The BPM number itself is
  // not a live region (it would speak a value every second); the zone is the
  // meaningful, low-frequency signal. (10.6.1)
  if (zone !== state.lastAnnouncedZone) {
    state.lastAnnouncedZone = zone;
    els.zoneAnnounce.textContent = `${zone[0].toUpperCase()}${zone.slice(1)} zone`;
  }
  handleTarget(zone);
}

/* --- dashboard · hero: beating heart ---
   Drive the heart from the ACTUAL bpm on two independent channels:
     tempo  — one cardiac cycle = 60 / bpm (the inner beat animation)
     size   — bpm mapped across a fixed absolute range (the outer wrapper)
   Both track bpm, so they always agree (big+fast, small+slow) regardless of
   how the user has set their zone thresholds. Zone only drives color. */

const HR_SIZE = { loBpm: 50, hiBpm: 180, minScale: 0.85, maxScale: 1.5 };

function sizeForBpm(bpm) {
  const t = (bpm - HR_SIZE.loBpm) / (HR_SIZE.hiBpm - HR_SIZE.loBpm);
  const clamped = Math.max(0, Math.min(1, t));
  return HR_SIZE.minScale + clamped * (HR_SIZE.maxScale - HR_SIZE.minScale);
}

function beatAt(bpm) {
  const dur = `${(60 / bpm).toFixed(3)}s`;
  els.heart.style.setProperty("--beat-dur", dur);
  els.heart.classList.add("beating");
  els.heartSize.style.setProperty("--size", sizeForBpm(bpm).toFixed(3));
  // The header's mini heart shares the same tempo (§2 header BPM).
  els.headerHeart.style.setProperty("--beat-dur", dur);
  els.headerHeart.classList.add("beating");
}

// The signal watchdog (§8) freezes the beat when readings go stale — a heart
// that keeps pulsing during signal loss contradicts the banner and the
// (silent) beep. Fresh readings restart it via beatAt above.
function setHeartBeating(on) {
  els.heart.classList.toggle("beating", on);
  els.headerHeart.classList.toggle("beating", on);
}

/* --- dashboard · hero: target-zone alerts (runtime) ---
   Alert on entering and leaving a chosen target zone. Hysteresis: a transition
   must hold for HYSTERESIS_MS before it fires, so hovering on a zone boundary
   doesn't spam alerts. "stable" is the committed state; "pending" is the last
   observed state and when it started. The user-facing controls live in the
   settings dialog's Alerts section (section 6). */

const HYSTERESIS_MS = 2500;
let targetZone = "none";
let alertSoundOn = true;
let targetStable = false;
let targetPending = false;
let targetPendingSince = 0;

function currentInTarget(zone) {
  return targetZone !== "none" && zone === targetZone;
}

function setTargetBadge(on) { els.targetBadge.hidden = !on; }

// Reset the alert baseline to the current state without firing — used when the
// target changes or on load, so selecting the zone you're already in is silent.
function resetTargetBaseline() {
  const latest = state.samples[state.samples.length - 1];
  const inTarget = latest ? currentInTarget(zoneFor(latest.bpm)) : false;
  targetStable = targetPending = inTarget;
  targetPendingSince = Date.now();
  setTargetBadge(inTarget);
}

function handleTarget(zone) {
  const inTarget = currentInTarget(zone);
  const now = Date.now();
  if (inTarget !== targetPending) { targetPending = inTarget; targetPendingSince = now; }
  if (targetPending !== targetStable && now - targetPendingSince >= HYSTERESIS_MS) {
    targetStable = targetPending;
    fireTargetAlert(targetStable);
  }
}

function fireTargetAlert(entered) {
  setTargetBadge(entered);
  els.bpmBlock.classList.remove("alert-enter", "alert-leave");
  void els.bpmBlock.offsetWidth; // restart the flash animation
  els.bpmBlock.classList.add(entered ? "alert-enter" : "alert-leave");
  if (alertSoundOn) { ensureAudio(); chime(entered); }
}

// Two-note chime: rising on enter, falling on leave.
function chime(up) {
  if (!audioCtx || audioCtx.state !== "running") return;
  const notes = up ? [660, 990] : [660, 440];
  notes.forEach((freq, i) => {
    const t = audioCtx.currentTime + i * 0.13;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  });
}

/* --- dashboard · chart --- */

const ctx = els.canvas.getContext("2d");

// The chart's colors come from CSS custom properties (theme + accent), which
// only change when the user switches theme or accent. Reading them via
// getComputedStyle is a relatively costly style lookup, so we read once and
// cache here — refreshed from applyTheme() — instead of paying it on every one
// of the ~60 draw frames per second (draw + hover previously called it twice).
const chartColors = {};
function refreshChartColors() {
  const s = getComputedStyle(document.documentElement);
  chartColors.grid = s.getPropertyValue("--grid").trim();
  chartColors.gridStrong = s.getPropertyValue("--grid-strong").trim();
  chartColors.ink = s.getPropertyValue("--ink").trim();
  chartColors.mutedInk = s.getPropertyValue("--ink-muted").trim();
  chartColors.zone = {
    light: s.getPropertyValue("--zone-light").trim(),
    moderate: s.getPropertyValue("--zone-moderate").trim(),
    vigorous: s.getPropertyValue("--zone-vigorous").trim(),
    peak: s.getPropertyValue("--zone-peak").trim(),
  };
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = els.canvas;
  els.canvas.width = w * dpr;
  els.canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const PAD = { left: 44, right: 14, top: 14, bottom: 26 };

function yBounds(samples) {
  if (!samples.length) return { lo: 40, hi: 140 };
  let lo = Math.min(...samples.map((s) => s.bpm));
  let hi = Math.max(...samples.map((s) => s.bpm));
  lo = Math.floor((lo - 8) / 10) * 10;
  hi = Math.ceil((hi + 8) / 10) * 10;
  if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = mid - 20; hi = mid + 20; }
  return { lo, hi };
}

function draw() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  const now = Date.now();
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;

  ctx.clearRect(0, 0, w, h);

  const visible = state.samples.filter((s) => s.t >= now - (WINDOW_SECONDS + 2) * 1000);
  const { lo, hi } = yBounds(visible.filter((s) => s.t >= now - WINDOW_SECONDS * 1000));

  const xOf = (t) => PAD.left + plotW * (1 - (now - t) / (WINDOW_SECONDS * 1000));
  const yOf = (bpm) => PAD.top + plotH * (1 - (bpm - lo) / (hi - lo));

  // Grid — recessive: thin, low-contrast, behind the data.
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.lineWidth = 1;
  const gridColor = chartColors.grid;
  const mutedInk = chartColors.mutedInk;
  const zoneColor = chartColors.zone;
  // Bands from bottom to top: [zone name, lower bpm, upper bpm].
  const bands = [
    ["light", lo, zones.moderate],
    ["moderate", zones.moderate, zones.vigorous],
    ["vigorous", zones.vigorous, zones.peak],
    ["peak", zones.peak, hi],
  ];

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = mutedInk;
  for (let bpm = lo; bpm <= hi; bpm += 20) {
    const y = yOf(bpm);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(w - PAD.right, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(String(bpm), PAD.left - 8, y);
  }
  // Vertical lines every 10 s, anchored to absolute time so they scroll.
  const firstTick = Math.ceil((now - WINDOW_SECONDS * 1000) / 10000) * 10000;
  for (let t = firstTick; t <= now; t += 10000) {
    const x = xOf(t);
    if (x < PAD.left) continue;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, h - PAD.bottom);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const ago = Math.round((now - t) / 1000);
    ctx.fillText(ago === 0 ? "now" : `-${ago}s`, x, h - PAD.bottom + 6);
  }

  // Dashed zone-threshold lines, each in its zone's color, labelled at the
  // right edge. Only drawn where the threshold falls within the visible range.
  ctx.setLineDash([5, 5]);
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  for (const [name, start] of [["moderate", zones.moderate], ["vigorous", zones.vigorous], ["peak", zones.peak]]) {
    if (start <= lo || start >= hi) continue;
    const y = yOf(start);
    ctx.strokeStyle = zoneColor[name];
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(w - PAD.right, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = zoneColor[name];
    ctx.fillText(name.toUpperCase(), PAD.left + 4, y - 3);
  }
  ctx.setLineDash([]);

  // Trace — 2px line, but recolored by zone: draw the whole polyline once per
  // band, clipped to that band's horizontal slice, so each part wears the color
  // of the zone it sits in.
  if (visible.length > 1) {
    const tracePath = () => {
      ctx.beginPath();
      visible.forEach((s, i) => {
        const x = xOf(s.t), y = yOf(s.bpm);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    for (const [name, bandLo, bandHi] of bands) {
      const yTop = yOf(Math.min(bandHi, hi));
      const yBot = yOf(Math.max(bandLo, lo));
      if (yBot - yTop < 0.5) continue; // band not visible
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, yTop, plotW, yBot - yTop); // clip to this band
      ctx.clip();
      ctx.strokeStyle = zoneColor[name];
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.shadowColor = zoneColor[name];
      ctx.shadowBlur = 6;
      tracePath();
      ctx.restore();
    }

    // Leading dot on the newest sample, colored by its zone.
    const last = visible[visible.length - 1];
    ctx.fillStyle = zoneColor[zoneFor(last.bpm)];
    ctx.beginPath();
    ctx.arc(xOf(last.t), yOf(last.bpm), 4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = mutedInk;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("connect a device to start the trace", w / 2, h / 2);
  }

  drawHover(visible, xOf, yOf, h);
  requestAnimationFrame(draw);
}

// Crosshair + tooltip on the nearest sample to the pointer.
function drawHover(visible, xOf, yOf, h) {
  if (!state.hover || !visible.length) { els.tooltip.hidden = true; return; }

  let nearest = null, best = Infinity;
  for (const s of visible) {
    const d = Math.abs(xOf(s.t) - state.hover.x);
    if (d < best) { best = d; nearest = s; }
  }
  if (!nearest || best > 40) { els.tooltip.hidden = true; return; }

  const x = xOf(nearest.t), y = yOf(nearest.bpm);
  ctx.strokeStyle = chartColors.gridStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, PAD.top);
  ctx.lineTo(x, h - PAD.bottom);
  ctx.stroke();
  ctx.fillStyle = chartColors.ink;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();

  els.tooltip.innerHTML =
    `${nearest.bpm} BPM <span class="t-muted">· ${new Date(nearest.t).toLocaleTimeString()}</span>`;
  els.tooltip.hidden = false;
  const wrap = els.canvas.parentElement.getBoundingClientRect();
  const tw = els.tooltip.offsetWidth;
  els.tooltip.style.left = `${Math.min(Math.max(x - tw / 2, 6), wrap.width - tw - 6)}px`;
  els.tooltip.style.top = `${Math.max(y - 40, 6)}px`;
}

els.canvas.addEventListener("pointermove", (e) => {
  const r = els.canvas.getBoundingClientRect();
  state.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
});
els.canvas.addEventListener("pointerleave", () => { state.hover = null; });

/* --- dashboard · time in zones ---
   Accumulate real seconds spent in each zone across the whole session. On each
   new sample, credit the elapsed gap to the zone we were in during that gap
   (the previous sample's zone). Gaps > 5 s are dropped as disconnections. */

function fmtDuration(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function accumulateZoneTime(t, bpm) {
  // Anchored to the last PULSED reading: no-pulse reports neither earn zone
  // time nor let a later recovery credit the silent gap to a stale zone.
  if (state.lastPulseT != null) {
    const dt = (t - state.lastPulseT) / 1000;
    if (dt > 0 && dt < 5) state.zoneSeconds[zoneFor(state.lastBpm)] += dt;
  }
  state.lastPulseT = t;
  state.lastBpm = bpm;
  renderZoneBar();
}

function renderZoneBar() {
  const z = state.zoneSeconds;
  const total = z.light + z.moderate + z.vigorous + z.peak;
  els.zoneTotal.textContent = fmtDuration(total);
  els.zonebarEmpty.hidden = total > 0;
  for (const name of ["light", "moderate", "vigorous", "peak"]) {
    const pct = total > 0 ? (z[name] / total) * 100 : 0;
    els[`seg${name[0].toUpperCase()}${name.slice(1)}`].style.width = `${pct}%`;
    els[`t${name[0].toUpperCase()}${name.slice(1)}`].textContent = fmtDuration(z[name]);
  }
  const hasData = state.sessionLog.length > 0;
  els.exportCsv.disabled = !hasData;
  els.exportJson.disabled = !hasData;
  els.exportEmpty.hidden = hasData;
  els.clearSession.disabled = !hasData;
  els.clearSessionQuick.disabled = !hasData;
}

/* --- dashboard · readings table --- */

// Default state follows placement (CSS §4 does the docking): expanded when
// docked in the right gutter on wide screens, collapsed in vertical flow.
// Crossing the boundary resets to that mode's default.
const tableGutterMQ = window.matchMedia("(min-width: 1460px)");
function syncTableState() { els.readingsTable.open = tableGutterMQ.matches; }
tableGutterMQ.addEventListener("change", syncTableState);
syncTableState();

function updateTable() {
  // From the raw session log (not the plotted samples): no-pulse reports are
  // real received data and belong in the record, even though they're never
  // plotted or zoned.
  const recent = state.sessionLog.slice(-20).reverse();
  els.readingsBody.innerHTML = recent
    .map((s) => {
      const time = new Date(s.t).toLocaleTimeString();
      const rr = s.rr.length ? s.rr.join(", ") : "--";
      return `<tr><td>${time}</td><td>${s.bpm}</td><td>${rr}</td></tr>`;
    })
    .join("");
}

/* ==================================================================
   4. FLIPBOOK — symmetric page snapping · footer mini-page · TOC · hints
   ================================================================== */

/* --- flipbook · snapping --- */

// Gentle "25%" snapping between the flipbook pages, re-implemented in JS
// because native CSS proximity snapping hard-codes its distance (1/3 of the
// viewport in Chromium) and can't express the symmetric boundary rule below.
// No wheel hijacking: it only ever acts on `scrollend`, after the user's
// scroll has already come to rest.
//
// SYMMETRIC boundary rule: a boundary is a page's top edge — wherever the
// previous page's content ENDS, so it tracks content growth (an expanded
// readings table just moves the boundary down). Positions are measured in
// the usable band between the sticky header's bottom edge and the viewport
// bottom. When a scroll rests with a boundary…
//   in the top quarter of the band    → pull it to the TOP (just below the
//                                       header; the next page fills the view)
//   in the bottom quarter of the band → push it to the BOTTOM (the previous
//                                       page's last screenful, ending flush)
//   anywhere between                  → free rest, no snap
//
// Snapping is OFF when: the screen is too small for pages to behave like
// screens (width ≤ 560px — the mobile layout — or height < 620px), the OS
// asks for reduced motion (until the user explicitly opts back in via the
// settings toggle, which stores "systol-snap"), or monitor mode is active.

const SNAP_THR = 0.25;
// NOTE: these breakpoints mirror the CSS gates — canonical list + complement
// rules are in the "BREAKPOINT GATES" block in style.css §1. Change a gate
// there AND here together (grep 560px / 619px). The compound below is the
// complement of the flipbook's `(min-width: 561px) and (min-height: 620px)`.
const snapTooSmall = window.matchMedia("(max-width: 560px), (max-height: 619px)");
const snapReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// The user's snapping PREFERENCE: their stored choice if they've ever touched
// the settings toggle, else the OS default (reduce motion → off). The toggle
// UI (settings · accessibility, section 6) reads and writes the same key.
function snapPrefWanted() {
  const stored = localStorage.getItem("systol-snap"); // "1" | "0" | null
  return stored === null ? !snapReducedMotion.matches : stored === "1";
}

function snapEnabled() {
  return snapPrefWanted() && !snapTooSmall.matches && !document.body.classList.contains("monitor");
}

// Footer mini-page state: which of its two rests the view last committed to.
let footerAtEnd = false;

document.addEventListener("scrollend", () => {
  // Scrolling while snapping is off invalidates the footer mini-page's
  // direction memory — without this, disable-at-the-footer → scroll away →
  // re-enable would replay a stale "I was at the end" on the first flip.
  if (!snapEnabled()) { footerAtEnd = false; return; }
  const headerH = headerEl.offsetHeight;
  const band = window.innerHeight - headerH; // the visible area under the header
  const pages = [...document.querySelectorAll(".page")];
  const atRest = (d) => Math.abs(d) <= 1;
  let target = null, bestD = Infinity;

  // Footer mini-page: the region below the thin-row rest (footer's first
  // line at the fold) flips as one small page. Direction-aware so neither
  // state is a trap: from the thin rest, ~40px of downward intent commits
  // to the full footer (document end); from the end, ~40px upward glides
  // back to thin. Everything stays reachable by plain scrolling regardless.
  const restThin = els.footer.offsetTop + els.footerThin.offsetHeight - window.innerHeight;
  const restEnd = document.documentElement.scrollHeight - window.innerHeight;
  if (window.scrollY > restThin + 1 && restEnd > restThin) {
    const commit = Math.min(40, (restEnd - restThin) / 3);
    const goal = footerAtEnd
      ? (restEnd - window.scrollY > commit ? restThin : restEnd)
      : (window.scrollY - restThin > commit ? restEnd : restThin);
    footerAtEnd = goal === restEnd;
    if (Math.abs(window.scrollY - goal) > 1) window.scrollTo({ top: goal, behavior: "smooth" });
    return;
  }
  footerAtEnd = false;

  for (let i = 0; i < pages.length; i++) {
    const v = pages[i].offsetTop - window.scrollY; // boundary's viewport position
    // Distance to this page's TOP rest. The FIRST page rests at the true
    // document top (scroll 0) — tucking it "below the header" like the
    // others would strand the view a few px down and pin the header seam.
    const dTop = i === 0 ? window.scrollY : v - headerH;
    const topRest = i === 0 ? 0 : pages[i].offsetTop - headerH;
    // Distance to this page's BOTTOM rest (boundary flush with the viewport
    // bottom = the previous page's last screenful). Invalid above scroll 0.
    const dBot = window.innerHeight - v;
    const botRest = pages[i].offsetTop - window.innerHeight;

    // Already resting at a legitimate stop → leave the user alone. Without
    // this, rests that sit within one snap zone of each other (the document
    // top and "page 1's last screenful", say) would drag a second hop.
    if (atRest(dTop) || (botRest > 0 && atRest(dBot))) return;

    // One-sided triggers, per the approved boundary rule; when two rests
    // compete, the closest one wins.
    if (dTop > 1 && dTop < band * SNAP_THR && dTop < bestD) {
      bestD = dTop;
      target = topRest;
    }
    if (botRest > 0 && dBot > 1 && dBot < band * SNAP_THR && dBot < bestD) {
      bestD = dBot;
      target = botRest;
    }
  }
  if (target !== null) window.scrollTo({ top: target, behavior: "smooth" });
});

/* --- flipbook · footer mini-page: thin-row height ---
   CSS shortens the last page by the thin row's height (--footer-thin-h) so
   the row sits exactly at the fold at the last page's rest; measure the
   real rendered height (the row can wrap at narrower widths) so CSS and
   layout can't drift apart. Stable: the row's height depends only on
   width, so writing the var can't feed back into it. */
function setFooterThinVar() {
  document.documentElement.style.setProperty("--footer-thin-h", `${els.footerThin.offsetHeight}px`);
}
window.addEventListener("resize", setFooterThinVar);
setFooterThinVar();

// Crossfade state between the footer's two forms: revealed once the view
// has committed past the thin line (24px of grace so the thin rest itself
// stays collapsed). Driven by raw scroll position, NOT snapEnabled(), so
// the full footer still appears for plain scrolling when snapping is off.
function updateFooterReveal() {
  const past = window.innerHeight + window.scrollY >=
    els.footer.offsetTop + els.footerThin.offsetHeight + 24;
  els.footer.classList.toggle("revealed", past);
}
window.addEventListener("scroll", updateFooterReveal, { passive: true });
window.addEventListener("resize", updateFooterReveal);
updateFooterReveal();

/* --- flipbook · left-gutter TOC ---
   Fixed page navigation: top-aligned with the hero, right edge hugging the
   content column (both measured, so it follows the layout on resize).
   Clicks are plain anchor links — scroll-margin-top lands them below the
   sticky header, and CSS scroll-behavior makes them glide unless the OS
   asks for reduced motion. The active entry is whichever page covers the
   MIDPOINT of the band below the header: midpoint, not intersection
   ratios, so pages taller than one screen still highlight correctly. */

function placeToc() {
  const r = document.querySelector(".hero").getBoundingClientRect();
  els.toc.style.left = `${Math.max(12, r.left - els.toc.offsetWidth - 26)}px`;
  els.toc.style.top = `${r.top + window.scrollY}px`;
}

const tocLinks = els.toc.querySelectorAll("a");

function updateTocActive() {
  const headerH = headerEl.offsetHeight;
  const mid = window.scrollY + headerH + (window.innerHeight - headerH) / 2;
  let active = "dashboard";
  for (const pg of document.querySelectorAll(".page")) {
    if (pg.offsetTop <= mid) active = pg.id;
  }
  tocLinks.forEach((a) => a.classList.toggle("active", a.dataset.page === active));
}

window.addEventListener("resize", () => { placeToc(); updateTocActive(); });
window.addEventListener("scroll", updateTocActive, { passive: true });
placeToc();
updateTocActive();

/* --- flipbook · scroll-down hints ---
   Each page except the last carries a .scroll-hint anchor at its bottom
   edge. Targets are wired here from the live page sequence — insert or
   reorder pages in the HTML and the hints follow; a hint on the final
   page (authoring slip) hides itself. */
{
  const pages = [...document.querySelectorAll(".page")];
  pages.forEach((pg, i) => {
    const hint = pg.querySelector(".scroll-hint");
    if (!hint) return;
    const next = pages[i + 1];
    if (!next) { hint.hidden = true; return; }
    hint.href = `#${next.id}`;
    const label = els.toc.querySelector(`[data-page="${next.id}"]`)?.textContent || "the next page";
    hint.setAttribute("aria-label", `Continue to ${label}`);
  });
}

/* ==================================================================
   5. DATA PIPELINE — bluetooth · battery · parsing · ingest
   ================================================================== */

// Web Bluetooth throws DOMExceptions whose messages are often long and
// technical (e.g. "GATT operation failed for unknown reason"). Map the known
// error names to short, human status-pill text; the raw error still goes to
// the console for debugging. NotFoundError (user closed the picker) is handled
// separately as a non-error.
const BLE_ERRORS = {
  SecurityError: "Bluetooth blocked by the browser",
  NetworkError: "Connection failed: device off or out of range",
  NotSupportedError: "No heart-rate service on this device",
  NotAllowedError: "Bluetooth permission denied",
  InvalidStateError: "Turn on Bluetooth and try again",
};
function bleErrorText(err) {
  return BLE_ERRORS[err.name] || "Couldn't connect, try again";
}

async function connect() {
  try {
    if (soundOn || alertSoundOn) ensureAudio(); // resume restored sound prefs on this gesture
    setStatus("Choose a device…", "connecting");
    // The browser shows a picker of nearby devices advertising 0x180D;
    // the page only ever learns about the one the user selects.
    state.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ["heart_rate"] }],
      optionalServices: ["battery_service"], // needed to read battery, if the device has it
    });
    state.device.addEventListener("gattserverdisconnected", onDisconnected);

    setStatus(`Connecting to ${state.device.name || "device"}…`, "connecting");
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService("heart_rate");
    const characteristic = await service.getCharacteristic("heart_rate_measurement");
    characteristic.addEventListener("characteristicvaluechanged", onMeasurement);
    await characteristic.startNotifications();

    setStatus(state.device.name || "Connected device", "live");
    setConnectButton(true);
    expectingData = true; // arm the signal-lost watchdog
    watchBattery(server); // defensive: only shows if the device exposes 0x180F
  } catch (err) {
    if (err.name === "NotFoundError") { // user closed the picker (or no devices)
      setStatus("Not connected", "idle");
    } else {
      console.warn("Systol: connection error", err); // keep the raw detail for debugging
      setStatus(bleErrorText(err), "error");         // …but show something human
    }
    state.device = null;
    setConnectButton(false);
  }
}

function disconnect() {
  expectingData = false; // a deliberate disconnect is not a "signal lost" event
  updateSignalBanner();  // clear the banner immediately if it was showing
  if (state.device?.gatt.connected) state.device.gatt.disconnect();
}

function onDisconnected() {
  state.device = null;
  setStatus("Disconnected", "error");
  setConnectButton(false);
  hideBattery();
}

// Battery is optional in BLE. Try the standard Battery Service (0x180F); if the
// device doesn't expose it (e.g. Fitbit), the indicator just stays hidden.
async function watchBattery(server) {
  try {
    const svc = await server.getPrimaryService("battery_service");
    const ch = await svc.getCharacteristic("battery_level");
    setBattery((await ch.readValue()).getUint8(0));
    ch.addEventListener("characteristicvaluechanged", (e) => setBattery(e.target.value.getUint8(0)));
    await ch.startNotifications();
  } catch {
    hideBattery();
  }
}
function setBattery(pct) {
  els.batteryPct.textContent = `${pct}%`;
  els.monitorBatteryPct.textContent = `${pct}%`;
  els.devBattery.textContent = `${pct}%`;
  els.batteryChip.hidden = false;
  els.monitorBattery.hidden = false;
  els.devBatteryRow.hidden = false;
  const low = pct <= 15;
  els.batteryChip.classList.toggle("low", low);
  els.monitorBattery.classList.toggle("low", low);
}
function hideBattery() {
  els.batteryChip.hidden = true;
  els.monitorBattery.hidden = true;
  els.devBatteryRow.hidden = true;
}

// Heart Rate Measurement (0x2A37) per the Bluetooth spec: a flags byte,
// then fields whose presence and size the flags announce.
function parseMeasurement(dv) {
  const flags = dv.getUint8(0);
  let offset = 1;
  let bpm;
  if (flags & 0x01) { bpm = dv.getUint16(offset, true); offset += 2; } // uint16 HR
  else { bpm = dv.getUint8(offset); offset += 1; }                     // uint8 HR

  const contactSupported = Boolean(flags & 0x04);
  const contact = contactSupported ? Boolean(flags & 0x02) : null;

  if (flags & 0x08) offset += 2; // energy expended (skip)

  const rr = [];
  if (flags & 0x10) {
    for (; offset + 1 < dv.byteLength; offset += 2) {
      // RR values arrive in units of 1/1024 s; convert to ms.
      rr.push(Math.round((dv.getUint16(offset, true) / 1024) * 1000));
    }
  }
  return { bpm, contact, rr };
}

function onMeasurement(event) {
  const { bpm, contact, rr } = parseMeasurement(event.target.value);
  ingestReading(bpm, contact, rr);
}

// Shared ingest path for both real notifications and the demo generator, so
// the demo exercises the exact same code the device drives.
function ingestReading(bpm, contact, rr) {
  const t = Date.now();
  state.lastSampleT = t;                 // ANY reading = the signal is alive
  state.sessionLog.push({ t, bpm, rr }); // …and everything real gets logged
  els.statContact.textContent = contact === null ? "--" : contact ? "yes" : "no";

  // Sub-threshold readings (devices send 0) mean "the sensor can't find a
  // pulse" — a REPORT, not a measurement: dry electrodes, loose strap,
  // off-body… indistinguishable from worse, so it is presented exactly like
  // signal loss (§8): logged in the table/export, but never plotted, never
  // zoned, never counted in stats, never beeped. The display holds the last
  // real reading; after the shared 5s grace the heart freezes, the beep
  // silences, and the notice pill says "no pulse detected" instead.
  if (bpm >= NO_PULSE_BPM) {
    state.samples.push({ t, bpm, rr });
    const cutoff = t - KEEP_SECONDS * 1000;
    while (state.samples.length && state.samples[0].t < cutoff) state.samples.shift();

    els.bpm.textContent = bpm;
    els.bpm.classList.remove("empty");
    els.headerBpmValue.textContent = bpm; // header mirror (§2)
    updateHeaderBpm();
    applyZone(bpm);
    beatAt(bpm);
    accumulateZoneTime(t, bpm);

    state.sessionMin = state.sessionMin === null ? bpm : Math.min(state.sessionMin, bpm);
    state.sessionMax = state.sessionMax === null ? bpm : Math.max(state.sessionMax, bpm);
    state.sessionSum += bpm;
    state.sessionN += 1;
    els.statMin.textContent = state.sessionMin;
    els.statMax.textContent = state.sessionMax;
    els.statAvg.textContent = Math.round(state.sessionSum / state.sessionN);
    els.statRR.textContent = rr.length ? `${rr[rr.length - 1]} ms` : "--";
  }

  updateTable();
  updateSignalBanner(); // pulse/staleness state may have changed either way
}

/* ==================================================================
   6. SETTINGS DIALOG — shell/nav · theme · audio · zones · alerts · accessibility · data · about
   ================================================================== */

/* --- settings · shell & section navigation ---
   Desktop: sidebar + content, one section shown at a time.
   Mobile: a drill-down — a category list (data-view="list") that opens one
   section's detail (data-view="detail") with the section name as the title. */

const navItems = els.settingsDialog.querySelectorAll(".nav-item");
const settingsSections = els.settingsDialog.querySelectorAll(".settings-section");
const isMobile = () => window.matchMedia("(max-width: 560px)").matches; // 560 gate — see style.css §1 GATES

function showSection(name) {
  let label = "Settings";
  navItems.forEach((b) => {
    const on = b.dataset.section === name;
    b.classList.toggle("active", on);
    if (on) { b.setAttribute("aria-current", "true"); label = b.textContent; }
    else b.removeAttribute("aria-current");
  });
  settingsSections.forEach((s) => { s.hidden = s.dataset.section !== name; });
  if (isMobile()) {
    els.settingsDialog.dataset.view = "detail";
    els.settingsTitle.textContent = label;
  }
}

function showSettingsList() { // mobile: back to the category list
  els.settingsDialog.dataset.view = "list";
  els.settingsTitle.textContent = "Settings";
}

navItems.forEach((b) => b.addEventListener("click", () => showSection(b.dataset.section)));

// A modal opened with showModal doesn't stop the page behind it from
// scrolling, so lock the page while any dialog is open.
function lockPageScroll(on) {
  document.documentElement.style.overflow = on ? "hidden" : "";
}

function openSettings() {
  if (soundOn || alertSoundOn) ensureAudio(); // resume audio on this gesture if any sound is on
  fillZoneInputs();
  zoneInputsValid();
  updateAlertUI();
  updateSnapUI();
  closeRestoreConfirm(); // reset the type-to-confirm box
  if (isMobile()) {
    showSettingsList();  // mobile: start at the category list
  } else {
    els.settingsDialog.dataset.view = "detail";
    showSection("theme"); // desktop: sidebar + first section
  }
  lockPageScroll(true);
  els.settingsDialog.showModal();
}
els.settingsBtn.addEventListener("click", openSettings);
els.settingsDialog.addEventListener("close", () => lockPageScroll(false));

// Back arrow (mobile): from a detail → the list; from the list → close.
els.settingsBack.addEventListener("click", () => {
  if (els.settingsDialog.dataset.view === "detail" && isMobile()) showSettingsList();
  else els.settingsDialog.close();
});

// Backdrop click / X / Done all just dismiss — nothing to save, since the
// panel is instant-apply. Only clicks targeting the <dialog> element itself
// can be backdrop clicks; without that guard, a click on a nav item that
// shrinks the dialog (e.g. Session data → Theme) re-centers it mid-event,
// the old coordinates land outside the new rect, and the dialog closes.
els.settingsDialog.addEventListener("click", (e) => {
  if (e.target !== els.settingsDialog) return;
  const r = els.settingsDialog.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) els.settingsDialog.close();
});
els.settingsClose.addEventListener("click", () => els.settingsDialog.close());

/* --- settings · theme ---
   Dark/light mode + accent preset, applied via data-attributes on <html> that
   swap CSS custom properties. The chart reads those vars each frame, so it
   re-colors automatically. Zone colors stay semantic across accents. */

let themeMode = "dark";
let accent = "green";
const accentSwatches = els.settingsDialog.querySelectorAll(".swatch");

function applyTheme() {
  const root = document.documentElement;
  root.dataset.theme = themeMode;   // "dark" | "light" (CSS swaps the moon/sun icon)
  root.dataset.accent = accent;     // "green" | "blue" | "amber"
  accentSwatches.forEach((s) => s.classList.toggle("selected", s.dataset.accent === accent));
  refreshChartColors();             // re-cache the canvas colors for the new theme/accent
}

els.modeToggle.addEventListener("click", () => {
  themeMode = themeMode === "light" ? "dark" : "light";
  localStorage.setItem("systol-theme", themeMode);
  applyTheme();
});

accentSwatches.forEach((s) => s.addEventListener("click", () => {
  accent = s.dataset.accent;
  localStorage.setItem("systol-accent", accent);
  applyTheme();
}));

themeMode = localStorage.getItem("systol-theme") === "light" ? "light" : "dark";
accent = ["blue", "amber"].includes(localStorage.getItem("systol-accent")) ? localStorage.getItem("systol-accent") : "green";
applyTheme();

/* --- settings · audio: beep per beat ---
   A short tick scheduled at the real beat interval (60000 / bpm), so it tracks
   the actual heart rate. Web Audio needs a user gesture to start, so the
   AudioContext is created/resumed on the toggle click. */

let audioCtx = null;
let soundOn = false;
let beatTimer = null;

// Tone presets: each is an oscillator blip with an attack → hold → release
// envelope (seconds). "monitor" holds a flat sustain to evoke the classic
// pure hospital-monitor beep timbre; "soft" has no hold (a quick tick).
const TONES = {
  soft:    { type: "sine",     freq: 1000, attack: 0.004, hold: 0.00, release: 0.06, gain: 0.16 },
  monitor: { type: "sine",     freq: 1000, attack: 0.004, hold: 0.10, release: 0.05, gain: 0.17 },
  pulse:   { type: "triangle", freq: 420,  attack: 0.006, hold: 0.03, release: 0.13, gain: 0.22 },
};
let tone = "soft";

function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // resume() is async, and the browser can suspend us again later — so the
      // hint follows the context's real state rather than guessing.
      audioCtx.addEventListener("statechange", updateAudioHint);
    } catch { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

function tick() {
  if (!audioCtx || audioCtx.state !== "running") return; // stay silent until a gesture resumes it
  const p = TONES[tone] || TONES.soft;
  const hold = p.hold || 0;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = p.type;
  osc.frequency.value = p.freq;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(p.gain, t + p.attack);      // attack
  if (hold > 0) gain.gain.setValueAtTime(p.gain, t + p.attack + hold); // flat sustain
  gain.gain.exponentialRampToValueAtTime(0.0001, t + p.attack + hold + p.release); // release
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + p.attack + hold + p.release + 0.02);
}

// Self-rescheduling: each tick books the next one at the current bpm, so the
// cadence follows the heart rate live. Silent (but keeps polling) when no data.
function scheduleBeat() {
  clearTimeout(beatTimer);
  if (!soundOn) return;
  // Liveness follows the last PULSED reading, so a stream of 0-BPM "no
  // pulse" reports goes silent on the same 5s grace as signal loss — the
  // beep must never imply a heartbeat the sensor can't find.
  const live = state.lastPulseT != null && Date.now() - state.lastPulseT < 5000;
  if (live) tick();
  const bpm = live ? (state.lastBpm || 60) : 60;
  beatTimer = setTimeout(scheduleBeat, 60000 / bpm);
}

function setSound(on) {
  soundOn = on;
  els.soundToggle.setAttribute("aria-checked", String(on));
  els.monitorMute.setAttribute("aria-pressed", String(on)); // keep the monitor-mode button in sync
  els.toneSelect.disabled = !on; // greys the tone row when beep is off
  localStorage.setItem("systol-sound", on ? "1" : "0");
  if (on) { ensureAudio(); scheduleBeat(); }
  else clearTimeout(beatTimer);
  updateAudioHint();
}

els.soundToggle.addEventListener("click", () => setSound(!soundOn));
els.monitorMute.addEventListener("click", () => setSound(!soundOn)); // quick toggle in fullscreen

// Tone picker: persist and play a one-shot preview so the choice is audible.
els.toneSelect.addEventListener("change", () => {
  tone = els.toneSelect.value;
  localStorage.setItem("systol-tone", tone);
  ensureAudio();
  tick();
});

tone = localStorage.getItem("systol-tone") || "soft"; // restore tone
els.toneSelect.value = tone;
setSound(localStorage.getItem("systol-sound") === "1"); // restore beep preference

/* --- settings · heart-rate zones ---
   Instant-apply zones: thresholds must strictly increase. Valid input is
   applied and persisted immediately; invalid input shows the inline error and
   simply isn't applied (the field reverts to the saved value on blur). */

function fillZoneInputs() {
  els.zoneModerate.value = zones.moderate;
  els.zoneVigorous.value = zones.vigorous;
  els.zonePeak.value = zones.peak;
}

function zoneInputsValid() {
  const m = Number(els.zoneModerate.value);
  const v = Number(els.zoneVigorous.value);
  const p = Number(els.zonePeak.value);
  // Per-field bounds via the inputs' OWN min/max (single source of truth) —
  // native constraint validation catches typed values the min/max attributes
  // don't block on their own (e.g. 500), plus empty and non-numeric. stepMismatch
  // is excluded on purpose, so decimals still pass; this only adds the bounds.
  const outOfRange = (el) =>
    el.validity.rangeUnderflow || el.validity.rangeOverflow ||
    el.validity.valueMissing || el.validity.badInput;
  const mRange = outOfRange(els.zoneModerate);
  const vRange = outOfRange(els.zoneVigorous);
  const pRange = outOfRange(els.zonePeak);
  const vOrder = !(v > m); // cross-field: strictly increasing
  const pOrder = !(p > v);
  els.zoneModerate.classList.toggle("invalid", mRange);
  els.zoneVigorous.classList.toggle("invalid", vRange || vOrder);
  els.zonePeak.classList.toggle("invalid", pRange || pOrder);
  const rangeBad = mRange || vRange || pRange;
  const ok = !rangeBad && !vOrder && !pOrder;
  // Message matches the actual failure (a bounds slip isn't an ordering slip).
  els.zoneError.textContent = rangeBad
    ? "Each zone must be between 40 and 230 BPM."
    : "Values must increase: Moderate < Vigorous < Peak.";
  els.zoneError.hidden = ok;
  return ok;
}

function applyZonesFromInputs() {
  if (!zoneInputsValid()) return; // invalid: keep last saved zones
  zones = {
    moderate: Number(els.zoneModerate.value),
    vigorous: Number(els.zoneVigorous.value),
    peak: Number(els.zonePeak.value),
  };
  localStorage.setItem("systol-zones", JSON.stringify(zones));
  const latest = state.samples[state.samples.length - 1];
  if (latest) applyZone(latest.bpm); // recolor immediately under new ranges
}

for (const input of [els.zoneModerate, els.zoneVigorous, els.zonePeak]) {
  input.addEventListener("input", applyZonesFromInputs);
  input.addEventListener("blur", () => {
    if (!zoneInputsValid()) { fillZoneInputs(); zoneInputsValid(); } // discard invalid edit
  });
}

els.zonesReset.addEventListener("click", () => {
  els.zoneModerate.value = ZONE_DEFAULTS.moderate;
  els.zoneVigorous.value = ZONE_DEFAULTS.vigorous;
  els.zonePeak.value = ZONE_DEFAULTS.peak;
  applyZonesFromInputs();
});

/* --- settings · alerts (controls for the section-3 runtime) --- */

function updateAlertUI() {
  els.targetZone.value = targetZone;
  els.alertSoundToggle.setAttribute("aria-checked", String(alertSoundOn));
  const disabled = targetZone === "none"; // no target → alerts do nothing
  els.alertSoundToggle.disabled = disabled;
  els.alertSoundToggle.closest(".alert-sound-row").classList.toggle("dim", disabled);
}

els.targetZone.addEventListener("change", () => {
  targetZone = els.targetZone.value;
  localStorage.setItem("systol-target", targetZone);
  if (alertSoundOn && targetZone !== "none") ensureAudio();
  updateAlertUI();
  updateAudioHint();     // a target zone can newly arm (or disarm) the chime
  resetTargetBaseline(); // adopt current state silently
});

els.alertSoundToggle.addEventListener("click", () => {
  if (els.alertSoundToggle.disabled) return;
  alertSoundOn = !alertSoundOn;
  localStorage.setItem("systol-alertsound", alertSoundOn ? "1" : "0");
  if (alertSoundOn) ensureAudio();
  updateAlertUI();
  updateAudioHint();
});

targetZone = localStorage.getItem("systol-target") || "none";
alertSoundOn = localStorage.getItem("systol-alertsound") !== "0"; // default on
updateAlertUI();
resetTargetBaseline();

/* --- settings · accessibility ---
   Page snapping toggle for the flipbook (section 4). The switch shows the
   effective PREFERENCE — the stored choice, or the OS reduce-motion default
   when the user has never touched it. Flipping it persists an explicit
   choice, which wins over the OS default from then on. snapEnabled() reads
   the same key live on every scroll-end, so changes apply instantly.
   When the screen is below the size gate (phones, short windows, heavy
   zoom) the switch is disabled + dimmed with an amber notice instead of
   pretending to work — and it unlocks live if the window grows. */

function updateSnapUI() {
  const locked = snapTooSmall.matches;
  // Show the EFFECTIVE state: while size-locked the switch reads "off"
  // (snapping truly isn't happening), whatever the stored preference —
  // which is preserved and springs back once the window grows.
  els.snapToggle.setAttribute("aria-checked", String(!locked && snapPrefWanted()));
  els.snapToggle.disabled = locked;
  els.snapToggle.closest(".snap-row").classList.toggle("dim", locked);
  els.snapNote.hidden = locked;
  els.snapLockedNote.hidden = !locked;
}

els.snapToggle.addEventListener("click", () => {
  if (els.snapToggle.disabled) return;
  localStorage.setItem("systol-snap", snapPrefWanted() ? "0" : "1");
  updateSnapUI();
});

// Until the user makes an explicit choice, the default tracks the OS
// setting live — flipping reduce-motion mid-session updates the switch.
// The size lock tracks window size the same way.
snapReducedMotion.addEventListener("change", updateSnapUI);
snapTooSmall.addEventListener("change", updateSnapUI);

updateSnapUI();

/* --- settings · session data: export ---
   Downloads happen entirely in the browser via a Blob object URL — the data
   never touches a network, consistent with the app's privacy guarantee. */

function triggerDownload(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sessionFilename(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `systol-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

function exportCsv() {
  const rows = [["iso_time", "epoch_ms", "bpm", "rr_intervals_ms"]];
  for (const s of state.sessionLog) {
    rows.push([new Date(s.t).toISOString(), s.t, s.bpm, s.rr.join(" ")]);
  }
  // Provenance as a leading # comment line (skipped by pandas/R and most
  // tools; harmless extra top row in a spreadsheet) — keeps the tabular data
  // itself clean while stamping which app version produced the file.
  const header = `# Systol ${APP_VERSION} · exported ${new Date().toISOString()}\n`;
  const csv = header + rows.map((r) => r.join(",")).join("\n");
  triggerDownload(sessionFilename("csv"), csv, "text/csv");
}

function exportJson() {
  const data = {
    app: "Systol",
    appVersion: APP_VERSION, // which build produced this file
    exportedAt: new Date().toISOString(),
    device: state.device?.name ?? (new URLSearchParams(location.search).has("demo") ? "demo" : null),
    zoneThresholds: zones,
    zoneSeconds: state.zoneSeconds,
    readings: state.sessionLog.map((s) => ({
      time: new Date(s.t).toISOString(),
      epochMs: s.t,
      bpm: s.bpm,
      rrMs: s.rr,
    })),
  };
  triggerDownload(sessionFilename("json"), JSON.stringify(data, null, 2), "application/json");
}

els.exportCsv.addEventListener("click", exportCsv);
els.exportJson.addEventListener("click", exportJson);

/* --- settings · session data: clear / restore defaults --- */

// Clear session (single click): wipe this session's readings but keep the
// connection and saved settings. Not confirmed — readings are re-recordable.
function clearSession() {
  state.samples = [];
  state.sessionLog = [];
  state.zoneSeconds = { light: 0, moderate: 0, vigorous: 0, peak: 0 };
  state.lastSampleT = null;
  state.lastPulseT = null;
  state.lastBpm = null;
  state.sessionMin = null;
  state.sessionMax = null;
  state.sessionSum = 0;
  state.sessionN = 0;

  els.bpm.textContent = "--";
  els.bpm.classList.add("empty");
  els.bpmBlock.dataset.zone = "";
  els.zoneLabel.textContent = "";
  state.lastAnnouncedZone = null; // next real reading re-announces its zone
  els.zoneAnnounce.textContent = "";
  els.heart.classList.remove("beating");
  els.headerBpmValue.textContent = "--"; // header mirror (§2)
  els.headerBpm.dataset.zone = "";
  els.headerHeart.classList.remove("beating");
  updateHeaderBpm(); // "--" reading → hides the header BPM
  for (const id of ["statMin", "statAvg", "statMax", "statRR", "statContact"]) els[id].textContent = "--";

  renderZoneBar();       // zone bar → empty; export + clear disable themselves
  updateTable();         // table → empty
  resetTargetBaseline(); // target badge off
}
els.clearSession.addEventListener("click", clearSession);
els.clearSessionQuick.addEventListener("click", clearSession); // dashboard shortcut

// Restore defaults (type "Delete" to confirm): a full reset — clear our saved
// data and reload, which drops the device and returns everything to first-run.
function closeRestoreConfirm() {
  els.restoreConfirm.hidden = true;
  els.restoreDefaults.hidden = false;
  els.restoreInput.value = "";
  els.restoreConfirmBtn.disabled = true;
}
els.restoreDefaults.addEventListener("click", () => {
  els.restoreConfirm.hidden = false;
  els.restoreDefaults.hidden = true;
  els.restoreInput.value = "";
  els.restoreConfirmBtn.disabled = true;
  els.restoreInput.focus();
});
els.restoreInput.addEventListener("input", () => {
  els.restoreConfirmBtn.disabled = els.restoreInput.value.trim().toLowerCase() !== "delete";
});
els.restoreCancel.addEventListener("click", closeRestoreConfirm);
els.restoreConfirmBtn.addEventListener("click", () => {
  Object.keys(localStorage).filter((k) => k.startsWith("systol-")).forEach((k) => localStorage.removeItem(k));
  location.reload();
});

/* ==================================================================
   7. DEVICE DIALOG — device screen, opened from status pill / BT icon
   ================================================================== */

// The Bluetooth icon (mobile) opens a screen showing the device, its status,
// and the Connect/Disconnect button (which lives here on mobile instead of the
// header). Its contents mirror the header status, kept in sync by setStatus.

const DEVICE_STATUS_LABEL = {
  idle: "Not connected",
  connecting: "Connecting…",
  live: "Connected",
  error: "Disconnected",
};

function updateDeviceScreen() {
  const st = els.status.dataset.state; // idle | connecting | live | error
  const connected = st === "live";
  const name = state.device?.name || (DEMO_MODE && connected ? "Demo device" : null);
  els.deviceName.textContent = connected ? (name || "Connected device") : "No device";
  els.deviceStatusText.textContent = DEVICE_STATUS_LABEL[st] || "Not connected";
  els.deviceStatusText.dataset.state = st;
  els.deviceLogo.dataset.state = st;
  els.deviceBtn.dataset.state = st;
  els.deviceConnectLabel.textContent = connected ? "Disconnect" : "Connect device";
  els.deviceConnectBtn.classList.toggle("connected", connected);

  // Show device details only when connected. device.id is Web Bluetooth's
  // opaque, per-site identifier (the spec hides the real MAC for privacy).
  els.deviceInfo.hidden = !connected;
  if (connected) els.devInfoId.textContent = state.device?.id || (DEMO_MODE ? "demo-0001-fitbit" : "--");
}

function openDeviceScreen() {
  updateDeviceScreen();
  lockPageScroll(true);
  els.deviceDialog.showModal();
}
els.deviceBtn.addEventListener("click", openDeviceScreen);           // mobile Bluetooth icon
els.status.addEventListener("click", openDeviceScreen);             // desktop status pill
els.status.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDeviceScreen(); }
});
els.deviceBack.addEventListener("click", () => els.deviceDialog.close());
els.deviceClose.addEventListener("click", () => els.deviceDialog.close());
els.deviceDialog.addEventListener("close", () => lockPageScroll(false));
els.deviceDialog.addEventListener("click", (e) => { // backdrop click closes (desktop)
  if (e.target !== els.deviceDialog) return; // content clicks can never be backdrop clicks
  const r = els.deviceDialog.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) els.deviceDialog.close();
});
els.deviceConnectBtn.addEventListener("click", () => {
  state.device?.gatt.connected ? disconnect() : connect();
});

/* ==================================================================
   8. OVERLAYS — signal banner · audio hint · back-to-top · monitor mode
   ================================================================== */

/* --- overlays · signal-lost banner ---
   When readings stop unexpectedly — device disconnected, battery died, out of
   range, or sensor off-body — show a plain on-screen notice. It states only
   what the app can actually know ("no readings"), never a conclusion about the
   wearer, and plays no sound by design: a false "flatline" on a consumer app
   must never imply someone's heart has stopped. `expectingData` is true only
   between a successful connect (or demo start) and a user-initiated
   disconnect, so deliberately disconnecting never raises the banner. */

const SIGNAL_LOST_MS = 5000; // no reading for this long, while expecting data
let expectingData = false;

function updateSignalBanner() {
  const now = Date.now();
  const signalStale = state.lastSampleT != null && now - state.lastSampleT >= SIGNAL_LOST_MS;
  const pulseFresh = state.lastPulseT != null && now - state.lastPulseT < SIGNAL_LOST_MS;
  // Two flavors of the same unknown, one 5s grace clock, one pill:
  //   signal lost — readings stopped arriving entirely
  //   no pulse    — readings arrive but the sensor reports no pulse (0 BPM)
  const noPulse = !signalStale && state.lastSampleT != null && !pulseFresh;
  els.signalBanner.hidden = !(expectingData && (signalStale || noPulse));
  els.signalBannerText.textContent = signalStale
    ? "Signal lost: no readings from your device"
    : "No pulse detected: check the sensor's fit and skin contact";
  // Every "beating right now" indicator follows the SAME clock: the beep
  // goes silent (scheduleBeat's live check, §6) and the hero heart freezes
  // here — on ANY pulse staleness, deliberate disconnects included, since a
  // pulsing heart without pulse data misleads either way. INTENDED: both
  // states are presented silently — never a flatline tone — because absence
  // of DATA (or of a DETECTED pulse) is not absence of a heartbeat
  // (strap off, out of range, dead battery, dry electrodes).
  setHeartBeating(pulseFresh);
}
setInterval(updateSignalBanner, 1000);

/* --- overlays · audio hint ---
   Browsers only let audio start after a user gesture. The hint shows when a
   preference would ACTUALLY make sound (beep on, or alert sound with a target
   set) but the AudioContext isn't running — and hides the moment it is. It's
   driven by the context's real state, not a one-time check at load: browsers
   sometimes permit audio immediately (sticky activation), and a gesture doesn't
   always succeed at resuming it. Nothing shows on a default (silent) visit. */

function wantsSound() {
  return soundOn || (alertSoundOn && targetZone !== "none");
}

function updateAudioHint() {
  els.audioHint.hidden = !(wantsSound() && audioCtx?.state !== "running");
}

// Retry on any gesture, but stay inert (and create no AudioContext) while no
// sound preference is armed — a silent visit never touches Web Audio.
const resumeAudioOnGesture = () => {
  if (!wantsSound()) return;
  ensureAudio();
  updateAudioHint();
};
window.addEventListener("pointerdown", resumeAudioOnGesture);
window.addEventListener("keydown", resumeAudioOnGesture);

if (wantsSound()) ensureAudio(); // browser may already permit it; statechange tells us
updateAudioHint();

/* --- overlays · back-to-top chevron ---
   Fades in once the page is meaningfully scrolled; click glides home —
   scrollTo without an explicit behavior obeys the CSS scroll-behavior, so
   it's smooth normally and instant under reduced motion. Landing at the
   true top is a snap rest, so the engine leaves it alone. */

window.addEventListener("scroll", () => {
  els.toTop.classList.toggle("show", window.scrollY > 300);
}, { passive: true });
els.toTop.addEventListener("click", () => window.scrollTo({ top: 0 }));

/* --- overlays · monitor mode ---
   Fullscreen + a body class that restyles to a glanceable dashboard. Esc (the
   browser's fullscreen exit) or the floating button both leave. */

// Monitor mode collapses the document to one screen, which clamps scroll to
// 0 — so remember the reading position on the way in and restore it on the
// way out (instant, not smooth: it's state restoration, not navigation).
let monitorReturnScroll = 0;

function setMonitor(on) {
  const was = document.body.classList.contains("monitor");
  if (on && !was) monitorReturnScroll = window.scrollY;
  document.body.classList.toggle("monitor", on);
  els.monitorCtls.hidden = !on;
  setWakeLock(on);
  if (!on && was) window.scrollTo({ top: monitorReturnScroll, behavior: "instant" });
  // Layout changed size; re-fit the canvas backing store on the next frame.
  requestAnimationFrame(resizeCanvas);
}

// Keep the screen awake in monitor mode — like video playback. Held ONLY
// while monitor mode is on: streaming data alone never holds it (a live
// stream can't be paused, so it would pin the screen forever). Best-effort:
// unsupported browsers or a denial (battery saver, insecure context) just
// mean normal sleep rules apply.
let wakeLock = null;
async function setWakeLock(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      const lock = await navigator.wakeLock.request("screen");
      if (!document.body.classList.contains("monitor")) { // mode ended mid-request
        await lock.release();
        return;
      }
      wakeLock = lock;
      wakeLock.addEventListener("release", () => { wakeLock = null; }); // OS can release it anytime
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch { /* best-effort by design */ }
}

// The OS auto-releases the lock whenever the tab is hidden; re-acquire on
// return if monitor mode is still active.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.body.classList.contains("monitor")) {
    setWakeLock(true);
  }
});

function toggleMonitor() {
  // Key off the MONITOR state, not fullscreenElement: in the class-only
  // fallback (fullscreen denied — iframe embed, kiosk policy) they diverge,
  // and keying off fullscreen made Exit re-request fullscreen instead of
  // exiting, trapping the user (10.11.1).
  if (document.body.classList.contains("monitor")) {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else setMonitor(false); // fallback: no fullscreen to exit — just unstyle
    return;
  }
  const req = document.documentElement.requestFullscreen?.();
  if (req && typeof req.then === "function") {
    req.catch(() => setMonitor(true)); // fullscreen blocked → still restyle
  } else if (!req) {
    setMonitor(true); // no Fullscreen API → class-only fallback
  }
}

// Keep the class in sync with the actual fullscreen state (covers Esc).
document.addEventListener("fullscreenchange", () => {
  setMonitor(Boolean(document.fullscreenElement));
});

// Esc must also leave monitor in the class-only fallback, where there's no
// browser fullscreen-Esc to cover it — keeps the FAQ's "leave with Esc"
// promise true everywhere (10.11.1).
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("monitor") && !document.fullscreenElement) {
    setMonitor(false);
  }
});

els.monitorBtn.addEventListener("click", toggleMonitor);
els.monitorExit.addEventListener("click", toggleMonitor);
els.chartExpand.addEventListener("click", toggleMonitor); // mobile chart expand

/* ==================================================================
   9. DEMO MODE (?demo) — scripted scenario through the real pipeline
   ================================================================== */

// A scripted scenario that cycles through every state so the UI can be tested
// without a device: rest → warm-up → cardio → peak → cool-down → signal-lost,
// then repeats. Each phase yields a target bpm (or null to simulate the device
// going silent — the flatline / not-worn case). Enable with ?demo; lock to one
// phase with ?demo=<name> (e.g. ?demo=peak, ?demo=flatline) for focused tests.

const lerp = (a, b, p) => a + (b - a) * Math.max(0, Math.min(1, p));
const jitter = (n) => (Math.random() - 0.5) * 2 * n;

const DEMO_PHASES = [
  { name: "rest",        secs: 8,  bpm: () => 60 + jitter(3) },                                  // Light
  { name: "warm-up",     secs: 12, bpm: (p) => lerp(62, 122, p) + jitter(2) },                   // Light→Moderate
  { name: "cardio",      secs: 12, bpm: (p) => 138 + Math.sin(p * Math.PI * 3) * 10 + jitter(2) },// Vigorous
  { name: "peak",        secs: 10, bpm: (p) => lerp(150, 174, Math.min(1, p * 2)) + jitter(2) },  // Peak
  { name: "cool-down",   secs: 14, bpm: (p) => lerp(174, 66, p) + jitter(2) },                    // →Light
  { name: "signal-lost", secs: 10, bpm: () => null },                                             // device silent
];

// Battery is a *separate* BLE characteristic from heart rate (Battery Service
// 0x180F, not the HR stream), so the demo drives it independently. It steps
// through representative widths and extremes — triple / double / single digit
// down to 0% — and the values <=15% also exercise the red "low" state. Pin one
// value with ?battery=<n> (e.g. ?demo&battery=5) for a focused screenshot.
const DEMO_BATTERY = [100, 76, 42, 9, 4, 0];

const demoParam = new URLSearchParams(location.search).get("demo");
if (demoParam !== null) {
  // Connecting a real sensor mid-demo would be a data-integrity bug, not a
  // feature: the demo's interval and the GATT notifications both call
  // ingestReading(), so scripted and real beats interleave into one chart,
  // one set of stats, one zone tally, and one export. Lock both entry points
  // (header + device dialog) and say why — the demo is a closed system.
  const DEMO_CONNECT_HINT = "Exit demo mode to connect a device";
  [els.connectBtn, els.deviceConnectBtn].forEach((btn) => {
    btn.disabled = true;
    btn.title = DEMO_CONNECT_HINT;
  });

  // ?demo=flatline is an alias for the signal-lost phase. A locked phase just
  // repeats on its own (cycling through its full range).
  // ?demo=nopulse is locked-only (not part of the cycle): the sensor stays
  // connected and keeps REPORTING, but finds no pulse (0 BPM) — a strap on
  // a table. Exercises the "no pulse detected" state end to end.
  // ?demo=nocontact is locked-only too: a real BPM but contact=false and no
  // RR intervals — a wrist optical sensor lifted off the skin. Exercises the
  // "contact: no" stat and the missing-RR paths (stat "--", table "--").
  const locked =
      demoParam === "nopulse" ? { name: "no-pulse", secs: 10, bpm: () => 0 }
    : demoParam === "nocontact" ? { name: "no-contact", secs: 10, bpm: () => 90 + jitter(6), noContact: true }
    : DEMO_PHASES.find((ph) => ph.name === (demoParam === "flatline" ? "signal-lost" : demoParam));
  const timeline = locked ? [locked] : DEMO_PHASES;
  const totalSecs = timeline.reduce((s, ph) => s + ph.secs, 0);
  const batteryRaw = new URLSearchParams(location.search).get("battery");
  const pinnedBattery = batteryRaw === null ? null : Number(batteryRaw);
  expectingData = true; // demo drives the same signal-lost watchdog as a device
  let elapsed = 0;

  setInterval(() => {
    // Locate the current phase and progress within it.
    let tsec = elapsed % totalSecs;
    let phase = timeline[0];
    for (const ph of timeline) {
      if (tsec < ph.secs) { phase = ph; break; }
      tsec -= ph.secs;
    }
    const raw = phase.bpm(tsec / phase.secs);

    if (raw === null) {
      setStatus("Demo: signal lost", "error"); // no data: red LED, chart goes stale
    } else if (raw === 0) {
      ingestReading(0, true, []); // sensor reporting, no pulse found (§5 handles it)
      setStatus("Demo: no pulse", "live");
    } else {
      const bpm = Math.round(Math.max(35, Math.min(210, raw)));
      // Chest straps report RR + contact; a lifted optical sensor reports
      // neither (phase.noContact) — exercises the "no"/"--"/"--" paths.
      const rr = phase.noContact ? [] : [Math.round(60000 / bpm + jitter(20))];
      ingestReading(bpm, !phase.noContact, rr);
      setStatus(`Demo: ${phase.name}`, "live");
    }

    // Battery: hold a pinned value, else step through the sample list every 6s.
    setBattery(pinnedBattery !== null
      ? pinnedBattery
      : DEMO_BATTERY[Math.floor(elapsed / 6) % DEMO_BATTERY.length]);

    elapsed += 1;
  }, 1000);
}

/* ==================================================================
   10. BOOT
   ================================================================== */

if (!navigator.bluetooth) {
  // In demo mode the warning is redundant — the user is already running the
  // thing it would send them to, and stacking a red "unsupported" notice under
  // the green "you're in demo" one reads as a fault. The demo banner stands
  // alone; the button and status still reflect the real capability.
  if (!DEMO_MODE) {
    els.unsupported.hidden = false;
    document.querySelector(".device-note-unsupported").hidden = false;
    placeToc(); // the banner above the dashboard just shifted the hero down
  }
  // BOTH entry points: the device dialog is the connect surface on mobile, so
  // leaving its button live here would offer a picker the browser can't open.
  const UNSUPPORTED_HINT = "This browser doesn't support Web Bluetooth";
  [els.connectBtn, els.deviceConnectBtn].forEach((btn) => {
    btn.disabled = true;
    // Demo already set a title, and its "exit demo" advice is the actionable
    // one — don't overwrite it with the browser caveat the demo made moot.
    if (!DEMO_MODE) btn.title = UNSUPPORTED_HINT;
  });
  setStatus("Web Bluetooth unavailable", "error");
}

// Installed-app contexts (PWA/TWA/WebView → display-mode: standalone) get
// native-app parity: no pinch zoom (the meta IS honored there, including
// iOS home-screen apps). The web version — mobile browsers included —
// keeps normal zoom: web users expect it, and restricting it there is
// both hostile and (on iOS Safari) ignored anyway. CSS pairs with this
// via the display-mode touch-action rule (§2).
if (window.matchMedia("(display-mode: standalone)").matches) {
  document.querySelector('meta[name="viewport"]').content =
    "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no";
}

requestAnimationFrame(draw);

/* ==================================================================
   11. COMPATIBLE-DEVICES LOGO ROWS (page 4)
   ==================================================================
   Each row stays STATIC and centered while its icons fit the available
   width; it only becomes a marquee when they don't (the "everything
   fits, so don't scroll it" rule). Adding .is-scrolling reveals the
   .dupe copies that make the loop seamless — while static they're
   hidden, so no logo is ever visibly repeated. The duration is derived
   from the measured content width, so the drift speed is identical at
   every viewport instead of stretching with the track. */

(() => {
  const marquees = document.querySelectorAll("#compatible .marquee");
  if (!marquees.length) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const SPEED = 55; // px/sec

  function update(marquee) {
    const track = marquee.querySelector(".marquee-track");
    if (!track) return;
    if (reduce.matches) return marquee.classList.remove("is-scrolling");

    marquee.classList.remove("is-scrolling"); // always measure in the static state
    const cs = getComputedStyle(track);
    const gap = parseFloat(cs.columnGap || cs.gap) || 0;
    const items = track.querySelectorAll(":scope > :not(.dupe)");

    let width = 0;
    items.forEach((el) => (width += el.getBoundingClientRect().width));
    if (items.length > 1) width += gap * (items.length - 1);

    if (width > marquee.clientWidth + 1) { // doesn't fit → scroll it
      marquee.style.setProperty("--mq-dur", `${(width + gap) / SPEED}s`);
      marquee.classList.add("is-scrolling");
    }
  }

  let raf;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => marquees.forEach(update));
  };

  // Logos are SVGs: measure again once each has real intrinsic width.
  marquees.forEach((m) =>
    m.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", schedule, { once: true });
    })
  );
  window.addEventListener("resize", schedule);
  reduce.addEventListener("change", schedule);
  // A theme swap shows the other badge set, which has different widths.
  new MutationObserver(schedule).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  schedule();
})();
