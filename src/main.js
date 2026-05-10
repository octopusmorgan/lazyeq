/**
 * lazyEq - Sine Sweep Speaker EQ Analyzer
 * Professional frequency response measurement using logarithmic sine sweep
 */

import { SineSweepSource } from "./sineSweep.js";
import { SpectrumAnalyzer } from "./analyzer.js";
import { SAMPLE_RATE, FFT_SIZE } from "./constants.js";
import {
  exportWavelet,
  exportEqMac,
  generateVisualizationData,
  EQMAC_BANDS,
  getHarmanTargetDB,
} from "./eqGenerator.js";
import { PinkNoiseSource } from "./pinkNoise.js";
import { ConvergenceDetector } from "./convergence.js";
import { saveProfile, loadProfile, loadPreviousProfile, isProfileSaturated, float32ToArray } from "./persistence.js";
import { PINK_NOISE_GAIN, MEASUREMENT_INTERVAL_MS, CONVERGENCE_THRESHOLD_DB, CONVERGENCE_WINDOW_COUNT, SNR_THRESHOLD_DB, MIN_MEASUREMENTS, CALIBRATION_TIMEOUT_MS, SILENCE_THRESHOLD_DB, INITIAL_PER_BAND_GAIN, SATURATION_RATIO_THRESHOLD, SATURATION_CONSECUTIVE_COUNT, MIN_SIGNAL_LEVEL_DB, LOW_SIGNAL_WINDOW_COUNT } from "./constants.js";
import { detectCandidates } from './candidateDetector.js';
import { rankCandidates } from './candidateRanker.js';
import { synthesizeBands, evaluateCurveAt, gainsFromBands } from './parametricEqSynthesizer.js';
import {
  PEAK_DETECTION_THRESHOLD, NULL_DETECTION_THRESHOLD, NULL_REJECTION_WIDTH_HZ,
  MERGE_DISTANCE_HZ, RANKING_WEIGHTS, LF_FOCUS_MULTIPLIER, LF_FOCUS_CUTOFF,
  MAX_CUT_DB, MAX_BOOST_DB, BOOST_CONFIDENCE_THRESHOLD, BOOST_PENALTY,
  Q_MIN, Q_MAX, MAX_PARAMETRIC_BANDS, LF_MAX_Q,
  FILTER_POOL_SIZE, FILTER_POOL_SMOOTHING, EVAL_FREQUENCIES, SMART_RESIDUAL_THRESHOLD_DB,
  USE_SMART_CORRECTION,
} from './constants.js';
import { logCalibrationWindow, enableCalibrationLog, logCalibrationError, logCalibrationConverged, isCalibrationDebugEnabled } from './calibrationDebugLog.js';

/**
 * Convert hex color to RGBA string
 * @param {string} hex - "#RRGGBB" or "#RGB" format
 * @param {number} alpha - Alpha value 0-1
 * @returns {string} "rgba(r,g,b,a)"
 */
function hexToRgba(hex, alpha) {
  // Normalize: expand #RGB → #RRGGBB
  let normalized = hex;
  if (hex.startsWith('#') && hex.length === 4) {
    normalized = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }

  // Parse RRGGBB
  const match = normalized.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return `rgba(0, 0, 0, ${alpha})`;

  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

let analyzer = null;
let sweepSource = null;

let animationFrame = null;
let frameCount = 0;
let accumulatedSpectrum = null;
let sweepDuration = 8;
let selectedMicDeviceId = null;
let sweepProcessing = false;
let sweepProcessTimeout = null;
let legacyAnimationFrame = null; // Track legacy sweep animation frame for cleanup

// Live pink noise calibration state
let pinkNoise = null;
let convergenceDetector = null;
let continuousMeasurement = null;
let liveSpectrum = null;
let liveEQGains = null;
let calibrationRunning = false;
let calibrationStartTime = 0;
let lowInputWarningCount = 0;
let cachedTargetCurve = null; // Pre-computed target curve for live canvas
let lastMeasurementResult = null; // Best result for stop/partial
let previousCandidateFreqs = null; // Freqs from previous window for stability tracking
let consecutiveLowSignalCount = 0; // Windows below MIN_SIGNAL_LEVEL_DB

// Phase 2 stability gating state
let bestResult = null;           // best measurement result (lowest residual error)
let bestMaxDelta = Infinity;     // lowest max(|residual|) seen
let validMeasurementCount = 0;   // non-SNR-gated windows
let consecutiveSNRSkips = 0;     // consecutive SNR-gated skips
let calibrationTimeout = null;   // setTimeout ID for 30s watchdog

// Active EQ state — filter chain applied to pink noise in real time
const ACTIVE_EQ_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
let activeEQFilters = null;   // BiquadFilterNode[] inserted in pink noise path
let cumulativeEQGains = null; // Float32Array(8) — running total of applied EQ
let currentParametricBands = null; // ParametricBand[] — current smart correction bands

// Adaptive per-band gain limits (Phase 3)
let perBandMaxGain = null;     // Float32Array(8), init to 6.0
let perBandMaxCut = null;      // Float32Array(8), init to -6.0
let perBandSaturationCount = null; // Uint8Array(8)
let prevBandCorrected = null;  // Float32Array(8)

// DOM Elements
const btnNoise = document.getElementById("btn-noise");
const btnSweep = document.getElementById("btn-sweep");
const btnStop = document.getElementById("btn-stop");
const btnExportWavelet = document.getElementById("btn-export-wavelet");
const btnExportEqMac = document.getElementById("btn-export-eqmac");
const btnRefreshDevices = document.getElementById("btn-refresh-devices");
const statusNoise = document.getElementById("status-noise");
const statusSweep = document.getElementById("status-sweep");
const statusExport = document.getElementById("status-export");
const statusDevices = document.getElementById("status-devices");
const micSelect = document.getElementById("mic-select");
const sweepCountSelect = document.getElementById("sweep-count");
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

// Legacy sweep fallback mapping (current UI uses calibration ids)
const legacyStatusFallback = statusCalibration;
const statusNoiseEl = document.getElementById("status-noise") || legacyStatusFallback;
const statusSweepEl = document.getElementById("status-sweep") || legacyStatusFallback;
const sweepCountSelectEl = document.getElementById("sweep-count") || document.getElementById("sweep-count-advanced");

// Progress bar elements
const noiseProgressContainer = document.getElementById("noise-progress-container");
const noiseProgressBar = document.getElementById("noise-progress-bar");
const sweepProgressContainer = document.getElementById("sweep-progress-container");
const sweepProgressBar = document.getElementById("sweep-progress-bar");

// Step indicator elements
const calStep1 = document.getElementById("cal-step-1");
const calStep2 = document.getElementById("cal-step-2");
const calStep3 = document.getElementById("cal-step-3");
const calConn1 = document.getElementById("cal-conn-1");
const calConn2 = document.getElementById("cal-conn-2");

// Legacy sweep (Advanced section) DOM elements
const btnLegacySweep = document.getElementById("btn-legacy-sweep");
const sweepCountAdvanced = document.getElementById("sweep-count-advanced");
const statusLegacySweep = document.getElementById("status-legacy-sweep");
const canvasLiveLegacy = document.getElementById("canvas-live-legacy");

// Card sections for progress state management
const cardDevices = document.getElementById("step-devices");
const cardNoise = document.getElementById("step-noise");
const cardSweep = document.getElementById("step-sweep");
const cardResults = document.getElementById("step-results");
const cardExport = document.getElementById("step-export");
let resultsReady = false;

// Hide results section until first measurement completes
if (cardResults) cardResults.classList.add("hidden");

// ─── Step Indicator & Progress Helpers ───────────────────────────────

/**
 * Update the calibration step indicator state.
 * @param {number} step - 1, 2, or 3
 * @param {'active' | 'completed' | 'pending'} state
 */
function updateStepIndicator(step, state) {
  const stepEl = step === 1 ? calStep1 : step === 2 ? calStep2 : calStep3;
  if (!stepEl) return;

  stepEl.classList.remove("active", "completed");
  if (state !== "pending") {
    stepEl.classList.add(state);
  }

  // Update connectors
  if (state === "completed" && step === 1 && calConn1) {
    calConn1.classList.add("completed");
  }
  if (state === "completed" && step === 2 && calConn2) {
    calConn2.classList.add("completed");
  }

  // Update card sections (active/completed/pending)
  const cards = [cardDevices, cardNoise, cardSweep, cardResults, cardExport];
  const cardMap = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 }; // step → card index
  // step 1=Noise card, 2=Sweep card, 3=Export card
  const cardIdx = { 1: 1, 2: 2, 3: 4 };
  const card = cardIdx[step] != null ? cards[cardIdx[step]] : null;
  if (card) {
    card.classList.remove("active", "completed");
    if (state === "active") card.classList.add("active");
    if (state === "completed") card.classList.add("completed");
  }
}

/**
 * Set progress bar percentage (0-100).
 * @param {'noise' | 'sweep'} type
 * @param {number} percent - 0 to 100
 */
function setProgressBar(type, percent) {
  const container = type === "noise" ? noiseProgressContainer : sweepProgressContainer;
  const bar = type === "noise" ? noiseProgressBar : sweepProgressBar;
  if (container) container.classList.remove("hidden");
  if (bar) bar.style.width = Math.min(100, Math.max(0, percent)) + "%";
}

/**
 * Hide a progress bar.
 * @param {'noise' | 'sweep'} type
 */
function hideProgressBar(type) {
  const container = type === "noise" ? noiseProgressContainer : sweepProgressContainer;
  const bar = type === "noise" ? noiseProgressBar : sweepProgressBar;
  if (container) container.classList.add("hidden");
  if (bar) bar.style.width = "0%";
}

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

// ─── Remote Mic Integration ──────────────────────────────────────────

async function initAnalyzer(ctx) {
  await analyzer.init(selectedMicDeviceId, ctx);
  if (import.meta.env.DEV) console.log("[Analyzer] Using LOCAL mic:", selectedMicDeviceId);
  // Permission granted — refresh device list to get proper labels
  await loadDevices();
}

function renderSpectrum(ctx, data, color) {
  const width = ctx.canvas.width / window.devicePixelRatio;
  const height = ctx.canvas.height / window.devicePixelRatio;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  
  // Background
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  
  // Grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    ctx.beginPath();
    ctx.moveTo(0, (g / 4) * height);
    ctx.lineTo(width, (g / 4) * height);
    ctx.stroke();
  }
  
  if (!data || data.length === 0) return;

  let minDB = Infinity, maxDB = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > -140) {
      minDB = Math.min(minDB, data[i]);
      maxDB = Math.max(maxDB, data[i]);
    }
  }
  const range = maxDB - minDB || 40;
  const padding = 12;

  // Create gradient for the fill
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  const baseColor = color || "#00f5d4";
  gradient.addColorStop(0, baseColor);
  gradient.addColorStop(0.5, baseColor);
  gradient.addColorStop(1, "#ffc857");

  // Draw filled area with glow
  ctx.save();
  ctx.shadowColor = baseColor;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * width;
    const y = padding + ((maxDB - data[i]) / range) * (height - padding * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Draw fill under the curve
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * width;
    const y = padding + ((maxDB - data[i]) / range) * (height - padding * 2);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  const fillGradient = ctx.createLinearGradient(0, 0, 0, height);
  fillGradient.addColorStop(0, hexToRgba(baseColor, 0.25));
  fillGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = hexToRgba(baseColor, 0.15);
  ctx.fill();

  // Frequency labels
  ctx.fillStyle = "rgba(160, 160, 176, 0.6)";
  ctx.font = "9px 'JetBrains Mono', monospace";
  [100, 1000, 10000].forEach(f => {
    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);
    const x = ((Math.log10(f) - logMin) / (logMax - logMin)) * width;
    const label = f >= 1000 ? f / 1000 + "k" : String(f);
    const lx = Math.max(2, Math.min(width - 20, x - 8));
    ctx.fillText(label, lx, height - 6);
  });
}

function renderEQCurve(ctx, gains) {
  const width = ctx.canvas.width / window.devicePixelRatio;
  const height = ctx.canvas.height / window.devicePixelRatio;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    ctx.beginPath();
    ctx.moveTo(0, (g / 4) * height);
    ctx.lineTo(width, (g / 4) * height);
    ctx.stroke();
  }

  if (!gains || gains.length === 0) {
    ctx.fillStyle = "rgba(160, 160, 176, 0.5)";
    ctx.font = "12px 'Outfit', sans-serif";
    ctx.fillText("No EQ data", 10, 30);
    return;
  }

  // Zero line (center)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Gradient for the curve
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#00f5d4");
  gradient.addColorStop(0.5, "#00f5d4");
  gradient.addColorStop(1, "#ffc857");

  // Draw EQ curve with glow
  ctx.save();
  ctx.shadowColor = "#00f5d4";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < gains.length; i++) {
    const x = (i / (gains.length - 1)) * width;
    const y = height / 2 - gains[i] * (height / 30);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Fill under curve
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  for (let i = 0; i < gains.length; i++) {
    const x = (i / (gains.length - 1)) * width;
    const y = height / 2 - gains[i] * (height / 30);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(width, height / 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(0, 245, 212, 0.1)";
  ctx.fill();
}

function renderLiveSweep() {
  const ctx = canvasLive.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = ctx.canvas.width / dpr;
  const height = ctx.canvas.height / dpr;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, width, height);

  if (!analyzer) {
    animationFrame = requestAnimationFrame(renderLiveSweep);
    return;
  }

  const data = analyzer.getCurrentSpectrum();
  if (!data) {
    animationFrame = requestAnimationFrame(renderLiveSweep);
    return;
  }

  // Debug: log first frame spectrum to verify analyzer is receiving audio
  if (frameCount === 0 && import.meta.env.DEV) {
    let maxVal = -Infinity, maxIdx = 0;
    let sumAboveNoise = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > maxVal) { maxVal = data[i]; maxIdx = i; }
      if (data[i] > -100) sumAboveNoise++;
    }
    console.log("[DIAG] First frame spectrum: max =", maxVal.toFixed(1), "dB at bin", maxIdx, "| bins > -100dB:", sumAboveNoise);
    // Also check RMS level
    const rms = analyzer.getRMSLevel();
    console.log("[DIAG] RMS level:", rms.toFixed(1), "dB");
  }

  if (!accumulatedSpectrum) {
    accumulatedSpectrum = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      accumulatedSpectrum[i] = -120;
    }
  }

  // Peak hold: keep maximum value at each frequency bin
  for (let i = 0; i < data.length; i++) {
    if (data[i] > accumulatedSpectrum[i]) {
      accumulatedSpectrum[i] = data[i];
    }
  }
  frameCount++;

  // Draw grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    ctx.beginPath();
    ctx.moveTo(0, (g / 4) * height);
    ctx.lineTo(width, (g / 4) * height);
    ctx.stroke();
  }

  // Draw live spectrum with gradient
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#00f5d4");
  gradient.addColorStop(0.5, "#00f5d4");
  gradient.addColorStop(1, "#ffc857");

  ctx.save();
  ctx.shadowColor = "#00f5d4";
  ctx.shadowBlur = 15;
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < 128; i++) {
    const logFreq = logMin + (i / 128) * (logMax - logMin);
    const freq = Math.pow(10, logFreq);
    const binIdx = Math.floor((freq / (analyzer.audioContext.sampleRate / 2)) * data.length);
    const x = (i / 128) * width;
    const db = data[Math.min(binIdx, data.length - 1)];
    const y = Math.max(0, Math.min(height, ((db + 100) / 100) * height));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Frame counter
  ctx.fillStyle = "rgba(0, 245, 212, 0.8)";
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.fillText(`${frameCount} frames`, 8, 16);

  animationFrame = requestAnimationFrame(renderLiveSweep);
}

// Gaussian smoothing
function gaussianSmooth(data, sigma = 2) {
  if (!data || data.length < 3) return data;

  const n = data.length;
  const result = new Float32Array(n);

  const kernelSize = Math.min(n, Math.max(3, Math.floor(sigma * 2 + 1) | 1));
  const halfKernel = (kernelSize - 1) / 2;

  const weights = [];
  let weightSum = 0;
  for (let i = -halfKernel; i <= halfKernel; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights.push(w);
    weightSum += w;
  }

  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wSum = 0;
    for (let j = -halfKernel; j <= halfKernel; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) {
        const w = weights[j + halfKernel];
        sum += data[idx] * w;
        wSum += w;
      }
    }
    result[i] = wSum > 0 ? sum / wSum : data[i];
  }

  return result;
}

// Adaptive smoothing - more in highs, less in bass
function adaptiveSmooth(data, smoothingFactor = 1.0) {
  if (!data || data.length < 5) return data;

  const n = data.length;
  const result = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const pos = i / n;
    const sigma = (1 + pos * 3) * smoothingFactor;
    const window = Math.max(3, Math.floor(sigma * 2 + 1) | 1);
    let sum = 0, wSum = 0;
    const halfW = (window - 1) / 2;

    for (let j = -halfW; j <= halfW; j++) {
      const idx = Math.max(0, Math.min(n - 1, i + j));
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sum += data[idx] * w;
      wSum += w;
    }

    result[i] = wSum > 0 ? sum / wSum : data[i];
  }

  return result;
}

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

// Step 1: Capture noise floor (legacy sweep path — preserved for Advanced mode)
let noiseCalibrationInProgress = false;
if (btnNoise) {
btnNoise.addEventListener("click", async () => {
  // Prevent duplicate handlers (Vite HMR can accumulate listeners)
  if (noiseCalibrationInProgress) return;
  
  try {
    // Auto-load devices on first user gesture if not loaded yet
    if (!selectedMicDeviceId && micSelect.options.length <= 1 && micSelect.options[0]?.textContent === "Loading devices…") {
      statusDevices.textContent = "Detecting microphones...";
      statusDevices.className = "status";
      await loadDevices();
    }

    noiseCalibrationInProgress = true;

    // ── Local mic: obtain stream ONCE and reuse it ──
    // We use getUserMedia({audio:true}) (generic constraint) to avoid the
    // ephemeral-deviceId issue where IDs from enumerateDevices() before
    // permission is granted become invalid after getUserMedia() is called.
    let localMicStream = null;
    // Check if mic permission was previously blocked (Chrome remembers)
    try {
      if (navigator.permissions) {
        const micPerm = await navigator.permissions.query({ name: "microphone" });
        if (micPerm.state === "denied") {
          statusNoiseEl.textContent = "Microphone access was previously blocked for this site. Click the camera/lock icon in the address bar and change it to 'Allow', then try again.";
          statusNoiseEl.className = "status danger";
          noiseCalibrationInProgress = false;
          return;
        }
      }
    } catch (_) { /* Permissions API not available or query failed */ }

    try {
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Re-enumerate now that we have permission — gets real device labels
      await loadDevices();
    } catch (permErr) {
      throw permErr;
    }

    statusNoiseEl.textContent = "Step 1 of 3: Please stay quiet for 5 seconds to measure room noise floor...";
    statusNoiseEl.className = "status";
    btnNoise.disabled = true;
    updateStepIndicator(1, "active");

    const ctx = await ensureAudioContext();
    analyzer = new SpectrumAnalyzer();
    await analyzer.init(localMicStream, ctx);

    statusNoiseEl.textContent = "Recording noise floor... keep quiet";
    statusNoiseEl.className = "status recording";
    hideProgressBar("noise");

    const startTime = Date.now();
    const captureDuration = 5000;

    const updateNoiseDisplay = async () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const progress = Math.min(100, (elapsed / (captureDuration / 1000)) * 100);
      setProgressBar("noise", progress);

      if (analyzer && analyzer.getRMSLevel) {
        const db = analyzer.getRMSLevel();
        statusNoiseEl.textContent = `Recording noise floor... ${db.toFixed(0)} dB — keep quiet`;
      }
      if (Date.now() - startTime < captureDuration) {
        setTimeout(updateNoiseDisplay, 100);
      }
    };
    updateNoiseDisplay();

await analyzer.captureNoiseFloor(5);

  // Self-calibrate microphone using phone speaker (invisible to user)
  statusNoiseEl.textContent = "Calibrating mic response...";
  await analyzer.calibrateMicrophone();

  if (analyzer.noiseBuffer) {
      let minDB = Infinity, maxDB = -Infinity;
      for (let i = 0; i < analyzer.noiseBuffer.length; i++) {
        if (analyzer.noiseBuffer[i] > -100) {
          minDB = Math.min(minDB, analyzer.noiseBuffer[i]);
          maxDB = Math.max(maxDB, analyzer.noiseBuffer[i]);
        }
      }
      if (minDB === Infinity) {
        statusNoiseEl.textContent = "Step 1 complete: Noise floor captured (silent environment)";
      } else {
        statusNoiseEl.textContent = `Step 1 complete: Noise floor measured (${minDB.toFixed(0)} to ${maxDB.toFixed(0)} dB)`;
      }
    } else {
      statusNoiseEl.textContent = "Step 1 complete: Noise floor captured";
    }
    statusNoiseEl.className = "status done";
    hideProgressBar("noise");
    updateStepIndicator(1, "completed");
    updateStepIndicator(2, "active");
    btnSweep.disabled = false;
    noiseCalibrationInProgress = false;
  } catch (err) {
    console.error(err);
    if (err.name === "NotAllowedError" || err.message?.includes("permission")) {
      statusNoiseEl.textContent = "Microphone access was blocked. Check your browser's address bar for the blocked-permissions icon, allow mic access, and try again.";
    } else {
      statusNoiseEl.textContent = "Noise floor calibration failed. Make sure your mic is working and try again.";
    }
    statusNoiseEl.className = "status danger";
    hideProgressBar("noise");
    updateStepIndicator(1, "pending");
    btnNoise.disabled = false;
    noiseCalibrationInProgress = false;
  }
});
} // end btnNoise guard

/**
 * Compute frequency spectrum from recorded PCM using Welch's method.
 * Produces a dB spectrum compatible with the existing processing pipeline.
 *
 * @param {Float32Array} pcm - Raw PCM recording
 * @param {number} sampleRate - Audio sample rate
 * @param {number} targetBins - Number of output bins (matches FFT_SIZE/2 = 1024)
 * @returns {Float32Array} Spectrum in dB
 */
function computeSpectrumFromPCM(pcm, sampleRate, targetBins) {
  const fftSize = 65536; // Power of 2, good frequency resolution
  const N = fftSize;

  // Use only the sweep-duration portion of the recording
  const sweepSamples = Math.floor(sweepDuration * sampleRate);
  const signal = pcm.length >= sweepSamples
    ? pcm.subarray(0, sweepSamples)
    : pcm;

  // Hann window
  const window = new Float32Array(N);
  let windowPower = 0;
  for (let i = 0; i < N; i++) {
    window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    windowPower += window[i] * window[i];
  }

  // Welch's method: average periodograms with 50% overlap
  const hopSize = Math.floor(N / 2);
  const numWindows = Math.max(1, Math.floor((signal.length - N) / hopSize) + 1);
  const spectrum = new Float64Array(N / 2);

  for (let w = 0; w < numWindows; w++) {
    const offset = w * hopSize;
    const real = new Float64Array(N);
    const imag = new Float64Array(N);

    for (let i = 0; i < N && (offset + i) < signal.length; i++) {
      real[i] = signal[offset + i] * window[i];
    }

    // Radix-2 Cooley-Tukey FFT (in-place)
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Butterfly stages
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = -2 * Math.PI / len;
      const wRe = Math.cos(angle);
      const wIm = Math.sin(angle);
      for (let i = 0; i < N; i += len) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < halfLen; j++) {
          const tRe = curRe * real[i + j + halfLen] - curIm * imag[i + j + halfLen];
          const tIm = curRe * imag[i + j + halfLen] + curIm * real[i + j + halfLen];
          real[i + j + halfLen] = real[i + j] - tRe;
          imag[i + j + halfLen] = imag[i + j] - tIm;
          real[i + j] += tRe;
          imag[i + j] += tIm;
          const newRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = newRe;
        }
      }
    }

    // Accumulate magnitude squared
    for (let i = 0; i < N / 2; i++) {
      spectrum[i] += (real[i] * real[i] + imag[i] * imag[i]) / (numWindows * windowPower);
    }
  }

  // Convert to dB
  const fullSpectrum = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    fullSpectrum[i] = spectrum[i] > 0 ? 10 * Math.log10(spectrum[i]) : -120;
  }

  // Resample to target bins using log-frequency interpolation
  const result = new Float32Array(targetBins);
  const srcNyquist = sampleRate / 2;
  for (let i = 0; i < targetBins; i++) {
    const freq = (i / targetBins) * srcNyquist;
    const srcIdx = (freq / srcNyquist) * (N / 2);
    const idxLo = Math.max(0, Math.min(N / 2 - 2, Math.floor(srcIdx)));
    const idxHi = idxLo + 1;
    const frac = srcIdx - idxLo;
    result[i] = fullSpectrum[idxLo] * (1 - frac) + fullSpectrum[idxHi] * frac;
  }

  return result;
}

// Step 2: Play Sine Sweep (supports multi-sweep averaging) — legacy path preserved for Advanced mode
if (btnSweep) {
btnSweep.addEventListener("click", async () => {
  try {

    // Check noise floor was calibrated
    if (!analyzer || !analyzer.noiseBuffer) {
      statusSweepEl.textContent = "Please complete Step 1 (Noise Floor) before running the sweep.";
      statusSweepEl.className = "status danger";
      btnSweep.disabled = false;
      btnStop.disabled = true;
      return;
    }

    // Read sweep count
    const sweepCount = parseInt(sweepCountSelectEl?.value || "1");

    btnSweep.disabled = true;
    btnStop.disabled = false;
    hideProgressBar("sweep");
    updateStepIndicator(2, "active");

    const ctx = await ensureAudioContext();

    // Reinitialize with same audioContext but preserve noiseBuffer
    await initAnalyzer(ctx);

    if (sweepCount === 1) {
      // ── Single sweep (original behavior) ──
      statusSweepEl.textContent = "Step 2 of 3: Playing 8-second sweep test tone through your speakers...";
      statusSweepEl.className = "status recording";

      sweepSource = new SineSweepSource(ctx);
      sweepSource.createBuffer(sweepDuration);

      // Start AudioWorklet recording before playing the sweep
      let recordingPromise = null;
      let useWorklet = true;
      try {
        recordingPromise = analyzer.recordSweep(sweepDuration);
      } catch (err) {
        console.warn('[Sweep] AudioWorklet recording failed, using AnalyserNode fallback:', err.message);
        useWorklet = false;
      }

      const sweepStartTime = Date.now();
      const sweepUpdateInterval = setInterval(() => {
        const elapsed = (Date.now() - sweepStartTime) / 1000;
        const progress = Math.min(100, (elapsed / sweepDuration) * 100);
        setProgressBar("sweep", progress);

        if (analyzer && analyzer.getRMSLevel) {
          const db = analyzer.getRMSLevel();
          statusSweepEl.textContent = `Recording sweep response... ${db.toFixed(0)} dB`;
        }
      }, 200);

      sweepSource.onComplete = async () => {
        clearInterval(sweepUpdateInterval);
        setProgressBar("sweep", 100);
        statusSweepEl.textContent = "Sweep finished — processing frequency response...";
        statusSweepEl.className = "status info";
        btnStop.disabled = true;

        sweepProcessTimeout = setTimeout(async () => {
          if (animationFrame) {
            cancelAnimationFrame(animationFrame);
            animationFrame = null;
          }

          // If AudioWorklet recording was used, process the recorded PCM
          if (useWorklet && recordingPromise) {
            try {
              const recordedPCM = await recordingPromise;
              if (recordedPCM && recordedPCM.length > 0) {
                if (import.meta.env.DEV) {
                  console.log('[Sweep] AudioWorklet recording complete:', recordedPCM.length, 'samples');
                }
                // Compute spectrum from recorded PCM
                const fftSize = analyzer.analyserNode.fftSize;
                const targetBins = fftSize / 2;
                const spectrum = computeSpectrumFromPCM(recordedPCM, analyzer.audioContext.sampleRate, targetBins);

                // Replace accumulatedSpectrum with the computed spectrum for processing
                accumulatedSpectrum = spectrum;
                frameCount = 100; // Ensure we pass the "enough data" check
              }
            } catch (err) {
              console.warn('[Sweep] AudioWorklet processing failed, falling back to peak-hold:', err.message);
              // Fall back to existing peak-hold data
            }
          }

          await processSweepResults();
        }, 500);
      };

      sweepSource.start();
      renderLiveSweep();

    } else {
      // ── Multi-sweep averaging ──
      statusSweepEl.textContent = `Step 2 of 3: Running ${sweepCount} sweeps for averaging...`;
      statusSweepEl.className = "status recording";

      const allSpectra = [];

      for (let sweepNum = 0; sweepNum < sweepCount; sweepNum++) {
        // Reset accumulation for each sweep
        accumulatedSpectrum = null;
        frameCount = 0;

        statusSweepEl.textContent = `Sweep ${sweepNum + 1} of ${sweepCount}...`;
        const sweepProgress = ((sweepNum) / sweepCount) * 100;
        setProgressBar("sweep", sweepProgress);

        sweepSource = new SineSweepSource(ctx);
        sweepSource.createBuffer(sweepDuration);

        // Wait for this sweep to complete
        await new Promise((resolve, reject) => {
          const sweepStartTime = Date.now();
          const sweepUpdateInterval = setInterval(() => {
            const elapsed = (Date.now() - sweepStartTime) / 1000;
            const sweepProgress = ((sweepNum + elapsed / sweepDuration) / sweepCount) * 100;
            setProgressBar("sweep", sweepProgress);

            if (analyzer && analyzer.getRMSLevel) {
              const db = analyzer.getRMSLevel();
              statusSweepEl.textContent = `Sweep ${sweepNum + 1} of ${sweepCount}... ${db.toFixed(0)} dB`;
            }
          }, 200);

          sweepSource.onComplete = async () => {
            clearInterval(sweepUpdateInterval);

            // Apply 1/f compensation to the accumulated peak-hold spectrum
            const f0 = 20;
            const sr = analyzer.audioContext.sampleRate;
            const fftSz = analyzer.analyserNode.fftSize;
            const bw = sr / fftSz;

            const compensatedSpectrum = new Float32Array(accumulatedSpectrum.length);
            for (let i = 0; i < accumulatedSpectrum.length; i++) {
              const freq = i * bw;
              if (freq > f0) {
                compensatedSpectrum[i] = accumulatedSpectrum[i] + 10 * Math.log10(freq / f0);
              } else {
                compensatedSpectrum[i] = accumulatedSpectrum[i];
              }
            }

            // Store the compensated spectrum
            allSpectra.push(compensatedSpectrum);

            // Reset for next sweep
            accumulatedSpectrum = null;
            frameCount = 0;

            resolve();
          };

          sweepSource.start();
          renderLiveSweep();
        });

        // Brief pause between sweeps
        if (sweepNum < sweepCount - 1) {
          statusSweepEl.textContent = `Pause before sweep ${sweepNum + 2}...`;
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // All sweeps done — average the compensated spectra
      setProgressBar("sweep", 100);
      statusSweepEl.textContent = `Averaging ${sweepCount} sweeps...`;
      statusSweepEl.className = "status info";
      btnStop.disabled = true;

      // Average in the compensated domain (after 1/f compensation, before noise subtraction)
      const averaged = new Float32Array(allSpectra[0].length);
      for (let i = 0; i < averaged.length; i++) {
        let sum = 0;
        for (const spectrum of allSpectra) {
          sum += spectrum[i];
        }
        averaged[i] = sum / allSpectra.length;
      }

      // Restore accumulatedSpectrum with the averaged result for processSweepResults
      accumulatedSpectrum = averaged;
      frameCount = 100; // Ensure we pass the "enough data" check

      // Store a flag so processSweepResults knows averaging was done (skip re-compensation)
      window._sweepAveraged = true;

      sweepProcessTimeout = setTimeout(async () => {
        if (animationFrame) {
          cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        await processSweepResults();
      }, 500);
    }
  } catch (err) {
    console.error(err);
    statusSweepEl.textContent = "Sweep failed: " + err.message + ". Try again or re-calibrate the noise floor first.";
    statusSweepEl.className = "status danger";
    hideProgressBar("sweep");
    btnSweep.disabled = false;
  }
});
} // end btnSweep guard

// Stop and analyze (legacy sweep path — preserved for Advanced mode)
if (btnStop) {
btnStop.addEventListener("click", async () => {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  statusSweepEl.textContent = "Processing sweep response...";
  statusSweepEl.className = "status info";
  btnStop.disabled = true;
  hideProgressBar("sweep");

  try {
    if (sweepProcessTimeout) {
      clearTimeout(sweepProcessTimeout);
      sweepProcessTimeout = null;
    }
    if (sweepSource) {
      sweepSource.stop();
      sweepSource = null;
    }
    // If we have a sweep response promise, use it; otherwise fall back to peak-hold
    await processSweepResults();
  } catch (err) {
    console.error(err);
    statusSweepEl.textContent = "Processing failed: " + err.message + ". Try playing the sweep again.";
    statusSweepEl.className = "status danger";
    hideProgressBar("sweep");
    btnSweep.disabled = false;
  }
});
} // end btnStop guard

// Calibration target in dB at frequency `freq`.
// Keep this in sync with the curve shown on the live canvas to avoid visual drift.
function getCalibrationTargetDB(freq) {
  return getHarmanTargetDB(Math.max(20, Math.min(20000, freq)));
}

// Shared processing for sweep results
// @param {Float32Array} spectrum - Frequency spectrum data
// @param {Object} options - { method, calibrationData, noiseFloor }
// @param {Object} options.gainLimits - { maxGain, maxCut, bassMax }
// @param {number} options.smoothingFactor - Smoothing factor for adaptiveSmooth
// @returns {Object} Processed result with frequency data
function _processMeasurementResults(spectrum, options = {}) {
  const method = options.method || 'sweep';
  const gainLimits = options.gainLimits || { maxGain: 8, maxCut: -12, bassMax: 4 };
  const smoothingFactor = options.smoothingFactor || 1.0;
  const perBandMaxGain = options.perBandMaxGain || null;
  const perBandMaxCut = options.perBandMaxCut || null;

  const { maxGain, maxCut, bassMax } = gainLimits;
  const effectiveRange = options.effectiveRange || { low: 0, high: Infinity };
  const linearFreqLabels = analyzer.getLinearFrequencyLabels();
  const visData = generateVisualizationData(spectrum, linearFreqLabels);

  // AutoEQ-inspired processing
  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });

  // Sanitize: replace -Infinity/NaN with noise floor to avoid polluting smoothing
  const NOISE_FLOOR_DB = -120;
  for (let i = 0; i < responseArr.length; i++) {
    if (!isFinite(responseArr[i])) {
      responseArr[i] = NOISE_FLOOR_DB;
      visData[i].y = NOISE_FLOOR_DB; // also fix the source so EQ table shows values
    }
  }

  const smoothedResponse = adaptiveSmooth(responseArr, smoothingFactor);

  // Normalize: center the measurement so its average in the effective range is 0 dB.
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
    // No usable data in effective range — pass through unnormalized
    normalizedResponse.set(smoothedResponse);
  }

  // Calculate gains using a practical target curve with gentle tilt
  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const freq = visData[i].x;
    const targetOffset = getCalibrationTargetDB(freq);
    rawGains[i] = targetOffset - normalizedResponse[i];
  }

  // Apply gain limits with smooth fade-out outside effective range
  const gains = Array.from(rawGains).map((g, i) => {
    const freq = visData[i].x;
    let gain = g;

    // Determine per-band limits if available, otherwise use global limits
    let bandMaxGain = maxGain;
    let bandMaxCut = maxCut;
    if (perBandMaxGain && perBandMaxCut) {
      // Find nearest active EQ band
      let nearestBand = 0;
      let minDist = Infinity;
      for (let b = 0; b < ACTIVE_EQ_FREQS.length; b++) {
        const dist = Math.abs(Math.log10(freq) - Math.log10(ACTIVE_EQ_FREQS[b]));
        if (dist < minDist) {
          minDist = dist;
          nearestBand = b;
        }
      }
      // Only use per-band limits if frequency is close enough to a band
      if (minDist < 0.3) { // within ~2x in log space
        bandMaxGain = perBandMaxGain[nearestBand];
        bandMaxCut = perBandMaxCut[nearestBand];
      }
    }

    // Apply hard limits first
    if (freq < 100) {
      gain = Math.min(gain, bassMax);
    }
    gain = Math.max(bandMaxCut, Math.min(bandMaxGain, gain));

    // Smooth fade-out outside effective range (1 octave transition)
    if (freq < effectiveRange.low) {
      const fadeFreq = effectiveRange.low / 2;
      if (freq <= fadeFreq) {
        gain *= 0; // No correction below half the low limit
      } else {
        const ratio = Math.log2(freq / fadeFreq);
        gain *= ratio; // Linear fade in log space
      }
    } else if (freq > effectiveRange.high) {
      const fadeFreq = effectiveRange.high * 2;
      if (freq >= fadeFreq) {
        gain *= 0; // No correction above double the high limit
      } else {
        const ratio = 1 - Math.log2(freq / effectiveRange.high);
        gain *= ratio; // Linear fade in log space
      }
    }

    return gain;
  });

  return { visData, normalizedResponse, gains, rangeAvg };
}

// Process sweep results using peak-hold FFT with spectral compensation
async function processSweepResults() {
  if (sweepProcessing) return;
  sweepProcessing = true;

  // Peak-hold FFT with spectral compensation for log sweep 1/f energy distribution
  if (!accumulatedSpectrum || frameCount < 10) {
    sweepProcessing = false;
    statusSweep.textContent = "Not enough data captured. Play the sweep for at least a few seconds, or try again.";
    statusSweep.className = "status danger";
    btnStop.disabled = false;
    btnSweep.disabled = false;
    return;
  }

  let compensated;

  // Check if averaging was already done (multi-sweep mode) — skip re-compensation
  if (window._sweepAveraged) {
    // Already compensated and averaged — use directly
    compensated = accumulatedSpectrum;
    window._sweepAveraged = false; // Reset flag
  } else {
    // Single sweep — apply 1/f compensation
    const f0 = 20; // Sweep start frequency
    const sr = analyzer.audioContext.sampleRate;
    const fftSz = analyzer.analyserNode.fftSize;
    const bw = sr / fftSz;

    compensated = new Float32Array(accumulatedSpectrum.length);
    for (let i = 0; i < accumulatedSpectrum.length; i++) {
      const freq = i * bw;
      if (freq > f0) {
        compensated[i] = accumulatedSpectrum[i] + 10 * Math.log10(freq / f0);
      } else {
        compensated[i] = accumulatedSpectrum[i];
      }
    }
  }

  const corrected = analyzer.getCorrectedSpectrumFromDB(compensated);

  let minS = Infinity, maxS = -Infinity, filled = 0;
  for (let i = 0; i < corrected.length; i++) {
    if (corrected[i] > -100) {
      minS = Math.min(minS, corrected[i]);
      maxS = Math.max(maxS, corrected[i]);
      filled++;
    }
  }

  // Detailed diagnostic: raw vs compensated vs corrected at key frequencies
  if (import.meta.env.DEV) {
    const sampleRate = analyzer.audioContext.sampleRate;
    const fftSize = analyzer.analyserNode.fftSize;
    const binWidth = sampleRate / fftSize;
    const keyFreqs = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 12500, 16000];

    console.log("=== SWEEP RESULTS ===");
    console.log("Bins with signal (>-100dB):", filled, "of", corrected.length);
    console.log("Range:", minS.toFixed(1), "→", maxS.toFixed(1));
    console.log("Method: Peak-hold FFT + 1/f spectral compensation");
    console.log("Sample rate:", sampleRate, "| FFT size:", fftSize, "| Bin width:", binWidth.toFixed(1), "Hz");
    console.log("");
    console.log("=== RAW vs COMPENSATED vs CORRECTED ===");
    console.log("Freq\t| Raw dB\t| Compensated\t| Corrected dB");
    console.log("--------|-----------|---------------|---------------");
    for (const freq of keyFreqs) {
      const binIdx = Math.round(freq / binWidth);
      const raw = accumulatedSpectrum[binIdx] ?? -120;
      const comp = compensated[binIdx] ?? -120;
      const cor = corrected[binIdx] ?? -120;
      console.log(`${freq.toString().padStart(6)} Hz | ${raw.toFixed(1).padStart(8)}\t| ${comp.toFixed(1).padStart(12)}\t| ${cor.toFixed(1)}`);
    }
    console.log("");

    // Also log the noise floor range if available
    if (analyzer.noiseBuffer) {
      let noiseMin = Infinity, noiseMax = -Infinity;
      for (let i = 0; i < analyzer.noiseBuffer.length; i++) {
        if (analyzer.noiseBuffer[i] > -120) {
          noiseMin = Math.min(noiseMin, analyzer.noiseBuffer[i]);
          noiseMax = Math.max(noiseMax, analyzer.noiseBuffer[i]);
        }
      }
      console.log("Noise floor range:", noiseMin.toFixed(1), "→", noiseMax.toFixed(1), "dB");
    }
  }

  statusSweep.textContent = "Step 3 of 3: Measurement complete! Your EQ curve is ready to export.";
  statusSweep.className = "status done";
  updateStepIndicator(2, "completed");
  updateStepIndicator(3, "active");

  // Show results card BEFORE resizing canvases, otherwise getBoundingClientRect
  // returns 0x0 for hidden elements and graphs render on zero-size bitmaps.
  if (cardResults) cardResults.classList.remove("hidden");

  await new Promise((resolve) => requestAnimationFrame(resolve));
  resizeCanvases();

  // Use shared processing with realistic limits for small Bluetooth speakers
  // Focus correction on the speaker's effective range (100Hz-8kHz)
  const { visData, normalizedResponse, gains, rangeAvg } = _processMeasurementResults(corrected, {
    method: 'sweep',
    gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
    smoothingFactor: 2.5,
    effectiveRange: { low: 100, high: 8000 }
  });

  // Log final processing results at key frequencies
  if (import.meta.env.DEV) {
    const keyFreqs = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 12500, 16000];
    console.log("=== FINAL EQ CURVE ===");
    console.log("rangeAvg (normalization):", rangeAvg.toFixed(1), "dB");
    console.log("");
    console.log("Freq\t| Response dB\t| EQ Gain dB");
    console.log("--------|---------------|------------");
    for (const freq of keyFreqs) {
      const point = visData.find(v => Math.abs(v.x - freq) < freq * 0.1);
      if (point) {
        const idx = visData.indexOf(point);
        const response = normalizedResponse[idx];
        const gain = gains[idx];
        console.log(`${freq.toString().padStart(6)} Hz | ${response.toFixed(1).padStart(12)}\t| ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}`);
      }
    }
  }

  // Render graphs
  const specCtx = canvasSpectrum.getContext("2d");
  renderSpectrum(specCtx, corrected, "#ff6b6b");

  const smoothedArr = Array.from(normalizedResponse);
  const estimatedResponse = smoothedArr.map((v, i) => v + (gains[i] || 0));
  const estCtx = canvasEstimated.getContext("2d");
  renderSpectrum(estCtx, estimatedResponse, "#00f5d4");

  if (canvasEq) {
    const eqCtx = canvasEq.getContext("2d");
    renderEQCurve(eqCtx, gains);
  }

  populateEQTable(visData, gains);

  btnExportWavelet.disabled = false;
  btnExportEqMac.disabled = false;
  btnExportWavelet.dataset.gains = JSON.stringify(gains);
  btnExportEqMac.dataset.gains = JSON.stringify(gains);
  btnExportEqMac.dataset.visData = JSON.stringify(visData);
  resultsReady = true;

  // Release microphone after results are ready
  try {
    analyzer?.destroy();
  } finally {
    analyzer = null;
    if (import.meta.env.DEV) console.log("Microphone released");
  }

  // Suspend audio context to fully release microphone
  setTimeout(() => {
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.suspend().then(() => {
        if (import.meta.env.DEV) console.log("Audio context suspended");
      });
    }
  }, 100);

  accumulatedSpectrum = null;
  frameCount = 0;
  btnSweep.disabled = false;
  sweepProcessing = false;
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

/**
 * Start live pink noise calibration.
 */
function startLiveCalibration() {
  if (calibrationRunning) return;

  calibrationRunning = true;
  calibrationStartTime = performance.now();
  enableCalibrationLog(USE_SMART_CORRECTION ? 'smart' : 'legacy');
  lowInputWarningCount = 0;
  lastMeasurementResult = null;
  liveSpectrum = null;
  liveEQGains = null;

  // Reset Phase 2 stability gating state
  bestResult = null;
  bestMaxDelta = Infinity;
  validMeasurementCount = 0;
  consecutiveSNRSkips = 0;
  calibrationTimeout = null;
  previousCandidateFreqs = null; // Reset candidate stability tracking
  consecutiveLowSignalCount = 0; // Reset signal level warning counter

  // Pre-calibration health check: quick RMS check before starting
  try {
    if (analyzer && analyzer.getRMSLevel && typeof analyzer.getRMSLevel === 'function') {
      const preRms = analyzer.getRMSLevel();
      if (preRms < SILENCE_THRESHOLD_DB && statusCalibration) {
        statusCalibration.textContent = "Mic seems silent — check your device. Starting anyway...";
        statusCalibration.className = "status info";
      }
    }
  } catch {
    // getRMSLevel may throw if analyserNode is null (e.g., fresh SpectrumAnalyzer)
    // Safe to ignore — calibration will proceed with the measurement pipeline
  }

  // UI: show stop, hide calibrate, hide previous results
  if (btnCalibrate) btnCalibrate.classList.add("hidden");
  if (btnStopCalibration) btnStopCalibration.classList.remove("hidden");
  if (calibrationDelta) calibrationDelta.classList.remove("hidden");
  if (resultsSection) resultsSection.classList.add("hidden");
  if (statusCalibration) {
    statusCalibration.textContent = "Playing pink noise — listening to your room...";
    statusCalibration.className = "status recording";
  }

  // Ensure analyzer is initialized
  const ctx = initAudioContext();
  if (!analyzer) {
    analyzer = new SpectrumAnalyzer();
  }

  // Reset convergence detector with minMeasurements gate
  convergenceDetector = new ConvergenceDetector(CONVERGENCE_THRESHOLD_DB, CONVERGENCE_WINDOW_COUNT, MIN_MEASUREMENTS);

  // Initialize cumulative EQ (starts flat — zero correction)
  cumulativeEQGains = new Float32Array(ACTIVE_EQ_FREQS.length);

  // Create active EQ filter chain — 16-filter pool (smart correction) or 8 fixed bands (legacy)
  // LEGACY_8BAND: Original 8-filter creation replaced by filter pool pattern (PR-2)
  // activeEQFilters = ACTIVE_EQ_FREQS.map((freq) => { ... });
  activeEQFilters = new Array(FILTER_POOL_SIZE)
    .fill(null)
    .map(() => {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = 1000;
      filter.Q.value = 1.0;
      filter.gain.value = 0;
      return filter;
    });
  // Chain all 16 filters in series
  for (let i = 0; i < activeEQFilters.length - 1; i++) {
    activeEQFilters[i].connect(activeEQFilters[i + 1]);
  }

  // Initialize adaptive per-band gain limits (Phase 3)
  perBandMaxGain = new Float32Array(ACTIVE_EQ_FREQS.length).fill(INITIAL_PER_BAND_GAIN);
  perBandMaxCut = new Float32Array(ACTIVE_EQ_FREQS.length).fill(-INITIAL_PER_BAND_GAIN);
  perBandSaturationCount = new Uint8Array(ACTIVE_EQ_FREQS.length);
  prevBandCorrected = new Float32Array(ACTIVE_EQ_FREQS.length).fill(-120);

  // Start pink noise with active EQ filter chain inserted
  pinkNoise = new PinkNoiseSource(ctx);
  pinkNoise.setFilterChain(activeEQFilters);
  pinkNoise.start();

  // Initialize mic and start continuous measurement
  initAnalyzer(ctx).then(() => {
    // Diagnostic: verify pink noise reaches the mic (one-shot FFT check)
    if (import.meta.env.DEV || isCalibrationDebugEnabled()) {
      setTimeout(() => {
        const testSpectrum = analyzer.getCurrentSpectrum();
        const linearLabels = analyzer.getLinearFrequencyLabels();
        let peakDb = -Infinity, peakFreq = 0, binsAbove90 = 0, binsAbove100 = 0;
        for (let i = 0; i < testSpectrum.length; i++) {
          if (testSpectrum[i] > peakDb) { peakDb = testSpectrum[i]; peakFreq = linearLabels[i]; }
          if (testSpectrum[i] > -90) binsAbove90++;
          if (testSpectrum[i] > -100) binsAbove100++;
        }
        const rmsNow = analyzer.getRMSLevel();
        console.log(`[cal-diag] pink noise check: peak=${peakDb.toFixed(1)}dB @${peakFreq.toFixed(0)}Hz | bins>-90dB: ${binsAbove90} | bins>-100dB: ${binsAbove100} | RMS=${rmsNow.toFixed(1)}dB`);
        if (peakDb < -100) {
          console.warn('[cal-diag] ⚠️ Pink noise NOT reaching mic — peak below -100 dBFS. Check speaker output.');
        }
      }, 1500); // Wait 1.5s for pink noise to stabilize
    }

    // Pre-compute target curve now that analyzer has frequency labels
    computeTargetCurveCache();

    continuousMeasurement = analyzer.measureContinuous((result) => {
      onMeasurementCallback(result);
    }, MEASUREMENT_INTERVAL_MS);

    // Set 30s watchdog timeout
    calibrationTimeout = setTimeout(() => {
      if (calibrationRunning) {
        if (lastMeasurementResult) {
          onCalibrationComplete(lastMeasurementResult, { timedOut: true });
        } else {
          stopCalibration();
          if (statusCalibration) {
            statusCalibration.textContent = "Calibration timed out with no usable data.";
            statusCalibration.className = "status danger";
          }
        }
      }
    }, CALIBRATION_TIMEOUT_MS);

    // Start canvas rendering loop and store the ID for cleanup
    animationFrame = requestAnimationFrame(renderLiveCalibration);
  }).catch((err) => {
    console.error("Failed to start live calibration:", err);
    stopCalibration();
    if (statusCalibration) {
      statusCalibration.textContent = "Calibration failed — " + (err.message || "check console for details") + ". Try refreshing the page.";
      statusCalibration.className = "status danger";
    }
  });
}

/**
 * Update the 16-filter pool with parametric EQ bands.
 * Unused slots are set to gain=0 (flat).
 * @param {Object[]} bands - ParametricBand[] from synthesizeBands
 */
function updateFilterPool(bands) {
  if (!activeEQFilters || activeEQFilters.length !== FILTER_POOL_SIZE) return;
  const t = audioContext ? audioContext.currentTime : 0;
  for (let i = 0; i < FILTER_POOL_SIZE; i++) {
    const filter = activeEQFilters[i];
    if (i < bands.length) {
      filter.frequency.setTargetAtTime(bands[i].freq, t, FILTER_POOL_SMOOTHING);
      filter.gain.setTargetAtTime(bands[i].gain, t, FILTER_POOL_SMOOTHING);
      filter.Q.setTargetAtTime(bands[i].Q, t, FILTER_POOL_SMOOTHING);
    } else {
      filter.gain.setTargetAtTime(0, t, FILTER_POOL_SMOOTHING);
    }
  }
}

/**
 * Log-frequency interpolation helper for visualization/correction arrays.
 * @param {number[]} freqs
 * @param {Float32Array|number[]} values
 * @param {number} targetFreq
 * @returns {number}
 */
function interpolateLogFreqValue(freqs, values, targetFreq) {
  if (!freqs || !values || freqs.length === 0 || values.length === 0) return 0;
  if (targetFreq <= freqs[0]) return values[0] ?? 0;
  if (targetFreq >= freqs[freqs.length - 1]) return values[values.length - 1] ?? 0;

  const logTarget = Math.log10(targetFreq);
  let lo = 0, hi = freqs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (Math.log10(freqs[mid]) <= logTarget) lo = mid;
    else hi = mid;
  }

  const fLo = freqs[lo];
  const fHi = freqs[hi];
  if (fHi <= fLo) return values[lo] ?? 0;

  const t = (logTarget - Math.log10(fLo)) / (Math.log10(fHi) - Math.log10(fLo));
  const yLo = values[lo] ?? 0;
  const yHi = values[hi] ?? yLo;
  return yLo * (1 - t) + yHi * t;
}

/**
 * Process pink noise measurement through the smart correction pipeline:
 * detect → rank → synthesize → evaluate.
 * @param {Float32Array} normalizedResponse - Smoothed, normalized response (64 pts)
 * @param {Float32Array} targetCurve - Target dB at each point
 * @param {number[]} frequencies - Hz labels matching response/target
 * @returns {{ bands: ParametricBand[], gains: Float32Array, evalGains: Float32Array, evalResiduals: Float32Array, candidates: RankedCandidate[] }}
 */
function _processPinkNoiseSmartCorrection(normalizedResponse, targetCurve, frequencies, previousCandidateFreqs = null) {
  // 1. Detect candidates
  const candidates = detectCandidates(normalizedResponse, targetCurve, frequencies, {
    peakThreshold: PEAK_DETECTION_THRESHOLD,
    nullThreshold: NULL_DETECTION_THRESHOLD,
    nullRejectionWidth: NULL_REJECTION_WIDTH_HZ,
    mergeDistance: MERGE_DISTANCE_HZ,
    effectiveRange: { low: 100, high: 8000 },
  });

  // Inject stability from previous window: persistent candidates get a boost,
  // transient (new) candidates get a penalty. This reduces band toggling.
  if (previousCandidateFreqs && previousCandidateFreqs.length > 0) {
    for (const c of candidates) {
      const isPersistent = previousCandidateFreqs.some(
        prevFreq => Math.abs(c.freq - prevFreq) / Math.max(prevFreq, 20) < 0.3
      );
      c.stability = isPersistent ? 1.5 : 0.7;
    }
  }

  // 2. Rank candidates
  const rankedCandidates = rankCandidates(candidates, {
    weights: RANKING_WEIGHTS,
    lfMultiplier: LF_FOCUS_MULTIPLIER,
    lfCutoff: LF_FOCUS_CUTOFF,
    maxBands: MAX_PARAMETRIC_BANDS,
  });

  // 3. Synthesize parametric bands
  const { bands, gains } = synthesizeBands(rankedCandidates, frequencies, {
    maxCutDb: MAX_CUT_DB,
    maxBoostDb: MAX_BOOST_DB,
    boostConfidenceThreshold: BOOST_CONFIDENCE_THRESHOLD,
    boostPenalty: BOOST_PENALTY,
    qMin: Q_MIN,
    qMax: Q_MAX,
    maxBands: MAX_PARAMETRIC_BANDS,
    lfMaxQ: LF_MAX_Q,
    lfCutoff: LF_FOCUS_CUTOFF,
  });

  // 4. Evaluate at convergence frequencies for ConvergenceDetector
  const evalGains = evaluateCurveAt(bands, EVAL_FREQUENCIES);
  const evalResiduals = new Float32Array(EVAL_FREQUENCIES.length);
  for (let i = 0; i < EVAL_FREQUENCIES.length; i++) {
    const freq = EVAL_FREQUENCIES[i];
    const responseAtFreq = interpolateLogFreqValue(frequencies, normalizedResponse, freq);
    const targetAtFreq = interpolateLogFreqValue(frequencies, targetCurve, freq);
    const estimatedAfterEq = responseAtFreq + evalGains[i];
    evalResiduals[i] = targetAtFreq - estimatedAfterEq;
  }

  // 5. gains is already a Float32Array at all visData frequencies for the canvas

  return { bands, gains, evalGains, evalResiduals, candidates: rankedCandidates };
}

/**
 * Core measurement callback — called every ~500ms by measureContinuous.
 * @param {{spectrum: Float32Array, rms: number, elapsedMs: number}} result
 */
function onMeasurementCallback({ spectrum, rms, elapsedMs }) {
  // Guard: analyzer may be null after calibration completes (race condition)
  if (!analyzer) return;

  // Capture analyzer values once at the top (may become null after convergence)
  const noiseFloorRms = analyzer.getNoiseFloorRMS();
  const linearLabels = analyzer.getLinearFrequencyLabels();

  // Timeout check: if we've exceeded the watchdog, stop with last result
  if (elapsedMs > CALIBRATION_TIMEOUT_MS) {
    if (lastMeasurementResult) {
      onCalibrationComplete(lastMeasurementResult, { timedOut: true });
    } else {
      stopCalibration();
      if (statusCalibration) {
        statusCalibration.textContent = "Calibration timed out with no usable data.";
        statusCalibration.className = "status danger";
      }
    }
    return;
  }

  // SNR gating: compute noise floor and skip if SNR is too low
  if (noiseFloorRms > -100) {
    const snr = rms - noiseFloorRms;
    if (snr < SNR_THRESHOLD_DB) {
      consecutiveSNRSkips++;
      if (consecutiveSNRSkips >= 20 && statusCalibration) {
        statusCalibration.textContent = "Low signal-to-noise ratio — check speaker volume or move closer.";
        statusCalibration.className = "status danger";
      }
      return; // Skip this window entirely
    }
  }
  // Valid measurement — reset skip counter
  consecutiveSNRSkips = 0;
  validMeasurementCount++;
  // Low-input warning
  if (rms < -60) {
    lowInputWarningCount++;
    if (lowInputWarningCount >= 3 && statusCalibration) {
      statusCalibration.textContent = "Room seems quiet — try moving closer to the speaker or increasing your speaker volume.";
      statusCalibration.className = "status danger";
    }
  } else {
    lowInputWarningCount = 0;
    if (statusCalibration && statusCalibration.className === "status danger") {
      statusCalibration.textContent = "Playing pink noise — listening to your room...";
      statusCalibration.className = "status recording";
    }
  }

  // Process through the existing pipeline (NO 1/f compensation for pink noise)
  const corrected = analyzer.getCorrectedSpectrumFromDB(spectrum);
  if (!corrected) return;

  // Sanitize: replace -Infinity/NaN before pipeline so all downstream gets clean data
  for (let i = 0; i < corrected.length; i++) {
    if (!isFinite(corrected[i])) corrected[i] = -120;
  }

  // ── Branch: Smart Correction vs Legacy 8-band path ───────────────────
  if (USE_SMART_CORRECTION) {
    try {
    // SMART CORRECTION PATH: detect → rank → synthesize → filter pool
    const processResult = _processMeasurementResults(corrected, {
      method: 'pink-noise',
      gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
      perBandMaxGain: perBandMaxGain,
      perBandMaxCut: perBandMaxCut,
      smoothingFactor: 2.5,
      effectiveRange: { low: 100, high: 8000 }
    });

    // Signal level guard: skip correction only when truly no usable signal
    // rangeAvg can be negative when normalized response has more energy in highs
    // (normal for laptop speakers). Check raw signal strength instead.
    const hasUsableSignal = processResult.visData.some((v, i) => {
      const freq = v.x;
      const val = processResult.normalizedResponse[i];
      return freq >= 100 && freq <= 8000 && Number.isFinite(val) && val > -30;
    });
    const isLowSignal = !hasUsableSignal;
    if (isLowSignal) {
      consecutiveLowSignalCount++;
      if (consecutiveLowSignalCount >= LOW_SIGNAL_WINDOW_COUNT && statusCalibration) {
        statusCalibration.textContent = "Mic isn't receiving the speaker signal — try moving closer or check audio output device.";
        statusCalibration.className = "status danger";
      }
      // Update UI with flat EQ (no correction) but keep canvas and state alive
      liveSpectrum = spectrum;
      liveEQGains = new Float32Array(ACTIVE_EQ_FREQS.length);
      lastMeasurementResult = { ...processResult, gains: liveEQGains };
      if (calibrationDelta) calibrationDelta.textContent = 'Δ — dB';
      // Still feed convergence detector to keep it alive
      if (convergenceDetector) convergenceDetector.push(new Float32Array(EVAL_FREQUENCIES.length));

      // Log with empty bands (no correction applied)
      logCalibrationWindow({
        mode: 'smart',
        elapsedMs,
        rms,
        noiseFloorRms,
        rangeAvg: processResult.rangeAvg,
        linearLabels,
        rawSpectrum: spectrum,
        correctedSpectrum: corrected,
        normalizedResponse: processResult.normalizedResponse,
        visFreqs: processResult.visData.map(v => v.x),
        targetCurve: new Float32Array(0),
        bands: [],
      });
    } else {
      consecutiveLowSignalCount = 0;

      // Build target curve at visData frequencies for candidate detection
      const targetCurve = new Float32Array(processResult.visData.length);
      const freqs = processResult.visData.map(v => v.x);
      for (let i = 0; i < targetCurve.length; i++) {
        targetCurve[i] = getCalibrationTargetDB(freqs[i]);
      }

      const smartResult = _processPinkNoiseSmartCorrection(
        processResult.normalizedResponse,
        targetCurve,
        freqs,
        previousCandidateFreqs
      );

      // Persist candidate frequencies for next window's stability tracking
      previousCandidateFreqs = smartResult.candidates.map(c => c.freq);

      // Update filter pool with parametric bands
      updateFilterPool(smartResult.bands);

      // Store parametric bands for profile saving (PR-3)
      currentParametricBands = smartResult.bands;

      // Set cumulative EQ gains directly (smart correction recalculates each window)
      cumulativeEQGains = smartResult.gains;

      // Update shared state for canvas rendering
      liveSpectrum = spectrum;
      liveEQGains = smartResult.gains;
      lastMeasurementResult = { ...processResult, gains: smartResult.gains };

      // Track best result (lowest max |evalResiduals|)
      const currentMax = Math.max(...Array.from(smartResult.evalResiduals).map(Math.abs));
      if (!bestResult || currentMax < bestMaxDelta) {
        bestResult = lastMeasurementResult;
        bestMaxDelta = currentMax;
      }

      // Feed convergence detector with residual error at evaluation frequencies
      let isStable = false;
      if (convergenceDetector) {
        const convergenceResult = convergenceDetector.push(smartResult.evalResiduals);

        const maxResidual = Math.max(...Array.from(smartResult.evalResiduals).map(Math.abs));
        isStable = convergenceResult.converged
          && validMeasurementCount >= MIN_MEASUREMENTS
          && maxResidual <= SMART_RESIDUAL_THRESHOLD_DB
          && consecutiveLowSignalCount < LOW_SIGNAL_WINDOW_COUNT;

        if (import.meta.env.DEV) {
          console.log(`  Δres = ${convergenceResult.delta.toFixed(2)} dB | max|res| = ${maxResidual.toFixed(1)} dB | bands=${smartResult.bands.length} cand=${smartResult.candidates.length} ${isStable ? '✅ CONVERGED' : ''}`);
        }

        if (calibrationDelta) {
          calibrationDelta.textContent = 'Δres ' + convergenceResult.delta.toFixed(1) + ' dB';
        }

        if (isStable) {
          logCalibrationConverged(elapsedMs);
          onCalibrationComplete(lastMeasurementResult);
        }
      }

      // Log with actual bands from smart correction
      logCalibrationWindow({
        mode: 'smart',
        elapsedMs,
        rms,
        noiseFloorRms,
        rangeAvg: processResult.rangeAvg,
        linearLabels,
        rawSpectrum: spectrum,
        correctedSpectrum: corrected,
        normalizedResponse: processResult.normalizedResponse,
        visFreqs: processResult.visData.map(v => v.x),
        targetCurve,
        bands: smartResult.bands,
      });
    }
    } catch (err) {
      console.error("[SmartCorrection] Error in measurement window — skipping:", err);
      logCalibrationError(err);
    }
  } else {
    // FALLBACK: existing per-point gain computation (unchanged)
    const result = _processMeasurementResults(corrected, {
      method: 'pink-noise',
      gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
      perBandMaxGain: perBandMaxGain,
      perBandMaxCut: perBandMaxCut,
      smoothingFactor: 2.5,
      effectiveRange: { low: 100, high: 8000 }
    });

    const legacyVisFreqs = result.visData.map((v) => v.x);
    const legacyTarget = new Float32Array(legacyVisFreqs.length);
    for (let i = 0; i < legacyTarget.length; i++) {
      legacyTarget[i] = getCalibrationTargetDB(legacyVisFreqs[i]);
    }
    logCalibrationWindow({
      mode: 'legacy',
      elapsedMs,
      rms,
      noiseFloorRms,
      rangeAvg: result.rangeAvg,
      linearLabels,
      rawSpectrum: spectrum,
      correctedSpectrum: corrected,
      normalizedResponse: result.normalizedResponse,
      visFreqs: legacyVisFreqs,
      targetCurve: legacyTarget,
      pointwiseEqGains: Float32Array.from(result.gains),
    });

    // ── Active EQ: interpolate gains to filter bands and update ──────────
    const deltaGains = new Float32Array(ACTIVE_EQ_FREQS.length);
    for (let f = 0; f < ACTIVE_EQ_FREQS.length; f++) {
      const targetFreq = ACTIVE_EQ_FREQS[f];
      // Find nearest point in visData
      let gain = 0;
      const point = result.visData.find(v => Math.abs(v.x - targetFreq) < targetFreq * 0.15);
      if (point) {
        const idx = result.visData.indexOf(point);
        gain = result.gains[idx];
      }
      deltaGains[f] = gain;
    }

    // ── Adaptive per-band saturation detection (Phase 3) ─────────────────
    if (perBandSaturationCount && prevBandCorrected) {
      const binWidth = analyzer.audioContext.sampleRate / analyzer.analyserNode.fftSize;
      for (let f = 0; f < ACTIVE_EQ_FREQS.length; f++) {
        const bin = Math.round(ACTIVE_EQ_FREQS[f] / binWidth);
        const currResp = corrected[bin];
        const expected = deltaGains[f];
        const actual = isFinite(prevBandCorrected[f]) && isFinite(currResp)
          ? currResp - prevBandCorrected[f]
          : 0;

        // Detect saturation: boost expected improvement but got much less
        if (Math.abs(expected) > 1.0 && Math.abs(actual) < Math.abs(expected) * SATURATION_RATIO_THRESHOLD) {
          perBandSaturationCount[f]++;
          if (perBandSaturationCount[f] >= SATURATION_CONSECUTIVE_COUNT) {
            if (expected > 0) {
              perBandMaxGain[f] = Math.max(1.0, perBandMaxGain[f] * 0.75);
            } else {
              perBandMaxCut[f] = Math.min(-1.0, perBandMaxCut[f] * 0.75);
            }
            perBandSaturationCount[f] = 0; // reset after adjustment
          }
        } else {
          perBandSaturationCount[f] = 0;
        }
        prevBandCorrected[f] = currResp;
      }
    }
    // ── End adaptive per-band saturation detection ───────────────────────

    // Apply cumulative EQ with per-band limits
    for (let f = 0; f < ACTIVE_EQ_FREQS.length; f++) {
      // Accumulate and clamp using per-band limits if available
      cumulativeEQGains[f] += deltaGains[f];
      const bandMax = perBandMaxGain ? perBandMaxGain[f] : 4;
      const bandMin = perBandMaxCut ? perBandMaxCut[f] : -4;
      cumulativeEQGains[f] = Math.max(bandMin, Math.min(bandMax, cumulativeEQGains[f]));
      // Apply to filter
      if (activeEQFilters && activeEQFilters[f]) {
        activeEQFilters[f].gain.value = cumulativeEQGains[f];
      }
    }
    // ── End active EQ update ──────────────────────────────────────────────

    // ── Diagnostic logs ──────────────────────────────────────────────────
    if (import.meta.env.DEV) {
      const binWidth = analyzer.audioContext.sampleRate / analyzer.analyserNode.fftSize;
      const keyFreqs = ACTIVE_EQ_FREQS;
      const elapsed = (elapsedMs / 1000).toFixed(1);

      // Raw spectrum at key frequencies
      const rawVals = keyFreqs.map(f => {
        const bin = Math.round(f / binWidth);
        return spectrum[bin]?.toFixed(1) ?? '---';
      }).join(' | ');

      // Corrected (noise-subtracted + mic-corrected) at key frequencies
      const corVals = keyFreqs.map(f => {
        const bin = Math.round(f / binWidth);
        return corrected[bin]?.toFixed(1) ?? '---';
      }).join(' | ');

      // Delta gains (new correction needed this iteration)
      const dVals = keyFreqs.map((_, i) => {
        const g = deltaGains[i];
        return (g >= 0 ? '+' : '') + g.toFixed(1);
      }).join(' | ');

      // Cumulative EQ (total applied so far)
      const cVals = keyFreqs.map((_, i) => {
        const g = cumulativeEQGains[i];
        return (g >= 0 ? '+' : '') + g.toFixed(1);
      }).join(' | ');

      console.log(
        `[t=${elapsed}s] RMS=${rms.toFixed(0)}dB\n` +
        `  Freq (Hz):   ${keyFreqs.map(f => String(f).padStart(5)).join(' | ')}\n` +
        `  Raw:         ${rawVals}\n` +
        `  Corrected:   ${corVals}\n` +
        `  Δ needed:    ${dVals}\n` +
        `  Cumulative:  ${cVals}`
      );
    }
    // ── End diagnostic logs ──────────────────────────────────────────────

    // Track best result (lowest max |deltaGains|)
    const currentMax = Math.max(...Array.from(deltaGains).map(Math.abs));
    if (!bestResult || currentMax < bestMaxDelta) {
      bestResult = result;
      bestMaxDelta = currentMax;
    }

    // Update shared state for canvas rendering
    liveSpectrum = spectrum;
    liveEQGains = result.gains;
    lastMeasurementResult = result;

    // Feed convergence detector with delta gains (how much correction is still needed)
    if (convergenceDetector) {
      const { converged, delta } = convergenceDetector.push(deltaGains);

      // Active convergence: delta small AND corrections near zero
      const maxCorrection = Math.max(...Array.from(deltaGains).map(Math.abs));
      const isStable = converged && maxCorrection < 1.0;

      if (import.meta.env.DEV) {
        console.log(`  Δ = ${delta.toFixed(2)} dB | max|corr| = ${maxCorrection.toFixed(1)} dB ${isStable ? '✅ CONVERGED' : ''}`);
      }

      // Update delta label
      if (calibrationDelta) {
        calibrationDelta.textContent = 'Δ ' + delta.toFixed(1) + ' dB';
      }

      if (isStable) {
        onCalibrationComplete(result);
      }
    }
  }
  // ── End branching ──────────────────────────────────────────────────────
}

/**
 * Called when convergence is detected or timeout fires.
 * @param {Object} result
 * @param {{timedOut?: boolean}} options
 */
function onCalibrationComplete(result, options = {}) {
  // Clear the watchdog timeout
  if (calibrationTimeout) {
    clearTimeout(calibrationTimeout);
    calibrationTimeout = null;
  }

  // Stop pink noise and measurement
  if (pinkNoise) {
    pinkNoise.stop();
    pinkNoise = null;
  }
  if (continuousMeasurement) {
    continuousMeasurement.stop();
    continuousMeasurement = null;
  }

  calibrationRunning = false;

  // Save profile with dual-slot + saturation rollback
  // Profile format: { gains, timestamp, type: 'pink-noise', bands?: ParametricBand[] }
  const saveResult = saveProfile({
    gains: float32ToArray(cumulativeEQGains),
    timestamp: Date.now(),
    type: 'pink-noise',
    bands: currentParametricBands,
  });

  // Show results
  showResults(result, { timedOut: options.timedOut, rolledBack: saveResult.rolledBack });

  // Render final frame on live canvas AFTER showResults
  renderLiveCalibrationFinal();

  if (statusCalibration) {
    if (options.timedOut) {
      statusCalibration.textContent = "Calibration timed out — showing best available result. Try moving closer to the speaker.";
      statusCalibration.className = "status info";
    } else {
      statusCalibration.textContent = "Calibration complete! Your EQ is ready.";
      statusCalibration.className = "status done";
    }
  }
}

/**
 * Build a partial result from the last measurement and cumulative EQ gains.
 * Interpolates the 8 filter-band cumulative gains to the 64 log-spaced visData points.
 *
 * @param {Object} lastResult — result from last _processMeasurementResults call
 * @param {Float32Array|null} cumulativeGains — 8-band cumulative EQ
 * @returns {Object} result compatible with showResults()
 */
function _buildPartialResult(lastResult, cumulativeGains) {
  if (!cumulativeGains) return lastResult;

  const { visData, normalizedResponse } = lastResult;
  const gains = [];

  for (let i = 0; i < visData.length; i++) {
    const freq = visData[i].x;
    // Interpolate from 8 filter bands to this frequency
    gains.push(_interpolateEQGains(freq, cumulativeGains));
  }

  return { visData, normalizedResponse, gains, rangeAvg: lastResult.rangeAvg };
}

/**
 * Interpolate cumulative EQ gain at a given frequency from the 8 filter bands.
 * Uses log-frequency linear interpolation. Extrapolates flat beyond the band edges.
 *
 * @param {number} freq — target frequency in Hz
 * @param {Float32Array} gains — 8-band cumulative gains
 * @returns {number} interpolated gain in dB
 */
function _interpolateEQGains(freq, gains) {
  const freqs = ACTIVE_EQ_FREQS;
  if (freq <= freqs[0]) return gains[0];
  if (freq >= freqs[freqs.length - 1]) return gains[gains.length - 1];

  for (let i = 0; i < freqs.length - 1; i++) {
    if (freq >= freqs[i] && freq <= freqs[i + 1]) {
      const ratio = (Math.log10(freq) - Math.log10(freqs[i])) /
                    (Math.log10(freqs[i + 1]) - Math.log10(freqs[i]));
      return gains[i] + ratio * (gains[i + 1] - gains[i]);
    }
  }
  return 0;
}

/**
 * Display calibration results on the existing canvases.
 * @param {Object} result
 * @param {{timedOut?: boolean, rolledBack?: boolean}} options
 */
function showResults(result, options = {}) {
  const { visData, gains } = result;

  // Show results section FIRST so canvases have dimensions
  if (resultsSection) resultsSection.classList.remove("hidden");

  // Render on existing canvases using existing functions
  resizeCanvases();

  // Spectrum canvas: show the corrected room response
  if (canvasSpectrum && liveSpectrum) {
    const corrected = analyzer.getCorrectedSpectrumFromDB(liveSpectrum);
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

  // Enable export buttons — ensure gains is a plain Array for JSON serialization
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
  } else if (cumulativeEQGains) {
    const maxAbs = Math.max(...Array.from(cumulativeEQGains).map(Math.abs));
    if (maxAbs >= 4.0 && statusCalibration) {
      statusCalibration.textContent = "High correction applied — room may need acoustic treatment.";
      statusCalibration.className = "status info";
    }
  }

  // UI: show calibrate, hide stop
  if (btnCalibrate) btnCalibrate.classList.remove("hidden");
  if (btnStopCalibration) btnStopCalibration.classList.add("hidden");

  // Release microphone
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

/**
 * Stop calibration manually (user clicks Stop or error occurs).
 */
function stopCalibration() {
  // Clear the watchdog timeout
  if (calibrationTimeout) {
    clearTimeout(calibrationTimeout);
    calibrationTimeout = null;
  }

  // Cancel any pending animation frame to prevent resource leak
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  // Release audio resources
  if (analyzer && analyzer.destroy) {
    analyzer.destroy();
    analyzer = null;
  }

  if (!calibrationRunning && !pinkNoise && !continuousMeasurement) return;

  if (pinkNoise) {
    pinkNoise.stop();
    pinkNoise = null;
  }
  if (continuousMeasurement) {
    continuousMeasurement.stop();
    continuousMeasurement = null;
  }

  // Save cumulative EQ before cleaning up state
  const savedCumulativeGains = cumulativeEQGains ? new Float32Array(cumulativeEQGains) : null;

  calibrationRunning = false;
  activeEQFilters = null;
  cumulativeEQGains = null;
  currentParametricBands = null;

  // Reset adaptive per-band gain limits (Phase 3)
  perBandMaxGain = null;
  perBandMaxCut = null;
  perBandSaturationCount = null;
  prevBandCorrected = null;

  // UI: show calibrate, hide stop
  if (btnCalibrate) btnCalibrate.classList.remove("hidden");
  if (btnStopCalibration) btnStopCalibration.classList.add("hidden");
  if (calibrationDelta) calibrationDelta.classList.add("hidden");

  // Use best available result if partial measurement exists
  if (lastMeasurementResult && convergenceDetector && convergenceDetector.windowCount >= 2) {
    if (statusCalibration) {
      statusCalibration.textContent = "Calibration stopped early. Showing EQ from partial measurement.";
      statusCalibration.className = "status info";
    }
    // Build result using cumulative EQ gains mapped to visData points
    const partialResult = _buildPartialResult(lastMeasurementResult, savedCumulativeGains);
    saveProfile({
      gains: partialResult.gains,
      timestamp: Date.now(),
      type: 'pink-noise',
      bands: currentParametricBands,
    });
    showResults(partialResult);
    renderLiveCalibrationFinal();
  } else {
    if (statusCalibration) {
      statusCalibration.textContent = "Calibration stopped.";
      statusCalibration.className = "status";
    }
  }

  // Release microphone
  try {
    analyzer?.destroy();
  } catch { /* ignore */ }
  analyzer = null;
}

/**
 * Live canvas rendering — called via requestAnimationFrame.
 * Draws 3 lines: target curve (cached), room response (updating), estimated response after EQ.
 */
function renderLiveCalibration(timestamp, final = false) {
  if (!calibrationRunning && !final) return;

  const canvas = canvasLive;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  // Clear
  ctx.clearRect(0, 0, width * dpr, height * dpr);
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
  if (liveSpectrum && analyzer) {
    const spectrumPoints = generateVisualizationData(liveSpectrum, analyzer.getLinearFrequencyLabels());
    drawLine(spectrumPoints, "#ff6b6b");
  }

  // Line 3: Estimated response after EQ (room + correction, cyan)
  if (lastMeasurementResult?.normalizedResponse && lastMeasurementResult?.visData && liveEQGains) {
    const estimatedPoints = [];
    const freqs = lastMeasurementResult.visData.map((v) => v.x);
    for (let i = 0; i < freqs.length; i++) {
      const y = lastMeasurementResult.normalizedResponse[i] + (liveEQGains[i] || 0);
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

  // Restore parametric bands if present (smart correction persistence)
  if (profile.bands && USE_SMART_CORRECTION) {
    currentParametricBands = profile.bands;
    try {
      updateFilterPool(currentParametricBands);
    } catch {
      // Filter pool not initialized yet (no audio context) — bands will be applied on next calibration
    }
  }

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
  updateStepIndicator(3, "completed");
});

btnExportEqMac.addEventListener("click", () => {
  const gains = JSON.parse(btnExportEqMac.dataset.gains);
  const visData = JSON.parse(btnExportEqMac.dataset.visData || "[]");
  const content = exportEqMac(gains, visData);
  downloadFile("lazyeq-eqmac.json", content);
  statusExport.textContent = "eqMac preset exported — open eqMac on macOS and import the file";
  statusExport.className = "status done";
  updateStepIndicator(3, "completed");
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

if (btnCalibrate) {
  btnCalibrate.addEventListener("click", () => {
    startLiveCalibration();
  });
}

if (btnStopCalibration) {
  btnStopCalibration.addEventListener("click", () => {
    stopCalibration();
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
      await initAnalyzer(ctx);

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

      const allSpectra = [];

      for (let sweepNum = 0; sweepNum < sweepCount; sweepNum++) {
        // Reset accumulation for each sweep
        accumulatedSpectrum = null;
        frameCount = 0;

        statusLegacySweep.textContent = `Sweep ${sweepNum + 1} of ${sweepCount}...`;

        // Use a separate SineSweepSource for legacy sweep
        const legacySweep = new SineSweepSource(ctx);
        legacySweep.createBuffer(sweepDuration);

        // Wait for this sweep to complete
        await new Promise((resolve) => {
          sweepSource = legacySweep;

          legacySweep.onComplete = async () => {
            // Apply 1/f compensation to the accumulated peak-hold spectrum
            const f0 = 20;
            const sr = analyzer.audioContext.sampleRate;
            const fftSz = analyzer.analyserNode.fftSize;
            const bw = sr / fftSz;

            const compensatedSpectrum = new Float32Array(accumulatedSpectrum.length);
            for (let i = 0; i < accumulatedSpectrum.length; i++) {
              const freq = i * bw;
              if (freq > f0) {
                compensatedSpectrum[i] = accumulatedSpectrum[i] + 10 * Math.log10(freq / f0);
              } else {
                compensatedSpectrum[i] = accumulatedSpectrum[i];
              }
            }

            allSpectra.push(compensatedSpectrum);
            accumulatedSpectrum = null;
            frameCount = 0;
            sweepSource = null;
            stopLegacySweepRendering(); // Clean up animation frame
            resolve();
          };

          legacySweep.start();

          // Render on legacy canvas
          renderLiveSweepOnCanvas(canvasLiveLegacy);
        });

        // Brief pause between sweeps
        if (sweepNum < sweepCount - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // All sweeps done — average the compensated spectra
      statusLegacySweep.textContent = `Averaging ${sweepCount} sweeps...`;
      statusLegacySweep.className = "status info";

      const averaged = new Float32Array(allSpectra[0].length);
      for (let i = 0; i < averaged.length; i++) {
        let sum = 0;
        for (const spectrum of allSpectra) {
          sum += spectrum[i];
        }
        averaged[i] = sum / allSpectra.length;
      }

      accumulatedSpectrum = averaged;
      frameCount = 100;

      // Process results using the same pipeline
      const corrected = analyzer.getCorrectedSpectrumFromDB(averaged);
      const result = _processMeasurementResults(corrected, {
        method: 'sweep',
        gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
        smoothingFactor: 2.5,
        effectiveRange: { low: 100, high: 8000 }
      });

      // Show results using the shared function
      liveSpectrum = corrected;
      showResults(result);

      statusLegacySweep.textContent = "Legacy sweep complete! EQ curve ready to export.";
      statusLegacySweep.className = "status done";
      btnLegacySweep.disabled = false;

    } catch (err) {
      console.error(err);
      statusLegacySweep.textContent = "Legacy sweep failed: " + err.message;
      statusLegacySweep.className = "status danger";
      btnLegacySweep.disabled = false;
    }
  });
}

/**
 * Render live sweep on a specific canvas (used by legacy sweep).
 * @param {HTMLCanvasElement} canvas
 */
function renderLiveSweepOnCanvas(canvas) {
  if (!canvas || !analyzer) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;

  const data = analyzer.getCurrentSpectrum();
  if (!data) {
    legacyAnimationFrame = requestAnimationFrame(() => renderLiveSweepOnCanvas(canvas));
    return;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, width, height);

  // Grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    ctx.beginPath();
    ctx.moveTo(0, (g / 4) * height);
    ctx.lineTo(width, (g / 4) * height);
    ctx.stroke();
  }

  // Draw spectrum
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "#00f5d4");
  gradient.addColorStop(0.5, "#00f5d4");
  gradient.addColorStop(1, "#ffc857");

  ctx.save();
  ctx.shadowColor = "#00f5d4";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < 128; i++) {
    const logFreq = logMin + (i / 128) * (logMax - logMin);
    const freq = Math.pow(10, logFreq);
    const binIdx = Math.floor((freq / (analyzer.audioContext.sampleRate / 2)) * data.length);
    const x = (i / 128) * width;
    const db = data[Math.min(binIdx, data.length - 1)];
    const y = Math.max(0, Math.min(height, ((db + 100) / 100) * height));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Continue rendering while sweep is active, with proper tracking
  if (sweepSource) {
    legacyAnimationFrame = requestAnimationFrame(() => renderLiveSweepOnCanvas(canvas));
  }
}

/**
 * Stop legacy sweep rendering and clean up animation frame.
 */
function stopLegacySweepRendering() {
  if (legacyAnimationFrame) {
    cancelAnimationFrame(legacyAnimationFrame);
    legacyAnimationFrame = null;
  }
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
