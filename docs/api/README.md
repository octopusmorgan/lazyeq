# API Notes (Internal)

lazyEq is currently an application repo, not a published package set.

## Main modules

- `src/sineSweep.js` — logarithmic sweep generation
- `src/analyzer.js` — microphone capture, FFT, correction pipeline
- `src/eqGenerator.js` — target curve and preset export helpers
- `src/roomCalibration.js` — directional and spatial averaging helpers
- `src/webrtc/remoteMic.js` — remote phone microphone transport

If you need reusable package APIs later, extract from these modules first.
