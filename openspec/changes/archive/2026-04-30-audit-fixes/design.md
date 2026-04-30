# Design: `audit-fixes` — lazyeq Code Audit Remediation

## Technical Approach

This design addresses 18 audit findings across 3 phases. Phase 1 fixes correctness bugs that produce wrong EQ/visualization data. Phase 2 eliminates technical debt and test gaps. Phase 3 removes code smells and adds i18n. The implementation order respects critical dependencies: B-2 (FFT bin mapping) must be done first as it corrupts every EQ calculation above ~300Hz.

## Architecture Decisions

### Decision: Binary Search for FFT Bin Mapping (B-2)

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Linear interpolation of log-frequency | Fast but mathematically wrong for discrete bins | REJECTED |
| Binary search over linear frequencyLabels array | O(log n) per lookup, mathematically correct | SELECTED |

**Rationale**: The current code uses `Math.floor(((logFreq - logMin) / (logMax - logMin)) * (frequencyLabels.length - 1))` which maps log-frequency position linearly to array index. This fails because frequencyLabels is linearly-spaced (20Hz, 21Hz, 22Hz...). At 632Hz, current code maps to bin 511 (~11kHz!) instead of bin ~29. Binary search finds the closest actual frequency in the linear array.

### Decision: RAF + AudioContext Time for Recording (B-3)

| Option | Tradeoff | Decision |
|--------|----------|----------|
| setTimeout-only | Simple but unreliable on mobile (throttled to 1fps) | REJECTED |
| requestAnimationFrame + audioContext.currentTime sync | Handles mobile throttling, uses audio clock | SELECTED |

**Rationale**: Mobile browsers throttle setTimeout to 1fps when tab is backgrounded. RAF runs at display refresh rate (usually 60fps), and audioContext.currentTime provides a reliable wall-clock for audio scheduling. Combined approach ensures consistent frame timing while respecting audio timing.

### Decision: Two-Pass filterOutliers (Q-4)

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Per-iteration array allocations | 15,000+ Float32Array allocations per call | REJECTED |
| Pre-compute stats in Float32Array, then score | Zero allocations, O(n·m) → O(2n·m) | SELECTED |

**Rationale**: Current code creates `values` array via `.map()` inside nested loops (line 165). For 15 measurements × 1024 bins = 15,360 allocations per call. Two-pass: (1) pre-compute means/stdDev per bin into Float32Array(1024 * 2), (2) score measurements using pre-computed stats.

### Decision: Main.js Extraction (Q-1)

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Single large refactor | All extraction at once, higher risk | REJECTED |
| Incremental extraction: ui.js → state.js → events.js | Lower risk, test after each | SELECTED |

**Rationale**: 1024 LOC is too large for single refactor. Extract UI code first (largest chunk ~200 LOC), then state management (~80 LOC), then event handlers (~100 LOC). Keep main.js as orchestration layer.

## Data Flow

```
Phase 1 - Correctness Fixes
┌─────────────────────────────────────────────────────────────────┐
│  B-1: calibrateMicrophone                                      │
│  main.js:114-125 ──→ sweep.start() called before recordSegment  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  B-2: generateVisualizationData (CRITICAL)                      │
│  eqGenerator.js:144-148                                         │
│  Log position ──→ binary search on frequencyLabels ──→ FFT bin  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  B-3: recordSegment                                            │
│  analyzer.js:71-101                                             │
│  setTimeout ──→ RAF + audioContext.currentTime                  │
└─────────────────────────────────────────────────────────────────┘

Phase 2 - Architecture & Quality
┌─────────────────────────────────────────────────────────────────┐
│  Q-1: main.js (1024 LOC) ──→ ui.js + state.js + events.js       │
│  Q-2: processSweepResults + processRoomWalkResults ──→ shared   │
│  Q-3: analyzer.test.js + roomCalibration.test.js (new tests)   │
│  Q-4: filterOutliers ──→ two-pass O(n·m)                       │
│  Q-5: hexToRgba helper function                                  │
│  Q-6: test.js reads all JS files                                │
└─────────────────────────────────────────────────────────────────┘

Phase 3 - Polish (all independent, parallel)
┌─────────────────────────────────────────────────────────────────┐
│  P-1: constants.js (SAMPLE_RATE)                                │
│  P-2: sineSweep.js error handling                               │
│  P-3: MIC_REFERENCE_OFFSET constant                             │
│  P-4: analyzer.destroy() try/finally                            │
│  P-5: getHarmanTargetDB key caching                             │
│  P-6: i18n.js (mixed English/Spanish)                            │
│  P-7: loadDevices() lazy init                                    │
│  P-8: RAF vs sweep onComplete race (Promise-based)              │
│  P-9: Gains in state instead of DOM dataset                    │
└─────────────────────────────────────────────────────────────────┘
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/analyzer.js` | Modify | B-1: add sweep.start(), B-3: RAF timing, P-3: MIC_REFERENCE_OFFSET constant |
| `src/eqGenerator.js` | Modify | B-2: binary search for FFT bin, P-5: cache Harman keys |
| `src/roomCalibration.js` | Modify | Q-4: two-pass filterOutliers (zero allocations) |
| `src/sineSweep.js` | Modify | P-2: add console.warn on sweep.stop() errors |
| `src/main.js` | Modify | P-4: try/finally on destroy, P-6: i18n extraction, P-7: lazy loadDevices, P-8: Promise completion, P-9: state-based gains |
| `src/constants.js` | Create | P-1: SAMPLE_RATE constant |
| `src/ui.js` | Create | Q-1: UI rendering logic (~200 LOC) |
| `src/state.js` | Create | Q-1: state management (~80 LOC) |
| `src/events.js` | Create | Q-1: event handlers (~100 LOC) |
| `src/i18n.js` | Create | P-6: internationalization strings |
| `tests/analyzer.test.js` | Create | Q-3: 8-12 unit tests for analyzer.js |
| `tests/roomCalibration.test.js` | Create | Q-3: 10-15 unit tests for roomCalibration.js |
| `test.js` | Modify | Q-6: read all .js files in dist/assets/ |

## Interfaces / Contracts

### New: hexToRgba Helper
```javascript
/**
 * Convert hex color to RGBA string
 * @param {string} hex - "#RRGGBB" or "#RGB" format
 * @param {number} alpha - Alpha value 0-1
 * @returns {string} "rgba(r,g,b,a)"
 */
function hexToRgba(hex, alpha) { ... }
```

### New: Binary Search for FFT Bins
```javascript
/**
 * Find closest FFT bin for a given frequency
 * @param {number} targetFreq - Target frequency in Hz
 * @param {Float32Array} frequencyLabels - Linear frequency array
 * @returns {number} Closest bin index
 */
function findClosestBin(targetFreq, frequencyLabels) { ... }
```

### New: _processMeasurementResults (shared)
```javascript
/**
 * Shared processing for sweep and room walk results
 * @param {Float32Array} spectrum - Frequency spectrum data
 * @param {Object} options - { method, calibrationData, noiseFloor }
 * @returns {Object} Processed result with frequency data
 */
function _processMeasurementResults(spectrum, options) { ... }
```

### Modified: recordSegment Signature
```javascript
// Before: async recordSegment(duration = 3)
// After: Same signature, but uses RAF + audioContext.currentTime internally
async recordSegment(duration = 3, options = {}) { ... }
```

### New: Constants Module
```javascript
// src/constants.js
export const SAMPLE_RATE = 44100;
export const FFT_SIZE = 2048;
export const MIC_REFERENCE_OFFSET = 90; // dB
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | B-1: sweep.start() call order | Mock SineSweepSource, verify .start() before recordSegment |
| Unit | B-2: FFT bin mapping | Regression test: 632Hz→bin29, 1kHz→bin95, 10kHz→bin927 |
| Unit | B-3: RAF timing | Mock audioContext.currentTime, verify no setTimeout |
| Unit | Q-4: filterOutliers | Functional equivalence + allocation count check |
| Unit | Q-5: hexToRgba | Both #RRGGBB and #RGB formats |
| Integration | Q-1: main.js extraction | npm test passes, smoke test |
| Integration | Q-3: analyzer/roomCalibration | ≥80% coverage via node --test --coverage |
| Integration | Q-6: test.js | npm run build && node test.js |

## Migration / Rollout

No data migration required. This is a bug fix and refactoring change. Feature flags not needed — all changes are backward-compatible improvements. Phased rollout by priority: Phase 1 (blockers) should be deployed first as they fix correctness issues.

## Open Questions

- [ ] None — all technical decisions have been resolved in the spec