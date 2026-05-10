# lazyEq

**Room EQ that learns your room in under a minute.**  
Plays pink noise through your speakers, captures the response with your phone's mic via WebRTC, and generates a correction curve — all in the browser. No install, no cables.

## Quick Start

```bash
npm install
npm run dev        # → https://localhost:5173 (or http://localhost:5173)
```

Open the link on your PC, grant mic access, tap **Start Calibration**. The app plays pink noise and auto-converges to an EQ curve in 10–30 seconds. Export to Wavelet (Android) or eqMac (macOS) when done.

> **Note**: If accessing from another device on the same network, use the HTTPS URL (e.g., `https://192.168.x.x:5173`). The browser's MediaDevices API requires a secure context (HTTPS or localhost) for microphone access.

## Two Calibration Paths

| Path | Sound | Time | Best for |
|------|-------|------|----------|
| **Auto-EQ** (pink noise) | Soft, continuous | 10–30s auto-converge | Daily use, quick setup |
| **Legacy Sweep** (sine sweep) | 8s tone, multi-sweep | 8–30s manual | Power users, diagnostics |

### Auto-EQ (Primary Path)

Plays pink noise through your speakers while the microphone captures the response in 500ms windows. Each window produces a correction delta — when the delta stabilizes below 0.5 dB across 3 consecutive windows, calibration is **done**.

1. Tap **Start Calibration**
2. Wait for convergence (watch the `Δ` value drop)
3. Export your EQ preset

The correction updates in real time: you can hear the EQ shaping as the system converges. The final curve also **persists** to localStorage — reload the page and your last calibration is ready to export.

### Legacy Sweep (Advanced)

8-second logarithmic sine sweep (20 Hz → 16 kHz) with multi-sweep averaging. For when you want full control.

1. **Step 1** — Capture noise floor (5s of silence)
2. **Step 2** — Play the sweep (select 1–3 sweeps for averaging)
3. **Step 3** — Export the EQ curve

The sweep section is in a collapsible **Advanced** panel below the main Auto-EQ card.

## HTTPS Setup for Local Network Access

By default, `npm run dev` serves HTTP. To access from another device on your network (e.g., a phone or tablet), you need HTTPS — browsers block microphone access on non-secure origins.

### Quick Setup (one-time)

```bash
# Install mkcert for local HTTPS certificates
brew install mkcert
mkcert -install

# Generate certificates for your network IP
mkcert 192.168.x.x localhost 127.0.0.1

# Rename for Vite (it auto-detects these files)
mv 192.168.x.x+2.pem cert.pem
mv 192.168.x.x+2-key.pem cert-key.pem

# Now run dev — it will serve HTTPS automatically
npm run dev
```

You'll see:
```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.68.101:5173/
```

Access from your phone: `https://192.168.68.101:5173/` — the microphone will work.

### Why HTTPS is required

Chrome, Edge, Brave, and Safari require a **secure context** (HTTPS or localhost) to grant microphone access. This is a browser security policy — the API simply won't work over plain HTTP on a network URL.

## Features

- **Auto-EQ with pink noise** — Continuous measurement, real-time convergence detection, no manual sweeps
- **Adaptive per-band limits** — Detects band-limited speakers and adjusts correction range
- **Profile persistence** — Dual-slot localStorage with saturation rollback protection
- **Multi-sweep averaging** — 1–3 sweeps averaged in the compensated domain
- **Logarithmic sine sweep** — 20 Hz to 16 kHz in 8 seconds, smooth fade-in/out
- **1/f spectral compensation** — Corrects the natural energy distribution of log sweeps
- **Noise floor subtraction** — Power-domain averaging with SNR gating
- **Phone mic correction** — Generic MEMS microphone curve
- **Practical EQ limits** — ±4 dB correction, 100 Hz–8 kHz effective range
- **Export presets** — Wavelet (147-band GraphicEQ) and eqMac (10-band peaking EQ) with preamp normalization
- **No installation** — Runs entirely in the browser

## Measurement Tips

| Parameter | Recommendation |
|-----------|----------------|
| **Phone position** | At ear height, where you normally listen |
| **Distance** | 2–3 meters from the speaker |
| **Volume** | 70–80% — loud but clean, no distortion |
| **Environment** | Quiet room, minimal background noise |
| **Browser** | Firefox recommended for best WebRTC support |

## Architecture

```
src/
├── main.js                # App entry, UI orchestration, both calibration flows
├── analyzer.js            # FFT analysis, noise floor, mic calibration, AudioWorklet
├── sineSweep.js           # Logarithmic sine sweep generator
├── pinkNoise.js           # Pink noise generator (Paul Kellet's method, looped)
├── eqGenerator.js         # EQ curve generation, Harman target, export formats
├── convergence.js         # Rolling window convergence detection for EQ gains
├── persistence.js         # Dual-slot localStorage profile save/load with rollback
├── constants.js           # Sample rate, FFT size, calibration thresholds
├── style.css              # Dark theme, glassmorphism, neon accents
├── candidateDetector.js   # Peak/null detection in frequency response
├── candidateRanker.js     # Ranking and prioritization of correction targets
├── parametricEqSynthesizer.js # RBJ biquad filter synthesis for parametric EQ
└── calibrationDebugLog.js # Debug logging for calibration pipeline

public/
└── audio-worklet-processor.js  # AudioWorklet for PCM sweep recording
```

## Technology Stack

- **Vite 6** — Build tool, dev server with auto-HTTPS
- **Web Audio API** — FFT analysis, pink noise, sine sweeps, AudioWorklet, BiquadFilter
- **Canvas API** — Real-time spectrum visualization with log-frequency rendering

## Algorithm Details

### Pink Noise (Auto-EQ)

Paul Kellet's refined method: 7 cascaded integrators with feedback to produce a -3 dB/octave spectral slope. Pre-generated 10-second buffer looped seamlessly.

### Convergence Detection

Rolling window of 3 measurements. Each window computes mean absolute delta between consecutive gain arrays. Converged when `delta < 0.5 dB` for 2 consecutive comparisons, with a minimum of 4 measurements before convergence is allowed.

### Adaptive Per-Band Limits

For each of the 8 ISO bands (63 Hz–8 kHz), tracks consecutive saturation events. If a band repeatedly requests correction but the measured response doesn't change (speaker can't reproduce that frequency), the band's gain limit is halved (min ±1 dB).

### Sweep Generation

Logarithmic sine sweep using the phase formula (legacy path):

```
φ(t) = 2π · f₀ · T · (e^(ln(f₁/f₀)·t/T) − 1) / ln(f₁/f₀)
```

Where f₀ = 20 Hz, f₁ = 16 kHz, T = 8 s.

### Spectral Compensation

A log sweep has constant energy per octave, so energy per Hz drops as 1/f. Compensated by adding `10 · log₁₀(f/f₀)` dB to each FFT bin.

### Noise Subtraction

Power-domain averaging: dB → linear power → average → back to dB. Noise floor subtracted in the linear domain before converting back to dB.

### EQ Curve

- **Target**: Harman 2013 house curve with gentle bass warmth and treble roll-off
- **Limits**: ±4 dB maximum correction (±12 dB in Wavelet export for compatibility)
- **Effective range**: 100 Hz–8 kHz with smooth log-space fade-out
- **Smoothing**: Adaptive Gaussian with factor 2.5 (more smoothing in highs, less in bass)

### Profile Persistence

- **Dual-slot**: Current + previous calibration stored in localStorage
- **Saturation rollback**: If all 8 bands clip at ±4 dB, auto-restores previous profile
- **Type tracking**: Each profile tagged as `pink-noise` or `sweep`

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development server (auto-detects HTTPS if certs exist) |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |
| `npm test` | Run test suite |

> When `cert.pem` and `cert-key.pem` exist in the project root, Vite automatically serves HTTPS.

## Browser Support

| Browser | Support |
|---------|---------|
| Firefox Desktop | ✅ Full support |
| Chrome Desktop | ✅ Full support |
| Firefox Android | ✅ Full support |
| Chrome Android | ✅ Full support |
| Safari iOS | ✅ Full support |

> **Note**: Microphone access requires HTTPS or localhost. Use the HTTPS network URL when accessing from another device.

## Package Structure

```
lazyeq/
├── docs/           # Architecture docs, strategy docs
├── tests/          # eqGenerator tests, integration tests, package tests
├── examples/       # Usage examples
├── packages/       # Reserved for future package extraction
├── dist/           # Build output (gitignored)
```

## License

MIT
