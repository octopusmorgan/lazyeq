/**
 * lazyEq - Sine Sweep Speaker EQ Analyzer
 * Product: AcousticForge
 */

import {
  SineSweepSource,
  SpectrumAnalyzer,
  RoomCalibration,
  getLinearFrequencyLabels,
  adaptiveSmooth,
  normalizeSpectrum,
  getHarmanTargetDB,
  calculateGains,
  generateVisualizationData,
  exportWavelet,
  exportEqMac,
  SAMPLE_RATE
} from '@acoustic-forge/core';
import { renderSpectrum, renderEQCurve, resizeCanvases } from '@acoustic-forge/ui';
import { downloadFile, EQMAC_BANDS } from '@acoustic-forge/shared';

// Application state
let analyzer = null;
let sweepSource = null;
let roomCalibration = null;
let animationFrame = null;
let frameCount = 0;
let accumulatedSpectrum = null;
let selectedMicDeviceId = null;
let audioContext = null;
let sweepProcessing = false; // guard against double-processing (onComplete vs btnStop race)

// DOM Elements
const getElements = () => ({
  btnNoise: document.getElementById("btn-noise"),
  btnSweep: document.getElementById("btn-sweep"),
  btnStop: document.getElementById("btn-stop"),
  btnRoomWalk: document.getElementById("btn-roomwalk"),
  btnExportWavelet: document.getElementById("btn-export-wavelet"),
  btnExportEqMac: document.getElementById("btn-export-eqmac"),
  btnRefreshDevices: document.getElementById("btn-refresh-devices"),
  btnCancelRoomWalk: document.getElementById("btn-roomwalk-stop"),
  statusNoise: document.getElementById("status-noise"),
  statusSweep: document.getElementById("status-sweep"),
  statusExport: document.getElementById("status-export"),
  statusDevices: document.getElementById("status-devices"),
  statusRoomWalk: document.getElementById("status-room-walk"),
  micSelect: document.getElementById("mic-select"),
  canvasSpectrum: document.getElementById("canvas-spectrum"),
  canvasEstimated: document.getElementById("canvas-estimated"),
  canvasEq: document.getElementById("canvas-eq"),
  canvasLive: document.getElementById("canvas-live"),
  roomWalkOverlay: document.getElementById("room-walk-overlay"),
  roomwalkProgress: document.getElementById("roomwalk-progress"),
  roomwalkCounter: document.getElementById("roomwalk-counter")
});

// Initialize AudioContext
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
  const { micSelect, statusDevices } = getElements();
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

// Live sweep rendering
function renderLiveSweep() {
  const { canvasLive } = getElements();
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

  ctx.fillStyle = "rgba(0, 245, 212, 0.8)";
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.fillText(`${frameCount} frames`, 8, 16);

  animationFrame = requestAnimationFrame(renderLiveSweep);
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

// Process measurement results
function processMeasurementResults(spectrum, options = {}) {
  const { method = 'sweep', gainLimits = { maxGain: 8, maxCut: -12, bassMax: 4 }, smoothingFactor = 1.0 } = options;

  const linearFreqLabels = getLinearFrequencyLabels();
  const visData = generateVisualizationData(spectrum, linearFreqLabels);

  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });

  const smoothedResponse = adaptiveSmooth(responseArr, smoothingFactor);

  const { normalized, rangeAvg } = normalizeSpectrum(smoothedResponse, visData);

  const gains = calculateGains(visData, normalized, gainLimits);

  return { visData, normalized, gains, rangeAvg };
}

// Process sweep results
async function processSweepResults() {
  const { canvasSpectrum, canvasEstimated, canvasEq, statusSweep, btnSweep, btnExportWavelet, btnExportEqMac } = getElements();

  if (!accumulatedSpectrum || frameCount < 10) {
    statusSweep.textContent = "Need more data — play sweep longer!";
    statusSweep.className = "status danger";
    return;
  }

  const corrected = analyzer.getCorrectedSpectrumFromDB(accumulatedSpectrum);

  statusSweep.textContent = "Sweep analysis complete (Harman target)";
  statusSweep.className = "status done";

  await new Promise((resolve) => requestAnimationFrame(resolve));
  resizeCanvases([canvasSpectrum, canvasEstimated, canvasEq, canvasLive]);

  const { visData, normalized, gains, rangeAvg } = processMeasurementResults(corrected, {
    method: 'sweep',
    gainLimits: { maxGain: 8, maxCut: -12, bassMax: 4 },
    smoothingFactor: 1.0
  });

  renderSpectrum(canvasSpectrum.getContext("2d"), corrected, "#ff6b6b");

  const smoothedArr = Array.from(normalized);
  const estimatedResponse = smoothedArr.map((v, i) => v + (gains[i] || 0));
  renderSpectrum(canvasEstimated.getContext("2d"), estimatedResponse, "#00f5d4");

  if (canvasEq) {
    renderEQCurve(canvasEq.getContext("2d"), gains);
  }

  populateEQTable(visData, gains);

  btnExportWavelet.disabled = false;
  btnExportEqMac.disabled = false;
  btnExportWavelet.dataset.gains = JSON.stringify(gains);
  btnExportEqMac.dataset.gains = JSON.stringify(gains);

  try {
    analyzer?.destroy();
  } finally {
    analyzer = null;
  }

  setTimeout(() => {
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.suspend();
    }
  }, 100);

  accumulatedSpectrum = null;
  frameCount = 0;
  btnSweep.disabled = false;
}

// Process room walk results
async function processRoomWalkResults(averagedSpectrum) {
  const { canvasSpectrum, canvasEstimated, canvasEq, statusRoomWalk, btnSweep, btnExportWavelet, btnExportEqMac } = getElements();

  if (!averagedSpectrum) {
    statusRoomWalk.textContent = "No valid measurements captured";
    statusRoomWalk.className = "status danger";
    return;
  }

  await new Promise((resolve) => requestAnimationFrame(resolve));
  resizeCanvases([canvasSpectrum, canvasEstimated, canvasEq]);

  const micCorrectedAvg = new Float32Array(averagedSpectrum.length);
  if (analyzer.micCorrectionCurve) {
    for (let i = 0; i < averagedSpectrum.length; i++) {
      micCorrectedAvg[i] = averagedSpectrum[i] - analyzer.micCorrectionCurve[i];
    }
  } else {
    micCorrectedAvg.set(averagedSpectrum);
  }

  const { visData, normalized, gains, rangeAvg } = processMeasurementResults(micCorrectedAvg, {
    method: 'room',
    gainLimits: { maxGain: 6, maxCut: -9, bassMax: 3 },
    smoothingFactor: 1.5
  });

  renderSpectrum(canvasSpectrum.getContext("2d"), Array.from(micCorrectedAvg).map((v, i) => v - rangeAvg), "#ff6b6b");

  const smoothedArr = Array.from(normalized);
  const estimatedResponse = smoothedArr.map((v, i) => v + (gains[i] || 0));
  renderSpectrum(canvasEstimated.getContext("2d"), estimatedResponse, "#00f5d4");

  if (canvasEq) {
    renderEQCurve(canvasEq.getContext("2d"), gains);
  }

  populateEQTable(visData, gains);

  btnExportWavelet.disabled = false;
  btnExportEqMac.disabled = false;
  btnExportWavelet.dataset.gains = JSON.stringify(gains);
  btnExportEqMac.dataset.gains = JSON.stringify(gains);

  try {
    analyzer?.destroy();
  } finally {
    analyzer = null;
  }

  setTimeout(() => {
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.suspend();
    }
  }, 100);

  accumulatedSpectrum = null;
  frameCount = 0;
  btnSweep.disabled = false;
}

// Room walk UI functions
function showRoomWalkOverlay() {
  const { roomWalkOverlay } = getElements();
  if (roomWalkOverlay) roomWalkOverlay.classList.remove("hidden");
}

function hideRoomWalkOverlay() {
  const { roomWalkOverlay } = getElements();
  if (roomWalkOverlay) roomWalkOverlay.classList.add("hidden");
}

// Initialize event handlers
export function initApp() {
  const elements = getElements();

  // Refresh devices
  elements.btnRefreshDevices.addEventListener("click", async () => {
    elements.statusDevices.textContent = "Refreshing...";
    elements.statusDevices.className = "status";
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {}
    await loadDevices();
  });

  // Mic selection change
  elements.micSelect.addEventListener("change", () => {
    selectedMicDeviceId = elements.micSelect.value;
  });

  // Noise floor calibration
  elements.btnNoise.addEventListener("click", async () => {
    try {
      elements.statusNoise.textContent = "Calibrating mic (5s silence)...";
      elements.statusNoise.className = "status";
      elements.btnNoise.disabled = true;

      const ctx = await ensureAudioContext();
      analyzer = new SpectrumAnalyzer();
      await analyzer.init(selectedMicDeviceId, ctx);

      elements.statusNoise.textContent = "Recording noise floor...";
      elements.statusNoise.className = "status recording";

      const startTime = Date.now();
      const captureDuration = 5000;

      const updateNoiseDisplay = async () => {
        if (analyzer && analyzer.getRMSLevel) {
          const db = analyzer.getRMSLevel();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          elements.statusNoise.textContent = `Recording: ${db.toFixed(0)} dB (${elapsed}s)`;
        }
        if (Date.now() - startTime < captureDuration) {
          setTimeout(updateNoiseDisplay, 100);
        }
      };
      updateNoiseDisplay();

      await analyzer.captureNoiseFloor(5);

      elements.statusNoise.textContent = "Calibrating mic response...";
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
          elements.statusNoise.textContent = "Noise floor: silent (< -100dB)";
        } else {
          elements.statusNoise.textContent = `Noise floor: ${minDB.toFixed(0)} to ${maxDB.toFixed(0)} dB`;
        }
      } else {
        elements.statusNoise.textContent = "Noise floor captured";
      }
      elements.statusNoise.className = "status done";
      elements.btnSweep.disabled = false;
      if (elements.btnRoomWalk) elements.btnRoomWalk.disabled = false;
    } catch (err) {
      console.error(err);
      elements.statusNoise.textContent = "Error: " + err.message;
      elements.statusNoise.className = "status danger";
      elements.btnNoise.disabled = false;
    }
  });

  // Sine sweep
  elements.btnSweep.addEventListener("click", async () => {
    try {
      elements.statusSweep.textContent = "🔊 Keep the phone pointing at the speaker. Sine Sweep (8s)...";
      elements.statusSweep.className = "status recording";
      elements.btnSweep.disabled = true;
      elements.btnStop.disabled = false;
      sweepProcessing = false;

      const ctx = await ensureAudioContext();

      if (!analyzer || !analyzer.noiseBuffer) {
        elements.statusSweep.textContent = "Error: Please calibrate noise floor first!";
        elements.statusSweep.className = "status danger";
        elements.btnSweep.disabled = false;
        elements.btnStop.disabled = true;
        return;
      }

      await analyzer.init(selectedMicDeviceId, ctx);

      sweepSource = new SineSweepSource(ctx);
      sweepSource.createBuffer(8);

      sweepSource.onComplete = async () => {
        // Guard: btnStop may have already triggered processing
        if (sweepProcessing) return;
        sweepProcessing = true;

        elements.statusSweep.textContent = "Sweep finished — processing...";
        elements.statusSweep.className = "status info";
        elements.btnStop.disabled = true;

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
      elements.statusSweep.textContent = "Error: " + err.message;
      elements.statusSweep.className = "status danger";
      elements.btnSweep.disabled = false;
    }
  });

  // Stop sweep
  elements.btnStop.addEventListener("click", async () => {
    // Guard: onComplete may have already triggered processing
    if (sweepProcessing) return;
    sweepProcessing = true;

    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }

    elements.statusSweep.textContent = "Processing sweep response...";
    elements.statusSweep.className = "status info";
    elements.btnStop.disabled = true;

    try {
      if (sweepSource) {
        sweepSource.stop();
        sweepSource = null;
      }
      await processSweepResults();
    } catch (err) {
      console.error(err);
      elements.statusSweep.textContent = "Error: " + err.message;
      elements.statusSweep.className = "status danger";
      elements.btnSweep.disabled = false;
    }
  });

  // Room walk
  if (elements.btnRoomWalk) {
    elements.btnRoomWalk.addEventListener("click", async () => {
      try {
        if (!analyzer || !analyzer.noiseBuffer) {
          elements.statusNoise.textContent = "Please calibrate noise floor first!";
          elements.statusNoise.className = "status danger";
          return;
        }

        const ctx = await ensureAudioContext();

        showRoomWalkOverlay();
        elements.roomwalkProgress.style.width = "0%";
        elements.roomwalkCounter.textContent = "Measurements: 0/15";

        roomCalibration = new RoomCalibration(ctx, analyzer);

        roomCalibration.onMeasurement = (current, total) => {
          elements.roomwalkProgress.style.width = `${(current / total) * 100}%`;
          elements.roomwalkCounter.textContent = `Measurements: ${current}/${total}`;
        };

        roomCalibration.onComplete = async (averagedSpectrum) => {
          try {
            await processRoomWalkResults(averagedSpectrum);
            hideRoomWalkOverlay();
            elements.statusRoomWalk.textContent = "Room calibration complete";
            elements.statusRoomWalk.className = "status done";
          } catch (err) {
            hideRoomWalkOverlay();
            elements.statusRoomWalk.textContent = "Error: " + err.message;
            elements.statusRoomWalk.className = "status danger";
          }
          elements.btnRoomWalk.disabled = false;
          roomCalibration = null;
        };

        roomCalibration.onError = (msg) => {
          hideRoomWalkOverlay();
          elements.statusRoomWalk.textContent = "Error: " + msg;
          elements.statusRoomWalk.className = "status danger";
          elements.btnRoomWalk.disabled = false;
          roomCalibration = null;
        };

        elements.statusRoomWalk.textContent = "🔊 Keep the phone pointing at the speaker. Do not rotate it.";
        elements.statusRoomWalk.className = "status recording";

        await roomCalibration.start();
      } catch (err) {
        console.error("Room walk error:", err);
        hideRoomWalkOverlay();
        elements.statusRoomWalk.textContent = "Error: " + err.message;
        elements.statusRoomWalk.className = "status danger";
        elements.btnRoomWalk.disabled = false;
      }
    });
  }

  // Cancel room walk
  if (elements.btnCancelRoomWalk) {
    elements.btnCancelRoomWalk.addEventListener("click", () => {
      if (roomCalibration) {
        roomCalibration.stop({ cancelled: true });
        roomCalibration = null;
      }
      hideRoomWalkOverlay();
      elements.statusRoomWalk.textContent = "Room walk cancelled";
      elements.statusRoomWalk.className = "status";
    });
  }

  // Export handlers
  elements.btnExportWavelet.addEventListener("click", () => {
    const gains = JSON.parse(elements.btnExportWavelet.dataset.gains);
    const content = exportWavelet(gains);
    downloadFile("acousticforge-wavelet.txt", content);
    elements.statusExport.textContent = "Wavelet preset exported";
    elements.statusExport.className = "status done";
  });

  elements.btnExportEqMac.addEventListener("click", () => {
    const gains = JSON.parse(elements.btnExportEqMac.dataset.gains);
    const content = exportEqMac(gains);
    downloadFile("acousticforge-eqmac.json", content);
    elements.statusExport.textContent = "eqMac preset exported";
    elements.statusExport.className = "status done";
  });

  // Resize handler
  const { canvasSpectrum, canvasEstimated, canvasEq, canvasLive } = elements;
  const allCanvases = [canvasSpectrum, canvasEstimated, canvasEq, canvasLive].filter(Boolean);

  function handleResize() {
    resizeCanvases(allCanvases);
  }

  window.addEventListener("resize", handleResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
  }

  handleResize();

  if (import.meta.env.DEV) console.log("AcousticForge lazyEq initialized");
}

// Dist verification hook
globalThis.lazyEqTest = { mode: "sine-sweep", version: "1.0.0" };

export { audioContext };