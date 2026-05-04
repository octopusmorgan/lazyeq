# lazyEq Documentation

This repository is a **single Vite application** focused on room EQ measurement with sine sweeps.

## Current architecture

- `src/` — app logic, DSP, UI rendering, WebRTC client/host integration
- `server/signaling.js` — WebSocket signaling relay for remote mic pairing
- `public/audio-worklet-processor.js` — AudioWorklet recorder
- `index.html` — desktop/controller UI
- `remote-mic.html` — phone microphone UI

## Development

```bash
npm install
npm run dev
```

## Test commands

```bash
npm test       # all Node tests in /tests
npm run test:dist   # dist smoke test (requires existing dist build)
```
