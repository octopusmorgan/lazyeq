# Exploration: Room Walk Calibration Mode

## Current State
The current lazyeq implementation performs single-point sine sweep measurement:
- **Duration**: 8 seconds per sweep (20Hz-20kHz logarithmic)
- **Flow**: Noise floor capture → Play sweep → Analyze → Export EQ
- **Output**: 10-band EQ (eqMac) or 147-band (Wavelet) based on Harman target curve
- **Tech Stack**: Vanilla JS + Web Audio API (FFT_SIZE=2048, SAMPLE_RATE=44100)

## Affected Areas
| File | Why Affected |
|------|--------------|
| `src/main.js` | New UI flow, measurement orchestration |
| `src/sineSweep.js` | Need shorter sweep bursts for periodic capture |
| `src/analyzer.js` | Need multi-capture storage and averaging logic |
| `src/eqGenerator.js` | New target curve for room compensation |
| `index.html` | New "Room Walk" mode UI section |

---

## Approach Analysis

### 1. User Experience Flow

| Approach | Description | Pros | Cons | Effort |
|----------|-------------|------|------|--------|
| **Guided walk (Recommended)** | Voice cues guide user through positions | Clear UX, Trueplay-like | Requires TTS or beeps | Medium |
| **Passive capture** | User walks freely, continuous capture | Simple | No quality control | Low |
| **Timer-based** | Fixed 30s walk, visual countdown | Easy to implement | Less engaging | Low |

**Recommendation**: Guided walk with audio beeps every 2 seconds + visual progress bar. 30-second duration with 15 capture points.

### 2. Technical Implementation

| Approach | Pros | Cons | Effort |
|----------|------|------|--------|
| **Continuous sweep (8s)** | Simple | User can't move, long wait | Low |
| **Periodic 1s bursts (Recommended)** | Easy to count positions, user-friendly | Need sync logic | Medium |
| **Continuous pink noise** | Natural, no timing needed | Harder to analyze | High |

**Recommendation**: Periodic 1-second logarithmic sweep bursts every 2 seconds. Total: 30 seconds = 15 measurements. This matches user walking pace (~1 step per 2 seconds).

**Capture Parameters**:
- **Interval**: 2 seconds between captures
- **Duration**: 1 second per sweep burst
- **Total captures**: 15 positions (30s total)
- **Outlier handling**: Discard captures with RMS > 20dB above/below median

### 3. Spatial Averaging Algorithm

| Approach | Description | Pros | Cons |
|----------|-------------|------|------|
| **Simple average** | Equal weight to all captures | Easy | Outliers skew result |
| **Energy-weighted (Recommended)** | Weight by consistency (inverse variance) | Robust to outliers | Slightly complex |
| **Median filter** | Take median per frequency bin | Excellent outlier rejection | Can lose valid peaks |

**Recommendation**: Energy-weighted averaging with consistency scoring:
1. Compute RMS for each capture
2. Discard captures with RMS > 2σ from median (outliers)
3. Weight remaining captures by inverse variance
4. Average in linear domain, convert to dB

**Room Mode Handling**:
- Apply 1/3-octave smoothing (already exists in `smoothResponse`)
- Flag and reduce weight to frequencies with very high variance (>15dB across captures)

### 4. EQ Generation Differences

| Aspect | Single-Point | Room Walk |
|--------|--------------|-----------|
| Max gain | ±12dB | ±6dB (more conservative) |
| Bass handling | Peaking filters | Shelf filters (< 100Hz) |
| Target curve | Harman | Modified Harman with +3dB bass rolloff |
| Smoothing | 12-octave | 6-octave (preserve some room variation) |

**Recommendation**: 
- **Conservative corrections**: Max ±6dB (vs ±12dB single-point)
- **Shelf filters for bass**: Use highpass shelf below 80Hz instead of peaking
- **Modified target**: Slightly warmer curve (+2dB at 100-200Hz) to compensate for multiple-position averaging

### 5. UI/UX Considerations

**Required Elements**:
1. **Mode toggle**: "Single Point" vs "Room Walk" buttons
2. **Progress bar**: Visual indicator (0-100% or capture count)
3. **Audio feedback**: Beep or voice "Point 1, Point 2..." every 2 seconds
4. **Position counter**: "Position 5/15" display
5. **Results screen**: Show individual captures + averaged result

**Optional Enhancements**:
- Real-time spectrum during walk (delayed, not live)
- "Bad capture" indicator if user moves too fast
- Before/after comparison slider

---

## Technical Feasibility

**Assessment**: HIGHLY FEASIBLE - The existing codebase provides most building blocks:

| Component | Status | Adaptation Needed |
|-----------|--------|-------------------|
| Sweep generation | ✅ Ready | Reduce to 1s bursts |
| FFT analysis | ✅ Ready | Store multiple captures |
| Noise floor | ✅ Ready | Reuse existing logic |
| Smoothing | ✅ Ready | Adjust octave count |
| EQ generation | ✅ Ready | New conservative algorithm |
| UI flow | ⚠️ Partial | Add room walk section |

**Key Changes Required**:
1. Create `RoomWalkCapture` class to manage multiple captures
2. Modify `SineSweepSource` to support burst mode
3. Add spatial averaging in analyzer
4. Update EQ generator with room compensation curve
5. Add new UI section in index.html

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| User moves too fast | Blurry captures | 2s interval is generous; add warning if RMS drops |
| Room modes dominate | EQ over-correction | Aggressive smoothing, variance-based downweighting |
| Device mic overload | Clipping | Monitor RMS, auto-gain or warn user |
| Bluetooth latency | Sync issues | Use device speaker, warn against BT |
| Battery drain | Capture incomplete | 30s is short enough; suggest charging |

---

## Recommendation

**Proceed with implementation** using the guided 30-second walk with:
- 15 periodic 1-second sweep bursts
- Energy-weighted spatial averaging
- Conservative EQ (±6dB max, shelf bass)
- Visual progress + audio beeps

This approach balances accuracy (multiple positions) with usability (Trueplay-like experience) while staying within existing tech constraints (Vanilla JS + Web Audio API).
