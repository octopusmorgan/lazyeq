# Proposal: `audit-fixes` — lazyeq Code Audit Remediation

## Change Metadata

| Field | Value |
|-------|-------|
| **Change Name** | `audit-fixes` |
| **Project** | `lazyeq` |
| **Type** | Remediation / Refactoring |
| **Author** | SDD Orchestrator |
| **Date** | 2026-04-30 |
| **Status** | Proposed |

---

## 1. Intent

Fix 18 audit findings identified in a full code review, organized into three phases:
**Blockers** (correctness bugs that produce wrong results) → **Architecture/Quality** (technical debt, code duplication, test gaps) → **Polish** (minor code smells, UX inconsistencies).

---

## 2. Scope

### Files In Scope

| File | LOC | Role |
|------|-----|------|
| `src/main.js` | 1024 | God Module — UI, canvas, DSP, state, exports |
| `src/analyzer.js` | 291 | Mic capture, FFT, calibration |
| `src/sineSweep.js` | 94 | Log sine sweep generator |
| `src/eqGenerator.js` | 154 | EQ curve math, export formats |
| `src/roomCalibration.js` | 270 | Room walk multi-position averaging |
| `test.js` | 83 | Build smoke test |
| `tests/eqGenerator.test.js` | 62 | Existing unit tests |
| `package.json` | 17 | Test scripts |

### Files Out of Scope
- `index.html`, CSS, assets (no audit findings)
- Build pipeline (Vite config untouched)

---

## 3. Approach

### Phase 1 — Blockers (Must Fix, Estimated: ~3h)

#### B-1: `calibrateMicrophone` — Sweep Never Starts (analyzer.js L114–123)

**Root Cause**: `SineSweepSource` is created, buffer built, gain connected, but `start()` is never called. `recordSegment(1)` captures silence, and the calibration silently returns `true` without any correction.

**Fix** (analyzer.js):
```js
// Before (broken):
const sweep = new SineSweepSource(this.audioContext);
sweep.createBuffer(1);
sweep.setVolume(0.5);
sweep.gainNode.connect(this.audioContext.destination);
const recordedSpectrum = await this.recordSegment(1);  // captures silence!
sweep.stop();

// After (fixed):
const sweep = new SineSweepSource(this.audioContext);
sweep.createBuffer(1);
sweep.setVolume(0.5);
sweep.gainNode.connect(this.audioContext.destination);
sweep.start();  // <-- MISSING CALL ADDED
const recordedSpectrum = await this.recordSegment(1);
sweep.stop();
```

**Risk**: Low. Single-line addition, directly fixes the bug.

#### B-2: `generateVisualizationData` — Log-to-Linear Bin Mismatch (eqGenerator.js L147)

**Root Cause**: The function maps a logarithmic frequency position to a **linear** bin index. At 632Hz (roughly 14.4% through the 20Hz–20kHz log range), it computes `binIdx = 511`, when the correct FFT bin is ~29. This corrupts **all** visualizations and EQ calculations for mid/high frequencies.

**Fix** (eqGenerator.js L144–148):
```js
// Before (broken — linear mapping of log position):
const binIdx = Math.floor(
  ((logFreq - logMin) / (logMax - logMin)) * (frequencyLabels.length - 1)
);

// After (correct — map log frequency to FFT bin via linear frequency labels):
const freq = minFreq * Math.pow(maxFreq / minFreq, i / (numPoints - 1));
// freq is already computed above at line 145 — use it directly:
// Look up the nearest bin in the linear frequency labels:
const binIdx = (() => {
  // frequencyLabels are linear (i * binWidth), so binary search is appropriate
  // Binary search for closest bin
  let lo = 0, hi = frequencyLabels.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frequencyLabels[mid] <= freq) lo = mid;
    else hi = mid;
  }
  return (freq - frequencyLabels[lo]) <= (frequencyLabels[hi] - freq) ? lo : hi;
})();
```

**Impact**: High. Every visualization and EQ calculation is currently wrong above ~300Hz.

**Risk**: Medium. Binary search introduces a new algorithm; thorough unit tests required.

#### B-3: `recordSegment` — setTimeout Timing (analyzer.js L89)

**Root Cause**: `setTimeout(processFrame, (framesPerBuffer / SAMPLE_RATE) * 1000)` has a ~4ms minimum clamp and is throttled to 1Hz in background tabs on mobile. At 44.1kHz / 2048 samples per buffer, the nominal interval is ~46ms — but on mobile in background, it becomes 1000ms, making recordings useless.

**Fix** (analyzer.js): Replace `setTimeout`-based frame loop with Web Audio API's `AudioContext.currentTime`-based scheduling, or use a `AnalyserNode` `getFloatFrequencyData` poll via `requestAnimationFrame` synchronized to `audioContext.currentTime`.

```js
// Replace setTimeout approach with RAF + AudioContext time:
async recordSegment(duration = 3) {
  const framesPerBuffer = FFT_SIZE;
  const totalFrames = Math.ceil((duration * SAMPLE_RATE) / framesPerBuffer);
  const frequencyData = new Float32Array(FFT_SIZE / 2);
  const startTime = this.audioContext.currentTime;
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
        const expectedTime = startTime + (frameCount * framesPerBuffer / SAMPLE_RATE);
        const delay = Math.max(0, (expectedTime - this.audioContext.currentTime) * 1000);
        setTimeout(processFrame, delay);
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

**Risk**: Medium. Changes async timing behavior; needs mobile/background testing.

---

### Phase 2 — Architecture & Quality (Estimated: ~6h)

#### Q-1: main.js God Module (1024 lines)

**Problem**: Single file mixing DOM manipulation, canvas rendering, DSP, state management, event handling, AudioContext lifecycle, and export logic.

**Fix**: Extract into focused modules:

| New File | Responsibility | Approx LOC |
|----------|---------------|------------|
| `src/ui.js` | DOM refs, canvas setup, resize logic, renderSpectrum/renderEQCurve | ~200 |
| `src/state.js` | Shared mutable state (accumulatedSpectrum, frameCount, analyzer, sweepSource) | ~80 |
| `src/events.js` | All event listener wiring | ~100 |
| `src/main.js` ( slimmed) | Orchestration only — wires ui/state/events, calls eqGenerator | ~150 |

**Timeline**: Slim `main.js` to ~400 lines in Phase 2, full extraction in follow-up change.

#### Q-2: `processSweepResults` / `processRoomWalkResults` Duplication (~80%, main.js L748–1012)

**Problem**: Two nearly identical functions for processing sweep vs. room-walk results.

**Fix**: Extract common post-processing into a shared private function:
```js
// In main.js — extracted common logic
function _processMeasurementResults(averagedSpectrum, options = {}) {
  const {
    gainLimits = { maxGain: 8, maxCut: -12, bassMax: 4 },
    smoothingFactor = 1.0,
    statusPrefix = "",
  } = options;
  // ... shared logic, returns { visData, gains, smoothedResponse }
}
```

Then both `processSweepResults` and `processRoomWalkResults` call this with different `options`.

**Estimated**: ~80 lines deduplicated.

#### Q-3: Zero Test Coverage (analyzer.js, roomCalibration.js, main.js)

**Problem**: Only `eqGenerator.js` has unit tests (7 tests). No coverage for the core DSP and measurement logic.

**Fix**: Add tests using Vitest (compatible with Vite) + jsdom or happy-dom for DOM tests:

| Test File | Coverage Target | Approx Tests |
|-----------|----------------|--------------|
| `tests/analyzer.test.js` | `recordSegment`, `calibrateMicrophone`, `getCorrectedSpectrumFromDB`, `getRMSLevel` | 8–12 |
| `tests/roomCalibration.test.js` | `filterOutliers`, `calculateWeightedAverage`, `isValidMeasurement` | 10–15 |
| `tests/ui.test.js` | Canvas rendering functions (scaffold with mocks) | 5–8 |

**Risk**: Low. Tests isolated to pure functions and mocked dependencies.

#### Q-4: `filterOutliers` O(n²·m) (roomCalibration.js L154–179)

**Problem**: At n=15 measurements × m=1024 bins, the inner loop at L165 creates a new array via `.map()` on every iteration of the outer loop, causing 15,360 temporary allocations.

**Fix**: Pre-compute per-bin statistics in a single pass:
```js
// Before: O(n²·m) with per-iteration allocation
for (let m = 0; m < n; m++) {
  for (let f = 0; f < bins; f++) {
    const values = this.measurements.map(meas => meas.spectrum[f]); // 15 allocations per f
    // ...
  }
}

// After: O(n·m) single pass, no per-iteration allocation
// Step 1: compute per-bin mean + stdDev in O(n·m)
const perBinStats = new Float32Array(bins * 2); // [mean, stdDev] per bin
for (let f = 0; f < bins; f++) {
  let sum = 0;
  for (let m = 0; m < n; m++) sum += measurements[m].spectrum[f];
  const mean = sum / n;
  let varSum = 0;
  for (let m = 0; m < n; m++) varSum += (measurements[m].spectrum[f] - mean) ** 2;
  perBinStats[f * 2] = mean;
  perBinStats[f * 2 + 1] = Math.sqrt(varSum / n);
}
// Step 2: score each measurement in O(n·m), zero allocations
for (let m = 0; m < n; m++) {
  let outlierBins = 0;
  for (let f = 0; f < bins; f++) {
    const mean = perBinStats[f * 2];
    const stdDev = perBinStats[f * 2 + 1];
    if (stdDev > 3 && Math.abs(measurements[m].spectrum[f] - mean) > 2 * stdDev) {
      outlierBins++;
    }
  }
  if (outlierBins / bins < 0.5) valid.push(measurements[m]);
}
```

**Estimated**: ~25 LOC reduction + 15,000 fewer temporary allocations.

#### Q-5: Fragile Hex-to-RGBA Regex (main.js L209)

**Problem**: Complex chain of `.replace()` calls that can produce malformed CSS if the hex color format varies.

**Fix**: Replace with a dedicated `hexToRgba(hex, alpha)` helper:
```js
function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
```

#### Q-6: `test.js` Smoke Test Fragility

**Problem**: Reads only the first JS file in `dist/assets/` — if Vite changes bundle naming, the test silently passes on an empty bundle.

**Fix**: Glob for all `.js` files and verify each contains expected markers, or use Vite's programmatic API to read manifest.

---

### Phase 3 — Polish (Estimated: ~2h)

| Finding | File | Fix | Estimated LOC |
|---------|------|-----|---------------|
| #7 — `SAMPLE_RATE = 44100` duplicated | analyzer.js, sineSweep.js, main.js | Centralize in `src/constants.js`, import everywhere | 5 |
| #10 — `sineSweep.stop()` swallows errors | sineSweep.js L85 | Add error logging: `console.warn('Sweep stop error:', e)` | 2 |
| #11 — Magic `+90` in `getRMSLevel` | analyzer.js L262 | Named constant `MIC_REFERENCE_OFFSET = 90` | 1 |
| #16 — `analyzer.destroy()` missing try/finally | main.js L851–855, L994–998 | Wrap in try/finally or use `try {} finally { analyzer?.destroy(); analyzer = null; }` | 4 |
| #17 — `getHarmanTargetDB` re-parses keys | eqGenerator.js L33 | Cache sorted keys array as module-level constant | 3 |
| #14 — Mixed English/Spanish UI | main.js L685, L693 | Extract all strings to `src/i18n.js` | 15 |
| #15 — `loadDevices()` eager at module load | main.js L123 | Defer to user gesture or explicit call | 1 |
| #4 — RAF vs sweep `onComplete` race | main.js L620–631 | Use a promise-based completion, cancel RAF on sweep complete | 10 |
| #9 — Gains as JSON in DOM dataset | main.js L847–848, L874, L882 | Use `Map` or closure to store gains, not DOM dataset | 5 |

---

## 4. Impact Assessment

### Correctness Impact (Blockers)
- **B-1** (`calibrateMicrophone`): Calibration is a silent no-op. Fixing this enables actual mic correction curves, improving measurement accuracy on non-flat microphones.
- **B-2** (`generateVisualizationData`): ALL frequency response data above ~300Hz is currently mapped to wrong FFT bins. Fixing this is the single highest-impact change — it affects every EQ calculation and visualization.
- **B-3** (`recordSegment`): Room walk and noise floor capture timing is unreliable on mobile. Fixing this enables the room walk feature to work correctly on phones.

### User-Facing Impact
- Phase 1 produces measurably better EQ curves (B-2) and enables working calibration (B-1) and room walk (B-3).
- Phase 2 has no user-facing impact — purely internal quality.
- Phase 3 is cosmetic/internationalization.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| B-2 binary search introduces off-by-one errors in visualization | Medium | Add regression tests with known frequency→bin mappings |
| B-3 timing change breaks existing behavior on desktop | Low-Medium | Test on Chrome, Firefox, Safari; fallback to old path if `currentTime` unavailable |
| Q-3: Adding Vitest changes the test harness | Medium | Keep existing `node --test` runner; add Vitest as additional layer |
| Q-1: Extracting `main.js` during audit could introduce regressions | Medium | Do extraction in a dedicated branch; no behavioral changes, only structural |
| Phase 3 i18n extraction may break UI layout if not done carefully | Low | Use a single `src/i18n.js` file, no string interpolation in JSX-like templates |

---

## 6. Estimated Effort

| Phase | Focus | Estimated Time |
|-------|-------|----------------|
| Phase 1 | Blockers (B-1, B-2, B-3) | ~3 hours |
| Phase 2 | Architecture / Quality (Q-1 through Q-6) | ~6 hours |
| Phase 3 | Polish (9 minor fixes) | ~2 hours |
| **Total** | | **~11 hours** |

---

## 7. Proposed Implementation Order

1. **B-2** first (highest impact — everything else depends on correct visualization data)
2. **B-1** second (enables mic calibration)
3. **B-3** third (enables mobile room walk)
4. **Q-2** and **Q-4** in parallel (refactor duplicated code and fix performance)
5. **Q-1** and **Q-5** (slim main.js, fix hex-to-rgba)
6. **Q-6** (fix test.js)
7. **Q-3** (add test coverage — after all code changes to prevent test pollution)
8. Phase 3 fixes (can be done incrementally across any phase)

---

## 8. Success Criteria

- All three blockers fixed and verifiable via unit tests or manual testing
- `main.js` reduced from 1024 to ≤600 LOC (Phase 2)
- `processSweepResults` / `processRoomWalkResults` share ≤20% duplicated code
- New test coverage for `analyzer.js` and `roomCalibration.js` (target: 80% coverage)
- `filterOutliers` performance: no per-iteration temporary array allocations
- No `setTimeout` in `recordSegment`
- `npm test` passes in CI