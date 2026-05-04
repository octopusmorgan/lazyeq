# lazyEq

**Room EQ measurement tool using your phone as a wireless microphone.**

lazyEq plays a logarithmic sine sweep through your speakers, captures it with your phone's microphone via WebRTC, and generates an EQ correction curve — all in the browser.

## Features

- **Dual-device measurement** — PC plays the sweep, phone captures it via WebRTC (no cables)
- **Logarithmic sine sweep** — 20Hz to 16kHz in 8 seconds with smooth fade-in/fade-out
- **1/f spectral compensation** — Corrects the natural energy distribution of log sweeps
- **Multi-sweep averaging** — Run 2-3 sweeps to reduce room mode variation
- **Practical EQ limits** — ±4dB correction focused on the speaker's effective range (100Hz-8kHz)
- **Export presets** — Wavelet (Android) and eqMac (macOS) formats
- **No installation required** — Runs entirely in the browser

## Quick Start

```bash
npm install
npm run dev
```

Visit `http://localhost:5173` to access the calibration interface.

## How It Works

### 1. Noise Floor Calibration
Record 5 seconds of room silence to establish the background noise baseline.

### 2. Sine Sweep Playback
Play an 8-second logarithmic sweep (20Hz → 16kHz) through your speakers. The phone captures the response via WebRTC.

### 3. EQ Curve Generation
The captured sweep is processed with:
- **Peak-hold FFT accumulation** during playback
- **1/f spectral compensation** to flatten the log sweep's natural energy distribution
- **Noise floor subtraction** using power-domain averaging
- **Phone mic correction** with a generic MEMS microphone curve
- **Adaptive smoothing** with effective range limiting (100Hz-8kHz)

### 4. Export
Download the EQ preset in your preferred format and apply it to your system.

## Remote Mic Setup

### LAN Mode (same Wi-Fi network)

1. Start the signaling server: `npm run signaling`
2. Start the app: `npm run dev`
3. Click **"Use Remote Mic"** on the PC
4. Open the URL shown on your phone's browser
5. Enter the 4-digit room code
6. Grant microphone permission when prompted

### Remote Mode (different networks)

For use over the internet, you'll need a signaling server accessible from both devices. The default setup uses a local WebSocket server on port 3001.

## Measurement Tips

| Parameter | Recommendation |
|-----------|----------------|
| **Phone position** | At ear height, where you normally listen |
| **Distance** | 2-3 meters from the speaker |
| **Volume** | 70-80% of max — loud but no distortion |
| **Sweeps** | 2-3 for averaging (reduces room mode variation) |
| **Environment** | Quiet room, no background noise |

## Architecture

```
src/
├── main.js              # App entry, UI orchestration, sweep handler
├── analyzer.js          # FFT analysis, noise floor, mic calibration, AudioWorklet
├── sineSweep.js         # Logarithmic sine sweep generator
├── eqGenerator.js       # EQ curve generation, export formats, target curves
├── constants.js         # Sample rate, FFT size, reference offsets
├── style.css            # Dark theme UI styles
├── webrtc/
│   ├── remoteMic.js     # WebRTC host (PC) and client (phone)
│   ├── networkDiscovery.js  # LAN network discovery
│   └── qrCode.js        # QR code generation for phone pairing
```

```
server/
└── signaling.js         # WebSocket relay for WebRTC signaling

public/
└── audio-worklet-processor.js  # AudioWorklet for sweep recording
```

## Technology Stack

- **Vite** — Build tool and dev server
- **Web Audio API** — FFT analysis, sweep generation, AudioWorklet
- **WebRTC** — Real-time audio streaming from phone to PC
- **WebSocket** — Signaling server for WebRTC handshake
- **Canvas API** — Real-time spectrum visualization

## Algorithm Details

### Sweep Generation
Logarithmic sine sweep using the phase formula:
```
φ(t) = 2π · f₀ · T · (e^(ln(f₁/f₀)·t/T) - 1) / ln(f₁/f₀)
```
Where f₀=20Hz, f₁=16kHz, T=8s.

### Spectral Compensation
A log sweep has constant energy per octave, meaning energy per Hz drops as 1/f. We compensate by adding `10·log₁₀(f/f₀)` dB to each FFT bin.

### Noise Subtraction
Power-domain averaging: convert dB to linear power, average, convert back. Subtract noise floor in the linear domain before converting to dB.

### EQ Curve
- **Target**: Practical "house curve" with gentle bass warmth and treble roll-off
- **Limits**: ±4dB maximum correction
- **Effective range**: 100Hz-8kHz with smooth log-space fade-out outside this range
- **Smoothing**: Adaptive Gaussian with factor 2.5

## Browser Support

| Browser | Support |
|---------|---------|
| Firefox Android | ✅ Full support |
| Chrome Android | ✅ Full support |
| Firefox Desktop | ✅ Full support |
| Chrome Desktop | ✅ Full support |
| Safari iOS | ⚠️ Limited (WebRTC audio may vary) |

## License

MIT
