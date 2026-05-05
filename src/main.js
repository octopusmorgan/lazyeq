/**
 * lazyEq - Sine Sweep Speaker EQ Analyzer
 * Professional frequency response measurement using logarithmic sine sweep
 */

import { SineSweepSource } from "./sineSweep.js";
import { SpectrumAnalyzer } from "./analyzer.js";
import { RemoteMicHost } from "./webrtc/remoteMicHost.js";
import { generateQRDataUrl } from "./webrtc/qrCode.js";
import { resolveSignalingUrl, isPrivateOrLocalHostname } from "./webrtc/networkDiscovery.js";
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
import { saveProfile, loadProfile, loadPreviousProfile, isProfileSaturated } from "./persistence.js";
import { PINK_NOISE_GAIN, MEASUREMENT_INTERVAL_MS, CONVERGENCE_THRESHOLD_DB, CONVERGENCE_WINDOW_COUNT, SNR_THRESHOLD_DB, MIN_MEASUREMENTS, CALIBRATION_TIMEOUT_MS, SILENCE_THRESHOLD_DB } from "./constants.js";

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
let remoteMicHost = null;
let isRemoteMicActive = false;
let sweepProcessing = false;
let sweepProcessTimeout = null;

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

// Phase 2 stability gating state
let bestResult = null;           // best measurement result (lowest max delta)
let bestMaxDelta = Infinity;     // lowest max(|deltaGains|) seen
let validMeasurementCount = 0;   // non-SNR-gated windows
let consecutiveSNRSkips = 0;     // consecutive SNR-gated skips
let calibrationTimeout = null;   // setTimeout ID for 30s watchdog

// Active EQ state — filter chain applied to pink noise in real time
const ACTIVE_EQ_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
let activeEQFilters = null;   // BiquadFilterNode[] inserted in pink noise path
let cumulativeEQGains = null; // Float32Array(8) — running total of applied EQ

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

// Remote Mic DOM Elements
const btnRemoteMic = document.getElementById("btn-remote-mic");
const remoteMicStatus = document.getElementById("remote-mic-status");
const remoteMicCodePanel = document.getElementById("remote-mic-code");
const remoteMicUrl = document.getElementById("remote-mic-url");
const remoteMicQr = document.getElementById("remote-mic-qr");
const remoteCodeDigits = document.getElementById("remote-code-digits");
const remoteMicServerInput = document.getElementById("remote-mic-server");
const remoteMicPublicUrlInput = document.getElementById("remote-mic-public-url");
const remoteMicServerHint = document.getElementById("remote-mic-server-hint");
const remoteMicConnectedBadge = document.getElementById("remote-mic-connected");
const sweepInstructions = document.getElementById("sweep-instructions");

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

// ─── Remote Mic Server URL Detection ───────────────────────────────

let detectedSignalingUrl = null;

async function initSignalingDetection() {
  const hostname = window.location.hostname;

  if (isPrivateOrLocalHostname(hostname)) {
    // Local network — use Vite's /signaling proxy when HTTPS, direct ws:// when HTTP
    if (window.location.protocol === "https:") {
      // HTTPS: use Vite WebSocket proxy (avoids certificate issues on port 3001)
      detectedSignalingUrl = `${window.location.origin.replace(/^https/, 'wss')}/signaling`;
      if (remoteMicServerInput) {
        remoteMicServerInput.value = detectedSignalingUrl;
      }
      if (remoteMicServerHint) {
        remoteMicServerHint.textContent = "Auto-detected: using Vite /signaling proxy (HTTPS).";
      }
    } else {
      // HTTP: direct ws:// connection
      detectedSignalingUrl = `ws://${hostname}:3001`;
      if (remoteMicServerInput) {
        remoteMicServerInput.value = detectedSignalingUrl;
      }
      if (remoteMicServerHint) {
        remoteMicServerHint.textContent = "Auto-detected LAN address. Use Firefox on the phone (Chrome blocks mic on HTTP).";
      }
    }
    return;
  }

  // Tunnel mode (HTTPS with public domain like ngrok, loca.lt, etc.)
  // Use Vite's proxy: WebSocket is served from the same origin at /signaling
  if (window.location.protocol === 'https:') {
    const tunnelUrl = `${window.location.origin.replace(/^http/, 'ws')}/signaling`;
    detectedSignalingUrl = tunnelUrl;
    if (remoteMicServerInput) {
      remoteMicServerInput.value = tunnelUrl;
    }
    if (remoteMicServerHint) {
      remoteMicServerHint.textContent = "Tunnel mode: using /signaling proxy. Only 1 tunnel needed.";
    }
    if (remoteMicPublicUrlInput && !remoteMicPublicUrlInput.value) {
      remoteMicPublicUrlInput.value = window.location.origin;
    }
    if (import.meta.env.DEV) console.log("[RemoteMic] Tunnel mode detected. Signaling URL:", tunnelUrl);
    return;
  }

  // Public tunnel — try WebRTC IP discovery automatically
  if (remoteMicServerHint) {
    remoteMicServerHint.textContent = "Detecting local IP via WebRTC...";
  }

  try {
    const url = await resolveSignalingUrl(hostname);
    if (url) {
      detectedSignalingUrl = url;
      if (remoteMicServerInput) {
        remoteMicServerInput.value = url;
      }
      if (remoteMicServerHint) {
        remoteMicServerHint.textContent = "Auto-detected via WebRTC. Both devices must be on the same Wi-Fi.";
      }
      if (import.meta.env.DEV) console.log("[RemoteMic] Auto-discovered signaling URL:", url);
      return;
    }
  } catch (e) {
    if (import.meta.env.DEV) console.warn("[RemoteMic] Auto-discovery failed:", e);
  }

  // Fallback: manual input required
  if (remoteMicServerInput) {
    remoteMicServerInput.value = "";
    remoteMicServerInput.placeholder = "ws://192.168.1.42:3001";
  }
  if (remoteMicServerHint) {
    remoteMicServerHint.innerHTML = `<span style="color:#fc5c5c">Could not auto-detect.</span> Enter your PC's local Wi-Fi IP (run <code>ipconfig</code> or <code>ifconfig</code>) with port 3001.`;
  }
}

// Kick off detection immediately (does not block app init)
initSignalingDetection();

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

// ─── Remote Mic Integration ──────────────────────────────────────────

async function initAnalyzer(ctx) {
  const hasRemote = !!(remoteMicHost && remoteMicHost.remoteStream);
  if (import.meta.env.DEV) {
    console.log("[initAnalyzer] isRemoteMicActive:", isRemoteMicActive);
    console.log("[initAnalyzer] remoteMicHost exists:", !!remoteMicHost);
    console.log("[initAnalyzer] remoteStream exists:", !!(remoteMicHost && remoteMicHost.remoteStream));
    console.log("[initAnalyzer] AudioContext state:", ctx?.state);
    if (hasRemote) {
      const track = remoteMicHost.remoteStream.getAudioTracks()[0];
      console.log("[initAnalyzer] Remote track state:", {
        enabled: track?.enabled,
        muted: track?.muted,
        readyState: track?.readyState
      });
    }
  }
  if (hasRemote) {
    await analyzer.init(remoteMicHost.remoteStream, ctx);
    if (import.meta.env.DEV) console.log("[Analyzer] Using REMOTE stream:", remoteMicHost.remoteStream.id);
  } else {
    await analyzer.init(selectedMicDeviceId, ctx);
    if (import.meta.env.DEV) console.log("[Analyzer] Using LOCAL mic:", selectedMicDeviceId);
    // Permission granted — refresh device list to get proper labels
    await loadDevices();
  }
}

function disconnectRemoteMic() {
  if (remoteMicHost) {
    remoteMicHost.disconnect();
    remoteMicHost = null;
  }
  isRemoteMicActive = false;
  if (btnRemoteMic) {
    btnRemoteMic.textContent = "📱 Use Remote Mic";
    btnRemoteMic.disabled = false;
  }
  if (remoteMicStatus) {
    remoteMicStatus.textContent = "";
    remoteMicStatus.className = "status";
  }
  if (remoteMicCodePanel) remoteMicCodePanel.classList.add("hidden");
  if (remoteMicQr) {
    remoteMicQr.src = "";
    remoteMicQr.style.display = "block";
  }
  if (remoteMicConnectedBadge) remoteMicConnectedBadge.classList.add("hidden");
  if (micSelect) micSelect.disabled = false;
  if (sweepInstructions) {
    sweepInstructions.textContent = "Connect your speaker via Bluetooth. We'll play a sweep (20Hz–20kHz) and capture the response.";
  }
}

if (btnRemoteMic) {
  btnRemoteMic.addEventListener("click", async () => {
    if (isRemoteMicActive) {
      disconnectRemoteMic();
      return;
    }

    try {
      btnRemoteMic.disabled = true;
      remoteMicStatus.textContent = "Starting remote mic server...";
      remoteMicStatus.className = "status";

      // Determine signaling URL from input or auto-detect
      let signalingUrl = remoteMicServerInput?.value?.trim();
      if (!signalingUrl) {
        if (!detectedSignalingUrl) {
          remoteMicStatus.textContent = "Please enter your PC's local Wi-Fi IP in the Signaling Server field above.";
          remoteMicStatus.className = "status danger";
          btnRemoteMic.disabled = false;
          return;
        }
        signalingUrl = detectedSignalingUrl;
      }

      // Determine the URL the phone will use to open remote-mic.html.
      // Priority: 1) manual public URL input, 2) current HTTPS origin (ngrok/tunnel), 3) local IP
      let publicBaseUrl = remoteMicPublicUrlInput?.value?.trim();
      if (!publicBaseUrl) {
        if (window.location.protocol === 'https:') {
          publicBaseUrl = window.location.origin;
        } else {
          try {
            const sigUrl = new URL(signalingUrl.replace(/^ws/, "http"));
            publicBaseUrl = `http://${sigUrl.hostname}:${window.location.port}`;
          } catch {
            publicBaseUrl = window.location.origin;
          }
        }
      }

      // Build the remote-mic page URL with signaling server as query param
      const remoteMicPageUrl = `${publicBaseUrl}/remote-mic.html?sig=${encodeURIComponent(signalingUrl)}`;

      remoteMicHost = new RemoteMicHost({ signalingUrl });

      // Safety timeout: if room is not created within 10s, show manual fallback
      const roomTimeout = setTimeout(() => {
        if (!remoteMicHost?.roomCode) {
          remoteMicStatus.innerHTML = `<span style="color:#fc5c5c">Connection to signaling server failed.</span><br>LocalTunnel may not support WebSockets.<br><br>Manual setup:<br>1. Open this URL on your phone:<br><code style="color:#00f5d4">${remoteMicPageUrl}</code><br>2. Enter code: <strong>${remoteCodeDigits.textContent || '----'}</strong>`;
          remoteMicStatus.className = "status danger";
          btnRemoteMic.disabled = false;
        }
      }, 10000);

      remoteMicHost.onRoomCreated = async (code) => {
        clearTimeout(roomTimeout);
        remoteMicStatus.textContent = `Remote mic ready — code: ${code}`;
        remoteMicStatus.className = "status done";
        if (remoteMicCodePanel) {
          remoteMicCodePanel.classList.remove("hidden");
          remoteMicUrl.textContent = remoteMicPageUrl;
          remoteCodeDigits.textContent = code;
          if (remoteMicQr) {
            try {
              remoteMicQr.src = await generateQRDataUrl(remoteMicPageUrl, 200);
            } catch (e) {
              console.warn("QR generation failed:", e);
              remoteMicQr.style.display = "none";
            }
          }
        }
        btnRemoteMic.textContent = "❌ Disconnect Remote Mic";
        btnRemoteMic.disabled = false;
      };

      remoteMicHost.onRemoteStream = (stream) => {
        isRemoteMicActive = true;
        remoteMicStatus.textContent = "Remote mic connected! Stream active.";
        remoteMicStatus.className = "status done";
        if (micSelect) micSelect.disabled = true;
        if (remoteMicConnectedBadge) remoteMicConnectedBadge.classList.remove("hidden");

        // Diagnostic: play remote stream directly to verify audio is flowing
        if (import.meta.env.DEV) {
          const track = stream.getAudioTracks()[0];
          console.log("[DIAG] Remote stream audio track:", {
            id: track?.id,
            enabled: track?.enabled,
            muted: track?.muted,
            readyState: track?.readyState,
            label: track?.label
          });

          // Play the remote stream through PC speakers to verify audio
          const audioEl = new Audio();
          audioEl.srcObject = stream;
          audioEl.muted = false;
          audioEl.volume = 0.5;
          audioEl.play().then(() => {
            console.log("[DIAG] Remote stream playback started - you should hear phone mic through PC speakers");
          }).catch(err => {
            console.warn("[DIAG] Remote stream playback failed:", err);
          });
        }
      };

      remoteMicHost.onClientConnected = () => {
        isRemoteMicActive = true;
        if (micSelect) micSelect.disabled = true;
        if (remoteMicConnectedBadge) remoteMicConnectedBadge.classList.remove("hidden");
        if (remoteMicStatus) {
          remoteMicStatus.textContent = "Remote mic active! Ready to measure.";
          remoteMicStatus.className = "status done";
        }
        if (sweepInstructions) {
          sweepInstructions.innerHTML = "Remote microphone is active. <strong>The PC will play the sweep through your speakers</strong> and the phone will capture the room's response.";
        }
      };

      remoteMicHost.onClientDisconnected = () => {
        if (remoteMicStatus) {
          remoteMicStatus.textContent = "Remote mic disconnected.";
          remoteMicStatus.className = "status";
        }
        isRemoteMicActive = false;
        if (micSelect) micSelect.disabled = false;
        if (remoteMicConnectedBadge) remoteMicConnectedBadge.classList.add("hidden");
        if (sweepInstructions) {
          sweepInstructions.textContent = "Connect your speaker via Bluetooth. We'll play a sweep (20Hz–20kHz) and capture the response.";
        }
      };

      remoteMicHost.onError = (msg) => {
        remoteMicStatus.textContent = "Remote mic error: " + msg;
        remoteMicStatus.className = "status danger";
        btnRemoteMic.disabled = false;
        isRemoteMicActive = false;
        micSelect.disabled = false;
      };

      remoteMicHost.onStatus = (msg) => {
        remoteMicStatus.textContent = msg;
        if (import.meta.env.DEV) console.log("[RemoteMic]", msg);
      };

      await remoteMicHost.start();
    } catch (err) {
      console.error("Remote mic error:", err);
      remoteMicStatus.textContent = "Failed to start remote mic: " + err.message;
      remoteMicStatus.className = "status danger";
      btnRemoteMic.disabled = false;
      isRemoteMicActive = false;
    }
  });
}

// ─── End Remote Mic Integration ──────────────────────────────────────

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

  // Source indicator: show if remote mic is active
  if (isRemoteMicActive) {
    ctx.fillStyle = "rgba(0, 245, 212, 0.15)";
    ctx.fillRect(width - 78, 4, 74, 18);
    ctx.strokeStyle = "rgba(0, 245, 212, 0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(width - 78, 4, 74, 18);
    ctx.fillStyle = "#00f5d4";
    ctx.font = "bold 9px 'JetBrains Mono', monospace";
    ctx.fillText("REMOTE MIC", width - 74, 16);
  }

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

// Step 1: Capture noise floor (legacy sweep path — preserved for Advanced mode)
if (btnNoise) {
btnNoise.addEventListener("click", async () => {
  try {
    // Auto-load devices on first user gesture if not loaded yet
    if (!selectedMicDeviceId && micSelect.options.length <= 1 && micSelect.options[0]?.textContent === "Loading devices…") {
      statusDevices.textContent = "Detecting microphones...";
      statusDevices.className = "status";
      await loadDevices();
    }

    // If remote mic mode is active but stream hasn't arrived yet, wait for it
    if (remoteMicHost && !remoteMicHost.remoteStream) {
      statusNoise.textContent = "Waiting for remote mic to connect...";
      statusNoise.className = "status";
      btnNoise.disabled = true;

      // Wait up to 15 seconds for the remote stream
      let waited = 0;
      while (!remoteMicHost.remoteStream && waited < 15000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }

      if (!remoteMicHost.remoteStream) {
        statusNoise.textContent = "Remote mic did not connect in time. Check the phone and try again.";
        statusNoise.className = "status danger";
        btnNoise.disabled = false;
        return;
      }
    }

    const remoteLabelNoise = isRemoteMicActive ? " [Remote Mic]" : "";
    statusNoise.textContent = "Step 1 of 3: Please stay quiet for 5 seconds to measure room noise floor..." + remoteLabelNoise;
    statusNoise.className = "status";
    btnNoise.disabled = true;
    updateStepIndicator(1, "active");

    const ctx = await ensureAudioContext();
    analyzer = new SpectrumAnalyzer();
    await initAnalyzer(ctx);

    statusNoise.textContent = "Recording noise floor... keep quiet";
    statusNoise.className = "status recording";
    hideProgressBar("noise");

    const startTime = Date.now();
    const captureDuration = 5000;

    const updateNoiseDisplay = async () => {
      const elapsed = (Date.now() - startTime) / 1000;
      const progress = Math.min(100, (elapsed / (captureDuration / 1000)) * 100);
      setProgressBar("noise", progress);

      if (analyzer && analyzer.getRMSLevel) {
        const db = analyzer.getRMSLevel();
        statusNoise.textContent = `Recording noise floor... ${db.toFixed(0)} dB — keep quiet`;
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
        statusNoise.textContent = "Step 1 complete: Noise floor captured (silent environment)";
      } else {
        statusNoise.textContent = `Step 1 complete: Noise floor measured (${minDB.toFixed(0)} to ${maxDB.toFixed(0)} dB)`;
      }
    } else {
      statusNoise.textContent = "Step 1 complete: Noise floor captured";
    }
    statusNoise.className = "status done";
    hideProgressBar("noise");
    updateStepIndicator(1, "completed");
    updateStepIndicator(2, "active");
    btnSweep.disabled = false;
  } catch (err) {
    console.error(err);
    if (err.name === "NotAllowedError" || err.message?.includes("permission")) {
      statusNoise.textContent = "Microphone access was blocked. Check your browser's address bar for the blocked-permissions icon, allow mic access, and try again.";
    } else {
      statusNoise.textContent = "Noise floor calibration failed. Make sure your mic is working and try again.";
    }
    statusNoise.className = "status danger";
    hideProgressBar("noise");
    updateStepIndicator(1, "pending");
    btnNoise.disabled = false;
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
    // If remote mic mode is active but stream hasn't arrived yet, wait for it
    if (remoteMicHost && !remoteMicHost.remoteStream) {
      statusSweep.textContent = "Waiting for remote mic to connect...";
      statusSweep.className = "status";
      btnSweep.disabled = true;

      let waited = 0;
      while (!remoteMicHost.remoteStream && waited < 15000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }

      if (!remoteMicHost.remoteStream) {
        statusSweep.textContent = "Remote mic did not connect in time. Check the phone and try again.";
        statusSweep.className = "status danger";
        btnSweep.disabled = false;
        return;
      }
    }

    // Check noise floor was calibrated
    if (!analyzer || !analyzer.noiseBuffer) {
      statusSweep.textContent = "Please complete Step 1 (Noise Floor) before running the sweep.";
      statusSweep.className = "status danger";
      btnSweep.disabled = false;
      btnStop.disabled = true;
      return;
    }

    // Read sweep count
    const sweepCount = parseInt(sweepCountSelect?.value || "1");

    const remoteLabel = isRemoteMicActive ? " [Remote Mic]" : "";
    btnSweep.disabled = true;
    btnStop.disabled = false;
    hideProgressBar("sweep");
    updateStepIndicator(2, "active");

    const ctx = await ensureAudioContext();

    // Reinitialize with same audioContext but preserve noiseBuffer
    await initAnalyzer(ctx);

    if (sweepCount === 1) {
      // ── Single sweep (original behavior) ──
      statusSweep.textContent = "Step 2 of 3: Playing 8-second sweep test tone through your speakers..." + remoteLabel;
      statusSweep.className = "status recording";

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
          statusSweep.textContent = `Recording sweep response... ${db.toFixed(0)} dB`;
        }
      }, 200);

      sweepSource.onComplete = async () => {
        clearInterval(sweepUpdateInterval);
        setProgressBar("sweep", 100);
        statusSweep.textContent = "Sweep finished — processing frequency response...";
        statusSweep.className = "status info";
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

      if (import.meta.env.DEV && isRemoteMicActive) {
        const checkRMS = () => {
          if (analyzer) {
            const rms = analyzer.getRMSLevel();
            console.log("[DIAG] Remote mic RMS level:", rms.toFixed(1), "dB");
          }
        };
        checkRMS();
        const rmsInterval = setInterval(checkRMS, 2000);
        setTimeout(() => clearInterval(rmsInterval), sweepDuration * 1000 + 2000);
      }
    } else {
      // ── Multi-sweep averaging ──
      statusSweep.textContent = `Step 2 of 3: Running ${sweepCount} sweeps for averaging...` + remoteLabel;
      statusSweep.className = "status recording";

      const allSpectra = [];

      for (let sweepNum = 0; sweepNum < sweepCount; sweepNum++) {
        // Reset accumulation for each sweep
        accumulatedSpectrum = null;
        frameCount = 0;

        statusSweep.textContent = `Sweep ${sweepNum + 1} of ${sweepCount}...`;
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
              statusSweep.textContent = `Sweep ${sweepNum + 1} of ${sweepCount}... ${db.toFixed(0)} dB`;
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
          statusSweep.textContent = `Pause before sweep ${sweepNum + 2}...`;
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // All sweeps done — average the compensated spectra
      setProgressBar("sweep", 100);
      statusSweep.textContent = `Averaging ${sweepCount} sweeps...`;
      statusSweep.className = "status info";
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
    statusSweep.textContent = "Sweep failed: " + err.message + ". Try again or re-calibrate the noise floor first.";
    statusSweep.className = "status danger";
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

  statusSweep.textContent = "Processing sweep response...";
  statusSweep.className = "status info";
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
    statusSweep.textContent = "Processing failed: " + err.message + ". Try playing the sweep again.";
    statusSweep.className = "status danger";
    hideProgressBar("sweep");
    btnSweep.disabled = false;
  }
});
} // end btnStop guard

// Practical target curve — gentle "house curve" tilt that matches real listening preference.
// Unlike a pure flat target, this allows natural bass warmth and smooth treble roll-off.
// Based on common consumer EQ preferences (slight V-shape with bass emphasis).
function getPracticalTargetDB(freq) {
  if (freq < 40) return 1.5;      // Sub-bass: slight lift
  if (freq < 80) return 1.0;      // Bass: warm
  if (freq < 200) return 0.5;     // Upper bass: transitioning
  if (freq < 500) return 0.0;     // Lower mids: reference (0 dB)
  if (freq < 2000) return 0.0;    // Mids: flat
  if (freq < 4000) return -0.5;   // Presence: slight dip
  if (freq < 8000) return -1.0;   // Treble: gentle roll-off
  if (freq < 12000) return -1.5;  // High treble: more roll-off
  return -2.0;                     // Ultra highs: natural limitation
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

  const { maxGain, maxCut, bassMax } = gainLimits;
  const effectiveRange = options.effectiveRange || { low: 0, high: Infinity };
  const linearFreqLabels = analyzer.getLinearFrequencyLabels();
  const visData = generateVisualizationData(spectrum, linearFreqLabels);

  // AutoEQ-inspired processing
  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });

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
  const rangeAvg = countRange > 0 ? sumRange / countRange : 0;

  const normalizedResponse = new Float32Array(smoothedResponse.length);
  for (let i = 0; i < smoothedResponse.length; i++) {
    normalizedResponse[i] = smoothedResponse[i] - rangeAvg;
  }

  // Calculate gains using a practical target curve with gentle tilt
  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const freq = visData[i].x;
    const targetOffset = getPracticalTargetDB(freq);
    rawGains[i] = targetOffset - normalizedResponse[i];
  }

  // Apply gain limits with smooth fade-out outside effective range
  const gains = Array.from(rawGains).map((g, i) => {
    const freq = visData[i].x;
    let gain = g;

    // Apply hard limits first
    if (freq < 100) {
      gain = Math.min(gain, bassMax);
    }
    gain = Math.max(maxCut, Math.min(maxGain, gain));

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
  if (cardResults) cardResults.classList.remove("hidden");

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

  // Pre-calibration health check: quick RMS check before starting
  if (analyzer && analyzer.getRMSLevel) {
    const preRms = analyzer.getRMSLevel();
    if (preRms < SILENCE_THRESHOLD_DB && statusCalibration) {
      statusCalibration.textContent = "Mic seems silent — check your device. Starting anyway...";
      statusCalibration.className = "status info";
    }
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

  // Create active EQ filter chain — 8 peaking filters inserted in pink noise path
  activeEQFilters = ACTIVE_EQ_FREQS.map((freq) => {
    const filter = ctx.createBiquadFilter();
    filter.type = "peaking";
    filter.frequency.value = freq;
    filter.Q.value = 1.0;
    filter.gain.value = 0;
    return filter;
  });
  // Chain filters in series
  for (let i = 0; i < activeEQFilters.length - 1; i++) {
    activeEQFilters[i].connect(activeEQFilters[i + 1]);
  }

  // Start pink noise with active EQ filter chain inserted
  pinkNoise = new PinkNoiseSource(ctx);
  pinkNoise.setFilterChain(activeEQFilters);
  pinkNoise.start();

  // Initialize mic and start continuous measurement
  initAnalyzer(ctx).then(() => {
    // Pre-compute target curve now that analyzer has frequency labels
    computeTargetCurveCache();

    continuousMeasurement = analyzer.measureContinuous((result) => {
      onMeasurementCallback(result);
    }, MEASUREMENT_INTERVAL_MS);

    // Set 30s watchdog timeout
    calibrationTimeout = setTimeout(() => {
      if (calibrationRunning) {
        onCalibrationComplete(bestResult || lastMeasurementResult, { timedOut: true });
      }
    }, CALIBRATION_TIMEOUT_MS);

    // Start canvas rendering loop
    requestAnimationFrame(renderLiveCalibration);
  }).catch((err) => {
    console.error("Failed to start live calibration:", err);
    stopCalibration();
    if (statusCalibration) {
      statusCalibration.textContent = "Could not access microphone. Check permissions and try again.";
      statusCalibration.className = "status danger";
    }
  });
}

/**
 * Core measurement callback — called every ~500ms by measureContinuous.
 * @param {{spectrum: Float32Array, rms: number, elapsedMs: number}} result
 */
function onMeasurementCallback({ spectrum, rms, elapsedMs }) {
  // Timeout check: if we've exceeded the watchdog, stop with best result
  if (elapsedMs > CALIBRATION_TIMEOUT_MS) {
    const timeoutResult = bestResult || lastMeasurementResult;
    if (timeoutResult) {
      onCalibrationComplete(timeoutResult, { timedOut: true });
    } else {
      // No valid measurements captured — all windows were SNR-gated
      stopCalibration();
      if (statusCalibration) {
        statusCalibration.textContent = "Calibration timed out with no usable data. Try moving closer to the speaker.";
        statusCalibration.className = "status danger";
      }
    }
    return;
  }

  // SNR gating: compute noise floor and skip if SNR is too low
  const noiseFloorRMS = analyzer.getNoiseFloorRMS();
  if (noiseFloorRMS > -100) {
    const snr = rms - noiseFloorRMS;
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

  const result = _processMeasurementResults(corrected, {
    method: 'pink-noise',
    gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
    smoothingFactor: 2.5,
    effectiveRange: { low: 100, high: 8000 }
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
    // Accumulate and clamp
    cumulativeEQGains[f] += gain;
    cumulativeEQGains[f] = Math.max(-4, Math.min(4, cumulativeEQGains[f]));
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
  const saveResult = saveProfile({ gains: result.gains, timestamp: Date.now(), type: 'pink-noise' });

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
  const gains = new Float32Array(visData.length);

  for (let i = 0; i < visData.length; i++) {
    const freq = visData[i].x;
    // Interpolate from 8 filter bands to this frequency
    gains[i] = _interpolateEQGains(freq, cumulativeGains);
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
  }

  // EQ canvas
  if (canvasEq && gains) {
    const eqCtx = canvasEq.getContext("2d");
    renderEQCurve(eqCtx, gains);
  }

  // EQ table
  populateEQTable(visData, gains);

  // Enable export buttons
  if (btnExportWavelet) {
    btnExportWavelet.disabled = false;
    btnExportWavelet.dataset.gains = JSON.stringify(gains);
  }
  if (btnExportEqMac) {
    btnExportEqMac.disabled = false;
    btnExportEqMac.dataset.gains = JSON.stringify(gains);
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
    saveProfile({ gains: partialResult.gains, timestamp: Date.now(), type: 'pink-noise' });
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
 * Draws 3 lines: target curve (cached), spectrum (updating), EQ (converging).
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

  // Line 3: EQ correction curve (converging, cyan)
  if (liveEQGains && cachedTargetCurve) {
    // Map EQ gains (64 points) to frequency points using the same log spacing
    const eqPoints = [];
    for (let i = 0; i < liveEQGains.length; i++) {
      const freq = 20 * Math.pow(20000 / 20, i / (liveEQGains.length - 1));
      eqPoints.push({ x: freq, y: liveEQGains[i] });
    }
    drawLine(eqPoints, "#00f5d4");
  }

  // Legend (top-left corner)
  ctx.font = "10px 'JetBrains Mono', monospace";
  const legendX = 10;
  let legendY = 18;
  const legendItems = [
    { color: "#6a6a7a", label: "Target", dashed: true },
    { color: "#ff6b6b", label: "Room Response" },
    { color: "#00f5d4", label: "Correction" },
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

  // Enable export with saved profile (graphs shown only after calibration)
  if (btnExportWavelet) {
    btnExportWavelet.disabled = false;
    btnExportWavelet.dataset.gains = JSON.stringify(profile.gains);
  }
  if (btnExportEqMac) {
    btnExportEqMac.disabled = false;
    btnExportEqMac.dataset.gains = JSON.stringify(profile.gains);
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

// Initialize all canvases
resizeCanvases();

// Populate device list on init (generic labels until permission granted)
loadDevices();

// Restore persisted profile on init
restorePersistedProfile();

if (import.meta.env.DEV) console.log("lazyEq (Pink Noise mode) initialized");

/** Dist verification hook — string must remain in bundle for `npm test` (test.js). */
globalThis.lazyEqTest = { mode: "sine-sweep", version: "1.0.0" };
