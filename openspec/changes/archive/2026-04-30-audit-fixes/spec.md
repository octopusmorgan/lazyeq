# Specification: `audit-fixes` — lazyeq Code Audit Remediation

## Change Metadata

| Field | Value |
|-------|-------|
| **Change Name** | `audit-fixes` |
| **Project** | `lazyeq` |
| **Type** | Remediation / Refactoring |
| **Author** | SDD Orchestrator |
| **Date** | 2026-04-30 |
| **Status** | Spec |
| **Specification Version** | 1 |

---

## Executive Summary

18 audit findings across 3 phases. Phase 1 (3 blockers) fixes correctness bugs that produce wrong EQ/visualization data. Phase 2 (6 architecture/quality) eliminates technical debt, duplication, and test gaps. Phase 3 (9 polish items) removes code smells and adds i18n. **B-2 is the most critical fix** — the log-to-linear FFT bin mapping is wrong for all frequencies above ~300Hz, corrupting every EQ calculation.

**Implementation order**: B-2 → B-1 → B-3 → Q-2/Q-4 (parallel) → Q-1/Q-5 → Q-6 → Q-3 → Phase 3

**Estimated total**: ~11 hours

---

## Phase 1 — Blockers

All Phase 1 tasks must be completed before any Phase 2 work. Phase 1 introduces no new external dependencies.

---

### B-1: `calibrateMicrophone` — Sweep Never Starts

**File**: `src/analyzer.js`  
**Lines**: ~114–125  
**Type**: Correctness bug (silent failure)  
**Risk**: Low  
**Effort**: ~15 minutes  
**Dependencies**: None  
**Verification**: Unit test or manual test that `recordedSpectrum` is not all-silent

#### Root Cause

`SineSweepSource` is created, buffered, connected to destination, but `.start()` is never called. `recordSegment(1)` therefore captures silence. Calibration returns `true` silently without any correction curve.

#### Current Code (analyzer.js L114–125)

```js
// Create test sweep (1 second)
const sweep = new SineSweepSource(this.audioContext);
sweep.createBuffer(1);
sweep.setVolume(0.5);

// Connect sweep to speakers (destination)
sweep.gainNode.connect(this.audioContext.destination);

// Record from existing analyser (which is connected to mic via this.stream)
// Just capture during the sweep
const recordedSpectrum = await this.recordSegment(1);

sweep.stop();
```

#### Specified Change

Add `sweep.start()` **before** `recordSegment(1)`:

```js
// Create test sweep (1 second)
const sweep = new SineSweepSource(this.audioContext);
sweep.createBuffer(1);
sweep.setVolume(0.5);

// Connect sweep to speakers (destination)
sweep.gainNode.connect(this.audioContext.destination);

// --- FIX: Start the sweep before recording ---
sweep.start();

// Record from existing analyser (which is connected to mic via this.stream)
// Just capture during the sweep
const recordedSpectrum = await this.recordSegment(1);

sweep.stop();
```

#### Test Requirements

1. **Unit test** (`tests/analyzer.test.js`): Mock `SineSweepSource`, verify `.start()` is called before `recordSegment` is called
2. **Manual test**: Run calibration, verify `analyzer.micCorrectionCurve` is populated (not `null`) when a speaker and mic are present

---

### B-2: `generateVisualizationData` — Log-to-Linear FFT Bin Mismatch

**File**: `src/eqGenerator.js`  
**Lines**: 139–152 (function body)  
**Type**: Correctness bug (severe data corruption)  
**Risk**: Medium  
**Effort**: ~1 hour  
**Dependencies**: None  
**Verification**: Regression tests with known frequency→bin mappings

#### Root Cause

The function maps a logarithmic frequency position (computed via `Math.log10`) to a **linear** bin index using a plain linear interpolation over the frequency range. The `frequencyLabels` array is linear (bin index × bin width), but the code treats the log-frequency position as if it directly maps to a linear index — this is fundamentally wrong.

**Mathematical error**: At 632Hz (≈14.4% through the 20Hz–20kHz log range), the current code computes:
```
logFreq ≈ 2.80, logMin ≈ 1.30, logMax ≈ 4.30
binIdx = floor(((2.80 - 1.30) / (4.30 - 1.30)) * (1024 - 1)) ≈ 511
```
But bin 511 corresponds to: `511 * (44100/2048) ≈ 11,015Hz` — not 632Hz.
Correct FFT bin for 632Hz: `floor(632 / (44100/2048)) = floor(632 / 21.53) ≈ 29`.

This corrupts **ALL** visualization and EQ data above ~300Hz.

#### Current Code (eqGenerator.js L144–148)

```js
for (let i = 0; i < numPoints; i++) {
  const freq = minFreq * Math.pow(maxFreq / minFreq, i / (numPoints - 1));
  const logFreq = Math.log10(freq);
  const binIdx = Math.floor(
    ((logFreq - logMin) / (logMax - logMin)) * (frequencyLabels.length - 1)
  );
  const safeIdx = Math.max(0, Math.min(binIdx, spectrum.length - 1));
  points.push({ x: freq, y: spectrum[safeIdx] || -100 });
}
```

#### Specified Change

Replace the log-linear bin index computation with a binary search over the linear `frequencyLabels` array:

```js
export function generateVisualizationData(spectrum, frequencyLabels, numPoints = 64) {
  if (!spectrum || spectrum.length === 0 || !frequencyLabels || frequencyLabels.length === 0) return [];
  const points = [];
  const minFreq = 20, maxFreq = 20000;

  // Binary search: find nearest linear-FT bin for a given log frequency.
  // frequencyLabels are linear: label[f] = f * (SAMPLE_RATE / FFT_SIZE).
  // Binary search is O(log n) and introduces no per-iteration allocations.
  for (let i = 0; i < numPoints; i++) {
    const freq = minFreq * Math.pow(maxFreq / minFreq, i / (numPoints - 1));

    // Binary search for closest bin in frequencyLabels
    let lo = 0, hi = frequencyLabels.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (frequencyLabels[mid] <= freq) lo = mid;
      else hi = mid;
    }
    const binIdx = (freq - frequencyLabels[lo]) <= (frequencyLabels[hi] - freq) ? lo : hi;

    points.push({ x: freq, y: spectrum[binIdx] || -100 });
  }
  return points;
}
```

**Note**: Remove the unused variables `logMin`, `logMax`, `logFreq`, `binIdx`, `safeIdx` that existed in the old loop body.

#### Test Requirements

1. **Regression tests** with known frequency→bin mappings:
   - At 632Hz (FFT bin ≈ 29 at 44100Hz/2048): verify the returned point's `y` value matches `spectrum[29]`
   - At 1000Hz (FFT bin ≈ 95): verify correct bin
   - At 10000Hz (FFT bin ≈ 927): verify correct bin
   - Verify returned `x` (frequency) values are strictly increasing (monotonic log)
2. Test that function returns `[]` when inputs are empty/invalid
3. Test `numPoints` parameter is respected
4. Use `node --test tests/eqGenerator.test.js` (existing runner)

#### Dependencies

None — independent task, do first.

---

### B-3: `recordSegment` — setTimeout Timing Unreliable on Mobile

**File**: `src/analyzer.js`  
**Lines**: 71–101  
**Type**: Correctness bug (mobile/background tab failure)  
**Risk**: Medium  
**Effort**: ~1.5 hours  
**Dependencies**: None  
**Verification**: Unit test + mobile manual test

#### Root Cause

`setTimeout(processFrame, (framesPerBuffer / SAMPLE_RATE) * 1000)` has a ~4ms browser minimum clamp and is throttled to ~1Hz in background tabs on mobile. At 44.1kHz / 2048 samples per buffer, nominal interval is ~46ms — but in a background mobile tab it becomes ~1000ms, making recordings useless.

#### Current Code (analyzer.js L71–101)

```js
async recordSegment(duration = 3) {
  const framesPerBuffer = FFT_SIZE;
  const totalFrames = Math.ceil((duration * SAMPLE_RATE) / framesPerBuffer);
  const frequencyData = new Float32Array(FFT_SIZE / 2);
  let frameCount = 0;

  return new Promise((resolve) => {
    const processFrame = () => {
      const data = new Float32Array(FFT_SIZE / 2);
      this.analyserNode.getFloatFrequencyData(data);

      for (let i = 0; i < data.length; i++) {
        frequencyData[i] += data[i];
      }

      frameCount++;

      if (frameCount < totalFrames) {
        setTimeout(processFrame, (framesPerBuffer / SAMPLE_RATE) * 1000);
      } else {
        const result = new Float32Array(FFT_SIZE / 2);
        for (let i = 0; i < result.length; i++) {
          result[i] = frequencyData[i] / frameCount;
        }
        resolve(result);
      }
    };

    processFrame();
  });
}
```

#### Specified Change

Replace `setTimeout`-only scheduling with `requestAnimationFrame` + `audioContext.currentTime` synchronization:

```js
async recordSegment(duration = 3) {
  const framesPerBuffer = FFT_SIZE;
  const totalFrames = Math.ceil((duration * SAMPLE_RATE) / framesPerBuffer);
  const frequencyData = new Float32Array(FFT_SIZE / 2);
  let frameCount = 0;
  let scheduledFrameTime = 0; // tracks expected time of next frame

  return new Promise((resolve) => {
    const scheduleNext = (now) => {
      // Compute delay until the next frame is due.
      // Using requestAnimationFrame keeps polling alive even when
      // backgrounded on desktop; audioContext.currentTime is never throttled.
      const delay = Math.max(0, (scheduledFrameTime - now));
      setTimeout(() => requestAnimationFrame(processFrame), delay);
    };

    const processFrame = (rafTimestamp) => {
      const now = this.audioContext.currentTime;
      const data = new Float32Array(FFT_SIZE / 2);
      this.analyserNode.getFloatFrequencyData(data);

      for (let i = 0; i < data.length; i++) {
        frequencyData[i] += data[i];
      }

      frameCount++;

      if (frameCount < totalFrames) {
        // Advance expected time by one buffer duration
        scheduledFrameTime = now + (framesPerBuffer / SAMPLE_RATE);
        scheduleNext(now);
      } else {
        const result = new Float32Array(FFT_SIZE / 2);
        for (let i = 0; i < result.length; i++) {
          result[i] = frequencyData[i] / frameCount;
        }
        resolve(result);
      }
    };

    // Bootstrap: capture start time and begin looping
    scheduledFrameTime = this.audioContext.currentTime + (framesPerBuffer / SAMPLE_RATE);
    requestAnimationFrame(processFrame);
  });
}
```

#### Test Requirements

1. **Unit test**: Mock `analyserNode.getFloatFrequencyData` and `audioContext.currentTime`. Verify that after `n` frames, `result[i] === frequencyData[i] / n` for all `i`.
2. **Unit test**: Verify `scheduledFrameTime` advances correctly per frame
3. **Manual test**: Run on mobile Chrome in background tab, verify frame timing is correct

#### Dependencies

None. Independent from B-1 and B-2. Can be done in parallel with B-1.

---

## Phase 2 — Architecture & Quality

All Phase 2 tasks may be done in parallel after Phase 1. Q-3 (tests) should be done last to avoid test pollution from ongoing code changes.

---

### Q-1: main.js God Module Extraction

**File**: `src/main.js` (1024 LOC → slimmed)  
**New files**: `src/ui.js`, `src/state.js`, `src/events.js`  
**Type**: Structural refactoring  
**Risk**: Medium  
**Effort**: ~3 hours  
**Dependencies**: Phase 1 (B-1, B-2, B-3 must land first to avoid extracting broken code)

#### Overview

`main.js` mixes UI, canvas rendering, DSP state, event handling, and export logic. Extract into focused modules. **No behavioral changes** — this is purely structural reorganization.

#### Module Map

| New File | Responsibility | Approx LOC |
|----------|---------------|------------|
| `src/state.js` | Module-level mutable state: `analyzer`, `sweepSource`, `roomCalibration`, `animationFrame`, `frameCount`, `accumulatedSpectrum`, `sweepDuration`, `selectedMicDeviceId`, `audioContext` | ~80 |
| `src/ui.js` | DOM refs, canvas setup/resize, `renderSpectrum`, `renderEQCurve`, `resizeCanvases`, `populateEQTable`, `downloadFile`, `showRoomWalkOverlay`, `hideRoomWalkOverlay` | ~200 |
| `src/events.js` | All `addEventListener` calls, wiring callbacks to state | ~100 |
| `src/main.js` (slimmed) | Imports all modules, orchestration, `initAudioContext`, `ensureAudioContext`, `processSweepResults`, `processRoomWalkResults`, `gaussianSmooth`, `adaptiveSmooth`, top-level `lazyEqTest` export | ~400–500 |

#### Specified Changes

1. **Create `src/state.js`**:
   ```js
   // Module-level shared mutable state — avoid global window pollution
   export const state = {
     analyzer: null,
     sweepSource: null,
     roomCalibration: null,
     animationFrame: null,
     frameCount: 0,
     accumulatedSpectrum: null,
     sweepDuration: 8,
     selectedMicDeviceId: null,
     audioContext: null,
   };
   ```

2. **Create `src/ui.js`**: Move canvas rendering functions from `main.js`: `renderSpectrum`, `renderEQCurve`, `resizeCanvases`, `populateEQTable`, `downloadFile`, `showRoomWalkOverlay`, `hideRoomWalkOverlay`. Also move all `const canvasX = document.getElementById(...)` DOM references here.

3. **Create `src/events.js`**: Move all `addEventListener` calls from `main.js` here. Import state from `state.js`, ui functions from `ui.js`.

4. **Slim `src/main.js`**: Remove extracted functions and DOM references. Keep only orchestration logic and the two `process*Results` functions. Import from `state.js`, `ui.js`, `events.js`.

#### Constraints

- No variable/function renames beyond what's needed for import/export wiring
- No behavioral changes
- `npm test` must pass after refactoring
- `globalThis.lazyEqTest` stays in `main.js` (used by `test.js` smoke test)

#### Test Requirements

1. After extraction, run `npm test` — all existing tests must pass
2. Manual smoke test: page loads without console errors, canvases render, buttons are wired

#### Dependencies

All Phase 1 blockers. Can run in parallel with Q-2, Q-4, Q-5, Q-6.

---

### Q-2: `processSweepResults` / `processRoomWalkResults` Code Duplication

**File**: `src/main.js`  
**Lines**: 748–870 (processSweepResults) and 902–1012 (processRoomWalkResults)  
**Type**: Code duplication (~80% overlap)  
**Risk**: Low  
**Effort**: ~1 hour  
**Dependencies**: None (can be done independently)

#### Root Cause

Two nearly identical functions that differ only in: gain limit constants (`MAX_GAIN`/`MAX_CUT`/`BASS_MAX` vs `ROOM_MAX_GAIN`/`ROOM_MAX_CUT`/`ROOM_BASS_MAX`), smoothing factor (`1.0` vs `1.5`), and noise subtraction step (present in sweep, skipped in room-walk).

#### Specified Change

Extract shared post-processing into a private function `_processMeasurementResults(averagedSpectrum, options)`:

```js
/**
 * Shared post-processing for sweep and room-walk measurement results.
 * @param {Float32Array} spectrum - Corrected, mic-calibration-applied spectrum
 * @param {object} options
 * @param {object} options.gainLimits - { maxGain, maxCut, bassMax }
 * @param {number} options.smoothingFactor - sigma multiplier for adaptiveSmooth
 * @param {string} options.statusPrefix - e.g. "" or "Room walk "
 * @param {boolean} options.skipNoiseSubtraction - true for room walk
 * @returns {{ visData, gains, smoothedResponse, normalizedResponse }}
 */
function _processMeasurementResults(spectrum, options = {}) {
  const {
    gainLimits = { maxGain: 8, maxCut: -12, bassMax: 4 },
    smoothingFactor = 1.0,
    statusPrefix = "",
  } = options;

  const linearFreqLabels = state.analyzer
    ? state.analyzer.getLinearFrequencyLabels()
    : null;

  const visData = linearFreqLabels
    ? generateVisualizationData(spectrum, linearFreqLabels)
    : [];

  const responseArr = new Float32Array(visData.length);
  visData.forEach((d, i) => { responseArr[i] = d.y; });

  const smoothedResponse = adaptiveSmooth(responseArr, smoothingFactor);

  // Normalize: center the measurement average in 100Hz–10kHz to 0dB
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

  const rawGains = new Float32Array(visData.length);
  for (let i = 0; i < visData.length; i++) {
    const targetOffset = getHarmanTargetDB(visData[i].x);
    rawGains[i] = targetOffset - normalizedResponse[i];
  }

  const gains = Array.from(rawGains).map((g, i) => {
    let gain = g;
    if (visData[i].x < 100) gain = Math.min(gain, gainLimits.bassMax);
    return Math.max(gainLimits.maxCut, Math.min(gainLimits.maxGain, gain));
  });

  return { visData, gains, smoothedResponse, normalizedResponse, rangeAvg };
}
```

Then simplify both `processSweepResults` and `processRoomWalkResults` to:
```js
async function processSweepResults() {
  // ... validation (unchanged)
  const corrected = state.analyzer.getCorrectedSpectrumFromDB(state.accumulatedSpectrum);
  const { visData, gains, rangeAvg } = _processMeasurementResults(corrected, {
    gainLimits: { maxGain: 8, maxCut: -12, bassMax: 4 },
    smoothingFactor: 1.0,
    statusPrefix: "",
  });
  // ... rendering and export (unchanged)
}
```

#### Test Requirements

1. After refactoring, run `npm test`
2. Manual test: run a sweep, verify EQ curve and export data are identical (bit-exact) before/after refactor

#### Dependencies

None. Can be done in parallel with Q-1.

---

### Q-3: Zero Test Coverage (analyzer.js, roomCalibration.js)

**Files**: `src/analyzer.js`, `src/roomCalibration.js`  
**New test files**: `tests/analyzer.test.js`, `tests/roomCalibration.test.js`  
**Type**: Test coverage gap  
**Risk**: Low  
**Effort**: ~2 hours  
**Dependencies**: Phase 1 (all fixes land), Q-1 (optional — tests use the real modules)

#### Approach

Use `node --test` (built-in Node test runner, already used by `tests/eqGenerator.test.js`). No Vitest or jsdom dependency. For browser-only APIs (`AudioContext`, `AnalyserNode`), mock the objects or test only pure functions.

#### Test File: `tests/analyzer.test.js`

| Test | Target | Approach |
|------|--------|----------|
| `recordSegment returns averaged spectrum` | `recordSegment` | Mock `analyserNode.getFloatFrequencyData` to return known values; verify averaging |
| `calibrateMicrophone calls sweep.start()` | `calibrateMicrophone` | Mock `SineSweepSource`; verify `.start()` called |
| `getCorrectedSpectrumFromDB applies micCorrectionCurve` | `getCorrectedSpectrumFromDB` | Set `micCorrectionCurve` to known values; verify subtraction |
| `getCorrectedSpectrumFromDB applies noise subtraction` | `getCorrectedSpectrumFromDB` | Set `noiseBuffer`; verify signal - noise formula |
| `getRMSLevel returns finite dB` | `getRMSLevel` | Mock `analyserNode.getFloatTimeDomainData`; verify finite return |
| `getFrequencyLabels returns ISO freqs` | `getFrequencyLabels` | Pure function — verify length and first/last values |
| `getLinearFrequencyLabels correct bin width` | `getLinearFrequencyLabels` | Verify `labels[1] - labels[0] === SAMPLE_RATE/FFT_SIZE` |
| `destroy cleans up stream` | `destroy` | Mock `stream.getTracks()`; verify `.stop()` called |

```js
// Conceptual structure for analyzer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

// Mock audio context and analyser node for testing
function createMockAnalyzer() {
  const mockData = new Float32Array(1024).fill(-80);
  return {
    audioContext: { currentTime: 0 },
    analyserNode: {
      getFloatFrequencyData: (arr) => arr.set(mockData),
      getFloatTimeDomainData: (arr) => arr.fill(0.001),
    },
    stream: { getTracks: () => [{ stop: () => {} }] },
    sourceNode: { disconnect: () => {} },
    noiseBuffer: null,
    micCorrectionCurve: null,
  };
}
```

#### Test File: `tests/roomCalibration.test.js`

| Test | Target | Approach |
|------|--------|----------|
| `isValidMeasurement returns true for loud signal` | `isValidMeasurement` | Pass spectrum with max > -80; verify true |
| `isValidMeasurement returns false for quiet signal` | `isValidMeasurement` | Pass spectrum with max < -80; verify false |
| `filterOutliers removes measurements with >50% outlier bins` | `filterOutliers` | Create 5 measurements, 1 outlier; verify filtered correctly |
| `filterOutliers keeps all measurements when none are outliers` | `filterOutliers` | All similar measurements; verify all kept |
| `calculateWeightedAverage returns Float32Array` | `calculateWeightedAverage` | Verify return type and length |
| `getAveragedSpectrum throws on insufficient measurements` | `getAveragedSpectrum` | Pass < minValidMeasurements; verify throws |
| `_filterOutliersIQR is called within getAveragedSpectrum` | `_filterOutliersIQR` | Integration test: verify IQR filtering affects output |

#### Test Requirements

1. All new tests must pass with `node --test tests/analyzer.test.js` and `node --test tests/roomCalibration.test.js`
2. Existing `node --test tests/eqGenerator.test.js` continues to pass
3. No breaking changes to existing modules

#### Dependencies

Phase 1 (all). Must be done after all code changes to avoid test pollution. Can be done in parallel with Q-4, Q-5, Q-6.

---

### Q-4: `filterOutliers` O(n²·m) Performance

**File**: `src/roomCalibration.js`  
**Lines**: 154–179  
**Type**: Performance (excessive memory allocations)  
**Risk**: Low  
**Effort**: ~1 hour  
**Dependencies**: None

#### Root Cause

At n=15 measurements × m=1024 bins, the inner loop at L165 calls `.map()` on `this.measurements` on every iteration of the outer loop — creating 15 × 1024 = 15,360 temporary arrays per call.

#### Current Code (roomCalibration.js L154–179)

```js
filterOutliers() {
  const valid = [];
  const n = this.measurements.length;
  if (n < 2) return this.measurements;
  const bins = this.measurements[0].spectrum.length;

  for (let m = 0; m < n; m++) {
    let outlierBins = 0;

    for (let f = 0; f < bins; f++) {
      const values = this.measurements.map(meas => meas.spectrum[f]); // 1024 allocations per m
      const mean = values.reduce((a, b) => a + b, 0) / n;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      const stdDev = Math.sqrt(variance);
      const diff = Math.abs(this.measurements[m].spectrum[f] - mean);

      if (diff > 2 * stdDev && stdDev > 3) outlierBins++;
    }

    if (outlierBins / bins < 0.5) {
      valid.push(this.measurements[m]);
    }
  }

  return valid;
}
```

#### Specified Change

Two-pass algorithm: (1) pre-compute per-bin mean + stdDev in O(n·m) with zero per-iteration allocations; (2) score each measurement in O(n·m):

```js
filterOutliers() {
  const valid = [];
  const n = this.measurements.length;
  if (n < 2) return this.measurements;
  const bins = this.measurements[0].spectrum.length;

  // Step 1: compute per-bin mean + stdDev in O(n·m), zero allocations
  const perBinStats = new Float32Array(bins * 2); // [mean, stdDev] per bin
  for (let f = 0; f < bins; f++) {
    let sum = 0;
    for (let m = 0; m < n; m++) sum += this.measurements[m].spectrum[f];
    const mean = sum / n;
    let varSum = 0;
    for (let m = 0; m < n; m++) varSum += (this.measurements[m].spectrum[f] - mean) ** 2;
    perBinStats[f * 2] = mean;
    perBinStats[f * 2 + 1] = Math.sqrt(varSum / n);
  }

  // Step 2: score each measurement in O(n·m), zero allocations
  for (let m = 0; m < n; m++) {
    let outlierBins = 0;
    for (let f = 0; f < bins; f++) {
      const mean = perBinStats[f * 2];
      const stdDev = perBinStats[f * 2 + 1];
      if (stdDev > 3 && Math.abs(this.measurements[m].spectrum[f] - mean) > 2 * stdDev) {
        outlierBins++;
      }
    }
    if (outlierBins / bins < 0.5) valid.push(this.measurements[m]);
  }

  return valid;
}
```

#### Test Requirements

1. Functional equivalence test: same input measurements → same output (verify algorithm is functionally identical)
2. Performance test: measure allocation count before/after (should drop from ~15,000 to 0 per call)
3. Run existing `npm test` to ensure no regressions

#### Dependencies

None.

---

### Q-5: Fragile Hex-to-RGBA Regex

**File**: `src/main.js`  
**Lines**: ~209 (fillGradient assignment)  
**Type**: Code smell (fragile string manipulation)  
**Risk**: Low  
**Effort**: ~30 minutes  
**Dependencies**: None

#### Current Code (main.js L209)

```js
fillGradient.addColorStop(0, baseColor.replace(')', ', 0.25)').replace('rgb', 'rgba').replace('#', 'rgba(').replace(/([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i, (m,r,g,b) => `${parseInt(r,16)}, ${parseInt(g,16)}, ${parseInt(b,16)}, 0.25)`));
```

This chain of `.replace()` calls is fragile: the order of replacements matters, and variations in hex format (e.g., `#RGB` shorthand) will produce malformed CSS.

#### Specified Change

Add a `hexToRgba(hex, alpha)` helper to `src/main.js` (or `src/ui.js` after Q-1) and use it:

```js
/**
 * Convert a hex color string to rgba(r, g, b, alpha).
 * Handles both 6-digit (#RRGGBB) and 3-digit (#RGB) formats.
 * @param {string} hex - Hex color string (e.g., "#00f5d4" or "#0f5")
 * @param {number} alpha - Alpha value (0–1)
 * @returns {string} rgba(r, g, b, alpha) string
 */
function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  const r = parseInt(full.substring(0, 2), 16);
  const g = parseInt(full.substring(2, 4), 16);
  const b = parseInt(full.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
```

Then replace the fragile chain with:
```js
fillGradient.addColorStop(0, hexToRgba(baseColor, 0.25));
```

#### Test Requirements

1. Unit test: verify `hexToRgba('#00f5d4', 0.25)` returns `'rgba(0, 245, 212, 0.25)'`
2. Unit test: verify `hexToRgba('#0f5', 0.5)` returns `'rgba(15, 255, 85, 0.5)'` (3-digit shorthand)
3. Run `npm test`

#### Dependencies

None.

---

### Q-6: `test.js` Smoke Test Fragility

**File**: `test.js`  
**Lines**: 56–62  
**Type**: Test reliability  
**Risk**: Low  
**Effort**: ~30 minutes  
**Dependencies**: None

#### Current Code (test.js L56–62)

```js
const jsFiles = fs.readdirSync(path.join(__dirname, 'dist/assets')).filter(f => f.endsWith('.js'));
assert(jsFiles.length > 0, 'No JS files found');
const js = fs.readFileSync(path.join(__dirname, 'dist/assets', jsFiles[0]), 'utf8');
assert(js.length > 1000, 'JS file seems too small - only ' + js.length + ' bytes');
console.log('   JS bundle size:', js.length, 'bytes');
```

The test reads **only the first** `.js` file alphabetically. If Vite changes bundle naming (e.g., adds hash prefixes), the first file might be a small manifest or a stale file, causing the test to silently pass on an empty bundle.

#### Specified Change

Glob for all `.js` files and verify each contains expected markers, or use Vite's programmatic API. Since this project uses Vite 6, use `import.meta.glob` or `fs.readdirSync` with a filter:

```js
// test.js — replace the fragile single-file check with a multi-file verification
const jsDir = path.join(__dirname, 'dist/assets');
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
assert(jsFiles.length > 0, 'No JS files found');

// Verify ALL js files, not just the first one
let totalBytes = 0;
for (const jsFile of jsFiles) {
  const js = fs.readFileSync(path.join(jsDir, jsFile), 'utf8');
  assert(js.length > 100, `JS file ${jsFile} is suspiciously small (${js.length} bytes)`);
  totalBytes += js.length;
}

// Verify key markers exist across the bundle set
const allJs = jsFiles.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
assert(allJs.includes('lazyEqTest'), 'lazyEqTest missing from bundle');
assert(allJs.includes('canvas-spectrum'), 'canvas-spectrum missing from bundle');
assert(allJs.includes('canvas-eq'), 'canvas-eq missing from bundle');

console.log(`   Total JS bundle size: ${totalBytes} bytes across ${jsFiles.length} file(s)`);
```

#### Test Requirements

1. Run `npm run build && node test.js` — must pass
2. Verify the test fails meaningfully if the bundle is empty (not silently pass)

#### Dependencies

None.

---

## Phase 3 — Polish

9 independent minor fixes. Can be done incrementally throughout any phase or as a batch at the end.

---

### P-1: `SAMPLE_RATE = 44100` Centralization

**Files**: `src/analyzer.js`, `src/sineSweep.js`, `src/main.js`  
**Finding**: `#7`  
**Effort**: ~10 minutes  

Create `src/constants.js`:
```js
export const SAMPLE_RATE = 44100;
export const FFT_SIZE = 2048;
export const MIC_REFERENCE_OFFSET = 90; // dB offset for getRMSLevel
```

Then import in all three files, replacing hardcoded `44100`.

**Test**: `npm test` passes.

---

### P-2: `sineSweep.stop()` Error Swallowing

**File**: `src/sineSweep.js` L85  
**Finding**: `#10`  
**Effort**: ~5 minutes  

Change:
```js
} catch (e) {}
```
to:
```js
} catch (e) {
  if (import.meta.env.DEV) console.warn('Sweep stop error:', e);
}
```

---

### P-3: Named constant for `+90` in `getRMSLevel`

**File**: `src/analyzer.js` L262  
**Finding**: `#11`  
**Effort**: ~5 minutes  

After Q-1 constants extraction: `const MIC_REFERENCE_OFFSET = 90;` in `constants.js`.  
In `getRMSLevel`: replace `+ 90` with `+ MIC_REFERENCE_OFFSET`.

---

### P-4: `analyzer.destroy()` in try/finally

**File**: `src/main.js` L851–855, L994–998  
**Finding**: `#16`  
**Effort**: ~10 minutes  

Wrap each `analyzer.destroy()` in try/finally:
```js
try {
  // ... existing cleanup
} finally {
  if (state.analyzer) {
    state.analyzer.destroy();
    state.analyzer = null;
  }
}
```

---

### P-5: `getHarmanTargetDB` Key Parsing Cache

**File**: `src/eqGenerator.js` L33  
**Finding**: `#17`  
**Effort**: ~10 minutes  

Cache the sorted keys array as a module-level constant:
```js
const _harMAN_TARGET_KEYS = Object.keys(HARMAN_TARGET).map(Number).sort((a, b) => a - b);

function getHarmanTargetDB(freq) {
  const freqs = _harMAN_TARGET_KEYS; // reuse cached value
  // ... rest unchanged
}
```

---

### P-6: Mixed English/Spanish UI Strings

**File**: `src/main.js` L685, L693  
**Finding**: `#14`  
**Effort**: ~1 hour  

Create `src/i18n.js`:
```js
export const i18n = {
  roomWalkMeasurements: (current, total) => `Mediciones: ${current}/${total}`,
  // Add other UI strings here
};
```

Replace hardcoded strings in `main.js`:
```js
// Before:
roomwalkCounter.textContent = "Mediciones: 0/15";

// After:
roomwalkCounter.textContent = i18n.roomWalkMeasurements(0, 15);
```

---

### P-7: `loadDevices()` Eager at Module Load

**File**: `src/main.js` L123  
**Finding**: `#15`  
**Effort**: ~5 minutes  

Change:
```js
// Load devices on page load
loadDevices();
```
to:
```js
// Defer device loading until user interaction (required by some browsers)
document.addEventListener('DOMContentLoaded', () => {
  // Only call loadDevices after a user gesture to satisfy autoplay policies
});
```

Or wrap in an `init()` function called explicitly.

---

### P-8: RAF vs Sweep `onComplete` Race

**File**: `src/main.js` L620–631  
**Finding**: `#4`  
**Effort**: ~1 hour  

The `setTimeout(..., 500)` in the sweep complete handler creates a race with the live sweep `requestAnimationFrame` loop. If the user clicks "Stop" before the 500ms timeout fires, the sweep's `onComplete` may fire after manual processing, causing double-processing.

**Fix**: Use a promise-based completion flag and cancel the RAF on sweep complete:
```js
let sweepCompletePending = null;

sweepSource.onComplete = async () => {
  // Cancel any pending RAF
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  
  // Cancel any pending manual stop processing
  if (sweepCompletePending) {
    clearTimeout(sweepCompletePending);
    sweepCompletePending = null;
  }
  
  statusSweep.textContent = "Sweep finished — processing...";
  statusSweep.className = "status info";
  btnStop.disabled = true;

  await processSweepResults();
};
```

In `btnStop` handler, track the pending timeout:
```js
// In btnStop handler, clear the sweep's onComplete to prevent double-processing
if (sweepSource) {
  sweepSource.onComplete = null; // prevent both paths from firing
  sweepSource.stop();
  sweepSource = null;
}
```

---

### P-9: Gains Stored in DOM Dataset

**File**: `src/main.js` L847–848, L874, L882  
**Finding**: `#9`  
**Effort**: ~30 minutes  

Replace `btnExportWavelet.dataset.gains = JSON.stringify(gains)` with a closure-based store or a `Map`:

```js
// In state.js:
export const exportState = {
  currentGains: null,
};

// When gains are computed (in processSweepResults/processRoomWalkResults):
state.exportState.currentGains = gains;

// In export handlers:
btnExportWavelet.addEventListener('click', () => {
  const gains = state.exportState.currentGains;
  if (!gains) { console.warn('No gains to export'); return; }
  const content = exportWavelet(gains);
  downloadFile('lazyeq-wavelet.txt', content);
  // ...
});
```

Remove `btnExportWavelet.dataset.gains` and `btnExportEqMac.dataset.gains` assignments.

---

## Task Dependency Graph

```
B-2 (log-to-linear bin mapping) ──────────────────────────────────┐
                                                                    │
B-1 (sweep.start) ──────────────────────────────┐                  │
                                                   │                  │
B-3 (setTimeout timing) ───────────────────────┐ │                  │
                                                  │ │                  │
Q-4 (filterOutliers perf) ────────────────────┐ │ │                  │
                                                 │ │                  │
Q-2 (process* duplication) ───────────────────┐ │ │ │                │
                                                │ │ │ │                │
Q-5 (hexToRgba) ──────────────────────────────┐ │ │ │ │                │
                                                │ │ │ │ │              │
Q-6 (test.js fragility) ──────────────────────┐ │ │ │ │ │              │
                                                  │ │ │ │ │ │            │
Q-1 (main.js extraction) ────────────────────────┴─┴─┴─┴─┴──────────┐
                                                                       │
Q-3 (test coverage) ──────────────────────────────────────────────────┘

Phase 3 items (P-1 through P-9): all independent, can run in parallel with any phase
```

---

## Success Criteria

| Criterion | Target | Verification |
|-----------|--------|--------------|
| B-1: sweep starts | `sweep.start()` called before `recordSegment` | Unit test mocks verify call order |
| B-2: correct FFT bin mapping | 632Hz maps to bin ~29 (not 511) | Regression test with known mappings |
| B-3: no setTimeout in recordSegment | `setTimeout` call removed from `recordSegment` | Code inspection + unit test |
| Q-1: main.js reduced | ≤600 LOC | `wc -l src/main.js` |
| Q-2: duplication eliminated | `processSweepResults`/`processRoomWalkResults` share common helper | Code inspection |
| Q-3: test coverage | `analyzer.js` and `roomCalibration.js` have ≥80% coverage | `node --test --coverage` |
| Q-4: zero temp allocations | `filterOutliers` creates no per-iteration arrays | Code inspection |
| Q-5: hexToRgba helper | Named function replaces fragile regex chain | Unit tests |
| Q-6: smoke test robust | Reads all JS files, not just first | Manual test with renamed bundle |
| All phases | `npm test` passes in CI | CI pipeline |