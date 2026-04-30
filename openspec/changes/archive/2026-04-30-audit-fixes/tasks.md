# Tasks: audit-fixes — lazyeq Code Audit Remediation

## Phase 1: Correctness Blockers (~3.5h)

- [x] 1.1 **[B-2] `eqGenerator.js`**: Replace log-→-linear FFT bin interpolation with binary search (`findClosestBin`). Add regression test: 632Hz→bin~29, 1kHz→bin~95, 10kHz→bin~927. ⚠️ Do FIRST.
- [x] 1.2 **[B-1] `analyzer.js`**: Add `sweep.start()` before `recordSegment(1)` in `calibrateMicrophone` (L114-125). Add unit test mocking SineSweepSource to verify call order.
- [x] 1.3 **[B-3] `analyzer.js`**: Replace `setTimeout`-only scheduling in `recordSegment` (L71-101) with `requestAnimationFrame` + `audioContext.currentTime` sync. Add unit test mocking audio clock.

## Phase 2: Architecture & Quality (~7.5h)

- [x] 2.1 **[Q-4] `roomCalibration.js`**: Two-pass `filterOutliers`: pre-compute per-bin mean+stdDev into `Float32Array(bins*2)`, then score measurements. Zero per-iteration allocations. Add equivalence + allocation-count test. *(parallel with 2.2)*
- [x] 2.2 **[Q-2] `main.js`**: Extract shared `_processMeasurementResults(spectrum, options)` from `processSweepResults` + `processRoomWalkResults`. Verify bit-exact output before/after. Add unit test. *(parallel with 2.1)*
- [x] 2.3 **[Q-5] `main.js`**: Extract `hexToRgba(hex, alpha)` helper from inline regex chain. Add unit test for `#RRGGBB` and `#RGB` formats.
- [ ] 2.4 **[Q-1] `main.js`**: Extract `src/ui.js` (~200LOC), `src/state.js` (~80LOC), `src/events.js` (~100LOC). Slim `main.js` to ~400-500 LOC. Run `npm test` and smoke test.
- [x] 2.5 **[Q-6] `test.js`**: Read ALL `.js` files in `dist/assets/`, not just first. Verify `lazyEqTest` across combined content. Test: `npm run build && node test.js`.
- [ ] 2.6 **[Q-3] New tests**: Write `tests/analyzer.test.js` (8-12 tests) and `tests/roomCalibration.test.js` (10-15 tests). Mock browser APIs. Target ≥80% coverage via `node --test --coverage`.

## Phase 3: Polish (~2h, all independent/parallel)

- [x] 3.1 **[P-1] Create `src/constants.js`**: Export `SAMPLE__RATE`, `FFT_SIZE`, `MIC_REFERENCE_OFFSET`. Import in `analyzer.js`, `sineSweep.js`, `main.js`.
- [x] 3.2 **[P-3] `analyzer.js`**: Replace magic `+90` with named `MIC_REFERENCE_OFFSET` from `constants.js`.
- [x] 3.3 **[P-5] `eqGenerator.js`**: Cache sorted `Object.keys(harMAN_TARGET_DB)` as module-level `_harMAN_TARGET_KEYS`.
- [x] 3.4 **[P-2] `sineSweep.js`**: Add `console.warn('Sweep stop error:', e)` on `sweep.stop()` error.
- [ ] 3.5 **[P-4] `main.js`**: Wrap `analyzer.destroy()` calls in `try {} finally {}`.
- [x] 3.6 **[P-6] Create `src/i18n.js`**: Extract English/Spanish strings from `main.js`. Export per-key get function.
- [x] 3.7 **[P-7] `main.js`**: Defer `loadDevices()` to `init()` or user gesture; remove eager call at module load.
- [ ] 3.8 **[P-8] `main.js`**: Promise-ize RAF vs sweep `onComplete` race; cancel RAF on sweep complete, clear `onComplete` on manual stop.
- [ ] 3.9 **[P-9] `main.js`**: Move gain values from DOM `dataset` to `state.exportState.currentGains` Map.

## Verification

- [x] 4.1 Run `npm test` — all tests pass.
- [ ] 4.2 Run `npm run build && node test.js` — smoke test reads all files.
- [ ] 4.3 Manual sweep test — verify EQ curve visually correct above 300Hz.
- [ ] 4.4 Coverage: `node --test --coverage` ≥80% on `analyzer.js`, `roomCalibration.js`.

## Critical Path

```
B-2 → B-1 → B-3 → Q-4 + Q-2 (parallel) → Q-5 → Q-1 → Q-6 → Q-3 → Phase 3
```

**Total estimated effort**: ~13 hours

(End of file - total 43 lines)