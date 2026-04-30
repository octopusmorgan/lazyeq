# Apply Progress: audit-fixes

## Phase 1: Correctness Blockers (~3.5h) — COMPLETE

- [x] 1.1 **[B-2]** `eqGenerator.js`: Binary search FFT bin interpolation
- [x] 1.2 **[B-1]** `analyzer.js`: Added sweep.start() before recordSegment
- [x] 1.3 **[B-3]** `analyzer.js`: RAF + audioContext timing

## Phase 2: Architecture & Quality (~7.5h) — IN PROGRESS

- [x] 2.1 **[Q-4]** `roomCalibration.js`: Two-pass filterOutliers (Float32Array pre-computed)
- [x] 2.2 **[Q-2]** `main.js`: Extracted _processMeasurementResults
- [x] 2.3 **[Q-5]** `main.js`: Extracted hexToRgba helper
- [ ] 2.4 **[Q-1]** `main.js`: Extract ui.js, state.js, events.js
- [x] 2.5 **[Q-6]** `test.js`: Read all .js files in dist/assets/
- [ ] 2.6 **[Q-3]** New tests for analyzer.js, roomCalibration.js

## Phase 3: Polish (~2h) — IN PROGRESS

- [x] 3.1 **[P-1]** constants.js created with SAMPLE_RATE, FFT_SIZE, MIC_REFERENCE_OFFSET
- [x] 3.2 **[P-3]** analyzer.js uses MIC_REFERENCE_OFFSET constant
- [x] 3.3 **[P-5]** eqGenerator.js caches _harMAN_TARGET_KEYS
- [x] 3.4 **[P-2]** sineSweep.js logs sweep.stop() errors
- [ ] 3.5 **[P-4]** main.js try/finally on analyzer.destroy()
- [x] 3.6 **[P-6]** i18n.js created
- [x] 3.7 **[P-7]** main.js deferred loadDevices()
- [ ] 3.8 **[P-8]** main.js Promise-ize sweep completion
- [ ] 3.9 **[P-9]** main.js state-based gains (not DOM dataset)

## Verification

- [ ] Run npm test
- [ ] Run npm run build && node test.js
- [ ] Manual sweep test
- [ ] Coverage ≥80%