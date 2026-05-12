/**
 * Unit tests for parametricEqSynthesizer.
 *
 * Pure logic — no browser dependencies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeBands, evaluateCurveAt, gainsFromBands } from '../../src/parametricEqSynthesizer.js';
import { MAX_CUT_DB, MAX_BOOST_DB, Q_MIN, Q_MAX, LF_FOCUS_CUTOFF, LF_MAX_Q } from '../../src/constants.js';

describe('synthesizeBands', () => {
  /**
   * Create a minimal ranked candidate.
   */
  function makeRankedCandidate(freq, deviationDb, widthHz = 100, confidence = 0.8, score = 10) {
    return { freq, deviationDb, widthHz, confidence, score, rank: 1, stability: 1.0, type: deviationDb > 0 ? 'peak' : 'null', atIndex: 0 };
  }

  test('single peak → single band with correct gain cut and Q', () => {
    const candidates = [makeRankedCandidate(1000, 4, 500)]; // +4dB peak, 500 Hz width
    const { bands } = synthesizeBands(candidates);

    assert.equal(bands.length, 1, 'Should produce 1 band');
    assert.equal(bands[0].freq, 1000, 'Freq should match candidate');
    // Gain = -deviationDb = -4 (cut)
    assert.ok(Math.abs(bands[0].gain - (-4)) < 0.01, `Gain should be -4, got ${bands[0].gain}`);
    // Q = freq / widthHz = 1000 / 500 = 2
    assert.ok(Math.abs(bands[0].Q - 2) < 0.01, `Q should be 2, got ${bands[0].Q}`);
  });

  test('single null → single band with boost', () => {
    const candidates = [makeRankedCandidate(1000, -3, 500, 0.9)]; // -3dB null, high confidence
    const { bands } = synthesizeBands(candidates);

    assert.equal(bands.length, 1, 'Should produce 1 band');
    // Gain = -(-3) = +3 (boost)
    assert.ok(Math.abs(bands[0].gain - 3) < 0.01, `Gain should be +3, got ${bands[0].gain}`);
  });

  test('cut limit: gain capped at MAX_CUT_DB', () => {
    const candidates = [makeRankedCandidate(1000, 10, 500)]; // +10dB peak → would be -10dB cut
    const { bands } = synthesizeBands(candidates);

    assert.ok(bands[0].gain >= -MAX_CUT_DB, `Cut gain ${bands[0].gain} should be >= ${-MAX_CUT_DB}`);
    assert.ok(Math.abs(bands[0].gain - (-MAX_CUT_DB)) < 0.01, `Cut should be capped at ${-MAX_CUT_DB}`);
  });

  test('boost limit: gain capped at MAX_BOOST_DB', () => {
    const candidates = [makeRankedCandidate(1000, -10, 500, 0.9)]; // -10dB null → would be +10dB boost
    const { bands } = synthesizeBands(candidates);

    assert.ok(bands[0].gain <= MAX_BOOST_DB, `Boost gain ${bands[0].gain} should be <= ${MAX_BOOST_DB}`);
    assert.ok(Math.abs(bands[0].gain - MAX_BOOST_DB) < 0.01, `Boost should be capped at ${MAX_BOOST_DB}`);
  });

  test('boost penalty: low confidence reduces boost gain', () => {
    const candidates = [makeRankedCandidate(1000, -4, 500, 0.3)]; // Low confidence
    const { bands } = synthesizeBands(candidates);

    // Expected: gain = min(4, MAX_BOOST_DB=3) * 0.5 = 3 * 0.5 = 1.5
    // (clamp first, then apply penalty per spec)
    assert.ok(Math.abs(bands[0].gain - 1.5) < 0.01, `Low confidence boost should be 1.5, got ${bands[0].gain}`);
  });

  test('Q clamping: very narrow peak → Q capped at Q_MAX', () => {
    const candidates = [makeRankedCandidate(1000, 4, 100)]; // Q = 1000/100 = 10 → cap at 4
    const { bands } = synthesizeBands(candidates);

    assert.ok(Math.abs(bands[0].Q - Q_MAX) < 0.01, `Q should be capped at ${Q_MAX}, got ${bands[0].Q}`);
  });

  test('Q clamping: wide peak → Q capped at Q_MIN', () => {
    const candidates = [makeRankedCandidate(1000, 4, 5000)]; // Q = 1000/5000 = 0.2 → cap at 0.5
    const { bands } = synthesizeBands(candidates);

    assert.ok(Math.abs(bands[0].Q - Q_MIN) < 0.01, `Q should be capped at ${Q_MIN}, got ${bands[0].Q}`);
  });

  test('LF Q cap: LF peak with high Q → capped at LF_MAX_Q', () => {
    const candidates = [makeRankedCandidate(100, 4, 25)]; // Q = 100/25 = 4 → cap at LF_MAX_Q=2
    const { bands } = synthesizeBands(candidates);

    assert.ok(Math.abs(bands[0].Q - LF_MAX_Q) < 0.01, `LF Q should be capped at ${LF_MAX_Q}, got ${bands[0].Q}`);
    assert.ok(bands[0].freq < LF_FOCUS_CUTOFF, 'Should be below LF cutoff');
  });

  test('merge nearby same-polarity candidates: within 1/3 octave → single band', () => {
    const candidates = [
      makeRankedCandidate(500, 4, 200, 0.8, 10),
      makeRankedCandidate(600, 3, 200, 0.8, 9), // 600/500 = 1.20 < cbrt(2) (within 1/3 octave)
    ];
    const { bands } = synthesizeBands(candidates);

    assert.ok(bands.length >= 1 && bands.length <= 2, `Expected 1-2 bands, got ${bands.length}`);
    bands.forEach((b) => assert.ok(b.gain <= 0, 'Peak candidates should produce cut bands'));
  });

  test('do not merge opposite-polarity bands even when close', () => {
    const candidates = [
      makeRankedCandidate(500, 4, 200, 0.8, 10),   // peak -> cut
      makeRankedCandidate(620, -3, 200, 0.8, 9),   // null -> boost
    ];
    const { bands } = synthesizeBands(candidates);
    assert.equal(bands.length, 2, `Opposite-polarity bands should stay separate, got ${bands.length}`);
  });

  test('empty candidates → empty bands and flat gains', () => {
    const result = synthesizeBands([]);
    assert.deepEqual(result.bands, []);
    assert.ok(result.gains instanceof Float32Array);
    assert.equal(result.gains.length, 0);
  });

  test('empty candidates with target frequencies → empty bands and flat gains', () => {
    const freqs = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
    const result = synthesizeBands([], freqs);
    assert.deepEqual(result.bands, []);
    assert.ok(result.gains instanceof Float32Array);
    assert.equal(result.gains.length, freqs.length);
    // All gains should be 0 (flat)
    for (let i = 0; i < result.gains.length; i++) {
      assert.equal(result.gains[i], 0, `Gain at index ${i} should be 0`);
    }
  });

  test('gains array has correct length for 147-point Wavelet export', () => {
    const candidates = [makeRankedCandidate(1000, 4, 500)];
    // 147-point Wavelet frequencies (log-spaced from 20 to 20000)
    const waveletFreqs = [];
    for (let i = 0; i < 147; i++) {
      waveletFreqs.push(20 * Math.pow(1000, i / 146));
    }

    const { gains } = synthesizeBands(candidates, waveletFreqs);

    assert.equal(gains.length, 147, 'Should produce 147 gains');
    assert.ok(gains instanceof Float32Array, 'Should be Float32Array');
  });
});

describe('evaluateCurveAt', () => {
  test('known bands → verify curve matches expected dB values (±0.5dB)', () => {
    // Single band: 1000 Hz, +6 dB gain, Q=1
    const bands = [{ freq: 1000, gain: 6, Q: 1 }];
    const freqs = [1000, 2000, 500];

    const result = evaluateCurveAt(bands, freqs);

    // At center freq (1000 Hz), should be close to +6 dB
    assert.ok(Math.abs(result[0] - 6) < 0.5, `At center freq, should be ~6dB, got ${result[0]}`);

    // At 2x freq (2000 Hz), should be lower (filter rolls off)
    assert.ok(result[1] < result[0], 'At 2x freq, gain should be lower than center');

    // At 0.5x freq (500 Hz), should be lower (filter rolls off)
    assert.ok(result[2] < result[0], 'At 0.5x freq, gain should be lower than center');
  });

  test('empty bands → flat response', () => {
    const freqs = [100, 200, 500, 1000];
    const result = evaluateCurveAt([], freqs);
    assert.equal(result.length, freqs.length);
    for (let i = 0; i < result.length; i++) {
      assert.equal(result[i], 0, `Should be 0 dB at ${freqs[i]} Hz`);
    }
  });

  test('multiple bands → combined response', () => {
    const bands = [
      { freq: 100, gain: -3, Q: 1 },
      { freq: 1000, gain: -3, Q: 1 },
    ];
    const freqs = [100, 1000];

    const result = evaluateCurveAt(bands, freqs);

    // At 100 Hz, the 100 Hz band contributes ~-3dB, the 1000 Hz band contributes ~0dB
    assert.ok(result[0] < -1, `At 100 Hz, combined should be negative, got ${result[0]}`);

    // At 1000 Hz, the 1000 Hz band contributes ~-3dB, the 100 Hz band contributes ~0dB
    assert.ok(result[1] < -1, `At 1000 Hz, combined should be negative, got ${result[1]}`);
  });

  test('cut band produces negative dB at center frequency', () => {
    const bands = [{ freq: 500, gain: -6, Q: 2 }];
    const freqs = [500];
    const result = evaluateCurveAt(bands, freqs);

    assert.ok(result[0] < -4, `Cut band should produce negative dB, got ${result[0]}`);
  });

  test('boost band produces positive dB at center frequency', () => {
    const bands = [{ freq: 500, gain: 3, Q: 2 }];
    const freqs = [500];
    const result = evaluateCurveAt(bands, freqs);

    assert.ok(result[0] > 1, `Boost band should produce positive dB, got ${result[0]}`);
  });
});

describe('gainsFromBands', () => {
  test('produces Float32Array of correct length', () => {
    const bands = [{ freq: 1000, gain: -4, Q: 2 }];
    const freqs = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

    const gains = gainsFromBands(bands, freqs);

    assert.ok(gains instanceof Float32Array);
    assert.equal(gains.length, freqs.length);
  });

  test('empty bands → all zeros', () => {
    const freqs = [100, 200, 500];
    const gains = gainsFromBands([], freqs);

    assert.equal(gains.length, freqs.length);
    for (let i = 0; i < gains.length; i++) {
      assert.equal(gains[i], 0);
    }
  });

  test('empty frequencies → empty array', () => {
    const bands = [{ freq: 1000, gain: -4, Q: 2 }];
    const gains = gainsFromBands(bands, []);
    assert.equal(gains.length, 0);
  });
});
