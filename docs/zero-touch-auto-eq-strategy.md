# Zero-Touch Auto-EQ Strategy

## Goal
Deliver a **run-and-forget** EQ experience: users open the app, allow mic access once, and the system auto-calibrates in the background with minimal interaction.

## Product Direction
- Make **Auto-EQ** the default and primary path.
- Keep manual sweep flow only in a hidden **Advanced** mode.
- Expose only one main control: **Auto-EQ ON/OFF** (default ON).

## UX Strategy (Low Interaction)
1. First run:
   - Ask for microphone permission.
   - Start background calibration automatically.
2. Daily use:
   - Continuously refine EQ during normal playback.
   - No mandatory sweeps or setup wizard.
3. Control:
   - Optional reset profile action.
   - Advanced panel for power users (manual sweep/export details).

## Technical Strategy
### 1) Two-Stage Calibration
- **Stage A: Quick bootstrap**  
  Very short low-level chirp/multitone to estimate initial response fast.
- **Stage B: Continuous adaptation**  
  Passive measurement during real listening to refine filters gradually.

### 2) Safety Rails
- Small correction limits (e.g., ±4 dB).
- Smooth curves and frequency-range constraints.
- Slow update rate to avoid audible pumping.
- Confidence gating: only apply updates when data quality is good.

### 3) Profile Model
- Save per-device/per-room profile.
- Auto-reuse on next launch.
- Graceful fallback to last known good profile.

## Implementation Phases
1. **MVP Zero-Touch**
   - Auto-start calibration after permission.
   - Background updates + profile persistence.
   - Single ON/OFF control.
2. **Stability**
   - Confidence scoring and update gating.
   - Rollback protection and health checks.
3. **Advanced/Power Features**
   - Hidden manual sweep and diagnostics.
   - Export enhancements and deeper tuning.

## Success Criteria
- User reaches useful EQ with near-zero setup steps.
- No intrusive calibration sound in normal flow.
- Stable perceived sound quality over time.
