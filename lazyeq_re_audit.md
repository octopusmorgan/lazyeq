# lazyEq — Re-Audit After Fixes

**Previous audit**: 18 findings  
**This review**: Verification of fixes + new/remaining issues

---

## Findings Status (Original 18)

| # | Original Finding | Status | Notes |
|---|-----------------|--------|-------|
| 1 | `main.js` God Module | 🟡 Partial | New modules extracted (`constants.js`, `i18n.js`, `state.js`), but `main.js` is still 1 028 lines. Rendering, DSP, and event handling remain co-located. |
| 2 | Duplication: `processSweepResults` / `processRoomWalkResults` | ✅ Fixed | Shared `_processMeasurementResults()` extracted (L777–828). Both callers now delegate to it. |
| 3 | `recordSegment` uses `setTimeout` | ✅ Fixed | Hybrid `requestAnimationFrame` + `audioContext.currentTime` scheduling (L69–112). |
| 4 | Race condition on `accumulatedSpectrum` | ❌ Not fixed | No `sweepActive` flag added. The rAF → cancel → setTimeout(500ms) → process sequence is unchanged. |
| 5 | Fragile hex-to-rgba regex | ✅ Fixed | Clean `hexToRgba()` helper (L23–39). Used in `renderSpectrum`. |
| 6 | `calibrateMicrophone` missing `sweep.start()` | ✅ Fixed | `sweep.start()` now called at L134. |
| 7 | `SAMPLE_RATE` duplicated | ✅ Fixed | `constants.js` exports `SAMPLE_RATE`, `FFT_SIZE`, `MIC_REFERENCE_OFFSET`. `analyzer.js` and `sineSweep.js` import from it. |
| 8 | O(n·m²) outlier filter | ✅ Fixed | `filterOutliers()` now pre-computes per-bin stats in two passes (L154–201). No per-measurement array allocations. |
| 9 | Gains stored in DOM dataset | ❌ Not fixed | Still `btnExportWavelet.dataset.gains = JSON.stringify(gains)` (L888–889). |
| 10 | `sineSweep.stop()` swallows errors | ✅ Fixed | Now logs: `console.warn('Sweep stop error:', e)` (L86). |
| 11 | Magic `+90` in `getRMSLevel` | ✅ Fixed | Uses named constant `MIC_REFERENCE_OFFSET` from `constants.js` (L277). |
| 12 | `test.js` fragile smoke test | ❌ Not fixed | Same build-verification test, unchanged. |
| 13 | No test coverage for `analyzer.js`, `roomCalibration.js`, `main.js` | ❌ Not fixed | Still only `tests/eqGenerator.test.js` (7 tests). |
| 14 | Mixed languages (EN/ES) in UI | 🟡 Partial | `i18n.js` created with string tables, but NOT wired into `index.html` or `main.js`. HTML still has hardcoded Spanish (L144, L148, L150). `main.js` still has `"Mediciones: ${current}/${total}"` (L709, L717). |
| 15 | `loadDevices()` called eagerly | ✅ Fixed | Comment at L146–147 confirms removal. Devices load on first user gesture. |
| 16 | `analyzer.destroy()` without try/finally | ✅ Fixed | Both `processSweepResults` (L892–897) and `processRoomWalkResults` (L996–1001) use try/finally. |
| 17 | `getHarmanTargetDB` re-parses keys | ✅ Fixed | Cached as `_harMAN_TARGET_KEYS` at module scope (L33). |
| 18 | Log-to-linear bin mapping bug in `generateVisualizationData` | ✅ Fixed | Binary search on `frequencyLabels` (L153–160). |

### Summary: 11 ✅ Fixed · 2 🟡 Partial · 5 ❌ Not fixed

---

## New Issues Found

---

### N1. `state.js` is imported but NOT used
**Severity: Medium** — Dead Code

`state.js` exports all DOM refs and mutable state variables, but `main.js` **re-declares all of them locally** (L41–72). The `state.js` module is imported by nobody — it's dead code that executes `document.getElementById()` calls for no reason.

Moreover, exporting `let` bindings from `state.js` is a design trap — importing modules get READ-ONLY bindings. You can't do `import { analyzer } from './state.js'; analyzer = new SpectrumAnalyzer()` — it throws `TypeError: Assignment to constant variable`.

**Recommendation**: Either:
- Delete `state.js` and keep the current approach (state stays in `main.js`)
- Actually use `state.js` with setter functions: `export function setAnalyzer(a) { analyzer = a; }`

---

### N2. `i18n.js` created but not wired in
**Severity: Low** — Dead Code

`i18n.js` has a `t()` function and string tables, but no file imports it. The HTML and `main.js` still have hardcoded strings in both English and Spanish.

**Recommendation**: Either wire it in or remove it to avoid confusion.

---

### N3. `initAudioContext` still hardcodes `44100` instead of using `SAMPLE_RATE`
**Severity: Low** — Inconsistency

[main.js L78](file:///Users/user/Documents/Proyects%20LLM/lazyeq/src/main.js#L78):
```js
audioContext = new (window.AudioContext || window.webkitAudioContext)({
  sampleRate: 44100  // ← should be SAMPLE_RATE from constants.js
});
```

`main.js` doesn't import `SAMPLE_RATE` from `constants.js`. The whole point of #7 was centralization, but the main consumer still hardcodes it.

---

### N4. `sineSweep.stop()` still doesn't filter `InvalidStateError`
**Severity: Low** — Nit

The fix changed empty catch to `console.warn`, which is better than silence. But on every normal sweep completion, `stop()` is called on an already-ended source, producing a console warning every time. This is noise for the user.

**Recommendation**:
```js
} catch (e) {
  if (e.name !== 'InvalidStateError') console.warn('Sweep stop error:', e);
}
```

---

### N5. `_filterOutliersIQR` was NOT optimized (unlike `filterOutliers`)
**Severity: Medium** — Performance

`filterOutliers()` was correctly optimized with pre-computed stats. But `_filterOutliersIQR()` ([roomCalibration.js L207–236](file:///Users/user/Documents/Proyects%20LLM/lazyeq/src/roomCalibration.js#L207-L236)) still allocates and SORTS an array per bin per measurement:

```js
for (let m = 0; m < n; m++) {
  for (let f = 0; f < bins; f++) {
    const values = measurements.map(meas => meas.spectrum[f]).sort(...)  // ← O(n·log n) per cell
```

With 15 measurements × 1024 bins = 15,360 sort operations. Same O(n²·m·log m) as before.

**Recommendation**: Pre-compute per-bin sorted arrays once outside the measurement loop, then look up Q1/Q3 for each measurement check.

---

### N6. `calibrateMicrophone` has a timing problem — sweep may not have started producing audio yet
**Severity: Medium** — Robustness

[analyzer.js L133–138](file:///Users/user/Documents/Proyects%20LLM/lazyeq/src/analyzer.js#L133-L138):
```js
sweep.start();
const recordedSpectrum = await this.recordSegment(1);
```

`sweep.start()` schedules a buffer source to play, but the Web Audio API processes audio asynchronously. `recordSegment` immediately starts capturing on the SAME call stack. The first few captured frames may contain silence before the sweep buffer actually begins producing output.

For a 1-second sweep this probably doesn't matter much in practice (a few ms of silence blended into 1s of data), but it's worth noting.

---

### N7. Indentation inconsistency in noise floor handler
**Severity: Low** — Code Quality

[main.js L584–605](file:///Users/user/Documents/Proyects%20LLM/lazyeq/src/main.js#L584-L605): The `await analyzer.captureNoiseFloor(5)` and the `if (analyzer.noiseBuffer)` block have broken indentation — they're at column 0 and column 4 respectively, while the surrounding code is at column 4+. This suggests a copy-paste artifact.

---

## Overall Re-Assessment

Good progress. The **critical bugs are fixed** (#6 calibration, #18 bin mapping), and several quality issues were addressed properly (constants extraction, outlier filter optimization, try/finally cleanup, hexToRgba).

### What's done well:
- `constants.js` — clean centralization
- `_processMeasurementResults` — good deduplication of the processing pipeline
- `filterOutliers` optimization — pre-computed stats, zero per-iteration allocations
- `hexToRgba` — solid replacement for the regex horror
- `recordSegment` — much better timing with `audioContext.currentTime`

### Priority fixes remaining:

| Priority | What | Why |
|----------|------|-----|
| **P0** | Delete `state.js` or actually use it | Dead code that runs on load and can't work as designed |
| **P1** | Wire `i18n.js` OR delete it | Same — dead code creates confusion |
| **P1** | Import `SAMPLE_RATE` in `main.js` L78 | Defeats the purpose of `constants.js` |
| **P2** | Optimize `_filterOutliersIQR` | You fixed `filterOutliers` but left the equally-hot sibling untouched |
| **P2** | Add `sweepActive` flag for race condition (#4) | The animation loop / onComplete timing gap is still there |
| **P3** | Add unit tests for DSP modules | Still the biggest risk for regression bugs |

**Updated quality score**: 6.5/10 (up from 5/10). The core correctness bugs are gone, but dead code modules and the untouched `main.js` monolith + test gap hold it back.
