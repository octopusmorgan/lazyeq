/**
 * Unit tests for AngularMicCompensation and DirectionalCalibration (Node — no browser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Mock AudioContext for Node environment before importing roomCalibration
// (SineSweepSource is imported at the top level and uses AudioContext)
globalThis.AudioContext = class MockAudioContext {
  get sampleRate() { return 44100; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
  createBuffer(ch, len, sr) {
    return { getChannelData: () => new Float32Array(len), sampleRate: sr };
  }
  createBufferSource() {
    return { connect() {}, start() {}, stop() {}, buffer: null };
  }
  get currentTime() { return 0; }
};

const { AngularMicCompensation, DirectionalCalibration, DIRECTIONAL_POSITIONS } =
  await import("../src/roomCalibration.js");

test("DIRECTIONAL_POSITIONS have equal weights", () => {
  for (const pos of DIRECTIONAL_POSITIONS) {
    assert.equal(pos.weight, 1.0, `${pos.id} weight should be 1.0`);
  }
});

test("AngularMicCompensation returns zero curve when no front reference", () => {
  const comp = new AngularMicCompensation({ left: new Float32Array(10) });
  const curve = comp.deriveCorrectionCurve(null);
  assert.equal(curve.length, 10);
  assert.ok(curve.every((v) => v === 0));
});

test("AngularMicCompensation derives correction = front - side", () => {
  const front = new Float32Array([10, 10, 10, 10]);
  const left  = new Float32Array([8,  8,  8,  8]);
  const freqLabels = [500, 1500, 2500, 3500]; // 2kHz mask boundary

  const comp = new AngularMicCompensation({ front, left });
  const curve = comp.deriveCorrectionCurve(freqLabels);

  // Below 2kHz: correction should be 0 (masked)
  assert.equal(curve[0], 0, "500 Hz should be masked");
  assert.equal(curve[1], 0, "1500 Hz should be masked");

  // Above 2kHz: correction = front - left = 2 dB
  assert.equal(curve[2], 2, "2500 Hz correction should be 2 dB");
  assert.equal(curve[3], 2, "3500 Hz correction should be 2 dB");
});

test("AngularMicCompensation averages left and right corrections", () => {
  const front = new Float32Array([10, 10]);
  const left  = new Float32Array([7,  7]);  // correction = 3
  const right = new Float32Array([9,  9]);  // correction = 1
  const freqLabels = [3000, 5000];

  const comp = new AngularMicCompensation({ front, left, right });
  const curve = comp.deriveCorrectionCurve(freqLabels);

  // Average correction: (3 + 1) / 2 = 2
  assert.equal(curve[0], 2);
  assert.equal(curve[1], 2);
});

test("AngularMicCompensation.applyCorrection adds curve to spectrum", () => {
  const comp = new AngularMicCompensation({});
  const spectrum = new Float32Array([5, 5, 5]);
  const curve = new Float32Array([0, 1, 2]);
  const corrected = comp.applyCorrection(spectrum, curve);

  assert.equal(corrected[0], 5);
  assert.equal(corrected[1], 6);
  assert.equal(corrected[2], 7);
});

test("DirectionalCalibration requires all 3 positions", () => {
  const cal = new DirectionalCalibration();
  assert.equal(cal.isComplete(), false);

  cal.savePositionResult("front", new Float32Array(10));
  assert.equal(cal.isComplete(), false);

  cal.savePositionResult("left", new Float32Array(10));
  cal.savePositionResult("right", new Float32Array(10));
  assert.equal(cal.isComplete(), true);
});

test("DirectionalCalibration.getDirectionalAverage applies angular correction", () => {
  const cal = new DirectionalCalibration();
  const binWidth = 44100 / 2048; // ~21.53 Hz/bin
  const bins = 100; // enough bins to span past 2kHz (bin ~93)

  // Simulate a scenario where the mic loses 3 dB at high frequencies on the sides
  // due to angular response. Front is the reference (no loss).
  const front = new Float32Array(bins).fill(10);
  const left  = new Float32Array(bins).fill(10);
  const right = new Float32Array(bins).fill(10);

  // Apply -3 dB drop only above 2kHz (bins >= 93)
  for (let i = 93; i < bins; i++) {
    left[i] = 7;
    right[i] = 7;
  }

  cal.savePositionResult("front", front);
  cal.savePositionResult("left", left);
  cal.savePositionResult("right", right);

  const avg = cal.getDirectionalAverage();
  assert.equal(avg.length, bins);

  // Low freqs (below 2kHz, no correction needed): average of 10,10,10 = 10
  assert.ok(Math.abs(avg[50] - 10) < 0.1, `avg[50] = ${avg[50]}, expected ~10`);

  // High freqs (above 2kHz, corrected): after angular compensation, sides become ~10 dB
  // Average should be ~10 dB, NOT ~8.2 dB (which it would be without correction)
  assert.ok(Math.abs(avg[95] - 10) < 0.5, `avg[95] = ${avg[95]}, expected ~10 after correction`);
  assert.ok(Math.abs(avg[99] - 10) < 0.5, `avg[99] = ${avg[99]}, expected ~10 after correction`);
});

test("DirectionalCalibration.getDirectionalAverage throws on incomplete", () => {
  const cal = new DirectionalCalibration();
  cal.savePositionResult("front", new Float32Array(4));
  assert.throws(() => cal.getDirectionalAverage(), /Missing positions/);
});

test("AngularMicCompensation _binToFrequency matches SAMPLE_RATE/FFT_SIZE", () => {
  const comp = new AngularMicCompensation({});
  // 44100 / 2048 ≈ 21.53 Hz/bin
  const f0 = comp._binToFrequency(0);
  const f1 = comp._binToFrequency(1);
  assert.equal(f0, 0);
  assert.ok(Math.abs(f1 - 21.53) < 0.01, `bin 1 freq = ${f1}`);
});
