# Smart Correction E2E Test Checklist

## iOS Safari / Mobile Testing

- [ ] Pink noise calibration starts without audio glitches
- [ ] 16-filter pool creates correctly (no crackle/pops)
- [ ] Convergence completes within 30 seconds
- [ ] Convergence delta label shows in canvas
- [ ] Filter pool updates smoothly (no zipper noise)
- [ ] Export Wavelet format produces valid output
- [ ] Export eqMac format produces valid output
- [ ] Saved profile includes bands field
- [ ] Loading saved profile restores filter state
- [ ] USE_SMART_CORRECTION=false falls back to old 8-band path

## Sine Sweep Path (Regression)

- [ ] Sine sweep calibration still works end-to-end
- [ ] Sweep measurement produces same results as before
- [ ] Export from sweep path is unchanged

## Desktop Chrome

- [ ] Pink noise calibration works
- [ ] All canvas visualizations render correctly
- [ ] No console errors
