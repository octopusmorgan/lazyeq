/**
 * lazyEq - Sine Sweep Speaker EQ Analyzer
 * Professional frequency response measurement using logarithmic sine sweep
 */

import { SineSweepSource } from "./sineSweep.js";
import { SpectrumAnalyzer } from "./analyzer.js";
import { RemoteMicHost } from "./webrtc/remoteMic.js";
import { generateQRDataUrl } from "./webrtc/qrCode.js";
import { resolveSignalingUrl, isPrivateOrLocalHostname } from "./webrtc/networkDiscovery.js";
import { SAMPLE_RATE } from "./constants.js";
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

let animationFrame = null;
let frameCount = 0;
let accumulatedSpectrum = null;
let sweepDuration = 8;
let selectedMicDeviceId = null;
let remoteMicHost = null;
let isRemoteMicActive = false;
let sweepProcessing = false;
let sweepProcessTimeout = null;

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
const canvasSpectrum = document.getElementById("canvas-spectrum");
const canvasEstimated = document.getElementById("canvas-estimated");
const canvasEq = document.getElementById("canvas-eq");
const canvasLive = document.getElementById("canvas-live");

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
            publicBaseUrl = `http://${sigUrl.hostname}:5173`;
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

// Step 1: Capture noise floor
btnNoise.addEventListener("click", async () => {
  try {
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
    statusNoise.textContent = "Calibrating mic (5s silence)..." + remoteLabelNoise;
    statusNoise.className = "status";
    btnNoise.disabled = true;

    const ctx = await ensureAudioContext();
    analyzer = new SpectrumAnalyzer();
    await initAnalyzer(ctx);

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

    const remoteLabel = isRemoteMicActive ? " [Remote Mic]" : "";
    statusSweep.textContent = "Starting Sine Sweep (8s)..." + remoteLabel;
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
    await initAnalyzer(ctx);

    sweepSource = new SineSweepSource(ctx);
    sweepSource.createBuffer(sweepDuration);

    sweepSource.onComplete = async () => {
      statusSweep.textContent = "Sweep finished — processing...";
      statusSweep.className = "status info";
      btnStop.disabled = true;

      sweepProcessTimeout = setTimeout(async () => {
        if (animationFrame) {
          cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        await processSweepResults();
      }, 500);
    };

    sweepSource.start();
    renderLiveSweep();

    // Diagnostic: log RMS level every 2 seconds during sweep
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
    statusSweep.textContent = "Error: " + err.message;
    statusSweep.className = "status danger";
    btnSweep.disabled = false;
  }
});

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

  // Calculate gains using a practical target curve with gentle tilt
  // Pure flat targets over-correct natural speaker roll-off.
  // A gentle downward tilt (like real listening preference) is more natural.
  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const freq = visData[i].x;
    // Practical target: slight bass boost preference, gentle treble roll-off
    // This matches how people actually prefer to listen (House Curve)
    const targetOffset = getPracticalTargetDB(freq);
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

// Process sweep results using peak-hold FFT with spectral compensation
async function processSweepResults() {
  if (sweepProcessing) return;
  sweepProcessing = true;

  // Peak-hold FFT with spectral compensation for log sweep 1/f energy distribution
  if (!accumulatedSpectrum || frameCount < 10) {
    sweepProcessing = false;
    statusSweep.textContent = "Need more data — play sweep longer!";
    statusSweep.className = "status danger";
    btnStop.disabled = false;
    btnSweep.disabled = false;
    return;
  }

  // A logarithmic sweep has constant energy per octave, meaning energy per Hz drops as 1/f.
  // We compensate by adding 10*log10(f/f0) dB to each bin to flatten the response.
  const f0 = 20; // Sweep start frequency
  const sr = analyzer.audioContext.sampleRate;
  const fftSz = analyzer.analyserNode.fftSize;
  const bw = sr / fftSz;
  
  const compensated = new Float32Array(accumulatedSpectrum.length);
  for (let i = 0; i < accumulatedSpectrum.length; i++) {
    const freq = i * bw;
    if (freq > f0) {
      compensated[i] = accumulatedSpectrum[i] + 10 * Math.log10(freq / f0);
    } else {
      compensated[i] = accumulatedSpectrum[i];
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

  statusSweep.textContent = "Sweep analysis complete (practical target)";
  statusSweep.className = "status done";

  await new Promise((resolve) => requestAnimationFrame(resolve));
  resizeCanvases();

  // Use shared processing with conservative EQ limits for real-world speakers
  const { visData, normalizedResponse, gains, rangeAvg } = _processMeasurementResults(corrected, {
    method: 'sweep',
    gainLimits: { maxGain: 6, maxCut: -6, bassMax: 6 },
    smoothingFactor: 2.0
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
  const visData = JSON.parse(btnExportEqMac.dataset.visData || "[]");
  const content = exportEqMac(gains, visData);
  downloadFile("lazyeq-eqmac.json", content);
  statusExport.textContent = "eqMac preset exported";
  statusExport.className = "status done";
});

window.addEventListener("resize", resizeCanvases);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resizeCanvases);
}

// Initialize all canvases
resizeCanvases();
if (import.meta.env.DEV) console.log("lazyEq (Sine Sweep mode) initialized");

/** Dist verification hook — string must remain in bundle for `npm test` (test.js). */
globalThis.lazyEqTest = { mode: "sine-sweep", version: "1.0.0" };
