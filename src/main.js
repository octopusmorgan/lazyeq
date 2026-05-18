/**
 * lazyEq - Sine Sweep Speaker EQ Analyzer
 * Professional frequency response measurement using logarithmic sine sweep
 */

import { SineSweepSource } from "./sineSweep.js";
import { SpectrumAnalyzer } from "./analyzer.js";
import { SAMPLE_RATE, FFT_SIZE, MEASUREMENT_INTERVAL_MS, CALIBRATION_TIMEOUT_MS, USE_SMART_CORRECTION, ACTIVE_EQ_FREQS } from "./constants.js";
import {
  exportWavelet,
  exportEqMac,
  generateVisualizationData,
  EQMAC_BANDS,
  getHarmanTargetDB,
} from "./eqGenerator.js";
import { saveProfile, loadProfile, float32ToArray } from "./persistence.js";
import { CalibrationOrchestrator } from './CalibrationOrchestrator.js';
import { hexToRgba, renderSpectrum, renderEQCurve, adaptiveSmooth } from './rendering.js';
import { LegacySweepOrchestrator } from './LegacySweepOrchestrator.js';

let analyzer = null;
let animationFrame = null;
let sweepDuration = 8;
let selectedMicDeviceId = null;
let sweepProcessing = false;
let sweepProcessTimeout = null;

/** @type {CalibrationOrchestrator|null} */
let orchestrator = null;
let cachedTargetCurve = null; // Pre-computed target curve for live canvas
let liveSpectrum = null; // Legacy sweep result spectrum, passed to showResults

// DOM Elements — Active elements present in index.html
const btnExportWavelet = document.getElementById("btn-export-wavelet");
const btnExportEqMac = document.getElementById("btn-export-eqmac");
const btnRefreshDevices = document.getElementById("btn-refresh-devices");
const statusExport = document.getElementById("status-export");
const statusDevices = document.getElementById("status-devices");
const micSelect = document.getElementById("mic-select");
const canvasSpectrum = document.getElementById("canvas-spectrum");
const canvasEstimated = document.getElementById("canvas-estimated");
const canvasEq = document.getElementById("canvas-eq");
const canvasLive = document.getElementById("canvas-live");

// Live calibration DOM elements
const btnCalibrate = document.getElementById("btn-calibrate");
const btnStopCalibration = document.getElementById("btn-stop-calibration");
const statusCalibration = document.getElementById("status-calibration");
const calibrationDelta = document.getElementById("calibration-delta");
const resultsSection = document.getElementById("results-section");

// Legacy sweep (Advanced section) DOM elements
const btnLegacySweep = document.getElementById("btn-legacy-sweep");
const sweepCountAdvanced = document.getElementById("sweep-count-advanced");
const statusLegacySweep = document.getElementById("status-legacy-sweep");
const canvasLiveLegacy = document.getElementById("canvas-live-legacy");

// Backward-compat aliases for legacy flow still present in main.js
const btnNoise = null;
const btnSweep = null;
const btnStop = null;
const statusNoise = statusCalibration;
const statusSweep = statusCalibration;
const statusNoiseEl = statusCalibration;
const statusSweepEl = statusCalibration;
const sweepCountSelectEl = sweepCountAdvanced;
const cardResults = resultsSection;

let resultsReady = false;

// Hide results section until first measurement completes
if (resultsSection) resultsSection.classList.add("hidden");

// ─────────────────────────────────────────────────────────────────────

let audioContext = null;

function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE
    });
  }
  return audioContext;
}

async function ensureAudioContext() {
  const ctx = initAudioContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (e) {
      console.error("Failed to resume:", e);
    }
  }
  return ctx;
}

// Device enumeration
async function loadDevices() {
  // Check if MediaDevices API is available (requires HTTPS or localhost)
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    statusDevices.textContent = "Error: MediaDevices API not available (requires HTTPS)";
    statusDevices.className = "status danger";
    console.error("MediaDevices API not available");
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === "audioinput");

    micSelect.innerHTML = "";

    if (audioInputs.length === 0) {
      micSelect.innerHTML = '<option value="">No microphones found</option>';
      return;
    }

    let phoneMicFound = false;

    audioInputs.forEach((device, index) => {
      const label = device.label || `Microphone ${index + 1}`;
      const option = document.createElement("option");
      option.value = device.deviceId;

      const lowerLabel = label.toLowerCase();
      if (!lowerLabel.includes("bluetooth") && !lowerLabel.includes("speaker") && !lowerLabel.includes("buds")) {
        option.textContent = "📱 " + label + " (Recommended)";
        if (!phoneMicFound) {
          option.selected = true;
          selectedMicDeviceId = device.deviceId;
          phoneMicFound = true;
        }
      } else {
        option.textContent = "🔗 " + label + " (Avoid)";
      }

      micSelect.appendChild(option);
    });

    if (!phoneMicFound && audioInputs.length > 0) {
      micSelect.selectedIndex = 0;
      selectedMicDeviceId = audioInputs[0].deviceId;
    }

    statusDevices.textContent = `Found ${audioInputs.length} microphone(s)`;
    statusDevices.className = "status done";

  } catch (err) {
    console.error("Error loading devices:", err);
    statusDevices.textContent = "Error: " + err.message;
    statusDevices.className = "status danger";
  }
}

// Auto-load devices at startup (enumerateDevices doesn't require permission).
// Labels may be generic until the user grants mic access, but the devices
// are immediately selectable. Refresh button handles new hot-plugged devices.

// Refresh button
btnRefreshDevices.addEventListener("click", async () => {
  statusDevices.textContent = "Refreshing...";
  statusDevices.className = "status";
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  } catch (e) {}
  await loadDevices();
});

// Update selected mic when changed
micSelect.addEventListener("change", () => {
  selectedMicDeviceId = micSelect.value;
  if (import.meta.env.DEV) {
    console.log("Selected mic:", micSelect.options[micSelect.selectedIndex].text);
  }
});

// ─── Analyzer Initialization ─────────────────────────────────────────

// initAnalyzer removed — was passing ephemeral deviceId before permission grant.
// Use the getUserMedia→analyzer.init(stream, ctx) pattern instead (see calibrate & legacy sweep handlers).


// Populate EQ table
function populateEQTable(visData, gains) {
  const table = document.getElementById("eq-table");
  if (!table) return;

  const tbody = table.querySelector("tbody") || document.createElement("tbody");
  tbody.innerHTML = "";

  if (!visData || !gains || visData.length === 0) {
    tbody.innerHTML = "<tr><td colspan='3'>No data</td></tr>";
    return;
  }

  function getGainAtFreq(targetFreq) {
    if (visData.length === 0) return { gain: 0, response: 0 };
    if (visData.length === 1) return { gain: gains[0], response: visData[0].y };

    for (let i = 0; i < visData.length - 1; i++) {
      const f1 = visData[i].x;
      const f2 = visData[i + 1].x;

      if (targetFreq <= f1) {
        return { gain: gains[i], response: visData[i].y };
      }
      if (targetFreq >= f2) continue;
      if (targetFreq >= f1 && targetFreq <= f2) {
        const ratio = (targetFreq - f1) / (f2 - f1);
        return {
          gain: gains[i] + (gains[i + 1] - gains[i]) * ratio,
          response: visData[i].y + (visData[i + 1].y - visData[i].y) * ratio
        };
      }
    }
    return { gain: gains[gains.length - 1], response: visData[visData.length - 1].y };
  }

  for (const freq of EQMAC_BANDS) {
    const { gain, response } = getGainAtFreq(freq);
    const gainNum = Number(gain);
    const respNum = Number(response);

    const freqLabel = freq >= 1000 ? (freq / 1000) + "k" : freq + "Hz";
    const gainColor = gainNum > 0 ? "#5cfc8a" : gainNum < 0 ? "#fc5c5c" : "#6a6a7a";
    const gainLabel = (!isNaN(gainNum) && isFinite(gainNum))
      ? (gainNum > 0 ? "+" + gainNum.toFixed(1) : gainNum.toFixed(1))
      : "0.0";
    const respLabel = (!isNaN(respNum) && isFinite(respNum)) ? respNum.toFixed(1) : "-";

    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${freqLabel}</td>
      <td>${respLabel} dB</td>
      <td style="color: ${gainColor}">${gainLabel} dB</td>
    `;
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  [canvasSpectrum, canvasEstimated, canvasEq, canvasLive].forEach((canvas) => {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const nextW = Math.floor(cssW * dpr);
    const nextH = Math.floor(cssH * dpr);
    // Avoid clearing canvas when size didn't change
    if (canvas.width === nextW && canvas.height === nextH) return;
    canvas.width = nextW;
    canvas.height = nextH;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Legacy sweep workflow removed — now using live calibration only
// ─────────────────────────────────────────────────────────────────────

// Calibration target in dB at frequency `freq`.
// Keep this in sync with the curve shown on the live canvas to avoid visual drift.
function getCalibrationTargetDB(freq) {
  return getHarmanTargetDB(Math.max(20, Math.min(20000, freq)));
}

// Shared processing for measurement results (used by live pink-noise path)
// @param {Float32Array} spectrum - Frequency spectrum data
// @param {Object} options - { method, gainLimits, smoothingFactor, effectiveRange, perBandMaxGain, perBandMaxCut }
// @returns {Object} Processed result with visualization data and gain proposal
function _processMeasurementResults(spectrum, options = {}) {
  const gainLimits = options.gainLimits || { maxGain: 8, maxCut: -12, bassMax: 4 };
  const smoothingFactor = options.smoothingFactor || 1.0;
  const perBandMaxGain = options.perBandMaxGain || null;
  const perBandMaxCut = options.perBandMaxCut || null;

  const { maxGain, maxCut, bassMax } = gainLimits;
  const effectiveRange = options.effectiveRange || { low: 0, high: Infinity };
  const linearFreqLabels = analyzer.getLinearFrequencyLabels();
  const visData = generateVisualizationData(spectrum, linearFreqLabels);

  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });

  const NOISE_FLOOR_DB = -120;
  for (let i = 0; i < responseArr.length; i++) {
    if (!isFinite(responseArr[i])) {
      responseArr[i] = NOISE_FLOOR_DB;
      visData[i].y = NOISE_FLOOR_DB;
    }
  }

  const smoothedResponse = adaptiveSmooth(responseArr, smoothingFactor);

  let sumRange = 0, countRange = 0;
  for (let i = 0; i < smoothedResponse.length; i++) {
    const freq = visData[i].x;
    if (freq >= effectiveRange.low && freq <= effectiveRange.high && smoothedResponse[i] > -90 && isFinite(smoothedResponse[i])) {
      sumRange += smoothedResponse[i];
      countRange++;
    }
  }
  const rangeAvg = countRange > 0 ? sumRange / countRange : NaN;

  const normalizedResponse = new Float32Array(smoothedResponse.length);
  if (Number.isFinite(rangeAvg)) {
    for (let i = 0; i < smoothedResponse.length; i++) {
      normalizedResponse[i] = smoothedResponse[i] - rangeAvg;
    }
  } else {
    normalizedResponse.set(smoothedResponse);
  }

  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const freq = visData[i].x;
    const targetOffset = getCalibrationTargetDB(freq);
    rawGains[i] = targetOffset - normalizedResponse[i];
  }

  const gains = Array.from(rawGains).map((g, i) => {
    const freq = visData[i].x;
    let gain = g;

    let bandMaxGain = maxGain;
    let bandMaxCut = maxCut;
    if (perBandMaxGain && perBandMaxCut) {
      let nearestBand = 0;
      let minDist = Infinity;
      for (let b = 0; b < ACTIVE_EQ_FREQS.length; b++) {
        const dist = Math.abs(Math.log10(freq) - Math.log10(ACTIVE_EQ_FREQS[b]));
        if (dist < minDist) {
          minDist = dist;
          nearestBand = b;
        }
      }
      if (minDist < 0.3) {
        bandMaxGain = perBandMaxGain[nearestBand];
        bandMaxCut = perBandMaxCut[nearestBand];
      }
    }

    if (freq < 100) {
      gain = Math.min(gain, bassMax);
    }
    gain = Math.max(bandMaxCut, Math.min(bandMaxGain, gain));

    if (freq < effectiveRange.low) {
      const fadeFreq = effectiveRange.low / 2;
      if (freq <= fadeFreq) {
        gain *= 0;
      } else {
        const ratio = Math.log2(freq / fadeFreq);
        gain *= ratio;
      }
    } else if (freq > effectiveRange.high) {
      const fadeFreq = effectiveRange.high * 2;
      if (freq >= fadeFreq) {
        gain *= 0;
      } else {
        const ratio = 1 - Math.log2(freq / effectiveRange.high);
        gain *= ratio;
      }
    }

    return gain;
  });

  return { visData, normalizedResponse, gains, rangeAvg };
}

// ─── Live Pink Noise Calibration Flow ─────────────────────────────────

/**
 * Pre-compute the target curve for the live canvas (cached, drawn once per frame).
 */
function computeTargetCurveCache() {
  if (cachedTargetCurve) return cachedTargetCurve;

  // Build a synthetic "target spectrum" — Harman target values mapped to FFT bins
  const binCount = FFT_SIZE / 2;
  const binWidth = analyzer.audioContext.sampleRate / analyzer.analyserNode.fftSize;
  const targetSpectrum = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const freq = i * binWidth;
    targetSpectrum[i] = getHarmanTargetDB(Math.max(20, Math.min(20000, freq)));
  }

  const labels = analyzer.getLinearFrequencyLabels();
  cachedTargetCurve = generateVisualizationData(targetSpectrum, labels);
  return cachedTargetCurve;
}

function showResults(result, options = {}) {
  const { visData, gains } = result;

  // Show results section FIRST so canvases have dimensions
  if (resultsSection) resultsSection.classList.remove("hidden");

  // Render on existing canvases using existing functions
  resizeCanvases();

  // Spectrum canvas: show the corrected room response
  // options.liveSpectrum comes from orchestrator.getState() or legacy sweep
  const spectrumForCanvas = options.liveSpectrum || (orchestrator && orchestrator.getState().liveSpectrum) || null;
  if (canvasSpectrum && spectrumForCanvas && analyzer) {
    const corrected = analyzer.getCorrectedSpectrumFromDB(spectrumForCanvas);
    if (corrected) {
      const specCtx = canvasSpectrum.getContext("2d");
      renderSpectrum(specCtx, corrected, "#ff6b6b");
    }
  }

  // Estimated canvas: response after EQ
  if (canvasEstimated && result.normalizedResponse) {
    const smoothedArr = Array.from(result.normalizedResponse);
    const estimatedResponse = smoothedArr.map((v, i) => v + (gains[i] || 0));
    const estCtx = canvasEstimated.getContext("2d");
    renderSpectrum(estCtx, estimatedResponse, "#00f5d4");
  } else if (import.meta.env.DEV) {
    console.log("[showResults] estimated canvas SKIPPED — canvasEstimated:", !!canvasEstimated, "normalizedResponse:", !!result.normalizedResponse);
  }

  // EQ canvas
  if (canvasEq && gains) {
    const eqCtx = canvasEq.getContext("2d");
    renderEQCurve(eqCtx, gains);
  }

  // EQ table
  populateEQTable(visData, gains);

  // Enable export buttons
  const gainsArray = Array.isArray(gains) ? gains : Array.from(gains);
  if (btnExportWavelet) {
    btnExportWavelet.disabled = false;
    btnExportWavelet.dataset.gains = JSON.stringify(gainsArray);
  }
  if (btnExportEqMac) {
    btnExportEqMac.disabled = false;
    btnExportEqMac.dataset.gains = JSON.stringify(gainsArray);
    btnExportEqMac.dataset.visData = JSON.stringify(visData);
  }

  // Post-calibration saturation advisory
  if (options.rolledBack && statusCalibration) {
    statusCalibration.textContent = "Calibration saturated at limits — reverted to previous profile.";
    statusCalibration.className = "status danger";
  } else if (options.cumulativeGains) {
    const maxAbs = Math.max(...Array.from(options.cumulativeGains).map(Math.abs));
    if (maxAbs >= 4.0 && statusCalibration) {
      statusCalibration.textContent = "High correction applied — room may need acoustic treatment.";
      statusCalibration.className = "status info";
    }
  }

  // UI: show calibrate, hide stop
  if (btnCalibrate) btnCalibrate.classList.remove("hidden");
  if (btnStopCalibration) btnStopCalibration.classList.add("hidden");

  // Release microphone (orchestrator handles this in stop path)
  try {
    analyzer?.destroy();
  } finally {
    analyzer = null;
  }

  // Suspend audio context
  setTimeout(() => {
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.suspend().catch(() => {});
    }
  }, 100);
}

/** Calibration stopped internally by orchestrator on error (no more manual stop). */

/**
 * Live canvas rendering — called via requestAnimationFrame.
 * Draws 3 lines: target curve (cached), room response (updating), estimated response after EQ.
 */
function renderLiveCalibration(timestamp, final = false) {
  const state = orchestrator ? orchestrator.getState() : {};
  if (!state.running && !final) return;

  const canvas = canvasLive;
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));
  const bufW = Math.floor(cssW * dpr);
  const bufH = Math.floor(cssH * dpr);

  // Sync canvas buffer to CSS dimensions every frame.
  // Ensures rendering is never clipped, regardless of whether
  // resizeCanvases() or ResizeObserver have fired yet.
  if (canvas.width !== bufW || canvas.height !== bufH) {
    canvas.width = bufW;
    canvas.height = bufH;
  }

  const ctx = canvas.getContext("2d");
  const width = cssW;
  const height = cssH;

  // Clear
  ctx.clearRect(0, 0, bufW, bufH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, width, height);

  // Grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = (g / 4) * height;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(width, gy);
    ctx.stroke();
  }

  // Zero line (center)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Y-axis range: -15 to +15 dB, centered at 0
  const minDB = -15;
  const maxDB = 15;
  const dbRange = maxDB - minDB;

  // Log-frequency X mapping
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);

  function freqToX(freq) {
    const logFreq = Math.log10(Math.max(20, Math.min(20000, freq)));
    return ((logFreq - logMin) / (logMax - logMin)) * width;
  }

  function dbToY(db) {
    const clamped = Math.max(minDB, Math.min(maxDB, db));
    return height - ((clamped - minDB) / dbRange) * height;
  }

  function drawLine(points, color, dashed = false, alpha = 1) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (dashed) ctx.setLineDash([5, 5]);
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = freqToX(points[i].x);
      const y = dbToY(points[i].y);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Line 1: Target curve (cached, dashed, semi-transparent)
  if (cachedTargetCurve && cachedTargetCurve.length > 0) {
    drawLine(cachedTargetCurve, "#6a6a7a", true, 0.4);
  }

  // Line 2: Pink noise spectrum (updating, coral)
  if (state.liveSpectrum && analyzer) {
    const spectrumPoints = generateVisualizationData(state.liveSpectrum, analyzer.getLinearFrequencyLabels());
    drawLine(spectrumPoints, "#ff6b6b");
  }

  // Line 3: Estimated response after EQ (room + correction, cyan)
  const lastRes = state.lastResult;
  if (lastRes?.normalizedResponse && lastRes?.visData && state.liveEQGains) {
    const estimatedPoints = [];
    const freqs = lastRes.visData.map((v) => v.x);
    for (let i = 0; i < freqs.length; i++) {
      const y = lastRes.normalizedResponse[i] + (state.liveEQGains[i] || 0);
      estimatedPoints.push({ x: freqs[i], y });
    }
    drawLine(estimatedPoints, "#00f5d4");
  }

  // Legend (top-left corner)
  ctx.font = "10px 'JetBrains Mono', monospace";
  const legendX = 10;
  let legendY = 18;
  const legendItems = [
    { color: "#6a6a7a", label: "Target", dashed: true },
    { color: "#ff6b6b", label: "Room Response" },
    { color: "#00f5d4", label: "Estimated" },
  ];
  for (const item of legendItems) {
    ctx.save();
    ctx.globalAlpha = item.dashed ? 0.4 : 1;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2;
    if (item.dashed) ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 16, legendY);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = item.color;
    ctx.fillText(item.label, legendX + 22, legendY + 4);
    legendY += 16;
  }

  // Delta label (bottom-right)
  if (calibrationDelta && calibrationDelta.textContent) {
    const deltaText = calibrationDelta.textContent;
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.font = "bold 11px 'JetBrains Mono', monospace";
    const textWidth = ctx.measureText(deltaText).width;
    ctx.fillText(deltaText, width - textWidth - 10, height - 10);
  }

  // Frequency labels (bottom axis, log-spaced)
  const freqLabels = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  for (const freq of freqLabels) {
    const x = freqToX(freq);
    const label = freq >= 1000 ? (freq / 1000) + "k" : freq + "Hz";
    ctx.fillText(label, x, height - 20);
    // Small tick mark
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, height - 2);
    ctx.lineTo(x, height - 8);
    ctx.stroke();
  }
  ctx.textAlign = "start";

  // Continue loop unless this is the final frame
  if (final !== true) {
    requestAnimationFrame(renderLiveCalibration);
  }
}

/**
 * Render one final frame on the live canvas and stop the loop.
 * Called when calibration completes or is manually stopped.
 */
function renderLiveCalibrationFinal() {
  if (import.meta.env.DEV) console.log("[live canvas] rendering final frame");
  renderLiveCalibration(0, true);
}

/**
 * Restore a persisted calibration profile on app init.
 */
function restorePersistedProfile() {
  const profile = loadProfile();
  if (!profile || !profile.gains) return;

  const ageHours = (Date.now() - profile.timestamp) / (1000 * 60 * 60);

  if (statusCalibration) {
    if (ageHours < 24) {
      statusCalibration.textContent = "Loaded saved calibration (" + Math.round(ageHours) + "h ago). Ready to use or recalibrate.";
      statusCalibration.className = "status done";
    } else {
      statusCalibration.textContent = "Loaded saved calibration (" + Math.round(ageHours) + "h old) — recalibrate for best accuracy.";
      statusCalibration.className = "status info";
    }
  }

  // Parametric bands restored on next calibration start (orchestrator creates fresh)

  // Enable export with saved profile (graphs shown only after calibration)
  // loadProfile() returns gains as Float32Array — convert to plain Array for JSON serialization
  const gainsArray = Array.from(profile.gains);
  if (btnExportWavelet) {
    btnExportWavelet.disabled = false;
    btnExportWavelet.dataset.gains = JSON.stringify(gainsArray);
  }
  if (btnExportEqMac) {
    btnExportEqMac.disabled = false;
    btnExportEqMac.dataset.gains = JSON.stringify(gainsArray);
  }
}

// ─── End Live Pink Noise Calibration Flow ─────────────────────────────

// Export handlers
btnExportWavelet.addEventListener("click", () => {
  const gains = JSON.parse(btnExportWavelet.dataset.gains);
  const content = exportWavelet(gains);
  downloadFile("lazyeq-wavelet.txt", content);
  statusExport.textContent = "Wavelet preset exported — import it into the Wavelet app on Android";
  statusExport.className = "status done";
});

btnExportEqMac.addEventListener("click", () => {
  const gains = JSON.parse(btnExportEqMac.dataset.gains);
  const visData = JSON.parse(btnExportEqMac.dataset.visData || "[]");
  const content = exportEqMac(gains, visData);
  downloadFile("lazyeq-eqmac.json", content);
  statusExport.textContent = "eqMac preset exported — open eqMac on macOS and import the file";
  statusExport.className = "status done";
});

window.addEventListener("resize", resizeCanvases);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeCanvases);
}

// Keep canvases in sync with layout changes (not only viewport resize)
if (window.ResizeObserver) {
  const resizeObserver = new ResizeObserver(() => {
    resizeCanvases();
  });
  const calibrationCardEl = document.getElementById("calibration-card");
  if (calibrationCardEl) resizeObserver.observe(calibrationCardEl);
  if (resultsSection) resizeObserver.observe(resultsSection);
  if (canvasLive) resizeObserver.observe(canvasLive);
}

// ─── Live Calibration Event Wiring ────────────────────────────────────

/** Build orchestrator with current module state. Called lazily on first use. */
function createOrchestrator() {
  if (orchestrator) return orchestrator;
  orchestrator = new CalibrationOrchestrator({
    analyzer,
    audioContext,
    processMeasurement: _processMeasurementResults,
    onStatusChange: ({ text, className }) => {
      if (statusCalibration) {
        statusCalibration.textContent = text;
        statusCalibration.className = className;
      }
    },
    onProgress: ({ text }) => {
      if (calibrationDelta) calibrationDelta.textContent = text;
    },
    onComplete: (result, options) => {
      const state = orchestrator ? orchestrator.getState() : {};
      showResults(result, {
        ...options,
        liveSpectrum: state.liveSpectrum,
        cumulativeGains: state.cumulativeGains,
      });
      renderLiveCalibrationFinal();
    },
  });
  return orchestrator;
}

if (btnCalibrate) {
  btnCalibrate.addEventListener("click", async () => {
    // UI toggles
    if (btnCalibrate) btnCalibrate.classList.add("hidden");
    if (btnStopCalibration) btnStopCalibration.classList.remove("hidden");
    if (calibrationDelta) calibrationDelta.classList.remove("hidden");
    if (resultsSection) resultsSection.classList.add("hidden");

    // ── Check if mic permission was previously blocked (Chrome remembers) ──
    try {
      if (navigator.permissions) {
        const micPerm = await navigator.permissions.query({ name: "microphone" });
        if (micPerm.state === "denied") {
          statusCalibration.textContent = "Microphone access was blocked for this site. Click the lock icon in the address bar, change it to 'Allow', and try again.";
          statusCalibration.className = "status danger";
          if (btnCalibrate) btnCalibrate.classList.remove("hidden");
          if (btnStopCalibration) btnStopCalibration.classList.add("hidden");
          if (calibrationDelta) calibrationDelta.classList.add("hidden");
          return;
        }
      }
    } catch (_) { /* Permissions API not available or query failed — proceed anyway */ }

    // ── Obtain mic stream ONCE with generic constraint ──
    // We use getUserMedia({audio:true}) (no deviceId) to avoid the
    // ephemeral-deviceId issue: IDs from enumerateDevices() before
    // permission is granted become invalid after getUserMedia() is called.
    const ctx = initAudioContext();
    if (!analyzer) analyzer = new SpectrumAnalyzer();
    try {
      const localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Re-enumerate now that we have permission — gets real device labels
      await loadDevices();
      // Pass the pre-obtained stream directly — no second getUserMedia call
      await analyzer.init(localMicStream, ctx);
    } catch (permErr) {
      if (permErr.name === "NotAllowedError") {
        statusCalibration.textContent = "Microphone access denied. Allow mic access in your browser and try again.";
        statusCalibration.className = "status danger";
      } else {
        statusCalibration.textContent = "Microphone error — " + (permErr.message || "check console") + ". Try refreshing the page.";
        statusCalibration.className = "status danger";
      }
      if (btnCalibrate) btnCalibrate.classList.remove("hidden");
      if (btnStopCalibration) btnStopCalibration.classList.add("hidden");
      if (calibrationDelta) calibrationDelta.classList.add("hidden");
      return;
    }

    // Pre-compute target curve for canvas rendering
    computeTargetCurveCache();

    // Create orchestrator (now analyzer + audioContext are live)
    const orch = createOrchestrator();
    orch.start();

    // Start canvas render loop
    animationFrame = requestAnimationFrame(renderLiveCalibration);
  });
}

if (btnStopCalibration) {
  btnStopCalibration.addEventListener("click", () => {
    // Stop orchestrator
    if (orchestrator) orchestrator.stop();

    // Clean up animation frame
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }

    // UI toggles
    if (btnCalibrate) btnCalibrate.classList.remove("hidden");
    if (btnStopCalibration) btnStopCalibration.classList.add("hidden");
    if (calibrationDelta) calibrationDelta.classList.add("hidden");
  });
}

// ─── End Live Calibration Event Wiring ────────────────────────────────

// ─── Legacy Sine Sweep (Advanced Section) ─────────────────────────────

if (btnLegacySweep) {
  btnLegacySweep.addEventListener("click", async () => {
    try {
      // Auto-load devices on first user gesture if not loaded yet
      if (!selectedMicDeviceId && micSelect.options.length <= 1 && micSelect.options[0]?.textContent === "Loading devices…") {
        statusDevices.textContent = "Detecting microphones...";
        statusDevices.className = "status";
        await loadDevices();
      }

      const ctx = initAudioContext();
      if (!analyzer) analyzer = new SpectrumAnalyzer();

      // Obtain mic stream with generic constraint (no deviceId) to avoid
      // ephemeral-ID issue: IDs from enumerateDevices() before permission
      // grant become invalid after getUserMedia() is called.
      const localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await loadDevices();
      await analyzer.init(localMicStream, ctx);

      // Capture noise floor if not already done
      if (!analyzer.noiseBuffer) {
        statusLegacySweep.textContent = "Capturing noise floor (5s silence)...";
        statusLegacySweep.className = "status recording";
        await analyzer.captureNoiseFloor(5);
        await analyzer.calibrateMicrophone();
      }

      const sweepCount = parseInt(sweepCountAdvanced?.value || "2");

      btnLegacySweep.disabled = true;
      statusLegacySweep.textContent = `Running ${sweepCount} sweep(s) for averaging...`;
      statusLegacySweep.className = "status recording";

      // Create orchestrator instance with DI
      const liveCanvasCtx = canvasLiveLegacy?.getContext("2d");
      const orchestrator = new LegacySweepOrchestrator({
        analyzer,
        audioContext: ctx,
        processMeasurement: _processMeasurementResults,
        onStatusChange: ({ text, className }) => {
          if (statusLegacySweep) {
            statusLegacySweep.textContent = text;
            statusLegacySweep.className = className;
          }
        },
        onComplete: (result, options) => {
          if (result) {
            liveSpectrum = options.spectrum;
            showResults(result);
          }
          btnLegacySweep.disabled = false;
        },
        renderFrame: (spectrum) => {
          if (liveCanvasCtx && canvasLiveLegacy) {
            renderSpectrum(liveCanvasCtx, spectrum);
          }
        },
      });

      await orchestrator.run(sweepCount);

    } catch (err) {
      console.error(err);
      if (statusLegacySweep) {
        statusLegacySweep.textContent = "Legacy sweep failed: " + err.message;
        statusLegacySweep.className = "status danger";
      }
      btnLegacySweep.disabled = false;
    }
  });
}

// ─── End Legacy Sine Sweep ────────────────────────────────────────────

// Initialize all canvases
resizeCanvases();

// Populate device list on init (generic labels until permission granted)
loadDevices();

// Restore persisted profile on init
restorePersistedProfile();

if (import.meta.env.DEV) console.log("lazyEq (Pink Noise mode) initialized");

/** Dist verification hook — string must remain in bundle for `npm test` (test.js). */
globalThis.lazyEqTest = { mode: "sine-sweep", version: "1.0.0" };
