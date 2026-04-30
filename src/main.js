/**
 * lazyEq - Sine Sweep Speaker EQ Analyzer
 * Professional frequency response measurement using logarithmic sine sweep
 */

import { SineSweepSource } from "./sineSweep.js";
import { SpectrumAnalyzer } from "./analyzer.js";
import { RoomCalibration } from "./roomCalibration.js";
import {
  exportWavelet,
  exportEqMac,
  generateVisualizationData,
  getHarmanTargetDB,
  EQMAC_BANDS,
} from "./eqGenerator.js";

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
let roomCalibration = null;
let animationFrame = null;
let frameCount = 0;
let accumulatedSpectrum = null;
let sweepDuration = 8;
let selectedMicDeviceId = null;

// DOM Elements
const btnNoise = document.getElementById("btn-noise");
const btnSweep = document.getElementById("btn-sweep");
const btnStop = document.getElementById("btn-stop");
const btnRoomWalk = document.getElementById("btn-roomwalk");
const btnExportWavelet = document.getElementById("btn-export-wavelet");
const btnExportEqMac = document.getElementById("btn-export-eqmac");
const btnRefreshDevices = document.getElementById("btn-refresh-devices");
const btnCancelRoomWalk = document.getElementById("btn-roomwalk-stop");
const statusNoise = document.getElementById("status-noise");
const statusSweep = document.getElementById("status-sweep");
const statusExport = document.getElementById("status-export");
const statusDevices = document.getElementById("status-devices");
const statusRoomWalk = document.getElementById("status-room-walk");
const micSelect = document.getElementById("mic-select");
const canvasSpectrum = document.getElementById("canvas-spectrum");
const canvasEstimated = document.getElementById("canvas-estimated");
const canvasEq = document.getElementById("canvas-eq");
const canvasLive = document.getElementById("canvas-live");
const roomWalkOverlay = document.getElementById("room-walk-overlay");
const roomwalkProgress = document.getElementById("roomwalk-progress");
const roomwalkCounter = document.getElementById("roomwalk-counter");

let audioContext = null;

function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100
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

// Defer loadDevices() to user gesture - don't call at module load
// P-7: Remove eager call at module load

// Refresh button
btnRefreshDevices.addEventListener("click", async () => {
  statusDevices.textContent = "Refreshing...";
  statusDevices.className = "status";
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
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
    const binIdx = Math.floor((freq / 22050) * data.length);
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
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  });
}

// Step 1: Capture noise floor
btnNoise.addEventListener("click", async () => {
  try {
    statusNoise.textContent = "Calibrating mic (5s silence)...";
    statusNoise.className = "status";
    btnNoise.disabled = true;

    const ctx = await ensureAudioContext();
    analyzer = new SpectrumAnalyzer();
    await analyzer.init(selectedMicDeviceId, ctx);

    statusNoise.textContent = "Recording noise floor...";
    statusNoise.className = "status recording";

    const startTime = Date.now();
    const captureDuration = 5000;

    const updateNoiseDisplay = async () => {
      if (analyzer && analyzer.getRMSLevel) {
        const db = analyzer.getRMSLevel();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        statusNoise.textContent = `Recording: ${db.toFixed(0)} dB (${elapsed}s)`;
      }
      if (Date.now() - startTime < captureDuration) {
        setTimeout(updateNoiseDisplay, 100);
      }
    };
    updateNoiseDisplay();

await analyzer.captureNoiseFloor(5);

  // Self-calibrate microphone using phone speaker (invisible to user)
  statusNoise.textContent = "Calibrating mic response...";
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
        statusNoise.textContent = "Noise floor: silent (< -100dB)";
      } else {
        statusNoise.textContent = `Noise floor: ${minDB.toFixed(0)} to ${maxDB.toFixed(0)} dB`;
      }
    } else {
      statusNoise.textContent = "Noise floor captured";
    }
    statusNoise.className = "status done";
    btnSweep.disabled = false;
    if (btnRoomWalk) {
      btnRoomWalk.disabled = false;
    }
  } catch (err) {
    console.error(err);
    statusNoise.textContent = "Error: " + err.message;
    statusNoise.className = "status danger";
    btnNoise.disabled = false;
  }
});

// Step 2: Play Sine Sweep
btnSweep.addEventListener("click", async () => {
  try {
    statusSweep.textContent = "Starting Sine Sweep (8s)...";
    statusSweep.className = "status recording";
    btnSweep.disabled = true;
    btnStop.disabled = false;

    const ctx = await ensureAudioContext();

    // Reuse existing analyzer to preserve noiseBuffer, or create new one
    if (!analyzer || !analyzer.noiseBuffer) {
      statusSweep.textContent = "Error: Please calibrate noise floor first!";
      statusSweep.className = "status danger";
      btnSweep.disabled = false;
      btnStop.disabled = true;
      return;
    }

    // Reinitialize with same audioContext but preserve noiseBuffer
    await analyzer.init(selectedMicDeviceId, ctx);

    sweepSource = new SineSweepSource(ctx);
    sweepSource.createBuffer(sweepDuration);

    sweepSource.onComplete = async () => {
      statusSweep.textContent = "Sweep finished — processing...";
      statusSweep.className = "status info";
      btnStop.disabled = true;

      setTimeout(async () => {
        if (animationFrame) {
          cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        await processSweepResults();
      }, 500);
    };

    sweepSource.start();
    renderLiveSweep();
  } catch (err) {
    console.error(err);
    statusSweep.textContent = "Error: " + err.message;
    statusSweep.className = "status danger";
    btnSweep.disabled = false;
  }
});

// Stop and analyze
btnStop.addEventListener("click", async () => {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  statusSweep.textContent = "Processing sweep response...";
  statusSweep.className = "status info";
  btnStop.disabled = true;

  try {
    if (sweepSource) {
      sweepSource.stop();
      sweepSource = null;
    }
    await processSweepResults();
  } catch (err) {
    console.error(err);
    statusSweep.textContent = "Error: " + err.message;
    statusSweep.className = "status danger";
    btnSweep.disabled = false;
  }
});

// Room Walk button event handler
if (btnRoomWalk) {
  btnRoomWalk.addEventListener("click", async () => {
    try {
      // Ensure noise floor is calibrated
      if (!analyzer || !analyzer.noiseBuffer) {
        statusNoise.textContent = "Please calibrate noise floor first!";
        statusNoise.className = "status danger";
        return;
      }

      const ctx = await ensureAudioContext();

      // Show overlay and start
      showRoomWalkOverlay();
      roomwalkProgress.style.width = "0%";
      roomwalkCounter.textContent = "Mediciones: 0/15";

      // Initialize Room Calibration with new API (audioContext, analyzer)
      roomCalibration = new RoomCalibration(ctx, analyzer);

      // Set up callbacks
      roomCalibration.onMeasurement = (current, total) => {
        roomwalkProgress.style.width = `${(current / total) * 100}%`;
        roomwalkCounter.textContent = `Mediciones: ${current}/${total}`;
      };

      roomCalibration.onComplete = async (averagedSpectrum) => {
        try {
          await processRoomWalkResults(averagedSpectrum);
          hideRoomWalkOverlay();
          statusRoomWalk.textContent = "Room calibration complete";
          statusRoomWalk.className = "status done";
        } catch (err) {
          hideRoomWalkOverlay();
          statusRoomWalk.textContent = "Error: " + err.message;
          statusRoomWalk.className = "status danger";
        }
        btnRoomWalk.disabled = false;
        roomCalibration = null;
      };

      roomCalibration.onError = (msg) => {
        hideRoomWalkOverlay();
        statusRoomWalk.textContent = "Error: " + msg;
        statusRoomWalk.className = "status danger";
        btnRoomWalk.disabled = false;
        roomCalibration = null;
      };

      statusRoomWalk.textContent = "Walk around the room...";
      statusRoomWalk.className = "status recording";

      await roomCalibration.start();

    } catch (err) {
      console.error("Room walk error:", err);
      hideRoomWalkOverlay();
      statusRoomWalk.textContent = "Error: " + err.message;
      statusRoomWalk.className = "status danger";
      btnRoomWalk.disabled = false;
    }
  });
}

// Cancel Room Walk button event handler
if (btnCancelRoomWalk) {
  btnCancelRoomWalk.addEventListener("click", () => {
    if (roomCalibration) {
      roomCalibration.stop({ cancelled: true });
      roomCalibration = null;
    }
    hideRoomWalkOverlay();
    statusRoomWalk.textContent = "Room walk cancelled";
    statusRoomWalk.className = "status";
  });
}

// Shared processing for sweep and room walk results
// @param {Float32Array} spectrum - Frequency spectrum data
// @param {Object} options - { method, calibrationData, noiseFloor }
// @param {Object} options.gainLimits - { maxGain, maxCut, bassMax }
// @param {number} options.smoothingFactor - Smoothing factor for adaptiveSmooth
// @returns {Object} Processed result with frequency data
function _processMeasurementResults(spectrum, options = {}) {
  const method = options.method || 'sweep';
  const gainLimits = options.gainLimits || { maxGain: 8, maxCut: -12, bassMax: 4 };
  const smoothingFactor = options.smoothingFactor || 1.0;

  const { maxGain, maxCut, bassMax } = gainLimits;
  const linearFreqLabels = analyzer.getLinearFrequencyLabels();
  const visData = generateVisualizationData(spectrum, linearFreqLabels);

  // AutoEQ-inspired processing
  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });

  const smoothedResponse = adaptiveSmooth(responseArr, smoothingFactor);

  // Normalize: center the measurement so its average in 100Hz-10kHz is 0 dB.
  // NOTE: rangeAvg acts as a global gain offset in final EQ curve (gain = target - measurement + rangeAvg).
  // This offset is benign — it does not alter the shape of the EQ, and digital preamp (eqMac export)
  // absorbs it automatically. No audible impact.
  let sumRange = 0, countRange = 0;
  for (let i = 0; i < smoothedResponse.length; i++) {
    const freq = visData[i].x;
    if (freq >= 100 && freq <= 10000 && smoothedResponse[i] > -90 && isFinite(smoothedResponse[i])) {
      sumRange += smoothedResponse[i];
      countRange++;
    }
  }
  const rangeAvg = countRange > 0 ? sumRange / countRange : 0;

  const normalizedResponse = new Float32Array(smoothedResponse.length);
  for (let i = 0; i < smoothedResponse.length; i++) {
    normalizedResponse[i] = smoothedResponse[i] - rangeAvg;
  }

  // Calculate gains (Harman target from eqGenerator)
  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const targetOffset = getHarmanTargetDB(visData[i].x);
    rawGains[i] = targetOffset - normalizedResponse[i];
  }

  const gains = Array.from(rawGains).map((g, i) => {
    let gain = g;
    if (visData[i].x < 100) {
      gain = Math.min(gain, bassMax);
    }
    gain = Math.max(maxCut, Math.min(maxGain, gain));
    return gain;
  });

  return { visData, normalizedResponse, gains, rangeAvg };
}

// Process sweep results
async function processSweepResults() {
  if (!accumulatedSpectrum || frameCount < 10) {
    statusSweep.textContent = "Need more data — play sweep longer!";
    statusSweep.className = "status danger";
    btnStop.disabled = false;
    btnSweep.disabled = false;
    return;
  }

  const corrected = analyzer.getCorrectedSpectrumFromDB(accumulatedSpectrum);

  let minS = Infinity, maxS = -Infinity, filled = 0;
  for (let i = 0; i < accumulatedSpectrum.length; i++) {
    if (accumulatedSpectrum[i] > -100) {
      minS = Math.min(minS, accumulatedSpectrum[i]);
      maxS = Math.max(maxS, accumulatedSpectrum[i]);
      filled++;
    }
  }
  if (import.meta.env.DEV) {
    console.log("=== SWEEP RESULTS ===");
    console.log("Total frames captured:", frameCount);
    console.log("Bins with signal (>-100dB):", filled, "of", accumulatedSpectrum.length);
    console.log("Peak held range:", minS.toFixed(1), "→", maxS.toFixed(1));
  }

  statusSweep.textContent = "Sweep analysis complete (Harman target)";
  statusSweep.className = "status done";

  await new Promise((resolve) => requestAnimationFrame(resolve));
  resizeCanvases();

  // Use shared processing
  const { visData, normalizedResponse, gains, rangeAvg } = _processMeasurementResults(corrected, {
    method: 'sweep',
    gainLimits: { maxGain: 8, maxCut: -12, bassMax: 4 },
    smoothingFactor: 1.0
  });

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
}

// Export handlers
btnExportWavelet.addEventListener("click", () => {
  const gains = JSON.parse(btnExportWavelet.dataset.gains);
  const content = exportWavelet(gains);
  downloadFile("lazyeq-wavelet.txt", content);
  statusExport.textContent = "Wavelet preset exported";
  statusExport.className = "status done";
});

btnExportEqMac.addEventListener("click", () => {
  const gains = JSON.parse(btnExportEqMac.dataset.gains);
  const content = exportEqMac(gains);
  downloadFile("lazyeq-eqmac.json", content);
  statusExport.textContent = "eqMac preset exported";
  statusExport.className = "status done";
});

// Room Walk UI Functions
function showRoomWalkOverlay() {
  if (roomWalkOverlay) {
    roomWalkOverlay.classList.remove("hidden");
  }
}

function hideRoomWalkOverlay() {
  if (roomWalkOverlay) {
    roomWalkOverlay.classList.add("hidden");
  }
}

async function processRoomWalkResults(averagedSpectrum) {
  if (!averagedSpectrum) {
    statusRoomWalk.textContent = "No valid measurements captured";
    statusRoomWalk.className = "status danger";
    return;
  }

  await new Promise((resolve) => requestAnimationFrame(resolve));
  resizeCanvases();

  // Apply mic correction curve to the averaged spectrum.
  // (Noise subtraction is intentionally skipped — the guard condition
  //  signalLinear > noiseLinear * 1.5 makes no sense on already-averaged data,
  //  and spatial averaging already attenuates random noise.)
  const micCorrectedAvg = new Float32Array(averagedSpectrum.length);
  if (analyzer.micCorrectionCurve) {
    for (let i = 0; i < averagedSpectrum.length; i++) {
      micCorrectedAvg[i] = averagedSpectrum[i] - analyzer.micCorrectionCurve[i];
    }
  } else {
    micCorrectedAvg.set(averagedSpectrum);
  }

  // Use shared processing with room walk gain limits
  const { visData, normalizedResponse, gains, rangeAvg } = _processMeasurementResults(micCorrectedAvg, {
    method: 'room',
    gainLimits: { maxGain: 6, maxCut: -9, bassMax: 3 },
    smoothingFactor: 1.5
  });

  // Render graphs
  const specCtx = canvasSpectrum.getContext("2d");
  renderSpectrum(specCtx, Array.from(micCorrectedAvg).map((v, i) => v - rangeAvg), "#ff6b6b");

  const smoothedArr = Array.from(normalizedResponse);
  const estimatedResponse = smoothedArr.map((v, i) => v + (gains[i] || 0));
  const estCtx = canvasEstimated.getContext("2d");
  renderSpectrum(estCtx, estimatedResponse, "#00f5d4");

  if (canvasEq) {
    const eqCtx = canvasEq.getContext("2d");
    renderEQCurve(eqCtx, gains);
  }

  populateEQTable(visData, gains);

  // Enable export buttons
  btnExportWavelet.disabled = false;
  btnExportEqMac.disabled = false;
  btnExportWavelet.dataset.gains = JSON.stringify(gains);
  btnExportEqMac.dataset.gains = JSON.stringify(gains);

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
}

window.addEventListener("resize", resizeCanvases);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeCanvases);
}

// Initialize all canvases
resizeCanvases();
if (import.meta.env.DEV) console.log("lazyEq (Sine Sweep mode) initialized");

/** Dist verification hook — string must remain in bundle for `npm test` (test.js). */
globalThis.lazyEqTest = { mode: "sine-sweep", version: "1.0.0" };
