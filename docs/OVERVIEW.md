# Project Overview (Current)

lazyEq is a browser-based room EQ measurement tool.

## What it does

1. Captures ambient noise floor
2. Plays a logarithmic sweep through speakers
3. Records response via local mic or phone mic over WebRTC
4. Computes a bounded correction curve
5. Exports presets for Wavelet and eqMac

## Repository shape

This repository is maintained as a **single app**, not a multi-package monorepo.

Key paths:

- `src/main.js`
- `src/analyzer.js`
- `src/sineSweep.js`
- `src/eqGenerator.js`
- `src/webrtc/*`
- `server/signaling.js`
- `public/audio-worklet-processor.js`
